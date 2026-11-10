import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateStructureModel, calculateStructureItems, normalizeStructureConfig, validateStructureState } from '../build/studio/lib/structure.js';
import { detectPlanRooms } from '../build/studio/lib/wall-plan.js';
import { summarize, validateItems } from '../build/studio/lib/cost.js';

const near=(value,expected,tolerance=1e-7)=>assert.ok(Math.abs(value-expected)<=tolerance,`${value} ≠ ${expected}`);
const empty=()=>({version:1,id:'structure-test',name:'结构验收',drawing:null,calibration:{metersPerPixel:null},regions:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const base={footprintSource:'rectangle',width:10,depth:10,floors:1,gridX:1,gridY:1,floorHeight:3,columnSize:400,slabThickness:110};
function active(project=empty(),config=base){return {...project,cost:{modules:{structure:{config,enabled:true}}}};}
function planRegion(points,holes=[]){return {id:'region',name:'标准层',points,holes,hidden:false,items:[],additionalCost:'0'};}

test('土建矩形方案100m²，柱止于板下，板量11m³不重复扣柱',()=>{
  const model=calculateStructureModel(empty(),base);
  near(model.quantities.buildingArea,100);near(model.quantities.slabs,11);
  assert.equal(model.columns.length,4);near(model.quantities.columns,1.8496);near(model.quantities.columnFormwork,18.496);
  near(model.quantities.foundation,4.5);near(model.quantities.cushion,.9);
  near(model.quantities.backfill+model.quantities.disposal,model.quantities.excavation);
});
test('增加标准层只复制地上构件与钢筋，基础及土方只计一次',()=>{
  const one=calculateStructureModel(empty(),base).quantities,three=calculateStructureModel(empty(),{...base,floors:3}).quantities;
  for(const key of ['columns','beams','slabs','masonry','columnFormwork','beamFormwork','slabFormwork','rebar','buildingArea'])near(three[key],one[key]*3);
  for(const key of ['foundation','cushion','foundationFormwork','excavation','backfill','disposal'])near(three[key],one[key]);
});
test('墙体占地与真实净房间合并成外轮廓，中心线400×300cm厚20cm时投影13.44m²',()=>{
  const points=[{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}];
  const walls=points.map((start,i)=>({id:'wall'+i,start,end:points[(i+1)%4],thickness:20,height:280}));
  const room=detectPlanRooms(walls)[0];
  const project={...empty(),drawing:{type:'plan'},calibration:{metersPerPixel:.01},walls,regions:[planRegion(room.points,room.holes)]};
  const model=calculateStructureModel(project,{floors:1,gridX:1,gridY:1});
  near(model.footprint.width,4.2);near(model.footprint.height,3.2);near(model.footprint.area,13.44);near(model.footprint.perimeter,14.8);
});
test('正交凹轮廓保持实际18m²，外包矩形30m²不冒充真实面积',()=>{
  const points=[{x:0,y:0},{x:600,y:0},{x:600,y:200},{x:200,y:200},{x:200,y:500},{x:0,y:500}];
  const project={...empty(),drawing:{type:'plan'},calibration:{metersPerPixel:.01},regions:[planRegion(points)]};
  const model=calculateStructureModel(project,{floors:1,gridX:1,gridY:1});
  near(model.footprint.area,18);near(model.quantities.slabs,1.98);assert.equal(model.columns.length,3);
});
test('楼板内部孔洞扣净面积，孔边不当作外墙周长，板侧模保留孔边',()=>{
  const points=[{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:0,y:1000}];
  const hole=[{x:400,y:400},{x:600,y:400},{x:600,y:600},{x:400,y:600}];
  const project={...empty(),drawing:{type:'plan'},calibration:{metersPerPixel:.01},regions:[planRegion(points,[hole])]};
  const model=calculateStructureModel(project,{floors:1,gridX:1,gridY:1});
  near(model.footprint.area,96);near(model.footprint.perimeter,40);near(model.footprint.boundaryPerimeter,48);near(model.quantities.slabs,10.56);
});
test('未校准、未闭合与斜边不能静默推断主体结构，明确矩形方案仍可计算',()=>{
  const points=[{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}];
  const image={...empty(),drawing:{type:'image'},regions:[planRegion(points)]};
  assert.throws(()=>calculateStructureModel(image),/校准/);
  assert.throws(()=>calculateStructureModel({...image,planError:'未闭合'}),/闭合/);
  near(calculateStructureModel(image,base).footprint.area,100);
  const diagonal={...image,drawing:{type:'plan'},calibration:{metersPerPixel:.01},regions:[planRegion([{x:0,y:0},{x:400,y:0},{x:200,y:300}])]};
  assert.throws(()=>calculateStructureModel(diagonal),/正交/);
});
test('土建参数校验拒绝0层、负数、非有限值、超限和错误枚举',()=>{
  for(const input of [{floors:0},{floors:31},{floorHeight:2},{columnSize:-1},{embedDepth:NaN},{width:Infinity},{gridX:1.5},{system:'unknown'},{slabThickness:undefined}]) {
    assert.throws(()=>normalizeStructureConfig(input),RangeError);
  }
  assert.throws(()=>validateStructureState({config:{floors:0}}),RangeError);
  assert.throws(()=>validateStructureState({modelGenerated:'yes'}),RangeError);
  assert.throws(()=>calculateStructureModel(empty(),{...base,width:100,gridX:1}),/跨距/);
});
test('三类基础有独立口径，不因地上层数重复，所有结果非负',()=>{
  const models=['spread','strip','raft'].map(foundation=>calculateStructureModel(empty(),{...base,foundation}));
  near(models[0].quantities.foundation,4.5);near(models[1].quantities.foundation,12.8);near(models[2].quantities.foundation,40);
  for(const model of models)for(const value of Object.values(model.quantities))assert.ok(Number.isFinite(value)&&value>=0);
});
test('框剪必须提供混凝土墙长度，墙混凝土与砌体分配守恒',()=>{
  assert.throws(()=>calculateStructureModel(empty(),{...base,system:'frame-shear'}),/混凝土墙长度/);
  const mixed=calculateStructureModel(empty(),{...base,system:'frame-shear',concreteWallLength:10});
  const frame=calculateStructureModel(empty(),base);
  near(mixed.quantities.concreteWalls+mixed.quantities.masonry,frame.quantities.masonry);
  assert.ok(mixed.quantities.concreteWalls>0);assert.ok(mixed.quantities.wallFormwork>0);
  assert.throws(()=>calculateStructureModel(empty(),{...base,system:'frame-shear',concreteWallLength:10000}),/总长/);
});
test('土建清单未启用时为空；生成项编号稳定唯一，指标及参考价均保留明确标记',()=>{
  assert.deepEqual(calculateStructureItems(empty()),[]);
  const items=calculateStructureItems(active());
  assert.ok(validateItems(items).ok);assert.equal(new Set(items.map(i=>i.id)).size,items.length);
  assert.ok(items.every(i=>i.estimate&&/^\d{12}$/.test(i.code)&&i.note.includes('方案估算')));
  assert.equal(items.find(i=>i.id==='structure:slabs').unitPrice,'520');
  assert.equal(items.find(i=>i.id==='structure:slabs').priceStatus,'reference');
  assert.equal(items.find(i=>i.id==='structure:excavation').priceStatus,'missing');
  assert.ok(summarize(items).missingPriceCount>0);
});
test('非C30无授权参考价时保持待填写，匹配原料仅显示供货参考且综合价仍待定',()=>{
  const unknown=calculateStructureItems(active(empty(),{...base,concreteGrade:'C40'}));
  assert.equal(unknown.find(i=>i.id==='structure:slabs').unitPrice,'0');
  assert.equal(unknown.find(i=>i.id==='structure:slabs').priceStatus,'missing');
  const project=active();project.cost.modules.structure.materials=[{id:'c30',name:'C30 商品混凝土',unit:'m³',unitPrice:'612.345',demo:false,provenance:{source:'地方供应商',priceDate:'2026-11-07'}}];
  const item=calculateStructureItems(project).find(i=>i.id==='structure:slabs');
  assert.equal(item.unitPrice,'0');assert.equal(item.amount,'0.00');assert.equal(item.priceStatus,'missing');
  assert.ok(item.note.includes('612.345')&&item.note.includes('2026-11-07')&&item.note.includes('不能直接充当综合施工报价'));
  assert.ok(summarize(calculateStructureItems(project)).missingPriceCount>summarize(calculateStructureItems(active())).missingPriceCount);
});
test('只有明确未税综合施工报价才可参考，原料不遮挡后续匹配且含税报价不得重复加税',()=>{
  const project=active();
  const raw={id:'c30-raw',name:'C30 商品混凝土',unit:'m³',unitPrice:'612.345',demo:false,provenance:{source:'地方供应商',priceDate:'2026-11-07'}};
  const construction={...raw,id:'c30-construction',unitPrice:'800',provenance:{...raw.provenance,priceBasis:'comprehensive-construction',taxIncluded:false}};
  project.cost.modules.structure.materials=[raw,construction];
  const item=calculateStructureItems(project).find(i=>i.id==='structure:slabs');
  assert.equal(item.unitPrice,'800');assert.equal(item.amount,'8800.00');assert.equal(item.priceStatus,'reference');
  assert.ok(item.note.includes('明确未税综合施工报价')&&item.note.includes('材料、人工及机械'));
  construction.provenance.taxIncluded=true;
  project.cost.modules.structure.materials=[construction];
  const taxed=calculateStructureItems(project).find(i=>i.id==='structure:slabs');
  assert.equal(taxed.unitPrice,'0');assert.equal(taxed.priceStatus,'missing');assert.ok(taxed.note.includes('未明确为未税价'));
  delete construction.provenance.taxIncluded;
  assert.equal(calculateStructureItems(project).find(i=>i.id==='structure:slabs').priceStatus,'missing');
});
test('综合单价覆盖即时按分重算，重新生成和几何变更保留价格覆盖',()=>{
  const project=active();project.cost.modules.structure.priceOverrides={'structure:slabs':'123.456'};
  const initial=calculateStructureItems(project).find(i=>i.id==='structure:slabs');
  assert.equal(initial.quantity,'11');assert.equal(initial.amount,'1358.02');assert.equal(initial.priceStatus,'confirmed');
  project.cost.modules.structure.config={...base,width:12};
  const changed=calculateStructureItems(project).find(i=>i.id==='structure:slabs');
  assert.equal(changed.unitPrice,'123.456');assert.equal(changed.quantity,'13.2');assert.equal(changed.amount,'1629.62');
});
test('相同输入完全确定，计算不修改源项目和配置，钢筋单位为吨',()=>{
  const project=active(),before=structuredClone(project);
  const first=calculateStructureItems(project),second=calculateStructureItems(project);
  assert.deepEqual(first,second);assert.deepEqual(project,before);
  const steel=first.find(i=>i.id==='structure:rebar');assert.equal(steel.unit,'t');assert.equal(steel.quantity,'5');
});
test('参考梁高低于板厚时不计虚构板下梁或梁模',()=>{
  const model=calculateStructureModel(empty(),{...base,width:1,depth:1});
  near(model.quantities.beams,0);near(model.quantities.beamFormwork,0);near(model.quantities.slabs,.11);
});
test('真实窗洞按结构净高裁剪，另建矩形方案不会混入原户型窗洞',()=>{
  const points=[{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}];
  const walls=points.map((start,i)=>({id:'wall'+i,start,end:points[(i+1)%4],thickness:20,height:280}));
  const room=detectPlanRooms(walls)[0];
  const project={...empty(),drawing:{type:'plan'},calibration:{metersPerPixel:.01},walls,regions:[planRegion(room.points,room.holes)]};
  const config={floors:1,gridX:1,gridY:1,floorHeight:2.4};
  const before=calculateStructureModel(project,config).quantities.masonry;
  project.openings=[{id:'window',wallId:'wall0',kind:'window',shape:'rectangle',offset:150,bottom:100,width:120,height:150,depth:6}];
  const after=calculateStructureModel(project,config).quantities.masonry;
  near(before-after,1.2*(2.4-.11-1)*.2);
  near(calculateStructureModel(project,base).quantities.masonry,calculateStructureModel(empty(),base).quantities.masonry);
});
