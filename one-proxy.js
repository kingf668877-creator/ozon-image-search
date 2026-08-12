// 独立 TCP 连接 - 每个请求一个新连接
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
        // 支持 chunked transfer
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const transfer = (hdrs['transfer-encoding'] || '').toLowerCase();
        const contentLen = parseInt(hdrs['content-length'] || '0');
        let bodyBuf = this.buf.slice(idx + 4);

        const tryFinish = (b) => {
          try { if (enc.includes('gzip')) b = zlib.gunzipSync(b); } catch (e) {}
          resolve({ status, headers: hdrs, body: b });
        };

        if (transfer === 'chunked') {
          let off = 0;
          let dechunked = Buffer.alloc(0);
          const tryDechunk = () => {
            while (off < bodyBuf.length) {
              const nl = bodyBuf.indexOf('\r\n', off);
              if (nl < 0) return false;
              const sz = parseInt(bodyBuf.slice(off, nl).toString('utf8'), 16);
              if (isNaN(sz)) return false;
              if (sz === 0) { tryFinish(dechunked); return true; }
              if (bodyBuf.length < nl + 2 + sz + 2) return false;
              dechunked = Buffer.concat([dechunked, bodyBuf.slice(nl + 2, nl + 2 + sz)]);
              off = nl + 2 + sz + 2;
            }
            return false;
          };
          if (tryDechunk()) return;
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (tryDechunk()) { this.sock.removeAllListeners('data'); this.sock.removeAllListeners('end'); }
          });
          this.sock.on('end', () => tryFinish(dechunked));
          return;
        }

        if (contentLen > 0 && bodyBuf.length < contentLen) {
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (bodyBuf.length >= contentLen) {
              this.sock.removeAllListeners('data');
              tryFinish(bodyBuf.slice(0, contentLen));
            }
          });
          return;
        }
        tryFinish(bodyBuf);
      });
      this.sock.on('error', (e) => responded ? null : reject(e));
      this.sock.setTimeout(20000, () => { if (!responded) { this.sock.destroy(); reject(new Error('timeout')); } });
    });
  }
}

async function socks5ToOzon(addr) {
  const [ph, pp] = addr.split(':');
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(pp), ph, () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    let buf = Buffer.alloc(0);
    let phase = 'g';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, 10000);
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
          clearTimeout(t);
          const tlsSock = tls.connect({ socket: sock, servername: 'www.ozon.ru', ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
          tlsSock.setTimeout(10000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(tlsSock));
          tlsSock.on('error', reject);
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function newConn(proxyAddr) {
  const tlsSock = await socks5ToOzon(proxyAddr);
  return new Conn(tlsSock);
}

const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'x-o3-app-name': 'dweb_client',
  'x-o3-app-version': 'release_csma_20260807-1',
  'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
};

async function fullSearch(proxy) {
  const t0 = Date.now();
  let cookies = {};

  // Stage 1: GET / -> 307 + ETC cookie
  const c1 = await newConn(proxy);
  const r1 = await c1.req('GET', '/', {
    ...BROWSER,
    'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document',
    'x-page-view-id': crypto.randomUUID(),
  });
  r1.headers['set-cookie'].forEach((c) => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log(`[${proxy}] R1 status=${r1.status} cookies=${Object.keys(cookies)}`);
  if (r1.status !== 307 && r1.status !== 200) throw new Error('boot ' + r1.status);

  // Stage 2: 独立连接 GET /?__rr=1 (Redirect) with cookie
  const c2 = await newConn(proxy);
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const r2 = await c2.req('GET', '/?__rr=1', {
    ...BROWSER,
    'Cookie': cookieH,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'Referer': 'https://www.ozon.ru/',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
  });
  r2.headers['set-cookie'].forEach((c) => { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  console.log(`[${proxy}] R2 (/?__rr=1) status=${r2.status} cookies=${Object.keys(cookies)} bodyLen=${r2.body.length}`);
  if (r2.body.toString('utf8').includes('abt_data') || r2.body.toString('utf8').includes('Похоже, нет')) {
    throw new Error('captcha on /?__rr=1');
  }
  if (r2.status !== 200) throw new Error('redirect status ' + r2.status);

  // 提取 requestID
  const html = r2.body.toString('utf8');
  const m = html.match(/"requestID"\s*:\s*"([^"]+)"/);
  const requestID = m ? m[1] : crypto.randomUUID();
  console.log(`[${proxy}] requestID=${requestID.slice(0, 30)}...`);
  const cookieH2 = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  // Stage 3: upload
  const c3 = await newConn(proxy);
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r3 = await c3.req('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    ...BROWSER,
    'Content-Type': 'multipart/form-data; boundary=' + b,
    'Origin': 'https://www.ozon.ru',
    'Referer': 'https://www.ozon.ru/?__rr=1',
    'Cookie': cookieH2,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
  }, uploadBody);
  console.log(`[${proxy}] R3 upload status=${r3.status}, body[:300]: ${r3.body.toString('utf8', 0, 300)}`);
  if (r3.status !== 200) throw new Error('upload ' + r3.status);
  let r3j;
  try { r3j = JSON.parse(r3.body.toString('utf8')); } catch (e) { throw new Error('upload not JSON'); }
  if (!r3j.imageId) throw new Error('no imageId');
  console.log(`[${proxy}] *** IMAGE UPLOADED: ${r3j.imageId} ***`);

  // Stage 4: crop
  const c4 = await newConn(proxy);
  const r4 = await c4.req('POST', '/api/composer-api.bx/_action/searchByImage', {
    ...BROWSER,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': 'https://www.ozon.ru',
    'Referer': 'https://www.ozon.ru/?__rr=1',
    'Cookie': cookieH2,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
    'x-o3-parent-requestid': requestID,
  }, JSON.stringify({ imageId: r3j.imageId, cropRectangle: { left: 0, top: 0, width: 1, height: 1 } }));
  console.log(`[${proxy}] R4 crop status=${r4.status} body[:200]: ${r4.body.toString('utf8', 0, 200)}`);
  if (r4.status !== 200) throw new Error('crop ' + r4.status);
  const r4j = JSON.parse(r4.body.toString('utf8'));
  if (!r4j.redirectUri) throw new Error('no redirectUri');

  // Stage 5: results
  const c5 = await newConn(proxy);
  const rPath = r4j.redirectUri.startsWith('http') ? r4j.redirectUri.replace(/^https?:\/\/[^/]+/, '') : r4j.redirectUri;
  const r5 = await c5.req('GET', rPath, {
    ...BROWSER,
    'Cookie': cookieH2,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'Referer': 'https://www.ozon.ru/?__rr=1',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
  });
  console.log(`[${proxy}] R5 results status=${r5.status} bodyLen=${r5.body.length}`);
  if (r5.status !== 200) throw new Error('results ' + r5.status);

  const html5 = r5.body.toString('utf8');
  const products = [...html5.matchAll(/"link"\s*:\s*"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
  const titles = [...html5.matchAll(/"title"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
  console.log(`[${proxy}] PRODUCTS: ${products.length}, first title: ${(titles[0] || '(none)').slice(0, 80)}`);

  return {
    ok: true,
    proxy,
    ms: Date.now() - t0,
    productCount: products.length,
    titles: titles.slice(0, 5),
    products: products.slice(0, 5),
  };
}

(async () => {
  const proxyList = fs.readFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-ozon-socks5.txt', 'utf8')
    .split(/\r?\n/).filter(Boolean);

  for (const proxyLine of proxyList.slice(0, 100)) {
    const proxy = proxyLine.replace(/^socks5:/, '');
    try {
      const r = await fullSearch(proxy);
      console.log('\n*** SUCCESS ***');
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    } catch (e) {
      console.log(`[${proxy}] FAILED: ${e.message.slice(0, 200)}\n`);
    }
  }
  console.log('\nAll 100 proxies failed');
  process.exit(2);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });