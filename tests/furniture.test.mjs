import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFurniture, furnitureFootprint, furnitureContains, clampFurniturePosition } from '../static/studio/lib/furniture.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { validateProject, createHistory, createProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';

const item = (overrides = {}) => ({ id: 'sofa', name: '沙发', kind: 'sofa', position: { x: 300, y: 300 }, width: 200, depth: 100, height: 85, rotation: 0, quantity: '3', unitPrice: '0.105', additionalCost: '0.005', ...overrides });
const project = (overrides = {}) => ({ version: 1, id: 'furniture-project', name: '家具报价', drawing: { id: 'plan', name: '平面图', type: 'plan', width: 1000, height: 800, url: '' }, calibration: { metersPerPixel: .01 }, regions: [], furniture: [item()], additionalCost: '0.005', taxRate: '10', view: { labels: true, drawingOpacity: 1 }, ...overrides });

test('家具按数量及自填价格计算，组件以分四舍五入，统一税只计一次', () => {
  const quote = calculateProject(project());
  assert.equal(quote.furniture[0].items[0].materialCost, '0.32');
  assert.equal(quote.furniture[0].total, '0.33');
  assert.equal(quote.knownFurnitureCost, '0.33');
  assert.equal(quote.beforeTax, '0.34');
  assert.equal(quote.tax, '0.03');
  assert.equal(quote.total, '0.37');
});

test('留空家具单价是待填价，明确填零才可生成完整报价', () => {
  const p = project({ furniture: [item({ unitPrice: '', additionalCost: '0' })], additionalCost: '0', taxRate: '0' });
  assert.equal(calculateProject(p).total, null);
  assert.equal(calculateProject(p).furniture[0].pendingReason, '家具尚未填写单价');
  p.furniture[0].unitPrice = '0';
  assert.equal(calculateProject(p).total, '0.00');
});

test('家具脚印、拖动、旋转、数量和隐藏状态均不扣房间净面积', () => {
  const p = project({ regions: [{ id: 'room', name: '客厅', points: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 400 }, { x: 0, y: 400 }], holes: [], additionalCost: '0', items: [{ id: 'floor', materialId: 'm', unitPrice: '100', quantityMode: 'area' }] }], additionalCost: '0', taxRate: '0' });
  assert.equal(calculateProject(p).regions[0].netArea, 20);
  const old = calculateProject(p).total;
  Object.assign(p.furniture[0], { hidden: true, rotation: 45, position: { x: 1, y: 1 }, width: 300 });
  assert.equal(calculateProject(p).regions[0].netArea, 20);
  assert.equal(calculateProject(p).total, old);
});

test('未校准底图不提供假尺寸脚印，数量报价仍可独立计算', () => {
  const p = project({ drawing: { ...project().drawing, type: 'image' }, calibration: { metersPerPixel: null } });
  assert.equal(furnitureFootprint(p.furniture[0], p), null);
  assert.equal(furnitureContains(p.furniture[0], { x: 300, y: 300 }, p), false);
  assert.equal(calculateProject(p).total, '0.37');
});

test('校准后家具大于整张底图时保留真实尺寸，位置可调整而不抛出异常', () => {
  const p = project({ drawing: { ...project().drawing, type: 'image' }, calibration: { metersPerPixel: .0005 } }), f = item();
  const position = clampFurniturePosition(f, { x: 200, y: 200 }, p);
  assert.deepEqual(position, { x: 500, y: 400 });
  assert.equal(f.width, 200);
  assert.equal(furnitureFootprint({ ...f, position }, p).length, 4);
});

test('真实家具脚印及命中与画布zoom无关，旋转后坐标和边界正确', () => {
  const p = project(), f = item();
  assert.deepEqual(furnitureFootprint(f, p), [{ x: 200, y: 250 }, { x: 400, y: 250 }, { x: 400, y: 350 }, { x: 200, y: 350 }]);
  f.rotation = 90;
  assert.equal(furnitureContains(f, { x: 349, y: 399 }, p), true);
  assert.equal(furnitureContains(f, { x: 400, y: 300 }, p), false);
  const clamped = clampFurniturePosition(f, { x: -100, y: 900 }, p);
  assert.ok(Math.abs(clamped.x - 50) < 1e-8 && Math.abs(clamped.y - 700) < 1e-8);
});

test('非法家具尺寸、位置、负价、数量及重复id在导入前被拒绝', () => {
  for (const patch of [{ width: 0 }, { depth: Infinity }, { height: -1 }, { rotation: NaN }, { position: { x: Infinity, y: 0 } }, { quantity: '0' }, { quantity: '1.5' }, { quantity: '1000001' }, { unitPrice: '-1' }, { additionalCost: '-1' }, { kind: 'invalid' }]) assert.throws(() => validateFurniture([item(patch)]));
  assert.throws(() => validateFurniture([item(), item()]));
  assert.throws(() => validateProject(project({ furniture: [item({ unitPrice: 'oops' })] })));
});

test('项目保存加载、JSON迁移和撤销恢复家具与自填价格', async () => {
  const records = new Map(), backend = { read: async id => records.get(id), write: async record => records.set(record.id, structuredClone(record)), list: async () => [...records.values()], remove: async id => records.delete(id) };
  const store = createProjectStore({ backend }), p = project();
  await store.saveProject(p);
  const loaded = await store.loadProject(p.id);
  assert.deepEqual(loaded.furniture, p.furniture);
  const imported = await importProjectJSON(await exportProjectJSON(p, { drawingBlob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"></svg>'], { type: 'image/svg+xml' }) }));
  assert.deepEqual(imported.furniture, p.furniture);
  const h = createHistory(p), changed = structuredClone(p); changed.furniture = []; h.push(changed);
  assert.deepEqual(h.undo().furniture, p.furniture);
  assert.deepEqual(h.redo().furniture, []);
  const legacy = project(); delete legacy.furniture; assert.doesNotThrow(() => validateProject(legacy));
});
