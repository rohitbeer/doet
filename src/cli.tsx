#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { render } from 'ink';
import React from 'react';
import { Bus } from './core/bus.js';
import { loadConfig, saveConfig, type DoetConfig } from './core/config.js';
import { SessionStore } from './core/sessions.js';
import { AGENT_LABELS } from './core/relay.js';
import { DOET_HOME } from './core/paths.js';
import {
  addWorktree,
  deleteBranch,
  excludeLocally,
  inspectRepo,
  listVsWorktrees,
  removeVsWorktree,
  removeWorktree,
  vsBranchName,
} from './core/git.js';
import { TmuxSession, tmux, tmuxAvailable } from './core/tmux.js';
import { VsRunner, vsInstructions, type VsSide } from './core/vs.js';
import { TmuxAgent } from './core/adapters/tmux-agent.js';
import { AGENT_IDS, SLOT_IDS, type AgentAdapter, type AgentId, type CliId, type Effort, type SlotId, type UiMode } from './core/types.js';
import { Conductor, DEFAULT_DEBATE, coCodeInstructions } from './core/conductor.js';
import { Control } from './ui/Control.js';
import { CoCode } from './ui/CoCode.js';
import { Modern } from './ui/Modern.js';
import { chooseOne } from './ui/StandalonePicker.js';

/**
 * What one VS run needs, written to disk so the copy of doet that runs inside
 * tmux can pick up exactly what the copy in your terminal decided.
 *
 * doet builds the layout and then has to live in it, which means re-entering
 * itself as the first pane. Handing the plan over as a file rather than as
 * argv keeps a long prompt, a model id with spaces in it and a path with
 * anything in it out of a command line.
 */
interface RunPlan {
  mode: DoetMode;
  /** Which interface to draw, and so whether the agents share doet's window. */
  ui: UiMode;
  socket: string;
  root: string;
  mainRoot: string;
  gitCommonDir: string;
  head: string;
  sessionId: string;
  rounds: number;
  /** vs only: which CLI, model and effort each isolated slot runs. */
  slots: Record<SlotId, { cli: CliId; model: string; effort?: Effort }>;
  /** co-code only: both agents work in one tree, so there are no slots. */
  agents: Record<AgentId, { model: string; effort?: Effort }>;
}

type DoetMode = 'co-code' | 'vs';

interface Args {
  cwd: string;
  claudeModel?: string;
  claudeEffort?: Effort;
  codexModel?: string;
  codexEffort?: Effort;
  mode?: DoetMode;
  ui?: UiMode;
  rounds?: number;
  worktrees?: 'list' | 'prune';
  force?: boolean;
  /** Internal: the plan to drive, when doet is re-entering inside tmux. */
  drive?: string;
}

function asEffort(value: string | undefined): Effort | undefined {
  return value && (['low', 'medium', 'high', 'xhigh', 'max'] as string[]).includes(value)
    ? (value as Effort)
    : undefined;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('-') ? next : undefined;
    const took = (): void => {
      if (value !== undefined) i++;
    };
    const required = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      return value;
    };

    switch (flag) {
      case '-C':
      case '--cwd':
        args.cwd = required();
        took();
        break;
      case '--claude-model':
        args.claudeModel = required();
        took();
        break;
      case '--claude-effort':
        args.claudeEffort = asEffort(required());
        took();
        break;
      case '--codex-model':
        args.codexModel = required();
        took();
        break;
      case '--codex-effort':
        args.codexEffort = asEffort(required());
        took();
        break;
      case '--mode':
        if (value !== 'co-code' && value !== 'vs') throw new Error('--mode must be co-code or vs.');
        args.mode = value;
        took();
        break;
      case '--ui':
        if (value !== 'interactive' && value !== 'modern') {
          throw new Error('--ui must be interactive or modern.');
        }
        args.ui = value;
        took();
        break;
      case '--rounds': {
        const n = Number(required());
        if (!Number.isFinite(n) || n < 1) throw new Error('--rounds must be a positive number.');
        args.rounds = Math.floor(n);
        took();
        break;
      }
      case '--worktrees':
        if (value === 'prune') {
          args.worktrees = 'prune';
          took();
        } else {
          args.worktrees = 'list';
        }
        break;
      case '--force':
        args.force = true;
        break;
      case '--drive':
        args.drive = required();
        took();
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write(`${version()}\n`);
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`doet — run two coding agents on the same task and compare them.

doet gives each agent its own git worktree and its own tmux pane, running its
real CLI. You watch both work, side by side, in the interface each one already
has. doet keeps the score, records the transcripts, and can fold either result
back into your working tree when you have picked one.

Usage
  doet [options]

Options
  -C, --cwd <dir>          Repository to work in (default: cwd)
      --ui <which>         interactive (agents on screen) or modern (agents
                           filed under their names, one keypress away)
      --claude-model <m>   Model when a slot runs Claude Code
      --claude-effort <e>  Reasoning effort: low|medium|high|xhigh|max
      --codex-model <m>    Model when a slot runs Codex
      --codex-effort <e>   Reasoning effort: low|medium|high|xhigh|max
      --worktrees          List the branches and worktrees past runs left here
      --worktrees prune    Delete the ones holding no work (--force: all)
  -h, --help               This text
  -v, --version            Print the version and exit

Environment
  DOET_HOME                Where doet keeps config and sessions (default: ~/.doet)

In the run
  type + enter             Send the request to both slots
  tab                      Target one slot; enter then talks to it alone
  a / b                    Fold that slot's branch into your main tree
  esc                      Stop the current turn (or clear the target)
  ctrl+c                   Quit; branches and worktrees are kept

  Each agent is a real CLI in its own pane. Approve its tools, scroll its
  output and type into it directly — doet does not stand in the way. Move
  between panes with your usual tmux keys.

Requires tmux, and the CLI or CLIs you select on PATH and logged in.
`);
}

/**
 * How to start this same doet again, in a pane.
 *
 * Not simply `node <argv[1]>`. Under `npm run dev` doet runs through tsx, which
 * is node plus a `--require` preflight and an `--import` loader — and argv[1]
 * is then `src/cli.tsx`, which bare node cannot parse:
 *
 *     ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx"
 *
 * and the pane dies before it draws anything. `execArgv` holds exactly those
 * hooks, so carrying it forward re-enters through whatever runtime is already
 * running — tsx in development, plain node from `dist`.
 */
function reenter(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (!script) throw new Error('doet cannot work out how to restart itself.');
  // `--eval` only shows up when node was given a program on the command line,
  // which is never how doet is launched; passing it on would re-run that
  // snippet instead of doet.
  const hooks: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const flag = process.execArgv[i]!;
    if (flag === '--eval' || flag === '-e' || flag.startsWith('--eval=')) {
      if (!flag.includes('=')) i++;
      continue;
    }
    hooks.push(flag);
  }
  return { command: process.execPath, args: [...hooks, script, ...args] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Re-entry: this process is the one living inside the layout.
  if (args.drive) {
    await drive(args.drive, config);
    return;
  }

  if (args.worktrees) {
    await manageWorktrees(args.cwd, args.worktrees, args.force ?? false);
    return;
  }

  await launch(args, config);
}

/**
 * Lists or deletes the branches and worktrees runs leave behind.
 *
 * Kept as a command rather than a screen: the cleanup you want is across runs
 * rather than within one, and a finished run's UI is gone by the time you want
 * to tidy up after it.
 */
async function manageWorktrees(cwd: string, action: 'list' | 'prune', force: boolean): Promise<void> {
  const repo = await inspectRepo(cwd);
  if (!repo) {
    process.stderr.write('Not a git repository, so there are no doet worktrees here.\n');
    process.exitCode = 1;
    return;
  }

  const worktrees = await listVsWorktrees(repo.root);
  if (worktrees.length === 0) {
    process.stdout.write('No doet worktrees in this repository.\n');
    return;
  }

  if (action === 'list') {
    process.stdout.write(`doet worktrees in ${repo.root}:\n\n`);
    for (const worktree of worktrees) {
      const held = [
        worktree.dirty > 0 ? `${worktree.dirty} uncommitted` : '',
        worktree.ahead > 0 ? `${worktree.ahead} commit${worktree.ahead === 1 ? '' : 's'}` : '',
        worktree.exists ? '' : 'directory missing',
      ].filter(Boolean).join(' · ');
      process.stdout.write(`  ${worktree.branch}\n    ${worktree.path}\n    ${held || 'nothing to lose'}\n`);
    }
    process.stdout.write(
      '\nEach path above is already checked out on its branch — `cd` into it and work,\n' +
        'or open it in your editor. `git checkout` on one of these branches is refused,\n' +
        'because a branch cannot be checked out in two places at once.\n\n' +
        'Delete the ones holding nothing with `doet --worktrees prune`.\n' +
        'Add --force to delete the rest too. Branches go with their worktrees.\n',
    );
    return;
  }

  let removed = 0;
  const kept: string[] = [];
  for (const worktree of worktrees) {
    const outcome = await removeVsWorktree(repo.root, worktree, force);
    if (outcome.ok) {
      removed += 1;
      process.stdout.write(`  removed ${worktree.branch}\n`);
    } else {
      kept.push(`  kept ${worktree.branch} — ${outcome.message}`);
    }
  }

  if (kept.length > 0) process.stdout.write(`${kept.join('\n')}\n`);
  process.stdout.write(
    `\n${removed} removed, ${kept.length} kept.` +
      (kept.length > 0 && !force
        ? ' Re-run with --force to delete the rest, once you have taken what you want from them.\n'
        : '\n'),
  );
}

/**
 * Everything that happens in your terminal, before the layout exists.
 *
 * The checks are here rather than inside tmux for one reason: a failure that
 * prints into a pane you have not attached to yet is a failure nobody sees.
 */
async function launch(args: Args, config: DoetConfig): Promise<void> {
  const tmux = await tmuxAvailable();
  if (!tmux.ok) {
    throw new Error(
      'doet needs tmux, which is what gives each agent a real terminal of its own.\n' +
        '  macOS   brew install tmux\n' +
        '  Debian  sudo apt install tmux',
    );
  }

  // Inside tmux already, doet's client cannot attach to the session doet is
  // about to build — tmux refuses to nest — and the failure looks like the
  // layout dying rather than the attach being turned down.
  if (process.env.TMUX) {
    throw new Error(
      'doet is already inside a tmux session, and it needs to build one of its own.\n' +
        'Run it from a plain shell, or detach first with your prefix key then `d`.',
    );
  }

  const repo = await inspectRepo(args.cwd);
  if (!repo) throw new Error('doet must be started inside a git repository.');
  if (!repo.clean) {
    throw new Error(
      `doet needs a clean working tree to branch from. Commit or stash: ${repo.dirty.join(', ')}`,
    );
  }

  const mode = args.mode ?? (await chooseOne('How should the two agents work?', [
    {
      id: 'co-code',
      label: 'co-code',
      description: 'One shared conversation in this working tree: each agent checks and improves the other, in turn.',
    },
    {
      id: 'vs',
      label: 'vs',
      description: 'Same task, two isolated worktrees and branches. Build and test each result on its own, then pick one.',
    },
  ])) as DoetMode | null;
  if (!mode) return;

  /**
   * Which interface to draw.
   *
   * Asked only for co-code, because only co-code has a modern view to offer
   * yet. Answering it for VS and then quietly ignoring the answer would be
   * worse than not asking — see `driveVs`.
   *
   * The choice is remembered rather than asked fresh each run: it is a
   * preference about how you like to read a session, not a decision about this
   * particular question, and it starts on whatever you picked last.
   */
  let ui: UiMode = args.ui ?? config.ui;
  if (!args.ui && mode === 'co-code') {
    const chosen = await chooseOne('Which interface?', [
      {
        id: 'interactive',
        label: 'interactive',
        description: 'Both agents live on screen beside doet. You see everything as it happens, in a third of the width each.',
      },
      {
        id: 'modern',
        label: 'modern',
        description: 'doet takes the whole terminal and shows the shape of the conversation. Each agent is filed under its name, full width, one keypress away.',
      },
    ], config.ui === 'modern' ? 1 : 0) as UiMode | null;
    if (!chosen) return;
    ui = chosen;
    if (ui !== config.ui) saveConfig({ ...config, ui });
  }
  if (mode === 'vs' && ui === 'modern') {
    // Said plainly rather than silently downgraded. The plumbing is in place —
    // windows, navigation keys, the attention signal — and what is missing is
    // the view itself, which is a different shape for VS: two lanes racing,
    // not one conversation being handed back and forth.
    process.stdout.write(
      'The modern interface is co-code only for now, so this VS run uses the interactive one.\n',
    );
    ui = 'interactive';
  }

  /** The model each CLI runs, from config unless the command line overrode it. */
  const settingFor = (cli: CliId): { model: string; effort?: Effort } => {
    const setting = config.models[cli];
    const model = (cli === 'claude' ? args.claudeModel : args.codexModel) ?? setting.id;
    const effort = (cli === 'claude' ? args.claudeEffort : args.codexEffort) ?? setting.effort;
    return { model, ...(effort ? { effort } : {}) };
  };

  const slots = {} as RunPlan['slots'];
  if (mode === 'vs') {
    for (const slot of SLOT_IDS) {
      const cli = await chooseOne(`Which CLI runs in slot ${slot.toUpperCase()}?`, [
        { id: 'claude', label: AGENT_LABELS.claude, description: 'A real Claude Code session in its own pane.' },
        { id: 'codex', label: AGENT_LABELS.codex, description: 'A real Codex session in its own pane.' },
      ], slot === 'a' ? 0 : 1);
      if (!cli) return;
      slots[slot] = { cli: cli as CliId, ...settingFor(cli as CliId) };
    }
  } else {
    // co-code is always both of them — that is what it is for.
    slots.a = { cli: 'claude', ...settingFor('claude') };
    slots.b = { cli: 'codex', ...settingFor('codex') };
  }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) +
    '-' + randomUUID().slice(0, 8);
  const plan: RunPlan = {
    mode,
    ui,
    rounds: args.rounds ?? DEFAULT_DEBATE.maxRounds,
    agents: { claude: settingFor('claude'), codex: settingFor('codex') },
    socket: `doet-${sessionId}`,
    root: repo.root,
    mainRoot: repo.mainRoot,
    gitCommonDir: repo.gitCommonDir,
    head: repo.head,
    sessionId,
    slots,
  };

  const planPath = join(DOET_HOME, 'runs', `${sessionId}.json`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  // doet's own pane is the first one, and it is this same binary re-entered
  // with the plan. Everything else — the worktrees, the agents, their panes —
  // is built by that copy, from inside the layout it is going to live in.
  const { session, pane } = await TmuxSession.create({
    id: sessionId,
    width: process.stdout.columns ?? 200,
    height: process.stdout.rows ?? 50,
    first: {
      title: 'doet',
      cwd: repo.root,
      ...reenter(['--drive', planPath]),
    },
  });

  // Before the terminal is handed over: is the layout actually standing?
  //
  // Attaching to a session that has already collapsed is how doet loses the
  // only account of why. The client draws nothing, prints "[server exited
  // unexpectedly]", and the pane that could have said what went wrong is gone
  // with the server that held it. A moment's wait catches exactly the failure
  // that hides itself — a first pane that dies on startup — while a healthy
  // one is still busy cutting worktrees and has not drawn anything yet either.
  await delay(600);
  const first = reenter(['--drive', planPath]);
  const standing = await checkLayout(session, pane, first);
  if (standing) {
    await session.kill().catch(() => {});
    process.stderr.write(`${standing}\n`);
    process.exitCode = 1;
    return;
  }

  const attach = session.attachCommand();
  /**
   * How the client that shows the layout ended.
   *
   * The exit status used to be dropped on the floor here, and that turned out
   * to be the difference between a diagnosable failure and a baffling one: a
   * client that died on startup left doet to finish the happy path and print
   * "Session saved", so a run that never appeared reported success. Whatever
   * else is true, doet must not claim a session went fine because it did not
   * look.
   */
  const client = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn(attach.command, attach.args, { stdio: 'inherit' });
    child.on('error', (error) => resolve({ code: null, error: error.message }));
    child.on('close', (code) => resolve({ code }));
  });

  // And the same question again on the way out, because a session can also die
  // while you are watching it. Read before the server is killed: killing it
  // takes the pane's scrollback with it.
  const ended = await checkLayout(session, pane, first);
  const clientFailed = client.error !== undefined || (client.code !== null && client.code !== 0);
  // Read while there is still something to read, for the same reason.
  const showing = clientFailed && !ended ? (await session.capture(pane, 60)).trim() : '';

  if (ended) {
    await session.kill().catch(() => {});
    process.stderr.write(`${ended}\n`);
    process.exitCode = 1;
    return;
  }

  if (clientFailed) {
    // Deliberately *not* killed. The layout is still standing and the thing
    // that failed is the window onto it, so the most useful thing doet can do
    // is get out of the way and let the same attach be run by hand, where tmux
    // prints its own reason to the terminal instead of into a torn-down pane.
    const run = [attach.command, ...attach.args].map(quoteForShell).join(' ');
    process.stderr.write(
      `doet built the layout, but the tmux client that displays it stopped immediately ` +
        `(${client.error ?? `exit status ${client.code}`}).\n\n` +
        'The session itself was still standing when doet checked, so this is the client ' +
        'failing in this terminal rather than the run failing.\n\n' +
        (showing ? `doet's own pane was showing:\n\n${showing}\n\n` : '') +
        'The session has been left running so you can attach to it yourself — tmux will\n' +
        'print its reason straight to this terminal:\n\n' +
        `  ${run}\n\n` +
        'When you are done with it:\n\n' +
        `  tmux -L ${session.socket} kill-server\n`,
    );
    process.exitCode = 1;
    return;
  }

  await session.kill().catch(() => {});
  process.stdout.write(
    `Session saved in ${join(DOET_HOME, 'sessions', sessionId)}\n` +
      'Branches and worktrees are kept — `doet --worktrees` lists them.\n',
  );
}

/**
 * What went wrong with the layout, or empty if nothing did.
 *
 * The two failures are told apart on purpose, because they have nothing to do
 * with each other. A dead *pane* is doet's own program failing, and its output
 * is still there to be read. A dead *server* is the session itself gone —
 * nothing left to ask, so the answer has to be the next thing to try rather
 * than a message doet cannot produce.
 */
async function checkLayout(
  session: TmuxSession,
  pane: string,
  first: { command: string; args: string[] },
): Promise<string> {
  // The command doet puts in its own pane, written so it can be pasted. When
  // the session is gone this is the only way left to see what that program
  // says, and it says it straight to the terminal instead of into a pane
  // nobody can read.
  const run = [first.command, ...first.args].map(quoteForShell).join(' ');

  if (!(await session.alive())) {
    // The session is gone and with it any account of why, so doet asks the only
    // question still worth asking: can tmux hold a session in this terminal at
    // all? One trivial session, five seconds long, nothing to do with doet.
    // Whichever way it goes, the next thing to try is different, and guessing
    // between the two is what wastes an afternoon.
    const held = await tmuxHoldsASession();
    return held
      ? `doet's tmux session ended before it could be shown.\n\n` +
        'tmux held a plain test session in this terminal, so tmux is fine here and it\n' +
        "is doet's own pane program that is stopping. Run it directly — it prints the\n" +
        'error to this terminal rather than into a pane that is being torn down:\n\n' +
        `  ${run}\n`
      : `doet's tmux session ended before it could be shown.\n\n` +
        'A plain `tmux new-session -d sleep 5` did not survive here either, so this is\n' +
        'tmux failing in this terminal rather than anything doet ran. Try a standalone\n' +
        'terminal (Terminal.app, iTerm, Ghostty) rather than an editor or app terminal,\n' +
        'and check `tmux -V`, `echo $TMUX` and `echo $TMPDIR`.\n';
  }
  if (await session.paneAlive(pane)) return '';
  const output = (await session.capture(pane, 80)).trim();
  return (
    `doet's own pane stopped:\n\n${output || '(the pane exited without printing anything)'}\n\n` +
    `Reproduce it directly with:\n\n  ${run}`
  );
}

/** Whether tmux can keep any session at all alive here, doet aside. */
async function tmuxHoldsASession(): Promise<boolean> {
  const socket = `doet-probe-${process.pid}`;
  try {
    const created = await tmux(socket, ['new-session', '-d', '-s', 'probe', 'sleep', '5']);
    if (!created.ok) return false;
    await delay(500);
    return (await tmux(socket, ['has-session', '-t', 'probe'])).ok;
  } finally {
    await tmux(socket, ['kill-server']).catch(() => {});
  }
}

/** Good enough to paste back into a shell, which is all this is for. */
function quoteForShell(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Everything that happens inside the layout.
 *
 * Runs as tmux pane 0. It cuts the worktrees, starts an agent in a pane of its
 * own for each slot, and then renders doet's own small pane beside them.
 */
async function drive(planPath: string, config: DoetConfig): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RunPlan;
  if (plan.mode === 'co-code') {
    await driveCoCode(plan, config);
    return;
  }
  await driveVs(plan, config);
}

/**
 * co-code, inside the layout.
 *
 * No worktrees: both agents work in the repository you started doet in, which
 * is the whole point — they are collaborating on one tree rather than being
 * compared on two. They take turns, so there is never a moment when both are
 * editing it.
 */
async function driveCoCode(plan: RunPlan, config: DoetConfig): Promise<void> {
  const session = TmuxSession.open(plan.socket);
  const store = new SessionStore(plan.sessionId, plan.sessionId);
  const bus = new Bus();
  store.attach(bus);

  const agents = {} as Record<AgentId, AgentAdapter>;
  const failures: string[] = [];
  for (const id of AGENT_IDS) {
    const { model, effort } = plan.agents[id];
    const adapter = new TmuxAgent({
      bus,
      cli: id,
      session,
      // Under the modern layout the way back is written into the border, which
      // is the only part of doet still visible once you are inside an agent.
      // Putting it in doet's own notice line instead — as it was — announced
      // the escape route in the one place you can no longer read it.
      title: `${AGENT_LABELS[id]}${model ? ` · ${model}` : ''}${effort ? ` · ${effort}` : ''}${
        plan.ui === 'modern' ? '  —  F12 back to doet' : ''
      }`,
      cwd: plan.root,
      model,
      effort,
      instructions: coCodeInstructions(id, id === 'claude' ? 'codex' : 'claude', plan.rounds),
      // Claude left, doet centre, Codex right — so a relay is a message
      // travelling across the screen rather than an event in a log. Means
      // nothing under the modern layout, where each agent has a window to
      // itself and there is no left or right to be on.
      before: id === 'claude',
      placement: plan.ui === 'modern' ? 'window' : 'split',
      // Both agents edit the tree you are sitting in, so nothing is
      // auto-accepted here — every change stops and asks, in that agent's pane.
      permissionMode: config.claude.permissionMode,
      approvalPolicy: config.codex.approvalPolicy,
      sandbox: config.codex.sandbox,
    });
    try {
      await adapter.start();
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    agents[id] = adapter;
  }
  if (failures.length > 0) throw new Error(`Could not start both agents:\n${failures.join('\n')}`);

  if (plan.ui === 'modern') {
    // The way back, and the way in. Once you are looking at an agent, doet is
    // not the program being typed at any more — only tmux is still listening,
    // so only tmux can offer you a key. Bound from the windows the agents
    // actually landed in rather than from the order they were started.
    // Function keys are the ones doet advertises, and Alt is bound alongside
    // them rather than instead of them. On a stock macOS terminal Option is not
    // Meta — it types an accented character — so `alt+1` silently does nothing
    // until the user turns that on, and the one key doet promises has to work
    // before it is configured. F12 rather than F0 for doet, there being no F0.
    await session.bindNavigation([
      { key: 'F12', window: 0 },
      { key: 'M-0', window: 0 },
      ...AGENT_IDS.flatMap((id) => {
        const window = agents[id].info().window;
        return window === undefined
          ? []
          : [{ key: `F${window}`, window }, { key: `M-${window}`, window }];
      }),
    ]);
  } else {
    // Only means anything when all three share one window.
    await session.tile();
  }

  const conductor = new Conductor({
    bus,
    agents,
    store,
    config: { maxRounds: plan.rounds },
  });

  const onUnhandled = (reason: unknown) => {
    bus.log('doet', reason instanceof Error ? reason.message : String(reason), 'error');
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);

  const app = render(
    plan.ui === 'modern' ? (
      <Modern
        bus={bus}
        conductor={conductor}
        agents={agents}
        store={store}
        session={session}
        defaultRounds={plan.rounds}
      />
    ) : (
      <CoCode
        bus={bus}
        conductor={conductor}
        agents={agents}
        store={store}
        defaultRounds={plan.rounds}
      />
    ),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();

  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUnhandled);
  await Promise.all(AGENT_IDS.map((id) => agents[id].dispose().catch(() => {})));
}

async function driveVs(plan: RunPlan, config: DoetConfig): Promise<void> {
  const session = TmuxSession.open(plan.socket);
  const store = new SessionStore(plan.sessionId, plan.sessionId);

  const worktreeBase = join(plan.mainRoot, '.doet', 'worktrees', plan.sessionId);
  await excludeLocally(plan.gitCommonDir, '/.doet/');

  const worktrees: Partial<Record<SlotId, Awaited<ReturnType<typeof addWorktree>>>> = {};
  const discard = async (): Promise<void> => {
    await Promise.all(SLOT_IDS.map(async (slot) => {
      const worktree = worktrees[slot];
      if (!worktree) return;
      await removeWorktree(plan.root, worktree.path, true);
      await deleteBranch(plan.root, worktree.branch, true);
    }));
  };

  try {
    for (const slot of SLOT_IDS) {
      const path = join(worktreeBase, slot);
      mkdirSync(dirname(path), { recursive: true });
      worktrees[slot] = await addWorktree(
        plan.root,
        path,
        vsBranchName(plan.sessionId, slot, plan.slots[slot].cli),
        plan.head,
      );
    }
  } catch (error) {
    await discard();
    throw error;
  }

  const buses = { a: new Bus(), b: new Bus() } satisfies Record<SlotId, Bus>;
  for (const slot of SLOT_IDS) store.attachVs(slot, buses[slot]);

  const sides = {} as Record<SlotId, VsSide>;
  const failures: string[] = [];
  for (const slot of SLOT_IDS) {
    const { cli, model, effort } = plan.slots[slot];
    const worktree = worktrees[slot]!;
    const adapter = new TmuxAgent({
      bus: buses[slot],
      cli,
      session,
      title: `${slot.toUpperCase()} · ${AGENT_LABELS[cli]}${model ? ` · ${model}` : ''}${effort ? ` · ${effort}` : ''}`,
      cwd: worktree.path,
      model,
      effort,
      // A linked worktree's refs and objects live in the main repository's git
      // directory, so without this the agent cannot commit its own work.
      addDirs: [plan.gitCommonDir],
      instructions: vsInstructions(slot),
      before: slot === 'a',
      // Edits land in a worktree of their own, so approving each one adds
      // nothing; anything with teeth still stops and asks, in that agent's pane.
      permissionMode: 'acceptEdits',
      approvalPolicy: config.codex.approvalPolicy,
      sandbox: config.codex.sandbox,
    });
    try {
      await adapter.start();
    } catch (error) {
      failures.push(`slot ${slot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    sides[slot] = { slot, cli, adapter, worktree };
  }

  if (failures.length > 0) {
    await discard();
    throw new Error(`Could not start both agents:\n${failures.join('\n')}`);
  }
  await session.tile();

  store.writeVsMeta({
    cwd: plan.root,
    query: '',
    base: plan.head,
    slots: {
      a: { cli: sides.a.cli, model: plan.slots.a.model, effort: plan.slots.a.effort, branch: sides.a.worktree.branch, worktree: sides.a.worktree.path },
      b: { cli: sides.b.cli, model: plan.slots.b.model, effort: plan.slots.b.effort, branch: sides.b.worktree.branch, worktree: sides.b.worktree.path },
    },
  });

  const runner = new VsRunner({ sides, store, root: plan.root, pricing: config.pricing });

  const onUnhandled = (reason: unknown) => {
    buses.a.log('doet', reason instanceof Error ? reason.message : String(reason), 'error');
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);

  const app = render(
    <Control
      buses={buses}
      sides={sides}
      runner={runner}
      store={store}
      session={session}
      root={plan.root}
      pricing={config.pricing}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();

  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUnhandled);
  await Promise.all(SLOT_IDS.map((slot) => sides[slot].adapter.dispose().catch(() => {})));
}

main().catch((error: unknown) => {
  const detail = error instanceof Error
    ? /^-{1,2}[A-Za-z]/.test(error.message)
      ? error.message
      : (error.stack ?? error.message)
    : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
