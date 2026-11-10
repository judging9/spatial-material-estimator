import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// This suite uses ordinary controls and file pickers against the built app.
// Read-only project/quote/scene hooks collect evidence. Each run owns its
// server and storage; neither user projects nor application modules are patched.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/mountain-placement');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-mountain-placement-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page, stderr = '', outcome = 'failed', browserClosed = false;
server.stderr.on('data', chunk => { stderr += chunk; });
const reports = [], errors = [], evidence = {};
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected}`);
const roundedMoney = value => (Math.round(value * 100 + 1e-9) / 100).toFixed(2);
const parseCSV = source => {
  const rows = [], row = []; let cell = '', quoted = false;
  source = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); rows.push([...row]); row.length = 0; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false); return rows;
};

function fixture() {
  const values = Array.from({ length: 21 * 16 }, (_, i) => {
    const x = i % 21 * 20, y = Math.floor(i / 21) * 20;
    return 30 + Math.max(0, 1 - Math.hypot(x - 200, y - 160) / 140) * 180;
  });
  const element = (id, kind, points, patch = {}) => ({ id, name: id, kind, points, holes: [], width: 600, depth: 20, height: 5, elevation: 3000, quantity: '1', unit: 'm²', unitPrice: '0', wasteRate: '0', laborRate: '0', additionalCost: '0', hidden: false, locked: false, items: [], ...patch });
  return {
    version: 1, id: 'mountain-placement-acceptance', name: '山地道路与设施工程', workspaceMode: 'municipal',
    drawing: { id: 'mountain-metric-plan', type: 'plan', name: '按尺寸绘制', width: 120000, height: 90000, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' },
    calibration: { metersPerPixel: .01, method: 'metric-plan' }, regions: [], walls: [], furniture: [], serviceRoutes: [], openings: [], civilElements: [], wallHeight: 280, wallThickness: 20,
    additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 },
    budget: { client: '验收甲方', reference: 'SD-20261108', note: '验证几何与用户单价，非市场报价', included: { decoration: false, civil: false, municipal: true } },
    municipalTerrain: { name: '210 m 山地', sourceName: '验收用确定性概念地形，非实测', visible: true, points: [], raster: { format: 'esri-ascii', ncols: 21, nrows: 16, xllcorner: -10, yllcorner: -310, originX: -10, originY: -10, cellSize: 20, noDataValue: -9999, coordinateUnit: 'm', yDirection: 'north-up', values } },
    municipalElements: [
      element('穿山道路', 'road', [{ x: 5000, y: 16000 }, { x: 35000, y: 16000 }]),
      element('山边路灯', 'streetlight', [{ x: 6000, y: 22000 }], { width: 20, depth: 20, height: 600, elevation: 0, unit: '件', items: undefined }),
    ],
  };
}

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Isolated server startup timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getProject && window.planStudio?.getQuote);
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const quote = () => page.evaluate(() => window.planStudio.getQuote());
  const budget = () => page.evaluate(() => window.planStudio.getProjectBudget());
  const stats = () => page.evaluate(() => window.planStudio.get3DStats());
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const element = async id => (await project()).municipalElements.find(item => item.id === id);
  const row = async id => (await quote()).municipalElements.find(item => item.id === id);
  const select = async id => {
    await page.locator(`#left-panel [data-action="select-municipal"][data-id="${id}"]`).click(); await frame();
    assert.equal((await page.evaluate(() => window.planStudio.getSelection())).municipalElementId, id);
  };
  const close = async () => { await page.locator('#dialog [data-dialog-close]').click(); await page.waitForFunction(() => !document.querySelector('#dialog')?.open); };
  const submit = async id => { await page.locator(`${id} [type="submit"]`).click(); await page.waitForFunction(() => !document.querySelector('#dialog')?.open); await frame(); };
  const importJSON = async (text, name) => {
    await page.locator('#open-project').click(); const event = page.waitForEvent('filechooser');
    await page.locator('#dialog [data-action="import-project"]').click(); const chooser = await event;
    await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('完整项目已导入') && document.querySelector('#project-file').value === ''); await frame();
  };
  const download = async (format, name) => {
    await page.locator('#export').click(); const event = page.waitForEvent('download'); await page.locator(`[data-export="${format}"]`).click(); const file = await event;
    assert.equal(await file.failure(), null); const target = join(artifacts, name); await file.saveAs(target); return readFile(target, 'utf8');
  };
  const screenshot = async name => { await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible')); await frame(); await page.screenshot({ path: join(artifacts, name) }); };
  const endpoints = async (start, end) => {
    await select('穿山道路'); await page.locator('#inspector [data-action="site-endpoints"]').click();
    await page.locator('#site-endpoint-start').fill(String(start)); await page.locator('#site-endpoint-end').fill(String(end)); await submit('#site-endpoints-form');
  };
  const tunnelFields = async fields => {
    for (const [key, value] of Object.entries(fields)) {
      const input = page.locator(`#site-tunnel-form [data-tunnel-field="${key}"]`);
      if (typeof value === 'boolean') await input.setChecked(value);
      else if (key === 'shape') await input.selectOption(value);
      else await input.fill(String(value));
    }
    await frame();
  };
  const create = async (kind, fields, heightMode) => {
    const before = new Set((await project()).municipalElements.map(item => item.id));
    await page.locator('#left-panel [data-action="quick-municipal"]').first().click(); await page.locator('#municipal-quick-kind').selectOption(kind);
    if(heightMode)await page.locator('#municipal-quick-placement').selectOption(heightMode);
    for (const [key, value] of Object.entries(fields)) await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
    await submit('#municipal-quick-form'); const added = (await project()).municipalElements.filter(item => !before.has(item.id));
    assert.equal(added.length, 1, 'One UI submission must add one facility'); assert.equal(added[0].kind, kind);
    await page.locator('#municipal-unitPrice').fill('0'); await page.locator('#municipal-unitPrice').press('Tab'); await frame();
    return element(added[0].id);
  };
  const show3D = async () => { if (await page.evaluate(() => window.planStudio.getViewMode()) !== '3d') await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready); await frame(); };
  const pixels = () => page.evaluate(() => {
    const canvas = document.querySelector('#viewer3d canvas'), gl = canvas.getContext('webgl'); gl.finish();
    const values = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values);
    let colored = 0; for (let i = 0; i < values.length; i += 4) if (Math.max(values[i], values[i + 1], values[i + 2]) - Math.min(values[i], values[i + 1], values[i + 2]) > 12) colored++;
    return { colored, error: gl.getError() };
  });

  const source = fixture(); await writeFile(join(artifacts, 'input-project.json'), JSON.stringify(source, null, 2));
  await importJSON(JSON.stringify(source), '山地工程验收.json');
  near((await project()).municipalTerrain.raster.values[8 * 21 + 10], 210);
  assert.equal((await project()).municipalElements.length, 2); assert.equal((await budget()).total, '0.00');
  await select('穿山道路'); near(await page.locator('#site-elevation').inputValue(), 30);
  assert.match(await page.locator('#site-elevation-note').innerText(), /30\.00 m/);
  pass('通过真实文件选择导入210m山体、300m道路及路灯，全部费用明确为零且标高界面采用米制');

  await page.locator('#site-elevation').fill('32.5'); await page.locator('#site-elevation').press('Tab'); await frame();
  near((await element('穿山道路')).elevation, 3250);
  await page.locator('#inspector [data-action="site-shift"][data-delta="1"]').click(); await frame(); near((await element('穿山道路')).elevation, 3350);
  await page.locator('#inspector [data-action="site-shift"][data-delta="-1"]').click(); await frame(); near((await element('穿山道路')).elevation, 3250);
  await endpoints(30, 36);
  const grade = await element('穿山道路'); assert.deepEqual(grade.roadProfile.points.map(point => [point.station, point.elevation]), [[0, 30], [300, 36]]);
  await page.locator('#site-elevation').fill('40'); await page.locator('#site-elevation').press('Tab'); await frame();
  assert.deepEqual((await element('穿山道路')).roadProfile.points.map(point => point.elevation), [40, 46]);
  await page.locator('#undo').click(); await frame(); assert.deepEqual(await element('穿山道路'), grade);
  pass('米制输入和±1m即时更新厘米数据；起终点30→36m形成真实2%纵坡，整体升降保持高差且一次撤销恢复');

  await page.locator('#inspector [data-action="site-align"]').click(); await page.locator('#site-align-offset').fill('.3');
  assert.equal(await page.locator('#site-align-follow').isChecked(), true); await submit('#site-align-form');
  const followed = await element('穿山道路'); assert.ok(followed.roadProfile.points.length > 2);
  const summit = followed.roadProfile.points.find(point => Math.abs(point.station - 150) < 1e-7); assert.ok(summit, 'Actual sampled mountain crest must remain a grade control'); near(summit.elevation, 210.3);
  assert.deepEqual(followed.points, grade.points); assert.equal(followed.unitPrice, grade.unitPrice);
  await page.locator('#undo').click(); await frame(); assert.deepEqual(await element('穿山道路'), grade);
  await select('山边路灯'); await page.locator('#inspector [data-action="site-align"]').click(); await page.locator('#site-align-offset').fill('1.25'); await submit('#site-align-form');
  near((await element('山边路灯')).elevation / 100, source.municipalTerrain.raster.values[11 * 21 + 3] + 1.25);
  pass('道路贴地保留真实210.3m山峰并可整体撤销；路灯使用真实锚点地形高程加1.25m，未捏造区域高程');

  const modeBefore = await project(); await page.locator('#site-placement-mode').selectOption('terrain'); await frame(); assert.deepEqual(await project(), modeBefore);
  const terrainRoad = await create('road', { x: 60, y: 100, length: 240, angle: 0, width: 600, height: 5, elevation: 0 });
  assert.equal(terrainRoad.roadProfile?.enabled, true, 'Terrain placement must actually generate a road profile');
  for (const point of terrainRoad.roadProfile.points) {
    const x = 60 + point.station, column = Math.min(19, Math.floor(x / 20)), t = (x - column * 20) / 20;
    const left = source.municipalTerrain.raster.values[5 * 21 + column], right = source.municipalTerrain.raster.values[5 * 21 + column + 1];
    near(point.elevation, left + (right - left) * t);
  }
  const terrainLamp = await create('streetlight', { x: 80, y: 220, width: 20, height: 600, elevation: 0 });
  near(terrainLamp.elevation / 100, source.municipalTerrain.raster.values[11 * 21 + 4]);
  await page.locator('#site-placement-mode').selectOption('manual'); await page.locator('#site-placement-elevation').fill('75'); await page.locator('#site-placement-elevation').press('Tab');
  const manualRoad = await create('road', { x: 50, y: 270, length: 100, angle: 0, width: 600, height: 5, elevation: 7500 });
  near(manualRoad.elevation, 7500); assert.equal(Boolean(manualRoad.roadProfile?.enabled), false);
  const manualLamp = await create('streetlight', { x: 360, y: 250, width: 20, height: 600, elevation: 7500 }); near(manualLamp.elevation, 7500);
  await page.locator('#site-placement-mode').selectOption('terrain');
  const popupLamp=await create('streetlight',{x:340,y:280,width:20,height:600,elevation:12500},'manual');near(popupLamp.elevation,12500);assert.equal(await page.locator('#site-placement-mode').inputValue(),'manual');near(await page.locator('#site-placement-elevation').inputValue(),125);
  evidence.placements = { terrainRoad, terrainLamp, manualRoad, manualLamp, popupLamp };
  assert.deepEqual(await element('穿山道路'), grade);
  pass('新建贴地道路按原栅格真实折坡、路灯落地；手动模式道路和路灯采用75m，切换放置方式不改旧对象');

  await select('穿山道路'); await page.locator('#inspector [data-action="site-tunnel"]').click();
  const tunnelBefore = await element('穿山道路');
  await tunnelFields({endStation:400});assert.match(await page.locator('#site-tunnel-error').innerText(),/超出/);assert.match(await page.locator('#site-tunnel-analysis').innerText(),/参数无效/);assert.equal(await page.locator('#site-tunnel-analysis .stat-row').count(),0);assert.deepEqual(await element('穿山道路'),tunnelBefore);
  await tunnelFields({ enabled: true, startStation: 50, endStation: 250, clearHeight: 5.5, liningThickness: .45, shape: 'box', pricingEnabled: true, unitPrice: '12.50', laborRate: '2.75', additionalCost: '80.10' });
  assert.deepEqual(await element('穿山道路'), tunnelBefore, 'Tunnel preview must remain an unapplied draft');
  const length = Math.hypot(200, 4), materialCost = roundedMoney(length * 12.5), laborCost = roundedMoney(length * 2.75);
  await submit('#site-tunnel-form'); const tunnelRoad = await element('穿山道路'), tunnelRow = await row('穿山道路'), charge = tunnelRow.items.find(item => item.category === 'tunnel');
  assert.ok(charge); assert.equal(charge.id, '穿山道路:tunnel'); near(charge.netQuantity, length, 1e-7);
  assert.equal(charge.materialCost, materialCost); assert.equal(charge.laborCost, laborCost); assert.equal(charge.additionalCost, '80.10'); assert.equal(charge.total, '3130.71');
  assert.equal((await quote()).total, '3130.71'); near(tunnelRow.tunnelEngineering.length, length); near(tunnelRow.tunnelEngineering.horizontalLength, 200);
  assert.deepEqual(tunnelRoad.tunnel, { enabled: true, startStation: 50, endStation: 250, clearHeight: 5.5, liningThickness: .45, shape: 'box', pricingEnabled: true, unitPrice: '12.50', laborRate: '2.75', additionalCost: '80.10' });
  await page.locator('#undo').click(); await frame(); assert.deepEqual(await element('穿山道路'), tunnelBefore); assert.equal((await quote()).total, '0.00');
  await page.locator('#redo').click(); await frame(); assert.deepEqual(await element('穿山道路'), tunnelRoad); assert.equal((await quote()).total, '3130.71');
  pass('50–250m隧道净高5.5m、衬砌0.45m；真实长度hypot(200,4)计价2500.50+550.11+80.10=3130.71，草稿/撤销/重做准确');

  await page.locator('#inspector [data-action="site-tunnel"]').click(); await tunnelFields({ shape: 'arch' }); await submit('#site-tunnel-form');
  assert.equal((await element('穿山道路')).tunnel.shape, 'arch'); assert.equal((await quote()).total, '3130.71');
  await page.locator('#inspector [data-action="site-tunnel"]').click(); await tunnelFields({ unitPrice: '' }); await submit('#site-tunnel-form');
  const pending = (await row('穿山道路')).items.find(item => item.category === 'tunnel'); assert.equal(pending.materialCost, null); assert.equal(pending.pending, true); assert.equal((await quote()).pending, true);
  await page.locator('#undo').click(); await frame(); assert.equal((await quote()).total, '3130.71');
  await page.locator('#inspector [data-action="site-tunnel"]').click(); await tunnelFields({ pricingEnabled: false }); await submit('#site-tunnel-form');
  assert.equal((await row('穿山道路')).items.some(item => item.category === 'tunnel'), false); assert.equal((await quote()).total, '0.00');
  await page.locator('#undo').click(); await frame(); assert.equal((await quote()).total, '3130.71');
  pass('矩形与拱形净空均可设置；空单价保持待确认，关闭独立计费只移除费用，撤销恢复正式3130.71报价');

  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const saved = await project(), savedBudget = await budget(), savedQuote = await quote(), savedStatus = await page.locator('#save-status').innerText();
  await show3D(); await page.locator('#fit').click(); await frame();
  const modes = [];
  for (const mode of ['solid', 'cutaway', 'hidden', 'solid']) {
    await page.locator('#terrain-display-' + mode).click(); await frame(); const state = await stats(), image = await pixels();
    assert.equal(state.terrainDisplayMode, mode); assert.equal(await page.locator('#terrain-display-' + mode).getAttribute('aria-pressed'), 'true');
    assert.equal(state.terrainOccludesPicking, mode === 'solid'); assert.equal(state.terrainRenderedDrawBatches, mode === 'hidden' ? 0 : 1);
    assert.ok(image.colored > 100); assert.equal(image.error, 0); assert.equal(state.glError, 0);
    assert.deepEqual(await project(), saved); assert.deepEqual(await budget(), savedBudget); assert.deepEqual(await quote(), savedQuote); assert.equal(await page.locator('#save-status').innerText(), savedStatus);
    modes.push({ mode, image, triangleCount: state.terrainTriangleCount });
    if (mode !== 'hidden') await screenshot(`mountain-tunnel-${mode}-1440.png`);
  }
  const clickTunnel=async()=>{const at=await page.evaluate(()=>{const canvas=document.querySelector('#viewer3d canvas'),box=canvas.getBoundingClientRect();return [140,160,180,200,220,240,260].map(x=>{const p=window.planStudio.toScreen3D({x,y:30+(x-50)*.02+5.5,z:160});return{...p,x:p.x+box.left,y:p.y+box.top};}).find(p=>p.visible&&document.elementFromPoint(p.x,p.y)===canvas);});assert.ok(at,'A real buried tunnel surface must be clickable outside floating controls');await page.mouse.click(at.x,at.y);await frame();return page.evaluate(()=>window.planStudio.getSelection().municipalElementId);};
  await select('山边路灯');await page.locator('#terrain-display-solid').click();assert.equal((await stats()).terrainDisplayMode,'solid');assert.notEqual(await clickTunnel(),'穿山道路','Solid terrain must block underground tunnel picking');
  await page.locator('#terrain-display-cutaway').click();assert.equal((await stats()).terrainDisplayMode,'cutaway','Mode button must apply on a focused canvas');assert.equal(await clickTunnel(),'穿山道路','Cutaway must permit actual tunnel selection');assert.equal((await stats()).terrainDisplayMode,'cutaway','Selection must preserve cutaway');
  await select('山边路灯');await page.locator('#terrain-display-hidden').click();assert.equal(await clickTunnel(),'穿山道路','Hidden terrain must permit actual tunnel selection');
  await page.locator('#terrain-display-solid').click();
  await select('穿山道路');
  await page.locator('#inspector [data-action="site-tunnel-view"][data-position="start"]').click(); await frame();
  const portalCamera = (await stats()).camera; assert.ok([portalCamera.eye.x, portalCamera.eye.y, portalCamera.eye.z].every(Number.isFinite)); await screenshot('tunnel-entry-1440.png');
  await page.locator('#inspector [data-action="site-tunnel-view"][data-position="inside"]').click(); await frame();
  const inside = await stats(); assert.notDeepEqual(inside.camera.eye, portalCamera.eye); assert.ok(inside.camera.eye.y < 100, 'Tunnel camera must remain inside the actual low roadway, rather than on the 210m mountain');
  const insidePixels = await pixels(); assert.ok(insidePixels.colored > 100); assert.equal(insidePixels.error, 0); await screenshot('tunnel-inside-1440.png');
  assert.deepEqual(await project(), saved); assert.deepEqual(await budget(), savedBudget); assert.equal(await page.locator('#save-status').innerText(), savedStatus);
  evidence.views = { modes, portalCamera, insideCamera: inside.camera, insidePixels };
  pass('实景/剖视/隐藏切换只影响渲染与遮挡，不改工程、报价或保存状态；入口/洞内相机定位真实隧道并绘出WebGL像素');

  const csv = parseCSV(await download('csv', '山地工程报价.csv')), exportedTunnel = csv.find(cells => cells[5] === '隧道综合施工');
  assert.ok(exportedTunnel); assert.equal(exportedTunnel[6], 'm'); assert.match(exportedTunnel[7], /真实三维/); near(exportedTunnel[8], length, 1e-7);
  assert.equal(exportedTunnel[10], '12.50'); assert.equal(exportedTunnel[13], '2500.50'); assert.equal(exportedTunnel[14], '550.11'); assert.equal(exportedTunnel[15], '80.10'); assert.equal(exportedTunnel[18], '3130.71');
  assert.match(exportedTunnel[24], /净高|净空/); assert.match(exportedTunnel[24], /衬砌/);
  const json = await download('json', '山地工程项目.json'), exported = JSON.parse(json);
  assert.deepEqual(exported.municipalTerrain, saved.municipalTerrain); assert.deepEqual(exported.municipalElements, saved.municipalElements);
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); await frame();
  assert.deepEqual((await project()).municipalElements, saved.municipalElements); assert.deepEqual((await project()).municipalTerrain, saved.municipalTerrain); assert.equal((await quote()).total, '3130.71');
  await importJSON(json, '山地工程项目.json'); assert.deepEqual((await project()).municipalElements, exported.municipalElements); assert.equal((await quote()).total, '3130.71');
  pass('真实CSV下载列出三维隧道长度和独立价；本机保存重开、完整JSON下载再导入保留地形、标高、净空与3130.71报价');

  const overflow = [];
  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 1000 }); await select('穿山道路'); await frame();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const panel = await page.locator('.site-elevation, .site-actions').evaluateAll(nodes => nodes.map(node => ({ name: node.className, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })));
    for (const check of panel) assert.ok(check.scrollWidth <= check.clientWidth + 1, `${width}px ${check.name} overflow`);
    const dialogChecks = [];
    for (const [action, form] of [['site-endpoints', '#site-endpoints-form'], ['site-align', '#site-align-form'], ['site-tunnel', '#site-tunnel-form']]) {
      await page.locator(`#inspector [data-action="${action}"]`).click(); await page.locator(form).waitFor(); await frame();
      const checks = await page.locator(`${form}, ${form} .field-grid, ${form} .input-affix, #dialog .dialog-body`).evaluateAll(nodes => nodes.map(node => ({ name: node.id || node.className, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })));
      for (const check of checks) assert.ok(check.scrollWidth <= check.clientWidth + 1, `${width}px ${form} ${check.name} overflow`);
      const controls = await page.locator(`${form} input, ${form} select, ${form} button`).evaluateAll(nodes => {
        const box = nodes[0]?.closest('form').getBoundingClientRect(); return nodes.map(node => { const r = node.getBoundingClientRect(); return { id: node.id || node.dataset.tunnelField || node.type, inside: r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1 }; });
      });
      for (const control of controls) assert.equal(control.inside, true, `${width}px ${form} ${control.id} outside form`);
      await page.locator(`${form} [type="submit"]`).scrollIntoViewIfNeeded(); assert.ok(await page.locator(`${form} [type="submit"]`).isVisible());
      await screenshot(`${action}-${width}.png`); dialogChecks.push({ form, checks, controls }); await close();
    }
    overflow.push({ width, panel, dialogChecks });
  }
  assert.deepEqual(errors, []); evidence.overflow = overflow;
  pass('1440/1100/900px标高、贴地、起终点和隧道控件无横向溢出，主要提交按钮可达且浏览器无未捕获错误');
  outcome = 'passed'; await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, errors, evidence, quote: savedQuote }, null, 2));
  process.stdout.write(`\n${reports.length} 项山地道路、标高与隧道浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  const state = page ? await page.evaluate(() => ({ project: window.planStudio?.getProject(), quote: window.planStudio?.getQuote(), stats: window.planStudio?.get3DStats(), toast: document.querySelector('#toast')?.textContent, dialog: document.querySelector('#dialog')?.innerText })).catch(() => ({})) : {};
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, errors, stderr, state }, null, 2)); throw error;
} finally {
  if (browser) { await browser.close(); browserClosed = true; }
  if (server.exitCode === null && server.signalCode === null) { server.kill(); await new Promise(done => { if (server.exitCode !== null || server.signalCode !== null) done(); else server.once('exit', done); }); }
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: server.exitCode !== null || server.signalCode !== null, isolatedStorage: storage, checks: reports.length, errors, stderr }, null, 2));
}
