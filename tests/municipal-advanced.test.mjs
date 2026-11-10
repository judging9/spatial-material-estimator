import assert from 'node:assert/strict';
import test from 'node:test';
import { createMunicipalElement, municipalFootprints } from '../static/studio/lib/municipal-design.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { roadProfileElevation, roadProfileAnalysis, roadSideSlopeDesign } from '../static/studio/lib/road-profile.js';
import { exportProjectJSON, importProjectJSON, createMemoryProjectStore } from '../static/studio/lib/persistence.js';
import { municipalToCSV } from '../static/studio/lib/municipal-export.js';
import { parseTerrainASCIIGrid } from '../static/studio/lib/terrain.js';
import { solveHydraulicNetwork } from '../static/studio/lib/hydraulics.js';
import { simulateHydraulicNetwork } from '../static/studio/lib/hydraulic-simulation.js';

const near=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected}`);
const site=()=>({version:1,id:'advanced-site',name:'真实高级场地',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:100000,height:90000,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
function roadway(){
  const p=site();
  p.municipalTerrain={name:'实测平地',visible:true,points:[{id:'a',x:0,y:0,z:0},{id:'b',x:30,y:0,z:0},{id:'c',x:30,y:30,z:0},{id:'d',x:0,y:30,z:0}]};
  const road=createMunicipalElement('road',[{x:500,y:1000},{x:1500,y:1000}],p);
  Object.assign(road,{width:200,height:10,unitPrice:'0',laborRate:'0',additionalCost:'0',roadProfile:{enabled:true,points:[{id:'a',station:0,elevation:1},{id:'b',station:10,elevation:1}],sampleInterval:1,earthwork:{enabled:true,cutUnitPrice:'0',fillUnitPrice:'2'},sideSlopes:{enabled:true,leftCut:2,rightCut:2,leftFill:2,rightFill:2,maxWidth:5,interval:1}}});
  p.municipalElements=[road];return p;
}

test('真实两侧1:2填方边坡进入路床土方量和报价，铺装面积仍按路面计量',()=>{
  const p=roadway(),q=calculateMunicipalProject(p),earth=q.municipalElements[0].roadEngineering.earthworks;
  assert.equal(earth.complete,true);near(earth.fillVolume,34.2);near(earth.cutVolume,0);
  near(q.municipalElements[0].area,20);assert.equal(q.total,'68.40');
});

test('转角道路的极小裁切土方按既有精度归零，报价和项目重开不会报数值越界',async()=>{
  const p=roadway(),road=p.municipalElements[0];
  p.municipalTerrain.points=[{id:'a',x:0,y:0,z:0},{id:'b',x:50,y:0,z:0},{id:'c',x:50,y:50,z:0},{id:'d',x:0,y:50,z:0}];
  road.points=[{x:500,y:500},{x:1500,y:500},{x:1500,y:1500}];
  Object.assign(road.roadProfile,{points:[{id:'a',station:0,elevation:1},{id:'b',station:20,elevation:1}],sampleInterval:.5,crossSection:{leftSlope:0,rightSlope:0},curveTolerance:.002});
  Object.assign(road.roadProfile.sideSlopes,{maxWidth:10,interval:2});
  const earth=roadProfileAnalysis(p,road).earthworks;
  assert.equal(earth.complete,true);assert.ok(earth.cutVolume>=0&&earth.cutVolume<5e-10);
  near(earth.fillVolume,64.53343983436504);
  const q=calculateMunicipalProject(p);
  assert.equal(q.municipalElements[0].items.find(item=>item.id.endsWith(':cutVolume')).netQuantity,'0');
  assert.equal(q.total,'129.07');
  const loaded=await importProjectJSON(await exportProjectJSON(p));
  assert.equal(loaded.quoteSummary.total,'129.07');assert.equal(calculateMunicipalProject(loaded).total,q.total);
});

test('接近计量舍入边界的道路土方预览与最终报价使用相同十进制规则',()=>{
  for(const base of [1,2,4,8,16])for(let offset=0;offset<6;offset++){
    const p=roadway(),road=p.municipalElements[0];
    road.roadProfile.sideSlopes.enabled=false;
    const elevation=.1+(base+(offset+.5)*1e-9)/20;
    road.roadProfile.points.forEach(point=>point.elevation=elevation);
    road.roadProfile.earthwork.fillUnitPrice='10000000';
    const analysis=roadProfileAnalysis(p,road),q=calculateMunicipalProject(p);
    assert.equal(analysis.earthworks.total,q.total,`volume=${analysis.earthworks.fillVolume}`);
  }
});

test('三维边坡与计价使用同一控制面，真实地面交点没有被缩放或隐藏改变',()=>{
  const p=roadway(),design=roadSideSlopeDesign(p,p.municipalElements[0]);
  assert.equal(design.complete,true);assert.ok(design.triangles.length>0);
  const scene=buildSceneMunicipal(p)[0],slopes=scene.surfaces.filter(surface=>surface.id.includes(':slope:'));
  assert.equal(slopes.length,design.triangles.length);
  const heights=slopes.flatMap(surface=>surface.points.map(point=>point.y));near(Math.min(...heights),0);near(Math.max(...heights),.9);
  const total=calculateMunicipalProject(p).total;p.municipalTerrain.visible=false;assert.equal(calculateMunicipalProject(p).total,total);
});

test('未找到边坡与实测地形交点时完整报价保持待确认',()=>{
  const p=roadway();p.municipalElements[0].roadProfile.sideSlopes.maxWidth=.5;
  const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.pending,true);
  assert.match(q.pendingReason,/边坡|放坡/);
});

test('横坡不同的道路不会被误当成同标高平板；相同冠形道路副本只计一次',()=>{
  const p=roadway(),road=p.municipalElements[0];road.roadProfile.sideSlopes.enabled=false;
  road.roadProfile.crossSection={leftSlope:-2,rightSlope:-2};
  const copy=structuredClone(road);copy.id='copy';p.municipalElements.push(copy);
  assert.equal(municipalFootprints(copy,p).length,0);
  copy.roadProfile.crossSection={leftSlope:2,rightSlope:2};
  near(calculateMunicipalProject(p).municipalElements[1].area,20);
});

test('反向路线交换左右横坡后仍归属同一真实设计面',()=>{
  const p=roadway(),road=p.municipalElements[0];road.roadProfile.sideSlopes.enabled=false;
  road.roadProfile.crossSection={leftSlope:-2,rightSlope:-3};
  const reversed=structuredClone(road);reversed.id='reverse';reversed.points.reverse();
  reversed.roadProfile.points.reverse();reversed.roadProfile.points.forEach(point=>point.station=10-point.station);
  reversed.roadProfile.crossSection={leftSlope:-3,rightSlope:-2};p.municipalElements.push(reversed);
  assert.equal(municipalFootprints(reversed,p).length,0);
});

test('真实竖曲线与横坡写入3D设计面，图表采样不是几何控制精度',()=>{
  const p=roadway(),road=p.municipalElements[0];road.roadProfile.sideSlopes.enabled=false;
  road.roadProfile.points=[{id:'a',station:0,elevation:0},{id:'pvi',station:5,elevation:1,curveLength:2},{id:'b',station:10,elevation:0}];
  road.roadProfile.crossSection={leftSlope:-2,rightSlope:-2};near(roadProfileElevation(road.roadProfile,5),.9);
  const a=roadProfileAnalysis(p,road),before=buildSceneMunicipal(p)[0].surfaces;
  road.roadProfile.sampleInterval=5;const b=roadProfileAnalysis(p,road),after=buildSceneMunicipal(p)[0].surfaces;
  near(a.earthworks.fillVolume,b.earthworks.fillVolume);assert.deepEqual(before,after);
  const tops=before.filter(surface=>surface.id.includes(':top:')).flatMap(surface=>surface.points);assert.ok(tops.some(point=>Math.abs(point.y-.9)<1e-6));
});

test('高级道路参数与预算在本机和完整JSON保存重开后一致',async()=>{
  const p=roadway();p.municipalElements[0].roadProfile.crossSection={leftSlope:-2,rightSlope:-2};
  const store=createMemoryProjectStore();await store.saveProject(p);const local=await store.loadProject(p.id);
  assert.deepEqual(local.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
  const loaded=await importProjectJSON(await exportProjectJSON(p));
  assert.deepEqual(loaded.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);assert.equal(loaded.quoteSummary.total,calculateMunicipalProject(p).total);
});

test('CSV保留25列和真实横坡及放坡口径，不混入水力运行费',()=>{
  const p=roadway();p.municipalElements[0].roadProfile.crossSection={leftSlope:-2,rightSlope:-2};
  const csv=municipalToCSV(p,calculateMunicipalProject(p),value=>'"'+String(value??'').replaceAll('"','""')+'"');
  assert.match(csv,/横坡/);assert.match(csv,/边坡/);assert.equal(csv.split('\r\n')[1].split('","').length,25);
});

test('DEM真实路床与边坡报价保存重开后保留原点、像元和高程',async()=>{
  const p=roadway(),raster=parseTerrainASCIIGrid('ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 10\nNODATA_value -9999\n0 0 0\n0 0 0\n0 0 0');
  raster.originY=0;p.municipalTerrain={name:'项目实测栅格',visible:true,points:[],raster};
  assert.equal(calculateMunicipalProject(p).total,'68.40');
  const store=createMemoryProjectStore();await store.saveProject(p);const local=await store.loadProject(p.id),loaded=await importProjectJSON(await exportProjectJSON(p));
  assert.deepEqual(local.municipalTerrain,p.municipalTerrain);assert.deepEqual(loaded.municipalTerrain,p.municipalTerrain);assert.equal(loaded.quoteSummary.total,'68.40');
});

test('损坏DEM不能覆盖已保存真实网格',async()=>{
  const p=site(),raster=parseTerrainASCIIGrid('ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n0 1\n2 -9999');
  p.municipalTerrain={name:'带缺测范围的地形',visible:true,points:[],raster};
  const store=createMemoryProjectStore();await store.saveProject(p);
  const bad=structuredClone(p);bad.municipalTerrain.raster.values[0]=NaN;await assert.rejects(async()=>store.saveProject(bad));
  assert.deepEqual((await store.loadProject(p.id)).municipalTerrain,p.municipalTerrain);
});

test('泵阀、水池和时序设置在项目JSON与本机保存中完整保留，结果重新计算',async()=>{
  const p=site();
  p.municipalHydraulics={mode:'pressure',nodes:[
    {id:'r',name:'水源',x:0,y:0,elevation:0,type:'reservoir',head:5,demand:null},
    {id:'t',name:'储水池',x:100,y:0,elevation:0,type:'tank',head:null,demand:0,tank:{area:100,minLevel:1,maxLevel:10,initialLevel:5}},
    {id:'j',name:'用水节点',x:200,y:0,elevation:0,type:'junction',head:null,demand:1}
  ],links:[
    {id:'p',name:'供水泵管',from:'r',to:'t',length:100,diameter:100,roughness:120,minorLoss:0,pump:{enabled:true,curve:[{flow:0,head:10},{flow:20,head:0}]},valve:{open:true,lossCoefficient:1},checkValve:true,status:'open'},
    {id:'l',name:'用水管',from:'t',to:'j',length:100,diameter:100,roughness:120,minorLoss:0}
  ],simulation:{duration:120,step:30,events:[{id:'e1',time:60,targetId:'j',kind:'demand',value:2},{id:'e2',time:90,targetId:'p',kind:'pump',value:false}]}};
  const before=structuredClone(p.municipalHydraulics);assert.equal(solveHydraulicNetwork(before).status,'ready');
  const simulation=simulateHydraulicNetwork(before);assert.equal(simulation.status,'ready');assert.ok(simulation.maxMassBalanceError<1e-6);
  assert.deepEqual(before,p.municipalHydraulics);
  const store=createMemoryProjectStore();await store.saveProject(p);const local=await store.loadProject(p.id),loaded=await importProjectJSON(await exportProjectJSON(p));
  assert.deepEqual(local.municipalHydraulics,before);assert.deepEqual(loaded.municipalHydraulics,before);assert.equal(loaded.quoteSummary.total,'0.00');
  const after=simulateHydraulicNetwork(loaded.municipalHydraulics);assert.equal(after.status,'ready');near(after.frames.at(-1).tanks[0].level,simulation.frames.at(-1).tanks[0].level);
});
