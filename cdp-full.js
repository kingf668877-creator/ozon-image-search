// 用 Edge + WARP 跑完整图搜流程
const { exec } = require('child_process');
const http = require('http');
const fs = require('fs');

async function run() {
  try { exec('taskkill /F /IM msedge.exe /T 2>nul'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const userDataDir = 'C:\\Users\\Administrator\\.trae-cn\\edge-search-' + Date.now();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=9444',
    '--proxy-server=socks5://127.0.0.1:1080',
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${userDataDir}`,
    '--lang=ru-RU',
    '--window-size=1920,1080',
  ];
  console.log('Launching Edge...');
  const proc = exec('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ' + args.map(a => '"' + a + '"').join(' '));
  proc.stderr.on('data', d => {});

  // Wait for CDP
  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const tabs = await new Promise((r, rj) => {
        http.get('http://127.0.0.1:9444/json', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => r(JSON.parse(body)));
        }).on('error', rj);
      });
      if (tabs.length) {
        const tab = tabs.find(t => t.type === 'page') || tabs[0];
        wsUrl = tab.webSocketDebuggerUrl;
        console.log('Tab ready:', tab.url);
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

  // Step 1: 导航到 OZON 主页 (拿 cookies)
  console.log('Step 1: goto https://www.ozon.ru/');
  await send('Page.navigate', { url: 'https://www.ozon.ru/' });
  await new Promise(r => setTimeout(r, 8000));

  const cookiesRes = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  const cookieH = cookiesRes.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log('  Got', cookiesRes.cookies.length, 'cookies');
  console.log('  Cookie string:', cookieH.slice(0, 200));

  // Step 2: 直接 POST upload (在同一个 page context)
  console.log('\nStep 2: POST searchByImageUpload in page context');
  const uploadResult = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const fd = new FormData();
          fd.append('url', 'https://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg');
          fd.append('sourceMetadata', JSON.stringify({ width: 1024, height: 1024, type: 'image/jpeg' }));
          const res = await fetch('/api/composer-api.bx/_action/searchByImageUpload', {
            method: 'POST',
            body: fd,
            credentials: 'include',
            headers: {
              'x-o3-app-name': 'dweb_client',
              'x-o3-app-version': 'release_csma_20260807-1',
              'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
              'x-page-previous': 'home',
              'x-page-view-id': crypto.randomUUID(),
              'x-o3-parent-requestid': crypto.randomUUID(),
            },
          });
          const text = await res.text();
          return JSON.stringify({
            status: res.status,
            ct: res.headers.get('content-type'),
            bodyStart: text.slice(0, 500),
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('  upload result:', uploadResult.result?.value);

  let uploadJson = null;
  try {
    const u = JSON.parse(uploadResult.result?.value || '{}');
    if (u.bodyStart) {
      try {
        uploadJson = JSON.parse(u.bodyStart);
      } catch (e) {}
    }
  } catch (e) {}

  if (uploadJson && uploadJson.imageId) {
    console.log('  *** IMAGE UPLOADED:', uploadJson.imageId, '***');

    // Step 3: crop
    const cropResult = await send('Runtime.evaluate', {
      expression: `
        (async () => {
          try {
            const res = await fetch('/api/composer-api.bx/_action/searchByImage', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'x-o3-app-name': 'dweb_client',
                'x-o3-app-version': 'release_csma_20260807-1',
                'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
                'x-page-previous': 'home',
                'x-page-view-id': crypto.randomUUID(),
                'x-o3-parent-requestid': crypto.randomUUID(),
              },
              body: JSON.stringify({
                imageId: ${JSON.stringify(uploadJson.imageId)},
                cropRectangle: { left: 0, top: 0, width: 1, height: 1 },
              }),
            });
            const text = await res.text();
            return JSON.stringify({ status: res.status, bodyStart: text.slice(0, 500) });
          } catch (e) { return JSON.stringify({ error: e.message }); }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log('  crop result:', cropResult.result?.value);
    let cropJson = null;
    try {
      const c = JSON.parse(cropResult.result?.value || '{}');
      if (c.bodyStart) {
        try { cropJson = JSON.parse(c.bodyStart); } catch (e) {}
      }
    } catch (e) {}

    if (cropJson && cropJson.redirectUri) {
      console.log('  *** REDIRECT URI:', cropJson.redirectUri, '***');

      // Step 4: 跟随 redirect 拿 results
      const fullUrl = cropJson.redirectUri.startsWith('http')
        ? cropJson.redirectUri
        : 'https://www.ozon.ru' + cropJson.redirectUri;
      await send('Page.navigate', { url: fullUrl });
      await new Promise(r => setTimeout(r, 4000));

      const productsResult = await send('Runtime.evaluate', {
        expression: `
          JSON.stringify({
            url: location.href,
            title: document.title,
            isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
            products: (() => {
              const out = [];
              const candidates = [];
              document.querySelectorAll('[data-state]').forEach(el => {
                try { candidates.push(JSON.parse(el.getAttribute('data-state') || '{}')); } catch (e) {}
              });
              if (window.__NUXT__?.state) candidates.push(window.__NUXT__.state);
              function walk(n) {
                if (!n || typeof n !== 'object') return;
                if (Array.isArray(n)) { n.forEach(walk); return; }
                if (n.link && n.title && (n.price != null || n.finalPrice != null)) {
                  out.push({ url: n.link, title: n.title, price: n.price || n.finalPrice });
                  return;
                }
                for (const k of Object.keys(n)) { if (k === '__proto__') continue; walk(n[k]); }
              }
              candidates.forEach(walk);
              const seen = new Set();
              return out.filter(p => seen.has(p.url) ? false : (seen.add(p.url), true)).slice(0, 10);
            })(),
          })
        `,
        returnByValue: true,
      });
      const prodJson = JSON.parse(productsResult.result.value);
      console.log('  result page:', prodJson.url);
      console.log('  isCaptcha:', prodJson.isCaptcha);
      console.log('  products found:', prodJson.products.length);
      prodJson.products.forEach((p, i) => {
        console.log(`    [${i+1}] ${p.title.slice(0, 80)}`);
        console.log(`        ${p.price} ₽ | ${p.url.slice(0, 100)}`);
      });
    }
  }

  ws.close();
  proc.kill();
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });