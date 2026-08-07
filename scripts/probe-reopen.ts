/**
 * Checks that `doet --resume` really reopens a session rather than just its
 * markdown: both agents must come back remembering what they were told.
 *
 *   npx tsx scripts/probe-reopen.ts
 */
import { randomUUID } from 'node:crypto';
import { Bus } from '../src/core/bus.js';
import { SessionStore } from '../src/core/sessions.js';
import { Summarizer } from '../src/core/summarizer.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { AGENT_IDS, type AgentAdapter, type AgentId } from '../src/core/types.js';

const bus = new Bus();
bus.on((event) => {
  if (event.kind === 'error') console.log(`  [${event.agent}] ERROR ${event.message}`);
  if (event.kind === 'log' && event.level !== 'info') console.log(`  [${event.source}] ${event.message}`);
});

const cwd = process.cwd();

function build(): Record<AgentId, AgentAdapter> {
  return {
    claude: new ClaudeAdapter({ bus, cwd, model: 'haiku' }),
    codex: new CodexAdapter({ bus, cwd, model: '', sandbox: 'read-only' }),
  };
}

// ---- first run -------------------------------------------------------------

console.log('=== run 1 ===');
const first = build();
await Promise.all(AGENT_IDS.map((id) => first[id].start()));

const store = new SessionStore(randomUUID());
store.attach(bus);
store.openQuestion('remember a word');

for (const id of AGENT_IDS) {
  await first[id].send(`Remember this word: MERIDIAN. Reply with just: OK`, 'probe');
}

store.writeMeta({
  cwd,
  query: 'remember a word',
  agents: {
    claude: { sessionId: first.claude.info().sessionId, model: first.claude.info().model },
    codex: { sessionId: first.codex.info().sessionId, model: first.codex.info().model },
  },
  summary: { agent: 'off', model: '' },
});
console.log(`stored ${store.id}`);
console.log(`  claude session ${first.claude.info().sessionId}`);
console.log(`  codex  session ${first.codex.info().sessionId}`);

// Quit hard, as a crash would.
await Promise.all(AGENT_IDS.map((id) => first[id].dispose()));

// ---- resolve, as the CLI does ---------------------------------------------

console.log('\n=== resolve ===');
const listed = SessionStore.list(cwd);
console.log(`sessions for this cwd: ${listed.length}, newest ${listed[0]?.id}`);

const meta = SessionStore.resolve(true, cwd);
if (!meta || meta.id !== store.id) {
  console.log(`FAIL: --resume resolved to ${meta?.id ?? 'nothing'}, expected ${store.id}`);
  process.exit(1);
}
console.log(`--resume would reopen ${meta.id}  PASS`);

const byPrefix = SessionStore.resolve(meta.id.slice(0, 12), cwd);
console.log(`--resume <prefix> → ${byPrefix?.id === meta.id ? 'PASS' : 'FAIL'}`);

// ---- second run ------------------------------------------------------------

console.log('\n=== run 2 (resumed) ===');
const second = build();
await Promise.all(AGENT_IDS.map((id) => second[id].start()));

const reopened = new SessionStore(randomUUID(), meta.id);
console.log(`reopened dir: ${reopened.id === meta.id ? 'PASS' : 'FAIL'} (${reopened.id})`);

const summarizer = new Summarizer({ bus, cwd, setting: { ...DEFAULT_CONFIG.summary, agent: 'off' } });
summarizer.seed(reopened.readGist());

for (const id of AGENT_IDS) {
  const stored = meta.agents[id].sessionId;
  if (stored) await second[id].resumeSession(stored);
}

let pass = true;
for (const id of AGENT_IDS) {
  const check = await second[id].send(
    'What word did I ask you to remember? Reply with just that word, or NOMEMORY.',
    'probe',
  );
  const ok = check.text.toUpperCase().includes('MERIDIAN');
  pass &&= ok;
  console.log(`${id}: ${JSON.stringify(check.text.slice(0, 40))}  ${ok ? 'PASS' : 'FAIL'}`);
}

await summarizer.dispose();
await Promise.all(AGENT_IDS.map((id) => second[id].dispose()));

console.log(`\n${pass ? 'ALL PASS' : 'FAILED'}`);
process.exit(pass ? 0 : 1);
