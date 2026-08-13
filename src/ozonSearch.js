/**
 * OZON 图搜 · 接管已验证 Chrome（CDP）+ .tile-root 提取
 *
 * 工作流程：
 *   1. 用户在本机 Chrome --remote-debugging-port=9225 打开 OZON，并完成登录/captcha；
 *   2. attachChrome() 通过 9225/json 找到 OZON 标签页，用 webSocketDebuggerUrl 建立 CDP；
 *   3. searchByImage() 在该浏览器上下文里跑 searchByImageUpload 拿到 imageId，
 *      再 navigate 到 /search-by-image?image_id=...；
 *   4. extractFromTiles() 抓 .tile-root（不进入详情页），返回结构化商品列表。
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const OZON_HOST = 'https://www.ozon.ru';
const UPLOAD_PATH = '/api/composer-api.bx/_action/searchByImageUpload';
const SEARCH_PATH_PREFIX = '/search-by-image?image_id=';
const CDP_PORT = Number(process.env.OZON_CDP_PORT || 9225);
const NAV_TIMEOUT_MS = 30000;
const NAV_POLL_MS = 1500;

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('invalid json: ' + body.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

async function listTabs(port = CDP_PORT) {
  const tabs = await httpJson(`http://127.0.0.1:${port}/json`);
  return tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function findOzonTab(port = CDP_PORT) {
  const tabs = await listTabs(port);
  const ozon = tabs.find((t) => (t.url || '').includes('ozon.ru'));
  return ozon || null;
}

/**
 * 接管本机 Chrome 中已打开的 OZON 标签页，返回 CDP 会话句柄。
 * handle: { ws, send, close, tab }
 */
async function attachChrome({ port = CDP_PORT, requireOzon = true } = {}) {
  let tab;
  if (requireOzon) {
    tab = await findOzonTab(port);
    if (!tab) {
      const err = new Error('no_ozon_tab');
      err.code = 'no_ozon_tab';
      err.message = '未找到打开 ozon.ru 的标签页，请保持 Chrome 打开且至少有一个 OZON 页面';
      throw err;
    }
  } else {
    const tabs = await listTabs(port);
    tab = tabs[0];
    if (!tab) {
      const err = new Error('no_browser_tab');
      err.code = 'no_browser_tab';
      throw err;
    }
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message || JSON.stringify(m.error)));
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
    async close() {
      try { ws.close(); } catch {}
    },
    tab,
  };
}

const EXTRACT_TILES_JS = `
(() => {
  const out = [];
  const tiles = document.querySelectorAll('.tile-root');

  function num(text) {
    if (!text) return '';
    const digits = String(text).replace(/[^\\d]/g, '');
    return digits ? (digits + ' ₽') : '';
  }

  for (const tile of tiles) {
    const linkEl = tile.querySelector('a[href*="/product/"]');
    if (!linkEl) continue;
    const href = linkEl.href.split('?')[0];

    const img = tile.querySelector('img');
    const image = img ? (img.src || (img.srcset || '').split(' ')[0] || '') : '';

    let title = '';
    const titleSpans = tile.querySelectorAll('.tsBody500Medium');
    for (const sp of titleSpans) {
      const t = sp.textContent.trim();
      if (t.length > 5) { title = t; break; }
    }

    let price = '';
    const priceSpans = tile.querySelectorAll('.c35_5_1-b2, [class*="tsHeadline500Medium"]');
    for (const sp of priceSpans) {
      const v = num(sp.textContent);
      if (v) { price = v; break; }
    }

    let oldPrice = '';
    const oldPriceSpans = tile.querySelectorAll('.c35_5_1-b');
    const curDigits = price.replace(/[^\\d]/g, '');
    for (const sp of oldPriceSpans) {
      const v = num(sp.textContent);
      if (v && v.replace(/[^\\d]/g, '') !== curDigits) { oldPrice = v; break; }
    }

    let discount = '';
    const discountSpans = tile.querySelectorAll('[class*="c35_5_1-b5"]');
    for (const sp of discountSpans) {
      const t = sp.textContent.trim();
      if (/[-\u2212]\\s?\\d+\\s?%/.test(t)) { discount = t; break; }
    }

    let rating = '';
    const ratingSpans = tile.querySelectorAll('.qg1_21, .c7w1_7_7-a0, [class*="ui-b3_4_1"], [class*="rating"], [class*="a7a_3_2"]');
    for (const sp of ratingSpans) {
      const match = sp.textContent.trim().match(/\d[.,]\d/);
      if (match) { rating = match[0]; break; }
    }
    let reviews = '';
    const tileText = (tile.innerText || '').replace(/\s+/g, ' ');
    const reviewMatch = tileText.match(/([\d\s\u00a0]+)\s*(?:отзыв(?:а|ов)?|оцен(?:ка|ок)?)/i);
    if (reviewMatch) reviews = reviewMatch[1].replace(/[^\d]/g, '');

    out.push({
      url: href,
      title,
      price,
      oldPrice,
      discount,
      rating,
      reviews,
      image,
    });
  }
  const seen = new Set();
  const unique = out.filter((p) => seen.has(p.url) ? false : (seen.add(p.url), true));
  return {
    tilesFound: tiles.length,
    uniqueProducts: unique.length,
    products: unique,
  };
})()
`;

async function evalJson(handle, expression) {
  const wrapped = expression.trim().startsWith('(')
    ? `JSON.stringify(${expression})`
    : `JSON.stringify((function(){ try { return (${expression}); } catch(e){ return { __error: String(e && e.message || e) }; } })())`;
  const r = await handle.send('Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r && r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'evaluate failed');
  }
  let raw = (r && r.result && r.result.value) || 'null';
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('invalid evaluate result: ' + String(raw).slice(0, 200));
  }
}

async function evalNoResult(handle, expression) {
  const r = await handle.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r && r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'evaluate failed');
  }
  return r && r.result ? r.result.value : undefined;
}

async function waitOzonTabReady(handle, { timeoutMs = NAV_TIMEOUT_MS } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evalJson(handle, `({
      url: location.href,
      title: document.title,
      isCaptcha: (document.body && document.body.innerText || '').includes('Похоже, нет соединения'),
      isAccess: /Доступ\\s*ограничен/i.test(document.body && document.body.innerText || ''),
      bodyLen: document.body ? document.body.innerHTML.length : 0,
      tileCount: document.querySelectorAll('.tile-root').length,
    })`);
    if (state && state.isCaptcha) {
      const err = new Error('captcha_required');
      err.code = 'captcha_required';
      throw err;
    }
    if (state && state.isAccess) {
      const err = new Error('access_restricted');
      err.code = 'access_restricted';
      throw err;
    }
    if (state && state.bodyLen > 80000 && state.tileCount > 0) return state;
    await new Promise((r) => setTimeout(r, NAV_POLL_MS));
  }
  const err = new Error('navigation_timeout');
  err.code = 'navigation_timeout';
  throw err;
}

async function navigateAndWait(handle, url) {
  await handle.send('Page.navigate', { url });
  return waitOzonTabReady(handle);
}

/**
 * 取得 OZON 主页的 requestID/cookie/fingerprint 上下文
 */
async function bootstrap(handle) {
  const cur = await evalJson(handle, `({ url: location.href })`);
  if (!cur.url || !/^https:\/\/www\.ozon\.ru/.test(cur.url)) {
    await navigateAndWait(handle, OZON_HOST + '/');
  }
  return true;
}

async function uploadImageBuffer(handle, buffer, fileName) {
  const b64 = Buffer.from(buffer).toString('base64');
  const expr = `
    (async () => {
      try {
        const bin = atob(${JSON.stringify(b64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const fd = new FormData();
        fd.append('file', blob, ${JSON.stringify(fileName || 'upload.jpg')});
        fd.append('sourceMetadata', JSON.stringify({ width: 1024, height: 1024, type: 'image/jpeg' }));
        const upRes = await fetch(${JSON.stringify(UPLOAD_PATH)}, { method: 'POST', body: fd, credentials: 'include' });
        const text = await upRes.text().catch(() => '');
        let json = {};
        try { json = JSON.parse(text); } catch {}
        return { ok: upRes.ok, status: upRes.status, raw: text.slice(0, 400), json };
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
  try { out = JSON.parse(r.result.value || 'null'); } catch (e) { out = { __parseError: String(r.result && r.result.value) }; }
  if (!out || !out.ok || !out.json || !out.json.imageId) {
    const err = new Error('upload_failed: status=' + (out && out.status) + ' raw=' + (out && out.raw) + ' err=' + (out && out.error));
    err.code = 'upload_failed';
    err.detail = out;
    throw err;
  }
  return out.json;
}

async function uploadImageUrl(handle, imageUrl) {
  const expr = `
    (async () => {
      try {
        const fd = new FormData();
        fd.append('url', ${JSON.stringify(imageUrl)});
        const upRes = await fetch(${JSON.stringify(UPLOAD_PATH)}, { method: 'POST', body: fd, credentials: 'include' });
        const text = await upRes.text().catch(() => '');
        let json = {};
        try { json = JSON.parse(text); } catch {}
        return { ok: upRes.ok, status: upRes.status, raw: text.slice(0, 400), json };
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
  try { out = JSON.parse(r.result.value || 'null'); } catch (e) { out = { __parseError: String(r.result && r.result.value) }; }
  if (!out || !out.ok || !out.json || !out.json.imageId) {
    const err = new Error('upload_failed: status=' + (out && out.status) + ' raw=' + (out && out.raw) + ' err=' + (out && out.error));
    err.code = 'upload_failed';
    err.detail = out;
    throw err;
  }
  return out.json;
}

/**
 * 完整图搜：upload -> navigate -> extract
 */
async function searchByImage(handle, opts) {
  await bootstrap(handle);
  let uploaded;
  if (opts.fileBuffer) {
    uploaded = await uploadImageBuffer(handle, opts.fileBuffer, opts.fileName);
  } else if (opts.url) {
    uploaded = await uploadImageUrl(handle, opts.url);
  } else {
    const err = new Error('need fileBuffer or url');
    err.code = 'invalid_input';
    throw err;
  }

  const imageId = uploaded.imageId;

  // 优先走纯 API 方式（~1秒），失败再回退到 navigate+DOM（~5秒）
  try {
    const apiResult = await searchByImageApi(handle, imageId);
    return {
      ok: true,
      imageId,
      imageSrc: uploaded.imageSrc || '',
      redirectUri: SEARCH_PATH_PREFIX + imageId,
      products: apiResult.products,
      meta: {
        method: 'api',
        tilesFound: apiResult.count,
        uniqueProducts: apiResult.count,
      },
    };
  } catch (apiErr) {
    console.error('[ozonSearch] API mode failed, falling back to DOM:', apiErr.message);
  }

  // 回退：navigate + DOM 提取
  const searchUrl = OZON_HOST + SEARCH_PATH_PREFIX + encodeURIComponent(imageId);
  const finalState = await navigateAndWait(handle, searchUrl);
  const tiles = await evalJson(handle, EXTRACT_TILES_JS);
  tiles.products.forEach((p, i) => { p.rank = i + 1; });

  return {
    ok: true,
    imageId,
    imageSrc: uploaded.imageSrc || '',
    redirectUri: SEARCH_PATH_PREFIX + imageId,
    products: tiles.products,
    meta: {
      method: 'dom',
      tilesFound: tiles.tilesFound,
      uniqueProducts: tiles.uniqueProducts,
      finalUrl: finalState.url,
    },
  };
}

/**
 * 纯 API 方式：直接 fetch entrypoint-api.bx 获取图搜结果 JSON，
 * 解析 tileGridDesktop widget，跳过 navigate + DOM 渲染。
 */
const SEARCH_API_PATH = '/api/entrypoint-api.bx/page/json/v2';

async function searchByImageApi(handle, imageId) {
  const searchPath = '/search-by-image?image_id=' + imageId;
  const expr = `
    (async () => {
      try {
        const apiUrl = ${JSON.stringify(SEARCH_API_PATH)} + '?url=' + encodeURIComponent(${JSON.stringify(searchPath)});
        const res = await fetch(apiUrl, { credentials: 'include' });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        const json = await res.json();

        const widgetStates = json.widgetStates || {};
        const tileKey = Object.keys(widgetStates).find(function(k) { return k.indexOf('tileGridDesktop') === 0; });
        if (!tileKey) return { ok: false, error: 'no_tileGrid', keys: Object.keys(widgetStates) };

        const tileData = JSON.parse(widgetStates[tileKey]);
        const items = tileData.items || [];

        const products = items.map(function(item, i) {
          var url = '', title = '', price = '', oldPrice = '', discount = '', rating = '', reviews = '', image = '';
          try {
            if (item.action && item.action.link) url = 'https://www.ozon.ru' + item.action.link.split('?')[0];
          } catch(e) {}
          try {
            var states = [];
            if (Array.isArray(item.mainState)) states = states.concat(item.mainState);
            if (Array.isArray(item.availableState)) states = states.concat(item.availableState);
            if (Array.isArray(item.availableStates)) states = states.concat(item.availableStates);
            for (var s = 0; s < states.length; s++) {
              var st = states[s];
              if (st.type === 'priceV2' && st.priceV2) {
                var ps = st.priceV2.price || [];
                for (var p = 0; p < ps.length; p++) {
                  if (ps[p].textStyle === 'PRICE') price = ps[p].text;
                  if (ps[p].textStyle === 'ORIGINAL_PRICE') oldPrice = ps[p].text;
                }
                if (st.priceV2.discount) discount = st.priceV2.discount;
              }
              if (st.type === 'textDS' && st.textDS && st.textDS.text) {
                var text = String(st.textDS.text).trim();
                var isTileName = st.textDS.testInfo && st.textDS.testInfo.automatizationId === 'tile-name';
                if (isTileName || (!title && text.indexOf('шт осталось') === -1)) {
                  title = text;
                }
                var ratingMatch = text.match(/(?:рейтинг|оценка)?\s*(\d[.,]\d)/i);
                if (!rating && ratingMatch) rating = ratingMatch[1];
                var reviewMatch = text.match(/([\d\s\u00a0]+)\s*(?:отзыв(?:а|ов)?|оцен(?:ка|ок)?)/i);
                if (!reviews && reviewMatch) reviews = reviewMatch[1].replace(/[^\d]/g, '');
              }
              if (st.type === 'rating' || st.rating) {
                var ratingState = st.rating || st;
                rating = rating || String(ratingState.value || ratingState.rating || ratingState.text || '');
                reviews = reviews || String(ratingState.reviewsCount || ratingState.reviewCount || ratingState.count || '');
              }
            }
          } catch(e) {}
          try {
            if (item.tileImage && item.tileImage.items && item.tileImage.items[0] && item.tileImage.items[0].image) {
              image = item.tileImage.items[0].image.link || '';
            }
          } catch(e) {}
          return { rank: i + 1, url: url, title: title, price: price, oldPrice: oldPrice, discount: discount, rating: rating, reviews: reviews, image: image };
        });

        return { ok: true, count: products.length, products: products };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()
  `;

  const r = await handle.send('Runtime.evaluate', {
    expression: `(async () => { return JSON.stringify(await (${expr})); })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (r && r.exceptionDetails) {
    throw new Error('searchByImageApi eval error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'unknown'));
  }

  let out;
  try { out = JSON.parse(r.result.value || 'null'); } catch { out = null; }
  if (!out || !out.ok) {
    const err = new Error('searchByImageApi failed: ' + (out && out.error));
    err.code = 'api_search_failed';
    err.detail = out;
    throw err;
  }
  return out;
}

module.exports = {
  attachChrome,
  findOzonTab,
  listTabs,
  searchByImage,
  searchByImageApi,
  navigateAndWait,
  evalJson,
  evalNoResult,
  EXTRACT_TILES_JS,
};