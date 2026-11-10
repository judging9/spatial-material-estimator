import test from 'node:test';
import assert from 'node:assert/strict';
import { readMaterialSource } from '../static/studio/project-material-prices.js';

const web = {
  id: 'source-material', name: '项目瓷砖', unit: 'm²', unitPrice: '88.605',
  provenance: { source: '供应商', sourceUrl: 'https://supplier.example/prices', materialName: '瓷砖', originalUnit: '平方米', region: '杭州', spec: '600x600', supplier: '当地厂家', priceDate: '2026-11-01', updatedAt: '2026-11-08T03:00:00Z',
    refresh: { kind: 'web', url: 'https://supplier.example/prices', tableIndex: 1, hasHeader: true, mapping: { name: 0, unit: 1, price: 2 } } },
};
const formFor = (material, patch = {}) => {
  const p = material.provenance, form = new FormData();
  for (const [key, value] of Object.entries({ name: material.name, unit: material.unit, unitPrice: material.unitPrice, sourceKind: p.refresh?.kind || 'manual', quoteSource: p.source, quoteUrl: p.sourceUrl || '', quoteName: p.materialName || material.name, quoteRegion: p.region || '', quoteDate: p.priceDate || '', quoteSpec: p.spec || '', quoteSupplier: p.supplier || '', ...patch })) form.set(key, value);
  return form;
};
test('editing non-price material properties retains raw source unit, web mapping and actual timestamp', () => {
  const before = structuredClone(web), result = readMaterialSource(formFor(web, { color: '#668899', wasteRate: '10', description: '新描述' }), web);
  assert.deepEqual(result, { ...web.provenance, manual: undefined }); assert.deepEqual(web, before);
});
test('NBS material edits keep the article identity and separate latest-release refresh URL', () => {
  const material = { ...web, unit: '吨', provenance: { ...web.provenance, sourceUrl: 'https://www.stats.gov.cn/sj/zxfb/article.html', originalUnit: '吨', refresh: { kind: 'nbs', url: 'https://www.stats.gov.cn/sj/zxfb/' } } };
  assert.deepEqual(readMaterialSource(formFor(material), material), { ...material.provenance, manual: undefined });
});
test('manually changing a price marks entry method without claiming a new online publication', () => {
  const result = readMaterialSource(formFor(web, { unitPrice: '95' }), web);
  assert.equal(result.manual, true); assert.equal(result.updatedAt, undefined);
  assert.equal(result.priceDate, '2026-11-01'); assert.deepEqual(result.refresh, web.provenance.refresh);
});
test('changing quote authority drops stale table mapping and validates required web URL and calendar date', () => {
  const result = readMaterialSource(formFor(web, { quoteUrl: 'https://other.example/quote' }), web);
  assert.equal(result.manual, true); assert.deepEqual(result.refresh, { kind: 'web', url: 'https://other.example/quote' });
  for (const patch of [{ quoteUrl: '' }, { quoteUrl: 'javascript:alert(1)' }, { quoteDate: '2026-02-30' }]) assert.throws(() => readMaterialSource(formFor(web, patch), web));
});
test('decimal representation alone does not relabel a previously fetched source as manual', () => {
  assert.deepEqual(readMaterialSource(formFor(web, { unitPrice: '88.6050' }), web), { ...web.provenance, manual: undefined });
});
