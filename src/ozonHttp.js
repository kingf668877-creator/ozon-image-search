/**
 * OZON 图搜 · 浏览器批量代理客户端
 *
 * 设计目的：
 *   - 不在 Node 服务端直连 OZON 接口（会被 WAF/Cloudflare 标记为非浏览器请求）；
 *   - 通过 CDP 在已登录的 OZON 标签页内并发执行 `fetch`（上传 + 拉商品），由浏览器侧
 *     携带 cookie / sec-ch-* 等指纹头；
 *   - 服务端只做调度、并发限速与结果汇总。
 */

const WebSocket = require('ws');
const http = require('http');
const { findOzonTab } = require('./ozonSession');
const { parseProductsFromTileGrid } = require('./ozonParse');

const BASE_CONCURRENCY = Number(process.env.OZON_HTTP_BASE_CONCURRENCY || process.env.OZON_HTTP_CONCURRENCY || 5);
const MAX_CONCURRENCY = Math.max(BASE_CONCURRENCY, Number(process.env.OZON_HTTP_MAX_CONCURRENCY || 7));
const PROMOTE_AFTER_SUCCESSES = Number(process.env.OZON_HTTP_PROMOTE_SUCCESSES || 100);
const PROMOTE_INTERVAL_MS = Number(process.env.OZON_HTTP_PROMOTE_INTERVAL_MS || 60000);
const BASE_BACKOFF_MS = Number(process.env.OZON_HTTP_BACKOFF_MS || 15000);
const MAX_BACKOFF_MS = Number(process.env.OZON_HTTP_MAX_BACKOFF_MS || 120000);
const MIN_INTERVAL_MS = Number(process.env.OZON_HTTP_MIN_INTERVAL_MS || 0);
const GUARDED_STATUSES = new Set([402, 403, 429]);
const OBSERVED_STATUSES = new Set([402, 403, 409, 429]);
const RESPONSE_BODY_LIMIT = Number(process.env.OZON_HTTP_ERROR_BODY_LIMIT || 2048);
const ERROR_EVENT_LIMIT = Number(process.env.OZON_HTTP_ERROR_EVENT_LIMIT || 50);

const handlePool = [];
let poolInitPromise = null;
let lastRequestAt = 0;
let waitingCount = 0;
let currentConcurrency = BASE_CONCURRENCY;
let cooldownUntil = 0;
let guardErrorCount = 0;
let consecutiveGuardBursts = 0;
let successesSincePromotion = 0;
let lastPromotionAt = Date.now();
let lastGuardError = null;
const errorEvents = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function recordErrorEvent(error) {
  const status = Number(error && error.status);
  if (!OBSERVED_STATUSES.has(status)) return;
  const detail = error && error.detail;
  const body = detail && (detail.raw || detail.body || detail.error);
  errorEvents.push({
    at: Date.now(),
    stage: error.stage || 'unknown',
    status,
    code: error.code || 'request_failed',
    concurrency: currentConcurrency,
    active: handlePool.filter((h) => h.busy).length,
    body: String(body || '').slice(0, RESPONSE_BODY_LIMIT),
  });
  if (errorEvents.length > ERROR_EVENT_LIMIT) errorEvents.splice(0, errorEvents.length - ERROR_EVENT_LIMIT);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function attachOneHandle() {
  const tab = await findOzonTab();
  if (!tab) {
    const err = new Error('no_ozon_tab');
    err.code = 'no_ozon_tab';
    throw err;
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }), (err) => {
        if (err) { pending.delete(id); rej(err); }
      });
    });
  }
  await send('Page.enable');
  await send('Runtime.enable');

  return {
    ws,
    send,
    busy: false,
    lastUsedAt: 0,
    async close() { try { ws.close(); } catch {} },
    tab,
  };
}

async function ensurePool() {
  if (handlePool.length >= currentConcurrency) return;
  if (poolInitPromise) return poolInitPromise;
  poolInitPromise = (async () => {
    while (handlePool.length < currentConcurrency) {
      try {
        const h = await attachOneHandle();
        handlePool.push(h);
      } catch (e) {
        break;
      }
    }
    poolInitPromise = null;
  })();
  await poolInitPromise;
}

async function waitForCooldown() {
  while (cooldownUntil > Date.now()) {
    await sleep(Math.min(1000, cooldownUntil - Date.now()));
  }
}

function markGuardError(error) {
  if (!GUARDED_STATUSES.has(Number(error && error.status))) return false;
  const now = Date.now();
  if (cooldownUntil <= now) consecutiveGuardBursts += 1;
  guardErrorCount += 1;
  successesSincePromotion = 0;
  currentConcurrency = BASE_CONCURRENCY;
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.min(3, consecutiveGuardBursts - 1)));
  cooldownUntil = Math.max(cooldownUntil, now + backoffMs);
  lastGuardError = {
    status: Number(error.status),
    code: error.code || 'rate_limited',
    message: error.message,
    at: Date.now(),
    backoff_ms: backoffMs,
  };
  return true;
}

function markSuccess() {
  if (cooldownUntil <= Date.now()) consecutiveGuardBursts = 0;
  successesSincePromotion += 1;
  if (
    currentConcurrency < MAX_CONCURRENCY &&
    successesSincePromotion >= PROMOTE_AFTER_SUCCESSES &&
    Date.now() - lastPromotionAt >= PROMOTE_INTERVAL_MS
  ) {
    currentConcurrency += 1;
    successesSincePromotion = 0;
    lastPromotionAt = Date.now();
  }
}

async function acquireHandle() {
  waitingCount += 1;
  try {
    while (true) {
      await waitForCooldown();
      await ensurePool();
      if (!handlePool.length) {
        const err = new Error('no_handle');
        err.code = 'no_handle';
        throw err;
      }
      const active = handlePool.filter((h) => h.busy).length;
      const idle = active < currentConcurrency ? handlePool.find((h) => !h.busy) : null;
      if (idle) {
        idle.busy = true;
        idle.lastUsedAt = Date.now();
        return idle;
      }
      await sleep(50);
    }
  } finally {
    waitingCount = Math.max(0, waitingCount - 1);
  }
}

function releaseHandle(handle) {
  handle.busy = false;
  handle.lastUsedAt = Date.now();
}

async function throttle() {
  if (MIN_INTERVAL_MS <= 0) return;
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function uploadViaBrowser(handle, fileBuffer, fileName) {
  const b64 = Buffer.from(fileBuffer).toString('base64');
  const expr = `
    (async () => {
      try {
        const bin = atob(${JSON.stringify(b64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const fd = new FormData();
        fd.append('file', blob, ${JSON.stringify(fileName || 'upload.jpg')});
        fd.append('sourceMetadata', JSON.stringify({
          width: 1024,
          height: 1024,
          type: 'image/jpeg'
        }));
        const upRes = await fetch('/api/composer-api.bx/_action/searchByImageUpload', {
          method: 'POST',
          body: fd,
          credentials: 'include'
        });
        const text = await upRes.text().catch(() => '');
        let json = {};
        try { json = JSON.parse(text); } catch {}
        return { ok: upRes.ok, status: upRes.status, raw: text.slice(0, ${RESPONSE_BODY_LIMIT}), json };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()
  `;
  const r = await handle.send('Runtime.evaluate', {
    expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ ok: false, error: 'top:' + String(e && e.message || e) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r && r.exceptionDetails) {
    throw new Error('upload eval error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'unknown'));
  }
  let out;
  try { out = JSON.parse(r.result.value || 'null'); } catch { out = null; }
  if (!out || !out.ok || !out.json || !out.json.imageId) {
    const err = new Error('upload_failed: status=' + (out && out.status) + ' raw=' + (out && out.raw) + ' err=' + (out && out.error));
    const status = Number(out && out.status);
    err.code = status === 401 ? 'auth_invalid' : (GUARDED_STATUSES.has(status) ? 'rate_limited' : (status === 409 ? 'conflict' : 'upload_failed'));
    err.status = status || null;
    err.stage = 'upload';
    err.detail = out;
    recordErrorEvent(err);
    throw err;
  }
  return out.json;
}

async function searchByImageIdViaBrowser(handle, imageId) {
  const expr = `
    (async () => {
      try {
        const searchPath = '/search-by-image?image_id=' + ${JSON.stringify(imageId)};
        const apiUrl = '/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(searchPath);
        const res = await fetch(apiUrl, { credentials: 'include' });
        const text = await res.text().catch(() => '');
        if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status, raw: text.slice(0, ${RESPONSE_BODY_LIMIT}) };
        let json = {};
        try { json = JSON.parse(text); } catch {}
        return { ok: true, status: res.status, json };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()
  `;
  const r = await handle.send('Runtime.evaluate', {
    expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ ok: false, error: 'top:' + String(e && e.message || e) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r && r.exceptionDetails) {
    throw new Error('search eval error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'unknown'));
  }
  let out;
  try { out = JSON.parse(r.result.value || 'null'); } catch { out = null; }
  if (!out || !out.ok) {
    const err = new Error('search_failed: ' + (out && (out.error || ('status=' + out.status))));
    const status = Number(out && out.status);
    err.code = status === 401 ? 'auth_invalid' : (GUARDED_STATUSES.has(status) ? 'rate_limited' : (status === 409 ? 'conflict' : 'search_failed'));
    err.status = status || null;
    err.stage = 'search';
    err.detail = out;
    recordErrorEvent(err);
    throw err;
  }
  return parseProductsFromTileGrid(out.json);
}

async function searchByFileOnce(fileBuffer, fileName) {
  let handle = null;
  const tTotal = Date.now();
  try {
    await throttle();
    handle = await acquireHandle();
    let up;
    const tUpload = Date.now();
    try {
      up = await uploadViaBrowser(handle, fileBuffer, fileName);
    } catch (e) {
      if (e.code === 'auth_invalid' || e.code === 'rate_limited') throw e;
      if (e.code === 'conflict') {
        await sleep(1000);
        up = await uploadViaBrowser(handle, fileBuffer, fileName);
      } else {
        handle = await resetHandle(handle);
        up = await uploadViaBrowser(handle, fileBuffer, fileName);
      }
    }
    const uploadSeconds = (Date.now() - tUpload) / 1000;
    const tSearch = Date.now();
    let products;
    let searchAttempts = 0;
    while (searchAttempts < 2) {
      searchAttempts += 1;
      try {
        products = await searchByImageIdViaBrowser(handle, up.imageId);
        break;
      } catch (e) {
        if (e.code === 'auth_invalid' || e.code === 'rate_limited' || searchAttempts >= 2) throw e;
        await sleep(1000);
      }
    }
    const searchSeconds = (Date.now() - tSearch) / 1000;
    return {
      ok: true,
      imageId: up.imageId,
      redirectUri: '/search-by-image?image_id=' + up.imageId,
      products,
      upload_seconds: uploadSeconds,
      search_seconds: searchSeconds,
      total_seconds: (Date.now() - tTotal) / 1000,
      search_attempts: searchAttempts,
    };
  } finally {
    if (handle) releaseHandle(handle);
  }
}

async function searchByFile(fileBuffer, fileName) {
  let guardAttempt = 0;
  while (guardAttempt < 2) {
    try {
      const result = await searchByFileOnce(fileBuffer, fileName);
      markSuccess();
      return result;
    } catch (error) {
      if (!markGuardError(error) || guardAttempt >= 1) throw error;
      guardAttempt += 1;
      await waitForCooldown();
    }
  }
  throw new Error('search_failed_after_guard_retry');
}

async function resetHandle(handle) {
  try { await handle.close(); } catch {}
  const idx = handlePool.indexOf(handle);
  if (idx >= 0) handlePool.splice(idx, 1);
  const fresh = await attachOneHandle();
  handlePool.push(fresh);
  fresh.busy = true;
  fresh.lastUsedAt = Date.now();
  return fresh;
}

async function searchByImageId(imageId) {
  const handle = await acquireHandle();
  try { return await searchByImageIdViaBrowser(handle, imageId); }
  finally { releaseHandle(handle); }
}

async function uploadImage(fileBuffer, fileName) {
  const handle = await acquireHandle();
  try { return await uploadViaBrowser(handle, fileBuffer, fileName); }
  finally { releaseHandle(handle); }
}

function getPoolStats() {
  const now = Date.now();
  return {
    configured: currentConcurrency,
    base_concurrency: BASE_CONCURRENCY,
    max_concurrency: MAX_CONCURRENCY,
    pool_size: handlePool.length,
    active: handlePool.filter((h) => h.busy).length,
    idle: handlePool.filter((h) => !h.busy).length,
    waiting: waitingCount,
    cooling_down: cooldownUntil > now,
    cooldown_remaining_ms: Math.max(0, cooldownUntil - now),
    guard_error_count: guardErrorCount,
    successes_until_promotion: Math.max(0, PROMOTE_AFTER_SUCCESSES - successesSincePromotion),
    last_guard_error: lastGuardError,
    observed_error_count: errorEvents.length,
    error_events: errorEvents.slice(),
  };
}

module.exports = {
  searchByFile,
  searchByImageId,
  uploadImage,
  DEFAULT_CONCURRENCY: BASE_CONCURRENCY,
  MAX_CONCURRENCY,
  ensurePool,
  getPoolStats,
};