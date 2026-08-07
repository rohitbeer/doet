import React from 'react';
import { Box, Text } from 'ink';
import type { AgentId } from '../core/types.js';
import { AGENT_COLOR } from './theme.js';

export interface RelayEntry {
  id: number;
  from: AgentId | 'user' | 'doet';
  to?: AgentId;
  round: number;
  note: string;
  level?: 'info' | 'warn' | 'error';
}

/**
 * A single line per hand-off. This is the view of the debate as a debate —
 * who spoke, what they concluded, who got it next — as opposed to the panes,
 * which show what was actually said.
 */
export function RelayLog({ entries, width, height }: { entries: RelayEntry[]; width: number; height: number }) {
  const visible = entries.slice(-Math.max(1, height));

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {visible.map((entry) => (
        <Text key={entry.id} wrap="truncate-end">
          <Text dimColor>{String(entry.round).padStart(2, ' ')} </Text>
          <Label who={entry.from} />
          {entry.to ? (
            <>
              <Text dimColor> → </Text>
              <Label who={entry.to} />
            </>
          ) : null}
          <Text
            color={entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : undefined}
            dimColor={!entry.level || entry.level === 'info'}
          >
            {'  '}
            {entry.note}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function Label({ who }: { who: AgentId | 'user' | 'doet' }) {
  if (who === 'user') return <Text color="white" bold>you</Text>;
  if (who === 'doet') return <Text color="gray" bold>doet</Text>;
  return (
    <Text color={AGENT_COLOR[who]} bold>
      {who}
    </Text>
  );
}
