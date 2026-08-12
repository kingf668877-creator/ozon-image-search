// 抓取每个商品的价格
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
  // Load existing products
  const products = JSON.parse(fs.readFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', 'utf-8')).products;
  console.log(`Loaded ${products.length} products. Fetching prices...`);

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

  // Only enrich unique products
  const uniqueProducts = [];
  const seen = new Set();
  for (const p of products) {
    if (!seen.has(p.url)) {
      seen.add(p.url);
      uniqueProducts.push(p);
    }
  }
  console.log(`Unique products: ${uniqueProducts.length}`);

  for (let i = 0; i < uniqueProducts.length; i++) {
    const product = uniqueProducts[i];
    console.log(`\n[${i+1}/${uniqueProducts.length}] ${product.title || product.url}`);
    await send('Page.navigate', { url: product.url });
    await new Promise(r => setTimeout(r, 4000));

    // Extract price
    let r;
    try {
      r = await send('Runtime.evaluate', {
        expression: `
          (() => {
            // OZON price is in multiple places:
            // 1) Page price text with ₽ symbol
            const allText = document.body?.innerText || '';
            const priceMatch = allText.match(/(\\d{1,3}(?:[\\s\\u00a0]\\d{3})*|\\d+)\\s*₽/);
            // 2) JSON-LD structured data
            let ldPrice = null;
            document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
              try {
                const j = JSON.parse(s.textContent);
                if (j.offers?.price) ldPrice = j.offers.price;
                if (Array.isArray(j)) j.forEach(x => { if (x.offers?.price) ldPrice = x.offers.price; });
              } catch (e) {}
            });
            // 3) __NUXT__ state
            const nuxtState = window.__NUXT__?.state || {};
            const stateKeys = Object.keys(nuxtState);
            let nuxtPrice = null;
            for (const k of ['product', 'webProduct', 'price']) {
              if (nuxtState[k]?.price) nuxtPrice = nuxtState[k].price;
            }
            // 4) Find price in DOM
            let domPrice = null;
            const priceEls = [...document.querySelectorAll('[class*="price"]')];
            for (const el of priceEls) {
              const t = el.textContent || '';
              const m = t.match(/(\\d{1,3}(?:[\\s\\u00a0]\\d{3})*|\\d+)/);
              if (m && m[1].length > 1) {
                domPrice = m[1];
                break;
              }
            }
            return JSON.stringify({
              priceText: priceMatch ? priceMatch[1] : null,
              ldPrice: ldPrice,
              nuxtPrice: nuxtPrice,
              domPrice: domPrice,
              title: document.title,
            });
          })()
        `,
        returnByValue: true,
      });
    } catch (e) {
      console.log('  err:', e.message);
      continue;
    }

    try {
      const data = JSON.parse(r.result.value);
      console.log('  ', JSON.stringify(data).slice(0, 200));
      const price = data.priceText || data.ldPrice || data.nuxtPrice || data.domPrice || '';
      product.price = price;
    } catch (e) {
      console.log('  parse err');
    }
  }

  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    products: uniqueProducts,
  }, null, 2));
  console.log('\nSaved with prices.');

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });