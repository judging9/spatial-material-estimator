import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuildWallRegions} from '../static/studio/lib/wall-regions.js';
const chain=[{x:100,y:100},{x:500,y:100},{x:500,y:400},{x:100,y:400}];
const walls=chain.map((p,i)=>({id:'wall'+i,start:p,end:chain[(i+1)%4],thickness:20,height:280}));
const divider={id:'divider',start:{x:300,y:100},end:{x:300,y:400},thickness:20,height:280};
const ceiling={enabled:true,height:260,additionalCost:'30',items:[{id:'ceiling-price',materialId:'x',unit:'m²',quantityMode:'area',unitPrice:'100',wasteRate:'10',laborRate:'20',additionalCost:'50'}]};
test('splitting a ceiling keeps prices and height but never duplicates its fixed fees or item IDs',()=>{
  const first=rebuildWallRegions(walls,[],undefined,'clean');first.regions[0].ceiling=structuredClone(ceiling);
  const split=rebuildWallRegions([...walls,divider],first.regions,undefined,'clean');
  assert.equal(split.error,null);assert.equal(split.regions.length,2);
  assert.equal(split.regions.reduce((s,r)=>s+Number(r.ceiling.additionalCost),0),30);
  assert.equal(split.regions.reduce((s,r)=>s+Number(r.ceiling.items[0].additionalCost),0),50);
  assert.equal(new Set(split.regions.map(r=>r.ceiling.items[0].id)).size,2);
  assert.ok(split.regions.every(r=>r.ceiling.height===260&&r.ceiling.items[0].unitPrice==='100'));
});
test('merging different ceiling materials requires a new scope instead of billing both over the full room',()=>{
  const split=rebuildWallRegions([...walls,divider],[],undefined,'clean');
  for(const r of split.regions)r.ceiling=structuredClone(ceiling);
  split.regions[1].ceiling.items[0].materialId='different';
  const merged=rebuildWallRegions(walls,split.regions,undefined,'clean');
  assert.equal(merged.error,null);assert.equal(merged.regions.length,1);
  assert.equal(merged.regions[0].ceiling.enabled,false);assert.deepEqual(merged.regions[0].ceiling.items,[]);
  assert.equal(merged.regions[0].ceiling.additionalCost,'0');
});
