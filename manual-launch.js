// 启动 Chrome with debug port - 用子目录 profile
const { exec, execSync } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

async function getDebugTabs(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForChrome(port, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const tabs = await getDebugTabs(port); if (tabs.length > 0) return tabs; } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Chrome not ready');
}

async function main() {
  const port = 9225;
  // 使用独立 profile directory (不能与现有 Chrome 共享)
  const profileDir = path.join('F:\\traehuihua\\6a7c43465a320f293c88f40c\\ozon-image-search', '.chrome-profile');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  console.log(`Launching Chrome with debug port ${port}...`);
  console.log(`Profile: ${profileDir}`);

  const proc = exec(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ` +
    `--remote-debugging-port=${port} --user-data-dir="${profileDir}" --no-sandbox --no-first-run --window-size=1920,1080 --lang=ru-RU`,
    { windowsHide: false });

  let chromeOutput = '';
  proc.stdout.on('data', d => { chromeOutput += d.toString(); });
  proc.stderr.on('data', d => { chromeOutput += d.toString(); });

  let tabs;
  try {
    tabs = await waitForChrome(port);
  } catch (e) {
    console.log('Chrome debug port did not open');
    console.log('Output:', chromeOutput.slice(0, 1000));
    proc.kill();
    return;
  }

  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru')) || tabs[0];
  console.log('Target tab:', ozonTab.url);

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

  console.log('\n=== Step 1: 加载 OZON 主页 ===');
  await send('Page.navigate', { url: 'https://www.ozon.ru/' });

  let homeOk = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot"), cookies: document.cookie.slice(0, 100)})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, cookies: ${state.cookies.slice(0, 60)}`);
    if (!state.isCaptcha && state.hasNuxt === 'object') {
      homeOk = true;
      console.log(`\n  *** HOME OK! requestID: ${state.requestID} ***`);
      break;
    }
  }

  if (!homeOk) {
    console.log('\n  等 5 分钟让你手动操作...');
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
        returnByValue: true,
      });
      const state = JSON.parse(r.result.value);
      if (i % 10 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, captcha=${state.isCaptcha}`);
      if (!state.isCaptcha && state.hasNuxt === 'object') {
        homeOk = true;
        console.log('  *** HOME OK! ***');
        break;
      }
    }
  }

  if (!homeOk) {
    console.log('  Home page failed.');
    console.log('  保持 Chrome 开启 5 分钟...');
    await new Promise(r => setTimeout(r, 300000));
    proc.kill();
    return;
  }

  // Save cookies
  const cookies = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\n  Cookies (${cookies.cookies.length}):`);
  cookies.cookies.forEach(c => console.log(`    ${c.name}=${c.value.slice(0, 60)}...`));
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookies.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookies.cookies,
  }, null, 2));

  console.log('\n=== Step 2: Navigate to search-by-image ===');
  await send('Page.navigate', { url: 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586' });

  let searchOk = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, bodyLen: document.body?.innerHTML?.length || 0, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    if (i % 2 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, bodyLen=${state.bodyLen}`);
    if (!state.isCaptcha && state.hasNuxt === 'object' && state.bodyLen > 10000) {
      searchOk = true;
      console.log(`\n  *** SEARCH OK! requestID: ${state.requestID} ***`);
      break;
    }
  }

  if (!searchOk) {
    console.log('\n  等 5 分钟手动过 captcha...');
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title, hasNuxt: typeof window.__NUXT__, requestID: window.__NUXT__?.state?.requestID || null, isCaptcha: document.title.includes("Похоже") || document.title.includes("Antibot")})',
        returnByValue: true,
      });
      const state = JSON.parse(r.result.value);
      if (i % 10 === 0) console.log(`  [${(i+1)*2}s] captcha=${state.isCaptcha}, requestID=${state.requestID}`);
      if (!state.isCaptcha && state.hasNuxt === 'object' && state.requestID) {
        searchOk = true;
        console.log('  *** SEARCH OK! ***');
        break;
      }
    }
  }

  if (!searchOk) {
    console.log('  Search failed.');
    console.log('  保持 Chrome 开启 5 分钟...');
    await new Promise(r => setTimeout(r, 300000));
    proc.kill();
    return;
  }

  console.log('\n=== Step 3: 提取商品 ===');
  await new Promise(r => setTimeout(r, 5000));

  const r = await send('Runtime.evaluate', {
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

  const cookies2 = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  const requestID = await (await send('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value;
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookies2.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookies2.cookies,
    requestID,
  }, null, 2));
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    requestID,
    products,
  }, null, 2));
  console.log('\n  Saved cookies + products.');

  console.log('\n  保持 Chrome 开启 10 分钟...');
  await new Promise(r => setTimeout(r, 600000));
  proc.kill();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });