/**
 * Pure geometry for diagram regions. Coordinates always remain in original
 * image pixels; canvas scale/pan never enters any area or length calculation.
 *
 * Polygon intersection uses ear-clipping triangulation and convex triangle
 * clipping. Holes are accounted for by inclusion/exclusion of polygon areas.
 * All predicates use a tolerance derived from geometry extent and floating
 * point resolution; touching boundaries have zero overlap area.
 */
const MACHINE_EPSILON = Number.EPSILON;
function isPoint(point) {
    return point !== null && typeof point === "object"
        && Number.isFinite(point.x) && Number.isFinite(point.y);
}
function requirePoints(points) {
    if (!Array.isArray(points) || !points.every(isPoint)) {
        throw new TypeError("顶点坐标必须是有限数字");
    }
}
function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}
function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function bounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let magnitude = 0;
    for (const { x, y } of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y));
    }
    return { minX, minY, maxX, maxY, magnitude };
}
function tolerance(points) {
    const box = bounds(points);
    const extent = points.length ? Math.hypot(box.maxX - box.minX, box.maxY - box.minY) : 0;
    const length = Math.max(1e-9, extent * 1e-12, box.magnitude * MACHINE_EPSILON * 8);
    return { length, area: Math.max(1e-14, extent * length * 4), extent };
}
function orientation(a, b, c, epsilon) {
    const value = cross(a, b, c);
    const threshold = epsilon * (distance(a, b) + distance(a, c) + epsilon);
    return value > threshold ? 1 : value < -threshold ? -1 : 0;
}
function pointOnSegment(point, a, b, epsilon) {
    return orientation(a, b, point, epsilon) === 0
        && point.x >= Math.min(a.x, b.x) - epsilon
        && point.x <= Math.max(a.x, b.x) + epsilon
        && point.y >= Math.min(a.y, b.y) - epsilon
        && point.y <= Math.max(a.y, b.y) + epsilon;
}
function segmentsMeet(a, b, c, d, epsilon) {
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - epsilon
        || Math.max(c.x, d.x) < Math.min(a.x, b.x) - epsilon
        || Math.max(a.y, b.y) < Math.min(c.y, d.y) - epsilon
        || Math.max(c.y, d.y) < Math.min(a.y, b.y) - epsilon)
        return false;
    const abc = orientation(a, b, c, epsilon);
    const abd = orientation(a, b, d, epsilon);
    const cda = orientation(c, d, a, epsilon);
    const cdb = orientation(c, d, b, epsilon);
    if (abc * abd < 0 && cda * cdb < 0)
        return true;
    return (abc === 0 && pointOnSegment(c, a, b, epsilon))
        || (abd === 0 && pointOnSegment(d, a, b, epsilon))
        || (cda === 0 && pointOnSegment(a, c, d, epsilon))
        || (cdb === 0 && pointOnSegment(b, c, d, epsilon));
}
function boundariesMeet(pointsA, pointsB, epsilon) {
    for (let a = 0; a < pointsA.length; a += 1) {
        for (let b = 0; b < pointsB.length; b += 1) {
            if (segmentsMeet(pointsA[a], pointsA[(a + 1) % pointsA.length], pointsB[b], pointsB[(b + 1) % pointsB.length], epsilon))
                return true;
        }
    }
    return false;
}
function signedPolygonArea(points) {
    if (points.length < 3)
        return 0;
    // Translate to a local origin to avoid cancellation for large image offsets.
    const origin = points[0];
    let sum = 0;
    let compensation = 0;
    for (let index = 1; index < points.length - 1; index += 1) {
        const term = cross(origin, points[index], points[index + 1]);
        const corrected = term - compensation;
        const next = sum + corrected;
        compensation = (next - sum) - corrected;
        sum = next;
    }
    return sum / 2;
}
/** Unsigned shoelace area in original-image pixels squared. */
export function polygonArea(points) {
    requirePoints(points);
    return Math.abs(signedPolygonArea(points));
}
/** Closed boundary length in original-image pixels. */
export function polygonPerimeter(points) {
    requirePoints(points);
    if (points.length < 2)
        return 0;
    let perimeter = 0;
    for (let index = 0; index < points.length; index += 1) {
        perimeter += distance(points[index], points[(index + 1) % points.length]);
    }
    return perimeter;
}
function invalid(error, code) {
    return { valid: false, error, code };
}
/** Validate a simple, nondegenerate polygon. Do not repeat its closing vertex. */
export function validatePolygon(points) {
    if (!Array.isArray(points) || !points.every(isPoint)) {
        return invalid("顶点坐标必须是有限数字", "invalid_coordinate");
    }
    if (points.length < 3)
        return invalid("至少需要三个顶点", "too_few_points");
    const { length: epsilon, area: areaEpsilon } = tolerance(points);
    for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
            if (distance(points[a], points[b]) <= epsilon) {
                return invalid("顶点重复或距离过近；闭合时无需重复首个顶点", "duplicate_point");
            }
        }
        const previous = points[(a + points.length - 1) % points.length];
        const current = points[a];
        const next = points[(a + 1) % points.length];
        const dot = (current.x - previous.x) * (next.x - current.x)
            + (current.y - previous.y) * (next.y - current.y);
        if (orientation(previous, current, next, epsilon) === 0 && dot < 0) {
            return invalid("相邻边发生折返或重叠", "degenerate_edge");
        }
    }
    for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
            if (b === a + 1 || (a === 0 && b === points.length - 1))
                continue;
            if (segmentsMeet(points[a], points[(a + 1) % points.length], points[b], points[(b + 1) % points.length], epsilon)) {
                return invalid("轮廓存在自交或非相邻边相接", "self_intersection");
            }
        }
    }
    if (polygonArea(points) <= areaEpsilon) {
        return invalid("轮廓面积为零或过小，请调整顶点", "degenerate_area");
    }
    return { valid: true, error: null };
}
// 1 = strict interior, 0 = boundary, -1 = exterior.
function pointLocation(point, polygon, epsilon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const a = polygon[previous];
        const b = polygon[index];
        if (pointOnSegment(point, a, b, epsilon))
            return 0;
        if ((a.y > point.y) !== (b.y > point.y)) {
            const crossingX = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y);
            if (point.x < crossingX)
                inside = !inside;
        }
    }
    return inside ? 1 : -1;
}
/** Outer boundary is selectable; hole interiors and boundaries are excluded. */
export function pointInRegion(point, region) {
    if (Array.isArray(region?.surfaceParts))
        return region.surfaceParts.some(part => pointInRegion(point, part));
    if (!isPoint(point) || !region || !Array.isArray(region.points)
        || region.points.length < 3 || !region.points.every(isPoint))
        return false;
    const holes = region.holes ?? [];
    if (!Array.isArray(holes) || holes.some(hole => !Array.isArray(hole) || !hole.every(isPoint)))
        return false;
    const epsilon = tolerance(region.points.concat(...holes)).length;
    if (pointLocation(point, region.points, epsilon) < 0)
        return false;
    return !holes.some(hole => hole.length >= 3 && pointLocation(point, hole, epsilon) >= 0);
}
function validateRegionShape(region, allowBoundaryContact = false) {
    if (!region || typeof region !== "object")
        return invalid("区域数据格式不正确", "invalid_region");
    if (region.surfaceParts !== undefined) {
        if (!Array.isArray(region.surfaceParts) || !region.surfaceParts.length || region.surfaceParts.length > 1000)
            return invalid("楼板有效轮廓数据格式不正确", "invalid_surface_parts");
        for (let index = 0; index < region.surfaceParts.length; index += 1) {
            const part = region.surfaceParts[index];
            if (part?.surfaceParts !== undefined)
                return invalid("楼板有效轮廓不能递归包含片段", "invalid_surface_parts");
            const result = validateRegionShape(part, true);
            if (!result.valid)
                return result;
            for (let previous = 0; previous < index; previous += 1) {
                if (shapeIntersectionArea(part, region.surfaceParts[previous]) > 0)
                    return invalid("楼板有效片段不能重复计量", "surface_parts_overlap");
            }
        }
        return { valid: true, error: null };
    }
    const polygonResult = validatePolygon(region.points);
    if (!polygonResult.valid)
        return polygonResult;
    const holes = region.holes ?? [];
    if (!Array.isArray(holes))
        return invalid("孔洞数据格式不正确", "invalid_holes");
    for (let index = 0; index < holes.length; index += 1) {
        const hole = holes[index];
        const result = validatePolygon(hole);
        if (!result.valid)
            return invalid(`孔洞 ${index + 1}：${result.error}`, result.code);
        const epsilon = tolerance(region.points.concat(...holes.slice(0, index + 1))).length;
        if ((!allowBoundaryContact && boundariesMeet(region.points, hole, epsilon))
            || hole.some(point => pointLocation(point, region.points, epsilon) < (allowBoundaryContact ? 0 : 1))
            || allowBoundaryContact && Math.abs(polygonIntersectionArea(region.points, hole) - polygonArea(hole)) > tolerance(region.points.concat(hole)).area) {
            return invalid(`孔洞 ${index + 1} 必须严格位于区域内部，不能触碰外边界`, "hole_outside");
        }
        for (let previous = 0; previous < index; previous += 1) {
            const other = holes[previous];
            if ((!allowBoundaryContact && boundariesMeet(hole, other, epsilon))
                || pointLocation(hole[0], other, epsilon) > (allowBoundaryContact ? 0 : -1)
                || pointLocation(other[0], hole, epsilon) > (allowBoundaryContact ? 0 : -1)
                || allowBoundaryContact && polygonIntersectionArea(hole, other) > 0) {
                return invalid("孔洞不能相交、相切或互相包含", "holes_intersect");
            }
        }
    }
    return { valid: true, error: null };
}
function simplifyCollinear(points, epsilon) {
    const simplified = points.map(point => ({ x: point.x, y: point.y }));
    let changed = true;
    while (changed && simplified.length > 3) {
        changed = false;
        for (let index = 0; index < simplified.length; index += 1) {
            const previous = simplified[(index + simplified.length - 1) % simplified.length];
            const current = simplified[index];
            const next = simplified[(index + 1) % simplified.length];
            if (pointOnSegment(current, previous, next, epsilon)) {
                simplified.splice(index, 1);
                changed = true;
                break;
            }
        }
    }
    return simplified;
}
function insideTriangle(point, a, b, c, epsilon) {
    return orientation(a, b, point, epsilon) >= 0
        && orientation(b, c, point, epsilon) >= 0
        && orientation(c, a, point, epsilon) >= 0;
}
function triangulate(points, epsilon) {
    const vertices = simplifyCollinear(points, epsilon);
    if (signedPolygonArea(vertices) < 0)
        vertices.reverse();
    const triangles = [];
    while (vertices.length > 3) {
        let clipped = false;
        for (let index = 0; index < vertices.length; index += 1) {
            const previousIndex = (index + vertices.length - 1) % vertices.length;
            const nextIndex = (index + 1) % vertices.length;
            const a = vertices[previousIndex];
            const b = vertices[index];
            const c = vertices[nextIndex];
            if (orientation(a, b, c, epsilon) <= 0)
                continue;
            let blocked = false;
            for (let candidate = 0; candidate < vertices.length; candidate += 1) {
                if (candidate === previousIndex || candidate === index || candidate === nextIndex)
                    continue;
                if (insideTriangle(vertices[candidate], a, b, c, epsilon)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            triangles.push([a, b, c]);
            vertices.splice(index, 1);
            clipped = true;
            break;
        }
        if (!clipped)
            throw new RangeError("无法计算该轮廓的交集，请移除距离过近或近乎共线的顶点");
    }
    if (vertices.length === 3)
        triangles.push(vertices);
    return triangles;
}
function lineDistance(a, b, point, epsilon) {
    const value = cross(a, b, point);
    return Math.abs(value) <= epsilon * distance(a, b) ? 0 : value;
}
function clipTriangle(subject, clip, epsilon) {
    let output = subject;
    for (let edge = 0; edge < clip.length && output.length > 0; edge += 1) {
        const a = clip[edge];
        const b = clip[(edge + 1) % clip.length];
        const input = output;
        output = [];
        let previous = input[input.length - 1];
        let previousDistance = lineDistance(a, b, previous, epsilon);
        for (const current of input) {
            const currentDistance = lineDistance(a, b, current, epsilon);
            const previousInside = previousDistance >= 0;
            const currentInside = currentDistance >= 0;
            if (previousInside !== currentInside) {
                const denominator = previousDistance - currentDistance;
                const parameter = denominator === 0 ? 0 : previousDistance / denominator;
                output.push({
                    x: previous.x + parameter * (current.x - previous.x),
                    y: previous.y + parameter * (current.y - previous.y),
                });
            }
            if (currentInside)
                output.push(current);
            previous = current;
            previousDistance = currentDistance;
        }
    }
    return output;
}
function boxesSeparate(boxA, boxB, epsilon) {
    return boxA.maxX < boxB.minX - epsilon || boxB.maxX < boxA.minX - epsilon
        || boxA.maxY < boxB.minY - epsilon || boxB.maxY < boxA.minY - epsilon;
}
function triangulatedIntersection(trianglesA, trianglesB, epsilon) {
    const preparedB = trianglesB.map(triangle => ({ triangle, box: bounds(triangle) }));
    let area = 0;
    for (const triangleA of trianglesA) {
        const boxA = bounds(triangleA);
        for (const { triangle: triangleB, box: boxB } of preparedB) {
            if (boxesSeparate(boxA, boxB, epsilon))
                continue;
            area += Math.abs(signedPolygonArea(clipTriangle(triangleA, triangleB, epsilon)));
        }
    }
    return area;
}
/** Exact polygon intersection via triangular partitions, in pixel². */
export function polygonIntersectionArea(pointsA, pointsB) {
    const first = validatePolygon(pointsA);
    const second = validatePolygon(pointsB);
    if (!first.valid || !second.valid)
        throw new RangeError((!first.valid ? first : second).error);
    const { length: epsilon, area: areaEpsilon } = tolerance(pointsA.concat(pointsB));
    if (boxesSeparate(bounds(pointsA), bounds(pointsB), epsilon))
        return 0;
    const area = triangulatedIntersection(triangulate(pointsA, epsilon), triangulate(pointsB, epsilon), epsilon);
    return area <= areaEpsilon ? 0 : area;
}
function preparedRegion(region, epsilon) {
    return {
        outer: triangulate(region.points, epsilon),
        holes: (region.holes ?? []).map(hole => triangulate(hole, epsilon)),
    };
}
function shapeIntersectionArea(regionA, regionB) {
    if (Array.isArray(regionA.surfaceParts) || Array.isArray(regionB.surfaceParts))
        return (regionA.surfaceParts ?? [regionA]).reduce((sum, first) => sum + (regionB.surfaceParts ?? [regionB]).reduce((area, second) => area + shapeIntersectionArea(first, second), 0), 0);
    const combined = regionA.points.concat(regionB.points, ...(regionA.holes ?? []), ...(regionB.holes ?? []));
    const { length: epsilon, area: areaEpsilon } = tolerance(combined);
    if (boxesSeparate(bounds(regionA.points), bounds(regionB.points), epsilon))
        return 0;
    const first = preparedRegion(regionA, epsilon);
    const second = preparedRegion(regionB, epsilon);
    let area = triangulatedIntersection(first.outer, second.outer, epsilon);
    for (const hole of first.holes)
        area -= triangulatedIntersection(hole, second.outer, epsilon);
    for (const hole of second.holes)
        area -= triangulatedIntersection(first.outer, hole, epsilon);
    for (const holeA of first.holes) {
        for (const holeB of second.holes)
            area += triangulatedIntersection(holeA, holeB, epsilon);
    }
    return area <= areaEpsilon ? 0 : area;
}
/** Net region intersection, excluding holes of both regions, in pixel². */
export function intersectionArea(regionA, regionB) {
    const first = validateRegionShape(regionA);
    const second = validateRegionShape(regionB);
    if (!first.valid || !second.valid)
        throw new RangeError((!first.valid ? first : second).error);
    return shapeIntersectionArea(regionA, regionB);
}
/** Validate holes and reject positive net-area overlap; shared edges are legal. */
export function validateRegion(region, others = []) {
    const shapeResult = validateRegionShape(region);
    if (!shapeResult.valid)
        return shapeResult;
    if (!Array.isArray(others))
        return invalid("其他区域数据格式不正确", "invalid_regions");
    for (const other of others) {
        if (other === region || (region.id !== undefined && region.id !== null && other?.id === region.id))
            continue;
        const otherResult = validateRegionShape(other);
        if (!otherResult.valid) {
            return invalid(`已有区域「${other?.name ?? "未命名"}」几何无效：${otherResult.error}`, "invalid_other_region");
        }
        try {
            if (shapeIntersectionArea(region, other) > 0) {
                return invalid(`区域与「${other.name || "未命名区域"}」重叠，请调整边界`, "regions_overlap");
            }
        }
        catch (error) {
            return invalid(error.message || "区域交集计算失败", "intersection_failed");
        }
    }
    return { valid: true, error: null };
}
/** Calibrated physical metrics. Boundary length includes all hole boundaries. */
export function regionMetrics(region, calibration) {
    const scale = calibration?.metersPerPixel;
    if (!Number.isFinite(scale) || scale <= 0) {
        return { netArea: null, perimeter: null, grossArea: null, holesArea: null };
    }
    if (Array.isArray(region.surfaceParts)) {
        const parts = region.surfaceParts.map(part => regionMetrics(part, calibration));
        const grossArea = polygonArea(region.points) * scale * scale;
        const netArea = parts.reduce((sum, part) => sum + part.netArea, 0);
        return { netArea, perimeter: parts.reduce((sum, part) => sum + part.perimeter, 0), grossArea, holesArea: Math.max(0, grossArea - netArea) };
    }
    const grossPixels = polygonArea(region.points);
    const holes = region.holes ?? [];
    const holePixels = holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
    const perimeterPixels = polygonPerimeter(region.points)
        + holes.reduce((sum, hole) => sum + polygonPerimeter(hole), 0);
    return {
        netArea: (grossPixels - holePixels) * scale * scale,
        perimeter: perimeterPixels * scale,
        grossArea: grossPixels * scale * scale,
        holesArea: holePixels * scale * scale,
    };
}
function polygonCentroid(points) {
    const origin = points[0];
    let twiceArea = 0;
    let x = 0;
    let y = 0;
    for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const weight = cross(origin, a, b);
        twiceArea += weight;
        x += (a.x - origin.x + b.x - origin.x) * weight;
        y += (a.y - origin.y + b.y - origin.y) * weight;
    }
    return { x: origin.x + x / (3 * twiceArea), y: origin.y + y / (3 * twiceArea) };
}
function scanlineIntervals(points, y, epsilon) {
    const crossings = [];
    for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        if ((a.y > y) !== (b.y > y)) {
            crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
        }
    }
    crossings.sort((a, b) => a - b);
    const intervals = [];
    for (let index = 0; index + 1 < crossings.length; index += 2) {
        if (crossings[index + 1] - crossings[index] > epsilon) {
            intervals.push([crossings[index], crossings[index + 1]]);
        }
    }
    return intervals;
}
function subtractIntervals(intervals, cuts, epsilon) {
    let result = intervals;
    for (const [cutStart, cutEnd] of cuts) {
        const remainder = [];
        for (const [start, end] of result) {
            if (cutEnd <= start || cutStart >= end) {
                remainder.push([start, end]);
                continue;
            }
            if (cutStart - start > epsilon)
                remainder.push([start, cutStart]);
            if (end - cutEnd > epsilon)
                remainder.push([cutEnd, end]);
        }
        result = remainder;
    }
    return result;
}
function distanceToBoundary(point, contours) {
    let minimum = Infinity;
    for (const contour of contours) {
        for (let index = 0; index < contour.length; index += 1) {
            const a = contour[index];
            const b = contour[(index + 1) % contour.length];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const squaredLength = dx * dx + dy * dy;
            const parameter = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squaredLength));
            minimum = Math.min(minimum, Math.hypot(point.x - (a.x + parameter * dx), point.y - (a.y + parameter * dy)));
        }
    }
    return minimum;
}
/**
 * Find an interior label anchor, including for concave outlines and holes.
 * Scan halfway between vertex Y-levels, subtract hole intervals, then choose
 * an interval midpoint with ample boundary clearance. No guessed centroid is
 * returned when it lies outside the net region. Invalid shapes return null.
 */
export function regionInteriorPoint(region) {
    if (Array.isArray(region?.surfaceParts)) {
        const parts = [...region.surfaceParts].sort((a, b) => (polygonArea(b.points) - (b.holes ?? []).reduce((sum, ring) => sum + polygonArea(ring), 0)) - (polygonArea(a.points) - (a.holes ?? []).reduce((sum, ring) => sum + polygonArea(ring), 0)));
        for (const part of parts) {
            // Boundary-touching voids are genuine apertures in derived floors.
            if (!validateRegionShape(part, true).valid)
                continue;
            const point = regionInteriorPointSimple(part);
            if (point)
                return point;
        }
        return null;
    }
    if (!validateRegionShape(region).valid)
        return null;
    return regionInteriorPointSimple(region);
}
function regionInteriorPointSimple(region) {
    const holes = region.holes ?? [];
    const contours = [region.points, ...holes];
    const allPoints = region.points.concat(...holes);
    const epsilon = tolerance(allPoints).length;
    const ys = [...new Set(allPoints.map(point => point.y))].sort((a, b) => a - b);
    let best = null;
    let bestClearance = 0;
    const consider = point => {
        if (!isPoint(point) || pointLocation(point, region.points, epsilon) !== 1
            || holes.some(hole => pointLocation(point, hole, epsilon) !== -1))
            return;
        const clearance = distanceToBoundary(point, contours);
        if (clearance > bestClearance + epsilon) {
            best = point;
            bestClearance = clearance;
        }
    };
    const centroid = polygonCentroid(region.points);
    consider(centroid);
    const scanYs = [];
    if (Number.isFinite(centroid.y))
        scanYs.push(centroid.y);
    for (let index = 0; index < ys.length - 1; index += 1) {
        if (ys[index + 1] - ys[index] > epsilon)
            scanYs.push((ys[index] + ys[index + 1]) / 2);
    }
    for (const y of scanYs) {
        let intervals = scanlineIntervals(region.points, y, epsilon);
        for (const hole of holes)
            intervals = subtractIntervals(intervals, scanlineIntervals(hole, y, epsilon), epsilon);
        for (const [start, end] of intervals)
            consider({ x: (start + end) / 2, y });
    }
    return best;
}
export const labelPosition = regionInteriorPoint;
/** Screen pixels = original image pixels × viewport.zoom + viewport.panX/Y. */
export function worldToScreen(point, viewport = {}) {
    const zoom = viewport.zoom ?? 1;
    const panX = viewport.panX ?? 0;
    const panY = viewport.panY ?? 0;
    if (!isPoint(point) || !Number.isFinite(zoom) || zoom <= 0
        || !Number.isFinite(panX) || !Number.isFinite(panY))
        throw new TypeError("缩放与坐标必须是有效数字");
    return { x: point.x * zoom + panX, y: point.y * zoom + panY };
}
export function screenToWorld(point, viewport = {}) {
    const zoom = viewport.zoom ?? 1;
    const panX = viewport.panX ?? 0;
    const panY = viewport.panY ?? 0;
    if (!isPoint(point) || !Number.isFinite(zoom) || zoom <= 0
        || !Number.isFinite(panX) || !Number.isFinite(panY))
        throw new TypeError("缩放与坐标必须是有效数字");
    return { x: (point.x - panX) / zoom, y: (point.y - panY) / zoom };
}
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map
//# sourceMappingURL=geometry.js.map