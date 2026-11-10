import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { pricingFixture } from './project-pricing-fixture.mjs';

// Exercise the built application using ordinary controls, real imports and
// real exports. No write hook, runtime patch, build or live module replacement.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/project-pricing');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-project-pricing-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '', browser, page, outcome = 'failed', browserClosed = false, serverStopped = false;
server.stderr.on('data', chunk => { stderr += chunk; });
const reports = [], runtimeErrors = [], evidence = {};
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
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
const oneRow = (rows, type, predicate = () => true) => {
  const matches = rows.filter(row => row[0] === type && predicate(row));
  assert.equal(matches.length, 1, `${type} must occur exactly once`); return matches[0];
};
const stripPrices = project => JSON.parse(JSON.stringify(project, (key, value) =>
  ['unitPrice', 'laborRate', 'wasteRate', 'provenance', 'quoteSummary', 'budgetSummary', 'savedAt', 'updatedAt'].includes(key) ? undefined : value));
const storey = (project, index) => project.levels[index].id === project.activeLevelId ? project : project.levels[index].content;
const confirmedPrices = project => {
  for (const index of [0, 1]) {
    const item = storey(project, index).regions[0].items[0];
    assert.equal(item.unitPrice, '100'); assert.equal(item.laborRate, '25'); assert.equal(item.wasteRate, '5');
  }
  assert.equal(storey(project, 1).furniture.find(item => item.id === '二楼床').unitPrice, '150');
};

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
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  let acceptConfirmation = true;
  const confirmations = [];
  page.on('dialog', async dialog => {
    confirmations.push({ type: dialog.type(), message: dialog.message(), accepted: acceptConfirmation });
    if (acceptConfirmation) await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getProjectBudget);
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const budget = () => page.evaluate(() => window.planStudio.getProjectBudget());
  const pricing = () => page.locator('#dialog.project-pricing-dialog');
  const overview = () => page.locator('#dialog.project-overview-dialog');
  const openPricing = async (tab = 'pricing') => {
    await page.locator('#project-overview').click(); await overview().waitFor();
    await overview().locator(tab === 'pricing' ? '[data-overview-pricing]' : '[data-overview-quantities]').click();
    await pricing().waitFor(); await frame();
  };
  const closePricing = async () => {
    await pricing().locator('[data-dialog-close]').click(); await pricing().waitFor({ state: 'hidden' }); await frame();
  };
  const floors = () => pricing().locator('[data-price-row]').filter({
    has: page.locator('.pricing-row-description > strong').filter({ hasText: /^防滑地砖$/ }),
  });
  const groundFloor = () => floors().filter({ hasText: '首层客厅' });
  const bed = () => pricing().locator('[data-price-row]').filter({ hasText: '二楼床' });
  const field = (row, name) => row.locator(`[data-price-field="${name}"]`);
  const edit = async (row, name, value) => { await field(row, name).fill(String(value)); await field(row, name).press('Tab'); await frame(); };
  const displayedAmount = async (selector, expected) => assert.equal((await pricing().locator(selector).textContent()).replace(/[¥,\s]/g, ''), expected);
  const waitTotal = total => page.waitForFunction(expected => window.planStudio.getProjectBudget().total === expected, total);
  const tileGroup = () => pricing().locator('[data-quantity-group]').filter({
    has: page.locator('.quantity-group-heading > strong').filter({ hasText: /^防滑地砖$/ }),
  });
  const importThroughPicker = async (text, name) => {
    await page.locator('#open-project').click();
    const event = page.waitForEvent('filechooser'); await page.locator('#dialog [data-action="import-project"]').click();
    const chooser = await event; await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('完整项目已导入') && document.querySelector('#project-file').value === '');
    await frame();
  };
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await frame(); await page.screenshot({ path: join(artifacts, name) });
  };
  const download = async (button, filename) => {
    const event = page.waitForEvent('download'); await button.click(); const item = await event;
    assert.equal(await item.failure(), null); await item.saveAs(join(artifacts, filename));
    return { text: await readFile(await item.path(), 'utf8'), filename: item.suggestedFilename() };
  };

  await openPricing();
  assert.equal(await pricing().locator('[data-price-row]').count(), 0);
  assert.equal(await pricing().locator('[data-pricing-select-all]').isDisabled(), true);
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), true);
  await displayedAmount('[data-pricing-before]', '—');
  await pricing().locator('[data-pricing-tab="quantities"]').click();
  for (const format of ['csv', 'pdf']) assert.equal(await pricing().locator(`[data-quantity-export="${format}"]`).isDisabled(), true);
  await screenshot('project-pricing-empty-1440.png'); await closePricing();
  pass('空工程通过总览进入报价与用量视图，无假零价、无可选价格行，应用、全选及导出禁用');

  const fixture = pricingFixture();
  await importThroughPicker(JSON.stringify(fixture), '两层集中报价待完善.json');
  const initialProject = await project(), initialBudget = await budget();
  assert.equal(initialProject.id, fixture.id); assert.equal(initialProject.levels.length, 2);
  assert.equal(initialBudget.pending, true); assert.equal(initialBudget.total, null); assert.equal(initialBudget.knownTotal, '1890.06');
  await openPricing();
  assert.equal(await pricing().locator('#pricing-status').inputValue(), 'pending');
  assert.equal(await pricing().locator('[data-price-row]').count(), 3);
  assert.equal(await floors().count(), 2); assert.equal(await bed().count(), 1);
  assert.equal(await pricing().locator('[data-price-row].is-pending').count(), 3);
  await displayedAmount('[data-pricing-before]', '1890.06');
  await screenshot('project-pricing-pending-1440.png');
  evidence.initialBudget = initialBudget;
  pass('真实JSON文件导入两层工程，两个地砖和二楼床缺价，默认显示3项待完善，已确认含税小计1890.06元');

  await floors().nth(0).locator('[data-price-select]').check();
  await floors().nth(1).locator('[data-price-select]').check();
  const bulkPrice = pricing().locator('#pricing-bulk-unit-price');
  await bulkPrice.fill(''); await bulkPrice.pressSequentially('-');
  assert.equal(await bulkPrice.evaluate(input => input.validity.badInput), true);
  await pricing().locator('#pricing-bulk-labor-rate').fill('25');
  await pricing().locator('[data-pricing-bulk-apply]').click(); await frame();
  assert.ok((await pricing().locator('#pricing-error').textContent()).trim());
  assert.equal(await pricing().locator('[data-price-row].is-changed').count(), 0);
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), true);
  assert.deepEqual(await project(), initialProject); await displayedAmount('[data-pricing-after]', '1890.06');
  evidence.bulkBadInput = { value: await bulkPrice.inputValue(), error: await pricing().locator('#pricing-error').textContent() };
  pass('真实键入统一单价“-”并填写人工25时整批拒绝，坏数字未被当作空白忽略，源工程和报价草稿保持不变');

  await bulkPrice.fill('100'); await pricing().locator('#pricing-bulk-labor-rate').fill('25');
  await pricing().locator('#pricing-bulk-waste-rate').fill('5');
  await pricing().locator('[data-pricing-bulk-apply]').click(); await frame();
  assert.equal(await floors().count(), 2, 'completed draft rows remain visible until application');
  for (const row of [floors().nth(0), floors().nth(1)]) {
    assert.equal(await field(row, 'unitPrice').inputValue(), '100');
    assert.equal(await field(row, 'laborRate').inputValue(), '25'); assert.equal(await field(row, 'wasteRate').inputValue(), '5');
    assert.match(await row.locator('[data-price-changes]').textContent(), /待填 → 100/);
    assert.match(await row.locator('[data-price-changes]').textContent(), /20 → 25/);
    assert.match(await row.locator('[data-price-changes]').textContent(), /10 → 5/);
  }
  await edit(bed(), 'unitPrice', '150');
  assert.equal(await field(bed(), 'laborRate').isDisabled(), true); assert.equal(await field(bed(), 'wasteRate').isDisabled(), true);
  await bed().locator('[data-price-select]').check();
  assert.equal(await bulkPrice.isDisabled(), true); assert.equal(await pricing().locator('#pricing-bulk-labor-rate').isDisabled(), true);
  assert.equal(await pricing().locator('#pricing-bulk-waste-rate').isDisabled(), true);
  assert.match(await pricing().locator('[data-pricing-bulk-note]').textContent(), /单位不同/);
  await displayedAmount('[data-pricing-after]', '3971.96');
  assert.deepEqual(await project(), initialProject); assert.deepEqual(await budget(), initialBudget);
  assert.equal(await pricing().locator('[data-price-row].is-changed').count(), 3);
  assert.match(await pricing().locator('[data-pricing-apply]').textContent(), /3/);
  for (const selector of ['[data-pricing-save]', '[data-pricing-undo]', '[data-pricing-redo]']) assert.equal(await pricing().locator(selector).isDisabled(), true);
  await screenshot('project-pricing-draft-1440.png');
  pass('两个地面统一100元/m²、人工25元/m²和损耗5%，床逐行150元；逐行原值对比及3971.96元预览真实，源工程未写入，家具不支持人工损耗且混单位统一金额禁用');

  await edit(groundFloor(), 'unitPrice', '-5');
  assert.equal(await field(groundFloor(), 'unitPrice').evaluate(input => input.classList.contains('validation-error')), true);
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), true);
  assert.ok((await pricing().locator('#pricing-error').textContent()).trim());
  await displayedAmount('[data-pricing-after]', '3971.96'); assert.deepEqual(await project(), initialProject);
  await edit(groundFloor(), 'unitPrice', '100');
  assert.equal(await field(groundFloor(), 'unitPrice').evaluate(input => input.classList.contains('validation-error')), false);
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), false);
  await pricing().locator('[data-pricing-tab="quantities"]').click(); await frame();
  assert.equal(await pricing().locator('[data-quantities-draft]').isVisible(), true);
  assert.match(await pricing().locator('[data-quantities-draft]').textContent(), /清单仍按当前工程/);
  for (const format of ['csv', 'pdf']) assert.equal(await pricing().locator(`[data-quantity-export="${format}"]`).isDisabled(), true);
  assert.match(await tileGroup().locator('.quantity-group-cost').textContent(), /320\.00/);
  await pricing().locator('[data-pricing-tab="pricing"]').click();
  acceptConfirmation = false;
  await pricing().locator('[data-dialog-close]').click(); await frame(); assert.equal(await pricing().isVisible(), true);
  await pricing().locator('[data-pricing-back]').click(); await frame(); assert.equal(await pricing().isVisible(), true);
  assert.equal(confirmations.slice(-2).every(item => item.type === 'confirm' && item.accepted === false), true);
  assert.deepEqual(await project(), initialProject); await displayedAmount('[data-pricing-after]', '3971.96');
  acceptConfirmation = true;
  pass('非法负价保留错误输入并阻止整份草稿应用；未应用时用量仍为原工程且不能导出，拒绝关闭和返回确认会保留完整草稿');

  await pricing().locator('[data-pricing-apply]').click(); await waitTotal('3971.96'); await frame();
  const appliedProject = await project(), appliedBudget = await budget();
  confirmedPrices(appliedProject); assert.equal(appliedBudget.pending, false); assert.equal(appliedBudget.status, 'ready');
  assert.equal(appliedBudget.knownTax, '327.96'); assert.equal(appliedBudget.additionalCost, '100.00');
  assert.deepEqual(stripPrices(appliedProject), stripPrices(initialProject));
  await pricing().locator('[data-pricing-undo]').click(); await frame();
  assert.deepEqual(await project(), initialProject); assert.deepEqual(await budget(), initialBudget);
  await pricing().locator('[data-pricing-redo]').click(); await waitTotal('3971.96'); await frame();
  confirmedPrices(await project()); assert.deepEqual(await budget(), appliedBudget);
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), true);
  evidence.appliedBudget = appliedBudget;
  pass('一次应用三项报价形成3971.96元完整含税预算，几何和固定费未改变；一次撤销恢复3缺价原工程，一次重做恢复整批价格');

  await pricing().locator('#pricing-status').selectOption('all');
  await pricing().locator('#pricing-search').fill('不存在的规格'); await frame();
  assert.equal(await pricing().locator('[data-price-row]').count(), 0);
  assert.equal(await pricing().locator('[data-pricing-select-all]').isDisabled(), true);
  await pricing().locator('#pricing-search').fill('');
  const sourceBeforeDiscard = await project();
  await edit(bed(), 'unitPrice', '200');
  acceptConfirmation = false; await pricing().locator('[data-dialog-close]').click(); await frame();
  assert.equal(await pricing().isVisible(), true); assert.equal(await field(bed(), 'unitPrice').inputValue(), '200');
  await page.keyboard.press('Escape'); await frame(); assert.equal(await pricing().isVisible(), true);
  acceptConfirmation = true; await closePricing(); assert.deepEqual(await project(), sourceBeforeDiscard);
  await openPricing(); assert.equal(await field(bed(), 'unitPrice').inputValue(), '150');
  await edit(bed(), 'unitPrice', '201');
  acceptConfirmation = false; await pricing().locator('[data-pricing-back]').click(); await frame(); assert.equal(await pricing().isVisible(), true);
  acceptConfirmation = true; await pricing().locator('[data-pricing-back]').click(); await overview().waitFor(); await frame();
  assert.deepEqual(await project(), sourceBeforeDiscard);
  await overview().locator('[data-overview-pricing]').click(); await pricing().waitFor(); await frame();
  assert.equal(await field(bed(), 'unitPrice').inputValue(), '150');
  evidence.confirmations = confirmations;
  pass('无匹配项时全选禁用；拒绝关闭、Esc或返回会保护草稿，接受关闭或返回后未应用价格200/201被放弃并保留已确认150元');

  await edit(groundFloor(), 'unitPrice', '');
  assert.equal(await pricing().locator('[data-pricing-apply]').isDisabled(), false);
  await pricing().locator('[data-pricing-apply]').click(); await frame();
  assert.equal(storey(await project(), 0).regions[0].items[0].unitPrice, '');
  assert.equal((await budget()).pending, true); assert.equal((await budget()).total, null);
  assert.equal((await budget()).knownTotal, '2598.56');
  assert.equal(await groundFloor().evaluate(row => row.classList.contains('is-pending')), true);
  await pricing().locator('[data-pricing-undo]').click(); await waitTotal('3971.96'); await frame(); confirmedPrices(await project());
  pass('主动清空首层材料单价保留计价项与人工，预算变为待报价且已确认2598.56元；一次撤销恢复完整价格和3971.96元总预算');

  await pricing().locator('[data-pricing-tab="quantities"]').click(); await frame();
  assert.equal(await tileGroup().count(), 1);
  assert.match(await tileGroup().locator('.quantity-group-measure').nth(0).textContent(), /\b16\b/);
  assert.match(await tileGroup().locator('.quantity-group-measure').nth(1).textContent(), /16\.8/);
  assert.equal((await tileGroup().locator('.quantity-group-cost > strong').textContent()).replace(/[¥,\s]/g, ''), '2080.00');
  await tileGroup().locator('summary').click();
  assert.equal(await tileGroup().locator('[data-quantity-locate]').count(), 2);
  assert.match(await tileGroup().locator('.quantity-rates').textContent(), /单价 100/);
  assert.match(await tileGroup().locator('.quantity-rates').textContent(), /人工 25/);
  const beforeLocate = await budget();
  await tileGroup().locator('[data-quantity-locate]').filter({ hasText: '二楼卧室' }).click();
  await page.waitForFunction(() => window.planStudio.getProject().activeLevelId === window.planStudio.getProject().levels[1].id);
  await page.locator('#inspector-region-name').waitFor(); await frame();
  assert.equal(await page.locator('#inspector-region-name').inputValue(), '二楼卧室');
  assert.equal((await page.evaluate(() => window.planStudio.getSelection())).regionId, '二楼卧室');
  assert.equal(await page.evaluate(() => window.planStudio.getWorkspaceMode()), 'decoration');
  assert.deepEqual(await budget(), beforeLocate);
  await screenshot('project-pricing-located-second-floor-1440.png');
  pass('同规格地砖跨楼层归并净量16m²、采购16.8m²和分项2080元，保留两个来源；点击二楼来源真实切层、选中区域并显示属性，总预算不变');

  await openPricing('quantities');
  const csv = await download(pricing().locator('[data-quantity-export="csv"]'), 'project-quantities-full.csv');
  assert.match(csv.filename, /工程用量清单\.csv$/);
  const rows = parseCSV(csv.text); for (const row of rows) assert.equal(row.length, 19);
  const tile = oneRow(rows, '规格用量汇总', row => row[4] === '防滑地砖');
  assert.deepEqual(tile.slice(6, 17), ['m²', '16', '16.8', '100', '5', '25', '1680.00', '400.00', '0.00', '2080.00', '2']);
  const tileSources = rows.filter(row => row[0] === '来源追溯' && row[4] === '防滑地砖');
  assert.equal(tileSources.length, 2); assert.ok(tileSources.some(row => row[18].includes('二楼卧室')));
  assert.equal(oneRow(rows, '费用汇总', row => row[4] === '工程固定费（一次）')[15], '100.00');
  assert.equal(oneRow(rows, '费用汇总', row => row[4] === '统一税金（一次）')[15], '327.96');
  assert.equal(oneRow(rows, '费用汇总', row => row[4] === '含税总预算')[15], '3971.96');
  assert.match(csv.text, /600×600 mm/); assert.match(csv.text, /浙江/);
  evidence.csv = { columns: rows[0], rowCount: rows.length, tile, tileSources, total: '3971.96' };
  pass('实际下载19列用量CSV，地砖净量16/采购16.8、材料1680/人工400/来源2准确，来源追溯和规格保留，固定费100及税327.96各一次');

  const popupEvent = page.waitForEvent('popup'); await pricing().locator('[data-quantity-export="pdf"]').click();
  const popup = await popupEvent; popup.on('pageerror', error => runtimeErrors.push(error.message));
  await popup.waitForLoadState('domcontentloaded');
  const reportText = await popup.locator('body').textContent();
  for (const value of ['工程用量清单', '防滑地砖', '600×600 mm', '16.8', '1680.00', '400.00', '3971.96', '327.96', '验收甲方', 'BJ-20261108']) assert.ok(reportText.includes(value), value);
  const printedTile = popup.locator('.quantity-group').filter({ has: popup.locator('h2').filter({ hasText: /^防滑地砖$/ }) });
  assert.equal(await printedTile.count(), 1); assert.equal(await printedTile.locator('.sources p').count(), 2);
  assert.equal(await popup.locator('.summary p').filter({ hasText: '工程固定费（一次）' }).count(), 1);
  assert.equal(await popup.locator('.summary p').filter({ hasText: '统一税金（一次）' }).count(), 1);
  const pdf = await popup.pdf({ path: join(artifacts, 'project-quantities-full.pdf'), format: 'A4', printBackground: true });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 4000);
  await popup.screenshot({ path: join(artifacts, 'project-quantities-print-report.png'), fullPage: true }); await popup.close();
  evidence.pdf = { header: '%PDF', size: pdf.length, total: '3971.96', tileSourceCount: 2 };
  pass('通过正式用量打印窗口显示完整规格、真实金额及两楼层来源，Chromium实际生成有效PDF，统一税金和工程固定费只出现一次');

  await pricing().locator('[data-pricing-save]').click();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存到本机');
  const saved = await project(); await closePricing();
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getProjectBudget);
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); await frame();
  confirmedPrices(await project()); assert.equal((await budget()).total, '3971.96'); assert.equal((await project()).levels.length, 2);
  await openPricing('quantities');
  assert.equal(await tileGroup().count(), 1); assert.equal(await pricing().locator('[data-quantity-export="csv"]').isDisabled(), false);
  await pricing().locator('[data-pricing-back]').click(); await overview().waitFor();
  const json = await download(overview().locator('[data-overview-export="json"]'), 'project-pricing-full.json');
  const exported = JSON.parse(json.text);
  assert.equal(exported.budgetSummary.total, '3971.96'); assert.equal(exported.levels.length, 2); confirmedPrices(exported);
  await overview().locator('[data-dialog-close]').click(); await overview().waitFor({ state: 'hidden' });
  await importThroughPicker(json.text, '集中报价完整工程重新导入.json');
  confirmedPrices(await project()); assert.equal((await budget()).total, '3971.96');
  evidence.savedProject = { id: saved.id, levelCount: saved.levels.length, activeLevelId: saved.activeLevelId, total: '3971.96' };
  evidence.json = { filename: json.filename, total: exported.budgetSummary.total, levelCount: exported.levels.length };
  pass('报价应用后通过普通保存、刷新和项目列表重开保留两层价格及3971.96元；完整JSON真实下载并经文件选择器重新导入得到相同预算和用量');

  await openPricing('quantities');
  await tileGroup().locator('summary').click();
  await tileGroup().locator('[data-quantity-locate]').filter({ hasText: '首层客厅' }).click();
  await page.locator('#inspector-region-name').waitFor();
  const surfacePrice = page.locator('[data-item-field="unitPrice"]').first();
  await surfacePrice.fill(''); await surfacePrice.press('Tab'); await frame();
  assert.equal((await project()).regions[0].items[0].unitPrice, '');
  assert.equal((await budget()).total, null); assert.equal((await budget()).knownTotal, '2598.56');
  const surfaceRow = (await page.evaluate(() => window.planStudio.getPriceRows())).find(row => row.targetId === '首层客厅' && row.targetType === 'region');
  assert.equal(surfaceRow.netQuantity, '12'); assert.equal(surfaceRow.purchaseQuantity, '12.6');
  assert.equal(surfaceRow.knownTotal, '300.00'); assert.match(surfaceRow.pendingReasons.join('；'), /单价/);
  assert.equal((await page.locator('#total-cost').textContent()).replace(/[,\s]/g, ''), '1414.00');
  assert.match(await page.locator('#quote-total-label').textContent(), /税前/);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存到本机');
  await page.locator('#undo').click(); await waitTotal('3971.96'); await frame(); confirmedPrices(await project());
  pass('原区域属性清空单价同样保留12m²净量、12.6m²采购量与300元人工，显示已知税前金额；待报价工程可正常保存并一次撤销恢复');

  const before3D = await project(), before3DBudget = await budget();
  await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats()?.ready && window.planStudio.getViewMode() === '3d'); await frame();
  const beforeCamera = await page.evaluate(() => window.planStudio.get3DStats().camera);
  await page.locator('#zoom-in').click(); await frame();
  const stats = await page.evaluate(() => window.planStudio.get3DStats());
  assert.equal(stats.ready, true); assert.equal(stats.error, null); assert.equal(stats.glError, 0);
  assert.notDeepEqual(stats.camera, beforeCamera); assert.deepEqual(await project(), before3D); assert.deepEqual(await budget(), before3DBudget);
  await screenshot('project-pricing-design-3d-1440.png');
  await page.locator('[data-view="2d"]').click(); await frame(); evidence.threeD = stats;
  pass('保存与重导后的三维真实渲染且无WebGL错误，缩放只改变相机，不改几何、已应用价格或跨专业预算');

  evidence.layouts = [];
  for (const width of [1440, 1100, 900, 640]) {
    await page.setViewportSize({ width, height: 1000 }); await frame(); await openPricing();
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('#dialog.project-pricing-dialog'), body = dialog.querySelector('.dialog-body'), rect = dialog.getBoundingClientRect();
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        dialog: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth };
    });
    assert.ok(layout.documentWidth <= width, 'document must not overflow horizontally');
    assert.ok(layout.dialog.x >= 0 && layout.dialog.x + layout.dialog.width <= width);
    assert.ok(layout.dialog.y >= 0 && layout.dialog.y + layout.dialog.height <= 1000);
    assert.ok(layout.bodyScrollWidth <= layout.bodyWidth + 1, 'pricing content must not overflow horizontally');
    const actionBoxes = [];
    for (const selector of ['[data-pricing-back]', '[data-pricing-save]', '[data-pricing-apply]', '[data-pricing-discard]', '[data-pricing-undo]', '[data-pricing-redo]']) {
      assert.equal(await pricing().locator(selector).isVisible(), true); const box = await pricing().locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000, selector);
      actionBoxes.push({ selector, ...box });
    }
    for (let a = 0; a < actionBoxes.length; a++) for (let b = a + 1; b < actionBoxes.length; b++) {
      const first = actionBoxes[a], second = actionBoxes[b];
      assert.ok(first.x + first.width <= second.x + 1 || second.x + second.width <= first.x + 1 || first.y + first.height <= second.y + 1 || second.y + second.height <= first.y + 1,
        `${first.selector} must not overlap ${second.selector}`);
    }
    await displayedAmount('[data-pricing-after]', '3971.96'); await screenshot(`project-pricing-complete-${width}.png`);
    await pricing().locator('[data-pricing-tab="quantities"]').click(); await frame();
    const quantityLayout = await pricing().locator('.dialog-body').evaluate(body => ({ clientWidth: body.clientWidth, scrollWidth: body.scrollWidth }));
    assert.ok(quantityLayout.scrollWidth <= quantityLayout.clientWidth + 1, 'quantity groups must not overflow horizontally');
    for (const format of ['csv', 'pdf']) {
      const button = pricing().locator(`[data-quantity-export="${format}"]`); assert.equal(await button.isVisible(), true);
      const box = await button.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000, format);
    }
    await screenshot(`project-quantities-complete-${width}.png`);
    evidence.layouts.push({ ...layout, actionBoxes, quantities: quantityLayout }); await closePricing();
  }
  pass('1440、1100、900和640窗口中报价与用量无横向溢出，底部主要按钮全部可见且互不重叠，按视口保存视觉审查截图');

  assert.deepEqual(runtimeErrors, []); pass('全部流程无浏览器运行时错误，独立Python数据库和浏览器上下文未触碰用户项目');
  outcome = 'passed';
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ outcome, checks: reports.length, reports, runtimeErrors, evidence,
    finalProject: await project(), finalBudget: await budget() }, null, 2));
  process.stdout.write(`\n${reports.length} 项报价与工程用量浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ outcome, error: String(error), reports, runtimeErrors, evidence,
    state: await page?.evaluate(() => ({ project: window.planStudio?.getProject(), budget: window.planStudio?.getProjectBudget(), selection: window.planStudio?.getSelection(),
      toast: document.querySelector('#toast')?.textContent, dialog: document.querySelector('#dialog')?.textContent })).catch(() => ({})) }, null, 2));
  throw error;
} finally {
  await browser?.close(); browserClosed = true;
  if (server.exitCode === null) {
    server.kill(); await new Promise(done => { const timer = setTimeout(done, 5000); server.once('exit', () => { clearTimeout(timer); done(); }); });
  }
  serverStopped = server.exitCode !== null || server.signalCode !== null;
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: serverStopped,
    isolatedStorage: storage, checks: reports.length, runtimeErrors }, null, 2));
}
