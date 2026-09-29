/**
 * Makefile target parsing and the run model shared by the rail panel and the
 * local service.
 *
 * The parser is pure and unit-testable; the run types describe the JSON the
 * panel polls from the service. The service spawns the real `make` process,
 * the panel never does: an iframe cannot start a process.
 */

export type MakeTarget = {
  name: string;
  /** Inline `##` doc or the `##` block written above the target. */
  description: string;
  /** Declared in `.PHONY`, so there is no file of that name. */
  phony: boolean;
  /** Make's default goal (the first ordinary target in the file). */
  default: boolean;
};

/** Lookup order GNU make itself uses. */
export const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'] as const;

export type RunStatus = 'running' | 'success' | 'failed' | 'stopped' | 'unknown';

/** One run as listed by `GET /targets` (no output body). */
export type RunSnapshot = {
  runId: string;
  directory: string;
  target: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** Total characters produced so far (including dropped output). */
  length: number;
};

/** One poll answer from `GET /run`. */
export type RunOutput = {
  ok: true;
  runId: string;
  target: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** New output from the requested offset. */
  output: string;
  /** Offset to pass on the next poll. */
  offset: number;
  /** The poll hit the per-answer cap; poll again right away. */
  more: boolean;
  /** Output before `offset` was dropped by the service. */
  truncated: boolean;
};

export type TargetsAnswer = {
  ok: boolean;
  directory: string;
  /** File name of the makefile that was found, or null. */
  makefile: string | null;
  targets: MakeTarget[];
  /** Latest run per target, so a reopened panel restores status. */
  runs: Record<string, RunSnapshot>;
  /** Newest event sequence at the moment of the answer; the client streams on from here. */
  seq: number;
  error?: string;
};

/**
 * One entry in the service's event log. The panel drains these through
 * `GET /events` (SSE frames) and never polls per-run output.
 */
export type StreamEvent =
  | { seq: number; type: 'run'; directory: string; run: RunSnapshot }
  | { seq: number; type: 'output'; directory: string; runId: string; target: string; chunk: string }
  | { seq: number; type: 'targets'; directory: string; makefile: string | null; targets: MakeTarget[] };

/** What `/events` may emit: an event, or a reset when the client fell behind. */
export type StreamFrame = StreamEvent | { seq: number; type: 'reset' };

const isSpecial = (name: string): boolean =>
  name.length === 0
  || name.startsWith('.')
  || name.includes('%')
  || name.includes('$')
  || name.includes('=');

const extractNames = (head: string): string[] => {
  const names: string[] = [];
  for (const token of head.split(/\s+/)) {
    const name = token.replace(/&$/, '');
    if (!isSpecial(name)) names.push(name);
  }
  return names;
};

const readPhonyTargets = (lines: string[]): Set<string> => {
  const phony = new Set<string>();
  for (const line of lines) {
    const match = /^\s*\.PHONY\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    for (const name of match[1].trim().split(/\s+/)) {
      if (name) phony.add(name);
    }
  }
  return phony;
};

/**
 * Extract the runnable targets from a makefile.
 *
 * Two passes: `.PHONY` may be declared after the targets it names. Only
 * ordinary rule lines are read — recipes (tab-indented), variable
 * assignments, directives, pattern/`$`-built names and dot-targets are not
 * things a user runs by hand.
 */
export const parseMakeTargets = (text: string): MakeTarget[] => {
  const lines = text.split(/\r?\n/);
  const phony = readPhonyTargets(lines);
  const found = new Map<string, MakeTarget>();
  let doc: string | null = null;
  let isFirst = true;

  for (const raw of lines) {
    if (raw.startsWith('\t')) continue;
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trimStart();

    if (!trimmed) {
      doc = null;
      continue;
    }
    if (trimmed.startsWith('#')) {
      const comment = /^#+\s?(.*)$/.exec(trimmed);
      if (trimmed.startsWith('##') && comment) doc = comment[1].trim();
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 0) {
      doc = null;
      continue;
    }
    const after = line.slice(colon);
    const head = line.slice(0, colon).trim();
    if (after.startsWith('::=') || after.startsWith(':=') || head.includes('$')) {
      doc = null;
      continue;
    }

    const inline = /##\s*(.+)$/.exec(line);
    for (const name of extractNames(head)) {
      const description = (inline?.[1]?.trim() ?? '') || doc || '';
      const existing = found.get(name);
      if (existing) {
        if (!existing.description && description) existing.description = description;
      } else {
        found.set(name, { name, description, phony: phony.has(name), default: isFirst });
        isFirst = false;
      }
    }
    doc = null;
  }

  return [...found.values()];
};
