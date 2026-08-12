import React from 'react';
import { Box, Text } from 'ink';
import { formatCost, type SlotScore } from '../core/scoreboard.js';
import { compactNumber, formatDuration } from '../core/util.js';
import { AGENT_COLOR, SPINNER } from './theme.js';
import type { CliId, SlotId } from '../core/types.js';

/** Rows this band occupies — a title, and one line per slot. */
export function scoreboardRows(slots: number): number {
  return 1 + slots;
}

interface Props {
  scores: SlotScore[];
  agents: Record<SlotId, CliId>;
  /** Wall clock for the run: the slowest slot, not the sum. */
  elapsedMs: number;
  finished: boolean;
  width: number;
  spinnerFrame: number;
  /** Files and lines each slot changed, once there is a diff to report. */
  diffs?: Partial<Record<SlotId, string>>;
  /**
   * The slot the keyboard is on, drawn with a marker.
   *
   * With two agents you could address one with `tab` and see which from the
   * header. With nine the scoreboard *is* the list you are choosing from, so
   * the selection has to be visible on the row itself.
   */
  selected?: SlotId | null;
}

/**
 * What each slot spent, side by side.
 *
 * Two implementations that both work are not equal, and the diff alone does not
 * say which one you would run again — the one that took forty seconds and eight
 * thousand tokens is a different proposition from the one that took four
 * minutes and eighty. It counts up live rather than appearing at the end,
 * because "this side is taking twice as long" is worth knowing while there is
 * still time to add a message and steer it.
 */
export function Scoreboard({
  scores,
  agents,
  elapsedMs,
  finished,
  width,
  spinnerFrame,
  diffs,
  selected,
}: Props) {
  // Every row lines up on the same columns, so the slots can be read as a
  // comparison instead of as a list of sentences.
  const labelWidth = Math.max(...scores.map((score) => score.label.length), 1);

  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text dimColor>── </Text>
        <Text color={finished ? 'green' : 'yellow'}>
          {finished ? 'spent' : `${SPINNER[spinnerFrame % SPINNER.length]} running`}
        </Text>
        <Text dimColor> · {formatDuration(elapsedMs)} wall clock ──</Text>
      </Box>
      {scores.map((score) => (
        <Box key={score.slot} width={width} flexWrap="nowrap" overflow="hidden">
          <Text color={selected === score.slot ? 'cyan' : undefined} bold>
            {selected === score.slot ? '❯' : ' '}
          </Text>
          <Text color={AGENT_COLOR[agents[score.slot] ?? 'claude']} bold>
            {score.slot.toUpperCase()}{' '}
          </Text>
          <Text>{score.label.padEnd(labelWidth)} </Text>
          <Text color={score.running ? 'yellow' : undefined}>
            {formatDuration(score.elapsedMs).padStart(7)}
          </Text>
          <Text dimColor>
            {' · '}
            {compactNumber(score.usage.inputTokens).padStart(6)} in
            {' · '}
            {compactNumber(score.usage.outputTokens).padStart(6)} out
          </Text>
          <Text> · {formatCost(score.cost)}</Text>
          {score.addOns > 0 && (
            <Text color="blue">
              {' · +'}
              {score.addOns} msg
            </Text>
          )}
          {diffs?.[score.slot] && <Text dimColor wrap="truncate-end"> · {diffs[score.slot]}</Text>}
        </Box>
      ))}
    </Box>
  );
}
