import React from 'react';
import { Text } from 'ink';

/** A run of characters sharing one style. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code — rendered in a colour rather than with backticks. */
  code?: boolean;
}

interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * `**bold**`, `` `code` ``, `*italic*`, `_italic_`, and `#` headings.
 *
 * Deliberately small: both agents write terminal markdown and both CLIs render
 * it, so seeing the raw asterisks in doet is a step backwards from either one.
 * Anything block-level — tables, fenced code — is left exactly as written,
 * because guessing at it badly is worse than showing it plainly.
 */
export function parseInline(line: string): Span[] {
  // A heading is bold for its whole length, with the hashes dropped.
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return mergeSpans(parseInline(heading[2]!).map((s) => ({ ...s, bold: true })));
  }

  const spans: Span[] = [];
  let plain = '';

  const flush = () => {
    if (plain) spans.push({ text: plain });
    plain = '';
  };

  for (let i = 0; i < line.length; ) {
    const rest = line.slice(i);

    // Order matters: `**` must be tried before `*`.
    const match =
      take(rest, '**', { bold: true }) ??
      take(rest, '__', { bold: true }) ??
      take(rest, '`', { code: true }) ??
      take(rest, '*', { italic: true }) ??
      take(rest, '_', { italic: true });

    if (match) {
      flush();
      // Nested styles inside `**…**`, but not inside code, where the point is
      // that the characters are literal.
      if (match.style.code) {
        spans.push({ text: match.inner, code: true });
      } else {
        for (const span of parseInline(match.inner)) {
          spans.push({ ...match.style, ...span, bold: span.bold || match.style.bold, italic: span.italic || match.style.italic });
        }
      }
      i += match.length;
      continue;
    }

    plain += line[i];
    i += 1;
  }

  flush();
  return mergeSpans(spans);
}

/** A delimited run starting at position 0, or null. */
function take(
  rest: string,
  delim: string,
  style: Style,
): { inner: string; length: number; style: Style } | null {
  if (!rest.startsWith(delim)) return null;
  const end = rest.indexOf(delim, delim.length);
  // An unclosed delimiter is just a character someone typed.
  if (end < 0) return null;
  const inner = rest.slice(delim.length, end);
  if (inner.length === 0) return null;
  return { inner, length: end + delim.length, style };
}

function sameStyle(a: Span, b: Span): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code;
}

function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, span)) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/**
 * Wrap styled text to `width` visible columns.
 *
 * Wrapping has to happen *after* the markers are parsed away, or every line
 * that contains any would break early — `**Goal**` occupies eight columns in
 * the source and four on screen.
 */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  if (width < 2) return [spans];

  // Character-level is the simple way to keep styles attached across a break.
  // Lines here are one pane wide, so the cost is irrelevant.
  const chars: Array<{ c: string; s: Style }> = [];
  for (const span of spans) {
    for (const c of span.text) {
      chars.push({ c, s: { bold: span.bold, italic: span.italic, code: span.code } });
    }
  }
  if (chars.length === 0) return [[]];

  const rows: Span[][] = [];
  let start = 0;

  while (start < chars.length) {
    if (chars.length - start <= width) {
      rows.push(toSpans(chars.slice(start)));
      break;
    }

    // Break on the last space that fits; hard-cut a word longer than the pane.
    let cut = -1;
    for (let i = start + width; i > start; i--) {
      if (chars[i]?.c === ' ') {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = start + width;

    rows.push(toSpans(chars.slice(start, cut)));
    start = cut;
    while (chars[start]?.c === ' ') start += 1;
  }

  return rows.length > 0 ? rows : [[]];
}

function toSpans(chars: Array<{ c: string; s: Style }>): Span[] {
  return mergeSpans(chars.map(({ c, s }) => ({ text: c, ...s })));
}

/** Renders one wrapped row. */
export function Markdown({ spans, dim, color }: { spans: Span[]; dim?: boolean; color?: string }) {
  if (spans.length === 0) return <Text> </Text>;
  return (
    <Text>
      {spans.map((span, i) => (
        <Text
          key={i}
          bold={span.bold}
          italic={span.italic}
          // Inline code gets a colour instead of backticks, which is what both
          // agents' own CLIs do with it.
          color={span.code ? 'cyan' : color}
          dimColor={dim && !span.code && !span.bold}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}
