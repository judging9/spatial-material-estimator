import assert from 'node:assert/strict';
import test from 'node:test';
import { createMunicipalElement, municipalFootprints } from '../static/studio/lib/municipal-design.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
import { roadProfileAnalysis } from '../static/studio/lib/road-profile.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { buildTerrainScene } from '../static/studio/lib/terrain-scene.js';
import { syncMunicipalEngineering } from '../static/studio/municipal-engineering.js';
import { networkFromMunicipal, resolveHydraulicSources, solveHydraulicNetwork } from '../static/studio/lib/hydraulics.js';
import { exportProjectJSON, importProjectJSON, validateProject, createMemoryProjectStore } from '../static/studio/lib/persistence.js';
import { municipalToCSV } from '../static/studio/lib/municipal-export.js';

const near=(actual,expected,tolerance=1e-7)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected}`);
const project=()=>({version:1,id:'engineering',name:'真实场地工程',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:100000,height:90000,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'5.55',taxRate:'9',view:{labels:true,drawingOpacity:1}});
const terrain=()=>({name:'实测平地',visible:true,points:[{id:'a',x:0,y:0,z:0},{id:'b',x:20,y:0,z:0},{id:'c',x:20,y:20,z:0},{id:'d',x:0,y:20,z:0}]});
function graded(){
  const p=project();p.municipalTerrain=terrain();
  const road=createMunicipalElement('road',[{x:500,y:1000},{x:1500,y:1000}],p);
  Object.assign(road,{width:200,height:10,unitPrice:'2',laborRate:'3',additionalCost:'1',roadProfile:{enabled:true,points:[{id:'start',station:0,elevation:-1},{id:'end',station:10,elevation:1}],sampleInterval:1,earthwork:{enabled:true,cutUnitPrice:'10',fillUnitPrice:'20'}}});
  p.municipalElements=[road];return p;
}

test('surveyed terrain and graded formation add real cut/fill costs to the budget with one fixed fee and tax',()=>{
  const p=graded(),q=calculateMunicipalProject(p),row=q.municipalElements[0];
  near(row.roadEngineering.earthworks.cutVolume,6.05);near(row.roadEngineering.earthworks.fillVolume,4.05);
  assert.equal(row.items.length,3);assert.equal(row.items[1].materialCost,'60.50');assert.equal(row.items[2].materialCost,'81.00');
  assert.equal(q.materialCost,'181.50');assert.equal(q.laborCost,'60.00');assert.equal(q.additionalCost,'6.55');assert.equal(q.subtotal,'248.05');assert.equal(q.tax,'22.32');assert.equal(q.total,'270.37');
});

test('structure layer thickness lowers formation and changes earthwork without counting its volume twice',()=>{
  const p=graded();p.municipalElements[0].items=[{id:'base',name:'基层',thickness:20,unit:'m³',unitPrice:'5',wasteRate:'0',laborRate:'0',additionalCost:'0'}];
  const row=calculateMunicipalProject(p).municipalElements[0];near(row.roadEngineering.earthworks.formationDepth,.3);
  near(row.roadEngineering.earthworks.cutVolume,8.45);near(row.roadEngineering.earthworks.fillVolume,2.45);assert.equal(row.items[1].netQuantity,'4');assert.equal(row.items[1].materialCost,'20.00');
});

test('incomplete survey blocks a formal total while retaining only measured partial earthwork money',()=>{
  const p=graded();p.municipalTerrain.points=p.municipalTerrain.points.map(point=>({...point,x:point.x/2}));
  const q=calculateMunicipalProject(p),earth=q.municipalElements[0].roadEngineering.earthworks;
  near(earth.coveredArea,10);near(earth.uncoveredArea,10);assert.equal(q.total,null);assert.equal(q.pending,true);assert.match(q.pendingReason,/未完整覆盖/);
  assert.equal(q.municipalElements[0].items[1].netQuantity,null);near(q.knownMaterialCost,40+earth.cutVolume*10+earth.fillVolume*20,.005);
});

test('no survey and blank cut/fill prices remain unfinished work that can still be saved',()=>{
  const p=graded();delete p.municipalTerrain;p.municipalElements[0].roadProfile.earthwork.cutUnitPrice='';
  const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.match(q.pendingReason,/地形/);assert.doesNotThrow(()=>validateProject(p));
});

test('hidden terrain changes rendering only; quotes still use the same measured elevations',()=>{
  const p=graded(),total=calculateMunicipalProject(p).total;assert.equal(buildTerrainScene(p).length,2);
  p.municipalTerrain.visible=false;assert.equal(buildTerrainScene(p).length,0);assert.equal(calculateMunicipalProject(p).total,total);
});

test('3D grade surfaces preserve changing top elevations and all true structure thicknesses',()=>{
  const p=graded(),road=buildSceneMunicipal(p)[0];assert.equal(road.horizontal.length,0);
  const tops=road.surfaces.filter(surface=>surface.id.includes(':top:')).flatMap(surface=>surface.points);
  near(Math.min(...tops.map(p=>p.y)),-1);near(Math.max(...tops.map(p=>p.y)),1);
  const bottoms=road.surfaces.filter(surface=>surface.id.includes(':bottom:')).flatMap(surface=>surface.points);
  near(Math.min(...bottoms.map(p=>p.y)),-1.1);near(Math.max(...bottoms.map(p=>p.y)),.9);
  assert.ok(road.surfaces.filter(surface=>surface.id.includes(':top:')).every(surface=>surface.normal.y>0));
});

test('equal graded construction planes share footprint ownership but a flat road at another plane does not',()=>{
  const p=graded(),copy=structuredClone(p.municipalElements[0]);copy.id='second';copy.roadProfile.points.forEach((point,i)=>point.id='second-'+i);p.municipalElements.push(copy);
  assert.equal(municipalFootprints(copy,p).length,0);
  delete copy.roadProfile;const row=calculateMunicipalProject(p).municipalElements[1];near(row.area,20);
});

test('geometry edit resizes grade stations, retains heights, and invalid explicit grades are rejected',()=>{
  const p=graded(),next=structuredClone(p);next.municipalElements[0].points[1].x=2500;syncMunicipalEngineering(next,p);
  assert.equal(next.municipalElements[0].roadProfile.points[1].station,20);assert.equal(next.municipalElements[0].roadProfile.points[1].elevation,1);
  near(roadProfileAnalysis(next,next.municipalElements[0]).maxAbsGrade,.1);
  const invalid=structuredClone(p);invalid.municipalElements[0].roadProfile.points[1].station=2;assert.throws(()=>syncMunicipalEngineering(invalid,p),/终点/);
});

test('project JSON and local storage retain survey, grade parameters and current earthwork quote',async()=>{
  const p=graded(),store=createMemoryProjectStore();await store.saveProject(p);const loaded=await store.loadProject(p.id);
  assert.deepEqual(loaded.municipalTerrain,p.municipalTerrain);assert.deepEqual(loaded.municipalElements[0].roadProfile,p.municipalElements[0].roadProfile);
  const text=await exportProjectJSON(p),imported=await importProjectJSON(text);assert.equal(imported.quoteSummary.total,'270.37');assert.equal(calculateMunicipalProject(imported).total,'270.37');
});

test('quote CSV has explicit earthwork rows and keeps the established 25-column layout',()=>{
  const p=graded(),csv=municipalToCSV(p,calculateMunicipalProject(p),value=>'"'+String(value??'').replaceAll('"','""')+'"');
  assert.match(csv,/路床挖方/);assert.match(csv,/路床填方/);assert.match(csv,/270\.37/);assert.equal(csv.split('\r\n')[1].split('","').length,25);
});

test('linked pressure routes recalculate physical length and stop stale endpoint connections',()=>{
  const p=project(),pipe=createMunicipalElement('pipeline',[{x:1000,y:1000,z:0},{x:2000,y:1000,z:0}],p);p.municipalElements=[pipe];
  const network=networkFromMunicipal(p);Object.assign(network.nodes[0],{type:'reservoir',head:30,demand:0});network.nodes[1].demand=1;Object.assign(network.links[0],{diameter:100,roughness:120});p.municipalHydraulics=network;
  assert.equal(solveHydraulicNetwork(network).status,'ready');
  pipe.points.splice(1,0,{x:1500,y:1200,z:0});const resolved=resolveHydraulicSources(p);near(resolved.links[0].length,2*Math.sqrt(29));assert.equal(solveHydraulicNetwork(resolved).status,'ready');
  pipe.points[0].x+=100;assert.equal(solveHydraulicNetwork(resolveHydraulicSources(p)).status,'pending');
});

test('corrupt survey/network/grade data cannot replace a valid saved project, and scene coordinates are metres',async()=>{
  const p=graded(),store=createMemoryProjectStore();await store.saveProject(p);
  const bad=structuredClone(p);bad.municipalTerrain.points[0].z=NaN;await assert.rejects(async()=>store.saveProject(bad));
  assert.equal((await store.loadProject(p.id)).municipalTerrain.points[0].z,0);
  const scene=buildTerrainScene(p);assert.ok(scene.every(surface=>surface.normal.y>0));assert.ok(scene.flatMap(surface=>surface.points).some(point=>point.x===20&&point.z===20));
});
