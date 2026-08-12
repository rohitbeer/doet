/**
 * Runs every `*.test.mjs` beside this file, each in its own process.
 *
 * Separate processes because two of these set environment variables that
 * redirect a CLI's data directory (`KILO_DB`, `CLINE_DATA_DIR`) before
 * importing the module that reads them — which only works if nothing has
 * imported it already.
 *
 * A test that cannot run says so and does not fail the suite. Three of the four
 * need a real CLI or a real tmux on the machine, and a suite that goes red
 * because you have not installed kilo is a suite people stop running.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort();

let failed = 0;
let skipped = 0;

for (const file of files) {
  console.log(`\n${'─'.repeat(60)}\n${file}\n${'─'.repeat(60)}`);
  try {
    execFileSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  } catch (error) {
    // 2 is the suite's own "nothing to run here" status; see `skip`.
    if (error.status === 2) skipped += 1;
    else failed += 1;
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(
  failed === 0
    ? `all suites passed${skipped ? ` (${skipped} skipped)` : ''}`
    : `${failed} suite${failed === 1 ? '' : 's'} FAILED${skipped ? `, ${skipped} skipped` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
