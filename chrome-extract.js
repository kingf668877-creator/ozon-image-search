// 让 Chrome 实际执行 challenge，捕获通过后的 cookies + 重新请求 search-by-image
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
      '--proxy-server=socks5://127.0.0.1:1080',
      '--proxy-bypass-list=<-loopback>,127.0.0.1',
    ],
  });
  console.log('Chrome launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 捕获 challenge 提交响应
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('abt/result') || url.includes('search-by-image') || url.includes('__rr=1')) {
      console.log('  [resp]', resp.status(), url.slice(0, 100));
      if (url.includes('abt/result')) {
        try {
          const text = await resp.text();
          console.log('  [resp body]', text.slice(0, 200));
        } catch (e) {}
      }
    }
  });

  // 拦截 fetch 和 form 提交
  await page.evaluateOnNewDocument(() => {
    window.__captures = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '?';
      const opts = args[1] || {};
      const method = opts.method || 'GET';
      let body = opts.body;
      if (body instanceof FormData) {
        body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[Blob]']));
      } else if (typeof body === 'string') body = body.slice(0, 300);
      window.__captures.push({ ts: Date.now(), kind: 'fetch', url, method, body });
      return origFetch.apply(this, args);
    };
  });

  // 步骤 1: 先访问 ozon.ru 主页让 OZON 给我一个 abt_data cookie
  console.log('\n[Step 1] GET https://www.ozon.ru/ (init)');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) { console.log('  err:', e.message); }

  // 步骤 2: 访问 search-by-image URL (会触发 captcha)
  console.log('\n[Step 2] GET search-by-image page (triggers challenge)');
  try {
    await page.goto('https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('  err:', e.message); }

  console.log('\n[Step 3] Wait 30s for JS challenge to execute');
  await new Promise(r => setTimeout(r, 30000));

  console.log('\n[Step 4] Check current state and captures');
  const captures = await page.evaluate(() => window.__captures || []);
  console.log('Captures:');
  captures.forEach(c => console.log('  ', JSON.stringify(c).slice(0, 250)));

  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
  }));
  console.log('State:', JSON.stringify(state));

  // 步骤 5: 提取 cookies 后，关闭浏览器，用纯 API + 这些 cookies 试一次
  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('\nFinal cookies:');
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 60)}...`));

  // Save
  require('fs').writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-cookies.json', JSON.stringify({
    cookies: cookiesRes.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookiesList: cookiesRes.cookies,
  }, null, 2));

  console.log('\nWaiting 5 min for you to inspect...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });