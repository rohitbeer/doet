import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import type { Conductor } from '../core/conductor.js';
import type { SessionStore } from '../core/sessions.js';
import { AGENT_LABELS } from '../core/relay.js';
import { compactNumber } from '../core/util.js';
import { AGENT_IDS, type AgentAdapter, type AgentId, type AgentInfo } from '../core/types.js';
import { Composer } from './Composer.js';
import { Picker } from './Picker.js';
import { AGENT_COLOR, SPINNER } from './theme.js';

interface Props {
  bus: Bus;
  conductor: Conductor;
  agents: Record<AgentId, AgentAdapter>;
  store: SessionStore;
  defaultRounds: number;
}

interface Line {
  id: number;
  text: string;
  from?: AgentId | 'user' | 'doet';
  tone: 'info' | 'warn' | 'error' | 'good';
}

/** Exchange counts on offer. `1` is last because it is the unusual choice. */
const ROUND_CHOICES = [2, 4, 6, 8, 12, 1];

const ROUND_NOTE: Record<number, string> = {
  1: 'No review at all — the first agent answers and that is it.',
  2: 'One answer and one review. Enough for a small check.',
  12: 'For work that will genuinely take the back-and-forth.',
};

/**
 * Where each party sits on screen: Claude left, doet centre, Codex right.
 *
 * The relay line is written in that order rather than in sender-first order, so
 * it reads as the movement you are watching. `you → Claude Code` described the
 * same event but pointed the wrong way across the screen, since Claude's pane
 * is to doet's *left*.
 */
const POSITION: Record<AgentId | 'user', number> = { claude: 0, user: 1, codex: 2 };

function describeFlow(from: AgentId | 'user', to: AgentId | 'user'): string {
  const name = (who: AgentId | 'user') => (who === 'user' ? 'you' : AGENT_LABELS[who]);
  // Left-to-right on screen, with the arrow pointing the way it travelled.
  return POSITION[from] < POSITION[to]
    ? `${name(from)} ──▶ ${name(to)}`
    : `${name(to)} ◀── ${name(from)}`;
}

const TONE: Record<Line['tone'], string | undefined> = {
  info: undefined,
  warn: 'yellow',
  error: 'red',
  good: 'green',
};

/**
 * doet's pane during a co-code session.
 *
 * The two agents are having the conversation, in their own panes, in their own
 * interfaces. This pane is the part that is doet's: who is speaking, which
 * exchange we are on, the line each agent writes about the turn it just took,
 * and one place to type — either a new question, or a note that reaches
 * whoever speaks next.
 */
export function CoCode({ bus, conductor, agents, store, defaultRounds }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns ?? 100);
  const [rows, setRows] = useState(stdout.rows ?? 14);

  const [input, setInput] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [infos, setInfos] = useState<Record<AgentId, AgentInfo>>({
    claude: agents.claude.info(),
    codex: agents.codex.info(),
  });
  const [active, setActive] = useState<AgentId | null>(null);
  const [round, setRound] = useState(0);
  const [running, setRunning] = useState(false);
  /** The closing account of the run, from whoever spoke last. */
  const [summary, setSummary] = useState('');
  const [notice, setNotice] = useState('Ask a question — both agents work in this tree, in turn.');
  /**
   * `first` asks who opens, `rounds` how many exchanges.
   *
   * Both are asked per question rather than set once, because the right answer
   * depends on the question: "check this one-liner" and "rewrite this module"
   * do not want the same number of passes, and deciding when you ask beats
   * remembering to change a setting beforehand.
   */
  const [choosing, setChoosing] = useState<'first' | 'rounds' | null>(null);
  const [rounds, setRounds] = useState(defaultRounds);
  const [roundIndex, setRoundIndex] = useState(0);
  const [spinner, setSpinner] = useState(0);
  const pending = useRef('');
  const opener = useRef<AgentId>('claude');
  /** Which way the last relay travelled, for the arrow between the panes. */
  const [flow, setFlow] = useState<{ from: AgentId; to: AgentId } | null>(null);
  const lineId = useRef(0);
  const quitting = useRef(false);

  const say = useCallback((text: string, tone: Line['tone'] = 'info', from?: Line['from']) => {
    setLines((previous) => [...previous, { id: lineId.current++, text, tone, from }].slice(-300));
  }, []);

  useEffect(() => {
    const onResize = () => {
      stdout.write('[2J[3J[H');
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 14);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    const timer = setInterval(() => setSpinner((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setActive(conductor.activeAgent), 150);
    return () => clearInterval(timer);
  }, [conductor]);

  useEffect(() => bus.on((event) => {
    switch (event.kind) {
      case 'status':
      case 'usage':
      case 'turn-end':
      case 'session':
        setInfos((previous) => ({ ...previous, [event.agent]: agents[event.agent].info() }));
        break;
      case 'relay':
        setRound(event.round);
        if (event.from !== 'user') setFlow({ from: event.from, to: event.to });
        say(
          `${describeFlow(event.from, event.to)}${event.from === 'user' ? '' : ` · ${event.note}`}`,
          'info',
          event.from,
        );
        break;
      case 'peer':
        // An agent reached the other one through a doet tool rather than
        // waiting for the relay. Worth showing: it is the one thing that
        // happens in this session that neither pane explains on its own.
        say(`${AGENT_LABELS[event.from]} → ${AGENT_LABELS[event.to]} · ${event.tool}: ${event.note}`, 'good', event.from);
        break;
      case 'recap':
        // The agent's own line about the turn it just took. It is written for
        // this pane and shown nowhere else: the other agent gets the answer
        // itself, so a summary of it would be doet paraphrasing a message it is
        // already passing on in full.
        if (event.final) setSummary(event.text);
        else say(`${AGENT_LABELS[event.agent]}: ${event.text}`, 'info', event.agent);
        break;
      case 'error':
        say(event.message, 'error', event.agent);
        break;
      case 'log':
        say(event.message, event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info', 'doet');
        break;
      default:
        break;
    }
  }), [agents, bus, say]);

  const start = useCallback((query: string, first: AgentId, howMany: number) => {
    setRunning(true);
    setNotice(`${AGENT_LABELS[first]} answers first · ${howMany} exchange${howMany === 1 ? '' : 's'}`);
    setFlow(null);
    // The last run's closing line belongs to the last run.
    setSummary('');
    void conductor.run(query, first, howMany).then((result) => {
      setRunning(false);
      setFlow(null);
      store.snapshot({ claude: agents.claude.history(), codex: agents.codex.history() });
      say(
        `done — ${result.rounds} exchange${result.rounds === 1 ? '' : 's'}, ${result.reason}. Final answer from ${AGENT_LABELS[result.finalFrom]}.`,
        result.reason === 'error' ? 'error' : 'good',
      );
      setNotice(`Saved in ${store.dir} — the final answer is in ${result.finalFrom}'s pane.`);
    }).catch((error: unknown) => {
      setRunning(false);
      setFlow(null);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [agents, conductor, say, store]);

  const shutdown = useCallback(async () => {
    if (quitting.current) {
      process.stdout.write('[?25h\ndoet: forced quit.\n');
      process.exit(0);
    }
    quitting.current = true;
    setNotice('Stopping… ctrl+c again to force-quit.');
    if (conductor.isRunning) {
      await conductor.abort();
      await conductor.whenIdle();
    }
    store.snapshot({ claude: agents.claude.history(), codex: agents.codex.history() });
    store.detach();
    exit();
  }, [agents, conductor, exit, store]);

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      void shutdown();
      return;
    }
    if (choosing === 'first') {
      if (char === '1' || char === '2') {
        opener.current = char === '1' ? 'claude' : 'codex';
        setChoosing('rounds');
        setRoundIndex(Math.max(0, ROUND_CHOICES.indexOf(rounds)));
      } else if (key.escape) {
        setChoosing(null);
        setInput(pending.current);
      }
      return;
    }
    if (choosing === 'rounds') {
      if (key.upArrow) setRoundIndex((i) => (i - 1 + ROUND_CHOICES.length) % ROUND_CHOICES.length);
      else if (key.downArrow) setRoundIndex((i) => (i + 1) % ROUND_CHOICES.length);
      else if (key.return) {
        const chosen = ROUND_CHOICES[roundIndex] ?? defaultRounds;
        setChoosing(null);
        setRounds(chosen);
        start(pending.current, opener.current, chosen);
      } else if (key.escape) {
        setChoosing('first');
      }
      return;
    }
    if (key.escape) {
      if (conductor.isRunning) conductor.requestStop();
      return;
    }
    if (key.ctrl && char === 'x') {
      void conductor.abort();
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput('');
      if (conductor.isRunning) {
        // Mid-session typing is a note to the agents, not a new question.
        conductor.interject(text);
        say(`you: ${text}`, 'info', 'user');
        return;
      }
      pending.current = text;
      setChoosing('first');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) setInput((value) => value + char);
  });

  const chrome = 2 + 4 + (summary ? 2 : 0);
  const visible = lines.slice(-Math.max(1, rows - chrome));

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet · co-code</Text>
          <Text dimColor> · </Text>
          {running && <Text color="yellow">{SPINNER[spinner % SPINNER.length]} </Text>}
          <Text color={running ? 'yellow' : 'green'}>
            {running ? `exchange ${round + 1}/${rounds}` : 'ready'}
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-end"> · {notice}</Text>
        </Box>
      </Box>

      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        {AGENT_IDS.map((id) => (
          <Box key={id} flexShrink={0} marginRight={2}>
            <Text color={AGENT_COLOR[id]} bold={active === id}>
              {active === id ? '▸ ' : '  '}{AGENT_LABELS[id]}
            </Text>
            <Text dimColor>
              {' '}{infos[id].model || 'default'}
              {infos[id].effort ? `/${infos[id].effort}` : ''}
              {infos[id].usage.outputTokens != null ? ` · ${compactNumber(infos[id].usage.outputTokens)}` : ''}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {visible.map((line) => (
          <Text
            key={line.id}
            color={TONE[line.tone] ?? (line.from && line.from !== 'user' && line.from !== 'doet' ? AGENT_COLOR[line.from] : undefined)}
            wrap="truncate-end"
          >
            {line.text}
          </Text>
        ))}
      </Box>

      {/* The relay, as a direction rather than a log line. Claude's pane is to
          the left of this one and Codex's to the right, so an answer moving
          between them is an arrow that points the way it actually travelled. */}
      {flow && running && (() => {
        // Drawn in screen order — left party, arrow, right party — so the line
        // matches the movement you are watching between the panes either side.
        const rightward = POSITION[flow.from] < POSITION[flow.to];
        const left = rightward ? flow.from : flow.to;
        const right = rightward ? flow.to : flow.from;
        return (
          <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
            <Text color={AGENT_COLOR[left]} bold>{AGENT_LABELS[left]}</Text>
            <Text color={rightward ? AGENT_COLOR[flow.to] : AGENT_COLOR[flow.from]} bold>
              {rightward ? ' ──▶ ' : ' ◀── '}
            </Text>
            <Text color={AGENT_COLOR[right]} bold>{AGENT_LABELS[right]}</Text>
            <Text dimColor> · carrying the answer</Text>
          </Box>
        );
      })()}

      {choosing === 'rounds' && (
        <Box paddingX={1}>
          <Picker
            title={`How many exchanges? — ${AGENT_LABELS[opener.current]} answers first`}
            items={ROUND_CHOICES.map((n) => ({
              id: String(n),
              label: n === 1 ? 'Just one answer' : `${n} exchanges`,
              description: ROUND_NOTE[n],
              badge: n === rounds ? 'last used' : '',
            }))}
            index={roundIndex}
            width={cols - 2}
            height={6}
            hint="↑↓ move · enter start · esc back"
          />
        </Box>
      )}

      {summary && (
        <Box paddingX={1} height={2} overflow="hidden">
          <Text dimColor wrap="truncate-end">summary · {summary.replace(/\s+/g, ' ')}</Text>
        </Box>
      )}

      <Composer
        value={input}
        choosingFirst={choosing === 'first'}
        phase={running ? 'exchanging' : 'idle'}
        active={active}
        width={cols}
        hint={
          running
            ? 'type a note for whoever speaks next · esc stops after this turn · ctrl+x now'
            : 'type a question · enter, then choose who answers first'
        }
      />
    </Box>
  );
}
