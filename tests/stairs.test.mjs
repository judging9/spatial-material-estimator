import test from 'node:test';
import assert from 'node:assert/strict';
import { STAIR_KINDS, isStairKind, stairPlanGeometry, buildStair3D, stairSettings } from '../build/studio/lib/stairs.js';
import { FURNITURE_TEMPLATES, searchFurnitureTemplates } from '../build/studio/lib/furniture-catalog.js';
import { buildFurniture3D } from '../build/studio/lib/furniture3d.js';
import { validateFurniture, furnitureFootprint, furnitureContains } from '../build/studio/lib/furniture.js';
import { polygonArea, validatePolygon, validateRegion, pointInRegion } from '../build/studio/lib/geometry.js';
import { calculateProject } from '../build/studio/lib/pricing.js';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const item=(kind='stairs',extra={})=>({...FURNITURE_TEMPLATES.find(value=>value.kind===kind),id:kind,position:{x:600,y:600},rotation:0,height:300,mountHeight:0,quantity:'1',unitPrice:'1800',additionalCost:'100',...extra});
const project=(furniture=[])=>({version:1,id:'stairs-project',name:'楼梯',drawing:{id:'plan',type:'plan',width:2400,height:1800},calibration:{metersPerPixel:.01},regions:[],furniture,additionalCost:'0',taxRate:'9',view:{labels:true,drawingOpacity:1}});
const measure=ring=>({minX:Math.min(...ring.map(p=>p.x)),maxX:Math.max(...ring.map(p=>p.x)),minY:Math.min(...ring.map(p=>p.y)),maxY:Math.max(...ring.map(p=>p.y))});
const points=model=>model.surfaces.flatMap(surface=>surface.points);

test('nine staircase presets are distinct, searchable and never carry invented prices',()=>{
  assert.equal(STAIR_KINDS.length,9);assert.ok(STAIR_KINDS.every(isStairKind));assert.equal(isStairKind('chair'),false);
  assert.equal(searchFurnitureTemplates('楼梯','circulation').length,9);assert.equal(searchFurnitureTemplates('螺旋').length,2);assert.equal(searchFurnitureTemplates('折返').length,1);
  for(const kind of STAIR_KINDS)assert.equal(FURNITURE_TEMPLATES.find(template=>template.kind===kind).unitPrice,undefined);
});

test('all stairs share valid actual envelopes, ordered treads and upper landing at the exact user rise',()=>{
  for(const kind of STAIR_KINDS){
    const value=item(kind),source=project([value]),before=structuredClone(source),plan=stairPlanGeometry(value,source),model=buildStair3D(value,source);
    assert.deepEqual(source,before);assert.equal(plan.stepCount,17);assert.ok(validateRegion({points:plan.outline,holes:plan.holes}).valid,kind);assert.ok(validateRegion(plan.opening).valid,kind+' opening');
    const b=measure(plan.outline);near(b.maxX-b.minX,value.width);near(b.maxY-b.minY,value.depth);near(Math.max(...plan.treadHeights),300);
    assert.ok(plan.ascentPath.length>=17);assert.ok(plan.steps.every(step=>validatePolygon(step).valid));
    const tops=model.surfaces.filter(surface=>surface.id.includes(':step:')&&surface.side==='top');assert.equal(tops.length,17);near(Math.max(...tops.flatMap(surface=>surface.points.map(point=>point.y))),3);
    assert.equal(model.size.height,3);assert.ok(model.surfaces.some(surface=>surface.id.includes(':post:')));assert.ok(model.surfaces.some(surface=>surface.id.includes(':rail:')));
  }
});

test('default double railings extend above rise; none, left and right show their actual chosen side',()=>{
  for(const kind of STAIR_KINDS){
    const value=item(kind),source=project(),both=buildStair3D(value,source),none=buildStair3D({...value,stair:{railing:'none',railingHeight:90}},source);
    assert.equal(stairSettings(value).railing,'both');assert.ok(Math.max(...points(both).map(point=>point.y))>3.89);near(Math.max(...points(none).map(point=>point.y)),3);
    assert.ok(!none.surfaces.some(surface=>surface.id.includes(':rail:')||surface.id.includes(':post:')));
    for(const side of ['left','right']){const model=buildStair3D({...value,stair:{railing:side,railingHeight:110}},source);assert.ok(model.surfaces.some(surface=>surface.id.includes(':post:'+side+':')));assert.ok(!model.surfaces.some(surface=>surface.id.includes(':post:'+(side==='left'?'right':'left')+':')));assert.ok(Math.max(...points(model).map(point=>point.y))>4.09);}
  }
});

test('every stair surface has a finite unit normal perpendicular to its actual rotated plane',()=>{
  for(const kind of STAIR_KINDS){const model=buildStair3D(item(kind,{rotation:37.27,mountHeight:80}),project());assert.ok(model.surfaces.length<5000);for(const surface of model.surfaces){near(Math.hypot(surface.normal.x,surface.normal.y,surface.normal.z),1);const first=surface.points[0];for(const p of surface.points)near((p.x-first.x)*surface.normal.x+(p.y-first.y)*surface.normal.y+(p.z-first.z)*surface.normal.z,0);}}
});

test('spiral and mirrored curved stairs produce genuine annular or sector footprints with opposite ascent direction',()=>{
  for(const family of ['Spiral','Arc']){const left=stairPlanGeometry(item('stairs'+family+'Left'),project()),right=stairPlanGeometry(item('stairs'+family+'Right'),project());assert.equal(left.holes.length,family==='Spiral'?1:0);assert.equal(right.holes.length,left.holes.length);assert.equal(right.opening.shape,family==='Spiral'?'annulus':'polygon');near(polygonArea(left.outline),polygonArea(right.outline));for(let i=0;i<left.ascentPath.length;i++){near(left.ascentPath[i].x+right.ascentPath[i].x,1200);near(left.ascentPath[i].y,right.ascentPath[i].y);}const turn=path=>{const[a,b,c]=path;return(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);};assert.ok(turn(left.ascentPath)*turn(right.ascentPath)<0);assert.ok(left.steps.length===right.steps.length);}
});

test('spiral central island remains intact, and aperture clearance expands the shell while shrinking the island',()=>{
  const value=item('stairsSpiralRight'),plan=stairPlanGeometry(value,project()),plain=stairPlanGeometry({...value,stair:{railing:'both',railingHeight:90,openingClearance:0}},project());
  assert.equal(plan.holes.length,1);assert.equal(plan.opening.holes.length,1);assert.ok(polygonArea(plan.opening.points)>polygonArea(plain.outline));assert.ok(polygonArea(plan.opening.holes[0])<polygonArea(plain.holes[0]));
  assert.equal(furnitureContains(value,value.position,project()),false);assert.equal(pointInRegion(value.position,plan.opening),false);
  const wide=stairPlanGeometry({...value,stair:{railing:'both',railingHeight:90,openingClearance:100}},project());assert.equal(wide.opening.holes.length,0);
});

test('helical stairs retain real open space underneath thin wedge treads and have continuous structural stringers',()=>{
  for(const kind of ['stairsSpiralLeft','stairsSpiralRight','stairsArcLeft','stairsArcRight']){const model=buildStair3D(item(kind),project()),tops=model.surfaces.filter(surface=>surface.id.includes(':step:')&&surface.side==='top');for(const top of tops){const bottom=model.surfaces.find(surface=>surface.id===top.id.replace(':top',':bottom'));assert.ok(bottom);near(top.points[0].y-bottom.points[0].y,.08);}assert.ok(model.surfaces.some(surface=>surface.id.includes(':stringer:')));near(Math.min(...points(model).map(point=>point.y)),0);}
});

test('curved handrails rise monotonically toward the landing and never dip at the first tread',()=>{
  for(const kind of ['stairsSpiralLeft','stairsSpiralRight','stairsArcLeft','stairsArcRight']){const model=buildStair3D(item(kind),project()),height=surface=>surface.points.reduce((sum,p)=>sum+p.y,0)/surface.points.length;for(const cap of model.surfaces.filter(surface=>/:rail:(left|right):\d+:a$/.test(surface.id))){const end=model.surfaces.find(surface=>surface.id===cap.id.slice(0,-1)+'b');assert.ok(end);assert.ok(height(end)>=height(cap)-1e-8);}}
});

test('L and U stairs use their real occupied outline instead of rejecting every empty corner in the bounding box',()=>{
  const value=item('stairsLRight'),source=project(),plan=stairPlanGeometry(value,source);assert.equal(plan.outline.length,6);assert.deepEqual(furnitureFootprint(value,source),plan.outline);
  assert.equal(furnitureContains(value,{x:value.position.x+value.width*.35,y:value.position.y-value.depth*.35},source),false);
  const u=item('stairsU'),up=stairPlanGeometry(u,source);assert.equal(up.outline.length,8);assert.equal(furnitureContains(u,{x:u.position.x,y:u.position.y-u.depth*.35},source),false);
});

test('arbitrary rotation and image calibration preserve physical stair dimensions and rotate matching apertures together',()=>{
  const value=item('stairsSpiralRight',{rotation:37.27,mountHeight:80}),native=project(),image={...project(),drawing:{type:'image'},calibration:{metersPerPixel:.025}},nativePlan=stairPlanGeometry(value,native),imagePlan=stairPlanGeometry(value,image),model=buildFurniture3D(project([value]))[0];
  near(model.position.y,.8);for(let i=0;i<nativePlan.outline.length;i++){near((nativePlan.outline[i].x-value.position.x)*.01,(imagePlan.outline[i].x-value.position.x)*.025);near((nativePlan.outline[i].y-value.position.y)*.01,(imagePlan.outline[i].y-value.position.y)*.025);}
  for(let i=0;i<nativePlan.opening.points.length;i++){near((nativePlan.opening.points[i].x-value.position.x)*.01,(imagePlan.opening.points[i].x-value.position.x)*.025);near((nativePlan.opening.points[i].y-value.position.y)*.01,(imagePlan.opening.points[i].y-value.position.y)*.025);}
});

test('railing, turns, position and aperture margin never alter the user-entered stair budget',()=>{
  const value=item('stairsSpiralRight'),source=project([value]),before=calculateProject(source);value.stair={railing:'right',railingHeight:110,turnDegrees:540,innerRatio:.3,openingClearance:8};value.rotation=37.27;value.mountHeight=80;
  assert.equal(calculateProject(source).total,before.total);assert.equal(before.total,'2071.00');assert.equal(buildFurniture3D(source).length,1);
});

test('landing variants retain a true intermediate platform and ordered flight rise without duplicating the platform quantity',()=>{
  for(const kind of ['stairsLanding','stairsLRight','stairsU']){const value=item(kind),plan=stairPlanGeometry(value,project()),model=buildStair3D(value,project()),platform=model.surfaces.find(surface=>surface.id.includes(':landing:')&&surface.side==='top');assert.ok(platform);assert.equal(plan.steps.length,plan.stepCount+1);near(platform.points[0].y,Math.floor(plan.stepCount/2)*3/plan.stepCount);}
});

test('invalid stair settings fail before rendering or saving; uncalibrated stairs produce no guessed footprint',()=>{
  const base=item('stairsSpiralRight');for(const changes of[{railing:'bad'},{railingHeight:49},{railingHeight:151},{innerRatio:0},{innerRatio:.9},{turnDegrees:179},{turnDegrees:721},{openingClearance:-1},{openingClearance:101},{autoOpening:'yes'}])assert.throws(()=>validateFurniture([{...base,stair:{railing:'both',railingHeight:90,...changes}}]));
  assert.throws(()=>validateFurniture([item('chair',{stair:{railing:'both',railingHeight:90}})]));const source={...project(),drawing:{type:'image'},calibration:{metersPerPixel:null}};assert.equal(stairPlanGeometry(base,source),null);assert.equal(buildStair3D(base,source),null);
});
