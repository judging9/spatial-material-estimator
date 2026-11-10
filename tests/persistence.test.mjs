import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, createMemoryProjectStore, createProjectStore, dataURLToBlob,
  exportProjectJSON, importProjectJSON, revokeProjectDrawing } from '../static/studio/lib/persistence.js';

const project = () => ({ version: 1, id: 'p1', name: '离线图纸工程', drawing: {
  id: 'drawing-1', name: '原图.png', type: 'image', url: '/api/studio/drawings/drawing-1', width: 100, height: 80,
}, calibration: { metersPerPixel: 0.01, method: 'line' }, regions: [{
  id: 'r1', name: '房间', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }],
  holes: [], hidden: false, items: [{ id: 'i1', materialId: 'm1', unitPrice: '120.00', wasteRate: '5', laborRate: '18.00',
    additionalCost: '0', quantityMode: 'area', quantity: '0' }], additionalCost: '0',
}], additionalCost: '0', taxRate: '9', view: { labels: true, drawingOpacity: 0.8 }, customMetadata: { revision: 'A' } });
const imageBlob = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });

test('JSON export recomputes the current quote after a saved price changes without mutating the saved snapshot', async () => {
  const data = project();
  data.drawing = null;
  data.quoteSummary = { total: '31.39' };
  const store = createMemoryProjectStore();
  await store.saveProject(data);
  data.regions[0].items[0].unitPrice = '240.00';
  const exported = JSON.parse(await exportProjectJSON(data));
  assert.equal(exported.quoteSummary.total, '58.86');
  assert.equal(exported.quoteSummary.materialCost, '50.40');
  assert.equal(exported.quoteSummary.laborCost, '3.60');
  assert.equal(exported.quoteSummary.tax, '4.86');
  assert.equal(exported.regions[0].items[0].unitPrice, '240.00');
  assert.equal(data.quoteSummary.total, '31.39');
  assert.equal((await store.loadProject(data.id)).quoteSummary.total, '31.39');
});
const wallProject = () => ({ ...project(), drawing: null, wallHeight: 320, wallThickness: 24, walls: [
  { id: 'wall-a', start: { x: 0, y: 0 }, end: { x: 500, y: 0 }, thickness: 20, height: 280 },
  { id: 'wall-b', start: { x: 500, y: 0 }, end: { x: 500, y: 400 }, thickness: 24, height: 320 },
] });

test('wall defaults and per-wall dimensions survive save/load without sharing mutable geometry', async () => {
  const storage = createMemoryProjectStore();
  const original = wallProject();
  const expected = structuredClone(original);
  await storage.saveProject(original);
  original.walls[0].height = 500;
  original.walls[0].start.x = 25;
  original.wallThickness = 30;
  const loaded = await storage.loadProject(original.id);
  assert.deepEqual(loaded, expected);
  loaded.walls[0].thickness = 40;
  assert.deepEqual(await storage.loadProject(original.id), expected);
});

test('JSON export/import preserves wall dimensions and project defaults exactly', async () => {
  const original = wallProject();
  original.wallHeight = 50;
  original.wallThickness = 100;
  original.walls[0].height = 1000;
  original.walls[0].thickness = 1;
  const imported = await importProjectJSON(await exportProjectJSON(original));
  assert.equal(imported.wallHeight, original.wallHeight);
  assert.equal(imported.wallThickness, original.wallThickness);
  assert.deepEqual(imported.walls, original.walls);
  assert.deepEqual(imported.regions, original.regions);
});

test('legacy projects and walls without height remain unchanged after persistence and JSON round-trip', async () => {
  const storage = createMemoryProjectStore();
  const original = wallProject();
  delete original.wallHeight;
  delete original.wallThickness;
  for (const wall of original.walls) delete wall.height;
  await storage.saveProject(original);
  assert.deepEqual(await storage.loadProject(original.id), original);
  const imported = await importProjectJSON(await exportProjectJSON(original));
  assert.deepEqual(imported.walls, original.walls);
  assert.equal('wallHeight' in imported, false);
  assert.equal('wallThickness' in imported, false);
  assert.equal(imported.walls.some(wall => 'height' in wall), false);
  const oldProject = project();
  oldProject.drawing = null;
  await storage.saveProject(oldProject);
  assert.deepEqual(await storage.loadProject(oldProject.id), oldProject);
});

test('invalid wall dimensions cannot replace a saved project or pass JSON import/export', async () => {
  const storage = createMemoryProjectStore();
  const valid = wallProject();
  await storage.saveProject(valid);
  const invalidChanges = [
    data => { data.wallHeight = 49; },
    data => { data.wallHeight = 1001; },
    data => { data.wallHeight = NaN; },
    data => { data.wallHeight = '280'; },
    data => { data.wallThickness = 0; },
    data => { data.wallThickness = 101; },
    data => { data.wallThickness = Infinity; },
    data => { data.wallThickness = null; },
    data => { data.walls[0].height = 49; },
    data => { data.walls[0].height = 1001; },
    data => { data.walls[0].height = Infinity; },
    data => { data.walls[0].thickness = 0; },
    data => { data.walls[0].thickness = 101; },
    data => { data.walls[0].thickness = NaN; },
    data => { data.walls = {}; },
  ];
  for (const change of invalidChanges) {
    const bad = structuredClone(valid);
    change(bad);
    assert.throws(() => storage.saveProject(bad), /墙/);
    await assert.rejects(exportProjectJSON(bad), /墙/);
    // JSON cannot represent NaN or infinity; encode them as invalid strings
    // rather than silently converting per-wall dimensions to legacy nulls.
    const json = JSON.stringify(bad, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
    await assert.rejects(importProjectJSON(json), /墙/);
    assert.deepEqual(await storage.loadProject(valid.id), valid);
  }
});

test('工程、校准、区域、单价快照和原图Blob一并保存，加载互不共享可变状态', async () => {
  const storage = createMemoryProjectStore();
  const original = project();
  const blob = imageBlob();
  const saved = await storage.saveProject(original, { drawingBlob: blob });
  assert.equal(saved.hasDrawingBlob, true);
  original.regions[0].points[0].x = 999;
  const loaded = await storage.loadProject('p1', { hydrateDrawing: false });
  assert.equal(loaded.regions[0].points[0].x, 0);
  assert.equal(loaded.regions[0].items[0].unitPrice, '120.00');
  assert.equal(loaded.calibration.metersPerPixel, 0.01);
  assert.equal(loaded.customMetadata.revision, 'A');
  assert.deepEqual(new Uint8Array(await loaded.drawing.blob.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
  loaded.name = 'Changed loaded copy';
  assert.equal((await storage.loadProject('p1')).name, '离线图纸工程');
});

test('连续保存按调用顺序提交，编辑区域时保留同一原图Blob', async () => {
  const storage = createMemoryProjectStore();
  await storage.saveProject(project(), { drawingBlob: imageBlob() });
  const first = project(); first.name = 'First';
  const second = project(); second.name = 'Second'; second.regions[0].name = '重新命名区域';
  await Promise.all([storage.saveProject(first), storage.saveProject(second)]);
  const loaded = await storage.loadProject('p1', { hydrateDrawing: false });
  assert.equal(loaded.name, 'Second');
  assert.equal(loaded.regions[0].name, '重新命名区域');
  assert.ok(loaded.drawing.blob instanceof Blob);
});

test('替换原图不能继承旧原图Blob，删除原图也清除缓存', async () => {
  const storage = createMemoryProjectStore();
  await storage.saveProject(project(), { drawingBlob: imageBlob() });
  const replacement = project(); replacement.drawing.id = 'drawing-2';
  await storage.saveProject(replacement);
  assert.equal((await storage.listProjects())[0].hasDrawingBlob, false);
  replacement.drawing = null;
  await storage.saveProject(replacement);
  assert.equal((await storage.loadProject('p1')).drawing, null);
});

test('项目列表只给摘要，删除工程不会影响另一个工程', async () => {
  const storage = createMemoryProjectStore();
  await storage.saveProject(project());
  const other = project(); other.id = 'p2'; other.name = '另一个工程';
  await storage.saveProject(other);
  const listed = await storage.listProjects();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((entry) => entry.id === 'p1').regionCount, 1);
  assert.ok(!('regions' in listed[0]));
  assert.equal(await storage.deleteProject('p1'), true);
  assert.equal(await storage.loadProject('p1'), null);
  assert.ok(await storage.loadProject('p2'));
  assert.equal(await storage.deleteProject('p1'), false);
});

test('保存失败真实报告错误，队列后续仍可恢复保存', async () => {
  let shouldFail = true;
  const records = new Map();
  const storage = createProjectStore({ backend: {
    async read(id) { return records.get(id); }, async list() { return [...records.values()]; },
    async write(record) { if (shouldFail) throw new Error('Quota exceeded'); records.set(record.id, record); },
    async remove(id) { records.delete(id); },
  } });
  await assert.rejects(storage.saveProject(project()), /Quota exceeded/);
  shouldFail = false;
  await storage.saveProject(project());
  assert.equal((await storage.listProjects()).length, 1);
});

test('导出的JSON包含原图字节和引用材料，可在无服务器文件时重新载入', async () => {
  const data = project();
  data.materialsSnapshot = [{ id: 'previous-unused', name: '已删除区域使用过的材料' }];
  const materials = [{ id: 'm1', name: '木地板', unit: 'm²', unitPrice: '999', image: 'data:image/svg+xml,%3Csvg%2F%3E', color: '#a87851' },
    { id: 'unused', name: '不属于本工程的材料', unit: '件' }];
  const json = await exportProjectJSON(data, { drawingBlob: imageBlob(), materials });
  assert.equal((json.match(/data:image\/png;base64,/g) ?? []).length, 1);
  const imported = await importProjectJSON(json);
  assert.ok(imported.drawing.url.startsWith('data:image/png;base64,'));
  assert.ok(imported.drawing.blob instanceof Blob);
  assert.equal(imported.regions[0].items[0].unitPrice, '120.00');
  assert.equal(imported.regions[0].items[0].materialName, '木地板');
  assert.equal(imported.materialsSnapshot.length, 1);
  assert.equal(imported.materialsSnapshot[0].id, 'm1');
  assert.deepEqual(new Uint8Array(await imported.drawing.blob.arrayBuffer()), new Uint8Array(await imageBlob().arrayBuffer()));
  assert.equal(imported.view.drawingOpacity, 0.8);
});

test('只有服务器URL而无缓存原图时拒绝导出不完整的工程JSON', async () => {
  await assert.rejects(exportProjectJSON(project()), /原图尚未缓存/);
  const data = project(); data.drawing = null;
  assert.equal((await importProjectJSON(await exportProjectJSON(data))).drawing, null);
});

test('原生SVG data URL保留UTF-8文本，拒绝可执行data URL和错误工程', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文图纸</text></svg>';
  assert.equal(await dataURLToBlob('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)).text(), svg);
  assert.throws(() => dataURLToBlob('data:text/html,<script>alert(1)</script>'), /格式/);
  await assert.rejects(importProjectJSON('{bad'), /JSON/);
  await assert.rejects(importProjectJSON(JSON.stringify({ ...project(), version: 9 })), /版本/);
  await assert.rejects(importProjectJSON(JSON.stringify({ ...project(), calibration: { metersPerPixel: -1 } })), /校准/);
  const poisoned = JSON.stringify(project()).replace('"customMetadata":{"revision":"A"}', '"__proto__":{"polluted":true}');
  await assert.rejects(importProjectJSON(poisoned), /不安全/);
});

test('工程导入在替换当前状态前拒绝重叠、自相交区域与无效金额', async () => {
  const overlap = project();
  overlap.drawing = null;
  overlap.regions.push({ ...structuredClone(overlap.regions[0]), id: 'overlap' });
  await assert.rejects(importProjectJSON(JSON.stringify(overlap)), /重叠/);
  const crossed = project();
  crossed.regions[0].points = [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 50, y: 0 }, { x: 0, y: 40 }];
  await assert.rejects(importProjectJSON(JSON.stringify(crossed)));
  const badPrice = project();
  badPrice.regions[0].items[0].unitPrice = 'NaN';
  await assert.rejects(importProjectJSON(JSON.stringify(badPrice)), /有效数字/);
});

test('加载原图生成新临时URL，关闭原图可释放URL', async () => {
  const storage = createMemoryProjectStore();
  await storage.saveProject(project(), { drawingBlob: imageBlob() });
  const loaded = await storage.loadProject('p1');
  assert.ok(loaded.drawing.url.startsWith('blob:'));
  assert.equal(loaded.drawing.sourceUrl, project().drawing.url);
  revokeProjectDrawing(loaded);
});

test('撤销/重做完整恢复几何与价格快照，新编辑丢弃旧重做分支，历史有上限', () => {
  const initial = project();
  const history = createHistory(initial, { limit: 3 });
  const second = project(); second.regions[0].points[0].x = 5;
  history.push(second);
  second.regions[0].points[0].x = 999;
  const third = project(); third.regions[0].items[0].unitPrice = '130.00';
  history.push(third);
  assert.equal(history.undo().regions[0].points[0].x, 5);
  assert.equal(history.undo().regions[0].points[0].x, 0);
  assert.equal(history.redo().regions[0].points[0].x, 5);
  const branch = project(); branch.name = '新分支';
  history.push(branch);
  assert.equal(history.canRedo(), false);
  assert.equal(history.current().name, '新分支');
  const fourth = project(); fourth.name = '第四次'; history.push(fourth);
  assert.equal(history.length, 3);
  const unchanged = history.current(); history.push(unchanged);
  assert.equal(history.length, 3);
  history.reset(initial);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});
