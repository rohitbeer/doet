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
  'awaiting-permission': 'needs you',
  error: 'error',
};

export const STATUS_COLOR: Record<AgentStatus, string> = {
  stopped: 'gray',
  starting: 'yellow',
  ready: 'green',
  thinking: 'yellow',
  working: 'blue',
  'awaiting-permission': 'red',
  error: 'red',
};

/** Braille spinner — one cell wide in every terminal font. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
