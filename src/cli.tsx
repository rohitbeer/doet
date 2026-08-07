#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { render } from 'ink';
import React from 'react';
import { Bus } from './core/bus.js';
import { loadConfig, type SummarySource } from './core/config.js';
import { Conductor } from './core/conductor.js';
import { SessionStore, type SessionMeta } from './core/sessions.js';
import { sessionInstructions } from './core/relay.js';
import { Summarizer } from './core/summarizer.js';
import { ClaudeAdapter } from './core/adapters/claude.js';
import { CodexAdapter } from './core/adapters/codex.js';
import { AGENT_IDS, EFFORTS, type AgentAdapter, type AgentId, type Effort } from './core/types.js';
import { App } from './ui/App.js';

interface Args {
  cwd: string;
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
}

function asEffort(value: string | undefined): Effort | undefined {
  return value && (EFFORTS as string[]).includes(value) ? (value as Effort) : undefined;
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
        args.rounds = Number(value);
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
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`doet — two agent CLIs, one conversation.

doet does not answer anything itself. It hands your question to one agent,
passes that agent's full response to the other, and keeps relaying until they
agree or run out of exchanges. Every permission prompt from both agents
surfaces in doet.

Usage
  doet [options]

Options
  -C, --cwd <dir>          Working directory for both agents (default: cwd)
      --claude-model <m>   Model for Claude Code (default: from config)
      --claude-effort <e>  Reasoning effort: low|medium|high|xhigh|max
      --codex-model <m>    Model for Codex (default: from config)
      --codex-effort <e>   Reasoning effort: low|medium|high|xhigh|max
      --summary <who>      Who keeps the running notes: claude|codex|off
      --summary-model <m>  Model for the note-taker's own session
      --rounds <n>         Default exchanges; doet asks per question anyway
      --first <agent>      Skip the "who answers first" prompt
  -r, --resume [id]        Reopen a stored session (default: the most recent)
      --sessions           List stored sessions and exit
  -h, --help               This text

In-session commands
  /open <agent>            Branch its session, or take it over here
  /where                   Where branched sessions should open
  /model [agent] [model]   Pick a model — no arguments opens a picker
  /models <agent>          Browse what that agent accepts
  /summary                 Choose the summary agent and its model
  /gist                    Show the running digest
  /session <agent> new     Start a fresh session for one CLI
  /session <agent> policy <manual|rounds:N|tokens:N>
  /session <agent> handoff <ask|gist|full|none>
  /perm <agent> <mode>     Change permission posture
  /rounds <n>              Re-cap the debate
  /first <agent>           Set the default opener
  /stop                    End the debate after the current turn
  /new                     Fresh doet session, both agents rotated
  /quit                    Exit

Keys
  ← / →                    Select a pane (works mid-turn); tab cycles
  ctrl+o                   Open the selected pane's session in its own CLI
  ↑ / ↓, pgup/pgdn         Scroll the selected pane
  ctrl+e                   Zoom the selected pane to full width
  ctrl+g                   Toggle the relay log / gist band

Requires the \`claude\` and \`codex\` CLIs on PATH, both already logged in.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (args.listSessions) {
    printSessions(args.cwd);
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
    // The stored models win, so a resumed session runs as it was, not as your
    // config has drifted since.
    config.models.claude = { id: resumed.agents.claude.model, effort: resumed.agents.claude.effort };
    config.models.codex = { id: resumed.agents.codex.model, effort: resumed.agents.codex.effort };
  }

  const bus = new Bus();
  const store = new SessionStore(randomUUID(), resumed?.id);
  store.attach(bus);

  // Flags win over config for this run, but are not written back — a one-off
  // `--claude-model opus` should not quietly become the new default.
  if (args.claudeModel) config.models.claude = { id: args.claudeModel, effort: args.claudeEffort };
  else if (args.claudeEffort) config.models.claude.effort = args.claudeEffort;
  if (args.codexModel) config.models.codex = { id: args.codexModel, effort: args.codexEffort };
  else if (args.codexEffort) config.models.codex.effort = args.codexEffort;
  if (args.summary) config.summary.agent = args.summary;
  if (args.summaryModel) config.summary.model = { id: args.summaryModel };

  const maxRounds = args.rounds ?? config.debate.maxRounds;

  const claude = new ClaudeAdapter({
    bus,
    cwd: args.cwd,
    model: config.models.claude.id,
    effort: config.models.claude.effort,
    // Sent once, as the session's own instructions. What reaches the agent as a
    // turn is then just the question, or just what the other one said.
    instructions: sessionInstructions({ self: 'claude', other: 'codex', rounds: maxRounds }),
    permissionMode: config.claude.permissionMode,
  });

  const codex = new CodexAdapter({
    bus,
    cwd: args.cwd,
    model: config.models.codex.id,
    effort: config.models.codex.effort,
    instructions: sessionInstructions({ self: 'codex', other: 'claude', rounds: maxRounds }),
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.sandbox,
  });

  const agents: Record<AgentId, AgentAdapter> = { claude, codex };

  // Always its own session, started lazily on the first exchange so a run that
  // never asks anything never pays for a third agent.
  const summarizer = new Summarizer({ bus, cwd: args.cwd, setting: config.summary });

  const conductor = new Conductor({
    bus,
    agents,
    store,
    summarizer,
    sessions: config.sessions,
    config: { ...config.debate, maxRounds },
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
    process.stdout.write(`  ${meta.id}\n    ${when} · ${query}\n`);
  }
  process.stdout.write('\nReopen one with `doet --resume <id>`, or the latest with `doet --resume`.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
