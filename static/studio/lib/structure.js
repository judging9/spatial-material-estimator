import { regionMetrics, pointInRegion, validateRegion, polygonArea } from './geometry.js';
import { normalizeWalls } from './wall-plan.js';
import { openingPolygon, validateOpenings } from './wall-solid.js';
import { createCostItem, applyModulePrices } from './cost.js';
import { formatQuantity, normalizeDecimal } from './pricing.js';
export const DEFAULT_STRUCTURE_CONFIG = Object.freeze({
    system: 'frame', floors: 3, floorHeight: 3, foundation: 'spread', concreteGrade: 'C30',
    columnSize: 400, slabThickness: 110, embedDepth: 1.5, rebarIndex: 50, gridX: 0, gridY: 0,
    footprintSource: 'auto', width: 10, depth: 10, concreteWallLength: 0, seismicGrade: '未指定',
});
const EPS = 1e-7;
const cleanNumber = (n) => Math.round(n * 1e9) / 1e9;
const quantity = (n) => formatQuantity(cleanNumber(n), 8);
function bounded(value, label, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) {
        throw new RangeError(`${label}应为 ${min}–${max}${integer ? ' 的整数' : ''}`);
    }
    return value;
}
export function normalizeStructureConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new RangeError('土建参数格式不正确');
    const config = { ...DEFAULT_STRUCTURE_CONFIG, ...input };
    if (!['frame', 'masonry', 'frame-shear'].includes(config.system))
        throw new RangeError('结构形式不正确');
    if (!['spread', 'strip', 'raft'].includes(config.foundation))
        throw new RangeError('基础形式不正确');
    if (!['C25', 'C30', 'C35', 'C40'].includes(config.concreteGrade))
        throw new RangeError('混凝土强度不正确');
    if (!['auto', 'rectangle'].includes(config.footprintSource))
        throw new RangeError('结构轮廓来源不正确');
    if (!['未指定', '一级', '二级', '三级', '四级'].includes(config.seismicGrade))
        throw new RangeError('抗震等级不正确');
    bounded(config.floors, '地上层数', 1, 30, true);
    bounded(config.floorHeight, '层高（m）', 2.4, 6);
    bounded(config.columnSize, '柱截面（mm）', 250, 1200);
    bounded(config.slabThickness, '板厚（mm）', 100, 500);
    bounded(config.embedDepth, '基础埋深（m）', .2, 10);
    bounded(config.rebarIndex, '钢筋指标（kg/m²）', 0, 300);
    bounded(config.gridX, 'X 向跨数（0 为自动）', 0, 40, true);
    bounded(config.gridY, 'Y 向跨数（0 为自动）', 0, 40, true);
    bounded(config.width, '矩形方案长度（m）', 1, 200);
    bounded(config.depth, '矩形方案宽度（m）', 1, 200);
    bounded(config.concreteWallLength, '混凝土墙长度（m）', 0, 10000);
    return config;
}
function rectangleFootprint(config) {
    const { width, depth } = config;
    const points = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: depth }, { x: 0, y: depth }];
    return { footprint: { width, height: depth, area: width * depth, perimeter: 2 * (width + depth), boundaryPerimeter: 2 * (width + depth), x: 0, y: 0,
            source: 'rectangle', note: '按用户输入的矩形外轮廓建立标准层方案；未从图纸推断结构。',
            outline: points.map((start, i) => ({ start, end: points[(i + 1) % 4] })) }, xs: [0, width], ys: [0, depth], occupied: [[true]] };
}
/** Exact planar union of measured orthogonal floor regions and square-capped wall footprints. */
function measuredFootprint(project, config) {
    if (config.footprintSource === 'rectangle' || !project.regions.length && !(project.walls?.length))
        return rectangleFootprint(config);
    if (project.planError)
        throw new RangeError('请先闭合并修正墙线，或选择矩形方案输入长宽。');
    if (!project.regions.length)
        throw new RangeError('当前墙线未形成房间，不能推断建筑外轮廓。');
    const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
    if (!Number.isFinite(scale) || scale <= 0)
        throw new RangeError('请先校准图纸，或选择矩形方案输入实际长宽。');
    const regions = project.regions.map(region => {
        const check = validateRegion(region);
        if (!check.valid)
            throw new RangeError('结构轮廓无效：' + check.error);
        const convert = (p) => ({ x: cleanNumber(p.x * scale), y: cleanNumber(p.y * scale) });
        const geometry = { points: region.points.map(convert), holes: (region.holes ?? []).map(hole => hole.map(convert)) };
        for (const ring of [geometry.points, ...geometry.holes])
            if (ring.some((p, i) => {
                const q = ring[(i + 1) % ring.length];
                return Math.abs(p.x - q.x) > EPS && Math.abs(p.y - q.y) > EPS;
            }))
                throw new RangeError('主体结构方案目前需要正交外轮廓；斜边图纸请先选择矩形方案。');
        // Reuse the trusted floor engine to reject unavailable physical quantities.
        const metrics = regionMetrics(region, { metersPerPixel: scale });
        if (!(metrics.netArea > 0))
            throw new RangeError('标准层轮廓没有有效面积');
        return geometry;
    });
    const wallRects = normalizeWalls(project.walls ?? []).map(wall => ({
        x0: cleanNumber((Math.min(wall.start.x, wall.end.x) - wall.thickness / 2) / 100),
        x1: cleanNumber((Math.max(wall.start.x, wall.end.x) + wall.thickness / 2) / 100),
        y0: cleanNumber((Math.min(wall.start.y, wall.end.y) - wall.thickness / 2) / 100),
        y1: cleanNumber((Math.max(wall.start.y, wall.end.y) + wall.thickness / 2) / 100),
    }));
    const allPoints = regions.flatMap(r => [r.points, ...r.holes].flat());
    const xs = [...new Set([...allPoints.map(p => p.x), ...wallRects.flatMap(r => [r.x0, r.x1])])].sort((a, b) => a - b);
    const ys = [...new Set([...allPoints.map(p => p.y), ...wallRects.flatMap(r => [r.y0, r.y1])])].sort((a, b) => a - b);
    if ((xs.length - 1) * (ys.length - 1) > 150000)
        throw new RangeError('外轮廓节点过多，请拆分主体结构方案。');
    const occupied = Array.from({ length: ys.length - 1 }, () => Array(xs.length - 1).fill(false));
    const regionBounds = regions.map(r => ({ region: r, x0: Math.min(...r.points.map(p => p.x)), x1: Math.max(...r.points.map(p => p.x)),
        y0: Math.min(...r.points.map(p => p.y)), y1: Math.max(...r.points.map(p => p.y)) }));
    let area = 0, perimeter = 0, boundaryPerimeter = 0;
    const outline = [];
    for (let y = 0; y < ys.length - 1; y++)
        for (let x = 0; x < xs.length - 1; x++) {
            const p = { x: (xs[x] + xs[x + 1]) / 2, y: (ys[y] + ys[y + 1]) / 2 };
            const filled = wallRects.some(r => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1)
                || regionBounds.some(r => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1 && pointInRegion(p, r.region));
            occupied[y][x] = filled;
            if (filled)
                area += (xs[x + 1] - xs[x]) * (ys[y + 1] - ys[y]);
        }
    // Empty cells connected to the bounding rectangle are exterior. Internal
    // floor holes retain their area deduction without becoming exterior walls.
    const exterior = occupied.map(row => row.map(() => false)), queue = [];
    const visit = (x, y) => { if (x < 0 || y < 0 || y >= occupied.length || x >= occupied[0].length || occupied[y][x] || exterior[y][x])
        return; exterior[y][x] = true; queue.push({ x, y }); };
    for (let x = 0; x < occupied[0].length; x++) {
        visit(x, 0);
        visit(x, occupied.length - 1);
    }
    for (let y = 0; y < occupied.length; y++) {
        visit(0, y);
        visit(occupied[0].length - 1, y);
    }
    for (let i = 0; i < queue.length; i++) {
        const { x, y } = queue[i];
        visit(x - 1, y);
        visit(x + 1, y);
        visit(x, y - 1);
        visit(x, y + 1);
    }
    const edge = (start, end, outer) => { const length = Math.hypot(end.x - start.x, end.y - start.y); boundaryPerimeter += length; if (outer)
        perimeter += length; outline.push({ start, end }); };
    for (let y = 0; y < ys.length - 1; y++)
        for (let x = 0; x < xs.length - 1; x++)
            if (occupied[y][x]) {
                if (y === 0 || !occupied[y - 1][x])
                    edge({ x: xs[x], y: ys[y] }, { x: xs[x + 1], y: ys[y] }, y === 0 || exterior[y - 1][x]);
                if (x === xs.length - 2 || !occupied[y][x + 1])
                    edge({ x: xs[x + 1], y: ys[y] }, { x: xs[x + 1], y: ys[y + 1] }, x === xs.length - 2 || exterior[y][x + 1]);
                if (y === ys.length - 2 || !occupied[y + 1][x])
                    edge({ x: xs[x + 1], y: ys[y + 1] }, { x: xs[x], y: ys[y + 1] }, y === ys.length - 2 || exterior[y + 1][x]);
                if (x === 0 || !occupied[y][x - 1])
                    edge({ x: xs[x], y: ys[y + 1] }, { x: xs[x], y: ys[y] }, x === 0 || exterior[y][x - 1]);
            }
    if (!Number.isFinite(area) || area <= EPS)
        throw new RangeError('没有可量化的标准层外轮廓');
    return { footprint: { width: cleanNumber(xs.at(-1) - xs[0]), height: cleanNumber(ys.at(-1) - ys[0]), area: cleanNumber(area),
            perimeter: cleanNumber(perimeter), boundaryPerimeter: cleanNumber(boundaryPerimeter), x: xs[0], y: ys[0], source: 'plan',
            note: '标准层投影为实际净房间与墙体占地的并集；不规则轮廓保留实际面积，柱网与基坑使用外包尺寸作方案估算。', outline }, xs, ys, occupied };
}
function rectangleIntersection(grid, x0, y0, x1, y1) {
    let area = 0;
    for (let y = 0; y < grid.ys.length - 1; y++) {
        const dy = Math.min(y1, grid.ys[y + 1]) - Math.max(y0, grid.ys[y]);
        if (dy <= 0)
            continue;
        for (let x = 0; x < grid.xs.length - 1; x++)
            if (grid.occupied[y][x]) {
                const dx = Math.min(x1, grid.xs[x + 1]) - Math.max(x0, grid.xs[x]);
                if (dx > 0)
                    area += dx * dy;
            }
    }
    return area;
}
function openingBelowHeight(ring, height) {
    const result = [];
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length], inside = p.y <= height, nextInside = q.y <= height;
        if (inside)
            result.push({ ...p });
        if (inside !== nextInside) {
            const ratio = (height - p.y) / (q.y - p.y);
            result.push({ x: p.x + (q.x - p.x) * ratio, y: height });
        }
    }
    return result;
}
export function calculateStructureModel(project, input = {}) {
    if (!project || !Array.isArray(project.regions))
        throw new RangeError('土建项目数据不正确');
    const config = normalizeStructureConfig(input), grid = measuredFootprint(project, config), f = grid.footprint;
    const b = config.columnSize / 1000, t = config.slabThickness / 1000, n = config.floors, h = config.floorHeight;
    if (f.width < b * 2 || f.height < b * 2)
        throw new RangeError('外轮廓过窄，无法容纳当前柱截面，请调整方案。');
    const gridX = config.gridX || Math.max(1, Math.ceil(f.width / 6)), gridY = config.gridY || Math.max(1, Math.ceil(f.height / 6));
    const dx = (f.width - b) / gridX, dy = (f.height - b) / gridY;
    if (Math.max(dx, dy) / 10 >= h - t)
        throw new RangeError('柱网跨距过大，请增加跨数后生成结构方案。');
    const columns = [], nodes = new Map();
    for (let y = 0; y <= gridY; y++)
        for (let x = 0; x <= gridX; x++) {
            const p = { x: f.x + b / 2 + dx * x, y: f.y + b / 2 + dy * y };
            if (Math.abs(rectangleIntersection(grid, p.x - b / 2, p.y - b / 2, p.x + b / 2, p.y + b / 2) - b * b) < 1e-6) {
                columns.push({ ...p, size: b });
                nodes.set(`${x},${y}`, p);
            }
        }
    if (!columns.length)
        throw new RangeError('当前柱网没有落入有效轮廓，请调整跨数或矩形方案。');
    const beams = [];
    const addBeam = (a, z) => {
        if (!a || !z)
            return;
        const span = Math.hypot(z.x - a.x, z.y - a.y), length = span - b;
        if (length <= EPS)
            return;
        const horizontal = Math.abs(a.y - z.y) < EPS, width = .25;
        const start = { x: a.x + (horizontal ? b / 2 : 0), y: a.y + (horizontal ? 0 : b / 2) };
        const end = { x: z.x - (horizontal ? b / 2 : 0), y: z.y - (horizontal ? 0 : b / 2) };
        const x0 = Math.min(start.x, end.x) - (horizontal ? 0 : width / 2), x1 = Math.max(start.x, end.x) + (horizontal ? 0 : width / 2);
        const y0 = Math.min(start.y, end.y) - (horizontal ? width / 2 : 0), y1 = Math.max(start.y, end.y) + (horizontal ? width / 2 : 0);
        if (Math.abs(rectangleIntersection(grid, x0, y0, x1, y1) - length * width) > 1e-6)
            return;
        beams.push({ start, end, width, height: span / 10, length });
    };
    for (let y = 0; y <= gridY; y++)
        for (let x = 0; x < gridX; x++)
            addBeam(nodes.get(`${x},${y}`), nodes.get(`${x + 1},${y}`));
    for (let x = 0; x <= gridX; x++)
        for (let y = 0; y < gridY; y++)
            addBeam(nodes.get(`${x},${y}`), nodes.get(`${x},${y + 1}`));
    const beamLength = beams.reduce((s, beam) => s + beam.length, 0), secondaryLength = beamLength * 1.2;
    const secondaryHeight = (dx + dy) / 24, secondaryDepth = Math.max(0, secondaryHeight - t);
    const primaryBeams = beams.reduce((s, beam) => s + beam.width * Math.max(0, beam.height - t) * beam.length, 0) * n;
    const secondaryBeams = .2 * secondaryDepth * secondaryLength * n;
    const baseSide = Math.max(1.5, 1.5 * b / .4);
    const foundation = config.foundation === 'spread' ? columns.length * baseSide * baseSide * .5 : config.foundation === 'strip' ? f.perimeter * .8 * .4 : f.area * .4;
    const cushion = config.foundation === 'spread' ? columns.length * baseSide * baseSide * .1 : config.foundation === 'strip' ? f.perimeter * .8 * .1 : f.area * .1;
    const H = config.embedDepth + .1, bottom = (f.width + .6) * (f.height + .6), top = (f.width + .6 + .66 * H) * (f.height + .6 + .66 * H);
    const excavation = H / 3 * (bottom + top + Math.sqrt(bottom * top));
    if (foundation + cushion > excavation + EPS)
        throw new RangeError('基础体积超过基坑方案容量，请调整埋深、柱网或基础形式。');
    const innerLength = f.area / h * .5, totalWallLength = f.perimeter + innerLength;
    if (config.system === 'frame-shear' && config.concreteWallLength <= 0)
        throw new RangeError('框架-剪力墙方案需要在高级参数填写混凝土墙长度。');
    if (config.concreteWallLength > totalWallLength + EPS)
        throw new RangeError('混凝土墙长度超过方案墙体总长，请核对参数。');
    const openings = f.source === 'plan' && project.openings?.length ? validateOpenings(project) : [];
    const openingVolume = openings.reduce((sum, o) => sum + polygonArea(openingBelowHeight(openingPolygon(o), (h - t) * 100)) / 10000 * .2, 0) * n;
    const grossWall = totalWallLength * (h - t) * .2 * n, netWall = Math.max(0, grossWall - openingVolume);
    const wallRatio = config.system === 'frame-shear' ? config.concreteWallLength / totalWallLength : 0;
    const concreteWalls = netWall * wallRatio, masonry = netWall - concreteWalls;
    const columnFormwork = 4 * b * (h - t) * columns.length * n;
    const effectiveSecondaryLength = secondaryDepth > 0 ? secondaryLength : 0;
    const beamFormwork = (beams.reduce((s, beam) => s + (beam.height > t ? (2 * (beam.height - t) + beam.width) * beam.length : 0), 0) + (2 * secondaryDepth + .2) * effectiveSecondaryLength) * n;
    const primaryProjection = beams.reduce((s, beam) => s + (beam.height > t ? beam.width * beam.length : 0), 0);
    const slabBottom = Math.max(0, f.area - columns.length * b * b - primaryProjection - effectiveSecondaryLength * .2);
    const foundationFormwork = config.foundation === 'spread' ? columns.length * baseSide * 4 * .5 : config.foundation === 'strip' ? f.perimeter * 2 * .4 : f.perimeter * .4;
    const quantities = { buildingArea: f.area * n, siteLeveling: f.area, excavation, backfill: excavation - foundation - cushion,
        disposal: foundation + cushion, cushion, foundation, columns: columns.length * b * b * (h - t) * n, primaryBeams, secondaryBeams, beams: primaryBeams + secondaryBeams,
        slabs: f.area * t * n, masonry, concreteWalls, foundationFormwork, columnFormwork, beamFormwork,
        slabFormwork: slabBottom * n + f.boundaryPerimeter * t * n, wallFormwork: config.system === 'frame-shear' ? config.concreteWallLength * (h - t) * 2 * n : 0,
        rebar: config.rebarIndex * f.area * n / 1000, scaffolding: f.area * n, verticalTransport: f.area * n };
    for (const key of Object.keys(quantities))
        quantities[key] = cleanNumber(quantities[key]);
    return { config, footprint: f, columns, beams, gridX, gridY, quantities,
        estimateFlags: ['柱网与梁尺寸为方案布置', '次梁按主梁净长度 × 1.2', '土方按整体外包基坑棱台估算', '内墙长度按面积 / 层高 × 0.5', '钢筋按 kg/m² 指标估算', '模板按方案构件与梁投影扣减估算',
            ...(f.source === 'rectangle' ? ['矩形方案无门窗数据，未作门窗洞口扣量'] : []),
            ...(config.system === 'masonry' ? ['砖混柱梁仅为构造柱、圈梁方案数量，未做结构设计'] : [])] };
}
const definitions = [
    { id: 'site', code: '010101001001', name: '平整场地', unit: 'm²', quantity: 'siteLeveling', group: '土石方', basis: '标准层外轮廓投影面积，仅计一次' },
    { id: 'excavation', code: '010101004001', name: '挖基坑土方', unit: 'm³', quantity: 'excavation', group: '土石方', basis: '整体外包基坑棱台，工作面每边0.3m，放坡1:0.33，深度=埋深+0.1m' },
    { id: 'backfill', code: '010103001001', name: '回填方', unit: 'm³', quantity: 'backfill', group: '土石方', basis: '基坑开挖量−基础体积−垫层体积，不含土方压实换算' },
    { id: 'disposal', code: '010103002001', name: '余方弃置', unit: 'm³', quantity: 'disposal', group: '土石方', basis: '开挖−回填，未计松散系数或运距' },
    { id: 'cushion', code: '010501001001', name: 'C15 垫层', unit: 'm³', quantity: 'cushion', group: '混凝土', basis: '基础底面积×0.1m，仅计一次', terms: ['C15'] },
    { id: 'foundation', code: '010501003001', name: '基础混凝土', unit: 'm³', quantity: 'foundation', group: '混凝土', basis: '独立基础每柱1个，或外轮廓条基，或0.4m筏板；基础仅计一次', terms: ['混凝土'] },
    { id: 'columns', code: '010502001001', name: '矩形柱', unit: 'm³', quantity: 'columns', group: '混凝土', basis: '柱网节点数×截面²×(层高−板厚)×层数，柱止于板下', terms: ['混凝土'] },
    { id: 'beams', code: '010503002001', name: '矩形梁', unit: 'm³', quantity: 'beams', group: '混凝土', basis: '主梁净跨度扣柱宽，梁高按跨距/10；次梁按主梁净长×1.2；只计板下梁身', terms: ['混凝土'] },
    { id: 'slabs', code: '010505001001', name: '有梁板', unit: 'm³', quantity: 'slabs', group: '混凝土', basis: '标准层真实投影面积×板厚×层数，柱梁均止于板下，不再重复扣柱', terms: ['混凝土'] },
    { id: 'walls', code: '010507001001', name: '混凝土墙', unit: 'm³', quantity: 'concreteWalls', group: '混凝土', basis: '用户混凝土墙长×(层高−板厚)×0.2m×层数，门窗按墙长比例扣量', terms: ['混凝土'] },
    { id: 'masonry', code: '010401004001', name: '多孔砖墙', unit: 'm³', quantity: 'masonry', group: '砌体', basis: '外周长+面积/层高×0.5估算内墙，厚0.2m，扣门窗；框剪另扣混凝土墙', reference: '415', range: '380–450 元/m³', terms: ['砌体', '多孔砖'] },
    { id: 'foundation-formwork', code: '011702001001', name: '基础模板', unit: 'm²', quantity: 'foundationFormwork', group: '模板', category: '措施项目', basis: '基础方案暴露侧面面积', reference: '55', range: '45–65 元/m²', terms: ['模板'] },
    { id: 'column-formwork', code: '011702002001', name: '矩形柱模板', unit: 'm²', quantity: 'columnFormwork', group: '模板', category: '措施项目', basis: '4×柱边长×(层高−板厚)×柱数×层数；接点细部为方案口径', reference: '55', range: '45–65 元/m²', terms: ['模板'] },
    { id: 'beam-formwork', code: '011702006001', name: '矩形梁模板', unit: 'm²', quantity: 'beamFormwork', group: '模板', category: '措施项目', basis: '板下梁的双侧+底面，净长扣柱宽；次梁为指标长度', reference: '55', range: '45–65 元/m²', terms: ['模板'] },
    { id: 'slab-formwork', code: '011702014001', name: '有梁板模板', unit: 'm²', quantity: 'slabFormwork', group: '模板', category: '措施项目', basis: '板底扣方案柱与梁投影，再加周边侧模；次梁投影为指标估算', reference: '55', range: '45–65 元/m²', terms: ['模板'] },
    { id: 'wall-formwork', code: '011702010001', name: '混凝土墙模板', unit: 'm²', quantity: 'wallFormwork', group: '模板', category: '措施项目', basis: '用户混凝土墙长×净层高×双面×层数，未扣洞口细部模板', reference: '55', range: '45–65 元/m²', terms: ['模板'] },
    { id: 'rebar', code: '010515001001', name: '现浇构件钢筋', unit: 't', quantity: 'rebar', group: '钢筋', basis: '建筑面积×用户钢筋含量指标/1000，不是配筋设计或钢筋明细表', reference: '4500', range: '4200–4800 元/t', terms: ['钢筋', '螺纹钢'] },
    { id: 'scaffolding', code: '011701001001', name: '综合脚手架', unit: 'm²', quantity: 'scaffolding', group: '施工措施', category: '措施项目', basis: '建筑面积方案指标' },
    { id: 'transport', code: '011703001001', name: '垂直运输', unit: 'm²', quantity: 'verticalTransport', group: '施工措施', category: '措施项目', basis: '建筑面积方案指标' },
];
function priceFor(def, config, materials) {
    const expected = def.unit === 't' ? '吨' : def.unit;
    const concrete = def.group === '混凝土' && def.id !== 'cushion';
    const matching = materials.filter(m => !m.demo && (m.unit === expected || m.unit === def.unit) && (concrete ? m.name.includes(config.concreteGrade) : (def.terms ?? []).some(term => m.name.includes(term))));
    const construction = matching.find(m => m.provenance?.priceBasis === 'comprehensive-construction' && m.provenance?.taxIncluded === false);
    if (construction) {
        const price = normalizeDecimal(construction.unitPrice, '综合施工报价');
        return { price, status: price === '0' ? 'missing' : 'reference',
            note: `明确未税综合施工报价参考：${construction.name}；${construction.provenance?.source ?? '用户报价'}；${construction.provenance?.priceDate ?? '来源日期未提供'}；元数据声明包含材料、人工及机械，需按本项施工范围确认` };
    }
    const material = matching[0];
    if (material) {
        const supplyPrice = normalizeDecimal(material.unitPrice, '材料库单价');
        const scope = material.provenance?.priceBasis === 'comprehensive-construction'
            ? '综合报价未明确为未税价，不能与统一税率直接合用'
            : '供货材料价未包含完整人工及机械，不能直接充当综合施工报价';
        return { price: '0', status: 'missing',
            note: `材料库报价参考：${material.name} ${supplyPrice} 元/${def.unit}；${material.provenance?.source ?? '手工材料库'}；${material.provenance?.priceDate ?? '来源日期未提供'}；${scope}；综合单价待填写，此参考金额未计入合价` };
    }
    if (concrete && config.concreteGrade === 'C30')
        return { price: '520', status: 'reference', note: '任务书参考区间480–560 元/m³，参考值，未取当地信息价' };
    if (def.reference)
        return { price: def.reference, status: 'reference', note: `任务书参考区间${def.range}，参考值，未取当地信息价` };
    return { price: '0', status: 'missing', note: '综合单价待填写，尚无当地信息价；零值仅为占位，不能作为已完成预算' };
}
export function calculateStructureItems(project) {
    const state = project.cost?.modules?.structure;
    if (!state?.enabled)
        return [];
    const model = calculateStructureModel(project, state.config), config = model.config;
    const materials = (state.materials ?? project.materialsSnapshot ?? []);
    if (!Array.isArray(materials))
        throw new RangeError('土建材料快照应为数组');
    const items = definitions.filter(def => !['walls', 'wall-formwork'].includes(def.id) || config.system === 'frame-shear').map(def => {
        const p = priceFor(def, config, materials);
        const name = def.id === 'foundation' ? `${{ spread: '独立', strip: '条形', raft: '筏板' }[config.foundation]}基础混凝土`
            : config.system === 'masonry' && def.id === 'columns' ? '矩形柱（构造柱方案）' : config.system === 'masonry' && def.id === 'beams' ? '矩形梁（圈梁方案）' : def.name;
        return createCostItem({ id: `structure:${def.id}`, section: '土建', category: def.category ?? '分部分项', code: def.code, name,
            feature: `${config.concreteGrade}；${config.floors}层×${config.floorHeight}m；柱${config.columnSize}mm；板厚${config.slabThickness}mm`,
            unit: def.unit, quantity: quantity(model.quantities[def.quantity]), unitPrice: p.price, priceStatus: p.status, estimate: true, source: 'generated', group: def.group,
            basis: def.basis, note: `${def.basis}；${p.note}；方案估算，编码为示意，以当地清单规范为准` });
    });
    return applyModulePrices(items, state);
}
export function validateStructureState(state) {
    if (state.config !== undefined)
        normalizeStructureConfig(state.config);
    if (state.modelGenerated !== undefined && typeof state.modelGenerated !== 'boolean')
        throw new RangeError('结构生成状态不正确');
    if (state.materials !== undefined && !Array.isArray(state.materials))
        throw new RangeError('结构材料快照格式不正确');
}
//# sourceMappingURL=structure.js.map