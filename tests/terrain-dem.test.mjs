import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base=process.env.TERRAIN_BUILD?pathToFileURL(resolve(process.env.TERRAIN_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {parseTerrainASCIIGrid,validateTerrain,compileTerrain,terrainElevation,terrainStats,calculateTerrainEarthworks,MAX_TERRAIN_RASTER_CELLS}=await import(new URL('lib/terrain.js',base));
const near=(a,b,eps=1e-8)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const asc=(rows,header='xllcorner 0\nyllcorner -30\ncellsize 10',noData='NODATA_value -9999')=>`ncols ${rows[0].length}\nnrows ${rows.length}\n${header}\n${noData}\n${rows.map(row=>row.join(' ')).join('\n')}`;
const terrain=(rows,header,noData)=>({name:'实测栅格',visible:true,points:[],raster:parseTerrainASCIIGrid(asc(rows,header,noData))});
const rectangle=(x,y,w,h,z)=>[[{x,y,z},{x:x+w,y,z},{x:x+w,y:y+h,z}],[{x,y,z},{x:x+w,y:y+h,z},{x,y:y+h,z}]];

test('ASC corner headers preserve original north-up rows and map Y to project downwards',()=>{
  const t=terrain([[1,2,3],[4,5,6],[7,8,9]]),r=t.raster;
  assert.equal(r.originX,0);assert.equal(r.originY,0);assert.equal(r.xllcorner,0);assert.equal(r.yllcorner,-30);assert.equal(r.coordinateUnit,'m');assert.equal(r.yDirection,'north-up');assert.deepEqual(r.values,[1,2,3,4,5,6,7,8,9]);
  near(terrainElevation(t,5,5),1);near(terrainElevation(t,25,25),9);near(terrainElevation(t,15,15),5);
  assert.equal(compileTerrain(t).triangles.length,8);near(terrainStats(t).area,400);near(terrainStats(t).fullRasterArea,900);
});
test('ASC center headers correctly become outer lower-left corners and case/BOM/whitespace work',()=>{
  const raster=parseTerrainASCIIGrid('\uFEFFNCOLS 2\nNROWS 2\nXLLCENTER 15\nYLLCENTER -15\nCELLSIZE 10\n 1\t2 \n 3 4 \n');
  assert.equal(raster.xllcorner,10);assert.equal(raster.yllcorner,-20);assert.equal(raster.originY,0);assert.equal(raster.noDataValue,null);
  near(terrainElevation({name:'center',visible:true,points:[],raster},15,5),1);
});
test('declared NoData becomes null; absent NODATA never guesses a -9999 sentinel',()=>{
  const t=terrain([[-9999,2],[3,4]],'xllcorner 0\nyllcorner -20\ncellsize 10');assert.equal(t.raster.values[0],null);assert.equal(compileTerrain(t).triangles.length,1);
  const without=terrain([[-9999,-1],[0,1]],'xllcorner 0\nyllcorner -20\ncellsize 10','');assert.equal(without.raster.values[0],-9999);assert.equal(compileTerrain(without).triangles.length,2);near(terrainElevation(without,5,5),-9999);
});
test('fixed triangles interpolate the supplied affine plane exactly including shifted survey coordinates',()=>{
  const t=terrain([[3,23,43],[-7,13,33],[-17,3,23]],'xllcorner 500000\nyllcorner -3000030\ncellsize 10');
  near(terrainElevation(t,500008,3000009),5);near(terrainElevation(t,500020,3000020),18);
  assert.equal(terrainElevation(t,500000,3000000),null);
});
test('NoData removes incident triangles without bridging holes or extrapolating outer half cells',()=>{
  const t=terrain([[0,0,0],[0,-9999,0],[0,0,0]]);assert.equal(compileTerrain(t).triangles.length,2);near(terrainStats(t).area,100);
  assert.equal(terrainElevation(t,15,15),null);assert.equal(terrainElevation(t,14,14),null);near(terrainElevation(t,7,7),0);near(terrainElevation(t,23,23),0);
  for(const [x,y]of[[0,10],[4.9,10],[26,10],[10,4.9],[10,26]])assert.equal(terrainElevation(t,x,y),null);
  near(terrainElevation(t,15,5),0);near(terrainElevation(t,5,15),0);near(terrainElevation(t,25,15),0);
});
test('isolated valid DEM values are retained but never form a fabricated surface',()=>{
  const t=terrain([[1,-9999],[-9999,2]],'xllcorner 0\nyllcorner -20\ncellsize 10');assert.equal(terrainStats(t).status,'incomplete');assert.equal(compileTerrain(t).triangles.length,0);assert.equal(terrainElevation(t,5,5),null);assert.equal(terrainStats(t).pointCount,2);
});
test('invalid dimensions, conflicting headers, row counts and nonnumeric values are explicitly rejected',()=>{
  const valid=asc([[0,0],[0,0]],'xllcorner 0\nyllcorner -20\ncellsize 10');
  for(const text of[valid.replace('ncols 2','ncols 2.5'),valid.replace('nrows 2','nrows 1'),valid.replace('cellsize 10','cellsize 0'),valid.replace('xllcorner 0','xllcorner 0\nxllcenter 5'),valid.replace('ncols 2','ncols 2\nncols 2'),valid.replace('yllcorner -20',''),valid.replace('0 0\n0 0','0 0 0\n0 0'),valid+'\n0 0',valid.replace('0 0\n0 0','NaN 0\n0 0'),valid.replace('0 0\n0 0','Infinity 0\n0 0'),valid.replace('0 0\n0 0','100001 0\n0 0'),valid.replace('cellsize 10','cellsize 10\nprojection geographic')])assert.throws(()=>parseTerrainASCIIGrid(text));
});
test('all NoData and malformed persisted raster arrays cannot replace a usable terrain',()=>{
  assert.throws(()=>terrain([[-9999,-9999],[-9999,-9999]],'xllcorner 0\nyllcorner -20\ncellsize 10'),/全部/);
  const t=terrain([[0,0],[0,0]],'xllcorner 0\nyllcorner -20\ncellsize 10');
  for(const change of[r=>r.values.pop(),r=>r.values[0]=NaN,r=>r.values[0]=undefined,r=>r.coordinateUnit='deg',r=>r.originX=1e8,r=>r.noDataValue=Infinity]){const bad=structuredClone(t);change(bad.raster);assert.throws(()=>validateTerrain(bad));}
});
test('full 128×128 DEM retains all 16384 cells and is independent of the 1000 TIN point cap',()=>{
  const rows=Array.from({length:128},(_,r)=>Array.from({length:128},(_,c)=>r+c));const t=terrain(rows,'xllcorner 0\nyllcorner -128\ncellsize 1');
  assert.equal(MAX_TERRAIN_RASTER_CELLS,16384);assert.equal(t.raster.values.length,16384);assert.equal(compileTerrain(t).triangles.length,32258);near(terrainStats(t).area,16129);near(terrainElevation(t,127.5,127.5),254);
  assert.throws(()=>parseTerrainASCIIGrid(asc(Array.from({length:129},()=>Array(128).fill(0)),'xllcorner 0\nyllcorner -129\ncellsize 1')),/16384/);
});
test('DEM queries use constant-size candidate cells instead of scanning values or compiling TIN',()=>{
  const t=terrain(Array.from({length:128},()=>Array(128).fill(7)),'xllcorner 0\nyllcorner -128\ncellsize 1');let reads=0;
  t.raster.values=new Proxy(t.raster.values,{get:(array,key)=>{if(/^\d+$/.test(String(key)))reads++;return Reflect.get(array,key);}});
  near(terrainElevation(t,75.25,62.4),7);assert.ok(reads<=16,`O(1) query should not read ${reads} raster values`);
});
test('DEM raster values, location and resolution all invalidate compiled mesh and queries immediately',()=>{
  const t=terrain([[0,0],[0,0]],'xllcorner 0\nyllcorner -20\ncellsize 10'),before=compileTerrain(t);t.raster.values[0]=8;assert.notEqual(compileTerrain(t),before);near(terrainElevation(t,5,5),8);
  const edited=compileTerrain(t);t.raster.originX=100;t.raster.originY=20;t.raster.cellSize=2;assert.notEqual(compileTerrain(t),edited);assert.equal(terrainElevation(t,5,5),null);near(terrainElevation(t,101,21),8);near(terrainStats(t).area,4);
});
test('DEM cut/fill uses real triangle intersection and separates positive/negative differences',()=>{
  const t=terrain([[0,10,20],[0,10,20],[0,10,20]]),result=calculateTerrainEarthworks(t,rectangle(5,5,20,20,10));
  near(result.cutVolume,1000);near(result.fillVolume,1000);near(result.coveredArea,400);assert.equal(result.status,'complete');
});
test('NoData and raster outer edges leave explicit uncovered earthworks instead of fake volumes',()=>{
  const t=terrain([[0,0,0],[0,-9999,0],[0,0,0]]),result=calculateTerrainEarthworks(t,rectangle(0,0,30,30,2));
  near(result.designArea,900);near(result.coveredArea,100);near(result.uncoveredArea,800);near(result.fillVolume,200);near(result.cutVolume,0);assert.equal(result.status,'partial');
});
test('DEM grid candidate indexing agrees with clipping every actual mesh triangle for narrow partial designs',()=>{
  const t=terrain(Array.from({length:8},(_,r)=>Array.from({length:8},(_,c)=>c-r)),'xllcorner 0\nyllcorner -8\ncellsize 1');
  for(const [x,y,w,h]of[[1.5,2.5,1.1,.2],[-1,1,3,2],[7.4,7.3,1,1],[4.9,3.1,2.3,.4]]){
    const design=rectangle(x,y,w,h,4),actual=calculateTerrainEarthworks(t,design);let cut=0,fill=0,area=0;
    for(const triangle of compileTerrain(t).triangles){const tin={name:'triangle',visible:true,points:triangle.map((p,i)=>({...p,id:String(i)}))},part=calculateTerrainEarthworks(tin,design);cut+=part.cutVolume;fill+=part.fillVolume;area+=part.coveredArea;}
    near(actual.cutVolume,cut);near(actual.fillVolume,fill);near(actual.coveredArea,area);
  }
});
