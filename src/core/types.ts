/**
 * doet — shared vocabulary.
 *
 * Claude Code and Codex expose very different wire protocols (an SDK async
 * generator vs. JSON-RPC over stdio). Everything above the adapter layer speaks
 * only the types in this file, so adding a third agent later means writing one
 * adapter and touching nothing else.
 */

export type AgentId = 'claude' | 'codex';

export const AGENT_IDS: AgentId[] = ['claude', 'codex'];

export function otherAgent(id: AgentId): AgentId {
  return id === 'claude' ? 'codex' : 'claude';
}

/**
 * Both CLIs expose a reasoning-effort dial with the same five names, so doet
 * can offer one vocabulary. Which levels a given model actually accepts comes
 * back on the `ModelChoice`, not from this list.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One selectable model, as the agent's own CLI describes it.
 *
 * doet used to keep models as bare strings, which is why picking one barely
 * worked: there was nothing to validate a typo against and nothing to show but
 * the raw id. Both CLIs already publish this much detail — Claude through the
 * SDK's `supportedModels()`, Codex through `model/list` — so doet asks instead
 * of guessing.
 */
export interface ModelChoice {
  /** The value handed back to `setModel`. */
  id: string;
  label: string;
  description?: string;
  /** Reasoning-effort levels this model accepts, if it has the dial at all. */
  efforts?: Effort[];
  defaultEffort?: Effort;
  isDefault?: boolean;
}

export type AgentStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'thinking'
  | 'working'
  | 'awaiting-permission'
  | 'error';

/** Where an agent stands in the debate right now. */
export type Verdict = 'AGREE' | 'REVISE';

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionKind =
  | 'exec' // run a shell command
  | 'edit' // write / patch files
  | 'tool' // generic tool call (MCP, web, etc.)
  | 'grant' // broaden the session's standing permissions
  | 'input'; // agent is asking the user a question

export interface PermissionOption {
  /** Stable id handed back to the adapter, which maps it to a native decision. */
  id: string;
  label: string;
  /** Single character the user presses. */
  key: string;
  tone?: 'allow' | 'deny' | 'danger';
}

export interface PermissionRequest {
  id: string;
  agent: AgentId;
  kind: PermissionKind;
  /** Tool or capability name, e.g. `Bash`, `shell`, `apply_patch`. */
  title: string;
  /** One-line gist — the command, the file path. */
  summary: string;
  /** Full payload: the diff, the argument object, the reason. */
  detail?: string;
  /** Why the agent says it needs this. */
  reason?: string;
  cwd?: string;
  options: PermissionOption[];
  createdAt: number;
}

export const ALLOW_ONCE: PermissionOption = {
  id: 'allow',
  label: 'Allow once',
  key: 'a',
  tone: 'allow',
};
export const ALLOW_SESSION: PermissionOption = {
  id: 'allow_session',
  label: 'Allow for session',
  key: 's',
  tone: 'allow',
};
export const DENY: PermissionOption = {
  id: 'deny',
  label: 'Deny',
  key: 'd',
  tone: 'deny',
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type DoetEvent =
  | { kind: 'status'; agent: AgentId; status: AgentStatus; note?: string }
  /** Streaming assistant text. */
  | { kind: 'text'; agent: AgentId; delta: string }
  /** A complete assistant message (authoritative; supersedes accumulated deltas). */
  | { kind: 'message'; agent: AgentId; text: string }
  /** Streaming reasoning/thinking summary. */
  | { kind: 'thinking'; agent: AgentId; delta: string }
  | {
      kind: 'tool';
      agent: AgentId;
      id: string;
      name: string;
      summary: string;
      phase: 'start' | 'end';
      ok?: boolean;
      result?: string;
    }
  /** Live stdout/stderr from a running command. */
  | { kind: 'output'; agent: AgentId; id: string; chunk: string }
  | { kind: 'permission'; agent: AgentId; request: PermissionRequest }
  | {
      kind: 'permission-resolved';
      agent: AgentId;
      id: string;
      optionId: string;
      label: string;
    }
  | { kind: 'usage'; agent: AgentId; usage: Usage }
  | { kind: 'error'; agent: AgentId; message: string; fatal?: boolean }
  /**
   * The prompt doet is about to hand this agent. Panes render it so each window
   * shows both halves of that agent's conversation, not just its replies.
   */
  | { kind: 'prompt'; agent: AgentId; text: string; label: string }
  /** Adapter finished a turn. `text` is the full final assistant message. */
  | { kind: 'turn-end'; agent: AgentId; text: string }
  /** A fresh underlying session was opened for one agent. */
  | { kind: 'session'; agent: AgentId; sessionId?: string; carried: HandoffMode }
  /** The summary agent published a new rolling gist. */
  | { kind: 'gist'; text: string; round: number }
  /** Conductor-level narration, shown in the relay log. */
  | { kind: 'relay'; from: AgentId | 'user'; to: AgentId; round: number; note: string }
  | { kind: 'debate'; phase: DebatePhase; round: number; note?: string }
  | { kind: 'log'; source: AgentId | 'doet'; message: string; level?: 'info' | 'warn' | 'error' };

export type DebatePhase =
  | 'idle'
  | 'opening'
  | 'exchanging'
  | 'converged'
  | 'synthesizing'
  | 'done'
  | 'stopped';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * What to carry into a freshly opened agent session.
 *
 * `gist` is the summary agent's rolling digest — small, and the reason the
 * summary agent exists. `full` is the agent's complete transcript so far, which
 * is faithful but re-pays for every token. `none` is a deliberate clean slate.
 */
export type HandoffMode = 'gist' | 'full' | 'none';

/**
 * When to retire an agent's session and open a new one. Long sessions drift and
 * get expensive; short ones forget. Neither default is right for everyone, so
 * this is the user's dial.
 */
export type SessionPolicy =
  | { mode: 'manual' }
  /** Rotate every N exchanges by that agent. */
  | { mode: 'rounds'; every: number }
  /** Rotate once the agent's session passes this many total tokens. */
  | { mode: 'tokens'; limit: number };

export interface AgentSessionSettings {
  policy: SessionPolicy;
  /** `ask` stops and prompts; the rest apply without interrupting. */
  handoff: HandoffMode | 'ask';
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** The id the user picked — what `/model` set and what config persists. */
  model: string;
  /**
   * What the CLI says it actually resolved that to (`sonnet` → `claude-sonnet-5`).
   * Kept apart from `model` on purpose: overwriting the requested id with the
   * resolved one used to make the selection un-round-trippable.
   */
  resolvedModel?: string;
  effort?: Effort;
  status: AgentStatus;
  cwd: string;
  /** Native permission/approval posture, phrased in the agent's own terms. */
  permissionMode: string;
  sessionId?: string;
  /** Bumped every time a new underlying session is opened. */
  sessionSeq: number;
  /** Turns taken in the *current* session, which is what a rounds policy counts. */
  sessionTurns: number;
  usage: Usage;
}

export interface TurnResult {
  agent: AgentId;
  /** Final assistant message, with any doet control markers stripped. */
  text: string;
  /** Verdict parsed out of the control marker, if the agent emitted one. */
  verdict: Verdict | null;
  usage: Usage;
  interrupted: boolean;
  error?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;

  start(): Promise<void>;
  /**
   * Send one user turn and resolve when the agent finishes responding.
   * `label` is what the pane shows above the prompt it renders.
   */
  send(prompt: string, label?: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Answer a pending permission request by option id. */
  resolvePermission(requestId: string, optionId: string): void;
  /** Throws if the model is not one this account can run. */
  setModel(model: string, effort?: Effort): Promise<void>;
  /** Models this agent will accept for `setModel`, as its own CLI reports them. */
  listModels(): Promise<ModelChoice[]>;
  setPermissionMode(mode: string): Promise<void>;
  listPermissionModes(): string[];
  /**
   * Retire the current session and open a fresh one. `carry` is prepended to
   * the next prompt rather than sent as a turn of its own, so a handoff costs
   * no extra round-trip.
   */
  newSession(carry?: string): Promise<void>;
  /**
   * Drop the live session so something else can own it, returning the id needed
   * to get it back. Null when there is no resumable session yet.
   *
   * This exists for the pane handover: two processes writing the same session
   * at once corrupts it, so doet lets go before the interactive CLI takes over.
   */
  releaseSession(): Promise<string | null>;
  /**
   * Re-attach to a session id — including one an interactive CLI has since
   * added turns to. The agent keeps whatever happened while doet was away.
   */
  resumeSession(sessionId: string): Promise<void>;
  /**
   * How to open this agent's current session in its own interactive CLI, or
   * null if there is nothing to open yet.
   */
  interactiveCommand(): { command: string; args: string[] } | null;
  /**
   * Branch the session and return the command that opens the branch, leaving
   * the live one untouched and running.
   *
   * This is the other half of `releaseSession`. Neither CLI can have one
   * session written by two processes at once, so there are exactly two honest
   * options: hand the session over (doet lets go, work comes back), or fork it
   * (nothing stops, work stays on the branch).
   */
  forkSession(): Promise<{ command: string; args: string[] } | null>;
  /** The agent's own transcript, as Markdown, for a `full` handoff. */
  history(): string;
  info(): AgentInfo;
  dispose(): Promise<void>;
}
