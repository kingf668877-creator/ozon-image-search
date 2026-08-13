/**
 * 直接调用 OZON entrypoint-api.bx 获取图搜结果 JSON，
 * 解析 tileGridDesktop widget 里的商品。
 * 完全跳过 Page.navigate + DOM 渲染。
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9225;
const IMAGE_ID = 'b8f89f01455af37382f4ca27060d24edxb7f89f01a3a17377869206a3749fa2e5';

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

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
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
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  await send('Runtime.enable');

  const t0 = Date.now();
  const expr = `
    (async () => {
      try {
        const searchPath = '/search-by-image?image_id=' + ${JSON.stringify(IMAGE_ID)};
        const apiUrl = '/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(searchPath);
        const res = await fetch(apiUrl, { credentials: 'include' });
        const text = await res.text();
        const json = JSON.parse(text);

        // 找 tileGridDesktop widget
        const widgetStates = json.widgetStates || {};
        const tileKey = Object.keys(widgetStates).find(k => k.startsWith('tileGridDesktop'));
        if (!tileKey) return JSON.stringify({ ok: false, error: 'no tileGrid', keys: Object.keys(widgetStates) });

        const tileData = JSON.parse(widgetStates[tileKey]);
        const items = tileData.items || [];

        const products = items.map((item, i) => {
          let price = '', oldPrice = '', discount = '', title = '', url = '', image = '';
          try { url = item.action && item.action.link ? ('https://www.ozon.ru' + item.action.link.split('?')[0]) : ''; } catch {}
          try {
            for (const st of (item.mainState || [])) {
              if (st.type === 'priceV2') {
                const ps = st.priceV2.price || [];
                for (const p of ps) {
                  if (p.textStyle === 'PRICE') price = p.text;
                  if (p.textStyle === 'ORIGINAL_PRICE') oldPrice = p.text;
                }
                if (st.priceV2.discount) discount = st.priceV2.discount;
              }
              if (st.type === 'textDS' && st.textDS && st.textDS.text && !title) {
                title = st.textDS.text;
              }
            }
          } catch {}
          try {
            const imgs = item.images || item.image || (item.mainState || []).find(s => s.type === 'image');
            if (item.images && item.images[0]) image = item.images[0].src || item.images[0];
          } catch {}
          return { rank: i+1, url, title, price, oldPrice, discount, image };
        });

        return JSON.stringify({
          ok: true,
          count: products.length,
          products: products,
          elapsed: (Date.now() - ${t0}) + 'ms'
        });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e && e.message || e) });
      }
    })()
  `;

  const r = await send('Runtime.evaluate', {
    expression: `(async () => { return await (${expr}); })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (r && r.exceptionDetails) {
    console.error('eval error:', r.exceptionDetails.exception && r.exceptionDetails.exception.description);
  } else {
    const result = JSON.parse(r.result.value || '{}');
    console.log(JSON.stringify(result, null, 2));
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });