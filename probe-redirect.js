// 详细追踪 OZON redirect 行为
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); }
  req(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
      const h = { ...headers, Host: 'www.ozon.ru', Connection: 'close' };
      if (data) h['Content-Length'] = String(data.length);
      const lines = [`${method} ${path} HTTP/1.1`];
      for (const k of Object.keys(h)) lines.push(`${k}: ${h[k]}`);
      lines.push('', '');
      this.sock.write(lines.join('\r\n'));
      if (data) this.sock.write(data);
      let responded = false;
      this.sock.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        if (responded) return;
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buf.slice(0, idx).toString('utf8');
        const m = head.match(/^HTTP\/[\d.]+ (\d+) /);
        if (!m) { this.sock.destroy(); reject(new Error('bad status')); return; }
        const status = parseInt(m[1]);
        const hdrs = {};
        head.split('\r\n').slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        hdrs['set-cookie'] = Object.entries(hdrs).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
        responded = true;
        let bodyBuf = this.buf.slice(idx + 4);
        const enc = (hdrs['content-encoding'] || '').toLowerCase();
        const contentLen = parseInt(hdrs['content-length'] || '0');
        if (contentLen > 0 && bodyBuf.length < contentLen) {
          this.sock.on('data', (c) => {
            bodyBuf = Buffer.concat([bodyBuf, c]);
            if (bodyBuf.length >= contentLen) {
              try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
              resolve({ status, headers: hdrs, body: bodyBuf });
            }
          });
          return;
        }
        try { if (enc.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf); } catch (e) {}
        resolve({ status, headers: hdrs, body: bodyBuf });
      });
      this.sock.on('error', (e) => responded ? null : reject(e));
      this.sock.setTimeout(15000, () => { if (!responded) { this.sock.destroy(); reject(new Error('timeout')); } });
    });
  }
  close() { try { this.sock.destroy(); } catch {} }
}

async function proxySocks(host, addr) {
  const [ph, pp] = addr.split(':');
  const port = Number(pp);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, ph, () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    let buf = Buffer.alloc(0);
    let phase = 'g';
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, 10000);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'g' && buf.length >= 2 && buf[1] === 0x00) {
        const hb = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(443 >> 8) & 0xff, 443 & 0xff])]));
        buf = Buffer.alloc(0); phase = 'c';
      }
      if (phase === 'c' && buf.length >= 4 && buf[0] === 0x05 && buf[1] === 0x00) {
        const atyp = buf[3]; let c = 4;
        if (atyp === 1) c += 4; else if (atyp === 3) c += 1 + buf[4]; else if (atyp === 4) c += 16;
        c += 2;
        if (buf.length >= c) {
          clearTimeout(timeout);
          const tlsSock = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
          tlsSock.setTimeout(10000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
          tlsSock.on('secureConnect', () => resolve(tlsSock));
          tlsSock.on('error', (e) => reject(e));
        }
      }
    });
    sock.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

(async () => {
  const proxyAddr = '98.170.57.241:4145';
  const tlsSock = await proxySocks('www.ozon.ru', proxyAddr);
  const conn = new Conn(tlsSock);

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Accept-Encoding': 'gzip',
    'x-o3-app-name': 'dweb_client',
    'x-o3-app-version': 'release_csma_20260807-1',
    'x-o3-manifest-version': 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
    'x-page-view-id': crypto.randomUUID(),
  };

  // 1st request
  const r1 = await conn.req('GET', '/', { ...baseHeaders });
  console.log('1st request status:', r1.status);
  console.log('1st response headers:', JSON.stringify(r1.headers, null, 2));
  console.log('1st body length:', r1.body.length);
  console.log('1st body[:500]:', r1.body.toString('utf8', 0, 500));

  // 用同一个 socket pipeline redirect
  if (r1.status === 307 && r1.headers.location) {
    console.log('\nFollowing redirect on same socket (HTTP/1.1 pipeline)...');
    const cookieH = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    console.log('Cookies:', cookieH);
    const path = r1.headers.location.replace(/^https?:\/\/[^/]+/, '');
    // 在同一个 socket 上发送第二个请求 (HTTP/1.1 pipeline 不允许 server 推回 307 之后立刻第二个请求但可行)
    const r1b = await conn.req('GET', path, { ...baseHeaders, Cookie: cookieH });
    console.log('2nd request status:', r1b.status);
    console.log('2nd response headers:', JSON.stringify(r1b.headers, null, 2));
    console.log('2nd body length:', r1b.body.length);
    console.log('2nd body[:500]:', r1b.body.toString('utf8', 0, 500));
  }
  conn.close();
})();