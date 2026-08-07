/** Lists the models this Codex install/account actually accepts. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });
let id = 1;
const send = (method, params) => {
  const msg = { jsonrpc: '2.0', id: id++, method, params: params ?? {} };
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return msg.id;
};

let initId = null;
let listId = null;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id === initId && msg.result !== undefined) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    listId = send('model/list', {});
  }
  if (msg.id === listId) {
    console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
    process.exit(0);
  }
});

initId = send('initialize', {
  clientInfo: { name: 'doet-probe', title: 'doet', version: '0.1.0' },
  capabilities: null,
});

setTimeout(() => { console.log('timeout'); process.exit(2); }, 30000);
