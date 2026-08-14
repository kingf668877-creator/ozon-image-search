/**
 * OZON 图搜 · 会话凭证与浏览器标签页工具
 */

const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = Number(process.env.OZON_CDP_PORT || 9225);
const OZON_HOST = 'https://www.ozon.ru';

let cache = null;

function snapshot() { return cache; }

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function listTabs() {
  const tabs = await httpJson(`http://127.0.0.1:${CDP_PORT}/json`);
  return tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function findOzonTab() {
  const tabs = await listTabs();
  return tabs.find((t) => (t.url || '').includes('ozon.ru')) || null;
}

async function captureFromBrowser() {
  const tab = await findOzonTab();
  if (!tab) {
    const err = new Error('no_ozon_tab');
    err.code = 'no_ozon_tab';
    throw err;
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }), (err) => {
        if (err) { pending.delete(id); rej(err); }
      });
    });
  }

  try {
    const cookies = await send('Network.getAllCookies');
    const ozonCookies = (cookies.cookies || []).filter((c) => /\.ozon\.ru$/.test(c.domain));
    const cookieHeader = ozonCookies.map((c) => `${c.name}=${c.value}`).join('; ');

    let captured = null;
    const onMsg = (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.method === 'Network.requestWillBeSent' && m.params && m.params.request) {
        const r = m.params.request;
        if (r.url && r.url.includes('/api/entrypoint-api.bx/')) {
          captured = captured || { url: r.url, headers: r.headers };
        }
      }
    };
    ws.on('message', onMsg);
    await send('Network.enable');
    await send('Runtime.evaluate', {
      expression: `fetch('/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent('/'), { credentials: 'include' }).then(r => r.status).catch(e => 'err')`,
      returnByValue: true,
      awaitPromise: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
    ws.off('message', onMsg);

    const headers = captured && captured.headers ? captured.headers : {};
    const ua = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
    const secChUa = headers['sec-ch-ua'] || '';
    const secChUaPlatform = headers['sec-ch-ua-platform'] || '';
    const platform = (secChUaPlatform || '').replace(/"/g, '') || 'Windows';

    cache = {
      cookieHeader,
      userAgent: ua,
      secChUa,
      platform,
      capturedAt: Date.now(),
      tabUrl: tab.url,
    };
    return cache;
  } finally {
    try { ws.close(); } catch {}
  }
}

function status() {
  return cache ? {
    ok: true,
    capturedAt: cache.capturedAt,
    ageMs: Date.now() - cache.capturedAt,
    tabUrl: cache.tabUrl,
    cookieLength: cache.cookieHeader.length,
  } : { ok: false };
}

module.exports = {
  snapshot,
  captureFromBrowser,
  status,
  findOzonTab,
  listTabs,
  OZON_HOST,
  CDP_PORT,
};
