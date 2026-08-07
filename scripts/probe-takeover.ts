/**
 * Proves the full pane handover round-trip, with a real CLI in the middle.
 *
 *   doet session ──release──► `claude -p --resume <id>` ──► doet re-attaches
 *
 * The middle step runs the agent's own CLI non-interactively so the probe can
 * run unattended; in doet it is the interactive TUI, attached to your terminal.
 * What matters either way is that all three parties agree on one session id,
 * and that work done in the middle survives into the re-attached session.
 *
 *   npx tsx scripts/probe-takeover.ts [claude|codex|both]
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

/**
 * The non-interactive stand-in for "the user typed in the real CLI".
 *
 * `codex exec` refuses to run outside a trusted directory, which the
 * interactive TUI instead asks about — hence the extra flag here and not in
 * `interactiveCommand()`.
 */
function headlessArgs(id: string, agent: string, prompt: string): [string, string[]] {
  return agent === 'claude'
    ? ['claude', ['--resume', id, '--print', prompt]]
    : ['codex', ['exec', 'resume', id, '--skip-git-repo-check', prompt]];
}

async function exercise(agent: AgentAdapter): Promise<void> {
  console.log(`\n=== ${agent.label} ===`);
  await agent.start();

  await agent.send('Remember this word: ORCHID. Reply with just: OK', 'probe');

  const argv = agent.interactiveCommand();
  console.log(`doet would open: ${argv!.command} ${argv!.args.join(' ')}`);

  const id = (await agent.releaseSession())!;
  console.log(`released ${id}`);

  // Stand in for the user working in their own CLI for a while.
  const [command, args] = headlessArgs(id, agent.id, 'Also remember the word TRELLIS. Reply with just: OK');
  const result = await run(command, args);
  console.log(`interactive CLI exit=${result.code}: ${result.out.trim().slice(0, 120)}`);
  if (result.code !== 0) {
    console.log('FAIL: the CLI could not open that session id');
    await agent.dispose();
    return;
  }

  await agent.resumeSession(id);
  const check = await agent.send(
    'List every word I have asked you to remember, comma separated. Nothing else.',
    'probe',
  );
  const text = check.text.toUpperCase();
  console.log(`recall → ${JSON.stringify(check.text.slice(0, 80))}`);
  console.log(
    `  doet-era word ORCHID:  ${text.includes('ORCHID') ? 'PASS' : 'FAIL'}\n` +
      `  user-era word TRELLIS: ${text.includes('TRELLIS') ? 'PASS' : 'FAIL'}`,
  );

  await agent.dispose();
}

/**
 * The race the UI actually has to survive: a turn is in flight, the user takes
 * that agent's session over, and doet must not release a session the conductor
 * is still awaiting.
 */
async function midTurn(): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const { Conductor } = await import('../src/core/conductor.js');
  const { SessionStore } = await import('../src/core/sessions.js');
  const { Summarizer } = await import('../src/core/summarizer.js');
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');

  console.log('\n=== mid-turn takeover ===');
  const claude = new ClaudeAdapter({ bus, cwd: process.cwd(), model: 'haiku' });
  const codex = new CodexAdapter({ bus, cwd: process.cwd(), model: '', sandbox: 'read-only' });
  const agents = { claude, codex };
  await Promise.all([claude.start(), codex.start()]);

  const store = new SessionStore(randomUUID());
  const summarizer = new Summarizer({
    bus,
    cwd: process.cwd(),
    setting: { ...DEFAULT_CONFIG.summary, agent: 'off' },
  });
  const conductor = new Conductor({
    bus,
    agents,
    store,
    summarizer,
    sessions: DEFAULT_CONFIG.sessions,
    config: { maxRounds: 6 },
  });

  const run = conductor.run('Count slowly from 1 to 40, one number per line.', 'claude');

  // Barge in while Claude is still talking.
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`running=${conductor.isRunning} active=${conductor.activeAgent}`);

  console.log('aborting for takeover…');
  await conductor.abort();
  await conductor.whenIdle();
  console.log(`settled. running=${conductor.isRunning}`);

  const id = await claude.releaseSession();
  console.log(`released ${id}`);
  await claude.resumeSession(id!);
  console.log('re-attached');

  // The session must still be usable, and the run must have resolved without
  // a synthesis turn against a session that was being handed over.
  const after = await claude.send('Reply with just: STILL HERE', 'probe');
  console.log(`post-takeover turn → ${JSON.stringify(after.text.slice(0, 40))} error=${after.error ?? 'none'}`);

  const result = await run;
  console.log(`run resolved: reason=${result.reason} rounds=${result.rounds}`);
  console.log(after.text.includes('STILL HERE') && !after.error ? 'PASS' : 'FAIL');

  await summarizer.dispose();
  await Promise.all([claude.dispose(), codex.dispose()]);
}

const which = process.argv[2] ?? 'both';
if (which === 'midturn') {
  await midTurn();
} else {
  if (which === 'both' || which === 'claude') {
    await exercise(new ClaudeAdapter({ bus, cwd: process.cwd(), model: 'haiku' }));
  }
  if (which === 'both' || which === 'codex') {
    await exercise(new CodexAdapter({ bus, cwd: process.cwd(), model: '', sandbox: 'read-only' }));
  }
}

console.log('\ndone');
process.exit(0);
