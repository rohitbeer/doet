import type { SessionStore } from './sessions.js';
import {
  SLOT_IDS,
  type AgentAdapter,
  type CliId,
  type SlotId,
  type TurnResult,
  type VsResult,
  type VsSlotResult,
} from './types.js';
import {
  commitAll,
  commitsSince,
  diffSummary,
  type Worktree,
} from './git.js';

export interface VsSide {
  slot: SlotId;
  cli: CliId;
  adapter: AgentAdapter;
  worktree: Worktree;
}

/**
 * Runs two isolated implementations of one request. There is deliberately no
 * relay, judging, or synthesis here: each session sees the exact same prompt
 * and owns a different git worktree.
 */
export class VsRunner {
  private readonly sides: Record<SlotId, VsSide>;
  private readonly store: SessionStore;
  private readonly root: string;
  private query = '';
  private inflight: Partial<Record<SlotId, Promise<unknown>>> = {};

  constructor(opts: {
    sides: Record<SlotId, VsSide>;
    store: SessionStore;
    root: string;
  }) {
    this.sides = opts.sides;
    this.store = opts.store;
    this.root = opts.root;
  }

  get isRunning(): boolean {
    return Object.keys(this.inflight).length > 0;
  }

  async run(query: string): Promise<VsResult> {
    if (this.isRunning) throw new Error('A VS run is already in progress.');
    this.query = query;
    this.store.openVsQuestion(query);

    for (const slot of SLOT_IDS) {
      this.inflight[slot] = this.runSide(this.sides[slot], query);
    }

    try {
      const [a, b] = await Promise.all([
        this.inflight.a! as Promise<VsSlotResult>,
        this.inflight.b! as Promise<VsSlotResult>,
      ]);
      const result: VsResult = {
        query,
        base: this.sides.a.worktree.base,
        slots: { a, b },
      };
      this.store.finalizeVs(result);
      return result;
    } finally {
      this.inflight = {};
    }
  }

  async abort(slot?: SlotId): Promise<void> {
    const targets = slot ? [slot] : SLOT_IDS;
    await Promise.all(targets.map((id) => this.sides[id].adapter.interrupt().catch(() => {})));
  }

  async whenSlotIdle(slot: SlotId): Promise<void> {
    await this.inflight[slot]?.catch(() => {});
  }

  /** Continue one plugged-in implementation in its original live session. */
  async continue(slot: SlotId, prompt: string): Promise<TurnResult> {
    if (this.isRunning) throw new Error('Another VS turn is already in progress.');
    const pending = this.runFollowUp(this.sides[slot], prompt);
    this.inflight[slot] = pending;
    try {
      return await pending;
    } finally {
      delete this.inflight[slot];
    }
  }

  private async runFollowUp(side: VsSide, prompt: string): Promise<TurnResult> {
    this.store.appendVsFollowUp(side.slot, prompt);
    let turn: TurnResult;
    try {
      turn = await side.adapter.send(prompt, `slot ${side.slot.toUpperCase()} follow-up`);
    } catch (error) {
      turn = {
        agent: side.cli,
        text: '',
        verdict: null,
        usage: side.adapter.info().usage,
        interrupted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.store.appendVsTurn(side.slot, `${side.adapter.info().label} follow-up`, turn.text, turn.error);
    this.store.writeSlotHistory(side.slot, side.adapter.info().label, side.adapter.history());
    if (side.adapter.info().cwd === this.root) {
      const commit = await commitAll(this.root, `doet vs: slot ${side.slot} follow-up`);
      if (commit.changed) {
        this.store.appendNote(
          `Committed slot ${side.slot.toUpperCase()} follow-up in main as ${commit.sha.slice(0, 12)}.`,
        );
      }
    }
    return turn;
  }

  private async runSide(side: VsSide, query: string): Promise<VsSlotResult> {
    let turn: TurnResult;
    try {
      turn = await side.adapter.send(query, 'shared VS request');
    } catch (error) {
      turn = {
        agent: side.cli,
        text: '',
        verdict: null,
        usage: side.adapter.info().usage,
        interrupted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.store.appendVsTurn(side.slot, side.adapter.info().label, turn.text, turn.error);
    this.store.writeSlotHistory(side.slot, side.adapter.info().label, side.adapter.history());

    const commit = await commitAll(
      side.worktree.path,
      `doet vs: slot ${side.slot} (${side.cli})`,
    );
    const [diff, commits] = await Promise.all([
      diffSummary(this.root, side.worktree.base, side.worktree.branch),
      commitsSince(this.root, side.worktree.base, side.worktree.branch),
    ]);

    return {
      slot: side.slot,
      cli: side.cli,
      branch: side.worktree.branch,
      worktree: side.worktree.path,
      commit: commit.sha,
      changed: commit.changed || commits.length > 0,
      files: diff.files,
      insertions: diff.insertions,
      deletions: diff.deletions,
      diffstat: diff.text,
      commits,
      response: turn.text,
      usage: turn.usage,
      error: turn.error,
    };
  }
}

export function vsInstructions(slot: SlotId): string {
  return `You are slot ${slot.toUpperCase()} in a doet VS run. Another coding agent receives the same request in a separate git worktree. Work independently: inspect the repository, make the requested changes in your current working tree, and verify them. Do not wait for or discuss the other agent. Your final response must stand alone and summarize what changed and how you verified it.`;
}
