import { icon, measure } from './ui.js';
import { terrainStats, validateTerrain } from './lib/terrain.js';
import { normalizeRoadProfile, validateRoadProfile, roadStations } from './lib/road-profile.js';
import { validateRoadTunnel } from './lib/road-tunnel.js';
import { resolveHydraulicSources, validateHydraulicNetwork } from './lib/hydraulics.js';
import { renderEarthworkTransferEntry } from './earthwork-transfer-panel.js';
export function renderMunicipalEngineering(project) {
    const stats = terrainStats(project.municipalTerrain), network = project.municipalHydraulics;
    const terrainLabel = project.municipalTerrain?.sourceName?.includes('自建') ? '自建地形' : project.municipalTerrain?.raster ? '栅格地形' : '地形与塑形';
    const terrainDescription = stats.pointCount ? `${stats.pointCount} 个${project.municipalTerrain?.raster ? '有效像元' : '测点'} · ${measure(stats.area, 1)} m² 覆盖` : '自建平地与起伏，或导入测点 / DEM';
    return `<section class="panel-section municipal-engineering"><div class="section-head"><h3>场地分析</h3><span class="eyebrow">Measured design</span></div><button class="engineering-entry" data-action="edit-terrain"><span>${icon('layers', 17)}</span><span><strong>${terrainLabel}</strong><small>${terrainDescription}</small></span>${icon('chevronRight', 13)}</button><button class="engineering-entry" data-action="municipal-hydraulics"><span>${icon('route', 17)}</span><span><strong>管网水力</strong><small>${network ? `${network.nodes.length} 个节点 · ${network.links.length} 段管道` : '泵阀、供排水与水位时序'}</small></span>${icon('chevronRight', 13)}</button>${renderEarthworkTransferEntry(project)}<p class="help">选中道路设置纵坡、竖曲线与横断面，结合真实地形计算路床挖填。所有高程使用同一基准。</p>${project.municipalTerrain ? `<label class="engineering-visibility"><input id="terrain-visible" type="checkbox" ${project.municipalTerrain.visible ? 'checked' : ''}>显示地形背景</label>` : ''}</section>`;
}
/** Rescale grade stations only when the physical horizontal geometry changes.
 * Explicitly entered invalid profiles are rejected rather than normalized. */
export function syncMunicipalEngineering(next, previous) {
    for (const item of next.municipalElements ?? []) {
        const before = previous.municipalElements?.find(value => value.id === item.id);
        if (item.tunnel && before?.tunnel && JSON.stringify([item.points, next.calibration]) !== JSON.stringify([before.points, previous.calibration])) {
            const oldLength = roadStations(previous, before)?.at(-1), length = roadStations(next, item)?.at(-1);
            if (oldLength && length && JSON.stringify(item.tunnel) === JSON.stringify(before.tunnel)) {
                item.tunnel.startStation *= length / oldLength;
                item.tunnel.endStation *= length / oldLength;
            }
        }
        if (item.roadProfile && before && JSON.stringify([item.points, next.calibration]) !== JSON.stringify([before.points, previous.calibration]))
            item.roadProfile = normalizeRoadProfile(next, item);
        validateRoadProfile(next, item);
        validateRoadTunnel(next, item);
    }
    validateTerrain(next.municipalTerrain);
    validateHydraulicNetwork(next.municipalHydraulics);
    if (next.municipalHydraulics)
        next.municipalHydraulics = resolveHydraulicSources(next, next.municipalHydraulics);
}
export function previewRoadGeometry(project, item, previousLength) {
    if (item.tunnel && previousLength) {
        const length = roadStations(project, item)?.at(-1);
        if (length) {
            item.tunnel.startStation *= length / previousLength;
            item.tunnel.endStation *= length / previousLength;
        }
    }
    if (item.roadProfile)
        item.roadProfile = normalizeRoadProfile(project, item);
}
//# sourceMappingURL=municipal-engineering.js.map