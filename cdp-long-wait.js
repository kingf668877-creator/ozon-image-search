// 详细测试：让 Chrome 长时间停留 OZON，看 captcha 是否会自己解决
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--window-size=1920,1080', '--lang=ru-RU'],
  });
  console.log('browser launched');
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  });
  console.log('navigating to OZON...');
  await page.goto('https://www.ozon.ru/', { waitUntil: 'networkidle2', timeout: 30000 });

  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const client = await page.target().createCDPSession();
    const cookies = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
      hasNuxt: typeof window.__NUXT__ !== 'undefined',
      bodyLen: document.body.innerHTML.length,
    }));
    console.log(`[${(i+1)*5}s] cookies=${cookies.cookies.length}, url=${info.url}, title=${info.title.slice(0, 50)}, isCaptcha=${info.isCaptcha}, hasNuxt=${info.hasNuxt}, bodyLen=${info.bodyLen}`);
    if (!info.isCaptcha) {
      console.log('*** NOT CAPTCHA - success ***');
      console.log('requestID:', await page.evaluate(() => window.__NUXT__?.state?.requestID || null));
      break;
    }
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });