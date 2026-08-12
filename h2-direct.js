// 完整测试：在 HTTP/2 直连下完整跑 OZON 图搜
const http2 = require('http2');
const zlib = require('zlib');
const crypto = require('crypto');

const session = http2.connect('https://www.ozon.ru', { rejectUnauthorized: false });
session.on('error', (e) => console.log('SESS ERR', e.message));

let cookies = {};

function h2Req(method, path, extra = {}, body = null) {
  return new Promise((resolve, reject) => {
    const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const h = {
      ':method': method,
      ':path': path,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.6',
      'accept-encoding': 'gzip, deflate, br',
      'cookie': cookieH,
      'x-o3-app-name': 'dweb_client',
      'x-o3-app-version': 'release_csma_20260807-1',
      'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
      'x-page-view-id': crypto.randomUUID(),
      ...extra,
    };
    const req = session.request(h);
    const chunks = [];
    req.on('response', (rh) => {
      // 收集 cookies
      (rh['set-cookie'] || []).forEach(c => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      });
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let b = raw;
        const enc = (rh['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) b = zlib.gunzipSync(raw); else if (enc.includes('br')) b = zlib.brotliDecompressSync(raw); } catch (e) {}
        resolve({ status: rh[':status'], headers: rh, body: b });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== Stage 1: GET / ===');
  const r1 = await h2Req('GET', '/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' });
  console.log('  status:', r1.status);
  console.log('  cookies:', Object.keys(cookies));

  console.log('\n=== Stage 2: GET /?__rr=1 ===');
  const r2 = await h2Req('GET', '/?__rr=1', {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'referer': 'https://www.ozon.ru/',
    'x-page-previous': 'home',
  });
  console.log('  status:', r2.status);
  console.log('  cookies:', Object.keys(cookies));
  console.log('  body length:', r2.body.length);
  console.log('  body[:200]:', r2.body.toString('utf8').slice(0, 200));
  if (r2.body.toString('utf8').includes('Похоже, нет')) { console.log('  *** CAPTCHA ***'); process.exit(1); }

  // Extract requestID
  const html = r2.body.toString('utf8');
  const m = html.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : crypto.randomUUID();
  console.log('  requestID:', requestID.slice(0, 30));

  console.log('\n=== Stage 3: POST upload ===');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r3 = await h2Req('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    'content-type': 'multipart/form-data; boundary=' + b,
    'origin': 'https://www.ozon.ru',
    'referer': 'https://www.ozon.ru/?__rr=1',
    'x-o3-parent-requestid': requestID,
    'x-page-previous': 'home',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }, uploadBody);
  console.log('  status:', r3.status);
  console.log('  body[:500]:', r3.body.toString('utf8').slice(0, 500));
  let r3j;
  try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) { r3j = null; }
  if (r3j && r3j.imageId) {
    console.log('  *** IMAGE UPLOADED:', r3j.imageId, '***');
    console.log('\n=== Stage 4: POST crop ===');
    const r4 = await h2Req('POST', '/api/composer-api.bx/_action/searchByImage', {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-o3-parent-requestid': requestID,
      'x-page-previous': 'home',
      'origin': 'https://www.ozon.ru',
      'referer': 'https://www.ozon.ru/?__rr=1',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }, JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }));
    console.log('  status:', r4.status);
    console.log('  body[:300]:', r4.body.toString('utf8').slice(0, 300));
    let r4j;
    try { r4j = JSON.parse(r4.body.toString('utf8')); } catch (e) {}
    if (r4j && r4j.redirectUri) {
      console.log('  *** REDIRECT:', r4j.redirectUri, '***');
      console.log('\n=== Stage 5: GET results ===');
      const path = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
      const r5 = await h2Req('GET', path, {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'x-page-previous': 'search',
        'referer': 'https://www.ozon.ru/?__rr=1',
      });
      console.log('  status:', r5.status);
      console.log('  body length:', r5.body.length);
      const html5 = r5.body.toString('utf8');
      const products = [...html5.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
      const titles = [...html5.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
      console.log('  *** PRODUCTS:', products.length, '***');
      titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
      console.log('\n*** FULL SUCCESS! ***');
    }
  }
  session.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });