import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.ROAD_PROFILE_BUILD?pathToFileURL(resolve(process.env.ROAD_PROFILE_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {createMunicipalElement,municipalMetrics}=await import(new URL('lib/municipal-design.js',root));
const {createRoadProfile,validateRoadProfile,normalizeRoadProfile,roadStations,roadProfileElevation,roadProfileGrade,roadVerticalCurves,roadCrossSectionAtStation,roadSurfaceErrorBound,roadControlStations,roadSideSlopeDesign,roadEarthworkDesignTriangles,roadProfileSegments,roadPointAtStation,roadStationAtPlanPoint,roadDesignTriangles,roadElevationAtPlanPoint,roadProfileAnalysis}=await import(new URL('lib/road-profile.js',root));
const {calculateTerrainEarthworks}=await import(new URL('lib/terrain.js',root));
const {createEarthworkBalance}=await import(new URL('lib/earthwork-balance.js',root));
const near=(a,b,eps=1e-7)=>assert.ok(Math.abs(Number(a)-b)<eps,`${a} != ${b}`);
const fixture=()=>({version:1,id:'roads',name:'真实道路纵断面',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:120000,height:90000,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},municipalElements:[],regions:[],walls:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const terrain=(elevation=0,maxX=50)=>({name:'实际测量地形',visible:true,points:[{id:'a',x:0,y:0,z:elevation},{id:'b',x:maxX,y:0,z:elevation},{id:'c',x:maxX,y:50,z:elevation},{id:'d',x:0,y:50,z:elevation}]});
const road=(p,points=[{x:1000,y:1000},{x:2000,y:1000}],patch={})=>{const item={...createMunicipalElement('road',points,p),id:'road',width:200,height:10,unitPrice:'0',...patch};p.municipalElements.push(item);return item;};
const enable=(p,item,heights=[1,1],patch={})=>{const profile=createRoadProfile(p,item);profile.points=heights.map((elevation,i)=>({id:'grade'+i,station:i*profile.points[1].station/(heights.length-1),elevation}));profile.earthwork={enabled:true,cutUnitPrice:'0',fillUnitPrice:'0'};Object.assign(profile,patch);item.roadProfile=profile;return profile;};
const area=triangles=>triangles.reduce((total,[a,b,c])=>total+Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2,0);

test('create genuine start/end stations and zero suggested market prices on an actual 10m route',()=>{
  const p=fixture(),item=road(p),profile=createRoadProfile(p,item);assert.equal(profile.points.length,2);near(profile.points[1].station,10);near(profile.points[0].elevation,0);assert.equal(profile.earthwork.cutUnitPrice,'');assert.equal(profile.earthwork.fillUnitPrice,'');assert.equal(profile.earthwork.enabled,false);assert.doesNotThrow(()=>validateRoadProfile(p,item,profile));
});
test('chainage follows real horizontal polyline length and calibrated source coordinates',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:1300,y:1400},{x:1300,y:1800}]);assert.deepEqual(roadStations(p,item),[0,5,9]);p.drawing.type='image';p.calibration.metersPerPixel=.02;assert.deepEqual(roadStations(p,item),[0,10,18]);near(roadPointAtStation(p,item,10).x,26);near(roadPointAtStation(p,item,10).y,28);
});
test('grade interpolation and design length use explicitly entered elevations at real stations',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[1,2,1]),segments=roadProfileSegments(p,item);near(roadProfileElevation(profile,2.5),1.5);near(roadProfileElevation(profile,7.5),1.5);near(segments[0].gradePercent,20);near(segments[1].gradePercent,-20);near(roadProfileAnalysis(p,item).designLength,2*Math.sqrt(26));
});
test('editing route length proportionally moves grade stations while retaining elevations and independent IDs',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[1,2,3]);item.points[1].x=3000;const normalized=normalizeRoadProfile(p,item);assert.deepEqual(normalized.points.map(point=>point.station),[0,10,20]);assert.deepEqual(normalized.points.map(point=>point.elevation),[1,2,3]);assert.deepEqual(profile.points.map(point=>point.station),[0,5,10]);assert.equal(normalized.points[1].id,profile.points[1].id);assert.doesNotThrow(()=>validateRoadProfile(p,item,normalized));
});
test('reject unsorted/duplicate/out-of-range grade stations, invalid numeric inputs and negative soil prices',()=>{
  const p=fixture(),item=road(p),original=enable(p,item);
  for(const change of[profile=>profile.points[0].station=1,profile=>profile.points[1].station=11,profile=>profile.points[1].station=0,profile=>profile.points[0].elevation=NaN,profile=>profile.points[0].id=profile.points[1].id,profile=>profile.sampleInterval=0,profile=>profile.earthwork.cutUnitPrice='-1',profile=>profile.points=[]]){const profile=structuredClone(original);change(profile);assert.throws(()=>validateRoadProfile(p,item,profile),RangeError);}
});
test('flat 10×2m road roof preserves exact footprint and all vertices share supplied absolute height',()=>{
  const p=fixture(),item=road(p);enable(p,item,[1,1]);const triangles=roadDesignTriangles(p,item);near(area(triangles),20);assert.ok(triangles.every(triangle=>triangle.every(point=>Math.abs(point.z-1)<1e-8)));near(roadElevationAtPlanPoint(p,item,{x:1500,y:1100}),1);near(municipalMetrics(item,p).area,20);
});
test('layer thickness is removed once before actual terrain fill, with exact decimal soil-cost calculation',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1]);item.items=[{id:'base',name:'真实基层',thickness:20,unit:'m³',unitPrice:'0',wasteRate:'0',laborRate:'0',additionalCost:'0'}];item.roadProfile.earthwork.fillUnitPrice='2.015';const a=roadProfileAnalysis(p,item);near(a.earthworks.formationDepth,.3);near(a.earthworks.fillVolume,14);near(a.earthworks.cutVolume,0);near(a.earthworks.coveredArea,20);assert.equal(a.earthworks.fillCost,'28.21');assert.equal(a.earthworks.total,'28.21');assert.equal(a.earthworks.complete,true);assert.equal(a.earthworks.pending,false);
});
test('a real slope crossing flat ground produces separate 6.05m³ cut and 4.05m³ fill without netting them',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[-1,1]);const a=roadProfileAnalysis(p,item);near(a.earthworks.cutVolume,6.05);near(a.earthworks.fillVolume,4.05);near(a.maxAbsGrade,.2);assert.equal(a.earthworks.complete,true);
});
test('intermediate grade changes partition the roof at the actual break, avoiding averaged end heights',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain(1);enable(p,item,[1,2,1]);const triangles=roadDesignTriangles(p,item),a=roadProfileAnalysis(p,item);near(area(triangles),20);near(roadElevationAtPlanPoint(p,item,{x:1500,y:1000}),2);near(a.earthworks.fillVolume,8.1);near(a.earthworks.cutVolume,.1);assert.ok(triangles.some(triangle=>triangle.some(point=>Math.abs(point.x-15)<1e-8&&Math.abs(point.z-2)<1e-8)));
});
test('L-route miter cross sections share the same grade height, conserve actual 40m² footprint and avoid double fill',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:2000,y:1000},{x:2000,y:2000}]);p.municipalTerrain=terrain();enable(p,item,[1,2,3]);const triangles=roadDesignTriangles(p,item);near(area(triangles),40);near(roadElevationAtPlanPoint(p,item,{x:1900,y:1100}),2);near(roadElevationAtPlanPoint(p,item,{x:2100,y:900}),2);const a=roadProfileAnalysis(p,item);assert.equal(a.earthworks.complete,true);near(a.earthworks.coveredArea,40);assert.doesNotThrow(()=>calculateTerrainEarthworks(p.municipalTerrain,triangles));
});
test('diagonal routes retain exact area and grade with rotation, using metre rather than pixel height',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:1600,y:1800}]);enable(p,item,[2,4]);const triangles=roadDesignTriangles(p,item);near(area(triangles),20);near(roadElevationAtPlanPoint(p,item,{x:1300,y:1400}),3);near(roadProfileAnalysis(p,item).maxAbsGrade,.2);
});
test('owned roadway footprint including an internal paving hole excludes soil once rather than masking only rendering',()=>{
  const p=fixture(),paving={...createMunicipalElement('paving',[{x:1400,y:950},{x:1500,y:950},{x:1500,y:1050},{x:1400,y:1050}],p),id:'paving',elevation:100,unitPrice:'0'};p.municipalElements=[paving];const item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1]);const triangles=roadDesignTriangles(p,item);near(area(triangles),19);near(roadProfileAnalysis(p,item).earthworks.fillVolume,17.1);
});
test('partial survey coverage yields only covered cut/fill and an explicit unknown remainder, never a full total',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain(0,15);enable(p,item,[1,1]);item.roadProfile.earthwork.fillUnitPrice='10';const earth=roadProfileAnalysis(p,item).earthworks;near(earth.coveredArea,10);near(earth.uncoveredArea,10);near(earth.fillVolume,9);assert.equal(earth.complete,false);assert.equal(earth.pending,true);assert.equal(earth.total,null);assert.equal(earth.knownCost,'90.00');assert.match(earth.pendingReason,/未完整覆盖/);
});
test('no survey does not manufacture ground elevations or soil volume and keeps enabled soil pricing pending',()=>{
  const p=fixture(),item=road(p);enable(p,item,[1,1]);const a=roadProfileAnalysis(p,item);assert.ok(a.rows.every(row=>row.groundElevation===null));near(a.earthworks.coveredArea,0);near(a.earthworks.uncoveredArea,20);assert.equal(a.earthworks.total,null);assert.equal(a.earthworks.pending,true);
});
test('empty soil prices remain pending while an explicit zero quote is valid with complete measured coverage',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1]);item.roadProfile.earthwork.cutUnitPrice='';item.roadProfile.earthwork.fillUnitPrice='';assert.equal(roadProfileAnalysis(p,item).earthworks.total,null);item.roadProfile.earthwork.cutUnitPrice='0';item.roadProfile.earthwork.fillUnitPrice='0';assert.equal(roadProfileAnalysis(p,item).earthworks.total,'0.00');assert.equal(roadProfileAnalysis(p,item).pending,false);
});
test('unpriced earthwork disabled preserves surface-only budget and can still display independently surveyed geometry',()=>{
  const p=fixture(),item=road(p);enable(p,item,[1,1]);item.roadProfile.earthwork.enabled=false;item.roadProfile.earthwork.cutUnitPrice='';item.roadProfile.earthwork.fillUnitPrice='';assert.equal(roadProfileAnalysis(p,item).pending,false);assert.equal(roadProfileAnalysis(p,item).earthworks.total,'0.00');item.roadProfile.enabled=false;assert.equal(roadProfileAnalysis(p,item).enabled,false);assert.equal(roadProfileAnalysis(p,item).earthworks,null);near(roadElevationAtPlanPoint(p,item,{x:1500,y:1000}),0);
});
test('without calibrated pixels no real roof triangles or ground samples are reported',()=>{
  const p=fixture(),item=road(p);enable(p,item,[1,1]);p.drawing.type='image';p.calibration.metersPerPixel=null;const a=roadProfileAnalysis(p,item);assert.equal(a.horizontalLength,null);assert.deepEqual(a.designTriangles,[]);assert.ok(a.rows.every(row=>row.x===null&&row.groundElevation===null));assert.equal(a.earthworks.pending,true);assert.match(a.earthworks.pendingReason,/未校准/);
});
test('sample interval changes graph density without changing exact terrain integration or grade design',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[-1,1]);item.roadProfile.sampleInterval=.1;const dense=roadProfileAnalysis(p,item);item.roadProfile.sampleInterval=10;const sparse=roadProfileAnalysis(p,item);assert.ok(dense.rows.length>sparse.rows.length);near(dense.earthworks.cutVolume,sparse.earthworks.cutVolume);near(dense.earthworks.fillVolume,sparse.earthworks.fillVolume);
});
test('station picking projects to actual polyline segments and returns physical chainage',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:2000,y:1000},{x:2000,y:2000}]);near(roadStationAtPlanPoint(p,item,{x:1600,y:1100}),6);near(roadStationAtPlanPoint(p,item,{x:2100,y:1400}),14);near(roadPointAtStation(p,item,14).x,20);near(roadPointAtStation(p,item,14).y,14);
});

test('several arbitrary route turns conserve the real footprint and cached triangles cannot be mutated by callers',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:2000,y:1500},{x:3000,y:1500},{x:3600,y:2500}]);p.municipalTerrain=terrain();enable(p,item,[1,1.2,1.8]);const triangles=roadDesignTriangles(p,item);near(area(triangles),municipalMetrics(item,p).area);assert.doesNotThrow(()=>calculateTerrainEarthworks(p.municipalTerrain,triangles));const original=triangles[0][0].z;triangles[0][0].z=900;near(roadDesignTriangles(p,item)[0][0].z,original);
});

const sideSlopes=(patch={})=>({enabled:true,leftCut:2,rightCut:2,leftFill:2,rightFill:2,maxWidth:10,interval:2,...patch});
test('symmetric parabolic crest and sag use actual curve elevation with tangent-continuous grades and exact arc length',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[0,1,0]);profile.points[1].curveLength=4;
  const [curve]=roadVerticalCurves(profile);near(curve.startStation,3);near(curve.endStation,7);near(curve.startElevation,.6);near(curve.endElevation,.6);near(roadProfileElevation(profile,5),.8);near(roadProfileGrade(profile,3),.2);near(roadProfileGrade(profile,5),0);near(roadProfileGrade(profile,7),-.2);
  const a=roadProfileAnalysis(p,item),primitive=g=>(g*Math.hypot(1,g)+Math.asinh(g))/2;near(a.designLength,6*Math.hypot(1,.2)+2*primitive(.2)/.1);near(a.maxAbsGrade,.2);assert.equal(a.segments.filter(segment=>segment.kind==='curve').length,1);
  profile.points.forEach((point,index)=>point.elevation=[1,0,1][index]);near(roadProfileElevation(profile,5),.2);near(roadProfileGrade(profile,3),-.2);near(roadProfileGrade(profile,7),.2);
});
test('vertical curve validation rejects overlaps, endpoint curves, invalid crossfall and slope configurations',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[0,1,0,1]);
  for(const mutate of [d=>d.points[0].curveLength=1,d=>d.points[1].curveLength=8,d=>{d.points[1].curveLength=4;d.points[2].curveLength=4;},d=>d.points[1].curveLength=-1,d=>d.curveTolerance=0,d=>d.crossSection=null,d=>d.crossSection={leftSlope:26,rightSlope:0},d=>d.sideSlopes=null,d=>d.sideSlopes=sideSlopes({leftFill:0}),d=>d.sideSlopes=sideSlopes({interval:0})]){const draft=structuredClone(profile);mutate(draft);assert.throws(()=>validateRoadProfile(p,item,draft),RangeError);}
  profile.points[1].curveLength=2;item.points[1].x=3000;const normalized=normalizeRoadProfile(p,item);near(normalized.points[1].curveLength,4);near(profile.points[1].curveLength,2);assert.doesNotThrow(()=>validateRoadProfile(p,item,normalized));
});
test('curve mesh meets declared chord error independently of ground graph interval and preserves plan area',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[0,1,0],{curveTolerance:.001});profile.points[1].curveLength=4;p.municipalTerrain=terrain();
  const controls=roadControlStations(p,item),triangles=roadDesignTriangles(p,item);near(area(triangles),20);
  for(let i=1;i<controls.length;i++){const middle=(controls[i-1]+controls[i])/2,actual=roadProfileElevation(profile,middle),mesh=roadElevationAtPlanPoint(p,item,{x:1000+middle*100,y:1000});assert.ok(Math.abs(actual-mesh)<=.001+1e-8);}
  profile.sampleInterval=.1;const dense=roadProfileAnalysis(p,item);profile.sampleInterval=100;const sparse=roadProfileAnalysis(p,item);assert.deepEqual(roadDesignTriangles(p,item),triangles);assert.ok(dense.rows.length>sparse.rows.length);assert.ok(sparse.rows.some(row=>Math.abs(row.station-5)<1e-8));near(dense.earthworks.fillVolume,sparse.earthworks.fillVolume);near(dense.earthworks.cutVolume,sparse.earthworks.cutVolume);
});
test('signed independent crossfall forms a shared centre ridge and updates exact area and cost',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1],{crossSection:{leftSlope:-2,rightSlope:-4}});item.roadProfile.earthwork.fillUnitPrice='2';
  near(roadElevationAtPlanPoint(p,item,{x:1500,y:1100}),.98);near(roadElevationAtPlanPoint(p,item,{x:1500,y:900}),.96);near(roadElevationAtPlanPoint(p,item,{x:1500,y:1000}),1);near(area(roadDesignTriangles(p,item)),20);near(roadProfileAnalysis(p,item).earthworks.fillVolume,17.7);assert.equal(roadProfileAnalysis(p,item).earthworks.total,'35.40');
  item.roadProfile.crossSection.leftSlope=2;near(roadElevationAtPlanPoint(p,item,{x:1500,y:1100}),1.02);near(roadProfileAnalysis(p,item).earthworks.fillVolume,17.9);
});
test('flat TIN daylight gives 1.8m fill slopes and exact 34.2m³ combined earthwork without counting pavement',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1],{sideSlopes:sideSlopes()});item.roadProfile.earthwork.fillUnitPrice='2';
  const side=roadSideSlopeDesign(p,item),a=roadProfileAnalysis(p,item);assert.equal(side.complete,true);assert.ok(side.sections.length>=6);side.sections.forEach(row=>{near(row.left.width,1.8);near(row.right.width,1.8);near(row.left.outer.z,0);assert.equal(row.left.kind,'fill');});near(area(side.triangles),36);near(a.earthworks.fillVolume,34.2);near(a.earthworks.cutVolume,0);assert.equal(a.earthworks.total,'68.40');assert.doesNotThrow(()=>calculateTerrainEarthworks(p.municipalTerrain,roadEarthworkDesignTriangles(p,item)));
  side.triangles[0][0].z=99;near(roadSideSlopeDesign(p,item).triangles[0][0].z,.9);
});
test('cut and asymmetric TIN daylight solve real linear intersections rather than using flat-ground guesses',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[-.9,-.9],{sideSlopes:sideSlopes({leftCut:1.5,rightCut:1.5})});const cut=roadProfileAnalysis(p,item);near(cut.sideSlopeDesign.sections[0].left.width,1.5);near(cut.earthworks.cutVolume,35);near(cut.earthworks.fillVolume,0);
  p.municipalTerrain.points.forEach(point=>point.z=(point.y-10)*.1);item.roadProfile.points.forEach(point=>point.elevation=1);const sloping=roadProfileAnalysis(p,item);near(sloping.sideSlopeDesign.sections[0].left.width,4/3);near(sloping.sideSlopeDesign.sections[0].right.width,2.5);near(sloping.earthworks.fillVolume,18+16/3+12.5);assert.equal(sloping.earthworks.complete,true);
});
test('cut to fill transitions add actual zero-depth control sections and never create overlapping slope strips',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[-1,1],{sideSlopes:sideSlopes()});const a=roadProfileAnalysis(p,item);assert.ok(a.sideSlopeDesign.sections.some(section=>Math.abs(section.station-5.5)<1e-7));assert.ok(a.sideSlopeDesign.sections.some(section=>section.left.kind==='cut'));assert.ok(a.sideSlopeDesign.sections.some(section=>section.left.kind==='fill'));assert.equal(a.earthworks.complete,true);assert.doesNotThrow(()=>calculateTerrainEarthworks(p.municipalTerrain,roadEarthworkDesignTriangles(p,item)));
});
test('maximum width and missing measured coverage keep slope totals pending with explicit reasons',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1],{sideSlopes:sideSlopes({maxWidth:.5})});let a=roadProfileAnalysis(p,item);assert.equal(a.sideSlopeDesign.complete,false);assert.equal(a.sideSlopeDesign.sections[0].left.status,'limit');assert.match(a.earthworks.pendingReason,/最大找坡宽度/);assert.equal(a.earthworks.total,null);near(a.earthworks.fillVolume,18);
  item.roadProfile.sideSlopes.maxWidth=10;p.municipalTerrain=terrain(0,15);a=roadProfileAnalysis(p,item);assert.equal(a.sideSlopeDesign.complete,false);assert.equal(a.earthworks.total,null);assert.match(a.earthworks.pendingReason,/连续覆盖/);
});
test('deducted roadways and cross-road daylight intersections cannot silently repeat side-slope quantities',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();enable(p,item,[1,1],{sideSlopes:sideSlopes()});const owner={...item,id:'first-owner',roadProfile:structuredClone(item.roadProfile)};p.municipalElements.unshift(owner);let a=roadProfileAnalysis(p,item);near(a.earthworks.designArea,0);near(a.earthworks.fillVolume,0);assert.equal(a.earthworks.complete,true);assert.deepEqual(a.sideSlopeDesign.triangles,[]);
  p.municipalElements=[item];const paving={...createMunicipalElement('paving',[{x:1400,y:950},{x:1500,y:950},{x:1500,y:1050},{x:1400,y:1050}],p),id:'pave',elevation:100};p.municipalElements.unshift(paving);a=roadProfileAnalysis(p,item);assert.equal(a.earthworks.complete,false);assert.match(a.earthworks.pendingReason,/净轮廓/);near(a.earthworks.fillVolume,17.1);
  p.municipalElements=[item];const other=road(p,[{x:1000,y:1450},{x:2000,y:1450}],{id:'other'});enable(p,other,[1,1],{sideSlopes:sideSlopes()});a=roadProfileAnalysis(p,item);assert.equal(a.earthworks.complete,false);assert.match(a.earthworks.pendingReason,/其它道路或边坡/);assert.deepEqual(a.sideSlopeDesign.triangles,[]);assert.equal(roadProfileAnalysis(p,other).earthworks.complete,false);
});

const crossfallPoints=(length=10)=>[{id:'cross-start',station:0,leftSlope:-2,rightSlope:-2},{id:'cross-end',station:length,leftSlope:6,rightSlope:-6}];
test('crossfall interpolation is signed, piecewise linear and backward compatible with constant sections',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[1,1],{crossSection:{leftSlope:-2,rightSlope:-3}}),legacy=roadDesignTriangles(p,item);
  assert.deepEqual(roadCrossSectionAtStation(profile,3),{leftSlope:-2,rightSlope:-3});profile.crossfallPoints=[{id:'a',station:0,leftSlope:-2,rightSlope:-3},{id:'b',station:10,leftSlope:-2,rightSlope:-3}];assert.deepEqual(roadDesignTriangles(p,item),legacy);
  profile.crossfallPoints=[{id:'a',station:0,leftSlope:-2,rightSlope:2},{id:'b',station:4,leftSlope:2,rightSlope:-2},{id:'c',station:10,leftSlope:8,rightSlope:-8}];
  assert.deepEqual(roadCrossSectionAtStation(profile,2),{leftSlope:0,rightSlope:0});assert.deepEqual(roadCrossSectionAtStation(profile,7),{leftSlope:5,rightSlope:-5});assert.deepEqual(roadCrossSectionAtStation(profile,-1),{leftSlope:-2,rightSlope:2});assert.deepEqual(roadCrossSectionAtStation(profile,20),{leftSlope:8,rightSlope:-8});assert.throws(()=>roadCrossSectionAtStation(profile,NaN),RangeError);
  const normalized=normalizeRoadProfile(p,{...item,points:[item.points[0],{x:3000,y:1000}]});assert.deepEqual(normalized.crossfallPoints.map(point=>point.station),[0,8,20]);assert.deepEqual(profile.crossfallPoints.map(point=>point.station),[0,4,10]);assert.equal(normalized.crossfallPoints[1].id,'b');
});
test('invalid crossfall tables cannot introduce unordered, missing or out-of-range design data',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item,[1,1],{crossfallPoints:crossfallPoints()});
  for(const mutate of [d=>d.crossfallPoints=[],d=>d.crossfallPoints=null,d=>d.crossfallPoints[0].station=1,d=>d.crossfallPoints[1].station=9,d=>d.crossfallPoints[1].station=0,d=>d.crossfallPoints[1].id=d.crossfallPoints[0].id,d=>d.crossfallPoints[1].leftSlope=26,d=>d.crossfallPoints[1].rightSlope=NaN]){const draft=structuredClone(profile);mutate(draft);assert.throws(()=>validateRoadProfile(p,item,draft),RangeError);}
});
test('real triangle interior crossfall transition errors meet declared tolerance, not just centre and edges',()=>{
  const p=fixture(),item=road(p,undefined,{width:600}),profile=enable(p,item,[1,1],{crossfallPoints:crossfallPoints(),curveTolerance:.001}),controls=roadControlStations(p,item),triangles=roadDesignTriangles(p,item);
  assert.ok(controls.length>20);near(area(triangles),60);for(let i=1;i<controls.length;i++)assert.ok(roadSurfaceErrorBound(p,item,controls[i-1],controls[i])<=.001+1e-10);
  let maxError=0;for(const triangle of triangles){const point={x:triangle[0].x*.2+triangle[1].x*.3+triangle[2].x*.5,y:triangle[0].y*.2+triangle[1].y*.3+triangle[2].y*.5,z:triangle[0].z*.2+triangle[1].z*.3+triangle[2].z*.5},station=point.x-10,side=point.y>=10?'leftSlope':'rightSlope',r=Math.abs(point.y-10)/3,reference=roadProfileElevation(profile,station)+r*3*roadCrossSectionAtStation(profile,station)[side]/100;maxError=Math.max(maxError,Math.abs(point.z-reference));}assert.ok(maxError>1e-5);assert.ok(maxError<=.001+1e-8);
});
test('parabola and changing crossfall jointly meet interior error tolerance in a turned miter plan',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:2000,y:1000},{x:2000,y:2000}]),profile=enable(p,item,[1,2,1],{crossfallPoints:[{id:'a',station:0,leftSlope:-2,rightSlope:-2},{id:'b',station:8,leftSlope:1,rightSlope:-4},{id:'c',station:20,leftSlope:6,rightSlope:-6}],curveTolerance:.001});profile.points[1].curveLength=4;
  const controls=roadControlStations(p,item);for(let i=1;i<controls.length;i++)assert.ok(roadSurfaceErrorBound(p,item,controls[i-1],controls[i])<=.001+1e-10);near(area(roadDesignTriangles(p,item)),40);
  let maxError=0;for(const station of[.31,2.47,7.83,9.13,9.87,10,10.37,11.83,16.27,19.13])for(const side of['leftSlope','rightSlope'])for(const r of[.13,.37,.61,.89]){
    const left=side==='leftSlope',u=station<=10?station:station-10,sign=left?1:-1,point=station<=10?{x:10+u-sign*r*u/10,y:10+sign*r}:{x:20-sign*r,y:10+u+sign*r*(1-u/10)},reference=roadProfileElevation(profile,station)+r*roadCrossSectionAtStation(profile,station)[side]/100,actual=roadElevationAtPlanPoint(p,item,{x:point.x*100,y:point.y*100});maxError=Math.max(maxError,Math.abs(actual-reference));
  }assert.ok(maxError<=.001+1e-8);assert.ok(maxError>1e-6);
});
test('crossfall road and daylight geometry remain shared when graph samples or prices change',()=>{
  const p=fixture(),item=road(p,[{x:1000,y:1000},{x:2000,y:1000},{x:2000,y:2000}]),profile=enable(p,item,[1,1,1],{crossfallPoints:crossfallPoints(20),sideSlopes:sideSlopes(),curveTolerance:.001});p.municipalTerrain=terrain();
  const initial=roadProfileAnalysis(p,item),mesh=roadDesignTriangles(p,item),side=roadSideSlopeDesign(p,item);assert.ok(side.sections.some(row=>Math.abs(row.station-10)<1e-7));
  for(const row of side.sections){const crossfall=roadCrossSectionAtStation(profile,row.station);near(row.left.edge.z,.9+crossfall.leftSlope/100);near(row.right.edge.z,.9+crossfall.rightSlope/100);if(row.left.status==='complete')near(row.left.width,row.left.edge.z*2);if(row.right.status==='complete')near(row.right.width,row.right.edge.z*2);}
  profile.sampleInterval=100;profile.earthwork.fillUnitPrice='3';const changed=roadProfileAnalysis(p,item);assert.deepEqual(roadDesignTriangles(p,item),mesh);assert.deepEqual(roadSideSlopeDesign(p,item),side);near(changed.earthworks.fillVolume,initial.earthworks.fillVolume);near(changed.earthworks.cutVolume,initial.earthworks.cutVolume);assert.doesNotThrow(()=>calculateTerrainEarthworks(p.municipalTerrain,roadEarthworkDesignTriangles(p,item)));
});
test('crossfall surface over 4000 controls and folded miter mappings are explicitly rejected',()=>{
  const p=fixture(),item=road(p,undefined,{width:40000});enable(p,item,[1,1],{crossfallPoints:[{id:'a',station:0,leftSlope:-25,rightSlope:25},{id:'b',station:10,leftSlope:25,rightSlope:-25}],curveTolerance:.0001});assert.throws(()=>roadControlStations(p,item),/4000/);
  const q=fixture(),folded=road(q);folded.points=[{x:1000,y:1000},{x:1100,y:1000},{x:1100,y:1100}];folded.width=800;enable(q,folded,[1,1],{crossfallPoints:crossfallPoints(2)});assert.throws(()=>roadDesignTriangles(q,folded),/路缘沿线折返/);
});
const balanceConfig=()=>({...createEarthworkBalance(),enabled:true,usableCutPercent:'70',naturalPerCompactedFill:'1.1',loosePerNatural:'1.25',borrowMaterial:{enabled:true,unitPrice:'10'},borrowHaul:{enabled:true,distanceKm:'5',unitPrice:'.8'}});
test('road balance derives supply from actual 6.05 cut and 4.05 fill while cut/fill pricing remains disabled',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();const profile=enable(p,item,[-1,1]);profile.earthwork={enabled:false,cutUnitPrice:'',fillUnitPrice:''};profile.earthworkBalance=balanceConfig();
  const a=roadProfileAnalysis(p,item),balance=a.earthworkBalance;near(a.earthworks.cutVolume,6.05);near(a.earthworks.fillVolume,4.05);assert.equal(a.earthworks.pending,false);assert.equal(a.earthworks.enabled,false);
  assert.equal(balance.volumes.reuseNatural,'4.235');assert.equal(balance.volumes.fillDemandNatural,'4.455');assert.equal(balance.volumes.borrowNatural,'0.22');assert.equal(balance.volumes.spoilNatural,'1.815');assert.equal(balance.knownCost,'3.30');assert.equal(balance.pending,false);assert.equal(a.pending,false);
});
test('balance coefficients, enabled budgets and prices never invalidate real road surface or daylight geometry',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain();const profile=enable(p,item,[1,1],{sideSlopes:sideSlopes()});profile.earthworkBalance=balanceConfig();
  const first=roadProfileAnalysis(p,item),surface=roadDesignTriangles(p,item),slopes=roadSideSlopeDesign(p,item);profile.earthworkBalance.naturalPerCompactedFill='1.3';profile.earthworkBalance.borrowHaul.distanceKm='9';profile.earthworkBalance.borrowMaterial.unitPrice='15';
  const changed=roadProfileAnalysis(p,item);assert.deepEqual(roadDesignTriangles(p,item),surface);assert.deepEqual(roadSideSlopeDesign(p,item),slopes);near(changed.earthworks.fillVolume,first.earthworks.fillVolume);assert.notEqual(changed.earthworkBalance.knownCost,first.earthworkBalance.knownCost);
});
test('partial coverage and unresolved slopes block every derived balance item even with cut/fill pricing off',()=>{
  const p=fixture(),item=road(p);p.municipalTerrain=terrain(0,15);const profile=enable(p,item,[-1,1]);profile.earthwork.enabled=false;profile.earthworkBalance=balanceConfig();let a=roadProfileAnalysis(p,item);
  assert.equal(a.earthworks.pending,false);assert.equal(a.earthworks.complete,false);assert.equal(a.earthworkBalance.volumes,null);assert.equal(a.earthworkBalance.totalCost,null);assert.equal(a.pending,true);assert.ok(a.earthworkBalance.items.every(item=>item.quantity===null));assert.match(a.earthworkBalance.pendingReason,/部分挖填/);
  p.municipalTerrain=terrain();profile.sideSlopes=sideSlopes({maxWidth:.1});a=roadProfileAnalysis(p,item);assert.equal(a.earthworkBalance.volumes,null);assert.match(a.earthworkBalance.pendingReason,/最大找坡宽度/);
});
test('disabled road profile cannot provide a fabricated balance and new configuration is validated on project import',()=>{
  const p=fixture(),item=road(p),profile=enable(p,item);profile.enabled=false;profile.earthworkBalance=balanceConfig();const a=roadProfileAnalysis(p,item);
  assert.equal(a.earthworkBalance.cutNaturalVolume,null);assert.equal(a.earthworkBalance.volumes,null);assert.equal(a.pending,true);assert.match(a.earthworkBalance.pendingReason,/启用道路纵断面/);
  profile.earthworkBalance.usableCutPercent='101';assert.throws(()=>validateRoadProfile(p,item),RangeError);
});
test('separate road balances neither share material nor double count borrow across other roads',()=>{
  const p=fixture(),cutRoad=road(p,undefined,{id:'cut'}),fillRoad=road(p,[{x:1000,y:1600},{x:2000,y:1600}],{id:'fill'});p.municipalTerrain=terrain();
  for(const [item,z] of [[cutRoad,-1],[fillRoad,1]]){const profile=enable(p,item,[z,z]);profile.earthwork.enabled=false;profile.earthworkBalance=balanceConfig();}
  const cut=roadProfileAnalysis(p,cutRoad).earthworkBalance,fill=roadProfileAnalysis(p,fillRoad).earthworkBalance;
  assert.equal(cut.volumes.borrowNatural,'0');assert.equal(cut.volumes.spoilNatural,'22');assert.equal(fill.volumes.borrowNatural,'19.8');assert.equal(fill.volumes.reuseNatural,'0');
});
