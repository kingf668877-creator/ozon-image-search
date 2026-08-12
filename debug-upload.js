// 专门打印 OZON 返回的 debug echo body
const { OzonSession, ProxyPool } = require('./ozon-image-api');
const fs = require('fs');

(async () => {
  const pool = new ProxyPool();
  pool.load('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/proxies-good.txt');
  const session = new OzonSession({ pool });

  // 手动 build body 并 print 完整 response
  const boundary = '----WebKitFormBoundary' + 'test';
  const sourceMeta = JSON.stringify({ width: 1024, height: 1024, type: 'image/jpeg' });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n' + sourceMeta + '\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg\r\n--' + boundary + '--\r\n'),
  ]);

  // 直接调 uploadByUrl 但打印完整body
  const r = await session._request('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
    body, contentType: 'multipart/form-data', boundary, pagePrevious: 'home',
  });
  console.log('status:', r.status);
  console.log('body:');
  console.log(r.body.toString('utf8'));
  session.close();
})();