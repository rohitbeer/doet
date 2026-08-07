import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DOET_HOME } from './paths.js';
import { EFFORTS, type AgentId, type AgentSessionSettings, type Effort } from './types.js';
import { DEFAULT_DEBATE, type DebateConfig } from './conductor.js';

/** A model choice as the user made it: which model, and how hard it should think. */
export interface ModelSetting {
  id: string;
  effort?: Effort;
}

/**
 * Who keeps the running gist.
 *
 * Always its own session, never one of the two agents': a summary written
 * inside a debater's session would be a turn in that agent's history, which is
 * exactly what the session is meant to be kept clear of. `ask` means doet has
 * not been told yet and will ask on first launch.
 */
export type SummarySource = AgentId | 'off' | 'ask';

export interface SummarySetting {
  agent: SummarySource;
  model: ModelSetting;
  /** Words to aim for. Small on purpose: a gist that grows is just a transcript. */
  targetWords: number;
}

/**
 * Where a branched session opens. `ask` means doet has not been told yet and
 * will offer the choice the first time you branch — once, then it remembers.
 */
export interface BranchSetting {
  mode: 'ask' | 'copy' | 'launcher' | 'command';
  /** Launcher id when `mode` is `launcher`. */
  launcher?: string;
  /** Shell template with `{cmd}` / `{cwd}` when `mode` is `command`. */
  command?: string;
}

export interface DoetConfig {
  models: Record<AgentId, ModelSetting>;
  branch: BranchSetting;
  /** Which agent receives the opening query when you don't pick one. */
  defaultFirst: AgentId;
  coCode: DebateConfig;
  summary: SummarySetting;
  sessions: Record<AgentId, AgentSessionSettings>;
  claude: {
    permissionMode: string;
  };
  codex: {
    approvalPolicy: string;
    sandbox: string;
  };
}

export const DEFAULT_CONFIG: DoetConfig = {
  // An empty id means "whatever that CLI is already configured to use". Model
  // availability varies by plan, so guessing an id here just produces a 400 on
  // the first turn.
  models: { claude: { id: 'sonnet' }, codex: { id: '' } },
  // Unanswered until you branch for the first time. doet cannot tell from the
  // environment whether you want a new window or a command to paste into your
  // editor, and guessing wrong is how you end up outside your editor.
  branch: { mode: 'ask' },
  defaultFirst: 'claude',
  coCode: DEFAULT_DEBATE,
  // Unanswered until first launch. Which agent takes the notes, and on what
  // model, is a cost decision doet has no business making for you.
  summary: { agent: 'ask', model: { id: '' }, targetWords: 220 },
  // Manual by default. Rotating a session is a real decision — it drops
  // everything the agent remembers — so doet does not do it behind your back.
  sessions: {
    claude: { policy: { mode: 'manual' }, handoff: 'ask' },
    codex: { policy: { mode: 'manual' }, handoff: 'ask' },
  },
  claude: { permissionMode: 'default' },
  // `untrusted` + `workspace-write` is the combination that actually produces
  // prompts. Loosening either one silently removes the thing doet is for.
  codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
};

export const CONFIG_PATH = join(DOET_HOME, 'config.json');

export function loadConfig(): DoetConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return clone(DEFAULT_CONFIG);
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!isRecord(parsed)) return clone(DEFAULT_CONFIG);
    const raw = parsed;
    const models = recordAt(raw.models);
    const summary = recordAt(raw.summary);
    const sessions = recordAt(raw.sessions);
    const claude = recordAt(raw.claude);
    const codex = recordAt(raw.codex);
    const coCode = recordAt(raw.coCode);
    const debate = recordAt(raw.debate);

    return {
      models: {
        claude: readModel(models.claude, DEFAULT_CONFIG.models.claude),
        codex: readModel(models.codex, DEFAULT_CONFIG.models.codex),
      },
      branch: readBranch(raw.branch),
      defaultFirst: raw.defaultFirst === 'codex' ? 'codex' : 'claude',
      // Read field by field rather than spread. A config written by an older
      // doet still carries keys for behaviour that has since been removed, and
      // spreading them back in is how a deleted feature comes back to life on
      // one machine and not another.
      coCode: { maxRounds: readRounds(coCode.maxRounds ?? debate.maxRounds) },
      summary: {
        agent: isSummarySource(summary.agent) ? summary.agent : DEFAULT_CONFIG.summary.agent,
        model: readModel(summary.model, DEFAULT_CONFIG.summary.model),
        targetWords: readPositiveInteger(summary.targetWords, DEFAULT_CONFIG.summary.targetWords),
      },
      sessions: {
        claude: readSessionSettings(sessions.claude, DEFAULT_CONFIG.sessions.claude),
        codex: readSessionSettings(sessions.codex, DEFAULT_CONFIG.sessions.codex),
      },
      claude: {
        permissionMode: oneOf(
          claude.permissionMode,
          ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
          DEFAULT_CONFIG.claude.permissionMode,
        ),
      },
      codex: {
        approvalPolicy: oneOf(
          codex.approvalPolicy,
          ['untrusted', 'on-request', 'never'],
          DEFAULT_CONFIG.codex.approvalPolicy,
        ),
        sandbox: oneOf(
          codex.sandbox,
          ['read-only', 'workspace-write', 'danger-full-access'],
          DEFAULT_CONFIG.codex.sandbox,
        ),
      },
    };
  } catch {
    // A broken config should not stop doet from starting.
    return clone(DEFAULT_CONFIG);
  }
}

/**
 * Models used to be plain strings. Reading both shapes means an existing
 * `~/.doet/config.json` keeps working instead of silently reverting to defaults.
 */
function readRounds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_CONFIG.coCode.maxRounds;
}

function readModel(value: unknown, fallback: ModelSetting): ModelSetting {
  if (typeof value === 'string') return { id: value };
  if (isRecord(value) && typeof value.id === 'string') {
    const effort = typeof value.effort === 'string'
      && (EFFORTS as readonly string[]).includes(value.effort)
      ? value.effort as Effort
      : undefined;
    return { id: value.id, ...(effort ? { effort } : {}) };
  }
  return { ...fallback };
}

function readBranch(value: unknown): BranchSetting {
  const raw = recordAt(value);
  const mode = oneOf(raw.mode, ['ask', 'copy', 'launcher', 'command'], DEFAULT_CONFIG.branch.mode);
  if (mode === 'launcher' && typeof raw.launcher !== 'string') return { mode: 'ask' };
  if (mode === 'command' && typeof raw.command !== 'string') return { mode: 'ask' };
  return {
    mode,
    ...(typeof raw.launcher === 'string' ? { launcher: raw.launcher } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
  };
}

function readSessionSettings(
  value: unknown,
  fallback: AgentSessionSettings,
): AgentSessionSettings {
  const raw = recordAt(value);
  const policy = recordAt(raw.policy);
  let parsedPolicy: AgentSessionSettings['policy'] = { ...fallback.policy };
  if (policy.mode === 'manual') parsedPolicy = { mode: 'manual' };
  else if (policy.mode === 'rounds') {
    const every = readPositiveInteger(policy.every, 0);
    if (every > 0) parsedPolicy = { mode: 'rounds', every };
  } else if (policy.mode === 'tokens') {
    const limit = readPositiveInteger(policy.limit, 0);
    if (limit > 0) parsedPolicy = { mode: 'tokens', limit };
  }
  const handoff = oneOf(raw.handoff, ['ask', 'gist', 'full', 'none'], fallback.handoff);
  return { policy: parsedPolicy, handoff };
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function isSummarySource(value: unknown): value is SummarySource {
  return value === 'claude' || value === 'codex' || value === 'off' || value === 'ask';
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordAt(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function saveConfig(config: DoetConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Defaults are handed out per call so a mutation cannot leak into the next load. */
function clone(config: DoetConfig): DoetConfig {
  return JSON.parse(JSON.stringify(config)) as DoetConfig;
}

/** `manual`, `rounds:4`, `tokens:120000` — the `/session … policy` argument. */
export function parseSessionPolicy(value: string): AgentSessionSettings['policy'] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'manual') return { mode: 'manual' };

  const match = /^(rounds|tokens):([1-9]\d*)$/.exec(normalized);
  if (!match) return null;
  const amount = Number(match[2]);
  if (!Number.isSafeInteger(amount)) return null;

  return match[1] === 'rounds'
    ? { mode: 'rounds', every: amount }
    : { mode: 'tokens', limit: amount };
}

export function describeSessionPolicy(policy: AgentSessionSettings['policy']): string {
  switch (policy.mode) {
    case 'rounds':
      return `every ${policy.every} turn${policy.every === 1 ? '' : 's'}`;
    case 'tokens':
      return `past ${policy.limit.toLocaleString()} tokens`;
    default:
      return 'manual';
  }
}
