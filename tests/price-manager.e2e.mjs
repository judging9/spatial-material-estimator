import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';

const root=await mkdtemp(join(tmpdir(),'studio-price-browser-'));
const artifacts=resolve('artifacts/studio');await mkdir(artifacts,{recursive:true});
const server=spawn(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python',['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:root,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let errorOutput='';server.stderr.on('data',data=>errorOutput+=data);
const baseURL=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(errorOutput||'server timeout')),20000);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});server.on('exit',()=>{clearTimeout(timer);reject(new Error(errorOutput));});});
const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
let browser;let checks=0;
const passed=name=>{checks++;console.log('✓ '+name);};
try{
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(baseURL);await page.waitForFunction(()=>window.planStudio);
  await page.evaluate(async()=>{
    const {openPriceManager}=await import('/studio/price-manager.js');const {DEMO_MATERIALS,saveMaterials}=await import('/studio/lib/materials.js');
    window.priceTestMaterials=structuredClone(DEMO_MATERIALS);
    window.openPriceTest=()=>openPriceManager(window.priceTestMaterials,next=>{window.priceTestMaterials=saveMaterials(next);});
  });
  const show=()=>page.evaluate(()=>window.openPriceTest());
  const envelope=data=>JSON.stringify({ok:true,data});
  await page.route('**/api/scrape/nbs/preview',route=>route.fulfill({contentType:'application/json',body:envelope({url:'https://www.stats.gov.cn/sj/zxfb/source.html',title:'国家统计局发布期（测试上游数据）',price_date:'2026-11-01',rows:[{name:'螺纹钢',spec:'HRB400E',unit:'吨',price:3410,region:'全国',price_date:'2026-11-01',source:'国家统计局'},{name:'玻璃',unit:'重量箱',price:101,region:'全国'}]})}));
  await show();await page.locator('#price-official-update').click();await page.waitForSelector('#price-preview-list');
  assert.equal(await page.locator('[data-price-row]:enabled').count(),1);assert.equal(await page.locator('[data-price-row]:disabled').count(),1);
  assert.equal(await page.locator('[data-price-target="0"] option').count(),1,'元/吨 cannot be mapped to existing m² material');
  assert.ok((await page.locator('#dialog').innerText()).includes('重量箱'));
  await page.locator('#price-apply').click();
  let materials=await page.evaluate(()=>window.priceTestMaterials);
  assert.equal(materials.at(-1).unit,'吨');assert.equal(materials.at(-1).unitPrice,'3410');assert.equal(materials.at(-1).provenance.priceDate,'2026-11-01');
  assert.equal(materials.at(-1).provenance.sourceUrl,'https://www.stats.gov.cn/sj/zxfb/source.html');
  passed('官方读取预览保留发布日期和吨单位，未知单位不能导入且不会错覆盖地板价格');

  await show();await page.locator('#price-region').fill('浙江杭州');await page.locator('#price-source').fill('杭州市地方材料网');await page.locator('#price-date').fill('2026-10-31');
  await page.locator('#price-import-file').setInputFiles({name:'地方材料.csv',mimeType:'text/csv',buffer:Buffer.from('名称,单位,价格\n墙砖,m²,88.5\n','utf8')});
  await page.waitForSelector('#price-apply');assert.ok((await page.locator('#price-preview-list').innerText()).includes('浙江杭州'));assert.ok((await page.locator('#price-preview-list').innerText()).includes('2026-10-31'));
  await page.locator('#price-apply').click();materials=await page.evaluate(()=>window.priceTestMaterials);
  assert.equal(materials.at(-1).provenance.source,'杭州市地方材料网');assert.equal(materials.at(-1).provenance.region,'浙江杭州');
  passed('真实CSV经后端解析后补充来源、地区和日期，预览确认再保存');

  await show();await page.locator('#price-paste').fill('名称\t单位\t单价\t地区\t日期\t来源\n瓷砖\tm²\t79.25\t杭州\t2026-11-02\t供应商报价\n无效价\tm²\t-90\t杭州\t2026-11-02\t供应商');
  await page.locator('#price-paste-button').click();await page.waitForSelector('#price-apply');
  assert.ok((await page.locator('.price-errors').innerText()).includes('不能小于'));
  await page.locator('[data-price-target="0"]').selectOption('demo-tile');await page.locator('#price-apply').click();
  materials=await page.evaluate(()=>window.priceTestMaterials);assert.equal(materials.find(row=>row.id==='demo-tile').unitPrice,'79.25');assert.equal(materials.find(row=>row.id==='demo-wood').unitPrice,'120');
  passed('粘贴地方报价可明确选择目标材料更新，负价拒绝且其他材料保持原价');

  const table={index:0,rows:41,cols:3,sample:[['名称','单位','价格'],...Array.from({length:11},(_,i)=>['网站材料'+i,'m²','100'])]};
  await page.route('**/api/scrape/preview',route=>route.fulfill({contentType:'application/json',body:envelope({url:'https://example.com/prices',tables:[table]})}));
  await page.route('**/api/scrape/rows/preview',async route=>{
    const payload=route.request().postDataJSON();assert.equal(payload.mapping.unit,'1');assert.equal(payload.mapping.price,'2');
    await route.fulfill({contentType:'application/json',body:envelope({rows:Array.from({length:40},(_,i)=>({name:'网站材料'+i,unit:'m²',price:100+i,region:'杭州',source:'本地材料网',date_provided:false}))})});
  });
  await show();await page.locator('#price-source-url').fill('https://example.com/prices');await page.locator('#price-web-button').click();await page.waitForSelector('#price-web-preview');
  await page.locator('#price-web-preview').click();await page.waitForSelector('#price-preview-list');assert.equal(await page.locator('[data-price-row]').count(),40);
  assert.ok((await page.locator('#price-preview-list').innerText()).includes('日期未提供'));
  await page.locator('#price-preview-search').fill('材料39');assert.equal(await page.locator('[data-price-row]').count(),1);
  await page.screenshot({path:join(artifacts,'price-import-preview.png')});
  await page.locator('[data-dialog-close]').click();
  passed('网站表格经列映射读取全部40行，可搜索筛选，未知报价日期清楚标注');

  const before=await page.evaluate(()=>window.priceTestMaterials);
  await page.unroute('**/api/scrape/nbs/preview');
  await page.route('**/api/scrape/nbs/preview',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'官方网站连接失败'})}));
  await show();await page.locator('#price-official-update').click();await page.waitForFunction(()=>document.querySelector('#price-status').classList.contains('error'));
  assert.ok((await page.locator('#price-status').innerText()).includes('保持原值'));assert.deepEqual(await page.evaluate(()=>window.priceTestMaterials),before);
  await page.screenshot({path:join(artifacts,'price-import-error.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  passed('官方网络失败展示真实错误并保持材料原价；价格管理流程无运行时错误与页面溢出');
  await writeFile(join(artifacts,'price-validation.json'),JSON.stringify({checks,fixtures:'Deterministic upstream fixture responses for official and website routes; CSV route uses actual server parser.'},null,2));
  console.log(`${checks} 项价格浏览器验收通过`);
}finally{await browser?.close();server.kill();}
