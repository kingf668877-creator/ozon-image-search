// 用 Edge + WARP + 完整指纹伪装
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
  console.log('Edge + WARP launched');
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('navigating...');
  try {
    await page.goto('https://www.ozon.ru/', { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log('goto error:', e.message);
  }
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const info = await page.evaluate(() => ({
      url: location.href, title: document.title,
      isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
      bodyLen: document.body.innerHTML.length,
    }));
    const client = await page.target().createCDPSession();
    const cookies = await client.send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
    console.log(`[${(i+1)*5}s] cookies=${cookies.cookies.length}, title=${info.title.slice(0, 40)}, captcha=${info.isCaptcha}, bodyLen=${info.bodyLen}`);
    if (!info.isCaptcha) {
      console.log('*** NOT CAPTCHA - success ***');
      const reqID = await page.evaluate(() => window.__NUXT__?.state?.requestID || null);
      console.log('  requestID:', reqID);
      break;
    }
  }
  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });