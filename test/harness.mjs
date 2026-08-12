import { execFileSync } from 'node:child_process';

/**
 * The smallest thing that will hold a test.
 *
 * No framework, and that is a decision rather than an omission. doet has four
 * runtime dependencies and a build that is one `tsc`; adding a test runner and
 * its tree to check a dozen invariants would be the largest dependency in the
 * project by some margin. These files run under plain `node`, against `dist`,
 * which is also the thing users actually run.
 */

let failures = 0;
let checks = 0;

export function check(name, ok, got) {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
    return true;
  }
  failures += 1;
  console.log(` FAIL   ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
  return false;
}

export function section(title) {
  console.log(`\n${title}`);
}

export function report(title) {
  if (failures === 0) {
    console.log(`\n${title}: ${checks} checks passed\n`);
    process.exit(0);
  }
  console.log(`\n${title}: ${failures} of ${checks} FAILED\n`);
  process.exit(1);
}

/** Imports from the built output, which is what a user runs. */
export function dist(path) {
  return new URL(`../dist/${path}`, import.meta.url).href;
}

/**
 * Bows out of a suite that cannot run here.
 *
 * Exit 2 rather than 0 or 1, so the runner can tell "nothing to check on this
 * machine" from both "checked and fine" and "checked and broken". Three of
 * these suites need a real CLI or a real tmux installed; a red suite because
 * kilo is not on this laptop would teach everyone to ignore the colour.
 */
export function skip(reason) {
  console.log(`  skipped — ${reason}`);
  process.exit(2);
}

/** Whether a command exists and answers, for deciding whether to `skip`. */
export function has(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
