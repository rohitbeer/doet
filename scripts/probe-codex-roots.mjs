/**
 * Which way can a Codex thread be given a writable root outside its cwd?
 *
 *   node scripts/probe-codex-roots.mjs
 *
 * VS mode runs each agent in a `git worktree`, whose `.git` is a file pointing
 * at `<repo>/.git/worktrees/<slot>` — outside the worktree. Under
 * `workspace-write` that path is not writable, so any git write the agent
 * itself attempts is refused. Two candidate fixes, tested against the real
 * app-server rather than read off the schema:
 *
 *   A  initialize with `capabilities.experimentalApi`, then pass
 *      `runtimeWorkspaceRoots` on thread/start.
 *   B  no capability, pass `config.sandbox_workspace_write.writable_roots`.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'doet-roots-'));
const repo = join(root, 'repo');
const tree = join(root, 'wt');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

execFileSync('git', ['init', '-q', repo]);
git(repo, ['config', 'user.email', 'probe@doet']);
git(repo, ['config', 'user.name', 'probe']);
writeFileSync(join(repo, 'a.txt'), 'hi\n');
git(repo, ['add', '-A']);
git(repo, ['commit', '-qm', 'base']);
git(repo, ['worktree', 'add', '-q', '-b', 'probe', tree, 'HEAD']);
const gitDir = git(tree, ['rev-parse', '--git-dir']);
const commonDir = git(tree, ['rev-parse', '--git-common-dir']);
console.log('worktree git dir :', gitDir);
console.log('common git dir   :', commonDir, '\n');

function client() {
  const child = spawn('codex', ['app-server'], { cwd: tree, stdio: ['pipe', 'pipe', 'pipe'] });
  const inflight = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const deferred = inflight.get(message.id);
      if (!deferred) return;
      inflight.delete(message.id);
      message.error ? deferred.reject(new Error(message.error.message)) : deferred.resolve(message.result);
    }
    // Server → client requests (approvals) are ignored: nothing here takes a turn.
  });
  child.stderr.setEncoding('utf8');
  return {
    request(method, params) {
      const id = next++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
      return new Promise((resolve, reject) => {
        inflight.set(id, { resolve, reject });
        setTimeout(() => reject(new Error('timed out')), 20_000).unref();
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
    },
    stop() {
      child.kill('SIGTERM');
    },
  };
}

async function attempt(label, capabilities, extra) {
  const rpc = client();
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'doet-probe', title: 'doet probe', version: '0.1.0' },
      capabilities,
    });
    rpc.notify('initialized', {});
    const started = await rpc.request('thread/start', {
      cwd: tree,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      ephemeral: true,
      ...extra,
    });
    console.log(`${label}: OK · thread ${started?.thread?.id ?? '(no id)'}`);
    return true;
  } catch (error) {
    console.log(`${label}: FAILED · ${error.message}`);
    return false;
  } finally {
    rpc.stop();
  }
}

const roots = [tree, commonDir];

console.log('--- what doet does today ---');
await attempt('plain (no roots, no capability)', null, {});
await attempt('runtimeWorkspaceRoots, capabilities:null', null, { runtimeWorkspaceRoots: roots });

console.log('\n--- candidate A: experimental capability ---');
await attempt('runtimeWorkspaceRoots + experimentalApi', { experimentalApi: true }, {
  runtimeWorkspaceRoots: roots,
});

console.log('\n--- candidate B: config override, no capability ---');
await attempt('config.sandbox_workspace_write.writable_roots', null, {
  config: { sandbox_workspace_write: { writable_roots: [commonDir] } },
});

console.log('\nprobe dir:', root);
process.exit(0);
