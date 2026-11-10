import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Run against the built application. All changes use ordinary controls and
// actual pointer events. Read-only hooks collect evidence; no runtime patch,
// hidden write hook, build or module replacement is used by this suite.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/municipal-authoring');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-municipal-authoring-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '', browser, page, outcome = 'failed', browserClosed = false, serverStopped = false;
server.stderr.on('data', chunk => { stderr += chunk; });
const reports = [], runtimeErrors = [], evidence = {};
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-7) => assert.ok(
  Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) < tolerance,
  `${actual} != ${expected} (tolerance ${tolerance})`,
);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pointNear = (actual, expected, tolerance = 1e-7) => {
  near(actual.x, expected.x, tolerance); near(actual.y, expected.y, tolerance);
};
const cents = text => {
  assert.match(String(text), /^\d+\.\d{2}$/);
  return BigInt(String(text).replace('.', ''));
};
const money = amount => `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
const parseCSV = source => {
  const rows = [], row = []; let cell = '', quoted = false;
  source = source.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); cell = ''; rows.push([...row]); row.length = 0;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false, 'CSV quoted cells must be complete'); return rows;
};

function fixture() {
  const item = (id, kind, points, options = {}) => ({
    id, kind, name: id, points, holes: [], width: 600, depth: 20, height: 5,
    elevation: 0, quantity: '1', unit: 'm²', unitPrice: '0', wasteRate: '0',
    laborRate: '0', additionalCost: '0', hidden: false, locked: false, items: [], ...options,
  });
  return {
    version: 1, id: 'municipal-authoring-acceptance', name: '城市道路与设施工程', workspaceMode: 'municipal',
    drawing: { id: 'municipal-authoring-plan', name: '按尺寸绘制', type: 'plan', width: 120000, height: 90000,
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' },
    calibration: { metersPerPixel: .01, method: 'metric-plan' },
    regions: [], walls: [], furniture: [], civilElements: [], serviceRoutes: [], openings: [],
    wallHeight: 280, wallThickness: 20, additionalCost: '100', taxRate: '9',
    view: { labels: true, drawingOpacity: 1 },
    budget: { client: '验收甲方', reference: 'SZ-20261108', note: '测试单价由验收人员明确填写，不代表市场价格。',
      included: { decoration: false, civil: false, municipal: true } },
    municipalElements: [
      item('四支路口', 'intersection', [{ x: 5000, y: 5000 }], {
        width: 1500, roadLayout: { lanes: 4, laneWidth: 350, medianWidth: 100 },
        junction: { arms: 4, armLength: 1800, rotation: 0, islandRadius: 600 },
      }),
      item('旋转八支路口', 'intersection', [{ x: 22000, y: 12000 }], {
        width: 2900, roadLayout: { lanes: 8, laneWidth: 350, medianWidth: 100 },
        junction: { arms: 8, armLength: 4500, rotation: 22.5, islandRadius: 600 },
      }),
      item('四支环岛', 'roundabout', [{ x: 5000, y: 14000 }], {
        junction: { arms: 4, armLength: 1000, rotation: 0, islandRadius: 1200 },
      }),
      item('斜向桥梁', 'bridge', [{ x: 11000, y: 5000 }, { x: 14000, y: 6500 }], {
        width: 700, height: 50, elevation: 400,
        roadLayout: { lanes: 2, laneWidth: 350, medianWidth: 0 },
        bridgeOptions: { pierSpacing: 1000, pierHeight: 400, railingHeight: 110,
          pierPricingEnabled: false, railingPricingEnabled: false, pierUnitPrice: '', railingUnitPrice: '' },
      }),
    ],
  };
}

// Check actual generated line segments against the interior of an approach
// end cap. This independent vector check detects a kerb blocking its entrance.
function segmentHitsCap(a, b, c, d) {
  const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: d.x - c.x, y: d.y - c.y };
  const w = { x: c.x - a.x, y: c.y - a.y };
  const cross = (p, q) => p.x * q.y - p.y * q.x;
  const determinant = cross(u, v), epsilon = 1e-8;
  if (Math.abs(determinant) > epsilon) {
    const t = cross(w, v) / determinant, s = cross(w, u) / determinant;
    return t >= -epsilon && t <= 1 + epsilon && s > epsilon && s < 1 - epsilon;
  }
  if (Math.abs(cross(w, u)) > epsilon || Math.hypot(v.x, v.y) < epsilon) return false;
  const square = v.x * v.x + v.y * v.y;
  const position = p => ((p.x - c.x) * v.x + (p.y - c.y) * v.y) / square;
  return Math.max(Math.min(position(a), position(b)), epsilon) < Math.min(Math.max(position(a), position(b)), 1 - epsilon);
}
function assertClearCaps(kerbs, ports, scale) {
  for (const port of ports) {
    const half = port.widthCm * .01 / scale / 2;
    const normal = { x: -port.direction.y, y: port.direction.x };
    const a = { x: port.point.x + normal.x * half, y: port.point.y + normal.y * half };
    const b = { x: port.point.x - normal.x * half, y: port.point.y - normal.y * half };
    for (const kerb of kerbs) for (let index = 1; index < kerb.points.length; index++)
      assert.equal(segmentHitsCap(kerb.points[index - 1], kerb.points[index], a, b), false,
        `${kerb.id} must not block ${port.id}`);
  }
}

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Isolated test server startup timeout')), 20000);
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
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio?.getMunicipalConnections && window.planStudio?.getQuantities);
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const quote = () => page.evaluate(() => window.planStudio.getQuote());
  const budget = () => page.evaluate(() => window.planStudio.getProjectBudget());
  const connections = () => page.evaluate(() => window.planStudio.getMunicipalConnections());
  const element = async id => (await project()).municipalElements.find(item => item.id === id);
  const row = async id => (await quote()).municipalElements.find(item => item.id === id);
  const select = async id => {
    await page.locator(`#left-panel [data-action="select-municipal"][data-id="${id}"]`).click(); await frame();
    assert.equal((await page.evaluate(() => window.planStudio.getSelection())).municipalElementId, id);
  };
  const fill = async fields => {
    for (const [key, value] of Object.entries(fields)) {
      const input = page.locator('#municipal-' + key); await input.fill(String(value)); await input.press('Tab');
    }
    await frame();
  };
  const importThroughPicker = async (text, name) => {
    await page.locator('#open-project').click();
    const event = page.waitForEvent('filechooser'); await page.locator('#dialog [data-action="import-project"]').click();
    const chooser = await event; await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('完整项目已导入') && document.querySelector('#project-file').value === '');
    await frame();
  };
  const screen = async point => {
    const box = await page.locator('#drawing-canvas').boundingBox(); assert.ok(box, '2D canvas must be visible');
    const view = await page.evaluate(() => window.planStudio.getViewport());
    const result = { x: box.x + view.panX + point.x * view.zoom, y: box.y + view.panY + point.y * view.zoom };
    assert.ok(result.x > box.x && result.x < box.x + box.width && result.y > box.y && result.y < box.y + box.height,
      `Drawing point ${JSON.stringify(point)} must be inside the visible canvas: ${JSON.stringify(result)}`);
    return result;
  };
  const drag = async (start, end, alt = false, capture) => {
    const a = await screen(start), b = await screen(end);
    if (alt) await page.keyboard.down('Alt');
    try {
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 });
      if (capture) { await frame(); await page.screenshot({ path: join(artifacts, capture) }); }
      await page.mouse.up();
    }
    finally { if (alt) await page.keyboard.up('Alt'); }
    await frame();
  };
  const click = async point => { const at = await screen(point); await page.mouse.click(at.x, at.y); await frame(); };
  const newlyAdded = async before => (await project()).municipalElements.filter(item => !before.has(item.id));
  const ids = async () => new Set((await project()).municipalElements.map(item => item.id));
  const drawRoad = async (lanes, start, end, { alt = false, laneWidth, medianWidth, capture } = {}) => {
    const before = await ids(); await page.locator(`[data-road-lanes="${lanes}"]`).click();
    for (const [key, value] of Object.entries({ laneWidth, medianWidth })) if (value !== undefined) {
      const field = page.locator(`[data-road-draft-field="${key}"]`); await field.fill(String(value)); await field.press('Tab');
    }
    await drag(start, end, alt, capture);
    const created = await newlyAdded(before); assert.equal(created.length, 1, 'One drag must create exactly one road');
    assert.equal(created[0].kind, 'road'); return created[0];
  };
  const generateKerbs = async (targetId, action = 'municipal-kerbs') => {
    await select(targetId); const before = await ids();
    await page.locator(`#inspector [data-action="${action}"]`).click(); await frame();
    const created = await newlyAdded(before); assert.ok(created.length > 0, 'Actual kerb geometry must be generated');
    for (const item of created) { assert.equal(item.kind, 'kerb'); assert.equal(item.unit, 'm'); assert.equal(item.unitPrice, ''); }
    return created;
  };
  const catalog = async (id, search, group) => {
    await page.locator('#urban-catalog-group').selectOption(group);
    await page.locator('#urban-catalog-search').fill(search); await frame();
    const button = page.locator(`[data-municipal-catalog="${id}"]`); assert.equal(await button.count(), 1); await button.click();
  };
  const placeFacility = async (id, search, group, at) => {
    const before = await ids(); await catalog(id, search, group); await click(at);
    const created = await newlyAdded(before); assert.equal(created.length, 1); assert.equal(created[0].catalogId, id);
    assert.equal(created[0].kind, 'facility'); assert.equal(created[0].unitPrice, ''); return created[0];
  };
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await frame(); await page.screenshot({ path: join(artifacts, name) });
  };
  const download = async (format, filename) => {
    await page.locator('#export').click(); const event = page.waitForEvent('download');
    await page.locator(`[data-export="${format}"]`).click(); const file = await event;
    assert.equal(await file.failure(), null); await file.saveAs(join(artifacts, filename));
    return readFile(await file.path(), 'utf8');
  };

  const source = fixture(); await writeFile(join(artifacts, 'input-project.json'), JSON.stringify(source, null, 2));
  await importThroughPicker(JSON.stringify(source), '市政真实尺寸验收.json');
  assert.equal((await project()).id, source.id); assert.equal((await project()).calibration.metersPerPixel, .01);
  assert.equal((await project()).municipalElements.length, 4); assert.equal((await budget()).total, '109.00');
  assert.equal(await page.locator('[data-draw-municipal]').count(), 12);
  assert.equal(await page.locator('[data-municipal-catalog]').count(), 32);
  await page.locator('#fit').click(); await frame();
  const ports = await connections();
  assert.equal(ports.filter(port => port.targetId === '四支路口').length, 4);
  assert.equal(ports.filter(port => port.targetId === '旋转八支路口').length, 8);
  assert.equal(ports.filter(port => port.targetId === '四支环岛').length, 4);
  assert.equal(ports.filter(port => port.targetId === '斜向桥梁').length, 2);
  evidence.initialPorts = ports;
  pass('真实JSON导入米制场地、四/八支路口、环岛与斜桥；12个基础入口和32个城市设施预设可用，连接端口来自实际几何');

  const east = ports.find(port => port.targetId === '四支路口' && port.direction.x > .9);
  pointNear(east.point, { x: 6800, y: 5000 });
  const firstRoad = await drawRoad(4, { x: east.point.x + 80, y: east.point.y + 100 }, { x: 10000, y: 5050 }, { laneWidth: 3.5, medianWidth: 1, capture: 'road-connection-drag-preview.png' });
  pointNear(firstRoad.points[0], east.point); near(firstRoad.points[1].y, 5000);
  assert.equal(firstRoad.roadLayout.lanes, 4); assert.equal(firstRoad.width, 1500);
  near((await row(firstRoad.id)).area, 480); assert.equal((await row(firstRoad.id)).pending, true);
  evidence.fourLaneRoad = firstRoad;
  await page.locator('#left-panel').evaluate(node => node.scrollTop = 0);
  await screenshot('road-authoring-tools-1440.png');
  pass('一次鼠标拖拽画出双向四车道，附近起点精确吸附到路口端面，末点沿支路方向对齐；实际路宽15m、净面积480m²，价格待填');

  const diagonal = ports.find(port => port.targetId === '旋转八支路口' && port.direction.x < -.8 && port.direction.y < 0);
  const diagonalEnd = { x: diagonal.point.x + diagonal.direction.x * 2200, y: diagonal.point.y + diagonal.direction.y * 2200 };
  const eightRoad = await drawRoad(8, { x: diagonal.point.x + 80, y: diagonal.point.y - 80 }, diagonalEnd, { laneWidth: 3.2, medianWidth: .8 });
  pointNear(eightRoad.points[0], diagonal.point); assert.equal(eightRoad.roadLayout.lanes, 8); assert.equal(eightRoad.width, 2640);
  const vector = { x: eightRoad.points[1].x - eightRoad.points[0].x, y: eightRoad.points[1].y - eightRoad.points[0].y };
  near(vector.x * diagonal.direction.y - vector.y * diagonal.direction.x, 0, 1e-5);
  assert.ok(Math.abs(vector.x) > 1000 && Math.abs(vector.y) > 500, 'Rotated connection must retain a genuinely diagonal road');
  near((await row(eightRoad.id)).area, distance(eightRoad.points[0], eightRoad.points[1]) * .01 * 26.4, 1e-4);
  evidence.eightLaneRoad = eightRoad;
  pass('拖画双向八车道精确衔接旋转八支路口；单车道3.2m、分隔带0.8m形成26.4m路宽，保留用户尺寸与真实斜向工程量');

  const endpointRoad = await drawRoad(2, { x: 12500, y: 3500 }, { x: 10100, y: 4920 }, { laneWidth: 3.5, medianWidth: 0 });
  pointNear(endpointRoad.points.at(-1), firstRoad.points.at(-1)); assert.equal(endpointRoad.width, 700);
  const north = ports.find(port => port.targetId === '四支路口' && port.direction.y < -.9);
  const bypassRoad = await drawRoad(2, { x: north.point.x + 120, y: north.point.y - 100 }, { x: 5120, y: 1600 }, { alt: true });
  assert.ok(distance(bypassRoad.points[0], north.point) > 100, 'Holding Alt must bypass the nearby exact port');
  evidence.endpointRoad = endpointRoad; evidence.altBypassRoad = bypassRoad;
  pass('新道路末点准确连接已有道路端点；按住Alt时附近起点保持用户位置，绕过吸附');

  const bridgeEnd = ports.find(port => port.targetId === '斜向桥梁' && port.position === 'end');
  const beforeApproach = await ids(); await page.locator('[data-draw-municipal="road"]').click();
  await drag({ x: bridgeEnd.point.x + 80, y: bridgeEnd.point.y + 80 }, {
    x: bridgeEnd.point.x + bridgeEnd.direction.x * 2200, y: bridgeEnd.point.y + bridgeEnd.direction.y * 2200,
  });
  const approaches = await newlyAdded(beforeApproach); assert.equal(approaches.length, 1);
  const approach = approaches[0]; pointNear(approach.points[0], bridgeEnd.point);
  assert.equal(approach.width, 700); assert.equal(approach.elevation, 400);
  assert.deepEqual(approach.roadLayout, { lanes: 2, laneWidth: 350, medianWidth: 0 });
  const ringEnd = ports.find(port => port.targetId === '四支环岛' && port.direction.x > .9);
  const beforeRingRoad = await ids(); await page.locator('[data-draw-municipal="road"]').click();
  await drag({ x: ringEnd.point.x + 80, y: ringEnd.point.y + 80 }, { x: 10000, y: 14000 });
  const ringRoads = await newlyAdded(beforeRingRoad); assert.equal(ringRoads.length, 1);
  pointNear(ringRoads[0].points[0], ringEnd.point); assert.equal(ringRoads[0].width, 600); assert.equal(ringRoads[0].elevation, 0);
  evidence.bridgeApproach = approach; evidence.roundaboutApproach = ringRoads[0];
  pass('基础道路工具拖画桥梁引道时继承端口7m路宽、双向车道布局及4m标高；环岛引道准确衔接实际支路端面，显式车道配置仍由快选优先');

  const beforeKerbs = (await project()).municipalElements;
  const roadKerbs = await generateKerbs(firstRoad.id); assert.equal(roadKerbs.length, 2);
  for (const kerb of roadKerbs) { near((await row(kerb.id)).length, 32); near(Math.abs(kerb.points[0].y - 5000), 757.5); }
  assertClearCaps(roadKerbs, (await connections()).filter(port => port.targetId === firstRoad.id), .01);
  const afterKerbs = (await project()).municipalElements;
  await page.locator('#inspector [data-action="municipal-kerbs"]').click(); await frame();
  assert.deepEqual((await project()).municipalElements, afterKerbs, 'Repeated generation must not duplicate geometry');
  await page.locator('#undo').click(); await frame(); assert.deepEqual((await project()).municipalElements, beforeKerbs);
  await page.locator('#redo').click(); await frame(); assert.deepEqual((await project()).municipalElements, afterKerbs);
  const junctionKerbs = await generateKerbs('四支路口');
  assertClearCaps(junctionKerbs, ports.filter(port => port.targetId === '四支路口'), .01);
  const afterJunctionKerbs = (await project()).municipalElements;
  await page.locator('#inspector [data-action="municipal-kerbs"]').click(); await frame();
  assert.deepEqual((await project()).municipalElements, afterJunctionKerbs);
  const islandKerbs = await generateKerbs('四支环岛', 'municipal-island-kerbs');
  assert.equal(islandKerbs.length, 2);
  for (const kerb of islandKerbs) {
    assert.ok(kerb.points.length > 2 && distance(kerb.points[0], kerb.points.at(-1)) > 1);
    assert.ok(kerb.points.every(point => distance(point, { x: 5000, y: 14000 }) < 1200));
  }
  const afterIslandKerbs = (await project()).municipalElements;
  await page.locator('#inspector [data-action="municipal-island-kerbs"]').click(); await frame();
  assert.deepEqual((await project()).municipalElements, afterIslandKerbs);
  const bridgeKerbs = await generateKerbs('斜向桥梁'); assert.equal(bridgeKerbs.length, 2);
  for (const kerb of bridgeKerbs) assert.equal(kerb.elevation, 400);
  assertClearCaps(bridgeKerbs, ports.filter(port => port.targetId === '斜向桥梁'), .01);
  evidence.kerbs = { road: roadKerbs, junction: junctionKerbs, island: islandKerbs, bridge: bridgeKerbs };
  pass('道路两侧各生成真实32m路缘石，路口入口与桥梁端面保持畅通，环岛内侧围边和桥梁标高正确；重复生成不重复计量，整批可一次撤销重做');

  await page.locator('#urban-catalog-search').fill('长椅'); await page.locator('#urban-catalog-group').selectOption('utilities'); await frame();
  assert.equal(await page.locator('[data-municipal-catalog]').count(), 0);
  assert.equal(await page.locator('.urban-catalog-empty').isVisible(), true);
  const bench = await placeFacility('street-bench', '长椅', 'landscape', { x: 15000, y: 15000 });
  await fill({ name: '街边长椅 · 验收', quantity: 3, unitPrice: 1200, wasteRate: 10, laborRate: 80, additionalCost: 50, rotation: 35, width: 200, depth: 70, height: 95 });
  assert.equal((await element(bench.id)).rotation, 35); assert.equal((await element(bench.id)).quantity, '3');
  const benchRow = await row(bench.id); assert.equal(benchRow.netQuantity, '3'); assert.equal(benchRow.purchaseQuantity, '3.3');
  assert.equal(benchRow.materialCost, '3960.00'); assert.equal(benchRow.laborCost, '240.00'); assert.equal(benchRow.total, '4250.00');
  const charger = await placeFacility('ev-charger', '充电', 'transport', { x: 17000, y: 15000 });
  await fill({ unitPrice: 2500, laborRate: 350 }); assert.equal((await row(charger.id)).total, '2850.00');
  const tree = await placeFacility('street-tree', '行道树', 'landscape', { x: 13000, y: 15000 });
  await fill({ quantity: 2, unitPrice: 800, laborRate: 120 }); assert.equal((await row(tree.id)).total, '1840.00');
  assert.equal((await element(tree.id)).points.length, 1, 'Budget quantity must not create fake duplicate scene objects');
  const beforeGuardrail = await ids(); await catalog('road-guardrail', '护栏', 'transport');
  await drag({ x: 10000, y: 14000 }, { x: 14000, y: 14000 });
  const guardrails = await newlyAdded(beforeGuardrail); assert.equal(guardrails.length, 1); const guardrail = guardrails[0];
  assert.equal(guardrail.catalogId, 'road-guardrail'); assert.equal(guardrail.kind, 'fence'); assert.equal(guardrail.unit, 'm');
  await fill({ unitPrice: 35, wasteRate: 5, laborRate: 7, additionalCost: 25 });
  const guardrailRow = await row(guardrail.id); assert.equal(guardrailRow.netQuantity, '40'); assert.equal(guardrailRow.purchaseQuantity, '42');
  assert.equal(guardrailRow.materialCost, '1470.00'); assert.equal(guardrailRow.laborCost, '280.00'); assert.equal(guardrailRow.total, '1775.00');
  const beforeSidewalk = await ids(); await catalog('sidewalk', '人行道', 'transport');
  for (const point of [{ x: 9000, y: 9000 }, { x: 11000, y: 9000 }, { x: 11000, y: 10500 }, { x: 9000, y: 10500 }]) await click(point);
  await page.keyboard.press('Enter'); await frame(); const sidewalks = await newlyAdded(beforeSidewalk);
  assert.equal(sidewalks.length, 1); const sidewalk = sidewalks[0]; assert.equal(sidewalk.catalogId, 'sidewalk');
  await fill({ unitPrice: 45, wasteRate: 8, laborRate: 12, additionalCost: 100 });
  const sidewalkRow = await row(sidewalk.id); assert.equal(sidewalkRow.netQuantity, '300'); assert.equal(sidewalkRow.purchaseQuantity, '324');
  assert.equal(sidewalkRow.materialCost, '14580.00'); assert.equal(sidewalkRow.laborCost, '3600.00'); assert.equal(sidewalkRow.total, '18280.00');
  evidence.facilities = { bench: benchRow, charger: await row(charger.id), tree: await row(tree.id), guardrail: guardrailRow, sidewalk: sidewalkRow };
  pass('搜索和分类实际放置长椅、充电桩、树木、护栏和人行道；手填报价按3件/40m/300m²计算，采购损耗、净量人工与固定费分别正确，预设没有市场价格');

  // Explicit zero is entered by the test operator for geometry-only lines.
  // Presets remain blank until this ordinary inspector operation confirms them.
  const confirmed = new Set([bench.id, charger.id, tree.id, guardrail.id, sidewalk.id]);
  for (const item of (await project()).municipalElements) if (!confirmed.has(item.id)) {
    await select(item.id); await fill({ unitPrice: 0, wasteRate: 0, laborRate: 0, additionalCost: 0 });
  }
  await select(firstRoad.id); await fill({ unitPrice: 10, wasteRate: 10, laborRate: 2, additionalCost: 15 });
  assert.equal((await row(firstRoad.id)).total, '6255.00');
  await fill({ unitPrice: 12 }); assert.equal((await row(firstRoad.id)).total, '7311.00');
  const complete = await quote(), completeBudget = await budget(); assert.equal(complete.pending, false); assert.equal(completeBudget.pending, false);
  const itemSum = complete.municipalElements.reduce((sum, item) => sum + cents(item.total), 0n);
  const taxable = itemSum + 10000n, expectedTax = (taxable * 9n + 50n) / 100n;
  assert.equal(completeBudget.total, money(taxable + expectedTax)); assert.equal(completeBudget.knownTax, money(expectedTax));
  assert.equal(complete.total, completeBudget.total); assert.deepEqual(completeBudget.includedSections, ['municipal']);
  const quantities = await page.evaluate(() => window.planStudio.getQuantities());
  for (const [id, net, purchase] of [[bench.id, '3', '3.3'], [guardrail.id, '40', '42'], [sidewalk.id, '300', '324']]) {
    const groups = quantities.groups.filter(group => group.sources.some(source => source.targetId === id));
    assert.equal(groups.length, 1); const source = groups[0].sources.find(source => source.targetId === id);
    assert.equal(source.netQuantity, net); assert.equal(source.purchaseQuantity, purchase);
    assert.equal(source.materialCost, (await row(id)).materialCost); assert.equal(source.laborCost, (await row(id)).laborCost);
  }
  assert.equal(quantities.totals.total, completeBudget.total); evidence.completeBudget = completeBudget; evidence.quantities = quantities;
  await page.locator('#project-overview').click(); await page.locator('#dialog [data-overview-quantities]').click();
  const pricing = page.locator('#dialog.project-pricing-dialog'); await pricing.waitFor(); await frame();
  const benchGroup = pricing.locator('[data-quantity-group]').filter({ hasText: '街边长椅' }); assert.equal(await benchGroup.count(), 1);
  await benchGroup.locator('summary').click(); assert.ok(await benchGroup.locator('[data-quantity-locate]').count());
  const quantityEvent = page.waitForEvent('download'); await pricing.locator('[data-quantity-export="csv"]').click(); const quantityFile = await quantityEvent;
  assert.equal(await quantityFile.failure(), null); await quantityFile.saveAs(join(artifacts, 'municipal-authoring-quantities.csv'));
  const quantityCSV = await readFile(await quantityFile.path(), 'utf8');
  for (const text of ['街边长椅', '道路护栏', '人行道铺装', completeBudget.total]) assert.ok(quantityCSV.includes(text), text);
  const quantityRows = parseCSV(quantityCSV); assert.ok(quantityRows.length > 10);
  for (const current of quantityRows) assert.equal(current.length, quantityRows[0].length);
  await pricing.locator('[data-dialog-close]').click(); await pricing.waitFor({ state: 'hidden' });
  pass('修改道路材料单价实时改变小计6255→7311元；逐项金额、工程固定费与一次9%税金独立核对一致，工程总览用量清单可查看真实来源并下载CSV');

  await select(bench.id); const geometryBefore3D = (await project()).municipalElements, quoteBefore3D = await quote();
  await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready && window.planStudio.getViewMode() === '3d'); await frame();
  await page.locator('#inspector [data-action="focus-municipal"]').click(); await frame();
  const beforeRotation = await page.locator('#viewer3d canvas').first().screenshot();
  await fill({ rotation: 70 }); const afterRotation = await page.locator('#viewer3d canvas').first().screenshot();
  assert.ok(!beforeRotation.equals(afterRotation), 'Facility rotation must alter the actual rendered 3D pixels');
  await fill({ rotation: 35 }); assert.deepEqual((await project()).municipalElements, geometryBefore3D); assert.deepEqual(await quote(), quoteBefore3D);
  const stats = await page.evaluate(() => window.planStudio.get3DStats());
  assert.equal(stats.error, null); assert.equal(stats.glError, 0); assert.equal(stats.renderedMunicipalElementCount, geometryBefore3D.length);
  await writeFile(join(artifacts, 'bench-3d-35-degrees.png'), beforeRotation); await writeFile(join(artifacts, 'bench-3d-70-degrees.png'), afterRotation);
  evidence.real3D = stats;
  pass('真实WebGL场景显示全部市政对象；设施朝向35°→70°实际改变三维画布像素，恢复后几何和报价一致，无WebGL错误');

  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const saved = await project(); await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject);
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); await frame();
  assert.deepEqual((await project()).municipalElements, saved.municipalElements); assert.deepEqual((await project()).calibration, saved.calibration);
  assert.equal((await budget()).total, completeBudget.total);
  const csv = await download('csv', 'municipal-authoring-quote.csv'), rows = parseCSV(csv);
  for (const current of rows) assert.equal(current.length, 25);
  for (const text of ['街边长椅', '汽车充电桩', '行道树', '道路护栏', '人行道铺装', completeBudget.total]) assert.ok(csv.includes(text), text);
  await page.locator('#export').click(); const popupEvent = page.waitForEvent('popup');
  await page.locator('[data-export="pdf"]').click(); const popup = await popupEvent;
  await popup.waitForLoadState('domcontentloaded'); await popup.waitForSelector('.sheet'); const html = await popup.content();
  for (const text of ['街边长椅', '道路护栏', '人行道铺装', completeBudget.total]) assert.ok(html.includes(text), text);
  const pdf = await popup.pdf({ format: 'A4', printBackground: true }); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > 10000);
  await writeFile(join(artifacts, 'municipal-authoring-quote.pdf'), pdf); await popup.close();
  const json = await download('json', 'municipal-authoring-project.json'), exported = JSON.parse(json);
  assert.deepEqual(exported.municipalElements, saved.municipalElements); assert.equal(exported.quoteSummary.total, completeBudget.total);
  await importThroughPicker(json, '重新导入市政工程.json');
  assert.deepEqual((await project()).municipalElements, saved.municipalElements); assert.equal((await budget()).total, completeBudget.total);
  pass('保存、刷新和重新打开恢复车道尺寸、精确端点、路缘石与设施报价；实际下载25列报价CSV、有效PDF与完整JSON，文件再导入预算一致');

  await page.locator('[data-view="2d"]').click(); await frame(); await select(sidewalk.id);
  await page.locator('#urban-catalog-group').selectOption('all'); await page.locator('#urban-catalog-search').fill('');
  evidence.layouts = [];
  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 1000 }); await page.locator('#fit').click(); await frame();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const controls = [];
    for (const id of ['save', 'export', 'settings']) {
      const box = await page.locator('#' + id).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000, `${id} must fit at ${width}px`);
      controls.push({ id, ...box });
    }
    const canvas = await page.locator('#drawing-canvas').boundingBox(); assert.ok(canvas && canvas.width > 160 && canvas.height > 300);
    assert.equal(await page.locator('#municipal-unitPrice').isVisible(), true);
    await screenshot(`municipal-authoring-2d-${width}.png`);
    await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready); await frame();
    const current = await page.evaluate(() => window.planStudio.get3DStats());
    assert.equal(current.error, null); assert.equal(current.glError, 0); assert.equal(current.renderedMunicipalElementCount, saved.municipalElements.length);
    await screenshot(`municipal-authoring-3d-${width}.png`); evidence.layouts.push({ width, canvas, controls, stats: current });
    await page.locator('[data-view="2d"]').click(); await frame();
  }
  assert.deepEqual(runtimeErrors, []);
  pass('1440/1100/900窗口均无横向溢出，保存导出设置和报价输入可见；二维三维画布正常，全部对象可渲染，无浏览器运行时错误');
  outcome = 'passed';
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ outcome, checks: reports.length, reports, runtimeErrors, evidence,
    finalProject: await project(), finalQuote: await quote(), finalBudget: await budget() }, null, 2));
  process.stdout.write(`\n${reports.length} 项市政绘制浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ outcome, error: String(error), reports, runtimeErrors, evidence,
    state: await page?.evaluate(() => ({ project: window.planStudio?.getProject(), quote: window.planStudio?.getQuote(),
      viewport: window.planStudio?.getViewport(), selection: window.planStudio?.getSelection(), toast: document.querySelector('#toast')?.textContent })).catch(() => ({})) }, null, 2));
  throw error;
} finally {
  try { await browser?.close(); browserClosed = Boolean(browser); }
  finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill(); await new Promise(done => {
        const timer = setTimeout(done, 5000); server.once('exit', () => { clearTimeout(timer); done(); });
      });
    }
    serverStopped = server.exitCode !== null || server.signalCode !== null;
    await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: serverStopped,
      isolatedStorage: storage, checks: reports.length, runtimeErrors, stderr }, null, 2));
  }
}
