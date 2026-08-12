/**
 * doet — shared vocabulary.
 *
 * doet runs each agent as its real terminal program in a tmux pane and reads
 * what it did from the transcript that CLI writes. So this file is smaller than
 * it used to be, and the things missing from it are missing on purpose:
 * permission prompts, session rotation and session handover were all doet's
 * problem only while doet was the client. The CLI owns them now, in a pane you
 * can see and type into, which is the better place for all three.
 */

/**
 * The coding CLIs doet can drive.
 *
 * This list is the *only* place the set is written down. Everything that used
 * to branch on "claude or codex" — the argv, the transcript reader, the recap,
 * the labels, the colours — now asks a `CliDefinition` in `core/agents/`
 * instead, so adding the next one is a new file in that directory rather than a
 * new arm on eight `if` statements.
 */
export type CliId = 'claude' | 'codex' | 'cline' | 'kilo';

/**
 * The old name for `CliId`, kept because it reads better in the places that
 * really are talking about an agent rather than about a program: the labels, the
 * colours, the pricing table.
 */
export type AgentId = CliId;

export const CLI_IDS: CliId[] = ['claude', 'codex', 'cline', 'kilo'];

/**
 * Which of the agents in a run this is — `a`, `b`, `c`…
 *
 * A plain string rather than `'a' | 'b'`, and that widening is the whole of
 * DOET-004's second half. Two things forced it. VS now runs N agents rather
 * than two, so the alphabet cannot be written out in a type. And co-code can
 * now put the *same* CLI on both sides, so the CLI id is no longer a usable
 * identity — two Claudes in one session are both `claude`, and every
 * `Record<AgentId, …>` keyed on that silently collapses them into one.
 *
 * So the slot is the identity, everywhere, in both modes. The CLI is something
 * a slot *has*.
 */
export type SlotId = string;

/**
 * Nine, and the limit is the keyboard rather than the machine.
 *
 * Each agent gets a tmux window, and the dashboard offers `F1`–`F9` and
 * `alt+1`–`alt+9` to jump straight into one. `F10` and a two-digit alt binding
 * both exist, but the first is taken by terminals often enough to be unreliable
 * and the second cannot be told from the start of `alt+1` without a timeout. A
 * tenth agent would have to be reached by a key that sometimes works, which is
 * worse than not offering it.
 */
export const MAX_SLOTS = 9;

const ALPHABET = 'abcdefghi';

/** `['a', 'b', 'c']` for 3. Throws rather than truncating — see `MAX_SLOTS`. */
export function slotIds(count: number): SlotId[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`A run needs at least one agent, not ${count}.`);
  }
  if (count > MAX_SLOTS) {
    throw new Error(`doet runs at most ${MAX_SLOTS} agents at once, not ${count}.`);
  }
  return ALPHABET.slice(0, count).split('');
}

/**
 * The reasoning-effort dial, where the CLI has one.
 *
 * These five names are Claude's and Codex's. They are *not* universal, which is
 * why the supported set now lives on each `CliDefinition` rather than here:
 * cline offers `none|low|medium|high|xhigh` — no `max` — and kilo has no dial at
 * all, choosing effort per model instead. This union is the vocabulary doet
 * displays; what any one CLI will actually accept is `supports.efforts`.
 */
export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One selectable model.
 *
 * Neither CLI publishes its model list to the command line, so this is no
 * longer discovered — it is whatever the user put in `~/.doet/config.json`,
 * exactly like `pricing`. doet passes the id straight to `--model`; if it is
 * wrong the CLI says so in its own pane, which is a better error than any doet
 * could invent from a list it could not verify.
 */
export interface ModelChoice {
  /** The value handed to `--model`. */
  id: string;
  label: string;
  description?: string;
  /** Reasoning-effort levels this model accepts, if it has the dial at all. */
  efforts?: Effort[];
  defaultEffort?: Effort;
  isDefault?: boolean;
}

export type AgentStatus = 'stopped' | 'starting' | 'ready' | 'thinking' | 'working' | 'error';

/**
 * Which of doet's two interfaces to draw.
 *
 * `interactive` is the original: every agent live on screen at once, doet's own
 * pane between them. You see everything, and you see it in a third of the width.
 *
 * `modern` gives doet the whole terminal and files each agent in a tmux window
 * of its own, named but not shown. What you read is the shape of the
 * conversation — who has it, which way it went, what each turn came to — and any
 * agent is one keypress away when you want the real thing.
 *
 * This is a preference about *display*, and deliberately nothing else. The
 * agents are the same real CLIs in the same real terminals either way, so
 * nothing below the UI layer branches on it.
 */
export type UiMode = 'interactive' | 'modern';

export const UI_MODES: UiMode[] = ['interactive', 'modern'];

/** Where an agent stands in a co-code exchange. */
export type Verdict = 'AGREE' | 'REVISE';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  /**
   * What the CLI itself says the session cost, when it says anything. Absent is
   * not zero — it means that agent does not report cost, and doet estimates
   * from tokens instead rather than inventing a number here.
   */
  costUsd?: number;
}

/**
 * What doet still publishes on its own bus.
 *
 * Far less than before, because the agents' own output no longer travels
 * through here — it is drawn by the CLI, in its pane. What is left is doet's
 * own voice: what it sent, what came back, what it cost, and what it is doing.
 */
/**
 * Note that every `agent` below is a `SlotId`, not a `CliId`.
 *
 * It used to be the CLI id, which worked only for as long as a session could
 * not hold two of the same one. co-code can now be Claude against Claude, so
 * "which agent said this" has exactly one answer that still means something:
 * the slot. The field kept its name because that is what it is *for* — the
 * agent in slot `b` — but what it carries is the slot.
 */
export type DoetEvent =
  | { kind: 'status'; agent: SlotId; status: AgentStatus; note?: string }
  /** A complete assistant message, read from the CLI's transcript. */
  | { kind: 'message'; agent: SlotId; text: string }
  | { kind: 'usage'; agent: SlotId; usage: Usage }
  | { kind: 'error'; agent: SlotId; message: string; fatal?: boolean }
  /** The prompt doet handed this agent. */
  | { kind: 'prompt'; agent: SlotId; text: string; label: string }
  /** Adapter finished a turn. `text` is the full final assistant message. */
  | { kind: 'turn-end'; agent: SlotId; text: string }
  /** A fresh underlying session was opened for one agent. */
  | { kind: 'session'; agent: SlotId; sessionId?: string }
  /**
   * This agent's pane has stopped moving mid-turn, so it is probably asking you
   * something. `note` is null when it starts moving again.
   *
   * Only the modern UI has any use for this, and only because that UI is what
   * hides the pane in the first place. In the interactive UI the prompt is on
   * screen and an event about it would be doet narrating what you can already
   * see. See `TmuxAgent`'s `stalled` handler for how it is worked out, and why
   * the answer is a guess rather than a fact.
   */
  | { kind: 'attention'; agent: SlotId; note: string | null }
  /**
   * An agent's own account of what it just did, written in a fork of its own
   * session. `final` marks the closing summary of the whole run.
   */
  | { kind: 'recap'; agent: SlotId; text: string; round: number; final?: boolean }
  /** One agent used a doet tool to reach the other. */
  | { kind: 'peer'; from: SlotId; to: SlotId; tool: string; note: string }
  /** Conductor-level narration, shown in the relay log. */
  | { kind: 'relay'; from: SlotId | 'user'; to: SlotId; round: number; note: string }
  | { kind: 'debate'; phase: DebatePhase; round: number; note?: string }
  | { kind: 'log'; source: SlotId | 'doet'; message: string; level?: 'info' | 'warn' | 'error' };

export type DebatePhase = 'idle' | 'opening' | 'exchanging' | 'converged' | 'done' | 'stopped';

// ---------------------------------------------------------------------------
// One-time messages
// ---------------------------------------------------------------------------

/**
 * What happened to a message you sent one agent.
 *
 * `live`  — pasted into the composer of a session that is mid-turn, which both
 *           CLIs accept and fold into the work in progress.
 * `sent`  — the agent was idle, so the message is simply its next turn.
 *
 * `queued` is gone: nothing is held back any more. Pasting into a running
 * composer is exactly what you would do yourself, and it always lands.
 */
export type MessageDelivery = 'live' | 'sent';

/**
 * What an adapter managed on its own. `null` means there was no exchange in
 * flight to add to, and the caller should open a turn instead.
 */
export type InFlightDelivery = 'live';

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AgentInfo {
  /** Which agent in the run this is. The identity — see `SlotId`. */
  slot: SlotId;
  /** Which program it is running. Two slots may well hold the same one. */
  cli: CliId;
  label: string;
  /** The id handed to `--model`, or empty for the CLI's own default. */
  model: string;
  effort?: Effort;
  status: AgentStatus;
  cwd: string;
  /** The CLI's session id, once its transcript exists. */
  sessionId?: string;
  sessionSeq: number;
  sessionTurns: number;
  usage: Usage;
  /**
   * The tmux window holding this agent, when it has one to itself.
   *
   * Set only under the modern UI, which is the only arrangement where an agent
   * lives somewhere you have to be taken to. In the interactive layout every
   * agent shares doet's window and there is nowhere to go.
   */
  window?: number;
  /** Why this agent might need you, or absent when it does not. See `attention`. */
  attention?: string;
}

export interface TurnResult {
  agent: SlotId;
  /** Final assistant message, as the CLI recorded it. */
  text: string;
  verdict: Verdict | null;
  usage: Usage;
  interrupted: boolean;
  error?: string;
}

export interface VsSlotResult {
  slot: SlotId;
  cli: CliId;
  model: string;
  branch: string;
  worktree: string;
  commit: string;
  changed: boolean;
  files: number;
  insertions: number;
  deletions: number;
  diffstat: string;
  commits: string[];
  response: string;
  usage: Usage;
  /** Wall-clock time this slot spent on this exchange, add-on messages included. */
  elapsedMs: number;
  /** One-time messages you added to this exchange while it ran. */
  addOns: number;
  error?: string;
}

export interface VsResult {
  query: string;
  base: string;
  /**
   * The slots in the order they were laid out, because `Record` has no order
   * and a scoreboard that lists B above A for no reason is a scoreboard nobody
   * trusts. Every consumer iterates this and looks `slots` up by it.
   */
  order: SlotId[];
  slots: Record<SlotId, VsSlotResult>;
  /**
   * Wall clock for the run, which is the slower slot rather than the sum: both
   * slots work at once, so adding their times would describe a race nobody ran.
   */
  elapsedMs: number;
}

/**
 * What one slot has spent so far — read live by the UI while a run is in
 * flight, and folded into `VsSlotResult` when it finishes.
 */
export interface VsSlotStats {
  turns: number;
  addOns: number;
  activeMs: number;
  /** Set while an exchange is in flight; the UI counts up from it. */
  runningSince?: number;
  usage: Usage;
}

/**
 * What doet asks of an agent.
 *
 * Deliberately small. Everything doet used to do *to* a session — approve its
 * tools, rotate it, release it so you could take it over — either belongs to
 * the CLI now or stopped meaning anything once the session was never doet's to
 * hold in the first place.
 */
export interface AgentAdapter {
  readonly slot: SlotId;
  readonly cli: CliId;
  readonly label: string;

  start(): Promise<void>;
  /** Send one user turn and resolve when the agent finishes responding. */
  send(prompt: string, label?: string): Promise<TurnResult>;
  /**
   * Add one message to the exchange this agent is in the middle of.
   *
   * Resolves `null` when no exchange was in flight, so the caller can send it
   * as an ordinary turn instead.
   */
  addMessage(text: string): Promise<InFlightDelivery | null>;
  interrupt(): Promise<void>;
  /** Only before the session starts; the CLI takes its model as a launch flag. */
  setModel(model: string, effort?: Effort): Promise<void>;
  listModels(): Promise<ModelChoice[]>;
  /** Move to another working tree, restarting the CLI there on the same session. */
  setCwd(cwd: string): Promise<void>;
  /** Branch the session, returning the command that opens the branch. */
  forkSession(): Promise<{ command: string; args: string[] } | null>;
  /** The agent's own transcript, as Markdown. */
  history(): string;
  info(): AgentInfo;
  dispose(): Promise<void>;
}
