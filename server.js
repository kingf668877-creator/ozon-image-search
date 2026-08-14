/**
 * OZON 图搜 · 本地 Web 服务（Express + 浏览器代理 + 接管备用）
 *
 * 启动方式：
 *   node server.js              # 默认 HTTP 代理模式（浏览器内并发 fetch + 复用已登录会话）
 *   OZON_MODE=attach node ...   # 退回旧 CDP 接管模式（每张图 navigate+DOM，慢且非批量）
 *
 * 健康检查：
 *   GET /api/health   -> { mode, sessionOk }
 *   GET /api/session  -> { ok, tabs:[{url,title}], mode, session }
 *   POST /api/session/refresh -> 重新从浏览器抓取会话凭证（HTTP 代理模式下备用）
 *
 * 前端协议与原实现完全一致，无需改动。
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MODE = (process.env.OZON_MODE || 'http').toLowerCase();

const PORT = Number(process.env.PORT || 5443);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_PORT = Number(process.env.OZON_CDP_PORT || 9225);

const ozonSearch = require('./src/ozonSearch');
const ozonHttp = require('./src/ozonHttp');
const ozonSession = require('./src/ozonSession');

const STATE = { tasks: new Map() };

function createTask(taskId) {
  return {
    taskId,
    createdAt: Date.now(),
    images: [],
    results: {},
    status: 'pending',
    message: '准备中',
    current: 0,
    total: 0,
    searched_count: 0,
    downloaded_count: 0,
    search_started_at: null,
    canceled: false,
    emitter: new EventEmitter(),
  };
}
function getTask(taskId) {
  let t = STATE.tasks.get(taskId);
  if (!t) { t = createTask(taskId); STATE.tasks.set(taskId, t); }
  return t;
}

// ============== 搜索执行 ==============
async function runSearchHttp(img) {
  if (!img.diskPath || !fs.existsSync(img.diskPath)) {
    return { ok: false, error: 'no_input', code: 'no_input' };
  }
  const buf = fs.readFileSync(img.diskPath);
  try {
    const r = await ozonHttp.searchByFile(buf, img.name);
    return {
      ok: true,
      products: r.products,
      imageId: r.imageId,
      redirectUri: r.redirectUri,
      meta: { method: 'http' },
      upload_seconds: r.upload_seconds,
      search_seconds: r.search_seconds,
      total_seconds: r.total_seconds,
      search_attempts: r.search_attempts,
    };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code, status: e.status };
  }
}

async function runSearchAttach(img) {
  const opts = {};
  if (img.diskPath) {
    opts.fileBuffer = fs.readFileSync(img.diskPath);
    opts.fileName = img.name;
  } else if (img.url) {
    opts.url = img.url;
  } else {
    return { ok: false, error: 'no_input' };
  }
  const handle = await ozonSearch.attachChrome({ port: CDP_PORT });
  try {
    const r = await ozonSearch.searchByImage(handle, opts);
    return { ok: true, products: r.products, imageId: r.imageId, redirectUri: r.redirectUri, meta: r.meta };
  } finally {
    try { await handle.close(); } catch {}
  }
}

async function runSearch(img) {
  if (MODE === 'attach') return runSearchAttach(img);
  return runSearchHttp(img);
}

async function startSearch(taskId) {
  const task = getTask(taskId);
  // Fail fast if CDP is down so the task doesn't pretend to run.
  if (MODE === 'http') {
    try {
      const tabs = await ozonSearch.listTabs(CDP_PORT);
      const ozonTabs = tabs.filter((t) => (t.url || '').includes('ozon.ru'));
      if (!ozonTabs.length) {
        task.status = 'failed';
        task.message = 'Chrome 已就绪但缺少 OZON 标签页，请检查浏览器窗口';
        return;
      }
    } catch (e) {
      task.status = 'failed';
      task.message = `Chrome 未运行或 CDP 不可达 (port ${CDP_PORT})，请启动 start-ozon-headless.ps1`;
      return;
    }
  }
  task.search_started_at = Date.now();
  task.status = 'searching';
  task.message = `正在搜索 ${task.total} 张图片...`;

  const concurrency = MODE === 'attach'
    ? 1
    : Number(process.env.OZON_HTTP_CONCURRENCY || 3);

  let nextIndex = 0;
  async function worker() {
    while (true) {
      if (task.canceled) return;
      const i = nextIndex;
      nextIndex += 1;
      if (i >= task.images.length) return;
      const img = task.images[i];
      img.status = 'searching';
      task.current = Math.min(task.searched_count + 1, task.total);
      task.message = `(${task.current}/${task.total}) ${img.name}`;
      const t0 = Date.now();
      try {
        const r = await runSearch(img);
        if (r.ok) {
          const products = Array.isArray(r.products) ? r.products : (r.products && r.products.products) || [];
          task.results[img.name] = {
            image_name: img.name,
            results: products,
            result_count: products.length,
            search_time: (Date.now() - t0) / 1000,
            imageId: r.imageId,
            redirectUri: r.redirectUri,
            meta: r.meta,
            upload_seconds: r.upload_seconds,
            search_seconds: r.search_seconds,
            total_seconds: r.total_seconds,
            search_attempts: r.search_attempts,
          };
          img.status = products.length ? 'completed' : 'no_results';
        } else {
          task.results[img.name] = {
            image_name: img.name,
            results: [],
            result_count: 0,
            search_time: (Date.now() - t0) / 1000,
            error: r.error || r.body || `HTTP ${r.status || 'unknown'}`,
            errorCode: r.code,
          };
          img.status = 'failed';
        }
      } catch (e) {
        console.error('[TASK]', taskId, 'image', img.name, 'failed:', e.message);
        task.results[img.name] = {
          image_name: img.name,
          results: [],
          result_count: 0,
          search_time: (Date.now() - t0) / 1000,
          error: e.message,
          errorCode: e.code,
        };
        img.status = 'failed';
      }
      task.searched_count += 1;
      task.current = Math.min(task.searched_count, task.total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, task.images.length) }, worker));

  if (MODE === 'http' && Object.values(task.results).every((r) => r && r.errorCode === 'auth_invalid')) {
    task.message = '浏览器会话已过期，请在 Chrome 中重新登录 OZON 并重试';
  }
  task.status = task.canceled ? 'failed' : 'completed';
  task.message = task.canceled ? '已取消' : '完成';
}

// ============== Express ==============
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');

function cleanupUploads() {
  try {
    if (fs.existsSync(UPLOAD_DIR)) {
      const entries = fs.readdirSync(UPLOAD_DIR);
      for (const entry of entries) {
        const fullPath = path.join(UPLOAD_DIR, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
      console.log(`[CLEANUP] 删除 ${entries.length} 个 uploads 条目`);
    }
  } catch (e) {
    console.error('[CLEANUP] 清理失败:', e.message);
  }
}

function clearAllTasks() {
  STATE.tasks.clear();
}

cleanupUploads();
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
    const original = Buffer.from(file.originalname || 'upload', 'latin1').toString('utf8');
    const ts = Date.now();
    cb(null, `${ts}_${original}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'ozon-image-search',
    mode: MODE,
    port: PORT,
    cdpPort: CDP_PORT,
    startedAt: new Date().toISOString(),
    session: ozonSession.status(),
    concurrency: MODE === 'attach' ? 1 : Number(process.env.OZON_HTTP_CONCURRENCY || 3),
  });
});

app.get('/api/session', async (req, res) => {
  try {
    const tabs = await ozonSearch.listTabs(CDP_PORT);
    const ozonTabs = tabs
      .filter((t) => (t.url || '').includes('ozon.ru'))
      .map((t) => ({ url: t.url, title: t.title, type: t.type }));
    res.json({
      ok: ozonTabs.length > 0,
      tabs: ozonTabs,
      allTabs: tabs.length,
      cdpPort: CDP_PORT,
      mode: MODE,
      session: ozonSession.status(),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/session/refresh', async (req, res) => {
  try {
    const snap = await ozonSession.captureFromBrowser();
    res.json({ ok: true, session: { ok: true, capturedAt: snap.capturedAt, tabUrl: snap.tabUrl } });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, code: e.code });
  }
});

app.get('/api/tasks', (req, res) => {
  res.json({
    success: true,
    service: 'ozon-image-search',
    mode: MODE,
    tasks: Array.from(STATE.tasks.values()).map((t) => ({
      taskId: t.taskId, status: t.status, total: t.total, current: t.current,
    })),
  });
});

app.post('/api/upload/:taskId', upload.array('files', 200), (req, res) => {
  const task = getTask(req.params.taskId);
  const uploaded = (req.files || []).map((f) => ({
    name: f.filename,
    originalName: Buffer.from(f.originalname || '', 'latin1').toString('utf8'),
    diskPath: f.path,
    size: f.size,
    status: 'pending',
  }));
  task.images.push(...uploaded);
  task.total = task.images.length;
  task.status = 'queued';
  res.json({ success: true, task_id: task.taskId, uploaded_count: uploaded.length });
});

app.post('/api/upload_b64', async (req, res) => {
  const { fileName, base64, auto_search = true, task_id } = req.body || {};
  if (!fileName || !base64) return res.status(400).json({ success: false, error: 'fileName/base64 required' });
  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch (e) { return res.status(400).json({ success: false, error: 'invalid base64' }); }
  if (!buf.length) return res.status(400).json({ success: false, error: 'empty file' });
  const task = task_id ? getTask(task_id) : getTask(crypto.randomBytes(8).toString('hex'));
  const safeName = String(Date.now()) + '_' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(UPLOAD_DIR, task.taskId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const diskPath = path.join(dir, safeName);
  fs.writeFileSync(diskPath, buf);
  task.images.push({ name: safeName, originalName: fileName, diskPath, status: 'downloaded', size: buf.length });
  task.total = task.images.length;
  task.status = 'queued';
  res.json({ success: true, task_id: task.taskId, total_images: task.images.length });
  if (auto_search) setImmediate(() => startSearch(task.taskId));
});

// 下载 URL 图片到本地，返回 diskPath；失败返回 null
async function downloadUrlToLocal(url, taskId, idx) {
  try {
    const dir = path.join(UPLOAD_DIR, taskId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let ext = '.jpg';
    try {
      const u = new URL(url);
      const p = u.pathname;
      const m = p.match(/\.(jpe?g|png|webp|gif|bmp|tiff?)($|\?)/i);
      if (m) ext = '.' + m[1].toLowerCase();
      else if (p.includes('.')) {
        const last = p.split('.').pop().split(/[\?#]/)[0];
        if (/^[a-z0-9]{2,5}$/i.test(last)) ext = '.' + last.toLowerCase();
      }
    } catch {}
    const safeName = `${Date.now()}_${idx}${ext}`;
    const filePath = path.join(dir, safeName);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('png') && ext === '.jpg') ext = '.png';
    else if (ct.includes('webp') && ext === '.jpg') ext = '.webp';
    else if (ct.includes('gif') && ext === '.jpg') ext = '.gif';
    if (ext !== '.' + safeName.split('.').pop()) {
      const newName = safeName.replace(/\.[^.]+$/, ext);
      const newPath = path.join(dir, newName);
      const ab = await resp.arrayBuffer();
      fs.writeFileSync(newPath, Buffer.from(ab));
      return { ok: true, diskPath: newPath, name: newName };
    }
    const ab = await resp.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(ab));
    return { ok: true, diskPath: filePath, name: safeName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.post('/api/upload_urls', async (req, res) => {
  const {
    urls = [],
    auto_search = true,
    task_id,
    is_last_batch = true,
    expected_total = null,
  } = req.body || {};
  const task = task_id ? getTask(task_id) : getTask(crypto.randomBytes(8).toString('hex'));

  // 先把 items 加入 task
  const items = urls.map((u) => ({ name: u, url: u, status: 'pending' }));
  task.images.push(...items);
  task.total = task.images.length;
  if (typeof expected_total === 'number' && expected_total > 0) {
    task.expected_total = Math.max(task.expected_total || 0, expected_total);
  }
  task.status = 'downloading';

  // 先同步下载所有 URL 图片到本地（用于结果区展示缩略图 + 提供给 runSearch 走本地路径）
  // 限制并发数为 5，避免阻塞
  const CONCURRENCY = 5;
  let cursor = 0;
  const errors = [];
  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      const u = urls[i];
      const img = task.images[i];
      const r = await downloadUrlToLocal(u, task.taskId, i);
      if (r.ok) {
        img.diskPath = r.diskPath;
        img.name = r.name;
        img.originalName = u;
        img.status = 'downloaded';
      } else {
        img.error = r.error;
        img.status = 'failed';
        errors.push({ url: u, error: r.error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));

  // 立即返回 task_id
  res.json({
    success: true,
    task_id: task.taskId,
    total_uploaded: items.length,
    batch_downloaded: urls.length - errors.length,
    batch_failed: errors.length,
  });

  // 仅当本批下载完且（前端告知是最后一批 或 任务累计图片数等于预期总数）时才启动搜索
  if (auto_search) {
    setImmediate(() => {
      const expected = task.expected_total || task.total;
      const ready = task.images.filter((i) => i.diskPath).length;
      if (is_last_batch || ready >= expected) {
        startSearch(task.taskId);
      } else {
        task.status = 'queued';
        task.message = `已下载 ${ready}/${expected} 张图片，等待剩余批次`;
      }
    });
  }
});

app.post('/api/search/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task.images.length) return res.status(400).json({ success: false, error: 'no_images' });
  // 对任何有 diskPath 且尚未成功搜索的图触发 startSearch
  const pending = task.images.filter(
    (i) => i.diskPath && i.status !== 'completed' && i.status !== 'searching'
  );
  if (!pending.length) {
    return res.json({ success: true, message: 'all_ready', ready: task.images.length });
  }
  setImmediate(() => startSearch(task.taskId));
  res.json({ success: true, pending: pending.length });
});

app.get('/api/status/:taskId', (req, res) => {
  const t = getTask(req.params.taskId);
  res.json({
    status: t.status,
    message: t.message,
    current: t.current,
    total: t.total,
    searched_count: t.searched_count,
    downloaded_count: t.downloaded_count,
    results_count: Object.keys(t.results).length,
    search_started_at: t.search_started_at,
    image_statuses: t.images.map((img) => ({
      name: img.name,
      status: img.status,
      result_count: (t.results[img.name] || {}).result_count || 0,
      search_time: (t.results[img.name] || {}).search_time || 0,
      upload_seconds: (t.results[img.name] || {}).upload_seconds || 0,
      search_seconds: (t.results[img.name] || {}).search_seconds || 0,
      total_seconds: (t.results[img.name] || {}).total_seconds || 0,
      search_attempts: (t.results[img.name] || {}).search_attempts || 0,
      error: (t.results[img.name] || {}).error || null,
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

// 清理所有上传文件和内存任务（页面关闭/刷新时调用）
app.post('/api/cleanup', (req, res) => {
  cleanupUploads();
  clearAllTasks();
  res.json({ success: true });
});

app.post('/api/cleanup/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(UPLOAD_DIR, taskId);
  try {
    if (fs.existsSync(taskDir)) {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  } catch (e) { /* ignore */ }
  STATE.tasks.delete(taskId);
  res.json({ success: true });
});

app.post('/api/cleanup_batch', (req, res) => {
  const { taskIds = [] } = req.body || {};
  let removed = 0;
  for (const taskId of taskIds) {
    if (!taskId || typeof taskId !== 'string') continue;
    const taskDir = path.join(UPLOAD_DIR, taskId);
    try {
      if (fs.existsSync(taskDir)) {
        fs.rmSync(taskDir, { recursive: true, force: true });
        removed++;
      }
    } catch (e) { /* ignore */ }
    STATE.tasks.delete(taskId);
  }
  res.json({ success: true, removed });
});

app.use('/uploads', express.static(UPLOAD_DIR));

app.use(express.static(path.join(__dirname)));

app.listen(PORT, HOST, async () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] mode: ${MODE}`);
  console.log(`[SERVER] CDP port: ${CDP_PORT}`);
  console.log(`[SERVER] 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`[SERVER] 会话检查: http://localhost:${PORT}/api/session`);
  if (MODE === 'attach') {
    console.log(`[SERVER] 请保持本机 Chrome 以 --remote-debugging-port=${CDP_PORT} 打开`);
    console.log(`[SERVER] 且至少打开一个 https://www.ozon.ru 页面并完成登录 / captcha`);
  } else {
    console.log(`[SERVER] HTTP 代理模式：浏览器内并发 fetch，会复用已登录 Chrome 会话`);
    try {
      const tab = await ozonSession.findOzonTab();
      if (tab) {
        console.log(`[SERVER] 已接管 OZON 标签页: ${tab.url}`);
      } else {
        console.log(`[SERVER] 未发现 OZON 标签页，请保持 Chrome 已登录 ozon.ru`);
      }
    } catch (e) {
      console.log(`[SERVER] 探测 OZON 标签页失败: ${e.message}`);
    }
  }
});

process.on('SIGINT', () => {
  console.log('\n[SERVER] SIGINT, shutting down');
  process.exit(0);
});