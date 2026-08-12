import type { CliId, Effort, ModelChoice, Usage } from '../types.js';

/**
 * What doet needs to know about a coding CLI in order to drive it.
 *
 * Before DOET-004 there were two agents and the difference between them was
 * spelled out wherever it happened to matter: an `if (this.id === 'claude')` in
 * the adapter's argv, a `readClaude`/`readCodex` pair in the journal, another
 * fork in the recap, a two-key record for the labels, another for the colours.
 * Adding a third agent meant finding all of them, and adding a fourth meant
 * finding all of them again.
 *
 * So the differences live here instead, one file per CLI, and the rest of doet
 * asks. Two things make that harder than a table of flags, and both are
 * deliberate in the shape below:
 *
 *   Not every CLI can do everything. cline cannot have text appended to its
 *   system prompt — its `-s` *replaces* the prompt, which would lobotomise it —
 *   and kilo has no reasoning-effort dial at all. `supports` is how a definition
 *   says so, and doet asks before it offers the user a choice that cannot be
 *   honoured. The alternative is a picker that collects an answer and throws it
 *   away, which is how you get a run that quietly ignores the effort you set.
 *
 *   Not every CLI writes its transcript to a file. Claude and Codex do, so doet
 *   tails them. cline and kilo keep sessions in SQLite and hand them back
 *   through their own commands. `JournalReader` is the seam: what doet wants is
 *   "has a turn finished, what did it say, what did it cost", and where that
 *   answer comes from is the reader's business.
 */

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * How much the agent may do without stopping to ask.
 *
 * Two postures rather than each CLI's own vocabulary, because doet is choosing
 * on the user's behalf and has to mean the same thing in every pane. Each
 * definition translates: what Claude spells `--permission-mode acceptEdits`,
 * Codex spells as an approval policy plus a sandbox, cline as `--auto-approve`
 * and kilo as `--auto`.
 *
 * `ask` is co-code, where both agents edit the tree you are sitting in and
 * every change should stop. `accept-edits` is VS, where edits land in a
 * worktree of their own and approving each one adds nothing — but anything with
 * teeth outside that tree still stops and asks, in the agent's own pane.
 */
export type Autonomy = 'ask' | 'accept-edits';

export interface LaunchContext {
  cwd: string;
  /** The id handed to the CLI's model flag, or empty for its own default. */
  model: string;
  effort?: Effort;
  /**
   * Which credentials to bill, for the CLIs that route to many vendors.
   *
   * Claude and Codex have exactly one provider and ignore this. cline takes it
   * as `-P`, and kilo folds it into the model id (`anthropic/claude-opus-4`) —
   * which is why `supports.provider` exists and why the picker asks for one
   * before it asks for a model.
   */
  provider?: string;
  /**
   * Directories the agent may touch beyond `cwd`. VS uses this for the shared
   * git metadata a linked worktree needs in order to commit at all — and only
   * two of the four CLIs have a flag for it. See `supports.addDirs`.
   */
  addDirs: string[];
  /** doet's standing framing for this run. See `supports.systemPrompt`. */
  instructions?: string;
  autonomy: Autonomy;
  /** Reopen this session instead of starting a fresh one. */
  resume?: string;
}

export interface Capabilities {
  /**
   * The effort levels this CLI accepts, or null when it has no dial.
   *
   * A list rather than a boolean because the vocabularies genuinely differ:
   * Claude and Codex take all five, cline takes `none` through `xhigh` and has
   * no `max`, and kilo has none of them — it picks effort per model instead.
   */
  efforts: Effort[] | null;
  /** Whether a provider has to be chosen before a model means anything. */
  provider: boolean;
  /**
   * How doet's standing brief reaches the agent.
   *
   * `append` — the CLI has a flag that adds to its own system prompt.
   * `prompt` — it has no such flag, so the brief rides in front of the first
   *            request instead. Weaker: it is a message the agent can lose
   *            track of rather than a standing instruction, and it costs a
   *            little context on the first turn. It is also the only honest
   *            option, since the alternative — cline's `-s` — replaces the
   *            prompt that makes cline work at all.
   */
  systemPrompt: 'append' | 'prompt';
  /** Whether extra writable roots can be granted on the command line. */
  addDirs: boolean;
  /**
   * How much doet trusts the journal to tell it a turn has ended.
   *
   * `journal` — the CLI records a turn boundary doet can read, so a pane that
   *             has gone quiet is an agent thinking, or an agent holding a
   *             permission prompt, and doet keeps waiting.
   * `journal-or-quiet` — the boundary is inferred rather than recorded, so a
   *             journal that never reports one must not hang the run. When the
   *             session *and* the screen have both been still long enough, doet
   *             takes the turn as finished and carries on with whatever text it
   *             has. Weaker, and only used where the alternative is a slot that
   *             waits for ever.
   */
  turnEnd: 'journal' | 'journal-or-quiet';
  /**
   * Whether a session can be *branched* — opened a second time, from where it
   * stands, without the copy becoming part of the original.
   *
   * The dashboard's "open this agent's worktree" key needs it, and so does the
   * recap. A CLI without it can still be resumed; you just cannot look at a
   * session while it is being worked in without disturbing it.
   */
  fork: boolean;
}

// ---------------------------------------------------------------------------
// Reading what happened
// ---------------------------------------------------------------------------

/** What doet needs out of a session, in the vocabulary the rest of it uses. */
export interface JournalState {
  /** Turns whose end has been seen, oldest first. */
  turns: Array<{ text: string; at: number }>;
  /** True while the newest turn is still open. */
  working: boolean;
  usage: Usage;
  sessionId: string | null;
  /**
   * A number that changes whenever the session does, and is otherwise
   * meaningless.
   *
   * It is what tells a slow turn from a stalled one: `awaitTurn` watches this
   * rather than the clock, so an agent thinking hard with nothing on screen is
   * not mistaken for an agent waiting on a permission prompt. Records read, for
   * a file; rows and a timestamp, for a database. Only ever compared with its
   * own previous value.
   */
  size: number;
}

/**
 * Where doet learns what an agent did.
 *
 * `handle` is opaque and belongs to the reader: a transcript path for the CLIs
 * that write one, a session id for the ones that do not. Nothing above this
 * interface looks inside it.
 *
 * Every method is async even where the work is a synchronous file read, because
 * two of the four readers shell out to the CLI itself and the callers must not
 * have to know which kind they are holding.
 */
export interface JournalReader {
  /**
   * Sessions that existed before doet started a pane.
   *
   * Handed back to `find` so that "the session doet just opened" means one that
   * was not there a moment ago, rather than whichever is newest. Codex needs
   * this badly — it files every session on the machine under one dated tree —
   * and so does kilo, whose database is shared by every project at once.
   */
  known(cwd: string): Promise<Set<string>>;
  /** The session this pane opened, or null if it has not appeared yet. */
  find(cwd: string, since: number, known: Set<string>): Promise<string | null>;
  /** The CLI's own id for a session, for `--resume` and for forking. */
  sessionId(handle: string): Promise<string | null>;
  read(handle: string): Promise<JournalState>;
  /**
   * How long to wait between reads.
   *
   * Not a constant, because the readers cost wildly different amounts. Tailing
   * a file is free and can be done four times a second. Asking a CLI is a
   * process launch — a hundred milliseconds of Node startup before it has read
   * anything — so those readers ask far less often and accept being a beat late
   * in exchange for not spawning six hundred processes an hour per agent.
   */
  readonly pollMs: number;
}

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/** One selectable set of credentials, for the CLIs that route to many vendors. */
export interface ProviderChoice {
  id: string;
  label: string;
  description?: string;
  /** False when the CLI knows this provider but has no credentials for it. */
  configured?: boolean;
}

export interface CliDefinition {
  id: CliId;
  label: string;
  /** The binary that has to be on PATH. */
  command: string;
  /** This agent's colour, everywhere it appears. */
  colour: string;
  supports: Capabilities;
  /** The argv that starts an interactive session with the selection baked in. */
  launch(context: LaunchContext): string[];
  /**
   * How to open a *copy* of a session, or null when the CLI cannot.
   *
   * Used for the recap — a question put to a branch never becomes a turn the
   * agent remembers taking — and by the dashboard, to drop you into an agent's
   * worktree with its session open beside you while the run carries on.
   */
  fork(sessionId: string, cwd: string): { command: string; args: string[] } | null;
  /**
   * Models this CLI will accept, asked of the CLI itself where it can answer.
   *
   * Empty is a valid answer and means "doet does not know" rather than "there
   * are none" — the model is then whatever the user typed or whatever the CLI
   * defaults to, and a wrong id fails in that agent's own pane with a better
   * message than any doet could invent.
   */
  models(provider?: string): Promise<ModelChoice[]>;
  providers(): Promise<ProviderChoice[]>;
  journal: JournalReader;
  /**
   * How to ask this agent for its own account of what it just did, or null when
   * there is no way to ask that would not disturb the session it is describing.
   *
   * Null is a real answer and stays null: doet would rather show no summary
   * line than one written by an agent that has been handed a copy of its own
   * log and started from nothing. That failure is not hypothetical — a run's
   * closing record once came back as "a list of available but uninstalled
   * plugins was provided", which was Codex faithfully describing the empty
   * context it had been given.
   */
  recap(request: RecapRequest): RecapPlan | null;
}

export interface RecapRequest {
  sessionId: string;
  cwd: string;
  /** What to ask, already worded for whether it can see the session. */
  prompt: string;
  /** A file the CLI may be told to write its answer to, for the ones that can. */
  lastMessagePath: string;
}

export interface RecapPlan {
  command: string;
  args: string[];
  /**
   * Where the answer will be.
   *
   * `json`  — stdout is one JSON object with the answer in it, and the id of
   *           whatever throwaway session it was written in.
   * `file`  — the CLI was told to write the answer to `lastMessagePath`,
   *           because its stdout is a transcript rather than an answer.
   * `text`  — stdout is the answer.
   */
  read: 'json' | 'file' | 'text';
  /**
   * Whether asking leaves a copy of the session on disk for doet to remove.
   *
   * Only Claude's fork does, and it is a real file in `~/.claude/projects` —
   * once per exchange, per run, for as long as you use doet, if nobody clears
   * it up.
   */
  leavesFork: boolean;
}
