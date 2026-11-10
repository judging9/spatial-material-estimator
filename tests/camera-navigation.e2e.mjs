import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Use the actual built software, ordinary controls and physical keyboard
// events. Inspection hooks only read data; this suite never rebuilds or changes
// served modules, and its projects live in isolated temporary storage.
const artifacts = resolve(process.env.STUDIO_E2E_ARTIFACTS || 'artifacts/camera-navigation');
await mkdir(artifacts, { recursive: true });
const storage = await mkdtemp(join(tmpdir(), 'studio-camera-navigation-'));
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: storage, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '', browser, page, room, outcome = 'failed', browserClosed = false, serverStopped = false;
server.stderr.on('data', chunk => stderr += chunk);
const reports = [], runtimeErrors = [], evidence = {}, limitations = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const delta = (after, before) => ({ x: after.x - before.x, y: after.y - before.y, z: after.z - before.z });
const length = vector => Math.hypot(vector.x, vector.y, vector.z);
const frame = current => current.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const stats = current => current.evaluate(() => window.planStudio.get3DStats());
const data = current => current.evaluate(() => ({ project: window.planStudio.getProject(), quote: window.planStudio.getQuote(), budget: window.planStudio.getProjectBudget(), status: document.querySelector('#save-status').textContent }));
const cameraNear = (actual, expected) => { for (const field of ['distance','yaw','pitch']) near(actual[field], expected[field]); for (const axis of ['x','y','z']) { near(actual.target[axis], expected.target[axis]); near(actual.eye[axis], expected.eye[axis]); } };
const unchanged = async (current, before) => { const after = await data(current); assert.deepEqual(after.project, before.project); assert.deepEqual(after.quote, before.quote); assert.deepEqual(after.budget, before.budget); assert.equal(after.status, before.status); };

const fixture = {
  version: 1, id: 'navigation-site', name: '三维视角移动验收', workspaceMode: 'municipal',
  drawing: { id: 'navigation-plan', type: 'plan', name: '真实米制场地', width: 30000, height: 22000, url: 'data:image/png;base64,iVBORw0KGgo=' },
  calibration: { metersPerPixel: .01 }, regions: [], walls: [], additionalCost: '100', taxRate: '9',
  budget: { included: { decoration: false, civil: false, municipal: true } }, view: { labels: true, drawingOpacity: 1 },
  municipalElements: [
    { id: 'navigation-road', kind: 'road', name: '已报价道路', points: [{ x: 10000, y: 10000 }, { x: 20000, y: 10000 }], holes: [], width: 600, depth: 100, height: 5, elevation: 0, quantity: '1', unit: 'm²', unitPrice: '50', wasteRate: '5', laborRate: '12', additionalCost: '25', hidden: false, locked: false },
    { id: 'navigation-bench', kind: 'facility', catalogId: 'street-bench', rotation: 15, name: '已报价长椅', points: [{ x: 14000, y: 12000 }], holes: [], width: 180, depth: 65, height: 85, elevation: 0, quantity: '1', unit: '件', unitPrice: '1200', wasteRate: '0', laborRate: '80', additionalCost: '0', hidden: false, locked: false },
  ],
};
await writeFile(join(artifacts, 'input-project.json'), JSON.stringify(fixture, null, 2));

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
  page = await context.newPage(); page.on('pageerror', error => runtimeErrors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getProjectBudget);
  await page.locator('#open-project').click(); const chooserEvent = page.waitForEvent('filechooser'); await page.locator('#dialog [data-action="import-project"]').click();
  const chooser = await chooserEvent; await chooser.setFiles({ name: 'navigation-site.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => window.planStudio.getProject().id === 'navigation-site');
  await page.locator('#dialog').waitFor({state:'hidden'});
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready && window.planStudio.getViewMode() === '3d');
  await page.locator('#navigation-speed').selectOption('2'); await page.locator('#navigation-toggle').click(); await frame(page);
  assert.equal((await stats(page)).navigation.active, true); assert.equal((await stats(page)).navigation.speed, 2);
  assert.equal(await page.locator('#viewer3d canvas').evaluate(node => document.activeElement === node), true);
  const original = await data(page); assert.equal(original.quote.pending, false);
  pass('真实米制场地及已填价格通过文件选择器导入，三维模型正常；开始移动聚焦画布，手动2m/s速度可用');

  const move = async (current, key, expected, duration = 180) => {
    const before = await stats(current), snapshot = await data(current);
    await current.keyboard.down(key); await current.waitForTimeout(duration); await current.keyboard.up(key); await frame(current);
    const after = await stats(current), travel = delta(after.camera.target, before.camera.target), eyeTravel = delta(after.camera.eye, before.camera.eye);
    assert.ok(length(travel) > .02, key + ' must move the actual camera');
    assert.ok(length(travel) < before.navigation.speed * .7, key + ' movement must remain bounded for a short hold');
    for (const axis of ['x','y','z']) near(eyeTravel[axis], travel[axis]);
    const heading = expected(before.camera.yaw), dot = travel.x * heading.x + travel.y * heading.y + travel.z * heading.z;
    near(dot / length(travel), 1, 1e-5);
    assert.equal(after.camera.distance, before.camera.distance); assert.equal(after.camera.yaw, before.camera.yaw); assert.equal(after.camera.pitch, before.camera.pitch);
    await unchanged(current, snapshot); assert.deepEqual(after.navigation.keys, []);
    return { before: before.camera, after: after.camera, travel, key };
  };
  const beforePixels = await page.locator('#viewer3d canvas').screenshot();
  evidence.forward = await move(page, 'w', yaw => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) }));
  const afterPixels = await page.locator('#viewer3d canvas').screenshot(); assert.ok(!beforePixels.equals(afterPixels), 'Keyboard movement must change actual WebGL pixels');
  await writeFile(join(artifacts, 'before-forward.png'), beforePixels); await writeFile(join(artifacts, 'after-forward.png'), afterPixels);
  evidence.back = await move(page, 's', yaw => ({ x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }));
  evidence.left = await move(page, 'a', yaw => ({ x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) }));
  evidence.right = await move(page, 'd', yaw => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) }));
  pass('WASD沿真实相机水平朝向前后左右移动，eye与target同位移，实际WebGL像素改变；视距、倾角、几何、预算与保存状态保持');

  const scrollBefore = await page.evaluate(() => scrollY);
  evidence.up = await move(page, 'Space', () => ({ x: 0, y: 1, z: 0 })); evidence.down = await move(page, 'Control', () => ({ x: 0, y: -1, z: 0 }));
  assert.equal(await page.evaluate(() => scrollY), scrollBefore);
  await unchanged(page, original);
  pass('Space上升、Ctrl下降使用真实米制竖直位移，空格不滚动页面，不改项目和报价');

  await page.locator('#left-panel [data-action="select-municipal"][data-id="navigation-bench"]').click();
  const cameraBeforeInput = (await stats(page)).camera; const nameInput = page.locator('#municipal-name'); await nameInput.click(); await nameInput.press('End'); await nameInput.press('w'); await frame(page);
  assert.equal((await page.evaluate(() => window.planStudio.getProject())).municipalElements.find(item => item.id === 'navigation-bench').name, '已报价长椅w');
  cameraNear((await stats(page)).camera, cameraBeforeInput); assert.equal(await page.evaluate(() => window.planStudio.getViewMode()), '3d');
  await nameInput.fill('已报价长椅'); await nameInput.press('Tab');
  await page.locator('#municipal-height').fill('100'); await page.locator('#municipal-height').press('Tab'); await frame(page);
  assert.equal((await page.evaluate(() => window.planStudio.getProject())).municipalElements.find(item => item.id === 'navigation-bench').height, 100);
  await page.locator('#navigation-toggle').click(); await page.keyboard.press('Control+z'); await frame(page);
  assert.equal((await page.evaluate(() => window.planStudio.getProject())).municipalElements.find(item => item.id === 'navigation-bench').height, 85);
  await page.keyboard.press('Control+Shift+z'); await frame(page);
  assert.equal((await page.evaluate(() => window.planStudio.getProject())).municipalElements.find(item => item.id === 'navigation-bench').height, 100);
  await page.keyboard.press('Control+z'); await frame(page);
  await page.keyboard.press('Control+s'); await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存到本机');
  assert.deepEqual((await data(page)).project.municipalElements, original.project.municipalElements); assert.deepEqual((await data(page)).quote, original.quote);
  pass('属性输入W正常输入且不移动、不切换画墙；画布焦点下Ctrl+Z/Shift+Z撤销重做和Ctrl+S保存仍正常，操作可恢复原几何与报价');

  await page.locator('#navigation-toggle').click(); await page.keyboard.down('d'); await page.waitForTimeout(80); await page.locator('#project-name').click(); await frame(page);
  const afterInputBlur = (await stats(page)).camera; await page.waitForTimeout(200); cameraNear((await stats(page)).camera, afterInputBlur); assert.deepEqual((await stats(page)).navigation.keys, []); await page.keyboard.up('d');
  await page.locator('#navigation-toggle').click(); await page.keyboard.down('w'); await page.waitForTimeout(80); await page.locator('#settings').click(); await page.locator('#dialog').waitFor(); await frame(page);
  const insideDialog = (await stats(page)).camera; await page.waitForTimeout(200); cameraNear((await stats(page)).camera, insideDialog); assert.deepEqual((await stats(page)).navigation.keys, []); await page.keyboard.up('w');
  await page.locator('#dialog [data-dialog-close]').click();
  await page.locator('#navigation-toggle').click(); await page.keyboard.down('Space'); await page.waitForTimeout(80); await page.locator('[data-view="2d"]').click(); await frame(page);
  const after2D = (await stats(page)).camera; await page.waitForTimeout(200); cameraNear((await stats(page)).camera, after2D); assert.deepEqual((await stats(page)).navigation.keys, []); await page.keyboard.up('Space');
  assert.equal(await page.evaluate(() => window.planStudio.getViewMode()), '2d');
  await page.locator('[data-view="3d"]').click(); await page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  await page.locator('#navigation-toggle').click(); await page.keyboard.down('a'); await page.waitForTimeout(80); await page.keyboard.press('Escape'); await frame(page);
  const afterEscape = (await stats(page)).camera; await page.waitForTimeout(200); cameraNear((await stats(page)).camera, afterEscape); assert.deepEqual((await stats(page)).navigation.keys, []); assert.equal((await stats(page)).navigation.focused, false); await page.keyboard.up('a');
  pass('输入框失焦、打开真实设置弹窗、切回二维和Esc释放均立即停止已按住的移动键，后续没有按键残留或视角漂移');

  // Some headless Chromium builds emulate every page as focused, even after
  // activating another real tab. Disable that CDP emulation when supported;
  // do not synthesize blur/visibility events or change application state.
  const focusEmulation = {};
  const disableFocusEmulation = async (current, label) => {
    const session = await context.newCDPSession(current);
    try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); focusEmulation[label] = 'disabled'; }
    catch (error) { focusEmulation[label] = String(error); }
    return session;
  };
  const pageFocusSession = await disableFocusEmulation(page, 'project');
  await page.locator('#navigation-toggle').click(); await page.keyboard.down('w'); await page.waitForTimeout(80);
  const away = await context.newPage(); await away.goto('about:blank');
  const awayFocusSession = await disableFocusEmulation(away, 'otherTab');
  const awayTarget = await awayFocusSession.send('Target.getTargetInfo');
  await awayFocusSession.send('Target.activateTarget', { targetId: awayTarget.targetInfo.targetId }); await away.bringToFront();
  const backgroundObserved = await page.waitForFunction(() => document.hidden || !document.hasFocus(), null, { timeout: 1800 }).then(() => true, () => false);
  evidence.windowFocus = { focusEmulation, backgroundObserved,
    observation: await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), navigation: window.planStudio.get3DStats().navigation })) };
  if (backgroundObserved) {
    await page.waitForFunction(() => window.planStudio.get3DStats().navigation.keys.length === 0);
    const afterWindowBlur = (await stats(page)).camera; await page.waitForTimeout(200); cameraNear((await stats(page)).camera, afterWindowBlur);
    pass('真实新标签页切换产生窗口失焦或页面隐藏，按住的W立即释放，视角停止；返回后不复用原来的按键');
  } else {
    const note = '当前headless浏览器在激活其他真实标签页后仍将工程页视为可见且聚焦，窗口失焦停止仅由camera-navigation.test.mjs控制器测试覆盖，本次浏览器未验证该子项。';
    limitations.push(note); process.stdout.write(`△ ${note}\n`);
  }
  await page.keyboard.up('w'); await frame(page); await away.close(); await page.bringToFront();
  await pageFocusSession.detach(); await page.locator('#navigation-toggle').click();
  assert.equal((await stats(page)).navigation.active, true); assert.deepEqual((await stats(page)).navigation.keys, []);

  await page.locator('#navigation-speed').selectOption('auto'); await page.locator('#navigation-toggle').click(); await frame(page);
  const autoBefore = (await stats(page)).navigation.speed;
  await page.locator('#inspector [data-action="focus-municipal"]').click(); await frame(page);
  const closeSpeed = (await stats(page)).navigation.speed; assert.ok(closeSpeed < autoBefore); assert.ok(closeSpeed >= .5);
  await page.locator('#fit').click(); await frame(page); assert.ok((await stats(page)).navigation.speed >= closeSpeed);
  evidence.autoSpeed = { overview: autoBefore, close: closeSpeed };
  pass('自动速度按实际场地与视角尺度调整，定位长椅近景时降速，适配全景后恢复；速度选择和定位不改预算');

  const overlap = (a, b) => a && b && Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x) > 1 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y) > 1;
  evidence.layouts = [];
  for(const width of [1440,1100,900]){
    await page.setViewportSize({width,height:1000}); await page.locator('#fit').click(); await frame(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const stage = await page.locator('#stage').boundingBox(), panel = await page.locator('.scene-navigation').boundingBox();
    assert.ok(panel.x >= stage.x && panel.x+panel.width <= stage.x+stage.width+1 && panel.y >= stage.y && panel.y+panel.height <= stage.y+stage.height+1);
    for(const selector of ['#navigation-toggle','#navigation-speed']){const bounds=await page.locator(selector).boundingBox();assert.ok(bounds.x >= panel.x && bounds.x+bounds.width <= panel.x+panel.width+1);}
    const controls={}; for(const selector of ['#three-tools','#view-switch','.canvas-bottom']){const bounds=await page.locator(selector).boundingBox();controls[selector]=bounds;assert.equal(overlap(panel,bounds),false,selector+' overlaps navigation');}
    for(const id of ['save','export','settings']){const bounds=await page.locator('#'+id).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);}
    const current=await stats(page);assert.equal(current.error,null);assert.equal(current.glError,0);
    evidence.layouts.push({width,panel,controls}); await page.screenshot({path:join(artifacts,`navigation-${width}.png`)});
  }
  pass('1440/1100/900窗口中导航、速度、缩放与顶部工具互不遮挡、无横向溢出；真实WebGL状态正常');

  const roomContext = await browser.newContext({ viewport:{width:1440,height:1000} }); room = await roomContext.newPage();
  room.on('pageerror', error=>runtimeErrors.push(error.message));room.on('dialog',dialog=>dialog.accept());
  await room.goto(baseURL);await room.waitForFunction(()=>window.planStudio);await room.locator('#draw-plan').click();
  await room.waitForFunction(()=>window.planStudio.getProject().drawing?.type==='plan');await room.locator('#wall-done').click();await room.locator('#inspector [data-action="room-template"]').click();
  await room.locator('#room-name').fill('键盘导航房间');await room.locator('#room-width').fill('4');await room.locator('#room-depth').fill('3');await room.locator('#room-template-form button').click();
  await room.locator('#save').click();await room.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');
  await room.locator('[data-view="3d"]').click();await room.waitForFunction(()=>window.planStudio.get3DStats()?.ready&&window.planStudio.getViewMode()==='3d');
  await room.locator('#navigation-speed').selectOption('2');await room.locator('#navigation-toggle').click();await frame(room);
  evidence.room=await move(room,'w',yaw=>({x:-Math.sin(yaw),y:0,z:-Math.cos(yaw)}));
  assert.equal(await room.evaluate(()=>window.planStudio.getViewMode()),'3d');
  near((await data(room)).quote.regions[0].netArea,12);
  await room.screenshot({path:join(artifacts,'room-navigation-1440.png')});
  pass('在独立空工程中通过真实4×3m房间模板建立12m²房间，W在三维中移动视角并保持墙体、材料面积和预算，不触发画墙快捷键');

  assert.deepEqual(runtimeErrors,[]);outcome='passed';
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({outcome,checks:reports.length,reports,runtimeErrors,limitations,evidence,finalProject:(await data(page)).project},null,2));
  process.stdout.write(`\n${reports.length} 项三维导航浏览器验收通过。\n`);
}catch(error){
  await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});
  await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({outcome,error:String(error),reports,runtimeErrors,limitations,evidence,state:await page?.evaluate(()=>({project:window.planStudio?.getProject(),quote:window.planStudio?.getQuote(),stats:window.planStudio?.get3DStats(),focus:document.activeElement?.id,toast:document.querySelector('#toast')?.textContent})).catch(()=>({}))},null,2));throw error;
}finally{
  if(browser){await browser.close();browserClosed=true;}
  if(server.exitCode===null&&server.signalCode===null){server.kill();await new Promise(done=>{if(server.exitCode!==null||server.signalCode!==null)done();else server.once('exit',done);});}
  serverStopped=server.exitCode!==null||server.signalCode!==null;
  await writeFile(join(artifacts,'run-receipt.json'),JSON.stringify({outcome,browserClosed,isolatedServerStopped:serverStopped,isolatedStorage:storage,checks:reports.length,runtimeErrors,limitations,stderr},null,2));
}
