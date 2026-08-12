// 启动 Chrome 用用户现有 profile（保留登录态）+ debug port
const { exec } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

async function getTabs(port = 9222) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForChrome(port = 9222, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const tabs = await getTabs(port); if (tabs.length > 0) return tabs; } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Chrome not ready');
}

async function main() {
  // 启动 Chrome 用用户 profile
  const profileDir = 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data';
  const args = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080',
    '--lang=ru-RU',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
  ];
  console.log('Launching Chrome with user profile...');
  const proc = exec('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' + args.map(a => `"${a}"`).join(' '));
  proc.stderr.on('data', d => {});

  console.log('Waiting for Chrome to be ready...');
  const tabs = await waitForChrome();
  console.log('Chrome ready, tabs:', tabs.length);

  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru')) || tabs[0];
  console.log('Target tab:', ozonTab.url);

  const ws = new WebSocket(ozonTab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  console.log('CDP connected');

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

  console.log('\n=== Step 1: 检查当前登录态 ===');
  let r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({url: location.href, title: document.title, cookies: document.cookie, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null})',
    returnByValue: true,
  });
  console.log(r.result.value);

  // 如果不在 OZON，导航到主页
  r = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (!r.result.value.includes('ozon.ru')) {
    console.log('Navigating to OZON home...');
    await send('Page.navigate', { url: 'https://www.ozon.ru/' });
    await new Promise(r => setTimeout(r, 5000));
  }

  // 检查登录态（10秒内）
  console.log('\n=== Step 2: 检查登录态 ===');
  for (let i = 0; i < 10; i++) {
    r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, hasNuxt=${state.hasNuxt}`);
    if (!state.isCaptcha && state.hasNuxt === 'object') {
      console.log('  *** OZON 主页已加载! ***');
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Step 3: 提取 cookies
  const client = await send('Page.targetSessionId');  // dummy
  const tabs2 = await getTabs();
  const ozonTab2 = tabs2.find(t => t.url && t.url.includes('ozon.ru')) || tabs2[0];
  const cookiesRes = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] }, null, 0).catch(() => null);
  // Actually use CDP directly
  const directRes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 9222, path: '/json' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.end();
  });

  // Use a fresh CDP connection for getCookies
  const ws2 = new WebSocket(ozonTab2.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws2.on('open', r));
  let nextId2 = 1;
  const pending2 = new Map();
  ws2.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending2.get(m.id);
      if (p) { pending2.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    }
  });
  function send2(method, params) {
    const id = nextId2++;
    return new Promise((res, rej) => { pending2.set(id, { res, rej }); ws2.send(JSON.stringify({ id, method, params: params || {} })); });
  }

  const c = await send2('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\n=== Cookies (${c.cookies.length}):`);
  c.cookies.forEach(co => console.log(`  ${co.name}=${co.value.slice(0, 60)}...`));

  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: c.cookies.map(co => `${co.name}=${co.value}`).join('; '),
    cookiesList: c.cookies,
  }, null, 2));

  // Step 4: 访问 search-by-image 页面
  console.log('\n=== Step 3: 访问 search-by-image ===');
  await send2('Page.navigate', { url: 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586' });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    r = await send2('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, bodyLen: document.body?.innerHTML?.length || 0, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, hasNuxt=${state.hasNuxt}, bodyLen=${state.bodyLen}`);
    if (!state.isCaptcha && state.hasNuxt === 'object' && state.bodyLen > 10000) {
      console.log('  *** SEARCH RESULTS LOADED ***');
      console.log('    requestID:', state.requestID);
      break;
    }
  }

  // Step 5: 抓商品
  console.log('\n=== Step 4: 提取商品 ===');
  r = await send2('Runtime.evaluate', {
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

  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    requestID: await (await send2('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value,
    products,
  }, null, 2));
  console.log('\nSaved to ozon-products.json');

  // Don't close browser
  console.log('\nKeeping Chrome open for inspection...');
  await new Promise(r => setTimeout(r, 600000));
  proc.kill();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });