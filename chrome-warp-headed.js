// Chrome + WARP + headed, 长时间等 + 抓取所有 fetch 调用
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
  console.log('Chrome + WARP + headed launched');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Hook fetch + XHR
  await page.evaluateOnNewDocument(() => {
    window.__logs = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || 'unknown';
      const method = args[1]?.method || 'GET';
      window.__logs.push({ kind: 'fetch-start', url, method, time: Date.now() });
      try {
        const resp = await origFetch.apply(this, args);
        window.__logs.push({ kind: 'fetch-end', url, status: resp.status, time: Date.now() });
        return resp;
      } catch (e) {
        window.__logs.push({ kind: 'fetch-error', url, error: e.message, time: Date.now() });
        throw e;
      }
    };
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        window.__logs.push({ kind: 'xhr-open', method, url, time: Date.now() });
        return origOpen.apply(this, [method, url, ...rest]);
      };
      return xhr;
    };
  });

  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'log') console.log('  [browser console]', m.type(), m.text().slice(0, 150));
  });
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)));
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('abt') || url.includes('search-by-image') || url.includes('composer')) {
      console.log('  [response]', resp.status(), url.slice(0, 100));
    }
  });

  const targetUrl = 'https://www.ozon.ru/search-by-image?image_id=56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586';
  console.log('Loading:', targetUrl);
  try {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.log('  goto err:', e.message);
  }

  console.log('\nWaiting 90s for JS challenge...');
  await new Promise(r => setTimeout(r, 90000));

  const logs = await page.evaluate(() => window.__logs || []);
  console.log('\n=== Network logs ===');
  logs.filter(l => l.kind === 'fetch-end' || l.kind === 'fetch-error').forEach(l => {
    console.log(JSON.stringify(l));
  });

  console.log('\n=== Page state ===');
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    isCaptcha: document.title.includes('Похоже'),
    isChallenge: document.title.includes('Antibot'),
    requestID: window.__NUXT__?.state?.requestID || null,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    bodyStart: document.body ? document.body.innerHTML.slice(0, 200) : '',
  }));
  console.log(JSON.stringify(info, null, 2));

  const client = await page.target().createCDPSession();
  const cookiesRes = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log(`\nCookies (${cookiesRes.cookies.length}):`);
  cookiesRes.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 50)}...`));

  await new Promise(r => setTimeout(r, 600000));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });