import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const testRoot = await mkdtemp(join(tmpdir(), 'plan-studio-e2e-'));
const artifacts = resolve('artifacts/studio');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverErrors = '';
server.stderr.on('data', chunk => serverErrors += chunk);
const baseURL = await new Promise((accept, reject) => {
  const timer = setTimeout(() => reject(new Error('Test server timeout: ' + serverErrors)), 20000);
  server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
});
const executablePath = process.env.CHROME_PATH || [
  'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
let browser;
let checks = 0;
const passed = name => { checks++; process.stdout.write(`✓ ${name}\n`); };
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio);
  await page.screenshot({ path: join(artifacts, 'empty.png') });
  assert.equal(await page.locator('#empty-state').isVisible(), true);
  passed('精致空状态与应用模块成功加载');

  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 820;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 820);
    ctx.strokeStyle = '#454c43'; ctx.lineWidth = 4;
    [[140,210,420,400],[600,210,320,240],[600,490,320,120]].forEach(rect => ctx.strokeRect(...rect));
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#687367';
    ctx.fillText('Acceptance floor plan / 100 px = 1 m', 140, 125);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const upload = async (name, mimeType, buffer) => {
    await page.locator('#drawing-file').setInputFiles({ name, mimeType, buffer });
    await page.waitForFunction(() => window.planStudio.getProject().drawing && document.querySelector('#upload-loading').hidden);
    await page.waitForTimeout(250);
  };
  await upload('验收平面图.png', 'image/png', png);
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  assert.equal(await page.evaluate(() => window.planStudio.getProject().drawing.width), 1200);
  passed('上传真实PNG并居中显示，未校准时无伪造面积');

  const location = async point => {
    const screen = await page.evaluate(p => window.planStudio.toScreen(p), point);
    const box = await page.locator('#drawing-canvas').boundingBox();
    return { x: screen.x + box.x, y: screen.y + box.y };
  };
  const clickPoint = async point => { const p = await location(point); await page.mouse.click(p.x, p.y); };
  const draw = async (points, tool = 'polygon') => {
    await page.locator(`[data-tool="${tool}"]`).click();
    for (const point of points) await clickPoint(point);
    await page.keyboard.press('Enter');
  };
  const rectangles = [
    [{x:140,y:210},{x:560,y:210},{x:560,y:610},{x:140,y:610}],
    [{x:600,y:210},{x:920,y:210},{x:920,y:450},{x:600,y:450}],
    [{x:600,y:490},{x:920,y:490},{x:920,y:610},{x:600,y:610}]
  ];
  for (const points of rectangles) await draw(points);
  await page.waitForFunction(() => window.planStudio.getProject().regions.length === 3);
  assert.equal(await page.locator('#total-area').innerText(), '待校准');
  assert.equal(await page.evaluate(() => window.planStudio.getQuote().total), null);
  passed('手动绘制三个独立区域；未校准报价保持待配置');

  await page.locator('[data-tool="calibrate"]').click();
  await clickPoint({x:140,y:700}); await clickPoint({x:560,y:700});
  await page.locator('#number-value').fill('4.2');
  await page.locator('#number-form button').click();
  const approximately = (value, expected, tolerance = .03) => assert.ok(Math.abs(Number(value) - expected) < tolerance, `${value} ≠ ${expected}`);
  let q = await page.evaluate(() => window.planStudio.getQuote());
  q.regions.forEach((r,i) => approximately(r.netArea, [16.8,7.68,3.84][i]));
  approximately(await page.evaluate(() => window.planStudio.getProject().calibration.metersPerPixel), .01, .00001);
  passed('两点真实距离校准得到16.80、7.68、3.84 m²');

  const beforeZoom = q.regions.map(r => r.netArea);
  await page.locator('#zoom-in').click();
  assert.deepEqual(await page.evaluate(() => window.planStudio.getQuote().regions.map(r=>r.netArea)), beforeZoom);
  await page.locator('#fit').click();
  const ids = await page.evaluate(() => window.planStudio.getProject().regions.map(r=>r.id));
  await page.locator(`[data-action="select-region"][data-id="${ids[0]}"]`).click();
  let start = await location(rectangles[0][1]), end = await location({x:540,y:230});
  await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.mouse.move(end.x,end.y,{steps:8});
  await page.waitForTimeout(80);
  q = await page.evaluate(() => window.planStudio.getQuote());
  assert.ok(q.regions[0].netArea < beforeZoom[0]);
  approximately(await page.locator('[data-stat="region-net-area"]').innerText(), q.regions[0].netArea);
  await page.mouse.up();
  await page.locator('#undo').click();
  approximately(await page.evaluate(() => window.planStudio.getQuote().regions[0].netArea), 16.8);
  await page.locator('#redo').click();
  assert.ok(await page.evaluate(() => window.planStudio.getQuote().regions[0].netArea < 16.8));
  await page.locator('#undo').click();
  await clickPoint(rectangles[0][1]); await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions[0].points.length),3);
  await page.locator('#undo').click();
  passed('缩放不改面积；拖动顶点实时更新并支持撤销');
  passed('顶点删除、撤销和重做恢复有效几何');

  await draw([{x:200,y:280},{x:300,y:280},{x:300,y:380},{x:200,y:380}], 'hole');
  approximately(await page.evaluate(() => window.planStudio.getQuote().regions[0].netArea), 15.8);
  await draw([{x:180,y:260},{x:320,y:260},{x:320,y:400},{x:180,y:400}]);
  assert.equal(await page.evaluate(() => window.planStudio.getProject().regions.length), 3);
  await page.keyboard.press('Escape');
  passed('孔洞扣除1 m²；与现有净区域重叠的轮廓被拒绝');
  await draw([{x:220,y:300},{x:280,y:300},{x:280,y:350},{x:220,y:350}]);
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions.length),4);
  await page.locator(`[data-action="select-region"][data-id="${ids[0]}"]`).click();
  await page.locator('[data-action="remove-hole"]').click();
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions[0].holes.length),1);
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions.length),3);
  await draw([{x:1000,y:210},{x:1120,y:340},{x:1000,y:340},{x:1120,y:210}]);
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions.length),3);
  await page.keyboard.press('Escape');
  passed('孔洞内独立区域可创建；移除孔洞导致重叠与自交多边形均被拒绝');

  for (const [i, material] of ['demo-wood','demo-tile','demo-stone'].entries()) {
    await page.locator(`[data-action="select-region"][data-id="${ids[i]}"]`).click();
    await page.locator('[data-action="add-item"]').click();
    await page.locator(`[data-pick-material="${material}"]`).click();
  }
  assert.equal(await page.evaluate(() => window.planStudio.getQuote().pending), false);
  await page.locator(`[data-action="select-region"][data-id="${ids[0]}"]`).click();
  await page.locator('[data-item-field="unitPrice"]').fill('100');
  await page.locator('[data-item-field="wasteRate"]').fill('10');
  await page.locator('[data-item-field="laborRate"]').fill('20');
  await page.locator('[data-item-field="additionalCost"]').fill('15');
  await page.locator('#region-additional-cost').fill('5');
  q = await page.evaluate(() => window.planStudio.getQuote());
  approximately(q.regions[0].items[0].purchaseQuantity,15.8*1.1);
  approximately(q.regions[0].materialCost,1738, .1);
  approximately(q.regions[0].laborCost,316, .1);
  approximately(q.regions[0].total,2074, .1);
  passed('三个区域选择不同材料，单价/损耗/人工/附加费实时正确更新');

  await page.locator('#settings').click();
  await page.locator('[name="additionalCost"]').fill('100');
  await page.locator('[name="taxRate"]').fill('6');
  await page.locator('#settings-form button[type="submit"]').click();
  q = await page.evaluate(() => window.planStudio.getQuote());
  approximately(q.tax,Math.round(Number(q.beforeTax)*6)/100, .001);
  assert.equal(q.total, (Number(q.beforeTax)+Number(q.tax)).toFixed(2));
  passed('项目固定费用与税率正确计入总价');

  await page.locator('[data-action="add-item"]').click();
  await page.locator('[data-action="new-material"]').click();
  await page.locator('[name="name"]').fill('实测踢脚线');
  await page.locator('[name="unit"]').selectOption('m');
  await page.locator('[name="unitPrice"]').fill('10');
  await page.locator('[name="wasteRate"]').fill('0');
  await page.locator('#material-form button[type="submit"]').click();
  await page.locator('[data-pick-material]').filter({hasText:'实测踢脚线'}).click();
  q = await page.evaluate(() => window.planStudio.getQuote());
  assert.equal(q.regions[0].items.length,2);
  approximately(q.regions[0].items[1].netQuantity,20.4,.03);
  passed('自定义按长度材料，同一区域多个计价项和含孔洞边界周长');

  await page.locator('[data-action="add-item"]').click();
  await page.locator('[data-action="new-material"]').click();
  await page.locator('[name="name"]').fill('检修配件');
  await page.locator('[name="unit"]').selectOption('件');
  await page.locator('[name="unitPrice"]').fill('0.105');
  await page.locator('[name="wasteRate"]').fill('0');
  await page.locator('#material-form button[type="submit"]').click();
  await page.locator('[data-pick-material]').filter({hasText:'检修配件'}).click();
  assert.equal(await page.evaluate(() => window.planStudio.getQuote().pending),true);
  await page.locator('[data-item-field="quantity"]').fill('3');
  q = await page.evaluate(() => window.planStudio.getQuote());
  assert.equal(q.regions[0].items[2].materialCost,'0.32');
  passed('按件材料待填数量；0.105×3以分为单位可靠舍入');

  const savedQuote = await page.evaluate(() => window.planStudio.getQuote());
  const projectId = await page.evaluate(() => window.planStudio.getProject().id);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  await page.locator(`[data-action="select-region"][data-id="${ids[1]}"]`).click();
  await page.waitForTimeout(180);
  await page.screenshot({path:join(artifacts,'workspace.png')});
  await page.reload(); await page.waitForFunction(()=>window.planStudio);
  await page.locator('#open-project').click();
  await page.locator(`[data-open-project="${projectId}"]`).click();
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(()=>window.planStudio.getQuote()),savedQuote);
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().drawing.blob instanceof Blob),true);
  passed('IndexedDB保存并刷新重载，几何/报价/底图Blob一致');

  await page.locator('#export').click();
  let downloading = page.waitForEvent('download');
  await page.locator('[data-export="csv"]').click();
  let download = await downloading; const csvPath = await download.path();
  const csv = await readFile(csvPath,'utf8');
  assert.ok(csv.includes('木地板') && csv.includes('检修配件') && csv.includes(savedQuote.total));
  await download.saveAs(join(artifacts,'quote.csv'));
  await page.locator('#export').click(); downloading = page.waitForEvent('download');
  await page.locator('[data-export="json"]').click(); download = await downloading;
  const jsonPath = await download.path(); const json = await readFile(jsonPath,'utf8');
  assert.ok(json.includes('data:image/png'));
  await page.locator('#project-file').setInputFiles(jsonPath);
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(()=>window.planStudio.getQuote()), savedQuote);
  passed('真实CSV下载和包含底图的JSON导出/重新导入');

  await page.locator('#export').click();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('[data-export="pdf"]').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.ok((await popup.locator('body').innerText()).includes(savedQuote.total));
  await popup.close();
  passed('真实排版报价页可打印或保存为PDF');

  await page.locator('#recognize').click();
  await page.waitForSelector('#accept-candidates',{timeout:30000});
  const candidateCount = await page.locator('[data-candidate]').count();
  assert.ok(candidateCount >= 3);
  await page.locator('[data-dialog-close]').click();
  passed('像素边界识别给出真实可确认候选轮廓');

  await page.setViewportSize({width:1100,height:800});
  await page.locator(`[data-action="select-region"][data-id="${ids[1]}"]`).click();
  await page.locator('#fit').click(); await page.waitForTimeout(150);
  await page.screenshot({path:join(artifacts,'workspace-1100.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  passed('1100px工作台无页面水平溢出');

  await page.setViewportSize({width:1440,height:960});
  await upload('识别验收.png','image/png',png);
  await page.locator('#recognize').click();
  await page.waitForSelector('#accept-candidates',{timeout:30000});
  await page.locator('#accept-candidates').click();
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions.length),3);
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().calibration.metersPerPixel),null);
  await page.locator('#calibration').click();
  await page.locator('[data-calibration="width"]').click();
  // The selected extracted polygon's horizontal span is measured from its real pixels.
  const actualWidth = await page.evaluate(()=>{const points=window.planStudio.getProject().regions.at(-1).points; return (Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)))/100;});
  await page.locator('#number-value').fill(String(actualWidth));
  await page.locator('#number-form button').click();
  approximately(await page.evaluate(()=>window.planStudio.getProject().calibration.metersPerPixel),.01,.000001);
  passed('确认实际识别候选后形成可编辑区域；已知宽度校准正确');

  await upload('两页图纸.pdf','application/pdf',await readFile(join(testRoot,'two-pages.pdf')));
  await page.waitForSelector('#pdf-page');
  await page.locator('#pdf-page').fill('2'); await page.locator('#pdf-form button').click();
  await page.waitForFunction(()=>window.planStudio.getProject().drawing.page===2,{timeout:30000});
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().drawing.pages),2);
  assert.equal(await page.evaluate(()=>window.planStudio.getProject().regions.length),0);
  passed('真实两页PDF上传、第二页渲染和校准重置');
  await page.locator('#pdf-pages').click();
  await page.locator('#pdf-page').fill('1'); await page.locator('#pdf-form button').click();
  await page.waitForFunction(()=>window.planStudio.getProject().drawing.page===1);
  await page.locator('#calibration').click(); await page.locator('[data-calibration="ratio"]').click();
  await page.locator('#ratio-number').fill('100'); await page.locator('#ratio-dpi').fill('300');
  await page.locator('#ratio-form button').click();
  approximately(await page.evaluate(()=>window.planStudio.getProject().calibration.metersPerPixel),.0254/3,.000001);
  passed('PDF页码可再次切换；比例尺与DPI换算正确');

  const plan = await context.newPage();
  plan.on('pageerror',error=>errors.push(error.message));
  plan.on('dialog',dialog=>dialog.accept());
  await plan.goto(baseURL); await plan.waitForFunction(()=>window.planStudio);
  await plan.locator('#draw-plan').click();
  await plan.waitForFunction(()=>window.planStudio.getProject().drawing?.type==='plan');
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().drawing.type),'plan');
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().calibration.metersPerPixel),.01);
  passed('无需图片，从真实尺寸二维绘图开始');
  const wallLength=async(length,direction)=>{
    await plan.locator('#wall-length').fill(String(length));
    await plan.locator('#wall-direction').selectOption(direction);
    await plan.locator('#wall-length-form button').click();
  };
  await wallLength(4,'right'); await wallLength(3,'down'); await wallLength(4,'left');
  assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),null);
  await wallLength(3,'up'); await plan.locator('#wall-done').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().walls.length),4);
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions.length),1);
  approximately(await plan.evaluate(()=>window.planStudio.getQuote().regions[0].netArea),10.64,.000001);
  passed('输入4×3m中心线长度自动闭合，扣20cm墙厚后10.64m²；断墙不给假报价');
  await plan.keyboard.press('p');
  assert.equal(await plan.locator('[data-tool="select"]').getAttribute('aria-pressed'),'true');
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions.length),1);
  await plan.locator('[data-action="select-region"]').click();
  await plan.locator('[data-action="add-item"]').click(); await plan.locator('[data-pick-material="demo-wood"]').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1340.64');
  const planPoint=async point=>{
    const screen=await plan.evaluate(p=>window.planStudio.toScreen(p),point);
    const box=await plan.locator('#drawing-canvas').boundingBox();
    await plan.mouse.click(screen.x+box.x,screen.y+box.y);
  };
  await plan.locator('[data-tool="wall"]').click();
  await planPoint({x:400,y:200}); await planPoint({x:400,y:500}); await plan.locator('#wall-done').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions.length),2);
  assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1270.08');
  await plan.locator('[data-tool="wall"]').click();
  await planPoint({x:400,y:350}); await planPoint({x:600,y:350}); await plan.locator('#wall-done').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions.length),3);
  assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1224.72');
  assert.ok(await plan.evaluate(()=>window.planStudio.getProject().regions.every(r=>r.items[0].materialId==='demo-wood')));
  passed('画分隔墙与T接点生成三个房间，自动继承材料并按新净面积重新报价');
  await planPoint({x:300,y:200});
  await plan.waitForSelector('#wall-edit-form');
  assert.equal(await plan.locator('#wall-edit-length').inputValue(),'4');
  await plan.locator('#wall-edit-length').fill('5'); await plan.locator('#wall-edit-form button[type="submit"]').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions.length),3);
  assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1552.32');
  await plan.locator('#undo').click(); assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1224.72');
  await plan.locator('#redo').click(); assert.equal(await plan.evaluate(()=>window.planStudio.getQuote().total),'1552.32');
  passed('编辑墙长保持连接并实时更新面积报价；撤销重做恢复配置');
  await plan.locator('[data-action="select-region"]').first().click();
  await plan.locator('#fit').click();
  await plan.screenshot({path:join(artifacts,'wall-plan.png')});
  const nativeQuote=await plan.evaluate(()=>window.planStudio.getQuote());
  const nativeId=await plan.evaluate(()=>window.planStudio.getProject().id);
  await plan.locator('#save').click(); await plan.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');
  await plan.reload(); await plan.waitForFunction(()=>window.planStudio);
  await plan.locator('#open-project').click(); await plan.locator(`[data-open-project="${nativeId}"]`).click();
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getQuote()),nativeQuote);
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().walls.length),6);
  passed('墙体/房间/材料与报价保存重载后重新计算一致');
  await plan.setViewportSize({width:1100,height:800});
  await plan.locator('#fit').click(); await plan.screenshot({path:join(artifacts,'wall-plan-1100.png')});
  assert.equal(await plan.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const controls=await plan.locator('#plan-controls').boundingBox(), stage=await plan.locator('#stage').boundingBox();
  assert.ok(controls.x>=stage.x&&controls.x+controls.width<=stage.x+stage.width,'绘墙长度工具溢出画布');
  passed('1100px绘图工作台及长度输入工具无溢出');

  await plan.setViewportSize({width:1440,height:960});
  // Wall height now changes wall measurements; with no wall finish, floor quantities and all charges remain invariant.
  const financialQuote=({walls,...quote})=>quote;
  const before3D=await plan.evaluate(()=>({quote:window.planStudio.getQuote(),walls:window.planStudio.getProject().walls}));
  await plan.locator('[data-view="3d"]').click();
  await plan.waitForFunction(()=>window.planStudio.getViewMode()==='3d'&&window.planStudio.get3DStats()?.ready);
  let stats3D=await plan.evaluate(()=>window.planStudio.get3DStats());
  assert.equal(stats3D.wallCount,6); assert.equal(stats3D.roomCount,3); assert.equal(stats3D.cutaway,false); assert.equal(stats3D.glError,0);
  const measuredScene=await plan.evaluate(async()=>{
    const {buildSceneModel}=await import('/studio/lib/scene-model.js');
    const model=buildSceneModel(window.planStudio.getProject());
    // Independent Newell area measurement of the actual metre-space geometry.
    // A union may simplify its triangulation without losing any wall or room.
    const area=ring=>{
      const normal=ring.reduce((n,p,i)=>{
        const q=ring[(i+1)%ring.length];
        n.x+=(p.y-q.y)*(p.z+q.z);n.y+=(p.z-q.z)*(p.x+q.x);n.z+=(p.x-q.x)*(p.y+q.y);return n;
      },{x:0,y:0,z:0});
      return Math.hypot(normal.x,normal.y,normal.z)/2;
    };
    return {floorAreas:model.floors.map(f=>area(f.points)-f.holes.reduce((sum,hole)=>sum+area(hole),0)).sort((a,b)=>a-b),
      wallIds:[...new Set(model.surfaces.map(s=>s.wallId))],surfaceCount:model.surfaces.length,
      topArea:model.surfaces.filter(s=>s.side==='top').reduce((sum,s)=>sum+area(s.points),0),
      bottomArea:model.surfaces.filter(s=>s.side==='bottom').reduce((sum,s)=>sum+area(s.points),0),
      verticalArea:model.surfaces.filter(s=>Math.abs(s.normal.y)<.01).reduce((sum,s)=>sum+area(s.points),0)};
  });
  assert.deepEqual(measuredScene.wallIds.sort(),before3D.walls.map(w=>w.id).sort(),'all six walls must have rendered exposed surfaces');
  assert.equal(stats3D.wallSurfaceCount,measuredScene.surfaceCount,'the viewer must render the entire real wall union');
  assert.equal(stats3D.floorCount,3);
  // The edited 5x3 m centreline envelope contains a 1.8x2.8 m room and
  // two 2.8x1.3 m rooms. Its walls occupy 5.2x3.2 - 12.32 = 4.32 m².
  measuredScene.floorAreas.forEach((area,index)=>approximately(area,[3.64,3.64,5.04][index],.000001));
  approximately(measuredScene.topArea,4.32,.000001);approximately(measuredScene.bottomArea,4.32,.000001);
  approximately(measuredScene.verticalArea,118.72,.000001);
  await plan.waitForFunction(()=>window.planStudio.get3DStats().texturedFloorCount===3);
  await plan.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const fullHeightPixels=await plan.evaluate(()=>{
    const canvas=document.querySelector('#viewer3d canvas'),gl=canvas.getContext('webgl'),data=new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    let dark=0;for(let i=0;i<data.length;i+=16)if(Math.min(data[i],data[i+1],data[i+2])<200)dark++;
    return {dark,error:gl.getError()};
  });
  assert.ok(fullHeightPixels.dark>500,'full-height walls and three material floors must produce a real framebuffer image');
  assert.equal(fullHeightPixels.error,0);
  assert.ok(stats3D.wallHeights.every(w=>w.height===2.8&&w.thickness===.2));
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  await plan.screenshot({path:join(artifacts,'three-full-height.png')});
  passed('真实WebGL生成六面墙和三个净地面，默认墙高2.8m、厚20cm，与二维报价一致');

  const canvas3D=await plan.locator('#viewer3d canvas').boundingBox();
  await plan.mouse.move(canvas3D.x+canvas3D.width*.5,canvas3D.y+canvas3D.height*.65);
  await plan.mouse.down(); await plan.mouse.move(canvas3D.x+canvas3D.width*.5+65,canvas3D.y+canvas3D.height*.65+20,{steps:8}); await plan.mouse.up();
  let moved3D=await plan.evaluate(()=>window.planStudio.get3DStats());
  assert.notEqual(moved3D.camera.yaw,stats3D.camera.yaw);
  await plan.mouse.down({button:'right'}); await plan.mouse.move(canvas3D.x+canvas3D.width*.5+85,canvas3D.y+canvas3D.height*.65+30,{steps:5}); await plan.mouse.up({button:'right'});
  assert.notDeepEqual(await plan.evaluate(()=>window.planStudio.get3DStats().camera.target),moved3D.camera.target);
  await plan.locator('#zoom-in').click();
  assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().camera.distance))<moved3D.camera.distance);
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getProject().walls),before3D.walls);
  await plan.locator('#fit').click();
  passed('三维旋转、平移和缩放只改变相机，真实墙体尺寸与报价保持一致');

  const point3D=async point=>{
    const screen=await plan.evaluate(p=>window.planStudio.toScreen3D(p),point);
    const bounds=await plan.locator('#viewer3d canvas').boundingBox();
    assert.equal(screen.visible,true,'三维目标应在视野内');
    return {x:screen.x+bounds.x,y:screen.y+bounds.y};
  };
  const frontWall=before3D.walls.find(w=>w.start.y===500&&w.end.y===500);
  let target3D=await point3D({x:(frontWall.start.x+frontWall.end.x)/200,y:1.4,z:5});
  await plan.mouse.click(target3D.x,target3D.y); await plan.waitForSelector('#wall-edit-height');
  assert.equal(await plan.locator('#wall-edit-height').inputValue(),'2.8');
  await plan.locator('#wall-edit-height').fill('3.5'); await plan.locator('#wall-edit-form button[type="submit"]').click();
  stats3D=await plan.evaluate(()=>window.planStudio.get3DStats());
  assert.equal(stats3D.wallHeights.find(w=>w.id===frontWall.id).height,3.5);
  assert.ok((await plan.evaluate(()=>window.planStudio.getQuote().walls)).find(w=>w.id===frontWall.id).netArea>before3D.quote.walls.find(w=>w.id===frontWall.id).netArea); assert.equal(stats3D.bounds.max.y,3.5);
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  await plan.locator('#undo').click(); assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).every(w=>w.height===2.8));
  await plan.locator('#redo').click(); assert.equal((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).find(w=>w.id===frontWall.id).height,3.5);
  passed('点击真实三维墙体修改单墙高度，模型与边界即时更新，撤销重做可靠且不改变地面报价');

  await plan.locator('#wall-defaults').click();
  const checkbox=await plan.locator('#apply-wall-dimensions').boundingBox(); assert.ok(checkbox.width<=20&&checkbox.height<=20);
  await plan.locator('#default-wall-height').fill('3.2'); await plan.locator('#wall-defaults-form button[type="submit"]').click();
  assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).every(w=>w.height===3.2));
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  await plan.locator('#wall-defaults').click(); await plan.locator('#apply-wall-dimensions').uncheck();
  await plan.locator('#default-wall-height').fill('3.6'); await plan.locator('#wall-defaults-form button[type="submit"]').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().wallHeight),360);
  assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).every(w=>w.height===3.2));
  await plan.locator('#wall-defaults').click(); await plan.locator('#default-wall-thickness').fill('30');
  await plan.locator('#wall-defaults-form button[type="submit"]').click();
  assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).every(w=>w.height===3.6&&w.thickness===.3));
  const thickerQuote=await plan.evaluate(()=>window.planStudio.getQuote()); assert.ok(Number(thickerQuote.total)<Number(before3D.quote.total));
  await plan.locator('#undo').click(); assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  passed('统一墙高及新墙默认值可分别设置；增厚墙体减少净地面及材料费用，撤销恢复');

  const dimensions3D=await plan.evaluate(()=>window.planStudio.getProject().walls);
  await plan.locator('#cutaway').click();
  stats3D=await plan.evaluate(()=>window.planStudio.get3DStats()); assert.equal(stats3D.cutaway,true);
  assert.ok(stats3D.wallHeights.every(w=>w.displayedHeight===.6&&w.height===3.2));
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getProject().walls),dimensions3D);
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  await plan.locator('#fit').click();
  await plan.waitForFunction(()=>window.planStudio.get3DStats().visibleLabelCount>0);
  const visibleLabels=await plan.locator('.scene-room-label:visible').allTextContents();
  assert.ok(visibleLabels.some(label=>label.includes('m²')));
  await plan.locator('[data-action="toggle-labels"]').click();
  await plan.waitForFunction(()=>window.planStudio.get3DStats().visibleLabelCount===0);
  assert.equal(await plan.evaluate(()=>window.planStudio.get3DStats().labelsEnabled),false);
  await plan.locator('[data-action="toggle-labels"]').click();
  await plan.waitForFunction(()=>window.planStudio.get3DStats().visibleLabelCount>0);
  assert.deepEqual(financialQuote(await plan.evaluate(()=>window.planStudio.getQuote())),financialQuote(before3D.quote));
  passed('三维房间标签显示真实名称和净面积，显示开关即时生效且不影响报价');
  const firstRoom=await plan.evaluate(()=>window.planStudio.getProject().regions[0]);
  const centerRoom=firstRoom.points.reduce((sum,p)=>({x:sum.x+p.x/firstRoom.points.length/100,y:.012,z:sum.z+p.y/firstRoom.points.length/100}),{x:0,y:.012,z:0});
  target3D=await point3D(centerRoom); await plan.mouse.click(target3D.x,target3D.y);
  assert.equal(await plan.locator('[data-region-field="name"]').inputValue(),firstRoom.name);
  await plan.locator('[data-action="choose-material"]').click(); await plan.locator('[data-pick-material="demo-tile"]').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().regions[0].items[0].materialId),'demo-tile');
  assert.notEqual((await plan.evaluate(()=>window.planStudio.getQuote().total)),before3D.quote.total);
  await plan.waitForFunction(()=>window.planStudio.get3DStats().texturedFloorCount===3);
  await plan.screenshot({path:join(artifacts,'three-materials.png')});
  passed('低墙查看只改变展示；点击三维地面选择材料，纹理、颜色与报价同步更新');

  const viewDownload=plan.waitForEvent('download'); await plan.locator('#capture-3d').click();
  const viewPNG=await viewDownload; const png3D=await readFile(await viewPNG.path());
  assert.ok(png3D.length>5000); assert.equal(png3D.subarray(1,4).toString(),'PNG');
  await viewPNG.saveAs(join(artifacts,'three-export.png'));
  const pixel3D=await plan.evaluate(()=>{
    const canvas=document.querySelector('#viewer3d canvas'),gl=canvas.getContext('webgl'),data=new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    let dark=0;for(let i=0;i<data.length;i+=16)if(Math.min(data[i],data[i+1],data[i+2])<200)dark++;
    return {dark,error:gl.getError()};
  });
  assert.ok(pixel3D.dark>500,'真实三维场景须绘制墙和材质像素'); assert.equal(pixel3D.error,0);
  passed('从真实WebGL视图导出有效PNG，像素读取确认模型可见而非空白画布');

  const saved3D=await plan.evaluate(()=>({walls:window.planStudio.getProject().walls,quote:window.planStudio.getQuote(),height:window.planStudio.getProject().wallHeight}));
  await plan.locator('#save').click(); await plan.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');
  await plan.reload(); await plan.waitForFunction(()=>window.planStudio);
  await plan.locator('#open-project').click(); await plan.locator(`[data-open-project="${nativeId}"]`).click();
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getProject().walls),saved3D.walls);
  assert.equal(await plan.evaluate(()=>window.planStudio.getProject().wallHeight),saved3D.height);
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getQuote()),saved3D.quote);
  await plan.locator('[data-view="3d"]').click(); await plan.waitForFunction(()=>window.planStudio.get3DStats()?.ready);
  assert.ok((await plan.evaluate(()=>window.planStudio.get3DStats().wallHeights)).every(w=>w.height===3.2));
  await plan.locator('#export').click(); const projectDownload=plan.waitForEvent('download'); await plan.locator('[data-export="json"]').click();
  const export3D=await projectDownload; const export3DPath=await export3D.path(); await plan.locator('#project-file').setInputFiles(export3DPath);
  await plan.waitForFunction(()=>window.planStudio.getViewMode()==='2d');
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getProject().walls),saved3D.walls);
  assert.deepEqual(await plan.evaluate(()=>window.planStudio.getQuote()),saved3D.quote);
  passed('墙高、厚度、材料报价在本机保存刷新及JSON导出重新导入后保持一致');
  await plan.locator('[data-view="3d"]').click(); await plan.waitForFunction(()=>window.planStudio.getViewMode()==='3d');
  await plan.setViewportSize({width:1100,height:800}); await plan.locator('#fit').click();
  await plan.screenshot({path:join(artifacts,'three-1100.png')});
  assert.equal(await plan.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const stage3D=await plan.locator('#stage').boundingBox();
  for(const selector of ['#view-switch','#three-tools','#wall-defaults']){
    const bounds=await plan.locator(selector).boundingBox();assert.ok(bounds.x>=stage3D.x&&bounds.x+bounds.width<=stage3D.x+stage3D.width,selector+' 溢出画布');
  }
  await plan.locator('#inspector [data-action="wall-tool"]').click();
  assert.equal(await plan.evaluate(()=>window.planStudio.getViewMode()),'2d');
  assert.equal(await plan.locator('[data-tool="wall"]').getAttribute('aria-pressed'),'true');
  await plan.locator('[data-view="3d"]').click(); await plan.waitForFunction(()=>window.planStudio.getViewMode()==='3d');
  await plan.keyboard.press('w'); await plan.waitForFunction(()=>window.planStudio.getViewMode()==='2d');
  assert.equal(await plan.locator('[data-tool="wall"]').getAttribute('aria-pressed'),'true');
  passed('1100px三维工具栏无溢出；画墙快捷键自动回到二维继续绘图');

  const quick = await context.newPage(); quick.on('pageerror',error=>errors.push(error.message)); quick.on('dialog',dialog=>dialog.accept());
  await quick.goto(baseURL); await quick.waitForFunction(()=>window.planStudio); await quick.locator('#draw-plan').click();
  await quick.waitForFunction(()=>window.planStudio.getProject().drawing?.type==='plan');
  await quick.locator('#wall-done').click(); await quick.locator('#inspector [data-action="room-template"]').click();
  await quick.locator('#room-name').fill('净尺寸房间'); await quick.locator('#room-width').fill('4'); await quick.locator('#room-depth').fill('3');
  await quick.locator('#room-template-form button').click();
  approximately(await quick.evaluate(()=>window.planStudio.getQuote().regions[0].netArea),12,.000001);
  assert.equal(await quick.evaluate(()=>window.planStudio.getProject().walls.length),4);
  passed('快捷模板输入净长宽4×3m，生成墙体并得到准确12m²');
  assert.deepEqual(errors,[]);
  passed('完整流程没有浏览器运行时错误');
  process.stdout.write(`\n${checks} 项浏览器验收通过。截图和CSV：${artifacts}\n`);
} catch (error) {
  if (browser) { for(const context of browser.contexts()) for(const page of context.pages()) await page.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{}); }
  throw error;
} finally {
  await browser?.close(); server.kill();
}
