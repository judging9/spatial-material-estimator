import { calculateProject, formatMoney, formatQuantity, normalizeDecimal } from './pricing.js';
import { exportProjectJSON } from './persistence.js';
import { furnitureFootprint } from './furniture.js';
import { levelProjects, effectiveLevelProject } from './levels.js';
import { isStairKind, stairPlanGeometry } from './stairs.js';
import { regionInteriorPoint } from './geometry.js';
import { furnitureScale } from './furniture.js';
import { servicePreset, serviceMetrics } from './services.js';
import { calculateCivilProject } from './civil-pricing.js';
import { civilToCSV, renderCivilQuoteHTML } from './civil-export.js';
import { calculateMunicipalProject } from './municipal-pricing.js';
import { municipalToCSV, renderMunicipalQuoteHTML } from './municipal-export.js';
export function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}
export function csvCell(value) {
    let text = String(value ?? '');
    // Excel and other spreadsheets evaluate formula-like text even in quoted CSV.
    if (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text))
        text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}
function exportPricing(project, options) {
    const pricing = options.pricing ?? (project.workspaceMode === 'municipal' ? calculateMunicipalProject(project) : project.workspaceMode === 'civil' ? calculateCivilProject(project) : calculateProject(project));
    if (pricing.pending && !options.allowDraft) {
        throw new Error(`请先完成报价：${pricing.pendingReason || '校准图纸并填写实际用量和单价'}，再导出正式报价`);
    }
    return pricing;
}
function materialInfo(item, materials) {
    const material = materials.find((candidate) => String(candidate.id) === String(item.materialId));
    return { name: item.materialName || material?.name || '未命名材料', provenance: item.provenance,
        unit: item.unit || material?.unit || (item.quantityMode === 'perimeter' ? 'm' : item.quantityMode === 'manual' ? '件' : 'm²'),
        demo: item.demo ?? material?.demo ?? false };
}
const metric = (value) => value === null || value === undefined ? '未校准' : formatQuantity(value);
const modes = { area: '净面积', perimeter: '边界周长', manual: '手工数量' };
const quoteEntries = pricing => [...pricing.regions, ...(pricing.walls || []).filter(wall => wall.items.length || Number(wall.additionalCost) > 0), ...(pricing.ceilings || []).filter(ceiling => ceiling.items.length || Number(ceiling.additionalCost) > 0), ...(pricing.furniture || []), ...(pricing.serviceRoutes || []), ...(pricing.openings || [])];
const entryName = entry => entry.levelName ? `${entry.levelName} / ${entry.name}` : entry.name;
const furnitureDimensions = (entry, project) => {
    const source = levelProjects(project).flatMap(level => level.project.furniture || []).find(item => item.id === entry.id);
    return source ? `${formatQuantity(source.width)} × ${formatQuantity(source.depth)} × ${formatQuantity(source.height)} cm；朝向 ${formatQuantity(source.rotation)}°${source.mountHeight !== undefined ? `；离地 ${formatQuantity(source.mountHeight)} cm` : ''}` : '';
};
const openingDetails = entry => `真实开口 ${metric(entry.netArea)} m²；轮廓 ${metric(entry.perimeter)} m；宽高 ${formatQuantity(entry.width)} × ${formatQuantity(entry.height)} cm；距墙起点 ${formatQuantity(entry.offset)} cm；离地 ${formatQuantity(entry.bottom)} cm`;
const serviceDetails = entry => [entry.spec, `实际路径 ${metric(entry.pathLength)} m`, `并行 ${entry.runs} 路`, `余量 ${formatQuantity(entry.extraLength)} m`, `直径 ${formatQuantity(entry.diameter)} cm`].filter(Boolean).join('；');
const servicePending = entry => entry.pathLength === null || entry.pathLength === undefined ? '待校准' : '待填写单价';
export function projectToCSV(project, options = {}) {
    const pricing = exportPricing(project, options);
    if (pricing.kind === 'civil')
        return civilToCSV(project, pricing, csvCell);
    if (pricing.kind === 'municipal')
        return municipalToCSV(project, pricing, csvCell);
    const pending = pricing.pendingReason || '待确认';
    const materials = options.materials ?? project.materialsSnapshot ?? [];
    const headers = ['行类型', '工程名称', '区域名称', '净面积（m²）', '周长（m）', '材料名称', '单位',
        '计量方式', '净用量', '采购量（含损耗）', '单价（元）', '损耗率（%）', '人工单价（元）',
        '材料费（元）', '人工费（元）', '项附加费（元）', '区域附加费（元）', '工程附加费（元）',
        '税前小计（元）', '税率（%）', '税额（元）', '总价（元）'];
    headers.push('价格来源', '价格日期', '地区 / 规格');
    const rows = [headers];
    for (const region of quoteEntries(pricing)) {
        const furniture = region.surfaceType === 'furniture';
        const service = region.surfaceType === 'service', opening = region.surfaceType === 'opening', pending = region.pendingReason || (service ? servicePending(region) : furniture || opening ? '待填写单价' : '待校准');
        for (const item of region.items) {
            const info = materialInfo(item, materials);
            rows.push([opening ? '门窗 / 开孔明细' : service ? '管线明细' : furniture ? '家具明细' : region.surfaceType === 'wall' ? '墙面材料明细' : region.surfaceType === 'ceiling' ? '天花板材料明细' : '材料明细', project.name, entryName(region), furniture || service ? '' : metric(region.netArea), furniture || service ? '' : metric(region.perimeter),
                info.name + (info.demo ? '（示例材料）' : ''), service ? 'm' : info.unit, service ? '三维路径长度＋余量×并行数量' : furniture ? '按件数量' : modes[item.quantityMode],
                item.quantity ?? '待校准', item.purchaseQuantity ?? '待校准', item.unitPrice === '' ? '待填写单价' : item.unitPrice, item.wasteRate,
                item.laborRate, item.materialCost ?? pending, item.laborCost ?? pending, item.additionalCost,
                '', '', item.total ?? pending, '', '', '', info.provenance?.source || '', info.provenance?.priceDate || '', [info.provenance?.region, info.provenance?.spec, opening ? openingDetails(region) : furniture ? furnitureDimensions(region, project) : service ? serviceDetails(region) : ''].filter(Boolean).join(' / ')]);
        }
        rows.push([opening ? '门窗 / 开孔汇总' : service ? '管线汇总' : furniture ? '家具汇总' : region.surfaceType === 'wall' ? '墙面汇总' : region.surfaceType === 'ceiling' ? '天花板汇总' : '区域汇总', project.name, entryName(region), furniture || service ? '' : metric(region.netArea), furniture || service ? '' : metric(region.perimeter),
            '', '', '', '', '', '', '', '', region.materialCost ?? pending, region.laborCost ?? pending,
            region.itemAdditionalCost, region.additionalCost, '', region.subtotal ?? pending, '', '', '']);
    }
    for (const level of pricing.levelSummaries || []) {
        const row = Array(25).fill('');
        row[0] = level.total === null ? '楼层草稿汇总' : '楼层汇总';
        row[1] = project.name;
        row[2] = level.name;
        row[3] = metric(level.netArea);
        row[18] = level.total ?? `已知部分 ${level.knownSubtotal}`;
        rows.push(row);
    }
    rows.push([pricing.pending ? '工程草稿汇总' : '工程汇总', project.name, '', '', '', '', '', '', '', '', '', '', '',
        pricing.materialCost ?? pending, pricing.laborCost ?? pending, '', '', pricing.projectAdditionalCost,
        pricing.subtotal ?? pending, pricing.taxRate, pricing.tax ?? pending, pricing.total ?? pending]);
    return '\uFEFF' + rows.map((row) => {
        const filled = [...row];
        while (filled.length < headers.length)
            filled.push('');
        return filled.map(csvCell).join(',');
    }).join('\r\n') + '\r\n';
}
function safeImageURL(url) {
    const text = String(url ?? '').trim();
    return /^(?:data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]|blob:|\/(?!\/)|\.\.?\/)/i.test(text) ? text : '';
}
function diagramSingleHTML(project) {
    const drawing = project.drawing;
    if (!drawing || !Number.isFinite(drawing.width) || !Number.isFinite(drawing.height))
        return '';
    const imageURL = safeImageURL(drawing.url);
    if (!imageURL)
        return '';
    const pathFor = (points) => {
        if (!Array.isArray(points) || !points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)))
            return '';
        return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') + ' Z';
    };
    const overlays = project.regions.filter((region) => !region.hidden).map((region) => {
        const parts = region.surfaceParts || [{ points: region.points, holes: region.holes || [] }];
        const outer = parts.map(part => pathFor(part.points) + ' ' + (part.holes || []).map(pathFor).join(' ')).join(' ');
        if (!outer)
            return '';
        const requested = region.items?.[0]?.color;
        const color = /^#[0-9a-f]{6}$/i.test(requested ?? '') ? requested : '#a87851';
        const start = region.surfaceParts ? regionInteriorPoint(region) : region.points[0];
        const label = start ? `<text x="${start.x + (region.surfaceParts ? 0 : drawing.width / 100)}" y="${start.y + (region.surfaceParts ? 0 : drawing.width / 50)}" font-size="${Math.max(drawing.width / 65, 10)}" fill="#172b43">${escapeHTML(region.name)}</text>` : '';
        return `<path data-region-id="${escapeHTML(region.id)}" d="${outer}" fill="${color}" fill-opacity=".3" stroke="#354155" stroke-width="${Math.max(drawing.width / 600, 1)}" fill-rule="evenodd"/>${label}`;
    }).join('');
    const furniture = (project.furniture || []).filter(item => !item.hidden).map(item => {
        const stair = isStairKind(item.kind) ? stairPlanGeometry(item, project) : null;
        const footprint = stair?.outline || furnitureFootprint(item, project);
        if (!footprint)
            return '';
        const steps = stair ? stair.steps.map(step => `<path d="${pathFor(step)}" fill="none" stroke="#627364" stroke-width="${Math.max(drawing.width / 850, .6)}"/>`).join('') : '';
        const ascent = stair?.ascentPath?.length > 1 ? `<polyline points="${stair.ascentPath.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="#2d6754" stroke-width="${Math.max(drawing.width / 500, 1)}"/>` : '';
        return `<g data-furniture-id="${escapeHTML(item.id)}"${item.incomingSourceLevel ? ' data-incoming-stair="true" opacity=".65"' : ''}><path d="${pathFor(footprint)} ${(stair?.holes || []).map(pathFor).join(' ')}" fill="#c8d1c7" fill-opacity=".75" fill-rule="evenodd" stroke="#627364" stroke-width="${Math.max(drawing.width / 600, 1)}"/>${steps}${ascent}<text x="${item.position.x}" y="${item.position.y}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.max(drawing.width / 70, 10)}" fill="#34473c">${escapeHTML(item.name)}${item.incomingSourceLevel ? ` · 来自${escapeHTML(item.incomingSourceLevel)}` : ''}</text></g>`;
    }).join('');
    const visibleRoutes = (project.serviceRoutes || []).filter(route => !route.hidden);
    const scale = furnitureScale(project);
    const services = visibleRoutes.map(route => {
        const color = servicePreset(route.presetId).color, width = Math.max(scale ? route.diameter / 100 / scale : 0, drawing.width / 450, 1);
        const points = route.points.map(point => `${point.x},${point.y}`).join(' ');
        const vertices = route.points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="${width * .8}" fill="${color}"/>`).join('');
        return `<g data-service-route-id="${escapeHTML(route.id)}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>${vertices}</g>`;
    }).join('');
    const legend = visibleRoutes.length ? `<div class="service-legend">${visibleRoutes.map(route => {
        const preset = servicePreset(route.presetId), length = serviceMetrics(route, project).pathLength;
        const heights = route.points.map(point => point.z), low = Math.min(...heights), high = Math.max(...heights);
        return `<p data-service-legend="${escapeHTML(route.id)}"><i style="background:${preset.color}"></i><strong>${escapeHTML(route.name)}</strong> · ${escapeHTML(route.spec || preset.name)} · 路径 ${escapeHTML(metric(length))} m · 本层标高 ${escapeHTML(formatQuantity(low / 100))}${high === low ? '' : `–${escapeHTML(formatQuantity(high / 100))}`} m</p>`;
    }).join('')}</div>` : '';
    return `<section class="drawing"><h2>${services ? '图纸、区域、家具与管线' : furniture ? '图纸、区域与家具' : '图纸与区域'}</h2><svg viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="报价区域、家具与管线示意"><image href="${escapeHTML(imageURL)}" width="${drawing.width}" height="${drawing.height}"/>${overlays}${furniture}${services}</svg>${legend}<p>${escapeHTML(drawing.name)}${drawing.page ? ` · 第 ${escapeHTML(drawing.page)} 页` : ''}</p></section>`;
}
function diagramHTML(project) {
    if (!project.levels)
        return diagramSingleHTML(effectiveLevelProject(project));
    const levels = levelProjects(project);
    return levels.map(level => {
        const incoming = levels.filter(source => source.id !== level.id).flatMap(source => (source.project.furniture || []).filter(item => isStairKind(item.kind) && item.stairTargetLevelId === level.id)
            .map(item => ({ ...item, incomingSourceLevel: source.name })));
        const display = effectiveLevelProject(level.project);
        return `<section class="level-diagram"><h2>${escapeHTML(level.name)} · 标高 ${formatQuantity(level.elevation / 100)} m</h2>${diagramSingleHTML({ ...display, furniture: [...(display.furniture || []), ...incoming] })}</section>`;
    }).join('');
}
export function renderExportHTML(project, options = {}) {
    const pricing = exportPricing(project, options);
    if (pricing.kind === 'civil')
        return renderCivilQuoteHTML(project, pricing, options, escapeHTML);
    if (pricing.kind === 'municipal')
        return renderMunicipalQuoteHTML(project, pricing, options, escapeHTML);
    const materials = options.materials ?? project.materialsSnapshot ?? [];
    const amount = (value) => value === null || value === undefined ? '待确认' : `¥ ${formatMoney(value)}`;
    const rate = (value) => {
        if (value === '' || value === null || value === undefined)
            return '待填写单价';
        const text = normalizeDecimal(value, '单价');
        const [whole, fraction = ''] = text.split('.');
        return `¥ ${whole}.${fraction.padEnd(2, '0')}`;
    };
    let demo = false;
    const regions = quoteEntries(pricing).map((region) => {
        const furniture = region.surfaceType === 'furniture';
        const service = region.surfaceType === 'service', opening = region.surfaceType === 'opening';
        const rows = region.items.map((item) => {
            const info = materialInfo(item, materials);
            demo ||= info.demo;
            return `<tr><td>${escapeHTML(info.name)}${info.demo ? ' <span class="badge">示例</span>' : ''}${info.provenance ? `<small class="hint"><br>${escapeHTML(info.provenance.source)} · ${escapeHTML(info.provenance.region || '')} · ${escapeHTML(info.provenance.priceDate || '来源日期未提供')}</small>` : ''}</td><td>${escapeHTML(service ? 'm' : info.unit)}</td><td>${escapeHTML(item.quantity === null ? '待校准' : formatQuantity(item.quantity))}</td><td>${escapeHTML(item.purchaseQuantity === null ? '待校准' : formatQuantity(item.purchaseQuantity))}</td><td>${escapeHTML(rate(item.unitPrice))}</td><td>${escapeHTML(item.wasteRate)}%</td><td>${escapeHTML(amount(item.laborCost))}${service ? `<small class="hint"><br>${escapeHTML(rate(item.laborRate))}/m</small>` : ''}</td><td>${escapeHTML(amount(item.additionalCost))}</td><td>${escapeHTML(amount(item.total))}</td></tr>`;
        }).join('');
        const measurements = opening ? `${escapeHTML(openingDetails(region))}；计价 ${escapeHTML(metric(region.netQuantity))} ${escapeHTML(region.unit)}` : service ? `${escapeHTML(serviceDetails(region))}；净用量 ${escapeHTML(metric(region.netQuantity))} m；采购 ${escapeHTML(metric(region.purchaseQuantity))} m`
            : furniture ? `按件报价：${escapeHTML(region.quantity)} 件　${escapeHTML(furnitureDimensions(region, project))}`
                : `${region.surfaceType === 'wall' ? '净裸露墙面' : region.surfaceType === 'ceiling' ? '天花板净面积' : '净面积'}：${escapeHTML(metric(region.netArea))} m²　施工边界：${escapeHTML(metric(region.perimeter))} m${region.surfaceType === 'wall' ? `　开口扣除：${escapeHTML(metric(region.openingArea))} m²` : ''}`;
        return `<section class="region"${opening ? ' data-quote-kind="opening"' : service ? ' data-quote-kind="service"' : furniture ? ' data-quote-kind="furniture"' : ''}><h2>${escapeHTML(entryName(region))}${opening ? ' · 门窗 / 开孔' : service ? ' · 管线' : furniture ? ' · 家具' : region.surfaceType === 'ceiling' ? ' · 天花板' : ''}</h2><p class="metrics">${measurements}</p><table><thead><tr><th>${opening ? '门窗 / 开孔施工' : service ? '线材 / 管材' : furniture ? '家具' : '材料'}</th><th>单位</th><th>${furniture ? '数量' : '净用量'}</th><th>采购量</th><th>单价</th><th>损耗</th><th>人工费</th><th>${furniture ? '安装 / 运费' : '附加费'}</th><th>小计</th></tr></thead><tbody>${rows || '<tr><td colspan="9">此区域尚未配置材料</td></tr>'}</tbody></table><p class="region-total">附加费 ${escapeHTML(amount(region.additionalCost))}　合计 ${escapeHTML(amount(region.total))}</p></section>`;
    }).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(project.name)} · 材料报价</title><style>
.service-legend{display:flex;flex-wrap:wrap;gap:4px 20px;margin:12px 0;color:#687486;font-size:11px}.service-legend p{margin:0}.service-legend i{display:inline-block;width:18px;height:3px;margin-right:6px;vertical-align:middle}.service-legend strong{font-weight:500;color:#34473c}
body{margin:0;padding:28px;color:#172b43;background:#f4f3ef;font:14px/1.5 "Microsoft YaHei",sans-serif}.sheet{max-width:1100px;margin:auto;background:white;padding:36px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center}h1{font-size:28px;margin:0}h2{font-size:18px;margin:24px 0 8px}.date,.metrics,.hint{color:#687486}.region{break-inside:avoid}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #dce1e6;padding:9px 7px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#f1f4f8}.region-total{text-align:right}.summary{margin-left:auto;max-width:360px}.summary p{display:flex;justify-content:space-between;border-bottom:1px solid #e3e6e9;padding:8px 0;margin:0}.summary .grand{font-size:22px;font-weight:bold}.badge{font-size:10px;background:#f4e9cf;padding:2px 4px;border-radius:3px}.drawing svg{display:block;width:100%;max-height:560px;border:1px solid #e3e6e9}.print-action{border:0;padding:10px 18px;background:#243d58;color:white;border-radius:6px;cursor:pointer}.draft{color:#9a630d;background:#fff1d6;padding:12px}.footer{margin-top:26px;color:#687486;font-size:12px}@page{size:A4 landscape;margin:12mm}@media print{body{padding:0;background:white}.sheet{padding:0;max-width:none}.print-action{display:none}.drawing{break-before:page}th{background:#eee;print-color-adjust:exact}.badge{print-color-adjust:exact}}
</style></head><body><main class="sheet"><header class="top"><div><h1>${escapeHTML(project.name)}</h1><p class="date">${pricing.furniture?.length ? '材料、家具与施工报价' : '材料与施工报价'} · ${escapeHTML(new Date().toLocaleDateString('zh-CN'))}</p></div><button class="print-action" type="button">打印 / 另存为 PDF</button></header>${pricing.pending ? `<p class="draft">报价草稿：尚有用量或单价待确认。${escapeHTML(pricing.pendingReason || '')}</p>` : ''}${regions}<section class="summary"><p><span>${pricing.furniture?.length ? '材料及家具费' : '材料费'}</span><strong>${escapeHTML(amount(pricing.materialCost))}</strong></p><p><span>人工费</span><strong>${escapeHTML(amount(pricing.laborCost))}</strong></p><p><span>附加费合计</span><strong>${escapeHTML(amount(pricing.additionalCost))}</strong></p><p><span>税前小计</span><strong>${escapeHTML(amount(pricing.subtotal))}</strong></p><p><span>税额（${escapeHTML(pricing.taxRate)}%）</span><strong>${escapeHTML(amount(pricing.tax))}</strong></p><p class="grand"><span>含税总价</span><strong>${escapeHTML(amount(pricing.total))}</strong></p></section>${options.includeDrawing === false ? '' : diagramHTML(project)}<p class="footer">材料费按采购量计取，人工费按净用量计取；已保存工程使用单价快照。${pricing.furniture?.length ? '家具按实际件数与填写单价计价，安装和运费单列。' : ''}${demo ? '本报价包含示例材料与演示价格，请替换为实际报价。' : ''}</p></main></body></html>`;
}
function safeFilename(name, extension) {
    return `${String(name || '图纸报价').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '图纸报价'}${extension}`;
}
export function downloadBlob(blob, filename) {
    if (typeof document === 'undefined')
        throw new Error('下载操作需要浏览器环境');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadCSV(project, options = {}) {
    const csv = projectToCSV(project, options);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeFilename(project.name, '.csv'));
}
export async function downloadProjectJSON(project, options = {}) {
    const json = await exportProjectJSON(project, options);
    downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), safeFilename(project.name, '.plan.json'));
}
export function printQuote(project, options = {}) {
    const html = renderExportHTML(project, options);
    const popup = window.open('', '_blank');
    if (!popup)
        throw new Error('浏览器阻止了打印窗口，请允许弹出窗口后重试');
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    const print = () => { popup.focus(); popup.print(); };
    const bindButton = () => popup.document.querySelector('.print-action')?.addEventListener('click', print);
    if (popup.document.readyState === 'complete')
        bindButton();
    else
        popup.addEventListener('load', bindButton, { once: true });
    return popup;
}
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map
//# sourceMappingURL=export.js.map