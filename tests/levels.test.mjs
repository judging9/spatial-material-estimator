import test from 'node:test';
import assert from 'node:assert/strict';
import { activeLevel, ensureLevels, levelProjects, switchLevel, addLevel, updateLevel, deleteLevel, validateLevels, effectiveLevelProject, ceilingHeight } from '../static/studio/lib/levels.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';
const rectangle = (x,y,w,d) => [{x,y},{x:x+w,y},{x:x+w,y:y+d},{x,y:y+d}];
const item = (id, price='10', waste='0', labor='0') => ({ id, materialId:'material-floor',materialName:'地面材料',unit:'m²',unitPrice:price,wasteRate:waste,laborRate:labor,additionalCost:'0',quantityMode:'area',quantity:'0' });
const room = () => ({id:'room-one',name:'一层客厅',points:rectangle(200,200,600,400),holes:[],hidden:false,items:[item('floor-item')],additionalCost:'0'});
const fixture = () => ({ version:1,id:'project-levels',name:'逐层报价',drawing:{id:'native-plan',name:'平面图',type:'plan',url:'data:image/png;base64,iVBORw0KGgo=',width:2400,height:1800},calibration:{metersPerPixel:.01,method:'metric-plan'},wallJoinStyle:'clean',regions:[room()],walls:[],wallHeight:280,wallThickness:20,additionalCost:'100',taxRate:'10',view:{labels:true,drawingOpacity:1} });
const furniture = (id='furniture-one', price='.105', quantity='3') => ({id,name:'用户家具',kind:'bed',position:{x:450,y:400},width:100,depth:200,height:55,rotation:17.5,quantity,unitPrice:price,additionalCost:'0'});
const near = (a,b,tolerance=1e-8) => assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

test('legacy project stays untouched; enabling storeys preserves its quote and chooses a real first-storey height', () => {
  const p=fixture(),copy=structuredClone(p),before=calculateProject(p),next=ensureLevels(p);
  assert.deepEqual(p,copy);assert.equal(p.levels,undefined);assert.equal(next.levels.length,1);assert.equal(activeLevel(next).height,300);assert.equal(activeLevel(next).elevation,0);assert.equal(activeLevel(next).content,undefined);
  assert.equal(calculateProject(next).total,before.total);assert.equal(calculateProject(next).regions[0].levelName,'一楼');
  assert.throws(()=>ensureLevels({...p,drawing:{...p.drawing,type:'image'}}),/平面图/);
});

test('maximum-height 10 metre walls can enable and add storeys without altering real wall dimensions', () => {
  const p=fixture();p.wallHeight=1000;p.walls=[{id:'tall-wall',start:{x:100,y:100},end:{x:900,y:100},thickness:20,height:1000}];const original=structuredClone(p);
  const enabled=ensureLevels(p);assert.equal(activeLevel(enabled).height,1000);assert.equal(enabled.wallHeight,1000);assert.deepEqual(enabled.walls,p.walls);assert.deepEqual(p,original);
  const added=addLevel(enabled),lower=levelProjects(added)[0];assert.equal(added.levels.length,2);assert.equal(activeLevel(added).elevation,1000);assert.equal(lower.height,1000);assert.equal(lower.project.wallHeight,1000);assert.deepEqual(lower.project.walls,p.walls);assert.deepEqual(p,original);assert.doesNotThrow(()=>validateLevels(added));
});

test('adding an empty upper storey has no invented furniture, rooms or quote and switching preserves lower work', () => {
  let p=ensureLevels(fixture());const first=p.activeLevelId,before=calculateProject(p).total;
  p=addLevel(p,{name:'Loft 二楼'});assert.equal(activeLevel(p).elevation,300);assert.deepEqual(p.regions,[]);assert.deepEqual(p.furniture,[]);assert.equal(calculateProject(p).total,before);
  p.regions.push({...room(),id:'up-room',name:'夹层卧室',points:rectangle(200,200,300,200),items:[item('up-item','20')]});
  const upstairs=p.activeLevelId,quote=calculateProject(p);near(quote.levelSummaries.find(layer=>layer.id===upstairs).netArea,6);assert.equal(quote.total,'506.00');
  p=switchLevel(p,first);assert.equal(p.regions[0].id,'room-one');assert.equal(calculateProject(p).total,quote.total);
  p=switchLevel(p,upstairs);assert.equal(p.regions[0].name,'夹层卧室');assert.equal(activeLevel(p).content,undefined);
});

test('Object.assign switch clears absent legacy fields instead of carrying upper furniture downstairs', () => {
  let p=ensureLevels(fixture());const first=p.activeLevelId;p=addLevel(p);p.furniture.push(furniture('upper-furniture'));
  const target={...p};Object.assign(target,switchLevel(p,first));assert.equal(target.furniture,undefined);assert.equal(levelProjects(target).find(layer=>layer.id!==first).project.furniture.length,1);
  const view=levelProjects(target);assert.ok(view.every(layer=>layer.project.levels===undefined&&layer.project.activeLevelId===undefined));
});

test('copy layout remaps all geometric and price IDs while keeping each stored snapshot independent', () => {
  const p=fixture();p.furniture=[furniture()];p.regions[0].ceiling={enabled:true,height:260,items:[item('ceiling-item','5')],additionalCost:'7'};
  p.floorOpenings=[{id:'void-one',regionId:'room-one',points:rectangle(250,250,50,50)}];
  const copy=addLevel(p,{copyLayout:true}),layers=levelProjects(copy);assert.equal(layers.length,2);const lower=layers[0].project,upper=layers[1].project;
  assert.notEqual(lower.regions[0].id,upper.regions[0].id);assert.notEqual(lower.regions[0].items[0].id,upper.regions[0].items[0].id);assert.notEqual(lower.furniture[0].id,upper.furniture[0].id);assert.notEqual(lower.regions[0].ceiling.items[0].id,upper.regions[0].ceiling.items[0].id);
  assert.equal(upper.floorOpenings[0].regionId,upper.regions[0].id);assert.equal(upper.furniture[0].unitPrice,'.105');assert.equal(upper.regions[0].ceiling.height,260);
  upper.regions[0].items[0].unitPrice='999';assert.equal(lower.regions[0].items[0].unitPrice,'10');
});

test('two storeys keep decimal component rounding, project fixed fee and one shared tax exact', () => {
  const p=fixture();p.regions=[];p.furniture=[furniture()];p.additionalCost='.105';
  const copy=addLevel(p,{copyLayout:true}),quote=calculateProject(copy);
  assert.equal(quote.materialCost,'0.64');assert.equal(quote.projectAdditionalCost,'0.11');assert.equal(quote.beforeTax,'0.75');assert.equal(quote.tax,'0.08');assert.equal(quote.total,'0.83');
  const small=fixture();small.regions=[];small.furniture=[furniture('tiny','.05','1')];small.additionalCost='0';small.taxRate='5';
  const result=calculateProject(addLevel(small,{copyLayout:true}));assert.equal(result.beforeTax,'0.10');assert.equal(result.tax,'0.01');assert.equal(result.total,'0.11');
});

test('storey aggregation never converts money above Number safety to floating point', () => {
  const p=fixture();p.regions=[];p.furniture=[furniture('large','9007199254740993.01','1')];p.additionalCost='0';p.taxRate='0';
  let next=addLevel(p);next.furniture.push(furniture('small','1.01','1'));
  assert.equal(calculateProject(next).total,'9007199254740994.02');
});

test('missing price on an inactive floor stays pending without hiding known prices from another floor', () => {
  const p=fixture();p.furniture=[furniture('missing','','1')];const next=addLevel(p);next.regions.push({...room(),id:'room-up',items:[item('up-item','20')]});
  const q=calculateProject(next);assert.equal(q.pending,true);assert.equal(q.total,null);assert.match(q.pendingReason,/一楼.*家具/);assert.equal(q.knownMaterialCost,'720.00');assert.equal(q.knownSubtotal,'820.00');
});

test('real slab void reduces floor and ceiling by its polygon area while raw wall-derived room remains intact', () => {
  const p=fixture();p.regions[0].ceiling={enabled:true,items:[item('ceiling-item','5','10','2')],additionalCost:'10'};
  p.floorOpenings=[{id:'stairs-hole',regionId:'room-one',points:rectangle(300,300,100,100)}];const saved=structuredClone(p);
  const effective=effectiveLevelProject(p),quote=calculateProject(p);near(quote.regions[0].netArea,23);near(quote.ceilings[0].netArea,23);assert.equal(quote.ceilings[0].sourceRegionId,'room-one');assert.equal(quote.ceilings[0].id,'ceiling:room-one');
  assert.equal(quote.ceilings[0].items[0].purchaseQuantity,'25.3');assert.equal(quote.ceilings[0].materialCost,'126.50');assert.equal(quote.ceilings[0].laborCost,'46.00');assert.equal(quote.ceilings[0].total,'182.50');
  assert.deepEqual(p,saved);assert.equal(effective.regions[0].surfaceParts[0].holes.length,1);assert.equal(effective.regions[0].holes.length,0);assert.equal(effective.floorOpenings,undefined);assert.equal(effectiveLevelProject(effective),effective);
});

test('slab opening rejects zero intersection, invalid ownership and complete removal; boundary cuts and overlap are measured once', () => {
  for (const openings of [
    [{id:'x',regionId:'missing',points:rectangle(300,300,100,100)}],
    [{id:'x',regionId:'room-one',points:rectangle(100,300,100,100)}],
    [{id:'x',regionId:'room-one',points:room().points}],
  ]) { const p=fixture();p.floorOpenings=openings;assert.throws(()=>validateLevels(p),/洞口/); }
  const touching=fixture();touching.floorOpenings=[{id:'x',regionId:'room-one',points:rectangle(200,300,100,100)}];assert.doesNotThrow(()=>validateLevels(touching));near(calculateProject(touching).regions[0].netArea,23);
  const overlapping=fixture();overlapping.floorOpenings=[{id:'x',regionId:'room-one',points:rectangle(300,300,100,100)},{id:'y',regionId:'room-one',points:rectangle(350,350,100,100)}];assert.doesNotThrow(()=>validateLevels(overlapping));near(calculateProject(overlapping).regions[0].netArea,22.25);
});

test('enabled empty ceilings are a real surface without a required fabricated material price', () => {
  const p=fixture();p.regions[0].ceiling={enabled:true,items:[],additionalCost:'0'};const q=calculateProject(p);
  assert.equal(q.pending,false);assert.equal(q.ceilings.length,1);assert.equal(q.ceilings[0].total,'0.00');assert.equal(q.total,'374.00');assert.equal(ceilingHeight(p,p.regions[0]),280);
  p.regions[0].ceiling.enabled=false;assert.equal(calculateProject(p).ceilings.length,0);
  p.regions[0].ceiling.items=[item('bad','NaN')];assert.throws(()=>calculateProject(p),/数字/);
});

test('ceiling malformed state or invalid height cannot reach pricing or persistence', () => {
  for (const ceiling of [null,{enabled:'yes',items:[],additionalCost:'0'},{enabled:true,items:[],height:NaN,additionalCost:'0'},{enabled:true,items:[],height:20,additionalCost:'0'},{enabled:true,items:{},additionalCost:'0'}]) {
    const p=fixture();p.regions[0].ceiling=ceiling;assert.throws(()=>calculateProject(p),/天花板/);
  }
});

test('levels validate metadata, unique IDs, active snapshot exclusivity and native-plan prerequisites', () => {
  const base=addLevel(fixture()),changes=[p=>p.levels[1].id=p.levels[0].id,p=>p.levels[1].elevation=42,p=>p.levels[0].height=-1,p=>p.levels[0].slabThickness=1000,p=>p.activeLevelId='missing',p=>p.levels[1].content={regions:[]},p=>delete p.levels[0].content,p=>p.levels[0].content.levels=[],p=>p.drawing.type='image'];
  for (const change of changes) { const bad=structuredClone(base);change(bad);assert.throws(()=>validateLevels(bad),/楼层|平面图/); }
  assert.throws(()=>validateLevels({...fixture(),activeLevelId:'orphan'}),/楼层/);
});

test('different storeys may overlap in XY but cannot share an actual object ID', () => {
  const p=addLevel(fixture());p.regions.push({...room(),id:'room-upper',items:[item('upper-item')]});assert.doesNotThrow(()=>validateLevels(p));
  p.regions[0].id='room-one';assert.throws(()=>validateLevels(p),/编号不能重复/);
});

test('updating storey height shifts all upper elevations without editing existing wall dimensions', () => {
  let p=ensureLevels(fixture());p.walls=[{id:'wall-one',start:{x:100,y:100},end:{x:900,y:100},thickness:20,height:280}];const first=p.activeLevelId;
  p=addLevel(p);const second=p.activeLevelId;p=addLevel(p);const third=p.activeLevelId;const before=structuredClone(p);
  const next=updateLevel(p,first,{height:350,name:'首层'});assert.deepEqual(p,before);assert.equal(next.levels.find(level=>level.id===second).elevation,350);assert.equal(next.levels.find(level=>level.id===third).elevation,650);assert.equal(levelProjects(next)[0].project.walls[0].height,280);
  assert.throws(()=>updateLevel(p,first,{height:0}),/高度/);
});

test('deleting current or inactive storey reorders elevations and clears only removed stair targets', () => {
  let p=addLevel(fixture());const second=p.activeLevelId,first=p.levels[0].id;
  p=switchLevel(p,first);p.furniture=[{...furniture('stair','1000','1'),kind:'stairs',height:300,depth:400,stairTargetLevelId:second}];
  const expected=calculateProject(p).total,next=deleteLevel(p,second);assert.equal(next.levels.length,1);assert.equal(next.furniture[0].stairTargetLevelId,undefined);assert.equal(next.furniture[0].height,300);assert.equal(next.furniture[0].unitPrice,'1000');assert.equal(calculateProject(next).total,expected);assert.throws(()=>deleteLevel(next,first),/保留/);
  const upper=addLevel(next);const upperId=upper.activeLevelId,deleted=deleteLevel(upper,upperId);assert.equal(deleted.activeLevelId,first);assert.equal(deleted.regions[0].id,'room-one');
});

test('stairs reject stale, lower-level and nonstairs bindings', () => {
  let p=addLevel(fixture());const first=p.levels[0].id;p.furniture=[{...furniture('stair'),kind:'stairs',stairTargetLevelId:first}];assert.throws(()=>validateLevels(p),/楼梯目标/);
  p.furniture[0].stairTargetLevelId='missing';assert.throws(()=>validateLevels(p),/楼梯目标/);
  p=switchLevel({...p,furniture:[]},first);p.furniture=[{...furniture('bed'),stairTargetLevelId:p.levels[1].id}];assert.throws(()=>validateLevels(p),/楼梯目标/);
});

test('bound stairs follow moved landings in active and inactive storeys without changing price snapshots', () => {
  let p=addLevel(fixture());const first=p.levels[0].id,second=p.activeLevelId;p=addLevel(p);const third=p.activeLevelId;
  p=switchLevel(p,first);p.furniture=[{...furniture('lower-stairs','1000','1'),kind:'stairs',height:560,mountHeight:40,stairTargetLevelId:third}];
  p=switchLevel(p,second);p.furniture=[{...furniture('middle-stairs','2500','1'),kind:'stairs',height:300,mountHeight:0,stairTargetLevelId:third}];
  const before=structuredClone(p),quote=calculateProject(p),next=updateLevel(p,second,{height:400});assert.deepEqual(p,before);
  const layers=levelProjects(next),lower=layers[0].project.furniture[0],middle=layers[1].project.furniture[0];
  assert.equal(next.levels.find(level=>level.id===third).elevation,700);assert.equal(lower.height,660);assert.equal(middle.height,400);
  assert.equal(lower.unitPrice,'1000');assert.equal(middle.unitPrice,'2500');assert.equal(calculateProject(next).total,quote.total);assert.doesNotThrow(()=>validateLevels(next));
});

test('deleting an intervening storey updates remaining bound rise and keeps the target and price', () => {
  let p=addLevel(fixture());const first=p.levels[0].id,second=p.activeLevelId;p=addLevel(p);const third=p.activeLevelId;p=switchLevel(p,first);
  p.furniture=[{...furniture('skip-stairs','8000','1'),kind:'stairs',height:600,stairTargetLevelId:third}];
  const next=deleteLevel(p,second);assert.equal(next.furniture[0].height,300);assert.equal(next.furniture[0].stairTargetLevelId,third);assert.equal(next.furniture[0].unitPrice,'8000');assert.equal(p.furniture[0].height,600);
});

test('a moved landing below stair mounting height rejects the whole edit or deletion', () => {
  let p=addLevel(fixture());const first=p.levels[0].id,second=p.activeLevelId;p=switchLevel(p,first);
  p.furniture=[{...furniture('mounted-stairs','5000','1'),kind:'stairs',height:220,mountHeight:80,stairTargetLevelId:second}];const original=structuredClone(p);
  assert.throws(()=>updateLevel(p,first,{height:50}),/楼梯实际升高/);assert.deepEqual(p,original);
  let three=addLevel(p);const third=three.activeLevelId;three=switchLevel(three,first);three.furniture[0].mountHeight=350;three.furniture[0].height=250;three.furniture[0].stairTargetLevelId=third;const saved=structuredClone(three);
  assert.throws(()=>deleteLevel(three,second),/楼梯实际升高/);assert.deepEqual(three,saved);
});

test('stale bound height or mount adjustment cannot save; releasing binding permits a user-defined stair rise', async () => {
  let p=addLevel(fixture());const first=p.levels[0].id,second=p.activeLevelId;p=switchLevel(p,first);p.furniture=[{...furniture('stair','1000','1'),kind:'stairs',height:300,stairTargetLevelId:second}];
  const storage=createMemoryProjectStore();await storage.saveProject(p);const bad=structuredClone(p);bad.furniture[0].height=280;
  assert.throws(()=>validateLevels(bad),/楼梯实际升高/);assert.throws(()=>storage.saveProject(bad),/楼梯实际升高/);await assert.rejects(importProjectJSON(JSON.stringify(bad)),/楼梯实际升高/);
  const mounted=structuredClone(p);mounted.furniture[0].mountHeight=20;assert.throws(()=>validateLevels(mounted),/楼梯实际升高/);mounted.furniture[0].height=280;assert.doesNotThrow(()=>validateLevels(mounted));
  delete bad.furniture[0].stairTargetLevelId;assert.doesNotThrow(()=>validateLevels(bad));assert.deepEqual(await storage.loadProject(p.id),p);
  assert.throws(()=>validateLevels({...fixture(),furniture:[{...furniture('orphan'),kind:'stairs',stairTargetLevelId:'missing'}]}),/楼梯绑定/);
});

test('copying stairs retains real geometry and prices while clearing cross-storey bindings', () => {
  let p=addLevel(fixture());const first=p.levels[0].id,second=p.activeLevelId;p=switchLevel(p,first);p.furniture=[{...furniture('stairs','2500','1'),kind:'stairs',height:275,mountHeight:25,stairTargetLevelId:second}];
  const next=addLevel(p,{copyLayout:true});assert.equal(next.furniture[0].stairTargetLevelId,undefined);assert.equal(next.furniture[0].height,275);assert.equal(next.furniture[0].mountHeight,25);assert.equal(next.furniture[0].unitPrice,'2500');assert.doesNotThrow(()=>validateLevels(next));
});

test('multi-storey state saves and reloads independently with ceiling, slab-hole and decimal quote intact', async () => {
  const storage=createMemoryProjectStore();const p=fixture();p.regions[0].ceiling={enabled:true,items:[item('ceiling-item','2.75')],additionalCost:'0'};p.floorOpenings=[{id:'void',regionId:'room-one',points:rectangle(300,300,100,100)}];
  const next=addLevel(p,{copyLayout:true}),before=calculateProject(next);await storage.saveProject(next);next.regions[0].name='未保存修改';const loaded=await storage.loadProject(next.id);assert.equal(loaded.regions[0].name,'一层客厅');assert.deepEqual(calculateProject(loaded),before);assert.equal((await storage.listProjects())[0].regionCount,2);
});

test('project JSON retains all-floor material snapshots, ceiling and curve owners without duplicate image data', async () => {
  const p=fixture();p.regions[0].ceiling={enabled:true,items:[{...item('ceiling-item','2'),materialId:'ceiling-material'}],additionalCost:'0'};
  const next=addLevel(p);next.regions.push({...room(),id:'upper-room',items:[{...item('up-item','20'),materialId:'up-material'}]});
  const materials=[{id:'material-floor',name:'首层面层',unit:'m²',image:'',color:'#cabba6'},{id:'ceiling-material',name:'吊顶板',unit:'m²',image:'',color:'#eeeeee'},{id:'up-material',name:'夹层面层',unit:'m²',image:'',color:'#bb9977'}];
  const json=await exportProjectJSON(next,{materials}),loaded=await importProjectJSON(json);assert.equal((json.match(/data:image\/png;base64/g)??[]).length,1);assert.deepEqual(loaded.materialsSnapshot.map(item=>item.id).sort(),materials.map(item=>item.id).sort());assert.equal(levelProjects(loaded)[0].project.regions[0].ceiling.items[0].materialName,'地面材料');assert.equal(calculateProject(loaded).total,calculateProject(next).total);
});

test('invalid inactive storey cannot replace saved valid work or survive JSON import', async () => {
  const storage=createMemoryProjectStore(),good=addLevel(fixture());await storage.saveProject(good);
  const bad=structuredClone(good);bad.levels[0].content.regions[0].items[0].unitPrice='NaN';assert.throws(()=>storage.saveProject(bad),/数字/);await assert.rejects(importProjectJSON(JSON.stringify(bad)),/数字/);assert.deepEqual(await storage.loadProject(good.id),good);
  const outside=structuredClone(good);outside.levels[0].content.floorOpenings=[{id:'outside',regionId:'room-one',points:rectangle(0,0,100,100)}];assert.throws(()=>storage.saveProject(outside),/洞口/);
});
