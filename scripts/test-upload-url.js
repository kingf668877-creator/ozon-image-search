// End-to-end smoke: 通过 /api/upload_urls 触发一次真实图搜。
const http = require('http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port: 5443,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  console.log('POST /api/upload_urls');
  const up = await req('POST', '/api/upload_urls', {
    urls: ['https://ir-20.ozonstatic.cn/s3/multimedia-1-a/wc500/12075745114.jpg'],
    auto_search: true,
  });
  console.log('status', up.status, up.body);
  const taskId = JSON.parse(up.body).task_id;
  if (!taskId) return process.exit(1);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await req('GET', '/api/status/' + taskId);
    const j = JSON.parse(s.body);
    console.log('[' + i + ']', j.status, j.message, 'current=' + j.current + '/' + j.total, 'results=' + j.results_count);
    if (j.status === 'completed' || j.status === 'failed') break;
  }
  const final = await req('GET', '/api/results/' + taskId);
  console.log('--- results ---');
  console.log(final.body);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });