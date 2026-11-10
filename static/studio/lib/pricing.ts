import { validateCostProject } from './cost.js';
import { regionMetrics } from './geometry.js';
import { buildWallSolid } from './wall-solid.js';
import { validateFurniture } from './furniture.js';
import { serviceMetrics, servicePreset, validateServiceRoutes } from './services.js';
import { validateWallShapes, wallShapeMeasurementProject, shapeWallMetrics } from './wall-shapes.js';
import { validateLevels, levelProjects, effectiveLevelProject } from './levels.js';
import { calculateOpeningQuote } from './opening-pricing.js';
import { sourcePriceMetadata } from './price-provenance.js';
// Keep decimal input as an integer coefficient and decimal scale. Quantities,
// rates and percentages stay exact until each monetary component is rounded.
const pow10 = (scale) => 10n ** BigInt(scale);
const ZERO = Object.freeze({ coefficient: 0n, scale: 0 });
function compact(decimal) {
    let { coefficient, scale } = decimal;
    if (coefficient === 0n)
        return ZERO;
    while (scale > 0 && coefficient % 10n === 0n) {
        coefficient /= 10n;
        scale -= 1;
    }
    return { coefficient, scale };
}
function decimal(value, label = '数值') {
    if (typeof value === 'number' && !Number.isFinite(value))
        throw new RangeError(`${label}必须是有限数字`);
    if (!['number', 'string', 'bigint'].includes(typeof value))
        throw new TypeError(`${label}必须是有效数字`);
    const text = String(value).trim();
    if (!text || text.length > 72)
        throw new RangeError(`${label}必须是有效数字`);
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match)
        throw new RangeError(`${label}必须是有效数字`);
    const whole = match[2] || '0';
    const fraction = match[3] ?? match[4] ?? '';
    const exponent = Number(match[5] || 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 30 || whole.length + fraction.length > 48) {
        throw new RangeError(`${label}超出可用范围`);
    }
    let coefficient = BigInt(whole + fraction) * (match[1] === '-' ? -1n : 1n);
    let scale = fraction.length - exponent;
    if (scale < 0) {
        coefficient *= pow10(-scale);
        scale = 0;
    }
    if (scale > 48 || (coefficient < 0n ? -coefficient : coefficient).toString().length > 48) {
        throw new RangeError(`${label}超出可用范围`);
    }
    return compact({ coefficient, scale });
}
function add(left, right) {
    const scale = Math.max(left.scale, right.scale);
    return compact({ coefficient: left.coefficient * pow10(scale - left.scale)
            + right.coefficient * pow10(scale - right.scale), scale });
}
function multiply(left, right) {
    return compact({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}
function divide100(value) {
    return compact({ coefficient: value.coefficient, scale: value.scale + 2 });
}
function compare(left, right) {
    const scale = Math.max(left.scale, right.scale);
    const difference = left.coefficient * pow10(scale - left.scale) - right.coefficient * pow10(scale - right.scale);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function plain(value) {
    const normalized = compact(value);
    const sign = normalized.coefficient < 0n ? '-' : '';
    const digits = (normalized.coefficient < 0n ? -normalized.coefficient : normalized.coefficient).toString();
    if (!normalized.scale)
        return sign + digits;
    const padded = digits.padStart(normalized.scale + 1, '0');
    return `${sign}${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
}
function roundInteger(coefficient: bigint, divisor: bigint): bigint {
    const negative = coefficient < 0n;
    const absolute = negative ? -coefficient : coefficient;
    const rounded = absolute / divisor + (absolute % divisor * 2n >= divisor ? 1n : 0n);
    return negative ? -rounded : rounded;
}
function cents(value) {
    return value.scale <= 2
        ? value.coefficient * pow10(2 - value.scale)
        : roundInteger(value.coefficient, pow10(value.scale - 2));
}
function money(amount) {
    const negative = amount < 0n;
    const digits = (negative ? -amount : amount).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function nonnegative(value, label) {
    const parsed = decimal(value, label);
    if (parsed.coefficient < 0n)
        throw new RangeError(`${label}不能小于零`);
    return parsed;
}
export function normalizeDecimal(value, label = '数值', { min = 0, max = null } = {}) {
    const parsed = decimal(value, label);
    if (min !== null && compare(parsed, decimal(min)) < 0)
        throw new RangeError(`${label}不能小于 ${min}`);
    if (max !== null && compare(parsed, decimal(max)) > 0)
        throw new RangeError(`${label}不能大于 ${max}`);
    return plain(parsed);
}
export function formatMoney(value) {
    return money(cents(decimal(value, '金额')));
}
export function formatQuantity(value, places = 6) {
    if (!Number.isInteger(places) || places < 0 || places > 12)
        throw new RangeError('用量小数位应在 0 到 12 之间');
    const parsed = decimal(value, '用量');
    const coefficient = parsed.scale <= places
        ? parsed.coefficient * pow10(places - parsed.scale)
        : roundInteger(parsed.coefficient, pow10(parsed.scale - places));
    return plain({ coefficient, scale: places });
}
function calculateItem(item, metrics) {
    const mode = item.quantityMode ?? 'area';
    if (!['area', 'perimeter', 'manual'].includes(mode))
        throw new RangeError('计量方式应是面积、周长或手工数量');
    const unit = item.unit ?? (mode === 'area' ? 'm²' : mode === 'perimeter' ? 'm' : '件');
    const unitMismatch = (mode === 'area' && unit !== 'm²') || (mode === 'perimeter' && unit !== 'm');
    const missingPrice = typeof item.unitPrice === 'string' && item.unitPrice.trim() === '';
    const price = nonnegative(missingPrice ? '0' : item.unitPrice ?? '0', '材料单价');
    const labor = nonnegative(item.laborRate ?? '0', '人工单价');
    const waste = nonnegative(item.wasteRate ?? '0', '损耗率');
    const additional = cents(nonnegative(item.additionalCost ?? '0', '项目附加费'));
    const rawQuantity = mode === 'area' ? metrics.netArea : mode === 'perimeter' ? metrics.perimeter : (item.quantity ?? '0');
    const unavailable = rawQuantity === null || rawQuantity === undefined;
    const parsedQuantity = unavailable ? null : mode === 'manual' ? decimal(rawQuantity, '手工数量') : nonnegative(rawQuantity, '净用量');
    const needsQuantity = mode === 'manual' && parsedQuantity?.coefficient <= 0n;
    const quantityPending = unitMismatch || unavailable || needsQuantity;
    const pending = quantityPending || missingPrice;
    const quantityReason = unitMismatch ? '材料单位与数量依据不匹配，请重新选择数量依据'
        : unavailable ? '图纸尚未校准，无法计算实际用量' : needsQuantity ? '请填写大于零的手工数量' : null;
    const result = {
        id: item.id, materialId: item.materialId, materialName: item.materialName ?? '', demo: item.demo,
        ...sourcePriceMetadata(item),
        unit,
        quantityMode: mode, unitPrice: missingPrice ? '' : plain(price), wasteRate: plain(waste), laborRate: plain(labor),
        additionalCost: money(additional), pending, status: pending ? 'pending' : 'ready',
        pendingReason: [quantityReason, missingPrice ? '材料尚未填写单价' : null].filter(Boolean).join('；') || null,
        quantity: null, netQuantity: null, purchaseQuantity: null, materialCost: null, laborCost: null, total: null,
        knownMaterialCost: '0.00', knownLaborCost: '0.00', knownTotal: money(additional),
    };
    if (quantityPending)
        return { result, material: 0n, labor: 0n, additional, knownTotal: additional };
    const quantity = parsedQuantity;
    const purchase = divide100(multiply(quantity, add(decimal(100), waste)));
    const materialCost = cents(multiply(purchase, price));
    const laborCost = cents(multiply(quantity, labor));
    const total = materialCost + laborCost + additional;
    Object.assign(result, {
        quantity: plain(quantity), netQuantity: plain(quantity), purchaseQuantity: plain(purchase),
        materialCost: missingPrice ? null : money(materialCost), laborCost: money(laborCost), total: missingPrice ? null : money(total),
        knownMaterialCost: money(materialCost), knownLaborCost: money(laborCost), knownTotal: money(total),
    });
    return { result, material: materialCost, labor: laborCost, additional, knownTotal: total };
}
function regionResult(region, calibration, metricsFunction) {
    const metrics = metricsFunction(region, calibration) ?? { netArea: null, perimeter: null };
    if (metrics.netArea !== null && metrics.netArea !== undefined)
        nonnegative(metrics.netArea, '区域净面积');
    if (metrics.perimeter !== null && metrics.perimeter !== undefined)
        nonnegative(metrics.perimeter, '区域周长');
    const calculated = (region.items ?? []).map((item) => calculateItem(item, metrics));
    const needsMaterial = calculated.length === 0 && (region.points?.length ?? 0) > 0;
    const pending = needsMaterial || calculated.some((item) => item.result.pending);
    const pendingReasons = [...new Set([
            ...(needsMaterial ? ['区域尚未选择材料'] : []),
            ...calculated.filter((item) => item.result.pending).map((item) => item.result.pendingReason),
        ])];
    const sum = (key) => calculated.reduce((total, item) => total + item[key], 0n);
    const material = sum('material');
    const labor = sum('labor');
    const itemAdditional = sum('additional');
    const additional = cents(nonnegative(region.additionalCost ?? '0', '区域附加费'));
    const known = sum('knownTotal') + additional;
    return {
        result: {
            id: region.id, name: region.name ?? '', hidden: Boolean(region.hidden),
            netArea: metrics.netArea ?? null, perimeter: metrics.perimeter ?? null,
            items: calculated.map((item) => item.result), pending, status: pending ? 'pending' : 'ready',
            pendingReasons, pendingReason: pendingReasons.join('；') || null,
            materialCost: pending ? null : money(material), laborCost: pending ? null : money(labor),
            knownMaterialCost: money(material), knownLaborCost: money(labor),
            itemAdditionalCost: money(itemAdditional), additionalCost: money(additional),
            subtotal: pending ? null : money(known), total: pending ? null : money(known), knownSubtotal: money(known),
        },
        pending, material, labor, additional: additional + itemAdditional, known,
    };
}
export function calculateRegion(region, calibration, { metrics = regionMetrics } = {}) {
    return regionResult(region, calibration, metrics).result;
}
function calculateSingleProject(project, { metrics = regionMetrics } = {}) {
    if (!project || !Array.isArray(project.regions))
        throw new TypeError('工程区域数据不正确');
    validateCostProject(project.cost);
    validateFurniture(project.furniture);
    validateServiceRoutes(project.serviceRoutes);
    validateWallShapes(project);
    const regions = project.regions.map((region) => regionResult(region, project.calibration, metrics));
    const wallSolid = project.walls?.length || project.openings?.length ? buildWallSolid(wallShapeMeasurementProject(project)) : {metrics:[],surfaces:[]};
    const wallMetrics = wallSolid.metrics;
    const walls = wallMetrics.map((measurement, index) => {
        const wall = project.walls.find(value => value.id === measurement.id);
        const priced = regionResult({ ...wall, name: wall.name || `墙体 ${String(index + 1).padStart(2, '0')}`, points: [], items: wall.items ?? [] }, null, () => measurement);
        Object.assign(priced.result, measurement, { surfaceType: 'wall' });
        return priced;
    });
    for (const shape of project.wallShapes??[]) {
        const measurement = shapeWallMetrics(shape,wallSolid);
        const priced = regionResult({...shape,points:[],items:shape.items??[]},null,()=>measurement);
        Object.assign(priced.result,measurement,{surfaceType:'wall',shapeKind:shape.kind,wallIds:[...shape.wallIds],radius:shape.radius,startDegrees:shape.startDegrees,sweepDegrees:shape.sweepDegrees,maxDeviation:shape.maxDeviation});
        walls.push(priced);
    }
    const furniture = (project.furniture ?? []).map((item) => {
        const missingPrice = item.unitPrice === '';
        const priced = regionResult({ id: item.id, name: item.name, hidden: item.hidden, points: [], additionalCost: '0', items: [{ id: item.id, materialId: item.id, materialName: item.name, unit: '件', quantityMode: 'manual', quantity: item.quantity, unitPrice: missingPrice ? '0' : item.unitPrice, wasteRate: '0', laborRate: '0', additionalCost: item.additionalCost, ...sourcePriceMetadata(item) }] }, null, () => ({ netArea: null, perimeter: null }));
        if (missingPrice) {
            priced.pending = true;
            priced.result.pending = true;
            priced.result.status = 'pending';
            priced.result.pendingReasons = ['家具尚未填写单价'];
            priced.result.pendingReason = '家具尚未填写单价';
            priced.result.subtotal = priced.result.total = priced.result.materialCost = priced.result.laborCost = null;
            Object.assign(priced.result.items[0], { pending: true, status: 'pending', pendingReason: '家具尚未填写单价', total: null, materialCost: null, unitPrice: '' });
        }
        Object.assign(priced.result, { surfaceType: 'furniture', kind: item.kind, quantity: item.quantity, unitPrice: item.unitPrice });
        return priced;
    });
    const serviceRoutes = (project.serviceRoutes ?? []).map((route) => {
        const measurement = serviceMetrics(route, project), preset = servicePreset(route.presetId);
        // Geometry necessarily starts as a measured double. User-entered
        // allowances, run counts, prices and percentages remain exact decimals.
        const netQuantity = measurement.pathLength === null ? null
            : plain(multiply(add(decimal(measurement.pathLength), decimal(route.extraLength)), decimal(route.runs)));
        const missingPrice = route.unitPrice === '';
        const priced = regionResult({ id: route.id, name: route.name, hidden: route.hidden, points: [], additionalCost: route.additionalCost,
            items: [{ id: route.id, materialId: route.presetId, materialName: route.name, unit: 'm', quantityMode: 'perimeter',
                unitPrice: missingPrice ? '0' : route.unitPrice, wasteRate: route.wasteRate, laborRate: route.laborRate, additionalCost: '0', ...sourcePriceMetadata(route) }] },
            null, () => ({ netArea: null, perimeter: netQuantity }));
        if (missingPrice) {
            const reasons = [...priced.result.pendingReasons, '管线尚未填写单价'];
            priced.pending = true;
            Object.assign(priced.result, { pending: true, status: 'pending', pendingReasons: reasons, pendingReason: reasons.join('；'),
                subtotal: null, total: null, materialCost: null });
            Object.assign(priced.result.items[0], { pending: true, status: 'pending', pendingReason: reasons.join('；'),
                total: null, materialCost: null, unitPrice: '' });
        }
        Object.assign(priced.result, { surfaceType: 'service', presetId: route.presetId, system: preset.system,
            color: preset.color, spec: route.spec, diameter: route.diameter, unit: 'm',
            pathLength: measurement.pathLength, netQuantity: priced.result.items[0].netQuantity,
            purchaseQuantity: priced.result.items[0].purchaseQuantity, runs: route.runs, extraLength: route.extraLength,
            unitPrice: route.unitPrice, wasteRate: route.wasteRate, laborRate: route.laborRate });
        return priced;
    });
    const ceilings = [];
    for (const region of project.regions) {
        const ceiling = region.ceiling;
        if (!ceiling) continue;
        // Validate financial input even on a temporarily hidden/disabled surface.
        const priced = regionResult({ id: `ceiling:${region.id}`, name: `${region.name || '房间'} · 天花板`, points: [], items: ceiling.items ?? [], additionalCost: ceiling.additionalCost ?? '0' }, project.calibration, () => metrics(region, project.calibration));
        if (ceiling.enabled) { Object.assign(priced.result, { surfaceType: 'ceiling', regionId: region.id, sourceRegionId: region.id }); ceilings.push(priced); }
    }
    const openings = (project.openings ?? []).map(calculateOpeningQuote).filter(Boolean).map(result => ({ result, pending: result.pending,
        material: cents(decimal(result.knownMaterialCost)), labor: cents(decimal(result.knownLaborCost)),
        additional: cents(decimal(result.additionalCost)), known: cents(decimal(result.knownSubtotal)) }));
    const entries = [...regions, ...walls, ...furniture, ...ceilings, ...serviceRoutes, ...openings];
    const serviceQuantity = key => serviceRoutes.some(route => route.result[key] === null) ? null
        : Number(plain(serviceRoutes.reduce((total, route) => add(total, decimal(route.result[key])), ZERO)));
    const planError = typeof project.planError === 'string' ? project.planError.trim() : project.planError ? '墙体房间尚未完成，请检查墙线后再生成报价' : null;
    const pending = Boolean(planError) || entries.some((region) => region.pending);
    const sum = (key) => entries.reduce((total, region) => total + region[key], 0n);
    const projectAdditional = cents(nonnegative(project.additionalCost ?? '0', '工程附加费'));
    const taxRate = nonnegative(project.taxRate ?? '0', '税率');
    const known = sum('known') + projectAdditional;
    const tax = cents(divide100(multiply({ coefficient: known, scale: 2 }, taxRate)));
    const pendingReasons = [...new Set([...(planError ? [planError] : []), ...entries.flatMap((region) => region.result.pendingReasons)])];
    return {
        projectId: project.id, name: project.name ?? '', currency: 'CNY',
        status: pending ? 'pending' : 'ready', pending,
        pendingReasons, pendingReason: pendingReasons.join('；') || null,
        regions: regions.map((region) => region.result),
        walls: walls.map((wall) => wall.result),
        furniture: furniture.map((item) => item.result),
        ceilings: ceilings.map((item) => item.result),
        serviceRoutes: serviceRoutes.map((route) => route.result),
        openings: openings.map((opening) => opening.result),
        serviceLength: serviceQuantity('netQuantity'), servicePathLength: serviceQuantity('pathLength'),
        knownFurnitureCost: money(furniture.reduce((total, item) => total + item.known, 0n)),
        knownServiceCost: money(serviceRoutes.reduce((total, route) => total + route.known, 0n)),
        knownOpeningCost: money(openings.reduce((total, opening) => total + opening.known, 0n)),
        materialCost: pending ? null : money(sum('material')),
        laborCost: pending ? null : money(sum('labor')),
        knownMaterialCost: money(sum('material')), knownLaborCost: money(sum('labor')),
        additionalCost: money(sum('additional') + projectAdditional), projectAdditionalCost: money(projectAdditional),
        subtotal: pending ? null : money(known), beforeTax: pending ? null : money(known),
        knownSubtotal: money(known), taxRate: plain(taxRate),
        tax: pending ? null : money(tax), total: pending ? null : money(known + tax),
    };
}

/** All storeys share one decimal-money total. Storey results carry no project
 * fixed fee or tax; these are applied once after their rounded line components. */
export function calculateProject(project, { metrics = regionMetrics } = {}) {
    if (!project || !Array.isArray(project.regions)) throw new TypeError('工程区域数据不正确');
    validateLevels(project);
    if (!project.levels) return calculateSingleProject(effectiveLevelProject(project), { metrics });
    validateCostProject(project.cost);
    const layers = levelProjects(project).map(layer => ({ ...layer, quote: calculateSingleProject({ ...effectiveLevelProject(layer.project), additionalCost: '0', taxRate: '0', cost: undefined }, { metrics }) }));
    const sum = key => layers.reduce((total, layer) => total + cents(decimal(layer.quote[key], '楼层金额')), 0n);
    const projectAdditional = cents(nonnegative(project.additionalCost ?? '0', '工程附加费'));
    const taxRate = nonnegative(project.taxRate ?? '0', '税率');
    const known = sum('knownSubtotal') + projectAdditional;
    const tax = cents(divide100(multiply({ coefficient: known, scale: 2 }, taxRate)));
    const pending = layers.some(layer => layer.quote.pending);
    const pendingReasons = [...new Set(layers.flatMap(layer => layer.quote.pendingReasons.map(reason => `${layer.name}：${reason}`)))];
    const rows = key => layers.flatMap(layer => layer.quote[key].map(row => ({ ...row, levelId: layer.id, levelName: layer.name })));
    const serviceQuantity = key => layers.some(layer => layer.quote[key] === null) ? null
        : Number(plain(layers.reduce((total, layer) => add(total, decimal(layer.quote[key])), ZERO)));
    return {
        projectId: project.id, name: project.name ?? '', currency: 'CNY', status: pending ? 'pending' : 'ready', pending,
        pendingReasons, pendingReason: pendingReasons.join('；') || null,
        regions: rows('regions'), walls: rows('walls'), furniture: rows('furniture'), ceilings: rows('ceilings'), serviceRoutes: rows('serviceRoutes'), openings: rows('openings'),
        serviceLength: serviceQuantity('serviceLength'), servicePathLength: serviceQuantity('servicePathLength'),
        levelSummaries: layers.map(layer => ({ id: layer.id, name: layer.name, elevation: layer.elevation, height: layer.height, slabThickness: layer.slabThickness,
            netArea: layer.quote.regions.reduce((sum, region) => sum + (region.netArea ?? 0), 0),
            serviceLength: layer.quote.serviceLength, servicePathLength: layer.quote.servicePathLength, knownServiceCost: layer.quote.knownServiceCost,
            materialCost: layer.quote.materialCost, laborCost: layer.quote.laborCost, additionalCost: layer.quote.additionalCost,
            knownSubtotal: layer.quote.knownSubtotal, subtotal: layer.quote.subtotal, total: layer.quote.total, pending: layer.quote.pending, pendingReason: layer.quote.pendingReason })),
        knownFurnitureCost: money(sum('knownFurnitureCost')),
        knownServiceCost: money(sum('knownServiceCost')),
        knownOpeningCost: money(sum('knownOpeningCost')),
        materialCost: pending ? null : money(sum('knownMaterialCost')), laborCost: pending ? null : money(sum('knownLaborCost')),
        knownMaterialCost: money(sum('knownMaterialCost')), knownLaborCost: money(sum('knownLaborCost')),
        additionalCost: money(sum('additionalCost') + projectAdditional), projectAdditionalCost: money(projectAdditional),
        subtotal: pending ? null : money(known), beforeTax: pending ? null : money(known), knownSubtotal: money(known),
        taxRate: plain(taxRate), tax: pending ? null : money(tax), total: pending ? null : money(known + tax),
    };
}
export function multiplyDecimal(a, b) { return plain(multiply(decimal(a), decimal(b))); }
export function addDecimal(a, b) { return plain(add(decimal(a), decimal(b))); }
