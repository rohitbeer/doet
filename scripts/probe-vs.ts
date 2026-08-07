import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentId,
  AgentInfo,
  Effort,
  MessageDelivery,
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
const added: string[] = [];

/** Long enough that a message can be added before the exchange closes. */
const LEG_MS = 120;

/**
 * Stands in for a real CLI closely enough to exercise the exchange contract: a
 * `send` that only settles once every message added to it has been answered,
 * which is the part the runner's timing and token tallies depend on.
 */
function fakeAgent(id: AgentId, cwd: string, file: string): AgentAdapter {
  let currentCwd = cwd;
  let settle: ((result: TurnResult) => void) | null = null;
  const legs: string[] = [];
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

  const bill = (input: number, output: number) => {
    info.usage = {
      inputTokens: (info.usage.inputTokens ?? 0) + input,
      outputTokens: (info.usage.outputTokens ?? 0) + output,
      totalTokens: (info.usage.totalTokens ?? 0) + input + output,
    };
  };

  let timer: NodeJS.Timeout | null = null;

  const finish = () => {
    timer = null;
    const done = settle;
    settle = null;
    const text = [`implemented ${file}`, ...legs].join('\n\n');
    legs.length = 0;
    done?.({ agent: id, text, verdict: null, usage: info.usage, interrupted: false });
  };

  /** Another leg of work. Re-arming is what keeps the exchange open. */
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(finish, LEG_MS);
  };

  return {
    id,
    label: id,
    start: async () => {},
    send: async (prompt): Promise<TurnResult> => {
      seen.push(prompt);
      writeFileSync(join(currentCwd, file), `${prompt}\n`);
      info.sessionTurns += 1;
      bill(10, 5);
      return new Promise<TurnResult>((resolve) => {
        settle = resolve;
        arm();
      });
    },
    addMessage: async (text): Promise<MessageDelivery> => {
      // Idle: the message would ride in front of the next prompt instead.
      if (!settle) return 'pending';
      added.push(text);
      legs.push(`applied: ${text}`);
      bill(4, 2);
      arm();
      return 'live';
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
  // A rate only slot B's model would match, so the probe covers both the
  // priced and the unpriced branch of the scoreboard.
  pricing: { probe: { input: 1_000_000, output: 2_000_000 } },
  sides: {
    a: { slot: 'a', cli: 'claude', adapter: adapterA, worktree: worktreeA },
    b: { slot: 'b', cli: 'claude', adapter: adapterB, worktree: worktreeB },
  },
});

const prompt = 'make the same feature';
// Started, not awaited: adding a message to an exchange means doing it while
// that exchange is still running, which is the whole point of the feature.
const pending = runner.run(prompt);
await new Promise((resolve) => setTimeout(resolve, 20));

const addOn = 'also handle the empty case';
const delivery = await runner.addMessage('a', addOn);
if (delivery !== 'live') throw new Error(`expected a live delivery, got ${delivery}`);
if (runner.statsFor('a').runningSince == null) {
  throw new Error('slot A should still be mid-exchange while a message is added to it');
}

const result = await pending;
if (seen.length !== 2 || seen.some((value) => value !== prompt)) {
  throw new Error(`slots did not receive the identical prompt: ${JSON.stringify(seen)}`);
}
if (added.length !== 1 || added[0] !== addOn) {
  throw new Error(`the added message did not reach slot A: ${JSON.stringify(added)}`);
}
if (!result.slots.a.response.includes(`applied: ${addOn}`)) {
  throw new Error('the exchange should not have closed before the added message was answered');
}
if (result.slots.a.addOns !== 1 || result.slots.b.addOns !== 0) {
  throw new Error(
    `added messages were attributed to the wrong slot: ${result.slots.a.addOns}/${result.slots.b.addOns}`,
  );
}
if (!result.slots.a.changed || !result.slots.b.changed) {
  throw new Error('both branches should contain committed changes');
}

// Time and spend, which is what the scoreboard reports.
for (const slot of ['a', 'b'] as const) {
  const side = result.slots[slot];
  if (!(side.elapsedMs > 0)) throw new Error(`slot ${slot} recorded no elapsed time`);
  if (side.elapsedMs > result.elapsedMs) {
    throw new Error(`slot ${slot} cannot have taken longer than the run`);
  }
  if ((side.usage.totalTokens ?? 0) <= 0) throw new Error(`slot ${slot} recorded no tokens`);
}
// The slot that answered an extra message spent more than the one that did not.
if ((result.slots.a.usage.totalTokens ?? 0) <= (result.slots.b.usage.totalTokens ?? 0)) {
  throw new Error('the added message should have cost slot A extra tokens');
}
const stats = runner.statsFor('a');
if (stats.runningSince != null) throw new Error('slot A should be idle once the run is over');
if (stats.turns !== 1 || stats.addOns !== 1) {
  throw new Error(`slot A stats are wrong: ${JSON.stringify(stats)}`);
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
if (!session.includes(addOn) || !session.includes('delivered mid-exchange')) {
  throw new Error('the added message and how it landed should both be in session.md');
}
if (!saved.includes('## Spend') || !saved.includes('Wall clock:')) {
  throw new Error('result.md should carry the scoreboard');
}
// 14 input + 7 output tokens at $1/$2 per token — a rate chosen to be
// unmistakable rather than realistic.
if (!saved.includes('~$28.00')) {
  throw new Error(`result.md should price slot A from the rate table:\n${saved}`);
}

console.log({
  samePrompt: seen,
  addedMidExchange: { text: addOn, delivery },
  branches: [result.slots.a.branch, result.slots.b.branch],
  files: [result.slots.a.files, result.slots.b.files],
  elapsedMs: {
    run: result.elapsedMs,
    a: result.slots.a.elapsedMs,
    b: result.slots.b.elapsedMs,
  },
  tokens: [result.slots.a.usage.totalTokens, result.slots.b.usage.totalTokens],
  continuedAndStacked: true,
  history: store.dir,
});
