import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMunicipalConfig, normalizeMunicipalConfig, calculateMunicipal, municipalRouteLength,
  generateMunicipalItems, validateMunicipalState } from '../build/studio/lib/municipal.js';
import { validateItems } from '../build/studio/lib/cost.js';

const near = (value, expected, tolerance = 1e-8) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);
const config = length => { const value = defaultMunicipalConfig(); value.road.length = length; return value; };
const project = configuration => ({ version: 1, id: 'municipal-test', name: '市政算量', drawing: null,
  calibration: { metersPerPixel: null }, regions: [], additionalCost: '0', taxRate: '0', view: {},
  cost: { modules: { municipal: { enabled: true, config: configuration } } } });

test('1000m×12m road produces 12000m² formation and 4cm asphalt 480m³/1152t', () => {
  const value = config(1000); value.road.width = 12; value.road.carriageway = 12; value.road.sidewalk = 0;
  const model = calculateMunicipal(value);
  near(model.road.formation, 12000);
  near(model.road.layers[0].volume, 480);
  near(model.road.layers[0].quantity, 1152);
  assert.equal(model.road.layers[0].unit, 't');
  near(model.stations.reduce((sum, station) => sum + station.formationArea, 0), 12000);
  assert.equal(model.stations.length, 10);
});
test('asphalt carriageway and common full-width base do not duplicate sidewalk surface', () => {
  const model = calculateMunicipal(config(1000));
  near(model.road.layers[0].area, 8000);
  near(model.road.layers[2].area, 12000);
  near(model.road.sidewalkArea, 4000);
  const value = config(1000); value.road.layers[0].unit = 'm²';
  near(calculateMunicipal(value).road.layers[0].quantity, 8000);
});
test('rain and sewer have independent pipe diameters and 21 wells each at 50m spacing', () => {
  const model = calculateMunicipal(config(1000));
  assert.equal(model.drainage.length, 2);
  assert.equal(model.drainage[0].manholes, 21);
  assert.equal(model.drainage[1].manholes, 21);
  assert.equal(model.drainage[0].nominalDiameter, 600);
  assert.equal(model.drainage[1].nominalDiameter, 400);
  assert.ok(model.drainage[0].excavation > model.drainage[1].excavation);
  const value = config(1000); value.drainage.rain = false;
  assert.deepEqual(calculateMunicipal(value).drainage.map(pipe => pipe.kind), ['sewer']);
});
test('single-side road lights are 35 sets; both sides double lights, handholes and cable', () => {
  const value = config(1000); value.lighting.side = 'left';
  const single = calculateMunicipal(value).lighting;
  assert.equal(single.poles, 35); assert.equal(single.handholes, 35); near(single.cable, 1100);
  value.lighting.side = 'both';
  const both = calculateMunicipal(value).lighting;
  assert.equal(both.poles, 70); assert.equal(both.handholes, 70); near(both.cable, 2200);
  value.lighting.enabled = false;
  assert.deepEqual(calculateMunicipal(value).lighting, { poles: 0, cable: 0, handholes: 0 });
});
test('trench excavation grows with diameter/depth, backfill has conserved non-overlapping deductions', () => {
  const value = config(1000), base = calculateMunicipal(value).drainage[0];
  value.drainage.diameterRain = 800;
  const larger = calculateMunicipal(value).drainage[0];
  assert.ok(larger.excavation > base.excavation);
  value.drainage.depth = 3;
  assert.ok(calculateMunicipal(value).drainage[0].excavation > larger.excavation);
  near(base.excavation, base.backfill + base.surplus);
  near(base.surplus, base.pipeVolume + base.wellVolume + base.foundation);
  assert.ok(base.pipeVolume < Math.PI * .6 ** 2 / 4 * 1000, 'well station segments must not be counted again as pipe void');
  assert.ok(base.backfill >= 0);
});
test('zero road length creates no phantom well, lamp, bridge or priced item', () => {
  const value = config(0); value.bridge.enabled = true;
  const model = calculateMunicipal(value);
  assert.equal(model.road.formation, 0);
  assert.ok(model.road.layers.every(layer => layer.quantity === 0));
  assert.ok(model.drainage.every(pipe => pipe.manholes === 0 && pipe.excavation === 0 && pipe.backfill === 0));
  assert.equal(model.lighting.poles, 0); assert.equal(model.greening.trees, 0);
  assert.equal(model.bridge, null); assert.deepEqual(model.stations, []);
  assert.deepEqual(generateMunicipalItems(project(value)), []);
});
test('bridge is absent unless enabled and then uses explicitly labelled reference indicator', () => {
  const value = config(200);
  assert.ok(generateMunicipalItems(project(value)).every(item => !item.id.endsWith(':bridge')));
  value.bridge.enabled = true; value.bridge.span = 20; value.bridge.width = 12;
  const bridge = generateMunicipalItems(project(value)).find(item => item.id === 'municipal:bridge');
  assert.equal(bridge.quantity, '240'); assert.equal(bridge.amount, '1080000.00');
  assert.equal(bridge.estimate, true); assert.equal(bridge.priceStatus, 'reference');
  assert.match(bridge.note, /参考值/); assert.match(bridge.note, /±40%/);
});
test('stable code/id output, unpriced rows and local per-item price overrides survive regeneration', () => {
  const input = project(config(200)), original = structuredClone(input);
  const first = generateMunicipalItems(input), second = generateMunicipalItems(input);
  assert.deepEqual(first, second); assert.deepEqual(input, original);
  assert.ok(validateItems(first).ok);
  assert.ok(first.every(item => item.priceStatus === 'missing' && item.amount === '0.00'));
  assert.equal(first.filter(item => item.category === '措施项目').length, 3);
  input.cost.modules.municipal.priceOverrides = { 'municipal:rain-pipe': '150' };
  const quoted = generateMunicipalItems(input).find(item => item.id === 'municipal:rain-pipe');
  assert.equal(quoted.quantity, '200'); assert.equal(quoted.amount, '30000.00'); assert.equal(quoted.priceStatus, 'confirmed');
  input.cost.modules.municipal.config.road.length = 300;
  assert.equal(generateMunicipalItems(input).find(item => item.id === quoted.id).amount, '45000.00');
});
test('route length follows all measured segments rather than bounding box or endpoint shortcut', () => {
  near(municipalRouteLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }]), 11);
  assert.throws(() => municipalRouteLength([]), RangeError);
  assert.throws(() => municipalRouteLength([{ x: 0, y: 0 }, { x: Infinity, y: 0 }]), RangeError);
});
test('negative, nonfinite, inconsistent widths, invalid units and out-of-range configuration are rejected', () => {
  const mutations = [
    value => value.road.length = -1,
    value => value.road.length = Infinity,
    value => value.road.carriageway = 20,
    value => value.road.layers[0].thickness = 0,
    value => value.road.layers[0].unit = 'wrong',
    value => value.drainage.manholeSpacing = 0,
    value => value.lighting.spacing = 0,
    value => value.greening.treeSpacing = -1,
    value => value.allowances.roadFillRatio = 2,
    value => value.bridge.enabled = 'true',
  ];
  for (const mutate of mutations) { const value = config(200); mutate(value); assert.throws(() => normalizeMunicipalConfig(value), RangeError); }
  assert.throws(() => calculateMunicipal(undefined), RangeError);
  assert.throws(() => normalizeMunicipalConfig(null), RangeError);
  assert.throws(() => validateMunicipalState({ config: { road: { length: NaN } } }), RangeError);
});
