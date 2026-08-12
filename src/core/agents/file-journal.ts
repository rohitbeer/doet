import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JournalReader, JournalState } from './types.js';

/**
 * Reading what an agent did from a transcript its own CLI writes.
 *
 * Two of the four CLIs doet drives persist every session as line-delimited
 * JSON, and that record is strictly richer than what they draw:
 *
 *   Claude  ~/.claude/projects/<slug>/<session-id>.jsonl
 *   Codex   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl
 *
 * The trade is worth stating plainly, because it is the main cost of this
 * design: these files are internal to their CLIs, not published interfaces, and
 * their shape can change in any release. That is not hypothetical — Codex wrote
 * the final assistant message as an `agent_message` event in transcripts from
 * one day and as a `response_item` with `output_text` content the next, on the
 * same machine. So every reader takes the union of the shapes it has seen
 * rather than the newest one, and anything it cannot parse is skipped rather
 * than guessed at. A turn doet cannot read is reported as unknown; it is never
 * invented.
 *
 * This file is the plumbing all of that shares. The two parsers that use it
 * live beside the CLIs they belong to, in `claude.ts` and `codex.ts`.
 */

/** Tailing a file is free, so it can be done often. */
const FILE_POLL_MS = 400;

export interface FileJournalSpec {
  /** Every transcript this CLI might have written for this working tree. */
  list(cwd: string): Array<{ path: string; mtimeMs: number }>;
  parse(path: string): JournalState;
  /** The CLI's own session id for a transcript. */
  idOf(path: string): string | null;
  /**
   * Whether a candidate really is a session rather than something half-written.
   *
   * Only needed where the file is identified by being new rather than by being
   * in the right directory — which is Codex, whose sessions all land in one
   * dated tree regardless of where they were run.
   */
  confirm?(path: string): boolean;
}

export function fileJournal(spec: FileJournalSpec): JournalReader {
  return {
    pollMs: FILE_POLL_MS,

    async known(cwd: string): Promise<Set<string>> {
      return new Set(spec.list(cwd).map((entry) => entry.path));
    },

    async find(cwd: string, since: number, known: Set<string>): Promise<string | null> {
      const candidates = spec
        .list(cwd)
        .filter((entry) => !known.has(entry.path))
        // A second of slack: the file is created around the moment doet stamps
        // `since`, and filesystem timestamps are not that precise.
        .filter((entry) => entry.mtimeMs >= since - 1000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const candidate of candidates) {
        if (!spec.confirm || spec.confirm(candidate.path)) return candidate.path;
      }
      return null;
    },

    async sessionId(handle: string): Promise<string | null> {
      return spec.idOf(handle);
    },

    async read(handle: string): Promise<JournalState> {
      return spec.parse(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared file plumbing
// ---------------------------------------------------------------------------

/**
 * The path with symlinks resolved, because a CLI files its transcript under the
 * real one.
 *
 * `resolve()` is not enough and the difference is not cosmetic: on macOS
 * `os.tmpdir()` hands back `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Claude writes to a directory named after the
 * latter, so a slug built from the former points at a directory that never
 * appears and doet waits out its whole timeout for a transcript that is already
 * there under a different name.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    // The directory may not exist yet — a worktree about to be created. The
    // unresolved path is the best available answer and is usually identical.
    return resolve(path);
  }
}

/** Every `.jsonl` in a directory, with the time it last changed. */
export function transcriptsIn(dir: string): Array<{ path: string; mtimeMs: number }> {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null);
  } catch {
    return [];
  }
}

/** Walks a dated tree for `.jsonl` files, which is how Codex buckets its own. */
export function transcriptsUnder(root: string, maxDepth = 4): Array<{ path: string; mtimeMs: number }> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(path, depth + 1);
      else if (entry.endsWith('.jsonl')) found.push({ path, mtimeMs: info.mtimeMs });
    }
  };
  walk(root, 0);
  return found;
}

export interface RawRecord {
  type?: string;
  payload?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export function* records(path: string): Generator<RawRecord> {
  let text: string;
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RawRecord;
    } catch {
      // A record still being written. It will be complete on the next read.
    }
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textOf(content: unknown, wanted: string[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asRecord(block);
      return wanted.includes(String(b.type)) && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('');
}

export function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The file's own timestamp, for stamping turns that carry none of their own. */
export function changedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}
