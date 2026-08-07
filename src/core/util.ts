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
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
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
  const hanging = indent.length + 2 <= width ? indent : '';

  let remaining = text;
  let prefix = '';

  while (remaining.length > 0) {
    const room = width - prefix.length;
    if (remaining.length <= room) {
      rows.push(prefix + remaining);
      break;
    }

    // Break on the last space that fits; fall back to a hard cut for words
    // longer than the pane (paths, URLs, base64).
    let cut = remaining.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;

    rows.push(prefix + remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^ +/, '');
    prefix = hanging;
  }

  return rows.length > 0 ? rows : [''];
}
