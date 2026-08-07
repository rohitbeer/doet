/**
 * Checks that a message added to a running exchange actually reaches the agent,
 * against the real CLIs rather than a stub.
 *
 * Three things have to hold, and only a live run can show any of them:
 *
 *   1. `addMessage` reports honestly which of `live` / `queued` it managed.
 *   2. The exchange stays open — `send` does not settle until the agent has
 *      answered the added message too, so the caller gets one result.
 *   3. The agent obeyed it. The prompt asks for a word it would never volunteer,
 *      so the reply either contains it or the message did not land.
 *
 *   npx tsx scripts/probe-message.ts [claude|codex|both]
 */
import { Bus } from '../src/core/bus.js';
import { ADD_ON_QUIET_MS, ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import type { AgentAdapter, AgentId, MessageDelivery } from '../src/core/types.js';

const which = (process.argv[2] ?? 'both').toLowerCase();
const targets: AgentId[] = which === 'both' ? ['claude', 'codex'] : [which as AgentId];

/**
 * Long enough to still be running when the message is added — the counting is
 * throwaway; the output tokens are the point. Break in early: an exchange that
 * has already finished tests the `pending` path instead, which is not the one
 * at risk here.
 */
const TASK = 'Count from 1 to 600, one number per line, with no other text at all.';
const ADD_ON =
  'Change of plan: stop counting. Reply with exactly the single word PINEAPPLE and nothing else.';
const BREAK_IN_MS = 3_000;

function build(id: AgentId, bus: Bus): AgentAdapter {
  const cwd = process.cwd();
  return id === 'claude'
    ? new ClaudeAdapter({ bus, cwd, model: 'sonnet', permissionMode: 'default' })
    : new CodexAdapter({ bus, cwd, model: '', sandbox: 'read-only', approvalPolicy: 'never' });
}

for (const id of targets) {
  const bus = new Bus();
  const prompts: string[] = [];
  /*
   * The gap between one leg's reply and the first sign of the next.
   *
   * This is what the adapter's quiet deadline has to clear: a message the CLI
   * runs as a turn of its own shows life again within this long, and anything
   * quieter means it folded the message into the turn it had. The number is
   * measured rather than assumed, because setting that deadline too short
   * would end an exchange while the agent was still writing files.
   */
  let lastReplyAt = 0;
  let restartGapMs = -1;
  bus.on((event) => {
    if (event.kind === 'prompt') prompts.push(event.label);
    if (event.kind === 'error') console.error(`  ! ${event.message}`);
    // Only events the CLI itself produced. doet emits `usage`, `status` and
    // `prompt` around a leg boundary of its own accord, and counting those
    // would measure doet's bookkeeping rather than the CLI restarting.
    const fromCli = ['text', 'thinking', 'tool', 'output'].includes(event.kind);
    if (event.kind === 'message') lastReplyAt = Date.now();
    else if (lastReplyAt > 0 && restartGapMs < 0 && fromCli) {
      restartGapMs = Date.now() - lastReplyAt;
    }
  });

  const agent = build(id, bus);
  console.log(`\n=== ${agent.label} ===`);
  await agent.start();

  let delivery: MessageDelivery | 'not-attempted' = 'not-attempted';
  const started = Date.now();
  const turn = agent.send(TASK, 'probe');

  const nudge = new Promise<void>((resolve) => {
    setTimeout(() => {
      agent
        .addMessage(ADD_ON)
        .then((result) => {
          delivery = result;
          console.log(`  added after ${Date.now() - started}ms → ${result}`);
        })
        .catch((error: unknown) => console.error(`  ! addMessage: ${String(error)}`))
        .finally(resolve);
    }, BREAK_IN_MS);
  });

  const result = await turn;
  await nudge;
  const elapsed = Date.now() - started;

  const obeyed = /PINEAPPLE/i.test(result.text);
  const settledAfterAddOn = delivery !== 'not-attempted';

  console.log(`  delivery      ${delivery}`);
  console.log(`  exchange      ${elapsed}ms, ${prompts.length} prompt event(s): ${prompts.join(', ')}`);
  console.log(`  tokens        in ${result.usage.inputTokens} / out ${result.usage.outputTokens}`);
  console.log(`  cost          ${result.usage.costUsd ?? 'not reported'}`);
  console.log(
    `  restart gap   ${restartGapMs < 0 ? 'none — the reply was folded into the running turn' : `${restartGapMs}ms`}`,
  );
  console.log(`  obeyed        ${obeyed ? 'yes' : 'NO'}`);
  if (result.error) console.log(`  error         ${result.error}`);
  console.log(`  tail          ${JSON.stringify(result.text.slice(-160))}`);

  await agent.dispose();

  if (!settledAfterAddOn) throw new Error(`${id}: addMessage never resolved`);
  if (prompts.length !== 2) {
    throw new Error(`${id}: expected the added message to show as its own prompt event`);
  }
  if (!obeyed) throw new Error(`${id}: the agent never saw the added message`);
  // Guards the Claude adapter's `ADD_ON_QUIET_MS`. If a real restart ever takes
  // longer than the deadline that is supposed to mean "no restart is coming",
  // doet would end exchanges early — and in VS that commits a branch the agent
  // is still writing to.
  if (id === 'claude' && restartGapMs > ADD_ON_QUIET_MS / 2) {
    throw new Error(
      `${id}: a turn restart took ${restartGapMs}ms, too close to the ${ADD_ON_QUIET_MS}ms quiet deadline`,
    );
  }
}

console.log('\nall good');
