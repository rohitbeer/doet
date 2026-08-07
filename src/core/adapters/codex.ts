import { randomUUID } from 'node:crypto';
import type { Bus } from '../bus.js';
import { AGENT_LABELS } from '../relay.js';
import {
  ALLOW_ONCE,
  ALLOW_SESSION,
  DENY,
  type AgentAdapter,
  type AgentInfo,
  type AgentStatus,
  type Effort,
  type HandoffMode,
  type ModelChoice,
  type PermissionOption,
  type PermissionRequest,
  type TurnResult,
  type Usage,
} from '../types.js';
import { Deferred, oneLine, renderHistory, truncate, type HistoryEntry } from '../util.js';
import { JsonRpcClient } from './jsonrpc.js';

/**
 * Codex's `approvalPolicy`. `untrusted` prompts for anything outside a known-safe
 * set, `on-request` lets the model ask when it wants to escape the sandbox, and
 * `never` runs unattended. doet defaults to `untrusted` — the whole point is
 * that the human sees the prompts.
 */
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/**
 * Thread items that are not tool calls and should not show up as one.
 * `userMessage` in particular is Codex echoing back the prompt doet just sent,
 * which reads as a phantom tool call in the pane.
 */
const QUIET_ITEMS = new Set(['agentMessage', 'reasoning', 'userMessage', 'plan', 'hookPrompt']);

export interface CodexAdapterOptions {
  bus: Bus;
  cwd: string;
  /**
   * Additional absolute paths the Codex sandbox may write. VS uses this for
   * the repository's shared git metadata: a linked worktree cannot create
   * commits or update its branch without it.
   */
  workspaceRoots?: string[];
  model: string;
  effort?: Effort;
  approvalPolicy?: string;
  sandbox?: string;
  /**
   * Standing framing for the whole thread, sent as `developerInstructions`.
   * Everything that does not change between turns belongs here rather than at
   * the top of every prompt.
   */
  instructions?: string;
  /**
   * Refuses every approval request outright, for an agent running off to the
   * side of the session where no prompt would ever be seen or answered.
   */
  readOnly?: boolean;
  /** Path to the codex binary. */
  command?: string;
}

interface ThreadItem {
  type: string;
  id: string;
  text?: string;
  command?: string;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Drives Codex through `codex app-server` — the JSON-RPC protocol its own
 * desktop and IDE clients use.
 *
 * `codex exec --json` would have been easier, but it is one-shot and cannot ask
 * the user anything: approvals are resolved by policy, not by a human. Since
 * doet exists to put both agents' permission prompts in front of you, the
 * app-server is the only honest option.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly label = AGENT_LABELS.codex;

  private readonly bus: Bus;
  private readonly opts: CodexAdapterOptions;
  private rpc: JsonRpcClient | null = null;

  private threadId: string | null = null;
  private turn: Deferred<TurnResult> | null = null;
  private turnText = '';
  private interruptedTurn = false;

  private readonly pending = new Map<string, Deferred<unknown>>();
  /** Approval kinds the user green-lit for the rest of the session. */
  private readonly sessionAllowed = new Set<string>();

  private status: AgentStatus = 'stopped';
  private model: string;
  private effort: Effort | undefined;
  private approvalPolicy: string;
  private sandbox: string;
  private usage: Usage = {};
  private models: ModelChoice[] = [];

  /** Everything said in the *current* thread, for a `full` handoff. */
  private transcript: HistoryEntry[] = [];
  private sessionSeq = 0;
  private sessionTurns = 0;
  /** Prepended to the next prompt after a session rotation. */
  private carry: string | null = null;

  constructor(opts: CodexAdapterOptions) {
    this.bus = opts.bus;
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    this.approvalPolicy = opts.approvalPolicy ?? 'untrusted';
    this.sandbox = opts.sandbox ?? 'workspace-write';
  }

  /**
   * Extra writable paths for a `workspace-write` thread, as a per-thread config
   * override.
   *
   * VS mode needs this: each agent works in a `git worktree`, whose `.git` is a
   * file pointing at `<repo>/.git/worktrees/<slot>`. That path is outside the
   * agent's cwd, so under `workspace-write` every git write the agent attempts
   * — `git add`, `git commit`, `git stash` — is refused by the sandbox.
   *
   * `thread/start` also accepts a `runtimeWorkspaceRoots` field that does the
   * same job, and it is the more purpose-built of the two. It is not used,
   * because the app-server gates it:
   *
   *     thread/start.runtimeWorkspaceRoots requires experimentalApi capability
   *
   * and the only way to unlock it is to declare `experimentalApi` at
   * `initialize` — which opts this client into experimental *notifications*
   * too, the very messages `handleNotification` parses to draw the panes. A
   * sandbox tweak is not worth putting the whole event stream on an
   * experimental footing. `config` is an ordinary, ungated parameter.
   *
   * These are additional roots: cwd is already writable and is not repeated.
   */
  private sandboxConfig(): Record<string, unknown> | undefined {
    const roots = this.opts.workspaceRoots?.filter((root) => root && root !== this.opts.cwd);
    if (!roots?.length) return undefined;
    return { sandbox_workspace_write: { writable_roots: [...new Set(roots)] } };
  }

  /**
   * Opens a thread with the sandbox override, and again without it if this
   * app-server will not take it.
   *
   * A Codex that rejects the parameter must not be able to stop a VS run from
   * starting — but it also must not do so quietly, because the agent will then
   * hit a refusal the first time it touches git and nothing on screen would say
   * why. So the retry is loud.
   */
  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.rpc) throw new Error('Codex adapter is not started.');
    if (!config) return this.rpc.request<T>(method, params);

    try {
      return await this.rpc.request<T>(method, { ...params, config });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Retry only when the override itself is what this Codex rejected. An
      // auth, model, thread-lock, or server failure must retain its real error
      // instead of being mislabeled as a sandbox compatibility problem.
      if (!/(?:config|sandbox_workspace_write|writable_roots|unknown field)/i.test(message)) {
        throw error;
      }
      this.bus.log(
        this.id,
        `Codex would not take the sandbox override (${message}). Continuing without it — git commands inside the worktree may be refused by the sandbox.`,
        'warn',
      );
      return this.rpc.request<T>(method, params);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.setStatus('starting');
    await this.connect();

    // Ask what this account can actually run before starting a thread. Model
    // availability depends on the plan — a hardcoded default gets rejected at
    // the first turn with a 400, which is a confusing place to find out.
    try {
      const models = await this.rpc!.request<{ data?: RawCodexModel[] }>('model/list', {});
      const entries = (models?.data ?? []).filter((m) => !m.hidden);
      this.models = entries.map(normalizeModel).filter((m): m is ModelChoice => m !== null);

      const fallback = this.models.find((m) => m.isDefault) ?? this.models[0];
      if (!this.model && fallback) {
        this.model = fallback.id;
        this.effort ??= fallback.defaultEffort;
      } else if (this.model && !this.models.some((m) => m.id === this.model)) {
        const wanted = this.model;
        this.model = fallback?.id ?? '';
        this.effort = fallback?.defaultEffort;
        this.bus.log(
          this.id,
          `${wanted} is not available on this account; using ${this.model || 'the default'}.`,
          'warn',
        );
      }
    } catch {
      // Not fatal — we just won't have a picker for /model.
    }

    await this.openThread();
    this.setStatus('ready');
  }

  /** Spawns `codex app-server` and completes the handshake. */
  private async connect(): Promise<void> {
    this.rpc = new JsonRpcClient({
      command: this.opts.command ?? 'codex',
      args: ['app-server'],
      cwd: this.opts.cwd,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onServerRequest(method, params),
      onError: (message) => {
        this.bus.emit({ kind: 'error', agent: this.id, message });
      },
      onExit: (code) => {
        this.setStatus('stopped');
        this.failTurn(`codex app-server exited with code ${code ?? 'null'}`);
      },
    });
    this.rpc.start();

    await this.rpc.request('initialize', {
      clientInfo: { name: 'doet', title: 'doet', version: '0.1.0' },
      capabilities: null,
    });
    // The protocol expects this handshake ack before it will start a thread.
    this.rpc.notify('initialized', {});
  }

  // -------------------------------------------------------------------------
  // Handover
  // -------------------------------------------------------------------------

  /**
   * Lets go of the thread so `codex resume` can own it. The app-server holds
   * the thread open, so the whole server is stopped rather than unsubscribed —
   * two owners writing one thread is not worth the cleverness.
   */
  async releaseSession(): Promise<string | null> {
    const id = this.threadId;
    if (!id) return null;
    this.rpc?.stop();
    this.rpc = null;
    this.setStatus('stopped');
    return id;
  }

  async resumeSession(threadId: string): Promise<void> {
    this.setStatus('starting');
    await this.connect();
    await this.request(
      'thread/resume',
      {
        threadId,
        cwd: this.opts.cwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        ...(this.model ? { model: this.model } : {}),
        // Re-asserted on resume, or a reopened thread loses the framing.
        ...(this.opts.instructions ? { developerInstructions: this.opts.instructions } : {}),
      },
      this.sandboxConfig(),
    );
    // Same conversation, so the turn counter and transcript carry on.
    this.threadId = threadId;
    this.setStatus('ready');
  }

  interactiveCommand(): { command: string; args: string[] } | null {
    if (!this.threadId) return null;
    return { command: this.opts.command ?? 'codex', args: ['resume', this.threadId] };
  }

  /**
   * Codex threads are server-side, so the branch is minted by an app-server
   * rather than at launch — but not by *this* one.
   *
   * Whichever app-server calls `thread/fork` becomes the new thread's active
   * writer, Codex permits exactly one, and `thread/unsubscribe` does not give
   * it up. Forking from doet's own server would therefore hand back an id that
   * the new window is refused ("already has an active writer"). So the branch
   * is cut by a throwaway server that is stopped immediately, taking its lock
   * with it. Reading the source thread needs no lock, so the live one carries
   * on untouched — no interrupt, no pause.
   */
  async forkSession(): Promise<{ command: string; args: string[] } | null> {
    if (!this.threadId) return null;
    const command = this.opts.command ?? 'codex';

    const scratch = new JsonRpcClient({
      command,
      args: ['app-server'],
      cwd: this.opts.cwd,
      onNotification: () => {},
      onRequest: async () => ({}),
      onError: () => {},
      onExit: () => {},
    });

    try {
      scratch.start();
      await scratch.request('initialize', {
        clientInfo: { name: 'doet', title: 'doet', version: '0.1.0' },
        capabilities: null,
      });
      scratch.notify('initialized', {});

      const forked = await scratch.request<{ thread?: { id?: string } }>('thread/fork', {
        threadId: this.threadId,
        cwd: this.opts.cwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        ...(this.model ? { model: this.model } : {}),
        // Persistent, or the branch exists only inside a server about to die.
        ephemeral: false,
      });

      const id = forked?.thread?.id;
      return id ? { command, args: ['resume', id] } : null;
    } finally {
      scratch.stop();
    }
  }

  /** Starts a thread with the current model and posture. */
  private async openThread(): Promise<void> {
    if (!this.rpc) throw new Error('Codex adapter is not started.');

    const params = {
      // Omit entirely when unknown so Codex falls back to its own default.
      ...(this.model ? { model: this.model } : {}),
      ...(this.opts.instructions ? { developerInstructions: this.opts.instructions } : {}),
      cwd: this.opts.cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
    };
    const config = this.sandboxConfig();

    const started = await this.request<{ thread?: { id?: string } }>(
      'thread/start',
      params,
      config,
    );
    this.threadId = started?.thread?.id ?? null;
    if (!this.threadId) throw new Error('codex did not return a thread id');

    this.sessionSeq += 1;
    this.sessionTurns = 0;
    this.usage = {};
    this.transcript = [];
  }

  /**
   * Retires this thread and opens a fresh one. Codex threads are server-side,
   * so this is a new `thread/start` rather than a process restart.
   */
  async newSession(carry?: string, carried: HandoffMode = carry ? 'full' : 'none'): Promise<void> {
    await this.openThread();
    this.carry = carry?.trim() ? carry.trim() : null;
    this.setStatus('ready');
    this.bus.emit({
      kind: 'session',
      agent: this.id,
      sessionId: this.threadId ?? undefined,
      carried,
    });
  }

  async setCwd(cwd: string): Promise<void> {
    if (cwd === this.opts.cwd) return;
    if (this.turn) throw new Error('Cannot move Codex while it is mid-turn.');

    const threadId = this.threadId;
    this.rpc?.stop();
    this.rpc = null;
    this.opts.cwd = cwd;
    this.setStatus('starting');
    await this.connect();
    if (threadId) {
      await this.request(
        'thread/resume',
        {
          threadId,
          cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          ...(this.model ? { model: this.model } : {}),
          ...(this.opts.instructions ? { developerInstructions: this.opts.instructions } : {}),
        },
        this.sandboxConfig(),
      );
      this.threadId = threadId;
    } else {
      await this.openThread();
    }
    this.setStatus('ready');
  }

  async dispose(): Promise<void> {
    for (const [, deferred] of this.pending) {
      deferred.resolve({ decision: 'cancel' });
    }
    this.pending.clear();
    this.rpc?.stop();
    this.rpc = null;
    this.setStatus('stopped');
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async send(prompt: string, label = 'prompt'): Promise<TurnResult> {
    if (!this.rpc || !this.threadId) throw new Error('Codex adapter is not started.');
    if (this.turn) throw new Error('Codex is already mid-turn.');

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

    await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      // No workspace roots here. `turn/start` takes a whole `sandboxPolicy`
      // rather than a list of roots, and re-asserting one every turn would
      // overwrite the thread's posture with a copy doet reconstructed. The
      // roots belong to the worktree the thread was opened on, not to a turn.
      // Both are per-turn overrides in the app-server protocol, so the current
      // selection is re-asserted on every turn rather than only at thread start.
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      approvalPolicy: this.approvalPolicy,
    });

    return this.turn.promise;
  }

  history(): string {
    return renderHistory(this.label, this.transcript);
  }

  async interrupt(): Promise<void> {
    this.interruptedTurn = true;
    for (const [id, deferred] of this.pending) {
      deferred.resolve({ decision: 'cancel' });
      this.pending.delete(id);
    }
    if (this.rpc && this.threadId) {
      try {
        await this.rpc.request('turn/interrupt', { threadId: this.threadId });
      } catch {
        // The turn may have already finished on its own.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Server → client requests (approvals)
  // -------------------------------------------------------------------------

  private async onServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Record<string, unknown>;

    // Same reasoning as the Claude adapter: a read-only agent runs on its own
    // bus with nobody watching, so an approval request would hang it and
    // everything awaiting it. `approvalPolicy: never` should prevent these
    // arriving at all — this makes it impossible rather than unlikely.
    if (this.opts.readOnly) {
      return { decision: 'decline' };
    }

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval':
        return this.ask({
          key: 'exec',
          kind: 'exec',
          title: 'Shell command',
          summary: oneLine(String(params.command ?? 'a command')),
          detail: String(params.command ?? ''),
          reason: params.reason ? String(params.reason) : undefined,
          cwd: params.cwd ? String(params.cwd) : undefined,
          accept: 'accept',
          acceptSession: 'acceptForSession',
          decline: 'decline',
        });

      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
        return this.ask({
          key: 'edit',
          kind: 'edit',
          title: 'File change',
          summary: describeChanges(params),
          detail: renderPatch(params),
          reason: params.reason ? String(params.reason) : undefined,
          accept: 'accept',
          acceptSession: 'acceptForSession',
          decline: 'decline',
        });

      case 'item/permissions/requestApproval':
        // A request to broaden the session's standing permissions. Deliberately
        // offered without an "allow for session" shortcut — the grant already is
        // the session-wide change.
        return this.askPermissionGrant(params);

      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        return this.ask({
          key: 'input',
          kind: 'input',
          title: method.startsWith('mcp') ? 'MCP server request' : 'Agent question',
          summary: oneLine(
            String(params.message ?? params.prompt ?? params.question ?? 'The agent needs input.'),
          ),
          detail: truncate(JSON.stringify(params, null, 2), 1200),
          accept: 'accept',
          decline: 'decline',
        });

      case 'item/tool/call':
        // A tool doet does not implement. Declining is correct and keeps the
        // turn moving rather than hanging.
        return { error: 'doet does not host client-side tools.' };

      default:
        // Unknown request types must still be answered or the turn stalls.
        this.bus.log(this.id, `Unhandled app-server request: ${method}`, 'warn');
        return {};
    }
  }

  private async ask(spec: {
    key: string;
    kind: PermissionRequest['kind'];
    title: string;
    summary: string;
    detail?: string;
    reason?: string;
    cwd?: string;
    accept: string;
    acceptSession?: string;
    decline: string;
  }): Promise<unknown> {
    if (spec.acceptSession && this.sessionAllowed.has(spec.key)) {
      return { decision: spec.accept };
    }

    const id = randomUUID();
    const deferred = new Deferred<unknown>();
    this.pending.set(id, deferred);

    const options: PermissionOption[] = spec.acceptSession
      ? [
          { ...ALLOW_ONCE, id: `d:${spec.accept}` },
          { ...ALLOW_SESSION, id: `s:${spec.acceptSession}:${spec.key}` },
          { ...DENY, id: `d:${spec.decline}` },
        ]
      : [
          { ...ALLOW_ONCE, id: `d:${spec.accept}` },
          { ...DENY, id: `d:${spec.decline}` },
        ];

    const request: PermissionRequest = {
      id,
      agent: this.id,
      kind: spec.kind,
      title: spec.title,
      summary: spec.summary,
      detail: spec.detail,
      reason: spec.reason,
      cwd: spec.cwd ?? this.opts.cwd,
      options,
      createdAt: Date.now(),
    };

    this.setStatus('awaiting-permission');
    this.bus.emit({ kind: 'permission', agent: this.id, request });

    try {
      return await deferred.promise;
    } finally {
      this.pending.delete(id);
      if (this.status === 'awaiting-permission') this.setStatus('working');
    }
  }

  private async askPermissionGrant(params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    const deferred = new Deferred<unknown>();
    this.pending.set(id, deferred);

    this.bus.emit({
      kind: 'permission',
      agent: this.id,
      request: {
        id,
        agent: this.id,
        kind: 'grant',
        title: 'Expand permissions',
        summary: oneLine(String(params.reason ?? 'Codex wants broader access.')),
        detail: truncate(JSON.stringify(params, null, 2), 1500),
        cwd: this.opts.cwd,
        options: [
          { id: 'grant', label: 'Grant', key: 'a', tone: 'danger' },
          { ...DENY, id: 'refuse' },
        ],
        createdAt: Date.now(),
      },
    });
    this.setStatus('awaiting-permission');

    try {
      return await deferred.promise;
    } finally {
      this.pending.delete(id);
      if (this.status === 'awaiting-permission') this.setStatus('working');
    }
  }

  resolvePermission(requestId: string, optionId: string): void {
    const deferred = this.pending.get(requestId);
    if (!deferred) return;
    this.pending.delete(requestId);

    if (optionId === 'grant') {
      // Hand back the profile Codex proposed, scoped to this thread.
      deferred.resolve({ permissions: {}, scope: 'thread' });
      return;
    }
    if (optionId === 'refuse') {
      deferred.resolve({ permissions: {}, scope: 'none' });
      return;
    }

    // Encoded as `d:<decision>` or `s:<decision>:<key>` when building options.
    const [prefix, decision, key] = optionId.split(':');
    if (prefix === 's' && key) this.sessionAllowed.add(key);
    deferred.resolve({ decision: decision ?? 'decline' });
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  private onNotification(method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = String(params.delta ?? '');
        if (delta) {
          this.setStatus('working');
          this.bus.emit({ kind: 'text', agent: this.id, delta });
        }
        break;
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = String(params.delta ?? '');
        if (delta) {
          this.setStatus('thinking');
          this.bus.emit({ kind: 'thinking', agent: this.id, delta });
        }
        break;
      }

      case 'item/started': {
        const item = params.item as ThreadItem | undefined;
        if (item && !QUIET_ITEMS.has(item.type)) {
          this.setStatus('working');
          this.bus.emit({
            kind: 'tool',
            agent: this.id,
            id: item.id,
            name: item.type,
            summary: describeItem(item),
            phase: 'start',
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params.item as ThreadItem | undefined;
        if (!item) break;
        if (item.type === 'agentMessage') {
          // Authoritative text for the turn; deltas were only for the live view.
          this.turnText += item.text ?? '';
        } else if (!QUIET_ITEMS.has(item.type)) {
          this.bus.emit({
            kind: 'tool',
            agent: this.id,
            id: item.id,
            name: item.type,
            summary: describeItem(item),
            phase: 'end',
            ok: item.status !== 'failed',
            result: typeof item.aggregatedOutput === 'string'
              ? truncate(item.aggregatedOutput, 2000)
              : undefined,
          });
        }
        break;
      }

      case 'item/commandExecution/outputDelta': {
        // This thread-item notification is already UTF-8 text. Never guess
        // from its contents: ordinary output such as "YWJjZGVmZ2hp" is valid
        // plain text and must not be silently decoded.
        const chunk = typeof params.delta === 'string' ? params.delta : '';
        if (chunk) {
          this.bus.emit({
            kind: 'output',
            agent: this.id,
            id: String(params.itemId ?? ''),
            chunk,
          });
        }
        break;
      }

      case 'command/exec/outputDelta': {
        // The standalone command channel names and documents this field as
        // base64 in the app-server protocol; its encoding is structural.
        const chunk = decodeBase64Chunk(params.deltaBase64);
        if (chunk) {
          this.bus.emit({
            kind: 'output',
            agent: this.id,
            id: String(params.itemId ?? ''),
            chunk,
          });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        // Shape is `{ tokenUsage: { total: {...}, last: {...} } }` — `total` is
        // the running count for the thread, which is what we want in the pane.
        const envelope = params.tokenUsage as
          | { total?: Record<string, number>; last?: Record<string, number> }
          | undefined;
        const usage = envelope?.total ?? envelope?.last;
        if (usage) {
          this.usage = {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedInputTokens,
            totalTokens: usage.totalTokens,
          };
          this.bus.emit({ kind: 'usage', agent: this.id, usage: this.usage });
        }
        break;
      }

      case 'turn/completed': {
        this.finishTurn(params.turn as { status?: string; error?: { message?: string } } | undefined);
        break;
      }

      case 'error': {
        const error = params.error as { message?: string } | undefined;
        const message = error?.message ?? 'Codex reported an error.';
        this.bus.emit({ kind: 'error', agent: this.id, message });
        if (!params.willRetry) this.failTurn(message);
        break;
      }

      case 'model/rerouted': {
        this.bus.log(this.id, `Model rerouted to ${String(params.model ?? 'another model')}.`, 'warn');
        break;
      }

      default:
        break;
    }
  }

  private finishTurn(turn?: { status?: string; error?: { message?: string } }): void {
    const raw = this.turnText;
    const text = raw.trim();

    this.transcript.push({ role: 'assistant', text });
    this.bus.emit({ kind: 'message', agent: this.id, text });
    this.bus.emit({ kind: 'turn-end', agent: this.id, text });
    this.setStatus('ready');

    const pending = this.turn;
    this.turn = null;
    pending?.resolve({
      agent: this.id,
      text,
      verdict: null,
      usage: this.usage,
      interrupted: this.interruptedTurn,
      error: turn?.status === 'failed' ? (turn.error?.message ?? 'The turn failed.') : undefined,
    });
  }

  private failTurn(message: string): void {
    const pending = this.turn;
    if (!pending) return;
    this.turn = null;
    pending.resolve({
      agent: this.id,
      text: this.turnText.trim(),
      verdict: null,
      usage: this.usage,
      interrupted: this.interruptedTurn,
      error: message,
    });
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  async setModel(model: string, effort?: Effort): Promise<void> {
    const choice = this.models.find((m) => m.id === model || m.label === model);
    // Only reject when we have a list to reject against. An empty list means
    // `model/list` failed, not that everything is invalid.
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

    // Codex takes model and effort as overrides on `turn/start`, so recording
    // them here is the whole change — they apply from the next turn.
    this.model = choice?.id ?? model;
    this.effort = effort ?? choice?.defaultEffort ?? this.effort;
    this.bus.log(
      this.id,
      `Model set to ${this.model}${this.effort ? ` · ${this.effort} effort` : ''} (applies from the next turn).`,
    );
    this.bus.emit({ kind: 'status', agent: this.id, status: this.status });
  }

  async listModels(): Promise<ModelChoice[]> {
    return this.models;
  }

  async setPermissionMode(mode: string): Promise<void> {
    if ((APPROVAL_POLICIES as readonly string[]).includes(mode)) {
      this.approvalPolicy = mode;
    } else if ((SANDBOX_MODES as readonly string[]).includes(mode)) {
      this.sandbox = mode;
    } else {
      throw new Error(`Unknown Codex mode: ${mode}`);
    }
    this.bus.log(this.id, `Approval policy: ${this.approvalPolicy}, sandbox: ${this.sandbox}.`);
  }

  listPermissionModes(): string[] {
    return [...APPROVAL_POLICIES, ...SANDBOX_MODES];
  }

  info(): AgentInfo {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      effort: this.effort,
      status: this.status,
      cwd: this.opts.cwd,
      permissionMode: `${this.approvalPolicy}/${this.sandbox}`,
      sessionId: this.threadId ?? undefined,
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

interface RawCodexModel {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}

/**
 * `model/list` returns each model with its own set of reasoning-effort tiers.
 * Codex publishes an `ultra` tier that doet's shared vocabulary does not carry,
 * so anything outside the five common levels is dropped rather than offered and
 * then rejected at `turn/start`.
 */
function normalizeModel(raw: RawCodexModel): ModelChoice | null {
  const id = raw.id ?? raw.model;
  if (!id) return null;

  const efforts = (raw.supportedReasoningEfforts ?? [])
    .map((e) => e.reasoningEffort)
    .filter((e): e is Effort => isEffort(e));

  return {
    id,
    label: raw.displayName ?? id,
    description: raw.description,
    efforts: efforts.length > 0 ? efforts : undefined,
    defaultEffort: isEffort(raw.defaultReasoningEffort) ? raw.defaultReasoningEffort : undefined,
    isDefault: raw.isDefault,
  };
}

function isEffort(value: unknown): value is Effort {
  return (
    value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
  );
}

function describeItem(item: ThreadItem): string {
  if (typeof item.command === 'string') return oneLine(item.command);
  if (typeof item.path === 'string') return oneLine(item.path);
  if (typeof item.text === 'string') return oneLine(item.text);
  if (typeof item.toolName === 'string') return oneLine(item.toolName as string);
  return item.type;
}

function describeChanges(params: Record<string, unknown>): string {
  const changes = params.changes as Record<string, unknown> | undefined;
  if (changes && typeof changes === 'object') {
    const paths = Object.keys(changes);
    if (paths.length === 1) return paths[0]!;
    if (paths.length > 1) return `${paths.length} files: ${paths.slice(0, 3).join(', ')}…`;
  }
  if (typeof params.grantRoot === 'string') return `write access under ${params.grantRoot}`;
  return 'edit files';
}

function renderPatch(params: Record<string, unknown>): string {
  const changes = params.changes as Record<string, { diff?: string }> | undefined;
  if (!changes) return truncate(JSON.stringify(params, null, 2), 1500);
  return truncate(
    Object.entries(changes)
      .map(([path, change]) => `--- ${path}\n${change?.diff ?? ''}`)
      .join('\n\n'),
    2000,
  );
}

function decodeBase64Chunk(value: unknown): string {
  if (typeof value === 'string') return Buffer.from(value, 'base64').toString('utf8');
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString('utf8');
  return '';
}
