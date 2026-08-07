#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { render } from 'ink';
import React from 'react';
import { Bus } from './core/bus.js';
import { loadConfig, type SummarySource } from './core/config.js';
import { Conductor } from './core/conductor.js';
import { SessionStore, type SessionMeta } from './core/sessions.js';
import { AGENT_LABELS, sessionInstructions } from './core/relay.js';
import { Summarizer } from './core/summarizer.js';
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
import { VsRunner, vsInstructions, type VsSide } from './core/vs.js';
import { ClaudeAdapter } from './core/adapters/claude.js';
import { CodexAdapter } from './core/adapters/codex.js';
import {
  AGENT_IDS,
  EFFORTS,
  SLOT_IDS,
  type AgentAdapter,
  type AgentId,
  type CliId,
  type Effort,
  type SlotId,
} from './core/types.js';
import { App } from './ui/App.js';
import { chooseOne } from './ui/StandalonePicker.js';
import { VsApp } from './ui/VsApp.js';

type DoetMode = 'co-code' | 'vs';

interface Args {
  cwd: string;
  mode?: DoetMode;
  claudeModel?: string;
  claudeEffort?: Effort;
  codexModel?: string;
  codexEffort?: Effort;
  summary?: SummarySource;
  summaryModel?: string;
  rounds?: number;
  first?: AgentId;
  /** `true` means "the most recent one"; a string is an id or a prefix. */
  resume?: string | true;
  listSessions?: boolean;
  /** `--worktrees` on its own lists; `--worktrees prune` deletes. */
  worktrees?: 'list' | 'prune';
  /** Lets `prune` delete worktrees that still hold work. */
  force?: boolean;
}

function asEffort(value: string | undefined): Effort | undefined {
  return value && (EFFORTS as string[]).includes(value) ? (value as Effort) : undefined;
}

/**
 * Read the number off package.json rather than hold a copy here, so an
 * installed doet cannot report a version it isn't. The path resolves the same
 * either way doet runs: `src/cli.tsx` under tsx and `dist/cli.js` once built
 * both sit one directory below the manifest.
 */
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
    const value = argv[i + 1];
    switch (flag) {
      case '-C':
      case '--cwd':
        if (value) args.cwd = value;
        i++;
        break;
      case '--claude-model':
        args.claudeModel = value;
        i++;
        break;
      case '--claude-effort':
        args.claudeEffort = asEffort(value);
        i++;
        break;
      case '--codex-model':
        args.codexModel = value;
        i++;
        break;
      case '--codex-effort':
        args.codexEffort = asEffort(value);
        i++;
        break;
      case '--summary':
        if (value === 'claude' || value === 'codex' || value === 'off') {
          args.summary = value;
        }
        i++;
        break;
      case '--summary-model':
        args.summaryModel = value;
        i++;
        break;
      case '--rounds':
        {
          const rounds = Number(value);
          if (!Number.isFinite(rounds) || rounds < 1) {
            throw new Error('--rounds must be a positive number.');
          }
          args.rounds = Math.floor(rounds);
        }
        i++;
        break;
      case '--mode':
        if (value !== 'co-code' && value !== 'vs') {
          throw new Error('--mode must be co-code or vs.');
        }
        args.mode = value;
        i++;
        break;
      case '--first':
        if (value === 'claude' || value === 'codex') args.first = value;
        i++;
        break;
      case '-r':
      case '--resume':
        // The id is optional, so only consume the next argv when it is one.
        if (value && !value.startsWith('-')) {
          args.resume = value;
          i++;
        } else {
          args.resume = true;
        }
        break;
      case '--sessions':
        args.listSessions = true;
        break;
      case '--worktrees':
        // `prune` is the only sub-word, so anything else is the next flag.
        if (value === 'prune') {
          args.worktrees = 'prune';
          i++;
        } else {
          args.worktrees = 'list';
        }
        break;
      case '--force':
        args.force = true;
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
  process.stdout.write(`doet — two coding-agent modes in one terminal.

co-code relays one conversation between two agents. vs sends the same task to
two isolated sessions and keeps both implementations on separate git branches.
Every permission prompt from both agents surfaces in doet.

Usage
  doet [options]

Options
  -C, --cwd <dir>          Working directory for both agents (default: cwd)
      --mode <mode>        co-code|vs (otherwise choose at launch)
      --claude-model <m>   Model for Claude Code (default: from config)
      --claude-effort <e>  Reasoning effort: low|medium|high|xhigh|max
      --codex-model <m>    Model for Codex (default: from config)
      --codex-effort <e>   Reasoning effort: low|medium|high|xhigh|max
      --summary <who>      Who keeps the running notes: claude|codex|off
      --summary-model <m>  Model for the note-taker's own session
      --rounds <n>         Default exchanges; doet asks per question anyway
      --first <agent>      Skip the "who answers first" prompt
  -r, --resume [id]        Reopen a stored co-code session (default: latest)
      --sessions           List stored sessions and exit
      --worktrees          List the branches and worktrees VS runs left here
      --worktrees prune    Delete the ones holding no work (--force: all)
  -h, --help               This text
  -v, --version            Print the version and exit

Environment
  DOET_HOME                Where doet keeps config and sessions
                           (default: ~/.doet)

In-session commands
  /open <agent>            Enter its live session here
  /branch <agent>          Fork its session into another terminal
  /where                   Where branched sessions should open
  /model [agent] [model]   Pick a model — no arguments opens a picker
  /models <agent>          Browse what that agent accepts
  /summary                 Choose the summary agent and its model
  /gist                    Show the running digest
  /session <agent> new     Start a fresh session for one CLI
  /session <agent> policy <manual|rounds:N|tokens:N>
  /session <agent> handoff <ask|gist|full|none>
  /perm <agent> <mode>     Change permission posture
  /rounds <n>              Re-cap the co-code exchange
  /first <agent>           Set the default opener
  /stop                    End co-code after the current turn
  /new                     Fresh doet session, both agents rotated
  /quit                    Exit

Keys
  ← / →                    Select a pane (works mid-turn); tab cycles
  enter / ctrl+o           Enter the selected pane's live CLI session
  ↑ / ↓, pgup/pgdn         Scroll the selected pane
  ctrl+e                   Zoom the selected pane to full width
  ctrl+g                   Toggle the relay log / gist band

co-code requires both \`claude\` and \`codex\` on PATH and logged in. vs only
requires the CLI or CLIs selected for its two slots.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (args.listSessions) {
    printSessions(args.cwd);
    return;
  }

  // Deliberately before anything that starts an agent: tidying up after old
  // runs should not cost two CLI sessions and a model list.
  if (args.worktrees) {
    await manageWorktrees(args.cwd, args.worktrees, args.force ?? false);
    return;
  }

  // Resuming reopens a stored session: same directory, same markdown, and both
  // agents re-attached to the sessions they were driving.
  let resumed: SessionMeta | null = null;
  if (args.resume !== undefined) {
    resumed = SessionStore.resolve(args.resume, args.cwd);
    if (!resumed) {
      process.stderr.write(
        typeof args.resume === 'string'
          ? `No stored session matches "${args.resume}". Try \`doet --sessions\`.\n`
          : `No stored sessions yet.\n`,
      );
      process.exit(1);
    }
  }

  const storedMode = resumed?.mode ?? 'co-code';
  const mode = args.mode ?? (resumed
    ? storedMode
    : await chooseOne('How should the two agents work?', [
        {
          id: 'co-code',
          label: 'co-code',
          description: 'One shared conversation: each agent reviews and improves the other.',
        },
        {
          id: 'vs',
          label: 'vs',
          description: 'Same task, two isolated worktrees and branches; compare the implementations afterwards.',
        },
      ]));
  if (!mode) return;
  if (mode === 'vs') {
    if (resumed) {
      throw new Error('VS histories are preserved, but reopening their finished agent sessions is not implemented yet.');
    }
    await runVsMode(args, config);
    return;
  }
  if (resumed?.mode === 'vs') {
    throw new Error('That id is a VS run. View its Markdown history under DOET_HOME/sessions.');
  }

  const bus = new Bus();
  const store = new SessionStore(randomUUID(), resumed?.id);
  store.attach(bus);

  // Launch overrides stay separate from the persisted object App edits. This
  // makes a later `/rounds` or `/where` save incapable of persisting a one-off
  // `--claude-model` (or a stored model from `--resume`) by accident.
  const launchModels = {
    claude: {
      ...(resumed
        ? { id: resumed.agents.claude.model, effort: resumed.agents.claude.effort }
        : config.models.claude),
    },
    codex: {
      ...(resumed
        ? { id: resumed.agents.codex.model, effort: resumed.agents.codex.effort }
        : config.models.codex),
    },
  };
  if (args.claudeModel) launchModels.claude = { id: args.claudeModel, effort: args.claudeEffort };
  else if (args.claudeEffort) launchModels.claude.effort = args.claudeEffort;
  if (args.codexModel) launchModels.codex = { id: args.codexModel, effort: args.codexEffort };
  else if (args.codexEffort) launchModels.codex.effort = args.codexEffort;
  const launchSummary = {
    ...config.summary,
    model: { ...config.summary.model },
  };
  if (args.summary) launchSummary.agent = args.summary;
  if (args.summaryModel) launchSummary.model = { id: args.summaryModel };

  const maxRounds = args.rounds ?? config.coCode.maxRounds;

  const claude = new ClaudeAdapter({
    bus,
    cwd: args.cwd,
    model: launchModels.claude.id,
    effort: launchModels.claude.effort,
    // Sent once, as the session's own instructions. What reaches the agent as a
    // turn is then just the question, or just what the other one said.
    instructions: sessionInstructions({ self: 'claude', other: 'codex', rounds: maxRounds }),
    permissionMode: config.claude.permissionMode,
  });

  const codex = new CodexAdapter({
    bus,
    cwd: args.cwd,
    model: launchModels.codex.id,
    effort: launchModels.codex.effort,
    instructions: sessionInstructions({ self: 'codex', other: 'claude', rounds: maxRounds }),
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.sandbox,
  });

  const agents: Record<AgentId, AgentAdapter> = { claude, codex };

  // Always its own session, started lazily on the first exchange so a run that
  // never asks anything never pays for a third agent.
  const summarizer = new Summarizer({ bus, cwd: args.cwd, setting: launchSummary });

  const conductor = new Conductor({
    bus,
    agents,
    store,
    summarizer,
    sessions: config.sessions,
    config: { ...config.coCode, maxRounds },
  });

  // Start both before rendering: a failure here is a plain error message
  // rather than a broken TUI the user has to kill.
  const failures: string[] = [];
  await Promise.all(
    AGENT_IDS.map(async (id) => {
      try {
        await agents[id].start();
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  if (failures.length > 0) {
    process.stderr.write(`doet could not start both agents:\n  ${failures.join('\n  ')}\n\n`);
    process.stderr.write('Check that `claude` and `codex` are on PATH and logged in.\n');
    await Promise.all(AGENT_IDS.map((id) => agents[id].dispose().catch(() => {})));
    process.exit(1);
  }

  if (resumed) {
    // Re-attach each agent to the session it was on. A missing or expired one
    // is not fatal — that agent simply starts fresh, and says so.
    for (const id of AGENT_IDS) {
      const stored = resumed.agents[id].sessionId;
      if (!stored) continue;
      try {
        await agents[id].resumeSession(stored);
      } catch (error) {
        bus.log(
          'doet',
          `Could not reopen the ${id} session (${stored.slice(0, 8)}): ` +
            `${error instanceof Error ? error.message : String(error)}. Starting it fresh.`,
          'warn',
        );
      }
    }
    summarizer.seed(store.readGist());
    store.noteResumed();
    bus.log('doet', `Resumed session ${resumed.id}.`);
  }

  // A stray rejection used to print a stack over the TUI and take the process
  // with it, losing both live agent sessions. Nothing in the UI is worth that;
  // surface it in the relay log and keep running.
  const onUnhandled = (reason: unknown) => {
    bus.log('doet', reason instanceof Error ? reason.message : String(reason), 'error');
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);

  const app = render(
    <App
      bus={bus}
      conductor={conductor}
      agents={agents}
      store={store}
      summarizer={summarizer}
      config={config}
      promptForSummary={args.summary === undefined}
    />,
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUnhandled);
  process.stdout.write(`Session saved. Reopen it with \`doet --resume ${store.id}\`\n`);
  await summarizer.dispose().catch(() => {});
  await Promise.all(AGENT_IDS.map((id) => agents[id].dispose().catch(() => {})));
}

function printSessions(cwd: string): void {
  const here = SessionStore.list(cwd);
  const sessions = here.length > 0 ? here : SessionStore.list();

  if (sessions.length === 0) {
    process.stdout.write('No stored sessions yet.\n');
    return;
  }

  process.stdout.write(
    here.length > 0 ? `Sessions for ${cwd}:\n\n` : 'No sessions for this directory. All sessions:\n\n',
  );
  for (const meta of sessions.slice(0, 20)) {
    const when = new Date(meta.updatedAt).toLocaleString();
    const query = meta.query ? meta.query.replace(/\s+/g, ' ').slice(0, 60) : '(no question yet)';
    process.stdout.write(`  ${meta.id}\n    ${when} · ${meta.mode ?? 'co-code'} · ${query}\n`);
  }
  process.stdout.write('\nReopen a co-code session with `doet --resume <id>`, or the latest with `doet --resume`.\n');
}

/**
 * Lists or deletes the branches and worktrees VS runs leave behind.
 *
 * A finished run's UI is gone by the time you want to tidy up after it, and the
 * cleanup you actually want is across runs rather than within one — so this is
 * a command rather than another action in a screen you would have to relaunch
 * two agents to reach.
 */
async function manageWorktrees(cwd: string, action: 'list' | 'prune', force: boolean): Promise<void> {
  const repo = await inspectRepo(cwd);
  if (!repo) {
    process.stderr.write('Not a git repository, so there are no VS worktrees here.\n');
    process.exitCode = 1;
    return;
  }

  const worktrees = await listVsWorktrees(repo.root);
  if (worktrees.length === 0) {
    process.stdout.write('No VS worktrees in this repository.\n');
    return;
  }

  if (action === 'list') {
    process.stdout.write(`VS worktrees in ${repo.root}:\n\n`);
    for (const worktree of worktrees) {
      const held = [
        worktree.dirty > 0 ? `${worktree.dirty} uncommitted` : '',
        worktree.ahead > 0 ? `${worktree.ahead} commit${worktree.ahead === 1 ? '' : 's'}` : '',
        worktree.exists ? '' : 'directory missing',
      ].filter(Boolean).join(' · ');
      process.stdout.write(`  ${worktree.branch}\n    ${worktree.path}\n    ${held || 'nothing to lose'}\n`);
    }
    // Said here because it is the first thing everyone gets wrong: a worktree
    // is not a branch waiting to be checked out, it is a checkout already.
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

async function runVsMode(args: Args, config: ReturnType<typeof loadConfig>): Promise<void> {
  const repo = await inspectRepo(args.cwd);
  if (!repo) throw new Error('VS mode must be started inside a git repository.');
  if (!repo.clean) {
    throw new Error(
      `VS mode requires a clean main working tree. Commit or stash: ${repo.dirty.join(', ')}`,
    );
  }

  const picked: Partial<Record<SlotId, CliId>> = {};
  for (const slot of SLOT_IDS) {
    const choice = await chooseOne(`CLI for slot ${slot.toUpperCase()}`, [
      {
        id: 'claude',
        label: AGENT_LABELS.claude,
        description: 'Run a separate Claude Code SDK session in this slot.',
      },
      {
        id: 'codex',
        label: AGENT_LABELS.codex,
        description: 'Run a separate Codex app-server thread in this slot.',
      },
    ], slot === 'a' ? 0 : 1);
    if (!choice) return;
    picked[slot] = choice as CliId;
  }

  const store = new SessionStore(randomUUID());

  /*
   * Worktrees live inside the repository, under an ignored `.doet/`.
   *
   * They used to sit in `DOET_HOME`, which put both agents' entire working
   * copies somewhere the editor never opens — you could not see the code being
   * written, let alone review it. Here your editor already has them, and the
   * exclude below keeps `git status` clean so `plug` and the next run still see
   * a clean main tree.
   */
  // `mainRoot`, not `root`: starting a run from inside another run's worktree is
  // fair game, but nesting its worktrees in there would make every generation of
  // paths longer than the last, and deleting the outer one would silently take
  // the inner one with it.
  const worktreeBase = join(repo.mainRoot, '.doet', 'worktrees', store.id);
  await excludeLocally(repo.gitCommonDir, '/.doet/');
  const worktrees: Partial<Record<SlotId, Awaited<ReturnType<typeof addWorktree>>>> = {};

  try {
    for (const slot of SLOT_IDS) {
      const path = join(worktreeBase, slot);
      mkdirSync(dirname(path), { recursive: true });
      const cli = picked[slot]!;
      worktrees[slot] = await addWorktree(
        repo.root,
        path,
        vsBranchName(store.id, slot, cli),
        repo.head,
      );
    }
  } catch (error) {
    await Promise.all(SLOT_IDS.map(async (slot) => {
      const worktree = worktrees[slot];
      if (!worktree) return;
      await removeWorktree(repo.root, worktree.path, true);
      await deleteBranch(repo.root, worktree.branch, true);
    }));
    throw error;
  }

  const buses = { a: new Bus(), b: new Bus() } satisfies Record<SlotId, Bus>;
  for (const slot of SLOT_IDS) store.attachVs(slot, buses[slot]);
  const sides = {} as Record<SlotId, VsSide>;
  for (const slot of SLOT_IDS) {
    const cli = picked[slot]!;
    const setting = config.models[cli];
    const common = {
      bus: buses[slot],
      cwd: worktrees[slot]!.path,
      model: setting.id,
      effort: setting.effort,
      instructions: vsInstructions(slot),
    };
    const adapter: AgentAdapter = cli === 'claude'
      ? new ClaudeAdapter({ ...common, permissionMode: config.claude.permissionMode })
      : new CodexAdapter({
          ...common,
          // A linked worktree's refs and objects live in the main repository's
          // git directory. Grant that metadata path, not the main checkout.
          workspaceRoots: [repo.gitCommonDir],
          approvalPolicy: config.codex.approvalPolicy,
          sandbox: config.codex.sandbox,
        });
    sides[slot] = { slot, cli, adapter, worktree: worktrees[slot]! };
  }

  const failures: string[] = [];
  await Promise.all(SLOT_IDS.map(async (slot) => {
    try {
      await sides[slot].adapter.start();
    } catch (error) {
      failures.push(`slot ${slot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  if (failures.length > 0) {
    await Promise.all(SLOT_IDS.map((slot) => sides[slot].adapter.dispose().catch(() => {})));
    await Promise.all(SLOT_IDS.map(async (slot) => {
      await removeWorktree(repo.root, sides[slot].worktree.path, true);
      await deleteBranch(repo.root, sides[slot].worktree.branch, true);
    }));
    throw new Error(`Could not start VS agents:\n${failures.join('\n')}`);
  }

  let keepArtifacts = false;
  try {
    for (const slot of SLOT_IDS) {
      const adapter = sides[slot].adapter;
      const models = await adapter.listModels();
      if (models.length === 0) continue;
      const current = adapter.info().model;
      const selected = await chooseOne(
        `Model for slot ${slot.toUpperCase()} · ${adapter.info().label}`,
        models.map((model) => ({
          id: model.id,
          label: model.label,
          description: model.description,
          badge: [model.id === current ? 'current' : '', model.isDefault ? 'default' : '']
            .filter(Boolean)
            .join(' · '),
        })),
        Math.max(0, models.findIndex((model) => model.id === current)),
      );
      if (!selected) continue;
      const model = models.find((candidate) => candidate.id === selected)!;
      let effort = model.defaultEffort;
      if (model.efforts?.length) {
        const effortChoice = await chooseOne(
          `Effort for slot ${slot.toUpperCase()} · ${model.label}`,
          model.efforts.map((value) => ({
            id: value,
            label: value,
            badge: value === model.defaultEffort ? 'default' : '',
          })),
          Math.max(0, model.efforts.indexOf(adapter.info().effort ?? model.defaultEffort!)),
        );
        if (effortChoice) effort = effortChoice as Effort;
      }
      await adapter.setModel(selected, effort);
    }

    const runner = new VsRunner({ sides, store, root: repo.root });
    keepArtifacts = true;
    const app = render(
      <VsApp buses={buses} sides={sides} runner={runner} store={store} root={repo.root} />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } catch (error) {
    if (!keepArtifacts) {
      await Promise.all(SLOT_IDS.map((slot) => sides[slot].adapter.dispose().catch(() => {})));
      await Promise.all(SLOT_IDS.map(async (slot) => {
        await removeWorktree(repo.root, sides[slot].worktree.path, true);
        await deleteBranch(repo.root, sides[slot].worktree.branch, true);
      }));
    }
    throw error;
  } finally {
    await Promise.all(SLOT_IDS.map((slot) => sides[slot].adapter.dispose().catch(() => {})));
  }
  process.stdout.write(
    `VS session saved in ${store.dir}\nAny branches and worktrees you kept remain available for testing.\n`,
  );
}

main().catch((error: unknown) => {
  const detail = error instanceof Error
    ? error.message.startsWith('--')
      ? error.message
      : (error.stack ?? error.message)
    : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
