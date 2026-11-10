import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modules = process.env.TUNNEL_PRICING_BUILD ? pathToFileURL(resolve(process.env.TUNNEL_PRICING_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { createMunicipalElement } = await import(new URL('lib/municipal-design.js', modules));
const { createRoadProfile } = await import(new URL('lib/road-profile.js', modules));
const { roadTunnelAnalysis } = await import(new URL('lib/road-tunnel.js', modules));
const { calculateMunicipalProject } = await import(new URL('lib/municipal-pricing.js', modules));
const { municipalToCSV, renderMunicipalQuoteHTML } = await import(new URL('lib/municipal-export.js', modules));
const { collectProjectPriceRows, collectProjectSourceRows, applyProjectPriceChanges, applyProjectMaterialPrices } = await import(new URL('lib/project-price-edit.js', modules));
const { exportProjectJSON, importProjectJSON, createMemoryProjectStore } = await import(new URL('lib/persistence.js', modules));
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected}`);
const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function fixture(tunnelPatch = {}) {
  const project = { version: 1, id: 'tunnel-pricing', name: '实际隧道工程', workspaceMode: 'municipal',
    drawing: { id: 'plan', name: '场地', type: 'plan', width: 6000, height: 6000, url: 'data:image/png;base64,iVBORw0KGgo=' },
    calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 },
  };
  const road = createMunicipalElement('road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], project);
  Object.assign(road, { id: 'road', name: '山中道路', width: 200, height: 10, unitPrice: '0', laborRate: '0', wasteRate: '0', additionalCost: '0', quantity: '2',
    tunnel: { enabled: true, startStation: 2, endStation: 8, clearHeight: 4, liningThickness: .4, shape: 'box', pricingEnabled: true, unitPrice: '10', laborRate: '2', additionalCost: '3', ...tunnelPatch },
  });
  project.municipalElements = [road]; return project;
}
const tunnelRow = quote => {
  const row = quote.municipalElements[0].items.find(item => item.category === 'tunnel');
  assert.ok(row, '必须生成真实隧道计价分项'); return row;
};
const priceRow = project => {
  const row = collectProjectPriceRows(project).find(row => row.itemId === 'road:tunnel');
  assert.ok(row, '必须找到原始隧道报价绑定'); return row;
};

test('tunnel quantities use the actual interval, multiply only measured quantities and preserve ordinary road pavement scope', () => {
  const project = fixture(), before = structuredClone(project), quote = calculateMunicipalProject(project), row = tunnelRow(quote), road = quote.municipalElements[0];
  assert.equal(row.id, 'road:tunnel'); assert.equal(row.unit, 'm'); assert.equal(row.quantityBasis, '真实三维隧道路线长度 × 预算份数，按米综合计价');
  near(row.measuredLength, 6); assert.equal(row.netQuantity, '12'); assert.equal(row.purchaseQuantity, '12'); assert.equal(row.wasteRate, '0');
  assert.equal(row.materialCost, '120.00'); assert.equal(row.laborCost, '24.00'); assert.equal(row.additionalCost, '3.00'); assert.equal(row.total, '147.00');
  assert.equal(quote.total, '147.00'); near(road.area, 20); assert.equal(road.items[0].netQuantity, '40');
  near(road.tunnelEngineering.length, 6); near(road.tunnelEngineering.netWidth, 2); near(road.tunnelEngineering.clearHeight, 4);
  assert.deepEqual(project, before);
});

test('a sloping tunnel is priced by exact spatial length instead of horizontal chainage, with no zoom-dependent multiplier', () => {
  const project = fixture(), road = project.municipalElements[0]; road.roadProfile = createRoadProfile(project, road);
  road.roadProfile.points[0].elevation = 0; road.roadProfile.points[1].elevation = 7.5; road.roadProfile.enabled = true;
  const quote = calculateMunicipalProject(project), row = tunnelRow(quote), analysis = roadTunnelAnalysis(project, road);
  near(analysis.horizontalLength, 6); near(analysis.length, Math.hypot(6, 4.5)); assert.equal(row.netQuantity, '15');
  assert.equal(row.materialCost, '150.00'); assert.equal(row.laborCost, '30.00'); assert.equal(quote.total, '183.00');
  project.view.zoom = 80; project.view.pan = { x: 100, y: -300 }; assert.deepEqual(tunnelRow(calculateMunicipalProject(project)), row);
});

test('decimal tunnel rates, fixed fees and project tax round to cents at their respective scopes', () => {
  const project = fixture({ unitPrice: '100.105', laborRate: '20.015', additionalCost: '5.555' }); project.additionalCost = '7.005'; project.taxRate = '6';
  const quote = calculateMunicipalProject(project), row = tunnelRow(quote);
  assert.equal(row.materialCost, '1201.26'); assert.equal(row.laborCost, '240.18'); assert.equal(row.additionalCost, '5.56'); assert.equal(row.total, '1447.00');
  assert.equal(quote.projectAdditionalCost, '7.01'); assert.equal(quote.additionalCost, '12.57'); assert.equal(quote.subtotal, '1454.01'); assert.equal(quote.tax, '87.24'); assert.equal(quote.total, '1541.25');
});

test('a blank tunnel rate remains pending while known labor and fixed fees remain visible; explicit zero is a valid rate', () => {
  const project = fixture({ unitPrice: '' }), pending = calculateMunicipalProject(project), row = tunnelRow(pending);
  assert.equal(row.materialCost, null); assert.equal(row.laborCost, '24.00'); assert.equal(row.knownTotal, '27.00'); assert.equal(row.total, null);
  assert.equal(pending.total, null); assert.equal(pending.knownSubtotal, '27.00'); assert.match(row.pendingReason, /隧道.*单价/);
  project.municipalElements[0].tunnel.unitPrice = '0'; assert.equal(calculateMunicipalProject(project).total, '27.00');
});

test('disabled independent pricing preserves tunnel engineering without manufacturing a price or charging its fixed fee', () => {
  const project = fixture({ pricingEnabled: false, unitPrice: '', additionalCost: '500' }), quote = calculateMunicipalProject(project);
  assert.equal(quote.total, '0.00'); assert.equal(quote.municipalElements[0].items.some(item => item.category === 'tunnel'), false);
  assert.equal(quote.municipalElements[0].tunnelEngineering.enabled, true); assert.equal(collectProjectPriceRows(project).some(row => row.itemId === 'road:tunnel'), false);
  project.municipalElements[0].tunnel.enabled = false; const disabled = calculateMunicipalProject(project);
  assert.equal(disabled.total, '0.00'); assert.equal(disabled.municipalElements[0].tunnelEngineering, undefined);
});

test('missing calibration keeps spatial tunnel quantity unknown and excludes imaginary labor or material costs', () => {
  const project = fixture(); project.drawing.type = 'image'; project.calibration.metersPerPixel = null;
  const quote = calculateMunicipalProject(project), row = tunnelRow(quote);
  assert.equal(row.netQuantity, null); assert.equal(row.purchaseQuantity, null); assert.equal(row.measuredLength, null);
  assert.equal(row.materialCost, null); assert.equal(row.laborCost, null); assert.equal(row.knownTotal, '3.00'); assert.equal(quote.total, null);
  assert.match(row.pendingReason, /校准/);
});

test('tunnel interval is removed from ordinary soil excavation while the full road pavement stays in the primary item', () => {
  const project = fixture(), road = project.municipalElements[0];
  project.municipalTerrain = { name: '真实测量高程', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 5 }, { id: 'b', x: 50, y: 0, z: 5 }, { id: 'c', x: 50, y: 50, z: 5 }, { id: 'd', x: 0, y: 50, z: 5 }] };
  road.roadProfile = createRoadProfile(project, road); road.roadProfile.enabled = true; road.roadProfile.earthwork = { enabled: true, cutUnitPrice: '1', fillUnitPrice: '0' };
  const quote = calculateMunicipalProject(project), priced = quote.municipalElements[0], earth = priced.roadEngineering.earthworks;
  near(priced.area, 20); near(earth.designArea, 8); near(earth.coveredArea, 8); near(earth.cutVolume, 40.8);
  assert.equal(priced.items.find(item => item.id === 'road:cutVolume').materialCost, '81.60'); assert.equal(quote.total, '228.60');
  assert.ok(quote.warnings.some(warning => /隧道.*普通路床挖填/.test(warning)));
});

test('project quote editing binds tunnel rates independently and rejects waste, stale edits and disabled fee scopes', () => {
  const project = fixture(), original = structuredClone(project), selected = priceRow(project);
  assert.deepEqual(selected.editableFields, ['unitPrice', 'laborRate']); assert.match(selected.spec, /矩形隧道.*2–8 m.*4 m/); assert.equal(selected.sourceLinkable, true);
  const updated = applyProjectPriceChanges(project, [{ rowId: selected.id, values: { unitPrice: '11', laborRate: '3' }, expected: { unitPrice: '10', laborRate: '2' } }]);
  assert.equal(calculateMunicipalProject(updated).total, '171.00'); assert.equal(updated.municipalElements[0].tunnel.additionalCost, '3');
  assert.deepEqual(updated.municipalElements[0].points, project.municipalElements[0].points); assert.deepEqual(project, original);
  assert.throws(() => applyProjectPriceChanges(project, [{ rowId: selected.id, values: { wasteRate: '5' } }]));
  assert.throws(() => applyProjectPriceChanges(updated, [{ rowId: selected.id, values: { unitPrice: '20' }, expected: { unitPrice: '10' } }]), /修改/);
  const disabled = fixture({ pricingEnabled: false }); assert.throws(() => applyProjectPriceChanges(disabled, [{ rowId: selected.id, values: { unitPrice: '20' } }]));
});

test('same-unit source association preserves engineering, records tunnel price provenance and handles manual overrides honestly', () => {
  const project = fixture(), original = structuredClone(project), row = priceRow(project), material = { id: 'tunnel-source', name: '实际供应商隧道综合价', category: '来源报价', image: '', unit: 'm', unitPrice: '21.5', wasteRate: '99', color: '#286850', description: '用户确认综合施工范围', demo: false,
    provenance: { source: '供应商确认报价', region: '杭州', spec: '用户确认隧道施工', priceDate: '2026-11-08', sourceUrl: 'https://supplier.example/tunnel' },
  };
  const linked = applyProjectMaterialPrices(project, [{ rowId: row.id, material, expectedPrice: '10', expectedMaterialId: null }]), tunnel = linked.municipalElements[0].tunnel;
  assert.equal(tunnel.unitPrice, '21.5'); assert.equal(tunnel.priceMaterialId, material.id); assert.equal(tunnel.priceSourceUnitPrice, '21.5'); assert.deepEqual(tunnel.provenance, material.provenance);
  assert.equal(tunnel.laborRate, '2'); assert.equal(tunnel.additionalCost, '3'); assert.equal(tunnel.clearHeight, 4); assert.equal(calculateMunicipalProject(linked).total, '285.00');
  assert.equal(tunnelRow(calculateMunicipalProject(linked)).provenance.source, '供应商确认报价'); assert.equal(collectProjectSourceRows(linked).find(row => row.itemId === 'road:tunnel').materialId, material.id);
  assert.throws(() => applyProjectMaterialPrices(project, [{ rowId: row.id, material: { ...material, unit: 'm²' }, expectedPrice: '10' }]), /单位/);
  const manual = applyProjectPriceChanges(linked, [{ rowId: row.id, values: { unitPrice: '22' } }]);
  assert.deepEqual(manual.municipalElements[0].tunnel.provenance, { source: '用户调整单价', spec: material.provenance.spec, region: material.provenance.region });
  const labor = applyProjectPriceChanges(linked, [{ rowId: row.id, values: { laborRate: '4' } }]); assert.deepEqual(labor.municipalElements[0].tunnel.provenance, material.provenance);
  assert.deepEqual(project, original);
});

test('CSV and printable PDF HTML include measured chainage, clearance, billing basis and traceable prices without fake thickness', () => {
  const project = fixture({ provenance: { source: '用户确认 <报价>', region: '杭州', priceDate: '2026-11-08', sourceUrl: 'https://supplier.example/tunnel' } }), quote = calculateMunicipalProject(project);
  const csv = municipalToCSV(project, quote, csvCell), html = renderMunicipalQuoteHTML(project, quote, { includeDrawing: false }, escape);
  for (const text of ['隧道综合施工', '隧道里程 2–8 m', '净宽 2 m / 净高 4 m', '三维隧道长度 6 m', '真实三维隧道路线长度 × 预算份数，按米综合计价', '隧道段覆土不计入普通路床挖填', '2026-11-08', 'https://supplier.example/tunnel']) { assert.ok(csv.includes(text), text); assert.ok(html.includes(text), text); }
  const tunnelCSV = csv.split('\r\n').find(line => line.startsWith('"市政分项"') && line.includes('"隧道综合施工"'));
  assert.match(tunnelCSV, /"m","真实三维隧道路线长度 × 预算份数，按米综合计价","12","12","10","0","2","120.00","24.00","3.00"/);
  assert.ok(!tunnelCSV.includes('本分项厚度 待校准')); assert.ok(html.includes('用户确认 &lt;报价&gt;')); assert.ok(!html.includes('用户确认 <报价>'));
  assert.ok(html.includes('隧道综合施工<p class="muted">')); assert.ok(html.includes('</td><td>m</td><td>—</td>'));
});

test('project save and JSON reload preserve tunnel geometry, independent pricing, source association and exact totals', async () => {
  const project = fixture({ priceMaterialId: 'actual-source', priceSourceUnitPrice: '10', provenance: { source: '实际合同', spec: '矩形施工', priceDate: '2026-11-08' } });
  const quote = calculateMunicipalProject(project), store = createMemoryProjectStore(); await store.saveProject(project);
  const saved = await store.loadProject(project.id), loaded = await importProjectJSON(await exportProjectJSON(project));
  for (const copy of [saved, loaded]) { assert.deepEqual(copy.municipalElements[0].tunnel, project.municipalElements[0].tunnel); assert.equal(calculateMunicipalProject(copy).total, quote.total); }
});
