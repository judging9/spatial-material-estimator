import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const storage = await mkdtemp(join(tmpdir(), 'studio-hydraulic-pump-speed-'));
const artifacts = resolve('artifacts/hydraulic-pump-speed');
await mkdir(artifacts, { recursive: true });
const python = existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python';
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '', browser, page;
server.stderr.on('data', chunk => serverErrors += chunk);
const reports = [], errors = [], footerLayouts = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const friction = 22.07601862231587 * .5 ** 1.852;
const parseCSV = csv => csv.trim().split('\r\n').map(row => row.split(','));

try {
  const url = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync), args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(url); await page.waitForFunction(() => window.planStudio?.getProject);
  const project = () => page.evaluate(() => window.planStudio.getProject());
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const solve = () => page.evaluate(async () => { const module = await import('/studio/lib/hydraulics.js'); return module.solveHydraulicNetwork(module.resolveHydraulicSources(window.planStudio.getProject())); });
  const open = async () => { await page.locator('[data-action="municipal-hydraulics"]').first().click(); await page.locator('#hydraulic-editor').waitFor(); };
  const fill = async (kind, id, field, value) => {
    const input = page.locator(`[data-hyd-kind="${kind}"][data-hyd-id="${id}"][data-hyd-field="${field}"]`);
    if (await input.evaluate(element => element.tagName === 'SELECT')) await input.selectOption(value); else await input.fill(String(value));
  };
  const ready = () => page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '计算已完成');
  const pending = () => page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '待填写参数');
  const run = async () => { await page.locator('#hyd-sim-run').click(); await page.waitForFunction(() => document.querySelector('#hyd-sim-run')?.textContent === '运行分析' && document.querySelector('#hyd-sim-results h3')); };
  const back = async () => { await page.locator('#hyd-sim-back').click(); await page.locator('#hydraulic-editor').waitFor(); };
  const download = async (selector, name, columns) => {
    const event = page.waitForEvent('download'); await page.locator(selector).click(); const result = await event;
    await result.saveAs(join(artifacts, name)); const csv = await readFile(await result.path(), 'utf8'), rows = parseCSV(csv);
    assert.ok(csv.startsWith('\uFEFF')); for (const row of rows) assert.equal(row.length, columns); return { csv, rows };
  };
  const capture = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible'));
    await page.screenshot({ path: join(artifacts, name) });
    if (!await page.locator('dialog.hydraulic-dialog[open]').count()) return;
    const layout = await page.evaluate(() => {
      const d = document.querySelector('dialog.hydraulic-dialog[open]'), rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { kind: d.classList.contains('hyd-simulation-dialog') ? 'simulation' : 'parameters', viewport: { width: innerWidth, height: innerHeight }, dialog: rect(d), footer: rect(d.querySelector('.dialog-footer')), buttons: [...d.querySelectorAll('.dialog-footer button')].map(button => ({ id: button.id, ...rect(button) })) };
    });
    footerLayouts.push({ screenshot: name, ...layout });
    for (const button of layout.buttons) assert.ok(button.bottom <= layout.dialog.bottom - 8 && button.bottom <= layout.footer.bottom && button.top >= layout.dialog.top && button.left >= layout.dialog.left && button.right <= layout.dialog.right, JSON.stringify(layout));
  };

  await page.locator('#enter-municipal').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'municipal');
  await page.locator('[data-action="quick-municipal"]').first().click(); await page.locator('#municipal-quick-kind').selectOption('pipeline');
  for (const [key, value] of Object.entries({ x: 5, y: 5, length: 1000, angle: 0, width: 30, height: 120, elevation: 0 })) await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
  await page.locator('#municipal-quick-form [type="submit"]').click(); await frame(); await open();
  const ids = await page.locator('[data-hyd-kind="node"][data-hyd-field="name"]').evaluateAll(inputs => inputs.map(input => input.dataset.hydId));
  const pipeId = await page.locator('[data-hyd-kind="link"][data-hyd-field="name"]').getAttribute('data-hyd-id');
  const speedInput = () => page.locator(`[data-hyd-device="${pipeId}"][data-device-field="pumpSpeed"]`);
  await fill('node', ids[0], 'type', 'reservoir'); await fill('node', ids[0], 'head', 50); await fill('node', ids[1], 'demand', 5);
  await fill('link', pipeId, 'diameter', 100); await fill('link', pipeId, 'roughness', 120);
  await page.locator('.hyd-device-card summary').click(); await page.locator(`[data-hyd-add-pump="${pipeId}"]`).click();
  for (const [index, field, value] of [[0, 'head', 30], [1, 'flow', 20], [1, 'head', 10]]) await page.locator(`[data-hyd-curve="${pipeId}"][data-curve-index="${index}"][data-curve-field="${field}"]`).fill(String(value));
  await ready(); assert.equal(await speedInput().inputValue(), '100'); assert.ok((await page.locator('.hyd-pump-curve strong').innerText()).includes('100%'));
  await speedInput().fill('50'); await ready(); await page.locator('.hyd-device-card').scrollIntoViewIfNeeded(); await capture('pump-speed-input-1440.png');
  await page.locator('#hydraulic-apply').click(); await frame(); const baseline = (await project()).municipalHydraulics, steady = await solve();
  near(baseline.links[0].pump.speed, .5); assert.deepEqual(baseline.links[0].pump.curve, [{ flow: 0, head: 30 }, { flow: 20, head: 10 }]);
  near(steady.links[0].flow, 5); near(steady.links[0].pumpHeadGain, 5); near(steady.nodes[1].head, 55 - friction); near(steady.links[0].pumpSpeedRatio, .5);
  pass('真实界面建立1000m DN100 C120管段与30→10m额定曲线，默认100%，50%得到5m实际扬程与独立末端水头');

  await open(); await page.locator('.hyd-device-card summary').click(); await speedInput().fill(''); await pending();
  assert.ok((await page.locator('#hydraulic-results').innerText()).includes('转速'));
  await speedInput().fill('0'); await page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '条件需核对');
  await page.locator('#hydraulic-apply').click(); assert.equal(await page.locator('#hydraulic-editor').count(), 1); assert.deepEqual((await project()).municipalHydraulics, baseline);
  await speedInput().fill('50'); await ready(); await page.locator(`[data-hyd-add-valve="${pipeId}"]`).click();
  await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="valveK"]`).fill('12'); await speedInput().fill('150'); await ready();
  assert.equal(await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="valveK"]`).inputValue(), '12');
  await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, baseline);
  pass('空转速显示待填写，0%不能应用，调速不会误写阀门K，取消草稿保留原额定曲线和项目');

  await open(); await page.locator('#hydraulic-rebuild').click(); await ready(); await page.locator('.hyd-device-card summary').click();
  assert.equal(await speedInput().inputValue(), '50');
  const device = await download('#hydraulic-export', 'pump-speed-device.csv', 27); assert.ok(device.csv.includes('泵转速比例'));
  await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, baseline);
  pass('源管线重建保留50%设定与额定曲线，27列设备CSV导出实际扬程和转速，取消重建不改项目');

  await open(); await page.locator('.hyd-device-card summary').click(); await speedInput().fill('100'); await ready(); await page.locator('#hydraulic-simulation').click();
  await page.locator('[data-sim-setting="duration"]').fill(String(300 / 3600)); await page.locator('[data-sim-setting="step"]').fill('5');
  const addSpeed = async (time, speed) => {
    await page.locator('#hyd-sim-add-event').click(); let row = page.locator('[data-sim-event-row]').last();
    await row.locator('[data-event-field="kind"]').selectOption('speed'); row = page.locator('[data-sim-event-row]').last();
    await row.locator('[data-event-field="time"]').fill(String(time / 3600)); await row.locator('[data-event-field="targetId"]').selectOption(pipeId); await row.locator('[data-event-field="value"]').fill(String(speed));
  };
  await addSpeed(100, 50); await addSpeed(200, 150); await capture('speed-event-settings-1440.png'); await run();
  assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '时序计算已完成'); assert.equal(await page.locator('.hyd-speed-event').count(), 2);
  await page.locator('#hyd-sim-series').selectOption(`speed:${pipeId}`);
  const stepPoints = await page.locator('.hyd-time-chart polyline').getAttribute('points');
  assert.equal(stepPoints.trim().split(' ').length, 7); const points = stepPoints.trim().split(' ').map(point => point.split(',').map(Number));
  near(points[3][0], points[4][0]); assert.ok(points[3][1] > points[4][1]);
  await page.locator('#hyd-sim-time').fill(await page.locator('#hyd-sim-time').getAttribute('max'));
  const pipeCells = await page.locator('#hyd-sim-results table.hyd-results').nth(1).locator('tbody tr').first().locator('td').allTextContents();
  near(Number(pipeCells[4]), 60, .0001); near(Number(pipeCells[5]), 150); assert.deepEqual((await project()).municipalHydraulics, baseline);
  await page.locator('.hyd-time-chart').scrollIntoViewIfNeeded(); await capture('speed-step-chart-1440.png');
  pass('Worker在100/200秒精确执行50%/150%事件，150%得到60m扬程，转速图使用真实阶梯，运行不应用草稿');

  const time = await download('#hyd-sim-export', 'pump-speed-time-series.csv', 20);
  const links = time.rows.slice(1).filter(row => row[1] === '管段'); assert.equal(links.length, 4);
  for (const row of links) { near(Number(row[7]), 5); near(Number(row[9]), friction); near(Number(row[19]), Number(row[0]) < 100 ? 1 : Number(row[0]) < 200 ? .5 : 1.5); near(Number(row[10]), Number(row[0]) < 100 ? 25 : Number(row[0]) < 200 ? 5 : 60); near(Number(row[17]), 0, 1e-9); }
  near(Number(links.at(-1)[14]), 1.5); near(Number(links.at(-1)[15]), 1.5);
  await page.locator('.hyd-speed-log summary').click(); const log = await download('#hyd-speed-export', 'pump-speed-events.csv', 6);
  assert.equal(log.rows.length, 3); near(Number(log.rows[1][0]), 100); near(Number(log.rows[1][3]), 50); near(Number(log.rows[2][0]), 200); near(Number(log.rows[2][3]), 150);
  assert.equal(await page.locator('.hyd-speed-log tbody tr').count(), 2); await page.locator('.hyd-speed-log').scrollIntoViewIfNeeded(); await capture('speed-events-log-1440.png');
  pass('20列时序与6列转速日志保持真实秒时刻、流量、损失和相似定律扬程，累计需求与供水均1.5m³');

  await back(); await page.locator('#hydraulic-apply').click(); const savedNetwork = (await project()).municipalHydraulics;
  near(savedNetwork.links[0].pump.speed, 1); assert.deepEqual(savedNetwork.simulation.events.map(event => event.value), [.5, 1.5]);
  assert.equal(savedNetwork.pumpSpeedLog, undefined); assert.equal(savedNetwork.simulation.pumpSpeedLog, undefined);
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存到本机'); const saved = await project();
  await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); assert.deepEqual((await project()).municipalHydraulics, savedNetwork);
  await open(); await page.locator('#hydraulic-simulation').click(); await run(); assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '时序计算已完成');
  await page.setViewportSize({ width: 1100, height: 900 }); await page.locator('#hyd-sim-series').selectOption(`speed:${pipeId}`); await page.locator('.hyd-time-chart').scrollIntoViewIfNeeded(); await capture('reopened-speed-chart-1100.png');
  pass('应用并保存刷新重开保留速度比例和事件，额定曲线不变、日志不入项目，重新运行产生相同真实结果');

  await back(); await page.locator('.hyd-device-card summary').click(); await page.locator('.hyd-device-card').scrollIntoViewIfNeeded(); await capture('reopened-speed-input-1100.png'); await speedInput().fill(''); await pending();
  await page.locator('#hydraulic-simulation').click(); await addSpeed(0, 50); await run(); assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '时序计算已完成');
  await page.locator('[data-sim-event-row]').last().locator('[data-event-field="value"]').fill('10'); await run();
  assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '条件需核对'); assert.ok((await page.locator('#hyd-sim-results').innerText()).includes('曲线')); assert.equal(await page.locator('#hyd-sim-time').count(), 0);
  await page.locator('[data-sim-event-row]').last().locator('[data-event-field="value"]').fill('50'); await run();
  await page.locator('[data-sim-event-row]').nth(1).locator('[data-event-field="value"]').fill('10'); await run();
  assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '条件需核对'); assert.ok((await page.locator('#hyd-sim-results').innerText()).includes('200.000000 秒'));
  await page.locator('#hyd-sim-results').scrollIntoViewIfNeeded(); await capture('scaled-curve-range-warning-1100.png');
  await back(); await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, savedNetwork);
  pass('时间0转速事件可完成空初始设定；10%有效曲线最大2L/s不能供应5L/s时在真实0/200秒暂停，禁止外推');

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
  assert.ok(footerLayouts.some(layout => layout.viewport.width === 1440)); assert.ok(footerLayouts.some(layout => layout.viewport.width === 1100));
  for (const kind of ['parameters', 'simulation']) for (const width of [1440, 1100]) assert.ok(footerLayouts.some(layout => layout.kind === kind && layout.viewport.width === width));
  pass('1440/1100设置、事件、阶梯图、日志与错误状态均无溢出，底部按钮完整可操作，浏览器无运行异常');
  await writeFile(join(artifacts, 'footer-layout.json'), JSON.stringify(footerLayouts, null, 2));
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, runtimeErrors: errors, footerLayouts, steady, savedNetwork, timeRows: time.rows, speedLogRows: log.rows, stepPoints, expectedFriction: friction }, null, 2));
  process.stdout.write(`\n${reports.length} 项泵转速浏览器验收通过。\n`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  if (page) await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, runtimeErrors: errors, project: await page.evaluate(() => window.planStudio?.getProject()).catch(() => null) }, null, 2));
  throw error;
} finally { await browser?.close(); server.kill(); }
