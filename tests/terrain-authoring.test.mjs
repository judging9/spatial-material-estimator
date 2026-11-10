import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = process.env.TERRAIN_BUILD ? pathToFileURL(resolve(process.env.TERRAIN_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { createTerrainGrid, applyTerrainBrush, carveTerrainRiver, terrainPathDistance } = await import(new URL('lib/terrain-authoring.js', base));
const { validateTerrain, terrainElevation, terrainStats, calculateTerrainEarthworks } = await import(new URL('lib/terrain.js', base));
const grid = (change = {}) => createTerrainGrid({ width: 20, length: 20, cellSize: 2, baseElevation: 10, relief: 4, preset: 'flat', ...change });
const near = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const rectangle = (x, y, w, h, z) => [[{ x, y, z }, { x: x + w, y, z }, { x: x + w, y: y + h, z }], [{ x, y, z }, { x: x + w, y: y + h, z }, { x, y: y + h, z }]];

test('created flat terrain has actual metre positions, exact elevation, area and explicit concept provenance', () => {
  const model = grid(); validateTerrain(model);
  assert.match(model.sourceName, /自建概念地形.*非实测/);
  assert.equal(model.raster.ncols, 11); assert.equal(model.raster.nrows, 11);
  near(terrainElevation(model, 0, 0), 10); near(terrainElevation(model, 20, 20), 10);
  near(terrainStats(model).area, 400);
  const earthworks = calculateTerrainEarthworks(model, rectangle(0, 0, 20, 20, 12));
  near(earthworks.fillVolume, 800); near(earthworks.cutVolume, 0); assert.equal(earthworks.status, 'complete');
});
test('grid generation rounds spans upwards to complete square intervals, including shifted origins', () => {
  const model = grid({ width: 21, length: 15, cellSize: 2, originX: 100, originY: 200 });
  assert.equal(model.raster.ncols, 12); assert.equal(model.raster.nrows, 9);
  near(terrainElevation(model, 100, 200), 10); near(terrainElevation(model, 122, 216), 10);
  near(terrainStats(model).area, 352);
});
test('hill, basin and valley use deterministic chosen heights instead of randomized survey data', () => {
  const hill = grid({ preset: 'hill' }), basin = grid({ preset: 'basin' }), valley = grid({ preset: 'valley' });
  assert.deepEqual(hill, grid({ preset: 'hill' }));
  near(terrainElevation(hill, 10, 10), 14); near(terrainElevation(basin, 10, 10), 6); near(terrainElevation(valley, 10, 10), 6);
  near(terrainElevation(hill, 0, 0), 10); near(terrainElevation(valley, 0, 10), 10);
});
test('generation rejects invalid data and excessive density before allocating elevations', () => {
  for (const change of [{ width: 0 }, { length: Infinity }, { cellSize: 0 }, { cellSize: .001 }, { baseElevation: NaN }, { relief: -1 }, { preset: 'unknown' }, { originX: Infinity }, { baseElevation: 100000, preset: 'hill', relief: 1 }]) assert.throws(() => grid(change));
});
test('raising/lowering stamp has exact centre change, smooth radial falloff, untouched edges and no mutation', () => {
  const before = grid(), snapshot = structuredClone(before);
  const raised = applyTerrainBrush(before, { x: 10, y: 10 }, { mode: 'raise', radius: 4, strength: 2 });
  near(terrainElevation(raised, 10, 10), 12); near(terrainElevation(raised, 12, 10), 11.125); near(terrainElevation(raised, 14, 10), 10);
  const lowered = applyTerrainBrush(raised, { x: 10, y: 10 }, { mode: 'lower', radius: 4, strength: 2 });
  near(terrainElevation(lowered, 10, 10), 10); assert.deepEqual(before, snapshot); assert.match(raised.sourceName, /人工塑形/);
});
test('flatten approaches the chosen absolute elevation without overshoot', () => {
  const model = grid();
  const lower = applyTerrainBrush(model, { x: 10, y: 10 }, { mode: 'flatten', radius: 6, strength: 100, targetElevation: 8 });
  near(terrainElevation(lower, 10, 10), 8);
  const upper = applyTerrainBrush(model, { x: 10, y: 10 }, { mode: 'flatten', radius: 6, strength: 1, targetElevation: 12 });
  near(terrainElevation(upper, 10, 10), 11);
  assert.throws(() => applyTerrainBrush(model, { x: 0, y: 0 }, { mode: 'flatten', radius: 3, strength: 1 }));
});
test('smoothing reads original neighbours and preserves NoData without fabricated fill', () => {
  const model = grid(), index = 5 * model.raster.ncols + 5;
  model.raster.values[index] = 19; model.raster.values[index - 1] = null;
  const smoothed = applyTerrainBrush(model, { x: 10, y: 10 }, { mode: 'smooth', radius: 3, strength: 100 });
  near(smoothed.raster.values[index], (19 + 7 * 10) / 8); assert.equal(smoothed.raster.values[index - 1], null);
  assert.equal(model.raster.values[index], 19); assert.equal(model.raster.values[index - 1], null);
});
test('brushes also modify supplied TIN elevations without moving coordinates', () => {
  const model = { name: '测点', visible: true, points: [{ id: 'A', x: 0, y: 0, z: 10 }, { id: 'B', x: 10, y: 0, z: 10 }, { id: 'C', x: 0, y: 10, z: 10 }] };
  const edited = applyTerrainBrush(model, { x: 0, y: 0 }, { mode: 'lower', radius: 3, strength: 2 });
  assert.deepEqual(edited.points.map(({ id, x, y }) => ({ id, x, y })), model.points.map(({ id, x, y }) => ({ id, x, y })));
  assert.equal(edited.points[0].z, 8); assert.equal(edited.points[1].z, 10); assert.equal(model.points[0].z, 10);
});
test('river carve uses metre bed width, depth and horizontal bank ratio once at path crossings', () => {
  const model = grid(), path = [{ x: 0, y: 10 }, { x: 20, y: 10 }];
  const river = carveTerrainRiver(model, path, { width: 4, depth: 4, bankSlope: 1 });
  near(terrainElevation(river, 10, 10), 6); near(terrainElevation(river, 10, 12), 6); near(terrainElevation(river, 10, 14), 8); near(terrainElevation(river, 10, 16), 10);
  const crossed = carveTerrainRiver(model, [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 10, y: 0 }, { x: 10, y: 20 }], { width: 4, depth: 4, bankSlope: 1 });
  near(terrainElevation(crossed, 10, 10), 6); assert.equal(model.raster.values.every(z => z === 10), true);
});
test('absolute river bed follows the selected water surface datum and never raises lower existing land', () => {
  const model = grid(), path = [{ x: 0, y: 10 }, { x: 20, y: 10 }];
  model.raster.values[5 * model.raster.ncols + 5] = 2;
  const river = carveTerrainRiver(model, path, { width: 4, depth: 4, bankSlope: 1, bedElevation: 6 });
  near(terrainElevation(river, 8, 10), 6); near(terrainElevation(river, 10, 10), 2); near(terrainElevation(river, 8, 14), 8);
  assert.throws(() => carveTerrainRiver(model, path, { width: 4, depth: 4, bankSlope: 1, bedElevation: Infinity }));
});
test('river paths preserve NoData and reject malformed shape or out-of-range carving', () => {
  const model = grid(); model.raster.values[5 * model.raster.ncols + 5] = null;
  const path = [{ x: 0, y: 10 }, { x: 20, y: 10 }], carved = carveTerrainRiver(model, path, { width: 4, depth: 2, bankSlope: 0 });
  assert.equal(carved.raster.values[5 * model.raster.ncols + 5], null);
  for (const invalid of [[], [path[0]], [path[0], path[0]], [{ x: NaN, y: 0 }, path[1]]]) assert.throws(() => carveTerrainRiver(model, invalid, { width: 4, depth: 2, bankSlope: 1 }));
  for (const options of [{ width: 0, depth: 2, bankSlope: 1 }, { width: 4, depth: -1, bankSlope: 1 }, { width: 4, depth: 2, bankSlope: -1 }, { width: 4, depth: 100000, bankSlope: 1 }]) assert.throws(() => carveTerrainRiver(grid({ baseElevation: -10 }), path, options));
});
test('closest path distance handles ends and oblique segments exactly', () => {
  near(terrainPathDistance({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 3);
  near(terrainPathDistance({ x: -3, y: 4 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 5);
  near(terrainPathDistance({ x: 10, y: 0 }, [{ x: 0, y: 0 }, { x: 10, y: 10 }]), Math.sqrt(50));
});
