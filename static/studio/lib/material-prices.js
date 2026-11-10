import { normalizeMaterial, newId } from './materials.js';
import { normalizeDecimal } from './pricing.js';
// Source prices retain their actual unit. This module never converts a bulk
// material quotation into a surface price or estimates missing market data.
const unitAliases = new Map([
    ['㎡', 'm²'], ['m2', 'm²'], ['m²', 'm²'], ['平方米', 'm²'], ['平方', 'm²'],
    ['m', 'm'], ['米', 'm'], ['延米', 'm'], ['件', '件'], ['个', '件'],
    ['kg', 'kg'], ['千克', 'kg'], ['公斤', 'kg'], ['吨', '吨'], ['t', '吨'],
    ['m³', 'm³'], ['m3', 'm³'], ['立方米', 'm³'], ['方', 'm³'],
]);
const text = value => String(value ?? '').trim();
export function normalizePriceUnit(value) {
    const raw = text(value).replace(/\s/g, '');
    return unitAliases.get(raw.toLowerCase()) || null;
}
function dateValue(value) {
    const raw = text(value);
    if (!raw)
        return '';
    const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw);
    if (!match)
        throw new RangeError('报价日期应为 YYYY-MM-DD');
    const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    const date = new Date(normalized + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized)
        throw new RangeError('报价日期无效');
    return normalized;
}
function sourceURL(value) {
    const raw = text(value);
    if (!raw)
        return '';
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new RangeError('来源地址应为 http(s) 网页');
    return parsed.href;
}
export function normalizePriceRows(rows, context = {}) {
    if (!Array.isArray(rows))
        throw new TypeError('报价数据必须是列表');
    if (rows.length > 5000)
        throw new RangeError('每次最多导入 5000 条材料报价');
    const candidates = [], errors = [];
    for (const [index, raw] of rows.entries()) {
        try {
            const name = text(raw?.name);
            if (!name)
                throw new RangeError('材料名称不能为空');
            const originalUnit = text(raw.unit || context.unit);
            const unit = normalizePriceUnit(originalUnit);
            const price = normalizeDecimal(text(raw.price ?? raw.unitPrice).replace(/[,，]/g, ''), '报价单价');
            const spec = text(raw.spec), region = text(raw.region_provided === false ? context.region : raw.region || context.region) || '未注明地区';
            const source = text(raw.source_provided === false ? context.source : raw.source || context.source) || '用户导入报价';
            candidates.push({
                id: String(index), name, spec, unit: unit || originalUnit, originalUnit, unitPrice: price,
                supported: Boolean(unit), region, priceDate: dateValue(raw.date_provided === false ? context.priceDate : raw.price_date || raw.priceDate || context.priceDate),
                source, sourceUrl: sourceURL(raw.sourceUrl || raw.source_url || context.sourceUrl),
                supplier: text(raw.supplier), category: text(raw.category),
                ...(context.refresh ? { refresh: structuredClone(context.refresh) } : {}),
                note: text(raw.note), error: unit ? null : originalUnit ? `暂不支持单位「${originalUnit}」` : '缺少计价单位，请补充后导入',
            });
        }
        catch (error) {
            errors.push(`第 ${index + 1} 条：${error.message}`);
        }
    }
    return { candidates, errors };
}
const fieldAliases = {
    name: ['名称', '材料名称', '产品名称', '品名', 'name'], spec: ['规格', '规格型号', '型号', 'spec'],
    unit: ['单位', '计价单位', 'unit'], price: ['价格', '单价', '市场价', '含税价', '信息价', '报价', 'unitPrice', 'price'],
    region: ['地区', '城市', '省市', 'region'], price_date: ['日期', '价格日期', '报价日期', '时间', 'price_date', 'priceDate'],
    source: ['来源', '数据来源', 'source'], supplier: ['供应商', '厂家', '品牌', 'supplier'], category: ['分类', '类别', 'category'],
};
function splitDelimited(input, delimiter) {
    const rows = [], row = [];
    let cell = '', quoted = false;
    for (let i = 0; i < input.length; i++) {
        const character = input[i];
        if (character === '"') {
            if (quoted && input[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (!quoted && character === delimiter) {
            row.push(cell);
            cell = '';
        }
        else if (!quoted && (character === '\n' || character === '\r')) {
            if (character === '\r' && input[i + 1] === '\n')
                i++;
            row.push(cell);
            if (row.some(value => value.trim()))
                rows.push([...row]);
            row.length = 0;
            cell = '';
        }
        else
            cell += character;
    }
    if (quoted)
        throw new RangeError('引号未闭合，请粘贴完整表格');
    row.push(cell);
    if (row.some(value => value.trim()))
        rows.push([...row]);
    return rows;
}
export function parsePriceText(input) {
    const raw = text(input).replace(/^\uFEFF/, '');
    if (!raw)
        throw new RangeError('请先粘贴报价表格');
    if (raw.length > 2_000_000)
        throw new RangeError('粘贴内容不能超过 2 MB');
    const lines = splitDelimited(raw, raw.includes('\t') ? '\t' : ',');
    const headers = lines[0].map(text), mapping = {};
    for (const [field, aliases] of Object.entries(fieldAliases)) {
        const index = headers.findIndex(header => aliases.some(alias => header.toLowerCase() === alias.toLowerCase()));
        if (index >= 0)
            mapping[field] = index;
    }
    if (mapping.name === undefined || mapping.price === undefined || mapping.unit === undefined)
        throw new RangeError('首行需包含「名称、单位、单价」，可从网页或 Excel 直接复制');
    return lines.slice(1).map(values => Object.fromEntries(Object.entries(mapping).map(([field, index]) => [field, text(values[index])])));
}
export function findPriceTarget(materials, candidate) {
    const targets = materials.filter(material => {
        const provenance = material.provenance;
        return provenance && provenance.materialName === candidate.name && text(provenance.spec) === text(candidate.spec)
            && provenance.region === candidate.region && material.unit === candidate.unit
            && text(provenance.source) === text(candidate.source) && text(provenance.supplier) === text(candidate.supplier);
    });
    return targets.length === 1 ? targets[0].id : null;
}
export function applyPriceRows(materials, candidates, selections, updatedAt = new Date().toISOString()) {
    if (!Array.isArray(materials) || !Array.isArray(candidates) || !Array.isArray(selections))
        throw new TypeError('材料报价选择无效');
    if (!selections.length)
        throw new RangeError('请至少选择一条报价');
    const next = materials.map(material => ({ ...material })), usedTargets = new Set(), usedRows = new Set();
    for (const selection of selections) {
        const candidate = candidates.find(row => row.id === String(selection.id));
        if (!candidate || !candidate.supported)
            throw new RangeError('选择的报价单位暂不支持');
        if (usedRows.has(candidate.id))
            throw new RangeError('同一条报价不能重复导入');
        usedRows.add(candidate.id);
        const targetId = selection.targetId || null;
        const existing = targetId ? next.find(material => material.id === targetId) : null;
        if (targetId && !existing)
            throw new RangeError('要更新的材料不存在');
        if (existing && existing.unit !== candidate.unit)
            throw new RangeError('报价单位与目标材料不一致，不能直接换算');
        if (targetId && usedTargets.has(targetId))
            throw new RangeError('同一材料只能选择一条来源报价，请核对地区和日期');
        if (targetId)
            usedTargets.add(targetId);
        const material = normalizeMaterial({
            ...(existing || {}), id: existing?.id || newId('market'),
            name: existing?.name || (candidate.spec ? `${candidate.name} · ${candidate.spec}` : candidate.name),
            category: existing?.category || candidate.category || '市场材料', unit: candidate.unit,
            unitPrice: candidate.unitPrice, wasteRate: existing?.wasteRate || '0', image: existing?.image || '',
            color: existing?.color || '#92a79c', demo: false,
            description: existing?.description || [candidate.spec, candidate.note].filter(Boolean).join('；'),
            provenance: { source: candidate.source, sourceUrl: candidate.sourceUrl, region: candidate.region,
                priceDate: candidate.priceDate, spec: candidate.spec, materialName: candidate.name,
                supplier: candidate.supplier, originalUnit: candidate.originalUnit, updatedAt,
                ...(candidate.refresh ? { refresh: structuredClone(candidate.refresh) } : {}) },
        });
        if (existing)
            next[next.findIndex(row => row.id === existing.id)] = material;
        else
            next.push(material);
    }
    return next;
}
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map
//# sourceMappingURL=material-prices.js.map