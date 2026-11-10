import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Exercise the real app through its controls. planStudio is only read for
// assertions and coordinate conversion; no project or hook mutation is used.
const testRoot = await mkdtemp(join(tmpdir(), 'studio-decoration-'));
const artifacts = resolve('artifacts/decoration');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErrors = '';
server.stderr.on('data', chunk => serverErrors += chunk);
let browser, page;
const reports = [], runtimeErrors = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected}`);
const csvRows = source => {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let index = source.charCodeAt(0) === 0xfeff ? 1 : 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false, 'CSV quoting must close');
  return rows;
};

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Test server timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
  });
  const executablePath = process.env.CHROME_PATH || [
    'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const getProject = () => page.evaluate(() => window.planStudio.getProject());
  const getQuote = () => page.evaluate(() => window.planStudio.getQuote());
  const getMode = () => page.evaluate(() => window.planStudio.getWorkspaceMode());
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const screen = async point => {
    const location = await page.evaluate(point => window.planStudio.toScreen(point), point);
    const box = await page.locator('#drawing-canvas').boundingBox();
    assert.ok(box, 'Actual drawing canvas must be visible');
    return { x: box.x + location.x, y: box.y + location.y };
  };
  const clickWorld = async point => { const location = await screen(point); await page.mouse.click(location.x, location.y); };
  const enterDecoration = async () => {
    await page.locator('#enter-decoration').click();
    await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'decoration');
    assert.equal(await page.evaluate(() => window.planStudio.getViewMode()), '2d');
  };
  const returnPlan = async () => {
    await page.locator('#return-plan').click();
    await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'plan');
  };
  const selectWall = async id => {
    const disclosure = page.locator('.walls-section details');
    if (await disclosure.count() && await disclosure.evaluate(element => !element.open)) await disclosure.locator('summary').click();
    await page.locator(`#left-panel [data-action="select-wall"][data-id="${id}"]`).click();
  };

  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio?.getWorkspaceMode);
  assert.equal(await getMode(), 'plan');
  assert.equal(await page.locator('#enter-decoration').isDisabled(), true);
  await page.locator('#draw-plan').click();
  await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan');
  assert.equal(await page.locator('#enter-decoration').isDisabled(), true);
  pass('空项目与未闭合平面禁用进入装修，阶段入口有明确准备条件');

  await page.locator('#plan-controls [data-action="room-template"]').click();
  for (const [selector, value] of [['#room-name', '装修验收房间'], ['#room-width', '6'], ['#room-depth', '4'], ['#room-height', '2.8'], ['#room-thickness', '20']]) await page.locator(selector).fill(value);
  await page.locator('#room-template-form [type="submit"]').click();
  await page.waitForFunction(() => window.planStudio.getProject().regions.length === 1);
  const initial = await getProject(), room = initial.regions[0];
  assert.equal(initial.planError, null);
  near((await getQuote()).regions[0].netArea, 24);
  // A rectangular wall ring has inner perimeter 20m, outer perimeter 21.6m.
  // Only its exposed left/right faces count; tops, ends and reveals do not.
  near((await getQuote()).walls.reduce((sum, wall) => sum + wall.netArea, 0), (20 + 21.6) * 2.8);
  pass('6×4m净房间面积24m²，双侧裸露墙面116.48m²，端面和顶底面不计价');

  const topWall = initial.walls.find(wall => wall.start.y === wall.end.y && wall.start.x < wall.end.x);
  const otherWall = initial.walls.find(wall => wall.start.x === wall.end.x);
  assert.ok(topWall && otherWall);
  await selectWall(topWall.id);
  await page.locator('[data-action="add-opening"][data-kind="hole"]').click();
  for (const [field, value] of [['width', '1'], ['height', '1'], ['offset', '1.5'], ['bottom', '1']]) await page.locator(`#opening-${field}`).fill(value);
  await page.locator('#opening-form [type="submit"]').click();
  await selectWall(otherWall.id);
  await page.locator('[data-action="add-opening"][data-kind="door"]').click();
  for (const [field, value] of [['width', '0.9'], ['height', '2.1'], ['offset', '0.8'], ['bottom', '0']]) await page.locator(`#opening-${field}`).fill(value);
  await page.locator('#opening-form [type="submit"]').click();
  near((await getQuote()).walls.reduce((sum, wall) => sum + wall.netArea, 0), 116.48 - 2 - 3.78);
  near((await getQuote()).regions[0].netArea, 24);
  pass('贯通1m²孔与0.9×2.1m门只扣真实左右面积，不补回洞口内壁，不改变地面面积');

  await selectWall(topWall.id);
  const areaBySide = {};
  for (const side of ['left', 'right', 'both']) {
    await page.locator('#wall-finish-side').selectOption(side);
    const selected = await page.evaluate(() => window.planStudio.get2DWallSelection());
    assert.equal(selected.side, side);
    assert.ok(selected.faces.length > 0);
    assert.ok(selected.faces.every(face => side === 'both' ? ['left', 'right'].includes(face.side) : face.side === side));
    near(selected.area, (await getQuote()).walls.find(wall => wall.id === topWall.id).netArea);
    const elevations = page.locator('#wall-finish-preview svg');
    assert.equal(await elevations.count(), side === 'both' ? 2 : 1);
    for (const elevation of await elevations.all()) {
      assert.equal(await elevation.getAttribute('data-face-count'), '1');
      assert.equal(await elevation.getAttribute('data-hole-count'), '1');
      const paths = elevation.locator('path');
      assert.equal(await paths.count(), 1, 'A continuous wall face must not display subdivision seams');
      assert.equal(await paths.getAttribute('fill-rule'), 'evenodd');
      const fill = await paths.evaluate(path => {
        const solid = path.ownerSVGElement.createSVGPoint(), hole = path.ownerSVGElement.createSVGPoint();
        solid.x = .5; solid.y = -.5; hole.x = 2; hole.y = -1.5;
        return { solid: path.isPointInFill(solid), hole: path.isPointInFill(hole) };
      });
      assert.deepEqual(fill, { solid: true, hole: false }, 'Actual SVG fill must leave the aperture empty');
    }
    areaBySide[side] = selected.area;
  }
  near(areaBySide.both, areaBySide.left + areaBySide.right);
  await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  const selected3D = await page.evaluate(() => window.planStudio.get3DStats());
  near(selected3D.selectedWallArea, areaBySide.both);
  assert.ok(selected3D.selectedWallSurfaces.every(surface => ['left', 'right'].includes(surface.side)));
  assert.equal(selected3D.selectedWallFaceCount, 2);
  assert.equal(selected3D.selectedWallFaces.reduce((sum, face) => sum + face.holes.length, 0), 2);
  assert.ok(selected3D.selectedWallFaces.every(face => face.points.length >= 4 && face.holes.every(hole => hole.length >= 4)));
  assert.equal(selected3D.glError, 0);
  await page.screenshot({ path: join(artifacts, 'continuous-wall-with-hole.png') });
  await page.locator('[data-view="2d"]').click();
  pass('双侧等于左右之和，二维/三维计价范围一致，每侧为一个带真实孔洞的连续面');

  await page.locator('#inspector [data-action="add-item"]').click();
  await page.locator('[data-pick-material="demo-wood"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('10');
  await page.locator('[data-item-field="wasteRate"]').fill('0');
  await page.locator('[data-item-field="laborRate"]').fill('0');
  const wallQuote = (await getQuote()).walls.find(wall => wall.id === topWall.id);
  near(wallQuote.netArea, 32.72);
  assert.equal(wallQuote.total, '327.20');
  await page.locator(`[data-action="select-region"][data-id="${room.id}"]`).click();
  await page.locator('[data-action="add-item"]').click(); await page.locator('[data-pick-material="demo-tile"]').click();
  await page.locator('[data-item-field="unitPrice"]').fill('100');
  await page.locator('[data-item-field="wasteRate"]').fill('10');
  await page.locator('[data-item-field="laborRate"]').fill('20');
  assert.equal((await getQuote()).regions[0].total, '3120.00');
  const beforeMode = await getProject();
  await enterDecoration();
  assert.equal((await getProject()).workspaceMode, 'decoration');
  assert.equal((await getProject()).id, beforeMode.id);
  assert.deepEqual((await getProject()).walls, beforeMode.walls);
  assert.deepEqual((await getProject()).regions, beforeMode.regions);
  for (const kind of ['nightstand', 'wardrobe', 'sofa']) assert.equal(await page.locator(`[data-place-furniture="${kind}"]`).isVisible(), true);
  pass('完成平面后进入独立装修界面，常驻床头柜/衣柜/沙发预设，不重建几何或报价');

  const xs = room.points.map(point => point.x), ys = room.points.map(point => point.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, depth = Math.max(...ys) - minY;
  const protectedGeometry = await getProject();
  for (const key of ['w', 'p', 'b', 'o']) {
    await page.keyboard.press(key);
    for (const point of [{ x: minX + 30, y: minY + 30 }, { x: minX + 100, y: minY + 30 }, { x: minX + 60, y: minY + 100 }]) await clickWorld(point);
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
    assert.deepEqual((await getProject()).walls, protectedGeometry.walls, `${key} cannot draw walls in decoration`);
    assert.deepEqual((await getProject()).regions, protectedGeometry.regions, `${key} cannot draw or cut room regions in decoration`);
    assert.equal(await getMode(), 'decoration');
  }
  pass('装修阶段W/P/B/O快捷键与实际点击不能改画墙、区域或孔洞，户型编辑须返回绘图');
  await page.locator('[data-place-furniture="nightstand"]').click();
  assert.equal((await getProject()).furniture?.length ?? 0, 0);
  await page.keyboard.press('Escape');
  await clickWorld({ x: minX + width / 2, y: minY + depth / 2 });
  assert.equal((await getProject()).furniture?.length ?? 0, 0);
  pass('选择预设后点击才落地，Esc取消不会留下家具或报价');

  const configurations = [
    { kind: 'nightstand', name: '甲方床头柜', point: { x: minX + width * .22, y: minY + depth * .3 }, quantity: '2', price: '125.25', extra: '30', dimensions: [45, 40, 55], total: '280.50' },
    { kind: 'wardrobe', name: '甲方衣柜', point: { x: minX + width * .78, y: minY + depth * .3 }, quantity: '1', price: '2000', extra: '100', dimensions: [180, 60, 220], total: '2100.00' },
    { kind: 'sofa', name: '甲方沙发 "A,款"', point: { x: minX + width * .5, y: minY + depth * .72 }, quantity: '1', price: '3200.10', extra: '50', dimensions: [240, 90, 85], total: '3250.10' },
  ];
  let downloads = 0; page.on('download', () => downloads++);
  for (const [index, configuration] of configurations.entries()) {
    await page.locator(`[data-place-furniture="${configuration.kind}"]`).click();
    assert.equal((await getProject()).furniture?.length ?? 0, index);
    await clickWorld(configuration.point);
    await page.waitForFunction(length => window.planStudio.getProject().furniture.length === length, index + 1);
    const added = (await getProject()).furniture.at(-1);
    assert.equal(added.kind, configuration.kind); assert.equal(added.unitPrice, '');
    near(added.position.x, configuration.point.x, 1); near(added.position.y, configuration.point.y, 1);
    assert.equal((await getQuote()).furniture.at(-1).pending, true);
    if (!index) {
      await page.locator('#export').click(); await page.locator('[data-export="csv"]').click();
      await page.waitForFunction(() => /请先完成报价/.test(document.querySelector('#toast').textContent));
      assert.equal(downloads, 0); await page.keyboard.press('Escape');
    }
    await page.locator('#furniture-name').fill(configuration.name);
    for (const [field, value] of [['quantity', configuration.quantity], ['unitPrice', configuration.price], ['additionalCost', configuration.extra], ['width', configuration.dimensions[0]], ['depth', configuration.dimensions[1]], ['height', configuration.dimensions[2]]]) await page.locator(`#furniture-${field}`).fill(String(value));
    assert.equal((await getQuote()).furniture.at(-1).total, configuration.total);
    configuration.id = added.id;
  }
  near((await getQuote()).regions[0].netArea, 24);
  assert.equal((await getQuote()).knownFurnitureCost, '5630.60');
  pass('三类预设独立摆放、尺寸可调且价格留空，自填件数与一次性运费准确得到5630.60元');

  await page.locator(`[data-action="select-furniture"][data-id="${configurations[0].id}"]`).click();
  await page.locator('#furniture-unitPrice').fill('0');
  assert.equal((await getQuote()).furniture[0].pending, false);
  assert.equal((await getQuote()).furniture[0].total, '30.00');
  await page.locator('#furniture-unitPrice').fill('125.25');
  const quoted = await getQuote();
  await page.locator(`[data-action="toggle-furniture"][data-id="${configurations[1].id}"]`).click();
  assert.equal((await getQuote()).beforeTax, quoted.beforeTax);
  assert.equal((await getProject()).furniture[1].hidden, true);
  await page.locator(`[data-action="toggle-furniture"][data-id="${configurations[1].id}"]`).click();
  pass('空价阻止正式CSV，明确零价有效；隐藏家具保留预算且不重复扣减房间面积');

  await page.locator(`[data-action="select-furniture"][data-id="${configurations[2].id}"]`).click();
  await page.locator('[data-action="duplicate-furniture"]').click();
  assert.equal((await getProject()).furniture.length, 4);
  assert.equal((await getQuote()).knownFurnitureCost, '8880.70');
  await returnPlan();
  await page.locator('#undo').click();
  assert.equal((await getProject()).furniture.length, 3);
  assert.equal(await getMode(), 'plan');
  await page.locator('#redo').click(); assert.equal((await getProject()).furniture.length, 4); assert.equal(await getMode(), 'plan');
  await enterDecoration(); await page.locator('#undo').click();
  assert.equal((await getProject()).furniture.length, 3); assert.equal(await getMode(), 'decoration');
  pass('复制创建独立摆放实例；返回画图保留装修，阶段切换不占用撤销栈');

  await page.locator(`[data-action="select-furniture"][data-id="${configurations[2].id}"]`).click();
  await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(() => {
    const stats = window.planStudio.get3DStats();
    return stats?.renderedFurnitureCount === 3 && stats.furnitureAssetsReady === true;
  });
  const stats = await page.evaluate(() => window.planStudio.get3DStats());
  assert.equal(stats.selectedFurnitureId, configurations[2].id);
  for (const configuration of configurations) {
    const rendered = stats.furniture.find(item => item.id === configuration.id);
    assert.ok(rendered);
    near(rendered.size.width, configuration.dimensions[0] / 100);
    near(rendered.size.depth, configuration.dimensions[1] / 100);
    near(rendered.size.height, configuration.dimensions[2] / 100);
  }
  assert.equal(stats.glError, 0);
  await page.screenshot({ path: join(artifacts, 'decoration-3d.png') });
  await page.locator('[data-view="2d"]').click();
  pass('装修三维包含真实尺寸床头柜、衣柜与沙发，二维/三维选择一致且WebGL无错误');

  await page.locator('#settings').click();
  await page.locator('#settings-form [name="taxRate"]').fill('10');
  await page.locator('#settings-form [type="submit"]').click();
  const finalQuote = await getQuote();
  assert.equal(finalQuote.beforeTax, '9077.80'); assert.equal(finalQuote.tax, '907.78'); assert.equal(finalQuote.total, '9985.58');
  const saved = await getProject();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getWorkspaceMode);
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id);
  assert.equal(await getMode(), 'decoration');
  assert.deepEqual((await getProject()).furniture, saved.furniture);
  assert.deepEqual((await getProject()).walls, saved.walls);
  assert.deepEqual((await getProject()).openings, saved.openings);
  assert.equal((await getQuote()).total, '9985.58');
  pass('保存与重新打开保留装修阶段、墙孔、家具尺寸价格和9985.58元税后总价');

  const downloadExport = async (format, name) => {
    await page.locator('#export').click();
    const downloading = page.waitForEvent('download'); await page.locator(`[data-export="${format}"]`).click();
    const file = await downloading; await file.saveAs(join(artifacts, name)); return readFile(await file.path(), 'utf8');
  };
  const csv = await downloadExport('csv', 'decoration-quote.csv'), rows = csvRows(csv);
  assert.equal(rows[0].length, 25); assert.ok(rows.every(row => row.length === 25));
  for (const configuration of configurations) {
    const line = rows.find(row => row[0] === '家具明细' && row[2] === configuration.name);
    assert.ok(line); assert.equal(line[3], ''); assert.equal(line[4], ''); assert.equal(line[8], configuration.quantity);
    assert.equal(line[18], configuration.total); assert.match(line[24], /cm/);
  }
  assert.equal(rows.at(-1)[21], '9985.58');
  const json = JSON.parse(await downloadExport('json', 'decoration-project.json'));
  assert.equal(json.workspaceMode, 'decoration'); assert.deepEqual(json.furniture, saved.furniture);
  assert.deepEqual(json.openings, saved.openings);
  pass('实际CSV保持25列并正确转义自定义家具名，项目JSON完整保存装修阶段和家具');

  await page.locator('#export').click();
  const popupEvent = page.waitForEvent('popup'); await page.locator('[data-export="pdf"]').click();
  const popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
  const printed = await popup.locator('body').innerText();
  for (const configuration of configurations) { assert.ok(printed.includes(configuration.name)); assert.ok(printed.includes(configuration.total)); }
  assert.ok(printed.includes('9985.58') || printed.includes('9,985.58'));
  await popup.pdf({ path: join(artifacts, 'decoration-quote.pdf'), format: 'A4', printBackground: true });
  await popup.close();
  pass('真实打印页包含家具件数规格与报价，可以输出PDF');

  for (const viewportWidth of [1440, 1100]) {
    await page.setViewportSize({ width: viewportWidth, height: 960 }); await page.locator('#fit').click(); await frame();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const kind of ['nightstand', 'wardrobe', 'sofa']) assert.equal(await page.locator(`[data-place-furniture="${kind}"]`).isVisible(), true);
    await page.screenshot({ path: join(artifacts, `decoration-workspace-${viewportWidth}.png`) });
  }
  const imageContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const imagePage = await imageContext.newPage();
  imagePage.on('pageerror', error => runtimeErrors.push(error.message));
  await imagePage.goto(baseURL); await imagePage.waitForFunction(() => window.planStudio?.getWorkspaceMode);
  const png = await imagePage.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 400, 300);
    context.strokeStyle = '#555'; context.lineWidth = 2; context.strokeRect(40, 40, 320, 220);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await imagePage.locator('#drawing-file').setInputFiles({ name: '装修底图.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await imagePage.waitForFunction(() => window.planStudio.getProject().drawing?.width === 400);
  await imagePage.locator('#enter-decoration').click();
  await imagePage.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'decoration');
  await imagePage.locator('[data-place-furniture="nightstand"]').click();
  const imagePoint = await imagePage.evaluate(() => window.planStudio.toScreen({ x: 200, y: 150 }));
  const imageBox = await imagePage.locator('#drawing-canvas').boundingBox();
  await imagePage.mouse.click(imageBox.x + imagePoint.x, imageBox.y + imagePoint.y);
  await imagePage.waitForFunction(() => window.planStudio.getProject().furniture?.length === 1);
  assert.equal(await imagePage.evaluate(() => window.planStudio.getProject().calibration.metersPerPixel), null);
  assert.match(await imagePage.locator('#inspector').innerText(), /尚未校准/);
  await imagePage.locator('#furniture-quantity').fill('2'); await imagePage.locator('#furniture-unitPrice').fill('50'); await imagePage.locator('#furniture-additionalCost').fill('5');
  assert.equal(await imagePage.evaluate(() => window.planStudio.getQuote().total), '105.00');
  assert.equal(await imagePage.evaluate(() => window.planStudio.getProject().calibration.metersPerPixel), null);
  await imagePage.screenshot({ path: join(artifacts, 'uncalibrated-image-decoration.png') });
  await imageContext.close();
  pass('实际上传底图可进入装修，未校准保留位置标记与明确提示，按件105元报价不伪造面积');
  assert.deepEqual(runtimeErrors, []);
  pass('1440与1100宽度装修界面无横向溢出，预设与图纸可操作，全流程无页面异常');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, finalQuote }, null, 2));
  process.stdout.write(`\n${reports.length} 项装修与连续墙面浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  if (page) process.stderr.write(JSON.stringify(await page.evaluate(() => ({
    toast: document.querySelector('#toast')?.textContent,
    workspaceMode: window.planStudio?.getWorkspaceMode?.(),
    selection: window.planStudio?.getSelection?.(),
    project: (() => { const project = window.planStudio?.getProject?.(); return project && { id: project.id, workspaceMode: project.workspaceMode, drawing: project.drawing && { id: project.drawing.id, type: project.drawing.type, width: project.drawing.width, height: project.drawing.height }, walls: project.walls, openings: project.openings, regions: project.regions, furniture: project.furniture, planError: project.planError }; })(),
    quote: window.planStudio?.getQuote?.(),
  })).catch(() => ({})), null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
