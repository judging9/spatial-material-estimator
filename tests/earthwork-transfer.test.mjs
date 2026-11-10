import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.EARTHWORK_TRANSFER_BUILD?pathToFileURL(resolve(process.env.EARTHWORK_TRANSFER_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {createEarthworkTransfer,validateEarthworkTransferConfig,calculateEarthworkTransfer}=await import(new URL('lib/earthwork-transfer.js',root));
const {addDecimal,multiplyDecimal}=await import(new URL('lib/pricing.js',root));
const road=(id,available='0',borrow='0',spoil=available,factor='1')=>({id,name:id,availableNatural:available,borrowNatural:borrow,spoilNatural:spoil,loosePerNatural:factor,complete:true});
const route=(id,from,to,price='1',distance='1',enabled=true)=>({id,fromRoadId:from,toRoadId:to,enabled,distanceKm:distance,unitPrice:price});
const config=(roads,routes=[])=>({enabled:true,roadIds:roads.map(road=>road.id),routes});
const run=(roads,routes=[])=>calculateEarthworkTransfer({roads},config(roads,routes));
const quantity=(result,id)=>result.routes.find(route=>route.id===id)?.naturalQuantity;

test('factory leaves compatibility, roads, route distances, prices and activation to the user',()=>{
  assert.deepEqual(createEarthworkTransfer(),{enabled:false,roadIds:[],routes:[]});
  assert.doesNotThrow(()=>validateEarthworkTransferConfig());assert.doesNotThrow(()=>validateEarthworkTransferConfig(createEarthworkTransfer()));
  const result=calculateEarthworkTransfer({roads:[]});assert.equal(result.enabled,false);assert.equal(result.pending,false);assert.equal(result.totalHaulCost,'0.00');
});

test('one compatible source supplies natural volume, using source loose factor and actual entered distance',()=>{
  const result=run([road('A','8','0','10','1.25'),road('B','0','5','0','1.1')],[route('ab','A','B','2','3')]);
  assert.equal(result.transferredNatural,'5');assert.equal(result.pending,false);
  assert.deepEqual(result.routes.map(row=>[row.naturalQuantity,row.looseQuantity,row.haulQuantity,row.amount]),[['5','6.25','18.75','37.50']]);
  assert.equal(result.roads[0].residualSpoilNatural,'5');assert.equal(result.roads[1].residualBorrowNatural,'0');assert.equal(result.totalHaulCost,'37.50');
});

test('unusable spoil cannot supply a shortage, available cap preserves unusable natural volume',()=>{
  const result=run([road('A','3','0','20'),road('B','0','8')],[route('ab','A','B')]);
  assert.equal(result.transferredNatural,'3');assert.equal(result.roads[0].residualSpoilNatural,'17');assert.equal(result.roads[1].residualBorrowNatural,'5');
});

test('no confirmed direction creates no hidden connection or centroid-distance guess',()=>{
  const roads=[road('A','10'),road('B','0','10')],result=run(roads,[route('ab','A','B','','',false)]);
  assert.equal(result.transferredNatural,'0');assert.equal(result.routes.length,0);assert.equal(result.roads[0].residualSpoilNatural,'10');assert.equal(result.roads[1].residualBorrowNatural,'10');
});

test('empty and single-road selections are complete zero-transfer plans',()=>{
  for(const roads of [[],[road('A','2')]]){const result=run(roads);assert.equal(result.pending,false);assert.equal(result.transferredNatural,'0');assert.equal(result.totalHaulCost,'0.00');}
});

test('direction matters and surplus is never transshipped through another road',()=>{
  const roads=[road('A','10'),road('B','0','5'),road('C')];
  const backward=run(roads,[route('ba','B','A')]);assert.equal(backward.transferredNatural,'0');
  const relay=run(roads,[route('ac','A','C'),route('cb','C','B')]);assert.equal(relay.transferredNatural,'0');
});

test('reverse residual paths undo the greedy first assignment to attain maximum reuse',()=>{
  const roads=[road('A','1'),road('B','1'),road('C','0','1'),road('D','0','1')];
  const result=run(roads,[route('ac','A','C','1'),route('ad','A','D','2'),route('bc','B','C','2')]);
  assert.equal(result.transferredNatural,'2');assert.equal(quantity(result,'ac'),'0');assert.equal(quantity(result,'ad'),'1');assert.equal(quantity(result,'bc'),'1');assert.equal(result.totalHaulCost,'4.00');
});

test('minimum transport cost uses rerouting even when every assignment attains equal maximum reuse',()=>{
  const roads=[road('A','1'),road('B','1'),road('C','0','1'),road('D','0','1')];
  const result=run(roads,[route('ac','A','C','1'),route('ad','A','D','2'),route('bc','B','C','2'),route('bd','B','D','100')]);
  assert.equal(result.transferredNatural,'2');assert.equal(result.totalHaulCost,'4.00');assert.equal(quantity(result,'bd'),'0');
});

test('objective maximises compatible reuse before cost, including an expensive necessary route',()=>{
  const result=run([road('A','2'),road('B','0','2')],[route('ab','A','B','1000000')]);
  assert.equal(result.transferredNatural,'2');assert.equal(result.totalHaulCost,'2000000.00');
});

test('exact source loose-volume cost decides routes rather than nominal price alone',()=>{
  const roads=[road('A','1','0','1','1'),road('B','1','0','1','2'),road('C','0','1')];
  const result=run(roads,[route('ac','A','C','.0049'),route('bc','B','C','.0044')]);
  assert.equal(quantity(result,'ac'),'1');assert.equal(quantity(result,'bc'),'0');assert.equal(result.totalHaulCost,'0.00');
});

test('sub-cent costs are compared exactly before money rounding and route input order cannot mask a cheaper route',()=>{
  const roads=[road('A','1'),road('B','1'),road('C','0','1')];
  for(const routes of [[route('ac','A','C','.0049'),route('bc','B','C','.0044')],[route('bc','B','C','.0044'),route('ac','A','C','.0049')]]){
    const result=run(roads,routes);assert.equal(quantity(result,'ac'),'0');assert.equal(quantity(result,'bc'),'1');assert.equal(result.totalHaulCost,'0.00');
  }
});

test('split allocation conserves every source and demand and totals once without negative residuals',()=>{
  const roads=[road('A','4','0','7','1.2'),road('B','3','0','5','1.1'),road('C','0','5'),road('D','0','4')];
  const result=run(roads,[route('ac','A','C','1'),route('ad','A','D','2'),route('bc','B','C','3'),route('bd','B','D','1')]);
  assert.equal(result.transferredNatural,'7');
  for(const row of result.roads){assert.equal(addDecimal(row.outgoingNatural,row.residualSpoilNatural),row.spoilNatural);assert.equal(addDecimal(row.incomingNatural,row.residualBorrowNatural),row.borrowNatural);assert.ok(!row.residualSpoilNatural.startsWith('-'));assert.ok(!row.residualBorrowNatural.startsWith('-'));}
  assert.equal(result.roads.reduce((sum,row)=>addDecimal(sum,row.outgoingNatural),'0'),result.transferredNatural);
  assert.equal(result.roads.reduce((sum,row)=>addDecimal(sum,row.incomingNatural),'0'),result.transferredNatural);
});

test('quantities above binary safe integers and tiny deficits remain exact decimal strings',()=>{
  const quantity='9007199254740993.00000000000000001',roads=[road('A',quantity),road('B','0','9007199254740993')];
  const result=run(roads,[route('ab','A','B','0')]);assert.equal(result.transferredNatural,'9007199254740993');assert.equal(result.roads[0].residualSpoilNatural,'0.00000000000000001');
});

test('a real fractional capacity is not quantised to pixels, cents or nanovolumes',()=>{
  const result=run([road('A','0.000000000000000001'),road('B','0','0.000000000000000002')],[route('ab','A','B','1000000000000000')]);
  assert.equal(result.transferredNatural,'0.000000000000000001');assert.equal(result.roads[1].residualBorrowNatural,'0.000000000000000001');assert.equal(result.routes[0].haulQuantity,'0.000000000000000001');
});

test('money rounds per actual route only after physical multiplication and sums those item amounts',()=>{
  const result=run([road('A','1'),road('B','1'),road('C','0','2')],[route('ac','A','C','.005'),route('bc','B','C','.005')]);
  assert.deepEqual(result.routes.map(row=>row.amount),['0.01','0.01']);assert.equal(result.totalHaulCost,'0.02');
});

test('source loose coefficient is retained separately from natural and haul quantities',()=>{
  const result=run([road('A','.22','0','.22','1.25'),road('B','0','.22','0','3')],[route('ab','A','B','.8','5')]);
  assert.equal(result.routes[0].naturalQuantity,'0.22');assert.equal(result.routes[0].looseQuantity,'0.275');assert.equal(result.routes[0].haulQuantity,'1.375');assert.equal(result.routes[0].amount,'1.10');
});

test('missing geometry or soil conversion invalidates the complete plan instead of using partial capacities',()=>{
  const roads=[road('A','10'),{...road('B','0','8'),complete:false,pendingReasons:['未完整覆盖地形','未完整覆盖地形']}],result=run(roads,[route('ab','A','B')]);
  assert.equal(result.pending,true);assert.equal(result.transferredNatural,null);assert.equal(result.totalHaulCost,null);assert.equal(result.knownHaulCost,'0.00');
  assert.ok(result.roads.every(row=>row.incomingNatural===null&&row.residualBorrowNatural===null));assert.ok(result.routes.every(row=>row.naturalQuantity===null&&row.amount===null));assert.equal(result.pendingReasons.length,1);
});

test('null available, borrow, spoil or loose factor cannot yield an apparently complete result',()=>{
  for(const field of ['availableNatural','borrowNatural','spoilNatural','loosePerNatural']){
    const a=road('A','1');a[field]=null;const result=run([a,road('B','0','1')],[route('ab','A','B')]);assert.equal(result.pending,true,field);assert.equal(result.transferredNatural,null,field);
  }
});

test('missing road references and unselected route endpoints are pending drafts, not invented zero-volume roads',()=>{
  const a=road('A','2'),b=road('B','0','2'),cfg=config([a,b],[route('ab','A','B')]);
  let result=calculateEarthworkTransfer({roads:[a]},cfg);assert.equal(result.pending,true);assert.match(result.pendingReason,/已不存在/);
  cfg.roadIds=['A'];result=calculateEarthworkTransfer({roads:[a,b]},cfg);assert.equal(result.pending,true);assert.match(result.pendingReason,/端点未选入/);
});

test('necessary route distance or unit price must be supplied before any derived allocation',()=>{
  const roads=[road('A','1'),road('B','0','1')];
  for(const [distance,price,reason]of [['','1',/运距/],['1','',/单价/]]){const result=run(roads,[route('ab','A','B',price,distance)]);assert.equal(result.transferredNatural,null);assert.equal(result.routes[0].haulQuantity,null);assert.match(result.pendingReason,reason);}
});

test('zero possible source or destination volume requires no route price or distance',()=>{
  for(const roads of [[road('A'),road('B','0','2')],[road('A','2'),road('B')]]){
    const result=run(roads,[route('ab','A','B','','')]);assert.equal(result.pending,false);assert.equal(result.transferredNatural,'0');assert.equal(result.routes[0].haulQuantity,'0');assert.equal(result.routes[0].amount,'0.00');assert.equal(result.routes[0].unitPrice,'');
  }
});

test('explicit zero distance or price participates with truthful zero cost and no fabricated rate',()=>{
  const roads=[road('A','2'),road('B','0','2')];
  for(const routeInput of [route('ab','A','B','','0'),route('ab','A','B','0','3')]){const result=run(roads,[routeInput]);assert.equal(result.transferredNatural,'2');assert.equal(result.totalHaulCost,'0.00');}
});

test('only selected roads and enabled user directions constrain the plan',()=>{
  const roads=[road('A','1'),road('B','0','1'),{...road('outside'),complete:false}];
  const result=calculateEarthworkTransfer({roads},config(roads.slice(0,2),[route('ab','A','B'),route('other','outside','A','','',false)]));
  assert.equal(result.pending,false);assert.equal(result.transferredNatural,'1');assert.equal(result.roads.length,2);assert.equal(result.routes.length,1);
});

test('all input objects and rated natural-volume records remain immutable, including returned arrays',()=>{
  const input={roads:[road('A','3'),road('B','0','2')]},cfg=config(input.roads,[route('ab','A','B')]),before=structuredClone({input,cfg});
  const result=calculateEarthworkTransfer(input,cfg);assert.deepEqual({input,cfg},before);result.roads[0].spoilNatural='999';result.routes[0].unitPrice='999';assert.deepEqual({input,cfg},before);
});

test('duplicate identities, duplicate directions, self routes and invalid settings are rejected',()=>{
  const roads=[road('A','1'),road('B','0','1')],base=config(roads,[route('ab','A','B')]);
  for(const change of [cfg=>cfg.enabled='yes',cfg=>cfg.roadIds=['A','A'],cfg=>cfg.routes[0].toRoadId='A',cfg=>cfg.routes.push({...route('ab','B','A')}),cfg=>cfg.routes.push(route('duplicate','A','B')),cfg=>cfg.routes[0].distanceKm='-1',cfg=>cfg.routes[0].unitPrice='NaN',cfg=>cfg.routes[0].unitPrice=0,cfg=>cfg.routes[0].enabled=1,cfg=>cfg.roadIds=['']]){
    const cfg=structuredClone(base);change(cfg);assert.throws(()=>validateEarthworkTransferConfig(cfg),RangeError);
  }
});

test('capacity limits, impossible natural volumes and invalid source records fail explicitly',()=>{
  assert.throws(()=>validateEarthworkTransferConfig({enabled:true,roadIds:Array.from({length:13},(_,i)=>'r'+i),routes:[]}),/最多选择 12/);
  const cfg={enabled:true,roadIds:[],routes:Array.from({length:133},(_,i)=>route('p'+i,'a'+i,'b'+i))};assert.throws(()=>validateEarthworkTransferConfig(cfg),/最多设置 132/);
  assert.throws(()=>run([road('A','2','0','1'),road('B','0','2')],[route('ab','A','B')]),/不能大于剩余弃方/);
  assert.throws(()=>run([road('A','-1'),road('B','0','1')],[route('ab','A','B')]),RangeError);
  assert.throws(()=>run([road('A','1','0','1','0'),road('B','0','1')],[route('ab','A','B')]),/必须大于零/);
  assert.throws(()=>calculateEarthworkTransfer({roads:[road('A'),road('A')]},{enabled:true,roadIds:['A'],routes:[]}),/不能重复/);
});

test('tiny exact rate differences still select the lower-cost maximum-reuse direction',()=>{
  const roads=[road('A','1'),road('B','1'),road('C','0','1')];
  const result=run(roads,[route('ac','A','C','1.000000000000000001'),route('bc','B','C','1')]);assert.equal(quantity(result,'ac'),'0');assert.equal(quantity(result,'bc'),'1');
});

test('deterministic equal-cost allocation remains feasible and stable across repeated calculations',()=>{
  const roads=[road('A','2'),road('B','2'),road('C','0','3'),road('D','0','1')],routes=[route('ac','A','C'),route('ad','A','D'),route('bc','B','C'),route('bd','B','D')];
  const first=run(roads,routes);assert.equal(first.transferredNatural,'4');assert.equal(first.totalHaulCost,'4.00');assert.deepEqual(run(roads,routes),first);
});

test('small complete and restricted transportation plans match an independent exhaustive integer oracle',()=>{
  const patterns=[[1,2,3,4],[1,2,2,100],[0,0,0,0],[4,3,2,1],[0,null,1,3],[1,2,2,null],[null,4,3,2]];
  for(const a of [0,1,2])for(const b of [0,1,2])for(const c of [0,1,2])for(const d of [0,1,2])for(const prices of patterns){
    let maximum=-1,minimumCost=Infinity;
    for(let ac=0;ac<=a;ac++)for(let ad=0;ad<=a;ad++)for(let bc=0;bc<=b;bc++)for(let bd=0;bd<=b;bd++){
      const flows=[ac,ad,bc,bd];if(ac+ad>a||bc+bd>b||ac+bc>c||ad+bd>d||flows.some((flow,index)=>flow>0&&prices[index]===null))continue;
      const flow=ac+ad+bc+bd,cost=flows.reduce((total,value,index)=>total+value*(prices[index]??0),0);
      if(flow>maximum){maximum=flow;minimumCost=cost;}else if(flow===maximum)minimumCost=Math.min(minimumCost,cost);
    }
    const roads=[road('A',String(a)),road('B',String(b)),road('C','0',String(c)),road('D','0',String(d))],endpoints=[['A','C'],['A','D'],['B','C'],['B','D']];
    const routes=prices.flatMap((price,index)=>price===null?[]:[route(String(index),...endpoints[index],String(price))]),result=run(roads,routes);
    assert.equal(result.transferredNatural,String(maximum));assert.equal(result.totalHaulCost,minimumCost.toFixed(2),JSON.stringify({a,b,c,d,prices}));
  }
});

test('maximum supported group produces complete exact conservation without expanding per-volume units',()=>{
  const roads=Array.from({length:12},(_,i)=>i<6?road('r'+i,'1000000.123456789','0','1000000.123456789','1.25'):road('r'+i,'0','1000000.123456789'));
  const routes=[];for(let i=0;i<6;i++)for(let j=6;j<12;j++)routes.push(route('p'+i+'-'+j,'r'+i,'r'+j,String(i+j),'2'));
  const result=run(roads,routes);assert.equal(result.pending,false);assert.equal(result.transferredNatural,multiplyDecimal('1000000.123456789','6'));assert.ok(result.roads.slice(0,6).every(row=>row.residualSpoilNatural==='0'));assert.ok(result.roads.slice(6).every(row=>row.residualBorrowNatural==='0'));
});
