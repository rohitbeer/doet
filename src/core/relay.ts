import type { AgentId } from './types.js';

/**
 * The text doet writes.
 *
 * There used to be a good deal more here — an opening framing, a hand-off
 * wrapper, a synthesis request, an interjection format — all of it in service
 * of relaying one agent's answer into the other's prompt. That model is gone:
 * agents no longer read each other through doet's paraphrase, so the prompts
 * that carried it went with it.
 *
 * What remains is what doet still says in its own voice, which is now only the
 * labels — even the note-taker's brief has gone, since the summary is written
 * by the agent that did the work, in a fork of its own session, and an agent
 * recapping itself needs no briefing.
 */

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};
