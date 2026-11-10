import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const modules = process.env.MUNICIPAL_CATALOG_BUILD ? pathToFileURL(join(resolve(process.env.MUNICIPAL_CATALOG_BUILD), 'lib') + '/') : new URL('../static/studio/lib/', import.meta.url);
const [catalog, design, scene, pricing, persistence] = await Promise.all(['municipal-catalog.js', 'municipal-design.js', 'municipal-scene.js', 'municipal-pricing.js', 'persistence.js'].map(file => import(new URL(file, modules))));
const { MUNICIPAL_CATALOG, municipalCatalogPreset, searchMunicipalCatalog, createMunicipalCatalogElement } = catalog;
const { municipalMetrics, municipalFootprints, municipalElementPreset, validateMunicipalElements } = design;
const { buildSceneMunicipal } = scene;
const { calculateMunicipalProject } = pricing;
const fixture = () => ({ version: 1, id: 'city-catalog-test', name: '城市设施', workspaceMode: 'municipal', drawing: { id: 'plan', name: '真实尺寸场地', type: 'plan', width: 60000, height: 50000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vertices = model => [...model.horizontal.flatMap(face => [...face.points, ...face.holes.flat()]), ...model.surfaces.flatMap(face => face.points)];

test('catalog lookup and search do not supply market prices or mutate preset data', () => {
  assert.equal(new Set(MUNICIPAL_CATALOG.map(item => item.id)).size, MUNICIPAL_CATALOG.length);
  assert.ok(MUNICIPAL_CATALOG.length >= 30);
  assert.ok(searchMunicipalCatalog('充电', 'transport').some(item => item.id === 'ev-charger'));
  assert.deepEqual(searchMunicipalCatalog('充电', 'landscape'), []);
  assert.deepEqual(searchMunicipalCatalog('无此设施'), []);
  assert.throws(() => municipalCatalogPreset('invented'), /预设不存在/);
  assert.ok(MUNICIPAL_CATALOG.every(item => !Object.hasOwn(item, 'unitPrice')));
});

for (const preset of MUNICIPAL_CATALOG) test(`${preset.name} uses editable real extents, valid geometry and pending user prices`, () => {
  const p = fixture(), element = createMunicipalCatalogElement(preset.id, [{ x: 5000, y: 5000 }], p);
  p.municipalElements = [element];
  const before = structuredClone(p), model = buildSceneMunicipal(p)[0], quote = calculateMunicipalProject(p);
  assert.equal(element.catalogId, preset.id); assert.equal(element.unitPrice, ''); assert.equal(element.unit, preset.unit);
  assert.equal(municipalElementPreset(element).name, preset.name); assert.equal(municipalElementPreset(element).color, preset.color);
  assert.equal(quote.total, null); assert.match(quote.pendingReason, /单价/);
  const points = vertices(model); assert.ok(points.length > 0);
  assert.ok(points.every(point => [point.x, point.y, point.z].every(Number.isFinite)));
  assert.ok(model.surfaces.every(surface => surface.wallId === 'municipal:' + element.id && Object.values(surface.normal).every(Number.isFinite)));
  if (element.kind === 'facility') {
    const anchor = { x: element.points[0].x * .01, y: element.elevation / 100, z: element.points[0].y * .01 };
    assert.ok(points.every(point => Math.abs(point.x - anchor.x) <= element.width / 200 + 1e-8));
    assert.ok(points.every(point => Math.abs(point.z - anchor.z) <= element.depth / 200 + 1e-8));
    assert.ok(points.every(point => point.y >= anchor.y - 1e-8 && point.y <= anchor.y + element.height / 100 + 1e-8));
    assert.equal(quote.municipalElements[0].netQuantity, '1');
  } else if (element.kind === 'paving') near(municipalMetrics(element, p).area, preset.width * preset.depth / 10000);
  else if (element.kind === 'fence') near(municipalMetrics(element, p).length, preset.depth / 100);
  assert.deepEqual(p, before);
});

test('point asset rotation changes actual footprint and scene without changing piece cost', () => {
  const p = fixture(), element = createMunicipalCatalogElement('street-bench', [{ x: 5000, y: 5000 }], p, { rotation: -37, width: 240, depth: 80, height: 100, unitPrice: '100.105', laborRate: '5', additionalCost: '3' });
  p.municipalElements = [element];
  const before = structuredClone(p), first = municipalFootprints(element, p), model = buildSceneMunicipal(p)[0];
  near(municipalMetrics(element, p).area, 1.92);
  const angle = element.rotation * Math.PI / 180, center = { x: 50, z: 50 };
  for (const point of vertices(model)) {
    const x = Math.cos(angle) * (point.x - center.x) + Math.sin(angle) * (point.z - center.z), z = -Math.sin(angle) * (point.x - center.x) + Math.cos(angle) * (point.z - center.z);
    assert.ok(Math.abs(x) <= 1.2 + 1e-8); assert.ok(Math.abs(z) <= .4 + 1e-8); assert.ok(point.y >= -1e-8 && point.y <= 1 + 1e-8);
  }
  const total = calculateMunicipalProject(p).total; assert.equal(total, '108.11');
  p.municipalElements[0].rotation = 90;
  assert.notDeepEqual(municipalFootprints(p.municipalElements[0], p), first); assert.equal(calculateMunicipalProject(p).total, total);
  near(municipalFootprints(p.municipalElements[0], p)[0].points[0].x, 5040);
  assert.deepEqual(before.municipalElements[0].points, element.points);
});

test('quoted count, price and visibility never create extra street furniture placements', () => {
  const p = fixture(), element = createMunicipalCatalogElement('ev-charger', [{ x: 5000, y: 5000 }], p, { quantity: '4', unitPrice: '12.345', laborRate: '2.1', wasteRate: '5', additionalCost: '3' });
  p.municipalElements = [element];
  assert.equal(buildSceneMunicipal(p).length, 1); assert.equal(calculateMunicipalProject(p).total, '63.25');
  const originalModel = buildSceneMunicipal(p)[0]; element.unitPrice = '90'; element.quantity = '9';
  assert.deepEqual(buildSceneMunicipal(p)[0], originalModel);
  const total = calculateMunicipalProject(p).total; element.hidden = true;
  assert.deepEqual(buildSceneMunicipal(p), []); assert.equal(calculateMunicipalProject(p).total, total);
});

test('uncalibrated image keeps real user piece count, while no guessed scene or area is emitted', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  const element = createMunicipalCatalogElement('litter-bin', [{ x: 5000, y: 5000 }], p, { quantity: '3', unitPrice: '15.5' }); p.municipalElements = [element];
  assert.equal(calculateMunicipalProject(p).total, '46.50'); assert.deepEqual(buildSceneMunicipal(p), []); assert.equal(municipalMetrics(element, p).area, null);
  assert.throws(() => createMunicipalCatalogElement('sidewalk', [{ x: 5000, y: 5000 }], p), /图纸比例/);
  assert.throws(() => createMunicipalCatalogElement('road-guardrail', [{ x: 5000, y: 5000 }], p), /图纸比例/);
});

test('catalog mismatch, duplicate identifiers, invalid geometry and invalid monetary values are rejected', () => {
  const p = fixture(), element = createMunicipalCatalogElement('street-bench', [{ x: 5000, y: 5000 }], p);
  for (const mutate of [item => item.catalogId = 'unknown', item => item.catalogId = 'sidewalk', item => item.rotation = NaN, item => item.rotation = 36001, item => item.width = -1, item => item.unitPrice = '-1']) {
    const next = structuredClone(element); mutate(next); assert.throws(() => validateMunicipalElements([next], p));
  }
  assert.throws(() => validateMunicipalElements([element, element], p), /编号/);
  assert.throws(() => createMunicipalCatalogElement('street-bench', [{ x: 10, y: 10 }], p, { rotation: 37 }), /范围/);
  const fence = createMunicipalCatalogElement('site-fence', [{ x: 5000, y: 5000 }, { x: 5500, y: 5400 }], p);
  assert.throws(() => validateMunicipalElements([{ ...fence, rotation: 12 }], p), /朝向/);
});

test('fences use original oblique path lengths and preserve real heights at shallow extreme dimensions', () => {
  const p = fixture(), fence = createMunicipalCatalogElement('site-fence', [{ x: 5000, y: 5000 }, { x: 5300, y: 5400 }, { x: 5900, y: 5400 }], p, { unitPrice: '10', height: .1 }); p.municipalElements = [fence];
  near(municipalMetrics(fence, p).length, 11); assert.equal(calculateMunicipalProject(p).total, '110.00');
  const model = buildSceneMunicipal(p)[0]; near(model.segments.reduce((sum, segment) => sum + segment.length, 0), 11);
  assert.ok(vertices(model).every(point => point.y >= -1e-8 && point.y <= .001 + 1e-8));
});

test('fence posts stay inside the actual butt-capped occupied boundary, including paths ending at the canvas limit', () => {
  const p = fixture(), fence = createMunicipalCatalogElement('site-fence', [{ x: 59500, y: 5000 }, { x: 60000, y: 5000 }], p); p.municipalElements = [fence];
  const model = buildSceneMunicipal(p)[0];
  assert.ok(vertices(model).every(point => point.x <= 600 + 1e-8 && point.x >= 595 - 1e-8));
  assert.ok(vertices(model).every(point => Math.abs(point.z - 50) <= fence.width / 200 + 1e-8));
  const short = createMunicipalCatalogElement('site-fence', [{ x: 5000, y: 5000 }, { x: 5001, y: 5000 }], p); p.municipalElements = [short];
  assert.ok(vertices(buildSceneMunicipal(p)[0]).every(point => point.x >= 50 - 1e-8 && point.x <= 50.01 + 1e-8));
});

test('catalog names, geometry, rotation and decimal prices survive save, JSON and budget recomputation', async () => {
  const p = fixture();
  p.municipalElements = [createMunicipalCatalogElement('public-toilet', [{ x: 5000, y: 5000 }], p, { rotation: -23, unitPrice: '10000.105' }), createMunicipalCatalogElement('site-fence', [{ x: 7000, y: 5000 }, { x: 8000, y: 5000 }], p, { unitPrice: '10.1' })];
  const total = calculateMunicipalProject(p).total, store = persistence.createMemoryProjectStore(); await store.saveProject(p);
  const loaded = await store.loadProject(p.id), imported = await persistence.importProjectJSON(await persistence.exportProjectJSON(p));
  for (const result of [loaded, imported]) { assert.deepEqual(result.municipalElements, p.municipalElements); assert.equal(calculateMunicipalProject(result).total, total); assert.equal(buildSceneMunicipal(result).length, 2); }
});
