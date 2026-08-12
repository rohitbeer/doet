import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentId, Usage } from './types.js';

/**
 * Reading what an agent did, from the transcript its own CLI writes.
 *
 * With the agents running as real terminal programs (see `tmux.ts`), doet no
 * longer receives protocol events telling it when a turn ended or what it cost.
 * It does not need to read the screen to find out: both CLIs already persist a
 * complete, structured record of every session as line-delimited JSON, and that
 * record is strictly richer than what they draw.
 *
 *   Claude  ~/.claude/projects/<slug>/<session-id>.jsonl
 *   Codex   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl
 *
 * The trade is deliberate and worth stating plainly, because it is the main
 * cost of this design: these files are internal to their CLIs, not published
 * interfaces, and their shape can change in any release. That is not
 * hypothetical — Codex wrote the final assistant message as an `agent_message`
 * event in transcripts from one day and as a `response_item` with `output_text`
 * content the next, on the same machine. So every reader below takes the union
 * of the shapes it has seen rather than the newest one, and anything it cannot
 * parse is skipped rather than guessed at. A turn doet cannot read is reported
 * as unknown; it is never invented.
 */

// ---------------------------------------------------------------------------
// Where the transcripts live
// ---------------------------------------------------------------------------

export const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
export const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

/**
 * Claude names a project directory after the working tree, with every character
 * that is not a letter, digit or dash replaced by a dash.
 *
 * Derived rather than searched because two worktrees of one repository differ
 * only in their path, and a VS run has both open at once — picking the wrong
 * directory would attribute one slot's work to the other.
 */
export function claudeProjectDir(cwd: string): string {
  return join(CLAUDE_PROJECTS, realPath(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * The path with symlinks resolved, because the CLI files its transcript under
 * the real one.
 *
 * `resolve()` is not enough and the difference is not cosmetic: on macOS
 * `os.tmpdir()` hands back `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Claude writes to a directory named after the
 * latter, so a slug built from the former points at a directory that never
 * appears and doet waits out its whole timeout for a transcript that is
 * already there under a different name.
 */
function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    // The directory may not exist yet — a worktree about to be created. The
    // unresolved path is the best available answer and is usually identical.
    return resolve(path);
  }
}

/** Every `.jsonl` in a directory, with the time it last changed. */
function transcripts(dir: string): Array<{ path: string; mtimeMs: number }> {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null);
  } catch {
    return [];
  }
}

/** Codex buckets by date, so its files need a walk rather than a listing. */
function codexTranscripts(): Array<{ path: string; mtimeMs: number }> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(path, depth + 1);
      else if (entry.endsWith('.jsonl')) found.push({ path, mtimeMs: info.mtimeMs });
    }
  };
  walk(CODEX_SESSIONS, 0);
  return found;
}

/**
 * The transcript a CLI opened after `since`, waiting for it to appear.
 *
 * Neither CLI creates its transcript at launch — it appears when the first turn
 * starts, which is also the first moment a session id exists. So doet cannot
 * ask "which session is this pane?" up front; it launches, sends the first
 * prompt, and then finds the file that was not there before.
 *
 * Claude's is looked up by working tree, which is exact. Codex writes every
 * session to one dated tree, so its file is identified by being new — hence
 * `since`, captured immediately before the pane was started.
 */
/**
 * Every transcript this agent has already written, before doet starts a new one.
 *
 * Taken immediately before a pane is launched and handed back to
 * `awaitTranscript` as `known`, so "the session doet just started" means a file
 * that did not exist a moment ago rather than whichever file happens to be
 * newest. Codex needs this badly: it files every session on the planet under
 * one dated tree, so without a before-picture the newest-since rule can pick a
 * session belonging to another window entirely — and doet then waits forever
 * for a turn to appear in a file nothing is writing to.
 */
export function existingTranscripts(agent: AgentId, cwd: string): Set<string> {
  const found = agent === 'claude' ? transcripts(claudeProjectDir(cwd)) : codexTranscripts();
  return new Set(found.map((entry) => entry.path));
}

export async function awaitTranscript(
  agent: AgentId,
  cwd: string,
  since: number,
  opts: { timeoutMs?: number; known?: Set<string> } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const known = opts.known ?? new Set<string>();

  while (Date.now() < deadline) {
    const candidates = (agent === 'claude' ? transcripts(claudeProjectDir(cwd)) : codexTranscripts())
      .filter((entry) => !known.has(entry.path))
      // A second of slack: the file is created around the moment doet stamps
      // `since`, and filesystem timestamps are not that precise.
      .filter((entry) => entry.mtimeMs >= since - 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    // For Codex the newest new file is the only signal available, so confirm it
    // really is a session rather than something half-written.
    for (const candidate of candidates) {
      if (agent === 'claude' || readSessionId(candidate.path) !== null) return candidate.path;
    }
    await delay(250);
  }
  return null;
}

/** Codex stamps its own session id inside the file; Claude uses the filename. */
function readSessionId(path: string): string | null {
  for (const record of records(path)) {
    if (record.type !== 'session_meta') continue;
    const payload = asRecord(record.payload);
    const id = payload.id ?? payload.session_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export function sessionIdFor(agent: AgentId, path: string): string | null {
  if (agent === 'codex') return readSessionId(path);
  const name = path.split('/').pop() ?? '';
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
}

// ---------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------

/** What doet needs out of a transcript, in the vocabulary the rest of it uses. */
export interface JournalState {
  /** Turns whose end has been seen, oldest first. */
  turns: Array<{ text: string; at: number }>;
  /** True while the newest turn is still open. */
  working: boolean;
  usage: Usage;
  sessionId: string | null;
  /** Records read so far, so an unchanged file can be skipped. */
  size: number;
}

interface RawRecord {
  type?: string;
  payload?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function* records(path: string): Generator<RawRecord> {
  let text: string;
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RawRecord;
    } catch {
      // A record still being written. It will be complete on the next read.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(content: unknown, wanted: string[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asRecord(block);
      return wanted.includes(String(b.type)) && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('');
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Claude's transcript.
 *
 * A turn is over when an `assistant` record carries a `stop_reason` that is not
 * `tool_use` — `tool_use` means the CLI is about to run something and come
 * back, which is mid-turn. Usage accumulates across the session's assistant
 * records the same way the adapter used to accumulate it across `result`s.
 */
function readClaude(path: string): JournalState {
  const state: JournalState = {
    turns: [],
    working: false,
    usage: {},
    sessionId: sessionIdFor('claude', path),
    size: 0,
  };
  let pending = '';
  const at = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return Date.now();
    }
  })();

  for (const record of records(path)) {
    state.size += 1;
    if (record.type !== 'assistant') continue;
    const message = asRecord(record.message);
    pending += textOf(message.content, ['text']);

    const usage = asRecord(message.usage);
    state.usage = {
      inputTokens: (state.usage.inputTokens ?? 0) + (positive(usage.input_tokens) ?? 0),
      outputTokens: (state.usage.outputTokens ?? 0) + (positive(usage.output_tokens) ?? 0),
      cachedTokens: (state.usage.cachedTokens ?? 0) + (positive(usage.cache_read_input_tokens) ?? 0),
    };
    state.usage.totalTokens =
      (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0);

    const stop = message.stop_reason;
    if (typeof stop === 'string' && stop && stop !== 'tool_use') {
      state.turns.push({ text: pending.trim(), at });
      pending = '';
    }
  }

  // Text with no terminator yet is a turn still being written.
  state.working = pending.trim().length > 0;
  return state;
}

/**
 * Codex's rollout.
 *
 * `task_started` / `task_complete` bracket a turn outright, which is the
 * cleanest boundary either CLI offers. The assistant's words are taken from
 * `response_item` records with an assistant role, and from `agent_message`
 * events — both shapes are accepted because both are produced, by versions of
 * Codex close enough together to appear in one week's transcripts.
 */
function readCodex(path: string): JournalState {
  const state: JournalState = {
    turns: [],
    working: false,
    usage: {},
    sessionId: null,
    size: 0,
  };
  let pending = '';
  let open = false;
  const at = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return Date.now();
    }
  })();

  for (const record of records(path)) {
    state.size += 1;
    const payload = asRecord(record.payload);
    const kind = String(payload.type ?? '');

    if (record.type === 'session_meta') {
      const id = payload.id ?? payload.session_id;
      if (typeof id === 'string') state.sessionId = id;
      continue;
    }

    if (kind === 'task_started') {
      open = true;
      pending = '';
      continue;
    }

    if (kind === 'agent_message' && typeof payload.message === 'string') {
      pending += payload.message;
      continue;
    }

    if (record.type === 'response_item' && payload.role === 'assistant') {
      pending += textOf(payload.content, ['output_text', 'text']);
      continue;
    }

    if (kind === 'token_count') {
      const info = asRecord(payload.info);
      const total = asRecord(info.total_token_usage);
      state.usage = {
        inputTokens: positive(total.input_tokens),
        outputTokens: positive(total.output_tokens),
        cachedTokens: positive(total.cached_input_tokens),
        totalTokens: positive(total.total_tokens),
      };
      continue;
    }

    if (kind === 'task_complete') {
      state.turns.push({ text: pending.trim(), at });
      pending = '';
      open = false;
    }
  }

  state.working = open;
  return state;
}

export function readJournal(agent: AgentId, path: string): JournalState {
  return agent === 'claude' ? readClaude(path) : readCodex(path);
}

/**
 * Watches a transcript until it records one more finished turn than it had.
 *
 * Polling rather than `fs.watch`: these files are appended to by another
 * process, `fs.watch` reports directory-level churn unreliably across
 * platforms, and the interval only has to beat a human's patience. The cost of
 * being a beat late is nothing; the cost of being early would be reading half a
 * turn, which is why the terminators above are what is waited on rather than a
 * quiet period.
 */
export async function awaitTurn(
  agent: AgentId,
  path: string,
  opts: {
    after: number;
    timeoutMs?: number;
    cancelled?: () => boolean;
    /**
     * Asked each time the transcript has not grown. Returning true ends the
     * wait as if the turn had been abandoned — which is what an interrupt the
     * user performed in the agent's own pane looks like from out here.
     */
    stalled?: (quietMs: number) => boolean | Promise<boolean>;
  },
): Promise<JournalState | null> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let changedAt = Date.now();

  while (Date.now() < deadline) {
    if (opts.cancelled?.()) return null;
    const state = readJournal(agent, path);
    if (state.turns.length > opts.after) return state;

    if (state.size !== lastSize) {
      lastSize = state.size;
      changedAt = Date.now();
    } else if (opts.stalled && (await opts.stalled(Date.now() - changedAt))) {
      return null;
    }
    await delay(400);
  }
  return null;
}

/**
 * Not unref'd, and for the same reason as in `tmux.ts`: this timer is the poll
 * interval, so it is the only thing pending while doet waits for an agent to
 * finish. Unref'ing it would let the process exit mid-turn.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
