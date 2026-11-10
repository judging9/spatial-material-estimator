import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.HYDRAULICS_BUILD ? pathToFileURL(resolve(process.env.HYDRAULICS_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { hydraulicControlLogToCSV, simulateHydraulicNetwork, simulationToCSV } = await import(new URL('lib/hydraulic-simulation.js', root));
const { validateSimulationSettings } = await import(new URL('lib/hydraulic-simulation-config.js', root));
const { decideHydraulicControl } = await import(new URL('lib/hydraulic-controls.js', root));
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const control = (patch = {}) => ({ id: 'c', enabled: true, tankId: 'T', linkId: 'P', device: 'pump', strategy: 'fill', lowLevel: 1, highLevel: 2, ...patch });
const settings = (patch = {}) => ({ duration: 300, step: 300, events: [], controls: [control()], ...patch });
const network = (patch = {}) => ({ mode: 'pressure', nodes: [{ id: 'R', name: 'source', x: 0, y: 0, elevation: 0, type: 'reservoir', head: 0, demand: null }, { id: 'T', name: 'tank', x: 1, y: 0, elevation: 0, type: 'tank', head: null, demand: 0, tank: { area: 1, minLevel: 0, maxLevel: 3, initialLevel: 1 } }], links: [{ id: 'P', name: 'pump', from: 'R', to: 'T', length: 1000, diameter: 100, roughness: 120, minorLoss: 0, pump: { enabled: false, curve: [{ flow: 0, head: 30 }, { flow: 20, head: 30 }] } }], ...patch });
const ready = (n, s) => { const r = simulateHydraulicNetwork(n, s); assert.equal(r.status, 'ready', r.messages.join(' ')); return r; };
const exponent = 1 / 1.852, coefficient = .01 / 22.07601862231587 ** exponent;
test('relay retains actual state inside band and applies reversed drain semantics', () => {
  assert.equal(decideHydraulicControl(control(), 1.5, false), null); assert.equal(decideHydraulicControl(control(), 1.5, true), null);
  assert.equal(decideHydraulicControl(control(), 1, false).active, true); assert.equal(decideHydraulicControl(control(), 2, true).active, false);
  assert.equal(decideHydraulicControl(control({ strategy: 'drain' }), 2, false).active, true); assert.equal(decideHydraulicControl(control({ strategy: 'drain' }), 1, true).active, false);
});
test('real pump filling threshold time matches independently integrated Hazen-Williams storage law, not output interval', () => {
  const n = network(), r = ready(n, settings()), automatic = r.controlLog.filter(log => log.source === 'automatic');
  const exact = (29 ** (1 - exponent) - 28 ** (1 - exponent)) / (coefficient * (1 - exponent));
  assert.equal(automatic.length, 2); near(automatic[0].time, 0); assert.equal(automatic[0].active, true); assert.equal(automatic[1].active, false); near(automatic[1].time, exact, .002); near(automatic[1].level, 2, 1e-10);
  assert.ok(automatic[1].time < 300); near(r.frames.at(-1).tanks[0].level, 2, 1e-10); near(r.frames.at(-1).result.links[0].flow, 0); near(r.frames.at(-1).reservoirVolume, 1, 1e-8); near(r.maxMassBalanceError, 0, 1e-8); assert.equal(n.links[0].pump.enabled, false);
});
test('valve and pipe relays control actual flow with the same physical filling reference', () => {
  for (const device of ['valve', 'pipe']) {
    const n = network(); n.nodes[0].head = 30; delete n.links[0].pump;
    if (device === 'valve') n.links[0].valve = { open: false, lossCoefficient: 0 }; else n.links[0].status = 'closed';
    const r = ready(n, settings({ controls: [control({ device })] })); const log = r.controlLog.filter(log => log.source === 'automatic');
    near(log[1].time, (29 ** (1 - exponent) - 28 ** (1 - exponent)) / (coefficient * (1 - exponent)), .002); near(r.frames.at(-1).result.links[0].flow, 0); near(r.maxMassBalanceError, 0, 1e-8);
  }
});
test('reverse drainage strategy reaches independently integrated low threshold and stops the pump', () => {
  const n = network(); n.nodes[1].tank.initialLevel = 2; n.links[0].from = 'T'; n.links[0].to = 'R';
  const r = ready(n, settings({ controls: [control({ strategy: 'drain' })] })), log = r.controlLog.filter(log => log.source === 'automatic');
  const exact = (32 ** (1 - exponent) - 31 ** (1 - exponent)) / (coefficient * (1 - exponent)); near(log[1].time, exact, .002); near(log[1].level, 1, 1e-10); assert.equal(log[1].active, false); near(r.frames.at(-1).reservoirVolume, -1, 1e-8); near(r.maxMassBalanceError, 0, 1e-8);
});
test('hysteresis produces actual repeat cycles; the closed-device drawdown period is exactly500 seconds', () => {
  const n = network(); n.nodes[1].demand = 2; const r = ready(n, settings({ duration: 1500 })), logs = r.controlLog.filter(log => log.source === 'automatic');
  assert.ok(logs.length >= 5); near(logs[2].time - logs[1].time, 500, 1e-6);
  for (const log of logs) near(log.level, log.active ? 1 : 2, 1e-9);
  const fine = ready(n, settings({ duration: 1500, step: 3 })); assert.equal(fine.controlLog.length, logs.length); near(fine.frames.at(-1).tanks[0].level, r.frames.at(-1).tanks[0].level, 1e-4); near(r.maxMassBalanceError, 0, 1e-7);
});
test('automatic action at water storage bounds takes place before a false empty/full stop, without clamping volume', () => {
  const n = network(); n.nodes[1].tank.minLevel = 1; n.nodes[1].tank.maxLevel = 2;
  const r = ready(n, settings()); near(r.frames.at(-1).tanks[0].level, 2, 1e-10); near(r.frames.at(-1).storageChange, 1, 1e-10); near(r.frames.at(-1).reservoirVolume, 1, 1e-8); assert.equal(r.stop, undefined);
});
test('two independent tanks hitting the same physical threshold switch together and conserve both stored volumes', () => {
  const n = network(); n.nodes.push({ ...structuredClone(n.nodes[1]), id: 'T2', name: 'tank2' }); n.links.push({ ...structuredClone(n.links[0]), id: 'P2', to: 'T2', name: 'pump2' });
  const r = ready(n, settings({ controls: [control(), control({ id: 'c2', tankId: 'T2', linkId: 'P2' })] }));
  const closed = r.controlLog.filter(log => log.source === 'automatic' && !log.active); assert.equal(closed.length, 2); near(closed[0].time, closed[1].time, 1e-10); near(r.frames.at(-1).reservoirVolume, 2, 1e-8); assert.ok(r.frames.at(-1).tanks.every(tank => Math.abs(tank.volume - 2) < 1e-9)); near(r.maxMassBalanceError, 0, 1e-8);
});
test('time0 schedule is applied first, then a high-level fill relay overrides it and records both sources', () => {
  const n = network(); n.nodes[1].tank.initialLevel = 2;
  const r = ready(n, settings({ events: [{ id: 'e', time: 0, targetId: 'P', kind: 'pump', value: true }] }));
  assert.deepEqual(r.controlLog.map(log => [log.source, log.time, log.active]), [['schedule', 0, true], ['automatic', 0, false]]); near(r.frames[0].result.links[0].flow, 0); near(r.frames.at(-1).tanks[0].level, 2);
});
test('a schedule inside the hysteresis band changes the device and later reaches the true high threshold', () => {
  const n = network(); n.nodes[1].tank.initialLevel = 1.5;
  const r = ready(n, settings({ events: [{ id: 'e', time: 100, targetId: 'P', kind: 'pump', value: true }] }));
  assert.equal(r.controlLog[0].source, 'schedule'); near(r.controlLog[0].time, 100); assert.equal(r.controlLog[1].source, 'automatic'); assert.ok(r.controlLog[1].time > 100); near(r.controlLog[1].level, 2, 1e-9); near(r.frames.find(frame => frame.time === 100).result.links[0].flow, Math.pow(28.5 / 22.07601862231587, exponent) * 10, 1e-7);
});
test('at a scheduled low-threshold timestamp the schedule is recorded before the automatic fill action', () => {
  const n = network(); n.nodes[1].tank.initialLevel = 2; n.nodes[1].demand = 1;
  const r = ready(n, settings({ duration: 1100, events: [{ id: 'e', time: 1000, targetId: 'P', kind: 'pump', value: false }] })), scheduled = r.controlLog.findIndex(log => log.source === 'schedule'), automatic = r.controlLog.findIndex(log => log.source === 'automatic' && log.active);
  assert.ok(scheduled >= 0 && automatic > scheduled); near(r.controlLog[automatic].time, 1000, 1e-8); near(r.controlLog[automatic].level, 1, 1e-10); near(r.maxMassBalanceError, 0, 1e-8);
});
test('same target enabled twice, deleted targets and unfinished enabled controls are explicit pending drafts', () => {
  const n = network(); n.links[0].valve = { open: true, lossCoefficient: 0 };
  for (const controls of [[control(), control({ id: 'c2', device: 'valve' })], [control({ tankId: 'deleted' })], [control({ linkId: 'deleted' })], [control({ lowLevel: null })]]) assert.equal(simulateHydraulicNetwork(n, settings({ controls })).status, 'pending');
});
test('zero or submillimetre hysteresis, negative thresholds and out-of-storage limits cannot run', () => {
  for (const patch of [{ highLevel: 1 }, { highLevel: 1.00001 }, { lowLevel: -1 }]) assert.throws(() => validateSimulationSettings(settings({ controls: [control(patch)] })));
  assert.equal(simulateHydraulicNetwork(network(), settings({ controls: [control({ highLevel: 4 })] })).status, 'pending');
});
test('absent or disabled incomplete automation leaves the original physical trajectory and stop unchanged', () => {
  const n = network(); n.links[0].pump.enabled = true;
  const base = simulateHydraulicNetwork(n, settings({ controls: undefined })), disabled = simulateHydraulicNetwork(n, settings({ controls: [control({ enabled: false, tankId: '', linkId: '', lowLevel: null, highLevel: null })] }));
  assert.equal(base.status, 'stopped'); assert.deepEqual(disabled.frames, base.frames); assert.deepEqual(disabled.stop, base.stop); assert.deepEqual(disabled.controlLog, []);
});
test('controls are saved as conditions while logs stay transient; CSV contains actual time and device actions in19 stable columns', () => {
  const n = network(); n.simulation = settings(); const restored = JSON.parse(JSON.stringify(n)); validateSimulationSettings(restored.simulation); const r = ready(restored, restored.simulation);
  assert.deepEqual(restored.simulation.controls, [control()]); assert.equal(restored.simulation.controlLog, undefined); assert.equal(restored.controlLog, undefined);
  const csv = simulationToCSV(r); assert.ok(csv.includes('控制动作')); assert.ok(csv.includes('补水策略关闭')); for (const row of csv.trim().split('\r\n')) assert.equal(row.split(',').length, 19);
  const logCSV = hydraulicControlLogToCSV(r); assert.ok(logCSV.includes('液位自动调度')); assert.ok(logCSV.includes('策略编号')); for (const row of logCSV.trim().split('\r\n')) assert.equal(row.split(',').length, 11);
});
