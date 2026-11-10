import test from 'node:test';
import assert from 'node:assert/strict';
import { changeWallDimensions } from '../static/studio/wall-editor.js';
import { detectPlanRooms } from '../static/studio/lib/wall-plan.js';
import { polygonArea } from '../static/studio/lib/geometry.js';

const fixture = () => [
  { id:'top', start:{x:200,y:200}, end:{x:600,y:200}, thickness:20 },
  { id:'right', start:{x:600,y:200}, end:{x:600,y:500}, thickness:20 },
  { id:'bottom', start:{x:600,y:500}, end:{x:200,y:500}, thickness:20 },
  { id:'left', start:{x:200,y:500}, end:{x:200,y:200}, thickness:20 },
];
test('修改墙长移动相连墙体并保持闭合，实际净面积与新尺寸一致',()=>{
  const walls = changeWallDimensions(fixture(),'top',5,20);
  assert.equal(walls[1].end.x,700);
  assert.equal(walls[2].start.x,700);
  const rooms=detectPlanRooms(walls);
  assert.equal(rooms.length,1);
  assert.equal(polygonArea(rooms[0].points)/10000,13.44);
  assert.equal(fixture()[0].end.x,600);
});
test('尺寸变化保留分隔墙的T连接与房间数',()=>{
  const walls=fixture(); walls.push({id:'divider',start:{x:400,y:350},end:{x:600,y:350},thickness:20});
  walls.push({id:'middle',start:{x:400,y:200},end:{x:400,y:500},thickness:20});
  const edited=changeWallDimensions(walls,'top',5,20);
  assert.equal(edited[4].end.x,700);
  assert.equal(detectPlanRooms(edited).length,3);
});
test('固定终点编辑可保留另一端相连边界；非法尺寸不写入',()=>{
  const walls=changeWallDimensions(fixture(),'top',3,30,'end');
  assert.equal(walls[0].start.x,300);
  assert.equal(walls[3].start.x,300);
  assert.equal(detectPlanRooms(walls).length,1);
  assert.throws(()=>changeWallDimensions(fixture(),'top',0,20),/有效/);
});

const rotate=(walls,angle)=>{
  const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a),p=q=>({x:q.x*c-q.y*s,y:q.x*s+q.y*c});
  return walls.map(w=>({...w,start:p(w.start),end:p(w.end)}));
};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('斜墙改长度保持当前单位方向和闭合连接，不把dx/dy符号当方向',()=>{
  const original=rotate(fixture(),35),before=structuredClone(original);
  const edited=changeWallDimensions(original,'top',5,20);
  near(Math.hypot(edited[0].end.x-edited[0].start.x,edited[0].end.y-edited[0].start.y),500);
  near(Math.atan2(edited[0].end.y-edited[0].start.y,edited[0].end.x-edited[0].start.x),35*Math.PI/180);
  assert.deepEqual(edited[0].end,edited[1].start);assert.deepEqual(edited[1].end,edited[2].start);
  near(polygonArea(detectPlanRooms(edited)[0].points)/10000,13.44);assert.deepEqual(original,before);
});
test('旋转墙网的T连接点随相连直墙平移，房间数仍为三',()=>{
  const walls=fixture();walls.push({id:'divider',start:{x:400,y:350},end:{x:600,y:350},thickness:20},{id:'middle',start:{x:400,y:200},end:{x:400,y:500},thickness:20});
  const angled=rotate(walls,27),edited=changeWallDimensions(angled,'top',5,20);
  const oldDistance=Math.hypot(angled[4].end.x-angled[4].start.x,angled[4].end.y-angled[4].start.y);
  near(Math.hypot(edited[4].end.x-edited[4].start.x,edited[4].end.y-edited[4].start.y),oldDistance+100);
  assert.equal(detectPlanRooms(edited).length,3);
});
test('显式方向角以起点朝终点为准，固定终点时长度与角度均正确',()=>{
  const start=changeWallDimensions(fixture(),'top',4,20,'start',30);
  near(start[0].end.x,200+400*Math.cos(Math.PI/6));near(start[0].end.y,200+400*Math.sin(Math.PI/6));
  assert.deepEqual(start[0].end,start[1].start);assert.equal(detectPlanRooms(start).length,1);
  const end=changeWallDimensions(fixture(),'top',4,20,'end',30);
  assert.deepEqual(end[0].end,{x:600,y:200});near(end[0].start.x,600-400*Math.cos(Math.PI/6));near(end[0].start.y,200-400*Math.sin(Math.PI/6));
  assert.deepEqual(end[0].start,end[3].end);assert.equal(detectPlanRooms(end).length,1);
  assert.throws(()=>changeWallDimensions(fixture(),'top',4,20,'start',NaN),/方向角/);
  assert.throws(()=>changeWallDimensions(fixture(),'top',4,20,'start',361),/方向角/);
});

test('提交未修改的长度与方向仅改墙高时，所有点坐标和净房间严格不变',()=>{
  const original=fixture();original[0].end.x=700;original[1].start.x=700;original[1].end.x=700;original[2].start.x=700;
  const prior=detectPlanRooms(original);
  const resized=changeWallDimensions(original,'bottom',5,20,'start',180);
  assert.deepEqual(resized,original);assert.deepEqual(detectPlanRooms(resized.map(w=>w.id==='bottom'?{...w,height:350}:w)),prior);
  const angled=rotate(original,37.123456789),selected=angled[2];
  const length=Number((Math.hypot(selected.end.x-selected.start.x,selected.end.y-selected.start.y)/100).toFixed(4));
  const angle=Number(((Math.atan2(selected.end.y-selected.start.y,selected.end.x-selected.start.x)*180/Math.PI+360)%360).toFixed(6));
  const unchanged=changeWallDimensions(angled,'bottom',length,20,'start',angle);
  assert.deepEqual(unchanged,angled);assert.deepEqual(detectPlanRooms(unchanged),detectPlanRooms(angled));
  const exact=changeWallDimensions(angled,'bottom',Math.hypot(selected.end.x-selected.start.x,selected.end.y-selected.start.y)/100,20);
  assert.deepEqual(exact,angled);
  const turned=changeWallDimensions(fixture(),'top',4,20,'start',180);
  assert.equal(turned[0].end.y,200);assert.equal(turned[0].end.x,-200);
});
