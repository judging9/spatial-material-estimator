import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const studio = resolve(process.env.SELECTION_STUDIO_ROOT || 'build/studio');
const assetsRoot = resolve('static/studio/assets');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>html,body{margin:0}#scene{position:relative;width:100vw;height:100vh}</style><div id="scene"></div>'); return; }
    const base = pathname.startsWith('/assets/') ? assetsRoot : studio;
    const file = resolve(base, '.' + (base === assetsRoot ? pathname.slice(7) : pathname));
    if (!file.startsWith(base + '/') && !file.startsWith(base + '\\')) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const executablePath = process.env.CHROME_PATH || ['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const artifacts = resolve('artifacts/wall-selection'); await mkdir(artifacts, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { Viewer3D } = await import('./viewer3d.js');
    const project = { version: 1, id: 'selection-fixture', name: '真实选面', drawing: { id: 'plan', type: 'plan', width: 600, height: 400, url: '' }, calibration: { metersPerPixel: .01 },
      walls: [{ id: 'wall', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 280, finishSide: 'both', items: [{ id: 'material', color: '#bda98f' }] }], regions: [],
      openings: [{ id: 'hole', wallId: 'wall', kind: 'hole', shape: 'ellipse', offset: 100, bottom: 100, width: 100, height: 100, depth: 20 },
        { id: 'window', wallId: 'wall', kind: 'window', shape: 'rectangle', offset: 220, bottom: 100, width: 80, height: 100, depth: 8 }],
      additionalCost: '0', taxRate: '0', view: { labels: true } };
    const state = { hits: [], errors: [] };
    const viewer = new Viewer3D(document.querySelector('#scene'), { selectWall(id, side) { state.hits.push({ id, side: side || null }); }, selectRegion() {}, selectOpening(id) { if (id) state.hits.push({ opening: id }); }, selectFurniture(id) { if (id) state.hits.push({ furniture: id }); }, error(message) { state.errors.push(message); } });
    viewer.setCutaway(false); viewer.setProject(project); viewer.setVisible(true); viewer.fit();
    window.wallSelectionValidation = { viewer, project, state };
  });
  await page.waitForFunction(() => { const stats = window.wallSelectionValidation.viewer.getStats(); return stats.ready && stats.furnitureAssetsReady; });
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const sample = point => page.evaluate(point => {
    const { viewer } = window.wallSelectionValidation, gl = viewer.canvas.getContext('webgl'), p = viewer.projectToScreen(point), rgba = new Uint8Array(4);
    const sx = viewer.canvas.width / viewer.canvas.clientWidth, sy = viewer.canvas.height / viewer.canvas.clientHeight;
    gl.readPixels(Math.floor(p.x * sx), viewer.canvas.height - Math.floor(p.y * sy) - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return [...rgba];
  }, point);
  const facePoint = { x: 3.7, y: 1.4, z: .1 }, topPoint = { x: .4, y: 2.8, z: 0 };
  await frame();
  const base = await sample(facePoint), top = await sample(topPoint);
  await page.evaluate(() => { const s = window.wallSelectionValidation; s.project.walls[0].finishSide = 'left'; s.viewer.setProject(s.project, null, 'wall'); }); await frame();
  const left = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.equal(left.selectedWallSide, 'left'); assert.ok(left.selectedWallSurfaceCount > 1);
  assert.ok(left.selectedWallSurfaces.every(surface => surface.side === 'left'));
  assert.equal(left.selectedWallFaceCount, 1);
  assert.equal(left.selectedWallFaces[0].holes.length, 2);
  assert.equal(left.selectedWallFaces[0].points.length, 4);
  assert.ok(Math.abs(left.selectedWallFaces[0].area - left.selectedWallArea) < 1e-8);
  assert.equal(left.selectedWallBounds.min.z, .1); assert.equal(left.selectedWallBounds.max.z, .1);
  assert.notDeepEqual(await sample(facePoint), base, 'chosen real side must visibly highlight over material colour');
  assert.deepEqual(await sample(topPoint), top, 'the wall top is not a priced side and must retain its original colour');
  await page.screenshot({ path: join(artifacts, 'left-wall-area.png') });

  await page.evaluate(() => { const s = window.wallSelectionValidation; s.project.walls[0].finishSide = 'right'; s.viewer.setProject(s.project); }); await frame();
  const rightScopeBase = await sample(facePoint);
  await page.evaluate(() => { const s = window.wallSelectionValidation; s.viewer.setProject(s.project, null, 'wall'); }); await frame();
  const right = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.ok(right.selectedWallSurfaces.every(surface => surface.side === 'right'));
  assert.equal(right.selectedWallBounds.min.z, -.1); assert.equal(right.selectedWallBounds.max.z, -.1);
  assert.deepEqual(await sample(facePoint), rightScopeBase, 'selecting the opposite side must not tint the visible unselected face');
  await page.screenshot({ path: join(artifacts, 'right-wall-area.png') });

  const click = async point => {
    const p = await page.evaluate(point => window.wallSelectionValidation.viewer.projectToScreen(point), point);
    assert.equal(p.visible, true); await page.mouse.click(p.x, p.y);
    return page.evaluate(() => window.wallSelectionValidation.state.hits.at(-1));
  };
  assert.deepEqual(await click(facePoint), { id: 'wall', side: 'left' });
  assert.deepEqual(await click(topPoint), { id: 'wall', side: null });
  assert.equal((await click({ x: 2.6, y: 1.5, z: 0 })).opening, 'window');
  const hole = await click({ x: 1.5, y: 1.5, z: 0 });
  assert.ok(!hole?.id, 'a real through-hole centre must not pick an imaginary solid wall');
  await page.evaluate(() => { const s = window.wallSelectionValidation; s.project.walls[0].finishSide = 'both'; s.viewer.setProject(s.project, null, 'wall'); s.viewer.setCutaway(true); }); await frame();
  const cut = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.ok(cut.selectedWallVisibleArea < cut.selectedWallArea);
  assert.equal(cut.selectedWallFaceCount, 2);
  assert.ok(cut.selectedWallFaces.every(face => face.holes.length === 2));
  assert.ok(cut.selectedWallSurfaces.every(surface => ['left', 'right'].includes(surface.side)));
  assert.ok(cut.selectedWallSurfaces.every(surface => surface.points.every(p => p.y <= .60000001)));
  assert.equal(cut.glError, 0); assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.wallSelectionValidation.state.errors), []);
  await page.evaluate(() => {
    const s = window.wallSelectionValidation; s.project.walls[0].end = { x: 300, y: 400 }; s.project.walls[0].finishSide = 'left';
    s.viewer.setCutaway(false); s.viewer.setProject(s.project, null, 'wall'); s.viewer.fit();
  }); await frame();
  const diagonal = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.ok(diagonal.selectedWallSurfaceCount > 0);
  assert.ok(diagonal.selectedWallSurfaces.every(surface => surface.side === 'left' && Math.abs(surface.normal.x + .8) < 1e-8 && Math.abs(surface.normal.z - .6) < 1e-8));
  assert.equal(diagonal.glError, 0);
  await page.evaluate(() => {
    const s = window.wallSelectionValidation;
    s.project.walls = []; s.project.openings = [];
    s.project.furniture = ['sofa', 'bed', 'table', 'chair', 'cabinet', 'custom', 'nightstand', 'wardrobe'].map((kind, index) => ({ id: `furniture-${index}`, name: kind, kind,
      position: { x: index % 3 * 250, y: Math.floor(index / 3) * 300 + 100 }, width: 140, depth: 80, height: 90, rotation: index === 1 ? 30 : 0, quantity: '1', unitPrice: '', additionalCost: '0' }));
    s.viewer.setProject(s.project); s.viewer.setSelectedFurniture(null); s.viewer.fit();
  }); await frame();
  const furniture = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.equal(furniture.renderedFurnitureCount, 8); assert.equal(furniture.furnitureCount, 8);
  assert.ok(furniture.furniture.every(item => item.size.width === 1.4 && item.size.height === .9 && item.size.depth === .8));
  assert.ok(furniture.furniture.every(item => item.geometrySource === 'original-mesh'));
  assert.ok(furniture.furnitureTriangles > 2000);
  assert.ok(furniture.furnitureBatchCount <= 35, 'asset faces must be merged by color to limit draw calls');
  assert.equal(furniture.glError, 0);
  const customPoint = { x: 5, y: .9, z: 4 }, furnitureBase = await sample(customPoint);
  assert.equal((await click(customPoint)).furniture, 'furniture-5');
  await page.evaluate(() => window.wallSelectionValidation.viewer.setSelectedFurniture('furniture-5')); await frame();
  assert.notDeepEqual(await sample(customPoint), furnitureBase, 'selected furniture must visibly highlight');
  assert.equal(await page.evaluate(() => window.wallSelectionValidation.viewer.getStats().selectedFurnitureId), 'furniture-5');
  await page.screenshot({ path: join(artifacts, 'furniture-true-dimensions.png') });
  await page.evaluate(() => { const s = window.wallSelectionValidation; s.project.furniture[5].hidden = true; s.viewer.setProject(s.project); }); await frame();
  assert.equal(await page.evaluate(() => window.wallSelectionValidation.viewer.getStats().furnitureCount), 7);
  const nightstand = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats().furniture.find(item => item.kind === 'nightstand'));
  assert.equal((await click({ x: nightstand.position.x, y: nightstand.size.height, z: nightstand.position.z })).furniture, nightstand.id);
  const wardrobe = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats().furniture.find(item => item.kind === 'wardrobe'));
  assert.equal((await click({ x: wardrobe.position.x, y: wardrobe.size.height, z: wardrobe.position.z })).furniture, wardrobe.id);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.wallSelectionValidation.state.errors), []);
  await page.route('**/assets/furniture-original.json', route => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(async () => {
    const { Viewer3D } = await import('./viewer3d.js'), s = window.wallSelectionValidation;
    s.viewer.dispose();
    s.project.furniture = s.project.furniture.filter(item => ['nightstand', 'wardrobe'].includes(item.kind));
    s.viewer = new Viewer3D(document.querySelector('#scene'), { selectWall() {}, selectRegion() {}, error(message) { s.state.errors.push(message); } });
    s.viewer.setProject(s.project); s.viewer.setVisible(true); s.viewer.fit();
  });
  await page.waitForFunction(() => window.wallSelectionValidation.viewer.getStats().furnitureAssetsState === 'fallback'); await frame();
  const fallback = await page.evaluate(() => window.wallSelectionValidation.viewer.getStats());
  assert.equal(fallback.ready, true); assert.equal(fallback.furnitureCount, 2);
  assert.ok(fallback.furniture.every(item => item.geometrySource === 'parametric' && item.size.height === .9));
  assert.deepEqual(await page.evaluate(() => window.wallSelectionValidation.state.errors), []);
  const previews = await browser.newPage({ viewport: { width: 960, height: 560 } });
  await previews.goto(`http://127.0.0.1:${server.address().port}`);
  await previews.setContent('<style>body{margin:0;background:#f6f5f0;font:14px system-ui;color:#3d463f;padding:32px}h1{font-size:20px;font-weight:500;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.item{background:white;border:1px solid #e3e5dc;padding:12px;text-align:center;border-radius:8px}img{display:block;width:100%;height:160px;object-fit:contain}</style><h1>Original furniture · Offline model previews</h1><div class="grid">' + ['sofa', 'bed', 'table', 'chair', 'cabinet', 'custom', 'nightstand', 'wardrobe'].map(kind => '<div class="item"><img src="/assets/furniture/' + kind + '.svg"><span>' + kind + '</span></div>').join('') + '</div>');
  await previews.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  await previews.screenshot({ path: join(artifacts, 'original-furniture-previews.png') }); await previews.close();
  console.log('Real WebGL wall selection: left/right exact face tint, unselected/top pixels, true side picking, window and ellipse voids, clipped scope and read-only area statistics passed.');
  console.log('Eight original furniture meshes: offline loading, batching, dimensions, orbit fit without walls, rotation, selection pixels, nightstand/wardrobe picking, hiding and missing-asset fallback passed.');
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
