// 用 CDP attach 到用户已经打开的 Chrome，抓取 OZON 图搜结果
// 不重新打开浏览器 - 用用户登录的 Chrome 实例

const http = require('http');
const fs = require('fs');

async function getDebugTabs(port = 9222) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Step 1: 让用户打开 Chrome debug 模式（--remote-debugging-port）
// 我们用现成的 Chrome实例，假设它开了 debug port

async function main() {
  console.log('Connecting to existing Chrome (CDP)...');

  // Try common ports
  let tabs = null;
  for (const port of [9222, 9223, 9333]) {
    try {
      tabs = await getDebugTabs(port);
      console.log(`  Found debug tabs on port ${port}`);
      break;
    } catch (e) {}
  }

  if (!tabs) {
    console.log('No Chrome with debug port. 启动一个 debug Chrome...');
    return;
  }

  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru')) || tabs[0];
  console.log('Target tab:', ozonTab.url);
  console.log('WS:', ozonTab.webSocketDebuggerUrl);

  const WebSocket = require('ws');
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

  console.log('\n=== Current URL ===');
  let r = await send('Runtime.evaluate', { expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null})' });
  console.log(r.result.value);

  console.log('\n=== Navigating to search-by-image ===');
  await send('Page.navigate', { url: 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586' });

  // Wait for navigation
  await new Promise(r => setTimeout(r, 8000));

  for (let i = 0; i < 30; i++) {
    r = await send('Runtime.evaluate', { expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, bodyLen: document.body?.innerHTML?.length || 0})' });
    const state = JSON.parse(r.result.value);
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, hasNuxt=${state.hasNuxt}, bodyLen=${state.bodyLen}`);
    if (state.hasNuxt === 'object' && state.bodyLen > 10000) {
      console.log('\n*** SEARCH RESULTS LOADED ***');
      console.log('  requestID:', state.requestID);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Extract products
  console.log('\n=== Extracting products ===');
  r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];
        const candidates = [];
        document.querySelectorAll('[data-state]').forEach(el => { try { candidates.push(JSON.parse(el.getAttribute('data-state') || '{}')); } catch (e) {} });
        if (window.__NUXT__?.state) candidates.push(window.__NUXT__.state);
        function walk(n) {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) { n.forEach(walk); return; }
          if (n.link && n.title && (n.price != null || n.finalPrice != null)) {
            out.push({
              url: n.link.startsWith('http') ? n.link : 'https://www.ozon.ru' + n.link,
              title: n.title,
              price: String(n.price || n.finalPrice || ''),
              image: n.image || n.imageUrl || '',
              rating: n.rating || null,
              reviews: n.reviewsCount || null,
            });
            return;
          }
          for (const k of Object.keys(n)) { if (k === '__proto__') continue; walk(n[k]); }
        }
        candidates.forEach(walk);
        const seen = new Set();
        return JSON.stringify(out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 30));
      })()
    `,
    returnByValue: true,
  });

  const products = JSON.parse(r.result.value);
  console.log(`\n*** PRODUCTS FOUND: ${products.length} ***`);
  products.forEach((p, i) => {
    console.log(`\n[${i+1}] ${p.title.slice(0, 80)}`);
    console.log(`    ${p.price} ₽ | rating=${p.rating} reviews=${p.reviews}`);
    console.log(`    ${p.url.slice(0, 100)}`);
  });

  // Save
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    products,
  }, null, 2));

  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });