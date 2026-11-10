import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=process.env.FLOOR_GEOMETRY_BUILD?pathToFileURL(resolve(process.env.FLOOR_GEOMETRY_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {syncLinkedStairOpenings,incomingStairs,detachStairOpening}=await import(new URL('lib/stair-links.js',root));
const {addLevel,switchLevel,activeLevel,levelProjects,validateLevels,updateLevel,effectiveLevelProject}=await import(new URL('lib/levels.js',root));
const {calculateProject}=await import(new URL('lib/pricing.js',root));
const {stairPlanGeometry}=await import(new URL('lib/stairs.js',root));
const {polygonArea,regionMetrics,pointInRegion}=await import(new URL('lib/geometry.js',root));
const {createMemoryProjectStore,exportProjectJSON,importProjectJSON}=await import(new URL('lib/persistence.js',root));
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
function fixture(kind='stairs',autoOpening=true){
 const p={version:1,id:'stair-linked-project',name:'楼梯联动工程',drawing:{id:'plan',type:'plan',name:'平面',url:'data:image/png;base64,iVBORw0KGgo=',width:2400,height:1800},calibration:{metersPerPixel:.01,method:'metric-plan'},regions:[{id:'lower-room',name:'一楼',points:rect(0,0,600,400),holes:[],hidden:false,items:[{id:'floor-item',materialId:'mat',materialName:'地板',unit:'m²',unitPrice:'100',wasteRate:'10',laborRate:'20',additionalCost:'0',quantityMode:'area',quantity:'0'}],additionalCost:'50'}],walls:[],wallHeight:280,wallThickness:20,wallJoinStyle:'clean',additionalCost:'25',taxRate:'9',view:{labels:true,drawingOpacity:1}};
 let multi=addLevel(p,{copyLayout:true}),upper=multi.activeLevelId,lower=multi.levels[0].id;multi=switchLevel(multi,lower);
 multi.furniture=[{id:'stairs-owner',name:'去二楼楼梯',kind,position:{x:300,y:200},width:100,depth:300,height:300,rotation:0,stairTargetLevelId:upper,quantity:'2',unitPrice:'1000',additionalCost:'100',stair:{railing:'both',railingHeight:90,autoOpening,openingClearance:5}}];
 return{project:multi,lower,upper};
}
const upperData=p=>levelProjects(p).find(level=>level.id!==p.levels[0].id).project;

test('automatic stair matching creates one real upper aperture and quotes furniture only on its source floor',()=>{
 const {project:p,lower,upper}=fixture();syncLinkedStairOpenings(p);assert.doesNotThrow(()=>validateLevels(p));const upstairs=upperData(p),opening=upstairs.floorOpenings[0];
 assert.equal(upstairs.floorOpenings.length,1);assert.equal(opening.sourceStairId,'stairs-owner');assert.equal(opening.sourceLevelId,lower);assert.equal(opening.regionId,upstairs.regions[0].id);assert.equal((upstairs.furniture?.length??0),0);near(polygonArea(opening.points),34100);
 const quote=calculateProject(p);near(quote.regions.find(region=>region.levelId===lower).netArea,24);near(quote.regions.find(region=>region.levelId===upper).netArea,20.59);assert.equal(quote.furniture.length,1);assert.equal(quote.furniture[0].total,'2100.00');assert.equal(quote.projectAdditionalCost,'25.00');assert.equal(quote.taxRate,'9');
 const id=opening.id;syncLinkedStairOpenings(p);assert.equal(upperData(p).floorOpenings.length,1);assert.equal(upperData(p).floorOpenings[0].id,id);assert.deepEqual(calculateProject(p),quote);
});
test('stair movement and arbitrary rotation update the same linked aperture with matching geometry',()=>{
 const {project:p}=fixture();syncLinkedStairOpenings(p);const first=structuredClone(upperData(p).floorOpenings[0]),before=calculateProject(p);p.furniture[0].position.x+=35;p.furniture[0].rotation=37.27;syncLinkedStairOpenings(p);
 const next=upperData(p).floorOpenings[0],plan=stairPlanGeometry(p.furniture[0],p);assert.equal(next.id,first.id);assert.notDeepEqual(next.points,first.points);assert.deepEqual(next.points,plan.opening.points);near(polygonArea(next.points),34100);assert.equal(calculateProject(p).beforeTax,before.beforeTax);
});
test('near-wall automatically matched overflow clips to the real upper room rather than rejecting a useful opening',()=>{
 const {project:p,upper}=fixture();p.furniture[0].position.x=50;syncLinkedStairOpenings(p);assert.doesNotThrow(()=>validateLevels(p));const opening=upperData(p).floorOpenings[0];assert.ok(opening.points.some(point=>point.x===-5));near(calculateProject(p).regions.find(region=>region.levelId===upper).netArea,20.745);
 const actual=effectiveLevelProject(upperData(p)).regions[0];assert.equal(actual.surfaceParts[0].holes.length,0);assert.equal(pointInRegion({x:20,y:200},actual),false);assert.equal(pointInRegion({x:200,y:200},actual),true);
});
test('spiral stair matching creates a true annular opening with a retained central floor island',()=>{
 const {project:p,upper}=fixture('stairsSpiralRight');Object.assign(p.furniture[0],{width:200,depth:200,stair:{railing:'both',railingHeight:95,innerRatio:.3,turnDegrees:360,autoOpening:true,openingClearance:0}});syncLinkedStairOpenings(p);assert.doesNotThrow(()=>validateLevels(p));
 const upstairs=upperData(p),opening=upstairs.floorOpenings[0],actual=effectiveLevelProject(upstairs).regions[0];assert.equal(opening.shape,'annulus');assert.equal(opening.holes.length,1);assert.equal(actual.surfaceParts.length,2);assert.equal(pointInRegion({x:300,y:200},actual),true);assert.equal(pointInRegion({x:380,y:200},actual),false);
 near(calculateProject(p).regions.find(region=>region.levelId===upper).netArea,(240000-polygonArea(opening.points)+polygonArea(opening.holes[0]))*.0001);assert.equal(calculateProject(p).furniture.length,1);
});
test('target layer shows an incoming stair reference while source layer owns its geometry and money',()=>{
 const {project:p,lower,upper}=fixture();syncLinkedStairOpenings(p);const before=calculateProject(p);assert.equal(incomingStairs(p).length,0);const upstairs=switchLevel(p,upper),incoming=incomingStairs(upstairs);assert.equal(incoming.length,1);assert.equal(incoming[0].levelId,lower);assert.equal(incoming[0].item.id,'stairs-owner');assert.equal((upstairs.furniture?.length??0),0);assert.deepEqual(calculateProject(upstairs),before);
 const hidden=structuredClone(upstairs);hidden.levels[0].content.furniture[0].hidden=true;assert.equal(incomingStairs(hidden).length,0);assert.equal(calculateProject(hidden).total,before.total);
});
test('deleting a source stair removes only generated openings while retaining manual openings',()=>{
 const {project:p}=fixture();syncLinkedStairOpenings(p);const upstairsOwner=p.levels[1].content;upstairsOwner.floorOpenings.push({id:'manual-hole',regionId:upstairsOwner.regions[0].id,points:rect(500,50,50,50),holes:[],shape:'rectangle'});p.furniture=[];syncLinkedStairOpenings(p);assert.equal(upperData(p).floorOpenings.length,1);assert.equal(upperData(p).floorOpenings[0].id,'manual-hole');assert.equal(calculateProject(p).furniture.length,0);near(regionMetrics(effectiveLevelProject(upperData(p)).regions[0],p.calibration).netArea,23.75);
});
test('detaching preserves a manual aperture and disabling auto matching prevents its later removal or movement',()=>{
 const {project:p}=fixture();syncLinkedStairOpenings(p);const before=structuredClone(upperData(p).floorOpenings[0]);detachStairOpening(p,'stairs-owner');assert.equal(p.furniture[0].stair.autoOpening,false);const opening=upperData(p).floorOpenings[0];assert.equal(opening.sourceStairId,undefined);assert.equal(opening.sourceLevelId,undefined);assert.deepEqual(opening.points,before.points);p.furniture[0].position.x=100;syncLinkedStairOpenings(p);assert.deepEqual(upperData(p).floorOpenings[0].points,before.points);p.furniture=[];syncLinkedStairOpenings(p);assert.equal(upperData(p).floorOpenings.length,1);
});
test('removing an automatic aperture also disables regeneration and restores the target floor area',()=>{
 const {project:p,upper}=fixture();syncLinkedStairOpenings(p);detachStairOpening(p,'stairs-owner',true);syncLinkedStairOpenings(p);assert.equal(p.furniture[0].stair.autoOpening,false);assert.equal(upperData(p).floorOpenings.length,0);near(calculateProject(p).regions.find(region=>region.levelId===upper).netArea,24);
});
test('changing a storey height keeps bound stairs and matching aperture dimensions synchronized without changing snapshots',()=>{
 const {project:p,lower,upper}=fixture();syncLinkedStairOpenings(p);const before=calculateProject(p),opening=structuredClone(upperData(p).floorOpenings[0]),next=updateLevel(p,lower,{height:330});syncLinkedStairOpenings(next);assert.doesNotThrow(()=>validateLevels(next));assert.equal(next.furniture[0].height,330);assert.equal(next.levels[1].elevation,330);assert.equal(next.furniture[0].unitPrice,'1000');assert.deepEqual(upperData(next).floorOpenings[0].points,opening.points);assert.equal(calculateProject(next).total,before.total);assert.equal(next.furniture[0].stairTargetLevelId,upper);
});
test('an automatically matching stair without an upper room rejects the candidate edit before original saved state changes',()=>{
 const {project:p}=fixture();syncLinkedStairOpenings(p);const saved=structuredClone(p),candidate=structuredClone(p);candidate.furniture[0].position={x:1200,y:1200};assert.throws(()=>syncLinkedStairOpenings(candidate),/上方没有/);assert.deepEqual(p,saved);assert.doesNotThrow(()=>validateLevels(p));
});
test('copying the target layout preserves its real void as a manual aperture rather than binding to the old stair',()=>{
 const {project:p,upper}=fixture();syncLinkedStairOpenings(p);let upstairs=switchLevel(p,upper),copy=addLevel(upstairs,{copyLayout:true});const oldArea=calculateProject(upstairs).regions.find(region=>region.levelId===upper).netArea;
 assert.equal(copy.floorOpenings[0].sourceStairId,undefined);assert.equal(copy.floorOpenings[0].sourceLevelId,undefined);syncLinkedStairOpenings(copy);assert.equal(copy.floorOpenings.length,1);near(calculateProject(copy).regions.find(region=>region.levelId===copy.activeLevelId).netArea,oldArea);assert.equal(calculateProject(copy).furniture.length,1);
});
test('all-floor persistence and project JSON preserve source-target stair relationships and exact quotes',async()=>{
 const {project:p,upper}=fixture('stairsLRight');Object.assign(p.furniture[0],{width:200,depth:240});syncLinkedStairOpenings(p);const storage=createMemoryProjectStore(),before=calculateProject(p);await storage.saveProject(p);const loaded=await storage.loadProject(p.id);assert.deepEqual(calculateProject(loaded),before);assert.equal(loaded.furniture[0].stairTargetLevelId,upper);assert.equal(upperData(loaded).floorOpenings[0].sourceStairId,'stairs-owner');const json=await exportProjectJSON(p),imported=await importProjectJSON(json);syncLinkedStairOpenings(imported);assert.equal(calculateProject(imported).total,before.total);assert.equal(upperData(imported).floorOpenings.length,1);
});
