/**
 * The text doet writes.
 *
 * There used to be a good deal more here — an opening framing, a hand-off
 * wrapper, a synthesis request, an interjection format — all of it in service
 * of relaying one agent's answer into the other's prompt. That model is gone:
 * agents no longer read each other through doet's paraphrase, so the prompts
 * that carried it went with it.
 *
 * What remained after that was the labels, and now even those have moved: a
 * label is a fact about a CLI, so it lives with the rest of that CLI's facts in
 * `core/agents/`. This re-export is kept because "what is this agent called"
 * is asked from a dozen places that have no other reason to know the registry
 * exists.
 */

export { AGENT_LABELS } from './agents/registry.js';

/**
 * doet's standing brief, for a CLI with no way to append to its system prompt.
 *
 * Two of the four cannot take `instructions` as a launch flag — cline's `-s`
 * replaces its prompt rather than adding to it, and kilo has no such flag at
 * all — so for those the brief has to ride in front of the first request
 * instead. Marked up rather than merely concatenated, so the agent can tell
 * doet's framing from the human's question, and stated as standing context so
 * it is not read as the thing being asked for.
 */
export function framedPrompt(instructions: string, prompt: string): string {
  const brief = instructions.trim();
  if (!brief) return prompt;
  return `<session-brief>\n${brief}\n</session-brief>\n\nThis brief describes the session you are in and stands for every turn, not just this one. What follows is the actual request.\n\n${prompt}`;
}
