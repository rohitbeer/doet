import type { Bus } from './bus.js';
import { Deferred } from './util.js';
import type { SessionStore } from './sessions.js';
import type { Summarizer } from './summarizer.js';
import {
  handoffPrompt,
  interjectionPrompt,
  openingPrompt,
  relayPrompt,
} from './relay.js';
import {
  otherAgent,
  type AgentAdapter,
  type AgentId,
  type AgentSessionSettings,
  type DebatePhase,
  type HandoffMode,
  type TurnResult,
  type Verdict,
} from './types.js';

export interface DebateConfig {
  /**
   * Exchanges to run. The default the "how many?" picker offers; the answer
   * there is what actually applies to a given question.
   */
  maxRounds: number;
}

export const DEFAULT_DEBATE: DebateConfig = {
  maxRounds: 6,
};

/**
 * A session rotation the conductor cannot decide on its own. The UI answers it
 * so the choice reaches a human rather than a default.
 */
export interface HandoffQuestion {
  agent: AgentId;
  reason: string;
  resolve: (mode: HandoffMode) => void;
}

export interface ConductorHooks {
  /** Asked when a rotation is due and that agent's handoff setting is `ask`. */
  askHandoff?: (question: Omit<HandoffQuestion, 'resolve'>) => Promise<HandoffMode>;
}

export interface DebateResult {
  query: string;
  rounds: number;
  reason: 'converged' | 'exhausted' | 'stopped' | 'error';
  final: string;
  finalFrom: AgentId;
}

interface Exchange {
  round: number;
  agent: AgentId;
  text: string;
  verdict: Verdict | null;
}

/**
 * The passer. Owns turn-taking and nothing else — it never calls a model, never
 * edits an agent's output, and never decides who is right. Its whole job is
 * deciding who speaks next and when to stop.
 */
export class Conductor {
  private readonly bus: Bus;
  private readonly agents: Record<AgentId, AgentAdapter>;
  private readonly store: SessionStore;
  private readonly summarizer: Summarizer;
  private hooks: ConductorHooks;
  private config: DebateConfig;
  private sessionSettings: Record<AgentId, AgentSessionSettings>;

  private phase: DebatePhase = 'idle';
  private round = 0;
  private query = '';
  private readonly exchanges: Exchange[] = [];
  /** Agents that have already seen the framing preamble. */
  private readonly greeted = new Set<AgentId>();

  private stopRequested = false;
  /** Settles when the current `run` finishes, however it finishes. */
  private inflight: Deferred<void> | null = null;
  private active: AgentId | null = null;
  /** Text the user typed mid-session, delivered before the next relay. */
  private interjections: string[] = [];
  /** Turns waiting to go to the summariser, flushed a full exchange at a time. */
  private pendingSummary: Array<{ agent: AgentId; text: string }> = [];

  constructor(opts: {
    bus: Bus;
    agents: Record<AgentId, AgentAdapter>;
    store: SessionStore;
    summarizer: Summarizer;
    config?: DebateConfig;
    sessions: Record<AgentId, AgentSessionSettings>;
    hooks?: ConductorHooks;
  }) {
    this.bus = opts.bus;
    this.agents = opts.agents;
    this.store = opts.store;
    this.summarizer = opts.summarizer;
    this.config = opts.config ?? DEFAULT_DEBATE;
    this.sessionSettings = opts.sessions;
    this.hooks = opts.hooks ?? {};
  }

  get currentQuery(): string {
    return this.query;
  }

  /** The UI installs these once it can render a question. */
  setHooks(hooks: ConductorHooks): void {
    this.hooks = hooks;
  }

  configureSessions(agent: AgentId, patch: Partial<AgentSessionSettings>): void {
    this.sessionSettings[agent] = { ...this.sessionSettings[agent], ...patch };
  }

  sessionSettingsFor(agent: AgentId): AgentSessionSettings {
    return this.sessionSettings[agent];
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

  configure(patch: Partial<DebateConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  get settings(): DebateConfig {
    return this.config;
  }

  /** Ends the debate after the current turn finishes. */
  requestStop(): void {
    if (!this.isRunning) return;
    this.stopRequested = true;
    this.bus.log('doet', 'Stopping after the current turn…', 'warn');
  }

  /** Ends the session now, cutting off whoever is mid-sentence. */
  async abort(): Promise<void> {
    if (!this.isRunning) return;
    this.stopRequested = true;
    if (this.active) await this.agents[this.active].interrupt();
  }

  /**
   * Resolves once no turn is in flight. Anything that takes a session out from
   * under the conductor has to wait for this first, or it races the turn the
   * conductor is still awaiting.
   */
  async whenIdle(): Promise<void> {
    await this.inflight?.promise.catch(() => {});
  }

  /** Queue a note for the next agent to receive. */
  interject(text: string): void {
    this.interjections.push(text);
    this.bus.log('doet', 'Your note will reach the next agent before its turn.');
  }

  // -------------------------------------------------------------------------

  /**
   * `rounds` is per-run: the cap is a property of the question, not of the
   * session. "Check this one-liner" and "rewrite this module" do not want the
   * same number of exchanges, and deciding when you ask beats remembering to
   * set it beforehand.
   */
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
    this.bus.emit({
      kind: 'relay',
      from: 'user',
      to: first,
      round: 0,
      note: 'opening query',
    });

    let speaker = first;
    let reason: DebateResult['reason'] = 'exhausted';

    for (this.round = 0; this.round < this.config.maxRounds; this.round++) {
      const prompt = this.buildPrompt(query, speaker);
      const result = await this.speak(speaker, prompt, this.round === 0 ? 'opening' : 'relay');

      // A turn cut short on purpose reports as an SDK error. Checking the stop
      // first keeps an intentional interrupt — `ctrl+x`, or taking the session
      // over — from being announced as the agent failing.
      if (this.stopRequested || result.interrupted) {
        if (result.text.trim()) {
          this.exchanges.push({
            round: this.round,
            agent: speaker,
            text: result.text,
            verdict: result.verdict,
          });
          this.store.appendTurn(speaker, this.round, result.text, result.verdict);
        }
        reason = 'stopped';
        break;
      }

      if (result.error) {
        this.bus.emit({
          kind: 'error',
          agent: speaker,
          message: `${speaker} failed: ${result.error}`,
        });
        reason = 'error';
        break;
      }

      this.exchanges.push({
        round: this.round,
        agent: speaker,
        text: result.text,
        verdict: result.verdict,
      });
      // Written now rather than at the end: rotating a session reads this file
      // back, so it has to be current while the debate is still running.
      this.store.appendTurn(speaker, this.round, result.text, result.verdict);
      this.store.writeAgentHistory(speaker, this.agents[speaker].history());

      // Buffered here and flushed a whole exchange at a time. Done before the
      // exit checks below so the last exchange still reaches the digest —
      // updating after the hand-off left the saved notes a turn stale.
      this.pendingSummary.push({ agent: speaker, text: result.text });
      await this.updateGist();

      // Runs exactly the number of exchanges the human asked for. There is no
      // convergence check any more: detecting it meant asking the agents to end
      // every turn with a status marker, which ended up in their own sessions.
      // Deciding when they have said enough is the human's call, which is why
      // the count is asked with every question.
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
        // The agents no longer report a verdict — they are asked to write
        // answers, not status lines — so this says where the message went.
        note: result.verdict
          ? result.verdict.toLowerCase()
          : `exchange ${this.round + 2} of ${this.config.maxRounds}`,
      });

      // Rotate before the next speaker builds its prompt, so a fresh session
      // receives the handoff on the very turn it is opened for.
      await this.maybeRotate(next);

      speaker = next;
      this.phase = 'exchanging';
      this.bus.emit({ kind: 'debate', phase: 'exchanging', round: this.round + 1 });
    }

    // A session that ends on an odd turn still has one message buffered.
    await this.updateGist(true);

    return this.conclude(query, speaker, reason);
  }

  /**
   * Hands the summariser a whole exchange — both agents' messages — rather
   * than each turn as it lands. A digest written from half an exchange is
   * written before the reply that answers it.
   *
   * `force` flushes whatever is buffered when the session ends on an odd turn.
   */
  private async updateGist(force = false): Promise<void> {
    if (!this.summarizer.enabled) return;
    if (this.pendingSummary.length === 0) return;
    if (!force && this.pendingSummary.length < 2) return;

    const messages = this.pendingSummary.splice(0);
    try {
      const gist = await this.summarizer.update({
        query: this.query,
        messages,
        round: this.round,
      });
      if (gist) this.store.writeGist(gist);
    } catch {
      // The digest is an aid. Losing it must never end a session.
    }
  }

  // -------------------------------------------------------------------------
  // Session rotation
  // -------------------------------------------------------------------------

  /** Rotates `agent` now, whatever its policy says. Used by `/session … new`. */
  async rotate(agent: AgentId, mode: HandoffMode): Promise<void> {
    const carry = this.buildHandoff(agent, mode);
    await this.agents[agent].newSession(carry, mode);
    this.store.appendNote(
      `New ${agent} session opened, carrying ${mode === 'none' ? 'nothing' : mode}.`,
    );
    this.bus.log(
      'doet',
      `Opened a new ${agent} session${mode === 'none' ? '' : ` carrying the ${mode}`}.`,
    );
  }

  /** Applies the agent's rotation policy, asking the human when told to. */
  private async maybeRotate(agent: AgentId): Promise<void> {
    const reason = this.rotationDue(agent);
    if (!reason) return;

    const settings = this.sessionSettings[agent];
    let mode: HandoffMode;

    if (settings.handoff === 'ask' && this.hooks.askHandoff) {
      mode = await this.hooks.askHandoff({ agent, reason });
    } else {
      // Without a way to ask, `ask` degrades to the gist rather than stalling a
      // running debate on a question nobody will see.
      mode = settings.handoff === 'ask' ? 'gist' : settings.handoff;
    }

    await this.rotate(agent, mode);
  }

  /** Why this agent is due for a fresh session, or null if it isn't. */
  private rotationDue(agent: AgentId): string | null {
    const policy = this.sessionSettings[agent].policy;
    const info = this.agents[agent].info();

    if (policy.mode === 'rounds') {
      return info.sessionTurns >= policy.every
        ? `${info.sessionTurns} turns on this session (limit ${policy.every})`
        : null;
    }
    if (policy.mode === 'tokens') {
      const used = info.usage.totalTokens ?? (info.usage.inputTokens ?? 0) + (info.usage.outputTokens ?? 0);
      return used >= policy.limit
        ? `${used.toLocaleString()} tokens on this session (limit ${policy.limit.toLocaleString()})`
        : null;
    }
    return null;
  }

  /** The text a rotated session opens with. */
  buildHandoff(agent: AgentId, mode: HandoffMode): string | undefined {
    if (mode === 'none') return undefined;

    const body =
      mode === 'full'
        ? this.store.readSession().trim() || this.summarizer.current
        : this.summarizer.current.trim() || this.store.readSession().trim();

    if (!body) return undefined;
    return handoffPrompt({ query: this.query, agent, gist: body });
  }

  private buildPrompt(query: string, speaker: AgentId): string {
    const notes = this.interjections.splice(0);
    const prefix = notes.length > 0 ? `${notes.map(interjectionPrompt).join('\n\n')}\n\n` : '';

    const firstContact = !this.greeted.has(speaker);
    this.greeted.add(speaker);

    // The opening turn is the human's question and nothing else — the framing
    // lives in the agent's session instructions.
    if (this.exchanges.length === 0) {
      return prefix + openingPrompt(query);
    }

    const last = this.exchanges[this.exchanges.length - 1]!;
    return (
      prefix +
      relayPrompt({
        query,
        other: last.agent,
        otherText: last.text,
        firstContact,
      })
    );
  }

  private async speak(agent: AgentId, prompt: string, label: string): Promise<TurnResult> {
    this.active = agent;
    try {
      return await this.agents[agent].send(prompt, label);
    } finally {
      this.active = null;
    }
  }

  /**
   * Both agents stop here, and nothing more is sent to either one.
   *
   * The last reply *is* the answer — every reply is written as the finished
   * answer, so there is nothing left to ask for. doet used to spend one more
   * turn asking whoever spoke last to restate it, which was the only place it
   * put a block of its own instructions in front of an agent. That is gone, and
   * gone rather than made optional: it lived on in saved configs and came back.
   */
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
    this.exchanges.length = 0;
    this.greeted.clear();
    this.stopRequested = false;
    this.interjections = [];
    this.active = null;
  }

  /** Clears the debate state without touching the agents' own sessions. */
  clear(): void {
    this.reset();
    this.query = '';
    this.phase = 'idle';
  }
}
