/**
 * Service log file.
 *
 * OpenChamber captures the service's stdout/stderr but keeps it nowhere the user
 * can read later, so the service also writes its own log beside the user's other
 * config: `~/.config/openchamber-makefile/logs/service.log`. It never writes into
 * the project. A single file is capped at 10 MiB; past that the active file is
 * renamed aside (the newest few are kept) and a fresh one is started, so the log
 * can be read after something went wrong without growing without bound.
 *
 * Logging is best-effort: if the directory cannot be written, the service keeps
 * running and stderr remains the only output.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A single log file rolls over once it would pass this size. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** Rolled-over files kept beside the active one; the oldest are pruned. */
const KEEP_LOG_FILES = 5;
/** The active file, always the newest so `tail` finds it without thinking. */
const ACTIVE_NAME = 'service.log';
/** Rolled-over names start with this, which is what the pruner matches. */
const ARCHIVE_PREFIX = 'service-';

const resolveLogDir = (): string => {
  // The tests point this at a scratch directory so they never touch the user's
  // real log. `XDG_CONFIG_HOME` is the standard home for `~/.config`.
  const override = process.env.OPENCHAMBER_MAKEFILE_LOG_DIR;
  if (override) return path.resolve(override);
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'openchamber-makefile', 'logs');
};

let directory: string | null = null;
let activePath: string | null = null;
let activeBytes = 0;

/** A rolled-over file name; the timestamp keeps rotations from colliding. */
const archiveName = (): string =>
  `${ARCHIVE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

/** Keep only the newest KEEP_LOG_FILES rolled-over files. */
const prune = (): void => {
  if (!directory) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  const archives = entries
    .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith('.log'))
    .sort();
  for (const name of archives.slice(0, Math.max(0, archives.length - KEEP_LOG_FILES))) {
    try {
      fs.rmSync(path.join(directory, name), { force: true });
    } catch {
      // Pruning is housekeeping; a leftover file is harmless.
    }
  }
};

/** Move the active file aside and start a fresh one in its place. */
const rotate = (): void => {
  if (!directory || !activePath) return;
  try {
    fs.renameSync(activePath, path.join(directory, archiveName()));
  } catch {
    // If the rename fails the append still lands in the active file; only the
    // size bookkeeping resets, which is the safe direction to be wrong in.
  }
  activeBytes = 0;
  prune();
};

/**
 * Prepare the log file. Called once at boot; a failure disables file logging but
 * never the service.
 */
export const initLog = (): void => {
  try {
    const dir = resolveLogDir();
    fs.mkdirSync(dir, { recursive: true });
    directory = dir;
    activePath = path.join(dir, ACTIVE_NAME);
    try {
      activeBytes = fs.statSync(activePath).size;
    } catch {
      activeBytes = 0;
    }
    // A file left over from a previous service run may already be full.
    if (activeBytes >= MAX_LOG_BYTES) rotate();
    prune();
  } catch {
    directory = null;
    activePath = null;
  }
};

/** Absolute path of the active log file, or null when file logging is off. */
export const logPath = (): string | null => activePath;

const write = (level: string, message: string): void => {
  if (!activePath) return;
  const line = `${new Date().toISOString()} ${level} ${message}\n`;
  const bytes = Buffer.byteLength(line);
  try {
    if (activeBytes + bytes > MAX_LOG_BYTES) rotate();
    fs.appendFileSync(activePath, line);
    activeBytes += bytes;
  } catch {
    // A log write must never take the service down.
  }
};

export const logInfo = (message: string): void => write('INFO', message);
export const logError = (message: string): void => write('ERROR', message);
