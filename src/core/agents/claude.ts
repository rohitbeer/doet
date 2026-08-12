import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '../types.js';
import {
  asRecord,
  changedAt,
  fileJournal,
  positive,
  realPath,
  records,
  textOf,
  transcriptsIn,
} from './file-journal.js';
import type { CliDefinition, JournalState, LaunchContext } from './types.js';

export const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

/**
 * Claude names a project directory after the working tree, with every character
 * that is not a letter, digit or dash replaced by a dash.
 *
 * Derived rather than searched because two worktrees of one repository differ
 * only in their path, and a VS run has several open at once — picking the wrong
 * directory would attribute one slot's work to another's.
 */
export function claudeProjectDir(cwd: string): string {
  return join(CLAUDE_PROJECTS, realPath(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Claude's transcript.
 *
 * A turn is over when an `assistant` record carries a `stop_reason` that is not
 * `tool_use` — `tool_use` means the CLI is about to run something and come
 * back, which is mid-turn. Usage accumulates across the session's assistant
 * records.
 */
function parse(path: string): JournalState {
  const state: JournalState = {
    turns: [],
    working: false,
    usage: {},
    sessionId: sessionIdOf(path),
    size: 0,
  };
  let pending = '';
  const at = changedAt(path);

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
    state.usage.totalTokens = (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0);

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

/** Claude puts the session id in the filename. */
function sessionIdOf(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
}

export const claude: CliDefinition = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  colour: 'magenta',

  supports: {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    provider: false,
    systemPrompt: 'append',
    addDirs: true,
    turnEnd: 'journal',
    fork: true,
  },

  launch(context: LaunchContext): string[] {
    const args: string[] = [];
    if (context.resume) args.push('--resume', context.resume);
    if (context.model) args.push('--model', context.model);
    if (context.effort && context.effort !== 'none') args.push('--effort', context.effort);
    args.push('--permission-mode', context.autonomy === 'ask' ? 'default' : 'acceptEdits');
    for (const dir of context.addDirs) args.push('--add-dir', dir);
    if (context.instructions) args.push('--append-system-prompt', context.instructions);
    return args;
  },

  /**
   * A branch of the session rather than a second client on it.
   *
   * This is the whole idea working as intended: the copy sees everything the
   * original saw — the files read, the commands run — and nothing done in it
   * becomes a turn the original remembers taking.
   */
  fork(sessionId: string) {
    return { command: 'claude', args: ['--resume', sessionId, '--fork-session'] };
  },

  /**
   * Empty, and that is the honest answer.
   *
   * Claude does not publish its model list to the command line, and model
   * availability varies by plan, so a list invented here would be wrong for
   * somebody. doet passes whatever id it is given straight to `--model`; if it
   * is wrong the CLI says so in its own pane, which is a better error than any
   * doet could produce from a list it could not verify.
   */
  async models(): Promise<ModelChoice[]> {
    return [];
  },

  async providers() {
    return [];
  },

  journal: fileJournal({
    list: (cwd) => transcriptsIn(claudeProjectDir(cwd)),
    parse,
    idOf: sessionIdOf,
  }),

  /**
   * The recap working exactly as intended: the question goes to a *branch* of
   * the session, so it never becomes a turn the agent remembers taking, and the
   * branch sees everything — the files read, the commands run, not just the
   * message that came out at the end.
   */
  recap(request) {
    return {
      command: 'claude',
      args: [
        '--resume', request.sessionId,
        '--fork-session',
        '--print',
        // Reading its own transcript needs no tools, and a summariser that
        // could run commands is a summariser that can raise a prompt nobody is
        // watching for.
        '--permission-mode', 'plan',
        '--disallowed-tools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task',
        // Asking for JSON is what makes the fork disposable rather than merely
        // findable: the answer comes back with the id of the session it was
        // written in, so the copy is deleted by name instead of by guessing
        // which file appeared while doet was not looking.
        '--output-format', 'json',
        // `--disallowed-tools <tools...>` is variadic, so without this it eats
        // the prompt: every word of it is read as another tool to deny, the
        // prompt arrives empty, and Claude sits waiting on stdin for one. It
        // fails as "Permission deny rule \"heading\" matches no known tool",
        // which does not sound like the prompt going missing, but is.
        '--',
        request.prompt,
      ],
      read: 'json',
      leavesFork: true,
    };
  },
};
