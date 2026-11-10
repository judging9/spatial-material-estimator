import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriceRows, normalizePriceUnit, parsePriceText, applyPriceRows, findPriceTarget } from '../static/studio/lib/material-prices.js';
import { createMaterialSnapshot } from '../static/studio/lib/materials.js';
import { calculateProject } from '../static/studio/lib/pricing.js';

const input=()=>[{name:'螺纹钢',spec:'HRB400E',unit:'吨',price:'3,450.50',region:'全国',price_date:'2026-11-01',source:'国家统计局',category:'钢材'}];
test('official source rows preserve original units, dates, specs, and decimal prices',()=>{
  const {candidates,errors}=normalizePriceRows(input(),{sourceUrl:'https://www.stats.gov.cn/sj/zxfb/latest.html'});
  assert.deepEqual(errors,[]);assert.equal(candidates[0].unit,'吨');assert.equal(candidates[0].unitPrice,'3450.5');
  const updated=applyPriceRows([],candidates,[{id:'0'}],'2026-11-02T00:00:00Z');
  assert.equal(updated[0].unitPrice,'3450.5');assert.equal(updated[0].provenance.priceDate,'2026-11-01');
  assert.equal(updated[0].provenance.sourceUrl,'https://www.stats.gov.cn/sj/zxfb/latest.html');
  assert.equal(updated[0].provenance.updatedAt,'2026-11-02T00:00:00Z');
  assert.equal(createMaterialSnapshot(updated[0]).quantityMode,'manual');
});
test('missing source values stay unknown; importer defaults can supply locality, source, and date',()=>{
  const rows=[{name:'瓷砖',unit:'平方米',price:'81',region:'全国',source:'Excel导入',price_date:'2026-11-07',region_provided:false,source_provided:false,date_provided:false}];
  const unspecified=normalizePriceRows(rows).candidates[0];assert.equal(unspecified.region,'未注明地区');assert.equal(unspecified.priceDate,'');
  const candidate=normalizePriceRows(rows,{region:'浙江杭州',source:'当地信息价',priceDate:'2026-10-31'}).candidates[0];
  assert.equal(candidate.region,'浙江杭州');assert.equal(candidate.source,'当地信息价');assert.equal(candidate.priceDate,'2026-10-31');assert.equal(candidate.unit,'m²');
});
test('bulk prices cannot overwrite a surface material and failed preview leaves originals intact',()=>{
  const existing=[{id:'floor',name:'地板',unit:'m²',unitPrice:'100',wasteRate:'5',image:'',color:'#123456'}],prior=structuredClone(existing);
  const {candidates}=normalizePriceRows(input());assert.throws(()=>applyPriceRows(existing,candidates,[{id:'0',targetId:'floor'}]),/单位/);
  assert.deepEqual(existing,prior);
  assert.equal(normalizePriceUnit('重量箱'),null);
  const unsupported=normalizePriceRows([{name:'玻璃',unit:'重量箱',price:25}]);assert.equal(unsupported.candidates[0].supported,false);
  assert.throws(()=>applyPriceRows(existing,unsupported.candidates,[{id:'0'}]),/单位/);
});
test('refreshing imported library material is explicit and does not mutate saved quote snapshots',()=>{
  const old=normalizePriceRows([{name:'瓷砖',unit:'m²',price:100,region:'杭州',price_date:'2026-10-31'}]).candidates;
  const library=applyPriceRows([],old,[{id:'0'}]);const snapshot=createMaterialSnapshot(library[0]);
  const current=normalizePriceRows([{name:'瓷砖',unit:'m²',price:'88.60',region:'杭州',price_date:'2026-11-07'}]).candidates;
  assert.equal(findPriceTarget(library,current[0]),library[0].id);
  const next=applyPriceRows(library,current,[{id:'0',targetId:library[0].id}]);assert.equal(next.length,1);assert.equal(next[0].unitPrice,'88.6');
  assert.equal(snapshot.unitPrice,'100');assert.equal(library[0].unitPrice,'100');
  assert.equal(snapshot.provenance.priceDate,'2026-10-31');
  assert.equal(next[0].provenance.priceDate,'2026-11-07');
  const other=normalizePriceRows([{name:'瓷砖',unit:'m²',price:75,region:'宁波'}]).candidates[0];assert.equal(findPriceTarget(library,other),null);
});
test('quoted CSV and tab-separated local website data preserve comma prices and provenance',()=>{
  const csv='名称,规格,单位,单价,地区,日期,来源\n"水泥,特种","42.5",吨,"1,234.50",上海,2026-11-01,"供应商"';
  const rows=parsePriceText(csv);assert.equal(rows[0].name,'水泥,特种');assert.equal(rows[0].price,'1,234.50');
  assert.equal(normalizePriceRows(rows).candidates[0].unitPrice,'1234.5');
  const tabs=parsePriceText('名称\t单位\t单价\t地区\t报价日期\n墙砖\t㎡\t86.25\t杭州\t2026-11-02');
  assert.equal(normalizePriceRows(tabs).candidates[0].unit,'m²');assert.equal(tabs[0].region,'杭州');
  assert.throws(()=>parsePriceText('名称,价格\n砖,100'),/单位/);assert.throws(()=>parsePriceText('名称,单位,单价\n"未闭合,m²,100'),/引号/);
});
test('invalid prices, dates, URLs and duplicate updates are rejected without substituting data',()=>{
  const invalid=[-1,NaN,Infinity,'=-2','1/2',''];
  const normalized=normalizePriceRows(invalid.map(price=>({name:'砖',unit:'m²',price})));assert.equal(normalized.candidates.length,0);assert.equal(normalized.errors.length,6);
  assert.equal(normalizePriceRows([{name:'砖',unit:'m²',price:10,price_date:'2026-02-30'}]).candidates.length,0);
  assert.equal(normalizePriceRows([{name:'砖',unit:'m²',price:10}],{sourceUrl:'javascript:alert(1)'}).candidates.length,0);
  const candidates=normalizePriceRows(input()).candidates;assert.throws(()=>applyPriceRows([],candidates,[{id:'0'},{id:'0'}]),/重复/);
});
test('new kg, tonne and cubic metre materials use manually supplied quantities reliably',()=>{
  for(const unit of ['kg','吨','m³']){
    const material=applyPriceRows([],normalizePriceRows([{name:'计量材料',unit,price:'0.105'}]).candidates,[{id:'0'}])[0];
    const item=createMaterialSnapshot(material,{quantity:'3'});
    const quote=calculateProject({id:'project',regions:[{id:'area',name:'数量计价',points:[],holes:[],items:[item]}],calibration:{metersPerPixel:null}});
    assert.equal(quote.pending,false);assert.equal(quote.total,'0.32');assert.equal(quote.regions[0].items[0].unit,unit);
  }
});
