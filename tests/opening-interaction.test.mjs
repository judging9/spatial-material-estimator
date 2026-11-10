import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.OPENING_BUILD ? pathToFileURL(resolve(process.env.OPENING_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { openingAtPlanPoint, openingPlanPoint, openingMoveBounds, openingPositionValidity, projectToValidOpeningPosition, openingPositionFromPlanDrag, openingMoveFromPointer, openingPositionFromElevationDrag, moveOpening } = await import(new URL('lib/opening-interaction.js', root));
const { validateOpenings, openingPolygon, buildWallSolid } = await import(new URL('lib/wall-solid.js', root));
const { createMemoryProjectStore, createHistory, exportProjectJSON, importProjectJSON, validateProject } = await import(new URL('lib/persistence.js', root));
const { addLevel, levelProjects } = await import(new URL('lib/levels.js', root));
const { calculateProject } = await import(new URL('lib/pricing.js', root));
const wall = (id = 'wall', start = { x: 100, y: 100 }, end = { x: 700, y: 100 }, patch = {}) => ({ id, start, end, height: 300, thickness: 20, ...patch });
const opening = (patch = {}) => ({ id: 'opening', wallId: 'wall', kind: 'window', shape: 'rectangle', offset: 100, bottom: 90, width: 80, height: 100, depth: 8, name: '窗', ...patch });
const fixture = (patch = {}) => ({ version: 1, id: 'opening-project', name: '门窗拖动', drawing: { id: 'plan', type: 'plan', name: '平面', width: 2400, height: 1800, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, walls: [wall()], openings: [opening()], wallHeight: 300, regions: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, ...patch });
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const legal = (p, o, patch) => assert.equal(openingPositionValidity(p, { ...o, ...patch }).valid, true);

test('top view can select door, window and unfilled hole through their true wall projection', () => {
  for (const kind of ['door', 'window', 'hole']) {
    const p = fixture({ openings: [opening({ kind })] }); assert.equal(openingAtPlanPoint(p, { x: 240, y: 100 }, 0).kind, kind);
    assert.equal(openingAtPlanPoint(p, { x: 240, y: 120 }, 0), null); assert.deepEqual(openingPlanPoint(p, p.openings[0]), { x: 240, y: 100 });
  }
});

test('selection tolerance stays screen-sized, with genuine Euclidean corner distance', () => {
  const p = fixture();
  for (const zoom of [.2, 1, 5]) { assert.equal(openingAtPlanPoint(p, { x: 240, y: 110 + 6 / zoom }, 7 / zoom).id, 'opening'); assert.equal(openingAtPlanPoint(p, { x: 240, y: 110 + 8 / zoom }, 7 / zoom), null); }
  assert.equal(openingAtPlanPoint(p, { x: 195, y: 115 }, 6), null); assert.equal(openingAtPlanPoint(p, { x: 195, y: 115 }, 8).id, 'opening');
});

test('selection respects the actual custom polygon projection and returns an independent copy', () => {
  const p = fixture({ openings: [opening({ kind: 'hole', shape: 'polygon', width: 100, points: [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 40, y: 60 }] })] });
  assert.equal(openingAtPlanPoint(p, { x: 205, y: 100 }, 0), null); const selected = openingAtPlanPoint(p, { x: 240, y: 100 }, 0); assert.ok(selected); selected.points[0].x = 999;
  assert.equal(p.openings[0].points[0].x, 20); assert.deepEqual(openingPlanPoint(p, p.openings[0]), { x: 240, y: 100 });
});

test('stacked elevation openings retain selected priority and locked apertures remain selectable', () => {
  const p = fixture({ openings: [opening({ id: 'lower', bottom: 20, height: 60, locked: true }), opening({ id: 'upper', bottom: 100, height: 60 })] });
  assert.equal(openingAtPlanPoint(p, { x: 240, y: 100 }).id, 'upper'); assert.equal(openingAtPlanPoint(p, { x: 240, y: 100 }, 0, 'lower').id, 'lower');
});

test('plan drag projects onto the actual diagonal wall axis and preserves its original sill', () => {
  const p = fixture({ walls: [wall('wall', { x: 100, y: 100 }, { x: 460, y: 580 })], openings: [opening({ bottom: 42.5 })] }), original = p.openings[0], before = structuredClone(p);
  const patch = openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 30, y: 40 }, { snap: false }); near(patch.offset, 150); assert.equal(patch.bottom, 42.5); legal(p, original, patch);
  assert.deepEqual(openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: -80, y: 60 }, { snap: false }), { offset: 100, bottom: 42.5 }); assert.deepEqual(p, before); assert.equal(openingMoveFromPointer, openingPositionFromPlanDrag);
});

test('reversed wall drag uses its real start direction instead of screen orientation', () => {
  const p = fixture({ walls: [wall('wall', { x: 700, y: 100 }, { x: 100, y: 100 })], openings: [opening({ offset: 200 })] });
  const patch = openingPositionFromPlanDrag(p, p.openings[0], { x: 0, y: 0 }, { x: 50, y: 0 }, { snap: false }); assert.deepEqual(patch, { offset: 150, bottom: 90 }); assert.deepEqual(openingPlanPoint(p, p.openings[0]), { x: 460, y: 100 });
});

test('default cm snapping never jitters unchanged coordinates or resets a fractional sill', () => {
  const p = fixture({ openings: [opening({ offset: 100.25, bottom: 90.25 })] }), original = p.openings[0];
  assert.deepEqual(openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 0, y: 0 }), { offset: 100.25, bottom: 90.25 });
  assert.deepEqual(openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 11.1, y: 0 }), { offset: 111, bottom: 90.25 });
});

test('plan wall-end clamp respects physical centerline length and never changes host or dimensions', () => {
  const p = fixture(), original = p.openings[0];
  const left = openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: -1000, y: 0 }, { snap: false }), right = openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 1000, y: 0 }, { snap: false });
  assert.equal(left.offset, 0); assert.equal(right.offset, 520); legal(p, original, left); legal(p, original, right);
  assert.equal(original.wallId, 'wall'); assert.equal(original.width, 80); assert.equal(original.height, 100);
});

test('clean right-angle corner clamps against its actual trimmed end instead of assuming offset zero is legal', () => {
  const p = fixture({ wallJoinStyle: 'clean', walls: [wall(), wall('return', { x: 100, y: 100 }, { x: 100, y: 400 })] }), original = p.openings[0], bounds = openingMoveBounds(p, original);
  near(bounds.minOffset, 10); const patch = openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: -500, y: 0 }, { snap: false }); near(patch.offset, 10); legal(p, original, patch);
  assert.equal(openingPositionValidity(p, { ...original, offset: 9 }).valid, false);
});

test('clean acute corners derive exact nonuniform placement limits from their angled footprint', () => {
  const p = fixture({ wallJoinStyle: 'clean', walls: [wall(), wall('return', { x: 100, y: 100 }, { x: 300, y: 300 })] }), original = p.openings[0], bounds = openingMoveBounds(p, original);
  assert.ok(bounds.minOffset > 10); legal(p, original, { offset: bounds.minOffset, bottom: original.bottom });
  assert.equal(openingPositionValidity(p, { ...original, offset: bounds.minOffset - .01 }).valid, false);
});

test('a long pointer jump cannot tunnel through a 1 cm peer even if its destination is valid beyond it', () => {
  const original = opening({ offset: 50, width: 40, height: 30 }), peer = opening({ id: 'thin', offset: 200, width: 1, height: 1 });
  const p = fixture({ openings: [original, peer] }); assert.equal(openingPositionValidity(p, { ...original, offset: 450 }).valid, true);
  const patch = projectToValidOpeningPosition(p, original, { offset: 450, bottom: 90 }, { snap: false }); assert.ok(patch.offset < 160 && patch.offset > 159.99); legal(p, original, patch);
});

test('continuous collision checks preserve real polygon voids rather than using opening bounding boxes', () => {
  const original = opening({ kind: 'hole', shape: 'polygon', offset: 50, bottom: 50, width: 100, height: 100, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }] });
  const p = fixture({ openings: [original, opening({ id: 'inside-void', offset: 120, bottom: 120, width: 20, height: 20 })] });
  assert.equal(openingPositionValidity(p, original).valid, true); const patch = projectToValidOpeningPosition(p, original, { offset: 70, bottom: 50 }, { snap: false }); near(patch.offset, 70); legal(p, original, patch);
});

test('vertically disjoint peers may share the same plan position and do not block horizontal motion', () => {
  const original = opening({ offset: 50, bottom: 180, height: 50 }), p = fixture({ openings: [original, opening({ id: 'lower', offset: 200, bottom: 20, height: 50 })] });
  const patch = projectToValidOpeningPosition(p, original, { offset: 450, bottom: 180 }, { snap: false }); assert.equal(patch.offset, 450); legal(p, original, patch);
});

test('T-junction drag stops on its near side without jumping to a valid far-side position', () => {
  const original = opening({ offset: 50, width: 40 }), p = fixture({ openings: [original], walls: [wall(), wall('branch', { x: 400, y: 100 }, { x: 400, y: 400 }, { thickness: 40 })] });
  const patch = projectToValidOpeningPosition(p, original, { offset: 500, bottom: 90 }, { snap: false }); assert.ok(patch.offset < 240 && patch.offset > 239.99); legal(p, original, patch);
  assert.equal(openingPositionValidity(p, { ...original, offset: 280 }).valid, false); assert.equal(openingPositionValidity(p, { ...original, offset: 500 }).valid, true);
});

test('an aperture above a low crossing wall can pass without a false full-height obstruction', () => {
  const original = opening({ offset: 50, width: 40, bottom: 180, height: 50 }), p = fixture({ openings: [original], walls: [wall(), wall('branch', { x: 400, y: 100 }, { x: 400, y: 400 }, { thickness: 40, height: 100 })] });
  const patch = projectToValidOpeningPosition(p, original, { offset: 500, bottom: 180 }, { snap: false }); assert.equal(patch.offset, 500); legal(p, original, patch);
});

test('flush clean T end caps block host apertures despite having zero volume overlap', () => {
  const original = opening({ offset: 50, width: 40 }), p = fixture({ wallJoinStyle: 'clean', openings: [original], walls: [wall(), wall('branch', { x: 400, y: 100 }, { x: 400, y: 400 }, { thickness: 40 })] });
  assert.equal(openingPositionValidity(p, { ...original, offset: 280 }).valid, false);
  const patch = projectToValidOpeningPosition(p, original, { offset: 500, bottom: 90 }, { snap: false }); assert.ok(patch.offset < 240 && patch.offset > 239.99); legal(p, original, patch);
  p.walls[1].height = 50; const high = projectToValidOpeningPosition(p, original, { offset: 500, bottom: 90 }, { snap: false }); assert.equal(high.offset, 500); legal(p, original, high);
});

test('collinear clean extensions do not become fictitious T obstacles', () => {
  const p = fixture({ wallJoinStyle: 'clean', walls: [wall(), wall('extension', { x: 700, y: 100 }, { x: 1000, y: 100 })] });
  const patch = projectToValidOpeningPosition(p, p.openings[0], { offset: 520, bottom: 90 }, { snap: false }); assert.equal(patch.offset, 520); legal(p, p.openings[0], patch);
});

test('window and hole elevation drags preserve grab offset, support both axes and clamp roof/floor', () => {
  for (const kind of ['window', 'hole']) {
    const original = opening({ kind }), p = fixture({ openings: [original] });
    assert.deepEqual(openingPositionFromElevationDrag(p, original, { x: 110, y: 130 }, { x: 145.5, y: 170.25 }, { snap: false }), { offset: 135.5, bottom: 130.25 });
    assert.equal(openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 0, y: 1000 }, { snap: false }).bottom, 200);
    assert.equal(openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 0, y: -1000 }, { snap: false }).bottom, 0);
  }
});

test('Shift elevation gestures constrain one physical axis and preserve the untouched fractional coordinate', () => {
  const original = opening({ bottom: 90.25 }), p = fixture({ openings: [original] });
  assert.deepEqual(openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 50, y: 20 }, { shift: true, snap: false }), { offset: 150, bottom: 90.25 });
  assert.deepEqual(openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 20, y: 50 }, { shift: true, snap: false }), { offset: 100, bottom: 140.25 });
});

test('legacy door sill at 20 cm is valid, but all drag helpers preserve it instead of forcing zero', () => {
  const original = opening({ kind: 'door', bottom: 20, height: 210 }), p = fixture({ openings: [original] }); assert.doesNotThrow(() => validateOpenings(p));
  const plan = openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 50, y: 500 }, { snap: false }), elevation = openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 50, y: 50 }, { snap: false });
  assert.deepEqual(plan, { offset: 150, bottom: 20 }); assert.deepEqual(elevation, plan); assert.deepEqual(moveOpening(p, original.id, { offset: 150, bottom: 70 }, { snap: false }), plan);
  assert.equal(openingPositionValidity(p, { ...original, bottom: 30 }).valid, true); assert.equal(openingPositionValidity(p, { ...original, bottom: 100 }).valid, false);
});

test('locked apertures remain in selection and quote while all movement APIs return their unchanged original position', () => {
  const original = opening({ locked: true }), p = fixture({ openings: [original] }); assert.ok(openingAtPlanPoint(p, { x: 240, y: 100 }));
  for (const patch of [projectToValidOpeningPosition(p, original, { offset: 300, bottom: 130 }), openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: 100, y: 0 }), openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 100, y: 40 })]) assert.deepEqual(patch, { offset: 100, bottom: 90 });
  const stale = { ...original, locked: false }; assert.deepEqual(moveOpening(p, stale.id, { offset: 300, bottom: 130 }), { offset: 100, bottom: 90 });
});

test('magnet targets include exact wall center, legal trimmed end and a 1 cm peer clearance', () => {
  const p = fixture(), original = p.openings[0]; assert.equal(projectToValidOpeningPosition(p, original, { offset: 258.4, bottom: 90 }).offset, 260);
  p.openings.push(opening({ id: 'peer', offset: 300 })); const patch = projectToValidOpeningPosition(p, original, { offset: 220, bottom: 90 }); assert.equal(patch.offset, 219); legal(p, original, patch);
});

test('the same elevation opening shape preserves real area, price and dimensions while moving', () => {
  const p = fixture(); p.walls[0].items = [{ id: 'finish', materialId: 'paint', materialName: '涂料', unit: 'm²', quantityMode: 'area', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '0' }];
  const original = p.openings[0], before = calculateProject(p), ring = openingPolygon(original), patch = openingPositionFromElevationDrag(p, original, { x: 0, y: 0 }, { x: 50, y: 20 }, { snap: false }); p.openings[0] = { ...original, ...patch };
  assert.equal(calculateProject(p).total, before.total); assert.equal(buildWallSolid(p).metrics[0].openingArea, buildWallSolid({ ...p, openings: [original] }).metrics[0].openingArea); assert.equal(openingPolygon(p.openings[0]).length, ring.length);
});

test('validity checks whole or explicit id position patches without modifying them or changing a numeric door sill', () => {
  const p = fixture(), patch = { offset: 150, bottom: 110 }, snapshot = structuredClone(p); assert.deepEqual(openingPositionValidity(p, patch, 'opening'), { valid: true, error: null }); assert.deepEqual(p, snapshot);
  assert.match(openingPositionValidity(p, { offset: -1, bottom: 90 }, 'opening').error, /尺寸/); assert.equal(openingPositionValidity(p, patch, 'missing').valid, false);
});

test('lock and name metadata validate in both old square and oriented clean solids', () => {
  for (const style of ['square', 'clean']) for (const patch of [{ locked: 'true' }, { locked: null }, { name: 'a'.repeat(121) }, { name: 123 }]) {
    const p = fixture({ wallJoinStyle: style, openings: [opening(patch)] }); assert.throws(() => validateOpenings(p)); assert.throws(() => validateProject(p));
  }
  assert.doesNotThrow(() => validateOpenings(fixture({ openings: [opening({ name: '', locked: false })] })));
});

test('save/reload, JSON, layer copies and undo keep aperture lock, name and nonzero door sill', async () => {
  const p = fixture({ openings: [opening({ kind: 'door', bottom: 20, height: 210, locked: true, name: '架空门' })] }), store = createMemoryProjectStore(); await store.saveProject(p);
  assert.deepEqual((await store.loadProject(p.id, { hydrateDrawing: false })).openings, p.openings);
  const loaded = await importProjectJSON(await exportProjectJSON(p)); assert.deepEqual(loaded.openings, p.openings);
  const layers = levelProjects(addLevel(p, { copyLayout: true })); assert.notEqual(layers[0].project.openings[0].id, layers[1].project.openings[0].id); assert.equal(layers[1].project.openings[0].locked, true); assert.equal(layers[1].project.openings[0].bottom, 20);
  const history = createHistory(p), changed = structuredClone(p); changed.openings[0].locked = false; changed.openings[0].offset = 200; history.push(changed); assert.deepEqual(history.undo().openings, p.openings); assert.deepEqual(history.redo().openings, changed.openings);
});

test('bad geometry and malformed gestures fail safely before replacing a valid aperture', () => {
  const p = fixture(), original = p.openings[0], before = structuredClone(p);
  assert.throws(() => openingAtPlanPoint(p, { x: NaN, y: 0 })); assert.throws(() => openingAtPlanPoint(p, { x: 0, y: 0 }, -1)); assert.throws(() => openingPositionFromPlanDrag(p, original, { x: 0, y: 0 }, { x: Infinity, y: 0 }));
  assert.throws(() => projectToValidOpeningPosition(p, original, { offset: Infinity, bottom: 90 })); assert.throws(() => moveOpening(p, 'missing', { offset: 1, bottom: 1 }));
  const invalid = { ...original, offset: -10 }; assert.deepEqual(projectToValidOpeningPosition(p, invalid, { offset: 500, bottom: 200 }), { offset: -10, bottom: 90 }); assert.deepEqual(p, before);
});
