/**
 * Checks the inline markdown parser against what the agents actually write.
 *
 * The thing that matters is the second column: styling is applied by dropping
 * the markers, so the visible width shrinks — and wrapping has to be measured
 * on that, not on the source.
 *
 *   npx tsx scripts/probe-markdown.ts
 */
import { parseInline, wrapSpans } from '../src/ui/markdown.js';

const CASES = [
  '**Goal** — Human opened the session with a casual greeting.',
  'Working directory `/Users/me/proj`, not a git repo.',
  '## Short version',
  '- `compactNumber(1500)` returns `"1.5k"` — the **k** branch.',
  'Mixed *italic* and **bold** and `code` together.',
  'An unclosed **marker should stay literal',
  'A bare * asterisk and a lone ` backtick.',
  '**`setModel`** — bold code, nested.',
  'plain text with no markup at all',
];

const show = (spans: ReturnType<typeof parseInline>) =>
  spans
    .map((s) => {
      const tag = [s.bold && 'b', s.italic && 'i', s.code && 'c'].filter(Boolean).join('');
      return tag ? `[${tag}:${s.text}]` : s.text;
    })
    .join('');

console.log('source → parsed (b=bold i=italic c=code)\n');
for (const line of CASES) {
  const spans = parseInline(line);
  const visible = spans.map((s) => s.text).join('');
  console.log(`  ${JSON.stringify(line)}`);
  console.log(`    ${show(spans)}`);
  console.log(`    source ${line.length} cols → visible ${visible.length} cols\n`);
}

console.log('\nwrapping at 40 columns, measured on visible text:\n');
const long =
  '**Settled** — Working directory `/Users/rohitbeer/Desktop/untitled folder 4/Harness`, not a git repo. Both agents replied with a plain greeting.';
for (const row of wrapSpans(parseInline(long), 40)) {
  const text = row.map((s) => s.text).join('');
  console.log(`  |${text.padEnd(40)}| ${text.length}`);
}

const over = wrapSpans(parseInline(long), 40).some(
  (row) => row.map((s) => s.text).join('').length > 40,
);
console.log(`\n  any row over 40 columns: ${over ? 'FAIL' : 'no — PASS'}`);
