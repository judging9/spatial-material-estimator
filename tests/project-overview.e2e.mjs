import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { budgetFixture } from './project-budget-fixture.mjs';

// Verify the actual served application through ordinary controls and imports.
// Never build or modify served modules while the browser is running.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/project-overview');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-project-overview-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
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
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); cell = ''; rows.push([...row]); row.length = 0;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false, 'CSV must have complete quoted cells');
  return rows;
};
const oneCSVRow = (rows, type, predicate = () => true) => {
  const matching = rows.filter(row => row[0] === type && predicate(row));
  assert.equal(matching.length, 1, `${type} should occur exactly once`);
  return matching[0];
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
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getProjectBudget);
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const budget = () => page.evaluate(() => window.planStudio.getProjectBudget());
  const overview = () => page.locator('#dialog.project-overview-dialog');
  const closeOverview = async () => {
    await overview().locator('[data-dialog-close]').click();
    await overview().waitFor({ state: 'hidden' }); await frame();
  };
  const openOverview = async () => {
    await page.locator('#project-overview').click(); await overview().waitFor(); await frame();
  };
  const input = (field, meta = false) => overview().locator(`[data-overview-${meta ? 'meta' : 'project-field'}="${field}"]`);
  const edit = async (field, value, meta = false) => {
    await input(field, meta).fill(String(value)); await input(field, meta).press('Tab'); await frame();
  };
  const waitTotal = total => page.waitForFunction(expected => window.planStudio.getProjectBudget().total === expected, total);
  const renderedTotal = async expected => {
    const text = await overview().locator('[data-overview-total]').textContent();
    assert.equal(text.replace(/[¥,\s]/g, ''), expected);
  };
  const importThroughPicker = async (text, name) => {
    await page.locator('#open-project').click();
    const event = page.waitForEvent('filechooser');
    await page.locator('#dialog [data-action="import-project"]').click();
    const chooser = await event;
    await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('完整项目已导入') && document.querySelector('#project-file').value === '');
    await frame();
  };
  const downloadFromOverview = async (format, filename) => {
    const event = page.waitForEvent('download');
    await overview().locator(`[data-overview-export="${format}"]`).click();
    const download = await event;
    assert.equal(await download.failure(), null); await download.saveAs(join(artifacts, filename));
    const text = await readFile(await download.path(), 'utf8');
    return { text, name: download.suggestedFilename() };
  };
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await frame(); await page.screenshot({ path: join(artifacts, name) });
  };

  assert.equal((await project()).drawing, null);
  await openOverview();
  assert.equal((await budget()).status, 'empty'); assert.equal((await budget()).total, null);
  assert.equal((await overview().locator('[data-overview-total]').textContent()).trim(), '—');
  assert.equal(await overview().locator('[data-overview-step].is-complete').count(), 0);
  assert.equal(await overview().locator('[data-overview-next-action]').getAttribute('data-overview-next-action'), 'calibrate');
  assert.equal(await overview().locator('[data-overview-export="csv"]').isDisabled(), true);
  assert.equal(await overview().locator('[data-overview-export="pdf"]').isDisabled(), true);
  await screenshot('project-overview-empty-1440.png'); await closeOverview();
  pass('空工程显示真实四步引导与待开始状态，不显示完整零价预算，CSV和PDF在无工程对象时禁用');

  const importedFixture = budgetFixture({ pending: true });
  // A project without explicit selection flags exercises default scope. Only
  // scope metadata is omitted; all two-storey dimensions and prices are intact.
  delete importedFixture.budget.included;
  await importThroughPicker(JSON.stringify(importedFixture), '综合工程待填价格.json');
  assert.equal((await project()).id, importedFixture.id); assert.equal((await project()).levels.length, 2);
  await openOverview();
  for (const section of ['decoration', 'civil', 'municipal'])
    assert.equal(await overview().locator(`[data-overview-include="${section}"]`).isChecked(), true);
  const pendingBudget = await budget();
  assert.equal(pendingBudget.pending, true); assert.equal(pendingBudget.total, null);
  assert.equal(pendingBudget.knownTotal, '3612.26'); await renderedTotal('3612.26');
  assert.match(await overview().locator('[data-overview-total-label]').textContent(), /已定价部分/);
  const missingBed = pendingBudget.issues.find(issue => issue.targetType === 'furniture' && issue.targetId === '二楼床' && issue.severity === 'pending');
  assert.ok(missingBed); assert.equal(missingBed.section, 'decoration');
  evidence.pendingBudget = pendingBudget;
  pass('通过真实文件导入两层装修、土建与道路工程，已有三个专业自动汇入；二楼床缺价时总价保持待完善，已确认含税小计3612.26元');

  const pendingCSV = await downloadFromOverview('csv', 'project-budget-pending.csv');
  const pendingRows = parseCSV(pendingCSV.text); for (const row of pendingRows) assert.equal(row.length, 20);
  const bedPending = oneCSVRow(pendingRows, '专业分项', row => row[4] === '二楼床');
  assert.equal(bedPending[10], '待填写'); assert.match(bedPending[18], /待完善/);
  assert.equal(oneCSVRow(pendingRows, '工程总汇')[17], '3612.26');
  assert.match(oneCSVRow(pendingRows, '工程总汇')[18], /待完善/);
  assert.equal(oneCSVRow(pendingRows, '工程固定费')[17], '100.00');
  pass('待完善总预算实际导出CSV，缺价项目明确标待填写，已确认金额及统一固定费准确保留');

  await overview().locator('#overview-search').fill('不存在的项目'); await frame();
  assert.equal(await overview().locator('[data-overview-issue]').count(), 0);
  assert.match(await overview().locator('[data-overview-issues]').textContent(), /没有匹配/);
  await overview().locator('#overview-search').fill('二楼床'); await frame();
  assert.equal(await overview().locator('[data-overview-issue]').count(), 1);
  const beforeLocate = await budget(), beforeViewport = await page.evaluate(() => window.planStudio.getViewport());
  await overview().locator(`[data-overview-issue="${missingBed.id}"]`).click();
  await page.waitForFunction(expected => window.planStudio.getProject().activeLevelId === expected, missingBed.levelId);
  await page.locator('#furniture-unitPrice').waitFor(); await frame();
  const selection = await page.evaluate(() => window.planStudio.getSelection());
  assert.equal(selection.furnitureId, '二楼床'); assert.equal(await page.locator('#furniture-name').inputValue(), '二楼床');
  assert.equal(await page.evaluate(() => window.planStudio.getWorkspaceMode()), 'decoration');
  assert.deepEqual(await budget(), beforeLocate);
  const afterViewport = await page.evaluate(() => window.planStudio.getViewport());
  assert.notDeepEqual(afterViewport, beforeViewport, '定位应把对应家具放入清晰可见的画布视野');
  evidence.locate = { target: missingBed, selection, beforeViewport, afterViewport };
  await screenshot('project-overview-located-bedroom-1440.png');
  pass('搜索待处理项目后，一键切到二楼并选中缺价床，画布聚焦和右侧属性同步，定位过程保持跨专业预算不变');

  await page.locator('#furniture-unitPrice').fill('150'); await page.locator('#furniture-unitPrice').press('Tab');
  await waitTotal('3775.76');
  assert.equal((await project()).furniture.find(item => item.id === '二楼床').unitPrice, '150');
  await openOverview();
  const completeBudget = await budget();
  assert.equal(completeBudget.pending, false); assert.equal(completeBudget.status, 'ready');
  assert.deepEqual(completeBudget.sections.map(section => [section.id, section.knownSubtotal]), [['decoration', '2394.00'], ['civil', '220.00'], ['municipal', '750.00']]);
  assert.equal(completeBudget.additionalCost, '100.00'); assert.equal(completeBudget.knownTax, '311.76');
  await renderedTotal('3775.76');
  assert.equal(await overview().locator('[data-overview-step].is-complete').count(), 4);
  assert.equal(await overview().locator('[data-overview-issue].is-info').count(), 0);
  await overview().locator('[data-overview-filter="info"]').click(); await frame();
  assert.ok(await overview().locator('[data-overview-issue].is-info').count() > 0);
  await overview().locator('[data-overview-filter="pending"]').click(); await frame();
  assert.equal(await overview().locator('[data-overview-issue]').count(), 0);
  evidence.completeBudget = completeBudget;
  pass('通过普通家具单价输入补齐150元，装修2394元、土建220元、市政750元，固定费100元和一次9%税金形成3775.76元总预算；检查类别可切换');

  await overview().locator('[data-overview-include="civil"]').uncheck(); await waitTotal('3535.96'); await renderedTotal('3535.96');
  assert.equal((await budget()).sections.find(section => section.id === 'civil').included, false);
  assert.equal((await budget()).sections.find(section => section.id === 'civil').itemCount, 2);
  assert.match(await overview().locator('[data-overview-section="civil"] [data-overview-section-state]').textContent(), /未汇入/);
  const subsetCSV = await downloadFromOverview('csv', 'project-budget-without-civil.csv'), subsetRows = parseCSV(subsetCSV.text);
  const excluded = oneCSVRow(subsetRows, '排除专业', row => row[2] === '土建');
  assert.equal(excluded[17], ''); assert.match(excluded[19], /220\.00/);
  assert.equal(oneCSVRow(subsetRows, '工程总汇')[17], '3535.96');
  assert.equal(subsetRows.filter(row => row[0] === '专业分项' && row[2] === '土建').length, 0);
  await overview().locator('[data-overview-undo]').click(); await waitTotal('3775.76');
  assert.equal(await overview().locator('[data-overview-include="civil"]').isChecked(), true); await renderedTotal('3775.76');
  await overview().locator('[data-overview-redo]').click(); await waitTotal('3535.96');
  assert.equal(await overview().locator('[data-overview-include="civil"]').isChecked(), false); await renderedTotal('3535.96');
  await overview().locator('[data-overview-undo]').click(); await waitTotal('3775.76');
  pass('手动排除土建后总价3535.96元，原构件保留且CSV明确排除；在总览内撤销和重做范围修改，勾选状态及金额即时同步');

  await edit('additionalCost', '200'); await waitTotal('3884.76'); await renderedTotal('3884.76');
  await edit('taxRate', '8'); await waitTotal('3849.12'); await renderedTotal('3849.12');
  assert.equal((await budget()).knownTax, '285.12');
  await overview().locator('[data-overview-undo]').click(); await waitTotal('3884.76');
  assert.equal(await input('taxRate').inputValue(), '9'); await renderedTotal('3884.76');
  await overview().locator('[data-overview-undo]').click(); await waitTotal('3775.76');
  assert.equal(await input('additionalCost').inputValue(), '100'); await renderedTotal('3775.76');
  await overview().locator('[data-overview-redo]').click(); await waitTotal('3884.76');
  assert.equal(await input('additionalCost').inputValue(), '200');
  await overview().locator('[data-overview-undo]').click(); await waitTotal('3775.76');
  assert.equal(await input('additionalCost').inputValue(), '100');
  pass('统一固定费和税率按一次收费真实重算，费用200元/税率8%得到3849.12元；总览内逐步撤销重做同时恢复输入值和报价');

  await edit('taxRate', '-1');
  assert.equal((await budget()).total, '3775.76'); assert.equal((await project()).taxRate, '9');
  assert.equal(await input('taxRate').evaluate(element => element.classList.contains('validation-error')), true);
  assert.ok((await overview().locator('#overview-budget-error').textContent()).trim());
  await overview().locator('[data-overview-save]').click(); await frame();
  assert.match(await overview().locator('#overview-budget-error').textContent(), /统一税率不能小于 0/);
  assert.equal(await input('taxRate').evaluate(element => document.activeElement === element), true);
  await edit('taxRate', '9'); assert.equal(await input('taxRate').evaluate(element => element.classList.contains('validation-error')), false);
  assert.equal((await budget()).total, '3775.76');
  pass('非法税率不会覆盖有效项目金额，输入错误与保存阻止提示清晰，修正后恢复正常状态');

  const metadata = { client: '华清建设有限公司', reference: '工程报价-2026-011', note: '包含两层室内装修、土建和室外道路；材料按用户确认价格计取。' };
  for (const [field, value] of Object.entries(metadata)) await edit(field, value, true);
  assert.deepEqual((await budget()).metadata, metadata);
  await overview().locator('[data-overview-save]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  const saved = await project(); await closeOverview();
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getProjectBudget);
  await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); await frame();
  assert.equal((await budget()).total, '3775.76'); assert.deepEqual((await budget()).metadata, metadata);
  assert.equal((await project()).levels.length, 2);
  assert.equal((await project()).furniture.find(item => item.id === '二楼床').unitPrice, '150');
  await openOverview();
  for (const [field, value] of Object.entries(metadata)) assert.equal(await input(field, true).inputValue(), value);
  evidence.savedMetadata = metadata;
  pass('甲方、报价编号、范围备注和专业范围随工程保存，刷新后通过项目列表重开保留两层设计、补齐价格及3775.76元总预算');

  const completeCSV = await downloadFromOverview('csv', 'project-budget-full.csv');
  assert.match(completeCSV.name, /工程总预算\.csv$/);
  const rows = parseCSV(completeCSV.text); for (const row of rows) assert.equal(row.length, 20);
  for (const [section, amount] of [['装修', '2394.00'], ['土建', '220.00'], ['市政', '750.00']])
    assert.equal(oneCSVRow(rows, '专业税前汇总', row => row[2] === section)[17], amount);
  assert.equal(rows.filter(row => row[0] === '专业税前汇总').length, 3);
  assert.equal(oneCSVRow(rows, '工程固定费')[17], '100.00');
  assert.equal(oneCSVRow(rows, '工程税前汇总')[17], '3464.00');
  assert.equal(oneCSVRow(rows, '工程税金')[17], '311.76');
  assert.equal(oneCSVRow(rows, '工程总汇')[17], '3775.76');
  const floor = oneCSVRow(rows, '专业分项', row => row[4] === '首层客厅' && row[5] === '用户确认材料');
  assert.equal(floor[8], '12'); assert.equal(floor[9], '13.2'); assert.equal(floor[13], '1320.00'); assert.equal(floor[14], '240.00');
  for (const value of Object.values(metadata)) assert.ok(completeCSV.text.includes(value));
  assert.ok(rows.some(row => row[3] === '二楼' && row[4] === '二楼床' && row[17] === '150.00'));
  evidence.csv = { columns: rows[0], rows: rows.length, total: oneCSVRow(rows, '工程总汇')[17], fixedFeeRows: 1, taxRows: 1 };
  pass('完整总预算CSV实际下载，净施工12m²与采购13.2m²、材料1320元及人工240元正确；各专业税前汇总与工程固定费、税金分别只列一次');

  const popupEvent = page.waitForEvent('popup');
  await overview().locator('[data-overview-export="pdf"]').click();
  const popup = await popupEvent; popup.on('pageerror', error => runtimeErrors.push(error.message));
  await popup.waitForLoadState('domcontentloaded');
  const reportText = await popup.locator('body').textContent();
  for (const value of ['工程总预算', '3775.76', '311.76', '2394.00', '220.00', '750.00', ...Object.values(metadata)]) assert.ok(reportText.includes(value), value);
  assert.equal(await popup.locator('[data-budget-section]').count(), 3);
  assert.equal(await popup.locator('.summary p').filter({ hasText: '项目固定费用（一次）' }).count(), 1);
  assert.equal(await popup.locator('.summary p').filter({ hasText: '税金（9% / 一次）' }).count(), 1);
  const pdf = await popup.pdf({ path: join(artifacts, 'project-budget-full.pdf'), format: 'A4', printBackground: true });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 4000);
  await popup.screenshot({ path: join(artifacts, 'project-budget-print-report.png'), fullPage: true }); await popup.close();
  evidence.pdf = { size: pdf.length, header: '%PDF', reportTotal: '3775.76' };
  pass('通过总览打开正式打印报价页，甲方与各专业金额齐全，Chromium实际生成有效PDF文件，固定费和税金各一次');

  const downloadedJSON = await downloadFromOverview('json', 'project-budget-full.json');
  const exported = JSON.parse(downloadedJSON.text);
  assert.deepEqual(exported.budget, (await project()).budget); assert.equal(exported.budgetSummary.total, '3775.76');
  assert.equal(exported.levels.length, 2); assert.equal(exported.drawing.type, 'plan');
  await closeOverview();
  await importThroughPicker(downloadedJSON.text, '综合工程完整项目.json');
  assert.equal((await budget()).total, '3775.76'); assert.deepEqual((await budget()).metadata, metadata);
  assert.equal((await budget()).sections.find(section => section.id === 'civil').itemCount, 2);
  evidence.importedBudget = await budget();
  pass('实际下载含完整图纸、楼层、几何与预算设置的JSON，再通过普通导入入口恢复并重新计算相同总预算');

  const before3D = await budget();
  await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(() => window.planStudio.get3DStats()?.ready && window.planStudio.getViewMode() === '3d'); await frame();
  const beforeCameraProject = await project(), beforeCamera = await page.evaluate(() => window.planStudio.get3DStats().camera);
  await page.locator('#zoom-in').click(); await frame();
  const afterCamera = await page.evaluate(() => window.planStudio.get3DStats().camera);
  assert.notDeepEqual(afterCamera, beforeCamera); assert.deepEqual(await project(), beforeCameraProject);
  assert.deepEqual(await budget(), before3D);
  const stats = await page.evaluate(() => window.planStudio.get3DStats());
  assert.equal(stats.ready, true); assert.equal(stats.error, null); assert.equal(stats.glError, 0);
  await screenshot('project-overview-design-3d-1440.png');
  await page.locator('[data-view="2d"]').click(); await frame();
  evidence.camera = { before: beforeCamera, after: afterCamera, stats };
  pass('导入后的真实三维正常渲染，缩放仅改变相机，工程源数据和跨专业预算保持完全一致');

  evidence.layouts = [];
  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 1000 }); await frame();
    const entry = await page.locator('#project-overview').boundingBox();
    assert.ok(entry && entry.x >= 0 && entry.x + entry.width <= width && entry.y >= 0 && entry.y + entry.height <= 1000);
    assert.equal(await page.locator('#project-overview').isVisible(), true);
    await openOverview();
    await overview().locator('[data-overview-next-title]').scrollIntoViewIfNeeded(); await frame();
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('#dialog.project-overview-dialog'), body = dialog.querySelector('.dialog-body'), rect = dialog.getBoundingClientRect();
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, dialog: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth };
    });
    assert.ok(layout.documentWidth <= width); assert.ok(layout.dialog.x >= 0 && layout.dialog.x + layout.dialog.width <= width);
    assert.ok(layout.dialog.y >= 0 && layout.dialog.y + layout.dialog.height <= 1000);
    assert.ok(layout.bodyScrollWidth <= layout.bodyWidth + 1, '总览内容不能出现横向溢出');
    for (const selector of ['[data-overview-save]', '[data-overview-export="csv"]', '[data-overview-export="pdf"]', '[data-overview-undo]', '[data-overview-redo]']) {
      const box = await overview().locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000, selector);
    }
    await renderedTotal('3775.76'); await screenshot(`project-overview-complete-${width}.png`);
    evidence.layouts.push({ ...layout, entry }); await closeOverview();
  }
  pass('1440、1100与900窗口下总览入口可用，内容无横向溢出，保存、撤销、重做和导出始终位于可见范围');

  assert.deepEqual(runtimeErrors, []); pass('全部流程无浏览器运行时或WebGL错误，测试使用独立数据库与浏览器上下文');
  outcome = 'passed';
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ outcome, checks: reports.length, reports, runtimeErrors, evidence,
    finalProject: await project(), finalBudget: await budget() }, null, 2));
  process.stdout.write(`\n${reports.length} 项工程总览浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ outcome, error: String(error), reports, runtimeErrors, evidence,
    state: await page?.evaluate(() => ({ project: window.planStudio?.getProject(), budget: window.planStudio?.getProjectBudget(), selection: window.planStudio?.getSelection(),
      toast: document.querySelector('#toast')?.textContent, overview: document.querySelector('#dialog')?.textContent })).catch(() => ({})) }, null, 2));
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
