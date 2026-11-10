import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.HYDRAULICS_BUILD ? pathToFileURL(resolve(process.env.HYDRAULICS_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { validateHydraulicNetwork, solveHydraulicNetwork, hazenWilliamsHeadLoss, circularManningFlow, circularManningState, networkFromMunicipal, resolveHydraulicSources, hydraulicsToCSV } = await import(new URL('lib/hydraulics.js', root));
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const node = (id, patch = {}) => ({ id, name: id, x: 0, y: 0, elevation: 0, type: 'junction', head: null, demand: 0, ...patch });
const link = (id, from, to, patch = {}) => ({ id, name: id, from, to, length: 1000, diameter: 100, roughness: 120, minorLoss: 0, invertStart: 1, invertEnd: 0, flow: null, ...patch });
const pressure = (nodes, links) => ({ mode: 'pressure', nodes, links });
const gravity = (nodes, links) => ({ mode: 'gravity', nodes, links: links.map(pipe => ({ ...pipe, length: 100, diameter: 300, roughness: .013 })) });
const ready = network => { const result = solveHydraulicNetwork(network); assert.equal(result.status, 'ready', result.messages.join(' ')); assert.equal(result.converged, true); assert.ok(result.maxContinuityError < 1e-5); return result; };

test('Hazen–Williams SI formula gives independent 22.07601862231587m loss for 10L/s through 1000m DN100 C120', () => {
  near(hazenWilliamsHeadLoss(1000, 100, 120, 10), 22.07601862231587, 1e-10);
  near(hazenWilliamsHeadLoss(1000, 100, 120, -10), -22.07601862231587, 1e-10);
  assert.equal(hazenWilliamsHeadLoss(1000, 100, 120, 0), 0);
});

test('single demand pipe solves genuine head and source supply with millimetre-scale energy precision', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 50 }), node('J', { elevation: 10, demand: 10 })], [link('P', 'R', 'J')]));
  near(r.nodes[1].head, 27.92398137768413, 2e-7); near(r.nodes[1].pressureHead, 17.92398137768413, 2e-7);
  near(r.links[0].flow, 10, 1e-6); near(r.nodes[0].supply, 10, 1e-6); assert.ok(r.maxEnergyError < 1e-8);
});

test('reverse link direction reports negative flow without reversing demand or fabricating heads', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'J', 'R')]));
  near(r.links[0].flow, -10, 1e-6); assert.ok(r.links[0].headLoss < 0); near(r.nodes[1].head, 27.92398137768413, 2e-7);
});

test('branch network conserves 10L/s upstream and 6L/s downstream with independently accumulated losses', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 80 }), node('A', { demand: 4 }), node('B', { demand: 6 })], [link('RA', 'R', 'A', { length: 500 }), link('AB', 'A', 'B', { length: 200 })]));
  near(r.links[0].flow, 10, 1e-6); near(r.links[1].flow, 6, 1e-6);
  near(r.nodes[1].head, 80 - 22.07601862231587 / 2, 1e-6);
  near(r.nodes[2].head, r.nodes[1].head - 22.07601862231587 * .2 * Math.pow(.6, 1.852), 1e-6);
});

test('parallel ring network shares flow physically and satisfies continuity and every edge energy equation', () => {
  const n = pressure([node('R', { type: 'reservoir', head: 70 }), node('A', { demand: 4 }), node('B', { demand: 7 }), node('C', { demand: 3 })], [link('RA', 'R', 'A'), link('AB', 'A', 'B'), link('BC', 'B', 'C'), link('CR', 'C', 'R'), link('AC', 'A', 'C', { diameter: 150, length: 800 })]);
  const r = ready(n), heads = new Map(r.nodes.map(row => [row.id, row.head]));
  near(r.nodes[0].supply, 14, 3e-6);
  for (const row of r.links) near(heads.get(row.from) - heads.get(row.to), row.headLoss, 1e-8);
  for (const row of r.nodes.filter(row => row.id !== 'R')) { const out = r.links.filter(link => link.from === row.id).reduce((s, link) => s + link.flow, 0), incoming = r.links.filter(link => link.to === row.id).reduce((s, link) => s + link.flow, 0); near(out - incoming + row.demand, 0, 2e-6); }
});

test('two fixed heads can exchange supply; zero unknown nodes still solve real signed flow', () => {
  const r = ready(pressure([node('High', { type: 'reservoir', head: 50 }), node('Low', { type: 'reservoir', head: 27.92398137768413 })], [link('P', 'High', 'Low')]));
  near(r.links[0].flow, 10); near(r.nodes[0].supply, 10); near(r.nodes[1].supply, -10); assert.equal(r.iterations, 0);
});

test('minor fitting loss joins friction loss in the actual pressure-network solver', () => {
  const n = pressure([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J', { minorLoss: 15 })]), r = ready(n);
  const local = 15 * 8 / (9.80665 * Math.PI ** 2 * .1 ** 4) * .01 ** 2;
  near(r.nodes[1].head, 50 - 22.07601862231587 - local, 2e-6);
});

test('zero confirmed demands produce zero flow and equal supply heads without invented usage', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 50 }), node('J')], [link('P', 'R', 'J')]));
  near(r.links[0].flow, 0); near(r.nodes[1].head, 50); near(r.nodes[0].supply, 0);
});

test('negative pressure is an explicit result warning and does not silently clamp the physical solution', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 10 }), node('J', { elevation: 20, demand: 10 })], [link('P', 'R', 'J')]));
  assert.ok(r.nodes[1].pressureHead < 0); assert.ok(r.warnings.some(message => message.includes('负')));
});

test('each disconnected pressure component needs its own real boundary and reports pending otherwise', () => {
  const n = pressure([node('R', { type: 'reservoir', head: 50 }), node('J'), node('A'), node('B')], [link('RJ', 'R', 'J'), link('AB', 'A', 'B')]);
  const r = solveHydraulicNetwork(n); assert.equal(r.status, 'pending'); assert.ok(r.messages.some(message => message.includes('连通分量'))); assert.equal(r.links[0].flow, null);
});

test('missing demands, inner diameter, roughness, or source head remain pending with no fake numbers', () => {
  const n = pressure([node('R', { type: 'reservoir', head: null }), node('J', { demand: null })], [link('P', 'R', 'J', { diameter: null, roughness: null })]);
  assert.doesNotThrow(() => validateHydraulicNetwork(n)); const r = solveHydraulicNetwork(n); assert.equal(r.status, 'pending'); assert.ok(r.messages.length >= 4); assert.equal(r.nodes[1].head, null);
});

test('node injection is a real negative demand and flows toward the fixed-head reservoir', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: -10 })], [link('P', 'R', 'J')]));
  near(r.links[0].flow, -10, 1e-6); near(r.nodes[1].head, 72.07601862231587, 1e-6);
});

test('Manning full circular flow equals independent DN300 n=.013 S=.01 reference 96.70075853355611 L/s', () => {
  near(circularManningFlow(300, .3, .013, .01), 96.70075853355611, 1e-10);
  near(circularManningFlow(300, .15, .013, .01), 96.70075853355611 / 2, 1e-10);
  const r = circularManningState(300, .013, .01, 96.70075853355611 / 2); near(r.normalDepth, .15, 1e-10); near(r.fillingRatio, .5, 1e-10);
});

test('normal-depth solver uses the shallow free-surface branch and distinguishes full from maximum capacity', () => {
  const r = circularManningState(300, .013, .01, 100); assert.equal(r.capacityExceeded, false); assert.ok(r.maxOpenFlowCapacity > r.fullFlowCapacity); assert.ok(r.normalDepth < .3); near(circularManningFlow(300, r.normalDepth, .013, .01), 100, 1e-8);
  const over = circularManningState(300, .013, .01, 120); assert.equal(over.capacityExceeded, true); assert.equal(over.normalDepth, null); assert.equal(over.velocity, null);
});

test('gravity branches merge and include actual lateral inflow, with outlet total conserved', () => {
  const n = gravity([node('A', { demand: 10 }), node('B', { demand: 20 }), node('C', { demand: 5 }), node('O', { type: 'outfall' })], [link('AC', 'A', 'C'), link('BC', 'B', 'C'), link('CO', 'C', 'O')]);
  const r = ready(n); assert.deepEqual(r.links.map(row => row.flow), [10, 20, 35]); assert.equal(r.nodes.at(-1).supply, 35); near(r.maxContinuityError, 0);
});

test('gravity split requires a user-defined split and rejects an inconsistent assigned-flow balance', () => {
  const n = gravity([node('J', { demand: 30 }), node('O1', { type: 'outfall' }), node('O2', { type: 'outfall' })], [link('A', 'J', 'O1'), link('B', 'J', 'O2')]);
  assert.equal(solveHydraulicNetwork(n).status, 'pending'); n.links[0].flow = 20; n.links[1].flow = 10; const r = ready(n); assert.deepEqual(r.links.map(row => row.flow), [20, 10]);
  n.links[1].flow = 5; const bad = solveHydraulicNetwork(n); assert.equal(bad.status, 'error'); assert.ok(bad.messages[0].includes('不守恒'));
});

test('gravity capacity overload exposes actual flow and capacities while normal depth is unavailable', () => {
  const r = ready(gravity([node('J', { demand: 120 }), node('O', { type: 'outfall' })], [link('P', 'J', 'O')]));
  assert.equal(r.links[0].capacityExceeded, true); assert.equal(r.links[0].normalDepth, null); assert.ok(r.warnings.some(message => message.includes('超过最大'))); assert.equal(r.links[0].flow, 120);
});

test('backfall and directed cycles are detected instead of guessing pressurized or dynamic drainage', () => {
  const n = gravity([node('J', { demand: 20 }), node('O', { type: 'outfall' })], [link('P', 'J', 'O', { invertStart: 0, invertEnd: 1 })]);
  const r = solveHydraulicNetwork(n); assert.equal(r.status, 'error'); assert.equal(r.links[0].normalDepth, null); assert.ok(r.messages[0].includes('反坡'));
  const loop = gravity([node('A'), node('B'), node('O', { type: 'outfall' })], [link('AB', 'A', 'B'), link('BA', 'B', 'A'), link('BO', 'B', 'O')]);
  assert.ok(solveHydraulicNetwork(loop).messages[0].includes('有向回路'));
});

test('gravity zero flow gives zero normal depth; unconfirmed pipe invert data stays pending', () => {
  const n = gravity([node('J'), node('O', { type: 'outfall' })], [link('P', 'J', 'O')]); const r = ready(n); assert.equal(r.links[0].normalDepth, 0); assert.equal(r.links[0].velocity, 0);
  n.links[0].invertStart = null; assert.equal(solveHydraulicNetwork(n).status, 'pending');
});

test('an outfall keeps its explicitly visible local inflow and outlet total includes it exactly once', () => {
  const r = ready(gravity([node('J', { demand: 10 }), node('O', { type: 'outfall', demand: 20 })], [link('P', 'J', 'O')]));
  assert.equal(r.links[0].flow, 10); assert.equal(r.nodes[1].demand, 20); assert.equal(r.nodes[1].supply, 30);
  const missing = gravity([node('J', { demand: 10 }), node('O', { type: 'outfall', demand: null })], [link('P', 'J', 'O')]);
  const pending = solveHydraulicNetwork(missing); assert.equal(pending.status, 'pending'); assert.ok(pending.messages.some(message => message.includes('出口本地')));
});

test('fixed pressure boundaries do not secretly consume an old hidden junction demand', () => {
  const r = ready(pressure([node('R', { type: 'reservoir', head: 50, demand: 999 }), node('J', { demand: 10 })], [link('P', 'R', 'J')]));
  near(r.nodes[0].supply, 10, 1e-6); assert.equal(r.nodes[0].demand, null);
});

test('subnormal roughness or dimensions are rejected before NaN or infinite results can be labelled ready', () => {
  for (const mode of ['pressure', 'gravity']) {
    const n = mode === 'pressure' ? pressure([node('R', { type: 'reservoir', head: 50 }), node('J')], [link('P', 'R', 'J')]) : gravity([node('J', { demand: 10 }), node('O', { type: 'outfall' })], [link('P', 'J', 'O')]);
    for (const key of ['roughness', 'diameter', 'length']) { const bad = structuredClone(n); bad.links[0][key] = 1e-200; assert.throws(() => validateHydraulicNetwork(bad), /0.000001/); assert.throws(() => solveHydraulicNetwork(bad)); }
  }
  assert.throws(() => hazenWilliamsHeadLoss(1000, 100, 1e-200, 0), /范围/);
  assert.throws(() => circularManningState(300, 1e-300, .01, 10), /范围/);
});

test('small circular water depths use stable section math instead of theta-minus-sine cancellation', () => {
  const depth = 1e-12, diameter = .3;
  const asymptote = (4 / 3 * Math.sqrt(diameter) * depth ** 1.5) / .013 * ((2 / 3) * depth) ** (2 / 3) * Math.sqrt(.01) * 1000;
  const flow = circularManningFlow(300, depth, .013, .01); assert.ok(flow > 0 && Number.isFinite(flow)); assert.ok(Math.abs(flow / asymptote - 1) < 1e-7);
});

test('large diameter and low but supported roughness still produce finite validated normal depth and velocity', () => {
  const r = circularManningState(1e7, 1e-6, .01, 10); assert.ok(r.normalDepth > 0); assert.ok(r.velocity > 0); assert.ok(Object.values(r).every(value => typeof value !== 'number' || Number.isFinite(value)));
  near(circularManningFlow(1e7, r.normalDepth, 1e-6, .01), 10, 1e-6);
});

test('a normal-depth target below effective bisection precision returns an error instead of a fake zero velocity', () => {
  const n = gravity([node('J', { demand: 1e-200 }), node('O', { type: 'outfall' })], [link('P', 'J', 'O')]);
  const r = solveHydraulicNetwork(n); assert.equal(r.status, 'error'); assert.ok(r.messages.some(message => message.includes('精度'))); assert.equal(r.links[0].normalDepth, null); assert.equal(r.links[0].velocity, null);
});

const project = () => ({ drawing: { type: 'plan' }, calibration: { metersPerPixel: .01 }, municipalElements: [
  { id: 'p1', name: '支管1', kind: 'pipeline', elevation: -80, points: [{ x: 0, y: 0, z: -80 }, { x: 300, y: 400, z: -80 }] },
  { id: 'p2', name: '支管2', kind: 'pipeline', elevation: -80, points: [{ x: 300, y: 400, z: -80 }, { x: 600, y: 400, z: -80 }] },
] });

test('actual polyline endpoints connect within 1mm XYZ; inner diameter and flow conditions remain unconfirmed', () => {
  const p = project(), n = networkFromMunicipal(p); assert.equal(n.nodes.length, 3); assert.equal(n.links.length, 2); near(n.links[0].length, 5); near(n.links[1].length, 3); assert.equal(n.links[0].to, n.links[1].from); assert.equal(n.links[0].diameter, null); assert.equal(n.links[0].roughness, null); assert.ok(n.nodes.every(node => node.demand === null && node.head === null));
  p.municipalElements[1].points[0].z = -79; assert.equal(networkFromMunicipal(p).nodes.length, 4);
});

test('intermediate line crossings do not fabricate hydraulic junctions and true XYZ length includes vertical legs', () => {
  const p = project(); p.municipalElements = [{ id: 'a', name: 'a', kind: 'pipeline', elevation: 0, points: [{ x: 0, y: 500, z: 0 }, { x: 1000, y: 500, z: 0 }] }, { id: 'b', name: 'b', kind: 'pipeline', elevation: 0, points: [{ x: 500, y: 0, z: 0 }, { x: 500, y: 1000, z: 300 }] }];
  const n = networkFromMunicipal(p); assert.equal(n.nodes.length, 4); near(n.links[1].length, Math.sqrt(109));
});

test('source lengths recompute after interior vertices change, but changed endpoints block stale connectivity', () => {
  const p = project(); p.municipalHydraulics = networkFromMunicipal(p); const original = structuredClone(p.municipalHydraulics);
  p.municipalElements[0].points.splice(1, 0, { x: 0, y: 400, z: -80 }); const updated = resolveHydraulicSources(p); near(updated.links[0].length, 7); assert.equal(updated.links[0].sourceStale, undefined); assert.deepEqual(p.municipalHydraulics, original);
  p.municipalElements[0].points[0].x += 1; const stale = resolveHydraulicSources(p); assert.ok(stale.links[0].sourceStale.includes('端点已改变')); assert.equal(solveHydraulicNetwork(stale).status, 'pending');
});

test('source deletion/uncalibration returns pending instead of keeping old length, and rebuild preserves confirmed values', () => {
  const p = project(), old = networkFromMunicipal(p); old.nodes[0].type = 'reservoir'; old.nodes[0].head = 50; old.nodes[1].demand = 4; old.links[0].diameter = 100; old.links[0].roughness = 120;
  const rebuilt = networkFromMunicipal(p, 'pressure', old); assert.equal(rebuilt.nodes[0].head, 50); assert.equal(rebuilt.nodes[1].demand, 4); assert.equal(rebuilt.links[0].diameter, 100); assert.equal(rebuilt.links[0].roughness, 120);
  p.municipalElements.shift(); const removed = resolveHydraulicSources(p, old); assert.equal(removed.links[0].length, null); assert.ok(removed.links[0].sourceStale.includes('已删除'));
  p.drawing.type = 'image'; p.calibration.metersPerPixel = null; assert.throws(() => networkFromMunicipal(p), /校准/);
});

test('rebuilding a real shared endpoint preserves user-edited hydraulic elevation and boundary data', () => {
  const p = project(), old = networkFromMunicipal(p); old.nodes[1].elevation = 5; old.nodes[1].demand = 7;
  const rebuilt = networkFromMunicipal(p, 'pressure', old); assert.equal(rebuilt.nodes.length, 3); assert.equal(rebuilt.links[0].to, rebuilt.links[1].from);
  assert.equal(rebuilt.nodes.find(node => node.id === old.nodes[1].id).elevation, 5); assert.equal(rebuilt.nodes.find(node => node.id === old.nodes[1].id).demand, 7);
});

test('invalid topology or numerical parameters cannot overwrite valid network data', () => {
  const n = pressure([node('R', { type: 'reservoir', head: 50 }), node('J')], [link('P', 'R', 'J')]);
  for (const change of [n => n.links[0].to = 'missing', n => n.links[0].diameter = 0, n => n.links[0].length = Infinity, n => n.nodes[0].head = NaN, n => n.nodes[1].id = 'R', n => n.links.push(structuredClone(n.links[0]))]) { const bad = structuredClone(n); change(bad); assert.throws(() => validateHydraulicNetwork(bad)); }
});

test('CSV exports current solver quantities and parameters in 23 stable columns, including pending-state messages', () => {
  const n = pressure([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J')]), csv = hydraulicsToCSV(n);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('总水头 m')); for (const row of csv.trim().replace(/^\uFEFF/, '').split('\r\n')) assert.equal(row.split(',').length, 23);
  near(Number(csv.split('\r\n').find(row => row.startsWith('管段,')).split(',')[16]), 22.07601862231587, 1e-7);
  n.links[0].diameter = null; const pending = hydraulicsToCSV(n); assert.ok(pending.includes('pending')); assert.ok(pending.includes('水力内径')); assert.equal(pending.split('\r\n').find(row => row.startsWith('管段,')).split(',')[16], '');
});
