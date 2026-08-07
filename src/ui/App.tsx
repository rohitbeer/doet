import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Bus } from '../core/bus.js';
import type { Conductor } from '../core/conductor.js';
import type { SessionStore } from '../core/sessions.js';
import type { Summarizer } from '../core/summarizer.js';
import type { DoetConfig } from '../core/config.js';
import {
  describeSessionPolicy,
  parseSessionPolicy,
  saveConfig,
  type SummarySource,
} from '../core/config.js';
import { AGENT_LABELS } from '../core/relay.js';
import {
  availableLaunchers,
  copyToClipboard,
  inEditorTerminal,
  launcherById,
  shellCommand,
  type Launcher,
} from '../core/terminal.js';
import {
  AGENT_IDS,
  EFFORTS,
  type AgentAdapter,
  type AgentId,
  type AgentInfo,
  type DebatePhase,
  type Effort,
  type HandoffMode,
  type PermissionRequest,
} from '../core/types.js';
import { AgentPane, type PaneLine } from './AgentPane.js';
import { Composer } from './Composer.js';
import { GistPanel } from './GistPanel.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { Picker, type PickerItem } from './Picker.js';
import { RelayLog, type RelayEntry } from './RelayLog.js';
import { AGENT_COLOR, SPINNER } from './theme.js';

interface Props {
  bus: Bus;
  conductor: Conductor;
  agents: Record<AgentId, AgentAdapter>;
  store: SessionStore;
  summarizer: Summarizer;
  config: DoetConfig;
  /** False when `--summary` already answered it on the command line. */
  promptForSummary: boolean;
}

const HINT_IDLE = 'enter send · ←→ select a pane · ctrl+g gist · /help commands · ctrl+c quit';
const HINT_RUNNING = 'type to interject · ←→ select a pane · esc stop after turn · ctrl+x abort now';
const HINT_FOCUSED =
  'ctrl+o open this session · ↑↓ scroll · pgup/pgdn page · ctrl+e zoom · esc release';

/** A picker waiting on the user. `onPick` may open the next one in a chain. */
interface PickSpec {
  title: string;
  items: PickerItem[];
  hint?: string;
  onPick: (id: string) => void;
  onCancel?: () => void;
}

const MAX_PANE_LINES = 4000;

export function App({
  bus,
  conductor,
  agents,
  store,
  summarizer,
  config,
  promptForSummary,
}: Props) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns ?? 100);
  const [rows, setRows] = useState(stdout.rows ?? 30);

  const [input, setInput] = useState('');
  const [choosingFirst, setChoosingFirst] = useState(false);
  const pendingQuery = useRef<string>('');
  const [history, setHistory] = useState<string[]>([]);
  const histIndex = useRef<number>(-1);

  const [panes, setPanes] = useState<Record<AgentId, PaneLine[]>>({ claude: [], codex: [] });
  const [relay, setRelay] = useState<RelayEntry[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [pick, setPick] = useState<PickSpec | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [infos, setInfos] = useState<Record<AgentId, AgentInfo>>({
    claude: agents.claude.info(),
    codex: agents.codex.info(),
  });
  const [phase, setPhase] = useState<DebatePhase>('idle');
  const [round, setRound] = useState(0);
  const [active, setActive] = useState<AgentId | null>(null);
  const [spinner, setSpinner] = useState(0);
  const [notice, setNotice] = useState<string>('');
  const [gist, setGist] = useState<string>('');
  /** Non-null while a session is being handed over, so the UI can say so. */
  const [handover, setHandover] = useState<string | null>(null);
  const takingOver = useRef(false);

  // Pane navigation.
  const [focus, setFocus] = useState<AgentId | null>(null);
  const [zoom, setZoom] = useState(false);
  const [scroll, setScroll] = useState<Record<AgentId, number>>({ claude: 0, codex: 0 });
  const [band, setBand] = useState<'relay' | 'gist'>('relay');
  const [gistScroll, setGistScroll] = useState(0);
  /** Set once you pick a band yourself, so new notes stop stealing it. */
  const bandPinned = useRef(false);
  // Filled by the panes on render so paging knows the real row counts.
  const metrics = useRef<Record<AgentId, { rows: number; viewport: number }>>({
    claude: { rows: 0, viewport: 1 },
    codex: { rows: 0, viewport: 1 },
  });

  const lineId = useRef(0);
  const relayId = useRef(0);
  const roundRef = useRef(0);

  // ---------------------------------------------------------------------
  // Terminal size
  // ---------------------------------------------------------------------
  useEffect(() => {
    const onResize = () => {
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 30);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    const timer = setInterval(() => setSpinner((n) => n + 1), 90);
    return () => clearInterval(timer);
  }, []);

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------
  useEffect(() => {
    const push = (agent: AgentId, line: Omit<PaneLine, 'id'>) => {
      setPanes((prev) => ({
        ...prev,
        [agent]: [...prev[agent], { id: lineId.current++, ...line }].slice(-MAX_PANE_LINES),
      }));
    };

    const pushMany = (agent: AgentId, lines: Array<Omit<PaneLine, 'id'>>) => {
      setPanes((prev) => ({
        ...prev,
        [agent]: [...prev[agent], ...lines.map((l) => ({ id: lineId.current++, ...l }))].slice(
          -MAX_PANE_LINES,
        ),
      }));
    };

    /** Append streaming text to the last line, starting new ones at newlines. */
    const appendText = (agent: AgentId, kind: 'text' | 'thinking' | 'output', delta: string) => {
      setPanes((prev) => {
        const lines = [...prev[agent]];
        const parts = delta.split('\n');
        const last = lines[lines.length - 1];

        if (last && last.kind === kind) {
          lines[lines.length - 1] = { ...last, text: last.text + parts[0] };
        } else if (parts[0]) {
          lines.push({ id: lineId.current++, kind, text: parts[0] });
        }
        for (const part of parts.slice(1)) {
          lines.push({ id: lineId.current++, kind, text: part });
        }
        return { ...prev, [agent]: lines.slice(-MAX_PANE_LINES) };
      });
    };

    const addRelay = (entry: Omit<RelayEntry, 'id'>) => {
      setRelay((prev) => [...prev, { id: relayId.current++, ...entry }].slice(-200));
    };

    return bus.on((event) => {
      switch (event.kind) {
        case 'text':
          appendText(event.agent, 'text', event.delta);
          break;
        case 'thinking':
          appendText(event.agent, 'thinking', event.delta);
          break;
        case 'output':
          appendText(event.agent, 'output', event.chunk);
          break;
        case 'prompt':
          // The input half of this agent's conversation, shown in its own pane.
          pushMany(event.agent, [
            { kind: 'prompt-head', text: `▼ doet → ${event.agent} · ${event.label}` },
            ...event.text.split('\n').map((text) => ({ kind: 'prompt' as const, text })),
            { kind: 'prompt-head', text: '' },
          ]);
          break;
        case 'tool':
          if (event.phase === 'start') {
            push(event.agent, { kind: 'tool', text: `${event.name} ${event.summary}`.trim() });
          } else if (event.ok === false) {
            push(event.agent, { kind: 'tool', text: 'failed', ok: false });
          }
          break;
        case 'error':
          push(event.agent, { kind: 'error', text: event.message });
          addRelay({ from: event.agent, round: roundRef.current, note: event.message, level: 'error' });
          break;
        case 'status':
        case 'usage':
          setInfos((prev) => ({ ...prev, [event.agent]: agents[event.agent].info() }));
          break;
        case 'session':
          setInfos((prev) => ({ ...prev, [event.agent]: agents[event.agent].info() }));
          push(event.agent, { kind: 'note', text: '── new session ──' });
          break;
        case 'gist':
          setGist(event.text);
          // Shown, not filed away. A digest nobody reads is a digest that was
          // not worth paying a third agent for — and a one-line "notes updated,
          // press ctrl+g" is a notification, not the notes. Switches the band
          // over unless you have already chosen what you want to look at.
          if (!bandPinned.current) setBand('gist');
          setGistScroll(0);
          break;
        case 'permission':
          setPermissions((prev) => [...prev, event.request]);
          break;
        case 'permission-resolved':
          push(event.agent, { kind: 'note', text: `${event.label}` });
          break;
        case 'turn-end':
          push(event.agent, { kind: 'note', text: '── end of turn ──' });
          // Claude only learns its session id once the session has something in
          // it, so this is the first point a resumable id exists.
          setInfos((prev) => ({ ...prev, [event.agent]: agents[event.agent].info() }));
          break;
        case 'relay':
          addRelay({ from: event.from, to: event.to, round: event.round, note: event.note });
          roundRef.current = event.round;
          setRound(event.round);
          break;
        case 'debate':
          setPhase(event.phase);
          break;
        case 'log':
          addRelay({
            from: event.source === 'doet' ? 'doet' : event.source,
            round: roundRef.current,
            note: event.message,
            level: event.level,
          });
          break;
        default:
          break;
      }
    });
  }, [bus, agents]);

  // Keep the active-agent highlight in sync with the conductor.
  useEffect(() => {
    const timer = setInterval(() => setActive(conductor.activeAgent), 120);
    return () => clearInterval(timer);
  }, [conductor]);

  const refreshInfo = useCallback(
    (agent: AgentId) => setInfos((prev) => ({ ...prev, [agent]: agents[agent].info() })),
    [agents],
  );

  /**
   * Keeps `meta.json` current so `doet --resume` has something to reopen. It is
   * rewritten whenever a session id or model could have changed, rather than at
   * exit — the case that most needs it is the one that never reaches exit.
   */
  useEffect(() => {
    try {
      store.writeMeta({
        cwd: infos.claude.cwd,
        query: conductor.currentQuery,
        agents: {
          claude: {
            sessionId: infos.claude.sessionId,
            model: infos.claude.model,
            effort: infos.claude.effort,
          },
          codex: {
            sessionId: infos.codex.sessionId,
            model: infos.codex.model,
            effort: infos.codex.effort,
          },
        },
        summary: { agent: config.summary.agent, model: config.summary.model.id },
      });
    } catch {
      // Bookkeeping for `--resume`. Never worth taking a render down over.
    }
  }, [store, conductor, config, infos, phase]);

  // ---------------------------------------------------------------------
  // Pickers
  // ---------------------------------------------------------------------

  const openPicker = useCallback((spec: PickSpec, index = 0) => {
    setPick(spec);
    setPickIndex(index);
  }, []);

  const closePicker = useCallback(() => {
    setPick(null);
    setPickIndex(0);
  }, []);

  /** agent → model → effort, each step reading from that CLI's own list. */
  const pickModel = useCallback(
    (agent: AgentId) => {
      void agents[agent].listModels().then((models) => {
        if (models.length === 0) {
          setNotice(`${AGENT_LABELS[agent]} did not report a model list. Use /model ${agent} <id>.`);
          return;
        }
        const currentId = agents[agent].info().model;
        openPicker({
          title: `Model for ${AGENT_LABELS[agent]}`,
          items: models.map((m) => ({
            id: m.id,
            label: m.label,
            description: m.description,
            badge: [m.id === currentId ? 'current' : '', m.isDefault ? 'default' : '']
              .filter(Boolean)
              .join(' · '),
          })),
          onPick: (modelId) => {
            const chosen = models.find((m) => m.id === modelId);
            const efforts = chosen?.efforts ?? [];
            if (efforts.length === 0) {
              closePicker();
              void applyModel(agent, modelId, undefined);
              return;
            }
            // Effort is a real part of picking a model on both CLIs, so it is
            // the second step rather than a separate command to remember.
            openPicker({
              title: `Reasoning effort for ${chosen?.label ?? modelId}`,
              items: EFFORTS.filter((e) => efforts.includes(e)).map((e) => ({
                id: e,
                label: e,
                badge: e === chosen?.defaultEffort ? 'default' : '',
              })),
              onPick: (effort) => {
                closePicker();
                void applyModel(agent, modelId, effort as Effort);
              },
            });
          },
        });
      });
    },
    [agents, openPicker, closePicker],
  );

  const applyModel = useCallback(
    async (agent: AgentId, model: string, effort: Effort | undefined) => {
      try {
        await agents[agent].setModel(model, effort);
        refreshInfo(agent);
        config.models[agent] = { id: model, effort };
        saveConfig(config);
        setNotice(`${AGENT_LABELS[agent]} → ${model}${effort ? ` · ${effort}` : ''}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [agents, config, refreshInfo],
  );

  /** Which agent keeps the notes, then on which of its models. */
  const pickSummary = useCallback(() => {
    // Start on whatever was chosen last, so confirming is one keystroke.
    const order: SummarySource[] = ['claude', 'codex', 'off'];
    const at = Math.max(0, order.indexOf(config.summary.agent));

    openPicker({
      title: 'Who keeps the running notes?',
      hint: 'its own session · never one of the two working agents',
      items: [
        {
          id: 'claude',
          label: `A separate ${AGENT_LABELS.claude} session`,
          description:
            'Reads both agents’ messages each exchange and writes a digest for you. Neither working session is touched.',
        },
        {
          id: 'codex',
          label: `A separate ${AGENT_LABELS.codex} thread`,
          description: 'The same, on Codex. Read-only, and never raises a prompt.',
        },
        {
          id: 'off',
          label: 'No notes',
          description: 'Nothing extra runs. The panes and the transcript are the whole record.',
        },
      ].map((item) => ({
        ...item,
        badge: item.id === config.summary.agent ? 'current' : '',
      })),
      onPick: (which) => {
        if (which === 'off') {
          closePicker();
          void applySummary({ ...config.summary, agent: 'off' });
          return;
        }
        const agent = which as AgentId;
        void agents[agent].listModels().then((models) => {
          if (models.length === 0) {
            closePicker();
            void applySummary({ ...config.summary, agent, model: { id: '' } });
            return;
          }
          openPicker({
            title: `Summary model (${AGENT_LABELS[agent]})`,
            hint: '↑↓ move · enter select · esc cancel — a small model is usually right here',
            items: models.map((m) => ({
              id: m.id,
              label: m.label,
              description: m.description,
              badge: m.id === config.summary.model.id ? 'current' : '',
            })),
            onPick: (modelId) => {
              closePicker();
              void applySummary({ ...config.summary, agent, model: { id: modelId } });
            },
          });
        });
      },
    }, at);
  }, [agents, config, openPicker, closePicker]);

  const applySummary = useCallback(
    async (setting: DoetConfig['summary']) => {
      config.summary = setting;
      saveConfig(config);
      await summarizer.configure(setting);
      setNotice(
        setting.agent === 'off' || setting.agent === 'ask'
          ? 'Notes off.'
          : `Notes → ${AGENT_LABELS[setting.agent]}${setting.model.id ? ` · ${setting.model.id}` : ''}`,
      );
    },
    [config, summarizer],
  );

  /**
   * The question asked whenever a session is retired, manually or by policy.
   * `who` is a label rather than an agent id so `/new`, which rotates both, can
   * ask once without naming only one of them.
   */
  const askHandoff = useCallback(
    (who: string, reason: string): Promise<HandoffMode> =>
      new Promise<HandoffMode>((resolve) => {
        const answer = (mode: HandoffMode) => {
          closePicker();
          resolve(mode);
        };
        openPicker({
          title: `New ${who} session — ${reason}. What should it carry over?`,
          hint: '↑↓ move · enter select — the new session remembers nothing else',
          items: [
            {
              id: 'gist',
              label: 'The gist',
              description: 'The summary agent’s digest: small, and enough to keep working.',
            },
            {
              id: 'full',
              label: 'The complete session',
              description: 'Everything said so far. Faithful, but re-pays for every token.',
            },
            {
              id: 'none',
              label: 'Nothing',
              description: 'A clean slate. It will only know the next prompt it is given.',
            },
          ],
          onPick: (mode) => answer(mode as HandoffMode),
          onCancel: () => answer('gist'),
        });
      }),
    [openPicker, closePicker],
  );

  /**
   * Asked at the start of every doet session, with last time's answer already
   * under the cursor — confirming is one keystroke, changing it is two.
   *
   * Not asked once and remembered forever: a note-taker is a third agent
   * burning real tokens on every exchange, and whether that is worth it depends
   * on the session you are about to have, not on the one where you last
   * thought about it. `--summary` skips the question outright.
   */
  const askedSummary = useRef(false);
  useEffect(() => {
    if (askedSummary.current || !promptForSummary) return;
    askedSummary.current = true;
    pickSummary();
  }, [promptForSummary, pickSummary]);

  // The conductor asks through this when a policy fires mid-debate.
  useEffect(() => {
    conductor.setHooks({
      askHandoff: ({ agent, reason }) => askHandoff(AGENT_LABELS[agent], reason),
    });
  }, [conductor, askHandoff]);

  // ---------------------------------------------------------------------
  // Taking a session over
  // ---------------------------------------------------------------------

  /**
   * Hands one pane's session to the user, in that agent's own interactive CLI.
   *
   * doet drives these CLIs over protocols, not a TTY — the SDK for Claude, the
   * app-server for Codex — so there is no terminal behind a pane to attach to.
   * What there is, is a session id both sides agree on. So doet lets go of the
   * session, gives the terminal to the real CLI resumed at that id, and picks
   * the session back up when you exit. Anything you did in there comes with it.
   */
  const takeOver = useCallback(
    async (agent: AgentId) => {
      // Releasing a session takes a moment, and a second ctrl+o in that window
      // would suspend an already-suspended terminal — which Ink throws on, and
      // which used to take the whole process down with it.
      if (takingOver.current) {
        setNotice('Already handing a session over — finish that one first.');
        return;
      }

      const adapter = agents[agent];
      const argv = adapter.interactiveCommand();
      if (!argv) {
        setNotice(`${AGENT_LABELS[agent]} has no session to open yet — it needs to take a turn first.`);
        return;
      }

      takingOver.current = true;
      setHandover(`Handing ${AGENT_LABELS[agent]} over…`);
      let id: string | null = null;
      let failure: string | null = null;

      try {
        // Two processes writing one session corrupts it, so the conductor has
        // to be done with this agent before doet lets go.
        if (conductor.isRunning) {
          await conductor.abort();
          await conductor.whenIdle();
        }

        id = await adapter.releaseSession();
        if (!id) {
          setNotice(`${AGENT_LABELS[agent]} has no resumable session.`);
          return;
        }

        try {
          // Ink gives the terminal to the child and restores itself afterwards.
          await suspendTerminal(async () => {
            printHandoverBanner(agent, argv);
            await new Promise<void>((resolve) => {
              const child = spawn(argv.command, argv.args, {
                stdio: 'inherit',
                cwd: adapter.info().cwd,
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
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        // However that went, the agent must not be left without a session.
        if (id) {
          try {
            await adapter.resumeSession(id);
          } catch (error) {
            failure ??= error instanceof Error ? error.message : String(error);
          }
        }
        takingOver.current = false;
        setHandover(null);
      }

      refreshInfo(agent);
      setPanes((prev) => ({
        ...prev,
        [agent]: [
          ...prev[agent],
          {
            id: lineId.current++,
            kind: 'note' as const,
            text: failure
              ? `── handover ended: ${failure} ──`
              : '── you took over this session · doet re-attached ──',
          },
        ],
      }));
      setNotice(
        failure
          ? `Handover problem on ${agent}: ${failure}`
          : `Back in doet. ${AGENT_LABELS[agent]} kept everything you did.`,
      );
    },
    [agents, conductor, refreshInfo, suspendTerminal],
  );

  /**
   * Opens a branch of the session in its own window. Nothing in doet stops —
   * the agent is not interrupted and its session is never released, because the
   * branch is a different session.
   */
  const forkOut = useCallback(
    async (agent: AgentId, where: Launcher) => {
      const adapter = agents[agent];
      try {
        const argv = await adapter.forkSession();
        if (!argv) {
          setNotice(`${AGENT_LABELS[agent]} has no session to branch yet.`);
          return;
        }
        await where.launch(argv.command, argv.args, adapter.info().cwd);
        setPanes((prev) => ({
          ...prev,
          [agent]: [
            ...prev[agent],
            {
              id: lineId.current++,
              kind: 'note' as const,
              text: `── branched into ${where.label} · this session carries on ──`,
            },
          ],
        }));
        setNotice(`Opened a branch of ${AGENT_LABELS[agent]} in ${where.label}.`);
      } catch (error) {
        setNotice(
          `Could not open a window: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [agents],
  );

  /**
   * Branches the session and hands you the command instead of running it.
   *
   * No editor lets a child process open a new integrated terminal, so when doet
   * is running inside one there is nothing it can launch that stays put. This
   * is the way out: you open a terminal wherever you actually want it — a split
   * in your editor, another tab — and paste.
   */
  const copyBranch = useCallback(
    async (agent: AgentId) => {
      const adapter = agents[agent];
      try {
        const argv = await adapter.forkSession();
        if (!argv) {
          setNotice(`${AGENT_LABELS[agent]} has no session to branch yet.`);
          return;
        }
        const line = shellCommand(argv.command, argv.args, adapter.info().cwd);
        const copied = await copyToClipboard(line);
        setPanes((prev) => ({
          ...prev,
          [agent]: [
            ...prev[agent],
            {
              id: lineId.current++,
              kind: 'note' as const,
              text: `── branch ready${copied ? ' · copied to clipboard' : ''} ──`,
            },
            // Printed regardless, so it is readable and selectable even when
            // there is no clipboard tool to be found.
            { id: lineId.current++, kind: 'note' as const, text: line },
          ],
        }));
        setNotice(
          copied
            ? 'Branch command copied — open a terminal anywhere and paste.'
            : 'Branch command is in the pane — copy it and run it anywhere.',
        );
      } catch (error) {
        setNotice(
          `Could not branch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [agents],
  );

  /** Runs a branch using whatever `config.branch` says to do. */
  const branchWith = useCallback(
    (agent: AgentId, setting: DoetConfig['branch']) => {
      if (setting.mode === 'copy') {
        void copyBranch(agent);
        return;
      }
      const chosen =
        setting.mode === 'command'
          ? launcherById('command', setting.command)
          : launcherById(setting.launcher ?? '');
      if (!chosen) {
        setNotice('That terminal is not available here — giving you the command instead.');
        void copyBranch(agent);
        return;
      }
      void forkOut(agent, chosen);
    },
    [copyBranch, forkOut],
  );

  /**
   * Asked once, the first time you branch, then remembered.
   *
   * doet cannot work this out from the environment: whether you want a new
   * window or a command to paste into your editor's own terminal is a
   * preference, not a fact about the machine.
   */
  const askWhereBranchesOpen = useCallback(
    (agent: AgentId | null) => {
      const launchers = availableLaunchers();
      const items: PickerItem[] = [
        ...launchers.map((l) => ({
          id: `launcher:${l.id}`,
          label: l.label.charAt(0).toUpperCase() + l.label.slice(1),
          description: l.description,
          badge: l.staysPut ? 'stays in this terminal' : '',
        })),
        {
          id: 'copy',
          label: 'Just give me the command',
          description:
            'doet copies it to your clipboard and prints it. Open a terminal wherever you want — a split in your editor, another tab — and paste. Works everywhere.',
        },
      ];

      // In an editor, the option that keeps you there goes first. Nothing doet
      // can launch stays inside an editor panel except tmux.
      if (inEditorTerminal() && !launchers.some((l) => l.staysPut)) {
        items.unshift(items.splice(items.length - 1, 1)[0]!);
      }

      openPicker({
        title: 'Where should branched sessions open?',
        hint: 'asked once · change it later with /where',
        items,
        onPick: (choice) => {
          closePicker();
          const setting: DoetConfig['branch'] = choice.startsWith('launcher:')
            ? { mode: 'launcher', launcher: choice.slice('launcher:'.length) }
            : { mode: 'copy' };
          config.branch = setting;
          saveConfig(config);
          if (agent) branchWith(agent, setting);
          else setNotice('Saved. Branches will open there from now on.');
        },
      });
    },
    [config, openPicker, closePicker, branchWith],
  );

  /**
   * Neither CLI lets two processes write one session, so there are exactly two
   * honest choices and this asks which one you want.
   */
  const requestTakeOver = useCallback(
    (agent: AgentId) => {
      if (takingOver.current) {
        setNotice('Already handing a session over — finish that one first.');
        return;
      }

      // Where a branch goes is a setting, asked once — so this only has to ask
      // the question that genuinely differs each time.
      const where =
        config.branch.mode === 'copy'
          ? 'you get the command'
          : (launcherById(
              config.branch.mode === 'command' ? 'command' : (config.branch.launcher ?? ''),
              config.branch.command,
            )?.label ?? 'a new terminal');

      openPicker({
        title: `${AGENT_LABELS[agent]}${conductor.isRunning ? ' is mid-turn' : ''} — open its session how?`,
        hint: 'a branch leaves everything running · a takeover brings the work back',
        items: [
          {
            id: 'branch',
            label: config.branch.mode === 'ask' ? 'Branch it' : `Branch it — ${where}`,
            description:
              'Nothing here stops: the agent keeps working and doet keeps running. You get a copy of the conversation, and what you do with it stays there.',
          },
          {
            id: 'takeover',
            label: 'Take this session over here',
            description: conductor.isRunning
              ? 'doet steps aside and gives you this terminal. The current turn is interrupted and the session ends, but everything you do comes back.'
              : 'doet steps aside and gives you this terminal. Everything you do comes back into the session.',
          },
          { id: 'cancel', label: 'Cancel', description: 'Carry on as you were.' },
        ],
        onPick: (choice) => {
          closePicker();
          if (choice === 'takeover') {
            void takeOver(agent);
          } else if (choice === 'branch') {
            if (config.branch.mode === 'ask') askWhereBranchesOpen(agent);
            else branchWith(agent, config.branch);
          }
        },
      });
    },
    [conductor, config, takeOver, branchWith, askWhereBranchesOpen, openPicker, closePicker],
  );

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  /** Asked after "who answers first", once per question. */
  const askRounds = useCallback(
    (query: string, first: AgentId) => {
      const last = config.debate.maxRounds;
      const choices = [2, 4, 6, 8, 12];
      openPicker({
        title: `How many exchanges? — ${AGENT_LABELS[first]} answers first`,
        hint: 'runs exactly this many · esc stops it early at any point',
        items: [
          ...choices.map((n) => ({
            id: String(n),
            label: `${n} exchange${n === 1 ? '' : 's'}`,
            description:
              n <= 2
                ? 'One answer and one review. Enough for a small check.'
                : n >= 12
                  ? 'For work that will genuinely take the back-and-forth.'
                  : undefined,
            badge: n === last ? 'last used' : '',
          })),
          {
            id: '1',
            label: 'Just one answer',
            description: 'No review at all — the first agent answers and that is it.',
          },
        ],
        onPick: (value) => {
          closePicker();
          const rounds = Number(value);
          // Remembered as the default the next question is offered, not as a
          // setting you have to go and change.
          config.debate.maxRounds = rounds;
          saveConfig(config);
          startDebate(query, first, rounds);
        },
        onCancel: () => setInput(query),
      });
    },
    [config, openPicker, closePicker],
  );

  const startDebate = (query: string, first: AgentId, rounds: number) => {
    setNotice('');
    void conductor
      .run(query, first, rounds)
      .then((result) => {
        store.finalize(result);
        store.snapshot({ claude: agents.claude.history(), codex: agents.codex.history() });
        // The session id, not the full path: the path is longer than the
        // header, and the id is what `--resume` and `/open` actually take.
        setNotice(`saved · ${store.id}`);
        setPhase('done');
      })
      .catch((error: unknown) => {
        bus.log('doet', error instanceof Error ? error.message : String(error), 'error');
      });
  };

  const runCommand = (raw: string) => {
    const [command, ...args] = raw.slice(1).trim().split(/\s+/);

    switch (command) {
      case 'help':
        setNotice(
          '/open <agent> · /where · /model [agent] · /summary · /session <agent> <new|policy …|handoff …> · /gist · /rounds <n> · /first <agent> · /perm <agent> <mode> · /stop · /new · /quit',
        );
        break;

      case 'model': {
        const [agent, ...rest] = args;
        // No agent named: pick one, then a model, then an effort.
        if (!agent) {
          openPicker({
            title: 'Change the model for…',
            items: AGENT_IDS.map((id) => ({
              id,
              label: AGENT_LABELS[id],
              badge: `${infos[id].model || 'default'}${infos[id].effort ? ` · ${infos[id].effort}` : ''}`,
            })),
            onPick: (id) => pickModel(id as AgentId),
          });
          break;
        }
        if (!isAgent(agent)) {
          setNotice('Usage: /model [claude|codex] [model] [effort]');
          break;
        }
        if (rest.length === 0) {
          pickModel(agent);
          break;
        }
        const [model, effort] = rest;
        if (effort && !isEffort(effort)) {
          setNotice(`Effort must be one of: ${EFFORTS.join(', ')}`);
          break;
        }
        void applyModel(agent, model!, effort as Effort | undefined);
        break;
      }

      case 'models': {
        const agent = args[0];
        if (!isAgent(agent)) {
          setNotice('Usage: /models <claude|codex>');
          break;
        }
        void agents[agent].listModels().then((list) => {
          openPicker({
            title: `${AGENT_LABELS[agent]} models`,
            hint: '↑↓ move · enter select · esc close',
            items: list.map((m) => ({
              id: m.id,
              label: m.label,
              description: m.description,
              badge: m.id === infos[agent].model ? 'current' : '',
            })),
            onPick: (id) => {
              closePicker();
              void applyModel(agent, id, undefined);
            },
          });
        });
        break;
      }

      case 'summary':
        pickSummary();
        break;

      case 'where':
        askWhereBranchesOpen(null);
        break;

      case 'open': {
        const agent = args[0] ?? focus ?? active ?? undefined;
        if (!isAgent(agent)) {
          setNotice('Usage: /open <claude|codex> — or select a pane with ←→ and press ctrl+o');
          break;
        }
        requestTakeOver(agent);
        break;
      }

      case 'gist':
        bandPinned.current = true;
        setBand('gist');
        setGistScroll(0);
        if (!gist.trim()) setNotice('No notes yet.');
        break;

      case 'session': {
        const [agent, action, ...rest] = args;
        if (!isAgent(agent)) {
          setNotice('Usage: /session <claude|codex> <new|policy manual|rounds:N|tokens:N|handoff ask|gist|full|none>');
          break;
        }
        const settings = conductor.sessionSettingsFor(agent);

        if (!action || action === 'status') {
          setNotice(
            `${AGENT_LABELS[agent]}: session #${infos[agent].sessionSeq}, ${infos[agent].sessionTurns} turns · rotate ${describeSessionPolicy(settings.policy)} · handoff ${settings.handoff}`,
          );
          break;
        }

        if (action === 'new') {
          void (async () => {
            const mode = await askHandoff(AGENT_LABELS[agent], 'you asked for one');
            await conductor.rotate(agent, mode);
            refreshInfo(agent);
          })();
          break;
        }

        if (action === 'policy') {
          const policy = parseSessionPolicy(rest.join(''));
          if (!policy) {
            setNotice('Usage: /session <agent> policy <manual|rounds:N|tokens:N>');
            break;
          }
          conductor.configureSessions(agent, { policy });
          config.sessions[agent].policy = policy;
          saveConfig(config);
          setNotice(`${AGENT_LABELS[agent]} rotates ${describeSessionPolicy(policy)}.`);
          break;
        }

        if (action === 'handoff') {
          const mode = rest[0];
          if (mode !== 'ask' && mode !== 'gist' && mode !== 'full' && mode !== 'none') {
            setNotice('Usage: /session <agent> handoff <ask|gist|full|none>');
            break;
          }
          conductor.configureSessions(agent, { handoff: mode });
          config.sessions[agent].handoff = mode;
          saveConfig(config);
          setNotice(`${AGENT_LABELS[agent]} carries ${mode === 'ask' ? 'whatever you choose' : mode} into a new session.`);
          break;
        }

        setNotice('Usage: /session <agent> <new|policy …|handoff …>');
        break;
      }

      case 'perm': {
        const [agent, mode] = args;
        if (!isAgent(agent) || !mode) {
          setNotice(
            `Usage: /perm <claude|codex> <mode>. claude: ${agents.claude
              .listPermissionModes()
              .join('|')} · codex: ${agents.codex.listPermissionModes().join('|')}`,
          );
          break;
        }
        void agents[agent]
          .setPermissionMode(mode)
          .then(() => refreshInfo(agent))
          .catch((error: unknown) =>
            setNotice(error instanceof Error ? error.message : String(error)),
          );
        break;
      }

      case 'rounds': {
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 1) {
          setNotice('Usage: /rounds <n>');
          break;
        }
        conductor.configure({ maxRounds: n });
        config.debate.maxRounds = n;
        saveConfig(config);
        setNotice(`${n} exchanges will be offered by default — you still pick per question.`);
        break;
      }

      case 'first': {
        const agent = args[0];
        if (!isAgent(agent)) {
          setNotice('Usage: /first <claude|codex>');
          break;
        }
        config.defaultFirst = agent;
        saveConfig(config);
        setNotice(`${AGENT_LABELS[agent]} will answer first by default.`);
        break;
      }

      case 'stop':
        conductor.requestStop();
        break;

      case 'new':
        // A fresh doet session is a fresh session for both agents too — the
        // panes clearing while the agents still remember everything is exactly
        // the confusion this used to cause.
        void (async () => {
          const mode = await askHandoff('doet', 'both agents start over');
          for (const id of AGENT_IDS) {
            await conductor.rotate(id, mode);
            refreshInfo(id);
          }
          conductor.clear();
          setPanes({ claude: [], codex: [] });
          setRelay([]);
          setPhase('idle');
          setRound(0);
          roundRef.current = 0;
          setScroll({ claude: 0, codex: 0 });
          setGist('');
          setNotice(`New session. Both agents carried ${mode === 'none' ? 'nothing' : `the ${mode}`}.`);
          // A new doet session gets the same question a launch does.
          pickSummary();
        })();
        break;

      case 'quit':
      case 'exit':
        void shutdown();
        break;

      default:
        setNotice(`Unknown command: /${command ?? ''}`);
    }
  };

  const shutdown = async () => {
    store.snapshot({ claude: agents.claude.history(), codex: agents.codex.history() });
    store.detach();
    await summarizer.dispose().catch(() => {});
    await Promise.all(AGENT_IDS.map((id) => agents[id].dispose()));
    exit();
  };

  const answerPermission = (request: PermissionRequest, optionId: string, label: string) => {
    agents[request.agent].resolvePermission(request.id, optionId);
    bus.emit({
      kind: 'permission-resolved',
      agent: request.agent,
      id: request.id,
      optionId,
      label,
    });
    setPermissions((prev) => prev.filter((p) => p.id !== request.id));
  };

  // ---------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------

  const scrollBy = (delta: number) => {
    if (band === 'gist' && !focus) {
      setGistScroll((value) => Math.max(0, value + delta));
      return;
    }
    if (!focus) return;
    const { rows: total, viewport } = metrics.current[focus];
    setScroll((prev) => ({
      ...prev,
      [focus]: Math.max(0, Math.min(prev[focus] + delta, Math.max(0, total - viewport))),
    }));
  };

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  const current = permissions[0];

  useInput((char, key) => {
    // Quitting has to work from every state, including a blocking prompt.
    if (key.ctrl && char === 'c') {
      void shutdown();
      return;
    }

    // A pending permission owns the keyboard — an agent is blocked on it.
    if (current) {
      const option = current.options.find((o) => o.key === char);
      if (option) {
        answerPermission(current, option.id, option.label);
      } else if (key.escape) {
        const deny = current.options.find((o) => o.tone === 'deny');
        if (deny) answerPermission(current, deny.id, deny.label);
      }
      return;
    }

    // Then a picker, which may itself be blocking a rotation.
    if (pick) {
      if (key.upArrow) {
        setPickIndex((i) => (i - 1 + pick.items.length) % pick.items.length);
      } else if (key.downArrow) {
        setPickIndex((i) => (i + 1) % pick.items.length);
      } else if (key.return) {
        const item = pick.items[pickIndex];
        if (item) pick.onPick(item.id);
      } else if (key.escape) {
        const cancel = pick.onCancel;
        closePicker();
        cancel?.();
      }
      return;
    }

    if (choosingFirst) {
      if (char === '1' || char === '2') {
        const first: AgentId = char === '1' ? 'claude' : 'codex';
        setChoosingFirst(false);
        askRounds(pendingQuery.current, first);
      } else if (key.escape) {
        setChoosingFirst(false);
        setInput(pendingQuery.current);
      }
      return;
    }

    if (key.ctrl && char === 'x') {
      void conductor.abort();
      return;
    }

    // Pane navigation. All non-printable, so the composer keeps every
    // character key — you can still type while a debate streams.
    if (key.tab) {
      setFocus((f) => (f === null ? 'claude' : f === 'claude' ? 'codex' : null));
      return;
    }

    // Left and right pick a pane by where it is on screen, which works the same
    // whether or not a turn is running.
    if (key.leftArrow) {
      setFocus('claude');
      return;
    }
    if (key.rightArrow) {
      setFocus('codex');
      return;
    }

    if (key.ctrl && char === 'o') {
      requestTakeOver(focus ?? active ?? 'claude');
      return;
    }

    if (key.ctrl && char === 'e') {
      setZoom((z) => !z);
      if (!focus) setFocus('claude');
      return;
    }

    if (key.ctrl && char === 'g') {
      bandPinned.current = true;
      setBand((b) => (b === 'relay' ? 'gist' : 'relay'));
      setGistScroll(0);
      return;
    }

    if (key.pageUp) {
      scrollBy(metrics.current[focus ?? 'claude'].viewport - 1);
      return;
    }
    if (key.pageDown) {
      scrollBy(-(metrics.current[focus ?? 'claude'].viewport - 1));
      return;
    }

    if (key.upArrow || key.downArrow) {
      const up = key.upArrow;
      // A focused pane (or the gist band) takes the arrows; otherwise they
      // walk the input history, as a prompt line should.
      if (focus || band === 'gist') {
        scrollBy(up ? 1 : -1);
        return;
      }
      if (history.length > 0) {
        const next = up
          ? Math.min(histIndex.current + 1, history.length - 1)
          : histIndex.current - 1;
        histIndex.current = Math.max(-1, next);
        setInput(histIndex.current < 0 ? '' : history[history.length - 1 - histIndex.current]!);
      }
      return;
    }

    if (key.escape) {
      if (focus) {
        setFocus(null);
        setZoom(false);
        return;
      }
      if (conductor.isRunning) conductor.requestStop();
      return;
    }

    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput('');
      setHistory((prev) => [...prev, text].slice(-100));
      histIndex.current = -1;

      if (text.startsWith('/')) {
        runCommand(text);
        return;
      }

      if (conductor.isRunning) {
        // Mid-debate typing is a note to the agents, not a new question.
        conductor.interject(text);
        setRelay((prev) => [
          ...prev,
          { id: relayId.current++, from: 'user', round, note: `note: ${text}` },
        ]);
        return;
      }

      pendingQuery.current = text;
      setChoosingFirst(true);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      setInput((value) => value + char);
    }
  });

  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------

  const permissionHeight = current
    ? Math.min(18, 8 + (current.detail?.split('\n').length ?? 0))
    : 0;
  const pickHeight = pick ? Math.min(20, 6 + Math.min(8, pick.items.length) * 2) : 0;
  const chrome = 1 /* header */ + 4 /* composer */ + permissionHeight + pickHeight;
  const bandHeight = Math.min(band === 'gist' ? 12 : 6, Math.max(3, Math.floor((rows - chrome) * 0.28)));
  const paneHeight = Math.max(6, rows - chrome - bandHeight - 1);
  const paneWidth = Math.floor((cols - 1) / 2);

  const summary = useMemo(() => {
    if (phase === 'idle') return 'ready';
    if (phase === 'done') return 'done';
    if (phase === 'synthesizing') return 'writing final version';
    return `${phase} · exchange ${round + 1}/${conductor.settings.maxRounds}`;
  }, [phase, round, conductor]);

  const noteRows = (agent: AgentId) => (n: number, viewport: number) => {
    metrics.current[agent] = { rows: n, viewport };
  };

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* One row, and it must stay one row. Without the shrink rules a long
          notice pushes the whole header past `cols`, and Ink resolves that by
          squeezing every child — which reads as garbled text ("doe", the
          status jammed onto the model name) rather than as an overflow. */}
      <Box paddingX={1} width={cols} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold>doet</Text>
          <Text dimColor> · </Text>
          <Text color={AGENT_COLOR.claude}>claude</Text>
          <Text dimColor>/</Text>
          <Text color={AGENT_COLOR.codex}>codex</Text>
        </Box>
        {summarizer.enabled && (
          <Box flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {' '}
              · gist {summarizer.describe}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} />
        {handover ? (
          <Box flexShrink={0}>
            <Text color="cyan" bold>
              {SPINNER[spinner % SPINNER.length]} {handover}
            </Text>
          </Box>
        ) : (
          <>
            <Box flexShrink={0}>
              <Text color={phase === 'done' ? 'green' : 'yellow'}>{summary}</Text>
            </Box>
            {notice && (
              <Box flexShrink={1} overflow="hidden">
                <Text dimColor wrap="truncate-end">
                  {' '}
                  · {notice}
                </Text>
              </Box>
            )}
          </>
        )}
      </Box>

      <Box>
        {(!zoom || focus !== 'codex') && (
          <AgentPane
            agent="claude"
            info={infos.claude}
            lines={panes.claude}
            width={zoom ? cols : paneWidth}
            height={paneHeight}
            active={active === 'claude'}
            focused={focus === 'claude'}
            scroll={scroll.claude}
            spinnerFrame={spinner}
            onRows={noteRows('claude')}
          />
        )}
        {(!zoom || focus === 'codex') && (
          <AgentPane
            agent="codex"
            info={infos.codex}
            lines={panes.codex}
            width={zoom ? cols : cols - paneWidth}
            height={paneHeight}
            active={active === 'codex'}
            focused={focus === 'codex'}
            scroll={scroll.codex}
            spinnerFrame={spinner}
            onRows={noteRows('codex')}
          />
        )}
      </Box>

      <Box paddingX={1}>
        {band === 'gist' ? (
          <GistPanel
            gist={gist}
            source={summarizer.describe}
            width={cols - 2}
            height={bandHeight}
            scroll={gistScroll}
          />
        ) : (
          <RelayLog entries={relay} width={cols - 2} height={bandHeight} />
        )}
      </Box>

      {pick && (
        <Box paddingX={1}>
          <Picker
            title={pick.title}
            items={pick.items}
            index={pickIndex}
            width={cols - 2}
            hint={pick.hint}
          />
        </Box>
      )}

      {current && (
        <Box paddingX={1}>
          <PermissionPrompt request={current} queued={permissions.length - 1} width={cols - 2} />
        </Box>
      )}

      <Composer
        value={input}
        choosingFirst={choosingFirst}
        phase={phase}
        active={active}
        width={cols}
        hint={focus ? HINT_FOCUSED : conductor.isRunning ? HINT_RUNNING : HINT_IDLE}
      />
    </Box>
  );
}

function isAgent(value: string | undefined): value is AgentId {
  return value === 'claude' || value === 'codex';
}

/**
 * Written straight to the terminal inside the suspension, just before the child
 * takes it. Without this the screen simply becomes another CLI, with nothing
 * saying where doet went or how to get back to it.
 */
function printHandoverBanner(agent: AgentId, argv: { command: string; args: string[] }): void {
  const line = '─'.repeat(64);
  process.stdout.write(
    `\n${line}\n` +
      ` doet handed this terminal to ${AGENT_LABELS[agent]}.\n` +
      ` ${argv.command} ${argv.args.join(' ')}\n\n` +
      ` Quit that CLI when you are done — ctrl+d, /exit, or ctrl+c twice —\n` +
      ` and doet comes back with this session and everything you did in it.\n` +
      `${line}\n\n`,
  );
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as string[]).includes(value);
}
