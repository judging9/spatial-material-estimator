import type { Project } from './types.js';
import { escape, icon, openDialog, toast } from './ui.js';
import { hydraulicsToCSV, networkFromMunicipal, resolveHydraulicSources, solveHydraulicNetwork, validateHydraulicNetwork, type HydraulicLink, type HydraulicNetwork, type HydraulicNode, type HydraulicResult } from './lib/hydraulics.js';
import { showHydraulicSimulationEditor } from './hydraulic-simulation-panel.js';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
const number = (value: number | null | undefined, digits = 3) => value == null ? '—' : Number(value.toFixed(digits)).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const emptyNetwork = (): HydraulicNetwork => ({ mode: 'pressure', nodes: [], links: [] });
const roles = { pressure: [['junction', '普通节点'], ['reservoir', '供水边界'], ['tank', '储水池']], gravity: [['junction', '汇流节点'], ['outfall', '排水出口']] };
const deviceState = (value: string) => ({ open: '打开', closed: '关闭', 'check-closed': '止回关闭', 'pump-running': '泵运行' })[value] ?? '—';

function equipmentHTML(network: HydraulicNetwork): string {
  const tanks = network.nodes.filter(node => node.type === 'tank');
  const tankFields = [['area', '横截面积 m²'], ['minLevel', '最低液位 m'], ['maxLevel', '最高液位 m'], ['initialLevel', '初始液位 m']];
  const select = (link: HydraulicLink, field: string, value: unknown, options: [string, string][]) => `<select data-hyd-device="${escape(link.id)}" data-device-field="${field}" aria-label="${escape(link.name + ' ' + field)}">${options.map(([id, name]) => `<option value="${id}" ${String(value) === id ? 'selected' : ''}>${name}</option>`).join('')}</select>`;
  return `${tanks.length ? `<section class="hyd-section"><div class="section-head"><h3>储水池</h3><span class="help">池底 = 节点标高 · 初始水头 = 池底 + 液位</span></div>${tanks.map(node => `<div class="hyd-tank-inputs"><strong>${escape(node.name)}</strong>${tankFields.map(([key, label]) => `<label>${label}<input type="number" step="any" min="0" data-hyd-tank="${escape(node.id)}" data-tank-field="${key}" value="${node.tank?.[key] ?? ''}" aria-label="${escape(node.name + ' ' + label)}"></label>`).join('')}</div>`).join('')}<p class="help">水池本地需求须在节点行显式填写。水池为恒定横截面，液位以池底为零；上下限控制时序停止。</p></section>` : ''}<section class="hyd-section hyd-equipment"><div class="section-head"><h3>泵与阀门</h3><button class="button subtle" id="hydraulic-simulation">${icon('activity', 14)}时序分析</button></div><p class="help">泵只按输入的真实曲线插值，禁止外推；停机按隔断处理。止回阀仅允许起点 → 终点。节流阀采用明确的 K，不猜测开度与阻力关系。</p>${network.links.map(link => `<details class="hyd-device-card"><summary><span>${escape(link.name)}</span><span class="help">${link.pump ? '泵 · ' : ''}${link.valve ? '节流阀 · ' : ''}${link.checkValve ? '止回 · ' : ''}${link.status === 'closed' ? '关闭' : '打开'}</span></summary><div class="hyd-device-controls"><label>管段${select(link, 'status', link.status ?? 'open', [['open', '打开'], ['closed', '关闭']])}</label><label>止回阀${select(link, 'checkValve', link.checkValve ?? false, [['false', '不设置'], ['true', '仅顺向']])}</label>${link.pump ? `<label>泵${select(link, 'pumpEnabled', link.pump.enabled, [['true', '运行'], ['false', '停止 · 隔断']])}</label><button class="button subtle" data-hyd-remove-pump="${escape(link.id)}">移除泵</button>` : `<button class="button subtle" data-hyd-add-pump="${escape(link.id)}">添加泵</button>`}${link.valve ? `<label>节流阀${select(link, 'valveOpen', link.valve.open, [['true', '打开'], ['false', '关闭']])}</label><label>阀门 K<input type="number" step="any" min="0" data-hyd-device="${escape(link.id)}" data-device-field="valveK" value="${link.valve.lossCoefficient ?? ''}" aria-label="${escape(link.name)} 阀门 K"></label><button class="button subtle" data-hyd-remove-valve="${escape(link.id)}">移除阀门</button>` : `<button class="button subtle" data-hyd-add-valve="${escape(link.id)}">添加节流阀</button>`}</div>${link.pump ? `<div class="hyd-pump-curve"><div class="section-head"><strong>泵曲线</strong><button class="button subtle" data-hyd-add-curve="${escape(link.id)}">${icon('plus', 12)}曲线点</button></div><div class="hyd-pump-points">${link.pump.curve.map((point, index) => `<div><label>流量 L/s<input type="number" step="any" min="0" data-hyd-curve="${escape(link.id)}" data-curve-index="${index}" data-curve-field="flow" value="${point.flow ?? ''}" aria-label="${escape(link.name)} 曲线 ${index + 1} 流量 L/s"></label><label>扬程 m<input type="number" step="any" min="0" data-hyd-curve="${escape(link.id)}" data-curve-index="${index}" data-curve-field="head" value="${point.head ?? ''}" aria-label="${escape(link.name)} 曲线 ${index + 1} 扬程 m"></label><button class="icon-button" data-hyd-delete-curve="${escape(link.id)}" data-curve-index="${index}" aria-label="删除曲线点">${icon('trash', 12)}</button></div>`).join('')}</div><p class="help">首点流量须为 0，后续流量递增、扬程不递增。须包含设备实际运行范围。</p></div>` : ''}</details>`).join('')}</section>`;
}

export function renderHydraulicsOverview(project: Project): string {
  const network = resolveHydraulicSources(project);
  let caption = '从已画管线建立网络，填写边界与用水条件。';
  if (network) { const result = solveHydraulicNetwork(network); caption = `${network.nodes.length} 个节点 · ${network.links.length} 条管段 · ${result.status === 'ready' ? '已计算' : result.status === 'pending' ? '参数待填写' : '需核对条件'}`; }
  return `<div class="hydraulics-overview"><button class="button subtle full" data-action="municipal-hydraulics">${icon('route', 15)}管网水力计算</button><p class="help">${escape(caption)}</p></div>`;
}

function diagram(network: HydraulicNetwork, result: HydraulicResult): string {
  if (!network.nodes.length) return '<div class="hyd-empty">先画市政管线，或添加两个节点和一条管段。</div>';
  const xs = network.nodes.map(node => node.x), ys = network.nodes.map(node => node.y), minX = Math.min(...xs), minY = Math.min(...ys), spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  const coincident = spanX < 1e-9 && spanY < 1e-9;
  const point = (node: HydraulicNode) => coincident ? { x: 55 + network.nodes.indexOf(node) * 490 / Math.max(1, network.nodes.length - 1), y: 100 + (network.nodes.indexOf(node) % 2) * 35 } : { x: 55 + (node.x - minX) / Math.max(spanX, 1) * 490, y: spanY < 1e-9 ? 112 : 40 + (node.y - minY) / Math.max(spanY, 1) * 145 };
  const nodeMap = new Map(network.nodes.map(node => [node.id, node]));
  const edges = network.links.map(link => {
    const a = point(nodeMap.get(link.from)), b = point(nodeMap.get(link.to)), row = result.links.find(row => row.id === link.id), reverse = (row?.flow ?? 0) < 0;
    return `<g><line x1="${reverse ? b.x : a.x}" y1="${reverse ? b.y : a.y}" x2="${reverse ? a.x : b.x}" y2="${reverse ? a.y : b.y}" marker-end="url(#hyd-arrow)"/><text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 7}">${escape(row?.flow == null ? link.name : Math.abs(row.flow).toFixed(2) + ' L/s')}</text></g>`;
  }).join('');
  const nodes = network.nodes.map(node => { const p = point(node); return `<g class="${node.type === 'junction' ? '' : 'boundary'}"><circle cx="${p.x}" cy="${p.y}" r="6"/><text x="${p.x}" y="${p.y + 23}">${escape(node.name)}</text></g>`; }).join('');
  return `<svg class="hyd-diagram" viewBox="0 0 600 230" role="img" aria-label="管网连接与流向示意"><defs><marker id="hyd-arrow" viewBox="0 0 10 10" refX="13" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z"/></marker></defs>${edges}${nodes}</svg>`;
}

function resultsHTML(network: HydraulicNetwork, result: HydraulicResult): string {
  const devices = network.mode === 'pressure' && network.links.some(link => link.pump || link.valve || link.checkValve || link.status === 'closed');
  const status = result.status === 'ready' ? '计算已完成' : result.status === 'pending' ? '待填写参数' : '条件需核对';
  const messages = [...result.messages, ...result.warnings];
  const nodes = result.nodes.map(row => network.mode === 'pressure' ? `<tr><td>${escape(row.name)}</td><td>${number(row.head)}</td><td>${number(row.pressureHead)}</td><td>${number(row.supply)}</td></tr>` : `<tr><td>${escape(row.name)}</td><td>${number(row.demand)}</td><td>${number(row.supply)}</td></tr>`).join('');
  const nodeDetails = `<details class="hyd-node-results"><summary>${network.mode === 'pressure' ? '节点水头与供出流量' : '节点本地汇入与出口合计'}</summary><div class="hyd-table-wrap"><table class="hyd-results"><thead>${network.mode === 'pressure' ? '<tr><th>节点</th><th>总水头 m</th><th>压力水头 m</th><th>边界供出 L/s</th></tr>' : '<tr><th>节点</th><th>本地汇入 L/s</th><th>出口合计 L/s</th></tr>'}</thead><tbody>${nodes}</tbody></table></div></details>`;
  const links = result.links.map(row => network.mode === 'pressure' ? `<tr><td>${escape(row.name)}</td><td>${number(row.flow)}</td><td>${number(row.velocity)}</td><td>${number(row.headLoss)}</td>${devices ? `<td>${number(row.pumpHeadGain)}</td><td>${number(row.pumpSpeedRatio == null ? null : row.pumpSpeedRatio * 100, 2)}</td><td>${deviceState(row.deviceState)}</td>` : ''}</tr>` : `<tr class="${row.capacityExceeded ? 'hyd-warning-row' : ''}"><td>${escape(row.name)}</td><td>${number(row.flow)}</td><td>${number(row.slope == null ? null : row.slope * 100, 4)}</td><td>${number(row.normalDepth)}</td><td>${number(row.fillingRatio == null ? null : row.fillingRatio * 100, 1)}</td><td>${number(row.velocity)}</td><td>${number(row.fullFlowCapacity)}</td><td>${number(row.maxOpenFlowCapacity)}</td></tr>`).join('');
  const headers = network.mode === 'pressure' ? `<tr><th>管段</th><th>流量 L/s</th><th>流速 m/s</th><th>损失 m</th>${devices ? '<th>泵扬程 m</th><th>转速 %</th><th>设备状态</th>' : ''}</tr>` : '<tr><th>管段</th><th>流量 L/s</th><th>坡度 %</th><th>水深 m</th><th>充满度 %</th><th>速度 m/s</th><th>充满能力 L/s</th><th>最大自由表面能力 L/s</th></tr>';
  return `<div class="hyd-result-head"><div><span class="eyebrow">Hydraulic analysis</span><h3>${status}</h3></div>${result.status === 'ready' ? `<span class="chip">${network.mode === 'pressure' ? result.iterations + ' 次迭代' : '稳态汇流'}</span>` : ''}</div>${diagram(network, result)}<div class="hyd-messages" role="status">${messages.length ? messages.map(message => `<p>${escape(message)}</p>`).join('') : '<p>结果由当前真实管长、用户边界与管材参数计算。</p>'}</div>${result.status === 'ready' ? `<div class="hyd-checks"><span>最大流量守恒误差 <strong>${number(result.maxContinuityError, 8)} L/s</strong></span>${network.mode === 'pressure' ? `<span>最大能量误差 <strong>${number(result.maxEnergyError, 8)} m</strong></span>` : ''}</div>` : ''}<div class="hyd-table-wrap"><table class="hyd-results"><thead>${headers}</thead><tbody>${links}</tbody></table></div>${nodeDetails}`;
}

/** Dialog keeps an independent working copy. Only explicit Apply commits it. */
export function showHydraulicsEditor(project: Project, onChange: (network: HydraulicNetwork) => void, draft?: HydraulicNetwork): void {
  let network = resolveHydraulicSources(project, draft) ?? (() => { try { return networkFromMunicipal(project); } catch { return emptyNetwork(); } })();
  let timer: ReturnType<typeof setTimeout>;
  const dialog = openDialog('管网水力计算', '<div id="hydraulic-editor"></div>', { wide: true, subtitle: '实际连接、明确边界与可核对的计算结果', footer: '<button class="button subtle" id="hydraulic-export">导出水力 CSV</button><button class="button primary" id="hydraulic-apply">应用到项目</button>' });
  dialog.classList.add('hydraulic-dialog');
  const body = dialog.querySelector<HTMLElement>('#hydraulic-editor');
  const input = (kind: 'node' | 'link', item: HydraulicNode | HydraulicLink, field: string, label: string, min?: number) => `<input type="number" step="any" ${min === undefined ? '' : `min="${min}"`} data-hyd-kind="${kind}" data-hyd-id="${escape(item.id)}" data-hyd-field="${field}" value="${item[field] == null ? '' : escape(item[field])}" placeholder="待填写" aria-label="${escape(item.name + ' ' + label)}">`;
  const result = () => { try { return solveHydraulicNetwork(network); } catch (error) { return { mode: network.mode, status: 'error', converged: false, iterations: 0, maxContinuityError: null, maxEnergyError: null, messages: [error.message], warnings: [], nodes: [], links: [] } as HydraulicResult; } };
  const updateResults = () => { const target = body.querySelector('#hydraulic-results'); if (target) target.innerHTML = resultsHTML(network, result()); };
  const render = () => {
    const pressure = network.mode === 'pressure';
    const nodes = network.nodes.map(node => `<tr><td><input data-hyd-kind="node" data-hyd-id="${escape(node.id)}" data-hyd-field="name" value="${escape(node.name)}" maxlength="120" aria-label="节点名称"></td><td><select data-hyd-kind="node" data-hyd-id="${escape(node.id)}" data-hyd-field="type" aria-label="${escape(node.name)}类型">${roles[network.mode].map(([value, name]) => `<option value="${value}" ${node.type === value ? 'selected' : ''}>${name}</option>`).join('')}</select></td><td>${input('node', node, 'elevation', '标高 m')}</td><td>${node.type === 'reservoir' && pressure ? input('node', node, 'head', '总水头 m') : input('node', node, 'demand', pressure ? '需求 L/s' : node.type === 'outfall' ? '出口本地汇入 L/s' : '外来流量 L/s', pressure ? undefined : 0)}</td><td><details><summary>坐标</summary><label>X m${input('node', node, 'x', 'X m')}</label><label>Y m${input('node', node, 'y', 'Y m')}</label></details></td><td><button type="button" class="icon-button" data-hyd-delete-node="${escape(node.id)}" aria-label="删除${escape(node.name)}">${icon('trash', 13)}</button></td></tr>`).join('');
    const endpoints = (link: HydraulicLink, field: 'from' | 'to') => `<select data-hyd-kind="link" data-hyd-id="${escape(link.id)}" data-hyd-field="${field}" aria-label="${escape(link.name)}${field === 'from' ? '起点' : '终点'}">${network.nodes.map(node => `<option value="${escape(node.id)}" ${link[field] === node.id ? 'selected' : ''}>${escape(node.name)}</option>`).join('')}</select>`;
    const links = network.links.map(link => `<tr><td><input data-hyd-kind="link" data-hyd-id="${escape(link.id)}" data-hyd-field="name" value="${escape(link.name)}" maxlength="120" aria-label="管段名称">${link.sourceElementId ? '<small>场地管线 · 实测管长</small>' : '<small>独立水力管段</small>'}</td><td>${endpoints(link, 'from')}</td><td>${endpoints(link, 'to')}</td><td>${input('link', link, 'length', '管长 m', .000001)}</td><td>${input('link', link, 'diameter', '内径 mm', .000001)}</td><td>${input('link', link, 'roughness', pressure ? 'Hazen Williams C' : 'Manning n', .000001)}</td>${pressure ? `<td>${input('link', link, 'minorLoss', '局部损失 K', 0)}</td>` : `<td>${input('link', link, 'invertStart', '起端管底 m')}</td><td>${input('link', link, 'invertEnd', '末端管底 m')}</td><td>${input('link', link, 'flow', '指定分流 L/s', 0)}</td>`}<td><button type="button" class="icon-button" data-hyd-delete-link="${escape(link.id)}" aria-label="删除${escape(link.name)}">${icon('trash', 13)}</button></td></tr>`).join('');
    body.innerHTML = `<div class="hyd-toolbar"><div class="hyd-mode" role="group" aria-label="水力计算模式"><button type="button" data-hyd-mode="pressure" aria-pressed="${pressure}" class="${pressure ? 'active' : ''}">压力供水</button><button type="button" data-hyd-mode="gravity" aria-pressed="${!pressure}" class="${!pressure ? 'active' : ''}">重力排水</button></div><button type="button" class="button subtle" id="hydraulic-rebuild">${icon('route', 14)}从场地管线重建</button></div><p class="help hyd-scope">${pressure ? 'Hazen–Williams 稳态压力网。普通节点填用水需求，供水边界填总水头；总水头减节点标高得到压力水头。负流量表示实际流向与起终点相反。' : 'Manning 圆管稳态均匀流。按有向网络累加上游与本节点外来流量，默认不猜分流比例。起终点顺序应沿下游，管底坡度 = 高程差 ÷ 实际管长。'}内径与粗糙系数由你填写。</p><section class="hyd-section"><div class="section-head"><h3>节点与边界</h3><button type="button" class="button subtle" id="hydraulic-add-node">${icon('plus', 13)}添加节点</button></div><div class="hyd-table-wrap"><table class="hyd-input-table hyd-node-table"><thead><tr><th>名称</th><th>类型</th><th>标高 m</th><th>${pressure ? '总水头 m / 需求 L/s' : '外来汇入 L/s'}</th><th>坐标 m</th><th></th></tr></thead><tbody>${nodes}</tbody></table></div></section><section class="hyd-section"><div class="section-head"><h3>连接与管材</h3><button type="button" class="button subtle" id="hydraulic-add-link" ${network.nodes.length < 2 ? 'disabled' : ''}>${icon('plus', 13)}添加管段</button></div><div class="hyd-table-wrap"><table class="hyd-input-table hyd-link-table"><thead><tr><th>名称</th><th>起点</th><th>终点</th><th>管长 m</th><th>内径 mm</th><th>${pressure ? 'C' : 'n'}</th>${pressure ? '<th>局部 K</th>' : '<th>起端底 m</th><th>末端底 m</th><th>指定分流 L/s</th>'}<th></th></tr></thead><tbody>${links}</tbody></table></div><p class="help">${pressure ? '局部 K = 0 表示未计弯头阀门等局部损失，按实际做法填写。' : '单一出流自动汇流；分流时为每条下游管填写明确流量，并验证节点守恒。'}绘图外径不自动冒充水力内径；途中交叉不自动连接。</p></section><section class="hyd-section" id="hydraulic-results"></section>`;
    if (pressure) body.querySelector('#hydraulic-results').insertAdjacentHTML('beforebegin', equipmentHTML(network));
    body.querySelectorAll<HTMLSelectElement>('[data-device-field="pumpEnabled"]').forEach(select => {
      const link = network.links.find(link => link.id === select.dataset.hydDevice), speed = link.pump.speed === undefined ? 1 : link.pump.speed, card = select.closest('.hyd-device-card');
      select.closest('label').insertAdjacentHTML('afterend', `<label>转速 · %<input type="number" step="any" min="10" max="150" data-hyd-device="${escape(link.id)}" data-device-field="pumpSpeed" value="${speed === null ? '' : escape(speed * 100)}" placeholder="待填写" aria-label="${escape(link.name)} 泵转速 %"></label>`);
      card.querySelector('.hyd-pump-curve strong').textContent = '额定泵曲线 · 100%';
      card.querySelector('.hyd-pump-curve .help').textContent += ' 转速按理想相似定律换算，保留此额定曲线；不是自动调压或水锤计算。';
    });
    body.querySelectorAll<HTMLInputElement>('input[data-hyd-kind="link"][data-hyd-field="length"]').forEach(element => { const link = network.links.find(link => link.id === element.dataset.hydId); if (link?.sourceElementId) { element.readOnly = true; element.title = '管长实时取所属场地管线；独立管段可手工填写。'; } });
    updateResults();
  };
  body.addEventListener('input', event => {
    const field = event.target as HTMLInputElement;
    if (field.dataset.hydTank || field.dataset.hydCurve || field.dataset.hydDevice) {
      const value = field.value.trim() === '' ? null : Number(field.value);
      if (field.dataset.hydTank) network.nodes.find(node => node.id === field.dataset.hydTank).tank[field.dataset.tankField] = value;
      else if (field.dataset.hydCurve) network.links.find(link => link.id === field.dataset.hydCurve).pump.curve[Number(field.dataset.curveIndex)][field.dataset.curveField] = value;
      else if (field.tagName === 'INPUT') { const link = network.links.find(link => link.id === field.dataset.hydDevice); if (field.dataset.deviceField === 'pumpSpeed') link.pump.speed = value === null ? null : value / 100; else link.valve.lossCoefficient = value; }
      clearTimeout(timer); timer = setTimeout(updateResults, 80); return;
    }
    if (!field.dataset.hydKind || field.tagName === 'SELECT') return;
    const owner = field.dataset.hydKind === 'node' ? network.nodes.find(node => node.id === field.dataset.hydId) : network.links.find(link => link.id === field.dataset.hydId);
    if (!owner) return;
    const key = field.dataset.hydField;
    if (field.type === 'number') owner[key] = field.value.trim() === '' ? null : Number(field.value); else owner[key] = field.value.trim() || (field.dataset.hydKind === 'node' ? '节点' : '管段');
    if (field.dataset.hydKind === 'node' && ['x', 'y'].includes(key)) { clearTimeout(timer); timer = setTimeout(updateResults, 80); } else { clearTimeout(timer); timer = setTimeout(updateResults, 80); }
  });
  body.addEventListener('change', event => {
    const field = event.target as HTMLSelectElement;
    if (field.dataset.hydDevice && field.tagName === 'SELECT') {
      const link = network.links.find(link => link.id === field.dataset.hydDevice), key = field.dataset.deviceField;
      if (key === 'status') link.status = field.value as 'open' | 'closed';
      else if (key === 'checkValve') link.checkValve = field.value === 'true';
      else if (key === 'pumpEnabled') link.pump.enabled = field.value === 'true';
      else if (key === 'valveOpen') link.valve.open = field.value === 'true';
      updateResults(); return;
    }
    if (!field.dataset.hydKind || field.tagName !== 'SELECT') return;
    const owner = field.dataset.hydKind === 'node' ? network.nodes.find(node => node.id === field.dataset.hydId) : network.links.find(link => link.id === field.dataset.hydId);
    if (!owner) return;
    owner[field.dataset.hydField] = field.value;
    if (field.dataset.hydKind === 'node' && field.dataset.hydField === 'type' && field.value === 'tank' && !owner['tank']) owner['tank'] = { area: null, minLevel: null, maxLevel: null, initialLevel: null };
    if (field.dataset.hydKind === 'link' && ['from', 'to'].includes(field.dataset.hydField)) { delete owner['sourceElementId']; delete owner['sourceStart']; delete owner['sourceEnd']; delete owner['sourceStale']; }
    render();
  });
  body.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
    try {
      if (button.id === 'hydraulic-simulation') { clearTimeout(timer); showHydraulicSimulationEditor(network, project.name || '市政项目', draft => showHydraulicsEditor(project, onChange, draft)); return; }
      else if (button.dataset.hydAddPump) network.links.find(link => link.id === button.dataset.hydAddPump).pump = { enabled: true, curve: [{ flow: 0, head: null }, { flow: null, head: null }] };
      else if (button.dataset.hydRemovePump) delete network.links.find(link => link.id === button.dataset.hydRemovePump).pump;
      else if (button.dataset.hydAddValve) network.links.find(link => link.id === button.dataset.hydAddValve).valve = { open: true, lossCoefficient: null };
      else if (button.dataset.hydRemoveValve) delete network.links.find(link => link.id === button.dataset.hydRemoveValve).valve;
      else if (button.dataset.hydAddCurve) network.links.find(link => link.id === button.dataset.hydAddCurve).pump.curve.push({ flow: null, head: null });
      else if (button.dataset.hydDeleteCurve) network.links.find(link => link.id === button.dataset.hydDeleteCurve).pump.curve.splice(Number(button.dataset.curveIndex), 1);
      else if (button.dataset.hydMode) {
        const mode = button.dataset.hydMode as HydraulicNetwork['mode']; if (mode === network.mode) return;
        network.mode = mode; network.links.forEach(link => link.roughness = null);
        network.nodes.forEach(node => { if (mode === 'gravity' && ['reservoir', 'tank'].includes(node.type)) node.type = 'outfall'; else if (mode === 'pressure' && node.type === 'outfall') node.type = 'reservoir'; });
        toast('模式已切换，请确认边界与流量并重新填写 C / n。');
      } else if (button.id === 'hydraulic-rebuild') {
        network = networkFromMunicipal(project, network.mode, network); toast('已按当前真实管线重建，保留相同节点和管线参数。');
      } else if (button.id === 'hydraulic-add-node') network.nodes.push({ id: uid('hyd-node'), name: `节点 ${network.nodes.length + 1}`, x: 0, y: 0, elevation: 0, type: 'junction', head: null, demand: null });
      else if (button.id === 'hydraulic-add-link' && network.nodes.length >= 2) network.links.push({ id: uid('hyd-link'), name: `管段 ${network.links.length + 1}`, from: network.nodes[0].id, to: network.nodes[1].id, length: null, diameter: null, roughness: null, minorLoss: 0, invertStart: null, invertEnd: null, flow: null });
      else if (button.dataset.hydDeleteNode) { const id = button.dataset.hydDeleteNode; if (network.links.some(link => link.from === id || link.to === id) && !confirm('删除节点将同时删除相连水力管段，尚未应用时可取消整个编辑。')) return; network.nodes = network.nodes.filter(node => node.id !== id); network.links = network.links.filter(link => link.from !== id && link.to !== id); }
      else if (button.dataset.hydDeleteLink) network.links = network.links.filter(link => link.id !== button.dataset.hydDeleteLink);
      else return;
      render();
      const equipmentId = button.dataset.hydAddPump ?? button.dataset.hydRemovePump ?? button.dataset.hydAddValve ?? button.dataset.hydRemoveValve ?? button.dataset.hydAddCurve ?? button.dataset.hydDeleteCurve;
      if (equipmentId) { const card = [...body.querySelectorAll<HTMLDetailsElement>('.hyd-device-card')].find(card => card.querySelector<HTMLSelectElement>('[data-hyd-device]')?.dataset.hydDevice === equipmentId); if (card) card.open = true; }
    } catch (error) { toast(error.message, true); }
  });
  dialog.querySelector('#hydraulic-export').addEventListener('click', () => {
    try { const blob = new Blob([hydraulicsToCSV(network, result(), true)], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = (project.name || '市政项目') + '-管网水力.csv'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (error) { toast(error.message, true); }
  });
  dialog.querySelector('#hydraulic-apply').addEventListener('click', () => {
    try { validateHydraulicNetwork(network); onChange(clone(network)); dialog.close(); toast(result().status === 'ready' ? '管网参数与计算已保存到项目' : '管网草稿已保存，补齐条件后可计算'); }
    catch (error) { toast(error.message, true); }
  });
  dialog.addEventListener('close', () => clearTimeout(timer), { once: true });
  render();
}
