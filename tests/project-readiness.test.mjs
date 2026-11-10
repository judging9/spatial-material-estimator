import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProjectReadiness } from '../static/studio/lib/project-readiness.js';
import { calculateProjectBudget } from '../static/studio/lib/project-budget.js';
import { addLevel, ensureLevels } from '../static/studio/lib/levels.js';
import { createCivilElement } from '../static/studio/lib/civil.js';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createTerrainGrid } from '../static/studio/lib/terrain-authoring.js';

const rect = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }];
const material = (patch = {}) => ({ id: 'material-item', materialId: 'floor', materialName: '地面材料', unit: 'm²',
  quantityMode: 'area', quantity: '0', unitPrice: '20', laborRate: '3', wasteRate: '5', additionalCost: '0', ...patch });
const region = (patch = {}) => ({ id: 'room', name: '房间', points: rect, holes: [], hidden: false,
  items: [material()], additionalCost: '0', ...patch });
const project = (patch = {}) => ({ version: 1, id: 'readiness', name: '工程完成引导', workspaceMode: 'plan',
  drawing: { id: 'plan', type: 'plan', name: '平面', width: 120000, height: 90000, url: 'data:image/png;base64,aA==' },
  calibration: { metersPerPixel: .01 }, regions: [], walls: [], furniture: [], serviceRoutes: [], civilElements: [], municipalElements: [],
  additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, ...patch });
const step = (result, id) => result.steps.find(row => row.id === id);

test('empty project gives truthful ordered scale/design/price/export guidance without completion', () => {
  const p = project({ drawing: null, calibration: { metersPerPixel: null } });
  const result = calculateProjectReadiness(p);
  assert.deepEqual(result.steps.map(row => row.id), ['scale', 'design', 'pricing', 'delivery']);
  assert.equal(result.nextStep.id, 'scale'); assert.equal(result.nextStep.action, 'calibrate');
  assert.equal(result.ready, false); assert.ok(result.steps.every(row => !row.complete));
  assert.ok(result.issues.some(issue => issue.id === 'readiness-design'));
});

test('prepared native drawing without objects advances to editable design instead of a zero-price completion', () => {
  const result = calculateProjectReadiness(project());
  assert.equal(step(result, 'scale').complete, true); assert.equal(step(result, 'design').complete, false);
  assert.equal(result.nextStep.id, 'design'); assert.equal(result.nextStep.action, 'plan'); assert.equal(result.ready, false);
});

test('native drawing type without stored scale does not claim calibration has been completed', () => {
  const result = calculateProjectReadiness(project({ calibration: { metersPerPixel: null }, regions: [region()] }));
  assert.equal(step(result, 'scale').complete, false); assert.equal(result.ready, false);
  assert.equal(result.nextStep.id, 'scale'); assert.equal(step(result, 'pricing').complete, false);
});

test('uploaded drawing must be calibrated and a saved quote cannot bypass real dimensions', () => {
  const p = project({ drawing: { ...project().drawing, type: 'image' }, calibration: { metersPerPixel: null }, regions: [region()] });
  const result = calculateProjectReadiness(p);
  assert.equal(result.ready, false); assert.equal(result.nextStep.id, 'scale'); assert.equal(step(result, 'pricing').complete, false);
  assert.ok(result.issues.some(issue => issue.id === 'readiness-scale' && issue.severity === 'pending'));
});

test('manual piece pricing on an uncalibrated image remains incomplete geometry even when price is valid', () => {
  const p = project({ drawing: { ...project().drawing, type: 'image' }, calibration: { metersPerPixel: null },
    furniture: [{ id: 'chair', name: '椅子', kind: 'chair', position: { x: 100, y: 100 }, width: 50, depth: 50, height: 80,
      rotation: 0, quantity: '1', unitPrice: '100', additionalCost: '0' }] });
  const result = calculateProjectReadiness(p);
  assert.equal(step(result, 'scale').complete, false); assert.equal(result.ready, false);
  assert.equal(result.nextStep.action, 'calibrate');
});

test('valid paid material produces export guidance and preserves project and supplied budget', () => {
  const p = project({ regions: [region()] }), budget = calculateProjectBudget(p);
  const beforeProject = structuredClone(p), beforeBudget = structuredClone(budget), result = calculateProjectReadiness(p, budget);
  assert.equal(result.ready, true); assert.equal(result.nextStep.id, 'delivery'); assert.equal(result.nextStep.action, 'export');
  assert.ok(result.steps.every(row => row.complete)); assert.deepEqual(p, beforeProject); assert.deepEqual(budget, beforeBudget);
});

test('unassigned region stays pending while confirmed zero material price completes pricing', () => {
  const missing = calculateProjectReadiness(project({ regions: [region({ items: [] })] }));
  assert.equal(missing.nextStep.id, 'pricing'); assert.equal(missing.ready, false);
  const zero = calculateProjectReadiness(project({ regions: [region({ items: [material({ unitPrice: '0', laborRate: '0' })] })] }));
  assert.equal(step(zero, 'pricing').complete, true); assert.equal(zero.ready, true);
});

test('Demo notes are attached only to used surfaces and do not pretend prices are blocked', () => {
  const p = project({ regions: [region({ items: [material({ demo: true })],
    ceiling: { enabled: false, items: [material({ id: 'inactive-ceiling', demo: true })], additionalCost: '0' } })],
    materialsSnapshot: [{ id: 'unused', name: 'unused Demo', demo: true }] });
  const result = calculateProjectReadiness(p), demoNotes = result.issues.filter(issue => issue.id.startsWith('readiness-demo-'));
  assert.equal(result.ready, true); assert.equal(demoNotes.length, 1); assert.equal(demoNotes[0].targetType, 'region');
  assert.equal(demoNotes[0].targetId, 'room'); assert.equal(demoNotes[0].severity, 'info');
});

test('inactive floor plan errors are detected and locate the affected floor', () => {
  let p = ensureLevels(project({ regions: [region()], planError: '墙线尚未闭合，请修正端点。' }));
  const badLevel = p.activeLevelId; p = addLevel(p, { name: '二楼' });
  p.regions = [region({ id: 'second-room', items: [material({ id: 'second-item' })] })];
  const result = calculateProjectReadiness(p);
  assert.equal(result.ready, false); assert.equal(step(result, 'design').complete, false);
  assert.ok(result.issues.some(issue => issue.levelId === badLevel && issue.message.includes('墙线尚未闭合')));
});

test('an imported unfinished wall graph is found even if cached planError was omitted', () => {
  const p = project({ walls: [{ id: 'wall-open', start: { x: 300, y: 300 }, end: { x: 500, y: 300 }, thickness: 20,
    items: [material({ id: 'wall-material' })] }] });
  const result = calculateProjectReadiness(p);
  assert.equal(step(result, 'design').complete, false); assert.equal(result.ready, false);
  assert.ok(result.issues.some(issue => issue.id.startsWith('readiness-plan-') && issue.message.includes('未闭合')));
});

test('an unpriced wall draft still directs the user to close its geometry before pricing', () => {
  const result = calculateProjectReadiness(project({ walls: [
    { id: 'draft-wall', start: { x: 300, y: 300 }, end: { x: 500, y: 300 }, thickness: 20 },
  ] }));
  assert.equal(result.nextStep.id, 'design'); assert.equal(result.ready, false);
  assert.ok(result.issues.some(issue => issue.message.includes('未闭合')));
});

test('excluded unfinished decoration does not block a valid civil delivery scope', () => {
  const p = project({ workspaceMode: 'civil', planError: '未闭合的草稿墙线',
    budget: { included: { decoration: false, civil: true, municipal: false } } });
  p.civilElements = [{ ...createCivilElement('column', { x: 500, y: 500 }, p), id: 'civil-column', unitPrice: '100' }];
  const result = calculateProjectReadiness(p);
  assert.equal(result.ready, true); assert.equal(result.issues.some(issue => issue.id.startsWith('readiness-plan-')), false);
});

test('civil steel indicators stay informational and map to the actual element and floor', () => {
  const p = project({ workspaceMode: 'civil' });
  p.civilElements = [{ ...createCivilElement('column', { x: 500, y: 500 }, p), id: 'column', unitPrice: '100',
    rebarMode: 'ratio', rebarRatio: '90', rebarPrice: '5' }];
  const result = calculateProjectReadiness(p), info = result.issues.find(issue => issue.id === 'readiness-rebar-column');
  assert.equal(result.ready, true); assert.equal(info.targetType, 'civil'); assert.equal(info.targetId, 'column');
  assert.equal(info.severity, 'info'); assert.match(info.message, /kg\/m³/);
});

test('concept terrain and river/bridge estimates are explicit nonblocking notes for the included municipal scope', () => {
  const p = project({ workspaceMode: 'municipal' });
  p.municipalTerrain = createTerrainGrid({ width: 20, length: 20, cellSize: 2, baseElevation: 0, relief: 0, preset: 'flat' });
  p.municipalElements = [
    { ...createMunicipalElement('river', [{ x: 5000, y: 10000 }, { x: 15000, y: 10000 }], p), id: 'river', unitPrice: '1' },
    { ...createMunicipalElement('bridge', [{ x: 10000, y: 9000 }, { x: 10000, y: 11000 }], p), id: 'bridge', unitPrice: '10',
      bridgeOptions: { pierSpacing: 800, pierHeight: 500, railingHeight: 120, pierPricingEnabled: false, railingPricingEnabled: false } },
  ];
  const result = calculateProjectReadiness(p);
  assert.equal(result.ready, true);
  for (const id of ['readiness-terrain', 'readiness-municipal-river', 'readiness-municipal-bridge'])
    assert.equal(result.issues.find(issue => issue.id === id)?.severity, 'info');
});

test('excluding all existing professionals advances to scope selection without false zero total completion', () => {
  const p = project({ regions: [region()], budget: { included: { decoration: false, civil: false, municipal: false } } });
  const result = calculateProjectReadiness(p);
  assert.equal(step(result, 'design').complete, true); assert.equal(result.nextStep.id, 'pricing');
  assert.match(result.nextStep.description, /至少选择/); assert.equal(result.ready, false);
});
