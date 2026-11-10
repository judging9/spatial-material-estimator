import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Each run owns its server and project storage; no existing user project is changed.
const testRoot = await mkdtemp(join(tmpdir(), 'studio-terrain-landscape-'));
const artifacts = resolve('artifacts/terrain-landscape');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page, serverErrors = '', outcome = 'failed', browserClosed = false;
server.stderr.on('data', chunk => serverErrors += chunk);
const reports = [], runtimeErrors = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected}`);

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Terrain landscape server timeout')), 20000);
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const executablePath = process.env.CHROME_PATH || [
    'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio?.getProject);

  const project = () => page.evaluate(() => window.planStudio.getProject());
  const quote = () => page.evaluate(() => window.planStudio.getQuote());
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const edit = async () => {
    await page.locator('#left-panel [data-action="edit-terrain"]').click();
    await page.locator('#terrain-form').waitFor();
  };
  const close = async () => {
    await page.locator('#dialog [data-dialog-close]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog')?.open);
  };
  const apply = async () => {
    await page.locator('#terrain-form [type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog')?.open);
    await frame();
  };
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await frame();
    await page.screenshot({ path: join(artifacts, name) });
  };
  const show3D = async () => {
    if (await page.evaluate(() => window.planStudio.getViewMode()) !== '3d') await page.locator('[data-view="3d"]').click();
    await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
    await page.locator('#fit').click();
    await frame();
  };
  const show2D = async () => {
    if (await page.evaluate(() => window.planStudio.getViewMode()) !== '2d') await page.locator('[data-view="2d"]').click();
    await frame();
  };
  const selectRow = async row => {
    await page.locator('#terrain-grid-row').fill(String(row + 1));
    await page.locator('#terrain-grid-row').blur();
  };
  const centre = async () => {
    await selectRow(5);
    return Number(await page.locator('[data-terrain-cell="60"]').inputValue());
  };
  const readGrid = async () => {
    const values = [];
    for (let row = 0; row < 11; row++) {
      await selectRow(row);
      const samples = await page.locator('[data-terrain-cell]').evaluateAll(inputs => inputs.map(input => ({
        index: Number(input.dataset.terrainCell), value: input.value === '' ? null : Number(input.value),
      })));
      for (const sample of samples) values[sample.index] = sample.value;
    }
    await selectRow(5);
    assert.equal(values.length, 121);
    return values;
  };
  const sectionPixels = () => page.locator('#terrain-section-canvas').evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 0) painted++;
    return painted;
  });
  // The grid is 11 × 11: sample centres span 20 m, raster border includes two half-cells.
  const canvasPoint = (x, y) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('#terrain-sculpt-canvas'), rect = canvas.getBoundingClientRect();
    const size = 22, scale = Math.min((canvas.width - 64) / size, (canvas.height - 48) / size);
    return {
      x: rect.left + ((canvas.width - size * scale) / 2 + (x + 1) * scale) * rect.width / canvas.width,
      y: rect.top + ((canvas.height - size * scale) / 2 + (y + 1) * scale) * rect.height / canvas.height,
    };
  }, { x, y });
  const clickPoint = async (x, y) => {
    await page.locator('#terrain-sculpt-canvas').scrollIntoViewIfNeeded();
    const point = await canvasPoint(x, y);
    await page.mouse.click(point.x, point.y);
  };
  const beginStroke = async points => {
    const canvas = page.locator('#terrain-sculpt-canvas');
    await canvas.scrollIntoViewIfNeeded();
    await canvas.evaluate(node => node.addEventListener('pointerdown', event => {
      node.dataset.e2ePointer = String(event.pointerId);
    }, { once: true }));
    const from = await canvasPoint(points[0].x, points[0].y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
      const target = await canvasPoint(point.x, point.y);
      await page.mouse.move(target.x, target.y, { steps: 8 });
    }
    return canvas.evaluate(node => Number(node.dataset.e2ePointer));
  };
  const dragPath = async points => { await beginStroke(points); await page.mouse.up(); };
  const configureFeature = async (mode, relief) => {
    await page.locator(`[data-terrain-tool="${mode}"]`).click();
    await page.locator('#terrain-feature-radius').fill('4');
    await page.locator('#terrain-feature-relief').fill(String(relief));
  };

  await page.locator('#enter-municipal').click();
  await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'municipal');
  const initial = await project();
  assert.equal(initial.municipalTerrain, undefined);
  await edit();
  assert.equal(await sectionPixels(), 0);
  await page.locator('[data-terrain-landscape="mountain"]').click();
  assert.equal(await page.locator('[data-terrain-landscape="mountain"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#terrain-create-relief').inputValue(), '500');
  for (const [id, value] of [['width', 20], ['length', 20], ['spacing', 2], ['elevation', 10], ['relief', 300], ['rotation', 0]]) {
    await page.locator('#terrain-create-' + id).fill(String(value));
  }
  await page.locator('#terrain-create').click();
  near(await centre(), 310);
  assert.match(await page.locator('#terrain-statistics').innerText(), /400\.00/);
  assert.match(await page.locator('#terrain-source').innerText(), /自建概念地形.*高山/);
  assert.match(await page.locator('#terrain-section-canvas').getAttribute('aria-label'), /最高 310\.00 m/);
  assert.ok(await sectionPixels() > 100);
  assert.deepEqual(await project(), initial);
  await page.locator('#terrain-section-axis').selectOption('y');
  assert.match(await page.locator('#terrain-section-note').innerText(), /上下剖面.*纵轴随真实高程范围缩放/);
  await page.locator('#terrain-section-axis').selectOption('x');
  pass('20 × 20 m / 2 m 网格真实生成基准10 + 山高300 = 310 m，400m²剖面按实际高程绘制，草稿不修改工程');

  await page.locator('#terrain-sculpt-undo').click();
  assert.equal(await sectionPixels(), 0);
  assert.equal(await page.locator('#terrain-sculpt-range').innerText(), '');
  assert.ok(await page.locator('#terrain-sculpt-empty').isVisible());
  assert.equal(await page.locator('#terrain-sculpt-undo').isDisabled(), true);
  assert.deepEqual(await project(), initial);
  await page.locator('#terrain-create').click();
  const mountainValues = await readGrid();
  near(mountainValues[60], 310);
  pass('生成地形可一步撤销到空模型，旧剖面与高程范围随之清空，再生成保持输入值');

  await configureFeature('hollow', 100);
  await clickPoint(10, 10);
  near(await centre(), 210);
  await page.locator('#terrain-sculpt-undo').click();
  assert.deepEqual(await readGrid(), mountainValues);
  pass('低谷100 m / 半径4 m 点击中心后由310降至210 m，一笔撤销精确恢复全部121个高程');

  for (const [mode, relief, expected, points] of [
    ['ridge', 50, 360, [{ x: 4, y: 10 }, { x: 16, y: 10 }]],
    ['canyon', 80, 230, [{ x: 4, y: 10 }, { x: 16, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 16 }]],
  ]) {
    await configureFeature(mode, relief);
    await dragPath(points);
    near(await centre(), expected);
    await page.locator('#terrain-sculpt-undo').click();
    assert.deepEqual(await readGrid(), mountainValues);
  }
  assert.deepEqual(await project(), initial);
  pass('山脊与弯曲交叉峡谷可真实拖画，松开一次提交；路径交叉不重复叠加，一步撤销恢复原地形');

  for (const [cancel, mode, relief, points] of [
    ['escape', 'peak', 100, [{ x: 10, y: 10 }]],
    ['pointercancel', 'ridge', 50, [{ x: 4, y: 10 }, { x: 16, y: 10 }]],
    ['blur', 'canyon', 80, [{ x: 4, y: 10 }, { x: 16, y: 10 }]],
  ]) {
    await configureFeature(mode, relief);
    await page.locator('#terrain-sculpt-canvas').scrollIntoViewIfNeeded();
    const beforeRange = await page.locator('#terrain-sculpt-range').innerText();
    const pointerId = await beginStroke(points);
    assert.notEqual(await page.locator('#terrain-sculpt-range').innerText(), beforeRange, `${cancel}: 操作中应先显示真实预览`);
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else if (cancel === 'pointercancel') await page.locator('#terrain-sculpt-canvas').dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, bubbles: true });
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.equal(await page.locator('#dialog').evaluate(dialog => dialog.open), true, '取消绘制不应关闭地形窗口');
    assert.equal(await page.locator('#terrain-sculpt-canvas').evaluate((canvas, id) => canvas.hasPointerCapture(id), pointerId), false);
    assert.deepEqual(await readGrid(), mountainValues, `${cancel}: 全部高程应回滚`);
    assert.deepEqual(await project(), initial);
  }
  // Cancellation must not add a history entry: only the original generation remains.
  await page.locator('#terrain-sculpt-undo').click();
  assert.equal(await sectionPixels(), 0);
  assert.ok(await page.locator('#terrain-sculpt-empty').isVisible());
  await page.locator('#terrain-create').click();
  near(await centre(), 310);
  pass('Esc、pointercancel 与窗口 blur 取消未完成塑形并释放捕获，完整回滚高程且不增加撤销历史');

  await apply();
  const appliedMountain = (await project()).municipalTerrain;
  near(appliedMountain.raster.values[60], 310);
  assert.equal(appliedMountain.raster.ncols, 11);
  assert.equal(appliedMountain.raster.nrows, 11);
  await page.locator('#undo').click();
  assert.equal((await project()).municipalTerrain, undefined);
  await page.locator('#redo').click();
  assert.deepEqual((await project()).municipalTerrain, appliedMountain);
  await show3D();
  const mountainScene = await page.evaluate(() => window.planStudio.get3DStats());
  assert.equal(mountainScene.terrainTriangleCount, 200);
  assert.ok(mountainScene.terrainSurfaces.flatMap(surface => surface.points).some(point => Math.abs(point.x - 10) < 1e-8 && Math.abs(point.z - 10) < 1e-8 && Math.abs(point.y - 310) < 1e-8));
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#viewer3d canvas'), gl = canvas.getContext('webgl');
    gl.finish();
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 12) colored++;
    return { colored, error: gl.getError() };
  });
  assert.ok(pixels.colored > 300, '真实三维应绘出可见山体像素');
  assert.equal(pixels.error, 0);
  assert.equal(mountainScene.glError, 0);
  await screenshot('mountain-310m-3d-1440.png');
  pass('应用只生成一次项目撤销，真实WebGL绘出200片山体三角形，中心顶点实际为310m且有可见像素');

  await show2D();
  // This regression compares a deliberately level roadway with changing
  // terrain. Terrain-following is now the ordinary default for new roads.
  await page.locator('#site-placement-mode').selectOption('manual');
  await page.locator('#site-placement-elevation').fill('0');
  await page.locator('#site-placement-elevation').press('Tab');
  await page.locator('[data-action="quick-municipal"]').first().click();
  await page.locator('#municipal-quick-kind').selectOption('road');
  for (const [key, value] of Object.entries({ x: 5, y: 10, length: 10, angle: 0, width: 200, height: 10, elevation: 0 })) {
    await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
  }
  await page.locator('#municipal-quick-form [type="submit"]').click();
  await frame();
  await page.locator('#municipal-unitPrice').fill('0');
  await frame();
  const roadId = (await project()).municipalElements.find(item => item.kind === 'road').id;
  const roadAnalysis = () => page.evaluate(async id => {
    const { roadProfileAnalysis } = await import('/studio/lib/road-profile.js');
    const current = window.planStudio.getProject();
    return roadProfileAnalysis(current, current.municipalElements.find(item => item.id === id));
  }, roadId);
  await page.locator('.rp-inspector [data-action="road-profile"]').click();
  await page.locator('#road-profile-form').waitFor();
  await page.locator('#road-profile-enabled').check();
  for (const index of [0, 1]) await page.locator(`[data-road-profile-point="${index}"] [data-road-grade-field="elevation"]`).fill('0');
  await page.locator('#road-earthwork-enabled').check();
  await page.locator('#road-cut-price').fill('10');
  await page.locator('#road-fill-price').fill('20');
  await page.locator('#road-profile-form [type="submit"]').click();
  await page.waitForSelector('#road-profile-form', { state: 'hidden' });
  await frame();
  const roadQuote = () => quote().then(result => result.municipalElements.find(item => item.id === roadId));
  const mountainQuote = await roadQuote();
  const mountainEarth = mountainQuote.roadEngineering.earthworks;
  assert.equal(mountainEarth.complete, true);
  near(mountainEarth.coveredArea, 20);
  near(mountainEarth.fillVolume, 0);
  assert.ok(mountainEarth.cutVolume > 0);
  near((await roadAnalysis()).rows.find(row => Math.abs(row.station - 5) < 1e-8).groundElevation, 310);
  near(mountainEarth.cutCost, mountainEarth.cutVolume * 10, .011);
  assert.equal(mountainQuote.total, mountainEarth.total);
  const mountainTotal = (await quote()).total;

  await edit();
  await configureFeature('hollow', 100);
  await clickPoint(10, 10);
  near(await centre(), 210);
  assert.deepEqual((await project()).municipalTerrain, appliedMountain);
  assert.equal((await quote()).total, mountainTotal);
  await apply();
  const loweredTerrain = (await project()).municipalTerrain, loweredQuote = await roadQuote();
  near(loweredTerrain.raster.values[60], 210);
  near((await roadAnalysis()).rows.find(row => Math.abs(row.station - 5) < 1e-8).groundElevation, 210);
  assert.ok(loweredQuote.roadEngineering.earthworks.cutVolume < mountainEarth.cutVolume);
  assert.ok(Number(loweredQuote.total) < Number(mountainQuote.total));
  near(loweredQuote.roadEngineering.earthworks.cutCost, loweredQuote.roadEngineering.earthworks.cutVolume * 10, .011);
  await page.locator('#undo').click();
  assert.deepEqual((await project()).municipalTerrain, appliedMountain);
  assert.equal((await quote()).total, mountainTotal);
  await page.locator('#redo').click();
  assert.deepEqual((await project()).municipalTerrain, loweredTerrain);
  assert.equal((await roadQuote()).total, loweredQuote.total);
  pass('真实UI建立10 × 2m道路并自填10/20元土方单价；地形310→210后地面读数、挖方与预算同步降低，草稿及项目撤销保持准确');

  // A corner gap is outside this road. Missing elevations remain missing without
  // invalidating the separate budget-update assertions above.
  await edit();
  await page.locator('[data-terrain-tool="view"]').click();
  await selectRow(0);
  await page.locator('[data-terrain-cell="0"]').fill('');
  const missingPixel = await page.locator('#terrain-sculpt-canvas').evaluate(canvas => {
    const size = 22, scale = Math.min((canvas.width - 64) / size, (canvas.height - 48) / size);
    const x = (canvas.width - size * scale) / 2 + scale, y = (canvas.height - size * scale) / 2 + scale;
    return Array.from(canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  });
  assert.deepEqual(missingPixel, [248, 247, 243, 255]);
  await configureFeature('peak', 80);
  await clickPoint(0, 0);
  await selectRow(0);
  assert.equal(await page.locator('[data-terrain-cell="0"]').inputValue(), '');
  await apply();
  const withGap = (await project()).municipalTerrain;
  assert.equal(withGap.raster.values[0], null);
  near(withGap.raster.values[60], 210);
  assert.equal((await roadQuote()).total, loweredQuote.total);
  const missingElevation = await page.evaluate(async () => {
    const { terrainElevation } = await import('/studio/lib/terrain.js');
    return terrainElevation(window.planStudio.getProject().municipalTerrain, 0, 0);
  });
  assert.equal(missingElevation, null);
  await show3D();
  const finalScene = await page.evaluate(() => window.planStudio.get3DStats());
  assert.ok(finalScene.terrainTriangleCount > 0 && finalScene.terrainTriangleCount < 200);
  for (const surface of finalScene.terrainSurfaces) for (const point of surface.points) {
    const col = Math.round(point.x / 2), row = Math.round(point.z / 2), value = withGap.raster.values[row * 11 + col];
    assert.notEqual(value, null, '三维不能桥接缺失高程');
    near(point.x, col * 2); near(point.z, row * 2); near(point.y, value);
  }
  assert.ok(finalScene.terrainSurfaces.flatMap(surface => surface.points).some(point => Math.abs(point.x - 10) < 1e-8 && Math.abs(point.z - 10) < 1e-8 && Math.abs(point.y - 210) < 1e-8));
  await screenshot('landscape-210m-gap-3d-1440.png');
  pass('角部NoData经过山峰塑形仍为空，三维全部顶点对应实际DEM中心及高程且不桥接缺失值，道路预算保持');

  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const saved = await project(), savedTotal = (await quote()).total;
  await page.reload();
  await page.waitForFunction(() => window.planStudio?.getProject);
  await page.locator('#open-project').click();
  await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id);
  assert.deepEqual(JSON.parse(JSON.stringify((await project()).municipalTerrain)), JSON.parse(JSON.stringify(saved.municipalTerrain)));
  assert.equal((await quote()).total, savedTotal);
  await page.locator('#export').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-export="json"]').click();
  const download = await downloadEvent, projectFile = join(artifacts, 'terrain-landscape-project.json');
  await download.saveAs(projectFile);
  const exported = JSON.parse(await readFile(projectFile, 'utf8'));
  assert.deepEqual(exported.municipalTerrain, JSON.parse(JSON.stringify(saved.municipalTerrain)));
  await page.locator('#open-project').click();
  await page.locator('[data-action="import-project"]').click();
  await page.locator('#project-file').setInputFiles(projectFile);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('完整项目已导入'));
  assert.deepEqual(JSON.parse(JSON.stringify((await project()).municipalTerrain)), exported.municipalTerrain);
  assert.equal((await quote()).total, savedTotal);
  pass('保存、刷新重开及完整JSON真实下载再导入，保留全部高程、NoData、比例、来源与道路预算');

  const overflow = [];
  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    await edit();
    if (!await page.locator('.terrain-generation').evaluate(node => node.open)) await page.locator('.terrain-generation summary').click();
    await page.locator('[data-terrain-landscape="ridge"]').click();
    await configureFeature('ridge', 50);
    assert.equal(await page.locator('#terrain-feature-fields').isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const checks = await page.locator('#dialog .dialog-body, .terrain-authoring, .terrain-generation-grid, .terrain-landscape-choices, .terrain-feature-fields, .terrain-height-profile, .terrain-sculpt-toolbar').evaluateAll(nodes => nodes.map(node => ({
      selector: node.id || node.className, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
    })));
    for (const check of checks) assert.ok(check.scrollWidth <= check.clientWidth + 1, `${width}px ${check.selector} 横向溢出`);
    const controls = await page.locator('[data-terrain-landscape], [data-terrain-tool], #terrain-feature-fields input, #terrain-create-rotation, #terrain-section-axis').evaluateAll(nodes => {
      const panel = document.querySelector('.terrain-edit-main').getBoundingClientRect();
      return nodes.map(node => { const rect = node.getBoundingClientRect(); return { id: node.id || node.dataset.terrainTool || node.dataset.terrainLandscape, inside: rect.left >= panel.left - 1 && rect.right <= panel.right + 1 && rect.width > 0 }; });
    });
    for (const control of controls) assert.equal(control.inside, true, `${width}px 控件 ${control.id} 应保持在地形面板内`);
    overflow.push({ width, checks, controls });
    await page.locator('.terrain-landscape-choices').scrollIntoViewIfNeeded();
    await screenshot(`landscape-presets-${width}.png`);
    await page.locator('#terrain-sculpt-canvas').scrollIntoViewIfNeeded();
    await screenshot(`landscape-editor-${width}.png`);
    await page.locator('#terrain-section-canvas').scrollIntoViewIfNeeded();
    await screenshot(`landscape-section-${width}.png`);
    await page.locator('#terrain-form [type="submit"]').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#terrain-form [type="submit"]').isVisible());
    await close();
    assert.deepEqual(JSON.parse(JSON.stringify((await project()).municipalTerrain)), exported.municipalTerrain);
  }
  assert.deepEqual(runtimeErrors, []);
  pass('1440 / 1100 / 900 px 新预设、塑形参数、工具栏及剖面无横向溢出，截图留存且未应用的控件调整保持工程');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({
    checks: reports.length, reports, runtimeErrors, pixels, terrain: saved.municipalTerrain,
    roadBudget: { mountain: mountainQuote.total, lowered: loweredQuote.total, saved: savedTotal }, overflow,
  }, null, 2));
  process.stdout.write(`\n${reports.length} 项高山低谷浏览器验收通过。\n`);
  outcome = 'passed';
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  const state = page ? await page.evaluate(() => ({
    project: window.planStudio?.getProject(), quote: window.planStudio?.getQuote(),
    stats: window.planStudio?.get3DStats(), toast: document.querySelector('#toast')?.textContent,
    terrainError: document.querySelector('#terrain-error')?.textContent,
    range: document.querySelector('#terrain-sculpt-range')?.textContent,
    section: document.querySelector('#terrain-section-canvas')?.getAttribute('aria-label'),
  })).catch(() => ({})) : {};
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, runtimeErrors, serverErrors, state }, null, 2));
  throw error;
} finally {
  if (browser) { await browser.close(); browserClosed = true; }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill(); await new Promise(done => { if (server.exitCode !== null || server.signalCode !== null) done(); else server.once('exit', done); });
  }
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: server.exitCode !== null || server.signalCode !== null, isolatedStorage: testRoot, checks: reports.length, runtimeErrors, serverErrors }, null, 2));
}
