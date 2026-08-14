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
  const DEFAULT_API_BASE = 'https://yidong.dianleida.net:21999';
  const LEGACY_API_BASES = new Set([
    'http://localhost:5443',
    'https://localhost:5443',
    'https://localhost:5443/api/tasks',
    'https://192.168.1.35:5443',
    'https://yidong.dianleida.net:22000',
  ]);
  const CHUNK_SIZE = 100;
  const FREIGHT_BATCH_SIZE = 5;
  const FILE_RENDER_BATCH = 30;
  const POLL_INTERVAL = 2000;

  // ============== 状态 ==============
  const state = {
    apiBase: DEFAULT_API_BASE,
    activeTab: 'link',
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
    // 记录本 tab 创建/访问过的所有 taskIds，关闭时一并清掉
    ownedTaskIds: new Set(JSON.parse(sessionStorage.getItem('ownedTaskIds') || '[]')),
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
    on($('#loadMoreFilesBtn'), 'click', () => {
      state.fileRenderCount = Math.min(state.fileRenderCount + FILE_RENDER_BATCH, state.files.length);
      renderFileList();
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
        // 上传后直接渲染缩略图
        state.fileRenderCount = state.files.length;
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
      state.fileRenderCount = Math.min(state.fileRenderCount, state.files.length);
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
    on(ta, 'input', () => { clearTimeout(state._urlTimer); state._urlTimer = setTimeout(parseUrls, 300); });
    on(ta, 'paste', () => { clearTimeout(state._urlTimer); state._urlTimer = setTimeout(parseUrls, 100); });
    on(fileInput, 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      ta.value = text;
      parseUrls();
    });
    on($('#clearUrlBtn'), 'click', () => { ta.value = ''; state.urls = []; $('#urlPreview').hidden = true; parseUrls(); });
    on($('#previewUrlBtn'), 'click', () => { parseUrls(); renderUrlGrid(); $('#urlPreview').hidden = state.urls.length === 0; });
  }

  // 解析 URL，只更新 state 和按钮状态，不渲染图片
  function parseUrls() {
    const lines = $('#urlTextarea').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const valid = lines.filter((u) => /^https?:\/\//i.test(u));
    state.urls = valid.map((url) => ({ url, status: 'pending' }));
    $('#urlCount').textContent = `${valid.length} 条`;
    updateSearchBtn();
  }

  // 预览 URL 图片网格（仅用户点"预览链接"时调用）
  function previewUrls() {
    parseUrls();
    renderUrlGrid();
    $('#urlPreview').hidden = state.urls.length === 0;
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

  // ============== Table Panel (Excel/CSV 上传) ==============
  function setupTablePanel() {
    const dropZone = $('#tableDropZone');
    const fileInput = $('#tableFileInput');
    on(dropZone, 'click', () => fileInput.click());
    on(fileInput, 'change', (e) => { const f = e.target.files[0]; if (f) handleTableFile(f); });
    ['dragover', 'dragenter'].forEach((ev) => on(dropZone, ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => on(dropZone, ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
    on(dropZone, 'drop', (e) => {
      const f = Array.from(e.dataTransfer.files).find((x) => /\.(xlsx|xls|csv)$/i.test(x.name));
      if (f) handleTableFile(f);
    });
    on($('#clearTableBtn'), 'click', () => {
      state.tableUrls = [];
      $('#tableFileInfo').hidden = true;
      $('#tablePreview').hidden = true;
      $('#tableFileInput').value = '';
      updateSearchBtn();
    });
    on($('#refreshTableUrlsBtn'), 'click', () => {
      const lines = $('#tableUrlTextarea').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = lines.filter((u) => /^https?:\/\//i.test(u));
      state.tableUrls = valid.map((url) => ({ url, status: 'pending' }));
      $('#tableUrlCount').textContent = `${valid.length} 条链接`;
      // 如果预览区已打开，刷新预览
      if (!$('#tablePreview').hidden) {
        renderTableGrid();
      }
      updateSearchBtn();
    });
    on($('#previewTableBtn'), 'click', () => {
      // 先确保数据是最新的（从 textarea 读取）
      const lines = $('#tableUrlTextarea').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = lines.filter((u) => /^https?:\/\//i.test(u));
      state.tableUrls = valid.map((url) => ({ url, status: 'pending' }));
      $('#tableUrlCount').textContent = `${valid.length} 条链接`;
      renderTableGrid();
      $('#tablePreview').hidden = state.tableUrls.length === 0;
      updateSearchBtn();
    });
  }

  // 解析 Excel/CSV 文件，提取所有单元格中的图片链接
  async function handleTableFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const wb = typeof XLSX !== 'undefined' ? XLSX.read(buf, { type: 'array' }) : null;

      let allText = '';
      if (wb) {
        // 遍历所有 sheet
        for (const name of wb.SheetNames) {
          const ws = wb.Sheets[name];
          const csv = XLSX.utils.sheet_to_csv(ws);
          allText += csv + '\n';
        }
      } else {
        // 纯 CSV/文本：直接读
        allText = new TextDecoder().decode(buf);
      }

      // 从所有文本中提取图片链接
      const urlRegex = /https?:\/\/[^\s"',;|}\]]+\.(?:jpg|jpeg|png|webp|gif|bmp|tiff?)(?:\?[^\s"',;|}\]]*)?/gi;
      const matches = allText.match(urlRegex) || [];
      // 去重
      const unique = [...new Set(matches.map((u) => u.trim()))];

      state.tableUrls = unique.map((url) => ({ url, status: 'pending' }));

      // 展示文件信息和识别到的链接
      $('#tableFileInfo').hidden = false;
      $('#tablePreview').hidden = true; // 默认不显示预览
      $('#tableFileName').textContent = '📄 ' + file.name;
      $('#tableUrlCount').textContent = `${unique.length} 条链接`;
      const ta = $('#tableUrlTextarea');
      ta.value = unique.join('\n');
      ta.readOnly = false; // 允许用户编辑

      updateSearchBtn();
    } catch (e) {
      alert('解析表格失败：' + e.message);
    }
  }

  // 渲染表格面板预览网格
  function renderTableGrid() {
    const grid = $('#tableGrid');
    grid.innerHTML = '';
    (state.tableUrls || []).forEach((u, idx) => {
      const el = h('div', { class: 'file-item' });
      el.appendChild(h('img', { src: u.url, alt: u.url, loading: 'lazy' }));
      el.appendChild(h('div', { class: 'file-item-name', title: u.url }, u.url.slice(0, 40) + (u.url.length > 40 ? '…' : '')));
      const rm = h('button', { class: 'file-item-remove' }, '×');
      on(rm, 'click', (e) => {
        e.stopPropagation();
        state.tableUrls.splice(idx, 1);
        // 同步更新 textarea
        $('#tableUrlTextarea').value = state.tableUrls.map((u) => u.url).join('\n');
        $('#tableUrlCount').textContent = `${state.tableUrls.length} 条链接`;
        renderTableGrid();
        if (state.tableUrls.length === 0) {
          $('#tablePreview').hidden = true;
        }
        updateSearchBtn();
      });
      el.appendChild(rm);
      grid.appendChild(el);
    });
  }

  // ============== Search Btn ==============
  function getCurrentFileCount() {
    if (state.activeTab === 'batch') return state.files.length;
    if (state.activeTab === 'link')  return state.urls.length;
    return (state.tableUrls || []).length;
  }
  function updateSearchBtn() {
    $('#searchBtn').disabled = getCurrentFileCount() === 0 || state.isSearching;
    // 清空按钮只在当前 tab 有数据时显示
    $('#clearBtn').hidden = state.isSearching || getCurrentFileCount() === 0;
  }

  // ============== Search Flow ==============
  async function startSearch() {
    if (state.isSearching) return;
    state.isSearching = true;
    state.taskId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
    registerOwnedTask(state.taskId);
    state.results = {};
    state.pollStartedAt = Date.now();
    state.cancelRequested = false;
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
    // 显示停止按钮
    $('#cancelBtn').hidden = false;
    $('#cancelBtn').disabled = false;
    $('#cancelBtn').textContent = '⏹ 停止任务';
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
        // table: 从 Excel/CSV 识别的 URL，走 URL 上传流程
        endpoint = `${state.apiBase}/api/upload_urls`;
        const allUrls = (state.tableUrls || []).map((u) => u.url);
        const first = allUrls.slice(0, CHUNK_SIZE);
        await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: first, auto_search: true, task_id: state.taskId, is_last_batch: allUrls.length <= CHUNK_SIZE, expected_total: allUrls.length }),
        });
        const rest = allUrls.slice(CHUNK_SIZE);
        for (let i = 0; i < rest.length; i += CHUNK_SIZE) {
          const batch = rest.slice(i, i + CHUNK_SIZE);
          fetchWithRetry(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: batch, auto_search: false, task_id: state.taskId, is_last_batch: i + batch.length >= rest.length, expected_total: allUrls.length }),
          }).catch((e) => console.warn('chunk upload failed:', e));
        }
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
        $('#cancelBtn').hidden = true;
        const wasCancelled = state.cancelRequested;
        await loadResults();
        state.isSearching = false;
        updateSearchBtn();
      }
    } catch (e) {
      console.warn('poll failed', e);
    }
  }

  function applyProgress(p) {
    if (!p) return;
    const total = p.total || 0;
    const current = p.current || 0;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    $('#progressCurrent').textContent = current;
    $('#progressTotal').textContent = total;
    $('#progressFill').style.width = percent + '%';
    $('#progressPercent').textContent = percent + '%';
    $('#progressStatus').textContent = p.message || p.status || '';
    $('#foundProducts').textContent = (p.results_count || 0);
    $('#imageStatusSummary').textContent = `${p.searched_count || 0}/${total} 已完成`;
    if (p.currentImage) $('#currentImage').textContent = p.currentImage;
    if (Array.isArray(p.image_statuses)) {
      const list = $('#imageStatusList');
      list.innerHTML = '';
      p.image_statuses.forEach((s) => {
        const item = h('div', { class: 'image-status-item' }, [
          h('div', { class: 'image-status-thumb' }, [
            h('img', { src: `/uploads/${state.taskId}/${encodeURIComponent(s.name)}`, alt: s.name, loading: 'lazy', onerror: (e) => { e.target.style.opacity = '0.3'; } })
          ]),
          h('div', { class: 'image-status-info' }, [
            h('div', { class: 'image-status-name', title: s.name }, s.name.length > 40 ? s.name.slice(0, 40) + '…' : s.name),
            h('div', { class: 'image-status-meta' }, [
              h('span', { class: 'pill', 'data-status': s.status }, s.status),
              h('span', {}, `${s.result_count} 个商品`),
              s.error ? h('span', { class: 'err' }, s.error) : null,
            ].filter(Boolean)),
          ]),
        ]);
        list.appendChild(item);
      });
    }
  }

  async function loadResults() {
    try {
      const res = await fetchWithRetry(`${state.apiBase}/api/results/${state.taskId}`);
      const json = await res.json();
      state.results = json.results || {};
      renderResults();
    } catch (e) {
      console.error('load results failed', e);
    }
  }

  function renderResults() {
    const container = $('#resultsGrid');
    container.innerHTML = '';
    const imageNames = Object.keys(state.results);
    state.pagination.imageNames = imageNames;
    state.pagination.totalItems = imageNames.length;
    state.pagination.currentPage = 1;
    renderPage();
    $('#result-section').hidden = imageNames.length === 0;
  }

  function renderPage() {
    const container = $('#resultsGrid');
    container.innerHTML = '';
    const { currentPage, pageSize, imageNames } = state.pagination;
    const start = (currentPage - 1) * pageSize;
    const pageNames = imageNames.slice(start, start + pageSize);
    pageNames.forEach((name) => {
      const item = state.results[name];
      if (!item) return;
      const card = h('div', { class: 'result-card' });
      card.appendChild(h('div', { class: 'result-thumb' }, [
        h('img', { src: `/uploads/${state.taskId}/${encodeURIComponent(name)}`, alt: name, loading: 'lazy', onerror: (e) => { e.target.style.opacity = '0.3'; } })
      ]));
      const body = h('div', { class: 'result-body' }, [
        h('div', { class: 'result-title', title: name }, name.length > 40 ? name.slice(0, 40) + '…' : name),
        h('div', { class: 'result-meta' }, `${item.results.length} 个候选商品`),
      ]);
      card.appendChild(body);
      const list = h('div', { class: 'product-list' });
      (item.results || []).slice(0, 5).forEach((p) => {
        list.appendChild(h('div', { class: 'product-item' }, [
          h('img', { src: p.image, alt: p.title }),
          h('div', { class: 'product-info' }, [
            h('a', { href: p.url, target: '_blank', class: 'product-title' }, p.title || ''),
            h('div', { class: 'product-price' }, p.price || '-'),
            h('div', { class: 'product-rating' }, [
              p.rating ? h('span', {}, `⭐ ${p.rating}`) : null,
              p.reviews ? h('span', {}, `💬 ${p.reviews}`) : null,
            ].filter(Boolean)),
          ]),
        ]));
      });
      card.appendChild(list);
      container.appendChild(card);
    });
    $('#pageInfo').textContent = `第 ${currentPage} / ${Math.max(1, Math.ceil(imageNames.length / pageSize))} 页`;
  }

  function nextPage() {
    const total = Math.ceil(state.pagination.totalItems / state.pagination.pageSize);
    if (state.pagination.currentPage < total) {
      state.pagination.currentPage += 1;
      renderPage();
    }
  }
  function prevPage() {
    if (state.pagination.currentPage > 1) {
      state.pagination.currentPage -= 1;
      renderPage();
    }
  }

  // ============== Cleanup ==============
  function registerOwnedTask(taskId) {
    state.ownedTaskIds.add(taskId);
    try { sessionStorage.setItem('ownedTaskIds', JSON.stringify(Array.from(state.ownedTaskIds))); } catch {}
  }

  async function cancelTask() {
    if (!state.taskId) return;
    state.cancelRequested = true;
    $('#cancelBtn').disabled = true;
    try {
      await fetchWithRetry(`${state.apiBase}/api/tasks/${state.taskId}/cancel`, { method: 'POST' });
    } catch {}
  }

  async function cleanupTasks() {
    const ids = Array.from(state.ownedTaskIds);
    if (!ids.length) return;
    try {
      await fetchWithRetry(`${state.apiBase}/api/cleanup_batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ids }),
      });
    } catch {}
    state.ownedTaskIds.clear();
    try { sessionStorage.removeItem('ownedTaskIds'); } catch {}
  }

  // ============== 事件绑定 ==============
  function bindEvents() {
    $$('.upload-tab').forEach((b) => on(b, 'click', () => switchTab(b.dataset.tab)));
    on($('#searchBtn'), 'click', () => startSearch());
    on($('#cancelBtn'), 'click', () => cancelTask());
    on($('#clearBtn'), 'click', () => {
      if (state.activeTab === 'batch') state.files = [];
      if (state.activeTab === 'link') { state.urls = []; $('#urlTextarea').value = ''; }
      if (state.activeTab === 'table') { state.tableUrls = []; $('#tableUrlTextarea').value = ''; $('#tableFileInfo').hidden = true; $('#tablePreview').hidden = true; }
      if (state.activeTab === 'batch') renderFileList();
      if (state.activeTab === 'link') { $('#urlCount').textContent = '0 条'; $('#urlPreview').hidden = true; }
      if (state.activeTab === 'table') { $('#tableUrlCount').textContent = '0 条链接'; }
      updateSearchBtn();
    });
    on($('#nextPageBtn'), 'click', () => nextPage());
    on($('#prevPageBtn'), 'click', () => prevPage());
    window.addEventListener('beforeunload', () => cleanupTasks());
  }

  // ============== 启动 ==============
  bindEvents();
  setupBatchUpload();
  setupUrlPanel();
  setupTablePanel();
  switchTab('link');
})();
