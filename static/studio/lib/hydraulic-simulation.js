import { solveHydraulicNetwork, validateHydraulicNetwork } from './hydraulics.js';
import { MAX_SIMULATION_STEPS, validateSimulationSettings } from './hydraulic-simulation-config.js';
import { decideHydraulicControl, hydraulicControlProblems, hydraulicControlThreshold, hydraulicDeviceActive } from './hydraulic-controls.js';
const clone = (value) => structuredClone(value);
function summarizeWarnings(frames) {
    const minimum = new Map(), other = new Set();
    for (const frame of frames) {
        const negative = frame.result.nodes.filter(node => node.pressureHead !== null && node.pressureHead < -1e-8);
        for (const node of negative)
            if (!minimum.has(node.id) || node.pressureHead < minimum.get(node.id).head)
                minimum.set(node.id, { name: node.name, head: node.pressureHead, time: frame.time });
        for (const warning of frame.result.warnings)
            if (!negative.some(node => warning.startsWith(node.name + ' 压力水头为负（')))
                other.add(warning);
    }
    return [...minimum.values()].map(value => `${value.name} 最低压力水头 ${value.head.toFixed(6)} m，发生在 ${value.time.toFixed(6)} 秒；当前供水边界不能保证正压。`).concat([...other]);
}
/** Quasi-steady network states coupled to actual tank storage. This is not water hammer. */
export function simulateHydraulicNetwork(original, settings = original.simulation, progress) {
    const output = { status: 'pending', messages: [], warnings: [], frames: [], controlLog: [], pumpSpeedLog: [], steps: 0, completedTime: 0, maxMassBalanceError: 0 };
    try {
        validateHydraulicNetwork(original);
        validateSimulationSettings(settings);
    }
    catch (error) {
        output.messages.push(error.message);
        return output;
    }
    if (original.mode !== 'pressure') {
        output.messages.push('时序分析支持准稳态压力管网与水池储水，重力网暂不支持动态波。');
        return output;
    }
    if (!settings || settings.duration === null || settings.step === null) {
        output.messages.push('请填写模拟时长和输出步长。');
        return output;
    }
    if (Math.ceil(settings.duration / settings.step) > MAX_SIMULATION_STEPS) {
        output.messages.push(`输出超过 ${MAX_SIMULATION_STEPS} 帧，请增大输出步长。`);
        return output;
    }
    const network = clone(original), tanks = network.nodes.filter(node => node.type === 'tank');
    if (tanks.some(node => !node.tank || Object.values(node.tank).some(value => value === null))) {
        output.messages.push('请填写水池面积与最低/最高/初始液位。');
        return output;
    }
    const events = clone(settings.events).sort((a, b) => a.time - b.time);
    const controls = clone(settings.controls ?? []).filter(control => control.enabled);
    output.messages.push(...hydraulicControlProblems(network, controls));
    const duplicate = new Set();
    for (const event of events) {
        if (event.time === null || event.value === null || event.time > settings.duration) {
            output.messages.push('每个事件须填写时间与值，并位于模拟时长内。');
            continue;
        }
        const node = network.nodes.find(node => node.id === event.targetId), link = network.links.find(link => link.id === event.targetId);
        const valid = event.kind === 'demand' ? node && ['junction', 'tank'].includes(node.type) : event.kind === 'head' ? node?.type === 'reservoir' : event.kind === 'pump' || event.kind === 'speed' ? link?.pump : event.kind === 'valve' ? link?.valve : link;
        if (!valid)
            output.messages.push('事件目标已删除、缺少设备或类型不匹配，请重新选择。');
        const key = [event.time, event.kind, event.targetId].join(':');
        if (duplicate.has(key))
            output.messages.push('同一时刻不能重复设置同一目标属性。');
        duplicate.add(key);
    }
    if (output.messages.length)
        return output;
    const initialLevels = tanks.map(node => node.tank.initialLevel), areas = tanks.map(node => node.tank.area);
    let levels = [...initialLevels], time = 0, nextEvent = 0, reservoirVolume = 0, demandVolume = 0;
    const applyEvent = (event) => {
        const node = network.nodes.find(node => node.id === event.targetId), link = network.links.find(link => link.id === event.targetId);
        const before = ['pump', 'valve', 'pipe'].includes(event.kind) ? hydraulicDeviceActive(link, event.kind) : null;
        if (event.kind === 'demand')
            node.demand = event.value;
        else if (event.kind === 'head')
            node.head = event.value;
        else if (event.kind === 'pump')
            link.pump.enabled = event.value;
        else if (event.kind === 'valve')
            link.valve.open = event.value;
        else if (event.kind === 'speed') {
            link.pump.speed = event.value;
            output.pumpSpeedLog.push({ time, eventId: event.id, linkId: link.id, name: link.name, speedRatio: event.value });
        }
        else
            link.status = event.value;
        if (before !== null) {
            const active = event.kind === 'pipe' ? event.value === 'open' : event.value === true;
            output.controlLog.push({ time, source: 'schedule', eventId: event.id, linkId: link.id, name: link.name, device: event.kind, active, reason: `定时事件${before === active ? '设置，设备状态保持' : '改变设备状态'}；同一时刻随后执行液位规则` });
        }
    };
    const applyAutomatic = (forced = []) => {
        for (const control of controls) {
            const link = network.links.find(link => link.id === control.linkId), index = tanks.findIndex(tank => tank.id === control.tankId), active = hydraulicDeviceActive(link, control.device);
            const action = forced.find(action => action.controlId === control.id) ?? decideHydraulicControl(control, levels[index], active);
            if (!action || action.active === active)
                continue;
            if (output.controlLog.length >= MAX_SIMULATION_STEPS)
                throw new RangeError('自动/定时设备动作达到 20,000 条上限，请扩大滞回液位差或缩短模拟。');
            if (action.device === 'pump')
                link.pump.enabled = action.active;
            else if (action.device === 'valve')
                link.valve.open = action.active;
            else
                link.status = action.active ? 'open' : 'closed';
            output.controlLog.push({ time, source: 'automatic', controlId: control.id, tankId: control.tankId, linkId: link.id, name: link.name, device: control.device, active: action.active, level: levels[index], reason: `${tanks[index].name} 达到${action.threshold === 'low' ? '低' : '高'}液位，${control.strategy === 'fill' ? '补水' : '排水'}策略${action.active ? '开启' : '关闭'}` });
        }
    };
    const solveAt = (values) => {
        const state = clone(network);
        // Tank head is a Dirichlet boundary for the steady solve; its demand is accounted in storage ODE.
        tanks.forEach((tank, i) => { const node = state.nodes.find(node => node.id === tank.id); node.type = 'reservoir'; node.head = tank.elevation + values[i]; });
        const result = solveHydraulicNetwork(state);
        if (result.status !== 'ready')
            throw new RangeError(result.messages.join(' '));
        tanks.forEach(tank => { result.nodes.find(row => row.id === tank.id).demand = tank.demand; });
        const rates = tanks.map((tank, i) => -(result.nodes.find(row => row.id === tank.id).supply + tank.demand) / 1000 / areas[i]);
        const reservoirRate = network.nodes.filter(node => node.type === 'reservoir').reduce((sum, node) => sum + result.nodes.find(row => row.id === node.id).supply / 1000, 0);
        const demandRate = network.nodes.filter(node => node.type === 'junction' || node.type === 'tank').reduce((sum, node) => sum + node.demand / 1000, 0);
        return { result, rates, reservoirRate, demandRate };
    };
    const storeFrame = (state) => {
        const storageChange = levels.reduce((sum, level, i) => sum + areas[i] * (level - initialLevels[i]), 0);
        const massBalanceError = storageChange - reservoirVolume + demandVolume;
        output.maxMassBalanceError = Math.max(output.maxMassBalanceError, Math.abs(massBalanceError));
        const frame = { time, tanks: tanks.map((tank, i) => ({ id: tank.id, name: tank.name, level: levels[i], volume: levels[i] * areas[i] })), result: state.result, reservoirVolume, demandVolume, storageChange, massBalanceError };
        if (output.frames.at(-1)?.time === time)
            output.frames[output.frames.length - 1] = frame;
        else
            output.frames.push(frame);
    };
    try {
        while (events[nextEvent]?.time === 0)
            applyEvent(events[nextEvent++]);
        applyAutomatic();
        const initial = solveHydraulicNetwork(network);
        if (initial.status !== 'ready') {
            output.messages.push(...initial.messages);
            return output;
        }
        let state = solveAt(levels), suggestedStep = Math.min(settings.step, 300), nextOutput = Math.min(settings.step, settings.duration);
        storeFrame(state);
        while (time < settings.duration) {
            const atBound = tanks.findIndex((tank, i) => levels[i] <= tank.tank.minLevel + 1e-10 && state.rates[i] < -1e-12 || levels[i] >= tank.tank.maxLevel - 1e-10 && state.rates[i] > 1e-12);
            if (atBound >= 0) {
                const bound = state.rates[atBound] < 0 ? 'min' : 'max';
                output.stop = { nodeId: tanks[atBound].id, bound, time };
                output.status = 'stopped';
                output.messages.push(`${tanks[atBound].name} 在 ${time.toFixed(6)} 秒达到${bound === 'min' ? '最低' : '最高'}液位，继续运行将越界，已停止。`);
                storeFrame(state);
                break;
            }
            if (output.steps >= MAX_SIMULATION_STEPS)
                throw new RangeError('自适应积分达到步数上限，请缩短时长或核对极端参数。');
            const target = Math.min(nextOutput, events[nextEvent]?.time ?? settings.duration, settings.duration);
            let dt = Math.min(suggestedStep, target - time);
            if (dt <= 0) {
                time = target;
            }
            else {
                const trial = (step) => {
                    const predictor = levels.map((level, i) => level + state.rates[i] * step), end = solveAt(predictor);
                    const corrected = levels.map((level, i) => level + (state.rates[i] + end.rates[i]) * step / 2);
                    const correctedState = solveAt(corrected);
                    return { end, corrected, correctedState, error: corrected.reduce((max, level, i) => Math.max(max, Math.abs(level - predictor[i]) / (1e-6 + 1e-6 * Math.abs(level))), 0) };
                };
                let candidate;
                for (;;) {
                    try {
                        candidate = trial(dt);
                        if (candidate.error <= 1)
                            break;
                        dt *= Math.max(.1, .8 / Math.sqrt(candidate.error));
                    }
                    catch (error) {
                        dt /= 2;
                        if (dt < 1e-12 || time + dt === time)
                            throw new RangeError('缩小积分步长后仍无法求解：' + error.message);
                    }
                    if (dt < 1e-12 || time + dt === time)
                        throw new RangeError('储水变化过快，无法达到液位积分精度。');
                }
                const crossing = tanks.flatMap((tank, index) => candidate.corrected[index] < tank.tank.minLevel ? [{ index, level: tank.tank.minLevel, direction: -1, bound: 'min' }] : candidate.corrected[index] > tank.tank.maxLevel ? [{ index, level: tank.tank.maxLevel, direction: 1, bound: 'max' }] : []);
                for (const control of controls) {
                    const index = tanks.findIndex(tank => tank.id === control.tankId), link = network.links.find(link => link.id === control.linkId), threshold = hydraulicControlThreshold(control, hydraulicDeviceActive(link, control.device));
                    if (threshold.direction === 1 ? levels[index] < threshold.level && candidate.corrected[index] >= threshold.level : levels[index] > threshold.level && candidate.corrected[index] <= threshold.level)
                        crossing.push({ index, level: threshold.level, direction: threshold.direction, action: { controlId: control.id, tankId: control.tankId, linkId: control.linkId, device: control.device, active: threshold.active, threshold: threshold.threshold, level: threshold.level } });
                }
                for (const hit of crossing) {
                    let lo = 0, hi = dt;
                    for (let k = 0; k < 55; k++) {
                        const mid = (lo + hi) / 2, value = trial(mid).corrected[hit.index];
                        if (hit.direction === -1 ? value > hit.level : value < hit.level)
                            lo = mid;
                        else
                            hi = mid;
                    }
                    hit.root = hi;
                }
                const first = crossing.length ? Math.min(...crossing.map(hit => hit.root)) : null;
                // Coalesce only floating-point roundoff at a scheduled timestamp. Integrate
                // the full remaining interval, preserving volume and schedule-before-relay order.
                const clockRoundoff = Number.EPSILON * Math.max(1, Math.abs(target)) * 16;
                const sameScheduledTime = first !== null && events[nextEvent]?.time === target && dt === target - time && Math.abs(first - dt) <= clockRoundoff && crossing.some(hit => hit.action && Math.abs(hit.root - first) <= clockRoundoff && Math.abs(candidate.corrected[hit.index] - hit.level) <= Number.EPSILON * Math.max(1, Math.abs(hit.level)) * 32);
                if (first !== null && !sameScheduledTime) {
                    dt = first;
                    candidate = trial(dt);
                }
                const hits = crossing.filter(hit => Math.abs(hit.root - dt) <= (sameScheduledTime ? clockRoundoff : Math.max(1e-12, Number.EPSILON * Math.max(1, time) * 4)) && Math.abs(candidate.corrected[hit.index] - hit.level) <= 1e-10 * Math.max(1, Math.abs(hit.level)));
                levels = candidate.corrected;
                reservoirVolume += dt * (state.reservoirRate + candidate.end.reservoirRate) / 2;
                demandVolume += dt * (state.demandRate + candidate.end.demandRate) / 2;
                time = dt === target - time ? target : time + dt;
                output.steps++;
                state = candidate.correctedState;
                suggestedStep = Math.min(settings.step, Math.max(dt, dt * Math.min(2, .9 / Math.sqrt(Math.max(candidate.error, .01)))));
                if (controls.length && hits.length) {
                    while (events[nextEvent]?.time === time)
                        applyEvent(events[nextEvent++]);
                    applyAutomatic(hits.flatMap(hit => hit.action ? [hit.action] : []));
                    state = solveAt(levels);
                    storeFrame(state);
                }
                const stop = hits.find(hit => hit.bound && (!controls.length || (hit.direction === -1 ? state.rates[hit.index] < -1e-12 : state.rates[hit.index] > 1e-12)));
                if (stop) {
                    output.stop = { nodeId: tanks[stop.index].id, bound: stop.bound, time };
                    output.status = 'stopped';
                    output.messages.push(`${tanks[stop.index].name} 在 ${time.toFixed(6)} 秒达到${stop.bound === 'min' ? '最低' : '最高'}液位，模拟停止；未裁切储水或虚构溢流。`);
                    storeFrame(state);
                    break;
                }
            }
            if (time === target) {
                while (events[nextEvent] && events[nextEvent].time === time)
                    applyEvent(events[nextEvent++]);
                applyAutomatic();
                state = solveAt(levels);
                storeFrame(state);
                if (time >= nextOutput)
                    nextOutput = Math.min(settings.duration, nextOutput + settings.step);
            }
            progress?.(time / settings.duration);
        }
        output.completedTime = time;
        if (output.status !== 'stopped') {
            output.status = 'ready';
            storeFrame(state);
        }
        output.messages.push('使用自适应 Heun 积分，液位局部误差控制 0.000001 m + 相对 0.000001；时间与体积守恒均按真实流量计算。');
        if (controls.length)
            output.messages.push('液位策略采用滞回，阈值由储水积分求触达时刻；定时事件先执行，再执行液位规则，滞回带内保留当前状态。');
        if (network.links.some(link => link.pump?.speed !== undefined))
            output.messages.push('转速使用理想泵相似定律换算额定曲线，不自动调压、不外推工作范围，也不模拟水锤。');
        if (output.maxMassBalanceError > 1e-5 * Math.max(1, Math.abs(reservoirVolume), Math.abs(demandVolume))) {
            output.status = 'error';
            output.messages.push('累计体积守恒误差超出精度，请核对计算。');
        }
    }
    catch (error) {
        output.status = 'pending';
        output.completedTime = time;
        output.messages.push(`在 ${time.toFixed(6)} 秒暂停：${error.message}`);
    }
    output.warnings = summarizeWarnings(output.frames);
    return output;
}
export function simulationToCSV(output, includePumpSpeed = false) {
    const rows = [['时间 s', '对象', '名称', '总水头 m', '压力水头 m', '需求 L/s', '边界供出 L/s', '管段流量 L/s', '速度 m/s', '损失 m', '泵扬程 m', '设备状态', '液位 m', '储水 m³', '累计水源供水 m³', '累计需求 m³', '储水变化 m³', '体积守恒误差 m³', '模拟状态']];
    if (includePumpSpeed)
        rows[0].push('泵转速比例');
    for (const frame of output.frames) {
        for (const node of frame.result.nodes) {
            const tank = frame.tanks.find(tank => tank.id === node.id);
            rows.push([frame.time, tank ? '水池' : '节点', node.name, node.head, node.pressureHead, node.demand, node.supply, '', '', '', '', '', tank?.level, tank?.volume, frame.reservoirVolume, frame.demandVolume, frame.storageChange, frame.massBalanceError, output.status]);
        }
        for (const link of frame.result.links)
            rows.push([frame.time, '管段', link.name, '', '', '', '', link.flow, link.velocity, link.headLoss, link.pumpHeadGain, link.deviceState, '', '', frame.reservoirVolume, frame.demandVolume, frame.storageChange, frame.massBalanceError, output.status, link.pumpSpeedRatio]);
    }
    for (const log of output.controlLog ?? [])
        rows.push([log.time, '控制动作', `${log.name} · ${log.source === 'automatic' ? '自动' : '定时'} · ${log.reason}`, '', '', '', '', '', '', '', '', `${log.device}:${log.active ? '开启' : '关闭'}`, log.level, '', '', '', '', '', output.status]);
    for (const log of output.pumpSpeedLog ?? [])
        rows.push([log.time, '转速设置', log.name, '', '', '', '', '', '', '', '', `${log.speedRatio * 100}%`, '', '', '', '', '', '', output.status, log.speedRatio]);
    const cell = (value) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
    return '\uFEFF' + rows.map(row => Array.from({ length: rows[0].length }, (_, index) => cell(row[index])).join(',')).join('\r\n') + '\r\n';
}
export function hydraulicControlLogToCSV(output) {
    const rows = [['时间 s', '来源', '设备', '目标名称', '动作', '液位 m', '说明', '事件编号', '策略编号', '水池编号', '管段编号']];
    for (const log of output.controlLog ?? [])
        rows.push([log.time, log.source === 'automatic' ? '液位自动调度' : '定时事件', log.device === 'pump' ? '泵' : log.device === 'valve' ? '节流阀' : '管段', log.name, log.active ? '开启' : '关闭', log.level, log.reason, log.eventId, log.controlId, log.tankId, log.linkId]);
    const cell = (value) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function pumpSpeedLogToCSV(output) {
    const rows = [['时间 s', '设备名称', '转速比例', '转速 %', '事件编号', '管段编号']];
    for (const log of output.pumpSpeedLog ?? [])
        rows.push([log.time, log.name, log.speedRatio, log.speedRatio * 100, log.eventId, log.linkId]);
    const cell = (value) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
//# sourceMappingURL=hydraulic-simulation.js.map