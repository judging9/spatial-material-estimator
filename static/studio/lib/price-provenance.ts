import type { PriceProvenance } from '../types.js';
import { normalizeDecimal } from './pricing.js';

const text = (value: unknown, label: string, limit: number) => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new RangeError(`${label}格式不正确。`);
  return value.trim();
};
const url = (value: unknown) => {
  const parsed = new URL(text(value, '来源网址', 2048));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RangeError('来源网址应为不含账号密码的 HTTP(S) 地址。');
  return parsed.href;
};

/** Source records describe an actual quote. A URL never implies a market rate. */
export function normalizePriceProvenance(value: unknown): PriceProvenance | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('价格来源格式不正确。');
  const source = value as Record<string, any>;
  const result: PriceProvenance = { source: text(source.source, '来源名称', 240) };
  if (!result.source) throw new RangeError('请填写价格来源名称。');
  if (source.manual !== undefined) {
    if (typeof source.manual !== 'boolean') throw new RangeError('报价录入方式无效。');
    result.manual = source.manual;
  }
  for (const [field, limit] of [['region', 120], ['spec', 1000], ['supplier', 240], ['materialName', 240], ['originalUnit', 80]] as const) {
    if (source[field] !== undefined && source[field] !== '') result[field] = text(source[field], '价格来源信息', limit);
  }
  if (source.sourceUrl) result.sourceUrl = url(source.sourceUrl);
  if (source.priceDate) {
    const date = text(source.priceDate, '报价日期', 10), parsed = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new RangeError('报价日期应为有效的 YYYY-MM-DD 日期。');
    result.priceDate = date;
  }
  if (source.updatedAt) {
    const stamp = text(source.updatedAt, '刷新时间', 40);
    if (!Number.isFinite(Date.parse(stamp))) throw new RangeError('价格刷新时间无效。');
    result.updatedAt = stamp;
  }
  if (source.refresh !== undefined) {
    const refresh = source.refresh;
    if (!refresh || typeof refresh !== 'object' || Array.isArray(refresh) || !['nbs', 'web'].includes(refresh.kind)) throw new RangeError('报价刷新来源类型无效。');
    result.refresh = { kind: refresh.kind, url: url(refresh.url) };
    if (refresh.tableIndex !== undefined) {
      if (!Number.isInteger(refresh.tableIndex) || refresh.tableIndex < 0 || refresh.tableIndex > 100) throw new RangeError('网页报价表格编号无效。');
      result.refresh.tableIndex = refresh.tableIndex;
    }
    if (refresh.hasHeader !== undefined) {
      if (typeof refresh.hasHeader !== 'boolean') throw new RangeError('网页报价表头设置无效。');
      result.refresh.hasHeader = refresh.hasHeader;
    }
    if (refresh.mapping !== undefined) {
      if (!refresh.mapping || typeof refresh.mapping !== 'object' || Array.isArray(refresh.mapping)) throw new RangeError('网页报价列设置无效。');
      const mapping: NonNullable<PriceProvenance['refresh']>['mapping'] = {};
      for (const [key, index] of Object.entries(refresh.mapping)) {
        if (!['name', 'unit', 'price', 'spec', 'date', 'supplier', 'region', 'source'].includes(key) || !Number.isInteger(index) || Number(index) < -1 || Number(index) > 1000) throw new RangeError('网页报价列编号无效。');
        mapping[key] = Number(index);
      }
      for (const key of ['name', 'unit', 'price']) if (mapping[key] === undefined || mapping[key] < 0) throw new RangeError('报价表需要名称、单位和价格列。');
      result.refresh.mapping = mapping;
    }
  }
  return result;
}

/** An explicit manual override must not be attributed to an older web quote. */
export function effectivePriceProvenance(target: { provenance?: PriceProvenance; unitPrice?: string; priceSourceUnitPrice?: string }, quotedPrice = target?.unitPrice): PriceProvenance | undefined {
  const original = normalizePriceProvenance(target?.provenance);
  if (!original) return undefined;
  if (target.priceSourceUnitPrice !== undefined && quotedPrice !== undefined && normalizeDecimal(quotedPrice || '0') !== normalizeDecimal(target.priceSourceUnitPrice)) {
    return { source: '用户调整单价', ...(original.spec ? { spec: original.spec } : {}), ...(original.region ? { region: original.region } : {}) };
  }
  return original.manual ? { ...original, source: '手工录入 · ' + original.source, manual: false } : original;
}

export function describePriceSource(provenance?: PriceProvenance, demo = false, blank = false): string {
  if (demo) return ['Demo 示例价格 · 尚未关联实际报价', provenance?.source].filter(Boolean).join(' · ');
  if (!provenance) return blank ? '待填写单价 · 尚无价格来源' : '用户手工报价 · 日期未注明';
  return [provenance.manual ? '手工录入' : '', provenance.source, provenance.region || '地区未注明', provenance.priceDate || '报价日期未注明', provenance.supplier].filter(Boolean).join(' · ');
}

export function sourcePriceMetadata(target: any, quotedPrice = target?.unitPrice): { provenance?: PriceProvenance; priceMaterialId?: string } {
  const provenance = effectivePriceProvenance(target, quotedPrice);
  return { ...(provenance ? { provenance } : {}), ...(target?.priceMaterialId ? { priceMaterialId: target.priceMaterialId } : {}) };
}
