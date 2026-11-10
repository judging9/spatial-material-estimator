import { createMunicipalElement, municipalEffectiveWidth, municipalJunctionArms, municipalScale, rawMunicipalFootprints, validateMunicipalElements } from './municipal-design.js';
import { roadElevationAtPlanPoint } from './road-profile.js';
const EPS = 1e-8;
const roadKinds = ['road', 'bridge', 'intersection', 'roundabout'];
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (a, b) => {
    const length = distance(a, b);
    return length > EPS ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null;
};
const isPoint = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y);
function elevationAt(project, element, point) {
    return element.kind === 'road' && element.roadProfile?.enabled
        ? roadElevationAtPlanPoint(project, element, point) * 100 : element.elevation;
}
function sourcePort(project, element, suffix, position, point, direction) {
    return {
        id: `${element.id}:connection:${suffix}`, targetId: element.id, targetName: element.name,
        kind: ['intersection', 'roundabout'].includes(element.kind) ? 'junction' : element.kind === 'bridge' ? 'bridge' : 'road',
        sourceKind: element.kind, position, point: { x: point.x, y: point.y }, direction: { ...direction },
        widthCm: municipalEffectiveWidth(element), elevation: elevationAt(project, element, point),
        ...(element.roadLayout ? { roadLayout: structuredClone(element.roadLayout) } : {}),
    };
}
/** End-cap centres follow actual approach axes, including rotated eight-arm
 * junctions and the larger outer radius of roundabout approach roads. */
export function municipalConnectionPorts(project) {
    if (!municipalScale(project))
        return [];
    const result = [];
    for (const element of project.municipalElements ?? []) {
        if (element.hidden || !roadKinds.includes(element.kind))
            continue;
        if (element.kind === 'intersection' || element.kind === 'roundabout') {
            for (const [index, arm] of municipalJunctionArms(element, project).entries()) {
                const direction = unit(element.points[0], arm.end);
                if (direction)
                    result.push(sourcePort(project, element, `arm:${index}`, 'arm', arm.end, direction));
            }
        }
        else {
            const points = element.points, first = points[0], last = points[points.length - 1];
            if (points.length < 2)
                continue;
            const start = unit(points[1], first), end = unit(points[points.length - 2], last);
            if (start)
                result.push(sourcePort(project, element, 'start', 'start', first, start));
            if (end)
                result.push(sourcePort(project, element, 'end', 'end', last, end));
        }
    }
    return result;
}
function projectToSegment(point, a, b) {
    const vector = subtract(b, a), squared = dot(vector, vector);
    if (squared <= EPS * EPS)
        return null;
    const t = Math.max(0, Math.min(1, dot(subtract(point, a), vector) / squared));
    return { point: { x: a.x + vector.x * t, y: a.y + vector.y * t }, t };
}
function towardReference(direction, reference, point) {
    return reference && dot(subtract(point, reference), direction) < 0 ? { x: -direction.x, y: -direction.y } : direction;
}
/** A source's elevation is inherited only at a new route's first point. Once
 * supplied, it prevents a flat road from snapping onto an elevated bridge. */
export function snapMunicipalConnection(project, kind, point, options) {
    if (!isPoint(point) || !options || !Number.isFinite(options.tolerance) || options.tolerance < 0)
        throw new RangeError('设施吸附需要有效坐标和非负距离。');
    if (options.reference !== undefined && !isPoint(options.reference))
        throw new RangeError('设施参考点应为有效坐标。');
    if (options.elevation !== undefined && !Number.isFinite(options.elevation))
        throw new RangeError('设施吸附标高应为有限数字。');
    const scale = municipalScale(project);
    if (!scale || !['road', 'bridge', 'kerb'].includes(kind))
        return null;
    const exclude = options.excludeId ?? options.excludedId;
    const sourceElevation = options.elevation ?? point.z;
    const compatible = (port) => port.targetId !== exclude && Number.isFinite(port.elevation)
        && (sourceElevation === undefined || Math.abs(port.elevation - sourceElevation) <= 1);
    const choose = (candidates, type) => {
        const sorted = candidates.filter(compatible).map(port => ({ port, distance: distance(point, port.point) }))
            .filter(candidate => candidate.distance <= options.tolerance + EPS)
            .sort((a, b) => a.distance - b.distance || a.port.id.localeCompare(b.port.id));
        const nearest = sorted[0];
        return nearest ? { point: { ...nearest.port.point }, ...nearest, kind: type, elevation: nearest.port.elevation } : null;
    };
    if (kind !== 'kerb') {
        const cap = choose(municipalConnectionPorts(project), 'port');
        if (cap)
            return cap;
        const projected = [];
        for (const element of project.municipalElements ?? []) {
            if (element.hidden || element.id === exclude || !['road', 'bridge'].includes(element.kind))
                continue;
            for (let index = 1; index < element.points.length; index++) {
                const a = element.points[index - 1], b = element.points[index], projection = projectToSegment(point, a, b), direction = unit(a, b);
                if (projection && direction)
                    projected.push(sourcePort(project, element, `segment:${index}`, 'segment', projection.point, towardReference(direction, options.reference, projection.point)));
            }
        }
        return choose(projected, 'port');
    }
    const kerbWidth = options.widthCm ?? 15;
    if (!Number.isFinite(kerbWidth) || kerbWidth < .1 || kerbWidth > 100000)
        throw new RangeError('路缘石宽度应为 0.1–100000 cm。');
    const offset = kerbWidth * .005 / scale, edges = [];
    for (const element of project.municipalElements ?? []) {
        if (element.hidden || element.id === exclude || !roadKinds.includes(element.kind))
            continue;
        for (const [partIndex, part] of (rawMunicipalFootprints(element, project) ?? []).entries()) {
            // Approach road edges and retained roundabout islands are genuine kerb
            // boundaries. Outer rings offset outwards; hole rings offset into holes.
            for (const [ringIndex, ring] of [part.points, ...part.holes].entries()) {
                const signed = ring.reduce((sum, p, index) => { const q = ring[(index + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
                const orientation = (signed >= 0 ? 1 : -1) * (ringIndex ? -1 : 1);
                for (let index = 0; index < ring.length; index++) {
                    const a = ring[index], b = ring[(index + 1) % ring.length], direction = unit(a, b);
                    if (!direction)
                        continue;
                    const outward = { x: direction.y * orientation, y: -direction.x * orientation };
                    const shifted = (p) => ({ x: p.x + outward.x * offset, y: p.y + outward.y * offset });
                    const projection = projectToSegment(point, shifted(a), shifted(b));
                    if (!projection)
                        continue;
                    const port = sourcePort(project, element, `edge:${partIndex}:${ringIndex}:${index}`, 'edge', projection.point, towardReference(direction, options.reference, projection.point));
                    port.kind = 'edge';
                    edges.push(port);
                }
            }
        }
    }
    return choose(edges, 'edge');
}
function offsetPath(points, offset) {
    const directions = points.slice(1).map((p, index) => unit(points[index], p));
    if (directions.some(direction => !direction))
        throw new RangeError('道路相邻节点不能重合。');
    const shifted = (p, direction) => ({ x: p.x - direction.y * offset, y: p.y + direction.x * offset });
    const result = [shifted(points[0], directions[0])];
    for (let index = 1; index < points.length - 1; index++) {
        const p = points[index], before = directions[index - 1], after = directions[index], a = shifted(p, before), b = shifted(p, after), turn = cross(before, after);
        if (Math.abs(turn) < EPS) {
            if (dot(before, after) < 0)
                throw new RangeError('道路不能原路折返。');
            result.push(a);
            continue;
        }
        const t = cross(subtract(b, a), after) / turn, intersection = { x: a.x + before.x * t, y: a.y + before.y * t };
        if (distance(p, intersection) <= Math.abs(offset) * 4 + EPS)
            result.push(intersection);
        else
            result.push(a, b);
    }
    result.push(shifted(points[points.length - 1], directions[directions.length - 1]));
    return result.filter((point, index) => !index || distance(point, result[index - 1]) > EPS);
}
function uncoveredSegments(points, existing, widthCm, elevation, scale) {
    const paths = [], tolerance = .001 / scale;
    for (let index = 1; index < points.length; index++) {
        const a = points[index - 1], b = points[index], direction = unit(a, b), length = distance(a, b);
        if (!direction)
            continue;
        const covered = [];
        for (const kerb of existing) {
            if (Math.abs(kerb.width - widthCm) > .01 || Math.abs(kerb.elevation - elevation) > .01)
                continue;
            for (let edge = 1; edge < kerb.points.length; edge++) {
                const c = kerb.points[edge - 1], d = kerb.points[edge];
                if (Math.abs(cross(direction, subtract(c, a))) > tolerance || Math.abs(cross(direction, subtract(d, a))) > tolerance)
                    continue;
                const from = dot(subtract(c, a), direction), to = dot(subtract(d, a), direction), start = Math.max(0, Math.min(from, to)), end = Math.min(length, Math.max(from, to));
                if (end - start > EPS)
                    covered.push([start, end]);
            }
        }
        covered.sort((left, right) => left[0] - right[0]);
        let cursor = 0;
        const append = (start, end) => {
            if (end - start <= tolerance)
                return;
            const from = { x: a.x + direction.x * start, y: a.y + direction.y * start }, to = { x: a.x + direction.x * end, y: a.y + direction.y * end }, prior = paths[paths.length - 1];
            if (prior && distance(prior[prior.length - 1], from) <= EPS)
                prior.push(to);
            else
                paths.push([from, to]);
        };
        for (const [start, end] of covered) {
            if (start > cursor)
                append(cursor, start);
            cursor = Math.max(cursor, end);
        }
        if (cursor < length)
            append(cursor, length);
    }
    return paths;
}
/** Generates real, separately priced kerbs; existing equal-width physical
 * segments are subtracted before new objects are returned. No project is
 * mutated, and a caller can add the result as one undoable operation. */
export function createRoadsideKerbs(project, road, options = { side: 'both' }) {
    if (road.kind === 'intersection' || road.kind === 'roundabout')
        return createJunctionKerbs(project, road, options);
    if (!['road', 'bridge'].includes(road.kind))
        throw new RangeError('沿道路生成路缘石需要先选择道路或桥梁。');
    if (!options || !['both', 'left', 'right'].includes(options.side))
        throw new RangeError('路缘石侧别应为左侧、右侧或双侧。');
    const scale = municipalScale(project);
    if (!scale)
        throw new RangeError('请先校准图纸，再沿道路生成路缘石。');
    validateMunicipalElements([road], project);
    const width = options.width ?? 15, height = options.height ?? 20, depth = options.depth ?? 30;
    for (const value of [width, height, depth])
        if (!Number.isFinite(value) || value < .1 || value > 100000)
            throw new RangeError('路缘石尺寸应为 0.1–100000 cm。');
    const offset = (municipalEffectiveWidth(road) + width) * .005 / scale;
    const sideSpecs = options.side === 'both' ? [['left', 1], ['right', -1]] : [[options.side, options.side === 'left' ? 1 : -1]];
    const result = [], existing = (project.municipalElements ?? []).filter(element => element.kind === 'kerb');
    for (const [side, sign] of sideSpecs) {
        const path = offsetPath(road.points, offset * sign), elevations = path.map(point => elevationAt(project, road, point));
        if (elevations.some(value => !Number.isFinite(value) || Math.abs(value - elevations[0]) > .01))
            throw new RangeError('该道路沿侧边标高变化，当前路缘石采用统一标高；请分段设置标高后再生成。');
        for (const [index, points] of uncoveredSegments(path, [...existing, ...result], width, elevations[0], scale).entries()) {
            result.push(createMunicipalElement('kerb', points, project, {
                name: `${road.name.slice(0, 96)} · ${side === 'left' ? '左侧' : '右侧'}路缘石${index ? ` ${index + 1}` : ''}`,
                width, height, depth, elevation: elevations[0],
                unitPrice: options.unitPrice ?? '', laborRate: options.laborRate ?? '0', wasteRate: options.wasteRate ?? '0', additionalCost: options.additionalCost ?? '0',
            }));
        }
    }
    return result;
}
/** Junction approach end caps are openings for connected roads, never kerb
 * segments. The remaining actual outline includes rotated and eight-arm
 * concave corners. Ring islands are returned as two open priced paths. */
export function createJunctionKerbs(project, junction, options = { side: 'both' }) {
    if (!['intersection', 'roundabout'].includes(junction.kind))
        throw new RangeError('路口道缘需要先选择交叉路口或环岛。');
    if (!options || !['both', 'left', 'right'].includes(options.side) || options.boundary !== undefined && !['outer', 'island', 'both'].includes(options.boundary))
        throw new RangeError('路口道缘边界选项不正确。');
    const scale = municipalScale(project);
    if (!scale)
        throw new RangeError('请先校准图纸，再生成路口路缘石。');
    validateMunicipalElements([junction], project);
    const width = options.width ?? 15, height = options.height ?? 20, depth = options.depth ?? 30;
    for (const value of [width, height, depth])
        if (!Number.isFinite(value) || value < .1 || value > 100000)
            throw new RangeError('路缘石尺寸应为 0.1–100000 cm。');
    const ports = municipalConnectionPorts({ ...project, municipalElements: [junction] }), physicalTolerance = .001 / scale;
    const existing = (project.municipalElements ?? []).filter(element => element.kind === 'kerb'), result = [];
    const boundary = options.boundary ?? 'outer';
    for (const part of rawMunicipalFootprints(junction, project) ?? []) {
        for (const [ringIndex, ring] of [part.points, ...part.holes].entries()) {
            if (ringIndex === 0 && boundary === 'island' || ringIndex > 0 && boundary === 'outer')
                continue;
            const cap = (a, b) => !ringIndex && ports.some(port => Math.abs(dot(subtract(a, port.point), port.direction)) < physicalTolerance
                && Math.abs(dot(subtract(b, port.point), port.direction)) < physicalTolerance
                && distance({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, port.point) < physicalTolerance);
            const caps = ring.map((a, index) => cap(a, ring[(index + 1) % ring.length])), firstCap = caps.indexOf(true), chains = [];
            if (firstCap >= 0) {
                let chain = [];
                for (let step = 1; step <= ring.length; step++) {
                    const index = (firstCap + step) % ring.length, a = ring[index], b = ring[(index + 1) % ring.length];
                    if (caps[index]) {
                        if (chain.length >= 2)
                            chains.push(chain);
                        chain = [];
                    }
                    else {
                        if (!chain.length)
                            chain.push(a);
                        chain.push(b);
                    }
                }
                if (chain.length >= 2)
                    chains.push(chain);
            }
            const signed = ring.reduce((sum, p, index) => { const q = ring[(index + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
            const offset = -(signed >= 0 ? 1 : -1) * (ringIndex ? -1 : 1) * width * .005 / scale;
            let shifted;
            if (firstCap < 0) {
                const closed = offsetPath([ring[ring.length - 1], ...ring, ring[0]], offset).slice(1, -1), middle = Math.floor(closed.length / 2);
                shifted = [closed.slice(0, middle + 1), [...closed.slice(middle), closed[0]]];
            }
            else
                shifted = chains.map(chain => offsetPath(chain, offset));
            for (const chain of shifted)
                for (const points of uncoveredSegments(chain, [...existing, ...result], width, junction.elevation, scale)) {
                    result.push(createMunicipalElement('kerb', points, project, {
                        name: `${junction.name.slice(0, 95)} · ${ringIndex ? '中心岛' : '外围'}路缘石 ${result.length + 1}`,
                        width, height, depth, elevation: junction.elevation,
                        unitPrice: options.unitPrice ?? '', laborRate: options.laborRate ?? '0', wasteRate: options.wasteRate ?? '0', additionalCost: options.additionalCost ?? '0',
                    }));
                }
        }
    }
    return result;
}
//# sourceMappingURL=municipal-connections.js.map