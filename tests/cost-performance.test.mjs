import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { calculateStructureItems, calculateStructureModel } from '../build/studio/lib/structure.js';
import { buildFinishModel, calculateFinish } from '../build/studio/lib/finish.js';
import { defaultMunicipalConfig, generateMunicipalItems } from '../build/studio/lib/municipal.js';
import { summarize, validateItems } from '../build/studio/lib/cost.js';
import { costToCSV, renderCostReport } from '../build/studio/lib/cost-export.js';

function sharedDisciplineProject() {
  const municipal = defaultMunicipalConfig();
  municipal.road.length = 1000;
  municipal.road.points = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 1000, y: 0 }];
  const wall = (id, start, end) => ({ id, start, end, thickness: 20, height: 280 });
  const regions = Array.from({ length: 100 }, (_, index) => {
    const x = (index % 10) * 420 + 10, y = Math.floor(index / 10) * 320 + 10;
    return {
      id: `actual-room-${index}`, name: index % 10 === 0 ? `卫生间 ${index}` : `卧室 ${index}`,
      source: 'walls', points: [{ x, y }, { x: x + 400, y }, { x: x + 400, y: y + 300 }, { x, y: y + 300 }],
      holes: [], hidden: false, items: [], additionalCost: '0',
    };
  });
  const walls = [
    ...Array.from({ length: 11 }, (_, index) => wall(`vertical-${index}`, { x: index * 420, y: 0 }, { x: index * 420, y: 3200 })),
    ...Array.from({ length: 11 }, (_, index) => wall(`horizontal-${index}`, { x: 0, y: index * 320 }, { x: 4200, y: index * 320 })),
  ];
  return {
    version: 1, id: 'three-discipline-performance', name: '100 房间与 1000 m 道路',
    drawing: { id: 'generated-plan', name: '实际墙体户型', type: 'plan', width: 4200, height: 3200, url: '' },
    calibration: { metersPerPixel: .01 }, regions, walls, openings: [],
    wallHeight: 280, wallThickness: 20, additionalCost: '0', taxRate: '0',
    cost: {
      rates: { measureRate: '2.5', taxRate: '9' }, otherCost: '1500',
      modules: {
        structure: { enabled: true, config: { footprintSource: 'auto', floors: 1, gridX: 10, gridY: 10 } },
        finish: { enabled: true, config: { ceiling: true } },
        municipal: { enabled: true, config: municipal },
      },
    },
  };
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

test('three disciplines measure 100 actual shared-wall rooms and 1000 m road in under 300 ms', () => {
  const value = sharedDisciplineProject(), before = structuredClone(value);
  freezeTree(value);
  const started = performance.now();
  const structure = calculateStructureItems(value), structureAt = performance.now();
  const finish = calculateFinish(value), finishAt = performance.now();
  const municipal = generateMunicipalItems(value), municipalAt = performance.now();
  const all = [...structure, ...finish, ...municipal];
  const checked = validateItems(all);
  const summary = summarize(all, { ...value.cost.rates, otherAmount: value.cost.otherCost });
  const finished = performance.now(), elapsed = finished - started;
  console.log(`three-discipline cold calculation: ${elapsed.toFixed(3)} ms; ` +
    `structure ${(structureAt - started).toFixed(3)} ms / ${structure.length} rows; ` +
    `finish ${(finishAt - structureAt).toFixed(3)} ms / ${finish.length} rows; ` +
    `municipal ${(municipalAt - finishAt).toFixed(3)} ms / ${municipal.length} rows; ` +
    `validation and totals ${(finished - municipalAt).toFixed(3)} ms; ${all.length} total rows`);

  assert.ok(elapsed < 300, `三专业实际计量、价格生成、校验与汇总 ${elapsed.toFixed(3)} ms，应 <300 ms`);
  assert.deepEqual(value, before, 'pure module functions must not mutate project, geometry or configurations');
  assert.equal(checked.ok, true, checked.errors.join('; '));
  assert.equal(new Set(all.map(line => line.id)).size, all.length);
  assert.equal(new Set(all.map(line => line.code)).size, all.length);
  assert.ok(all.every(line => /^\d{12}$/.test(line.code)));
  for (const section of ['土建', '装饰装修', '市政']) assert.ok(all.some(line => line.section === section));
  assert.equal(finish.filter(line => line.id.endsWith(':floor-level')).length, 100);
  assert.equal(municipal.find(line => line.id === 'municipal:rain-pipe').quantity, '1000');
  assert.equal(municipal.find(line => line.id === 'municipal:sewer-pipe').quantity, '1000');

  const model = buildFinishModel(value);
  assert.equal(model.rooms.length, 100);
  for (const room of model.rooms) {
    assert.ok(Math.abs(room.netArea - 12) < 1e-8);
    assert.ok(Math.abs(room.wallArea - 39.2) < 1e-8);
    assert.equal(room.wallEstimate, false, 'performance fixture must use actual wall geometry');
  }
  const structuralModel = calculateStructureModel(value, value.cost.modules.structure.config);
  assert.equal(structuralModel.footprint.source, 'plan');
  assert.ok(structuralModel.footprint.area > 1200, 'structural footprint also includes actual wall occupancy');
  assert.deepEqual(calculateStructureItems(value), structure);
  assert.deepEqual(calculateFinish(value), finish);
  assert.deepEqual(generateMunicipalItems(value), municipal);
  assert.deepEqual(value, before);

  const csv = costToCSV(all, summary, { name: value.name });
  // This fixture contains no embedded newlines; every exported item must have
  // one row, followed by the seven complete shared summary rows.
  assert.equal(csv.split('\r\n').filter(Boolean).length, all.length + 1 + 7);
  for (const line of all) assert.ok(csv.includes(`"${line.code}"`));
  const html = renderCostReport(all, summary, { name: value.name });
  assert.equal((html.match(/<tbody>/g) ?? []).length, 3);
  assert.equal((html.match(/<tr>/g) ?? []).length, all.length + 3);
  assert.ok(html.includes(`¥ ${summary.total}`));
  assert.ok(summary.missingPriceCount > 0);
  assert.match(html, /已定价部分含税小计/);
});
