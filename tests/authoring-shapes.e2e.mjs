import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Actual app controls create every new fixture. The one legacy JSON below was
// exported through the preceding app's UI, including its raster plan image.
// planStudio is read only; it is never used to replace project state.
const testRoot = await mkdtemp(join(tmpdir(), 'studio-authoring-'));
const artifacts = resolve('artifacts/authoring'); await mkdir(artifacts, { recursive: true });
const python = process.env.PYTHON || (existsSync('D:/python/python.exe') ? 'D:/python/python.exe' : 'python');
const server = spawn(python, ['-u', 'tests/studio_test_server.py'], { env: { ...process.env, STUDIO_TEST_ROOT: testRoot, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '', browser, currentPage;
server.stderr.on('data', chunk => serverErrors += chunk);
const reports = [], errors = [];
const pass = message => { reports.push(message); process.stdout.write(`✓ ${message}\n`); };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(actual) - expected) < tolerance, `${actual} != ${expected} ± ${tolerance}`);
const geometry = project => ({ walls: project.walls, regions: project.regions, wallShapes: project.wallShapes, planBoundary: project.planBoundary, wallJoinStyle: project.wallJoinStyle, openings: project.openings, furniture: project.furniture, planError: project.planError });

try {
  const baseURL = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Test server timeout')), 20000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
  });
  const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const open = async (draw = true) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(); currentPage = page;
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(baseURL); await page.waitForFunction(() => window.planStudio?.getWallFootprints);
    if (draw) { await page.locator('#draw-plan').click(); await page.waitForFunction(() => window.planStudio.getProject().drawing?.type === 'plan'); }
    return { page, context };
  };
  const project = page => page.evaluate(() => window.planStudio.getProject());
  const quote = page => page.evaluate(() => window.planStudio.getQuote());
  const footprints = page => page.evaluate(() => window.planStudio.getWallFootprints());
  const frame = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const pointScreen = async (page, point) => {
    const location = await page.evaluate(point => window.planStudio.toScreen(point), point), box = await page.locator('#drawing-canvas').boundingBox();
    assert.ok(box); return { x: box.x + location.x, y: box.y + location.y };
  };
  const click = async (page, point) => { const location = await pointScreen(page, point); await page.mouse.click(location.x, location.y); };
  const wallChain = async (page, points) => { await page.locator('[data-tool="wall"]').click(); for (const point of points) await click(page, point); await page.locator('#wall-done').click(); await page.locator('[data-tool="select"]').click(); };
  const selectWall = async (page, id) => {
    const disclosure = page.locator('.walls-section details');
    if (await disclosure.count() && await disclosure.evaluate(element => !element.open)) await disclosure.locator('summary').click();
    await page.locator(`#left-panel [data-action="select-wall"][data-id="${id}"]`).click();
  };
  const selectShape = async (page, id) => {
    const disclosure = page.locator('.walls-section details');
    if (await disclosure.count() && await disclosure.evaluate(element => !element.open)) await disclosure.locator('summary').click();
    await page.locator(`#left-panel [data-action="select-wall-shape"][data-id="${id}"]`).click();
  };
  const boundary = async (page, values) => {
    await page.locator('[data-action="plan-boundary"]').first().click();
    for (const [name, value] of Object.entries(values)) await page.locator(`#plan-boundary-form [name="${name}"]`).fill(String(value));
    await page.locator('#plan-boundary-form [type="submit"], [form="plan-boundary-form"][type="submit"]').click();
  };
  const insideBox = (pieces, box) => {
    assert.ok(pieces.length);
    for (const piece of pieces) for (const point of piece.points) assert.ok(point.x >= box.minX - 1e-6 && point.x <= box.maxX + 1e-6 && point.y >= box.minY - 1e-6 && point.y <= box.maxY + 1e-6, `Actual joined wall ${piece.wallId} leaves boundary at ${JSON.stringify(point)}`);
  };
  const curveQuality = (source, shape) => {
    assert.ok(shape.wallIds.length > 3 && shape.wallIds.length <= 200);
    assert.ok(shape.maxDeviation <= .5 + 1e-8, 'Disclosed chord deviation is at most 0.5cm');
    for (const id of shape.wallIds) {
      const wall = source.walls.find(wall => wall.id === id); assert.ok(wall);
      near(Math.hypot(wall.start.x - shape.center.x, wall.start.y - shape.center.y), shape.radius, 1e-5);
      near(Math.hypot(wall.end.x - shape.center.x, wall.end.y - shape.center.y), shape.radius, 1e-5);
      const chord = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
      const deviation = shape.radius - Math.sqrt(Math.max(0, shape.radius ** 2 - chord ** 2 / 4));
      assert.ok(deviation <= shape.maxDeviation + 1e-6, 'Actual curve chords obey their disclosed sampling error');
    }
  };

  const layout=await open();
  for(const viewportWidth of[1440,1100]){
    await layout.page.setViewportSize({width:viewportWidth,height:1000});
    for(const kind of['circle','arc','boundary']){
      await layout.page.locator(`[data-tool="${kind}"]`).click();
      assert.equal(await layout.page.locator('#plan-controls').isVisible(),false);
      if(kind==='circle')await click(layout.page,{x:600,y:500});
      else if(kind==='arc')for(const point of[{x:400,y:500},{x:600,y:300}])await click(layout.page,point);
      else for(const point of[{x:400,y:300},{x:800,y:300}])await click(layout.page,point);
      const pointer=await pointScreen(layout.page,{x:800,y:500});await layout.page.mouse.move(pointer.x,pointer.y);await frame(layout.page);
      assert.equal(await layout.page.locator('#drawing-shape-status').isVisible(),true);
      assert.ok((await layout.page.locator('#drawing-shape-hint').innerText()).trim());
      const toolbar=await layout.page.locator('#canvas-tools').boundingBox(),stage=await layout.page.locator('#stage').boundingBox();
      assert.ok(toolbar.x>=stage.x-1&&toolbar.x+toolbar.width<=stage.x+stage.width+1,'Toolbar must fit the actual drawing stage');
      assert.equal(await layout.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await layout.page.screenshot({path:join(artifacts,`${kind}-drawing-${viewportWidth}.png`)});
      await layout.page.keyboard.press('Escape');await frame(layout.page);
      assert.equal(await layout.page.locator('#drawing-shape-status').isVisible(),false);
      assert.equal(await layout.page.locator('#plan-controls').isVisible(),true);
      assert.equal((await project(layout.page)).walls.length,0);
    }
  }
  pass('1440/1100圆、弧与边界绘制中工具条在画布内，提示条与画墙栏互斥，Esc恢复原工具且零残留');

  const t = await open();
  assert.equal((await project(t.page)).wallJoinStyle, 'clean');
  await wallChain(t.page, [{ x: 300, y: 400 }, { x: 700, y: 400 }]);
  await wallChain(t.page, [{ x: 400, y: 600 }, { x: 600, y: 400 }]);
  const tSource = await project(t.page), branch = tSource.walls[1];
  const branchPoints = (await footprints(t.page)).filter(piece => piece.wallId === branch.id).flatMap(piece => piece.points);
  assert.ok(branchPoints.length); assert.ok(branchPoints.every(point => point.y >= 390 - 1e-6));
  await t.page.locator('#fit').click(); await frame(t.page);
  const samples = await t.page.evaluate(() => {
    const canvas = document.querySelector('#drawing-canvas'), context = canvas.getContext('2d');
    const pixel = point => { const screen = window.planStudio.toScreen(point); return [...context.getImageData(Math.round(screen.x), Math.round(screen.y), 1, 1).data]; };
    return { oldSpike: pixel({ x: 600, y: 388 }), solid: pixel({ x: 660, y: 400 }), background: pixel({ x: 680, y: 388 }) };
  });
  const colourDistance = (a, b) => Math.hypot(...a.slice(0, 3).map((channel, index) => channel - b[index]));
  assert.ok(colourDistance(samples.oldSpike, samples.background) + 15 < colourDistance(samples.oldSpike, samples.solid), 'The old T-cap spike is actual background in the 2D canvas');
  await t.page.screenshot({ path: join(artifacts, 'clean-diagonal-t-2d.png') });
  await selectWall(t.page, branch.id); await t.page.locator('[data-view="3d"]').click();
  await t.page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  const tStats = await t.page.evaluate(() => window.planStudio.get3DStats());
  assert.ok(tStats.selectedWallFaces.flatMap(face => [face.points, ...face.holes]).flat().every(point => point.z >= 3.9 - 1e-8));
  near(tStats.selectedWallArea, (await quote(t.page)).walls.find(wall => wall.id === branch.id).netArea);
  assert.equal(tStats.glError, 0); await t.page.screenshot({ path: join(artifacts, 'clean-diagonal-t-3d.png') });
  pass('真实45°T接墙无4.142cm端帽突起，二维像素、实际足迹与三维报价面一致');

  const legacy = await open(false);
  const legacyPath = resolve('tests/fixtures/authoring-legacy-t.json'), legacyFile = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(legacyFile.wallJoinStyle, undefined);
  await legacy.page.locator('#open-project').click(); await legacy.page.locator('[data-action="import-project"]').click();
  await legacy.page.locator('#project-file').setInputFiles(legacyPath);
  await legacy.page.waitForFunction(id => window.planStudio.getProject().id === id, legacyFile.id);
  const oldSource = await project(legacy.page), beforeClean = await footprints(legacy.page);
  assert.ok(beforeClean.flatMap(piece => piece.points).some(point => point.y < 390 - 1e-5));
  await legacy.page.locator('[data-action="clean-walls"]').first().click();
  await legacy.page.waitForFunction(() => window.planStudio.getProject().wallJoinStyle === 'clean');
  const cleaned = await project(legacy.page);
  assert.equal(cleaned.id, oldSource.id);
  assert.deepEqual(cleaned.walls.map(({id,start,end,thickness,height})=>({id,start,end,thickness,height})), oldSource.walls.map(({id,start,end,thickness,height})=>({id,start,end,thickness,height})));
  assert.ok((await footprints(legacy.page)).flatMap(piece => piece.points).every(point => point.y >= 390 - 1e-6));
  await legacy.page.locator('#undo').click(); assert.notEqual((await project(legacy.page)).wallJoinStyle, 'clean');
  await legacy.page.locator('#redo').click(); assert.equal((await project(legacy.page)).wallJoinStyle, 'clean');
  pass('真实旧格式JSON保留原square几何，用户整理后去突起，中心线与项目身份保持且可撤销');

  const l = await open();
  await wallChain(l.page, [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 200, y: 500 }, { x: 200, y: 200 }]);
  near((await quote(l.page)).regions[0].netArea, 4.86);
  await l.page.locator('#fit').click(); await l.page.screenshot({ path: join(artifacts, 'clean-angled-closed-room-2d.png') });
  await l.page.locator('[data-view="3d"]').click(); await l.page.waitForFunction(() => window.planStudio.get3DStats()?.ready);
  assert.equal(await l.page.evaluate(() => window.planStudio.get3DStats().roomCount), 1);
  assert.equal(await l.page.evaluate(() => window.planStudio.get3DStats().glError), 0);
  await l.page.screenshot({ path: join(artifacts, 'clean-angled-closed-room-3d.png') });
  pass('清理后的斜L连接仍能闭合真实3-4-5房间，20cm墙厚净面积4.86m²');

  const bounded = await open();
  await boundary(bounded.page, { x: 2, y: 2, width: 8, depth: 6 });
  const rectangularBoundary = (await project(bounded.page)).planBoundary;
  assert.ok(rectangularBoundary?.points.length === 4);
  await bounded.page.locator('[data-tool="wall"]').click();
  await click(bounded.page, { x: 300, y: 300 }); await click(bounded.page, { x: 700, y: 300 });
  const legal = await project(bounded.page);
  await click(bounded.page, { x: 1100, y: 300 });
  assert.deepEqual(geometry(await project(bounded.page)), geometry(legal));
  await click(bounded.page, { x: 700, y: 600 });
  const resumed = await project(bounded.page);
  assert.equal(resumed.walls.length, 2);
  assert.deepEqual(resumed.walls[1].start, { x: 700, y: 300 });
  assert.deepEqual(resumed.walls[1].end, { x: 700, y: 600 });
  await bounded.page.locator('#wall-done').click(); await bounded.page.locator('[data-tool="select"]').click();
  insideBox(await footprints(bounded.page), { minX: 200, maxX: 1000, minY: 200, maxY: 800 });
  await boundary(bounded.page, { x: 3, y: 3, width: 1, depth: 1 });
  assert.deepEqual(geometry(await project(bounded.page)), geometry(resumed));
  await bounded.page.keyboard.press('Escape');
  await selectWall(bounded.page, resumed.walls[0].id);
  await bounded.page.locator('#wall-edit-length').fill('10');
  await bounded.page.locator('#wall-edit-form [type="submit"]').click();
  assert.deepEqual(geometry(await project(bounded.page)), geometry(resumed));
  await bounded.page.locator('#fit').click(); await bounded.page.screenshot({ path: join(artifacts, 'boundary-atomic-rejection.png') });
  pass('用户8×6m边界拒绝越界墙、缩小边界和尺寸编辑，无半成品残留，拒绝后墙链从原点继续');
  await bounded.page.locator('[data-action="plan-boundary"]').first().click(); await bounded.page.locator('[data-boundary-clear]').click();
  assert.equal((await project(bounded.page)).planBoundary,null); assert.deepEqual((await project(bounded.page)).walls,resumed.walls);
  await bounded.page.locator('#undo').click(); assert.deepEqual((await project(bounded.page)).planBoundary,rectangularBoundary);
  pass('清除边界保留原墙体，用户可一次撤销恢复原范围');

  const concave = await open();
  const uBoundary = [{x:200,y:200},{x:1000,y:200},{x:1000,y:800},{x:600,y:800},{x:600,y:400},{x:400,y:400},{x:400,y:800},{x:200,y:800}];
  await concave.page.locator('[data-tool="boundary"]').click();
  for (const point of uBoundary) await click(concave.page, point); await concave.page.keyboard.press('Enter');
  assert.deepEqual((await project(concave.page)).planBoundary.points, uBoundary);
  await concave.page.locator('[data-tool="wall"]').click();
  await click(concave.page,{x:300,y:600}); await click(concave.page,{x:700,y:600});
  assert.equal((await project(concave.page)).walls.length, 0);
  await click(concave.page,{x:300,y:700}); assert.equal((await project(concave.page)).walls.length, 1);
  await concave.page.locator('#wall-done').click(); await concave.page.locator('#fit').click();
  await concave.page.screenshot({ path: join(artifacts, 'concave-boundary-rejection.png') });
  pass('实际绘制凹边界，两端都在范围内但穿过缺口的墙仍拒绝，保留合法起点');

  const rectangle=await open();await boundary(rectangle.page,{x:2,y:2,width:8,depth:6});
  const dragRectangle=async(start,end)=>{await rectangle.page.locator('[data-tool="rectangle"]').click();const a=await pointScreen(rectangle.page,start),b=await pointScreen(rectangle.page,end);await rectangle.page.mouse.move(a.x,a.y);await rectangle.page.mouse.down();await rectangle.page.mouse.move(b.x,b.y,{steps:8});await rectangle.page.mouse.up();};
  await dragRectangle({x:200,y:300},{x:500,y:500});
  assert.equal((await project(rectangle.page)).walls.length,0);assert.equal((await project(rectangle.page)).regions.length,0);
  await rectangle.page.screenshot({path:join(artifacts,'boundary-rectangle-rejection.png')});
  await dragRectangle({x:300,y:300},{x:500,y:500});
  assert.equal((await project(rectangle.page)).walls.length,4);near((await quote(rectangle.page)).regions[0].netArea,3.24);
  pass('矩形中心线在边界内但墙厚越界时整组拒绝且无页面异常，后续合法矩形仍得到3.24m²');

  const circle = await open();
  await boundary(circle.page, { x: 2, y: 2, width: 8, depth: 6 });
  await circle.page.locator('[data-tool="circle"]').click();
  await click(circle.page,{x:600,y:500}); await click(circle.page,{x:900,y:500});
  assert.equal((await project(circle.page)).walls.length, 0);
  assert.equal((await project(circle.page)).wallShapes?.length ?? 0, 0);
  assert.equal((await project(circle.page)).regions.length, 0);
  await circle.page.keyboard.press('Escape'); await circle.page.locator('[data-tool="circle"]').click();
  await click(circle.page,{x:600,y:500}); await click(circle.page,{x:800,y:500});
  await circle.page.waitForFunction(() => window.planStudio.getProject().wallShapes?.length === 1);
  const circular = await project(circle.page), circleShape = circular.wallShapes[0];
  assert.equal(circleShape.kind, 'circle'); near(circleShape.radius, 200); assert.equal(circular.regions.length,1);
  curveQuality(circular,circleShape);
  insideBox(await footprints(circle.page),{minX:200,maxX:1000,minY:200,maxY:800});
  near((await quote(circle.page)).regions[0].netArea, Math.PI * 1.9 ** 2, .04);
  await circle.page.locator('#fit').click(); await circle.page.screenshot({path:join(artifacts,'circle-room-2d.png')});
  pass('两击生成真实圆墙和房间，R2m/厚20cm净面积接近π×1.9²；曲线墙厚越界整组拒绝且弦误差≤0.5cm');
  await frame(circle.page);
  const seamSamples = await circle.page.evaluate(() => {
    const source = window.planStudio.getProject(), shape = source.wallShapes[0];
    const canvas = document.querySelector('#drawing-canvas'), context = canvas.getContext('2d');
    const pixel = point => { const screen = window.planStudio.toScreen(point); return [...context.getImageData(Math.round(screen.x), Math.round(screen.y), 1, 1).data]; };
    const sampleIndices = [12, 27, 42, 54, 63];
    return sampleIndices.map(index => {
      const wall = source.walls.find(wall => wall.id === shape.wallIds[index]);
      return { seam: pixel(wall.start), solid: pixel({ x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 }) };
    });
  });
  for (const sample of seamSamples) {
    assert.ok(colourDistance(sample.solid, [165, 177, 162]) <= 2, `Curve interior must have actual wall colour: ${JSON.stringify(sample)}`);
    assert.ok(colourDistance(sample.seam, sample.solid) <= 2, `Joined curve edges must not expose antialiasing cracks: ${JSON.stringify(sample)}`);
    assert.equal(sample.seam[3], 255);
  }
  pass('实际圆墙五处相邻墙段共边像素与实体色一致，合并填充消除抗锯齿白缝');

  await selectShape(circle.page,circleShape.id);
  await circle.page.locator('#inspector [data-action="add-item"]').click(); await circle.page.locator('[data-pick-material="demo-wood"]').click();
  for (const [field,value] of [['unitPrice','10'],['wasteRate','0'],['laborRate','0'],['additionalCost','100']]) await circle.page.locator(`[data-item-field="${field}"]`).fill(value);
  let circleQuote=await quote(circle.page), groupQuote=circleQuote.walls.find(wall=>wall.id===circleShape.id);
  assert.ok(groupQuote); assert.equal(groupQuote.items.length,1); assert.equal(groupQuote.itemAdditionalCost,'100.00');
  assert.equal(circleQuote.walls.filter(wall=>wall.items.length).length,1);
  near(Number(groupQuote.total), Number(groupQuote.materialCost)+100,.001);
  await circle.page.locator('#shape-edit-form [name="height"]').fill('3'); await circle.page.locator('#shape-edit-form [type="submit"]').click();
  const higherQuote=await quote(circle.page);
  near(higherQuote.regions[0].netArea,circleQuote.regions[0].netArea);
  near(higherQuote.walls.find(wall=>wall.id===circleShape.id).netArea,groupQuote.netArea*3/2.8,.0001);
  const beforeInvalidShape=await project(circle.page);
  await circle.page.locator('#shape-edit-form [name="radius"]').fill('6'); await circle.page.locator('#shape-edit-form [type="submit"]').click();
  assert.deepEqual(geometry(await project(circle.page)),geometry(beforeInvalidShape));
  await circle.page.locator('#shape-edit-form [name="radius"]').fill('2.5'); await circle.page.locator('#shape-edit-form [type="submit"]').click();
  const edited=await project(circle.page), editedShape=edited.wallShapes[0];
  near(editedShape.radius,250); curveQuality(edited,editedShape);
  near((await quote(circle.page)).regions[0].netArea,Math.PI*2.4**2,.06);
  assert.equal((await quote(circle.page)).walls.find(wall=>wall.id===circleShape.id).itemAdditionalCost,'100.00');
  pass('圆墙作为一组计材，100元固定费只加一次；改高不改地面，半径更新真实面积，越界改形整组回滚');

  const circularRegion=edited.regions[0];
  await circle.page.locator(`[data-action="select-region"][data-id="${circularRegion.id}"]`).click();
  await circle.page.locator('#inspector [data-action="add-item"]').click(); await circle.page.locator('[data-pick-material="demo-tile"]').click();
  for(const[field,value]of[['unitPrice','100'],['wasteRate','10'],['laborRate','20']])await circle.page.locator(`[data-item-field="${field}"]`).fill(value);
  circleQuote=await quote(circle.page); const circleFloor=circleQuote.regions[0];
  near(circleFloor.items[0].purchaseQuantity,circleFloor.netArea*1.1,.00001);
  near(Number(circleFloor.materialCost),circleFloor.netArea*110,.011); near(Number(circleFloor.laborCost),circleFloor.netArea*20,.011);
  assert.equal(circleQuote.pending,false); const beforeResizingTotal=circleQuote.total;
  await selectShape(circle.page,circleShape.id);
  await circle.page.locator('#shape-edit-form [name="radius"]').fill('2.4'); await circle.page.locator('#shape-edit-form [type="submit"]').click();
  const smallerQuote=await quote(circle.page);
  assert.deepEqual(smallerQuote.regions[0].items.map(item=>({materialId:item.materialId,unitPrice:item.unitPrice,wasteRate:item.wasteRate,laborRate:item.laborRate})),circleFloor.items.map(item=>({materialId:item.materialId,unitPrice:item.unitPrice,wasteRate:item.wasteRate,laborRate:item.laborRate})));
  assert.ok(smallerQuote.regions[0].netArea<circleFloor.netArea); assert.ok(Number(smallerQuote.total)<Number(circleQuote.total));
  await circle.page.locator('#shape-edit-form [name="radius"]').fill('2.5'); await circle.page.locator('#shape-edit-form [type="submit"]').click();
  circleQuote=await quote(circle.page); assert.equal(circleQuote.total,beforeResizingTotal);
  near(circleQuote.regions[0].netArea,circleFloor.netArea);
  pass('已选地面材料在圆房间改半径后保留单价与损耗，面积和完整报价实时随尺寸更新');
  near(await circle.page.evaluate(()=>window.planStudio.get2DWallSelection().area),circleQuote.walls.find(wall=>wall.id===circleShape.id).netArea);
  await circle.page.locator('[data-view="3d"]').click(); await circle.page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);
  const circleStats=await circle.page.evaluate(()=>window.planStudio.get3DStats());
  assert.equal(circleStats.roomCount,1); assert.equal(circleStats.glError,0);
  near(circleStats.selectedWallArea,circleQuote.walls.find(wall=>wall.id===circleShape.id).netArea);
  assert.deepEqual([...new Set(circleStats.selectedWallFaces.map(face=>face.wallId))].sort(),(await project(circle.page)).wallShapes[0].wallIds.slice().sort());
  const scopedAreas = {};
  for (const side of ['left','right']) {
    await circle.page.locator('#wall-finish-side').selectOption(side); await frame(circle.page);
    const scopedQuote = (await quote(circle.page)).walls.find(wall => wall.id === circleShape.id);
    const scopedStats = await circle.page.evaluate(() => window.planStudio.get3DStats());
    near(await circle.page.evaluate(() => window.planStudio.get2DWallSelection().area),scopedQuote.netArea);
    near(scopedStats.selectedWallArea,scopedQuote.netArea);
    assert.ok(scopedStats.selectedWallFaces.length > 0);
    assert.ok(scopedStats.selectedWallFaces.every(face => face.side === side));
    assert.ok(scopedStats.selectedWallSurfaces.every(surface => surface.side === side));
    assert.equal(scopedStats.glError,0); scopedAreas[side] = scopedQuote.netArea;
  }
  near(scopedAreas.left+scopedAreas.right,circleStats.selectedWallArea);
  await circle.page.locator('#wall-finish-side').selectOption('both'); await frame(circle.page);
  assert.deepEqual(await quote(circle.page),circleQuote);
  pass('整组圆墙左右施工范围通过实际下拉切换，二维/三维只高亮对应侧且面积与报价一致，左右和等于双侧');
  await circle.page.screenshot({path:join(artifacts,'circle-room-3d.png')}); await circle.page.locator('[data-view="2d"]').click();
  const saved=await project(circle.page); await circle.page.locator('#save').click(); await circle.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');
  await circle.page.reload(); await circle.page.waitForFunction(()=>window.planStudio?.getWallFootprints); await circle.page.locator('#open-project').click(); await circle.page.locator(`[data-open-project="${saved.id}"]`).click(); await circle.page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);
  assert.deepEqual((await project(circle.page)).wallShapes,saved.wallShapes); assert.deepEqual((await project(circle.page)).planBoundary,saved.planBoundary); assert.equal((await quote(circle.page)).total,circleQuote.total);
  await circle.page.locator('#export').click();const downloading=circle.page.waitForEvent('download');await circle.page.locator('[data-export="json"]').click();const file=await downloading;await file.saveAs(join(artifacts,'authoring-project.json'));const exported=JSON.parse(await readFile(await file.path(),'utf8'));assert.deepEqual(exported.wallShapes,saved.wallShapes);assert.deepEqual(exported.planBoundary,saved.planBoundary);
  pass('圆房间真实采购损耗/人工正确，三维可运行，保存/重开/正式JSON保留边界、曲线参数与报价');
  await circle.page.locator('#export').click(); const csvEvent=circle.page.waitForEvent('download'); await circle.page.locator('[data-export="csv"]').click();
  const csvFile=await csvEvent; await csvFile.saveAs(join(artifacts,'authoring-quote.csv'));
  const csv=await readFile(await csvFile.path(),'utf8');
  const csvRows=csv.replace(/^\uFEFF/,'').trim().split('\r\n').map(line=>(line.match(/"(?:[^"]|"")*"/g)||[]).map(cell=>cell.slice(1,-1).replace(/""/g,'"')));
  assert.ok(csvRows.every(row=>row.length===25));
  const pricedGroup=csvRows.filter(row=>row[0]==='墙面材料明细'&&row[2]===editedShape.name);
  assert.equal(pricedGroup.length,1); assert.equal(pricedGroup[0][15],'100.00'); assert.equal(csvRows.at(-1)[21],circleQuote.total);
  await circle.page.locator('#export').click(); const popupEvent=circle.page.waitForEvent('popup'); await circle.page.locator('[data-export="pdf"]').click();
  const popup=await popupEvent; await popup.waitForLoadState('domcontentloaded'); assert.ok((await popup.locator('body').innerText()).includes(editedShape.name));
  await popup.pdf({path:join(artifacts,'authoring-quote.pdf'),format:'A4',printBackground:true});await popup.close();
  pass('实际CSV与打印PDF按整组输出曲线墙，100元固定费用没有变成分段重复收费');
  await selectShape(circle.page,circleShape.id);
  const beforeDeletion = await project(circle.page), beforeDeletionQuote = await quote(circle.page);
  await circle.page.keyboard.press('Delete');
  await circle.page.waitForFunction(() => window.planStudio.getProject().wallShapes.length === 0);
  assert.equal((await project(circle.page)).walls.length,0);
  assert.equal((await project(circle.page)).regions.length,0);
  await circle.page.keyboard.press('Control+z');
  assert.deepEqual(geometry(await project(circle.page)),geometry(beforeDeletion));
  assert.deepEqual(await quote(circle.page),beforeDeletionQuote);
  pass('已报价圆墙用Delete整组删除，CtrlZ完整恢复所有墙段、房间材料、100元固定费及总报价');
  await circle.page.locator('#enter-decoration').click(); await circle.page.waitForFunction(()=>window.planStudio.getWorkspaceMode()==='decoration');
  await circle.page.locator('[data-place-furniture="nightstand"]').click(); await click(circle.page,{x:600,y:795});
  assert.equal((await project(circle.page)).furniture?.length??0,0); assert.equal((await quote(circle.page)).total,circleQuote.total);
  await circle.page.keyboard.press('Escape'); await circle.page.locator('[data-place-furniture="nightstand"]').click(); await click(circle.page,{x:600,y:500});
  await circle.page.waitForFunction(()=>window.planStudio.getProject().furniture?.length===1); await circle.page.locator('#furniture-unitPrice').fill('50');
  const furnitureBefore= (await project(circle.page)).furniture[0], start=await pointScreen(circle.page,furnitureBefore.position), outside=await pointScreen(circle.page,{x:600,y:795});
  await circle.page.mouse.move(start.x,start.y);await circle.page.mouse.down();await circle.page.mouse.move(outside.x,outside.y,{steps:8});await circle.page.mouse.up();
  const afterDrag=(await project(circle.page)).furniture[0];
  assert.ok(afterDrag.position.x-afterDrag.width/2>=200-1e-6&&afterDrag.position.x+afterDrag.width/2<=1000+1e-6&&afterDrag.position.y-afterDrag.depth/2>=200-1e-6&&afterDrag.position.y+afterDrag.depth/2<=800+1e-6,'Furniture preview and committed dimensions must remain within boundary');
  const beforeInvalidFurniture=await project(circle.page);await circle.page.locator('#furniture-width').fill('2000');
  assert.deepEqual((await project(circle.page)).furniture,beforeInvalidFurniture.furniture);
  near((await quote(circle.page)).regions[0].netArea,circleFloor.netArea);near((await quote(circle.page)).beforeTax,Number(circleQuote.beforeTax)+50,.001);
  await circle.page.screenshot({path:join(artifacts,'furniture-boundary-rejection.png')});
  pass('装修家具中心虽在范围内但占地越界仍拒绝，零残留；拖动和尺寸编辑守住边界且预算不丢失');

  const arc=await open();
  await boundary(arc.page,{x:2,y:2,width:8,depth:6});
  await arc.page.locator('[data-tool="arc"]').click();for(const point of[{x:400,y:500},{x:600,y:500},{x:800,y:500}])await click(arc.page,point);
  assert.equal((await project(arc.page)).wallShapes?.length??0,0);assert.equal((await project(arc.page)).walls.length,0);
  await arc.page.keyboard.press('Escape');await arc.page.locator('[data-tool="arc"]').click();
  for(const point of[{x:400,y:500},{x:600,y:300},{x:800,y:500}])await click(arc.page,point);
  await arc.page.waitForFunction(()=>window.planStudio.getProject().wallShapes?.length===1);
  const openArc=await project(arc.page),arcShape=openArc.wallShapes[0];assert.equal(arcShape.kind,'arc');near(arcShape.radius,200);near(Math.abs(arcShape.sweepDegrees),180);curveQuality(openArc,arcShape);assert.equal(openArc.regions.length,0);
  await wallChain(arc.page,[{x:800,y:500},{x:400,y:500}]);await arc.page.waitForFunction(()=>window.planStudio.getProject().regions.length===1);
  const r=1.9,h=.1,capArea=r*r*Math.acos(h/r)-h*Math.sqrt(r*r-h*h);
  near((await quote(arc.page)).regions[0].netArea,capArea,.05);insideBox(await footprints(arc.page),{minX:200,maxX:1000,minY:200,maxY:800});
  await arc.page.locator('#fit').click();await arc.page.screenshot({path:join(artifacts,'arc-closed-room-2d.png')});
  await arc.page.locator('[data-view="3d"]').click();await arc.page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);assert.equal(await arc.page.evaluate(()=>window.planStudio.get3DStats().roomCount),1);assert.equal(await arc.page.evaluate(()=>window.planStudio.get3DStats().glError),0);await arc.page.screenshot({path:join(artifacts,'arc-closed-room-3d.png')});
  pass('三点圆弧拒绝共线零残留，真实180°弧加直墙闭合，净面积符合内移圆弓公式且三维正常');

  const exact=await open();await exact.page.locator('[data-action="shape-parameters"]').first().click();await exact.page.locator('#shape-parameters-form [name="kind"]').selectOption('arc');
  for(const[name,value]of[['x','6'],['y','5'],['radius','2'],['startDegrees','180'],['sweepDegrees','180'],['thickness','20'],['height','2.8']])await exact.page.locator(`#shape-parameters-form [name="${name}"]`).fill(value);
  await exact.page.locator('#shape-parameters-form [type="submit"], [form="shape-parameters-form"][type="submit"]').click();const exactShape=(await project(exact.page)).wallShapes[0];near(exactShape.center.x,600);near(exactShape.center.y,500);near(exactShape.radius,200);near(exactShape.startDegrees,180);near(exactShape.sweepDegrees,180);curveQuality(await project(exact.page),exactShape);
  pass('精确参数入口按米、厘米与角度绘制圆弧，保存的真实圆心半径和方向一致');

  assert.deepEqual(errors,[]);pass('新增接点、边界与圆弧工作流无浏览器运行时错误');
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,circleQuote},null,2));
  process.stdout.write(`\n${reports.length} 项墙体接点、边界与曲线浏览器验收通过。\n`);
}catch(error){
  await currentPage?.screenshot({path:join(artifacts,'authoring-failure.png')}).catch(()=>{});
  if(currentPage)process.stderr.write(JSON.stringify(await currentPage.evaluate(()=>{const p=window.planStudio?.getProject?.(),q=window.planStudio?.getQuote?.();return{toast:document.querySelector('#toast')?.textContent,project:p&&{id:p.id,wallJoinStyle:p.wallJoinStyle,planBoundary:p.planBoundary,wallShapes:p.wallShapes?.map(s=>({id:s.id,kind:s.kind,center:s.center,radius:s.radius,wallCount:s.wallIds.length})),wallCount:p.walls?.length,regionCount:p.regions?.length},selection:window.planStudio?.getSelection?.(),quote:q&&{pending:q.pending,pendingReason:q.pendingReason,total:q.total,regions:q.regions?.map(r=>({id:r.id,netArea:r.netArea,total:r.total})),walls:q.walls?.filter(w=>w.items.length).map(w=>({id:w.id,netArea:w.netArea,total:w.total,itemAdditionalCost:w.itemAdditionalCost}))}};}).catch(()=>({})),null,2)+'\n');throw error;
}finally{await browser?.close();server.kill();}
