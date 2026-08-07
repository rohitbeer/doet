import { resolveCost, totalTokens, type Cost, type PricingTable } from './pricing.js';
import { AGENT_LABELS } from './relay.js';
import { SLOT_IDS, type SlotId, type Usage, type VsResult, type VsSlotStats } from './types.js';
import { compactNumber, formatDuration, formatUsd } from './util.js';

/**
 * What one slot spent, ready to render.
 *
 * VS is a comparison, and until now the only axis it compared on was the diff.
 * Two implementations that both work are still not equal if one took four
 * minutes and forty thousand tokens to get there — so time and spend are part
 * of the result, not a footnote.
 */
export interface SlotScore {
  slot: SlotId;
  label: string;
  model: string;
  elapsedMs: number;
  /** Still counting: the UI keeps the row live rather than showing a stale total. */
  running: boolean;
  usage: Usage;
  tokens?: number;
  cost: Cost;
  addOns: number;
}

/** Time on the clock for a slot, counting the exchange still in flight. */
export function elapsedFor(stats: VsSlotStats, now: number): number {
  return stats.activeMs + (stats.runningSince != null ? Math.max(0, now - stats.runningSince) : 0);
}

export function scoreSlot(opts: {
  slot: SlotId;
  label: string;
  model: string;
  stats: VsSlotStats;
  pricing: PricingTable;
  now: number;
}): SlotScore {
  const { slot, label, model, stats, pricing, now } = opts;
  return {
    slot,
    label,
    model,
    elapsedMs: elapsedFor(stats, now),
    running: stats.runningSince != null,
    usage: stats.usage,
    tokens: totalTokens(stats.usage),
    cost: resolveCost(stats.usage, model, pricing),
    addOns: stats.addOns,
  };
}

/**
 * `$0.41` / `~$0.41` / `–`.
 *
 * The tilde is load-bearing: a figure doet worked out from your rate table is
 * not the same claim as one the CLI reported, and the two sit side by side in
 * the same column.
 */
export function formatCost(cost: Cost): string {
  if (cost.usd == null) return '–';
  return `${cost.estimated ? '~' : ''}${formatUsd(cost.usd)}`;
}

/**
 * `1m 07s · 34.2k tok · ~$0.41` — the compact form.
 *
 * `cost: false` for a pane header, which is one row that must stay one row: a
 * third field there is what tips a half-width header into wrapping, and the
 * cost is on the scoreboard directly below it anyway.
 */
export function formatScore(score: SlotScore, opts: { cost?: boolean } = {}): string {
  const parts = [formatDuration(score.elapsedMs), `${compactNumber(score.tokens)} tok`];
  if (opts.cost !== false && score.cost.usd != null) parts.push(formatCost(score.cost));
  return parts.join(' · ');
}

/**
 * The markdown table saved beside the diffs.
 *
 * `result.md` is what you read after the terminal is gone, so the numbers that
 * decided the comparison belong in it — including the reason a cost cell is
 * empty, which is otherwise indistinguishable from "free".
 */
export function renderScoreboard(result: VsResult, pricing: PricingTable): string {
  const rows = SLOT_IDS.map((slot) => {
    const side = result.slots[slot];
    const usage = side.usage;
    const cost = resolveCost(usage, side.model, pricing);
    return [
      `Slot ${slot.toUpperCase()}`,
      `${AGENT_LABELS[side.cli]}${side.model ? ` · \`${side.model}\`` : ''}`,
      formatDuration(side.elapsedMs),
      compactNumber(usage.inputTokens),
      compactNumber(usage.outputTokens),
      compactNumber(totalTokens(usage)),
      formatCost(cost),
      side.addOns > 0 ? String(side.addOns) : '–',
    ];
  });

  const header = '| | Agent | Time | In | Out | Total | Cost | Added |';
  const divider = '|---|---|---:|---:|---:|---:|---:|---:|';
  const unpriced = rows.some((row) => row[6] === '–');

  return [
    `## Spend\n`,
    `Wall clock: ${formatDuration(result.elapsedMs)} — both slots ran at once, so this is`,
    `the slower one rather than the sum.\n`,
    header,
    divider,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    ...(unpriced
      ? [
          '_A `–` under Cost means that CLI does not report one and no rate for its',
          'model is set. Add `pricing` entries to `~/.doet/config.json` for an',
          'estimate; a `~` marks figures doet worked out that way._',
          '',
        ]
      : []),
  ].join('\n');
}
