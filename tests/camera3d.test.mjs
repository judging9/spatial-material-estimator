import test from 'node:test';
import assert from 'node:assert/strict';
import { multiply4, perspective4, lookAt4, inverse4, transform4, screenRay, rayBox, rayTriangle, triangulateXZ, pointInRingXZ, floorLabelData } from '../static/studio/lib/camera3d.js';

const close=(a,b,tolerance=1e-5)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const p=(x,z,y=0)=>({x,y,z});
const triangleArea=(a,b,c)=>Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))/2;

test('camera projection and unprojection round trip; centre ray meets target',()=>{
  const eye={x:6,y:8,z:10},target={x:2,y:0,z:3};
  const vp=multiply4(perspective4(Math.PI/4,1.5,.01,1000),lookAt4(eye,target));
  const identity=multiply4(vp,inverse4(vp));
  identity.forEach((value,index)=>close(value,index%5===0?1:0,1e-4));
  const projected=transform4(vp,[target.x,target.y,target.z,1]);
  close(projected[0]/projected[3],0);close(projected[1]/projected[3],0);
  const ray=screenRay(600,400,1200,800,vp);
  const distance=(target.y-ray.origin.y)/ray.direction.y;
  close(ray.origin.x+ray.direction.x*distance,target.x);
  close(ray.origin.z+ray.direction.z*distance,target.z);
  assert.throws(()=>inverse4(new Float32Array(16)),/Singular/);
  assert.throws(()=>perspective4(0,1,.1,10),/Invalid/);
});

test('oriented wall box picking observes height, thickness, and yaw',()=>{
  const size={x:6,y:3,z:.2},center={x:0,y:1.5,z:0};
  close(rayBox({x:3,y:1,z:2},{x:-1,y:0,z:0},center,size,-Math.PI/2),2.9);
  assert.equal(rayBox({x:3,y:1,z:4},{x:-1,y:0,z:0},center,size,-Math.PI/2),null);
  assert.equal(rayBox({x:0,y:4,z:5},{x:0,y:0,z:-1},center,size),null);
  assert.equal(rayBox({x:0,y:1,z:0},{x:1,y:0,z:0},center,size),0);
  close(rayBox({x:0,y:1,z:5},{x:0,y:0,z:-1},center,size),4.9);
});

test('floor ray intersection is double sided and rejects misses',()=>{
  const a=p(0,0),b=p(4,0),c=p(0,4);
  close(rayTriangle(p(1,1,3),{x:0,y:-1,z:0},a,b,c),3);
  close(rayTriangle(p(1,1,-3),{x:0,y:1,z:0},a,b,c),3);
  assert.equal(rayTriangle(p(3,3,3),{x:0,y:-1,z:0},a,b,c),null);
  assert.equal(rayTriangle(p(1,1,3),{x:1,y:0,z:0},a,b,c),null);
});

test('concave triangulation conserves area and keeps the concavity empty',()=>{
  const points=[p(0,0),p(4,0),p(4,1),p(1,1),p(1,4),p(0,4)];
  for(const ring of [points,[...points].reverse()]){
    const indices=triangulateXZ(ring);assert.equal(indices.length,12);
    let area=0;
    for(let i=0;i<indices.length;i+=3){const triangle=indices.slice(i,i+3).map(index=>ring[index]);area+=triangleArea(...triangle);assert.equal(rayTriangle(p(2,2,1),{x:0,y:-1,z:0},...triangle),null);}
    close(area,7);
  }
});

test('collinear vertices triangulate without fake fan fallback; invalid rings fail',()=>{
  const ring=[p(0,0),p(2,0),p(4,0),p(4,3),p(0,3)],indices=triangulateXZ(ring);
  let area=0;for(let i=0;i<indices.length;i+=3)area+=triangleArea(...indices.slice(i,i+3).map(index=>ring[index]));close(area,12);
  assert.throws(()=>triangulateXZ([p(0,0),p(2,2),p(0,2),p(2,0)]),/Invalid floor polygon/);
  assert.throws(()=>triangulateXZ([p(0,0),p(1,0)]),/Invalid floor polygon/);
});

test('hole membership is independent of polygon winding',()=>{
  const hole=[p(1,1),p(3,1),p(3,3),p(1,3)];
  assert.equal(pointInRingXZ(p(2,2),hole),true);
  assert.equal(pointInRingXZ(p(2,2),[...hole].reverse()),true);
  assert.equal(pointInRingXZ(p(.5,2),hole),false);
});

test('floor labels use measured net area and stay within concave floors outside holes',()=>{
  const concave={points:[p(0,0),p(4,0),p(4,1),p(1,1),p(1,4),p(0,4)],holes:[]};
  const label=floorLabelData(concave);close(label.netArea,7);assert.ok(pointInRingXZ(label.point,concave.points));
  const courtyard={points:[p(0,0),p(8,0),p(8,8),p(0,8)],holes:[[p(2,2),p(6,2),p(6,6),p(2,6)]]};
  const holeLabel=floorLabelData(courtyard);close(holeLabel.netArea,48);assert.ok(pointInRingXZ(holeLabel.point,courtyard.points));assert.equal(pointInRingXZ(holeLabel.point,courtyard.holes[0]),false);
  assert.equal(floorLabelData({points:[p(0,0),p(1,0)],holes:[]}),null);
});
