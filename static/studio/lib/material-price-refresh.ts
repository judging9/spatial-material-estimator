import type { Material } from '../types.js';
import { normalizeDecimal } from './pricing.js';
import { normalizePriceRows, normalizePriceUnit } from './material-prices.js';
import { normalizePriceProvenance } from './price-provenance.js';

export type PriceTableField = 'name' | 'unit' | 'price' | 'spec' | 'date' | 'supplier' | 'region' | 'source';
export type PriceTableMapping = Partial<Record<PriceTableField, number>>;
export type MaterialPriceRefreshSource = { kind: 'nbs' | 'web'; url: string; tableIndex?: number; mapping?: PriceTableMapping; hasHeader?: boolean };
export type PriceRefreshCandidate = {
  id: string; name: string; spec: string; unit: string; originalUnit: string; unitPrice: string;
  supported: boolean; region: string; priceDate: string; source: string; sourceUrl: string; supplier: string;
  refresh?: MaterialPriceRefreshSource;
};
export type SavedPriceSource = {
  eligible: boolean; reason: string; source?: MaterialPriceRefreshSource;
  materialName: string; spec: string; region: string; supplier: string; sourceName: string;
};
export type MaterialPriceRefreshEntry = {
  materialId: string; name: string; unit: string; oldPrice: string; oldDate: string;
  state: 'ready' | 'unavailable' | 'failed'; reason: string; fingerprint: string;
  changed?: boolean; candidate?: PriceRefreshCandidate;
};
type FetchLike = (path: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;
const FIELDS: PriceTableField[] = ['name', 'unit', 'price', 'spec', 'date', 'supplier', 'region', 'source'];
const NBS_URL = 'https://www.stats.gov.cn/sj/zxfb/';
const text = (value: unknown) => String(value ?? '').trim();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value ?? null);
};
const sourceURL = (value: unknown): string => {
  const raw = text(value); if (!raw || raw.length > 2048) throw new RangeError('请关联完整的在线报价来源网址。');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RangeError('报价来源应为无账号密码的 http(s) 网页。');
  url.hash = ''; return url.href;
};
const isNBS = (url: string) => ['stats.gov.cn', 'www.stats.gov.cn'].includes(new URL(url).hostname.toLowerCase());
const provenanceOf = (material: Material): Record<string, any> => material?.provenance ?? {};
const priceFingerprint = (material: Material): string => canonical({ id: material.id, unit: material.unit, unitPrice: normalizeDecimal(material.unitPrice), demo: material.demo, provenance: material.provenance });

/** Explicit header aliases only. Duplicate or ambiguous fields require a
 * mapping selected by the user; no position or price is guessed. */
export function inferPriceTableMapping(headers: unknown[]): PriceTableMapping | null {
  if (!Array.isArray(headers) || !headers.length || headers.length > 1001) return null;
  const aliases: Record<PriceTableField, string[]> = {
    name: ['名称', '材料名称', '产品名称', '品名', 'name'], unit: ['单位', '计价单位', '计量单位', 'unit'],
    price: ['单价', '价格', '报价', '信息价', '市场价', '含税价', '本期价格', '本期价格（元）', '单价（元）', '价格（元）', 'price', 'unitprice'],
    spec: ['规格', '规格型号', '型号', 'spec'], date: ['日期', '价格日期', '报价日期', '发布日期', 'price_date', 'pricedate'],
    supplier: ['供应商', '厂家', '品牌', 'supplier'], region: ['地区', '城市', '省市', 'region'], source: ['来源', '数据来源', 'source'],
  };
  const mapping: PriceTableMapping = {};
  for (const field of FIELDS) {
    const matches = headers.map((label, index) => aliases[field].includes(text(label).toLowerCase()) ? index : -1).filter(index => index >= 0);
    if (matches.length > 1) return null;
    if (matches.length) mapping[field] = matches[0];
  }
  return ['name', 'unit', 'price'].every(field => mapping[field] !== undefined) ? mapping : null;
}

export function normalizeMaterialRefreshSource(value: unknown): MaterialPriceRefreshSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('在线报价来源配置无效。');
  const input = value as Record<string, unknown>, url = sourceURL(input.url);
  if (!['nbs', 'web'].includes(text(input.kind))) throw new RangeError('报价刷新来源类型无效。');
  if (input.kind === 'nbs') {
    if (!isNBS(url)) throw new RangeError('官方报价来源必须是国家统计局网站。');
    return { kind: 'nbs', url: NBS_URL };
  }
  const result: MaterialPriceRefreshSource = { kind: 'web', url };
  if (input.tableIndex !== undefined) {
    if (!Number.isInteger(input.tableIndex) || Number(input.tableIndex) < 0 || Number(input.tableIndex) > 100) throw new RangeError('报价表格序号应为 0–100。');
    result.tableIndex = Number(input.tableIndex);
  }
  if (input.hasHeader !== undefined) {
    if (typeof input.hasHeader !== 'boolean') throw new RangeError('报价表头配置无效。');
    result.hasHeader = input.hasHeader;
  }
  if (input.mapping !== undefined) {
    if (!input.mapping || typeof input.mapping !== 'object' || Array.isArray(input.mapping)) throw new RangeError('报价表格列映射无效。');
    const mapping: PriceTableMapping = {}, raw = input.mapping as Record<string, unknown>;
    for (const [key, index] of Object.entries(raw)) {
      if (Number(index) === -1 && !['name', 'unit', 'price'].includes(key) && FIELDS.includes(key as PriceTableField)) continue;
      if (!FIELDS.includes(key as PriceTableField) || !Number.isInteger(index) || Number(index) < 0 || Number(index) > 1000) throw new RangeError('报价列应使用有效的名称、单位、单价及可选来源列。');
      mapping[key] = Number(index);
    }
    if (!['name', 'unit', 'price'].every(field => mapping[field] !== undefined)) throw new RangeError('报价刷新必须关联名称、单位和单价列。');
    if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new RangeError('报价字段不能使用同一列。');
    result.mapping = mapping;
    result.tableIndex ??= 0;
    result.hasHeader ??= true;
  }
  return result;
}

/** A material without a readable source cannot acquire a fabricated refresh
 * rate. A legacy official URL is recognizable; a file is never a live source. */
export function savedMaterialPriceSource(material: Material): SavedPriceSource {
  const p = provenanceOf(material), identity = {
    materialName: text(p.materialName) || text(material?.name), spec: text(p.spec),
    region: text(p.region) || '未注明地区', supplier: text(p.supplier), sourceName: text(p.source),
  };
  try {
    if (!material || !material.id || !normalizePriceUnit(material.unit)) throw new RangeError('材料身份或单位无效。');
    if (!p.sourceUrl && !p.refresh) throw new RangeError(material.demo ? 'Demo 示例没有在线市场来源，请先关联实际报价。' : '尚未关联可读取的在线来源；手工和文件报价可重新导入。');
    let source: MaterialPriceRefreshSource;
    if (p.refresh) source = normalizeMaterialRefreshSource(p.refresh);
    else {
      const url = sourceURL(p.sourceUrl);
      source = isNBS(url) && /国家统计局/.test(identity.sourceName)
        ? { kind: 'nbs', url: NBS_URL } : { kind: 'web', url };
    }
    if (p.sourceUrl && source.kind === 'web' && sourceURL(p.sourceUrl) !== source.url) throw new RangeError('刷新网址与当前报价来源不一致，请重新关联来源。');
    if (p.sourceUrl && source.kind === 'nbs' && !isNBS(sourceURL(p.sourceUrl))) throw new RangeError('当前报价与官方来源不一致，请重新关联来源。');
    if (!identity.materialName) throw new RangeError('来源材料名称尚未填写。');
    if (source.kind === 'nbs' && identity.region !== '全国') throw new RangeError('全国官方报价不能直接覆盖地方报价。');
    identity.sourceName ||= source.kind === 'nbs' ? '国家统计局·流通领域重要生产资料' : new URL(source.url).hostname;
    return { eligible: true, reason: '', source, ...identity };
  } catch (error) { return { eligible: false, reason: error.message, ...identity }; }
}

function matchingCandidate(material: Material, candidates: PriceRefreshCandidate[]): PriceRefreshCandidate {
  const saved = savedMaterialPriceSource(material); if (!saved.eligible) throw new RangeError(saved.reason);
  const sameIdentity = candidates.filter(candidate => candidate.supported && normalizePriceUnit(candidate.originalUnit) === candidate.unit && candidate.name === saved.materialName && candidate.spec === saved.spec
    && candidate.unit === material.unit && candidate.region === saved.region && candidate.supplier === saved.supplier
    && (saved.source.kind === 'nbs' ? isNBS(sourceURL(candidate.sourceUrl)) && /国家统计局/.test(candidate.source)
      : sourceURL(candidate.sourceUrl) === saved.source.url && candidate.source === saved.sourceName));
  if (!sameIdentity.length) throw new RangeError('来源中未找到名称、规格、单位、地区和供应商完全一致的报价。');
  if (sameIdentity.length > 1) throw new RangeError('同规格来源有多条报价，请在导入预览中核对日期后选择。');
  const candidate = sameIdentity[0], oldDate = text(provenanceOf(material).priceDate);
  if (candidate.priceDate && oldDate && candidate.priceDate < oldDate) throw new RangeError('来源报价早于已保存的价格日期，保留当前报价。');
  return candidate;
}

async function post(fetcher: FetchLike, path: string, payload: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw new DOMException('报价读取已取消', 'AbortError');
  const response = await fetcher(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  const envelope = await response.json();
  if (!response.ok || !envelope?.ok) throw new Error(text(envelope?.error) || '无法读取来源报价。');
  if (signal?.aborted) throw new DOMException('报价读取已取消', 'AbortError');
  return envelope.data;
}

/** Reads only preview endpoints. Equal source requests share a result, while
 * per-material errors retain every original price. Nothing is committed here. */
export async function readSavedMaterialPrices(materials: Material[], options: { materialIds?: string[]; fetcher?: FetchLike; signal?: AbortSignal } = {}): Promise<MaterialPriceRefreshEntry[]> {
  if (!Array.isArray(materials) || materials.length > 5000) throw new RangeError('每次最多刷新 5000 项材料报价。');
  const ids = new Set(options.materialIds ?? materials.map(material => material.id));
  if (ids.size !== (options.materialIds ?? materials).length || [...ids].some(id => !materials.some(material => material.id === id))) throw new RangeError('要刷新的材料不存在或重复。');
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis), requests = new Map<string, Promise<PriceRefreshCandidate[]>>();
  const read = (saved: SavedPriceSource): Promise<PriceRefreshCandidate[]> => {
    const key = canonical({ source: saved.source, region: saved.region, sourceName: saved.sourceName });
    if (requests.has(key)) return requests.get(key);
    const promise = (async () => {
      let source = saved.source, result: any;
      if (source.kind === 'nbs') result = await post(fetcher, '/api/scrape/nbs/preview', {}, options.signal);
      else {
        if (!source.mapping) {
          const preview = await post(fetcher, '/api/scrape/preview', { url: source.url }, options.signal);
          if (!Array.isArray(preview?.tables)) throw new Error('来源未返回可读取的报价表格。');
          const tables = preview.tables.map(table => ({ table, mapping: inferPriceTableMapping(table?.sample?.[0]) })).filter(value => value.mapping && (source.tableIndex === undefined || value.table.index === source.tableIndex));
          if (!tables.length) throw new Error('没有名称、单位、单价表头，请先通过报价导入选择表格列。');
          if (tables.length > 1) throw new Error('来源有多个报价表格，请先通过报价导入保存所需表格。');
          source = normalizeMaterialRefreshSource({ ...source, tableIndex: tables[0].table.index, mapping: tables[0].mapping, hasHeader: true });
        }
        result = await post(fetcher, '/api/scrape/rows/preview', { url: source.url, table_index: source.tableIndex ?? 0, mapping: source.mapping, has_header: source.hasHeader ?? true, region: saved.region, source: saved.sourceName }, options.signal);
      }
      if (!Array.isArray(result?.rows)) throw new Error('来源未返回有效报价行。');
      const url = sourceURL(result.url || source.url);
      if (source.kind === 'nbs' ? !isNBS(url) : url !== source.url) throw new Error('返回报价来源与关联来源不一致。');
      const context = { sourceUrl: url, source: source.kind === 'nbs' ? '国家统计局·流通领域重要生产资料' : saved.sourceName,
        region: source.kind === 'nbs' ? '全国' : saved.region, priceDate: source.kind === 'nbs' ? result.price_date : undefined };
      const normalized = normalizePriceRows(result.rows, context);
      if (!normalized.candidates.length && normalized.errors.length) throw new Error(normalized.errors.slice(0, 3).join('；'));
      return normalized.candidates.map(candidate => ({ ...candidate, refresh: structuredClone(source) })) as PriceRefreshCandidate[];
    })(); requests.set(key, promise); return promise;
  };
  const entries: MaterialPriceRefreshEntry[] = [];
  // Keep upstream requests bounded and avoid starting thousands of connections.
  for (const material of materials.filter(material => ids.has(material.id))) {
    if (options.signal?.aborted) throw new DOMException('报价读取已取消', 'AbortError');
    const saved = savedMaterialPriceSource(material), entry: MaterialPriceRefreshEntry = {
      materialId: material.id, name: material.name, unit: material.unit, oldPrice: normalizeDecimal(material.unitPrice),
      oldDate: text(provenanceOf(material).priceDate), state: saved.eligible ? 'failed' : 'unavailable', reason: saved.reason, fingerprint: priceFingerprint(material),
    };
    if (saved.eligible) {
      try {
        const candidate = matchingCandidate(material, await read(saved));
        Object.assign(entry, { state: 'ready', candidate, changed: candidate.unitPrice !== entry.oldPrice,
          reason: candidate.priceDate ? '已核对来源报价' : '来源未提供报价日期，请按实际报价确认' });
      } catch (error) { if (error.name === 'AbortError') throw error; entry.reason = error.message; }
    }
    entries.push(entry);
  }
  return entries;
}

/** Commit only selected, fresh rows. Geometry, waste, appearance and all other
 * rates stay in their current material; even an equal price keeps its new date. */
export function applySavedMaterialPrices(materials: Material[], entries: MaterialPriceRefreshEntry[], materialIds: string[], updatedAt = new Date().toISOString()): Material[] {
  if (!Array.isArray(materials) || !Array.isArray(entries) || !Array.isArray(materialIds) || !materialIds.length) throw new RangeError('请选择已核对的来源报价。');
  if (new Set(materialIds).size !== materialIds.length || new Set(materials.map(material => material.id)).size !== materials.length) throw new RangeError('刷新材料编号不能重复。');
  const next = materials.map(material => ({ ...material }));
  for (const id of materialIds) {
    const material = materials.find(value => value.id === id), matches = entries.filter(value => value.materialId === id), entry = matches[0];
    if (!material || matches.length !== 1 || entry.state !== 'ready' || !entry.candidate) throw new RangeError('请选择来源核对成功的材料。');
    if (priceFingerprint(material) !== entry.fingerprint) throw new RangeError('材料报价或来源已更新，请重新读取来源后再应用。');
    const normalized = normalizePriceRows([entry.candidate]);
    if (normalized.candidates.length !== 1 || !normalized.candidates[0].supported) throw new RangeError(normalized.errors[0] || '来源报价格式无效。');
    const candidate = matchingCandidate(material, [{ ...normalized.candidates[0], originalUnit: entry.candidate.originalUnit, refresh: entry.candidate.refresh } as PriceRefreshCandidate]);
    const unitPrice = normalizeDecimal(candidate.unitPrice, '来源材料单价');
    const refreshed = { ...material, unitPrice, demo: false, provenance: normalizePriceProvenance({
      source: candidate.source, sourceUrl: candidate.sourceUrl, materialName: candidate.name, spec: candidate.spec,
      region: candidate.region, supplier: candidate.supplier, priceDate: candidate.priceDate, originalUnit: candidate.originalUnit,
      updatedAt, refresh: normalizeMaterialRefreshSource(candidate.refresh ?? savedMaterialPriceSource(material).source),
    }) } as Material;
    next[next.findIndex(value => value.id === id)] = refreshed;
  }
  return next;
}
