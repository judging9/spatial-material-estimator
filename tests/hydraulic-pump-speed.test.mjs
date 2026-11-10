import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.HYDRAULICS_BUILD ? pathToFileURL(resolve(process.env.HYDRAULICS_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { pumpHeadAtFlow, pumpSpeedRatio } = await import(new URL('lib/hydraulic-devices.js', root));
const { solveHydraulicNetwork, validateHydraulicNetwork, networkFromMunicipal, hydraulicsToCSV } = await import(new URL('lib/hydraulics.js', root));
const { simulateHydraulicNetwork, simulationToCSV, pumpSpeedLogToCSV } = await import(new URL('lib/hydraulic-simulation.js', root));
const { validateSimulationSettings } = await import(new URL('lib/hydraulic-simulation-config.js', root));
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const pump = (patch = {}) => ({ enabled: true, curve: [{ flow: 0, head: 30 }, { flow: 20, head: 10 }], ...patch });
const node = (id, patch = {}) => ({ id, name: id, x: 0, y: 0, elevation: 0, type: 'junction', head: null, demand: 0, ...patch });
const network = (speed = undefined, demand = 5) => ({ mode: 'pressure', nodes: [node('R', { type: 'reservoir', head: 50 }), node('J', { demand })], links: [{ id: 'P', name: 'P', from: 'R', to: 'J', length: 1000, diameter: 100, roughness: 120, minorLoss: 0, pump: pump({ speed }) }] });
const settings = (patch = {}) => ({ duration: 300, step: 60, events: [], ...patch });
const event = (id, time, value, kind = 'speed') => ({ id, time, value, kind, targetId: 'P' });
const ready = n => { const r = solveHydraulicNetwork(n); assert.equal(r.status, 'ready', r.messages.join(' ')); return r; };
const run = (n, s) => { const r = simulateHydraulicNetwork(n, s); assert.equal(r.status, 'ready', r.messages.join(' ')); return r; };
test('omitted speed remains exactly the original100 percent rated curve', () => {
  near(pumpSpeedRatio(pump()), 1); near(pumpHeadAtFlow(pump(), 10).head, 20); const r = ready(network()); near(r.links[0].pumpSpeedRatio, 1); near(r.links[0].pumpHeadGain, 25);
});
test('ideal affinity scaling gives independent head and derivative at50/100/150 percent without mutating rating', () => {
  for (const [speed, flow, head, slope] of [[.5, 5, 5, -.5], [1, 10, 20, -1], [1.5, 15, 45, -1.5]]) {
    const p = pump({ speed }), copy = structuredClone(p.curve), r = pumpHeadAtFlow(p, flow); near(r.head, head); near(r.slope, slope);
    const numerical = (pumpHeadAtFlow(p, flow + .0001).head - pumpHeadAtFlow(p, flow - .0001).head) / .0002; near(numerical, slope, 1e-8); assert.deepEqual(p.curve, copy);
  }
});
test('effective flow domain scales with speed and never extrapolates the rated curve', () => {
  near(pumpHeadAtFlow(pump({ speed: .5 }), 10).head, 2.5); assert.throws(() => pumpHeadAtFlow(pump({ speed: .5 }), 10.01), /禁止外推/);
  near(pumpHeadAtFlow(pump({ speed: 1.5 }), 25).head, 30); assert.throws(() => pumpHeadAtFlow(pump({ speed: 1.5 }), 30.01), /禁止外推/);
});
test('changed speed changes physical downstream head while retaining true5L/s flow and pipe energy loss', () => {
  const r = ready(network(.5)), friction = 22.07601862231587 * .5 ** 1.852;
  near(r.links[0].flow, 5); near(r.links[0].headLoss, friction); near(r.links[0].pumpHeadGain, 5); near(r.nodes[1].head, 50 + 5 - friction); assert.ok(r.maxEnergyError < 1e-8);
});
test('scaled shutoff head closes a reverse pressure boundary using7.5m rather than the rated30m', () => {
  const n = network(.5); n.nodes = [node('R', { type: 'reservoir', head: 0 }), node('J', { type: 'reservoir', head: 10 })];
  const r = ready(n); near(r.links[0].flow, 0); assert.equal(r.links[0].deviceState, 'check-closed'); near(r.maxEnergyError, 0); near(r.links[0].pumpSpeedRatio, .5);
});
test('curve-valid small flows still converge at10/50/150 percent speed', () => {
  for (const speed of [.1, .5, 1.5]) { const r = ready(network(speed, .001)); near(r.links[0].flow, .001, 1e-8); near(r.links[0].pumpHeadGain, speed * speed * 30 - speed * .001, 1e-8); assert.ok(r.maxEnergyError < 1e-7); }
});
test('stopped pump keeps its chosen speed setting without pretending zero speed or positive head gain', () => {
  const n = network(.5); n.links[0].pump.enabled = false; n.nodes[1] = node('J', { type: 'reservoir', head: 20 }); const r = ready(n);
  near(r.links[0].pumpSpeedRatio, .5); near(r.links[0].flow, 0); near(r.links[0].pumpHeadGain, 0); assert.equal(r.links[0].deviceState, 'closed');
});
test('blank speed is a saved pending draft; zero/out-of-range/nonfinite speed cannot be accepted', () => {
  const n = network(null); assert.doesNotThrow(() => validateHydraulicNetwork(n)); assert.equal(solveHydraulicNetwork(n).status, 'pending');
  for (const speed of [0, -.1, .09, 1.51, NaN, Infinity]) { assert.throws(() => validateHydraulicNetwork(network(speed))); assert.throws(() => pumpHeadAtFlow(pump({ speed }), 1)); }
});
test('time0 speed event can complete a blank initial setting before the first actual solve', () => {
  const n = network(null), rating = structuredClone(n.links[0].pump.curve), r = run(n, settings({ events: [event('e', 0, .5)] }));
  near(r.frames[0].result.links[0].pumpSpeedRatio, .5); near(r.frames[0].result.links[0].pumpHeadGain, 5); assert.deepEqual(r.pumpSpeedLog.map(log => [log.time, log.speedRatio]), [[0, .5]]); assert.equal(n.links[0].pump.speed, null); assert.deepEqual(n.links[0].pump.curve, rating);
});
test('scheduled speed changes are exact-time states with real head changes, fixed demand and conserved total volume', () => {
  const n = network(), rating = structuredClone(n.links[0].pump.curve), r = run(n, settings({ events: [event('a', 100, .5), event('b', 200, 1.5)] }));
  const a = r.frames.find(frame => frame.time === 100), b = r.frames.find(frame => frame.time === 200), friction = 22.07601862231587 * .5 ** 1.852;
  near(a.result.links[0].pumpHeadGain, 5); near(a.result.nodes[1].head, 55 - friction); near(b.result.links[0].pumpHeadGain, 60); near(b.result.nodes[1].head, 110 - friction); near(r.frames.at(-1).reservoirVolume, 1.5, 1e-8); near(r.frames.at(-1).demandVolume, 1.5); near(r.maxMassBalanceError, 0, 1e-8); assert.deepEqual(n.links[0].pump.curve, rating); assert.equal(n.links[0].pump.speed, undefined);
});
test('speed event that demands flow beyond the newly scaled curve pauses instead of extrapolating', () => {
  const n = network(1, 15), r = simulateHydraulicNetwork(n, settings({ events: [event('e', 100, .5)] }));
  assert.equal(r.status, 'pending'); near(r.completedTime, 100); assert.ok(r.messages.join().includes('曲线')); assert.ok(r.frames.every(frame => frame.result.links[0].pumpSpeedRatio === 1)); near(r.pumpSpeedLog[0].time, 100);
});
test('speed event validation rejects wrong targets, duplicates and invalid ratios; independent simultaneous speed and stop are allowed', () => {
  for (const value of [0, .09, 1.51, true]) assert.throws(() => validateSimulationSettings(settings({ events: [event('e', 0, value)] })));
  const n = network(); assert.equal(simulateHydraulicNetwork(n, settings({ events: [event('a', 0, .5), event('b', 0, .8)] })).status, 'pending');
  const wrong = structuredClone(n); delete wrong.links[0].pump; assert.equal(simulateHydraulicNetwork(wrong, settings({ events: [event('e', 0, .5)] })).status, 'pending');
  n.nodes[1] = node('J', { type: 'reservoir', head: 10 }); const r = run(n, settings({ events: [event('s', 0, .5), event('p', 0, false, 'pump')] })); near(r.frames[0].result.links[0].pumpSpeedRatio, .5); near(r.frames[0].result.links[0].flow, 0); assert.equal(r.controlLog[0].device, 'pump');
});
test('automatic level relay changes only enabled state and preserves a scheduled new speed when the pump restarts', () => {
  const n = network(.8); n.nodes = [node('R', { type: 'reservoir', head: 0 }), node('J', { type: 'tank', demand: 2, tank: { area: 1, minLevel: 0, maxLevel: 3, initialLevel: 1 } })]; n.links[0].pump.curve[1].head = 30; n.links[0].pump.enabled = false;
  const s = settings({ duration: 1000, events: [event('e', 600, 1.2)], controls: [{ id: 'c', enabled: true, tankId: 'J', linkId: 'P', device: 'pump', strategy: 'fill', lowLevel: 1, highLevel: 2 }] }), r = run(n, s), restart = r.controlLog.find(log => log.active && log.time > 600);
  assert.ok(restart); const frame = r.frames.find(frame => frame.time === restart.time); near(frame.result.links[0].pumpSpeedRatio, 1.2); assert.equal(frame.result.links[0].deviceState, 'pump-running'); near(r.maxMassBalanceError, 0, 1e-7); near(n.links[0].pump.speed, .8); assert.ok(r.controlLog.every(log => log.device === 'pump'));
});
test('scaled flat pump changes actual tank storage according to an independent integrated7.5m head law', () => {
  const n = network(.5); n.nodes = [node('R', { type: 'reservoir', head: 0 }), node('J', { type: 'tank', tank: { area: 1, minLevel: 0, maxLevel: 3, initialLevel: 1 } })]; n.links[0].pump.curve[1].head = 30;
  const r = run(n, settings({ duration: 100 })), exponent = 1 / 1.852, k = .01 / 22.07601862231587 ** exponent;
  const exact = 7.5 - (6.5 ** (1 - exponent) - k * (1 - exponent) * 100) ** (1 / (1 - exponent)); near(r.frames.at(-1).tanks[0].level, exact, 3e-6); near(r.frames.at(-1).reservoirVolume, exact - 1, 3e-6); near(r.maxMassBalanceError, 0, 1e-8);
});
test('source rebuild preserves chosen speed and the unchanged rated curve', () => {
  const p = { drawing: { type: 'plan' }, municipalElements: [{ id: 'source', name: 'source', kind: 'pipeline', elevation: 0, points: [{ x: 0, y: 0, z: 0 }, { x: 100000, y: 0, z: 0 }] }] }, n = networkFromMunicipal(p);
  n.nodes[0].type = 'reservoir'; n.nodes[0].head = 50; n.nodes[1].demand = 5; n.links[0].diameter = 100; n.links[0].roughness = 120; n.links[0].pump = pump({ speed: .8 }); const rebuilt = networkFromMunicipal(p, 'pressure', n); near(rebuilt.links[0].pump.speed, .8); assert.deepEqual(rebuilt.links[0].pump.curve, n.links[0].pump.curve); ready(rebuilt);
});
test('speed export explicitly extends device/time CSV while legacy defaults stay23/19 columns', () => {
  const n = network(.5), r = ready(n), simulation = run(n, settings({ events: [event('e', 100, .8)] }));
  near(hydraulicsToCSV(n, r).split('\r\n')[0].split(',').length, 23); const device = hydraulicsToCSV(n, r, true); near(device.split('\r\n')[0].split(',').length, 27); assert.ok(device.includes('泵转速比例'));
  near(simulationToCSV(simulation).split('\r\n')[0].split(',').length, 19); const time = simulationToCSV(simulation, true); for (const row of time.trim().split('\r\n')) near(row.split(',').length, 20); assert.ok(time.includes('转速设置')); const log = pumpSpeedLogToCSV(simulation); assert.ok(log.includes('80')); near(log.split('\r\n')[0].split(',').length, 6);
});
test('JSON save/load retains speed conditions and events but never mutates rating or persists transient speed logs', () => {
  const n = network(.8); n.simulation = settings({ events: [event('e', 100, .5)] }); const copy = JSON.parse(JSON.stringify(n)); validateHydraulicNetwork(copy); run(copy, copy.simulation); near(copy.links[0].pump.speed, .8); near(copy.simulation.events[0].value, .5); assert.deepEqual(copy.links[0].pump.curve, pump().curve); assert.equal(copy.pumpSpeedLog, undefined); assert.equal(copy.simulation.pumpSpeedLog, undefined);
});
