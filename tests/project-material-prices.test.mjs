import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProjectPriceRows, collectProjectSourceRows, applyProjectMaterialPrices, applyProjectPriceChanges } from '../static/studio/lib/project-price-edit.js';
import { normalizePriceProvenance, effectivePriceProvenance, describePriceSource, sourcePriceMetadata } from '../static/studio/lib/price-provenance.js';
import { calculateProjectBudget } from '../static/studio/lib/project-budget.js';
import { projectBudgetToCSV } from '../static/studio/lib/project-budget-export.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { makeArc } from '../static/studio/lib/drawing-shapes.js';
import { createCivilElement } from '../static/studio/lib/civil.js';
import { createServiceRoute } from '../static/studio/lib/services.js';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';
import { switchLevel } from '../static/studio/lib/levels.js';
import { budgetFixture } from './project-budget-fixture.mjs';
import { projectToCSV, renderExportHTML } from '../static/studio/lib/export.js';

const rectangle = (x, y, width, depth) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
const item = (id = 'floor', patch = {}) => ({ id, materialId: id, materialName: '原设计地砖', color: '#8e9c96', image: '原材料图', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '5', ...patch });
const room = (patch = {}) => ({ id: 'room', name: '客厅', points: rectangle(100, 100, 400, 300), holes: [], hidden: false, items: [item()], additionalCost: '7', ...patch });
const fixture = (patch = {}) => ({ version: 1, id: 'project-material-prices', name: '真实工程报价', workspaceMode: 'plan', drawing: { id: 'plan', type: 'plan', name: '实际画板', width: 6000, height: 6000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, walls: [], regions: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, ...patch });
const webURL = 'https://supplier.example/prices';
const provenance = (patch = {}) => ({ source: '当地供应商报价', sourceUrl: webURL, region: '杭州', spec: '用户确认规格', supplier: '实际厂家', materialName: '实际报价材料', originalUnit: '平方米', priceDate: '2026-11-01', updatedAt: '2026-11-08T03:00:00Z', refresh: { kind: 'web', url: webURL, tableIndex: 2, hasHeader: true, mapping: { name: 0, unit: 1, price: 2, spec: 3, date: 4, supplier: 5, region: 6, source: 7 } }, ...patch });
const catalogMaterial = (unit = 'm²', patch = {}) => ({ id: 'source-' + unit, name: '最新真实采购报价', category: '来源材料', image: '新的供应商图', unit, unitPrice: '88.605', wasteRate: '99', color: '#336b58', description: '供应商材料说明', demo: false, provenance: provenance({ originalUnit: unit }), ...patch });
const sourceRow = (project, predicate) => {
  const row = collectProjectSourceRows(project).find(predicate);
  assert.ok(row, '必须找到真实源计价行');
  return row;
};
const linkedChange = (row, material = catalogMaterial(row.unit)) => ({ rowId: row.id, material, expectedPrice: row.values.unitPrice, expectedMaterialId: row.materialId ?? null });
const unchangedExceptPrices = value => {
  if (Array.isArray(value)) return value.map(unchangedExceptPrices);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['unitPrice', 'priceMaterialId', 'priceSourceUnitPrice', 'provenance', 'demo'].includes(key)).map(([key, child]) => [key, unchangedExceptPrices(child)]));
};

function straightWall(id) {
  return { id, name: id, start: { x: 100, y: 1500 }, end: { x: 900, y: 1500 }, thickness: 20, height: 300, finishSide: 'left', items: [item(id + '-finish')], additionalCost: '2' };
}
function addArc(content, prefix) {
  const shape = makeArc({ x: 2000, y: 2000 }, 200, 0, 90);
  const segments = shape.points.slice(0, -1).map((point, index) => ({ id: prefix + '-segment-' + index, start: { ...point }, end: { ...shape.points[index + 1] }, thickness: 20, height: 280, items: [], additionalCost: '0' }));
  content.walls.push(...segments);
  content.wallShapes = [{ id: prefix + '-arc', kind: shape.kind, name: '真实弧墙', wallIds: segments.map(wall => wall.id), center: shape.center, radius: shape.radius, startDegrees: shape.startDegrees, sweepDegrees: shape.sweepDegrees, maxDeviation: shape.maxDeviation, finishSide: 'left', items: [item('same-curve-item')], additionalCost: '6' }];
}
function fullFixture() {
  const p = budgetFixture(), upper = p.levels.find(level => level.id !== p.activeLevelId);
  upper.content.regions[0].ceiling = { enabled: true, items: [item('upper-ceiling')], additionalCost: '3' };
  for (const [content, prefix] of [[p, 'ground'], [upper.content, 'upper']]) {
    const wall = straightWall(prefix + '-wall');
    content.walls = [wall];
    addArc(content, prefix);
    content.openings = [{ id: prefix + '-door', wallId: wall.id, kind: 'door', shape: 'rectangle', offset: 100, width: 90, height: 210, bottom: 0, depth: 4, quote: { enabled: true, unit: '件', quantity: '2', unitPrice: '1300', wasteRate: '3', laborRate: '50', additionalCost: '7' } }];
    content.serviceRoutes = [{ ...createServiceRoute('bv25', [{ x: 100, y: 100, z: 0 }, { x: 400, y: 500, z: 1200 }]), id: prefix + '-electric', unitPrice: '3.2', wasteRate: '4', laborRate: '1.6', additionalCost: '8', runs: '2', extraLength: '1.5' }];
  }
  p.municipalElements[0].items = [{ id: 'road-base', name: '原设计基层', materialId: 'original-base', materialName: '原基层材料', unit: 'm³', thickness: 20, unitPrice: '200', wasteRate: '3', laborRate: '25', additionalCost: '2' }];
  return p;
}

test('source collection includes excluded disciplines while ordinary pricing still obeys selected budget scope', () => {
  const p = fullFixture(), before = structuredClone(p), rows = collectProjectSourceRows(p);
  assert.equal(rows.length, 18);
  assert.deepEqual(new Set(rows.map(row => row.targetType)), new Set(['region', 'ceiling', 'wall', 'furniture', 'service', 'opening', 'civil', 'municipal']));
  assert.ok(rows.every(row => row.sourceLinkable));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  for (const type of ['region', 'ceiling', 'wall', 'furniture', 'service', 'opening', 'civil']) {
    assert.equal(new Set(rows.filter(row => row.targetType === type).map(row => row.levelId)).size, 2);
  }
  assert.deepEqual(p, before);
  p.budget.included.civil = false; p.budget.included.municipal = false;
  assert.equal(collectProjectSourceRows(p).length, rows.length);
  assert.ok(collectProjectPriceRows(p).every(row => row.section === 'decoration'));
  assert.deepEqual(collectProjectSourceRows(fixture()), []);
});

test('one batch links real area, ceiling, straight/arc wall, furniture, service, opening, civil and municipal quotes across floors', () => {
  const p = fullFixture(), before = structuredClone(p), rows = collectProjectSourceRows(p);
  const materials = rows.map((row, index) => catalogMaterial(row.unit, { id: 'catalog-' + index, unitPrice: String(201 + index), provenance: provenance({ materialName: '来源分项-' + index, originalUnit: row.unit }) }));
  const materialCopies = structuredClone(materials);
  const next = applyProjectMaterialPrices(p, rows.map((row, index) => linkedChange(row, materials[index])));
  const refreshed = collectProjectSourceRows(next);
  assert.deepEqual(p, before);
  assert.deepEqual(materials, materialCopies);
  assert.deepEqual(unchangedExceptPrices(next), unchangedExceptPrices(before), '除单价和来源元数据之外所有实际工程数据必须原样保留');
  assert.equal(next.activeLevelId, p.activeLevelId);
  assert.deepEqual(next.levels.find(level => level.id === p.activeLevelId).content, before.levels.find(level => level.id === p.activeLevelId).content, '活动层只更新根源，不写旧楼层快照');
  for (const [index, row] of rows.entries()) {
    const current = refreshed.find(candidate => candidate.id === row.id);
    assert.equal(current.values.unitPrice, materials[index].unitPrice);
    assert.equal(current.materialId, materials[index].id);
    assert.deepEqual(current.provenance, materials[index].provenance);
    assert.equal(current.unit, row.unit);
    assert.equal(current.values.wasteRate, row.values.wasteRate);
    assert.equal(current.values.laborRate, row.values.laborRate);
    assert.equal(current.netQuantity, row.netQuantity);
    assert.equal(current.purchaseQuantity, row.purchaseQuantity);
  }
  const switched = switchLevel(next, next.levels.find(level => level.id !== next.activeLevelId).id);
  assert.deepEqual(new Map(collectProjectSourceRows(switched).map(row => [row.id, row.values.unitPrice])), new Map(refreshed.map(row => [row.id, row.values.unitPrice])));
});

test('selected source price links retain the original material name, image, unit, quantity mode, waste, labor and fixed fees', () => {
  const p = fixture({ regions: [room()] }), before = structuredClone(p), row = sourceRow(p, row => row.targetType === 'region');
  const latest = catalogMaterial('m²', { name: '另一材料的参考报价', wasteRate: '99' });
  const next = applyProjectMaterialPrices(p, [linkedChange(row, latest)]), updated = next.regions[0].items[0];
  assert.deepEqual(updated, { ...before.regions[0].items[0], unitPrice: '88.605', priceMaterialId: latest.id, priceSourceUnitPrice: '88.605', provenance: latest.provenance, demo: false });
  assert.deepEqual(next.regions[0].points, p.regions[0].points);
  const quote = calculateProject(next).regions[0];
  assert.equal(quote.netArea, 12);
  assert.equal(quote.items[0].purchaseQuantity, '13.2');
  assert.equal(quote.materialCost, '1169.59');
  assert.equal(quote.laborCost, '240.00');
  assert.equal(quote.total, '1421.59');
});

test('an excluded source price can refresh explicitly without enabling its discipline or changing the total budget', () => {
  const p = fullFixture(); p.budget.included.civil = false; p.budget.included.municipal = false;
  const before = structuredClone(p), budget = calculateProjectBudget(p);
  const selected = collectProjectSourceRows(p).filter(row => ['civil', 'municipal'].includes(row.section));
  const next = applyProjectMaterialPrices(p, selected.map(row => linkedChange(row, catalogMaterial(row.unit, { unitPrice: '999' }))));
  assert.equal(calculateProjectBudget(next).total, budget.total);
  assert.deepEqual(next.budget, before.budget);
  assert.deepEqual(next.regions, before.regions);
  assert.ok(collectProjectPriceRows(next).every(row => row.section === 'decoration'));
  assert.ok(collectProjectSourceRows(next).filter(row => ['civil', 'municipal'].includes(row.section)).every(row => row.values.unitPrice === '999'));
  assert.deepEqual(p, before);
});

test('same item names and ids on different floors resolve their own source while all unselected prices remain intact', () => {
  const p = fullFixture(), upper = p.levels.find(level => level.id !== p.activeLevelId);
  upper.content.regions[0].name = p.regions[0].name;
  upper.content.regions[0].items[0].id = p.regions[0].items[0].id;
  const rows = collectProjectSourceRows(p), selected = rows.find(row => row.targetType === 'region' && row.levelId === upper.id);
  const next = applyProjectMaterialPrices(p, [linkedChange(selected, catalogMaterial('m²', { unitPrice: '95' }))]);
  assert.equal(next.regions[0].items[0].unitPrice, '100');
  assert.equal(next.levels.find(level => level.id === upper.id).content.regions[0].items[0].unitPrice, '95');
  for (const row of rows.filter(row => row.id !== selected.id)) assert.deepEqual(sourceRow(next, candidate => candidate.id === row.id), row);
});

test('only true main price fields are linkable; formwork, rebar, bridge extras and road earthwork keep their professional controls', () => {
  const p = fixture(), column = { ...createCivilElement('column', { x: 1000, y: 1000 }, p), id: 'column', unitPrice: '100', formworkRate: '3', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '5' };
  p.civilElements = [column];
  const bridge = createMunicipalElement('bridge', [{ x: 1000, y: 3000 }, { x: 3400, y: 3000 }], p, { width: 1500, unitPrice: '10', bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '1000', railingUnitPrice: '20' } });
  bridge.id = 'bridge';
  const road = createMunicipalElement('road', [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }], p, { width: 200, unitPrice: '10' });
  Object.assign(road, { id: 'road', roadProfile: { enabled: true, points: [{ id: 'start', station: 0, elevation: 0 }, { id: 'end', station: 10, elevation: 0 }], sampleInterval: 1, earthwork: { enabled: true, cutUnitPrice: '2', fillUnitPrice: '3' } } });
  p.municipalElements = [bridge, road];
  p.municipalTerrain = { name: '已知水平地形', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 60, y: 0, z: 0 }, { id: 'c', x: 60, y: 60, z: 0 }, { id: 'd', x: 0, y: 60, z: 0 }] };
  const rows = collectProjectSourceRows(p), extras = rows.filter(row => /:formwork$|:rebar$|:piers$|:railings$|:cutVolume$|:fillVolume$/.test(row.itemId));
  assert.equal(extras.length, 6);
  assert.ok(extras.every(row => row.sourceLinkable === false));
  assert.ok(rows.filter(row => /:main$|:material$/.test(row.itemId)).every(row => row.sourceLinkable));
  const before = structuredClone(p), valid = linkedChange(rows.find(row => row.itemId === 'column:material'), catalogMaterial('m³'));
  for (const extra of extras) {
    assert.throws(() => applyProjectMaterialPrices(p, [valid, linkedChange(extra, catalogMaterial(extra.unit))]), /专业工具/);
    assert.deepEqual(p, before);
  }
});

test('source units must match exactly and may not reinterpret square metres, metres, pieces, kilograms, tonnes or cubic metres', () => {
  for (const unit of ['m²', 'm', '件', 'kg', '吨', 'm³']) {
    const p = fixture({ regions: [room({ items: [item('manual', { unit, quantityMode: 'manual', quantity: '2', wasteRate: '0', laborRate: '0', additionalCost: '0' })] })] });
    const row = sourceRow(p, row => row.targetType === 'region'), before = structuredClone(p);
    for (const otherUnit of ['m²', 'm', '件', 'kg', '吨', 'm³'].filter(candidate => candidate !== unit)) {
      assert.throws(() => applyProjectMaterialPrices(p, [linkedChange(row, catalogMaterial(otherUnit))]), /单位/);
      assert.deepEqual(p, before);
    }
    assert.equal(sourceRow(applyProjectMaterialPrices(p, [linkedChange(row, catalogMaterial(unit))]), candidate => candidate.id === row.id).unit, unit);
  }
});

test('stale expected price, stale source id, duplicate rows and a bad late change reject the entire batch without mutation', () => {
  const p = fullFixture(), before = structuredClone(p), rows = collectProjectSourceRows(p);
  const valid = linkedChange(rows[0]), second = linkedChange(rows[1]);
  for (const batch of [
    [valid, { ...second, expectedPrice: '999' }],
    [valid, { ...second, expectedMaterialId: 'already-changed-source' }],
    [valid, { ...second, material: catalogMaterial('吨') }],
    [valid, { ...second, material: catalogMaterial(second.material.unit, { unitPrice: '-1' }) }],
    [valid, { ...second, rowId: 'removed-row' }],
    [valid, valid], [valid, null], [null], {}, 'not-an-array',
  ]) {
    assert.throws(() => applyProjectMaterialPrices(p, batch));
    assert.deepEqual(p, before);
  }
  const next = applyProjectMaterialPrices(p, [valid]);
  assert.throws(() => applyProjectMaterialPrices(next, [valid]), /已变化/);
  assert.equal(sourceRow(next, row => row.id === valid.rowId).values.unitPrice, '88.605');
});

test('exact preview strings detect representation changes and explicit absent-source checks cannot overwrite an existing link', () => {
  const p = fixture({ regions: [room()] }), row = sourceRow(p, row => row.targetType === 'region');
  assert.throws(() => applyProjectMaterialPrices(p, [{ ...linkedChange(row), expectedPrice: '100.00' }]), /已变化/);
  const linked = applyProjectMaterialPrices(p, [linkedChange(row)]), current = sourceRow(linked, row => row.targetType === 'region');
  assert.throws(() => applyProjectMaterialPrices(linked, [{ ...linkedChange(current), expectedMaterialId: null }]), /已变化/);
  const refreshed = applyProjectMaterialPrices(linked, [linkedChange(current, catalogMaterial('m²', { unitPrice: '90', provenance: provenance({ priceDate: '2026-11-08' }) }))]);
  assert.equal(sourceRow(refreshed, row => row.id === current.id).values.unitPrice, '90');
});

test('removed and disabled source objects reject old rows rather than recreating an area, ceiling, opening or quantity', () => {
  const p = fullFixture(), rows = collectProjectSourceRows(p);
  for (const [type, mutate] of [
    ['region', value => { value.regions = []; }],
    ['ceiling', value => { value.regions[0].ceiling.enabled = false; }],
    ['opening', value => { value.openings[0].quote.enabled = false; }],
    ['furniture', value => { value.furniture = []; }],
    ['service', value => { value.serviceRoutes = []; }],
  ]) {
    const row = rows.find(row => row.targetType === type && row.levelId === p.activeLevelId), changed = structuredClone(p);
    mutate(changed);
    const before = structuredClone(changed);
    assert.throws(() => applyProjectMaterialPrices(changed, [linkedChange(row)]));
    assert.deepEqual(changed, before);
  }
});

test('invalid cross-floor object ids cannot bypass project validation or silently select a different source', () => {
  const p = fullFixture(), row = sourceRow(p, row => row.targetType === 'region');
  p.levels.find(level => level.id !== p.activeLevelId).content.regions[0].id = p.regions[0].id;
  const before = structuredClone(p);
  assert.throws(() => collectProjectSourceRows(p));
  assert.throws(() => applyProjectMaterialPrices(p, [linkedChange(row)]));
  assert.deepEqual(p, before);
});

test('blank prices can be linked to a real zero quote and refreshing only the quote date keeps computed amounts', () => {
  const p = fixture({ regions: [room({ items: [item('missing', { unitPrice: '' })] })] });
  const row = sourceRow(p, row => row.targetType === 'region');
  assert.equal(row.values.unitPrice, '');
  const zero = applyProjectMaterialPrices(p, [linkedChange(row, catalogMaterial('m²', { unitPrice: '0' }))]);
  const current = sourceRow(zero, row => row.targetType === 'region');
  assert.equal(current.values.unitPrice, '0');
  assert.equal(current.pending, false);
  const amount = calculateProjectBudget(zero).total;
  const newer = applyProjectMaterialPrices(zero, [linkedChange(current, catalogMaterial('m²', { unitPrice: '0.00', provenance: provenance({ priceDate: '2026-11-08' }) }))]);
  assert.equal(calculateProjectBudget(newer).total, amount);
  assert.equal(sourceRow(newer, row => row.id === current.id).provenance.priceDate, '2026-11-08');
});

test('supplier provenance and mapping are detached copies; editing one linked item cannot alter another item or the material library', () => {
  const p = fullFixture(), rows = collectProjectSourceRows(p).filter(row => row.targetType === 'region'), material = catalogMaterial();
  const before = structuredClone(material), next = applyProjectMaterialPrices(p, rows.map(row => linkedChange(row, material)));
  const active = next.regions[0].items[0], inactive = next.levels.find(level => level.id !== next.activeLevelId).content.regions[0].items[0];
  active.provenance.refresh.mapping.price = 99;
  active.provenance.supplier = '用户草稿供应商';
  assert.deepEqual(inactive.provenance, before.provenance);
  assert.deepEqual(material, before);
  assert.equal(p.regions[0].items[0].provenance, undefined);
});

test('real sourcing clears Demo on material snapshots and unsourced / Demo candidates retain explicit truthful fallback labels', () => {
  const p = fixture({ regions: [room({ items: [item('demo', { demo: true })] })] }), row = sourceRow(p, row => row.targetType === 'region');
  assert.match(row.sourceNote, /Demo/);
  const real = applyProjectMaterialPrices(p, [linkedChange(row)]);
  assert.equal(real.regions[0].items[0].demo, false);
  assert.doesNotMatch(sourceRow(real, row => row.targetType === 'region').sourceNote, /Demo/);
  for (const demo of [false, true]) {
    const fallback = catalogMaterial('m²', { provenance: undefined, demo }), next = applyProjectMaterialPrices(p, [linkedChange(row, fallback)]);
    assert.deepEqual(next.regions[0].items[0].provenance, { source: demo ? 'Demo 示例价格' : '用户手工报价', materialName: fallback.name });
    assert.equal(next.regions[0].items[0].demo, demo);
    assert.match(sourceRow(next, row => row.targetType === 'region').sourceNote, demo ? /Demo/ : /用户手工报价/);
  }
});

test('linked large decimal prices retain exact money beyond safe integers', () => {
  const p = fixture({ regions: [room({ additionalCost: '0', items: [item('one-piece', { unit: '件', quantityMode: 'manual', quantity: '1', wasteRate: '0', laborRate: '0', additionalCost: '0' })] })] });
  const row = sourceRow(p, row => row.targetType === 'region'), price = '9007199254740993.01';
  const next = applyProjectMaterialPrices(p, [linkedChange(row, catalogMaterial('件', { unitPrice: price }))]);
  assert.equal(next.regions[0].items[0].unitPrice, price);
  assert.equal(next.regions[0].items[0].priceSourceUnitPrice, price);
  assert.equal(calculateProjectBudget(next).total, price);
});

test('manual overrides strip the old supplier, date, URL and refresh authority while retaining material connection, local region and spec', () => {
  const p = fullFixture(), linked = applyProjectMaterialPrices(p, collectProjectSourceRows(p).map(row => linkedChange(row, catalogMaterial(row.unit, { unitPrice: '100' }))));
  for (const row of collectProjectSourceRows(linked)) {
    const value = structuredClone(linked);
    const override = applyProjectPriceChanges(value, [{ rowId: row.id, values: { unitPrice: '125' } }]);
    const edited = sourceRow(override, candidate => candidate.id === row.id);
    assert.equal(edited.materialId, row.materialId);
    assert.deepEqual(edited.provenance, { source: '用户调整单价', spec: '用户确认规格', region: '杭州' });
    assert.match(edited.sourceNote, /用户调整单价/);
    assert.doesNotMatch(edited.sourceNote, /当地供应商报价|实际厂家|2026-11-01/);
  }
});

test('price equality is normalized without falsely marking trailing zeros or very large decimals as manual', () => {
  const prior = provenance(), target = { provenance: prior, priceMaterialId: 'source', priceSourceUnitPrice: '9007199254740993.0100', unitPrice: '9007199254740993.01' };
  assert.deepEqual(effectivePriceProvenance(target), prior);
  assert.deepEqual(sourcePriceMetadata(target), { provenance: prior, priceMaterialId: 'source' });
  assert.deepEqual(target.provenance, prior);
  const overridden = { ...target, unitPrice: '9007199254740993.02' };
  assert.deepEqual(sourcePriceMetadata(overridden), { provenance: { source: '用户调整单价', spec: prior.spec, region: prior.region }, priceMaterialId: 'source' });
  assert.deepEqual(effectivePriceProvenance({ ...target, priceSourceUnitPrice: '100', unitPrice: '' }), { source: '用户调整单价', spec: prior.spec, region: prior.region });
});

test('manual input markers remain explicit in source descriptions and are not prefixed twice', () => {
  const input = { provenance: provenance({ source: '业主提供报价', manual: true }), unitPrice: '100' }, before = structuredClone(input);
  const effective = effectivePriceProvenance(input);
  assert.equal(effective.source, '手工录入 · 业主提供报价');
  assert.equal(effective.manual, false);
  assert.equal(effectivePriceProvenance({ ...input, provenance: effective }).source, effective.source);
  assert.match(describePriceSource(effective), /^手工录入 · 业主提供报价.*杭州.*2026-11-01/);
  assert.match(describePriceSource(input.provenance), /^手工录入 · 业主提供报价/);
  assert.equal(describePriceSource(undefined, false, true), '待填写单价 · 尚无价格来源');
  assert.equal(describePriceSource(undefined), '用户手工报价 · 日期未注明');
  assert.match(describePriceSource(effective, true), /^Demo/);
  assert.deepEqual(input, before);
});

test('source records validate calendar dates, URL schemes, credentials, control text and explicit refresh mapping', () => {
  const valid = provenance({ priceDate: '2024-02-29' }), before = structuredClone(valid);
  assert.deepEqual(normalizePriceProvenance(valid), valid);
  assert.deepEqual(valid, before);
  assert.equal(normalizePriceProvenance(undefined), undefined);
  assert.equal(normalizePriceProvenance(null), undefined);
  for (const invalid of [[], '', 42, {}, { source: ' ' }, provenance({ source: 'bad\u0000source' }), provenance({ supplier: 'a\u0007b' }), provenance({ manual: 'true' }), provenance({ priceDate: '2026-02-29' }), provenance({ priceDate: '2026-13-01' }), provenance({ priceDate: '2026-11-31' }), provenance({ updatedAt: 'not-a-date' })]) assert.throws(() => normalizePriceProvenance(invalid));
  for (const sourceUrl of ['javascript:alert(1)', 'data:text/plain,quote', 'file:///quote.csv', 'ftp://example.org/prices', 'https://user:password@example.org/prices']) assert.throws(() => normalizePriceProvenance(provenance({ sourceUrl })));
  for (const refresh of [null, [], { kind: 'unknown', url: webURL }, { kind: 'web', url: 'javascript:alert(1)' }, { kind: 'web', url: webURL, tableIndex: 101 }, { kind: 'web', url: webURL, hasHeader: 'true' }, { kind: 'web', url: webURL, mapping: [] }, { kind: 'web', url: webURL, mapping: { name: 0, unit: 1 } }, { kind: 'web', url: webURL, mapping: { name: 0, unit: 1, price: -1 } }, { kind: 'web', url: webURL, mapping: { name: 0, unit: 1, price: 2, unexpected: 3 } }]) assert.throws(() => normalizePriceProvenance(provenance({ refresh })));
});

test('invalid incoming provenance rejects a complete source-price batch before any existing source is changed', () => {
  const p = fullFixture(), before = structuredClone(p), rows = collectProjectSourceRows(p);
  const bad = catalogMaterial(rows[1].unit, { provenance: provenance({ priceDate: '2026-02-29' }) });
  assert.throws(() => applyProjectMaterialPrices(p, [linkedChange(rows[0]), linkedChange(rows[1], bad)]), /报价日期/);
  assert.deepEqual(p, before);
});

test('linked provenance reaches calculated line items and CSV for every primary source scope without changing quoted names', () => {
  const p = fullFixture(), rows = collectProjectSourceRows(p), materials = rows.map((row, index) => catalogMaterial(row.unit, { id: 'csv-' + index, provenance: provenance({ source: '来源记录-' + index, originalUnit: row.unit }) }));
  const next = applyProjectMaterialPrices(p, rows.map((row, index) => linkedChange(row, materials[index]))), budget = calculateProjectBudget(next);
  const csv = projectBudgetToCSV(next, budget);
  for (const [index, row] of rows.entries()) {
    const refreshed = sourceRow(next, candidate => candidate.id === row.id);
    assert.deepEqual(refreshed.provenance, materials[index].provenance);
    assert.ok(csv.includes('来源记录-' + index), `${row.targetType} / ${row.levelName ?? '场地'} 来源应透传CSV`);
    assert.ok(csv.includes(row.name), '原工程计价项目名称不得被材料库来源名覆盖');
  }
  assert.match(csv, /2026-11-01/); assert.match(csv, /杭州/); assert.match(csv, /用户确认规格/);
});

test('manual changes are reported truthfully by computed budget items and CSV rather than attributed to the former web quote', () => {
  const p = fixture({ regions: [room()] }), linked = applyProjectMaterialPrices(p, [linkedChange(sourceRow(p, row => row.targetType === 'region'))]);
  linked.regions[0].items[0].unitPrice = '125';
  const quote = calculateProject(linked), metadata = quote.regions[0].items[0].provenance;
  assert.deepEqual(metadata, { source: '用户调整单价', spec: '用户确认规格', region: '杭州' });
  const csv = projectBudgetToCSV(linked);
  assert.match(csv, /用户调整单价/);
  assert.doesNotMatch(csv, /当地供应商报价|实际厂家|2026-11-01/);
});

test('memory save, JSON export and reload preserve linked source ids, original prices, provenance mappings and all recalculated quantities', async () => {
  const p = fullFixture(), rows = collectProjectSourceRows(p), next = applyProjectMaterialPrices(p, rows.map(row => linkedChange(row)));
  const beforeRows = collectProjectSourceRows(next), beforeBudget = calculateProjectBudget(next), store = createMemoryProjectStore();
  await store.saveProject(next);
  const saved = await store.loadProject(next.id), json = await exportProjectJSON(next), imported = await importProjectJSON(json);
  for (const restored of [saved, imported]) {
    assert.equal(calculateProjectBudget(restored).total, beforeBudget.total);
    assert.deepEqual(collectProjectSourceRows(restored), beforeRows);
    assert.deepEqual(unchangedExceptPrices(restored.regions), unchangedExceptPrices(next.regions));
    assert.equal(restored.regions[0].items[0].priceSourceUnitPrice, '88.605');
    assert.equal(restored.regions[0].items[0].priceMaterialId, 'source-m²');
    assert.deepEqual(restored.regions[0].items[0].provenance.refresh.mapping, next.regions[0].items[0].provenance.refresh.mapping);
    assert.match(projectBudgetToCSV(restored), /当地供应商报价.*2026-11-01.*杭州/);
  }
});

test('professional civil and municipal CSV and printable reports carry the real source and date safely', () => {
  const p = fullFixture(), rows = collectProjectSourceRows(p);
  const next = applyProjectMaterialPrices(p, rows.map(row => linkedChange(row)));
  for (const mode of ['civil', 'municipal']) {
    const current = { ...next, workspaceMode: mode };
    const csv = projectToCSV(current), html = renderExportHTML(current, { includeDrawing: false });
    assert.match(csv, /当地供应商报价/); assert.match(csv, /2026-11-01/);
    assert.match(csv, /实际厂家/); assert.match(csv, /https:\/\/supplier\.example\/prices/);
    assert.match(html, /当地供应商报价/); assert.match(html, /2026-11-01/);
    assert.match(html, /https:\/\/supplier\.example\/prices/);
  }
});
