import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AgentId, AgentInfo } from '../core/types.js';
import { AGENT_COLOR, SPINNER, STATUS_COLOR, STATUS_LABEL } from './theme.js';
import { compactNumber, wrapLine } from '../core/util.js';
import { isVerdictLine } from '../core/relay.js';
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

  onRows?.(rows.length, viewport);

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
      <Box>
        <Text color={color} bold>
          {info.label}
        </Text>
        <Text dimColor> {info.model || 'default'}</Text>
        {info.effort && <Text dimColor>/{info.effort}</Text>}
        {info.sessionSeq > 1 && <Text dimColor> #{info.sessionSeq}</Text>}
        <Box flexGrow={1} />
        {focused && <Text color="white">ctrl+o open </Text>}
        {!following && (
          <Text color="yellow">
            ↑{offset}{' '}
          </Text>
        )}
        {busy && <Text color={color}>{SPINNER[spinnerFrame % SPINNER.length]} </Text>}
        <Text color={STATUS_COLOR[info.status]}>{STATUS_LABEL[info.status]}</Text>
        {info.usage.outputTokens != null && (
          <Text dimColor> · {compactNumber(info.usage.outputTokens)}</Text>
        )}
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
    // doet's own control marker, which the agent was asked to emit and which
    // is stripped everywhere else. The pane renders raw token deltas, so it has
    // to drop the line itself rather than rely on the cleaned message.
    if (line.kind === 'text' && isVerdictLine(line.text)) continue;
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
