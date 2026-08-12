// 重新抓取并保存正确的价格
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
  const products = JSON.parse(fs.readFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', 'utf-8')).products;
  console.log(`Loaded ${products.length} products. Re-extracting prices...`);

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

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    if (product.price && product.price !== '1' && product.price.length > 2) {
      console.log(`[${i+1}] SKIP - has price: ${product.price}`);
      continue;
    }

    console.log(`[${i+1}/${products.length}] ${product.title}`);
    await send('Page.navigate', { url: product.url });
    await new Promise(r => setTimeout(r, 4500));

    try {
      const r = await send('Runtime.evaluate', {
        expression: `
          (() => {
            const ldPrices = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
              try {
                const j = JSON.parse(s.textContent);
                const collect = (o) => {
                  if (o && typeof o === 'object') {
                    if (o.offers) {
                      const offers = Array.isArray(o.offers) ? o.offers : [o.offers];
                      offers.forEach(of => { if (of.price) ldPrices.push(of.price); });
                    }
                    if (o.price) ldPrices.push(o.price);
                  }
                };
                collect(j);
                if (Array.isArray(j)) j.forEach(collect);
              } catch (e) {}
            });
            // Try to find visible price in DOM
            const dom = [];
            document.querySelectorAll('*').forEach(el => {
              if (el.children.length === 0) {
                const t = (el.textContent || '').trim();
                const m = t.match(/^(\\d{1,3}(?:[\\s\\u00a0]\\d{3})*)\\s*[₽\\u20BD]$/);
                if (m) dom.push(m[1].replace(/[\\s\\u00a0]/g, ''));
              }
            });
            return JSON.stringify({ ldPrices, domPrices: dom });
          })()
        `,
        returnByValue: true,
      });
      const data = JSON.parse(r.result.value);
      console.log('  ld:', data.ldPrices, 'dom:', data.domPrices);
      // Prefer the first non-"1" price
      let price = '';
      for (const p of data.ldPrices) {
        if (p !== '1' && p !== 1 && parseInt(p) > 50) {
          price = p + ' ₽';
          break;
        }
      }
      if (!price && data.ldPrices.length > 0) {
        price = data.ldPrices[0] + ' ₽';
      }
      if (!price && data.domPrices.length > 0) {
        price = data.domPrices[0] + ' ₽';
      }
      product.price = price;
      console.log('  →', price);
    } catch (e) {
      console.log('  err:', e.message);
    }
  }

  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    products,
  }, null, 2));
  console.log('\nSaved with correct prices.');

  // Print summary
  const withPrices = products.filter(p => p.price && p.price !== '1' && p.price.length > 2);
  console.log(`\n*** SUMMARY: ${withPrices.length}/${products.length} products have valid prices ***`);
  withPrices.slice(0, 10).forEach((p, i) => {
    console.log(`\n[${i+1}] ${p.title.slice(0, 60)}`);
    console.log(`    ${p.price}`);
    console.log(`    ${p.url.slice(0, 80)}`);
  });

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });