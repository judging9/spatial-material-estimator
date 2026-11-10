import { detectPlanRooms } from './wall-plan.js';
import { intersectionArea, validateRegion } from './geometry.js';
import { newId } from './materials.js';
const clone = (value) => structuredClone(value);
const ROUNDING_AREA = 1e-5;
function comparable(value) {
    if (Array.isArray(value))
        return value.map(comparable);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key])]));
    return value;
}
function itemConfiguration(items) {
    // Item IDs identify UI rows, not their rate/quantity configuration.
    return JSON.stringify((items || []).map(item => JSON.stringify(comparable(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))))).sort());
}
function uniqueWallRegions(regions) {
    const ids = new Set();
    return regions.filter(region => {
        if (region?.source !== 'walls' || ids.has(region.id))
            return false;
        ids.add(region.id);
        return true;
    });
}
/**
 * Rebuild only wall-derived rooms, keeping manual geometry and material edits.
 * Pass prior cache together with current regions after an unfinished wall edit.
 * On any invalid/overlapping result, wall rooms leave the quote while their
 * configuration remains in cache until the wall graph is repaired.
 */
export function rebuildWallRegions(walls, previousRegions, idFactory = newId, joinStyle = 'square') {
    if (!Array.isArray(previousRegions))
        return { regions: [], cache: [], error: '已有区域数据格式不正确' };
    const manual = previousRegions.filter(region => region?.source !== 'walls');
    const previous = uniqueWallRegions(previousRegions);
    const failure = (message) => ({ regions: clone(manual), cache: clone(previous), error: message });
    if (!Array.isArray(walls))
        return failure('墙线数据格式不正确');
    if (!walls.length)
        return { regions: clone(manual), cache: [], error: null };
    try {
        const faces = detectPlanRooms(walls, joinStyle);
        if (!faces.length)
            return failure('墙线尚未闭合，请连接端点形成房间后再计算报价');
        const previousKeys = new Map();
        for (const region of previous)
            if (region.sourceKey && !previousKeys.has(region.sourceKey))
                previousKeys.set(region.sourceKey, region);
        const assignments = faces.map(face => {
            const exact = previousKeys.get(face.key);
            if (exact)
                return { face, matches: [exact], exact: true };
            const matches = previous.map(region => ({ region, area: intersectionArea(face, region) }))
                .filter(match => match.area > ROUNDING_AREA).sort((a, b) => b.area - a.area).map(match => match.region);
            return { face, matches, exact: false };
        });
        const descendants = new Map();
        for (const { matches } of assignments)
            if (matches.length === 1)
                descendants.set(matches[0].id, (descendants.get(matches[0].id) || 0) + 1);
        const exactIds = new Set(assignments.filter(a => a.exact).map(a => a.matches[0].id));
        const usedIds = new Set(manual.map(region => region.id));
        const reservedIds = new Set(previousRegions.flatMap(region => [region.id, ...(region.items || []).map(item => item.id), ...(region.ceiling?.items || []).map(item => item.id)]));
        let fallbackCounter = 0;
        const freshId = (prefix) => {
            let id = String(idFactory(prefix));
            while (!id || usedIds.has(id) || reservedIds.has(id))
                id = `${id || prefix}-${++fallbackCounter}`;
            usedIds.add(id);
            return id;
        };
        const childNumber = new Map();
        const notices = new Set();
        const generated = [];
        for (const { face, matches, exact } of assignments) {
            const parent = matches[0];
            const isMerge = matches.length > 1;
            const isSplit = matches.length === 1 && (descendants.get(parent.id) || 0) > 1;
            const sameMaterials = !isMerge || matches.every(region => itemConfiguration(region.items) === itemConfiguration(parent.items));
            const occurrence = parent ? (childNumber.get(parent.id) || 0) + 1 : 0;
            if (parent)
                childNumber.set(parent.id, occurrence);
            const keepId = parent && !usedIds.has(parent.id) && (exact || !exactIds.has(parent.id));
            const id = keepId ? parent.id : freshId('area');
            if (keepId)
                usedIds.add(id);
            const base = parent ? clone(parent) : {
                id, name: `房间 ${String(generated.length + 1).padStart(2, '0')}`, points: [], holes: [], hidden: false, items: [], additionalCost: '0',
            };
            let items = sameMaterials ? clone(base.items || []) : [];
            let additionalCost = base.additionalCost || '0';
            let name = base.name;
            if (isSplit) {
                name = `${parent.name} ${occurrence}`.slice(0, 120);
                if (occurrence > 1) {
                    additionalCost = '0';
                    items = items.map(item => ({ ...item, id: freshId('item'), additionalCost: '0' }));
                }
                // A room's manually measured quantity has no justified allocation after a split.
                items = items.map(item => item.quantityMode === 'manual' ? { ...item, quantity: '0' } : item);
                notices.add('房间已拆分并继承材料单价；固定费用保留在首个子区，手工用量请重新填写');
            }
            if (isMerge) {
                name = [...new Set(matches.map(region => region.name))].join(' / ').slice(0, 120);
                additionalCost = '0';
                items = items.map(item => ({ ...item, additionalCost: '0', ...(item.quantityMode === 'manual' ? { quantity: '0' } : {}) }));
                notices.add(sameMaterials ? '房间已合并并保留相同材料方案；固定费用和手工用量请重新核对' : '合并区域的材料配置不同，请重新选择材料');
            }
            if (base.ceiling) {
                base.ceiling = clone(base.ceiling);
                if (isSplit) {
                    if (occurrence > 1) {
                        base.ceiling.additionalCost = '0';
                        base.ceiling.items = base.ceiling.items.map(item => ({ ...item, id: freshId('ceiling-item'), additionalCost: '0' }));
                    }
                    base.ceiling.items = base.ceiling.items.map(item => item.quantityMode === 'manual' ? { ...item, quantity: '0' } : item);
                }
                if (isMerge) {
                    const config = (region) => region.ceiling ? JSON.stringify({ enabled: region.ceiling.enabled, height: region.ceiling.height, items: itemConfiguration(region.ceiling.items) }) : null;
                    if (!matches.every(region => config(region) === config(parent))) {
                        base.ceiling.enabled = false;
                        base.ceiling.items = [];
                        notices.add('合并区域的天花板配置不同，请重新设置天花板材料');
                    }
                    else
                        base.ceiling.items = base.ceiling.items.map(item => ({ ...item, additionalCost: '0', ...(item.quantityMode === 'manual' ? { quantity: '0' } : {}) }));
                    base.ceiling.additionalCost = '0';
                }
            }
            const region = {
                ...base, id, name, points: clone(face.points), holes: clone(face.holes || []),
                source: 'walls', sourceKey: face.key, centerlinePoints: clone(face.centerlinePoints), items, additionalCost,
            };
            // The wall engine's stable key is the sorted JSON array of boundary IDs.
            const wallIds = JSON.parse(face.key);
            if (Array.isArray(wallIds) && wallIds.every(value => typeof value === 'string'))
                region.wallIds = wallIds;
            const validation = validateRegion(region, [...manual, ...generated]);
            if (!validation.valid)
                return failure(`墙体生成的房间无效：${validation.error}`);
            generated.push(region);
        }
        generated.forEach((region, index) => { if (/^房间 \d+(?: \d+)*$/.test(region.name))
            region.name = `房间 ${String(index + 1).padStart(2, '0')}`; });
        return { regions: [...clone(manual), ...generated], cache: clone(generated), error: null, ...(notices.size ? { notice: [...notices].join('；') } : {}) };
    }
    catch (error) {
        return failure(error instanceof Error ? error.message : '墙体房间无法可靠计算，请检查墙线');
    }
}
//# sourceMappingURL=wall-regions.js.map