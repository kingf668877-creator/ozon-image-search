// Chrome (headed) 直接连本机 IP 110.90.254.23（不用 WARP）
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--lang=ru-RU',
    ],
  });
  console.log('Chrome (headed, no proxy) launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('abt/result') || url.includes('search-by-image') || url.includes('__rr=1')) {
      let body = '';
      if (url.includes('abt/result')) {
        try { body = ' ' + (await resp.text()).slice(0, 100); } catch (e) {}
      }
      console.log('  [resp]', resp.status(), url.slice(0, 100), body);
    }
  });

  await page.evaluateOnNewDocument(() => {
    window.__captures = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '?';
      const opts = args[1] || {};
      let body = opts.body;
      if (body instanceof FormData) {
        body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 100) : '[Blob]']));
      } else if (typeof body === 'string') body = body.slice(0, 100);
      window.__captures.push({ ts: Date.now(), kind: 'fetch', url, method: opts.method || 'GET', body });
      return origFetch.apply(this, args);
    };
  });

  console.log('\n[Step 1] GET ozon.ru (init cookie)');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) { console.log('  err:', e.message); }

  console.log('\n[Step 2] GET search-by-image (trigger challenge)');
  try {
    await page.goto('https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  console.log('\n[Step 3] Wait 60s for JS challenge to pass');
  await new Promise(r => setTimeout(r, 60000));

  const captures = await page.evaluate(() => window.__captures || []);
  console.log('\n=== Captures ===');
  captures.forEach(c => console.log('  ', JSON.stringify(c).slice(0, 250)));

  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    requestID: window.__NUXT__?.state?.requestID || null,
    hasNuxt: typeof window.__NUXT__,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
  }));
  console.log('\n=== Final state ===');
  console.log(JSON.stringify(state, null, 2));

  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('\n=== Final cookies ===');
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 60)}...`));

  // 如果真页面，提取商品
  if (state.requestID || !state.title.includes('Похоже')) {
    await new Promise(r => setTimeout(r, 5000));
    const products = await page.evaluate(() => {
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
            title: n.title, price: String(n.price || n.finalPrice || ''),
            image: n.image || n.imageUrl || '',
          });
          return;
        }
        for (const k of Object.keys(n)) { if (k === '__proto__') continue; walk(n[k]); }
      }
      candidates.forEach(walk);
      const seen = new Set();
      return out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 20);
    });
    console.log(`\n*** PRODUCTS: ${products.length} ***`);
    products.forEach((p, i) => console.log(`  [${i+1}] ${p.title.slice(0, 80)} | ${p.price} ₽ | ${p.url.slice(0, 80)}`));
    require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify(products, null, 2));
  }

  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookiesRes.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookiesRes.cookies,
  }, null, 2));

  console.log('\nWaiting 5 min for inspection...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });