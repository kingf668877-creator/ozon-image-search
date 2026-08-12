/**
 * OZON 批量图搜 · 纯 API 调用脚本（不依赖浏览器）+ 代理池支持
 *
 * 工作原理：
 *   - 直接用 Node.js http2 调 OZON 官网图搜接口
 *   - 通过 HTTP CONNECT 或 SOCKS5 代理绕过本机 IP 被 ban 的问题
 *   - 自动加载 proxies-good.txt 里的代理池，失败时切换下一个
 *
 * 必要的指纹头 (x-o3-* 必须从真实浏览器抓取后填入):
 *   x-o3-app-name: dweb_client
 *   x-o3-app-version: <release_csma_xxx>
 *   x-o3-manifest-version: <frontend-ozon-ru:xxx>
 *   x-o3-parent-requestid: <UUID>
 *   x-page-view-id: <UUID>
 *   x-page-previous: home
 *
 * Cookie: _nano_fp, __Secure-ab-group, bacntid, rfuid, xcid (自动从首屏抓)
 */

const http2 = require('http2');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ===== 配置 =====
const OZON_HOST = 'www.ozon.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// 默认 fingerprint（首次访问从浏览器抓取后覆盖）
const DEFAULT_FINGERPRINT = {
  appName: 'dweb_client',
  appVersion: 'release_csma_20260807-1',
  manifestVersion: 'frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1',
};

const TLS_OPTS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
    'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305',
  ].join(':'),
  ecdhCurve: 'X25519:P-256:P-384',
  sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384',
  ALPNProtocols: ['h2'],
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
};

// ===== 代理池 =====
class ProxyPool {
  constructor(opts = {}) {
    this.proxies = [];
    this.index = 0;
    this.failureCount = new Map();
    this.maxFailures = opts.maxFailures || 3;
    this.cooldownMs = opts.cooldownMs || 30000;
    this.lastFailure = new Map();
  }

  load(file) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      this.proxies = lines.map(line => {
        const idx = line.indexOf(':');
        const kind = line.slice(0, idx);
        const addr = line.slice(idx + 1);
        return { kind: kind || 'http', addr: addr || line };
      });
      console.log(`[PROXY] Loaded ${this.proxies.length} proxies from ${file}`);
      return this.proxies.length;
    } catch (e) {
      console.warn('[PROXY] No proxies loaded:', e.message);
      return 0;
    }
  }

  loadFromList(list) {
    this.proxies = list.map(line => {
      const idx = line.indexOf(':');
      const kind = line.slice(0, idx);
      const addr = line.slice(idx + 1);
      return { kind: kind || 'http', addr: addr || line };
    }).filter(p => p.addr);
    console.log(`[PROXY] Loaded ${this.proxies.length} proxies from list`);
  }

  next() {
    if (!this.proxies.length) return null;
    const startIdx = this.index;
    let attempts = 0;
    while (attempts < this.proxies.length) {
      const p = this.proxies[this.index];
      this.index = (this.index + 1) % this.proxies.length;

      const failures = this.failureCount.get(p.addr) || 0;
      const lastFail = this.lastFailure.get(p.addr) || 0;
      const inCooldown = failures >= this.maxFailures && (Date.now() - lastFail) < this.cooldownMs;

      if (inCooldown) {
        attempts++;
        continue;
      }
      return p;
    }
    // 全部冷却中，重置并返回第一个
    this.failureCount.clear();
    this.lastFailure.clear();
    return this.proxies[0];
  }

  markFailure(proxy) {
    const c = (this.failureCount.get(proxy.addr) || 0) + 1;
    this.failureCount.set(proxy.addr, c);
    this.lastFailure.set(proxy.addr, Date.now());
  }

  markSuccess(proxy) {
    this.failureCount.delete(proxy.addr);
  }

  size() { return this.proxies.length; }
}

// ===== 通过 HTTP CONNECT 代理的 http2 session =====
function proxyConnect2(proxy, targetHost) {
  return new Promise((resolve, reject) => {
    const [ph, pp] = proxy.addr.split(':');
    const port = Number(pp);

    const sock = net.connect(port, ph, () => {
      if (proxy.kind === 'socks5') {
        // SOCKS5 handshake
        sock.write(Buffer.from([0x05, 0x01, 0x00])); // VER, NMETHODS=1, METHOD=no-auth
      } else {
        // HTTP CONNECT
        sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}\r\n\r\n`);
      }
    });

    let buf = Buffer.alloc(0);
    let phase = proxy.kind === 'socks5' ? 'greeting' : 'connect';

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (proxy.kind === 'socks5' && phase === 'greeting') {
        if (buf.length >= 2 && buf[1] === 0x00) {
          // OK, send CONNECT request: VER=5, CMD=1(CONNECT), RSV, ATYP=3(DOMAIN) + len + domain + port
          const hostBuf = Buffer.from(targetHost);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(443 >> 8) & 0xff, 443 & 0xff]),
          ]);
          buf = Buffer.alloc(0);
          phase = 'connect';
          sock.write(req);
        } else {
          sock.destroy();
          reject(new Error('SOCKS5 auth failed'));
        }
      }
      if (phase === 'connect') {
        // HTTP CONNECT: "HTTP/1.1 200 OK"
        // SOCKS5 CONNECT reply: VER, REP, RSV, ATYP, ...
        if (proxy.kind === 'socks5') {
          if (buf.length >= 4 && buf[0] === 0x05 && buf[1] === 0x00) {
            // 成功 — 解析剩余的 BND.ADDR + BND.PORT
            const atyp = buf[3];
            let consumed = 4;
            if (atyp === 1) consumed += 4;       // IPv4
            else if (atyp === 3) {
              consumed += 1 + buf[4];
            } else if (atyp === 4) consumed += 16; // IPv6
            consumed += 2; // port
            if (buf.length >= consumed) {
              resolve(sock);
            }
          }
        } else {
          const s = buf.toString('utf8');
          if (s.includes('\r\n\r\n') || s.match(/^HTTP\/[\d.]+ \d+/)) {
            const m = s.match(/^HTTP\/[\d.]+ (\d+)/);
            if (m && m[1] === '200') resolve(sock);
            else { sock.destroy(); reject(new Error('CONNECT ' + m[1])); }
          }
        }
      }
    });

    sock.on('error', reject);
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('proxy connect timeout')); });
  });
}

// ===== HTTP/2 over proxy (raw socket + TLS + ALPN h2) =====
function h2OverProxy(proxy, targetHost, opts = {}) {
  return new Promise((resolve, reject) => {
    proxyConnect2(proxy, targetHost).then(rawSock => {
      const tlsSock = tls.connect({
        socket: rawSock,
        servername: targetHost,
        ALPNProtocols: ['h2'],
        rejectUnauthorized: false,
      });
      tlsSock.on('secureConnect', () => {
        if (tlsSock.alpnProtocol !== 'h2') {
          tlsSock.destroy();
          reject(new Error('ALPN did not negotiate h2'));
          return;
        }
        const session = http2.connect(`https://${targetHost}`, {
          createConnection: () => tlsSock,
          ...opts,
        });
        session.on('error', reject);
        resolve(session);
      });
      tlsSock.on('error', reject);
      tlsSock.setTimeout(15000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
    }).catch(reject);
  });
}

// ===== HTTP/1.1 fallback (for proxies where ALPN h2 fails) =====
function h1OverProxy(proxy, targetHost, opts = {}) {
  return new Promise((resolve, reject) => {
    proxyConnect2(proxy, targetHost).then(rawSock => {
      const tlsSock = tls.connect({
        socket: rawSock,
        servername: targetHost,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: false,
      });
      tlsSock.on('error', reject);
      tlsSock.setTimeout(15000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
      // 让上层自行处理；这里只返回 socket
      tlsSock.on('secureConnect', () => resolve(tlsSock));
    }).catch(reject);
  });
}

// ===== OzonSession =====
class OzonSession {
  constructor(opts = {}) {
    this.cookies = new Map();
    this.fp = opts.fingerprint || DEFAULT_FINGERPRINT;
    this.requestID = null;
    this.pool = opts.pool || null;
    this.proxy = null;
    this.h2Session = null;
  }

  setCookiesFromHeaders(headers) {
    const sc = headers['set-cookie'] || [];
    sc.forEach(c => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    });
  }

  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _defaultHeaders(extra = {}) {
    return {
      ':authority': OZON_HOST,
      ':scheme': 'https',
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8,zh;q=0.6',
      'accept-encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
      'cookie': this.cookieHeader(),
      'x-o3-app-name': this.fp.appName,
      'x-o3-app-version': this.fp.appVersion,
      'x-o3-manifest-version': this.fp.manifestVersion,
      ...extra,
    };
  }

  async _ensureSession() {
    if (this.h2Session && !this.h2Session.closed && !this.h2Session.destroyed) {
      return this.h2Session;
    }
    // 直连模式：直接建 HTTP/2
    if (!this.pool) {
      const session = http2.connect(`https://${OZON_HOST}`, { rejectUnauthorized: false });
      this.h2Session = session;
      return session;
    }
    // 尝试最多 5 个代理直到成功建立连接
    let lastErr;
    for (let i = 0; i < Math.min(5, this.pool.size()); i++) {
      const p = this.pool.next();
      if (!p) break;
      try {
        const session = await h2OverProxy(p, OZON_HOST, { rejectUnauthorized: false });
        this.proxy = p;
        this.h2Session = session;
        this.pool.markSuccess(p);
        return session;
      } catch (e) {
        console.warn(`[PROXY] ${p.addr} failed: ${e.message}`);
        this.pool.markFailure(p);
        lastErr = e;
      }
    }
    throw lastErr || new Error('No proxy available');
  }

  async _request(method, path, opts = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await this._ensureSession();
      const result = await new Promise((resolve) => {
        const headers = this._defaultHeaders(opts.headers || {});
        headers[':method'] = method;
        headers[':path'] = path;
        if (!this.requestID && opts.needRequestId !== false) {
          this.requestID = crypto.randomUUID();
        }
        if (this.requestID && opts.skipRequestId !== true) {
          headers['x-o3-parent-requestid'] = this.requestID;
        }
        if (!opts.skipRequestId) {
          headers['x-page-view-id'] = crypto.randomUUID();
        }
        if (opts.pagePrevious) headers['x-page-previous'] = opts.pagePrevious;

        const req = session.request(headers);
        const chunks = [];
        let responded = false;
        req.on('response', (rh) => {
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            responded = true;
            this.setCookiesFromHeaders(rh);
            const raw = Buffer.concat(chunks);
            let body = raw;
            const enc = (rh['content-encoding'] || '').toLowerCase();
            try {
              if (enc.includes('gzip')) body = zlib.gunzipSync(raw);
              else if (enc.includes('br')) body = zlib.brotliDecompressSync(raw);
            } catch (e) {}
            resolve({ status: rh[':status'], headers: rh, body });
          });
        });
        req.on('error', (e) => {
          if (!responded) {
            // connection broken, close session
            try { session.close(); } catch {}
            this.h2Session = null;
            resolve({ error: e });
          }
        });
        req.setTimeout(20000, () => req.close());
        if (opts.body) req.write(opts.body);
        req.end();
      });
      if (result.error) {
        lastErr = result.error;
        if (this.proxy) this.pool.markFailure(this.proxy);
        this.h2Session = null;
        continue; // try next proxy
      }
      return result;
    }
    throw lastErr || new Error('All proxies failed');
  }

  // ===== 完整 4 步图搜流程 =====
  async searchByImage({ fileBuffer, fileName, url }) {
    console.log('[BOOT] GET https://www.ozon.ru/');
    const r = await this._request('GET', '/');
    console.log('  status:', r.status);
    if (r.status === 307 && r.headers.location) {
      console.log('[BOOT] follow:', r.headers.location);
      // 重定向时设置 same-origin + referer
      const r2 = await this._request('GET', new URL(r.headers.location).pathname + new URL(r.headers.location).search, {
        pagePrevious: 'home',
        headers: {
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'referer': 'https://www.ozon.ru/',
        },
      });
      console.log('  status:', r2.status);
      if (r2.status !== 200) {
        return { ok: false, stage: 'bootstrap', status: r2.status, html: r2.body.toString('utf8').slice(0, 1000) };
      }
      return this._continueSearch(r2, { fileBuffer, fileName, url });
    }
    if (r.status !== 200) {
      return { ok: false, stage: 'bootstrap', status: r.status, html: r.body.toString('utf8').slice(0, 1000) };
    }
    return this._continueSearch(r, { fileBuffer, fileName, url });
  }

  async _continueSearch(bootResp, opts) {
    const html = bootResp.body.toString('utf8');
    // 提取 requestID
    const nuxtMatch = html.match(/<script[^>]*>\s*window\.__NUXT__\s*=\s*([\s\S]{100,500000}?)<\/script>/);
    if (nuxtMatch) {
      const m1 = nuxtMatch[1].match(/"requestID":\s*"([^"]+)"/);
      if (m1) this.requestID = m1[1];
    }
    const cfgMatch = html.match(/<script[^>]*>window\.__APP_CONFIG__\s*=\s*(\{[\s\S]{100,50000}?\});<\/script>/);
    if (cfgMatch) {
      try {
        const cfg = JSON.parse(cfgMatch[1]);
        if (cfg.manifestVersion) this.fp.manifestVersion = cfg.manifestVersion;
        if (cfg.appVersion) this.fp.appVersion = cfg.appVersion;
      } catch (e) {}
    }
    console.log(`[BOOT] OK requestID=${this.requestID} appVersion=${this.fp.appVersion}`);

    // 上传
    let up;
    if (opts.fileBuffer) {
      up = await this.uploadImage({ buffer: opts.fileBuffer, fileName: opts.fileName || 'upload.jpg' });
    } else if (opts.url) {
      up = await this.uploadByUrl(opts.url);
    } else {
      return { ok: false, stage: 'input', error: 'need fileBuffer or url' };
    }
    if (!up.ok) return { ok: false, stage: 'upload', ...up };

    // crop
    const crop = await this.submitCrop(up.imageId);
    if (!crop.ok) return { ok: false, stage: 'crop', ...crop };

    // 跟踪结果
    const result = await this.fetchResults(crop.redirectUri);
    if (!result.ok) return { ok: false, stage: 'results', ...result };

    return {
      ok: true,
      imageId: up.imageId,
      redirectUri: crop.redirectUri,
      products: result.items,
    };
  }

  async uploadImage({ buffer, fileName, mimeType = 'image/jpeg' }) {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const sourceMeta = JSON.stringify({ width: 1024, height: 1024, type: mimeType });
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="sourceMetadata"\r\n\r\n' + sourceMeta + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: ' + mimeType + '\r\n\r\n'),
      buffer,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    console.log(`[UPLOAD] POST .../searchByImageUpload (${buffer.length}B)`);
    const r = await this._request('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
      body,
      contentType: 'multipart/form-data',
      boundary,
      pagePrevious: 'home',
    });
    let json;
    try { json = JSON.parse(r.body.toString('utf8')); } catch (e) { json = null; }
    console.log('  status:', r.status, 'body:', JSON.stringify(json).slice(0, 200));
    if (r.status !== 200 || !json || !json.imageId) {
      return { ok: false, status: r.status, body: json || r.body.toString('utf8').slice(0, 500) };
    }
    return { ok: true, imageId: json.imageId, imageSrc: json.imageSrc };
  }

  async uploadByUrl(url) {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="url"\r\n\r\n${url}\r\n--${boundary}--\r\n`),
    ]);
    console.log(`[UPLOAD-URL] POST .../searchByImageUpload (url: ${url})`);
    const r = await this._request('POST', '/api/composer-api.bx/_action/searchByImageUpload', {
      body,
      contentType: 'multipart/form-data',
      boundary,
      pagePrevious: 'home',
    });
    let json;
    try { json = JSON.parse(r.body.toString('utf8')); } catch (e) { json = null; }
    console.log('  status:', r.status, 'body:', JSON.stringify(json).slice(0, 200));
    if (r.status !== 200 || !json || !json.imageId) {
      return { ok: false, status: r.status, body: json || r.body.toString('utf8').slice(0, 500) };
    }
    return { ok: true, imageId: json.imageId, imageSrc: json.imageSrc };
  }

  async submitCrop(imageId, crop = { left: 0, top: 0, width: 1, height: 1 }) {
    const body = JSON.stringify({ imageId, cropRectangle: crop });
    console.log(`[CROP] POST .../searchByImage`);
    const r = await this._request('POST', '/api/composer-api.bx/_action/searchByImage', {
      body,
      contentType: 'application/json',
      pagePrevious: 'home',
    });
    let json;
    try { json = JSON.parse(r.body.toString('utf8')); } catch (e) { json = null; }
    console.log('  status:', r.status, 'body:', JSON.stringify(json).slice(0, 200));
    if (r.status !== 200 || !json || !json.redirectUri) {
      return { ok: false, status: r.status, body: json || r.body.toString('utf8').slice(0, 500) };
    }
    return { ok: true, redirectUri: json.redirectUri, resultId: json.resultId };
  }

  async fetchResults(redirectUri) {
    const u = new URL(redirectUri, `https://${OZON_HOST}`);
    console.log(`[RESULT] GET ${u.pathname}${u.search}`);
    const r = await this._request('GET', u.pathname + u.search, {
      skipRequestId: true,
      headers: {
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    console.log('  status:', r.status);
    if (r.status !== 200) {
      return { ok: false, status: r.status, html: r.body.toString('utf8').slice(0, 500) };
    }
    const items = this._extractProducts(r.body.toString('utf8'));
    return { ok: true, count: items.length, items };
  }

  _extractProducts(html) {
    const out = [];
    const candidates = [];
    const dataStateMatches = html.matchAll(/data-state=(["'])(.+?)\1/g);
    for (const m of dataStateMatches) {
      try { candidates.push(JSON.parse(m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))); } catch (e) {}
    }
    const nuxtMatch = html.match(/<script[^>]*>\s*window\.__NUXT__\s*=\s*([\s\S]{100,5000000}?)<\/script>/);
    if (nuxtMatch) {
      try { candidates.push(JSON.parse(nuxtMatch[1])); } catch (e) {}
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const hasLink = typeof node.link === 'string' && node.link.includes('/product/');
      const hasTitle = typeof node.title === 'string' && node.title.length > 3;
      const hasPrice = node.price != null || node.finalPrice != null || node.cardPrice != null;
      if (hasLink && hasTitle && hasPrice) {
        out.push({
          url: node.link.startsWith('http') ? node.link : 'https://' + OZON_HOST + node.link,
          title: node.title,
          image: node.image || node.imageUrl || (node.images && node.images[0]) || '',
          price: String(node.price || node.finalPrice || node.cardPrice || ''),
          rating: node.rating || null,
          reviews: node.reviewsCount || node.reviews || null,
        });
      }
      for (const k of Object.keys(node)) {
        if (k === '__proto__') continue;
        walk(node[k]);
      }
    }
    candidates.forEach(walk);
    const seen = new Set();
    return out.filter(x => seen.has(x.url) ? false : (seen.add(x.url), true));
  }

  close() {
    if (this.h2Session) try { this.h2Session.close(); } catch {}
  }
}

// ===== CLI =====
if (require.main === module) {
  const argv = process.argv.slice(2);
  let filePath = null;
  let imageUrl = null;
  let proxyFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') filePath = argv[++i];
    else if (argv[i] === '--url') imageUrl = argv[++i];
    else if (argv[i] === '--proxies') proxyFile = argv[++i];
  }

  if (!filePath && !imageUrl) {
    console.log('Usage: node ozon-image-api.js [--file path] [--url URL] [--proxies file]');
    console.log('');
    console.log('Output: { ok, imageId, redirectUri, products: [...] }');
    process.exit(1);
  }

  (async () => {
    const pool = new ProxyPool();
    if (proxyFile) {
      pool.load(proxyFile);
    } else {
      // 默认查找 proxies-good.txt
      const defaultFile = path.join(__dirname, 'proxies-good.txt');
      if (fs.existsSync(defaultFile)) pool.load(defaultFile);
      else {
        // 从 list.txt 加载并立即扫描
        const listFile = path.join(__dirname, 'proxies-list.txt');
        if (fs.existsSync(listFile)) {
          pool.loadFromList(fs.readFileSync(listFile, 'utf8').split(/\r?\n/));
        } else {
          console.error('[ERROR] No proxies available. Run proxy-scanner.js first or pass --proxies.');
          process.exit(1);
        }
      }
    }
    if (!pool.size()) {
      console.error('[ERROR] proxy list is empty');
      process.exit(1);
    }
    const session = new OzonSession({ pool });
    let buffer = null, fileName = null;
    if (filePath) {
      buffer = fs.readFileSync(filePath);
      fileName = path.basename(filePath);
    }
    const result = await session.searchByImage({ fileBuffer: buffer, fileName, url: imageUrl });
    console.log('\n===== RESULT =====');
    console.log(JSON.stringify(result, null, 2));
    session.close();
    process.exit(result.ok ? 0 : 2);
  })().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(3); });
}

module.exports = { OzonSession, ProxyPool, DEFAULT_FINGERPRINT };