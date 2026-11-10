import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';

// Real UI imports and saves; the public quote and actual geometry engine are
// checked alongside the displayed amounts. No DOM or project state is patched.
const artifacts=resolve('artifacts/municipal-price-boundaries');
await mkdir(artifacts,{recursive:true});
const storage=await mkdtemp(join(tmpdir(),'studio-price-boundaries-'));
const server=spawn(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python',['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:storage,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let browser,page,stderr='';
server.stderr.on('data',chunk=>stderr+=chunk);
const reports=[],runtimeErrors=[],results=[];
const pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const near=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const serializable=value=>JSON.parse(JSON.stringify(value));
const moneyValue=text=>text.replace(/[¥￥,\s]/g,'');

try{
  const url=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'server timeout')),20000);server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});});
  const executablePath=['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>runtimeErrors.push(error.message));
  await page.goto(url);await page.waitForFunction(()=>window.planStudio?.getProject);
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const project=()=>page.evaluate(()=>window.planStudio.getProject());
  const quote=()=>page.evaluate(()=>window.planStudio.getQuote());
  const engineering=()=>page.evaluate(async()=>{const {roadProfileAnalysis}=await import('/studio/lib/road-profile.js');const p=window.planStudio.getProject();return roadProfileAnalysis(p,p.municipalElements[0]);});
  const selectRoad=async id=>{await page.locator(`[data-action="select-municipal"][data-id="${id}"]`).click();await frame();};
  const openProfile=async()=>{await page.locator('.rp-inspector [data-action="road-profile"]').scrollIntoViewIfNeeded();await page.locator('.rp-inspector [data-action="road-profile"]').click();await page.waitForSelector('#road-profile-form');};
  const apply=async()=>{await page.locator('#road-profile-form [type="submit"]').click();await page.waitForSelector('#road-profile-form',{state:'hidden'});await frame();};
  const preview=async()=>moneyValue(await page.locator('[data-road-earthwork-total]').innerText());
  const inspectorTotal=async()=>moneyValue(await page.locator('[data-municipal-stat="total"]').innerText());
  const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');};
  const capture=async name=>{await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));await page.screenshot({path:join(artifacts,name)});};
  const imported=async model=>{await page.locator('#project-file').setInputFiles({name:model.name+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(model))});await page.waitForFunction(id=>window.planStudio.getProject().id===id,model.id);await frame();await selectRoad(model.municipalElements[0].id);};

  const fixture=JSON.parse(await readFile('artifacts/road-profile/road-profile-miter-project.json','utf8'));
  fixture.id='price-boundary-miter';fixture.name='道路转角报价验收';
  const boundary=structuredClone(fixture);boundary.id='price-boundary-half-unit';boundary.name='工程量舍入边界验收';
  const item=boundary.municipalElements[0],top=.1+(1+2.5e-9)/20;
  Object.assign(item,{points:[{x:500,y:500},{x:1500,y:500}],width:200,height:10,elevation:top*100,items:[],unit:'m²',unitPrice:'0',wasteRate:'0',laborRate:'0',additionalCost:'0',quantity:'1'});
  item.roadProfile={...item.roadProfile,enabled:true,points:[{id:'boundary-start',station:0,elevation:top},{id:'boundary-end',station:10,elevation:top}],crossSection:{leftSlope:0,rightSlope:0},sideSlopes:{...item.roadProfile.sideSlopes,enabled:false},earthwork:{enabled:true,cutUnitPrice:'0',fillUnitPrice:'10000000'}};
  boundary.taxRate='0';boundary.additionalCost='0';
  const scenarios=[{model:fixture,name:'miter',expected:'129.07',price:'2',volume:64.53343983436504},{model:boundary,name:'half-unit',expected:'10000000.03',price:'10000000',volume:1.0000000025}];

  for(const scenario of scenarios){
    await writeFile(join(artifacts,scenario.name+'-project.json'),JSON.stringify(scenario.model,null,2));
    await imported(scenario.model);
    const original=await project(),initial=await engineering();
    near(initial.earthworks.fillVolume,scenario.volume);
    assert.equal(initial.earthworks.complete,true);
    assert.equal((await quote()).total,scenario.expected);
    assert.equal(await inspectorTotal(),scenario.expected);
    if(scenario.name==='miter'){assert.ok(initial.earthworks.cutVolume<5e-10);assert.equal(initial.earthworks.cutCost,'0.00');}
    await openProfile();
    await page.locator('#road-fill-price').fill('0');assert.equal(await preview(),'0.00');
    await page.locator('#road-fill-price').fill(scenario.price);
    assert.equal(await page.locator('#road-profile-error').innerText(),'');
    assert.equal(await preview(),scenario.expected);
    await capture(scenario.name+'-preview.png');
    await apply();
    const applied=await project(),analysis=await engineering(),appliedQuote=await quote();
    assert.equal(analysis.earthworks.total,scenario.expected);
    assert.equal(appliedQuote.total,scenario.expected);
    assert.equal(appliedQuote.municipalElements[0].total,scenario.expected);
    assert.equal(await inspectorTotal(),scenario.expected);
    assert.deepEqual(applied.municipalElements[0].points,original.municipalElements[0].points);
    assert.deepEqual(applied.municipalElements[0].roadProfile.points,original.municipalElements[0].roadProfile.points);
    await capture(scenario.name+'-applied.png');
    pass(`${scenario.name==='miter'?'真实L形转角的微量挖方不阻断导入':'真实2×10m平路的1.0000000025m³用量按十进制9位舍入'}，用户编辑单价后道路预览、实际引擎、右侧本项及总报价一致为 ${scenario.expected} 元`);

    await save();const saved=await project();
    await page.reload();await page.waitForFunction(()=>window.planStudio?.getProject);
    await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();
    await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);await frame();
    await selectRoad(saved.municipalElements[0].id);
    const reopened=await project(),reopenedAnalysis=await engineering();
    assert.deepEqual(serializable(reopened.municipalElements[0].roadProfile),serializable(saved.municipalElements[0].roadProfile));
    assert.deepEqual(serializable(reopened.municipalTerrain),serializable(saved.municipalTerrain));
    near(reopenedAnalysis.earthworks.fillVolume,scenario.volume);
    assert.equal(reopenedAnalysis.earthworks.total,scenario.expected);
    assert.equal((await quote()).total,scenario.expected);assert.equal(await inspectorTotal(),scenario.expected);
    await openProfile();assert.equal(await preview(),scenario.expected);
    assert.equal(await page.locator('#road-fill-price').inputValue(),scenario.price);
    await capture(scenario.name+'-reopened.png');await page.locator('[data-dialog-close]').click();
    results.push({name:scenario.name,volume:reopenedAnalysis.earthworks.fillVolume,preview:scenario.expected,total:(await quote()).total,profile:serializable(reopened.municipalElements[0].roadProfile)});
    pass(`${scenario.name==='miter'?'L形转角':'半单位边界'}应用并保存后刷新重开，原图形、高程、地形和自填单价保留，真实预览和报价仍为 ${scenario.expected} 元`);
  }
  assert.deepEqual(runtimeErrors,[]);
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,runtimeErrors,environment:{node:process.version,nodeOptions:process.env.NODE_OPTIONS??'',browserVersion:browser.version()},results,finalQuote:await quote()},null,2));
  process.stdout.write(`\n${reports.length} 项市政价格边界浏览器验收通过。\n`);
}catch(error){
  await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});
  await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({error:String(error),reports,runtimeErrors,nodeOptions:process.env.NODE_OPTIONS??'',state:page?await page.evaluate(()=>({projectId:window.planStudio?.getProject()?.id,quote:window.planStudio?.getQuote(),dialog:document.querySelector('#dialog')?.innerText,toast:document.querySelector('#toast')?.textContent})).catch(()=>({})):null},null,2));
  throw error;
}finally{await browser?.close();server.kill();}
