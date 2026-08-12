import type { AgentId, AgentStatus } from '../core/types.js';

/**
 * Each agent gets one colour and keeps it everywhere — pane border, relay
 * arrows, permission prompt, status bar. In a split view where both sides
 * stream at once, colour is the fastest way to tell who is talking.
 */
export const AGENT_COLOR: Record<AgentId, string> = {
  claude: 'magenta',
  codex: 'cyan',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  stopped: 'stopped',
  starting: 'starting',
  ready: 'ready',
  thinking: 'thinking',
  working: 'working',

  error: 'error',
};

export const STATUS_COLOR: Record<AgentStatus, string> = {
  stopped: 'gray',
  starting: 'yellow',
  ready: 'green',
  thinking: 'yellow',
  working: 'blue',

  error: 'red',
};

/** Braille spinner — one cell wide in every terminal font. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Words to cycle through while an agent is mid-turn.
 *
 * Decorative, and worth being honest about why. doet learns what an agent did
 * by reading the transcript the CLI writes when the turn *ends* — it never
 * scrapes the pane to infer what is happening inside one. So this cannot
 * describe the work, and does not try to: it is the same fixed list every time,
 * and its only job is to make a waiting screen feel alive rather than frozen.
 * The line that actually says something is the recap, and it arrives when the
 * turn does.
 */
export const THINKING_WORDS = [
  'deliberating',
  'ruminating',
  'considering',
  'untangling',
  'poking about',
  'thinking it over',
  'reading around',
  'weighing it up',
  'chasing a thread',
  'sizing it up',
];
