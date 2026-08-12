import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DOET_HOME } from './paths.js';
import { EFFORTS, UI_MODES, type AgentId, type Effort, type UiMode } from './types.js';
import { DEFAULT_PRICING, readPricing, type PricingTable } from './pricing.js';

/** A model choice as the user made it: which model, and how hard it should think. */
export interface ModelSetting {
  id: string;
  effort?: Effort;
}

/**
 * There is no summary setting any more, and nothing replaced it.
 *
 * Who keeps the notes, on what model, at what length, was a question doet had
 * to ask because the note-taker was a third agent with a bill of its own. The
 * summary is now one line written by the agent that just spoke, in a fork of
 * its own session, on the model it is already running — so there is nothing
 * left to choose.
 */
export interface DoetConfig {
  models: Record<AgentId, ModelSetting>;
  /**
   * Which interface to open with — remembered from the last run rather than
   * asked every time, because it is a preference about how you like to work and
   * not a decision about this particular question. The launch picker starts on
   * whatever is here, and writes back whatever you choose.
   */
  ui: UiMode;
  claude: {
    permissionMode: string;
  };
  codex: {
    approvalPolicy: string;
    sandbox: string;
  };
  /**
   * USD per million tokens, by model id, for the models whose CLI does not
   * report a cost of its own. Yours to fill in — see `pricing.ts` for why doet
   * ships none.
   */
  pricing: PricingTable;
}

export const DEFAULT_CONFIG: DoetConfig = {
  // An empty id means "whatever that CLI is already configured to use". Model
  // availability varies by plan, so guessing an id here just produces a 400 on
  // the first turn.
  models: { claude: { id: 'sonnet' }, codex: { id: '' } },
  // The interactive layout is the default because it is the one that shows you
  // everything without being asked. Modern is the better view once you trust
  // the run; it is not the better view the first time you see one.
  ui: 'interactive',
  claude: { permissionMode: 'default' },
  // `untrusted` + `workspace-write` is the combination that actually produces
  // prompts. Loosening either one silently removes the thing doet is for.
  codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  pricing: DEFAULT_PRICING,
};

export const CONFIG_PATH = join(DOET_HOME, 'config.json');

export function loadConfig(): DoetConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return clone(DEFAULT_CONFIG);
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!isRecord(parsed)) return clone(DEFAULT_CONFIG);
    const raw = parsed;
    const models = recordAt(raw.models);
    const claude = recordAt(raw.claude);
    const codex = recordAt(raw.codex);

    return {
      models: {
        claude: readModel(models.claude, DEFAULT_CONFIG.models.claude),
        codex: readModel(models.codex, DEFAULT_CONFIG.models.codex),
      },
      ui: oneOf(raw.ui, UI_MODES, DEFAULT_CONFIG.ui),
      // Read field by field rather than spread. A config written by an older
      // doet still carries keys for behaviour that has since been removed —
      // `summary` among them now — and spreading them back in is how a deleted
      // feature comes back to life on one machine and not another.
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
      pricing: readPricing(raw.pricing),
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

