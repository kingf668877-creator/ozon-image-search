// 看 OZON bootstrap 完整 response headers
const { OzonSession, ProxyPool } = require('./ozon-image-api');
const fs = require('fs');

(async () => {
  const pool = new ProxyPool();
  pool.load('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-good.txt');
  const session = new OzonSession({ pool });
  // 直接调 _request 看完整 headers
  const r = await session._request('GET', '/', {});
  console.log('status:', r.status);
  console.log('headers:', JSON.stringify(r.headers, null, 2));
  console.log('---');
  console.log('cookies after GET /:', Array.from(session.cookies.entries()));
  session.close();
})();