import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.OPENING_QUOTE_BUILD?pathToFileURL(resolve(process.env.OPENING_QUOTE_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {calculateOpeningQuote,defaultOpeningQuote,openingQuoteMetrics}=await import(new URL('lib/opening-pricing.js',root));
const {calculateProject}=await import(new URL('lib/pricing.js',root));
const {validateOpenings,buildWallSolid}=await import(new URL('lib/wall-solid.js',root));
const {addLevel,levelProjects}=await import(new URL('lib/levels.js',root));
const {createMemoryProjectStore,createHistory,exportProjectJSON,importProjectJSON}=await import(new URL('lib/persistence.js',root));
const {projectToCSV,renderExportHTML}=await import(new URL('lib/export.js',root));
const opening=(patch={})=>({id:'opening',wallId:'wall',kind:'door',shape:'rectangle',offset:100,bottom:0,width:90,height:200,depth:4,...patch});
const config=(patch={})=>({enabled:true,unit:'件',quantity:'1',unitPrice:'100',wasteRate:'0',laborRate:'0',additionalCost:'0',...patch});
const fixture=(patch={})=>({version:1,id:'opening-price-project',name:'开口报价',drawing:{id:'drawing',type:'plan',name:'真实平面',width:2400,height:1800,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},wallJoinStyle:'clean',walls:[{id:'wall',start:{x:100,y:100},end:{x:900,y:100},height:300,thickness:20}],regions:[],openings:[opening()],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1},...patch});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('legacy apertures and explicit disabled quotes preserve prior wall-only totals',()=>{
  const source=fixture(),before=calculateProject(source);assert.equal(before.total,'0.00');assert.deepEqual(before.openings,[]);
  source.openings[0].quote=config({enabled:false});assert.deepEqual(calculateProject(source),before);assert.equal(defaultOpeningQuote(opening()).unitPrice,'');
});
test('manual count, waste, labor, fixed fee and project tax use cent precision once',()=>{
  const source=fixture({additionalCost:'2.005',taxRate:'6',openings:[opening({quote:config({quantity:'3',unitPrice:'100.105',wasteRate:'10',laborRate:'20.015',additionalCost:'7.005'})})]}),quote=calculateProject(source),row=quote.openings[0];
  assert.equal(row.netQuantity,'3');assert.equal(row.purchaseQuantity,'3.3');assert.equal(row.materialCost,'330.35');assert.equal(row.laborCost,'60.05');assert.equal(row.additionalCost,'7.01');assert.equal(row.total,'397.41');
  assert.equal(quote.subtotal,'399.42');assert.equal(quote.tax,'23.97');assert.equal(quote.total,'423.39');assert.equal(quote.knownOpeningCost,'397.41');
});
test('empty price exposes pending while preserving real quantity, known labor and fixed costs',()=>{
  const source=fixture({openings:[opening({quote:config({quantity:'2',unitPrice:'',laborRate:'3.333',additionalCost:'4.445'})})]}),quote=calculateProject(source),row=quote.openings[0];
  assert.equal(row.pending,true);assert.equal(row.total,null);assert.equal(row.netQuantity,'2');assert.equal(row.purchaseQuantity,'2');assert.equal(row.materialCost,null);assert.equal(row.laborCost,'6.67');assert.equal(row.knownSubtotal,'11.12');assert.equal(quote.knownSubtotal,'11.12');assert.equal(quote.total,null);
});
test('explicit zero is a valid user quote and small decimal sums remain exact',()=>{
  const zero=opening({quote:config({unitPrice:'0'})});assert.equal(calculateOpeningQuote(zero).pending,false);assert.equal(calculateOpeningQuote(zero).total,'0.00');
  zero.quote=config({quantity:'3',unitPrice:'0.105'});assert.equal(calculateOpeningQuote(zero).total,'0.32');
  zero.quote=config({quantity:'9007199254740993',unitPrice:'0.1'});assert.equal(calculateOpeningQuote(zero).total,'900719925474099.30');
});
test('rectangle, ellipse and concave polygon use their actual contour area instead of enclosing boxes',()=>{
  const rectangular=opening({kind:'window',width:120,height:100,bottom:80,quote:config({unit:'m²',unitPrice:'12.34',wasteRate:'5',laborRate:'2'})}),rect=calculateOpeningQuote(rectangular);
  near(rect.netArea,1.2);assert.equal(rect.netQuantity,'1.2');assert.equal(rect.purchaseQuantity,'1.26');assert.equal(rect.materialCost,'15.55');assert.equal(rect.laborCost,'2.40');assert.equal(rect.total,'17.95');
  const ellipse=calculateOpeningQuote({...rectangular,shape:'ellipse'});assert.ok(ellipse.netArea<1.2&&ellipse.netArea>.94);assert.notEqual(ellipse.total,rect.total);
  const polygon=calculateOpeningQuote({...rectangular,shape:'polygon',width:100,height:100,points:[{x:0,y:0},{x:100,y:0},{x:100,y:40},{x:40,y:40},{x:40,y:100},{x:0,y:100}]});near(polygon.netArea,.64);
});
test('length pricing follows the true closed contour including nonrectangular edges',()=>{
  const item=opening({kind:'hole',width:100,height:100,shape:'polygon',points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}],quote:config({unit:'m',unitPrice:'10'})}),row=calculateOpeningQuote(item);
  near(row.perimeter,2+Math.SQRT2);near(Number(row.netQuantity),2+Math.SQRT2);assert.equal(row.materialCost,'34.14');
});
test('moving, locking and changing display scale do not alter physical object quantity or costs',()=>{
  const item=opening({kind:'window',shape:'ellipse',width:120,height:90,quote:config({unit:'m²',unitPrice:'88.88'})}),before=calculateOpeningQuote(item),moved=calculateOpeningQuote({...item,offset:500,bottom:80,locked:true});
  assert.equal(moved.netQuantity,before.netQuantity);assert.equal(moved.total,before.total);assert.deepEqual(openingQuoteMetrics(item),openingQuoteMetrics({...item,offset:98765,bottom:98765}));
  const source=fixture({openings:[item]});assert.equal(calculateProject({...source,calibration:{metersPerPixel:99},view:{labels:false}}).total,calculateProject(source).total);
});
test('wall deduction and object quote remain independent and budget quantities never multiply physical holes',()=>{
  const source=fixture(),before=buildWallSolid(source).metrics;source.openings[0].quote=config({quantity:'5',unitPrice:'120'});const quote=calculateProject(source);
  assert.deepEqual(buildWallSolid(source).metrics,before);assert.equal(quote.openings[0].total,'600.00');assert.equal(source.openings.length,1);source.openings[0].quote.quantity='2';assert.deepEqual(buildWallSolid(source).metrics,before);
});
test('copying a storey remaps object identity and bills its actual new apertures once with one tax',()=>{
  const original=fixture({additionalCost:'5',taxRate:'10',openings:[opening({quote:config({unitPrice:'100',additionalCost:'7'})})]}),source=addLevel(original,{name:'二楼',copyLayout:true}),quote=calculateProject(source),layers=levelProjects(source);
  assert.equal(quote.openings.length,2);assert.notEqual(quote.openings[0].id,quote.openings[1].id);assert.equal(quote.knownOpeningCost,'214.00');assert.equal(quote.subtotal,'219.00');assert.equal(quote.tax,'21.90');assert.equal(quote.total,'240.90');
  assert.deepEqual(layers[0].project.openings[0].quote,layers[1].project.openings[0].quote);assert.ok(quote.openings.every(row=>row.levelId&&row.levelName));
});
test('invalid prices, units, types and disabled financial input reject before import or persistence',()=>{
  for(const quote of[config({unitPrice:'-1'}),config({quantity:'-1'}),config({unit:'kg'}),config({enabled:'true'}),config({laborRate:'NaN'}),config({wasteRate:Infinity}),config({enabled:false,additionalCost:'-2'}),null,[]]){
    const source=fixture({openings:[opening({quote})]});assert.throws(()=>validateOpenings(source));assert.throws(()=>calculateProject(source));
  }
});
test('unfinished zero counts are saved as pending without fabricating measurable procurement',async()=>{
  const source=fixture({openings:[opening({quote:config({quantity:'0',additionalCost:'8.88'})})]}),quote=calculateProject(source);assert.equal(quote.pending,true);assert.equal(quote.openings[0].netQuantity,null);assert.equal(quote.knownSubtotal,'8.88');
  const store=createMemoryProjectStore();await store.saveProject(source);assert.equal(calculateProject(await store.loadProject(source.id)).pending,true);
});
test('save, JSON and undo preserve independent user price snapshots and lock state',async()=>{
  const source=fixture({openings:[opening({locked:true,quote:config({unitPrice:'333.33',laborRate:'9',additionalCost:'1.11'})})]}),quote=calculateProject(source),store=createMemoryProjectStore();await store.saveProject(source);
  const loaded=await store.loadProject(source.id);assert.deepEqual(loaded.openings,source.openings);assert.deepEqual(calculateProject(loaded),quote);loaded.openings[0].quote.unitPrice='9';assert.equal((await store.loadProject(source.id)).openings[0].quote.unitPrice,'333.33');
  const text=await exportProjectJSON(source),imported=await importProjectJSON(text);assert.deepEqual(imported.openings,source.openings);assert.equal(calculateProject(imported).total,quote.total);
  const history=createHistory(source),next=structuredClone(source);next.openings[0].quote.unitPrice='100';history.push(next);assert.deepEqual(history.undo().openings,source.openings);assert.equal(history.redo().openings[0].quote.unitPrice,'100');
});
test('CSV and print identify object scope, actual dimensions, quantities and user prices',()=>{
  const source=fixture({openings:[opening({name:'南墙定制门',quote:config({quantity:'2',unitPrice:'150.15',laborRate:'3.33',additionalCost:'4.44'})})]}),csv=projectToCSV(source),html=renderExportHTML(source,{includeDrawing:false});
  assert.match(csv,/门窗 \/ 开孔明细/);assert.match(csv,/南墙定制门/);assert.match(csv,/150\.15/);assert.match(csv,/距墙起点/);assert.match(csv,/门窗 \/ 开孔汇总/);assert.match(html,/data-quote-kind="opening"/);assert.match(html,/实际|真实开口/);assert.match(html,/南墙定制门/);assert.match(html,/311\.40/);
});
test('pending user prices prevent formal CSV/PDF while draft exports mark missing prices honestly',()=>{
  const source=fixture({openings:[opening({quote:config({unitPrice:''})})]});assert.throws(()=>projectToCSV(source),/填写单价/);assert.throws(()=>renderExportHTML(source),/填写单价/);
  assert.match(projectToCSV(source,{allowDraft:true}),/待填写单价/);assert.match(renderExportHTML(source,{allowDraft:true}),/报价草稿/);
});
test('user names cannot introduce executable HTML or spreadsheet formulas in opening exports',()=>{
  const source=fixture({openings:[opening({name:'=1+1<script>alert(1)</script>',quote:config()})]}),csv=projectToCSV(source),html=renderExportHTML(source,{includeDrawing:false});assert.match(csv,/'=1\+1/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
