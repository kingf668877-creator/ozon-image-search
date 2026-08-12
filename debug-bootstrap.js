// 测试所有代理哪个能真正到达 OZON（server header 不是 squid）
const { OzonSession, ProxyPool } = require('./ozon-image-api');
const fs = require('fs');

(async () => {
  const pool = new ProxyPool();
  pool.load('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-good.txt');
  console.log('Testing ' + pool.size() + ' proxies to find one that reaches real OZON...');

  for (let i = 0; i < pool.size(); i++) {
    const p = pool.next();
    const session = new OzonSession({ pool });
    try {
      const r = await session._request('GET', '/', {});
      const server = r.headers['server'] || '';
      const date = r.headers['date'] || '';
      const isRealOz = !server.includes('squid') && (server.includes('ozon') || server.includes('nginx') || r.body.toString('utf8').includes('OZON'));
      const cookie = r.headers['set-cookie'] || [];
      console.log(`[${i}] ${p.addr} server="${server}" date="${date}" bodyLen=${r.body.length} cookies=${cookie.length} realOz=${isRealOz}`);
      if (isRealOz && cookie.length > 0) {
        console.log('  *** GOOD PROXY ***');
        console.log('  cookies:', cookie);
      }
      if (isRealOz) {
        // 找出好代理，存起来
        fs.appendFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-ozon.txt',
          p.kind + ':' + p.addr + '\n');
      }
    } catch (e) {
      console.log(`[${i}] ${p.addr} ERR: ${e.message}`);
    }
    session.close();
  }
})();