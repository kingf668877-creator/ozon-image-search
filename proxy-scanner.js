/**
 * OZON 图搜 · 代理扫描器 (v2: HTTPS-over-CONNECT)
 *
 * 测试一组免费 HTTPS / SOCKS5 代理，找出能成功访问 https://www.ozon.ru 的。
 *
 * 用法：
 *   node proxy-scanner.js https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt [limit]
 */

const https = require('https');
const http = require('http');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const TEST_HOST = 'www.ozon.ru';
const TEST_TIMEOUT = 12000;
const CONCURRENCY = 20;

function loadProxies(arg) {
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    return new Promise((resolve, reject) => {
      const u = new URL(arg);
      const mod = u.protocol === 'https:' ? https : http;
      mod.get(arg, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
      }).on('error', reject);
    });
  }
  return arg.split(/[,\s]+/).filter(Boolean);
}

async function probeViaAgent(proxyAddr, kind) {
  const [host, port] = proxyAddr.split(':');
  if (!host || !port) return { ok: false, reason: 'bad-format' };

  const proxyUrl = kind === 'socks5'
    ? `socks5://${host}:${port}`
    : `http://${host}:${port}`;

  let agent;
  try {
    agent = kind === 'socks5' ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    return { ok: false, reason: 'agent-init' };
  }

  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get(`https://${TEST_HOST}/`, {
      agent,
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9', 'Accept': 'text/html' },
      timeout: TEST_TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8', 0, 1024);
        const isCaptcha = body.includes('abt_data') || body.includes('Похоже, нет') || body.includes('abt-challenge');
        const isOz = body.includes('OZON') || body.includes('Ozon') || body.includes('ozon.ru');
        resolve({
          ok: true,
          proxy: proxyAddr,
          kind,
          status: res.statusCode,
          ms: Date.now() - t0,
          isCaptcha,
          isOz,
          bodyStart: body.slice(0, 80).replace(/\n/g, ' '),
        });
      });
      res.on('error', () => {});
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout', proxy: proxyAddr }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message.slice(0, 30), proxy: proxyAddr }));
  });
}

async function runBatch(proxies, kind, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < proxies.length) {
      const myIdx = idx++;
      const r = await probeViaAgent(proxies[myIdx], kind);
      results.push(r);
      if (results.length % 20 === 0 || results.length === proxies.length) {
        const ok = results.filter(x => x.ok && x.isOz && !x.isCaptcha).length;
        const captcha = results.filter(x => x.ok && x.isCaptcha).length;
        const err = results.filter(x => !x.ok).length;
        const reasonStats = {};
        results.filter(x => !x.ok).forEach(x => { reasonStats[x.reason] = (reasonStats[x.reason] || 0) + 1; });
        console.log(`  ... ${results.length}/${proxies.length}  ok-OZ=${ok} captcha=${captcha} err=${err}  reasons=${JSON.stringify(reasonStats)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

(async () => {
  const arg = process.argv[2] || 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt';
  const kind = (process.argv[4] || 'http').toLowerCase();
  const limit = parseInt(process.argv[3] || '0');
  console.log('Loading proxies from:', arg, '(kind=' + kind + ')');
  const allProxies = await loadProxies(arg);
  console.log('Loaded:', allProxies.length);
  const proxies = limit > 0 ? allProxies.slice(0, limit) : allProxies;
  console.log('Testing:', proxies.length);

  const results = await runBatch(proxies, kind, CONCURRENCY);

  const ozPass = results.filter(x => x.ok && x.status === 200 && x.isOz && !x.isCaptcha);
  const captcha = results.filter(x => x.ok && x.isCaptcha);
  const reachable = results.filter(x => x.ok);

  console.log('\n=========== SUMMARY ===========');
  console.log('Total tested:', results.length);
  console.log('HTTP 200 + real OZON:', ozPass.length);
  console.log('Reachable (any):', reachable.length);
  console.log('Captcha-403:', captcha.length);

  if (ozPass.length) {
    console.log('\n>>> WINNERS:');
    ozPass.slice(0, 30).forEach(r => console.log(`  ${r.proxy} (${r.kind}) ${r.ms}ms status=${r.status}`));
  }
  if (captcha.length) {
    console.log('\n>>> Captcha-403 (proxy alive, OZON WAF blocks IP):');
    captcha.slice(0, 20).forEach(r => console.log(`  ${r.proxy} (${r.kind}) ${r.ms}ms status=${r.status}`));
  }

  if (reachable.length) {
    fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-good.txt',
      reachable.map(r => `${r.kind}:${r.proxy}`).join('\n'));
    console.log(`\nSaved ${reachable.length} reachable proxies to proxies-good.txt`);
  }
})();