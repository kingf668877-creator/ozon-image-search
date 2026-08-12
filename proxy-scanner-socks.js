// 测试 SOCKS5 代理是否能直连 OZON
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const fs = require('fs');

async function probe(socksAddr) {
  return new Promise((resolve) => {
    const agent = new SocksProxyAgent(`socks5://${socksAddr}`);
    const t0 = Date.now();
    const req = https.get('https://www.ozon.ru/', {
      agent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' },
      timeout: 15000,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8', 0, 1024);
        const server = res.headers['server'] || '';
        const setCookie = res.headers['set-cookie'] || [];
        resolve({ ok: true, server, setCookie: setCookie.length, ms: Date.now() - t0, bodyStart: body.slice(0, 80) });
      });
    });
    req.on('error', e => resolve({ ok: false, reason: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
  });
}

(async () => {
  const proxyList = await new Promise((resolve, reject) => {
    https.get('https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body.split(/\r?\n/).filter(Boolean)));
    }).on('error', reject);
  });
  console.log('SOCKS5 list:', proxyList.length);

  let idx = 0, ok = 0, captcha = 0;
  const concurrency = 20;
  const results = [];

  async function worker() {
    while (idx < proxyList.length) {
      const i = idx++;
      const p = proxyList[i];
      const r = await probe(p);
      results.push({ p, ...r });
      if (r.ok && (r.server.includes('nginx') || r.bodyStart.includes('OZON'))) ok++;
      if (r.ok && r.bodyStart.includes('abt_data')) captcha++;
      if (results.length % 30 === 0) {
        const reasonStats = {};
        results.filter(x => !x.ok).forEach(x => { reasonStats[x.reason] = (reasonStats[x.reason] || 0) + 1; });
        console.log(`  ... ${results.length}/${proxyList.length} ok-realOZ=${ok} captcha=${captcha} err=${results.length - ok - captcha} reasons=${JSON.stringify(reasonStats)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log('\nSUMMARY:', ok, 'realOZON;', captcha, 'captcha');
  const good = results.filter(x => x.ok && (x.server.includes('nginx') || x.bodyStart.includes('OZON')));
  console.log('GOOD SOCKS5:', good.length);
  good.forEach(r => console.log(`  ${r.p}  ${r.ms}ms  server=${r.server}`));
  if (good.length) {
    fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-ozon-socks5.txt',
      good.map(r => 'socks5:' + r.p).join('\n'));
  }
})();