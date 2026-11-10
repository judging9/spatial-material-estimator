import { escape, icon, openDialog, toast } from './ui.js';
import { hydraulicControlLogToCSV, pumpSpeedLogToCSV, simulationToCSV } from './lib/hydraulic-simulation.js';
const clone = (value) => structuredClone(value);
const uid = () => crypto.randomUUID();
const num = (value, digits = 4) => value == null ? '—' : Number(value.toFixed(digits)).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const kinds = [['demand', '用水需求'], ['head', '水源总水头'], ['pump', '泵启停'], ['speed', '泵转速'], ['valve', '节流阀开闭'], ['pipe', '管段开闭']];
/** Returns to the parent draft. No result frame or hidden Apply is persisted. */
export function showHydraulicSimulationEditor(source, projectName, onBack) {
    const network = clone(source);
    const settings = network.simulation ?? { duration: 3600, step: 60, events: [] };
    network.simulation = settings;
    let output = null, worker = null, frameIndex = 0, series = '', returned = false;
    const dialog = openDialog('管网时序分析', '<div id="hydraulic-simulation-editor"></div>', { wide: true, subtitle: '压力网准稳态 · 水池储水 · 真实需求与设备事件', footer: '<button class="button subtle" id="hyd-sim-back">返回参数编辑</button><button class="button subtle" id="hyd-sim-export" disabled>导出时序 CSV</button><button class="button primary" id="hyd-sim-run">运行分析</button>' });
    dialog.classList.add('hydraulic-dialog', 'hyd-simulation-dialog');
    const body = dialog.querySelector('#hydraulic-simulation-editor');
    const targets = (kind) => kind === 'demand' ? network.nodes.filter(node => node.type === 'junction' || node.type === 'tank') : kind === 'head' ? network.nodes.filter(node => node.type === 'reservoir') : network.links.filter(link => kind === 'pump' || kind === 'speed' ? link.pump : kind === 'valve' ? link.valve : true);
    const eventValueHTML = (event) => {
        if (['demand', 'head', 'speed'].includes(event.kind)) {
            const speed = event.kind === 'speed', value = event.value === null ? '' : Number(event.value) * (speed ? 100 : 1), unit = speed ? '%' : event.kind === 'demand' ? 'L/s' : 'm';
            return `<label class="hyd-event-value"><input type="number" step="any" ${speed ? 'min="10" max="150"' : ''} data-sim-event="${escape(event.id)}" data-event-field="value" value="${value}" aria-label="${speed ? '泵转速 %' : '事件数值'}"><span>${unit}</span></label>`;
        }
        const states = event.kind === 'pipe' ? [['open', '打开'], ['closed', '关闭']] : [['true', event.kind === 'pump' ? '运行' : '打开'], ['false', event.kind === 'pump' ? '停止（隔断）' : '关闭']];
        return `<select data-sim-event="${escape(event.id)}" data-event-field="value" aria-label="事件状态"><option value="">待选择</option>${states.map(([value, name]) => `<option value="${value}" ${String(event.value) === value ? 'selected' : ''}>${name}</option>`).join('')}</select>`;
    };
    const controlsHTML = () => `<section class="hyd-section hyd-auto-controls"><div class="section-head"><h3>液位自动调度</h3><button class="button subtle" id="hyd-sim-add-control">${icon('plus', 13)}添加策略</button></div><p class="help">补水：低液位开启，高液位关闭。排水：高液位开启，低液位关闭。两者之间保留当前状态，液位差至少 0.001 m。定时事件先执行，随后由液位规则判断；每个管段仅启用一条自动策略。</p>${(settings.controls ?? []).map(control => {
        const tanks = network.nodes.filter(node => node.type === 'tank'), links = targets(control.device), tank = tanks.find(tank => tank.id === control.tankId);
        const selector = (field, value, choices, placeholder) => `<select data-sim-control="${escape(control.id)}" data-control-field="${field}" aria-label="自动策略 ${field}">${placeholder ? `<option value="">${placeholder}</option>` : ''}${value && !choices.some(([id]) => id === value) ? `<option value="${escape(value)}" selected>目标已变化 · 重新选择</option>` : ''}${choices.map(([id, name]) => `<option value="${escape(id)}" ${id === value ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select>`;
        return `<article class="hyd-auto-card ${control.enabled ? '' : 'disabled'}" data-sim-control-card="${escape(control.id)}"><div class="hyd-auto-card-head"><label><input type="checkbox" data-sim-control="${escape(control.id)}" data-control-field="enabled" ${control.enabled ? 'checked' : ''}>启用此策略</label><button class="icon-button" data-sim-delete-control="${escape(control.id)}" aria-label="删除液位策略">${icon('trash', 13)}</button></div><div class="hyd-auto-fields"><label>监测水池${selector('tankId', control.tankId, tanks.map(tank => [tank.id, tank.name]), '选择水池')}</label><label>控制设备${selector('device', control.device, [['pump', '泵'], ['valve', '节流阀'], ['pipe', '管段开闭']])}</label><label>设备所在管段${selector('linkId', control.linkId, links.map(link => [link.id, link.name]), '选择管段')}</label><label>运行方式${selector('strategy', control.strategy, [['fill', '补水 · 低开高关'], ['drain', '排水 · 高开低关']])}</label><label>低液位 · m<input type="number" step="any" min="0" data-sim-control="${escape(control.id)}" data-control-field="lowLevel" value="${control.lowLevel ?? ''}" aria-label="自动策略低液位 m"></label><label>高液位 · m<input type="number" step="any" min="0" data-sim-control="${escape(control.id)}" data-control-field="highLevel" value="${control.highLevel ?? ''}" aria-label="自动策略高液位 m"></label></div><p class="help">${tank?.tank ? `水池范围 ${num(tank.tank.minLevel)}–${num(tank.tank.maxLevel)} m，初始液位 ${num(tank.tank.initialLevel)} m。` : '先选择已填写面积和液位的水池。'}自动动作按真实液位触达时刻执行，不会裁切储水。</p></article>`;
    }).join('')}${settings.controls?.length ? '' : '<p class="help">未添加自动策略，设备按当前状态与定时事件运行。</p>'}</section>`;
    const invalidate = () => { output = null; dialog.querySelector('#hyd-sim-export').disabled = true; body.querySelector('#hyd-sim-results').innerHTML = '<div class="hyd-empty">条件已更新，点击「运行分析」计算时序。</div>'; };
    const render = () => {
        const rows = settings.events.map(event => `<tr data-sim-event-row="${escape(event.id)}"><td><input type="number" step="any" min="0" data-sim-event="${escape(event.id)}" data-event-field="time" value="${event.time == null ? '' : event.time / 3600}" aria-label="事件时间 h"></td><td><select data-sim-event="${escape(event.id)}" data-event-field="kind" aria-label="事件条件">${kinds.map(([kind, name]) => `<option value="${kind}" ${kind === event.kind ? 'selected' : ''}>${name}</option>`).join('')}</select></td><td><select data-sim-event="${escape(event.id)}" data-event-field="targetId" aria-label="事件目标"><option value="">选择目标</option>${targets(event.kind).map(target => `<option value="${escape(target.id)}" ${target.id === event.targetId ? 'selected' : ''}>${escape(target.name)}</option>`).join('')}</select></td><td>${eventValueHTML(event)}</td><td><button class="icon-button" data-sim-delete-event="${escape(event.id)}" aria-label="删除事件">${icon('trash', 13)}</button></td></tr>`).join('');
        body.innerHTML = `<p class="help hyd-scope">按实际流量积分水池储水，事件时间以秒计算。触及水池上下限将停止。转速按理想泵相似定律换算额定曲线，不自动调压或模拟水锤。关闭窗口返回未应用的参数草稿。</p>
      <div class="hyd-sim-settings"><label>模拟时长 · h<input type="number" step="any" min="0.0000003" max="168" data-sim-setting="duration" value="${settings.duration == null ? '' : settings.duration / 3600}" aria-label="模拟时长 h"></label><label>输出间隔 · min<input type="number" step="any" min="0.000017" data-sim-setting="step" value="${settings.step == null ? '' : settings.step / 60}" aria-label="输出间隔 min"></label><span class="help">自适应积分 · 最多 20,000 步</span></div>
      <section class="hyd-section"><div class="section-head"><h3>运行事件</h3><button class="button subtle" id="hyd-sim-add-event">${icon('plus', 13)}添加事件</button></div>${rows ? `<div class="hyd-table-wrap"><table class="hyd-input-table hyd-event-table"><thead><tr><th>时间 h</th><th>条件</th><th>目标</th><th>新值</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="help">按当前条件连续运行。添加事件可调整需求、泵启停或转速。</p>'}</section>
      ${controlsHTML()}<section id="hyd-sim-results"><div class="hyd-empty">点击「运行分析」查看液位、水头和流量随时间的变化。</div></section>`;
    };
    const renderResults = () => {
        if (!output)
            return;
        const target = body.querySelector('#hyd-sim-results'), frame = output.frames[Math.min(frameIndex, output.frames.length - 1)];
        const choices = [...network.nodes.filter(node => node.type === 'tank').map(node => [`tank:${node.id}`, node.name + ' · 液位 m']), ...network.nodes.map(node => [`head:${node.id}`, node.name + ' · 总水头 m']), ...network.links.map(link => [`flow:${link.id}`, link.name + ' · 流量 L/s']), ...network.links.filter(link => link.pump).map(link => [`speed:${link.id}`, link.name + ' · 设定转速 %'])];
        if (!choices.some(([id]) => id === series))
            series = choices[0]?.[0] ?? '';
        const [kind, id] = series.split(':'), values = output.frames.map(frame => kind === 'tank' ? frame.tanks.find(tank => tank.id === id)?.level : kind === 'head' ? frame.result.nodes.find(node => node.id === id)?.head : kind === 'speed' ? frame.result.links.find(link => link.id === id)?.pumpSpeedRatio * 100 : frame.result.links.find(link => link.id === id)?.flow);
        let chart = '';
        if (values.length && values.every(value => value != null && Number.isFinite(value))) {
            const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, Math.abs(max) * .01, .01), duration = Math.max(output.completedTime, 1);
            const coordinate = (value, index) => `${64 + output.frames[index].time / duration * 760},${178 - (value - min) / span * 140}`;
            const points = values.flatMap((value, index) => kind === 'speed' && index > 0 ? [coordinate(values[index - 1], index), coordinate(value, index)] : [coordinate(value, index)]).join(' ');
            chart = `<svg class="hyd-time-chart" viewBox="0 0 864 224" role="img" aria-label="实际计算时序曲线"><line x1="64" y1="178" x2="824" y2="178"/><line x1="64" y1="38" x2="64" y2="178"/><text x="54" y="181" text-anchor="end">${num(min)}</text><text x="54" y="42" text-anchor="end">${num(min + span)}</text><text x="64" y="207">0 h</text><text x="824" y="207" text-anchor="end">${num(duration / 3600)} h</text><polyline points="${points}"/><circle cx="${64 + frame.time / duration * 760}" cy="${178 - (values[frameIndex] - min) / span * 140}" r="4"/></svg>`;
            const automatic = (output.controlLog ?? []).filter(log => log.source === 'automatic'), stride = Math.max(1, Math.ceil(automatic.length / 80));
            const markers = automatic.filter((_, index) => index % stride === 0).map(log => `<line class="hyd-control-event" x1="${64 + log.time / duration * 760}" x2="${64 + log.time / duration * 760}" y1="38" y2="178"><title>${escape(log.name)} ${log.active ? '开启' : '关闭'} · ${num(log.time, 6)} s</title></line>`).join('');
            const speedMarkers = (output.pumpSpeedLog ?? []).map(log => `<line class="hyd-speed-event" x1="${64 + log.time / duration * 760}" x2="${64 + log.time / duration * 760}" y1="38" y2="178"><title>${escape(log.name)} 设定转速 ${num(log.speedRatio * 100)}% · ${num(log.time, 6)} s</title></line>`).join('');
            chart = chart.replace('</svg>', markers + speedMarkers + '</svg>');
        }
        target.innerHTML = `<div class="hyd-result-head"><div><span class="eyebrow">Quasi-steady simulation</span><h3>${output.status === 'ready' ? '时序计算已完成' : output.status === 'stopped' ? '已达到水池液位边界' : '条件需核对'}</h3></div><span class="chip">${output.steps} 个积分步</span></div><div class="hyd-messages" role="status">${[...output.messages, ...output.warnings].map(message => `<p>${escape(message)}</p>`).join('')}</div>${frame ? `<div class="hyd-checks"><span>已运行<strong>${num(output.completedTime / 3600, 6)} h</strong></span><span>最大体积守恒误差<strong>${num(output.maxMassBalanceError, 10)} m³</strong></span></div><div class="hyd-series-select"><label>查看曲线<select id="hyd-sim-series" aria-label="时序曲线">${choices.map(([id, label]) => `<option value="${escape(id)}" ${id === series ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></label></div>${chart}<label class="hyd-time-slider">时间 ${num(frame.time / 3600, 6)} h<input id="hyd-sim-time" type="range" min="0" max="${output.frames.length - 1}" value="${frameIndex}" step="1" aria-label="时刻"></label><div class="hyd-table-wrap"><table class="hyd-results"><thead><tr><th>节点</th><th>总水头 m</th><th>压力水头 m</th><th>供出 L/s</th><th>液位 m</th><th>储水 m³</th></tr></thead><tbody>${frame.result.nodes.map(node => { const tank = frame.tanks.find(tank => tank.id === node.id); return `<tr><td>${escape(node.name)}</td><td>${num(node.head)}</td><td>${num(node.pressureHead)}</td><td>${num(node.supply)}</td><td>${num(tank?.level ?? null)}</td><td>${num(tank?.volume ?? null)}</td></tr>`; }).join('')}</tbody></table></div><div class="hyd-table-wrap"><table class="hyd-results"><thead><tr><th>管段</th><th>流量 L/s</th><th>速度 m/s</th><th>损失 m</th><th>泵扬程 m</th><th>设备状态</th></tr></thead><tbody>${frame.result.links.map(link => `<tr><td>${escape(link.name)}</td><td>${num(link.flow)}</td><td>${num(link.velocity)}</td><td>${num(link.headLoss)}</td><td>${num(link.pumpHeadGain ?? null)}</td><td>${escape(({ open: '打开', closed: '关闭', 'check-closed': '止回关闭', 'pump-running': '泵运行' })[link.deviceState] ?? '打开')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
        dialog.querySelector('#hyd-sim-export').disabled = !output.frames.length;
        if (frame) {
            const table = target.querySelectorAll('table.hyd-results')[1];
            table.querySelector('thead tr').lastElementChild.insertAdjacentHTML('beforebegin', '<th>设定转速 %</th>');
            [...table.querySelectorAll('tbody tr')].forEach((row, index) => { const speed = frame.result.links[index].pumpSpeedRatio; row.lastElementChild.insertAdjacentHTML('beforebegin', `<td>${num(speed == null ? null : speed * 100, 2)}</td>`); });
        }
        if (output.controlLog?.length)
            target.insertAdjacentHTML('beforeend', `<details class="hyd-control-log"><summary>设备动作 · ${output.controlLog.length} 条</summary><div class="section-head"><p class="help">自动调度与定时事件分别标注。${output.controlLog.length > 200 ? '显示最近 200 条；完整记录可导出。' : '记录真实动作时刻。'}${output.controlLog.filter(log => log.source === 'automatic').length > 80 ? '图中显示部分动作标记。' : ''}</p><button class="button subtle" id="hyd-control-export">导出动作日志</button></div><div class="hyd-table-wrap"><table class="hyd-results"><thead><tr><th>时间 s</th><th>来源</th><th>设备 / 管段</th><th>动作</th><th>液位 m</th><th>原因</th></tr></thead><tbody>${output.controlLog.slice(-200).map(log => `<tr><td>${num(log.time, 6)}</td><td>${log.source === 'automatic' ? '液位自动' : '定时事件'}</td><td>${escape(log.name)}</td><td>${log.active ? '开启' : '关闭'}</td><td>${num(log.level ?? null, 6)}</td><td>${escape(log.reason)}</td></tr>`).join('')}</tbody></table></div></details>`);
        if (output.pumpSpeedLog?.length)
            target.insertAdjacentHTML('beforeend', `<details class="hyd-speed-log"><summary>转速事件 · ${output.pumpSpeedLog.length} 条</summary><div class="section-head"><p class="help">显示相对额定转速的设置值。停机仍使用泵启停；额定曲线保持不变。</p><button class="button subtle" id="hyd-speed-export">导出转速日志</button></div><div class="hyd-table-wrap"><table class="hyd-results"><thead><tr><th>时间 s</th><th>设备 / 管段</th><th>设定转速 %</th></tr></thead><tbody>${output.pumpSpeedLog.map(log => `<tr><td>${num(log.time, 6)}</td><td>${escape(log.name)}</td><td>${num(log.speedRatio * 100, 2)}</td></tr>`).join('')}</tbody></table></div></details>`);
    };
    body.addEventListener('input', event => {
        const input = event.target;
        if (input.id === 'hyd-sim-time') {
            frameIndex = Number(input.value);
            renderResults();
            return;
        }
        if (input.dataset.simControl && input.tagName === 'INPUT') {
            const control = settings.controls.find(control => control.id === input.dataset.simControl), field = input.dataset.controlField;
            control[field] = input.type === 'checkbox' ? input.checked : input.value.trim() === '' ? null : Number(input.value);
            if (field === 'enabled')
                input.closest('.hyd-auto-card').classList.toggle('disabled', !input.checked);
            invalidate();
            return;
        }
        if (input.dataset.simSetting) {
            settings[input.dataset.simSetting] = input.value.trim() === '' ? null : Number(input.value) * (input.dataset.simSetting === 'duration' ? 3600 : 60);
            invalidate();
        }
        if (input.dataset.simEvent && input.tagName === 'INPUT') {
            const item = settings.events.find(item => item.id === input.dataset.simEvent);
            item[input.dataset.eventField] = input.value.trim() === '' ? null : Number(input.value) * (input.dataset.eventField === 'time' ? 3600 : item.kind === 'speed' ? .01 : 1);
            invalidate();
        }
    });
    body.addEventListener('change', event => {
        const select = event.target;
        if (select.id === 'hyd-sim-series') {
            series = select.value;
            renderResults();
            return;
        }
        if (select.dataset.simControl && select.tagName === 'SELECT') {
            const control = settings.controls.find(control => control.id === select.dataset.simControl), field = select.dataset.controlField;
            control[field] = select.value;
            if (field === 'device')
                control.linkId = '';
            render();
            invalidate();
            return;
        }
        if (!select.dataset.simEvent || select.tagName !== 'SELECT')
            return;
        const item = settings.events.find(item => item.id === select.dataset.simEvent), field = select.dataset.eventField;
        if (field === 'kind') {
            item.kind = select.value;
            item.targetId = '';
            item.value = null;
            render();
        }
        else if (field === 'targetId')
            item.targetId = select.value;
        else
            item.value = !select.value ? null : item.kind === 'pipe' ? select.value : select.value === 'true';
        invalidate();
    });
    body.addEventListener('click', event => { const button = event.target.closest('button'); if (!button)
        return; if (button.id === 'hyd-sim-add-event') {
        settings.events.push({ id: uid(), time: null, kind: 'demand', targetId: '', value: null });
        render();
        invalidate();
    }
    else if (button.dataset.simDeleteEvent) {
        settings.events = settings.events.filter(item => item.id !== button.dataset.simDeleteEvent);
        render();
        invalidate();
    }
    else if (button.id === 'hyd-sim-add-control') {
        settings.controls ??= [];
        settings.controls.push({ id: uid(), enabled: true, tankId: '', linkId: '', device: 'pump', strategy: 'fill', lowLevel: null, highLevel: null });
        render();
        invalidate();
    }
    else if (button.dataset.simDeleteControl) {
        settings.controls = settings.controls.filter(control => control.id !== button.dataset.simDeleteControl);
        render();
        invalidate();
    }
    else if ((button.id === 'hyd-control-export' || button.id === 'hyd-speed-export') && output) {
        const speed = button.id === 'hyd-speed-export', url = URL.createObjectURL(new Blob([speed ? pumpSpeedLogToCSV(output) : hydraulicControlLogToCSV(output)], { type: 'text/csv;charset=utf-8' })), anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = projectName + (speed ? '-泵转速日志.csv' : '-设备动作日志.csv');
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } });
    dialog.querySelector('#hyd-sim-run').addEventListener('click', () => {
        const button = dialog.querySelector('#hyd-sim-run');
        if (worker) {
            worker.terminate();
            worker = null;
            button.textContent = '运行分析';
            body.inert = false;
            toast('已停止计算，参数草稿保留');
            return;
        }
        try {
            output = null;
            frameIndex = 0;
            dialog.querySelector('#hyd-sim-export').disabled = true;
            worker = new Worker(new URL('./hydraulic-simulation-worker.js', import.meta.url), { type: 'module' });
            button.textContent = '停止分析';
            body.inert = true;
            body.querySelector('#hyd-sim-results').innerHTML = '<div class="hyd-empty" role="status">正在求解管网与储水变化… <span id="hyd-sim-progress">0%</span></div>';
            const finish = () => { worker?.terminate(); worker = null; button.textContent = '运行分析'; body.inert = false; };
            worker.onmessage = event => { if (event.data.progress !== undefined)
                body.querySelector('#hyd-sim-progress').textContent = Math.floor(event.data.progress * 100) + '%'; if (event.data.result) {
                output = event.data.result;
                finish();
                renderResults();
            } if (event.data.error) {
                finish();
                toast(event.data.error, true);
            } };
            worker.onerror = () => { finish(); toast('时序计算模块加载失败，请检查服务是否正常运行', true); };
            worker.postMessage({ network, settings });
        }
        catch (error) {
            worker?.terminate();
            worker = null;
            body.inert = false;
            button.textContent = '运行分析';
            toast(error.message, true);
        }
    });
    dialog.querySelector('#hyd-sim-back').addEventListener('click', () => dialog.close());
    dialog.querySelector('#hyd-sim-export').addEventListener('click', () => { if (!output)
        return; const url = URL.createObjectURL(new Blob([simulationToCSV(output, true)], { type: 'text/csv;charset=utf-8' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = projectName + '-管网时序.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    dialog.addEventListener('close', () => { worker?.terminate(); if (!returned) {
        returned = true;
        onBack(clone(network));
    } }, { once: true });
    render();
}
//# sourceMappingURL=hydraulic-simulation-panel.js.map