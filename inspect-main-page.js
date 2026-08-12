// 检查主页面的 [data-state] 结构，找到包含商品价格的数据
const http = require('http');
const WebSocket = require('ws');

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
  console.log('OZON tab:', ozonTab.url);

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

  // 1) 检查 page.html 里是否已经有产品价格
  console.log('\n=== Check main page for product data ===');
  const r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];

        // 1) data-state elements
        const dataStateEls = document.querySelectorAll('[data-state]');
        for (const el of dataStateEls) {
          try {
            const ds = JSON.parse(el.getAttribute('data-state') || '{}');
            // Look for items[] / products[] / cells[]
            const walk = (obj, path) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) {
                  if (obj[i] && typeof obj[i] === 'object') {
                    // Check if this is a product
                    if (obj[i].link && obj[i].price != null && obj[i].title) {
                      out.push({
                        source: 'data-state',
                        path,
                        url: obj[i].link,
                        title: obj[i].title,
                        price: obj[i].price,
                        image: obj[i].image,
                        rating: obj[i].rating,
                        reviews: obj[i].reviewsCount,
                      });
                    }
                    walk(obj[i], path + '[' + i + ']');
                  }
                }
                return;
              }
              if (obj.link && obj.price != null && obj.title) {
                out.push({
                  source: 'data-state',
                  path,
                  url: obj.link,
                  title: obj.title,
                  price: obj.price,
                  image: obj.image,
                  rating: obj.rating,
                  reviews: obj.reviewsCount,
                });
              }
              for (const k of Object.keys(obj)) {
                if (k === '__proto__') continue;
                if (['items', 'products', 'cells', 'tiles', 'widgets', 'widget', 'data'].includes(k)) {
                  walk(obj[k], path + '.' + k);
                }
              }
            };
            walk(ds, 'data-state');
          } catch (e) {}
        }

        // 2) JSON-LD structured data
        const ldProducts = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try {
            const j = JSON.parse(s.textContent);
            const extract = (o) => {
              if (!o || typeof o !== 'object') return;
              if (o['@type'] === 'Product' || o['@type'] === 'ItemList') {
                if (o.itemListElement) o.itemListElement.forEach(extract);
                if (o.name && o.offers) {
                  ldProducts.push({
                    source: 'ld+json',
                    title: o.name,
                    price: o.offers.price,
                    currency: o.offers.priceCurrency,
                    url: o.url,
                    image: o.image,
                    rating: o.aggregateRating?.ratingValue,
                    reviews: o.aggregateRating?.reviewCount,
                  });
                }
              }
              for (const k of Object.keys(o)) {
                if (typeof o[k] === 'object') extract(o[k]);
              }
            };
            extract(j);
          } catch (e) {}
        });

        // 3) Check NUXT for webSearchResults or products
        const nuxt = window.__NUXT__?.state || {};
        const nuxtKeys = Object.keys(nuxt);

        // 4) Check for any script tag with products
        const scriptTags = [...document.querySelectorAll('script')].filter(s => s.textContent.includes('price') && s.textContent.includes('title'));

        return JSON.stringify({
          dataStateCount: dataStateEls.length,
          dataStateProducts: out.slice(0, 10),
          dataStateProductTotal: out.length,
          ldProductCount: ldProducts.length,
          ldProducts: ldProducts.slice(0, 5),
          nuxtKeys,
          scriptTagsWithProducts: scriptTags.length,
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  // 5) Save the page.html for inspection
  console.log('\n=== Saving page.html ===');
  const htmlR = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/page2.html', htmlR.result.value);
  console.log('  Saved page2.html, size:', htmlR.result.value.length);

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });