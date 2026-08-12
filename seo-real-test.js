// 用真实 Chrome（headless: false）但通过 CDP 控制
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
  console.log('Chrome (headed) launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  });

  console.log('Loading search-by-image page (real Chrome)...');
  const targetUrl = 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586';
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Waiting for JS challenge...');
  let finalUrl = targetUrl;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      isChallenge: document.title.includes('Antibot') || document.title.includes('Похоже'),
      hasProducts: !!document.querySelector('[data-state]') || (window.__NUXT__ && Object.keys(window.__NUXT__?.state || {}).length > 0),
    }));
    if (i % 3 === 0) console.log(`[${i+1}s] url=${info.url.slice(0, 80)}, title=${info.title.slice(0, 50)}, challenge=${info.isChallenge}`);
    if (!info.isChallenge && info.url !== targetUrl) {
      finalUrl = info.url;
      console.log('  *** CHALLENGE PASSED! ***');
      break;
    }
  }

  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\nFinal URL: ${finalUrl}`);
  console.log(`Cookies (${cookiesRes.cookies.length}):`);
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 40)}...`));

  if (finalUrl !== targetUrl) {
    await new Promise(r => setTimeout(r, 3000));
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
    console.log(`\n*** PRODUCTS FOUND: ${products.length} ***`);
    products.forEach((p, i) => console.log(`[${i+1}] ${p.title.slice(0, 80)} | ${p.price} ₽ | ${p.url.slice(0, 100)}`));
  }

  // Save cookies
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookiesRes.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookiesRes.cookies,
    requestID: await page.evaluate(() => window.__NUXT__?.state?.requestID || null),
  }, null, 2));

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });