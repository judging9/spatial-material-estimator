import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const testRoot = await mkdtemp(join(tmpdir(), 'studio-furniture-'));
const artifacts = resolve('artifacts/furniture'); await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = ''; server.stderr.on('data', chunk => serverErrors += chunk);
let browser, page, checks = 0; const reports = [];
const pass = message => { reports.push(message); checks++; process.stdout.write(`✓ ${message}\n`); };
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(Number(a) - b) < tolerance, `${a} != ${b}`);
try {
  const baseURL = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 20000); server.stdout.on('data', chunk => { const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (url) { clearTimeout(timer); accept(url[0]); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); }); });
  const executablePath = process.env.CHROME_PATH || 'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio);
  await page.locator('#draw-plan').click(); await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  const getProject = () => page.evaluate(() => window.planStudio.getProject());
  const getQuote = () => page.evaluate(() => window.planStudio.getQuote());
  const screen = async point => { const p = await page.evaluate(point => window.planStudio.toScreen(point), point); const box = await page.locator('#drawing-canvas').boundingBox(); return { x: box.x + p.x, y: box.y + p.y }; };
  const clickWorld = async point => { const p = await screen(point); await page.mouse.click(p.x, p.y); };
  // Actual pointer drawing of a 3-4-5 right triangle: r=100cm, 10cm half
  // wall thickness. Inner area is 6*(1-10/100)^2 = 4.86 m².
  for (const p of [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 200, y: 500 }, { x: 200, y: 200 }]) await clickWorld(p);
  await page.locator('#wall-done').click();
  const triangle = (await getProject()).regions[0]; assert.ok(triangle); near((await getQuote()).regions[0].netArea, 4.86);
  const diagonal = (await getProject()).walls.find(w => w.start.x !== w.end.x && w.start.y !== w.end.y); assert.ok(diagonal);
  pass('鼠标实际绘制斜边闭合房间，3-4-5三角形扣20cm墙厚得到4.86m²');
  await page.locator(`[data-action="select-region"][data-id="${triangle.id}"]`).click();
  await page.locator('[data-action="add-item"]').click(); await page.locator('[data-pick-material="demo-wood"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('100'); await page.locator('[data-item-field="wasteRate"]').fill('10'); await page.locator('[data-item-field="laborRate"]').fill('20');
  near((await getQuote()).regions[0].items[0].purchaseQuantity, 5.346); assert.equal((await getQuote()).regions[0].total, '631.80');
  pass('斜房间采购损耗、净面积人工费按实际净面积计算');
  await page.locator('.walls-section summary').click(); await page.locator(`[data-action="select-wall"][data-id="${diagonal.id}"]`).click();
  for (const side of ['left', 'right', 'both']) {
    await page.locator('#wall-finish-side').selectOption(side);
    const selection = await page.evaluate(() => window.planStudio.get2DWallSelection());
    assert.equal(selection.side, side); assert.ok(selection.faces.length > 0);
    assert.ok(selection.faces.every(face => side === 'both' ? ['left', 'right', 'end', 'reveal'].includes(face.side) : face.side === side));
    near(selection.area, (await getQuote()).walls.find(w => w.id === diagonal.id).netArea);
  }
  await page.locator('#wall-finish-side').selectOption('left'); await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats()?.ready && window.planStudio.getViewMode() === '3d');
  const wallStats = await page.evaluate(() => window.planStudio.get3DStats());
  near(wallStats.selectedWallArea, (await getQuote()).walls.find(w => w.id === diagonal.id).netArea);
  assert.ok(wallStats.selectedWallSurfaces.every(surface => surface.side === 'left'));
  await page.screenshot({ path: join(artifacts, 'diagonal-left-face.png') });
  await page.locator('[data-view="2d"]').click();
  pass('二维及三维选择左/右墙面只高亮对应真实计价面，高亮面积与报价一致');
  // Create two independent rooms via the ordinary net-dimension controls.
  for (const [name, width, depth] of [['客厅', 4, 3], ['卧室', 3, 3]]) {
    await page.locator('#plan-controls [data-action="room-template"]').click();
    await page.locator('#room-name').fill(name); await page.locator('#room-width').fill(String(width)); await page.locator('#room-depth').fill(String(depth)); await page.locator('#room-template-form button[type="submit"]').click();
    await page.locator('[data-action="add-item"]').click(); await page.locator(`[data-pick-material="${name === '客厅' ? 'demo-tile' : 'demo-wood'}"]`).click();
    await page.locator('[data-item-field="unitPrice"]').fill('100'); await page.locator('[data-item-field="wasteRate"]').fill('0'); await page.locator('[data-item-field="laborRate"]').fill('0');
  }
  assert.equal((await getProject()).regions.length, 3); const floorArea = (await getQuote()).regions.reduce((sum, row) => sum + row.netArea, 0); near(floorArea, 25.86);
  pass('三个独立区域分别选材，面积合计正确');
  await page.locator('#left-panel [data-action="add-furniture"]').last().click(); await page.locator('[data-furniture-kind="sofa"]').click();
  assert.equal((await getProject()).furniture[0].unitPrice, ''); assert.equal((await getQuote()).furniture[0].pending, true);
  await page.locator('#furniture-name').fill('定制沙发'); await page.locator('#furniture-quantity').fill('2'); await page.locator('#furniture-unitPrice').fill('1234.56'); await page.locator('#furniture-additionalCost').fill('100');
  assert.equal((await getQuote()).furniture[0].total, '2569.12');
  await page.locator('#furniture-unitPrice').fill('1250.15'); assert.equal((await getQuote()).furniture[0].total, '2600.30');
  await page.locator('#furniture-unitPrice').fill('1234.56');
  pass('家具由用户手动添加并命名，自填数量和价格实时得到2569.12元，不预填虚构价');
  const f = (await getProject()).furniture[0], start = await screen(f.position);
  await page.mouse.move(start.x + 12, start.y + 12); await page.mouse.down(); await page.mouse.move(start.x + 42, start.y + 32, { steps: 6 }); await page.mouse.up();
  const moved = (await getProject()).furniture[0]; assert.notDeepEqual(moved.position, f.position);
  await page.locator('#undo').click(); assert.deepEqual((await getProject()).furniture[0].position, f.position); await page.locator('#redo').click(); assert.deepEqual((await getProject()).furniture[0].position, moved.position);
  await page.locator('#furniture-width').fill('240'); await page.locator('#furniture-depth').fill('100'); await page.locator('#furniture-height').fill('90'); await page.locator('[data-action="rotate-furniture"]').click(); assert.equal((await getProject()).furniture[0].rotation, 90);
  near((await getQuote()).regions.reduce((sum, row) => sum + row.netArea, 0), floorArea); assert.equal((await getQuote()).furniture[0].total, '2569.12');
  pass('家具拖动、尺寸编辑、旋转与撤销/重做可用，不扣地面面积或重复计费');
  // Escape restores a preview instead of persisting a half-completed move.
  const beforeEscape = (await getProject()).furniture[0].position, escStart = await screen(beforeEscape);
  await page.mouse.move(escStart.x, escStart.y); await page.mouse.down(); await page.mouse.move(escStart.x + 24, escStart.y + 16, { steps: 3 }); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual((await getProject()).furniture[0].position, beforeEscape);
  await page.mouse.move(escStart.x, escStart.y); await page.mouse.down(); await page.mouse.move(escStart.x + 30, escStart.y + 20, { steps: 3 }); await page.mouse.move(escStart.x, escStart.y, { steps: 3 }); await page.mouse.up();
  assert.deepEqual((await getProject()).furniture[0].position, beforeEscape);
  pass('Esc取消家具拖动恢复原位，不保存中间位置');
  await page.locator('#left-panel [data-action="select-furniture"]').click();
  await page.locator('#inspector [data-action="delete-furniture"]').click(); assert.equal((await getProject()).furniture.length, 0); await page.locator('#undo').click(); assert.equal((await getProject()).furniture.length, 1);
  pass('移除家具后可一次撤销完整恢复尺寸和价格');
  await page.locator('#left-panel [data-action="select-furniture"]').click(); await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.renderedFurnitureCount === 1);
  const stats = await page.evaluate(() => window.planStudio.get3DStats()); const size = stats.furniture[0].size;
  near(size.width, 2.4); near(size.depth, 1); near(size.height, .9); assert.equal(stats.selectedFurnitureId, f.id); assert.equal(stats.glError, 0);
  await page.screenshot({ path: join(artifacts, 'furniture-3d.png') }); await page.locator('[data-view="2d"]').click();
  pass('三维家具与输入实际宽深高一致，2D/3D选择和报价同步');
  await page.locator('#settings').click(); await page.locator('#settings-form [name="taxRate"]').fill('10'); await page.locator('#settings-form [type="submit"]').click();
  const finalQuote = await getQuote(); assert.equal(finalQuote.beforeTax, '5300.92'); assert.equal(finalQuote.tax, '530.09'); assert.equal(finalQuote.total, '5831.01');
  const saved = await getProject(); await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  await page.reload(); await page.waitForFunction(() => window.planStudio); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click(); await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id);
  assert.deepEqual((await getProject()).furniture, saved.furniture); assert.equal((await getQuote()).total, finalQuote.total); near((await getQuote()).regions.reduce((sum, row) => sum + row.netArea, 0), floorArea);
  pass('项目保存、刷新后重新打开，家具与税后总报价完整保留');
  await page.locator('#export').click(); const csvEvent = page.waitForEvent('download'); await page.locator('[data-export="csv"]').click(); const csvFile = await csvEvent; await csvFile.saveAs(join(artifacts, 'furniture-quote.csv'));
  const csv = await readFile(await csvFile.path(), 'utf8'); assert.match(csv, /定制沙发/); assert.match(csv, /2569\.12/); assert.match(csv, /5831\.01/);
  await page.locator('#export').click(); const jsonEvent = page.waitForEvent('download'); await page.locator('[data-export="json"]').click(); const jsonFile = await jsonEvent; const json = JSON.parse(await readFile(await jsonFile.path(), 'utf8')); assert.deepEqual(json.furniture, saved.furniture);
  pass('实际CSV与项目JSON导出包含家具、自填价格和正确合计');
  await page.locator('#export').click(); const popupEvent = page.waitForEvent('popup'); await page.locator('[data-export="pdf"]').click(); const popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
  assert.match(await popup.locator('body').innerText(), /定制沙发/); assert.match(await popup.locator('body').innerText(), /2569\.12/); assert.match(await popup.locator('body').innerText(), /5831\.01/);
  await popup.pdf({ path: join(artifacts, 'furniture-quote.pdf'), format: 'A4', printBackground: true }); await popup.close();
  pass('实际打印报价页包含家具明细与税后金额，可以生成PDF');
  await page.locator('#left-panel [data-action="select-furniture"]').click();
  for (const width of [1440, 1100]) { await page.setViewportSize({ width, height: 960 }); await page.locator('#fit').click(); await page.waitForTimeout(100); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false); await page.screenshot({ path: join(artifacts, `furniture-workspace-${width}.png`) }); }
  pass('1440及1100宽度布局无水平溢出，图纸和家具属性均可操作');
  // Independent fresh context verifies exact oblique length entry plus Shift.
  const angleContext = await browser.newContext({ viewport: { width: 1440, height: 960 } }); const anglePage = await angleContext.newPage(); await anglePage.goto(baseURL); await anglePage.waitForFunction(() => window.planStudio); await anglePage.locator('#draw-plan').click();
  await anglePage.locator('#wall-direction').selectOption('angle'); await anglePage.locator('#wall-angle').fill('45'); await anglePage.locator('#wall-length').fill('4'); await anglePage.locator('#wall-length-form [type="submit"]').click();
  const angled = await anglePage.evaluate(() => window.planStudio.getProject().walls[0]); near(Math.hypot(angled.end.x - angled.start.x, angled.end.y - angled.start.y), 400); near(angled.end.x - angled.start.x, angled.end.y - angled.start.y);
  const vp = await anglePage.evaluate(p => window.planStudio.toScreen(p), { x: angled.end.x + 200, y: angled.end.y + 70 }); const box = await anglePage.locator('#drawing-canvas').boundingBox(); await anglePage.keyboard.down('Shift'); await anglePage.mouse.click(box.x + vp.x, box.y + vp.y); await anglePage.keyboard.up('Shift');
  const constrained = await anglePage.evaluate(() => window.planStudio.getProject().walls[1]); assert.ok(constrained.start.x === constrained.end.x || constrained.start.y === constrained.end.y); await angleContext.close();
  pass('自定义45°方向按真实4m画斜墙，Shift保留简易正交绘制');
  const imageContext = await browser.newContext({ viewport: { width: 1440, height: 960 } }), imagePage = await imageContext.newPage(); imagePage.on('pageerror', error => errors.push(error.message)); await imagePage.goto(baseURL); await imagePage.waitForFunction(() => window.planStudio);
  const png = await imagePage.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 300); ctx.strokeStyle = '#555'; ctx.strokeRect(40, 40, 320, 220); return c.toDataURL('image/png').split(',')[1]; });
  await imagePage.locator('#drawing-file').setInputFiles({ name: '家具底图.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await imagePage.waitForFunction(() => window.planStudio.getProject().drawing?.type !== 'plan' && window.planStudio.getProject().drawing?.width === 400);
  await imagePage.locator('#left-panel [data-action="add-furniture"]').last().click(); await imagePage.locator('[data-furniture-kind="custom"]').click();
  assert.equal(await imagePage.evaluate(() => window.planStudio.getProject().calibration.metersPerPixel), null);
  await imagePage.locator('#furniture-quantity').fill('3'); await imagePage.locator('#furniture-unitPrice').fill('100'); await imagePage.locator('#furniture-additionalCost').fill('20');
  assert.equal(await imagePage.evaluate(() => window.planStudio.getQuote().total), '320.00');
  await imagePage.locator('#calibration').click(); await imagePage.locator('[data-calibration="width"]').click(); await imagePage.locator('#number-value').fill('0.1'); await imagePage.locator('#number-form button').click();
  const imageFurniture = await imagePage.evaluate(() => window.planStudio.getProject().furniture[0]); const p = await imagePage.evaluate(point => window.planStudio.toScreen(point), imageFurniture.position), imageBox = await imagePage.locator('#drawing-canvas').boundingBox();
  await imagePage.mouse.move(imageBox.x + p.x, imageBox.y + p.y); await imagePage.mouse.down(); await imagePage.mouse.move(imageBox.x + p.x + 20, imageBox.y + p.y + 15); await imagePage.mouse.up();
  assert.equal(await imagePage.evaluate(() => window.planStudio.getQuote().total), '320.00');
  await imagePage.locator('#furniture-width').fill('5'); await imagePage.locator('#furniture-depth').fill('5'); assert.equal(await imagePage.evaluate(() => window.planStudio.getProject().furniture[0].width), 5); await imageContext.close();
  pass('上传底图未校准时家具仍可按件报价，校准后超图幅家具可编辑且不会触发页面异常');
  assert.deepEqual(errors, []); pass('新业务流程无浏览器运行时错误');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks, reports, finalQuote }, null, 2)); process.stdout.write(`\n${checks} 项家具与斜墙浏览器验收通过。\n`);
} catch (error) { await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); if (page) process.stderr.write(JSON.stringify(await page.evaluate(() => { const project = window.planStudio?.getProject(), quote = window.planStudio?.getQuote(); return { toast: document.querySelector('#toast')?.textContent, selection: window.planStudio?.getSelection(), furniture: project?.furniture, quote: quote && { pending: quote.pending, pendingReason: quote.pendingReason, furniture: quote.furniture, total: quote.total } }; }).catch(() => ({})), null, 2) + '\n'); throw error; }
finally { await browser?.close(); server.kill(); }
