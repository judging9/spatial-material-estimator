import { polygonArea, validatePolygon } from './geometry.js';
const EPS = 1e-6;
export const WALL_MITER_LIMIT = 4;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
const signedArea = (ring) => ring.reduce((sum, p, i) => sum + cross(subtract(p, ring[0]), subtract(ring[(i + 1) % ring.length], ring[0])), 0) / 2;
const frame = (wall) => {
    const vector = subtract(wall.end, wall.start), length = Math.hypot(vector.x, vector.y);
    if (!Number.isFinite(length) || length < 1 || !Number.isFinite(wall.thickness) || wall.thickness < 1 || wall.thickness > 100)
        throw new RangeError('墙线或墙厚无效，无法生成实际墙体边界。');
    const u = { x: vector.x / length, y: vector.y / length };
    return { u, n: { x: -u.y, y: u.x }, length, half: wall.thickness / 2 };
};
const at = (origin, u, n, along, across) => ({ x: origin.x + u.x * along + n.x * across, y: origin.y + u.y * along + n.y * across });
/** Actual butt ends and bounded miter connections, in source centimetres.
 * This helper is shared by floor subtraction, 3D solids and project boundaries.
 * No renderer creates a different width, cap or connection approximation. */
export function wallFootprints(walls, style = 'square') {
    if (!Array.isArray(walls))
        throw new TypeError('墙体边界需要墙线数组。');
    if (!['square', 'clean'].includes(style))
        throw new RangeError('墙体连接方式应为原连接或整洁连接。');
    const frames = walls.map(frame);
    return walls.flatMap((wall, index) => {
        const own = frames[index];
        if (style === 'square')
            return [{ wallId: wall.id, points: [[-own.half, -own.half], [own.length + own.half, -own.half], [own.length + own.half, own.half], [-own.half, own.half]].map(([u, v]) => at(wall.start, own.u, own.n, u, v)) }];
        const cap = (point, end) => {
            const direction = end ? { x: -own.u.x, y: -own.u.y } : own.u;
            const normal = { x: -direction.y, y: direction.x };
            const hostIndex = walls.findIndex((other, j) => {
                if (j === index || same(point, other.start) || same(point, other.end))
                    return false;
                const host = frames[j], local = subtract(point, other.start), along = dot(local, host.u), across = dot(local, host.n);
                // Only an explicit centreline junction is a T. Nearby offset sides of
                // curved chains can overlap without defining a topological connection.
                return along > EPS && along < host.length - EPS && Math.abs(across) <= EPS && Math.abs(dot(direction, host.n)) > EPS;
            });
            if (hostIndex >= 0) {
                const host = frames[hostIndex], origin = walls[hostIndex].start, denominator = dot(direction, host.n), near = host.half * Math.sign(denominator);
                const flush = (sign) => {
                    const p = at(point, direction, normal, 0, own.half * sign);
                    const along = (near - dot(subtract(p, origin), host.n)) / denominator;
                    return at(point, direction, normal, along, own.half * sign);
                };
                const left = flush(1), right = flush(-1);
                return end ? { left: right, right: left } : { left, right };
            }
            const neighbours = walls.flatMap((other, j) => {
                if (j === index)
                    return [];
                const opposite = same(point, other.start) ? other.end : same(point, other.end) ? other.start : null;
                if (!opposite)
                    return [];
                const vector = subtract(opposite, point), length = Math.hypot(vector.x, vector.y);
                const u = { x: vector.x / length, y: vector.y / length };
                // Repeated/collinear source walls are handled by the solid union, not
                // mistaken for a second corner ray or made into zero-length miters.
                if (Math.abs(cross(direction, u)) <= 1e-8)
                    return [];
                return [{ u, half: frames[j].half }];
            });
            let left = at(point, direction, normal, 0, own.half), right = at(point, direction, normal, 0, -own.half);
            if (neighbours.length === 1) {
                const neighbour = neighbours[0], otherNormal = { x: -neighbour.u.y, y: neighbour.u.x };
                const denominator = cross(direction, neighbour.u);
                const miter = (sign) => {
                    const a = at(point, direction, normal, 0, own.half * sign), b = at(point, neighbour.u, otherNormal, 0, -neighbour.half * sign);
                    const along = cross(subtract(b, a), neighbour.u) / denominator;
                    const limit = WALL_MITER_LIMIT * Math.max(own.half, neighbour.half);
                    const maxAlong = Math.sqrt(Math.max(0, limit * limit - own.half * own.half));
                    return at(point, direction, normal, Math.max(-maxAlong, Math.min(maxAlong, along)), own.half * sign);
                };
                left = miter(1);
                right = miter(-1);
            }
            return end ? { left: right, right: left } : { left, right };
        };
        const start = cap(wall.start, false), end = cap(wall.end, true);
        let points = [start.right, end.right, end.left, start.left];
        // An endpoint entering a through wall cannot push its diagonal/thick cap
        // beyond the host's far face. Choose the earliest host deterministically.
        for (const [point, opposite] of [[wall.start, wall.end], [wall.end, wall.start]]) {
            const direction = subtract(opposite, point);
            const hostIndex = walls.findIndex((other, j) => {
                if (j === index || same(point, other.start) || same(point, other.end))
                    return false;
                const host = frames[j], local = subtract(point, other.start), along = dot(local, host.u), across = dot(local, host.n);
                return along > EPS && along < host.length - EPS && Math.abs(across) <= EPS && Math.abs(dot(direction, host.n)) > EPS;
            });
            if (hostIndex < 0)
                continue;
            const host = frames[hostIndex], origin = walls[hostIndex].start, sign = Math.sign(dot(direction, host.n));
            const distance = (p) => dot(subtract(p, origin), host.n) * sign + host.half;
            const clipped = [];
            for (let i = 0; i < points.length; i++) {
                const a = points[i], b = points[(i + 1) % points.length], da = distance(a), db = distance(b);
                if (da >= -EPS)
                    clipped.push(a);
                if ((da >= -EPS) !== (db >= -EPS)) {
                    const t = da / (da - db);
                    clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
                }
            }
            points = clipped;
        }
        points = points.filter((p, i) => !same(p, points[(i + points.length - 1) % points.length]));
        if (points.length < 3 || polygonArea(points) < EPS * EPS)
            return [];
        const valid = validatePolygon(points);
        if (!valid.valid)
            throw new RangeError('整理墙体后边界无效，请增大短墙长度、减小墙厚或调整锐角：' + valid.error);
        if (signedArea(points) < 0)
            points.reverse();
        // Each miter quad and every half-plane trim is convex. Retain an assertion
        // so future join styles cannot silently feed a concave volume to clipping.
        if (points.some((p, i) => cross(subtract(points[(i + 1) % points.length], p), subtract(points[(i + 2) % points.length], points[(i + 1) % points.length])) < -EPS))
            throw new RangeError('墙体连接产生不可靠的凹形边界，请调整短墙或锐角。');
        return [{ wallId: wall.id, points }];
    });
}
//# sourceMappingURL=wall-joins.js.map