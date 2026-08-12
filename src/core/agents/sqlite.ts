import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Reading a session out of a CLI that keeps one in SQLite.
 *
 * Two of the four agents doet drives do not write a transcript it can tail.
 * cline keeps sessions in `~/.cline/data/db/sessions.db` and kilo — which is
 * opencode underneath — in `~/.local/share/kilo/kilo.db`. Both ship a supported
 * command that will run a query and print JSON, so doet is not reverse
 * engineering a private file either way.
 *
 * It reads the database directly all the same, and the reason is latency
 * measured rather than assumed. Both CLIs are ~100MB compiled binaries, and
 * asking one anything costs a process launch:
 *
 *     kilo db "select 1" --format json     1435ms  1432ms  1653ms
 *     cline history --json                 1050ms   697ms   756ms
 *     node:sqlite, same file, same query      8ms
 *
 * doet polls for the end of a turn. At a second and a half per poll it would
 * spend more time waiting on the reader than the reader spends reading, and
 * nine agents in a VS run would have nine ~100MB processes starting and exiting
 * several times a second for the length of the run. The direct read is the same
 * query against the same file — `kilo db` takes raw SQL, so the schema is the
 * interface it exposes — for a two-hundredth of the cost.
 *
 * The subprocess is kept as the fallback rather than deleted, because
 * `node:sqlite` is only there from Node 22.5 and doet still says it runs on 20.
 * On an older runtime every read simply goes the slow way and the run is a beat
 * less responsive, which is a far better failure than not starting.
 */

/** Loaded once, and never again if it is not there. */
let sqliteModule: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => Db } | null | undefined;

interface Db {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

async function loadSqlite(): Promise<typeof sqliteModule> {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = (await import('node:sqlite')) as never;
  } catch {
    // Node older than 22.5, or built without it. Everything falls back.
    sqliteModule = null;
  }
  return sqliteModule;
}

export interface SqlSource {
  /** The database file. Absent or unreadable falls straight through. */
  path: string;
  /**
   * The CLI's own way to run a query and print JSON rows, for the runtimes that
   * cannot open the file directly.
   */
  fallback?(sql: string): { command: string; args: string[] };
}

/**
 * Values are inlined rather than bound, and that needs saying out loud.
 *
 * The fallback path hands the statement to another program as one argv string,
 * so there is nowhere to put a bound parameter — the two readers would have to
 * build their SQL differently depending on which path they took, which is
 * exactly the sort of split that gets one of them tested and the other not.
 *
 * What is inlined is never user prose: session ids the CLI generated and
 * directory paths git handed doet. `quote` doubles any apostrophe, which is
 * SQLite's own escape, and refuses a NUL outright rather than truncating at it.
 */
export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('A SQL value cannot contain a null byte.');
  return `'${value.replace(/'/g, "''")}'`;
}

/** Rows as plain objects, or empty when the session store cannot be read. */
export async function query<T = Record<string, unknown>>(
  source: SqlSource,
  sql: string,
): Promise<T[]> {
  const sqlite = await loadSqlite();
  if (sqlite && existsSync(source.path)) {
    try {
      // Read-only, because doet is a guest in another program's database and a
      // writable handle could take a lock the CLI itself is waiting on.
      const db = new sqlite.DatabaseSync(source.path, { readOnly: true });
      try {
        return db.prepare(sql).all() as T[];
      } finally {
        db.close();
      }
    } catch {
      // Falls through: an older schema, a database mid-migration, or a
      // read-only handle refused because the -shm file is not there yet.
    }
  }

  const fallback = source.fallback?.(sql);
  if (!fallback) return [];
  try {
    const { stdout } = await run(fallback.command, fallback.args, {
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const text = stdout.trim();
    // Both CLIs print their logs to stderr and their answer to stdout, so this
    // is either JSON or nothing. Nothing is what an empty result looks like.
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** `123` from whatever SQLite handed back — integer, real, or a string. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Milliseconds since the epoch, from either an integer stamp or an ISO string. */
export function stamp(value: unknown): number | undefined {
  const asNumber = num(value);
  // Seconds rather than milliseconds, if it is small enough to be a date before
  // 1973 in ms. Neither store uses seconds today; this only stops a future one
  // from reading as 1970 and looking older than everything.
  if (asNumber != null) return asNumber < 1e11 ? asNumber * 1000 : asNumber;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A `data` column, which both stores use to hold a JSON blob. */
export function json(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
