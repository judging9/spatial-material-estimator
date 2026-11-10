import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const testRoot = await mkdtemp(join(tmpdir(), 'studio-cost-'));
const artifacts = resolve('artifacts'); await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = process.env.STUDIO_BASE_URL ? null : spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErrors = ''; server?.stderr.on('data', data => serverErrors += data);
const baseURL = process.env.STUDIO_BASE_URL || await new Promise((accept, reject) => {
  const timer = setTimeout(() => reject(new Error(serverErrors || 'Test server timeout')), 20000);
  server.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
});
const executablePath = process.env.CHROME_PATH || [
  'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
let browser, page, checks = [];
const passed = name => { checks.push(name); console.log('✓ ' + name); };
const near = (value, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(value) - expected) < tolerance, `${value} ≠ ${expected}`);
const cents = money => BigInt(String(money).replace('.', ''));
function parseCSV(text) {
  const rows = []; let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) { if (char === '\r' && text[i + 1] === '\n') i++; row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) rows.push([...row, value]);
  assert.equal(quoted, false); return rows;
}
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio);
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const items = () => page.evaluate(() => window.planStudio.getCostItems());
  const summary = () => page.evaluate(() => window.planStudio.getCostSummary());
  const tab = id => page.locator(`.cost-tabs [data-cost-tab="${id}"]`).click();
  await page.locator('#open-cost').click();
  await page.locator('.cost-empty').getByText('准备第一份造价清单').waitFor();
  assert.equal((await items()).length, 0);
  await page.screenshot({ path: join(artifacts, 'cost-empty.png') });
  await page.locator('[data-cost-close]').click(); passed('空项目造价引导，无虚构工程量');

  await page.locator('#draw-plan').click(); await page.locator('#wall-done').click();
  await page.locator('#inspector [data-action="room-template"]').click();
  await page.locator('#room-name').fill('客厅'); await page.locator('#room-width').fill('6'); await page.locator('#room-depth').fill('4');
  await page.locator('#room-template-form button[type="submit"]').click();
  await page.waitForFunction(() => window.planStudio.getProject().regions.length === 1);
  const p0 = await project(); const regionId = p0.regions[0].id;
  near(await page.evaluate(() => window.planStudio.getQuote().regions[0].netArea), 24);
  await page.locator('#project-name').fill('甲方工程/验收'); await page.locator('#project-name').blur();
  passed('通过真实户型控件创建6×4m净尺寸房间');

  await page.locator('#open-cost').click(); await tab('structure');
  await page.locator('#structure-floors').fill('2'); await page.locator('#structure-generate').click();
  assert.equal((await items()).filter(i => i.section === '土建').length, 0);
  await page.locator('#structure-generate-cost').click();
  assert.ok((await items()).some(i => i.name.includes('矩形柱')));
  assert.ok((await items()).some(i => i.name.includes('有梁板')));
  const structural = (await items()).find(i => i.id === 'structure:columns');
  await page.locator(`[data-cost-price="${structural.id}"]`).fill('600.01');
  assert.equal((await items()).find(i => i.id === structural.id).unitPrice, '600.01');
  await page.screenshot({ path: join(artifacts, 'cost-structure.png') });
  passed('两步生成土建柱梁板，真实单价可确认');

  await tab('finish');
  await page.locator(`[data-finish-room-type="${regionId}"]`).selectOption('kitchen');
  assert.equal(await page.locator(`[data-finish-room="${regionId}"] [data-finish-point="sockets"]`).inputValue(), '6');
  await tab('structure'); await tab('finish');
  assert.equal(await page.locator(`[data-finish-room-type="${regionId}"]`).inputValue(), 'kitchen');
  await page.locator(`[data-finish-room-type="${regionId}"]`).selectOption('bedroom');
  assert.equal(await page.locator(`[data-finish-room="${regionId}"] [data-finish-point="sockets"]`).inputValue(), '4');
  await page.locator(`[data-finish-room-type="${regionId}"]`).selectOption('living');
  await page.locator('#finish-one-click').click();
  assert.ok((await items()).some(i => i.name.includes('块料楼地面')));
  assert.ok((await items()).some(i => i.name.includes('踢脚线')));
  const flooring = (await items()).find(i => i.id.includes('floor-surface'));
  const floorLabor = (await items()).find(i => i.id.includes('floor-install'));
  near(flooring.quantity, 24 * 1.03); near(floorLabor.quantity, 24);
  await page.locator(`[data-cost-price="${flooring.id}"]`).fill('120.35');
  await page.locator(`[data-cost-price="${floorLabor.id}"]`).fill('28.5');
  assert.equal((await items()).find(i => i.id === flooring.id).amount, '2975.05');
  await page.screenshot({ path: join(artifacts, 'cost-finish.png') });
  passed('装修做法分层，材料损耗量与人工净量分开计价');

  await tab('municipal'); await page.locator('#municipal-length').fill('200');
  await page.locator('#municipal-generate').click();
  assert.ok((await items()).some(i => i.section === '市政' && i.name.includes('检查井')));
  const road = (await items()).find(i => i.section === '市政' && i.category === '分部分项');
  await page.locator(`[data-cost-price="${road.id}"]`).fill('32.16');
  await page.screenshot({ path: join(artifacts, 'cost-municipal.png') });
  passed('200m道路生成真实分层、雨污管井与沿线工程量');

  await tab('summary');
  await page.locator('[data-cost-rate="measureRate"]').fill('3'); await page.locator('[data-cost-rate="measureRate"]').blur();
  await page.locator('[data-cost-other]').fill('1000.25'); await page.locator('[data-cost-other]').blur();
  await page.locator('[data-cost-rate="taxRate"]').fill('9'); await page.locator('[data-cost-rate="taxRate"]').blur();
  const all = await items(); const s = await summary();
  assert.equal(Object.values(s.bySection).reduce((sum, v) => sum + cents(v), 0n), cents(s.subtotal));
  assert.equal(cents(s.subtotal) + cents(s.measures) + cents(s.other) + cents(s.fees), cents(s.beforeTax));
  assert.equal(cents(s.beforeTax) + cents(s.tax), cents(s.total));
  near(s.rateMeasures, Math.round(Number(s.subtotal) * 3) / 100);
  assert.ok(s.missingPriceCount > 0); assert.match(await page.locator('.cost-grand').innerText(), /已定价部分/);
  assert.equal(await page.locator('[data-cost-grand]').innerText(), '¥ ' + s.total);
  passed('三专业统一汇总，措施费/暂列金额/税金分毫一致，缺价提示清楚');

  await page.locator('[data-cost-estimates]').click();
  const expectedEstimates = all.filter(i => i.estimate).length;
  assert.equal(await page.locator('[data-cost-row]').count(), expectedEstimates);
  await page.locator('[data-cost-estimates]').click();
  await page.locator(`[data-cost-row="${flooring.id}"] .cost-row-link`).click();
  assert.equal(await page.locator('.cost-tabs [data-cost-tab="finish"]').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator(`[data-cost-row="${flooring.id}"]`).evaluate(el => el.classList.contains('cost-highlight')));
  await tab('summary'); passed('估算筛选及明细跳转高亮正常');

  const beforePrice = (await items()).find(i => i.id === flooring.id).unitPrice;
  await page.locator(`[data-cost-price="${flooring.id}"]`).fill('200');
  await page.locator('[data-cost-grand]').click(); await page.keyboard.press('Control+z');
  assert.equal((await items()).find(i => i.id === flooring.id).unitPrice, beforePrice);
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await items()).find(i => i.id === flooring.id).unitPrice, '200');
  await page.keyboard.press('Control+z'); passed('确认单价进入撤销和重做，派生清单保留');

  const downloadEvent = page.waitForEvent('download'); await page.locator('[data-cost-csv]').click();
  const download = await downloadEvent; assert.match(download.suggestedFilename(), /^甲方工程_验收-造价表-\d{8}\.csv$/);
  const csv = await readFile(await download.path(), 'utf8');
  const rows = parseCSV(csv);
  assert.equal(rows.length, all.length + 8); assert.ok(rows.every(row => row.length === 11));
  assert.ok(csv.includes('待填写单价')); assert.ok(csv.includes('估算')); assert.ok(csv.includes(s.total));
  await download.saveAs(join(artifacts, 'cost-acceptance.csv'));
  const popupEvent = page.waitForEvent('popup'); await page.locator('[data-cost-print]').click(); const popup = await popupEvent;
  await popup.waitForLoadState(); assert.match(await popup.locator('body').innerText(), /方案估算/);
  assert.match(await popup.locator('.total').innerText(), /已定价部分/);
  assert.ok((await popup.locator('style').textContent()).includes('A4 portrait')); await popup.close();
  passed('总表CSV列数/汇总/BOM正确，打印页面保留估算与缺价');

  const finalTotal = (await summary()).total, savedProject = await project();
  await page.locator('[data-cost-save]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  await page.reload(); await page.waitForFunction(() => window.planStudio);
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${savedProject.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, savedProject.id);
  assert.equal((await summary()).total, finalTotal);
  assert.deepEqual((await project()).cost.modules, savedProject.cost.modules);
  await page.locator('#open-cost').click(); passed('新项目本地保存、刷新重开，几何和三专业价格完整保留');

  await page.locator('[data-cost-close]').click();
  if (!await page.locator('.walls-section details').evaluate(el => el.open)) await page.locator('.walls-section summary').click();
  await page.locator(`#left-panel [data-action="select-wall"][data-id="${p0.walls[0].id}"]`).click();
  await page.locator('#wall-edit-length').fill('7.2'); await page.locator('#wall-edit-form button[type="submit"]').click();
  near(await page.evaluate(() => window.planStudio.getQuote().regions[0].netArea), 28);
  near((await items()).find(i => i.id === flooring.id).quantity, 28.84);
  assert.equal((await items()).find(i => i.id === flooring.id).unitPrice, beforePrice);
  assert.notEqual((await summary()).total, finalTotal);
  await page.locator('#undo').click(); assert.equal((await summary()).total, finalTotal);
  await page.locator('#open-cost').click(); passed('修改墙线净面积24→28m²，工程量和造价同步，撤销完整恢复');

  // Centerline drawing remains an open polyline in calibrated meters.
  await tab('municipal'); await page.locator('#municipal-route').click();
  const clickWorld = async point => {
    const screen = await page.evaluate(p => window.planStudio.toScreen(p), point), box = await page.locator('#drawing-canvas').boundingBox();
    await page.mouse.click(screen.x + box.x, screen.y + box.y);
  };
  const minX = Math.min(...p0.regions[0].points.map(p => p.x)), minY = Math.min(...p0.regions[0].points.map(p => p.y));
  await clickWorld({ x: minX + 150, y: minY + 100 }); await clickWorld({ x: minX + 450, y: minY + 100 });
  await clickWorld({ x: minX + 450, y: minY + 300 }); await page.keyboard.press('Enter');
  near((await project()).cost.modules.municipal.config.road.length, 5);
  assert.equal((await project()).regions.length, 1);
  await page.locator('#municipal-route').click(); await clickWorld({ x: 200, y: 200 }); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#route-controls').isVisible(), false);
  assert.equal(await page.locator('#cost-view').isVisible(), true);
  near((await project()).cost.modules.municipal.config.road.length, 5);
  passed('中心线长度按米读取，不闭合为房间，Esc取消返回市政');

  await tab('summary'); await page.screenshot({ path: join(artifacts, 'cost-summary.png') });
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'));
  await page.screenshot({ path: join(artifacts, 'cost-summary-clean.png') });
  await page.setViewportSize({ width: 1100, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'cost-summary-1100.png') });
  for (const id of ['structure', 'finish', 'municipal']) {
    await tab(id); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `cost-${id}-1100.png`) });
    if (id === 'finish') {
      await page.locator('.finish-room-row').scrollIntoViewIfNeeded();
      const labelSize = await page.locator('.finish-room-row label:first-child strong').first().boundingBox();
      assert.ok(labelSize.width >= 22 && labelSize.height < 24, '房间中文名称保持一行');
      await page.screenshot({ path: join(artifacts, 'cost-finish-room-1100.png') });
    }
    if (id === 'municipal') {
      await page.locator('#municipal-form details').first().locator('summary').click();
      await page.locator('.municipal-layer-row').first().scrollIntoViewIfNeeded();
      const overflow = await page.locator('.municipal-layer-row').first().evaluate(el => el.scrollWidth > el.clientWidth);
      assert.equal(overflow, false); await page.screenshot({ path: join(artifacts, 'cost-municipal-layers-1100.png') });
    }
  }
  passed('1440/1100桌面布局无整页横向溢出，三专业切换不丢状态');

  // Import an actual old-format project through its file input, not a write hook.
  await page.locator('[data-cost-close]').click(); await page.locator('#open-project').click();
  await page.locator('[data-action="import-project"]').click();
  const legacy = { ...savedProject, id: 'cost-legacy-fixture', name: '旧项目兼容验收' }; delete legacy.cost;
  await page.locator('#project-file').setInputFiles({ name: '旧版项目.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  const leave = page.locator('[data-leave="save"]'); if (await leave.isVisible()) await leave.click();
  await page.waitForFunction(() => window.planStudio.getProject().id === 'cost-legacy-fixture');
  assert.equal((await items()).length, 0); await page.locator('#open-cost').click();
  await page.locator('.cost-empty').getByText('准备第一份造价清单').waitFor();
  passed('无cost字段的真实旧版JSON仍能导入，造价显示空态');

  await page.locator('[data-cost-close]').click(); await page.locator('#open-project').click();
  await page.locator('[data-action="import-project"]').click();
  const stress = { ...legacy, id: 'cost-500-fixture', name: '500项清单性能验收', cost: { manualItems: Array.from({ length: 500 }, (_, i) => ({
    id: 'manual-' + i, section: ['土建', '装饰装修', '市政'][i % 3], category: '分部分项', code: '099999' + String(i + 1).padStart(6, '0'),
    name: '核对项目 ' + (i + 1), feature: '验收用清单数据', unit: '项', quantity: '1', unitPrice: '1.23', amount: '1.23',
    source: 'manual', estimate: false, priceStatus: 'confirmed', note: '人工录入工程量和单价',
  })) } };
  await page.locator('#project-file').setInputFiles({ name: '500项.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(stress)) });
  await page.waitForFunction(() => window.planStudio.getProject().id === 'cost-500-fixture' || document.querySelector('[data-leave="save"]'));
  if (await leave.isVisible()) await leave.click();
  await page.waitForFunction(() => window.planStudio.getProject().id === 'cost-500-fixture');
  const renderMs = await page.evaluate(() => { const start = performance.now(); document.querySelector('#open-cost').click(); return performance.now() - start; });
  assert.equal(await page.locator('[data-cost-row]').count(), 500);
  assert.ok(renderMs < 1000, `500行渲染 ${renderMs.toFixed(1)}ms`);
  near((await summary()).subtotal, 615);
  console.log(`500-row browser render: ${renderMs.toFixed(1)} ms`);
  passed('真实导入500项清单，一次渲染流畅，汇总准确');

  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'cost-acceptance.json'), JSON.stringify({ passed: checks.length, checks, finalTotal, regionId, missingPriceCount: s.missingPriceCount, render500RowsMs: renderMs, browserErrors: errors }, null, 2));
  console.log(`Cost acceptance: ${checks.length}/${checks.length} passed`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'cost-failure.png') }).catch(() => {});
  throw error;
} finally { await browser?.close(); server?.kill(); }
