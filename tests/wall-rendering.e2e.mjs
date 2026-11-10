import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

// Standalone renderer validation: an explicit measured fixture, real WebGL,
// and an isolated read-only static server; does not touch saved user projects.
const studio=resolve(process.env.RENDERER_STUDIO_ROOT||'static/studio');
const server=createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>html,body{margin:0}#scene{width:100vw;height:100vh;position:relative}</style><div id="scene"></div>');return;}
    const file=resolve(studio,'.'+pathname);
    if(!file.startsWith(studio+'/')&&!file.startsWith(studio+'\\')){response.writeHead(403).end();return;}
    response.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'application/octet-stream');response.end(await readFile(file));
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseURL=`http://127.0.0.1:${server.address().port}`;
const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const artifacts=resolve('artifacts/studio');await mkdir(artifacts,{recursive:true});
let browser;
try{
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(baseURL);
  await page.evaluate(async()=>{
    const {Viewer3D}=await import('./viewer3d.js');
    const image='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ad9581"/><path d="M0 0H32V32H0Z M0 16H32 M16 0V32" stroke="#817361"/></svg>');
    const project={version:1,id:'renderer-fixture',name:'真实墙面验收',drawing:{id:'plan',type:'plan',width:800,height:600,url:''},calibration:{metersPerPixel:.01},walls:[{id:'wall',start:{x:100,y:200},end:{x:700,y:200},thickness:20,height:300,items:[{id:'finish',unit:'m²',materialId:'tile',color:'#bda98f',image,unitPrice:'100',wasteRate:'5',laborRate:'20',additionalCost:'0',quantityMode:'area',quantity:'0'}],finishSide:'both'}],regions:[],openings:[{id:'door',wallId:'wall',kind:'door',shape:'rectangle',offset:40,bottom:0,width:100,height:210,depth:4},{id:'round',wallId:'wall',kind:'hole',shape:'ellipse',offset:210,bottom:110,width:100,height:100,depth:20},{id:'window',wallId:'wall',kind:'window',shape:'rectangle',offset:410,bottom:100,width:100,height:100,depth:8},{id:'triangle',wallId:'wall',kind:'hole',shape:'polygon',offset:530,bottom:130,width:60,height:80,depth:20,points:[{x:0,y:0},{x:60,y:0},{x:30,y:80}]}],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}};
    const state={selected:null,errors:[]};
    const viewer=new Viewer3D(document.querySelector('#scene'),{selectWall:id=>state.selected=id?{type:'wall',id}:null,selectRegion:id=>state.selected=id?{type:'floor',id}:null,selectOpening:id=>state.selected=id?{type:'opening',id}:null,error:message=>state.errors.push(message)});
    viewer.setCutaway(false);viewer.setProject(project);viewer.setVisible(true);viewer.fit();
    window.rendererValidation={viewer,project,state};
  });
  await page.waitForFunction(()=>window.rendererValidation.viewer.getStats().ready&&window.rendererValidation.viewer.getStats().texturedWallSurfaceCount>0);
  const stats=await page.evaluate(()=>window.rendererValidation.viewer.getStats());
  assert.equal(stats.openingCount,4);assert.equal(stats.renderedInsertCount,2);assert.equal(stats.glError,0);
  await page.screenshot({path:join(artifacts,'next-wall-renderer.png')});
  const click=async point=>{
    const p=await page.evaluate(point=>window.rendererValidation.viewer.projectToScreen(point),point);
    assert.equal(p.visible,true);await page.mouse.click(p.x,p.y);return page.evaluate(()=>window.rendererValidation.state.selected);
  };
  assert.equal((await click({x:1.9,y:1.1,z:2})).id,'door');
  assert.equal((await click({x:5.6,y:1.5,z:2})).id,'window');
  assert.equal((await click({x:3.6,y:1.6,z:2})).id,'round','圆孔中心选择真实开口轮廓，不能选中虚构的实心墙');
  const triangleHit=await click({x:6.55,y:1.58,z:2});
  assert.ok(triangleHit===null||triangleHit.type==='opening'&&triangleHit.id==='triangle','三角形孔射线不得命中虚构的实心墙');
  assert.equal((await click({x:4.5,y:1.5,z:2})).type,'wall');
  const pixels=await page.evaluate(()=>{
    const {viewer}=window.rendererValidation,gl=viewer.canvas.getContext('webgl'),data=new Uint8Array(4),read=point=>{
      const screen=viewer.projectToScreen(point);gl.readPixels(Math.floor(screen.x),viewer.canvas.height-Math.floor(screen.y)-1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return [...data];
    };
    return {wall:read({x:4.5,y:1.5,z:2}),hole:read({x:3.6,y:1.6,z:2}),error:gl.getError()};
  });
  assert.notDeepEqual(pixels.wall,pixels.hole);assert.equal(pixels.error,0);
  await page.evaluate(()=>window.rendererValidation.viewer.setCutaway(true));
  await page.waitForTimeout(100);
  const cutaway=await page.evaluate(()=>window.rendererValidation.viewer.getStats());
  assert.ok(cutaway.wallHeights.every(wall=>wall.displayedHeight===.6&&wall.height===3));
  assert.equal(cutaway.glError,0);
  assert.equal((await click({x:3.6,y:1.6,z:2})).id,'round','低墙模式保留完整圆孔轮廓的真实拾取');
  await page.evaluate(()=>{
    const state=window.rendererValidation;
    state.project.openings=[];state.project.walls.push({...structuredClone(state.project.walls[0]),id:'overlap',start:{x:300,y:200},end:{x:800,y:200}});
    state.viewer.setProject(state.project);state.viewer.fit();
  });
  await page.mouse.move(550,400);await page.mouse.down();await page.mouse.move(720,450,{steps:15});await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.rendererValidation.viewer.getStats().glError),0);
  assert.deepEqual(await page.evaluate(()=>window.rendererValidation.state.errors),[]);assert.deepEqual(errors,[]);
  console.log('Real renderer: wall textures, rectangle/ellipse/polygon void pixels and picking, door/window thickness, cutaway and overlapping wall orbit passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
