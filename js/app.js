/**
 * OZON 批量图搜 · 前端交互逻辑
 * 适配参考页面（1688 图搜）的所有交互规则：
 *   - 三种上传方式（文件 / URL / 表格）
 *   - 进度轮询、结果分页、相似度排序、详情弹窗
 *   - 后端 API 协议保持一致（/api/upload, /api/upload_urls, /api/search/:id, /api/status/:id, /api/results/:id, /api/tasks, /uploads/:id/:file）
 */

(function () {
  'use strict';

  // ============== 配置 ==============
  const DEFAULT_API_BASE = 'http://localhost:5443';
  const LEGACY_API_BASES = new Set([
    'https://192.168.1.35:5443',
    'https://yidong.dianleida.net:22000',
    'https://localhost:5443/api/tasks',
  ]);
  const CHUNK_SIZE = 10;
  const FREIGHT_BATCH_SIZE = 5;
  const FILE_RENDER_BATCH = 30;
  const POLL_INTERVAL = 2000;

  // ============== 状态 ==============
  const state = {
    apiBase: DEFAULT_API_BASE,
    activeTab: 'batch',
    files: [],           // { id, name, dataUrl, status }
    urls: [],            // { url, dataUrl, status }
    tableRows: [],       // [{ name, dataUrl, status }]
    fileRenderCount: 0,
    taskId: null,
    pollTimer: null,
    pollStartedAt: 0,
    lastProgress: null,
    results: {},
    pagination: { currentPage: 1, pageSize: 50, totalItems: 0, imageNames: [] },
    cleanupSentTaskId: null,
    isSearching: false,
    elapsedTimer: null,
  };

  // ============== DOM 工具 ==============
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    children.flat().forEach((c) => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  };
  const fmtTime = (sec) => {
    if (!isFinite(sec) || sec < 0) return '-';
    sec = Math.round(sec);
    if (sec < 60) return `${sec}秒`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}分${s}秒`;
    const hh = Math.floor(m / 60);
    return `${hh}时${m % 60}分`;
  };
  const fmtClock = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  };

  // ============== API Base ==============
  function getApiBase() {
    let base = localStorage.getItem('apiBase');
    if (LEGACY_API_BASES.has(base)) base = DEFAULT_API_BASE;
    if (!base) base = DEFAULT_API_BASE;
    return base.replace(/\/+$/, '');
  }
  function setApiBase(v) {
    localStorage.setItem('apiBase', v);
    state.apiBase = v.replace(/\/+$/, '');
  }

  // ============== fetch with retry ==============
  async function fetchWithRetry(url, opts = {}, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 600000);
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
    throw lastErr;
  }

  // ============== Tabs ==============
  function switchTab(name) {
    state.activeTab = name;
    $$('.upload-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.upload-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    updateSearchBtn();
  }

  // ============== File Upload (Batch) ==============
  function setupBatchUpload() {
    const dropZone = $('#dropZone');
    const fileInput = $('#fileInput');
    on(dropZone, 'click', () => fileInput.click());
    on(fileInput, 'change', (e) => handleFiles(e.target.files));
    ['dragover', 'dragenter'].forEach((ev) =>
      on(dropZone, ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      on(dropZone, ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
    );
    on(dropZone, 'drop', (e) => {
      const fs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      handleFiles(fs);
    });
  }

  function handleFiles(fileList) {
    const arr = Array.from(fileList);
    const seen = new Set(state.files.map((f) => f.name + f.size));
    arr.forEach((f) => {
      if (!f.type.startsWith('image/')) return;
      if (seen.has(f.name + f.size)) return;
      seen.add(f.name + f.size);
      const id = crypto.randomUUID();
      const item = { id, name: f.name, size: f.size, file: f, dataUrl: null };
      state.files.push(item);
      const reader = new FileReader();
      reader.onload = () => {
        item.dataUrl = reader.result;
        renderFileList();
        updateSearchBtn();
      };
      reader.readAsDataURL(f);
    });
  }

  function renderFileList() {
    const grid = $('#fileGrid');
    grid.innerHTML = '';
    const total = state.files.length;
    const shown = Math.min(state.fileRenderCount, total);
    $('#fileCount').textContent = `${total} 张`;
    $('#fileList').hidden = total === 0;
    state.files.slice(0, shown).forEach((f, idx) => grid.appendChild(buildFileItem(f, idx, () => {
      state.files.splice(idx, 1);
      renderFileList();
      updateSearchBtn();
    })));
    if (total > shown) {
      $('#fileListMore').hidden = false;
      $('#fileShown').textContent = shown;
      $('#fileTotal').textContent = total;
    } else {
      $('#fileListMore').hidden = true;
    }
  }

  function buildFileItem(f, idx, onRemove) {
    const el = h('div', { class: 'file-item' });
    if (f.dataUrl) el.appendChild(h('img', { src: f.dataUrl, alt: f.name }));
    el.appendChild(h('div', { class: 'file-item-name', title: f.name }, f.name));
    const rm = h('button', { class: 'file-item-remove', 'aria-label': '移除' }, '×');
    on(rm, 'click', (e) => { e.stopPropagation(); onRemove(); });
    el.appendChild(rm);
    return el;
  }

  // ============== URL Panel ==============
  function setupUrlPanel() {
    const ta = $('#urlTextarea');
    const fileInput = $('#urlFileInput');
    on(ta, 'input', () => {/* preview on demand only */});
    on(fileInput, 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      ta.value = text;
      previewUrls();
    });
    on($('#clearUrlBtn'), 'click', () => { ta.value = ''; state.urls = []; renderUrlGrid(); });
    on($('#previewUrlBtn'), 'click', previewUrls);
  }
  async function previewUrls() {
    const lines = $('#urlTextarea').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const valid = lines.filter((u) => /^https?:\/\//i.test(u));
    state.urls = valid.map((url) => ({ url, status: 'pending' }));
    $('#urlPreview').hidden = valid.length === 0;
    $('#urlCount').textContent = `${valid.length} 条`;
    renderUrlGrid();
    updateSearchBtn();
  }
  function renderUrlGrid() {
    const grid = $('#urlGrid');
    grid.innerHTML = '';
    state.urls.forEach((u, idx) => {
      const el = h('div', { class: 'file-item' });
      el.appendChild(h('img', { src: u.url, alt: u.url, loading: 'lazy' }));
      el.appendChild(h('div', { class: 'file-item-name', title: u.url }, u.url.slice(0, 40) + (u.url.length > 40 ? '…' : '')));
      const rm = h('button', { class: 'file-item-remove' }, '×');
      on(rm, 'click', (e) => { e.stopPropagation(); state.urls.splice(idx, 1); renderUrlGrid(); previewUrls(); });
      el.appendChild(rm);
      grid.appendChild(el);
    });
  }

  // ============== Table Panel ==============
  function setupTablePanel() {
    for (let i = 0; i < 3; i++) addTableRow();
    on($('#addTableRowBtn'), 'click', () => addTableRow());
    on($('#clearTableBtn'), 'click', () => { state.tableRows = []; for (let i = 0; i < 3; i++) addTableRow(); renderTable(); });
  }
  function addTableRow() {
    state.tableRows.push({ name: '', dataUrl: null, status: 'pending' });
    renderTable();
  }
  function renderTable() {
    const wrap = $('#tableGrid');
    wrap.innerHTML = '';
    state.tableRows.forEach((row, idx) => {
      const rowEl = h('div', { class: 'table-row' });
      rowEl.appendChild(h('div', { class: 'table-row-index' }, String(idx + 1)));
      const cell = h('div', { class: 'table-upload-cell' + (row.dataUrl ? ' has-file' : '') });
      const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });
      if (row.dataUrl) {
        cell.appendChild(h('div', { class: 'table-cell-content' },
          h('img', { src: row.dataUrl, class: 'table-cell-img' }),
          h('span', { class: 'table-cell-name', title: row.name }, row.name),
        ));
        const rm = h('button', { class: 'table-cell-remove' }, '×');
        on(rm, 'click', (e) => {
          e.stopPropagation();
          row.dataUrl = null; row.name = '';
          renderTable();
          updateSearchBtn();
        });
        cell.appendChild(rm);
      } else {
        cell.appendChild(h('span', {}, '点击或拖入图片'));
      }
      on(cell, 'click', () => fileInput.click());
      on(fileInput, 'change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { row.dataUrl = reader.result; row.name = f.name; row.file = f; renderTable(); updateSearchBtn(); };
        reader.readAsDataURL(f);
      });
      ['dragover', 'dragenter'].forEach((ev) => on(cell, ev, (e) => { e.preventDefault(); cell.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach((ev) => on(cell, ev, (e) => { e.preventDefault(); cell.classList.remove('dragover'); }));
      on(cell, 'drop', (e) => {
        const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'));
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { row.dataUrl = reader.result; row.name = f.name; row.file = f; renderTable(); updateSearchBtn(); };
        reader.readAsDataURL(f);
      });
      rowEl.appendChild(cell);
      cell.appendChild(fileInput);
      if (state.tableRows.length > 1) {
        const rmRow = h('button', { class: 'table-row-remove', 'aria-label': '删除行' }, '×');
        on(rmRow, 'click', () => { state.tableRows.splice(idx, 1); renderTable(); updateSearchBtn(); });
        rowEl.appendChild(rmRow);
      }
      wrap.appendChild(rowEl);
    });
    const filled = state.tableRows.filter((r) => r.dataUrl).length;
    $('#tableCount').textContent = `${filled} 张图片`;
  }

  // ============== Search Btn ==============
  function getCurrentFileCount() {
    if (state.activeTab === 'batch') return state.files.length;
    if (state.activeTab === 'link')  return state.urls.length;
    return state.tableRows.filter((r) => r.dataUrl).length;
  }
  function updateSearchBtn() {
    $('#searchBtn').disabled = getCurrentFileCount() === 0 || state.isSearching;
  }

  // ============== Search Flow ==============
  async function startSearch() {
    if (state.isSearching) return;
    state.isSearching = true;
    state.taskId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
    state.results = {};
    state.pollStartedAt = Date.now();
    updateSearchBtn();

    $('#progress-section').hidden = false;
    $('#progress-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#progressStatus').textContent = '准备中...';
    $('#progressFill').style.width = '0%';
    $('#progressCurrent').textContent = '0';
    $('#progressTotal').textContent = '0';
    $('#progressPercent').textContent = '0%';
    $('#foundProducts').textContent = '0';
    $('#elapsedTime').textContent = '00:00';
    $('#estimatedTime').textContent = '-';
    $('#currentImage').textContent = '-';
    $('#imageStatusList').innerHTML = '';
    $('#imageStatusSection').hidden = false;
    $('#imageStatusSummary').textContent = '0/0 已完成';
    $('#result-section').hidden = true;

    const t0 = Date.now();
    let endpoint, body;
    try {
      if (state.activeTab === 'batch') {
        endpoint = `${state.apiBase}/api/upload/${state.taskId}`;
        const fd = new FormData();
        state.files.forEach((f) => fd.append('files', f.file));
        const res = await fetchWithRetry(endpoint, { method: 'POST', body: fd });
        const json = await res.json();
        // 立刻触发搜索
        await fetchWithRetry(`${state.apiBase}/api/search/${state.taskId}`, { method: 'POST' });
      } else if (state.activeTab === 'link') {
        // 分批流水线
        endpoint = `${state.apiBase}/api/upload_urls`;
        const allUrls = state.urls.map((u) => u.url);
        const first = allUrls.slice(0, CHUNK_SIZE);
        await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: first, auto_search: true, task_id: state.taskId, is_last_batch: allUrls.length <= CHUNK_SIZE, expected_total: allUrls.length }),
        });
        // 后台继续传剩余
        const rest = allUrls.slice(CHUNK_SIZE);
        for (let i = 0; i < rest.length; i += CHUNK_SIZE) {
          const batch = rest.slice(i, i + CHUNK_SIZE);
          fetchWithRetry(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: batch, auto_search: false, task_id: state.taskId, is_last_batch: i + batch.length >= rest.length, expected_total: allUrls.length }),
          }).catch((e) => console.warn('chunk upload failed:', e));
        }
      } else {
        // table
        const fd = new FormData();
        const filledRows = state.tableRows.filter((r) => r.dataUrl && r.file);
        filledRows.forEach((r) => fd.append('files', r.file));
        endpoint = `${state.apiBase}/api/upload/${state.taskId}`;
        await fetchWithRetry(endpoint, { method: 'POST', body: fd });
        await fetchWithRetry(`${state.apiBase}/api/search/${state.taskId}`, { method: 'POST' });
      }
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      $('#uploadTiming').hidden = false;
      $('#timingVal').textContent = seconds;
      startPolling();
    } catch (e) {
      alert('上传失败：' + e.message);
      state.isSearching = false;
      updateSearchBtn();
    }
  }

  // ============== Polling ==============
  function startPolling() {
    stopPolling();
    state.elapsedTimer = setInterval(() => {
      const sec = (Date.now() - state.pollStartedAt) / 1000;
      $('#elapsedTime').textContent = fmtClock(sec);
    }, 1000);
    poll();
    state.pollTimer = setInterval(poll, POLL_INTERVAL);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  }
  async function poll() {
    try {
      const res = await fetchWithRetry(`${state.apiBase}/api/status/${state.taskId}`, {}, 1);
      const json = await res.json();
      applyProgress(json);
      if (json.status === 'completed' || json.status === 'failed') {
        stopPolling();
        if (json.status === 'completed') await loadResults();
        state.isSearching = false;
        updateSearchBtn();
      }
    } catch (e) {
      console.warn('poll error:', e);
    }
  }
  function applyProgress(j) {
    state.lastProgress = j;
    const total = j.total || 0;
    const cur = j.current || 0;
    $('#progressTotal').textContent = total;
    $('#progressCurrent').textContent = cur;
    const pct = total ? Math.round((cur / total) * 100) : 0;
    $('#progressPercent').textContent = pct + '%';
    $('#progressFill').style.width = pct + '%';
    $('#progressStatus').textContent = j.message || j.status;
    $('#foundProducts').textContent = j.results_count || j.searched_count || 0;
    if (total > 0 && cur > 0) {
      const elapsed = (Date.now() - state.pollStartedAt) / 1000;
      const avg = elapsed / cur;
      const remain = avg * (total - cur);
      $('#estimatedTime').textContent = fmtTime(remain);
    }
    const curImg = (j.image_statuses || []).find((s) => s.status === 'searching');
    $('#currentImage').textContent = curImg ? curImg.name : (j.image_statuses && j.image_statuses.length ? j.image_statuses[j.image_statuses.length - 1].name : '-');
    // 渲染状态列表
    const list = $('#imageStatusList');
    list.innerHTML = '';
    let done = 0;
    (j.image_statuses || []).forEach((s) => {
      if (s.status === 'completed' || s.status === 'no_results' || s.status === 'failed') done++;
      const labels = { pending: '等待中', searching: '搜索中', completed: '已完成', no_results: '无结果', failed: '失败' };
      const row = h('div', { class: 'image-status-row' },
        h('span', { class: 'name', title: s.name }, s.name),
        h('span', { class: `status-badge ${s.status}` }, labels[s.status] || s.status),
        s.result_count != null ? h('span', { class: 'meta-item' }, `${s.result_count} 个结果`) : null,
      );
      list.appendChild(row);
    });
    $('#imageStatusSummary').textContent = `${done}/${(j.image_statuses || []).length} 已完成`;
  }

  // ============== Results ==============
  async function loadResults() {
    try {
      const res = await fetchWithRetry(`${state.apiBase}/api/results/${state.taskId}?limit=500&offset=0`, {}, 1);
      const j = await res.json();
      state.results = j.results || {};
      renderResults();
    } catch (e) {
      console.error('loadResults error:', e);
    }
  }

  function renderResults() {
    $('#result-section').hidden = false;
    $('#result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const names = Object.keys(state.results);
    state.pagination.imageNames = names;
    state.pagination.totalItems = names.length;
    state.pagination.currentPage = 1;
    const totalProducts = Object.values(state.results).reduce((s, r) => s + (r.result_count || 0), 0);
    const totalImages = names.length;
    $('#resultSubtitle').textContent = `共搜索 ${totalImages} 张图片，找到 ${totalProducts} 个商品`;

    // stats cards
    const dur = state.lastProgress ? ((Date.now() - state.pollStartedAt) / 1000).toFixed(1) : '0';
    $('#statsRow').innerHTML = '';
    $('#statsRow').appendChild(makeStatsCard('搜索图片数', totalImages, false));
    $('#statsRow').appendChild(makeStatsCard('找到商品数', totalProducts, true));
    $('#statsRow').appendChild(makeStatsCard('平均结果/图', totalImages ? (totalProducts / totalImages).toFixed(1) : '0', false));
    $('#statsRow').appendChild(makeStatsCard('接口总耗时', dur + '秒', false));

    renderPage();
  }

  function makeStatsCard(label, val, primary) {
    return h('div', { class: 'stats-card' + (primary ? ' primary' : '') },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, String(val)),
    );
  }

  function renderPage() {
    const list = $('#resultList');
    list.innerHTML = '';
    const { currentPage, pageSize, imageNames } = state.pagination;
    const total = imageNames.length;
    if (total === 0) {
      list.appendChild(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state-icon' }, '🔍'),
        h('p', {}, '未找到匹配的商品')));
      $('#paginationWrap').hidden = true;
      return;
    }
    const start = (currentPage - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const pageItems = imageNames.slice(start, end);
    pageItems.forEach((imgName) => {
      const entry = state.results[imgName] || {};
      const items = (entry.results || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
      const row = h('div', { class: 'result-row' });
      row.appendChild(h('div', { class: 'result-source' }, h('img', { src: `${state.apiBase}/uploads/${state.taskId}/${encodeURIComponent(imgName)}`, alt: imgName, loading: 'lazy' })));
      const miniWrap = h('div', { class: 'result-mini-cards' });
      items.slice(0, 5).forEach((it, i) => miniWrap.appendChild(buildMiniCard(it, i + 1)));
      row.appendChild(miniWrap);
      const moreWrap = h('div', { class: 'result-more' });
      if (items.length > 5) {
        const btn = h('button', { class: 'btn-view-more' }, `查看更多 +${items.length - 5}`);
        on(btn, 'click', () => openResultModal(imgName, entry));
        moreWrap.appendChild(btn);
      }
      const btnAll = h('button', { class: 'btn-view-more' }, '查看全部');
      on(btnAll, 'click', () => openResultModal(imgName, entry));
      moreWrap.appendChild(btnAll);
      row.appendChild(moreWrap);
      list.appendChild(row);
    });
    $('#paginationWrap').hidden = total <= pageSize;
    $('#paginationInfo').textContent = `第 ${start + 1}-${end} 条，共 ${total} 条`;
    $('#pageCurrentNum').textContent = currentPage;
    $('#pageTotalNum').textContent = Math.max(1, Math.ceil(total / pageSize));
    $('#pagePrev').disabled = currentPage <= 1;
    $('#pageNext').disabled = currentPage >= Math.ceil(total / pageSize);
    $('#pageFirst').disabled = currentPage <= 1;
    $('#pageLast').disabled = currentPage >= Math.ceil(total / pageSize);
  }

  function buildMiniCard(item, rank) {
    const tpl = $('#miniCardTemplate');
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.href = item.url || '#';
    node.querySelector('img').src = item.image || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23f5f7fb"/%3E%3Ctext x="50" y="55" text-anchor="middle" font-size="12" fill="%238b94b0"%3E无图%3C/text%3E%3C/svg%3E';
    node.querySelector('.mini-title').textContent = item.title || '暂无标题';
    node.querySelector('.mini-rank').textContent = '#' + rank;
    node.querySelector('.mini-price').textContent = item.price ? `₽ ${item.price}` : '-';
    return node;
  }

  function buildFullCard(item, rank) {
    const tpl = $('#productCardTemplate');
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.href = item.url || '#';
    node.querySelector('img').src = item.image || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23f5f7fb"/%3E%3Ctext x="50" y="55" text-anchor="middle" font-size="12" fill="%238b94b0"%3E无图%3C/text%3E%3C/svg%3E';
    node.querySelector('.product-title').textContent = item.title || '暂无标题';
    node.querySelector('.product-price').textContent = item.price ? `₽ ${item.price}` : '-';
    const meta = node.querySelector('.product-meta');
    meta.innerHTML = '';
    if (item.rating) meta.appendChild(h('span', { class: 'meta-item' }, `⭐ ${item.rating}`));
    if (item.reviews) meta.appendChild(h('span', { class: 'meta-item' }, `💬 ${item.reviews}`));
    if (item.rank) meta.appendChild(h('span', { class: 'meta-item' }, `#${item.rank}`));
    const fill = node.querySelector('.similarity-fill');
    const sim = item.similarity != null ? item.similarity : (item.rank ? Math.max(0, 1 - item.rank / 50) : 0.5);
    fill.style.width = Math.max(10, Math.min(100, sim * 100)) + '%';
    return node;
  }

  function openResultModal(imgName, entry) {
    $('#resultModalThumb').src = `${state.apiBase}/uploads/${state.taskId}/${encodeURIComponent(imgName)}`;
    $('#resultModalTitle').textContent = imgName;
    const items = (entry.results || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
    $('#resultModalSub').textContent = `共 ${items.length} 个结果 · 耗时 ${(entry.search_time || 0).toFixed(1)}秒`;
    const grid = $('#resultModalGrid');
    grid.innerHTML = '';
    items.forEach((it, i) => grid.appendChild(buildFullCard(it, i + 1)));
    $('#resultModal').hidden = false;
  }
  function closeResultModal() { $('#resultModal').hidden = true; }

  // ============== Pagination ==============
  function setupPagination() {
    on($('#pageFirst'), 'click', () => { state.pagination.currentPage = 1; renderPage(); });
    on($('#pagePrev'),  'click', () => { if (state.pagination.currentPage > 1) state.pagination.currentPage--; renderPage(); });
    on($('#pageNext'),  'click', () => { state.pagination.currentPage++; renderPage(); });
    on($('#pageLast'),  'click', () => { state.pagination.currentPage = Math.ceil(state.pagination.totalItems / state.pagination.pageSize); renderPage(); });
    on($('#pageJumpBtn'), 'click', () => {
      const v = Number($('#pageJumpInput').value);
      if (v >= 1 && v <= Math.ceil(state.pagination.totalItems / state.pagination.pageSize)) {
        state.pagination.currentPage = v; renderPage();
      }
    });
    on($('#pageSizeSelect'), 'change', (e) => { state.pagination.pageSize = Number(e.target.value); state.pagination.currentPage = 1; renderPage(); });
  }

  // ============== Settings ==============
  function openSettings() {
    $('#apiBaseInput').value = state.apiBase;
    $('#settingsModal').hidden = false;
    testConnection();
  }
  function closeSettings() { $('#settingsModal').hidden = true; }
  async function testConnection() {
    const dot = $('#connectionStatus .status-dot');
    const text = $('#connectionStatus .status-text');
    dot.className = 'status-dot checking';
    text.textContent = '检测中...';
    try {
      const res = await fetch(`${state.apiBase}/api/tasks`, { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.json();
      dot.className = 'status-dot success';
      text.textContent = '连接成功';
    } catch (e) {
      dot.className = 'status-dot error';
      text.textContent = '连接失败：' + e.message;
    }
  }
  function setupSettings() {
    on($('#settingsBtn'), 'click', openSettings);
    on($('#settingsClose'), 'click', closeSettings);
    on($('#settingsCancel'), 'click', closeSettings);
    on($('#settingsSave'), 'click', () => {
      const v = $('#apiBaseInput').value.trim();
      if (v) { setApiBase(v); $('#settingsSave').textContent = '✓ 已保存'; setTimeout(() => $('#settingsSave').textContent = '保存设置', 1200); }
    });
    on($('#settingsOverlay'), 'click', closeSettings);
    on(document, 'keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeResultModal(); } });
  }

  // ============== Notice ==============
  function setupNotice() {
    on($('#noticeClose'), 'click', () => $('#apiNotice').hidden = true);
    on($('#apiNotice'), 'click', (e) => { if (e.target.tagName === 'A') return; openSettings(); });
  }

  // ============== Result Modal ==============
  function setupResultModal() {
    on($('#resultModalClose'), 'click', closeResultModal);
    on($('#resultModalOverlay'), 'click', closeResultModal);
  }

  // ============== Export / New ==============
  function exportJson() {
    const data = {
      taskId: state.taskId,
      totalImages: state.pagination.totalItems,
      results: state.results,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `OZON图搜结果_${state.taskId}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  function newSearch() {
    cleanupCurrentTask();
    state.files = []; state.urls = []; state.tableRows = [];
    for (let i = 0; i < 3; i++) addTableRow();
    renderFileList(); renderUrlGrid(); renderTable();
    $('#uploadTiming').hidden = true;
    $('#result-section').hidden = true;
    $('#progress-section').hidden = true;
    state.isSearching = false;
    updateSearchBtn();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function cleanupCurrentTask() {
    if (!state.taskId) return;
    try { await fetch(`${state.apiBase}/api/tasks/${state.taskId}/cancel`, { method: 'POST' }); } catch {}
  }

  // ============== Lifecycle ==============
  function setupLifecycle() {
    window.addEventListener('beforeunload', () => { if (state.taskId) cleanupCurrentTask(); });
  }

  // ============== Init ==============
  function init() {
    state.apiBase = getApiBase();
    $('#apiBaseInput').value = state.apiBase;
    setupBatchUpload();
    setupUrlPanel();
    setupTablePanel();
    setupPagination();
    setupSettings();
    setupResultModal();
    setupNotice();
    setupLifecycle();
    $$('.upload-tab').forEach((b) => on(b, 'click', () => switchTab(b.dataset.tab)));
    on($('#searchBtn'), 'click', startSearch);
    on($('#clearBtn'), 'click', () => { state.files = []; renderFileList(); updateSearchBtn(); });
    on($('#exportJsonBtn'), 'click', exportJson);
    on($('#newSearchBtn'), 'click', newSearch);
    on($('#loadMoreFilesBtn'), 'click', () => { state.fileRenderCount += FILE_RENDER_BATCH; renderFileList(); });
    state.fileRenderCount = FILE_RENDER_BATCH;
    // 默认打开设置（首次访问）
    if (!localStorage.getItem('apiBase')) {
      setTimeout(openSettings, 600);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();