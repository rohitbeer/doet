/**
 * End-to-end check of doet's core with no TUI: starts both agents, runs a real
 * debate, and auto-approves permission requests so it can run unattended.
 *
 * Run with: npx tsx scripts/probe-debate.ts "your question"
 */
import { randomUUID } from 'node:crypto';
import { Bus } from '../src/core/bus.js';
import { Conductor } from '../src/core/conductor.js';
import { SessionStore } from '../src/core/sessions.js';
import { Summarizer } from '../src/core/summarizer.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { sessionInstructions } from '../src/core/relay.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { AGENT_IDS, type AgentAdapter, type AgentId } from '../src/core/types.js';

const query = process.argv[2] ?? 'In one sentence, what is the single biggest risk of relaying output between two AI agents without a human in the loop?';
const rounds = Number(process.argv[3] ?? 4);
/** `last` uses whoever just spoke; `off` skips the digest entirely. */
const summaryAgent = (process.argv[4] ?? 'claude') as AgentId | 'last' | 'off';

const bus = new Bus();
const cwd = process.cwd();

const claude = new ClaudeAdapter({
  bus,
  cwd,
  model: 'sonnet',
  instructions: sessionInstructions({ self: 'claude', other: 'codex', rounds }),
});
const codex = new CodexAdapter({
  bus,
  cwd,
  model: '',
  sandbox: 'read-only',
  instructions: sessionInstructions({ self: 'codex', other: 'claude', rounds }),
});
const agents: Record<AgentId, AgentAdapter> = { claude, codex };

const seen: Record<string, number> = {};

bus.on((event) => {
  switch (event.kind) {
    case 'status':
      console.log(`[${event.agent}] status=${event.status}`);
      break;
    case 'permission':
      console.log(
        `[${event.agent}] PERMISSION ${event.request.title}: ${event.request.summary}`,
      );
      // Auto-approve so the probe runs unattended. The TUI is what puts a
      // human here; this only proves the round-trip works.
      setTimeout(() => {
        const allow = event.request.options[0]!;
        agents[event.agent].resolvePermission(event.request.id, allow.id);
        console.log(`[${event.agent}] auto-answered "${allow.label}"`);
      }, 50);
      break;
    case 'tool':
      if (event.phase === 'start') console.log(`[${event.agent}] tool ${event.name} ${event.summary}`);
      break;
    case 'turn-end':
      console.log(`\n===== ${event.agent} turn (${event.text.length} chars) =====`);
      console.log(event.text.slice(0, 600));
      console.log('=====\n');
      break;
    case 'relay':
      console.log(`>>> relay ${event.from} -> ${event.to} (round ${event.round}) [${event.note}]`);
      break;
    case 'prompt':
      // The whole point of the split: show what a turn actually carries.
      console.log(
        `\n>>> PROMPT → ${event.agent} [${event.label}] ${event.text.trim().split(/\s+/).length} words\n` +
          `${event.text.trim()}\n<<< end prompt\n`,
      );
      break;
    case 'usage':
      seen[event.agent] = event.usage.outputTokens ?? 0;
      break;
    case 'error':
      console.log(`[${event.agent}] ERROR ${event.message}`);
      break;
    case 'log':
      console.log(`[${event.source}] ${event.message}`);
      break;
    case 'gist':
      console.log(`\n----- gist after round ${event.round} -----\n${event.text}\n-----\n`);
      break;
    case 'session':
      console.log(`>>> ${event.agent} opened a new session (carried ${event.carried})`);
      break;
    default:
      break;
  }
});

async function main() {
  console.log('starting agents…');
  await Promise.all(AGENT_IDS.map((id) => agents[id].start()));
  console.log('both agents ready.\n');
  console.log('claude:', JSON.stringify(claude.info()));
  console.log('codex :', JSON.stringify(codex.info()));
  console.log();

  const store = new SessionStore(randomUUID());
  store.attach(bus);

  const summarizer = new Summarizer({
    bus,
    cwd,
    setting: { ...DEFAULT_CONFIG.summary, agent: summaryAgent },
    debaters: agents,
  });

  const conductor = new Conductor({
    bus,
    agents,
    store,
    summarizer,
    sessions: DEFAULT_CONFIG.sessions,
    config: { ...DEFAULT_CONFIG.debate, maxRounds: rounds },
    // No human here, so an `ask` policy has to answer itself.
    hooks: { askHandoff: async () => 'gist' },
  });

  const result = await conductor.run(query, 'claude');

  console.log('\n################ RESULT ################');
  console.log('reason      :', result.reason);
  console.log('rounds      :', result.rounds);
  console.log('final from  :', result.finalFrom);
  console.log('output tok  :', JSON.stringify(seen));
  console.log('session dir :', store.dir);
  console.log('\n--- gist ---\n');
  console.log(summarizer.current || '(none)');
  console.log('\n--- final ---\n');
  console.log(result.final);

  store.finalize(result);
  await summarizer.dispose();
  await Promise.all(AGENT_IDS.map((id) => agents[id].dispose()));
  process.exit(0);
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  process.exit(1);
});
