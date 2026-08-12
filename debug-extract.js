// 改进版商品提取
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

  // 1) Debug page structure
  console.log('\n=== Debug: Page structure ===');
  let r = await send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        url: location.href,
        title: document.title,
        bodyLen: document.body.innerHTML.length,
        nuxtStateKeys: Object.keys(window.__NUXT__?.state || {}).slice(0, 30),
        nuxtStateLength: Object.keys(window.__NUXT__?.state || {}).length,
        widgetKeys: Object.keys(window.__NUXT__?.state?.widget || {}).slice(0, 30),
        // Look for products in different places
        webSearchResults: window.__NUXT__?.state?.webSearchResults || null,
        // HTML element query
        dataStateCount: document.querySelectorAll('[data-state]').length,
        aHrefs: [...document.querySelectorAll('a[href*="/product/"]')].length,
        // Find product links
        productLinks: [...new Set([...document.querySelectorAll('a[href*="/product/"]')].map(a => a.href))].slice(0, 5),
      })
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  // 2) Dump page HTML for inspection
  console.log('\n=== Saving page HTML ===');
  r = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/page.html', r.result.value);
  console.log('  Saved page.html, size:', r.result.value.length);

  // 3) Find product data structures
  console.log('\n=== Find products ===');
  r = await send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        // Try various known locations for product data in OZON Nuxt state
        wsrShops: (window.__NUXT__?.state?.webSearchResults?.shops || []).length,
        wsrProducts: (window.__NUXT__?.state?.webSearchResults?.products || []).length,
        // widget.products
        widgetProducts: (window.__NUXT__?.state?.widget?.webSearchResults?.products || []).length,
        // searchResultsV2
        searchV2: (window.__NUXT__?.state?.searchResultsV2 || []).length,
        // direct widget keys
        search: Object.keys(window.__NUXT__?.state?.widget || {}).filter(k => k.toLowerCase().includes('search')),
        product: Object.keys(window.__NUXT__?.state?.widget || {}).filter(k => k.toLowerCase().includes('product')),
        // top-level state keys with 'product' or 'search'
        allKeys: Object.keys(window.__NUXT__?.state || {}).filter(k => k.toLowerCase().includes('product') || k.toLowerCase().includes('search')),
      })
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  // 4) Wide search: find any object with product-like fields
  console.log('\n=== Wide product search ===');
  r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];
        const candidates = [];
        // data-state attributes
        document.querySelectorAll('[data-state]').forEach(el => { try { candidates.push(JSON.parse(el.getAttribute('data-state') || '{}')); } catch (e) {} });
        // __NUXT__ state
        if (window.__NUXT__?.state) candidates.push(window.__NUXT__.state);
        // Also fetch all script tags
        document.querySelectorAll('script[type="application/json"]').forEach(el => {
          try { candidates.push(JSON.parse(el.textContent)); } catch (e) {}
        });
        function walk(n, path = 'root') {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) {
            n.forEach((v, i) => walk(v, path + '[' + i + ']'));
            return;
          }
          // Look for product-like objects
          const hasTitle = n.title && typeof n.title === 'string' && n.title.length > 5;
          const hasPrice = n.price != null || n.finalPrice != null;
          const hasLink = n.link || n.href || n.url;
          if (hasTitle && hasPrice && hasLink) {
            out.push({
              path,
              url: n.link || n.href || n.url,
              title: n.title,
              price: n.price || n.finalPrice,
              image: n.image || n.imageUrl || '',
            });
            return;
          }
          for (const k of Object.keys(n)) {
            if (k === '__proto__' || k === 'parent') continue;
            walk(n[k], path + '.' + k);
          }
        }
        candidates.forEach(c => walk(c));
        const seen = new Set();
        return JSON.stringify({
          totalCandidates: candidates.length,
          totalFound: out.length,
          sample: out.slice(0, 10),
          unique: out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 30),
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });