import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.MATERIAL_PRICE_REFRESH_BUILD ? pathToFileURL(resolve(process.env.MATERIAL_PRICE_REFRESH_BUILD) + '/lib/') : new URL('../static/studio/lib/', import.meta.url);
const { inferPriceTableMapping, normalizeMaterialRefreshSource, savedMaterialPriceSource, readSavedMaterialPrices, applySavedMaterialPrices } = await import(new URL('material-price-refresh.js', modules));
const { normalizePriceRows, applyPriceRows } = await import(new URL('material-prices.js', modules));
const { calculateProject } = await import(new URL('pricing.js', modules));
const { createMaterialSnapshot } = await import(new URL('materials.js', modules));

// Deterministic upstream response fixtures. Network results in the product
// come from the real read-only preview endpoints, not these test fixtures.
const webURL = 'https://supplier.example/prices';
const nbsURL = 'https://www.stats.gov.cn/sj/zxfb/202611/t20261101_123.html';
const material = (patch = {}) => ({ id: 'tile', name: '项目瓷砖', unit: 'm²', unitPrice: '100', wasteRate: '8', category: '地面', image: '', color: '#88aa99', description: '用户备注', demo: false,
  provenance: { materialName: '瓷砖', spec: '600x600', source: '当地供应商', sourceUrl: webURL, region: '杭州', supplier: '实际厂家', priceDate: '2026-10-31', originalUnit: '平方米', refresh: { kind: 'web', url: webURL, tableIndex: 2, mapping: { name: 0, unit: 1, price: 2, spec: 3, date: 4, supplier: 5, region: 6, source: 7 }, hasHeader: true } }, ...patch });
const official = (patch = {}) => material({ id: 'steel', name: '用户钢材', unit: '吨', provenance: { materialName: '螺纹钢', spec: 'HRB400E', source: '国家统计局·流通领域重要生产资料', sourceUrl: nbsURL, region: '全国', supplier: '', priceDate: '2026-10-31', refresh: { kind: 'nbs', url: 'https://www.stats.gov.cn/sj/zxfb/' } }, ...patch });
const row = (patch = {}) => ({ name: '瓷砖', unit: '平方米', price: '88.605', spec: '600x600', price_date: '2026-11-01', source: '当地供应商', region: '杭州', supplier: '实际厂家', ...patch });
const fetchRows = (rows, calls = [], url = webURL) => async (path, init) => { calls.push({ path, payload: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, data: { url, rows } }) }; };

test('standard table headers are mapped explicitly without guessing missing or duplicate fields', () => {
  assert.deepEqual(inferPriceTableMapping(['名称', '规格', '单位', '单价', '报价日期', '供应商', '地区', '来源']), { name: 0, unit: 2, price: 3, spec: 1, date: 4, supplier: 5, region: 6, source: 7 });
  assert.equal(inferPriceTableMapping(['名称', '金额']), null);
  assert.equal(inferPriceTableMapping(['名称', '单位', '单价', '价格']), null);
  assert.equal(inferPriceTableMapping(['模糊产品字段', 'm²', '100']), null);
});

test('source configuration validates its authority, table and independent integer columns', () => {
  assert.deepEqual(normalizeMaterialRefreshSource({ kind: 'web', url: webURL + '#table', mapping: { name: 0, unit: 1, price: 2, spec: -1 } }), { kind: 'web', url: webURL, mapping: { name: 0, unit: 1, price: 2 }, tableIndex: 0, hasHeader: true });
  for (const invalid of [{ kind: 'web', url: 'javascript:alert(1)' }, { kind: 'web', url: 'https://user:secret@example.com' }, { kind: 'nbs', url: webURL }, { kind: 'web', url: webURL, tableIndex: 101 }, { kind: 'web', url: webURL, mapping: { name: 0, unit: 1, price: -1 } }, { kind: 'web', url: webURL, mapping: { name: 0, unit: 1, price: 1 } }, { kind: 'web', url: webURL, mapping: { name: '0', unit: 1, price: 2 } }]) assert.throws(() => normalizeMaterialRefreshSource(invalid));
});

test('Demo, manual and local file prices cannot silently acquire a fabricated online rate', async () => {
  const demo = material({ demo: true, provenance: undefined }), manual = material({ id: 'manual', provenance: { source: '手工录入' } }), prior = structuredClone([demo, manual]);
  let calls = 0;
  const entries = await readSavedMaterialPrices(prior, { fetcher: async () => { calls++; throw new Error('should not fetch'); } });
  assert.equal(calls, 0); assert.ok(entries.every(entry => entry.state === 'unavailable'));
  assert.match(entries[0].reason, /Demo/); assert.deepEqual([demo, manual], prior);
  assert.throws(() => applySavedMaterialPrices(prior, entries, ['tile']));
});

test('a legacy official source is recognized while official quotes cannot overwrite local-region prices', () => {
  const legacy = official(); delete legacy.provenance.refresh;
  assert.equal(savedMaterialPriceSource(legacy).source.kind, 'nbs');
  legacy.provenance.region = '杭州'; assert.equal(savedMaterialPriceSource(legacy).eligible, false);
  assert.equal(savedMaterialPriceSource(material({ provenance: { source: '当地供应商', sourceUrl: 'file:///prices.csv' } })).eligible, false);
});

test('official materials share one genuine latest-preview request and retain exact source units', async () => {
  const one = official(), two = official({ id: 'copper', provenance: { ...official().provenance, materialName: '电解铜', spec: '1#' } }), calls = [];
  const entries = await readSavedMaterialPrices([one, two], { fetcher: fetchRows([row({ name: '螺纹钢', unit: '吨', spec: 'HRB400E', region: '全国', supplier: '', source: '国家统计局', price: '3450.12' }), row({ name: '电解铜', unit: '吨', spec: '1#', region: '全国', supplier: '', source: '国家统计局', price: '71000.5' })], calls, nbsURL) });
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/scrape/nbs/preview'); assert.deepEqual(calls[0].payload, {});
  assert.ok(entries.every(entry => entry.state === 'ready'));
  const next = applySavedMaterialPrices([one, two], entries, ['steel', 'copper'], '2026-11-02T00:00:00Z');
  assert.equal(next[0].unitPrice, '3450.12'); assert.equal(next[1].unitPrice, '71000.5'); assert.equal(next[0].unit, '吨');
  assert.equal(next[0].provenance.sourceUrl, nbsURL); assert.equal(next[0].provenance.updatedAt, '2026-11-02T00:00:00Z');
});

test('saved website mapping is used completely and price updates preserve other material properties', async () => {
  const original = material(), before = structuredClone(original), calls = [];
  const entries = await readSavedMaterialPrices([original], { fetcher: fetchRows([row()], calls) });
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/scrape/rows/preview');
  assert.deepEqual(calls[0].payload.mapping, original.provenance.refresh.mapping); assert.equal(calls[0].payload.table_index, 2);
  assert.equal(entries[0].state, 'ready'); assert.equal(entries[0].candidate.unitPrice, '88.605');
  const next = applySavedMaterialPrices([original], entries, ['tile'], '2026-11-02T00:00:00Z')[0];
  assert.deepEqual(original, before); assert.equal(next.unitPrice, '88.605'); assert.equal(next.wasteRate, '8');
  for (const key of ['id', 'name', 'image', 'category', 'color', 'description', 'unit']) assert.equal(next[key], original[key]);
  assert.equal(next.provenance.priceDate, '2026-11-01'); assert.equal(next.provenance.materialName, '瓷砖');
});

test('an equal rate with a newer date is still an explicit metadata refresh; zero is a valid source rate', async () => {
  const original = material(), entries = await readSavedMaterialPrices([original], { fetcher: fetchRows([row({ price: '100.00' })]) });
  assert.equal(entries[0].changed, false);
  const next = applySavedMaterialPrices([original], entries, ['tile'])[0]; assert.equal(next.unitPrice, '100'); assert.equal(next.provenance.priceDate, '2026-11-01');
  const zero = await readSavedMaterialPrices([original], { fetcher: fetchRows([row({ price: '0' })]) });
  assert.equal(zero[0].state, 'ready'); assert.equal(applySavedMaterialPrices([original], zero, ['tile'])[0].unitPrice, '0');
});

for (const [label, patch] of Object.entries({ name: { name: '瓷砖近似名称' }, spec: { spec: '800x800' }, unit: { unit: '吨' }, region: { region: '宁波' }, supplier: { supplier: '其他厂家' }, source: { source: '另一供应商' } })) test(`refresh rejects a mismatched ${label} instead of substituting another material quote`, async () => {
  const original = material(), entries = await readSavedMaterialPrices([original], { fetcher: fetchRows([row(patch)]) });
  assert.equal(entries[0].state, 'failed'); assert.match(entries[0].reason, /完全一致/);
  assert.throws(() => applySavedMaterialPrices([original], entries, ['tile'])); assert.equal(original.unitPrice, '100');
});

test('duplicate matching quotations require explicit resolution and stale source periods are rejected', async () => {
  const original = material(), duplicate = await readSavedMaterialPrices([original], { fetcher: fetchRows([row(), row({ price: '91' })]) });
  assert.equal(duplicate[0].state, 'failed'); assert.match(duplicate[0].reason, /多条/);
  const older = await readSavedMaterialPrices([original], { fetcher: fetchRows([row({ price_date: '2026-10-01' })]) });
  assert.equal(older[0].state, 'failed'); assert.match(older[0].reason, /早于/);
});

test('unknown source dates never reuse the old quote date or an import collection date', async () => {
  const original = material(), entries = await readSavedMaterialPrices([original], { fetcher: fetchRows([row({ price_date: '2026-11-02', date_provided: false })]) });
  assert.equal(entries[0].state, 'ready'); assert.equal(entries[0].candidate.priceDate, ''); assert.match(entries[0].reason, /未提供报价日期/);
  const next = applySavedMaterialPrices([original], entries, ['tile'])[0]; assert.equal(next.provenance.priceDate, undefined); assert.equal(original.provenance.priceDate, '2026-10-31');
});

test('unmapped sources inspect real headers and persist the confirmed standard mapping', async () => {
  const original = material(); delete original.provenance.refresh; const calls = [];
  const entries = await readSavedMaterialPrices([original], { fetcher: async (path, init) => {
    calls.push({ path, payload: JSON.parse(init.body) });
    const data = path === '/api/scrape/preview' ? { url: webURL, tables: [{ index: 1, sample: [['名称', '单位', '价格', '规格', '日期', '供应商', '地区', '来源']] }] } : { url: webURL, rows: [row()] };
    return { ok: true, json: async () => ({ ok: true, data }) };
  } });
  assert.deepEqual(calls.map(call => call.path), ['/api/scrape/preview', '/api/scrape/rows/preview']);
  assert.equal(calls[1].payload.table_index, 1); assert.equal(entries[0].state, 'ready');
  const next = applySavedMaterialPrices([original], entries, ['tile'])[0]; assert.equal(next.provenance.refresh.tableIndex, 1); assert.equal(next.provenance.refresh.mapping.price, 2);
});

test('multiple or unrecognized website tables require a mapping instead of an assumed first table', async () => {
  for (const tables of [[{ index: 0, sample: [['名称', '单位', '价格']] }, { index: 1, sample: [['名称', '单位', '单价']] }], [{ index: 0, sample: [['不明字段', '数值']] }]]) {
    const original = material(); delete original.provenance.refresh; let calls = 0;
    const entries = await readSavedMaterialPrices([original], { fetcher: async () => { calls++; return { ok: true, json: async () => ({ ok: true, data: { url: webURL, tables } }) }; } });
    assert.equal(calls, 1); assert.equal(entries[0].state, 'failed');
  }
});

test('network failures and returned source mismatches retain the original rate', async () => {
  const original = material(), before = structuredClone(original);
  const failed = await readSavedMaterialPrices([original], { fetcher: async () => { throw new Error('actual network failure'); } });
  assert.match(failed[0].reason, /actual network failure/); assert.equal(failed[0].state, 'failed');
  const wrong = await readSavedMaterialPrices([original], { fetcher: fetchRows([row()], [], 'https://another.example/prices') });
  assert.equal(wrong[0].state, 'failed'); assert.match(wrong[0].reason, /来源不一致/); assert.deepEqual(original, before);
});

test('aborted refreshes never continue upstream or yield commit-ready rows', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(readSavedMaterialPrices([material()], { signal: controller.signal, fetcher: async () => { calls++; throw new Error('not called'); } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const pending = new AbortController();
  await assert.rejects(readSavedMaterialPrices([material()], { signal: pending.signal, fetcher: async () => { pending.abort(); return { ok: true, json: async () => ({ ok: true, data: { url: webURL, rows: [row()] } }) }; } }), { name: 'AbortError' });
});

test('only selected rows can apply and a source or rate changed while reading requires a new preview', async () => {
  const one = material(), two = material({ id: 'other' }), originals = [one, two], before = structuredClone(originals);
  const entries = await readSavedMaterialPrices(originals, { materialIds: ['tile'], fetcher: fetchRows([row()]) });
  assert.equal(entries.length, 1); assert.deepEqual(applySavedMaterialPrices(originals, entries, ['tile'])[1], two);
  assert.throws(() => applySavedMaterialPrices(originals, entries, ['tile', 'tile']), /重复/);
  for (const changed of [material({ unitPrice: '120' }), material({ provenance: { ...one.provenance, source: '另一来源' } })]) assert.throws(() => applySavedMaterialPrices([changed], entries, ['tile']), /已更新/);
  await assert.rejects(readSavedMaterialPrices(originals, { materialIds: ['missing'] }), /不存在/); assert.deepEqual(originals, before);
});

test('tampered preview prices, dates and original units are validated again before applying', async () => {
  const original = material(), entries = await readSavedMaterialPrices([original], { fetcher: fetchRows([row()]) });
  for (const patch of [{ unitPrice: '-1' }, { unitPrice: '' }, { priceDate: '2026-02-30' }, { originalUnit: '吨' }]) {
    const tampered = structuredClone(entries); Object.assign(tampered[0].candidate, patch);
    assert.throws(() => applySavedMaterialPrices([original], tampered, ['tile']));
  }
  assert.equal(original.unitPrice, '100');
});

test('imported table mapping survives material normalization and refreshed decimal prices drive real quote math', async () => {
  const refresh = material().provenance.refresh, candidates = normalizePriceRows([row()], { sourceUrl: webURL, refresh }).candidates;
  const imported = applyPriceRows([], candidates, [{ id: '0' }]); assert.deepEqual(imported[0].provenance.refresh.mapping, refresh.mapping);
  const entries = await readSavedMaterialPrices(imported, { fetcher: fetchRows([row({ price: '12.345', price_date: '2026-11-02' })]) });
  const next = applySavedMaterialPrices(imported, entries, [imported[0].id]);
  const item = createMaterialSnapshot(next[0], { quantityMode: 'manual', quantity: '3', wasteRate: '10', laborRate: '2' });
  const quote = calculateProject({ id: 'exact-source-cost', regions: [{ id: 'area', name: '实际用量', points: [], holes: [], items: [item] }], calibration: { metersPerPixel: null } });
  assert.equal(quote.total, '46.74'); assert.equal(quote.regions[0].items[0].materialCost, '40.74'); assert.equal(quote.regions[0].items[0].laborCost, '6.00');
});
