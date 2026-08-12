import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bus } from './bus.js';
import { claudeProjectDir } from './journal.js';
import type { AgentId } from './types.js';

/**
 * The one-line account of a turn, written by the agent that took it.
 *
 * doet used to pay a third agent to keep notes. That agent had none of the
 * context, so everything had to be described to it — the request, both replies,
 * the digest so far — and it still only knew what it had been told. It needed a
 * model of its own, config of its own, and it burned tokens on every exchange
 * re-reading a conversation it was not part of.
 *
 * This is the same job given to the one participant who already knows
 * everything. How it is asked differs by CLI, and not for want of trying to
 * make it uniform:
 *
 *   Claude  `--resume <id> --fork-session --print`, which is the whole idea
 *           working as intended. The question is put to a *branch* of the
 *           session, so it never becomes a turn the agent remembers taking, and
 *           the branch — a real file in ~/.claude/projects — is deleted the
 *           moment it answers. The fork sees everything: the files read, the
 *           commands run, not just the message that came out at the end.
 *
 *   Codex   cannot do this, and the failure is not subtle. Its conversations
 *           live in a thread store with one writer: resuming a live session by
 *           id is refused outright ("thread <id> already has an active writer"),
 *           which is the store protecting the pane's own session. Handing it a
 *           *copy* of the session's rollout file is accepted and useless — the
 *           rollout is a log, not a conversation, so the resumed agent starts
 *           empty and cheerfully summarises a session it has never had. That is
 *           not a hypothetical: a run's closing record came back as "a list of
 *           available but uninstalled plugins was provided". So for Codex the
 *           line is written by a fresh one-shot `codex exec` — same CLI, same
 *           model, no session to pollute — handed the text it just wrote.
 *
 * It is worth being plain about what that costs: Codex summarises its own
 * message, Claude summarises its own work. The Codex line is the weaker of the
 * two, and it is the best this CLI allows today.
 *
 * Either way the line is doet's to show and nobody else's: it goes to the
 * console and to the session record, and it is never handed to the other agent.
 * The next speaker reads the answer itself, in full — a summary of it, written
 * by the agent being reviewed, would be a worse copy of what it is already
 * being given.
 */

/** Long enough for a sentence, short enough not to stall a run. */
const RECAP_TIMEOUT_MS = 60_000;

/** One line means one row of the console, so it is cut to fit one. */
const MAX_LINE = 200;

/** The fork's file can land after its process exits, so the delete is retried. */
const FORK_TRIES = 5;
const FORK_WAIT_MS = 200;

export type RecapScope = 'exchange' | 'session';

/** What Claude is asked, in a fork that has already lived through the turn. */
function forkPrompt(scope: RecapScope): string {
  return scope === 'exchange'
    ? `In one sentence on a single line — under 25 words — say what you just did in this turn: what
you changed or concluded, and anything you are unsure of. Someone is watching this scroll past in
a console, so it must be one line: no line breaks, no preamble, no bullet, no heading, no restating
the request.`
    : `In at most six lines, summarise this whole session from the beginning: what was asked,
what was actually done, what is settled, and anything left open. This is the record of the
session, so write it as one — no preamble, no second person, and no mention of this request or
of how long the summary should be. Start with the work, not with what you were asked for.`;
}

/**
 * What Codex is asked, having been handed its own words and nothing else.
 *
 * Written in the first person on purpose: the line appears in the console under
 * the agent's own name, beside Claude's, and a note *about* Codex in among
 * notes *by* both of them reads as a third voice that is not there.
 */
function oneShotPrompt(scope: RecapScope, said: string): string {
  return scope === 'exchange'
    ? `Below is a message you have just sent in a working session. In one sentence on a single line —
under 25 words, first person — say what you did in it: what you changed or concluded, and anything
you are unsure of. No preamble, no bullet, no heading, no line breaks.

<message>
${said}
</message>`
    : `Below is a working session between you and another coding agent, in order. In at most six
lines, summarise it from the beginning: what was asked, what was actually done, what is settled,
and anything left open. This is the record of the session, so write it as one — no preamble, no
second person, no mention of this request.

<session>
${said}
</session>`;
}

/**
 * The argv that answers one question and exits.
 *
 * `lastMessage` is a path Codex is asked to write its final message to.
 * `codex exec` narrates itself on stdout — a banner, the model, its reasoning —
 * so stdout is a transcript rather than an answer, and squeezing that into one
 * line would print the banner instead of the summary. Claude's `--print` writes
 * the answer alone, so it needs nothing of the sort.
 */
function argv(opts: {
  agent: AgentId;
  sessionId: string;
  scope: RecapScope;
  said: string;
  lastMessage: string;
}): { command: string; args: string[] } {
  if (opts.agent === 'claude') {
    return {
      command: 'claude',
      args: [
        '--resume', opts.sessionId,
        // Branch the conversation rather than continuing it: this question is
        // doet's, and it must not become a turn the agent remembers taking.
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
        forkPrompt(opts.scope),
      ],
    };
  }
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
      // config override is the same setting by its real name. Not decoration: a
      // summariser nobody is watching must not be able to run anything, or ask.
      '-c', 'sandbox_mode="read-only"',
      '-c', 'approval_policy="never"',
      '--output-last-message', opts.lastMessage,
      oneShotPrompt(opts.scope, opts.said),
    ],
  };
}

/**
 * Asks one agent to recap, and cleans up after itself.
 *
 * Never throws and never blocks a run: a recap is a nicety, and a session that
 * stalled because its note-taker did is a bad trade. Failures come back as
 * null and are logged, not raised.
 */
export async function recap(opts: {
  bus: Bus;
  agent: AgentId;
  sessionId: string;
  cwd: string;
  scope: RecapScope;
  /** What the agent wrote. Only Codex needs it — Claude's fork was there. */
  said?: string;
}): Promise<string | null> {
  const { bus, agent, sessionId, cwd, scope } = opts;
  const said = (opts.said ?? '').trim();
  if (agent === 'codex' && !said) return null;

  // Claude's fork is a real session on disk. Note what is there first so the
  // copy can be removed afterwards rather than left behind for every exchange
  // of every run.
  const before = agent === 'claude' ? listSessions(cwd) : new Set<string>();
  const scratch = agent === 'codex' ? mkdtempSync(join(tmpdir(), 'doet-recap-')) : null;
  const lastMessage = scratch ? join(scratch, 'message.txt') : '';
  const { command, args } = argv({ agent, sessionId, scope, said, lastMessage });

  let fork: string | undefined;
  try {
    const text = await new Promise<string>((resolve) => {
      const child = execFile(
        command,
        args,
        { cwd, timeout: RECAP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error && !stdout.trim()) {
            bus.log(agent, `Could not summarise: ${error.message}`, 'warn');
            resolve('');
            return;
          }
          if (agent === 'claude') {
            const answer = readClaudeResult(stdout);
            // The id first: a run that failed still forked, and the copy has to
            // go whether or not there is anything to show for it.
            fork = answer.session;
            if (answer.failed) {
              bus.log(agent, `Could not summarise: ${answer.text || 'the CLI reported an error'}`, 'warn');
              resolve('');
              return;
            }
            resolve(answer.text);
            return;
          }
          // Codex's own file first; its stdout is the fallback, and only
          // because an answer buried in narration still beats no answer.
          resolve(readLastMessage(lastMessage) || stdout.trim());
        },
      );
      // Nothing is being sent, so say so by closing it. Both CLIs read stdin
      // for a prompt even when given one on the command line: Claude waits
      // three seconds and says so ("no stdin data received in 3s, proceeding
      // without it"), Codex waits for as long as you let it — which out here
      // looks like a summariser that always times out, because it always does.
      child.stdin?.end();
    });
    const tidied = scope === 'exchange' ? oneLine(text) : text.trim();
    return tidied || null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (agent === 'claude') await discardFork(cwd, fork, before, bus);
  }
}

/**
 * The answer, and the throwaway session it was written in.
 *
 * Falls back to the raw text if the JSON is not what this expects, because a
 * summary that arrives in an unfamiliar wrapper is still a summary; only the
 * cleanup suffers, and that has a sweep behind it.
 */
function readClaudeResult(stdout: string): { text: string; session?: string; failed?: boolean } {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as { result?: unknown; session_id?: unknown; is_error?: unknown };
      return {
        text: typeof record.result === 'string' ? record.result.trim() : stdout.trim(),
        session: typeof record.session_id === 'string' ? record.session_id : undefined,
        // `is_error` is how `--print` reports a refusal or a failed turn; the
        // exit code is 0 either way, so `result` would otherwise be shown as
        // though the agent had written it about its work.
        failed: record.is_error === true,
      };
    }
  } catch {
    // Not JSON — an older CLI, or an error printed plainly.
  }
  return { text: stdout.trim() };
}

function readLastMessage(path: string): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * One line, whatever came back.
 *
 * The prompt asks for a single sentence and usually gets one, but a model that
 * adds a heading or a bullet must not be allowed to take three rows of a pane
 * that is only a dozen rows tall to begin with.
 */
function oneLine(text: string): string {
  const line = text
    .replace(/\s+/g, ' ')
    .replace(/^(?:[-*•>]+\s*)+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
  if (line.length <= MAX_LINE) return line;
  const cut = line.slice(0, MAX_LINE);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_LINE * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function listSessions(cwd: string): Set<string> {
  try {
    return new Set(readdirSync(claudeProjectDir(cwd)).filter((name) => name.endsWith('.jsonl')));
  } catch {
    return new Set<string>();
  }
}

/**
 * Removes the copy the fork left behind.
 *
 * Retried, because the file is not reliably there when the process that writes
 * it exits: a run that deleted nothing and reported success left a 12KB copy of
 * a session sitting in `~/.claude/projects` — once per exchange, per run, for
 * as long as you use doet.
 *
 * By id when the CLI told us one. The sweep behind it — anything that appeared
 * while the recap ran — is only for the case where it did not, and is
 * deliberately the fallback: in co-code both agents share this directory, so a
 * blind sweep can catch a session that belongs to somebody still using it.
 */
async function discardFork(
  cwd: string,
  fork: string | undefined,
  before: Set<string>,
  bus: Bus,
): Promise<void> {
  const dir = claudeProjectDir(cwd);
  for (let attempt = 0; attempt < FORK_TRIES; attempt++) {
    if (removeFork(dir, fork, before)) return;
    await new Promise((resolve) => setTimeout(resolve, FORK_WAIT_MS));
  }
  // Only worth saying when we know exactly which file is left over; without an
  // id, "nothing was removed" most likely means nothing was written.
  if (fork) bus.log('doet', `A summary fork was left in ${dir}.`, 'warn');
}

function removeFork(dir: string, fork: string | undefined, before: Set<string>): boolean {
  try {
    if (fork) {
      const path = join(dir, `${fork}.jsonl`);
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    }
    let removed = false;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl') || before.has(name)) continue;
      rmSync(join(dir, name), { force: true });
      removed = true;
    }
    return removed;
  } catch {
    return false;
  }
}
