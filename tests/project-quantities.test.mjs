import assert from 'node:assert/strict';
import test from 'node:test';
const { calculateProjectQuantities, projectQuantitiesToCSV, renderProjectQuantitiesReport, downloadProjectQuantitiesCSV, printProjectQuantitiesReport } = await import(process.env.PROJECT_QUANTITIES_MODULE || '../static/studio/lib/project-quantities.js');
import { calculateProjectBudget } from '../static/studio/lib/project-budget.js';
import { addLevel, switchLevel } from '../static/studio/lib/levels.js';
import { createCivilElement } from '../static/studio/lib/civil.js';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createEarthworkBalance } from '../static/studio/lib/earthwork-balance.js';
import { createRoadProfile } from '../static/studio/lib/road-profile.js';
import { defaultOpeningQuote } from '../static/studio/lib/opening-pricing.js';
import { budgetFixture } from './project-budget-fixture.mjs';

const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const fixture = () => ({ version: 1, id: 'quantity-project', name: '工程用量', drawing: { id: 'plan', type: 'plan', name: '按尺寸绘制', width: 10000, height: 10000, url: 'data:image/png;base64,iVBORw0KGgo=' },
  calibration: { metersPerPixel: .01 }, regions: [], walls: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const item = (patch = {}) => ({ id: 'material-item', materialId: 'confirmed-tile', materialName: '确认地砖', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '10.005', wasteRate: '10', laborRate: '2', additionalCost: '0', ...patch });
const room = (id, area, patch = {}) => ({ id, name: id, points: rectangle(100, id === 'one' ? 100 : 1000, 100, area * 100), holes: [], hidden: false, items: [item({ id: id + '-item', ...patch })], additionalCost: '0' });
const chair = (id, width = 100) => ({ id, name: '同款椅子', kind: 'chair', position: { x: 200, y: 200 }, width, depth: 60, height: 80, rotation: 0, quantity: '1', unitPrice: '100', additionalCost: '0' });
const parseCSV = text => {
  const rows = [], row = []; let cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; } else if ((c === '\r' || c === '\n') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push([...row]); row.length = 0; cell = ''; } else cell += c; }
  return rows;
};

test('同一真实材料跨两个区域合并净施工量、损耗采购量和原行金额', () => {
  const p = fixture(); p.regions = [room('one', 2), room('two', 3)]; const before = structuredClone(p), q = calculateProjectQuantities(p);
  assert.equal(q.groups.length, 1); const g = q.groups[0];
  assert.equal(g.sourceCount, 2); assert.equal(g.netQuantity, '5'); assert.equal(g.purchaseQuantity, '5.5');
  assert.equal(g.knownMaterialCost, '55.03'); assert.equal(g.knownLaborCost, '10.00'); assert.equal(g.knownTotal, '65.03');
  assert.equal(q.totals.total, '65.03'); assert.deepEqual(p, before);
});

test('不同单价、损耗、人工或供应商规格不合并成均价', () => {
  for (const patch of [{ unitPrice: '10.006' }, { wasteRate: '11' }, { laborRate: '3' }, { provenance: { source: '报价A', supplier: '另一供应商', spec: '600×600' } }]) {
    const p = fixture(); p.regions = [room('one', 2), room('two', 3, patch)];
    assert.equal(calculateProjectQuantities(p).groups.length, 2);
  }
});

test('价格来源、供应商、地区、日期和 Demo 状态在清单及导出中可核对', () => {
  const p = fixture(); p.regions = [room('one', 2, { demo: true, provenance: { source: '用户询价', supplier: '供应商甲', region: '上海', priceDate: '2026-11-08', sourceUrl: 'https://example.test/quote', spec: '600 × 600 mm' } })];
  const q = calculateProjectQuantities(p), spec = q.groups[0].spec;
  for (const value of ['Demo', '用户询价', '供应商甲', '上海', '2026-11-08', 'https://example.test/quote', '600 × 600 mm']) {
    assert.ok(spec.includes(value)); assert.ok(projectQuantitiesToCSV(p, q).includes(value)); assert.ok(renderProjectQuantitiesReport(p, q).includes(value));
  }
});

test('正式清单与打印报告使用家具、土建、市政和门窗轮廓的中文规格名称', () => {
  const p = fixture(); p.furniture = ['bed', 'sofa', 'chair'].map((kind, i) => ({ ...chair('f-' + i), kind }));
  p.civilElements = ['column', 'padFooting'].map((kind, i) => ({ ...createCivilElement(kind, { x: 2500 + i * 2500, y: 5000 }, p), unitPrice: '1' }));
  p.municipalElements = [createMunicipalElement('road', [{ x: 1000, y: 8000 }, { x: 2000, y: 8000 }], p, { unitPrice: '1' })];
  p.walls = [{ id: 'wall', start: { x: 100, y: 100 }, end: { x: 800, y: 100 }, thickness: 20, height: 300 }];
  p.openings = ['rectangle', 'ellipse', 'polygon'].map((shape, i) => {
    const opening = { id: 'o-' + i, wallId: 'wall', kind: ['door', 'window', 'hole'][i], shape, offset: [100, 300, 500][i], bottom: i === 0 ? 0 : 80, width: 100, height: 120, depth: 4,
      ...(shape === 'polygon' ? { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }] } : {}) };
    opening.quote = { ...defaultOpeningQuote(opening), enabled: true, unitPrice: '1' }; return opening;
  });
  const q = calculateProjectQuantities(p), specs = q.groups.map(group => group.spec).join('\n'), html = renderProjectQuantitiesReport(p, q);
  for (const chinese of ['床 ·', '沙发 ·', '椅子 ·', '矩形柱 ·', '独立基础 ·', '道路 ·', '门 · 矩形', '窗 · 椭圆形', '墙面开孔 · 自定义多边形']) assert.ok(specs.includes(chinese));
  const internalKinds = /\b(bed|sofa|chair|padFooting|column|road|door|window|hole|rectangle|ellipse|polygon)\b/;
  const reportText = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '');
  assert.ok(!internalKinds.test(specs)); assert.ok(!internalKinds.test(reportText));
  const csvSpecs = parseCSV(projectQuantitiesToCSV(p, q)).filter(row => row[0] === '规格用量汇总').map(row => row[5]).join('\n');
  assert.equal(csvSpecs, specs);
});

test('同名而不同材料身份、单位及计量面分别保留', () => {
  const p = fixture(); p.regions = [room('one', 2), room('two', 3, { materialId: 'another-tile' })];
  p.regions[0].ceiling = { enabled: true, items: [item({ id: 'ceiling-item' })], additionalCost: '0' };
  p.regions[0].items.push(item({ id: 'edge-item', unit: 'm', quantityMode: 'perimeter' }));
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 4);
  assert.deepEqual(q.groups.map(group => group.unit).sort(), ['m', 'm²', 'm²', 'm²']);
});

test('墙面左侧与右侧饰面按实际选中的计量面保留独立来源', () => {
  const p = fixture(); p.walls = ['left', 'right'].map((finishSide, i) => ({ id: 'wall-' + i, start: { x: 100, y: 100 + i * 1000 }, end: { x: 800, y: 100 + i * 1000 }, thickness: 20, height: 300, finishSide, items: [item({ id: 'wall-item-' + i })] }));
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 2);
  assert.ok(q.groups[0].spec.includes('左侧')); assert.ok(q.groups[1].spec.includes('右侧'));
  assert.ok(q.groups.every(group => group.sources[0].targetType === 'wall' && Number(group.netQuantity) > 0));
});

test('楼层切换不会重复当前楼层用量，来源保留两层定位', () => {
  let p = fixture(); p.regions = [room('one', 2)]; p = addLevel(p, { name: '二楼' }); p.regions.push(room('two', 3));
  p = switchLevel(p, p.levels[0].id); const q = calculateProjectQuantities(p);
  assert.equal(q.groups.length, 1); assert.equal(q.groups[0].netQuantity, '5'); assert.equal(q.groups[0].sources.length, 2);
  assert.deepEqual(q.groups[0].sources.map(source => source.levelName), ['一楼', '二楼']);
  assert.equal(calculateProjectQuantities(switchLevel(p, p.levels[1].id)).totals.total, q.totals.total);
});

test('真实孔洞从净量和采购量扣除，不按外包面积合并', () => {
  const p = fixture(); p.regions = [room('one', 4)]; p.regions[0].points = rectangle(100, 100, 200, 200); p.regions[0].holes = [rectangle(150, 150, 100, 100)];
  const q = calculateProjectQuantities(p); assert.equal(q.groups[0].netQuantity, '3'); assert.equal(q.groups[0].purchaseQuantity, '3.3');
});

test('未校准保持未知用量，不伪造完整零价；已知固定费用独立显示', () => {
  const p = fixture(); p.calibration.metersPerPixel = null; p.regions = [room('one', 2, { additionalCost: '7' })]; p.regions[0].additionalCost = '3'; p.additionalCost = '10';
  const q = calculateProjectQuantities(p); assert.equal(q.groups[0].netQuantity, null); assert.equal(q.groups[0].purchaseQuantity, null);
  assert.equal(q.groups[0].knownNetQuantity, '0'); assert.equal(q.totals.itemAdditionalCost, '7.00'); assert.equal(q.totals.objectAdditionalCost, '3.00');
  assert.equal(q.totals.projectAdditionalCost, '10.00'); assert.equal(q.totals.knownTotal, '20.00'); assert.equal(q.totals.total, null); assert.equal(q.pending, true);
});

test('按件缺价仍保留实际件数，完整金额待确认，明确零价为有效报价', () => {
  const p = fixture(); p.furniture = [chair('one')]; p.furniture[0].unitPrice = '';
  let q = calculateProjectQuantities(p); assert.equal(q.groups[0].netQuantity, '1'); assert.equal(q.groups[0].pending, true); assert.equal(q.totals.total, null);
  p.furniture[0].unitPrice = '0'; q = calculateProjectQuantities(p); assert.equal(q.groups[0].pending, false); assert.equal(q.totals.total, '0.00');
});

test('同款设备相同尺寸可合并，尺寸不同不作为同一货品', () => {
  const p = fixture(); p.furniture = [chair('one'), chair('two')]; let q = calculateProjectQuantities(p);
  assert.equal(q.groups.length, 1); assert.equal(q.groups[0].netQuantity, '2'); assert.equal(q.groups[0].category, 'equipment');
  p.furniture[1].width = 120; q = calculateProjectQuantities(p); assert.equal(q.groups.length, 2); assert.notEqual(q.groups[0].spec, q.groups[1].spec);
});

test('门窗尺寸相同但真实轮廓不同，计价设备保留独立规格', () => {
  const p = fixture(); p.walls = [{ id: 'wall', start: { x: 100, y: 100 }, end: { x: 800, y: 100 }, thickness: 20, height: 300 }];
  p.openings = ['rectangle', 'ellipse'].map((shape, i) => { const value = { id: 'window-' + i, wallId: 'wall', kind: 'window', shape, offset: 100 + i * 300, bottom: 80, width: 100, height: 120, depth: 4 }; value.quote = { ...defaultOpeningQuote(value), enabled: true, unitPrice: '100' }; return value; });
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 2); assert.ok(q.groups.every(group => group.category === 'equipment'));
});

test('土建主材、模板施工和钢筋指标保留自己的量纲与原计量依据', () => {
  const p = fixture(); p.civilElements = [1000, 3000].map((x, i) => ({ ...createCivilElement('column', { x, y: 1000 }, p), id: 'column-' + i,
    width: 100, depth: 100, height: 100, elevation: 0, unitPrice: '100', formworkRate: '10', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '5' }));
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 3);
  assert.equal(q.groups.find(group => group.unit === 'm³').netQuantity, '2'); assert.equal(q.groups.find(group => group.unit === 'kg').netQuantity, '200');
  const formwork = q.groups.find(group => group.unit === 'm²'); assert.equal(formwork.category, 'construction'); assert.equal(formwork.netQuantity, '8');
  assert.match(q.groups.find(group => group.unit === 'kg').spec, /100 kg\/m³/); assert.equal(q.totals.total, '1280.00');
});

test('道路主项可按同规格归并，不同结构层厚度不能混成同一做法', () => {
  const p = fixture(); p.municipalElements = [1000, 3000].map((y, i) => createMunicipalElement('road', [{ x: 1000, y }, { x: 2000, y }], p,
    { width: 200, height: 10, unitPrice: '10', items: [{ id: 'base-' + i, name: '基层', thickness: 10 + i * 10, unit: 'm³', unitPrice: '20', wasteRate: '0', laborRate: '0', additionalCost: '0' }] }));
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 3); assert.equal(q.groups.find(group => group.unit === 'm²').sourceCount, 2);
  assert.deepEqual(q.groups.filter(group => group.unit === 'm³').map(group => group.netQuantity), ['2', '4']);
  assert.ok(q.groups.every(group => group.category === 'construction'));
});

test('同规格路口不同摆放朝向仍合并，支路数不同保持独立计量', () => {
  const p = fixture(); p.municipalElements = [0, 90].map((rotation, i) => createMunicipalElement('intersection', [{ x: 2500 + i * 5000, y: 4000 }], p,
    { unitPrice: '10', junction: { arms: 4, armLength: 1800, rotation, islandRadius: 600 } }));
  let q = calculateProjectQuantities(p); assert.equal(q.groups.length, 1); assert.equal(q.groups[0].sourceCount, 2);
  p.municipalElements[1].junction.arms = 3; q = calculateProjectQuantities(p); assert.equal(q.groups.length, 2);
});

test('桥面、中间墩和侧栏杆使用面积、件数、真实侧边米数分别核对', () => {
  const p = fixture(); p.municipalElements = [createMunicipalElement('bridge', [{ x: 1000, y: 1000 }, { x: 3400, y: 1000 }], p, {
    width: 600, height: 40, elevation: 500, unitPrice: '10', bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '100', railingUnitPrice: '10' } })];
  const q = calculateProjectQuantities(p); assert.deepEqual(q.groups.map(group => [group.unit, group.netQuantity]), [['m²', '144'], ['件', '2'], ['m', '48']]);
  assert.equal(q.totals.total, '2120.00'); assert.ok(q.notes.some(note => note.includes('结构受力')));
});

function earthworkFixture() {
  const p = fixture(); p.municipalTerrain = { name: '用户输入平地', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 30, y: 0, z: 0 }, { id: 'c', x: 30, y: 30, z: 0 }, { id: 'd', x: 0, y: 30, z: 0 }] };
  const road = createMunicipalElement('road', [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }], p), balance = createEarthworkBalance();
  Object.assign(balance, { enabled: true, usableCutPercent: '60', naturalPerCompactedFill: '1.1', loosePerNatural: '1.2', borrowMaterial: { enabled: true, unitPrice: '40' }, reuseHaul: { enabled: true, distanceKm: '.2', unitPrice: '3' }, borrowHaul: { enabled: true, distanceKm: '5', unitPrice: '2' }, spoilHaul: { enabled: true, distanceKm: '10', unitPrice: '1.5' } });
  Object.assign(road, { width: 200, height: 10, unitPrice: '0', roadProfile: { enabled: true, points: [{ id: 'start', station: 0, elevation: -.9 }, { id: 'end', station: 10, elevation: 1.1 }], sampleInterval: 1, earthwork: { enabled: false, cutUnitPrice: '', fillUnitPrice: '' }, earthworkBalance: balance } });
  p.municipalElements = [road]; return p;
}

test('借方天然体积与松方乘运距独立归类，不把m³·km当采购m³', () => {
  const p = earthworkFixture(), q = calculateProjectQuantities(p);
  assert.equal(q.totals.total, '168.16'); const hauling = q.groups.filter(group => group.unit === 'm³·km');
  assert.equal(hauling.length, 3); assert.ok(hauling.every(group => group.category === 'transport'));
  assert.deepEqual(hauling.map(group => group.netQuantity), ['0.72', '15', '24']);
  assert.equal(q.groups.find(group => group.unit === 'm³').netQuantity, '2.5');
});

test('已确认零借料和零弃方运输的空价显示无需单价，非零缺价仍待填写', () => {
  const p = earthworkFixture(), balance = p.municipalElements[0].roadProfile.earthworkBalance;
  Object.assign(balance, { usableCutPercent: '100', naturalPerCompactedFill: '1' });
  balance.borrowMaterial.unitPrice = ''; balance.borrowHaul.unitPrice = ''; balance.borrowHaul.distanceKm = '';
  balance.spoilHaul.unitPrice = ''; balance.spoilHaul.distanceKm = '';
  const q = calculateProjectQuantities(p); assert.equal(q.budgetStatus, 'ready'); assert.equal(q.pending, false);
  const zero = q.groups.filter(group => group.netQuantity === '0' && group.unitPrice === ''); assert.equal(zero.length, 3);
  assert.ok(zero.every(group => group.purchaseQuantity === '0' && !group.pending));
  const rows = parseCSV(projectQuantitiesToCSV(p, q)).filter(row => row[0] === '规格用量汇总' || row[0] === '来源追溯');
  assert.equal(rows.filter(row => row[9] === '零量无需单价').length, 6); assert.ok(rows.every(row => row[9] !== '待填写'));
  const html = renderProjectQuantitiesReport(p, q); assert.equal((html.match(/零量无需单价/g) ?? []).length, 6); assert.ok(!html.includes('待填写'));
  const missing = fixture(); missing.furniture = [{ ...chair('unpriced'), unitPrice: '' }];
  assert.match(projectQuantitiesToCSV(missing), /待填写/); assert.match(renderProjectQuantitiesReport(missing), /待填写/);
  assert.ok(!renderProjectQuantitiesReport(missing).includes('零量无需单价'));
});

test('部分地形只列实际覆盖土方量，未测范围保持未知不外推', () => {
  const p = fixture(); p.municipalTerrain = { name: '仅覆盖半幅道路', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 15, y: 0, z: 0 }, { id: 'c', x: 15, y: 30, z: 0 }, { id: 'd', x: 0, y: 30, z: 0 }] };
  const road = createMunicipalElement('road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], p, { width: 200, height: 10, unitPrice: '0' });
  road.roadProfile = createRoadProfile(p, road); road.roadProfile.points.forEach(point => point.elevation = 1); road.roadProfile.earthwork = { enabled: true, cutUnitPrice: '2', fillUnitPrice: '2' }; p.municipalElements = [road];
  const q = calculateProjectQuantities(p), fill = q.groups.find(group => group.materialName === '路床填方');
  assert.equal(fill.netQuantity, null); assert.equal(fill.purchaseQuantity, null); assert.ok(Number(fill.knownNetQuantity) > 0); assert.ok(Number(fill.knownNetQuantity) < 18);
  assert.equal(q.totals.total, null); assert.ok(Number(fill.knownMaterialCost) > 0); assert.match(projectQuantitiesToCSV(p), /待确认（已知部分/);
  const csvSources = parseCSV(projectQuantitiesToCSV(p)).filter(row => row[0] === '来源追溯' && row[4] === '路床填方');
  assert.equal(csvSources.length, 1); assert.ok(csvSources[0][7].includes(fill.sources[0].knownNetQuantity));
});

test('分项固定费、对象固定费、工程固定费与统一税金仅计一次', () => {
  const p = budgetFixture(), q = calculateProjectQuantities(p);
  assert.deepEqual(q.totals, { materialCost: '2930.00', laborCost: '424.00', itemAdditionalCost: '10.00', objectAdditionalCost: '0.00', projectAdditionalCost: '100.00', beforeTax: '3464.00', tax: '311.76', total: '3775.76', knownTotal: '3775.76' });
  assert.equal(q.itemCount, 8); assert.equal(q.totals.total, calculateProjectBudget(p).total);
});

test('取消专业后清单按本次范围过滤，原对象与独立报价不变', () => {
  const p = budgetFixture(); p.budget.included.civil = false; const before = structuredClone(p), q = calculateProjectQuantities(p);
  assert.ok(q.groups.every(group => group.section !== 'civil')); assert.ok(q.excludedSections.includes('civil')); assert.equal(q.totals.total, '3535.96'); assert.deepEqual(p, before);
});

test('原分项金额先按分舍入，用量合并不重乘单价改变金额', () => {
  const p = fixture(); p.regions = ['one', 'two', 'three'].map(id => ({ ...room(id, 1, { unit: '件', quantityMode: 'manual', quantity: '1', unitPrice: '.105', wasteRate: '0', laborRate: '0' }), points: [] }));
  const q = calculateProjectQuantities(p); assert.equal(q.groups.length, 1); assert.equal(q.groups[0].netQuantity, '3'); assert.equal(q.groups[0].knownMaterialCost, '0.33'); assert.equal(q.totals.total, '0.33');
});

test('超安全整数金额精确合并且同额不重新转成Number', () => {
  const p = fixture(); p.regions = [room('one', 1, { unitPrice: '9007199254740993.01', wasteRate: '0', laborRate: '0' }), room('two', 1, { unitPrice: '9007199254740993.01', wasteRate: '0', laborRate: '0' })];
  assert.equal(calculateProjectQuantities(p).totals.total, '18014398509481986.02');
});

test('CSV列数一致、汇总与来源层级分开，HTML/公式文字安全转义', () => {
  const p = fixture(); p.name = '=SUM(A1)<script>bad</script>'; p.budget = { client: '甲方<script>bad</script>', reference: '=A1', note: '第一行\n第二行' }; p.regions = [room('one', 2)];
  const q = calculateProjectQuantities(p), rows = parseCSV(projectQuantitiesToCSV(p, q)), html = renderProjectQuantitiesReport(p, q);
  assert.ok(rows.every(row => row.length === 19)); assert.equal(rows.filter(row => row[0] === '规格用量汇总').length, 1); assert.equal(rows.filter(row => row[0] === '来源追溯').length, 1);
  assert.ok(rows.slice(1).every(row => row[1].startsWith("'="))); assert.ok(rows.some(row => row[18] === "'=A1"));
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;')); assert.ok(!html.includes('<script>bad</script>')); assert.ok(html.includes('第一行\n第二行'));
});

test('空工程与仅固定费不变成完整用量，派生清单拒绝另一项目预算', () => {
  const p = fixture(); p.additionalCost = '10'; const q = calculateProjectQuantities(p);
  assert.equal(q.groups.length, 0); assert.equal(q.budgetStatus, 'empty'); assert.equal(q.totals.total, null); assert.match(renderProjectQuantitiesReport(p, q), /尚无已汇入/);
  const another = calculateProjectBudget({ ...p, id: 'another' }); assert.throws(() => calculateProjectQuantities(p, another), /不一致/);
});

test('完整新预算副本可校验通过，同 ID 同总价但数量和单价已变的旧预算被拒绝', () => {
  const p = fixture(); p.regions = [room('one', 1, { unit: '件', quantityMode: 'manual', quantity: '1', unitPrice: '10', wasteRate: '0', laborRate: '0' })];
  const budget = calculateProjectBudget(p); assert.deepEqual(calculateProjectQuantities(p, structuredClone(budget)), calculateProjectQuantities(p));
  p.regions[0].items[0].quantity = '2'; p.regions[0].items[0].unitPrice = '5';
  assert.equal(calculateProjectBudget(p).total, budget.total); assert.throws(() => calculateProjectQuantities(p, budget), /已更新或不一致/);
  const forged = calculateProjectBudget(p); forged.sections[0].quote.regions[0].items[0].unitPrice = '999';
  assert.throws(() => calculateProjectQuantities(p, forged), /已更新或不一致/);
});

test('CSV、打印和下载拒绝同总价旧清单及伪造结果，默认导出始终以当前源数据为准', () => {
  const p = fixture(); p.regions = [room('one', 1, { unit: '件', quantityMode: 'manual', quantity: '1', unitPrice: '10', wasteRate: '0', laborRate: '0' })];
  const old = calculateProjectQuantities(p); p.regions[0].items[0].quantity = '2'; p.regions[0].items[0].unitPrice = '5';
  assert.equal(calculateProjectQuantities(p).totals.total, old.totals.total);
  for (const exporter of [projectQuantitiesToCSV, renderProjectQuantitiesReport, downloadProjectQuantitiesCSV, printProjectQuantitiesReport]) assert.throws(() => exporter(p, old), /已更新或不一致/);
  const latest = calculateProjectQuantities(p), rows = parseCSV(projectQuantitiesToCSV(p, structuredClone(latest))), line = rows.find(row => row[0] === '规格用量汇总');
  assert.equal(line[7], '2'); assert.equal(line[9], '5');
  assert.equal(projectQuantitiesToCSV(p), projectQuantitiesToCSV(p, latest)); assert.equal(renderProjectQuantitiesReport(p), renderProjectQuantitiesReport(p, latest));
  const forged = structuredClone(latest); forged.groups[0].knownTotal = '999.00';
  assert.throws(() => projectQuantitiesToCSV(p, forged), /已更新或不一致/); assert.throws(() => renderProjectQuantitiesReport(p, forged), /已更新或不一致/);
});

test('按件价格未变时家具真实规格更新也使旧导出清单失效', () => {
  const p = fixture(); p.furniture = [chair('one')]; const old = calculateProjectQuantities(p); p.furniture[0].width = 120;
  assert.equal(calculateProjectQuantities(p).totals.total, old.totals.total);
  assert.throws(() => projectQuantitiesToCSV(p, old), /已更新或不一致/); assert.throws(() => renderProjectQuantitiesReport(p, old), /已更新或不一致/);
  assert.match(projectQuantitiesToCSV(p), /120 × 60 × 80 cm/);
});
