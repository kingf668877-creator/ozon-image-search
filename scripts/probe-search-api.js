/**
 * 探测 OZON 图搜页加载时的所有 API 请求，
 * 找到直接返回商品 JSON 数据的那个接口。
 *
 * 方法：CDP Network domain 监听 responseReceived + response body
 */
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9225;
const SEARCH_URL = 'https://www.ozon.ru/search-by-image?image_id=b8f89f01455af37382f4ca27060d24edxb7f89f01a3a17377869206a3749fa2e5';

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
    }).on('error', reject);
  });
}

(async () => {
  const tabs = await httpJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const tab = tabs.find((t) => t.type === 'page' && (t.url || '').includes('ozon.ru'));
  if (!tab) { console.error('no ozon tab'); process.exit(1); }
  console.log('attach to', tab.url);

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });

  let nextId = 1;
  const pending = new Map();
  const responses = new Map(); // requestId -> {url, status, mimeType}

  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      const reqId = m.params.requestId;
      // 只关注 API/XHR/fetch 类型的大响应
      if (r && r.mimeType && (r.mimeType.includes('json') || r.url.includes('/api/'))) {
        responses.set(reqId, { url: r.url, status: r.status, mimeType: r.mimeType });
      }
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async function getBody(requestId) {
    try {
      const r = await send('Network.getResponseBody', { requestId });
      return r.body ? r.body.slice(0, 3000) : '';
    } catch { return ''; }
  }

  // 启用 Network
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');

  // 导航
  console.log('navigate to', SEARCH_URL);
  await send('Page.navigate', { url: SEARCH_URL });

  // 等待页面加载 + API 调用完成
  await new Promise((r) => setTimeout(r, 8000));

  console.log('\n=== JSON API responses captured ===');
  console.log('total api/json responses:', responses.size);

  for (const [reqId, info] of responses) {
    const body = await getBody(reqId);
    const hasProducts = body.includes('"tile"') || body.includes('"product"') || body.includes('"sku"') || body.includes('"title"') || body.includes('"price"') || body.includes('searchResults') || body.includes('"items"');
    console.log(`\n--- ${info.status} ${info.mimeType} ---`);
    console.log('URL:', info.url.slice(0, 200));
    console.log('hasProductData:', hasProducts);
    console.log('bodyLen:', body.length);
    if (hasProducts || info.url.includes('search') || info.url.includes('composer')) {
      console.log('BODY PREVIEW:', body.slice(0, 2000));
    }
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });