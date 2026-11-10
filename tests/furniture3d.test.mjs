import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFurniture3D, validateFurnitureAssets } from '../build/studio/lib/furniture3d.js';
import { furnitureFootprint } from '../build/studio/lib/furniture.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const kinds = ['sofa', 'bed', 'table', 'chair', 'cabinet', 'nightstand', 'wardrobe', 'custom'];
const assetBytes = await readFile(new URL('../static/studio/assets/furniture-original.json', import.meta.url));
const assets = validateFurnitureAssets(JSON.parse(assetBytes));

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const item = (extra = {}) => ({ id: 'furniture', name: '家具', kind: 'custom', position: { x: 200, y: 300 },
  width: 200, depth: 80, height: 100, rotation: 0, quantity: '1', unitPrice: '', additionalCost: '0', ...extra });
const project = (furniture = [item()], extra = {}) => ({ drawing: { type: 'plan' }, calibration: { metersPerPixel: .01 }, furniture, ...extra });
function bounds(model) {
  const points = model.surfaces.flatMap(surface => surface.points);
  return Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))]]));
}

test('all eight fallback furniture forms preserve exact user width, depth and overall height', () => {
  for (const kind of kinds) {
    const value = project([item({ kind })]), model = buildFurniture3D(value)[0], b = bounds(model);
    near(b.x[0], 1); near(b.x[1], 3); near(b.z[0], 2.6); near(b.z[1], 3.4);
    near(b.y[0], 0); near(b.y[1], 1);
    assert.deepEqual(model.size, { width: 2, depth: .8, height: 1 });
    assert.ok(model.surfaces.length >= 6);
    assert.ok(model.surfaces.every(surface => surface.points.length === 4));
  }
});

test('original beveled meshes preserve exact actual dimensions, position and rotation for all eight kinds', () => {
  for (const kind of kinds) {
    for (const rotation of [0, 90, -90]) {
      const value = project([item({ kind, width: 360, depth: 40, height: 215, rotation })]), before = structuredClone(value);
      const model = buildFurniture3D(value, assets)[0], b = bounds(model);
      assert.equal(model.geometrySource, 'original-mesh'); assert.deepEqual(value, before);
      near(b.y[0], 0); near(b.y[1], 2.15);
      if (rotation === 0) { near(b.x[0], .2); near(b.x[1], 3.8); near(b.z[0], 2.8); near(b.z[1], 3.2); }
      else { near(b.x[0], 1.8); near(b.x[1], 2.2); near(b.z[0], 1.2); near(b.z[1], 4.8); }
      assert.equal(model.surfaces.length, assets.models[kind].faces.length);
      for (const surface of model.surfaces) {
        const n = surface.normal; near(Math.hypot(n.x, n.y, n.z), 1);
        const first = surface.points[0];
        for (const point of surface.points) {
          const dot = (point.x-first.x)*n.x+(point.y-first.y)*n.y+(point.z-first.z)*n.z;
          assert.ok(Math.abs(dot) < 2e-6, 'normal must remain perpendicular after nonuniform scaling and rotation');
        }
      }
    }
  }
});

test('asset manifest matches bundled geometry and all eight previews are offline originals', async () => {
  const manifest = JSON.parse(await readFile(new URL('../static/studio/assets/furniture-manifest.json', import.meta.url)));
  assert.equal(manifest.bytes, assetBytes.length);
  assert.equal(manifest.sha256, createHash('sha256').update(assetBytes).digest('hex'));
  assert.equal(manifest.license, 'CC0-1.0'); assert.match(manifest.source, /Original procedural/);
  assert.deepEqual(Object.keys(assets.models).sort(), [...kinds].sort());
  for (const kind of kinds) {
    assert.equal(manifest.modelStats[kind].faces, assets.models[kind].faces.length);
    const preview = await readFile(new URL('../static/studio/assets/' + manifest.modelStats[kind].preview, import.meta.url), 'utf8');
    assert.match(preview, /<svg/); assert.match(preview, /<polygon/);
    assert.doesNotMatch(preview, /<(image|script)|href=|https?:\/\/(?!www\.w3\.org)/);
  }
});

test('invalid bundled asset geometry is rejected before WebGL allocation', () => {
  for (const mutate of [a => a.schema=2, a => a.models.sofa=null, a => a.models.sofa.triangles++,
    a => a.models.sofa.faces[0].points[0][0]=1, a => a.models.sofa.faces[0].points[0][1]=-1,
    a => a.models.sofa.faces[0].normal=[1,1,1], a => a.models.sofa.faces[0].color='bad']) {
    const invalid = structuredClone(assets); mutate(invalid); assert.throws(() => validateFurnitureAssets(invalid), RangeError);
  }
});

test('rotation follows the drawing clockwise convention and all face normals remain unit vectors', () => {
  const model = buildFurniture3D(project([item({ rotation: 90 })]))[0], b = bounds(model);
  near(b.x[0], 1.6); near(b.x[1], 2.4); near(b.z[0], 2); near(b.z[1], 4);
  for (const surface of model.surfaces) near(Math.hypot(surface.normal.x, surface.normal.y, surface.normal.z), 1);
  const negative = bounds(buildFurniture3D(project([item({ rotation: -90 })]))[0]);
  for (const axis of ['x', 'y', 'z']) { near(negative[axis][0], b[axis][0]); near(negative[axis][1], b[axis][1]); }
});

test('calibrated image positions and native centimetre positions share metre dimension semantics', () => {
  const image = project([item()], { drawing: { type: 'image' }, calibration: { metersPerPixel: .025 } });
  const model = buildFurniture3D(image)[0];
  assert.deepEqual(model.position, { x: 5, y: 0, z: 7.5 });
  assert.deepEqual(model.size, { width: 2, depth: .8, height: 1 });
  const footprint = furnitureFootprint(image.furniture[0], image).map(p => ({ x: p.x * .025, z: p.y * .025 }));
  const b = bounds(model);
  near(b.x[0], Math.min(...footprint.map(p => p.x))); near(b.z[1], Math.max(...footprint.map(p => p.z)));
});

test('hidden and uncalibrated furniture do not produce invented geometry', () => {
  assert.deepEqual(buildFurniture3D(project([item({ hidden: true })])), []);
  assert.deepEqual(buildFurniture3D(project([item()], { drawing: { type: 'image' }, calibration: { metersPerPixel: null } })), []);
  assert.deepEqual(buildFurniture3D(project([])), []);
});

test('procurement quantity does not invent additional placed instances', () => {
  const value = project([item({ quantity: '100' })]);
  assert.equal(buildFurniture3D(value).length, 1);
});

test('pure furniture geometry is deterministic and independent from pricing edits', () => {
  const value = project([item({ kind: 'sofa', rotation: 37 })]), before = structuredClone(value), first = buildFurniture3D(value);
  assert.deepEqual(value, before); assert.deepEqual(buildFurniture3D(value), first);
  value.furniture[0].unitPrice = '2000'; value.furniture[0].additionalCost = '60'; value.furniture[0].quantity = '3';
  assert.deepEqual(buildFurniture3D(value), first);
});

test('invalid furniture is rejected rather than producing broken meshes', () => {
  for (const extra of [{ width: 0 }, { height: NaN }, { rotation: Infinity }, { kind: 'unknown' }, { unitPrice: '-1' }]) assert.throws(() => buildFurniture3D(project([item(extra)])));
});
