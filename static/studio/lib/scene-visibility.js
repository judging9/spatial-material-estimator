import { normalize3, rayBox, rayMesh, triangulateSurface } from './camera3d.js';
/** Display choices never alter measured terrain, engineering data or prices. */
export function terrainDisplaySettings(mode) {
    if (mode === 'solid')
        return { opacity: 1, drawTerrain: true, writeDepth: true, occludesPicking: true };
    if (mode === 'cutaway')
        return { opacity: .22, drawTerrain: true, writeDepth: false, occludesPicking: false };
    if (mode === 'hidden')
        return { opacity: 0, drawTerrain: false, writeDepth: false, occludesPicking: false };
    throw new RangeError('无效的地形显示方式。');
}
/** Cache only real surface triangles. Bounds accelerate picking without filling
 * DEM voids or tunnel portals with an invented bounding-box surface. */
export function compileTerrainOccluders(surfaces) {
    return surfaces.map(surface => {
        const points = surface.points, indices = points.length === 3 ? [0, 1, 2] : triangulateSurface(points, surface.normal);
        const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const point of points)
            for (const axis of ['x', 'y', 'z']) {
                min[axis] = Math.min(min[axis], point[axis]);
                max[axis] = Math.max(max[axis], point[axis]);
            }
        return { points, indices, center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } };
    });
}
export function nearestTerrainRayDistance(origin, direction, terrain, limit = Infinity) {
    let nearest = limit, found = false;
    for (const surface of terrain) {
        const boundsHit = rayBox(origin, direction, surface.center, surface.size);
        if (boundsHit === null || boundsHit > nearest)
            continue;
        const hit = rayMesh(origin, direction, surface.points, surface.indices);
        if (hit !== null && hit <= nearest) {
            nearest = hit;
            found = true;
        }
    }
    return found ? nearest : null;
}
/** Test real terrain above measured inspection points. A ray through a DEM
 * gap or an open portal stays empty; coplanar road surfaces remain visible. */
export function terrainCoversInspectionPoints(terrain, points, tolerance = .01) {
    if (!Number.isFinite(tolerance) || tolerance < 0)
        throw new RangeError('无效的遮挡容差。');
    if (!terrain.length || !points.length)
        return false;
    return points.some(point => {
        if (![point.x, point.y, point.z].every(Number.isFinite))
            return false;
        const distance = nearestTerrainRayDistance({ ...point, y: point.y + tolerance }, { x: 0, y: 1, z: 0 }, terrain);
        return distance !== null && distance > 1e-8;
    });
}
/** Camera coordinates follow the real road grade and inward portal tangent.
 * The same orbit camera then continues to support the existing WASD controls. */
export function tunnelInspectionCamera(tunnel, position = 'inside') {
    if (!['inside', 'start', 'end'].includes(position))
        throw new RangeError('无效的隧道查看位置。');
    if (!tunnel?.enabled || !(tunnel.clearHeight > 0 && tunnel.length > 0) || tunnel.portals.length < 2)
        return null;
    const portal = tunnel.portals[position === 'end' ? tunnel.portals.length - 1 : 0];
    if (![...Object.values(portal.point), ...Object.values(portal.direction)].every(Number.isFinite))
        return null;
    const direction = normalize3(portal.direction);
    // The viewer uses a 45° vertical field of view. Leave room around the
    // portal above the eye, as well as at the sides, before entering the bore.
    const step = position === 'inside' ? Math.min(2, tunnel.length / 4) : Math.max(2, Math.max(tunnel.netWidth ?? 0, tunnel.clearHeight) * 1.75);
    const signedStep = position === 'inside' ? step : -step;
    const eye = { x: portal.point.x + direction.x * signedStep, y: portal.point.y + direction.y * signedStep + tunnel.clearHeight * .45, z: portal.point.z + direction.z * signedStep };
    const distance = position === 'inside' ? Math.min(2, Math.max(.25, tunnel.length / 4)) : 2;
    return {
        target: { x: eye.x + direction.x * distance, y: eye.y + direction.y * distance, z: eye.z + direction.z * distance },
        distance, yaw: Math.atan2(-direction.x, -direction.z), pitch: -Math.asin(Math.max(-1, Math.min(1, direction.y))),
    };
}
//# sourceMappingURL=scene-visibility.js.map