import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import { abortMerge, commitAll, inspectRepo, mergeBranch } from '../core/git.js';
import type { PricingTable } from '../core/pricing.js';
import { elapsedFor, scoreSlot, type SlotScore } from '../core/scoreboard.js';
import type { SessionStore } from '../core/sessions.js';
import type { TmuxSession } from '../core/tmux.js';
import type { AgentInfo, CliId, SlotId, VsResult } from '../core/types.js';
import type { VsRunner, VsSide } from '../core/vs.js';
import { Composer } from './Composer.js';
import { Scoreboard } from './Scoreboard.js';
import { AGENT_COLOR, SPINNER } from './theme.js';

interface Props {
  buses: Record<SlotId, Bus>;
  sides: Record<SlotId, VsSide>;
  order: SlotId[];
  runner: VsRunner;
  store: SessionStore;
  session: TmuxSession;
  root: string;
  pricing: PricingTable;
}

/** One line of doet's own narration. The agents narrate themselves, in their panes. */
interface Note {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'error' | 'good';
}

const TONE_COLOR: Record<Note['tone'], string | undefined> = {
  info: undefined,
  warn: 'yellow',
  error: 'red',
  good: 'green',
};

/**
 * doet's own screen in a VS run — the dashboard.
 *
 * It used to be a narrow pane wedged between two agents. That worked for two
 * and stops working at three: five agents tiled beside doet gets every one of
 * them about fifteen columns, which is not a coding agent, it is a column of
 * broken words.
 *
 * So VS borrows co-code's modern arrangement. Each agent has a tmux window to
 * itself, running at the full width of your terminal whether or not you are
 * looking at it, and this takes the whole screen: a row per agent with what it
 * has spent and what its branch holds. You move down the list with the arrow
 * keys and open the one you want.
 *
 * Two keys do the things you actually want from a list like this:
 *
 *   enter — go to that agent's window and watch it work.
 *   w     — open its *worktree* in a new window, with its session forked, so
 *           you can pick up where it got to without touching the run.
 *
 * The second is the one that needed the CLI work behind it. A fork is a copy of
 * the conversation, not a second client on it: the agent carries on undisturbed
 * in its own window while you have the whole of its context in yours. Claude and
 * kilo can do it; Codex and cline cannot, and say so rather than quietly
 * resuming the live session and corrupting it.
 */
export function Control({
  buses,
  sides,
  order,
  runner,
  store,
  session,
  root,
  pricing,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns ?? 100);
  const [rows, setRows] = useState(stdout.rows ?? 14);

  const [input, setInput] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [infos, setInfos] = useState<Record<SlotId, AgentInfo>>(() =>
    Object.fromEntries(order.map((slot) => [slot, sides[slot]!.adapter.info()])),
  );
  const [running, setRunning] = useState(false);
  const [runningSlots, setRunningSlots] = useState<SlotId[]>([]);
  const [finished, setFinished] = useState<VsResult | null>(null);
  const [notice, setNotice] = useState(
    `Type a request — all ${order.length} agents get it, each in its own worktree.`,
  );
  const [spinner, setSpinner] = useState(0);
  /** Where the keyboard is. Never null: with a list, something is always current. */
  const [cursor, setCursor] = useState<SlotId>(order[0]!);
  /** Set when enter should address one agent rather than all of them. */
  const [target, setTarget] = useState<SlotId | null>(null);
  const [plugged, setPlugged] = useState<Record<SlotId, boolean>>({});
  const [mergeConflict, setMergeConflict] = useState(false);

  const noteId = useRef(0);
  const quitting = useRef(false);

  const say = useCallback((text: string, tone: Note['tone'] = 'info') => {
    setNotes((previous) => [...previous, { id: noteId.current++, text, tone }].slice(-200));
  }, []);

  const refreshInfo = useCallback((slot: SlotId) => {
    const side = sides[slot];
    if (!side) return;
    setInfos((previous) => ({ ...previous, [slot]: side.adapter.info() }));
  }, [sides]);

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

  // Only doet's own events reach here — status, usage, errors and notes. The
  // agents' prose and tool calls never enter this process at all.
  useEffect(() => {
    const off = order.map((slot) => buses[slot]!.on((event) => {
      switch (event.kind) {
        case 'status':
        case 'usage':
        case 'session':
        case 'turn-end':
        case 'attention':
          refreshInfo(slot);
          break;
        case 'error':
          say(`${slot.toUpperCase()}: ${event.message}`, 'error');
          break;
        case 'log':
          say(
            `${slot.toUpperCase()}: ${event.message}`,
            event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
          );
          break;
        default:
          break;
      }
    }));
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [buses, order, refreshInfo, say]);

  useEffect(() => {
    for (const slot of order) {
      say(`${slot.toUpperCase()} → ${sides[slot]!.worktree.branch}`, 'info');
    }
  }, [order, say, sides]);

  const start = useCallback((query: string) => {
    const unavailable = order.filter((slot) => plugged[slot]);
    if (unavailable.length > 0) {
      setNotice(
        `${unavailable.map((s) => s.toUpperCase()).join(', ')} already moved into the main tree, so there is nothing isolated left to compare.`,
      );
      return;
    }
    setRunning(true);
    setRunningSlots(order);
    setNotice(`All ${order.length} agents are working — enter opens the one you are on.`);
    void runner.run(query).then((result) => {
      setFinished(result);
      setRunning(false);
      setRunningSlots([]);
      for (const slot of result.order) {
        const side = result.slots[slot];
        if (!side) continue;
        say(
          side.error
            ? `${slot.toUpperCase()} failed: ${side.error}`
            : `${slot.toUpperCase()} ready · ${side.files}f +${side.insertions} −${side.deletions} · ${side.branch}`,
          side.error ? 'error' : 'good',
        );
        refreshInfo(slot);
      }
      setNotice(`Saved in ${store.dir} · p plugs the selected agent into main`);
    }).catch((error: unknown) => {
      setRunning(false);
      setRunningSlots([]);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [order, plugged, refreshInfo, runner, say, store.dir]);

  const sendTo = useCallback(async (slot: SlotId, text: string) => {
    try {
      const { delivery, turn } = await runner.addMessage(slot, text);
      say(`→ ${slot.toUpperCase()} (${delivery === 'live' ? 'added mid-turn' : 'its own turn'})`, 'info');
      if (!turn) return;
      setRunning(true);
      setRunningSlots((current) => (current.includes(slot) ? current : [...current, slot]));
      await turn.catch(() => undefined);
      setRunning(runner.isRunning);
      setRunningSlots((current) => current.filter((id) => id !== slot));
      refreshInfo(slot);
      const diff = await runner.diffFor(slot).catch(() => null);
      if (diff) {
        setFinished((current) => {
          const side = current?.slots[slot];
          if (!current || !side) return current;
          return { ...current, slots: { ...current.slots, [slot]: { ...side, ...diff } } };
        });
      }
      say(`${slot.toUpperCase()} finished — its branch has the change.`, 'good');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refreshInfo, runner, say]);

  /** Go and watch this agent work, in the window it has to itself. */
  const openAgent = useCallback(async (slot: SlotId) => {
    const window = infos[slot]?.window;
    if (window === undefined) {
      setNotice(`Slot ${slot.toUpperCase()} has no window of its own yet.`);
      return;
    }
    await session.selectWindow(window);
  }, [infos, session]);

  /**
   * Open this agent's worktree with its session forked into it.
   *
   * The point of the fork is that the run carries on. You get a session that has
   * read everything that agent read and made everything it made, in the same
   * checkout, and nothing you do in it lands in the comparison.
   */
  const openWorktree = useCallback(async (slot: SlotId) => {
    const side = sides[slot];
    if (!side) return;
    try {
      const fork = await side.adapter.forkSession();
      if (!fork) {
        const info = infos[slot];
        setNotice(
          info?.sessionId
            ? `${info.label} cannot fork a session, so doet will not open one — it would be a second client on the session that agent is still working in.`
            : `Slot ${slot.toUpperCase()} has no session yet. Send a request first.`,
        );
        return;
      }
      const placed = await session.newWindow({
        title: `${slot.toUpperCase()} · worktree · ${side.worktree.branch}  —  F12 back to doet`,
        name: `${slot}-tree`,
        cwd: side.worktree.path,
        command: fork.command,
        args: fork.args,
      });
      await session.selectWindow(placed.window);
      store.appendNote(`Opened slot ${slot.toUpperCase()}'s worktree on a fork of its session.`);
      say(`${slot.toUpperCase()} — forked into ${side.worktree.path}`, 'good');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [infos, say, session, sides, store]);

  /** Squash one agent's branch into the main tree and keep working there. */
  const plug = useCallback(async (slot: SlotId) => {
    const side = sides[slot];
    if (!side) return;
    try {
      if (running) {
        setNotice('Wait for the current turn to finish first.');
        return;
      }
      const state = await inspectRepo(root);
      if (!state) throw new Error('The main working tree is no longer a git repository.');
      if (!state.clean) {
        setNotice('The main tree has uncommitted changes. Commit or stash them first.');
        return;
      }
      await commitAll(side.worktree.path, `doet vs: slot ${slot} before plug`);
      const outcome = await mergeBranch(root, side.worktree.branch, { squash: true });
      if (!outcome.ok) {
        setMergeConflict(outcome.conflicts.length > 0);
        setNotice(
          outcome.conflicts.length > 0
            ? `Conflicts in ${outcome.conflicts.join(', ')} — press x to abort the merge.`
            : outcome.message,
        );
        return;
      }
      const commit = await commitAll(root, `doet vs: plug slot ${slot} (${side.cli})`);
      // Restarts that CLI in the main tree on the same session, so the window
      // you were reading carries on where it was.
      await side.adapter.setCwd(root);
      refreshInfo(slot);
      setMergeConflict(false);
      setPlugged((current) => ({ ...current, [slot]: true }));
      setTarget(slot);
      store.appendNote(
        `Plugged slot ${slot.toUpperCase()} into main${commit.changed ? ` as ${commit.sha.slice(0, 12)}` : ''}.`,
      );
      say(`${slot.toUpperCase()} plugged into main — it is now on the main tree.`, 'good');
      setNotice(`Typing now continues slot ${slot.toUpperCase()} in the main tree.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refreshInfo, root, running, say, sides, store]);

  const shutdown = useCallback(async () => {
    if (quitting.current) {
      process.stdout.write('[?25h\ndoet: forced quit. Branches and worktrees are intact.\n');
      process.exit(0);
    }
    quitting.current = true;
    setNotice('Stopping… ctrl+c again to force-quit.');
    if (runner.isRunning) await runner.abort();
    store.detach();
    exit();
  }, [exit, runner, store]);

  const move = useCallback((delta: number) => {
    setCursor((current) => {
      const index = order.indexOf(current);
      const next = (index + delta + order.length) % order.length;
      return order[next]!;
    });
  }, [order]);

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      void shutdown();
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.tab) {
      // Addresses the agent the cursor is on, or clears the address if it is
      // already the one being addressed.
      setTarget((current) => (current === cursor ? null : cursor));
      return;
    }
    if (key.escape) {
      if (target) setTarget(null);
      else if (running) void runner.abort();
      return;
    }
    if (key.return) {
      const text = input.trim();
      // Enter on an empty composer is "show me this one", which is the thing you
      // want most often from a list of agents you cannot see.
      if (!text) {
        void openAgent(cursor);
        return;
      }
      setInput('');
      if (target) void sendTo(target, text);
      else if (running) setNotice('A run is in flight — tab to address one agent, or esc to stop.');
      else start(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    // Letter actions only when the composer is empty, or every `w` typed into a
    // request would open a worktree.
    if (!input) {
      if (char === 'w') {
        void openWorktree(cursor);
        return;
      }
      if (char === 'p' && finished && !running) {
        void plug(cursor);
        return;
      }
      if (char === 'x' && mergeConflict) {
        void abortMerge(root).then((outcome) => {
          setMergeConflict(false);
          setNotice(outcome.ok ? 'Merge aborted; main tree restored.' : outcome.stderr);
        });
        return;
      }
    }
    if (char && !key.ctrl && !key.meta) setInput((value) => value + char);
  });

  const now = Date.now();
  const stats = useMemo(
    () => Object.fromEntries(order.map((slot) => [slot, runner.statsFor(slot)])),
    // Recomputed every frame on purpose: the counters are live while a run is in
    // flight, and the spinner tick is what drives the redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, runner, spinner],
  );
  const scores: SlotScore[] = order.map((slot) => scoreSlot({
    slot,
    label: infos[slot]?.label ?? slot.toUpperCase(),
    model: infos[slot]?.model ?? '',
    stats: stats[slot]!,
    pricing,
    now,
  }));
  const wallClock = Math.max(0, ...order.map((slot) => elapsedFor(stats[slot]!, now)));
  const agents: Record<SlotId, CliId> = Object.fromEntries(
    order.map((slot) => [slot, sides[slot]!.cli]),
  );
  const diffs: Partial<Record<SlotId, string>> = finished
    ? Object.fromEntries(order.flatMap((slot) => {
        const side = finished.slots[slot];
        return side ? [[slot, `${side.files}f +${side.insertions} −${side.deletions}`]] : [];
      }))
    : {};

  const started = running || finished !== null;
  const chrome = 1 /* header */ + (started ? 1 + order.length : 0) + 4 /* composer */;
  const noteRows = Math.max(1, rows - chrome);
  const visible = notes.slice(-noteRows);

  const summary = useMemo(() => {
    if (running) {
      return runningSlots.length === order.length
        ? `all ${order.length} working`
        : `${runningSlots.map((slot) => slot.toUpperCase()).join(', ')} working`;
    }
    return finished ? 'branches ready' : 'ready';
  }, [finished, order.length, running, runningSlots]);

  const waiting = order.filter((slot) => infos[slot]?.attention);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet · vs</Text>
          <Text dimColor> · {order.length} agents</Text>
          {target && (
            <Text color={AGENT_COLOR[sides[target]!.cli]} bold>
              {' '}→ {target.toUpperCase()}
            </Text>
          )}
        </Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Text dimColor> · </Text>
          {running && <Text color="yellow">{SPINNER[spinner % SPINNER.length]} </Text>}
          <Text color={finished && !running ? 'green' : running ? 'yellow' : 'white'}>{summary}</Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-end"> · {notice}</Text>
        </Box>
      </Box>

      {started && (
        <Box paddingX={1} height={1 + order.length} overflow="hidden">
          <Scoreboard
            scores={scores}
            agents={agents}
            elapsedMs={wallClock}
            finished={!running}
            width={cols - 2}
            spinnerFrame={spinner}
            diffs={diffs}
            selected={cursor}
          />
        </Box>
      )}

      {waiting.length > 0 && (
        <Box paddingX={1}>
          <Text color="yellow">
            {waiting.map((slot) => `${slot.toUpperCase()} ${infos[slot]?.attention}`).join(' · ')}
          </Text>
        </Box>
      )}

      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {visible.map((note) => (
          <Text key={note.id} color={TONE_COLOR[note.tone]} wrap="truncate-end">
            {note.text}
          </Text>
        ))}
      </Box>

      <Composer
        value={input}
        choosingFirst={false}
        phase={running ? 'exchanging' : finished ? 'done' : 'idle'}
        active={running ? (sides[runningSlots[0] ?? order[0]!]?.cli ?? null) : null}
        width={cols}
        hint={
          target
            ? `enter sends to ${target.toUpperCase()} alone · tab clears it · ↑↓ moves`
            : input
              ? 'enter sends to every agent · tab addresses the selected one'
              : `↑↓ select · enter opens ${cursor.toUpperCase()} · w opens its worktree (forked)` +
                (finished && !running ? ' · p plugs it into main' : '') +
                (mergeConflict ? ' · x aborts the merge' : '')
        }
      />
    </Box>
  );
}
