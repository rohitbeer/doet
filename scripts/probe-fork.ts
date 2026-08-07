/**
 * Checks that branching a session leaves the original alone.
 *
 * The claim behind "open it in a new window and keep going" is that doet never
 * lets go: the branch is a *different* session, so the live one is neither
 * paused nor mutated. This proves both halves — the branch inherits the
 * conversation, and work done on the branch does not leak back.
 *
 *   npx tsx scripts/probe-fork.ts [claude|codex|both]
 */
import { spawn } from 'node:child_process';
import { Bus } from '../src/core/bus.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import type { AgentAdapter } from '../src/core/types.js';

const bus = new Bus();
bus.on((event) => {
  if (event.kind === 'error') console.log(`  [${event.agent}] ERROR ${event.message}`);
});

function run(command: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/** Non-interactive stand-in for the window a user would actually get. */
function headless(argv: { command: string; args: string[] }, prompt: string): [string, string[]] {
  if (argv.command === 'claude') {
    return ['claude', [...argv.args, '--print', prompt]];
  }
  // `codex resume <id>` → `codex exec resume <id>` for an unattended run.
  const id = argv.args[argv.args.length - 1]!;
  return ['codex', ['exec', 'resume', id, '--skip-git-repo-check', prompt]];
}

async function exercise(agent: AgentAdapter): Promise<void> {
  console.log(`\n=== ${agent.label} ===`);
  await agent.start();

  await agent.send('Remember this word: LANTERN. Reply with just: OK', 'probe');
  const liveId = agent.info().sessionId;
  console.log(`live session: ${liveId}`);

  const argv = await agent.forkSession();
  if (!argv) {
    console.log('FAIL: no branch command');
    await agent.dispose();
    return;
  }
  console.log(`branch opens with: ${argv.command} ${argv.args.join(' ')}`);

  // The live session must still be usable *right now* — nothing was released.
  const still = await agent.send('Reply with just: STILL RUNNING', 'probe');
  console.log(
    `live session during branch → ${JSON.stringify(still.text.slice(0, 40))}  ` +
      `${still.text.includes('STILL RUNNING') && !still.error ? 'PASS' : 'FAIL'}`,
  );

  // The branch should inherit the conversation, and take on work of its own.
  const [command, args] = headless(argv, 'What word were you asked to remember? Then also remember: TANGENT. Reply with both words only.');
  const result = await run(command, args);
  const branchText = result.out.toUpperCase();
  console.log(`branch says: ${JSON.stringify(result.out.trim().slice(0, 70))}`);
  console.log(`  inherited LANTERN: ${branchText.includes('LANTERN') ? 'PASS' : 'FAIL'}`);

  // …and none of that should have reached the session doet is still driving.
  const check = await agent.send(
    'List every word you have been asked to remember, comma separated. Nothing else.',
    'probe',
  );
  const liveText = check.text.toUpperCase();
  console.log(`live session now: ${JSON.stringify(check.text.slice(0, 60))}`);
  console.log(
    `  still has LANTERN:        ${liveText.includes('LANTERN') ? 'PASS' : 'FAIL'}\n` +
      `  did NOT absorb TANGENT:   ${!liveText.includes('TANGENT') ? 'PASS' : 'FAIL'}\n` +
      `  session id unchanged:     ${agent.info().sessionId === liveId ? 'PASS' : 'FAIL'}\n` +
      `  never rotated (#${agent.info().sessionSeq}):     ${agent.info().sessionSeq === 1 ? 'PASS' : 'FAIL'}`,
  );

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
