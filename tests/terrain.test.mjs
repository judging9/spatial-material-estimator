import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base=process.env.TERRAIN_BUILD?pathToFileURL(resolve(process.env.TERRAIN_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {parseTerrainCSV,validateTerrain,compileTerrain,triangulateTerrain,terrainElevation,terrainStats,calculateTerrainEarthworks}=await import(new URL('lib/terrain.js',base));
const near=(a,b,eps=1e-8)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const model=(coordinates)=>({name:'实际测量地形',visible:true,points:coordinates.map(([x,y,z],index)=>({id:'P'+index,x,y,z}))});
const flat=(z=0)=>model([[0,0,z],[10,0,z],[10,4,z],[0,4,z]]);
const rectangle=(x,y,w,h,z)=>[[{x,y,z},{x:x+w,y,z},{x:x+w,y:y+h,z}],[{x,y,z},{x:x+w,y:y+h,z},{x,y:y+h,z}]];

test('CSV imports actual metre XYZ values with UTF-8 BOM, point IDs and header units',()=>{
  const points=parseTerrainCSV('\uFEFF点号,X(m),Y(m),高程(m)\nA,0,0,3.2\nB,10,0,4\nC,0,4,3.6');
  assert.deepEqual(points,[{id:'A',x:0,y:0,z:3.2},{id:'B',x:10,y:0,z:4},{id:'C',x:0,y:4,z:3.6}]);
});
test('CSV preserves explicitly negative heights, exponent numbers and unnamed XYZ rows',()=>{
  const points=parseTerrainCSV('0 0 -1.25\n1e1 0 -2\n0 4 0');
  assert.equal(points[1].x,10);assert.equal(points[0].z,-1.25);assert.ok(points.every(point=>point.id));
});
test('CSV supports semicolon delimiters and escaped quoted survey identifiers',()=>{
  const points=parseTerrainCSV('id;x;y;z\n"A""点";0;0;0\nB;10;0;0\nC;0;4;0');assert.equal(points[0].id,'A"点');
});
test('CSV refuses implied centimetres, empty/trailing bad numbers and mismatched rows',()=>{
  for(const text of['x(cm),y(cm),z(cm)\n0,0,0\n10,0,0\n0,4,0','x,y,z\n0,0,0\n10,0,\n0,4,0','0,0,0\n10foo,0,0\n0,4,0','x,y,z\n0,0,0\n10,0\n0,4,0'])assert.throws(()=>parseTerrainCSV(text));
});
test('CSV refuses incomplete or collinear sets instead of fabricating terrain',()=>{
  for(const text of['x,y,z\n0,0,0\n10,0,1','0,0,0\n10,0,1\n20,0,2'])assert.throws(()=>parseTerrainCSV(text));
});
test('unfinished manual point collections may save but have no TIN or fake elevation',()=>{
  for(const coordinates of[[],[[0,0,2]],[[0,0,2],[10,0,3]]]){const terrain=model(coordinates);assert.doesNotThrow(()=>validateTerrain(terrain));assert.deepEqual(triangulateTerrain(terrain),[]);assert.equal(terrainElevation(terrain,1,1),null);assert.equal(terrainStats(terrain).status,'incomplete');}
});
test('duplicate XY, differing elevations and duplicate IDs are explicitly rejected',()=>{
  assert.throws(()=>validateTerrain(model([[0,0,1],[0,0,2],[1,1,3]])),/不同高程/);
  assert.throws(()=>validateTerrain(model([[0,0,1],[0,0,1],[1,1,3]])),/重复/);
  const terrain=flat();terrain.points[1].id=terrain.points[0].id;assert.throws(()=>validateTerrain(terrain),/编号/);
});
test('NaN, infinities and unsafe coordinate ranges cannot enter saved terrain',()=>{
  for(const value of[NaN,Infinity,1e8]){const terrain=flat();terrain.points[0].x=value;assert.throws(()=>validateTerrain(terrain));}
});
test('cocircular rectangle forms two nonoverlapping triangles and exact hull area',()=>{
  const terrain=flat(2),triangles=triangulateTerrain(terrain);assert.equal(triangles.length,2);near(terrainStats(terrain).area,40);near(terrainElevation(terrain,5,2),2);near(terrainElevation(terrain,0,0),2);assert.equal(terrainElevation(terrain,-.01,2),null);
});
test('TIN is deterministic under point order reversal and does not mutate survey coordinates',()=>{
  const terrain=model([[0,0,0],[10,0,1],[10,4,2],[0,4,3],[3,2,4]]),before=structuredClone(terrain),signature=value=>JSON.stringify(triangulateTerrain(value).map(tri=>tri.map(({x,y,z})=>[x,y,z])));
  assert.equal(signature(terrain),signature({...terrain,points:[...terrain.points].reverse()}));assert.deepEqual(terrain,before);
});
test('TIN captures a supplied interior hill rather than reducing terrain to a bounding plane',()=>{
  const terrain=model([[0,0,0],[10,0,0],[10,4,0],[0,4,0],[5,2,3]]);assert.equal(triangulateTerrain(terrain).length,4);near(terrainElevation(terrain,5,2),3);near(terrainElevation(terrain,2.5,1),1.5);near(terrainStats(terrain).area,40);
});
test('regular 5×5 measured grid keeps every elevation vertex and correct convex hull',()=>{
  const coordinates=[];for(let x=0;x<5;x++)for(let y=0;y<5;y++)coordinates.push([x*2,y*2,.2*x-.3*y]);const terrain=model(coordinates);near(terrainStats(terrain).area,64);assert.equal(triangulateTerrain(terrain).length,32);for(const point of terrain.points)near(terrainElevation(terrain,point.x,point.y),point.z);
});
test('barycentric interpolation respects an affine slope and translated survey eastings',()=>{
  const terrain=model([[500000,3000000,3],[500010,3000000,23],[500010,3000004,19],[500000,3000004,-1]]);near(terrainElevation(terrain,500003,3000002),7);assert.equal(terrainElevation(terrain,500011,3000002),null);
});
test('cached TIN is reused until actual elevations or point coordinates change',()=>{
  const terrain=flat(),mesh=compileTerrain(terrain);assert.equal(compileTerrain(terrain),mesh);terrain.points[0].z=2;assert.notEqual(compileTerrain(terrain),mesh);near(terrainElevation(terrain,0,0),2);
});
test('a measured flat 10×4m site at 0m and design at 2m needs exactly 80m³ fill',()=>{
  const result=calculateTerrainEarthworks(flat(),rectangle(0,0,10,4,2));near(result.designArea,40);near(result.coveredArea,40);near(result.uncoveredArea,0);near(result.fillVolume,80);near(result.cutVolume,0);assert.equal(result.status,'complete');
});
test('negative design-ground differences produce excavation, not negative fill',()=>{
  const result=calculateTerrainEarthworks(flat(3),rectangle(0,0,10,4,1));near(result.cutVolume,80);near(result.fillVolume,0);
});
test('zero contour splitting keeps 50m³ cut and 50m³ fill instead of cancelling them',()=>{
  const terrain=model([[0,0,0],[10,0,10],[10,4,10],[0,4,0]]),result=calculateTerrainEarthworks(terrain,rectangle(0,0,10,4,5));near(result.cutVolume,50);near(result.fillVolume,50);near(result.coveredArea,40);
});
test('affine design plane versus measured ground integrates real plane difference exactly',()=>{
  const terrain=flat(),design=[[{x:0,y:0,z:1},{x:10,y:0,z:3},{x:0,y:4,z:1}]];const result=calculateTerrainEarthworks(terrain,design);near(result.designArea,20);near(result.fillVolume,100/3);near(result.cutVolume,0);
});
test('outside terrain coverage is explicit and is never assigned an invented grade',()=>{
  const result=calculateTerrainEarthworks(flat(),rectangle(5,0,10,4,2));near(result.designArea,40);near(result.coveredArea,20);near(result.uncoveredArea,20);near(result.fillVolume,40);assert.equal(result.status,'partial');
  const absent=calculateTerrainEarthworks(undefined,rectangle(0,0,10,4,2));assert.equal(absent.status,'uncovered');near(absent.uncoveredArea,40);near(absent.fillVolume,0);
});
test('CW and reversed design triangles preserve area and measured cut/fill',()=>{
  const design=rectangle(0,0,10,4,2),result=calculateTerrainEarthworks(flat(),design.map(triangle=>[...triangle].reverse()));near(result.fillVolume,80);near(result.coveredArea,40);
});
test('shared triangle borders have zero overlap while duplicate design coverage is rejected',()=>{
  assert.doesNotThrow(()=>calculateTerrainEarthworks(flat(),rectangle(0,0,10,4,2)));
  const [triangle]=rectangle(0,0,10,4,2);assert.throws(()=>calculateTerrainEarthworks(flat(),[triangle,triangle]),/重复覆盖/);
});
test('degenerate design faces, invalid elevations and excessive survey size are refused',()=>{
  assert.throws(()=>calculateTerrainEarthworks(flat(),[[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:2,y:0,z:0}]]));assert.throws(()=>calculateTerrainEarthworks(flat(),[[{x:0,y:0,z:NaN},{x:1,y:0,z:0},{x:0,y:1,z:0}]]));
  const terrain=model(Array.from({length:1001},(_,i)=>[i,i%3,0]));assert.throws(()=>validateTerrain(terrain),/1000/);
});
