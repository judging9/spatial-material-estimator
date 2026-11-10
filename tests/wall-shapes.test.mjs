import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCircle, makeArc, arcThroughPoints } from '../build/studio/lib/drawing-shapes.js';
import { validateWallShapes, shapeForWall, shapeWallMetrics, wallShapeMeasurementProject } from '../build/studio/lib/wall-shapes.js';
import { wallShapeSelection, projectWallShapeSelection, cancelSharedBoundary } from '../build/studio/lib/wall-shape-selection.js';
import { buildWallSolid } from '../build/studio/lib/wall-solid.js';
import { calculateProject, calculateRegion } from '../build/studio/lib/pricing.js';

const near=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);
const line=(extra={})=>({id:'material',materialId:'m',materialName:'墙面',unit:'m²',quantityMode:'area',quantity:'0',unitPrice:'2.675',wasteRate:'7',laborRate:'1.005',additionalCost:'0.005',...extra});
function fixture(geometry=makeCircle({x:500,y:500},200),items=[line()]) {
  const walls=geometry.points.slice(0,geometry.closed?undefined:-1).map((p,i)=>({id:'w'+i,start:{...p},end:{...geometry.points[(i+1)%geometry.points.length]},thickness:20,height:280,items:[],additionalCost:'0'}));
  const shape={id:'curve',kind:geometry.kind,name:'圆弧墙',wallIds:walls.map(w=>w.id),center:geometry.center,radius:geometry.radius,startDegrees:geometry.startDegrees,sweepDegrees:geometry.sweepDegrees,maxDeviation:geometry.maxDeviation,items,additionalCost:'0.005',finishSide:'both'};
  return {id:'project',name:'曲线测试',walls,wallShapes:[shape],regions:[],wallJoinStyle:'clean',drawing:{type:'plan'},calibration:{metersPerPixel:.01},additionalCost:'0.005',taxRate:'9'};
}

test('group metadata validates actual circumference, ordered chain and irregular three-point arc sampling',()=>{
  const circle=fixture(),before=structuredClone(circle);validateWallShapes(circle);assert.deepEqual(circle,before);
  assert.equal(shapeForWall(circle,'w0').id,'curve');assert.equal(shapeForWall(circle,'missing'),null);
  const r=200,a=31*Math.PI/180,arc=arcThroughPoints({x:r,y:0},{x:r*Math.cos(a),y:r*Math.sin(a)},{x:0,y:r});
  validateWallShapes(fixture(arc));
});
test('malformed geometry, duplicate ownership and member prices cannot invent an extra group quote',()=>{
  const mutations=[p=>p.wallShapes[0].radius++,p=>p.wallShapes[0].maxDeviation=0,p=>p.wallShapes[0].sweepDegrees=350,
    p=>p.wallShapes[0].wallIds.pop(),p=>p.wallShapes[0].wallIds[1]='missing',p=>p.walls[0].end.x++,
    p=>p.walls[0].items=[line()],p=>p.walls[0].additionalCost='1',p=>p.walls[0].height=300,
    p=>p.wallShapes.push({...structuredClone(p.wallShapes[0]),id:'second'}),p=>p.wallShapes[0].items[0].unitPrice='-1',p=>p.wallShapes[0].items[0].unitPrice='1e31'];
  for(const mutate of mutations){const p=fixture();mutate(p);assert.throws(()=>validateWallShapes(p),RangeError);}
});
test('closed circle perimeter cancels every internal vertical seam and uses the actual sampled side lengths',()=>{
  const geometry=makeCircle({x:500,y:500},200),project=fixture(geometry),solid=buildWallSolid(wallShapeMeasurementProject(project));
  const selection=wallShapeSelection(solid.surfaces,project.wallShapes[0].wallIds),measured=shapeWallMetrics(project.wallShapes[0],solid);
  near(measured.netArea,2*geometry.polylineLength/100*2.8);near(selection.area,measured.netArea);
  near(measured.perimeter,4*geometry.polylineLength/100);
  for(let i=0;i<selection.boundary.length;i+=2)near(selection.boundary[i].y,selection.boundary[i+1].y);
  const naive=solid.metrics.reduce((sum,m)=>sum+m.perimeter,0);assert.ok(naive>measured.perimeter+700,'per-segment vertical seams must not become priced perimeter');
  const projected=projectWallShapeSelection(solid.surfaces,project.wallShapes[0].wallIds);
  near(projected.area,measured.netArea);assert.ok(projected.segments.length>0);assert.ok(selection.surfaces.every(s=>['left','right'].includes(s.side)));
});
test('open arc retains only its four physical vertical side boundaries; left and right scope remain independent',()=>{
  const geometry=makeArc({x:0,y:0},200,0,90),project=fixture(geometry),solid=buildWallSolid(wallShapeMeasurementProject(project));
  const both=wallShapeSelection(solid.surfaces,project.wallShapes[0].wallIds,'both'),left=wallShapeSelection(solid.surfaces,project.wallShapes[0].wallIds,'left'),right=wallShapeSelection(solid.surfaces,project.wallShapes[0].wallIds,'right');
  near(both.perimeter,4*geometry.polylineLength/100+4*2.8);near(both.area,left.area+right.area);near(both.perimeter,left.perimeter+right.perimeter);
  assert.ok(left.surfaces.every(s=>s.side==='left'));assert.ok(right.surfaces.every(s=>s.side==='right'));
});
test('partial shared collinear boundaries split and cancel without losing an unmatched opening interval',()=>{
  const p=y=>({x:4,y,z:7});
  const remaining=cancelSharedBoundary([p(0),p(3),p(0),p(1),p(2),p(3)]);
  assert.equal(remaining.length,2);near(Math.min(remaining[0].y,remaining[1].y),1);near(Math.max(remaining[0].y,remaining[1].y),2);
});
test('shared edges still cancel when floating-point translation crosses a spatial hash boundary',()=>{
  const x=1+4.999e-9,p=(x,y)=>({x,y,z:7});
  assert.deepEqual(cancelSharedBoundary([p(x,0),p(x,3),p(x+2e-12,0),p(x+2e-12,3)]),[]);
  assert.equal(cancelSharedBoundary([p(x,0),p(x,3),p(x+1e-4,0),p(x+1e-4,3)]).length,4);
});
test('a real curved-wall opening reduces only actual sides and adds its true hole perimeter once',()=>{
  const project=fixture(),original=calculateProject(project).walls.find(w=>w.id==='curve');
  project.openings=[{id:'hole',wallId:'w0',kind:'hole',shape:'rectangle',offset:6,bottom:100,width:5,height:100,depth:20}];
  const group=calculateProject(project).walls.find(w=>w.id==='curve');
  near(original.netArea-group.netArea,.1);near(group.openingArea,.1);near(group.perimeter-original.perimeter,4.2);
  assert.equal(group.items.length,1);assert.equal(group.additionalCost,'0.01');
});
test('one group prices area, waste, labor and fixed costs once using the existing decimal rounding engine',()=>{
  const project=fixture(),before=structuredClone(project),quote=calculateProject(project),group=quote.walls.find(w=>w.id==='curve');
  assert.equal(quote.walls.length,project.walls.length+1);assert.ok(quote.walls.filter(w=>w.id!=='curve').every(w=>w.items.length===0&&w.total==='0.00'));
  const expected=calculateRegion({...project.wallShapes[0],points:[]},null,{metrics:()=>({netArea:group.netArea,perimeter:group.perimeter})});
  assert.equal(group.total,expected.total);assert.equal(group.materialCost,expected.materialCost);assert.equal(group.laborCost,expected.laborCost);
  assert.equal(group.additionalCost,'0.01');assert.equal(group.items[0].additionalCost,'0.01');assert.equal(quote.additionalCost,'0.03');
  assert.deepEqual(project,before);
});
test('manual quantity is independent from the number of chords; missing quantity remains pending',()=>{
  const project=fixture(undefined,[line({unit:'件',quantityMode:'manual',quantity:'3',unitPrice:'0.105',wasteRate:'0',laborRate:'0.005'})]);
  let quote=calculateProject(project),group=quote.walls.find(w=>w.id==='curve');
  assert.equal(group.materialCost,'0.32');assert.equal(group.laborCost,'0.02');assert.equal(quote.knownMaterialCost,'0.32');
  project.wallShapes[0].items[0].quantity='0';quote=calculateProject(project);assert.equal(quote.pending,true);assert.equal(quote.total,null);assert.match(quote.pendingReason,/数量/);
});
test('group side changes recalculate actual scope without charging unrelated straight walls twice',()=>{
  const project=fixture();project.taxRate='0';project.walls.push({id:'straight',start:{x:0,y:0},end:{x:300,y:0},thickness:20,height:280,items:[line({id:'straight-price',unitPrice:'1',wasteRate:'0',laborRate:'0',additionalCost:'0'})]});
  const both=calculateProject(project);project.wallShapes[0].finishSide='left';const left=calculateProject(project);project.wallShapes[0].finishSide='right';const right=calculateProject(project);
  near(both.walls.find(w=>w.id==='curve').netArea,left.walls.find(w=>w.id==='curve').netArea+right.walls.find(w=>w.id==='curve').netArea);
  assert.equal(both.walls.find(w=>w.id==='straight').total,'16.80');assert.equal(left.walls.find(w=>w.id==='straight').total,'16.80');assert.equal(right.walls.find(w=>w.id==='straight').total,'16.80');
});
