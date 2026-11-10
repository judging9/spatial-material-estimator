import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.MUNICIPAL_BUILD?pathToFileURL(resolve(process.env.MUNICIPAL_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {MUNICIPAL_PRESETS,isMunicipalPath,isMunicipalPolygon,createMunicipalElement,createMunicipalLayer,municipalCorridor,municipalMetrics,municipalFootprints,rawMunicipalFootprints,buildMunicipalQuantities,validateMunicipalElements,moveMunicipalElement}=await import(new URL('lib/municipal-design.js',root));
const {calculateMunicipalProject}=await import(new URL('lib/municipal-pricing.js',root));
const {polygonArea}=await import(new URL('lib/geometry.js',root));
const fixture=()=>({version:1,id:'municipal-project',name:'市政实绘',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:120000,height:90000,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},municipalElements:[],regions:[],walls:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const near=(a,b,eps=1e-8)=>assert.ok(Math.abs(Number(a)-b)<eps,`${a} != ${b}`);
const road=(patch={},project=fixture())=>({...createMunicipalElement('road',[{x:1000,y:1000},{x:2000,y:1000}],project),id:'road-one',width:200,height:10,unitPrice:'10',...patch});
const partArea=parts=>parts.reduce((sum,part)=>sum+polygonArea(part.points)-part.holes.reduce((sum,hole)=>sum+polygonArea(hole),0),0)*.0001;

test('fourteen municipal kinds create genuine editable paths, regions or point fixtures without market prices',()=>{
  assert.deepEqual(MUNICIPAL_PRESETS.map(preset=>preset.kind).sort(),['road','paving','pipeline','manhole','streetlight','green','kerb','intersection','roundabout','trafficlight','river','bridge','facility','fence'].sort());
  for(const preset of MUNICIPAL_PRESETS){const p=fixture(),points=isMunicipalPolygon(preset.kind)?rect(5000,5000,500,400):isMunicipalPath(preset.kind)?[{x:5000,y:5000},{x:6000,y:5000}]:[{x:5000,y:5000}];const item=createMunicipalElement(preset.kind,points,p);assert.equal(item.unitPrice,'');assert.equal(item.quantity,'1');assert.equal(item.locked,false);assert.equal(item.additionalCost,'0');assert.doesNotThrow(()=>validateMunicipalElements([item],p));assert.ok(municipalFootprints(item,p).length);}
});
test('a 10m straight road and actual butt caps have 20m² footprint and 2m³ primary paving',()=>{
  const p=fixture(),item=road();p.municipalElements=[item];const m=municipalMetrics(item,p);near(m.length,10);near(m.area,20);near(m.volume,2);near(m.perimeter,24);near(partArea(municipalFootprints(item,p)),20);assert.equal(m.totalDepth,10);
});
test('diagonal routes use real unit normals and rotation, translation and reversal preserve measured road area',()=>{
  const p=fixture(),base=road(),angle=.732,rotate=point=>({x:3000+(point.x-1000)*Math.cos(angle),y:3000+(point.x-1000)*Math.sin(angle)}),diagonal={...base,points:base.points.map(rotate)};
  near(municipalMetrics(diagonal,p).area,20);near(municipalMetrics(diagonal,p).length,10);near(municipalMetrics({...diagonal,points:[...diagonal.points].reverse()},p).area,20);assert.notEqual(municipalFootprints(diagonal,p)[0].points[0].x,municipalFootprints(diagonal,p)[0].points[1].x);
});
test('an L turn uses a single real miter corridor without counting overlapping segment rectangles twice',()=>{
  const p=fixture(),item=road({points:[{x:1000,y:1000},{x:2000,y:1000},{x:2000,y:2000}]});const ring=municipalCorridor(item.points,200);near(polygonArea(ring)*.0001,40);near(municipalMetrics(item,p).area,40);near(municipalMetrics(item,p).length,20);
});
test('wide hairpins, backwards repeats and self-crossing road boundaries are rejected rather than guessed',()=>{
  const p=fixture();for(const points of[[{x:1000,y:1000},{x:2000,y:2000},{x:1000,y:2000},{x:2000,y:1000}],[{x:1000,y:1000},{x:2000,y:1000},{x:1000,y:1000}],[{x:1000,y:1000},{x:2000,y:1000},{x:1000,y:1050}]])assert.throws(()=>validateMunicipalElements([road({points,width:600})],p));
});
test('crossed roads share one physical union and first persisted placement owns only the intersection',()=>{
  const p=fixture(),first=road(),second=road({id:'road-two',points:[{x:1500,y:500},{x:1500,y:1500}]});p.municipalElements=[first,second];const rows=buildMunicipalQuantities(p);near(rows[0].metrics.area,20);near(rows[1].metrics.area,16);near(rows[1].metrics.overlapArea,4);near(rows.reduce((sum,row)=>sum+row.metrics.area,0),36);near(partArea(municipalFootprints(second,p)),16);assert.equal(rows[1].parts.length,2);assert.ok(rows[1].metrics.warnings.length);
});
test('complete duplicate roads become zero net volume without random UUID or price-dependent ownership',()=>{
  const p=fixture(),first=road({id:'z-random',unitPrice:'2'}),second=road({id:'a-random',unitPrice:'9000'});p.municipalElements=[first,second];near(municipalMetrics(second,p).area,0);assert.deepEqual(municipalFootprints(second,p),[]);first.unitPrice='900000';second.id='z-after';near(municipalMetrics(second,p).area,0);near(municipalMetrics(first,p).area,20);
});
test('different base elevations keep independent stacked paving while coplanar road and plaza scopes deduct true overlap',()=>{
  const p=fixture(),base=road(),plaza={...createMunicipalElement('paving',rect(1400,900,200,300),p),id:'plaza',unitPrice:'1'};p.municipalElements=[base,plaza];near(municipalMetrics(plaza,p).area,2);plaza.elevation=30;near(municipalMetrics(plaza,p).area,6);
});
test('concave paving and internal holes use polygon net area, preserve the hole and allow independent green inside it',()=>{
  const p=fixture(),plaza={...createMunicipalElement('paving',[{x:1000,y:1000},{x:1500,y:1000},{x:1500,y:1200},{x:1200,y:1200},{x:1200,y:1500},{x:1000,y:1500}],p),id:'plaza',holes:[rect(1040,1040,100,100)],unitPrice:'1'},green={...createMunicipalElement('green',rect(1040,1040,100,100),p),id:'green',unitPrice:'1'};p.municipalElements=[plaza,green];near(municipalMetrics(plaza,p).area,15);near(municipalMetrics(green,p).area,1);assert.equal(municipalFootprints(plaza,p)[0].holes.length,1);
});
test('image calibration scales XY without changing user-entered cm width or material thickness',()=>{
  const p=fixture();p.drawing.type='png';p.calibration.metersPerPixel=.02;const item=road();near(municipalMetrics(item,p).length,20);near(municipalMetrics(item,p).area,40);near(municipalMetrics(item,p).volume,4);near(partArea(rawMunicipalFootprints(item,p))/.0001*.0004,40);
});
test('pipeline length uses actual point elevations, while rectangular trench volume uses its declared plan projection',()=>{
  const p=fixture(),pipe={...createMunicipalElement('pipeline',[{x:1000,y:1000,z:-200},{x:1300,y:1400,z:-100}],p),width:20,depth:80,height:120,unitPrice:'1'};const m=municipalMetrics(pipe,p);near(m.pathLength,5);near(m.length,Math.sqrt(26));near(m.volume,4.8);const v={...pipe,points:[{x:1000,y:1000,z:-200},{x:1000,y:1000,z:100}]};near(municipalMetrics(v,p).length,3);near(municipalMetrics(v,p).volume,0);assert.ok(municipalFootprints(v,p).length);assert.ok(municipalMetrics({...pipe,unit:'m³'},p).warnings.some(value=>value.includes('未计地形')));
});
test('pipeline plan crossings at sufficiently different real elevations are permitted, same elevation crossings rejected',()=>{
  const p=fixture(),points=[{x:1000,y:1000,z:0},{x:2000,y:2000,z:0},{x:1000,y:2000,z:100},{x:2000,y:1000,z:100}],pipe={...createMunicipalElement('pipeline',points,p),width:20};assert.doesNotThrow(()=>validateMunicipalElements([pipe],p));assert.throws(()=>validateMunicipalElements([{...pipe,points:points.map(point=>({...point,z:0}))}],p));
});
test('facility pieces price by confirmed count without pretending their outer volume is masonry concrete',()=>{
  const p=fixture(),well={...createMunicipalElement('manhole',[{x:1000,y:1000}],p),quantity:'3',unitPrice:'100.05'},light={...createMunicipalElement('streetlight',[{x:1500,y:1000}],p),quantity:'2',unitPrice:'200.10'};p.municipalElements=[well,light];const q=calculateMunicipalProject(p);assert.equal(q.total,'700.35');assert.equal(q.netArea,0);assert.throws(()=>validateMunicipalElements([{...well,unit:'m³'}],p));
});
test('loss, net labor, primary and layer fixed fees plus one project tax use exact cent arithmetic',()=>{
  const p=fixture(),item=road({unitPrice:'10.05',wasteRate:'10',laborRate:'2.05',additionalCost:'3.05',items:[{...createMunicipalLayer('基层',20),unitPrice:'5.05',wasteRate:'5',laborRate:'1.05',additionalCost:'1.10'}]});p.municipalElements=[item];p.additionalCost='7.10';p.taxRate='8.5';const q=calculateMunicipalProject(p),row=q.municipalElements[0];assert.equal(row.items[0].netQuantity,'20');assert.equal(row.items[0].purchaseQuantity,'22');assert.equal(row.items[0].materialCost,'221.10');assert.equal(row.items[0].laborCost,'41.00');assert.equal(row.items[1].netQuantity,'4');assert.equal(row.items[1].purchaseQuantity,'4.2');assert.equal(row.items[1].materialCost,'21.21');assert.equal(row.items[1].laborCost,'4.20');assert.equal(row.knownSubtotal,'291.66');assert.equal(q.knownSubtotal,'298.76');assert.equal(q.tax,'25.39');assert.equal(q.total,'324.15');assert.equal(row.totalDepth,30);
});
test('same-layer areas do not use quantity or unit price to decide actual geometry ownership',()=>{
  const p=fixture(),first=road({quantity:'3'}),second=road({id:'second',quantity:'100',points:[{x:1500,y:500},{x:1500,y:1500}]});p.municipalElements=[first,second];const q=calculateMunicipalProject(p);assert.equal(q.netArea,36);assert.equal(q.municipalElements[0].netQuantity,'60');assert.equal(q.municipalElements[1].netQuantity,'1600');assert.equal(q.totalLength,20);near(municipalMetrics(second,p).area,16);
});
test('blank prices preserve known net labor and fixed amounts, explicit zero prices produce a complete quote',()=>{
  const p=fixture(),item=road({unitPrice:'',laborRate:'1.05',additionalCost:'5.20'});p.municipalElements=[item];let q=calculateMunicipalProject(p);assert.equal(q.pending,true);assert.equal(q.total,null);assert.equal(q.knownSubtotal,'26.20');assert.equal(q.knownMaterialCost,'0.00');item.unitPrice='0';q=calculateMunicipalProject(p);assert.equal(q.pending,false);assert.equal(q.total,'26.20');
});
test('uncalibrated geometry stays pending but independently confirmed piece prices and fixed amounts remain known',()=>{
  const p=fixture();p.drawing.type='png';p.calibration.metersPerPixel=null;const r=road({unitPrice:'10',laborRate:'2',additionalCost:'5'}),well={...createMunicipalElement('manhole',[{x:2000,y:3000}],p),unitPrice:'20'};p.municipalElements=[r,well];const q=calculateMunicipalProject(p);assert.equal(q.pending,true);assert.equal(q.netArea,null);assert.equal(q.total,null);assert.equal(q.knownSubtotal,'25.00');assert.equal(q.municipalElements[1].total,'20.00');assert.equal(municipalFootprints(r,p),null);
});
test('big monetary inputs and per-line half-up rounding never pass through unsafe Number cents',()=>{
  const p=fixture(),well={...createMunicipalElement('manhole',[{x:1000,y:1000}],p),quantity:'3',unitPrice:'0.105'};p.municipalElements=[well];assert.equal(calculateMunicipalProject(p).total,'0.32');well.unitPrice='9007199254740993.01';assert.equal(calculateMunicipalProject(p).total,'27021597764222979.03');
});
test('irrelevant rotation floating-point residue cannot flip a material half-cent at an exact measured area',()=>{
  for(let i=0;i<100;i++){
    const p=fixture(),angle=i*.061,points=[{x:4000,y:4000},{x:4000+1000*Math.cos(angle),y:4000+1000*Math.sin(angle)}],item=road({points,unitPrice:'0.13375'});p.municipalElements=[item];assert.equal(calculateMunicipalProject(p).total,'2.68');
  }
});
test('outdoor estimates remain independent of unfinished room, furniture, structural and legacy indicator worksheet budgets',()=>{
  const p=fixture();p.municipalElements=[road({unitPrice:'2'})];p.regions=[{id:'pending-room',points:rect(4000,4000,1000,1000),holes:[],items:[],name:'无材料房间',additionalCost:'0'}];p.furniture=[{unitPrice:''}];p.civilElements=[{unitPrice:''}];p.cost={municipal:{enabled:true}};const q=calculateMunicipalProject(p);assert.equal(q.total,'40.00');assert.equal(q.pending,false);assert.deepEqual(q.regions,[]);assert.deepEqual(q.civilElements,[]);
});
test('unrelated building levels do not duplicate outdoor lengths, fixtures, fixed fees or taxes',()=>{
  const p=fixture();p.municipalElements=[road({unitPrice:'2'})];p.levels=[{id:'level-one',name:'一楼',elevation:0,height:300},{id:'level-two',name:'二楼',elevation:300,height:300,content:{regions:[]}}];p.activeLevelId='level-one';p.additionalCost='5';p.taxRate='10';const q=calculateMunicipalProject(p);assert.equal(q.municipalElements.length,1);assert.equal(q.netArea,20);assert.equal(q.total,'49.50');
});
test('geometry cache ignores pricing changes and exposes independent copies that cannot corrupt later measurements',()=>{
  const p=fixture(),item=road();p.municipalElements=[item];const before=structuredClone(p),parts=municipalFootprints(item,p);parts[0].points[0].x=999999;near(municipalMetrics(item,p).area,20);assert.deepEqual(p,before);item.width=400;near(municipalMetrics(item,p).area,40);item.unitPrice='999';near(municipalMetrics(item,p).area,40);
});
test('locked and hidden municipal items retain quote while move helper preserves or independently shifts actual points and holes',()=>{
  const p=fixture(),item=road({locked:true,hidden:true});p.municipalElements=[item];assert.equal(calculateMunicipalProject(p).total,'200.00');assert.deepEqual(moveMunicipalElement(item,{x:0,y:0},{x:100,y:200}),item);const free={...item,locked:false},moved=moveMunicipalElement(free,{x:0,y:0},{x:100,y:200});assert.equal(moved.points[0].x,1100);near(municipalMetrics(moved,p).area,20);assert.equal(free.points[0].x,1000);
});
test('invalid fields, repeated IDs, orphan holes, negative prices and facilities with extra nodes are rejected before saving',()=>{
  const p=fixture(),good=road(),bad=[{width:0},{height:Infinity},{quantity:'1.5'},{unitPrice:'-1'},{wasteRate:'NaN'},{locked:'yes'},{points:[{x:1,y:1}]},{name:''},{kind:'unknown'},{unit:'kg'},{elevation:Infinity},{items:[{...createMunicipalLayer(),thickness:0}]}];for(const patch of bad)assert.throws(()=>validateMunicipalElements([{...good,...patch}],p));assert.throws(()=>validateMunicipalElements([good,good],p));const plaza=createMunicipalElement('paving',rect(2000,2000,500,500),p);assert.throws(()=>validateMunicipalElements([{...plaza,holes:[rect(3000,3000,50,50)]}],p));const fixtureItem=createMunicipalElement('streetlight',[{x:2000,y:2000}],p);assert.throws(()=>validateMunicipalElements([{...fixtureItem,points:[...fixtureItem.points,{x:3000,y:3000}]}],p));
});
test('geometry outside the board includes full road width and shifted node high elevations remain finite',()=>{
  const p=fixture(),item=road({points:[{x:100,y:20},{x:1100,y:20}],width:200});assert.throws(()=>validateMunicipalElements([item],p));const pipe=createMunicipalElement('pipeline',[{x:1000,y:1000},{x:2000,y:1000}],p);assert.throws(()=>validateMunicipalElements([{...pipe,points:[pipe.points[0],{x:2000,y:1000,z:Infinity}]}],p));
});
