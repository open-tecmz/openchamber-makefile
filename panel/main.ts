/**
 * OpenChamber Makefile — rail panel (and full-screen page).
 *
 * The panel is event-driven: it loads targets once, then drains the service's
 * SSE event stream (`GET /events`), applying `run`, `output` and `targets`
 * events to its state. Commands (run / stop) stay request/response; everything
 * the service pushes back arrives on the one stream.
 *
 * The host bridge buffers a service response, so `/events` is long-held (the
 * service answers the moment there is something to send) and reopened right
 * after each answer. The same endpoint would work with a real `EventSource`
 * once the host exposes a streaming call.
 *
 * Panel copy follows the OpenChamber language (`ctx.locale`); see `src/i18n.ts`.
 */

import { HostRequestError, connectHost, type HostClient } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSpinner,
} from '@openchamber/sdk/ui';

import type {
  MakeTarget,
  RunOutput,
  RunSnapshot,
  RunStatus,
  StreamEvent,
  StreamFrame,
  TargetsAnswer,
} from '../src/makefile.ts';
import { createTranslator, type Translator } from '../src/i18n.ts';

const host: HostClient = connectHost({ requestTimeoutMs: 25_000 });
const root = document.querySelector('#root') as HTMLElement;

/** Slow beat: only health detection and the badge; no per-run requests. */
const BEAT_MS = 5000;
/** While the service is off, retry the health check at this cadence. */
const DETECT_EVERY_MS = 5000;
/**
 * The hold the panel asks the event stream for. The service caps it, and the cap
 * is short on purpose: a parked read holds a whole connection from the panel to
 * the service, and a sandboxed panel has only a few of them — a reader left
 * behind by a reload or a directory switch (the host cannot cancel a request
 * already in flight) must not push the panel's next request into a queue behind
 * it. The panel reopens the stream the moment one answer arrives, so an event
 * still shows up as soon as it happens.
 */
const LONG_POLL_MS = 2_000;

type Mode = 'service' | 'off' | 'error' | 'unknown';

type ProjectRef = { directory: string; name: string };

type RunView = {
  runId: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  output: string;
  /** Absolute offset the output has been filled to (== output end). */
  offset: number;
  truncated: boolean;
  /** Output events held while a backfill is still catching up. */
  pending: string;
  /** True while /run is fetching the pre-connection tail of a run. */
  needsBackfill: boolean;
  backfillTo: number;
};

let t: Translator = createTranslator('en');
let localeTag = 'en';
let mode: Mode = 'unknown';
let project: ProjectRef | null = null;
let directory: string | null = null;
let makefileName: string | null = null;
let targets: MakeTarget[] = [];
let targetsLoaded = false;
let loadError: string | null = null;
/** Live filter over target name/description, typed in the header search box. */
let searchQuery = '';
let renderKey = '';
let panelMounted = false;
let mounted = false;
let beatTimer: number | null = null;
let lastDetectAt = 0;
let lastBadge: number | null = null;

/** Last event sequence applied; the stream resumes from here. */
let cursor = 0;
/** Bumped to stop a running stream loop (service loss). */
let streamGen = 0;
/** True while a loop is draining the stream: one reader is all the panel needs. */
let streaming = false;

const runs = new Map<string, RunView>();
const expanded = new Set<string>();
/** Target -> in-flight command, so Run/Stop shows a spinner until the answer. */
const pending = new Map<string, 'start' | 'stop'>();
const disposables: Array<{ dispose: () => void }> = [];
const logRefs = new Map<string, { log: HTMLElement; meta: HTMLElement; status: HTMLElement }>();
const backfills = new Set<string>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Service client
// ---------------------------------------------------------------------------

const service = {
  async json<T>(method: string, path: string, query?: Record<string, string>, body?: string): Promise<T> {
    const result = await host.serviceRequest({
      method: method as never,
      path,
      ...(query ? { query } : {}),
      ...(body ? { body } : {}),
    });
    return JSON.parse(result.body) as T;
  },
  /** Raw body, for the SSE event stream and the health probe alike. */
  async text(method: string, path: string, query?: Record<string, string>): Promise<string> {
    const result = await host.serviceRequest({
      method: method as never,
      path,
      ...(query ? { query } : {}),
    });
    return result.body;
  },
  stream(since: number): Promise<string> {
    return this.text('GET', '/events', { since: String(since), wait: String(LONG_POLL_MS) });
  },
  async health(): Promise<void> {
    await this.text('GET', '/health');
  },
  targets(directory: string): Promise<TargetsAnswer> {
    return this.json('GET', '/targets', { directory });
  },
  run(directory: string, target: string): Promise<{ ok: boolean; run: RunSnapshot }> {
    return this.json('POST', '/run', undefined, JSON.stringify({ directory, target }));
  },
  backfill(runId: string, offset: number, to: number): Promise<RunOutput> {
    return this.json('GET', '/run', { runId, offset: String(offset), to: String(to) });
  },
  stop(runId: string): Promise<{ ok: boolean }> {
    return this.json('POST', '/stop', undefined, JSON.stringify({ runId }));
  },
};

const isNoService = (error: unknown): boolean =>
  error instanceof HostRequestError && (error.code === 'NO_SERVICE' || error.code === 'DISABLED');

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const projectNameFor = (dir: string): string => dir.split('/').filter(Boolean).pop() ?? dir;

const runningCount = (): number => {
  let count = 0;
  for (const view of runs.values()) if (view.status === 'running') count += 1;
  return count;
};

const statusLabel = (status: RunStatus): string => {
  switch (status) {
    case 'running': return t('target.running');
    case 'success': return t('status.success');
    case 'failed': return t('status.failed');
    case 'stopped': return t('status.stopped');
    default: return t('status.unknown');
  }
};

const viewTone = (view: RunView | undefined): string => (view ? view.status : 'idle');

/** Head label: a target with no run yet is "not run", not an unknown status. */
const headLabel = (view: RunView | undefined): string => (view ? statusLabel(view.status) : t('target.ready'));

/** Tone for the head/status dot, showing a busy state while a command is in flight. */
const headTone = (target: string, view: RunView | undefined): string =>
  pending.has(target) ? 'pending' : viewTone(view);

/** Head label, showing the in-flight command (start/stop) while one is running. */
const headLabelFor = (target: string, view: RunView | undefined): string => {
  const action = pending.get(target);
  if (action === 'start') return t('target.starting');
  if (action === 'stop') return t('target.stopping');
  return headLabel(view);
};

/** Placeholder shown in the log area while there is no output to display yet. */
const logPlaceholder = (target: string, view: RunView | undefined): string => {
  if (pending.get(target) === 'start') return t('target.starting');
  if (view?.needsBackfill) return t('log.loading');
  if (view?.status === 'running') return '';
  return t('log.empty');
};

const metaText = (view: RunView | undefined): string => {
  if (!view) return t('target.ready');
  if (view.status === 'running') return t('target.running');
  const parts: string[] = [statusLabel(view.status)];
  if (view.exitCode !== null) parts.push(t('log.exit', { code: view.exitCode }));
  if (view.finishedAt !== null && view.startedAt) {
    parts.push(t('log.duration', { s: ((view.finishedAt - view.startedAt) / 1000).toFixed(1) }));
  }
  if (view.truncated) parts.push(t('log.truncated'));
  return parts.join(' · ');
};

/** Meta line, preferring the in-flight command over the last run's summary. */
const metaTextFor = (target: string, view: RunView | undefined): string => {
  const action = pending.get(target);
  if (action === 'start') return t('target.starting');
  if (action === 'stop') return t('target.stopping');
  return metaText(view);
};

const makeView = (snapshot: RunSnapshot): RunView => ({
  runId: snapshot.runId,
  status: snapshot.status,
  exitCode: snapshot.exitCode,
  startedAt: snapshot.startedAt,
  finishedAt: snapshot.finishedAt,
  output: '',
  offset: 0,
  truncated: false,
  pending: '',
  needsBackfill: false,
  backfillTo: 0,
});

// ---------------------------------------------------------------------------
// Loading, backfill and the event stream
// ---------------------------------------------------------------------------

const setBadge = (): void => {
  const count = runningCount();
  if (count === lastBadge) return;
  lastBadge = count;
  void host.setBadge(count > 0 ? count : null).catch(() => undefined);
};

const detectMode = async (): Promise<Mode> => {
  lastDetectAt = Date.now();
  try {
    await service.health();
    mode = 'service';
  } catch (error) {
    if (error instanceof HostRequestError) {
      if (error.code === 'NO_SERVICE' || error.code === 'DISABLED') mode = 'off';
      else if (error.code === 'SERVICE_FAILED') mode = 'error';
      else mode = 'unknown';
    } else {
      mode = 'unknown';
    }
  }
  return mode;
};

const handleServiceLost = async (): Promise<void> => {
  stopStream();
  await detectMode();
  render();
};

/** Backfill the pre-connection tail of one run, up to its snapshot length. */
const ensureBackfill = (target: string): void => {
  const view = runs.get(target);
  if (!view?.needsBackfill || backfills.has(target)) return;
  backfills.add(target);
  void (async () => {
    try {
      while (runs.get(target) === view && view.offset < view.backfillTo) {
        const answer = await service.backfill(view.runId, view.offset, view.backfillTo);
        if (!answer.ok) break;
        if (answer.output) {
          view.output += answer.output;
          view.offset = answer.offset;
        } else if (answer.offset <= view.offset) {
          break;
        } else {
          view.offset = answer.offset;
        }
        view.truncated = view.truncated || answer.truncated;
      }
      if (runs.get(target) === view) {
        view.needsBackfill = false;
        if (view.pending) {
          view.output += view.pending;
          view.offset += view.pending.length;
          view.pending = '';
        }
        syncLog(target);
      }
    } catch (error) {
      if (isNoService(error)) await handleServiceLost();
    } finally {
      backfills.delete(target);
    }
  })();
};

/** Fetch the full state for the current directory and reset the cursor. */
const loadState = async (): Promise<boolean> => {
  if (!directory || mode !== 'service') return false;
  try {
    const answer = await service.targets(directory);
    targetsLoaded = true;
    if (!answer.ok) {
      loadError = answer.error ?? 'failed';
      render();
      return false;
    }
    makefileName = answer.makefile;
    targets = answer.targets;
    loadError = null;
    cursor = answer.seq;
    runs.clear();
    for (const [name, snapshot] of Object.entries(answer.runs ?? {})) {
      const view = makeView(snapshot);
      view.backfillTo = snapshot.length;
      view.needsBackfill = snapshot.length > 0;
      runs.set(name, view);
    }
    render();
    for (const [name, view] of runs) if (view.needsBackfill) ensureBackfill(name);
    return true;
  } catch (error) {
    if (isNoService(error)) {
      await handleServiceLost();
      return false;
    }
    targetsLoaded = true;
    loadError = error instanceof Error ? error.message : String(error);
    render();
    return false;
  }
};

/** Parse an SSE body into typed frames. */
const parseSse = (body: string): StreamFrame[] => {
  const frames: StreamFrame[] = [];
  for (const block of body.split('\n\n')) {
    let name = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!name || !data) continue;
    try {
      frames.push(JSON.parse(data) as StreamFrame);
    } catch {
      // ignore a malformed frame
    }
  }
  return frames;
};

const applyEvent = (event: StreamEvent): void => {
  if (event.type === 'targets') {
    if (event.directory !== directory) return;
    makefileName = event.makefile;
    targets = event.targets;
    targetsLoaded = true;
    loadError = null;
    render();
    return;
  }
  if (event.directory !== directory) return;

  if (event.type === 'run') {
    const existing = runs.get(event.run.target);
    if (existing) {
      existing.runId = event.run.runId;
      existing.status = event.run.status;
      existing.exitCode = event.run.exitCode;
      existing.startedAt = event.run.startedAt;
      existing.finishedAt = event.run.finishedAt;
    } else {
      runs.set(event.run.target, makeView(event.run));
    }
    syncLog(event.run.target);
    render();
    return;
  }

  // output
  const view = runs.get(event.target);
  if (!view) return;
  if (view.needsBackfill) {
    view.pending += event.chunk;
    return;
  }
  view.output += event.chunk;
  view.offset += event.chunk.length;
  syncLog(event.target);
};

/**
 * Drain the event stream; reopen immediately after each answer. The log belongs
 * to the service, not to a directory, so this loop keeps running while the user
 * moves between projects: one reader, one connection.
 */
const consumeEvents = async (gen: number): Promise<void> => {
  let retryDelay = 0;
  try {
    while (gen === streamGen && mode === 'service' && directory) {
      retryDelay = 0;
      try {
        const body = await service.stream(cursor);
        if (gen !== streamGen) return;
        let reset = false;
        for (const frame of parseSse(body)) {
          // A reset is about the log itself, so it is read before the cursor
          // check: the service may have restarted with a lower sequence.
          if (frame.type === 'reset') {
            reset = true;
            continue;
          }
          // Already covered by a state read (or applied earlier): a read that
          // was in flight while the state was fetched can still answer with it.
          if (frame.seq <= cursor) continue;
          cursor = frame.seq;
          applyEvent(frame);
        }
        if (reset) await loadState();
      } catch (error) {
        if (isNoService(error)) {
          await handleServiceLost();
          return;
        }
        // The host bridge dropped the hold: pause, then reopen the stream.
        retryDelay = 1000;
      }
      if (retryDelay > 0) await sleep(retryDelay);
    }
  } finally {
    // A loop that ended on its own condition must let the next one start.
    if (gen === streamGen) streaming = false;
  }
};

const stopStream = (): void => {
  streamGen += 1;
  streaming = false;
};

const startStream = (): void => {
  if (streaming) return;
  if (mode !== 'service' || !directory) return;
  streaming = true;
  void consumeEvents(streamGen);
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const startRun = async (target: string): Promise<void> => {
  if (mode !== 'service' || !directory || pending.has(target)) return;
  pending.set(target, 'start');
  render();
  try {
    const answer = await service.run(directory, target);
    if (!answer.ok) {
      await host.toast({ kind: 'error', message: t('toast.runFailed') });
      return;
    }
    runs.set(target, makeView(answer.run));
    expanded.add(target);
  } catch (error) {
    if (isNoService(error)) await handleServiceLost();
    else await host.toast({ kind: 'error', message: t('toast.runFailed') });
  } finally {
    pending.delete(target);
    render();
  }
};

const stopRun = async (target: string): Promise<void> => {
  const view = runs.get(target);
  if (!view || pending.has(target)) return;
  pending.set(target, 'stop');
  render();
  try {
    await service.stop(view.runId);
  } catch (error) {
    if (isNoService(error)) await handleServiceLost();
  } finally {
    pending.delete(target);
    render();
  }
};

const clearLog = (target: string): void => {
  const view = runs.get(target);
  if (!view) return;
  view.output = '';
  view.pending = '';
  syncLog(target);
};

const copyLog = async (target: string): Promise<void> => {
  const view = runs.get(target);
  if (!view?.output) return;
  try {
    await host.writeClipboard(view.output);
    await host.toast({ kind: 'success', message: t('toast.copied') });
  } catch {
    await host.toast({ kind: 'error', message: t('toast.copyFailed') });
  }
};

const toggleTarget = (target: string): void => {
  if (expanded.has(target)) {
    expanded.delete(target);
    render();
    return;
  }
  expanded.add(target);
  // Opening a target that was never run starts it right away; a target with a
  // previous run just shows its last output until "Run again" is pressed.
  if (!runs.has(target)) {
    void startRun(target);
    return;
  }
  render();
};

// ---------------------------------------------------------------------------
// Beat: health detection and badge only (the stream does the rest)
// ---------------------------------------------------------------------------

const beat = async (): Promise<void> => {
  if (!panelMounted || !directory) return;
  if (mode !== 'service') {
    if (Date.now() - lastDetectAt > DETECT_EVERY_MS) {
      const next = await detectMode();
      if (next === 'service') {
        render();
        if (await loadState()) startStream();
      } else {
        render();
      }
    }
    return;
  }
  setBadge();
};

const startBeat = (): void => {
  if (beatTimer !== null) window.clearInterval(beatTimer);
  beatTimer = window.setInterval(() => void beat(), BEAT_MS);
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * One persistent search box, re-appended into each rebuilt header. Keeping the
 * same node (rather than creating it per render) is what lets focus and caret
 * survive the full re-render that every keystroke triggers.
 */
let searchInput: HTMLInputElement | null = null;

const ensureSearchInput = (): HTMLInputElement => {
  if (searchInput) return searchInput;
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'mf-search-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => {
    searchQuery = input.value;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchQuery) {
      event.preventDefault();
      searchQuery = '';
      input.value = '';
      render();
    }
  });
  searchInput = input;
  return input;
};

/**
 * Capture the search box focus/caret before a rebuild and return a restore
 * callback to run once the new DOM is in place.
 */
const captureSearchFocus = (): (() => void) => {
  const input = searchInput;
  if (!input || document.activeElement !== input) return () => {};
  const start = input.selectionStart;
  const end = input.selectionEnd;
  return () => {
    if (!searchInput) return;
    searchInput.focus();
    if (start !== null && end !== null) searchInput.setSelectionRange(start, end);
  };
};

const clearSearch = (): void => {
  if (!searchQuery) return;
  searchQuery = '';
  if (searchInput) searchInput.value = '';
  render();
  searchInput?.focus();
};

const clearDisposables = (): void => {
  while (disposables.length > 0) disposables.pop()?.dispose();
};

const syncLog = (target: string): void => {
  const refs = logRefs.get(target);
  if (!refs) return;
  const view = runs.get(target);
  const text = view?.output ?? '';
  refs.log.textContent = text || logPlaceholder(target, view);
  refs.log.classList.toggle('mf-log-empty', !text);
  refs.meta.textContent = metaTextFor(target, view);
  refs.status.textContent = headLabelFor(target, view);
  refs.status.className = `mf-status mf-status-${headTone(target, view)}`;
  if (view?.status === 'running') refs.log.scrollTop = refs.log.scrollHeight;
};

const targetsSignature = (): string =>
  targets.map((target) => `${target.name}\u0001${target.description}\u0001${target.phony ? 1 : 0}${target.default ? 1 : 0}`).join('\u0002');

const runsSignature = (): string =>
  [...runs.entries()]
    .map(([name, view]) => `${name}:${view.status}:${view.exitCode ?? ''}:${view.finishedAt ?? ''}:${view.truncated ? 1 : 0}`)
    .join('|');

const matchesSearch = (target: MakeTarget, needle: string): boolean =>
  target.name.toLowerCase().includes(needle) || target.description.toLowerCase().includes(needle);

const render = (): void => {
  if (!panelMounted) return;
  const needle = searchQuery.trim().toLowerCase();
  const visibleTargets = needle ? targets.filter((target) => matchesSearch(target, needle)) : targets;
  const searching = needle.length > 0;
  const key = JSON.stringify({
    localeTag,
    mode,
    directory,
    makefileName,
    targetsLoaded,
    loadError,
    search: searchQuery,
    targets: targetsSignature(),
    expanded: [...expanded].sort(),
    runs: runsSignature(),
    pending: [...pending.entries()].sort(),
  });
  if (key === renderKey) return;
  renderKey = key;

  const restoreFocus = captureSearchFocus();
  paint(visibleTargets, searching);
  restoreFocus();
};

const paint = (visibleTargets: MakeTarget[], searching: boolean): void => {
  clearDisposables();
  logRefs.clear();
  root.textContent = '';

  const header = root.appendChild(el('div', 'mf-header'));
  const titleRow = header.appendChild(el('div', 'mf-title-row'));
  titleRow.appendChild(el('span', 'mf-title', t('title')));
  titleRow.appendChild(el('span', 'mf-project', project?.name ?? t('noProject')));
  disposables.push(mountBadge(titleRow, {
    label: mode === 'service' ? t('mode.service') : mode === 'off' ? t('mode.off') : t('mode.unknown'),
    tone: mode === 'service' ? 'info' : mode === 'error' ? 'error' : mode === 'off' ? 'warning' : 'neutral',
  }));
  const countsRow = header.appendChild(el('div', 'mf-counts'));
  disposables.push(mountBadge(countsRow, {
    label: searching ? t('count.matches', { n: visibleTargets.length, m: targets.length }) : t('count.targets', { n: targets.length }),
    tone: searching && visibleTargets.length === 0 ? 'warning' : 'neutral',
  }));
  if (runningCount() > 0) {
    disposables.push(mountBadge(countsRow, { label: t('count.running', { n: runningCount() }), tone: 'primary' }));
  }
  if (makefileName && directory) {
    header.appendChild(el('div', 'mf-makefile', makefileName));
  }

  // The search box rides above the list and stays put while filtering, so it is
  // part of the header even when nothing matches.
  if (targetsLoaded && targets.length > 0) {
    const row = header.appendChild(el('div', 'mf-search'));
    const input = ensureSearchInput();
    input.placeholder = t('search.placeholder');
    input.setAttribute('aria-label', t('search.placeholder'));
    if (input.value !== searchQuery) input.value = searchQuery;
    row.appendChild(input);
    if (searchQuery) {
      const clear = row.appendChild(el('button', 'mf-search-clear', '×')) as HTMLButtonElement;
      clear.type = 'button';
      clear.title = t('search.clear');
      clear.setAttribute('aria-label', t('search.clear'));
      clear.addEventListener('click', () => clearSearch());
    }
  }

  if (mode === 'off') {
    disposables.push(mountBanner(root, { tone: 'warning', title: t('banner.off.title'), body: t('banner.off.body') }));
  } else if (mode === 'error' || mode === 'unknown') {
    disposables.push(mountBanner(root, { tone: 'error', title: t('banner.error.title'), body: t('banner.error.body') }));
  }

  if (!project || !directory) {
    disposables.push(mountEmpty(root, { title: t('empty.noProject.title'), body: t('empty.noProject.body') }));
    return;
  }

  if (mode !== 'service') return;

  if (!targetsLoaded) {
    const loading = root.appendChild(el('div', 'mf-loading'));
    disposables.push(mountSpinner(loading, { label: t('mode.unknown') }));
    return;
  }

  if (loadError && targets.length === 0) {
    disposables.push(mountBanner(root, { tone: 'error', title: t('toast.loadFailed'), body: loadError }));
  }

  if (targets.length === 0) {
    disposables.push(mountEmpty(root, { title: t('empty.noTargets.title'), body: t('empty.noTargets.body') }));
    return;
  }

  if (visibleTargets.length === 0) {
    disposables.push(mountEmpty(root, { title: t('search.empty.title'), body: t('search.empty.body') }));
    return;
  }

  const list = root.appendChild(el('div', 'mf-list'));
  for (const target of visibleTargets) list.appendChild(renderTarget(target));
  for (const target of expanded) syncLog(target);
};

const renderTarget = (target: MakeTarget): HTMLElement => {
  const view = runs.get(target.name);
  const open = expanded.has(target.name);
  const action = pending.get(target.name);
  const tone = headTone(target.name, view);

  const item = el('div', `mf-item mf-item-${tone}${open ? ' mf-open' : ''}`);
  const head = item.appendChild(el('button', 'mf-head')) as HTMLButtonElement;
  head.type = 'button';
  head.appendChild(el('span', 'mf-chevron', '›'));
  head.appendChild(el('span', 'mf-name', target.name));

  const tags = el('span', 'mf-tags');
  if (target.default) tags.appendChild(el('span', 'mf-tag mf-tag-default', t('target.default')));
  if (target.phony) tags.appendChild(el('span', 'mf-tag', t('target.phony')));
  head.appendChild(tags);

  head.appendChild(el('span', 'mf-desc', target.description));
  const status = el('span', `mf-status mf-status-${tone}`, headLabelFor(target.name, view));
  head.appendChild(status);
  head.addEventListener('click', () => toggleTarget(target.name));

  const body = item.appendChild(el('div', 'mf-body'));
  const toolbar = body.appendChild(el('div', 'mf-toolbar'));
  const meta = toolbar.appendChild(el('span', 'mf-meta', metaTextFor(target.name, view)));
  const actions = toolbar.appendChild(el('div', 'mf-actions'));

  const running = view?.status === 'running';
  // Keep one action button: it turns into a spinner while a command is in flight.
  const actionLabel = action === 'start' ? t('target.run')
    : action === 'stop' ? t('target.stop')
    : running ? t('target.stop')
    : view ? t('target.rerun')
    : t('target.run');
  disposables.push(mountButton(actions, {
    label: actionLabel,
    size: 'xs',
    variant: running || action === 'stop' ? 'outline' : 'default',
    loading: action !== undefined,
    onClick: () => (running ? void stopRun(target.name) : void startRun(target.name)),
  }));
  disposables.push(mountButton(actions, {
    label: t('log.copy'),
    size: 'xs',
    variant: 'ghost',
    disabled: !view?.output,
    onClick: () => void copyLog(target.name),
  }));
  disposables.push(mountButton(actions, {
    label: t('log.clear'),
    size: 'xs',
    variant: 'ghost',
    disabled: !view?.output,
    onClick: () => clearLog(target.name),
  }));

  const log = body.appendChild(el('pre', 'mf-log mf-log-empty'));
  if (view?.output) {
    log.textContent = view.output;
    log.classList.remove('mf-log-empty');
    if (running) queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  } else if (!running || action) {
    log.textContent = logPlaceholder(target.name, view);
  }

  logRefs.set(target.name, { log, meta, status });
  return item;
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const switchDirectory = async (next: string | null): Promise<void> => {
  // The stream is the service's own and carries every directory, so it keeps
  // running: only the state read below re-syncs the cursor.
  directory = next;
  project = next ? { directory: next, name: projectNameFor(next) } : null;
  targets = [];
  makefileName = null;
  targetsLoaded = false;
  loadError = null;
  searchQuery = '';
  if (searchInput) searchInput.value = '';
  runs.clear();
  expanded.clear();
  pending.clear();
  logRefs.clear();
  backfills.clear();
  cursor = 0;
  renderKey = '';
  await detectMode();
  if (mode === 'service') {
    // Paint the loading state before the (possibly slow) target fetch.
    render();
    if (await loadState()) startStream();
  }
  render();
};

const preparePanel = async (): Promise<void> => {
  await detectMode();
  if (mode === 'service') {
    // Paint the loading state before the (possibly slow) target fetch.
    render();
    if (await loadState()) startStream();
  }
  render();
  startBeat();
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  localeTag = ctx.locale;
  t = createTranslator(ctx.locale);
  document.documentElement.lang = ctx.locale;
  document.body.dataset.surface = ctx.surface;

  if (!mounted) {
    mounted = true;
    panelMounted = true;
    directory = ctx.directory;
    project = ctx.directory ? { directory: ctx.directory, name: projectNameFor(ctx.directory) } : null;
    void preparePanel();
    return;
  }
  if (ctx.directory !== directory) void switchDirectory(ctx.directory);
});

host.onDirectory((next) => {
  if (!panelMounted) return;
  if (next === directory) return;
  void switchDirectory(next);
});
