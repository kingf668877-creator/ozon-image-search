// 测试 Cloudflare WARP 安装情况
const https = require('https');
const { exec } = require('child_process');

console.log('=== Checking Cloudflare WARP installation ===');

exec('where warp-cli 2>&1', (err, stdout) => {
  console.log('warp-cli:', stdout || 'NOT FOUND');

  exec('where cloudflare-warp 2>&1', (err, stdout) => {
    console.log('cloudflare-warp:', stdout || 'NOT FOUND');

    exec('warp-cli --help 2>&1', (err, stdout, stderr) => {
      console.log('warp-cli --help output:', stdout || stderr || 'NOT WORKING');
    });
  });
});