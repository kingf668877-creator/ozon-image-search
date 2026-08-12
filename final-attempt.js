// 启动 Chrome with debug port + 等待用户登录 + 然后抓数据
const puppeteer = require('puppeteer-core');

(async () => {
  console.log('Launching Chrome with debug port...');
  const profileDir = 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data';

  // 用 connect 而不是 launch，避免重新启动 Chrome
  // 但因为我们需要 debug port，先 launch
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--lang=ru-RU',
      '--remote-debugging-port=9222',
    ],
  });
  console.log('Chrome launched with your profile (should preserve login state)');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('response', async (resp) => {
    if (resp.url().includes('abt/result') || resp.url().includes('search-by-image')) {
      console.log('  [resp]', resp.status(), resp.url().slice(0, 100));
    }
  });

  console.log('\n=== Step 1: 检查登录态 ===');
  console.log('正在打开 OZON...');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  await new Promise(r => setTimeout(r, 3000));

  // Check login state
  for (let i = 0; i < 5; i++) {
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasNuxt: typeof window.__NUXT__,
      cookies: document.cookie.slice(0, 200),
      isCaptcha: document.title.includes('Похоже'),
    }));
    console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, hasNuxt=${state.hasNuxt}, captcha=${state.isCaptcha}`);
    console.log(`         cookies: ${state.cookies}`);
    if (i === 0) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // If on captcha, wait for user to complete it
  let finalUrl = '';
  for (let i = 0; i < 30; i++) {
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasNuxt: typeof window.__NUXT__,
      isCaptcha: document.title.includes('Похоже') || document.title.includes('Antibot'),
    }));
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}`);
    if (!state.isCaptcha && state.hasNuxt === 'object') {
      finalUrl = state.url;
      console.log(`  *** OZON 主页加载完成! ***`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!finalUrl) {
    console.log('  OZON 主页加载失败。');
    return;
  }

  // Save cookies
  const client = await page.target().createCDPSession();
  const cookies = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookies.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookies.cookies,
  }, null, 2));
  console.log(`\n  Saved ${cookies.cookies.length} cookies.`);

  // Step 2: Navigate to search-by-image
  console.log('\n=== Step 2: Navigate to search-by-image ===');
  try {
    await page.goto('https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  let searchUrl = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasNuxt: typeof window.__NUXT__,
      requestID: window.__NUXT__?.state?.requestID || null,
      bodyLen: document.body?.innerHTML?.length || 0,
      isCaptcha: document.title.includes('Похоже') || document.title.includes('Antibot'),
    }));
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, bodyLen=${state.bodyLen}`);
    if (!state.isCaptcha && state.hasNuxt === 'object' && state.bodyLen > 10000) {
      searchUrl = state.url;
      console.log('  *** SEARCH RESULTS LOADED ***');
      console.log('  requestID:', state.requestID);
      break;
    }
  }

  if (!searchUrl) {
    console.log('  Search page failed.');
    console.log('\n  等待 10 分钟以便手动完成 captcha...');
    await new Promise(r => setTimeout(r, 600000));
    return;
  }

  // Step 3: Extract products
  console.log('\n=== Step 3: 提取商品 ===');
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
    return out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 30);
  });

  console.log(`\n*** PRODUCTS FOUND: ${products.length} ***`);
  products.forEach((p, i) => {
    console.log(`\n[${i+1}] ${p.title.slice(0, 80)}`);
    console.log(`    ${p.price} ₽ | rating=${p.rating} reviews=${p.reviews}`);
    console.log(`    ${p.url.slice(0, 100)}`);
  });

  const cookies2 = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookies2.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookies2.cookies,
    requestID: await page.evaluate(() => window.__NUXT__?.state?.requestID || null),
  }, null, 2));
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
    imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
    timestamp: Date.now(),
    products,
  }, null, 2));
  console.log('\n  Saved cookies + products.');

  console.log('\n  保持 Chrome 开启 10 分钟以便检查...');
  await new Promise(r => setTimeout(r, 600000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });