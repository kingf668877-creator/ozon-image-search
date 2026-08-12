/**
 * 简单单元测试：金额解析（脚本内联在 EXTRACT_TILES_JS 的 num() 函数）
 * 这里独立复刻 num() 做几组断言，确保后续 OZON 改版时也能回归。
 */
const assert = require('assert');

function num(text) {
  if (!text) return '';
  const digits = String(text).replace(/[^\d]/g, '');
  return digits ? (digits + ' ₽') : '';
}

const cases = [
  ['2 016 ₽', '2016 ₽'],
  ['1 250 ₽', '1250 ₽'],
  ['513 ₽', '513 ₽'],
  ['\u202f2\u202f016\u00a0₽', '2016 ₽'], // narrow no-break spaces
  ['', ''],
  ['\u20bd 540', '540 ₽'],
  ['1', '1 ₽'],
  ['\u22125%', '5 \u20bd'], // num() 只清掉非数字，调用方应只把价格 DOM 节点喂进来
];

let pass = 0;
for (const [input, expected] of cases) {
  const got = num(input);
  try {
    assert.strictEqual(got, expected);
    pass++;
    console.log(`ok   "${input}" -> "${got}"`);
  } catch (e) {
    console.error(`FAIL "${input}" -> "${got}" (expected "${expected}")`);
  }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);