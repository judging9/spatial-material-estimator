import assert from 'node:assert/strict';
import test from 'node:test';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createEarthworkBalance } from '../static/studio/lib/earthwork-balance.js';
import { analyzeProjectEarthworkTransfer } from '../static/studio/lib/earthwork-transfer-project.js';
import { calculateMunicipalProject } from '../static/studio/lib/municipal-pricing.js';
import { buildSceneMunicipal } from '../static/studio/lib/municipal-scene.js';
import { roadProfileAnalysis } from '../static/studio/lib/road-profile.js';
import { municipalToCSV, renderMunicipalQuoteHTML } from '../static/studio/lib/municipal-export.js';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';

const near=(actual,expected)=>assert.ok(Math.abs(Number(actual)-expected)<1e-7,`${actual} != ${expected}`);
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function fixture(){
  const p={version:1,id:'cross-road-site',name:'跨道路土方调配',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'本地画板',width:6000,height:6000,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="6000"></svg>')},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};
  p.municipalTerrain={name:'实际输入地形',visible:true,points:[{id:'a',x:0,y:0,z:0},{id:'b',x:60,y:0,z:0},{id:'c',x:60,y:60,z:0},{id:'d',x:0,y:60,z:0}]};
  for(const [id,name,y,elevation,usable,factor,loose]of [['s','来源道路',500,-.9,'60','1','1.25'],['a','目标道路 A',1500,.5,'100','1','1.2'],['b','目标道路 B',2500,.6,'100','1','1.1']]){
    const road=createMunicipalElement('road',[{x:500,y},{x:1500,y}],p),balance=createEarthworkBalance();
    Object.assign(balance,{enabled:true,usableCutPercent:usable,naturalPerCompactedFill:factor,loosePerNatural:loose});
    if(id==='s')balance.spoilHaul={enabled:true,distanceKm:'3',unitPrice:'2'};
    if(id==='a'){balance.borrowMaterial={enabled:true,unitPrice:'10'};balance.borrowHaul={enabled:true,distanceKm:'5',unitPrice:'1'};}
    if(id==='b'){balance.borrowMaterial={enabled:true,unitPrice:'12'};balance.borrowHaul={enabled:true,distanceKm:'4',unitPrice:'1'};}
    Object.assign(road,{id,name,width:200,height:10,unitPrice:'0',wasteRate:'0',laborRate:'0',additionalCost:'0',quantity:'1',roadProfile:{enabled:true,points:[{id:id+'-start',station:0,elevation},{id:id+'-end',station:10,elevation}],sampleInterval:1,earthwork:{enabled:false,cutUnitPrice:'',fillUnitPrice:''},earthworkBalance:balance}});
    p.municipalElements.push(road);
  }
  p.municipalEarthworkTransfer={enabled:true,roadIds:['s','a','b'],routes:[{id:'sa',fromRoadId:'s',toRoadId:'a',enabled:true,distanceKm:'2',unitPrice:'1'},{id:'sb',fromRoadId:'s',toRoadId:'b',enabled:true,distanceKm:'1',unitPrice:'1'}]};return p;
}
const row=(q,id)=>q.municipalElements.find(row=>row.id===id);
const balanceItem=(q,id,key)=>row(q,id).items.find(item=>item.balanceKey===key);

test('实测三条道路最大复用12天然方，来源60%可用余土优先运往费用低的目标',()=>{
  const p=fixture(),plan=analyzeProjectEarthworkTransfer(p);
  assert.equal(plan.pending,false);assert.equal(plan.transferredNatural,'12');assert.equal(plan.totalHaulCost,'17.50');
  assert.deepEqual(plan.routes.map(route=>[route.id,route.naturalQuantity,route.looseQuantity,route.haulQuantity,route.amount]),[['sa','2','2.5','5','5.00'],['sb','10','12.5','12.5','12.50']]);
  assert.deepEqual(plan.roads.map(road=>[road.id,road.incomingNatural,road.outgoingNatural,road.residualBorrowNatural,road.residualSpoilNatural]),[['s','0','12','0','8'],['a','2','0','6','0'],['b','10','0','0','0']]);
});

test('正式报价替换剩余借方和弃方，跨路运输按来源松方计入一次',()=>{
  const p=fixture(),q=calculateMunicipalProject(p);assert.equal(q.total,'173.50');assert.equal(q.pending,false);
  assert.equal(balanceItem(q,'s','spoil-haul').netQuantity,'30');assert.equal(balanceItem(q,'s','spoil-haul').total,'60.00');
  assert.equal(balanceItem(q,'a','borrow-material').total,'60.00');assert.equal(balanceItem(q,'a','borrow-haul').total,'36.00');
  assert.equal(balanceItem(q,'b','borrow-material').total,'0.00');assert.equal(balanceItem(q,'b','borrow-haul').total,'0.00');
  const transport=row(q,'s').items.filter(item=>item.category==='earthwork-transfer');assert.equal(transport.length,2);assert.equal(transport.reduce((sum,item)=>sum+Number(item.total),0),17.5);
  near(q.netArea,60);assert.equal(row(q,'s').roadEngineering.earthworkBalanceBeforeTransfer.volumes.spoilNatural,'20');assert.equal(row(q,'s').roadEngineering.earthworkBalance.volumes.spoilNatural,'8');
});

test('关闭所有路线或全局调配均恢复原本442元外部借弃报价',()=>{
  const p=fixture();p.municipalEarthworkTransfer.routes.forEach(route=>route.enabled=false);assert.equal(calculateMunicipalProject(p).total,'442.00');assert.equal(analyzeProjectEarthworkTransfer(p).transferredNatural,'0');
  p.municipalEarthworkTransfer.enabled=false;assert.equal(calculateMunicipalProject(p).total,'442.00');delete p.municipalEarthworkTransfer;assert.equal(calculateMunicipalProject(p).total,'442.00');
});

test('自填跨路价格变化重新分配但不改变原道路几何与挖填',()=>{
  const p=fixture(),geometry=buildSceneMunicipal(p),earth=p.municipalElements.map(road=>roadProfileAnalysis(p,road).earthworks);
  p.municipalEarthworkTransfer.routes[1].unitPrice='3';const q=calculateMunicipalProject(p);
  assert.deepEqual(q.earthworkTransfer.routes.map(route=>route.naturalQuantity),['8','4']);assert.equal(q.total,'193.40');
  assert.deepEqual(buildSceneMunicipal(p),geometry);assert.deepEqual(p.municipalElements.map(road=>roadProfileAnalysis(p,road).earthworks),earth);
});

test('几何编辑自动重算可调余土和费用，不沿用保存的临时方案',()=>{
  const p=fixture();p.municipalElements[0].roadProfile.points.forEach(point=>point.elevation=-1.4);
  const q=calculateMunicipalProject(p);assert.equal(q.earthworkTransfer.transferredNatural,'18');assert.equal(q.total,'122.50');
  assert.equal(q.earthworkTransfer.roads[0].residualSpoilNatural,'12');
});

test('目标仍保留其内部复用，来源不可用弃土不能跨路抵消需求',()=>{
  const p=fixture();const a=p.municipalElements[1];a.roadProfile.points[0].elevation=-.9;a.roadProfile.points[1].elevation=1.1;
  const before=roadProfileAnalysis(p,a).earthworkBalance.volumes;
  const q=calculateMunicipalProject(p),after=row(q,'a').roadEngineering.earthworkBalance.volumes;
  assert.equal(after.reuseNatural,before.reuseNatural);assert.equal(row(q,'s').roadEngineering.interRoadTransfer.availableNatural,'12');
  assert.equal(q.earthworkTransfer.transferredNatural,'10');assert.equal(q.earthworkTransfer.roads[0].residualSpoilNatural,'10');
});

test('现有道路挖填施工费和新调配运输费分开，人工固定费税各计一次',()=>{
  const p=fixture();p.municipalElements[0].roadProfile.earthwork={enabled:true,cutUnitPrice:'3',fillUnitPrice:'0'};
  p.municipalElements[1].laborRate='2';p.municipalElements[2].additionalCost='7';p.additionalCost='10';p.taxRate='9';
  const q=calculateMunicipalProject(p);assert.equal(q.knownSubtotal,'290.50');assert.equal(q.tax,'26.15');assert.equal(q.total,'316.65');
  assert.equal(row(q,'s').items.find(item=>item.id.endsWith(':cutVolume')).total,'60.00');
});

test('消除目标借方后原借料空价及空外部运距不阻止完成报价',()=>{
  const p=fixture(),b=p.municipalElements[2].roadProfile.earthworkBalance;b.borrowMaterial.unitPrice='';b.borrowHaul.unitPrice='';b.borrowHaul.distanceKm='';
  const q=calculateMunicipalProject(p);assert.equal(q.total,'173.50');assert.equal(q.pending,false);
  assert.equal(balanceItem(q,'b','borrow-material').unitPrice,'');assert.equal(balanceItem(q,'b','borrow-haul').total,'0.00');
  assert.match(municipalToCSV(p,q,csvCell),/零量无需单价/);
});

test('减少后仍有非零外购量时缺原借料单价必须待确认',()=>{
  const p=fixture();p.municipalElements[1].roadProfile.earthworkBalance.borrowMaterial.unitPrice='';
  const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.match(q.pendingReason,/借方材料.*单价/);assert.equal(q.earthworkTransfer.pending,false);assert.equal(q.knownSubtotal,'113.50');
});

test('活跃运输缺价或运距不会形成部分正式计划，其他主材仍保留已知费用',()=>{
  for(const field of ['unitPrice','distanceKm']){
    const p=fixture();p.municipalEarthworkTransfer.routes[0][field]='';p.municipalElements[0].unitPrice='2';
    const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.earthworkTransfer.transferredNatural,null);assert.ok(q.earthworkTransfer.routes.every(route=>route.haulQuantity===null));assert.equal(q.knownSubtotal,'40.00');
  }
});

test('缺测与缺转换系数阻止全局调运，不将已知局部量当成完整借弃量',()=>{
  for(const change of [p=>p.municipalTerrain.points=p.municipalTerrain.points.map(point=>({...point,x:Math.min(point.x,10)})),p=>p.municipalElements[0].roadProfile.earthworkBalance.usableCutPercent='']){
    const p=fixture();change(p);const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.earthworkTransfer.pending,true);assert.equal(q.earthworkTransfer.transferredNatural,null);assert.ok(q.earthworkTransfer.roads.every(road=>road.outgoingNatural===null));
  }
});

test('预算份数2、关闭纵断面或关闭道路平衡均保持待确认，不复制物理土料',()=>{
  for(const change of [road=>road.quantity='2',road=>road.roadProfile.enabled=false,road=>road.roadProfile.earthworkBalance.enabled=false]){
    const p=fixture();change(p.municipalElements[0]);const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.equal(q.earthworkTransfer.transferredNatural,null);assert.match(q.pendingReason,/预算份数|纵断面|土方平衡/);
  }
});

test('删除被引用道路后保留草稿和清楚提示，存储可重开而不能忽略其需求',async()=>{
  const p=fixture();p.municipalElements=p.municipalElements.filter(road=>road.id!=='b');
  const q=calculateMunicipalProject(p);assert.equal(q.total,null);assert.match(q.pendingReason,/不存在|删除|找不到/);assert.deepEqual(p.municipalEarthworkTransfer.roadIds,['s','a','b']);
  const store=createMemoryProjectStore();await store.saveProject(p);const restored=await store.loadProject(p.id);assert.equal(calculateMunicipalProject(restored).total,null);
});

test('真实零运输距离允许空运输价，量仍守恒，不自动猜测路程',()=>{
  const p=fixture();Object.assign(p.municipalEarthworkTransfer.routes[0],{distanceKm:'0',unitPrice:''});
  const q=calculateMunicipalProject(p);assert.equal(q.earthworkTransfer.pending,false);assert.deepEqual(q.earthworkTransfer.routes.map(route=>route.naturalQuantity),['8','4']);
  assert.equal(q.earthworkTransfer.routes[0].haulQuantity,'0');assert.equal(q.earthworkTransfer.routes[0].amount,'0.00');assert.match(municipalToCSV(p,q,csvCell),/零量无需单价/);
});

test('跨道路方案与报价保存重开一致，忽略伪造quoteSummary并从真实输入重算',async()=>{
  const p=fixture(),store=createMemoryProjectStore();await store.saveProject(p);
  const local=await store.loadProject(p.id),json=JSON.parse(await exportProjectJSON(p));json.quoteSummary.total='1.00';json.quoteSummary.earthworkTransfer.transferredNatural='999999';
  const imported=await importProjectJSON(JSON.stringify(json));
  for(const restored of [local,imported]){assert.deepEqual(restored.municipalEarthworkTransfer,p.municipalEarthworkTransfer);assert.equal(calculateMunicipalProject(restored).total,'173.50');assert.equal(calculateMunicipalProject(restored).earthworkTransfer.transferredNatural,'12');}
});

test('非法负运距不能覆盖原工程',async()=>{
  const p=fixture(),store=createMemoryProjectStore();await store.saveProject(p);
  const bad=structuredClone(p);bad.municipalEarthworkTransfer.routes[0].distanceKm='-1';await assert.rejects(async()=>store.saveProject(bad));
  assert.deepEqual((await store.loadProject(p.id)).municipalEarthworkTransfer,p.municipalEarthworkTransfer);
});

test('25列CSV与正式打印单完整解释调运量、来源松方和调运后剩余费用',()=>{
  const p=fixture(),q=calculateMunicipalProject(p),csv=municipalToCSV(p,q,csvCell),html=renderMunicipalQuoteHTML(p,q,{},escape);
  for(const line of csv.trimEnd().split('\r\n'))assert.equal(line.split('","').length,25);
  for(const text of ['来源道路松方 × 运距','天然方','跨路调入','跨路调出','最小运输费','173.50'])assert.ok(csv.includes(text),text);
  assert.match(html,/跨道路土方调配/);assert.match(html,/来源松方 m³/);assert.match(html,/运距 km/);assert.match(html,/不重复加计/);assert.match(html,/173.50/);
});
