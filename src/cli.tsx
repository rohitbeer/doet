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
import { available, cliFor } from './core/agents/registry.js';
import {
  CLI_IDS,
  EFFORTS,
  MAX_SLOTS,
  slotIds,
  type AgentAdapter,
  type CliId,
  type Effort,
  type SlotId,
  type UiMode,
} from './core/types.js';
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
interface SlotPlan {
  cli: CliId;
  model: string;
  effort?: Effort;
  provider?: string;
}

interface RunPlan {
  mode: DoetMode;
  /** Which interface to draw, and so whether the agents share doet's window. */
  ui: UiMode;
  socket: string;
  root: string;
  mainRoot: string;
  gitCommonDir: string;
  /**
   * The commit every worktree is cut from — the tip of the branch you were on
   * when you started doet. Every agent begins from exactly what you had.
   */
  head: string;
  /** The branch that commit belongs to, for saying so on screen. */
  branch: string | null;
  sessionId: string;
  rounds: number;
  /**
   * The agents, in the order they were chosen.
   *
   * Both modes use this now. co-code always holds two; VS holds between two and
   * `MAX_SLOTS`, each with a worktree of its own.
   */
  order: SlotId[];
  slots: Record<SlotId, SlotPlan>;
}

type DoetMode = 'co-code' | 'vs';

interface Args {
  cwd: string;
  /**
   * Per-CLI overrides, as `--model claude=opus`.
   *
   * This replaced `--claude-model`/`--codex-model` and the two matching effort
   * flags when the third and fourth agents arrived: four CLIs times three
   * settings is twelve flags to write, document and keep in step, and the next
   * agent would have made it fifteen. One flag that names the CLI it is talking
   * about does not grow.
   */
  models: Partial<Record<CliId, string>>;
  efforts: Partial<Record<CliId, Effort>>;
  providers: Partial<Record<CliId, string>>;
  mode?: DoetMode;
  ui?: UiMode;
  rounds?: number;
  /** How many isolated agents a VS run starts. */
  agents?: number;
  worktrees?: 'list' | 'prune';
  force?: boolean;
  /** Internal: the plan to drive, when doet is re-entering inside tmux. */
  drive?: string;
}

/** `claude=opus` → which CLI, and what to set. Rejects a name doet cannot run. */
function splitAssignment(flag: string, value: string): { cli: CliId; value: string } {
  const at = value.indexOf('=');
  if (at < 0) {
    throw new Error(`${flag} takes <cli>=<value>, for example ${flag} claude=opus.`);
  }
  const cli = value.slice(0, at).trim();
  if (!(CLI_IDS as string[]).includes(cli)) {
    throw new Error(`${flag}: doet does not run "${cli}". Choose from ${CLI_IDS.join(', ')}.`);
  }
  return { cli: cli as CliId, value: value.slice(at + 1).trim() };
}

function asEffort(value: string | undefined): Effort | undefined {
  return value && (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : undefined;
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
  const args: Args = { cwd: process.cwd(), models: {}, efforts: {}, providers: {} };
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
      case '--model': {
        const assignment = splitAssignment(flag, required());
        args.models[assignment.cli] = assignment.value;
        took();
        break;
      }
      case '--effort': {
        const assignment = splitAssignment(flag, required());
        const effort = asEffort(assignment.value);
        if (!effort) {
          throw new Error(`--effort: "${assignment.value}" is not one of ${EFFORTS.join(', ')}.`);
        }
        const allowed = cliFor(assignment.cli).supports.efforts;
        if (!allowed) {
          throw new Error(
            `--effort: ${cliFor(assignment.cli).label} has no reasoning-effort dial — it chooses per model.`,
          );
        }
        if (!allowed.includes(effort)) {
          throw new Error(
            `--effort: ${cliFor(assignment.cli).label} does not take "${effort}". Choose from ${allowed.join(', ')}.`,
          );
        }
        args.efforts[assignment.cli] = effort;
        took();
        break;
      }
      case '--provider': {
        const assignment = splitAssignment(flag, required());
        args.providers[assignment.cli] = assignment.value;
        took();
        break;
      }
      case '--agents': {
        const n = Number(required());
        if (!Number.isInteger(n) || n < 1 || n > MAX_SLOTS) {
          throw new Error(`--agents must be a whole number from 1 to ${MAX_SLOTS}.`);
        }
        args.agents = n;
        took();
        break;
      }
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
  process.stdout.write(`doet — run several coding agents on the same task and compare them.

doet gives each agent its own git worktree, cut from the branch you are on, and
its own window running that agent's real CLI. You watch them work in the
interface each one already has. doet keeps the score, records the transcripts,
and can fold any one result back into your working tree when you have picked it.

Agents
  ${CLI_IDS.map((id) => {
    const definition = cliFor(id);
    const traits = [
      definition.supports.efforts ? 'effort' : '',
      definition.supports.provider ? 'byok' : '',
      definition.supports.fork ? 'forkable' : '',
    ].filter(Boolean).join(', ');
    return `${id.padEnd(8)} ${definition.label.padEnd(13)} ${traits}`;
  }).join('\n  ')}

Usage
  doet [options]

Options
  -C, --cwd <dir>          Repository to work in (default: cwd)
      --agents <n>         How many isolated agents in vs mode (1–${MAX_SLOTS})
      --ui <which>         interactive (agents on screen) or modern (agents
                           filed under their names, one keypress away)
      --model <cli>=<m>    Model for one CLI, e.g. --model claude=opus
      --effort <cli>=<e>   Reasoning effort, where that CLI has the dial:
                           ${EFFORTS.join('|')}
      --provider <cli>=<p> Whose credentials to bill, for the CLIs that route
                           to many vendors (cline, kilo)
      --rounds <n>         Exchanges in co-code mode
      --worktrees          List the branches and worktrees past runs left here
      --worktrees prune    Delete the ones holding no work (--force: all)
  -h, --help               This text
  -v, --version            Print the version and exit

Environment
  DOET_HOME                Where doet keeps config and sessions (default: ~/.doet)

In a vs run
  type + enter             Send the request to every agent
  ↑ ↓                      Move between agents
  enter (empty composer)   Open the selected agent's window and watch it work
  w                        Open its worktree with its session forked, so you
                           can carry on from where it got to without
                           disturbing the run
  tab                      Address the selected agent alone
  p                        Fold its branch into your main tree
  esc                      Stop the current turn (or clear the address)
  F1–F9 / F12              Jump to an agent's window, or back to doet
  ctrl+c                   Quit; branches and worktrees are kept

  Each agent is a real CLI in its own window. Approve its tools, scroll its
  output and type into it directly — doet does not stand in the way.

Requires tmux, and the CLIs you select on PATH and logged in.
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
 * Everything one agent needs, asked in the order the answers depend on.
 *
 * The chain is not decoration. A model id means nothing until you know which
 * program is being told about it, and for the CLIs that route to many vendors
 * it means nothing until you know whose credentials are paying — kilo lists 288
 * models across a dozen providers, and picking from that flat is not a choice,
 * it is a search. So: which CLI, then whose account, then which model, then how
 * hard it should think.
 *
 * Every step after the first is skipped when the CLI has nothing to say about
 * it. Claude and Codex have one provider and publish no model list, so choosing
 * one of them asks nothing further and takes the model from your config, exactly
 * as it did before this ticket. kilo has no reasoning dial, so it is never asked
 * for one. A question doet cannot honour is a question it does not ask.
 */
async function pickSlot(
  slot: SlotId,
  total: number,
  mode: DoetMode,
  args: Args,
  config: DoetConfig,
): Promise<SlotPlan | null> {
  const where = mode === 'vs'
    ? `slot ${slot.toUpperCase()} of ${total}`
    : `${slot === 'a' ? 'the first' : 'the second'} agent`;

  const cli = await chooseOne(
    `Which CLI runs ${where}?`,
    CLI_IDS.map((id) => {
      const definition = cliFor(id);
      const traits = [
        definition.supports.efforts ? 'effort dial' : '',
        definition.supports.provider ? 'bring your own key' : '',
        definition.supports.fork ? 'forkable session' : '',
      ].filter(Boolean);
      return {
        id,
        label: definition.label,
        description: `A real ${definition.label} session in its own window${traits.length ? ` · ${traits.join(' · ')}` : ''}`,
      };
    }),
    // Different CLIs on the first two slots by default, since a comparison
    // between two of the same is the rarer thing to want — but it is allowed,
    // and picking the same one twice is a supported answer rather than an
    // accident doet has to guard against.
    Math.min(CLI_IDS.length - 1, slot.charCodeAt(0) - 'a'.charCodeAt(0)),
  ) as CliId | null;
  if (!cli) return null;

  const definition = cliFor(cli);
  const setting = config.models[cli];
  const plan: SlotPlan = {
    cli,
    model: args.models[cli] ?? setting.id,
    ...(args.efforts[cli] ?? setting.effort ? { effort: args.efforts[cli] ?? setting.effort } : {}),
    ...(args.providers[cli] ?? setting.provider ? { provider: args.providers[cli] ?? setting.provider } : {}),
  };

  if (definition.supports.provider && !args.providers[cli]) {
    const providers = await definition.providers();
    if (providers.length > 0) {
      const chosen = await chooseOne(
        `Which provider pays for ${definition.label} in ${where}?`,
        providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          description: provider.description ?? '',
          badge: provider.id === plan.provider ? 'last used' : '',
        })),
        Math.max(0, providers.findIndex((provider) => provider.id === plan.provider)),
      );
      if (!chosen) return null;
      plan.provider = chosen;
    }
  }

  if (!args.models[cli]) {
    const models = await definition.models(plan.provider);
    if (models.length > 0) {
      const chosen = await chooseOne(
        `Which model for ${definition.label} in ${where}?`,
        models.map((model) => ({
          id: model.id,
          label: model.label,
          description: model.description ?? '',
          badge: model.id === plan.model ? 'last used' : '',
        })),
        Math.max(0, models.findIndex((model) => model.id === plan.model)),
      );
      if (!chosen) return null;
      plan.model = chosen;
    }
  }

  const efforts = definition.supports.efforts;
  if (efforts && efforts.length > 0 && !args.efforts[cli]) {
    const chosen = await chooseOne(
      `How hard should ${definition.label} think in ${where}?`,
      efforts.map((effort) => ({
        id: effort,
        label: effort,
        description: effort === 'none'
          ? "Leave the provider's own default alone."
          : `Reasoning effort: ${effort}.`,
        badge: effort === plan.effort ? 'last used' : '',
      })),
      Math.max(0, efforts.indexOf(plan.effort ?? 'medium')),
    ) as Effort | null;
    if (!chosen) return null;
    plan.effort = chosen;
  } else if (!efforts) {
    // kilo picks effort per model, so carrying one over from another CLI's
    // setting would put a flag on the command line that does not exist.
    delete plan.effort;
  }

  return plan;
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
  if (!args.ui) {
    const chosen = await chooseOne('Which interface?', [
      {
        id: 'interactive',
        label: 'interactive',
        description: 'Every agent live on screen beside doet. You see everything as it happens, in a fraction of the width each.',
      },
      {
        id: 'modern',
        label: 'modern',
        description: 'doet takes the whole terminal and shows the shape of the run. Each agent is filed under its name, full width, one keypress away.',
      },
    ], config.ui === 'modern' ? 1 : 0) as UiMode | null;
    if (!chosen) return;
    ui = chosen;
    if (ui !== config.ui) saveConfig({ ...config, ui });
  }

  /**
   * How many isolated agents to run.
   *
   * VS only. co-code is a conversation between two and does not scale — they
   * share one working tree and take turns, so a third would have nowhere to
   * stand. See the `Conductor` constructor.
   */
  let count = 2;
  if (mode === 'vs') {
    const chosen = args.agents ?? Number(await chooseOne(
      'How many agents?',
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        id: String(n),
        label: `${n} agents`,
        description: n === 2
          ? 'A straight comparison. Both on screen in one glance.'
          : n <= 4
            ? `${n} takes on the same request, ${n} branches to read.`
            : `${n} at once. Thorough, and ${n} times the tokens per request.`,
        badge: n === config.vsAgents ? 'last used' : '',
      })),
      Math.max(0, [2, 3, 4, 5, 6, 7, 8, 9].indexOf(config.vsAgents)),
    ) ?? '');
    if (!Number.isInteger(chosen) || chosen < 1) return;
    count = chosen;
    if (count !== config.vsAgents) saveConfig({ ...config, vsAgents: count });
  }

  if (mode === 'vs' && count > 2 && ui === 'interactive') {
    // Said plainly rather than silently downgraded, and not a matter of taste:
    // three agents plus doet tiled across a 200-column terminal is fifty
    // columns each, and five is thirty-three. A coding agent rendering itself
    // into thirty-three columns is a column of broken words. Past two, the
    // dashboard is the only layout that fits.
    process.stdout.write(
      `${count} agents will not fit side by side, so this run uses the dashboard.\n` +
        'Each agent gets a window of its own at full width; F1–F9 open them, F12 comes back.\n',
    );
    ui = 'modern';
  }

  const order = slotIds(count);
  const slots = {} as RunPlan['slots'];

  for (const slot of order) {
    const chosen = await pickSlot(slot, order.length, mode, args, config);
    if (!chosen) return;
    slots[slot] = chosen;
  }

  // Asked before the layout is built, because a missing binary that only
  // surfaces as a pane dying during startup costs the user a whole layout and
  // an error in a window they have not attached to yet.
  const missing: string[] = [];
  for (const cli of new Set(order.map((slot) => slots[slot]!.cli))) {
    const check = await available(cli);
    if (!check.ok && check.error) missing.push(check.error);
  }
  if (missing.length > 0) {
    throw new Error(missing.join('\n'));
  }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) +
    '-' + randomUUID().slice(0, 8);
  const plan: RunPlan = {
    mode,
    ui,
    rounds: args.rounds ?? DEFAULT_DEBATE.maxRounds,
    socket: `doet-${sessionId}`,
    root: repo.root,
    mainRoot: repo.mainRoot,
    gitCommonDir: repo.gitCommonDir,
    head: repo.head,
    branch: repo.branch,
    sessionId,
    order,
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
async function driveCoCode(plan: RunPlan, _config: DoetConfig): Promise<void> {
  const session = TmuxSession.open(plan.socket);
  const store = new SessionStore(plan.sessionId, plan.sessionId);
  const bus = new Bus();
  store.attach(bus);

  const agents = {} as Record<SlotId, AgentAdapter>;
  const failures: string[] = [];
  /**
   * What each side is called, worked out before any of them start.
   *
   * co-code can now be Claude against Claude, and two participants with the
   * same name is worse than a prefix on both — so the slot is added exactly
   * when it has to be. The conductor computes the same thing at runtime; this
   * is the launch-time copy, needed to write each agent's brief before there is
   * a conductor to ask.
   */
  const labelFor = (slot: SlotId): string => {
    const cli = plan.slots[slot]!.cli;
    const shared = plan.order.some((other) => other !== slot && plan.slots[other]!.cli === cli);
    return shared ? `${slot.toUpperCase()} · ${cliFor(cli).label}` : cliFor(cli).label;
  };

  for (const [index, slot] of plan.order.entries()) {
    const { cli, model, effort, provider } = plan.slots[slot]!;
    const other = plan.order.find((candidate) => candidate !== slot) ?? slot;
    const adapter = new TmuxAgent({
      bus,
      slot,
      cli,
      session,
      // Under the modern layout the way back is written into the border, which
      // is the only part of doet still visible once you are inside an agent.
      // Putting it in doet's own notice line instead — as it was — announced
      // the escape route in the one place you can no longer read it.
      title: `${labelFor(slot)}${model ? ` · ${model}` : ''}${effort ? ` · ${effort}` : ''}${
        plan.ui === 'modern' ? '  —  F12 back to doet' : ''
      }`,
      cwd: plan.root,
      model,
      ...(effort ? { effort } : {}),
      ...(provider ? { provider } : {}),
      instructions: coCodeInstructions(labelFor(slot), labelFor(other), plan.rounds),
      // First agent left, doet centre, second right — so a relay is a message
      // travelling across the screen rather than an event in a log. Means
      // nothing under the modern layout, where each agent has a window to
      // itself and there is no left or right to be on.
      before: index === 0,
      placement: plan.ui === 'modern' ? 'window' : 'split',
      // Both agents edit the tree you are sitting in, so nothing is
      // auto-accepted here — every change stops and asks, in that agent's pane.
      autonomy: 'ask',
    });
    try {
      await adapter.start();
    } catch (error) {
      failures.push(`${slot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    agents[slot] = adapter;
  }
  if (failures.length > 0) throw new Error(`Could not start both agents:\n${failures.join('\n')}`);

  store.writeMeta({
    cwd: plan.root,
    query: '',
    order: plan.order,
    slots: Object.fromEntries(plan.order.map((slot) => {
      const { cli, model, effort, provider } = plan.slots[slot]!;
      return [slot, {
        cli,
        model,
        ...(effort ? { effort } : {}),
        ...(provider ? { provider } : {}),
      }];
    })),
  });

  if (plan.ui === 'modern') {
    await bindWindows(session, plan.order.map((slot) => agents[slot]!.info().window));
  } else {
    // Only means anything when all three share one window.
    await session.tile();
  }

  const conductor = new Conductor({
    bus,
    agents,
    order: plan.order,
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
        order={plan.order}
        store={store}
        session={session}
        defaultRounds={plan.rounds}
      />
    ) : (
      <CoCode
        bus={bus}
        conductor={conductor}
        agents={agents}
        order={plan.order}
        store={store}
        defaultRounds={plan.rounds}
      />
    ),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();

  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUnhandled);
  await Promise.all(plan.order.map((slot) => agents[slot]!.dispose().catch(() => {})));
}

/**
 * The keys that move between windows, bound from where the agents actually
 * landed rather than from the order they were started.
 *
 * Once you are looking at an agent, doet is not the program being typed at any
 * more — only tmux is still listening, so only tmux can offer you a way back.
 * Function keys are the ones doet advertises, and Alt is bound alongside them
 * rather than instead of them: on a stock macOS terminal Option is not Meta, it
 * types an accented character, so `alt+1` silently does nothing until the user
 * turns that on, and the one key doet promises has to work before it is
 * configured. F12 rather than F0 for doet, there being no F0.
 *
 * Nine agents is the cap for exactly this reason — see `MAX_SLOTS`.
 */
async function bindWindows(
  session: TmuxSession,
  windows: Array<number | undefined>,
): Promise<void> {
  await session.bindNavigation([
    { key: 'F12', window: 0 },
    { key: 'M-0', window: 0 },
    ...windows.flatMap((window) =>
      window === undefined || window < 1 || window > 9
        ? []
        : [{ key: `F${window}`, window }, { key: `M-${window}`, window }]),
  ]);
}

async function driveVs(plan: RunPlan, config: DoetConfig): Promise<void> {
  const session = TmuxSession.open(plan.socket);
  const store = new SessionStore(plan.sessionId, plan.sessionId);

  const worktreeBase = join(plan.mainRoot, '.doet', 'worktrees', plan.sessionId);
  await excludeLocally(plan.gitCommonDir, '/.doet/');

  const worktrees: Partial<Record<SlotId, Awaited<ReturnType<typeof addWorktree>>>> = {};
  const discard = async (): Promise<void> => {
    await Promise.all(plan.order.map(async (slot) => {
      const worktree = worktrees[slot];
      if (!worktree) return;
      await removeWorktree(plan.root, worktree.path, true);
      await deleteBranch(plan.root, worktree.branch, true);
    }));
  };

  try {
    for (const slot of plan.order) {
      const path = join(worktreeBase, slot);
      mkdirSync(dirname(path), { recursive: true });
      // Every worktree is cut from `plan.head` — the tip of the branch you were
      // on when you started doet. That is what makes the comparison fair: each
      // agent begins from exactly what you had, and none of them can see any
      // other's work.
      worktrees[slot] = await addWorktree(
        plan.root,
        path,
        vsBranchName(plan.sessionId, slot, plan.slots[slot]!.cli),
        plan.head,
      );
    }
  } catch (error) {
    await discard();
    throw error;
  }

  const buses = Object.fromEntries(
    plan.order.map((slot) => [slot, new Bus()]),
  ) as Record<SlotId, Bus>;
  for (const slot of plan.order) store.attachVs(slot, buses[slot]!);

  const sides = {} as Record<SlotId, VsSide>;
  const failures: string[] = [];
  const notes: string[] = [];
  for (const [index, slot] of plan.order.entries()) {
    const { cli, model, effort, provider } = plan.slots[slot]!;
    const definition = cliFor(cli);
    const worktree = worktrees[slot]!;

    // A linked worktree's refs and objects live in the main repository's git
    // directory. Claude and Codex can be granted it on the command line; cline
    // and kilo have no such flag, and neither sandboxes the filesystem, so they
    // reach it anyway. Said out loud rather than assumed, because if one of them
    // ever does start sandboxing, the symptom is a slot that cannot commit and
    // this note is the first place to look.
    if (!definition.supports.addDirs) {
      notes.push(
        `${definition.label} takes no --add-dir, so slot ${slot.toUpperCase()} reaches the shared git directory unsandboxed.`,
      );
    }

    const adapter = new TmuxAgent({
      bus: buses[slot]!,
      slot,
      cli,
      session,
      title: `${slot.toUpperCase()} · ${definition.label}${model ? ` · ${model}` : ''}${effort ? ` · ${effort}` : ''}${
        plan.ui === 'modern' ? '  —  F12 back to doet' : ''
      }`,
      cwd: worktree.path,
      model,
      ...(effort ? { effort } : {}),
      ...(provider ? { provider } : {}),
      addDirs: [plan.gitCommonDir],
      instructions: vsInstructions(slot, plan.order.length),
      before: index === 0,
      placement: plan.ui === 'modern' ? 'window' : 'split',
      // Edits land in a worktree of their own, so approving each one adds
      // nothing; anything with teeth still stops and asks, in that agent's pane.
      autonomy: 'accept-edits',
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
    throw new Error(
      `Could not start ${failures.length === plan.order.length ? 'the agents' : 'every agent'}:\n${failures.join('\n')}`,
    );
  }

  if (plan.ui === 'modern') {
    await bindWindows(session, plan.order.map((slot) => sides[slot]!.adapter.info().window));
  } else {
    await session.tile();
  }

  store.writeVsMeta({
    cwd: plan.root,
    query: '',
    base: plan.head,
    order: plan.order,
    slots: Object.fromEntries(plan.order.map((slot) => {
      const { cli, model, effort, provider } = plan.slots[slot]!;
      const side = sides[slot]!;
      return [slot, {
        cli,
        model,
        ...(effort ? { effort } : {}),
        ...(provider ? { provider } : {}),
        branch: side.worktree.branch,
        worktree: side.worktree.path,
      }];
    })),
  });

  const runner = new VsRunner({
    sides,
    order: plan.order,
    store,
    root: plan.root,
    pricing: config.pricing,
  });

  const first = buses[plan.order[0]!]!;
  for (const note of notes) first.log('doet', note, 'info');

  const onUnhandled = (reason: unknown) => {
    first.log('doet', reason instanceof Error ? reason.message : String(reason), 'error');
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);

  const app = render(
    <Control
      buses={buses}
      sides={sides}
      order={plan.order}
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
  await Promise.all(plan.order.map((slot) => sides[slot]!.adapter.dispose().catch(() => {})));
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
