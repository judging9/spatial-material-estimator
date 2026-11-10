import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProjectPriceRows, applyProjectPriceChanges, previewProjectPriceChanges } from '../static/studio/lib/project-price-edit.js';
import { calculateProjectBudget } from '../static/studio/lib/project-budget.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { createCivilElement } from '../static/studio/lib/civil.js';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createEarthworkBalance } from '../static/studio/lib/earthwork-balance.js';
import { makeCircle, makeArc } from '../static/studio/lib/drawing-shapes.js';
import { createServiceRoute } from '../static/studio/lib/services.js';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';
import { budgetFixture } from './project-budget-fixture.mjs';

const rectangle = (x, y, width, depth) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
const material = (id = 'tile', patch = {}) => ({ id, materialId: id, materialName: '用户地砖', color: '#8e9c96', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '5', ...patch });
const room = (patch = {}) => ({ id: 'room', name: '客厅', points: rectangle(100, 100, 400, 300), holes: [], hidden: false, items: [material()], additionalCost: '7', ...patch });
const fixture = (patch = {}) => ({ version: 1, id: 'project-price-edit', name: '用户工程', workspaceMode: 'plan', drawing: { id: 'plan', type: 'plan', name: '实际画板', width: 6000, height: 6000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, walls: [], regions: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, ...patch });
function rowFor(project, predicate) {
  const row = collectProjectPriceRows(project).find(predicate);
  assert.ok(row, '必须找到实际源计价行');
  return row;
}
const changeFor = (project, predicate, values) => ({ rowId: rowFor(project, predicate).id, values });

function roadway() {
  const p = fixture({ workspaceMode: 'municipal' });
  p.municipalTerrain = { name: '实际平地', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 60, y: 0, z: 0 }, { id: 'c', x: 60, y: 60, z: 0 }, { id: 'd', x: 0, y: 60, z: 0 }] };
  const road = createMunicipalElement('road', [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }], p), balance = createEarthworkBalance();
  Object.assign(balance, { enabled: true, usableCutPercent: '60', naturalPerCompactedFill: '1.1', loosePerNatural: '1.2', borrowMaterial: { enabled: true, unitPrice: '40' }, reuseHaul: { enabled: true, distanceKm: '.2', unitPrice: '3' }, borrowHaul: { enabled: true, distanceKm: '5', unitPrice: '2' }, spoilHaul: { enabled: true, distanceKm: '10', unitPrice: '1.5' } });
  Object.assign(road, { id: 'road', width: 200, height: 10, unitPrice: '0', laborRate: '0', wasteRate: '0', additionalCost: '0', roadProfile: { enabled: true, points: [{ id: 'start', station: 0, elevation: -.9 }, { id: 'end', station: 10, elevation: 1.1 }], sampleInterval: 1, curveTolerance: .002, earthwork: { enabled: false, cutUnitPrice: '', fillUnitPrice: '' }, earthworkBalance: balance } });
  p.municipalElements = [road]; return p;
}
function transferFixture() {
  const p = roadway(); p.municipalElements = [];
  for (const [id, y, elevation, usable, loose] of [['s', 500, -.9, '60', '1.25'], ['a', 1500, .5, '100', '1.2'], ['b', 2500, .6, '100', '1.1']]) {
    const road = createMunicipalElement('road', [{ x: 500, y }, { x: 1500, y }], p), balance = createEarthworkBalance();
    Object.assign(balance, { enabled: true, usableCutPercent: usable, naturalPerCompactedFill: '1', loosePerNatural: loose });
    if (id === 's') balance.spoilHaul = { enabled: true, distanceKm: '3', unitPrice: '2' };
    if (id === 'a') { balance.borrowMaterial = { enabled: true, unitPrice: '10' }; balance.borrowHaul = { enabled: true, distanceKm: '5', unitPrice: '1' }; }
    if (id === 'b') { balance.borrowMaterial = { enabled: true, unitPrice: '12' }; balance.borrowHaul = { enabled: true, distanceKm: '4', unitPrice: '1' }; }
    Object.assign(road, { id, name: '道路 ' + id, width: 200, height: 10, unitPrice: '0', wasteRate: '0', laborRate: '0', additionalCost: '0', quantity: '1', roadProfile: { enabled: true, points: [{ id: id + '-start', station: 0, elevation }, { id: id + '-end', station: 10, elevation }], sampleInterval: 1, earthwork: { enabled: false, cutUnitPrice: '', fillUnitPrice: '' }, earthworkBalance: balance } });
    p.municipalElements.push(road);
  }
  p.municipalEarthworkTransfer = { enabled: true, roadIds: ['s', 'a', 'b'], routes: [{ id: 'sa', fromRoadId: 's', toRoadId: 'a', enabled: true, distanceKm: '2', unitPrice: '1' }, { id: 'sb', fromRoadId: 's', toRoadId: 'b', enabled: true, distanceKm: '1', unitPrice: '1' }] };
  return p;
}

test('收集真实汇入专业，空项目不生成示例计价行', () => {
  const p = budgetFixture(), before = structuredClone(p), rows = collectProjectPriceRows(p);
  assert.equal(rows.length, 8); assert.deepEqual(new Set(rows.map(row => row.section)), new Set(['decoration', 'civil', 'municipal']));
  assert.ok(rows.every(row => row.editableFields.includes('unitPrice'))); assert.equal(calculateProjectBudget(p).total, '3775.76');
  assert.match(rows.find(row => row.targetType === 'furniture' && row.levelId === p.activeLevelId).spec, /^沙发 · /);
  assert.match(rows.find(row => row.targetType === 'furniture' && row.levelId !== p.activeLevelId).spec, /^床 · /);
  assert.ok(rows.filter(row => row.targetType === 'civil').every(row => !/padFooting|column/.test(row.spec)));
  assert.ok(rows.filter(row => row.targetType === 'municipal').every(row => !/road/.test(row.spec)));
  assert.deepEqual(p, before); assert.deepEqual(collectProjectPriceRows(fixture()), []);
  p.budget.included.civil = false; assert.ok(collectProjectPriceRows(p).every(row => row.section !== 'civil'));
});

test('一次补齐非活动楼层家具缺价，保持活动楼层和原数据不变', () => {
  const p = budgetFixture({ pending: true }), before = structuredClone(p), missing = rowFor(p, row => row.targetType === 'furniture' && row.pending);
  assert.notEqual(missing.levelId, p.activeLevelId); assert.equal(missing.values.unitPrice, '');
  const preview = previewProjectPriceChanges(p, [{ rowId: missing.id, values: { unitPrice: '150' }, expected: { unitPrice: '' } }]);
  assert.equal(preview.before.status, 'pending'); assert.equal(preview.before.total, null); assert.equal(preview.after.total, '3775.76'); assert.equal(preview.changedRows, 1);
  assert.equal(preview.project.activeLevelId, p.activeLevelId); assert.equal(preview.project.levels.find(level => level.id === missing.levelId).content.furniture[0].unitPrice, '150');
  assert.deepEqual(p, before); assert.equal(preview.changes[0].before.unitPrice, ''); assert.equal(preview.changes[0].after.unitPrice, '150');
});

test('跨楼层同名和同材料分项 ID 按楼层与对象寻址，不覆盖另一楼层', () => {
  const p = budgetFixture(), active = p.regions[0], inactive = p.levels.find(level => level.id !== p.activeLevelId);
  inactive.content.regions[0].name = active.name; inactive.content.regions[0].items[0].id = active.items[0].id;
  const rows = collectProjectPriceRows(p).filter(row => row.targetType === 'region' && row.objectName === active.name);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  const chosen = rows.find(row => row.levelId === inactive.id), next = applyProjectPriceChanges(p, [{ rowId: chosen.id, values: { unitPrice: '99' } }]);
  assert.equal(next.regions[0].items[0].unitPrice, '100'); assert.equal(next.levels.find(level => level.id === inactive.id).content.regions[0].items[0].unitPrice, '99');
});

test('非法跨楼层重复对象 ID 在批量报价前拒绝，不能绕过工程编号约束', () => {
  const p = budgetFixture(), selected = rowFor(p, row => row.targetType === 'region');
  p.levels.find(level => level.id !== p.activeLevelId).content.regions[0].id = p.regions[0].id;
  const before = structuredClone(p);
  assert.throws(() => collectProjectPriceRows(p));
  assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '99' } }]));
  assert.deepEqual(p, before);
});

test('多专业多行批次只变价格参数，几何、用量、固定费和专业开关保持一致', () => {
  const p = budgetFixture(), before = structuredClone(p), rows = collectProjectPriceRows(p);
  const changes = [changeFor(p, row => row.targetType === 'region' && row.levelId === p.activeLevelId, { unitPrice: '110', wasteRate: '5', laborRate: '30' }), changeFor(p, row => row.targetType === 'civil' && row.levelId !== p.activeLevelId, { unitPrice: '250' }), changeFor(p, row => row.section === 'municipal', { laborRate: '3' })];
  const preview = previewProjectPriceChanges(p, changes); assert.equal(preview.changedRows, 3); assert.ok(preview.after.total !== preview.before.total);
  assert.deepEqual(preview.project.regions[0].points, p.regions[0].points); assert.deepEqual(preview.project.regions[0].holes, p.regions[0].holes); assert.deepEqual(preview.project.municipalElements[0].points, p.municipalElements[0].points);
  assert.equal(preview.project.additionalCost, p.additionalCost); assert.deepEqual(preview.project.budget, p.budget); assert.deepEqual(p, before);
  for (const row of rows) { const updated = rowFor(preview.project, next => next.id === row.id); assert.equal(updated.netQuantity, row.netQuantity); }
});

test('损耗采购量、净量人工、固定费与税精确重算', () => {
  const p = fixture({ regions: [room()], additionalCost: '11', taxRate: '6' });
  const preview = previewProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '100.105', wasteRate: '7', laborRate: '20.015' })]);
  const line = preview.after.sections[0].quote.regions[0].items[0];
  assert.equal(line.netQuantity, '12'); assert.equal(line.purchaseQuantity, '12.84'); assert.equal(line.materialCost, '1285.35'); assert.equal(line.laborCost, '240.18'); assert.equal(line.additionalCost, '5.00');
  assert.equal(preview.after.knownSubtotal, '1548.53'); assert.equal(preview.after.tax, '92.91'); assert.equal(preview.after.total, '1641.44');
});

test('清空普通材料单价进入待报价且保留实际量、已知人工和固定费', () => {
  const p = fixture({ regions: [room()], additionalCost: '11', taxRate: '6' });
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '' })]), budget = calculateProjectBudget(next), row = rowFor(next, row => row.targetType === 'region');
  assert.equal(budget.status, 'pending'); assert.equal(budget.total, null); assert.equal(budget.knownSubtotal, '263.00'); assert.equal(budget.knownTotal, '278.78');
  assert.equal(row.pending, true); assert.match(row.pendingReasons.join('；'), /单价/); assert.equal(row.netQuantity, '12'); assert.equal(row.purchaseQuantity, '13.2'); assert.equal(row.knownTotal, '245.00');
  assert.equal(next.regions[0].items[0].unitPrice, '');
});

test('未校准项目补价不会制造面积或完成总价', () => {
  const p = fixture({ drawing: { ...fixture().drawing, type: 'image' }, calibration: { metersPerPixel: null }, regions: [room({ items: [material('tile', { unitPrice: '' })] })] });
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '90' })]), row = collectProjectPriceRows(next)[0];
  assert.equal(row.pending, true); assert.equal(row.netQuantity, null); assert.equal(row.purchaseQuantity, null); assert.equal(calculateProjectBudget(next).total, null); assert.equal(row.knownTotal, '5.00');
});

test('明确零价有效；规格化相同值属于 no-op 且不修改价格来源', () => {
  const p = fixture({ regions: [room()] }); p.regions[0].items[0].provenance = { source: '供应商报价', priceDate: '2026-11-08', supplier: '实际供应商' };
  const original = structuredClone(p.regions[0].items[0]), noOp = previewProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '100.00', wasteRate: '10.000' })]);
  assert.equal(noOp.changedRows, 0); assert.deepEqual(noOp.project.regions[0].items[0], original);
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '0' })]);
  assert.equal(rowFor(next, row => row.targetType === 'region').pending, false); assert.equal(calculateProjectBudget(next).total, '252.00');
});

test('用户改价清理旧供应商日期链接但保留规格地区及 Demo 标识', () => {
  const p = fixture({ regions: [room()] }); p.regions[0].items[0].demo = true;
  p.regions[0].items[0].provenance = { source: '当地供应商', spec: '600 × 600', region: '上海', supplier: '某供应商', priceDate: '2026-10-01', url: 'https://example.org/quote' };
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '95' })]), item = next.regions[0].items[0], row = collectProjectPriceRows(next)[0];
  assert.deepEqual(item.provenance, { source: '用户调整单价', spec: '600 × 600', region: '上海' }); assert.equal(item.demo, true); assert.match(row.sourceNote, /Demo/); assert.match(row.sourceNote, /用户调整单价/); assert.equal(row.spec, '600 × 600');
});

test('只调整损耗和人工时材料报价来源不变', () => {
  const p = fixture({ regions: [room()] }); p.regions[0].items[0].provenance = { source: '业主确认', region: '杭州', priceDate: '2026-11-01' };
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { wasteRate: '8', laborRate: '30' })]);
  assert.deepEqual(next.regions[0].items[0].provenance, p.regions[0].items[0].provenance);
});

test('吊顶材料独立寻址，未启用吊顶不会被批量补价开启', () => {
  const p = fixture({ regions: [room()] }); p.regions[0].ceiling = { enabled: true, items: [material('ceiling', { unitPrice: '12', wasteRate: '0', laborRate: '2', additionalCost: '0' })], additionalCost: '3' };
  const selected = rowFor(p, row => row.targetType === 'ceiling'), next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '15' } }]);
  assert.equal(next.regions[0].ceiling.items[0].unitPrice, '15'); assert.equal(next.regions[0].items[0].unitPrice, '100'); assert.equal(next.regions[0].ceiling.additionalCost, '3');
  p.regions[0].ceiling.enabled = false; assert.ok(collectProjectPriceRows(p).every(row => row.targetType !== 'ceiling')); assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '18' } }]));
});

test('直墙材料调整不会改变饰面侧及实际墙面量', () => {
  const p = fixture({ walls: [{ id: 'wall', name: '左墙', start: { x: 100, y: 100 }, end: { x: 600, y: 100 }, thickness: 20, height: 280, finishSide: 'left', items: [material('finish', { unitPrice: '8', additionalCost: '0' })], additionalCost: '2' }] });
  const selected = rowFor(p, row => row.targetType === 'wall'), next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '12', laborRate: '4' } }]);
  assert.equal(next.walls[0].items[0].unitPrice, '12'); assert.equal(next.walls[0].finishSide, 'left'); assert.equal(rowFor(next, row => row.id === selected.id).netQuantity, selected.netQuantity); assert.deepEqual(next.walls[0].start, p.walls[0].start);
});

for (const kind of ['circle', 'arc']) test(`真实${kind === 'circle' ? '圆墙' : '弧墙'}组修改价格只写组源，不写分段墙`, () => {
  const geometry = kind === 'circle' ? makeCircle({ x: 1000, y: 1000 }, 200) : makeArc({ x: 1000, y: 1000 }, 200, 0, 90), p = fixture();
  p.walls = geometry.points.slice(0, geometry.closed ? undefined : -1).map((point, index) => ({ id: 'w' + index, start: { ...point }, end: { ...geometry.points[(index + 1) % geometry.points.length] }, thickness: 20, height: 280, items: [], additionalCost: '0' }));
  p.wallShapes = [{ id: 'curve', kind: geometry.kind, name: '弧形墙饰面', wallIds: p.walls.map(wall => wall.id), center: geometry.center, radius: geometry.radius, startDegrees: geometry.startDegrees, sweepDegrees: geometry.sweepDegrees, maxDeviation: geometry.maxDeviation, finishSide: 'left', items: [material('curve-finish')], additionalCost: '0' }];
  const selected = rowFor(p, row => row.targetId === 'curve'), next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '42' } }]);
  assert.equal(next.wallShapes[0].items[0].unitPrice, '42'); assert.deepEqual(next.walls, p.walls); assert.equal(collectProjectPriceRows(next).length, 1); assert.equal(rowFor(next, row => row.id === selected.id).netQuantity, selected.netQuantity);
});

test('室内管线按真实三维路径与用户预留量计价，数量参数保持原值', () => {
  const route = { ...createServiceRoute('bv25', [{ x: 0, y: 0, z: 0 }, { x: 300, y: 400, z: 1200 }]), id: 'electric', unitPrice: '', runs: '2', extraLength: '1.5', additionalCost: '3' }, p = fixture({ serviceRoutes: [route] });
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'service', { unitPrice: '2.105', wasteRate: '10', laborRate: '1.005' })]), priced = calculateProject(next).serviceRoutes[0];
  assert.equal(priced.netQuantity, '29'); assert.equal(priced.purchaseQuantity, '31.9'); assert.equal(priced.materialCost, '67.15'); assert.equal(priced.laborCost, '29.15'); assert.equal(priced.total, '99.30');
  assert.deepEqual(next.serviceRoutes[0].points, route.points); assert.equal(next.serviceRoutes[0].runs, '2'); assert.equal(next.serviceRoutes[0].extraLength, '1.5');
});

test('家具只支持单价，手工件数和附加费不随材料费用改变', () => {
  const p = budgetFixture(), selected = rowFor(p, row => row.targetType === 'furniture' && row.levelId === p.activeLevelId);
  assert.deepEqual(selected.editableFields, ['unitPrice']); assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { wasteRate: '5' } }]));
  const next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '200' } }]);
  assert.equal(next.furniture[0].quantity, '1'); assert.equal(next.furniture[0].additionalCost, '10'); assert.equal(rowFor(next, row => row.id === selected.id).knownTotal, '210.00');
});

test('启用门窗报价写 quote 参数，关闭项不被开启且墙面扣孔量不变', () => {
  const p = fixture({ walls: [{ id: 'wall', start: { x: 100, y: 100 }, end: { x: 900, y: 100 }, thickness: 20, height: 300 }], openings: [{ id: 'door', wallId: 'wall', kind: 'door', shape: 'rectangle', offset: 100, width: 90, height: 210, bottom: 0, depth: 4, quote: { enabled: true, unit: '件', quantity: '2', unitPrice: '', wasteRate: '0', laborRate: '5', additionalCost: '3' } }] });
  const selected = rowFor(p, row => row.targetType === 'opening'), beforeArea = calculateProject(p).walls[0].netArea;
  assert.match(selected.spec, /^门 · 矩形 · /);
  const next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '100', wasteRate: '10', laborRate: '8' } }]);
  assert.equal(next.openings[0].quote.unitPrice, '100'); assert.equal(next.openings[0].quote.quantity, '2'); assert.equal(calculateProject(next).openings[0].total, '239.00'); assert.equal(calculateProject(next).walls[0].netArea, beforeArea);
  p.openings[0].quote.enabled = false; assert.deepEqual(collectProjectPriceRows(p), []); assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '1' } }]));
});

test('土建主材、模板、钢筋各写原价格字段，不改变构件尺寸及指标', () => {
  const p = fixture(), column = { ...createCivilElement('column', { x: 1000, y: 1000 }, p), id: 'column', unitPrice: '100', laborRate: '10', formworkRate: '3', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '' }; p.civilElements = [column];
  const rows = collectProjectPriceRows(p); assert.equal(rows.length, 3);
  const changes = rows.map(row => ({ rowId: row.id, values: { unitPrice: row.itemId.endsWith(':material') ? '200' : row.itemId.endsWith(':formwork') ? '4' : '5' } }));
  const next = applyProjectPriceChanges(p, changes), quote = calculateProjectBudget(next);
  assert.equal(next.civilElements[0].unitPrice, '200'); assert.equal(next.civilElements[0].formworkRate, '4'); assert.equal(next.civilElements[0].rebarPrice, '5'); assert.equal(next.civilElements[0].rebarRatio, '100'); assert.equal(quote.status, 'ready');
  assert.equal(quote.total, '360.00'); assert.deepEqual(next.civilElements[0].position, column.position); assert.equal(next.civilElements[0].height, column.height);
});

test('模板清空会关闭计价，因此批量清空拒绝而明确零单价保留计价项', () => {
  const p = fixture(); p.civilElements = [{ ...createCivilElement('column', { x: 1000, y: 1000 }, p), id: 'column', unitPrice: '0', formworkRate: '3' }];
  const selected = rowFor(p, row => row.itemId.endsWith(':formwork')); assert.deepEqual(selected.editableFields, ['unitPrice']);
  assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '' } }]), /模板/);
  assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { laborRate: '1' } }]));
  const next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '0' } }]); assert.equal(next.civilElements[0].formworkRate, '0'); assert.ok(collectProjectPriceRows(next).some(row => row.itemId.endsWith(':formwork')));
  p.civilElements[0].formworkRate = ''; assert.ok(collectProjectPriceRows(p).every(row => !row.itemId.endsWith(':formwork'))); assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '3' } }]));
});

test('市政主项和结构层各自调价，层厚及预算份数不改', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], p, { width: 200, unitPrice: '10' });
  road.id = 'road'; road.items = [{ id: 'base', name: '基层', materialId: 'base', materialName: '基层', unit: 'm³', thickness: 20, unitPrice: '20', wasteRate: '0', laborRate: '0', additionalCost: '2' }]; p.municipalElements = [road];
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.itemId === 'road:main', { unitPrice: '12', wasteRate: '5', laborRate: '2' }), changeFor(p, row => row.itemId === 'base', { unitPrice: '30', laborRate: '3' })]);
  assert.equal(next.municipalElements[0].unitPrice, '12'); assert.equal(next.municipalElements[0].items[0].unitPrice, '30'); assert.equal(next.municipalElements[0].items[0].thickness, 20); assert.equal(next.municipalElements[0].items[0].additionalCost, '2'); assert.equal(next.municipalElements[0].quantity, road.quantity);
  assert.equal(calculateProjectBudget(next).total, '426.00');
});

test('桥墩和侧栏杆价格修改保留实际数量，未勾选部分不加入补价', () => {
  const p = fixture(), bridge = createMunicipalElement('bridge', [{ x: 1000, y: 1000 }, { x: 3400, y: 1000 }], p, { width: 1500, unitPrice: '10', bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '1000', railingUnitPrice: '20' } }); bridge.id = 'bridge'; p.municipalElements = [bridge];
  const rows = collectProjectPriceRows(p), piers = rows.find(row => row.itemId.endsWith(':piers')), railings = rows.find(row => row.itemId.endsWith(':railings')); assert.ok(piers); assert.ok(railings);
  const next = applyProjectPriceChanges(p, [{ rowId: piers.id, values: { unitPrice: '900' } }, { rowId: railings.id, values: { unitPrice: '25' } }]);
  assert.equal(next.municipalElements[0].bridgeOptions.pierUnitPrice, '900'); assert.equal(next.municipalElements[0].bridgeOptions.railingUnitPrice, '25'); assert.equal(calculateProjectBudget(next).total, '6600.00');
  assert.equal(rowFor(next, row => row.id === piers.id).netQuantity, '2'); assert.equal(rowFor(next, row => row.id === railings.id).netQuantity, '48');
  p.municipalElements[0].bridgeOptions.railingPricingEnabled = false; assert.throws(() => applyProjectPriceChanges(p, [{ rowId: railings.id, values: { unitPrice: '1' } }]));
});

test('道路挖填及四类借弃调配价格映射原配置，工程量系数运距不变', () => {
  const p = roadway(); p.municipalElements[0].roadProfile.earthwork = { enabled: true, cutUnitPrice: '2', fillUnitPrice: '3' };
  const rates = new Map([['road:cutVolume', '4'], ['road:fillVolume', '5']]);
  const changes = collectProjectPriceRows(p).filter(row => !row.itemId.endsWith(':main')).map(row => ({ rowId: row.id, values: { unitPrice: rates.get(row.itemId) ?? '2' } }));
  assert.equal(changes.length, 6); const next = applyProjectPriceChanges(p, changes), profile = next.municipalElements[0].roadProfile;
  assert.equal(profile.earthwork.cutUnitPrice, '4'); assert.equal(profile.earthwork.fillUnitPrice, '5');
  for (const key of ['borrowMaterial', 'reuseHaul', 'borrowHaul', 'spoilHaul']) assert.equal(profile.earthworkBalance[key].unitPrice, '2');
  assert.equal(profile.earthworkBalance.borrowHaul.distanceKm, '5'); assert.equal(profile.earthworkBalance.usableCutPercent, '60'); assert.deepEqual(profile.points, p.municipalElements[0].roadProfile.points); assert.equal(calculateProjectBudget(next).total, '129.44');
});

test('跨道路运输改价重新优化调配用量，源道路几何和旧项目不变', () => {
  const p = transferFixture(), before = structuredClone(p), selected = rowFor(p, row => row.itemId.includes('sb') && row.name.includes('运输'));
  const preview = previewProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '3' } }]);
  assert.equal(preview.before.total, '173.50'); assert.equal(preview.after.total, '193.40'); assert.deepEqual(preview.after.sections[2].quote.earthworkTransfer.routes.map(route => route.naturalQuantity), ['8', '4']);
  assert.equal(preview.project.municipalEarthworkTransfer.routes[1].unitPrice, '3'); assert.deepEqual(preview.project.municipalElements, p.municipalElements); assert.deepEqual(p, before);
});

test('特殊真实零借量空价不误判缺价，补价不改变既有守恒量', () => {
  const p = roadway(), balance = p.municipalElements[0].roadProfile.earthworkBalance;
  Object.assign(balance, { usableCutPercent: '100', naturalPerCompactedFill: '1' }); balance.borrowMaterial.unitPrice = ''; balance.borrowHaul.unitPrice = ''; balance.borrowHaul.distanceKm = ''; balance.spoilHaul.unitPrice = ''; balance.spoilHaul.distanceKm = '';
  const selected = rowFor(p, row => row.itemId.includes('borrow-material')); assert.equal(selected.values.unitPrice, ''); assert.equal(selected.netQuantity, '0'); assert.equal(selected.pending, false);
  const next = applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '50' } }]); assert.equal(rowFor(next, row => row.id === selected.id).knownTotal, '0.00'); assert.equal(calculateProjectBudget(next).total, '3.60');
});

test('旧材料未显式写价格参数时使用引擎合法零默认值', () => {
  const item = material(); delete item.unitPrice; delete item.wasteRate; delete item.laborRate;
  const p = fixture({ regions: [room({ items: [item] })] }), selected = collectProjectPriceRows(p)[0];
  assert.deepEqual(selected.values, { unitPrice: '0', wasteRate: '0', laborRate: '0' }); assert.equal(selected.pending, false);
  assert.equal(previewProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: '0' } }]).changedRows, 0);
});

test('非法行、排除专业、重复行与非法字段整批拒绝且原工程不变', () => {
  const p = budgetFixture(), before = structuredClone(p), selected = rowFor(p, row => row.targetType === 'region'), valid = { rowId: selected.id, values: { unitPrice: '120' } };
  const invalidBatches = [[valid, { rowId: 'unknown', values: { unitPrice: '2' } }], [valid, valid], [valid, { rowId: collectProjectPriceRows(p).find(row => row.targetType === 'furniture').id, values: { laborRate: '3' } }], [{ rowId: selected.id, values: { quantity: '2' } }], [{ rowId: selected.id, values: null }], [{ rowId: selected.id, values: [] }], [null], 'not-an-array'];
  for (const batch of invalidBatches) { assert.throws(() => applyProjectPriceChanges(p, batch)); assert.deepEqual(p, before); }
  const excluded = structuredClone(p), civil = rowFor(p, row => row.section === 'civil'); excluded.budget.included.civil = false;
  assert.throws(() => applyProjectPriceChanges(excluded, [{ rowId: civil.id, values: { unitPrice: '100' } }])); assert.equal(excluded.budget.included.civil, false);
});

test('负数、NaN、Infinity、非字符串及空人工损耗拒绝，不会覆盖已知价格', () => {
  const p = fixture({ regions: [room()] }), before = structuredClone(p), selected = collectProjectPriceRows(p)[0];
  for (const value of ['-1', 'NaN', 'Infinity', '-Infinity', '1e31', 'text', 5, null, {}, []]) { assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { unitPrice: value } }])); assert.deepEqual(p, before); }
  for (const field of ['wasteRate', 'laborRate']) for (const value of ['', ' ', '-0.1']) assert.throws(() => applyProjectPriceChanges(p, [{ rowId: selected.id, values: { [field]: value } }]));
});

test('expected 检测已变动价格，冲突拒绝整批并保留最新工程', () => {
  const p = budgetFixture(), rows = collectProjectPriceRows(p), before = structuredClone(p);
  assert.throws(() => applyProjectPriceChanges(p, [{ rowId: rows[0].id, values: { unitPrice: '200' }, expected: { unitPrice: rows[0].values.unitPrice } }, { rowId: rows[1].id, values: { unitPrice: '200' }, expected: { unitPrice: '999' } }]), /其他操作修改/);
  assert.deepEqual(p, before);
  assert.throws(() => applyProjectPriceChanges(p, [{ rowId: rows[0].id, values: { unitPrice: '90' }, expected: { quantity: '1' } }]));
  const next = applyProjectPriceChanges(p, [{ rowId: rows[0].id, values: { unitPrice: '90' }, expected: rows[0].values }]); assert.equal(rowFor(next, row => row.id === rows[0].id).values.unitPrice, '90');
});

test('超安全整数单价全程十进制精度，未转成 Number', () => {
  const p = fixture({ regions: [room({ additionalCost: '0', items: [material('large', { unit: '件', quantityMode: 'manual', quantity: '1', unitPrice: '1', wasteRate: '0', laborRate: '0', additionalCost: '0' })] })], additionalCost: '.005', taxRate: '10' });
  const next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'region', { unitPrice: '9007199254740993.01' })]), quote = calculateProjectBudget(next);
  assert.equal(quote.knownSubtotal, '9007199254740993.02'); assert.equal(quote.tax, '900719925474099.30'); assert.equal(quote.total, '9907919180215092.32');
});

test('批量补价保存和 JSON 重开后从源参数重算相同工程总价', async () => {
  const p = budgetFixture({ pending: true }), next = applyProjectPriceChanges(p, [changeFor(p, row => row.targetType === 'furniture' && row.pending, { unitPrice: '150' })]), store = createMemoryProjectStore();
  await store.saveProject(next); const loaded = await store.loadProject(next.id), imported = await importProjectJSON(await exportProjectJSON(next));
  for (const restored of [loaded, imported]) { assert.equal(calculateProjectBudget(restored).total, '3775.76'); assert.deepEqual(collectProjectPriceRows(restored), collectProjectPriceRows(next)); }
});
