import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.STUDIO_TEST_MODULE_ROOT?pathToFileURL(resolve(process.env.STUDIO_TEST_MODULE_ROOT)+'/'):new URL('../static/studio/',import.meta.url);
const {createMunicipalElement,validateMunicipalElements}=await import(new URL('lib/municipal-design.js',root));
const {createRoadProfile,roadDesignTriangles,roadProfileSegments,roadProfileAnalysis}=await import(new URL('lib/road-profile.js',root));
const {validateRoadTunnel,roadTunnelAnalysis,suggestRoadTunnel,roadTunnelGeometry,excludeTunnelEarthworkTriangles,MAX_TUNNEL_SECTIONS}=await import(new URL('lib/road-tunnel.js',root));
const {buildTunnelGeometry,subtractTunnelVoids}=await import(new URL('lib/tunnel-scene.js',root));
const {buildTerrainScene}=await import(new URL('lib/terrain-scene.js',root));
const {compileTerrain}=await import(new URL('lib/terrain.js',root));
const {buildSceneMunicipal}=await import(new URL('lib/municipal-scene.js',root));
const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
function fixture(){return{version:1,id:'tunnels',name:'山中道路',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:120000,height:90000,url:''},calibration:{metersPerPixel:.01},municipalElements:[],regions:[],walls:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};}
function road(project,points=[{x:1000,y:1000},{x:3000,y:1000}],patch={}){const item={...createMunicipalElement('road',points,project),id:'road',width:600,height:20,unitPrice:'0',...patch};item.tunnel={enabled:true,startStation:0,endStation:20,clearHeight:5,liningThickness:.3,shape:'box',unitPrice:'',laborRate:'0',additionalCost:'0'};project.municipalElements.push(item);return item;}
const planeArea=triangles=>triangles.reduce((sum,[a,b,c])=>sum+Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2,0);
const sceneArea=pieces=>pieces.reduce((sum,ring)=>sum+ring.slice(2).reduce((s,c,i)=>{const a=ring[0],b=ring[i+1],u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};return s+Math.hypot(u.y*v.z-u.z*v.y,u.z*v.x-u.x*v.z,u.x*v.y-u.y*v.x)/2;},0),0);
const squareTerrain=(z=10)=>({name:'真实山体',visible:true,points:[{id:'a',x:0,y:0,z},{id:'b',x:50,y:0,z},{id:'c',x:50,y:50,z},{id:'d',x:0,y:50,z}]});

test('20 m by 6 m box uses actual 30 m² section, 600 m³ clearance and 320 m² lining',()=>{
  const p=fixture(),r=road(p),g=roadTunnelGeometry(p,r),a=roadTunnelAnalysis(p,r);
  near(a.length,20);near(a.horizontalLength,20);near(a.netWidth,6);near(a.sectionArea,30);near(a.voidVolume,600);near(a.liningArea,320);
  assert.equal(a.portals.length,2);assert.ok(g.surfaces.some(s=>s.id.includes('inside')));assert.ok(g.surfaces.some(s=>s.id.includes('outside')));
  assert.ok(g.surfaces.filter(s=>s.id.includes('portal')).every(s=>s.points.some(v=>Math.abs(v.y-5)<1e-8||Math.abs(v.z-7)<1e-8||Math.abs(v.z-13)<1e-8||Math.abs(v.y)<1e-8)));
  assert.ok(g.surfaces.every(s=>s.points.every(v=>Object.values(v).every(Number.isFinite))));
  near(a.unknownLength,20);assert.ok(a.warnings.some(w=>w.includes('缺测')));
});
test('3–4–5 slope length is spatial, while vertical sections retain actual horizontal swept volume',()=>{
  const p=fixture(),r=road(p,[{x:1000,y:1000},{x:1300,y:1000}]);r.tunnel.endStation=3;r.roadProfile=createRoadProfile(p,r);r.roadProfile.points[1].elevation=4;
  const a=roadTunnelAnalysis(p,r);near(a.length,5);near(a.horizontalLength,3);near(a.voidVolume,90);
  near(Math.hypot(...Object.values(a.portals[0].direction)),1);near(a.portals[0].direction.y,.8);near(a.portals[1].direction.y,-.8);
});
test('diagonal path, L bend and calibrated image coordinates conserve the real swept volume',()=>{
  const p=fixture(),r=road(p,[{x:1000,y:1000},{x:2200,y:2600}]);near(roadTunnelAnalysis(p,r).voidVolume,600);
  r.points=[{x:1000,y:1000},{x:3000,y:1000},{x:3000,y:3000}];r.tunnel.endStation=40;near(roadTunnelAnalysis(p,r).voidVolume,1200);
  p.drawing.type='image';p.calibration.metersPerPixel=.02;r.tunnel.endStation=80;near(roadTunnelAnalysis(p,r).voidVolume,2400);
});
test('arch quantities use the same faceted section as the hollow scene and portals',()=>{
  const p=fixture(),r=road(p);r.tunnel.shape='arch';const a=roadTunnelAnalysis(p,r),g=buildTunnelGeometry(p,r);
  assert.ok(a.sectionArea>16.5&&a.sectionArea<30);near(a.voidVolume,a.sectionArea*20);assert.ok(g.voids.length>6);assert.ok(g.surfaces.some(s=>s.id.includes('portal')));
  assert.ok(g.surfaces.filter(s=>s.id.includes('inside')).every(s=>s.points.every(v=>v.y>=-1e-8&&v.y<=5+1e-8)));
});
test('parabolic vertical curves integrate true chainage independently of graph interval',()=>{
  const p=fixture(),r=road(p);r.roadProfile=createRoadProfile(p,r);r.roadProfile.points=[{id:'a',station:0,elevation:0},{id:'b',station:10,elevation:2,curveLength:10},{id:'c',station:20,elevation:0}];
  const expected=roadProfileSegments(p,r).reduce((sum,s)=>sum+s.designLength,0),a=roadTunnelAnalysis(p,r);near(a.length,expected);assert.ok(a.length>20);near(a.voidVolume,600,1e-5);
  r.roadProfile.sampleInterval=.1;near(roadTunnelAnalysis(p,r).length,a.length);r.roadProfile.sampleInterval=100;near(roadTunnelAnalysis(p,r).length,a.length);
});
test('clearance subtraction preserves all mountain roof and removes portal intrusions exactly without duplicate fragments',()=>{
  const p=fixture(),r=road(p),voids=roadTunnelGeometry(p,r).voids;
  const rectangle=[{x:5,y:2,z:5},{x:35,y:2,z:5},{x:35,y:2,z:15},{x:5,y:2,z:15}];
  near(sceneArea(subtractTunnelVoids(rectangle,voids)),180);
  near(sceneArea(subtractTunnelVoids(rectangle,[...voids,...voids])),180);
  const roof=rectangle.map(v=>({...v,y:8}));assert.deepEqual(subtractTunnelVoids(roof,voids),[roof]);
  const slope=[{x:9,y:0,z:7},{x:11,y:2,z:7},{x:11,y:2,z:13},{x:9,y:0,z:13}];near(sceneArea(subtractTunnelVoids(slope,voids)),6*Math.sqrt(2));
});
test('terrain surface clips only true tunnel intersections and never mutates terrain or fills NoData',()=>{
  const p=fixture(),r=road(p);p.municipalTerrain=squareTerrain(10);const original=JSON.stringify(p.municipalTerrain),surface=buildTerrainScene(p);near(sceneArea(surface.map(s=>s.points)),2500);assert.equal(JSON.stringify(p.municipalTerrain),original);
  p.municipalTerrain=squareTerrain(2);near(sceneArea(buildTerrainScene(p).map(s=>s.points)),2380);assert.equal(compileTerrain(p.municipalTerrain).triangles.length,2);
  p.municipalTerrain={name:'缺测栅格',visible:true,points:[],raster:{format:'esri-ascii',ncols:4,nrows:3,xllcorner:0,yllcorner:0,cellSize:10,noDataValue:-9999,values:[10,10,null,10,10,10,null,10,10,10,null,10],coordinateUnit:'m',yDirection:'north-up',originX:0,originY:0}};
  const before=JSON.stringify(p.municipalTerrain);buildTerrainScene(p);assert.equal(JSON.stringify(p.municipalTerrain),before);assert.ok(roadTunnelAnalysis(p,r).unknownLength>0);
});
test('earthwork excludes only actual tunnel stations, and complementary fragments preserve supplied Z',()=>{
  const p=fixture(),r=road(p);r.tunnel.startStation=4;r.tunnel.endStation=16;const original=roadDesignTriangles(p,{...r,roadProfile:{...createRoadProfile(p,r),points:[{id:'a',station:0,elevation:3},{id:'b',station:20,elevation:4}]}}),out=excludeTunnelEarthworkTriangles(p,r,original);
  near(planeArea(original),120);near(planeArea(out),48);assert.ok(out.every(triangle=>triangle.every(v=>Math.abs(v.z-(3+(v.x-10)*.05))<1e-8)));
  assert.ok(out.every(triangle=>triangle.every(v=>v.x<=14+1e-8)||triangle.every(v=>v.x>=26-1e-8)));
  r.roadProfile=createRoadProfile(p,r);r.roadProfile.earthwork.enabled=true;r.roadProfile.earthwork.cutUnitPrice='1';r.roadProfile.earthwork.fillUnitPrice='1';p.municipalTerrain=squareTerrain(10);near(roadProfileAnalysis(p,r).earthworks.designArea,48);
});
test('suggestions depend on real terrain, split distinct mountains and never span unknown survey gaps',()=>{
  const p=fixture(),r=road(p);assert.equal(suggestRoadTunnel(p,r),null);p.municipalTerrain=squareTerrain(0);assert.equal(suggestRoadTunnel(p,r),null);
  p.municipalTerrain={name:'斜坡',visible:true,points:[{id:'a',x:0,y:0,z:-2},{id:'b',x:40,y:0,z:2},{id:'c',x:40,y:20,z:2},{id:'d',x:0,y:20,z:-2}]};
  const suggestion=suggestRoadTunnel(p,r);near(suggestion.startStation,10.5);near(suggestion.endStation,20);near(suggestion.coveredLength,9.5);assert.match(suggestion.reason,/真实地形/);
  p.municipalTerrain={name:'间断测量',visible:true,points:[],raster:{format:'esri-ascii',ncols:6,nrows:3,xllcorner:0,yllcorner:0,cellSize:5,noDataValue:-9999,values:[2,2,2,null,2,2,2,2,2,null,2,2,2,2,2,null,2,2],coordinateUnit:'m',yDirection:'north-up',originX:0,originY:0}};
  const gap=suggestRoadTunnel(p,r);if(gap){assert.ok(gap.unknownLength>0);assert.ok(gap.coveredLength<20);}
});
test('unscaled drawings never report manufactured length, section or amount',()=>{
  const p=fixture(),r=road(p);p.drawing.type='image';p.calibration.metersPerPixel=null;const a=roadTunnelAnalysis(p,r);assert.equal(a.length,null);assert.equal(a.sectionArea,null);assert.deepEqual(roadTunnelGeometry(p,r).surfaces,[]);
});
test('tunnel schema rejects invalid dimensions, chainages, source prices and geometry, with no validator recursion',()=>{
  const p=fixture(),r=road(p),original=structuredClone(r.tunnel);assert.doesNotThrow(()=>validateMunicipalElements([r],p));
  for(const patch of [{endStation:21},{startStation:-1},{endStation:0},{clearHeight:0},{liningThickness:NaN},{shape:'round'},{unitPrice:'-1'},{laborRate:''},{priceSourceUnitPrice:'-1'},{priceMaterialId:''}]){r.tunnel={...original,...patch};assert.throws(()=>validateRoadTunnel(p,r),RangeError);}
  r.tunnel=original;r.points=[{x:1000,y:1000},{x:2000,y:1000},{x:1000,y:1001}];assert.throws(()=>validateRoadTunnel(p,r),RangeError);
});
test('section resource limits produce an explicit error instead of freezing the editor',()=>{
  const p=fixture(),r=road(p);r.points[1].x=10001000;p.drawing.width=10002000;r.tunnel.endStation=100000;r.roadProfile=createRoadProfile(p,r);r.roadProfile.points=[{id:'a',station:0,elevation:0},{id:'b',station:50000,elevation:10000,curveLength:50000},{id:'c',station:100000,elevation:0}];
  r.roadProfile.curveTolerance=.0001;assert.throws(()=>roadTunnelGeometry(p,r),new RegExp(String(MAX_TUNNEL_SECTIONS)));
});
test('asymmetric changing crossfall follows the real crown and preserves union volume without doubled voids',()=>{
  const p=fixture(),r=road(p);r.roadProfile=createRoadProfile(p,r);r.roadProfile.crossfallPoints=[{id:'a',station:0,leftSlope:-2,rightSlope:-2},{id:'b',station:20,leftSlope:6,rightSlope:-4}];
  const g=roadTunnelGeometry(p,r);near(g.analysis.voidVolume,600,.24);assert.ok(g.surfaces.some(s=>s.id.includes('inside')&&s.points.some(p=>Math.abs(p.z-10)<1e-8&&Math.abs(p.y-5)<1e-8)));
  const roof=[{x:5,y:2,z:5},{x:35,y:2,z:5},{x:35,y:2,z:15},{x:5,y:2,z:15}];near(sceneArea(subtractTunnelVoids(roof,g.voids)),180);
});
test('lining surfaces and tunnel portal metadata belong to the same selectable municipal road',()=>{
  const p=fixture(),r=road(p);const source=buildSceneMunicipal(p)[0];assert.equal(source.tunnel.enabled,true);assert.equal(source.tunnel.portals.length,2);assert.ok(source.surfaces.some(s=>s.id.includes(':tunnel:')));assert.ok(source.surfaces.filter(s=>s.id.includes(':tunnel:')).every(s=>s.wallId==='municipal:road'));
});
