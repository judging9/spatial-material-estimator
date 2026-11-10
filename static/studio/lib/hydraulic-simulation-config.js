import { validateHydraulicControls } from './hydraulic-controls.js';
import { MAX_PUMP_SPEED, MIN_PUMP_SPEED } from './hydraulic-devices.js';
export const MAX_SIMULATION_DURATION = 604800;
export const MAX_SIMULATION_STEPS = 20000;
export function validateSimulationSettings(value) {
    if (value === undefined)
        return;
    if (!value || !Array.isArray(value.events) || value.events.length > 200)
        throw new RangeError('时序设置无效，最多支持 200 个事件。');
    validateHydraulicControls(value.controls);
    for (const key of ['duration', 'step'])
        if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < .001 || value[key] > MAX_SIMULATION_DURATION))
            throw new RangeError('时长与输出步长须为 0.001～604800 秒或待填写。');
    const ids = new Set();
    for (const event of value.events) {
        if (!event || typeof event.id !== 'string' || !event.id || ids.has(event.id) || typeof event.targetId !== 'string' || !['demand', 'head', 'pump', 'valve', 'pipe', 'speed'].includes(event.kind))
            throw new RangeError('时序事件编号、目标或类型无效。');
        ids.add(event.id);
        if (event.time !== null && (typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time < 0 || event.time > MAX_SIMULATION_DURATION))
            throw new RangeError('事件时间须为非负秒数或待填写。');
        if (event.value !== null && (['demand', 'head', 'speed'].includes(event.kind) ? typeof event.value !== 'number' || !Number.isFinite(event.value) || Math.abs(event.value) > 1e7 || event.kind === 'speed' && (event.value < MIN_PUMP_SPEED || event.value > MAX_PUMP_SPEED) : event.kind === 'pipe' ? !['open', 'closed'].includes(String(event.value)) : typeof event.value !== 'boolean'))
            throw new RangeError(event.kind === 'speed' ? '泵转速事件须填 10%–150%，停机使用泵启停事件。' : '时序事件目标值无效。');
    }
}
//# sourceMappingURL=hydraulic-simulation-config.js.map