import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CIVIL_BUILD ? pathToFileURL(resolve(process.env.CIVIL_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { CIVIL_PRESETS, createCivilElement, validateCivilElements, civilParts, civilFootprint, civilMetrics, civilResolvedElement, detachCivilElement, buildCivilQuantities, generateCivilLayout } = await import(new URL('lib/civil.js', root));
const { calculateCivilProject } = await import(new URL('lib/civil-pricing.js', root));
const { calculateProject } = await import(new URL('lib/pricing.js', root));
const { polygonArea, regionMetrics, pointInRegion } = await import(new URL('lib/geometry.js', root));
const { openingShape } = await import(new URL('lib/floor-openings.js', root));
const { addLevel, switchLevel, ensureLevels, levelProjects, effectiveLevelProject, validateLevels } = await import(new URL('lib/levels.js', root));
const { createMemoryProjectStore, createHistory, exportProjectJSON, importProjectJSON, validateProject } = await import(new URL('lib/persistence.js', root));
const rect = (x, y, width, depth) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
const fixture = () => ({ version: 1, id: 'civil-project', name: '土建设计', workspaceMode: 'civil', drawing: { id: 'plan', name: '平面图', type: 'plan', width: 2400, height: 1800, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], walls: [], civilElements: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const element = (kind = 'column', patch = {}, p = fixture()) => ({ ...createCivilElement(kind, { x: 500, y: 500 }, p), id: 'element-one', unitPrice: '100', ...patch });
const room = () => ({ id: 'room', name: '楼板轮廓', points: rect(0, 0, 600, 400), holes: [], hidden: false, items: [], additionalCost: '0' });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const volumeOfSlices = (metrics, scale = .01) => metrics.slices.reduce((sum, slice) => sum + slice.parts.reduce((area, part) => area + polygonArea(part.points) - part.holes.reduce((n, hole) => n + polygonArea(hole), 0), 0) * scale * scale * slice.height * .01, 0);

test('12 real civil presets create editable measured elements with no invented market rates', () => {
  assert.equal(CIVIL_PRESETS.length, 12); assert.equal(new Set(CIVIL_PRESETS.map(preset => preset.kind)).size, 12);
  for (const preset of CIVIL_PRESETS) {
    const created = createCivilElement(preset.kind, { x: 500, y: 500 }, fixture());
    assert.equal(created.unitPrice, ''); assert.equal(created.formworkRate, ''); assert.equal(created.rebarMode, 'none'); assert.equal(created.rebarPrice, '');
    assert.equal(created.quantity, '1'); assert.equal(created.additionalCost, '0'); assert.equal(created.locked, false);
    assert.doesNotThrow(() => validateCivilElements([created], fixture())); assert.ok(civilMetrics(created, fixture()).netVolume > 0);
  }
});

test('centimetre rectangular column has a real footprint, cubic-metre volume and side-only formwork', () => {
  const p = fixture(), e = element(), m = civilMetrics(e, p);
  near(m.footprintArea, .16); near(m.grossVolume, .48); near(m.netVolume, .48); near(m.formworkArea, 4.8); near(volumeOfSlices(m), .48);
  assert.equal(m.rebarQuantity, 0); assert.equal(m.slices.length, 1); assert.equal(m.slices[0].elevation, 0); assert.equal(m.slices[0].height, 300);
  assert.deepEqual(civilFootprint(e, p), rect(480, 480, 40, 40));
});

test('round columns use the actual curved profile shared by visible slices and measured volume', () => {
  const e = element('roundColumn'), p = fixture(), m = civilMetrics(e, p);
  assert.equal(civilFootprint(e, p).length, 200); near(m.footprintArea, Math.PI * .2 ** 2, 3e-5); near(m.netVolume, Math.PI * .2 ** 2 * 3, 7e-5);
  near(m.netVolume, volumeOfSlices(m)); assert.match(m.warnings.join(' '), /200.*近似/);
  assert.deepEqual(civilParts({ ...e, rotation: 37.27 }, p), civilParts(e, p));
});

test('plan rotation and camera movement preserve physical volume and per-instance quantity', () => {
  const p = fixture(), e = element('beam', { width: 30, depth: 450, rotation: 37.27, quantity: '8' }), m = civilMetrics(e, p);
  near(m.netVolume, .3 * 4.5 * .5); p.view.labels = false; p.camera = { zoom: 123, x: 999, y: 999 };
  near(civilMetrics(e, p).netVolume, m.netVolume); assert.equal(m.slices.length, civilMetrics(e, p).slices.length);
});

test('uploaded plan calibration affects XY conversion without changing user-entered physical dimensions', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = .02;
  const e = element(), points = civilFootprint(e, p), m = civilMetrics(e, p); assert.deepEqual(points, rect(490, 490, 20, 20)); near(m.netVolume, .48);
  p.calibration.metersPerPixel = .05; near(civilMetrics(e, p).netVolume, .48);
});

test('no calibration exposes no fake physical quantity while preserving confirmed fixed fees', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null; p.civilElements.push(element('column', { laborRate: '80', additionalCost: '25', formworkRate: '10' }));
  const m = civilMetrics(p.civilElements[0], p), q = calculateCivilProject(p);
  assert.equal(civilFootprint(p.civilElements[0], p), null); assert.equal(m.netVolume, null); assert.deepEqual(m.slices, []);
  assert.equal(q.netVolume, null); assert.equal(q.total, null); assert.equal(q.knownSubtotal, '25.00'); assert.equal(q.knownLaborCost, '0.00'); assert.match(q.pendingReason, /校准/);
});

test('foundation, column, beam and slab share real union volume using stable structural priority', () => {
  const p = fixture(); p.civilElements = [element('slab', { id: 'slab', height: 15, elevation: 285 }), element('beam', { id: 'beam' }), element('column', { id: 'column' })];
  const rows = buildCivilQuantities(p), m = id => rows.find(row => row.id === id).metrics;
  near(m('column').netVolume, .48); near(m('beam').grossVolume, .6); near(m('beam').netVolume, .54);
  near(m('slab').grossVolume, 2.4); near(m('slab').netVolume, 2.214); near(calculateCivilProject(p).netVolume, 3.234);
  near(m('slab').overlapVolume, .186); assert.match(m('slab').warnings.join(' '), /不重复/);
  for (const row of rows) near(volumeOfSlices(row.metrics), row.metrics.netVolume);
  p.civilElements.reverse(); for (const row of buildCivilQuantities(p)) near(row.metrics.netVolume, m(row.id).netVolume);
});

test('actual contact formwork excludes buried interfaces and includes beam undersides', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'column' }), element('beam', { id: 'beam' }), element('slab', { id: 'slab' })];
  const rows = buildCivilQuantities(p), m = id => rows.find(row => row.id === id).metrics;
  // Slab underside is 16 − 0.16 − (1.2 − 0.12) = 14.76 m²;
  // its exposed 15.4 m edge × 0.15 m thickness adds 2.31 m².
  near(m('column').formworkArea, 4.35); near(m('beam').formworkArea, 3.9); near(m('slab').formworkArea, 17.07);
});

test('touching identical-height columns share no volume and their contact faces need no duplicate templates', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'a', width: 100, depth: 100, height: 100 }), element('column', { id: 'b', position: { x: 600, y: 500 }, width: 100, depth: 100, height: 100 })];
  const rows = buildCivilQuantities(p); for (const row of rows) { near(row.metrics.netVolume, 1); near(row.metrics.formworkArea, 3); }
  near(calculateCivilProject(p).netVolume, 2);
});

test('overlapping bounding boxes of separated diagonal profiles do not fabricate volume deductions', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'a', width: 100, depth: 100, height: 100, rotation: 45 }), element('column', { id: 'b', position: { x: 610, y: 610 }, width: 100, depth: 100, height: 100, rotation: 45 })];
  for (const row of buildCivilQuantities(p)) { near(row.metrics.netVolume, 1); near(row.metrics.overlapVolume, 0); }
});

test('complete same-space duplicates give persisted first placement ownership and an explicit zero second volume', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'b' }), element('column', { id: 'a' })];
  const rows = buildCivilQuantities(p); near(rows.find(row => row.id === 'b').metrics.netVolume, .48); near(rows.find(row => row.id === 'a').metrics.netVolume, 0);
  assert.deepEqual(rows.find(row => row.id === 'a').metrics.slices, []); near(calculateCivilProject(p).netVolume, .48);
});

test('same-kind partial overlap uses physical geometry rather than UUIDs or input array order', () => {
  const p = fixture();
  p.civilElements = [element('column', { id: 'a', position: { x: 300, y: 300 }, width: 100, depth: 100, height: 100, unitPrice: '100' }), element('column', { id: 'b', position: { x: 350, y: 300 }, width: 100, depth: 100, height: 100, unitPrice: '200' })];
  const before = calculateCivilProject(p); assert.equal(before.total, '200.00');
  p.civilElements[0].id = 'z'; p.civilElements.reverse();
  const after = calculateCivilProject(p); assert.equal(after.total, before.total);
  near(after.civilElements.find(row => row.id === 'z').netVolume, 1); near(after.civilElements.find(row => row.id === 'b').netVolume, .5);
});

test('changing prices never changes another same-kind element net geometry or overlap attribution', () => {
  const p = fixture();
  p.civilElements = [element('column', { id: 'first', position: { x: 300, y: 300 }, width: 100, depth: 100, height: 100 }), element('column', { id: 'second', position: { x: 350, y: 300 }, width: 100, depth: 100, height: 100 })];
  const before = buildCivilQuantities(p).map(row => row.metrics);
  p.civilElements[0].unitPrice = '999999'; p.civilElements[1].unitPrice = '0';
  assert.deepEqual(buildCivilQuantities(p).map(row => row.metrics), before);
});

test('fully identical footprints retain first placement ownership after UUID replacement', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'z', unitPrice: '100' }), element('column', { id: 'a', unitPrice: '200' })];
  assert.equal(calculateCivilProject(p).total, '48.00');
  p.civilElements[0].id = '1'; p.civilElements[1].id = '0';
  const rows = buildCivilQuantities(p); near(rows[0].metrics.netVolume, .48); near(rows[1].metrics.netVolume, 0); assert.equal(calculateCivilProject(p).total, '48.00');
});

test('soil operations are separately measured and masonry volume is deducted against existing concrete', () => {
  const p = fixture(); p.civilElements = [element('excavation', { id: 'exc', width: 100, depth: 100, height: 100, elevation: 0 }), element('backfill', { id: 'fill', width: 100, depth: 100, height: 100, elevation: 0 }), element('column', { id: 'col', width: 100, depth: 100, height: 100 }), element('masonry', { id: 'wall', width: 100, depth: 100, height: 100 })];
  const rows = buildCivilQuantities(p); assert.equal(rows.find(row => row.id === 'exc').metrics.netVolume, 1); assert.equal(rows.find(row => row.id === 'fill').metrics.netVolume, 1);
  assert.match(rows.find(row => row.id === 'fill').metrics.warnings.join(' '), /不互相抵扣/); assert.equal(rows.find(row => row.id === 'wall').metrics.netVolume, 0);
  near(calculateCivilProject(p).netVolume, 3);
});

test('slabs and rafts inherit exact source-room holes and envelope dimensions', () => {
  const p = fixture(); p.regions = [room()]; p.floorOpenings = [{ id: 'hole', regionId: 'room', points: rect(200, 100, 100, 100) }];
  for (const kind of ['slab', 'raft']) {
    const e = createCivilElement(kind, { x: 50, y: 50 }, p); e.height = 20;
    assert.equal(e.sourceRegionId, 'room'); assert.deepEqual(e.position, { x: 300, y: 200 }); assert.equal(e.width, 600); assert.equal(e.depth, 400);
    const parts = civilParts(e, p), m = civilMetrics(e, p); assert.equal(parts[0].holes.length, 1); near(m.footprintArea, 23); near(m.netVolume, 4.6);
    assert.equal(pointInRegion({ x: 250, y: 150 }, { points: parts[0].points, holes: parts[0].holes }), false); near(volumeOfSlices(m), m.netVolume);
  }
});

test('annular openings retain a real central floor island in quantities and all rendered slices', () => {
  const p = fixture(); p.regions = [room()]; p.floorOpenings = [{ id: 'annulus', regionId: 'room', ...openingShape('annulus', { x: 300, y: 200 }, { x: 400, y: 200 }, { innerRatio: .45 }) }];
  const e = createCivilElement('slab', { x: 50, y: 50 }, p), m = civilMetrics(e, p), actualArea = regionMetrics(effectiveLevelProject(p).regions[0], p.calibration).netArea;
  assert.equal(civilParts(e, p).length, 2); near(m.footprintArea, actualArea); near(m.netVolume, actualArea * .15); assert.equal(m.slices[0].parts.length, 2); near(volumeOfSlices(m), m.netVolume);
});

test('linked envelope and quote dimensions follow current source edits without mutating saved coordinates', () => {
  const p = fixture(); p.regions = [room()];
  const e = createCivilElement('slab', { x: 50, y: 50 }, p); e.unitPrice = '100'; p.civilElements = [e];
  const original = structuredClone(e); p.regions[0].points = rect(100, 200, 700, 500);
  const resolved = civilResolvedElement(e, p);
  assert.deepEqual(resolved.position, { x: 450, y: 450 }); assert.equal(resolved.width, 700); assert.equal(resolved.depth, 500); assert.equal(resolved.rotation, 0);
  assert.deepEqual(e, original); assert.equal(calculateCivilProject(p).civilElements[0].width, 700);
  const detached = detachCivilElement(e, p); p.civilElements = [detached];
  assert.equal(detached.width, 700); assert.equal(detached.depth, 500); near(civilMetrics(detached, p).footprintArea, 35);
  assert.deepEqual(e, original); assert.equal(detached.sourceRegionId, undefined);
});

test('detaching concave slabs preserves intrinsic holes, annular retained islands, exact quantities and quote', () => {
  const p = fixture();
  p.regions = [{ ...room(), points: [{ x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 800 }, { x: 200, y: 800 }], holes: [rect(250, 650, 50, 50)] }];
  p.floorOpenings = [{ id: 'annulus', regionId: 'room', points: rect(300, 300, 200, 200), holes: [rect(350, 350, 100, 100)] }];
  const e = createCivilElement('slab', { x: 250, y: 250 }, p);
  Object.assign(e, { height: 20, unitPrice: '100', wasteRate: '10', laborRate: '20', formworkRate: '5' }); p.civilElements = [e];
  const before = civilMetrics(e, p), quote = calculateCivilProject(p), original = structuredClone(p), detached = detachCivilElement(e, p);
  assert.deepEqual(p, original); assert.equal(detached.profile.length, 2); assert.equal(detached.sourceRegionId, undefined);
  p.civilElements = [detached]; const after = civilMetrics(detached, p), parts = civilParts(detached, p);
  for (const field of ['footprintArea', 'netVolume', 'grossVolume', 'formworkArea', 'overlapVolume']) near(after[field], before[field]);
  near(after.footprintArea, 24.75); assert.equal(calculateCivilProject(p).total, quote.total);
  const inside = point => parts.some(part => pointInRegion(point, part));
  assert.equal(inside({ x: 400, y: 400 }), true); assert.equal(inside({ x: 325, y: 325 }), false);
  assert.equal(inside({ x: 275, y: 675 }), false); assert.equal(inside({ x: 700, y: 600 }), false);
});

test('detached multiple-part profiles preserve holes through independent transforms and physical resizing', () => {
  const p = fixture(); p.regions = [room()];
  p.floorOpenings = [{ id: 'annulus', regionId: 'room', points: rect(200, 100, 200, 200), holes: [rect(250, 150, 100, 100)] }];
  const e = detachCivilElement(createCivilElement('raft', { x: 50, y: 50 }, p), p), before = civilMetrics(e, p);
  e.position = { x: 1000, y: 900 }; e.rotation = 90;
  near(civilMetrics(e, p).footprintArea, before.footprintArea); assert.equal(civilParts(e, p).length, 2);
  e.width *= 1.2; e.depth *= 1.5;
  near(civilMetrics(e, p).footprintArea, before.footprintArea * 1.8); near(civilMetrics(e, p).netVolume, before.netVolume * 1.8);
  assert.equal(civilParts(e, p)[0].holes.length, 1); near(volumeOfSlices(civilMetrics(e, p)), before.netVolume * 1.8);
});

test('uncalibrated source resolution stays honest and source detachment requires a real XY scale', () => {
  const p = fixture(); p.regions = [room()]; const e = createCivilElement('slab', { x: 50, y: 50 }, p);
  p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  assert.deepEqual(civilResolvedElement(e, p), e); assert.notEqual(civilResolvedElement(e, p), e);
  assert.throws(() => detachCivilElement(e, p), /校准/); assert.equal(civilParts(e, p), null);
  assert.throws(() => civilResolvedElement({ ...e, sourceRegionId: 'missing' }, p), /房间/);
  p.regions[0].points = [{ x: 0, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }, { x: 400, y: 0 }];
  assert.throws(() => civilResolvedElement(e, p), /无效/);
});

test('profile canonical geometry ignores ring start, direction and multi-part ordering for identical placement ownership', () => {
  const p = fixture(), profile = [{ points: rect(-.5, -.5, .4, 1), holes: [] }, { points: rect(.1, -.5, .4, 1), holes: [] }];
  const shifted = structuredClone(profile).reverse().map(part => ({ ...part, points: part.points.slice(1).concat(part.points[0]).reverse() }));
  p.civilElements = [element('slab', { id: 'z', profile, width: 100, depth: 100, height: 100, elevation: 0, unitPrice: '100' }), element('slab', { id: 'a', profile: shifted, width: 100, depth: 100, height: 100, elevation: 0, unitPrice: '200' })];
  const rows = buildCivilQuantities(p); near(rows[0].metrics.netVolume, .8); near(rows[1].metrics.netVolume, 0); assert.equal(calculateCivilProject(p).total, '80.00');
});

test('collinear extra vertices do not turn physically identical slabs into different ownership identities', () => {
  const p = fixture(), profile = [{ points: rect(-.5, -.5, 1, 1), holes: [] }], extra = structuredClone(profile);
  extra[0].points.splice(1, 0, { x: 0, y: -.5 });
  p.civilElements = [element('slab', { id: 'z', profile, width: 100, depth: 100, height: 100, elevation: 0, unitPrice: '100' }), element('slab', { id: 'a', profile: extra, width: 100, depth: 100, height: 100, elevation: 0, unitPrice: '200' })];
  const rows = buildCivilQuantities(p); near(rows[0].metrics.netVolume, 1); near(rows[1].metrics.netVolume, 0); assert.equal(calculateCivilProject(p).total, '100.00');
});

test('engineering JSON and local store preserve independent multi-part profiles and exact quote snapshots', async () => {
  const p = fixture(); p.regions = [room()];
  p.floorOpenings = [{ id: 'annulus', regionId: 'room', points: rect(200, 100, 200, 200), holes: [rect(250, 150, 100, 100)] }];
  const e = detachCivilElement(createCivilElement('slab', { x: 50, y: 50 }, p), p); e.unitPrice = '100'; p.civilElements = [e];
  const before = calculateCivilProject(p), store = createMemoryProjectStore(); await store.saveProject(p);
  const loaded = await store.loadProject(p.id, { hydrateDrawing: false }), restored = await importProjectJSON(await exportProjectJSON(p));
  for (const value of [loaded, restored]) { assert.deepEqual(value.civilElements[0].profile, e.profile); assert.deepEqual(calculateCivilProject(value), before); }
});

test('invalid independent profiles, self intersections, orphan holes and duplicate parts are rejected', () => {
  const p = fixture(), profile = [{ points: rect(-.5, -.5, 1, 1), holes: [] }]; p.regions = [room()];
  for (const patch of [
    { kind: 'column', profile }, { sourceRegionId: 'room', profile }, { profile: [] }, { profile: 'invalid' },
    { profile: [{ points: rect(-.6, -.5, 1, 1), holes: [] }] }, { profile: [{ points: rect(-.5, -.5, 1, 1), holes: 'invalid' }] },
    { profile: [{ points: [{ x: -.5, y: -.5 }, { x: .5, y: .5 }, { x: -.5, y: .5 }, { x: .5, y: -.5 }], holes: [] }] },
    { profile: [{ points: rect(-.5, -.5, .5, 1), holes: [rect(.1, -.1, .1, .1)] }] },
    { profile: [...profile, ...profile] }, { profile: [{ ...profile[0], surfaceParts: profile }] },
  ]) assert.throws(() => validateCivilElements([element('slab', patch)], p));
  assert.doesNotThrow(() => validateCivilElements([element('slab', { profile })], p));
});

test('editing geometry or source openings invalidates cached metrics without exposing shared coordinate arrays', () => {
  const p = fixture(); p.regions = [room()]; p.civilElements.push(createCivilElement('slab', { x: 50, y: 50 }, p));
  const initial = buildCivilQuantities(p); initial[0].metrics.slices[0].parts[0].points[0].x = 999999;
  near(buildCivilQuantities(p)[0].metrics.netVolume, 3.6);
  p.floorOpenings = [{ id: 'hole', regionId: 'room', points: rect(200, 100, 100, 100) }]; near(buildCivilQuantities(p)[0].metrics.netVolume, 3.45);
  p.civilElements[0].height = 20; near(buildCivilQuantities(p)[0].metrics.netVolume, 4.6);
});

test('civil quote is independent of pending floor coverings and does not invent decoration costs', () => {
  const p = fixture(); p.regions = [room()]; p.civilElements = [element('column')]; assert.equal(calculateProject(p).pending, true);
  const q = calculateCivilProject(p); assert.equal(q.kind, 'civil'); assert.equal(q.pending, false); assert.equal(q.total, '48.00');
  for (const field of ['regions', 'walls', 'furniture', 'ceilings', 'serviceRoutes']) assert.deepEqual(q[field], []);
  p.civilElements[0].unitPrice = '999'; assert.equal(calculateProject(p).knownSubtotal, '0.00');
});

test('quantity, waste, net-volume labor, optional formwork, ratio steel, fixed fees and one tax stay distinct', () => {
  const p = fixture(); p.civilElements = [element('column', { width: 100, depth: 100, height: 100, quantity: '2', unitPrice: '100', wasteRate: '10', laborRate: '20', formworkRate: '5', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '4', additionalCost: '25' })]; p.additionalCost = '50'; p.taxRate = '9';
  const q = calculateCivilProject(p), row = q.civilElements[0]; assert.equal(row.singleNetVolume, 1); assert.equal(row.netVolume, 2); assert.equal(row.volume, '2'); assert.equal(row.purchaseVolume, '2.2');
  assert.equal(row.materialCost, '220.00'); assert.equal(row.laborCost, '40.00'); assert.equal(row.formworkArea, 8); assert.equal(row.formworkCost, '40.00'); assert.equal(row.rebarQuantity, 200); assert.equal(row.rebarCost, '800.00');
  assert.equal(row.total, '1125.00'); assert.equal(q.beforeTax, '1175.00'); assert.equal(q.tax, '105.75'); assert.equal(q.total, '1280.75');
  assert.ok(row.items.every(item => item.additionalCost === '0.00')); assert.equal(row.items.length, 3); assert.match(row.warnings.join(' '), /指标估算/);
});

test('manual rebar retains exact user kilograms and cannot be rounded through a Number conversion', () => {
  const p = fixture(); p.civilElements = [element('column', { width: 100, depth: 100, height: 100, unitPrice: '0', rebarMode: 'manual', rebarQuantity: '9007199254740993.01', rebarPrice: '1' })];
  const q = calculateCivilProject(p), row = q.civilElements[0]; assert.equal(row.items.find(item => item.unit === 'kg').netQuantity, '9007199254740993.01'); assert.equal(row.rebarCost, '9007199254740993.01'); assert.equal(q.total, '9007199254740993.01');
});

test('blank formwork is disabled, enabled steel needs a price, and confirmed zero prices are valid', () => {
  const p = fixture(); p.civilElements = [element('column', { unitPrice: '0' })]; assert.equal(calculateCivilProject(p).total, '0.00'); assert.equal(calculateCivilProject(p).civilElements[0].items.length, 1);
  p.civilElements[0].formworkRate = '0'; assert.equal(calculateCivilProject(p).civilElements[0].items.length, 2); assert.equal(calculateCivilProject(p).total, '0.00');
  p.civilElements[0].rebarMode = 'manual'; p.civilElements[0].rebarQuantity = '10'; const missing = calculateCivilProject(p); assert.equal(missing.total, null); assert.match(missing.pendingReason, /钢筋.*单价/);
  p.civilElements[0].rebarPrice = '0'; assert.equal(calculateCivilProject(p).total, '0.00');
});

test('missing concrete price preserves known net labor, template and fixed amounts without pretending a full total', () => {
  const p = fixture(); p.civilElements = [element('column', { width: 100, depth: 100, height: 100, unitPrice: '', laborRate: '20', formworkRate: '5', additionalCost: '25' })];
  const q = calculateCivilProject(p), row = q.civilElements[0]; assert.equal(q.total, null); assert.equal(row.materialCost, null); assert.equal(row.laborCost, '20.00'); assert.equal(row.formworkCost, '20.00'); assert.equal(q.knownSubtotal, '65.00'); assert.equal(row.knownTotal, '65.00');
});

test('each money component rounds to cents before project aggregation and tax', () => {
  const p = fixture(); p.civilElements = [element('column', { width: 100, depth: 100, height: 100, quantity: '3', unitPrice: '.105', laborRate: '.015', additionalCost: '.005' })]; p.additionalCost = '.005'; p.taxRate = '10';
  const q = calculateCivilProject(p); assert.equal(q.materialCost, '0.32'); assert.equal(q.laborCost, '0.05'); assert.equal(q.civilElements[0].total, '0.38'); assert.equal(q.beforeTax, '0.39'); assert.equal(q.tax, '0.04'); assert.equal(q.total, '0.43');
});

test('physical instances remain singular when quoted quantity changes and hidden or locked objects still cost', () => {
  const p = fixture(); p.civilElements = [element('column', { quantity: '3', hidden: true, locked: true })];
  const q = calculateCivilProject(p), geometry = buildCivilQuantities(p); near(q.netVolume, 1.44); assert.equal(q.total, '144.00'); assert.equal(geometry.length, 1); near(geometry[0].metrics.netVolume, .48);
});

test('cross-floor columns use absolute height slices without duplicate overlapping concrete', () => {
  const p = fixture(); p.civilElements = [element('column', { id: 'a-lower', height: 400 })]; const upper = addLevel(p); upper.civilElements = [element('column', { id: 'b-upper', height: 300 })];
  const rows = buildCivilQuantities(upper), lowerMetrics = rows.find(row => row.id === 'a-lower').metrics, upperRow = rows.find(row => row.id === 'b-upper');
  near(lowerMetrics.netVolume, .64); near(upperRow.metrics.netVolume, .32); assert.equal(upperRow.levelElevation, 300); assert.equal(upperRow.metrics.slices[0].elevation, 100);
  near(calculateCivilProject(upper).netVolume, .96); const lowerView = switchLevel(upper, upper.levels[0].id); near(calculateCivilProject(lowerView).netVolume, .96);
});

test('copying and switching storeys remap civil/source region ids and preserve independent price snapshots', () => {
  const p = fixture(); p.regions = [room()]; p.civilElements = [createCivilElement('slab', { x: 50, y: 50 }, p)]; p.civilElements[0].unitPrice = '10';
  const copied = addLevel(p, { copyLayout: true }), layers = levelProjects(copied), lower = layers[0].project.civilElements[0], upper = layers[1].project.civilElements[0];
  assert.notEqual(lower.id, upper.id); assert.notEqual(lower.sourceRegionId, upper.sourceRegionId); assert.equal(upper.sourceRegionId, layers[1].project.regions[0].id);
  upper.unitPrice = '999'; assert.equal(lower.unitPrice, '10');
  let old = ensureLevels(fixture()); const first = old.activeLevelId; old = addLevel(old); old.civilElements.push(element()); const target = { ...old }; Object.assign(target, switchLevel(old, first)); assert.deepEqual(target.civilElements, []); assert.equal(calculateCivilProject(target).total, '48.00');
});

test('all-floor structural quote applies the shared project fixed fee and tax exactly once', () => {
  const p = fixture(); p.civilElements = [element('column', { width: 100, depth: 100, height: 100 })]; p.additionalCost = '100'; p.taxRate = '10';
  const q = calculateCivilProject(addLevel(p, { copyLayout: true })); assert.equal(q.civilElements.length, 2); assert.equal(q.netVolume, 2); assert.equal(q.beforeTax, '300.00'); assert.equal(q.tax, '30.00'); assert.equal(q.total, '330.00');
});

test('explicit empty-plan dimensions generate a real editable frame without adding prices or changing the project', () => {
  const p = fixture(), original = structuredClone(p), elements = generateCivilLayout(p, { origin: { x: 200, y: 200 }, width: 800, depth: 400, columnSize: 40, beamWidth: 30, beamHeight: 50, slabThickness: 15, floorHeight: 300, spanX: 400, spanY: 400, foundation: true });
  assert.deepEqual(p, original); assert.equal(elements.filter(e => e.kind === 'column').length, 6); assert.equal(elements.filter(e => e.kind === 'padFooting').length, 6); assert.equal(elements.filter(e => e.kind === 'beam').length, 7); assert.equal(elements.filter(e => e.kind === 'slab').length, 1);
  assert.equal(new Set(elements.map(e => e.id)).size, elements.length); assert.ok(elements.every(e => e.unitPrice === ''));
  p.civilElements = elements; const geometry = buildCivilQuantities(p); assert.ok(geometry.every(row => row.metrics.netVolume > 0)); assert.equal(calculateCivilProject(p).total, null);
});

test('room-derived templates preserve nonrectangular slabs and true floor openings', () => {
  const p = fixture(); p.regions = [{ ...room(), points: rect(200, 200, 600, 400) }]; p.floorOpenings = [{ id: 'hole', regionId: 'room', points: rect(400, 300, 100, 100) }];
  const elements = generateCivilLayout(p, { columnSize: 40, beamWidth: 30, beamHeight: 50, slabThickness: 20, floorHeight: 300, spanX: 600, spanY: 400, foundation: false });
  const slab = elements.find(e => e.kind === 'slab'); assert.equal(slab.sourceRegionId, 'room'); assert.equal(civilParts(slab, p)[0].holes.length, 1); near(civilMetrics(slab, p).footprintArea, 23);
});

test('invalid templates fail before altering source and never fill a concave boundary by its bounding rectangle', () => {
  const p = fixture(), cfg = { range: { origin: { x: 100, y: 100 }, width: 400, depth: 400 }, columnSize: 40, beamWidth: 30, beamHeight: 50, slabThickness: 15, floorHeight: 300, spanX: 400, spanY: 400, foundation: false };
  for (const patch of [{ spanX: 0 }, { slabThickness: 301 }, { foundation: 'yes' }, { range: { origin: { x: 0, y: 0 }, width: Infinity, depth: 400 } }, { spanX: 1, spanY: 1 }]) assert.throws(() => generateCivilLayout(p, { ...cfg, ...patch }));
  assert.throws(() => generateCivilLayout(p, { ...cfg, range: { origin: { x: 0, y: 0 }, width: 400, depth: 400 } }), /超出画板/);
  p.planBoundary = { points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 400 }, { x: 0, y: 400 }] };
  const before = structuredClone(p); assert.throws(() => generateCivilLayout(p, { ...cfg, range: undefined }), /非矩形/); assert.deepEqual(p, before);
});

test('save, reload, engineering JSON and undo preserve structural geometry with independent civil quotes', async () => {
  const p = fixture(); p.regions = [room()]; p.civilElements = [createCivilElement('slab', { x: 50, y: 50 }, p)]; p.civilElements[0].unitPrice = '100'; p.civilElements[0].locked = true;
  const multi = addLevel(p, { copyLayout: true }), store = createMemoryProjectStore(), before = calculateCivilProject(multi); await store.saveProject(multi);
  const loaded = await store.loadProject(multi.id, { hydrateDrawing: false }); assert.deepEqual(calculateCivilProject(loaded), before);
  const restored = await importProjectJSON(await exportProjectJSON(multi)); assert.deepEqual(calculateCivilProject(restored), before); assert.equal(restored.workspaceMode, 'civil');
  const history = createHistory(multi), changed = structuredClone(multi); changed.civilElements[0].height = 25; history.push(changed); assert.deepEqual(history.undo().civilElements, multi.civilElements); assert.deepEqual(history.redo().civilElements, changed.civilElements);
});

test('invalid inactive structural work and orphan slab sources cannot overwrite a good saved project', async () => {
  const p = fixture(); p.civilElements.push(element()); const multi = addLevel(p), store = createMemoryProjectStore(); await store.saveProject(multi);
  const bad = structuredClone(multi); bad.levels[0].content.civilElements[0].width = -1; assert.throws(() => store.saveProject(bad), /构件宽/); assert.deepEqual((await store.loadProject(multi.id, { hydrateDrawing: false })).levels, multi.levels);
  assert.throws(() => validateProject({ ...fixture(), civilElements: [element('slab', { sourceRegionId: 'missing' })] }), /房间/);
});

test('civil validation rejects invalid geometry, categories, prices, steel settings and duplicate objects', () => {
  for (const patch of [{ kind: 'unknown' }, { width: 0 }, { depth: Infinity }, { height: 0 }, { elevation: NaN }, { rotation: NaN }, { position: { x: Infinity, y: 0 } }, { quantity: '0' }, { quantity: '1.5' }, { unitPrice: '-1' }, { laborRate: '-1' }, { wasteRate: '-1' }, { additionalCost: '-1' }, { formworkRate: 'NaN' }, { rebarMode: 'guess' }, { rebarRatio: '-1' }, { rebarQuantity: '-1' }, { rebarPrice: '-1' }, { hidden: 'true' }, { locked: 1 }, { sourceRegionId: 'room' }]) assert.throws(() => validateCivilElements([element('column', patch)], fixture()));
  assert.throws(() => validateCivilElements([element('roundColumn', { depth: 41 })], fixture()), /直径/); assert.throws(() => validateCivilElements([element(), element()], fixture()), /编号/);
  const multi = addLevel({ ...fixture(), civilElements: [element()] }); multi.civilElements.push(element()); assert.throws(() => validateLevels(multi), /编号不能重复/);
});
