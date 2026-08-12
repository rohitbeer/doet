import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import { abortMerge, commitAll, inspectRepo, mergeBranch } from '../core/git.js';
import type { PricingTable } from '../core/pricing.js';
import { elapsedFor, scoreSlot, type SlotScore } from '../core/scoreboard.js';
import type { SessionStore } from '../core/sessions.js';
import type { TmuxSession } from '../core/tmux.js';
import { SLOT_IDS, type AgentInfo, type SlotId, type VsResult } from '../core/types.js';
import type { VsRunner, VsSide } from '../core/vs.js';
import { Composer } from './Composer.js';
import { Scoreboard } from './Scoreboard.js';
import { AGENT_COLOR, SPINNER } from './theme.js';

interface Props {
  buses: Record<SlotId, Bus>;
  sides: Record<SlotId, VsSide>;
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
 * doet's own pane.
 *
 * There used to be two of these, each around fourteen hundred lines, and almost
 * all of it was spent redrawing the agents: wrapping their prose, colouring
 * their tool calls, tracking scrollback, arbitrating a permission prompt. None
 * of that is here, because none of it is doet's job any more — each agent
 * renders itself in its own tmux pane, far better than this ever did.
 *
 * What is left is the part that was always doet's: what the run has spent,
 * where the branches are, and one place to type.
 */
export function Control({
  buses,
  sides,
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
  const [infos, setInfos] = useState<Record<SlotId, AgentInfo>>({
    a: sides.a.adapter.info(),
    b: sides.b.adapter.info(),
  });
  const [running, setRunning] = useState(false);
  const [runningSlot, setRunningSlot] = useState<SlotId | null>(null);
  const [finished, setFinished] = useState<VsResult | null>(null);
  const [notice, setNotice] = useState('Type a request — both slots get it, in their own worktrees.');
  const [spinner, setSpinner] = useState(0);
  const [target, setTarget] = useState<SlotId | null>(null);
  const [plugged, setPlugged] = useState<Record<SlotId, boolean>>({ a: false, b: false });
  const [mergeConflict, setMergeConflict] = useState(false);

  const noteId = useRef(0);
  const quitting = useRef(false);

  const say = useCallback((text: string, tone: Note['tone'] = 'info') => {
    setNotes((previous) => [...previous, { id: noteId.current++, text, tone }].slice(-200));
  }, []);

  const refreshInfo = useCallback((slot: SlotId) => {
    setInfos((previous) => ({ ...previous, [slot]: sides[slot].adapter.info() }));
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

  // Only doet's own events reach here now — status, usage, errors and notes.
  // The agents' prose and tool calls never enter this process at all.
  useEffect(() => {
    const off = SLOT_IDS.map((slot) => buses[slot].on((event) => {
      switch (event.kind) {
        case 'status':
        case 'usage':
        case 'session':
        case 'turn-end':
          refreshInfo(slot);
          break;
        case 'error':
          say(`${slot.toUpperCase()}: ${event.message}`, 'error');
          break;
        case 'log':
          say(`${slot.toUpperCase()}: ${event.message}`, event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info');
          break;
        default:
          break;
      }
    }));
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [buses, refreshInfo, say]);

  useEffect(() => {
    for (const slot of SLOT_IDS) {
      say(`${slot.toUpperCase()} → ${sides[slot].worktree.branch}`, 'info');
    }
  }, [say, sides]);

  const start = useCallback((query: string) => {
    const unavailable = SLOT_IDS.filter((slot) => plugged[slot]);
    if (unavailable.length > 0) {
      setNotice(
        `Slot ${unavailable.map((s) => s.toUpperCase()).join(' and ')} already moved into the main tree, so there is nothing isolated left to compare.`,
      );
      return;
    }
    setRunning(true);
    setRunningSlot(null);
    setNotice('Both slots are working — watch their panes.');
    void runner.run(query).then((result) => {
      setFinished(result);
      setRunning(false);
      for (const slot of SLOT_IDS) {
        const side = result.slots[slot];
        say(
          side.error
            ? `${slot.toUpperCase()} failed: ${side.error}`
            : `${slot.toUpperCase()} ready · ${side.files}f +${side.insertions} −${side.deletions} · ${side.branch}`,
          side.error ? 'error' : 'good',
        );
        refreshInfo(slot);
      }
      setNotice(`Saved in ${store.dir} · a/b plugs a slot into main · tab targets one slot`);
    }).catch((error: unknown) => {
      setRunning(false);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [plugged, refreshInfo, runner, say, store.dir]);

  const sendTo = useCallback(async (slot: SlotId, text: string) => {
    try {
      const { delivery, turn } = await runner.addMessage(slot, text);
      say(`→ ${slot.toUpperCase()} (${delivery === 'live' ? 'added mid-turn' : 'its own turn'})`, 'info');
      if (!turn) return;
      setRunning(true);
      setRunningSlot(slot);
      await turn.catch(() => undefined);
      setRunning(runner.isRunning);
      setRunningSlot((current) => (current === slot ? null : current));
      refreshInfo(slot);
      const diff = await runner.diffFor(slot).catch(() => null);
      if (diff) {
        setFinished((current) => current && ({
          ...current,
          slots: { ...current.slots, [slot]: { ...current.slots[slot], ...diff } },
        }));
      }
      say(`${slot.toUpperCase()} finished — its branch has the change.`, 'good');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refreshInfo, runner, say]);

  /** Squash one slot's branch into the main tree and keep working there. */
  const plug = useCallback(async (slot: SlotId) => {
    const side = sides[slot];
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
      // Restarts that CLI in the main tree on the same session, so the pane you
      // were reading carries on where it was.
      await side.adapter.setCwd(root);
      await session.tile();
      refreshInfo(slot);
      setMergeConflict(false);
      setPlugged((current) => ({ ...current, [slot]: true }));
      setTarget(slot);
      store.appendNote(
        `Plugged slot ${slot.toUpperCase()} into main${commit.changed ? ` as ${commit.sha.slice(0, 12)}` : ''}.`,
      );
      say(`${slot.toUpperCase()} plugged into main — its pane is now on the main tree.`, 'good');
      setNotice(`Typing now continues slot ${slot.toUpperCase()} in the main tree.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refreshInfo, root, running, say, session, sides, store]);

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

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      void shutdown();
      return;
    }
    if (key.tab) {
      setTarget((current) => (current === null ? 'a' : current === 'a' ? 'b' : null));
      return;
    }
    if (key.escape) {
      if (target) setTarget(null);
      else if (running) void runner.abort();
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput('');
      if (target) void sendTo(target, text);
      else if (running) setNotice('A run is in flight — tab to target one slot, or esc to stop.');
      else start(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    // Actions only make sense once there is something to act on, and only when
    // the composer is empty — otherwise every `a` typed into a prompt would
    // plug a branch into the main tree.
    if (!input && finished && !running) {
      if (char === 'a' || char === 'b') {
        void plug(char);
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
  const stats = { a: runner.statsFor('a'), b: runner.statsFor('b') };
  const scores: SlotScore[] = SLOT_IDS.map((slot) => scoreSlot({
    slot,
    label: infos[slot].label,
    model: infos[slot].model,
    stats: stats[slot],
    pricing,
    now,
  }));
  const wallClock = Math.max(...SLOT_IDS.map((slot) => elapsedFor(stats[slot], now)));
  const diffs: Partial<Record<SlotId, string>> = finished
    ? {
        a: `${finished.slots.a.files}f +${finished.slots.a.insertions} −${finished.slots.a.deletions}`,
        b: `${finished.slots.b.files}f +${finished.slots.b.insertions} −${finished.slots.b.deletions}`,
      }
    : {};

  const started = running || finished !== null;
  // This pane is short by design — the agents get the height. Everything below
  // the scoreboard shares what is left, newest last.
  const chrome = 1 /* header */ + (started ? 3 : 0) + 4 /* composer */;
  const noteRows = Math.max(1, rows - chrome);
  const visible = notes.slice(-noteRows);

  const summary = useMemo(
    () => running
      ? runningSlot ? `slot ${runningSlot.toUpperCase()} working` : 'both slots working'
      : finished ? 'branches ready' : 'ready',
    [finished, running, runningSlot],
  );

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet · vs</Text>
          {target && (
            <Text color={AGENT_COLOR[sides[target].cli]} bold>
              {' '}→ {target.toUpperCase()}
            </Text>
          )}
        </Box>
        {/* The spacer collapses to nothing in a narrow pane — doet's own pane
            is deliberately the small one — so the separator has to be a real
            character rather than a gap, or the title runs straight into the
            status ("doet · vsready"). */}
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
        <Box paddingX={1} height={3} overflow="hidden">
          <Scoreboard
            scores={scores}
            agents={{ a: sides.a.cli, b: sides.b.cli }}
            elapsedMs={wallClock}
            finished={!running}
            width={cols - 2}
            spinnerFrame={spinner}
            diffs={diffs}
          />
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
        active={running ? sides[runningSlot ?? 'a'].cli : null}
        width={cols}
        hint={
          target
            ? `enter sends to slot ${target.toUpperCase()} alone · tab cycles · esc clears the target`
            : running
              ? 'tab to target one slot · esc stops both · agents are in their own panes'
              : finished
                ? 'type for another round · tab targets one slot · a/b plugs into main' +
                  (mergeConflict ? ' · x aborts the merge' : '')
                : 'type one request · enter sends it to both slots'
        }
      />
    </Box>
  );
}
