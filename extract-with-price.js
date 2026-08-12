// 完整提取 - 包括价格和标题
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

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
  console.log('OZON tab:', ozonTab.url);

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

  // Debug: 查看第一个商品 tile 的完整结构
  console.log('=== Inspect first product tile ===');
  const inspect = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const firstLink = document.querySelector('a[href*="/product/"]');
        if (!firstLink) return JSON.stringify({error: 'no product link'});

        // 向上找最近的商品 tile
        let tile = firstLink;
        for (let i = 0; i < 10; i++) {
          tile = tile.parentElement;
          if (!tile) break;
          // 看到 tile 包含价格时停止
          if (tile.querySelectorAll('a[href*="/product/"]').length > 1) break;
          const txt = tile.textContent || '';
          if (/\d+\s*₽/.test(txt) && txt.length < 2000) break;
        }

        // 提取tile的所有文本
        const allText = tile?.textContent?.slice(0, 2000) || '';
        // 提取 tile 里的所有元素类型
        const elements = tile ? [...tile.querySelectorAll('*')].slice(0, 50).map(el => ({
          tag: el.tagName,
          cls: (el.className || '').slice(0, 100),
          text: (el.textContent || '').slice(0, 200).trim(),
          ariaLabel: el.getAttribute('aria-label'),
        })).filter(e => e.text) : [];

        // 搜索价格 - 所有数字+₽的文本
        const priceTexts = [...tile.querySelectorAll('span')].map(s => s.textContent.trim()).filter(t => /\d+\s*₽|\d+\s*\\u20BD/.test(t));

        return JSON.stringify({
          tileClass: tile?.className,
          allText: allText,
          elements: elements.slice(0, 30),
          priceTexts: priceTexts,
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(inspect.result.value);

  // 真正的商品提取 - 用更智能的方式
  console.log('\n=== Final extraction ===');
  const final = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = [];
        const seen = new Set();
        const links = document.querySelectorAll('a[href*="/product/"]');

        for (const link of links) {
          const href = link.href.split('?')[0];
          if (seen.has(href)) continue;
          seen.add(href);

          // 找到商品 tile
          let tile = link;
          for (let i = 0; i < 6; i++) {
            tile = tile.parentElement;
            if (!tile) break;
          }

          // 提取 title (通常是 tile 里的 h2 / a 标签文本，不是促销标签)
          // 商品名通常是俄文 + 描述
          let title = '';
          const candidateTitles = [];
          tile?.querySelectorAll('span, a').forEach(el => {
            const text = (el.textContent || '').trim();
            // 跳过短文本、促销文本
            if (text.length < 10 || text.length > 200) return;
            if (/^(Распродажа|Осталось?|Новинка|Цена|Бесплатно|Хит|Скидка)/.test(text)) return;
            if (/\d+\s*₽/.test(text)) return; // skip prices
            if (/^\d+$/.test(text)) return; // skip pure numbers
            candidateTitles.push(text);
          });
          // 取第一个长 title
          for (const t of candidateTitles) {
            if (t.length > 20) { title = t; break; }
          }
          if (!title && candidateTitles.length > 0) title = candidateTitles[0];

          // 提取价格 - 搜索包含 ₽ 的所有数字
          let price = '';
          const allText = tile?.textContent || '';
          const priceMatch = allText.match(/(\d{2,6})\s*₽/);
          if (priceMatch) {
            price = priceMatch[1] + ' ₽';
          }

          // 提取图片
          const img = tile?.querySelector('img');

          out.push({
            url: href,
            title: title,
            price: price,
            image: img ? (img.src || img.getAttribute('data-src') || '') : '',
          });
        }

        // Filter out empty titles
        return JSON.stringify({
          totalLinks: links.length,
          totalFound: out.length,
          withTitle: out.filter(p => p.title).length,
          withPrice: out.filter(p => p.price).length,
          products: out.slice(0, 50),
        }, null, 2);
      })()
    `,
    returnByValue: true,
  });
  console.log(final.result.value);

  // Save final result
  try {
    const parsed = JSON.parse(final.result.value);
    const products = parsed.products.map(p => ({
      url: p.url,
      title: p.title,
      price: p.price,
      image: p.image,
    }));
    const requestID = await (await send('Runtime.evaluate', { expression: 'window.__NUXT__?.state?.requestID || null', returnByValue: true })).result.value;
    fs.writeFileSync('F:/traehuihua/6a7c43465a320f293c88f40c/ozon-image-search/ozon-products.json', JSON.stringify({
      imageId: '56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586',
      timestamp: Date.now(),
      requestID,
      products,
    }, null, 2));
    console.log(`\nSaved ${products.length} products to ozon-products.json`);
    if (parsed.withPrice > 0) console.log(`  其中 ${parsed.withPrice} 个有价格`);
  } catch (e) {
    console.log('Save failed:', e.message);
  }

  ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });