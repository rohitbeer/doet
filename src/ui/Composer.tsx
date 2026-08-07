import React from 'react';
import { Box, Text } from 'ink';
import type { AgentId, DebatePhase } from '../core/types.js';
import { AGENT_COLOR } from './theme.js';

interface Props {
  value: string;
  /** Set while doet is waiting for you to choose who answers first. */
  choosingFirst: boolean;
  phase: DebatePhase;
  active: AgentId | null;
  width: number;
  hint: string;
}

export function Composer({ value, choosingFirst, phase, active, width, hint }: Props) {
  if (choosingFirst) {
    return (
      <Box borderStyle="round" borderColor="white" paddingX={1} width={width} flexDirection="column">
        <Text bold>Who answers first?</Text>
        <Box marginTop={1}>
          <Box marginRight={3}>
            <Text color={AGENT_COLOR.claude} bold>
              [1]
            </Text>
            <Text> Claude Code</Text>
          </Box>
          <Box marginRight={3}>
            <Text color={AGENT_COLOR.codex} bold>
              [2]
            </Text>
            <Text> Codex</Text>
          </Box>
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
