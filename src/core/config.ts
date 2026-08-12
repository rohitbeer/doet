import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DOET_HOME } from './paths.js';
import { CLI_IDS, EFFORTS, UI_MODES, type CliId, type Effort, type UiMode } from './types.js';
import { DEFAULT_PRICING, readPricing, type PricingTable } from './pricing.js';

/** A model choice as the user made it: which model, how hard, and on whose bill. */
export interface ModelSetting {
  id: string;
  effort?: Effort;
  /**
   * Which credentials to use, for the CLIs that route to many vendors.
   *
   * Meaningless for Claude and Codex, which have exactly one. cline takes it as
   * a flag and kilo folds it into the model id.
   */
  provider?: string;
}

/**
 * There is no summary setting any more, and nothing replaced it.
 *
 * Who keeps the notes, on what model, at what length, was a question doet had
 * to ask because the note-taker was a third agent with a bill of its own. The
 * summary is now one line written by the agent that just spoke, in a fork of
 * its own session, on the model it is already running — so there is nothing
 * left to choose.
 *
 * The per-CLI permission blocks have gone the same way, and for a related
 * reason. There used to be a `claude.permissionMode` and a
 * `codex.approvalPolicy`/`codex.sandbox`, which meant every caller starting an
 * agent had to know which of the three applied to it — and a third and fourth
 * CLI would each have added their own. doet chooses a *posture* now (`Autonomy`)
 * and each CLI definition translates it. A config written by an older doet
 * still carrying those keys is simply ignored; see `loadConfig`.
 */
export interface DoetConfig {
  models: Record<CliId, ModelSetting>;
  /**
   * Which interface to open with — remembered from the last run rather than
   * asked every time, because it is a preference about how you like to work and
   * not a decision about this particular question.
   */
  ui: UiMode;
  /**
   * How many isolated agents a VS run starts with.
   *
   * Remembered for the same reason as `ui`: two is a comparison and five is a
   * survey, and which of those you are doing tends to be a habit rather than a
   * fresh decision each time.
   */
  vsAgents: number;
  /**
   * USD per million tokens, by model id, for the models whose CLI does not
   * report a cost of its own. Yours to fill in — see `pricing.ts` for why doet
   * ships none.
   */
  pricing: PricingTable;
}

/**
 * An empty model id means "whatever that CLI is already configured to use".
 *
 * Model availability varies by plan and by provider, so guessing an id here
 * just produces a 400 on the first turn. Claude is the exception only because
 * `sonnet` is an alias every plan resolves.
 */
export const DEFAULT_CONFIG: DoetConfig = {
  models: {
    claude: { id: 'sonnet' },
    codex: { id: '' },
    cline: { id: '' },
    kilo: { id: '' },
  },
  // The interactive layout is the default because it is the one that shows you
  // everything without being asked. The dashboard is the better view once you
  // trust the run; it is not the better view the first time you see one — and
  // past two agents it is the only one that fits, which doet works out for
  // itself rather than making it your problem.
  ui: 'interactive',
  vsAgents: 2,
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

    return {
      models: Object.fromEntries(
        CLI_IDS.map((id) => [id, readModel(models[id], DEFAULT_CONFIG.models[id])]),
      ) as Record<CliId, ModelSetting>,
      ui: oneOf(raw.ui, UI_MODES, DEFAULT_CONFIG.ui),
      vsAgents: count(raw.vsAgents, DEFAULT_CONFIG.vsAgents),
      // Read field by field rather than spread. A config written by an older
      // doet still carries keys for behaviour that has since been removed —
      // `summary`, and now `claude`/`codex` permission blocks — and spreading
      // them back in is how a deleted feature comes back to life on one machine
      // and not another.
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
    const provider = typeof value.provider === 'string' && value.provider ? value.provider : undefined;
    return { id: value.id, ...(effort ? { effort } : {}), ...(provider ? { provider } : {}) };
  }
  return { ...fallback };
}

/** A whole number in range, or the default. Never `NaN`, which `??` would pass. */
function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
    ? value
    : fallback;
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
