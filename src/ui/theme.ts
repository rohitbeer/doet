import type { AgentStatus } from '../core/types.js';

/**
 * Each agent's colour now lives with the rest of that CLI's facts, in
 * `core/agents/`, so that adding one is a single file rather than a file plus
 * an entry in every record keyed by agent. Re-exported because the UI asks for
 * it constantly and has no other reason to know the registry exists.
 */
export { AGENT_COLOR } from '../core/agents/registry.js';

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
