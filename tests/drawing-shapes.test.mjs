import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCircle, makeArc, circleFromPoints, arcThroughPoints } from '../build/studio/lib/drawing-shapes.js';
import { polygonArea } from '../build/studio/lib/geometry.js';

const near = (actual,expected,tolerance=1e-8) => assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
test('circle samples real centimetre coordinates with bounded sagitta and disclosed exact/chord lengths',()=>{
  const circle=makeCircle({x:50,y:-20},300),n=circle.segmentCount;
  assert.equal(n,72);assert.equal(circle.points.length,n);assert.equal(circle.closed,true);
  assert.notDeepEqual(circle.points[0],circle.points.at(-1));
  circle.points.forEach(p=>near(Math.hypot(p.x-50,p.y+20),300));
  near(circle.exactLength,2*Math.PI*300);near(circle.polylineLength,n*600*Math.sin(Math.PI/n));
  near(circle.maxDeviation,300*(1-Math.cos(Math.PI/n)));assert.ok(circle.maxDeviation<=.5);
  near(polygonArea(circle.points),n/2*300**2*Math.sin(2*Math.PI/n),1e-6);
  assert.ok(circle.lengthError>0);near(circle.lengthError,circle.exactLength-circle.polylineLength);
});
test('arc positive direction follows plan Y and wraps through zero without changing sweep',()=>{
  const arc=makeArc({x:0,y:0},200,350,20);
  assert.equal(arc.closed,false);assert.equal(arc.points.length,arc.segmentCount+1);
  near(arc.points[0].x,200*Math.cos(350*Math.PI/180));near(arc.points.at(-1).y,200*Math.sin(10*Math.PI/180));
  near(arc.exactLength,200*20*Math.PI/180);assert.ok(arc.maxDeviation<=.5);
  const reverse=makeArc({x:0,y:0},200,10,-20);
  near(reverse.points.at(-1).x,arc.points[0].x);near(reverse.points.at(-1).y,arc.points[0].y);
});
test('three-point circumcircle preserves the clicked through point and selects a major arc when required',()=>{
  const start={x:100,y:0},through={x:0,y:-100},end={x:0,y:100};
  const arc=arcThroughPoints(start,through,end);
  near(arc.center.x,0);near(arc.center.y,0);near(arc.radius,100);near(arc.sweepDegrees,-270);
  assert.deepEqual(arc.points[0],start);assert.deepEqual(arc.points.at(-1),end);
  assert.ok(arc.points.some(p=>p.x===through.x&&p.y===through.y));
  const angle=31*Math.PI/180,irregular=arcThroughPoints(start,{x:100*Math.cos(angle),y:100*Math.sin(angle)},end);
  near(irregular.sweepDegrees,90);assert.equal(irregular.segmentCount,19);
  assert.ok(irregular.maxDeviation<=.5);
});
test('two-point circle and stricter sampling are pure and deterministic',()=>{
  const center={x:300,y:400},edge={x:300,y:600},before=structuredClone({center,edge});
  const circle=circleFromPoints(center,edge,{maxStepDegrees:2.5});
  assert.equal(circle.radius,200);assert.equal(circle.segmentCount,144);
  assert.deepEqual({center,edge},before);assert.deepEqual(circle,circleFromPoints(center,edge,{maxStepDegrees:2.5}));
});
test('invalid points, collinear arcs, short wall chords and exceeded budgets fail completely',()=>{
  for(const operation of [()=>makeCircle({x:0,y:0},0),()=>makeCircle({x:0,y:0},10),()=>makeCircle({x:0,y:0},5000),
    ()=>makeCircle({x:0,y:0},200,{maxSegments:50}),()=>makeArc({x:0,y:0},200,0,360),()=>makeArc({x:0,y:0},100,0,.1),
    ()=>arcThroughPoints({x:0,y:0},{x:10,y:0},{x:20,y:0}),()=>arcThroughPoints({x:0,y:0},{x:0,y:0},{x:20,y:0}),
    ()=>makeCircle({x:Infinity,y:0},100),()=>makeCircle({x:1e6,y:0},100),()=>makeCircle({x:0,y:0},100,{chordErrorCm:1})]) assert.throws(operation,RangeError);
});
