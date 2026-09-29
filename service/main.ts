/**
 * OpenChamber Makefile — local service.
 *
 * Runs as a child process of the OpenChamber host (`contributes.service`). The
 * sandboxed panel cannot start a process or read a file, so this service owns
 * both: it reads the project's makefile, spawns `make <target>` and serves the
 * result to the panel.
 *
 * Downstream state travels as an **event stream** (SSE frames): every run
 * start/finish, every output chunk and every makefile change is appended to a
 * sequenced log that `GET /events` drains. Commands stay request/response
 * (`POST /run`, `POST /stop`, `GET /targets`); the events are the push side.
 *
 * The host bridge buffers a service response whole (no streaming yet), so
 * `/events` holds the request until there is something to send and is meant to
 * be reconnected immediately; the exact same endpoint works with a real
 * `EventSource` once the host gains a streaming call.
 *
 * Protocol: the host passes OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN; every request needs `Authorization: Bearer <token>`.
 */

import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  MAKEFILE_NAMES,
  parseMakeTargets,
  type MakeTarget,
  type RunOutput,
  type RunSnapshot,
  type RunStatus,
  type StreamEvent,
  type StreamFrame,
} from '../src/makefile.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

/** Kept per run; the oldest output is dropped past this. */
const MAX_OUTPUT_CHARS = 400_000;
/** A single backfill answer never carries more than this. */
const POLL_CHUNK_CHARS = 60_000;
/** Finished runs kept in memory so a reopened panel restores recent logs. */
const MAX_RUNS = 40;
/** How many events the log keeps for clients that fall behind. */
const EVENT_BUFFER_MAX = 4_000;
/** Caps one `/events` answer so it stays under the host proxy's response limit. */
const EVENT_BATCH_MAX_BYTES = 200_000;
/**
 * How long one `/events` request may wait. A parked reader costs a whole
 * connection from the host to this process, and a sandboxed panel has only a few
 * of them to spend, so the hold stays short: a client that asked for more simply
 * asks again from the cursor it already has, and an event still arrives the
 * moment it happens because the hold ends as soon as one does. A long hold lets
 * readers left behind by a reload or a directory switch — the host cannot cancel
 * a request already in flight — starve every later request behind them.
 */
const MAX_HOLD_MS = 2_000;

/**
 * How long a parked reader must have been waiting before a newer one may take
 * its place. The grace keeps a client that keeps losing its reader (two panels
 * watching at once) from spinning against the other.
 */
const PARKED_GRACE_MS = 1_000;

// ---------------------------------------------------------------------------
// Event log (the push side)
// ---------------------------------------------------------------------------

/** An event before the service stamps its sequence on it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StreamEventInput = DistributiveOmit<StreamEvent, 'seq'>;

let nextSeq = 1;
const eventLog: StreamEvent[] = [];
const eventWaiters = new Set<() => void>();

const latestSeq = (): number => nextSeq - 1;
const oldestSeq = (): number => (eventLog.length > 0 ? eventLog[0].seq : nextSeq);

const emit = (event: StreamEventInput): void => {
  eventLog.push({ ...event, seq: nextSeq } as StreamEvent);
  nextSeq += 1;
  if (eventLog.length > EVENT_BUFFER_MAX) eventLog.splice(0, eventLog.length - EVENT_BUFFER_MAX);
  for (const wake of [...eventWaiters]) wake();
};

const eventsSince = (since: number): StreamEvent[] => eventLog.filter((event) => event.seq > since);

/** The one reader parked on `/events` right now, if any. */
let parked: { at: number; supersede: () => void } | null = null;

/**
 * Hold until an event arrives, the client disconnects, `waitMs` passes, or a
 * newer reader takes this one's place.
 *
 * At most one reader stays parked: the newest wins, and the one it replaces is
 * woken at once so its connection frees instead of holding on. The host cannot
 * cancel a request already in flight, so this is the only way to drop the reader
 * a reloaded or switched panel left behind.
 */
const holdEvents = (res: http.ServerResponse, waitMs: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout;
    const wake = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      eventWaiters.delete(wake);
      res.off('close', wake);
      if (parked?.supersede === wake) parked = null;
      resolve();
    };
    timer = setTimeout(wake, waitMs);
    eventWaiters.add(wake);
    res.on('close', wake);
    if (parked && Date.now() - parked.at >= PARKED_GRACE_MS) {
      const previous = parked;
      parked = null;
      previous.supersede();
    }
    parked = { at: Date.now(), supersede: wake };
  });

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

type Run = {
  id: string;
  directory: string;
  target: string;
  child: ChildProcess | null;
  /** Tail of the output; the head is dropped once MAX_OUTPUT_CHARS is passed. */
  output: string;
  /** Characters dropped from the front, so offsets stay absolute. */
  dropped: number;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
};

const runs = new Map<string, Run>();
/** Run ids oldest first, for eviction. */
const runOrder: string[] = [];

const totalLength = (run: Run): number => run.dropped + run.output.length;

const snapshotOf = (run: Run): RunSnapshot => ({
  runId: run.id,
  directory: run.directory,
  target: run.target,
  status: run.status,
  exitCode: run.exitCode,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  length: totalLength(run),
});

const evictRuns = (): void => {
  while (runOrder.length > MAX_RUNS) {
    const id = runOrder.find((candidate) => runs.get(candidate)?.status !== 'running');
    if (!id) return;
    runOrder.splice(runOrder.indexOf(id), 1);
    runs.delete(id);
  }
};

const appendOutput = (run: Run, chunk: string): void => {
  if (!chunk) return;
  run.output += chunk;
  if (run.output.length > MAX_OUTPUT_CHARS) {
    const cut = run.output.length - MAX_OUTPUT_CHARS;
    run.output = run.output.slice(cut);
    run.dropped += cut;
  }
  emit({ type: 'output', directory: run.directory, runId: run.id, target: run.target, chunk });
};

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

const resolveDirectory = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
};

const findMakefile = async (directory: string): Promise<{ file: string; name: string } | null> => {
  for (const name of MAKEFILE_NAMES) {
    const file = path.join(directory, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile()) return { file, name };
    } catch {
      // try the next candidate
    }
  }
  return null;
};

const readTargets = async (directory: string): Promise<{ makefile: string | null; targets: MakeTarget[] }> => {
  const found = await findMakefile(directory);
  if (!found) return { makefile: null, targets: [] };
  const text = await fsp.readFile(found.file, 'utf8');
  return { makefile: found.name, targets: parseMakeTargets(text) };
};

const targetsSignature = (makefile: string | null, targets: MakeTarget[]): string =>
  `${makefile ?? ''}|${targets.map((t) => `${t.name}\u0001${t.description}\u0001${t.phony ? 1 : 0}${t.default ? 1 : 0}`).join('\u0002')}`;

const latestRunsFor = (directory: string): Record<string, RunSnapshot> => {
  const latest: Record<string, RunSnapshot> = {};
  for (const id of runOrder) {
    const run = runs.get(id);
    if (!run || run.directory !== directory) continue;
    latest[run.target] = snapshotOf(run);
  }
  return latest;
};

// ---------------------------------------------------------------------------
// Makefile watch: a change pushes a `targets` event to every panel
// ---------------------------------------------------------------------------

/** directory -> last target signature seen, so we only emit on a real change. */
const lastTargets = new Map<string, string>();
const watchers = new Map<string, fs.FSWatcher>();
const rescans = new Map<string, NodeJS.Timeout>();

const rescanDirectory = async (directory: string): Promise<void> => {
  try {
    const { makefile, targets } = await readTargets(directory);
    const signature = targetsSignature(makefile, targets);
    if (lastTargets.get(directory) === signature) return;
    lastTargets.set(directory, signature);
    emit({ type: 'targets', directory, makefile, targets });
  } catch {
    // the directory (or makefile) went away while we watched it
  }
};

const watchDirectory = (directory: string): void => {
  if (watchers.has(directory)) return;
  try {
    const watcher = fs.watch(directory, () => {
      const pending = rescans.get(directory);
      if (pending) clearTimeout(pending);
      rescans.set(directory, setTimeout(() => {
        rescans.delete(directory);
        void rescanDirectory(directory);
      }, 300));
    });
    watcher.on('error', () => {
      watchers.delete(directory);
      watcher.close();
    });
    watcher.unref?.();
    watchers.set(directory, watcher);
  } catch {
    // Watching is best-effort; /targets still reflects the file on demand.
  }
};

// ---------------------------------------------------------------------------
// Running make
// ---------------------------------------------------------------------------

let runSequence = 0;

const startRun = (directory: string, target: string): Run => {
  const run: Run = {
    id: `run_${Date.now().toString(36)}_${(runSequence += 1).toString(36)}`,
    directory,
    target,
    child: null,
    output: '',
    dropped: 0,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  runs.set(run.id, run);
  runOrder.push(run.id);
  evictRuns();
  emit({ type: 'run', directory, run: snapshotOf(run) });

  let settled = false;
  const finish = (status: RunStatus, code: number | null): void => {
    if (settled) return;
    settled = true;
    run.status = status;
    run.exitCode = code;
    run.finishedAt = Date.now();
    run.child = null;
    emit({ type: 'run', directory, run: snapshotOf(run) });
  };

  let child: ChildProcess;
  try {
    child = spawn('make', ['--no-print-directory', target], { cwd: directory, env: process.env });
  } catch (error) {
    appendOutput(run, `${error instanceof Error ? error.message : String(error)}\n`);
    finish('failed', null);
    return run;
  }

  run.child = child;
  child.stdout?.on('data', (chunk: Buffer) => appendOutput(run, chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput(run, chunk.toString()));

  child.on('error', (error) => {
    appendOutput(run, `${error.message}\n`);
    finish('failed', null);
  });

  child.on('close', (code, signal) => {
    if (signal) finish('stopped', null);
    else finish(code === 0 ? 'success' : 'failed', code ?? null);
  });

  return run;
};

const stopRun = (runId: string): boolean => {
  const run = runs.get(runId);
  if (!run || !run.child || run.status !== 'running') return false;
  run.child.kill('SIGTERM');
  const child = run.child;
  setTimeout(() => {
    if (run.status === 'running' && child) child.kill('SIGKILL');
  }, 3000).unref?.();
  return true;
};

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Clamp the requested hold to what the host bridge can survive. */
const clampWait = (raw: string | null): number => {
  const value = Number(raw ?? '0');
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_HOLD_MS);
};

/**
 * Output of one run from `requestedOffset` up to `to` (an absolute offset, used
 * by the panel to backfill exactly the snapshot length without overlapping the
 * live event stream).
 */
const answerFor = (run: Run, requestedOffset: number, to: number): RunOutput => {
  const total = totalLength(run);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.min(requestedOffset, total) : 0;
  const from = Math.max(offset, run.dropped);
  const end = Math.min(total, to, from + POLL_CHUNK_CHARS);
  const slice = run.output.slice(from - run.dropped, Math.max(0, end - run.dropped));
  const next = from + slice.length;
  return {
    ok: true,
    runId: run.id,
    target: run.target,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    output: slice,
    offset: next,
    more: next < Math.min(total, to),
    truncated: offset < run.dropped,
  };
};

const sseFrame = (frame: StreamFrame): string => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;

/** Write an SSE body, capped in size so the host proxy never truncates a frame. */
const respondSse = (res: http.ServerResponse, frames: StreamFrame[]): void => {
  let body = '';
  for (const frame of frames) {
    const text = sseFrame(frame);
    if (body.length > 0 && body.length + text.length > EVENT_BATCH_MAX_BYTES) break;
    body += text;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) reject(new Error('request too large'));
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, pid: process.pid });
      return;
    }

    // The push side: sequenced events, SSE frames, long-held when idle.
    if (url.pathname === '/events' && req.method === 'GET') {
      const raw = Number(url.searchParams.get('since') ?? '0');
      const since = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const wait = clampWait(url.searchParams.get('wait'));
      // Ahead of the log (a cursor from an earlier service run) or behind it:
      // either way the client re-reads its state instead of waiting forever.
      if (since > latestSeq() || since + 1 < oldestSeq()) {
        respondSse(res, [{ seq: latestSeq(), type: 'reset' }]);
        return;
      }
      let batch = eventsSince(since);
      if (batch.length === 0 && wait > 0) {
        await holdEvents(res, wait);
        batch = eventsSince(since);
      }
      respondSse(res, batch);
      return;
    }

    if (url.pathname === '/targets') {
      const directory = resolveDirectory(url.searchParams.get('directory'));
      if (!directory) {
        json(res, 400, { ok: false, error: 'invalid-directory' });
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(directory);
      } catch {
        json(res, 404, { ok: false, error: 'no-directory' });
        return;
      }
      if (!stat.isDirectory()) {
        json(res, 400, { ok: false, error: 'not-a-directory' });
        return;
      }
      const { makefile, targets } = await readTargets(directory);
      watchDirectory(directory);
      const signature = targetsSignature(makefile, targets);
      const previous = lastTargets.get(directory);
      if (previous !== undefined && previous !== signature) {
        emit({ type: 'targets', directory, makefile, targets });
      }
      lastTargets.set(directory, signature);
      json(res, 200, {
        ok: true,
        directory,
        makefile,
        targets,
        runs: latestRunsFor(directory),
        seq: latestSeq(),
      });
      return;
    }

    if (url.pathname === '/run' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { directory?: unknown; target?: unknown };
      const directory = resolveDirectory(body.directory);
      const target = typeof body.target === 'string' ? body.target.trim() : '';
      if (!directory || !target || /\s/.test(target)) {
        json(res, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      json(res, 200, { ok: true, run: snapshotOf(startRun(directory, target)) });
      return;
    }

    // Backfill only: the live tail arrives as `output` events.
    if (url.pathname === '/run' && req.method === 'GET') {
      const runId = url.searchParams.get('runId') ?? '';
      const requested = Number(url.searchParams.get('offset') ?? '0');
      const toRaw = Number(url.searchParams.get('to') ?? '');
      const to = Number.isFinite(toRaw) && toRaw > 0 ? toRaw : Number.POSITIVE_INFINITY;
      const run = runs.get(runId);
      if (!run) {
        json(res, 404, { ok: false, error: 'no-run' });
        return;
      }
      json(res, 200, answerFor(run, requested, to));
      return;
    }

    if (url.pathname === '/stop' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { runId?: unknown };
      const runId = typeof body.runId === 'string' ? body.runId : '';
      json(res, 200, { ok: stopRun(runId) });
      return;
    }

    json(res, 404, { error: 'not-found' });
  })().catch((error) => {
    console.error('[makefile] request failed', error);
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed' });
  });
});

server.listen(PORT, '127.0.0.1');

const shutdown = (): void => {
  for (const run of runs.values()) {
    if (run.status === 'running') run.child?.kill('SIGTERM');
  }
  for (const watcher of watchers.values()) watcher.close();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
