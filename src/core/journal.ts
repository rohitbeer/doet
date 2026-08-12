import type { JournalReader, JournalState } from './agents/types.js';

export type { JournalState } from './agents/types.js';

/**
 * Waiting on an agent, whoever it is.
 *
 * This file used to contain the readers themselves — one for Claude's
 * transcript, one for Codex's rollout, and the directory-walking to find them.
 * They live beside their CLIs now, in `core/agents/`, because two of the four
 * agents doet drives do not write a transcript at all and "read the file" had
 * stopped being a shared idea.
 *
 * What is genuinely shared is the *waiting*: doet asks the same two questions
 * of every agent — has a session appeared, and has a turn finished — and the
 * answers arrive the same way regardless of whether the reader tailed a file or
 * asked a database. So that is all that is left here, written against
 * `JournalReader` and knowing nothing about any particular CLI.
 */

/**
 * The session a CLI opened after `since`, waiting for it to appear.
 *
 * None of the four create a session at launch — it appears when the first turn
 * starts, which is also the first moment a session id exists. So doet cannot
 * ask "which session is this pane?" up front; it launches, sends the first
 * prompt, and then finds the one that was not there before.
 */
export async function awaitSession(
  reader: JournalReader,
  cwd: string,
  since: number,
  opts: { timeoutMs?: number; known?: Set<string>; cancelled?: () => boolean } = {},
): Promise<string | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const known = opts.known ?? new Set<string>();

  while (Date.now() < deadline) {
    if (opts.cancelled?.()) return null;
    const found = await reader.find(cwd, since, known);
    if (found) return found;
    await delay(reader.pollMs);
  }
  return null;
}

/**
 * Watches a session until it records one more finished turn than it had.
 *
 * Polling rather than watching for a change: these sessions are written by
 * another process, `fs.watch` reports directory-level churn unreliably across
 * platforms, half the readers are database queries with nothing to watch at
 * all, and the interval only has to beat a human's patience. The cost of being
 * a beat late is nothing; the cost of being early would be reading half a turn,
 * which is why a recorded boundary is what is waited on rather than a quiet
 * period.
 *
 * The interval is the reader's, not this function's. Tailing a file is free and
 * happens four times a second; asking a CLI costs a process launch and happens
 * about once. Sleeping *after* the read rather than on a fixed schedule is what
 * keeps a slow reader from queueing work up behind itself.
 */
export async function awaitTurn(
  reader: JournalReader,
  handle: string,
  opts: {
    after: number;
    timeoutMs?: number;
    cancelled?: () => boolean;
    /**
     * Asked each time the session has not changed. Returning true ends the wait
     * as if the turn had been abandoned — which is what an interrupt the user
     * performed in the agent's own pane looks like from out here, and what a
     * finished turn looks like for an agent whose journal records no boundary.
     */
    stalled?: (quietMs: number) => boolean | Promise<boolean>;
  },
): Promise<JournalState | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  let lastSize = -1;
  let changedAt = Date.now();

  while (Date.now() < deadline) {
    if (opts.cancelled?.()) return null;
    const state = await reader.read(handle);
    if (state.turns.length > opts.after) return state;

    if (state.size !== lastSize) {
      lastSize = state.size;
      changedAt = Date.now();
    } else if (opts.stalled && (await opts.stalled(Date.now() - changedAt))) {
      return null;
    }
    await delay(reader.pollMs);
  }
  return null;
}

/**
 * Not unref'd, and deliberately.
 *
 * This timer is the poll interval, so it is the only thing pending while doet
 * waits for an agent to finish. Unref'ing it would let the process exit
 * mid-turn.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
