import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneModel } from '../static/studio/lib/scene-model.js';
import { normalizeWalls, detectPlanRooms } from '../static/studio/lib/wall-plan.js';
import { polygonArea } from '../static/studio/lib/geometry.js';
import { calculateProject } from '../static/studio/lib/pricing.js';

const rectangle = () => [
  { id:'top',start:{x:200,y:200},end:{x:600,y:200},thickness:20 },
  { id:'right',start:{x:600,y:200},end:{x:600,y:500},thickness:20 },
  { id:'bottom',start:{x:600,y:500},end:{x:200,y:500},thickness:20 },
  { id:'left',start:{x:200,y:500},end:{x:200,y:200},thickness:20 },
];
const project = () => {
  const walls=rectangle(), face=detectPlanRooms(walls)[0];
  return {version:1,id:'scene',name:'立体房间',drawing:{id:'plan',type:'plan'},calibration:{metersPerPixel:.01},walls,regions:[{id:'room',name:'客厅',points:face.points,holes:face.holes,hidden:false,items:[{id:'wood',materialId:'wood',unit:'m²',unitPrice:'120',wasteRate:'5',laborRate:'0',additionalCost:'0',quantityMode:'area',quantity:'0',color:'#a87851',image:'data:image/svg+xml,<svg></svg>'}],additionalCost:'0'}],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};
};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const xzArea=points=>Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.z-q.x*p.z;},0))/2;

test('墙体与净地面从厘米转为真实米，墙盒保留方形端帽',()=>{
  const source=project(), before=structuredClone(source), model=buildSceneModel(source);
  const top=model.walls.find(w=>w.id==='top');
  assert.deepEqual(top.position,{x:4,y:1.4,z:2});
  assert.deepEqual(top.size,{length:4.2,height:2.8,thickness:.2});
  assert.equal(top.rotationY,0);
  const right=model.walls.find(w=>w.id==='right');
  close(right.rotationY,-Math.PI/2);
  assert.deepEqual(right.size,{length:3.2,height:2.8,thickness:.2});
  close(xzArea(model.floors[0].points),10.64);
  assert.equal(model.floors[0].color,'#a87851');
  assert.equal(model.floors[0].materialImage,source.regions[0].items[0].image);
  assert.deepEqual(source,before);
});
test('墙高改变模型高度和相机范围，不改变净面积及材料报价',()=>{
  const source=project(), prior=calculateProject(source), before=buildSceneModel(source);
  source.walls=source.walls.map(w=>({...w,height:360}));
  const model=buildSceneModel(source);
  assert.equal(model.bounds.max.y,3.6);
  assert.equal(before.bounds.max.y,2.8);
  assert.deepEqual(model.floors,before.floors);
  const after=calculateProject(source);
  assert.deepEqual(after.regions,prior.regions);
  for(const field of ['total','materialCost','laborCost','additionalCost','subtotal','tax'])assert.equal(after[field],prior[field]);
  assert.ok(after.walls.every((wall,index)=>wall.netArea>prior.walls[index].netArea));
  close(polygonArea(detectPlanRooms(source.walls)[0].points)/10000,10.64);
});
test('旧工程缺墙高用默认2.8m；项目默认与单墙覆盖可分别指定',()=>{
  const source=project();
  assert.equal(normalizeWalls(source.walls)[0].height,undefined);
  source.wallHeight=300; source.walls[0].height=350;
  const model=buildSceneModel(source);
  assert.equal(model.walls.find(w=>w.id==='top').size.height,3.5);
  assert.equal(model.walls.find(w=>w.id==='right').size.height,3);
  assert.equal(normalizeWalls(source.walls)[0].height,350);
});
test('孔洞同步进入三维地面，隐藏区不生成可见地面，缩放不改变尺寸',()=>{
  const source=project();
  source.regions[0].holes=[[{x:250,y:250},{x:350,y:250},{x:350,y:350},{x:250,y:350}]];
  const model=buildSceneModel(source), floor=model.floors[0];
  close(xzArea(floor.points)-floor.holes.reduce((sum,h)=>sum+xzArea(h),0),9.64);
  source.view.zoom=4; assert.deepEqual(buildSceneModel(source),model);
  source.regions[0].hidden=true; assert.equal(buildSceneModel(source).floors.length,0);
});
test('反向重叠同厚墙只形成一个可选模型，保留别名且使用最高高度',()=>{
  const source=project(); source.walls.push({...source.walls[0],id:'alias',start:source.walls[0].end,end:source.walls[0].start,height:360});
  const model=buildSceneModel(source);
  assert.equal(model.walls.length,4);
  const top=model.walls.find(w=>w.sourceIds.includes('top'));
  assert.deepEqual(top.sourceIds,['alias','top']);
  assert.equal(top.size.height,3.6);
});
test('非法墙高和同编号不同高度拒绝，旧几何验证保持有效',()=>{
  const wall=rectangle()[0];
  for(const height of [0,49,1001,NaN,Infinity,-10,'280']) assert.throws(()=>normalizeWalls([{...wall,height}]),/墙高/);
  assert.throws(()=>normalizeWalls([wall,{...wall,height:300}]),/编号/);
  assert.equal(normalizeWalls([{...wall,height:50}])[0].height,50);
  assert.equal(normalizeWalls([{...wall,height:1000}])[0].height,1000);
  const source=project(); source.wallHeight=Infinity; assert.throws(()=>buildSceneModel(source),/默认墙高/);
});
test('栅格区域必须已校准，三维地面使用真实比例而非预估墙体',()=>{
  const source=project(); source.walls=[]; source.drawing.type='jpg';source.calibration.metersPerPixel=null;
  assert.throws(()=>buildSceneModel(source),/校准/);
  source.calibration.metersPerPixel=.02;
  const model=buildSceneModel(source); assert.equal(model.walls.length,0);close(xzArea(model.floors[0].points),42.56);
  source.calibration.metersPerPixel=1e308;assert.throws(()=>buildSceneModel(source),/有效范围/);
  source.calibration.metersPerPixel=.02;
  source.regions[0].points[0].x=NaN;assert.throws(()=>buildSceneModel(source),/无效/);
});
test('空工程范围无虚构墙体，模型边界包含墙体端帽',()=>{
  const source=project(), model=buildSceneModel(source);
  close(model.bounds.min.x,1.9);close(model.bounds.min.z,1.9);close(model.bounds.max.x,6.1);close(model.bounds.max.z,5.1);
  source.walls=[];source.regions=[];const empty=buildSceneModel(source);
  assert.deepEqual(empty.bounds,{min:{x:0,y:0,z:0},max:{x:0,y:0,z:0},center:{x:0,y:0,z:0},size:{x:0,y:0,z:0}});
  assert.deepEqual(empty.walls,[]);assert.deepEqual(empty.floors,[]);
});
test('门窗实体厚度超过墙厚时，相机边界仍包含实际突出部分',()=>{
  const source=project();source.openings=[{id:'door',wallId:'top',kind:'door',shape:'rectangle',offset:100,bottom:0,width:90,height:210,depth:100}];
  const model=buildSceneModel(source);close(model.bounds.min.z,1.5);
  for(const insert of model.inserts)for(const surface of insert.surfaces)for(const point of surface.points)for(const axis of ['x','y','z'])assert.ok(point[axis]>=model.bounds.min[axis]-1e-9&&point[axis]<=model.bounds.max[axis]+1e-9);
});

test('任意方向墙模型按真实角度旋转，场景边界由实际棱柱而非轴对齐替代面组成',()=>{
  const source=project();source.regions=[];source.walls=[{id:'diagonal',start:{x:200,y:200},end:{x:440,y:520},thickness:20,height:300}];
  const model=buildSceneModel(source),wall=model.walls[0];
  close(wall.rotationY,-Math.atan2(320,240));close(wall.size.length,4.2);close(wall.size.height,3);
  assert.deepEqual(wall.position,{x:3.2,y:1.5,z:3.6});
  close(model.bounds.min.x,1.86);close(model.bounds.max.x,4.54);close(model.bounds.min.z,1.86);close(model.bounds.max.z,5.34);
  assert.equal(model.surfaces.length,6);
  for(const surface of model.surfaces)for(const point of surface.points)for(const axis of ['x','y','z'])assert.ok(point[axis]>=model.bounds.min[axis]-1e-9&&point[axis]<=model.bounds.max[axis]+1e-9);
});

test('旋转净房间与门扇突出厚度同时进入实际场景范围，缩放不改变几何',()=>{
  const source=project(),angle=.63,c=Math.cos(angle),s=Math.sin(angle),rotate=point=>({x:point.x*c-point.y*s,y:point.x*s+point.y*c});
  source.walls=source.walls.map(wall=>({...wall,start:rotate(wall.start),end:rotate(wall.end)}));
  source.regions=source.regions.map(region=>({...region,points:region.points.map(rotate),holes:region.holes.map(hole=>hole.map(rotate))}));
  source.openings=[{id:'door',wallId:'top',kind:'door',shape:'rectangle',offset:100,bottom:0,width:90,height:210,depth:100}];
  const model=buildSceneModel(source);close(xzArea(model.floors[0].points),10.64);
  for(const insert of model.inserts)for(const surface of insert.surfaces)for(const point of surface.points)for(const axis of ['x','y','z'])assert.ok(point[axis]>=model.bounds.min[axis]-1e-9&&point[axis]<=model.bounds.max[axis]+1e-9);
  source.view.zoom=3;assert.deepEqual(buildSceneModel(source),model);
});
