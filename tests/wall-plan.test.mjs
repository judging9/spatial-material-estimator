import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlanRooms, normalizeWalls, snapWallPoint, wallFootprint } from '../static/studio/lib/wall-plan.js';
import { polygonArea, validateRegion, intersectionArea, pointInRegion } from '../static/studio/lib/geometry.js';

const wall = (id, start, end, thickness = 20) => ({ id, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, thickness });
const rectangle = (x = 0, y = 0, width = 400, height = 300, prefix = 'outer') => [
  wall(`${prefix}-top`,[x,y],[x+width,y]), wall(`${prefix}-right`,[x+width,y],[x+width,y+height]),
  wall(`${prefix}-bottom`,[x+width,y+height],[x,y+height]), wall(`${prefix}-left`,[x,y+height],[x,y])
];
const area = room => (polygonArea(room.points) - room.holes.reduce((sum, hole) => sum + polygonArea(hole), 0)) / 10000;
const approximately = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} != ${expected}`);

test('400×300cm中心线矩形扣除20cm墙厚，真实净面积为10.64m²', () => {
  const rooms = detectPlanRooms(rectangle());
  assert.equal(rooms.length,1);
  approximately(area(rooms[0]),10.64);
  assert.equal(polygonArea(rooms[0].centerlinePoints)/10000,12);
  assert.ok(rooms[0].points.every(point=>point.x>=10 && point.x<=390 && point.y>=10 && point.y<=290));
});

test('T接点分隔墙形成三个净房间，不重复计算共墙', () => {
  const walls = [...rectangle(0,0,800,600), wall('vertical',[400,0],[400,600]), wall('tee',[400,300],[800,300])];
  const rooms = detectPlanRooms(walls);
  assert.equal(rooms.length,3);
  const areas=rooms.map(area).sort((a,b)=>a-b);
  approximately(areas[0],10.64); approximately(areas[1],10.64); approximately(areas[2],22.04);
  for(const [index,room] of rooms.entries()) assert.equal(validateRegion({...room,id:room.key},rooms.slice(0,index).map(other=>({...other,id:other.key}))).valid,true);
});

test('内部分隔墙交叉形成四个房间', () => {
  const rooms=detectPlanRooms([...rectangle(0,0,800,600),wall('vertical',[400,0],[400,600]),wall('horizontal',[0,300],[800,300])]);
  assert.equal(rooms.length,4);
  rooms.forEach(room=>approximately(area(room),10.64));
});

test('重复和反向共墙保留一个几何占地', () => {
  const walls=rectangle();
  const duplicate=walls.map(w=>({...w,id:w.id+'-duplicate',start:w.end,end:w.start}));
  const rooms=detectPlanRooms([...walls,...duplicate]);
  assert.equal(rooms.length,1);approximately(area(rooms[0]),10.64);
  assert.equal(normalizeWalls([...walls,{...walls[0],start:walls[0].end,end:walls[0].start}]).length,4);
});

test('断开边界及真实小断口不产生伪造房间', () => {
  const walls=rectangle();
  assert.deepEqual(detectPlanRooms(walls.slice(0,3)),[]);
  walls[3]={...walls[3],end:{x:0,y:2}};
  assert.deepEqual(detectPlanRooms(walls),[]);
});

test('独立内圈扩为扣除孔洞，内圈自身缩为净房间', () => {
  const rooms=detectPlanRooms([...rectangle(0,0,800,600),...rectangle(200,200,200,100,'inner')]);
  assert.equal(rooms.length,2);
  const outer=rooms.find(room=>room.holes.length);
  const inner=rooms.find(room=>!room.holes.length);
  assert.ok(outer);approximately(area(outer),42.6);approximately(area(inner),1.44);
});

test('正交L形房间保持凹口并正确扣除边界半墙厚', () => {
  const points=[[0,0],[600,0],[600,300],[300,300],[300,600],[0,600]];
  const rooms=detectPlanRooms(points.map((start,i)=>wall('l-'+i,start,points[(i+1)%points.length])));
  assert.equal(rooms.length,1);approximately(area(rooms[0]),24.64);
  assert.equal(rooms[0].points.length,6);
});

test('不同边墙厚按各边半厚扣除；极窄净空间不能反向假算', () => {
  const walls=rectangle();walls[0].thickness=40;
  approximately(area(detectPlanRooms(walls)[0]),10.26);
  assert.throws(()=>detectPlanRooms(rectangle(0,0,15,300)),/墙厚|净尺寸/);
});

test('内墙死端和同一直边墙厚突变明确拒绝，不能沿用中心线面积', () => {
  assert.throws(()=>detectPlanRooms([...rectangle(),wall('stub',[200,0],[200,150])]),/未闭合墙段|墙厚/);
  const walls=rectangle().filter(w=>w.id!=='outer-top');
  walls.push(wall('top1',[0,0],[200,0]),wall('top2',[200,0],[400,0],40));
  assert.throws(()=>detectPlanRooms(walls),/厚度不同|墙厚/);
});

test('墙数据允许任意方向直墙，拒绝负厚度、非有限点、短段和冲突编号且不改输入', () => {
  const walls=rectangle();const before=structuredClone(walls);normalizeWalls(walls);assert.deepEqual(walls,before);
  assert.deepEqual(normalizeWalls([wall('diagonal',[0,0],[100,100])])[0].end,{x:100,y:100});
  assert.throws(()=>normalizeWalls([wall('negative',[0,0],[100,0],-1)]),/墙厚/);
  assert.throws(()=>normalizeWalls([wall('bad',[NaN,0],[100,0])]),/有限数字/);
  assert.throws(()=>normalizeWalls([wall('short',[0,0],[.1,0])]),/长度/);
  assert.throws(()=>normalizeWalls([wall('same',[0,0],[100,0]),wall('same',[0,0],[200,0])]),/编号/);
});

const rotate = (walls, degrees, offset = {x:0,y:0}) => {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const point = p => ({x:offset.x+p.x*c-p.y*s,y:offset.y+p.x*s+p.y*c});
  return walls.map(w=>({...w,start:point(w.start),end:point(w.end)}));
};
const ringWalls = (points,prefix='angled') => points.map((start,i)=>wall(prefix+i,start,points[(i+1)%points.length]));
const clearFloor = (rooms,walls) => {
  for (const [index,room] of rooms.entries()) {
    assert.equal(validateRegion({...room,id:room.key},rooms.slice(0,index).map(r=>({...r,id:r.key}))).valid,true);
    walls.forEach(w=>assert.ok(intersectionArea(room,wallFootprint(w))<1e-5));
  }
};

test('任意旋转的400×300cm矩形净面积仍为10.64m²，正向反向与平移均一致',()=>{
  for (const angle of [13,30,45,73,123,271]) {
    const walls=rotate(rectangle(),angle,{x:23456,y:-12345});
    const room=detectPlanRooms(walls)[0];approximately(area(room),10.64);clearFloor([room],walls);
    const reverse=detectPlanRooms([...walls].reverse().map(w=>({...w,start:w.end,end:w.start})))[0];
    assert.equal(reverse.key,room.key);approximately(area(reverse),10.64);
  }
});

test('斜三角房间按侧线半墙厚计算真实内切三角，不用外包矩形',()=>{
  const walls=ringWalls([[0,0],[600,0],[0,300]]);
  const rooms=detectPlanRooms(walls);assert.equal(rooms.length,1);
  const radius=(900-Math.hypot(600,300))/2;
  approximately(area(rooms[0]),9*(1-10/radius)**2);clearFloor(rooms,walls);
  assert.ok(area(rooms[0])<9);assert.equal(rooms[0].points.length,3);
});

test('旋转后的T接点及交叉分隔保持三个/四个不重叠净房间',()=>{
  const tee=[...rectangle(0,0,800,600),wall('vertical',[400,0],[400,600]),wall('tee',[400,300],[800,300])];
  const angled=rotate(tee,31);const rooms=detectPlanRooms(angled);assert.equal(rooms.length,3);
  const areas=rooms.map(area).sort((a,b)=>a-b);approximately(areas[0],10.64);approximately(areas[1],10.64);approximately(areas[2],22.04);clearFloor(rooms,angled);
  const cross=rotate([...rectangle(0,0,800,600),wall('vertical',[400,0],[400,600]),wall('horizontal',[0,300],[800,300])],37);
  const crossed=detectPlanRooms(cross);assert.equal(crossed.length,4);crossed.forEach(r=>approximately(area(r),10.64));clearFloor(crossed,cross);
});

test('斜分隔墙在未显式拆分的水平边界相交，准确生成两个三角净区域',()=>{
  const walls=[...rectangle(0,0,600,300),wall('diagonal-divider',[0,0],[600,300])];
  const rooms=detectPlanRooms(walls);assert.equal(rooms.length,2);
  const radius=(900-Math.hypot(600,300))/2;
  rooms.forEach(r=>approximately(area(r),9*(1-10/radius)**2));clearFloor(rooms,walls);
});

test('旋转内圈的实际方形端帽扣成孔洞，不重复扣面积或占用净地面',()=>{
  const outer=rectangle(0,0,1000,1000),inner=rotate(rectangle(0,0,200,100,'inner'),29,{x:300,y:300});
  const walls=[...outer,...inner],rooms=detectPlanRooms(walls);assert.equal(rooms.length,2);
  approximately(area(rooms.find(r=>r.holes.length)),93.4);approximately(area(rooms.find(r=>!r.holes.length)),1.44);clearFloor(rooms,walls);
});

test('斜梯形孔洞扣除超出普通miter的真实端帽，凹口也不留墙占地',()=>{
  const walls=[...rectangle(0,0,1000,1000),...ringWalls([[200,200],[600,200],[400,500],[200,500]],'inner')];
  const rooms=detectPlanRooms(walls);assert.equal(rooms.length,2);clearFloor(rooms,walls);
  const outer=rooms.find(r=>r.holes.length),capPoint={x:597,y:188};
  assert.ok(walls.some(w=>pointInRegion(capPoint,wallFootprint(w))));assert.equal(pointInRegion(capPoint,outer),false);
  const concave=ringWalls([[0,0],[600,0],[600,300],[300,200],[300,600],[0,600]],'concave');
  const concaveRooms=detectPlanRooms(concave);assert.equal(concaveRooms.length,1);clearFloor(concaveRooms,concave);
  const rotated=detectPlanRooms(rotate(concave,23))[0];approximately(area(rotated),area(concaveRooms[0]));
});

test('自由绘图通用点线磁吸，Shift兼容选项锁正交且不破坏斜墙线',()=>{
  const walls=[wall('slope',[0,0],[100,100])];
  assert.deepEqual(snapWallPoint({x:98,y:97},walls,1,{x:0,y:200},{orthogonal:false}),{x:100,y:100});
  const projected=snapWallPoint({x:43,y:46},walls,1,{x:0,y:200},{orthogonal:false});
  approximately(projected.x,44.5);approximately(projected.y,44.5);
  assert.deepEqual(snapWallPoint({x:34,y:55},[],1,{x:0,y:0},{orthogonal:false}),{x:30,y:60});
  assert.deepEqual(snapWallPoint({x:48,y:51},walls,1,{x:0,y:50},{orthogonal:true}),{x:50,y:50});
});

test('斜墙真实断口与内部死端仍明确拒绝，不自动填补几何',()=>{
  const walls=rotate(rectangle(),35),last=walls[3],length=Math.hypot(last.end.x-last.start.x,last.end.y-last.start.y);
  last.end.x+=(last.start.x-last.end.x)/length*.1;last.end.y+=(last.start.y-last.end.y)/length*.1;
  assert.deepEqual(detectPlanRooms(walls),[]);
  assert.throws(()=>detectPlanRooms(rotate([...rectangle(),wall('stub',[200,0],[200,150])],35)),/未闭合墙段|墙厚/);
  assert.throws(()=>detectPlanRooms(rotate(rectangle(0,0,15,300),35)),/墙厚|净尺寸/);
});

test('端点和墙段吸附支持8屏幕像素半径，绘制始终水平或垂直', () => {
  const walls=rectangle();
  assert.deepEqual(snapWallPoint({x:397,y:3},walls,1),{x:400,y:0});
  assert.deepEqual(snapWallPoint({x:202,y:5},walls,1),{x:200,y:0});
  assert.deepEqual(snapWallPoint({x:397,y:106},walls,1,{x:200,y:100}),{x:400,y:100});
  assert.deepEqual(snapWallPoint({x:106,y:299},walls,1,{x:100,y:100}),{x:100,y:300});
  assert.deepEqual(snapWallPoint({x:34,y:55},[],1,{x:0,y:0}),{x:0,y:60});
  assert.deepEqual(snapWallPoint({x:34,y:25},[],1,{x:0,y:0}),{x:30,y:0});
});

test('房间key和净几何不依赖输入顺序、墙方向或平移', () => {
  const walls=rectangle();const first=detectPlanRooms(walls)[0];
  const reversed=detectPlanRooms([...walls].reverse().map(w=>({...w,start:w.end,end:w.start})))[0];
  assert.equal(first.key,reversed.key);approximately(area(reversed),10.64);
  const moved=detectPlanRooms(walls.map(w=>({...w,start:{x:w.start.x+2000,y:w.start.y-1000},end:{x:w.end.x+2000,y:w.end.y-1000}})))[0];
  assert.equal(first.key,moved.key);approximately(area(moved),10.64);
});
