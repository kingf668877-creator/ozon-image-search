// 用 Edge + WARP SOCKS5 实际访问 OZON 看是否能拿到真页面（不是 captcha）
const { exec } = require('child_process');
const http = require('http');
const fs = require('fs');

async function cdpBoot() {
  // 清理已有实例
  try { exec('taskkill /F /IM msedge.exe /T 2>nul'); } catch (e) {}

  // 启动 Edge with WARP SOCKS5
  const userDataDir = 'C:\\Users\\Administrator\\.trae-cn\\edge-boot-' + Date.now();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=9334',
    '--proxy-server=socks5://127.0.0.1:1080',
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${userDataDir}`,
    '--lang=ru-RU',
    '--window-size=1920,1080',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  ];
  console.log('Launching Edge...');
  const proc = exec('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ' + args.map(a => '"' + a + '"').join(' '));
  proc.stdout.on('data', d => console.log('OUT:', d.toString().slice(0, 200)));
  proc.stderr.on('data', d => console.log('ERR:', d.toString().slice(0, 200)));

  // Wait for CDP
  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const tabs = await new Promise((r, rj) => {
        http.get('http://127.0.0.1:9334/json', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => r(JSON.parse(body)));
        }).on('error', rj);
      });
      if (tabs.length) {
        const tab = tabs.find(t => t.type === 'page') || tabs[0];
        wsUrl = tab.webSocketDebuggerUrl;
        console.log('Tab:', tab.url, 'WS:', wsUrl.slice(0, 80));
        break;
      }
    } catch (e) {}
  }

  if (!wsUrl) {
    console.log('CDP not ready');
    proc.kill();
    return;
  }

  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
      }
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  await send('Page.enable');
  await send('Network.enable');
  console.log('Navigating to https://www.ozon.ru/ ...');
  await send('Page.navigate', { url: 'https://www.ozon.ru/' });

  // Wait for page to fully load (OZON typically redirects)
  await new Promise(r => setTimeout(r, 8000));

  // Get cookies
  const cookies = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('\n=== Cookies ===');
  cookies.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 40)} (${c.domain}, ${c.path})`));

  // Get fingerprint
  const fpRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      title: document.title,
      hasNuxt: typeof window.__NUXT__ !== 'undefined',
      requestID: window.__NUXT__?.state?.requestID || null,
      bodyLen: document.body ? document.body.innerHTML.length : 0,
      isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
      isOz: document.body.innerHTML.includes('OZON') || document.body.innerHTML.includes('Ozon'),
    })`,
    returnByValue: true,
  });
  console.log('\n=== Fingerprint ===');
  console.log(fpRes.result.value);

  // Save cookies + requestID
  const cookieData = cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const fp = JSON.parse(fpRes.result.value);
  fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/session.json', JSON.stringify({
    cookies: cookieData,
    cookiesList: cookies.cookies,
    requestID: fp.requestID,
    url: fp.url,
    title: fp.title,
    isCaptcha: fp.isCaptcha,
    isOz: fp.isOz,
  }, null, 2));
  console.log('\nSaved session to session.json');

  ws.close();
  proc.kill();
}

cdpBoot().catch(e => { console.error('FATAL:', e); process.exit(1); });