import { normalizeWalls } from './wall-plan.js';
import { wallShapeSelection } from './wall-shape-selection.js';
const RAD = Math.PI / 180, TAU = Math.PI * 2;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 1_000_000 && Math.abs(p.y) <= 1_000_000;
const amount = (value, label) => {
    const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
    const match = /^[+\-]?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+\-]?\d+))?$/i.exec(text);
    const whole = match?.[1] ?? '0', fraction = match?.[2] ?? match?.[3] ?? '', exponent = Number(match?.[4] ?? 0);
    if (!text || text.length > 72 || !match || !Number.isFinite(Number(text)) || Number(text) < 0 || Math.abs(exponent) > 30 || whole.length + fraction.length > 48 || fraction.length - exponent > 48 || whole.length + Math.max(0, exponent - fraction.length) > 48)
        throw new RangeError(label + '必须是有效范围内的非负数。');
};
/** Imported curve metadata must describe its actual member walls. It never
 * grants permission to invent a radius, length, area or extra priced instance. */
export function validateWallShapes(project) {
    if (project.wallShapes === undefined)
        return;
    if (!Array.isArray(project.wallShapes) || project.wallShapes.length > 200)
        throw new RangeError('曲线墙分组数据无效。');
    const walls = normalizeWalls(project.walls ?? []), wallMap = new Map(walls.map(w => [w.id, w])), ids = new Set(), owned = new Set();
    for (const shape of project.wallShapes) {
        if (!shape || typeof shape.id !== 'string' || !shape.id.trim() || shape.id.length > 200 || ids.has(shape.id) || wallMap.has(shape.id) || project.regions?.some(r => r.id === shape.id))
            throw new RangeError('曲线墙分组编号无效或重复。');
        ids.add(shape.id);
        if (!['circle', 'arc'].includes(shape.kind) || typeof shape.name !== 'string' || !shape.name.trim() || shape.name.length > 200 || !finitePoint(shape.center))
            throw new RangeError('曲线墙名称、类型或中心坐标无效。');
        if (!Number.isFinite(shape.radius) || shape.radius <= 0 || shape.radius > 1_000_000 || !Number.isFinite(shape.startDegrees) || shape.startDegrees < 0 || shape.startDegrees >= 360 || !Number.isFinite(shape.sweepDegrees) || !shape.sweepDegrees || Math.abs(shape.sweepDegrees) > 360 || shape.kind === 'circle' && Math.abs(Math.abs(shape.sweepDegrees) - 360) > 1e-8 || shape.kind === 'arc' && Math.abs(shape.sweepDegrees) >= 360)
            throw new RangeError('曲线墙半径或角度无效。');
        if (!Number.isFinite(shape.maxDeviation) || shape.maxDeviation < 0 || shape.maxDeviation > .500001 || !['both', 'left', 'right'].includes(shape.finishSide ?? 'both'))
            throw new RangeError('曲线墙精度或施工侧面无效。');
        if (!Array.isArray(shape.wallIds) || shape.wallIds.length < (shape.kind === 'circle' ? 3 : 1) || shape.wallIds.length > 200 || shape.wallIds.some(id => typeof id !== 'string' || !wallMap.has(id) || owned.has(id)) || new Set(shape.wallIds).size !== shape.wallIds.length)
            throw new RangeError('曲线墙成员缺失、重复或属于多个分组。');
        const members = shape.wallIds.map(id => wallMap.get(id));
        const thickness = members[0].thickness, height = members[0].height ?? project.wallHeight ?? 280;
        let swept = 0, deviation = 0;
        const sign = Math.sign(shape.sweepDegrees), positive = (a) => ((a % TAU) + TAU) % TAU;
        const first = { x: shape.center.x + shape.radius * Math.cos(shape.startDegrees * RAD), y: shape.center.y + shape.radius * Math.sin(shape.startDegrees * RAD) };
        const last = { x: shape.center.x + shape.radius * Math.cos((shape.startDegrees + shape.sweepDegrees) * RAD), y: shape.center.y + shape.radius * Math.sin((shape.startDegrees + shape.sweepDegrees) * RAD) };
        if (distance(members[0].start, first) > 1e-4 || distance(members[members.length - 1].end, last) > 1e-4)
            throw new RangeError('曲线墙端点与圆弧参数不一致。');
        for (let i = 0; i < members.length; i++) {
            const wall = members[i];
            owned.add(wall.id);
            if (wall.additionalCost !== undefined)
                amount(wall.additionalCost, '成员附加费');
            if (wall.items?.length || wall.additionalCost !== undefined && Number(wall.additionalCost) !== 0)
                throw new RangeError('曲线墙成员不能独立计价，请将材料和附加费设置到整组。');
            if (Math.abs(wall.thickness - thickness) > 1e-8 || Math.abs((wall.height ?? project.wallHeight ?? 280) - height) > 1e-8)
                throw new RangeError('同一曲线墙的墙厚和墙高必须一致。');
            if (Math.abs(distance(wall.start, shape.center) - shape.radius) > 1e-4 || Math.abs(distance(wall.end, shape.center) - shape.radius) > 1e-4 || i && distance(members[i - 1].end, wall.start) > 1e-5)
                throw new RangeError('曲线墙成员不在指定圆上或未连续连接。');
            const a = Math.atan2(wall.start.y - shape.center.y, wall.start.x - shape.center.x), b = Math.atan2(wall.end.y - shape.center.y, wall.end.x - shape.center.x), step = positive(sign * (b - a));
            if (step < 1e-10 || step > 5 * RAD + 1e-7)
                throw new RangeError('曲线墙成员角度超过 5° 或方向不一致。');
            swept += step;
            deviation = Math.max(deviation, shape.radius * (1 - Math.cos(step / 2)));
        }
        if (Math.abs(swept - Math.abs(shape.sweepDegrees) * RAD) > 1e-6 || Math.abs(deviation - shape.maxDeviation) > 1e-5)
            throw new RangeError('曲线墙扫过角或弦偏差与实际几何不一致。');
        if (!Array.isArray(shape.items))
            throw new RangeError('曲线墙材料项目无效。');
        const itemIds = new Set();
        for (const item of shape.items) {
            if (!item || typeof item.id !== 'string' || !item.id.trim() || itemIds.has(item.id) || !['area', 'perimeter', 'manual'].includes(item.quantityMode ?? 'area'))
                throw new RangeError('曲线墙计价项目无效或重复。');
            itemIds.add(item.id);
            for (const field of ['unitPrice', 'wasteRate', 'laborRate', 'additionalCost'])
                if (item[field] !== undefined)
                    amount(item[field], '曲线墙' + field);
            if ((item.quantityMode ?? 'area') === 'manual' && item.quantity !== undefined)
                amount(item.quantity, '手工数量');
        }
        amount(shape.additionalCost ?? '0', '曲线墙附加费');
    }
}
export function shapeForWall(project, wallId) {
    return project.wallShapes?.find(shape => shape.wallIds.includes(wallId)) ?? null;
}
/** Set group scope for measurement only; group items remain authoritative and
 * are priced once. Raw saved member materials are never duplicated here. */
export function wallShapeMeasurementProject(project) {
    const byWall = new Map((project.wallShapes ?? []).flatMap(shape => shape.wallIds.map(id => [id, shape])));
    return { ...project, walls: project.walls?.map(wall => { const shape = byWall.get(wall.id); return shape ? { ...wall, finishSide: shape.finishSide ?? 'both', items: [] } : wall; }) };
}
export function shapeWallMetrics(shape, solid) {
    const values = shape.wallIds.map(id => solid.metrics.find(metric => metric.id === id));
    if (values.some(value => !value || value.side !== (shape.finishSide ?? 'both')))
        throw new RangeError('曲线墙计量数据缺失或侧面不一致。');
    const selection = wallShapeSelection(solid.surfaces, shape.wallIds, shape.finishSide ?? 'both');
    const sum = (key) => Number(values.reduce((total, value) => total + Number(value[key]), 0).toFixed(10));
    return { id: shape.id, side: shape.finishSide ?? 'both', grossArea: sum('grossArea'), openingArea: sum('openingArea'), netArea: sum('netArea'),
        leftArea: sum('leftArea'), rightArea: sum('rightArea'), endArea: sum('endArea'), revealArea: sum('revealArea'), perimeter: Number(selection.perimeter.toFixed(10)) };
}
//# sourceMappingURL=wall-shapes.js.map