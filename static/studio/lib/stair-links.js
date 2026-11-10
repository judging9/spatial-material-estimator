import { activeLevel, levelProjects } from './levels.js';
import { intersectionArea } from './geometry.js';
import { isStairKind, stairPlanGeometry } from './stairs.js';
export function incomingStairs(project) {
    if (!project.levels?.length)
        return [];
    const current = activeLevel(project);
    return levelProjects(project).filter(level => level.elevation < current.elevation).flatMap(level => (level.project.furniture ?? []).filter(item => isStairKind(item.kind) && !item.hidden && item.stairTargetLevelId === current.id)
        .map(item => ({ item, project: level.project, levelId: level.id, levelName: level.name, elevation: level.elevation })));
}
const ownerFor = (project, id) => id === project.activeLevelId ? project : project.levels.find(level => level.id === id).content;
const newOpeningId = () => 'floor-opening-' + crypto.randomUUID();
/** Update generated apertures atomically on a cloned project. Stair budgets
 * remain on their source floor; upper-floor references never copy furniture. */
export function syncLinkedStairOpenings(project) {
    if (!project.levels?.length)
        return;
    const layers = levelProjects(project);
    const sources = layers.flatMap(level => (level.project.furniture ?? []).filter(item => isStairKind(item.kind)).map(item => ({ level, item })));
    if (!sources.some(source => source.item.stair?.autoOpening) && !layers.some(level => level.project.floorOpenings?.some(opening => opening.sourceStairId)))
        return;
    const previous = new Map();
    for (const level of layers) {
        const owner = ownerFor(project, level.id);
        for (const opening of owner.floorOpenings ?? [])
            if (opening.sourceStairId)
                previous.set(opening.sourceStairId, opening);
        owner.floorOpenings = (owner.floorOpenings ?? []).filter(opening => !opening.sourceStairId);
    }
    for (const { level, item } of sources) {
        if (!item.stair?.autoOpening || !item.stairTargetLevelId)
            continue;
        const target = layers.find(layer => layer.id === item.stairTargetLevelId);
        if (!target || target.elevation <= level.elevation)
            continue;
        const plan = stairPlanGeometry(item, level.project);
        if (!plan)
            throw new RangeError('请先校准图纸，再匹配楼梯口。');
        const opening = plan.opening, old = previous.get(item.id);
        const candidates = target.project.regions.map(region => ({ region, area: intersectionArea(region, opening) })).filter(candidate => candidate.area > 1e-6).sort((a, b) => b.area - a.area);
        const region = candidates.find(candidate => candidate.region.id === old?.regionId)?.region ?? candidates[0]?.region;
        if (!region)
            throw new RangeError(`${item.name}上方没有可开洞的房间。先在目标层画房间，再自动匹配楼梯口。`);
        const owner = ownerFor(project, target.id);
        (owner.floorOpenings ??= []).push({ ...opening, id: old?.id ?? newOpeningId(), regionId: region.id, sourceStairId: item.id, sourceLevelId: level.id, clearance: item.stair.openingClearance ?? 5 });
    }
}
export function defaultStairSettings(item) {
    return item.stair ?? { railing: 'both', railingHeight: 90, autoOpening: false, openingClearance: 5 };
}
export function detachStairOpening(project, stairId, remove = false) {
    for (const level of levelProjects(project)) {
        const owner = project.levels ? ownerFor(project, level.id) : project;
        const item = owner.furniture?.find(item => item.id === stairId);
        if (item)
            item.stair = { ...defaultStairSettings(item), autoOpening: false };
        owner.floorOpenings = (owner.floorOpenings ?? []).filter(opening => !(remove && opening.sourceStairId === stairId));
        for (const opening of owner.floorOpenings)
            if (opening.sourceStairId === stairId) {
                delete opening.sourceStairId;
                delete opening.sourceLevelId;
                delete opening.clearance;
            }
    }
}
//# sourceMappingURL=stair-links.js.map