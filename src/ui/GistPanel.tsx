import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Markdown, parseInline, wrapSpans, type Span } from './markdown.js';

interface Props {
  gist: string;
  source: string;
  width: number;
  height: number;
  /** Rows scrolled up from the top. */
  scroll: number;
}

/**
 * The running digest, in the band the relay log otherwise occupies.
 *
 * The relay log answers "who spoke and when"; this answers "what has actually
 * been established" — the thing that gets hard to hold in your head once a
 * session runs past a few exchanges.
 */
export function GistPanel({ gist, source, width, height, scroll }: Props) {
  const rows = useMemo<Span[][]>(() => {
    if (!gist.trim()) return [];
    const inner = Math.max(20, width - 2);
    return gist
      .split('\n')
      .flatMap((line) => (line.trim() ? wrapSpans(parseInline(line), inner) : [[]]));
  }, [gist, width]);

  const body = Math.max(1, height - 1);
  const offset = Math.min(scroll, Math.max(0, rows.length - body));
  const visible = rows.slice(offset, offset + body);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box>
        <Text color="cyan" bold>
          notes
        </Text>
        <Text dimColor> {source}</Text>
        {rows.length > body && (
          <Text dimColor>
            {' '}
            · {offset + 1}–{Math.min(offset + body, rows.length)}/{rows.length} · ↑↓ scroll
          </Text>
        )}
        <Box flexGrow={1} />
        <Text dimColor>ctrl+g relay log</Text>
      </Box>

      {visible.length > 0 ? (
        visible.map((spans, index) => <Markdown key={index} spans={spans} />)
      ) : (
        <Text dimColor>
          {gist.trim() ? '' : 'No notes yet — written after the first full exchange.'}
        </Text>
      )}
    </Box>
  );
}
