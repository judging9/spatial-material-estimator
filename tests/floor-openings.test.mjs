import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=process.env.FLOOR_GEOMETRY_BUILD?pathToFileURL(resolve(process.env.FLOOR_GEOMETRY_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {openingShape,snapOpeningPoint,openingRegionParts,openingNetArea,openingNetPerimeter}=await import(new URL('lib/floor-openings.js',root));
const {polygonArea,regionMetrics,pointInRegion,regionInteriorPoint,validateRegion,intersectionArea}=await import(new URL('lib/geometry.js',root));
const {effectiveLevelProject,validateLevels,addLevel,levelProjects}=await import(new URL('lib/levels.js',root));
const {calculateProject}=await import(new URL('lib/pricing.js',root));
const {createMemoryProjectStore,importProjectJSON}=await import(new URL('lib/persistence.js',root));
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const room=(points=rect(0,0,600,400),holes=[])=>({id:'room',name:'实际房间',points,holes,hidden:false,items:[{id:'floor-item',materialId:'mat',materialName:'地板',unit:'m²',unitPrice:'100',wasteRate:'10',laborRate:'20',additionalCost:'0',quantityMode:'area',quantity:'0'}],additionalCost:'50'});
const cut=(points,holes=[])=>({id:'cut',regionId:'room',points,holes});
const project=()=>({version:1,id:'floor-project',name:'洞口工程',drawing:{id:'plan',type:'plan',name:'平面',url:'data:image/png;base64,iVBORw0KGgo=',width:2400,height:1800},calibration:{metersPerPixel:.01,method:'metric-plan'},regions:[room()],walls:[],wallHeight:280,wallThickness:20,wallJoinStyle:'clean',additionalCost:'25',taxRate:'9',view:{labels:true,drawingOpacity:1}});
const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
const measured=parts=>({points:rect(0,0,600,400),holes:[],surfaceParts:parts});

test('internal aperture preserves room ownership and subtracts its exact area and perimeter',()=>{
 const original=room(),saved=structuredClone(original),parts=openingRegionParts(original,[cut(rect(200,100,100,100))]);
 near(openingNetArea(original,[cut(rect(200,100,100,100))]),230000);near(openingNetPerimeter(original,[cut(rect(200,100,100,100))]),2400);
 assert.equal(parts.length,1);assert.equal(parts[0].holes.length,1);assert.deepEqual(original,saved);assert.equal(validateRegion(measured(parts)).valid,true);
});
test('a flush wall-side rectangle produces a real notch with no artificial gap or duplicate boundary',()=>{
 const cuts=[cut(rect(0,100,100,100))],parts=openingRegionParts(room(),cuts);near(openingNetArea(room(),cuts),230000);near(openingNetPerimeter(room(),cuts),2200);
 assert.equal(parts.length,1);assert.equal(parts[0].holes.length,0);assert.ok(parts[0].points.some(p=>p.x===0&&p.y===100));assert.equal(pointInRegion({x:50,y:150},measured(parts)),false);
 assert.equal(validateRegion(measured(parts)).valid,true);
});
test('corner overflow is clipped to the actual room and uses the true retained perimeter',()=>{
 const cuts=[cut(rect(-50,-50,150,150))];near(openingNetArea(room(),cuts),230000);near(openingNetPerimeter(room(),cuts),2000);
 assert.equal(openingRegionParts(room(),cuts)[0].holes.length,0);
});
test('overlapping and duplicate apertures are unioned and never double-counted',()=>{
 const cuts=[cut(rect(100,100,100,100)),{...cut(rect(150,100,100,100)),id:'second'},cut(rect(100,100,100,100))];
 near(openingNetArea(room(),cuts),225000);near(openingNetPerimeter(room(),cuts),2500);assert.equal(openingRegionParts(room(),cuts)[0].holes.length,1);
});
test('a cut joining opposite walls returns two real floor pieces with one logical owner',()=>{
 const parts=openingRegionParts(room(),[cut(rect(250,-50,100,500))]);assert.equal(parts.length,2);near(regionMetrics(measured(parts),{metersPerPixel:.01}).netArea,20);near(regionMetrics(measured(parts),{metersPerPixel:.01}).perimeter,26);
 assert.equal(pointInRegion({x:100,y:100},measured(parts)),true);assert.equal(pointInRegion({x:500,y:100},measured(parts)),true);assert.equal(pointInRegion({x:300,y:100},measured(parts)),false);
 assert.ok(pointInRegion(regionInteriorPoint(measured(parts)),measured(parts)));
});
test('a concave room clips away portions outside its actual outline',()=>{
 const actual=room([{x:0,y:0},{x:400,y:0},{x:400,y:100},{x:100,y:100},{x:100,y:400},{x:0,y:400}]),cuts=[cut(rect(50,50,200,200))];
 near(openingNetArea(actual,cuts),52500);assert.equal(validateRegion({...actual,surfaceParts:openingRegionParts(actual,cuts)}).valid,true);
});
test('existing shaft holes and new openings form one union without counting shaft area again',()=>{
 const actual=room(rect(0,0,600,400),[rect(200,100,100,100)]),cuts=[cut(rect(250,100,100,100))];near(openingNetArea(actual,cuts),225000);near(openingNetPerimeter(actual,cuts),2500);
});
test('an annular aperture retains and measures its central island as a separate real floor part',()=>{
 const shape=openingShape('annulus',{x:300,y:200},{x:400,y:200},{innerRatio:.5}),parts=openingRegionParts(room(),[cut(shape.points,shape.holes)]);
 assert.equal(parts.length,2);const expected=240000-polygonArea(shape.points)+polygonArea(shape.holes[0]);near(openingNetArea(room(),[cut(shape.points,shape.holes)]),expected);
 const effective=measured(parts);assert.equal(pointInRegion({x:300,y:200},effective),true);assert.equal(pointInRegion({x:375,y:200},effective),false);assert.equal(pointInRegion({x:450,y:200},effective),true);assert.equal(validateRegion(effective).valid,true);
});
test('overlapping a second cut with an annulus removes only its true remaining central island portion',()=>{
 const shape=openingShape('annulus',{x:300,y:200},{x:400,y:200},{innerRatio:.5}),parts=openingRegionParts(room(),[cut(shape.points,shape.holes),cut(rect(0,0,300,400))]);
 const expected=120000-polygonArea(shape.points)/2+polygonArea(shape.holes[0])/2;near(parts.reduce((sum,part)=>sum+regionMetrics(part,{metersPerPixel:1}).netArea,0),expected,1e-5);
});
test('reversed ring winding leaves clipped area and topology unchanged',()=>{
 const shape=openingShape('annulus',{x:300,y:200},{x:400,y:200},{innerRatio:.4}),normal=openingRegionParts(room(),[cut(shape.points,shape.holes)]),reversed=openingRegionParts(room([...room().points].reverse()),[cut([...shape.points].reverse(),shape.holes.map(ring=>[...ring].reverse()))]);
 near(regionMetrics(measured(normal),{metersPerPixel:1}).netArea,regionMetrics(measured(reversed),{metersPerPixel:1}).netArea);assert.equal(normal.length,reversed.length);
});
test('a circular aperture tangent to the room boundary is a real boundary contact and keeps reliable metrics',()=>{
 const shape=openingShape('circle',{x:100,y:200},{x:200,y:200}),parts=openingRegionParts(room(),[cut(shape.points)]);
 near(regionMetrics(measured(parts),{metersPerPixel:1}).netArea,240000-polygonArea(shape.points));assert.equal(validateRegion(measured(parts)).valid,true);assert.ok(regionInteriorPoint(measured(parts)));
});
test('geometry helpers handle effective parts and further previews without restoring removed material',()=>{
 const original=room(),parts=openingRegionParts(original,[cut(rect(250,-50,100,500))]),effective={...original,surfaceParts:parts},next=openingRegionParts(effective,[cut(rect(0,0,100,100))]);
 near(regionMetrics({...original,surfaceParts:next},{metersPerPixel:1}).netArea,190000);near(intersectionArea(effective,{points:rect(0,0,600,400),holes:[]}),200000);
});
test('circle and ellipse controls produce shared accurate sampled geometry and annulus inner ratios',()=>{
 const circle=openingShape('circle',{x:0,y:0},{x:200,y:0}),ellipse=openingShape('ellipse',{x:-200,y:-100},{x:200,y:100}),annulus=openingShape('annulus',{x:0,y:0},{x:200,y:0},{innerRatio:.3});
 assert.ok(circle.points.length<=200&&circle.points.length>=32);near(polygonArea(circle.points),Math.PI*200**2,Math.PI*200**2*.008);
 near(polygonArea(ellipse.points),Math.PI*200*100,Math.PI*200*100*.008);near(polygonArea(annulus.holes[0])/polygonArea(annulus.points),.09);
 for(const [kind,a,b,options]of[['circle',{x:0,y:0},{x:0,y:0},{}],['annulus',{x:0,y:0},{x:100,y:0},{innerRatio:1}],['ellipse',{x:0,y:0},{x:0,y:20},{}]])assert.throws(()=>openingShape(kind,a,b,options));
});
test('edge and vertex magnets land on exact room coordinates while distant overflow remains a drawing gesture',()=>{
 const actual=room();assert.deepEqual(snapOpeningPoint({x:-3,y:150},actual,10),{x:0,y:150});assert.deepEqual(snapOpeningPoint({x:3,y:4},actual,10),{x:0,y:0});assert.deepEqual(snapOpeningPoint({x:-50,y:150},actual,10),{x:-50,y:150});
 assert.deepEqual(snapOpeningPoint({x:3,y:150},actual,10),{x:0,y:150});
});
test('large diagram coordinate offsets retain exact clipped rectangular area',()=>{
 const x=1e9,y=-1e9,actual=room(rect(x,y,600,400)),cuts=[cut(rect(x-50,y+100,150,100))];near(openingNetArea(actual,cuts),230000);near(openingNetPerimeter(actual,cuts),2200);
});
test('effective floor and ceiling price once across disconnected pieces and retain original gross area',()=>{
 const p=project();p.regions[0].ceiling={enabled:true,height:260,items:[{...p.regions[0].items[0],id:'ceiling-item',unitPrice:'50',laborRate:'12'}],additionalCost:'10'};p.floorOpenings=[cut(rect(250,-50,100,500))];
 assert.doesNotThrow(()=>validateLevels(p));const saved=structuredClone(p),effective=effectiveLevelProject(p),quote=calculateProject(p);assert.equal(effective.regions.length,1);assert.equal(effective.regions[0].id,'room');assert.equal(effective.regions[0].surfaceParts.length,2);assert.equal(effective.floorOpenings,undefined);assert.equal(effectiveLevelProject(effective),effective);assert.deepEqual(p,saved);
 near(quote.regions[0].netArea,20);assert.equal(quote.regions[0].materialCost,'2200.00');assert.equal(quote.regions[0].laborCost,'400.00');assert.equal(quote.regions[0].additionalCost,'50.00');assert.equal(quote.ceilings[0].total,'1350.00');near(regionMetrics(effective.regions[0],p.calibration).grossArea,24);near(regionMetrics(effective.regions[0],p.calibration).holesArea,4);
});
test('empty or invalid apertures and complete floor removal are rejected before quote and persistence',()=>{
 for(const opening of[cut(rect(-200,-200,100,100)),cut(rect(-100,100,100,100)),cut(room().points),cut([{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}])]){const p=project();p.floorOpenings=[opening];assert.throws(()=>validateLevels(p),/楼板|洞口/);}
 const p=project();p.floorOpenings=[cut(rect(0,100,100,100)),{...cut(rect(50,100,100,100)),id:'second'}];assert.doesNotThrow(()=>validateLevels(p));near(calculateProject(p).regions[0].netArea,22.5);
});
test('all-floor save and load retains genuine annular openings and never persists effective fragments',async()=>{
 const p=project(),shape=openingShape('annulus',{x:300,y:200},{x:400,y:200},{innerRatio:.5});p.floorOpenings=[cut(shape.points,shape.holes)];const multi=addLevel(p,{copyLayout:true}),storage=createMemoryProjectStore(),before=calculateProject(multi);await storage.saveProject(multi);const saved=await storage.loadProject(multi.id);assert.deepEqual(calculateProject(saved),before);assert.equal(levelProjects(saved)[0].project.regions[0].surfaceParts,undefined);assert.equal(saved.floorOpenings[0].holes.length,1);
});
test('untrusted JSON cannot provide fabricated effective fragments in active, inactive or cached rooms',async()=>{
 const storage=createMemoryProjectStore(),p=project();p.regions[0].surfaceParts=[{points:rect(0,0,10,10),holes:[]}];assert.throws(()=>storage.saveProject(p),/派生/);await assert.rejects(importProjectJSON(JSON.stringify(p)),/派生/);
 const multi=addLevel(project());multi.levels[0].content.wallRegionCache=[{...room(),surfaceParts:[{points:rect(0,0,10,10),holes:[]}]}];assert.throws(()=>storage.saveProject(multi),/派生/);
});
test('cached floor geometry cannot be poisoned by a caller changing returned vertices or hole arrays',()=>{
 const actual=room(),openings=[cut(rect(170,130,90,90))],first=openingRegionParts(actual,openings),expected=structuredClone(first),second=openingRegionParts(actual,openings);
 first[0].points[0].x=-900;first[0].holes[0][0].y=100000;second[0].holes.splice(0,1);second[0].points.push({x:NaN,y:NaN});
 assert.deepEqual(openingRegionParts(actual,openings),expected);near(openingNetArea(actual,openings),231900);
});
test('cached geometry updates real coordinates, retained parts and hole contours while ignoring price and object IDs',()=>{
 const actual=room(),openings=[cut(rect(0,100,90,90))];near(openingNetArea(actual,openings),231900);actual.items[0].unitPrice='987';openings[0].id='another-id';near(openingNetArea(actual,openings),231900);
 openings[0].points=rect(-40,100,90,90);near(openingNetArea(actual,openings),235500);actual.points=rect(0,0,700,400);near(openingNetArea(actual,openings),275500);
 const shape=openingShape('annulus',{x:300,y:200},{x:390,y:200},{innerRatio:.4});openings[0].points=shape.points;openings[0].holes=shape.holes;const before=openingNetArea(actual,openings);openings[0].holes=shape.holes.map(ring=>ring.map(point=>({x:300+(point.x-300)*.5,y:200+(point.y-200)*.5})));near(before-openingNetArea(actual,openings),polygonArea(shape.holes[0])*.75);
 const base={...room(),surfaceParts:openingRegionParts(room(),[cut(rect(250,-50,100,500))])},draft=[cut(rect(0,0,50,50))];near(openingNetArea(base,draft),197500);base.surfaceParts=openingRegionParts(room(),[cut(rect(200,-50,200,500))]);near(openingNetArea(base,draft),157500);
});
