// Edge + WARP + headed, 长时间等 + 不 reload
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
  console.log('Edge launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('console', m => console.log('  [console]', m.type(), m.text().slice(0, 200)));
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)));
  page.on('requestfailed', r => console.log('  [reqfail]', r.url().slice(0, 100), r.failure()?.errorText));

  // 关键：在请求被发送前注入 hook，捕获 challenge 提交
  await page.evaluateOnNewDocument(() => {
    window.__challengeLogs = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      window.__challengeLogs.push({ url: args[0], method: args[1]?.method || 'GET', time: Date.now() });
      const resp = await origFetch.apply(this, args);
      window.__challengeLogs.push({ url: args[0], status: resp.status, time: Date.now() });
      return resp;
    };
  });

  const targetUrl = 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586';
  console.log('Loading:', targetUrl);
  await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });

  console.log('Waiting 90s for challenge to complete...');
  await new Promise(r => setTimeout(r, 90000));

  console.log('\n=== Challenge logs ===');
  const logs = await page.evaluate(() => window.__challengeLogs || []);
  logs.forEach(l => console.log(JSON.stringify(l)));

  console.log('\n=== Current state ===');
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    isCaptcha: document.title.includes('Похоже'),
    isChallenge: document.title.includes('Antibot'),
    bodyStart: document.body ? document.body.innerHTML.slice(0, 300) : '',
    hasNuxt: typeof window.__NUXT__,
    requestID: window.__NUXT__?.state?.requestID || null,
  }));
  console.log('URL:', info.url);
  console.log('Title:', info.title);
  console.log('isCaptcha:', info.isCaptcha);
  console.log('isChallenge:', info.isChallenge);
  console.log('hasNuxt:', info.hasNuxt);
  console.log('requestID:', info.requestID);
  console.log('body[:300]:', info.bodyStart);

  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\nCookies (${cookiesRes.cookies.length}):`);
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 50)}... (${c.domain})`));

  await new Promise(r => setTimeout(r, 600000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });