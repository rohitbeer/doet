import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Bus } from './bus.js';
import type { SummarySource } from './config.js';
import { DOET_HOME } from './paths.js';
import type { DebateResult } from './conductor.js';
import { AGENT_LABELS } from './relay.js';
import { AGENT_IDS, type AgentId, type DoetEvent, type Effort } from './types.js';

export const SESSIONS_DIR = join(DOET_HOME, 'sessions');

/**
 * Enough to reopen a doet session later: which agent sessions it was driving,
 * and on what models. Written beside the markdown as the session runs, so a
 * crash or a quit does not strand the conversation.
 */
export interface SessionMeta {
  id: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  query: string;
  agents: Record<AgentId, { sessionId?: string; model: string; effort?: Effort }>;
  summary: { agent: SummarySource; model: string };
}

/**
 * One directory per doet session, written as it happens rather than at the end.
 *
 *   <stamp>/session.md   the conversation, appended turn by turn
 *   <stamp>/claude.md    that agent's own transcript
 *   <stamp>/codex.md
 *   <stamp>/gist.md      the summary agent's latest digest
 *   <stamp>/events.jsonl every event, including permission decisions
 *
 * Written live because the markdown is not only a record: rotating an agent's
 * session reads it back to hand the replacement a `full` handoff. A file that
 * only appeared when a debate ended could not do that.
 */
export class SessionStore {
  readonly dir: string;
  readonly id: string;
  private readonly startedAt = new Date();
  private unsubscribe: (() => void) | null = null;
  private wroteHeader = false;

  /**
   * `reopen` adopts an existing session directory instead of starting one, so a
   * resumed run keeps appending to the same markdown rather than orphaning it.
   */
  constructor(sessionId: string, reopen?: string) {
    // A sortable stamp plus a short id: readable in `ls`, still unique.
    this.id =
      reopen ??
      `${this.startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${sessionId.slice(0, 8)}`;
    this.dir = join(SESSIONS_DIR, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.wroteHeader = reopen !== undefined && existsSync(join(this.dir, 'session.md'));
  }

  // -------------------------------------------------------------------------
  // Resuming
  // -------------------------------------------------------------------------

  writeMeta(meta: Omit<SessionMeta, 'id' | 'startedAt' | 'updatedAt'>): void {
    this.safely(() =>
      writeFileSync(
        this.path('meta.json'),
        `${JSON.stringify(
          {
            id: this.id,
            startedAt: this.startedAt.toISOString(),
            updatedAt: new Date().toISOString(),
            ...meta,
          } satisfies SessionMeta,
          null,
          2,
        )}\n`,
        'utf8',
      ),
    );
  }

  /** Stored sessions, newest first. `cwd` narrows to ones for that directory. */
  static list(cwd?: string): SessionMeta[] {
    let entries: string[];
    try {
      entries = readdirSync(SESSIONS_DIR);
    } catch {
      return [];
    }

    return entries
      .map((id) => SessionStore.load(id))
      .filter((meta): meta is SessionMeta => meta !== null)
      .filter((meta) => !cwd || meta.cwd === cwd)
      // The directory name starts with a sortable timestamp, but `updatedAt` is
      // what "most recent" should mean for resuming.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static load(id: string): SessionMeta | null {
    try {
      const raw = readFileSync(join(SESSIONS_DIR, id, 'meta.json'), 'utf8');
      const meta = JSON.parse(raw) as SessionMeta;
      return meta.id ? meta : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves what `--resume` was given: an exact id, a unique prefix, or
   * nothing at all, meaning the most recent session for this directory.
   */
  static resolve(idOrPrefix: string | true, cwd: string): SessionMeta | null {
    if (idOrPrefix === true) {
      return SessionStore.list(cwd)[0] ?? SessionStore.list()[0] ?? null;
    }
    const exact = SessionStore.load(idOrPrefix);
    if (exact) return exact;
    return SessionStore.list().find((meta) => meta.id.startsWith(idOrPrefix)) ?? null;
  }

  attach(bus: Bus): void {
    this.unsubscribe = bus.on((event) => this.record(event));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private record(event: DoetEvent): void {
    // Token-level deltas would bloat the file by orders of magnitude and add
    // nothing the complete `message` event doesn't already carry.
    if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'output') return;
    this.safely(() =>
      appendFileSync(this.path('events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8'),
    );
  }

  // -------------------------------------------------------------------------
  // Live markdown
  // -------------------------------------------------------------------------

  /** Called once, when a question is first asked. */
  openQuestion(query: string): void {
    this.safely(() => {
      if (!this.wroteHeader) {
        writeFileSync(
          this.path('session.md'),
          `# doet session — ${this.startedAt.toLocaleString()}\n`,
          'utf8',
        );
        this.wroteHeader = true;
      }
      appendFileSync(this.path('session.md'), `\n## Request\n\n${query}\n`, 'utf8');
    });
  }

  /** Marks where a resumed run picks the markdown back up. */
  noteResumed(): void {
    this.safely(() =>
      appendFileSync(
        this.path('session.md'),
        `\n---\n\n_Resumed ${new Date().toLocaleString()}_\n`,
        'utf8',
      ),
    );
  }

  /** Called as each turn completes, so the file is never behind the screen. */
  appendTurn(agent: AgentId, round: number, text: string, verdict: string | null): void {
    this.safely(() =>
      appendFileSync(
        this.path('session.md'),
        `\n### ${round}. ${AGENT_LABELS[agent]}${verdict ? ` — ${verdict}` : ''}\n\n${text}\n`,
        'utf8',
      ),
    );
  }

  appendNote(note: string): void {
    this.safely(() => appendFileSync(this.path('session.md'), `\n> ${note}\n`, 'utf8'));
  }

  writeGist(gist: string): void {
    this.safely(() => writeFileSync(this.path('gist.md'), `${gist}\n`, 'utf8'));
  }

  readGist(): string {
    return this.read('gist.md');
  }

  /** Snapshots one agent's own session transcript. */
  writeAgentHistory(agent: AgentId, markdown: string): void {
    if (!markdown.trim()) return;
    this.safely(() =>
      writeFileSync(
        this.path(`${agent}.md`),
        `# ${AGENT_LABELS[agent]} — session transcript\n\n${markdown}\n`,
        'utf8',
      ),
    );
  }

  /** The whole conversation so far, for a `full` handoff. */
  readSession(): string {
    return this.read('session.md');
  }

  private read(name: string): string {
    try {
      const path = this.path(name);
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    } catch {
      return '';
    }
  }

  /** Returns the path written, so the UI can tell the user where it went. */
  finalize(result: DebateResult): string {
    const path = this.path('session.md');
    this.safely(() => {
      appendFileSync(
        path,
        `\n---\n\n## Final version — ${AGENT_LABELS[result.finalFrom]}\n\n` +
          `_${result.reason} after ${result.rounds} exchange${result.rounds === 1 ? '' : 's'}_\n\n` +
          `${result.final}\n`,
        'utf8',
      );
    });
    return path;
  }

  /** Snapshot everything the agents know, e.g. on quit. */
  snapshot(histories: Record<AgentId, string>): void {
    for (const id of AGENT_IDS) this.writeAgentHistory(id, histories[id]);
  }

  private safely(write: () => void): void {
    try {
      write();
    } catch {
      // Never let logging take down the session.
    }
  }
}
