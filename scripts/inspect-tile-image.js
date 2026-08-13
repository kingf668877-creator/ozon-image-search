// 查看 tileImage 的完整结构
const http = require('http');
const WebSocket = require('ws');
const CDP_PORT = 9225;
const IMAGE_ID = 'b8f89f01455af37382f4ca27060d24edxb7f89f01a3a17377869206a3749fa2e5';
function httpJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } }); }).on('error', reject); }); }
(async () => {
  const tabs = await httpJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const tab = tabs.find((t) => t.type === 'page' && (t.url || '').includes('ozon.ru'));
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });
  let nextId = 1; const pending = new Map();
  ws.on('message', (data) => { const m = JSON.parse(data); if (m.id != null) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); } });
  function send(method, params) { const id = nextId++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  await send('Runtime.enable');
  const expr = `(async () => {
    const searchPath = '/search-by-image?image_id=' + ${JSON.stringify(IMAGE_ID)};
    const res = await fetch('/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(searchPath), { credentials: 'include' });
    const json = await res.json();
    const ws2 = json.widgetStates || {};
    const tileKey = Object.keys(ws2).find(k => k.startsWith('tileGridDesktop'));
    const tileData = JSON.parse(ws2[tileKey]);
    const first = tileData.items[0];
    return JSON.stringify({ tileImage: first.tileImage }, null, 1);
  })()`;
  const r = await send('Runtime.evaluate', { expression: `(async () => { return await (${expr}); })()`, returnByValue: true, awaitPromise: true });
  console.log(r.result.value);
  ws.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });