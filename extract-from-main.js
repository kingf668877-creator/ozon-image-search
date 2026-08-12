// 正确提取：每个商品的tile独立提取
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
      expression: 'JSON.stringify({url: location.href, bodyLen: document.body.innerHTML.length, isCaptcha: document.title.includes("Похоже")})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] bodyLen=${state.bodyLen}, captcha=${state.isCaptcha}`);
    if (state.bodyLen > 100000 && !state.isCaptcha) break;
  }

  console.log('\n=== Extract from tile-root elements ===');
  const r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];

        // OZON 用 class="tile-root" 标记每个商品
        const tiles = document.querySelectorAll('.tile-root');
        for (const tile of tiles) {
          // Get product link
          const linkEl = tile.querySelector('a[href*="/product/"]');
          if (!linkEl) continue;
          const href = linkEl.href.split('?')[0];

          // Get image
          const img = tile.querySelector('img');
          const image = img ? (img.src || img.srcset?.split(' ')[0] || '') : '';

          // Get title - look for tsBody500Medium span
          let title = '';
          const titleSpans = tile.querySelectorAll('.tsBody500Medium');
          for (const sp of titleSpans) {
            const t = sp.textContent.trim();
            if (t.length > 5) { title = t; break; }
          }

          // Get price - look for .c35_5_1-b2 class (current price)
          let price = '';
          const priceSpans = tile.querySelectorAll('.c35_5_1-b2, [class*="tsHeadline500Medium"]');
          for (const sp of priceSpans) {
            const t = sp.textContent.trim();
            const m = t.match(/(\\d+)/);
            if (m) { price = m[1] + ' ₽'; break; }
          }

          // Get original price (struck through) - c35_5_1-b
          let oldPrice = '';
          const oldPriceSpans = tile.querySelectorAll('.c35_5_1-b');
          for (const sp of oldPriceSpans) {
            const t = sp.textContent.trim();
            const m = t.match(/(\\d+)/);
            if (m && m[1] !== price.replace(' ₽', '')) { oldPrice = m[1] + ' ₽'; break; }
          }

          // Get discount
          let discount = '';
          const discountSpans = tile.querySelectorAll('[class*="c35_5_1-b5"]');
          for (const sp of discountSpans) {
            const t = sp.textContent.trim();
            if (/[−-]\\d+%/.test(t)) { discount = t; break; }
          }

          // Get rating & reviews
          let rating = '';
          let reviews = '';
          // Look for rating
          const ratingSpans = tile.querySelectorAll('[class*="ui-b3_4_1"], [class*="rating"], [class*="a7a_3_2"]');
          for (const sp of ratingSpans) {
            const t = sp.textContent.trim();
            if (/\\d\\.\\d/.test(t)) { rating = t.slice(0, 10); break; }
          }
          // Look for reviews - "X отзыв"
          const tileText = tile.innerText || '';
          const reviewMatch = tileText.match(/(\\d+)\\s*(?:отзыв|оцен)/i);
          if (reviewMatch) reviews = reviewMatch[1];

          out.push({
            url: href,
            title: title,
            price: price,
            oldPrice: oldPrice,
            discount: discount,
            rating: rating,
            reviews: reviews,
            image: image,
          });
        }

        const seen = new Set();
        const unique = out.filter(p => !seen.has(p.url) ? (seen.add(p.url), true) : false);

        return JSON.stringify({
          tilesFound: tiles.length,
          uniqueProducts: unique.length,
          withTitle: unique.filter(p => p.title).length,
          withPrice: unique.filter(p => p.price).length,
          withRating: unique.filter(p => p.rating).length,
          withReviews: unique.filter(p => p.reviews).length,
          products: unique,
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  // Save products
  try {
    const parsed = JSON.parse(r.result.value);
    const requestID = await (await send('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value;
    fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products-v2.json', JSON.stringify({
      imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
      timestamp: Date.now(),
      requestID,
      products: parsed.products,
    }, null, 2));
    console.log(`\nSaved ${parsed.products.length} products with prices, ratings, reviews to ozon-products-v2.json`);
  } catch (e) {
    console.log('Save err:', e.message);
  }

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });