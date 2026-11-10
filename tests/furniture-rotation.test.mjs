import test from 'node:test';
import assert from 'node:assert/strict';
import {rotationFromPointer,rotationHandle,normalizedRotation} from '../static/studio/lib/furniture-rotation.js';
test('free rotation follows pointer angle, wraps zero and optionally snaps by 15 degrees',()=>{
  const c={x:500,y:400},start={x:500,y:300};
  assert.equal(rotationFromPointer(c,start,{x:600,y:400},0),90);
  assert.equal(rotationFromPointer(c,start,{x:400,y:400},0),270);
  assert.equal(rotationFromPointer(c,start,{x:600,y:300},350),35);
  const a=37.27*Math.PI/180,p={x:500+100*Math.sin(a),y:400-100*Math.cos(a)};
  assert.equal(rotationFromPointer(c,start,p,0),37.27);
  assert.equal(rotationFromPointer(c,start,p,0,true),30);
  assert.equal(normalizedRotation(-720.5),359.5);
  assert.equal(rotationFromPointer(c,start,c,15),15);
  assert.throws(()=>rotationFromPointer(c,start,{x:NaN,y:0},0));
});
test('rotation handle respects true dimensions, current rotation and screen-pixel spacing',()=>{
  const item={position:{x:300,y:400},depth:100,rotation:0},project={drawing:{type:'plan'},calibration:{metersPerPixel:.01}};
  assert.deepEqual(rotationHandle(item,project,2),{x:300,y:336});
  const right=rotationHandle({...item,rotation:90},project,2);
  assert.ok(Math.abs(right.x-364)<1e-8&&Math.abs(right.y-400)<1e-8);
});
