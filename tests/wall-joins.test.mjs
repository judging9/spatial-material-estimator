import test from 'node:test';
import assert from 'node:assert/strict';
import { wallFootprints, WALL_MITER_LIMIT } from '../build/studio/lib/wall-joins.js';
import { buildWallSolid, validateOpenings } from '../build/studio/lib/wall-solid.js';
import { detectPlanRooms } from '../build/studio/lib/wall-plan.js';
import { buildSceneModel } from '../build/studio/lib/scene-model.js';
import { wallSelection } from '../build/studio/lib/wall-selection.js';
import { wallShapeSelection } from '../build/studio/lib/wall-shape-selection.js';
import { calculateProject } from '../build/studio/lib/pricing.js';
import { makeCircle, makeArc } from '../build/studio/lib/drawing-shapes.js';
import { polygonArea, intersectionArea } from '../build/studio/lib/geometry.js';

const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const wall = (id = 'wall', start = { x: 0, y: 0 }, end = { x: 400, y: 0 }, extra = {}) => ({ id, start, end, thickness: 20, height: 280, ...extra });
const project = (walls = [wall()], extra = {}) => ({ version: 1, id: 'clean', name: '实际连接', walls, openings: [], wallHeight: 280, wallJoinStyle: 'clean', drawing: null, regions: [], calibration: { metersPerPixel: .01 }, additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, ...extra });
const total = solid => solid.metrics.reduce((sum, metric) => sum + metric.netArea, 0);
const top = solid => solid.surfaces.filter(surface => surface.side === 'top').reduce((sum, surface) => sum + polygonArea(surface.points.map(p => ({ x: p.x, y: p.z }))), 0);
const end = solid => solid.metrics.reduce((sum, metric) => sum + metric.endArea, 0);
const opening = (extra = {}) => ({ id: 'opening', wallId: 'wall', kind: 'hole', shape: 'rectangle', offset: 100, bottom: 90, width: 100, height: 100, depth: 20, ...extra });
const material = (price = '100') => ({ id: 'paint', materialId: 'paint', materialName: '用户报价涂料', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: price, wasteRate: '0', laborRate: '0', additionalCost: '0' });
const rotate = (walls, angle) => { const c = Math.cos(angle), s = Math.sin(angle), point = p => ({ x: 700 + p.x * c - p.y * s, y: 800 + p.x * s + p.y * c }); return walls.map(w => ({ ...w, start: point(w.start), end: point(w.end) })); };
const rectangle = () => [wall('north'), wall('east', { x: 400, y: 0 }, { x: 400, y: 300 }), wall('south', { x: 400, y: 300 }, { x: 0, y: 300 }), wall('west', { x: 0, y: 300 }, { x: 0, y: 0 })];

test('clean free ends are true butt caps; missing style preserves legacy square geometry and price', () => {
  const input = project(), before = structuredClone(input), clean = buildWallSolid(input);
  assert.deepEqual(wallFootprints(input.walls, 'clean')[0].points, [{ x: 0, y: -10 }, { x: 400, y: -10 }, { x: 400, y: 10 }, { x: 0, y: 10 }]);
  near(total(clean), 22.4); near(top(clean), .8); near(end(clean), 1.12); near(clean.metrics[0].perimeter, 27.2);
  const legacy = structuredClone(input); delete legacy.wallJoinStyle;
  assert.deepEqual(buildWallSolid(legacy), buildWallSolid({ ...legacy, wallJoinStyle: 'square' }));
  near(total(buildWallSolid(legacy)), 23.52); near(top(buildWallSolid(legacy)), .84);
  const scene = buildSceneModel(input); near(scene.walls[0].size.length, 4); near(scene.bounds.min.x, 0); near(scene.bounds.max.x, 4);
  assert.deepEqual(input, before);
});

test('L miter produces a continuous real corner without square protrusions, including unequal thickness and rotation', () => {
  const base = [wall('first'), wall('second', { x: 400, y: 0 }, { x: 400, y: 300 }, { thickness: 40 })];
  for (const walls of [base, [...base].reverse(), rotate(base, .73)]) {
    const input = project(walls), solid = buildWallSolid(input), footprints = wallFootprints(walls, 'clean');
    near(top(solid), .2 * 4 + .4 * 3); near(total(solid), (4 + 3) * 2 * 2.8); near(end(solid), (.2 + .4) * 2.8);
    near(intersectionArea({ points: footprints[0].points, holes: [] }, { points: footprints[1].points, holes: [] }), 0);
    assert.ok(solid.metrics.every(metric => metric.openingArea === 0));
    for (const measured of solid.metrics) near(wallSelection(solid.surfaces, measured.id).area, measured.netArea);
  }
});

test('thick oblique T branch ends exactly at the host near side and cannot protrude or leave an exposed cap notch', () => {
  const walls = [wall('host'), wall('branch', { x: 200, y: 0 }, { x: 350, y: 200 }, { thickness: 60 })];
  const footprints = wallFootprints(walls, 'clean'), branch = footprints.find(p => p.wallId === 'branch');
  const joint = branch.points.filter(p => Math.abs(p.y - 10) < 1e-8);
  assert.equal(joint.length, 2); near(Math.min(...joint.map(p => p.x)), 170); near(Math.max(...joint.map(p => p.x)), 245);
  assert.ok(branch.points.every(p => p.y >= 10 - 1e-8));
  assert.deepEqual(footprints.find(p => p.wallId === 'host').points, wallFootprints([walls[0]], 'clean')[0].points);
  const solid = buildWallSolid(project(walls)); near(top(solid), 2.225); near(total(solid), 33.6);
  assert.ok(!solid.surfaces.some(s => s.wallId === 'branch' && s.side === 'end' && s.points.every(p => p.y < 2.8 && p.z < .10000001)));
  const shorter = buildWallSolid(project([walls[0], { ...walls[1], height: 180 }])); near(total(shorter), 29.6); near(top(shorter), 2.225);
});

test('orthogonal T and cross contacts share one physical union with no buried or duplicate billed area', () => {
  const walls = [wall('host'), wall('branch', { x: 200, y: 0 }, { x: 200, y: 200 })];
  for (const order of [walls, [...walls].reverse()]) { const solid = buildWallSolid(project(order)); near(top(solid), 1.18); near(total(solid), 32.48); }
  const cross = buildWallSolid(project([wall('a'), wall('b', { x: 200, y: -200 }, { x: 200, y: 200 })]));
  near(top(cross), .8 + .8 - .04); near(total(cross), (4 + 4) * 2 * 2.8 - 4 * .2 * 2.8);
});

test('collinear overlap is removed once and the earlier source owns shared material faces', () => {
  const a = wall('first', undefined, undefined, { items: [material('10')] });
  const b = wall('later', { x: 200, y: 0 }, { x: 600, y: 0 }, { items: [material('100')] });
  const input = project([a, b]), solid = buildWallSolid(input), quote = calculateProject(input);
  near(top(solid), 1.2); near(total(solid), 33.6);
  near(solid.metrics.find(m => m.id === 'first').netArea, 22.4); near(solid.metrics.find(m => m.id === 'later').netArea, 11.2);
  assert.equal(quote.walls.find(w => w.id === 'first').total, '224.00'); assert.equal(quote.walls.find(w => w.id === 'later').total, '1120.00'); assert.equal(quote.total, '1344.00');
  near(total(buildWallSolid(project([b, a]))), 33.6);
  const duplicate = buildWallSolid(project([a, { ...a, id: 'duplicate' }])); near(total(duplicate), 22.4); near(duplicate.metrics.find(m => m.id === 'duplicate').netArea, 0);
});

test('same footprint with unequal height bills each exposed band once while preserving first-wall priority', () => {
  const input = project([wall('first', undefined, undefined, { height: 180, items: [material('10')] }), wall('later', undefined, undefined, { height: 300, items: [material('100')] })]);
  const solid = buildWallSolid(input), quote = calculateProject(input);
  near(total(solid), 24); near(solid.metrics[0].netArea, 14.4); near(solid.metrics[1].netArea, 9.6); assert.equal(quote.total, '1104.00');
});

test('clean closed rectangle shares the exact same footprint between net floor, side selection and 3D', () => {
  const input = project(rectangle()), rooms = detectPlanRooms(input.walls, 'clean'), solid = buildWallSolid(input);
  assert.equal(rooms.length, 1); near(polygonArea(rooms[0].points) / 10000, 3.8 * 2.8); near(top(solid), 2.8); near(total(solid), 78.4); near(end(solid), 0);
  for (const footprint of wallFootprints(input.walls, 'clean')) near(intersectionArea(rooms[0], { points: footprint.points, holes: [] }), 0);
  for (const metric of solid.metrics) { const selection = wallSelection(solid.surfaces, metric.id); near(selection.area, metric.netArea); assert.equal(selection.faces.length, 2); assert.ok(selection.faces.every(f => f.points.length === 4)); }
});

test('miter limit bounds acute-corner extensions instead of creating arbitrary long spikes', () => {
  const angle = 10 * Math.PI / 180, walls = [wall('a'), wall('b', { x: 0, y: 0 }, { x: 400 * Math.cos(angle), y: 400 * Math.sin(angle) })];
  assert.equal(WALL_MITER_LIMIT, 4);
  for (const footprint of wallFootprints(walls, 'clean')) for (const p of [footprint.points[0], footprint.points.at(-1)]) assert.ok(Math.hypot(p.x, p.y) <= 40 + 1e-8);
  const solid = buildWallSolid(project(walls)); assert.ok(total(solid) > 0); assert.ok(solid.surfaces.every(s => s.points.every(p => [p.x, p.y, p.z].every(Number.isFinite))));
});

test('clean door cutout and exact financial totals use actual geometry, waste, labor, fixed costs and tax', () => {
  const input = project([wall('wall', undefined, undefined, { items: [{ ...material(), wasteRate: '10', laborRate: '20', additionalCost: '5' }], additionalCost: '7' })], { openings: [opening({ kind: 'door', offset: 50, bottom: 0, width: 90, height: 210, depth: 4 })], additionalCost: '3', taxRate: '6' });
  const quote = calculateProject(input); near(quote.walls[0].netArea, 18.62); near(quote.walls[0].openingArea, 3.78);
  assert.equal(quote.walls[0].items[0].purchaseQuantity, '20.482'); assert.equal(quote.materialCost, '2048.20'); assert.equal(quote.laborCost, '372.40'); assert.equal(quote.subtotal, '2435.60'); assert.equal(quote.tax, '146.14'); assert.equal(quote.total, '2581.74');
  const before = structuredClone(input); buildWallSolid(input, .6); assert.deepEqual(input, before); assert.deepEqual(calculateProject(input), quote);
});

test('openings cannot occupy trimmed T endpoints, and an aperture touching a butt end has no fictitious masonry jamb', () => {
  const walls = [wall('host'), wall('branch', { x: 200, y: 0 }, { x: 200, y: 200 })];
  assert.throws(() => validateOpenings(project(walls, { openings: [opening({ wallId: 'branch', offset: 0, width: 50 })] })), /墙端|移动|整理/);
  assert.equal(validateOpenings(project(walls, { openings: [opening({ wallId: 'branch', offset: 50, width: 50 })] })).length, 1);
  const solid = buildWallSolid(project([wall()], { openings: [opening({ offset: 0 })] })); near(total(solid), 20.4); near(solid.metrics[0].revealArea, .6); near(end(solid), .92);
});

test('72-chord circle retains one real net room and exact side/top/perimeter conservation without cap teeth', () => {
  const circle = makeCircle({ x: 600, y: 600 }, 200), walls = circle.points.map((start, i) => wall(`circle-${i}`, start, circle.points[(i + 1) % circle.points.length]));
  assert.equal(walls.length, 72); const length = walls.reduce((sum, w) => sum + Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) / 100, 0), rooms = detectPlanRooms(walls, 'clean'), solid = buildWallSolid(project(walls));
  assert.equal(rooms.length, 1); near(polygonArea(rooms[0].points) / 10000, 11.325624478435229); near(total(solid), length * 2 * 2.8); near(top(solid), length * .2); near(end(solid), 0);
  // A curved wall is one construction group: its shared vertical segment
  // edges cancel, while all actual inner/outer floor and ceiling edges remain.
  near(wallShapeSelection(solid.surfaces, walls.map(w => w.id)).perimeter, length * 4);
});

test('convex half-circle plus chord does not mistake adjacent curved endpoints for T joins', () => {
  const arc = makeArc({ x: 600, y: 600 }, 200, 180, 180), walls = arc.points.map((start, i) => wall(`arc-${i}`, start, arc.points[(i + 1) % arc.points.length]));
  assert.equal(walls.length, 37); const length = walls.reduce((sum, w) => sum + Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) / 100, 0), rooms = detectPlanRooms(walls, 'clean'), solid = buildWallSolid(project(walls));
  assert.equal(rooms.length, 1); near(polygonArea(rooms[0].points) / 10000, 5.283267902349967); near(total(solid), length * 2 * 2.8); near(total(solid), 57.57467397140695); near(top(solid), length * .2); near(top(solid), 2.056238356121472); near(end(solid), 0);
  near(wallShapeSelection(solid.surfaces, walls.map(w => w.id)).perimeter, length * 4);
  for (const footprint of wallFootprints(walls, 'clean')) near(intersectionArea(rooms[0], { points: footprint.points, holes: [] }), 0);
});

test('invalid join style is rejected and geometry helpers keep caller data unchanged', () => {
  const walls = rectangle(), before = structuredClone(walls); wallFootprints(walls, 'clean'); detectPlanRooms(walls, 'clean'); buildWallSolid(project(walls)); assert.deepEqual(walls, before);
  assert.throws(() => wallFootprints(walls, 'unknown')); assert.throws(() => buildWallSolid(project(walls, { wallJoinStyle: 'unknown' })));
});
