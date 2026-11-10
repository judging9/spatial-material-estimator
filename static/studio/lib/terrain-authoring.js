import { MAX_TERRAIN_RASTER_CELLS, compileTerrain, terrainElevation, validateTerrain } from './terrain.js';
const presetNames = { flat: '平地', hill: '丘陵', basin: '盆地', valley: '河谷', mountain: '高山', ridge: '山脉', canyon: '峡谷' };
const finite = (value, label, min, max) => {
    if (!Number.isFinite(value) || value < min || value > max)
        throw new RangeError(`${label}应为 ${min}–${max} 范围内的有效数字。`);
};
function editable(model) {
    const result = structuredClone(model);
    const source = result.sourceName ?? '手工地形';
    if (!source.includes('人工塑形'))
        result.sourceName = source.slice(0, 216) + ' · 人工塑形（非实测现状）';
    return result;
}
/** User-created concept surface. Sample centres start at the requested origin;
 * the requested span is rounded up to whole square intervals and never shrunk.
 * These explicitly chosen elevations are not claimed to be survey data. */
export function createTerrainGrid(options) {
    const { width, length, cellSize, baseElevation, relief, preset } = options;
    finite(width, '场地宽度（m）', .001, 1e7);
    finite(length, '场地长度（m）', .001, 1e7);
    finite(cellSize, '网格间距（m）', .001, 1e7);
    finite(baseElevation, '基准高程（m）', -1e5, 1e5);
    finite(relief, '起伏高度（m）', 0, 1e5);
    finite(options.rotation ?? 0, '地形走向（°）', -36000, 36000);
    if (!Object.hasOwn(presetNames, preset))
        throw new RangeError('请选择有效的地形预设。');
    const ncols = Math.max(2, Math.ceil(width / cellSize) + 1), nrows = Math.max(2, Math.ceil(length / cellSize) + 1);
    if (ncols * nrows > MAX_TERRAIN_RASTER_CELLS)
        throw new RangeError(`网格过密，最多 ${MAX_TERRAIN_RASTER_CELLS} 个高程点；请增大网格间距。`);
    const sampleX = options.originX ?? 0, sampleY = options.originY ?? 0;
    finite(sampleX, '起点 X（m）', -1e7, 1e7);
    finite(sampleY, '起点 Y（m）', -1e7, 1e7);
    const originX = sampleX - cellSize / 2, originY = sampleY - cellSize / 2;
    const angle = (options.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const values = Array.from({ length: ncols * nrows }, (_, index) => {
        const u = index % ncols / (ncols - 1), v = Math.floor(index / ncols) / (nrows - 1);
        const radial = Math.max(0, 1 - ((u - .5) ** 2 + (v - .5) ** 2) * 4);
        const valley = Math.max(0, 1 - Math.abs(u - (.5 + .12 * Math.sin(v * Math.PI * 2))) / .22);
        const dx = 2 * (u - .5), dy = 2 * (v - .5);
        const px = dx * (ncols - 1) * cellSize / 2, py = dy * (nrows - 1) * cellSize / 2;
        const across = (-s * px + c * py) / ((Math.abs(s) * (ncols - 1) + Math.abs(c) * (nrows - 1)) * cellSize / 2);
        const along = (c * px + s * py) / ((Math.abs(c) * (ncols - 1) + Math.abs(s) * (nrows - 1)) * cellSize / 2);
        const peak = Math.max(0, 1 - Math.hypot(dx, dy)) ** 1.5;
        const crest = Math.max(0, 1 - Math.abs(across - .12 * Math.sin(along * Math.PI * 2)) / .34) ** 1.5;
        const ridge = crest * Math.max(0, 1 - along ** 2) ** .5 * (.7 + .3 * Math.cos(along * Math.PI * 2) ** 2);
        const gorge = Math.max(0, 1 - Math.abs(across - .12 * Math.sin(along * Math.PI * 2)) / .24) ** .5;
        const delta = preset === 'flat' ? 0 : preset === 'hill' ? relief * radial ** 2 : preset === 'basin' ? -relief * radial ** 2 : preset === 'valley' ? -relief * valley ** 2 : preset === 'mountain' ? relief * peak : preset === 'ridge' ? relief * ridge : -relief * gorge;
        return baseElevation + delta;
    });
    const raster = { format: 'esri-ascii', ncols, nrows, cellSize, originX, originY, xllcorner: originX, yllcorner: -originY - nrows * cellSize, noDataValue: null, coordinateUnit: 'm', yDirection: 'north-up', values };
    const model = { name: `自建${presetNames[preset]}地形`, sourceName: `自建概念地形 · ${presetNames[preset]}（非实测）`, visible: true, points: [], raster };
    validateTerrain(model);
    return model;
}
function samples(model) {
    if (!model.raster)
        return model.points.map((p, index) => ({ x: p.x, y: p.y, z: p.z, index }));
    const r = model.raster;
    return r.values.map((z, index) => ({ x: r.originX + (index % r.ncols + .5) * r.cellSize, y: r.originY + (Math.floor(index / r.ncols) + .5) * r.cellSize, z, index }));
}
function writeSample(model, index, z) {
    finite(z, '塑形后高程（m）', -1e5, 1e5);
    if (model.raster)
        model.raster.values[index] = z;
    else
        model.points[index].z = z;
}
/** A stamp changes supplied elevations only. NoData remains NoData. All smooth
 * targets use the pre-stamp samples, so traversal order cannot bias the result. */
export function applyTerrainBrush(model, center, options) {
    validateTerrain(model);
    finite(center.x, '笔刷 X（m）', -1e7, 1e7);
    finite(center.y, '笔刷 Y（m）', -1e7, 1e7);
    finite(options.radius, '笔刷半径（m）', .001, 1e7);
    finite(options.strength, '每次最大变化（m）', 0, 1e5);
    if (!['raise', 'lower', 'flatten', 'smooth'].includes(options.mode))
        throw new RangeError('笔刷类型不正确。');
    if (options.mode === 'flatten')
        finite(options.targetElevation, '平整目标高程（m）', -1e5, 1e5);
    const result = editable(model), input = samples(model), raster = model.raster;
    for (const sample of input) {
        if (sample.z === null)
            continue;
        const normalized = Math.hypot(sample.x - center.x, sample.y - center.y) / options.radius;
        if (normalized >= 1)
            continue;
        const weight = (1 - normalized ** 2) ** 2, step = options.strength * weight;
        let delta = options.mode === 'raise' ? step : options.mode === 'lower' ? -step : 0;
        if (options.mode === 'flatten')
            delta = Math.max(-step, Math.min(step, options.targetElevation - sample.z));
        if (options.mode === 'smooth') {
            let sum = 0, count = 0;
            if (raster) {
                const row = Math.floor(sample.index / raster.ncols), col = sample.index % raster.ncols;
                for (let dr = -1; dr <= 1; dr++)
                    for (let dc = -1; dc <= 1; dc++) {
                        if (row + dr < 0 || row + dr >= raster.nrows || col + dc < 0 || col + dc >= raster.ncols)
                            continue;
                        const z = raster.values[(row + dr) * raster.ncols + col + dc];
                        if (z !== null) {
                            sum += z;
                            count++;
                        }
                    }
            }
            else {
                for (const neighbour of input)
                    if (neighbour.z !== null && Math.hypot(neighbour.x - sample.x, neighbour.y - sample.y) <= options.radius) {
                        sum += neighbour.z;
                        count++;
                    }
            }
            if (count)
                delta = Math.max(-step, Math.min(step, sum / count - sample.z));
        }
        writeSample(result, sample.index, sample.z + delta);
    }
    validateTerrain(result);
    return result;
}
export function terrainPathDistance(point, path) {
    let best = Infinity;
    for (let index = 1; index < path.length; index++) {
        const a = path[index - 1], b = path[index], dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
        best = Math.min(best, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
    }
    return best;
}
/** One local feature changes every supplied sample at most once. Long or
 * crossing paths never multiply the requested crest height / valley depth. */
export function sculptTerrainFeature(model, path, options) {
    validateTerrain(model);
    if (!options || !['peak', 'hollow', 'ridge', 'canyon'].includes(options.mode))
        throw new RangeError('请选择山峰、低谷、山脊或峡谷工具。');
    const pointFeature = options.mode === 'peak' || options.mode === 'hollow';
    if (!Array.isArray(path) || path.length < (pointFeature ? 1 : 2) || path.length > (pointFeature ? 1 : 200))
        throw new RangeError(pointFeature ? '山峰与低谷使用一个中心点。' : '山脊与峡谷需要 2–200 个路径点。');
    path.forEach(p => { finite(p?.x, '塑形位置 X（m）', -1e7, 1e7); finite(p?.y, '塑形位置 Y（m）', -1e7, 1e7); });
    if (path.slice(1).some((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y) < 1e-9))
        throw new RangeError('塑形路径相邻节点不能重合。');
    finite(options.radius, '塑形影响半径（m）', .001, 1e7);
    finite(options.relief, '山高 / 谷深（m）', .001, 1e5);
    const result = editable(model), sign = options.mode === 'peak' || options.mode === 'ridge' ? 1 : -1;
    let touched = 0;
    for (const sample of samples(model)) {
        if (sample.z === null)
            continue;
        const distance = pointFeature ? Math.hypot(sample.x - path[0].x, sample.y - path[0].y) : terrainPathDistance(sample, path);
        const q = distance / options.radius;
        if (q >= 1)
            continue;
        const weight = (1 - q) ** (options.mode === 'canyon' ? .5 : options.mode === 'hollow' ? 2 : 1.5);
        writeSample(result, sample.index, sample.z + sign * options.relief * weight);
        touched++;
    }
    if (!touched)
        throw new RangeError('影响范围内没有有效高程点，请增大半径或移动到已有地形。');
    validateTerrain(result);
    return result;
}
/** A true metre-distance section. Missing terrain and NoData stay null; the
 * UI must break its profile at those samples rather than invent an elevation. */
export function terrainSectionProfile(model, start, end, count = 65) {
    validateTerrain(model);
    for (const [label, point] of [['起点', start], ['终点', end]]) {
        finite(point?.x, `剖面${label} X（m）`, -1e7, 1e7);
        finite(point?.y, `剖面${label} Y（m）`, -1e7, 1e7);
    }
    if (!Number.isInteger(count) || count < 2 || count > 257)
        throw new RangeError('地形剖面采样数应为 2–257 的整数。');
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (length <= 1e-9)
        throw new RangeError('地形剖面起点与终点不能重合。');
    const mesh = model.raster ? undefined : compileTerrain(model);
    return Array.from({ length: count }, (_, index) => {
        const t = index / (count - 1), x = start.x + dx * t, y = start.y + dy * t;
        return { x, y, distance: length * t, elevation: terrainElevation(model, x, y, mesh) };
    });
}
/** Carves a ground-following channel once per sample, including intersecting
 * path segments. Width is bed width; bankSlope is horizontal / vertical (1:n).
 * This is editable geometric modelling, not a hydraulic river simulation. */
export function carveTerrainRiver(model, path, options) {
    validateTerrain(model);
    if (!Array.isArray(path) || path.length < 2 || path.length > 200)
        throw new RangeError('河槽路径需要 2–200 个点。');
    path.forEach(p => { finite(p?.x, '河槽 X（m）', -1e7, 1e7); finite(p?.y, '河槽 Y（m）', -1e7, 1e7); });
    if (path.slice(1).some((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y) < 1e-9))
        throw new RangeError('河槽相邻节点不能重合。');
    finite(options.width, '河底宽度（m）', .001, 1e7);
    finite(options.depth, '河槽深度（m）', .001, 1e5);
    finite(options.bankSlope, '岸坡水平系数', 0, 1000);
    if (options.bedElevation !== undefined)
        finite(options.bedElevation, '河床高程（m）', -1e5, 1e5);
    const result = editable(model), bankWidth = options.depth * options.bankSlope;
    for (const sample of samples(model)) {
        if (sample.z === null)
            continue;
        const distance = terrainPathDistance(sample, path), outside = Math.max(0, distance - options.width / 2);
        const blend = outside === 0 ? 1 : bankWidth > 0 ? Math.max(0, 1 - outside / bankWidth) : 0;
        const cut = (options.bedElevation === undefined ? options.depth : Math.max(0, sample.z - options.bedElevation)) * blend;
        if (cut)
            writeSample(result, sample.index, sample.z - cut);
    }
    validateTerrain(result);
    return result;
}
//# sourceMappingURL=terrain-authoring.js.map