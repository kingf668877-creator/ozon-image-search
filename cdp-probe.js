// 用 Puppeteer 实际访问 OZON 主页，看OZON给的内容
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--lang=ru-RU',
    ],
  });
  console.log('browser launched');
  const page = await browser.newPage();
  page.on('console', m => console.log('  [CONSOLE]', m.text()));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    // 删掉 webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  console.log('navigating...');
  await page.goto('https://www.ozon.ru/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));
  const info = await page.evaluate(() => {
    const cookies = document.cookie;
    const html = document.body ? document.body.innerHTML : '';
    return {
      url: location.href,
      title: document.title,
      cookies,
      cookiesApi: (typeof window.__APP_CONFIG__ !== 'undefined' ? Object.keys(window.__APP_CONFIG__) : 'undefined'),
      hasNuxt: typeof window.__NUXT__,
      isCaptcha: html.includes('Похоже, нет'),
      isCaptchaEn: html.includes('No connection'),
      isHome: html.includes('OZON') && !html.includes('Похоже, нет'),
      bodyLen: html.length,
      bodyStart: html.slice(0, 500),
    };
  });
  console.log('INFO:', JSON.stringify(info, null, 2));

  // 取 cookies via DevTools Protocol
  const client = await page.target().createCDPSession();
  const allCookies = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('CDP cookies:', allCookies.cookies.map(c => `${c.name}=${c.value.slice(0,40)} (${c.domain})`).join(' | '));

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });