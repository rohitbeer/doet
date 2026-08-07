/**
 * Renders the VS view against stub agents and prints the frame, so the
 * scoreboard band and the per-slot message composer can be checked without a
 * TTY or a live model call.
 *
 *   npx tsx scripts/probe-vs-ui.tsx running   both slots working, live counters
 *   npx tsx scripts/probe-vs-ui.tsx message   a message being typed at a busy slot
 *   npx tsx scripts/probe-vs-ui.tsx idle      the same at a finished slot — sends now
 *   npx tsx scripts/probe-vs-ui.tsx done      the finished scoreboard
 *   npx tsx scripts/probe-vs-ui.tsx narrow    the same, in a small window
 */
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/core/bus.js';
import type { SessionStore } from '../src/core/sessions.js';
import { VsApp } from '../src/ui/VsApp.js';
import { VsRunner, type VsSide } from '../src/core/vs.js';
import type {
  AgentAdapter,
  AgentId,
  AgentInfo,
  InFlightDelivery,
  SlotId,
  TurnResult,
} from '../src/core/types.js';

const scene = process.argv[2] ?? 'running';
const narrow = scene === 'narrow';

/*
 * A real repository with real worktrees.
 *
 * The `done` scene is the one worth rendering carefully, and it only exists
 * once the runner has committed each side and diffed it — so a stubbed git
 * would be stubbing out most of what that frame reports.
 */
const scratch = mkdtempSync(join(tmpdir(), 'doet-vs-ui-'));
process.env.DOET_HOME = join(scratch, 'home');
const { addWorktree, git, inspectRepo, vsBranchName } = await import('../src/core/git.js');

const repo = join(scratch, 'repo');
await git(scratch, ['init', '-q', repo]);
await git(repo, ['config', 'user.email', 'probe@doet']);
await git(repo, ['config', 'user.name', 'doet probe']);
writeFileSync(join(repo, 'base.txt'), 'base\n');
await git(repo, ['add', '-A']);
await git(repo, ['commit', '-qm', 'base']);
const head = (await inspectRepo(repo))!.head;

/** Long enough that the scene still shows a run in flight when the frame is grabbed. */
const WORK_MS = scene === 'done' || scene === 'idle' ? 250 : 60_000;

function stub(id: AgentId, model: string, cwd: string): AgentAdapter {
  const info: AgentInfo = {
    id,
    label: id === 'claude' ? 'Claude Code' : 'Codex',
    model,
    resolvedModel: model,
    effort: id === 'claude' ? 'high' : 'low',
    status: 'working',
    cwd,
    permissionMode: id === 'claude' ? 'default' : 'untrusted/workspace-write',
    sessionSeq: 1,
    sessionTurns: 1,
    usage:
      id === 'claude'
        ? { inputTokens: 18_412, outputTokens: 3_818, totalTokens: 22_230, costUsd: 0.41 }
        : { inputTokens: 29_037, outputTokens: 1_234, totalTokens: 30_271 },
  };
  return {
    id,
    label: info.label,
    start: async () => {},
    send: async (): Promise<TurnResult> =>
      new Promise((resolve) =>
        setTimeout(() => {
          // Something for the diff to report, so the finished band is not all
          // zeroes.
          writeFileSync(join(cwd, `${id}.ts`), `export const built = '${id}';\n`.repeat(id === 'claude' ? 12 : 5));
          info.status = 'ready';
          resolve({ agent: id, text: 'done', verdict: null, usage: info.usage, interrupted: false });
        }, WORK_MS),
      ),
    addMessage: async (): Promise<InFlightDelivery | null> =>
      info.status === 'ready' ? null : id === 'claude' ? 'live' : 'queued',
    interrupt: async () => {},
    resolvePermission: () => {},
    setModel: async () => {},
    listModels: async () => [],
    setPermissionMode: async () => {},
    listPermissionModes: () => [],
    setCwd: async () => {},
    newSession: async () => {},
    releaseSession: async () => 'stub-session-id',
    resumeSession: async () => {},
    interactiveCommand: () => ({ command: 'sh', args: ['-c', 'true'] }),
    forkSession: async () => null,
    history: () => '',
    info: () => info,
    dispose: async () => {},
  };
}

const buses: Record<SlotId, Bus> = { a: new Bus(), b: new Bus() };
const worktrees = {
  a: await addWorktree(repo, join(scratch, 'a'), vsBranchName('probe', 'a', 'claude'), head),
  b: await addWorktree(repo, join(scratch, 'b'), vsBranchName('probe', 'b', 'codex'), head),
};

const sides: Record<SlotId, VsSide> = {
  a: {
    slot: 'a',
    cli: 'claude',
    adapter: stub('claude', 'sonnet', worktrees.a.path),
    worktree: worktrees.a,
  },
  b: {
    slot: 'b',
    cli: 'codex',
    adapter: stub('codex', 'gpt-5.6-sol', worktrees.b.path),
    worktree: worktrees.b,
  },
};

const store = {
  id: 'probe',
  dir: '/tmp/doet',
  detach: () => {},
  openVsQuestion: () => {},
  appendVsTurn: () => {},
  appendVsFollowUp: () => {},
  appendVsAddOn: () => {},
  appendNote: () => {},
  writeSlotHistory: () => {},
  writeVsMeta: () => {},
  finalizeVs: () => '/tmp/doet/result.md',
} as unknown as SessionStore;

const runner = new VsRunner({
  sides,
  store,
  root: repo,
  // Codex reports no cost of its own, so this is the branch of the scoreboard
  // that only exists because of the rate table.
  pricing: { 'gpt-5.6-sol': { input: 1.25, output: 10 } },
});

const frames: string[] = [];
const fake = new EventEmitter() as unknown as NodeJS.WriteStream;
Object.assign(fake, {
  columns: narrow ? 92 : 130,
  rows: narrow ? 20 : 34,
  write: (chunk: string) => {
    frames.push(chunk);
    return true;
  },
  isTTY: false,
});

const pending: string[] = [];
const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadStream;
Object.assign(fakeStdin, {
  isTTY: true,
  setRawMode: () => fakeStdin,
  resume: () => fakeStdin,
  pause: () => fakeStdin,
  setEncoding: () => fakeStdin,
  read: () => (pending.length > 0 ? pending.shift()! : null),
  unshift: (data: Uint8Array) => {
    pending.unshift(Buffer.from(data).toString('utf8'));
    fakeStdin.emit('readable');
  },
  unref: () => fakeStdin,
  ref: () => fakeStdin,
});

const app = render(
  <VsApp
    buses={buses}
    sides={sides}
    runner={runner}
    store={store}
    root={repo}
    pricing={{ 'gpt-5.6-sol': { input: 1.25, output: 10 } }}
  />,
  { stdout: fake, stdin: fakeStdin, patchConsole: false, exitOnCtrlC: false },
);

/** Past Ink's 200ms kitty-protocol probe, which otherwise eats the keystrokes. */
const type = (text: string, at: number) =>
  setTimeout(() => {
    pending.push(text);
    fakeStdin.emit('readable');
  }, at);

// Type the shared request, send it, and let both slots start working.
type('add a --json flag', 300);
type('\r', 380);

if (scene === 'message') {
  type('\u001b[C', 600); // right arrow selects slot B
  type('m', 660);
  type('use the existing flag parser, do not add a dependency', 720);
}

// The same keys, but after both slots have finished. The hint has to say the
// message sends now rather than joining an exchange — there is no exchange.
if (scene === 'idle') {
  type('\u001b[C', 800);
  type('m', 870);
  type('now add a test for the empty case', 940);
}

setTimeout(() => {
  app.unmount();
  const last = frames.filter((f) => f.includes('doet')).pop() ?? frames[frames.length - 1] ?? '';
  process.stdout.write(`${last}\n`);
  process.stdout.write(`\n[scene=${scene}, captured ${frames.length} frames]\n`);
  process.exit(0);
}, 1_400);
