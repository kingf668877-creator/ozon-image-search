// Follow redirect: GET /search-by-image -> 307 to ?__rr=1 -> 200 OK
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');

const cookies = {};

async function req(method, path, extraHeaders = {}) {
  const cookieH = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: 'www.ozon.ru', port: 443, servername: 'www.ozon.ru', ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
    sock.on('error', reject);
    sock.on('secureConnect', () => {
      const headers = [
        method + ' ' + path + ' HTTP/1.1',
        'Host: www.ozon.ru',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language: ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.6',
        'Accept-Encoding: gzip, deflate, br',
        'Connection: close',
        'Upgrade-Insecure-Requests: 1',
      ];
      if (cookieH) headers.push('Cookie: ' + cookieH);
      for (const k of Object.keys(extraHeaders)) headers.push(`${k}: ${extraHeaders[k]}`);
      headers.push('', '');
      sock.write(headers.join('\r\n'));
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
        // parse cookies
        const scs = [];
        Object.entries(hdrs).forEach(([k, v]) => {
          if (k.toLowerCase() === 'set-cookie') {
            if (Array.isArray(v)) scs.push(...v); else scs.push(v);
          }
        });
        scs.forEach(c => {
          if (typeof c !== 'string') return;
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        });
        hdrs['set-cookie'] = scs;
        let bodyBuf = buf.slice(headEnd + 4);
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const cl = parseInt(hdrs['content-length'] || '0');
        // 处理 chunked
        if ((hdrs['transfer-encoding'] || '').toLowerCase() === 'chunked') {
          let off = 0;
          let dec = Buffer.alloc(0);
          while (off < bodyBuf.length) {
            const nl = bodyBuf.indexOf('\r\n', off);
            if (nl < 0) break;
            const sz = parseInt(bodyBuf.slice(off, nl).toString('utf8'), 16);
            if (isNaN(sz)) break;
            if (sz === 0) { bodyBuf = dec; break; }
            if (bodyBuf.length < nl + 2 + sz + 2) break;
            dec = Buffer.concat([dec, bodyBuf.slice(nl + 2, nl + 2 + sz)]);
            off = nl + 2 + sz + 2;
          }
          bodyBuf = dec;
        } else if (cl > 0 && bodyBuf.length > cl) {
          bodyBuf = bodyBuf.slice(0, cl);
        }
        try {
          if (enc.includes('br')) bodyBuf = zlib.brotliDecompressSync(bodyBuf);
          else if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf);
        } catch (e) {}
        resolve({ status, headers: hdrs, body: bodyBuf });
      });
      sock.on('error', reject);
      sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('timeout')); });
    });
  });
}

(async () => {
  const imageId = '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586';

  console.log('1. GET /  (init cookies)');
  const r1 = await req('GET', '/', {
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
  });
  console.log('  status:', r1.status, 'cookies:', Object.keys(cookies));

  console.log('\n2. GET /search-by-image?image_id=...');
  const r2 = await req('GET', `/search-by-image?image_id=${imageId}`, {
    'Referer': 'https://www.ozon.ru/',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
  });
  console.log('  status:', r2.status, 'body[:300]:', r2.body.toString('utf8').slice(0, 300));
        console.log('  headers:', Object.entries(r2.headers).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n    '));
        if (r2.status === 307 || r2.status === 302) {
    console.log('  redirect to:', r2.headers.location);
    const newPath = r2.headers.location.startsWith('http') ? r2.headers.location.replace(/^https?:\/\/[^/]+/, '') : r2.headers.location;
    const r3 = await req('GET', newPath, {
      'Referer': 'https://www.ozon.ru/',
      'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
    });
    console.log('\n3. Follow redirect to', newPath);
    console.log('  status:', r3.status);
    console.log('  body length:', r3.body.length);
    console.log('  body[:500]:', r3.body.toString('utf8').slice(0, 500));
    console.log('  body full save to: dump.html');
    require('fs').writeFileSync('dump.html', r3.body);
    if (r3.status === 200) {
      const products = [...r3.body.toString('utf8').matchAll(/"link":"(https?:\/\/[^"]*\/product\/[^"]+)"/g)].map(m => m[1]);
      const titles = [...r3.body.toString('utf8').matchAll(/"title":"([^"]{5,200})"/g)].map(m => m[1]);
      console.log('  *** FOUND', products.length, 'PRODUCTS ***');
      titles.slice(0, 5).forEach((t, i) => console.log(`    [${i+1}] ${t.slice(0, 80)}`));
      console.log('\n*** FULL SUCCESS! ***');
    }
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });