// 直接走 /api/upload/<id> + /api/search/<id> 跑一次本地文件上传图搜
const http = require('http');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'uploads', 'sample.jpg');

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port: 5443, path, method, headers: headers || {} };
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const taskId = 'test' + Date.now();
  const fileBuf = fs.readFileSync(filePath);
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sample.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuf, tail]);
  const len = body.length;

  console.log('POST /api/upload/' + taskId);
  const up = await req('POST', '/api/upload/' + taskId, body, {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': len,
  });
  console.log('upload status', up.status, up.body);

  const start = await req('POST', '/api/search/' + taskId, '{}', { 'Content-Type': 'application/json' });
  console.log('search trigger', start.status, start.body);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await req('GET', '/api/status/' + taskId);
    const j = JSON.parse(s.body);
    console.log('[' + i + ']', j.status, j.message, 'current=' + j.current + '/' + j.total, 'results=' + j.results_count);
    if (j.status === 'completed' || j.status === 'failed') break;
  }
  const final = await req('GET', '/api/results/' + taskId);
  console.log('--- results ---');
  console.log(final.body.slice(0, 2000));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });