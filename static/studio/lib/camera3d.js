import { validatePolygon, regionInteriorPoint, regionMetrics } from './geometry.js';
export const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export function normalize3(a) {
    const length = Math.hypot(a.x, a.y, a.z);
    if (!Number.isFinite(length) || length === 0)
        throw new RangeError('Invalid direction.');
    return { x: a.x / length, y: a.y / length, z: a.z / length };
}
export function multiply4(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            for (let k = 0; k < 4; k++)
                out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}
export function perspective4(fovY, aspect, near, far) {
    if (!(fovY > 0 && fovY < Math.PI && aspect > 0 && near > 0 && far > near))
        throw new RangeError('Invalid perspective.');
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
export function lookAt4(eye, target, up = { x: 0, y: 1, z: 0 }) {
    const z = normalize3(sub3(eye, target)), x = normalize3(cross3(up, z)), y = cross3(z, x);
    return new Float32Array([x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1]);
}
export function inverse4(matrix) {
    const rows = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? matrix[c * 4 + r] : +(c - 4 === r)));
    for (let c = 0; c < 4; c++) {
        let pivot = c;
        for (let r = c + 1; r < 4; r++)
            if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c]))
                pivot = r;
        if (Math.abs(rows[pivot][c]) < 1e-14)
            throw new RangeError('Singular camera matrix.');
        [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
        const divisor = rows[c][c];
        for (let k = 0; k < 8; k++)
            rows[c][k] /= divisor;
        for (let r = 0; r < 4; r++)
            if (r !== c) {
                const f = rows[r][c];
                for (let k = 0; k < 8; k++)
                    rows[r][k] -= f * rows[c][k];
            }
    }
    return new Float64Array(Array.from({ length: 16 }, (_, i) => rows[i % 4][Math.floor(i / 4) + 4]));
}
export function transform4(m, v) {
    return Array.from({ length: 4 }, (_, r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
}
export function screenRay(x, y, width, height, viewProjection) {
    if (!(width > 0 && height > 0))
        throw new RangeError('Invalid viewport.');
    const inv = inverse4(viewProjection);
    const point = (depth) => { const p = transform4(inv, [x / width * 2 - 1, 1 - y / height * 2, depth, 1]); return { x: p[0] / p[3], y: p[1] / p[3], z: p[2] / p[3] }; };
    const origin = point(-1), far = point(1);
    return { origin, direction: normalize3(sub3(far, origin)) };
}
export function rayBox(origin, direction, center, size, rotationY = 0) {
    const c = Math.cos(rotationY), s = Math.sin(rotationY), relative = sub3(origin, center);
    const local = (v) => ({ x: c * v.x - s * v.z, y: v.y, z: s * v.x + c * v.z });
    const o = local(relative), d = local(direction);
    let near = -Infinity, far = Infinity;
    for (const axis of ['x', 'y', 'z']) {
        const half = size[axis] / 2;
        if (Math.abs(d[axis]) < 1e-12) {
            if (Math.abs(o[axis]) > half)
                return null;
            continue;
        }
        let a = (-half - o[axis]) / d[axis], b = (half - o[axis]) / d[axis];
        if (a > b)
            [a, b] = [b, a];
        near = Math.max(near, a);
        far = Math.min(far, b);
        if (near > far)
            return null;
    }
    return far >= 0 ? Math.max(0, near) : null;
}
export function rayTriangle(origin, direction, a, b, c) {
    const e1 = sub3(b, a), e2 = sub3(c, a), p = cross3(direction, e2), det = dot3(e1, p);
    if (Math.abs(det) < 1e-12)
        return null;
    const inv = 1 / det, t = sub3(origin, a), u = dot3(t, p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9)
        return null;
    const q = cross3(t, e1), v = dot3(direction, q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9)
        return null;
    const distance = dot3(e2, q) * inv;
    return distance >= 0 ? distance : null;
}
export function pointInRingXZ(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x)
            inside = !inside;
    }
    return inside;
}
/** Triangulate a planar 3D boundary by projecting along its dominant normal. */
export function triangulateSurface(points, normal) {
    const abs = { x: Math.abs(normal.x), y: Math.abs(normal.y), z: Math.abs(normal.z) };
    if (Math.max(abs.x, abs.y, abs.z) < 1e-10)
        throw new RangeError('Invalid surface normal.');
    const projected = points.map(p => abs.y >= abs.x && abs.y >= abs.z ? { x: p.x, y: 0, z: p.z } : abs.x >= abs.z ? { x: p.z, y: 0, z: p.y } : { x: p.x, y: 0, z: p.y });
    return triangulateXZ(projected);
}
/** Ray picking follows actual triangles, so a void never acts like a wall box. */
export function rayMesh(origin, direction, points, indices) {
    let nearest = Infinity;
    for (let i = 0; i < indices.length; i += 3) {
        const hit = rayTriangle(origin, direction, points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]);
        if (hit !== null && hit < nearest)
            nearest = hit;
    }
    return Number.isFinite(nearest) ? nearest : null;
}
/** Keep true creases and outer edges while hiding seams between coplanar patches. */
export function creaseSegments(surfaces) {
    const groups = new Map();
    const quantize = (value) => Math.round(value * 1e7) / 1e7;
    for (const surface of surfaces)
        for (let i = 0; i < surface.points.length; i++) {
            let a = surface.points[i], b = surface.points[(i + 1) % surface.points.length];
            if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-9)
                continue;
            let direction = normalize3(sub3(b, a));
            if ((Math.abs(direction.x) > 1e-8 ? direction.x : Math.abs(direction.y) > 1e-8 ? direction.y : direction.z) < 0) {
                [a, b] = [b, a];
                direction = normalize3(sub3(b, a));
            }
            const moment = cross3(direction, a), key = [direction.x, direction.y, direction.z, moment.x, moment.y, moment.z].map(quantize).join(',');
            let group = groups.get(key);
            if (!group) {
                group = { direction, origin: a, edges: [] };
                groups.set(key, group);
            }
            const start = dot3(sub3(a, group.origin), group.direction), end = dot3(sub3(b, group.origin), group.direction);
            group.edges.push({ a, b, normal: surface.normal, start: Math.min(start, end), end: Math.max(start, end) });
        }
    const lines = [];
    for (const { direction, origin, edges } of groups.values()) {
        const stops = [...new Set(edges.flatMap(edge => [edge.start, edge.end]).map(quantize))].sort((a, b) => a - b);
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i], b = stops[i + 1];
            if (b - a < 1e-8)
                continue;
            const middle = (a + b) / 2, cover = edges.filter(edge => edge.start < middle + 1e-8 && edge.end > middle - 1e-8);
            if (!cover.length)
                continue;
            // Polygonal approximations of curved apertures should read as a smooth
            // reveal, rather than outlining every shallow 128-segment facet.
            if (cover.length > 1 && cover.every(edge => Math.abs(dot3(normalize3(edge.normal), normalize3(cover[0].normal))) > Math.cos(Math.PI / 12)))
                continue;
            const point = (distance) => ({ x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance });
            lines.push(point(a), point(b));
        }
    }
    return lines;
}
/** Scene floors are already in metres; derive labels from their true net shape. */
export function floorLabelData(floor) {
    const to2D = (p) => ({ x: p.x, y: p.z });
    const region = { points: floor.points.map(to2D), holes: floor.holes.map(hole => hole.map(to2D)) };
    if (floor.partIndex !== undefined)
        region.surfaceParts = [{ points: region.points, holes: region.holes }];
    const point = regionInteriorPoint(region);
    if (!point)
        return null;
    const { netArea } = regionMetrics(region, { metersPerPixel: 1 });
    return { point: { x: point.x, y: .02, z: point.y }, netArea };
}
/** Ear clipping preserves original indices and concave boundaries. Holes are masked separately by the renderer. */
export function triangulateXZ(points) {
    const valid = validatePolygon(points.map(p => ({ x: p.x, y: p.z })));
    if (!valid.valid)
        throw new RangeError('Invalid floor polygon: ' + valid.error);
    const cross = (a, b, c) => (points[b].x - points[a].x) * (points[c].z - points[a].z) - (points[b].z - points[a].z) * (points[c].x - points[a].x);
    const extent = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.z)) - Math.min(...points.map(p => p.z));
    const epsilon = Math.max(1e-14, extent * extent * 1e-12);
    let ring = points.map((_, i) => i);
    let removed = true;
    while (removed && ring.length > 3) {
        removed = false;
        for (let i = 0; i < ring.length; i++) {
            if (Math.abs(cross(ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length])) <= epsilon) {
                ring.splice(i, 1);
                removed = true;
                break;
            }
        }
    }
    const area = ring.reduce((sum, index, i) => sum + cross(ring[0], index, ring[(i + 1) % ring.length]), 0);
    if (area < 0)
        ring.reverse();
    const triangles = [];
    while (ring.length > 3) {
        let found = false;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
            if (cross(a, b, c) <= epsilon)
                continue;
            if (ring.some(p => p !== a && p !== b && p !== c && cross(a, b, p) >= -epsilon && cross(b, c, p) >= -epsilon && cross(c, a, p) >= -epsilon))
                continue;
            triangles.push(a, b, c);
            ring.splice(i, 1);
            found = true;
            break;
        }
        if (!found)
            throw new RangeError('Floor triangulation failed; please check the boundary.');
    }
    triangles.push(...ring);
    return triangles;
}
//# sourceMappingURL=camera3d.js.map