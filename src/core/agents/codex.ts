import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '../types.js';
import {
  asRecord,
  changedAt,
  fileJournal,
  positive,
  records,
  textOf,
  transcriptsUnder,
} from './file-journal.js';
import type { CliDefinition, JournalState, LaunchContext } from './types.js';

export const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

/**
 * Codex's rollout.
 *
 * `task_started` / `task_complete` bracket a turn outright, which is the
 * cleanest boundary any of the four CLIs offers. The assistant's words are
 * taken from `response_item` records with an assistant role, and from
 * `agent_message` events — both shapes are accepted because both are produced,
 * by versions of Codex close enough together to appear in one week's
 * transcripts.
 */
function parse(path: string): JournalState {
  const state: JournalState = {
    turns: [],
    working: false,
    usage: {},
    sessionId: null,
    size: 0,
  };
  let pending = '';
  let open = false;
  const at = changedAt(path);

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

/** Codex stamps its own session id inside the file rather than in its name. */
function sessionIdOf(path: string): string | null {
  for (const record of records(path)) {
    if (record.type !== 'session_meta') continue;
    const payload = asRecord(record.payload);
    const id = payload.id ?? payload.session_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export const codex: CliDefinition = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  colour: 'cyan',

  supports: {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    provider: false,
    systemPrompt: 'prompt',
    addDirs: true,
    turnEnd: 'journal',
    fork: false,
  },

  launch(context: LaunchContext): string[] {
    const args: string[] = [];
    if (context.resume) args.push('resume', context.resume);
    if (context.model) args.push('--model', context.model);
    // Codex takes reasoning effort as a config override rather than a flag.
    if (context.effort && context.effort !== 'none') {
      args.push('-c', `model_reasoning_effort="${context.effort}"`);
    }
    args.push('--ask-for-approval', context.autonomy === 'ask' ? 'untrusted' : 'on-request');
    // Forced up to `workspace-write` when there are extra roots, because Codex
    // rejects them outright otherwise and takes the whole pane down with it.
    args.push('--sandbox', 'workspace-write');
    for (const dir of context.addDirs) args.push('--add-dir', dir);
    return args;
  },

  /**
   * Null, and not for want of trying.
   *
   * Codex's conversations live in a thread store with one writer: resuming a
   * live session by id is refused outright ("thread <id> already has an active
   * writer"), which is the store protecting the pane's own session. Handing it a
   * *copy* of the rollout is accepted and useless — the rollout is a log, not a
   * conversation, so the resumed agent starts empty and cheerfully summarises a
   * session it has never had.
   */
  fork() {
    return null;
  },

  async models(): Promise<ModelChoice[]> {
    return [];
  },

  async providers() {
    return [];
  },

  journal: fileJournal({
    // Codex writes every session on the machine to one dated tree, so its file
    // cannot be found by working tree the way Claude's can — it is identified
    // by being new, which is what `known` and `since` are for.
    list: () => transcriptsUnder(CODEX_SESSIONS),
    parse,
    idOf: sessionIdOf,
    // The newest new file is the only signal available, so confirm it really is
    // a session rather than something half-written.
    confirm: (path) => sessionIdOf(path) !== null,
  }),

  /**
   * A fresh one-shot rather than a look at the session, because Codex will not
   * give doet a look at the session — see `fork`.
   *
   * It is worth being plain about what that costs: Claude summarises its own
   * *work*, Codex summarises its own *message*. The Codex line is the weaker of
   * the two, and it is the best this CLI allows today.
   */
  recap(request) {
    return {
      command: 'codex',
      args: [
        'exec',
        // No session on disk and none in the thread store: this is one question
        // about text doet already has, and it must leave nothing behind that a
        // later `resume` could walk into.
        '--ephemeral',
        '--skip-git-repo-check',
        // `codex exec` takes `--sandbox`, `codex exec resume` does not, and the
        // config override is the same setting by its real name. Not decoration:
        // a summariser nobody is watching must not be able to run anything, or
        // ask.
        '-c', 'sandbox_mode="read-only"',
        '-c', 'approval_policy="never"',
        // `codex exec` narrates itself on stdout — a banner, the model, its
        // reasoning — so stdout is a transcript rather than an answer, and
        // squeezing that into one line would print the banner instead of the
        // summary.
        '--output-last-message', request.lastMessagePath,
        request.prompt,
      ],
      read: 'file',
      leavesFork: false,
    };
  },
};
