import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';
import { projectToCSV, renderExportHTML } from '../static/studio/lib/export.js';
import { calculateProject } from '../static/studio/lib/pricing.js';

const material = { id:'paint',name:'墙面涂料',category:'墙面',unit:'m²',unitPrice:'10',wasteRate:'5',image:'',color:'#ccd4c9',description:'实际录入材料',provenance:{source:'地方公开报价',region:'浙江',priceDate:'2026-10-31',sourceUrl:'https://example.org/prices'} };
const project = () => ({version:1,id:'wall-openings',name:'墙面报价工程',drawing:null,calibration:{metersPerPixel:.01},regions:[],walls:[{id:'wall',name:'南墙',start:{x:0,y:0},end:{x:400,y:0},thickness:20,height:280,finishSide:'left',items:[{id:'paint-item',materialId:'paint',materialName:'墙面涂料',unit:'m²',unitPrice:'10',wasteRate:'5',laborRate:'2',additionalCost:'3',quantityMode:'area',quantity:'0',provenance:structuredClone(material.provenance)}]}],openings:[{id:'door',wallId:'wall',kind:'door',shape:'rectangle',offset:100,bottom:0,width:90,height:210,depth:4}],wallHeight:280,wallThickness:20,additionalCost:'0',taxRate:'6',view:{labels:true,drawingOpacity:1}});

test('wall finishes and real apertures persist independently and restore the same quote',async()=>{
  const store=createMemoryProjectStore(),source=project(),before=calculateProject(source);
  await store.saveProject(source);const loaded=await store.loadProject(source.id);
  assert.deepEqual(loaded.walls,source.walls);assert.deepEqual(loaded.openings,source.openings);assert.deepEqual(calculateProject(loaded),before);
  loaded.walls[0].items[0].unitPrice='999';loaded.openings[0].width=10;
  assert.deepEqual((await store.loadProject(source.id)).openings,source.openings);
  const invalid=structuredClone(source);invalid.walls[0].height=180;
  assert.throws(()=>store.saveProject(invalid),/超出/);assert.deepEqual(calculateProject(await store.loadProject(source.id)),before);
});
test('portable project exports wall-only material references and rejects stale aperture geometry',async()=>{
  const source=project(); source.walls[0].items[0].color=material.color; source.walls[0].items[0].image=material.image;
  const text=await exportProjectJSON(source,{materials:[material]}),loaded=await importProjectJSON(text);
  assert.deepEqual(loaded.materialsSnapshot,[material]);assert.deepEqual(loaded.walls,source.walls);assert.deepEqual(loaded.openings,source.openings);
  assert.deepEqual(calculateProject(loaded),calculateProject(source));
  const invalid=JSON.parse(text);invalid.openings[0].wallId='missing';await assert.rejects(importProjectJSON(JSON.stringify(invalid)),/不存在/);
});
test('CSV and print quote include real wall quantity and saved price provenance rather than newer catalog data',()=>{
  const source=project(),quote=calculateProject(source);
  // Left side is a 4.2m capped wall, less one real 0.9×2.1m door.
  assert.ok(Math.abs(quote.walls[0].netArea-9.87)<1e-9);
  assert.equal(quote.walls[0].materialCost,'103.64');assert.equal(quote.walls[0].laborCost,'19.74');assert.equal(quote.total,'133.96');
  const newer={...material,unitPrice:'99',provenance:{...material.provenance,priceDate:'2026-11-07'}};
  const csv=projectToCSV(source,{materials:[newer]}),html=renderExportHTML(source,{materials:[newer],includeDrawing:false});
  assert.match(csv,/墙面材料明细/);assert.match(csv,/9\.87/);assert.match(csv,/133\.96/);assert.match(csv,/2026-10-31/);assert.doesNotMatch(csv,/2026-11-07/);
  assert.match(html,/净裸露墙面/);assert.match(html,/南墙/);assert.match(html,/2026-10-31/);assert.doesNotMatch(html,/2026-11-07/);
});
