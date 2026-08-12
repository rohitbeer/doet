import React from 'react';
import { Box, Text } from 'ink';
import type { CliId, DebatePhase } from '../core/types.js';
import { AGENT_COLOR } from './theme.js';

/** One of the two participants, as the "who answers first?" prompt needs them. */
export interface Opener {
  key: string;
  label: string;
  cli: CliId;
}

interface Props {
  value: string;
  /** Set while doet is waiting for you to choose who answers first. */
  choosingFirst: boolean;
  /**
   * Who is on offer, named rather than assumed.
   *
   * This used to be hardcoded to "[1] Claude Code / [2] Codex", which stopped
   * being true twice over: co-code can run any two of the four CLIs, and it can
   * run the same one on both sides, where the only thing telling them apart is
   * the slot.
   */
  openers?: Opener[];
  phase: DebatePhase;
  active: CliId | null;
  width: number;
  hint: string;
}

export function Composer({ value, choosingFirst, openers = [], phase, active, width, hint }: Props) {
  if (choosingFirst) {
    return (
      <Box borderStyle="round" borderColor="white" paddingX={1} width={width} flexDirection="column">
        <Text bold>Who answers first?</Text>
        <Box marginTop={1}>
          {openers.map((opener) => (
            <Box key={opener.key} marginRight={3}>
              <Text color={AGENT_COLOR[opener.cli]} bold>
                [{opener.key}]
              </Text>
              <Text> {opener.label}</Text>
            </Box>
          ))}
          <Text dimColor>[esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  const running = phase !== 'idle' && phase !== 'done' && phase !== 'stopped';
  const border = running && active ? AGENT_COLOR[active] : 'gray';

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={border} paddingX={1}>
        <Text color={running ? 'yellow' : 'green'}>{running ? '·' : '>'} </Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
