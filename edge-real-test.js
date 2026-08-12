// 用 Edge + WARP + 多等待时间让 captcha JS challenge 通过
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
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
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  console.log('Navigating to OZON via Edge + WARP...');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log('goto err:', e.message);
  }
  // 长等，让 captcha JS 评估完成
  console.log('Waiting 15s for captcha challenge to evaluate...');
  await new Promise(r => setTimeout(r, 15000));

  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
    isHome: document.body.innerHTML.includes('OZON') && !document.body.innerHTML.includes('Похоже, нет'),
    hasNuxt: typeof window.__NUXT__,
    requestID: window.__NUXT__?.state?.requestID || null,
    bodyLen: document.body.innerHTML.length,
  }));
  console.log('INFO:', JSON.stringify(info));

  if (info.isCaptcha || !info.isHome) {
    console.log('*** Still blocked or not on real page ***');
    await browser.close();
    return;
  }

  console.log('*** ON REAL OZON PAGE ***');
  // 4-stage image search
  const result = await page.evaluate(async () => {
    const fd = new FormData();
    fd.append('url', 'https://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg');
    fd.append('sourceMetadata', JSON.stringify({ width: 1024, height: 1024, type: 'image/jpeg' }));
    const upRes = await fetch('/api/composer-api.bx/_action/searchByImageUpload', {
      method: 'POST', body: fd, credentials: 'include',
    });
    const upJson = await upRes.json();
    console.log('upload result:', upJson);
    if (!upJson.imageId) return { error: 'upload failed', detail: upJson };
    const cropRes = await fetch('/api/composer-api.bx/_action/searchByImage', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: upJson.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }),
    });
    const cropJson = await cropRes.json();
    return { imageId: upJson.imageId, redirectUri: cropJson.redirectUri, resultId: cropJson.resultId };
  });
  console.log('Upload+crop result:', JSON.stringify(result));

  if (result.redirectUri) {
    const fullUrl = result.redirectUri.startsWith('http') ? result.redirectUri : 'https://www.ozon.ru' + result.redirectUri;
    console.log('Navigating to results:', fullUrl);
    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 30000 });
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
          out.push({ url: n.link, title: n.title, price: String(n.price || n.finalPrice), image: n.image || n.imageUrl });
          return;
        }
        for (const k of Object.keys(n)) { if (k === '__proto__') continue; walk(n[k]); }
      }
      candidates.forEach(walk);
      const seen = new Set();
      return out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 10);
    });
    console.log('*** PRODUCTS FOUND:', products.length);
    products.forEach((p, i) => console.log(`  [${i+1}] ${p.title.slice(0, 80)} | ${p.price} ₽`));
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });