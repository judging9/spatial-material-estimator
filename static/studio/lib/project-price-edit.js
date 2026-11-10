import { calculateProjectBudget, projectBudgetEntries } from './project-budget.js';
import { addDecimal, formatMoney, normalizeDecimal } from './pricing.js';
import { validateProject } from './persistence.js';
import { FURNITURE_TEMPLATES } from './furniture-catalog.js';
import { civilPreset } from './civil.js';
import { municipalElementPreset } from './municipal-design.js';
import { normalizeMaterial } from './materials.js';
import { effectivePriceProvenance, describePriceSource } from './price-provenance.js';
const fields = ['unitPrice', 'wasteRate', 'laborRate'];
const allFields = { unitPrice: 'unitPrice', wasteRate: 'wasteRate', laborRate: 'laborRate' };
const onePrice = (field = 'unitPrice') => ({ unitPrice: field });
const find = (rows, id) => rows?.find(row => row.id === id);
const physicalSize = (source) => [source.width, source.depth, source.height].filter(value => value !== undefined).join(' × ') + ' cm';
const openingKinds = { door: '门', window: '窗', hole: '墙面开孔' };
const openingShapes = { rectangle: '矩形', ellipse: '圆 / 椭圆', polygon: '自定义多边形' };
/** The active storey lives at root. Inactive storeys are edited in their raw
 * content; derived slab fragments and switchLevel snapshots are never written. */
function contentFor(project, levelId) {
    if (!project.levels)
        return project;
    if (!levelId)
        return undefined;
    if (levelId === project.activeLevelId)
        return project;
    return project.levels.find(level => level.id === levelId)?.content;
}
function ownerFor(project, section, type, id, levelId) {
    if (section === 'municipal')
        return find(project.municipalElements, id);
    const content = contentFor(project, levelId);
    if (!content)
        return undefined;
    if (type === 'region' || type === 'ceiling')
        return find(content.regions, id);
    if (type === 'wall')
        return find(content.wallShapes, id) ?? find(content.walls, id);
    if (type === 'opening')
        return find(content.openings, id);
    if (type === 'furniture')
        return find(content.furniture, id);
    if (type === 'service')
        return find(content.serviceRoutes, id);
    if (type === 'civil')
        return find(content.civilElements, id);
    return undefined;
}
function bindingFor(project, section, row, type, targetId, item) {
    const base = (value) => ownerFor(value, section, type, targetId, row.levelId);
    const source = base(project);
    if (!source)
        return undefined;
    if (['region', 'wall', 'ceiling'].includes(type)) {
        const resolve = (value) => {
            const owner = base(value);
            if (type === 'ceiling' && !owner?.ceiling?.enabled)
                return undefined;
            return find(type === 'ceiling' ? owner?.ceiling?.items : owner?.items, item.id);
        };
        const snapshot = resolve(project);
        return snapshot ? { resolve, fields: allFields, materialSnapshot: true, spec: String(snapshot.provenance?.spec ?? ''), note: '只更新本工程材料快照；材料库和其他未选项目保持原价。' } : undefined;
    }
    if (type === 'furniture')
        return { resolve: base, fields: onePrice(), spec: `${FURNITURE_TEMPLATES.find(template => template.kind === source.kind)?.name ?? '自定义家具'} · ${physicalSize(source)}`, note: '按用户确认件数计价；本项没有独立损耗和人工费参数。' };
    if (type === 'service')
        return { resolve: base, fields: allFields, spec: [source.spec, `外径 / 显示直径 ${source.diameter} cm`].filter(Boolean).join(' · '), note: '路径、预留长度和并行条数保持原设置。' };
    if (type === 'opening') {
        const resolve = (value) => base(value)?.quote?.enabled ? base(value).quote : undefined;
        return resolve(project) ? { resolve, fields: allFields, spec: `${openingKinds[source.kind] ?? '墙面开口'} · ${openingShapes[source.shape] ?? '矩形'} · ${physicalSize(source)}`, note: '只更新已启用的门窗 / 开孔本体报价，不改变墙面扣孔量。' } : undefined;
    }
    if (type === 'civil') {
        const spec = `${civilPreset(source.kind).name} · ${physicalSize(source)}`;
        if (item.id === source.id + ':material')
            return { resolve: base, fields: allFields, spec, note: '主材和人工按原构件净体积计算，固定费不变。' };
        if (item.id === source.id + ':formwork' && source.formworkRate !== '')
            return { resolve: base, fields: onePrice('formworkRate'), spec, note: '只修改已启用模板综合单价，不把模板面积当作采购板材面积。' };
        if (item.id === source.id + ':rebar' && source.rebarMode !== 'none')
            return { resolve: base, fields: onePrice('rebarPrice'), spec: source.rebarMode === 'ratio' ? `用户钢筋指标 ${source.rebarRatio} kg/m³` : `用户钢筋公斤数 ${source.rebarQuantity} kg`, note: '钢筋指标或手工公斤数保持原设置，不推断材质等级。' };
        return undefined;
    }
    if (type !== 'municipal')
        return undefined;
    const spec = `${municipalElementPreset({ kind: source.kind, catalogId: source.catalogId }).name} · 宽 ${source.width} cm · 深 ${source.depth} cm · 高 / 厚 ${source.height} cm`;
    if (item.id === source.id + ':main')
        return { resolve: base, fields: allFields, spec, note: '综合主项报价，不自动更改计价单位或补入施工分项。' };
    const layer = find(source.items, item.id);
    if (layer)
        return { resolve: value => find(base(value)?.items, item.id), fields: allFields, spec: `结构层厚度 ${layer.thickness} cm`, note: '层厚、单位及分项固定费保持原设置。' };
    if (item.category === 'tunnel' && item.id === source.id + ':tunnel') {
        if (!source.tunnel?.enabled || !source.tunnel.pricingEnabled)
            return undefined;
        const resolve = (value) => base(value)?.tunnel?.enabled && base(value).tunnel.pricingEnabled ? base(value).tunnel : undefined;
        return { resolve, fields: { unitPrice: 'unitPrice', laborRate: 'laborRate' }, priceSource: true,
            spec: `${source.tunnel.shape === 'arch' ? '拱形' : '矩形'}隧道 · 里程 ${source.tunnel.startStation}–${source.tunnel.endStation} m · 净高 ${source.tunnel.clearHeight} m · 衬砌 ${source.tunnel.liningThickness} m`,
            note: '按真实三维路线长度 × 预算份数计米；仅修改综合单价和人工单价，隧道几何、独立计费开关和固定费保持原设置。' };
    }
    if (item.category === 'bridge') {
        const part = item.bridgePart === 'piers' ? 'pier' : item.bridgePart === 'railings' ? 'railing' : null;
        if (!part || !source.bridgeOptions?.[part + 'PricingEnabled'])
            return undefined;
        const resolve = (value) => base(value)?.bridgeOptions?.[part + 'PricingEnabled'] ? base(value).bridgeOptions : undefined;
        return { resolve, fields: onePrice(part + 'UnitPrice'), spec: part === 'pier' ? `中间墩高 ${source.bridgeOptions.pierHeight} cm` : `栏杆高 ${source.bridgeOptions.railingHeight} cm`, note: item.quantityBasis };
    }
    if (item.category === 'earthwork') {
        const field = item.id === source.id + ':cutVolume' ? 'cutUnitPrice' : item.id === source.id + ':fillVolume' ? 'fillUnitPrice' : null;
        if (!field || !source.roadProfile?.earthwork?.enabled)
            return undefined;
        const resolve = (value) => base(value)?.roadProfile?.earthwork?.enabled ? base(value).roadProfile.earthwork : undefined;
        return { resolve, fields: onePrice(field), spec: '道路设计路床与地形高程差', note: '仅修改综合施工单价，地形覆盖不足仍保持待确认。' };
    }
    if (item.category === 'earthwork-balance') {
        const key = { 'borrow-material': 'borrowMaterial', 'reuse-haul': 'reuseHaul', 'borrow-haul': 'borrowHaul', 'spoil-haul': 'spoilHaul' }[item.balanceKey];
        if (!key || !source.roadProfile?.earthworkBalance?.enabled || !source.roadProfile.earthworkBalance[key]?.enabled)
            return undefined;
        const resolve = (value) => {
            const balance = base(value)?.roadProfile?.earthworkBalance;
            return balance?.enabled && balance[key]?.enabled ? balance[key] : undefined;
        };
        const config = source.roadProfile.earthworkBalance;
        return { resolve, fields: onePrice(), spec: key === 'borrowMaterial' ? '借方天然体积' : `松方运输 · 用户运距 ${config[key].distanceKm} km`, note: '不改变土质系数、运距及收费开关；须核对原挖填综合价包含范围。' };
    }
    if (item.category === 'earthwork-transfer') {
        const resolve = (value) => value.municipalEarthworkTransfer?.enabled ? find(value.municipalEarthworkTransfer.routes, item.transferRouteId) : undefined;
        const route = resolve(project);
        if (!route?.enabled)
            return undefined;
        const fromName = find(project.municipalElements, route.fromRoadId)?.name || '来源道路';
        const toName = find(project.municipalElements, route.toRoadId)?.name || '目标道路';
        return { resolve, fields: onePrice(), spec: `${fromName} → ${toName} · 运距 ${route.distanceKm} km`, note: '运输单价影响最小费用调配，预览会重算路线用量；不改变源道路几何。' };
    }
    return undefined;
}
function sourceDescription(snapshot, item) {
    const provenance = snapshot ? effectivePriceProvenance(snapshot, item.unitPrice) : item.provenance;
    return describePriceSource(provenance, Boolean(snapshot?.demo || item.demo), item.unitPrice === '');
}
function knownAmount(item) {
    if (item.knownTotal !== undefined && item.knownTotal !== null)
        return formatMoney(item.knownTotal);
    if (item.total !== undefined && item.total !== null)
        return formatMoney(item.total);
    return formatMoney(addDecimal(addDecimal(item.knownMaterialCost ?? item.materialCost ?? '0', item.knownLaborCost ?? item.laborCost ?? '0'), item.additionalCost ?? '0'));
}
function collect(project, includeExcluded = false) {
    const budget = calculateProjectBudget(project), rows = [], bindings = new Map();
    for (const section of budget.sections.filter(section => includeExcluded || section.included)) {
        for (const entry of projectBudgetEntries(section.id, section.quote))
            for (const item of entry.row.items ?? []) {
                const object = entry.row, targetId = entry.targetId ?? object.id;
                const id = 'price:' + JSON.stringify([section.id, object.levelId ?? '', entry.targetType, targetId, item.id]);
                const binding = bindingFor(project, section.id, object, entry.targetType, targetId, item);
                const snapshot = binding?.resolve(project), values = {};
                for (const field of fields) {
                    const key = binding?.fields[field];
                    values[field] = String(key && snapshot ? snapshot[key] ?? item[field] ?? (field === 'unitPrice' ? '' : '0') : item[field] ?? (field === 'unitPrice' ? '' : '0'));
                }
                const pendingReasons = [...new Set(item.pendingReasons?.length ? item.pendingReasons : item.pendingReason ? [item.pendingReason] : [])];
                rows.push({ id, section: section.id, levelId: object.levelId, levelName: object.levelName,
                    targetType: entry.targetType, targetId, itemId: item.id, objectName: object.name ?? '', name: item.materialName || item.name || '计价项目', unit: item.unit ?? '',
                    spec: binding?.spec ?? String(item.provenance?.spec ?? ''), values, editableFields: binding ? fields.filter(field => Boolean(binding.fields[field])) : [],
                    pending: Boolean(item.pending), pendingReasons,
                    netQuantity: item.netQuantity ?? item.quantity ?? null, purchaseQuantity: item.purchaseQuantity ?? null,
                    knownTotal: knownAmount(item), sourceNote: sourceDescription(snapshot, item),
                    materialId: snapshot?.priceMaterialId ?? (binding?.materialSnapshot ? snapshot?.materialId : undefined),
                    provenance: snapshot ? effectivePriceProvenance(snapshot, item.unitPrice) : item.provenance,
                    sourceLinkable: binding?.fields.unitPrice === 'unitPrice',
                    editNote: binding?.note ?? '本行由专用计算工具生成，请在对应属性或计算工具中调整报价。' });
                if (binding)
                    bindings.set(id, binding);
            }
    }
    return { rows, bindings };
}
export function collectProjectPriceRows(project) { return collect(project).rows; }
export function collectProjectSourceRows(project) { return collect(project, true).rows; }
function normalized(value, field) {
    if (typeof value !== 'string')
        throw new RangeError('报价参数必须是有效的十进制文字。');
    if (field === 'unitPrice' && value.trim() === '')
        return '';
    return normalizeDecimal(value, field === 'unitPrice' ? '单价' : field === 'wasteRate' ? '损耗率' : '人工单价');
}
function validateChanges(project, changes) {
    if (!Array.isArray(changes))
        throw new RangeError('批量报价修改列表格式不正确。');
    const { rows, bindings } = collect(project), byId = new Map(rows.map(row => [row.id, row])), seen = new Set();
    return changes.map(change => {
        if (!change || typeof change.rowId !== 'string' || seen.has(change.rowId))
            throw new RangeError('报价行编号不能为空或重复。');
        seen.add(change.rowId);
        const row = byId.get(change.rowId), binding = bindings.get(change.rowId);
        if (!row || !binding)
            throw new RangeError('报价行已失效、未汇入预算或不支持批量编辑，请重新打开报价列表。');
        if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values))
            throw new RangeError('报价修改参数格式不正确。');
        const values = {};
        for (const [field, value] of Object.entries(change.values)) {
            if (!fields.includes(field) || !row.editableFields.includes(field))
                throw new RangeError('本计价行不支持修改该字段；数量、固定费和计价开关只能在原属性中调整。');
            values[field] = normalized(value, field);
            if (field === 'unitPrice' && binding.fields.unitPrice === 'formworkRate' && values.unitPrice === '')
                throw new RangeError('模板空单价代表关闭计价；请填写零或有效单价，如需关闭模板请在原构件属性中设置。');
        }
        if (change.expected !== undefined) {
            if (!change.expected || typeof change.expected !== 'object' || Array.isArray(change.expected))
                throw new RangeError('报价原值校验格式不正确。');
            for (const [field, value] of Object.entries(change.expected)) {
                if (!fields.includes(field))
                    throw new RangeError('报价原值校验包含不支持的字段。');
                normalized(value, field);
                if (row.values[field] !== value)
                    throw new RangeError('报价已被其他操作修改，请重新读取列表后再应用，避免覆盖新值。');
            }
        }
        const written = Object.fromEntries(Object.entries(values).filter(([field, value]) => normalized(row.values[field], field) !== value));
        return { row, binding, written };
    });
}
function applyValidated(project, changes) {
    // Validate every row before applying anything, including rows late in a batch.
    const staged = validateChanges(project, changes), next = structuredClone(project), details = [];
    for (const { row, binding, written } of staged) {
        if (!Object.keys(written).length)
            continue;
        const target = binding.resolve(next);
        if (!target)
            throw new RangeError('报价源项目已变化，请重新打开列表。');
        for (const [field, value] of Object.entries(written))
            target[binding.fields[field]] = value;
        if ((binding.materialSnapshot || binding.priceSource) && Object.prototype.hasOwnProperty.call(written, 'unitPrice')) {
            const old = target.provenance;
            target.provenance = { source: '用户调整单价', ...(old?.spec ? { spec: old.spec } : {}), ...(old?.region ? { region: old.region } : {}) };
        }
        details.push({ rowId: row.id, name: row.name, objectName: row.objectName, before: { ...row.values }, after: { ...row.values, ...written } });
    }
    validateProject(next);
    calculateProjectBudget(next);
    return { project: next, changes: details };
}
/** Apply only explicit price fields to original source objects, preserving all
 * geometry, quantities, fixed fees, professional scope and material-library data. */
export function applyProjectPriceChanges(project, changes) { return applyValidated(project, changes).project; }
/** Link a consciously selected same-unit price or synchronize its latest quote.
 * Quantities, labor, waste, geometry, fixed fees and design materials are kept
 * in their original scope. Only the quote price and its traceable source change. */
export function applyProjectMaterialPrices(project, changes) {
    if (!Array.isArray(changes))
        throw new RangeError('来源报价更新列表无效。');
    const { rows, bindings } = collect(project, true), byId = new Map(rows.map(row => [row.id, row])), seen = new Set();
    const staged = changes.map(change => {
        if (!change || seen.has(change.rowId))
            throw new RangeError('来源报价行编号重复或无效。');
        seen.add(change.rowId);
        const row = byId.get(change.rowId), binding = bindings.get(change.rowId);
        if (!row || binding?.fields.unitPrice !== 'unitPrice')
            throw new RangeError('此分项需要在对应的专业工具中编辑来源与价格。');
        if (row.values.unitPrice !== change.expectedPrice || change.expectedMaterialId !== undefined && (row.materialId ?? null) !== change.expectedMaterialId)
            throw new RangeError('项目报价或关联来源已变化，请重新核对后应用。');
        const material = normalizeMaterial(change.material);
        if (material.unit !== row.unit)
            throw new RangeError('来源报价单位与项目单位不一致，不能直接覆盖。');
        return { change, binding, material };
    });
    const next = structuredClone(project);
    for (const { change, binding, material } of staged) {
        const target = binding.resolve(next);
        if (!target)
            throw new RangeError('原报价对象已变化。');
        target.unitPrice = material.unitPrice;
        target.priceMaterialId = material.id;
        target.priceSourceUnitPrice = material.unitPrice;
        target.provenance = structuredClone(material.provenance ?? { source: material.demo ? 'Demo 示例价格' : '用户手工报价', materialName: material.name });
        if (binding.materialSnapshot)
            target.demo = Boolean(material.demo);
    }
    validateProject(next);
    calculateProjectBudget(next);
    return next;
}
export function previewProjectPriceChanges(project, changes) {
    const before = calculateProjectBudget(project), result = applyValidated(project, changes), after = calculateProjectBudget(result.project);
    return { project: result.project, before, after, changedRows: result.changes.length, changes: result.changes };
}
//# sourceMappingURL=project-price-edit.js.map