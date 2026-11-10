import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createGeoTIFF,setGeoTIFFTag} from './helpers/geotiff-fixture.mjs';
const root=process.env.TERRAIN_BUILD?pathToFileURL(resolve(process.env.TERRAIN_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {parseTerrainGeoTIFF,GeoTIFFUnitConfirmationRequired}=await import(new URL('lib/terrain-geotiff.js',root));
const {terrainElevation,terrainStats,validateTerrain,calculateTerrainEarthworks}=await import(new URL('lib/terrain.js',root));
const buffer=value=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength),parse=(options={},settings={})=>parseTerrainGeoTIFF(buffer(createGeoTIFF(options)),settings);
const model=({raster,source})=>({name:'真实GeoTIFF',visible:true,points:[],raster,rasterSource:source}),near=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);

test('independent local GDAL binary references decode identical authoritative sample values across types',{skip:!existsSync('development_resources/gdal-master/gdal-master/autotest/gcore/data/byte.tif')},async()=>{
  for(const file of ['byte.tif','int16.tif','float32.tif','gtiff/float32_little_endian_golden.tif']){const raw=await readFile('development_resources/gdal-master/gdal-master/autotest/gcore/data/'+file),result=await parseTerrainGeoTIFF(buffer(raw),{confirmLocalMeters:true});assert.equal(result.raster.ncols,20);assert.equal(result.raster.nrows,20);assert.deepEqual(result.raster.values.slice(0,12),[107,123,132,115,132,132,140,132,132,132,107,132]);assert.deepEqual(result.source.pixelScale,[60,60,0]);assert.equal(result.source.originEasting,440720);assert.equal(result.source.originNorthing,3751320);}
});

test('classic little/big-endian float DEM reads supplied values and real square metre georeferencing',async()=>{
  for(const littleEndian of[true,false]){const result=await parse({rows:[[1,2,3],[4,5,6],[7,8,9]],littleEndian,originX:100,originY:200});assert.deepEqual(result.raster.values,[1,2,3,4,5,6,7,8,9]);assert.equal(result.raster.format,'geotiff');assert.equal(result.raster.originX,0);assert.equal(result.raster.originY,0);assert.equal(result.source.originEasting,100);assert.equal(result.source.originNorthing,200);assert.equal(result.source.unitBasis,'metadata');near(terrainStats(model(result)).area,400);near(terrainElevation(model(result),15,15),5);const saved=JSON.parse(JSON.stringify(model(result)));validateTerrain(saved);assert.deepEqual(saved.rasterSource,result.source);}
});
test('source placement preserves metre origin and north-up direction; PixelIsPoint honours half-cell shift',async()=>{
  const r=await parse({rows:[[1,2],[3,4]],originX:100,originY:200},{placement:'source'});assert.equal(r.raster.originX,100);assert.equal(r.raster.originY,-200);near(terrainElevation(model(r),105,-195),1);
  const p=await parse({originX:100,originY:200,pixelIsPoint:true},{placement:'source'});assert.equal(p.source.originEasting,95);assert.equal(p.source.originNorthing,205);near(terrainElevation(model(p),100,-200),0);
});
test('large valid projected eastings can be placed locally before project bounds validation',async()=>{
  const local=await parse({originX:13500000,originY:3500000});assert.equal(local.raster.originX,0);assert.equal(local.source.originEasting,13500000);validateTerrain(model(local));await assert.rejects(()=>parse({originX:13500000,originY:3500000},{placement:'source'}),/项目左上角/);
});
test('unsigned and signed integer precision is read exactly without interpreting colour as height',async()=>{
  for(const [bits,sampleFormat,rows]of[[8,1,[[0,255],[12,64]]],[16,2,[[-123,32767],[-32768,3]]],[32,2,[[-10000,10000],[42,-42]]],[64,3,[[-1.25,2.125],[3.0625,4.5]]]])assert.deepEqual((await parse({bits,sampleFormat,rows})).raster.values,rows.flat());
});
test('Deflate strips and padded edge tiles decode every real sample for both endian orders',async()=>{
  const rows=[[1,2,3],[4,5,6],[7,8,9]];for(const compression of[8,32946])for(const storage of['strips','tiles'])for(const littleEndian of[true,false])assert.deepEqual((await parse({rows,storage,compression,littleEndian,blockHeight:2,blockWidth:2})).raster.values,rows.flat());
});
test('integer horizontal Predictor2 is reversed per row including signed wrap and Deflate tiles',async()=>{
  const rows=[[-32768,32767,-4],[5,-6,7],[8,9,10]];for(const littleEndian of[true,false])for(const storage of['strips','tiles'])assert.deepEqual((await parse({rows,bits:16,sampleFormat:2,predictor:2,compression:8,storage,littleEndian,blockHeight:2})).raster.values,rows.flat());
});
test('declared numeric/NaN NoData remains a true hole and absent metadata never guesses missing samples',async()=>{
  const r=await parse({rows:[[0,0,0],[0,-9999,0],[0,0,0]],noData:'-9999'});assert.equal(r.raster.values[4],null);assert.equal(terrainStats(model(r)).triangleCount,2);assert.equal(terrainElevation(model(r),15,15),null);near(terrainStats(model(r)).area,100);
  const nan=await parse({rows:[[1,2],[3,NaN]],noData:'nan'});assert.equal(nan.raster.values[3],null);assert.equal(nan.raster.noDataValue,null);assert.equal(nan.source.noData,'nan');
  assert.equal((await parse({rows:[[-9999,2],[3,4]]})).raster.values[0],-9999);await assert.rejects(()=>parse({rows:[[1,2],[3,NaN]]}),/未声明/);
});
test('GDAL band scale and offset transform actual heights after raw NoData removal',async()=>{
  const r=await parse({rows:[[0,10],[20,-9999]],bits:16,sampleFormat:2,noData:'-9999',bandScale:.1,bandOffset:100,unit:'m'});assert.deepEqual(r.raster.values,[100,101,102,null]);assert.equal(r.source.bandScale,.1);assert.equal(r.source.bandOffset,100);near(terrainElevation(model(r),5,5),100);
  await assert.rejects(()=>parse({unit:'ft'}),/高程单位不是米/);await assert.rejects(()=>parse({geoKeys:[[1024,1],[3076,9001],[4099,9002]]}),/高程/);
});
test('unknown local units require explicit real confirmation; declared geographic and feet never override',async()=>{
  await assert.rejects(()=>parse({geoKeys:[]}),GeoTIFFUnitConfirmationRequired);const local=await parse({geoKeys:[]},{confirmLocalMeters:true});assert.equal(local.source.unitBasis,'confirmed-local');
  for(const geoKeys of[[[1024,2],[2048,4326]],[[2048,4326]],[[1024,1],[3076,9002]],[[1024,1],[3072,4326],[3076,9001]]])await assert.rejects(()=>parse({geoKeys},{confirmLocalMeters:true}),/经纬度|地理经纬度|英尺/);
});
test('UTM authority code infers known metre units without guessing arbitrary coordinate systems',async()=>{
  assert.equal((await parse({geoKeys:[[1024,1],[3072,32650]]})).source.unitBasis,'metadata');await assert.rejects(()=>parse({geoKeys:[[1024,1],[3072,2227]]}),GeoTIFFUnitConfirmationRequired);
});
test('rotation, non-square grid, contradictory tiepoints and unsupported formats are rejected clearly',async()=>{
  await assert.rejects(()=>parse({cellSizeY:20}),/尺寸相同/);await assert.rejects(()=>parse({extraTags:[[34264,12,Array(16).fill(0)]]}),/旋转/);await assert.rejects(()=>parse({tiepoints:[0,0,0,0,0,0,1,1,0,20,-10,0]}),/矛盾/);
  for(const [id,value,pattern]of[[277,3,/单波段/],[259,7,/压缩/],[317,3,/预测/],[274,3,/方向/]])await assert.rejects(()=>parseTerrainGeoTIFF(buffer(setGeoTIFFTag(createGeoTIFF(),id,value))),pattern);
  const big=createGeoTIFF();big.writeUInt16LE(43,2);await assert.rejects(()=>parseTerrainGeoTIFF(buffer(big)),/BigTIFF/);
});
test('truncated pointers, compressed bombs/corruption, malformed NoData and all missing raster never apply',async()=>{
  const t=createGeoTIFF({compression:8});await assert.rejects(()=>parseTerrainGeoTIFF(buffer(t.subarray(0,t.length-3))),/截断|越界/);const corrupted=Buffer.from(t);corrupted[corrupted.length-2]^=255;await assert.rejects(()=>parseTerrainGeoTIFF(buffer(corrupted)),/解压|损坏/);
  await assert.rejects(()=>parse({noData:'invalid'}),/NoData/);await assert.rejects(()=>parse({rows:[[-9999,-9999],[-9999,-9999]],noData:'-9999'}),/全部/);
  let oversized=createGeoTIFF({rows:Array.from({length:16},()=>Array(16).fill(5)),compression:8});for(const[id,value]of[[256,2],[257,2],[278,2]])oversized=setGeoTIFFTag(oversized,id,value);await assert.rejects(()=>parseTerrainGeoTIFF(buffer(oversized)),/超过实际分块/);
});
test('full128 square source preserves all16384 samples, real interpolation and no downsampling',async()=>{
  const rows=Array.from({length:128},(_,r)=>Array.from({length:128},(_,c)=>r+c));const r=await parse({rows,compression:8,storage:'tiles',blockWidth:16,blockHeight:16,cellSize:1});assert.equal(r.raster.values.length,16384);assert.equal(terrainStats(model(r)).triangleCount,32258);near(terrainElevation(model(r),127.5,127.5),254);await assert.rejects(()=>parse({rows:Array.from({length:129},()=>Array(128).fill(0))}),/16384/);
});
test('pure geometric cut/fill uses decoded and scaled heights rather than metadata guesses',async()=>{
  const r=await parse({rows:[[0,0],[0,0]],cellSize:10,bandOffset:100});const design=[[{x:5,y:5,z:102},{x:15,y:5,z:102},{x:15,y:15,z:102}],[{x:5,y:5,z:102},{x:15,y:15,z:102},{x:5,y:15,z:102}]];const volumes=calculateTerrainEarthworks(model(r),design);near(volumes.fillVolume,200);near(volumes.cutVolume,0);near(volumes.coveredArea,100);
});
test('saved original GeoTIFF metadata is validated independently of editable project origin',async()=>{
  const r=model(await parse());r.raster.originX=123;r.raster.cellSize=2;const saved=JSON.parse(JSON.stringify(r));validateTerrain(saved);assert.equal(saved.rasterSource.pixelScale[0],10);
  for(const change of[s=>s.originEasting=NaN,s=>s.linearUnit=9002,s=>s.width=99,s=>s.pixelScale[1]=20,s=>s.bitsPerSample=16]){const bad=structuredClone(r);change(bad.rasterSource);assert.throws(()=>validateTerrain(bad));}
});
