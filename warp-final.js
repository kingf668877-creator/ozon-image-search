// 跳过 redirect - 直接 POST upload 看 WARP 是否能让请求通过
const { OzonSession, ProxyPool } = require('./ozon-image-api');
const http2 = require('http2');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

async function socks5Tls(targetHost, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(1080, '127.0.0.1', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let buf = Buffer.alloc(0);
    let phase = 'g';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('socks5 timeout')); }, 15000);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'g' && buf.length >= 2 && buf[1] === 0x00) {
        const hb = Buffer.from(targetHost);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
        buf = Buffer.alloc(0); phase = 'c';
      }
      if (phase === 'c' && buf.length >= 4 && buf[0] === 0x05 && buf[1] === 0x00) {
        const atyp = buf[3]; let c = 4;
        if (atyp === 1) c += 4; else if (atyp === 3) c += 1 + buf[4]; else if (atyp === 4) c += 16;
        c += 2;
        if (buf.length >= c) {
          clearTimeout(t);
          const tlsSock = tls.connect({ socket: sock, servername: targetHost, ALPNProtocols: ['h2'], rejectUnauthorized: false });
          tlsSock.setTimeout(15000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(tlsSock));
          tlsSock.on('error', (e) => reject(e));
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function h2Req(session, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    const h = { ...headers };
    h[':method'] = method;
    h[':path'] = path;
    h[':authority'] = 'www.ozon.ru';
    h[':scheme'] = 'https';
    if (data) h['content-length'] = String(data.length);
    const req = session.request(h);
    const chunks = [];
    req.on('response', (rh) => {
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body = raw;
        const enc = (rh['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) body = zlib.gunzipSync(raw); else if (enc.includes('br')) body = zlib.brotliDecompressSync(raw); } catch (e) {}
        resolve({ status: rh[':status'], headers: rh, body });
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(30000, () => req.close());
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== Connect to WARP via SOCKS5 ===');
  const tlsSock = await socks5Tls('www.ozon.ru', 443);
  const session = http2.connect('https://www.ozon.ru', {
    createConnection: () => tlsSock,
  });
  await new Promise(r => setTimeout(r, 500));
  console.log('  H2 ready, ALPN:', tlsSock.alpnProtocol);

  const BASE = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.7',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1',
    'x-o3-app-name': 'dweb_client',
    'x-o3-app-version': 'release_csma_20260807-1',
    'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
  };

  // Step 1: GET /
  console.log('\n=== Step 1: GET / (boot) ===');
  const r1 = await h2Req(session, 'GET', '/', { ...BASE, 'x-page-view-id': crypto.randomUUID() });
  console.log('  status:', r1.status);
  const cookies = {};
  (r1.headers['set-cookie'] || []).forEach(c => {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  console.log('  cookies:', Object.keys(cookies));

  // Step 2: 直接尝试 POST upload (跳过 redirect)
  console.log('\n=== Step 2: Direct POST upload ===');
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const b = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const uploadBody = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n{"width":1024,"height":1024,"type":"image/jpeg"}\r\n'),
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + b + '--\r\n'),
  ]);
  const r2 = await h2Req(session, 'POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    ...BASE,
    'content-type': 'multipart/form-data; boundary=' + b,
    'origin': 'https://www.ozon.ru',
    'referer': 'https://www.ozon.ru/',
    'cookie': cookieH,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'x-page-view-id': crypto.randomUUID(),
    'x-page-previous': 'home',
    'x-o3-parent-requestid': crypto.randomUUID(),
  }, uploadBody);
  console.log('  status:', r2.status);
  console.log('  body:', r2.body.toString('utf8').slice(0, 500));
  let r2j;
  try { r2j = JSON.parse(r2.body.toString('utf8')); } catch (e) {}
  if (r2j && r2j.imageId) {
    console.log('  *** IMAGE UPLOADED: ' + r2j.imageId + ' ***');
  }

  session.close();
  tlsSock.destroy();
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });