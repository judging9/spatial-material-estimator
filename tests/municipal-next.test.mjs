import assert from 'node:assert/strict';
import test from 'node:test';
import { createMunicipalElement, municipalFootprints } from '../static/studio/lib/municipal-design.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { roadCrossSectionAtStation, roadProfileAnalysis, normalizeRoadProfile } from '../static/studio/lib/road-profile.js';
import { exportProjectJSON, importProjectJSON, createMemoryProjectStore } from '../static/studio/lib/persistence.js';
import { municipalToCSV, renderMunicipalQuoteHTML } from '../static/studio/lib/municipal-export.js';
import { parseTerrainGeoTIFF } from '../static/studio/lib/terrain-geotiff.js';
import { simulateHydraulicNetwork } from '../static/studio/lib/hydraulic-simulation.js';
import { createGeoTIFF } from './helpers/geotiff-fixture.mjs';

const near=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(Number(actual)-expected)<=tolerance,`${actual} != ${expected}`);
function roadway(){
  const p={version:1,id:'progressive-site',name:'道路横坡过渡',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'本地画板',width:3000,height:3000,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000"></svg>')},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};
  p.municipalTerrain={name:'实际输入平地',visible:true,points:[{id:'a',x:0,y:0,z:0},{id:'b',x:30,y:0,z:0},{id:'c',x:30,y:30,z:0},{id:'d',x:0,y:30,z:0}]};
  const road=createMunicipalElement('road',[{x:500,y:1000},{x:1500,y:1000}],p);
  Object.assign(road,{width:200,height:10,unitPrice:'0',laborRate:'0',additionalCost:'0',roadProfile:{enabled:true,points:[{id:'a',station:0,elevation:1},{id:'b',station:10,elevation:1}],sampleInterval:1,curveTolerance:.002,earthwork:{enabled:true,cutUnitPrice:'0',fillUnitPrice:'2'},crossfallPoints:[{id:'cf-a',station:0,leftSlope:0,rightSlope:0},{id:'cf-b',station:10,leftSlope:-10,rightSlope:-10}]}});
  p.municipalElements=[road];return p;
}

test('真实横坡过渡进入路面、土方与预算，图表采样不会改变设计面',()=>{
  const p=roadway(),road=p.municipalElements[0],analysis=roadProfileAnalysis(p,road),q=calculateMunicipalProject(p);
  near(roadCrossSectionAtStation(road.roadProfile,5).leftSlope,-5);
  near(q.municipalElements[0].area,20);
  // The exact continuous surface loses 0.5m³ from the flat 18m³ formation.
  // The declared 2mm surface approximation bounds volume error by 20m²×2mm.
  near(analysis.earthworks.fillVolume,17.5,20*.002+1e-7);
  assert.equal(analysis.earthworks.complete,true);assert.equal(q.pending,false);
  assert.equal(q.municipalElements[0].items.find(item=>item.id.endsWith(':fillVolume')).total,analysis.earthworks.fillCost);
  const before=buildSceneMunicipal(p)[0].surfaces;
  road.roadProfile.sampleInterval=10;
  assert.deepEqual(buildSceneMunicipal(p)[0].surfaces,before);
  assert.equal(calculateMunicipalProject(p).total,q.total);
});

test('横坡过渡的重复副本和反向等价路线仅计一次实际占地',()=>{
  const p=roadway(),road=p.municipalElements[0],copy=structuredClone(road);
  copy.id='copy';copy.roadProfile.crossfallPoints.forEach(point=>point.id+='-copy');p.municipalElements.push(copy);
  assert.equal(municipalFootprints(copy,p).length,0);
  copy.points.reverse();copy.roadProfile.points.reverse();
  copy.roadProfile.points.forEach(point=>point.station=10-point.station);
  copy.roadProfile.crossfallPoints.reverse();
  copy.roadProfile.crossfallPoints.forEach(point=>{point.station=10-point.station;[point.leftSlope,point.rightSlope]=[point.rightSlope,point.leftSlope];});
  assert.equal(municipalFootprints(copy,p).length,0);
  assert.equal(calculateMunicipalProject(p).total,calculateMunicipalProject({...p,municipalElements:[road]}).total);
});

test('恒定里程表与旧横坡等价，里程表覆盖保留的旧设置',()=>{
  const p=roadway(),road=p.municipalElements[0];
  road.roadProfile.crossfallPoints.forEach(point=>{point.leftSlope=-2;point.rightSlope=-3;});
  road.roadProfile.crossSection={leftSlope:20,rightSlope:20};
  const copy=structuredClone(road);copy.id='legacy';delete copy.roadProfile.crossfallPoints;
  copy.roadProfile.crossSection={leftSlope:-2,rightSlope:-3};p.municipalElements.push(copy);
  assert.equal(municipalFootprints(copy,p).length,0);
});

test('里程表编辑使三维和计量缓存更新，不同施工面不误扣成零量',()=>{
  const p=roadway(),road=p.municipalElements[0],copy=structuredClone(road);copy.id='edit';p.municipalElements.push(copy);
  assert.equal(municipalFootprints(copy,p).length,0);
  const before=buildSceneMunicipal({...p,municipalElements:[road]})[0].surfaces;
  copy.roadProfile.crossfallPoints[1].leftSlope=5;
  assert.ok(municipalFootprints(copy,p).length>0);
  assert.notDeepEqual(buildSceneMunicipal({...p,municipalElements:[copy]})[0].surfaces,before);
  near(calculateMunicipalProject(p).municipalElements[1].area,20);
});

test('路线改长同比移动横坡里程，用户设计横坡不被重置',()=>{
  const p=roadway(),road=p.municipalElements[0];road.points[1].x=2500;
  const changed=normalizeRoadProfile(p,road);
  near(changed.crossfallPoints[1].station,20);assert.equal(changed.crossfallPoints[1].leftSlope,-10);
  assert.equal(road.roadProfile.crossfallPoints[1].station,10);
});

test('渐变横坡保存重开后保留设计与报价，CSV和打印单注明里程参数',async()=>{
  const p=roadway(),q=calculateMunicipalProject(p),store=createMemoryProjectStore();
  await store.saveProject(p);const local=await store.loadProject(p.id),loaded=await importProjectJSON(await exportProjectJSON(p));
  assert.deepEqual(local.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
  assert.deepEqual(loaded.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
  assert.equal(loaded.quoteSummary.total,q.total);
  const csv=municipalToCSV(p,q,value=>'"'+String(value??'').replaceAll('"','""')+'"');
  assert.equal(csv.split('\r\n')[1].split('","').length,25);assert.match(csv,/横坡里程表/);assert.match(csv,/线性过渡/);
  const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  assert.match(renderMunicipalQuoteHTML(p,q,{},escape),/横坡里程表/);
});

test('无效横坡里程数据不能覆盖已保存项目',async()=>{
  const p=roadway(),store=createMemoryProjectStore();await store.saveProject(p);
  const bad=structuredClone(p);bad.municipalElements[0].roadProfile.crossfallPoints[1].station=0;
  await assert.rejects(async()=>store.saveProject(bad));
  assert.deepEqual((await store.loadProject(p.id)).municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
});

test('真实GeoTIFF、渐变横坡和自动液位调度在同一项目保存重开后完整保留',async()=>{
  const p=roadway(),buffer=createGeoTIFF({rows:[[0,0,0],[0,0,0],[0,0,0]],originX:13500000,originY:4000000,cellSize:10});
  const parsed=await parseTerrainGeoTIFF(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),{placement:'local'});
  p.municipalTerrain={name:'已导入实测米制地形',visible:true,points:[],raster:parsed.raster,rasterSource:parsed.source};
  p.municipalHydraulics={mode:'pressure',nodes:[
    {id:'r',name:'供水边界',x:0,y:0,elevation:0,type:'reservoir',head:0,demand:null},
    {id:'t',name:'储水池',x:10,y:0,elevation:0,type:'tank',head:null,demand:1,tank:{area:1,minLevel:0,maxLevel:5,initialLevel:1.5}}
  ],links:[{id:'p',name:'进水泵',from:'r',to:'t',length:10,diameter:100,roughness:120,minorLoss:0,pump:{enabled:false,curve:[{flow:0,head:20},{flow:10,head:0}]}}],simulation:{duration:3600,step:120,events:[],controls:[{id:'c',enabled:true,tankId:'t',linkId:'p',device:'pump',strategy:'fill',lowLevel:2,highLevel:4}]}};
  const before=simulateHydraulicNetwork(p.municipalHydraulics);
  assert.equal(before.status,'ready');assert.ok(before.controlLog.length>=2);assert.ok(before.maxMassBalanceError<1e-6);
  const q=calculateMunicipalProject(p),store=createMemoryProjectStore();await store.saveProject(p);
  const local=await store.loadProject(p.id),loaded=await importProjectJSON(await exportProjectJSON(p));
  for(const restored of [local,loaded]){
    assert.deepEqual(restored.municipalTerrain,p.municipalTerrain);
    assert.deepEqual(restored.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
    assert.deepEqual(restored.municipalHydraulics,p.municipalHydraulics);
    assert.equal(calculateMunicipalProject(restored).total,q.total);
    const after=simulateHydraulicNetwork(restored.municipalHydraulics);assert.equal(after.status,'ready');
    assert.deepEqual(after.controlLog,before.controlLog);near(after.frames.at(-1).tanks[0].level,before.frames.at(-1).tanks[0].level);
  }
  const bad=structuredClone(p);bad.municipalHydraulics.simulation.controls[0].highLevel=2;
  await assert.rejects(async()=>store.saveProject(bad));assert.deepEqual((await store.loadProject(p.id)).municipalHydraulics,p.municipalHydraulics);
});
