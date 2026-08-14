/**
 * OZON 图搜 · 结果解析
 */

function pushStates(target, states) {
  if (!Array.isArray(states)) return;
  for (const st of states) target.push(st);
}

function extractRatingAndReviews(labelList) {
  if (!labelList || !Array.isArray(labelList.items)) return { rating: '', reviews: '' };
  let rating = '';
  let reviews = '';
  for (const item of labelList.items) {
    let t = item && item.text;
    if (t && typeof t === 'object') t = t.text;
    if (!t) continue;
    const text = String(t).trim();
    if (!text) continue;
    if (!rating && /^\d[.,]\d+$/.test(text)) rating = text;
    if (!reviews && /\d/.test(text) && /отзыв(?:а|ов)?/i.test(text)) {
      reviews = text.replace(/[^\d]/g, '');
    }
  }
  return { rating, reviews };
}

function extractPrice(st) {
  let price = '';
  let oldPrice = '';
  let discount = '';
  if (!st || !st.priceV2) return { price, oldPrice, discount };
  const ps = st.priceV2.price || [];
  for (const p of ps) {
    if (p.textStyle === 'PRICE' && !price) price = p.text;
    if (p.textStyle === 'ORIGINAL_PRICE' && !oldPrice) oldPrice = p.text;
  }
  if (st.priceV2.discount) discount = st.priceV2.discount;
  return { price, oldPrice, discount };
}

function extractTitle(states) {
  for (const st of states) {
    if (!st || st.type !== 'textDS' || !st.textDS || !st.textDS.text) continue;
    const text = String(st.textDS.text).trim();
    if (!text) continue;
    const isTileName = st.textDS.testInfo && st.textDS.testInfo.automatizationId === 'tile-name';
    if (!isTileName) continue;
    return text;
  }
  for (const st of states) {
    if (!st || st.type !== 'textDS' || !st.textDS || !st.textDS.text) continue;
    const text = String(st.textDS.text).trim();
    if (!text || text.indexOf('шт осталось') !== -1) continue;
    return text;
  }
  return '';
}

function mapItem(item, index) {
  let url = '';
  try {
    if (item.action && item.action.link) {
      url = 'https://www.ozon.ru' + item.action.link.split('?')[0];
    }
  } catch (e) { /* ignore */ }

  const states = [];
  pushStates(states, item.mainState);
  pushStates(states, item.availableState);
  pushStates(states, item.availableStates);

  let title = '';
  let price = '';
  let oldPrice = '';
  let discount = '';
  let rating = '';
  let reviews = '';

  for (const st of states) {
    if (!st || !st.type) continue;
    if (st.type === 'priceV2') {
      const p = extractPrice(st);
      if (!price) price = p.price;
      if (!oldPrice) oldPrice = p.oldPrice;
      if (!discount) discount = p.discount;
    } else if (st.type === 'textDS') {
      if (!title) {
        const t = String(st.textDS.text || '').trim();
        const isTileName = st.textDS.testInfo && st.textDS.testInfo.automatizationId === 'tile-name';
        if ((isTileName || t.indexOf('шт осталось') === -1) && t.length > 0) {
          title = t;
        }
      }
      const text = String(st.textDS.text || '');
      if (!rating) {
        const m = text.match(/(?:рейтинг|оценка)?\s*(\d[.,]\d)/i);
        if (m) rating = m[1];
      }
      if (!reviews) {
        const m = text.match(/([\d\s\u00a0]+)\s*(?:отзыв(?:а|ов)?|оцен(?:ка|ок)?)/i);
        if (m) reviews = m[1].replace(/[^\d]/g, '');
      }
    } else if (st.type === 'labelListV2' && st.labelListV2) {
      const r = extractRatingAndReviews(st.labelListV2);
      if (!rating) rating = r.rating;
      if (!reviews) reviews = r.reviews;
    }
  }

  if (!title) title = extractTitle(states);

  let image = '';
  try {
    if (item.tileImage && item.tileImage.items && item.tileImage.items[0] && item.tileImage.items[0].image) {
      image = item.tileImage.items[0].image.link || '';
    }
  } catch (e) { /* ignore */ }

  return { rank: index + 1, url, title, price, oldPrice, discount, rating, reviews, image };
}

function parseProductsFromTileGrid(json) {
  const widgetStates = (json && json.widgetStates) || {};
  const tileKey = Object.keys(widgetStates).find((k) => k.indexOf('tileGridDesktop') === 0);
  if (!tileKey) {
    const err = new Error('no_tileGrid');
    err.code = 'no_tileGrid';
    err.detail = Object.keys(widgetStates);
    throw err;
  }
  const tileData = JSON.parse(widgetStates[tileKey]);
  const items = Array.isArray(tileData.items) ? tileData.items : [];
  const products = items.map((item, i) => mapItem(item, i));
  return { count: products.length, products };
}

module.exports = {
  parseProductsFromTileGrid,
  extractRatingAndReviews,
  extractPrice,
  mapItem,
};
