import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The git doet needs for vs mode, and nothing more.
 *
 * Two agents cannot share a working tree — they would overwrite each other's
 * edits between turns and neither branch would mean anything. So each side gets
 * its own `git worktree`: a full checkout of the same repository, on its own
 * branch, in its own directory. Both adapters already take a `cwd`, so this is
 * the whole of the isolation mechanism.
 *
 * Everything here shells out to `git` rather than using a library. doet already
 * spawns two agent CLIs; a third dependency to run commands the user could type
 * themselves would buy nothing, and the plumbing commands used below are stable
 * across every git that ships `worktree` (2.5+).
 */

/** Never let a stuck git command hang a session the way a stuck agent would. */
const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs git and *returns* the failure rather than throwing it.
 *
 * Half the calls here are questions whose answer is "no" — is this a repo, is
 * it clean, did the merge conflict — and a rejected promise is the wrong shape
 * for a question. The callers that genuinely cannot continue check `ok`.
 */
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Keep the parent's environment but silence anything interactive: a
      // credential or editor prompt inside doet's TUI is a hang with no
      // keyboard attached to it.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

export interface RepoState {
  /** Absolute path to the top of the working tree. */
  root: string;
  /** Shared git metadata, writable by linked worktrees for refs and objects. */
  gitCommonDir: string;
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** False when there is anything uncommitted, staged or not, tracked or not. */
  clean: boolean;
  /** Paths reported by `git status --porcelain`, for telling the user what. */
  dirty: string[];
}

/**
 * What doet needs to know before it offers vs mode at all: whether this is a
 * repository, where it starts from, and whether the tree is clean.
 *
 * Null means "not a git repository" — vs mode is unavailable, which the UI has
 * to say up front rather than after the user has typed a prompt and picked two
 * models.
 */
export async function inspectRepo(cwd: string): Promise<RepoState | null> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok || !root.stdout) return null;

  const [branch, head, status, commonDir] = await Promise.all([
    git(root.stdout, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root.stdout, ['rev-parse', 'HEAD']),
    git(root.stdout, ['status', '--porcelain']),
    git(root.stdout, ['rev-parse', '--git-common-dir']),
  ]);

  if (!head.ok || !head.stdout) {
    throw new Error('vs mode requires a repository with at least one commit.');
  }
  if (!status.ok) {
    throw new Error(`could not read repository status: ${status.stderr || status.stdout}`);
  }
  if (!commonDir.ok || !commonDir.stdout) {
    throw new Error(`could not locate git metadata: ${commonDir.stderr || commonDir.stdout}`);
  }

  const dirty = status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    root: root.stdout,
    gitCommonDir: resolve(root.stdout, commonDir.stdout),
    // A detached HEAD is a real state, not an error — it just means there is no
    // branch name to merge back into later.
    branch: branch.stdout && branch.stdout !== 'HEAD' ? branch.stdout : null,
    head: head.stdout,
    clean: dirty.length === 0,
    dirty,
  };
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.ok && result.stdout.length > 0;
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface Worktree {
  path: string;
  branch: string;
  /** Where the branch started, so a diff can be taken against it later. */
  base: string;
}

/**
 * Cuts a branch at `base` and checks it out in its own directory.
 *
 * `git worktree add -b` does both in one command and refuses if the branch
 * already exists, which is the check doet wants anyway: a name collision means
 * a previous vs run was not cleaned up, and silently reusing its branch would
 * mix two runs' work.
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  base: string,
): Promise<Worktree> {
  const result = await git(root, ['worktree', 'add', '-b', branch, path, base]);
  if (!result.ok) {
    throw new Error(`could not create a worktree at ${path}: ${result.stderr || result.stdout}`);
  }
  return { path, branch, base };
}

/**
 * Removes the checkout. The branch survives on purpose — the point of a vs run
 * is the branches, and one is usually still worth reading after its worktree is
 * gone.
 *
 * `force` is needed for a tree with uncommitted changes in it, which is the
 * normal state for the side you did not pick.
 */
export async function removeWorktree(root: string, path: string, force = false): Promise<GitResult> {
  const result = await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  if (!result.ok) {
    // A real checkout that is dirty must stay a failure; pruning is only for
    // an administrative entry whose directory has already disappeared.
    if (existsSync(path)) return result;
    // A tree the user deleted by hand leaves a stale administrative entry, and
    // `remove` fails on it. Pruning is the documented repair and is safe when
    // there is nothing to prune.
    const pruned = await git(root, ['worktree', 'prune']);
    if (pruned.ok) {
      return { ok: true, stdout: '', stderr: '', code: 0 };
    }
  }
  return result;
}

export async function deleteBranch(root: string, branch: string, force = true): Promise<GitResult> {
  return git(root, ['branch', force ? '-D' : '-d', branch]);
}

/**
 * Makes a path invisible to `git status` for this clone only.
 *
 * VS mode keeps its worktrees inside the repository, because a worktree the
 * editor cannot see is a worktree nobody reviews. That would otherwise leave
 * the main tree permanently dirty — and a dirty main tree is what `plug` and
 * the next VS run both refuse to start on.
 *
 * `.git/info/exclude` rather than `.gitignore`: doet runs on other people's
 * repositories and has no business editing a tracked file to make its own
 * scratch space tidy. This one is local, untracked, and shared by every linked
 * worktree, since it lives in the common git dir.
 */
export async function excludeLocally(gitCommonDir: string, pattern: string): Promise<void> {
  const path = join(gitCommonDir, 'info', 'exclude');
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (existing.split('\n').some((line) => line.trim() === pattern)) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf8');
  } catch {
    // Not being able to hide the directory is untidy, not fatal: the run still
    // works, `git status` is just noisier than it should be.
  }
}

// ---------------------------------------------------------------------------
// Recording what an agent did
// ---------------------------------------------------------------------------

export interface Commit {
  sha: string;
  /** False when the agent changed nothing, which is a result too. */
  changed: boolean;
}

/**
 * Commits everything in a worktree, if there is anything to commit.
 *
 * An agent that edits files but never commits leaves a branch that is identical
 * to its base — so "the branches are done" would show two empty results. doet
 * makes the commit itself so the branch is a real artifact either way, and so
 * the diff the user reviews is a diff of commits rather than of a dirty tree
 * that any later command could disturb.
 *
 * `--no-verify` because this is doet's bookkeeping, not the user's commit: a
 * repository whose pre-commit hook runs the test suite should not be able to
 * fail the recording of what an agent did.
 */
export async function commitAll(dir: string, message: string): Promise<Commit> {
  const added = await git(dir, ['add', '-A']);
  if (!added.ok) throw new Error(`could not stage changes in ${dir}: ${added.stderr || added.stdout}`);

  // `diff --cached --quiet` exits 1 when something is staged. That non-zero
  // exit is the signal, which is exactly why `git()` reports rather than throws.
  const staged = await git(dir, ['diff', '--cached', '--quiet']);
  if (staged.ok) {
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`could not read HEAD in ${dir}: ${head.stderr || head.stdout}`);
    return { sha: head.stdout, changed: false };
  }
  if (staged.code !== 1) {
    throw new Error(`could not inspect staged changes in ${dir}: ${staged.stderr || staged.stdout}`);
  }

  const commit = await git(dir, [
    '-c',
    'user.name=doet',
    '-c',
    'user.email=doet@local',
    'commit',
    '--no-verify',
    '-m',
    message,
  ]);
  if (!commit.ok) throw new Error(`could not commit in ${dir}: ${commit.stderr || commit.stdout}`);

  const head = await git(dir, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error(`could not read commit in ${dir}: ${head.stderr || head.stdout}`);
  return { sha: head.stdout, changed: true };
}

export interface DiffSummary {
  files: number;
  insertions: number;
  deletions: number;
  /** Per-file `--stat` output, for the pane. */
  text: string;
}

/** `git diff --stat base..branch`, parsed into something a pane can render. */
export async function diffSummary(root: string, from: string, to: string): Promise<DiffSummary> {
  const result = await git(root, ['diff', '--stat', `${from}..${to}`]);
  if (!result.ok) {
    throw new Error(`could not diff ${from}..${to}: ${result.stderr || result.stdout}`);
  }
  const text = result.stdout;
  const last = text.split('\n').pop() ?? '';

  const read = (pattern: RegExp): number => {
    const match = pattern.exec(last);
    return match?.[1] ? Number(match[1]) : 0;
  };

  return {
    files: read(/(\d+) files? changed/),
    insertions: read(/(\d+) insertions?\(\+\)/),
    deletions: read(/(\d+) deletions?\(-\)/),
    text,
  };
}

/** The commits a branch added on top of its base, newest first. */
export async function commitsSince(root: string, base: string, branch: string): Promise<string[]> {
  const result = await git(root, ['log', '--oneline', `${base}..${branch}`]);
  if (!result.ok) {
    throw new Error(`could not read commits on ${branch}: ${result.stderr || result.stdout}`);
  }
  return result.stdout ? result.stdout.split('\n') : [];
}

// ---------------------------------------------------------------------------
// Bringing a branch back
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  ok: boolean;
  /** Files left with conflict markers, when a merge stops half-done. */
  conflicts: string[];
  message: string;
}

/**
 * Merges a vs branch into whatever the main working tree has checked out.
 *
 * Merging is the only one of the obvious moves that works here. Checking the
 * branch out is not: git refuses to check out a branch that a worktree already
 * holds —
 *
 *     fatal: 'doet/vs/…/a' is already checked out at '…/wt-a'
 *
 * — and the worktree is where the user is going to test it. Merging from the
 * main tree is allowed while the branch lives in a worktree, so both can be
 * true at once: test it over there, take it here.
 *
 * `squash` collapses the agent's work into one staged change with no commit,
 * which is usually what "plug this in and carry on" means. Without it the merge
 * commit is left uncommitted (`--no-commit`) so the user reviews before it
 * becomes history.
 */
export async function mergeBranch(
  root: string,
  branch: string,
  opts: { squash?: boolean } = {},
): Promise<MergeOutcome> {
  const args = opts.squash
    ? ['merge', '--squash', branch]
    : ['merge', '--no-ff', '--no-commit', branch];

  const result = await git(root, args);
  if (result.ok) {
    return { ok: true, conflicts: [], message: result.stdout || `Merged ${branch}.` };
  }

  const conflicted = await git(root, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = conflicted.stdout ? conflicted.stdout.split('\n').filter(Boolean) : [];

  return {
    ok: false,
    conflicts,
    message: result.stderr || result.stdout || `Could not merge ${branch}.`,
  };
}

/**
 * Undoes a merge that stopped in conflict. Offered rather than done
 * automatically: a half-merged tree is sometimes exactly what you want to sit
 * in and resolve by hand.
 */
export async function abortMerge(root: string): Promise<GitResult> {
  const mergeAbort = await git(root, ['merge', '--abort']);
  if (mergeAbort.ok) return mergeAbort;

  // A conflicted `merge --squash` deliberately writes no MERGE_HEAD, so
  // `merge --abort` refuses it. VS merges only start from a clean main tree;
  // `reset --merge HEAD` is the corresponding safe rollback for that case.
  return git(root, ['reset', '--merge', 'HEAD']);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Branch name for one side of a vs run.
 *
 * Namespaced under `doet/vs/` so the branches a run leaves behind are obvious
 * in `git branch` and trivial to clean up, and stamped with the session id so
 * two runs in the same repository cannot collide.
 */
export function vsBranchName(sessionId: string, slot: string, cli: string): string {
  return `doet/vs/${sanitize(sessionId)}/${sanitize(slot)}-${sanitize(cli)}`;
}

/** git refs disallow a fair amount; keep to what is always legal. */
function sanitize(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .toLowerCase();
}
