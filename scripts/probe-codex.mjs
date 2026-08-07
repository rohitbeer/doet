/**
 * Verifies the codex app-server handshake outside the TUI:
 * initialize → initialized → thread/start → turn/start, printing every frame.
 * Run with: node scripts/probe-codex.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });

let id = 1;
const send = (method, params) => {
  const msg = { jsonrpc: '2.0', id: id++, method, params: params ?? {} };
  console.log('→', JSON.stringify(msg).slice(0, 200));
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return msg.id;
};
const notify = (method, params) => {
  const msg = { jsonrpc: '2.0', method, params: params ?? {} };
  console.log('→', JSON.stringify(msg).slice(0, 200));
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};

child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => console.log('stderr:', d.trim().slice(0, 300)));

let threadId = null;
let initId = null;
let startId = null;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log('non-json:', line.slice(0, 200));
    return;
  }
  console.log('←', JSON.stringify(msg).slice(0, 400));

  if (msg.id === initId && msg.result !== undefined) {
    notify('initialized', {});
    startId = send('thread/start', { cwd: process.cwd(), approvalPolicy: 'untrusted', sandbox: 'read-only' });
  }

  if (msg.id === startId && msg.result !== undefined) {
    threadId = msg.result?.thread?.id ?? msg.result?.threadId ?? null;
    console.log('*** threadId =', threadId);
    if (threadId) {
      send('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Reply with exactly the word: pong', text_elements: [] }],
      });
    } else {
      console.log('*** could not find thread id in result — dumping full result');
      console.log(JSON.stringify(msg.result, null, 2).slice(0, 2000));
      process.exit(1);
    }
  }

  if (msg.method === 'turn/completed') {
    console.log('*** turn completed');
    setTimeout(() => process.exit(0), 200);
  }
});

initId = send('initialize', {
  clientInfo: { name: 'doet-probe', title: 'doet probe', version: '0.1.0' },
  capabilities: null,
});

setTimeout(() => {
  console.log('*** timeout');
  process.exit(2);
}, 90_000);
