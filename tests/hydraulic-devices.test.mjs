import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.HYDRAULICS_BUILD ? pathToFileURL(resolve(process.env.HYDRAULICS_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { solveHydraulicNetwork, validateHydraulicNetwork, hydraulicsToCSV, networkFromMunicipal } = await import(new URL('lib/hydraulics.js', root));
const { pumpHeadAtFlow } = await import(new URL('lib/hydraulic-devices.js', root));
const { simulateHydraulicNetwork, simulationToCSV } = await import(new URL('lib/hydraulic-simulation.js', root));
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const node = (id, patch = {}) => ({ id, name: id, x: 0, y: 0, elevation: 0, type: 'junction', head: null, demand: 0, ...patch });
const link = (id, from, to, patch = {}) => ({ id, name: id, from, to, length: 1000, diameter: 100, roughness: 120, minorLoss: 0, ...patch });
const network = (nodes, links) => ({ mode: 'pressure', nodes, links });
const pump = (patch = {}) => ({ enabled: true, curve: [{ flow: 0, head: 30 }, { flow: 20, head: 10 }], ...patch });
const ready = n => { const r = solveHydraulicNetwork(n); assert.equal(r.status, 'ready', r.messages.join(' ')); return r; };
const tank = (id, patch = {}) => node(id, { type: 'tank', elevation: 10, tank: { area: 100, minLevel: 1, maxLevel: 6, initialLevel: 5 }, ...patch });
const drain = () => network([tank('T', { demand: 2 }), node('J', { demand: 10 })], [link('P', 'T', 'J')]);
const settings = (patch = {}) => ({ duration: 600, step: 60, events: [], ...patch });
test('pump curve interpolates real user points and refuses extrapolation or invalid ordering', () => {
  near(pumpHeadAtFlow(pump(), 10).head, 20); near(pumpHeadAtFlow(pump(), 10).slope, -1);
  assert.throws(() => pumpHeadAtFlow(pump(), 21), /禁止外推/);
  assert.throws(() => pumpHeadAtFlow(pump({ curve: [{ flow: 0, head: 20 }, { flow: 5, head: 30 }] }), 2), /不得递增/);
});
test('pump adds independently interpolated 20m head at demand10L/s, preserving pipe loss and energy', () => {
  const r = ready(network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J', { pump: pump() })]));
  near(r.links[0].flow, 10); near(r.links[0].headLoss, 22.07601862231587); near(r.links[0].pumpHeadGain, 20);
  near(r.nodes[1].head, 47.92398137768413); assert.ok(r.maxEnergyError < 1e-8); assert.equal(r.links[0].deviceState, 'pump-running');
});
test('low but valid forward pump demand converges within the real curve instead of crossing shutoff and isolating', () => {
  for (const demand of [.001, 1, 5, 19.99]) {
    const r = ready(network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand })], [link('P', 'R', 'J', { pump: pump() })]));
    near(r.links[0].flow, demand, 1e-8); near(r.links[0].pumpHeadGain, 30 - demand, 1e-8); near(r.nodes[1].head, 50 + 30 - demand - 22.07601862231587 * (demand / 10) ** 1.852, 1e-7);
  }
});
test('pump demand beyond supplied curve stays pending instead of extrapolating', () => {
  const r = solveHydraulicNetwork(network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 30 })], [link('P', 'R', 'J', { pump: pump() })]));
  assert.equal(r.status, 'pending'); assert.equal(r.links[0].flow, null);
});
test('boundary-imposed pump operating point beyond supplied curve stays pending', () => {
  const r = solveHydraulicNetwork(network([node('R', { type: 'reservoir', head: 500 }), node('S', { type: 'reservoir', head: 0 })], [link('P', 'R', 'S', { pump: pump() })]));
  assert.equal(r.status, 'pending'); assert.ok(r.messages.join().includes('曲线'));
});
test('stopped pump or closed valve isolates a demand component and cannot fabricate its head', () => {
  for (const device of [{ pump: pump({ enabled: false }) }, { valve: { open: false, lossCoefficient: 5 } }, { status: 'closed' }]) {
    const r = solveHydraulicNetwork(network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J', device)]));
    assert.equal(r.status, 'pending'); assert.equal(r.nodes[1].head, null);
  }
});
test('closed passive pipe between two fixed boundaries has zero flow without forcing equal heads', () => {
  const r = ready(network([node('R', { type: 'reservoir', head: 50 }), node('S', { type: 'reservoir', head: 5 })], [link('P', 'R', 'S', { status: 'closed' })]));
  assert.equal(r.links[0].flow, 0); assert.equal(r.links[0].deviceState, 'closed'); near(r.maxEnergyError, 0);
});
test('check valve blocks reverse pressure and preserves complementarity without fake energy loss', () => {
  const r = ready(network([node('R', { type: 'reservoir', head: 5 }), node('S', { type: 'reservoir', head: 50 })], [link('P', 'R', 'S', { checkValve: true })]));
  near(r.links[0].flow, 0); assert.equal(r.links[0].deviceState, 'check-closed'); near(r.maxEnergyError, 0);
});
test('pump-fed ring closes a reverse bypass check valve, then stopped pump allows a real alternate supply path', () => {
  const n = network([node('R', { type: 'reservoir', head: 70 }), node('A', { demand: 1 }), node('B', { demand: 3 })], [link('pump', 'R', 'A', { pump: pump() }), link('AB', 'A', 'B', { length: 300 }), link('bypass', 'R', 'B', { checkValve: true })]);
  const running = ready(n); near(running.links[0].flow, 4); near(running.links[1].flow, 3); near(running.links[2].flow, 0); assert.equal(running.links[2].deviceState, 'check-closed'); assert.ok(running.maxEnergyError < 1e-8);
  n.links[0].pump.enabled = false; const stopped = ready(n); near(stopped.links[0].flow, 0); near(stopped.links[1].flow, -1); near(stopped.links[2].flow, 4); assert.ok(stopped.maxContinuityError < 1e-7);
});
test('wrong check valve direction cannot supply positive demand', () => {
  const r = solveHydraulicNetwork(network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'J', 'R', { checkValve: true })]));
  assert.equal(r.status, 'pending'); assert.equal(r.links[0].flow, null);
});
test('throttle K adds exact local loss and edits update head with same conserved flow', () => {
  const n = network([node('R', { type: 'reservoir', head: 100 }), node('J', { demand: 10 })], [link('P', 'R', 'J', { minorLoss: 3, valve: { open: true, lossCoefficient: 12 } })]);
  const a = ready(n), extra = 15 * 8 / (9.80665 * Math.PI ** 2 * .1 ** 4) * .01 ** 2;
  near(a.links[0].headLoss, 22.07601862231587 + extra); n.links[0].valve.lossCoefficient = 24; const b = ready(n);
  near(b.links[0].flow, 10); assert.ok(b.nodes[1].head < a.nodes[1].head);
});
test('tank steady head is bottom plus initial level and local demand remains explicit', () => {
  const r = ready(drain()); near(r.nodes[0].head, 15); near(r.nodes[0].pressureHead, 5); near(r.nodes[0].supply, 10); near(r.nodes[0].demand, 2);
  const n = drain(); n.nodes[0].demand = null; assert.equal(solveHydraulicNetwork(n).status, 'pending');
});
test('draft pump/tank fields save structurally but do not produce fake calculations', () => {
  const n = drain(); n.nodes[0].tank.area = null; n.links[0].pump = pump({ curve: [{ flow: 0, head: null }] });
  assert.doesNotThrow(() => validateHydraulicNetwork(n)); assert.equal(solveHydraulicNetwork(n).status, 'pending');
  n.nodes[0].tank.area = -1; assert.throws(() => validateHydraulicNetwork(n));
});
test('tank drains by exact integrated 12L/s including local demand and global mass is conserved', () => {
  const r = simulateHydraulicNetwork(drain(), settings()); assert.equal(r.status, 'ready', r.messages.join());
  near(r.frames.at(-1).tanks[0].level, 4.928, 1e-9); near(r.frames.at(-1).demandVolume, 7.2, 1e-9);
  near(r.frames.at(-1).storageChange, -7.2, 1e-9); near(r.maxMassBalanceError, 0, 1e-9);
});
test('negative-pressure time warnings summarize the independently known minimum and its true time once per node', () => {
  const r = simulateHydraulicNetwork(drain(), settings()); assert.equal(r.status, 'ready');
  assert.equal(r.warnings.length, 1); const match = r.warnings[0].match(/最低压力水头 (-?[\d.]+) m，发生在 ([\d.]+) 秒/); assert.ok(match);
  near(Number(match[1]), 10 + 5 - .012 * 600 / 100 - 22.07601862231587, 5e-7); near(Number(match[2]), 600, 1e-9);
  assert.ok(r.frames.every(frame => frame.result.warnings.length === 1)); near(r.maxMassBalanceError, 0, 1e-9);
});
test('exact-time demand event integrates old and new demands once and records new conditions at event', () => {
  const r = simulateHydraulicNetwork(drain(), settings({ events: [{ id: 'e', time: 300, targetId: 'J', kind: 'demand', value: 20 }] }));
  assert.equal(r.status, 'ready', r.messages.join()); near(r.frames.at(-1).tanks[0].level, 4.898, 1e-9);
  near(r.frames.find(frame => frame.time === 300).result.links[0].flow, 20); near(r.frames.at(-1).demandVolume, 10.2, 1e-9); near(r.maxMassBalanceError, 0, 1e-8);
});
test('time0 pump activation precedes initial feasibility check', () => {
  const n = network([node('R', { type: 'reservoir', head: null }), node('J', { demand: 10 })], [link('P', 'R', 'J', { pump: pump({ enabled: false }) })]);
  const r = simulateHydraulicNetwork(n, settings({ events: [{ id: 'p', time: 0, targetId: 'P', kind: 'pump', value: true }, { id: 'h', time: 0, targetId: 'R', kind: 'head', value: 50 }] }));
  assert.equal(r.status, 'ready', r.messages.join()); near(r.frames[0].result.links[0].flow, 10);
});
test('empty tank stops at solved boundary time without clamping storage or losing mass', () => {
  const r = simulateHydraulicNetwork(drain(), settings({ duration: 60000, step: 1000 })); assert.equal(r.status, 'stopped', r.messages.join());
  near(r.completedTime, 100 * (5 - 1) / .012, 1e-6); near(r.frames.at(-1).tanks[0].level, 1, 1e-10); near(r.frames.at(-1).storageChange, -400, 1e-8); near(r.maxMassBalanceError, 0, 1e-7); assert.equal(r.stop.bound, 'min');
});
test('filling tank stops at max boundary, handling local injection as real volume', () => {
  const n = network([tank('T', { demand: -10, tank: { area: 1, minLevel: 0, maxLevel: 3, initialLevel: 2 } }), node('J')], [link('P', 'T', 'J')]);
  const r = simulateHydraulicNetwork(n, settings()); assert.equal(r.status, 'stopped', r.messages.join()); near(r.completedTime, 100, 1e-7); near(r.frames.at(-1).tanks[0].volume, 3, 1e-9); near(r.maxMassBalanceError, 0, 1e-9); assert.equal(r.stop.bound, 'max');
});
test('nonzero subnanosecond event interval still integrates real storage', () => {
  const n = drain(); n.nodes[0].tank = { area: .001, minLevel: 0, maxLevel: 2, initialLevel: 1 }; n.nodes[0].demand = 0;
  const r = simulateHydraulicNetwork(n, settings({ duration: .001, step: .001, events: [{ id: 'e', time: 1e-9, targetId: 'J', kind: 'demand', value: 0 }] }));
  assert.equal(r.status, 'ready', r.messages.join()); near(r.frames.at(-1).storageChange, -1e-11, 1e-14); near(r.frames.at(-1).demandVolume, 1e-11, 1e-14); assert.ok(r.frames.some(frame => frame.time === 1e-9));
});
test('pump stop event pauses invalid downstream service at exact event time instead of fake flow', () => {
  const n = network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J', { pump: pump() })]);
  const r = simulateHydraulicNetwork(n, settings({ events: [{ id: 'e', time: 300, targetId: 'P', kind: 'pump', value: false }] }));
  assert.equal(r.status, 'pending'); near(r.completedTime, 300); assert.ok(r.messages.join().includes('暂停'));
});
test('invalid events, gravity mode, stale source and missing settings remain pending', () => {
  for (const patch of [{ events: [{ id: 'e', time: 3, targetId: 'deleted', kind: 'pump', value: true }] }, { duration: null }]) assert.equal(simulateHydraulicNetwork(drain(), settings(patch)).status, 'pending');
  const n = drain(); n.links[0].sourceStale = '端点已改变'; assert.equal(simulateHydraulicNetwork(n, settings()).status, 'pending'); n.mode = 'gravity'; assert.equal(simulateHydraulicNetwork(n, settings()).status, 'pending');
});
test('default CSV keeps23 stable columns, explicit equipment CSV and time CSV include real pump/storage quantities', () => {
  const n = network([node('R', { type: 'reservoir', head: 50 }), node('J', { demand: 10 })], [link('P', 'R', 'J', { pump: pump() })]), r = ready(n);
  assert.equal(hydraulicsToCSV(n, r).split('\r\n')[0].split(',').length, 23); const ext = hydraulicsToCSV(n, r, true); assert.equal(ext.split('\r\n')[0].split(',').length, 27); assert.ok(ext.includes('泵扬程 m')); assert.ok(ext.includes('pump-running')); assert.ok(ext.includes('泵转速比例'));
  const csv = simulationToCSV(simulateHydraulicNetwork(drain(), settings())); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('体积守恒误差 m³')); assert.ok(csv.includes('-7.2'));
});
test('nonlinear reservoir-to-tank transient converges independently of large or small output step', () => {
  const n = network([node('R', { type: 'reservoir', head: 20 }), tank('T', { elevation: 0, demand: 1, tank: { area: 10, minLevel: 0, maxLevel: 30, initialLevel: 2 } })], [link('P', 'R', 'T')]);
  const big = simulateHydraulicNetwork(n, settings({ duration: 600, step: 600 })), small = simulateHydraulicNetwork(n, settings({ duration: 600, step: 5 }));
  assert.equal(big.status, 'ready', big.messages.join()); assert.equal(small.status, 'ready', small.messages.join()); near(big.frames.at(-1).tanks[0].level, small.frames.at(-1).tanks[0].level, 3e-5); assert.ok(big.maxMassBalanceError < 1e-7);
});
test('failed coarse pump predictor shrinks the integration step and completes the feasible exact timeline', () => {
  const n = network([node('R', { type: 'reservoir', head: 50 }), tank('T', { elevation: 0, demand: 20, tank: { area: .01, minLevel: 0, maxLevel: 100, initialLevel: 49 } })], [link('P', 'R', 'T', { pump: pump({ curve: [{ flow: 0, head: 30 }, { flow: 10, head: 20 }] }) })]);
  const coarse = simulateHydraulicNetwork(n, settings({ duration: 1.058, step: 100 })), fine = simulateHydraulicNetwork(n, settings({ duration: 1.058, step: .01 }));
  assert.equal(coarse.status, 'ready', coarse.messages.join()); assert.equal(fine.status, 'ready', fine.messages.join()); assert.ok(coarse.steps > 1); near(coarse.completedTime, 1.058, 1e-12);
  near(coarse.frames.at(-1).tanks[0].level, fine.frames.at(-1).tanks[0].level, 5e-5); near(coarse.maxMassBalanceError, 0, 1e-9);
});
test('source rebuild retains pump, valve, tank and simulation settings; removed event targets remain explicit pending drafts', () => {
  const p = { drawing: { type: 'plan' }, municipalElements: [{ id: 'p1', name: 'source1', kind: 'pipeline', elevation: 0, points: [{ x: 0, y: 0, z: 0 }, { x: 100000, y: 0, z: 0 }] }, { id: 'p2', name: 'source2', kind: 'pipeline', elevation: 0, points: [{ x: 100000, y: 0, z: 0 }, { x: 200000, y: 0, z: 0 }] }] };
  const old = networkFromMunicipal(p); old.nodes[0] = { ...old.nodes[0], type: 'reservoir', head: 50 }; old.nodes[1].demand = 1; old.nodes[2] = { ...old.nodes[2], ...tank(old.nodes[2].id), demand: 0 };
  old.links.forEach(pipe => Object.assign(pipe, { diameter: 100, roughness: 120 })); old.links[0].pump = pump(); old.links[0].valve = { open: true, lossCoefficient: 3 };
  old.simulation = settings({ events: [{ id: 'e', time: 300, targetId: old.nodes[0].id, kind: 'head', value: 60 }] });
  const rebuilt = networkFromMunicipal(p, 'pressure', old); assert.deepEqual(rebuilt.simulation, old.simulation); assert.deepEqual(rebuilt.links[0].pump, old.links[0].pump); assert.deepEqual(rebuilt.links[0].valve, old.links[0].valve); assert.deepEqual(rebuilt.nodes.find(node => node.id === old.nodes[2].id).tank, old.nodes[2].tank);
  p.municipalElements.shift(); const removed = networkFromMunicipal(p, 'pressure', rebuilt); assert.equal(removed.simulation.events[0].targetId, old.nodes[0].id); assert.equal(simulateHydraulicNetwork(removed).status, 'pending');
});
