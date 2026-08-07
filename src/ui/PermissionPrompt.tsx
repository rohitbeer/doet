import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionRequest } from '../core/types.js';
import { AGENT_COLOR } from './theme.js';

const KIND_VERB: Record<PermissionRequest['kind'], string> = {
  exec: 'wants to run',
  edit: 'wants to edit',
  tool: 'wants to use',
  grant: 'is asking for',
  input: 'is asking you',
};

interface Props {
  request: PermissionRequest;
  /** How many more are stacked up behind this one. */
  queued: number;
  width: number;
}

/**
 * Both agents' prompts render through this one component. That is the point of
 * the normalized PermissionRequest type — you approve a Codex shell command and
 * a Claude file edit with the same keys, without learning two UIs.
 */
export function PermissionPrompt({ request, queued, width }: Props) {
  const color = AGENT_COLOR[request.agent];
  const detail = request.detail?.split('\n').slice(0, 12) ?? [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Box>
        <Text color={color} bold>
          {request.agent === 'claude' ? 'Claude Code' : 'Codex'}
        </Text>
        <Text> {KIND_VERB[request.kind]} </Text>
        <Text bold>{request.title}</Text>
        {queued > 0 && <Text dimColor> (+{queued} waiting)</Text>}
      </Box>

      <Box marginTop={1}>
        <Text wrap="truncate-end">{request.summary}</Text>
      </Box>

      {request.reason && (
        <Box>
          <Text dimColor wrap="truncate-end">
            {request.reason}
          </Text>
        </Box>
      )}

      {detail.length > 0 && detail.join('\n') !== request.summary && (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          {detail.map((line, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {'│ '}
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        {request.options.map((option, index) => (
          <Box key={option.id} marginRight={2}>
            <Text
              color={
                option.tone === 'deny' ? 'red' : option.tone === 'danger' ? 'yellow' : 'green'
              }
              bold={index === 0}
            >
              [{option.key}]
            </Text>
            <Text> {option.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
