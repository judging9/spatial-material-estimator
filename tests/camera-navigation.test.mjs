import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modules = process.env.CAMERA_NAVIGATION_BUILD ? pathToFileURL(resolve(process.env.CAMERA_NAVIGATION_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { automaticNavigationSpeed, cameraNavigationAxes, cameraNavigationCode, cameraNavigationTranslation, MAX_NAVIGATION_FRAME_SECONDS } = await import(new URL('lib/camera-navigation.js', modules));
const { Viewer3D } = await import(new URL('viewer3d.js', modules));
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const distance = vector => Math.hypot(vector.x, vector.y, vector.z);

test('physical movement keys work independently from keyboard labels with a legacy-event fallback', () => {
  assert.equal(cameraNavigationCode({ code: 'KeyW', key: 'z' }), 'KeyW');
  assert.equal(cameraNavigationCode({ code: 'Space', key: ' ' }), 'Space');
  assert.equal(cameraNavigationCode({ code: '', key: 'D' }), 'KeyD');
  assert.equal(cameraNavigationCode({ code: 'ControlRight', key: 'Control' }), 'ControlRight');
  assert.equal(cameraNavigationCode({ code: 'Enter', key: 'Enter' }), null);
});

test('opposed keys cancel and both Control keys still represent one downward axis', () => {
  assert.deepEqual(cameraNavigationAxes(['KeyW','KeyS','KeyA','KeyD','Space','ControlLeft']), { forward:0,right:0,up:0 });
  assert.deepEqual(cameraNavigationTranslation(0,['KeyW','KeyS'],2,.05),{x:0,y:0,z:0});
  assert.equal(cameraNavigationAxes(['ControlLeft','ControlRight']).up,-1);
});

for(const yaw of [0,Math.PI/2,-Math.PI/2,.731])test(`WASD directions use horizontal camera heading at yaw ${yaw}`,()=>{
  const forward=cameraNavigationTranslation(yaw,['KeyW'],10,.1),right=cameraNavigationTranslation(yaw,['KeyD'],10,.1);
  near(forward.x,-Math.sin(yaw));near(forward.z,-Math.cos(yaw));assert.equal(forward.y,0);
  near(right.x,Math.cos(yaw));near(right.z,-Math.sin(yaw));assert.equal(right.y,0);
  const back=cameraNavigationTranslation(yaw,['KeyS'],10,.1),left=cameraNavigationTranslation(yaw,['KeyA'],10,.1);
  near(back.x,-forward.x);near(back.z,-forward.z);near(left.x,-right.x);near(left.z,-right.z);
});

test('horizontal and spatial diagonals keep the configured metres-per-second speed',()=>{
  for(const keys of [['KeyW'],['KeyW','KeyD'],['KeyW','KeyD','Space'],['KeyW','KeyA','ControlLeft']])near(distance(cameraNavigationTranslation(.6,keys,8,.05)),.4);
  assert.deepEqual(cameraNavigationTranslation(.6,['Space'],8,.05),{x:0,y:.4,z:0});
  assert.deepEqual(cameraNavigationTranslation(.6,['ControlRight'],8,.05),{x:0,y:-.4,z:0});
});

test('24/60/144 fps give the same physical displacement and stalled frames have a bounded step',()=>{
  for(const fps of [24,60,144]){
    const moved={x:0,y:0,z:0};
    for(let frame=0;frame<fps;frame++){const delta=cameraNavigationTranslation(.73,['KeyW','KeyD'],8,1/fps);for(const axis of ['x','y','z'])moved[axis]+=delta[axis];}
    near(distance(moved),8);
  }
  near(distance(cameraNavigationTranslation(0,['KeyW'],20,30)),20*MAX_NAVIGATION_FRAME_SECONDS);
});

test('automatic speed follows real model dimensions and movement rejects invalid numeric parameters',()=>{
  assert.equal(automaticNavigationSpeed({x:0,y:0,z:0}),.5);
  assert.equal(automaticNavigationSpeed({x:12,y:0,z:16}),2.5);
  assert.equal(automaticNavigationSpeed({x:30000,y:2000,z:40000}),200);
  assert.equal(automaticNavigationSpeed({x:30000,y:2000,z:40000},4),.5);
  assert.equal(automaticNavigationSpeed({x:30000,y:2000,z:40000},80),10);
  assert.throws(()=>automaticNavigationSpeed({x:-1,y:0,z:0}),/尺寸/);
  for(const [yaw,speed,time] of [[NaN,1,.1],[0,0,.1],[0,1001,.1],[0,1,-1],[0,1,Infinity]])assert.throws(()=>cameraNavigationTranslation(yaw,['KeyW'],speed,time),/无效/);
});

/** Actual controller handlers with a minimal DOM/canvas adapter, preserving
 * the real keyboard gate and camera integration rather than mocking either. */
function controller(){
  const originalDocument=globalThis.document;
  const state={hidden:false,activeElement:null,modal:false,focused:true};
  globalThis.document={get hidden(){return state.hidden;},get activeElement(){return state.activeElement;},hasFocus:()=>state.focused,querySelector:()=>state.modal?{}:null};
  const viewer=new Viewer3DAdapter();
  state.activeElement=viewer.canvas;
  return{viewer,state,restore(){globalThis.document=originalDocument;}};
}
function Viewer3DAdapter(){
  const viewer=Object.create(Viewer3D.prototype);
  const fixtureProject={id:'project',regions:[{id:'floor',points:[{x:0,y:0},{x:3,y:0},{x:3,y:4}],items:[]}],walls:[],additionalCost:'17',taxRate:'9'};
  Object.assign(viewer,{canvas:{style:{},focus(){document.activeElement=this;},blur(){document.activeElement=null;}},visible:true,disposed:false,contextLost:false,sceneError:null,gl:{},openingDrag:null,
    project:fixtureProject,model:{bounds:{size:{x:12,y:0,z:16}}},camera:{target:{x:3,y:4,z:5},yaw:0,pitch:1,distance:12},navigationEnabled:true,navigationKeys:new Set(),navigationLastTime:null,navigationSpeed:2,navigation:null,
    renderRequests:0,requestRender(){this.renderRequests++;},hasGeometry(){return true;}});
  return viewer;
}

test('real controller time integration moves the view while keeping model, project and orbit dimensions unchanged',()=>{
  const h=controller();try{
    const before=structuredClone({project:h.viewer.project,model:h.viewer.model,camera:h.viewer.camera});
    h.viewer.navigationKeys.add('KeyW');h.viewer.navigationLastTime=1000;h.viewer.advanceNavigation(1050);
    assert.deepEqual(h.viewer.camera.target,{x:3,y:4,z:4.9});
    assert.equal(h.viewer.camera.distance,before.camera.distance);assert.equal(h.viewer.camera.pitch,before.camera.pitch);
    assert.deepEqual(h.viewer.project,before.project);assert.deepEqual(h.viewer.model,before.model);
    h.viewer.navigationKeys.add('Space');h.viewer.advanceNavigation(1100);near(h.viewer.camera.target.y,4+.1/Math.sqrt(2));
  }finally{h.restore();}
});

for(const block of ['input','dialog','hidden','window-blur','view-hidden','editing','disabled'])test(`real controller clears held keys and cannot move when blocked by ${block}`,()=>{
  const h=controller();try{
    const before=structuredClone(h.viewer.camera);h.viewer.navigationKeys.add('KeyW');h.viewer.navigationLastTime=1000;
    if(block==='input')h.state.activeElement={tagName:'INPUT'};
    if(block==='dialog')h.state.modal=true;
    if(block==='hidden')h.state.hidden=true;
    if(block==='window-blur')h.state.focused=false;
    if(block==='view-hidden')h.viewer.visible=false;
    if(block==='editing')h.viewer.openingDrag={id:'opening'};
    if(block==='disabled')h.viewer.navigationEnabled=false;
    h.viewer.advanceNavigation(1050);
    assert.deepEqual(h.viewer.camera,before);assert.equal(h.viewer.navigationKeys.size,0);assert.equal(h.viewer.navigationLastTime,null);
  }finally{h.restore();}
});

test('manual and automatic speed changes release previous keys and preserve scene data',()=>{
  const h=controller();try{
    const before=structuredClone(h.viewer.project);h.viewer.navigationKeys.add('KeyD');h.viewer.navigationLastTime=10;
    h.viewer.setNavigationSpeed(50);assert.equal(h.viewer.effectiveNavigationSpeed(),50);assert.equal(h.viewer.navigationKeys.size,0);
    h.viewer.setNavigationSpeed(null);assert.equal(h.viewer.effectiveNavigationSpeed(),1.5);assert.deepEqual(h.viewer.project,before);
    assert.throws(()=>h.viewer.setNavigationSpeed(-1),/速度/);assert.equal(h.viewer.navigationSpeed,null);
    h.viewer.navigationKeys.add('Space');h.viewer.setNavigationEnabled(false);assert.equal(h.viewer.navigationKeys.size,0);
  }finally{h.restore();}
});
