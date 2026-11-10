import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneModel } from '../static/studio/lib/scene-model.js';
import { buildLevelFurniture } from '../static/studio/lib/scene-furniture.js';
import { buildFurniture3D } from '../static/studio/lib/furniture3d.js';
import { ensureLevels, addLevel, switchLevel } from '../static/studio/lib/levels.js';
import { floorLabelData, pointInRingXZ, triangulateXZ } from '../static/studio/lib/camera3d.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { renderExportHTML } from '../static/studio/lib/export.js';

const rectangle=(x,y,w,d)=>[{x,y},{x:x+w,y},{x:x+w,y:y+d},{x,y:y+d}];
const ring=(x,y,radius,count=128)=>Array.from({length:count},(_,i)=>({x:x+radius*Math.cos(i*Math.PI*2/count),y:y+radius*Math.sin(i*Math.PI*2/count)}));
const near=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const source=()=>({version:1,id:'stair-scene',name:'楼梯与洞口',drawing:{id:'plan',name:'平面图',type:'plan',width:2400,height:1800,url:'data:image/png;base64,a'},calibration:{metersPerPixel:.01},wallHeight:280,wallThickness:20,walls:[],regions:[{id:'room',name:'客厅',points:rectangle(200,200,400,300),holes:[],hidden:false,items:[{id:'floor-price',materialId:'custom',materialName:'地面',unit:'m²',unitPrice:'100',wasteRate:'0',laborRate:'0',additionalCost:'25',quantityMode:'area',quantity:'0'}],additionalCost:'50'}],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const openingProject=opening=>{const project=ensureLevels(source());project.floorOpenings=[{id:'opening',regionId:'room',...opening}];project.regions[0].ceiling={enabled:true,height:260,items:[],additionalCost:'0'};return project;};
const area=floor=>floorLabelData(floor)?.netArea??0;
const stair=(id,targetId)=>({id,name:'楼梯',kind:'stairs',position:{x:400,y:350},width:90,depth:360,height:300,rotation:0,stairTargetLevelId:targetId,quantity:'1',unitPrice:'2000',additionalCost:'0'});
const twoLevels=()=>{let project=ensureLevels(source());const lowerId=project.activeLevelId;project=addLevel(project,{name:'二楼',copyLayout:true});const upperId=project.activeLevelId;project=switchLevel(project,lowerId);project.furniture=[stair('bound-stair',upperId),{...stair('unbound-stair'),stairTargetLevelId:undefined}];project=switchLevel(project,upperId);project.view.levelMode='active';return {project,lowerId,upperId};};

test('a wall-adjacent opening creates a real notch in the top, slab underside and ceiling',()=>{
  const project=openingProject({points:rectangle(180,180,120,120)}),before=structuredClone(project),model=buildSceneModel(project);
  assert.equal(model.floors.length,1);assert.equal(model.floors[0].regionId,'room');
  const floor=model.floors[0];near(area(floor),11);assert.equal(floor.holes.length,0);
  near(area(model.slabs[0].underside),11);near(area(model.ceilings[0]),11);
  assert.equal(pointInRingXZ({x:2.5,y:0,z:2.5},floor.points),false);
  assert.ok(triangulateXZ(floor.points).length>0);assert.deepEqual(project,before);
});

test('a ring opening preserves the middle island across floor, slab and ceiling without duplicate pricing',()=>{
  const project=openingProject({points:ring(400,350,100),holes:[ring(400,350,50)],shape:'annulus'}),model=buildSceneModel(project),quote=calculateProject(project);
  assert.equal(model.floors.length,2);assert.equal(model.slabs.length,2);assert.equal(model.ceilings.length,2);
  assert.equal(new Set(model.floors.map(floor=>floor.id)).size,2);assert.ok(model.floors.every(floor=>floor.regionId==='room'));
  const measured=model.floors.reduce((sum,floor)=>sum+area(floor),0);near(measured,12-Math.PI*.75,.002);
  near(measured,quote.regions[0].netArea);near(model.slabs.reduce((sum,slab)=>sum+area(slab.underside),0),measured);near(model.ceilings.reduce((sum,ceiling)=>sum+area(ceiling),0),measured);
  assert.ok(model.floors.some(floor=>!floor.holes.length&&pointInRingXZ({x:4,y:0,z:3.5},floor.points)));
  assert.equal(quote.regions.length,1);assert.equal(quote.regions[0].items.length,1);assert.equal(quote.regions[0].itemAdditionalCost,'25.00');assert.equal(quote.regions[0].additionalCost,'50.00');
});

test('a circular opening tangent to the room boundary keeps its exact location in every horizontal surface',()=>{
  const project=openingProject({points:ring(300,350,100),shape:'circle'}),model=buildSceneModel(project),floor=model.floors[0];
  near(model.floors.reduce((sum,part)=>sum+area(part),0),12-Math.PI,.003);
  assert.ok(floor.holes.some(hole=>hole.some(point=>Math.abs(point.x-2)<1e-9)));
  assert.ok(model.slabs[0].underside.holes.some(hole=>hole.some(point=>Math.abs(point.x-2)<1e-9)));
  assert.ok(model.ceilings[0].holes.some(hole=>hole.some(point=>Math.abs(point.x-2)<1e-9)));
});

test('an opening crossing both boundaries retains two selectable parts under one room owner',()=>{
  const project=openingProject({points:rectangle(350,180,100,340)}),model=buildSceneModel(project),quote=calculateProject(project);
  assert.equal(model.floors.length,2);assert.ok(model.floors.every(floor=>floor.regionId==='room'&&floor.partCount===2));
  near(model.floors.reduce((sum,floor)=>sum+area(floor),0),9);assert.equal(quote.regions[0].total,'975.00');
  assert.equal(model.slabs.length,2);assert.ok(model.slabs.every(slab=>slab.regionId==='room'&&slab.underside.regionId==='room'&&slab.surfaces.every(surface=>surface.regionId==='room')));
});

test('upper-only view includes its incoming staircase at its source elevation and does not copy unbound furniture',()=>{
  const {project,lowerId,upperId}=twoLevels(),before=structuredClone(project),furniture=buildLevelFurniture(project);
  assert.equal(furniture.length,1);const item=furniture[0];assert.equal(item.id,'bound-stair');assert.equal(item.isIncoming,true);assert.equal(item.sourceLevelId,lowerId);assert.equal(item.levelId,lowerId);assert.equal(item.targetLevelId,upperId);near(item.position.y,0);near(item.size.height,3);
  assert.ok(item.surfaces.some(surface=>surface.points.some(point=>point.y>3)));assert.deepEqual(project,before);
});

test('all-storey display contains every staircase once and active source view owns its existing objects',()=>{
  let {project,lowerId}=twoLevels();const total=calculateProject(project).total;
  project.view.levelMode='all';let models=buildLevelFurniture(project);assert.equal(models.filter(item=>item.id==='bound-stair').length,1);assert.ok(models.every(item=>!item.isIncoming));
  project=switchLevel(project,lowerId);project.view.levelMode='active';models=buildLevelFurniture(project);assert.equal(models.length,2);assert.ok(models.every(item=>item.levelId===lowerId&&!item.isIncoming));assert.equal(calculateProject(project).total,total);
});

test('hidden incoming staircases remain priced but are not duplicated into the target view',()=>{
  const {project,lowerId}=twoLevels();project.levels.find(level=>level.id===lowerId).content.furniture[0].hidden=true;
  assert.equal(buildLevelFurniture(project).length,0);assert.equal(calculateProject(project).furniture.filter(item=>item.id==='bound-stair').length,1);
});

test('legacy single-floor furniture model output remains compatible',()=>{
  const project=source();project.furniture=[{...stair('old-stair'),stairTargetLevelId:undefined}];assert.deepEqual(buildLevelFurniture(project),buildFurniture3D(project));
});

test('printed diagrams include all surviving surface parts while the room cost appears once',()=>{
  const project=openingProject({points:rectangle(350,180,100,340)}),html=renderExportHTML(project);
  const diagram=html.match(/<svg[\s\S]*?<\/svg>/)?.[0];assert.ok(diagram);
  assert.equal((diagram.match(/data-region-id="room"/g)??[]).length,1);assert.ok(/d="[^"]*M[^\"]*M/.test(diagram));
  assert.ok(html.includes('975.00'));assert.ok(diagram.includes('fill-rule="evenodd"'));
});

test('an upper-floor print shows its incoming stair as a reference and the budget keeps one furniture entry',()=>{
  const {project}=twoLevels(),quote=calculateProject(project),html=renderExportHTML(project);
  assert.equal(quote.furniture.filter(item=>item.id==='bound-stair').length,1);
  assert.equal((html.match(/data-incoming-stair="true"/g)??[]).length,1);assert.ok(html.includes('来自一楼'));
});
