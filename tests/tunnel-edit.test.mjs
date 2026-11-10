import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTunnelPriceEdit } from '../static/studio/lib/tunnel-edit.js';
const source=()=>({enabled:true,startStation:1,endStation:20,clearHeight:5,liningThickness:.4,shape:'box',pricingEnabled:true,unitPrice:'12.50',laborRate:'3',additionalCost:'0',provenance:{source:'供应商报价',priceDate:'2026-11-01',supplier:'旧供应商',sourceUrl:'https://example.com/price',spec:'箱形隧道',region:'上海'}});
test('manual tunnel draft price changes clear old supplier/date attribution without mutating the original',()=>{
 const initial=source(),draft={...initial,unitPrice:'15'};const next=prepareTunnelPriceEdit(initial,draft);
 assert.deepEqual(next.provenance,{source:'用户调整单价',spec:'箱形隧道',region:'上海'});assert.equal(initial.provenance.supplier,'旧供应商');assert.equal(draft.provenance.priceDate,'2026-11-01');
});
test('equivalent decimal prices and labor-only changes preserve the real material quotation',()=>{
 const initial=source();assert.deepEqual(prepareTunnelPriceEdit(initial,{...initial,unitPrice:'12.500'}).provenance,initial.provenance);assert.deepEqual(prepareTunnelPriceEdit(initial,{...initial,laborRate:'8'}).provenance,initial.provenance);
});
test('blank and zero prices are distinct and source association stays available for a future refresh',()=>{
 const initial={...source(),unitPrice:'0',priceMaterialId:'catalog-one',priceSourceUnitPrice:'0'};const next=prepareTunnelPriceEdit(initial,{...initial,unitPrice:''});assert.equal(next.provenance.source,'用户调整单价');assert.equal(next.priceMaterialId,'catalog-one');assert.equal(next.priceSourceUnitPrice,'0');
 const fresh=source();delete fresh.provenance;assert.equal(prepareTunnelPriceEdit(fresh,{...fresh,unitPrice:'22'}).provenance,undefined);
});
