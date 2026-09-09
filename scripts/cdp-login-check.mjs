/* CDP 验证:裁剪 iframe 内完成登录,实测主界面在窄窗口下的布局 */
import WebSocket from 'ws';
import http from 'node:http';

const [, , url = 'http://127.0.0.1:3200/releases/latest/harness.html', width = '640'] = process.argv;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 9222, path, method: 'PUT' }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

const target = await getJson('/json/new?about:blank');
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 3000));

// 在 iframe 内注册并登录(React 受控输入需 native setter)
const loginExpr = `(async () => {
  const f = document.getElementById('app');
  const w = f ? f.contentWindow : window;
  const d = f ? f.contentDocument : document;
  const wait = () => new Promise(r => setTimeout(r, 400));
  for (let i = 0; i < 10 && !d.querySelector('.login-input'); i++) await wait();
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const inputs = d.querySelectorAll('.login-input');
  setVal(inputs[0], 'admin'); setVal(inputs[1], 'Test1234!');
  d.querySelector('.btn-primary').click();
  for (let i = 0; i < 10 && !d.querySelector('.sidebar'); i++) await wait();
  await wait();
  return JSON.stringify({ loggedIn: !!d.querySelector('.sidebar') });
})()`;
const lr = await send('Runtime.evaluate', { expression: loginExpr, returnByValue: true, awaitPromise: true });
console.log('LOGIN', lr?.result?.value);

const auditExpr = `(() => {
  const f = document.getElementById('app');
  const d = f ? f.contentDocument : document;
  const grid = d.querySelector('.stat-grid');
  return JSON.stringify({
    outerVw: window.innerWidth,
    dataVw: d.documentElement.dataset.vw,
    appVwVar: d.documentElement.style.getPropertyValue('--app-vw') || null,
    bodyW: Math.round(d.body.getBoundingClientRect().width),
    innerScrollW: d.documentElement.scrollWidth,
    sidebarW: Math.round(d.querySelector('.sidebar')?.getBoundingClientRect().width ?? -1),
    navLabelHidden: getComputedStyle(d.querySelector('.nav-label')).display === 'none',
    statCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : -1,
    logoutVisible: (d.querySelector('.btn-logout')?.getBoundingClientRect().width ?? 0) > 0,
  });
})()`;
const ar = await send('Runtime.evaluate', { expression: auditExpr, returnByValue: true });
console.log('AUDIT', ar?.result?.value);
ws.close();
process.exit(0);
