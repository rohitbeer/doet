import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DOET_HOME } from './paths.js';
import type { AgentId, AgentSessionSettings, Effort } from './types.js';
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
  debate: DebateConfig;
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
  debate: DEFAULT_DEBATE,
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
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<DoetConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      models: {
        claude: readModel(raw.models?.claude, DEFAULT_CONFIG.models.claude),
        codex: readModel(raw.models?.codex, DEFAULT_CONFIG.models.codex),
      },
      branch: { ...DEFAULT_CONFIG.branch, ...raw.branch },
      // Read field by field rather than spread. A config written by an older
      // doet still carries keys for behaviour that has since been removed, and
      // spreading them back in is how a deleted feature comes back to life on
      // one machine and not another.
      debate: { maxRounds: readRounds(raw.debate?.maxRounds) },
      summary: {
        ...DEFAULT_CONFIG.summary,
        ...raw.summary,
        model: readModel(raw.summary?.model, DEFAULT_CONFIG.summary.model),
      },
      sessions: {
        claude: { ...DEFAULT_CONFIG.sessions.claude, ...raw.sessions?.claude },
        codex: { ...DEFAULT_CONFIG.sessions.codex, ...raw.sessions?.codex },
      },
      claude: { ...DEFAULT_CONFIG.claude, ...raw.claude },
      codex: { ...DEFAULT_CONFIG.codex, ...raw.codex },
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
    : DEFAULT_DEBATE.maxRounds;
}

function readModel(value: unknown, fallback: ModelSetting): ModelSetting {
  if (typeof value === 'string') return { id: value };
  if (value && typeof value === 'object') {
    const m = value as Partial<ModelSetting>;
    if (typeof m.id === 'string') return { id: m.id, effort: m.effort };
  }
  return { ...fallback };
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
  if (value === 'manual') return { mode: 'manual' };

  const [mode, rawAmount] = value.split(':');
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 1) return null;

  if (mode === 'rounds') return { mode: 'rounds', every: Math.floor(amount) };
  if (mode === 'tokens') return { mode: 'tokens', limit: Math.floor(amount) };
  return null;
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
