import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanBoundary, segmentWithinBoundary, validateRegionWithinBoundary, validateWallsWithinBoundary, validateProjectBoundary } from '../build/studio/lib/plan-boundary.js';
import { wallFootprints } from '../build/studio/lib/wall-joins.js';
import { makeCircle } from '../build/studio/lib/drawing-shapes.js';

const rectangle=(x0,y0,x1,y1)=>[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
const boundary={points:rectangle(0,0,100,100)};
const wall=(extra={})=>({id:'wall',start:{x:10,y:50},end:{x:90,y:50},thickness:20,height:280,...extra});
test('boundary accepts simple rectangular/concave rings and rejects invalid imported geometry',()=>{
  assert.equal(validatePlanBoundary(boundary).valid,true);assert.equal(validatePlanBoundary(null).valid,true);
  for(const points of [[{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}],rectangle(0,0,100,100).concat([{x:0,y:0}]),[{x:NaN,y:0},{x:1,y:0},{x:0,y:1}],[]]) assert.equal(validatePlanBoundary({points}).valid,false);
});
test('entire segments are checked across a concave notch even when both endpoints are inside',()=>{
  const notch={points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:70,y:100},{x:70,y:30},{x:30,y:30},{x:30,y:100},{x:0,y:100}]};
  assert.equal(segmentWithinBoundary({x:10,y:80},{x:90,y:80},notch),false);
  assert.equal(segmentWithinBoundary({x:10,y:20},{x:90,y:20},notch),true);
  assert.equal(segmentWithinBoundary({x:0,y:0},{x:100,y:0},notch),true);
  const bridge={points:rectangle(10,70,90,90),holes:[]};
  const result=validateRegionWithinBoundary(bridge,notch);assert.equal(result.valid,false);assert.ok(Math.abs(result.outsideArea-800)<1e-7);
});
test('polygon area intersection catches a boundary notch enclosed inside a shape with all vertices inside',()=>{
  const notch={points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:51,y:100},{x:51,y:40},{x:49,y:40},{x:49,y:100},{x:0,y:100}]};
  const result=validateRegionWithinBoundary({points:rectangle(10,10,90,90),holes:[]},notch);
  assert.equal(result.valid,false);assert.ok(Math.abs(result.outsideArea-100)<1e-7);
});
test('wall thickness and legacy square caps are checked, including exact boundary contact',()=>{
  assert.equal(validateWallsWithinBoundary([wall()],boundary).valid,true);
  const cap=wall({start:{x:0,y:50},end:{x:100,y:50}});
  assert.equal(validateWallsWithinBoundary([cap],boundary).valid,false);
  assert.equal(validateWallsWithinBoundary([cap],boundary,wallFootprints([cap],'clean')).valid,true);
  assert.equal(validateWallsWithinBoundary([wall({start:{x:10,y:5},end:{x:90,y:5}})],boundary).valid,false);
});
test('project boundary uses actual clean physical footprints and rejects a proposed limit without mutating geometry',()=>{
  const project={wallJoinStyle:'clean',walls:[wall({start:{x:0,y:50},end:{x:100,y:50}})],regions:[],planBoundary:boundary},before=structuredClone(project);
  assert.equal(validateProjectBoundary(project).valid,true);assert.deepEqual(project,before);
  const rejected=validateProjectBoundary({...project,planBoundary:{points:rectangle(0,0,99,100)}});
  assert.equal(rejected.valid,false);assert.equal(rejected.wallId,'wall');assert.deepEqual(project,before);
  assert.equal(validateProjectBoundary({...project,wallJoinStyle:'square'}).valid,false);
});
test('rotated physical walls and complete sampled circles are rejected rather than partially clipped',()=>{
  const diagonal=wall({start:{x:10,y:10},end:{x:90,y:90}});
  assert.equal(validateProjectBoundary({walls:[diagonal],wallJoinStyle:'clean',regions:[],planBoundary:boundary}).valid,true);
  const circle=makeCircle({x:100,y:100},80),walls=circle.points.map((p,i)=>wall({id:String(i),start:p,end:circle.points[(i+1)%circle.points.length],thickness:10}));
  const full={walls,wallJoinStyle:'clean',regions:[],planBoundary:{points:rectangle(0,0,200,200)}};
  assert.equal(validateProjectBoundary(full).valid,true);
  assert.equal(validateProjectBoundary({...full,planBoundary:{points:rectangle(0,0,180,200)}}).valid,false);
  assert.equal(walls.length,circle.segmentCount);
});
test('regions and holes are validated without silently deleting existing hidden or visible content',()=>{
  assert.equal(validateProjectBoundary({walls:[],regions:[{id:'r',points:rectangle(10,10,90,90),holes:[rectangle(20,20,40,40)]}],planBoundary:boundary}).valid,true);
  const result=validateProjectBoundary({walls:[],regions:[{id:'r',points:rectangle(10,10,110,90),holes:[],hidden:true}],planBoundary:boundary});
  assert.equal(result.valid,false);assert.equal(result.regionId,'r');
});
test('rotated furniture uses its real footprint and a smaller boundary is rejected atomically, including hidden furniture',()=>{
  const furniture={id:'chair',name:'家具',kind:'custom',position:{x:50,y:50},width:80,depth:20,height:80,rotation:45,quantity:'1',unitPrice:'',additionalCost:'0',hidden:true};
  const project={drawing:{type:'plan'},calibration:{metersPerPixel:null},walls:[],regions:[],furniture:[furniture],planBoundary:boundary},before=structuredClone(project);
  assert.equal(validateProjectBoundary(project).valid,true);
  const moved=validateProjectBoundary({...project,furniture:[{...furniture,position:{x:80,y:50}}]});
  assert.equal(moved.valid,false);assert.equal(moved.furnitureId,'chair');assert.ok(moved.outsideArea>0);
  assert.equal(validateProjectBoundary({...project,planBoundary:{points:rectangle(0,0,75,100)}}).valid,false);assert.deepEqual(project,before);
  assert.equal(validateProjectBoundary({...project,drawing:{type:'image'},furniture:[{...furniture,position:{x:80,y:50}}]}).valid,true,'uncalibrated images must not invent a real furniture footprint');
});
