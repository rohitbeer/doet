import React from 'react';
import { Box, Text } from 'ink';
import { wrapLine } from '../core/util.js';

export interface PickerItem {
  id: string;
  label: string;
  description?: string;
  /** Right-aligned annotation, e.g. the current selection or a default marker. */
  badge?: string;
}

interface Props {
  title: string;
  items: PickerItem[];
  index: number;
  width: number;
  /** Rows of the list to show at once. */
  height?: number;
  hint?: string;
}

/**
 * One list, arrow keys, enter. Used for models, efforts, agents and handoff
 * choices alike — the point being that picking a model should not require
 * typing its id exactly right from memory, which is how it worked before.
 */
export function Picker({ title, items, index, width, height = 8, hint }: Props) {
  const inner = Math.max(20, width - 4);

  // Keep the cursor inside a scrolling window when the list is long.
  const window = Math.min(height, items.length);
  const start = Math.max(0, Math.min(index - Math.floor(window / 2), items.length - window));
  const visible = items.slice(start, start + window);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      <Text bold>{title}</Text>

      <Box flexDirection="column" marginTop={1}>
        {visible.map((item, offset) => {
          const selected = start + offset === index;
          // The description is the reason a picker beats typing an id, so it is
          // wrapped rather than clipped — but only for the highlighted row, to
          // keep the list's height predictable.
          const description =
            selected && item.description
              ? wrapLine(item.description, inner - 4).slice(0, 2)
              : [];

          return (
            <Box key={item.id} flexDirection="column">
              <Box>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {selected ? '❯ ' : '  '}
                  {item.label}
                </Text>
                {item.badge && <Text dimColor> {item.badge}</Text>}
              </Box>
              {description.map((line, i) => (
                <Text key={i} dimColor>
                  {'    '}
                  {line}
                </Text>
              ))}
            </Box>
          );
        })}
      </Box>

      {items.length > window && (
        <Text dimColor>
          {'  '}
          {index + 1}/{items.length}
        </Text>
      )}

      <Box marginTop={1}>
        <Text dimColor>{hint ?? '↑↓ move · enter select · esc cancel'}</Text>
      </Box>
    </Box>
  );
}
