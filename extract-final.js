// 从 DOM 提取商品
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

async function getTabs(port = 9225) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const port = 9225;
  const tabs = await getTabs(port);
  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru'));

  const ws = new WebSocket(ozonTab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('=== DOM-based extraction ===');
  const r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];
        const seen = new Set();

        // 1) Find all product tiles using common OZON selectors
        const productCards = document.querySelectorAll('[data-state]');
        productCards.forEach(el => {
          try {
            const ds = JSON.parse(el.getAttribute('data-state') || '{}');
            // OZON product card structure: ds has layoutTrackingInfo? Or product widget?
            // Look for product-like data inside
            function findProduct(obj, depth = 0) {
              if (!obj || typeof obj !== 'object' || depth > 5) return null;
              if (Array.isArray(obj)) {
                for (const item of obj) {
                  const p = findProduct(item, depth + 1);
                  if (p) return p;
                }
                return null;
              }
              if (obj.link && obj.title && obj.price != null) return obj;
              if (obj.link && obj.title && obj.priceText) return { ...obj, price: obj.priceText };
              // Recurse into common keys
              for (const k of ['items', 'products', 'cells', 'tiles', 'widgets', 'widget']) {
                if (obj[k]) {
                  const p = findProduct(obj[k], depth + 1);
                  if (p) return p;
                }
              }
              return null;
            }
            const p = findProduct(ds);
            if (p) {
              out.push({
                source: 'data-state',
                url: p.link.startsWith('http') ? p.link : 'https://www.ozon.ru' + p.link,
                title: p.title,
                price: String(p.price || p.priceText || ''),
                image: p.image || p.imageUrl || '',
              });
            }
          } catch (e) {}
        });

        // 2) DOM scraping fallback
        const seen2 = new Set();
        document.querySelectorAll('a[href*="/product/"]').forEach(a => {
          const href = a.href.split('?')[0];
          if (seen2.has(href)) return;
          seen2.add(href);
          // Walk up to find tile
          let tile = a;
          for (let i = 0; i < 5 && tile.parentElement; i++) {
            if (tile.parentElement.querySelector('a[href*="/product/"]') !== tile) break;
            tile = tile.parentElement;
          }
          const titleEl = tile.querySelector('span, div');
          const title = (a.textContent || titleEl?.textContent || '').slice(0, 200).trim();
          // Look for price near the link
          let priceEl = '';
          const priceSpans = tile.querySelectorAll('span');
          for (const sp of priceSpans) {
            const txt = sp.textContent.trim();
            if (/^[0-9 ]+₽?$|^[0-9 ]+\\u20BD$/.test(txt) || /\d+\s*₽/.test(txt)) {
              priceEl = txt;
              break;
            }
          }
          out.push({
            source: 'dom',
            url: href,
            title: title,
            price: priceEl,
            image: (tile.querySelector('img') || {}).src || '',
          });
        });

        // Dedupe by URL
        const unique = [];
        for (const p of out) {
          const u = p.url;
          if (!seen.has(u)) {
            seen.add(u);
            unique.push(p);
          }
        }
        return JSON.stringify({
          totalCandidates: out.length,
          unique: unique.slice(0, 30),
          totalDataState: document.querySelectorAll('[data-state]').length,
          totalProductLinks: document.querySelectorAll('a[href*="/product/"]').length,
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });

  console.log(r.result.value);

  // Save products
  try {
    const parsed = JSON.parse(r.result.value);
    const products = parsed.unique.map(p => ({
      url: p.url,
      title: p.title,
      price: p.price,
      image: p.image,
    }));
    const requestID = await (await send('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value;
    fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
      imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
      timestamp: Date.now(),
      requestID,
      products,
    }, null, 2));
    console.log(`\nSaved ${products.length} products to ozon-products.json`);
  } catch (e) {
    console.log('Save failed:', e.message);
  }

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });