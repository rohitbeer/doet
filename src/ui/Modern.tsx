import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import type { Conductor } from '../core/conductor.js';
import type { SessionStore } from '../core/sessions.js';
import type { TmuxSession } from '../core/tmux.js';
import { AGENT_LABELS } from '../core/relay.js';
import { compactNumber } from '../core/util.js';
import { AGENT_IDS, type AgentAdapter, type AgentId, type AgentInfo } from '../core/types.js';
import { Composer } from './Composer.js';
import { Picker } from './Picker.js';
import { AGENT_COLOR, SPINNER, THINKING_WORDS } from './theme.js';
import { isMouseReport, useMouse } from './useMouse.js';

interface Props {
  bus: Bus;
  conductor: Conductor;
  agents: Record<AgentId, AgentAdapter>;
  store: SessionStore;
  session: TmuxSession;
  defaultRounds: number;
}

const ROUND_CHOICES = [2, 4, 6, 8, 12, 1];

const ROUND_NOTE: Record<number, string> = {
  1: 'No review at all — the first agent answers and that is it.',
  2: 'One answer and one review. Enough for a small check.',
  12: 'For work that will genuinely take the back-and-forth.',
};

/**
 * One line of the conversation's shape.
 *
 * `user` is something you said. `agent` is a turn somebody took, and is the
 * only kind you can open — it stands for a real session in a real window.
 * `note` is doet's own voice: an error, a warning, the closing line of a run.
 */
interface Entry {
  id: number;
  kind: 'user' | 'agent' | 'note';
  agent?: AgentId;
  /** Who handed this turn over, for the arrow. Absent on the opening turn. */
  from?: AgentId | 'user';
  text: string;
  tone: 'info' | 'warn' | 'error' | 'good';
}

const TONE: Record<Entry['tone'], string | undefined> = {
  info: undefined,
  warn: 'yellow',
  error: 'red',
  good: 'green',
};

/**
 * Rows above the flow list, and the reason this is a constant.
 *
 * A click arrives as a row number, and turning that back into "which agent did
 * you click" is arithmetic against wherever the list starts. That makes the
 * layout below load-bearing rather than cosmetic: header, agent strip, and the
 * rule under them are exactly three rows, and a fourth row added there without
 * changing this number would silently open the wrong agent.
 */
const FLOW_TOP = 3;

/** Width of the name column, so the arrows below it line up into a path. */
const NAME_WIDTH = 17;
/** Width of the arrow column. */
const ARROW_WIDTH = 16;

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/**
 * doet's pane, when doet has the whole terminal.
 *
 * The agents are not on screen. They are running, in windows of their own, at
 * full width — see `newWindow` — and what is here instead is the thing you
 * could never see when all three panes were fighting for the same row: the
 * shape of the conversation. Who has it. Which way it went. What each turn came
 * to, in the agent's own words.
 *
 * Every agent line is a door. Click it, or walk to it and press tab, and you
 * are in that session — the real one, with its scrollback and its composer,
 * exactly as if it had been on screen the whole time. `M-0` brings you back.
 */
export function Modern({ bus, conductor, agents, store, session, defaultRounds }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns ?? 100);
  const [rows, setRows] = useState(stdout.rows ?? 24);

  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [infos, setInfos] = useState<Record<AgentId, AgentInfo>>({
    claude: agents.claude.info(),
    codex: agents.codex.info(),
  });
  const [active, setActive] = useState<AgentId | null>(null);
  const [round, setRound] = useState(0);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState('');
  const [notice, setNotice] = useState('Ask a question — both agents work in this tree, in turn.');
  const [choosing, setChoosing] = useState<'first' | 'rounds' | null>(null);
  const [rounds, setRounds] = useState(defaultRounds);
  const [roundIndex, setRoundIndex] = useState(0);
  const [spinner, setSpinner] = useState(0);
  const [word, setWord] = useState(0);
  /**
   * Which agent line the cursor is on, as an index into the *visible* rows.
   * Null follows the newest, which is what you want while a run is moving.
   */
  const [cursor, setCursor] = useState<number | null>(null);

  const pending = useRef('');
  const opener = useRef<AgentId>('claude');
  const entryId = useRef(0);
  const quitting = useRef(false);

  const add = useCallback((entry: Omit<Entry, 'id'>) => {
    setEntries((previous) => [...previous, { ...entry, id: entryId.current++ }].slice(-300));
  }, []);

  useEffect(() => {
    const onResize = () => {
      stdout.write('[2J[3J[H');
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 24);
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

  // Slower than the spinner on purpose: a word that changes ten times a second
  // is unreadable, and this one is meant to be read once and then ignored.
  useEffect(() => {
    const timer = setInterval(() => setWord((value) => value + 1), 1_600);
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
      case 'attention':
        setInfos((previous) => ({ ...previous, [event.agent]: agents[event.agent].info() }));
        break;
      case 'relay':
        setRound(event.round);
        if (event.from === 'user') {
          // The question itself is already on screen as the `user` entry; this
          // is only the hand-off into the first agent.
          add({ kind: 'agent', agent: event.to, from: 'user', text: '', tone: 'info' });
        } else {
          add({ kind: 'agent', agent: event.to, from: event.from, text: '', tone: 'info' });
        }
        break;
      case 'recap':
        // The agent's own line about the turn it just took, which is exactly
        // what the flow wants written beside the arrow. Attached to the newest
        // line belonging to that agent rather than appended, so a turn stays
        // one row however much the agent had to say about it.
        if (event.final) {
          setSummary(event.text);
          break;
        }
        setEntries((previous) => {
          const next = [...previous];
          for (let i = next.length - 1; i >= 0; i--) {
            const entry = next[i];
            if (entry && entry.kind === 'agent' && entry.agent === event.agent && !entry.text) {
              next[i] = { ...entry, text: event.text };
              return next;
            }
          }
          return [...previous, { id: entryId.current++, kind: 'agent', agent: event.agent, text: event.text, tone: 'info' }];
        });
        break;
      case 'peer':
        add({
          kind: 'agent',
          agent: event.to,
          from: event.from,
          text: `${event.tool}: ${event.note}`,
          tone: 'good',
        });
        break;
      case 'error':
        add({ kind: 'note', text: event.message, tone: 'error' });
        break;
      case 'log':
        add({
          kind: 'note',
          text: event.message,
          tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
        });
        break;
      default:
        break;
    }
  }), [add, agents, bus]);

  const start = useCallback((query: string, first: AgentId, howMany: number) => {
    setRunning(true);
    setNotice(`${AGENT_LABELS[first]} answers first · ${howMany} exchange${howMany === 1 ? '' : 's'}`);
    setSummary('');
    add({ kind: 'user', text: query, tone: 'info' });
    void conductor.run(query, first, howMany).then((result) => {
      setRunning(false);
      store.snapshot({ claude: agents.claude.history(), codex: agents.codex.history() });
      add({
        kind: 'note',
        text: `done — ${result.rounds} exchange${result.rounds === 1 ? '' : 's'}, ${result.reason}. Final answer from ${AGENT_LABELS[result.finalFrom]}.`,
        tone: result.reason === 'error' ? 'error' : 'good',
      });
      setNotice(`Saved in ${store.dir} — the final answer is in ${AGENT_LABELS[result.finalFrom]}'s window.`);
    }).catch((error: unknown) => {
      setRunning(false);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [add, agents, conductor, store]);

  /** Put an agent's real session on screen. */
  const open = useCallback((id: AgentId) => {
    const window = infos[id].window;
    if (window === undefined) {
      setNotice(`${AGENT_LABELS[id]} has no window of its own yet.`);
      return;
    }
    void session.selectWindow(window);
    // F12 first, and alt second, because Option is not Meta on a stock macOS
    // terminal — `alt+0` quietly does nothing until you turn that on, and a way
    // back that might not work is worse than a duller one that always does.
    setNotice(`In ${AGENT_LABELS[id]}'s session — F12 (or ctrl+b 0) comes back here.`);
  }, [infos, session]);

  const shutdown = useCallback(async () => {
    if (quitting.current) {
      process.stdout.write('[?25h\ndoet: forced quit.\n');
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

  const chrome = FLOW_TOP + 4 + (summary ? 1 : 0);
  const flowRows = Math.max(1, rows - chrome);
  const visible = entries.slice(-flowRows);
  /** Rows within `visible` that stand for an agent, which are the openable ones. */
  const doors = useMemo(
    () => visible.flatMap((entry, index) => (entry.kind === 'agent' && entry.agent ? [index] : [])),
    [visible],
  );
  const here = cursor ?? doors[doors.length - 1] ?? null;

  const step = useCallback((by: 1 | -1) => {
    if (doors.length === 0) return;
    const at = doors.indexOf(here ?? -1);
    // From nowhere, up starts at the end and down at the start — so the first
    // press always lands on something rather than being swallowed.
    const next = at === -1 ? (by === -1 ? doors.length - 1 : 0) : at + by;
    setCursor(doors[Math.max(0, Math.min(doors.length - 1, next))] ?? null);
  }, [doors, here]);

  useMouse(true, useCallback((click) => {
    const index = click.row - 1 - FLOW_TOP;
    if (index < 0 || index >= visible.length) return;
    const entry = visible[index];
    if (!entry || entry.kind !== 'agent' || !entry.agent) return;
    setCursor(index);
    open(entry.agent);
  }, [open, visible]));

  useInput((char, key) => {
    // A click is delivered to `useInput` as well as to the mouse hook, and
    // without this every one of them would type its own coordinates into the
    // composer.
    if (isMouseReport(char)) return;

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
    if (key.upArrow) {
      step(-1);
      return;
    }
    if (key.downArrow) {
      step(1);
      return;
    }
    // Tab opens rather than enter, because enter belongs to the composer and a
    // key that sometimes sends your message and sometimes changes window is
    // worse than either.
    if (key.tab) {
      const entry = here === null ? undefined : visible[here];
      if (entry?.kind === 'agent' && entry.agent) open(entry.agent);
      return;
    }
    if (key.escape) {
      if (cursor !== null) setCursor(null);
      else if (conductor.isRunning) conductor.requestStop();
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
        conductor.interject(text);
        add({ kind: 'user', text, tone: 'info' });
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

  const flowWidth = Math.max(20, cols - 2);
  const summaryWidth = Math.max(10, flowWidth - NAME_WIDTH - ARROW_WIDTH - 2);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet</Text>
          <Text dimColor> · co-code · </Text>
          {running && <Text color="yellow">{SPINNER[spinner % SPINNER.length]} </Text>}
          <Text color={running ? 'yellow' : 'green'}>
            {running ? `exchange ${round + 1}/${rounds}` : 'ready'}
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-end"> · {notice}</Text>
        </Box>
      </Box>

      {/* The agents, as names rather than as panes. Everything you would have
          read off a live pane at a glance — which model, what it has spent,
          whether it has stopped for you — is here instead. */}
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        {AGENT_IDS.map((id) => (
          <Box key={id} flexShrink={0} marginRight={2}>
            <Text color={AGENT_COLOR[id]} bold={active === id}>
              {active === id ? '▸ ' : '  '}{AGENT_LABELS[id]}
            </Text>
            <Text dimColor>
              {infos[id].window !== undefined ? ` F${infos[id].window}` : ''}
              {' '}{infos[id].model || 'default'}
              {infos[id].effort ? `/${infos[id].effort}` : ''}
              {infos[id].usage.outputTokens != null ? ` · ${compactNumber(infos[id].usage.outputTokens)}` : ''}
            </Text>
            {infos[id].attention && (
              <Text color="yellow" bold> ⚠ {infos[id].attention}</Text>
            )}
          </Box>
        ))}
      </Box>

      <Box paddingX={1} width={cols}>
        <Text dimColor>{'─'.repeat(flowWidth)}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {visible.map((entry, index) => {
          if (entry.kind === 'user') {
            return (
              <Text key={entry.id} wrap="truncate-end">
                <Text bold>{pad('you', NAME_WIDTH)}</Text>
                <Text>{entry.text}</Text>
              </Text>
            );
          }
          if (entry.kind === 'note') {
            return (
              <Text key={entry.id} color={TONE[entry.tone]} dimColor={entry.tone === 'info'} wrap="truncate-end">
                {' '.repeat(2)}{entry.text}
              </Text>
            );
          }

          const id = entry.agent!;
          const selected = index === here;
          const working = running && active === id && !entry.text;
          return (
            <Text key={entry.id} wrap="truncate-end">
              <Text color={AGENT_COLOR[id]} bold={selected}>
                {selected ? '▾ ' : '  '}
                {pad(AGENT_LABELS[id], NAME_WIDTH - 2)}
              </Text>
              <Text dimColor>
                {pad(entry.from ? `◀── ${entry.from === 'user' ? 'you' : AGENT_LABELS[entry.from]}` : '', ARROW_WIDTH)}
              </Text>
              {working ? (
                <Text color="yellow">
                  {SPINNER[spinner % SPINNER.length]} {THINKING_WORDS[word % THINKING_WORDS.length]}…
                </Text>
              ) : (
                <Text color={TONE[entry.tone]}>
                  {entry.text.replace(/\s+/g, ' ').slice(0, summaryWidth)}
                </Text>
              )}
            </Text>
          );
        })}
      </Box>

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
        <Box paddingX={1} height={1} overflow="hidden">
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
            ? 'click a name or tab to open it · F12 comes back · type a note for whoever speaks next · esc stops after this turn'
            : 'type a question · enter, then choose who answers first · click a name to open it, F12 comes back'
        }
      />
    </Box>
  );
}
