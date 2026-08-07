import type { PricingTable } from './pricing.js';
import { renderScoreboard } from './scoreboard.js';
import type { SessionStore } from './sessions.js';
import {
  SLOT_IDS,
  type AgentAdapter,
  type CliId,
  type MessageDelivery,
  type SlotId,
  type TurnResult,
  type VsResult,
  type VsSlotResult,
  type VsSlotStats,
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
  private readonly pricing: PricingTable;
  private query = '';
  private inflight: Partial<Record<SlotId, Promise<unknown>>> = {};
  /**
   * What each slot has spent, kept here rather than in the UI because a
   * follow-up, a handover and a reconnect all pass through the runner and none
   * of them go through React. Tokens are not here — see `statsFor`.
   */
  private readonly stats: Record<SlotId, Omit<VsSlotStats, 'usage'>> = {
    a: { turns: 0, addOns: 0, activeMs: 0 },
    b: { turns: 0, addOns: 0, activeMs: 0 },
  };

  constructor(opts: {
    sides: Record<SlotId, VsSide>;
    store: SessionStore;
    root: string;
    pricing?: PricingTable;
  }) {
    this.sides = opts.sides;
    this.store = opts.store;
    this.root = opts.root;
    this.pricing = opts.pricing ?? {};
  }

  get isRunning(): boolean {
    return Object.keys(this.inflight).length > 0;
  }

  /**
   * A snapshot, not the live object: the UI reads this on every frame while a
   * run is in flight, and handing out the mutable record would let a render
   * observe a slot half-updated.
   *
   * Tokens come straight off the adapter rather than a copy taken when the last
   * exchange ended. Both adapters publish usage as the turn streams, and their
   * tally is already cumulative for the session — so reading it live costs
   * nothing and is the difference between a counter that moves while you watch
   * and one that sits on `–` until the run is over.
   */
  statsFor(slot: SlotId): VsSlotStats {
    return { ...this.stats[slot], usage: { ...this.sides[slot].adapter.info().usage } };
  }

  async run(query: string): Promise<VsResult> {
    if (this.isRunning) throw new Error('A VS run is already in progress.');
    this.query = query;
    this.store.openVsQuestion(query);

    const startedAt = Date.now();
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
        elapsedMs: Date.now() - startedAt,
      };
      this.store.finalizeVs(result, renderScoreboard(result, this.pricing));
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

  /**
   * Adds one message to whatever exchange this slot is in the middle of.
   *
   * Deliberately not routed through `continue`: this is not another turn, it is
   * an amendment to the turn already running. Whether the agent hears it now or
   * at the next boundary is the adapter's answer, not the runner's, and it comes
   * back so the UI can say which happened rather than guessing.
   */
  async addMessage(slot: SlotId, text: string): Promise<MessageDelivery> {
    const side = this.sides[slot];
    const body = text.trim();
    if (!body) throw new Error('An added message needs some text.');

    const delivery = await side.adapter.addMessage(body);
    this.stats[slot].addOns += 1;
    this.store.appendVsAddOn(slot, body, delivery);
    return delivery;
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
    const done = this.beginExchange(side.slot);
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
    } finally {
      done();
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

  /**
   * Starts this slot's clock and returns the function that stops it.
   *
   * The clock covers the whole exchange, added messages included — that is what
   * "how long did this take me" means, and it is the number the two slots are
   * being compared on.
   */
  private beginExchange(slot: SlotId): () => number {
    const stats = this.stats[slot];
    const startedAt = Date.now();
    stats.runningSince = startedAt;
    return () => {
      const elapsed = Date.now() - startedAt;
      stats.activeMs += elapsed;
      stats.turns += 1;
      delete stats.runningSince;
      return elapsed;
    };
  }

  private async runSide(side: VsSide, query: string): Promise<VsSlotResult> {
    let turn: TurnResult;
    const done = this.beginExchange(side.slot);
    let elapsedMs = 0;
    const addOnsBefore = this.stats[side.slot].addOns;
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
    } finally {
      elapsedMs = done();
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

    const info = side.adapter.info();
    return {
      slot: side.slot,
      cli: side.cli,
      model: info.resolvedModel ?? info.model,
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
      elapsedMs,
      addOns: this.stats[side.slot].addOns - addOnsBefore,
      error: turn.error,
    };
  }
}

export function vsInstructions(slot: SlotId): string {
  return `You are slot ${slot.toUpperCase()} in a doet VS run. Another coding agent receives the same request in a separate git worktree. Work independently: inspect the repository, make the requested changes in your current working tree, and verify them. Do not wait for or discuss the other agent. Your final response must stand alone and summarize what changed and how you verified it.`;
}
