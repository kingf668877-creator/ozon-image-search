// HTTP/1.1 keep-alive 顺序 4 步
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');

// HTTP/1.1 over TLS
class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); }
  request(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
      const h = { ...headers, Host: 'www.ozon.ru', Connection: 'keep-alive' };
      if (data) h['Content-Length'] = String(data.length);
      const lines = [`${method} ${path} HTTP/1.1`];
      for (const k of Object.keys(h)) lines.push(`${k}: ${h[k]}`);
      lines.push('', '');
      this.sock.write(lines.join('\r\n'));
      if (data) this.sock.write(data);
      let responded = false;
      const cleanup = () => { this.sock.removeAllListeners('data'); this.sock.removeAllListeners('error'); };
      this.sock.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        if (responded) return;
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buf.slice(0, idx).toString('utf8');
        const m = head.match(/^HTTP\/[\d.]+ (\d+) /);
        if (!m) { cleanup(); reject(new Error('bad status')); return; }
        const status = parseInt(m[1]);
        const hdrs = {};
        head.split('\r\n').slice(1).forEach((l) => {
          const i = l.indexOf(':');
          if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        });
        hdrs['set-cookie'] = Object.entries(hdrs).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
        responded = true;
        let bodyBuf = this.buf.slice(idx + 4);
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const cl = parseInt(hdrs['content-length'] || '0');
        if (cl > 0 && bodyBuf.length < cl) {
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (bodyBuf.length >= cl) {
              try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
              cleanup();
              resolve({ status, headers: hdrs, body: bodyBuf });
            }
          });
          return;
        }
        try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); else if (enc.includes('br')) bodyBuf = zlib.brotliDecompressSync(bodyBuf); } catch (e) {}
        cleanup();
        resolve({ status, headers: hdrs, body: bodyBuf });
      });
      this.sock.on('error', (e) => responded ? null : reject(e));
      this.sock.setTimeout(15000, () => { if (!responded) { this.sock.destroy(); reject(new Error('timeout')); } });
    });
  }
}

(async () => {
  // 直接 TLS 连接 www.ozon.ru
  const sock = tls.connect({
    host: 'www.ozon.ru',
    port: 443,
    ALPNProtocols: ['http/1.1'],
    servername: 'www.ozon.ru',
    rejectUnauthorized: false,
  });
  await new Promise(r => sock.on('secureConnect', r));
  console.log('TLS ready, ALPN:', sock.alpnProtocol);
  const conn = new Conn(sock);

  const cookies = {};
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'x-o3-app-name': 'dweb_client',
    'x-o3-app-version': 'release_csma_20260807-1',
    'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
  };

  console.log('\n1. GET /');
  const r1 = await conn.request('GET', '/', { ...baseHeaders, 'x-page-view-id': crypto.randomUUID(), 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, null);
  console.log('  status:', r1.status);
  r1.headers['set-cookie'].forEach(c => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log('  cookies:', Object.keys(cookies));

  console.log('\n2. GET /?__rr=1');
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const r2 = await conn.request('GET', '/?__rr=1', { ...baseHeaders, 'Cookie': cookieH, 'x-page-view-id': crypto.randomUUID(), 'x-page-previous': 'home', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'referer': 'https://www.ozon.ru/' }, null);
  console.log('  status:', r2.status);
  r2.headers['set-cookie'].forEach(c => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log('  cookies:', Object.keys(cookies));
  console.log('  body[:300]:', r2.body.toString('utf8').slice(0, 300));
  if (r2.body.toString('utf8').includes('Похоже, нет')) {
    console.log('  *** CAPTCHA ***');
    return;
  }

  const html = r2.body.toString('utf8');
  const m = html.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : crypto.randomUUID();
  console.log('  requestID:', requestID.slice(0, 30));
  const cookieH2 = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  console.log('\n3. POST upload');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r3 = await conn.request('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    ...baseHeaders,
    'Content-Type': 'multipart/form-data; boundary=' + b,
    'Cookie': cookieH2,
    'Origin': 'https://www.ozon.ru',
    'Referer': 'https://www.ozon.ru/?__rr=1',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }, uploadBody);
  console.log('  status:', r3.status);
  console.log('  body[:500]:', r3.body.toString('utf8').slice(0, 500));
  let r3j;
  try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) {}
  if (r3j && r3j.imageId) {
    console.log('  *** IMAGE UPLOADED:', r3j.imageId, '***');

    console.log('\n4. POST crop');
    const r4 = await conn.request('POST', '/api/composer-api.bx/_action/searchByImage', {
      ...baseHeaders,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': cookieH2,
      'Origin': 'https://www.ozon.ru',
      'Referer': 'https://www.ozon.ru/?__rr=1',
      'x-page-view-id': crypto.randomUUID(),
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }, JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }));
    console.log('  status:', r4.status);
    console.log('  body[:300]:', r4.body.toString('utf8').slice(0, 300));
    let r4j;
    try { r4j = JSON.parse(r4.body.toString('utf8')); } catch (e) {}
    if (r4j && r4j.redirectUri) {
      console.log('  *** REDIRECT:', r4j.redirectUri, '***');
      console.log('\n5. GET results');
      const path = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
      const r5 = await conn.request('GET', path, {
        ...baseHeaders,
        'Cookie': cookieH2,
        'Referer': 'https://www.ozon.ru/?__rr=1',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'x-page-view-id': crypto.randomUUID(),
        'x-page-previous': 'search',
      }, null);
      console.log('  status:', r5.status);
      if (r5.status === 200) {
        const html5 = r5.body.toString('utf8');
        const products = [...html5.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
        const titles = [...html5.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
        console.log('  *** FOUND', products.length, 'PRODUCTS ***');
        titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
        console.log('\n*** FULL SUCCESS! ***');
      }
    }
  }
  sock.destroy();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });