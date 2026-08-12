// 单 TCP 连接 HTTP/2 多路复用 over SOCKS5 代理
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const http2 = require('http2');
const crypto = require('crypto');

async function connectSocks5(addr) {
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
          const tlsSock = tls.connect({ socket: sock, servername: 'www.ozon.ru', ALPNProtocols: ['h2'], rejectUnauthorized: false });
          tlsSock.setTimeout(10000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(tlsSock));
          tlsSock.on('error', reject);
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function h2Req(session, method, path, headers, body) {
  return new Promise((resolve) => {
    const req = session.request({
      ':method': method,
      ':path': path,
      'host': 'www.ozon.ru',
      ...headers,
    });
    const chunks = [];
    let rh = null;
    req.on('response', (h) => {
      rh = h;
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body = raw;
        const enc = (h['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) body = zlib.gunzipSync(raw); else if (enc.includes('br')) body = zlib.brotliDecompressSync(raw); } catch (e) {}
        resolve({ status: h[':status'], headers: h, body });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => req.close());
    if (body) req.write(body);
    req.end();
  });
}

const BASE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
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
  const proxyList = fs.readFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-ozon-socks5.txt', 'utf8')
    .split(/\r?\n/).filter(Boolean);

  for (const proxyLine of proxyList.slice(0, 30)) {
    const proxy = proxyLine.replace(/^socks5:/, '');
    console.log('\n=========================================');
    console.log('Trying', proxy);
    let tlsSock;
    try {
      tlsSock = await connectSocks5(proxy);
    } catch (e) {
      console.log('  CONN FAIL:', e.message);
      continue;
    }

    // HTTP/2 单连接多请求
    const session = http2.connect('https://www.ozon.ru', {
      createConnection: () => tlsSock,
    });
    await new Promise((r) => setTimeout(r, 300));
    if (session.closed || session.destroyed) {
      console.log('  H2 session dead');
      session.close();
      tlsSock.destroy();
      continue;
    }

    console.log('  H2 ALPN:', tlsSock.alpnProtocol);

    // 1. boot
    const r1 = await h2Req(session, 'GET', '/', {
      ...BASE_HEADERS,
      'x-page-view-id': crypto.randomUUID(),
    });
    if (r1.error) {
      console.log('  R1 err:', r1.error);
      session.close();
      tlsSock.destroy();
      continue;
    }
    console.log('  R1 status:', r1.status);

    if (r1.status !== 307 && r1.status !== 200) {
      console.log('  R1 unexpected status');
      session.close();
      tlsSock.destroy();
      continue;
    }

    // 解析 cookie
    const setCookies = r1.headers['set-cookie'] || [];
    const cookies = {};
    setCookies.forEach((c) => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
    const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    console.log('  R1 cookies:', Object.keys(cookies).join(','));
    const requestID = (r1.body.toString('utf8').match(/"requestID"\s*:\s*"([^"]+)"/) || [])[1] || crypto.randomUUID();

    // 2. upload (search by URL)
    const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const uploadBody = Buffer.concat([
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
      Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
    ]);
    const r2 = await h2Req(session, 'POST', '/api/composer-api.bx/_action/searchByImageUpload', {
      ...BASE_HEADERS,
      'content-type': 'multipart/form-data; boundary=' + b,
      'cookie': cookieH,
      'origin': 'https://www.ozon.ru',
      'referer': 'https://www.ozon.ru/',
      'x-page-view-id': crypto.randomUUID(),
      'x-page-previous': 'home',
      'x-o3-parent-requestid': requestID,
    }, uploadBody);
    console.log('  R2 status:', r2.status);
    if (r2.error) {
      console.log('  R2 err:', r2.error);
      session.close();
      tlsSock.destroy();
      continue;
    }
    const r2body = r2.body.toString('utf8');
    console.log('  R2 body[:300]:', r2body.slice(0, 300));
    let r2json;
    try { r2json = JSON.parse(r2body); } catch (e) { r2json = null; }

    if (r2json && r2json.imageId) {
      console.log('\n*** IMAGE UPLOADED: ' + r2json.imageId + ' ***');
      console.log('Proxy: ' + proxy);
      process.exit(0);
    }
    session.close();
    tlsSock.destroy();
  }

  console.log('\nAll 30 proxies failed');
  process.exit(2);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });