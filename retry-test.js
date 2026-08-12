// 重试测试 - 看 OZON 是不是概率性的放行
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
  for (let i = 0; i < 10; i++) {
    Object.keys(cookies).forEach(k => delete cookies[k]);
    try {
      await req('GET', '/', null, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' });
      const r2 = await req('GET', '/?__rr=1', null, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'referer': 'https://www.ozon.ru/', 'x-page-previous': 'home' });
      const isCaptcha = r2.body.toString('utf8').includes('Похоже, нет');
      const html = r2.body.toString('utf8');
      const reqMatch = html.match(/"requestID":"([^"]+)"/);
      console.log(`[${i+1}] r2 status=${r2.status} captcha=${isCaptcha} bodyLen=${r2.body.length} reqID=${reqMatch ? reqMatch[1].slice(0,20) : 'none'}`);
      if (!isCaptcha) {
        console.log('*** NOT CAPTCHA! ***');
        console.log('body[:300]:', html.slice(0, 300));
        break;
      }
    } catch (e) {
      console.log(`[${i+1}] ERR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });