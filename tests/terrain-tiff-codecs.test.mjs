import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createGeoTIFF,setGeoTIFFTag} from './helpers/geotiff-fixture.mjs';
const root=process.env.TERRAIN_BUILD?pathToFileURL(resolve(process.env.TERRAIN_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {decodeTIFFLZW,undoTIFFFloatingPredictor}=await import(new URL('lib/terrain-tiff-codecs.js',root));
const {parseTerrainGeoTIFF}=await import(new URL('lib/terrain-geotiff.js',root));
const {terrainStats,terrainElevation,validateTerrain}=await import(new URL('lib/terrain.js',root));
const buffer=raw=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),parse=async opts=>parseTerrainGeoTIFF(buffer(createGeoTIFF(opts))),model=r=>({name:'真实压缩DEM',visible:true,points:[],raster:r.raster,rasterSource:r.source});
// Explicit MSB code transcripts isolate bit-width changes from any compressor.
const pack=items=>{const out=new Uint8Array(Math.ceil(items.reduce((n,[,width])=>n+width,0)/8));let bit=0;for(const[code,width]of items)for(let shift=width-1;shift>=0;shift--,bit++)if(code>>shift&1)out[bit>>3]|=1<<(7-(bit&7));return out;};
const fixed=codes=>pack(codes.map(c=>[c,9]));

test('TIFF LZW Clear/EOI and KwKwK codes restore literal bytes with bounded dictionary',()=>{
  assert.deepEqual([...decodeTIFFLZW(fixed([256,65,66,67,257]),3)],[65,66,67]);
  assert.deepEqual([...decodeTIFFLZW(fixed([256,65,258,259,257]),6)],[65,65,65,65,65,65]);
  assert.deepEqual([...decodeTIFFLZW(fixed([256,65,66,256,67,68,257]),4)],[65,66,67,68]);
});
test('TIFF early-change=1 increases widths before literal255/767/1791, reaching12 bits',()=>{
  const count=2300,transcript=[[256,9]];for(let i=0;i<count;i++)transcript.push([i%256,i<254?9:i<766?10:i<1790?11:12]);transcript.push([257,12]);
  const expected=Uint8Array.from({length:count},(_,i)=>i%256);assert.deepEqual(decodeTIFFLZW(pack(transcript),count),expected);
});
test('Clear after12-bit state resets dictionary and subsequent code width to9 bits',()=>{
  const count=2000,transcript=[[256,9]];for(let i=0;i<count;i++)transcript.push([i%256,i<254?9:i<766?10:i<1790?11:12]);transcript.push([256,12],[42,9],[43,9],[257,9]);
  const expected=Uint8Array.from([...Array.from({length:count},(_,i)=>i%256),42,43]);assert.deepEqual(decodeTIFFLZW(pack(transcript),count+2),expected);
});
test('invalid references, missingClear/EOI, short output and nonzero tail fail explicitly',()=>{
  for(const [bytes,size,pattern]of[[fixed([65,257]),1,/Clear/],[fixed([256,65]),1,/截断/],[fixed([256,65,300,257]),2,/字典/],[fixed([256,257]),1,/字节数/]])assert.throws(()=>decodeTIFFLZW(bytes,size),pattern);
  const tail=fixed([256,65,257]);tail[tail.length-1]|=1;assert.throws(()=>decodeTIFFLZW(tail,1),/EOI/);
});
test('LZW expands only to validated expected size and never accepts oversized destination',()=>{
  assert.throws(()=>decodeTIFFLZW(fixed([256,65,258,257]),1),/超过实际/);for(const size of[0,-1,2_000_001,NaN,Infinity,.5])assert.throws(()=>decodeTIFFLZW(fixed([256,257]),size),/尺寸/);
});
test('Predictor3 handwritten byte transcript restores1.0/2.0 floats in either file byte order',()=>{
  // MSB planes of 1.0/2.0: 3f40 8000 0000 0000; delta across full row.
  const encoded=Uint8Array.from([0x3f,1,0x40,0x80,0,0,0,0]);
  assert.deepEqual([...undoTIFFFloatingPredictor(encoded,2,1,32,false)],[0x3f,0x80,0,0,0x40,0,0,0]);
  assert.deepEqual([...undoTIFFFloatingPredictor(encoded,2,1,32,true)],[0,0,0x80,0x3f,0,0,0,0x40]);
  assert.deepEqual([...encoded],[0x3f,1,0x40,0x80,0,0,0,0]);
});
test('Predictor3 resets differences on each row and preserves exact float64 negative zero bits',()=>{
  const row=Uint8Array.from([0x80,0x80,0,0,0,0,0,0]);const encoded=new Uint8Array(16);encoded.set(row);encoded.set(row,8);
  const actual=undoTIFFFloatingPredictor(encoded,1,2,64,false);assert.deepEqual([...actual],[0x80,0,0,0,0,0,0,0,0x80,0,0,0,0,0,0,0]);assert.equal(Object.is(new DataView(actual.buffer).getFloat64(0,false),-0),true);
});
test('Predictor3 rejects wrong dimensions/types before any row allocation',()=>{
  for(const args of[[new Uint8Array(8),2,1,64,true],[new Uint8Array(8),0,1,32,true],[new Uint8Array(8),2,1,16,true],[new Uint8Array(8),2,1,32,undefined],[new Uint8Array(8),300000,1,64,true]])assert.throws(()=>undoTIFFFloatingPredictor(...args));
});
test('actual GDAL LZW and floating predictor files match all400 uncompressed reference samples',{skip:!existsSync('development_resources/gdal-master/gdal-master/autotest/gcore/data/gtiff/float64_LZW_predictor_3.tif')},async()=>{
  const base='development_resources/gdal-master/gdal-master/autotest/gcore/data/',reference=await parseTerrainGeoTIFF(buffer(await readFile(base+'byte.tif')),{confirmLocalMeters:true});
  for(const file of['byte_LZW.tif','byte_LZW_tiled.tif','float32_LZW_predictor_3.tif','float32_lzw_predictor_3_big_endian.tif','float64_LZW_predictor_3.tif']){const result=await parseTerrainGeoTIFF(buffer(await readFile(base+'gtiff/'+file)),{confirmLocalMeters:true});assert.deepEqual(result.raster.values,reference.raster.values,file);assert.equal(result.source.compression,5);assert.equal(result.raster.values.reduce((sum,v)=>sum+v,0),50706);validateTerrain(model(result));}
});
test('LZW/Deflate Predictor3 reads actual float32/64 values in endian strips and padded tiles',async()=>{
  const rows=[[-1.25,2.125,3.0625],[0,5.5,10.75],[.125,-.25,20.5]];
  for(const compression of[5,8,32946])for(const bits of[32,64])for(const littleEndian of[true,false])for(const storage of['strips','tiles']){const r=await parse({rows,compression,bits,littleEndian,storage,predictor:3,blockWidth:2,blockHeight:2});assert.deepEqual(r.raster.values,rows.flat());assert.equal(r.source.predictor,3);assert.equal(r.source.compression,compression);validateTerrain(JSON.parse(JSON.stringify(model(r))));}
});
test('LZW integer Predictor2 remains exact while valid float Predictor3 respects raw NoData thenScaleOffset',async()=>{
  const integer=await parse({rows:[[-32768,32767],[-1,2]],sampleFormat:2,bits:16,predictor:2,compression:5});assert.deepEqual(integer.raster.values,[-32768,32767,-1,2]);
  for(const compression of[5,8]){const r=await parse({rows:[[0,10,20],[30,NaN,50],[60,70,80]],compression,predictor:3,bits:64,noData:'nan',bandScale:.1,bandOffset:100,unit:'m'});assert.deepEqual(r.raster.values,[100,101,102,103,null,105,106,107,108]);assert.equal(terrainStats(model(r)).triangleCount,2);assert.equal(terrainElevation(model(r),15,15),null);}
});
test('LZW/Predictor3 preserves complete128² grid and bounded malformed blocks are rejected',async()=>{
  const rows=Array.from({length:128},(_,r)=>Array.from({length:128},(_,c)=>r+c/2)),result=await parse({rows,compression:5,predictor:3,bits:32,storage:'tiles',blockWidth:16,blockHeight:16,cellSize:1});assert.deepEqual(result.raster.values,rows.flat());assert.equal(terrainStats(model(result)).triangleCount,32258);
  let malformed=createGeoTIFF({rows:Array.from({length:16},()=>Array(16).fill(1)),compression:5,predictor:3});for(const[id,value]of[[256,2],[257,2],[278,2]])malformed=setGeoTIFFTag(malformed,id,value);await assert.rejects(()=>parseTerrainGeoTIFF(buffer(malformed)),/超过实际/);
});
