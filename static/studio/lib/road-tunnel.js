import { municipalScale, municipalEffectiveWidth, municipalCorridor } from './municipal-design.js';
import { roadStations, roadPointAtStation, roadProfileElevation, roadProfileGrade, roadProfileSegments, roadSurfaceErrorBound, roadCrossSectionAtStation, validateRoadProfile } from './road-profile.js';
import { compileTerrain, terrainElevation } from './terrain.js';
import { normalizeDecimal } from './pricing.js';
import { normalizePriceProvenance } from './price-provenance.js';
export const MAX_TUNNEL_SECTIONS = 512;
const EPS = 1e-8;
const geometryCache = new Map();
const analysisCache = new Map();
export function roadTunnelGeometryKey(project, road) {
    const profile = road.roadProfile, tunnel = road.tunnel;
    return JSON.stringify([project.drawing?.type, project.calibration.metersPerPixel, road.id, road.points, road.width, road.roadLayout, road.elevation, profile?.enabled ? { points: profile.points, tolerance: profile.curveTolerance, crossSection: profile.crossSection, crossfallPoints: profile.crossfallPoints } : null, tunnel ? { enabled: tunnel.enabled, start: tunnel.startStation, end: tunnel.endStation, height: tunnel.clearHeight, thickness: tunnel.liningThickness, shape: tunnel.shape } : null]);
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z); return l > EPS ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 0 }; };
const lerp3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const area3 = (points) => points.slice(2).reduce((sum, p, i) => sum + Math.hypot(...Object.values(cross(sub(points[i + 1], points[0]), sub(p, points[0])))) / 2, 0);
const boundsOf = (points) => ({ min: { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)), z: Math.min(...points.map(p => p.z)) }, max: { x: Math.max(...points.map(p => p.x)), y: Math.max(...points.map(p => p.y)), z: Math.max(...points.map(p => p.z)) } });
const sorted = (values) => [...new Set(values.map(v => Math.round(v * 1e9) / 1e9))].sort((a, b) => a - b);
const elevationAt = (road, station) => road.roadProfile?.enabled ? roadProfileElevation(road.roadProfile, station) : road.elevation / 100;
export function validateRoadTunnel(project, road, tunnel = road.tunnel) {
    if (tunnel === undefined)
        return;
    if (road.kind !== 'road' || !tunnel || typeof tunnel.enabled !== 'boolean')
        throw new RangeError('隧道仅适用于道路，隧道开关无效。');
    if (![tunnel.startStation, tunnel.endStation, tunnel.clearHeight, tunnel.liningThickness].every(Number.isFinite) || tunnel.startStation < 0 || tunnel.endStation - tunnel.startStation < .1)
        throw new RangeError('隧道起终里程应递增，长度至少为 0.1 m。');
    if (tunnel.clearHeight < .5 || tunnel.clearHeight > 30)
        throw new RangeError('隧道净高应为 0.5–30 m。');
    if (tunnel.liningThickness < .05 || tunnel.liningThickness > 3)
        throw new RangeError('隧道衬砌厚度应为 0.05–3 m。');
    if (!['box', 'arch'].includes(tunnel.shape))
        throw new RangeError('隧道截面应为箱形或拱形。');
    if (tunnel.pricingEnabled !== undefined && typeof tunnel.pricingEnabled !== 'boolean')
        throw new RangeError('隧道计价开关无效。');
    for (const key of ['unitPrice', 'laborRate', 'additionalCost']) {
        if (typeof tunnel[key] !== 'string' || key !== 'unitPrice' && tunnel[key] === '')
            throw new RangeError('隧道费用应为有效十进制金额，人工与固定费用无费用时填 0。');
        if (tunnel[key] !== '')
            normalizeDecimal(tunnel[key], '隧道费用');
    }
    normalizePriceProvenance(tunnel.provenance);
    if (tunnel.priceMaterialId !== undefined && (typeof tunnel.priceMaterialId !== 'string' || !tunnel.priceMaterialId.trim() || tunnel.priceMaterialId.length > 200))
        throw new RangeError('隧道价格材料关联编号无效。');
    if (tunnel.priceSourceUnitPrice !== undefined) {
        if (typeof tunnel.priceSourceUnitPrice !== 'string' || tunnel.priceSourceUnitPrice === '')
            throw new RangeError('隧道来源单价无效。');
        normalizeDecimal(tunnel.priceSourceUnitPrice, '隧道来源单价');
    }
    if (!Array.isArray(road.points) || road.points.length < 2 || road.points.some(p => ![p.x, p.y].every(Number.isFinite)))
        throw new RangeError('请先画出有效道路中心线。');
    const width = municipalEffectiveWidth(road) / 100;
    if (!Number.isFinite(width) || width <= 0 || width > 1000)
        throw new RangeError('隧道路宽应为有效正数。');
    if (project) {
        const stations = roadStations(project, road), length = stations?.at(-1);
        if (length !== undefined && tunnel.endStation > length + Math.max(EPS, length * 1e-9))
            throw new RangeError('隧道终点不能超出道路实际长度。');
        // Do not call validateMunicipalElements: it delegates back to this validator.
        validateRoadProfile(project, road);
        if (tunnel.enabled && stations) {
            const path = tunnelPlan(project, road, tunnel.startStation, tunnel.endStation);
            municipalCorridor(path, width + 2 * tunnel.liningThickness);
            tunnelFrames(project, road, sorted([tunnel.startStation, ...stations.filter(s => s > tunnel.startStation && s < tunnel.endStation), tunnel.endStation]));
        }
    }
}
function tunnelPlan(project, road, start, end) {
    const stations = roadStations(project, road) ?? [];
    return [start, ...stations.filter(s => s > start + EPS && s < end - EPS), end].map(s => roadPointAtStation(project, road, s));
}
/** Bounded miter sections share vertices at bends, without doubled corner volume. */
function tunnelFrames(project, road, stations) {
    if (stations.length > MAX_TUNNEL_SECTIONS)
        throw new RangeError(`隧道断面超过 ${MAX_TUNNEL_SECTIONS} 个，请缩短隧道区间或放宽道路曲线精度。`);
    const routeStations = roadStations(project, road), scale = municipalScale(project), route = road.points.map(p => ({ x: p.x * scale, y: p.y * scale }));
    const directions = route.slice(1).map((p, i) => { const dx = p.x - route[i].x, dy = p.y - route[i].y, length = Math.hypot(dx, dy); if (length <= EPS)
        throw new RangeError('隧道路线相邻节点不能重合。'); return { x: dx / length, y: dy / length }; });
    const nodeNormals = route.map((_, i) => {
        if (i === 0)
            return { x: -directions[0].y, y: directions[0].x };
        if (i === route.length - 1)
            return { x: -directions.at(-1).y, y: directions.at(-1).x };
        const a = directions[i - 1], b = directions[i], sum = { x: a.x + b.x, y: a.y + b.y }, length = Math.hypot(sum.x, sum.y);
        if (length < EPS)
            throw new RangeError('隧道不能原路折返。');
        const tangent = { x: sum.x / length, y: sum.y / length }, n = { x: -tangent.y, y: tangent.x }, factor = n.x * (-a.y) + n.y * a.x;
        if (factor < .25)
            throw new RangeError('隧道转角过急，请将急转弯改成平缓的多个节点。');
        return { x: n.x / factor, y: n.y / factor };
    });
    return stations.map(station => {
        let segment = routeStations.findIndex((s, i) => i > 0 && station < s - EPS) - 1;
        if (segment < 0)
            segment = directions.length - 1;
        let tangent = directions[segment];
        const fraction = Math.max(0, Math.min(1, (station - routeStations[segment]) / (routeStations[segment + 1] - routeStations[segment]))), first = nodeNormals[segment], last = nodeNormals[segment + 1], normal = { x: first.x + (last.x - first.x) * fraction, y: first.y + (last.y - first.y) * fraction };
        const corner = routeStations.findIndex((s, i) => i > 0 && i < routeStations.length - 1 && Math.abs(s - station) <= EPS);
        if (corner > 0) {
            const sum = { x: directions[corner - 1].x + directions[corner].x, y: directions[corner - 1].y + directions[corner].y }, length = Math.hypot(sum.x, sum.y);
            tangent = { x: sum.x / length, y: sum.y / length };
        }
        return { station, point: roadPointAtStation(project, road, station), normal, tangent, elevation: elevationAt(road, station) };
    });
}
function tunnelControlStations(project, road, tunnel) {
    const values = [tunnel.startStation, tunnel.endStation, ...(roadStations(project, road) ?? []).filter(s => s > tunnel.startStation && s < tunnel.endStation)];
    if (road.roadProfile?.enabled) {
        for (const segment of roadProfileSegments(project, road)) {
            const a = Math.max(tunnel.startStation, segment.startStation), b = Math.min(tunnel.endStation, segment.endStation);
            if (b <= a)
                continue;
            values.push(a, b);
        }
        values.push(...road.roadProfile.points.map(p => p.station).filter(s => s > tunnel.startStation && s < tunnel.endStation));
        values.push(...(road.roadProfile.crossfallPoints ?? []).map(p => p.station).filter(s => s > tunnel.startStation && s < tunnel.endStation));
    }
    const basic = sorted(values);
    if (!road.roadProfile?.enabled)
        return basic;
    const tolerance = road.roadProfile.curveTolerance ?? .002, result = [basic[0]], width = municipalEffectiveWidth(road) / 100, outerFactor = (width + 2 * tunnel.liningThickness) / width;
    const subdivide = (a, b, depth) => {
        if (result.length >= MAX_TUNNEL_SECTIONS || depth > 30)
            throw new RangeError(`隧道曲线需要超过 ${MAX_TUNNEL_SECTIONS} 个断面，请缩短区间或放宽道路曲线精度。`);
        if (roadSurfaceErrorBound(project, road, a, b) * outerFactor <= tolerance) {
            result.push(b);
            return;
        }
        const middle = (a + b) / 2;
        subdivide(a, middle, depth + 1);
        subdivide(middle, b, depth + 1);
    };
    for (let i = 1; i < basic.length; i++)
        subdivide(basic[i - 1], basic[i], 0);
    return result;
}
/** Faceted convex clearance is also the quantity section, matching the model. */
function tunnelSection(width, height, shape) {
    const half = width / 2;
    // Include the real road crown in both floor and roof. It is essential when
    // left and right crossfalls differ: a chord between edges is not the road.
    if (shape === 'box')
        return [{ x: -half, y: 0 }, { x: 0, y: 0 }, { x: half, y: 0 }, { x: half, y: height }, { x: 0, y: height }, { x: -half, y: height }];
    const spring = height * .55, arch = height - spring;
    return [{ x: -half, y: 0 }, { x: 0, y: 0 }, { x: half, y: 0 }, ...Array.from({ length: 17 }, (_, i) => ({ x: half * Math.cos(i * Math.PI / 16), y: spring + arch * Math.sin(i * Math.PI / 16) }))];
}
/** Offset each real edge by lining thickness, then intersect adjacent edges. */
function offsetSection(ring, thickness) {
    const lines = ring.map((p, i) => { const q = ring[(i + 1) % ring.length], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy); return { p: { x: p.x + dy / l * thickness, y: p.y - dx / l * thickness }, d: { x: dx / l, y: dy / l } }; });
    return ring.map((_, i) => { const a = lines[(i + ring.length - 1) % ring.length], b = lines[i], det = a.d.x * b.d.y - a.d.y * b.d.x; if (Math.abs(det) < EPS)
        return b.p; const x = b.p.x - a.p.x, y = b.p.y - a.p.y, t = (x * b.d.y - y * b.d.x) / det; return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y }; });
}
function framePoint(road, frame, p) {
    const slopes = road.roadProfile?.enabled ? roadCrossSectionAtStation(road.roadProfile, frame.station) : { leftSlope: 0, rightSlope: 0 };
    const crossfall = Math.abs(p.x) * (p.x < 0 ? slopes.rightSlope : slopes.leftSlope) / 100;
    return { x: frame.point.x + frame.normal.x * p.x, y: frame.elevation + p.y + crossfall, z: frame.point.y + frame.normal.y * p.x };
}
function tetrahedron(points) {
    const [a, b, c, d] = points, volume = Math.abs(dot(sub(b, a), cross(sub(c, a), sub(d, a)))) / 6;
    if (volume < 1e-11)
        return null;
    const planes = points.map((opposite, i) => { const face = points.filter((_, j) => j !== i); let normal = norm(cross(sub(face[1], face[0]), sub(face[2], face[0]))); if (dot(normal, sub(opposite, face[0])) < 0)
        normal = { x: -normal.x, y: -normal.y, z: -normal.z }; return { normal, constant: -dot(normal, face[0]) }; });
    return { void: { planes, bounds: boundsOf(points) }, volume };
}
function tunnelLength(project, road, start, end) {
    if (!road.roadProfile?.enabled)
        return end - start;
    const primitive = (g) => (g * Math.hypot(1, g) + Math.asinh(g)) / 2;
    return roadProfileSegments(project, road).reduce((sum, segment) => {
        const a = Math.max(start, segment.startStation), b = Math.min(end, segment.endStation);
        if (b <= a)
            return sum;
        const k = (segment.endGrade - segment.startGrade) / (segment.endStation - segment.startStation), g0 = segment.startGrade + k * (a - segment.startStation), g1 = segment.startGrade + k * (b - segment.startStation);
        return sum + (Math.abs(k) < 1e-12 ? (b - a) * Math.hypot(1, g0) : (primitive(g1) - primitive(g0)) / k);
    }, 0);
}
function emptyAnalysis(road) {
    return { startStation: road.tunnel?.startStation ?? null, endStation: road.tunnel?.endStation ?? null, shape: road.tunnel?.shape ?? null, quantityBasis: 'length', enabled: !!road.tunnel?.enabled, length: null, horizontalLength: null, liningArea: null, voidVolume: null, sectionArea: null, netWidth: null, clearHeight: road.tunnel?.clearHeight ?? null, portals: [], coveredLength: 0, unknownLength: null, cover: { min: null, max: null, coveredLength: 0, unknownLength: null }, warnings: [] };
}
/** Pure geometry drives both displayed surfaces and measured quantities. */
function buildRoadTunnelGeometry(project, road) {
    const analysis = emptyAnalysis(road), surfaces = [], voids = [];
    if (!road.tunnel?.enabled)
        return { surfaces, voids, analysis };
    const scale = municipalScale(project);
    if (!scale) {
        analysis.warnings.push('图纸尚未校准，隧道数量待计算。');
        return { surfaces, voids, analysis };
    }
    const tunnel = road.tunnel, width = municipalEffectiveWidth(road) / 100;
    const stations = tunnelControlStations(project, road, tunnel);
    const frames = tunnelFrames(project, road, stations), section = tunnelSection(width, tunnel.clearHeight, tunnel.shape), outerSection = offsetSection(section, tunnel.liningThickness);
    const inner = frames.map(frame => section.map(p => framePoint(road, frame, p))), outer = frames.map(frame => outerSection.map(p => framePoint(road, frame, p))), owner = `municipal:${road.id}`;
    const emit = (id, points, toward, color) => {
        // Triangulate twisted quads explicitly. The viewer, area and void share diagonals.
        for (let i = 1; i < points.length - 1; i++) {
            const triangle = [points[0], points[i], points[i + 1]], normal = norm(cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0])));
            if (!Number.isFinite(normal.x) || Math.hypot(normal.x, normal.y, normal.z) < EPS)
                continue;
            if (dot(normal, toward) < 0) {
                triangle.reverse();
                normal.x = -normal.x;
                normal.y = -normal.y;
                normal.z = -normal.z;
            }
            surfaces.push({ id: `${owner}:tunnel:${id}:${i}`, wallId: owner, sourceIds: [], side: 'end', points: triangle, normal, color });
        }
    };
    let volume = 0, liningArea = 0;
    for (let j = 0; j < frames.length - 1; j++) {
        for (let i = 0; i < section.length; i++) {
            const next = (i + 1) % section.length, mid = { x: (section[i].x + section[next].x) / 2, y: (section[i].y + section[next].y) / 2 }, inward = { x: -mid.x * frames[j].normal.x, y: tunnel.clearHeight / 2 - mid.y, z: -mid.x * frames[j].normal.y };
            // The existing roadway is the clearance floor; no coplanar duplicate roof.
            if (i > 1) {
                const face = [inner[j][i], inner[j][next], inner[j + 1][next], inner[j + 1][i]];
                liningArea += area3(face);
                emit(`inside:${j}:${i}`, face, inward, '#c0c5bf');
            }
            emit(`outside:${j}:${i}`, [outer[j][i], outer[j][next], outer[j + 1][next], outer[j + 1][i]], { x: -inward.x, y: -inward.y, z: -inward.z }, '#9da89f');
        }
        // A centre fan remains valid for a crowned road's concave floor. A fan
        // from its left corner would overlap at the crown and overcount volume.
        const centerA = framePoint(road, frames[j], { x: 0, y: tunnel.clearHeight / 2 }), centerB = framePoint(road, frames[j + 1], { x: 0, y: tunnel.clearHeight / 2 });
        for (let i = 0; i < section.length; i++) {
            const next = (i + 1) % section.length, a = [centerA, inner[j][i], inner[j][next]], b = [centerB, inner[j + 1][i], inner[j + 1][next]];
            for (const points of [[a[0], a[1], a[2], b[2]], [a[0], a[1], b[1], b[2]], [a[0], b[0], b[1], b[2]]]) {
                const tetra = tetrahedron(points);
                if (tetra) {
                    voids.push(tetra.void);
                    volume += tetra.volume;
                }
            }
        }
    }
    // Portal rings leave the complete clearance open at both ends.
    for (const j of [0, frames.length - 1]) {
        const frame = frames[j], sign = j === 0 ? 1 : -1, grade = road.roadProfile?.enabled ? roadProfileGrade(road.roadProfile, frame.station) : 0, direction = norm({ x: frame.tangent.x * sign, y: grade * sign, z: frame.tangent.y * sign });
        analysis.portals.push({ station: frame.station, point: { x: frame.point.x, y: frame.elevation, z: frame.point.y }, direction });
        for (let i = 0; i < section.length; i++) {
            const next = (i + 1) % section.length;
            emit(`portal:${j}:${i}`, [outer[j][i], outer[j][next], inner[j][next], inner[j][i]], { x: -direction.x, y: -direction.y, z: -direction.z }, '#bbc1b7');
        }
    }
    analysis.length = tunnelLength(project, road, tunnel.startStation, tunnel.endStation);
    analysis.horizontalLength = tunnel.endStation - tunnel.startStation;
    analysis.liningArea = liningArea;
    analysis.voidVolume = volume;
    analysis.sectionArea = Math.abs(section.reduce((sum, p, i) => { const q = section[(i + 1) % section.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
    analysis.netWidth = width;
    return { surfaces, voids, analysis };
}
export function roadTunnelGeometry(project, road) {
    validateRoadTunnel(project, road);
    const key = roadTunnelGeometryKey(project, road), previous = geometryCache.get(key);
    if (previous)
        return previous;
    const geometry = buildRoadTunnelGeometry(project, road);
    if (geometryCache.size >= 6)
        geometryCache.delete(geometryCache.keys().next().value);
    geometryCache.set(key, geometry);
    return geometry;
}
/** Partition the real route at mesh edges. NoData is never bridged by sampling. */
function terrainStationBreaks(project, road, mesh, start, end) {
    const routeStations = roadStations(project, road) ?? [], path = road.points, scale = municipalScale(project), values = [start, end, ...routeStations.filter(s => s > start && s < end)];
    for (let k = 0; k < path.length - 1; k++) {
        const a = { x: path[k].x * scale, y: path[k].y * scale }, b = { x: path[k + 1].x * scale, y: path[k + 1].y * scale }, dx = b.x - a.x, dy = b.y - a.y, segLength = routeStations[k + 1] - routeStations[k];
        if (routeStations[k + 1] < start || routeStations[k] > end)
            continue;
        for (const triangle of mesh.triangles)
            for (let i = 0; i < 3; i++) {
                const c = triangle[i], d = triangle[(i + 1) % 3], ex = d.x - c.x, ey = d.y - c.y, denom = dx * ey - dy * ex;
                if (Math.abs(denom) < 1e-12)
                    continue;
                const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denom, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denom;
                if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
                    const station = routeStations[k] + Math.max(0, Math.min(1, t)) * segLength;
                    if (station > start && station < end)
                        values.push(station);
                }
            }
    }
    if (road.roadProfile?.enabled)
        for (const segment of roadProfileSegments(project, road))
            for (const s of [segment.startStation, segment.endStation])
                if (s > start && s < end)
                    values.push(s);
    const result = sorted(values);
    if (result.length > 20000)
        throw new RangeError('地形沿线分段过多，请减少地形网格或缩短道路区间。');
    return result;
}
function coverageIntervals(project, road, start, end, roofHeight) {
    if (!project.municipalTerrain)
        return [{ start, end, known: false, covered: false, min: null, max: null }];
    const model = project.municipalTerrain, mesh = compileTerrain(model), breaks = terrainStationBreaks(project, road, mesh, start, end), out = [];
    const difference = (station) => { const p = roadPointAtStation(project, road, station), ground = terrainElevation(model, p.x, p.y, mesh); return ground === null ? null : ground - elevationAt(road, station) - roofHeight; };
    for (let i = 1; i < breaks.length; i++) {
        const a = breaks[i - 1], b = breaks[i], middle = (a + b) / 2, mid = difference(middle);
        if (b - a < EPS)
            continue;
        if (mid === null) {
            out.push({ start: a, end: b, known: false, covered: false, min: null, max: null });
            continue;
        }
        // On one terrain triangle minus one profile segment, the difference is quadratic.
        // Its three genuine values determine all roots, including short hill crossings.
        const da = difference(a) ?? difference(a + (b - a) * 1e-6), db = difference(b) ?? difference(b - (b - a) * 1e-6);
        if (da === null || db === null) {
            out.push({ start: a, end: b, known: false, covered: false, min: null, max: null });
            continue;
        }
        const q = 2 * (da + db - 2 * mid), r = db - da - q, roots = [];
        if (Math.abs(q) < 1e-10) {
            if (Math.abs(r) > 1e-12)
                roots.push(-da / r);
        }
        else {
            const disc = r * r - 4 * q * da;
            if (disc >= 0) {
                const rt = Math.sqrt(disc);
                roots.push((-r - rt) / (2 * q), (-r + rt) / (2 * q));
            }
        }
        const partitions = sorted([0, ...roots.filter(t => t > EPS && t < 1 - EPS), 1]);
        for (let j = 1; j < partitions.length; j++) {
            const t0 = partitions[j - 1], t1 = partitions[j], value = (t) => q * t * t + r * t + da, values = [value(t0), value(t1)], extremum = -r / (2 * q);
            if (Number.isFinite(extremum) && extremum > t0 && extremum < t1)
                values.push(value(extremum));
            out.push({ start: a + t0 * (b - a), end: a + t1 * (b - a), known: true, covered: value((t0 + t1) / 2) > EPS, min: Math.min(...values), max: Math.max(...values) });
        }
    }
    return out;
}
export function roadTunnelAnalysis(project, road) {
    const geometry = roadTunnelGeometry(project, road), key = roadTunnelGeometryKey(project, road) + JSON.stringify(project.municipalTerrain ?? null), previous = analysisCache.get(key);
    if (previous)
        return previous;
    const analysis = { ...geometry.analysis, warnings: [...geometry.analysis.warnings], cover: { ...geometry.analysis.cover } };
    if (!analysis.enabled || analysis.horizontalLength === null)
        return analysis;
    const tunnel = road.tunnel, intervals = coverageIntervals(project, road, tunnel.startStation, tunnel.endStation, tunnel.clearHeight + tunnel.liningThickness);
    analysis.coveredLength = intervals.reduce((sum, i) => sum + (i.covered ? i.end - i.start : 0), 0);
    analysis.unknownLength = intervals.reduce((sum, i) => sum + (!i.known ? i.end - i.start : 0), 0);
    const known = intervals.filter(i => i.known);
    analysis.cover = { min: known.length ? Math.min(...known.map(i => i.min)) : null, max: known.length ? Math.max(...known.map(i => i.max)) : null, coveredLength: analysis.coveredLength, unknownLength: analysis.unknownLength };
    if (analysis.unknownLength > EPS)
        analysis.warnings.push(`沿线 ${analysis.unknownLength.toFixed(2)} m 地形缺测，覆土不能确认。`);
    if (known.some(i => i.min < 0))
        analysis.warnings.push('部分隧道顶面高于测得地形；请核对洞口位置、净高与道路标高。');
    analysis.warnings.push('覆土为实际中心线测点内插结果；不代表全洞宽勘测及结构安全验算。');
    if (analysisCache.size >= 12)
        analysisCache.delete(analysisCache.keys().next().value);
    analysisCache.set(key, analysis);
    return analysis;
}
export function suggestRoadTunnel(project, road) {
    if (road.kind !== 'road' || !project.municipalTerrain || !municipalScale(project))
        return null;
    const end = roadStations(project, road)?.at(-1);
    if (!end)
        return null;
    // Detect actual centreline burial, without inventing walls from a sample image.
    const intervals = coverageIntervals(project, road, 0, end, .05), groups = [];
    for (const i of intervals)
        if (i.known && i.covered) {
            const previous = groups.at(-1);
            if (previous && Math.abs(previous.end - i.start) < EPS)
                previous.end = i.end;
            else
                groups.push({ start: i.start, end: i.end });
        }
    const best = groups.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!best || best.end - best.start < .1)
        return null;
    const unknownLength = intervals.reduce((sum, i) => sum + (!i.known ? i.end - i.start : 0), 0);
    return { startStation: best.start, endStation: best.end, coveredLength: best.end - best.start, unknownLength, reason: `根据真实地形与道路高程检测到 ${groups.length} 段埋入区间，建议最长连续区间。${unknownLength > EPS ? '缺测区间未连接。' : ''}请核对洞口、净高和全宽勘测。` };
}
/** Remove only the selected tunnel interval from open-cut design triangles.
 * The complementary fragments retain original interpolation and absolute Z. */
export function excludeTunnelEarthworkTriangles(project, road, triangles, options = {}) {
    if (!road.tunnel?.enabled || !municipalScale(project))
        return triangles;
    const tunnel = road.tunnel;
    validateRoadTunnel(project, road);
    const frames = tunnelFrames(project, road, sorted([tunnel.startStation, ...(roadStations(project, road) ?? []).filter(s => s > tunnel.startStation && s < tunnel.endStation), tunnel.endStation]));
    const half = municipalEffectiveWidth(road) / 200 + tunnel.liningThickness + Math.max(0, options.extraWidth ?? 0), masks = [];
    const offset = (f, sign) => ({ x: f.point.x + f.normal.x * half * sign, y: f.point.y + f.normal.y * half * sign });
    for (let i = 1; i < frames.length; i++)
        masks.push([offset(frames[i - 1], 1), offset(frames[i - 1], -1), offset(frames[i], -1), offset(frames[i], 1)]);
    let pieces = triangles.map(triangle => triangle);
    for (const mask of masks) {
        const signed = mask.reduce((sum, p, i) => { const q = mask[(i + 1) % mask.length]; return sum + p.x * q.y - q.x * p.y; }, 0), sign = signed >= 0 ? 1 : -1;
        const planes = mask.map((a, i) => { const b = mask[(i + 1) % mask.length], length = Math.hypot(b.x - a.x, b.y - a.y), normal = { x: -(b.y - a.y) / length * sign, y: (b.x - a.x) / length * sign, z: 0 }; return { normal, constant: -normal.x * a.x - normal.y * a.y }; });
        const bounds = boundsOf(mask.map(p => ({ ...p, z: 0 })));
        pieces = pieces.flatMap(piece => { const box = boundsOf(piece); if (box.max.x < bounds.min.x - EPS || box.min.x > bounds.max.x + EPS || box.max.y < bounds.min.y - EPS || box.min.y > bounds.max.y + EPS)
            return [piece]; return subtractConvexPlanes(piece, planes); });
        if (pieces.length > 100000)
            throw new RangeError('隧道土方裁切片数过多，请简化道路路线。');
    }
    return pieces.flatMap(piece => piece.slice(2).map((p, i) => [piece[0], piece[i + 1], p]));
}
function cleanPolygon(points) {
    const clean = points.filter((p, i) => i === 0 || Math.hypot(...Object.values(sub(p, points[i - 1]))) > EPS);
    if (clean.length > 1 && Math.hypot(...Object.values(sub(clean[0], clean.at(-1)))) <= EPS)
        clean.pop();
    return clean.length >= 3 && area3(clean) > 1e-11 ? clean : [];
}
/** Inclusive inside, complementary outside: coplanar pieces never duplicate. */
export function splitTunnelPlane(points, plane) {
    const values = points.map(p => dot(plane.normal, p) + plane.constant), inside = [], outside = [];
    if (values.every(v => v >= -EPS))
        return { inside: points, outside: [] };
    if (values.every(v => v <= EPS) && values.some(v => v < -EPS))
        return { inside: [], outside: points };
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length], da = values[i], db = values[(i + 1) % points.length];
        if (da >= 0)
            inside.push(a);
        if (da <= 0)
            outside.push(a);
        if (da * db < 0) {
            const p = lerp3(a, b, da / (da - db));
            inside.push(p);
            outside.push(p);
        }
    }
    return { inside: cleanPolygon(inside), outside: cleanPolygon(outside) };
}
export function subtractConvexPlanes(points, planes) {
    let remaining = points;
    const output = [];
    for (const plane of planes) {
        if (!remaining.length)
            break;
        const split = splitTunnelPlane(remaining, plane);
        if (split.outside.length)
            output.push(split.outside);
        remaining = split.inside;
    }
    return output;
}
//# sourceMappingURL=road-tunnel.js.map