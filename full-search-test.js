// 极简图搜测试 - 只跑 3 个代理
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');

class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); }
  req(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
      const h = { ...headers, Host: 'www.ozon.ru', Connection: 'close' };
      if (data) h['Content-Length'] = String(data.length);
      const lines = [`${method} ${path} HTTP/1.1`];
      for (const k of Object.keys(h)) lines.push(`${k}: ${h[k]}`);
      lines.push('', '');
      this.sock.write(lines.join('\r\n'));
      if (data) this.sock.write(data);
      let responded = false;
      const cleanup = () => { this.sock.removeAllListeners('data'); this.sock.removeAllListeners('error'); };
      const finish = (status, hdrs, body) => { cleanup(); resolve({ status, headers: hdrs, body }); };
      this.sock.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        if (responded) return;
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buf.slice(0, idx).toString('utf8');
        const m = head.match(/^HTTP\/[\d.]+ (\d+) /);
        if (!m) { reject(new Error('bad status')); return; }
        const status = parseInt(m[1]);
        const hdrs = {};
        head.split('\r\n').slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        // 让 set-cookie 数组
        hdrs['set-cookie'] = Object.entries(hdrs)
          .filter(([k]) => k.toLowerCase() === 'set-cookie')
          .map(([, v]) => v);
        responded = true;
        let bodyBuf = this.buf.slice(idx + 4);
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const contentLen = parseInt(hdrs['content-length'] || '0');
        if (contentLen > 0 && bodyBuf.length < contentLen) {
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (bodyBuf.length >= contentLen) {
              try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
              finish(status, hdrs, bodyBuf);
            }
          });
          return;
        }
        try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
        finish(status, hdrs, bodyBuf);
      });
      this.sock.on('error', (e) => responded ? null : reject(e));
      this.sock.setTimeout(12000, () => { if (!responded) { this.sock.destroy(); reject(new Error('timeout')); } });
    });
  }
}

async function proxySocks(host, addr) {
  const [ph, pp] = addr.split(':');
  const port = Number(pp);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, ph, () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    let buf = Buffer.alloc(0);
    let phase = 'g';
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, 10000);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'g' && buf.length >= 2 && buf[1] === 0x00) {
        const hb = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(443 >> 8) & 0xff, 443 & 0xff])]));
        buf = Buffer.alloc(0); phase = 'c';
      }
      if (phase === 'c' && buf.length >= 4 && buf[0] === 0x05 && buf[1] === 0x00) {
        const atyp = buf[3]; let c = 4;
        if (atyp === 1) c += 4; else if (atyp === 3) c += 1 + buf[4]; else if (atyp === 4) c += 16;
        c += 2;
        if (buf.length >= c) {
          clearTimeout(timeout);
          const tlsSock = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
          tlsSock.setTimeout(10000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(tlsSock));
          tlsSock.on('error', (e) => reject(e));
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function tryOne(addr, imageUrl) {
  const t0 = Date.now();
  const tlsSock = await proxySocks('www.ozon.ru', addr);
  const conn = new Conn(tlsSock);
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Accept-Encoding': 'gzip',
    'x-o3-app-name': 'dweb_client',
    'x-o3-app-version': 'release_csma_20260807-1',
    'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
    'x-page-view-id': crypto.randomUUID(),
  };
  console.log(`[${addr}] (${Date.now()-t0}ms) TLS ready`);

  const r1 = await conn.req('GET', '/', { ...baseHeaders });
  console.log(`[${addr}] (${Date.now()-t0}ms) BOOT status=${r1.status}`);
  let allCookies = {};
  (r1.headers['set-cookie'] || []).forEach((c) => {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i > 0) allCookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  let cookieH = Object.entries(allCookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (r1.status === 307 && r1.headers.location) {
    console.log(`[${addr}] Following redirect to ${r1.headers.location}`);
    const path = r1.headers.location.replace(/^https?:\/\/[^/]+/, '');
    const r1b = await conn.req('GET', path, { ...baseHeaders, Cookie: cookieH });
    (r1b.headers['set-cookie'] || []).forEach((c) => {
      const [p] = c.split(';'); const i = p.indexOf('=');
      if (i > 0) allCookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    cookieH = Object.entries(allCookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (r1b.status === 200) { r1.body = r1b.body; r1.status = 200; }
    else throw new Error('redirect ' + r1b.status);
  }
  if (r1.status !== 200) throw new Error('boot ' + r1.status);
  console.log(`[${addr}] (${Date.now()-t0}ms) cookies: ${Object.keys(allCookies).join(',')}`);
  const reqID = crypto.randomUUID();

  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\n' + imageUrl + '\r\n--' + b + '--\r\n'),
  ]);
  const r2 = await conn.req('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    ...baseHeaders,
    'Content-Type': 'multipart/form-data; boundary=' + b,
    'Cookie': cookieH,
    'x-o3-parent-requestid': reqID,
    'x-page-previous': 'home',
  }, uploadBody);
  console.log(`[${addr}] (${Date.now()-t0}ms) UPLOAD status=${r2.status}`);
  if (r2.status !== 200) throw new Error('upload ' + r2.status);
  const r2j = JSON.parse(r2.body.toString('utf8'));
  console.log(`[${addr}] (${Date.now()-t0}ms) UPLOAD body: ${JSON.stringify(r2j).slice(0,200)}`);
  if (!r2j.imageId) throw new Error('no imageId');
  const imageId = r2j.imageId;

  const r3 = await conn.req('POST', '/api/composer-api.bx/_action/searchByImage', {
    ...baseHeaders,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Cookie': cookieH,
    'x-o3-parent-requestid': reqID,
    'x-page-previous': 'home',
  }, JSON.stringify({ imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }));
  console.log(`[${addr}] (${Date.now()-t0}ms) CROP status=${r3.status}`);
  if (r3.status !== 200) throw new Error('crop ' + r3.status);
  const r3j = JSON.parse(r3.body.toString('utf8'));
  console.log(`[${addr}] (${Date.now()-t0}ms) CROP body: ${JSON.stringify(r3j).slice(0,200)}`);
  if (!r3j.redirectUri) throw new Error('no redirectUri');
  const rPath = r3j.redirectUri.startsWith('http') ? r3j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r3j.redirectUri;
  console.log(`[${addr}] (${Date.now()-t0}ms) REDIRECT path: ${rPath}`);

  const r4 = await conn.req('GET', rPath, {
    ...baseHeaders,
    'Cookie': cookieH,
    'Accept': 'text/html',
  });
  console.log(`[${addr}] (${Date.now()-t0}ms) RESULT status=${r4.status}`);
  if (r4.status !== 200) throw new Error('result ' + r4.status);
  const html = r4.body.toString('utf8');
  const products = [...html.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
  const titles = [...html.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
  return { proxy: addr, ms: Date.now()-t0, products: products.slice(0, 5), titles: titles.slice(0, 5) };
}

(async () => {
  const proxyList = fs.readFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-ozon-socks5.txt', 'utf8')
    .split(/\r?\n/).filter(Boolean);

  const IMAGE_URL = 'https://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg';

  for (const proxyLine of proxyList) {
    const proxy = proxyLine.replace(/^socks5:/, '');
    try {
      console.log('\n=========================================');
      console.log('Trying', proxy);
      const r = await tryOne(proxy, IMAGE_URL);
      console.log('\n*** SUCCESS ***');
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    } catch (e) {
      console.log(`[${proxy}] FAILED: ${e.message.slice(0, 100)}`);
    }
  }
  console.log('All proxies failed');
  process.exit(2);
})();