// service/main.ts
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// src/makefile.ts
var MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];
var isSpecial = (name) => name.length === 0 || name.startsWith(".") || name.includes("%") || name.includes("$") || name.includes("=");
var extractNames = (head) => {
  const names = [];
  for (const token of head.split(/\s+/)) {
    const name = token.replace(/&$/, "");
    if (!isSpecial(name))
      names.push(name);
  }
  return names;
};
var readPhonyTargets = (lines) => {
  const phony = new Set;
  for (const line of lines) {
    const match = /^\s*\.PHONY\s*:\s*(.*)$/.exec(line);
    if (!match)
      continue;
    for (const name of match[1].trim().split(/\s+/)) {
      if (name)
        phony.add(name);
    }
  }
  return phony;
};
var parseMakeTargets = (text) => {
  const lines = text.split(/\r?\n/);
  const phony = readPhonyTargets(lines);
  const found = new Map;
  let doc = null;
  let isFirst = true;
  for (const raw of lines) {
    if (raw.startsWith("\t"))
      continue;
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trimStart();
    if (!trimmed) {
      doc = null;
      continue;
    }
    if (trimmed.startsWith("#")) {
      const comment = /^#+\s?(.*)$/.exec(trimmed);
      if (trimmed.startsWith("##") && comment)
        doc = comment[1].trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      doc = null;
      continue;
    }
    const after = line.slice(colon);
    const head = line.slice(0, colon).trim();
    if (after.startsWith("::=") || after.startsWith(":=") || head.includes("$")) {
      doc = null;
      continue;
    }
    const inline = /##\s*(.+)$/.exec(line);
    for (const name of extractNames(head)) {
      const description = (inline?.[1]?.trim() ?? "") || doc || "";
      const existing = found.get(name);
      if (existing) {
        if (!existing.description && description)
          existing.description = description;
      } else {
        found.set(name, { name, description, phony: phony.has(name), default: isFirst });
        isFirst = false;
      }
    }
    doc = null;
  }
  return [...found.values()];
};

// service/main.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!PORT || !TOKEN) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var MAX_OUTPUT_CHARS = 400000;
var POLL_CHUNK_CHARS = 60000;
var MAX_RUNS = 40;
var EVENT_BUFFER_MAX = 4000;
var EVENT_BATCH_MAX_BYTES = 200000;
var MAX_HOLD_MS = 2000;
var PARKED_GRACE_MS = 1000;
var nextSeq = 1;
var eventLog = [];
var eventWaiters = new Set;
var latestSeq = () => nextSeq - 1;
var oldestSeq = () => eventLog.length > 0 ? eventLog[0].seq : nextSeq;
var emit = (event) => {
  eventLog.push({ ...event, seq: nextSeq });
  nextSeq += 1;
  if (eventLog.length > EVENT_BUFFER_MAX)
    eventLog.splice(0, eventLog.length - EVENT_BUFFER_MAX);
  for (const wake of [...eventWaiters])
    wake();
};
var eventsSince = (since) => eventLog.filter((event) => event.seq > since);
var parked = null;
var holdEvents = (res, waitMs) => new Promise((resolve) => {
  let done = false;
  let timer;
  const wake = () => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    eventWaiters.delete(wake);
    res.off("close", wake);
    if (parked?.supersede === wake)
      parked = null;
    resolve();
  };
  timer = setTimeout(wake, waitMs);
  eventWaiters.add(wake);
  res.on("close", wake);
  if (parked && Date.now() - parked.at >= PARKED_GRACE_MS) {
    const previous = parked;
    parked = null;
    previous.supersede();
  }
  parked = { at: Date.now(), supersede: wake };
});
var runs = new Map;
var runOrder = [];
var totalLength = (run) => run.dropped + run.output.length;
var snapshotOf = (run) => ({
  runId: run.id,
  directory: run.directory,
  target: run.target,
  status: run.status,
  exitCode: run.exitCode,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  length: totalLength(run)
});
var evictRuns = () => {
  while (runOrder.length > MAX_RUNS) {
    const id = runOrder.find((candidate) => runs.get(candidate)?.status !== "running");
    if (!id)
      return;
    runOrder.splice(runOrder.indexOf(id), 1);
    runs.delete(id);
  }
};
var appendOutput = (run, chunk) => {
  if (!chunk)
    return;
  run.output += chunk;
  if (run.output.length > MAX_OUTPUT_CHARS) {
    const cut = run.output.length - MAX_OUTPUT_CHARS;
    run.output = run.output.slice(cut);
    run.dropped += cut;
  }
  emit({ type: "output", directory: run.directory, runId: run.id, target: run.target, chunk });
};
var resolveDirectory = (value) => {
  if (typeof value !== "string" || !value.trim())
    return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
};
var findMakefile = async (directory) => {
  for (const name of MAKEFILE_NAMES) {
    const file = path.join(directory, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile())
        return { file, name };
    } catch {}
  }
  return null;
};
var readTargets = async (directory) => {
  const found = await findMakefile(directory);
  if (!found)
    return { makefile: null, targets: [] };
  const text = await fsp.readFile(found.file, "utf8");
  return { makefile: found.name, targets: parseMakeTargets(text) };
};
var targetsSignature = (makefile, targets) => `${makefile ?? ""}|${targets.map((t) => `${t.name}\x01${t.description}\x01${t.phony ? 1 : 0}${t.default ? 1 : 0}`).join("\x02")}`;
var latestRunsFor = (directory) => {
  const latest = {};
  for (const id of runOrder) {
    const run = runs.get(id);
    if (!run || run.directory !== directory)
      continue;
    latest[run.target] = snapshotOf(run);
  }
  return latest;
};
var lastTargets = new Map;
var watchers = new Map;
var rescans = new Map;
var rescanDirectory = async (directory) => {
  try {
    const { makefile, targets } = await readTargets(directory);
    const signature = targetsSignature(makefile, targets);
    if (lastTargets.get(directory) === signature)
      return;
    lastTargets.set(directory, signature);
    emit({ type: "targets", directory, makefile, targets });
  } catch {}
};
var watchDirectory = (directory) => {
  if (watchers.has(directory))
    return;
  try {
    const watcher = fs.watch(directory, () => {
      const pending = rescans.get(directory);
      if (pending)
        clearTimeout(pending);
      rescans.set(directory, setTimeout(() => {
        rescans.delete(directory);
        rescanDirectory(directory);
      }, 300));
    });
    watcher.on("error", () => {
      watchers.delete(directory);
      watcher.close();
    });
    watcher.unref?.();
    watchers.set(directory, watcher);
  } catch {}
};
var ENV_MARKER = "__openchamber_makefile_env__";
var SHELL_ENV_TIMEOUT_MS = 5000;
var shellPath = () => {
  if (process.env.OPENCHAMBER_MAKEFILE_SHELL)
    return process.env.OPENCHAMBER_MAKEFILE_SHELL;
  if (process.env.SHELL)
    return process.env.SHELL;
  try {
    return os.userInfo().shell || "/bin/sh";
  } catch {
    return "/bin/sh";
  }
};
var shellArgs = (shell, script) => {
  const name = path.basename(shell);
  return name === "zsh" || name === "bash" ? ["-l", "-i", "-c", script] : ["-l", "-c", script];
};
var parseShellEnv = (text) => {
  const parts = text.split("\x00");
  const start = parts.indexOf(ENV_MARKER);
  const end = parts.indexOf(ENV_MARKER, start + 1);
  if (start < 0 || end < 0)
    return null;
  const env = {};
  for (const entry of parts.slice(start + 1, end)) {
    const eq = entry.indexOf("=");
    if (eq > 0)
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
};
var captureShellEnv = () => {
  if (process.platform === "win32")
    return Promise.resolve(null);
  const shell = shellPath();
  const script = `printf '%s\\0' ${ENV_MARKER}; env -0; printf '%s\\0' ${ENV_MARKER}`;
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const done = (value) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(shell, shellArgs(shell, script), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, SHELL_ENV_TIMEOUT_MS);
    timer.unref?.();
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => done(null));
    child.on("close", () => {
      const env = parseShellEnv(out);
      if (env)
        console.error(`[makefile] using the environment of ${shell}`);
      done(env);
    });
  });
};
var shellEnvPromise = null;
var shellEnv = () => {
  shellEnvPromise ??= captureShellEnv();
  return shellEnvPromise;
};
var runEnv = (captured) => captured ? { ...process.env, ...captured } : { ...process.env };
var runSequence = 0;
var startRun = (directory, target, env) => {
  const run = {
    id: `run_${Date.now().toString(36)}_${(runSequence += 1).toString(36)}`,
    directory,
    target,
    child: null,
    output: "",
    dropped: 0,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null
  };
  runs.set(run.id, run);
  runOrder.push(run.id);
  evictRuns();
  emit({ type: "run", directory, run: snapshotOf(run) });
  let settled = false;
  const finish = (status, code) => {
    if (settled)
      return;
    settled = true;
    run.status = status;
    run.exitCode = code;
    run.finishedAt = Date.now();
    run.child = null;
    emit({ type: "run", directory, run: snapshotOf(run) });
  };
  let child;
  try {
    child = spawn("make", ["--no-print-directory", target], { cwd: directory, env });
  } catch (error) {
    appendOutput(run, `${error instanceof Error ? error.message : String(error)}
`);
    finish("failed", null);
    return run;
  }
  run.child = child;
  child.stdout?.on("data", (chunk) => appendOutput(run, chunk.toString()));
  child.stderr?.on("data", (chunk) => appendOutput(run, chunk.toString()));
  child.on("error", (error) => {
    appendOutput(run, `${error.message}
`);
    finish("failed", null);
  });
  child.on("close", (code, signal) => {
    if (signal)
      finish("stopped", null);
    else
      finish(code === 0 ? "success" : "failed", code ?? null);
  });
  return run;
};
var stopRun = (runId) => {
  const run = runs.get(runId);
  if (!run || !run.child || run.status !== "running")
    return false;
  run.child.kill("SIGTERM");
  const child = run.child;
  setTimeout(() => {
    if (run.status === "running" && child)
      child.kill("SIGKILL");
  }, 3000).unref?.();
  return true;
};
var clampWait = (raw) => {
  const value = Number(raw ?? "0");
  if (!Number.isFinite(value) || value <= 0)
    return 0;
  return Math.min(value, MAX_HOLD_MS);
};
var answerFor = (run, requestedOffset, to) => {
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
    truncated: offset < run.dropped
  };
};
var sseFrame = (frame) => `event: ${frame.type}
data: ${JSON.stringify(frame)}

`;
var respondSse = (res, frames) => {
  let body = "";
  for (const frame of frames) {
    const text = sseFrame(frame);
    if (body.length > 0 && body.length + text.length > EVENT_BATCH_MAX_BYTES)
      break;
    body += text;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
};
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e6)
      reject(new Error("request too large"));
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
var server = http.createServer((req, res) => {
  (async () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, pid: process.pid });
      return;
    }
    if (url.pathname === "/events" && req.method === "GET") {
      const raw = Number(url.searchParams.get("since") ?? "0");
      const since = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const wait = clampWait(url.searchParams.get("wait"));
      if (since > latestSeq() || since + 1 < oldestSeq()) {
        respondSse(res, [{ seq: latestSeq(), type: "reset" }]);
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
    if (url.pathname === "/targets") {
      const directory = resolveDirectory(url.searchParams.get("directory"));
      if (!directory) {
        json(res, 400, { ok: false, error: "invalid-directory" });
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(directory);
      } catch {
        json(res, 404, { ok: false, error: "no-directory" });
        return;
      }
      if (!stat.isDirectory()) {
        json(res, 400, { ok: false, error: "not-a-directory" });
        return;
      }
      const { makefile, targets } = await readTargets(directory);
      watchDirectory(directory);
      const signature = targetsSignature(makefile, targets);
      const previous = lastTargets.get(directory);
      if (previous !== undefined && previous !== signature) {
        emit({ type: "targets", directory, makefile, targets });
      }
      lastTargets.set(directory, signature);
      json(res, 200, {
        ok: true,
        directory,
        makefile,
        targets,
        runs: latestRunsFor(directory),
        seq: latestSeq()
      });
      return;
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const directory = resolveDirectory(body.directory);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (!directory || !target || /\s/.test(target)) {
        json(res, 400, { ok: false, error: "invalid-request" });
        return;
      }
      const env = runEnv(await shellEnv());
      json(res, 200, { ok: true, run: snapshotOf(startRun(directory, target, env)) });
      return;
    }
    if (url.pathname === "/run" && req.method === "GET") {
      const runId = url.searchParams.get("runId") ?? "";
      const requested = Number(url.searchParams.get("offset") ?? "0");
      const toRaw = Number(url.searchParams.get("to") ?? "");
      const to = Number.isFinite(toRaw) && toRaw > 0 ? toRaw : Number.POSITIVE_INFINITY;
      const run = runs.get(runId);
      if (!run) {
        json(res, 404, { ok: false, error: "no-run" });
        return;
      }
      json(res, 200, answerFor(run, requested, to));
      return;
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const runId = typeof body.runId === "string" ? body.runId : "";
      json(res, 200, { ok: stopRun(runId) });
      return;
    }
    json(res, 404, { error: "not-found" });
  })().catch((error) => {
    console.error("[makefile] request failed", error);
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : "failed" });
  });
});
server.listen(PORT, "127.0.0.1");
shellEnv();
var shutdown = () => {
  for (const run of runs.values()) {
    if (run.status === "running")
      run.child?.kill("SIGTERM");
  }
  for (const watcher of watchers.values())
    watcher.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
