/**
 * A whole VS run against the real CLIs: two worktrees, one shared prompt, a
 * message added to slot A while it is still working.
 *
 * The stub probes cover each seam on its own. This one exists for the join —
 * that the runner's clock, token tally and scoreboard describe what two real
 * agents actually did, and that a message added mid-run reaches one slot and
 * only one.
 *
 *   npx tsx scripts/probe-vs-live.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/core/bus.js';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import type { SlotId } from '../src/core/types.js';
import type { VsSide } from '../src/core/vs.js';

const scratch = mkdtempSync(join(tmpdir(), 'doet-vs-live-'));
process.env.DOET_HOME = join(scratch, 'home');

const { addWorktree, git, inspectRepo, vsBranchName } = await import('../src/core/git.js');
const { SessionStore } = await import('../src/core/sessions.js');
const { VsRunner, vsInstructions } = await import('../src/core/vs.js');

const repo = join(scratch, 'repo');
await git(scratch, ['init', '-q', repo]);
await git(repo, ['config', 'user.email', 'probe@doet']);
await git(repo, ['config', 'user.name', 'doet probe']);
writeFileSync(join(repo, 'README.md'), '# probe\n');
await git(repo, ['add', '-A']);
await git(repo, ['commit', '-qm', 'base']);
const state = (await inspectRepo(repo))!;

const TASK = 'Create a file called greet.sh that prints a greeting. Keep it short.';
const ADD_ON =
  'One more thing while you work: the greeting must be exactly the word PINEAPPLE.';
const BREAK_IN_MS = 6_000;

const store = new SessionStore('aaaaaaaa-0000-0000-0000-000000000000');
const buses: Record<SlotId, Bus> = { a: new Bus(), b: new Bus() };
for (const slot of ['a', 'b'] as const) store.attachVs(slot, buses[slot]);

const worktrees = {
  a: await addWorktree(repo, join(scratch, 'a'), vsBranchName(store.id, 'a', 'claude'), state.head),
  b: await addWorktree(repo, join(scratch, 'b'), vsBranchName(store.id, 'b', 'codex'), state.head),
};

const sides: Record<SlotId, VsSide> = {
  a: {
    slot: 'a',
    cli: 'claude',
    adapter: new ClaudeAdapter({
      bus: buses.a,
      cwd: worktrees.a.path,
      model: 'sonnet',
      instructions: vsInstructions('a'),
      permissionMode: 'bypassPermissions',
    }),
    worktree: worktrees.a,
  },
  b: {
    slot: 'b',
    cli: 'codex',
    adapter: new CodexAdapter({
      bus: buses.b,
      cwd: worktrees.b.path,
      model: '',
      workspaceRoots: [state.gitCommonDir],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      instructions: vsInstructions('b'),
    }),
    worktree: worktrees.b,
  },
};

await Promise.all([sides.a.adapter.start(), sides.b.adapter.start()]);

const runner = new VsRunner({
  sides,
  store,
  root: repo,
  // Deliberately only Codex, the CLI that reports no cost of its own.
  pricing: { 'gpt-5': { input: 1.25, output: 10 } },
});

const pending = runner.run(TASK);
const nudged = new Promise<string>((resolve) => {
  setTimeout(() => {
    runner
      .addMessage('a', ADD_ON)
      .then(({ delivery }) => resolve(delivery))
      .catch((error: unknown) => resolve(`failed: ${String(error)}`));
  }, BREAK_IN_MS);
});

const result = await pending;
const delivery = await nudged;

for (const slot of ['a', 'b'] as const) {
  const side = result.slots[slot];
  console.log(`\n=== slot ${slot.toUpperCase()} · ${side.cli} · ${side.model} ===`);
  console.log(`  time     ${side.elapsedMs}ms`);
  console.log(`  tokens   in ${side.usage.inputTokens} / out ${side.usage.outputTokens}`);
  console.log(`  cost     ${side.usage.costUsd ?? 'not reported'}`);
  console.log(`  diff     ${side.files} files, +${side.insertions} −${side.deletions}`);
  console.log(`  added    ${side.addOns}`);
  if (side.error) console.log(`  error    ${side.error}`);
}
console.log(`\nrun ${result.elapsedMs}ms · slot A delivery: ${delivery}`);

// The added message went to one slot and only one — the comparison survives.
if (result.slots.a.addOns !== 1 || result.slots.b.addOns !== 0) {
  throw new Error('the added message leaked across slots');
}
for (const slot of ['a', 'b'] as const) {
  if (!(result.slots[slot].elapsedMs > 0)) throw new Error(`slot ${slot} recorded no time`);
  if (!((result.slots[slot].usage.outputTokens ?? 0) > 0)) {
    throw new Error(`slot ${slot} recorded no output tokens`);
  }
}

const wroteIt = (await git(repo, ['show', `${result.slots.a.branch}:greet.sh`])).stdout;
console.log(`\nslot A's greet.sh:\n${wroteIt.trim()}`);
if (!/PINEAPPLE/i.test(wroteIt)) {
  throw new Error('slot A never applied the message added mid-run');
}

/*
 * The other half: a message to a slot that is sitting idle.
 *
 * It must go to that agent's own session there and then, and to that agent
 * only — not be held back for whatever prompt the shared composer sends next.
 */
console.log('\n=== message to an idle slot ===');
const IDLE_MSG = 'Add a second file called note.txt containing the word MANGO.';
const idle = await runner.addMessage('b', IDLE_MSG);
console.log(`  delivery ${idle.delivery}`);
if (idle.delivery !== 'sent') throw new Error(`an idle slot should send, got ${idle.delivery}`);
if (!idle.turn) throw new Error('a sent message should hand back the turn it opened');
const idleTurn = await idle.turn;
if (idleTurn.error) throw new Error(`the idle-slot turn failed: ${idleTurn.error}`);

const note = await git(repo, ['show', `${result.slots.b.branch}:note.txt`]);
console.log(`  slot B's note.txt: ${JSON.stringify(note.stdout.trim())}`);
if (!note.ok || !/MANGO/i.test(note.stdout)) {
  throw new Error('the message to the idle slot never reached its branch');
}
// And slot A, which was not addressed, has no such file.
if ((await git(repo, ['show', `${result.slots.a.branch}:note.txt`])).ok) {
  throw new Error('a message to one slot leaked into the other');
}
console.log('  slot A untouched');

const saved = readFileSync(join(store.dir, 'result.md'), 'utf8');
console.log(`\n${saved.slice(saved.indexOf('## Spend'))}`);

await Promise.all([sides.a.adapter.dispose(), sides.b.adapter.dispose()]);
console.log(`history: ${store.dir}`);
