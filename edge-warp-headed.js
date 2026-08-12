// Edge + WARP + headed 模式
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--lang=ru-RU',
      '--proxy-server=socks5://127.0.0.1:1080',
      '--proxy-bypass-list=<-loopback>,127.0.0.1',
    ],
  });
  console.log('Edge (headed) + WARP launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  });

  const targetUrl = 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586';
  console.log('Loading:', targetUrl);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for challenge to pass
  console.log('Waiting for JS challenge to complete...');
  let finalUrl = targetUrl;
  let finalTitle = '';
  let challengeAttempts = 0;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      isChallenge: document.title.includes('Antibot') || document.title.includes('Похоже'),
      hasChallengeData: document.getElementById('challenge') !== null,
    }));

    if (info.title.includes('Antibot')) {
      challengeAttempts++;
      if (i % 5 === 0) console.log(`[${i+1}s] Antibot challenge page, waiting for JS...`);
      // 模拟用户交互 — 移动鼠标 + 点击
      if (i === 5 || i === 15 || i === 25) {
        try {
          await page.mouse.move(500 + i * 10, 300 + i * 5);
          await page.mouse.down();
          await new Promise(r => setTimeout(r, 100));
          await page.mouse.up();
          console.log(`  [${i+1}s] simulated mouse click`);
        } catch (e) {}
      }
    } else if (info.title.includes('Похоже')) {
      if (i % 5 === 0) console.log(`[${i+1}s] "No connection" page (OZON captcha)`);
      // 也尝试刷新
      if (i === 10 || i === 30) {
        console.log(`  [${i+1}s] trying to reload...`);
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
      }
    } else {
      finalUrl = info.url;
      finalTitle = info.title;
      console.log(`[${i+1}s] URL=${info.url.slice(0, 80)} title=${info.title.slice(0, 50)}`);
      if (info.url !== targetUrl) {
        console.log('  *** CHALLENGE PASSED! ***');
        break;
      }
    }
  }

  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\nFinal URL: ${finalUrl}`);
  console.log(`Final title: ${finalTitle}`);
  console.log(`Cookies (${cookiesRes.cookies.length}):`);
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 50)}...`));

  if (finalUrl !== targetUrl && !finalTitle.includes('Похоже')) {
    console.log('\nWaiting for results to render...');
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
      return out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 20);
    });
    console.log(`\n*** PRODUCTS FOUND: ${products.length} ***`);
    products.forEach((p, i) => {
      console.log(`[${i+1}] ${p.title.slice(0, 80)}`);
      console.log(`    ${p.price} ₽ | rating=${p.rating} reviews=${p.reviews}`);
      console.log(`    ${p.url.slice(0, 100)}`);
    });

    // Save to file
    require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
      imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
      timestamp: Date.now(),
      products,
    }, null, 2));
    console.log('\nSaved to ozon-products.json');
  } else {
    console.log('\n*** Challenge did NOT pass ***');
    console.log('Page is showing captcha / "no connection" page');
  }

  // Save cookies
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookiesRes.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookiesRes.cookies,
  }, null, 2));

  // Don't close so user can inspect
  console.log('\nBrowser will stay open for 5 minutes for inspection...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });