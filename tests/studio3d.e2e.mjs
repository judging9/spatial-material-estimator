import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Real application, installed browser, isolated DB and IndexedDB. This test
// drives user controls; test hooks only observe geometry, quotes, and cameras.
const testRoot = await mkdtemp(join(tmpdir(), 'plan-studio-3d-'));
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
  server.stdout.on('data', chunk => {
    const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { clearTimeout(timer); accept(match[0]); }
  });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
});
const executablePath = process.env.CHROME_PATH || [
  'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
let browser;
let page;
let checks = 0;
const reports = [];
const passed = name => { checks++; reports.push(name); process.stdout.write(`✓ ${name}\n`); };
const approximately = (value, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(value) - expected) < tolerance, `${value} ≠ ${expected}`);
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio);
  await page.locator('#draw-plan').click();
  await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  await page.locator('#wall-done').click();
  const getProject = () => page.evaluate(() => window.planStudio.getProject());
  // No wall finishes are selected in this regression; inspect unchanged floor quantities and financial totals separately from height-dependent wall measurements.
  const getQuote = () => page.evaluate(() => { const {walls,...quote}=window.planStudio.getQuote(); return quote; });
  const getStats = () => page.evaluate(() => window.planStudio.get3DStats());
  const show3D = async () => {
    await page.locator('[data-view="3d"]').click();
    await page.waitForFunction(() => window.planStudio.getViewMode() === '3d' && window.planStudio.get3DStats()?.ready);
    await page.waitForTimeout(120);
  };
  const quickRoom = async (name, width, depth, height = 2.8, thickness = 20) => {
    await page.locator('#inspector [data-action="room-template"]').click();
    await page.locator('#room-name').fill(name);
    await page.locator('#room-width').fill(String(width));
    await page.locator('#room-depth').fill(String(depth));
    await page.locator('#room-height').fill(String(height));
    await page.locator('#room-thickness').fill(String(thickness));
    await page.locator('#room-template-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
  };
  // Real rooms constructed through the net-dimension helper, with no fixtures
  // injected into application state.
  await quickRoom('客厅', 4, 3);
  const firstId = (await getProject()).regions[0].id;
  await page.locator('[data-action="add-item"]').click();
  await page.locator('[data-pick-material="demo-wood"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('100');
  await page.locator('[data-item-field="wasteRate"]').fill('10');
  await page.locator('[data-item-field="laborRate"]').fill('20');
  approximately((await getQuote()).regions[0].netArea, 12);
  assert.equal((await getQuote()).regions[0].total, '1560.00');
  passed('输入净宽4m、净深3m、墙高2.8m、墙厚20cm生成真实墙体与12m²地面');

  await show3D();
  let stats = await getStats();
  assert.equal(stats.wallCount, 4);
  assert.equal(stats.floorCount, 1);
  assert.equal(stats.glError, 0);
  assert.ok(stats.triangles > 12);
  assert.equal(await page.locator('#drawing-canvas').isVisible(), false);
  assert.equal(await page.locator('#viewer3d canvas').isVisible(), true);
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#viewer3d canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const colors = new Set();
    const pixel = new Uint8Array(4);
    for (let x = .15; x < .9; x += .06) for (let y = .15; y < .9; y += .06) {
      gl.readPixels(Math.floor(canvas.width*x), Math.floor(canvas.height*y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      colors.add(Array.from(pixel).join(','));
    }
    return { colors: colors.size, error: gl.getError() };
  });
  assert.ok(pixels.colors > 5, '3D WebGL画面应实际包含墙、地面与光照颜色');
  assert.equal(pixels.error, 0);
  await page.screenshot({ path: join(artifacts, '3d-room.png') });
  passed('3D使用实际WebGL渲染墙体和地面，读取帧缓冲验证非空画面');

  const click3D = async point => {
    const screen = await page.evaluate(p => window.planStudio.toScreen3D(p), point);
    assert.ok(screen?.visible, '测试的三维点应在相机内');
    const box = await page.locator('#viewer3d').boundingBox();
    await page.mouse.click(box.x + screen.x, box.y + screen.y);
  };
  let project = await getProject();
  const wall = project.walls[0];
  const wallPoint = { x: (wall.start.x + wall.end.x) / 200, y: 2.79, z: (wall.start.y + wall.end.y) / 200 };
  await click3D(wallPoint);
  await page.waitForSelector('#wall-edit-form');
  const chosenId = (await getStats()).wallHeights.find(w => w.id === wall.id)?.id;
  assert.equal(chosenId, wall.id);
  assert.equal(await page.locator('#wall-edit-height').inputValue(), '2.8');
  const originalQuote = await getQuote();
  await page.locator('#wall-edit-height').fill('3.6');
  await page.locator('#wall-edit-form button[type="submit"]').click();
  project = await getProject();
  assert.equal(project.walls.find(w => w.id === wall.id).height, 360);
  stats = await getStats();
  approximately(stats.wallHeights.find(w => w.id === wall.id).height, 3.6);
  approximately(stats.bounds.max.y, 3.6);
  assert.deepEqual(await getQuote(), originalQuote);
  await page.locator('#undo').click();
  approximately((await getStats()).wallHeights.find(w => w.id === wall.id).height, 2.8);
  await page.locator('#redo').click();
  approximately((await getStats()).wallHeights.find(w => w.id === wall.id).height, 3.6);
  passed('点击真实三维墙体可编辑单墙高度；网格、边界、撤销重做同步且报价不变');

  await page.locator('#cutaway').click();
  assert.equal((await getStats()).cutaway, true);
  assert.ok((await getStats()).wallHeights.every(w => w.displayedHeight < w.height));
  assert.equal((await getProject()).walls.find(w => w.id === wall.id).height, 360);
  assert.deepEqual(await getQuote(), originalQuote);
  await page.waitForFunction(() => window.planStudio.get3DStats().visibleLabelCount === 1);
  assert.match(await page.locator('.scene-room-label').innerText(), /客厅/);
  assert.match(await page.locator('.scene-room-label').innerText(), /12\.00/);
  await page.locator('[data-action="toggle-labels"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats().visibleLabelCount === 0);
  await page.locator('[data-action="toggle-labels"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats().visibleLabelCount === 1);
  await page.locator('#cutaway').click();
  await page.waitForFunction(() => window.planStudio.get3DStats().visibleLabelCount === 0);
  await page.locator('#cutaway').click();
  await page.waitForFunction(() => window.planStudio.get3DStats().visibleLabelCount === 1);
  const region = (await getProject()).regions[0];
  const center = region.points.reduce((p, v) => ({ x: p.x + v.x / region.points.length / 100, z: p.z + v.y / region.points.length / 100 }), { x: 0, z: 0 });
  await click3D({ ...center, y: 0 });
  await page.waitForSelector('[data-action="choose-material"]');
  await page.locator('[data-action="choose-material"]').click();
  await page.locator('[data-pick-material="demo-tile"]').click();
  assert.equal((await getProject()).regions[0].items[0].materialId, 'demo-tile');
  assert.equal((await getStats()).floorCount, 1);
  assert.ok((await getStats()).texturedFloorCount > 0);
  passed('低墙查看和真实面积标签只改变显示；名称开关生效，三维点击地面可换材料');

  const cameraBefore = (await getStats()).camera;
  const quoteBeforeCamera = await getQuote();
  const box = await page.locator('#viewer3d').boundingBox();
  await page.mouse.move(box.x + box.width*.6, box.y + box.height*.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width*.6 + 80, box.y + box.height*.55 + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  let camera = (await getStats()).camera;
  assert.notEqual(camera.yaw, cameraBefore.yaw);
  const beforePan = camera.target;
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width*.6 + 120, box.y + box.height*.55 + 65, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(100);
  assert.notDeepEqual((await getStats()).camera.target, beforePan);
  const beforeZoom = (await getStats()).camera.distance;
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(100);
  assert.ok((await getStats()).camera.distance < beforeZoom);
  assert.deepEqual(await getQuote(), quoteBeforeCamera);
  passed('拖动旋转、右键平移和滚轮缩放改变相机，保留真实面积与报价');

  await page.locator('[data-view="2d"]').click();
  await page.locator('[data-tool="select"]').click();
  // Clear selection by clicking empty plan so the short room guide appears.
  const screen = await page.evaluate(() => window.planStudio.toScreen({ x: 1500, y: 1300 }));
  const canvasBox = await page.locator('#drawing-canvas').boundingBox();
  await page.mouse.click(canvasBox.x + screen.x, canvasBox.y + screen.y);
  // A fit can put a distant test point outside the stage; deselect using the
  // middle of a blank canvas location as a fallback.
  if (!await page.locator('#inspector [data-action="room-template"]').count()) {
    await page.mouse.click(canvasBox.x + canvasBox.width*.9, canvasBox.y + canvasBox.height*.75);
  }
  await quickRoom('卧室', 3, 3);
  await page.locator('[data-action="add-item"]').click();
  await page.locator('[data-pick-material="demo-wood"]').click();
  await page.mouse.click(canvasBox.x + canvasBox.width*.9, canvasBox.y + canvasBox.height*.75);
  await quickRoom('厨房', 2, 2);
  await page.locator('[data-action="add-item"]').click();
  await page.locator('[data-pick-material="demo-stone"]').click();
  assert.equal((await getProject()).regions.length, 3);
  await show3D();
  assert.equal((await getStats()).floorCount, 3);
  assert.equal((await getStats()).wallCount, 12);
  passed('三个独立真实房间可在2D编辑并即时生成三维墙体和各自材料地面');

  const bulk = async (height, thickness, apply = true) => {
    await page.locator('#wall-defaults').click();
    await page.locator('#default-wall-height').fill(String(height));
    await page.locator('#default-wall-thickness').fill(String(thickness));
    await page.locator('#apply-wall-dimensions').setChecked(apply);
    const inputBox = await page.locator('#apply-wall-dimensions').boundingBox();
    assert.ok(inputBox.width < 25 && inputBox.height < 25, '墙体设置的复选框应紧凑');
    await page.locator('#wall-defaults-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
  };
  let beforeBulk = await getQuote();
  await bulk(3.2, 20);
  assert.ok((await getProject()).walls.every(w => w.height === 320));
  assert.ok((await getStats()).wallHeights.every(w => Math.abs(w.height - 3.2) < 1e-6));
  assert.deepEqual(await getQuote(), beforeBulk);
  await bulk(3.2, 30);
  let q = await getQuote();
  q.regions.map(r => r.netArea).sort((a,b)=>a-b).forEach((area, i) => approximately(area, [3.61,8.41,11.31][i]));
  assert.notEqual(q.total, beforeBulk.total);
  assert.ok((await getStats()).wallHeights.every(w => Math.abs(w.thickness - .3) < 1e-6));
  await page.locator('#undo').click();
  assert.deepEqual(await getQuote(), beforeBulk);
  await page.locator('#redo').click();
  assert.deepEqual(await getQuote(), q);
  const actualWalls = (await getProject()).walls;
  await bulk(4, 25, false);
  assert.deepEqual((await getProject()).walls, actualWalls);
  assert.deepEqual(await getQuote(), q);
  assert.equal((await getProject()).wallHeight, 400);
  passed('统一墙高保持报价；墙厚重算11.31/8.41/3.61m²；仅设置新墙默认值保留现有墙体');

  const viewDownload = page.waitForEvent('download');
  await page.locator('#capture-3d').click();
  const pngDownload = await viewDownload;
  const pngPath = join(artifacts, '3d-export.png');
  await pngDownload.saveAs(pngPath);
  const png = await readFile(pngPath);
  assert.deepEqual(Array.from(png.subarray(0,8)), [137,80,78,71,13,10,26,10]);
  assert.ok(png.length > 10000);
  passed('保存三维视图导出真实PNG图像');

  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const stored = await getProject();
  const storedQuote = await getQuote();
  await page.reload();
  await page.waitForFunction(() => window.planStudio);
  await page.locator('#open-project').click();
  await page.locator(`[data-open-project="${stored.id}"]`).click();
  assert.deepEqual((await getProject()).walls, stored.walls);
  assert.equal((await getProject()).wallHeight, 400);
  assert.deepEqual(await getQuote(), storedQuote);
  await show3D();
  assert.equal((await getStats()).floorCount, 3);
  assert.ok((await getStats()).wallHeights.every(w => Math.abs(w.height-3.2)<1e-6));
  const projectDownload = page.waitForEvent('download');
  await page.locator('#export').click();
  await page.locator('[data-export="json"]').click();
  const downloaded = await projectDownload;
  const exportPath = join(artifacts, '3d-project.json');
  await downloaded.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.deepEqual(exported.walls, stored.walls);
  await page.locator('#project-file').setInputFiles(exportPath);
  await page.waitForFunction(() => window.planStudio.getViewMode() === '2d');
  assert.deepEqual((await getProject()).walls, stored.walls);
  assert.deepEqual(await getQuote(), storedQuote);
  await show3D();
  passed('墙高、墙厚、默认值、地面材料与报价保存重载及完整JSON导出导入一致');

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.locator('#fit').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifacts, '3d-workspace-1100.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const stageBox = await page.locator('#stage').boundingBox();
  for (const selector of ['#view-switch', '#wall-defaults', '#three-tools']) {
    const control = await page.locator(selector).boundingBox();
    assert.ok(control.x >= stageBox.x && control.x + control.width <= stageBox.x + stageBox.width, `${selector}溢出画布`);
  }
  assert.ok((await getStats()).viewport.width > 0);
  passed('1100×800窗口中三维画布、模式切换与墙体工具无溢出');

  const holes = await context.newPage();
  holes.on('pageerror', error => errors.push(error.message));
  holes.on('dialog', dialog => dialog.accept());
  await holes.goto(baseURL);
  await holes.waitForFunction(() => window.planStudio);
  await holes.locator('#draw-plan').click();
  await holes.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  await holes.locator('#wall-done').click();
  const rectangle = async (start, end) => {
    await holes.locator('[data-tool="rectangle"]').click();
    const points = await holes.evaluate(([a,b]) => [window.planStudio.toScreen(a), window.planStudio.toScreen(b)], [start, end]);
    const rect = await holes.locator('#drawing-canvas').boundingBox();
    await holes.mouse.move(rect.x + points[0].x, rect.y + points[0].y);
    await holes.mouse.down();
    await holes.mouse.move(rect.x + points[1].x, rect.y + points[1].y, { steps: 8 });
    await holes.mouse.up();
  };
  await rectangle({ x:200, y:200 }, { x:800, y:800 });
  // Inner walls are drawn as a wall chain; the quick rectangle helper prevents
  // creating overlapping rooms before topology has made the internal hole.
  await holes.locator('[data-tool="wall"]').click();
  for (const point of [{x:400,y:400},{x:600,y:400},{x:600,y:600},{x:400,y:600},{x:400,y:400}]) {
    const screen = await holes.evaluate(p => window.planStudio.toScreen(p), point);
    const rect = await holes.locator('#drawing-canvas').boundingBox();
    await holes.mouse.click(rect.x + screen.x, rect.y + screen.y);
  }
  await holes.locator('#wall-done').click();
  const rings = await holes.evaluate(() => window.planStudio.getProject().regions);
  assert.equal(rings.length, 2);
  const outer = rings.find(r => r.holes.length === 1);
  const inner = rings.find(r => r.holes.length === 0);
  assert.ok(outer && inner);
  await holes.locator(`[data-action="select-region"][data-id="${outer.id}"]`).click();
  await holes.locator('[data-action="add-item"]').click();
  await holes.locator('[data-pick-material="demo-wood"]').click();
  await holes.locator(`[data-action="toggle-region"][data-id="${inner.id}"]`).click({ force: true });
  await holes.locator('[data-view="3d"]').click();
  await holes.waitForFunction(() => window.planStudio.getViewMode() === '3d' && window.planStudio.get3DStats()?.ready);
  await holes.locator('#cutaway').click();
  await holes.waitForTimeout(150);
  assert.equal(await holes.evaluate(() => window.planStudio.get3DStats().holeCount), 1);
  assert.equal(await holes.evaluate(() => window.planStudio.get3DStats().floorCount), 1);
  const holePoint = await holes.evaluate(() => window.planStudio.toScreen3D({ x:5, y:.012, z:5 }));
  const floorPoint = await holes.evaluate(() => window.planStudio.toScreen3D({ x:3, y:.012, z:5 }));
  const holePixels = await holes.evaluate(([holePoint,floorPoint]) => {
    const canvas = document.querySelector('#viewer3d canvas'), gl = canvas.getContext('webgl');
    const read = point => {
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(point.x*canvas.width/canvas.clientWidth), Math.floor(canvas.height-point.y*canvas.height/canvas.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    };
    return { hole: read(holePoint), floor: read(floorPoint), error: gl.getError() };
  }, [holePoint, floorPoint]);
  assert.ok(holePixels.hole.slice(0,3).every(v => v > 220), '孔洞中心应显示浅色背景地面');
  assert.notDeepEqual(holePixels.hole, holePixels.floor, '内部孔洞不得铺满材料');
  const holeBox = await holes.locator('#viewer3d').boundingBox();
  await holes.mouse.click(holeBox.x + holePoint.x, holeBox.y + holePoint.y);
  assert.equal(await holes.locator('[data-action="choose-material"]').count(), 0, '孔洞中不能选中外部材料地面');
  assert.equal(holePixels.error, 0);
  await holes.screenshot({ path: join(artifacts, '3d-floor-hole.png') });
  await holes.close();
  passed('真实内圈墙生成地面孔洞；隐藏内地面后孔洞透明，点击不会误选外围材料');

  // Context loss is a real browser event. Switching to 2D must remain possible
  // with unchanged project/quote, rather than losing unsaved work.
  const beforeLoss = await getProject();
  const quoteBeforeLoss = await getQuote();
  const lost = await page.evaluate(() => {
    const canvas = document.querySelector('#viewer3d canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    window.validationRestore3D = () => extension.restoreContext();
    extension.loseContext();
    return true;
  });
  assert.equal(lost, true);
  await page.waitForTimeout(200);
  assert.equal((await getStats()).ready, false);
  await page.locator('[data-view="2d"]').click();
  assert.equal(await page.locator('#drawing-canvas').isVisible(), true);
  assert.deepEqual((await getProject()).walls, beforeLoss.walls);
  assert.deepEqual(await getQuote(), quoteBeforeLoss);
  passed('WebGL上下文丢失后仍可返回2D，工程尺寸与报价完整保留');
  await page.evaluate(() => window.validationRestore3D());
  await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  await show3D();
  assert.equal((await getStats()).glError, 0);
  assert.equal((await getStats()).floorCount, 3);
  assert.deepEqual(await getQuote(), quoteBeforeLoss);
  passed('WebGL上下文恢复后自动重建三维网格，保留材料贴图与工程报价');
  assert.deepEqual(errors, []);
  passed('三维完整业务流程没有浏览器运行时错误');
  await writeFile(join(artifacts, '3d-validation.json'), JSON.stringify({ checks, reports, finalStats: stats, pixels }, null, 2));
  process.stdout.write(`\n${checks} 项三维浏览器验收通过。截图与导出：${artifacts}\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, '3d-failure.png') }).catch(() => {});
  if (page) process.stderr.write(JSON.stringify(await page.evaluate(() => ({ stats: window.planStudio?.get3DStats(), view: window.planStudio?.getViewMode(), toast: document.querySelector('#toast')?.textContent })).catch(() => ({})), null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
