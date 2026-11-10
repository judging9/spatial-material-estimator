import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const modules = process.env.MUNICIPAL_BUILD ? pathToFileURL(resolve(process.env.MUNICIPAL_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const [{ createMunicipalElement, municipalMetrics, municipalFootprints, municipalJunctionArms }, { municipalDecorations }, { pointInRegion }] = await Promise.all(['lib/municipal-design.js', 'lib/municipal-decoration.js', 'lib/geometry.js'].map(file => import(new URL(file, modules))));
const fixture = () => ({ version: 1, id: 'lane-markings', name: '多车道路口', drawing: { id: 'plan', type: 'plan', width: 120000, height: 90000 }, calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [] });
const average = points => points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
const within = (marks, parts) => { for (const mark of marks) for (const point of mark.points) assert.ok(parts.some(part => pointInRegion(point, part)), `${mark.kind} leaves owned geometry`); };

for (const arms of [3, 4, 8]) for (const lanes of [2, 4, 6, 8]) test(`${arms}-arm ${lanes}-lane intersection has per-lane arrows, real markings and incoming stops`, () => {
  const p = fixture(), item = createMunicipalElement('intersection', [{ x: 30000, y: 30000 }], p, { roadLayout: { lanes, laneWidth: 350, medianWidth: lanes > 2 ? 100 : 0 }, junction: { arms, armLength: 12000, rotation: 17, islandRadius: 800 } }); p.municipalElements.push(item);
  const before = structuredClone(item), metrics = municipalMetrics(item, p), marks = municipalDecorations(item, p), parts = municipalFootprints(item, p);
  assert.equal(marks.filter(mark => mark.kind === 'arrow').length, lanes * arms); assert.equal(marks.filter(mark => mark.kind === 'stop').length, arms); assert.ok(marks.some(mark => mark.kind === 'median')); if (lanes > 2) assert.ok(marks.some(mark => mark.kind === 'lane'));
  within(marks, parts); assert.deepEqual(municipalMetrics(item, p), metrics); assert.deepEqual(item, before);
  const armGeometry = municipalJunctionArms(item, p);
  for (const stop of marks.filter(mark => mark.kind === 'stop')) {
    const center = average(stop.points), arm = armGeometry.slice().sort((a, b) => Math.hypot(center.x - a.end.x, center.y - a.end.y) - Math.hypot(center.x - b.end.x, center.y - b.end.y))[0], dx = arm.end.x - item.points[0].x, dy = arm.end.y - item.points[0].y, length = Math.hypot(dx, dy);
    const offset = ((center.x - item.points[0].x) * -dy + (center.y - item.points[0].y) * dx) / length;
    assert.ok(offset < 0, 'stop line must be on the incoming carriageway');
  }
});

for (const lanes of [2, 4, 6, 8]) test(`${lanes}-lane roundabout has editable-ring lane separators and same-direction arrows`, () => {
  const p = fixture(), item = createMunicipalElement('roundabout', [{ x: 30000, y: 30000 }], p, { roadLayout: { lanes, laneWidth: 350, medianWidth: 100 }, junction: { arms: 4, armLength: 6500, rotation: 22.5, islandRadius: 1000 } }); p.municipalElements.push(item);
  const before = municipalMetrics(item, p), marks = municipalDecorations(item, p), parts = municipalFootprints(item, p), outer = 1000 + item.width;
  assert.equal(marks.filter(mark => mark.kind === 'island').length, 1); within(marks.filter(mark => mark.kind !== 'island'), parts);
  const circular = marks.filter(mark => { const center = average(mark.points); return mark.kind === 'lane' && Math.hypot(center.x - 30000, center.y - 30000) < outer - 10; }); assert.ok(circular.length >= (lanes - 1) * 12);
  const circularArrows = marks.filter(mark => { const center = average(mark.points); return mark.kind === 'arrow' && Math.hypot(center.x - 30000, center.y - 30000) < outer - 10; }); assert.equal(circularArrows.length, lanes * 4);
  for (const mark of circularArrows) {
    const center = average(mark.points), tip = mark.points[3], tail = { x: (mark.points[0].x + mark.points[6].x) / 2, y: (mark.points[0].y + mark.points[6].y) / 2 };
    assert.ok((center.x - 30000) * (tip.y - tail.y) - (center.y - 30000) * (tip.x - tail.x) < 0, 'circulating arrows follow the same direction');
  }
  assert.deepEqual(municipalMetrics(item, p), before);
});

test('an eight-arm eight-lane large roundabout keeps marking work bounded and its retained island intact', () => {
  const p = fixture(), item = createMunicipalElement('roundabout', [{ x: 50000, y: 45000 }], p, { roadLayout: { lanes: 8, laneWidth: 350, medianWidth: 100 }, junction: { arms: 8, armLength: 18000, rotation: 13, islandRadius: 9000 } }); p.municipalElements.push(item);
  const marks = municipalDecorations(item, p); assert.ok(marks.length <= 1024); assert.equal(marks.filter(mark => mark.kind === 'island').length, 1); assert.ok(marks.every(mark => mark.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
});

test('shared-road ownership clips markings and uncalibrated drawings generate no false visual measurements', () => {
  const p = fixture(), intersection = createMunicipalElement('intersection', [{ x: 20000, y: 20000 }], p, { roadLayout: { lanes: 4, laneWidth: 350, medianWidth: 100 }, junction: { arms: 4, armLength: 6500, rotation: 0, islandRadius: 800 } }), road = createMunicipalElement('road', [{ x: 15000, y: 20000 }, { x: 26000, y: 20000 }], p, { width: 1500 }); p.municipalElements = [road, intersection];
  within(municipalDecorations(intersection, p), municipalFootprints(intersection, p));
  assert.deepEqual(municipalDecorations(road, { ...p, drawing: { ...p.drawing, type: 'image' }, calibration: { metersPerPixel: null } }), []);
});
