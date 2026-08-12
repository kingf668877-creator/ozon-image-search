// 完全手动登录OZON后，自动抓取图搜结果
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
  console.log('Chrome launched.');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 第一步: 导航到OZON登录页
  console.log('\n[Step 1] Navigating to OZON...');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  // 等用户登录（10分钟窗口）
  console.log('\n[Step 2] 请在浏览器中登录OZON（10分钟窗口）');
  console.log('  我会检测您是否登录成功...');

  let loggedIn = false;
  for (let i = 0; i < 300; i++) {  // 300 * 2s = 600s = 10min
    await new Promise(r => setTimeout(r, 2000));
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      isCaptcha: document.title.includes('Похоже'),
      hasNuxt: typeof window.__NUXT__,
      requestID: window.__NUXT__?.state?.requestID || null,
    }));
    if (i % 5 === 0) {
      console.log(`[${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}`);
    }
    // 登录成功标志: 不在 captcha 页 + OZON 主页
    if (!state.isCaptcha && state.url === 'https://www.ozon.ru/' && state.hasNuxt === 'object') {
      loggedIn = true;
      console.log(`\n  *** LOGGED IN! requestID: ${state.requestID} ***`);
      break;
    }
  }

  if (!loggedIn) {
    console.log('\n  Login timeout. 重新尝试...');
    // 不退出，继续等
  }

  // 提取登录后的 cookies
  const client = await page.target().createCDPSession();
  const cookies1 = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('\n  Login cookies:');
  cookies1.cookies.forEach(c => console.log(`    ${c.name}=${c.value.slice(0, 60)}...`));

  // 第二步: 访问 search-by-image
  console.log('\n[Step 3] 访问 search-by-image 页面...');
  try {
    await page.goto('https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  await new Promise(r => setTimeout(r, 5000));

  // 检测是否再次出现 captcha
  let searchPassed = false;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      isCaptcha: document.title.includes('Похоже'),
      hasNuxt: typeof window.__NUXT__,
      requestID: window.__NUXT__?.state?.requestID || null,
      bodyLen: document.body ? document.body.innerHTML.length : 0,
    }));
    if (i % 3 === 0) console.log(`  [${(i+1)*2}s] url=${state.url.slice(0, 80)}, title=${state.title.slice(0, 30)}, captcha=${state.isCaptcha}, hasNuxt=${state.hasNuxt}, bodyLen=${state.bodyLen}`);
    if (!state.isCaptcha && state.hasNuxt === 'object' && state.bodyLen > 10000) {
      searchPassed = true;
      console.log(`\n  *** SEARCH PAGE LOADED! requestID: ${state.requestID} ***`);
      break;
    }
  }

  if (!searchPassed) {
    console.log('\n  Search page failed. 等待手动完成 captcha（5分钟窗口）...');
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        isCaptcha: document.title.includes('Похоже'),
        hasNuxt: typeof window.__NUXT__,
        requestID: window.__NUXT__?.state?.requestID || null,
      }));
      if (i % 5 === 0) console.log(`  [${(i+1)*2}s] captcha=${state.isCaptcha}, hasNuxt=${state.hasNuxt}, requestID=${state.requestID}`);
      if (!state.isCaptcha && state.hasNuxt === 'object' && state.requestID) {
        searchPassed = true;
        console.log(`\n  *** SEARCH PASSED! ***`);
        break;
      }
    }
  }

  if (!searchPassed) {
    console.log('\n  完全失败。保存 cookies 以备后用。');
    const cookies2 = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
    require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
      cookies: cookies2.cookies.map(c => `${c.name}=${c.value}`).join('; '),
      cookiesList: cookies2.cookies,
    }, null, 2));
    await browser.close();
    return;
  }

  // 抓商品
  console.log('\n[Step 4] 等待商品加载...');
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

  console.log(`\n  *** PRODUCTS FOUND: ${products.length} ***`);
  products.forEach((p, i) => {
    console.log(`\n  [${i+1}] ${p.title.slice(0, 80)}`);
    console.log(`      ${p.price} ₽ | rating=${p.rating} reviews=${p.reviews}`);
    console.log(`      ${p.url.slice(0, 100)}`);
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
    requestID: await page.evaluate(() => window.__NUXT__?.state?.requestID || null),
    products,
  }, null, 2));
  console.log('\n  Saved cookies + products.');

  console.log('\n  等待 10 分钟后关闭...');
  await new Promise(r => setTimeout(r, 600000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });