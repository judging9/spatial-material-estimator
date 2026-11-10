import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.SITE_ELEVATION_BUILD ? pathToFileURL(resolve(process.env.SITE_ELEVATION_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { createMunicipalElement, validateMunicipalElements } = await import(new URL('lib/municipal-design.js', root));
const { setMunicipalElevation, shiftMunicipalElevation, setRoadEndpointElevations, alignMunicipalToTerrain, terrainReferenceElevation, municipalElevationSummary } = await import(new URL('lib/municipal-elevation.js', root));
const { createRoadProfile, validateRoadProfile, roadProfileElevation, roadStations } = await import(new URL('lib/road-profile.js', root));
const { createEarthworkBalance } = await import(new URL('lib/earthwork-balance.js', root));
const { terrainElevation } = await import(new URL('lib/terrain.js', root));

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const fixture = () => ({ version: 1, id: 'site-elevation', name: '实际场地标高', workspaceMode: 'municipal', drawing: { id: 'metric-plan', type: 'plan', name: '场地', width: 120000, height: 90000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], municipalElements: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const tin = (height = 50) => ({ name: '实际测量面', sourceName: '用户测点', visible: true, points: [{ id: 'a', x: 0, y: 0, z: height }, { id: 'b', x: 50, y: 0, z: height }, { id: 'c', x: 50, y: 50, z: height }, { id: 'd', x: 0, y: 50, z: height }] });
const grid = (at, { columns = 21, rows = 7, size = 1 } = {}) => ({ name: '真实栅格样本', sourceName: '用户 DEM', visible: true, points: [], raster: { format: 'esri-ascii', ncols: columns, nrows: rows, xllcorner: 0, yllcorner: -rows * size, cellSize: size, noDataValue: -9999, values: Array.from({ length: columns * rows }, (_, i) => at((i % columns + .5) * size, (Math.floor(i / columns) + .5) * size, i % columns, Math.floor(i / columns))), coordinateUnit: 'm', yDirection: 'north-up', originX: 0, originY: 0 } });
const add = (p, kind = 'road', points = [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], patch = {}) => {
  const item = createMunicipalElement(kind, points, p, { id: `${kind}-${p.municipalElements.length}`, width: 100, unitPrice: '23.015', wasteRate: '8', laborRate: '5.50', additionalCost: '101.01', ...patch });
  p.municipalElements.push(item); return item;
};
const picked = (p, item) => p.municipalElements.find(value => value.id === item.id);
const profileWithOptions = (p, road) => {
  const profile = createRoadProfile(p, road), end = profile.points.at(-1).station;
  profile.points = [{ id: 'start', station: 0, elevation: 10 }, { id: 'summit', station: end / 2, elevation: 12, curveLength: Math.min(2, end / 4) }, { id: 'end', station: end, elevation: 11 }];
  profile.crossSection = { leftSlope: -2, rightSlope: -3 };
  profile.crossfallPoints = [{ id: 'cross-start', station: 0, leftSlope: -2, rightSlope: -3 }, { id: 'cross-end', station: end, leftSlope: -1, rightSlope: -4 }];
  profile.sideSlopes = { enabled: false, leftCut: 2, rightCut: 3, leftFill: 1.5, rightFill: 2, maxWidth: 20, interval: 2 };
  profile.curveTolerance = .003;
  profile.earthwork = { enabled: true, cutUnitPrice: '12.05', fillUnitPrice: '25.01' };
  profile.earthworkBalance = createEarthworkBalance();
  profile.earthworkBalance.usableCutPercent = '75';
  profile.earthworkBalance.naturalPerCompactedFill = '1.05';
  profile.source = { name: '用户纵断面', note: '保留来源' };
  road.roadProfile = profile;
  return profile;
};
const assertUnchangedOnError = (p, action, pattern) => {
  const before = structuredClone(p); assert.throws(action, pattern ?? RangeError); assert.deepEqual(p, before);
};

test('absolute and relative heights use metres, preserving centimetre data and all user prices', () => {
  const p = fixture(), item = add(p), before = structuredClone(p);
  item.source = { book: '当地材料价格', updatedAt: '2026-11-08' };
  const elevated = setMunicipalElevation(p, item.id, 450.125), result = picked(elevated, item);
  near(result.elevation, 45012.5);
  assert.deepEqual(result.points, item.points); assert.deepEqual(result.source, item.source);
  for (const field of ['unitPrice', 'wasteRate', 'laborRate', 'additionalCost', 'quantity', 'unit']) assert.equal(result[field], item[field]);
  near(picked(shiftMunicipalElevation(elevated, item.id, -500), item).elevation, -4987.5);
  assert.equal(before.municipalElements[0].elevation, item.elevation);
  assert.notEqual(elevated, p); assert.notEqual(elevated.municipalElements, p.municipalElements);
});

test('an enabled road shifts every grade point, keeping curves, chainage, crossfall, earthwork and metadata', () => {
  const p = fixture(), item = add(p), originalProfile = profileWithOptions(p, item), before = structuredClone(p);
  item.points[0].z = item.elevation;
  const result = picked(setMunicipalElevation(p, item.id, 500), item), expected = structuredClone(originalProfile);
  expected.points.forEach(point => point.elevation += 490);
  assert.deepEqual(result.roadProfile, expected); near(result.elevation, 50000); near(result.points[0].z, 50000);
  near(roadProfileElevation(result.roadProfile, 5), roadProfileElevation(originalProfile, 5) + 490);
  assert.deepEqual(p.municipalElements[0].roadProfile, before.municipalElements[0].roadProfile);
  assert.doesNotThrow(() => validateRoadProfile(p, result));
});

test('pipeline translations retain different node elevations and apply the existing datum to missing z', () => {
  const p = fixture(), item = add(p, 'pipeline', [{ x: 1000, y: 1000, z: -100 }, { x: 1500, y: 1000, z: -150 }, { x: 2000, y: 1000 }], { elevation: -80 });
  delete item.points[2].z;
  const result = picked(setMunicipalElevation(p, item.id, 100), item);
  near(result.elevation, 10000); assert.deepEqual(result.points.map(point => point.z), [9980, 9930, 10000]);
  near(result.points[1].z - result.points[0].z, -50);
  assert.equal(item.points[2].z, undefined); assert.doesNotThrow(() => validateMunicipalElements([result], p));
});

test('simple start/end road grade follows total polyline chainage and replaces only intermediate controls and curves', () => {
  const p = fixture(), item = add(p, 'road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 2000 }]), originalProfile = profileWithOptions(p, item);
  item.points[1].z = item.elevation;
  const result = picked(setRoadEndpointElevations(p, item.id, 150, 154), item), expected = structuredClone(originalProfile);
  expected.points = result.roadProfile.points;
  expected.enabled = true;
  assert.deepEqual(result.roadProfile, expected); assert.equal(result.roadProfile.points.length, 2);
  assert.deepEqual(result.roadProfile.points.map(point => [point.station, point.elevation]), [[0, 150], [20, 154]]);
  near(roadProfileElevation(result.roadProfile, 10), 152); near(result.points[1].z, 15000);
  assert.deepEqual(result.points.map(({ x, y }) => ({ x, y })), item.points.map(({ x, y }) => ({ x, y })));
  assert.doesNotThrow(() => validateRoadProfile(p, result));
});

test('endpoint grading works on a road without a profile and introduces no market prices', () => {
  const p = fixture(), item = add(p), result = picked(setRoadEndpointElevations(p, item.id, -20, -18), item);
  assert.equal(result.roadProfile.enabled, true); assert.equal(result.roadProfile.earthwork.enabled, false);
  assert.equal(result.roadProfile.earthwork.cutUnitPrice, ''); assert.equal(result.roadProfile.earthwork.fillUnitPrice, '');
  near(result.elevation, -2000); assert.equal(item.roadProfile, undefined);
});

test('invalid numeric heights, absent objects and invalid follow options reject without mutation', () => {
  const p = fixture(), item = add(p); p.municipalTerrain = tin();
  for (const value of [NaN, Infinity, -Infinity, 1000.001, -1000.001, '50', null]) assertUnchangedOnError(p, () => setMunicipalElevation(p, item.id, value));
  for (const value of [NaN, Infinity, -Infinity, '1']) assertUnchangedOnError(p, () => shiftMunicipalElevation(p, item.id, value));
  assertUnchangedOnError(p, () => setMunicipalElevation(p, 'missing', 2));
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { offset: NaN }));
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: 'true' }));
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, null));
  assertUnchangedOnError(p, () => setRoadEndpointElevations(p, item.id, 0, 1001));
});

test('locked objects reject all height actions, and translated internal heights cannot exceed the object range', () => {
  const p = fixture(), item = add(p); p.municipalTerrain = tin(); item.locked = true;
  for (const action of [() => setMunicipalElevation(p, item.id, 1), () => shiftMunicipalElevation(p, item.id, 1), () => alignMunicipalToTerrain(p, item.id), () => setRoadEndpointElevations(p, item.id, 0, 1)]) assertUnchangedOnError(p, action, /锁定/);
  item.locked = false; profileWithOptions(p, item);
  assertUnchangedOnError(p, () => setMunicipalElevation(p, item.id, 1000), /1000/);
  const pipe = add(p, 'pipeline', [{ x: 1000, y: 2000, z: 100000 }, { x: 2000, y: 2000, z: 99900 }], { elevation: 99900 });
  assertUnchangedOnError(p, () => shiftMunicipalElevation(p, pipe.id, 1), /1000/);
  assert.doesNotThrow(() => setMunicipalElevation(p, item.id, -1000));
});

test('flat measured ground gives genuine road, lamp, well, bridge and river reference offsets', () => {
  const p = fixture(); p.municipalTerrain = tin(450);
  for (const [kind, points, expected, label] of [
    ['road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], 450, '顶面'],
    ['streetlight', [{ x: 2500, y: 1000 }], 450, '底部'],
    ['manhole', [{ x: 3000, y: 1000 }], 448.5, '井底'],
    ['bridge', [{ x: 1000, y: 3000 }, { x: 2000, y: 3000 }], 454, '桥面'],
    ['river', [{ x: 1000, y: 4000 }, { x: 2000, y: 4000 }], 450, '水面'],
  ]) {
    const item = add(p, kind, points), next = alignMunicipalToTerrain(p, item.id), result = picked(next, item), summary = municipalElevationSummary(next, item.id);
    near(result.elevation / 100, expected); near(summary.groundElevation, 450); near(summary.anchorDelta, expected - 450); assert.match(summary.referenceLabel, new RegExp(label));
    assert.equal(result.unitPrice, item.unitPrice); assert.equal(summary.sampleCoverage, 'complete');
  }
});

test('user-defined offset supersedes the preset without inferring prices or changing any geometry', () => {
  const p = fixture(); p.municipalTerrain = tin(60); const item = add(p, 'streetlight', [{ x: 1000, y: 1000 }]);
  const next = alignMunicipalToTerrain(p, item.id, { offset: 2.35 }), result = picked(next, item);
  near(result.elevation, 6235); assert.deepEqual(result.points, item.points); assert.deepEqual(next.municipalTerrain, p.municipalTerrain);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: true }), /仅适用于道路和管线/);
});

test('overall pipeline alignment uses its actual first centre and preserves its slope even with a differing datum', () => {
  const p = fixture(); p.municipalTerrain = tin(100);
  const item = add(p, 'pipeline', [{ x: 1000, y: 1000, z: -100 }, { x: 2000, y: 1000, z: -200 }], { elevation: -80 });
  const next = alignMunicipalToTerrain(p, item.id), result = picked(next, item), summary = municipalElevationSummary(next, item.id);
  near(result.points[0].z / 100, 99.2); near(result.points[1].z / 100, 98.2); near(result.elevation / 100, 99.4);
  near(summary.anchorElevation, 99.2); near(summary.anchorDelta, -.8); assert.match(summary.referenceLabel, /管中心/);
});

test('pipeline follow matches original nodes to true terrain plus burial depth, with atomic coverage rejection', () => {
  const p = fixture(); p.municipalTerrain = grid((x, y) => 20 + x * .5 + y * .1, { columns: 51, rows: 31 });
  const item = add(p, 'pipeline', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 3000, y: 2000 }]);
  const next = alignMunicipalToTerrain(p, item.id, { follow: true, offset: -1.2 }), result = picked(next, item);
  for (let i = 0; i < result.points.length; i++) {
    const point = result.points[i]; near(point.z / 100, terrainElevation(p.municipalTerrain, point.x / 100, point.y / 100) - 1.2);
    assert.equal(point.x, item.points[i].x); assert.equal(point.y, item.points[i].y);
  }
  near(result.elevation, result.points[0].z);
  p.municipalTerrain = tin(); item.points[2].x = 6000;
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: true }), /有效地形/);
});

test('a flat terrain-follow road has exactly two grade points and preserves the supplied offset', () => {
  const p = fixture(); p.municipalTerrain = tin(100); const item = add(p);
  const result = picked(alignMunicipalToTerrain(p, item.id, { follow: true, offset: .35 }), item);
  assert.equal(result.roadProfile.enabled, true); assert.equal(result.roadProfile.points.length, 2);
  assert.deepEqual(result.roadProfile.points.map(point => point.station), [0, 10]);
  for (const point of result.roadProfile.points) near(point.elevation, 100.35);
  assert.doesNotThrow(() => validateRoadProfile(p, result));
});

test('true affine DEM slope simplifies without losing height on diagonal or bent routes', () => {
  const p = fixture(); p.municipalTerrain = grid((x, y) => 50 + .3 * x - .2 * y, { columns: 51, rows: 51 });
  for (const points of [[{ x: 1000, y: 1000 }, { x: 3000, y: 2500 }], [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 3000 }]]) {
    const item = add(p, 'road', points), result = picked(alignMunicipalToTerrain(p, item.id, { follow: true, offset: .2 }), item), stations = roadStations(p, item);
    assert.ok(result.roadProfile.points.length <= points.length);
    for (let i = 0; i < points.length; i++) near(roadProfileElevation(result.roadProfile, stations[i]), 50 + .3 * points[i].x / 100 - .2 * points[i].y / 100 + .2);
  }
});

test('a narrow ridge between the usual regular samples is retained at its actual crest and slopes', () => {
  const p = fixture(); p.municipalTerrain = grid((x, _y, col) => col === 7 ? 110 : 10);
  const item = add(p, 'road', [{ x: 150, y: 250 }, { x: 1950, y: 250 }]), result = picked(alignMunicipalToTerrain(p, item.id, { follow: true }), item);
  near(roadProfileElevation(result.roadProfile, 6), 110); near(roadProfileElevation(result.roadProfile, 5.5), 60); near(roadProfileElevation(result.roadProfile, 6.5), 60);
  assert.ok(result.roadProfile.points.some(point => Math.abs(point.station - 6) < 1e-8 && point.elevation === 110));
  assert.ok(result.roadProfile.points.length >= 5);
});

test('following a measured triangle edge and raster sample boundary retains exact start and end chainages', () => {
  const p = fixture(); p.municipalTerrain = grid((x) => 10 + x * .5);
  const item = add(p, 'road', [{ x: 50, y: 150 }, { x: 2050, y: 150 }]), result = picked(alignMunicipalToTerrain(p, item.id, { follow: true }), item);
  assert.deepEqual(result.roadProfile.points.map(point => point.station), [0, 20]);
  near(result.roadProfile.points[0].elevation, 10.25); near(result.roadProfile.points.at(-1).elevation, 20.25);
});

test('an interior NoData strip rejects terrain following even when both road ends have measured elevations', () => {
  const p = fixture(); p.municipalTerrain = grid((_x, _y, col) => col === 10 ? null : 50);
  const item = add(p, 'road', [{ x: 150, y: 320 }, { x: 1950, y: 320 }]);
  assert.notEqual(terrainReferenceElevation(p, item), null); assert.notEqual(terrainElevation(p.municipalTerrain, 19.5, 3.2), null);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: true }), /NoData|有效地形/);
});

test('a road outside the measured TIN hull rejects without extrapolating across the missing land', () => {
  const p = fixture(); p.municipalTerrain = { name: '三角测区', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 10 }, { id: 'b', x: 50, y: 0, z: 20 }, { id: 'c', x: 0, y: 50, z: 30 }] };
  const item = add(p, 'road', [{ x: 1000, y: 1000 }, { x: 4000, y: 4000 }, { x: 1000, y: 4000 }]);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: true }), /NoData|有效地形/);
});

test('terrain following replaces prior vertical curves and preserves all other profile and project configuration', () => {
  const p = fixture(); p.municipalTerrain = tin(200); const item = add(p), previous = profileWithOptions(p, item), before = structuredClone(p);
  const next = alignMunicipalToTerrain(p, item.id, { follow: true }), result = picked(next, item), expected = structuredClone(previous);
  expected.points = result.roadProfile.points;
  assert.deepEqual(result.roadProfile, expected); assert.ok(result.roadProfile.points.every(point => point.curveLength === undefined));
  assert.equal(result.unitPrice, item.unitPrice); assert.deepEqual(p, before); assert.deepEqual(next.municipalTerrain, p.municipalTerrain);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});

test('a large affine grid remains exact with two controls, while over 100 genuine terrain slope changes reject', () => {
  const p = fixture(); p.municipalTerrain = grid((x, y) => 50 + x * .3 - y * .2, { columns: 128, rows: 128 });
  const item = add(p, 'road', [{ x: 150, y: 150 }, { x: 12650, y: 12650 }]), result = picked(alignMunicipalToTerrain(p, item.id, { follow: true }), item);
  assert.equal(result.roadProfile.points.length, 2); near(result.roadProfile.points.at(-1).elevation, 62.65);
  p.municipalTerrain = grid((_x, _y, col) => col % 2 ? 20 : 10, { columns: 128, rows: 3 });
  item.points = [{ x: 150, y: 150 }, { x: 12650, y: 150 }];
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id, { follow: true }), /100 个实际坡折/);
});

test('summary states physical height reference and sampled burial/coverage without labelling manual grades as automatic', () => {
  const p = fixture(); p.municipalTerrain = tin(50); const item = add(p), summary = municipalElevationSummary(p, item.id);
  near(summary.elevation, 0); near(summary.anchorElevation, 0); near(summary.groundElevation, 50); near(summary.anchorDelta, -50);
  assert.equal(summary.sampledBelowTerrain, true); assert.equal(summary.sampleScope, 'control-points-and-midpoints');
  assert.equal(summary.sampledPointCount, 3); assert.equal(summary.coveredPointCount, 3); assert.equal(summary.sampleCoverage, 'complete'); assert.match(summary.warnings.join(' '), /隧道/);
  profileWithOptions(p, item);
  assert.equal(municipalElevationSummary(p, item.id).profileEnabled, true); assert.equal('autoFollow' in municipalElevationSummary(p, item.id), false);
  p.municipalTerrain = tin(50); item.points[1].x = 6000; delete item.roadProfile;
  assert.equal(municipalElevationSummary(p, item.id).sampleCoverage, 'partial');
});

test('un-calibrated images, missing terrain, uncovered anchors and excessively high land never manufacture heights', () => {
  const p = fixture(), item = add(p); assert.equal(terrainReferenceElevation(p, item.id), null);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id), /创建或导入地形/);
  p.municipalTerrain = tin(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  assert.equal(terrainReferenceElevation(p, item.id), null); assert.equal(municipalElevationSummary(p, item.id).groundElevation, null);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id), /校准/);
  p.drawing.type = 'plan'; p.municipalTerrain = tin(1001);
  assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id), /1000/);
  p.municipalTerrain = tin(); item.points = [{ x: 6000, y: 1000 }, { x: 7000, y: 1000 }];
  assert.equal(terrainReferenceElevation(p, item.id), null); assertUnchangedOnError(p, () => alignMunicipalToTerrain(p, item.id), /有效地形/);
});

test('calibrated image coordinates use their real scale, and hidden terrain/canvas zoom do not alter elevations', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = .02; p.municipalTerrain = grid((x, y) => 10 + x * .5 + y * .1, { columns: 61, rows: 61 });
  const item = add(p), a = alignMunicipalToTerrain(p, item.id, { follow: true });
  near(picked(a, item).roadProfile.points.at(-1).station, 20); near(picked(a, item).elevation / 100, 22);
  p.view.zoom = 4; p.view.pan = { x: 100, y: 100 }; p.municipalTerrain.visible = false;
  const b = alignMunicipalToTerrain(p, item.id, { follow: true });
  assert.deepEqual(picked(a, item).roadProfile.points, picked(b, item).roadProfile.points);
  near(terrainReferenceElevation(p, item.id), 22);
});
