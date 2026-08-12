// 完整测试：拿 cookie -> redirect -> 看结果
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const COOKIES = {}; // 收集的 cookies

function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const cookieH = Object.entries(COOKIES).map(([k, v]) => `${k}=${v}`).join('; ');
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.6',
      'accept-encoding': 'gzip, deflate, br',
      'cookie': cookieH,
      'x-o3-app-name': 'dweb_client',
      'x-o3-app-version': 'release_csma_20260807-1',
      'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
      'x-page-view-id': crypto.randomUUID(),
      ...extraHeaders,
    };
    if (data) headers['content-length'] = String(data.length);
    const req = https.request({
      host: 'www.ozon.ru', path, method, headers, rejectUnauthorized: false, timeout: 20000,
    }, (res) => {
      (res.headers['set-cookie'] || []).forEach(c => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) COOKIES[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      });
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let b = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) b = zlib.gunzipSync(b); else if (enc.includes('br')) b = zlib.brotliDecompressSync(b); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: b });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('1. GET /');
  const r1 = await request('GET', '/', null, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' });
  console.log('  status:', r1.status, 'cookies:', Object.keys(COOKIES));

  console.log('\n2. GET /?__rr=1');
  const r2 = await request('GET', '/?__rr=1', null, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'referer': 'https://www.ozon.ru/', 'x-page-previous': 'home' });
  console.log('  status:', r2.status, 'cookies:', Object.keys(COOKIES));
  console.log('  body[:300]:', r2.body.toString('utf8').slice(0, 300));
  const html2 = r2.body.toString('utf8');
  const m = html2.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : crypto.randomUUID();
  console.log('  requestID:', requestID.slice(0, 30));
  if (html2.includes('Похоже, нет')) {
    console.log('  *** CAPTCHA - This IP is banned ***');
    return;
  }

  console.log('\n3. POST upload');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r3 = await request('POST', '/api/composer-api.bx/_action/searchByImageUpload', uploadBody, {
    'content-type': 'multipart/form-data; boundary=' + b,
    'origin': 'https://www.ozon.ru',
    'referer': 'https://www.ozon.ru/?__rr=1',
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  });
  console.log('  status:', r3.status);
  console.log('  body[:500]:', r3.body.toString('utf8').slice(0, 500));
  let r3j;
  try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) {}
  if (r3j && r3j.imageId) {
    console.log('  *** IMAGE UPLOADED:', r3j.imageId, '***');

    console.log('\n4. POST crop');
    const r4 = await request('POST', '/api/composer-api.bx/_action/searchByImage', JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }), {
      'content-type': 'application/json',
      'accept': 'application/json',
      'origin': 'https://www.ozon.ru',
      'referer': 'https://www.ozon.ru/?__rr=1',
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    console.log('  status:', r4.status);
    console.log('  body[:300]:', r4.body.toString('utf8').slice(0, 300));
    let r4j;
    try { r4j = JSON.parse(r4.body.toString('utf8')); } catch (e) {}
    if (r4j && r4j.redirectUri) {
      console.log('  *** REDIRECT:', r4j.redirectUri, '***');
      console.log('\n5. GET results');
      const path = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
      const r5 = await request('GET', path, null, {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'x-page-previous': 'search',
        'referer': 'https://www.ozon.ru/?__rr=1',
      });
      console.log('  status:', r5.status);
      console.log('  body length:', r5.body.length);
      if (r5.status === 200) {
        const html5 = r5.body.toString('utf8');
        const products = [...html5.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
        const titles = [...html5.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
        console.log('  *** FOUND', products.length, 'PRODUCTS ***');
        titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
      }
    }
  }
})().catch(e => { console.error('FATAL:', e); });