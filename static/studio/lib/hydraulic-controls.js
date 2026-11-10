export const MIN_CONTROL_HYSTERESIS = .001; // one millimetre, preventing zero-width relay chatter
export function validateHydraulicControls(controls) {
    if (controls === undefined)
        return;
    if (!Array.isArray(controls) || controls.length > 50)
        throw new RangeError('自动液位策略最多支持 50 条。');
    const ids = new Set();
    for (const control of controls) {
        if (!control || typeof control.id !== 'string' || !control.id || ids.has(control.id) || typeof control.enabled !== 'boolean' || typeof control.tankId !== 'string' || typeof control.linkId !== 'string' || !['pump', 'valve', 'pipe'].includes(control.device) || !['fill', 'drain'].includes(control.strategy))
            throw new RangeError('自动液位策略格式无效。');
        ids.add(control.id);
        for (const level of [control.lowLevel, control.highLevel])
            if (level !== null && (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1e7))
                throw new RangeError('自动控制液位须为非负有限数或待填写。');
        if (control.lowLevel !== null && control.highLevel !== null && control.highLevel - control.lowLevel < MIN_CONTROL_HYSTERESIS - 1e-12)
            throw new RangeError('高液位须至少比低液位高 0.001 m，避免无滞回切换。');
    }
}
export function hydraulicControlProblems(network, controls = []) {
    const problems = [], links = new Set();
    for (const control of controls.filter(control => control.enabled)) {
        const tank = network.nodes.find(node => node.id === control.tankId), link = network.links.find(link => link.id === control.linkId);
        if (tank?.type !== 'tank' || !tank.tank || !link || control.device === 'pump' && !link.pump || control.device === 'valve' && !link.valve) {
            problems.push('自动策略的水池或设备已删除、未选择或类型不匹配，请重新选择。');
            continue;
        }
        if (links.has(link.id))
            problems.push(`${link.name} 同时存在多条启用自动策略，请仅保留一条。`);
        links.add(link.id);
        if (control.lowLevel === null || control.highLevel === null)
            problems.push(`${tank.name} 自动策略请填写低、高液位。`);
        else if (control.lowLevel < tank.tank.minLevel || control.highLevel > tank.tank.maxLevel)
            problems.push(`${tank.name} 自动阈值必须位于水池最低与最高液位之间。`);
    }
    return problems;
}
export function hydraulicDeviceActive(link, device) {
    return device === 'pump' ? link.pump.enabled : device === 'valve' ? link.valve.open : link.status !== 'closed';
}
/** A relay has one next switching threshold; state is retained within its hysteresis band. */
export function hydraulicControlThreshold(control, active) {
    const high = control.strategy === 'fill' ? active : !active;
    return { level: high ? control.highLevel : control.lowLevel, direction: high ? 1 : -1, active: !active, threshold: high ? 'high' : 'low' };
}
export function decideHydraulicControl(control, level, active) {
    if (!control.enabled)
        return null;
    const threshold = hydraulicControlThreshold(control, active);
    if (threshold.direction === 1 ? level < threshold.level : level > threshold.level)
        return null;
    return { controlId: control.id, tankId: control.tankId, linkId: control.linkId, device: control.device, active: threshold.active, threshold: threshold.threshold, level };
}
//# sourceMappingURL=hydraulic-controls.js.map