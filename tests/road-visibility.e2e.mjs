import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Real file pickers, scene controls, and visibility buttons operate the built
// app. App hooks only read project/quote/scene evidence; no geometry is injected.
// A single road per fixture makes hidden/show pixel changes attributable to it.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/road-visibility');
await mkdir(artifacts, { recursive: true });
const source = baseFixture();
const storage = await mkdtemp(join(tmpdir(), 'studio-road-visibility-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page, stderr = '', outcome = 'failed', browserClosed = false;
const reports = [], errors = [], evidence = [];
server.stderr.on('data', chunk => { stderr += chunk; });
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };

function baseFixture() {
  // Deterministic metric terrain shared in shape with mountain-placement's
  // acceptance fixture; no prior test run or generated artifact is required.
  const values = Array.from({ length: 21 * 16 }, (_, i) => {
    const x = i % 21 * 20, y = Math.floor(i / 21) * 20;
    return 30 + Math.max(0, 1 - Math.hypot(x - 200, y - 160) / 140) * 180;
  });
  return {
    version: 1, id: 'road-visibility-base', name: '道路可见性验收', workspaceMode: 'municipal',
    drawing: {
      id: 'road-visibility-metric-plan', type: 'plan', name: '按尺寸绘制', width: 120000, height: 90000,
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    },
    calibration: { metersPerPixel: .01, method: 'metric-plan' },
    regions: [], walls: [], furniture: [], serviceRoutes: [], openings: [], civilElements: [], wallHeight: 280, wallThickness: 20,
    additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 },
    budget: {
      client: '验收甲方', reference: 'ROAD-VISIBILITY', note: '确定性几何验收，非市场报价',
      included: { decoration: false, civil: false, municipal: true },
    },
    municipalTerrain: {
      name: '210 m 山地', sourceName: '验收用确定性概念地形，非实测', visible: true, points: [],
      raster: {
        format: 'esri-ascii', ncols: 21, nrows: 16, xllcorner: -10, yllcorner: -310, originX: -10, originY: -10,
        cellSize: 20, noDataValue: -9999, coordinateUnit: 'm', yDirection: 'north-up', values,
      },
    },
    municipalElements: [{
      id: '穿山道路', name: '穿山道路', kind: 'road', points: [{ x: 5000, y: 16000 }, { x: 35000, y: 16000 }], holes: [],
      width: 600, depth: 20, height: 5, elevation: 3000, quantity: '1', unit: 'm²',
      unitPrice: '0', wasteRate: '0', laborRate: '0', additionalCost: '0', hidden: false, locked: false, items: [],
    }],
  };
}

function fixture(name, { flat = false, tunnel, oversized = false, empty = false } = {}) {
  const project = structuredClone(source);
  project.id = `road-visibility-${name}`;
  project.name = `道路可见性 · ${name}`;
  project.municipalElements = empty ? [] : [structuredClone(source.municipalElements.find(item => item.kind === 'road'))];
  if (flat || oversized) project.municipalTerrain.raster.values.fill(30);
  if (oversized) {
    // 100 times the original horizontal terrain extent, with the same 300m road.
    const raster = project.municipalTerrain.raster;
    raster.cellSize *= 100;
    raster.yllcorner = raster.originY - raster.cellSize * (raster.nrows - 1);
    project.municipalTerrain.name = '道路周围 100 倍范围地形';
  }
  if (!empty) {
    const road = project.municipalElements[0];
    road.id = `road-${name}`;
    road.name = `验收道路 · ${name}`;
    road.unitPrice = road.laborRate = road.additionalCost = '0';
    if (tunnel) {
      road.roadProfile = {
        enabled: true,
        points: [{ id: `${name}-start`, station: 0, elevation: 30 }, { id: `${name}-end`, station: 300, elevation: 36 }],
        sampleInterval: 10,
        earthwork: { enabled: false, cutUnitPrice: '', fillUnitPrice: '' },
      };
      road.tunnel = {
        enabled: true, startStation: 50, endStation: 250, clearHeight: 5.5,
        liningThickness: .45, shape: tunnel, pricingEnabled: false,
        unitPrice: '', laborRate: '0', additionalCost: '0',
      };
    }
  }
  return project;
}

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Isolated server startup timeout')), 20000);
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
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
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio?.getProject && window.planStudio?.get3DStats);

  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const quote = () => page.evaluate(() => window.planStudio.getQuote());
  const stats = () => page.evaluate(() => window.planStudio.get3DStats());
  const snapshot = async () => ({ project: await project(), quote: await quote() });
  const unchanged = async (before, name) => {
    assert.deepEqual(await project(), before.project, `${name}: view controls changed the project`);
    assert.deepEqual(await quote(), before.quote, `${name}: view controls changed the quote`);
  };
  const importProject = async input => {
    if (await page.evaluate(() => window.planStudio.getViewMode()) === '3d') {
      await page.locator('[data-view="2d"]').click(); await frame();
    }
    await writeFile(join(artifacts, `${input.id}.json`), JSON.stringify(input, null, 2));
    await page.locator('#open-project').click();
    const event = page.waitForEvent('filechooser');
    await page.locator('#dialog [data-action="import-project"]').click();
    const chooser = await event;
    await chooser.setFiles({ name: `${input.name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input), 'utf8') });
    await page.waitForFunction(id => window.planStudio.getProject().id === id && document.querySelector('#project-file').value === '', input.id);
    await frame();
  };
  const select = async id => {
    await page.locator(`#left-panel [data-action="select-municipal"][data-id="${id}"]`).click();
    await frame();
    assert.equal(await page.evaluate(() => window.planStudio.getSelection().municipalElementId), id);
  };
  const show3D = async () => {
    await page.locator('[data-view="3d"]').click();
    await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
    await frame();
  };
  const clickView = async selector => {
    const before = await snapshot();
    await page.locator(selector).click(); await frame();
    await unchanged(before, selector);
  };
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await frame();
    await page.screenshot({ path: join(artifacts, name) });
  };

  // The road base color is #596562 and the shader applies a .76–1 light factor.
  // Bounds allow cutaway blending and raster rounding, but exclude white clear
  // pixels, grey-white lining and the selected teal outline. Lining assertions
  // run with terrain hidden, so terrain cannot supply their light green pixels.
  const pixels = (raw = false) => page.evaluate(includeRaw => {
    const canvas = document.querySelector('#viewer3d canvas'), gl = canvas.getContext('webgl');
    gl.finish();
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let road = 0, lining = 0;
    const roadBounds = { minX: canvas.width, minY: canvas.height, maxX: -1, maxY: -1 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= 55 && r <= 120 && g >= 65 && g <= 130 && b >= 60 && b <= 125 && g - r >= 5 && g - r <= 18 && g - b >= 1 && g - b <= 11) {
        road++;
        const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
        roadBounds.minX = Math.min(roadBounds.minX, x); roadBounds.maxX = Math.max(roadBounds.maxX, x);
        roadBounds.minY = Math.min(roadBounds.minY, y); roadBounds.maxY = Math.max(roadBounds.maxY, y);
      }
      if (r >= 115 && r <= 205 && g >= 125 && g <= 215 && b >= 115 && b <= 205 && g - r >= 1 && g - r <= 20 && g - b >= 1 && g - b <= 20) lining++;
    }
    let base64;
    if (includeRaw) {
      let binary = '';
      for (let i = 0; i < data.length; i += 16384) binary += String.fromCharCode(...data.subarray(i, i + 16384));
      base64 = btoa(binary);
    }
    return { width: canvas.width, height: canvas.height, road, lining, roadBounds, error: gl.getError(), ...(includeRaw ? { base64 } : {}) };
  }, raw);
  const assertRoadPixels = async (name, minimum = 200) => {
    const result = await pixels();
    assert.equal(result.error, 0, `${name}: WebGL error`);
    assert.ok(result.road >= minimum, `${name}: road-face pixels ${result.road} < ${minimum}`);
    return result;
  };
  const projection = async (name, point) => {
    const result = await page.evaluate(value => {
      const canvas = document.querySelector('#viewer3d canvas'), projected = window.planStudio.toScreen3D(value);
      return { projected, width: canvas.clientWidth, height: canvas.clientHeight };
    }, point);
    assert.ok(result.projected?.visible, `${name}: road is behind the camera`);
    assert.ok(result.projected.x >= 0 && result.projected.x <= result.width && result.projected.y >= 0 && result.projected.y <= result.height, `${name}: road midpoint is outside the actual canvas`);
    return result;
  };
  const visibilityDifference = async (id, name) => {
    await clickView('#terrain-display-hidden');
    const before = await snapshot(), beforeCamera = (await stats()).camera;
    const shown = await pixels(true);
    assert.ok(shown.road >= 200, `${name}: no road face before hiding`);
    await page.locator(`#left-panel [data-action="toggle-municipal"][data-id="${id}"]`).click(); await frame();
    assert.equal((await project()).municipalElements.find(item => item.id === id).hidden, true);
    assert.deepEqual((await stats()).camera, beforeCamera, `${name}: hiding the only road moved the camera`);
    const hidden = await pixels(true);
    assert.ok(hidden.road < 20, `${name}: hidden road still contributed ${hidden.road} road-color pixels`);
    const a = Buffer.from(shown.base64, 'base64'), b = Buffer.from(hidden.base64, 'base64');
    assert.equal(a.length, b.length);
    let changed = 0, roadChanged = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 12) {
        changed++;
        const r = a[i], g = a[i + 1], blue = a[i + 2];
        if (r >= 55 && r <= 120 && g >= 65 && g <= 130 && blue >= 60 && blue <= 125 && g - r >= 5 && g - r <= 18 && g - blue >= 1 && g - blue <= 11) roadChanged++;
      }
    }
    assert.ok(changed >= 300, `${name}: only ${changed} framebuffer pixels changed on hiding`);
    assert.ok(roadChanged >= 200, `${name}: only ${roadChanged} road-face pixels disappeared`);
    await page.locator(`#left-panel [data-action="toggle-municipal"][data-id="${id}"]`).click(); await frame();
    await unchanged(before, `${name}: visibility restored`);
    assert.deepEqual((await stats()).camera, beforeCamera, `${name}: showing the road moved the camera`);
    const restored = await assertRoadPixels(`${name}: restored`);
    await screenshot(`${name}-hidden-terrain.png`);
    return { changed, roadChanged, shown: { ...shown, base64: undefined }, hidden: { ...hidden, base64: undefined }, restored };
  };

  const plain = fixture('plain', { flat: true });
  await importProject(plain); await select(plain.municipalElements[0].id);
  const plainBefore = await snapshot(); await show3D(); await unchanged(plainBefore, 'Plain road first 3D entry');
  const plainFirst = await assertRoadPixels('Plain road without manual fit');
  await screenshot('plain-first-3d.png');
  await clickView('#scene-road-overview');
  const plainProjection = await projection('Plain overview', { x: 200, y: 30, z: 160 });
  const plainDifference = await visibilityDifference(plain.municipalElements[0].id, 'plain');
  evidence.push({ case: 'plain', first: plainFirst, projection: plainProjection, difference: plainDifference });
  pass('平地上的普通道路首次进入三维无需手动适配；真实路面像素及眼睛隐藏/显示帧差证明道路实际绘出');

  for (const shape of ['arch', 'box']) {
    const input = fixture(`tunnel-${shape}`, { tunnel: shape });
    await importProject(input); await select(input.municipalElements[0].id);
    const before = await snapshot(); await show3D(); await unchanged(before, `${shape}: first 3D entry`);
    assert.equal((await stats()).terrainDisplayMode, 'cutaway', `${shape}: buried selected road must automatically be revealed`);
    const first = await assertRoadPixels(`${shape}: buried road without manual fit`);
    await screenshot(`${shape}-first-3d.png`);
    await clickView('#scene-road-overview');
    const overviewProjection = await projection(`${shape}: overview`, { x: 200, y: 33, z: 160 });
    const difference = await visibilityDifference(input.municipalElements[0].id, shape);
    const views = [];
    for (const [button, name] of [['#scene-tunnel-entry', 'entry'], ['#scene-tunnel-inside', 'inside']]) {
      await clickView(button); await clickView('#terrain-display-hidden');
      const image = await assertRoadPixels(`${shape}: ${name}`, 500);
      assert.ok(image.lining >= 500, `${shape}: ${name} has only ${image.lining} lining pixels`);
      const state = await stats();
      assert.ok(state.camera.eye.y < 50, `${shape}: ${name} camera must remain near the actual 30–36m roadway`);
      assert.equal(state.glError, 0);
      await screenshot(`${shape}-${name}.png`);
      views.push({ name, image, camera: state.camera });
    }
    await unchanged(before, `${shape}: all view operations`);
    evidence.push({ case: shape, first, projection: overviewProjection, difference, views });
    pass(`${shape === 'arch' ? '拱形' : '矩形'}埋地隧道首次三维自动剖视；洞口和洞内均实际绘出不同色域的路面与衬砌，查看不改工程或报价`);
  }

  const newRoadInput = fixture('new-terrain-road', { empty: true });
  await importProject(newRoadInput);
  await page.locator('#site-placement-mode').selectOption('terrain');
  await page.locator('#left-panel [data-action="quick-municipal"]').first().click();
  await page.locator('#municipal-quick-kind').selectOption('road');
  await page.locator('#municipal-quick-placement').selectOption('terrain');
  for (const [key, value] of Object.entries({ x: 60, y: 100, length: 240, angle: 0, width: 600, height: 5, elevation: 0 })) {
    await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
  }
  await page.locator('#municipal-quick-form [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog')?.open && window.planStudio.getProject().municipalElements.length === 1);
  await frame();
  const created = (await project()).municipalElements[0];
  assert.equal(created.kind, 'road'); assert.equal(created.roadProfile?.enabled, true);
  assert.ok(created.roadProfile.points.length > 2, 'New terrain-following road must keep real mountain grade controls');
  await select(created.id);
  const createdBefore = await snapshot(); await show3D(); await unchanged(createdBefore, 'New road first 3D entry');
  await clickView('#scene-road-overview'); await clickView('#terrain-display-hidden');
  const newFirst = await assertRoadPixels('New terrain-following road');
  const newDifference = await visibilityDifference(created.id, 'new-terrain-road');
  await unchanged(createdBefore, 'New terrain-following road view operations');
  evidence.push({ case: 'new-terrain-road', first: newFirst, difference: newDifference, road: created });
  pass('通过按尺寸添加真实新建贴地道路；保留山地纵断面，查看道路及眼睛帧差验证真实绘制，不靠固定导入几何');

  const oversized = fixture('oversized-terrain', { oversized: true });
  await importProject(oversized); await select(oversized.municipalElements[0].id);
  const oversizedBefore = await snapshot(); await show3D(); await unchanged(oversizedBefore, 'Oversized terrain first 3D entry');
  await clickView('#scene-road-overview'); await clickView('#terrain-display-hidden');
  const largeProjection = await projection('100x terrain road overview', { x: 200, y: 30, z: 160 });
  const largeImage = await assertRoadPixels('100x terrain road overview');
  const largeDifference = await visibilityDifference(oversized.municipalElements[0].id, 'oversized-terrain');
  await unchanged(oversizedBefore, '100x terrain view operations');
  evidence.push({ case: 'oversized-terrain', projection: largeProjection, image: largeImage, difference: largeDifference });
  pass('地形水平范围扩大100倍后，查看道路仍把真实道路定位于画布并绘出路面，不被全地形适配缩成不可见点');

  assert.deepEqual(errors, []);
  outcome = 'passed';
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, errors, evidence }, null, 2));
  process.stdout.write(`\n${reports.length} 项道路与隧道真实可见性验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  const state = page ? await page.evaluate(() => ({ project: window.planStudio?.getProject(), quote: window.planStudio?.getQuote(), stats: window.planStudio?.get3DStats(), toast: document.querySelector('#toast')?.textContent })).catch(() => ({})) : {};
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, errors, stderr, state }, null, 2));
  throw error;
} finally {
  if (browser) { await browser.close(); browserClosed = true; }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await new Promise(done => {
      if (server.exitCode !== null || server.signalCode !== null) done(); else server.once('exit', done);
    });
  }
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: server.exitCode !== null || server.signalCode !== null, isolatedStorage: storage, checks: reports.length, errors, stderr }, null, 2));
}
