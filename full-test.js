// 直接重新测试两个 OZON 可达代理（不经过 pool）
const { OzonSession, ProxyPool } = require('./ozon-image-api');
const fs = require('fs');

(async () => {
  const pool = new ProxyPool();
  pool.loadFromList(['http:108.131.109.106:17562', 'http:15.160.132.166:6649']);
  const session = new OzonSession({ pool });

  console.log('=== TEST 1: searchByImage via URL ===');
  const r1 = await session.searchByImage({
    url: 'https://cdn1.ozonusercontent.com/s3/multimedia-u/6901892013.jpg',
  });
  console.log('Result 1:', JSON.stringify(r1, null, 2));

  if (r1.ok) {
    console.log('\n=== SUCCESS! Got', r1.products.length, 'products ===');
    r1.products.slice(0, 5).forEach((p, i) => {
      console.log(`  [${i+1}] ${p.title.slice(0,80)}`);
      console.log(`      ${p.price}₽ | ${p.url.slice(0, 100)}`);
    });
  }

  session.close();
  process.exit(r1.ok ? 0 : 2);
})().catch(e => { console.error('FATAL:', e); process.exit(3); });