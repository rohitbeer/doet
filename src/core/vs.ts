import type { PricingTable } from './pricing.js';
import { renderScoreboard } from './scoreboard.js';
import type { SessionStore } from './sessions.js';
import {
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

/** The outcome of sending one slot a message, and the work it started. */
export interface AddedMessage {
  delivery: MessageDelivery;
  /**
   * Set only when the message opened a turn of its own, so the caller can show
   * that slot as working and react when it finishes. Absent when the message
   * joined an exchange that was already running — that exchange's own promise
   * already covers it.
   */
  turn?: Promise<TurnResult>;
}

/**
 * Runs N isolated implementations of one request. There is deliberately no
 * relay, judging, or synthesis here: each session sees the exact same prompt
 * and owns a different git worktree.
 *
 * It was two until DOET-004, and the widening changed less than it looks. The
 * slots were already independent — each with its own bus, its own worktree, its
 * own inflight promise, released the moment it settled rather than when the
 * pair did — so going from two to nine is mostly a matter of iterating `order`
 * instead of naming `a` and `b`. What genuinely had to change is that nothing
 * may assume a *pair* any more: no `Promise.all([a, b])`, no "the other one",
 * and a wall clock that is the slowest of many rather than the slower of two.
 */
export class VsRunner {
  private readonly sides: Record<SlotId, VsSide>;
  /** The slots, in the order they were laid out. The only source of order. */
  private readonly order: SlotId[];
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
  private readonly stats: Record<SlotId, Omit<VsSlotStats, 'usage'>>;

  constructor(opts: {
    sides: Record<SlotId, VsSide>;
    order: SlotId[];
    store: SessionStore;
    root: string;
    pricing?: PricingTable;
  }) {
    this.sides = opts.sides;
    this.order = [...opts.order];
    this.store = opts.store;
    this.root = opts.root;
    this.pricing = opts.pricing ?? {};
    this.stats = Object.fromEntries(
      this.order.map((slot) => [slot, { turns: 0, addOns: 0, activeMs: 0 }]),
    );
  }

  private statsOf(slot: SlotId): Omit<VsSlotStats, 'usage'> {
    const stats = this.stats[slot];
    if (!stats) throw new Error(`There is no slot ${slot.toUpperCase()} in this run.`);
    return stats;
  }

  /** The slots this run holds, in order. */
  get slots(): SlotId[] {
    return [...this.order];
  }

  sideFor(slot: SlotId): VsSide {
    const side = this.sides[slot];
    if (!side) throw new Error(`There is no slot ${slot.toUpperCase()} in this run.`);
    return side;
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
    const stats = this.stats[slot] ?? { turns: 0, addOns: 0, activeMs: 0 };
    return { ...stats, usage: { ...this.sideFor(slot).adapter.info().usage } };
  }

  async run(query: string): Promise<VsResult> {
    if (this.isRunning) throw new Error('A VS run is already in progress.');
    this.query = query;
    this.store.openVsQuestion(query);

    const startedAt = Date.now();
    // Each side releases its own slot the moment it settles, rather than all of
    // them being released when the last one does. The slots are independent,
    // and a slot that finished a minute ago is genuinely idle: you can message
    // it, continue it, or take its session over without waiting on the rest.
    // Clearing them together made every fast slot report "still finishing its
    // last turn" for as long as the slowest one ran — which is exactly the
    // window in which you want to talk to it, and with nine agents it is nearly
    // the whole run.
    const pending = {} as Record<SlotId, Promise<VsSlotResult>>;
    for (const slot of this.order) {
      const side: Promise<VsSlotResult> = this.runSide(this.sideFor(slot), query).finally(() => {
        if (this.inflight[slot] === side) delete this.inflight[slot];
      });
      pending[slot] = side;
      this.inflight[slot] = side;
    }

    try {
      const settled = await Promise.all(this.order.map((slot) => pending[slot]!));
      const slots = Object.fromEntries(
        this.order.map((slot, index) => [slot, settled[index]!]),
      ) as Record<SlotId, VsSlotResult>;
      const result: VsResult = {
        query,
        base: this.sideFor(this.order[0]!).worktree.base,
        order: [...this.order],
        slots,
        elapsedMs: Date.now() - startedAt,
      };
      this.store.finalizeVs(result, renderScoreboard(result, this.pricing));
      return result;
    } finally {
      // Belt and braces for a side that never reached its own cleanup. Guarded
      // by identity: a solo turn started on a slot that finished early belongs
      // to that turn, not to this run, and must not be cleared here.
      for (const slot of this.order) {
        if (this.inflight[slot] === pending[slot]) delete this.inflight[slot];
      }
    }
  }

  async abort(slot?: SlotId): Promise<void> {
    const targets = slot ? [slot] : this.order;
    await Promise.all(targets.map((id) => this.sideFor(id).adapter.interrupt().catch(() => {})));
  }

  async whenSlotIdle(slot: SlotId): Promise<void> {
    await this.inflight[slot]?.catch(() => {});
  }

  /**
   * Sends one message to one slot, and to no other.
   *
   * The composer at the bottom of the screen addresses both slots, because that
   * is what makes a VS run a comparison. This is the other thing you need: you
   * are talking to *that* agent, in its own session, about its own branch.
   *
   * Which of the two shapes it takes depends only on whether that slot happens
   * to be working, and the caller does not have to know in advance:
   *
   *   busy — the adapter folds it into the exchange in flight (`live`/`queued`),
   *          and that exchange stays open until the agent has answered it.
   *   idle — it is simply that slot's next turn, opened here and now.
   *
   * The idle case used to hold the text back and prepend it to whatever went to
   * *both* slots next, which was wrong twice over: the message did not reach the
   * agent when you sent it, and when it finally did it arrived stapled to a
   * shared prompt. Nothing is stored now — a message you send is sent.
   */
  async addMessage(slot: SlotId, text: string): Promise<AddedMessage> {
    const side = this.sideFor(slot);
    const body = text.trim();
    if (!body) throw new Error('An added message needs some text.');

    // Asked of the adapter rather than inferred from `inflight`: only the
    // adapter knows whether a turn is genuinely open, and a turn that ends
    // between the check and the call would otherwise be added to thin air.
    const delivery = await side.adapter.addMessage(body);
    if (delivery) {
      this.statsOf(slot).addOns += 1;
      this.store.appendVsAddOn(slot, body, delivery);
      return { delivery };
    }

    if (this.inflight[slot]) {
      // The adapter is between turns but the runner is still finishing up —
      // committing, diffing. Sending now would race that.
      throw new Error(`Slot ${slot.toUpperCase()} is finishing its last turn. Try again in a moment.`);
    }

    this.statsOf(slot).addOns += 1;
    this.store.appendVsAddOn(slot, body, 'sent');
    // The cleanup is part of the promise handed back, not a chain hung off the
    // side of it. A caller awaiting `turn` and then asking `isRunning` has to
    // see the slot already free — with a separate chain that is a coin flip on
    // microtask ordering, and losing it leaves the UI stuck showing "running".
    const turn: Promise<TurnResult> = this.runSolo(
      side,
      body,
      `slot ${side.slot.toUpperCase()} message`,
    ).finally(() => {
      if (this.inflight[slot] === turn) delete this.inflight[slot];
    });
    this.inflight[slot] = turn;
    return { delivery: 'sent', turn };
  }

  /**
   * Continue one implementation in its own live session.
   *
   * Gated per slot rather than on the whole run: the two slots are independent,
   * and there is no reason a turn on one should be refused because the other is
   * busy.
   */
  async continue(slot: SlotId, prompt: string): Promise<TurnResult> {
    if (this.inflight[slot]) throw new Error(`Slot ${slot.toUpperCase()} is already working.`);
    this.store.appendVsFollowUp(slot, prompt);
    const pending = this.runSolo(
      this.sideFor(slot),
      prompt,
      `slot ${slot.toUpperCase()} follow-up`,
    );
    this.inflight[slot] = pending;
    try {
      return await pending;
    } finally {
      if (this.inflight[slot] === pending) delete this.inflight[slot];
    }
  }

  /** One turn for one slot, committed wherever that slot is currently working. */
  private async runSolo(side: VsSide, prompt: string, label: string): Promise<TurnResult> {
    let turn: TurnResult;
    const done = this.beginExchange(side.slot);
    try {
      turn = await side.adapter.send(prompt, label);
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
    this.store.appendVsTurn(side.slot, `${side.adapter.info().label} — ${label}`, turn.text, turn.error);
    this.store.writeSlotHistory(side.slot, side.adapter.info().label, side.adapter.history());

    // Committed in whichever tree the slot is working in — its own worktree
    // before you plug it in, the main tree afterwards. A slot that answered a
    // message and left the result uncommitted would show a stale diff and lose
    // the work to the next branch operation.
    const cwd = side.adapter.info().cwd;
    const inMain = cwd === this.root;
    const commit = await commitAll(cwd, `doet vs: slot ${side.slot} ${inMain ? 'follow-up' : 'message'}`);
    if (commit.changed) {
      this.store.appendNote(
        `Committed slot ${side.slot.toUpperCase()} in ${inMain ? 'main' : side.worktree.branch} as ${commit.sha.slice(0, 12)}.`,
      );
    }
    return turn;
  }

  /** What a slot's branch looks like now — for refreshing the board after a solo turn. */
  async diffFor(slot: SlotId): Promise<{ files: number; insertions: number; deletions: number }> {
    const side = this.sideFor(slot);
    const diff = await diffSummary(this.root, side.worktree.base, side.worktree.branch);
    return { files: diff.files, insertions: diff.insertions, deletions: diff.deletions };
  }

  /**
   * Starts this slot's clock and returns the function that stops it.
   *
   * The clock covers the whole exchange, added messages included — that is what
   * "how long did this take me" means, and it is the number the two slots are
   * being compared on.
   */
  private beginExchange(slot: SlotId): () => number {
    const stats = this.statsOf(slot);
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
    const addOnsBefore = this.statsOf(side.slot).addOns;
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
      model: info.model,
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
      addOns: this.statsOf(side.slot).addOns - addOnsBefore,
      error: turn.error,
    };
  }
}

/**
 * The standing brief each isolated agent is given.
 *
 * `total` is stated rather than left vague because "another coding agent" reads
 * very differently from "five other coding agents" — the first invites a
 * comparison, the second makes plain that being one voice among several is the
 * point. Either way the instruction is the same: work alone, finish, and write
 * something that stands on its own.
 */
export function vsInstructions(slot: SlotId, total: number): string {
  const others = total - 1;
  const company = others <= 0
    ? 'You are the only agent on this request.'
    : `${others === 1 ? 'Another coding agent receives' : `${others} other coding agents receive`} the same request, each in a separate git worktree.`;
  return `You are slot ${slot.toUpperCase()} in a doet VS run. ${company} Work independently: inspect the repository, make the requested changes in your current working tree, and verify them. Do not wait for or discuss the other agents. Your final response must stand alone and summarize what changed and how you verified it.`;
}
