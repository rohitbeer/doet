import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AgentId, AgentInfo } from '../core/types.js';
import { AGENT_COLOR, SPINNER, STATUS_COLOR, STATUS_LABEL } from './theme.js';
import { compactNumber, wrapLine } from '../core/util.js';
import { Markdown, parseInline, wrapSpans, type Span } from './markdown.js';

export type LineKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'output'
  | 'error'
  | 'note'
  /** A prompt doet handed this agent — the input half of the conversation. */
  | 'prompt'
  /** The header above a prompt block. */
  | 'prompt-head';

export interface PaneLine {
  id: number;
  kind: LineKind;
  text: string;
  ok?: boolean;
}

/** One physical row after wrapping. `first` marks the start of a logical line. */
interface Row {
  key: string;
  kind: LineKind;
  text: string;
  /** Set for prose, which is rendered as markdown rather than raw. */
  spans?: Span[];
  ok?: boolean;
  first: boolean;
}

interface Props {
  agent: AgentId;
  info: AgentInfo;
  lines: PaneLine[];
  width: number;
  height: number;
  /** Highlights the pane whose turn it is. */
  active: boolean;
  /** This pane has the keyboard for scrolling. */
  focused: boolean;
  /** Rows scrolled up from the bottom. 0 follows the live tail. */
  scroll: number;
  spinnerFrame: number;
  /**
   * What this pane has spent — time and tokens, already formatted. Passed in
   * rather than derived here because only the caller knows when the clock
   * started, and VS is the only mode that measures one.
   */
  meter?: string;
  onRows?: (rows: number, viewport: number) => void;
}

export function AgentPane({
  agent,
  info,
  lines,
  width,
  height,
  active,
  focused,
  scroll,
  spinnerFrame,
  meter,
  onRows,
}: Props) {
  const color = AGENT_COLOR[agent];
  const busy = info.status === 'thinking' || info.status === 'working';

  // Borders take 2 columns and 2 rows; the header takes 1 more row.
  const inner = Math.max(8, width - 4);
  const viewport = Math.max(1, height - 3);

  // Wrapping happens here rather than in Ink so scrollback can be exact: a
  // component that decides its own height cannot be scrolled precisely, which
  // is why this pane used to clip every line at the pane width instead.
  const rows = useMemo(() => layout(lines, inner), [lines, inner]);

  const maxScroll = Math.max(0, rows.length - viewport);
  const offset = Math.min(scroll, maxScroll);
  const end = rows.length - offset;
  const visible = rows.slice(Math.max(0, end - viewport), end);

  useEffect(() => {
    onRows?.(rows.length, viewport);
  }, [onRows, rows.length, viewport]);

  const following = offset === 0;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={focused ? 'double' : active ? 'round' : 'single'}
      borderColor={focused ? 'white' : active ? color : 'gray'}
      paddingX={1}
    >
      {/*
        One row, and it has to stay one row. The pane reserves exactly one for
        it (`viewport = height - 3`), so a header that wraps does not get taller
        — it pushes a row of the agent's output off the bottom of a pane whose
        scrollback still believes it is there. Hence nowrap, and a left group
        that truncates: at half a narrow terminal the model id is the least
        useful thing here, and the status and the counters are the most.
      */}
      <Box flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text color={color} bold>
            {info.label}
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {' '}
            {info.model || 'default'}
            {info.effort ? `/${info.effort}` : ''}
            {info.sessionSeq > 1 ? ` #${info.sessionSeq}` : ''}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} />
        <Box flexShrink={0}>
          {focused && <Text color="white">enter open </Text>}
          {!following && (
            <Text color="yellow">
              ↑{offset}{' '}
            </Text>
          )}
          {busy && <Text color={color}>{SPINNER[spinnerFrame % SPINNER.length]} </Text>}
          <Text color={STATUS_COLOR[info.status]}>{STATUS_LABEL[info.status]}</Text>
          {/* One or the other, never both: a second counter is what pushed
              this row over the edge in the first place. */}
          {meter ? (
            <Text dimColor> · {meter}</Text>
          ) : (
            info.usage.outputTokens != null && (
              <Text dimColor> · {compactNumber(info.usage.outputTokens)}</Text>
            )
          )}
        </Box>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((row) => (
          <PaneRow key={row.key} row={row} color={color} />
        ))}
      </Box>
    </Box>
  );
}

/** Expand logical lines into wrapped display rows. */
function layout(lines: PaneLine[], width: number): Row[] {
  const rows: Row[] = [];
  for (const line of lines) {
    // Prompt bodies get a gutter, so they wrap two columns narrower.
    const isPrompt = line.kind === 'prompt';
    const room = isPrompt ? Math.max(4, width - 2) : width;

    // Assistant prose is markdown, and both agents' own CLIs render it. Doing
    // the same here means wrapping the *visible* text: `**Goal**` is eight
    // columns of source and four of screen, so parsing has to come first.
    if (line.kind === 'text') {
      wrapSpans(parseInline(line.text), room).forEach((spans, index) => {
        rows.push({
          key: `${line.id}:${index}`,
          kind: line.kind,
          text: '',
          spans,
          first: index === 0,
        });
      });
      continue;
    }

    wrapLine(line.text, room).forEach((text, index) => {
      rows.push({
        key: `${line.id}:${index}`,
        kind: line.kind,
        text,
        ok: line.ok,
        first: index === 0,
      });
    });
  }
  return rows;
}

function PaneRow({ row, color }: { row: Row; color: string }) {
  switch (row.kind) {
    case 'thinking':
      return (
        <Text dimColor italic>
          {row.text}
        </Text>
      );
    case 'tool':
      return (
        <Text>
          <Text color={row.ok === false ? 'red' : color}>
            {row.first ? (row.ok === false ? '✗ ' : '⏵ ') : '  '}
          </Text>
          <Text>{row.text}</Text>
        </Text>
      );
    case 'output':
      return <Text dimColor>{row.text}</Text>;
    case 'error':
      return <Text color="red">{row.text}</Text>;
    case 'note':
      return <Text color="yellow">{row.text}</Text>;
    case 'prompt-head':
      return (
        <Text color="blue" bold>
          {row.text}
        </Text>
      );
    case 'prompt':
      // A gutter, so the input half of the conversation is unmistakable at a
      // glance even when it fills the pane.
      return (
        <Text color="blue" dimColor>
          {'▎ '}
          {row.text}
        </Text>
      );
    default:
      return row.spans ? <Markdown spans={row.spans} /> : <Text>{row.text}</Text>;
  }
}
