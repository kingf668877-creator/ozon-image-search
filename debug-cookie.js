const { OzonSession, ProxyPool } = require('./ozon-image-api');
(async () => {
  const pool = new ProxyPool();
  pool.loadFromList(['socks5:127.0.0.1:1080']);
  const session = new OzonSession({ pool });

  console.log('1st request:');
  const r1 = await session._request('GET', '/', {});
  console.log('  status:', r1.status);
  console.log('  set-cookie count:', (r1.headers['set-cookie'] || []).length);
  console.log('  cookies in session:', Array.from(session.cookies.keys()));
  console.log('  cookie header:', session.cookieHeader().slice(0, 200));

  console.log('\n2nd request:');
  const r2 = await session._request('GET', '/?__rr=1', {
    pagePrevious: 'home',
    headers: {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'referer': 'https://www.ozon.ru/',
    },
  });
  console.log('  status:', r2.status);
  console.log('  body[:300]:', r2.body.toString('utf8').slice(0, 300));
  console.log('  cookie header now:', session.cookieHeader().slice(0, 200));
  session.close();
})().catch(e => { console.error('FATAL:', e.message); });