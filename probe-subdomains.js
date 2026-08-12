// 测试 OZON 多个域看哪个不被 captcha
const https = require('https');
const zlib = require('zlib');

function probe(host, path = '/') {
  return new Promise((resolve) => {
    const req = https.request({
      host, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 10000,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let b = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) b = zlib.gunzipSync(b); } catch (e) {}
        resolve({ status: res.statusCode, server: res.headers['server'], len: b.length, bodyStart: b.toString('utf8', 0, 200) });
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

(async () => {
  const hosts = ['www.ozon.ru', 'm.ozon.ru', 'api.ozon.ru', 'ozon.ru', 'st.ozone.ru', 'cdn1.ozonusercontent.com', 'cdn2.ozone.ru', 'tr-oszorfr01.ozon.ru'];
  for (const h of hosts) {
    const r = await probe(h);
    console.log(`${h.padEnd(40)} status=${r.status || 'err'} server=${(r.server || '').slice(0, 20).padEnd(20)} len=${(r.len || 0).toString().padStart(8)} ${r.error || ''}`);
    if (r.bodyStart && (r.bodyStart.includes('OZON') || r.bodyStart.includes('Ozon'))) {
      console.log('    bodyStart:', r.bodyStart.slice(0, 100));
    }
  }
})().catch(e => { console.error(e); });