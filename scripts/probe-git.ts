/**
 * Exercises `src/core/git.ts` against a throwaway repository.
 *
 *   npx tsx scripts/probe-git.ts
 *
 * Covers the two facts vs mode depends on and neither is obvious: a branch held
 * by a worktree cannot be checked out anywhere else, and merging it from the
 * main tree works anyway.
 */
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWorktree,
  abortMerge,
  commitAll,
  commitsSince,
  deleteBranch,
  diffSummary,
  git,
  inspectRepo,
  mergeBranch,
  removeWorktree,
  vsBranchName,
} from '../src/core/git.js';

const root = mkdtempSync(join(tmpdir(), 'doet-probe-'));
const repo = join(root, 'repo');

async function main(): Promise<void> {
  await git(root, ['init', '-q', repo]);
  await git(repo, ['config', 'user.email', 'probe@doet']);
  await git(repo, ['config', 'user.name', 'doet probe']);
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'base']);

  const state = await inspectRepo(repo);
  console.log('inspectRepo:', { branch: state?.branch, clean: state?.clean, head: state?.head.slice(0, 7) });
  console.log('inspectRepo(non-repo):', await inspectRepo(tmpdir()));

  const base = state!.head;
  const branchA = vsBranchName('2026-08-07-abc', 'a', 'claude');
  const branchB = vsBranchName('2026-08-07-abc', 'b', 'codex');
  console.log('branch names:', branchA, branchB);

  const a = await addWorktree(repo, join(root, 'wt-a'), branchA, base);
  const b = await addWorktree(repo, join(root, 'wt-b'), branchB, base);

  // Slot A edits an existing file; slot B adds one. Neither commits — doet does.
  appendFileSync(join(a.path, 'f.txt'), 'from a\n');
  writeFileSync(join(b.path, 'g.txt'), 'from b\n');

  console.log('commitAll(a):', await commitAll(a.path, 'doet vs: a'));
  console.log('commitAll(b):', await commitAll(b.path, 'doet vs: b'));
  // Nothing left to commit — must not invent an empty commit.
  console.log('commitAll(a) again:', await commitAll(a.path, 'doet vs: a'));

  console.log('diff a:', await diffSummary(repo, base, branchA));
  console.log('commits a:', await commitsSince(repo, base, branchA));

  // The fact the whole design rests on.
  const checkout = await git(repo, ['checkout', branchA]);
  console.log('checkout of a worktree branch ->', checkout.ok ? 'ALLOWED (!)' : checkout.stderr);

  const merged = await mergeBranch(repo, branchB, { squash: true });
  console.log('merge b (squash):', merged.ok, merged.message.split('\n')[0]);
  console.log('staged after squash:', (await git(repo, ['diff', '--cached', '--name-only'])).stdout);
  await git(repo, ['commit', '--no-verify', '-qm', 'plug in b']);

  // Now a conflicting one: rewrite the same line a touched.
  writeFileSync(join(repo, 'f.txt'), 'base\nfrom main\n');
  await git(repo, ['commit', '--no-verify', '-qam', 'main edit']);
  const clash = await mergeBranch(repo, branchA, { squash: true });
  console.log('squash a (conflict expected):', { ok: clash.ok, conflicts: clash.conflicts });
  console.log('abort squash conflict:', (await abortMerge(repo)).ok);
  console.log('conflicts after abort:', (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout);

  // The loser's tree is normally dirty — check both paths in that order.
  appendFileSync(join(b.path, 'g.txt'), 'uncommitted\n');
  const gentle = await removeWorktree(repo, b.path);
  console.log('removeWorktree(dirty, no force):', gentle.ok, gentle.stderr.split('\n')[0]);
  console.log('removeWorktree(dirty, force):', (await removeWorktree(repo, b.path, true)).ok);
  console.log('deleteBranch:', (await deleteBranch(repo, branchB)).ok);
  console.log('worktrees left:', (await git(repo, ['worktree', 'list'])).stdout);
  console.log('\nprobe dir:', root);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
