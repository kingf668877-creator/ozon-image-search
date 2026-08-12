// 下载用户在图搜 URL 里的 imageSrc 作为真实样本
const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://ir-20.ozonstatic.cn/s3/multimedia-1-a/wc500/12075745114.jpg';
const out = path.join(__dirname, '..', 'uploads', 'sample.jpg');

function get(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return resolve(get(r.headers.location));
      }
      if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const buf = await get(url);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });