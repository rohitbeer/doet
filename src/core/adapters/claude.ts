import { randomUUID } from 'node:crypto';
import { query, type Query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Bus } from '../bus.js';
import { parseVerdict, stripVerdict, AGENT_LABELS } from '../relay.js';
import {
  ALLOW_ONCE,
  ALLOW_SESSION,
  DENY,
  type AgentAdapter,
  type AgentInfo,
  type AgentStatus,
  type Effort,
  type ModelChoice,
  type PermissionKind,
  type PermissionOption,
  type PermissionRequest,
  type TurnResult,
  type Usage,
} from '../types.js';
import { Deferred, renderHistory, summarizeValue, truncate, type HistoryEntry } from '../util.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

/** Tools whose permission prompt is really "may I edit this file". */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Kept off a read-only agent. This is a convenience so the model does not waste
 * turns reaching for tools; the guarantee is the blanket refusal in
 * `onPermission`, which holds for any tool whether or not it is named here.
 */
const READ_ONLY_DENY = [
  'Bash',
  'BashOutput',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
];

export interface ClaudeAdapterOptions {
  bus: Bus;
  cwd: string;
  model: string;
  effort?: Effort;
  permissionMode?: string;
  /**
   * Standing framing for the whole session, appended to Claude Code's own
   * system prompt. Everything that does not change between turns belongs here
   * rather than at the top of every prompt.
   */
  instructions?: string;
  /** Extra directories the agent may touch beyond `cwd`. */
  addDirs?: string[];
  /**
   * Refuses every tool call outright. Used for the summary agent, which only
   * reads text doet hands it — and which must never raise a permission prompt,
   * since it runs off to the side of the debate on its own bus, where nobody is
   * watching for one and nothing would ever answer it.
   */
  readOnly?: boolean;
}

/**
 * Drives Claude Code through the official Agent SDK in streaming-input mode.
 *
 * Streaming input is what makes a debate possible: the session stays alive
 * across turns, so round 4 still remembers round 1 without doet re-sending the
 * transcript. The trade-off is that the SDK owns the loop — we push prompts
 * into a queue that an async generator drains, and read the results off the
 * message stream, rather than calling a simple request/response function.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly label = AGENT_LABELS.claude;

  private readonly bus: Bus;
  private readonly opts: ClaudeAdapterOptions;

  private session: Query | null = null;
  private pump: Promise<void> | null = null;

  /** Prompts waiting to be handed to the SDK's input generator. */
  private readonly inbox: SDKUserMessage[] = [];
  private inboxWaiter: Deferred<void> | null = null;
  private closed = false;

  /** Resolves when the in-flight turn produces a `result` message. */
  private turn: Deferred<TurnResult> | null = null;
  private turnText = '';
  private interruptedTurn = false;

  private readonly pending = new Map<string, Deferred<PermissionResult>>();
  /** Tools the user chose to allow for the rest of the session. */
  private readonly sessionAllowed = new Set<string>();

  private status: AgentStatus = 'stopped';
  /** The id the user asked for (`sonnet`), never overwritten by the resolved one. */
  private model: string;
  private resolvedModel: string | undefined;
  private effort: Effort | undefined;
  private permissionMode: string;
  private sessionId: string | undefined;
  private usage: Usage = {};
  private models: ModelChoice[] = [];

  /** Everything said in the *current* session, for a `full` handoff. */
  private transcript: HistoryEntry[] = [];
  private sessionSeq = 0;
  private sessionTurns = 0;
  /** Prepended to the next prompt after a session rotation. */
  private carry: string | null = null;

  constructor(opts: ClaudeAdapterOptions) {
    this.bus = opts.bus;
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permissionMode ?? 'default';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.setStatus('starting');
    this.openSession();

    // The CLI publishes the models this account can actually run, which beats
    // shipping a hardcoded list that goes stale — and gives `/model` something
    // to validate a typo against.
    try {
      this.models = normalizeModels(await this.session!.supportedModels());
    } catch {
      // Older CLIs may not answer; switching still works, we just cannot offer
      // a picker for it.
      this.models = [];
    }

    // An effort carried over from config is worth applying up front rather than
    // silently waiting for the first `/model`.
    if (this.effort) await this.applyEffort(this.effort);

    this.setStatus('ready');
  }

  /**
   * Builds the SDK query. Separate from `start` so `newSession` can redo it,
   * and so a handover can rebuild it around an existing session id.
   */
  private openSession(resume?: string): void {
    this.closed = false;
    this.inbox.length = 0;
    this.resolvedModel = undefined;

    if (resume) {
      // Re-attaching to the same conversation, so the turn counter and the
      // transcript carry on rather than restarting.
      this.sessionId = resume;
    } else {
      this.sessionId = undefined;
      this.sessionTurns = 0;
      this.transcript = [];
      this.sessionSeq += 1;
    }

    this.session = query({
      prompt: this.inputStream(),
      options: {
        cwd: this.opts.cwd,
        model: this.model,
        ...(this.effort ? { effort: this.effort } : {}),
        ...(resume ? { resume } : {}),
        // Appended to the `claude_code` preset rather than replacing it, so the
        // agent keeps its normal behaviour and gains doet's framing on top.
        ...(this.opts.instructions
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: this.opts.instructions,
              },
            }
          : {}),
        permissionMode: this.permissionMode as never,
        additionalDirectories: this.opts.addDirs,
        // `disallowedTools` is the option that actually restricts; it saves the
        // model from reaching for tools that `onPermission` would refuse anyway.
        ...(this.opts.readOnly ? { disallowedTools: READ_ONLY_DENY } : {}),
        includePartialMessages: true,
        canUseTool: (toolName, input, options) =>
          this.onPermission(toolName, input, options),
      },
    });

    this.pump = this.consume().catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error));
    });
  }

  // -------------------------------------------------------------------------
  // Handover
  // -------------------------------------------------------------------------

  /**
   * Lets go of the session so `claude --resume` can own it. The SDK holds the
   * session open while it runs, and two writers would corrupt it.
   */
  async releaseSession(): Promise<string | null> {
    const id = this.sessionId ?? null;
    if (!id) return null;
    await this.closeSession();
    this.setStatus('stopped');
    return id;
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.setStatus('starting');
    this.openSession(sessionId);
    // Wait for the CLI to actually load the conversation, so the first prompt
    // after a handover is not sent into a session that is still booting.
    try {
      await this.session?.initializationResult();
    } catch {
      // Older CLIs may not answer the handshake; the session still works.
    }
    if (this.effort) await this.applyEffort(this.effort);
    this.setStatus('ready');
  }

  interactiveCommand(): { command: string; args: string[] } | null {
    if (!this.sessionId) return null;
    return { command: 'claude', args: ['--resume', this.sessionId] };
  }

  /**
   * The CLI does the branching itself at launch, so doet's session is never
   * touched and never has to pause.
   */
  async forkSession(): Promise<{ command: string; args: string[] } | null> {
    if (!this.sessionId) return null;
    return { command: 'claude', args: ['--resume', this.sessionId, '--fork-session'] };
  }

  /**
   * Retires this session and opens a fresh one. `carry` rides along on the next
   * prompt instead of being sent as a turn of its own — a handoff should not
   * cost an extra round-trip before the agent does any work.
   */
  async newSession(carry?: string): Promise<void> {
    await this.closeSession();
    this.openSession();
    this.carry = carry?.trim() ? carry.trim() : null;
    this.setStatus('ready');
    this.bus.emit({
      kind: 'session',
      agent: this.id,
      carried: carry ? 'full' : 'none',
    });
  }

  async dispose(): Promise<void> {
    await this.closeSession();
    this.setStatus('stopped');
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    this.inboxWaiter?.resolve();
    // Unblock anything still waiting on a permission answer, or the SDK's
    // stream will never drain.
    for (const [, deferred] of this.pending) {
      deferred.resolve({ behavior: 'deny', message: 'doet is shutting down.' });
    }
    this.pending.clear();
    try {
      await this.session?.return(undefined as never);
    } catch {
      // Already torn down.
    }
    await this.pump?.catch(() => {});
    this.session = null;
    this.pump = null;
  }

  // -------------------------------------------------------------------------
  // Input side
  // -------------------------------------------------------------------------

  /** Async generator the SDK pulls user turns from, one at a time. */
  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.inbox.length === 0) {
        this.inboxWaiter = new Deferred<void>();
        await this.inboxWaiter.promise;
        this.inboxWaiter = null;
        continue;
      }
      yield this.inbox.shift()!;
    }
  }

  async send(prompt: string, label = 'prompt'): Promise<TurnResult> {
    if (!this.session) throw new Error('Claude adapter is not started.');
    if (this.turn) throw new Error('Claude is already mid-turn.');

    // A pending handoff rides in front of the real prompt, once.
    const text = this.carry ? `${this.carry}\n\n---\n\n${prompt}` : prompt;
    this.carry = null;

    this.turnText = '';
    this.interruptedTurn = false;
    this.turn = new Deferred<TurnResult>();
    this.sessionTurns += 1;
    this.transcript.push({ role: 'user', text });
    this.setStatus('thinking');

    // The pane renders this, so each window shows what went in as well as what
    // came out.
    this.bus.emit({ kind: 'prompt', agent: this.id, text, label });

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    } as SDKUserMessage);
    this.inboxWaiter?.resolve();

    return this.turn.promise;
  }

  history(): string {
    return renderHistory(this.label, this.transcript);
  }

  async interrupt(): Promise<void> {
    this.interruptedTurn = true;
    // Deny anything on screen; an interrupt with a live prompt would otherwise
    // hang until the user answers a question they no longer care about.
    for (const [id, deferred] of this.pending) {
      deferred.resolve({ behavior: 'deny', message: 'Interrupted by the user.' });
      this.pending.delete(id);
    }
    await this.session?.interrupt();
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  private async onPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      toolUseID: string;
    },
  ): Promise<PermissionResult> {
    // A read-only agent runs on its own bus, off to the side of the debate.
    // Nothing is listening for its prompts, so a prompt here would block that
    // agent — and anything awaiting it — forever. Refuse without asking.
    //
    // `allowedTools: []` does not do this: that option is an auto-approve
    // allowlist, not a restriction, so an empty one changes nothing.
    if (this.opts.readOnly) {
      return {
        behavior: 'deny',
        message: 'You have no tools in this role. Answer from the text you were given.',
      };
    }

    if (this.sessionAllowed.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const id = randomUUID();
    const deferred = new Deferred<PermissionResult>();
    this.pending.set(id, deferred);

    const request: PermissionRequest = {
      id,
      agent: this.id,
      kind: classify(toolName),
      title: options.displayName ?? toolName,
      summary: options.title ?? summarizeValue(toolName, input),
      detail: describeInput(toolName, input),
      reason: options.decisionReason ?? options.description,
      cwd: this.opts.cwd,
      options: buildOptions(toolName),
      createdAt: Date.now(),
    };

    this.setStatus('awaiting-permission');
    this.bus.emit({ kind: 'permission', agent: this.id, request });

    // If the SDK gives up on this call, stop waiting on a human.
    const onAbort = () => {
      this.pending.delete(id);
      deferred.resolve({ behavior: 'deny', message: 'The request was cancelled.' });
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await deferred.promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      this.pending.delete(id);
      if (this.status === 'awaiting-permission') this.setStatus('working');
    }
  }

  resolvePermission(requestId: string, optionId: string): void {
    const deferred = this.pending.get(requestId);
    if (!deferred) return;
    this.pending.delete(requestId);

    if (optionId === 'deny') {
      deferred.resolve({
        behavior: 'deny',
        message: 'The user denied this from doet.',
      });
      return;
    }

    if (optionId.startsWith('allow_session:')) {
      // Remembered by doet rather than pushed into Claude's own rule store, so
      // "for this session" means this doet session and leaves no residue in
      // the user's settings files.
      const toolName = optionId.slice('allow_session:'.length);
      if (toolName) this.sessionAllowed.add(toolName);
    }

    deferred.resolve({ behavior: 'allow' });
  }

  // -------------------------------------------------------------------------
  // Output side
  // -------------------------------------------------------------------------

  private async consume(): Promise<void> {
    if (!this.session) return;

    for await (const message of this.session) {
      switch (message.type) {
        case 'system': {
          if (message.subtype === 'init') {
            this.sessionId = message.session_id;
            // What the CLI resolved our request to. Recorded beside `model`
            // rather than over it — overwriting `sonnet` with `claude-sonnet-5`
            // is what used to make a selection impossible to round-trip.
            this.resolvedModel = message.model ?? undefined;
          }
          break;
        }

        case 'stream_event': {
          const event = message.event as {
            type: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (event.type === 'content_block_delta' && event.delta) {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              this.setStatus('working');
              this.bus.emit({ kind: 'text', agent: this.id, delta: event.delta.text });
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              this.setStatus('thinking');
              this.bus.emit({ kind: 'thinking', agent: this.id, delta: event.delta.thinking });
            }
          }
          break;
        }

        case 'assistant': {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              // Authoritative copy of the turn's prose; deltas above are only
              // for the live view.
              this.turnText += block.text;
            } else if (block.type === 'tool_use') {
              this.setStatus('working');
              this.bus.emit({
                kind: 'tool',
                agent: this.id,
                id: block.id,
                name: block.name,
                summary: summarizeValue(block.name, block.input as Record<string, unknown>),
                phase: 'start',
              });
            }
          }
          break;
        }

        case 'user': {
          // Tool results come back as user-role messages.
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
                const b = block as { tool_use_id: string; is_error?: boolean; content?: unknown };
                this.bus.emit({
                  kind: 'tool',
                  agent: this.id,
                  id: b.tool_use_id,
                  name: '',
                  summary: '',
                  phase: 'end',
                  ok: !b.is_error,
                  result: truncate(renderToolResult(b.content), 2000),
                });
              }
            }
          }
          break;
        }

        case 'result': {
          this.finishTurn(message);
          break;
        }

        default:
          break;
      }
    }
  }

  private finishTurn(message: {
    subtype: string;
    is_error?: boolean;
    result?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    total_cost_usd?: number;
  }): void {
    const raw = message.subtype === 'success' && message.result ? message.result : this.turnText;
    const text = stripVerdict(raw).trim();

    this.usage = {
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
      cachedTokens: message.usage?.cache_read_input_tokens,
      costUsd: message.total_cost_usd,
    };
    this.transcript.push({ role: 'assistant', text });
    this.bus.emit({ kind: 'usage', agent: this.id, usage: this.usage });
    this.bus.emit({ kind: 'message', agent: this.id, text });
    this.bus.emit({ kind: 'turn-end', agent: this.id, text });
    this.setStatus('ready');

    const result: TurnResult = {
      agent: this.id,
      text,
      verdict: parseVerdict(raw),
      usage: this.usage,
      interrupted: this.interruptedTurn,
      error: message.is_error ? (message.result ?? 'The turn failed.') : undefined,
    };

    const turn = this.turn;
    this.turn = null;
    turn?.resolve(result);
  }

  private fail(message: string): void {
    this.setStatus('error');
    this.bus.emit({ kind: 'error', agent: this.id, message, fatal: true });
    const turn = this.turn;
    this.turn = null;
    turn?.resolve({
      agent: this.id,
      text: this.turnText,
      verdict: null,
      usage: this.usage,
      interrupted: false,
      error: message,
    });
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  async setModel(model: string, effort?: Effort): Promise<void> {
    const choice = this.models.find((m) => m.id === model || m.label === model);
    // Only reject when we have a list to reject against. An empty list means the
    // CLI never told us, not that everything is invalid.
    if (!choice && this.models.length > 0) {
      throw new Error(
        `${this.label} cannot run "${model}". Available: ${this.models.map((m) => m.id).join(', ')}`,
      );
    }
    const id = choice?.id ?? model;

    if (effort && choice?.efforts && !choice.efforts.includes(effort)) {
      throw new Error(
        `${choice.label} does not support ${effort} effort. Available: ${choice.efforts.join(', ')}`,
      );
    }

    await this.session?.setModel(id);
    this.model = id;
    this.resolvedModel = undefined; // Re-learned from the next init/turn.

    if (effort) await this.applyEffort(effort);
    this.bus.log(this.id, `Model set to ${id}${effort ? ` · ${effort} effort` : ''}.`);
    this.bus.emit({ kind: 'status', agent: this.id, status: this.status });
  }

  private async applyEffort(effort: Effort): Promise<void> {
    try {
      await this.session?.applyFlagSettings({ effortLevel: effort });
      this.effort = effort;
    } catch (error) {
      // A model without the dial is not a failure worth stopping a debate over.
      this.bus.log(
        this.id,
        `Could not set ${effort} effort: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  async listModels(): Promise<ModelChoice[]> {
    return this.models;
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.session?.setPermissionMode(mode as never);
    this.permissionMode = mode;
    this.bus.log(this.id, `Permission mode set to ${mode}.`);
  }

  listPermissionModes(): string[] {
    return [...PERMISSION_MODES];
  }

  info(): AgentInfo {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      resolvedModel: this.resolvedModel,
      effort: this.effort,
      status: this.status,
      cwd: this.opts.cwd,
      permissionMode: this.permissionMode,
      sessionId: this.sessionId,
      sessionSeq: this.sessionSeq,
      sessionTurns: this.sessionTurns,
      usage: this.usage,
    };
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bus.emit({ kind: 'status', agent: this.id, status });
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * The SDK reports a model as `{ value, displayName, supportedEffortLevels }`.
 * `value` is what `setModel` wants back, so that is the id doet keeps.
 */
function normalizeModels(models: unknown): ModelChoice[] {
  if (!Array.isArray(models)) return [];
  return models
    .map((raw): ModelChoice | null => {
      if (typeof raw === 'string') return { id: raw, label: raw };
      const m = raw as {
        value?: string;
        resolvedModel?: string;
        displayName?: string;
        description?: string;
        supportsEffort?: boolean;
        supportedEffortLevels?: Effort[];
      };
      if (!m.value) return null;
      return {
        id: m.value,
        label: m.displayName ?? m.value,
        description: m.description,
        efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
      };
    })
    .filter((m): m is ModelChoice => m !== null);
}

function classify(toolName: string): PermissionKind {
  if (toolName === 'Bash' || toolName === 'BashOutput') return 'exec';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  return 'tool';
}

function buildOptions(toolName: string): PermissionOption[] {
  return [
    ALLOW_ONCE,
    { ...ALLOW_SESSION, id: `allow_session:${toolName}` },
    DENY,
  ];
}

function describeInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return input.command;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    const body =
      typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.content === 'string'
          ? input.content
          : '';
    return body ? `${path}\n\n${truncate(body, 1200)}` : path;
  }
  return truncate(JSON.stringify(input, null, 2), 1200);
}

function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}
