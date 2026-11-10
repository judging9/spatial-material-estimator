import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const testRoot = await mkdtemp(join(tmpdir(), 'studio-terrain-authoring-')), artifacts = resolve('artifacts/terrain-authoring');
await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page, serverErrors = ''; server.stderr.on('data', chunk => serverErrors += chunk);
const reports = [], runtimeErrors = [], pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Terrain authoring server timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error('Test server exited ' + code)); });
  });
  const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); page = await context.newPage();
  page.on('dialog', dialog => dialog.accept()); page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getProject);
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const edit = async () => { await page.locator('#left-panel [data-action="edit-terrain"]').click(); await page.locator('#terrain-form').waitFor(); };
  const apply = async () => { await page.locator('#terrain-form [type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#dialog')?.open); };
  const canvasPoint = (x, y) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('#terrain-sculpt-canvas'), rect = canvas.getBoundingClientRect(), size = 22, scale = Math.min((canvas.width - 64) / size, (canvas.height - 48) / size);
    return { x: rect.left + ((canvas.width - size * scale) / 2 + (x + 1) * scale) * rect.width / canvas.width, y: rect.top + ((canvas.height - size * scale) / 2 + (y + 1) * scale) * rect.height / canvas.height };
  }, { x, y });
  const click = async (x, y) => { await page.locator('#terrain-sculpt-canvas').scrollIntoViewIfNeeded(); const point = await canvasPoint(x, y); await page.mouse.click(point.x, point.y); };
  await page.locator('#enter-municipal').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'municipal'); await edit();
  for (const [id, value] of [['width', 20], ['length', 20], ['spacing', 2], ['elevation', 10]]) await page.locator('#terrain-create-' + id).fill(String(value));
  await page.locator('#terrain-create').click(); assert.equal((await project()).municipalTerrain, undefined);
  assert.match(await page.locator('#terrain-statistics').innerText(), /400\.00/); assert.match(await page.locator('#terrain-source').innerText(), /自建概念地形/);
  pass('无需文件即可生成11×11真实高程点与400m²内插场地，应用前工程保持未改动');
  await page.locator('[data-terrain-tool="raise"]').click(); await page.locator('#terrain-brush-radius').fill('4'); await page.locator('#terrain-brush-strength').fill('2'); await click(10, 10);
  await page.locator('#terrain-grid-row').fill('6'); await page.locator('#terrain-grid-row').blur(); assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '12');
  await page.locator('#terrain-sculpt-undo').click(); assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '10');
  await page.locator('[data-terrain-tool="lower"]').click(); await click(10, 10); assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '8');
  await page.locator('[data-terrain-tool="flatten"]').click(); await page.locator('#terrain-flatten-elevation').fill('10'); await page.locator('#terrain-brush-strength').fill('5'); await click(10, 10); assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '10');
  pass('画布笔刷实际抬高、降低和平整中心高程，单次笔刷可在窗口内撤销');
  await page.locator('[data-terrain-tool="river"]').click(); await page.locator('#terrain-river-width').fill('4'); await page.locator('#terrain-river-depth').fill('2'); await page.locator('#terrain-river-slope').fill('1');
  await click(0, 10); await click(20, 10); await page.locator('#terrain-river-finish').click(); assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '8');
  await apply(); const original = (await project()).municipalTerrain; assert.equal(original.raster.values[60], 8); assert.match(original.sourceName, /人工塑形/);
  await page.locator('#undo').click(); assert.equal((await project()).municipalTerrain, undefined); await page.locator('#redo').click(); assert.deepEqual((await project()).municipalTerrain, original);
  pass('逐点河槽真实改变河床高程，应用后只产生一次项目撤销与重做');
  await edit(); await page.locator('#terrain-grid-row').fill('6'); await page.locator('#terrain-grid-row').blur(); await page.locator('[data-terrain-cell="60"]').fill('');
  assert.equal(await page.locator('[data-terrain-cell="60"]').inputValue(), '');
  assert.deepEqual(await page.locator('#terrain-sculpt-canvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data)), [248, 247, 243, 255], '直接编辑NoData后塑形预览立即显示缺失像元');
  await page.locator('[data-terrain-tool="raise"]').click(); await click(10, 10); await apply(); const withHole = (await project()).municipalTerrain; assert.equal(withHole.raster.values[60], null);
  pass('既有DEM缺失像元经过笔刷仍为NoData，没有编造缺失高程');
  await edit();
  await page.locator('.terrain-generation summary').click(); await page.locator('#terrain-create-spacing').fill('.001'); await page.locator('#terrain-create').click();
  assert.match(await page.locator('#terrain-error').innerText(), /16384/); await page.locator('#dialog [data-dialog-close]').click(); assert.deepEqual((await project()).municipalTerrain, withHole);
  pass('过密网格明确拒绝，关闭未应用的草稿保持原工程');
  await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  assert.ok((await page.evaluate(() => window.planStudio.get3DStats())).terrainTriangleCount > 0);
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机'); const saved = await project();
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); assert.deepEqual(JSON.parse(JSON.stringify((await project()).municipalTerrain)), JSON.parse(JSON.stringify(saved.municipalTerrain)));
  pass('自建及塑形地形进入真实三维，保存、刷新和重开保留完整高程与来源');
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 }); await edit();
    assert.ok(await page.locator('#dialog .dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.locator('#terrain-sculpt-canvas').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(artifacts, `editor-${width}.png`) });
    await page.locator('#terrain-form [type="submit"]').scrollIntoViewIfNeeded(); assert.ok(await page.locator('#terrain-form [type="submit"]').isVisible()); await page.locator('#dialog [data-dialog-close]').click();
  }
  assert.deepEqual(runtimeErrors, []); pass('1440/1100地形编辑器无水平溢出，塑形画布和应用按钮可操作且无浏览器异常');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, runtimeErrors }, null, 2));
} catch (error) { await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ error: String(error), reports, runtimeErrors }, null, 2)); throw error; }
finally { await browser?.close(); server.kill(); }
