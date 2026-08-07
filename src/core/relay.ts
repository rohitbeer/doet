import type { AgentId } from './types.js';

/**
 * doet is a passer, not an agent: it never calls a model itself. The only
 * leverage it has over the conversation is the text it wraps around each
 * hand-off. That text lives here.
 */

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

interface SessionArgs {
  self: AgentId;
  other: AgentId;
  rounds: number;
}

/**
 * Everything that is true for the whole session, sent once as the agent's own
 * system/developer instructions rather than as a user turn.
 *
 * This used to be prepended to every prompt, which meant the agent read several
 * hundred words of unchanging framing before reaching the actual question — and
 * the human's request arrived buried in the middle of doet's own voice. Here it
 * costs one setup, and a turn can be just the thing that is new.
 */
export function sessionInstructions({ self, other, rounds }: SessionArgs): string {
  return `You are ${AGENT_LABELS[self]}, working alongside ${AGENT_LABELS[other]} in a session run
by \`doet\`. doet is a relay: it passes messages between the two of you and never writes any
of the answer itself. A human is watching, and approves every tool call.

Whoever speaks first answers the human directly. That reply is handed to the other, who
checks and improves it; it comes back, and so on. The human chose ${rounds} exchange${rounds === 1 ? '' : 's'} for this
question and can stop it sooner. Being corrected here is cheap. Shipping something wrong is not.

Do the actual work — read the files, run the commands — rather than describing what you would
do. Be specific enough that ${AGENT_LABELS[other]} can check your reasoning instead of guessing
at it.

When you are handed ${AGENT_LABELS[other]}'s answer, that message is theirs, passed through
untouched; doet adds no instructions to it. Check what you can — read the files they cite, run
the commands, see whether it holds up. Then write your own best version of the answer rather
than notes on theirs. Concede plainly when you are wrong and hold your position when you are
not. Do not manufacture disagreement to look thorough, and do not restate your previous message.

Write every reply as the finished answer to the human's request. The last one said is what
they receive, so any single reply should stand on its own — no status markers, no notes to
doet, no meta-commentary about the session or about how many exchanges are left. If the
answer is done, say it is done and stop adding to it.`;
}

/**
 * The opening turn is the human's question, verbatim.
 *
 * Everything the agent needs to know about the arrangement is already in its
 * session instructions, so there is nothing to wrap around this. The first
 * agent should read what the human actually typed, not doet's paraphrase of the
 * situation with the question embedded in it.
 */
export function openingPrompt(query: string): string {
  return query;
}

interface RelayArgs {
  query: string;
  other: AgentId;
  otherText: string;
  /** True on an agent's very first sight of the conversation. */
  firstContact: boolean;
}

/**
 * A hand-off: a label saying whose words these are, and the words, unaltered.
 *
 * doet does not add a task here. What to do with another agent's answer never
 * changes from round to round, so it is in the session instructions; repeating
 * it on every relay would be doet talking over the agent it is quoting.
 *
 * The running digest is not here either. Both agents hold persistent sessions
 * and already remember everything, so notes would be doet paraphrasing them
 * back at themselves — and on the first exchange there is nothing in them but
 * "nothing yet". The digest is for the human, and for briefing a session that
 * has genuinely lost its memory (see `handoffPrompt`).
 *
 * Note the asymmetry between `firstContact` and later rounds. Each adapter
 * keeps one long-lived session, so an agent already remembers the request and
 * everything it said about it — only a newcomer needs the request restated.
 */
export function relayPrompt({ query, other, otherText, firstContact }: RelayArgs): string {
  const answer = `Answer by ${AGENT_LABELS[other]}:

<${other}>
${otherText}
</${other}>`;

  const request = firstContact
    ? `<request>
${query}
</request>

`
    : '';

  return `${request}${answer}`;
}

// ---------------------------------------------------------------------------
// The summary agent
// ---------------------------------------------------------------------------

/**
 * The summary agent's standing brief, sent once as its session instructions.
 * Same reason as the debaters': the unchanging half does not belong in a prompt
 * that is sent again after every exchange.
 */
export function summaryInstructions(targetWords: number): string {
  return `You are the note-taker for a working session between two coding agents,
${AGENT_LABELS.claude} and ${AGENT_LABELS.codex}. You are not one of them. Never answer the
human's request, never take a side, and never add work of your own.

You maintain one running digest. Each time you are given a new exchange, rewrite the digest so
it reflects everything through that exchange, and output the digest alone — no preamble, no
"here is the updated digest".

Keep it under ${targetWords} words, using these headings, dropping any with nothing under it:

**Goal** — one sentence on what the human actually wants.
**Settled** — claims both agents accept, and concrete work done: files changed, commands run,
results observed. Facts, not narration.
**Open** — where they still disagree, and what would settle it.
**Next** — what the session is about to do.

Replace superseded points rather than appending to them; a digest that only grows is just a
second transcript. Keep specifics — file paths, function names, numbers, error text — and drop
adjectives. If an agent asserted something without checking it, say so.`;
}

interface GistArgs {
  query: string;
  /** The digest so far, empty on the first call. */
  previous: string;
  /** Everything said since the last digest, in order. */
  messages: Array<{ agent: AgentId; text: string }>;
  round: number;
}

/**
 * The summary agent is the only model doet talks to on its own behalf, and it
 * is deliberately not a participant: it never answers the question, never
 * judges who is right, and never speaks to the debaters. It maintains one
 * running digest so a long session stays comprehensible — to the human reading
 * along, and to an agent handed a fresh session halfway through.
 */
export function gistPrompt({ query, previous, messages, round }: GistArgs): string {
  // The request only needs restating while there is no digest to carry it.
  const frame = previous.trim()
    ? `Your digest so far:

<digest>
${previous.trim()}
</digest>
`
    : `The human asked:

<request>
${query}
</request>
`;

  // Both agents' messages arrive together, so the digest is written from a
  // complete exchange rather than from half of one.
  const exchange = messages
    .map((m) => `<${m.agent}>\n${m.text}\n</${m.agent}>`)
    .join('\n\n');

  return `${frame}
Exchange ${round}:

${exchange}`;
}

interface HandoffArgs {
  query: string;
  agent: AgentId;
  gist: string;
}

/**
 * Prepended to the first prompt of a rotated session. The replacement has none
 * of its predecessor's memory, so this has to stand alone.
 */
export function handoffPrompt({ query, agent, gist }: HandoffArgs): string {
  return `You are ${AGENT_LABELS[agent]}, picking up a working session already in progress.
This is a fresh session: you have no memory of the earlier exchanges, and the notes below are
all you carry forward. Your counterpart is ${AGENT_LABELS[otherLabel(agent)]}, whose own session
is still running and who does remember.

The human's original request:

<request>
${query}
</request>

Where the session stands:

<handoff>
${gist.trim()}
</handoff>

Treat this as a briefing, not as ground truth you wrote. Where it matters, re-check the files
and commands it mentions rather than trusting the summary of them. If it contradicts what you
find, believe what you find and say so.`;
}

function otherLabel(id: AgentId): AgentId {
  return id === 'claude' ? 'codex' : 'claude';
}

interface SynthesisArgs {
  other: AgentId;
  reason: 'converged' | 'exhausted' | 'stopped';
  rounds: number;
}

/**
 * Kept only for sessions that explicitly turn synthesis back on. doet does not
 * ask for a closing deliverable by default: every reply is already written as
 * the finished answer, so the last one is the answer. Asking again spent a turn
 * to restate what had just been said, and put a block of doet's instructions in
 * front of the agent to do it.
 */

/**
 * The debate produced the thinking; this asks for the artifact. Without it the
 * session ends on a critique of a critique, which is not what the user asked for.
 */
export function synthesisPrompt({ other, reason, rounds }: SynthesisArgs): string {
  const why = {
    converged: `You and ${AGENT_LABELS[other]} have converged.`,
    exhausted: `That is ${rounds} exchanges without full agreement.`,
    stopped: 'The human stopped the session here.',
  }[reason];

  const caveat =
    reason === 'converged'
      ? ''
      : ` End with a short "Unresolved" section naming what you two still
disagree on and what would settle it — do not paper over it.`;

  return `${why} Write the final answer now — this is what the human receives.

Write it for them, not for ${AGENT_LABELS[other]}: no meta-commentary about the session, no
"as we discussed", no summary of who said what. Just the finished answer to what they
originally asked, incorporating everything you two worked out.${caveat}

No verdict marker on this one.`;
}

/**
 * Injected when the user types while a debate is running. Kept visually distinct
 * so the model does not mistake it for its counterpart's turn.
 */
export function interjectionPrompt(text: string): string {
  return `The human broke in to tell you this directly. It takes priority — apply it, and
carry it forward.

<human>
${text}
</human>`;
}

/**
 * Injected when the user adds a message to an exchange the agent is already
 * working on.
 *
 * The last line is the whole point. Without it an agent that has been running
 * for two minutes reads a new user message as a new request and starts over,
 * throwing away the work the message was meant to redirect.
 */
export function addedMessagePrompt(text: string): string {
  return `The human added this to the request you are working on right now. It takes
priority over anything it contradicts. Fold it into the work in progress and
carry on with the same task — do not start over, and do not treat it as a new
request.

<human>
${text}
</human>`;
}
