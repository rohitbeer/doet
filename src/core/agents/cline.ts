import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelChoice } from '../types.js';
import { realPath } from './file-journal.js';
import { json, num, query, quote, stamp, text, type SqlSource } from './sqlite.js';
import type { CliDefinition, JournalReader, JournalState, LaunchContext, ProviderChoice } from './types.js';

const run = promisify(execFile);

/**
 * cline.
 *
 * The most awkward of the four to read, and worth being plain about why rather
 * than papering over it.
 *
 * cline keeps an index of sessions in SQLite — `~/.cline/data/db/sessions.db`,
 * one row per session with `cwd`, `status`, `model` and, usefully, a
 * `messages_path` pointing at where that session's messages actually live. The
 * index is verified: doet reads its schema directly. What is *inside*
 * `messages_path` is not, because a session cannot be created without
 * credentials, so the reader below is written from cline's own documented
 * `--json` vocabulary — `type`, `say`/`ask`, `text`, `ts`, `partial` — and
 * takes the union of the plausible shapes rather than betting on one.
 *
 * That is why cline is the one agent whose turns doet will also end on a quiet
 * pane (`turnEnd: 'journal-or-quiet'`). If the message file parses, doet knows
 * exactly when the turn ended and roughly what it cost. If it does not, the run
 * still works: the turn ends when cline stops moving, and the scoreboard says
 * `–` for tokens rather than inventing a number. Nothing silently hangs.
 */

/** cline's own `--data-dir`, as an environment variable so the reader follows it. */
const CLINE_DATA = process.env.CLINE_DATA_DIR || join(homedir(), '.cline', 'data');

const source: SqlSource = {
  path: join(CLINE_DATA, 'db', 'sessions.db'),
  // No fallback: `cline history --json` lists sessions but will not run a
  // query, so there is no second way to ask this. On a runtime without
  // `node:sqlite` the journal simply finds nothing and the quiet-pane backstop
  // carries the run.
};

/** Slower than kilo's: every read also touches a file, and cline is chattier. */
const POLL_MS = 1000;

interface SessionRow {
  session_id: unknown;
  cwd: unknown;
  status: unknown;
  started_at: unknown;
  updated_at: unknown;
  ended_at: unknown;
  model: unknown;
  messages_path: unknown;
  transcript_path: unknown;
}

const COLUMNS =
  'session_id, cwd, status, started_at, updated_at, ended_at, model, messages_path, transcript_path';

function sessionsIn(cwd: string): Promise<SessionRow[]> {
  const real = realPath(cwd);
  const where = real === cwd ? `cwd = ${quote(cwd)}` : `cwd in (${quote(cwd)}, ${quote(real)})`;
  return query<SessionRow>(
    source,
    `select ${COLUMNS} from sessions where ${where} order by started_at desc limit 50`,
  );
}

/**
 * cline's messages, however it chose to write them.
 *
 * JSON array or one object per line — both are accepted, because the column is
 * a path rather than a format and doet has not seen a populated one.
 */
function readMessages(path: string): Array<Record<string, unknown>> {
  if (!path || !existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((entry) => json(entry));
    } catch {
      // A file mid-write. The next poll gets it whole.
    }
    return [];
  }

  const messages: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split('\n')) {
    const body = line.trim();
    if (!body) continue;
    try {
      messages.push(json(JSON.parse(body)));
    } catch {
      // Same again — a partially written record.
    }
  }
  return messages;
}

/**
 * Whether an entry closes a turn.
 *
 * `completion_result` is cline's own marker for "the task is finished", and it
 * appears both as something cline says and as something it asks (the variant
 * that offers you a follow-up). Either way the work has stopped, which is the
 * only question being asked here.
 */
function closesTurn(entry: Record<string, unknown>): boolean {
  return text(entry.say) === 'completion_result' || text(entry.ask) === 'completion_result';
}

const journal: JournalReader = {
  pollMs: POLL_MS,

  async known(cwd: string): Promise<Set<string>> {
    return new Set((await sessionsIn(cwd)).map((row) => text(row.session_id)).filter(Boolean));
  },

  async find(cwd: string, since: number, known: Set<string>): Promise<string | null> {
    for (const row of await sessionsIn(cwd)) {
      const id = text(row.session_id);
      if (!id || known.has(id)) continue;
      const started = stamp(row.started_at);
      if (started != null && started < since - 1000) continue;
      return id;
    }
    return null;
  },

  async sessionId(handle: string): Promise<string | null> {
    return handle || null;
  },

  async read(handle: string): Promise<JournalState> {
    const rows = await query<SessionRow>(
      source,
      `select ${COLUMNS} from sessions where session_id = ${quote(handle)}`,
    );
    const state: JournalState = {
      turns: [],
      working: false,
      usage: {},
      sessionId: handle,
      size: 0,
    };

    const row = rows[0];
    if (!row) return state;

    const updated = stamp(row.updated_at);
    if (updated != null) state.size += Math.floor(updated / 1000);

    const messages = readMessages(text(row.messages_path) || text(row.transcript_path));
    state.size += messages.length;

    let pending = '';
    let usage: JournalState['usage'] = {};
    for (const entry of messages) {
      // A partial is cline mid-sentence, re-emitted whole on the next entry.
      // Counting it would double every streamed message.
      if (entry.partial === true) continue;

      // `api_req_started` carries the accounting for the request it opens, as a
      // JSON string in `text` rather than as fields of its own.
      if (text(entry.say) === 'api_req_started') {
        const info = json(entry.text);
        const input = num(info.tokensIn) ?? usage.inputTokens;
        const output = num(info.tokensOut) ?? usage.outputTokens;
        const cached = num(info.cacheReads) ?? usage.cachedTokens;
        const cost = num(info.cost);
        usage = {
          inputTokens: input,
          outputTokens: output,
          cachedTokens: cached,
          totalTokens: (input ?? 0) + (output ?? 0),
          ...(cost != null && cost > 0 ? { costUsd: cost } : {}),
        };
        continue;
      }

      const say = text(entry.say);
      if (say === 'text' || say === 'completion_result') {
        const body = text(entry.text);
        if (body) pending += (pending ? '\n\n' : '') + body;
      }

      if (closesTurn(entry)) {
        state.turns.push({ text: pending.trim(), at: stamp(entry.ts) ?? Date.now() });
        pending = '';
      }
    }

    state.usage = usage;
    // Words with no completion marker after them are a turn still being
    // written. So is a session cline has not marked finished.
    state.working = pending.trim().length > 0 || text(row.status) === 'running';
    return state;
  },
};

/**
 * Providers cline has credentials for.
 *
 * Read from its settings file rather than asked of the CLI, because `cline
 * auth` is an interactive configuration screen rather than a listing — running
 * it to find out what is configured would open a form in a pane nobody is
 * looking at.
 */
async function listProviders(): Promise<ProviderChoice[]> {
  try {
    const raw = readFileSync(join(CLINE_DATA, 'settings', 'providers.json'), 'utf8');
    const parsed = json(raw);
    const providers = json(parsed.providers);
    const last = text(parsed.lastUsedProvider);
    return Object.keys(providers)
      .map((id) => {
        const settings = json(json(providers[id]).settings);
        const model = text(settings.model);
        return {
          id,
          label: id,
          description: model ? `configured · ${model}` : 'configured',
          configured: true,
          last: id === last,
        };
      })
      // Whatever was used last goes first, since it is the one you probably
      // want again.
      .sort((a, b) => Number(b.last) - Number(a.last) || a.id.localeCompare(b.id))
      .map(({ last: _last, ...choice }) => choice);
  } catch {
    return [];
  }
}

/**
 * cline does not list models for a provider on the command line, so the only
 * one doet can name is the one already configured for it.
 *
 * Returned as a single choice rather than an empty list, because "the model
 * your provider is set to" is a genuinely useful default and an empty picker
 * would make it look as though there were none.
 */
async function listModels(provider?: string): Promise<ModelChoice[]> {
  try {
    const raw = readFileSync(join(CLINE_DATA, 'settings', 'providers.json'), 'utf8');
    const providers = json(json(raw).providers);
    const wanted = provider ? [provider] : Object.keys(providers);
    const models: ModelChoice[] = [];
    for (const id of wanted) {
      const settings = json(json(providers[id]).settings);
      const model = text(settings.model);
      if (model && !models.some((choice) => choice.id === model)) {
        models.push({ id: model, label: model, description: `${id}'s configured model` });
      }
    }
    return models;
  } catch {
    return [];
  }
}

export const cline: CliDefinition = {
  id: 'cline',
  label: 'Cline',
  command: 'cline',
  colour: 'yellow',

  supports: {
    // cline's dial has no `max`, and its `none` is a real setting rather than
    // the absence of one — it means "leave the provider's default alone".
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    provider: true,
    // `-s` *replaces* cline's system prompt rather than adding to it, and that
    // prompt is most of what makes cline work. doet will not overwrite it, so
    // its brief rides in front of the first request instead.
    systemPrompt: 'prompt',
    addDirs: false,
    // The one agent whose turn boundary doet infers rather than reads. See the
    // note at the top of this file: if the message file parses, the journal is
    // authoritative; if it does not, a still session and a still screen end the
    // turn rather than hanging the slot for ever.
    turnEnd: 'journal-or-quiet',
    // `--id` resumes a session; there is no flag that copies one. So doet can
    // reopen a cline session but not look at it while it is being worked in.
    fork: false,
  },

  launch(context: LaunchContext): string[] {
    // Interactive is opt-in for cline: bare `cline` runs the prompt and exits,
    // which in a doet pane would be an agent that vanishes after one turn.
    const args: string[] = ['--tui'];
    if (context.resume) args.push('--id', context.resume);
    args.push('--cwd', context.cwd);
    if (context.provider) args.push('--provider', context.provider);
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('--thinking', context.effort);
    args.push('--auto-approve', context.autonomy === 'ask' ? 'false' : 'true');
    return args;
  },

  fork() {
    return null;
  },

  models: listModels,
  providers: listProviders,

  journal,

  /**
   * Null, for the same reason Codex's is.
   *
   * cline can resume a session by id but cannot copy one, so the only way to
   * ask it about its own work would be to open the session the pane is still
   * working in — two clients on one conversation. A one-shot handed a copy of
   * its own words is the other option, and that is a summary of a message
   * rather than of the work, written by an agent starting from nothing.
   *
   * doet would rather say nothing. The recap is a nicety; a fabricated one is
   * not.
   */
  recap() {
    return null;
  },
};

/** Kept for the doctor-style check: is this CLI actually usable here? */
export async function clineVersion(): Promise<string | null> {
  try {
    const { stdout } = await run('cline', ['--version'], { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
