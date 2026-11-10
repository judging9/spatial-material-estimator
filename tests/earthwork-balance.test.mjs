import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.ROAD_PROFILE_BUILD?pathToFileURL(resolve(process.env.ROAD_PROFILE_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {createEarthworkBalance,validateEarthworkBalance,calculateEarthworkBalance}=await import(new URL('lib/earthwork-balance.js',root));
const {addDecimal,multiplyDecimal}=await import(new URL('lib/pricing.js',root));
const base=()=>({...createEarthworkBalance(),enabled:true,usableCutPercent:'70',naturalPerCompactedFill:'1.1',loosePerNatural:'1.25'});
const input=(cut=100,fill=80,geometryComplete=true)=>({cutNaturalVolume:cut,fillCompactedVolume:fill,geometryComplete});
const allBudgets=()=>({...base(),borrowMaterial:{enabled:true,unitPrice:'10'},reuseHaul:{enabled:true,distanceKm:'2',unitPrice:'.5'},borrowHaul:{enabled:true,distanceKm:'5',unitPrice:'.8'},spoilHaul:{enabled:true,distanceKm:'3',unitPrice:'1.2'}});

test('factory contains no guessed soil factors, rates, transport distances or enabled budgets',()=>{
  const config=createEarthworkBalance();assert.equal(config.enabled,false);
  for(const key of ['usableCutPercent','naturalPerCompactedFill','loosePerNatural'])assert.equal(config[key],'');
  for(const key of ['borrowMaterial','reuseHaul','borrowHaul','spoilHaul']){assert.equal(config[key].enabled,false);assert.equal(config[key].unitPrice,'');}
  for(const key of ['reuseHaul','borrowHaul','spoilHaul'])assert.equal(config[key].distanceKm,'');
  assert.doesNotThrow(()=>validateEarthworkBalance(config));
});
test('natural-volume balance consumes reusable cut once and includes unusable cut in spoil',()=>{
  const result=calculateEarthworkBalance(input(),base());
  assert.deepEqual(result.volumes,{usableCutNatural:'70',fillDemandNatural:'88',reuseNatural:'70',borrowNatural:'18',spoilNatural:'30',reuseLoose:'87.5',borrowLoose:'22.5',spoilLoose:'37.5'});
  assert.equal(result.complete,true);assert.equal(result.pending,false);assert.deepEqual(result.items,[]);assert.equal(result.totalCost,'0.00');
});
test('all material and hauling items use the declared volume basis and separate entered distances',()=>{
  const result=calculateEarthworkBalance(input(),allBudgets());
  assert.deepEqual(result.items.map(item=>[item.key,item.quantity,item.unit,item.amount]),[
    ['borrow-material','18','m³','180.00'],['reuse-haul','175','m³·km','87.50'],['borrow-haul','112.5','m³·km','90.00'],['spoil-haul','112.5','m³·km','135.00']]);
  assert.equal(result.knownCost,'492.50');assert.equal(result.totalCost,'492.50');
});
test('surplus reusable cut is not also purchased or charged as internal reuse',()=>{
  const result=calculateEarthworkBalance(input(100,20),base());
  assert.equal(result.volumes.fillDemandNatural,'22');assert.equal(result.volumes.reuseNatural,'22');assert.equal(result.volumes.borrowNatural,'0');assert.equal(result.volumes.spoilNatural,'78');
});
test('zero usable percentage routes the complete cut to spoil and complete fill demand to borrow',()=>{
  const result=calculateEarthworkBalance(input(),{...base(),usableCutPercent:'0'});
  assert.equal(result.volumes.reuseNatural,'0');assert.equal(result.volumes.borrowNatural,'88');assert.equal(result.volumes.spoilNatural,'100');
});
test('full usability and balanced earthworks do not create imaginary borrow or spoil',()=>{
  const config={...base(),usableCutPercent:'100',naturalPerCompactedFill:'1'};
  const result=calculateEarthworkBalance(input(10,10),config);assert.equal(result.volumes.reuseNatural,'10');assert.equal(result.volumes.borrowNatural,'0');assert.equal(result.volumes.spoilNatural,'0');
});
test('natural mass conservation remains exact across representative cut/fill/coefficient combinations',()=>{
  for(const cut of [0,.1,3.141592653,100])for(const fill of [0,.25,80,1000])for(const percent of ['0','33.333333333333333','70','100']){
    const config={...base(),usableCutPercent:percent},v=calculateEarthworkBalance(input(cut,fill),config).volumes;
    assert.equal(addDecimal(v.reuseNatural,v.spoilNatural),String(cut));
    assert.equal(addDecimal(v.reuseNatural,v.borrowNatural),v.fillDemandNatural);
    assert.equal(addDecimal(v.reuseLoose,v.spoilLoose),multiplyDecimal(String(cut),config.loosePerNatural));
  }
});
test('exact decimal comparison does not turn a minute real deficit into zero',()=>{
  const result=calculateEarthworkBalance(input(100,200),{...base(),usableCutPercent:'99.9999999999999999',naturalPerCompactedFill:'1',loosePerNatural:'1'});
  assert.equal(result.volumes.reuseNatural,'99.9999999999999999');assert.equal(result.volumes.borrowNatural,'100.0000000000000001');assert.equal(result.volumes.spoilNatural,'0.0000000000000001');
});
test('missing conversion parameters keep quantities and complete quote pending',()=>{
  for(const field of ['usableCutPercent','naturalPerCompactedFill','loosePerNatural']){
    const config=allBudgets();config[field]='';const result=calculateEarthworkBalance(input(),config);
    assert.equal(result.volumes,null);assert.equal(result.pending,true);assert.equal(result.totalCost,null);assert.equal(result.knownCost,'0.00');
    assert.ok(result.items.every(item=>item.quantity===null&&item.amount===null&&item.pending));assert.match(result.pendingReason,/待填写/);
  }
});
test('incomplete surveyed geometry never nets a partially known cut against assumed full fill',()=>{
  const source={...input(5,80,false),geometryReasons:['测区缺口 30 m²','放坡超出最大宽度']};
  const result=calculateEarthworkBalance(source,allBudgets());
  assert.equal(result.cutNaturalVolume,5);assert.equal(result.fillCompactedVolume,80);assert.equal(result.volumes,null);assert.equal(result.totalCost,null);
  assert.ok(result.items.every(item=>item.quantity===null&&item.pending));assert.match(result.pendingReason,/测区缺口/);assert.match(result.pendingReason,/放坡/);
});
test('missing source geometry gives an explicit pending reason even when completeness flag is incorrect',()=>{
  const result=calculateEarthworkBalance({...input(),cutNaturalVolume:null},allBudgets());assert.equal(result.volumes,null);assert.match(result.pendingReason,/完整/);
});
test('unselected budgets never demand prices or distances',()=>{
  const result=calculateEarthworkBalance(input(),base());assert.equal(result.pending,false);assert.equal(result.items.length,0);
});
test('a missing nonzero budget rate preserves all known independent fees',()=>{
  const config=allBudgets();config.borrowMaterial.unitPrice='';const result=calculateEarthworkBalance(input(),config);
  assert.equal(result.items[0].quantity,'18');assert.equal(result.items[0].amount,null);assert.match(result.items[0].pendingReason,/单价待填写/);
  assert.equal(result.knownCost,'312.50');assert.equal(result.totalCost,null);assert.ok(result.items.slice(1).every(item=>!item.pending));
});
test('missing nonzero transport distance affects only that item without an invented km',()=>{
  const config=allBudgets();config.borrowHaul.distanceKm='';const result=calculateEarthworkBalance(input(),config);
  assert.equal(result.items[2].quantity,null);assert.equal(result.items[2].amount,null);assert.match(result.items[2].pendingReason,/运距待填写/);
  assert.equal(result.knownCost,'402.50');assert.equal(result.totalCost,null);
});
test('confirmed zero volumes require neither prices nor transport distances',()=>{
  const config={...base(),usableCutPercent:'100',naturalPerCompactedFill:'1'};config.borrowMaterial.enabled=config.borrowHaul.enabled=config.spoilHaul.enabled=true;
  const result=calculateEarthworkBalance(input(10,10),config);assert.equal(result.pending,false);
  assert.ok(result.items.every(item=>item.quantity==='0'&&item.amount==='0.00'&&item.unitPrice===''));assert.equal(result.totalCost,'0.00');
});
test('explicit zero distance has zero transport cost and explicit zero price is valid',()=>{
  const config=allBudgets();config.borrowHaul={enabled:true,distanceKm:'0',unitPrice:''};config.borrowMaterial.unitPrice='0';
  const result=calculateEarthworkBalance(input(),config);assert.equal(result.pending,false);assert.equal(result.items[0].amount,'0.00');assert.equal(result.items[2].quantity,'0');assert.equal(result.items[2].amount,'0.00');assert.equal(result.totalCost,'222.50');
});
test('disabled balance leaves existing geometry unchanged and requires no enabled configuration',()=>{
  const source=input(1,2,false),config=createEarthworkBalance(),before=structuredClone(source);
  const result=calculateEarthworkBalance(source,config);assert.deepEqual(source,before);assert.equal(result.enabled,false);assert.equal(result.pending,false);assert.equal(result.totalCost,'0.00');assert.equal(result.volumes,null);
});
test('geometric 9-place half boundary and monetary cents use the original decimal quantity',()=>{
  const config={...base(),usableCutPercent:'0',naturalPerCompactedFill:'1',loosePerNatural:'1',borrowMaterial:{enabled:true,unitPrice:'10000000'}};
  const result=calculateEarthworkBalance(input(0,1.0000000025),config);assert.equal(result.items[0].quantity,'1.000000003');assert.equal(result.totalCost,'10000000.03');
  config.borrowMaterial.unitPrice='.005';assert.equal(calculateEarthworkBalance(input(0,1),config).totalCost,'0.01');
});
test('geometric slivers below declared 9-place precision become zero without hiding raw source',()=>{
  const result=calculateEarthworkBalance(input(1e-48,1e-48),base());assert.equal(result.cutNaturalVolume,1e-48);assert.equal(result.volumes.reuseNatural,'0');assert.equal(result.volumes.borrowNatural,'0');assert.equal(result.volumes.spoilNatural,'0');
});
test('rejects malformed configuration, impossible percentages, nonpositive factors and negative rates/distances',()=>{
  const mutations=[c=>c.enabled='yes',c=>c.usableCutPercent='100.01',c=>c.usableCutPercent='-1',c=>c.usableCutPercent=70,c=>c.naturalPerCompactedFill='0',c=>c.loosePerNatural='0',c=>c.loosePerNatural='NaN',c=>c.borrowMaterial=null,c=>c.borrowMaterial.unitPrice='-1',c=>c.borrowHaul.distanceKm='-1',c=>c.reuseHaul.enabled='yes'];
  for(const mutate of mutations){const config=base();mutate(config);assert.throws(()=>validateEarthworkBalance(config),RangeError);}
});
test('rejects invalid geometric quantities and completeness states',()=>{
  for(const value of [-1,-5e-10,Infinity,NaN])assert.throws(()=>calculateEarthworkBalance(input(value,2),base()),RangeError);
  assert.throws(()=>calculateEarthworkBalance({...input(),geometryComplete:'yes'},base()),RangeError);
});
test('each budget keeps unique prerequisite reasons without inheriting other item errors',()=>{
  const config=allBudgets();config.loosePerNatural='';
  const result=calculateEarthworkBalance({...input(5,80,false),geometryReasons:['测区有缺口','测区有缺口','边坡待确认']},config);
  const expected=['测区有缺口','边坡待确认','天然方转松方系数待填写'];
  assert.deepEqual(result.pendingReasons,expected);
  for(const item of result.items)assert.deepEqual(item.pendingReasons,expected);
  const rates=allBudgets();rates.borrowMaterial.unitPrice='';rates.borrowHaul.distanceKm='';
  const independent=calculateEarthworkBalance(input(),rates);
  assert.equal(independent.items[0].pendingReasons.length,1);assert.match(independent.items[0].pendingReason,/材料.*单价待填写/);
  assert.equal(independent.items[2].pendingReasons.length,1);assert.match(independent.items[2].pendingReason,/运输.*运距待填写/);
  assert.deepEqual(independent.items[1].pendingReasons,[]);assert.deepEqual(independent.items[3].pendingReasons,[]);
});
