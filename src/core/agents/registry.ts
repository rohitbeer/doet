import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLI_IDS, type CliId, type Effort } from '../types.js';
import { claude } from './claude.js';
import { cline } from './cline.js';
import { codex } from './codex.js';
import { kilo } from './kilo.js';
import type { CliDefinition } from './types.js';

const run = promisify(execFile);

/**
 * Every CLI doet can drive, in one place.
 *
 * This is the whole of the "adding an agent" surface. A new one is a file in
 * this directory and a line here; nothing else in doet learns its name. The
 * next two are already mapped out — `opencode` is kilo's file with a different
 * binary and data directory, and `pi` writes JSONL at
 * `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`, so it is a `fileJournal`
 * like Claude's.
 */
export const CLIS: Record<CliId, CliDefinition> = { claude, codex, cline, kilo };

export function cliFor(id: CliId): CliDefinition {
  const definition = CLIS[id];
  if (!definition) throw new Error(`doet does not know how to run "${id}".`);
  return definition;
}

/** The display name, which is what the panes, labels and records all use. */
export const AGENT_LABELS: Record<CliId, string> = Object.fromEntries(
  CLI_IDS.map((id) => [id, CLIS[id].label]),
) as Record<CliId, string>;

/**
 * Each agent gets one colour and keeps it everywhere — pane border, scoreboard
 * row, dashboard. With several agents running at once, colour is the fastest
 * way to tell whose row you are reading.
 */
export const AGENT_COLOR: Record<CliId, string> = Object.fromEntries(
  CLI_IDS.map((id) => [id, CLIS[id].colour]),
) as Record<CliId, string>;

/**
 * The effort levels this CLI will accept, narrowed to what doet offers.
 *
 * Empty means it has no dial, and the picker skips the question rather than
 * asking one whose answer cannot be honoured.
 */
export function effortsFor(id: CliId): Effort[] {
  return cliFor(id).supports.efforts ?? [];
}

/**
 * Whether a CLI is actually usable here, and if not, why.
 *
 * Checked before a run rather than after: a missing binary that surfaces as a
 * pane dying during startup costs the user a whole layout and an error in a
 * window they have not attached to yet. `--version` because all four answer it
 * quickly and none of them need credentials to do so.
 */
export async function available(id: CliId): Promise<{ ok: boolean; version?: string; error?: string }> {
  const definition = cliFor(id);
  try {
    const { stdout } = await run(definition.command, ['--version'], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    // kilo prints a banner and its logs on stderr, so the version is whichever
    // line on stdout looks like one.
    const version = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /\d+\.\d+/.test(line));
    return { ok: true, ...(version ? { version } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /ENOENT/.test(message)
        ? `\`${definition.command}\` is not on PATH. Install ${definition.label} and log in, or pick another agent.`
        : `\`${definition.command} --version\` failed: ${message}`,
    };
  }
}
