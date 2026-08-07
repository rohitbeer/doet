/**
 * Prints the exact text each agent receives, with no models involved.
 *
 * The point of separating session instructions from turns is that a turn should
 * be the thing that is new — the human's question, or what the other agent just
 * said. This makes that visible instead of a claim.
 *
 *   npx tsx scripts/probe-prompts.ts ["your question"]
 */
import {
  openingPrompt,
  relayPrompt,
  sessionInstructions,
  summaryInstructions,
  gistPrompt,
} from '../src/core/relay.js';

const query = process.argv[2] ?? 'what is this repo about';

const rule = (label: string) => {
  const line = '━'.repeat(78);
  console.log(`\n${line}\n${label}\n${line}`);
};

const words = (text: string) => text.trim().split(/\s+/).length;

rule('SESSION INSTRUCTIONS → claude   (sent once, at session start)');
const instructions = sessionInstructions({ self: 'claude', other: 'codex', rounds: 6 });
console.log(instructions);

rule('TURN 1 → claude   (what the first agent actually reads)');
const opening = openingPrompt(query);
console.log(JSON.stringify(opening));

rule('TURN 2 → codex   (joining: the request, then the other answer, verbatim)');
const relayFirst = relayPrompt({
  query,
  other: 'claude',
  otherText: "It's `doet` — a relay that passes one question between Claude Code and Codex.\nsrc/core/conductor.ts owns turn-taking; the adapters speak each CLI's protocol.",
  firstContact: true,
});
console.log(relayFirst);

rule('TURN 3 → claude   (already in it: the other answer, and nothing else)');
const relayLater = relayPrompt({
  query,
  other: "codex",
  otherText: "Checked src/core/conductor.ts — accurate, but it also owns session rotation.",
  firstContact: false,
});
console.log(relayLater);



rule('FINAL TURN — there is none. The last reply is the answer.');
console.log('doet sends nothing. Both agents simply stop.');

rule('SUMMARY AGENT — instructions once, then each exchange');
console.log(summaryInstructions(220));
console.log('\n--- and per exchange: ---\n');
console.log(
  gistPrompt({
    query,
    previous: "**Goal** — Explain what the repo is.",
    messages: [
      { agent: "claude", text: "It is \`doet\` — a relay between two agent CLIs." },
      { agent: "codex", text: "Confirmed against src/core/conductor.ts. Also owns session rotation." },
    ],
    round: 2,
  }),
);

rule('SIZE');
console.log(`session instructions (once): ${words(instructions)} words`);
console.log(`opening turn:                ${words(opening)} words  ← the question, verbatim`);
console.log(`relay, first contact:        ${words(relayFirst)} words`);
console.log(`relay, later rounds:         ${words(relayLater)} words`);
