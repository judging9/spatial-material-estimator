import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildWallRegions } from '../static/studio/lib/wall-regions.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { regionMetrics } from '../static/studio/lib/geometry.js';

const wall = (id, x0, y0, x1, y1, thickness = 10) => ({ id, start: {x:x0,y:y0}, end:{x:x1,y:y1}, thickness });
const perimeter = () => [wall('top',100,100,500,100), wall('right',500,100,500,400), wall('bottom',500,400,100,400), wall('left',100,400,100,100)];
const divider = () => wall('divider',300,100,300,400);
const ids = () => { let index=0; return prefix => `${prefix}-${++index}`; };
const material = (id='wood', overrides={}) => ({id:'item-original',materialId:id,materialName:id,unit:'m²',unitPrice:'100',wasteRate:'0',laborRate:'10',additionalCost:'5',quantityMode:'area',quantity:'0',...overrides});
const priced = () => {
  const result = rebuildWallRegions(perimeter(), [], ids());
  assert.equal(result.error,null);
  result.regions[0].name = '客厅'; result.regions[0].items = [material()]; result.regions[0].additionalCost='20';
  return result.regions;
};
const manual = () => ({id:'manual',name:'独立手绘区',points:[{x:700,y:100},{x:800,y:100},{x:800,y:200},{x:700,y:200}],holes:[],hidden:false,items:[material()],additionalCost:'0'});
const project = (regions, planError=null) => ({id:'p',name:'墙体工程',regions,calibration:{metersPerPixel:.01},additionalCost:'0',taxRate:'6',planError});

test('墙长与墙厚编辑保留稳定区域身份、名称和材料价格配置', () => {
  const previous = priced();
  const walls = perimeter();
  walls[0].end.x=600; walls[1].start.x=600; walls[1].end.x=600; walls[2].start.x=600;
  const updated = rebuildWallRegions(walls, previous, ids());
  assert.equal(updated.error,null);
  assert.equal(updated.regions[0].id,previous[0].id);
  assert.equal(updated.regions[0].name,'客厅');
  assert.deepEqual(updated.regions[0].items,previous[0].items);
  assert.equal(updated.regions[0].additionalCost,'20');
  assert.ok(regionMetrics(updated.regions[0],{metersPerPixel:.01}).netArea > regionMetrics(previous[0],{metersPerPixel:.01}).netArea);
  const thicker = rebuildWallRegions(walls.map(w=>({...w,thickness:20})), updated.regions, ids());
  assert.equal(thicker.error,null);
  assert.equal(thicker.regions[0].id,previous[0].id);
  assert.ok(regionMetrics(thicker.regions[0],{metersPerPixel:.01}).netArea < regionMetrics(updated.regions[0],{metersPerPixel:.01}).netArea);
});

test('一间房拆成两间继承材料单价，固定费用不会重复计入', () => {
  const previous=priced();
  const result=rebuildWallRegions([...perimeter(),divider()],previous,ids());
  assert.equal(result.error,null);
  assert.equal(result.regions.length,2);
  assert.equal(new Set(result.regions.map(r=>r.id)).size,2);
  assert.ok(result.regions.every(r=>r.items[0].unitPrice==='100' && r.items[0].materialId==='wood'));
  assert.equal(result.regions.reduce((sum,r)=>sum+Number(r.additionalCost),0),20);
  assert.equal(result.regions.reduce((sum,r)=>sum+Number(r.items[0].additionalCost),0),5);
  assert.match(result.notice,/拆分/);
});

test('拆分手工材料的数量没有可靠分配依据，必须重新填写后计算', () => {
  const previous=priced(); previous[0].items.push(material('pieces',{id:'manual-item',unit:'件',quantityMode:'manual',quantity:'3'}));
  const result=rebuildWallRegions([...perimeter(),divider()],previous,ids());
  assert.ok(result.regions.every(r=>r.items[1].quantity==='0'));
  assert.equal(calculateProject(project(result.regions)).total,null);
});

test('合并不同材料配置清空材料，防止两个方案都作用于整片合并区域', () => {
  const separate=rebuildWallRegions([...perimeter(),divider()],[],ids()).regions;
  separate[0].items=[material('wood')]; separate[1].items=[material('tile')];
  const merged=rebuildWallRegions(perimeter(),separate,ids());
  assert.equal(merged.error,null);
  assert.equal(merged.regions.length,1);
  assert.deepEqual(merged.regions[0].items,[]);
  assert.match(merged.notice,/配置不同/);
  assert.equal(calculateProject(project(merged.regions)).total,null);
});

test('合并相同方案只保留一份材料配置，按新净面积重新计价', () => {
  const separate=rebuildWallRegions([...perimeter(),divider()],[],ids()).regions;
  separate.forEach((r,i)=>r.items=[material('wood',{id:`item-${i}`})]);
  const merged=rebuildWallRegions(perimeter(),separate,ids());
  assert.equal(merged.error,null);
  assert.equal(merged.regions[0].items.length,1);
  assert.equal(merged.regions[0].items[0].materialId,'wood');
  assert.equal(merged.regions[0].items[0].additionalCost,'0');
  assert.equal(calculateProject(project(merged.regions)).pending,false);
});

test('断墙时清除墙体报价并缓存配置，补齐后恢复相同区域和单价', () => {
  const previous=[manual(),...priced()];
  const failed=rebuildWallRegions(perimeter().slice(0,3),previous,ids());
  assert.match(failed.error,/尚未闭合/);
  assert.deepEqual(failed.regions,[previous[0]]);
  assert.equal(failed.cache.length,1);
  assert.deepEqual(failed.cache[0].items,previous[1].items);
  const quote=calculateProject(project(failed.regions,failed.error));
  assert.equal(quote.pending,true);
  for(const key of ['total','materialCost','laborCost','tax','subtotal','beforeTax']) assert.equal(quote[key],null);
  assert.match(quote.pendingReason,/尚未闭合/);
  const repaired=rebuildWallRegions(perimeter(),[...failed.regions,...failed.cache],ids());
  assert.equal(repaired.error,null);
  assert.equal(repaired.regions[1].id,previous[1].id);
  assert.deepEqual(repaired.regions[1].items,previous[1].items);
});

test('墙体区域不覆盖已有手绘区域；错误时保留手绘区和墙体配置缓存', () => {
  const previous=priced();
  const overlapping={...manual(),points:[{x:110,y:110},{x:130,y:110},{x:130,y:130},{x:110,y:130}]};
  const result=rebuildWallRegions(perimeter(),[overlapping,...previous],ids());
  assert.match(result.error,/重叠/);
  assert.deepEqual(result.regions,[overlapping]);
  assert.deepEqual(result.cache,previous);
});

test('空墙线无错误；无区域但墙线未闭合的工程不得给出零元正式报价', () => {
  const empty=rebuildWallRegions([],[],ids());
  assert.equal(empty.error,null);
  assert.equal(calculateProject(project([])).total,'0.00');
  const unfinished=rebuildWallRegions([wall('single',0,0,400,0)],[],ids());
  assert.match(unfinished.error,/尚未闭合/);
  assert.equal(calculateProject(project([],unfinished.error)).total,null);
});

const rotate=(walls,angle)=>{
  const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a),p=q=>({x:q.x*c-q.y*s,y:q.x*s+q.y*c});
  return walls.map(w=>({...w,start:p(w.start),end:p(w.end)}));
};
test('户型转为斜墙后保留稳定房间身份、名称和实际计价配置',()=>{
  const previous=priced(),updated=rebuildWallRegions(rotate(perimeter(),33),previous,ids());
  assert.equal(updated.error,null);assert.equal(updated.regions.length,1);
  assert.equal(updated.regions[0].id,previous[0].id);assert.equal(updated.regions[0].name,'客厅');assert.deepEqual(updated.regions[0].items,previous[0].items);
  assert.ok(Math.abs(regionMetrics(updated.regions[0],{metersPerPixel:.01}).netArea-11.31)<1e-8);
  assert.equal(calculateProject(project(updated.regions)).total,calculateProject(project(previous)).total);
});
test('斜分隔墙拆分保留单价但不复制固定费用，断开后可恢复',()=>{
  const previous=priced(),angled=rotate([...perimeter(),divider()],31),split=rebuildWallRegions(angled,previous,ids());
  assert.equal(split.error,null);assert.equal(split.regions.length,2);assert.ok(split.regions.every(r=>r.items[0].unitPrice==='100'));
  assert.equal(split.regions.reduce((s,r)=>s+Number(r.additionalCost),0),20);
  const broken=rebuildWallRegions(angled.slice(0,3),split.regions,ids());assert.match(broken.error,/尚未闭合/);
  const repaired=rebuildWallRegions(angled,[...broken.regions,...broken.cache],ids());assert.equal(repaired.error,null);
  assert.deepEqual(repaired.regions.map(r=>r.id).sort(),split.regions.map(r=>r.id).sort());
});
