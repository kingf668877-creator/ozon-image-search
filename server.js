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
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const { EventEmitter } = require('events');

const MODE = (process.env.OZON_MODE || 'http').toLowerCase();

const PORT = Number(process.env.PORT || 5443);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_PORT = Number(process.env.OZON_CDP_PORT || 9225);

const ozonSearch = require('./src/ozonSearch');
const ozonHttp = require('./src/ozonHttp');
const ozonSession = require('./src/ozonSession');
const taskStore = require('./src/taskStore');

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
    // 流水线状态：submitDone=URL 批次已全部提交；dlQueued=后台待下载数；pipelineActive=搜索管线运行中
    submitDone: true,
    dlQueued: 0,
    pipelineActive: false,
    emitter: new EventEmitter(),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只落盘任务元数据（不重写全部图片行），供高频更新点使用。
function persistTaskMeta(task) {
  if (task.deleted) return;
  try { taskStore.saveTask(task); } catch (e) { console.error('[STORE] save task meta failed:', e.message); }
}
function saveImagesRange(task, from, to) {
  for (let i = from; i < to && i < task.images.length; i++) {
    try { taskStore.saveImage(task.taskId, task.images[i], i); } catch (e) { console.error('[STORE] save image failed:', e.message); }
  }
}
// 下载量达到阈值即提前启动搜索（边下边搜），默认 20 张。
const EARLY_SEARCH_THRESHOLD = Number(process.env.OZON_EARLY_SEARCH_THRESHOLD || 20);
function maybeStartEarly(task) {
  if (task.canceled || task.deleted || task.pipelineActive) return;
  if (task.downloaded_count >= EARLY_SEARCH_THRESHOLD) startSearch(task.taskId);
}
function persistTask(task) {
  if (task.deleted) return;
  try { taskStore.persistTask(task); } catch (e) { console.error('[STORE] save task failed:', e.message); }
}
function persistResult(task, imageIndex, image) {
  if (task.deleted) return;
  try { taskStore.saveResult(task.taskId, imageIndex, image.name, task.results[image.name]); } catch (e) { console.error('[STORE] save result failed:', e.message); }
}
// 页面离开时销毁任务：停止后台协程、删除磁盘文件和 SQLite 记录，不占用存储。
function destroyTask(taskId) {
  const t = STATE.tasks.get(taskId);
  if (t) { t.canceled = true; t.deleted = true; }
  const taskDir = path.join(UPLOAD_DIR, taskId);
  try { if (fs.existsSync(taskDir)) fs.rmSync(taskDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  STATE.tasks.delete(taskId);
  try { taskStore.deleteTask(taskId); } catch (e) { console.error('[STORE] delete task failed:', e.message); }
}
function getTask(taskId) {
  let t = STATE.tasks.get(taskId);
  if (!t) {
    t = taskStore.loadTask(taskId) || createTask(taskId);
    STATE.tasks.set(taskId, t);
  }
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
  // Fail fast if CDP is down and persist the failure so it remains queryable.
  if (MODE === 'http') {
    try {
      const tabs = await ozonSearch.listTabs(CDP_PORT);
      const ozonTabs = tabs.filter((t) => (t.url || '').includes('ozon.ru'));
      if (!ozonTabs.length) {
        task.status = 'failed';
        task.message = 'Chrome 已就绪但缺少 OZON 标签页，请检查浏览器窗口';
        persistTask(task);
        return;
      }
    } catch (e) {
      task.status = 'failed';
      task.message = `Chrome 未运行或 CDP 不可达 (port ${CDP_PORT})，请启动 start-ozon-headless.ps1`;
      persistTask(task);
      return;
    }
  }
  if (task.pipelineActive) return; // 管线已在运行（边下边搜模式），无需重复启动
  task.pipelineActive = true;
  task.search_started_at = task.search_started_at || Date.now();
  task.status = 'searching';
  task.message = `正在搜索 ${task.total} 张图片...`;
  persistTaskMeta(task);

  // 启动到探测上限的 worker；底层连接池从 5 路开始并负责动态放行与退避。
  const concurrency = MODE === 'attach'
    ? 1
    : ozonHttp.MAX_CONCURRENCY;

  // 拉取式认领：扫描已下载且未搜索的图片并原子标记 searching，下载与搜索即可并行。
  function claimNext() {
    for (let i = 0; i < task.images.length; i++) {
      const im = task.images[i];
      if (im.diskPath && (im.status === 'pending' || im.status === 'downloaded')) {
        im.status = 'searching';
        return { img: im, i };
      }
    }
    return null;
  }
  // 输入是否结束：URL 批次全部提交完成且后台下载队列已清空。
  function inputDone() {
    return task.submitDone && task.dlQueued === 0;
  }
  async function worker() {
    let idleMs = 0;
    while (true) {
      if (task.canceled || task.deleted) return;
      const claimed = claimNext();
      if (!claimed) {
        if (inputDone()) return;
        // 提交中断且长时间无新图片时退出，避免任务永久停留在 searching。
        idleMs += 500;
        if (idleMs >= 10 * 60 * 1000) return;
        await sleep(500);
        continue;
      }
      idleMs = 0;
      const { img, i } = claimed;
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
          persistResult(task, i, img);
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
          persistResult(task, i, img);
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
        persistResult(task, i, img);
      }
      task.searched_count += 1;
      task.current = Math.min(task.searched_count, task.total);
      persistTaskMeta(task);
      try { taskStore.saveImage(task.taskId, img, i); } catch (e) { /* 状态行写入失败不影响结果 */ }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  task.pipelineActive = false;
  if (task.deleted) return;

  if (MODE === 'http' && Object.values(task.results).every((r) => r && r.errorCode === 'auth_invalid')) {
    task.message = '浏览器会话已过期，请在 Chrome 中重新登录 OZON 并重试';
  }
  const failedCount = task.images.filter((image) => image.status === 'failed').length;
  task.status = task.canceled ? 'failed' : (failedCount ? 'partial' : 'completed');
  task.message = task.canceled ? '已取消，已保留已完成结果' : (failedCount ? `部分完成，${failedCount} 张失败，已保留成功结果` : '完成');
  persistTask(task);
}

// ============== Express ==============
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use('/api/cleanup_batch', express.text({ type: 'text/plain', limit: '1mb' }));
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

// 保留 uploads 中的历史任务文件，任务数据由 SQLite 管理。
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
    concurrency: MODE === 'attach' ? 1 : ozonHttp.getPoolStats().configured,
    search_pool: MODE === 'http' ? ozonHttp.getPoolStats() : null,
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
  res.json({ success: true, service: 'ozon-image-search', mode: MODE, tasks: taskStore.listTasks() });
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
  task.downloaded_count = task.images.filter((image) => Boolean(image.diskPath)).length;
  task.status = 'queued';
  persistTask(task);
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
  task.downloaded_count = task.images.filter((image) => Boolean(image.diskPath)).length;
  task.status = 'queued';
  persistTask(task);
  res.json({ success: true, task_id: task.taskId, total_images: task.images.length });
  if (auto_search) setImmediate(() => startSearch(task.taskId));
});

// 下载 URL 图片到本地；超时覆盖响应头和正文读取，避免慢链接永久占住全部下载槽位。
async function downloadUrlToLocal(url, taskId, idx, timeoutMs = null) {
  const ctrl = new AbortController();
  const effectiveTimeout = Number(timeoutMs || process.env.OZON_DL_TIMEOUT_MS || 12000);
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
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
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
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
    return { ok: false, error: e.name === 'AbortError' ? `下载超时 ${effectiveTimeout}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 后台下载：任务内批次串行、批内并发，避免请求长时间挂起触发网关超时。
async function runDownloadEntries(task, entries) {
  const CONCURRENCY = Number(process.env.OZON_DL_CONCURRENCY || 10);
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      // 任务被取消或销毁（页面关闭）时立即停止，不再下载、不写库。
      if (task.canceled || task.deleted) return;
      const { img, idx, countDownload = true } = entries[cursor++];
      if (img.diskPath) continue;
      img.status = 'downloading';
      let r = null;
      let lastError = '';
      const retryTimeouts = [12000, 12000, 25000];
      const retryDelays = [0, 2000, 5000];
      for (let attempt = 0; attempt < retryTimeouts.length; attempt++) {
        if (task.canceled || task.deleted) return;
        if (retryDelays[attempt]) await sleep(retryDelays[attempt]);
        r = await downloadUrlToLocal(img.url, task.taskId, idx, retryTimeouts[attempt]);
        if (r.ok) break;
        lastError = r.error || '下载失败';
      }
      if (!r || !r.ok) r = { ok: false, error: lastError };
      if (task.deleted) return;
      if (r.ok) {
        img.diskPath = r.diskPath;
        img.name = r.name;
        img.originalName = img.url;
        img.status = 'downloaded';
      } else {
        img.error = r.error;
        img.status = 'failed';
      }
      // 首次处理才累加；失败图片重试不重复计数。
      if (countDownload) task.downloaded_count = Math.min(task.total, task.downloaded_count + 1);
      task.current = task.downloaded_count;
      task.message = `正在下载图片 ${task.downloaded_count}/${task.total}`;
      try { taskStore.saveTask(task); taskStore.saveImage(task.taskId, img, idx); } catch (e) { console.error('[STORE] save download failed:', e.message); }
      // 边下边搜：下载量达到阈值即触发搜索管线（若尚未启动）。
      maybeStartEarly(task);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, entries.length)) }, worker));
}

function queueDownload(task, entries, done) {
  if (!entries.length) { if (done) done(); return; }
  task.dlQueued += entries.length;
  task.downloadChain = (task.downloadChain || Promise.resolve())
    .then(() => runDownloadEntries(task, entries))
    .then(() => { task.dlQueued -= entries.length; if (done) done(); })
    .catch((e) => { task.dlQueued -= entries.length; console.error('[DL] background download failed:', e.message); if (done) done(); });
}

app.post('/api/upload_urls', (req, res) => {
  const {
    urls = [],
    auto_search = true,
    task_id,
    is_last_batch = true,
    expected_total = null,
  } = req.body || {};
  const task = task_id ? getTask(task_id) : getTask(crypto.randomBytes(8).toString('hex'));

  // 去重：前端重试或重复提交时，跳过任务中已有的 URL，避免重复下载。
  const existing = new Set(task.images.map((im) => im.originalName || im.url).filter(Boolean));
  const freshUrls = (Array.isArray(urls) ? urls : []).filter((u) => u && !existing.has(u));
  const batchStart = task.images.length;
  task.images.push(...freshUrls.map((u) => ({ name: u, url: u, status: 'pending' })));
  if (typeof expected_total === 'number' && expected_total > 0) {
    task.expected_total = Math.max(task.expected_total || 0, expected_total);
  }
  const received = task.images.length;
  task.total = task.expected_total || task.images.length;
  task.status = 'downloading';
  task.message = `正在下载图片 ${task.downloaded_count}/${task.total}`;
  // 是否还有后续批次：搜索管线据此判断何时可以收尾。
  task.submitDone = Boolean(is_last_batch) || (typeof expected_total === 'number' && received >= expected_total);
  persistTaskMeta(task);
  saveImagesRange(task, batchStart, task.images.length);

  // 立即返回，下载进入后台队列；下载达到阈值即边下边搜，全部批次结束后自动收尾。
  res.json({
    success: true,
    task_id: task.taskId,
    total_uploaded: freshUrls.length,
    skipped_duplicates: urls.length - freshUrls.length,
  });

  const entries = freshUrls.map((u, k) => ({ img: task.images[batchStart + k], idx: batchStart + k }));
  queueDownload(task, entries, () => {
    if (task.canceled || task.deleted) return;
    const expected = task.expected_total || task.total;
    // 所有批次已提交且后台下载队列已清空：确保搜索管线启动（小任务未达阈值也能触发）。
    if (auto_search && task.submitDone && task.dlQueued === 0) {
      startSearch(task.taskId); // 管线已在运行时此调用为空操作
    } else if (!['searching', 'partial', 'completed'].includes(task.status)) {
      task.status = 'queued';
      task.message = `已下载 ${task.downloaded_count}/${expected} 张图片，等待剩余批次`;
      persistTaskMeta(task);
    }
  });
  // 本批提交后立即检查一次阈值，覆盖下载回调之外的触发时序。
  maybeStartEarly(task);
});

app.post('/api/search/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task.images.length) return res.status(400).json({ success: false, error: 'no_images' });
  // 需要补下载的图（有 URL 但还没有本地文件）+ 需要搜索的图（已有文件但未完成）
  const needDownload = task.images
    .map((img, idx) => ({ img, idx }))
    .filter((e) => e.img.url && !e.img.diskPath && !['completed', 'no_results', 'searching'].includes(e.img.status));
  const pendingSearch = task.images.filter((i) => i.diskPath && !['completed', 'no_results', 'searching'].includes(i.status));
  if (!needDownload.length && !pendingSearch.length) return res.json({ success: true, message: 'all_ready', ready: task.images.length });
  task.canceled = false;
  task.status = needDownload.length ? 'downloading' : 'queued';
  task.message = needDownload.length ? `准备补下载 ${needDownload.length} 张图片` : `准备继续 ${pendingSearch.length} 张图片`;
  persistTask(task);
  needDownload.forEach((e) => { e.img.status = 'pending'; e.img.error = null; });
  if (needDownload.length) {
    queueDownload(task, needDownload, () => {
      task.current = 0;
      startSearch(task.taskId);
    });
  } else {
    setImmediate(() => startSearch(task.taskId));
  }
  res.json({ success: true, to_download: needDownload.length, pending: pendingSearch.length, preserved_results: Object.keys(task.results).length });
});

app.post('/api/tasks/:taskId/retry-failed', (req, res) => {
  const task = getTask(req.params.taskId);
  const failedEntries = task.images.map((img, idx) => ({ img, idx })).filter((e) => e.img.status === 'failed');
  const needDownload = failedEntries.filter((e) => e.img.url && !e.img.diskPath).map((e) => ({ ...e, countDownload: false }));
  failedEntries.forEach((e) => { e.img.status = 'pending'; e.img.error = null; });
  task.canceled = false;
  task.status = failedEntries.length ? 'queued' : task.status;
  task.message = failedEntries.length ? `准备重试 ${failedEntries.length} 张图片` : '没有可重试的失败图片';
  persistTask(task);
  if (needDownload.length) {
    queueDownload(task, needDownload, () => {
      task.current = 0;
      startSearch(task.taskId);
    });
  } else if (failedEntries.length) {
    setImmediate(() => startSearch(task.taskId));
  }
  res.json({ success: true, retried: failedEntries.length, preserved_results: Object.keys(task.results).length });
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
    results_count: taskStore.getResultSummary(t.taskId).image_count,
    total_products: taskStore.getResultSummary(t.taskId).product_count,
    search_started_at: t.search_started_at,
    search_pool: MODE === 'http' ? ozonHttp.getPoolStats() : null,
    image_statuses_total: t.images.length,
    // 大任务只返回最新 200 条明细，让状态列表始终反映当前正在处理的图片。
    image_statuses: t.images.slice(-200).map((img) => ({
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

function getBestProduct(resultPayload) {
  if (!resultPayload) return null;
  let entry;
  try { entry = JSON.parse(resultPayload); } catch { return null; }
  const products = Array.isArray(entry.results) ? entry.results.slice() : [];
  products.sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
  return products[0] || null;
}

function firstString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function productLink(product) {
  return firstString(product && (product.url || product.product_url || product.link || product.productLink || product.href));
}

function productImageLink(product) {
  const value = product && (product.image || product.image_url || product.imageUrl || product.main_image || product.mainImage || product.photo);
  if (Array.isArray(value)) return firstString(value[0]);
  return firstString(value);
}

app.get('/api/export/:taskId.xlsx', async (req, res) => {
  try {
    const task = getTask(req.params.taskId);
    const rows = taskStore.getExportRows(task.taskId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OZON 图搜';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('图搜结果');
    sheet.columns = [
      { header: '上传图片', key: 'image', width: 24 },
      { header: '商品链接', key: 'productLink', width: 58 },
      { header: '商品主图链接', key: 'imageLink', width: 58 },
    ];
    sheet.freezePanes = { xSplit: 0, ySplit: 1 };
    sheet.getRow(1).height = 24;
    sheet.getRow(1).font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1769E0' } };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    for (const [index, row] of rows.entries()) {
      const excelRow = sheet.addRow({ productLink: '', imageLink: '' });
      excelRow.height = 92;
      excelRow.font = { name: 'Arial', size: 10, color: { argb: '243047' } };
      excelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'F7F9FC' : 'FFFFFFFF' } };
      excelRow.alignment = { vertical: 'middle', wrapText: true };
      excelRow.eachCell((cell) => { cell.border = { bottom: { style: 'thin', color: { argb: 'D9DEE7' } } }; });
      const product = getBestProduct(row.resultPayload);
      excelRow.getCell(2).value = productLink(product);
      excelRow.getCell(3).value = productImageLink(product);
      const imagePath = row.diskPath && path.resolve(row.diskPath);
      if (imagePath && fs.existsSync(imagePath)) {
        try {
          const thumbnail = await sharp(imagePath)
            .rotate()
            .resize(112, 84, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          const imageId = workbook.addImage({ buffer: thumbnail, extension: 'png' });
          sheet.addImage(imageId, { tl: { col: 0.15, row: index + 1.15 }, ext: { width: 112, height: 84 } });
        } catch (e) {
          excelRow.getCell(1).value = row.originalName || row.imageName || row.imageUrl || '图片读取失败';
        }
      } else {
        excelRow.getCell(1).value = row.originalName || row.imageName || row.imageUrl || row.imageError || '图片不可用';
      }
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const exportFileName = `OZON-search-${task.taskId}.xlsx`;
    const encodedFileName = encodeURIComponent(`OZON图搜结果_${task.taskId}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename="${exportFileName}"; filename*=UTF-8''${encodedFileName}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[EXPORT] Excel export failed:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Excel 导出失败', detail: e.message });
  }
});

app.get('/api/results/:taskId', (req, res) => {
  const t = getTask(req.params.taskId);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = taskStore.getResultRows(t.taskId, limit, offset);
  const results = {};
  for (const row of rows) { try { results[row.imageName] = JSON.parse(row.payload); } catch {} }
  res.json({
    status: t.status,
    message: t.message,
    total_images: t.total,
    total_results: taskStore.getResultSummary(t.taskId).image_count,
    total_products: taskStore.getResultSummary(t.taskId).product_count,
    search_duration: (Date.now() - (t.search_started_at || t.createdAt)) / 1000,
    results,
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
  for (const t of STATE.tasks.values()) { t.canceled = true; t.deleted = true; }
  cleanupUploads();
  clearAllTasks();
  taskStore.clearTasks();
  res.json({ success: true });
});

app.post('/api/cleanup/:taskId', (req, res) => {
  destroyTask(req.params.taskId);
  res.json({ success: true });
});

app.post('/api/cleanup_batch', (req, res) => {
  let payload = req.body || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  const { taskIds = [] } = payload;
  let removed = 0;
  for (const taskId of taskIds) {
    if (!taskId || typeof taskId !== 'string') continue;
    destroyTask(taskId);
    removed++;
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