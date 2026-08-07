import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import {
  abortMerge,
  addWorktree,
  commitAll,
  deleteBranch,
  inspectRepo,
  mergeBranch,
  removeWorktree,
} from '../core/git.js';
import { DOET_HOME } from '../core/paths.js';
import type { SessionStore } from '../core/sessions.js';
import {
  detectEditor,
  detectLauncher,
  openInEditor,
  shellCommand,
  shellQuote,
  workspaceFile,
} from '../core/terminal.js';
import {
  SLOT_IDS,
  type AgentAdapter,
  type AgentInfo,
  type PermissionRequest,
  type SlotId,
  type VsResult,
} from '../core/types.js';
import type { VsRunner, VsSide } from '../core/vs.js';
import { AgentPane, type PaneLine } from './AgentPane.js';
import { Composer } from './Composer.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { Picker, type PickerItem } from './Picker.js';
import { SPINNER } from './theme.js';

interface Props {
  buses: Record<SlotId, Bus>;
  sides: Record<SlotId, VsSide>;
  runner: VsRunner;
  store: SessionStore;
  root: string;
}

interface SlotPermission {
  slot: SlotId;
  request: PermissionRequest;
}

interface PickSpec {
  title: string;
  items: PickerItem[];
  onPick: (id: string) => void;
}

const MAX_PANE_LINES = 4000;

/** Never render a frame this short, whatever the overlays want. */
const MIN_PANE_ROWS = 3;
/** Header row plus the composer's three rows and its hint line. */
const CHROME_ROWS = 5;

/**
 * How long the UI will wait on an agent CLI before taking its keyboard back.
 *
 * Interrupting a turn, releasing a session and disposing an adapter all cross
 * a process boundary, and any of them can wedge. When one does, every key that
 * waits on it — quit included — silently does nothing, and a single stuck
 * promise reads as "the whole UI is frozen". So every such await is raced
 * against a deadline: the operation may still be hung, but the screen and the
 * keyboard are not.
 */
const AGENT_DEADLINE_MS = 6_000;

/**
 * Where the editor workspace files go: outside the repository, so opening a
 * worktree in an editor never adds a file to the branch under review.
 */
const WORKSPACES_DIR = join(DOET_HOME, 'workspaces');

/**
 * Resolves true when the file appears, false when the caller gives up first.
 *
 * Polling rather than `fs.watch`: the file is created in a temp directory by a
 * shell in another window, and watching a directory for a file that does not
 * exist yet is the one thing `fs.watch` is unreliable at across platforms.
 */
function waitForFile(path: string, cancelled: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        rmSync(path, { force: true });
        resolve(true);
      } else if (cancelled()) {
        clearInterval(timer);
        resolve(false);
      }
    }, 400);
    timer.unref?.();
  });
}

async function withDeadline<T>(work: Promise<T>, ms = AGENT_DEADLINE_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function VsApp({ buses, sides, runner, store, root }: Props) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns ?? 100);
  const [rows, setRows] = useState(stdout.rows ?? 30);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [panes, setPanes] = useState<Record<SlotId, PaneLine[]>>({ a: [], b: [] });
  const [infos, setInfos] = useState<Record<SlotId, AgentInfo>>({
    a: sides.a.adapter.info(),
    b: sides.b.adapter.info(),
  });
  const [focus, setFocus] = useState<SlotId | null>(null);
  const [running, setRunning] = useState(false);
  const [runningSlot, setRunningSlot] = useState<SlotId | null>(null);
  const [finished, setFinished] = useState<VsResult | null>(null);
  const [notice, setNotice] = useState('Both sessions receive the next prompt.');
  const [permissions, setPermissions] = useState<SlotPermission[]>([]);
  const [pick, setPick] = useState<PickSpec | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [spinner, setSpinner] = useState(0);
  const [handover, setHandover] = useState<SlotId | null>(null);
  const [mergeConflict, setMergeConflict] = useState(false);
  const [continuedSlot, setContinuedSlot] = useState<SlotId | null>(null);
  const [plugged, setPlugged] = useState<Record<SlotId, boolean>>({ a: false, b: false });
  const [discarded, setDiscarded] = useState<Record<SlotId, boolean>>({ a: false, b: false });
  const [scroll, setScroll] = useState<Record<SlotId, number>>({ a: 0, b: 0 });
  /** Slots whose session is currently open in a window of its own. */
  const [outside, setOutside] = useState<Record<SlotId, boolean>>({ a: false, b: false });
  const metrics = useRef<Record<SlotId, { rows: number; viewport: number }>>({
    a: { rows: 0, viewport: 1 },
    b: { rows: 0, viewport: 1 },
  });
  const lineId = useRef(0);
  const takingOver = useRef(false);
  /** Set by the first ctrl+c, so the second one can stop waiting and leave. */
  const quitting = useRef(false);
  /** Set by `esc` while a handover is waiting on a turn to finish. */
  const cancelHandover = useRef(false);
  /** Keeps forked branch and worktree names unique per slot. */
  const forkCount = useRef<Record<SlotId, number>>({ a: 0, b: 0 });
  /** Set to take a slot back by hand when its window never reported closing. */
  const reclaim = useRef<Record<SlotId, boolean>>({ a: false, b: false });

  const refreshInfo = useCallback((slot: SlotId) => {
    setInfos((previous) => ({ ...previous, [slot]: sides[slot].adapter.info() }));
  }, [sides]);

  const push = useCallback((slot: SlotId, line: Omit<PaneLine, 'id'>) => {
    setPanes((previous) => ({
      ...previous,
      [slot]: [...previous[slot], { id: lineId.current++, ...line }].slice(-MAX_PANE_LINES),
    }));
  }, []);

  const append = useCallback((slot: SlotId, kind: 'text' | 'thinking' | 'output', delta: string) => {
    setPanes((previous) => {
      const lines = [...previous[slot]];
      const parts = delta.split('\n');
      const last = lines[lines.length - 1];
      if (last?.kind === kind) lines[lines.length - 1] = { ...last, text: last.text + parts[0] };
      else if (parts[0]) lines.push({ id: lineId.current++, kind, text: parts[0] });
      for (const part of parts.slice(1)) {
        lines.push({ id: lineId.current++, kind, text: part });
      }
      return { ...previous, [slot]: lines.slice(-MAX_PANE_LINES) };
    });
  }, []);

  useEffect(() => {
    const onResize = () => {
      /*
       * Wipe the screen before re-rendering at the new size.
       *
       * Ink erases the previous frame by counting rows, and a resize makes that
       * count a lie: the terminal has already reflowed those rows to a new
       * width, so the erase removes the wrong ones and the leftovers stay on
       * screen — which is why a stretched window ends up showing one frame
       * threaded through another ("isolated branchesbranches ready"). Once that
       * has happened the corruption is permanent, because every later frame is
       * erased against the same wrong count. Clearing the screen *and* the
       * scrollback costs one flicker and makes the next frame the only thing
       * there is.
       */
      stdout.write('\u001B[2J\u001B[3J\u001B[H');
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 30);
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
    const unsubscribers = SLOT_IDS.map((slot) => buses[slot].on((event) => {
      switch (event.kind) {
        case 'status':
        case 'usage':
        case 'session':
        case 'turn-end':
          refreshInfo(slot);
          break;
        case 'prompt':
          push(slot, { kind: 'prompt-head', text: `── ${event.label} ──` });
          for (const text of event.text.split('\n')) push(slot, { kind: 'prompt', text });
          break;
        case 'text':
          append(slot, 'text', event.delta);
          break;
        case 'thinking':
          append(slot, 'thinking', event.delta);
          break;
        case 'output':
          append(slot, 'output', event.chunk);
          break;
        case 'tool':
          push(slot, {
            kind: 'tool',
            text: event.phase === 'start'
              ? `${event.name}${event.summary ? ` · ${event.summary}` : ''}`
              : event.result || `${event.name || 'tool'} finished`,
            ok: event.ok,
          });
          break;
        case 'permission':
          setPermissions((items) => [...items, { slot, request: event.request }]);
          break;
        case 'permission-resolved':
          setPermissions((items) => items.filter((item) => item.request.id !== event.id));
          break;
        case 'error':
          push(slot, { kind: 'error', text: event.message });
          break;
        case 'log':
          push(slot, { kind: event.level === 'error' ? 'error' : 'note', text: event.message });
          break;
        default:
          break;
      }
    }));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [append, buses, push, refreshInfo]);

  useEffect(() => {
    store.writeVsMeta({
      cwd: root,
      query,
      base: sides.a.worktree.base,
      slots: {
        a: {
          cli: sides.a.cli,
          sessionId: infos.a.sessionId,
          model: infos.a.model,
          effort: infos.a.effort,
          branch: sides.a.worktree.branch,
          worktree: sides.a.worktree.path,
        },
        b: {
          cli: sides.b.cli,
          sessionId: infos.b.sessionId,
          model: infos.b.model,
          effort: infos.b.effort,
          branch: sides.b.worktree.branch,
          worktree: sides.b.worktree.path,
        },
      },
    });
  }, [infos, query, root, sides, store]);

  /**
   * Says where each slot is working, in the pane, before anything runs.
   *
   * Two agents editing files you cannot find is worse than no isolation at all:
   * the branch and the path are the only handles you have on their work, so
   * they are the first thing each pane says.
   */
  useEffect(() => {
    for (const slot of SLOT_IDS) {
      push(slot, { kind: 'note', text: `── ${sides[slot].worktree.branch} ──` });
      push(slot, { kind: 'note', text: sides[slot].worktree.path });
    }
  }, [push, sides]);

  /**
   * Hands one slot's live session to you, in its own CLI.
   *
   * A turn in flight is *waited on*, not cut short. Entering the session is how
   * you take the work further, and a turn interrupted halfway leaves the thing
   * you were entering half-done — the agent stops mid-edit, its branch holds
   * whatever it had written by then, and continuing means first working out
   * what it was in the middle of. Interrupting is still available, from the
   * actions menu, for when the agent is off down the wrong path and stopping it
   * is the point.
   */
  /**
   * Opens a slot's live session in a window of its own.
   *
   * This is the better default here, and for a reason particular to VS: the
   * other slot is usually still working. Suspending doet to give this terminal
   * to one agent blanks the screen the other one is streaming to, and hides its
   * permission prompts — so the agent you did not touch quietly blocks on a
   * question nobody can see. In a separate window, doet stays up and keeps
   * answering for the other side.
   *
   * It is still a handover and not a fork: doet lets go of the session, so it
   * has to learn when you are done with it. No launcher reports a window
   * closing, so the command it runs ends by touching a file doet watches for.
   */
  const handOffToWindow = useCallback(async (slot: SlotId): Promise<boolean> => {
    const adapter = sides[slot].adapter;
    const command = adapter.interactiveCommand();
    const editor = detectEditor();
    const launcher = detectLauncher();
    if (!command || (!editor && !launcher)) return false;

    const sessionId = await withDeadline(adapter.releaseSession());
    if (!sessionId) {
      setNotice(
        `${adapter.info().label} did not release its session in time — nothing was handed over.`,
      );
      return true;
    }

    const cwd = adapter.info().cwd;
    const sentinel = join(tmpdir(), `doet-${slot}-${sessionId.slice(0, 8)}-${Date.now()}.done`);
    // `;` rather than `&&`: doet must be told the window is finished even when
    // the CLI exits non-zero, or the session stays out for good. The path is
    // quoted because a temp directory with a space in it makes `>` ambiguous,
    // and the sentinel then never appears at all.
    const script = `${shellCommand(command.command, command.args, cwd)}; : > ${shellQuote(sentinel)}`;

    // The editor wins when there is one. A worktree is a checkout, and what you
    // want opened on a checkout is the editor — with the session running in its
    // terminal, so the code and the agent that wrote it are in one window.
    const where = editor?.label ?? launcher!.label;
    try {
      if (editor) {
        const workspace = join(WORKSPACES_DIR, `${store.id}-${slot}.code-workspace`);
        mkdirSync(dirname(workspace), { recursive: true });
        writeFileSync(
          workspace,
          workspaceFile(cwd, { label: `doet · slot ${slot.toUpperCase()} live session`, command: script }),
          'utf8',
        );
        await openInEditor(editor, workspace);
      } else {
        await launcher!.launch('/bin/sh', ['-c', script], cwd);
      }
    } catch (error) {
      // The session is already released, so put it back before reporting.
      await withDeadline(adapter.resumeSession(sessionId).then(() => true));
      setNotice(`Could not open a window: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }

    setOutside((current) => ({ ...current, [slot]: true }));
    push(slot, { kind: 'note', text: `── this session is open in ${where} ──` });
    setNotice(
      editor
        ? `Slot ${slot.toUpperCase()} is open in ${where} on its worktree. Say yes to "Allow automatic tasks" and its session starts in that window's terminal; doet takes it back when you close it.`
        : `Slot ${slot.toUpperCase()} is yours in ${where}. doet takes it back when you close that window; the other slot carries on here.`,
    );

    // Watched rather than awaited inline: the whole point is that doet stays
    // usable while one slot is out.
    void (async () => {
      const returned = await waitForFile(sentinel, () => reclaim.current[slot]);
      const resumed = await withDeadline(adapter.resumeSession(sessionId).then(() => true));
      reclaim.current[slot] = false;
      setOutside((current) => ({ ...current, [slot]: false }));
      refreshInfo(slot);
      push(slot, {
        kind: resumed ? 'note' : 'error',
        text: resumed
          ? '── back in doet, with everything you did ──'
          : `── could not re-attach to ${sessionId.slice(0, 8)} ──`,
      });
      setNotice(
        resumed
          ? `Slot ${slot.toUpperCase()} is back${returned ? '' : ' (reclaimed)'}, and kept what you did.`
          : `Slot ${slot.toUpperCase()} did not re-attach. Reopen it with its own CLI.`,
      );
    })();

    return true;
  }, [push, refreshInfo, sides, store.id]);

  const takeOver = useCallback(async (
    slot: SlotId,
    opts: { interrupt?: boolean; here?: boolean } = {},
  ) => {
    if (takingOver.current) {
      // Returning in silence is why a wedged handover reads as a dead keyboard:
      // every further press does nothing and says nothing about why.
      setNotice('Still handing a session over — press ctrl+c twice to force-quit doet.');
      return;
    }
    if (outside[slot]) {
      setNotice(
        `Slot ${slot.toUpperCase()} is already open in another window. Close it, or press a → Re-attach now.`,
      );
      return;
    }
    if (discarded[slot]) {
      setNotice(`Slot ${slot.toUpperCase()} was discarded; its saved Markdown remains in ${store.dir}.`);
      return;
    }
    const adapter = sides[slot].adapter;
    const command = adapter.interactiveCommand();
    if (!command) {
      setNotice(`Slot ${slot.toUpperCase()} has no live session yet.`);
      return;
    }

    takingOver.current = true;
    cancelHandover.current = false;
    setHandover(slot);
    let sessionId: string | null = null;
    let failure = '';
    let cancelled = false;
    let toWindow = false;
    try {
      if (running) {
        if (opts.interrupt) {
          setNotice(`Interrupting slot ${slot.toUpperCase()} before handing it over…`);
          await withDeadline(runner.abort(slot));
          await withDeadline(runner.whenSlotIdle(slot));
        } else {
          // No deadline on this one: the wait is the feature, and how long a
          // turn takes is the agent's business. `esc` is the way out, and the
          // rest of the UI keeps running while this sits here.
          setNotice(
            `Slot ${slot.toUpperCase()} is mid-turn — handing over the moment it finishes · esc cancels · a → interrupt now`,
          );
          await runner.whenSlotIdle(slot);
        }
      }

      if (cancelHandover.current) {
        cancelled = true;
        setNotice(`Handover cancelled. Slot ${slot.toUpperCase()} carries on in doet.`);
        return;
      }

      // A window first, and this terminal only when nothing here can open one —
      // an editor's integrated terminal with no tmux, typically. Taking this
      // terminal blinds the other slot, so it is the fallback, not the plan.
      if (!opts.here && await handOffToWindow(slot)) {
        toWindow = true;
        return;
      }

      // A deadline here does not mean "carry on anyway": if doet has not let go
      // of the session, handing the same id to an interactive CLI would put two
      // writers on it. Timing out aborts the handover instead.
      sessionId = await withDeadline(adapter.releaseSession());
      if (!sessionId) {
        throw new Error(
          `${adapter.info().label} did not release its session in time. It is still doet's — nothing was handed over.`,
        );
      }
      await suspendTerminal(async () => {
        process.stdout.write(`\nEntering slot ${slot.toUpperCase()} (${adapter.info().label}). Exit its CLI to return to doet.\n\n`);
        await new Promise<void>((resolve) => {
          const child = spawn(command.command, command.args, {
            cwd: adapter.info().cwd,
            stdio: 'inherit',
          });
          child.on('error', (error) => {
            failure = error.message;
            resolve();
          });
          child.on('close', () => resolve());
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (sessionId) {
        // Also on a deadline: a re-attach that never settles would leave the
        // spinner spinning and `takingOver` latched, which is the same trap.
        const resumed = await withDeadline(
          adapter.resumeSession(sessionId).then(() => true),
        );
        if (!resumed) {
          failure ||= `${adapter.info().label} did not re-attach to ${sessionId.slice(0, 8)}. Reopen it with its own CLI.`;
        }
      }
      takingOver.current = false;
      setHandover(null);
      refreshInfo(slot);
    }
    // A cancelled handover never left doet, and one that went to a window
    // reports for itself when the window closes.
    if (cancelled || toWindow) return;
    push(slot, {
      kind: failure ? 'error' : 'note',
      text: failure ? `handover ended: ${failure}` : '── live session returned to doet ──',
    });
    setNotice(failure || `Back from slot ${slot.toUpperCase()}; its session history is intact.`);
  }, [discarded, push, refreshInfo, runner, running, sides, store.dir, suspendTerminal]);

  const plug = useCallback(async (slot: SlotId) => {
    const side = sides[slot];
    try {
      if (running) {
        setNotice('Wait for the active turn to finish before plugging another result in.');
        return;
      }
      if (discarded[slot]) throw new Error(`Slot ${slot.toUpperCase()} was discarded.`);
      if (plugged[slot]) {
        setContinuedSlot(slot);
        setFocus(null);
        setNotice(`Composer now continues slot ${slot.toUpperCase()} in the main tree.`);
        return;
      }
      const state = await inspectRepo(root);
      if (!state) throw new Error('The main working tree is no longer a git repository.');
      if (!state.clean) {
        setNotice('The main tree has uncommitted changes. Commit or stash them before plugging another result in.');
        return;
      }

      // A test terminal may have left edits in the side tree. Record them on
      // the branch before taking its complete state into the main checkout.
      await commitAll(side.worktree.path, `doet vs: slot ${slot} follow-up`);
      const outcome = await mergeBranch(root, side.worktree.branch, { squash: true });
      if (!outcome.ok) {
        setMergeConflict(outcome.conflicts.length > 0);
        setNotice(outcome.conflicts.length > 0
          ? `Merge conflicts: ${outcome.conflicts.join(', ')}. Press a for abort.`
          : outcome.message);
        return;
      }

      const commit = await commitAll(root, `doet vs: plug slot ${slot} (${side.cli})`);
      await side.adapter.setCwd(root);
      refreshInfo(slot);
      setMergeConflict(false);
      setPlugged((current) => ({ ...current, [slot]: true }));
      setContinuedSlot(slot);
      setFocus(null);
      store.appendNote(
        `Plugged slot ${slot.toUpperCase()} into the main tree${commit.changed ? ` as ${commit.sha.slice(0, 12)}` : ''}.`,
      );
      setNotice(`Slot ${slot.toUpperCase()} is committed in the main tree. The composer now continues that live session.`);
      push(slot, { kind: 'note', text: '── plugged and committed in main · composer continues here ──' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [discarded, plugged, push, refreshInfo, root, running, sides, store]);

  const openWorktree = useCallback(async (slot: SlotId) => {
    if (discarded[slot]) {
      setNotice(`Slot ${slot.toUpperCase()}'s worktree was discarded.`);
      return;
    }
    const launcher = detectLauncher();
    if (!launcher) {
      setNotice(`Open a terminal at ${sides[slot].worktree.path}`);
      return;
    }
    const shell = process.env.SHELL || '/bin/sh';
    await launcher.launch(shell, ['-l'], sides[slot].worktree.path).then(
      () => setNotice(`Opened slot ${slot.toUpperCase()}'s worktree in ${launcher.label}.`),
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );
  }, [discarded, sides]);

  const discardSlot = useCallback(async (slot: SlotId) => {
    if (running) {
      setNotice('Stop the active turn before discarding a slot.');
      return;
    }
    try {
      await sides[slot].adapter.dispose();
      const removed = await removeWorktree(root, sides[slot].worktree.path, true);
      if (!removed.ok) throw new Error(removed.stderr || removed.stdout || 'Could not remove worktree.');
      const deleted = await deleteBranch(root, sides[slot].worktree.branch, true);
      if (!deleted.ok) throw new Error(deleted.stderr || deleted.stdout || 'Could not delete branch.');
      setDiscarded((current) => ({ ...current, [slot]: true }));
      setPlugged((current) => ({ ...current, [slot]: false }));
      setContinuedSlot((current) => current === slot ? null : current);
      setFocus((current) => current === slot ? null : current);
      store.appendNote(`Discarded slot ${slot.toUpperCase()} branch and worktree; its Markdown history was kept.`);
      setNotice(`Discarded slot ${slot.toUpperCase()}'s branch and worktree. Its Markdown history was kept.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [root, running, sides, store]);

  const confirmDiscard = useCallback((slot: SlotId) => {
    setPick({
      title: `Discard slot ${slot.toUpperCase()}?`,
      items: [
        {
          id: 'discard',
          label: 'Delete branch and worktree',
          description: 'Closes the live adapter; saved Markdown history is retained.',
        },
        { id: 'cancel', label: 'Keep artifacts', description: 'Leave the branch, worktree, and live session intact.' },
      ],
      onPick: (choice) => {
        setPick(null);
        if (choice === 'discard') void discardSlot(slot);
      },
    });
    setPickIndex(1);
  }, [discardSlot]);

  /**
   * Branches a slot's session into a checkout of its own.
   *
   * The co-code fork opens a copy of the conversation and leaves the original
   * running. Here that is only half of it: a forked *session* pointed at the
   * slot's own worktree would be a second writer in one directory, undoing the
   * isolation the whole mode is built on. So the fork gets its own worktree and
   * its own branch, cut from where the slot has got to — commits included,
   * which is why the slot is committed first.
   */
  const forkOut = useCallback(async (slot: SlotId) => {
    const side = sides[slot];
    try {
      setNotice(`Branching slot ${slot.toUpperCase()}…`);
      // Otherwise the fork starts from the slot's last commit and silently
      // loses everything it has written since.
      await commitAll(side.worktree.path, `doet vs: slot ${slot} before fork`);

      const argv = await side.adapter.forkSession();
      if (!argv) {
        setNotice(`Slot ${slot.toUpperCase()} has no session to branch yet.`);
        return;
      }

      const seq = (forkCount.current[slot] += 1);
      const branch = `${side.worktree.branch}-fork${seq}`;
      const path = join(dirname(side.worktree.path), `${slot}-fork${seq}`);
      mkdirSync(dirname(path), { recursive: true });
      await addWorktree(root, path, branch, side.worktree.branch);

      const launcher = detectLauncher();
      if (!launcher) {
        push(slot, { kind: 'note', text: `── fork ready · ${branch} ──` });
        push(slot, { kind: 'note', text: shellCommand(argv.command, argv.args, path) });
        setNotice('No terminal doet can open here — the fork command is in the pane.');
        return;
      }

      await launcher.launch(argv.command, argv.args, path);
      push(slot, { kind: 'note', text: `── forked into ${branch} ──` });
      push(slot, { kind: 'note', text: path });
      setNotice(`Slot ${slot.toUpperCase()} forked into ${launcher.label}; this session carries on.`);
    } catch (error) {
      setNotice(
        `Could not fork slot ${slot.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [push, root, sides]);

  const openActions = useCallback((slot: SlotId) => {
    if (discarded[slot]) {
      setNotice(`Slot ${slot.toUpperCase()} was discarded; only its saved Markdown remains.`);
      return;
    }
    if (outside[slot]) {
      setPick({
        title: `Slot ${slot.toUpperCase()} is open in another window`,
        items: [
          {
            id: 'reclaim',
            label: 'Re-attach now',
            description:
              'Only once you have closed that window. Two processes on one session corrupt it.',
          },
          { id: 'cancel', label: 'Leave it open', description: 'It comes back on its own when you close it.' },
        ],
        onPick: (choice) => {
          setPick(null);
          if (choice === 'reclaim') {
            reclaim.current[slot] = true;
            setNotice(`Taking slot ${slot.toUpperCase()} back…`);
          }
        },
      });
      setPickIndex(1);
      return;
    }

    const items: PickerItem[] = [
      {
        id: 'enter',
        label: running ? 'Enter live session when this turn finishes' : 'Enter live session',
        description: `${
          detectEditor()
            ? `Opens this slot's worktree in ${detectEditor()!.label}, with its live session running in that window's terminal.`
            : 'Opens the live session in a terminal window of its own.'
        }${running ? ' Waits for the turn to finish first — nothing is cut short.' : ''} doet stays here for the other slot and takes this one back when you close the window.`,
      },
      {
        id: 'enter-here',
        label: 'Enter in this terminal instead',
        description:
          'doet steps aside and gives you this terminal. The other slot keeps working but you will not see it, prompts included.',
      },
      {
        id: 'fork',
        label: 'Fork into a new worktree',
        description:
          'Branches the session and gives the branch its own checkout, so you can test it without touching what this slot is doing. Nothing here stops.',
      },
    ];
    if (running) {
      items.push({
        id: 'interrupt',
        label: 'Interrupt, then enter',
        description: 'Stops the turn where it is. Use it when the agent is going the wrong way.',
      });
    }
    if (finished) {
      items.push(
        { id: 'test', label: 'Open worktree terminal', description: sides[slot].worktree.path },
        plugged[slot]
          ? { id: 'continue', label: 'Continue in composer', description: 'Route follow-up prompts to this live session in the main tree.' }
          : { id: 'plug', label: 'Plug into main', description: 'Squash and commit in main, then continue this same live session there.' },
        { id: 'discard', label: 'Discard artifacts', description: 'Confirm deletion of this branch and worktree; keep Markdown history.' },
      );
    }
    if (mergeConflict) items.push({ id: 'abort', label: 'Abort conflicted merge', description: 'Restore the clean main tree from before plug-in.' });
    setPick({
      title: `Slot ${slot.toUpperCase()} actions`,
      items,
      onPick: (choice) => {
        setPick(null);
        if (choice === 'enter') void takeOver(slot);
        else if (choice === 'enter-here') void takeOver(slot, { here: true });
        else if (choice === 'interrupt') void takeOver(slot, { interrupt: true });
        else if (choice === 'fork') void forkOut(slot);
        else if (choice === 'test') void openWorktree(slot);
        else if (choice === 'plug') void plug(slot);
        else if (choice === 'continue') {
          setContinuedSlot(slot);
          setFocus(null);
          setNotice(`Composer now continues slot ${slot.toUpperCase()} in the main tree.`);
        } else if (choice === 'discard') confirmDiscard(slot);
        else if (choice === 'abort') void abortMerge(root).then((outcome) => {
          setMergeConflict(false);
          setNotice(outcome.ok ? 'Merge aborted; main tree restored.' : outcome.stderr);
        });
      },
    });
    setPickIndex(0);
  }, [confirmDiscard, discarded, finished, forkOut, mergeConflict, openWorktree, outside, plug, plugged, root, running, sides, takeOver]);

  const start = useCallback((query: string) => {
    setQuery(query);
    setRunning(true);
    setRunningSlot(null);
    setNotice('Both slots are working independently…');
    void runner.run(query).then((result) => {
      setFinished(result);
      setRunning(false);
      setRunningSlot(null);
      for (const slot of SLOT_IDS) {
        const side = result.slots[slot];
        push(slot, {
          kind: side.error ? 'error' : 'note',
          text: side.error
            ? `── finished with error: ${side.error} ──`
            : `── branch ready · ${side.files} files · +${side.insertions} −${side.deletions} ──`,
        });
        refreshInfo(slot);
      }
      setNotice(`Results saved in ${store.dir}. Select a slot: enter opens its live session; a shows all actions.`);
    }).catch((error: unknown) => {
      setRunning(false);
      setRunningSlot(null);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [push, refreshInfo, runner, store.dir]);

  const continueRun = useCallback((slot: SlotId, prompt: string) => {
    setRunning(true);
    setRunningSlot(slot);
    setNotice(`Slot ${slot.toUpperCase()} is continuing in the main tree…`);
    void runner.continue(slot, prompt).then((turn) => {
      setRunning(false);
      setRunningSlot(null);
      refreshInfo(slot);
      push(slot, {
        kind: turn.error ? 'error' : 'note',
        text: turn.error
          ? `── follow-up ended with error: ${turn.error} ──`
          : '── follow-up complete in main tree ──',
      });
      setNotice(turn.error || `Slot ${slot.toUpperCase()} finished. Send another follow-up or select a pane.`);
    }).catch((error: unknown) => {
      setRunning(false);
      setRunningSlot(null);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [push, refreshInfo, runner]);

  const scrollBy = useCallback((slot: SlotId, delta: number) => {
    const { rows: total, viewport } = metrics.current[slot];
    const max = Math.max(0, total - viewport);
    setScroll((current) => ({
      ...current,
      [slot]: Math.max(0, Math.min(max, current[slot] + delta)),
    }));
  }, []);

  /**
   * Quitting must work from any state, including one where an agent CLI has
   * stopped answering. A tidy shutdown is attempted once, on a deadline; a
   * second ctrl+c gives up on tidiness and leaves. Everything doet writes — the
   * Markdown, the branches, the worktrees — is already on disk by then, so the
   * only thing a hard exit costs is the adapters' own goodbye.
   */
  const shutdown = useCallback(async () => {
    if (quitting.current) {
      process.stdout.write('\u001B[?25h\ndoet: forced quit. Branches and worktrees are intact.\n');
      process.exit(0);
    }
    quitting.current = true;
    setNotice('Stopping both slots… press ctrl+c again to force-quit.');

    if (runner.isRunning) {
      await withDeadline(runner.abort());
      await withDeadline(Promise.all(SLOT_IDS.map((slot) => runner.whenSlotIdle(slot))));
    }
    store.detach();
    await withDeadline(
      Promise.all(SLOT_IDS.map((slot) => sides[slot].adapter.dispose().catch(() => {}))),
    );
    exit();
  }, [exit, runner, sides, store]);

  const currentPermission = permissions[0];
  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      void shutdown();
      return;
    }
    if (currentPermission) {
      const option = currentPermission.request.options.find((candidate) => candidate.key === char);
      if (option) {
        sides[currentPermission.slot].adapter.resolvePermission(currentPermission.request.id, option.id);
        buses[currentPermission.slot].emit({
          kind: 'permission-resolved',
          agent: sides[currentPermission.slot].cli,
          id: currentPermission.request.id,
          optionId: option.id,
          label: option.label,
        });
      } else if (key.escape) {
        const deny = currentPermission.request.options.find((candidate) => candidate.tone === 'deny');
        if (deny) {
          sides[currentPermission.slot].adapter.resolvePermission(currentPermission.request.id, deny.id);
          buses[currentPermission.slot].emit({
            kind: 'permission-resolved',
            agent: sides[currentPermission.slot].cli,
            id: currentPermission.request.id,
            optionId: deny.id,
            label: deny.label,
          });
        }
      }
      return;
    }
    if (pick) {
      if (key.upArrow) setPickIndex((index) => (index - 1 + pick.items.length) % pick.items.length);
      else if (key.downArrow) setPickIndex((index) => (index + 1) % pick.items.length);
      else if (key.return) pick.items[pickIndex] && pick.onPick(pick.items[pickIndex]!.id);
      else if (key.escape) setPick(null);
      return;
    }
    if (key.leftArrow) {
      setFocus('a');
      return;
    }
    if (key.rightArrow) {
      setFocus('b');
      return;
    }
    if (focus && key.pageUp) {
      scrollBy(focus, metrics.current[focus].viewport - 1);
      return;
    }
    if (focus && key.pageDown) {
      scrollBy(focus, -(metrics.current[focus].viewport - 1));
      return;
    }
    if (focus && key.upArrow) {
      scrollBy(focus, 1);
      return;
    }
    if (focus && key.downArrow) {
      scrollBy(focus, -1);
      return;
    }
    if (key.escape) {
      // A handover waiting on a turn is the thing esc should call off first —
      // it is the only state where doet is waiting on your behalf.
      if (handover && !cancelHandover.current) {
        cancelHandover.current = true;
        setNotice('Cancelling the handover once this turn finishes…');
        return;
      }
      if (focus) setFocus(null);
      else if (running) void runner.abort();
      return;
    }
    if (key.ctrl && char === 'x') {
      void runner.abort();
      return;
    }
    if (char === 'a' && focus) {
      openActions(focus);
      return;
    }
    if ((key.return || (key.ctrl && char === 'o')) && focus) {
      void takeOver(focus);
      return;
    }
    if (key.return) {
      const query = input.trim();
      if (!query || running) return;
      if (finished) {
        if (mergeConflict) {
          setNotice('Resolve the current merge conflicts, or select a pane, press a, and choose Abort conflicted merge.');
          return;
        }
        setInput('');
        // Plugging one side into main is one way a VS pair carries on, not the
        // only way. Before that happens both slots are still live sessions on
        // their own branches, and the obvious thing to do with a result you are
        // not happy with — say so and let them both go again — used to be
        // refused with a notice about plugging in, which read as a dead prompt.
        if (continuedSlot) continueRun(continuedSlot, query);
        else start(query);
        return;
      }
      setInput('');
      start(query);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta && !focus) setInput((value) => value + char);
  });

  const widthA = Math.floor(cols / 2);

  /*
   * The frame must never be taller than the window.
   *
   * Ink can only redraw in place while the output fits: once a frame is taller
   * than the terminal it is appended instead, and since the spinner re-renders
   * eleven times a second the screen turns into a scrolling wall of half-frames
   * with no way to read or click anything. The old `Math.max(8, rows - 7 - …)`
   * guaranteed exactly that — an 18-row permission prompt in a 24-row window
   * asked for 31 rows of frame — because the floor was applied last and could
   * out-vote the window.
   *
   * So the window is the budget: overlays get what is left after a minimum
   * pane, and the panes get what is left after the overlays.
   */
  const wanted = {
    pick: pick ? Math.min(12, 5 + pick.items.length * 2) : 0,
    permission: currentPermission
      ? Math.min(18, 8 + (currentPermission.request.detail?.split('\n').length ?? 0))
      : 0,
  };
  const overlayBudget = Math.max(0, rows - CHROME_ROWS - MIN_PANE_ROWS);
  const permissionHeight = Math.min(wanted.permission, overlayBudget);
  const pickHeight = Math.min(wanted.pick, overlayBudget - permissionHeight);
  const paneHeight = Math.max(
    MIN_PANE_ROWS,
    rows - CHROME_ROWS - permissionHeight - pickHeight,
  );
  const active = (slot: SlotId) => ['thinking', 'working', 'awaiting-permission'].includes(infos[slot].status);
  const phase = running ? 'exchanging' : finished ? 'done' : 'idle';
  const summary = useMemo(
    () => running
      ? runningSlot ? `continuing ${runningSlot.toUpperCase()}` : 'running both slots'
      : finished ? 'branches ready' : 'ready',
    [finished, running, runningSlot],
  );

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* One row, and it has to stay one row: a notice long enough to wrap
          makes the header two rows tall, which pushes the frame past the
          window and starts the append-forever scroll this layout exists to
          prevent. Shrink and truncate rather than wrap. */}
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet · vs</Text>
          <Text dimColor> · same prompt, isolated branches</Text>
        </Box>
        <Box flexGrow={1} />
        {handover && (
          <Box flexShrink={0}>
            <Text color="cyan">{SPINNER[spinner % SPINNER.length]} handing over {handover.toUpperCase()} · </Text>
          </Box>
        )}
        <Box flexShrink={0}>
          <Text color={finished ? 'green' : running ? 'yellow' : 'white'}>{summary}</Text>
        </Box>
        {notice && (
          <Box flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate-end"> · {notice}</Text>
          </Box>
        )}
      </Box>
      <Box>
        {SLOT_IDS.map((slot) => (
          <AgentPane
            key={slot}
            agent={sides[slot].cli}
            info={{ ...infos[slot], label: `${slot.toUpperCase()} · ${infos[slot].label}` }}
            lines={panes[slot]}
            width={slot === 'a' ? widthA : cols - widthA}
            height={paneHeight}
            active={active(slot)}
            focused={focus === slot}
            scroll={scroll[slot]}
            spinnerFrame={spinner}
            onRows={(total, viewport) => {
              metrics.current[slot] = { rows: total, viewport };
            }}
          />
        ))}
      </Box>
      {/* Both overlays are clamped to the rows the budget above set aside for
          them. They render their natural height otherwise, and a tall one
          would overflow the window on its own. */}
      {pick && pickHeight > 0 && (
        <Box paddingX={1} height={pickHeight} overflow="hidden">
          <Picker title={pick.title} items={pick.items} index={pickIndex} width={cols - 2} />
        </Box>
      )}
      {currentPermission && (
        <Box paddingX={1} height={permissionHeight} overflow="hidden">
          <PermissionPrompt
            request={currentPermission.request}
            queued={permissions.length - 1}
            width={cols - 2}
          />
        </Box>
      )}
      <Composer
        value={input}
        choosingFirst={false}
        phase={phase}
        active={running ? sides[runningSlot ?? 'a'].cli : null}
        width={cols}
        hint={handover
          ? 'waiting for the turn to finish · esc cancels the handover'
          : focus
            ? running
              ? 'enter live session after this turn · a interrupt/fork · esc release'
              : 'enter live session · a fork/test/plug/discard · esc release'
            : running
              ? '←→ select a slot · ctrl+x stop both'
              : finished
                ? continuedSlot
                  ? `continuing ${continuedSlot.toUpperCase()} in main · type follow-up · ←→ select`
                  : 'type to send both slots another round · ←→ select · a actions'
                : 'type one request · enter sends it to both slots'}
      />
    </Box>
  );
}
