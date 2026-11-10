import test from 'node:test';
import assert from 'node:assert/strict';
import { createMunicipalStarter } from '../static/studio/lib/municipal-starters.js';
import { changeMunicipalOption } from '../static/studio/lib/municipal-options.js';
import { municipalMetrics, municipalBridgeQuantities, validateMunicipalElements } from '../static/studio/lib/municipal-design.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
const project = () => ({ version: 1, id: 'starter', name: '起步工程', regions: [], walls: [], drawing: { type: 'plan', width: 120000, height: 90000 }, calibration: { metersPerPixel: .01 }, municipalElements: [], additionalCost: '0', taxRate: '0' });
const settings = { x: 150, y: 150, length: 100, lanes: 4 };

for (const [preset, count] of [['crossroads', 9], ['eight-way', 17], ['roundabout', 5], ['river-bridge', 4]]) test(`${preset} starter creates actual editable geometry with no market prices`, () => {
  const p = project(), before = structuredClone(p), elements = createMunicipalStarter(p, preset, settings);
  assert.equal(elements.length, count); assert.equal(new Set(elements.map(e => e.id)).size, count); assert.deepEqual(p, before);
  p.municipalElements = elements; assert.doesNotThrow(() => validateMunicipalElements(elements, p));
  for (const e of elements) { assert.equal(e.unitPrice, ''); assert.ok(municipalMetrics(e, p).grossArea > 0); }
  const quote = calculateMunicipalProject(p); assert.equal(quote.pending, true); assert.equal(quote.total, null);
});
test('eight-road and ring templates accommodate eight lanes with connected approach endpoints', () => {
  for (const kind of ['eight-way', 'roundabout']) {
    const p = project(), elements = createMunicipalStarter(p, kind, { ...settings, lanes: 8 }); p.municipalElements = elements;
    const junction = elements[0], roads = elements.filter(e => e.kind === 'road');
    assert.equal(junction.width, 2900); assert.equal(roads.length, kind === 'eight-way' ? 8 : 4);
    const radius = (junction.junction.armLength + (kind === 'roundabout' ? junction.junction.islandRadius + junction.width : 0)) / 100;
    for (const road of roads) assert.ok(Math.abs(Math.hypot(road.points[0].x * .01 - settings.x, road.points[0].y * .01 - settings.y) - radius) < 1e-8);
  }
});
test('invalid starter placement and capacity are rejected without modifying an existing project', () => {
  const p = project(), before = structuredClone(p);
  assert.throws(() => createMunicipalStarter(p, 'crossroads', { ...settings, x: 0 }), /范围/);
  assert.throws(() => createMunicipalStarter(p, 'invalid', settings), /方案/);
  assert.throws(() => createMunicipalStarter(p, 'roundabout', { ...settings, length: NaN }), /长度/);
  assert.deepEqual(p, before);
});
test('lane preset command synchronizes actual width and quote while leaving source immutable', () => {
  const p = project(), original = createMunicipalStarter(p, 'river-bridge', settings).find(e => e.kind === 'road'), before = structuredClone(original);
  const changed = changeMunicipalOption(original, 'roadLayout', 'lanes', '8'); p.municipalElements = [changed];
  assert.equal(changed.width, 2900); assert.deepEqual(original, before);
  changed.unitPrice = '10'; changed.laborRate = '2';
  const metrics = municipalMetrics(changed, p); assert.ok(Math.abs(metrics.area - 88 * 29) < 1e-6);
  assert.equal(calculateMunicipalProject(p).total, '30624.00');
  const custom = changeMunicipalOption(changed, 'roadLayout', 'lanes', '0'); assert.equal(custom.width, 2900); assert.equal(custom.roadLayout, undefined);
});
test('locked bridge geometry stays protected while explicitly pricing piers and railing remains possible', () => {
  const p = project(), bridge = createMunicipalStarter(p, 'river-bridge', settings)[1]; bridge.locked = true;
  assert.throws(() => changeMunicipalOption(bridge, 'bridgeOptions', 'pierHeight', '700'), /解锁/);
  let changed = changeMunicipalOption(bridge, 'bridgeOptions', 'pierUnitPrice', '100');
  changed = changeMunicipalOption(changed, 'bridgeOptions', 'railingUnitPrice', '10'); changed.unitPrice = '1'; p.municipalElements = [changed];
  assert.deepEqual(municipalBridgeQuantities(changed, p), { pierCount: 2, railingLength: 48 });
  assert.equal(calculateMunicipalProject(p).total, '1040.00');
  assert.equal(changed.bridgeOptions.pierHeight, bridge.bridgeOptions.pierHeight); assert.equal(bridge.bridgeOptions.pierUnitPrice, '');
});
