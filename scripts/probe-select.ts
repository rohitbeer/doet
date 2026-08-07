/**
 * Proves model selection round-trips on both CLIs, with no TUI in the way.
 *
 * Starts each adapter, lists what the account can run, switches to a specific
 * model + effort, and asks the agent one throwaway question. Then rotates the
 * session and checks the agent has actually forgotten.
 *
 *   npx tsx scripts/probe-select.ts
 */
import { Bus } from '../src/core/bus.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import type { AgentAdapter } from '../src/core/types.js';

const bus = new Bus();
bus.on((event) => {
  if (event.kind === 'log' || event.kind === 'error') {
    console.log(`  [${event.kind === 'error' ? event.agent : event.source}] ${event.message}`);
  }
});

async function exercise(agent: AgentAdapter, wanted: string): Promise<void> {
  console.log(`\n=== ${agent.label} ===`);
  await agent.start();

  const models = await agent.listModels();
  console.log(`models (${models.length}):`);
  for (const m of models) {
    console.log(`  ${m.id.padEnd(22)} ${m.label.padEnd(22)} efforts=${m.efforts?.join(',') ?? '–'}`);
  }

  const pick = models.find((m) => m.id.includes(wanted)) ?? models[0];
  if (!pick) throw new Error('no models reported');

  const effort = pick.efforts?.includes('low') ? 'low' : pick.efforts?.[0];
  await agent.setModel(pick.id, effort);
  console.log(`selected → ${JSON.stringify({ model: agent.info().model, effort: agent.info().effort })}`);

  // A bogus id must be rejected rather than silently accepted and persisted.
  try {
    await agent.setModel('definitely-not-a-model');
    console.log('BUG: bogus model was accepted');
  } catch (error) {
    console.log(`rejected bogus model: ${(error as Error).message.slice(0, 80)}…`);
  }

  const first = await agent.send('Reply with exactly: PINEAPPLE. Nothing else.', 'probe');
  console.log(`turn 1 → ${JSON.stringify(first.text.slice(0, 60))} (error=${first.error ?? 'none'})`);
  console.log(`resolved model → ${agent.info().resolvedModel ?? '(not reported)'}`);
  console.log(`session #${agent.info().sessionSeq}, turns=${agent.info().sessionTurns}`);

  await agent.newSession();
  const second = await agent.send(
    'What single word did I ask you to reply with a moment ago? If you have no idea, reply exactly: NOMEMORY.',
    'probe',
  );
  console.log(`after newSession → ${JSON.stringify(second.text.slice(0, 90))}`);
  console.log(`session #${agent.info().sessionSeq}, turns=${agent.info().sessionTurns}`);

  await agent.dispose();
}

const which = process.argv[2] ?? 'both';

if (which === 'both' || which === 'claude') {
  await exercise(new ClaudeAdapter({ bus, cwd: process.cwd(), model: 'sonnet' }), 'haiku');
}
if (which === 'both' || which === 'codex') {
  await exercise(new CodexAdapter({ bus, cwd: process.cwd(), model: '' }), 'mini');
}

console.log('\ndone');
process.exit(0);
