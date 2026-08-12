import type { Bus } from './bus.js';
import { Deferred } from './util.js';
import type { SessionStore } from './sessions.js';
import { AGENT_LABELS } from './relay.js';
import { recap } from './recap.js';
import {
  otherAgent,
  type AgentAdapter,
  type AgentId,
  type DebatePhase,
  type TurnResult,
} from './types.js';

export interface DebateConfig {
  /** Exchanges to run. The answer to "how many?" is asked with every question. */
  maxRounds: number;
}

export const DEFAULT_DEBATE: DebateConfig = { maxRounds: 6 };

export interface DebateResult {
  query: string;
  rounds: number;
  reason: 'exhausted' | 'stopped' | 'error';
  final: string;
  finalFrom: AgentId;
}

interface Exchange {
  round: number;
  agent: AgentId;
  text: string;
}

/**
 * The passer.
 *
 * Both agents work in the *same* checkout — that is what makes this co-code
 * rather than vs. They take turns rather than running at once, because two
 * agents editing one tree simultaneously would overwrite each other between
 * keystrokes and neither one's work would mean anything.
 *
 * What changed with tmux is where the words go. doet used to receive one
 * agent's answer as protocol events and re-render it into a pane; now it reads
 * the answer out of that CLI's own transcript and pastes it into the other
 * one's composer, which is exactly what you would do by hand. The relay is the
 * same idea it always was — the difference is that both halves of it are now
 * visible, in the interface each agent already has.
 */
export class Conductor {
  private readonly bus: Bus;
  private readonly agents: Record<AgentId, AgentAdapter>;
  private readonly store: SessionStore;
  private config: DebateConfig;

  private phase: DebatePhase = 'idle';
  private round = 0;
  private query = '';
  private readonly exchanges: Exchange[] = [];
  /** Agents that have already been told what the human asked. */
  private readonly greeted = new Set<AgentId>();
  private stopRequested = false;
  private inflight: Deferred<void> | null = null;
  private active: AgentId | null = null;
  /** Text the user typed mid-session, delivered before the next relay. */
  private interjections: string[] = [];

  constructor(opts: {
    bus: Bus;
    agents: Record<AgentId, AgentAdapter>;
    store: SessionStore;
    config?: DebateConfig;
  }) {
    this.bus = opts.bus;
    this.agents = opts.agents;
    this.store = opts.store;
    this.config = opts.config ?? DEFAULT_DEBATE;
  }

  get currentQuery(): string {
    return this.query;
  }

  get currentPhase(): DebatePhase {
    return this.phase;
  }

  get currentRound(): number {
    return this.round;
  }

  get activeAgent(): AgentId | null {
    return this.active;
  }

  get isRunning(): boolean {
    return this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'stopped';
  }

  get settings(): DebateConfig {
    return this.config;
  }

  configure(patch: Partial<DebateConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Ends the exchange after the current turn finishes. */
  /**
   * Ends the exchange after the current turn — and, asked twice, ends it now.
   *
   * The escalation is the important half. `stopRequested` is only read once a
   * turn resolves, so on its own it is useless in the one case where you most
   * want out: doet waiting on a turn that already finished, where nothing will
   * ever resolve and the flag is never read. A second press interrupts the
   * agent outright, which settles the turn and lets the loop notice the stop.
   */
  requestStop(): void {
    if (!this.isRunning) return;
    if (this.stopRequested) {
      this.bus.log('doet', 'Still waiting — interrupting the agent now.', 'warn');
      void this.abort();
      return;
    }
    this.stopRequested = true;
    this.bus.log('doet', 'Stopping after the current turn… press esc again to cut it short.', 'warn');
  }

  /**
   * Abandons the run wholesale, however wedged it is.
   *
   * The last resort behind `abort()`: if interrupting the agent still does not
   * settle the turn, the conductor stops waiting on it. The turn's promise is
   * left dangling rather than awaited — it belongs to a CLI doet no longer has
   * an answer from, and holding the whole session open for it helps nobody.
   */
  forceEnd(): void {
    if (!this.isRunning) return;
    this.stopRequested = true;
    this.phase = 'stopped';
    this.bus.emit({ kind: 'debate', phase: 'stopped', round: this.round, note: 'abandoned' });
    this.bus.log('doet', 'Gave up waiting on this turn. The session is yours again.', 'warn');
    const settled = this.inflight;
    this.inflight = null;
    settled?.resolve();
  }

  /** Ends it now, cutting off whoever is mid-sentence. */
  async abort(): Promise<void> {
    if (!this.isRunning) return;
    this.stopRequested = true;
    if (this.active) await this.agents[this.active].interrupt();
  }

  async whenIdle(): Promise<void> {
    await this.inflight?.promise.catch(() => {});
  }

  /**
   * A note from the human, delivered to whoever speaks next.
   *
   * Not pasted into the pane of whoever is working right now — that agent is
   * mid-turn, and an unannounced instruction arriving in the middle of its work
   * is how you get a half-applied change. It rides in front of the next prompt.
   */
  interject(text: string): void {
    this.interjections.push(text);
    this.bus.log('doet', 'Your note will reach the next agent before its turn.');
  }

  async run(query: string, first: AgentId, rounds?: number): Promise<DebateResult> {
    this.inflight = new Deferred<void>();
    if (rounds && rounds > 0) this.config = { ...this.config, maxRounds: rounds };
    try {
      return await this.exchange(query, first);
    } finally {
      const settled = this.inflight;
      this.inflight = null;
      settled?.resolve();
    }
  }

  private async exchange(query: string, first: AgentId): Promise<DebateResult> {
    this.reset();
    this.query = query;
    this.phase = 'opening';
    this.store.openQuestion(query);
    this.bus.emit({ kind: 'debate', phase: 'opening', round: 0 });
    this.bus.emit({ kind: 'relay', from: 'user', to: first, round: 0, note: 'opening query' });

    let speaker = first;
    let reason: DebateResult['reason'] = 'exhausted';

    for (this.round = 0; this.round < this.config.maxRounds; this.round++) {
      const prompt = this.buildPrompt(speaker);
      const result = await this.speak(speaker, prompt, this.round === 0 ? 'opening' : 'relay');

      // A turn cut short on purpose reports as an error from the CLI. Checking
      // the stop first keeps an intentional interrupt from being announced as
      // the agent having failed.
      if (this.stopRequested || result.interrupted) {
        if (result.text.trim()) this.record(speaker, result.text);
        reason = 'stopped';
        break;
      }

      if (result.error) {
        this.bus.emit({ kind: 'error', agent: speaker, message: `${speaker} failed: ${result.error}` });
        reason = 'error';
        break;
      }

      this.record(speaker, result.text);
      await this.recapExchange(speaker);

      if (this.round === this.config.maxRounds - 1) {
        reason = 'exhausted';
        break;
      }

      const next = otherAgent(speaker);
      this.bus.emit({
        kind: 'relay',
        from: speaker,
        to: next,
        round: this.round + 1,
        note: `exchange ${this.round + 2} of ${this.config.maxRounds}`,
      });

      speaker = next;
      this.phase = 'exchanging';
      this.bus.emit({ kind: 'debate', phase: 'exchanging', round: this.round + 1 });
    }

    // Whoever actually spoke last, which is not always `speaker`: a run that
    // ends on an interrupted or failed turn leaves `speaker` pointing at an
    // agent that never said anything. Asking *that* one for the closing account
    // gets a summary of a session it barely has — observed, not theorised: a
    // stopped run's record came back as "a list of available but uninstalled
    // plugins was provided", which is Codex describing its own empty context.
    const closer = this.exchanges[this.exchanges.length - 1]?.agent ?? speaker;
    await this.recapSession(closer);
    return this.conclude(query, speaker, reason);
  }

  /**
   * The agent that just spoke, in one line, from a fork of its own session.
   *
   * Awaited rather than fired and forgotten: it runs between turns, when
   * nothing else is happening, and letting it overlap the next turn would have
   * two processes reading one session at once. It is cheap — the agent already
   * has the context, so there is nothing to send it.
   *
   * The line goes to doet's pane and to the session record, and no further.
   * `buildPrompt` hands the next speaker the answer itself; adding the author's
   * own gloss on that answer would be doet talking over the message it is
   * relaying, and worse, letting an agent brief its own reviewer.
   */
  private async recapExchange(agent: AgentId): Promise<void> {
    const info = this.agents[agent].info();
    if (!info.sessionId) return;
    const text = await recap({
      bus: this.bus,
      agent,
      sessionId: info.sessionId,
      cwd: info.cwd,
      scope: 'exchange',
      // Only Codex reads this — see `recap.ts` for why it cannot be asked the
      // way Claude is. Passed for both so the caller has one shape.
      said: this.exchanges[this.exchanges.length - 1]?.text ?? '',
    });
    if (!text) return;
    this.bus.emit({ kind: 'recap', agent, text, round: this.round });
    this.store.appendNote(`${AGENT_LABELS[agent]} — ${text}`);
  }

  /**
   * The closing account of the whole run, from whoever spoke last.
   *
   * The last speaker rather than a neutral third party, because by then it is
   * the one that has seen every exchange: it wrote the final answer, and it
   * read everything that led there.
   */
  private async recapSession(agent: AgentId): Promise<void> {
    if (this.exchanges.length === 0) return;
    const info = this.agents[agent].info();
    if (!info.sessionId) return;
    const text = await recap({
      bus: this.bus,
      agent,
      sessionId: info.sessionId,
      cwd: info.cwd,
      scope: 'session',
      said: this.exchanges
        .map((exchange) => `${AGENT_LABELS[exchange.agent]}:\n${exchange.text}`)
        .join('\n\n'),
    });
    if (!text) return;
    this.bus.emit({ kind: 'recap', agent, text, round: this.round, final: true });
    this.store.writeSummary(text);
  }

  private record(agent: AgentId, text: string): void {
    this.exchanges.push({ round: this.round, agent, text });
    this.store.appendTurn(agent, this.round, text, null);
    this.store.writeAgentHistory(agent, this.agents[agent].history());
  }

  /**
   * What the next speaker is handed.
   *
   * The other agent's answer, labelled and otherwise untouched. doet does not
   * add a task here: what to do with a counterpart's answer never changes from
   * round to round, so it lives in the session instructions each agent was
   * started with, and repeating it every relay would be doet talking over the
   * agent it is quoting.
   */
  private buildPrompt(speaker: AgentId): string {
    const notes = this.interjections.splice(0);
    const prefix = notes.length > 0
      ? `${notes.map((note) => `The human broke in to say this. It takes priority.\n\n<human>\n${note}\n</human>`).join('\n\n')}\n\n`
      : '';

    if (this.exchanges.length === 0) {
      this.greeted.add(speaker);
      return prefix + this.query;
    }

    const last = this.exchanges[this.exchanges.length - 1]!;
    // The first time an agent sees this conversation it is handed the other
    // one's answer — and, without this, nothing else. It has never been told
    // what was asked, so it is reviewing a reply to a question it cannot see;
    // the symptom is the second agent answering with "send me the task". Every
    // later turn omits it, because by then the agent's own session remembers.
    const request = this.greeted.has(speaker)
      ? ''
      : `<request>\n${this.query}\n</request>\n\n`;
    this.greeted.add(speaker);

    return `${prefix}${request}Answer by ${AGENT_LABELS[last.agent]}:

<${last.agent}>
${last.text}
</${last.agent}>`;
  }

  private async speak(agent: AgentId, prompt: string, label: string): Promise<TurnResult> {
    this.active = agent;
    try {
      return await this.agents[agent].send(prompt, label);
    } finally {
      this.active = null;
    }
  }

  private conclude(
    query: string,
    lastSpeaker: AgentId,
    reason: DebateResult['reason'],
  ): DebateResult {
    const last = this.exchanges[this.exchanges.length - 1];
    this.phase = 'done';
    this.bus.emit({ kind: 'debate', phase: 'done', round: this.round, note: reason });
    return {
      query,
      rounds: this.exchanges.length,
      reason,
      final: last?.text ?? '',
      finalFrom: last?.agent ?? lastSpeaker,
    };
  }

  private reset(): void {
    this.round = 0;
    this.greeted.clear();
    this.exchanges.length = 0;
    this.stopRequested = false;
    this.interjections = [];
    this.active = null;
  }

  clear(): void {
    this.reset();
    this.query = '';
    this.phase = 'idle';
  }
}

/**
 * The standing brief each agent is started with, as its system prompt.
 *
 * Sent once at launch rather than on top of every relay, so a turn can be just
 * the thing that is new.
 */
export function coCodeInstructions(self: AgentId, other: AgentId, rounds: number): string {
  return `You are ${AGENT_LABELS[self]}, working alongside ${AGENT_LABELS[other]} in a session run
by \`doet\`. doet is a relay: it passes messages between the two of you and never writes any of
the answer itself. You share one working tree, and you take turns — never edit while it is not
your turn.

Whoever speaks first answers the human directly. That reply is handed to the other, who checks
and improves it; it comes back, and so on. The human chose ${rounds} exchange${rounds === 1 ? '' : 's'} for this question
and can stop it sooner. Being corrected here is cheap. Shipping something wrong is not.

Do the actual work — read the files, run the commands — rather than describing what you would
do. Be specific enough that ${AGENT_LABELS[other]} can check your reasoning instead of guessing
at it.

When you are handed ${AGENT_LABELS[other]}'s answer, that message is theirs, passed through
untouched; doet adds no instructions to it. Check what you can — read the files they cite, run
the commands, see whether it holds up. Then write your own best version of the answer rather
than notes on theirs. Concede plainly when you are wrong and hold your position when you are
not. Do not manufacture disagreement to look thorough, and do not restate your previous message.

Write every reply as the finished answer to the human's request. The last one said is what they
receive, so any single reply should stand on its own — no status markers, no notes to doet, no
meta-commentary about the session or about how many exchanges are left.`;
}
