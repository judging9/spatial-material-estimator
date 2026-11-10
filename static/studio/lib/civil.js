import { normalizeDecimal, multiplyDecimal } from './pricing.js';
import { openingRegionParts } from './floor-openings.js';
import { polygonArea, polygonPerimeter, pointInRegion, validateRegion } from './geometry.js';
import { effectiveLevelProject, levelProjects } from './levels.js';
export const CIVIL_CATEGORIES = [{ id: 'foundation', name: '基础' }, { id: 'structure', name: '主体结构' }, { id: 'earthwork', name: '土方' }];
export const CIVIL_PRESETS = [
    { kind: 'column', name: '矩形柱', category: 'structure', color: '#82968a', width: 40, depth: 40, height: 300, elevation: 0 },
    { kind: 'roundColumn', name: '圆柱', category: 'structure', color: '#82968a', width: 40, depth: 40, height: 300, elevation: 0 },
    { kind: 'beam', name: '梁', category: 'structure', color: '#91a294', width: 30, depth: 400, height: 50, elevation: 250 },
    { kind: 'slab', name: '楼板', category: 'structure', color: '#aab5a7', width: 400, depth: 400, height: 15, elevation: 285 },
    { kind: 'padFooting', name: '独立基础', category: 'foundation', color: '#a29989', width: 160, depth: 160, height: 50, elevation: -50 },
    { kind: 'stripFooting', name: '条形基础', category: 'foundation', color: '#a29989', width: 80, depth: 400, height: 40, elevation: -40 },
    { kind: 'raft', name: '筏板基础', category: 'foundation', color: '#aaa28f', width: 400, depth: 400, height: 40, elevation: -40 },
    { kind: 'cushion', name: '基础垫层', category: 'foundation', color: '#b5aea0', width: 180, depth: 180, height: 10, elevation: -60 },
    { kind: 'masonry', name: '砌体墙', category: 'structure', color: '#b09c87', width: 20, depth: 400, height: 280, elevation: 0 },
    { kind: 'retainingWall', name: '挡土墙', category: 'structure', color: '#9caa98', width: 30, depth: 400, height: 200, elevation: 0 },
    { kind: 'excavation', name: '土方开挖', category: 'earthwork', color: '#c0ad94', width: 300, depth: 300, height: 100, elevation: -100 },
    { kind: 'backfill', name: '土方回填', category: 'earthwork', color: '#b4ad96', width: 300, depth: 300, height: 60, elevation: -60 },
];
export const MAX_CIVIL_ELEMENTS = 300;
export function civilPreset(kind) {
    const preset = CIVIL_PRESETS.find(item => item.kind === kind);
    if (!preset)
        throw new RangeError('土建构件类型不存在，请重新选择。');
    return preset;
}
const scaleOf = (project) => {
    const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
    return Number.isFinite(scale) && scale > 0 ? scale : null;
};
const cloneParts = (parts) => structuredClone(parts);
const partArea = (part) => polygonArea(part.points) - part.holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
const partsArea = (parts) => parts.reduce((sum, part) => sum + partArea(part), 0);
const uid = () => 'civil-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
const soil = (kind) => kind === 'excavation' || kind === 'backfill';
const priority = { cushion: 0, padFooting: 1, stripFooting: 2, raft: 3, column: 4, roundColumn: 4, retainingWall: 5, beam: 6, slab: 7, masonry: 8, excavation: 9, backfill: 10 };
const mapParts = (parts, transform) => parts.map(part => ({ points: part.points.map(transform), holes: part.holes.map(hole => hole.map(transform)) }));
function validateProfile(element) {
    if (element.profile === undefined)
        return;
    if (!['slab', 'raft'].includes(element.kind) || element.sourceRegionId !== undefined)
        throw new RangeError('独立轮廓仅适用于已解除房间关联的楼板或筏板。');
    const profile = element.profile;
    if (!Array.isArray(profile) || !profile.length || profile.length > 1000)
        throw new RangeError('楼板独立轮廓数据格式不正确。');
    for (const part of profile) {
        if (!part || part['surfaceParts'] !== undefined || !Array.isArray(part.points) || !Array.isArray(part.holes) || part.holes.some(hole => !Array.isArray(hole)))
            throw new RangeError('楼板独立轮廓及孔洞数据格式不正确。');
        for (const point of [part.points, ...part.holes].flat())
            if (!point || ![point.x, point.y].every(Number.isFinite) || Math.abs(point.x) > .5 || Math.abs(point.y) > .5)
                throw new RangeError('楼板独立轮廓局部坐标必须位于 -0.5 至 0.5 之间。');
    }
    // Validate in centimetres so small normalized features in a large slab do
    // not become degenerate merely because of the storage coordinate system.
    const parts = mapParts(profile, point => ({ x: point.x * element.width, y: point.y * element.depth }));
    const validity = validateRegion({ surfaceParts: parts });
    if (!validity.valid)
        throw new RangeError('楼板独立轮廓无效：' + validity.error);
}
export function validateCivilElements(value, project) {
    if (value === undefined)
        return;
    if (!Array.isArray(value) || value.length > MAX_CIVIL_ELEMENTS)
        throw new RangeError(`土建构件数据格式不正确，单层最多支持 ${MAX_CIVIL_ELEMENTS} 项。`);
    const ids = new Set();
    for (const element of value) {
        if (!element || typeof element.id !== 'string' || !element.id.trim() || ids.has(element.id))
            throw new RangeError('土建构件编号不能为空或重复。');
        ids.add(element.id);
        civilPreset(element.kind);
        if (typeof element.name !== 'string' || !element.name.trim() || element.name.length > 120)
            throw new RangeError('土建构件名称应为 1–120 字。');
        if (!element.position || ![element.position.x, element.position.y].every(Number.isFinite) || Math.abs(element.position.x) > 1e9 || Math.abs(element.position.y) > 1e9)
            throw new RangeError('土建构件位置必须是有效坐标。');
        for (const field of ['width', 'depth'])
            if (!Number.isFinite(element[field]) || element[field] < 1 || element[field] > 100000)
                throw new RangeError('构件宽、深应为 1–100000 cm。');
        if (!Number.isFinite(element.height) || element.height < .1 || element.height > 2000)
            throw new RangeError('构件高度 / 厚度应为 0.1–2000 cm。');
        if (!Number.isFinite(element.rotation))
            throw new RangeError('构件旋转角度必须是有效数字。');
        if (!Number.isFinite(element.elevation) || element.elevation < -5000 || element.elevation > 10000)
            throw new RangeError('构件底标高应为 -5000–10000 cm，相对本层。');
        if (element.kind === 'roundColumn' && Math.abs(element.width - element.depth) > 1e-8)
            throw new RangeError('圆柱宽、深必须使用相同直径。');
        if (!/^\d+$/.test(String(element.quantity)) || Number(element.quantity) < 1 || Number(element.quantity) > 1000000)
            throw new RangeError('构件数量应为 1–1000000 的整数。');
        for (const field of ['wasteRate', 'laborRate', 'additionalCost', 'rebarRatio', 'rebarQuantity'])
            normalizeDecimal(element[field], '土建计价参数');
        for (const field of ['unitPrice', 'formworkRate', 'rebarPrice'])
            if (element[field] !== '')
                normalizeDecimal(element[field], '土建单价');
        if (!['none', 'ratio', 'manual'].includes(element.rebarMode))
            throw new RangeError('钢筋依据应为不计、指标估算或用户公斤数。');
        for (const field of ['hidden', 'locked'])
            if (element[field] !== undefined && typeof element[field] !== 'boolean')
                throw new RangeError('构件显示或锁定状态格式不正确。');
        if (element.sourceRegionId !== undefined) {
            if (!['slab', 'raft'].includes(element.kind) || typeof element.sourceRegionId !== 'string' || !element.sourceRegionId.trim())
                throw new RangeError('只有楼板与筏板可关联房间轮廓。');
            if (project && !project.regions.some(region => region.id === element.sourceRegionId && region.points?.length >= 3))
                throw new RangeError('关联楼板 / 筏板的房间已不存在，请解除关联或重新选择房间。');
        }
        validateProfile(element);
    }
}
/** Native coordinates remain centimetres; uploaded images use the measured
 * XY scale. Profile sampling is shared by volume, ownership and rendering. */
function rawParts(element, project) {
    const scale = scaleOf(project);
    if (element.sourceRegionId) {
        const region = effectiveLevelProject(project).regions.find(region => region.id === element.sourceRegionId);
        if (!region)
            throw new RangeError('关联楼板房间不存在。');
        const validity = validateRegion(region);
        if (!validity.valid)
            throw new RangeError('土建楼板轮廓无效：' + validity.error);
        return scale ? cloneParts(region.surfaceParts ?? [{ points: region.points, holes: region.holes ?? [] }]) : null;
    }
    if (!scale)
        return null;
    const halfWidth = element.width * .01 / scale / 2, halfDepth = element.depth * .01 / scale / 2;
    const angle = element.kind === 'roundColumn' ? 0 : element.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    if (element.profile)
        return mapParts(element.profile, point => {
            const x = point.x * halfWidth * 2, y = point.y * halfDepth * 2;
            return { x: element.position.x + x * cos - y * sin, y: element.position.y + x * sin + y * cos };
        });
    const local = element.kind === 'roundColumn'
        ? Array.from({ length: 200 }, (_, i) => ({ x: halfWidth * Math.cos(i * Math.PI / 100), y: halfWidth * Math.sin(i * Math.PI / 100) }))
        : [{ x: -halfWidth, y: -halfDepth }, { x: halfWidth, y: -halfDepth }, { x: halfWidth, y: halfDepth }, { x: -halfWidth, y: halfDepth }];
    return [{ points: local.map(p => ({ x: element.position.x + p.x * cos - p.y * sin, y: element.position.y + p.x * sin + p.y * cos })), holes: [] }];
}
export function civilParts(element, project) {
    validateCivilElements([element], project);
    return rawParts(element, project);
}
export function civilFootprint(element, project) {
    return civilParts(element, project)?.[0]?.points ?? null;
}
function box(parts) {
    const points = parts.flatMap(part => part.points);
    return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}
function resolveEnvelope(element, project, parts) {
    const resolved = structuredClone(element), scale = scaleOf(project);
    if (!resolved.sourceRegionId || !parts || !scale)
        return resolved;
    const bounds = box(parts);
    resolved.position = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    resolved.width = (bounds.maxX - bounds.minX) * scale * 100;
    resolved.depth = (bounds.maxY - bounds.minY) * scale * 100;
    resolved.rotation = 0;
    return resolved;
}
/** Read current linked dimensions without mutating the saved element. */
export function civilResolvedElement(element, project) {
    return resolveEnvelope(element, project, civilParts(element, project));
}
/** Freeze the current exact source outline, including holes and retained
 * islands. Moving, rotating and resizing can then operate in local space. */
export function detachCivilElement(element, project) {
    const parts = civilParts(element, project), detached = resolveEnvelope(element, project, parts);
    if (!element.sourceRegionId)
        return detached;
    if (!parts)
        throw new RangeError('请先校准图纸比例，再解除楼板与房间的关联。');
    const bounds = box(parts), width = bounds.maxX - bounds.minX, depth = bounds.maxY - bounds.minY;
    detached.profile = mapParts(parts, point => ({
        x: Math.max(-.5, Math.min(.5, (point.x - bounds.minX) / width - .5)),
        y: Math.max(-.5, Math.min(.5, (point.y - bounds.minY) / depth - .5)),
    }));
    delete detached.sourceRegionId;
    validateCivilElements([detached], project);
    return detached;
}
const meets = (a, b) => a.maxX >= b.minX && b.maxX >= a.minX && a.maxY >= b.minY && b.maxY >= a.minY;
function subtract(parts, cuts) {
    if (!parts.length || !cuts.length)
        return cloneParts(parts);
    return openingRegionParts({ points: parts[0].points, holes: parts[0].holes, surfaceParts: parts }, cuts);
}
function inParts(point, parts) {
    return parts.some(part => pointInRegion(point, { points: part.points, holes: part.holes }));
}
const cross = (a, b) => a.x * b.y - a.y * b.x;
/** Split perimeter edges at actual neighbouring footprints before excluding
 * touching concrete. A bounding-box intersection is only a broad-phase test. */
function exposedPerimeter(parts, neighbours) {
    if (!neighbours.length)
        return parts.reduce((sum, part) => sum + polygonPerimeter(part.points) + part.holes.reduce((n, hole) => n + polygonPerimeter(hole), 0), 0);
    let length = 0;
    for (const part of parts)
        for (const ring of [part.points, ...part.holes])
            for (let i = 0; i < ring.length; i++) {
                const a = ring[i], b = ring[(i + 1) % ring.length], r = { x: b.x - a.x, y: b.y - a.y }, edgeLength = Math.hypot(r.x, r.y);
                if (!edgeLength)
                    continue;
                const ts = [0, 1];
                for (const neighbour of neighbours)
                    for (const outline of [neighbour.points, ...neighbour.holes])
                        for (let j = 0; j < outline.length; j++) {
                            const c = outline[j], d = outline[(j + 1) % outline.length], s = { x: d.x - c.x, y: d.y - c.y }, q = { x: c.x - a.x, y: c.y - a.y }, denominator = cross(r, s);
                            if (Math.abs(denominator) > 1e-10) {
                                const t = cross(q, s) / denominator, u = cross(q, r) / denominator;
                                if (t > 0 && t < 1 && u >= 0 && u <= 1)
                                    ts.push(t);
                            }
                            else if (Math.abs(cross(q, r)) < 1e-7 * edgeLength) {
                                for (const point of [c, d]) {
                                    const t = ((point.x - a.x) * r.x + (point.y - a.y) * r.y) / edgeLength ** 2;
                                    if (t > 0 && t < 1)
                                        ts.push(t);
                                }
                            }
                        }
                const sorted = [...new Set(ts)].sort((x, y) => x - y);
                for (let j = 1; j < sorted.length; j++) {
                    const t = (sorted[j - 1] + sorted[j]) / 2, point = { x: a.x + r.x * t, y: a.y + r.y * t }, offset = Math.max(1e-5, edgeLength * 1e-7);
                    const left = { x: point.x - r.y / edgeLength * offset, y: point.y + r.x / edgeLength * offset }, right = { x: point.x + r.y / edgeLength * offset, y: point.y - r.x / edgeLength * offset };
                    const outside = inParts(left, parts) ? right : left;
                    if (!inParts(outside, neighbours))
                        length += (sorted[j] - sorted[j - 1]) * edgeLength;
                }
            }
    return length;
}
const cache = new Map();
const MAX_CACHED_PROJECTS = 8;
// Ignore floating-point noise from equivalent rotations, while retaining
// physical coordinates. Ring start, direction, hole and part order are not
// identities and must not determine concrete ownership.
const physicalCoordinate = (value) => Number(value.toPrecision(14));
function canonicalRing(points, scale) {
    const coordinates = points.map(point => [physicalCoordinate(point.x * scale), physicalCoordinate(point.y * scale)]);
    const xs = coordinates.map(point => point[0]), ys = coordinates.map(point => point[1]);
    const epsilon = Math.max(1e-12, (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) * 1e-12);
    let changed = true;
    while (changed && coordinates.length > 3) {
        changed = false;
        for (let index = coordinates.length - 1; index >= 0 && coordinates.length > 3; index--) {
            const a = coordinates[(index - 1 + coordinates.length) % coordinates.length], b = coordinates[index], c = coordinates[(index + 1) % coordinates.length];
            const ab = [b[0] - a[0], b[1] - a[1]], bc = [c[0] - b[0], c[1] - b[1]];
            if (Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) <= epsilon * (Math.hypot(...ab) + Math.hypot(...bc)) && ab[0] * bc[0] + ab[1] * bc[1] >= -(epsilon ** 2)) {
                coordinates.splice(index, 1);
                changed = true;
            }
        }
    }
    let start = 0;
    for (let index = 1; index < coordinates.length; index++)
        if (coordinates[index][0] < coordinates[start][0] || coordinates[index][0] === coordinates[start][0] && coordinates[index][1] < coordinates[start][1])
            start = index;
    const forward = JSON.stringify(coordinates.map((_, index) => coordinates[(start + index) % coordinates.length]));
    const backward = JSON.stringify(coordinates.map((_, index) => coordinates[(start - index + coordinates.length) % coordinates.length]));
    return forward < backward ? forward : backward;
}
function canonicalParts(parts, scale) {
    return JSON.stringify(parts.map(part => [canonicalRing(part.points, scale), part.holes.map(hole => canonicalRing(hole, scale)).sort()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function ownershipOrder(a, b) {
    const structural = priority[a.element.kind] - priority[b.element.kind] || a.bottom - b.bottom || a.top - b.top;
    if (structural)
        return structural;
    if (a.ownershipBounds && b.ownershipBounds) {
        for (let index = 0; index < a.ownershipBounds.length; index++) {
            const difference = a.ownershipBounds[index] - b.ownershipBounds[index];
            if (difference)
                return difference;
        }
    }
    return a.ownershipShape.localeCompare(b.ownershipShape) || a.sequence - b.sequence;
}
/** One global ownership pass includes real storey elevations. Stable priority
 * is foundation → columns → retaining walls → beams → slabs → masonry.
 * Within a kind, physical geometry sets order; identical shapes use their
 * persisted placement order. IDs and prices never influence net quantities.
 * Excavation/backfill are different construction operations and not solids. */
export function buildCivilQuantities(project, override) {
    const layers = levelProjects(project), nodes = [];
    for (const layer of layers) {
        const elements = (layer.project.civilElements ?? []).map(element => override?.id === element.id ? override : element);
        if (override && layer.id === (project.activeLevelId ?? layers[0].id) && !layers.some(other => other.project.civilElements?.some(element => element.id === override.id)))
            elements.push(override);
        validateCivilElements(elements, layer.project);
        for (const element of elements) {
            const parts = rawParts(element, layer.project), scale = scaleOf(layer.project), bounds = parts ? box(parts) : null;
            nodes.push({ id: element.id, element: resolveEnvelope(element, layer.project, parts), project: layer.project, levelId: layer.id, levelName: layer.name, levelElevation: layer.elevation,
                metrics: null, parts, bottom: layer.elevation + element.elevation, top: layer.elevation + element.elevation + element.height,
                sequence: nodes.length, ownershipShape: parts ? canonicalParts(parts, scale) : '',
                ...(bounds ? { bounds, ownershipBounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map(value => physicalCoordinate(value * scale)) } : {}) });
        }
    }
    const key = JSON.stringify(nodes.map(node => [node.id, node.levelId, node.bottom, node.top, node.element.kind, node.parts, scaleOf(node.project), node.element.rebarMode, node.element.rebarRatio, node.element.rebarQuantity]));
    const cached = cache.get(key);
    if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return nodes.map((node, index) => ({ id: node.id, element: node.element, levelId: node.levelId, levelName: node.levelName, levelElevation: node.levelElevation, metrics: structuredClone(cached[index]) }));
    }
    const sorted = [...nodes].sort(ownershipOrder);
    const previous = [];
    for (const node of sorted) {
        const element = node.element, scale = scaleOf(node.project);
        if (!node.parts || !scale) {
            node.metrics = { grossVolume: null, netVolume: null, footprintArea: null, formworkArea: null, rebarQuantity: null, overlapVolume: null, slices: [], warnings: ['图纸尚未校准，不能计算土建实际用量。'] };
            previous.push(node);
            continue;
        }
        const footprintArea = partsArea(node.parts) * scale ** 2, grossVolume = footprintArea * element.height * .01;
        const neighbours = soil(element.kind) ? [] : nodes.filter(other => other !== node && !soil(other.element.kind) && other.parts && other.bottom < node.top && other.top > node.bottom && meets(node.bounds, other.bounds));
        const earlier = soil(element.kind) ? [] : previous.filter(other => !soil(other.element.kind) && other.parts && other.bottom < node.top && other.top > node.bottom && meets(node.bounds, other.bounds));
        const heights = [...new Set([node.bottom, node.top, ...neighbours.flatMap(other => [Math.max(node.bottom, other.bottom), Math.min(node.top, other.top)])])].sort((a, b) => a - b);
        const slices = [];
        let netVolume = 0, formworkArea = 0;
        for (let i = 1; i < heights.length; i++) {
            const bottom = heights[i - 1], top = heights[i], middle = (bottom + top) / 2;
            const cuts = earlier.filter(other => other.bottom < middle && other.top > middle).flatMap(other => other.parts);
            const parts = subtract(node.parts, cuts);
            if (!parts.length)
                continue;
            const height = top - bottom;
            netVolume += partsArea(parts) * scale ** 2 * height * .01;
            slices.push({ elevation: bottom - node.levelElevation, height, parts });
            if (!soil(element.kind) && element.kind !== 'masonry' && element.kind !== 'cushion') {
                const contacts = neighbours.filter(other => other.bottom < middle && other.top > middle).flatMap(other => other.parts);
                formworkArea += exposedPerimeter(parts, contacts) * scale * height * .01;
            }
        }
        if (['beam', 'slab'].includes(element.kind)) {
            const bottomSlice = slices.find(slice => Math.abs(slice.elevation - element.elevation) < 1e-7);
            if (bottomSlice) {
                const below = nodes.filter(other => other !== node && !soil(other.element.kind) && other.parts && other.bottom < node.bottom && other.top >= node.bottom && meets(node.bounds, other.bounds)).flatMap(other => other.parts);
                formworkArea += partsArea(subtract(bottomSlice.parts, below)) * scale ** 2;
            }
        }
        const overlapVolume = Math.max(0, grossVolume - netVolume);
        const warnings = [...(overlapVolume > 1e-9 ? ['已按基础→柱→梁→板→砌体优先归属扣除相交实体，重叠体积不重复计量。'] : []),
            ...(soil(element.kind) ? ['土方按本项施工操作计量；开挖与回填可处于同一空间，不互相抵扣。'] : []),
            ...(element.kind === 'roundColumn' ? ['圆柱采用与三维相同的 200 边圆形轮廓计算，曲线为几何近似。'] : []),
            ...(element.rebarMode === 'ratio' ? ['钢筋为用户填写 kg/m³ 指标估算，不是钢筋翻样量。'] : [])];
        const rebarQuantity = element.rebarMode === 'none' ? 0 : element.rebarMode === 'manual' ? Number(element.rebarQuantity) : Number(multiplyDecimal(netVolume, element.rebarRatio));
        node.metrics = { grossVolume, netVolume, footprintArea, formworkArea, rebarQuantity, overlapVolume, slices, warnings };
        previous.push(node);
    }
    cache.set(key, nodes.map(node => structuredClone(node.metrics)));
    if (cache.size > MAX_CACHED_PROJECTS)
        cache.delete(cache.keys().next().value);
    return nodes.map(node => ({ id: node.id, element: node.element, metrics: structuredClone(node.metrics), levelId: node.levelId, levelName: node.levelName, levelElevation: node.levelElevation }));
}
export function civilMetrics(element, project) {
    return buildCivilQuantities(project, element).find(row => row.id === element.id).metrics;
}
/** Linked slabs initially expose the real source envelope for handles; their
 * actual polygon, holes and retained islands remain source-derived. */
export function createCivilElement(kind, position, project) {
    const preset = civilPreset(kind), count = (project.civilElements ?? []).filter(element => element.kind === kind).length;
    const element = { id: uid(), name: preset.name + (count ? ' ' + (count + 1) : ''), kind, position: { ...position }, width: preset.width, depth: preset.depth, height: preset.height,
        rotation: 0, elevation: preset.elevation, quantity: '1', unitPrice: '', wasteRate: '0', laborRate: '0', additionalCost: '0', formworkRate: '', rebarMode: 'none', rebarRatio: '0', rebarQuantity: '0', rebarPrice: '', hidden: false, locked: false };
    const scale = scaleOf(project);
    if (scale && ['slab', 'raft'].includes(kind)) {
        const region = effectiveLevelProject(project).regions.filter(region => !region.hidden && region.points?.length >= 3 && pointInRegion(position, region)).sort((a, b) => polygonArea(a.points) - polygonArea(b.points))[0];
        if (region) {
            const bounds = box(region.surfaceParts ?? [{ points: region.points, holes: region.holes ?? [] }]);
            element.sourceRegionId = region.id;
            element.position = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
            element.width = (bounds.maxX - bounds.minX) * scale * 100;
            element.depth = (bounds.maxY - bounds.minY) * scale * 100;
        }
    }
    validateCivilElements([element], project);
    return element;
}
export function generateCivilLayout(project, config) {
    if (project.drawing?.type !== 'plan')
        throw new RangeError('框架模板需要真实尺寸平面图，请先新建平面图。');
    if (!config || typeof config.foundation !== 'boolean')
        throw new RangeError('请明确模板是否生成基础。');
    for (const field of ['columnSize', 'beamWidth', 'beamHeight', 'slabThickness', 'floorHeight', 'spanX', 'spanY'])
        if (!Number.isFinite(config[field]) || config[field] <= 0)
            throw new RangeError('框架模板尺寸必须为大于零的有限厘米数。');
    if (config.floorHeight > 2000 || config.slabThickness >= config.floorHeight || config.beamHeight > config.floorHeight)
        throw new RangeError('模板层高不超过 2000 cm，板厚与梁高必须适合层高。');
    let origin, width, depth;
    const range = config.range ?? (config.width !== undefined || config.depth !== undefined ? { origin: config.origin ?? { x: 200, y: 200 }, width: config.width, depth: config.depth } : null);
    if (range) {
        origin = { ...range.origin };
        width = range.width;
        depth = range.depth;
    }
    else {
        const outlines = project.planBoundary?.points?.length ? [project.planBoundary.points] : project.regions.map(region => region.points).filter(points => points.length >= 3);
        if (!outlines.length)
            throw new RangeError('请输入框架长宽与起点，或先画出建筑范围。');
        const bounds = box(outlines.map(points => ({ points, holes: [] })));
        origin = { x: bounds.minX, y: bounds.minY };
        width = bounds.maxX - bounds.minX;
        depth = bounds.maxY - bounds.minY;
    }
    if (!origin || ![origin.x, origin.y, width, depth].every(Number.isFinite) || width < 1 || depth < 1 || width > 100000 || depth > 100000)
        throw new RangeError('模板范围长宽应为 1–100000 cm，起点必须有效。');
    const nx = Math.ceil(width / config.spanX), ny = Math.ceil(depth / config.spanY);
    const count = (nx + 1) * (ny + 1) * (config.foundation ? 2 : 1) + nx * (ny + 1) + ny * (nx + 1) + Math.max(1, project.regions.length);
    if (count + (project.civilElements?.length ?? 0) > MAX_CIVIL_ELEMENTS)
        throw new RangeError('模板构件过多，请增大柱网间距或缩小范围。');
    const result = [], point = (x, y) => ({ x: origin.x + width * x / nx, y: origin.y + depth * y / ny });
    const add = (kind, position, patch) => { const element = createCivilElement(kind, position, project); Object.assign(element, patch); element.name = civilPreset(kind).name + ' ' + (result.filter(item => item.kind === kind).length + 1); result.push(element); return element; };
    for (let y = 0; y <= ny; y++)
        for (let x = 0; x <= nx; x++) {
            add('column', point(x, y), { width: config.columnSize, depth: config.columnSize, height: config.floorHeight, elevation: 0 });
            if (config.foundation)
                add('padFooting', point(x, y), { width: config.columnSize * 3, depth: config.columnSize * 3, height: 50, elevation: -50 });
        }
    const beam = (a, b) => add('beam', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { width: config.beamWidth, depth: Math.hypot(b.x - a.x, b.y - a.y), height: config.beamHeight, elevation: config.floorHeight - config.beamHeight, rotation: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI - 90 });
    for (let y = 0; y <= ny; y++)
        for (let x = 0; x < nx; x++)
            beam(point(x, y), point(x + 1, y));
    for (let x = 0; x <= nx; x++)
        for (let y = 0; y < ny; y++)
            beam(point(x, y), point(x, y + 1));
    if (!range && project.regions.some(region => region.points.length >= 3)) {
        for (const region of effectiveLevelProject(project).regions.filter(region => region.points.length >= 3)) {
            const bounds = box(region.surfaceParts ?? [{ points: region.points, holes: region.holes ?? [] }]);
            add('slab', { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, { sourceRegionId: region.id, width: bounds.maxX - bounds.minX, depth: bounds.maxY - bounds.minY, height: config.slabThickness, elevation: config.floorHeight - config.slabThickness });
        }
    }
    else {
        if (!range && project.planBoundary?.points?.length) {
            const area = polygonArea(project.planBoundary.points);
            if (Math.abs(area - width * depth) > 1e-5)
                throw new RangeError('非矩形边界请先生成房间，楼板将沿真实房间轮廓创建；或明确输入矩形模板长宽。');
        }
        const slab = add('slab', { x: origin.x + width / 2, y: origin.y + depth / 2 }, { width, depth, height: config.slabThickness, elevation: config.floorHeight - config.slabThickness });
        delete slab.sourceRegionId;
    }
    validateCivilElements(result, project);
    for (const element of result) {
        const footprint = rawParts(element, project).flatMap(part => part.points);
        if (footprint.some(point => point.x < 0 || point.y < 0 || point.x > project.drawing.width || point.y > project.drawing.height))
            throw new RangeError('模板构件超出画板：请缩小范围、调整起点，并为边缘柱和基础留出半宽距离。');
    }
    return result;
}
//# sourceMappingURL=civil.js.map