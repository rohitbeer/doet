/** A promise you resolve from somewhere else. Used all over the adapters, where
 *  a request goes out on one code path and its answer arrives on another. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** Collapse whitespace so a multi-line command fits on one status line. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * A short human label for a tool call. Both agents name their tools differently,
 * so this handles the common ones by name and falls back to the first
 * string-ish argument, which is nearly always the interesting one.
 */
export function summarizeValue(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  };

  const direct = pick(
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'prompt',
    'description',
  );
  if (direct) return oneLine(direct);

  const firstString = Object.values(input).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return firstString ? oneLine(firstString) : toolName;
}

/** `1.2k`, `847`, `3.4M` — token counts in a status bar shouldn't wrap. */
export function compactNumber(value: number | undefined): string {
  if (value == null) return '–';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(value: number | undefined): string {
  if (value == null) return '';
  if (value === 0) return '$0.00';
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

/**
 * `4.2s`, `1m 07s`, `2h 03m` — an elapsed time that stays the same width as it
 * grows, so a running counter does not make the row it sits in reflow.
 *
 * Sub-minute keeps a decimal because the difference between a 3-second and a
 * 9-second turn is worth seeing; past a minute it stops pretending to that
 * precision.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '–';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Session history
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * An agent's own session as Markdown. This is what a `full` handoff sends into
 * a fresh session, so it has to read as a transcript rather than a dump —
 * whoever receives it has no memory of any of it.
 */
export function renderHistory(label: string, entries: HistoryEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((entry) =>
      entry.role === 'user' ? `**doet →**\n\n${entry.text}` : `**${label} →**\n\n${entry.text}`,
    )
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/**
 * Wrap one logical line into display rows of at most `width` columns.
 *
 * The panes do their own wrapping rather than leaning on Ink's `wrap="wrap"`
 * because scrollback needs to know exactly how many rows a line occupies. A
 * component that decides its own height cannot be scrolled precisely, which is
 * why the old panes clipped every line instead.
 */
export function wrapLine(text: string, width: number): string[] {
  if (width < 2) return [text];
  if (text.length === 0) return [''];

  const rows: string[] = [];
  // Preserve leading indentation on continuation rows so wrapped code and
  // bullet lists stay readable.
  const indent = /^\s*/.exec(text)?.[0] ?? '';
  const hanging = displayWidth(indent) + 2 <= width ? indent : '';

  let remaining = text;
  let prefix = '';

  while (remaining.length > 0) {
    const room = width - displayWidth(prefix);
    if (displayWidth(remaining, displayWidth(prefix)) <= room) {
      rows.push(prefix + remaining);
      break;
    }

    // Break on the last whitespace grapheme that fits; fall back to a hard cut
    // for long paths/URLs. Indexes come from Intl.Segmenter, so an emoji or a
    // combining sequence is never split between rows.
    let cut = fittingCut(remaining, room, displayWidth(prefix));
    if (cut <= 0) cut = firstGraphemeEnd(remaining);

    rows.push(prefix + remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^[ \t]+/, '');
    prefix = hanging;
  }

  return rows.length > 0 ? rows : [''];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Terminal-cell width, including wide CJK/emoji, combining marks and tabs. */
export function displayWidth(text: string, startingColumn = 0): number {
  let column = startingColumn;
  for (const part of graphemes.segment(text)) {
    column += graphemeWidth(part.segment, column);
  }
  return column - startingColumn;
}

function fittingCut(text: string, room: number, startingColumn: number): number {
  let used = 0;
  let end = 0;
  let whitespace = 0;
  for (const part of graphemes.segment(text)) {
    const width = graphemeWidth(part.segment, startingColumn + used);
    if (used + width > room) break;
    used += width;
    end = part.index + part.segment.length;
    if (/^\s$/u.test(part.segment)) whitespace = part.index;
  }
  return whitespace > 0 ? whitespace : end;
}

function firstGraphemeEnd(text: string): number {
  const first = graphemes.segment(text)[Symbol.iterator]().next().value as
    | { segment: string }
    | undefined;
  return first?.segment.length ?? 1;
}

function graphemeWidth(value: string, column: number): number {
  if (value === '\t') return 4 - (column % 4);
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(value)) return 0;
  if (/\p{Extended_Pictographic}/u.test(value)) return 2;

  const code = value.codePointAt(0) ?? 0;
  return isWide(code) ? 2 : 1;
}

/** Unicode ranges conventionally rendered as two terminal cells. */
function isWide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1ffff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
