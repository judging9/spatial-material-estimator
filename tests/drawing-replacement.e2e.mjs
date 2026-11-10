import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Construct the original design with real UI actions. Test hooks only read
// state or transform coordinates, and the uploaded PNG is a real canvas image.
const storage = await mkdtemp(join(tmpdir(), 'studio-drawing-replacement-'));
const artifacts = resolve('artifacts/drawing-replacement');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '', browser, page, confirmPolicy = 'accept';
server.stderr.on('data', chunk => serverErrors += chunk);
const reports = [], runtimeErrors = [], dialogs = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected}`);
const designFields = ['regions', 'walls', 'wallShapes', 'openings', 'floorOpenings', 'furniture', 'serviceRoutes', 'civilElements', 'levels', 'activeLevelId', 'planBoundary', 'wallRegionCache', 'planError', 'calibration'];
const design = project => Object.fromEntries(designFields.map(key => [key, project[key]]));
const emptyDesign = project => {
  for (const key of ['regions', 'walls', 'wallShapes', 'openings', 'floorOpenings', 'furniture', 'serviceRoutes', 'civilElements', 'wallRegionCache']) assert.deepEqual(project[key], [], `old ${key} must be cleared`);
  assert.equal(project.levels, undefined); assert.equal(project.activeLevelId, undefined); assert.equal(project.planBoundary, null); assert.equal(project.planError, null); assert.equal(project.calibration.metersPerPixel, null);
};
const emptyQuote = quote => {
  for (const key of ['regions', 'walls', 'furniture', 'ceilings', 'serviceRoutes', 'civilElements']) assert.equal(quote[key]?.length ?? 0, 0, `old quote ${key} must be absent`);
  if (quote.levelSummaries) { assert.ok(quote.levelSummaries.length <= 1, 'inactive old storeys must be absent'); for (const layer of quote.levelSummaries) { assert.equal(layer.knownSubtotal, '0.00'); if (layer.netVolume !== undefined) assert.equal(layer.netVolume, 0); } }
  assert.equal(quote.knownSubtotal, '0.00'); assert.equal(quote.total, '0.00');
  if (quote.netVolume !== undefined) assert.equal(quote.netVolume, 0);
};

try {
  const url = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(serverErrors || 'Test server timeout')), 20000); server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); }); });
  const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message(), policy: confirmPolicy }); if (confirmPolicy === 'dismiss' && dialog.type() === 'confirm') await dialog.dismiss(); else await dialog.accept(); });
  const project = () => page.evaluate(() => window.planStudio.getProject()), quote = () => page.evaluate(() => window.planStudio.getQuote());
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const click = async point => { const screen = await page.evaluate(point => window.planStudio.toScreen(point), point), bounds = await page.locator('#drawing-canvas').boundingBox(); await page.mouse.click(bounds.x + screen.x, bounds.y + screen.y); await frame(); };
  const save = async () => { await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机'); };
  await page.goto(url); await page.waitForFunction(() => window.planStudio?.getCivilElements);
  await page.locator('#draw-plan').click(); await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  if (await page.locator('#wall-done').isVisible()) await page.locator('#wall-done').click();
  await page.locator('#project-name').fill('图纸替换与土建预算回归');
  await page.locator('#plan-controls [data-action="room-template"]').click();
  for (const [key, value] of Object.entries({ name: '原两层设计', width: 6, depth: 4, height: 2.8, thickness: 20 })) await page.locator(`#room-${key}`).fill(String(value));
  await page.locator('#room-template-form [type="submit"]').click(); await page.waitForFunction(() => window.planStudio.getProject().regions.length === 1);
  const room = (await project()).regions[0], minX = Math.min(...room.points.map(point => point.x)), minY = Math.min(...room.points.map(point => point.y));
  const point = (x, y) => ({ x: minX + x, y: minY + y });
  await page.locator('[data-action="add-item"]').click(); await page.locator('[data-pick-material="demo-wood"]').click();
  for (const key of ['unitPrice', 'wasteRate', 'laborRate', 'additionalCost']) await page.locator(`[data-item-field="${key}"]`).fill('0');
  await page.locator('[data-action="floor-hole-dimensions"]').click(); await page.locator('#floor-opening-form [name="shape"]').selectOption('rectangle');
  for (const [key, value] of Object.entries({ width: 1, depth: 1, x: (minX + 400) / 100, y: (minY + 250) / 100 })) await page.locator(`#floor-opening-form [name="${key}"]`).fill(String(value));
  await page.locator('#floor-opening-form [type="submit"]').click(); await page.waitForFunction(() => window.planStudio.getProject().floorOpenings?.length === 1);
  const wallsDetails = page.locator('.walls-section details'); if (await wallsDetails.getAttribute('open') === null) await page.locator('.walls-section summary').click();
  const hostWall = (await project()).walls.find(wall => Math.abs(wall.start.y - wall.end.y) < 1e-7 && Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) > 600);
  assert.ok(hostWall); await page.locator(`#left-panel [data-action="select-wall"][data-id="${hostWall.id}"]`).click(); await page.locator('[data-action="add-opening"][data-kind="door"]').click();
  for (const [key, value] of Object.entries({ width: .8, height: 2, offset: 1, bottom: .2, depth: 4 })) await page.locator(`#opening-form [name="${key}"]`).fill(String(value));
  await page.locator('#opening-form [type="submit"]').click(); await page.locator('#opening-form').waitFor({ state: 'hidden' });
  await page.locator('#enter-decoration').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'decoration');
  await page.locator('[data-decoration-category="all"]').click(); await page.locator('[data-place-furniture="chair"]').click(); await click(point(200, 100));
  await page.waitForFunction(() => window.planStudio.getProject().furniture?.length === 1); await page.locator('#furniture-unitPrice').fill('123.45');
  await page.locator('[data-decoration-tab="services"]').click(); await page.locator('[data-draw-service="custom-line"]').click(); await click(point(100, 300)); await click(point(300, 300)); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.planStudio.getProject().serviceRoutes?.length === 1); await page.locator('#service-unitPrice').fill('8.5');
  await page.locator('#enter-civil').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'civil');
  const placeCivil = async (kind, at) => { const count = (await project()).civilElements?.length ?? 0; await page.locator('[data-civil-category="all"]').click(); await page.locator(`[data-place-civil="${kind}"]`).click(); await click(at); await page.waitForFunction(count => (window.planStudio.getProject().civilElements?.length ?? 0) > count, count); await page.locator('#civil-unitPrice').fill('100'); await frame(); return (await project()).civilElements.at(-1); };
  const column = await placeCivil('column', point(100, 100)), slab = await placeCivil('slab', point(300, 150));
  assert.equal(slab.sourceRegionId, room.id); near((await quote()).netVolume, 3.906); assert.equal((await quote()).total, '390.60');
  await page.locator('[data-action="manage-levels"]').click(); await page.locator('#level-add-form [name="name"]').fill('二楼完整设计'); await page.locator('#level-add-form [name="copyLayout"]').selectOption('true'); await page.locator('#level-add-form [type="submit"]').click();
  await page.waitForFunction(() => window.planStudio.getProject().levels?.length === 2); await frame(); assert.equal((await quote()).total, '781.20');
  const original = await project(), originalQuote = await quote();
  for (const key of ['walls', 'openings', 'furniture', 'serviceRoutes', 'civilElements', 'floorOpenings']) assert.ok(original[key].length > 0, `fixture must contain ${key}`);
  assert.ok(original.levels[0].content.civilElements.length === 2); assert.notEqual(original.civilElements[0].id, original.levels[0].content.civilElements[0].id);
  await save(); await page.screenshot({ path: join(artifacts, 'original-two-level-design.png') });
  pass('真实UI创建房间、墙门、楼板洞、家具与管线，放置关联楼板和柱，复制二楼，土建净量7.812m³与自填预算781.20元');

  const png = await page.locator('#drawing-canvas').screenshot(), file = { name: '替换平面图.png', mimeType: 'image/png', buffer: png };
  await writeFile(join(artifacts, 'replacement-plan.png'), png);
  confirmPolicy = 'dismiss'; let dialogEvent = page.waitForEvent('dialog'); await page.locator('#drawing-file').setInputFiles(file); const cancelledDialog = await dialogEvent; assert.equal(cancelledDialog.type(), 'confirm'); await frame();
  assert.deepEqual(design(await project()), design(original)); assert.equal((await quote()).total, originalQuote.total);
  pass('取消图纸替换确认后，所有楼层设计与781.20元真实报价保持原样');

  confirmPolicy = 'accept'; dialogEvent = page.waitForEvent('dialog'); await page.locator('#drawing-file').setInputFiles(file); const acceptedDialog = await dialogEvent; assert.equal(acceptedDialog.type(), 'confirm');
  await page.waitForFunction(oldId => window.planStudio.getProject().drawing?.id !== oldId && document.querySelector('#upload-loading').hidden, original.drawing.id); await frame();
  const replaced = await project(); assert.equal(replaced.drawing.type, 'png'); assert.equal(replaced.drawing.name, file.name); emptyDesign(replaced); emptyQuote(await quote());
  const selection = await page.evaluate(() => window.planStudio.getSelection()); assert.ok(Object.values(selection).every(value => value === null));
  await page.screenshot({ path: join(artifacts, 'replaced-clean-design.png') });
  pass('确认上传真实PNG后，所有civil/墙体/开口/家具/管线/楼层/洞口与选择清空，旧土建报价无残留且新图待校准');

  await page.locator('#undo').click(); await frame(); const undone = await project(); assert.deepEqual(design(undone), design(original)); assert.equal(undone.drawing.id, original.drawing.id); assert.equal(undone.drawing.type, 'plan');
  assert.equal((await quote()).kind, 'civil'); assert.equal((await quote()).total, originalQuote.total); assert.deepEqual((await quote()).civilElements, originalQuote.civilElements);
  assert.equal(undone.civilElements.find(element => element.sourceRegionId)?.sourceRegionId, original.civilElements.find(element => element.sourceRegionId)?.sourceRegionId); assert.ok(undone.levels[0].content.civilElements.some(element => element.id === column.id));
  pass('单次Undo恢复两层完整设计、关联洞与独立构件编号，实时土建预算准确恢复781.20元');
  await page.locator('#redo').click(); await frame(); const redone = await project(); emptyDesign(redone); emptyQuote(await quote()); assert.equal(redone.drawing.id, replaced.drawing.id);
  pass('单次Redo重新应用图纸替换，未带回任何旧土建或其他设计');

  await save(); await page.reload(); await page.waitForFunction(() => window.planStudio?.getCivilElements); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${redone.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().drawing?.id === id, redone.drawing.id); emptyDesign(await project()); emptyQuote(await quote());
  pass('替换后的项目可保存、刷新并从本机重开，全部设计仍清空且无旧报价');
  await page.locator('#export').click(); const downloadEvent = page.waitForEvent('download'); await page.locator('[data-export="json"]').click(); const download = await downloadEvent; const exportedPath = join(artifacts, 'replacement-project.json'); await download.saveAs(exportedPath);
  const exported = JSON.parse(await readFile(exportedPath, 'utf8')); emptyDesign(exported); assert.equal(exported.drawing.id, replaced.drawing.id); assert.ok(exported.drawing.url.startsWith('data:image/')); if (exported.quoteSummary) assert.equal(exported.quoteSummary.total, '0.00');
  await page.locator('#open-project').click(); await page.locator('[data-action="import-project"]').click(); await page.locator('#project-file').setInputFiles(exportedPath);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('完整项目已导入')); emptyDesign(await project()); emptyQuote(await quote());
  pass('真实JSON导出自带新PNG，保存总价0且无旧构件；重新导入后项目和报价均保持清洁');
  assert.deepEqual(runtimeErrors, []); pass('确认、替换、撤销重做、保存和JSON迁移全过程无浏览器运行时错误');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, runtimeErrors, dialogs, originalQuote, replacementDrawing: (await project()).drawing, finalQuote: await quote() }, null, 2));
  process.stdout.write(`\n${reports.length} 项图纸替换与土建回归验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  const state = await page?.evaluate(() => ({ project: window.planStudio?.getProject(), quote: window.planStudio?.getQuote(), selection: window.planStudio?.getSelection(), toast: document.querySelector('#toast')?.textContent })).catch(() => ({}));
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), state, reports, runtimeErrors, dialogs }, null, 2));
  throw error;
} finally { await browser?.close(); server.kill(); }
