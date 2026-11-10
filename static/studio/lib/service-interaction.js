const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function projection(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / square)) : 0;
    return { x: a.x + dx * t, y: a.y + dy * t };
}
export function serviceRouteAt(project, point, zoom, selectedId) {
    const routes = [...(project.serviceRoutes ?? [])].filter(route => !route.hidden).reverse();
    const selected = routes.find(route => route.id === selectedId);
    if (selected)
        routes.splice(routes.indexOf(selected), 1), routes.unshift(selected);
    return routes.find(route => route.points.slice(1).some((end, index) => distance(point, projection(point, route.points[index], end)) * zoom <= 7)) ?? null;
}
export function serviceVertexAt(route, point, zoom) {
    if (!route || route.hidden)
        return null;
    for (let i = route.points.length - 1; i >= 0; i--)
        if (distance(point, route.points[i]) * zoom <= 10)
            return i;
    return null;
}
export function snapServicePoint(project, point, zoom, previous, orthogonal = false, ignoreRouteId) {
    let result = { ...point };
    if (orthogonal && previous) {
        if (Math.abs(point.x - previous.x) >= Math.abs(point.y - previous.y))
            result.y = previous.y;
        else
            result.x = previous.x;
    }
    const candidates = [
        ...(project.furniture ?? []).filter(item => !item.hidden).map(item => item.position),
        ...(project.serviceRoutes ?? []).filter(route => !route.hidden && route.id !== ignoreRouteId).flatMap(route => route.points),
        ...(project.walls ?? []).flatMap(wall => [wall.start, wall.end, projection(result, wall.start, wall.end)])
    ];
    let closest = null, gap = 11 / zoom;
    for (const candidate of candidates) {
        if (orthogonal && previous && (result.x === previous.x && Math.abs(candidate.x - previous.x) > 1e-6 || result.y === previous.y && Math.abs(candidate.y - previous.y) > 1e-6))
            continue;
        const d = distance(result, candidate);
        if (d < gap) {
            gap = d;
            closest = candidate;
        }
    }
    if (closest)
        result = { x: closest.x, y: closest.y };
    else if (project.drawing?.type === 'plan') {
        if (!orthogonal || !previous || result.x !== previous.x)
            result.x = Math.round(result.x / 5) * 5;
        if (!orthogonal || !previous || result.y !== previous.y)
            result.y = Math.round(result.y / 5) * 5;
    }
    if (project.drawing) {
        result.x = Math.max(0, Math.min(project.drawing.width, result.x));
        result.y = Math.max(0, Math.min(project.drawing.height, result.y));
    }
    return result;
}
//# sourceMappingURL=service-interaction.js.map