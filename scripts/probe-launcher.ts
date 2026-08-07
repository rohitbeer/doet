/**
 * Shows where a branch would open, for each environment doet might be run in.
 *
 * The order is the whole point: doet should stay where you already are. tmux
 * first because it works inside an editor's integrated terminal; a GUI window
 * last, and labelled so you know it will take you out of your editor.
 *
 *   npx tsx scripts/probe-launcher.ts
 */
import { detectLauncher } from '../src/core/terminal.js';

const CASES: Array<[string, Record<string, string>]> = [
  ['VS Code + tmux', { TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'vscode' }],
  ['VS Code, no tmux', { TERM_PROGRAM: 'vscode' }],
  ['Cursor, no tmux', { TERM_PROGRAM: 'Cursor' }],
  ['plain tmux', { TMUX: '/tmp/tmux-501/default,1,0' }],
  ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }],
  ['iTerm', { TERM_PROGRAM: 'iTerm.app' }],
  ['DOET_TERMINAL override', { DOET_TERMINAL: 'my-term -e {cmd}' }],
];

const KEYS = ['TMUX', 'TERM_PROGRAM', 'DOET_TERMINAL', 'KITTY_LISTEN_ON'];

for (const [label, env] of CASES) {
  const saved: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const launcher = detectLauncher();
  console.log(`${label.padEnd(24)} → ${launcher ? launcher.label : '(none — takeover only)'}`);

  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

console.log(`\nthis shell             → ${detectLauncher()?.label ?? '(none — takeover only)'}`);
