import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Exercise the actual served application and UI. The project is created by
// user-facing forms; API reads only collect evidence. Never build while open.
const artifacts=resolve(process.env.STUDIO_E2E_ARTIFACTS||'artifacts/municipal-expansion');
await mkdir(artifacts,{recursive:true});
const storage=await mkdtemp(join(tmpdir(),'studio-municipal-expansion-'));
const python=process.env.PYTHON||(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python');
const server=spawn(python,['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:storage,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let stderr='',browser,page,outcome='failed',browserClosed=false,serverStopped=false;
server.stderr.on('data',chunk=>stderr+=chunk);
const reports=[],runtimeErrors=[],evidence={};
const pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const near=(actual,expected,tolerance=1e-7)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected}`);
const parseCSV=source=>{const rows=[],row=[];let cell='',quoted=false;source=source.replace(/^\uFEFF/,'');for(let i=0;i<source.length;i++){const char=source[i];if(char==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&source[i+1]==='\n')i++;row.push(cell);cell='';rows.push([...row]);row.length=0;}else cell+=char;}if(cell||row.length){row.push(cell);rows.push(row);}return rows;};

try{
  const baseURL=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Isolated test server timeout')),20000);server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});server.on('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${stderr}`));});});
  const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();
  page.on('pageerror',error=>runtimeErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(baseURL);await page.waitForFunction(()=>window.planStudio?.getProject);
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const project=()=>page.evaluate(()=>window.planStudio.getProject()),quote=()=>page.evaluate(()=>window.planStudio.getQuote());
  const element=async id=>(await project()).municipalElements.find(item=>item.id===id),row=async id=>(await quote()).municipalElements.find(item=>item.id===id);
  const select=async id=>{await page.locator(`#left-panel [data-action="select-municipal"][data-id="${id}"]`).click();await frame();};
  const fill=async fields=>{for(const[key,value]of Object.entries(fields))await page.locator('#municipal-'+key).fill(String(value));await frame();};
  const option=(group,field)=>page.locator(`[data-municipal-option="${group}"][data-option-field="${field}"]`);
  const starter=async(preset,settings)=>{
    const before=new Set(((await project()).municipalElements??[]).map(item=>item.id));
    await page.locator('#left-panel [data-action="municipal-start"]').click();await page.locator('#municipal-starter-form').waitFor();
    await page.locator(`#municipal-starter-form [name="preset"][value="${preset}"]`).check();
    for(const[key,value]of Object.entries(settings)){const input=page.locator(`#municipal-starter-form [name="${key}"]`);if(key==='lanes')await input.selectOption(String(value));else await input.fill(String(value));}
    await page.locator('#municipal-starter-form [type="submit"]').click();await page.locator('#municipal-starter-form').waitFor({state:'hidden'});await frame();
    return(await project()).municipalElements.filter(item=>!before.has(item.id));
  };
  const screenshot=async name=>{await page.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||getComputedStyle(toast).opacity==='0';});await frame();await page.screenshot({path:join(artifacts,name)});};
  const download=async(format,name)=>{await page.locator('#export').click();const event=page.waitForEvent('download');await page.locator(`[data-export="${format}"]`).click();const file=await event;await file.saveAs(join(artifacts,name));return readFile(await file.path(),'utf8');};

  assert.equal((await project()).drawing,null);
  await page.locator('#enter-municipal').click();await page.waitForFunction(()=>window.planStudio.getWorkspaceMode()==='municipal');
  const blank=await project();assert.equal(blank.drawing.type,'plan');assert.equal(blank.calibration.metersPerPixel,.01);assert.equal(await page.locator('[data-draw-municipal]').count(),12);
  assert.equal(await page.locator('#left-panel [data-action="municipal-start"]').count(),1);
  pass('从空白工程直接进入04市政，自动建立真实米制画板，12种设施和场地预设入口可用');

  const cross=await starter('crossroads',{x:150,y:150,length:100,lanes:4});
  assert.equal(cross.length,9);assert.equal(cross.filter(item=>item.kind==='road').length,4);assert.equal(cross.filter(item=>item.kind==='trafficlight').length,4);
  const junction=cross.find(item=>item.kind==='intersection');assert.equal(junction.junction.arms,4);near((await row(junction.id)).area,855);near((await quote()).netArea,5775);assert.equal((await quote()).total,null);
  await page.locator('#undo').click();await frame();assert.equal(((await project()).municipalElements??[]).length,0);
  await page.locator('#redo').click();await frame();assert.deepEqual((await project()).municipalElements,cross);
  evidence.crossroads={elements:cross,quote:await quote()};
  pass('一键生成四车道十字路口、4条真实支路和4套信号灯，路口净855m²、总净5775m²；整套布置可一次撤销和重做，价格保持待填写');

  const firstRoad=cross.find(item=>item.kind==='road');await select(firstRoad.id);await fill({unitPrice:10,wasteRate:10,laborRate:2});
  near((await row(firstRoad.id)).area,1230);assert.equal((await row(firstRoad.id)).total,'15990.00');
  await option('roadLayout','lanes').selectOption('8');await frame();assert.equal((await element(firstRoad.id)).width,2900);near((await row(firstRoad.id)).area,2378);assert.equal((await row(firstRoad.id)).total,'30914.00');
  await fill({unitPrice:12});assert.equal((await row(firstRoad.id)).total,'36145.60');
  await page.locator('#undo').click();await frame();assert.equal((await row(firstRoad.id)).total,'30914.00');await page.locator('#undo').click();await frame();assert.equal((await element(firstRoad.id)).width,1500);assert.equal((await row(firstRoad.id)).total,'15990.00');
  pass('在道路属性中改为双向八车道，真实路宽29m、净面积2378m²，损耗和人工即时重算；再改单价及逐步撤销能恢复正确预算');

  const signal=cross.find(item=>item.kind==='trafficlight');await select(signal.id);
  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready&&window.planStudio.getViewMode()==='3d');await frame();
  // The ordinary focus button makes a real 19cm lens inspectable without
  // teaching the user orbit, pan and repeated wheel gestures.
  const beforeFocusProject=await project(),beforeFocusQuote=await quote(),beforeFocusDistance=await page.evaluate(()=>window.planStudio.get3DStats().camera.distance);
  await page.locator('#inspector [data-action="focus-municipal"]').click();await frame();
  const focusedDistance=await page.evaluate(()=>window.planStudio.get3DStats().camera.distance);assert.ok(focusedDistance<beforeFocusDistance);
  assert.deepEqual(await project(),beforeFocusProject);assert.deepEqual(await quote(),beforeFocusQuote);
  const beforeSignal=await page.locator('#viewer3d canvas').first().screenshot();
  await option('trafficSignal','phase').selectOption('green');await frame();assert.equal((await element(signal.id)).trafficSignal.phase,'green');
  const afterSignal=await page.locator('#viewer3d canvas').first().screenshot();assert.ok(!beforeSignal.equals(afterSignal),'真实三维画布应随灯色变化');
  const stats=await page.evaluate(()=>window.planStudio.get3DStats());assert.equal(stats.ready,true);assert.equal(stats.error,null);assert.equal(stats.glError,0);assert.equal(stats.renderedMunicipalElementCount,9);
  await writeFile(join(artifacts,'crossroads-signal-red.png'),beforeSignal);await writeFile(join(artifacts,'crossroads-signal-green.png'),afterSignal);await screenshot('crossroads-3d-1440.png');
  evidence.signal3D={stats,pngChanged:true,beforeFocusDistance,focusedDistance};pass('点击定位查看自动面向并放大信号灯头，仅改变相机；红转绿即时改变真实画布像素，9项场地模型和WebGL状态正常');
  await page.locator('[data-view="2d"]').click();await frame();

  const eight=await starter('eight-way',{x:400,y:150,length:100,lanes:4});assert.equal(eight.length,17);assert.equal(eight.filter(item=>item.kind==='road').length,8);assert.equal(eight.filter(item=>item.kind==='trafficlight').length,8);
  const eightJunction=eight.find(item=>item.kind==='intersection');assert.equal(eightJunction.junction.arms,8);assert.ok((await row(eightJunction.id)).area>0);
  const ring=await starter('roundabout',{x:650,y:150,length:100,lanes:4});assert.equal(ring.length,5);
  const roundabout=ring.find(item=>item.kind==='roundabout');const ringGeometry=await page.evaluate(async id=>{const {municipalFootprints}=await import('/studio/lib/municipal-design.js');const p=window.planStudio.getProject();return municipalFootprints(p.municipalElements.find(item=>item.id===id),p);},roundabout.id);
  assert.ok(ringGeometry.some(part=>part.holes.length>0));assert.ok((await row(roundabout.id)).area>0);assert.equal((await project()).municipalElements.length,31);
  evidence.eightWay=eight;evidence.roundabout={elements:ring,parts:ringGeometry};
  pass('八支路预设真实创建1路口、8支路及8信号灯；环岛预设创建可编辑环形路与4支路，真实中心岛孔洞从路面量中扣除，已有设计保持');

  const crossing=await starter('river-bridge',{x:800,y:500,length:100,lanes:4});assert.equal(crossing.length,4);
  const river=crossing.find(item=>item.kind==='river'),bridge=crossing.find(item=>item.kind==='bridge');
  assert.equal(crossing.filter(item=>item.kind==='road').length,2);near((await row(river.id)).area,2400);near((await row(river.id)).volume,4800);near((await row(bridge.id)).area,360);
  await select(bridge.id);assert.equal(await option('bridgeOptions','pierPricingEnabled').isChecked(),true);assert.equal(await option('bridgeOptions','railingPricingEnabled').isChecked(),true);
  await fill({unitPrice:10,wasteRate:10,laborRate:2});await option('bridgeOptions','pierUnitPrice').fill('1000');await option('bridgeOptions','railingUnitPrice').fill('20');await frame();
  const bridgeRow=await row(bridge.id);assert.equal(bridgeRow.items.find(item=>item.bridgePart==='piers').netQuantity,'2');assert.equal(bridgeRow.items.find(item=>item.bridgePart==='railings').netQuantity,'48');assert.equal(bridgeRow.total,'7640.00');
  evidence.crossing={elements:crossing,bridgeQuote:bridgeRow};
  pass('跨河预设一次生成河道、桥梁及两端道路；河道净2400m²/矩形槽4800m³，桥面360m²、2中间墩及48m栏杆按用户单价独立计费，小计7640元');

  await select(river.id);assert.equal((await project()).municipalTerrain,undefined);await page.locator('[data-action="carve-municipal-river"]').click();
  await page.locator('#river-carve-form [name="bankSlope"]').fill('1');await page.locator('#river-carve-form [type="submit"]').click();await page.locator('#river-carve-form').waitFor({state:'hidden'});await frame();
  const carved=await project();assert.ok(carved.municipalTerrain.raster);assert.ok(carved.municipalTerrain.raster.values.some(value=>value!==null&&value<0));
  const elevation=await page.evaluate(async()=>{const {terrainElevation}=await import('/studio/lib/terrain.js');return terrainElevation(window.planStudio.getProject().municipalTerrain,800,500);});near(elevation,-3);
  await page.locator('#undo').click();await frame();assert.equal((await project()).municipalTerrain,undefined);await page.locator('#redo').click();await frame();assert.deepEqual((await project()).municipalTerrain,carved.municipalTerrain);
  evidence.riverCarve={centerElevation:elevation,terrain:carved.municipalTerrain};
  pass('点击河流开槽自动建立并修改真实地形，高程在河中心达到-3m；操作可一次撤销及重做，水面和桥梁预算不被替换');

  await page.locator('#left-panel [data-action="municipal-check"]').click();const locate=page.locator('[data-locate-municipal]').first();assert.ok(await locate.count());const target=await locate.getAttribute('data-locate-municipal');await locate.click();await frame();assert.equal((await page.evaluate(()=>window.planStudio.getSelection())).municipalElementId,target);assert.equal(await page.locator('#municipal-name').inputValue(),(await element(target)).name);
  pass('工程检查集中列出真实待填价和计量说明，点击检查项直接定位对应设施与属性面板');

  // Confirm prices using the ordinary inspector for every actual item. No
  // internal state mutation, inferred market price or hidden demo pricing.
  for(const item of(await project()).municipalElements){await select(item.id);await fill({unitPrice:1,wasteRate:0,laborRate:0,additionalCost:0});if(item.kind==='bridge'){await option('bridgeOptions','pierUnitPrice').fill('10');await option('bridgeOptions','railingUnitPrice').fill('2');await frame();}}
  const complete=await quote();assert.equal(complete.pending,false);assert.notEqual(complete.total,null);assert.equal(complete.municipalElements.length,35);
  const independentlySummed=complete.municipalElements.flatMap(item=>item.items).reduce((sum,item)=>sum+Math.round(Number(item.netQuantity)*Number(item.unitPrice)*100)/100,0);near(complete.total,independentlySummed,1e-6);
  evidence.completeQuote=complete;pass('35项实际设施全部通过属性表填写明确价格后形成完整报价，各桥梁分项逐行金额与项目总价一致');

  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');const saved=await project();
  await page.reload();await page.waitForFunction(()=>window.planStudio?.getProject);await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);await frame();
  assert.deepEqual((await project()).municipalElements,saved.municipalElements);assert.deepEqual((await project()).municipalTerrain,saved.municipalTerrain);assert.equal((await quote()).total,complete.total);
  pass('保存、刷新和重新打开保留35项设施、车道/支路、信号灯色、桥梁分项价格及真实河槽地形，报价保持一致');

  const csv=await download('csv','municipal-expansion-quote.csv');for(const r of parseCSV(csv))assert.equal(r.length,25);for(const text of ['市政工程汇总','中间桥墩','两侧桥栏杆','中心岛半径','双向 4 车道',complete.total])assert.ok(csv.includes(text),text);
  await page.locator('#export').click();const popupEvent=page.waitForEvent('popup');await page.locator('[data-export="pdf"]').click();const popup=await popupEvent;await popup.waitForLoadState('domcontentloaded');await popup.waitForSelector('.sheet');const html=await popup.content();for(const text of ['中间桥墩','两侧桥栏杆','中心岛半径',complete.total])assert.ok(html.includes(text),text);
  const pdf=await popup.pdf({format:'A4',printBackground:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);await writeFile(join(artifacts,'municipal-expansion-quote.pdf'),pdf);await popup.close();
  const json=await download('json','municipal-expansion-project.json'),exported=JSON.parse(json);assert.deepEqual(exported.municipalElements,saved.municipalElements);assert.deepEqual(exported.municipalTerrain,saved.municipalTerrain);assert.equal(exported.quoteSummary.total,complete.total);
  await page.locator('#project-file').setInputFiles(join(artifacts,'municipal-expansion-project.json'));await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('完整项目已导入'));await frame();assert.equal((await quote()).total,complete.total);
  pass('实际下载25列CSV、有效PDF与完整JSON；新车道、环岛扣量、桥墩栏杆及最终报价保留，JSON再导入恢复真实设施和地形');

  await select(bridge.id);evidence.layouts=[];
  for(const width of[1440,1100]){
    await page.setViewportSize({width,height:1000});await page.locator('#fit').click();await frame();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const controls=[];for(const id of ['save','export','settings']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.y+box.height<=1000);controls.push({id,...box});}
    evidence.layouts.push({width,controls});await screenshot(`municipal-expansion-2d-${width}.png`);
    await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);await frame();const current=await page.evaluate(()=>window.planStudio.get3DStats());assert.equal(current.error,null);assert.equal(current.glError,0);assert.equal(current.renderedMunicipalElementCount,35);assert.ok(current.terrainTriangleCount>0);
    await screenshot(`municipal-expansion-3d-${width}.png`);await page.locator('[data-view="2d"]').click();await frame();
  }
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);await frame();
  const beforeBridgeFocusProject=await project(),beforeBridgeFocusQuote=await quote(),beforeBridgeFocusDistance=await page.evaluate(()=>window.planStudio.get3DStats().camera.distance);
  await page.locator('#inspector [data-action="focus-municipal"]').click();await frame();const bridgeFocusedDistance=await page.evaluate(()=>window.planStudio.get3DStats().camera.distance);assert.ok(bridgeFocusedDistance<beforeBridgeFocusDistance);
  assert.deepEqual(await project(),beforeBridgeFocusProject);assert.deepEqual(await quote(),beforeBridgeFocusQuote);
  await screenshot('municipal-expansion-bridge-focus-1440.png');await page.setViewportSize({width:1100,height:1000});await frame();await page.locator('#inspector [data-action="focus-municipal"]').click();await frame();assert.deepEqual(await project(),beforeBridgeFocusProject);assert.deepEqual(await quote(),beforeBridgeFocusQuote);await screenshot('municipal-expansion-bridge-focus-1100.png');
  evidence.bridgeFocus={beforeBridgeFocusDistance,bridgeFocusedDistance};
  assert.deepEqual(runtimeErrors,[]);pass('1440/1100两种窗口下二维三维无横向溢出，顶部保存导出设置均可见，35项模型与真实河槽正常渲染，无运行时或WebGL错误');
  outcome='passed';await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({outcome,checks:reports.length,reports,runtimeErrors,evidence,finalProject:await project(),finalQuote:await quote()},null,2));
  process.stdout.write(`\n${reports.length} 项市政扩展浏览器验收通过。\n`);
}catch(error){
  await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});
  await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({outcome,error:String(error),reports,runtimeErrors,evidence,state:await page?.evaluate(()=>({project:window.planStudio?.getProject(),quote:window.planStudio?.getQuote(),selection:window.planStudio?.getSelection(),toast:document.querySelector('#toast')?.textContent})).catch(()=>({}))},null,2));throw error;
}finally{
  await browser?.close();browserClosed=true;
  if(server.exitCode===null){server.kill();await new Promise(done=>{const timer=setTimeout(done,5000);server.once('exit',()=>{clearTimeout(timer);done();});});}
  serverStopped=server.exitCode!==null||server.signalCode!==null;
  await writeFile(join(artifacts,'run-receipt.json'),JSON.stringify({outcome,browserClosed,isolatedServerStopped:serverStopped,isolatedStorage:storage,checks:reports.length,runtimeErrors},null,2));
}
