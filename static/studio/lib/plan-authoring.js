import { validatePolygon, validateRegion } from './geometry.js';
const EPS = 1e-7;
const precise = (value) => Math.round(value * 1e8) / 1e8;
function finite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new RangeError(`${label}必须是有效数字`);
    return value;
}
function centimetres(meters, label) {
    finite(meters, label);
    if (meters < .1 || meters > 100)
        throw new RangeError(`${label}须在 0.1–100 米之间`);
    return precise(meters * 100);
}
function checkedPoints(points) {
    if (!Array.isArray(points) || points.length < 3 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        throw new RangeError('房间轮廓需要至少三个有效顶点');
    }
}
/** User-entered dimensions are net interior dimensions, without an implicit wall offset. */
export function makeRoomPoints(shape, widthMeters, depthMeters, origin = { x: 0, y: 0 }, cutWidthMeters, cutDepthMeters) {
    const width = centimetres(widthMeters, '房间宽度');
    const depth = centimetres(depthMeters, '房间进深');
    finite(origin?.x, '房间位置');
    finite(origin?.y, '房间位置');
    let local;
    if (shape === 'rectangle') {
        local = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: depth }, { x: 0, y: depth }];
    }
    else if (shape === 'l-shape') {
        const cutWidth = cutWidthMeters == null ? width / 2 : finite(cutWidthMeters, '缺口宽度') * 100;
        const cutDepth = cutDepthMeters == null ? depth / 2 : finite(cutDepthMeters, '缺口进深') * 100;
        if (cutWidth <= 0 || cutWidth >= width || cutDepth <= 0 || cutDepth >= depth) {
            throw new RangeError('L 形缺口尺寸须大于零，且小于房间对应的总尺寸');
        }
        const innerX = width - cutWidth, innerY = depth - cutDepth;
        local = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: innerY }, { x: innerX, y: innerY }, { x: innerX, y: depth }, { x: 0, y: depth }];
    }
    else
        throw new RangeError('不支持的房间形状');
    return local.map(p => ({ x: precise(origin.x + p.x), y: precise(origin.y + p.y) }));
}
/** Bounding dimensions remain in centimetres, matching the drawing coordinate system. */
export function roomBounds(room) {
    const points = Array.isArray(room) ? room : room?.points;
    checkedPoints(points);
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: precise(Math.max(...xs) - x), depth: precise(Math.max(...ys) - y) };
}
/** A dimension edit applies only to an axis-aligned, four-corner rectangle. */
export function isRectangle(points) {
    if (!Array.isArray(points) || points.length !== 4 || !validatePolygon(points).valid)
        return false;
    const { x, y, width, depth } = roomBounds(points);
    if (width <= EPS || depth <= EPS)
        return false;
    const close = (a, b) => Math.abs(a - b) <= EPS;
    return points.every((p, i) => {
        const next = points[(i + 1) % points.length];
        return (close(p.x, x) || close(p.x, x + width)) && (close(p.y, y) || close(p.y, y + depth))
            && (close(p.x, next.x) !== close(p.y, next.y));
    });
}
/** Resize about the top-left corner, retaining metadata, order and all material items. */
export function resizeRoom(room, widthMeters, depthMeters) {
    if (!isRectangle(room.points) || room.holes?.length)
        throw new RangeError('长宽编辑适用于无孔洞的矩形房间；其他轮廓请拖动顶点调整');
    const width = centimetres(widthMeters, '房间宽度'), depth = centimetres(depthMeters, '房间进深');
    const previous = roomBounds(room);
    return { ...room, points: room.points.map(p => ({
            x: precise(previous.x + (p.x - previous.x) / previous.width * width),
            y: precise(previous.y + (p.y - previous.y) / previous.depth * depth),
        })), holes: [] };
}
/** Translation never changes area, perimeter, hole relationships or quote parameters. */
export function translateRegion(room, dx, dy) {
    finite(dx, '水平移动距离');
    finite(dy, '垂直移动距离');
    checkedPoints(room.points);
    const translate = (points) => points.map(p => ({ x: precise(p.x + dx), y: precise(p.y + dy) }));
    return { ...room, points: translate(room.points), holes: (room.holes ?? []).map(translate) };
}
function intervalGap(a0, a1, b0, b1) {
    return Math.max(0, b0 - a1, a0 - b1);
}
/**
 * Snap a dragged room to the centimetre grid and nearby room edges. The screen
 * tolerance stays 8 px across zoom levels; distant rows/columns do not attract it.
 * The caller must validate overlap/bounds before accepting the translated region.
 */
export function snapRoomTranslation(room, dx, dy, others, zoom, options = {}) {
    finite(dx, '水平移动距离');
    finite(dy, '垂直移动距离');
    finite(zoom, '画布缩放');
    const step = options.step ?? 10, tolerancePixels = options.tolerancePixels ?? 8;
    if (zoom <= 0 || !Number.isFinite(step) || step <= 0 || !Number.isFinite(tolerancePixels) || tolerancePixels < 0)
        throw new RangeError('吸附设置无效');
    if (!Array.isArray(others))
        throw new RangeError('其他房间数据格式不正确');
    const original = roomBounds(room), tolerance = tolerancePixels / zoom;
    const proposed = { x: original.x + dx, y: original.y + dy, width: original.width, depth: original.depth };
    const grid = options.grid !== false;
    let x = grid ? Math.round(proposed.x / step) * step : proposed.x;
    let y = grid ? Math.round(proposed.y / step) * step : proposed.y;
    let bestX = null;
    let bestY = null;
    const consider = (current, delta, target) => {
        if (Math.abs(delta) > tolerance + EPS || current && Math.abs(delta) >= Math.abs(current.delta) - EPS)
            return current;
        return { delta, target };
    };
    for (const other of others) {
        if (other.hidden || other === room || room.id != null && other.id === room.id)
            continue;
        const target = roomBounds(other);
        if (intervalGap(proposed.y, proposed.y + proposed.depth, target.y, target.y + target.depth) <= tolerance) {
            // Opposite edges are considered first: prefer touching rooms at equal distances.
            const pairs = [[proposed.x, target.x + target.width], [proposed.x + proposed.width, target.x], [proposed.x, target.x], [proposed.x + proposed.width, target.x + target.width]];
            for (const [from, to] of pairs)
                bestX = consider(bestX, to - from, to);
        }
        if (intervalGap(proposed.x, proposed.x + proposed.width, target.x, target.x + target.width) <= tolerance) {
            const pairs = [[proposed.y, target.y + target.depth], [proposed.y + proposed.depth, target.y], [proposed.y, target.y], [proposed.y + proposed.depth, target.y + target.depth]];
            for (const [from, to] of pairs)
                bestY = consider(bestY, to - from, to);
        }
    }
    const guides = [];
    if (bestX) {
        x = proposed.x + bestX.delta;
        guides.push({ axis: 'x', value: bestX.target });
    }
    if (bestY) {
        y = proposed.y + bestY.delta;
        guides.push({ axis: 'y', value: bestY.target });
    }
    return { dx: precise(x - original.x), dy: precise(y - original.y), guides };
}
/** Find a deterministic adjoining free position, with real polygon overlap checks. */
export function findRoomPlacement(points, others, drawingW = 2400, drawingH = 1800) {
    checkedPoints(points);
    finite(drawingW, '画布宽度');
    finite(drawingH, '画布进深');
    if (drawingW <= 0 || drawingH <= 0 || !Array.isArray(others))
        throw new RangeError('画布或房间数据无效');
    const validation = validatePolygon(points);
    if (!validation.valid)
        throw new RangeError(validation.error);
    const bounds = roomBounds(points), width = bounds.width, depth = bounds.depth;
    if (width > drawingW + EPS || depth > drawingH + EPS)
        throw new RangeError('房间尺寸超出当前画布，请缩小房间或扩大画布');
    const local = points.map(p => ({ x: p.x - bounds.x, y: p.y - bounds.y }));
    const start = { x: Math.min(100, (drawingW - width) / 2), y: Math.min(100, (drawingH - depth) / 2) };
    const candidates = [];
    const xs = new Set([0, start.x, drawingW - width]);
    const ys = new Set([0, start.y, drawingH - depth]);
    for (const other of [...others].reverse()) {
        const b = roomBounds(other);
        candidates.push({ x: b.x + b.width, y: b.y }, { x: b.x, y: b.y + b.depth }, { x: b.x - width, y: b.y }, { x: b.x, y: b.y - depth });
        for (const x of [b.x, b.x + b.width, b.x - width, b.x + b.width - width])
            xs.add(x);
        for (const y of [b.y, b.y + b.depth, b.y - depth, b.y + b.depth - depth])
            ys.add(y);
    }
    candidates.push(start, { x: 0, y: 0 });
    for (const y of ys)
        for (const x of xs)
            candidates.push({ x, y });
    const visited = new Set();
    for (const candidate of candidates) {
        const x = precise(candidate.x), y = precise(candidate.y), key = `${x},${y}`;
        if (visited.has(key))
            continue;
        visited.add(key);
        if (x < 0 || y < 0 || x + width > drawingW + EPS || y + depth > drawingH + EPS)
            continue;
        const placed = { points: local.map(p => ({ x: precise(x + p.x), y: precise(y + p.y) })), holes: [] };
        const result = validateRegion(placed, others);
        if (result.valid)
            return { x, y };
        if (result.code === 'invalid_other_region')
            throw new RangeError(result.error);
    }
    throw new RangeError('当前画布没有合适的位置，请缩小房间或先移动已有房间');
}
//# sourceMappingURL=plan-authoring.js.map