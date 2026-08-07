import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentId,
  AgentInfo,
  Effort,
  ModelChoice,
  TurnResult,
} from '../src/core/types.js';

const scratch = mkdtempSync(join(tmpdir(), 'doet-vs-probe-'));
process.env.DOET_HOME = join(scratch, 'home');

const {
  addWorktree,
  commitAll,
  git,
  inspectRepo,
  mergeBranch,
  vsBranchName,
} = await import('../src/core/git.js');
const { SessionStore } = await import('../src/core/sessions.js');
const { VsRunner } = await import('../src/core/vs.js');

const repo = join(scratch, 'repo');
await git(scratch, ['init', '-q', repo]);
await git(repo, ['config', 'user.email', 'probe@doet']);
await git(repo, ['config', 'user.name', 'doet probe']);
writeFileSync(join(repo, 'base.txt'), 'base\n');
await git(repo, ['add', '-A']);
await git(repo, ['commit', '-qm', 'base']);

const state = (await inspectRepo(repo))!;
const store = new SessionStore('12345678-1234-1234-1234-123456789abc');
const seen: string[] = [];

function fakeAgent(id: AgentId, cwd: string, file: string): AgentAdapter {
  let currentCwd = cwd;
  const info: AgentInfo = {
    id,
    label: id,
    model: 'probe',
    status: 'ready',
    cwd,
    permissionMode: 'never',
    sessionId: `${id}-${file}`,
    sessionSeq: 1,
    sessionTurns: 0,
    usage: {},
  };
  return {
    id,
    label: id,
    start: async () => {},
    send: async (prompt): Promise<TurnResult> => {
      seen.push(prompt);
      writeFileSync(join(currentCwd, file), `${prompt}\n`);
      info.sessionTurns += 1;
      return {
        agent: id,
        text: `implemented ${file}`,
        verdict: null,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        interrupted: false,
      };
    },
    interrupt: async () => {},
    resolvePermission: () => {},
    setModel: async (_model: string, _effort?: Effort) => {},
    listModels: async (): Promise<ModelChoice[]> => [],
    setPermissionMode: async () => {},
    listPermissionModes: () => [],
    setCwd: async (cwd) => {
      currentCwd = cwd;
      info.cwd = cwd;
    },
    newSession: async () => {},
    releaseSession: async () => info.sessionId ?? null,
    resumeSession: async () => {},
    interactiveCommand: () => null,
    forkSession: async () => null,
    history: () => `history for ${file}`,
    info: () => ({ ...info }),
    dispose: async () => {},
  };
}

const worktreeA = await addWorktree(
  repo,
  join(scratch, 'a'),
  vsBranchName(store.id, 'a', 'claude'),
  state.head,
);
const worktreeB = await addWorktree(
  repo,
  join(scratch, 'b'),
  vsBranchName(store.id, 'b', 'claude'),
  state.head,
);
const adapterA = fakeAgent('claude', worktreeA.path, 'a.txt');
const adapterB = fakeAgent('claude', worktreeB.path, 'b.txt');

const runner = new VsRunner({
  root: repo,
  store,
  sides: {
    a: { slot: 'a', cli: 'claude', adapter: adapterA, worktree: worktreeA },
    b: { slot: 'b', cli: 'claude', adapter: adapterB, worktree: worktreeB },
  },
});

const prompt = 'make the same feature';
const result = await runner.run(prompt);
if (seen.length !== 2 || seen.some((value) => value !== prompt)) {
  throw new Error(`slots did not receive the identical prompt: ${JSON.stringify(seen)}`);
}
if (!result.slots.a.changed || !result.slots.b.changed) {
  throw new Error('both branches should contain committed changes');
}
if (!(await git(repo, ['show', `${result.slots.a.branch}:a.txt`])).ok) {
  throw new Error('slot A change is missing from its branch');
}
if (!(await git(repo, ['show', `${result.slots.b.branch}:b.txt`])).ok) {
  throw new Error('slot B change is missing from its branch');
}

// Plug A, continue its exact live adapter in main, then stack B. Each step
// commits, so the main tree stays clean enough for the next result.
const pluggedA = await mergeBranch(repo, result.slots.a.branch, { squash: true });
if (!pluggedA.ok) throw new Error(`could not plug A: ${pluggedA.message}`);
await commitAll(repo, 'plug A');
await adapterA.setCwd(repo);
await runner.continue('a', 'continue the chosen implementation');
if (!(await inspectRepo(repo))?.clean) throw new Error('follow-up should leave main clean');

const pluggedB = await mergeBranch(repo, result.slots.b.branch, { squash: true });
if (!pluggedB.ok) throw new Error(`could not stack B: ${pluggedB.message}`);
await commitAll(repo, 'plug B');
if (!(await git(repo, ['show', 'HEAD:a.txt'])).ok || !(await git(repo, ['show', 'HEAD:b.txt'])).ok) {
  throw new Error('stacked main tree should contain both slot results');
}

const session = readFileSync(join(store.dir, 'session.md'), 'utf8');
const saved = readFileSync(join(store.dir, 'result.md'), 'utf8');
if (!session.includes(prompt)
  || !session.includes('continue the chosen implementation')
  || !saved.includes(result.slots.a.branch)
  || !saved.includes(result.slots.b.branch)) {
  throw new Error('VS Markdown history is incomplete');
}

console.log({
  samePrompt: seen,
  branches: [result.slots.a.branch, result.slots.b.branch],
  files: [result.slots.a.files, result.slots.b.files],
  continuedAndStacked: true,
  history: store.dir,
});
