// CDP 通过 Edge + WARP SOCKS5 测试
const { exec } = require('child_process');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const fs = require('fs');

const WARP = 'socks5://127.0.0.1:1080';

async function cdpFetch(target) {
  // 启动 Edge with WARP SOCKS5 proxy
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=9222',
    '--proxy-server=' + WARP,
    '--proxy-bypass-list=<-loopback>',
    '--user-data-dir=C:\\Users\\Administrator\\.trae-cn\\edge-ozon-warp',
    '--lang=ru-RU',
    '--window-size=1920,1080',
  ];
  console.log('Launching Edge with', args.join(' '));
  const proc = exec('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ' + args.map(a => '"' + a + '"').join(' '));
  proc.stdout.on('data', d => process.stdout.write('EDGE OUT: ' + d));
  proc.stderr.on('data', d => process.stderr.write('EDGE ERR: ' + d));

  // wait for CDP
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const tabs = await new Promise((r, rj) => {
          http.get('http://127.0.0.1:9222/json', (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => r(JSON.parse(body)));
          }).on('error', rj);
        });
        if (tabs.length > 0) {
          clearInterval(timer);
          resolve(tabs[0]);
        }
      } catch (e) {}
    }, 1000);
    setTimeout(() => { clearInterval(timer); resolve(null); }, 15000);
  });

  const tabs = await new Promise((r, rj) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => r(JSON.parse(body)));
    }).on('error', rj);
  });
  if (!tabs.length) {
    console.log('No tabs found');
    proc.kill();
    return;
  }
  const tab = tabs.find(t => t.type === 'page') || tabs[0];
  console.log('Tab:', tab.url, 'WS:', tab.webSocketDebuggerUrl);

  const WebSocket = require('ws');
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let nextId = 1;
  const pending = new Map();
  const handlers = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
      }
    } else if (m.method) {
      handlers.forEach(h => { if (h.event === m.method) h.cb(m.params); });
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  console.log('Navigating to https://www.ozon.ru/ ...');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: target });

  // Wait 10 seconds
  await new Promise(r => setTimeout(r, 10000));

  // Get cookies
  const cookies = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  console.log('\n=== Cookies ===');
  cookies.cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0, 40)} (${c.domain})`));

  // Get title
  const titleRes = await send('Runtime.evaluate', { expression: 'document.title' });
  console.log('\nTitle:', titleRes.result.value);

  // Get fingerprint
  const fpRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      hasNuxt: typeof window.__NUXT__ !== 'undefined',
      requestID: window.__NUXT__?.state?.requestID || null,
      bodyLen: document.body ? document.body.innerHTML.length : 0,
    })`
  });
  console.log('FP:', fpRes.result.value);

  // Check if captcha
  const captchaRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      isCaptcha: document.body.innerHTML.includes('abt_data') || document.body.innerHTML.includes('Похоже, нет'),
      isOz: document.body.innerHTML.includes('OZON') || document.body.innerHTML.includes('Ozon'),
      title: document.title,
    })`
  });
  console.log('Status:', captchaRes.result.value);

  ws.close();
  proc.kill();
}

cdpFetch('https://www.ozon.ru/').catch(e => { console.error('FATAL:', e); process.exit(1); });