/* CDP 验证脚本:无头 Chrome 实测裁剪 iframe 内的 data-vw 档位 */
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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result ?? m.error); pending.delete(m.id); }
  else if (m.method) events.push(m.method);
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 3500));

const expr = `(async () => {
  const f = document.getElementById('app');
  if (!f) return JSON.stringify({ fail: 'no iframe' });
  const d = f.contentDocument, w = f.contentWindow;
  const probes = [...d.querySelectorAll('div[data-x]')];
  const ioResult = await new Promise((resolve) => {
    const seen = {};
    const io = new w.IntersectionObserver((es) => {
      for (const e of es) seen[e.target.dataset.x] = { vis: e.isIntersecting, ratio: +e.intersectionRatio.toFixed(3), rootRight: Math.round(e.rootBounds?.right ?? -1), targetLeft: Math.round(e.boundingClientRect.left) };
      if (Object.keys(seen).length >= probes.length) { io.disconnect(); resolve(seen); }
    }, { threshold: [0] });
    probes.forEach(p => io.observe(p));
    setTimeout(() => resolve(seen), 2500);
  });
  return JSON.stringify({
    outerVw: window.innerWidth,
    docW: document.documentElement.scrollWidth,
    iframeInnerWidth: w.innerWidth,
    visualViewportW: Math.round(w.visualViewport?.width ?? -1),
    outerVisualViewportW: Math.round(window.visualViewport?.width ?? -1),
    scrollX: window.scrollX,
    dataVw: d.documentElement.dataset.vw ?? null,
    io: ioResult,
  });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log('RESULT', r?.result?.value ?? JSON.stringify(r));
ws.close();
process.exit(0);
