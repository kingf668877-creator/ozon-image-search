/**
 * OZON 图搜 · 本地 Web 服务（Express + 接管已验证 Chrome CDP）
 *
 * 启动方式：
 *   node server.js              # 接管本机 Chrome 9225 调试端口上已打开的 OZON 页面
 *
 * 健康检查：
 *   GET /api/health   -> { mode, sessionOk }
 *   GET /api/session  -> { ok, tabs:[{url,title}] }
 *
 * 重要：必须保持本机 Chrome 以 `--remote-debugging-port=9225` 启动，并至少打开一个 ozon.ru 页面
 * 并完成登录 / captcha，服务端才会找到可接管的目标。
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MODE = 'attach';

const PORT = Number(process.env.PORT || 5443);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_PORT = Number(process.env.OZON_CDP_PORT || 9225);

const ozonSearch = require('./src/ozonSearch');

// ============== 任务状态 ==============
const STATE = {
  tasks: new Map(),
};

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
async function runSearch(img) {
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

async function startSearch(taskId) {
  const task = getTask(taskId);
  task.search_started_at = Date.now();
  task.status = 'searching';
  task.message = `正在搜索 ${task.total} 张图片...`;

  for (let i = 0; i < task.images.length; i++) {
    if (task.canceled) break;
    const img = task.images[i];
    img.status = 'searching';
    task.current = i + 1;
    task.message = `(${i + 1}/${task.total}) ${img.name}`;
    const t0 = Date.now();
    try {
      const r = await runSearch(img);
      if (r.ok) {
        task.results[img.name] = {
          image_name: img.name,
          results: r.products,
          result_count: r.products.length,
          search_time: (Date.now() - t0) / 1000,
          imageId: r.imageId,
          redirectUri: r.redirectUri,
          meta: r.meta,
        };
        img.status = r.products.length ? 'completed' : 'no_results';
      } else {
        task.results[img.name] = {
          image_name: img.name,
          results: [],
          result_count: 0,
          search_time: (Date.now() - t0) / 1000,
          error: r.error || r.body || `HTTP ${r.status || 'unknown'}`,
        };
        img.status = 'failed';
      }
      task.searched_count = i + 1;
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

// 清理 uploads 目录（删除所有子目录和文件）
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

// 清空内存中的所有任务
function clearAllTasks() {
  STATE.tasks.clear();
}

// 启动时自动清理上次残留的 uploads
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
    // multer 默认把 originalname 当 latin1，要还原 UTF-8（中文/特殊字符文件名）
    const original = Buffer.from(file.originalname || 'upload', 'latin1').toString('utf8');
    const ts = Date.now();
    // 给文件名加时间戳前缀防冲突，但保留原文件名作为后缀，这样后端 img.name 与实际文件名一致
    // express.static 自动 URL-encode 文件名（包括 ! 等特殊字符），所以 ! 没问题
    cb(null, `${ts}_${original}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'ozon-image-search',
    mode: MODE,
    port: PORT,
    cdpPort: CDP_PORT,
    startedAt: new Date().toISOString(),
  });
});

// CDP 会话状态
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
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
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
    // 用实际文件名（f.filename = 时间戳_原名）作为 key，确保前端能正确访问 /uploads/{taskId}/{name}
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

// 下载 URL 图片到本地，返回 diskPath；失败返回 null
async function downloadUrlToLocal(url, taskId, idx) {
  try {
    const dir = path.join(UPLOAD_DIR, taskId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 优先从 URL 后缀推导
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
    // 如果响应头有正确的 content-type，用它纠正后缀
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
  const { urls = [], auto_search = true, task_id } = req.body || {};
  const task = task_id ? getTask(task_id) : getTask(crypto.randomBytes(8).toString('hex'));

  // 先把 items 加入 task
  const items = urls.map((u) => ({ name: u, url: u, status: 'pending' }));
  task.images.push(...items);
  task.total = task.images.length;
  task.status = 'queued';

  // 先同步下载所有 URL 图片到本地（用于结果区展示缩略图 + 提供给 runSearch 走本地路径）
  // 限制并发数为 5，避免阻塞
  const CONCURRENCY = 5;
  let cursor = 0;
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
      } else {
        img.error = r.error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));

  // 立即返回 task_id
  res.json({ success: true, task_id: task.taskId, total_uploaded: items.length });

  if (auto_search) setImmediate(() => startSearch(task.taskId));
});

app.post('/api/search/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task.images.length) return res.status(400).json({ success: false, error: 'no_images' });
  setImmediate(() => startSearch(task.taskId));
  res.json({ success: true });
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

// 按任务ID清理（删除该任务的上传文件和内存数据）
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

// 批量按 taskId 清理（前端 pagehide 时调用，清掉本 tab 访问过的所有 task）
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

// 前端静态资源
app.use(express.static(path.join(__dirname)));

// ============== 启动 ==============
app.listen(PORT, HOST, () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] mode: ${MODE}`);
  console.log(`[SERVER] CDP port: ${CDP_PORT}`);
  console.log(`[SERVER] 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`[SERVER] 会话检查: http://localhost:${PORT}/api/session`);
  if (MODE === 'attach') {
    console.log(`[SERVER] 请保持本机 Chrome 以 --remote-debugging-port=${CDP_PORT} 打开`);
    console.log(`[SERVER] 且至少打开一个 https://www.ozon.ru 页面并完成登录 / captcha`);
  }
});

process.on('SIGINT', () => {
  console.log('\n[SERVER] SIGINT, shutting down');
  process.exit(0);
});