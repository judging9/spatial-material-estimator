import test from 'node:test';
import assert from 'node:assert/strict';
import { money, unitPrice } from '../static/studio/ui.js';

test('UI金额保留超出Number安全整数的完整分位和分组', () => {
  assert.equal(money('9007199254740993.01'), '9,007,199,254,740,993.01');
  assert.equal(money('999999999999999999999999.99'), '999,999,999,999,999,999,999,999.99');
});
test('UI按分舍入并保留待计算状态', () => {
  assert.equal(money('0.105'), '0.11');
  assert.equal(money('999.995'), '1,000.00');
  assert.equal(money('0'), '0.00');
  assert.equal(money(null), '—');
  assert.equal(unitPrice('0.105'), '0.105');
  assert.equal(unitPrice('120'), '120.00');
});
