import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
const storage = await mkdtemp(join(tmpdir(), 'studio-hydraulic-devices-')), artifacts = resolve(process.env.HYDRAULIC_DEVICES_ARTIFACTS || 'artifacts/hydraulic-devices'); await mkdir(artifacts, { recursive: true });
const python = existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python';
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '', browser, page; server.stderr.on('data', chunk => serverErrors += chunk); const reports = [], errors = [], footerLayouts = [], pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
try {
  const url = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 20000); server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } }); });
  browser = await chromium.launch({ headless: true, executablePath: ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync), args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); await page.goto(url); await page.waitForFunction(() => window.planStudio?.getProject);
  const project = () => page.evaluate(() => window.planStudio.getProject()), frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const solve = () => page.evaluate(async () => { const module = await import('/studio/lib/hydraulics.js'); return module.solveHydraulicNetwork(module.resolveHydraulicSources(window.planStudio.getProject())); });
  const open = async () => { await page.locator('[data-action="municipal-hydraulics"]').first().click(); await page.locator('#hydraulic-editor').waitFor(); };
  const fill = async (kind, id, field, value) => { const input = page.locator(`[data-hyd-kind="${kind}"][data-hyd-id="${id}"][data-hyd-field="${field}"]`); if (await input.evaluate(element => element.tagName === 'SELECT')) await input.selectOption(value); else await input.fill(String(value)); };
  const ready = () => page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '计算已完成');
  const capture = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible')); await page.screenshot({ path: join(artifacts, name) });
    if (await page.locator('dialog.hydraulic-dialog[open]').count()) {
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('dialog.hydraulic-dialog[open]'), rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
        return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(dialog), head: rect(dialog.querySelector('.dialog-head')), body: rect(dialog.querySelector('.dialog-body')), footer: rect(dialog.querySelector('.dialog-footer')), buttons: [...dialog.querySelectorAll('.dialog-footer button')].map(button => ({ id: button.id, ...rect(button) })) };
      });
      footerLayouts.push({ screenshot: name, ...layout }); await writeFile(join(artifacts, 'footer-layout.json'), JSON.stringify(footerLayouts, null, 2));
      for (const button of layout.buttons) assert.ok(button.top >= layout.dialog.top && button.bottom <= layout.dialog.bottom - 8 && button.left >= layout.dialog.left && button.right <= layout.dialog.right && button.bottom <= layout.footer.bottom && button.bottom <= layout.viewport.height, `Footer button clipped: ${JSON.stringify({ screenshot: name, dialog: layout.dialog, footer: layout.footer, button })}`);
    }
  };
  await page.locator('#enter-municipal').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'municipal');
  await page.locator('[data-action="quick-municipal"]').first().click(); await page.locator('#municipal-quick-kind').selectOption('pipeline');
  for (const [key, value] of Object.entries({ x: 5, y: 5, length: 1000, angle: 0, width: 30, height: 120, elevation: 0 })) await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
  await page.locator('#municipal-quick-form [type="submit"]').click(); await frame(); await open();
  const ids = await page.locator('[data-hyd-kind="node"][data-hyd-field="name"]').evaluateAll(inputs => inputs.map(input => input.dataset.hydId)), pipeId = await page.locator('[data-hyd-kind="link"][data-hyd-field="name"]').getAttribute('data-hyd-id');
  await fill('node', ids[0], 'type', 'reservoir'); await fill('node', ids[0], 'head', 50); await fill('node', ids[1], 'demand', 1); await fill('link', pipeId, 'diameter', 100); await fill('link', pipeId, 'roughness', 120);
  await page.locator('.hyd-device-card summary').click(); await page.locator(`[data-hyd-add-pump="${pipeId}"]`).click();
  assert.equal(await page.locator('.hyd-device-card').evaluate(card => card.open), true);
  await page.locator(`[data-hyd-curve="${pipeId}"][data-curve-index="0"][data-curve-field="head"]`).fill('30'); await page.locator(`[data-hyd-curve="${pipeId}"][data-curve-index="1"][data-curve-field="flow"]`).fill('20'); await page.locator(`[data-hyd-curve="${pipeId}"][data-curve-index="1"][data-curve-field="head"]`).fill('10'); await ready();
  await page.locator('#hydraulic-results .hyd-results').first().scrollIntoViewIfNeeded(); assert.ok((await page.locator('#hydraulic-results').innerText()).includes('29')); await capture('pump-low-flow-results-1440.png'); await page.locator('#hydraulic-apply').click(); await frame(); const pumpNetwork = (await project()).municipalHydraulics, pumpResult = await solve();
  assert.equal(pumpResult.status, 'ready'); near(pumpResult.links[0].flow, 1); near(pumpResult.links[0].pumpHeadGain, 29); near(pumpResult.nodes[1].head, 79 - 22.07601862231587 * .1 ** 1.852);
  pass('真实UI添加制造商曲线，1L/s低流泵稳定求解29m扬程、独立摩阻与末端总水头，曲线控件编辑后保持展开');
  await open(); await page.locator('#hydraulic-rebuild').click(); await ready(); await page.locator('.hyd-device-card summary').click(); assert.equal(await page.locator(`[data-hyd-curve="${pipeId}"][data-curve-index="0"][data-curve-field="head"]`).inputValue(), '30');
  const deviceCSVEvent = page.waitForEvent('download'); await page.locator('#hydraulic-export').click(); const deviceDownload = await deviceCSVEvent; await deviceDownload.saveAs(join(artifacts, 'pump-device.csv')); const deviceCSV = await readFile(await deviceDownload.path(), 'utf8'); assert.equal(deviceCSV.split('\r\n')[0].split(',').length, 27); assert.ok(deviceCSV.includes('pump-running')); assert.ok(deviceCSV.includes('泵扬程 m')); assert.ok(deviceCSV.includes('泵转速比例')); await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, pumpNetwork);
  pass('从当前真实源管重建保留泵曲线及内径，显式27列设备CSV包含实际扬程、转速与运行状态，关闭重建草稿不改项目');
  await open(); await page.locator('.hyd-device-card summary').click(); await page.locator(`[data-hyd-add-valve="${pipeId}"]`).click(); await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="valveK"]`).fill('12'); await ready();
  await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="valveOpen"]`).selectOption('false'); await page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '待填写参数'); await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="valveOpen"]`).selectOption('true'); await ready();
  await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="pumpEnabled"]`).selectOption('false'); await page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '待填写参数'); await page.locator(`[data-hyd-device="${pipeId}"][data-device-field="pumpEnabled"]`).selectOption('true'); await ready(); await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, pumpNetwork);
  pass('节流阀K可编辑，关闭阀门或停泵导致真实隔离时显示待确认，重新打开恢复计算，取消不会改项目');
  const configureTank = async () => {
    await fill('node', ids[0], 'type', 'tank'); await fill('node', ids[0], 'elevation', 10); await fill('node', ids[0], 'demand', 2); await fill('node', ids[1], 'demand', 10);
    for (const [field, value] of Object.entries({ area: 100, minLevel: 1, maxLevel: 6, initialLevel: 5 })) await page.locator(`[data-hyd-tank="${ids[0]}"][data-tank-field="${field}"]`).fill(String(value));
    await page.locator('.hyd-device-card summary').click(); await page.locator(`[data-hyd-remove-pump="${pipeId}"]`).click(); await ready();
  };
  const configureSimulation = async () => {
    await page.locator('#hydraulic-simulation').click(); await page.locator('#hydraulic-simulation-editor').waitFor(); await page.locator('[data-sim-setting="duration"]').fill(String(600 / 3600)); await page.locator('[data-sim-setting="step"]').fill('1'); await page.locator('#hyd-sim-add-event').click();
    const row = page.locator('[data-sim-event-row]').last(); await row.locator('[data-event-field="time"]').fill(String(300 / 3600)); await row.locator('[data-event-field="targetId"]').selectOption(ids[1]); await row.locator('[data-event-field="value"]').fill('20');
  };
  const run = async () => { await page.locator('#hyd-sim-run').click(); await page.waitForFunction(() => document.querySelector('#hyd-sim-run')?.textContent === '运行分析' && document.querySelector('#hyd-sim-results h3')); };
  await open(); await configureTank(); await configureSimulation(); assert.deepEqual((await project()).municipalHydraulics, pumpNetwork); await run(); assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '时序计算已完成');
  await page.locator('#hyd-sim-time').fill(await page.locator('#hyd-sim-time').getAttribute('max')); await page.locator('.hyd-time-chart').scrollIntoViewIfNeeded(); assert.ok((await page.locator('#hyd-sim-results').innerText()).includes('4.898')); await capture('tank-time-series-1440.png');
  const csvEvent = page.waitForEvent('download'); await page.locator('#hyd-sim-export').click(); const download = await csvEvent; await download.saveAs(join(artifacts, 'tank-time-series.csv')); const csv = await readFile(await download.path(), 'utf8'); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('体积守恒误差 m³')); assert.ok(csv.includes('4.898')); for (const row of csv.trim().split('\r\n')) assert.equal(row.split(',').length, 20); assert.ok(csv.includes('泵转速比例'));
  pass('未应用草稿可运行后台Worker，600s水池本地2L/s与300s改为20L/s需求给出4.898m真实液位，图表/时刻/CSV同步');
  await page.locator('#hyd-sim-back').click(); await page.locator('#hydraulic-editor').waitFor(); assert.equal(await page.locator(`[data-hyd-tank="${ids[0]}"][data-tank-field="area"]`).inputValue(), '100'); assert.deepEqual((await project()).municipalHydraulics, pumpNetwork); await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, pumpNetwork);
  pass('时序返回保留设备、水池和事件编辑草稿，关闭父编辑器仍保持原项目，模拟无隐式应用');
  await open(); await configureTank(); await configureSimulation(); await page.locator('[data-dialog-close]').click(); await page.locator('#hydraulic-editor').waitFor(); await page.locator('#hydraulic-apply').click(); const savedNetwork = (await project()).municipalHydraulics;
  assert.equal(savedNetwork.nodes[0].type, 'tank'); assert.equal(savedNetwork.simulation.events.length, 1); assert.equal(savedNetwork.simulation.duration, 600); assert.equal(savedNetwork.frames, undefined);
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存到本机'); const saved = await project(); await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click(); await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); assert.deepEqual((await project()).municipalHydraulics, savedNetwork);
  await open(); await page.locator('#hydraulic-rebuild').click(); assert.equal(await page.locator(`[data-hyd-tank="${ids[0]}"][data-tank-field="area"]`).inputValue(), '100'); await page.setViewportSize({ width: 1100, height: 900 }); await page.locator('.hyd-tank-inputs').scrollIntoViewIfNeeded(); await capture('tank-inputs-1100.png'); await page.locator('#hydraulic-simulation').click(); assert.equal(await page.locator('[data-sim-event-row]').count(), 1); await run(); assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '时序计算已完成'); await page.locator('#hyd-sim-time').fill(await page.locator('#hyd-sim-time').getAttribute('max')); assert.ok((await page.locator('#hyd-sim-results').innerText()).includes('4.898')); await page.locator('.hyd-time-chart').scrollIntoViewIfNeeded(); await capture('tank-time-series-1100.png');
  pass('明确应用后设备、水池和时序设置保存刷新重开完整恢复，只存条件，重新运行得到同一4.898m液位');
  await page.locator('[data-sim-delete-event]').click(); await page.locator('[data-sim-setting="duration"]').fill('12'); await page.locator('[data-sim-setting="step"]').fill('30'); await run(); assert.equal(await page.locator('#hyd-sim-results h3').innerText(), '已达到水池液位边界');
  assert.ok((await page.locator('#hyd-sim-results').innerText()).includes('33333.333333')); await page.locator('#hyd-sim-time').fill(await page.locator('#hyd-sim-time').getAttribute('max')); await page.locator('.hyd-time-chart').scrollIntoViewIfNeeded(); await capture('tank-min-boundary-1100.png');
  pass('12h时序在33333.333333秒真实触最低液位时停止，精确边界时刻、液位和体积误差清晰显示');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []); pass('1440/1100设备、水池、时序曲线与返回草稿无页面横向溢出或运行异常');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, runtimeErrors: errors, footerLayouts, pumpResult, savedNetwork }, null, 2)); process.stdout.write(`\n${reports.length} 项设备与时序浏览器验收通过。\n`);
} catch (error) { await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); if (page) await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, runtimeErrors: errors, project: await page.evaluate(() => window.planStudio?.getProject()).catch(() => null) }, null, 2)); throw error; }
finally { await browser?.close(); server.kill(); }
