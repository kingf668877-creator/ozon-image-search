/**
 * OZON 批量图搜 · 后端服务 (Express + 4 种代理模式)
 *
 * 模式 A (默认): 纯 API 调用 (ozon-image-api.js + WARP SOCKS5 自动)
 *   - 用 Node http2 走 WARP SOCKS5 (127.0.0.1:1080)，调 OZON 图搜接口
 *   - WARP 提供 Cloudflare 边缘 IP，本机 IP 不被直接使用
 *
 * 模式 B (--browser): Puppeteer + 本机 Chrome (--proxy-server=socks5://127.0.0.1:1080)
 *   - 启动本地 Chrome 真实浏览器 context 调 fetch
 *   - 浏览器通过 SOCKS5 代理走 WARP，TLS fingerprint 真实
 *
 * 模式 C (--direct): 纯 API + 直连 (用户必须已有不被 WAF ban 的 IP)
 *
 * 模式 D (--proxy <list>): 纯 API + 用户提供的代理池
 *
 * 启动:
 *   node server.js                  # 模式 A (WARP + API)
 *   node server.js --browser        # 模式 B (Puppeteer + WARP)
 *   node server.js --direct         # 模式 C (纯直连，不推荐)
 *   node server.js --proxy file     # 模式 D (用户代理池)
 *
 * 健康检查:
 *   http://localhost:5443/api/tasks
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { OzonSession, ProxyPool } = require('./ozon-image-api');

const args = process.argv.slice(2);
const USE_BROWSER = args.includes('--browser') || args.includes('-b');
const USE_DIRECT = args.includes('--direct');
const WARP_SOCKS = 'socks5://127.0.0.1:1080';
const proxyArgIdx = args.indexOf('--proxy');
const USER_PROXY_FILE = proxyArgIdx >= 0 ? args[proxyArgIdx + 1] : null;

const WARP_MARKER = path.join(__dirname, '.warp-enabled');
const WARP_INSTALLED = fs.existsSync(WARP_MARKER);

// ============ 状态 ============
const STATE = {
  tasks: new Map(),
  browser: null,
};

function createTask(taskId) {
  return {
    taskId, createdAt: Date.now(),
    images: [], results: {}, status: 'pending', message: '准备中',
    current: 0, total: 0, searched_count: 0, downloaded_count: 0,
    search_started_at: null, canceled: false,
    emitter: new EventEmitter(),
  };
}
function getTask(taskId) {
  let t = STATE.tasks.get(taskId);
  if (!t) { t = createTask(taskId); STATE.tasks.set(taskId, t); }
  return t;
}

// ============ 模式 A / C / D: 纯 API 调用 ============
async function apiSearchImage(opts) {
  if (!opts.pool) {
    const pool = new ProxyPool();
    if (USER_PROXY_FILE) {
      pool.load(USER_PROXY_FILE);
      console.log('[API] Using user proxy:', USER_PROXY_FILE);
    } else if (USE_DIRECT) {
      console.log('[API] Using direct connection (no proxy)');
      const session = new OzonSession();
      return await session.searchByImage(opts);
    } else if (WARP_INSTALLED) {
      pool.loadFromList(['socks5:127.0.0.1:1080']);
      console.log('[API] Using WARP SOCKS5');
    } else {
      const proxyFile = path.join(__dirname, 'proxies-good.txt');
      if (fs.existsSync(proxyFile)) {
        pool.load(proxyFile);
        console.log('[API] Using proxies-good.txt');
      }
    }
    if (!pool.size()) {
      console.log('[API] No proxy pool available, trying direct');
      const session = new OzonSession();
      return await session.searchByImage(opts);
    }
    const session = new OzonSession({ pool });
    return await session.searchByImage(opts);
  }
  const session = new OzonSession({ pool: opts.pool });
  return await session.searchByImage(opts);
}

// ============ 模式 B: Puppeteer + 本机 Chrome ============
let puppeteer = null;
async function ensureBrowser() {
  if (STATE.browser) return STATE.browser;
  puppeteer = require('puppeteer-core');
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  let exePath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { exePath = c; break; }
  }
  if (!exePath) throw new Error('No Chrome/Edge found');

  console.log('[BROWSER] launching:', exePath);
  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--window-size=1920,1080',
    '--lang=ru-RU',
  ];
  // 不让 Chrome 走代理 — 让浏览器直接用本机家庭宽带 IP
  // （WARP SOCKS5 已被 OZON WAF 标记为 datacenter，不能用）
  void WARP_INSTALLED;
  STATE.browser = await puppeteer.launch({
    executablePath: exePath,
    headless: 'new',
    args: launchArgs,
  });
  console.log('[BROWSER] ready');
  return STATE.browser;
}

async function browserSearchImage(opts) {
  const browser = await ensureBrowser();
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9',
    });
    console.log('[BROWSER] goto https://www.ozon.ru/');
    await page.goto('https://www.ozon.ru/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    const fp = await page.evaluate(() => ({
      url: location.href,
      requestID: window.__NUXT__?.state?.requestID || null,
      cookies: document.cookie,
      isCaptcha: document.body.innerHTML.includes('Похоже, нет'),
      bodyLen: document.body ? document.body.innerHTML.length : 0,
    }));
    console.log('[BROWSER] fingerprint:', JSON.stringify(fp));
    if (fp.isCaptcha) {
      throw new Error('OZON 给了 captcha challenge，请换 IP 或使用住宅代理');
    }

    const imageId = await page.evaluate(async ({ fileBuffer, fileName, url }) => {
      const buf = fileBuffer ? new Uint8Array(fileBuffer) : null;
      const fd = new FormData();
      if (url) {
        fd.append('url', url);
      } else {
        const blob = new Blob([buf], { type: 'image/jpeg' });
        fd.append('file', blob, fileName || 'upload.jpg');
        fd.append('sourceMetadata', JSON.stringify({ width: 1024, height: 1024, type: 'image/jpeg' }));
      }
      const upRes = await fetch('/api/composer-api.bx/_action/searchByImageUpload', {
        method: 'POST', body: fd, credentials: 'include',
      });
      const upJson = await upRes.json();
      if (!upJson.imageId) throw new Error('upload failed: ' + JSON.stringify(upJson).slice(0, 200));
      const cropRes = await fetch('/api/composer-api.bx/_action/searchByImage', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageId: upJson.imageId,
          cropRectangle: { left: 0, top: 0, width: 1, height: 1 },
        }),
      });
      const cropJson = await cropRes.json();
      return {
        imageId: upJson.imageId,
        imageSrc: upJson.imageSrc,
        redirectUri: cropJson.redirectUri,
        resultId: cropJson.resultId,
      };
    }, { fileBuffer: opts.fileBuffer ? Array.from(opts.fileBuffer) : null, fileName: opts.fileName, url: opts.url });

    const fullUrl = imageId.redirectUri.startsWith('http')
      ? imageId.redirectUri
      : 'https://www.ozon.ru' + imageId.redirectUri;
    console.log('[BROWSER] goto results:', fullUrl);
    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    const items = await page.evaluate(() => {
      const out = [];
      const candidates = [];
      document.querySelectorAll('[data-state]').forEach(el => {
        try { candidates.push(JSON.parse(el.getAttribute('data-state') || '{}')); } catch (e) {}
      });
      if (window.__NUXT__?.state) candidates.push(window.__NUXT__.state);
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.link && node.title && (node.price != null || node.finalPrice != null)) {
          out.push({
            url: node.link.startsWith('http') ? node.link : 'https://www.ozon.ru' + node.link,
            title: node.title,
            image: node.image || node.imageUrl || '',
            price: String(node.price != null ? node.price : (node.finalPrice || '')),
            rating: node.rating || null,
            reviews: node.reviewsCount || node.reviews || null,
          });
          return;
        }
        for (const k of Object.keys(node)) {
          if (k === '__proto__') continue;
          walk(node[k]);
        }
      }
      candidates.forEach(walk);
      const seen = new Set();
      return out.filter(x => seen.has(x.url) ? false : (seen.add(x.url), true)).slice(0, 30);
    });

    return { ok: true, imageId: imageId.imageId, redirectUri: imageId.redirectUri, products: items };
  } finally {
    await page.close();
  }
}

// ============ Express ============
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const taskId = req.params.taskId || crypto.randomBytes(8).toString('hex');
    const dir = path.join(UPLOAD_DIR, taskId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    req._taskDir = dir;
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, Date.now() + '_' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

app.get('/api/tasks', (req, res) => {
  res.json({
    success: true,
    service: 'ozon-image-search',
    mode: USE_BROWSER ? 'browser' : 'api',
    warp_enabled: WARP_INSTALLED,
    proxy_config: USER_PROXY_FILE ? USER_PROXY_FILE : (USE_DIRECT ? 'direct' : (WARP_INSTALLED ? 'warp' : 'none')),
    tasks: Array.from(STATE.tasks.values()).map(t => ({
      taskId: t.taskId, status: t.status, total: t.total, current: t.current,
    })),
  });
});

app.post('/api/upload/:taskId', upload.array('files', 200), (req, res) => {
  const task = getTask(req.params.taskId);
  const uploaded = (req.files || []).map(f => ({
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    diskPath: f.path, size: f.size, status: 'pending',
  }));
  task.images.push(...uploaded);
  task.total = task.images.length;
  task.status = 'queued';
  res.json({ success: true, task_id: task.taskId, uploaded_count: uploaded.length });
});

app.post('/api/upload_urls', async (req, res) => {
  const { urls = [], auto_search = true, task_id } = req.body || {};
  const task = task_id ? getTask(task_id) : getTask(crypto.randomBytes(8).toString('hex'));
  const items = urls.map(u => ({ name: u, url: u, status: 'pending' }));
  task.images.push(...items);
  task.total = task.images.length;
  task.status = 'queued';
  if (auto_search) setImmediate(() => startSearch(task.taskId));
  res.json({ success: true, task_id: task.taskId, total_uploaded: items.length });
});

app.post('/api/search/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task.images.length) return res.status(400).json({ success: false, error: 'no images' });
  setImmediate(() => startSearch(task.taskId));
  res.json({ success: true });
});

app.get('/api/status/:taskId', (req, res) => {
  const t = getTask(req.params.taskId);
  res.json({
    status: t.status, message: t.message, current: t.current, total: t.total,
    searched_count: t.searched_count, downloaded_count: t.downloaded_count,
    results_count: Object.keys(t.results).length,
    search_started_at: t.search_started_at,
    image_statuses: t.images.map(img => ({
      name: img.name, status: img.status,
      result_count: (t.results[img.name] || {}).result_count || 0,
      search_time: (t.results[img.name] || {}).search_time || 0,
    })),
  });
});

app.get('/api/results/:taskId', (req, res) => {
  const t = getTask(req.params.taskId);
  res.json({
    total_images: t.total,
    total_products: Object.values(t.results).reduce((s, r) => s + (r.result_count || 0), 0),
    search_duration: (Date.now() - (t.search_started_at || t.createdAt)) / 1000,
    results: t.results,
  });
});

app.post('/api/tasks/:taskId/cancel', (req, res) => {
  const t = getTask(req.params.taskId);
  t.canceled = true;
  t.status = 'failed';
  res.json({ success: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));

async function startSearch(taskId) {
  const task = getTask(taskId);
  task.search_started_at = Date.now();
  task.status = 'searching';
  task.message = `正在搜索 ${task.total} 张图片...`;
  const searchFn = USE_BROWSER ? browserSearchImage : apiSearchImage;

  for (let i = 0; i < task.images.length; i++) {
    if (task.canceled) break;
    const img = task.images[i];
    img.status = 'searching';
    task.current = i + 1;
    task.message = `(${i + 1}/${task.total}) ${img.name}`;
    const t0 = Date.now();
    try {
      const opts = {};
      if (img.diskPath) {
        opts.fileBuffer = fs.readFileSync(img.diskPath);
        opts.fileName = img.name;
      } else if (img.url) {
        opts.url = img.url;
      }
      const r = await searchFn(opts);
      if (r.ok) {
        task.results[img.name] = {
          image_name: img.name, results: r.products,
          result_count: r.products.length,
          search_time: (Date.now() - t0) / 1000,
        };
        img.status = r.products.length ? 'completed' : 'no_results';
      } else {
        task.results[img.name] = {
          image_name: img.name, results: [], result_count: 0,
          search_time: (Date.now() - t0) / 1000, error: r.body || r.error || `HTTP ${r.status}`,
        };
        img.status = 'failed';
      }
      task.searched_count = i + 1;
    } catch (e) {
      console.error('[TASK]', taskId, 'image', img.name, 'failed:', e.message);
      task.results[img.name] = {
        image_name: img.name, results: [], result_count: 0,
        search_time: (Date.now() - t0) / 1000, error: e.message,
      };
      img.status = 'failed';
    }
  }
  task.status = task.canceled ? 'failed' : 'completed';
  task.message = task.canceled ? '已取消' : '完成';
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 5443;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] mode: ${USE_BROWSER ? 'puppeteer + 本机 Chrome' : '纯 API (http2)'}`);
  console.log(`[SERVER] WARP: ${WARP_INSTALLED ? 'enabled (socks5://127.0.0.1:1080)' : 'disabled'}`);
  console.log(`[SERVER] Proxy: ${USER_PROXY_FILE ? USER_PROXY_FILE : (USE_DIRECT ? 'direct' : 'default')}`);
  console.log(`[SERVER] 健康检查: http://localhost:${PORT}/api/tasks`);
});

process.on('SIGINT', async () => {
  console.log('\n[SERVER] SIGINT, closing browser...');
  if (STATE.browser) try { await STATE.browser.close(); } catch {}
  process.exit(0);
});