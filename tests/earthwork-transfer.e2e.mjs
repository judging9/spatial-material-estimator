import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';

// Real JSON file import and public UI edits. The measured roads and flat survey
// below are explicit test inputs; no application state or DOM is injected.
const artifacts=resolve('artifacts/earthwork-transfer');
await mkdir(artifacts,{recursive:true});
const storage=await mkdtemp(join(tmpdir(),'studio-earthwork-transfer-'));
const server=spawn(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python',['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:storage,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let browser,page,stderr='',outcome='failed',browserClosed=false,isolatedServerStopped=false;
server.stderr.on('data',chunk=>stderr+=chunk);
const reports=[],runtimeErrors=[],evidence={};
const pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const near=(actual,expected,tolerance=1e-7)=>assert.ok(Math.abs(Number(actual)-expected)<=tolerance,`${actual} != ${expected}`);
const parseCSV=source=>{const rows=[],row=[];let cell='',quoted=false;source=source.replace(/^\uFEFF/,'');for(let i=0;i<source.length;i++){const char=source[i];if(char==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&source[i+1]==='\n')i++;row.push(cell);cell='';rows.push([...row]);row.length=0;}else cell+=char;}if(cell||row.length){row.push(cell);rows.push(row);}return rows;};

function fixture(){
  const p={version:1,id:'earthwork-transfer-browser',name:'跨道路土方调配验收',workspaceMode:'municipal',drawing:{id:'transfer-plan',type:'plan',name:'30m场地测试画板',width:3000,height:3000,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000"></svg>')},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1},municipalTerrain:{name:'明确输入的0m测试平地',visible:true,points:[{id:'terrain-a',x:0,y:0,z:0},{id:'terrain-b',x:30,y:0,z:0},{id:'terrain-c',x:30,y:30,z:0},{id:'terrain-d',x:0,y:30,z:0}]}};
  const road=(id,name,y,top,loose,borrowPrice,borrowDistance,spoilPrice,spoilDistance)=>({id,kind:'road',name,points:[{x:500,y},{x:1500,y}],holes:[],width:200,depth:20,height:10,elevation:top*100,quantity:'1',unit:'m²',unitPrice:'0',wasteRate:'0',laborRate:'0',additionalCost:'0',items:[],roadProfile:{enabled:true,points:[{id:id+'-start',station:0,elevation:top},{id:id+'-end',station:10,elevation:top}],sampleInterval:1,curveTolerance:.002,crossSection:{leftSlope:0,rightSlope:0},earthwork:{enabled:false,cutUnitPrice:'',fillUnitPrice:''},earthworkBalance:{enabled:true,usableCutPercent:id==='transfer-source'?'60':'100',naturalPerCompactedFill:'1',loosePerNatural:loose,borrowMaterial:{enabled:true,unitPrice:borrowPrice},reuseHaul:{enabled:false,distanceKm:'',unitPrice:''},borrowHaul:{enabled:true,distanceKm:borrowDistance,unitPrice:borrowDistance===''?'':'1'},spoilHaul:{enabled:true,distanceKm:spoilDistance,unitPrice:spoilPrice}}}});
  p.municipalElements=[road('transfer-source','挖方道路',500,-.9,'1.25','','','2','3'),road('transfer-a','填方道路 A',1000,.5,'1.2','10','5','',''),road('transfer-b','填方道路 B',1500,.6,'1.1','12','4','','')];
  return p;
}

try{
  const url=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'test server timeout')),20000);server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});server.on('exit',code=>{clearTimeout(timer);reject(new Error('test server exited '+code));});});
  const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();
  page.on('pageerror',error=>runtimeErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(url);await page.waitForFunction(()=>window.planStudio?.getProject);
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const project=()=>page.evaluate(()=>window.planStudio.getProject());
  const quote=()=>page.evaluate(()=>window.planStudio.getQuote());
  const analysis=()=>page.evaluate(async()=>{const {analyzeProjectEarthworkTransfer}=await import('/studio/lib/earthwork-transfer-project.js');return analyzeProjectEarthworkTransfer(window.planStudio.getProject());});
  const roadAnalysis=()=>page.evaluate(async()=>{const {roadProfileAnalysis}=await import('/studio/lib/road-profile.js');const p=window.planStudio.getProject();return p.municipalElements.map(item=>({id:item.id,...roadProfileAnalysis(p,item)}));});
  const open=async()=>{await page.locator('#left-panel [data-action="earthwork-transfer"]').click();await page.locator('#earthwork-transfer-form').waitFor();await frame();};
  const apply=async()=>{await page.locator('#transfer-apply').click();await page.locator('#earthwork-transfer-form').waitFor({state:'hidden'});await frame();};
  const select=async id=>{await page.locator(`#left-panel [data-action="select-municipal"][data-id="${id}"]`).click();await frame();};
  const undo=async()=>{await page.locator('#undo').click();await frame();};
  const stat=async key=>(await page.locator(`[data-transfer-stat="${key}"]`).innerText()).replace(/[¥￥,\s]/g,'').replace(/m³.*$/,'');
  const screenshot=async name=>{await page.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||getComputedStyle(toast).opacity==='0';});await frame();await page.screenshot({path:join(artifacts,name)});};
  const importModel=async p=>{await page.locator('#project-file').setInputFiles({name:p.name+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await page.waitForFunction(id=>window.planStudio.getProject().id===id,p.id);await frame();};
  const download=async(format,name)=>{await page.locator('#export').click();const event=page.waitForEvent('download');await page.locator(`[data-export="${format}"]`).click();const file=await event;await file.saveAs(join(artifacts,name));return readFile(await file.path(),'utf8');};
  const addRoute=async(to,km)=>{
    await page.locator('#transfer-from').selectOption('transfer-source');await page.locator('#transfer-to').selectOption(to);await page.locator('#transfer-add-route').click();
    const row=page.locator('[data-transfer-route-row]').last(),id=await row.getAttribute('data-transfer-route-row');
    assert.equal(await page.locator(`[data-transfer-route-enabled="${id}"]`).isChecked(),false);
    assert.equal(await page.locator(`[data-transfer-route="${id}"][data-transfer-field="distanceKm"]`).inputValue(),'');
    assert.equal(await page.locator(`[data-transfer-route="${id}"][data-transfer-field="unitPrice"]`).inputValue(),'');
    await page.locator(`[data-transfer-route="${id}"][data-transfer-field="distanceKm"]`).fill(String(km));await page.locator(`[data-transfer-route="${id}"][data-transfer-field="unitPrice"]`).fill('1');await page.locator(`[data-transfer-route-enabled="${id}"]`).check();await frame();return id;
  };
  const base=fixture();await importModel(base);const initialGeometry=await roadAnalysis();
  assert.equal((await quote()).total,'442.00');assert.equal((await project()).municipalElements.length,3);
  for(const road of initialGeometry)near(road.earthworks.designArea,20);
  near(initialGeometry[0].earthworks.cutVolume,20);near(initialGeometry[1].earthworks.fillVolume,8);near(initialGeometry[2].earthworks.fillVolume,10);
  assert.equal(initialGeometry[0].earthworkBalance.volumes.usableCutNatural,'12');evidence.initial={geometry:initialGeometry,quote:await quote()};
  pass('真实文件导入3条独立10×2m道路和平地，挖方20m³中仅12m³可用，两个目标需要8/10m³，原外购及弃运预算442.00元');

  await open();assert.equal(await page.locator('#earthwork-transfer-enabled').isChecked(),false);
  assert.equal(await page.locator('[data-transfer-route-row]').count(),0);
  await page.locator('#earthwork-transfer-enabled').check();for(const id of ['transfer-source','transfer-a','transfer-b'])await page.locator(`[data-transfer-road="${id}"]`).check();
  await page.locator('#transfer-cancel').click();await frame();assert.equal((await project()).municipalEarthworkTransfer,undefined);assert.equal((await quote()).total,'442.00');
  pass('未启用的旧项目不自动调配；选择道路后取消草稿不写项目、不改变原报价，不猜运输路线或市场参数');

  await open();await page.locator('#earthwork-transfer-enabled').check();for(const id of ['transfer-source','transfer-a','transfer-b'])await page.locator(`[data-transfer-road="${id}"]`).check();
  const routeA=await addRoute('transfer-a',2),routeB=await addRoute('transfer-b',1);
  near(await stat('transferredNatural'),12);near(await stat('residualBorrowNatural'),6);near(await stat('residualSpoilNatural'),8);near(await stat('totalHaulCost'),17.5);
  assert.equal((await quote()).total,'442.00');evidence.layouts=[];
  for(const width of [1440,1100]){
    await page.setViewportSize({width,height:1000});
    const bounds=await page.locator('dialog.earthwork-transfer-dialog').evaluate(dialog=>{const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};};return{dialog:rect(dialog),footer:rect(dialog.querySelector('.dialog-footer')),buttons:[...dialog.querySelectorAll('.dialog-footer button')].map(button=>({id:button.id,...rect(button)})),overflow:dialog.scrollWidth>dialog.clientWidth};});
    assert.equal(bounds.overflow,false);for(const button of bounds.buttons){assert.ok(button.top>=bounds.footer.top);assert.ok(button.bottom<=bounds.footer.bottom);assert.ok(button.right<=bounds.dialog.right);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);evidence.layouts.push({width,...bounds});
    await screenshot('transfer-settings-'+width+'.png');await page.locator('#transfer-preview').scrollIntoViewIfNeeded();await screenshot('transfer-preview-'+width+'.png');
  }
  await apply();const planned=await analysis(),q=await quote();assert.equal(q.total,'173.50');
  near(planned.transferredNatural,12);near(planned.totalHaulCost,17.5);
  const outgoing=planned.routes.filter(row=>row.fromRoadId==='transfer-source');near(outgoing.find(row=>row.toRoadId==='transfer-a').naturalQuantity,2);near(outgoing.find(row=>row.toRoadId==='transfer-b').naturalQuantity,10);
  near(planned.roads.find(row=>row.id==='transfer-source').residualSpoilNatural,8);near(planned.roads.find(row=>row.id==='transfer-a').residualBorrowNatural,6);
  const balanceItems=id=>q.municipalElements.find(row=>row.id===id).items.filter(item=>item.category==='earthwork-balance');
  assert.equal(balanceItems('transfer-source').find(item=>item.balanceKey==='spoil-haul').netQuantity,'30');assert.equal(balanceItems('transfer-a').find(item=>item.balanceKey==='borrow-material').netQuantity,'6');assert.equal(balanceItems('transfer-a').find(item=>item.balanceKey==='borrow-haul').netQuantity,'36');
  const interRoad=q.municipalElements.flatMap(row=>row.items.filter(item=>item.category==='earthwork-transfer'));
  assert.equal(interRoad.length,2);near(interRoad.reduce((sum,row)=>sum+Number(row.materialCost),0),17.5);
  assert.deepEqual((await roadAnalysis()).map(row=>row.earthworks),initialGeometry.map(row=>row.earthworks));evidence.planned={analysis:planned,quote:q};
  pass('以最大12m³复用量优先，再择最低运输费，较近目标B10/A2m³；不可用8m³继续弃方，外购仅6m³，运输17.50元且全预算173.50元，无重复材料或弃运收费');

  const savedPlan=(await project()).municipalEarthworkTransfer;
  await undo();assert.equal((await quote()).total,'442.00');assert.equal((await project()).municipalEarthworkTransfer,undefined);
  await page.locator('#redo').click();await frame();assert.equal((await quote()).total,'173.50');assert.deepEqual((await project()).municipalEarthworkTransfer,savedPlan);
  await open();await page.locator(`[data-transfer-route="${routeB}"][data-transfer-field="unitPrice"]`).fill('3');await apply();
  assert.equal((await quote()).total,'193.40');const repriced=await analysis();near(repriced.routes.find(row=>row.toRoadId==='transfer-a').naturalQuantity,8);near(repriced.routes.find(row=>row.toRoadId==='transfer-b').naturalQuantity,4);near(repriced.totalHaulCost,35);
  await undo();assert.equal((await quote()).total,'173.50');
  await open();for(const id of [routeA,routeB])await page.locator(`[data-transfer-route-enabled="${id}"]`).uncheck();await apply();
  assert.equal((await quote()).total,'442.00');near((await analysis()).transferredNatural,0);await undo();assert.equal((await quote()).total,'173.50');
  pass('应用一次可撤销/重做完整方案；真实改价触发A8/B4m³重新分配，关闭确认路线则恢复原借方弃方预算，几何保持真实原状');

  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');const saved=await project();
  await page.reload();await page.waitForFunction(()=>window.planStudio?.getProject);await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);await frame();
  assert.deepEqual((await project()).municipalEarthworkTransfer,saved.municipalEarthworkTransfer);assert.deepEqual((await project()).municipalElements,saved.municipalElements);assert.equal((await quote()).total,'173.50');
  const csv=await download('csv','earthwork-transfer-quote.csv');for(const row of parseCSV(csv))assert.equal(row.length,25);assert.ok(csv.includes('173.50'));assert.ok(csv.includes('m³·km'));assert.match(csv,/跨道路|跨路|土方调配/);
  await page.locator('#export').click();const popupEvent=page.waitForEvent('popup');await page.locator('[data-export="pdf"]').click();const popup=await popupEvent;await popup.waitForLoadState();await popup.waitForSelector('.sheet');const body=await popup.locator('body').innerText();assert.ok(body.includes('173.50'));assert.match(body,/跨道路|跨路|土方调配/);
  const pdf=await popup.pdf({format:'A4',printBackground:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);await writeFile(join(artifacts,'earthwork-transfer-quote.pdf'),pdf);await popup.close();
  const json=await download('json','earthwork-transfer-project.json'),exported=JSON.parse(json);assert.deepEqual(exported.municipalEarthworkTransfer,saved.municipalEarthworkTransfer);assert.equal(exported.quoteSummary.total,'173.50');
  await page.locator('#project-file').setInputFiles(join(artifacts,'earthwork-transfer-project.json'));await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('完整项目已导入'));await frame();
  assert.equal((await quote()).total,'173.50');assert.deepEqual((await project()).municipalEarthworkTransfer,saved.municipalEarthworkTransfer);
  pass('本机保存刷新重开及实际JSON重新导入保留真实道路、系数和允许路线；25列CSV与实际PDF包含新运输项目、计量依据和173.50元正式总价');

  await open();await page.locator(`[data-transfer-route="${routeB}"][data-transfer-field="unitPrice"]`).fill('');assert.match(await page.locator('#transfer-preview').innerText(),/待|单价/);await screenshot('transfer-missing-price-1100.png');await apply();
  assert.equal((await quote()).total,null);assert.match((await quote()).pendingReason,/单价/);await undo();assert.equal((await quote()).total,'173.50');
  await select('transfer-a');await page.locator('.rp-inspector [data-action="road-profile"]').click();if(!await page.locator('.rp-balance').evaluate(node=>node.open))await page.locator('.rp-balance summary').click();
  await page.locator('[data-road-balance-field="naturalPerCompactedFill"]').fill('');await page.locator('#road-profile-form [type="submit"]').click();await page.locator('#road-profile-form').waitFor({state:'hidden'});await frame();
  assert.equal((await quote()).total,null);assert.equal((await analysis()).transferredNatural,null);await undo();assert.equal((await quote()).total,'173.50');
  await select('transfer-b');await page.locator('#inspector [data-action="delete-municipal"]').click();await frame();assert.equal((await project()).municipalElements.length,2);assert.equal((await quote()).total,null);assert.equal((await analysis()).transferredNatural,null);
  await open();assert.match(await page.locator('#transfer-road-list').innerText(),/已删除/);assert.equal(await page.locator('[data-transfer-road="transfer-b"]').isChecked(),true);
  // Removing a missing road removes its checkbox immediately. A real click
  // avoids uncheck() waiting to re-inspect a node that no longer exists.
  await page.locator('[data-transfer-road="transfer-b"]').click();assert.equal(await page.locator('[data-transfer-road="transfer-b"]').count(),0);await apply();
  assert.equal((await quote()).total,'110.00');assert.equal((await project()).municipalEarthworkTransfer.routes.some(route=>route.toRoadId==='transfer-b'),false);
  await undo();assert.equal((await quote()).total,null);await undo();assert.equal((await quote()).total,'173.50');
  pass('必要路线缺价、目标转换系数缺失或删除已选道路均保留待确认；明确移除缺失道路与关联路线后恢复110.00元有效方案，撤销准确恢复');

  await select('transfer-source');await page.locator('.rp-inspector [data-action="road-profile"]').click();
  assert.equal(await page.locator('[data-road-grade-field="elevation"]').count(),2);
  for(const input of await page.locator('[data-road-grade-field="elevation"]').all())await input.fill('-1.4');
  await page.locator('#road-profile-form [type="submit"]').click();await page.locator('#road-profile-form').waitFor({state:'hidden'});await frame();
  assert.equal((await quote()).total,'122.50');near((await analysis()).transferredNatural,18);near((await analysis()).roads.find(row=>row.id==='transfer-source').residualSpoilNatural,12);
  await undo();assert.equal((await quote()).total,'173.50');
  const multiplied=structuredClone(saved);multiplied.id='earthwork-transfer-multiplier';multiplied.name='跨路调配预算倍数验收';multiplied.municipalElements[0].quantity='2';
  await importModel(multiplied);assert.equal((await quote()).total,null);assert.match((await quote()).pendingReason,/份|数量|1/);assert.equal((await analysis()).transferredNatural,null);
  await importModel(saved);assert.equal((await quote()).total,'173.50');
  pass('真实导入既有预算份数2的道路项目时明确保持待确认，不将预算倍数作为实际土源；重导原项目恢复173.50元');
  await open();await page.locator('#transfer-preview').scrollIntoViewIfNeeded();await screenshot('transfer-reopened-preview-1100.png');await page.locator('#transfer-cancel').click();await frame();
  assert.deepEqual(runtimeErrors,[]);evidence.finalQuote=await quote();evidence.savedConfig=savedPlan;
  pass('道路实际高程修改后挖方30m³、可用18m³自动满足两目标并重算122.50元，撤销恢复；1440/1100主要状态及固定按钮无溢出或浏览器异常');
  // Include the final check in the report, after all assertions have succeeded.
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,runtimeErrors,environment:{node:process.version,nodeOptions:process.env.NODE_OPTIONS??'',browserVersion:browser.version()},evidence},null,2));
  outcome='passed';process.stdout.write(`\n${reports.length} 项跨道路土方调配浏览器验收通过。\n`);
}catch(error){await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({error:String(error),reports,runtimeErrors,state:page?await page.evaluate(()=>({project:window.planStudio?.getProject(),quote:window.planStudio?.getQuote(),dialog:document.querySelector('dialog[open]')?.innerText,toast:document.querySelector('#toast')?.textContent})).catch(()=>({})):null},null,2));throw error;}
finally{
  if(browser){await browser.close();browserClosed=true;}
  isolatedServerStopped=server.exitCode!==null||await new Promise(resolve=>{server.once('close',()=>resolve(true));server.kill();setTimeout(()=>resolve(server.exitCode!==null),3000);});
  await writeFile(join(artifacts,'run-receipt.json'),JSON.stringify({outcome,command:'node tests/earthwork-transfer.e2e.mjs',exitCode:outcome==='passed'?0:1,checks:reports.length,runtimeErrors,node:process.version,NODE_OPTIONS:process.env.NODE_OPTIONS??'',nodeOptions:process.env.NODE_OPTIONS??'',browserClosed,isolatedServerStopped,isolatedStorage:storage,completedAt:new Date().toISOString()},null,2));
}
