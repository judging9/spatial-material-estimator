import { formatMoney, formatQuantity, addDecimal } from './pricing.js';
import { buildCivilQuantities, civilPreset } from './civil.js';
import { regionInteriorPoint } from './geometry.js';
const measurement = value => value === null || value === undefined ? '待校准' : formatQuantity(value);
const amount = value => value === null || value === undefined ? '待确认' : `¥ ${formatMoney(value)}`;
const materialSum = row => [row.materialCost, row.formworkCost, row.rebarCost].some(value => value === null) ? null : formatMoney([row.materialCost, row.formworkCost, row.rebarCost].reduce((sum, value) => addDecimal(sum, value ?? '0'), '0'));
const name = row => row.levelName ? `${row.levelName} / ${row.name}` : row.name;
const priceSource = item => item.provenance ? [item.provenance.source, item.provenance.priceDate || '日期未注明', item.provenance.region, item.provenance.supplier, item.provenance.sourceUrl].filter(Boolean).join(' · ') : '';
const details = row => [civilPreset(row.kind).name, `${row.width} × ${row.depth} × ${row.height} cm`, `本层底标高 ${row.elevation} cm`, `朝向 ${row.rotation}°`, `数量 ${row.quantity}`, `单实例毛体积 ${measurement(row.singleGrossVolume)} m³`, `单实例净体积 ${measurement(row.singleNetVolume)} m³`, `交叠扣量 ${measurement(row.overlapVolume)} m³`, ...(row.warnings ?? [])].join('；');
/** Keep the established 25-column interchange format. Template and steel
 * are real separate priced items; a constituent fee appears only once. */
export function civilToCSV(project, pricing, csvCell) {
    const headers = ['行类型', '工程名称', '构件名称', '平面面积（m²）', '周长（m）', '分项名称', '单位', '计量方式', '净用量', '采购量（含损耗）', '单价（元）', '损耗率（%）', '人工单价（元）', '材料费（元）', '人工费（元）', '项附加费（元）', '构件附加费（元）', '工程附加费（元）', '税前小计（元）', '税率（%）', '税额（元）', '总价（元）', '价格来源', '价格日期', '地区 / 规格'];
    const rows = [headers];
    for (const element of pricing.civilElements) {
        for (const item of element.items) {
            const row = Array(25).fill('');
            Object.assign(row, { 0: '土建分项', 1: project.name, 2: name(element), 3: measurement(element.footprintArea), 5: item.materialName, 6: item.unit, 7: item.unit === 'm³' ? '净体积' : item.unit === 'kg' ? '用户钢筋数量 / 指标' : '真实模板面积', 8: item.quantity ?? '待校准', 9: item.purchaseQuantity ?? '待校准', 10: item.unitPrice === '' ? '待填写单价' : item.unitPrice, 11: item.wasteRate, 12: item.laborRate, 13: item.materialCost ?? '待填写单价', 14: item.laborCost ?? '待校准', 15: item.additionalCost, 18: item.total ?? '待确认', 24: details(element) });
            row[22] = item.provenance?.source || '';
            row[23] = item.provenance?.priceDate || '';
            row[24] += [item.provenance?.region, item.provenance?.spec, item.provenance?.supplier, item.provenance?.sourceUrl].filter(Boolean).map(value => '；' + value).join('');
            rows.push(row);
        }
        const row = Array(25).fill('');
        Object.assign(row, { 0: '土建构件汇总', 1: project.name, 2: name(element), 3: measurement(element.footprintArea), 13: materialSum(element) ?? '待确认', 14: element.laborCost ?? '待确认', 16: element.additionalCost, 18: element.total ?? `已知部分 ${element.knownSubtotal}`, 24: details(element) });
        rows.push(row);
    }
    for (const level of pricing.levelSummaries ?? []) {
        const row = Array(25).fill('');
        Object.assign(row, { 0: level.pending ? '楼层草稿汇总' : '楼层汇总', 1: project.name, 2: level.name, 3: measurement(level.footprintArea), 18: level.total ?? `已知部分 ${level.knownSubtotal}`, 24: `净体积 ${measurement(level.netVolume)} m³；模板 ${measurement(level.formworkArea)} m²；钢筋 ${measurement(level.rebarQuantity)} kg` });
        rows.push(row);
    }
    const row = Array(25).fill('');
    Object.assign(row, { 0: pricing.pending ? '工程草稿汇总' : '工程汇总', 1: project.name, 13: materialSum(pricing) ?? '待确认', 14: pricing.laborCost ?? '待确认', 17: pricing.projectAdditionalCost, 18: pricing.subtotal ?? `已知部分 ${pricing.knownSubtotal}`, 19: pricing.taxRate, 20: pricing.tax ?? '待确认', 21: pricing.total ?? '待确认', 24: `净体积 ${measurement(pricing.netVolume)} m³；模板 ${measurement(pricing.formworkArea)} m²；钢筋 ${measurement(pricing.rebarQuantity)} kg` });
    rows.push(row);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function civilDiagram(project, escape) {
    const drawing = project.drawing;
    if (!drawing || !Number.isFinite(drawing.width) || !Number.isFinite(drawing.height))
        return '';
    const quantities = buildCivilQuantities(project).filter(record => !record.element.hidden), groups = new Map();
    for (const record of quantities) {
        const id = record.levelId ?? '', group = groups.get(id) ?? { name: record.levelName ?? '', elements: [] };
        group.elements.push(record);
        groups.set(id, group);
    }
    const path = part => [part.points, ...part.holes].map(ring => ring.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') + ' Z').join(' ');
    const safeURL = /^(?:data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]|blob:|\/(?!\/)|\.\.?\/)/i.test(drawing.url ?? '') ? drawing.url : '';
    return [...groups.values()].map(group => {
        const geometry = group.elements.map(record => {
            const element = record.element, preset = civilPreset(element.kind), parts = record.metrics.slices.flatMap(slice => slice.parts);
            const label = parts.length ? regionInteriorPoint({ points: parts[0].points, holes: parts[0].holes, surfaceParts: parts }) : null;
            return `<g data-civil-element-id="${escape(element.id)}">${parts.map(part => `<path d="${path(part)}" fill="${preset.color}" fill-opacity=".22" stroke="${preset.color}" stroke-width="${Math.max(1, drawing.width / 700)}" fill-rule="evenodd"/>`).join('')}${label ? `<text x="${label.x}" y="${label.y}" text-anchor="middle" font-size="${Math.max(10, drawing.width / 95)}" fill="#34473c">${escape(element.name)}</text>` : ''}</g>`;
        }).join('');
        return `<section class="civil-drawing"><h2>${escape(group.name ? group.name + ' · 构件布置' : '构件布置')}</h2><svg viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="真实土建构件与孔洞">${safeURL ? `<image href="${escape(safeURL)}" width="${drawing.width}" height="${drawing.height}"/>` : ''}${geometry}</svg></section>`;
    }).join('');
}
export function renderCivilQuoteHTML(project, pricing, options, escape) {
    const rate = value => value === '' || value === null || value === undefined ? '待填写单价' : `¥ ${formatQuantity(value)}`;
    const elements = pricing.civilElements.map(element => `<section class="element" data-quote-kind="civil"><h2>${escape(name(element))} <small>${escape(civilPreset(element.kind).name)}</small></h2><p class="metrics">${escape(details(element))}</p><table><thead><tr><th>计价分项</th><th>单位</th><th>净用量</th><th>采购用量</th><th>单价</th><th>损耗</th><th>材料费</th><th>人工费</th><th>小计</th></tr></thead><tbody>${element.items.map(item => `<tr><td>${escape(item.materialName)}${item.provenance ? `<p class="metrics">${escape(priceSource(item))}</p>` : ''}</td><td>${escape(item.unit)}</td><td>${escape(measurement(item.quantity))}</td><td>${escape(measurement(item.purchaseQuantity))}</td><td>${escape(rate(item.unitPrice))}</td><td>${escape(item.wasteRate)}%</td><td>${escape(amount(item.materialCost))}</td><td>${escape(amount(item.laborCost))}</td><td>${escape(amount(item.total))}</td></tr>`).join('')}</tbody></table><p class="element-total">固定费用 ${escape(amount(element.additionalCost))}　合计 ${escape(amount(element.total))}</p></section>`).join('');
    const fields = [['主材费', pricing.materialCost], ['人工费', pricing.laborCost], ['模板费', pricing.formworkCost], ['钢筋费', pricing.rebarCost], ['固定费用', pricing.additionalCost], ['税前小计', pricing.subtotal], [`税额（${pricing.taxRate}%）`, pricing.tax]];
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.name)} · 土建预算</title><style>body{margin:0;background:#f4f3ef;color:#33443b;font:13px/1.6 "Microsoft YaHei",sans-serif;padding:28px}.sheet{max-width:1100px;margin:auto;background:#fff;padding:36px}.head{display:flex;justify-content:space-between;align-items:center;gap:24px}h1{font-size:26px;font-weight:500;margin:0}h2{font-size:16px;font-weight:500;margin:24px 0 8px}h2 small{font-size:11px;color:#849083;margin-left:8px}.metrics,.date,.footer{color:#7f8d80;font-size:11px}.element{break-inside:avoid}.element-total{text-align:right}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:9px 7px;border-bottom:1px solid #e2e8df;text-align:right}th{background:#f5f7f2;font-weight:500}th:first-child,td:first-child{text-align:left}.summary{max-width:360px;margin:28px 0 0 auto}.summary p{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #e2e8df;padding:9px 0;margin:0}.summary strong{font-weight:500}.grand{font-size:22px;color:#2f6754}.draft{padding:12px 16px;background:#faf3e4;color:#927247}.civil-drawing svg{display:block;width:100%;max-height:560px;border:1px solid #e2e8df}.print-action{background:#2f6754;color:white;border:0;border-radius:6px;padding:10px 16px}.footer{margin-top:28px}@page{size:A4 landscape;margin:12mm}@media print{body{padding:0;background:white}.sheet{padding:0}.print-action{display:none}.civil-drawing{break-before:page}th{print-color-adjust:exact}}</style></head><body><main class="sheet"><header class="head"><div><h1>${escape(project.name)}</h1><p class="date">土建构件与施工预算 · ${escape(new Date().toLocaleDateString('zh-CN'))}</p></div><button class="print-action" type="button">打印 / 另存为 PDF</button></header>${pricing.pending ? `<p class="draft">报价草稿：${escape(pricing.pendingReason ?? '用量或单价待完善')}。已知部分 ${escape(amount(pricing.knownSubtotal))}</p>` : ''}<p class="metrics">净体积 ${escape(measurement(pricing.netVolume))} m³ · 模板 ${escape(measurement(pricing.formworkArea))} m² · 钢筋 ${escape(measurement(pricing.rebarQuantity))} kg</p>${elements}<section class="summary">${fields.map(([label, value]) => `<p><span>${escape(label)}</span><strong>${escape(amount(value))}</strong></p>`).join('')}<p class="grand"><span>含税总价</span><strong>${escape(amount(pricing.total))}</strong></p></section>${options.includeDrawing === false ? '' : civilDiagram(project, escape)}<p class="footer">几何量按实际净实体计算，交叠部分只计一次；主材含损耗，人工按净用量，固定费用按构件计一次。数量用于预算倍率，布置图保持一个实际实例。钢筋指标估算与用户公斤数在分项中明确标注。</p></main></body></html>`;
}
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map
//# sourceMappingURL=civil-export.js.map