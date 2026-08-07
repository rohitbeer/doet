import type { Usage } from './types.js';

/**
 * What a model costs, in US dollars per million tokens — the unit every vendor
 * publishes, so a rate can be copied off a pricing page without arithmetic.
 */
export interface TokenRate {
  input: number;
  output: number;
  /**
   * Cache reads, when the vendor bills them separately. Left out, cached tokens
   * are not charged again on top of `input` — which is the shape both CLIs
   * report today.
   */
  cached?: number;
}

/** Rates by model id, as the user wrote them in `~/.doet/config.json`. */
export type PricingTable = Record<string, TokenRate>;

/**
 * Empty, deliberately.
 *
 * doet knows what a run *cost* only when the CLI tells it: the Claude Agent SDK
 * reports `total_cost_usd`, and that figure already accounts for caching, the
 * plan you are on, and whatever the model actually resolved to. Codex reports
 * tokens and no cost at all.
 *
 * Shipping a built-in price list would paper over that difference with numbers
 * doet cannot verify and that go stale the next time a vendor changes a price —
 * and a confidently wrong dollar figure is worse than an honest blank. So the
 * table starts empty and the scoreboard says "add a rate" for models it cannot
 * price. Fill it in and every later run shows an estimate, marked as one.
 */
export const DEFAULT_PRICING: PricingTable = {};

export interface Cost {
  usd?: number;
  /**
   * True when doet worked the figure out from tokens and your rate table
   * instead of being told it. Always shown, never hidden behind a rounded
   * dollar sign.
   */
  estimated: boolean;
}

/**
 * Finds the rate for a model id.
 *
 * Exact match first, then the longest key the id starts with. The prefix rule
 * is what makes the table usable at all: both CLIs resolve a short name into a
 * dated one (`sonnet` → `claude-sonnet-5-20260401`), and which of the two shows
 * up here depends on how far the session got. One `claude-sonnet-5` entry
 * covers every variant of it.
 */
export function rateFor(model: string | undefined, pricing: PricingTable): TokenRate | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  if (!id) return undefined;

  let best: { key: string; rate: TokenRate } | undefined;
  for (const [key, rate] of Object.entries(pricing)) {
    const candidate = key.trim().toLowerCase();
    if (!candidate) continue;
    if (candidate === id) return rate;
    if (!id.startsWith(candidate)) continue;
    if (!best || candidate.length > best.key.length) best = { key: candidate, rate };
  }
  return best?.rate;
}

/**
 * What this usage cost, preferring the agent's own figure over doet's sums.
 *
 * The two are not the same kind of number and the caller should not have to
 * care which it got — hence `estimated`, which the UI renders rather than
 * quietly dropping.
 */
export function resolveCost(
  usage: Usage,
  model: string | undefined,
  pricing: PricingTable,
): Cost {
  if (usage.costUsd != null && Number.isFinite(usage.costUsd)) {
    return { usd: usage.costUsd, estimated: false };
  }

  const rate = rateFor(model, pricing);
  if (!rate) return { estimated: false };

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = rate.cached != null ? (usage.cachedTokens ?? 0) : 0;
  if (input + output + cached === 0) return { estimated: false };

  const usd =
    (input * rate.input + output * rate.output + cached * (rate.cached ?? 0)) / 1_000_000;
  return { usd, estimated: true };
}

/** Tokens moved in total, however the agent chose to report them. */
export function totalTokens(usage: Usage): number | undefined {
  if (usage.totalTokens != null) return usage.totalTokens;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Reads a `pricing` block off a parsed config file, dropping anything unusable. */
export function readPricing(value: unknown): PricingTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const table: PricingTable = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rate = raw as Record<string, unknown>;
    const input = positive(rate.input);
    const output = positive(rate.output);
    // A half-filled rate would silently under-report, which is exactly the kind
    // of wrong number this module exists to avoid.
    if (input == null || output == null) continue;
    const cached = positive(rate.cached);
    table[model] = { input, output, ...(cached != null ? { cached } : {}) };
  }
  return table;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
