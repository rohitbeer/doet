import { check, section, report, dist, skip, has } from './harness.mjs';
// Builds a kilo database with a real session in it — same schema kilo created
// on this machine — and runs doet's reader over it. This is the only way to
// prove the message/part parsing without credentials to make a real session.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!has("kilo", ['--version'])) skip("kilo is not installed, so there is no schema to copy");

const dir = mkdtempSync(join(tmpdir(), 'doet-fixture-'));
const dbPath = join(dir, 'kilo.db');
const CWD = '/tmp/doet-fixture-worktree';

// The schema, copied verbatim out of the kilo install on this machine.
const schema = execFileSync('kilo', ['db',
  "select sql from sqlite_master where type='table' and name in ('session','message','part')",
  '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const db = new DatabaseSync(dbPath);
for (const row of JSON.parse(schema)) {
  // Drop the foreign keys: the fixture inserts only the three tables under test.
  db.exec(row.sql.replace(/,\s*CONSTRAINT[\s\S]*?\)\s*$/m, '\n)'));
}

const now = Date.now();
db.exec(`insert into session (id, project_id, slug, directory, title, version,
  cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  time_created, time_updated)
  values ('ses_1','prj','slug','${CWD}','t','7.4.21', 0.0432, 1200, 340, 90, 500, 10, ${now}, ${now + 5000})`);

const msg = (id, role, completed) => db.exec(
  `insert into message (id, session_id, time_created, time_updated, data) values
   ('${id}','ses_1',${now},${now}, '${JSON.stringify({
     id, role, sessionID: 'ses_1',
     time: completed ? { created: now, completed: now + 1000 } : { created: now },
     modelID: 'claude-opus-4', providerID: 'anthropic',
   }).replace(/'/g, "''")}')`);

const part = (id, messageId, type, text) => db.exec(
  `insert into part (id, message_id, session_id, time_created, time_updated, data) values
   ('${id}','${messageId}','ses_1',${now},${now}, '${JSON.stringify({
     id, messageID: messageId, sessionID: 'ses_1', type, ...(text ? { text } : {}),
   }).replace(/'/g, "''")}')`);

msg('msg_user', 'user', true);
part('prt_u', 'msg_user', 'text', 'the request');
msg('msg_1', 'assistant', true);           // a finished turn
part('prt_1a', 'msg_1', 'step-start');     // noise that must not appear
part('prt_1b', 'msg_1', 'reasoning', 'thinking out loud');
part('prt_1c', 'msg_1', 'text', 'First half. ');
part('prt_1d', 'msg_1', 'text', 'Second half.');
msg('msg_2', 'assistant', false);          // still going
part('prt_2a', 'msg_2', 'text', 'partial answer');
db.close();

process.env.KILO_DB = dbPath;
const { cliFor } = await import(dist('core/agents/registry.js'));
const journal = cliFor('kilo').journal;


const known = await journal.known(CWD);
check('known() finds the session by directory', known.has('ses_1'), [...known]);
check('find() skips one it already knew', await journal.find(CWD, 0, known) === null);
check('find() returns a session it did not know', await journal.find(CWD, 0, new Set()) === 'ses_1');
check('find() ignores another directory', await journal.find('/tmp/elsewhere', 0, new Set()) === null);

const state = await journal.read('ses_1');
check('one finished turn (the open one is excluded)', state.turns.length === 1, state.turns);
check('text is joined across parts', state.turns[0]?.text === 'First half. Second half.', state.turns[0]?.text);
check('reasoning and step-start are excluded',
  !state.turns[0]?.text.includes('thinking') && !state.turns[0]?.text.includes('step'));
check('working is true while a turn is open', state.working === true);
check('input tokens', state.usage.inputTokens === 1200, state.usage);
check('output tokens', state.usage.outputTokens === 340, state.usage);
check('cached tokens', state.usage.cachedTokens === 500, state.usage);
check('total includes reasoning', state.usage.totalTokens === 1200 + 340 + 90, state.usage);
check('cost is the CLI\'s own figure, not an estimate', state.usage.costUsd === 0.0432, state.usage);
check('size is non-zero so stall detection has a signal', state.size > 0, state.size);

// The stall signal must move when the session does, and only then.
const before = state.size;
const db2 = new DatabaseSync(dbPath);
db2.exec(`insert into part (id, message_id, session_id, time_created, time_updated, data)
  values ('prt_2b','msg_2','ses_1',${now},${now},'{"type":"text","text":" more"}')`);
db2.close();
check('size changes when the session grows', (await journal.read('ses_1')).size !== before);

report('kilo journal');
