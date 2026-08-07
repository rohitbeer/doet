/**
 * Checks that a rotated session actually carries what it was told to carry.
 *
 * Runs a short debate with a `rounds:1` policy on Codex, so Codex gets a fresh
 * thread between its turns. The interesting question is not whether the thread
 * is new — probe-select proves that — but whether the replacement can still
 * answer a question about work it never did.
 *
 *   npx tsx scripts/probe-handoff.ts [gist|full|none]
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bus } from '../src/core/bus.js';
import { Conductor } from '../src/core/conductor.js';
import { SessionStore } from '../src/core/sessions.js';
import { Summarizer } from '../src/core/summarizer.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { AGENT_IDS, type AgentAdapter, type AgentId, type HandoffMode } from '../src/core/types.js';

const mode = (process.argv[2] ?? 'gist') as HandoffMode;

const bus = new Bus();
const cwd = process.cwd();

const claude = new ClaudeAdapter({ bus, cwd, model: 'sonnet' });
const codex = new CodexAdapter({ bus, cwd, model: '', sandbox: 'read-only' });
const agents: Record<AgentId, AgentAdapter> = { claude, codex };

/** The prompt each agent actually received, so a handoff can be inspected. */
const prompts: Array<{ agent: AgentId; label: string; text: string }> = [];

bus.on((event) => {
  switch (event.kind) {
    case 'prompt':
      prompts.push({ agent: event.agent, label: event.label, text: event.text });
      console.log(`>>> prompt → ${event.agent} [${event.label}] ${event.text.length} chars`);
      break;
    case 'session':
      console.log(`>>> ${event.agent} opened a NEW session`);
      break;
    case 'permission':
      setTimeout(() => {
        agents[event.agent].resolvePermission(event.request.id, event.request.options[0]!.id);
      }, 50);
      break;
    case 'turn-end':
      console.log(`--- ${event.agent} turn: ${event.text.slice(0, 160).replace(/\n/g, ' ')}`);
      break;
    case 'error':
      console.log(`[${event.agent}] ERROR ${event.message}`);
      break;
    case 'log':
      console.log(`[${event.source}] ${event.message}`);
      break;
    default:
      break;
  }
});

async function main() {
  await Promise.all(AGENT_IDS.map((id) => agents[id].start()));
  console.log(`both agents ready. handoff mode = ${mode}\n`);

  const store = new SessionStore(randomUUID());
  store.attach(bus);
  const summarizer = new Summarizer({ bus, cwd, setting: DEFAULT_CONFIG.summary });

  const conductor = new Conductor({
    bus,
    agents,
    store,
    summarizer,
    // Codex rotates after every one of its turns; Claude never does, so it acts
    // as the control that still remembers everything.
    sessions: {
      claude: { policy: { mode: 'manual' }, handoff: 'ask' },
      codex: { policy: { mode: 'rounds', every: 1 }, handoff: mode },
    },
    config: { maxRounds: 4, agreeStreak: 99, synthesize: false },
  });

  const result = await conductor.run(
    'Pick exactly one word to name this session and state it. Then, in later turns, always repeat the word you were given before adding anything new.',
    'claude',
  );

  console.log('\n################ RESULT ################');
  console.log('reason:', result.reason, '· rounds:', result.rounds);
  console.log('codex sessions opened:', codex.info().sessionSeq);
  console.log('claude sessions opened:', claude.info().sessionSeq);

  // The handoff is prepended to the first prompt of each new session, so its
  // presence and size is visible right here.
  const codexPrompts = prompts.filter((p) => p.agent === 'codex');
  codexPrompts.forEach((p, i) => {
    const carried = p.text.includes('<handoff>');
    console.log(
      `codex prompt ${i}: ${p.text.length} chars, handoff=${carried ? 'YES' : 'no'}`,
    );
  });

  const second = codexPrompts[1];
  if (second) {
    const start = second.text.indexOf('<handoff>');
    console.log('\n--- what the replacement session was handed ---');
    console.log(start >= 0 ? second.text.slice(start, start + 700) : '(nothing carried)');
  }

  console.log('\n--- session.md on disk ---');
  console.log(readFileSync(join(store.dir, 'session.md'), 'utf8').slice(0, 400));

  await summarizer.dispose();
  await Promise.all(AGENT_IDS.map((id) => agents[id].dispose()));
  process.exit(0);
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  process.exit(1);
});
