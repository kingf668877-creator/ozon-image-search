// 完整 flow
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');
const cookies = {};

async function req(method, path, body, extraHeaders = {}) {
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const data = body ? Buffer.from(body) : null;
  const headers = {
    'Host': 'www.ozon.ru',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'close',
    'x-o3-app-name': 'dweb_client',
    'x-o3-app-version': 'release_csma_20260807-1',
    'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
    'x-page-view-id': crypto.randomUUID(),
    ...extraHeaders,
  };
  if (cookieH) headers['Cookie'] = cookieH;
  if (data) headers['Content-Length'] = String(data.length);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: 'www.ozon.ru', port: 443, servername: 'www.ozon.ru', ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
    sock.on('error', reject);
    sock.on('secureConnect', () => {
      const lines = [`${method} ${path} HTTP/1.1`];
      for (const k of Object.keys(headers)) lines.push(`${k}: ${headers[k]}`);
      lines.push('', '');
      sock.write(lines.join('\r\n'));
      if (data) sock.write(data);
      const chunks = [];
      sock.on('data', c => chunks.push(c));
      sock.on('end', () => {
        const buf = Buffer.concat(chunks);
        const headEnd = buf.indexOf('\r\n\r\n');
        const head = buf.slice(0, headEnd).toString('utf8');
        const m = head.match(/^HTTP\/[\d.]+ (\d+) /);
        const status = parseInt(m[1]);
        const hdrs = {};
        head.split('\r\n').slice(1).forEach(l => { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        const scs = [];
        Object.entries(hdrs).forEach(([k, v]) => {
          if (k.toLowerCase() === 'set-cookie') {
            if (Array.isArray(v)) scs.push(...v); else scs.push(v);
          }
        });
        hdrs['set-cookie'] = scs;
        scs.forEach(c => {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        });
        let bodyBuf = buf.slice(headEnd + 4);
        try { if ((hdrs['content-encoding'] || '').includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
        resolve({ status, headers: hdrs, body: bodyBuf });
      });
      sock.on('error', reject);
      sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('timeout')); });
    });
  });
}

(async () => {
  // 多次尝试直到找到不 captcha 的窗口
  for (let attempt = 0; attempt < 20; attempt++) {
    Object.keys(cookies).forEach(k => delete cookies[k]);

    // 1) GET / 拿到 ETC cookie + redirect to ?__rr=1
    const r1 = await req('GET', '/', null, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' });

    // 2) GET /?__rr=1 with ETC cookie
    const r2 = await req('GET', '/?__rr=1', null, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'referer': 'https://www.ozon.ru/', 'x-page-previous': 'home' });

    if (r2.status !== 200) {
      console.log(`[${attempt+1}] r2 status=${r2.status}, skip`);
      continue;
    }
    const html = r2.body.toString('utf8');
    if (html.includes('Похоже, нет')) {
      console.log(`[${attempt+1}] CAPTCHA`);
      continue;
    }
    console.log(`[${attempt+1}] r2 status=200, bodyLen=${r2.body.length}`);
    const m = html.match(/"requestID":"([^"]+)"/);
    const requestID = m ? m[1] : crypto.randomUUID();
    console.log('  requestID:', requestID);

    // 3) POST upload
    const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const uploadBody = Buffer.concat([
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
    ]);
    const r3 = await req('POST', '/api/composer-api.bx/_action/searchByImageUpload', uploadBody, {
      'Content-Type': 'multipart/form-data; boundary=' + b,
      'origin': 'https://www.ozon.ru',
      'referer': 'https://www.ozon.ru/?__rr=1',
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    console.log('  R3 status:', r3.status);
    console.log('  R3 body[:500]:', r3.body.toString('utf8').slice(0, 500));
    let r3j;
    try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) {}
    if (r3j && r3j.imageId) {
      console.log('  *** IMAGE UPLOADED:', r3j.imageId, '***');
      // 4) POST crop
      const r4 = await req('POST', '/api/composer-api.bx/_action/searchByImage', JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }), {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'origin': 'https://www.ozon.ru',
        'referer': 'https://www.ozon.ru/?__rr=1',
        'x-page-previous': 'home',
        'x-o3-parent-requestid': requestID,
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      });
      console.log('  R4 status:', r4.status);
      console.log('  R4 body[:300]:', r4.body.toString('utf8').slice(0, 300));
      let r4j;
      try { r4j = JSON.parse(r4.body.toString('utf8')); } catch (e) {}
      if (r4j && r4j.redirectUri) {
        console.log('  *** REDIRECT:', r4j.redirectUri, '***');
        const path = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
        const r5 = await req('GET', path, null, {
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'x-page-previous': 'search',
          'referer': 'https://www.ozon.ru/?__rr=1',
        });
        console.log('  R5 status:', r5.status, 'bodyLen:', r5.body.length);
        if (r5.status === 200) {
          const html5 = r5.body.toString('utf8');
          const products = [...html5.matchAll(/"link":"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
          const titles = [...html5.matchAll(/"title":"([^"]{5,200})"/g)].map(m => m[1]);
          console.log('  *** FOUND', products.length, 'PRODUCTS ***');
          titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
          console.log('\n*** FULL SUCCESS! ***');
        }
      }
    }
    break;
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });