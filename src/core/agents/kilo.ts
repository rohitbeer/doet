import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelChoice } from '../types.js';
import { realPath } from './file-journal.js';
import { json, num, query, quote, stamp, text, type SqlSource } from './sqlite.js';
import type { CliDefinition, JournalReader, JournalState, LaunchContext, ProviderChoice } from './types.js';

const run = promisify(execFile);

/**
 * kilo — and, before long, opencode.
 *
 * kilo is a fork of opencode and does not hide it: run `kilo --help` and the
 * log line it prints identifies itself as `opencode`. Everything below is
 * therefore opencode's shape too — the same `session`/`message`/`part` tables,
 * the same message schema, the same flags — which is why the next ticket's
 * opencode support is very nearly this file with a different binary name and
 * data directory.
 *
 * The database is the richest source of any of the four agents. Its `session`
 * row carries not just tokens but a real `cost`, which means kilo is the only
 * one of them whose spend on doet's scoreboard is a figure the CLI computed
 * rather than one doet estimated from a rate table.
 */

const KILO_DATA = join(homedir(), '.local', 'share', 'kilo');

/**
 * `KILO_DB` is kilo's own override, not doet's invention — it is how kilo itself
 * decides where its database lives, so honouring it means doet follows a kilo
 * pointed somewhere else instead of reading a store nothing is writing to.
 *
 * It is also what makes this reader testable: a fixture database with a session
 * in it can be handed to the same code that will read the real one, which
 * matters more here than anywhere else in doet, since a session cannot be
 * created without credentials.
 */
const source: SqlSource = {
  path: process.env.KILO_DB || join(KILO_DATA, 'kilo.db'),
  fallback: (sql) => ({ command: 'kilo', args: ['db', sql, '--format', 'json'] }),
};

/**
 * Fast enough that the poll is not the thing you are waiting for, slow enough
 * that nine agents are not hammering one file.
 *
 * The direct read costs about 8ms, so this is almost all sleep. On a runtime
 * that has to fall back to `kilo db` each read costs a second and a half and
 * the loop simply runs slower — `awaitTurn` waits for the read before it waits
 * at all, so nothing overlaps and nothing queues up.
 */
const POLL_MS = 800;

interface SessionRow {
  id: unknown;
  directory: unknown;
  time_created: unknown;
  time_updated: unknown;
  cost: unknown;
  tokens_input: unknown;
  tokens_output: unknown;
  tokens_reasoning: unknown;
  tokens_cache_read: unknown;
  tokens_cache_write: unknown;
}

/**
 * Sessions kilo has filed against a working tree.
 *
 * Matched on `directory`, which is exact and is what makes VS work at all: a
 * run has several worktrees of one repository open at once and they differ only
 * by path. Both the resolved and unresolved forms are offered because doet
 * cannot know which one kilo wrote — see `realPath` for why that difference is
 * not academic on macOS.
 */
function sessionsIn(cwd: string): Promise<SessionRow[]> {
  const real = realPath(cwd);
  const where = real === cwd ? `directory = ${quote(cwd)}` : `directory in (${quote(cwd)}, ${quote(real)})`;
  return query<SessionRow>(
    source,
    `select id, directory, time_created, time_updated, cost, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write
     from session where ${where} order by time_created desc limit 50`,
  );
}

const journal: JournalReader = {
  pollMs: POLL_MS,

  async known(cwd: string): Promise<Set<string>> {
    return new Set((await sessionsIn(cwd)).map((row) => text(row.id)).filter(Boolean));
  },

  async find(cwd: string, since: number, known: Set<string>): Promise<string | null> {
    for (const row of await sessionsIn(cwd)) {
      const id = text(row.id);
      if (!id || known.has(id)) continue;
      const created = stamp(row.time_created);
      // A second of slack, as everywhere else: the row is written around the
      // moment doet stamps `since`, not after it.
      if (created != null && created < since - 1000) continue;
      return id;
    }
    return null;
  },

  /** The handle already is the session id — there is no file to name it after. */
  async sessionId(handle: string): Promise<string | null> {
    return handle || null;
  },

  async read(handle: string): Promise<JournalState> {
    const id = quote(handle);
    const [sessions, messages, parts] = await Promise.all([
      query<SessionRow>(
        source,
        `select id, directory, time_created, time_updated, cost, tokens_input, tokens_output,
                tokens_reasoning, tokens_cache_read, tokens_cache_write
         from session where id = ${id}`,
      ),
      query<{ id: unknown; data: unknown; time_created: unknown }>(
        source,
        `select id, data, time_created from message where session_id = ${id} order by time_created asc`,
      ),
      query<{ message_id: unknown; data: unknown }>(
        source,
        `select message_id, data from part where session_id = ${id} order by time_created asc`,
      ),
    ]);

    const state: JournalState = {
      turns: [],
      working: false,
      usage: {},
      sessionId: handle,
      // Rows *and* the update stamp: a turn can spend minutes inside one tool
      // call, appending nothing, while `time_updated` keeps moving. Watching
      // rows alone would call that stalled.
      size: messages.length + parts.length,
    };

    const row = sessions[0];
    if (row) {
      const updated = stamp(row.time_updated);
      if (updated != null) state.size += Math.floor(updated / 1000);

      const input = num(row.tokens_input);
      const output = num(row.tokens_output);
      const cacheRead = num(row.tokens_cache_read);
      const cost = num(row.cost);
      state.usage = {
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cacheRead,
        totalTokens: (input ?? 0) + (output ?? 0) + (num(row.tokens_reasoning) ?? 0),
        // Reported rather than estimated. kilo is the only one of the four that
        // keeps a running cost, so this is the CLI's own figure and the
        // scoreboard shows it without a tilde.
        ...(cost != null && cost > 0 ? { costUsd: cost } : {}),
      };
    }

    // Text belongs to a message through its parts, so gather them first.
    const said = new Map<string, string>();
    for (const part of parts) {
      const data = json(part.data);
      // `text` is the answer; `reasoning`, `tool` and `step-start` are the
      // working, and the working is drawn in kilo's own pane rather than here.
      if (data.type !== 'text') continue;
      const body = text(data.text);
      if (!body) continue;
      const key = text(part.message_id) || text(data.messageID);
      said.set(key, (said.get(key) ?? '') + body);
    }

    for (const message of messages) {
      const data = json(message.data);
      if (data.role !== 'assistant') continue;
      const key = text(message.id) || text(data.id);
      const when = json(data.time);
      // `time.completed` is opencode's own turn boundary — set when the
      // assistant has finished, absent while it is still going. It is the
      // cleanest signal of the four CLIs after Codex's task brackets.
      if (stamp(when.completed) == null) {
        state.working = true;
        continue;
      }
      state.turns.push({
        text: (said.get(key) ?? '').trim(),
        at: stamp(when.completed) ?? stamp(message.time_created) ?? Date.now(),
      });
    }

    return state;
  },
};

/**
 * Every model kilo will accept, asked once and remembered.
 *
 * `kilo models` prints one id per line and takes about a second and a half to
 * do it, and the picker asks for the list twice — once to work out the
 * providers, once to show the models under the chosen one. Caching turns three
 * seconds of staring at a blank terminal into one and a half.
 */
let cached: ModelChoice[] | null = null;

async function allModels(): Promise<ModelChoice[]> {
  if (cached) return cached;
  try {
    const { stdout } = await run('kilo', ['models'], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const seen = new Set<string>();
    const models: ModelChoice[] = [];
    for (const line of stdout.split('\n')) {
      const id = line.trim();
      if (!id || id.includes(' ') || !id.includes('/') || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id.slice(id.lastIndexOf('/') + 1) });
    }
    cached = models;
    return models;
  } catch {
    // Empty means doet does not know rather than that there are none: the model
    // is then whatever you typed or whatever kilo defaults to, and a wrong id
    // fails in kilo's own pane with a better message than doet could invent.
    return [];
  }
}

/**
 * The part of an id that names who is being billed — everything up to the last
 * slash.
 *
 * Not the *first* segment, and the difference is the whole reason the provider
 * step is worth having. On a stock install every one of the 288 ids begins
 * `kilo/`, because kilo's own gateway is the configured provider and it fronts
 * everybody: grouping on the first segment yields exactly one group of 288,
 * which is not a choice, it is the same list with an extra keystroke in front
 * of it. Grouping on `kilo/anthropic`, `kilo/openai` and so on turns it into
 * about a dozen groups of ten, which is what a picker is for.
 */
function vendorOf(id: string): string {
  const at = id.lastIndexOf('/');
  return at > 0 ? id.slice(0, at) : id;
}

async function listModels(provider?: string): Promise<ModelChoice[]> {
  const models = await allModels();
  if (!provider) return models;
  return models.filter((model) => vendorOf(model.id) === provider);
}

export const kilo: CliDefinition = {
  id: 'kilo',
  label: 'Kilo',
  command: 'kilo',
  colour: 'green',

  supports: {
    // No dial at all: kilo picks reasoning effort per model rather than per
    // session, so there is nothing here for doet to set and offering the choice
    // would be collecting an answer it would have to throw away.
    efforts: null,
    provider: true,
    // `--prompt` seeds the first message; there is no flag that adds to kilo's
    // own system prompt. AGENTS.md would be the other way in, but writing one
    // into somebody's repository to brief an agent is doet leaving litter in a
    // tracked file.
    systemPrompt: 'prompt',
    addDirs: false,
    turnEnd: 'journal',
    fork: true,
  },

  launch(context: LaunchContext): string[] {
    const args: string[] = [];
    // The working tree is a positional rather than a flag, and passing it
    // explicitly matters: the pane is started in the right directory anyway,
    // but kilo keys its sessions on the directory it was *told* about, and that
    // is the key doet later looks a session up by.
    args.push(context.cwd);
    if (context.resume) args.push('--session', context.resume);
    if (context.model) args.push('--model', context.model);
    if (context.autonomy === 'accept-edits') args.push('--auto');
    return args;
  },

  fork(sessionId: string, cwd: string) {
    return { command: 'kilo', args: [cwd, '--session', sessionId, '--fork'] };
  },

  models: listModels,

  /**
   * Providers, derived from the models rather than asked for separately.
   *
   * `kilo auth list` reports only what has credentials, which on a fresh
   * install is nothing at all — and yet `kilo models` still lists 288, because
   * the default `kilo` provider is a gateway onto everything. Grouping the
   * model ids is therefore the only listing that matches what can actually be
   * selected.
   */
  async providers(): Promise<ProviderChoice[]> {
    const counts = new Map<string, number>();
    for (const model of await allModels()) {
      const vendor = vendorOf(model.id);
      if (vendor) counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({
        id,
        label: id,
        description: `${count} model${count === 1 ? '' : 's'}`,
        configured: true,
      }));
  },

  journal,

  /**
   * A forked run rather than a look at the live session.
   *
   * `--fork` copies the conversation and continues the copy, which is the same
   * bargain Claude's `--fork-session` offers: the answer is written by an agent
   * that lived through the turn, and nothing it says becomes part of the
   * session being described. `run` rather than the TUI so it answers and exits.
   *
   * Unlike Claude's, the copy is a row in kilo's database rather than a file in
   * a directory doet can sweep — so `leavesFork` is false and the copy stays.
   * It is inert, it is listed under the same project, and `kilo session delete`
   * will remove it; doet reaching into another program's database to delete
   * rows it did not create is a worse trade than leaving a tidy one behind.
   */
  recap(request) {
    return {
      command: 'kilo',
      args: [
        'run',
        '--session', request.sessionId,
        '--fork',
        '--agent', 'ask',
        request.prompt,
      ],
      read: 'text',
      leavesFork: false,
    };
  },
};
