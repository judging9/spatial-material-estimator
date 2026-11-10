import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';

// Actual project import, UI editing, persistence and printable quote. No DOM,
// geometry or internal project mutation is used to produce the result.
const artifacts=resolve(process.env.STUDIO_E2E_ARTIFACTS||'artifacts/road-earthwork-balance');await mkdir(artifacts,{recursive:true});
const storage=await mkdtemp(join(tmpdir(),'studio-road-balance-'));
const server=spawn(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python',['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:storage,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let browser,page,stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
const reports=[],runtimeErrors=[],evidence={};
const pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const near=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected}`);
const moneyValue=text=>text.replace(/[¥￥,\s]/g,'');
try{
  const url=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'server timeout')),20000);server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});});
  const executablePath=['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>runtimeErrors.push(error.message));await page.goto(url);await page.waitForFunction(()=>window.planStudio?.getProject);
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const project=()=>page.evaluate(()=>window.planStudio.getProject());
  const quote=()=>page.evaluate(()=>window.planStudio.getQuote());
  const analysis=()=>page.evaluate(async()=>{const {roadProfileAnalysis}=await import('/studio/lib/road-profile.js');const p=window.planStudio.getProject();return roadProfileAnalysis(p,p.municipalElements[0]);});
  const select=async id=>{await page.locator(`[data-action="select-municipal"][data-id="${id}"]`).click();await frame();};
  const open=async()=>{await page.locator('.rp-inspector [data-action="road-profile"]').scrollIntoViewIfNeeded();await page.locator('.rp-inspector [data-action="road-profile"]').click();await page.waitForSelector('#road-profile-form');if(!await page.locator('.rp-balance').evaluate(node=>node.open))await page.locator('.rp-balance summary').click();};
  const apply=async()=>{await page.locator('#road-profile-form [type="submit"]').click();await page.waitForSelector('#road-profile-form',{state:'hidden'});await frame();};
  const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');};
  const importModel=async model=>{await page.locator('#project-file').setInputFiles({name:model.name+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(model))});await page.waitForFunction(id=>window.planStudio.getProject().id===id,model.id);await frame();await select(model.municipalElements[0].id);};
  const field=key=>page.locator(`[data-road-balance-field="${key}"]`);
  const budget=key=>page.locator(`[data-road-balance-budget="${key}"]`);
  const preview=async()=>moneyValue(await page.locator('[data-road-balance-total]').innerText());
  const screenshot=async name=>{await page.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||getComputedStyle(toast).opacity==='0';});await frame();await page.screenshot({path:join(artifacts,name)});};
  const download=async(format,name)=>{await page.locator('#export').click();const event=page.waitForEvent('download');await page.locator(`[data-export="${format}"]`).click();const file=await event;await file.saveAs(join(artifacts,name));return readFile(await file.path(),'utf8');};

  const base=JSON.parse(await readFile('artifacts/road-profile/road-profile-miter-project.json','utf8'));
  base.id='road-earthwork-balance';base.name='道路土方平衡验收';base.taxRate='0';base.additionalCost='0';
  const road=base.municipalElements[0],roadId=road.id;base.municipalElements=[road];
  Object.assign(road,{points:[{x:500,y:500},{x:1500,y:500}],width:200,height:10,elevation:0,items:[],unitPrice:'0',wasteRate:'0',laborRate:'0',additionalCost:'0',quantity:'2',locked:false});
  road.roadProfile={enabled:true,points:[{id:'balance-start',station:0,elevation:-1},{id:'balance-end',station:10,elevation:1}],sampleInterval:1,crossSection:{leftSlope:0,rightSlope:0},earthwork:{enabled:false,cutUnitPrice:'',fillUnitPrice:''}};
  await importModel(base);assert.equal((await quote()).total,'0.00');
  await open();assert.equal(await field('usableCutPercent').inputValue(),'');assert.equal(await field('naturalPerCompactedFill').inputValue(),'');assert.equal(await field('loosePerNatural').inputValue(),'');
  await page.locator('#road-balance-enabled').check();assert.match(await page.locator('#road-balance-preview').innerText(),/待填写/);
  await field('usableCutPercent').fill('101');assert.match(await page.locator('#road-profile-error').innerText(),/不能大于 100/);await field('usableCutPercent').fill('70');
  await field('naturalPerCompactedFill').fill('1.1');await field('loosePerNatural').fill('1.25');
  const values={usableCutNatural:4.235,fillDemandNatural:4.455,reuseNatural:4.235,borrowNatural:.22,spoilNatural:1.815};
  for(const [key,expected]of Object.entries(values))near((await page.locator(`[data-road-balance-volume="${key}"]`).innerText()).replace(/m³|,/g,''),expected);
  await budget('borrowMaterial').check();await field('borrowMaterial.unitPrice').fill('10');
  for(const [key,km,rate]of [['reuseHaul','2','.5'],['borrowHaul','5','.8'],['spoilHaul','3','1.2']]){await budget(key).check();await field(key+'.distanceKm').fill(km);await field(key+'.unitPrice').fill(rate);}
  assert.equal(await preview(),'16.76');assert.equal(await page.locator('#road-profile-error').innerText(),'');
  evidence.layout={};
  for(const width of[1440,1100]){
    await page.setViewportSize({width,height:1000});await page.locator('.rp-balance-factors').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const bounds=await page.locator('.road-profile-dialog[open]').evaluate(dialog=>{const rect=node=>{const r=node.getBoundingClientRect();return{top:r.top,left:r.left,right:r.right,bottom:r.bottom};};return{dialog:rect(dialog),body:rect(dialog.querySelector('.dialog-body')),button:rect(dialog.querySelector('[type="submit"]')),overflow:dialog.scrollWidth>dialog.clientWidth};});
    assert.equal(bounds.overflow,false);assert.ok(bounds.button.bottom<=bounds.body.bottom+1);assert.ok(bounds.button.top>=bounds.body.top-1);evidence.layout[width]=bounds;
    await screenshot('balance-'+width+'.png');await field('spoilHaul.unitPrice').scrollIntoViewIfNeeded();await screenshot('balance-budgets-'+width+'.png');
    await page.locator('#road-balance-preview').hover();await page.mouse.wheel(0,260);await frame();
    const totalBounds=await page.locator('[data-road-balance-total]').boundingBox(),footer=await page.locator('.rp-submit').boundingBox();
    assert.ok(totalBounds.y+totalBounds.height<footer.y,'single-road subtotal must be readable above sticky Apply');
    await screenshot('balance-summary-'+width+'.png');
  }
  await page.setViewportSize({width:1440,height:1000});await apply();
  const applied=await project(),a=await analysis(),q=await quote();near(a.earthworks.cutVolume,6.05);near(a.earthworks.fillVolume,4.05);
  assert.equal(a.earthworks.enabled,false);assert.equal(a.earthworkBalance.knownCost,'16.76');assert.equal(q.total,'33.53');
  assert.deepEqual(q.municipalElements[0].items.filter(item=>item.category==='earthwork-balance').map(item=>[item.balanceKey,item.quantity,item.materialCost]),[['borrow-material','0.44','4.40'],['reuse-haul','21.175','10.59'],['borrow-haul','2.75','2.20'],['spoil-haul','13.6125','16.34']]);
  evidence.initial={cut:a.earthworks.cutVolume,fill:a.earthworks.fillVolume,balance:a.earthworkBalance,quoteTotal:q.total};
  pass('真实6.05天然挖方/4.05压实填方按自填系数形成0.22借方/1.815弃方；4项费用独立启用，单条预览16.76元，预算2份按各项用量计价33.53元，1440/1100无溢出');
  await page.keyboard.press('Control+z');await frame();assert.equal((await project()).municipalElements[0].roadProfile.earthworkBalance,undefined);assert.equal((await quote()).total,'0.00');
  await page.keyboard.press('Control+Shift+z');await frame();assert.equal((await quote()).total,'33.53');assert.deepEqual((await project()).municipalElements[0].roadProfile.earthworkBalance,applied.municipalElements[0].roadProfile.earthworkBalance);
  pass('一次撤销恢复未启用平衡和原零价，重做完整恢复用户参数、各费用开关和33.53元预算');

  await save();const saved=await project();const json=JSON.parse(await download('json','earthwork-balance-project.json'));assert.deepEqual(json.municipalElements[0].roadProfile.earthworkBalance,saved.municipalElements[0].roadProfile.earthworkBalance);
  const csv=await download('csv','earthwork-balance.csv');for(const pattern of [/土方平衡/,/天然方/,/松方/,/33.53/])assert.match(csv,pattern);
  await page.locator('#export').click();const popupEvent=page.waitForEvent('popup');await page.locator('[data-export="pdf"]').click();const popup=await popupEvent;await popup.waitForLoadState();const body=await popup.locator('body').innerText();for(const pattern of [/土方平衡/,/天然方/,/松方/,/33.53/])assert.match(body,pattern);
  const pdf=await popup.pdf({format:'A4',printBackground:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');await writeFile(join(artifacts,'earthwork-balance.pdf'),pdf);await popup.close();
  await page.reload();await page.waitForFunction(()=>window.planStudio?.getProject);await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);await select(roadId);
  assert.deepEqual((await project()).municipalElements[0].roadProfile.earthworkBalance,saved.municipalElements[0].roadProfile.earthworkBalance);assert.equal((await quote()).total,'33.53');await open();assert.equal(await preview(),'16.76');await page.locator('[data-dialog-close]').click();
  pass('真实CSV、打印PDF和完整JSON保留天然/松方依据及预算；本机保存刷新重开保留系数、运距、价格、费用开关及同一真实金额');

  await page.locator('#municipal-locked').check();await open();assert.equal(await page.locator('#road-profile-interval').isDisabled(),true);assert.equal(await field('borrowMaterial.unitPrice').isDisabled(),false);
  await field('borrowMaterial.unitPrice').fill('11');assert.equal(await preview(),'16.98');await apply();assert.equal((await quote()).total,'33.97');assert.deepEqual((await project()).municipalElements[0].roadProfile.points,saved.municipalElements[0].roadProfile.points);
  await page.keyboard.press('Control+z');await frame();assert.equal((await quote()).total,'33.53');await page.locator('#municipal-locked').uncheck();
  await open();await field('borrowHaul.distanceKm').fill('');assert.match(await page.locator('#road-balance-preview').innerText(),/运距待填写/);assert.equal(await preview(),'15.66');await apply();
  assert.equal((await quote()).total,null);assert.equal((await quote()).knownSubtotal,'31.33');assert.match((await quote()).pendingReason,/运距待填写/);
  await page.keyboard.press('Control+z');await frame();assert.equal((await quote()).total,'33.53');
  pass('锁定保护实测道路形状且允许改价；非零借方运距清空后完整总价待确认，独立已知费用保留31.33元，撤销恢复正式总价');

  const partial=structuredClone(saved);partial.id='road-earthwork-partial';partial.name='土方平衡缺测验收';for(const point of partial.municipalTerrain.points)if(point.x===50)point.x=10;
  await importModel(partial);const partialAnalysis=await analysis();assert.equal(partialAnalysis.earthworks.complete,false);assert.equal(partialAnalysis.earthworkBalance.volumes,null);assert.equal((await quote()).total,null);assert.match((await quote()).pendingReason,/部分挖填/);
  for(const item of partialAnalysis.earthworkBalance.items)assert.deepEqual(item.pendingReasons,partialAnalysis.earthworkBalance.pendingReasons);
  for(const item of (await quote()).municipalElements[0].items.filter(item=>item.category==='earthwork-balance'))assert.equal(item.pendingReasons.length,new Set(item.pendingReasons).size);
  evidence.partial=partialAnalysis.earthworkBalance;
  const disabled=structuredClone(saved);disabled.id='road-earthwork-disabled';disabled.name='土方平衡设计源关闭验收';disabled.municipalElements[0].roadProfile.enabled=false;
  await importModel(disabled);assert.equal((await analysis()).earthworkBalance.volumes,null);assert.equal((await quote()).total,null);assert.match((await quote()).pendingReason,/启用道路纵断面/);
  pass('实测范围不足与纵断面关闭均拒绝输出派生平衡量和完整报价，不用部分挖方抵销完整填方，不隐式忽略仍启用的预算');
  assert.deepEqual(runtimeErrors,[]);
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,runtimeErrors,environment:{node:process.version,browserVersion:browser.version()},evidence},null,2));
  process.stdout.write(`\n${reports.length} 项道路土方平衡浏览器验收通过。\n`);
}catch(error){await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({error:String(error),reports,runtimeErrors,state:page?await page.evaluate(()=>({projectId:window.planStudio?.getProject()?.id,quote:window.planStudio?.getQuote(),dialog:document.querySelector('.road-profile-dialog[open]')?.innerText,toast:document.querySelector('#toast')?.textContent})).catch(()=>({})):null},null,2));throw error;}
finally{await browser?.close();server.kill();}
