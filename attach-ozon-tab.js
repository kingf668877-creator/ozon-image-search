// Attach 到 OZON tab 并抓取数据
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
  console.log('Getting tabs on port', port);
  const tabs = await getTabs(port);

  // 找OZON的tab
  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru')) || tabs[0];
  console.log('OZON tab:', ozonTab.url);
  console.log('WS:', ozonTab.webSocketDebuggerUrl);

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

  // 1) Get page state
  let r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot"), bodyLen: document.body?.innerHTML?.length || 0})',
    returnByValue: true,
  });
  let state = JSON.parse(r.result.value);
  console.log('\n=== State ===');
  console.log(JSON.stringify(state, null, 2));

  // 如果captcha，等用户
  if (state.isCaptcha) {
    console.log('\n  Captcha detected。等 5 分钟手动过 captcha...');
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 2000));
      r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
        returnByValue: true,
      });
      state = JSON.parse(r.result.value);
      if (i % 10 === 0) console.log(`  [${(i+1)*2}s] captcha=${state.isCaptcha}, requestID=${state.requestID}`);
      if (!state.isCaptcha && state.hasNuxt === 'object' && state.requestID) {
        console.log('  *** Captcha passed! ***');
        break;
      }
    }
  }

  // 如果不是真页面，继续等
  if (state.isCaptcha || !state.hasNuxt) {
    console.log('  Still in captcha。等 3 分钟再试一次...');
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000));
      r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
        returnByValue: true,
      });
      state = JSON.parse(r.result.value);
      if (i % 10 === 0) console.log(`  [${(i+1)*2}s] captcha=${state.isCaptcha}, requestID=${state.requestID}`);
      if (!state.isCaptcha && state.hasNuxt === 'object' && state.requestID) {
        console.log('  *** Captcha passed! ***');
        break;
      }
    }
  }

  if (state.isCaptcha || !state.requestID) {
    console.log('  Still captcha. abort.');
    ws.close();
    return;
  }

  // 2) Extract products
  console.log('\n=== 提取商品 ===');
  await new Promise(r => setTimeout(r, 5000));

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

  // 3) Save cookies + products
  r = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  const requestID = await (await send('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value;
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: r.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: r.cookies,
    requestID,
  }, null, 2));
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    requestID,
    products,
  }, null, 2));
  console.log('\n  Saved cookies + products.');

  ws.close();
  console.log('\n  Done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });