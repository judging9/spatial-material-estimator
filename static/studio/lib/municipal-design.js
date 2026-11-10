import { normalizeDecimal } from './pricing.js';
import { polygonArea, polygonPerimeter, validateRegion, validatePolygon } from './geometry.js';
import { openingRegionParts } from './floor-openings.js';
import { validateRoadTunnel } from './road-tunnel.js';
import { findMunicipalCatalogPreset } from './municipal-catalog.js';
export const MAX_MUNICIPAL_ELEMENTS = 500;
export const MAX_MUNICIPAL_POINTS = 200;
export const MAX_BRIDGE_PIERS = 500;
export const MUNICIPAL_PRESETS = [
    { kind: 'road', name: '道路', category: 'surface', color: '#929a90', width: 600, depth: 20, height: 5, elevation: 0, unit: 'm²', units: ['m²', 'm³'], description: '画中心线，按实际路宽生成路面，可分别添加基层和垫层。' },
    { kind: 'paving', name: '广场 / 人行铺装', category: 'surface', color: '#b4ac99', width: 300, depth: 300, height: 6, elevation: 0, unit: 'm²', units: ['m²', 'm³'], description: '逐点圈定铺装边界，按真实净面积和厚度计量。' },
    { kind: 'pipeline', name: '市政管线', category: 'network', color: '#648779', width: 30, depth: 80, height: 120, elevation: -80, unit: 'm', units: ['m', 'm³'], description: '按实际三维线路长度报价，也可按用户矩形沟宽、沟深估算开挖。' },
    { kind: 'manhole', name: '检查井', category: 'facility', color: '#8d978d', width: 90, depth: 90, height: 150, elevation: -150, unit: '件', units: ['件'], description: '按实际位置与外形摆放，井体施工按件填写价格。' },
    { kind: 'streetlight', name: '路灯', category: 'facility', color: '#88968d', width: 20, depth: 20, height: 600, elevation: 0, unit: '件', units: ['件'], description: '按实际高度摆放灯杆，按套填写供货及安装报价。' },
    { kind: 'green', name: '绿化区域', category: 'surface', color: '#94a78c', width: 300, depth: 300, height: 30, elevation: 0, unit: 'm²', units: ['m²', 'm³'], description: '圈定绿化边界，按净面积或用户覆土厚度计量。' },
    { kind: 'kerb', name: '路缘石', category: 'network', color: '#b4b9ab', width: 15, depth: 30, height: 30, elevation: 0, unit: 'm', units: ['m', 'm³'], description: '沿实际折线路线计米，也可按宽、高计石材外形体积。' },
    { kind: 'intersection', name: '交叉路口', category: 'surface', color: '#929a90', width: 600, depth: 20, height: 5, elevation: 0, unit: 'm²', units: ['m²', 'm³'], description: '点击放置三、四或八支路路口，实际交叠路面仅计一次。' },
    { kind: 'roundabout', name: '环岛', category: 'surface', color: '#929a90', width: 600, depth: 20, height: 5, elevation: 0, unit: 'm²', units: ['m²', 'm³'], description: '中心岛与环形路面分开，支路、环形路面和中心岛扣除使用真实边界。' },
    { kind: 'trafficlight', name: '交通信号灯', category: 'facility', color: '#64796b', width: 30, depth: 30, height: 450, elevation: 0, unit: '件', units: ['件'], description: '设置朝向与展示灯色，按套填写供货和安装单价；不模拟交通流。' },
    { kind: 'river', name: '河流 / 河道', category: 'network', color: '#78a5b0', width: 1000, depth: 200, height: 20, elevation: -100, unit: 'm²', units: ['m²', 'm³', 'm'], description: '画河道中心线并填写宽度、深度与水面标高；矩形河槽按净水面面积 × 深度估算。' },
    { kind: 'bridge', name: '桥梁', category: 'surface', color: '#a7ac9e', width: 600, depth: 100, height: 50, elevation: 400, unit: 'm²', units: ['m²', 'm³', 'm'], description: '画桥轴线设置桥面宽、高及墩栏参数；主项只计桥面，墩栏另行填写报价。' },
    { kind: 'facility', name: '城市设施', category: 'facility', color: '#85968b', width: 100, depth: 60, height: 100, elevation: 0, unit: '件', units: ['件'], description: '选择城市设施预设，设置尺寸和朝向后按件填写价格。' },
    { kind: 'fence', name: '沿线护栏 / 围栏', category: 'network', color: '#7c8f87', width: 12, depth: 600, height: 110, elevation: 0, unit: 'm', units: ['m', 'm³'], description: '沿实际走向画护栏或围栏，按真实路径长度报价，设置高度。' },
];
const EPS = 1e-7;
const clone = (value) => structuredClone(value);
const uid = (prefix = 'municipal') => prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
const vec = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const pathKinds = ['road', 'pipeline', 'kerb', 'river', 'bridge', 'fence'];
const polygonKinds = ['paving', 'green'];
const surfaceKinds = ['road', 'paving', 'green', 'intersection', 'roundabout', 'bridge', 'river'];
export const isMunicipalPath = (kind) => pathKinds.includes(kind);
export const isMunicipalPolygon = (kind) => polygonKinds.includes(kind);
export const isMunicipalSurface = (kind) => surfaceKinds.includes(kind);
export const isMunicipalLayered = (kind) => ['road', 'paving', 'intersection', 'roundabout', 'bridge'].includes(kind);
export const DEFAULT_MUNICIPAL_JUNCTION = { arms: 4, armLength: 1800, rotation: 0, islandRadius: 600 };
export function municipalEffectiveWidth(element) { return element.roadLayout ? element.roadLayout.lanes * element.roadLayout.laneWidth + element.roadLayout.medianWidth : element.width; }
export function municipalJunctionAngles(junction) { return (junction.arms === 3 ? [0, 90, 180] : Array.from({ length: junction.arms }, (_, i) => i * 360 / junction.arms)).map(angle => (angle + junction.rotation) * Math.PI / 180); }
export function municipalPreset(kind) {
    const preset = MUNICIPAL_PRESETS.find(item => item.kind === kind);
    if (!preset)
        throw new RangeError('市政对象类型不存在，请重新选择。');
    return preset;
}
export function municipalElementPreset(element) {
    const base = municipalPreset(element.kind), catalog = findMunicipalCatalogPreset(element.catalogId);
    return catalog && catalog.kind === element.kind ? { ...base, ...catalog, category: base.category, units: base.units } : base;
}
export function municipalScale(project) {
    const scale = project?.drawing?.type === 'plan' ? .01 : project?.calibration?.metersPerPixel;
    return Number.isFinite(scale) && scale > 0 ? scale : null;
}
function allElements(project) { return (project.municipalElements ?? []); }
const areaOf = (parts) => parts.reduce((sum, part) => sum + polygonArea(part.points) - part.holes.reduce((holes, ring) => holes + polygonArea(ring), 0), 0);
const perimeterOf = (parts) => parts.reduce((sum, part) => sum + polygonPerimeter(part.points) + part.holes.reduce((holes, ring) => holes + polygonPerimeter(ring), 0), 0);
/** Butt caps and bounded miter/bevel joins follow the explicit offset-curve
 * model used by GIS geometry engines. Original implementation; no GEOS code
 * or runtime dependency. Quantities use this actual boundary, never an AABB. */
export function municipalCorridor(points, width) {
    if (points.length < 2 || !Number.isFinite(width) || width <= 0)
        throw new RangeError('请画出有效路线并设置正数宽度。');
    const half = width / 2, directions = points.slice(1).map((point, i) => { const length = dist(points[i], point); if (length <= EPS)
        throw new RangeError('路线相邻节点不能重合。'); return { x: (point.x - points[i].x) / length, y: (point.y - points[i].y) / length }; });
    const side = (sign) => {
        const offset = (p, u) => ({ x: p.x - u.y * half * sign, y: p.y + u.x * half * sign });
        const result = [offset(points[0], directions[0])];
        for (let i = 1; i < points.length - 1; i++) {
            const p = points[i], before = directions[i - 1], after = directions[i], a = offset(p, before), b = offset(p, after), turn = cross(before, after);
            if (Math.abs(turn) < 1e-10) {
                if (dot(before, after) < 0)
                    throw new RangeError('路线不能原路折返，请修改节点。');
                result.push(a);
                continue;
            }
            const d = vec(a, b), t = cross(d, after) / turn, join = { x: a.x + before.x * t, y: a.y + before.y * t };
            if (dist(p, join) <= half * 4 + EPS)
                result.push(join);
            else
                result.push(a, b);
        }
        result.push(offset(points[points.length - 1], directions[directions.length - 1]));
        return result;
    };
    const ring = [...side(1), ...side(-1).reverse()].filter((p, i, ring) => i === 0 || dist(p, ring[i - 1]) > EPS);
    const valid = validatePolygon(ring);
    if (!valid.valid)
        throw new RangeError('路线宽度或转角使边界自交，请缩小宽度或调整路线：' + valid.error);
    return ring;
}
export function municipalJunctionArms(element, project) {
    if (!['intersection', 'roundabout'].includes(element.kind))
        return [];
    const scale = municipalScale(project);
    if (!scale)
        return [];
    const junction = element.junction ?? DEFAULT_MUNICIPAL_JUNCTION, p = element.points[0], outer = element.kind === 'roundabout' ? junction.islandRadius + municipalEffectiveWidth(element) : 0;
    return municipalJunctionAngles(junction).map(angle => ({ start: { x: p.x + outer * .01 / scale * Math.cos(angle), y: p.y + outer * .01 / scale * Math.sin(angle) }, end: { x: p.x + (outer + junction.armLength) * .01 / scale * Math.cos(angle), y: p.y + (outer + junction.armLength) * .01 / scale * Math.sin(angle) } }));
}
const junctionGeometryCache = new Map();
function junctionParts(element, project) {
    const scale = municipalScale(project), junction = element.junction ?? DEFAULT_MUNICIPAL_JUNCTION, p = element.points[0], width = municipalEffectiveWidth(element) * .01 / scale, half = width / 2;
    const key = JSON.stringify([element.kind, scale, p, width, junction]), cached = junctionGeometryCache.get(key);
    if (cached)
        return clone(cached);
    const remember = (parts) => { junctionGeometryCache.set(key, clone(parts)); if (junctionGeometryCache.size > 32)
        junctionGeometryCache.delete(junctionGeometryCache.keys().next().value); return parts; };
    if (element.kind === 'intersection') {
        const angles = municipalJunctionAngles(junction), length = junction.armLength * .01 / scale, points = [];
        for (let i = 0; i < angles.length; i++) {
            const angle = angles[i], next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2, ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
            points.push({ x: p.x + ux * length - nx * half, y: p.y + uy * length - ny * half }, { x: p.x + ux * length + nx * half, y: p.y + uy * length + ny * half });
            const gap = next - angle;
            if (gap < Math.PI - 1e-8) {
                const radius = half / Math.sin(gap / 2), mid = angle + gap / 2;
                points.push({ x: p.x + Math.cos(mid) * radius, y: p.y + Math.sin(mid) * radius });
            }
        }
        return remember([{ points, holes: [] }]);
    }
    // Circle and approach rectangles form one regularized union. The actual
    // island is the sole subtraction, retaining both correct area and hole.
    const outer = (junction.islandRadius + municipalEffectiveWidth(element)) * .01 / scale, inner = junction.islandRadius * .01 / scale;
    const circle = (radius) => Array.from({ length: 128 }, (_, i) => { const angle = i * Math.PI / 64 + junction.rotation * Math.PI / 180; return { x: p.x + radius * Math.cos(angle), y: p.y + radius * Math.sin(angle) }; });
    const disk = { points: circle(outer), holes: [] }, source = [disk];
    // The reusable region engine requires non-overlapping source parts. Append
    // only each approach's newly occupied area before the final island cut
    // regularizes their shared edges into a seamless outer boundary.
    for (const arm of municipalJunctionArms(element, project))
        source.push(...openingRegionParts({ points: municipalCorridor([p, arm.end], width), holes: [] }, source));
    return remember(openingRegionParts({ ...disk, surfaceParts: source }, [{ points: circle(inner), holes: [] }]));
}
export function municipalBridgeQuantities(element, project) {
    if (element.kind !== 'bridge')
        throw new RangeError('桥墩与栏杆工程量仅适用于桥梁。');
    const scale = municipalScale(project);
    if (!scale)
        return { pierCount: null, railingLength: null };
    const options = element.bridgeOptions ?? { pierSpacing: 1000, pierHeight: 400, railingHeight: 110 }, length = element.points.slice(1).reduce((sum, p, i) => sum + dist(element.points[i], p) * scale, 0);
    if (!Number.isFinite(options.pierSpacing) || options.pierSpacing <= 0)
        throw new RangeError('桥墩间距应为正数。');
    const corridor = municipalCorridor(element.points, municipalEffectiveWidth(element) * .01 / scale);
    return { pierCount: Math.max(0, Math.ceil(length / (options.pierSpacing * .01) - 1e-10) - 1), railingLength: Math.max(0, polygonPerimeter(corridor) * scale - 2 * municipalEffectiveWidth(element) * .01) };
}
function pathValidity(element) {
    const points = element.points, isPipe = element.kind === 'pipeline';
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dz = ((b.z ?? element.elevation) - (a.z ?? element.elevation)) * .01;
        if (dist(a, b) < EPS && (!isPipe || Math.abs(dz) < EPS))
            throw new RangeError('路线相邻节点不能重合。');
    }
    for (let i = 0; i < points.length - 1; i++)
        for (let j = i + 2; j < points.length - 1; j++) {
            const a = points[i], b = points[i + 1], c = points[j], d = points[j + 1], u = vec(a, b), v = vec(c, d), w = vec(a, c), det = cross(u, v);
            if (Math.abs(det) > EPS) {
                const t = cross(w, v) / det, s = cross(w, u) / det;
                if (t < -EPS || t > 1 + EPS || s < -EPS || s > 1 + EPS)
                    continue;
                if (isPipe) {
                    const za = (a.z ?? element.elevation) + ((b.z ?? element.elevation) - (a.z ?? element.elevation)) * t, zb = (c.z ?? element.elevation) + ((d.z ?? element.elevation) - (c.z ?? element.elevation)) * s;
                    if (Math.abs(za - zb) > element.width + EPS)
                        continue;
                }
                throw new RangeError('路线自身相交，请调整节点；不同高度的管线可按实际标高分开。');
            }
            const length = Math.hypot(u.x, u.y);
            if (length < EPS)
                continue;
            if (Math.abs(cross(u, w)) > EPS * length)
                continue;
            const lo = Math.max(0, Math.min(dot(w, u), dot(vec(a, d), u)) / length), hi = Math.min(length, Math.max(dot(w, u), dot(vec(a, d), u)) / length);
            if (hi - lo > EPS && (!isPipe || Math.abs((a.z ?? element.elevation) - (c.z ?? element.elevation)) < element.width))
                throw new RangeError('路线存在重复的重叠段，请调整节点。');
        }
}
function rawParts(element, project) {
    const scale = municipalScale(project);
    if (!scale)
        return null;
    if (['intersection', 'roundabout'].includes(element.kind))
        return junctionParts(element, project);
    if (isMunicipalPolygon(element.kind))
        return [{ points: element.points.map(({ x, y }) => ({ x, y })), holes: clone(element.holes ?? []) }];
    if (isMunicipalPath(element.kind)) {
        const width = municipalEffectiveWidth(element) * .01 / scale;
        if (element.kind === 'pipeline') {
            const parts = [];
            for (let i = 1; i < element.points.length; i++) {
                const a = element.points[i - 1], b = element.points[i];
                if (dist(a, b) > EPS)
                    parts.push({ points: municipalCorridor([a, b], width), holes: [] });
                else
                    parts.push({ points: Array.from({ length: 32 }, (_, index) => ({ x: a.x + width / 2 * Math.cos(index * Math.PI / 16), y: a.y + width / 2 * Math.sin(index * Math.PI / 16) })), holes: [] });
            }
            return parts;
        }
        return [{ points: municipalCorridor(element.points, width), holes: [] }];
    }
    const p = element.points[0], halfWidth = element.width * .01 / scale / 2, halfDepth = element.depth * .01 / scale / 2;
    const angle = (element.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const at = (x, y) => ({ x: p.x + c * x - s * y, y: p.y + s * x + c * y });
    return [{ points: ['streetlight', 'trafficlight'].includes(element.kind) ? Array.from({ length: 48 }, (_, index) => ({ x: p.x + halfWidth * Math.cos(index * Math.PI / 24), y: p.y + halfWidth * Math.sin(index * Math.PI / 24) })) : [at(-halfWidth, -halfDepth), at(halfWidth, -halfDepth), at(halfWidth, halfDepth), at(-halfWidth, halfDepth)], holes: [] }];
}
export function validateMunicipalElements(value, project) {
    if (value === undefined)
        return;
    if (!Array.isArray(value) || value.length > MAX_MUNICIPAL_ELEMENTS)
        throw new RangeError(`市政数据格式不正确，最多支持 ${MAX_MUNICIPAL_ELEMENTS} 项。`);
    const ids = new Set();
    for (const element of value) {
        if (!element || typeof element.id !== 'string' || !element.id.trim() || ids.has(element.id))
            throw new RangeError('市政对象编号不能为空或重复。');
        ids.add(element.id);
        const preset = municipalPreset(element.kind);
        if (element.catalogId !== undefined && (typeof element.catalogId !== 'string' || !findMunicipalCatalogPreset(element.catalogId) || findMunicipalCatalogPreset(element.catalogId).kind !== element.kind))
            throw new RangeError('城市设施预设与对象类型不匹配，请重新选择。');
        if (element.rotation !== undefined && (!Number.isFinite(element.rotation) || Math.abs(element.rotation) > 36000 || element.kind !== 'facility' && element.rotation !== 0))
            throw new RangeError('设施朝向应为有效角度，非点状设施请通过实际路线或边界设置方向。');
        if (typeof element.name !== 'string' || !element.name.trim() || element.name.length > 120)
            throw new RangeError('市政对象名称应为 1–120 字。');
        const minimum = isMunicipalPolygon(element.kind) ? 3 : isMunicipalPath(element.kind) ? 2 : 1;
        if (!Array.isArray(element.points) || element.points.length < minimum || element.points.length > MAX_MUNICIPAL_POINTS || !isMunicipalPath(element.kind) && !isMunicipalPolygon(element.kind) && element.points.length !== 1)
            throw new RangeError('市政路线或边界节点数量不正确。');
        for (const p of element.points) {
            if (!p || ![p.x, p.y].every(Number.isFinite) || Math.abs(p.x) > 1e9 || Math.abs(p.y) > 1e9 || p.z !== undefined && (!Number.isFinite(p.z) || Math.abs(p.z) > 100000))
                throw new RangeError('市政节点应使用有效坐标，高程范围为 ±100000 cm。');
            if (element.kind !== 'pipeline' && p.z !== undefined && Math.abs(p.z - element.elevation) > EPS)
                throw new RangeError('当前路面或设施使用统一标高，逐点高程仅用于管线。');
        }
        if (!Array.isArray(element.holes) || element.holes.length > 100 || element.holes.some(ring => !Array.isArray(ring) || ring.length > MAX_MUNICIPAL_POINTS))
            throw new RangeError('市政扣除区域格式不正确。');
        if (!isMunicipalPolygon(element.kind) && element.holes.length)
            throw new RangeError('内部扣除区域仅适用于铺装或绿化多边形。');
        for (const field of ['width', 'depth', 'height'])
            if (!Number.isFinite(element[field]) || element[field] < .1 || element[field] > 100000)
                throw new RangeError('市政尺寸应为 0.1–100000 cm。');
        if (element.roadLayout !== undefined) {
            const layout = element.roadLayout;
            if (!['road', 'intersection', 'roundabout', 'bridge'].includes(element.kind) || !layout || ![2, 4, 6, 8].includes(layout.lanes) || !Number.isFinite(layout.laneWidth) || layout.laneWidth < .1 || !Number.isFinite(layout.medianWidth) || layout.medianWidth < 0 || municipalEffectiveWidth(element) > 100000)
                throw new RangeError('车道布局应为 2、4、6 或 8 车道，车道宽应大于零，中央分隔带宽不能为负，总宽不能超过 100000 cm。');
            if (Math.abs(element.width - municipalEffectiveWidth(element)) > EPS)
                throw new RangeError('道路总宽应等于车道数 × 单车道宽 + 中央分隔带宽。');
        }
        if (element.junction !== undefined && !['intersection', 'roundabout'].includes(element.kind))
            throw new RangeError('支路参数仅适用于交叉路口与环岛。');
        if (['intersection', 'roundabout'].includes(element.kind)) {
            const junction = element.junction ?? DEFAULT_MUNICIPAL_JUNCTION;
            if (!junction || ![3, 4, 8].includes(junction.arms) || !Number.isFinite(junction.armLength) || junction.armLength < .1 || junction.armLength > 100000 || !Number.isFinite(junction.rotation) || Math.abs(junction.rotation) > 36000 || !Number.isFinite(junction.islandRadius) || junction.islandRadius < .1 || junction.islandRadius > 100000)
                throw new RangeError('路口支路数应为 3、4 或 8，支路长及岛半径应为 0.1–100000 cm，旋转角应为有效数字。');
            const minimum = municipalEffectiveWidth(element) / 2 * (junction.arms === 8 ? 1 / Math.tan(Math.PI / 8) : 1);
            if (element.kind === 'intersection' && junction.armLength <= minimum + EPS)
                throw new RangeError('支路过短，无法容纳当前路宽；请增加支路长度或缩小路宽。');
        }
        if (element.trafficSignal !== undefined) {
            const signal = element.trafficSignal;
            if (element.kind !== 'trafficlight' || !signal || !['red', 'amber', 'green'].includes(signal.phase) || !Number.isFinite(signal.rotation) || Math.abs(signal.rotation) > 36000)
                throw new RangeError('信号灯颜色或朝向格式不正确。');
        }
        if (element.bridgeOptions !== undefined) {
            const bridge = element.bridgeOptions;
            if (element.kind !== 'bridge' || !bridge || ['pierSpacing', 'pierHeight', 'railingHeight'].some(field => !Number.isFinite(bridge[field]) || bridge[field] < .1 || bridge[field] > 100000))
                throw new RangeError('桥墩间距、高度和栏杆高度应为 0.1–100000 cm。');
            for (const field of ['pierPricingEnabled', 'railingPricingEnabled'])
                if (bridge[field] !== undefined && typeof bridge[field] !== 'boolean')
                    throw new RangeError('桥墩及栏杆独立报价状态格式不正确。');
            for (const field of ['pierUnitPrice', 'railingUnitPrice'])
                if (bridge[field] !== undefined && bridge[field] !== '')
                    normalizeDecimal(bridge[field], '桥梁分项单价');
            if (project && municipalScale(project) && municipalBridgeQuantities(element, project).pierCount > MAX_BRIDGE_PIERS)
                throw new RangeError(`单座桥梁最多支持 ${MAX_BRIDGE_PIERS} 个中间墩，请增加墩间距。`);
        }
        if (!Number.isFinite(element.elevation) || Math.abs(element.elevation) > 100000)
            throw new RangeError('市政标高范围为 ±100000 cm。');
        if (!preset.units.includes(element.unit))
            throw new RangeError('此市政对象不支持当前计量单位。');
        if (!/^\d+$/.test(String(element.quantity)) || Number(element.quantity) < 1 || Number(element.quantity) > 1000000)
            throw new RangeError('数量应为 1–1000000 的整数，场地图示为一份布置。');
        for (const field of ['wasteRate', 'laborRate', 'additionalCost'])
            normalizeDecimal(element[field], '市政计价参数');
        if (element.unitPrice !== '')
            normalizeDecimal(element.unitPrice, '市政单价');
        for (const field of ['hidden', 'locked'])
            if (element[field] !== undefined && typeof element[field] !== 'boolean')
                throw new RangeError('市政显示或锁定状态格式不正确。');
        if (element.items !== undefined) {
            if (!Array.isArray(element.items) || element.items.length > 20 || !isMunicipalLayered(element.kind))
                throw new RangeError('结构层仅适用于道路、路口、环岛、桥面和铺装，最多 20 层。');
            const itemIds = new Set();
            for (const item of element.items) {
                if (!item || typeof item.id !== 'string' || !item.id.trim() || itemIds.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120)
                    throw new RangeError('市政结构层名称或编号不正确。');
                itemIds.add(item.id);
                if (!Number.isFinite(item.thickness) || item.thickness < .1 || item.thickness > 10000)
                    throw new RangeError('结构层厚度应为 0.1–10000 cm。');
                if (!['m²', 'm³'].includes(item.unit))
                    throw new RangeError('结构层按面积或体积计量。');
                for (const field of ['wasteRate', 'laborRate', 'additionalCost'])
                    normalizeDecimal(item[field], '结构层计价参数');
                if (item.unitPrice !== '')
                    normalizeDecimal(item.unitPrice, '结构层单价');
            }
        }
        if (isMunicipalPath(element.kind))
            pathValidity(element);
        if (isMunicipalPolygon(element.kind)) {
            const valid = validateRegion(element);
            if (!valid.valid)
                throw new RangeError('市政区域边界无效：' + valid.error);
        }
        if (element.tunnel !== undefined)
            validateRoadTunnel(project, element);
        if (project) {
            const parts = rawParts(element, project);
            if (parts && element.kind !== 'pipeline')
                for (const part of parts) {
                    const valid = validateRegion(part);
                    if (!valid.valid)
                        throw new RangeError('市政真实占地无效：' + valid.error);
                }
            if (project.drawing)
                for (const p of [...element.points, ...(parts ?? []).flatMap(part => part.points)])
                    if (p.x < 0 || p.y < 0 || p.x > project.drawing.width || p.y > project.drawing.height)
                        throw new RangeError('市政对象超出当前绘图范围，请调整位置、宽度或边界。');
        }
    }
}
export function createMunicipalElement(kind, points, project, patch = {}) {
    const preset = municipalPreset(kind), element = { id: uid(), kind, name: preset.name, points: points.map(point => ({ ...point })), holes: [], width: preset.width, depth: preset.depth, height: preset.height, elevation: preset.elevation, quantity: '1', unit: preset.unit, unitPrice: '', wasteRate: '0', laborRate: '0', additionalCost: '0', hidden: false, locked: false, items: [] };
    if (['intersection', 'roundabout'].includes(kind))
        element.junction = clone(DEFAULT_MUNICIPAL_JUNCTION);
    if (kind === 'trafficlight')
        element.trafficSignal = { phase: 'red', rotation: 0 };
    if (kind === 'bridge')
        element.bridgeOptions = { pierSpacing: 1000, pierHeight: 400, railingHeight: 110, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '', railingUnitPrice: '' };
    Object.assign(element, clone(patch));
    element.kind = kind;
    if (element.roadLayout)
        element.width = municipalEffectiveWidth(element);
    if (kind === 'pipeline')
        element.points = element.points.map(point => ({ ...point, z: point.z ?? element.elevation }));
    if (!isMunicipalLayered(kind))
        delete element.items;
    validateMunicipalElements([element], project);
    return element;
}
export function createMunicipalLayer(name = '结构层', thickness = 20) { return { id: uid('municipal-layer'), name, thickness, unit: 'm³', unitPrice: '', wasteRate: '0', laborRate: '0', additionalCost: '0' }; }
export function rawMunicipalFootprints(element, project) { validateMunicipalElements([element], project); return clone(rawParts(element, project)); }
const bounds = (parts) => { const points = parts.flatMap(part => part.points); return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) }; };
const boundsMeet = (a, b) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
const ownershipCache = new Map();
// A graded road is a different construction surface from a flat site at its
// old default elevation. Equal affine planes still share overlap ownership.
function surfaceGroup(element, project) {
    if (element.kind === 'bridge' || element.kind === 'river')
        return element.kind + ':flat:' + Math.round(element.elevation * 1e6) / 1e8;
    const profile = element.kind === 'road' && element.roadProfile?.enabled ? element.roadProfile : null;
    const round = (v) => Math.round(v * 1e8) / 1e8;
    if (!profile)
        return 'flat:' + round(element.elevation / 100);
    const elevations = profile.points.map(point => point.elevation), crossfalls = profile.crossfallPoints;
    const leftSlope = (crossfalls?.length ? crossfalls[0].leftSlope : profile.crossSection?.leftSlope ?? 0) / 100, rightSlope = (crossfalls?.length ? crossfalls[0].rightSlope : profile.crossSection?.rightSlope ?? 0) / 100;
    const constantCrossfall = !crossfalls?.length || crossfalls.every(point => Math.abs(point.leftSlope / 100 - leftSlope) < EPS && Math.abs(point.rightSlope / 100 - rightSlope) < EPS);
    if (constantCrossfall && !leftSlope && !rightSlope && elevations.every(value => Math.abs(value - elevations[0]) < EPS))
        return 'flat:' + round(elevations[0]);
    const scale = municipalScale(project) ?? .01, first = element.points[0], last = element.points[element.points.length - 1], dx = (last.x - first.x) * scale, dy = (last.y - first.y) * scale, length = Math.hypot(dx, dy);
    const straight = length > EPS && element.points.every(p => Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) < EPS / scale);
    const grade = (elevations[elevations.length - 1] - elevations[0]) / length;
    if (straight && constantCrossfall && Math.abs(leftSlope + rightSlope) < EPS && profile.points.every(point => Math.abs(point.elevation - elevations[0] - grade * point.station) < EPS)) {
        const a = grade * dx / length - leftSlope * dy / length, b = grade * dy / length + leftSlope * dx / length, c = elevations[0] - a * first.x * scale - b * first.y * scale;
        return 'plane:' + JSON.stringify([a, b, c].map(round));
    }
    const coordinates = element.points.map(p => [round(p.x * scale), round(p.y * scale)]), stations = profile.points.map(p => [round(p.station), round(p.elevation), round(p.curveLength ?? 0)]), total = profile.points[profile.points.length - 1]?.station ?? 0;
    const forwardCrossfall = constantCrossfall ? [leftSlope, rightSlope] : crossfalls.map(point => [round(point.station), round(point.leftSlope), round(point.rightSlope)]);
    const reverseCrossfall = constantCrossfall ? [rightSlope, leftSlope] : crossfalls.slice().reverse().map(point => [round(total - point.station), round(point.rightSlope), round(point.leftSlope)]);
    const forward = JSON.stringify([coordinates, stations, forwardCrossfall]), reverse = JSON.stringify([coordinates.slice().reverse(), stations.slice().reverse().map(([station, elevation, curve]) => [round(total - station), elevation, curve]), reverseCrossfall]);
    return 'profile:' + (forward < reverse ? forward : reverse);
}
function ownedParts(project, elements) {
    const key = JSON.stringify([municipalScale(project), elements.map(element => [element.id, element.kind, element.catalogId, element.points, element.holes, element.width, element.depth, element.elevation, element.rotation, element.roadLayout, element.junction, element.roadProfile?.enabled, element.roadProfile?.points, element.roadProfile?.crossSection, element.roadProfile?.crossfallPoints])]);
    const cached = ownershipCache.get(key);
    if (cached)
        return cached;
    const result = new Map(), prior = [];
    for (const element of elements) {
        const raw = rawParts(element, project);
        let parts = raw;
        if (raw && surfaceKinds.includes(element.kind)) {
            const box = bounds(raw), group = surfaceGroup(element, project), cuts = prior.filter(previous => surfaceGroup(previous.element, project) === group && boundsMeet(box, previous.bounds)).flatMap(previous => previous.parts);
            if (cuts.length)
                parts = openingRegionParts({ points: raw[0].points, holes: raw[0].holes, surfaceParts: raw }, cuts);
            prior.push({ element, parts: raw, bounds: box });
        }
        result.set(element.id, { raw, parts });
    }
    ownershipCache.set(key, result);
    if (ownershipCache.size > 4)
        ownershipCache.delete(ownershipCache.keys().next().value);
    return result;
}
export function municipalFootprints(element, project) {
    validateMunicipalElements([element], project);
    const elements = allElements(project), source = elements.some(item => item.id === element.id) ? elements.map(item => item.id === element.id ? element : item) : [...elements, element];
    return clone(ownedParts(project, source).get(element.id)?.parts ?? null);
}
function measure(element, project, own) {
    const scale = municipalScale(project), totalDepth = element.kind === 'river' ? element.depth : element.height + (element.items ?? []).reduce((sum, item) => sum + item.thickness, 0), warnings = [];
    if (!scale)
        return { length: null, pathLength: null, area: null, netArea: null, grossArea: null, overlapArea: null, volume: null, perimeter: null, totalDepth, warnings: ['图纸尚未校准，实际市政工程量待确认。'] };
    let length = 0, pathLength = 0;
    for (let i = 1; i < element.points.length; i++) {
        const a = element.points[i - 1], b = element.points[i], horizontal = dist(a, b) * scale;
        pathLength += horizontal;
        if (isMunicipalPath(element.kind))
            length += Math.hypot(horizontal, element.kind === 'pipeline' ? ((b.z ?? element.elevation) - (a.z ?? element.elevation)) * .01 : 0);
    }
    if (!isMunicipalPath(element.kind))
        length = 0;
    const grossArea = element.kind === 'pipeline' ? 0 : areaOf(own.raw ?? []) * scale * scale, area = element.kind === 'pipeline' ? 0 : areaOf(own.parts ?? []) * scale * scale;
    const overlapArea = Math.max(0, grossArea - area), perimeter = element.kind === 'pipeline' ? 0 : perimeterOf(own.parts ?? []) * scale;
    const volume = element.kind === 'pipeline' ? pathLength * element.depth * .01 * element.height * .01 : area * (element.kind === 'river' ? element.depth : element.height) * .01;
    if (overlapArea > 1e-9)
        warnings.push('同标高场地的重叠部分已按先放置对象归属，只计一次净面积。');
    if (element.kind === 'pipeline' && element.unit === 'm³')
        warnings.push('管沟按水平投影长度 × 矩形沟宽 × 沟深估算，未计地形、放坡和井坑。');
    if (element.kind === 'river')
        warnings.push('河槽体积按实际净水面面积 × 用户矩形槽深估算；不含河岸放坡、地质分层或水流模拟。');
    if (element.kind === 'roundabout')
        warnings.push('环形道路采用 128 边圆形控制轮廓，中心岛从路面净量扣除，展示与计量使用同一边界。');
    if (element.kind === 'bridge')
        warnings.push('桥梁主项仅按桥面尺寸计量；桥墩与栏杆按勾选项独立计费，不含结构受力验算与基础详算。');
    if (element.kind === 'trafficlight')
        warnings.push('灯色用于场景展示；信号灯按用户预算数量报价，不包含交通流或配时模拟。');
    return { length, pathLength, area, netArea: area, grossArea, overlapArea, volume, perimeter, totalDepth, warnings };
}
export function municipalMetrics(element, project) {
    validateMunicipalElements([element], project);
    const elements = allElements(project), source = elements.some(item => item.id === element.id) ? elements.map(item => item.id === element.id ? element : item) : [...elements, element];
    return measure(element, project, ownedParts(project, source).get(element.id));
}
export function buildMunicipalQuantities(project) {
    const elements = allElements(project);
    validateMunicipalElements(elements, project);
    const parts = ownedParts(project, elements);
    return elements.map(element => ({ element: clone(element), metrics: measure(element, project, parts.get(element.id)), parts: clone(parts.get(element.id)?.parts ?? null), grossParts: clone(parts.get(element.id)?.raw ?? null) }));
}
export function moveMunicipalElement(element, start, current) {
    const next = clone(element);
    if (next.locked)
        return next;
    const dx = current.x - start.x, dy = current.y - start.y;
    next.points = next.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy }));
    next.holes = next.holes.map(ring => ring.map(point => ({ x: point.x + dx, y: point.y + dy })));
    return next;
}
//# sourceMappingURL=municipal-design.js.map