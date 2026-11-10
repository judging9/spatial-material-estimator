import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { projectToCSV } from '../static/studio/lib/export.js';
import { createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';

const item = (patch = {}) => ({ id: 'tile', materialId: 'tile', materialName: '自定义地砖', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '', wasteRate: '10', laborRate: '20', additionalCost: '5', ...patch });
const fixture = () => ({ version: 1, id: 'missing-price', name: '材料补价工程', drawing: null, calibration: { metersPerPixel: .01 }, regions: [{ id: 'room', name: '客厅', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], holes: [], hidden: false, items: [item()], additionalCost: '7' }], additionalCost: '10', taxRate: '9', view: { labels: true, drawingOpacity: 1 } });

test('blank surface price preserves actual net and purchase quantity, labor and fixed fees without a complete material total', () => {
  const p = fixture(), before = structuredClone(p), q = calculateProject(p), line = q.regions[0].items[0];
  assert.equal(q.pending, true); assert.equal(q.total, null);
  assert.equal(line.unitPrice, ''); assert.equal(line.netQuantity, '12'); assert.equal(line.purchaseQuantity, '13.2');
  assert.equal(line.materialCost, null); assert.equal(line.laborCost, '240.00'); assert.equal(line.knownTotal, '245.00');
  assert.equal(q.knownMaterialCost, '0.00'); assert.equal(q.knownLaborCost, '240.00'); assert.equal(q.knownSubtotal, '262.00');
  assert.match(q.pendingReason, /尚未填写单价/); assert.deepEqual(p, before);
});

test('explicit zero price confirms free material while empty price remains pending', () => {
  const p = fixture(); p.regions[0].items[0].unitPrice = '0';
  const q = calculateProject(p); assert.equal(q.pending, false); assert.equal(q.beforeTax, '262.00'); assert.equal(q.total, '285.58');
  p.regions[0].items[0].unitPrice = '   '; assert.equal(calculateProject(p).pending, true);
});

test('unavailable geometry and a missing material price are both reported and neither creates invented quantity or labor', () => {
  const p = fixture(); p.calibration.metersPerPixel = null;
  const q = calculateProject(p), line = q.regions[0].items[0];
  assert.equal(line.netQuantity, null); assert.equal(line.purchaseQuantity, null); assert.equal(line.laborCost, null);
  assert.match(q.pendingReason, /校准/); assert.match(q.pendingReason, /单价/);
  assert.equal(q.knownSubtotal, '22.00'); assert.equal(q.total, null);
});

test('area, perimeter and manual items share missing-price behavior and preserve each real quantity basis', () => {
  const p = fixture(); p.regions[0].items = [item(), item({ id: 'edge', unit: 'm', quantityMode: 'perimeter', wasteRate: '0', laborRate: '2' }), item({ id: 'piece', unit: '件', quantityMode: 'manual', quantity: '3', wasteRate: '0', laborRate: '0.105' })];
  const q = calculateProject(p), rows = q.regions[0].items;
  assert.deepEqual(rows.map(row => row.netQuantity), ['12', '14', '3']);
  assert.deepEqual(rows.map(row => row.laborCost), ['240.00', '28.00', '0.32']);
  assert.ok(rows.every(row => row.materialCost === null && row.total === null));
});

test('missing-price projects can be saved and reloaded, and draft CSV labels price rather than inventing failed calibration', async () => {
  const p = fixture(), store = createMemoryProjectStore(); await store.saveProject(p);
  const read = await store.loadProject(p.id); assert.equal(read.regions[0].items[0].unitPrice, '');
  const json = await exportProjectJSON(read), restored = await importProjectJSON(json);
  assert.equal(calculateProject(restored).total, null); assert.equal(calculateProject(restored).knownSubtotal, '262.00');
  const csv = projectToCSV(restored, { allowDraft: true }); assert.match(csv, /待填写单价/); assert.match(csv, /材料尚未填写单价/);
  assert.throws(() => projectToCSV(restored), /单价/);
});

test('missing price support still rejects invalid rates and preserves exact large labor amounts', () => {
  const p = fixture();
  for (const value of ['-1', 'NaN', 'Infinity']) { p.regions[0].items[0].laborRate = value; assert.throws(() => calculateProject(p)); }
  p.regions[0].items[0] = item({ quantityMode: 'manual', unit: '件', quantity: '1', laborRate: '9007199254740993.01', additionalCost: '0' });
  assert.equal(calculateProject(p).knownLaborCost, '9007199254740993.01');
});
