import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneModel } from '../static/studio/lib/scene-model.js';
import { ensureLevels, addLevel, switchLevel } from '../static/studio/lib/levels.js';
import { floorLabelData } from '../static/studio/lib/camera3d.js';

const room = (id='ground-room',points=[{x:200,y:200},{x:600,y:200},{x:600,y:500},{x:200,y:500}]) => ({id,name:'客厅',points,holes:[],hidden:false,items:[],additionalCost:'0'});
const source = () => ({version:1,id:'building',name:'Loft',drawing:{id:'plan',name:'平面图',type:'plan',width:2400,height:1800,url:'data:image/png;base64,'},calibration:{metersPerPixel:.01},walls:[{id:'ground-wall',start:{x:190,y:190},end:{x:610,y:190},height:280,thickness:20}],regions:[room()],wallHeight:280,wallThickness:20,wallJoinStyle:'clean',additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const twoLevels=()=>{
  let project=ensureLevels(source());
  const groundId=project.activeLevelId;
  project=addLevel(project,{name:'二楼',height:300,copyLayout:false});
  project.regions=[room('upper-room',[{x:200,y:200},{x:600,y:200},{x:600,y:350},{x:200,y:350}])];
  project.walls=[{id:'upper-wall',start:{x:190,y:190},end:{x:610,y:190},height:280,thickness:20}];
  return {project,groundId,upperId:project.activeLevelId};
};

test('two storeys retain local saved geometry and use their real metre elevations in the scene',()=>{
  const {project}=twoLevels(),before=structuredClone(project),model=buildSceneModel(project);
  assert.equal(model.levels.length,2);assert.equal(model.floors.length,2);
  near(model.walls.find(wall=>wall.id==='ground-wall').start.y,0);
  near(model.walls.find(wall=>wall.id==='upper-wall').start.y,3);
  near(model.walls.find(wall=>wall.id==='upper-wall').position.y,4.4);
  near(model.bounds.max.y,5.8);near(model.bounds.min.y,-.2);
  near(floorLabelData(model.floors.find(floor=>floor.id==='ground-room')).netArea,12);
  near(floorLabelData(model.floors.find(floor=>floor.id==='upper-room')).netArea,6);
  assert.deepEqual(project,before);
});
test('a partial upper storey remains a true mezzanine footprint instead of copying the ground floor',()=>{
  const {project}=twoLevels(),model=buildSceneModel(project),upper=model.floors.find(floor=>floor.id==='upper-room');
  assert.ok(upper.points.every(point=>point.z<=3.5));
  const slab=model.slabs.find(slab=>slab.regionId==='upper-room');
  near(slab.top,3);near(slab.bottom,2.8);assert.equal(slab.surfaces.length,4);
  assert.ok(slab.surfaces.every(surface=>surface.points.every(point=>point.y>=2.8&&point.y<=3)));
});
test('active-storey view filters only display, and switching restores the independent floor geometry',()=>{
  let {project,groundId,upperId}=twoLevels();project.view.levelMode='active';
  let model=buildSceneModel(project);assert.equal(model.levels.length,1);assert.equal(model.levels[0].id,upperId);assert.equal(model.floors[0].id,'upper-room');near(model.bounds.min.y,2.8);
  project=switchLevel(project,groundId);model=buildSceneModel(project);assert.equal(model.levels[0].id,groundId);assert.equal(model.floors[0].id,'ground-room');near(model.bounds.max.y,2.8);
  project.view.levelMode='all';assert.equal(buildSceneModel(project).floors.length,2);
});
test('floor openings cut the top, underside, slab reveal, ceiling and measured net area with one ring',()=>{
  const {project}=twoLevels();
  project.floorOpenings=[{id:'stair-opening',regionId:'upper-room',points:[{x:250,y:230},{x:350,y:230},{x:350,y:330},{x:250,y:330}]}];
  project.regions[0].ceiling={enabled:true,height:260,items:[],additionalCost:'0'};
  const before=structuredClone(project),model=buildSceneModel(project),upper=model.floors.find(floor=>floor.id==='upper-room'),slab=model.slabs.find(slab=>slab.regionId==='upper-room'),ceiling=model.ceilings[0];
  assert.equal(upper.holes.length,1);assert.equal(slab.underside.holes.length,1);assert.equal(slab.surfaces.length,8);assert.equal(ceiling.holes.length,1);
  near(floorLabelData(upper).netArea,5);near(floorLabelData(slab.underside).netArea,5);near(floorLabelData(ceiling).netArea,5);near(ceiling.points[0].y,5.6);
  assert.deepEqual(project,before);
});
test('ceiling material and actual height derive from its region settings while visibility keeps the geometry unchanged',()=>{
  const project=ensureLevels(source());project.regions[0].ceiling={enabled:true,height:240,items:[{color:'#b9c9b5',image:'data:image/svg+xml,<svg/>'}],additionalCost:'0'};
  const before=buildSceneModel(project);assert.equal(before.ceilings.length,1);near(before.ceilings[0].points[0].y,2.4);assert.equal(before.ceilings[0].color,'#b9c9b5');assert.equal(before.ceilings[0].materialImage,'data:image/svg+xml,<svg/>');
  project.view.ceilings=true;assert.deepEqual(buildSceneModel(project),before);
});
test('low wall display is clipped relative to each storey rather than a global height threshold',()=>{
  const {project}=twoLevels(),model=buildSceneModel(project,.6);
  const upper=model.surfaces.filter(surface=>surface.wallId==='upper-wall'),ground=model.surfaces.filter(surface=>surface.wallId==='ground-wall');
  assert.ok(upper.length&&ground.length);
  assert.ok(upper.every(surface=>surface.points.every(point=>point.y>=3-1e-9&&point.y<=3.6+1e-9)));
  assert.ok(ground.every(surface=>surface.points.every(point=>point.y>=-1e-9&&point.y<=.6+1e-9)));
  near(model.walls.find(wall=>wall.id==='upper-wall').size.height,2.8);
});
