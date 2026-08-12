import { check, section, report, dist, skip, has } from './harness.mjs';
// The same treatment for cline: a sessions.db with cline's real schema, plus a
// messages file written in cline's documented --json vocabulary, run through
// doet's reader. Proves the parsing and, just as importantly, that a shape the
// reader does not recognise degrades to "unknown" rather than to a crash.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

if (!has("sqlite3", ['--version'])) skip("sqlite3 is not on PATH, so cline's schema cannot be read");

const dir = mkdtempSync(join(tmpdir(), 'doet-cline-'));
mkdirSync(join(dir, 'db'), { recursive: true });
const CWD = '/tmp/doet-fixture-worktree';

// cline's own schema, read off the database cline created on this machine.
const schema = execFileSync('sqlite3',
  [join(homedir(), '.cline/data/db/sessions.db'),
   "select sql from sqlite_master where type='table' and name='sessions'"],
  { encoding: 'utf8' }).trim();
const db = new DatabaseSync(join(dir, 'db', 'sessions.db'));
db.exec(schema);

const messagesPath = join(dir, 'messages.json');
const at = Date.now();
db.exec(`insert into sessions (session_id, source, pid, started_at, status, status_lock,
  interactive, provider, model, cwd, workspace_root, enable_tools, enable_spawn, enable_teams,
  hook_path, messages_path, updated_at)
  values ('s1','cli',1,'${new Date(at).toISOString()}','running',0,1,'anthropic','claude-opus-4',
  '${CWD}','${CWD}',1,1,1,'','${messagesPath}','${new Date(at).toISOString()}')`);
db.close();

// cline's documented --json fields: type, text, ts, say/ask, reasoning, partial.
writeFileSync(messagesPath, JSON.stringify([
  { ts: at, type: 'say', say: 'api_req_started',
    text: JSON.stringify({ tokensIn: 900, tokensOut: 210, cacheReads: 300, cost: 0.011 }) },
  { ts: at + 1, type: 'say', say: 'text', text: 'Looking at the file.' },
  { ts: at + 2, type: 'say', say: 'text', text: 'ignore me', partial: true },
  { ts: at + 3, type: 'say', say: 'completion_result', text: 'Done: renamed the helper.' },
  { ts: at + 4, type: 'say', say: 'text', text: 'Starting the follow-up.' },
]), 'utf8');

process.env.CLINE_DATA_DIR = dir;
const { cliFor } = await import(dist('core/agents/registry.js'));
const journal = cliFor('cline').journal;


const known = await journal.known(CWD);
check('known() finds the session by cwd', known.has('s1'), [...known]);
check('find() returns a session it did not know', await journal.find(CWD, 0, new Set()) === 's1');

const state = await journal.read('s1');
check('one completed turn', state.turns.length === 1, state.turns);
check('turn text spans say:text and completion_result',
  state.turns[0]?.text === 'Looking at the file.\n\nDone: renamed the helper.', state.turns[0]?.text);
check('a partial is not counted twice', !state.turns[0]?.text.includes('ignore me'));
check('text after the marker leaves the next turn open', state.working === true);
check('input tokens from api_req_started', state.usage.inputTokens === 900, state.usage);
check('output tokens', state.usage.outputTokens === 210, state.usage);
check('cost', state.usage.costUsd === 0.011, state.usage);

// The honest-degradation path: a messages file in a shape the reader has never
// seen must leave usage unknown, not crash and not invent a number.
writeFileSync(messagesPath, JSON.stringify({ some: 'other shape entirely' }), 'utf8');
const odd = await journal.read('s1');
check('an unrecognised messages file yields no turns', odd.turns.length === 0, odd.turns);
check('and no invented usage', odd.usage.inputTokens === undefined, odd.usage);
check('and still reports the session as live', odd.working === true);

writeFileSync(messagesPath, '{ "half written', 'utf8');
const torn = await journal.read('s1');
check('a half-written file does not throw', Array.isArray(torn.turns));

report('cline journal');
