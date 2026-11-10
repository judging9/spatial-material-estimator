import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulateSurface, rayMesh, creaseSegments } from '../static/studio/lib/camera3d.js';
import { buildWallSolid } from '../static/studio/lib/wall-solid.js';

const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const wall={id:'wall',start:{x:0,y:0},end:{x:400,y:0},height:300,thickness:20};
const opening=(kind='hole',shape='rectangle')=>({id:'opening',wallId:'wall',kind,shape,offset:100,bottom:100,width:100,height:100,depth:4});
const hitSurfaces=(surfaces,origin,direction)=>surfaces.map(surface=>rayMesh(origin,direction,surface.points,triangulateSurface(surface.points,surface.normal))).filter(hit=>hit!==null);

test('vertical and tilted boundary polygons triangulate in their own plane',()=>{
  const points=[{x:2,y:0,z:0},{x:2,y:0,z:4},{x:2,y:1,z:4},{x:2,y:1,z:1},{x:2,y:4,z:1},{x:2,y:4,z:0}];
  const indices=triangulateSurface(points,{x:1,y:0,z:0});
  assert.equal(indices.length,12);
  close(rayMesh({x:5,y:.5,z:2},{x:-1,y:0,z:0},points,indices),3);
  assert.equal(rayMesh({x:5,y:2,z:2},{x:-1,y:0,z:0},points,indices),null);
  assert.throws(()=>triangulateSurface(points,{x:0,y:0,z:0}),/normal/);
});

test('coplanar surface fragments do not create a visible seam, even with split edge lengths',()=>{
  const square=(x0,y0,x1,y1)=>({normal:{x:0,y:0,z:1},points:[{x:x0,y:y0,z:0},{x:x1,y:y0,z:0},{x:x1,y:y1,z:0},{x:x0,y:y1,z:0}]});
  const lines=creaseSegments([square(0,0,1,2),square(1,0,2,1),square(1,1,2,2)]);
  for(let i=0;i<lines.length;i+=2){
    const a=lines[i],b=lines[i+1];
    assert.ok(a.x===0&&b.x===0||a.x===2&&b.x===2||a.y===0&&b.y===0||a.y===2&&b.y===2,'internal patch seam must not be outlined');
  }
  close(lines.reduce((sum,p,i)=>i%2?sum:sum+Math.hypot(p.x-lines[i+1].x,p.y-lines[i+1].y,p.z-lines[i+1].z),0),8);
});

test('ray picking follows the real rectangular and ellipse openings instead of the old solid box',()=>{
  for(const shape of ['rectangle','ellipse']){
    const solid=buildWallSolid({walls:[wall],openings:[opening('hole',shape)]});
    assert.equal(hitSurfaces(solid.surfaces,{x:1.5,y:1.5,z:2},{x:0,y:0,z:-1}).length,0);
    assert.ok(hitSurfaces(solid.surfaces,{x:.5,y:1.5,z:2},{x:0,y:0,z:-1}).length>0);
  }
});

test('door and window selection meshes have their requested physical depth',()=>{
  for(const kind of ['door','window']){
    const aperture={...opening(kind),bottom:kind==='door'?0:100,height:kind==='door'?210:100,depth:kind==='door'?4:8};
    const solid=buildWallSolid({walls:[wall],openings:[aperture]});
    const insert=solid.inserts[0];
    assert.equal(insert.kind,kind);close(insert.depth,aperture.depth/100);
    const z=insert.surfaces.flatMap(surface=>surface.points.map(point=>point.z));
    close(Math.max(...z)-Math.min(...z),aperture.depth/100);
    assert.ok(hitSurfaces(insert.surfaces,{x:1.5,y:1.5,z:2},{x:0,y:0,z:-1}).length>0);
  }
});
