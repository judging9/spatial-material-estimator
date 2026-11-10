import assert from 'node:assert/strict';
import test from 'node:test';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createEarthworkBalance } from '../static/studio/lib/earthwork-balance.js';
import { roadProfileAnalysis } from '../static/studio/lib/road-profile.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
import { municipalToCSV, renderMunicipalQuoteHTML } from '../static/studio/lib/municipal-export.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { exportProjectJSON, importProjectJSON, createMemoryProjectStore } from '../static/studio/lib/persistence.js';
import { pumpHeadAtFlow } from '../static/studio/lib/hydraulic-devices.js';
import { solveHydraulicNetwork } from '../static/studio/lib/hydraulics.js';
import { simulateHydraulicNetwork } from '../static/studio/lib/hydraulic-simulation.js';

const near=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(Number(a)-b)<=tolerance,`${a} != ${b}`);
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function roadway(){
  const p={version:1,id:'operations-site',name:'实测道路调配',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'本地画板',width:3000,height:3000,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000"></svg>')},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};
  p.municipalTerrain={name:'用户输入平地',visible:true,points:[{id:'a',x:0,y:0,z:0},{id:'b',x:30,y:0,z:0},{id:'c',x:30,y:30,z:0},{id:'d',x:0,y:30,z:0}]};
  const road=createMunicipalElement('road',[{x:500,y:1000},{x:1500,y:1000}],p),balance=createEarthworkBalance();
  Object.assign(balance,{enabled:true,usableCutPercent:'60',naturalPerCompactedFill:'1.1',loosePerNatural:'1.2',borrowMaterial:{enabled:true,unitPrice:'40'},reuseHaul:{enabled:true,distanceKm:'.2',unitPrice:'3'},borrowHaul:{enabled:true,distanceKm:'5',unitPrice:'2'},spoilHaul:{enabled:true,distanceKm:'10',unitPrice:'1.5'}});
  Object.assign(road,{width:200,height:10,unitPrice:'0',laborRate:'0',wasteRate:'0',additionalCost:'0',roadProfile:{enabled:true,points:[{id:'start',station:0,elevation:-.9},{id:'end',station:10,elevation:1.1}],sampleInterval:1,curveTolerance:.002,earthwork:{enabled:false,cutUnitPrice:'',fillUnitPrice:''},earthworkBalance:balance}});
  p.municipalElements=[road];return p;
}
const balanceItems=q=>q.municipalElements[0].items.filter(item=>item.category==='earthwork-balance');

test('实绘10×2m路床产生5方挖和5方填，天然方调配及松方运输准确进入总报价',()=>{
  const p=roadway(),analysis=roadProfileAnalysis(p,p.municipalElements[0]),q=calculateMunicipalProject(p);
  near(analysis.earthworks.cutVolume,5);near(analysis.earthworks.fillVolume,5);
  assert.deepEqual(analysis.earthworkBalance.volumes,{usableCutNatural:'3',fillDemandNatural:'5.5',reuseNatural:'3',borrowNatural:'2.5',spoilNatural:'2',reuseLoose:'3.6',borrowLoose:'3',spoilLoose:'2.4'});
  assert.equal(analysis.earthworks.enabled,false);assert.equal(q.pending,false);
  assert.deepEqual(balanceItems(q).map(item=>[item.balanceKey,item.netQuantity,item.unit,item.total]),[['borrow-material','2.5','m³','100.00'],['reuse-haul','0.72','m³·km','2.16'],['borrow-haul','15','m³·km','30.00'],['spoil-haul','24','m³·km','36.00']]);
  assert.equal(q.total,'168.16');
});

test('材料损耗、人工、固定费和统一税金与新增调配费各计一次',()=>{
  const p=roadway(),road=p.municipalElements[0];Object.assign(road,{unitPrice:'2',wasteRate:'5',laborRate:'1',additionalCost:'3'});p.additionalCost='10';p.taxRate='9';
  const q=calculateMunicipalProject(p),main=q.municipalElements[0].items[0];
  assert.equal(main.purchaseQuantity,'21');assert.equal(main.materialCost,'42.00');assert.equal(main.laborCost,'20.00');
  assert.equal(q.additionalCost,'13.00');assert.equal(q.knownSubtotal,'243.16');assert.equal(q.tax,'21.88');assert.equal(q.total,'265.04');
});

test('预算份数只倍计计价工程量，不伪造第二条道路或跨路调配',()=>{
  const p=roadway(),before=buildSceneMunicipal(p)[0].surfaces;p.municipalElements[0].quantity='2';
  const q=calculateMunicipalProject(p);assert.equal(q.total,'336.32');near(q.netArea,20);
  assert.deepEqual(balanceItems(q).map(item=>item.netQuantity),['5','1.44','30','48']);
  assert.deepEqual(q.municipalElements[0].roadEngineering.earthworkBalance.volumes,roadProfileAnalysis(p,p.municipalElements[0]).earthworkBalance.volumes);
  assert.deepEqual(buildSceneMunicipal(p)[0].surfaces,before);
});

test('半分单价先合并预算工程量再按分舍入，不能预舍入单道路费用',()=>{
  const p=roadway(),balance=p.municipalElements[0].roadProfile.earthworkBalance;
  for(const key of ['reuseHaul','borrowHaul','spoilHaul'])balance[key].enabled=false;
  balance.borrowMaterial.unitPrice='.002';assert.equal(calculateMunicipalProject(p).total,'0.01');
  p.municipalElements[0].quantity='2';const q=calculateMunicipalProject(p);assert.equal(balanceItems(q)[0].netQuantity,'5');assert.equal(q.total,'0.01');
});

test('修改借料价格、运距或土质系数立即更新费用，真实三维面保持不变',()=>{
  const p=roadway(),before=buildSceneMunicipal(p)[0].surfaces,balance=p.municipalElements[0].roadProfile.earthworkBalance;
  balance.borrowMaterial.unitPrice='41';assert.equal(calculateMunicipalProject(p).total,'170.66');
  balance.borrowHaul.distanceKm='6';assert.equal(calculateMunicipalProject(p).total,'176.66');
  balance.usableCutPercent='80';const changed=calculateMunicipalProject(p);assert.notEqual(changed.total,'176.66');
  assert.deepEqual(buildSceneMunicipal(p)[0].surfaces,before);
});

test('测量缺口不允许用部分挖方抵完整填方，保留其他已知费用',()=>{
  const p=roadway();p.municipalTerrain.points=p.municipalTerrain.points.map(point=>({...point,x:Math.min(point.x,10)}));p.municipalElements[0].unitPrice='2';
  const q=calculateMunicipalProject(p),balance=q.municipalElements[0].roadEngineering.earthworkBalance;
  assert.equal(q.pending,true);assert.equal(q.total,null);assert.equal(q.knownSubtotal,'40.00');assert.equal(balance.volumes,null);
  assert.ok(balanceItems(q).every(item=>item.netQuantity===null&&item.total===null));assert.match(q.pendingReason,/未完整覆盖/);
});

test('转换参数缺失或运输距离清空后正式总价待确认，已知材料费继续显示',()=>{
  const p=roadway(),balance=p.municipalElements[0].roadProfile.earthworkBalance;
  balance.borrowHaul.distanceKm='';let q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.knownSubtotal,'138.16');assert.match(q.pendingReason,/运距/);
  balance.loosePerNatural='';q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.knownSubtotal,'0.00');assert.match(q.pendingReason,/天然方转松方/);
  assert.ok(balanceItems(q).every(item=>item.netQuantity===null));
});

test('关闭纵断面且保留启用调配时必须待确认，不输出表面上完成的报价',()=>{
  const p=roadway();p.municipalElements[0].roadProfile.enabled=false;
  const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.pending,true);assert.match(q.pendingReason,/启用道路纵断面/);
  assert.equal(q.municipalElements[0].roadEngineering.earthworkBalance.volumes,null);
});

test('真实零借方、零运输量允许留空价格和运距，导出明确无需单价',()=>{
  const p=roadway(),balance=p.municipalElements[0].roadProfile.earthworkBalance;
  Object.assign(balance,{usableCutPercent:'100',naturalPerCompactedFill:'1'});balance.borrowMaterial.unitPrice='';balance.borrowHaul.unitPrice='';balance.borrowHaul.distanceKm='';balance.spoilHaul.unitPrice='';balance.spoilHaul.distanceKm='';
  const q=calculateMunicipalProject(p);assert.equal(q.pending,false);assert.equal(q.total,'3.60');
  const zero=balanceItems(q).filter(item=>item.netQuantity==='0');assert.equal(zero.length,3);assert.ok(zero.every(item=>item.total==='0.00'&&item.unitPrice===''));
  const csv=municipalToCSV(p,q,csvCell),html=renderMunicipalQuoteHTML(p,q,{},escape);
  assert.match(csv,/零量无需单价/);assert.match(html,/零量无需单价/);assert.doesNotMatch(csv,/市政草稿汇总/);
});

test('未勾选费用不要求单价，关闭调配后兼容原有表面报价',()=>{
  const p=roadway(),balance=p.municipalElements[0].roadProfile.earthworkBalance;
  for(const key of ['borrowMaterial','reuseHaul','borrowHaul','spoilHaul'])Object.assign(balance[key],{enabled:false,unitPrice:''});
  let q=calculateMunicipalProject(p);assert.equal(q.total,'0.00');assert.equal(balanceItems(q).length,0);
  Object.assign(balance,{enabled:false,usableCutPercent:'',naturalPerCompactedFill:'',loosePerNatural:''});p.municipalElements[0].roadProfile.enabled=false;
  q=calculateMunicipalProject(p);assert.equal(q.total,'0.00');assert.equal(q.municipalElements[0].roadEngineering,undefined);
});

test('25列CSV和打印报价区分借料天然方、运输松方及单条道路预算份数',()=>{
  const p=roadway();p.municipalElements[0].quantity='2';const q=calculateMunicipalProject(p),csv=municipalToCSV(p,q,csvCell),html=renderMunicipalQuoteHTML(p,q,{},escape);
  for(const line of csv.trimEnd().split('\r\n'))assert.equal(line.split('","').length,25);
  for(const text of ['借方天然体积','松方 × 运距','m³·km','天然方','松方','预算份数 2','336.32'])assert.ok(csv.includes(text),text);
  assert.match(html,/m³·km/);assert.match(html,/天然方/);assert.match(html,/松方/);assert.match(html,/336.32/);assert.doesNotMatch(html,/本分项厚度 undefined/);
});

test('报价CSV净量和采购量保留精确十进制，不在导出时舍入工程量',()=>{
  const p=roadway();p.municipalElements[0].roadProfile.earthworkBalance.borrowHaul.distanceKm='.123456789';
  const q=calculateMunicipalProject(p),item=balanceItems(q).find(item=>item.balanceKey==='borrow-haul');assert.equal(item.netQuantity,'0.370370367');
  const csv=municipalToCSV(p,q,csvCell);assert.ok(csv.includes('"0.370370367","0.370370367"'));
});

test('本机保存与JSON重开保留调配参数、原始几何和真实总价',async()=>{
  const p=roadway(),q=calculateMunicipalProject(p),store=createMemoryProjectStore();await store.saveProject(p);
  const local=await store.loadProject(p.id),json=await importProjectJSON(await exportProjectJSON(p));
  for(const restored of [local,json]){assert.deepEqual(restored.municipalElements,p.municipalElements);assert.deepEqual(restored.municipalTerrain,p.municipalTerrain);assert.equal(calculateMunicipalProject(restored).total,q.total);}
  assert.equal(json.quoteSummary.total,'168.16');
});

test('无效调配参数不能覆盖已保存项目，完整待填写草稿可以保存',async()=>{
  const p=roadway(),store=createMemoryProjectStore();await store.saveProject(p);
  const bad=structuredClone(p);bad.municipalElements[0].roadProfile.earthworkBalance.usableCutPercent='101';await assert.rejects(async()=>store.saveProject(bad));
  assert.deepEqual((await store.loadProject(p.id)).municipalElements,p.municipalElements);
  const draft=structuredClone(p);draft.municipalElements[0].roadProfile.earthworkBalance.loosePerNatural='';await store.saveProject(draft);
  assert.equal(calculateMunicipalProject(await store.loadProject(p.id)).total,null);
});

function pumping(){return{mode:'pressure',nodes:[{id:'r',name:'供水源',x:0,y:0,elevation:0,type:'reservoir',head:50,demand:null},{id:'j',name:'用水点',x:10,y:0,elevation:0,type:'junction',head:null,demand:1}],links:[{id:'p',name:'供水泵管',from:'r',to:'j',length:1000,diameter:100,roughness:120,minorLoss:0,pump:{enabled:true,speed:.8,curve:[{flow:0,head:30},{flow:20,head:10}]}}],simulation:{duration:300,step:60,events:[{id:'speed-event',time:100,kind:'speed',targetId:'p',value:.5}],controls:[]}};}

test('80%额定转速使用实际相似换算扬程及导数，真实下游水头符合独立公式',()=>{
  const network=pumping(),pump=network.links[0].pump,r=solveHydraulicNetwork(network),curve=pumpHeadAtFlow(pump,10);
  near(curve.head,11.2);near(curve.slope,-.8);assert.equal(r.status,'ready');
  near(r.links[0].pumpHeadGain,18.4);near(r.links[0].headLoss,.3103993132658106);near(r.nodes[1].head,68.0896006867342);
  assert.throws(()=>pumpHeadAtFlow(pump,16.1),/禁止外推/);
});

test('道路预算和定时调速泵在同一项目本机保存、JSON重开后均可靠重算',async()=>{
  const p=roadway();p.municipalHydraulics=pumping();const before=simulateHydraulicNetwork(p.municipalHydraulics),store=createMemoryProjectStore();assert.equal(before.status,'ready');
  await store.saveProject(p);const restored=[await store.loadProject(p.id),await importProjectJSON(await exportProjectJSON(p))];
  for(const loaded of restored){assert.deepEqual(loaded.municipalHydraulics,p.municipalHydraulics);assert.equal(calculateMunicipalProject(loaded).total,'168.16');const after=simulateHydraulicNetwork(loaded.municipalHydraulics);assert.equal(after.status,'ready');assert.deepEqual(after.pumpSpeedLog,before.pumpSpeedLog);near(after.frames.at(-1).result.nodes[1].head,before.frames.at(-1).result.nodes[1].head);}
  assert.equal(p.municipalHydraulics.links[0].pump.speed,.8);assert.equal(p.municipalHydraulics.pumpSpeedLog,undefined);
});
