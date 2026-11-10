import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Ordinary imports, material forms, linking, refresh, save and export controls
// exercise the built application. Observation hooks are read-only. The routed
// API responses below are deterministic upstream fixtures, not live prices.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/project-material-prices');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-project-material-prices-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '', browser, page, outcome = 'failed', browserClosed = false, serverStopped = false;
server.stderr.on('data', chunk => { stderr += chunk; });
const reports = [], runtimeErrors = [], evidence = {};
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const url = 'https://supplier.example/project-prices';
const materialName = '项目瓷砖来源验收';
const upstream = patch => ({ name: '瓷砖', spec: '600x600', unit: '平方米', price: '88.605',
  region: '杭州', source: '供应商测试报价', supplier: '测试厂家', price_date: '2026-11-01', ...patch });
let sourceRows = [upstream()], previewCalls = 0, rowCalls = 0;
const fixture = {
  version: 1, id: 'project-material-prices', name: '材料来源完整工程', workspaceMode: 'plan',
  drawing: { id: 'price-plan', name: '真实米制工程', type: 'plan', width: 1000, height: 800,
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' },
  calibration: { metersPerPixel: .01, method: 'metric-plan' },
  regions: [{ id: 'price-room', name: '客厅', points: [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }, { x: 100, y: 400 }],
    holes: [], hidden: false, additionalCost: '0', items: [{ id: 'room-tile', materialId: 'saved-tile', materialName: '客厅地砖',
      color: '#82958e', image: '', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '5',
      provenance: { source: '用户初始报价', region: '杭州', spec: '600x600' } }] }],
  walls: [], openings: [], wallHeight: 280, wallThickness: 20,
  furniture: [{ id: 'price-sofa', name: '客厅沙发', kind: 'sofa', position: { x: 280, y: 270 }, width: 180, depth: 80, height: 85,
    rotation: 0, quantity: '1', unitPrice: '250', additionalCost: '10', hidden: false, locked: false }],
  additionalCost: '100', taxRate: '9', view: { labels: true, drawingOpacity: 1 },
  budget: { client: '验收甲方', reference: 'SOURCE-20261108', note: '真实材料来源与报价同步验收', included: { decoration: true, civil: false, municipal: false } },
};
await writeFile(join(artifacts, 'input-project.json'), JSON.stringify(fixture, null, 2));
const persistentProject = project => {
  const value = structuredClone(project);
  // IndexedDB legitimately creates a fresh object URL while restoring the same
  // image bytes. Compare saved design/source data without that runtime handle.
  if (value.drawing) for (const key of ['url', 'sourceUrl', 'blob']) delete value.drawing[key];
  for (const key of ['quoteSummary', 'budgetSummary', 'savedAt', 'updatedAt']) delete value[key];
  return value;
};
const physicalProject = project => JSON.parse(JSON.stringify(persistentProject(project), (key, value) =>
  ['unitPrice', 'priceMaterialId', 'priceSourceUnitPrice', 'provenance', 'demo', 'quoteSummary', 'budgetSummary', 'savedAt', 'updatedAt'].includes(key) ? undefined : value));
const parseCSV = source => {
  const rows = [], row = []; let cell = '', quoted = false;
  source = source.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') { if (quoted && source[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); cell = ''; rows.push([...row]); row.length = 0;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false); return rows;
};

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Isolated server startup timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const executablePath = process.env.CHROME_PATH || [
    'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const envelope = data => JSON.stringify({ ok: true, data });
  await page.route('**/api/scrape/preview', async route => {
    previewCalls++; assert.equal(route.request().postDataJSON().url, url);
    await route.fulfill({ contentType: 'application/json', body: envelope({ url, tables: [{ index: 1,
      sample: [['名称', '单位', '价格', '规格', '日期', '供应商', '地区', '来源'],
        ['瓷砖', '平方米', '88.605', '600x600', '2026-11-01', '测试厂家', '杭州', '供应商测试报价']] }] }) });
  });
  await page.route('**/api/scrape/rows/preview', async route => {
    rowCalls++; const payload = route.request().postDataJSON();
    assert.equal(payload.url, url); assert.equal(payload.table_index, 1);
    assert.deepEqual(payload.mapping, { name: 0, unit: 1, price: 2, spec: 3, date: 4, supplier: 5, region: 6, source: 7 });
    await route.fulfill({ contentType: 'application/json', body: envelope({ url, rows: sourceRows }) });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => ['getMaterials', 'getSourceRows', 'getProject', 'getProjectBudget'].every(name => typeof window.planStudio?.[name] === 'function'));
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const budget = () => page.evaluate(() => window.planStudio.getProjectBudget());
  const rows = () => page.evaluate(() => window.planStudio.getSourceRows());
  const materials = () => page.evaluate(() => window.planStudio.getMaterials());
  const item = async () => (await project()).regions.find(region => region.id === 'price-room').items.find(item => item.id === 'room-tile');
  const sourceRow = async () => (await rows()).find(row => row.targetId === 'price-room' && row.itemId === 'room-tile');
  const waitTotal = total => page.waitForFunction(expected => window.planStudio.getProjectBudget().total === expected, total);
  const close = async () => { if (await page.locator('#dialog').isVisible()) { await page.locator('#dialog [data-dialog-close]').click(); await page.locator('#dialog').waitFor({ state: 'hidden' }); } };
  const library = async () => { await page.locator('#settings').click(); await page.locator('#dialog [data-action="manage-materials"]').click(); };
  const selectRoom = async () => { await page.locator('#left-panel [data-action="select-region"][data-id="price-room"]').click(); await page.locator('#inspector .price-source-inspector').waitFor(); await frame(); };
  const sourceButton = action => page.locator(`#inspector .price-source-inspector [data-action="${action}"]`).first();
  const download = async (button, filename) => {
    const event = page.waitForEvent('download'); await button.click(); const result = await event;
    assert.equal(await result.failure(), null); await result.saveAs(join(artifacts, filename));
    return { text: await readFile(await result.path(), 'utf8'), filename: result.suggestedFilename() };
  };
  const screenshot = async filename => { await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible')); await frame(); await page.screenshot({ path: join(artifacts, filename) }); };
  const assertBudget = async (total, materialCost, floorTotal, subtotal, tax) => {
    await waitTotal(total); const value = await budget(), row = await sourceRow();
    assert.equal(value.total, total); assert.equal(value.knownSubtotal, subtotal); assert.equal(value.knownTax, tax);
    assert.equal(value.additionalCost, '100.00'); assert.equal(value.taxRate, '9'); assert.equal(value.pending, false);
    assert.equal(row.netQuantity, '12'); assert.equal(row.purchaseQuantity, '13.2'); assert.equal(row.knownTotal, floorTotal);
    const floor = value.sections.find(section => section.id === 'decoration').quote.regions.find(region => region.id === 'price-room');
    const quoteItem = floor.items.find(item => item.id === 'room-tile');
    assert.equal(quoteItem.materialCost, materialCost); assert.equal(quoteItem.laborCost, '240.00');
    assert.equal(quoteItem.additionalCost, '5.00');
    const current = await project();
    assert.equal(current.regions[0].items[0].wasteRate, '10'); assert.equal(current.regions[0].items[0].laborRate, '20');
    assert.equal(current.furniture[0].unitPrice, '250'); assert.equal(current.furniture[0].quantity, '1'); assert.equal(current.furniture[0].additionalCost, '10');
  };

  await page.locator('#open-project').click();
  const chooserEvent = page.waitForEvent('filechooser'); await page.locator('#dialog [data-action="import-project"]').click();
  const chooser = await chooserEvent; await chooser.setFiles({ name: '材料来源工程.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture), 'utf8') });
  await page.waitForFunction(() => window.planStudio.getProject().id === 'project-material-prices'); await close(); await frame();
  await assertBudget('2098.25', '1320.00', '1565.00', '1925.00', '173.25');
  const original = await project(), physical = physicalProject(original), originalMaterials = await materials();
  pass('通过JSON文件选择器导入12m²客厅，材料采购13.2m²/1320元、人工240、分项固定5、沙发260、工程固定100和9%税，含税2098.25元真实可复核');

  await library(); await page.locator('#dialog [data-action="new-material"]').click();
  const fields = { name: materialName, category: '地面', unit: 'm²', unitPrice: '100', wasteRate: '8', color: '#88aa99', description: '真实来源集成验收材料',
    sourceKind: 'web', quoteSource: '供应商测试报价', quoteName: '瓷砖', quoteSpec: '600x600', quoteRegion: '杭州', quoteDate: '2026-10-31', quoteSupplier: '测试厂家', quoteUrl: url };
  for (const [name, value] of Object.entries(fields)) {
    const input = page.locator(`#material-form [name="${name}"]`);
    if (['unit', 'sourceKind'].includes(name)) await input.selectOption(value); else await input.fill(value);
  }
  await page.locator('#material-form button[type="submit"]').click();
  await page.waitForFunction(name => window.planStudio.getMaterials().some(material => material.name === name), materialName);
  await close();
  const created = (await materials()).find(material => material.name === materialName), materialId = created.id;
  assert.equal(created.provenance.manual, true); assert.equal(created.provenance.refresh.kind, 'web'); assert.equal(created.provenance.refresh.url, url);
  assert.deepEqual((await materials()).filter(material => material.id !== materialId), originalMaterials.map(material => ({ ...material, unitPrice: String(Number(material.unitPrice)) })));
  await selectRoom(); await sourceButton('link-price-source').click();
  await page.locator('#source-material-choice').selectOption(materialId); await page.locator('#source-link-apply').click(); await close(); await frame();
  const linked = await project();
  assert.equal((await item()).priceMaterialId, materialId); assert.equal((await item()).priceSourceUnitPrice, '100');
  assert.equal((await item()).materialId, 'saved-tile'); assert.equal((await item()).materialName, '客厅地砖'); assert.equal((await item()).color, '#82958e');
  assert.equal((await sourceRow()).materialId, materialId); assert.equal((await sourceRow()).provenance.sourceUrl, url);
  assert.match(await page.locator('#inspector .price-source-inspector').innerText(), /手工录入.*供应商测试报价/);
  assert.equal(await page.locator('#inspector .price-source-inspector a').getAttribute('href'), url);
  assert.deepEqual(physicalProject(linked), physical); await assertBudget('2098.25', '1320.00', '1565.00', '1925.00', '173.25');
  pass('通过真实材料表单创建网页瓷砖来源并关联区域报价，来源单位/网址/规格与手工录入标记保存；设计材料外观、10%损耗和原费用保持');

  await sourceButton('refresh-price-source').click();
  await page.locator(`[data-price-refresh-id="${materialId}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#price-refresh-apply').disabled);
  assert.equal(previewCalls, 1); assert.equal(rowCalls, 1);
  assert.equal((await materials()).find(material => material.id === materialId).unitPrice, '100'); assert.equal((await item()).unitPrice, '100');
  assert.match(await page.locator(`[data-price-refresh-material="${materialId}"]`).innerText(), /88\.605/);
  await page.locator('#price-refresh-apply').click(); await page.locator('#source-sync-apply').waitFor(); await frame();
  const refreshed = (await materials()).find(material => material.id === materialId);
  assert.equal(refreshed.unitPrice, '88.605'); assert.equal(refreshed.wasteRate, '8'); assert.equal(refreshed.provenance.priceDate, '2026-11-01'); assert.notEqual(refreshed.provenance.manual, true);
  assert.equal((await item()).unitPrice, '100'); assert.deepEqual(await project(), linked);
  assert.equal((await page.locator('#source-sync-before').textContent()).replace(/[¥,\s]/g, ''), '2098.25');
  assert.equal((await page.locator('#source-sync-after').textContent()).replace(/[¥,\s]/g, ''), '1934.30');
  await screenshot('source-sync-preview-1440.png'); await page.locator('#source-sync-skip').click(); await close();
  assert.deepEqual(await project(), linked); await waitTotal('2098.25');
  pass('区域刷新使用真实API入口和明确上游fixture：先核对88.605才更新库，项目仍100；总预算2098.25→1934.30预览可取消，取消保留项目原价');

  await library(); await page.locator('#dialog [data-action="sync-project-prices"]').click(); await page.locator('#source-sync-apply').click(); await close();
  await assertBudget('1934.30', '1169.59', '1414.59', '1774.59', '159.71');
  assert.equal((await item()).unitPrice, '88.605'); assert.equal((await item()).provenance.priceDate, '2026-11-01');
  assert.deepEqual(physicalProject(await project()), physical);
  const applied = await project();
  await page.locator('#undo').click(); await waitTotal('2098.25'); assert.deepEqual(await project(), linked);
  assert.equal((await materials()).find(material => material.id === materialId).unitPrice, '88.605');
  await page.locator('#redo').click(); await waitTotal('1934.30'); assert.deepEqual(await project(), applied);
  pass('从材料库同步项目单价并按分舍入：材料1169.59/人工240/分项1414.59/税159.71/总价1934.30；一次撤销重做恢复完整来源和价格，库内报价保持');

  sourceRows = [upstream({ price_date: '2026-11-02' })];
  await selectRoom(); await sourceButton('refresh-price-source').click(); await page.locator(`[data-price-refresh-id="${materialId}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#price-refresh-apply').disabled); await page.locator('#price-refresh-apply').click();
  await page.locator('#source-sync-apply').waitFor();
  assert.equal(previewCalls, 1); assert.equal(rowCalls, 2); assert.equal((await item()).provenance.priceDate, '2026-11-01');
  await page.locator('#source-sync-apply').click(); await close(); await frame();
  assert.equal((await item()).unitPrice, '88.605'); assert.equal((await item()).provenance.priceDate, '2026-11-02');
  assert.equal((await sourceRow()).provenance.priceDate, '2026-11-02'); await waitTotal('1934.30');
  pass('同单价的新发布日期仍能从保存列映射刷新并同步项目，原日期在确认前保留，确认后来源日期更新而总价保持');

  await selectRoom(); const manualPrice = page.locator('[data-item-field="unitPrice"][data-item-id="room-tile"]');
  await manualPrice.fill('95'); await manualPrice.press('Tab'); await waitTotal('2026.31');
  assert.equal((await item()).provenance.source, '用户调整单价'); assert.equal((await sourceRow()).provenance.source, '用户调整单价');
  assert.equal((await sourceRow()).provenance.sourceUrl, undefined); assert.equal((await sourceRow()).provenance.priceDate, undefined);
  assert.match(await page.locator('#inspector .price-source-inspector').innerText(), /用户调整单价/);
  assert.equal(await page.locator('#inspector .price-source-inspector a').count(), 0);
  assert.deepEqual(physicalProject(await project()), physical);
  await page.locator('#undo').click(); await waitTotal('1934.30'); assert.equal((await item()).provenance.priceDate, '2026-11-02');
  pass('属性手工改价95元实时得到2026.31元，并标用户调整，旧网页/旧日期不再归因；一次撤销恢复最新实际来源');

  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const saved = await project(), savedLibrary = await materials();
  await page.reload(); await page.waitForFunction(() => typeof window.planStudio?.getProjectBudget === 'function');
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); await close(); await frame();
  assert.deepEqual(persistentProject(await project()), persistentProject(saved)); assert.deepEqual(await materials(), savedLibrary); await waitTotal('1934.30');
  await page.locator('#export').click(); const json = await download(page.locator('#dialog [data-export="json"]'), 'project-material-prices-full.json');
  const exported = JSON.parse(json.text), exportedItem = exported.regions[0].items[0];
  assert.equal(exported.budgetSummary.total, '1934.30'); assert.equal(exportedItem.unitPrice, '88.605'); assert.equal(exportedItem.priceMaterialId, materialId);
  assert.equal(exportedItem.provenance.sourceUrl, url); assert.equal(exportedItem.provenance.priceDate, '2026-11-02'); await close();
  await page.locator('#project-overview').click(); const csv = await download(page.locator('#dialog [data-overview-export="csv"]'), 'project-material-prices-budget.csv');
  const csvRows = parseCSV(csv.text); for (const row of csvRows) assert.equal(row.length, 20);
  const floorRow = csvRows.filter(row => row[0] === '专业分项' && row[4] === '客厅' && row[5] === '客厅地砖'); assert.equal(floorRow.length, 1);
  assert.deepEqual(floorRow[0].slice(6, 16), ['m²', '扣孔后的净面积', '12', '13.2', '88.605', '10', '20', '1169.59', '240.00', '5.00']);
  for (const text of [url, '2026-11-02', '供应商测试报价', '600x600', '杭州', '测试厂家']) assert.ok(floorRow[0][19].includes(text), text);
  const summary = type => { const matches = csvRows.filter(row => row[0] === type); assert.equal(matches.length, 1); return matches[0]; };
  assert.equal(summary('工程固定费')[17], '100.00'); assert.equal(summary('工程税金')[17], '159.71'); assert.equal(summary('工程总汇')[17], '1934.30');
  evidence.exports = { jsonFilename: json.filename, csvFilename: csv.filename, floor: floorRow[0], total: '1934.30', source: exportedItem.provenance };
  await close();
  pass('普通保存、刷新及项目列表重开保留库与项目来源；实际下载完整JSON和工程总览20列CSV包含来源URL/日期、真实用量及总价，税和工程固定费各一次');

  evidence.layouts = [];
  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 1000 }); await selectRoom();
    const panel = await page.locator('#inspector .price-source-inspector').evaluate(node => {
      const rect = node.getBoundingClientRect(); return { x: rect.x, width: rect.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, documentWidth: document.documentElement.scrollWidth };
    });
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1); assert.ok(panel.documentWidth <= width); assert.ok(panel.scrollWidth <= panel.clientWidth + 1);
    for (const action of ['link-price-source', 'refresh-price-source']) assert.equal(await sourceButton(action).isVisible(), true);
    await screenshot(`project-source-panel-${width}.png`);
    await sourceButton('link-price-source').click();
    const link = await page.locator('#dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect(), body = dialog.querySelector('.dialog-body'); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: body.clientWidth, scrollWidth: body.scrollWidth };
    });
    assert.ok(link.x >= 0 && link.x + link.width <= width + 1 && link.y >= 0 && link.y + link.height <= 1001); assert.ok(link.scrollWidth <= link.clientWidth + 1);
    assert.equal(await page.locator('#source-link-apply').isVisible(), true); await screenshot(`project-source-link-${width}.png`); await close();
    await library(); await page.locator('#dialog [data-action="sync-project-prices"]').click();
    const sync = await page.locator('#dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect(), body = dialog.querySelector('.dialog-body'); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: body.clientWidth, scrollWidth: body.scrollWidth };
    });
    assert.ok(sync.x >= 0 && sync.x + sync.width <= width + 1 && sync.y >= 0 && sync.y + sync.height <= 1001); assert.ok(sync.scrollWidth <= sync.clientWidth + 1);
    for (const selector of ['#source-sync-skip', '#source-sync-apply']) assert.equal(await page.locator(selector).isVisible(), true);
    await screenshot(`project-source-sync-${width}.png`); await page.locator('#source-sync-skip').click(); await close();
    evidence.layouts.push({ width, panel, link, sync });
  }
  assert.deepEqual(physicalProject(await project()), physical); await waitTotal('1934.30'); assert.deepEqual(runtimeErrors, []);
  pass('1440/1100/900宽度下区域来源属性、关联弹窗及总预算同步弹窗均无横向溢出，主要按钮可操作，查看与取消不改工程');
  outcome = 'passed';
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ outcome, checks: reports.length, reports, runtimeErrors, evidence,
    upstreamFixtures: 'Deterministic source API fixtures; this run does not verify live market prices.', finalProject: await project() }, null, 2));
  process.stdout.write(`\n${reports.length} 项项目材料来源浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ outcome, error: String(error), reports, runtimeErrors, evidence,
    state: await page?.evaluate(() => ({ project: window.planStudio?.getProject(), budget: window.planStudio?.getProjectBudget(), rows: window.planStudio?.getSourceRows(),
      focus: document.activeElement?.id, dialog: document.querySelector('#dialog')?.textContent, toast: document.querySelector('#toast')?.textContent })).catch(() => ({})) }, null, 2));
  throw error;
} finally {
  if (browser) { await browser.close(); browserClosed = true; }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill(); await new Promise(done => { if (server.exitCode !== null || server.signalCode !== null) done(); else server.once('exit', done); });
  }
  serverStopped = server.exitCode !== null || server.signalCode !== null;
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: serverStopped,
    isolatedStorage: storage, checks: reports.length, runtimeErrors, stderr }, null, 2));
}
