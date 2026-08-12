// 用 WARP SOCKS5 代理测试完整图搜流程
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const zlib = require('zlib');
const crypto = require('crypto');
const url = require('url');

const WARP = 'socks5://127.0.0.1:1080';

function httpsGet(path, headers) {
  const agent = new SocksProxyAgent(WARP);
  const u = url.parse('https://www.ozon.ru' + path);
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: u.hostname,
      path: u.path,
      headers,
      agent,
      timeout: 30000,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) body = zlib.gunzipSync(body); else if (enc.includes('br')) body = zlib.brotliDecompressSync(body); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function httpsPost(path, headers, body) {
  const agent = new SocksProxyAgent(WARP);
  const u = url.parse('https://www.ozon.ru' + path);
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = https.request({
      host: u.hostname,
      path: u.path,
      method: 'POST',
      headers: { ...headers, 'Content-Length': bodyBuf.length },
      agent,
      timeout: 30000,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) body = zlib.gunzipSync(body); else if (enc.includes('br')) body = zlib.brotliDecompressSync(body); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

const BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'x-o3-app-name': 'dweb_client',
  'x-o3-app-version': 'release_csma_20260807-1',
  'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
};

(async () => {
  // Stage 1: GET /  -> 307 + ETC cookie
  console.log('=== Stage 1: GET / ===');
  const r1 = await httpsGet('/', { ...BASE, 'x-page-view-id': crypto.randomUUID() });
  console.log('  status:', r1.status);
  const cookies = {};
  (r1.headers['set-cookie'] || []).forEach(c => {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  console.log('  cookies:', Object.keys(cookies));

  // Stage 2: GET /?__rr=1 with cookie
  console.log('\n=== Stage 2: GET /?__rr=1 ===');
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const r2 = await httpsGet('/?__rr=1', {
    ...BASE,
    'Cookie': cookieH,
    'Referer': 'https://www.ozon.ru/',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
  });
  console.log('  status:', r2.status);
  console.log('  new cookies:', (r2.headers['set-cookie'] || []).length);
  (r2.headers['set-cookie'] || []).forEach(c => {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  console.log('  all cookies:', Object.keys(cookies));
  const html = r2.body.toString('utf8');
  console.log('  body length:', html.length);
  if (html.includes('abt_data') || html.includes('Похоже, нет')) {
    console.log('  *** CAPTCHA ***');
    console.log('  body[:500]:', html.slice(0, 500));
    return;
  }
  const m = html.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : crypto.randomUUID();
  console.log('  requestID:', requestID.slice(0, 30) + '...');
  const cookieH2 = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  // Stage 3: upload
  console.log('\n=== Stage 3: POST searchByImageUpload ===');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r3 = await httpsPost('/api/composer-api.bx/_action/searchByImageUpload', {
    ...BASE,
    'Content-Type': 'multipart/form-data; boundary=' + b,
    'Origin': 'https://www.ozon.ru',
    'Referer': 'https://www.ozon.ru/?__rr=1',
    'Cookie': cookieH2,
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
  }, uploadBody);
  console.log('  status:', r3.status);
  console.log('  body[:500]:', r3.body.toString('utf8').slice(0, 500));
  let r3j;
  try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) { r3j = null; }
  if (r3j && r3j.imageId) {
    console.log('  *** IMAGE UPLOADED: ' + r3j.imageId + ' ***');

    // Stage 4: crop
    console.log('\n=== Stage 4: POST searchByImage ===');
    const r4 = await httpsPost('/api/composer-api.bx/_action/searchByImage', {
      ...BASE,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.ozon.ru',
      'Referer': 'https://www.ozon.ru/?__rr=1',
      'Cookie': cookieH2,
      'x-page-view-id': crypto.randomUUID(),
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
    }, JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }));
    console.log('  status:', r4.status);
    console.log('  body:', r4.body.toString('utf8').slice(0, 500));
    let r4j;
    try { r4j = JSON.parse(r4.body.toString('utf8')); } catch (e) { r4j = null; }
    if (r4j && r4j.redirectUri) {
      console.log('  redirectUri:', r4j.redirectUri);

      // Stage 5: results
      console.log('\n=== Stage 5: GET results ===');
      const rPath = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
      const r5 = await httpsGet(rPath, {
        ...BASE,
        'Cookie': cookieH2,
        'Referer': 'https://www.ozon.ru/?__rr=1',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'x-page-view-id': crypto.randomUUID(),
        'x-page-previous': 'home',
      });
      console.log('  status:', r5.status);
      const html5 = r5.body.toString('utf8');
      const products = [...html5.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
      const titles = [...html5.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
      console.log('  products found:', products.length);
      console.log('  first 3 titles:');
      titles.slice(0, 3).forEach((t, i) => console.log('    ' + (i+1) + '. ' + t.slice(0, 80)));
      console.log('\n*** SUCCESS! ***');
    }
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });