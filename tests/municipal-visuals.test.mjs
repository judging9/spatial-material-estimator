import test from 'node:test';
import assert from 'node:assert/strict';
import { createMunicipalElement, municipalBridgeQuantities, municipalFootprints, municipalMetrics } from '../static/studio/lib/municipal-design.js';
import { municipalDecorations, municipalBridgeSupports, municipalBridgeRailPaths } from '../static/studio/lib/municipal-decoration.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { pointInRegion } from '../static/studio/lib/geometry.js';
const fixture = () => ({ version: 1, id: 'visual', name: '三维场地', regions: [], walls: [], drawing: { type: 'plan', width: 120000, height: 90000 }, calibration: { metersPerPixel: .01 }, municipalElements: [], additionalCost: '0', taxRate: '0' });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const finiteScene = (source, id) => { for (const s of source.surfaces) { assert.equal(s.wallId, `municipal:${id}`); for (const p of [...s.points, s.normal]) assert.ok([p.x, p.y, p.z].every(Number.isFinite)); } };

for (const lanes of [2, 4, 8]) test(`${lanes} lane road paints real directional markings inside its own measured boundary`, () => {
  const p = fixture(), item = createMunicipalElement('road', [{ x: 6000, y: 6000 }, { x: 9000, y: 6000 }], p, { roadLayout: { lanes, laneWidth: 350, medianWidth: 100 } }); p.municipalElements = [item];
  const before = municipalMetrics(item, p), marks = municipalDecorations(item, p), parts = municipalFootprints(item, p);
  assert.equal(marks.filter(m => m.kind === 'arrow').length, lanes); assert.ok(marks.some(m => m.kind === 'median'));
  for (const mark of marks) for (const point of mark.points) assert.ok(parts.some(part => pointInRegion(point, part)));
  const scene = buildSceneMunicipal(p)[0]; finiteScene(scene, item.id); assert.ok(scene.surfaces.some(s => s.id.includes('decoration')));
  assert.deepEqual(municipalMetrics(item, p), before);
});
test('eight-arm junction crosswalks and stops remain within editable geometry', () => {
  const p = fixture(), item = createMunicipalElement('intersection', [{ x: 10000, y: 10000 }], p, { junction: { arms: 8, armLength: 5000, rotation: 17, islandRadius: 600 } }); p.municipalElements = [item];
  const marks = municipalDecorations(item, p); assert.equal(marks.filter(m => m.kind === 'stop').length, 8); assert.ok(marks.filter(m => m.kind === 'crosswalk').length >= 40);
  finiteScene(buildSceneMunicipal(p)[0], item.id);
});
test('middle pier placement matches actual quoted count and maximum spacing without endpoint piers', () => {
  const p = fixture(), item = createMunicipalElement('bridge', [{ x: 6000, y: 6000 }, { x: 8500, y: 6000 }], p, { bridgeOptions: { pierSpacing: 800, pierHeight: 600, railingHeight: 120 } }); p.municipalElements = [item];
  const count = municipalBridgeQuantities(item, p).pierCount, supports = municipalBridgeSupports(item, p);
  assert.equal(count, 3); assert.equal(supports.length, count); supports.forEach((s, i) => near(s.station * .01, (i + 1) * 25 / 4));
  const scene = buildSceneMunicipal(p)[0]; assert.equal(scene.surfaces.filter(s => s.id.includes('pier-cap')).length, count * 6); finiteScene(scene, item.id);
  const dense = createMunicipalElement('bridge', [{ x: 1000, y: 2000 }, { x: 51000, y: 2000 }], p, { bridgeOptions: { pierSpacing: 100, pierHeight: 600, railingHeight: 120 } });
  assert.equal(municipalBridgeSupports(dense, p).length, 499);
});
test('bent bridge rails use true offset paths and equal quoted perimeter less the two caps', () => {
  const p = fixture(), item = createMunicipalElement('bridge', [{ x: 6000, y: 6000 }, { x: 9000, y: 6000 }, { x: 9000, y: 9000 }], p); p.municipalElements = [item];
  const paths = municipalBridgeRailPaths(item, p), lengths = paths.map(path => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y) * .01, 0));
  near(lengths[0], 54); near(lengths[1], 66); near(lengths[0] + lengths[1], municipalBridgeQuantities(item, p).railingLength);
  const scene = buildSceneMunicipal(p)[0]; finiteScene(scene, item.id); assert.ok(scene.surfaces.some(s => s.id.includes(':rail:')));
});
test('traffic lenses react to real phase and rotation while all pieces remain selectable as one object', () => {
  const p = fixture(), item = createMunicipalElement('trafficlight', [{ x: 8000, y: 8000 }], p); p.municipalElements = [item];
  const red = buildSceneMunicipal(p)[0], before = municipalMetrics(item, p);
  item.trafficSignal = { phase: 'green', rotation: 90 }; const green = buildSceneMunicipal(p)[0];
  assert.ok(red.surfaces.some(s => s.id.includes('signal-lens:red') && s.color === '#d96b62'));
  assert.ok(green.surfaces.some(s => s.id.includes('signal-lens:green') && s.color === '#68b18c'));
  finiteScene(green, item.id); assert.deepEqual(municipalMetrics(item, p), before);
});
test('river bank elevation responds to its displayed height without altering measured channel volume', () => {
  const p = fixture(), item = createMunicipalElement('river', [{ x: 6000, y: 6000 }, { x: 9000, y: 6000 }], p, { width: 1000, depth: 200, elevation: -100, height: 80 }); p.municipalElements = [item];
  const scene = buildSceneMunicipal(p)[0], bank = scene.surfaces.filter(s => s.id.includes(':bank:'));
  near(Math.max(...bank.flatMap(s => s.points.map(p => p.y))), -.2); near(municipalMetrics(item, p).volume, 600); finiteScene(scene, item.id);
});
