import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const modules = process.env.TERRAIN_BUILD ? pathToFileURL(resolve(process.env.TERRAIN_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const [{ createTerrainGrid, sculptTerrainFeature, terrainSectionProfile }, { terrainElevation, terrainStats, calculateTerrainEarthworks, validateTerrain }, { buildTerrainScene }] = await Promise.all([
  'lib/terrain-authoring.js', 'lib/terrain.js', 'lib/terrain-scene.js',
].map(file => import(new URL(file, modules))));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const flat = (patch = {}) => createTerrainGrid({ width: 100, length: 60, cellSize: 2, baseElevation: 50, relief: 500, preset: 'flat', ...patch });
const heights = model => model.raster?.values ?? model.points.map(point => point.z);

for (const [preset, relief, centre] of [['mountain',500,550],['ridge',300,350],['canyon',180,-130]]) test(`${preset} generates chosen hundred-metre elevations without random data or changing the footprint`, () => {
  const input = { preset, relief }, model = flat(input), before = structuredClone(input);
  assert.deepEqual(model, flat(input)); assert.deepEqual(input, before); validateTerrain(model);
  near(terrainElevation(model, 50, 30), centre); near(terrainStats(model).area, 6000);
  assert.match(model.sourceName, /自建概念地形.*非实测/);
  assert.ok(heights(model).every(value => value >= Math.min(50,centre) && value <= Math.max(50,centre)));
});

test('high mountain values keep metre origins and negative baselines, and rotate ridge axes without changing scale', () => {
  const model = flat({ preset: 'mountain', originX: 1000, originY: 2000, baseElevation: -150, relief: 800 });
  near(terrainElevation(model, 1050, 2030), 650); near(terrainStats(model).area, 6000);
  const horizontal = flat({ preset: 'ridge', rotation: 0 }), vertical = flat({ preset: 'ridge', rotation: 90 });
  assert.ok(terrainElevation(horizontal, 70, 30) > terrainElevation(vertical, 70, 30));
  assert.ok(terrainElevation(vertical, 50, 44) > terrainElevation(horizontal, 50, 44));
  near(terrainElevation(horizontal, 50, 30), 550); near(terrainElevation(vertical, 50, 30), 550);
});

test('extreme elevation sums, invalid rotations and excessive density are rejected before returning a model', () => {
  for (const patch of [{ preset: 'mountain', baseElevation: 99999, relief: 2 }, { preset: 'canyon', baseElevation: -99999, relief: 2 }, { rotation: Infinity }, { relief: 100001 }, { cellSize: .001 }, { preset: '__proto__' }]) assert.throws(() => flat(patch));
});

test('a single peak uses exact centre height, compact falloff and true metre radius without mutating input', () => {
  const before = flat(), original = structuredClone(before), after = sculptTerrainFeature(before, [{ x: 50, y: 30 }], { mode: 'peak', radius: 8, relief: 500 });
  near(terrainElevation(after, 50, 30), 550); near(terrainElevation(after, 54, 30), 50 + 500 * .5 ** 1.5); near(terrainElevation(after, 58, 30), 50);
  assert.deepEqual(before, original); assert.match(after.sourceName, /人工塑形/); near(terrainStats(after).area, 6000);
});

test('a hollow lowers the supplied surface by the chosen depth and leaves its radius boundary untouched', () => {
  const before = flat(), after = sculptTerrainFeature(before, [{ x: 50, y: 30 }], { mode: 'hollow', radius: 8, relief: 300 });
  near(terrainElevation(after, 50, 30), -250); near(terrainElevation(after, 54, 30), -25); near(terrainElevation(after, 58, 30), 50);
  assert.equal(terrainElevation(before, 50, 30), 50);
});

test('a diagonal ridge uses distance to its real path and every sample is changed only once', () => {
  const before = flat(), path = [{ x: 20, y: 10 }, { x: 80, y: 50 }];
  const ridge = sculptTerrainFeature(before, path, { mode: 'ridge', radius: 6, relief: 300 });
  near(terrainElevation(ridge, 50, 30), 350);
  const crossed = sculptTerrainFeature(before, [{ x: 20, y: 30 }, { x: 80, y: 30 }, { x: 50, y: 10 }, { x: 50, y: 50 }], { mode: 'ridge', radius: 6, relief: 300 });
  near(terrainElevation(crossed, 50, 30), 350); assert.ok(heights(crossed).every(value => value <= 350));
  const reverse = sculptTerrainFeature(before, [...path].reverse(), { mode: 'ridge', radius: 6, relief: 300 });
  heights(ridge).forEach((value,index) => near(value,heights(reverse)[index]));
});

test('canyon depth is applied once along a winding or crossing path and its sides remain within the chosen radius', () => {
  const before = flat(), path = [{ x: 10, y: 30 }, { x: 90, y: 30 }];
  const valley = sculptTerrainFeature(before, path, { mode: 'canyon', radius: 8, relief: 160 });
  near(terrainElevation(valley, 50, 30), -110); near(terrainElevation(valley, 50, 34), 50 - 160 * Math.sqrt(.5)); near(terrainElevation(valley, 50, 38), 50);
  const longer = sculptTerrainFeature(before, [path[0], path[1], { x: 50, y: 10 }, { x: 50, y: 50 }], { mode: 'canyon', radius: 8, relief: 160 });
  near(terrainElevation(longer, 50, 30), -110); assert.ok(heights(longer).every(value => value >= -110));
});

test('local features preserve imported TIN coordinates, point identities and the original source name', () => {
  const before = { name: '测量地形', sourceName: '现场测量 2026', visible: true, points: [{ id: 'A', x: 1000, y: 2000, z: 50 }, { id: 'B', x: 1100, y: 2000, z: 50 }, { id: 'C', x: 1000, y: 2100, z: 50 }] };
  const after = sculptTerrainFeature(before, [{ x: 1000, y: 2000 }], { mode: 'peak', radius: 10, relief: 500 });
  assert.deepEqual(after.points.map(({id,x,y}) => ({id,x,y})), before.points.map(({id,x,y}) => ({id,x,y})));
  near(after.points[0].z, 550); near(after.points[1].z, 50); assert.match(after.sourceName, /现场测量 2026.*人工塑形/);
});

test('NoData stays absent through positive and negative feature stamps, including a stamp centred on a gap', () => {
  const before = flat(), index = 15 * before.raster.ncols + 25; before.raster.values[index] = null;
  const peak = sculptTerrainFeature(before, [{ x: 50, y: 30 }], { mode: 'peak', radius: 8, relief: 500 });
  const valley = sculptTerrainFeature(peak, [{ x: 20, y: 30 }, { x: 80, y: 30 }], { mode: 'canyon', radius: 8, relief: 200 });
  assert.equal(peak.raster.values[index], null); assert.equal(valley.raster.values[index], null);
  assert.equal(terrainElevation(valley, 50, 30), null);
});

test('invalid feature paths, invalid dimensions, empty coverage and extreme results do not mutate supplied terrain', () => {
  const before = flat(), copy = structuredClone(before), base = { mode: 'peak', radius: 8, relief: 500 };
  for (const path of [[], [{x:NaN,y:0}], [{x:1,y:1},{x:2,y:2}], [{x:1000,y:1000}]]) assert.throws(() => sculptTerrainFeature(before,path,base));
  for (const options of [{...base,mode:'unknown'},{...base,radius:0},{...base,relief:-1},{...base,relief:100000}]) assert.throws(() => sculptTerrainFeature(before,[{x:50,y:30}],options));
  for (const path of [[{x:1,y:1}], [{x:1,y:1},{x:1,y:1}]]) assert.throws(() => sculptTerrainFeature(before,path,{...base,mode:'ridge'}));
  assert.deepEqual(before,copy);
});

test('moving a terrain and feature together preserves all actual elevations', () => {
  const before = flat(), offset = flat({ originX: 1234, originY: 5678 });
  const a = sculptTerrainFeature(before,[{x:50,y:30}],{mode:'peak',radius:8,relief:500});
  const b = sculptTerrainFeature(offset,[{x:1284,y:5708}],{mode:'peak',radius:8,relief:500});
  assert.deepEqual(heights(a),heights(b));
});

test('profiles use true metre distances and interpolated elevations from an affine supplied TIN', () => {
  const model = { name:'坡地',visible:true,points:[{id:'A',x:0,y:0,z:100},{id:'B',x:20,y:0,z:140},{id:'C',x:0,y:20,z:160}] };
  const samples = terrainSectionProfile(model,{x:0,y:0},{x:10,y:10},9);
  samples.forEach((sample,index) => { near(sample.distance,Math.sqrt(200)*index/8); near(sample.elevation,100+2*sample.x+3*sample.y); });
  near(samples.at(-1).elevation,150); assert.equal(samples.length,9);
});

test('profiles break at missing raster data and outside the true interpolation hull', () => {
  const model = flat(), middle = 15 * model.raster.ncols + 25; model.raster.values[middle] = null;
  const section = terrainSectionProfile(model,{x:40,y:30},{x:60,y:30},11);
  assert.equal(section[5].elevation,null); assert.ok(section.some(sample => sample.elevation === 50));
  const outside = terrainSectionProfile(model,{x:-10,y:0},{x:10,y:0},5); assert.equal(outside[0].elevation,null); near(outside.at(-1).elevation,50);
  for (const count of [1,2.5,258]) assert.throws(() => terrainSectionProfile(model,{x:0,y:0},{x:10,y:10},count));
  assert.throws(() => terrainSectionProfile(model,{x:0,y:0},{x:0,y:0}));
});

test('hundred-metre features enter real three-dimensional vertices and terrain cut volume without exaggeration', () => {
  const original = { name:'方案基底',visible:true,points:[{id:'A',x:0,y:0,z:0},{id:'B',x:20,y:0,z:0},{id:'C',x:0,y:20,z:0}] };
  const model = sculptTerrainFeature(original,[{x:0,y:0}],{mode:'peak',radius:1,relief:300});
  const triangles = [[{x:0,y:0,z:0},{x:20,y:0,z:0},{x:0,y:20,z:0}]];
  const earth = calculateTerrainEarthworks(model,triangles); near(earth.cutVolume,20000); near(earth.fillVolume,0); near(earth.coveredArea,200);
  const scene = buildTerrainScene({workspaceMode:'municipal',municipalTerrain:model}); assert.equal(scene.length,1);
  assert.ok(scene[0].points.some(point => point.x === 0 && point.y === 300 && point.z === 0));
  assert.ok(scene.every(surface => surface.normal.y > 0 && /^#[0-9a-f]{6}$/.test(surface.color)));
  near(terrainStats(model).maxElevation,300); assert.equal(buildTerrainScene({workspaceMode:'municipal',municipalTerrain:{...model,visible:false}}).length,0);
});
