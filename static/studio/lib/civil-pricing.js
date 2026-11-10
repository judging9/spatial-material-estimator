import { addDecimal, multiplyDecimal, normalizeDecimal, formatMoney } from './pricing.js';
import { buildCivilQuantities, civilPreset } from './civil.js';
import { levelProjects, validateLevels } from './levels.js';
import { sourcePriceMetadata } from './price-provenance.js';
// Reuse the established decimal kernel. Sum already-rounded components as
// integer cents, including amounts above Number.MAX_SAFE_INTEGER.
const cents = (value) => BigInt(formatMoney(value).replace('.', ''));
const money = (value) => { const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(3, '0'); return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`; };
const sum = (values) => money(values.reduce((total, value) => total + cents(value), 0n));
const percent = (value) => multiplyDecimal(value, '.01');
const quantity = (value, count) => value === null ? null : multiplyDecimal(value, count);
function priceItem(input) {
    const missingQuantity = input.netQuantity === null, missingPrice = input.unitPrice === '';
    const purchaseQuantity = missingQuantity ? null : multiplyDecimal(input.netQuantity, addDecimal('1', percent(input.wasteRate ?? '0')));
    const materialCost = missingQuantity || missingPrice ? null : formatMoney(multiplyDecimal(purchaseQuantity, input.unitPrice));
    const laborCost = missingQuantity ? null : formatMoney(multiplyDecimal(input.netQuantity, input.laborRate ?? '0'));
    const knownMaterialCost = materialCost ?? '0.00', knownLaborCost = laborCost ?? '0.00', knownTotal = sum([knownMaterialCost, knownLaborCost]);
    const reasons = [...(missingQuantity ? ['图纸尚未校准，无法计算实际用量'] : []), ...(missingPrice ? [`${input.materialName}尚未填写单价`] : [])];
    return {
        id: input.id, materialId: input.materialId, materialName: input.materialName, unit: input.unit, quantityMode: 'manual',
        quantity: input.netQuantity, netQuantity: input.netQuantity, purchaseQuantity, unitPrice: input.unitPrice,
        wasteRate: input.wasteRate ?? '0', laborRate: input.laborRate ?? '0', additionalCost: '0.00',
        materialCost, laborCost, knownMaterialCost, knownLaborCost, knownTotal,
        pending: Boolean(reasons.length), status: reasons.length ? 'pending' : 'ready', pendingReasons: reasons,
        pendingReason: reasons.join('；') || null, total: reasons.length ? null : knownTotal,
    };
}
function priceElement(row) {
    const element = row.element, measurement = row.metrics, preset = civilPreset(element.kind), count = element.quantity;
    const volume = quantity(measurement.netVolume, count), grossVolume = quantity(measurement.grossVolume, count);
    const formworkQuantity = quantity(measurement.formworkArea, count), footprintQuantity = quantity(measurement.footprintArea, count);
    // Manual steel kilograms and the kg/m³ ratio remain user-entered decimals.
    // Their numeric UI equivalents never become the monetary quantity source.
    const rebarQuantity = element.rebarMode === 'none' ? '0' : element.rebarMode === 'manual'
        ? multiplyDecimal(element.rebarQuantity, count) : volume === null ? null : multiplyDecimal(volume, element.rebarRatio);
    const items = [priceItem({ id: element.id + ':material', materialId: element.kind, materialName: preset.name + '主材', unit: 'm³', netQuantity: volume, unitPrice: element.unitPrice, wasteRate: element.wasteRate, laborRate: element.laborRate })];
    Object.assign(items[0], sourcePriceMetadata(element));
    if (element.formworkRate !== '')
        items.push(priceItem({ id: element.id + ':formwork', materialId: 'civil-formwork', materialName: '模板', unit: 'm²', netQuantity: formworkQuantity, unitPrice: element.formworkRate }));
    if (element.rebarMode !== 'none')
        items.push(priceItem({ id: element.id + ':rebar', materialId: 'civil-rebar', materialName: element.rebarMode === 'ratio' ? '钢筋（指标估算）' : '钢筋（用户公斤数）', unit: 'kg', netQuantity: rebarQuantity, unitPrice: element.rebarPrice }));
    const formwork = items.find(item => item.materialId === 'civil-formwork'), rebar = items.find(item => item.materialId === 'civil-rebar');
    const additionalCost = formatMoney(element.additionalCost), pendingReasons = [...new Set(items.flatMap(item => item.pendingReasons))];
    const knownSubtotal = sum([...items.map(item => item.knownTotal), additionalCost]);
    const pending = Boolean(pendingReasons.length);
    return {
        id: element.id, name: element.name, kind: element.kind, surfaceType: 'civil', category: preset.category, color: preset.color,
        levelId: row.levelId, levelName: row.levelName, hidden: Boolean(element.hidden), locked: Boolean(element.locked),
        quantity: count, width: element.width, depth: element.depth, height: element.height, rotation: element.rotation, elevation: element.elevation,
        sourceRegionId: element.sourceRegionId, singleGrossVolume: measurement.grossVolume, singleNetVolume: measurement.netVolume,
        grossVolume: grossVolume === null ? null : Number(grossVolume), netVolume: volume === null ? null : Number(volume), volume,
        purchaseVolume: items[0].purchaseQuantity, footprintArea: footprintQuantity === null ? null : Number(footprintQuantity),
        formworkArea: formworkQuantity === null ? null : Number(formworkQuantity), rebarQuantity: rebarQuantity === null ? null : Number(rebarQuantity),
        overlapVolume: measurement.overlapVolume === null ? null : Number(quantity(measurement.overlapVolume, count)),
        unitPrice: element.unitPrice, wasteRate: element.wasteRate, laborRate: element.laborRate, formworkRate: element.formworkRate,
        rebarMode: element.rebarMode, rebarRatio: element.rebarRatio, rebarPrice: element.rebarPrice,
        materialCost: items[0].materialCost, laborCost: items[0].laborCost,
        formworkCost: formwork?.materialCost ?? (formwork?.pending ? null : '0.00'), rebarCost: rebar?.materialCost ?? (rebar?.pending ? null : '0.00'),
        knownMaterialCost: items[0].knownMaterialCost, knownLaborCost: items[0].knownLaborCost,
        knownFormworkCost: formwork?.knownMaterialCost ?? '0.00', knownRebarCost: rebar?.knownMaterialCost ?? '0.00',
        additionalCost, itemAdditionalCost: '0.00', items, warnings: [...measurement.warnings],
        pending, status: pending ? 'pending' : 'ready', pendingReasons, pendingReason: pendingReasons.join('；') || null,
        knownSubtotal, knownTotal: knownSubtotal, subtotal: pending ? null : knownSubtotal, total: pending ? null : knownSubtotal,
    };
}
/** Independent structural quote. Unassigned floor coverings or furniture
 * prices cannot block this budget. Both disciplines retain their own lines. */
export function calculateCivilProject(project) {
    if (!project || !Array.isArray(project.regions))
        throw new RangeError('土建项目数据格式不正确。');
    validateLevels(project);
    const rows = buildCivilQuantities(project).map(priceElement);
    const projectAdditionalCost = formatMoney(normalizeDecimal(project.additionalCost ?? '0', '工程固定费用'));
    const taxRate = normalizeDecimal(project.taxRate ?? '0', '税率');
    const sumField = (field, source = rows) => sum(source.map(row => row[field]));
    const sumQuantity = (field, source = rows) => source.some(row => row[field] === null) ? null : Number(source.reduce((total, row) => addDecimal(total, row[field]), '0'));
    const knownSubtotal = sum([sumField('knownSubtotal'), projectAdditionalCost]);
    const tax = formatMoney(multiplyDecimal(knownSubtotal, percent(taxRate)));
    const pendingReasons = [...new Set(rows.flatMap(row => row.pendingReasons.map(reason => project.levels ? `${row.levelName} / ${row.name}：${reason}` : `${row.name}：${reason}`)))];
    const pending = Boolean(pendingReasons.length), layers = levelProjects(project);
    return {
        kind: 'civil', projectId: project.id, name: project.name, currency: 'CNY', status: pending ? 'pending' : 'ready', pending,
        pendingReasons, pendingReason: pendingReasons.join('；') || null, warnings: [...new Set(rows.flatMap(row => row.warnings))],
        regions: [], walls: [], furniture: [], ceilings: [], serviceRoutes: [], civilElements: rows,
        netVolume: sumQuantity('volume'), grossVolume: sumQuantity('grossVolume'), footprintArea: sumQuantity('footprintArea'),
        formworkArea: sumQuantity('formworkArea'), rebarQuantity: sumQuantity('rebarQuantity'),
        knownMaterialCost: sumField('knownMaterialCost'), knownLaborCost: sumField('knownLaborCost'),
        knownFormworkCost: sumField('knownFormworkCost'), knownRebarCost: sumField('knownRebarCost'),
        materialCost: pending ? null : sumField('knownMaterialCost'), laborCost: pending ? null : sumField('knownLaborCost'),
        formworkCost: pending ? null : sumField('knownFormworkCost'), rebarCost: pending ? null : sumField('knownRebarCost'),
        knownCivilCost: sumField('knownSubtotal'), knownFurnitureCost: '0.00', knownServiceCost: '0.00', serviceLength: 0, servicePathLength: 0,
        additionalCost: sum([sumField('additionalCost'), projectAdditionalCost]), projectAdditionalCost,
        knownSubtotal, knownTotal: knownSubtotal, subtotal: pending ? null : knownSubtotal, beforeTax: pending ? null : knownSubtotal,
        taxRate, tax: pending ? null : tax, total: pending ? null : sum([knownSubtotal, tax]),
        levelSummaries: layers.map(layer => {
            const own = rows.filter(row => row.levelId === layer.id), layerPending = own.some(row => row.pending), layerSubtotal = sumField('knownSubtotal', own);
            return { id: layer.id, name: layer.name, elevation: layer.elevation, height: layer.height, slabThickness: layer.slabThickness,
                netVolume: sumQuantity('volume', own), footprintArea: sumQuantity('footprintArea', own), formworkArea: sumQuantity('formworkArea', own), rebarQuantity: sumQuantity('rebarQuantity', own),
                knownSubtotal: layerSubtotal, total: layerPending ? null : layerSubtotal, pending: layerPending,
                pendingReason: [...new Set(own.flatMap(row => row.pendingReasons))].join('；') || null };
        }),
    };
}
export function validateCivilProject(project) { calculateCivilProject(project); }
//# sourceMappingURL=civil-pricing.js.map