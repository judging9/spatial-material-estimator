import { compileTerrain, terrainStats } from './lib/terrain.js';
import { municipalScale } from './lib/municipal-design.js';
/** A measured TIN background. It never substitutes a guessed height outside
 * the survey hull; hiding it changes display only. */
export function paintTerrain(ctx, project, toScreen) {
    const terrain = project.municipalTerrain, scale = municipalScale(project);
    if (!terrain?.visible || !scale)
        return;
    const mesh = compileTerrain(terrain), stats = terrainStats(terrain), span = (stats.maxElevation ?? 0) - (stats.minElevation ?? 0);
    const screen = (p) => toScreen({ x: p.x / scale, y: p.y / scale });
    ctx.save();
    for (const triangle of mesh.triangles) {
        const shade = span ? Math.max(0, Math.min(1, (triangle.reduce((z, p) => z + p.z / 3, 0) - (stats.minElevation ?? 0)) / span)) : .5;
        const rgb = [235, 240, 231].map((v, i) => Math.round(v - shade * [42, 40, 42][i]));
        ctx.beginPath();
        triangle.forEach((p, i) => { const point = screen(p); if (i)
            ctx.lineTo(point.x, point.y);
        else
            ctx.moveTo(point.x, point.y); });
        ctx.closePath();
        ctx.fillStyle = `rgba(${rgb.join(',')},.65)`;
        ctx.fill();
        if (!terrain.raster) {
            ctx.strokeStyle = 'rgba(89,118,96,.16)';
            ctx.lineWidth = .6;
            ctx.stroke();
        }
    }
    if (terrain.raster && mesh.bounds) {
        const a = screen({ x: mesh.bounds.minX, y: mesh.bounds.minY }), b = screen({ x: mesh.bounds.maxX, y: mesh.bounds.maxY });
        ctx.strokeStyle = 'rgba(89,118,96,.4)';
        ctx.lineWidth = .8;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.setLineDash([]);
    }
    if (!terrain.raster && terrain.points.length <= 80) {
        ctx.font = '10px "Microsoft YaHei",sans-serif';
        for (const p of terrain.points) {
            const point = screen(p);
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#758b78';
            ctx.fill();
            if (project.view.labels) {
                ctx.fillStyle = '#607664';
                ctx.fillText(p.z.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' m', point.x + 6, point.y - 6);
            }
        }
    }
    ctx.restore();
}
//# sourceMappingURL=terrain-render.js.map