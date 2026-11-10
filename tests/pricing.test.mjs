import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProject, calculateRegion, formatMoney, normalizeDecimal } from '../static/studio/lib/pricing.js';
import { createMaterialSnapshot, DEMO_MATERIALS, loadMaterials, saveMaterials } from '../static/studio/lib/materials.js';
import { csvCell, projectToCSV, renderExportHTML } from '../static/studio/lib/export.js';

const rectangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
const hole = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
const item = (overrides = {}) => ({ id: 'i', materialId: 'm', materialName: '材料', unitPrice: '120.00',
  wasteRate: '5', laborRate: '18.00', additionalCost: '10', quantityMode: 'area', quantity: '0', ...overrides });
const project = (overrides = {}) => ({ version: 1, id: 'p', name: '测试工程', drawing: null,
  calibration: { metersPerPixel: 0.1, method: 'line' },
  regions: [{ id: 'r', name: '房间', points: rectangle, holes: [hole], items: [item()], additionalCost: '20' }],
  additionalCost: '30', taxRate: '9', ...overrides });

test('净面积扣洞、采购量含损耗、人工按净用量、三级附加费和税计算准确', () => {
  const result = calculateProject(project());
  assert.equal(result.regions[0].netArea, 96);
  assert.equal(result.regions[0].perimeter, 48);
  assert.equal(result.regions[0].items[0].purchaseQuantity, '100.8');
  assert.equal(result.materialCost, '12096.00');
  assert.equal(result.laborCost, '1728.00');
  assert.equal(result.additionalCost, '60.00');
  assert.equal(result.subtotal, '13884.00');
  assert.equal(result.tax, '1249.56');
  assert.equal(result.total, '15133.56');
});

test('同一区域多个材料项分别支持面积、周长和手工件数', () => {
  const data = project({ additionalCost: '0', taxRate: '0' });
  data.regions[0].additionalCost = '0';
  data.regions[0].items = [item({ unitPrice: '1', laborRate: '0', wasteRate: '0', additionalCost: '0' }),
    item({ id: 'length', quantityMode: 'perimeter', unit: 'm', unitPrice: '8', wasteRate: '10', laborRate: '2', additionalCost: '0' }),
    item({ id: 'pieces', quantityMode: 'manual', unit: '件', quantity: '3', unitPrice: '7.5', wasteRate: '0', laborRate: '1', additionalCost: '0' })];
  const result = calculateProject(data);
  assert.deepEqual(result.regions[0].items.map((line) => line.quantity), ['96', '48', '3']);
  assert.equal(result.regions[0].items[1].purchaseQuantity, '52.8');
  assert.equal(result.regions[0].items[1].laborCost, '96.00');
  assert.equal(result.regions[0].items[2].laborCost, '3.00');
  assert.equal(result.total, '639.90');
});

test('每个金额组件以分 ROUND_HALF_UP 后汇总，避免浮点误差', () => {
  const data = project({ additionalCost: '0.005', taxRate: '10' });
  data.regions[0].additionalCost = '0.005';
  data.regions[0].items = [item({ quantityMode: 'manual', quantity: '3', unitPrice: '0.105', wasteRate: '0', laborRate: '0.005', additionalCost: '0.005' })];
  const result = calculateProject(data);
  assert.equal(result.materialCost, '0.32');
  assert.equal(result.laborCost, '0.02');
  assert.equal(result.subtotal, '0.37');
  assert.equal(result.tax, '0.04');
  assert.equal(result.total, '0.41');
  assert.equal(formatMoney('1.005'), '1.01');
  assert.equal(formatMoney('2.675'), '2.68');
  assert.ok(renderExportHTML(data).includes('¥ 0.105'));
});

test('超过 Number 安全整数范围的金额仍保存完整分位', () => {
  const data = project({ additionalCost: '0', taxRate: '0' });
  data.regions[0].additionalCost = '0';
  data.regions[0].items = [item({ quantityMode: 'manual', quantity: '1', unitPrice: '9007199254740993.01', wasteRate: '0', laborRate: '0', additionalCost: '0' })];
  assert.equal(calculateProject(data).total, '9007199254740993.01');
});

test('未校准的面积或周长计价不能生成假报价，已知附加费仅作为部分金额', () => {
  const data = project({ calibration: { metersPerPixel: null, method: null } });
  const result = calculateProject(data);
  assert.equal(result.pending, true);
  assert.equal(result.total, null);
  assert.equal(result.tax, null);
  assert.equal(result.regions[0].items[0].purchaseQuantity, null);
  assert.equal(result.knownSubtotal, '60.00');
  assert.match(result.pendingReason, /校准/);
  assert.throws(() => projectToCSV(data), /校准/);
  assert.throws(() => renderExportHTML(data), /校准/);
  assert.match(projectToCSV(data, { allowDraft: true }), /工程草稿汇总/);
});

test('有区域未选材和手工数量零均待填写；空项目可以零金额', () => {
  const data = project();
  data.regions[0].items = [];
  assert.match(calculateProject(data).pendingReason, /选择材料/);
  data.regions[0].items = [item({ quantityMode: 'manual', quantity: '0' })];
  assert.match(calculateProject(data).pendingReason, /手工数量/);
  data.regions[0].items[0].quantity = '-1';
  assert.match(calculateProject(data).pendingReason, /手工数量/);
  assert.equal(calculateProject({ ...data, regions: [], additionalCost: '0' }).total, '0.00');
});

test('手工数量无需几何校准，隐藏区域仍包含在报价中', () => {
  const region = { id: 'r', name: '隐藏区', points: rectangle, holes: [], hidden: true,
    items: [item({ quantityMode: 'manual', quantity: '2', unitPrice: '10', wasteRate: '0', laborRate: '0', additionalCost: '0' })], additionalCost: '0' };
  const result = calculateRegion(region, { metersPerPixel: null });
  assert.equal(result.pending, false);
  assert.equal(result.total, '20.00');
  assert.equal(result.netArea, null);
});

test('材料单位与面积或长度依据不匹配时pending，不能沿用错误几何报价', () => {
  const data = project();
  data.regions[0].items[0].unit = '件';
  const mismatched = calculateProject(data);
  assert.equal(mismatched.pending, true);
  assert.equal(mismatched.total, null);
  assert.match(mismatched.pendingReason, /不匹配/);
  data.regions[0].items[0].quantityMode = 'manual';
  data.regions[0].items[0].quantity = '2';
  assert.equal(calculateProject(data).pending, false);
});

test('拒绝负数、NaN、Infinity与可执行表达式', () => {
  for (const invalid of ['-1', 'NaN', 'Infinity', '1+2', '1e100000']) {
    assert.throws(() => normalizeDecimal(invalid));
    const data = project();
    data.regions[0].items[0].unitPrice = invalid;
    assert.throws(() => calculateProject(data));
  }
});

test('材料价格快照不随独立材料库变化，内置示例明确标注并有本地SVG', () => {
  const material = { ...DEMO_MATERIALS[0] };
  const snapshot = createMaterialSnapshot(material, { quantityMode: 'manual', quantity: '1' });
  material.unitPrice = '999';
  const data = project({ additionalCost: '0', taxRate: '0' });
  data.regions[0].additionalCost = '0';
  data.regions[0].items = [snapshot];
  assert.equal(calculateProject(data).total, '126.00');
  assert.ok(DEMO_MATERIALS.every((entry) => entry.demo && entry.image.startsWith('data:image/svg+xml')));
  const cache = new Map();
  const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
  saveMaterials([material], storage);
  assert.equal(loadMaterials(storage)[0].unitPrice, '999');
  assert.equal(snapshot.unitPrice, '120');
});

test('CSV包含区域用量、单价、人工、附加费和税总额，防止公式注入', () => {
  const data = project({ name: '=HYPERLINK("evil")' });
  data.regions[0].name = ' +CMD()';
  const csv = projectToCSV(data);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /采购量（含损耗）/);
  assert.match(csv, /15133\.56/);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("' +CMD()"));
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell('\t=1+1'), '"\'\t=1+1"');
});

test('打印报价HTML转义工程、区域与材料文本，保留真实金额和示例说明', () => {
  const data = project({ name: '<script>alert(1)</script>' });
  data.regions[0].name = '<img src=x onerror=alert(2)>';
  data.regions[0].items[0].materialName = '材料 & <b>名称</b>';
  data.regions[0].items[0].demo = true;
  const html = renderExportHTML(data);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('材料 &amp; &lt;b&gt;名称&lt;/b&gt;'));
  assert.ok(html.includes('15133.56'));
  assert.ok(html.includes('演示价格'));
});
