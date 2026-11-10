import { furnitureScale } from './furniture.js';
import { levelProjects } from './levels.js';
import { servicePreset, validateServiceRoutes } from './services.js';
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalized = (v) => { const length = Math.hypot(v.x, v.y, v.z); return { x: v.x / length, y: v.y / length, z: v.z / length }; };
/** Actual centimetre diameters and route heights, independent of the camera.
 * A procurement run count does not invent additional spatial placements. */
function routeModel(route, scale, elevation) {
    const points = route.points.map(point => ({ x: point.x * scale, y: (point.z + elevation) / 100, z: point.y * scale }));
    const color = servicePreset(route.presetId).color, diameter = route.diameter / 100;
    const segments = [], surfaces = [];
    for (let index = 1; index < points.length; index++) {
        const start = points[index - 1], end = points[index], delta = subtract(end, start), length = Math.hypot(delta.x, delta.y, delta.z);
        if (length < 1e-9)
            continue;
        segments.push({ start, end, length });
        const axis = normalized(delta), u = normalized(cross(axis, Math.abs(axis.y) < .9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 })), v = cross(axis, u);
        const sides = 10, ring = (center) => Array.from({ length: sides }, (_, side) => {
            const angle = side / sides * Math.PI * 2, radius = diameter / 2;
            return { x: center.x + radius * (u.x * Math.cos(angle) + v.x * Math.sin(angle)),
                y: center.y + radius * (u.y * Math.cos(angle) + v.y * Math.sin(angle)),
                z: center.z + radius * (u.z * Math.cos(angle) + v.z * Math.sin(angle)) };
        });
        const first = ring(start), last = ring(end), base = `service:${route.id}:segment:${index - 1}`;
        const surface = (id, points, normal) => surfaces.push({ id, wallId: `service:${route.id}`, sourceIds: [], side: 'end', color, points, normal });
        for (let side = 0; side < sides; side++) {
            const next = (side + 1) % sides, angle = (side + .5) / sides * Math.PI * 2;
            surface(`${base}:side:${side}`, [first[side], first[next], last[next], last[side]], { x: u.x * Math.cos(angle) + v.x * Math.sin(angle), y: u.y * Math.cos(angle) + v.y * Math.sin(angle), z: u.z * Math.cos(angle) + v.z * Math.sin(angle) });
        }
        surface(`${base}:start`, [...first].reverse(), { x: -axis.x, y: -axis.y, z: -axis.z });
        surface(`${base}:end`, last, axis);
    }
    return { id: route.id, serviceRouteId: route.id, name: route.name, kind: 'service', presetId: route.presetId, color, diameter, points, segments, surfaces };
}
export function buildSceneServices(project) {
    const own = (source, elevation = 0) => {
        validateServiceRoutes(source.serviceRoutes ?? []);
        const scale = furnitureScale(source);
        if (!scale)
            return [];
        return (source.serviceRoutes ?? []).filter(route => !route.hidden).map(route => routeModel(route, scale, elevation));
    };
    if (!project.levels?.length)
        return own(project);
    return levelProjects(project).filter(level => project.view?.levelMode !== 'active' || level.id === project.activeLevelId)
        .flatMap(level => own(level.project, level.elevation).map(route => ({ ...route, levelId: level.id, levelName: level.name })));
}
/** Closest point between a forward ray and a finite route segment. Used for
 * a small pixel hit tolerance while retaining wall and floor occlusion. */
export function rayServiceSegment(origin, direction, segment) {
    const v = subtract(segment.end, segment.start), w = subtract(origin, segment.start);
    const a = dot(direction, direction), b = dot(direction, v), c = dot(v, v), d = dot(direction, w), e = dot(v, w), determinant = a * c - b * b;
    if (a < 1e-12 || c < 1e-18)
        return null;
    let parameter = Math.max(0, Math.min(1, determinant > 1e-15 ? (a * e - b * d) / determinant : e / c));
    let rayDistance = Math.max(0, (b * parameter - d) / a);
    if (rayDistance === 0)
        parameter = Math.max(0, Math.min(1, e / c));
    const point = { x: segment.start.x + parameter * v.x, y: segment.start.y + parameter * v.y, z: segment.start.z + parameter * v.z };
    const rayPoint = { x: origin.x + rayDistance * direction.x, y: origin.y + rayDistance * direction.y, z: origin.z + rayDistance * direction.z };
    return { rayDistance, point, distance: Math.hypot(point.x - rayPoint.x, point.y - rayPoint.y, point.z - rayPoint.z) };
}
//# sourceMappingURL=scene-services.js.map