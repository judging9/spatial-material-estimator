import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const storage = await mkdtemp(join(tmpdir(), 'studio-hydraulics-')), artifacts = resolve('artifacts/hydraulics'); await mkdir(artifacts, { recursive: true });
const python = existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python';
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '', browser, page; server.stderr.on('data', chunk => serverErrors += chunk); const reports = [], errors = [], pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
try {
  const url = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 20000); server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } }); });
  browser = await chromium.launch({ headless: true, executablePath: ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync), args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); await page.goto(url); await page.waitForFunction(() => window.planStudio?.getProject);
  const project = () => page.evaluate(() => window.planStudio.getProject()), frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const solution = () => page.evaluate(async () => { const module = await import('/studio/lib/hydraulics.js'); const p = window.planStudio.getProject(); return module.solveHydraulicNetwork(module.resolveHydraulicSources(p)); });
  const open = async () => { await page.locator('[data-action="municipal-hydraulics"]').first().click(); await page.locator('#hydraulic-editor').waitFor(); };
  const fill = async (kind, id, field, value) => { const input = page.locator(`[data-hyd-kind="${kind}"][data-hyd-id="${id}"][data-hyd-field="${field}"]`); if (await input.evaluate(element => element.tagName === 'SELECT')) await input.selectOption(value); else await input.fill(String(value)); };
  const ready = async () => { await page.waitForFunction(() => document.querySelector('#hydraulic-results h3')?.textContent === '计算已完成'); };
  const capture = async name => { await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('visible')); await page.screenshot({ path: join(artifacts, name) }); };
  await page.locator('#enter-municipal').click(); await page.waitForFunction(() => window.planStudio.getWorkspaceMode() === 'municipal');
  await page.locator('[data-action="quick-municipal"]').first().click(); await page.locator('#municipal-quick-kind').selectOption('pipeline');
  for (const [key, value] of Object.entries({ x: 5, y: 5, length: 1000, angle: 0, width: 30, height: 120, elevation: 0 })) await page.locator(`#municipal-quick-form [name="${key}"]`).fill(String(value));
  await page.locator('#municipal-quick-form [type="submit"]').click(); await frame(); await page.locator('#municipal-unitPrice').fill('0'); const pipe = (await project()).municipalElements[0];
  await open(); const defaults = await page.locator('[data-hyd-field="diameter"]').inputValue(); assert.equal(defaults, ''); assert.equal(await page.locator('[data-hyd-field="roughness"]').inputValue(), ''); assert.ok((await page.locator('#hydraulic-results').innerText()).includes('待填写参数'));
  pass('从真实1000m场地管线生成两个端点，水力内径、粗糙度与用水边界不伪造，空参数明确待填');
  const ids = await page.locator('[data-hyd-kind="node"][data-hyd-field="name"]').evaluateAll(inputs => inputs.map(input => input.dataset.hydId)), linkId = await page.locator('[data-hyd-kind="link"][data-hyd-field="name"]').getAttribute('data-hyd-id');
  await fill('node', ids[0], 'type', 'reservoir'); await fill('node', ids[0], 'head', 50); await fill('node', ids[1], 'demand', 10); await fill('link', linkId, 'diameter', 100); await fill('link', linkId, 'roughness', 120); await ready();
  const event = page.waitForEvent('download'); await page.locator('#hydraulic-export').click(); const download = await event; await download.saveAs(join(artifacts, 'pressure-network.csv')); const csv = await readFile(await download.path(), 'utf8'); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('22.0760186'));
  await capture('hydraulics-pressure-1440.png'); await page.locator('.hyd-node-results summary').click(); await page.locator('.hyd-node-results').scrollIntoViewIfNeeded(); await capture('hydraulics-pressure-results-1440.png'); await page.locator('#hydraulic-apply').click(); await frame(); const savedNetwork = (await project()).municipalHydraulics, pressureResult = await solution(); assert.equal(pressureResult.status, 'ready'); near(pressureResult.nodes.find(node => node.id === ids[1]).head, 27.92398137768413, 1e-7); near(pressureResult.links[0].flow, 10); assert.ok(pressureResult.maxContinuityError < 1e-6);
  pass('真实UI输入50m总水头、10L/s需求、DN100内径及C120，独立参照损失22.076018622m、末端27.923981378m及CSV均一致');
  await open(); await fill('node', ids[0], 'head', 60); await ready(); await page.locator('[data-dialog-close]').click(); assert.deepEqual((await project()).municipalHydraulics, savedNetwork);
  pass('未点击应用时改水头后关闭弹窗，原网络参数与结果完整保留');
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存到本机'); const saved = await project(); await page.reload(); await page.waitForFunction(() => window.planStudio?.getProject); await page.locator('#open-project').click(); await page.locator(`[data-open-project="${saved.id}"]`).click(); await page.waitForFunction(id => window.planStudio.getProject().id === id, saved.id); assert.deepEqual((await project()).municipalHydraulics, savedNetwork); near((await solution()).links[0].flow, 10);
  pass('水力连接、内径、边界及真实计算保存刷新重开后完整恢复');
  await page.locator(`#left-panel [data-action="select-municipal"][data-id="${pipe.id}"]`).click(); await page.locator('.municipal-nodes summary').click(); await page.locator('[data-municipal-point="1"][data-municipal-axis="z"]').fill('100'); await frame(); const stale = await solution(); assert.equal(stale.status, 'pending'); assert.ok(stale.messages.some(message => message.includes('端点已改变')));
  await open(); assert.ok((await page.locator('#hydraulic-results').innerText()).includes('端点已改变')); await page.locator('#hydraulic-rebuild').click(); await page.locator('[data-hyd-mode="gravity"]').click();
  pass('改场地管线端点高程后旧水力连接暂停输出，弹窗明确提示从当前场地重建');
  const gravityIds = await page.locator('[data-hyd-kind="node"][data-hyd-field="name"]').evaluateAll(inputs => inputs.map(input => input.dataset.hydId)), gravityLink = await page.locator('[data-hyd-kind="link"][data-hyd-field="name"]').getAttribute('data-hyd-id');
  await fill('node', gravityIds[0], 'type', 'junction'); await fill('node', gravityIds[0], 'demand', 48.350379266778055); await fill('node', gravityIds[1], 'type', 'outfall'); await fill('node', gravityIds[1], 'demand', 0); await fill('link', gravityLink, 'diameter', 300); await fill('link', gravityLink, 'roughness', .013); await fill('link', gravityLink, 'invertStart', 10.00000499999875); await fill('link', gravityLink, 'invertEnd', 0); await ready();
  // Source physical length is sqrt(1000²+1²), so the entered fall gives an exact 1% hydraulic slope.
  await page.setViewportSize({ width: 1100, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await capture('hydraulics-gravity-1100.png'); await page.locator('#hydraulic-results .hyd-results').first().scrollIntoViewIfNeeded(); await capture('hydraulics-gravity-results-1100.png'); await page.locator('#hydraulic-apply').click(); await frame(); const gravityResult = await solution(); assert.equal(gravityResult.status, 'ready'); near(gravityResult.links[0].slope, .01, 1e-12); near(gravityResult.links[0].normalDepth, .15, 1e-9); near(gravityResult.links[0].fullFlowCapacity, 96.70075853355611, 1e-8);
  pass('重力模式确认流量、内径和管底1%坡度，Manning得到0.15m正常水深及96.700758534L/s充满能力');
  await open(); await fill('node', gravityIds[0], 'demand', 120); await page.waitForFunction(() => document.querySelector('#hydraulic-results')?.textContent.includes('超过最大自由表面')); await page.locator('#hydraulic-apply').click(); const exceeded = await solution(); assert.equal(exceeded.links[0].capacityExceeded, true); assert.equal(exceeded.links[0].normalDepth, null);
  pass('实际汇入120L/s超过最大自由表面能力时明确超限，正常水深留空，不伪造满管结果');
  await open(); await fill('node', gravityIds[0], 'demand', 10); await fill('node', gravityIds[1], 'type', 'junction'); await fill('node', gravityIds[1], 'demand', 20); await fill('node', gravityIds[1], 'type', 'outfall');
  assert.equal(await page.locator(`[data-hyd-kind="node"][data-hyd-id="${gravityIds[1]}"][data-hyd-field="demand"]`).isVisible(), true); assert.equal(await page.locator(`[data-hyd-kind="node"][data-hyd-id="${gravityIds[1]}"][data-hyd-field="demand"]`).inputValue(), '20'); await ready();
  // Numeric inputs debounce the result repaint by 80ms; wait for the last repaint before expanding.
  await page.waitForTimeout(150); await page.locator('.hyd-node-results summary').click(); await page.locator('.hyd-node-results .hyd-results').waitFor({ state: 'visible' }); await page.locator('.hyd-node-results').scrollIntoViewIfNeeded(); assert.equal(await page.locator('.hyd-node-results').evaluate(element => element.open), true); const outletTable = await page.locator('.hyd-node-results tbody').innerText(); assert.ok(outletTable.includes('20') && outletTable.includes('30')); await capture('hydraulics-outfall-local-flow-1100.png'); await page.locator('#hydraulic-apply').click(); const localOutlet = await solution(); near(localOutlet.links[0].flow, 10); near(localOutlet.nodes.find(node => node.id === gravityIds[1]).supply, 30);
  pass('汇流节点本地20L/s改为排水出口后输入仍清晰可见，上游10与本地20合计30L/s明确列出');
  assert.deepEqual(errors, []); pass('1440/1100水力编辑、结果、源重建与应用/取消无横向页面溢出或浏览器异常');
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ checks: reports.length, reports, runtimeErrors: errors, pressureResult, gravityResult, exceeded, localOutlet }, null, 2)); process.stdout.write(`\n${reports.length} 项水力浏览器验收通过。\n`);
} catch (error) { await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); if (page) await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({ error: String(error), reports, runtimeErrors: errors, project: await page.evaluate(() => window.planStudio?.getProject()).catch(() => null) }, null, 2)); throw error; }
finally { await browser?.close(); server.kill(); }
