/**
 * Starts a real `CodexAdapter` in a real git worktree, the way VS mode does.
 *
 *   npx tsx scripts/probe-codex-worktree.ts
 *
 * This is the exact path that failed with
 * `thread/start.runtimeWorkspaceRoots requires experimentalApi capability`.
 * No turn is taken, so it costs nothing but a handshake.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/core/bus.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';

const root = mkdtempSync(join(tmpdir(), 'doet-cx-wt-'));
const repo = join(root, 'repo');
const tree = join(root, 'slot-a');
const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

execFileSync('git', ['init', '-q', repo]);
run(repo, ['config', 'user.email', 'probe@doet']);
run(repo, ['config', 'user.name', 'probe']);
writeFileSync(join(repo, 'a.txt'), 'base\n');
run(repo, ['add', '-A']);
run(repo, ['commit', '-qm', 'base']);
run(repo, ['worktree', 'add', '-q', '-b', 'doet/vs/probe/a-codex', tree, 'HEAD']);

const gitCommonDir = run(tree, ['rev-parse', '--git-common-dir']);

const bus = new Bus();
bus.on((event) => {
  if (event.kind === 'log' || event.kind === 'error') {
    console.log(`[${event.kind}]`, 'message' in event ? event.message : '');
  }
});

const adapter = new CodexAdapter({
  bus,
  cwd: tree,
  model: '',
  instructions: 'probe',
  approvalPolicy: 'untrusted',
  sandbox: 'workspace-write',
  workspaceRoots: [gitCommonDir],
});

async function main(): Promise<void> {
  await adapter.start();
  const info = adapter.info();
  console.log('started OK');
  console.log('  cwd          :', info.cwd);
  console.log('  writable root:', gitCommonDir);
  console.log('  thread       :', info.sessionId ?? '(none)');
  console.log('  model        :', info.model || '(account default)');
  await adapter.dispose();
}

main()
  .catch((error: unknown) => {
    console.error('FAILED:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    console.log('probe dir:', root);
    process.exit(process.exitCode ?? 0);
  });
