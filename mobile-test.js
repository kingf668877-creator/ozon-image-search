// 测试 mobile user-agent 是否不被 captcha
const https = require('https');
const zlib = require('zlib');

const userAgents = [
  { name: 'iPhone Safari', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'Samsung Android', ua: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36' },
  { name: 'Yandex', ua: 'Mozilla/5.0 (Linux; arm_64; Android 12; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 YaBrowser/24.4.0.0.00 SA/3 Mobile Safari/537.36' },
  { name: 'Desktop Chrome 120', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
];

function test(uaName, ua) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'www.ozon.ru',
      path: '/?__rr=1',
      method: 'GET',
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cookie': '__Secure-ETC=4ae076e70ff47e824b59a2b54ea17567; abt_data=test',
        'x-o3-app-name': 'dweb_client',
        'x-o3-app-version': 'release_csma_20260807-1',
        'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
        'x-page-view-id': crypto.randomUUID(),
      },
      rejectUnauthorized: false,
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let b = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc.includes('gzip')) b = zlib.gunzipSync(b); } catch (e) {}
        const txt = b.toString('utf8');
        resolve({
          uaName,
          status: res.statusCode,
          server: res.headers['server'],
          isCaptcha: txt.includes('Похоже, нет'),
          isHome: txt.includes('OZON') && !txt.includes('Похоже, нет'),
          bodyLen: txt.length,
          cookieCount: (res.headers['set-cookie'] || []).length,
        });
      });
    });
    req.on('error', e => resolve({ uaName, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ uaName, error: 'timeout' }); });
    req.end();
  });
}

const crypto = require('crypto');

(async () => {
  for (const t of userAgents) {
    const r = await test(t.name, t.ua);
    console.log(JSON.stringify(r));
  }
})().catch(e => { console.error(e); });