import { Bus } from './bus.js';
import type { SummarySetting } from './config.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { gistPrompt, summaryInstructions } from './relay.js';
import type { AgentAdapter, AgentId } from './types.js';

/** How long a session will wait on the digest before carrying on without it. */
const GIST_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd so a pending timer never holds the process open at exit.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface SummarizerOptions {
  /** The bus the UI listens on — used only for status lines, never for panes. */
  bus: Bus;
  cwd: string;
  setting: SummarySetting;
}

/**
 * Keeps one running digest of the session.
 *
 * It runs on its own adapter and its own event bus. Both matter. A separate
 * session means summarizing does not pollute either debater's context or burn
 * one of their turns; a separate bus means its tokens and tool chatter never
 * appear in the two panes, which are for the debate.
 *
 * doet's rule that it never calls a model itself has exactly one exception, and
 * this is it — an explicit, user-selected one that writes notes and nothing
 * else. It never speaks to the debaters directly; the conductor decides whether
 * to carry the digest into a prompt.
 */
export class Summarizer {
  private readonly bus: Bus;
  private readonly cwd: string;
  private setting: SummarySetting;

  /** Its own bus: the summarizer's events must not reach the debate panes. */
  private readonly innerBus = new Bus();
  private agent: AgentAdapter | null = null;
  private starting: Promise<void> | null = null;

  private gist = '';
  private round = 0;
  /** Serializes updates so two exchanges cannot interleave into one digest. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: SummarizerOptions) {
    this.bus = opts.bus;
    this.cwd = opts.cwd;
    this.setting = opts.setting;

    // Surface only failures, and as doet's own log line rather than as an agent
    // event, so a summarizer hiccup never looks like a debater misbehaving.
    this.innerBus.on((event) => {
      if (event.kind === 'error') {
        this.bus.log('doet', `Summary agent: ${event.message}`, 'warn');
      }
    });
  }

  get enabled(): boolean {
    return this.setting.agent !== 'off' && this.setting.agent !== 'ask';
  }

  get current(): string {
    return this.gist;
  }

  get describe(): string {
    if (this.setting.agent === 'ask') return 'not chosen';
    if (!this.enabled) return 'off';
    return `${this.setting.agent}${this.setting.model.id ? ` · ${this.setting.model.id}` : ''}`;
  }

  /** Adopts a digest read back from disk, e.g. when resuming a stored session. */
  seed(gist: string): void {
    this.gist = gist.trim();
  }

  /** Start a genuinely fresh doet session, including the note-taker's context. */
  async reset(): Promise<void> {
    await this.dispose();
    this.gist = '';
    this.round = 0;
    this.queue = Promise.resolve();
  }

  /**
   * Swaps which agent keeps the notes. The old session is torn down; the digest
   * survives, since it is doet's, not the agent's.
   */
  async configure(setting: SummarySetting): Promise<void> {
    const changed =
      setting.agent !== this.setting.agent ||
      setting.model.id !== this.setting.model.id ||
      setting.model.effort !== this.setting.model.effort;
    this.setting = setting;
    if (!changed) return;

    await this.dispose();
    this.agent = null;
    this.starting = null;
  }

  // -------------------------------------------------------------------------

  private async ensure(): Promise<AgentAdapter | null> {
    if (!this.enabled) return null;
    if (this.agent) return this.agent;

    this.starting ??= this.spawn();
    try {
      await this.starting;
    } catch (error) {
      this.bus.log(
        'doet',
        `Summary agent failed to start: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      this.starting = null;
      return null;
    }
    return this.agent;
  }

  private async spawn(): Promise<void> {
    const { agent: which, model } = this.setting;
    // The brief is standing, so it goes in once rather than on top of every
    // exchange it is asked to fold in.
    const instructions = summaryInstructions(this.setting.targetWords);

    const adapter: AgentAdapter =
      which === 'codex'
        ? new CodexAdapter({
            bus: this.innerBus,
            cwd: this.cwd,
            model: model.id,
            effort: model.effort,
            instructions,
            // A note-taker has no business editing anything, and must never
            // block the debate on a prompt only it can see.
            readOnly: true,
            approvalPolicy: 'never',
            sandbox: 'read-only',
          })
        : new ClaudeAdapter({
            bus: this.innerBus,
            cwd: this.cwd,
            model: model.id,
            effort: model.effort,
            instructions,
            readOnly: true,
          });

    await adapter.start();
    if (model.id) {
      // Best effort: an unavailable summariser model should degrade to the
      // account default, not take the digest down with it.
      await adapter.setModel(model.id, model.effort).catch((error: unknown) => {
        this.bus.log(
          'doet',
          `Summary agent model: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      });
    }
    this.agent = adapter;
  }

  /**
   * Folds one exchange into the digest. Errors are swallowed on purpose: the
   * digest is an aid, and losing it must never end a debate.
   */
  async update(args: {
    query: string;
    /** Everything said since the last digest — normally both agents' turns. */
    messages: Array<{ agent: AgentId; text: string }>;
    round: number;
  }): Promise<string> {
    const messages = args.messages.filter((m) => m.text.trim());
    if (!this.enabled || messages.length === 0) return this.gist;

    const run = this.queue.then(async () => {
      const agent = await this.ensure();
      if (!agent) return;

      const result = await agent.send(
        gistPrompt({
          query: args.query,
          previous: this.gist,
          messages,
          round: args.round,
        }),
        'gist',
      );

      if (result.error || !result.text.trim()) return;
      this.gist = result.text.trim();
      this.round = args.round;
      this.bus.emit({ kind: 'gist', text: this.gist, round: this.round });
    });

    this.queue = run.catch(() => {});

    // The digest is an aid, and the session waits on it between exchanges.
    // Nothing about it is worth stalling the work for, so a slow or wedged
    // summarizer is abandoned rather than waited on. The run itself carries on
    // in `queue`, so a late answer still lands for the next round.
    await Promise.race([this.queue, sleep(GIST_TIMEOUT_MS)]);
    return this.gist;
  }

  async dispose(): Promise<void> {
    await this.queue.catch(() => {});
    await this.agent?.dispose().catch(() => {});
    this.agent = null;
    this.starting = null;
  }
}
