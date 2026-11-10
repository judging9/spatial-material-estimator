import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const modules = process.env.MUNICIPAL_CATALOG_BUILD
  ? pathToFileURL(join(resolve(process.env.MUNICIPAL_CATALOG_BUILD), 'lib') + '/')
  : new URL('../static/studio/lib/', import.meta.url);
const [catalog, design, pricing, budget, quantities, priceEdit, persistence, exporting, municipalExport] = await Promise.all([
  'municipal-catalog.js', 'municipal-design.js', 'municipal-pricing.js', 'project-budget.js',
  'project-quantities.js', 'project-price-edit.js', 'persistence.js', 'export.js', 'municipal-export.js',
].map(file => import(new URL(file, modules))));
const { createMunicipalCatalogElement, municipalCatalogPreset } = catalog;
const { createMunicipalLayer, municipalMetrics } = design;
const { calculateMunicipalProject } = pricing;
const { calculateProjectBudget } = budget;
const { calculateProjectQuantities } = quantities;
const { collectProjectPriceRows, applyProjectPriceChanges, previewProjectPriceChanges } = priceEdit;
const { createMemoryProjectStore, exportProjectJSON, importProjectJSON } = persistence;
const { municipalToCSV, renderMunicipalQuoteHTML } = municipalExport;
const { csvCell, escapeHTML } = exporting;

const fixture = () => ({
  version: 1, id: 'catalog-budget', name: '市政设施预算', workspaceMode: 'municipal',
  drawing: { id: 'site', type: 'plan', name: '用户尺寸场地', width: 60000, height: 50000, url: 'data:image/png;base64,iVBORw0KGgo=' },
  calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [],
  additionalCost: '0', taxRate: '0', budget: { included: { decoration: false, civil: false, municipal: true } },
  view: { labels: true, drawingOpacity: 1 },
});
const bench = p => createMunicipalCatalogElement('street-bench', [{ x: 5000, y: 5000 }], p,
  { quantity: '3', unitPrice: '12.345', wasteRate: '5', laborRate: '2.1', additionalCost: '1.20', rotation: 37 });
const fence = p => createMunicipalCatalogElement('site-fence', [{ x: 10000, y: 5000 }, { x: 10300, y: 5400 }], p,
  { quantity: '2', unitPrice: '12.345', wasteRate: '7.5', laborRate: '2.25', additionalCost: '3.10' });
const pavingPoints = [{ x: 15000, y: 5000 }, { x: 15600, y: 5000 }, { x: 15500, y: 5400 }, { x: 15100, y: 5400 }];
const paving = p => createMunicipalCatalogElement('sidewalk', pavingPoints, p,
  { unitPrice: '1.235', wasteRate: '10', laborRate: '.125', additionalCost: '.33' });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-8, `${actual} != ${expected}`);
const main = p => calculateMunicipalProject(p).municipalElements[0].items[0];
const geometry = element => {
  const { unitPrice, wasteRate, laborRate, ...rest } = element;
  return rest;
};

test('catalog piece quantities use user count, waste and labor with separately rounded cents', () => {
  const p = fixture(); p.municipalElements = [bench(p)];
  const before = structuredClone(p), row = calculateMunicipalProject(p).municipalElements[0], item = row.items[0];
  assert.equal(item.name, municipalCatalogPreset('street-bench').name);
  assert.equal(item.netQuantity, '3'); assert.equal(item.purchaseQuantity, '3.15');
  assert.equal(item.materialCost, '38.89'); assert.equal(item.laborCost, '6.30');
  assert.equal(row.additionalCost, '1.20'); assert.equal(row.total, '46.39');
  assert.deepEqual(p, before);
});

test('catalog fences use real diagonal length rather than bounding box or scene count', () => {
  const p = fixture(); p.municipalElements = [fence(p)];
  near(municipalMetrics(p.municipalElements[0], p).length, 5);
  const item = main(p);
  assert.equal(item.netQuantity, '10'); assert.equal(item.purchaseQuantity, '10.75');
  assert.equal(item.materialCost, '132.71'); assert.equal(item.laborCost, '22.50');
  assert.equal(calculateMunicipalProject(p).total, '158.31');
});

test('catalog paving uses actual irregular polygon area and true thickness for cubic units', () => {
  const p = fixture(); p.municipalElements = [paving(p)];
  near(municipalMetrics(p.municipalElements[0], p).area, 20);
  let item = main(p);
  assert.equal(item.netQuantity, '20'); assert.equal(item.purchaseQuantity, '22');
  assert.equal(item.materialCost, '27.17'); assert.equal(item.laborCost, '2.50');
  assert.equal(calculateMunicipalProject(p).total, '30.00');
  Object.assign(p.municipalElements[0], { unit: 'm³', height: 3, quantity: '2', unitPrice: '9.995', wasteRate: '0' });
  near(municipalMetrics(p.municipalElements[0], p).volume, .6);
  item = main(p);
  assert.equal(item.netQuantity, '1.2'); assert.equal(item.materialCost, '11.99'); assert.equal(item.laborCost, '0.15');
  assert.equal(calculateMunicipalProject(p).total, '12.47');
});

test('catalog assets reconcile discipline, project budget and quantities with fixed fees and tax counted once', () => {
  const p = fixture(); p.additionalCost = '2.05'; p.taxRate = '6'; p.municipalElements = [bench(p), fence(p), paving(p)];
  const quote = calculateMunicipalProject(p), total = calculateProjectBudget(p), q = calculateProjectQuantities(p);
  assert.equal(quote.materialCost, '198.77'); assert.equal(quote.laborCost, '31.30');
  assert.equal(quote.additionalCost, '6.68'); assert.equal(quote.subtotal, '236.75');
  assert.equal(quote.tax, '14.21'); assert.equal(quote.total, '250.96');
  assert.deepEqual(total.includedSections, ['municipal']); assert.equal(total.itemCount, 3);
  assert.equal(total.beforeTax, '236.75'); assert.equal(total.total, quote.total);
  assert.equal(q.totals.total, total.total); assert.equal(q.groups.length, 3);
  assert.equal(q.totals.objectAdditionalCost, '4.63'); assert.equal(q.totals.projectAdditionalCost, '2.05');
  assert.equal(q.groups.find(group => group.unit === '件').category, 'equipment');
  assert.equal(q.groups.find(group => group.unit === 'm').category, 'construction');
  p.municipalElements.forEach(element => element.hidden = true);
  assert.equal(calculateProjectBudget(p).total, total.total);
});

test('blank catalog price remains pending while explicit zero preserves known labor and fixed fees', () => {
  const p = fixture(); p.municipalElements = [bench(p)]; p.municipalElements[0].unitPrice = '';
  let total = calculateProjectBudget(p), q = calculateProjectQuantities(p);
  assert.equal(total.total, null); assert.equal(total.status, 'pending'); assert.equal(total.knownTotal, '7.50');
  assert.equal(q.groups[0].unitPrice, ''); assert.equal(q.groups[0].netQuantity, '3');
  assert.equal(q.groups[0].knownLaborCost, '6.30'); assert.equal(q.totals.total, null);
  p.municipalElements[0].unitPrice = '0';
  total = calculateProjectBudget(p); q = calculateProjectQuantities(p);
  assert.equal(total.status, 'ready'); assert.equal(total.total, '7.50');
  assert.equal(q.groups[0].pending, false); assert.equal(q.groups[0].unitPrice, '0');
});

test('catalog identity and dimensions distinguish procurement while position, custom name and rotation do not split one SKU', () => {
  const p = fixture(), first = createMunicipalCatalogElement('street-bench', [{ x: 5000, y: 5000 }], p, { name: '现场设施', unitPrice: '10', rotation: 0 });
  const second = createMunicipalCatalogElement('street-bench', [{ x: 10000, y: 5000 }], p, { name: '现场设施', unitPrice: '10', quantity: '2', rotation: -37 });
  const bin = createMunicipalCatalogElement('litter-bin', [{ x: 15000, y: 5000 }], p,
    { name: '现场设施', unitPrice: '10', width: first.width, depth: first.depth, height: first.height });
  p.municipalElements = [first, second, bin];
  let q = calculateProjectQuantities(p);
  assert.equal(q.groups.length, 2);
  const chairs = q.groups.find(group => group.materialName === municipalCatalogPreset('street-bench').name);
  assert.equal(chairs.sourceCount, 2); assert.equal(chairs.netQuantity, '3'); assert.equal(chairs.knownTotal, '30.00');
  assert.equal(new Set(q.groups.map(group => group.materialName)).size, 2);
  second.width += 10;
  q = calculateProjectQuantities(p); assert.equal(q.groups.length, 3);
});

test('identically named construction layers of different catalog paving presets remain separate', () => {
  const p = fixture(), layer = () => ({ ...createMunicipalLayer('用户铺装层', 3), unitPrice: '2', laborRate: '.5' });
  const a = createMunicipalCatalogElement('sidewalk', [{ x: 5000, y: 5000 }], p, { name: '铺装', width: 400, depth: 300, height: 20, unitPrice: '0', items: [layer()] });
  const b = createMunicipalCatalogElement('bicycle-lane', [{ x: 10000, y: 5000 }], p, { name: '铺装', width: 400, depth: 300, height: 20, unitPrice: '0', items: [layer()] });
  p.municipalElements = [a, b];
  const groups = calculateProjectQuantities(p).groups;
  assert.equal(groups.length, 4); assert.equal(groups.filter(group => group.materialName === '用户铺装层').length, 2);
  assert.ok(groups.every(group => group.sourceCount === 1));
});

test('catalog bulk price changes preserve original geometry, rotation, count and fees and recompute budget', () => {
  const p = fixture(); p.additionalCost = '2.05'; p.taxRate = '6'; p.municipalElements = [bench(p)];
  const before = structuredClone(p), row = collectProjectPriceRows(p)[0];
  assert.match(row.spec, new RegExp(municipalCatalogPreset('street-bench').name));
  assert.deepEqual(row.editableFields, ['unitPrice', 'wasteRate', 'laborRate']);
  const changes = [{ rowId: row.id, expected: row.values, values: { unitPrice: '5', wasteRate: '10', laborRate: '1.25' } }];
  const preview = previewProjectPriceChanges(p, changes), updated = applyProjectPriceChanges(p, changes);
  assert.equal(preview.changedRows, 1); assert.equal(preview.before.total, '51.35'); assert.equal(preview.after.total, '24.91');
  assert.equal(calculateProjectBudget(updated).total, '24.91');
  assert.deepEqual(geometry(updated.municipalElements[0]), geometry(before.municipalElements[0]));
  assert.deepEqual(p, before); assert.deepEqual(updated, preview.project);
  assert.throws(() => applyProjectPriceChanges(updated, changes), /已被其他操作修改/);
});

test('saving and full project JSON preserve catalog geometry and decimal prices; imported summaries are recomputed', async () => {
  const p = fixture(); p.additionalCost = '2.05'; p.taxRate = '6'; p.municipalElements = [bench(p), fence(p), paving(p)];
  const expectedElements = structuredClone(p.municipalElements), store = createMemoryProjectStore();
  await store.saveProject(p);
  p.municipalElements[0].unitPrice = '999';
  const loaded = await store.loadProject(p.id, { hydrateDrawing: false });
  assert.deepEqual(loaded.municipalElements, expectedElements); assert.equal(calculateProjectBudget(loaded).total, '250.96');
  const json = JSON.parse(await exportProjectJSON(loaded));
  assert.equal(json.quoteSummary.total, '250.96'); assert.equal(json.budgetSummary.total, '250.96');
  json.quoteSummary.total = '0.01'; json.budgetSummary.total = '0.01';
  const restored = await importProjectJSON(JSON.stringify(json));
  assert.deepEqual(restored.municipalElements, expectedElements);
  assert.equal(calculateProjectBudget(restored).total, '250.96'); assert.equal(calculateProjectQuantities(restored).totals.total, '250.96');
  assert.equal(restored.municipalElements[0].unitPrice, '12.345'); assert.equal(restored.municipalElements[0].rotation, 37);
});

test('catalog quote exports preserve facility identity, real quantity and user price alongside escaped names', () => {
  const p = fixture(); p.municipalElements = [bench(p)]; p.municipalElements[0].name = '定制长椅 <script>&';
  const quote = calculateMunicipalProject(p), csv = municipalToCSV(p, quote, csvCell), html = renderMunicipalQuoteHTML(p, quote, { includeDrawing: true }, escapeHTML);
  assert.ok(csv.includes(municipalCatalogPreset('street-bench').name)); assert.ok(csv.includes('12.345'));
  assert.ok(csv.includes('3.15')); assert.ok(csv.includes('46.39'));
  assert.ok(html.includes(municipalCatalogPreset('street-bench').name)); assert.ok(html.includes('46.39'));
  assert.ok(csv.includes('朝向 37°')); assert.ok(html.includes('朝向 37°'));
  assert.ok(html.includes('fill="' + municipalCatalogPreset('street-bench').color + '"'));
  assert.ok(html.includes('&lt;script&gt;&amp;')); assert.ok(!html.includes('定制长椅 <script>'));
  assert.ok(html.includes('data-municipal-element-id="' + p.municipalElements[0].id + '"'));
});
