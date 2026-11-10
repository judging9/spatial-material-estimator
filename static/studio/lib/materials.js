import { normalizeDecimal } from './pricing.js';
import { normalizePriceProvenance } from './price-provenance.js';
const STORAGE_KEY = 'plan-material-studio.materials.v1';
const svgImage = (content, background) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="${background}"/>${content}</svg>`)}`;
const wood = svgImage('<path d="M0 40H240M0 80H240M0 120H240M80 0V40M160 40V80M60 80V120M150 120V160" stroke="#76543c" stroke-width="3"/><path d="M8 20Q50 12 78 23T155 18T233 25M3 63Q62 52 112 64T240 60M4 101Q77 95 130 105T239 98M6 143Q65 132 135 145T238 139" fill="none" stroke="#cfa97c" stroke-width="2"/>', '#a87851');
const tile = svgImage('<path d="M0 0H240V160H0Z M0 80H240M80 0V160M160 0V160" fill="none" stroke="#c3c0b8" stroke-width="5"/><path d="M6 7H73V72H6Z M86 87H153V152H86Z M166 7H233V72H166Z" fill="#f3f0e9" opacity=".6"/>', '#e2dfd7');
const stone = svgImage('<path d="M-10 20L70 55L103 43L166 75L250 91M0 84L53 112L105 98L168 137L240 151M45 -5L91 24L135 18L188 55L245 61" fill="none" stroke="#a5a7a5" stroke-width="3"/><path d="M-10 22L65 60L96 50L157 81L245 95M5 85L60 115L104 100L170 139" fill="none" stroke="#fff" stroke-width="2"/>', '#d1d2cf');
const carpet = svgImage('<defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M1 2L4 5M6 7L9 9" stroke="#898985" stroke-width="2"/><circle cx="8" cy="2" r="1" fill="#c7c4bd"/></pattern></defs><rect width="240" height="160" fill="url(#p)"/>', '#aaa9a3');
export const DEMO_MATERIALS = Object.freeze([
    Object.freeze({ id: 'demo-wood', name: '木地板', category: '地面', image: wood, unit: 'm²', unitPrice: '120.00', wasteRate: '5', color: '#a87851', description: '示例材料与演示价格，请按实际品牌、规格和当地报价修改。', demo: true }),
    Object.freeze({ id: 'demo-tile', name: '瓷砖', category: '地面', image: tile, unit: 'm²', unitPrice: '85.00', wasteRate: '8', color: '#d0cbc0', description: '示例瓷砖示意图，价格仅供演示，不作为市场信息价。', demo: true }),
    Object.freeze({ id: 'demo-stone', name: '石材', category: '地面', image: stone, unit: 'm²', unitPrice: '260.00', wasteRate: '10', color: '#b9bcb9', description: '示例石材示意图，请核对真实材料、损耗与施工单价。', demo: true }),
    Object.freeze({ id: 'demo-carpet', name: '地毯', category: '软装', image: carpet, unit: 'm²', unitPrice: '95.00', wasteRate: '5', color: '#aaa9a3', description: '示例地毯与演示价格，可替换为自己的产品图和报价。', demo: true }),
]);
export function newId(prefix = 'material') {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
export function normalizeMaterial(material) {
    if (!material || typeof material !== 'object')
        throw new TypeError('材料数据格式不正确');
    const name = String(material.name ?? '').trim();
    if (!name)
        throw new RangeError('材料名称不能为空');
    const unit = material.unit ?? 'm²';
    if (!['m²', 'm', '件', 'kg', '吨', 'm³'].includes(unit))
        throw new RangeError('材料单位应是 m²、m、件、kg、吨或 m³');
    const color = /^#[0-9a-f]{6}$/i.test(material.color ?? '') ? material.color : '#a87851';
    return {
        ...material, id: material.id ?? newId(), name, category: String(material.category ?? '').trim(),
        image: String(material.image ?? ''), unit,
        unitPrice: normalizeDecimal(material.unitPrice ?? '0', '材料单价'),
        wasteRate: normalizeDecimal(material.wasteRate ?? '0', '损耗率'),
        color, description: String(material.description ?? ''), demo: Boolean(material.demo),
        ...(material.provenance ? { provenance: normalizePriceProvenance(material.provenance) } : {}),
    };
}
export function createMaterialSnapshot(material, overrides = {}) {
    const normalized = normalizeMaterial(material);
    const mode = normalized.unit === 'm²' ? 'area' : normalized.unit === 'm' ? 'perimeter' : 'manual';
    return {
        id: newId('item'), materialId: normalized.id,
        materialName: normalized.name, unit: normalized.unit, image: normalized.image,
        color: normalized.color, demo: normalized.demo,
        unitPrice: normalized.unitPrice, priceSourceUnitPrice: normalized.unitPrice, wasteRate: normalized.wasteRate,
        ...(normalized.provenance ? { provenance: { ...normalized.provenance } } : {}),
        laborRate: '0', additionalCost: '0', quantityMode: mode, quantity: '0',
        ...overrides,
    };
}
export function refreshMaterialSnapshot(item, material) {
    const normalized = normalizeMaterial(material);
    if (String(item.materialId) !== String(normalized.id))
        throw new RangeError('材料编号不匹配');
    return { ...item, materialName: normalized.name, unit: normalized.unit, image: normalized.image,
        color: normalized.color, demo: normalized.demo, unitPrice: normalized.unitPrice, wasteRate: normalized.wasteRate,
        ...(normalized.provenance ? { provenance: { ...normalized.provenance } } : {}) };
}
export function loadMaterials(storage = globalThis.localStorage) {
    if (!storage)
        return DEMO_MATERIALS.map((material) => ({ ...material }));
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null)
        return DEMO_MATERIALS.map((material) => ({ ...material }));
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new RangeError('本地材料库无法读取，请先备份后重新导入');
    }
    if (!Array.isArray(parsed))
        throw new RangeError('本地材料库格式不正确');
    return parsed.map(normalizeMaterial);
}
export function saveMaterials(materials, storage = globalThis.localStorage) {
    if (!storage)
        throw new Error('当前浏览器无法保存本地材料库');
    if (!Array.isArray(materials))
        throw new TypeError('材料库应是材料列表');
    const normalized = materials.map(normalizeMaterial);
    const ids = normalized.map((material) => String(material.id));
    if (new Set(ids).size !== ids.length)
        throw new RangeError('材料编号不能重复');
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
}
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map
//# sourceMappingURL=materials.js.map