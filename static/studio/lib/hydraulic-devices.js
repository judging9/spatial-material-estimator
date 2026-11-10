export const MIN_PUMP_SPEED = .1;
export const MAX_PUMP_SPEED = 1.5;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export function validateDeviceInputs(link) {
    if (link.status !== undefined && !['open', 'closed'].includes(link.status))
        throw new RangeError('管段开闭状态无效。');
    if (link.checkValve !== undefined && typeof link.checkValve !== 'boolean')
        throw new RangeError('止回阀状态无效。');
    if (link.valve && (typeof link.valve.open !== 'boolean' || link.valve.lossCoefficient !== null && (!finite(link.valve.lossCoefficient) || link.valve.lossCoefficient < 0 || link.valve.lossCoefficient > 1e6)))
        throw new RangeError('节流阀 K 须为 0～1000000 或待填写。');
    if (link.pump) {
        if (typeof link.pump.enabled !== 'boolean' || !Array.isArray(link.pump.curve) || link.pump.curve.length > 50)
            throw new RangeError('泵曲线格式无效，最多支持 50 个点。');
        for (const point of link.pump.curve)
            if (!point || ['flow', 'head'].some(key => point[key] !== null && (!finite(point[key]) || point[key] < 0 || point[key] > 1e7)))
                throw new RangeError('泵曲线流量 L/s、扬程 m 须为非负有限数或待填写。');
        if (link.pump.speed !== undefined && link.pump.speed !== null)
            pumpSpeedRatio(link.pump);
    }
}
export function pumpCurveProblem(pump) {
    if (pump.speed === null)
        return '请填写泵转速比例（10%–150%）；停机请使用启停设置。';
    if (pump.curve.length < 2 || pump.curve.some(point => point.flow === null || point.head === null))
        return '请填写至少两个真实泵曲线点（流量 L/s、扬程 m）。';
    if (pump.curve[0].flow !== 0)
        return '泵曲线首点必须是 0 L/s 的关阀扬程。';
    for (let i = 1; i < pump.curve.length; i++)
        if (pump.curve[i].flow <= pump.curve[i - 1].flow || pump.curve[i].head > pump.curve[i - 1].head)
            return '泵曲线流量必须递增、扬程不得递增。';
    return null;
}
export function pumpSpeedRatio(pump) {
    const speed = pump.speed === undefined ? 1 : pump.speed;
    if (!finite(speed) || speed < MIN_PUMP_SPEED || speed > MAX_PUMP_SPEED)
        throw new RangeError('泵转速比例须为 0.1–1.5（10%–150%），停机使用启停，不能填写 0。');
    return speed;
}
export function pumpHeadAtFlow(pump, flowLiters) {
    const problem = pumpCurveProblem(pump);
    if (problem)
        throw new RangeError(problem);
    const points = pump.curve, speed = pumpSpeedRatio(pump);
    if (!finite(flowLiters) || flowLiters < 0 || flowLiters > speed * points.at(-1).flow + 1e-8)
        throw new RangeError('泵工作点超出当前转速对应的已输入曲线范围，禁止外推。');
    const q = Math.min(flowLiters / speed, points.at(-1).flow);
    const index = Math.max(1, points.findIndex(point => point.flow >= q));
    const a = points[index - 1], b = points[index], slope = (b.head - a.head) / (b.flow - a.flow);
    // Ideal affinity laws retain the rated user curve: H_s(Q)=s² H_1(Q/s).
    return { head: speed * speed * (a.head + (q - a.flow) * slope), slope: speed * slope };
}
export function validateTank(tank) {
    if (!tank || ['area', 'minLevel', 'maxLevel', 'initialLevel'].some(key => tank[key] !== null && (!finite(tank[key]) || tank[key] < 0 || tank[key] > 1e7)))
        throw new RangeError('水池面积与液位须为非负有限数或待填写。');
    if (tank.area !== null && tank.area < 1e-6)
        throw new RangeError('水池横截面积不得小于 0.000001 m²。');
    if (tank.minLevel !== null && tank.maxLevel !== null && tank.maxLevel <= tank.minLevel)
        throw new RangeError('最高液位必须大于最低液位。');
    if (tank.initialLevel !== null && (tank.minLevel !== null && tank.initialLevel < tank.minLevel || tank.maxLevel !== null && tank.initialLevel > tank.maxLevel))
        throw new RangeError('初始液位须位于上下限之间。');
}
//# sourceMappingURL=hydraulic-devices.js.map