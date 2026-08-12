// 全新的连接做 redirect，带更完整的浏览器头
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); }
  req(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
      const h = { ...headers, Host: 'www.ozon.ru' };
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
        if (!m) { this.sock.destroy(); reject(new Error('bad status')); return; }
        const status = parseInt(m[1]);
        const hdrs = {};
        head.split('\r\n').slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        hdrs['set-cookie'] = Object.entries(hdrs).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
        responded = true;
        let bodyBuf = this.buf.slice(idx + 4);
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const contentLen = parseInt(hdrs['content-length'] || '0');
        if (contentLen > 0 && bodyBuf.length < contentLen) {
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (bodyBuf.length >= contentLen) {
              try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
              cleanup();
              resolve({ status, headers: hdrs, body: bodyBuf });
            }
          });
          return;
        }
        try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
        cleanup();
        resolve({ status, headers: hdrs, body: bodyBuf });
      });
      this.sock.on('error', (e) => responded ? null : reject(e));
      this.sock.setTimeout(20000, () => { if (!responded) { this.sock.destroy(); reject(new Error('timeout')); } });
    });
  }
}

async function newConn(proxyAddr) {
  const [ph, pp] = proxyAddr.split(':');
  const port = Number(pp);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, ph, () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    let buf = Buffer.alloc(0);
    let phase = 'g';
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, 10000);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'g' && buf.length >= 2 && buf[1] === 0x00) {
        const hb = Buffer.from('www.ozon.ru');
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(443 >> 8) & 0xff, 443 & 0xff])]));
        buf = Buffer.alloc(0); phase = 'c';
      }
      if (phase === 'c' && buf.length >= 4 && buf[0] === 0x05 && buf[1] === 0x00) {
        const atyp = buf[3]; let c = 4;
        if (atyp === 1) c += 4; else if (atyp === 3) c += 1 + buf[4]; else if (atyp === 4) c += 16;
        c += 2;
        if (buf.length >= c) {
          clearTimeout(timeout);
          const tlsSock = tls.connect({ socket: sock, servername: 'www.ozon.ru', ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
          tlsSock.setTimeout(10000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(new Conn(tlsSock)));
          tlsSock.on('error', (e) => reject(e));
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

const baseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avimage,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'upgrade-insecure-requests': '1',
  'x-o3-app-name': 'dweb_client',
  'x-o3-app-version': 'release_csma_20260807-1',
  'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
};

(async () => {
  const proxy = '98.170.57.241:4145';
  console.log('=== STAGE 1: GET / (bootstrap) ===');
  const conn1 = await newConn(proxy);
  const r1 = await conn1.req('GET', '/', { ...baseHeaders, 'x-page-view-id': crypto.randomUUID() });
  console.log('status:', r1.status, 'cookies:', r1.headers['set-cookie'].length);
  const cookies = {};
  r1.headers['set-cookie'].forEach((c) => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log('cookies:', Object.keys(cookies));

  // Wait a bit (real browser would navigate after page load)
  await new Promise(r => setTimeout(r, 800));

  console.log('\n=== STAGE 2: GET /?__rr=1 (with cookie, new connection) ===');
  const conn2 = await newConn(proxy);
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const r2 = await conn2.req('GET', '/?__rr=1', {
    ...baseHeaders,
    'Cookie': cookieH,
    'Referer': 'https://www.ozon.ru/',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
  });
  console.log('status:', r2.status);
  console.log('new cookies:', r2.headers['set-cookie'].length);
  r2.headers['set-cookie'].forEach((c) => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log('all cookies:', Object.keys(cookies));
  console.log('body length:', r2.body.length);
  console.log('body[:300]:', r2.body.toString('utf8', 0, 300));

  // 检查是否有 captcha 标识
  const html = r2.body.toString('utf8');
  if (html.includes('abt_data') || html.includes('Похоже, нет')) {
    console.log('\n*** STILL CAPTCHA ***');
    process.exit(1);
  }

  // 提取 requestID
  const m = html.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : null;
  console.log('\nrequestID:', requestID);

  if (r2.status === 200 && requestID) {
    console.log('\n=== STAGE 3: POST upload (search by image URL) ===');
    await new Promise(r => setTimeout(r, 500));
    const conn3 = await newConn(proxy);
    const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
    ]);
    const cookieH2 = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const r3 = await conn3.req('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
      ...baseHeaders,
      'Content-Type': 'multipart/form-data; boundary=' + b,
      'Cookie': cookieH2,
      'Origin': 'https://www.ozon.ru',
      'Referer': 'https://www.ozon.ru/',
      'x-page-view-id': crypto.randomUUID(),
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
    }, body);
    console.log('status:', r3.status);
    console.log('body:', r3.body.toString('utf8').slice(0, 500));
  }
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });