import type { Project } from '../types.js';
import { addDecimal, formatMoney, formatQuantity, multiplyDecimal, normalizeDecimal } from './pricing.js';
import { levelProjects } from './levels.js';
import { calculateProjectBudget, projectBudgetEntries, type BudgetEntry, type BudgetIssue, type BudgetSection, type ProjectBudget } from './project-budget.js';
import { calculateProjectReadiness } from './project-readiness.js';
import { csvCell, downloadBlob, escapeHTML } from './export.js';
import { FURNITURE_TEMPLATES } from './furniture-catalog.js';
import { civilPreset } from './civil.js';
import { municipalElementPreset } from './municipal-design.js';

export type QuantityCategory = 'material' | 'equipment' | 'construction' | 'transport';
export type QuantitySource = {
  levelId?: string; levelName?: string; targetType: BudgetIssue['targetType']; targetId?: string;
  objectName: string; itemId: string; netQuantity: string | null; purchaseQuantity: string | null;
  unitPrice: string; materialCost: string; laborCost: string; itemAdditionalCost: string;
  pending: boolean; pendingReasons: string[];
  knownNetQuantity?: string; knownPurchaseQuantity?: string;
};
export type QuantityGroup = {
  id: string; section: BudgetSection; label: string; category: QuantityCategory; categoryLabel: string;
  materialName: string; unit: string; spec: string; unitPrice: string; wasteRate: string; laborRate: string;
  netQuantity: string | null; purchaseQuantity: string | null; knownNetQuantity: string; knownPurchaseQuantity: string;
  knownMaterialCost: string; knownLaborCost: string; knownItemAdditionalCost: string; knownTotal: string;
  pending: boolean; pendingReasons: string[]; sourceCount: number; sources: QuantitySource[];
};
export type ProjectQuantities = {
  groups: QuantityGroup[];
  totals: { materialCost: string; laborCost: string; itemAdditionalCost: string; objectAdditionalCost: string;
    projectAdditionalCost: string; beforeTax: string; tax: string; total: string | null; knownTotal: string };
  budgetStatus: ProjectBudget['status']; pending: boolean; excludedSections: BudgetSection[]; itemCount: number; notes: string[];
};

const labels: Record<BudgetSection, string> = { decoration: '装修', civil: '土建', municipal: '市政' };
const categoryLabels: Record<QuantityCategory, string> = { material: '材料用量', equipment: '设备数量', construction: '施工计量', transport: '运输计量' };
const cents = (value: unknown) => BigInt(formatMoney(value ?? '0').replace('.', ''));
const money = (value: bigint) => { const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(3, '0'); return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`; };
const sumMoney = (values: unknown[]) => money(values.reduce<bigint>((total, value) => total + cents(value), 0n));
const quantity = (value: unknown): string | null => value === null || value === undefined ? null : normalizeDecimal(value, '原计价用量');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value ?? null);
};
const shown = (value: unknown) => value === undefined || value === null ? '未注明' : String(value);

function priceSourceText(item: any): string[] {
  const source = item.provenance;
  return [
    ...(item.demo ? ['Demo 示例材料，价格须另行核实'] : []),
    ...(!source ? [] : [source.source ? `价格来源：${source.source}` : '', source.supplier ? `供应商：${source.supplier}` : '',
      source.region ? `地区：${source.region}` : '', source.priceDate ? `价格日期：${source.priceDate}` : '',
      source.sourceUrl ? `来源地址：${source.sourceUrl}` : ''].filter(Boolean)),
  ];
}

function categoryOf(entry: BudgetEntry, item: any): QuantityCategory {
  if (item.category === 'earthwork-transfer' || item.unit === 'm³·km') return 'transport';
  if (entry.targetType === 'furniture') return 'equipment';
  if (entry.targetType === 'opening') return entry.row.kind === 'hole' ? 'construction' : 'equipment';
  if (entry.targetType === 'civil') return item.materialId === 'civil-formwork' || ['excavation', 'backfill'].includes(entry.row.kind) ? 'construction' : 'material';
  if (entry.targetType === 'municipal') {
    if (['manhole', 'streetlight', 'trafficlight', 'facility'].includes(entry.row.kind)) return 'equipment';
    return 'construction';
  }
  return 'material';
}

function originalOwner(project: Project, entry: BudgetEntry, layers: ReturnType<typeof levelProjects>): any {
  if (entry.targetType === 'municipal') return project.municipalElements?.find(value => value.id === entry.targetId);
  const layer = layers.find(value => value.id === entry.row.levelId)?.project ?? project;
  const field = ({ region: 'regions', ceiling: 'regions', wall: 'walls', furniture: 'furniture', opening: 'openings', service: 'serviceRoutes', civil: 'civilElements' } as const)[entry.targetType];
  if (entry.targetType === 'wall') return layer.wallShapes?.find(value => value.id === entry.targetId) ?? layer.walls?.find(value => value.id === entry.targetId);
  return field ? (layer[field] as any[])?.find(value => value.id === entry.targetId) : undefined;
}

/** Object geometry that affects specification is kept apart from measured
 * quantity. A different position or floor is never treated as a new SKU. */
function specification(entry: BudgetEntry, item: any, source: any): { text: string; identity: unknown } {
  const row = entry.row, provenance = item.provenance ?? {}, base = provenance.spec ? [String(provenance.spec)] : [];
  const dimensions = entry.targetType === 'civil' ? [row.width, row.depth, row.height] : source ? [source.width, source.depth, source.height] : [row.width, row.depth, row.height];
  if (entry.targetType === 'furniture') return { text: [...base, `${FURNITURE_TEMPLATES.find(template => template.kind === (source?.kind ?? row.kind))?.name ?? '自定义家具'} · ${dimensions.map(shown).join(' × ')} cm`].join('；'),
    identity: { kind: source?.kind ?? row.kind, dimensions, stair: source?.stair ? { railing: source.stair.railing, railingHeight: source.stair.railingHeight, innerRatio: source.stair.innerRatio, turnDegrees: source.stair.turnDegrees } : undefined } };
  if (entry.targetType === 'opening') {
    const points = source?.points, origin = points?.[0];
    const profile = points?.map(point => ({ x: point.x - origin.x, y: point.y - origin.y }));
    return { text: [...base, `${({ door: '门', window: '窗', hole: '墙面开孔' } as Record<string, string>)[source?.kind ?? row.kind] ?? '开口'} · ${({ rectangle: '矩形', ellipse: '椭圆形', polygon: '自定义多边形' } as Record<string, string>)[source?.shape ?? row.shape] ?? '轮廓未注明'} · ${dimensions.map(shown).join(' × ')} cm`, profile ? '按原多边形轮廓区分' : ''].filter(Boolean).join('；'),
      identity: { kind: source?.kind ?? row.kind, shape: source?.shape ?? row.shape, dimensions, profile } };
  }
  if (entry.targetType === 'service') return { text: [...base, source?.spec ?? row.spec, `管径 ${shown(source?.diameter ?? row.diameter)} cm`].filter(Boolean).join('；'),
    identity: { preset: source?.presetId ?? row.presetId, spec: source?.spec ?? row.spec, diameter: source?.diameter ?? row.diameter } };
  if (entry.targetType === 'wall') return { text: [...base, `墙面${({ left: '左侧', right: '右侧', both: '双侧' } as const)[source?.finishSide ?? row.side ?? 'both'] ?? '双侧'}`].join('；'),
    identity: { side: source?.finishSide ?? row.side ?? 'both' } };
  if (entry.targetType === 'civil') {
    if (item.materialId === 'civil-rebar') return { text: [...base, row.rebarMode === 'ratio' ? `用户钢筋指标 ${shown(row.rebarRatio)} kg/m³` : '用户填写钢筋公斤数', '未注明钢筋级别'].join('；'),
      identity: { kind: row.kind, rebarMode: row.rebarMode, rebarRatio: row.rebarMode === 'ratio' ? row.rebarRatio : undefined } };
    return { text: [...base, item.materialId === 'civil-formwork' ? '按真实模板施工面积' : '按扣重叠后的净体积', `${civilPreset(row.kind).name} · ${dimensions.map(shown).join(' × ')} cm`, '材料等级未注明'].join('；'),
      identity: { kind: row.kind, dimensions, part: item.materialId } };
  }
  if (entry.targetType === 'municipal') {
    if (item.category === 'earthwork-transfer') return { text: [...base, item.quantityBasis, `运距 ${shown(item.transferRoute?.distanceKm)} km`, '来源道路松方'].filter(Boolean).join('；'),
      identity: { kind: row.kind, part: item.category, route: item.transferRouteId ?? item.id, distanceKm: item.transferRoute?.distanceKm } };
    if (item.category === 'earthwork-balance' || item.category === 'earthwork') return { text: [...base, item.quantityBasis ?? '道路路床与地形之间的实测覆盖量', '土方施工计量'].join('；'),
      identity: { kind: row.kind, part: item.category, sourceId: row.id, key: item.balanceKey ?? item.id } };
    if (item.category === 'bridge') return { text: [...base, item.quantityBasis, item.bridgePart === 'piers' ? `中间墩高 ${shown(source?.bridgeOptions?.pierHeight)} cm` : `栏杆高 ${shown(source?.bridgeOptions?.railingHeight)} cm`].filter(Boolean).join('；'),
      identity: { kind: row.kind, part: item.bridgePart, width: source?.width ?? row.width, pierHeight: source?.bridgeOptions?.pierHeight, railingHeight: source?.bridgeOptions?.railingHeight } };
    const layer = source?.items?.find(value => value.id === item.id);
    return { text: [...base, layer ? `结构层厚 ${shown(layer.thickness)} cm` : `${municipalElementPreset(source ?? row).name} · 宽 ${shown(row.width)} cm · 深 ${shown(row.depth)} cm · 厚/高 ${shown(item.thickness ?? row.height)} cm`, '按原设施综合施工项'].join('；'),
      identity: layer ? { kind: row.kind, catalogId: source?.catalogId, thickness: layer.thickness, layerName: layer.name } : { kind: row.kind, catalogId: source?.catalogId, width: row.width, depth: row.depth, height: item.thickness ?? row.height, roadLayout: source?.roadLayout,
        junction: source?.junction ? { arms: source.junction.arms, armLength: source.junction.armLength, islandRadius: source.junction.islandRadius } : undefined } };
  }
  return { text: base.join('；') || (entry.targetType === 'ceiling' ? '原吊顶材料规格' : '原区域材料规格'), identity: { surface: entry.targetType } };
}

function itemIdentity(entry: BudgetEntry, item: any): string {
  // Municipal ids and furniture ids are object-generated. Their identity is
  // the exact name + source specification, not the random object id.
  return entry.targetType === 'municipal' || entry.targetType === 'furniture' ? String(item.materialName ?? item.name ?? '') : String(item.materialId ?? item.materialName ?? item.id);
}

/** Sum the already-priced original lines. Do not multiply the grouped quantity
 * by a price again: separate source lines can round to different cents. */
export function calculateProjectQuantities(project: Project, suppliedBudget?: ProjectBudget): ProjectQuantities {
  const budget = calculateProjectBudget(project);
  if (suppliedBudget !== undefined) {
    if (suppliedBudget.projectId !== project.id) throw new RangeError('工程用量清单与当前项目不一致。');
    // An id or total alone is not a freshness check: a quantity and its rate
    // can change inversely while preserving the total. Compare every current
    // original quoted line, scope, issue and metadata before accepting a copy.
    if (canonical(suppliedBudget) !== canonical(budget)) throw new RangeError('工程预算已更新或不一致，请按当前项目重新计算用量清单。');
  }
  const groups: QuantityGroup[] = [], grouped = new Map<string, QuantityGroup>(), layers = levelProjects(project);
  let objectAdditionalCost = '0.00';
  for (const section of budget.sections.filter(value => value.included)) for (const entry of projectBudgetEntries(section.id, section.quote)) {
    const row = entry.row, owner = originalOwner(project, entry, layers);
    objectAdditionalCost = sumMoney([objectAdditionalCost, row.additionalCost]);
    for (const item of row.items ?? []) {
      const spec = specification(entry, item, owner), category = categoryOf(entry, item);
      const unitPrice = item.unitPrice === '' ? '' : normalizeDecimal(item.unitPrice ?? '0');
      const wasteRate = normalizeDecimal(item.wasteRate ?? '0'), laborRate = normalizeDecimal(item.laborRate ?? '0');
      const key = canonical({ section: section.id, targetType: entry.targetType, identity: itemIdentity(entry, item), name: item.materialName ?? item.name,
        unit: item.unit ?? '', price: unitPrice, waste: wasteRate, labor: laborRate, spec: spec.identity, provenance: item.provenance ?? null, demo: Boolean(item.demo), category });
      let group = grouped.get(key);
      if (!group) {
        group = { id: `quantity-${groups.length + 1}`, section: section.id, label: labels[section.id], category, categoryLabel: categoryLabels[category],
          materialName: String(item.materialName ?? item.name ?? '未命名计价项目'), unit: String(item.unit ?? ''), spec: [spec.text, ...priceSourceText(item)].filter(Boolean).join('；'), unitPrice, wasteRate, laborRate,
          netQuantity: '0', purchaseQuantity: '0', knownNetQuantity: '0', knownPurchaseQuantity: '0', knownMaterialCost: '0.00', knownLaborCost: '0.00',
          knownItemAdditionalCost: '0.00', knownTotal: '0.00', pending: false, pendingReasons: [], sourceCount: 0, sources: [] };
        grouped.set(key, group); groups.push(group);
      }
      const net = quantity(item.netQuantity ?? item.quantity), purchase = quantity(item.purchaseQuantity);
      // A partly-covered DEM is not a complete quantity. Preserve the actual
      // covered earthwork amount separately, using the quote engine's same
      // physical precision and budget count; never extrapolate missing cells.
      const covered = net === null && item.category === 'earthwork' && Number.isFinite(item.measuredCoveredVolume)
        ? multiplyDecimal(formatQuantity(item.measuredCoveredVolume, 9), row.quantity ?? '1') : null;
      const knownNet = net ?? covered, knownPurchase = purchase ?? covered;
      const materialCost = formatMoney(item.knownMaterialCost ?? item.materialCost ?? '0'), laborCost = formatMoney(item.knownLaborCost ?? item.laborCost ?? '0'), itemAdditionalCost = formatMoney(item.additionalCost ?? '0');
      const reasons: string[] = [...new Set<string>(item.pendingReasons?.length ? item.pendingReasons : item.pendingReason ? [item.pendingReason] : [])];
      const pending = Boolean(item.pending || net === null || purchase === null);
      if (knownNet !== null) group.knownNetQuantity = addDecimal(group.knownNetQuantity, knownNet);
      if (knownPurchase !== null) group.knownPurchaseQuantity = addDecimal(group.knownPurchaseQuantity, knownPurchase);
      group.netQuantity = group.netQuantity === null || net === null ? null : addDecimal(group.netQuantity, net);
      group.purchaseQuantity = group.purchaseQuantity === null || purchase === null ? null : addDecimal(group.purchaseQuantity, purchase);
      group.knownMaterialCost = sumMoney([group.knownMaterialCost, materialCost]); group.knownLaborCost = sumMoney([group.knownLaborCost, laborCost]);
      group.knownItemAdditionalCost = sumMoney([group.knownItemAdditionalCost, itemAdditionalCost]);
      group.knownTotal = sumMoney([group.knownMaterialCost, group.knownLaborCost, group.knownItemAdditionalCost]);
      group.pending ||= pending; group.pendingReasons = [...new Set([...group.pendingReasons, ...reasons])];
      group.sources.push({ levelId: row.levelId, levelName: row.levelName, targetType: entry.targetType, targetId: entry.targetId, objectName: row.name,
        itemId: String(item.id), netQuantity: net, purchaseQuantity: purchase, unitPrice, materialCost, laborCost, itemAdditionalCost, pending, pendingReasons: reasons,
        ...(covered === null ? {} : { knownNetQuantity: covered, knownPurchaseQuantity: covered }) });
      group.sourceCount++;
    }
  }
  const materialCost = sumMoney(groups.map(group => group.knownMaterialCost)), laborCost = sumMoney(groups.map(group => group.knownLaborCost)), itemAdditionalCost = sumMoney(groups.map(group => group.knownItemAdditionalCost));
  const excludedSections = budget.sections.filter(section => !section.included).map(section => section.id);
  const notes = [
    '同专业、材料身份、单位、价格、损耗、人工及原规格来源一致时才合并；不同单位不合计工程量。',
    '采购量沿用原分项含损耗用量；模板、土方、道路综合项和运输是施工计量，不能直接当作商品采购数量。',
    '金额合并原始分项已舍入金额；材料、人工、分项固定费、对象固定费和工程固定费分别列示，不重复计费。',
    ...excludedSections.map(section => `${labels[section]}未汇入本次工程用量清单。`),
    ...calculateProjectReadiness(project, budget).issues.map(issue => `${issue.title}：${issue.message}`),
  ];
  return { groups, totals: { materialCost, laborCost, itemAdditionalCost, objectAdditionalCost, projectAdditionalCost: budget.additionalCost,
    beforeTax: budget.knownSubtotal, tax: budget.knownTax, total: budget.total, knownTotal: budget.knownTotal },
    budgetStatus: budget.status, pending: budget.pending, excludedSections, itemCount: groups.reduce((count, group) => count + group.sourceCount, 0), notes: [...new Set(notes)] };
}

const qtyText = (value: string | null, known: string) => value === null ? `待确认（已知部分 ${formatQuantity(known, 9)}）` : formatQuantity(value, 9);
const priceText = (line: Pick<QuantitySource, 'unitPrice' | 'pending' | 'netQuantity' | 'purchaseQuantity'>) => line.unitPrice !== '' ? line.unitPrice
  : !line.pending && line.netQuantity === '0' && line.purchaseQuantity === '0' ? '零量无需单价' : '待填写';

function exportQuantities(project: Project, suppliedResult?: ProjectQuantities): ProjectQuantities {
  const result = calculateProjectQuantities(project);
  if (suppliedResult !== undefined && canonical(suppliedResult) !== canonical(result)) throw new RangeError('工程用量清单已更新或不一致，请按当前项目重新导出。');
  return result;
}
const headers = ['行类型', '工程名称', '专业', '分类', '材料/计价项目', '规格/依据', '单位', '净用量', '采购/计量用量', '单价（元）', '损耗率（%）', '人工单价（元）', '已确认材料/施工费（元）', '已确认人工费（元）', '分项固定费（元）', '已确认分项金额（元）', '来源数', '状态', '来源/说明'];
const summaryRow = (project: Project, label: string, amount: string, note = '') => { const row = Array(headers.length).fill(''); row[0] = '费用汇总'; row[1] = project.name; row[4] = label; row[15] = amount; row[18] = note; return row; };

export function projectQuantitiesToCSV(project: Project, suppliedResult?: ProjectQuantities): string {
  const result = exportQuantities(project, suppliedResult);
  const rows: string[][] = [headers];
  for (const [label, value] of [['甲方/客户', project.budget?.client], ['报价编号', project.budget?.reference], ['范围与备注', project.budget?.note]]) if (value) rows.push(summaryRow(project, label, '', value));
  for (const group of result.groups) {
    rows.push(['规格用量汇总', project.name, group.label, group.categoryLabel, group.materialName, group.spec, group.unit,
      qtyText(group.netQuantity, group.knownNetQuantity), qtyText(group.purchaseQuantity, group.knownPurchaseQuantity), priceText(group),
      group.wasteRate, group.laborRate, group.knownMaterialCost, group.knownLaborCost, group.knownItemAdditionalCost, group.knownTotal, String(group.sourceCount),
      group.pending ? '待完善/已确认部分' : '已确认', group.pendingReasons.join('；')]);
    for (const source of group.sources) {
      const row = Array(headers.length).fill(''); row[0] = '来源追溯'; row[1] = project.name; row[2] = group.label; row[3] = group.categoryLabel; row[4] = group.materialName; row[5] = group.spec; row[6] = group.unit;
      row[7] = qtyText(source.netQuantity, source.knownNetQuantity ?? '0'); row[8] = qtyText(source.purchaseQuantity, source.knownPurchaseQuantity ?? '0');
      row[9] = priceText(source); row[17] = source.pending ? '待完善' : '已确认';
      row[18] = [source.levelName, source.objectName, `分项 ${source.itemId}`, source.pendingReasons.join('；')].filter(Boolean).join(' / '); rows.push(row);
    }
  }
  const totals = result.totals;
  for (const [label, amount] of [['已确认材料/施工费', totals.materialCost], ['已确认人工费', totals.laborCost], ['分项固定费', totals.itemAdditionalCost], ['对象固定费', totals.objectAdditionalCost],
    ['工程固定费（一次）', totals.projectAdditionalCost], ['已确认税前金额', totals.beforeTax], ['统一税金（一次）', totals.tax], [result.budgetStatus === 'ready' ? '含税总预算' : '已确认部分含税小计', totals.knownTotal]]) rows.push(summaryRow(project, label, amount, '汇总与来源行用于核对，请勿重复累加。'));
  for (const note of result.notes) rows.push(summaryRow(project, '计量说明', '', note));
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function renderProjectQuantitiesReport(project: Project, suppliedResult?: ProjectQuantities): string {
  const result = exportQuantities(project, suppliedResult);
  const e = escapeHTML, totals = result.totals;
  const groups = result.groups.map(group => `<section class="quantity-group"><header><div><span class="eyebrow">${e(group.label)} · ${e(group.categoryLabel)}</span><h2>${e(group.materialName)}</h2><p>${e(group.spec)}</p></div><span>${group.sourceCount} 项来源</span></header><table><thead><tr><th>单位</th><th>净用量</th><th>采购/计量用量</th><th>单价 / 损耗 / 人工</th><th>已确认金额（元）</th></tr></thead><tbody><tr><td>${e(group.unit)}</td><td>${e(qtyText(group.netQuantity, group.knownNetQuantity))}</td><td>${e(qtyText(group.purchaseQuantity, group.knownPurchaseQuantity))}</td><td>${e(priceText(group))}<small>损耗 ${e(group.wasteRate)}% · 人工 ${e(group.laborRate)}</small></td><td>${e(group.knownTotal)}${group.pending ? '<small>已确认部分 / 待完善</small>' : ''}</td></tr></tbody></table><p class="amounts">材料/施工费 ${e(group.knownMaterialCost)} · 人工 ${e(group.knownLaborCost)} · 分项固定费 ${e(group.knownItemAdditionalCost)}</p><div class="sources">${group.sources.map(source => `<p><strong>${e([source.levelName, source.objectName].filter(Boolean).join(' / '))}</strong><span>净量 ${e(qtyText(source.netQuantity, source.knownNetQuantity ?? '0'))} ${e(group.unit)} · 采购/计量 ${e(qtyText(source.purchaseQuantity, source.knownPurchaseQuantity ?? '0'))} ${e(group.unit)} · 单价 ${e(priceText(source))}</span></p>`).join('')}</div>${group.pendingReasons.length ? `<p class="pending">${e(group.pendingReasons.join('；'))}</p>` : ''}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${e(project.name)} · 工程用量清单</title><style>body{margin:0;background:#f5f6f3;color:#34473e;font:12px/1.7 "Microsoft YaHei",sans-serif}.sheet{max-width:980px;margin:24px auto;background:white;padding:32px}h1{font-size:24px;font-weight:500;margin:0}h2{font-size:16px;font-weight:500;margin:4px 0}header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}header p,.eyebrow,small{color:#7b887e;font-size:10px}.print-action{border:1px solid #d3ded4;border-radius:6px;padding:8px 14px;background:white;color:#365b49}.metadata{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #dfe5dc;padding:16px 0}.note{white-space:pre-wrap;overflow-wrap:anywhere}.quantity-group{margin-top:24px;border-top:1px solid #e0e7dd;padding-top:16px;break-inside:avoid}table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:12px}th,td{padding:9px 8px;border-bottom:1px solid #e1e7de;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#f4f7f1;font-size:10px;font-weight:500}th:first-child,td:first-child{text-align:left;width:8%}small{display:block}.amounts{font-size:10px;text-align:right;color:#778b7d}.sources p{display:flex;justify-content:space-between;gap:24px;font-size:10px;color:#7c8a7d}.sources strong{font-weight:500;color:#5f7266}.pending,.notice{color:#987d4e;background:#faf6ec;padding:10px 12px}.summary{max-width:440px;margin:24px 0 0 auto}.summary p{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid #e0e7dd;padding:9px 0}.summary strong{font-variant-numeric:tabular-nums}.grand{font-size:18px;color:#2e6953}.notes{font-size:10px;color:#7c8b7d;padding-left:18px}.notes li{margin:6px 0}thead{display:table-header-group}@page{size:A4 portrait;margin:14mm}@media print{body{background:white}.sheet{padding:0;margin:0}.print-action{display:none}th{print-color-adjust:exact}}</style></head><body><main class="sheet"><header><div><h1>${e(project.name)}</h1><p>工程用量清单 · ${result.budgetStatus === 'ready' ? '按原计价来源核对' : '待完善，仅列示已确认部分'}</p></div><button class="print-action" type="button" onclick="window.print()">打印 / 保存 PDF</button></header><div class="metadata"><span>甲方 / 客户：${e(project.budget?.client ?? '—')}</span><span>报价编号：${e(project.budget?.reference ?? '—')}</span></div>${project.budget?.note ? `<p class="note">${e(project.budget.note)}</p>` : ''}${result.budgetStatus !== 'ready' ? '<p class="notice">' + (result.budgetStatus === 'empty' ? '尚无已汇入的计价分项，请先创建工程并确认预算范围。' : '工程量或价格仍有待确认项，金额为已确认部分。') + '</p>' : ''}${groups || '<p>暂无工程用量。</p>'}<section class="summary">${[['材料/施工费', totals.materialCost], ['人工费', totals.laborCost], ['分项固定费', totals.itemAdditionalCost], ['对象固定费', totals.objectAdditionalCost], ['工程固定费（一次）', totals.projectAdditionalCost], ['税前金额', totals.beforeTax], ['统一税金（一次）', totals.tax]].map(([label, value]) => `<p><span>${e(label)}</span><strong>¥ ${e(value)}</strong></p>`).join('')}<p class="grand"><span>${result.budgetStatus === 'ready' ? '含税总预算' : '已确认部分含税小计'}</span><strong>¥ ${e(totals.knownTotal)}</strong></p></section><h2>计量与汇总说明</h2><ul class="notes">${result.notes.map(note => `<li>${e(note)}</li>`).join('')}</ul></main></body></html>`;
}

const filename = (project: Project) => (project.name || '工程').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
export function downloadProjectQuantitiesCSV(project: Project, suppliedResult?: ProjectQuantities): void {
  downloadBlob(new Blob([projectQuantitiesToCSV(project, suppliedResult)], { type: 'text/csv;charset=utf-8' }), `${filename(project)}-工程用量清单.csv`);
}
export function printProjectQuantitiesReport(project: Project, suppliedResult?: ProjectQuantities): void {
  const report = renderProjectQuantitiesReport(project, suppliedResult);
  const popup = window.open('', '_blank'); if (!popup) throw new Error('请允许本地软件打开工程用量打印窗口。');
  popup.document.open(); popup.document.write(report); popup.document.close();
}
