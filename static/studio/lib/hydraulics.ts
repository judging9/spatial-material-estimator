import type { Project } from '../types.js';
import { pumpCurveProblem, pumpHeadAtFlow, pumpSpeedRatio, validateDeviceInputs, validateTank, type HydraulicPump, type HydraulicTank, type HydraulicValve } from './hydraulic-devices.js';
import { validateSimulationSettings, type HydraulicSimulationSettings } from './hydraulic-simulation-config.js';

export type HydraulicMode = 'pressure' | 'gravity';
export type HydraulicNode = {
  id: string; name: string; x: number; y: number; elevation: number;
  type: 'reservoir' | 'junction' | 'outfall' | 'tank'; head: number | null; demand: number | null; tank?: HydraulicTank;
};
export type HydraulicLocation = { x: number; y: number; z: number };
export type HydraulicLink = {
  id: string; name: string; from: string; to: string; sourceElementId?: string;
  length: number | null; diameter: number | null; roughness: number | null; minorLoss: number;
  invertStart?: number | null; invertEnd?: number | null; flow?: number | null;
  sourceStart?: HydraulicLocation; sourceEnd?: HydraulicLocation; sourceStale?: string;
  status?: 'open' | 'closed'; checkValve?: boolean; valve?: HydraulicValve; pump?: HydraulicPump;
};
export type HydraulicNetwork = { mode: HydraulicMode; nodes: HydraulicNode[]; links: HydraulicLink[]; simulation?: HydraulicSimulationSettings };
export type HydraulicNodeResult = {
  id: string; name: string; head: number | null; pressureHead: number | null;
  demand: number | null; supply: number | null;
};
export type HydraulicLinkResult = {
  id: string; name: string; from: string; to: string; flow: number | null; velocity: number | null;
  headLoss: number | null; slope: number | null; normalDepth: number | null;
  fillingRatio: number | null; fullFlowCapacity: number | null; maxOpenFlowCapacity: number | null;
  capacityExceeded: boolean;
  pumpHeadGain?: number | null; pumpSpeedRatio?: number | null; deviceState?: 'open' | 'closed' | 'check-closed' | 'pump-running';
};
export type HydraulicResult = {
  mode: HydraulicMode; status: 'ready' | 'pending' | 'error'; converged: boolean; iterations: number;
  maxContinuityError: number | null; maxEnergyError: number | null;
  messages: string[]; warnings: string[]; nodes: HydraulicNodeResult[]; links: HydraulicLinkResult[];
};
export const MAX_HYDRAULIC_NODES = 200;
export const MAX_HYDRAULIC_LINKS = 400;
const GRAVITY = 9.80665;
const POWER = 1.852;
const PRESSURE_FLOW_TOLERANCE = 1e-12; // m³/s, i.e. 10⁻⁹ L/s.
const MIN_HYDRAULIC_PARAMETER = 1e-6;
const clone = <T>(value: T): T => structuredClone(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const named = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
const uid = (prefix: string) => prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));

/** Structural validation allows explicit null fields in a saved draft. */
export function validateHydraulicNetwork(value: HydraulicNetwork | undefined): void {
  if (value === undefined) return;
  if (!value || !['pressure', 'gravity'].includes(value.mode) || !Array.isArray(value.nodes) || !Array.isArray(value.links)) throw new RangeError('管网水力数据格式不正确。');
  if (value.nodes.length > MAX_HYDRAULIC_NODES || value.links.length > MAX_HYDRAULIC_LINKS) throw new RangeError(`水力网最多支持 ${MAX_HYDRAULIC_NODES} 个节点、${MAX_HYDRAULIC_LINKS} 个管段。`);
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!node || !named(node.id) || ids.has(node.id) || !named(node.name)) throw new RangeError('水力节点名称或编号为空、过长或重复。');
    ids.add(node.id);
    if (!['reservoir', 'junction', 'outfall', 'tank'].includes(node.type) || ![node.x, node.y, node.elevation].every(finite) || Math.max(Math.abs(node.x), Math.abs(node.y), Math.abs(node.elevation)) > 1e7) throw new RangeError('水力节点坐标或类型不正确，坐标单位为 m。');
    if (node.tank !== undefined) validateTank(node.tank);
    for (const key of ['head', 'demand'] as const) if (node[key] !== null && (!finite(node[key]) || Math.abs(node[key]) > 1e7)) throw new RangeError('水头与流量须为有限数字或明确的空值。');
  }
  const linkIds = new Set<string>();
  for (const link of value.links) {
    validateDeviceInputs(link);
    if (!link || !named(link.id) || linkIds.has(link.id) || !named(link.name)) throw new RangeError('水力管段名称或编号为空、过长或重复。');
    linkIds.add(link.id);
    if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) throw new RangeError('管段必须连接两个不同的已有节点。');
    for (const key of ['length', 'diameter', 'roughness'] as const) if (link[key] !== null && (!finite(link[key]) || link[key] < MIN_HYDRAULIC_PARAMETER || link[key] > 1e7)) throw new RangeError('管长、内径与粗糙系数须在 0.000001～10000000 内，或保留明确的空值。');
    if (!finite(link.minorLoss) || link.minorLoss < 0 || link.minorLoss > 1e6) throw new RangeError('局部损失系数须为非负数字。');
    for (const key of ['invertStart', 'invertEnd', 'flow'] as const) if (link[key] !== undefined && link[key] !== null && (!finite(link[key]) || Math.abs(link[key]) > 1e7 || key === 'flow' && link[key] < 0)) throw new RangeError('管底高程或指定流量无效，流量不能为负数。');
    for (const location of [link.sourceStart, link.sourceEnd]) if (location !== undefined && (!location || ![location.x, location.y, location.z].every(finite))) throw new RangeError('来源管线端点快照无效。');
    if (link.sourceElementId !== undefined && !named(link.sourceElementId) || link.sourceStale !== undefined && typeof link.sourceStale !== 'string') throw new RangeError('水力管段来源信息无效。');
  }
  validateSimulationSettings(value.simulation);
}

const emptyResult = (network: HydraulicNetwork, messages: string[], status: 'pending' | 'error' = 'pending'): HydraulicResult => ({
  mode: network.mode, status, converged: false, iterations: 0, maxContinuityError: null, maxEnergyError: null, messages, warnings: [],
  nodes: network.nodes.map(node => ({ id: node.id, name: node.name, head: null, pressureHead: null, demand: node.demand, supply: null })),
  links: network.links.map(link => ({ id: link.id, name: link.name, from: link.from, to: link.to, flow: null, velocity: null, headLoss: null, slope: null, normalDepth: null, fillingRatio: null, fullFlowCapacity: null, maxOpenFlowCapacity: null, capacityExceeded: false })),
});

function parameters(network: HydraulicNetwork): string[] {
  const missing: string[] = [];
  if (!network.nodes.length || !network.links.length) return ['先从市政管线生成网络，或添加节点和管段。'];
  for (const node of network.nodes) {
    if (network.mode === 'pressure' && node.type === 'outfall') missing.push(`${node.name}：压力网请设为供水边界或普通节点。`);
    if (network.mode === 'gravity' && ['reservoir', 'tank'].includes(node.type)) missing.push(`${node.name}：重力网请设为普通节点或排水出口。`);
    if ((node.type === 'junction' || node.type === 'tank' || network.mode === 'gravity') && node.demand === null) missing.push(`${node.name}：请填写${network.mode === 'pressure' ? '节点需求' : node.type === 'outfall' ? '出口本地汇入流量' : '外来汇入流量'}，确认无流量可填 0。`);
    if (network.mode === 'gravity' && node.demand !== null && node.demand < 0) missing.push(`${node.name}：重力网外来流量不能为负。`);
    if (network.mode === 'pressure' && node.type === 'reservoir' && node.head === null) missing.push(`${node.name}：请填写供水总水头。`);
    if (network.mode === 'pressure' && node.type === 'tank' && (!node.tank || Object.values(node.tank).some(value => value === null))) missing.push(`${node.name}：请填写水池横截面积、最低/最高/初始液位。`);
  }
  for (const link of network.links) {
    if (network.mode === 'pressure' && link.pump) { const problem = pumpCurveProblem(link.pump); if (problem) missing.push(link.name + '：' + problem); }
    if (network.mode === 'pressure' && link.valve?.lossCoefficient === null) missing.push(link.name + '：请填写节流阀损失系数 K。');
    if (network.mode === 'gravity' && (link.pump || link.valve || link.checkValve || link.status === 'closed')) missing.push(link.name + '：泵阀设备与时序储水仅支持压力网；请切换压力模式或移除设备。');
    if (link.sourceStale) missing.push(link.name + '：' + link.sourceStale);
    if (link.length === null) missing.push(link.name + '：请填写实际管长（m）。');
    if (link.diameter === null) missing.push(link.name + '：请填写水力内径（mm），绘图外径不能代替内径。');
    if (link.roughness === null) missing.push(link.name + `：请填写${network.mode === 'pressure' ? 'Hazen–Williams C' : 'Manning n'}。`);
    if (network.mode === 'gravity') {
      if (link.roughness !== null && link.roughness > 1) missing.push(link.name + '：Manning n 应在 0～1 内，请核对模式及单位。');
      if (link.invertStart == null || link.invertEnd == null) missing.push(link.name + '：请填写两端真实管底高程（m）。');
    }
  }
  return missing;
}

export function hazenWilliamsHeadLoss(length: number, diameterMm: number, coefficient: number, flowLiters: number, minorLoss = 0): number {
  if (![length, diameterMm, coefficient].every(value => finite(value) && value >= MIN_HYDRAULIC_PARAMETER && value <= 1e7) || !finite(flowLiters) || !finite(minorLoss) || minorLoss < 0) throw new RangeError('Hazen–Williams 输入不正确或超出稳定计算范围。');
  const diameter = diameterMm / 1000, flow = Math.abs(flowLiters) / 1000;
  const friction = 10.67 * length / (Math.pow(coefficient, POWER) * Math.pow(diameter, 4.8704));
  const local = minorLoss * 8 / (GRAVITY * Math.PI * Math.PI * Math.pow(diameter, 4));
  const loss = Math.sign(flowLiters) * (friction * Math.pow(flow, POWER) + local * flow * flow);
  if (![friction, local, loss].every(Number.isFinite)) throw new RangeError('Hazen–Williams 阻力或水头损失超出有限数值范围。');
  return loss;
}

function pressureResistance(link: HydraulicLink) {
  const diameter = link.diameter / 1000;
  const resistance = { friction: 10.67 * link.length / (Math.pow(link.roughness, POWER) * Math.pow(diameter, 4.8704)), local: (link.minorLoss + (link.valve?.lossCoefficient ?? 0)) * 8 / (GRAVITY * Math.PI * Math.PI * Math.pow(diameter, 4)) };
  if (!Number.isFinite(resistance.friction) || resistance.friction <= 0 || !Number.isFinite(resistance.local)) throw new RangeError('压力管段阻力超出稳定计算范围。');
  return resistance;
}
function pressureFlow(head: number, resistance: ReturnType<typeof pressureResistance>) {
  const magnitude = Math.abs(head), { friction, local } = resistance;
  let q = magnitude === 0 ? 0 : Math.pow(magnitude / friction, 1 / POWER);
  if (local && magnitude) {
    let lo = 0, hi = q;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2, loss = friction * Math.pow(mid, POWER) + local * mid * mid; if (loss < magnitude) lo = mid; else hi = mid; }
    q = (lo + hi) / 2;
  }
  const derivative = 1 / (POWER * friction * Math.pow(Math.max(q, 1e-10), POWER - 1) + 2 * local * Math.max(q, 1e-10));
  return { q: Math.sign(head) * q, derivative };
}

const isClosed = (link: HydraulicLink) => link.status === 'closed' || link.valve?.open === false || link.pump?.enabled === false;
const isBoundary = (node: HydraulicNode) => node.type === 'reservoir' || node.type === 'tank';
function deviceFlow(head: number, link: HydraulicLink, resistance: ReturnType<typeof pressureResistance>) {
  if (isClosed(link)) return { q: 0, derivative: 0, state: 'closed' as const };
  if (!link.pump) {
    if (link.checkValve && head < 0) return { q: 0, derivative: 0, state: 'check-closed' as const };
    return { ...pressureFlow(head, resistance), state: 'open' as const };
  }
  const pump = link.pump, threshold = -pumpHeadAtFlow(pump, 0).head;
  if (head < threshold) return { q: 0, derivative: 0, state: 'check-closed' as const };
  const maxQ = pump.curve.at(-1).flow * pumpSpeedRatio(pump) / 1000;
  const equation = (q: number) => resistance.friction * q ** POWER + resistance.local * q * q - pumpHeadAtFlow(pump, q * 1000).head;
  let lo = 0, hi = maxQ;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (equation(mid) < head) lo = mid; else hi = mid; }
  const q = (lo + hi) / 2;
  // Endpoint tangent is used only to guide Newton back into the supplied curve.
  // Final energy validation rejects any capped point outside that curve.
  const derivative = 1 / (POWER * resistance.friction * Math.max(q, 1e-10) ** (POWER - 1) + 2 * resistance.local * q - pumpHeadAtFlow(pump, q * 1000).slope * 1000);
  return { q, derivative, state: 'pump-running' as const };
}

/** Pivoted elimination for the symmetric positive nodal conductance matrix. */
function linearSolve(matrix: number[][], right: number[]): number[] | null {
  const n = right.length, a = matrix.map((row, i) => [...row, right[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (!Number.isFinite(a[pivot][column]) || Math.abs(a[pivot][column]) < 1e-20) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = column + 1; row < n; row++) { const factor = a[row][column] / a[column][column]; if (!factor) continue; for (let col = column; col <= n; col++) a[row][col] -= factor * a[column][col]; }
  }
  const answer = Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) { let remainder = a[row][n]; for (let column = row + 1; column < n; column++) remainder -= a[row][column] * answer[column]; answer[row] = remainder / a[row][row]; }
  return answer.every(Number.isFinite) ? answer : null;
}

function solvePressure(network: HydraulicNetwork): HydraulicResult {
  const nodeMap = new Map(network.nodes.map((node, i) => [node.id, i]));
  const adjacency = network.nodes.map(() => [] as number[]);
  network.links.filter(link => !isClosed(link)).forEach(link => { const a = nodeMap.get(link.from), b = nodeMap.get(link.to); adjacency[a].push(b); adjacency[b].push(a); });
  const heads = network.nodes.map(node => node.type === 'tank' ? node.elevation + node.tank.initialLevel : node.type === 'reservoir' ? node.head : 0), visited = new Set<number>();
  for (let start = 0; start < network.nodes.length; start++) {
    if (visited.has(start)) continue;
    const stack = [start], component: number[] = []; visited.add(start);
    while (stack.length) { const i = stack.pop(); component.push(i); for (const next of adjacency[i]) if (!visited.has(next)) { visited.add(next); stack.push(next); } }
    const boundaries = component.filter(i => isBoundary(network.nodes[i]));
    if (!boundaries.length) return emptyResult(network, [`${network.nodes[start].name} 所在连通分量没有供水总水头边界，请连接供水点。`]);
    const initial = boundaries.reduce((total, i) => total + heads[i], 0) / boundaries.length;
    component.filter(i => !isBoundary(network.nodes[i])).forEach(i => heads[i] = initial);
  }
  const unknown = network.nodes.map((node, i) => node.type === 'junction' ? i : -1).filter(i => i >= 0), positions = new Map(unknown.map((index, i) => [index, i]));
  const resistances = network.links.map(pressureResistance);
  const evaluate = (values: number[], jacobian = false) => {
    const residual = unknown.map(i => network.nodes[i].demand / 1000), matrix = unknown.map(() => Array(unknown.length).fill(0));
    const active = network.nodes.map(() => [] as number[]);
    const flows = network.links.map((link, index) => {
      const a = nodeMap.get(link.from), b = nodeMap.get(link.to), { q, derivative, state } = deviceFlow(values[a] - values[b], link, resistances[index]), ia = positions.get(a), ib = positions.get(b);
      if (state !== 'closed' && state !== 'check-closed') { active[a].push(b); active[b].push(a); }
      if (ia !== undefined) residual[ia] += q;
      if (ib !== undefined) residual[ib] -= q;
      if (jacobian) { if (ia !== undefined) matrix[ia][ia] += derivative; if (ib !== undefined) matrix[ib][ib] += derivative; if (ia !== undefined && ib !== undefined) { matrix[ia][ib] -= derivative; matrix[ib][ia] -= derivative; } }
      return q;
    });
    const connected = new Set(network.nodes.map((node, i) => isBoundary(node) ? i : -1).filter(i => i >= 0)), queue = [...connected];
    while (queue.length) for (const next of active[queue.pop()]) if (!connected.has(next)) { connected.add(next); queue.push(next); }
    return { residual, matrix, flows, valid: unknown.every(i => connected.has(i)), norm: residual.reduce((total, value) => total + value * value, 0), max: residual.reduce((max, value) => Math.max(max, Math.abs(value)), 0) };
  };
  let iterations = 0, solution = evaluate(heads), converged = solution.max <= PRESSURE_FLOW_TOLERANCE;
  while (!converged && iterations < 120) {
    iterations++;
    const current = evaluate(heads, true), step = linearSolve(current.matrix, current.residual.map(value => -value));
    if (!step) return emptyResult(network, ['泵阀开闭后存在无有效水头边界或无法供给需求的分量，请核对止回方向、设备状态和泵曲线。']);
    let accepted = false;
    for (let fraction = 1; fraction >= 1 / 1048576; fraction /= 2) {
      const candidate = [...heads]; unknown.forEach((node, index) => candidate[node] += fraction * step[index]);
      const next = evaluate(candidate);
      if (next.valid && Number.isFinite(next.norm) && next.norm < current.norm) { candidate.forEach((value, i) => heads[i] = value); solution = next; accepted = true; break; }
    }
    if (!accepted) break;
    converged = solution.max <= PRESSURE_FLOW_TOLERANCE;
  }
  if (!converged) return { ...emptyResult(network, [network.links.some(link => link.pump || link.checkValve) ? '泵阀网络未找到守恒工作点，请核对泵曲线范围、止回方向和需求。' : '压力网迭代未收敛，未输出未经验证的水头或流量；请核对极端参数。'], network.links.some(link => link.pump || link.checkValve) ? 'pending' : 'error'), iterations };
  const active = network.nodes.map(() => [] as number[]);
  network.links.forEach((link, i) => { const a = nodeMap.get(link.from), b = nodeMap.get(link.to), state = deviceFlow(heads[a] - heads[b], link, resistances[i]).state; if (state !== 'closed' && state !== 'check-closed') { active[a].push(b); active[b].push(a); } });
  const connected = new Set(network.nodes.map((node, i) => isBoundary(node) ? i : -1).filter(i => i >= 0)), queue = [...connected];
  while (queue.length) for (const next of active[queue.pop()]) if (!connected.has(next)) { connected.add(next); queue.push(next); }
  if (network.nodes.some((node, i) => !connected.has(i))) return emptyResult(network, ['止回阀关闭后的连通分量缺少有效水头边界，隔离节点水头不可确定。']);
  const flows = solution.flows, warnings: string[] = [], nodeBalance = network.nodes.map(() => 0);
  network.links.forEach((link, i) => { nodeBalance[nodeMap.get(link.from)] += flows[i]; nodeBalance[nodeMap.get(link.to)] -= flows[i]; });
  const resultNodes = network.nodes.map((node, i) => {
    const pressureHead = heads[i] - node.elevation;
    if (pressureHead < -1e-8) warnings.push(`${node.name} 压力水头为负（${pressureHead.toFixed(3)} m），当前供水边界不能保证正压。`);
    return { id: node.id, name: node.name, head: heads[i], pressureHead, demand: node.type === 'junction' || node.type === 'tank' ? node.demand : null, supply: isBoundary(node) ? nodeBalance[i] * 1000 : null };
  });
  let maxEnergyError = 0;
  const resultLinks = network.links.map((link, i): HydraulicLinkResult => {
    const flow = flows[i] * 1000, headLoss = hazenWilliamsHeadLoss(link.length, link.diameter, link.roughness, flow, link.minorLoss + (link.valve?.lossCoefficient ?? 0));
    const difference = heads[nodeMap.get(link.from)] - heads[nodeMap.get(link.to)], deviceState = deviceFlow(difference, link, resistances[i]).state;
    const pumpHeadGain = link.pump?.enabled && deviceState === 'pump-running' ? pumpHeadAtFlow(link.pump, flow).head : 0;
    if (deviceState === 'check-closed') maxEnergyError = Math.max(maxEnergyError, Math.max(0, difference + (link.pump ? pumpHeadAtFlow(link.pump, 0).head : 0)));
    else if (deviceState !== 'closed') maxEnergyError = Math.max(maxEnergyError, Math.abs(difference - headLoss + pumpHeadGain));
    return { id: link.id, name: link.name, from: link.from, to: link.to, flow, velocity: flows[i] / (Math.PI * Math.pow(link.diameter / 1000, 2) / 4), headLoss, pumpHeadGain, pumpSpeedRatio: link.pump ? pumpSpeedRatio(link.pump) : null, deviceState, slope: null, normalDepth: null, fillingRatio: null, fullFlowCapacity: null, maxOpenFlowCapacity: null, capacityExceeded: false };
  });
  if (!heads.every(Number.isFinite) || !flows.every(Number.isFinite) || !Number.isFinite(maxEnergyError) || resultLinks.some(row => !Number.isFinite(row.headLoss) || !Number.isFinite(row.velocity)) || resultNodes.some(row => !Number.isFinite(row.pressureHead) || row.supply !== null && !Number.isFinite(row.supply))) return emptyResult(network, ['压力计算结果超出有限数值范围，未输出不可靠结果。'], 'error');
  const energyScale = Math.max(1, ...network.links.map(link => Math.abs(heads[nodeMap.get(link.from)] - heads[nodeMap.get(link.to)])));
  if (maxEnergyError > Math.max(1e-7, energyScale * 1e-9)) return emptyResult(network, [network.links.some(link => link.pump) ? '泵工作点超出已输入曲线，或设备能量残差未达到精度；未外推泵扬程。' : '压力管网能量残差未达到计算精度，未输出不可靠结果。'], network.links.some(link => link.pump) ? 'pending' : 'error');
  return { mode: 'pressure', status: 'ready', converged, iterations, maxContinuityError: solution.max * 1000, maxEnergyError, messages: [], warnings, nodes: resultNodes, links: resultLinks };
}

function circularSection(diameter: number, depth: number) {
  // asin(sqrt(y/D)) avoids subtracting nearly equal numbers near an empty pipe.
  const theta = 4 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, depth / diameter))));
  const square = theta * theta;
  const difference = theta < 1e-3 ? theta * square / 6 * (1 - square / 20 + square * square / 840 - square * square * square / 60480) : theta - Math.sin(theta);
  return { area: diameter * diameter / 8 * difference, perimeter: diameter / 2 * theta };
}

export function circularManningFlow(diameterMm: number, depthMeters: number, roughness: number, slope: number): number {
  if (![diameterMm, roughness].every(value => finite(value) && value >= MIN_HYDRAULIC_PARAMETER && value <= 1e7) || !finite(slope) || slope <= 0 || !finite(depthMeters) || depthMeters < 0 || depthMeters > diameterMm / 1000) throw new RangeError('Manning 圆管输入不正确或超出稳定计算范围；需要正坡度且水深不超过内径。');
  const diameter = diameterMm / 1000;
  if (depthMeters === 0) return 0;
  const { area, perimeter } = circularSection(diameter, depthMeters);
  const flow = area / roughness * Math.pow(area / perimeter, 2 / 3) * Math.sqrt(slope) * 1000;
  if (![area, perimeter, flow].every(Number.isFinite) || area <= 0 || perimeter <= 0 || flow <= 0) throw new RangeError('圆管水深或流量超出可稳定计算的精度范围。');
  return flow;
}

export function circularManningState(diameterMm: number, roughness: number, slope: number, flowLiters: number) {
  if (!finite(flowLiters) || flowLiters < 0) throw new RangeError('重力流量须为非负数字。');
  const diameter = diameterMm / 1000, capacity = circularManningFlow(diameterMm, diameter, roughness, slope);
  let lo = diameter / 2, hi = diameter;
  for (let i = 0; i < 90; i++) { const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3; if (circularManningFlow(diameterMm, left, roughness, slope) < circularManningFlow(diameterMm, right, roughness, slope)) lo = left; else hi = right; }
  const peakDepth = (lo + hi) / 2, maxCapacity = circularManningFlow(diameterMm, peakDepth, roughness, slope), capacityExceeded = flowLiters > maxCapacity * (1 + 1e-10);
  if (capacityExceeded) return { normalDepth: null, fillingRatio: null, velocity: null, fullFlowCapacity: capacity, maxOpenFlowCapacity: maxCapacity, capacityExceeded };
  lo = 0; hi = peakDepth;
  for (let i = 0; i < 90; i++) { const depth = (lo + hi) / 2; if (circularManningFlow(diameterMm, depth, roughness, slope) < flowLiters) lo = depth; else hi = depth; }
  const depth = flowLiters === 0 ? 0 : (lo + hi) / 2, { area } = circularSection(diameter, depth);
  const calculatedFlow = depth === 0 ? 0 : circularManningFlow(diameterMm, depth, roughness, slope);
  if (flowLiters > 0 && Math.abs(calculatedFlow - flowLiters) > flowLiters * 1e-7) throw new RangeError('正常水深反算未达到流量精度，未输出不可靠水深。');
  const velocity = area > 0 ? flowLiters / 1000 / area : 0;
  if (![depth, velocity, capacity, maxCapacity].every(Number.isFinite) || flowLiters > 0 && velocity <= 0) throw new RangeError('Manning 结果超出有限数值或有效水深范围。');
  return { normalDepth: depth, fillingRatio: depth / diameter, velocity, fullFlowCapacity: capacity, maxOpenFlowCapacity: maxCapacity, capacityExceeded };
}

function solveGravity(network: HydraulicNetwork): HydraulicResult {
  const nodes = new Map(network.nodes.map(node => [node.id, node])), outgoing = new Map(network.nodes.map(node => [node.id, [] as HydraulicLink[]])), indegree = new Map(network.nodes.map(node => [node.id, 0]));
  network.links.forEach(link => { outgoing.get(link.from).push(link); indegree.set(link.to, indegree.get(link.to) + 1); });
  for (const node of network.nodes) {
    if (node.type === 'outfall' && outgoing.get(node.id).length) return emptyResult(network, [`${node.name} 已设为排水出口，不能再接出流管段。`], 'error');
    if (node.type !== 'outfall' && !outgoing.get(node.id).length) return emptyResult(network, [`${node.name} 是网络末端，请设为排水出口或继续连接下游。`]);
  }
  const queue = network.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id), order: string[] = [];
  while (queue.length) { const id = queue.shift(); order.push(id); for (const link of outgoing.get(id)) { const count = indegree.get(link.to) - 1; indegree.set(link.to, count); if (!count) queue.push(link.to); } }
  if (order.length !== network.nodes.length) return emptyResult(network, ['重力网络含有有向回路；当前稳态汇流需要连接到下游出口的无环网络。'], 'error');
  const inflow = new Map(network.nodes.map(node => [node.id, node.demand ?? 0])), flows = new Map<string, number>();
  let maxContinuityError = 0;
  for (const id of order) {
    const links = outgoing.get(id), total = inflow.get(id);
    if (!links.length) continue;
    if (links.length > 1 && links.some(link => link.flow == null)) return emptyResult(network, [`${nodes.get(id).name} 有分流：请为各出流管明确填写分配流量，不能自动猜分流比例。`]);
    const outgoingTotal = links.reduce((sum, link) => sum + (link.flow ?? (links.length === 1 ? total : 0)), 0);
    maxContinuityError = Math.max(maxContinuityError, Math.abs(outgoingTotal - total));
    if (Math.abs(outgoingTotal - total) > Math.max(1e-6, total * 1e-8)) return emptyResult(network, [`${nodes.get(id).name} 的指定出流 ${outgoingTotal.toFixed(4)} L/s 与入流及外来流量 ${total.toFixed(4)} L/s 不守恒，请核对。`], 'error');
    for (const link of links) { const flow = link.flow ?? total; flows.set(link.id, flow); inflow.set(link.to, inflow.get(link.to) + flow); }
  }
  const warnings: string[] = [], messages: string[] = [];
  const resultLinks = network.links.map((link): HydraulicLinkResult => {
    const flow = flows.get(link.id), slope = (link.invertStart - link.invertEnd) / link.length;
    if (slope <= 0) { messages.push(`${link.name} 管底${slope < 0 ? '反坡' : '无坡度'}，不能用正坡均匀流求正常水深。`); return { id: link.id, name: link.name, from: link.from, to: link.to, flow, velocity: null, headLoss: null, slope, normalDepth: null, fillingRatio: null, fullFlowCapacity: null, maxOpenFlowCapacity: null, capacityExceeded: false }; }
    const state = circularManningState(link.diameter, link.roughness, slope, flow);
    if (state.capacityExceeded) warnings.push(`${link.name} 要求 ${flow.toFixed(3)} L/s，超过最大自由表面输水能力 ${state.maxOpenFlowCapacity.toFixed(3)} L/s，正常水深不存在。`);
    else if (state.fillingRatio > .8) warnings.push(`${link.name} 正常充满度为 ${(state.fillingRatio * 100).toFixed(1)}%，请按项目采用的设计条件核对。`);
    return { id: link.id, name: link.name, from: link.from, to: link.to, flow, headLoss: null, slope, ...state };
  });
  return { mode: 'gravity', status: messages.length ? 'error' : 'ready', converged: !messages.length, iterations: 0, maxContinuityError, maxEnergyError: null, messages, warnings,
    nodes: network.nodes.map(node => ({ id: node.id, name: node.name, head: null, pressureHead: null, demand: node.demand, supply: node.type === 'outfall' ? inflow.get(node.id) : null })), links: resultLinks };
}

export function solveHydraulicNetwork(network: HydraulicNetwork): HydraulicResult {
  validateHydraulicNetwork(network);
  const missing = parameters(network);
  if (missing.length) return emptyResult(network, missing);
  try {
    const result = network.mode === 'pressure' ? solvePressure(network) : solveGravity(network);
    if (result.status === 'ready') {
      const measurements = [...result.nodes.flatMap(node => [node.head, node.pressureHead, node.demand, node.supply]), ...result.links.flatMap(link => [link.flow, link.velocity, link.headLoss, link.slope, link.normalDepth, link.fillingRatio, link.fullFlowCapacity, link.maxOpenFlowCapacity]), result.maxContinuityError, result.maxEnergyError];
      if (measurements.some(value => value !== null && value !== undefined && !Number.isFinite(value))) return emptyResult(network, ['水力计算超出有限数值范围，未输出不可靠结果。'], 'error');
    }
    return result;
  } catch (error) { return emptyResult(network, [error.message || '水力计算未达到有效精度。'], 'error'); }
}

function sourceGeometry(project: Project, pipe: NonNullable<Project['municipalElements']>[number]) {
  const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
  if (!scale || !finite(scale) || scale <= 0) return null;
  const points = pipe.points.map(point => ({ x: point.x * scale, y: point.y * scale, z: (point.z ?? pipe.elevation) / 100 }));
  const length = points.slice(1).reduce((total, point, i) => total + Math.hypot(point.x - points[i].x, point.y - points[i].y, point.z - points[i].z), 0);
  return { start: points[0], end: points[points.length - 1], length };
}
const sameLocation = (a: HydraulicLocation, b: HydraulicLocation) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= .001;

/** Only actual route endpoints connect; crossing XY lines are not junctions. */
export function networkFromMunicipal(project: Project, mode: HydraulicMode = 'pressure', previous?: HydraulicNetwork): HydraulicNetwork {
  const network: HydraulicNetwork = { mode, nodes: [], links: [] };
  const reusable = previous?.mode === mode ? previous : undefined;
  if (reusable?.simulation) network.simulation = clone(reusable.simulation);
  const locations = new Map<string, HydraulicLocation>();
  const nodeFor = (point: HydraulicLocation) => {
    let node = network.nodes.find(node => sameLocation(locations.get(node.id), point));
    if (node) return node;
    const oldSource = reusable?.links.find(link => link.sourceStart && sameLocation(link.sourceStart, point) || link.sourceEnd && sameLocation(link.sourceEnd, point));
    const sourceNodeId = oldSource ? oldSource.sourceStart && sameLocation(oldSource.sourceStart, point) ? oldSource.from : oldSource.to : null;
    const old = reusable?.nodes.find(node => node.id === sourceNodeId) ?? reusable?.nodes.find(node => sameLocation({ x: node.x, y: node.y, z: node.elevation }, point));
    node = old ? clone(old) : { id: uid('hyd-node'), name: `节点 ${String(network.nodes.length + 1).padStart(2, '0')}`, x: point.x, y: point.y, elevation: point.z, type: 'junction', head: null, demand: null };
    locations.set(node.id, point);
    network.nodes.push(node); return node;
  };
  for (const pipe of project.municipalElements ?? []) {
    if (pipe.kind !== 'pipeline') continue;
    const geometry = sourceGeometry(project, pipe);
    if (!geometry) throw new RangeError('先校准市政图纸，才能生成真实管长的水力网络。');
    const from = nodeFor(geometry.start), to = nodeFor(geometry.end);
    if (from.id === to.id) throw new RangeError(`${pipe.name} 起终点相同，请拆成至少两条独立管段以建立环网节点。`);
    const old = reusable?.links.find(link => link.sourceElementId === pipe.id);
    network.links.push({ ...(old ? clone(old) : { id: uid('hyd-link'), diameter: null, roughness: null, minorLoss: 0, invertStart: null, invertEnd: null, flow: null }), name: pipe.name, from: from.id, to: to.id, sourceElementId: pipe.id, length: geometry.length, sourceStart: geometry.start, sourceEnd: geometry.end, sourceStale: undefined });
  }
  validateHydraulicNetwork(network); return network;
}

/** Re-evaluate source route lengths, and block a stale topology after endpoints move. */
export function resolveHydraulicSources(project: Project, value?: HydraulicNetwork): HydraulicNetwork | undefined {
  const original = value ?? (project as Project & { municipalHydraulics?: HydraulicNetwork }).municipalHydraulics;
  if (!original) return undefined;
  validateHydraulicNetwork(original);
  const network = clone(original), pipes = new Map((project.municipalElements ?? []).filter(pipe => pipe.kind === 'pipeline').map(pipe => [pipe.id, pipe]));
  for (const link of network.links) {
    if (!link.sourceElementId) continue;
    const pipe = pipes.get(link.sourceElementId);
    if (!pipe) { link.sourceStale = '来源管线已删除，请从场地重建网络。'; link.length = null; continue; }
    const geometry = sourceGeometry(project, pipe);
    if (!geometry) { link.sourceStale = '图纸尚未校准，实际管长待确认。'; link.length = null; continue; }
    link.length = geometry.length;
    const from = network.nodes.find(node => node.id === link.from), to = network.nodes.find(node => node.id === link.to);
    const start = link.sourceStart ?? { x: from.x, y: from.y, z: from.elevation }, end = link.sourceEnd ?? { x: to.x, y: to.y, z: to.elevation };
    link.sourceStale = !sameLocation(start, geometry.start) || !sameLocation(end, geometry.end) ? '来源管线端点已改变，请重建并确认连接关系。' : undefined;
  }
  return network;
}

export function hydraulicsToCSV(network: HydraulicNetwork, result = solveHydraulicNetwork(network), includeDevices = false): string {
  validateHydraulicNetwork(network);
  const header = ['对象类型', '名称', '起点', '终点', '模式', '管长 m', '内径 mm', '粗糙系数 C/n', '局部损失 K', '节点/起端标高 m', '末端管底 m', '需求/汇入 L/s', '计算流量/供出 L/s', '速度 m/s', '总水头 m', '压力水头 m', '水头损失 m', '管底坡度', '正常水深 m', '充满度', '充满流能力 L/s', '最大自由表面能力 L/s', '状态', '泵扬程 m', '设备状态', '节流阀 K', '泵转速比例'];
  const rows: unknown[][] = [header];
  if (!includeDevices) header.length = 23;
  for (const node of network.nodes) { const data = result.nodes.find(row => row.id === node.id); rows.push(['节点', node.name, '', '', network.mode, '', '', '', '', node.elevation, '', node.demand, data?.supply, '', data?.head, data?.pressureHead, '', '', '', '', '', '', result.status]); }
  for (const link of network.links) { const data = result.links.find(row => row.id === link.id); rows.push(['管段', link.name, network.nodes.find(node => node.id === link.from)?.name, network.nodes.find(node => node.id === link.to)?.name, network.mode, link.length, link.diameter, link.roughness, link.minorLoss, link.invertStart, link.invertEnd, '', data?.flow, data?.velocity, '', '', data?.headLoss, data?.slope, data?.normalDepth, data?.fillingRatio, data?.fullFlowCapacity, data?.maxOpenFlowCapacity, data?.capacityExceeded ? '超最大自由表面能力' : result.status, data?.pumpHeadGain, data?.deviceState, link.valve?.lossCoefficient, data?.pumpSpeedRatio]); }
  for (const message of [...result.messages, ...result.warnings]) rows.push(['提示', message, ...Array(20).fill(''), result.status]);
  const cell = (value: unknown) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
  return '\uFEFF' + rows.map(row => Array.from({ length: header.length }, (_, i) => cell(row[i])).join(',')).join('\r\n') + '\r\n';
}
