import type { Bus } from '../bus.js';
import { AGENT_LABELS } from '../relay.js';
import {
  awaitTranscript,
  awaitTurn,
  existingTranscripts,
  readJournal,
  sessionIdFor,
  type JournalState,
} from '../journal.js';
import type { TmuxSession } from '../tmux.js';
import {
  type AgentAdapter,
  type AgentId,
  type AgentInfo,
  type AgentStatus,
  type Effort,
  type InFlightDelivery,
  type ModelChoice,
  type TurnResult,
  type Usage,
} from '../types.js';
import { renderHistory, type HistoryEntry } from '../util.js';

/**
 * An agent that doet does not draw.
 *
 * The other two adapters drive a CLI over a protocol and hand doet a stream of
 * events to re-render. This one runs the CLI as what it actually is — a
 * terminal program, in a tmux pane, rendering itself — and learns what happened
 * by reading the transcript that CLI writes to disk.
 *
 * It implements the same `AgentAdapter` interface on purpose. Everything above
 * the adapter layer is worth keeping exactly as it is: `VsRunner` still owns
 * turn-taking and commits, the git layer still cuts the worktrees, the
 * scoreboard still prices the run. Only the transport changed, so only the
 * transport should have to know.
 *
 * What genuinely does not survive the move is written as a throw or a no-op
 * below rather than faked, because a permission prompt that silently never
 * arrives is worse than one doet admits it cannot show.
 */

export interface TmuxAgentOptions {
  bus: Bus;
  cli: AgentId;
  session: TmuxSession;
  /** Pane title, e.g. `A · Claude Code`. */
  title: string;
  cwd: string;
  model: string;
  effort?: Effort;
  /**
   * Directories the agent may touch beyond `cwd`. VS uses this for the shared
   * git metadata a linked worktree needs in order to commit at all.
   */
  addDirs?: string[];
  /** Standing framing, appended to the CLI's own system prompt where supported. */
  instructions?: string;
  /** What `listModels` reports. Gathered once at startup, before any pane exists. */
  models?: ModelChoice[];
  /**
   * Put this agent's pane to the left of doet's rather than the right.
   *
   * With doet in the middle, the two agents sit either side of it and the
   * relay has a direction you can see: the message leaves the pane on the left,
   * passes through doet, and arrives in the pane on the right.
   */
  before?: boolean;
  /**
   * Whether this agent shares doet's window or gets one of its own.
   *
   * `split` is the interactive layout: everything on screen at once, each agent
   * beside doet. `window` is the modern one, where the agent is filed under its
   * name and shown when you ask for it.
   *
   * Only the arrangement differs. A windowed agent is started the same way,
   * pasted into the same way, and read the same way — see `newWindow` for why
   * being off-screen costs it nothing.
   */
  placement?: 'split' | 'window';
  /** Claude's posture: `default`, `acceptEdits`, `plan`, `bypassPermissions`. */
  permissionMode?: string;
  /** Codex's approval policy: `untrusted`, `on-request`, `never`. */
  approvalPolicy?: string;
  /**
   * Codex's sandbox: `read-only`, `workspace-write`, `danger-full-access`.
   *
   * `workspace-write` is not optional when `addDirs` is set — Codex refuses
   * extra writable roots under any weaker sandbox and exits at startup saying
   * so, which in VS means a slot that dies before it draws anything.
   */
  sandbox?: string;
}

/** How long to wait for a CLI's own UI to come up before sending it anything. */
const READY_TIMEOUT_MS = 60_000;
/** How long to wait for the transcript to appear after the first prompt. */
const TRANSCRIPT_TIMEOUT_MS = 120_000;
/**
 * How many trust prompts to answer before giving up.
 *
 * More than one because a CLI can ask again after onboarding, and bounded
 * because a screen doet keeps mistaking for a dialog would otherwise have Enter
 * pressed into it until the timeout.
 */
const TRUST_ANSWER_LIMIT = 3;
/**
 * How long the transcript and the pane must both sit still before doet calls a
 * turn abandoned.
 *
 * Generous on purpose. Too short ends a turn while the agent is thinking with
 * nothing on screen, and in co-code that would relay half an answer to the
 * other agent as if it were finished. Too long only costs a wait, once, after
 * the work has already stopped.
 */
const STALL_QUIET_MS = 20_000;
/**
 * How long a turn must sit completely still before doet says so out loud.
 *
 * Well short of `STALL_QUIET_MS`, because these two thresholds are answering
 * different questions about the same silence. At twenty seconds doet concludes
 * the turn is over and stops waiting. At six it concludes nothing — it just
 * mentions that nothing is moving, which under the modern UI is the difference
 * between an agent quietly holding a permission prompt and an agent thinking
 * hard. Under the interactive UI the prompt is already on screen and this is
 * never shown.
 */
const ATTENTION_QUIET_MS = 6_000;

export class TmuxAgent implements AgentAdapter {
  readonly id: AgentId;
  readonly label: string;

  private readonly bus: Bus;
  private readonly opts: TmuxAgentOptions;

  private pane: string | null = null;
  /** The window this agent has to itself, under the modern layout only. */
  private window: number | undefined;
  /** Why this agent might be waiting on you, or null when nothing suggests it is. */
  private attention: string | null = null;
  private transcript: string | null = null;
  private sessionId: string | undefined;
  /** Stamped immediately before the pane starts, to find its transcript after. */
  private startedAt = 0;

  private status: AgentStatus = 'stopped';
  private model: string;
  private effort: Effort | undefined;
  private usage: Usage = {};
  private models: ModelChoice[];

  /** Turns already read out of the transcript — the cursor `awaitTurn` reads from. */
  private turnsSeen = 0;
  private transcriptOf: HistoryEntry[] = [];
  private sessionSeq = 0;
  private sessionTurns = 0;
  private busy = false;
  /** Last screen seen while waiting, for telling a stalled turn from a slow one. */
  private lastScreen = '';
  /** Transcripts that existed before this pane started, so a new one stands out. */
  private knownTranscripts = new Set<string>();
  private interruptedTurn = false;

  constructor(opts: TmuxAgentOptions) {
    this.id = opts.cli;
    this.label = AGENT_LABELS[opts.cli];
    this.bus = opts.bus;
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    this.models = opts.models ?? [];
  }

  // -------------------------------------------------------------------------
  // Launching
  // -------------------------------------------------------------------------

  /**
   * The argv that starts this CLI, with the selection baked in.
   *
   * Model and effort are launch flags rather than commands typed afterwards,
   * because `/model` inside a running TUI is a thing doet would have to drive
   * by keystroke and confirm by reading the screen. Both CLIs accept the whole
   * selection up front, and in VS the selection is made before the run starts
   * anyway, so nothing is lost by fixing it here.
   */
  private argv(resume?: string): { command: string; args: string[] } {
    const addDirs = this.opts.addDirs ?? [];

    if (this.id === 'claude') {
      const args: string[] = [];
      if (resume) args.push('--resume', resume);
      if (this.model) args.push('--model', this.model);
      if (this.effort) args.push('--effort', this.effort);
      if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
      for (const dir of addDirs) args.push('--add-dir', dir);
      if (this.opts.instructions) args.push('--append-system-prompt', this.opts.instructions);
      return { command: 'claude', args };
    }

    const args: string[] = [];
    if (resume) args.push('resume', resume);
    if (this.model) args.push('--model', this.model);
    // Codex takes reasoning effort as a config override rather than a flag.
    if (this.effort) args.push('-c', `model_reasoning_effort="${this.effort}"`);
    if (this.opts.approvalPolicy) args.push('--ask-for-approval', this.opts.approvalPolicy);
    // Forced up to `workspace-write` when there are extra roots, because Codex
    // rejects them outright otherwise and takes the whole pane down with it.
    const sandbox = this.opts.sandbox ?? (addDirs.length > 0 ? 'workspace-write' : undefined);
    if (sandbox) args.push('--sandbox', addDirs.length > 0 ? 'workspace-write' : sandbox);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return { command: 'codex', args };
  }

  async start(): Promise<void> {
    this.setStatus('starting');
    this.startedAt = Date.now();
    // The before-picture, taken while it is still true. `startedAt` alone is
    // not enough to identify this session's transcript: the file is not written
    // until the first turn, which in co-code is several minutes and one whole
    // exchange later, and anything else that writes a transcript in between
    // would otherwise look newer and win.
    this.knownTranscripts = existingTranscripts(this.id, this.opts.cwd);

    const { command, args } = this.argv();
    const spec = {
      title: this.opts.title,
      name: this.label,
      cwd: this.opts.cwd,
      command,
      args,
    };
    if (this.opts.placement === 'window') {
      const placed = await this.opts.session.newWindow(spec);
      this.pane = placed.pane;
      this.window = placed.window;
    } else {
      this.pane = await this.opts.session.split(await this.anchorPane(), spec, {
        before: this.opts.before,
      });
    }

    await this.waitUntilReady();
    this.sessionSeq += 1;
    this.setStatus('ready');
  }

  /**
   * Where a new pane is grafted. The session always holds at least one pane, so
   * splitting from the first is enough; the layout is evened afterwards.
   */
  private async anchorPane(): Promise<string> {
    // doet's own pane, from the environment tmux gives every process it starts.
    //
    // Not `panes[0]`: with doet in the middle, the first agent inserts itself
    // *before* doet, so by the time the second one starts `panes[0]` is the
    // first agent — and splitting off that put doet on the far right instead
    // of between them. The anchor has to be a fixed point, and the only fixed
    // point is the pane doet is actually running in.
    const own = process.env.TMUX_PANE;
    if (own) return own;
    const panes = await this.opts.session.listPanes();
    const first = panes[0];
    if (!first) throw new Error('the tmux session has no pane to split from');
    return first.id;
  }

  /**
   * Waits for the CLI to have drawn itself.
   *
   * This is the one place doet looks at the screen, and only to answer "has it
   * finished starting" — never to work out what the agent said. It waits for
   * the pane to stop changing rather than for any particular glyph, so it does
   * not break when either CLI redesigns its banner. Sending a beat early would
   * only mean a paste landing in a composer that is not listening yet, which is
   * why the settle is generous and the check is cheap.
   */
  private async waitUntilReady(): Promise<void> {
    const pane = this.pane;
    if (!pane) throw new Error(`${this.label} has no pane.`);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let previous = '';
    let stable = 0;
    let trusted = 0;

    while (Date.now() < deadline) {
      if (!(await this.opts.session.paneAlive(pane))) {
        const screen = await this.opts.session.capture(pane, 40);
        throw new Error(
          `${this.label} exited during startup.${screen.trim() ? `\n${screen.trim()}` : ''}`,
        );
      }
      // Visible screen only. A dialog that has been dismissed still sits in the
      // scrollback, so matching against history asks "was a dialog ever open?"
      // — a question whose answer never returns to no.
      const screen = await this.opts.session.captureVisible(pane);
      if (awaitingTrust(screen)) {
        // A settled screen is normally a CLI that has finished starting, but a
        // blocking dialog is just as still — and pasting a prompt into one
        // types the request into a yes/no question, which is how both slots
        // once sat for two minutes having sent nothing at all. VS cuts a new
        // worktree per run, so neither CLI has seen the directory before and
        // this is the *usual* first screen rather than an edge case.
        //
        // Answered in the pane rather than by editing the user's CLI config:
        // an Enter here lasts as long as this process and leaves nothing
        // behind, where `hasTrustDialogAccepted` / `trust_level` would persist
        // globally and silently change how a later hand-run `claude` or
        // `codex` behaves in that path.
        if (trusted >= TRUST_ANSWER_LIMIT) {
          throw new Error(
            `${this.label} kept asking whether it can trust ${this.opts.cwd}. Answer it in its pane.`,
          );
        }
        trusted += 1;
        this.bus.log(
          this.id,
          `Confirmed the workspace trust prompt for ${this.opts.cwd} (doet created this worktree).`,
        );
        // `1` — the affirmative — chosen by number rather than by pressing
        // Enter on whatever is highlighted. Both CLIs put "yes" first *here*,
        // but that is a fact about this dialog and not about dialogs: Claude's
        // bypass-permissions warning highlights "No, exit" first, so a blind
        // Enter there quietly kills the pane. Never press the default; always
        // name the option.
        await this.opts.session.keys(pane, '1');
        await delay(600);
        if (awaitingTrust(await this.opts.session.captureVisible(pane))) {
          // Typing the number selected without confirming.
          await this.opts.session.keys(pane, 'Enter');
        }
        stable = 0;
        previous = '';
        await delay(1200);
        continue;
      }
      if (needsUnsafeConsent(screen)) {
        // A different dialog, and not one doet gets to answer. Accepting
        // "bypass all permission checks" on someone's behalf is not a
        // convenience, and doet asked for this mode in the first place — so it
        // is doet's configuration that is wrong, not the user's attention.
        throw new Error(
          `${this.label} is asking you to accept a mode that disables its safety checks. ` +
            'doet will not answer that for you — start the run without ' +
            `${this.id === 'claude' ? '`bypassPermissions`' : '`--dangerously-bypass-approvals-and-sandbox`'}` +
            ', or answer it yourself in its pane.',
        );
      }
      if (screen.trim().length > 0 && screen === previous) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
      previous = screen;
      await delay(500);
    }
    // Not fatal: a CLI that animates forever would never look stable, and the
    // paste is harmless if it is genuinely not ready.
    this.bus.log(this.id, `${this.label} did not settle; continuing anyway.`, 'warn');
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async send(prompt: string, label = 'prompt'): Promise<TurnResult> {
    const pane = this.pane;
    if (!pane) throw new Error(`${this.label} is not started.`);
    if (this.busy) throw new Error(`${this.label} is already mid-turn.`);

    this.busy = true;
    this.interruptedTurn = false;
    this.sessionTurns += 1;
    this.transcriptOf.push({ role: 'user', text: prompt });
    this.setStatus('thinking');
    this.bus.emit({ kind: 'prompt', agent: this.id, text: prompt, label });

    try {
      await this.opts.session.paste(pane, prompt, { submit: true });

      // The transcript does not exist until the first prompt opens it — that is
      // also the first moment a session id exists — so it is located here
      // rather than at startup.
      if (!this.transcript) {
        this.transcript = await awaitTranscript(this.id, this.opts.cwd, this.startedAt, {
          timeoutMs: TRANSCRIPT_TIMEOUT_MS,
          known: this.knownTranscripts,
        });
        if (this.transcript) {
          this.sessionId = sessionIdFor(this.id, this.transcript) ?? undefined;
          this.bus.emit({
            kind: 'session',
            agent: this.id,
            sessionId: this.sessionId,

          });
        }
      }
      if (!this.transcript) {
        throw new Error(
          `could not find ${this.label}'s transcript, so doet cannot tell when its turn ends.`,
        );
      }

      this.setStatus('working');
      let abandoned = false;
      const state = await awaitTurn(this.id, this.transcript, {
        after: this.turnsSeen,
        cancelled: () => this.interruptedTurn,
        stalled: async (quietMs) => {
          // The turn is not going to end, because the human already ended it.
          //
          // doet only knows about an interrupt it performed itself; the agent
          // is a real CLI in a pane you can type into, so `esc` pressed *there*
          // stops the turn without a word to doet — and doet then waits for a
          // completion that is never coming. Neither CLI records an abandoned
          // turn in a way that can be relied on, so what is detected instead is
          // the state that always follows one: the transcript has stopped
          // growing *and* the pane has stopped changing. Both, because either
          // alone is normal — a long tool call is quiet on disk, and a spinner
          // is busy on screen.
          if (quietMs < ATTENTION_QUIET_MS) return false;
          const screen = await this.opts.session.captureVisible(pane);
          if (screen !== this.lastScreen) {
            this.lastScreen = screen;
            this.setAttention(null);
            return false;
          }

          // Nothing on disk, nothing on screen. Long before that is grounds to
          // give up on the turn, it is grounds to mention it: a CLI holding a
          // permission prompt looks exactly like this, and under the modern UI
          // that prompt is in a window you are not looking at. Said as a guess
          // rather than a fact, because doet genuinely cannot see the
          // difference between "asking you something" and "wedged" — only that
          // both of them have stopped.
          this.setAttention(
            asking(screen)
              ? 'waiting for you'
              : 'nothing moving',
          );

          if (quietMs < STALL_QUIET_MS) return false;
          abandoned = true;
          return true;
        },
      });

      if (!state) {
        // What was written before it stopped is still the agent's work, and
        // still worth handing back — the caller decides what to do with a turn
        // that ended early, but it should not be handed an empty one.
        const partial = readJournal(this.id, this.transcript);
        const text = partial.turns.length > this.turnsSeen
          ? (partial.turns[partial.turns.length - 1]?.text ?? '')
          : '';
        this.absorb(partial);
        this.turnsSeen = Math.max(this.turnsSeen, partial.turns.length);
        return this.finish({
          text,
          error: this.interruptedTurn || abandoned
            ? undefined
            : 'the turn did not finish in time.',
          interrupted: this.interruptedTurn || abandoned,
        });
      }

      this.absorb(state);
      const turn = state.turns[state.turns.length - 1];
      this.turnsSeen = state.turns.length;
      return this.finish({ text: turn?.text ?? '', interrupted: false });
    } catch (error) {
      return this.finish({
        text: '',
        error: error instanceof Error ? error.message : String(error),
        interrupted: false,
      });
    }
  }

  private finish(opts: { text: string; error?: string; interrupted: boolean }): TurnResult {
    this.busy = false;
    // Whatever the pane was holding, the turn is over and it is not holding it
    // on doet's account any more.
    this.setAttention(null);
    this.transcriptOf.push({ role: 'assistant', text: opts.text });
    this.bus.emit({ kind: 'message', agent: this.id, text: opts.text });
    this.bus.emit({ kind: 'turn-end', agent: this.id, text: opts.text });
    this.setStatus(opts.error ? 'error' : 'ready');
    return {
      agent: this.id,
      text: opts.text,
      verdict: null,
      usage: this.usage,
      interrupted: opts.interrupted,
      error: opts.error,
    };
  }

  private absorb(state: JournalState): void {
    this.usage = state.usage;
    if (state.sessionId) this.sessionId = state.sessionId;
    this.bus.emit({ kind: 'usage', agent: this.id, usage: this.usage });
  }

  /**
   * A message added to the exchange already running.
   *
   * Pasted straight into the composer and submitted, which is what you would do
   * yourself: both CLIs accept input while working and fold it into the turn in
   * progress. `live` rather than `queued` because nothing is held back — the
   * text is in the agent's hands the moment this returns.
   */
  async addMessage(text: string): Promise<InFlightDelivery | null> {
    const body = text.trim();
    if (!body) throw new Error('An added message needs some text.');
    if (!this.pane) throw new Error(`${this.label} is not started.`);
    if (!this.busy) return null;

    await this.opts.session.paste(this.pane, body, { submit: true });
    this.transcriptOf.push({ role: 'user', text: body });
    this.bus.emit({ kind: 'prompt', agent: this.id, text: body, label: 'added to this exchange' });
    return 'live';
  }

  /** Escape is what stops a turn in both CLIs' own UIs. */
  async interrupt(): Promise<void> {
    this.interruptedTurn = true;
    if (this.pane) await this.opts.session.keys(this.pane, 'Escape');
  }

  // -------------------------------------------------------------------------
  // Things that belong to the CLI now
  // -------------------------------------------------------------------------

  /**
   * A no-op, and deliberately not a silent one at the call site.
   *
   * With the CLI drawing itself, its approval prompt is its own: it appears in
   * that pane and the user answers it there. doet never sees the request, so it
   * has nothing to resolve. Claude can be routed back through doet with a
   * `PreToolUse` hook; until that exists this is honest rather than pending.
   */
  resolvePermission(): void {
    /* the CLI owns its own prompts now */
  }

  async setModel(model: string, effort?: Effort): Promise<void> {
    if (this.pane) {
      throw new Error(
        `${this.label}'s model is fixed when its session starts. Choose it before the run.`,
      );
    }
    const choice = this.models.find((m) => m.id === model || m.label === model);
    if (!choice && this.models.length > 0) {
      throw new Error(
        `${this.label} cannot run "${model}". Available: ${this.models.map((m) => m.id).join(', ')}`,
      );
    }
    if (effort && choice?.efforts && !choice.efforts.includes(effort)) {
      throw new Error(
        `${choice.label} does not support ${effort} effort. Available: ${choice.efforts.join(', ')}`,
      );
    }
    this.model = choice?.id ?? model;
    this.effort = effort ?? choice?.defaultEffort ?? this.effort;
  }

  async listModels(): Promise<ModelChoice[]> {
    return this.models;
  }

  async setPermissionMode(): Promise<void> {
    throw new Error(
      `${this.label} manages its own permissions in its pane. Set the posture before the run.`,
    );
  }

  listPermissionModes(): string[] {
    return [];
  }

  /**
   * Moves the agent to another working tree, which VS does when a slot is
   * plugged into the main checkout.
   *
   * A pane cannot be re-rooted, so the CLI is restarted there and resumed at
   * the same session id — which is exactly what the user would type. The
   * transcript is dropped rather than carried: Claude files transcripts per
   * working tree, so the resumed session writes somewhere new and the old path
   * would quietly stop updating.
   */
  async setCwd(cwd: string): Promise<void> {
    if (cwd === this.opts.cwd) return;
    if (this.busy) throw new Error(`Cannot move ${this.label} while it is mid-turn.`);

    const resume = this.sessionId;
    const pane = this.pane;
    this.opts.cwd = cwd;
    this.transcript = null;
    this.turnsSeen = 0;
    this.startedAt = Date.now();
    this.knownTranscripts = existingTranscripts(this.id, cwd);

    const { command, args } = this.argv(resume);
    this.setStatus('starting');
    const spec = { title: this.opts.title, name: this.label, cwd, command, args };
    if (this.opts.placement === 'window') {
      // The replacement window is opened before the old one goes, so there is
      // never a moment where this agent has no pane at all.
      const placed = await this.opts.session.newWindow(spec);
      this.pane = placed.pane;
      if (pane) await this.opts.session.killPane(pane);
      // Read back *after* the old window has gone: closing it renumbers the
      // ones above, so the index this window was born with is already stale.
      this.window = (await this.opts.session.windowOf(placed.pane)) ?? placed.window;
    } else {
      this.pane = await this.opts.session.split(pane ?? (await this.anchorPane()), spec, {
        before: this.opts.before,
      });
      if (pane) await this.opts.session.killPane(pane);
      // Only means anything when the agents share doet's window; with a window
      // each there is no split left to even out.
      await this.opts.session.tile();
    }
    await this.waitUntilReady();
    this.setStatus('ready');
  }

  /**
   * The session is already interactive — it is right there in its own pane.
   *
   * Returning null is what stops the UI offering to "enter the live session":
   * the whole handover mechanism existed because doet held a session the user
   * could not reach, and under tmux it never holds one.
   */
  interactiveCommand(): { command: string; args: string[] } | null {
    return null;
  }

  async releaseSession(): Promise<string | null> {
    return this.sessionId ?? null;
  }

  async resumeSession(): Promise<void> {
    /* nothing to re-attach to: doet never let go */
  }

  /** Branching still means something: a second CLI on a copy of this session. */
  async forkSession(): Promise<{ command: string; args: string[] } | null> {
    if (!this.sessionId) return null;
    return this.id === 'claude'
      ? { command: 'claude', args: ['--resume', this.sessionId, '--fork-session'] }
      : { command: 'codex', args: ['resume', this.sessionId] };
  }

  history(): string {
    return renderHistory(this.label, this.transcriptOf);
  }

  info(): AgentInfo {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      effort: this.effort,
      status: this.status,
      cwd: this.opts.cwd,

      sessionId: this.sessionId,
      sessionSeq: this.sessionSeq,
      sessionTurns: this.sessionTurns,
      usage: this.usage,
      window: this.window,
      attention: this.attention ?? undefined,
    };
  }

  /** The pane doet arranged, so a controller can select or resize it. */
  get paneId(): string | null {
    return this.pane;
  }

  /** Re-reads the transcript without waiting, for a live counter. */
  refresh(): void {
    if (!this.transcript) return;
    this.absorb(readJournal(this.id, this.transcript));
  }

  async dispose(): Promise<void> {
    this.busy = false;
    this.setStatus('stopped');
    // The pane is left standing on purpose when the session is being torn down
    // wholesale; killing the server takes it. Killing it here would erase the
    // agent's own output before the user had a chance to read it.
    this.pane = null;
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bus.emit({ kind: 'status', agent: this.id, status });
  }

  private setAttention(note: string | null): void {
    if (this.attention === note) return;
    this.attention = note;
    this.bus.emit({ kind: 'attention', agent: this.id, note });
  }
}

/**
 * Whether the pane looks like it is waiting for an answer.
 *
 * Only ever used to *word* a message doet is already showing, never to decide
 * anything — by the time this is called doet has established that both the
 * transcript and the screen have stopped, and the only question left is whether
 * to say "waiting for you" or the vaguer "nothing moving". A miss in either
 * direction costs one adjective.
 *
 * Kept separate from `awaitingTrust` because that one guards an action — doet
 * types into that dialog — and so has to be much more careful than this.
 */
function asking(screen: string): boolean {
  const text = screen.toLowerCase();
  return (
    text.includes('do you want') ||
    text.includes('would you like') ||
    text.includes('allow') ||
    text.includes('approve') ||
    text.includes('(y/n)') ||
    /❯?\s*1\.\s*yes/.test(text)
  );
}

/**
 * Whether the pane is showing a "do you trust this folder?" dialog.
 *
 * Matched on the question rather than on any one CLI's wording, and used only
 * to decide *not* to type into it — never to answer it. Both CLIs pre-select
 * "yes", so a stray Enter here would accept a security prompt on the user's
 * behalf; that decision belongs to them, so this reports and stops.
 *
 * A false positive costs a clear error where the run would have worked. A false
 * negative is the old behaviour, which is worse.
 */
function awaitingTrust(screen: string): boolean {
  const text = screen.toLowerCase();
  if (needsUnsafeConsent(text)) return false;
  return (
    text.includes('trust') &&
    (text.includes('do you trust') ||
      text.includes('is this a project you created') ||
      text.includes('yes, i trust') ||
      text.includes('yes, continue'))
  );
}

/**
 * A dialog asking the user to switch off a safety mechanism.
 *
 * Kept separate from the trust prompt and never auto-answered. It is checked
 * *first*, because the bypass warning also contains the word "permissions" and
 * a looser trust matcher would happily press a button on it — and on that one
 * the highlighted default is "No, exit".
 */
function needsUnsafeConsent(screen: string): boolean {
  const text = screen.toLowerCase();
  return (
    text.includes('bypass permissions mode') ||
    text.includes('accept all responsibility') ||
    text.includes('dangerously')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
