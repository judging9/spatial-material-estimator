import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModulePrices, createCostItem, registerCostValidator, summarize,
  validateCostProject, validateItems,
} from '../build/studio/lib/cost.js';
import { costToCSV, renderCostReport } from '../build/studio/lib/cost-export.js';
import { addDecimal, calculateProject, formatMoney, multiplyDecimal } from '../build/studio/lib/pricing.js';
import {
  createHistory, createMemoryProjectStore, exportProjectJSON, importProjectJSON,
  validateProject,
} from '../build/studio/lib/persistence.js';
import { defaultMunicipalConfig, validateMunicipalState } from '../build/studio/lib/municipal.js';

const item = (id = 1, overrides = {}) => createCostItem({
  id: `item-${id}`, section: '土建', code: String(100000000000 + id),
  name: '混凝土工程', unit: 'm³', quantity: '10', unitPrice: '500', ...overrides,
});
const project = () => ({
  version: 1, id: 'cost-project', name: '综合造价工程', drawing: null,
  calibration: null, regions: [], additionalCost: '0', taxRate: '0',
});
const costProject = () => ({ ...project(), cost: {
  rates: { measureRate: '2.5', taxRate: '9' }, otherCost: '350',
  modules: { municipal: { enabled: true, config: defaultMunicipalConfig(),
    priceOverrides: { 'item-1': '550.25' }, items: [item()] } },
  manualItems: [item(2, { section: '装饰装修', unit: 'm²', quantity: '20', unitPrice: '100' })],
} });

// CSV parsing retains quoted commas, quotes and newlines instead of splitting
// strings in ways that would hide malformed export rows.
function parseCSV(csv) {
  const text = csv.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (character === '\r' && text[index + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; index++;
    } else cell += character;
  }
  assert.equal(quoted, false, 'CSV must close every quoted field');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}

test('cost items calculate real quantities and prices with decimal HALF_UP rounding', () => {
  assert.equal(item().amount, '5000.00');
  assert.equal(item(2, { quantity: '0.333', unitPrice: '1234.56' }).amount, '411.11');
  assert.equal(item(3, { quantity: '1', unitPrice: '0.005' }).amount, '0.01');
  assert.equal(item(4, { quantity: '1', unitPrice: '0.0049' }).amount, '0.00');
  assert.equal(item(5, { quantity: '1', unitPrice: '1.015' }).amount, '1.02');
});

test('pricing decimal helpers preserve integers beyond Number safety and tiny decimals', () => {
  assert.equal(addDecimal('9007199254740993.01', '0.09'), '9007199254740993.1');
  assert.equal(multiplyDecimal('0.000000000000000001', '1000000000000000000'), '1');
  assert.equal(formatMoney(multiplyDecimal('9007199254740993', '0.01')), '90071992547409.93');
  const lines = [item(1, { quantity: '9007199254740993', unitPrice: '0.01' }),
    item(2, { quantity: '1', unitPrice: '0.07' })];
  assert.equal(summarize(lines, { measureRate: '0', taxRate: '0' }).total, '90071992547410.00');
});

test('three sections remain distinct and section base excludes measures and other fees', () => {
  const lines = [item(1, { unitPrice: '100' }),
    item(2, { section: '装饰装修', quantity: '2', unitPrice: '1000' }),
    item(3, { section: '市政', quantity: '3', unitPrice: '1000' }),
    item(4, { section: '土建', category: '措施项目', quantity: '1', unitPrice: '300' }),
    item(5, { section: '装饰装修', category: '其他项目', quantity: '1', unitPrice: '200' })];
  const result = summarize(lines, { measureRate: '0', taxRate: '0' });
  assert.deepEqual(result.bySection, { '土建': '1000.00', '装饰装修': '2000.00', '市政': '3000.00' });
  assert.deepEqual(result.bySectionTotal, { '土建': '1300.00', '装饰装修': '2200.00', '市政': '3000.00' });
  assert.equal(result.subtotal, '6000.00');
  assert.equal(result.total, '6500.00');
});

test('explicit measures and the shared rate are added once and tax is applied once', () => {
  const lines = [item(1, { quantity: '10', unitPrice: '1000' }),
    item(2, { category: '措施项目', quantity: '1', unitPrice: '300' }),
    item(3, { category: '其他项目', quantity: '1', unitPrice: '200' }),
    item(4, { category: '规费税金', quantity: '1', unitPrice: '100' })];
  const result = summarize(lines, { measureRate: '2.5', taxRate: '9', otherAmount: '50' });
  assert.equal(result.rateMeasures, '250.00');
  assert.equal(result.measures, '550.00');
  assert.equal(result.other, '250.00');
  assert.equal(result.fees, '100.00');
  assert.equal(result.beforeTax, '10900.00');
  assert.equal(result.tax, '981.00');
  assert.equal(result.total, '11881.00');
});

test('empty cost lists and explicit zero fee rates have stable totals', () => {
  const empty = summarize([]);
  assert.equal(empty.total, '0.00');
  assert.equal(empty.missingPriceCount, 0);
  assert.equal(empty.estimateCount, 0);
  const taxed = summarize([item(1, { quantity: '1', unitPrice: '10000' })], { measureRate: '0', taxRate: '9' });
  assert.equal(taxed.measures, '0.00');
  assert.equal(taxed.tax, '900.00');
  assert.equal(taxed.total, '10900.00');
});

test('missing prices are flagged without fabricated values and confirmed zero is allowed', () => {
  const missing = item(1, { unitPrice: '0', estimate: true });
  const zeroQuantity = item(2, { quantity: '0', unitPrice: '0' });
  const free = item(3, { unitPrice: '0', priceStatus: 'confirmed' });
  const reference = item(4, { quantity: '1', unitPrice: '12.5' });
  assert.equal(missing.priceStatus, 'missing');
  assert.equal(missing.amount, '0.00');
  const result = summarize([missing, zeroQuantity, free, reference], { measureRate: '0', taxRate: '0' });
  assert.equal(result.missingPriceCount, 1);
  assert.equal(result.referencePriceCount, 1);
  assert.equal(result.estimateCount, 1);
  assert.equal(result.total, '12.50');
});

test('imported zero quantities are normalized before missing-price counting', () => {
  const raw = { ...item(1, { quantity: '0', unitPrice: '0' }), quantity: '0.00' };
  assert.equal(validateItems([raw]).ok, true);
  assert.equal(summarize([raw]).missingPriceCount, 0);
});

test('stable ID price overrides preserve quantity and geometry basis', () => {
  const original = item(1, { unitPrice: '0', basis: '实体几何体积', note: '未定价' });
  const updated = applyModulePrices([original], { priceOverrides: { 'item-1': '125.5', unrelated: '9' } });
  assert.equal(updated[0].unitPrice, '125.5');
  assert.equal(updated[0].amount, '1255.00');
  assert.equal(updated[0].priceStatus, 'confirmed');
  assert.equal(updated[0].quantity, original.quantity);
  assert.equal(updated[0].basis, original.basis);
  assert.match(updated[0].note, /用户确认/);
  assert.equal(original.unitPrice, '0');
  assert.deepEqual(applyModulePrices([original]), [original]);
});

test('invalid numerical values, units, codes and statuses are rejected', () => {
  for (const overrides of [
    { quantity: '-1' }, { quantity: 'NaN' }, { quantity: Infinity }, { unitPrice: '-0.01' },
    { unitPrice: '' }, { unitPrice: '1e100' }, { unit: 'km' }, { unit: '' },
    { id: '' }, { name: '  ' }, { code: '010101' }, { code: 'ABCDEFGHIJKL' },
    { category: 'unknown' }, { section: '园林' }, { priceStatus: 'fake' }, { source: 'fake' },
  ]) assert.throws(() => item(1, overrides), undefined, JSON.stringify(overrides));
  assert.equal(validateItems(null).ok, false);
  assert.equal(validateItems([null]).ok, false);
});

test('duplicate item IDs and project codes cannot reach aggregation', () => {
  const first = item();
  const duplicateId = item(2, { id: first.id });
  const duplicateCode = item(3, { code: first.code });
  assert.equal(validateItems([first, duplicateId]).ok, false);
  assert.equal(validateItems([first, duplicateCode]).ok, false);
  assert.throws(() => summarize([first, duplicateId]), /重复/);
  assert.throws(() => summarize([first, duplicateCode]), /重复/);
});

test('imported line amounts accept one cent discrepancy and reject two cents', () => {
  const original = item();
  assert.equal(validateItems([{ ...original, amount: '5000.01' }]).ok, true);
  assert.equal(validateItems([{ ...original, amount: '4999.99' }]).ok, true);
  assert.equal(validateItems([{ ...original, amount: '5000.02' }]).ok, false);
  assert.equal(validateItems([{ ...original, amount: '4999.98' }]).ok, false);
  const absent = { ...original }; delete absent.amount;
  assert.equal(validateItems([absent]).ok, false);
  assert.equal(summarize([{ ...original, amount: '5000.01' }], { measureRate: '0', taxRate: '0' }).total, '5000.00');
});

test('CSV and PDF normalize accepted one-cent imported amount drift to the same calculated amount', () => {
  const lines = [{ ...item(), amount: '5000.01' }];
  assert.equal(validateItems(lines).ok, true);
  const summary = summarize(lines, { measureRate: '0', taxRate: '0' });
  const csvRows = parseCSV(costToCSV(lines, summary, { name: '精度校验' }));
  assert.equal(csvRows[1][8], '5000.00');
  assert.equal(csvRows.at(-1)[8], '5000.00');
  const html = renderCostReport(lines, summary, { name: '精度校验' });
  assert.ok(html.includes('<td>5000.00</td>'));
  assert.ok(html.includes('¥ 5000.00'));
  assert.ok(!html.includes('5000.01'));
  assert.equal(lines[0].amount, '5000.01', 'export must normalize a copied item without changing source data');
});

test('shared fee rates and project-level extra amounts reject invalid inputs', () => {
  for (const options of [
    { measureRate: '-1' }, { measureRate: '100.1' }, { taxRate: '101' },
    { taxRate: 'NaN' }, { otherAmount: '-5' }, { otherAmount: 'invalid' },
  ]) assert.throws(() => summarize([item()], options));
});

test('CSV contains BOM, CRLF and exactly eleven columns including all seven totals', () => {
  const lines = [item(1), item(2, { section: '市政', unit: 'm', quantity: '100', unitPrice: '0', estimate: true })];
  const summary = summarize(lines);
  const csv = costToCSV(lines, summary, { name: '甲方工程' });
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.endsWith('\r\n'));
  const rows = parseCSV(csv);
  assert.equal(rows.length, lines.length + 1 + 7);
  assert.ok(rows.every(row => row.length === 11));
  assert.deepEqual(rows[0], ['序号', '专业', '项目编码', '项目名称', '项目特征', '计量单位', '工程量', '综合单价(元)', '合价(元)', '是否估算', '备注']);
  assert.equal(rows[1][9], '几何计量');
  assert.equal(rows[2][9], '估算');
  assert.match(rows[2][10], /待填写单价/);
  assert.match(rows[1][10], /参考单价/);
  assert.equal(rows.at(-1)[3], '含税总价');
  assert.equal(rows.at(-1)[8], summary.total);
  assert.equal(rows.at(-1)[4], '甲方工程');
});

test('CSV preserves commas, escaped quotes and embedded newlines without executing formulas', () => {
  const lines = [item(1, { name: '=HYPERLINK("https://example.test","材料")',
    feature: '规格, "进口"\n第二行', note: '@SUM(1,2)' })];
  const csv = costToCSV(lines, summarize(lines), { name: '工程,"一"\n两层' });
  const rows = parseCSV(csv);
  assert.ok(rows.every(row => row.length === 11));
  assert.equal(rows[1][3], '\'=HYPERLINK("https://example.test","材料")');
  assert.equal(rows[1][4], '规格, "进口"\n第二行');
  assert.equal(rows.at(-1)[4], '工程,"一"\n两层');
  const formulaNote = item(2, { note: '-2+3', priceStatus: 'confirmed' });
  assert.equal(parseCSV(costToCSV([formulaNote], summarize([formulaNote]), { name: '测试' }))[1][10], "'-2+3");
});

test('printable reports escape user text and identify estimates, missing and reference prices', () => {
  const lines = [item(1, { name: '<img src=x onerror=alert(1)>', feature: 'A&B', note: '<script>bad()</script>', estimate: true }),
    item(2, { section: '市政', unitPrice: '0' })];
  const summary = summarize(lines);
  const html = renderCostReport(lines, summary, { name: '<甲方> "预算"', date: '2026-11-07' });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(html.includes('A&amp;B'));
  assert.ok(html.includes('&lt;甲方&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>bad()'));
  assert.match(html, /class="badge">估算/);
  assert.match(html, /待填写单价/);
  assert.match(html, /参考单价/);
  assert.match(html, /已定价部分含税小计/);
  assert.ok(html.includes(`¥ ${summary.total}`));
  assert.match(html, /table-header-group/);
  assert.match(html, /size:A4/);
  assert.match(html, /counter\(page\)/);
});

test('legacy projects without cost data preserve the original pricing behavior', async () => {
  const original = project();
  validateCostProject(undefined);
  assert.equal(validateProject(original), original);
  assert.equal(calculateProject(original).total, '0.00');
  const store = createMemoryProjectStore();
  await store.saveProject(original);
  const loaded = await store.loadProject(original.id);
  assert.deepEqual(loaded, original);
  assert.equal('cost' in loaded, false);
  const imported = await importProjectJSON(await exportProjectJSON(original));
  assert.equal('cost' in imported, false);
});

test('new cost configurations, snapshots and price overrides persist as independent copies', async () => {
  const original = costProject();
  const expected = structuredClone(original);
  const store = createMemoryProjectStore();
  await store.saveProject(original);
  original.cost.rates.taxRate = '25';
  original.cost.modules.municipal.priceOverrides['item-1'] = '999';
  original.cost.manualItems[0].quantity = '999';
  const loaded = await store.loadProject(original.id);
  assert.deepEqual(loaded, expected);
  loaded.cost.modules.municipal.config.road.length = 100;
  loaded.cost.modules.municipal.items[0].unitPrice = '5000';
  assert.deepEqual(await store.loadProject(original.id), expected);
});

test('new cost data survives project JSON export and import exactly', async () => {
  const original = costProject();
  const imported = await importProjectJSON(await exportProjectJSON(original));
  assert.deepEqual(imported.cost, original.cost);
  assert.deepEqual(imported.regions, original.regions);
});

test('invalid cost data cannot overwrite a saved project or pass JSON validation', async () => {
  const valid = costProject();
  const store = createMemoryProjectStore();
  await store.saveProject(valid);
  const changes = [
    data => { data.cost = null; },
    data => { data.cost = []; },
    data => { data.cost.rates.taxRate = '-1'; },
    data => { data.cost.rates.measureRate = '101'; },
    data => { data.cost.otherCost = 'NaN'; },
    data => { data.cost.otherCost = '-1'; },
    data => { data.cost.manualItems[0].quantity = '-2'; },
    data => { data.cost.manualItems.push(structuredClone(data.cost.manualItems[0])); },
    data => { data.cost.modules = []; },
    data => { data.cost.modules.unknown = {}; },
    data => { data.cost.modules.municipal = null; },
    data => { data.cost.modules.municipal.enabled = 'true'; },
    data => { data.cost.modules.municipal.priceOverrides['item-1'] = '-1'; },
    data => { data.cost.modules.municipal.items[0].amount = '1'; },
  ];
  for (const change of changes) {
    const bad = structuredClone(valid); change(bad);
    assert.throws(() => store.saveProject(bad));
    await assert.rejects(exportProjectJSON(bad));
    await assert.rejects(importProjectJSON(JSON.stringify(bad)));
    assert.deepEqual(await store.loadProject(valid.id), valid);
  }
});

test('cost validation refuses unsafe fields, nonfinite nested values and excessive depth', () => {
  assert.throws(() => validateCostProject(JSON.parse('{"modules":{"municipal":{"config":{"__proto__":{"x":1}}}}}')), /不安全/);
  assert.throws(() => validateCostProject({ modules: { municipal: { config: { x: Infinity } } } }), /有限/);
  let nested = {};
  for (let index = 0; index < 25; index++) nested = { child: nested };
  assert.throws(() => validateCostProject({ nested }), /过深/);
});

test('optional cost fields must have their declared shape when supplied', () => {
  for (const invalid of [
    { rates: false }, { rates: null }, { manualItems: false }, { manualItems: null },
    { modules: { municipal: { items: false } } },
    { modules: { municipal: { items: null } } },
    { modules: { municipal: { priceOverrides: '10' } } },
    { modules: { municipal: { priceOverrides: [] } } },
    { modules: { municipal: { modelGenerated: 'true' } } },
  ]) assert.throws(() => validateCostProject(invalid), undefined, JSON.stringify(invalid));
});

test('registered professional validators run through save and import paths', async () => {
  registerCostValidator('municipal', validateMunicipalState);
  const valid = costProject();
  const store = createMemoryProjectStore();
  await store.saveProject(valid);
  const bad = structuredClone(valid);
  bad.cost.modules.municipal.config.road.length = -1;
  assert.throws(() => store.saveProject(bad));
  await assert.rejects(importProjectJSON(JSON.stringify(bad)));
  assert.deepEqual(await store.loadProject(valid.id), valid);
});

test('history replace updates derived snapshots without adding a user undo step', () => {
  const initial = costProject();
  const history = createHistory(initial);
  const edited = structuredClone(initial); edited.cost.otherCost = '400';
  history.push(edited);
  const derived = history.current(); derived.cost.modules.municipal.model = { totalLength: 120 };
  history.replace(derived);
  derived.cost.modules.municipal.model.totalLength = 999;
  assert.equal(history.length, 2);
  assert.equal(history.current().cost.modules.municipal.model.totalLength, 120);
  assert.deepEqual(history.undo(), initial);
  assert.equal(history.redo().cost.modules.municipal.model.totalLength, 120);
  assert.equal(history.current().cost.otherCost, '400');
});

test('history replace after undo preserves redo and a later edit still branches correctly', () => {
  const initial = project();
  const history = createHistory(initial);
  history.push({ ...initial, name: '第一项编辑' });
  history.push({ ...initial, name: '第二项编辑' });
  history.undo();
  const derived = history.current(); derived.cost = { otherCost: '100' };
  history.replace(derived);
  assert.equal(history.length, 3);
  assert.equal(history.canRedo(), true);
  assert.equal(history.redo().name, '第二项编辑');
  assert.deepEqual(history.undo().cost, { otherCost: '100' });
  history.push({ ...history.current(), name: '新分支' });
  assert.equal(history.canRedo(), false);
  assert.equal(history.undo().name, '第一项编辑');
});
