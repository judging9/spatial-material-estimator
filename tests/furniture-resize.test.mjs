import test from 'node:test';
import assert from 'node:assert/strict';
import { furnitureResizeHandles, furnitureResizeFromPointer } from '../build/studio/lib/furniture-resize.js';
import { validateFurniture } from '../build/studio/lib/furniture.js';
import { calculateProject } from '../build/studio/lib/pricing.js';
import { importProjectJSON, createHistory } from '../build/studio/lib/persistence.js';
import { addLevel, ensureLevels, switchLevel, updateLevel } from '../build/studio/lib/levels.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const item=(extra={})=>({id:'object',kind:'custom',name:'物件',position:{x:600,y:500},width:120,depth:80,height:100,rotation:0,quantity:'2',unitPrice:'150.15',additionalCost:'20.05',...extra});
const project=(extra={})=>({version:1,id:'resize',name:'尺寸',drawing:{id:'plan',type:'plan',width:2400,height:1800},calibration:{metersPerPixel:.01},regions:[],furniture:[item()],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1},...extra});
const get=(value,p,key)=>furnitureResizeHandles(value,p).find(handle=>handle.key===key).point;
const rotatedDelta=(degrees,x,y)=>{const r=degrees*Math.PI/180;return{x:x*Math.cos(r)-y*Math.sin(r),y:x*Math.sin(r)+y*Math.cos(r)};};
const opposite={nw:'se',n:'s',ne:'sw',e:'w',se:'nw',s:'n',sw:'ne',w:'e'};

test('eight real boundary handles use exact width, depth and rotated centimetre coordinates',()=>{
  const value=item(),p=project(),handles=furnitureResizeHandles(value,p);
  assert.equal(handles.length,8);assert.equal(new Set(handles.map(handle=>handle.key)).size,8);
  assert.deepEqual(get(value,p,'nw'),{x:540,y:460});assert.deepEqual(get(value,p,'e'),{x:660,y:500});
  assert.equal(handles.find(handle=>handle.key==='e').cursor,'ew-resize');assert.equal(handles.find(handle=>handle.key==='n').cursor,'ns-resize');
  const rotated=item({rotation:90});near(get(rotated,p,'e').x,600);near(get(rotated,p,'e').y,560);
});

test('dragging every edge and corner keeps its exact opposite anchor fixed at arbitrary rotation',()=>{
  for(const rotation of[0,37.27,90,180,-24.63])for(const key of Object.keys(opposite)){
    const value=item({rotation}),p=project(),start=get(value,p,key),delta=rotatedDelta(rotation,key.includes('w')?-40:key.includes('e')?40:0,key.includes('n')?-30:key.includes('s')?30:0);
    const before=structuredClone(value),patch=furnitureResizeFromPointer(value,key,start,{x:start.x+delta.x,y:start.y+delta.y},p),after={...value,...patch};
    const anchor=get(value,p,opposite[key]),nextAnchor=get(after,p,opposite[key]);near(anchor.x,nextAnchor.x);near(anchor.y,nextAnchor.y);assert.deepEqual(value,before);
    near(patch.width,key.includes('w')||key.includes('e')?160:120);near(patch.depth,key.includes('n')||key.includes('s')?110:80);
  }
});

test('pointer offset inside the hit halo does not jump geometry or change the opposite edge',()=>{
  const value=item({rotation:37.27}),p=project(),handle=get(value,p,'e'),start={x:handle.x+3,y:handle.y-2};
  assert.deepEqual(furnitureResizeFromPointer(value,'e',start,start,p),{position:{...value.position},width:120,depth:80});
  const delta=rotatedDelta(value.rotation,25,0),patch=furnitureResizeFromPointer(value,'e',start,{x:start.x+delta.x,y:start.y+delta.y},p);near(patch.width,145);near(patch.depth,80);
});

test('shrinking across the opposite corner stops at one centimetre without flipping or moving the anchor',()=>{
  const value=item(),p=project(),start=get(value,p,'se'),anchor=get(value,p,'nw');
  const patch=furnitureResizeFromPointer(value,'se',start,{x:start.x-300,y:start.y-200},p),result={...value,...patch};
  assert.equal(patch.width,1);assert.equal(patch.depth,1);assert.deepEqual(get(result,p,'nw'),anchor);
});

test('oversized drags stop at allowed dimensions with the opposite edge fixed',()=>{
  const value=item({rotation:37.27}),p=project(),start=get(value,p,'e'),delta=rotatedDelta(value.rotation,5000,0),patch=furnitureResizeFromPointer(value,'e',start,{x:start.x+delta.x,y:start.y+delta.y},p);
  assert.equal(patch.width,2000);near(patch.depth,80);near(get({...value,...patch},p,'w').x,get(value,p,'w').x);near(get({...value,...patch},p,'w').y,get(value,p,'w').y);
});

test('Shift resizing preserves initial aspect ratio and corner anchor using actual coordinates',()=>{
  const value=item({rotation:37.27}),p=project(),start=get(value,p,'se'),delta=rotatedDelta(value.rotation,60,5),patch=furnitureResizeFromPointer(value,'se',start,{x:start.x+delta.x,y:start.y+delta.y},p,{preserveRatio:true});
  near(patch.width,180);near(patch.depth,120);near(get({...value,...patch},p,'nw').x,get(value,p,'nw').x);near(get({...value,...patch},p,'nw').y,get(value,p,'nw').y);
});

test('circular civil columns keep one diameter on all eight handles and support their own size range',()=>{
  for(const key of Object.keys(opposite)){
    const value=item({width:40,depth:40,rotation:24}),p=project(),start=get(value,p,key),delta=rotatedDelta(value.rotation,key.includes('w')?-80:key.includes('e')?80:0,key.includes('n')?-60:key.includes('s')?60:0);
    const patch=furnitureResizeFromPointer(value,key,start,{x:start.x+delta.x,y:start.y+delta.y},p,{circle:true,max:100000});assert.equal(patch.width,patch.depth);assert.ok(patch.width>40);
  }
});

test('calibrated image resizing uses real centimetres instead of pixels, with no dependency on canvas zoom',()=>{
  const value=item(),p=project({drawing:{id:'image',type:'image',width:2400,height:1800},calibration:{metersPerPixel:.025}}),start=get(value,p,'e');
  near(start.x,624);const patch=furnitureResizeFromPointer(value,'e',start,{x:start.x+20,y:start.y},p);near(patch.width,170);near(patch.depth,80);
  near(get({...value,...patch},p,'w').x,get(value,p,'w').x);
  const uncalibrated={...p,calibration:{metersPerPixel:null}};assert.deepEqual(furnitureResizeHandles(value,uncalibrated),[]);assert.throws(()=>furnitureResizeFromPointer(value,'e',start,start,uncalibrated),/校准/);
});

test('locked geometry exposes no resize handles and never responds to pointer transforms',()=>{
  const value=item({locked:true}),p=project();assert.deepEqual(furnitureResizeHandles(value,p),[]);
  const patch=furnitureResizeFromPointer(value,'se',{x:0,y:0},{x:1000,y:1000},p);assert.deepEqual(patch,{position:value.position,width:120,depth:80});assert.notEqual(patch.position,value.position);
  validateFurniture([value]);for(const locked of['true',0,null])assert.throws(()=>validateFurniture([item({locked})]),/锁定/);
});

test('resize preview cancellation and one committed history step restore geometry while preserving exact quantity pricing',()=>{
  const p=project(),history=createHistory(p),value=p.furniture[0],start=get(value,p,'se'),patch=furnitureResizeFromPointer(value,'se',start,{x:start.x+40,y:start.y+20},p),quote=calculateProject(p).total;
  const preview=structuredClone(p);Object.assign(preview.furniture[0],patch);assert.equal(calculateProject(preview).total,quote);assert.equal(history.length,1);
  history.push(preview);assert.equal(history.length,2);assert.deepEqual(history.undo(),p);assert.deepEqual(history.redo(),preview);assert.equal(quote,'320.35');
});

test('project import preserves optional boolean locks and rejects fabricated lock values',async()=>{
  const p=project();p.furniture[0].locked=true;
  const loaded=await importProjectJSON(JSON.stringify(p));assert.equal(loaded.furniture[0].locked,true);assert.equal(calculateProject(loaded).total,'320.35');
  p.furniture[0].locked='true';await assert.rejects(importProjectJSON(JSON.stringify(p)),/锁定/);
});

test('invalid pointer coordinates, size ranges and unknown handles fail before producing geometry',()=>{
  const value=item(),p=project(),start=get(value,p,'e');
  for(const [key,end,options]of[['unknown',start,{}],['e',{x:NaN,y:1},{}],['e',start,{min:0}],['e',start,{min:20,max:10}]])assert.throws(()=>furnitureResizeFromPointer(value,key,start,end,p,options),RangeError);
});

test('level height edits cannot change a locked bound stair in either active or inactive content, and unlock restores exact syncing',()=>{
  const lower=ensureLevels(project({furniture:[item({kind:'stairsSpiralRight',height:300,locked:true})]})),lowerId=lower.activeLevelId;
  const upper=addLevel(lower,{name:'二楼',height:300}),upperId=upper.activeLevelId;
  upper.levels.find(level=>level.id===lowerId).content.furniture[0].stairTargetLevelId=upperId;
  const activeLower=switchLevel(upper,lowerId),before=structuredClone(activeLower),inactiveBefore=structuredClone(upper);
  assert.throws(()=>updateLevel(activeLower,lowerId,{height:325}),/已锁定/);assert.deepEqual(activeLower,before);
  assert.throws(()=>updateLevel(upper,lowerId,{height:325}),/已锁定/);assert.deepEqual(upper,inactiveBefore);
  const renamed=updateLevel(activeLower,lowerId,{name:'一楼改名'});assert.equal(renamed.levels[0].name,'一楼改名');near(renamed.furniture[0].height,300);assert.equal(renamed.furniture[0].locked,true);
  const unlocked=structuredClone(activeLower);unlocked.furniture[0].locked=false;const unlockedBefore=structuredClone(unlocked),updated=updateLevel(unlocked,lowerId,{height:325});
  assert.deepEqual(unlocked,unlockedBefore);near(updated.furniture[0].height,325);near(updated.levels.find(level=>level.id===upperId).elevation,325);assert.equal(updated.furniture[0].stairTargetLevelId,upperId);assert.equal(updated.furniture[0].unitPrice,'150.15');
});
