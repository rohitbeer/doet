/**
 * Checks that a session can be released and re-attached without losing memory.
 *
 * This is the foundation of the pane handover: doet drops the live session, an
 * interactive CLI owns it for a while, and doet picks it back up. If re-attach
 * does not remember, the whole feature is a lie.
 *
 *   npx tsx scripts/probe-resume.ts [claude|codex|both]
 */
import { Bus } from '../src/core/bus.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import type { AgentAdapter } from '../src/core/types.js';

const bus = new Bus();
bus.on((event) => {
  if (event.kind === 'error') console.log(`  [${event.agent}] ERROR ${event.message}`);
});

const WORD = 'BANANA';

async function exercise(agent: AgentAdapter): Promise<void> {
  console.log(`\n=== ${agent.label} ===`);
  await agent.start();

  await agent.send(`Remember this word: ${WORD}. Reply with just: OK`, 'probe');
  const id = agent.info().sessionId;
  console.log(`session id: ${id}`);

  const argv = agent.interactiveCommand();
  console.log(`interactive: ${argv ? `${argv.command} ${argv.args.join(' ')}` : '(none)'}`);

  // Release, as the handover does before spawning the interactive CLI.
  const released = await agent.releaseSession();
  console.log(`released: ${released}`);

  // Re-attach, as the handover does when the user exits.
  await agent.resumeSession(released!);
  console.log(`re-attached, session id now: ${agent.info().sessionId}`);

  const check = await agent.send(
    'What word did I ask you to remember? Reply with just that word, or NOMEMORY if you do not know.',
    'probe',
  );
  const remembered = check.text.toUpperCase().includes(WORD);
  console.log(`recall → ${JSON.stringify(check.text.slice(0, 60))}  ${remembered ? 'PASS' : 'FAIL'}`);
  console.log(`session #${agent.info().sessionSeq}, turns=${agent.info().sessionTurns}`);

  await agent.dispose();
}

const which = process.argv[2] ?? 'both';
if (which === 'both' || which === 'claude') {
  await exercise(new ClaudeAdapter({ bus, cwd: process.cwd(), model: 'haiku' }));
}
if (which === 'both' || which === 'codex') {
  await exercise(new CodexAdapter({ bus, cwd: process.cwd(), model: '', sandbox: 'read-only' }));
}

console.log('\ndone');
process.exit(0);
