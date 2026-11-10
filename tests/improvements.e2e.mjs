import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Isolated, real UI acceptance: geometry is drawn by user controls, CSV uses
// the real server parser, and hooks only read project/quote/rendering state.
const testRoot = await mkdtemp(join(tmpdir(), 'studio-improvements-'));
const artifacts = resolve('artifacts/studio');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '';
server.stderr.on('data', data => serverErrors += data);
const baseURL = await new Promise((accept, reject) => {
  const timer = setTimeout(() => reject(new Error(serverErrors || 'Test server timeout')), 20000);
  server.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
});
const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
let browser, page;
let checks = 0;
const reports = [];
const passed = name => { assert.ok(checks < 16); checks++; reports.push(name); console.log('✓ ' + name); };
const near = (value, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(value) - expected) < tolerance, `${value} ≠ ${expected}`);
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width:1440, height:960 }, acceptDownloads:true });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio);
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const quote = () => page.evaluate(() => window.planStudio.getQuote());
  const stats = () => page.evaluate(() => window.planStudio.get3DStats());
  const selectWall = async id => {
    if (!await page.locator('.walls-section details').evaluate(el => el.open)) await page.locator('.walls-section summary').click();
    await page.locator(`#left-panel [data-action="select-wall"][data-id="${id}"]`).click();
    await page.waitForSelector('#wall-edit-form');
  };
  const show3D = async () => { await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.getViewMode() === '3d' && window.planStudio.get3DStats()?.ready); await page.waitForTimeout(100); };
  const show2D = () => page.locator('[data-view="2d"]').click();
  const opening = async (wallId, kind, values, configure) => {
    await selectWall(wallId);
    await page.locator(`[data-action="add-opening"][data-kind="${kind}"]`).click();
    for (const [field, value] of Object.entries(values)) {
      if (field === 'shape') await page.locator('#opening-shape').selectOption(String(value));
      else await page.locator('#opening-' + field).fill(String(value));
    }
    if (configure) await configure();
    await page.locator('#opening-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    return (await project()).openings.at(-1);
  };
  const wallQuote = async id => (await quote()).walls.find(w => w.id === id);
  const pixelAt = async point => page.evaluate(point => {
    const canvas = document.querySelector('#viewer3d canvas'), gl = canvas.getContext('webgl');
    const screen = window.planStudio.toScreen3D(point), pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(screen.x*canvas.width/canvas.clientWidth), Math.floor(canvas.height-screen.y*canvas.height/canvas.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return { pixel:Array.from(pixel), screen, error:gl.getError() };
  }, point);
  await page.locator('#draw-plan').click(); await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  await page.locator('#wall-done').click(); await page.locator('#inspector [data-action="room-template"]').click();
  await page.locator('#room-name').fill('验收房间'); await page.locator('#room-width').fill('4'); await page.locator('#room-depth').fill('3');
  await page.locator('#room-height').fill('2.8'); await page.locator('#room-thickness').fill('20');
  await page.locator('#room-template-form button[type="submit"]').click();
  const roomId = (await project()).regions[0].id;
  const walls = (await project()).walls, firstId = walls[0].id, secondId = walls[1].id, thirdId = walls[2].id, fourthId = walls[3].id;
  await page.locator('[data-action="add-item"]').click(); await page.locator('[data-pick-material="demo-wood"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('50'); await page.locator('[data-item-field="wasteRate"]').fill('0'); await page.locator('[data-item-field="laborRate"]').fill('0');
  near((await quote()).regions[0].netArea, 12); assert.equal((await quote()).total, '600.00');
  passed('真实净尺寸4×3m房间生成四面墙，原地面材料报价仍准确');

  await selectWall(firstId); await page.locator('[data-wall-field="name"]').fill('验收主墙');
  const grossWall = (await wallQuote(firstId)).grossArea;
  // A net 4 x 3 m room has a 4 m inner and 4.4 m outer north face.
  // Coplanar corner strips complete the long faces, without billing real ends.
  near(grossWall, (4 + 4.4) * 2.8);
  near((await quote()).walls.reduce((sum,w) => sum + w.netArea,0), 82.88);
  near((await wallQuote(firstId)).netArea, grossWall);
  await page.locator('[data-action="add-item"]').click(); await page.locator('[data-pick-material="demo-tile"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('100'); await page.locator('[data-item-field="wasteRate"]').fill('10'); await page.locator('[data-item-field="laborRate"]').fill('20');
  await page.locator('#wall-finish-side').selectOption('left'); near((await wallQuote(firstId)).netArea, 11.2); assert.equal((await wallQuote(firstId)).total, '1456.00');
  await page.locator('#wall-finish-side').selectOption('right'); assert.equal((await wallQuote(firstId)).side,'right');
  near((await wallQuote(firstId)).netArea, 4.4 * 2.8);
  await page.locator('#wall-finish-side').selectOption('both'); assert.equal((await wallQuote(firstId)).total, (grossWall*130).toFixed(2));
  assert.equal((await quote()).total, (600+grossWall*130).toFixed(2));
  passed('真实连续内外侧面总面积82.88m²、主墙内侧11.20m²及外侧12.32m²；损耗人工正确计价');

  const door = await opening(firstId, 'door', { width:.9,height:2.1,offset:.5,bottom:0,depth:4 });
  assert.equal(door.depth, 4); near((await wallQuote(firstId)).openingArea, 2 * .9 * 2.1); near((await wallQuote(firstId)).revealArea, (2 * 2.1 + .9) * .2); near((await wallQuote(firstId)).netArea, grossWall - 2 * .9 * 2.1);
  assert.equal((await wallQuote(firstId)).materialCost, '2171.40'); assert.equal((await wallQuote(firstId)).laborCost, '394.80'); assert.equal((await wallQuote(firstId)).total, '2566.20'); assert.equal((await quote()).total, '3166.20');
  near((await quote()).regions[0].netArea, 12); assert.equal((await wallQuote(firstId)).items.length, 1);
  passed('0.9×2.1m门扣双面3.78m²，保留真实1.02m²洞口内壁但不计价，材料人工按净19.74m²计算');
  const win = await opening(firstId, 'window', { width:1.2,height:1.2,offset:2,bottom:1,depth:6 });
  near((await wallQuote(firstId)).openingArea, 2 * (.9 * 2.1 + 1.2 * 1.2)); near((await wallQuote(firstId)).netArea, grossWall - 2 * (.9 * 2.1 + 1.2 * 1.2));
  near((await wallQuote(firstId)).revealArea, (2 * 2.1 + .9 + 4 * 1.2) * .2);
  assert.equal((await wallQuote(firstId)).materialCost, '1854.60'); assert.equal((await wallQuote(firstId)).laborCost, '337.20'); assert.equal((await wallQuote(firstId)).total, '2191.80'); assert.equal((await quote()).total, '2791.80');
  await show3D(); assert.equal((await stats()).renderedInsertCount, 2); assert.equal((await stats()).openingCount, 2);
  assert.equal((await stats()).openings.find(o => o.id === win.id).depth, 6);
  passed('1.2×1.2m窗及6cm窗框进入真实三维，双面开口准确扣量，洞口内壁不加价且地面不受影响');

  // A known point on the visible right-hand wall is sampled before and after
  // making a genuine through-opening, using the same fitted camera.
  const rightWall = walls[1], holePoint = { x:rightWall.start.x/100 + .1,y:1.2,z:rightWall.start.y/100 + 1.4 };
  const beforeHole = await pixelAt(holePoint);
  await show2D();
  const rectangular = await opening(secondId, 'hole', { width:1.2,height:1.2,offset:.8,bottom:.6,shape:'rectangle' });
  assert.equal(rectangular.depth, 20); await show3D(); const afterHole = await pixelAt(holePoint);
  assert.notDeepEqual(afterHole.pixel, beforeHole.pixel, '真实孔洞处像素必须改变，不能只画轮廓');
  const box = await page.locator('#viewer3d').boundingBox();
  await page.mouse.click(box.x + afterHole.screen.x, box.y + afterHole.screen.y);
  assert.equal(await page.locator('#wall-edit-form').count(), 0, '通过孔洞的射线不得命中原先完整墙盒');
  assert.equal(afterHole.error, 0);
  await page.screenshot({ path:join(artifacts,'improvements-rectangle-hole.png') });
  passed('矩形孔洞贯穿20cm墙厚，真实帧缓冲和射线选择验证缺口');

  await show2D();
  const ellipse = await opening(fourthId, 'hole', { width:.8,height:.6,offset:.8,bottom:1,shape:'ellipse' });
  await selectWall(fourthId); near((await wallQuote(fourthId)).openingArea / 2, Math.PI*.4*.3, .0002);
  assert.equal(ellipse.shape, 'ellipse');
  passed('椭圆开孔由确定性128边几何计算，单侧扣除面积接近π×0.4×0.3m²');

  const svgClick = async (x, y, wallHeight = 280) => {
    const point = await page.evaluate(({x,y,wallHeight}) => { const p = new DOMPoint(x,wallHeight-y).matrixTransform(document.querySelector('#opening-preview').getScreenCTM()); return {x:p.x,y:p.y}; }, {x,y,wallHeight});
    await page.mouse.click(point.x, point.y);
  };
  const polygon = await opening(thirdId, 'hole', { width:1,height:1,offset:.5,bottom:1,shape:'polygon' }, async () => {
    await page.locator('#opening-redraw').click();
    await svgClick(60,110); await svgClick(140,110); await svgClick(100,190);
    await page.locator('#opening-close').click();
  });
  assert.equal(polygon.points.length, 3);
  await selectWall(thirdId); near((await wallQuote(thirdId)).openingArea, .64, .005);
  await page.locator(`[data-action="select-opening"][data-id="${polygon.id}"]`).click(); await page.locator('[data-action="edit-opening"]').click();
  const vertex = await page.locator('[data-opening-vertex="2"]').boundingBox();
  const target = await page.evaluate(() => { const p = new DOMPoint(100,110).matrixTransform(document.querySelector('#opening-preview').getScreenCTM()); return {x:p.x,y:p.y}; });
  await page.mouse.move(vertex.x+vertex.width/2,vertex.y+vertex.height/2); await page.mouse.down(); await page.mouse.move(target.x,target.y,{steps:5}); await page.mouse.up();
  await page.locator('#opening-form button[type="submit"]').click(); await selectWall(thirdId);
  near((await wallQuote(thirdId)).openingArea, .48, .006);
  passed('用户在立面预览重绘三角形孔洞，并拖动顶点将双侧扣除量从0.64改为0.48m²');

  await selectWall(firstId); const oldWallAmount = (await wallQuote(firstId)).total;
  await page.locator('#wall-defaults').click(); await page.locator('#default-wall-height').fill('3.2'); await page.locator('#default-wall-thickness').fill('20'); await page.locator('#wall-defaults-form button[type="submit"]').click();
  assert.ok(Number((await wallQuote(firstId)).total) > Number(oldWallAmount)); near((await quote()).regions[0].netArea, 12);
  await selectWall(firstId); await page.locator('#wall-edit-length').fill('5.2'); await page.locator('#wall-edit-form button[type="submit"]').click(); near((await quote()).regions[0].netArea, 15);
  await page.locator('#wall-defaults').click(); await page.locator('#default-wall-height').fill('3.2'); await page.locator('#default-wall-thickness').fill('30'); await page.locator('#wall-defaults-form button[type="submit"]').click();
  near((await quote()).regions[0].netArea, 14.21); assert.equal((await project()).openings.find(o => o.id === door.id).depth, 4);
  passed('墙高更新墙面报价而保留地面，墙长更新房间15m²，30cm墙厚更新14.21m²且保留门扇厚度');

  const beforeInvalid = await project(), invalidQuote = await quote();
  for (const [field,value] of [['length','1'],['height','.8']]) {
    await selectWall(firstId); await page.locator('#wall-edit-' + field).fill(value); await page.locator('#wall-edit-form button[type="submit"]').click();
    assert.deepEqual((await project()).walls, beforeInvalid.walls); assert.deepEqual((await project()).openings, beforeInvalid.openings); assert.deepEqual(await quote(), invalidQuote);
    assert.match(await page.locator('#toast').innerText(), /开孔|开口|门窗/);
  }
  passed('缩短墙长或墙高导致已有开口越界时明确报错，原工程与报价保持完整');
  await selectWall(firstId); await page.locator('[data-action="delete-wall"]').click();
  assert.ok(!(await project()).walls.some(w => w.id === firstId)); assert.ok(!(await project()).openings.some(o => o.wallId === firstId));
  await page.locator('#undo').click(); assert.deepEqual((await project()).walls, beforeInvalid.walls); assert.deepEqual((await project()).openings, beforeInvalid.openings); assert.deepEqual(await quote(), invalidQuote);
  passed('删除墙体连同其门窗一起移除；一次撤销完整恢复墙材、开口和报价');

  await selectWall(firstId); const beforePrice = (await wallQuote(firstId)).items[0].unitPrice;
  await page.locator('[data-action="update-prices"]').click(); await page.waitForSelector('#price-official-update');
  await page.locator('#price-region').fill('浙江杭州'); await page.locator('#price-source').fill('验收供应商'); await page.locator('#price-date').fill('2026-11-07');
  await page.locator('#price-import-file').setInputFiles({name:'真实验收报价.csv',mimeType:'text/csv',buffer:Buffer.from('名称,单位,价格\n墙砖,m²,150\n','utf8')});
  await page.waitForSelector('#price-apply'); await page.locator('[data-price-target="0"]').selectOption('demo-tile'); await page.locator('#price-apply').click();
  assert.equal((await wallQuote(firstId)).items[0].unitPrice, beforePrice);
  await page.locator('[data-action="refresh-item-price"]').click(); assert.equal((await wallQuote(firstId)).items[0].unitPrice, '150');
  assert.equal((await project()).walls.find(w => w.id === firstId).items[0].provenance.region, '浙江杭州');
  passed('左侧真实CSV导入保留地区、日期和来源，旧单价快照保持，显式刷新才应用150元/m²');

  // Only this error response is intercepted. Official positive-data parsing and
  // preview are covered by price-manager.e2e.mjs with labelled upstream fixtures.
  await page.route('**/api/scrape/nbs/preview', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'验收模拟：官方网站暂时不可访问'})}));
  const beforeNetwork = await quote(); await page.locator('[data-action="update-prices"]').click(); await page.locator('#price-official-update').click();
  await page.waitForFunction(() => document.querySelector('#price-status').classList.contains('error'));
  assert.match(await page.locator('#price-status').innerText(), /保持原值/); assert.deepEqual(await quote(), beforeNetwork);
  await page.locator('[data-dialog-close]').click();
  passed('官方更新按钮接入真实请求，网络失败清楚显示错误并保留既有报价');

  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const stored = await project(), storedQuote = await quote();
  await page.reload(); await page.waitForFunction(() => window.planStudio); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${stored.id}"]`).click();
  assert.deepEqual((await project()).openings, stored.openings); assert.deepEqual((await project()).walls, stored.walls); assert.deepEqual(await quote(), storedQuote);
  const downloadFile = async type => { const [download] = await Promise.all([page.waitForEvent('download',{timeout:8000}), (async () => { await page.locator('#export').click(); await page.locator(`[data-export="${type}"]`).click(); })()]); const path = join(artifacts,'improvements-project.' + type); await download.saveAs(path); return path; };
  const jsonPath = await downloadFile('json'); const exported = JSON.parse(await readFile(jsonPath,'utf8'));
  assert.deepEqual(exported.openings, stored.openings); assert.deepEqual(exported.walls, stored.walls);
  await page.locator('#project-file').setInputFiles(jsonPath); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('完整项目已导入'));
  assert.deepEqual((await project()).openings, stored.openings); assert.deepEqual(await quote(), storedQuote);
  passed('保存重载与完整JSON分享保留墙面材价、左右计量范围、门窗厚度和自定义孔洞顶点');
  const csv = await readFile(await downloadFile('csv'),'utf8'); assert.match(csv,/墙面材料明细/); assert.match(csv,/验收主墙/); assert.match(csv,/150/);
  passed('CSV正式报价同时包含地面与墙面真实用量、材料、人工和总价');

  await show3D(); const finalStats = await stats(); assert.equal(finalStats.openingCount, 5); assert.equal(finalStats.renderedInsertCount, 2); assert.ok(finalStats.wallSurfaceCount > 24); assert.ok(finalStats.texturedWallSurfaceCount > 0); assert.equal(finalStats.glError,0);
  await page.screenshot({path:join(artifacts,'improvements-3d.png')});
  await page.setViewportSize({width:1100,height:800}); await page.locator('#fit').click(); await page.waitForTimeout(120);
  await page.screenshot({path:join(artifacts,'improvements-1100.png')}); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  assert.deepEqual(errors,[]);
  passed('五个门窗孔形使用实际union三维面，材质同步；1100px布局无溢出且全流程无运行时错误');
  await writeFile(join(artifacts,'improvements-validation.json'),JSON.stringify({checks,reports,finalStats,fixtures:'Only the official failure response is intercepted; CSV uses the actual local HTTP parser.'},null,2));
  console.log(`${checks} 项改进功能浏览器验收通过`);
} catch(error) {
  await page?.screenshot({path:join(artifacts,'improvements-failure.png')}).catch(()=>{});
  if(page) console.error(JSON.stringify(await page.evaluate(() => ({quote:{total:window.planStudio?.getQuote().total,pending:window.planStudio?.getQuote().pending,reasons:window.planStudio?.getQuote().pendingReasons},stats:window.planStudio?.get3DStats(),toast:document.querySelector('#toast')?.textContent})).catch(()=>({})),null,2));
  throw error;
} finally { await browser?.close(); server.kill(); }
