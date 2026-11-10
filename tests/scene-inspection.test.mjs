import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.SCENE_INSPECTION_BUILD
  ? pathToFileURL(resolve(process.env.SCENE_INSPECTION_BUILD) + '/')
  : new URL('../static/studio/', import.meta.url);
const { compileTerrainOccluders, terrainCoversInspectionPoints } = await import(new URL('lib/scene-visibility.js', modules));
const { createMunicipalElement } = await import(new URL('lib/municipal-design.js', modules));
const { buildSceneMunicipal } = await import(new URL('lib/municipal-scene.js', modules));
const { buildTerrainScene } = await import(new URL('lib/terrain-scene.js', modules));
const { calculateMunicipalProject } = await import(new URL('lib/municipal-pricing.js', modules));
const { Viewer3D } = await import(new URL('viewer3d.js', modules));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

const surface = points => ({ points, normal: { x: 0, y: 1, z: 0 } });
const plane = (height = 5) => surface([
  { x: 0, y: height, z: 0 }, { x: 40, y: height, z: 0 },
  { x: 40, y: height, z: 40 }, { x: 0, y: height, z: 40 },
]);

test('inspection coverage uses a sloping surveyed triangle, including its actual boundary', () => {
  const terrain = compileTerrainOccluders([surface([
    { x: 0, y: 2, z: 0 }, { x: 4, y: 6, z: 0 }, { x: 0, y: 2, z: 4 },
  ])]);
  const before = structuredClone(terrain);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 1, y: 2.5, z: 1 }]), true);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 1, y: 3, z: 1 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 1, y: 3.1, z: 1 }]), false);
  // Inside the bounding box, but outside the triangle, remains unmeasured.
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 3, y: 0, z: 3 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 4, y: 5, z: 0 }]), true);
  assert.deepEqual(terrain, before);
});

test('coplanar and above-ground geometry stays in real view while a buried point is detected', () => {
  const terrain = compileTerrainOccluders([plane()]);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 5, z: 10 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 6, z: 10 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 4.995, z: 10 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 4.98, z: 10 }]), true);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 100, y: 0, z: 100 }, { x: 10, y: 0, z: 10 }]), true);
});

test('zero inspection tolerance detects a real positive cover without turning coplanar surfaces into cover', () => {
  const terrain = compileTerrainOccluders([plane()]);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 4.995, z: 10 }], 0), true);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 5, z: 10 }], 0), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 10, y: 6, z: 10 }], 0), false);
});

test('inspection rejects invalid tolerances even when there are no usable terrain samples', () => {
  const terrain = compileTerrainOccluders([plane()]), points = [{ x: 10, y: 0, z: 10 }];
  for (const tolerance of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => terrainCoversInspectionPoints(terrain, points, tolerance), /容差/);
    assert.throws(() => terrainCoversInspectionPoints([], points, tolerance), /容差/);
    assert.throws(() => terrainCoversInspectionPoints(terrain, [], tolerance), /容差/);
  }
});

test('empty data and invalid inspection points cannot invent a terrain obstruction', () => {
  const terrain = compileTerrainOccluders([plane()]);
  assert.equal(terrainCoversInspectionPoints([], [{ x: 10, y: 0, z: 10 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, []), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: NaN, y: 0, z: 10 }, { x: 10, y: Infinity, z: 10 }]), false);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: NaN, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }]), true);
});

function terrainSquare(height, left = 0, top = 0, right = 50, bottom = 50) {
  return { name: '实测山体', visible: true, points: [
    { id: 'a', x: left, y: top, z: height }, { id: 'b', x: right, y: top, z: height },
    { id: 'c', x: right, y: bottom, z: height }, { id: 'd', x: left, y: bottom, z: height },
  ] };
}

function projectFixture({ terrain = terrainSquare(20), tunnel = false, elevation = 0 } = {}) {
  const project = {
    version: 1, id: 'scene-inspection', name: '真实山地工程', workspaceMode: 'municipal',
    drawing: { id: 'plan', type: 'plan', name: '场地', width: 10000, height: 10000, url: '' },
    calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [],
    additionalCost: '80.10', taxRate: '9.5', view: { labels: true, drawingOpacity: 1 },
    ...(terrain ? { municipalTerrain: terrain } : {}),
  };
  const road = createMunicipalElement('road', [{ x: 1000, y: 1000 }, { x: 3000, y: 1000 }], project,
    { width: 600, height: 20, elevation: elevation * 100, unitPrice: '12.50', laborRate: '2.75' });
  road.id = 'road'; road.name = '穿山道路';
  if (tunnel) road.tunnel = {
    enabled: true, startStation: 3, endStation: 17, clearHeight: 5, liningThickness: .4, shape: 'box',
    pricingEnabled: true, unitPrice: '100.25', laborRate: '8.50', additionalCost: '80.10',
  };
  project.municipalElements.push(road);
  return project;
}

test('a real DEM NoData strip stays empty during inspection instead of becoming a bounding-box mountain', () => {
  const project = projectFixture({ terrain: {
    name: '缺测 DEM', visible: true, points: [], raster: {
      format: 'esri-ascii', ncols: 6, nrows: 3, xllcorner: 0, yllcorner: 0, cellSize: 10,
      noDataValue: -9999, values: Array.from({ length: 3 }, () => [20, 20, 20, null, 20, 20]).flat(),
      coordinateUnit: 'm', yDirection: 'north-up', originX: 0, originY: 0,
    },
  } });
  const original = structuredClone(project.municipalTerrain), terrain = compileTerrainOccluders(buildTerrainScene(project));
  assert.ok(terrain.length > 0);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 15, y: 0, z: 15 }]), true);
  assert.equal(terrainCoversInspectionPoints(terrain, [{ x: 35, y: 0, z: 15 }]), false);
  assert.deepEqual(project.municipalTerrain, original);
});

function controller(project, mode = 'solid') {
  const viewer = Object.create(Viewer3D.prototype), events = [];
  const terrainData = buildTerrainScene(project), municipalData = buildSceneMunicipal(project);
  Object.assign(viewer, {
    project, municipalData, terrainData, terrainOccluders: compileTerrainOccluders(terrainData),
    terrainDisplayMode: mode, selectedMunicipalElementId: null,
    camera: { target: { x: 3000, y: 2000, z: 1000 }, distance: 1000, yaw: 0, pitch: 1 },
    container: { getBoundingClientRect() { return { width: 900, height: 600 }; } },
    history: { undo: [structuredClone(project)], redo: [] },
    clearNavigation() { events.push('navigation-cleared'); },
    updateNavigationUI() { events.push('navigation-updated'); },
    requestRender() { events.push('render'); },
  });
  return { viewer, events };
}

function measuredState(viewer) {
  return structuredClone({ project: viewer.project, terrain: viewer.terrainData, scene: viewer.municipalData, history: viewer.history });
}

test('the real viewer inspection focuses and selects a generated tunnel road, then reveals surveyed cover', () => {
  const project = projectFixture({ tunnel: true }), { viewer, events } = controller(project);
  const before = measuredState(viewer), quotation = calculateMunicipalProject(project);
  const terrainCache = viewer.terrainOccluders, source = viewer.municipalData[0];
  assert.equal(viewer.inspectMunicipalElement('road'), true);
  assert.equal(viewer.selectedMunicipalElementId, 'road');
  assert.equal(viewer.terrainDisplayMode, 'cutaway');
  near(viewer.camera.target.x, 20); near(viewer.camera.target.y, 2.5); near(viewer.camera.target.z, 10);
  assert.ok(viewer.camera.distance > 20 && viewer.camera.distance < 100);
  near(viewer.camera.yaw, Math.PI / 4); near(viewer.camera.pitch, Math.PI / 6);
  assert.equal(events[0], 'navigation-cleared'); assert.ok(events.includes('render'));
  assert.equal(viewer.terrainOccluders, terrainCache); assert.equal(viewer.municipalData[0], source);
  assert.deepEqual(measuredState(viewer), before);
  assert.deepEqual(calculateMunicipalProject(project), quotation);
});

test('inspection also reveals a flat road whose endpoints are outside a small mountain covering its middle', () => {
  const project = projectFixture({ terrain: terrainSquare(20, 18, 7, 22, 13) }), { viewer } = controller(project);
  const before = measuredState(viewer);
  assert.equal(viewer.inspectMunicipalElement('road'), true);
  assert.equal(viewer.terrainDisplayMode, 'cutaway');
  near(viewer.camera.target.x, 20); near(viewer.camera.target.z, 10);
  assert.deepEqual(measuredState(viewer), before);
});

for (const mode of ['hidden', 'cutaway']) test(`inspection preserves the user's ${mode} choice and still focuses the road`, () => {
  const project = projectFixture({ tunnel: true }), { viewer } = controller(project, mode);
  const before = measuredState(viewer);
  assert.equal(viewer.inspectMunicipalElement('road'), true);
  assert.equal(viewer.terrainDisplayMode, mode); assert.equal(viewer.selectedMunicipalElementId, 'road');
  near(viewer.camera.target.x, 20); near(viewer.camera.target.y, 2.5); near(viewer.camera.target.z, 10);
  assert.deepEqual(measuredState(viewer), before);
});

for (const [label, options] of [
  ['coplanar', { terrain: terrainSquare(20), elevation: 20 }],
  ['above-ground', { terrain: terrainSquare(20), elevation: 25 }],
  ['unmeasured', { terrain: terrainSquare(20, 60, 60, 70, 70) }],
  ['without terrain', { terrain: null }],
]) test(`real viewer inspection leaves a ${label} road in solid mode`, () => {
  const { viewer } = controller(projectFixture(options)), before = measuredState(viewer);
  assert.equal(viewer.inspectMunicipalElement('road'), true);
  assert.equal(viewer.terrainDisplayMode, 'solid'); assert.equal(viewer.selectedMunicipalElementId, 'road');
  assert.deepEqual(measuredState(viewer), before);
});

test('an unknown or unrenderable inspection target cannot reset the camera, selection, terrain or quotation', () => {
  const { viewer } = controller(projectFixture({ tunnel: true })), before = measuredState(viewer), camera = structuredClone(viewer.camera);
  viewer.selectedMunicipalElementId = 'previous';
  assert.equal(viewer.inspectMunicipalElement('missing'), false);
  assert.equal(viewer.selectedMunicipalElementId, 'previous'); assert.equal(viewer.terrainDisplayMode, 'solid');
  assert.deepEqual(viewer.camera, camera); assert.deepEqual(measuredState(viewer), before);
  const empty = { id: 'empty', kind: 'road', surfaces: [], horizontal: [], segments: [] };
  viewer.municipalData.push(empty);
  assert.equal(viewer.inspectMunicipalElement('empty'), false);
  assert.equal(viewer.selectedMunicipalElementId, 'previous'); assert.equal(viewer.terrainDisplayMode, 'solid');
  assert.deepEqual(viewer.camera, camera); assert.deepEqual(viewer.project, before.project);
});
