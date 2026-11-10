import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PROJECT_BUDGET_BUILD ? pathToFileURL(resolve(process.env.PROJECT_BUDGET_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { calculateProjectBudget, validateProjectBudgetOptions, projectBudgetSnapshot } = await import(new URL('lib/project-budget.js', root));
const { calculateProject } = await import(new URL('lib/pricing.js', root));
const { calculateCivilProject } = await import(new URL('lib/civil-pricing.js', root));
const { calculateMunicipalProject } = await import(new URL('lib/municipal-pricing.js', root));
const { createCivilElement } = await import(new URL('lib/civil.js', root));
const { createMunicipalElement } = await import(new URL('lib/municipal-design.js', root));
const { addLevel } = await import(new URL('lib/levels.js', root));
const { createMemoryProjectStore, exportProjectJSON, importProjectJSON } = await import(new URL('lib/persistence.js', root));

const fixture = () => ({ version: 1, id: 'complete-project', name: '完整工程预算', drawing: { id: 'drawing', type: 'plan', name: '真实平面', width: 10000, height: 10000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], civilElements: [], municipalElements: [], additionalCost: '11', taxRate: '6', view: { labels: true, drawingOpacity: 1 } });
const region = () => ({ id: 'room', name: '客厅', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], holes: [], hidden: false, additionalCost: '7', items: [{ id: 'tile', materialId: 'tile', materialName: '地砖', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '5' }] });
function threeDisciplines() {
  const p = fixture(); p.regions = [region()];
  p.civilElements = [{ ...createCivilElement('column', { x: 1000, y: 1000 }, p), id: 'column', unitPrice: '1000', laborRate: '100', formworkRate: '10', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '5', additionalCost: '4' }];
  p.municipalElements = [createMunicipalElement('road', [{ x: 2000, y: 1000 }, { x: 3000, y: 1000 }], p, { width: 200, unitPrice: '50', wasteRate: '5', laborRate: '5', additionalCost: '6' })];
  return p;
}

test('跨装修、土建、市政的工程总汇仅计算一次共享固定费与税金', () => {
  const p = threeDisciplines(), before = structuredClone(p), b = calculateProjectBudget(p);
  assert.deepEqual(b.sections.map(s => s.knownSubtotal), ['1572.00', '820.00', '1156.00']);
  assert.deepEqual(b.includedSections, ['decoration', 'civil', 'municipal']);
  assert.equal(b.additionalCost, '11.00'); assert.equal(b.knownSubtotal, '3559.00'); assert.equal(b.tax, '213.54'); assert.equal(b.total, '3772.54');
  assert.equal(b.itemCount, 3); assert.equal(b.status, 'ready'); assert.deepEqual(p, before);
  for (const section of b.sections) { assert.equal(section.quote.projectAdditionalCost, '0.00'); assert.equal(section.quote.taxRate, '0'); }
});

test('总汇不会改变原有专业独立报价', () => {
  const p = threeDisciplines(), before = [calculateProject(p), calculateCivilProject(p), calculateMunicipalProject(p)];
  calculateProjectBudget(p);
  assert.deepEqual([calculateProject(p), calculateCivilProject(p), calculateMunicipalProject(p)], before);
  assert.equal(before[0].total, '1677.98'); assert.equal(before[1].total, '880.86'); assert.equal(before[2].total, '1237.02');
});

test('默认只选有实际计价对象的专业，元数据可以单独设置', () => {
  const p = fixture(); p.regions = [region()]; p.budget = { client: '建设单位', reference: 'A-001', note: '当地采购价' };
  const b = calculateProjectBudget(p); assert.deepEqual(b.includedSections, ['decoration']);
  assert.deepEqual(b.sections.map(s => s.available), [true, false, false]);
  assert.deepEqual(b.metadata, { client: '建设单位', reference: 'A-001', note: '当地采购价' }); assert.equal(b.total, '1677.98');
});

test('明确排除待填价专业后不阻断所选范围的总预算', () => {
  const p = threeDisciplines(); p.civilElements[0].unitPrice = ''; p.budget = { included: { civil: false } };
  const b = calculateProjectBudget(p); assert.equal(b.status, 'ready'); assert.equal(b.total, '2903.34');
  assert.equal(b.sections[1].pending, true); assert.equal(b.sections[1].included, false); assert.ok(b.sections[1].issues.some(i => i.severity === 'pending'));
  assert.ok(b.issues.every(i => i.section !== 'civil')); assert.deepEqual(b.includedSections, ['decoration', 'municipal']);
});

test('取消全部专业时保留原计价数据，状态为空且不显示完整零价', () => {
  const p = threeDisciplines(); p.budget = { included: { decoration: false, civil: false, municipal: false } };
  const before = structuredClone(p), b = calculateProjectBudget(p); assert.equal(b.status, 'empty'); assert.equal(b.total, null); assert.equal(b.itemCount, 0);
  assert.equal(b.beforeTax, null); assert.equal(b.tax, null); assert.equal(b.knownTotal, '11.66'); assert.deepEqual(p, before);
});

test('空白工程即使设定固定费也不能标记报价完成', () => {
  const b = calculateProjectBudget(fixture()); assert.equal(b.status, 'empty'); assert.equal(b.pending, false); assert.equal(b.total, null);
  assert.deepEqual(b.includedSections, []); assert.equal(b.itemCount, 0);
});

test('未校准图纸中真实用量保持待确认，固定金额保留', () => {
  const p = threeDisciplines(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  const b = calculateProjectBudget(p); assert.equal(b.status, 'pending'); assert.equal(b.total, null); assert.equal(b.knownSubtotal, '33.00'); assert.equal(b.knownTax, '1.98');
  assert.equal(b.sections[0].quote.regions[0].netArea, null); assert.equal(b.sections[1].quote.civilElements[0].netVolume, null);
  assert.ok(b.issues.some(i => i.section === 'decoration' && i.targetType === 'region' && i.targetId === 'room'));
  assert.ok(b.pendingReasons.some(reason => /校准/.test(reason)));
});

test('土建缺主材单价时保留真实人工、模板、钢筋金额并定位构件', () => {
  const p = threeDisciplines(); p.civilElements[0].unitPrice = '';
  const b = calculateProjectBudget(p); assert.equal(b.pending, true); assert.equal(b.total, null); assert.equal(b.knownSubtotal, '3079.00');
  const issue = b.issues.find(i => i.section === 'civil' && i.severity === 'pending');
  assert.equal(issue.targetType, 'civil'); assert.equal(issue.targetId, 'column'); assert.match(issue.message, /单价/);
});

test('区域未选材料进入可定位清单，隐藏对象仍保留预算', () => {
  const p = threeDisciplines(); p.regions[0].items = []; p.regions[0].hidden = true;
  const b = calculateProjectBudget(p); assert.equal(b.pending, true); assert.equal(b.itemCount, 3);
  const issue = b.issues.find(i => i.targetType === 'region'); assert.equal(issue.targetId, 'room'); assert.match(issue.message, /选择材料/);
});

test('明确输入零价视为确认报价，不把零价误认待填写', () => {
  const p = fixture(); p.additionalCost = '0'; p.taxRate = '0'; const road = createMunicipalElement('road', [{ x: 2000, y: 1000 }, { x: 3000, y: 1000 }], p, { width: 200, unitPrice: '0' }); p.municipalElements = [road];
  const b = calculateProjectBudget(p); assert.equal(b.status, 'ready'); assert.equal(b.total, '0.00'); assert.equal(b.pendingReasons.length, 0);
});

test('工程总汇的分位舍入不依赖Number，并覆盖超安全整数金额', () => {
  const p = fixture(); p.regions = [region()]; p.regions[0].items[0] = { ...p.regions[0].items[0], quantityMode: 'manual', unit: '件', quantity: '1', unitPrice: '9007199254740993.01', wasteRate: '0', laborRate: '0', additionalCost: '0' };
  p.regions[0].additionalCost = '0'; p.additionalCost = '.005'; p.taxRate = '10';
  const b = calculateProjectBudget(p); assert.equal(b.knownSubtotal, '9007199254740993.02'); assert.equal(b.tax, '900719925474099.30'); assert.equal(b.total, '9907919180215092.32');
});

test('各专业分项先舍入，总汇税金按整体税前额一次舍入', () => {
  const p = fixture(); p.additionalCost = '.005'; p.taxRate = '10';
  p.regions = [region()]; p.regions[0].additionalCost = '0'; p.regions[0].items = [{ ...p.regions[0].items[0], quantityMode: 'manual', unit: '件', quantity: '1', unitPrice: '.045', laborRate: '0', additionalCost: '0', wasteRate: '0' }];
  p.municipalElements = [createMunicipalElement('trafficlight', [{ x: 2000, y: 1000 }], p, { unitPrice: '.045' })];
  const b = calculateProjectBudget(p); assert.equal(b.knownSubtotal, '.11'.replace(/^\./, '0.')); assert.equal(b.tax, '0.01'); assert.equal(b.total, '0.12');
});

test('跨楼层装修和结构仅算活动层一次，保留检查楼层定位', () => {
  let p = threeDisciplines(); p = addLevel(p, { name: '二楼', copyLayout: true });
  const b = calculateProjectBudget(p); assert.equal(b.sections[0].itemCount, 2); assert.equal(b.sections[1].itemCount, 2); assert.equal(b.sections[2].itemCount, 1);
  assert.deepEqual(b.sections.map(s => s.knownSubtotal), ['3144.00', '1640.00', '1156.00']); assert.equal(b.total, '6308.06');
  p.regions[0].items = []; const pending = calculateProjectBudget(p); const issue = pending.issues.find(i => i.targetType === 'region');
  assert.equal(issue.levelId, p.activeLevelId); assert.match(issue.title, /二楼/);
});

test('桥面、实际中间墩和真实侧栏杆完整纳入市政与总预算', () => {
  const p = fixture(); p.additionalCost = '0'; p.taxRate = '0';
  const bridge = createMunicipalElement('bridge', [{ x: 4000, y: 4000 }, { x: 6400, y: 4000 }], p, { width: 1500, unitPrice: '10', bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '1000', railingUnitPrice: '20' } });
  p.municipalElements = [bridge]; const b = calculateProjectBudget(p), row = b.sections[2].quote.municipalElements[0];
  assert.equal(b.total, '6560.00'); assert.deepEqual(row.items.map(item => item.netQuantity), ['360', '2', '48']);
});

test('默认未启用门窗报价不强制加入装修范围', () => {
  const p = fixture(); p.walls = [{ id: 'wall', start: { x: 0, y: 500 }, end: { x: 1000, y: 500 }, thickness: 20, height: 280 }];
  p.openings = [{ id: 'door', wallId: 'wall', kind: 'door', shape: 'rectangle', offset: 100, width: 90, height: 210, bottom: 0, depth: 4 }];
  const b = calculateProjectBudget(p); assert.equal(b.sections[0].available, false); assert.equal(b.status, 'empty');
});

test('项目级房间错误保留检查信息且不会伪造计价对象', () => {
  const p = fixture(); p.regions = [region()]; p.planError = '墙线未闭合';
  const b = calculateProjectBudget(p); assert.equal(b.status, 'pending'); assert.ok(b.issues.some(i => i.targetType === 'project' && i.message === '墙线未闭合'));
});

test('专业默认设置及所有合法部分开关均通过验证', () => {
  assert.doesNotThrow(() => validateProjectBudgetOptions(undefined)); assert.doesNotThrow(() => validateProjectBudgetOptions({}));
  assert.doesNotThrow(() => validateProjectBudgetOptions({ included: {} })); assert.doesNotThrow(() => validateProjectBudgetOptions({ included: { civil: false }, client: '甲方', reference: '项目一', note: '说明\n第二行' }));
});

test('拒绝非法专业开关与非文字/过长/控制字符元数据', () => {
  for (const value of [null, [], 'x', { included: [] }, { included: { civil: 'false' } }, { included: { plumbing: true } }, { extra: true }, { client: 3 }, { reference: 'x'.repeat(121) }, { note: 'x'.repeat(2001) }, { note: 'a\0b' }]) assert.throws(() => validateProjectBudgetOptions(value));
});

test('专业选择和元数据经过保存重开与完整JSON导入保持一致', async () => {
  const p = threeDisciplines(); p.budget = { included: { decoration: false, civil: true }, client: '甲方建设', reference: '预算2026', note: '材料价由用户确认\n施工另计' };
  const store = createMemoryProjectStore(); await store.saveProject(p); const reopened = await store.loadProject(p.id); assert.deepEqual(reopened.budget, p.budget); assert.deepEqual(calculateProjectBudget(reopened), calculateProjectBudget(p));
  const text = await exportProjectJSON(p), imported = await importProjectJSON(text); assert.deepEqual(imported.budget, p.budget); assert.equal(calculateProjectBudget(imported).total, calculateProjectBudget(p).total);
});

test('派生总汇快照不复制专业几何与quote，金额来自原始参数', () => {
  const p = threeDisciplines(), snapshot = projectBudgetSnapshot(p); assert.equal(snapshot.total, '3772.54'); assert.equal(snapshot.sections.length, 3);
  assert.ok(snapshot.sections.every(section => !('quote' in section))); assert.ok(!('issues' in snapshot)); assert.ok(!JSON.stringify(snapshot).includes('points'));
  p.budgetSummary = { total: '999999999.99', sections: [{ quote: '伪造' }] }; assert.equal(calculateProjectBudget(p).total, '3772.54');
});
