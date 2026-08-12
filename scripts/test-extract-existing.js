// 直接对已知存在的图搜 imageId 跑一次提取，验证 .tile-root 流程。
const http = require('http');
const ozon = require('../src/ozonSearch');

(async () => {
  const handle = await ozon.attachChrome({ port: 9225 });
  console.log('attached to', handle.tab.url);
  const state = await ozon.evalJson(handle, `({ url: location.href, title: document.title, tileCount: document.querySelectorAll('.tile-root').length })`);
  console.log('page', state);
  const tiles = await ozon.evalJson(handle, ozon.EXTRACT_TILES_JS);
  console.log('tiles found:', tiles.tilesFound, 'unique:', tiles.uniqueProducts);
  console.log('first product:', JSON.stringify(tiles.products[0], null, 2));
  await handle.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });