// 查找所有tiles，调试为何只看到8个
const http = require('http');
const WebSocket = require('ws');

async function getTabs(port = 9225) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const port = 9225;
  const tabs = await getTabs(port);
  const ozonTab = tabs.find(t => t.url && t.url.includes('ozon.ru'));

  const ws = new WebSocket(ozonTab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  const r = await send('Runtime.evaluate', {
    expression: `
      (() => {
        // Try various selectors
        const tests = {
          tile_root: document.querySelectorAll('.tile-root').length,
          tileGrid: document.querySelectorAll('[data-widget="tileGridDesktop"]').length,
          productLinks: document.querySelectorAll('a[href*="/product/"]').length,
          dataState: document.querySelectorAll('[data-state]').length,
          allLinks: document.querySelectorAll('a').length,
          // Look for parent containers
          tileGridItems: document.querySelectorAll('[data-widget="tileGridDesktop"] > div > div').length,
          // Find any element with multiple product links as children
          multiProductContainers: [...document.querySelectorAll('div')].filter(d => d.querySelectorAll('a[href*="/product/"]').length > 3).length,
        };

        // Also extract from __NUXT__ if any
        const nuxt = window.__NUXT__?.state || {};

        // Look for items/widgets at top of state
        const widgets = (nuxt.widget || {});
        const widgetKeys = Object.keys(widgets);

        return JSON.stringify({
          tests,
          widgetKeys,
          nuxtKeys: Object.keys(nuxt),
          // Maybe webSearchResults V2
          webSearch: !!nuxt.webSearchResults,
          webSearchItems: (nuxt.webSearchResults?.items || []).length,
          // Look for layoutTrackingInfo
          hasLayoutTracking: !!nuxt.layoutTrackingInfo,
          // items array in layout
          layoutItems: (nuxt.layout?.items || []).length,
          layoutWidgets: (nuxt.layout?.widgets || []).length,
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(r.result.value);

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });