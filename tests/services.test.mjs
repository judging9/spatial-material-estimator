import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.SERVICES_BUILD ? pathToFileURL(resolve(process.env.SERVICES_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { SERVICE_PRESETS, servicePreset, validateServiceRoutes, createServiceRoute, serviceMetrics, routeMetrics, nearestServicePoint } = await import(new URL('lib/services.js', root));
const { calculateProject } = await import(new URL('lib/pricing.js', root));
const { addLevel, ensureLevels, switchLevel, levelProjects, activeLevel, validateLevels } = await import(new URL('lib/levels.js', root));
const { createMemoryProjectStore, createHistory, exportProjectJSON, importProjectJSON, validateProject } = await import(new URL('lib/persistence.js', root));
const fixture = () => ({ version: 1, id: 'services-project', name: '真实水电管线', drawing: { id: 'plan', name: '平面图', type: 'plan', width: 2400, height: 1800, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01, method: 'metric-plan' }, regions: [], walls: [], wallHeight: 280, wallThickness: 20, additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const route = (patch = {}) => ({ ...createServiceRoute('bv25', [{ x: 0, y: 0, z: 0 }, { x: 300, y: 400, z: 0 }]), id: 'route-one', unitPrice: '10', ...patch });
const near = (a, b, eps = 1e-10) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('27 service presets include custom routes with explicit specifications and no fabricated prices', () => {
  assert.equal(SERVICE_PRESETS.length, 27); assert.equal(new Set(SERVICE_PRESETS.map(p => p.id)).size, 27);
  for (const preset of SERVICE_PRESETS) {
    const created = createServiceRoute(preset.id, [{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    assert.equal(created.unitPrice, ''); assert.equal(created.wasteRate, '0'); assert.equal(created.laborRate, '0');
    assert.equal(created.extraLength, '0'); assert.equal(created.additionalCost, '0'); assert.equal(created.runs, '1');
    assert.equal(created.spec, preset.spec); assert.equal(created.points[0].z, preset.defaultHeight);
    assert.doesNotThrow(() => validateServiceRoutes([created]));
  }
  assert.throws(() => servicePreset('random-pipe'), /预设/);
  assert.equal(servicePreset('custom-line').defaultHeight, 0); assert.equal(servicePreset('custom-line').diameter, 1);
});

test('creating a route copies real points and adds readable names for repeated presets', () => {
  const points = [{ x: 10, y: 20, z: 5 }, { x: 100, y: 20 }], first = createServiceRoute('ppr-cold20', points);
  points[0].x = 999;
  const second = createServiceRoute('ppr-cold20', [{ x: 0, y: 0 }, { x: 100, y: 0 }], { serviceRoutes: [first] });
  assert.equal(first.points[0].x, 10); assert.equal(first.points[0].z, 5); assert.equal(first.points[1].z, 20);
  assert.notEqual(first.id, second.id); assert.match(second.name, /2$/);
});

test('native centimetre plan measures a 3–4–5 diagonal exactly without any room polygon', () => {
  const p = fixture(), r = route(); p.calibration.metersPerPixel = .123;
  assert.deepEqual(serviceMetrics(r, p), { pathLength: 5, netQuantity: 5, purchaseQuantity: 5 });
  assert.equal(routeMetrics, serviceMetrics); assert.equal(calculateProject({ ...p, serviceRoutes: [r] }).total, '50.00');
});

test('segment measurement includes physical elevation in 3D rather than using only projected length', () => {
  const p = fixture(), r = route({ points: [{ x: 0, y: 0, z: 0 }, { x: 300, y: 400, z: 1200 }] });
  assert.equal(serviceMetrics(r, p).pathLength, 13);
  r.points[1].z = -100; near(serviceMetrics(r, p).pathLength, Math.sqrt(26));
});

test('a vertical riser is a legitimate measured route and same-height zero-length routes are rejected', () => {
  const r = route({ points: [{ x: 20, y: 20, z: -5 }, { x: 20, y: 20, z: 295 }] });
  assert.equal(serviceMetrics(r, fixture()).pathLength, 3);
  assert.throws(() => validateServiceRoutes([route({ points: [{ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 5 }] })]), /零/);
});

test('multi-segment route measures each real leg including harmless repeated nodes', () => {
  const r = route({ points: [{ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, { x: 300, y: 400, z: 0 }, { x: 300, y: 400, z: 300 }] });
  assert.equal(serviceMetrics(r, fixture()).pathLength, 10);
});

test('uploaded drawings use linear calibration for XY while vertical centimetres stay physical', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = .1;
  const r = route({ points: [{ x: 0, y: 0, z: 0 }, { x: 30, y: 40, z: 1200 }] });
  assert.equal(serviceMetrics(r, p).pathLength, 13);
  p.calibration.metersPerPixel = .2; near(serviceMetrics(r, p).pathLength, Math.sqrt(244));
});

test('uncalibrated drawings report all lengths as null including vertical-only routes', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  for (const r of [route(), route({ points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 300 }] })]) {
    assert.deepEqual(serviceMetrics(r, p), { pathLength: null, netQuantity: null, purchaseQuantity: null });
  }
  p.serviceRoutes = [route({ additionalCost: '25', laborRate: '100' })]; const q = calculateProject(p);
  assert.equal(q.total, null); assert.equal(q.serviceLength, null); assert.equal(q.servicePathLength, null);
  assert.equal(q.knownServiceCost, '25.00'); assert.equal(q.knownLaborCost, '0.00'); assert.match(q.pendingReason, /校准/);
});

test('camera zoom, labels, visibility and pipe diameter never affect physical length or quote', () => {
  const p = { ...fixture(), serviceRoutes: [route()] }, before = calculateProject(p);
  p.view = { ...p.view, labels: false, drawingOpacity: .1 }; p.camera = { zoom: 100, pan: { x: 999, y: 999 } };
  p.serviceRoutes[0].hidden = true; p.serviceRoutes[0].diameter = 50;
  const after = calculateProject(p); assert.equal(after.total, before.total); assert.equal(after.serviceLength, before.serviceLength);
  assert.equal(after.serviceRoutes[0].hidden, true); assert.equal(serviceMetrics(p.serviceRoutes[0], p).pathLength, 5);
});

test('purchase quantity includes each run allowance then waste; labor uses unwasted net quantity', () => {
  const r = route({ runs: '3', extraLength: '.5', wasteRate: '10', unitPrice: '12.34', laborRate: '8', additionalCost: '25' });
  const p = { ...fixture(), serviceRoutes: [r], additionalCost: '50', taxRate: '9' }, q = calculateProject(p), row = q.serviceRoutes[0];
  const measured = serviceMetrics(r, p); assert.equal(measured.pathLength, 5); assert.equal(measured.netQuantity, 16.5); near(measured.purchaseQuantity, 18.15);
  assert.equal(row.netQuantity, '16.5'); assert.equal(row.purchaseQuantity, '18.15'); assert.equal(row.materialCost, '223.97');
  assert.equal(row.laborCost, '132.00'); assert.equal(row.total, '380.97'); assert.equal(row.additionalCost, '25.00');
  assert.equal(row.items[0].additionalCost, '0.00'); assert.equal(q.knownServiceCost, '380.97');
  assert.equal(q.servicePathLength, 5); assert.equal(q.serviceLength, 16.5); assert.equal(q.additionalCost, '75.00');
  assert.equal(q.beforeTax, '430.97'); assert.equal(q.tax, '38.79'); assert.equal(q.total, '469.76');
});

test('quantity allowances and prices retain decimal precision rather than .1 + .2 floating error', () => {
  const p = { ...fixture(), serviceRoutes: [route({ points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], extraLength: '.2', unitPrice: '100000000000000000' })] }, row = calculateProject(p).serviceRoutes[0];
  assert.equal(row.netQuantity, '0.3'); assert.equal(row.purchaseQuantity, '0.3'); assert.equal(row.total, '30000000000000000.00');
});

test('material, labor and fixed fees each round to cents before one project tax', () => {
  const p = { ...fixture(), serviceRoutes: [route({ points: [{ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }], unitPrice: '.105', laborRate: '.015', additionalCost: '.005' })], additionalCost: '.005', taxRate: '10' }, q = calculateProject(p);
  assert.equal(q.materialCost, '0.32'); assert.equal(q.laborCost, '0.05'); assert.equal(q.serviceRoutes[0].total, '0.38');
  assert.equal(q.beforeTax, '0.39'); assert.equal(q.tax, '0.04'); assert.equal(q.total, '0.43');
});

test('empty price is pending while explicit zero is valid and confirmed labor remains known', () => {
  const p = { ...fixture(), serviceRoutes: [route({ unitPrice: '', laborRate: '8', additionalCost: '25' })] }, pending = calculateProject(p);
  assert.equal(pending.total, null); assert.equal(pending.materialCost, null); assert.equal(pending.serviceRoutes[0].materialCost, null);
  assert.equal(pending.serviceRoutes[0].items[0].unitPrice, ''); assert.equal(pending.serviceRoutes[0].items[0].total, null);
  assert.equal(pending.knownMaterialCost, '0.00'); assert.equal(pending.knownLaborCost, '40.00'); assert.equal(pending.knownServiceCost, '65.00');
  assert.equal(pending.serviceLength, 5); assert.match(pending.pendingReason, /单价/);
  p.serviceRoutes[0].unitPrice = '0'; const ready = calculateProject(p); assert.equal(ready.pending, false); assert.equal(ready.total, '65.00');
});

test('both missing calibration and empty price remain explicit without invented quantity or labor', () => {
  const p = { ...fixture(), serviceRoutes: [route({ unitPrice: '', laborRate: '8', additionalCost: '.105' })] }; p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  const q = calculateProject(p); assert.match(q.pendingReason, /校准/); assert.match(q.pendingReason, /单价/);
  assert.equal(q.serviceRoutes[0].netQuantity, null); assert.equal(q.serviceRoutes[0].laborCost, null); assert.equal(q.knownServiceCost, '0.11');
});

test('changing actual shape, material price, runs and user allowances immediately changes quote', () => {
  const p = { ...fixture(), serviceRoutes: [route()] }; assert.equal(calculateProject(p).total, '50.00');
  p.serviceRoutes[0].points[1] = { x: 600, y: 800, z: 0 }; assert.equal(calculateProject(p).total, '100.00');
  p.serviceRoutes[0].unitPrice = '20'; assert.equal(calculateProject(p).total, '200.00');
  p.serviceRoutes[0].runs = '2'; p.serviceRoutes[0].extraLength = '.5'; assert.equal(calculateProject(p).total, '420.00');
});

test('quote exposes specifications and exactly one line item per actual route', () => {
  const p = { ...fixture(), serviceRoutes: [route({ spec: '用户定制 BV 2.5 mm²', diameter: .8, runs: '3', extraLength: '.25' })] }, row = calculateProject(p).serviceRoutes[0];
  assert.equal(row.surfaceType, 'service'); assert.equal(row.unit, 'm'); assert.equal(row.system, 'power'); assert.equal(row.presetId, 'bv25');
  assert.equal(row.spec, p.serviceRoutes[0].spec); assert.equal(row.runs, '3'); assert.equal(row.extraLength, '.25'); assert.equal(row.diameter, .8);
  assert.equal(row.items.length, 1); assert.equal(row.items[0].quantityMode, 'perimeter'); assert.equal(row.items[0].netQuantity, '15.75');
});

test('copying a storey clones route geometry and remaps IDs without mutating source', () => {
  const p = { ...fixture(), serviceRoutes: [route({ runs: '3', extraLength: '.5', unitPrice: '.105' })] }, original = structuredClone(p), copied = addLevel(p, { copyLayout: true }), layers = levelProjects(copied);
  const lower = layers[0].project.serviceRoutes[0], upper = layers[1].project.serviceRoutes[0];
  assert.notEqual(lower.id, upper.id); assert.deepEqual(lower.points, upper.points); assert.equal(upper.unitPrice, '.105'); assert.equal(upper.extraLength, '.5');
  upper.points[0].x = 1234; upper.unitPrice = '999'; assert.equal(lower.points[0].x, 0); assert.equal(lower.unitPrice, '.105'); assert.deepEqual(p, original);
});

test('floor switching preserves routes per storey and clears absent legacy fields in Object.assign flows', () => {
  let p = ensureLevels(fixture()); const lower = activeLevel(p).id; p = addLevel(p); assert.deepEqual(p.serviceRoutes, []);
  p.serviceRoutes.push(route()); const upper = activeLevel(p).id, total = calculateProject(p).total;
  const target = { ...p }; Object.assign(target, switchLevel(p, lower)); assert.equal(target.serviceRoutes, undefined); assert.equal(calculateProject(target).total, total);
  p = switchLevel(target, upper); assert.equal(p.serviceRoutes.length, 1); assert.equal(p.serviceRoutes[0].id, 'route-one');
});

test('all storeys aggregate real service quantities and money with exactly one project fee and tax', () => {
  const p = { ...fixture(), serviceRoutes: [route()], additionalCost: '100', taxRate: '10' }, q = calculateProject(addLevel(p, { copyLayout: true }));
  assert.equal(q.serviceRoutes.length, 2); assert.equal(new Set(q.serviceRoutes.map(row => row.id)).size, 2);
  assert.equal(q.serviceLength, 10); assert.equal(q.servicePathLength, 10); assert.equal(q.knownServiceCost, '100.00');
  assert.equal(q.projectAdditionalCost, '100.00'); assert.equal(q.beforeTax, '200.00'); assert.equal(q.tax, '20.00'); assert.equal(q.total, '220.00');
  for (const row of q.serviceRoutes) { assert.ok(row.levelId); assert.ok(row.levelName); }
  for (const level of q.levelSummaries) { assert.equal(level.serviceLength, 5); assert.equal(level.knownServiceCost, '50.00'); }
});

test('inactive missing prices remain pending while confirmed amounts elsewhere stay available', () => {
  const p = { ...fixture(), serviceRoutes: [route({ unitPrice: '', laborRate: '8', additionalCost: '25' })] }, upper = addLevel(p);
  upper.serviceRoutes.push(route({ id: 'route-upper' })); const q = calculateProject(upper);
  assert.equal(q.total, null); assert.match(q.pendingReason, /一楼.*单价/); assert.equal(q.serviceLength, 10);
  assert.equal(q.knownServiceCost, '115.00'); assert.equal(q.knownMaterialCost, '50.00'); assert.equal(q.knownLaborCost, '40.00');
});

test('multi-storey cents above Number safety remain exact', () => {
  const p = { ...fixture(), serviceRoutes: [route({ points: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }], unitPrice: '9007199254740993.01' })] }, next = addLevel(p);
  next.serviceRoutes.push(route({ id: 'upper-small', points: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }], unitPrice: '1.01' }));
  assert.equal(calculateProject(next).total, '9007199254740994.02');
});

test('old projects without service routes retain their existing quote and gain no invented quantities', () => {
  const p = fixture(); assert.equal(p.serviceRoutes, undefined); const q = calculateProject(p);
  assert.equal(q.serviceLength, 0); assert.equal(q.servicePathLength, 0); assert.equal(q.knownServiceCost, '0.00'); assert.deepEqual(q.serviceRoutes, []); assert.equal(q.total, '0.00');
  const upper = addLevel(p); assert.deepEqual(upper.serviceRoutes, []); assert.equal(calculateProject(upper).total, '0.00');
});

test('saved projects, JSON migration and undo preserve geometry, per-storey routes and prices', async () => {
  const p = addLevel({ ...fixture(), serviceRoutes: [route({ runs: '3', extraLength: '.5', unitPrice: '.105', hidden: true })] }, { copyLayout: true }), q = calculateProject(p), store = createMemoryProjectStore();
  await store.saveProject(p); const loaded = await store.loadProject(p.id, { hydrateDrawing: false }); assert.deepEqual(calculateProject(loaded), q);
  assert.deepEqual(loaded.serviceRoutes, p.serviceRoutes); assert.deepEqual(loaded.levels, p.levels);
  const restored = await importProjectJSON(await exportProjectJSON(p)); assert.deepEqual(calculateProject(restored), q); assert.deepEqual(restored.serviceRoutes, p.serviceRoutes);
  const history = createHistory(p), changed = structuredClone(p); changed.serviceRoutes[0].points[1].z = 500; changed.serviceRoutes[0].unitPrice = '55'; history.push(changed);
  assert.deepEqual(history.undo().serviceRoutes, p.serviceRoutes); assert.deepEqual(history.redo().serviceRoutes, changed.serviceRoutes);
});

test('invalid pending work cannot overwrite a previously valid saved inactive route', async () => {
  const p = addLevel({ ...fixture(), serviceRoutes: [route()] }), store = createMemoryProjectStore(); await store.saveProject(p);
  const broken = structuredClone(p); broken.levels[0].content.serviceRoutes[0].points[1].z = Infinity;
  assert.throws(() => store.saveProject(broken), /坐标/);
  assert.deepEqual((await store.loadProject(p.id, { hydrateDrawing: false })).levels, p.levels);
  await assert.rejects(() => importProjectJSON(JSON.stringify({ ...p, serviceRoutes: [{ ...route(), presetId: 'unknown' }] })), /预设/);
});

test('service IDs cannot duplicate across floors or collide with real region IDs', () => {
  const p = addLevel({ ...fixture(), serviceRoutes: [route()] }); p.serviceRoutes.push(route()); assert.throws(() => validateLevels(p), /编号不能重复/);
  const single = ensureLevels(fixture()); single.regions = [{ id: 'route-one', name: '客厅', points: [], holes: [], hidden: false, items: [], additionalCost: '0' }]; single.serviceRoutes = [route()];
  assert.throws(() => validateLevels(single), /编号不能重复/);
});

test('route validation rejects invalid ids, points, presets, physical dimensions and financial fields', () => {
  const bad = [
    { id: '' }, { name: '' }, { name: 'a'.repeat(121) }, { presetId: 'unknown' }, { spec: 42 }, { spec: 'a'.repeat(201) },
    { diameter: 0 }, { diameter: 100.01 }, { diameter: NaN }, { points: [] }, { points: [{ x: 0, y: 0, z: 0 }] },
    { points: [{ x: 0, y: 0, z: 0 }, { x: Infinity, y: 0, z: 0 }] }, { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: -101 }] },
    { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 2001 }] }, { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0 }] },
    { runs: '0' }, { runs: '1.5' }, { runs: '1000001' }, { extraLength: '-1' }, { unitPrice: '-1' }, { unitPrice: 'NaN' },
    { wasteRate: '-1' }, { laborRate: '-1' }, { additionalCost: '-1' }, { hidden: 'yes' },
  ];
  for (const patch of bad) assert.throws(() => validateServiceRoutes([route(patch)]), JSON.stringify(patch));
  assert.throws(() => validateServiceRoutes([route(), route()]), /编号/); assert.throws(() => validateServiceRoutes({}), /格式/);
  assert.throws(() => validateProject({ ...fixture(), serviceRoutes: [route({ unitPrice: 'oops' })] }), /数字/);
  assert.doesNotThrow(() => validateServiceRoutes(undefined));
});

test('route and vertex limits stop malformed imported paths before storage', () => {
  assert.throws(() => validateServiceRoutes(Array.from({ length: 501 }, (_, i) => route({ id: 'r' + i }))), /500/);
  assert.throws(() => validateServiceRoutes([route({ points: Array.from({ length: 201 }, (_, i) => ({ x: i, y: 0, z: 0 })) })]), /200/);
  assert.throws(() => validateServiceRoutes([route({ points: [{ x: 0, y: 0, z: 0 }, { x: 1e9 + 1, y: 0, z: 0 }] })]), /坐标/);
});

test('endpoint magnets choose the closest visible actual node and return an independent copy', () => {
  const first = route({ points: [{ x: 10, y: 0, z: 5 }, { x: 100, y: 0, z: 50 }] }), hidden = route({ id: 'hidden', hidden: true, points: [{ x: 0, y: 0, z: 99 }, { x: 100, y: 0, z: 99 }] });
  const snapped = nearestServicePoint({ x: 1, y: 0 }, [first, hidden], 10); assert.deepEqual(snapped, { x: 10, y: 0, z: 5 }); snapped.z = 200;
  assert.equal(first.points[0].z, 5); assert.equal(nearestServicePoint({ x: 1, y: 0 }, [first], 1), null); assert.equal(nearestServicePoint({ x: 0, y: 0 }, undefined, 10), null);
});
