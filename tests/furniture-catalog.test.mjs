import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FURNITURE_TEMPLATES, FURNITURE_CATEGORIES, searchFurnitureTemplates } from '../build/studio/lib/furniture-catalog.js';
import { validateFurniture, furnitureFootprint } from '../build/studio/lib/furniture.js';
import { buildFurniture3D, validateFurnitureAssets } from '../build/studio/lib/furniture3d.js';
import { calculateProject } from '../build/studio/lib/pricing.js';
import { isStairKind } from '../build/studio/lib/stairs.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const item=(template,extra={})=>({...template,id:template.kind,position:{x:500,y:500},mountHeight:0,rotation:0,quantity:'1',unitPrice:'',additionalCost:'0',...extra});
const project=furniture=>({version:1,id:'catalog-project',name:'Catalogue',drawing:{id:'p',type:'plan',width:2400,height:1800},calibration:{metersPerPixel:.01},regions:[],furniture,additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const bounds=model=>Object.fromEntries(['x','y','z'].map(axis=>{const values=model.surfaces.flatMap(face=>face.points.map(point=>point[axis]));return[axis,[Math.min(...values),Math.max(...values)]];}));

test('93 unique editable product presets cover appliances, nine stairs and 35 installation fixtures without vendor or demo prices',()=>{
  assert.equal(FURNITURE_TEMPLATES.length,93);
  assert.equal(new Set(FURNITURE_TEMPLATES.map(template=>template.kind)).size,93);
  assert.equal(FURNITURE_TEMPLATES.filter(template=>isStairKind(template.kind)).length,9);
  for(const kind of ['tv','computer','kitchenBase','kitchenWall','dishwasher','cooktop','washingMachine','stairs'])assert.ok(FURNITURE_TEMPLATES.some(template=>template.kind===kind));
  assert.equal(FURNITURE_CATEGORIES.length,12);
  for(const template of FURNITURE_TEMPLATES){assert.equal(template.unitPrice,undefined);validateFurniture([item(template)]);}
});

test('catalogue search understands product names, aliases and categories deterministically',()=>{
  assert.deepEqual(searchFurnitureTemplates('PC').map(template=>template.kind),['computer']);
  assert.deepEqual(searchFurnitureTemplates('ledStripController').map(template=>template.kind),['ledStripController']);
  assert.deepEqual(searchFurnitureTemplates('马桶').map(template=>template.kind),['toilet']);
  assert.deepEqual(searchFurnitureTemplates('洗碗机','kitchen').map(template=>template.kind),['dishwasher']);
  assert.deepEqual(searchFurnitureTemplates('洗碗机','office'),[]);
  assert.ok(searchFurnitureTemplates('橱柜','kitchen').length>=2);
  assert.deepEqual(searchFurnitureTemplates('<script>'),[]);
});

test('every preset uses its exact requested width depth height and relative mount elevation',()=>{
  for(const template of FURNITURE_TEMPLATES){
    const source=project([item(template,{mountHeight:120,...(isStairKind(template.kind)?{stair:{railing:'none',railingHeight:90}}:{})})]),before=structuredClone(source),model=buildFurniture3D(source)[0],b=bounds(model);
    assert.deepEqual(source,before);
    near(b.x[0],5-template.width/200);near(b.x[1],5+template.width/200);
    near(b.z[0],5-template.depth/200);near(b.z[1],5+template.depth/200);
    near(b.y[0],1.2);near(b.y[1],1.2+template.height/100);
    assert.ok(model.surfaces.length>=6);
    for(const face of model.surfaces){near(Math.hypot(face.normal.x,face.normal.y,face.normal.z),1);const first=face.points[0];for(const point of face.points)near((point.x-first.x)*face.normal.x+(point.y-first.y)*face.normal.y+(point.z-first.z)*face.normal.z,0);}
  }
});

test('new appliance silhouettes contain real screens burners drums or plumbing details',()=>{
  const models=new Map(buildFurniture3D(project(FURNITURE_TEMPLATES.map(template=>item(template)))).map(model=>[model.kind,model]));
  for(const kind of ['tv','computer','washingMachine','cooktop','sink','toilet','stairs'])assert.ok(models.get(kind).surfaces.length>6,`${kind} must be more than a featureless box`);
  for(const kind of ['washingMachine','cooktop','sink','toilet'])assert.ok(models.get(kind).surfaces.some(surface=>surface.points.length===32),`${kind} must have a true round detail`);
  assert.notDeepEqual(models.get('dishwasher').surfaces,models.get('refrigerator').surfaces);
});

test('straight staircase has physical ordered treads at heights derived from user rise',()=>{
  const template=FURNITURE_TEMPLATES.find(template=>template.kind==='stairs');
  for(const height of [280,350,170]){
    const model=buildFurniture3D(project([item(template,{height})]))[0],tops=model.surfaces.filter(surface=>surface.side==='top');
    assert.equal(tops.length,Math.ceil(height/18));
    const ordered=tops.slice().sort((a,b)=>a.points[0].z-b.points[0].z);
    for(let i=0;i<ordered.length;i++)near(ordered[i].points[0].y,(i+1)*height/100/ordered.length);
    near(Math.max(...tops.flatMap(surface=>surface.points.map(point=>point.y))),height/100);
  }
});

test('free fractional rotation and mount elevation change geometry without changing the furniture budget',()=>{
  const values=['dishwasher','computer','stairs'].map((kind,index)=>item(FURNITURE_TEMPLATES.find(template=>template.kind===kind),{unitPrice:String(100+index),quantity:'3',additionalCost:'10'}));
  const source=project(values),quote=calculateProject(source),before=structuredClone(source);
  values.forEach(value=>{value.rotation=37.25;value.mountHeight=85;});
  assert.equal(calculateProject(source).total,quote.total);
  for(const model of buildFurniture3D(source)){
    const value=values.find(item=>item.id===model.id),footprint=furnitureFootprint(value,source),b=bounds(model);
    for(const point of model.surfaces.flatMap(surface=>surface.points))assert.ok(point.x>=Math.min(...footprint.map(p=>p.x))*.01-1e-8&&point.x<=Math.max(...footprint.map(p=>p.x))*.01+1e-8);
    near(b.y[0],.85);
  }
  assert.equal(quote.total,'939.00');assert.equal(before.furniture.length,3);
});

test('all new previews are local original SVG polygons and old Blender assets keep their eight models',async()=>{
  const original=validateFurnitureAssets(JSON.parse(await readFile(new URL('../static/studio/assets/furniture-original.json',import.meta.url))));
  assert.equal(Object.keys(original.models).length,8);
  const manifest=JSON.parse(await readFile(new URL('../static/studio/assets/furniture-catalog-manifest.json',import.meta.url)));
  assert.equal(manifest.models.length,85);assert.equal(manifest.license,'CC0-1.0');
  for(const entry of manifest.models){const svg=await readFile(new URL('../static/studio/assets/'+entry.preview,import.meta.url),'utf8');assert.match(svg,/<svg/);assert.match(svg,/<polygon/);assert.doesNotMatch(svg,/<(?:script|image)|href=|https?:\/\/(?!www\.w3\.org)/);}
});

test('invalid mounting height cannot reach geometry or pricing',()=>{
  const template=FURNITURE_TEMPLATES[0];
  for(const mountHeight of[-1,2001,NaN,Infinity,'20'])assert.throws(()=>buildFurniture3D(project([item(template,{mountHeight})])));
});
