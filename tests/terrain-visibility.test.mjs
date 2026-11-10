import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modules = process.env.TERRAIN_VISIBILITY_BUILD ? pathToFileURL(resolve(process.env.TERRAIN_VISIBILITY_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { terrainDisplaySettings, compileTerrainOccluders, nearestTerrainRayDistance, tunnelInspectionCamera } = await import(new URL('lib/scene-visibility.js', modules));
const { lookAt4, multiply4, perspective4, normalize3 } = await import(new URL('lib/camera3d.js', modules));
const { Viewer3D } = await import(new URL('viewer3d.js', modules));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const surface = (points, normal = { x: 0, y: 1, z: 0 }) => ({ id: 'terrain', wallId: 'terrain', sourceIds: [], side: 'end', points, normal });
const plane = (y = 5, left = -10, right = 10) => surface([{ x: left, y, z: -10 }, { x: right, y, z: -10 }, { x: right, y, z: 10 }, { x: left, y, z: 10 }]);

test('terrain modes expose real solid, transparent inspection and hidden states with safe depth semantics', () => {
  assert.deepEqual(terrainDisplaySettings('solid'), { opacity: 1, drawTerrain: true, writeDepth: true, occludesPicking: true });
  assert.deepEqual(terrainDisplaySettings('cutaway'), { opacity: .22, drawTerrain: true, writeDepth: false, occludesPicking: false });
  assert.deepEqual(terrainDisplaySettings('hidden'), { opacity: 0, drawTerrain: false, writeDepth: false, occludesPicking: false });
  for (const mode of [undefined, null, 'transparent', '__proto__']) assert.throws(() => terrainDisplaySettings(mode), /显示方式/);
});

test('actual sloping terrain triangles determine the hit, rather than a flat altitude or aggregate bounding box', () => {
  const slope = surface([{ x: 0, y: 2, z: 0 }, { x: 4, y: 6, z: 0 }, { x: 0, y: 2, z: 4 }], { x: -1, y: 1, z: 0 });
  const original = structuredClone(slope), cache = compileTerrainOccluders([slope]);
  near(nearestTerrainRayDistance({ x: 1, y: 10, z: 1 }, { x: 0, y: -1, z: 0 }, cache), 7);
  // This point is inside the triangle's bounding box and outside its boundary.
  assert.equal(nearestTerrainRayDistance({ x: 3, y: 10, z: 3 }, { x: 0, y: -1, z: 0 }, cache), null);
  assert.deepEqual(slope, original);
});

test('nearest real terrain intersection respects distance limits and both sides of a surface', () => {
  const cache = compileTerrainOccluders([plane(2), plane(5)]), origin = { x: 0, y: 10, z: 0 }, down = { x: 0, y: -1, z: 0 };
  near(nearestTerrainRayDistance(origin, down, cache), 5);
  assert.equal(nearestTerrainRayDistance(origin, down, cache, 4.9), null);
  near(nearestTerrainRayDistance(origin, down, cache, 5), 5);
  near(nearestTerrainRayDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, cache), 2);
  assert.equal(nearestTerrainRayDistance(origin, { x: 1, y: 0, z: 0 }, cache), null);
});

test('terrain gaps, NoData and a real portal cut retain empty ray paths', () => {
  const cache = compileTerrainOccluders([plane(5, -10, -2), plane(5, 2, 10)]);
  assert.equal(nearestTerrainRayDistance({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, cache), null);
  near(nearestTerrainRayDistance({ x: 3, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, cache), 5);
  assert.equal(nearestTerrainRayDistance({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, []), null);
});

function selectionController(terrain = [plane()], height = 0, fallback = false) {
  const viewer = Object.create(Viewer3D.prototype), cap = { id: 'road', points: plane(height).points, holes: [], color: '#73887e' };
  Object.assign(viewer, {
    terrainDisplayMode: 'solid', terrainData: terrain, terrainOccluders: compileTerrainOccluders(terrain), sceneError: null,
    project: { id: 'project', workspaceMode: 'municipal', additionalCost: '25', taxRate: '9' }, camera: { target: { x: 0, y: 0, z: 0 }, distance: 20, yaw: 0, pitch: 1.5 },
    viewport: { width: 100, height: 100 }, viewProjection: multiply4(perspective4(Math.PI / 4, 1, .1, 100), lookAt4({ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })),
    hasGeometry() { return true; }, updateCamera() {}, requestRender() { this.renderRequests++; }, renderRequests: 0,
    wallMeshes: [], insertMeshes: [], furnitureMeshes: [], slabMeshes: [], floorMeshes: [], serviceMeshes: [], civilMeshes: [], openingTargets: [],
    municipalMeshes: [{ source: { id: 'road', diameter: fallback ? 100 : 1, segments: fallback ? [{ start: { x: -5, y: height, z: 0 }, end: { x: 5, y: height, z: 0 } }] : [] }, surfaces: [], horizontal: fallback ? [] : [{ source: cap }] }],
  });
  return viewer;
}

test('the actual controller blocks an underground road in solid view and selects it in cutaway and hidden views', () => {
  const viewer = selectionController(), before = structuredClone({ project: viewer.project, camera: viewer.camera, terrain: viewer.terrainData });
  assert.equal(viewer.hitTest(50, 50).municipalElementId, null);
  viewer.setTerrainDisplayMode('cutaway'); assert.equal(viewer.hitTest(50, 50).municipalElementId, 'road');
  viewer.setTerrainDisplayMode('hidden'); assert.equal(viewer.hitTest(50, 50).municipalElementId, 'road');
  viewer.setTerrainDisplayMode('solid'); assert.equal(viewer.hitTest(50, 50).municipalElementId, null);
  assert.deepEqual({ project: viewer.project, camera: viewer.camera, terrain: viewer.terrainData }, before);
  assert.equal(viewer.renderRequests, 3);
  assert.throws(() => viewer.setTerrainDisplayMode('bad'), /显示方式/); assert.equal(viewer.terrainDisplayMode, 'solid');
});

test('solid selection preserves visible facilities and traverses an actual cutout without a fake terrain blocker', () => {
  assert.equal(selectionController([plane()], 6).hitTest(50, 50).municipalElementId, 'road');
  assert.equal(selectionController([plane()], 5).hitTest(50, 50).municipalElementId, 'road');
  assert.equal(selectionController([plane(5, -10, -2), plane(5, 2, 10)], 0).hitTest(50, 50).municipalElementId, 'road');
});

test('wide road centreline convenience picking cannot bypass mountain occlusion using the road width as a radius', () => {
  const viewer = selectionController([plane()], 0, true);
  assert.equal(viewer.hitTest(50, 50).municipalElementId, null);
  viewer.setTerrainDisplayMode('cutaway'); assert.equal(viewer.hitTest(50, 50).municipalElementId, 'road');
  viewer.setTerrainDisplayMode('hidden'); assert.equal(viewer.hitTest(50, 50).municipalElementId, 'road');
});

test('real project refresh retains inspection mode and geometry cache, while a different project returns to solid view', () => {
  const viewer = Object.create(Viewer3D.prototype), terrain = { name: '现场地形', visible: true, points: [{ id: 'a', x: 0, y: 0, z: 5 }, { id: 'b', x: 10, y: 0, z: 5 }, { id: 'c', x: 0, y: 10, z: 5 }] };
  const project = { id: 'first', name: '工程', workspaceMode: 'municipal', regions: [], walls: [], municipalElements: [], municipalTerrain: terrain, calibration: { metersPerPixel: .1 }, additionalCost: '25', taxRate: '9' };
  Object.assign(viewer, { project: null, terrainDisplayMode: 'solid', terrainData: [], terrainOccluders: [], furnitureData: [], serviceData: [], municipalData: [],
    model: { walls: [], floors: [], bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } } },
    camera: { target: { x: 1, y: 2, z: 3 }, distance: 20, yaw: .7, pitch: .3 }, callbacks: { error(message) { assert.fail(message); } },
    signature: '', inputSignature: '', gl: null, cachedJoinStyle: undefined, selectedMunicipalElementId: null,
    updateOverlay() {}, updateNavigationUI() {}, requestRender() {}, fit() {}, clearNavigation() {},
  });
  viewer.setProject(project); viewer.setTerrainDisplayMode('cutaway');
  const cache = viewer.terrainOccluders, model = viewer.model, camera = structuredClone(viewer.camera);
  viewer.setProject({ ...project, name: '新名称', additionalCost: '50', taxRate: '13' });
  assert.equal(viewer.terrainDisplayMode, 'cutaway'); assert.equal(viewer.terrainOccluders, cache); assert.equal(viewer.model, model); assert.deepEqual(viewer.camera, camera);
  viewer.setProject({ ...project, id: 'second' }); assert.equal(viewer.terrainDisplayMode, 'solid'); assert.deepEqual(viewer.camera, camera);
});

function renderingController(mode) {
  const viewer = Object.create(Viewer3D.prototype), draws = [], states = { depthWrite: true, blending: false };
  const gl = { DEPTH_TEST: 1, STENCIL_TEST: 2, BLEND: 3, POLYGON_OFFSET_FILL: 4, COLOR_BUFFER_BIT: 8, DEPTH_BUFFER_BIT: 16, STENCIL_BUFFER_BIT: 32,
    enable(flag) { if (flag === this.BLEND) states.blending = true; }, disable(flag) { if (flag === this.BLEND) states.blending = false; },
    depthMask(enabled) { states.depthWrite = enabled; }, viewport() {}, clearColor() {}, stencilMask() {}, colorMask() {}, clear() {}, useProgram() {}, uniformMatrix4fv() {}, polygonOffset() {}, blendFunc() {},
  };
  Object.assign(viewer, { gl, program: {}, uniforms: { uVP: {} }, canvas: { width: 100, height: 100 }, viewport: { width: 100, height: 100 }, viewProjection: [],
    terrainDisplayMode: mode, terrainData: [plane()], terrainMesh: { id: 'terrain' }, ground: { id: 'grid' }, wallMeshes: [], floorMeshes: [], slabMeshes: [],
    updateCamera() {}, hasGeometry() { return true; }, draw(mesh, color, texture, grid, unlit, opacity = 1) { draws.push({ id: mesh.id, opacity, ...states }); },
    renderFurniture() {}, renderInserts() {}, renderServices() {}, renderCivil() {}, renderMunicipal() { this.draw({ id: 'road' }, []); }, renderSelectedWallFaces() {}, renderSelectionOutline() {}, renderOpeningGuides() {}, renderLabels() {},
  });
  return { viewer, draws, states };
}

for (const mode of ['solid', 'cutaway', 'hidden']) test(`the actual renderer applies ${mode} without a grid hiding underground geometry or leaking WebGL depth state`, () => {
  const { viewer, draws, states } = renderingController(mode); viewer.render();
  assert.equal(draws.some(draw => draw.id === 'grid'), false); assert.equal(states.depthWrite, true); assert.equal(states.blending, false);
  if (mode === 'solid') { assert.deepEqual(draws.map(draw => draw.id), ['terrain', 'road']); assert.equal(draws[0].depthWrite, true); }
  if (mode === 'cutaway') { assert.deepEqual(draws.map(draw => draw.id), ['road', 'terrain']); assert.equal(draws[1].depthWrite, false); assert.equal(draws[1].blending, true); assert.equal(draws[1].opacity, .22); }
  if (mode === 'hidden') assert.deepEqual(draws.map(draw => draw.id), ['road']);
});

const tunnel = { enabled: true, clearHeight: 4, netWidth: 6, length: 100, portals: [{ point: { x: 10, y: 20, z: 30 }, direction: { x: 1, y: .2, z: 0 } }, { point: { x: 110, y: 40, z: 30 }, direction: { x: -1, y: -.2, z: 0 } }] };
for (const position of ['inside', 'start', 'end']) test(`tunnel ${position} camera follows real grade and the portal's inward tangent`, () => {
  const before = structuredClone(tunnel), camera = tunnelInspectionCamera(tunnel, position), viewer = Object.create(Viewer3D.prototype); viewer.camera = camera;
  const eye = viewer.cameraEye(), portal = tunnel.portals[position === 'end' ? 1 : 0], direction = normalize3(portal.direction), signedStep = position === 'inside' ? 2 : -10.5;
  near(eye.x, portal.point.x + direction.x * signedStep); near(eye.y, portal.point.y + direction.y * signedStep + 1.8); near(eye.z, portal.point.z + direction.z * signedStep);
  const heading = normalize3({ x: camera.target.x - eye.x, y: camera.target.y - eye.y, z: camera.target.z - eye.z });
  for (const axis of ['x', 'y', 'z']) near(heading[axis], direction[axis]);
  assert.deepEqual(tunnel, before);
});

test('tunnel positioning rejects disabled and missing portals and keeps a short tunnel viewpoint inside the actual span', () => {
  assert.equal(tunnelInspectionCamera({ ...tunnel, enabled: false }), null);
  assert.equal(tunnelInspectionCamera({ ...tunnel, portals: [] }), null);
  assert.throws(() => tunnelInspectionCamera(tunnel, 'bad'), /查看位置/);
  const camera = tunnelInspectionCamera({ ...tunnel, length: 1 }), viewer = Object.create(Viewer3D.prototype); viewer.camera = camera;
  near(viewer.cameraEye().x, 10 + normalize3(tunnel.portals[0].direction).x * .25);
});

for (const position of ['start', 'end']) test(`a short tunnel ${position} camera still retreats by the full portal dimensions`, () => {
  const camera = tunnelInspectionCamera({ ...tunnel, length: 1 }, position), viewer = Object.create(Viewer3D.prototype); viewer.camera = camera;
  const portal = tunnel.portals[position === 'end' ? 1 : 0], direction = normalize3(portal.direction), eye = viewer.cameraEye();
  near(eye.x, portal.point.x - direction.x * 10.5); near(eye.y, portal.point.y - direction.y * 10.5 + 1.8); near(eye.z, portal.point.z - direction.z * 10.5);
  assert.equal(camera.distance, 2);
});

for (const [netWidth, clearHeight, expected] of [[undefined, 4, 7], [null, 4, 7], [3, 8, 14], [1, .5, 2]]) test(`portal retreat uses clearance ${clearHeight} m and width ${netWidth} without a fake width`, () => {
  const camera = tunnelInspectionCamera({ ...tunnel, netWidth, clearHeight }, 'start'), viewer = Object.create(Viewer3D.prototype); viewer.camera = camera;
  const portal = tunnel.portals[0], direction = normalize3(portal.direction), eye = viewer.cameraEye();
  near(eye.x, portal.point.x - direction.x * expected); near(eye.y, portal.point.y - direction.y * expected + clearHeight * .45); near(eye.z, portal.point.z - direction.z * expected);
});

test('the actual tunnel focus entry selects the road, restores keyboard focus and preserves stored engineering data', () => {
  const viewer = Object.create(Viewer3D.prototype), events = [];
  Object.assign(viewer, { municipalData: [{ id: 'road', tunnel }], project: { id: 'project', taxRate: '9' }, terrainDisplayMode: 'cutaway',
    camera: { target: { x: 0, y: 0, z: 0 }, distance: 100, yaw: 0, pitch: 1 }, canvas: { focus() { events.push('focus'); } },
    clearNavigation() { events.push('clear'); }, setNavigationEnabled(enabled) { events.push(`enabled:${enabled}`); }, updateNavigationUI() {}, requestRender() {},
  });
  const before = structuredClone({ project: viewer.project, municipalData: viewer.municipalData });
  assert.equal(viewer.focusTunnel('missing'), false); assert.equal(viewer.focusTunnel('road'), true);
  assert.equal(viewer.selectedMunicipalElementId, 'road'); assert.equal(viewer.terrainDisplayMode, 'cutaway');
  assert.deepEqual(events, ['clear', 'enabled:true', 'focus']); assert.deepEqual({ project: viewer.project, municipalData: viewer.municipalData }, before);
});
