import { addDecimal, multiplyDecimal, normalizeDecimal, formatMoney } from './pricing.js';
export const COST_SECTIONS = ['土建', '装饰装修', '市政'];
export const COST_UNITS = ['m³', 'm²', 'm', 't', '吨', 'kg', '座', '套', '樘', '株', '项', '个', '件'];
const categories = ['分部分项', '措施项目', '其他项目', '规费税金'];
const validators = new Map();
export function registerCostValidator(id, validate) { validators.set(id, validate); }
export function createCostItem(input) {
    if (!input.id?.trim() || !input.name?.trim())
        throw new RangeError('清单编号和项目名称不能为空');
    if (!COST_SECTIONS.includes(input.section))
        throw new RangeError('清单专业不正确');
    if (!/^\d{12}$/.test(input.code))
        throw new RangeError('项目编码必须为 12 位数字');
    if (!COST_UNITS.includes(input.unit))
        throw new RangeError('计量单位不正确');
    const category = input.category ?? '分部分项';
    if (!categories.includes(category))
        throw new RangeError('清单类别不正确');
    const quantity = normalizeDecimal(input.quantity, '工程量');
    const unitPrice = normalizeDecimal(input.unitPrice, '综合单价');
    const priceStatus = input.priceStatus ?? (unitPrice === '0' ? 'missing' : 'reference');
    if (!['missing', 'reference', 'confirmed'].includes(priceStatus))
        throw new RangeError('单价确认状态不正确');
    if (input.source !== undefined && !['manual', 'generated'].includes(input.source))
        throw new RangeError('清单来源不正确');
    return { ...input, id: input.id, section: input.section, code: input.code, name: input.name,
        category, feature: input.feature ?? '', unit: input.unit, quantity, unitPrice,
        ...(input.wasteRate !== undefined ? { wasteRate: normalizeDecimal(input.wasteRate, '损耗率') } : {}),
        amount: formatMoney(multiplyDecimal(quantity, unitPrice)), estimate: Boolean(input.estimate),
        note: input.note ?? '', source: input.source ?? 'generated', priceStatus };
}
export function validateItems(items) {
    const errors = [], codes = new Set(), ids = new Set();
    if (!Array.isArray(items))
        return { ok: false, errors: ['清单数据必须为数组'] };
    for (const [index, item] of items.entries()) {
        try {
            const normalized = createCostItem(item);
            if (ids.has(normalized.id))
                errors.push(`第 ${index + 1} 行清单编号重复`);
            if (codes.has(normalized.code))
                errors.push(`第 ${index + 1} 行项目编码重复：${normalized.code}`);
            ids.add(normalized.id);
            codes.add(normalized.code);
            if (item.amount === undefined)
                errors.push(`第 ${index + 1} 行缺少合价`);
            else {
                const actual = BigInt(formatMoney(normalizeDecimal(item.amount, '合价')).replace('.', ''));
                const expected = BigInt(normalized.amount.replace('.', ''));
                const difference = actual > expected ? actual - expected : expected - actual;
                if (difference > 1n)
                    errors.push(`第 ${index + 1} 行合价与工程量 × 单价不一致`);
            }
        }
        catch (error) {
            errors.push(`第 ${index + 1} 行：${error.message}`);
        }
    }
    return { ok: !errors.length, errors };
}
export function summarize(items, { measureRate = '2.5', taxRate = '9', otherAmount = '0' } = {}) {
    const checked = validateItems(items);
    if (!checked.ok)
        throw new RangeError(checked.errors.join('；'));
    items = items.map(item => createCostItem(item));
    measureRate = normalizeDecimal(measureRate, '措施费率', { max: 100 });
    taxRate = normalizeDecimal(taxRate, '税率', { max: 100 });
    const bySection = { '土建': '0.00', '装饰装修': '0.00', '市政': '0.00' };
    const bySectionTotal = { ...bySection };
    const byCategory = { '分部分项': '0.00', '措施项目': '0.00', '其他项目': '0.00', '规费税金': '0.00' };
    for (const item of items) {
        const amount = item.amount;
        bySectionTotal[item.section] = formatMoney(addDecimal(bySectionTotal[item.section], amount));
        if (item.category === '分部分项')
            bySection[item.section] = formatMoney(addDecimal(bySection[item.section], amount));
        byCategory[item.category] = formatMoney(addDecimal(byCategory[item.category], amount));
    }
    const subtotal = byCategory['分部分项'];
    const rateMeasures = formatMoney(multiplyDecimal(subtotal, multiplyDecimal(measureRate, '.01')));
    const measures = formatMoney(addDecimal(byCategory['措施项目'], rateMeasures));
    const other = formatMoney(addDecimal(byCategory['其他项目'], normalizeDecimal(otherAmount, '其他项目费')));
    const fees = byCategory['规费税金'];
    const beforeTax = formatMoney(addDecimal(addDecimal(addDecimal(subtotal, measures), other), fees));
    const tax = formatMoney(multiplyDecimal(beforeTax, multiplyDecimal(taxRate, '.01')));
    return { bySection, bySectionTotal, byCategory, subtotal, measures, rateMeasures, other, fees,
        beforeTax, taxRate, measureRate, tax, total: formatMoney(addDecimal(beforeTax, tax)),
        estimateCount: items.filter(item => item.estimate).length,
        missingPriceCount: items.filter(item => item.priceStatus === 'missing' && item.quantity !== '0').length,
        referencePriceCount: items.filter(item => item.priceStatus === 'reference').length };
}
export function applyModulePrices(items, state = {}) {
    return items.map(item => Object.hasOwn(state.priceOverrides ?? {}, item.id)
        ? createCostItem({ ...item, unitPrice: state.priceOverrides[item.id], priceStatus: 'confirmed',
            note: item.note + '；综合单价由用户确认，原工程量依据保留' }) : createCostItem(item));
}
function finiteTree(value, depth = 0) {
    if (depth > 20)
        throw new RangeError('造价参数嵌套过深');
    if (typeof value === 'number' && !Number.isFinite(value))
        throw new RangeError('造价参数必须为有限数字');
    if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key))
                throw new RangeError('造价参数包含不安全字段');
            finiteTree(child, depth + 1);
        }
}
/** Optional cost data is checked by the existing project validation path. */
export function validateCostProject(cost) {
    if (cost === undefined)
        return;
    if (!cost || typeof cost !== 'object' || Array.isArray(cost))
        throw new RangeError('造价数据格式不正确');
    finiteTree(cost);
    if (cost.rates !== undefined) {
        if (!cost.rates || typeof cost.rates !== 'object' || Array.isArray(cost.rates))
            throw new RangeError('造价费率格式不正确');
        normalizeDecimal(cost.rates.measureRate, '措施费率', { max: 100 });
        normalizeDecimal(cost.rates.taxRate, '税率', { max: 100 });
    }
    if (cost.otherCost !== undefined)
        normalizeDecimal(cost.otherCost, '其他项目费');
    if (cost.manualItems !== undefined) {
        const check = validateItems(cost.manualItems);
        if (!check.ok)
            throw new RangeError(check.errors.join('；'));
    }
    if (cost.modules !== undefined && (!cost.modules || typeof cost.modules !== 'object' || Array.isArray(cost.modules)))
        throw new RangeError('专业造价数据格式不正确');
    for (const [id, state] of Object.entries(cost.modules ?? {})) {
        if (!['structure', 'finish', 'municipal'].includes(id) || !state || typeof state !== 'object' || Array.isArray(state))
            throw new RangeError('专业造价模块不正确');
        if (state.enabled !== undefined && typeof state.enabled !== 'boolean')
            throw new RangeError('专业启用状态不正确');
        if (state.modelGenerated !== undefined && typeof state.modelGenerated !== 'boolean')
            throw new RangeError('专业模型生成状态不正确');
        if (state.priceOverrides !== undefined && (!state.priceOverrides || typeof state.priceOverrides !== 'object' || Array.isArray(state.priceOverrides)))
            throw new RangeError('清单单价覆盖格式不正确');
        for (const price of Object.values(state.priceOverrides ?? {}))
            normalizeDecimal(price, '清单单价');
        if (state.items !== undefined) {
            const check = validateItems(state.items);
            if (!check.ok)
                throw new RangeError(check.errors.join('；'));
        }
        validators.get(id)?.(state);
    }
}
//# sourceMappingURL=cost.js.map