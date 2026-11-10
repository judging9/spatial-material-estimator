import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Explicit deterministic upstream fixtures test the real browser UI. This
// acceptance test does not claim to have verified any live market quote.
const root = await mkdtemp(join(tmpdir(), 'studio-saved-price-browser-'));
const artifacts = resolve('artifacts/saved-price-refresh');
await mkdir(artifacts, { recursive: true });
const python = ['D:/python/python.exe', '.venv/Scripts/python.exe'].find(existsSync) || 'python';
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], {
  env: { ...process.env, STUDIO_TEST_ROOT: root, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', data => { stderr += data; });
const baseURL = await new Promise((accept, reject) => {
  const timer = setTimeout(() => reject(new Error(stderr || 'server timeout')), 20000);
  server.stdout.on('data', data => {
    const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { clearTimeout(timer); accept(match[0]); }
  });
  server.on('exit', () => { clearTimeout(timer); reject(new Error(stderr || 'server exited')); });
});
const executablePath = process.env.CHROME_PATH || [
  'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const envelope = data => JSON.stringify({ ok: true, data });
const url = 'https://supplier.example/prices';
const row = (patch = {}) => ({ name: '瓷砖', spec: '600x600', unit: '平方米', price: '88.605',
  region: '杭州', source: '供应商测试报价', supplier: '测试厂家', price_date: '2026-11-01', ...patch });
let rows = [row()], failure = false, hold = false, releaseRead, readStarted;
let previewCalls = 0, rowCalls = 0, browser, outcome = 'failed', browserClosed = false;
const results = [];
const passed = name => { results.push(name); console.log('✓ ' + name); };

try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await page.waitForFunction(() => window.planStudio);
  await page.waitForFunction(() => typeof window.planStudio.getMaterials === 'function');
  const originalMaterials = await page.evaluate(() => window.planStudio.getMaterials());
  const demo = originalMaterials.find(material => material.demo);
  assert.ok(demo, 'the real material library contains explicitly marked demo materials');
  await page.route('**/api/scrape/preview', route => {
    previewCalls++;
    return route.fulfill({ contentType: 'application/json', body: envelope({ url, tables: [{ index: 1,
      sample: [['名称', '单位', '价格', '规格', '日期', '供应商', '地区', '来源'], ['瓷砖', '平方米', '88.605', '600x600', '2026-11-01', '测试厂家', '杭州', '供应商测试报价']] }] }) });
  });
  await page.route('**/api/scrape/rows/preview', async route => {
    rowCalls++;
    const payload = route.request().postDataJSON();
    assert.equal(payload.url, url);
    assert.equal(payload.table_index, 1);
    assert.deepEqual(payload.mapping, { name: 0, unit: 1, price: 2, spec: 3, date: 4, supplier: 5, region: 6, source: 7 });
    const held = hold;
    if (held) { readStarted?.(); await new Promise(accept => { releaseRead = accept; }); }
    try {
      await route.fulfill({ status: failure ? 503 : 200, contentType: 'application/json',
        body: failure ? JSON.stringify({ ok: false, error: '测试上游连接失败' }) : envelope({ url, rows }) });
    } catch (error) { if (!held) throw error; }
  });
  const close = () => page.locator('[data-dialog-close]').click();
  const library = async () => {
    await page.locator('#settings').click();
    await page.locator('#dialog [data-action="manage-materials"]').click();
  };
  const createMaterial = async (fields) => {
    await library();
    await page.locator('#dialog [data-action="new-material"]').click();
    for (const [name, value] of Object.entries(fields)) {
      const control = page.locator(`#material-form [name="${name}"]`);
      if (['unit', 'sourceKind'].includes(name)) await control.selectOption(value);
      else await control.fill(value);
    }
    await page.locator('#material-form button[type="submit"]').click();
    await page.waitForFunction(name => window.planStudio.getMaterials().some(material => material.name === name), fields.name);
    return page.evaluate(name => window.planStudio.getMaterials().find(material => material.name === name), fields.name);
  };
  const created = await createMaterial({ name: '项目瓷砖测试报价', category: '地面', unit: 'm²', unitPrice: '100', wasteRate: '8', color: '#88aa99', description: '原用户备注',
    sourceKind: 'web', quoteSource: '供应商测试报价', quoteRegion: '杭州', quoteDate: '2026-10-31', quoteSupplier: '测试厂家', quoteSpec: '600x600', quoteName: '瓷砖', quoteUrl: url });
  const id = created.id;
  assert.equal(created.provenance.manual, true, 'the material form honestly marks manually entered source prices');
  const show = async () => { await library(); await page.locator('#dialog [data-action="refresh-material-prices"]').click(); };
  const material = () => page.evaluate(id => window.planStudio.getMaterials().find(material => material.id === id), id);
  const materials = () => page.evaluate(() => window.planStudio.getMaterials());
  const refreshButton = () => page.locator(`[data-price-refresh-id="${id}"]`);
  const refreshCheck = () => page.locator(`[data-price-refresh-select="${id}"]`);
  const refreshRow = () => page.locator(`[data-price-refresh-material="${id}"]`);
  const refreshState = () => page.locator(`[data-price-refresh-state="${id}"]`);
  const read = async () => {
    await refreshButton().click();
    await page.waitForFunction(() => !document.querySelector('#price-refresh-read').disabled);
    await refreshState().waitFor();
  };

  await show();
  assert.equal(await page.locator(`[data-price-refresh-select="${demo.id}"]`).isDisabled(), true);
  assert.match(await page.locator(`[data-price-refresh-material="${demo.id}"]`).innerText(), /Demo.*没有在线市场来源/);
  assert.equal(await page.locator('#price-refresh-apply').isDisabled(), true);
  assert.equal(rowCalls, 0);
  passed('无来源 Demo 明确引导关联实际来源，不生成市场价格');

  await read();
  assert.equal(previewCalls, 1);
  assert.equal(rowCalls, 1);
  assert.equal((await material()).unitPrice, '100', 'preview does not commit');
  assert.match(await refreshRow().innerText(), /88\.605/);
  await refreshCheck().uncheck();
  assert.equal(await page.locator('#price-refresh-apply').isDisabled(), true);
  await refreshCheck().check();
  await page.screenshot({ path: join(artifacts, 'refresh-preview-1280.png') });
  await page.locator('#price-refresh-apply').click();
  const updated = await material();
  assert.equal(updated.unitPrice, '88.605');
  assert.equal(updated.provenance.priceDate, '2026-11-01');
  assert.notEqual(updated.provenance.manual, true, 'a confirmed online quote clears prior manual-entry provenance');
  assert.equal(updated.provenance.refresh.tableIndex, 1);
  assert.equal(updated.provenance.refresh.mapping.price, 2);
  assert.equal(updated.wasteRate, '8');
  assert.equal(updated.color, '#88aa99');
  assert.equal(updated.description, '原用户备注');
  assert.deepEqual((await materials()).filter(material => material.id !== id), originalMaterials.map(material => ({ ...material, unitPrice: String(Number(material.unitPrice)) })));
  passed('真实表头映射可保存，预览不写价，勾选确认后保留其他材料参数');

  rows = [row({ price_date: '2026-11-02' })];
  await show(); await read();
  assert.equal(previewCalls, 1, 'saved mapping skips header discovery');
  await page.locator('#price-refresh-apply').click();
  assert.equal((await material()).unitPrice, '88.605');
  assert.equal((await material()).provenance.priceDate, '2026-11-02');
  passed('相同价格的新发布日期仍可刷新，并复用已保存的列映射');

  rows = [row({ price: '91', date_provided: false })];
  await show(); await read();
  assert.match(await refreshRow().innerText(), /报价日期未提供/);
  await page.locator('#price-refresh-apply').click();
  assert.equal((await material()).unitPrice, '91');
  assert.equal((await material()).provenance.priceDate, undefined);
  passed('来源未注明日期时明确显示并清除旧报价日期');

  const webSourceBeforeEdit = (await material()).provenance;
  await library();
  await page.locator(`[data-edit-material="${id}"]`).click();
  await page.locator('#material-form [name="color"]').fill('#789a86');
  await page.locator('#material-form button[type="submit"]').click();
  assert.deepEqual((await material()).provenance, webSourceBeforeEdit, 'appearance edits preserve the raw source unit alias and verified provenance');
  passed('网页原始单位别名与来源元数据在编辑外观时完整保留');

  rows = [row({ unit: '吨' })];
  await show(); await read();
  assert.match(await refreshState().innerText(), /完全一致.*原报价保留/);
  assert.equal(await page.locator('#price-refresh-apply').isDisabled(), true);
  assert.equal((await material()).unitPrice, '91');
  await close();
  failure = true;
  await show(); await read();
  assert.match(await refreshState().innerText(), /连接失败.*原报价保留/);
  assert.equal(await page.locator('#price-refresh-apply').isDisabled(), true);
  assert.equal((await material()).unitPrice, '91');
  await page.screenshot({ path: join(artifacts, 'refresh-error-1280.png') });
  await close(); failure = false;
  passed('单位不匹配和网络失败均保留原报价，不能应用');

  rows = [row({ price: '95', price_date: '2026-11-03' })];
  hold = true;
  const started = new Promise(accept => { readStarted = accept; });
  await show();
  await refreshButton().click();
  await started;
  await close();
  releaseRead();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.equal((await material()).unitPrice, '91');
  hold = false;
  passed('关闭读取中的弹窗取消操作，延迟响应不能写入价格');

  await show();
  await page.locator('#price-refresh-search').fill(demo.name);
  assert.equal(await page.locator('[data-price-refresh-material]').count(), 1);
  await page.locator(`[data-price-link-id="${demo.id}"]`).click();
  assert.match(await page.locator('#dialog').innerText(), /为选中的材料关联真实报价来源/);
  await close();
  passed('搜索及无来源材料的关联入口可操作');

  const officialURL = 'https://www.stats.gov.cn/sj/zxfb/202611/t20261101_test.html';
  await page.route('**/api/scrape/nbs/preview', route => route.fulfill({ contentType: 'application/json', body: envelope({
    url: officialURL, title: '国家统计局测试上游发布期', price_date: '2026-11-01',
    rows: [{ name: '螺纹钢', spec: 'HRB400E', unit: '吨', price: '3450.12', region: '全国', price_date: '2026-11-01', source: '国家统计局' }],
  }) }));
  const official = await createMaterial({ name: '全国钢材测试报价', category: '钢材', unit: '吨', unitPrice: '3300', wasteRate: '3',
    sourceKind: 'nbs', quoteSource: '国家统计局·流通领域重要生产资料', quoteRegion: '全国', quoteDate: '2026-10-31',
    quoteSupplier: '', quoteSpec: 'HRB400E', quoteName: '螺纹钢', quoteUrl: 'https://www.stats.gov.cn/sj/zxfb/' });
  await show();
  await page.locator(`[data-price-refresh-id="${official.id}"]`).click();
  await page.waitForSelector(`[data-price-refresh-state="${official.id}"]`);
  await page.waitForFunction(() => !document.querySelector('#price-refresh-apply').disabled);
  await page.locator('#price-refresh-apply').click();
  const sourceBeforeEdit = (await materials()).find(material => material.id === official.id).provenance;
  assert.equal(sourceBeforeEdit.sourceUrl, officialURL);
  assert.equal(sourceBeforeEdit.refresh.url, 'https://www.stats.gov.cn/sj/zxfb/');
  assert.notEqual(sourceBeforeEdit.manual, true);
  await library();
  await page.locator(`[data-edit-material="${official.id}"]`).click();
  await page.locator('#material-form [name="color"]').fill('#708899');
  await page.locator('#material-form button[type="submit"]').click();
  const sourceAfterEdit = (await materials()).find(material => material.id === official.id).provenance;
  assert.deepEqual(sourceAfterEdit, sourceBeforeEdit, 'editing appearance preserves actual NBS article, refresh list and collection timestamp');
  passed('全国报价真实入口刷新后，编辑外观保留文章来源和刷新列表及读取时间');

  const beforeReload = await materials();
  await page.reload();
  await page.waitForFunction(() => typeof window.planStudio?.getMaterials === 'function');
  assert.deepEqual(await materials(), beforeReload);
  passed('实际材料表单和刷新保存后，重新打开页面保留完整报价来源');

  await show();
  await page.setViewportSize({ width: 540, height: 800 });
  const overflow = await page.locator('#dialog').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect(), list = dialog.querySelector('#price-refresh-list');
    const button = dialog.querySelector('#price-refresh-apply').getBoundingClientRect();
    return { fits: rect.left >= 0 && rect.right <= innerWidth, listFits: list.scrollWidth <= list.clientWidth + 1, buttonFits: button.bottom <= rect.bottom && button.right <= rect.right };
  });
  assert.deepEqual(overflow, { fits: true, listFits: true, buttonFits: true });
  await page.screenshot({ path: join(artifacts, 'refresh-preview-540.png') });
  assert.deepEqual(errors, []);
  passed('窄屏刷新弹窗不溢出，主要交互无运行时错误');

  await writeFile(join(artifacts, 'validation.json'), JSON.stringify({ checks: results.length, results,
    fixtures: 'Deterministic upstream fixture responses; no live market price or external network validation.' }, null, 2));
  console.log(`${results.length} 项已保存来源刷新浏览器验收通过`);
  outcome = 'passed';
} finally {
  releaseRead?.();
  if (browser) { await browser.close(); browserClosed = true; }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill(); await new Promise(done => { if (server.exitCode !== null || server.signalCode !== null) done(); else server.once('exit', done); });
  }
  await writeFile(join(artifacts, 'run-receipt.json'), JSON.stringify({ outcome, browserClosed, isolatedServerStopped: server.exitCode !== null || server.signalCode !== null, isolatedStorage: root, checks: results.length, stderr }, null, 2));
}
