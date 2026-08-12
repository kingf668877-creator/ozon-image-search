// 完整混合方案：Edge boot + 纯 API 跑后续
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const zlib = require('zlib');
const crypto = require('crypto');

let bootCookie = '';
let bootCookiesList = [];

async function cdpBoot() {
  try { exec('taskkill /F /IM msedge.exe /T 2>nul'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const userDataDir = 'C:\\Users\\Administrator\\.trae-cn\\edge-final-' + Date.now();
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=9556',
    '--proxy-server=socks5://127.0.0.1:1080',
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${userDataDir}`,
    '--lang=ru-RU', '--window-size=1920,1080',
  ];
  const proc = exec('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ' + args.map(a => '"' + a + '"').join(' '));

  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const tabs = await new Promise((r, rj) => {
        http.get('http://127.0.0.1:9556/json', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => r(JSON.parse(body)));
        }).on('error', rj);
      });
      if (tabs.length) {
        wsUrl = tabs.find(t => t.type === 'page')?.webSocketDebuggerUrl || tabs[0].webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }
  if (!wsUrl) { proc.kill(); return null; }

  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }

  await send('Page.enable');
  await send('Network.enable');
  console.log('[BROWSER] Navigating to https://www.ozon.ru/...');
  await send('Page.navigate', { url: 'https://www.ozon.ru/' });
  await new Promise(r => setTimeout(r, 10000));

  const cookies = await send('Network.getCookies', { urls: ['https://www.ozon.ru/'] });
  bootCookie = cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  bootCookiesList = cookies.cookies;
  console.log('[BROWSER] Got', cookies.cookies.length, 'cookies');

  ws.close();
  proc.kill();
  return bootCookie;
}

function apiCall(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
    const opts = {
      host: 'www.ozon.ru', path, method, agent, rejectUnauthorized: false, timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Cookie': bootCookie,
        'Origin': 'https://www.ozon.ru',
        'Referer': 'https://www.ozon.ru/',
        'x-o3-app-name': 'dweb_client',
        'x-o3-app-version': 'release_csma_20260807-1',
        'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
        'x-page-view-id': crypto.randomUUID(),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) raw = zlib.gunzipSync(raw); else if (enc.includes('br')) raw = zlib.brotliDecompressSync(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8') });
      });
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const cookieH = await cdpBoot();
  if (!cookieH) { console.log('Boot failed'); process.exit(1); }

  console.log('\n[API] GET /?__rr=1 (follow initial redirect)');
  let r = await apiCall('GET', '/?__rr=1', null, { 'sec-fetch-site': 'same-origin' });
  console.log('  status:', r.status, 'length:', r.body.length);
  if (r.body.includes('Похоже, нет')) { console.log('  STILL CAPTCHA'); console.log(r.body.slice(0, 500)); }

  // Try to extract requestID
  let requestID = (r.body.match(/"requestID"\s*:\s*"([^"]+)"/) || [])[1];
  if (!requestID) requestID = crypto.randomUUID();
  console.log('  requestID:', requestID.slice(0, 30) + '...');

  console.log('\n[API] POST upload (searchByImageUpload)');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  r = await apiCall('POST', '/api/composer-api.bx/_action/searchByImageUpload', uploadBody, {
    'Content-Type': 'multipart/form-data; boundary=' + b,
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
  });
  console.log('  status:', r.status);
  console.log('  body[:500]:', r.body.slice(0, 500));
  let rj;
  try { rj = JSON.parse(r.body); } catch (e) {}
  if (rj && rj.imageId) {
    console.log('  *** IMAGE UPLOADED:', rj.imageId, '***');

    console.log('\n[API] POST crop (searchByImage)');
    const cropBody = JSON.stringify({ imageId: rj.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } });
    r = await apiCall('POST', '/api/composer-api.bx/_action/searchByImage', cropBody, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
    });
    console.log('  status:', r.status);
    console.log('  body[:300]:', r.body.slice(0, 300));
    let r4j;
    try { r4j = JSON.parse(r.body); } catch (e) {}
    if (r4j && r4j.redirectUri) {
      console.log('  *** REDIRECT:', r4j.redirectUri, '***');

      console.log('\n[API] GET results');
      const path = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
      r = await apiCall('GET', path, null, {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'x-page-previous': 'search',
      });
      console.log('  status:', r.status);
      console.log('  body length:', r.body.length);
      if (r.status === 200) {
        // extract products
        const products = [...r.body.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
        const titles = [...r.body.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
        console.log('  *** FOUND', products.length, 'products ***');
        titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
        console.log('\n*** FULL SUCCESS ***');
      }
    }
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });