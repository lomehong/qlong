import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DSH = 'E:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js';
const child = spawn(process.execPath, [DSH, '--profile', 'acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let idc = 0;
const pending = new Map();
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        console.log(`[${ts()}s] ← 响应 id=${m.id}: ${JSON.stringify(m.result ?? m.error).slice(0, 100)}`);
        p(m);
      } else if (m.method === 'session/update') {
        const u = m.params?.update ?? {};
        console.log(`[${ts()}s] ← update: ${u.sessionUpdate} ${String(u.content?.text ?? '').length}字`);
      }
    } catch { console.log(`[${ts()}s] 非JSON`); }
  }
});
child.stderr?.on('data', () => {});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++idc;
  pending.set(id, (m) => resolve(m));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 240_000);
});

const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
console.log(`[${ts()}s] initialize ok`);
const sess = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] });
const sid = sess.result?.sessionId;
console.log(`[${ts()}s] session: ${sid}`);

console.log(`[${ts()}s] prompt: 写一段 300 字的短文介绍龙文化`);
await rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '写一段 300 字的短文介绍龙文化' }] });
console.log(`[${ts()}s] prompt 完成`);
child.kill();
process.exit(0);
