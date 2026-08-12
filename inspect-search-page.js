// Navigate to search-by-image + 检查主页面是否真有所有商品数据
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

  // Navigate to search-by-image
  console.log('Navigating to search-by-image...');
  await send('Page.navigate', { url: 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586' });

  // Wait for load
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, bodyLen: document.body.innerHTML.length, isCaptcha: document.title.includes("Похоже")})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 60)}, bodyLen=${state.bodyLen}, captcha=${state.isCaptcha}`);
    if (state.bodyLen > 100000) break;
  }

  console.log('\n=== Save main page HTML ===');
  const htmlR = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/search-page.html', htmlR.result.value);
  console.log('  Saved search-page.html, size:', htmlR.result.value.length);

  console.log('\n=== Comprehensive extraction ===');
  const r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];

        // 1) data-state elements - all of them, parse and look for product-like structures
        const dataStateEls = document.querySelectorAll('[data-state]');
        const states = [];
        for (const el of dataStateEls) {
          try {
            states.push(JSON.parse(el.getAttribute('data-state') || '{}'));
          } catch (e) {}
        }

        // 2) Look for products anywhere in states
        const findProducts = (obj, path, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 6) return;
          if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
              if (obj[i] && typeof obj[i] === 'object') {
                // Check if it looks like a product
                if (obj[i].link && obj[i].price != null && obj[i].title) {
                  out.push({ ...obj[i], _path: path + '[' + i + ']' });
                }
                findProducts(obj[i], path + '[' + i + ']', depth + 1);
              }
            }
            return;
          }
          // 单个 product
          if (obj.link && obj.price != null && obj.title) {
            out.push({ ...obj, _path: path });
            return;
          }
          for (const k of Object.keys(obj)) {
            if (k === '__proto__') continue;
            findProducts(obj[k], path + '.' + k, depth + 1);
          }
        };
        states.forEach((s, i) => findProducts(s, 'state[' + i + ']'));

        // 3) JSON-LD ItemList
        const ldList = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try {
            const j = JSON.parse(s.textContent);
            const extract = (o) => {
              if (!o || typeof o !== 'object') return;
              if (o['@type'] === 'ItemList' && o.itemListElement) {
                o.itemListElement.forEach(item => {
                  if (item.url) {
                    ldList.push({
                      source: 'ld-ItemList',
                      url: item.url,
                      title: item.name,
                      image: item.image,
                      position: item.position,
                    });
                  }
                });
              }
              if (o['@type'] === 'Product' && o.offers) {
                ldList.push({
                  source: 'ld-Product',
                  url: o['@id'] || o.url,
                  title: o.name,
                  price: o.offers.price,
                  image: o.image,
                  rating: o.aggregateRating?.ratingValue,
                  reviews: o.aggregateRating?.reviewCount,
                });
              }
              for (const k of Object.keys(o)) {
                if (typeof o[k] === 'object') extract(o[k]);
              }
            };
            extract(j);
          } catch (e) {}
        });

        // 4) DOM scraping with price detection
        const dom = [];
        document.querySelectorAll('a[href*="/product/"]').forEach(a => {
          const href = a.href.split('?')[0];
          // Walk up to find tile
          let tile = a;
          for (let i = 0; i < 6; i++) {
            tile = tile.parentElement;
            if (!tile) break;
          }
          // Find price in tile - search for digit ₽ patterns
          let priceText = '';
          const tileText = tile?.innerText || '';
          const priceMatches = [...tileText.matchAll(/(\\d{2,6})\\s*[₽\\u20BD]/g)];
          if (priceMatches.length > 0) {
            priceText = priceMatches[0][1] + ' ₽';
          }
          // Find rating
          const ratingMatch = tileText.match(/(\\d\\.\\d)\\s*\\/\\s*5/);
          // Find reviews
          const reviewsMatch = tileText.match(/(\\d+)\\s*(?:отзыв|оцен)/i);

          dom.push({
            source: 'dom',
            url: href,
            title: (a.textContent || '').trim().slice(0, 200),
            price: priceText,
            rating: ratingMatch ? ratingMatch[1] : null,
            reviews: reviewsMatch ? reviewsMatch[1] : null,
          });
        });

        // Dedup
        const seen = new Set();
        const uniqueDom = dom.filter(p => {
          if (seen.has(p.url)) return false;
          seen.add(p.url);
          return true;
        });

        return JSON.stringify({
          dataStateCount: dataStateEls.length,
          dataStateProducts: out.length,
          ldItemList: ldList.length,
          ldItems: ldList.slice(0, 5),
          domTotal: dom.length,
          domUnique: uniqueDom.length,
          domSample: uniqueDom.slice(0, 10),
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });