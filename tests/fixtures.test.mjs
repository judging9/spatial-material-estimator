import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_KINDS, isFixtureKind, isWallFixtureKind, fixtureWallPlacement } from '../build/studio/lib/fixtures.js';
import { FURNITURE_TEMPLATES, searchFurnitureTemplates } from '../build/studio/lib/furniture-catalog.js';
import { buildFurniture3D } from '../build/studio/lib/furniture3d.js';
import { calculateProject } from '../build/studio/lib/pricing.js';
import { extraFurnitureSymbol } from '../build/studio/lib/furniture-symbols.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const fixtures=FURNITURE_TEMPLATES.filter(value=>isFixtureKind(value.kind));
const item=(kind,extra={})=>({...FURNITURE_TEMPLATES.find(value=>value.kind===kind),id:kind,position:{x:100,y:200},rotation:0,quantity:'1',unitPrice:'',additionalCost:'0',...extra});
const project=(furniture=[],extra={})=>({version:1,id:'fixtures',name:'点位',drawing:{type:'plan',width:1200,height:900},calibration:{metersPerPixel:.01},regions:[],furniture,additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1},...extra});
const bounds=model=>Object.fromEntries(['x','y','z'].map(axis=>{const values=model.surfaces.flatMap(face=>face.points.map(point=>point[axis]));return[axis,[Math.min(...values),Math.max(...values)]];}));

test('35 installation fixtures have separate categories, practical centimetre dimensions and no supplier prices',()=>{
  assert.equal(fixtures.length,35);assert.equal(FIXTURE_KINDS.length,35);
  assert.equal(fixtures.filter(value=>value.category==='electrical').length,20);
  assert.equal(fixtures.filter(value=>value.category==='lighting').length,6);
  assert.equal(fixtures.filter(value=>value.category==='smart').length,9);
  assert.ok(FURNITURE_TEMPLATES.slice(0,58).every(value=>!isFixtureKind(value.kind)));
  assert.ok(fixtures.every(value=>value.width>=1&&value.depth>=1&&value.height>=1&&value.unitPrice===undefined));
  near(item('socketFive').width,8.6);near(item('socketFive').mountHeight,30);near(item('switchSingle').mountHeight,120);
  near(item('socketFloor').mountHeight??0,0);near(item('smokeDetector').mountHeight,256);
  assert.ok(searchFurnitureTemplates('网线','electrical').some(value=>value.kind==='networkPanel'));
  assert.ok(searchFurnitureTemplates('插头').some(value=>value.kind==='powerPlug'));
  assert.ok(searchFurnitureTemplates('暖通','smart').length>=4);
});

test('fixture helpers distinguish tiny hardware from furniture and free floor/ceiling devices',()=>{
  for(const kind of FIXTURE_KINDS)assert.equal(isFixtureKind(kind),true);
  for(const kind of['sofa','stairs','untrusted',null,{},undefined])assert.equal(isFixtureKind(kind),false);
  for(const kind of['socketFive','networkPanel','doorbell','radiator'])assert.equal(isWallFixtureKind(kind),true);
  for(const kind of['socketFloor','floorDrain','downlight','wirelessAP','router','powerPlug'])assert.equal(isWallFixtureKind(kind),false);
});

test('each actual fixture model preserves all three dimensions and lower-edge mounting height without enlarging small panels',()=>{
  for(const template of fixtures){
    const value=item(template.kind),source=project([value]),before=structuredClone(source),model=buildFurniture3D(source)[0],b=bounds(model);
    assert.deepEqual(source,before);
    near(b.x[0],1-value.width/200);near(b.x[1],1+value.width/200);
    near(b.z[0],2-value.depth/200);near(b.z[1],2+value.depth/200);
    near(b.y[0],(value.mountHeight??0)/100);near(b.y[1],((value.mountHeight??0)+value.height)/100);
    assert.ok(model.surfaces.length>12,`${template.kind} must include hardware details`);
    assert.ok(new Set(model.surfaces.map(face=>face.color)).size>=2);
    assert.equal(model.geometrySource,'parametric');
  }
});

test('nonuniformly resized and freely rotated fixtures have planar faces, outward normals and finite metric vertices',()=>{
  for(const template of fixtures){
    const source=project([item(template.kind,{width:template.width*1.7,depth:template.depth*2.1,height:template.height*.8,rotation:37.27})]);
    const model=buildFurniture3D(source)[0];
    for(const face of model.surfaces){
      near(Math.hypot(face.normal.x,face.normal.y,face.normal.z),1);
      const first=face.points[0];
      for(const point of face.points){assert.ok([point.x,point.y,point.z].every(Number.isFinite));near((point.x-first.x)*face.normal.x+(point.y-first.y)*face.normal.y+(point.z-first.z)*face.normal.z,0);}
      const a=face.points[0],b=face.points[1],c=face.points[2],u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
      assert.ok((u.y*v.z-u.z*v.y)*face.normal.x+(u.z*v.x-u.x*v.z)*face.normal.y+(u.x*v.y-u.y*v.x)*face.normal.z>0,`${template.kind} face winding must match its normal`);
    }
  }
});

test('real circular bodies, ports, fan grilles and plug blades differentiate device silhouettes',()=>{
  const models=new Map(buildFurniture3D(project(fixtures.map(value=>item(value.kind)))).map(model=>[model.kind,model]));
  for(const kind of['downlight','wirelessAP','smokeDetector','waterOutletCold','waterValve','powerPlug']){
    assert.ok(models.get(kind).surfaces.some(face=>face.id.includes(':cylinder:')));
    assert.ok(models.get(kind).surfaces.some(face=>face.points.length===32));
  }
  for(const pair of[['socketFive','socketUsb'],['switchSingle','switchTriple'],['distributionBox','lowVoltageBox'],['waterOutletCold','waterOutletHot']])assert.notDeepEqual(models.get(pair[0]).surfaces,models.get(pair[1]).surfaces);
  for(const kind of['downlight','pendantLight','smokeDetector','wirelessAP'])assert.ok(models.get(kind).surfaces.some(face=>face.id.includes(':detail:')&&face.normal.y===-1),'ceiling fixture visible light/detector face must point downward');
});

test('fixtures keep deterministic quantity pricing independent of their physical size or mount position',()=>{
  const source=project([item('socketFive',{quantity:'5',unitPrice:'18.90',additionalCost:'12.05'}),item('networkPanel',{quantity:'2',unitPrice:'25.15',additionalCost:'3.20'})]);
  const quote=calculateProject(source);assert.equal(quote.total,'160.05');assert.equal(buildFurniture3D(source).length,2);
  source.furniture.forEach(value=>{value.rotation=37.25;value.mountHeight=170;value.width*=2;});
  assert.equal(calculateProject(source).total,'160.05');assert.equal(buildFurniture3D(source).length,2);
});

test('all fixture symbols are safe, deterministic offline vector markup',()=>{
  for(const kind of FIXTURE_KINDS){const svg=extraFurnitureSymbol(kind);assert.match(svg,/<(?:path|rect|circle)/);assert.doesNotMatch(svg,/<(?:script|image)|href=|on\w+=/);assert.equal(extraFurnitureSymbol(kind),svg);}
});

test('wall placement puts the back exactly on either clicked face with device front pointing into the chosen side',()=>{
  for(const degrees of[0,90,37.27,180])for(const side of[-1,1]){
    const angle=degrees*Math.PI/180,u={x:Math.cos(angle),y:Math.sin(angle)},n={x:-u.y,y:u.x};
    const wall={id:'wall',start:{x:300,y:300},end:{x:300+u.x*500,y:300+u.y*500},thickness:20};
    const point={x:300+u.x*200+n.x*side*20,y:300+u.y*200+n.y*side*20};
    const fixture=item('socketFive'),source=project([],{walls:[wall]}),before=structuredClone(source),placement=fixtureWallPlacement(fixture,point,source);
    assert.equal(placement.snapped,true);assert.equal(placement.wallId,'wall');assert.deepEqual(source,before);
    const rotation=placement.rotation*Math.PI/180,front={x:-Math.sin(rotation),y:Math.cos(rotation)};
    near(front.x*n.x+front.y*n.y,side);
    near((placement.position.x-wall.start.x)*n.x+(placement.position.y-wall.start.y)*n.y,side*(20+fixture.depth)/2);
    const back={x:placement.position.x-front.x*fixture.depth/2,y:placement.position.y-front.y*fixture.depth/2};
    near((back.x-wall.start.x)*n.x+(back.y-wall.start.y)*n.y,side*10);
  }
});

test('near-wall snapping respects device end margins, short walls, distant clicks and images',()=>{
  const wall={id:'host',start:{x:100,y:100},end:{x:500,y:100},thickness:20};
  const fixture=item('socketFive'),source=project([],{walls:[wall]});
  const end=fixtureWallPlacement(fixture,{x:101,y:115},source);near(end.position.x,104.3);
  for(const value of[
    fixtureWallPlacement(fixture,{x:200,y:160},source),
    fixtureWallPlacement(item('floorDrain'),{x:200,y:115},source),
    fixtureWallPlacement(fixture,{x:200,y:115},project([],{walls:[{...wall,end:{x:105,y:100}}]})),
    fixtureWallPlacement(fixture,{x:200,y:115},project([],{walls:[wall],drawing:{type:'image'}})),
  ])assert.equal(value.snapped,false);
  const centre=fixtureWallPlacement(fixture,{x:200,y:100},source);near(centre.rotation,0);near(centre.position.y,110.75);
});
