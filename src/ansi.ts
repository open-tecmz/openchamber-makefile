/**
 * ANSI colour for the run log.
 *
 * Build tools colour their output with ANSI SGR sequences (`ESC [ 32 m`) and
 * redraw a progress line by returning the carriage; dropped into a `<pre>` as
 * plain text that reads as `[32m` noise. This module walks the raw text once
 * and turns it into what a terminal would show: coloured spans, the characters
 * that fit on screen, and one clean copy of every progress line.
 *
 * `ansiToHtml` builds the markup the log element shows; `stripAnsi` is the
 * same scan without the markup, for Copy, so the clipboard gets plain text.
 * Both read the whole text on every sync, so an escape sequence split across
 * two output chunks is only ever seen once it is complete.
 *
 * The scanner is pure — no DOM, no host APIs — so it is easy to test.
 */

type Style = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  reverse: boolean;
  /** A CSS colour, or null for the terminal default. */
  fg: string | null;
  bg: string | null;
};

/** The 16 base colours, tuned for the log's own dark background. */
const ANSI_16 = [
  '#3b4048', // 0 black
  '#e06c75', // 1 red
  '#98c379', // 2 green
  '#e5c07b', // 3 yellow
  '#61afef', // 4 blue
  '#c678dd', // 5 magenta
  '#56b6c2', // 6 cyan
  '#dcdfe4', // 7 white
  '#67707e', // 8 bright black
  '#ff7b86', // 9 bright red
  '#b0e88a', // 10 bright green
  '#ffd68a', // 11 bright yellow
  '#8bc8ff', // 12 bright blue
  '#e29bf5', // 13 bright magenta
  '#7fd6e0', // 14 bright cyan
  '#ffffff', // 15 bright white
];

/** Terminal defaults; `reverse` swaps between them and any colours that are set. */
const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#0b0e14';

const freshStyle = (): Style => ({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  reverse: false,
  fg: null,
  bg: null,
});

/** xterm's 256-colour palette: 16 named, a 6×6×6 cube, then a 24-step grey ramp. */
const color256 = (index: number): string => {
  if (index < 16) return ANSI_16[Math.max(0, index)];
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    return `rgb(${level(Math.floor(cube / 36) % 6)},${level(Math.floor(cube / 6) % 6)},${level(cube % 6)})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
};

/** Apply one SGR parameter list (the text between `ESC [` and `m`) to a style. */
const applySgr = (style: Style, body: string): void => {
  const parts = body.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      Object.assign(style, freshStyle());
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.reverse = true;
    } else if (code === 9) {
      style.strike = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code === 27) {
      style.reverse = false;
    } else if (code === 29) {
      style.strike = false;
    } else if (code >= 30 && code <= 37) {
      style.fg = ANSI_16[code - 30];
    } else if (code === 39) {
      style.fg = null;
    } else if (code >= 40 && code <= 47) {
      style.bg = ANSI_16[code - 40];
    } else if (code === 49) {
      style.bg = null;
    } else if (code >= 90 && code <= 97) {
      style.fg = ANSI_16[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      style.bg = ANSI_16[code - 100 + 8];
    } else if (code === 38 || code === 48) {
      // Extended colour: `5;n` picks from the 256-palette, `2;r;g;b` is truecolour.
      const target: 'fg' | 'bg' = code === 38 ? 'fg' : 'bg';
      const mode = Number(parts[i + 1]);
      if (mode === 5) {
        const index = Number(parts[i + 2]);
        if (Number.isFinite(index)) style[target] = color256(index);
        i += 2;
      } else if (mode === 2) {
        const r = Number(parts[i + 2]);
        const g = Number(parts[i + 3]);
        const b = Number(parts[i + 4]);
        if ([r, g, b].every(Number.isFinite)) style[target] = `rgb(${r},${g},${b})`;
        i += 4;
      }
    }
  }
};

/**
 * Consume one escape sequence at `index`, applying any SGR it carries. Returns
 * the index just past it, or -1 when the text ends mid-sequence — the caller
 * stops, and the sequence shows up whole on the next render.
 */
const consumeEscape = (text: string, index: number, style: Style): number => {
  const next = text[index + 1];
  if (next === '[') {
    // CSI: parameter/intermediate bytes (0x20–0x3f) then a final byte (0x40–0x7e).
    let i = index + 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 0x20 && code <= 0x3f) i += 1;
      else break;
    }
    if (i >= text.length) return -1;
    const final = text.charCodeAt(i);
    if (final >= 0x40 && final <= 0x7e) {
      if (text[i] === 'm') applySgr(style, text.slice(index + 2, i));
      return i + 1;
    }
    // Malformed: drop the `ESC [` and let the caller read the rest as text.
    return index + 2;
  }
  if (next === ']') {
    // OSC (a window title, a hyperlink): ends at BEL or the ST terminator.
    let i = index + 2;
    while (i < text.length && text[i] !== '\x07' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1;
    if (i >= text.length) return -1;
    return text[i] === '\x07' ? i + 1 : i + 2;
  }
  if (next === undefined) return -1;
  return index + 2; // a two-byte escape (charset, keypad mode, …): drop it
};

type Segment = { text: string; style: Style };

/**
 * Walk the raw output into lines of styled segments, the way a terminal would
 * lay it out: a newline opens a line, a carriage return clears the current one
 * (progress bars redraw in place), a backspace erases one character, and other
 * control bytes are dropped.
 */
const scan = (text: string): Segment[][] => {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let current: Segment | null = null;
  const style = freshStyle();

  const pushText = (chunk: string): void => {
    if (!chunk) return;
    if (current) {
      current.text += chunk;
    } else {
      current = { text: chunk, style: { ...style } };
      line.push(current);
    }
  };

  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const end = consumeEscape(text, i, style);
      if (end < 0) break; // incomplete at the end; it will render whole later
      current = null; // the style may have changed: the next text opens a segment
      i = end;
      continue;
    }
    if (code === 0x0a) {
      lines.push(line);
      line = [];
      current = null;
      i += 1;
      continue;
    }
    if (code === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        i += 1; // CRLF: let the LF on the next turn open the line
        continue;
      }
      line = []; // a lone CR redraws the line in place
      current = null;
      i += 1;
      continue;
    }
    if (code === 0x08) {
      const last = line[line.length - 1];
      if (last) {
        last.text = last.text.slice(0, -1);
        if (!last.text) line.pop();
      }
      current = line[line.length - 1] ?? null;
      i += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i += 1; // BEL and the remaining controls have no rendering: drop them
      continue;
    }
    let end = i + 1;
    while (end < text.length) {
      const nextCode = text.charCodeAt(end);
      if (nextCode < 0x20 || nextCode === 0x7f) break;
      end += 1;
    }
    pushText(text.slice(i, end));
    i = end;
  }

  lines.push(line);
  return lines;
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));

/** The inline CSS for one segment; empty when the segment is unstyled. */
const cssForStyle = (style: Style): string => {
  const parts: string[] = [];
  if (style.bold) parts.push('font-weight:600');
  if (style.dim) parts.push('opacity:.65');
  if (style.italic) parts.push('font-style:italic');
  const decoration: string[] = [];
  if (style.underline) decoration.push('underline');
  if (style.strike) decoration.push('line-through');
  if (decoration.length > 0) parts.push(`text-decoration:${decoration.join(' ')}`);

  let fg = style.fg;
  let bg = style.bg;
  if (style.reverse) {
    fg = style.bg ?? DEFAULT_BG;
    bg = style.fg ?? DEFAULT_FG;
  }
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  return parts.join(';');
};

/** Render ANSI output to the HTML the log element shows. */
export const ansiToHtml = (text: string): string => {
  const lines = scan(text);
  let html = '';
  for (let l = 0; l < lines.length; l += 1) {
    if (l > 0) html += '\n';
    for (const segment of lines[l]) {
      const css = cssForStyle(segment.style);
      html += css ? `<span style="${css}">${escapeHtml(segment.text)}</span>` : escapeHtml(segment.text);
    }
  }
  return html;
};

/** The same scan without markup: the text to put on the clipboard. */
export const stripAnsi = (text: string): string => {
  const lines = scan(text);
  let plain = '';
  for (let l = 0; l < lines.length; l += 1) {
    if (l > 0) plain += '\n';
    for (const segment of lines[l]) plain += segment.text;
  }
  return plain;
};
