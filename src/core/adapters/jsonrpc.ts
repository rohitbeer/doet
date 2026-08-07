import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { Deferred } from '../util.js';

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Server → client notification (fire and forget). */
  onNotification: (method: string, params: unknown) => void;
  /**
   * Server → client request. Whatever this resolves to is sent back as the
   * result. This is the path every Codex approval prompt travels.
   */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * Line-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * The important detail is that this is genuinely bidirectional. Codex's
 * app-server does not just answer our requests — it turns around and asks
 * *us* things ("may I run this command?"), and blocks its turn until we
 * answer. A client that only tracked outbound requests would deadlock the
 * moment the agent tried to touch anything.
 */
export class JsonRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private readonly inflight = new Map<string | number, Deferred<unknown>>();
  private readonly opts: JsonRpcClientOptions;
  private stderrTail: string[] = [];

  constructor(opts: JsonRpcClientOptions) {
    this.opts = opts;
  }

  start(): void {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.onLine(line));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep a rolling tail so a crash can report why rather than just a code.
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });

    child.on('error', (error) => {
      // Nothing spawned at all — usually `codex` is not on PATH. Without this
      // the pending `initialize` never settles and startup hangs with no
      // message, which is worse than any error text.
      this.failAll(`could not run \`${this.opts.command}\`: ${error.message}`);
      this.opts.onError(error.message);
    });
    child.on('exit', (code) => {
      this.failAll(`codex app-server exited (code ${code ?? 'null'})`);
      if (code !== 0 && code !== null) {
        const tail = this.stderrTail.join('').trim();
        if (tail) this.opts.onError(tail.split('\n').slice(-8).join('\n'));
      }
      this.opts.onExit(code);
    });
  }

  /** Settles every pending request, so a dead child can never leave a hang. */
  private failAll(reason: string): void {
    for (const [, deferred] of this.inflight) {
      deferred.reject(new Error(reason));
    }
    this.inflight.clear();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // The app-server occasionally prints non-JSON banners on stdout; ignoring
      // them is safer than treating the stream as corrupt.
      return;
    }

    // A response to something we sent.
    if (message.id !== undefined && message.method === undefined) {
      const deferred = this.inflight.get(message.id);
      if (!deferred) return;
      this.inflight.delete(message.id);
      if (message.error) {
        deferred.reject(new Error(message.error.message));
      } else {
        deferred.resolve(message.result);
      }
      return;
    }

    // A request from the server — must be answered.
    if (message.id !== undefined && message.method !== undefined) {
      const id = message.id;
      void this.opts
        .onRequest(message.method, message.params)
        .then((result) => this.write({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) => {
          this.write({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return;
    }

    // A notification.
    if (message.method !== undefined) {
      this.opts.onNotification(message.method, message.params);
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error('app-server is not running'));
    const id = this.nextId++;
    const deferred = new Deferred<unknown>();
    this.inflight.set(id, deferred);
    this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    return deferred.promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop(): void {
    this.reader?.close();
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
