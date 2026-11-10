import { csvCell, downloadBlob, escapeHTML } from './export.js';
import { formatMoney, formatQuantity } from './pricing.js';
import { calculateProjectBudget, projectBudgetEntries } from './project-budget.js';
import { calculateProjectReadiness } from './project-readiness.js';
const columns = ['行类型', '工程名称', '专业', '楼层', '对象名称', '计价项目', '单位', '计量依据', '净用量', '采购量',
    '单价（元）', '损耗率（%）', '人工单价（元）', '材料费（元）', '人工费（元）', '分项固定费（元）', '对象固定费（元）', '税前金额（元）', '状态', '说明'];
const money = (value) => value === null || value === undefined ? '待确认' : formatMoney(value);
const quantity = (value) => value === null || value === undefined ? '待校准 / 待确认' : formatQuantity(value, 9);
const statusText = (budget, designReady = true) => budget.status === 'empty' ? '尚未选择计价对象' : budget.pending ? '待完善，金额为已定价部分' : designReady ? '报价参数完整' : '计价参数已完整，设计待完善';
const metadataNotes = (budget) => [
    '本表合并已选专业的真实几何报价，工程固定费及税金仅在总汇中计算一次。',
    '原造价工作台方案表独立保存，未加入本表。',
    ...budget.sections.filter(section => !section.included && section.available).map(section => `${section.label}未纳入本次总预算。`),
];
const sourceNote = (item) => [item.demo ? '示例材料价格，请确认实际采购单价' : '', item.provenance?.source,
    item.provenance?.priceDate, item.provenance?.region, item.provenance?.spec, item.provenance?.supplier, item.provenance?.sourceUrl, item.pendingReason].filter(Boolean).join('；');
function basis(entry, item) {
    if (item.quantityBasis)
        return item.quantityBasis;
    if (entry.targetType === 'civil') {
        if (item.materialId === 'civil-formwork')
            return '真实模板面积 × 构件数量';
        if (item.materialId === 'civil-rebar')
            return /指标/.test(item.materialName ?? '') ? '净混凝土体积 × 用户钢筋指标' : '用户钢筋公斤数 × 构件数量';
        return '扣重叠后的净体积 × 构件数量';
    }
    if (entry.targetType === 'municipal') {
        if (item.category === 'earthwork')
            return '真实地形与道路路床之间的挖填量';
        if (item.thickness !== undefined && item.id !== entry.row.id + ':main')
            return item.unit === 'm³' ? `真实净平面面积 × 本层厚度 ${formatQuantity(item.thickness)} cm` : '真实净平面面积';
        if (entry.row.kind === 'river' && item.unit === 'm³')
            return '河道净平面面积 × 用户槽深（矩形估算）';
        return item.unit === 'm²' ? '真实净平面面积 × 数量' : item.unit === 'm³' ? '真实净体积 × 数量' : item.unit === 'm' ? '真实轴线长度 × 数量' : '用户确认件数';
    }
    if (entry.targetType === 'service')
        return '真实三维路径加余量，再乘并行数量';
    if (entry.targetType === 'furniture')
        return '用户确认件数';
    if (entry.targetType === 'opening')
        return item.unit === 'm²' ? '真实开口面积' : item.unit === 'm' ? '真实开口轮廓周长' : '用户确认件数';
    return item.quantityMode === 'area' ? '扣孔后的净面积' : item.quantityMode === 'perimeter' ? '真实边界周长' : '用户确认手工数量';
}
function knownItemAmount(item) {
    if (item.knownTotal !== undefined && item.knownTotal !== null)
        return formatMoney(item.knownTotal);
    const values = [item.knownMaterialCost ?? item.materialCost ?? '0', item.knownLaborCost ?? item.laborCost ?? '0', item.additionalCost ?? '0'];
    const cents = values.reduce((sum, value) => sum + BigInt(formatMoney(value).replace('.', '')), 0n);
    const digits = cents.toString().padStart(3, '0');
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function objectNote(entry) {
    const row = entry.row;
    return [row.pendingReason, ...(row.warnings ?? [])].filter(Boolean).join('；');
}
function csvSummary(project, type, label, amount, status, note = '', section = '') {
    const row = Array(columns.length).fill('');
    row[0] = type;
    row[1] = project.name;
    row[2] = section;
    row[5] = label;
    row[17] = amount ?? '';
    row[18] = status;
    row[19] = note;
    return row;
}
export function projectBudgetToCSV(project, budget = calculateProjectBudget(project)) {
    const readiness = calculateProjectReadiness(project, budget);
    const rows = [columns];
    rows.push(csvSummary(project, '项目资料', '委托单位', null, '', budget.metadata.client));
    rows.push(csvSummary(project, '项目资料', '项目编号', null, '', budget.metadata.reference));
    if (budget.metadata.note)
        rows.push(csvSummary(project, '项目资料', '报价说明', null, '', budget.metadata.note));
    for (const section of budget.sections) {
        if (!section.included) {
            rows.push(csvSummary(project, '排除专业', section.label, null, '未纳入总预算', section.available ? `独立税前已定价金额 ${section.knownSubtotal} 元，未加计。` : '尚无计价对象。', section.label));
            continue;
        }
        for (const entry of projectBudgetEntries(section.id, section.quote)) {
            const row = entry.row;
            for (const item of row.items ?? []) {
                rows.push(['专业分项', project.name, section.label, row.levelName ?? '', row.name, item.materialName || item.name || '计价项目', item.unit ?? '',
                    basis(entry, item), quantity(item.netQuantity ?? item.quantity), quantity(item.purchaseQuantity),
                    item.unitPrice === '' ? '待填写' : item.unitPrice ?? '', item.wasteRate ?? '0', item.laborRate ?? '0',
                    money(item.materialCost), money(item.laborCost), formatMoney(item.additionalCost ?? '0'), '',
                    item.total === null || item.total === undefined ? knownItemAmount(item) : formatMoney(item.total), item.pending ? '待完善 / 已定价部分' : '已确认', sourceNote(item)]);
            }
            const summary = csvSummary(project, '计价对象汇总', row.name, formatMoney(row.knownSubtotal ?? row.knownTotal ?? row.total ?? '0'), row.pending ? '待完善 / 已定价部分' : '已确认', objectNote(entry), section.label);
            summary[3] = row.levelName ?? '';
            summary[4] = row.name;
            summary[16] = formatMoney(row.additionalCost ?? '0');
            rows.push(summary);
        }
        rows.push(csvSummary(project, '专业税前汇总', section.label, section.knownSubtotal, section.pending ? '待完善 / 已定价部分' : '已确认', '此专业金额不含项目固定费与税金，不与明细重复累加。', section.label));
    }
    for (const note of metadataNotes(budget))
        rows.push(csvSummary(project, '计量说明', '', null, '', note));
    for (const issue of readiness.issues)
        rows.push(csvSummary(project, '工程检查', issue.title, null, issue.severity === 'pending' ? '待处理' : '计量说明', issue.message, budget.sections.find(section => section.id === issue.section)?.label));
    rows.push(csvSummary(project, '工程固定费', '项目固定费用（一次）', budget.additionalCost, '已确认'));
    rows.push(csvSummary(project, '工程税前汇总', budget.pending ? '已定价税前小计' : '税前合计', budget.knownSubtotal, statusText(budget, readiness.ready)));
    rows.push(csvSummary(project, '工程税金', `税金（${budget.taxRate}% / 一次）`, budget.knownTax, statusText(budget, readiness.ready)));
    rows.push(csvSummary(project, '工程总汇', budget.status === 'ready' ? '含税总预算' : '已定价部分含税小计', budget.knownTotal, statusText(budget, readiness.ready), budget.pendingReasons.join('；')));
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function reportSection(section) {
    if (!section.included)
        return `<p class="excluded"><strong>${escapeHTML(section.label)}</strong>未纳入本次总预算${section.available ? `，独立税前已定价金额 ¥ ${escapeHTML(section.knownSubtotal)}` : ''}。</p>`;
    const entries = projectBudgetEntries(section.id, section.quote);
    return `<section class="discipline" data-budget-section="${section.id}"><div class="section-title"><h2>${section.label}</h2><span>${section.itemCount} 个计价对象 · ${section.pending ? '已定价税前金额' : '税前金额'} ¥ ${escapeHTML(section.knownSubtotal)}</span></div>${entries.length ? entries.map(entry => {
        const row = entry.row;
        const itemRows = (row.items ?? []).map(item => `<tr><td><strong>${escapeHTML(item.materialName || item.name || '计价项目')}</strong><small>${escapeHTML(basis(entry, item))}${sourceNote(item) ? '<br>' + escapeHTML(sourceNote(item)) : ''}</small></td><td>${escapeHTML(item.unit)}</td><td>${escapeHTML(quantity(item.netQuantity ?? item.quantity))}<small>采购 ${escapeHTML(quantity(item.purchaseQuantity))}</small></td><td>${escapeHTML(item.unitPrice === '' ? '待填写' : item.unitPrice)}<small>损耗 ${escapeHTML(item.wasteRate ?? '0')}% · 人工 ${escapeHTML(item.laborRate ?? '0')}<br>分项固定费 ${escapeHTML(money(item.additionalCost ?? '0'))}</small></td><td>${escapeHTML(item.total === null || item.total === undefined ? knownItemAmount(item) : formatMoney(item.total))}${item.pending ? '<small class="pending-text">已定价部分 / 待完善</small>' : ''}</td></tr>`).join('');
        return `<article class="object"><h3>${escapeHTML(row.levelName ? row.levelName + ' / ' + row.name : row.name)}</h3>${itemRows ? `<table><thead><tr><th>计价项目 / 依据</th><th>单位</th><th>净用量 / 采购量</th><th>单价 / 损耗 / 人工</th><th>税前金额（元）</th></tr></thead><tbody>${itemRows}</tbody></table>` : '<p class="muted">尚未配置计价材料。</p>'}<p class="object-summary">对象固定费 ¥ ${escapeHTML(formatMoney(row.additionalCost ?? '0'))} · ${row.pending ? '已定价税前小计' : '税前小计'} ¥ ${escapeHTML(formatMoney(row.knownSubtotal ?? row.knownTotal ?? row.total ?? '0'))}</p>${objectNote(entry) ? `<p class="muted">${escapeHTML(objectNote(entry))}</p>` : ''}</article>`;
    }).join('') : '<p class="muted">此专业尚无计价对象。</p>'}</section>`;
}
export function renderProjectBudgetReport(project, budget = calculateProjectBudget(project)) {
    const readiness = calculateProjectReadiness(project, budget);
    const issues = readiness.issues.map(issue => `<li><strong>${escapeHTML(issue.title)}</strong> · ${escapeHTML(issue.message)} <small>${issue.severity === 'pending' ? '待处理' : '计量说明'}</small></li>`).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(project.name)} · 工程总预算</title><style>
body{margin:0;background:#f4f5f2;color:#34443e;font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}.sheet{max-width:1056px;margin:24px auto;background:white;padding:40px}header{display:flex;justify-content:space-between;align-items:start;gap:24px;border-bottom:1px solid #dfe5df;padding-bottom:24px}h1{font-size:27px;font-weight:600;margin:0 0 8px}h2{font-size:19px;font-weight:600;margin:0}h3{font-size:14px;margin:24px 0 8px;font-weight:600}.muted,small{color:#748178;font-size:11px}small{display:block;line-height:1.6;font-weight:400;margin-top:3px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:24px 0}.notice{padding:12px 16px;background:#f8f4e9;border-left:2px solid #a68b53;white-space:pre-wrap}.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:24px;border-bottom:1px solid #dfe5df;padding-bottom:12px;margin-top:32px}.section-title span{font-size:12px;color:#748178}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11px}th,td{padding:9px 8px;border-bottom:1px solid #e3e8e1;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#f6f8f4;font-weight:500}th:first-child,td:first-child{text-align:left;width:34%}th:nth-child(2){width:7%}td:not(:first-child){font-variant-numeric:tabular-nums}.object-summary{text-align:right;font-size:11px}.pending-text{color:#947642}.excluded{border:1px solid #e3e8e1;padding:12px;color:#748178}.excluded strong{margin-right:12px}.summary{max-width:400px;margin:32px 0 0 auto}.summary p{display:flex;justify-content:space-between;border-bottom:1px solid #e3e8e1;padding:10px 0;margin:0}.summary .grand{font-size:21px;color:#326451;font-weight:600}.issues{padding-left:18px}.issues li{margin:8px 0}.footer{margin-top:24px;border-top:1px solid #dfe5df;padding-top:16px;color:#748178;font-size:11px}.print-action{border:1px solid #cedacf;border-radius:6px;padding:8px 16px;background:white;color:#34443e;cursor:pointer}.note{white-space:pre-wrap;overflow-wrap:anywhere}.object{break-inside:avoid}thead{display:table-header-group}@page{size:A4 portrait;margin:14mm}@media print{body{background:white}.sheet{margin:0;padding:0}.print-action{display:none}.section-title{break-after:avoid}th{print-color-adjust:exact}}
</style></head><body><main class="sheet"><header><div><h1>${escapeHTML(project.name)}</h1><span class="muted">工程总预算 · ${escapeHTML(new Date().toLocaleDateString('zh-CN'))} · ${escapeHTML(statusText(budget, readiness.ready))}</span></div><button class="print-action" type="button" onclick="window.print()">打印 / 保存 PDF</button></header><div class="meta"><span>委托单位：${escapeHTML(budget.metadata.client || '—')}</span><span>项目编号：${escapeHTML(budget.metadata.reference || '—')}</span></div>${budget.metadata.note ? `<p class="note">${escapeHTML(budget.metadata.note)}</p>` : ''}${budget.status !== 'ready' ? '<p class="notice">' + (budget.status === 'empty' ? '尚未选择计价对象，请先完成工程布置并选择预算范围。' : '当前预算待完善，下列金额仅为已定价部分，不构成完整总预算。') + '</p>' : !readiness.ready ? '<p class="notice">计价参数已完整，设计待完善。请查看工程检查；按件价格等已确认金额保留。</p>' : ''}${budget.sections.map(reportSection).join('')}<section class="summary">${budget.sections.filter(section => section.included).map(section => `<p><span>${escapeHTML(section.label)}税前${section.pending ? '已定价小计' : '小计'}</span><strong>¥ ${escapeHTML(section.knownSubtotal)}</strong></p>`).join('')}<p><span>项目固定费用（一次）</span><strong>¥ ${escapeHTML(budget.additionalCost)}</strong></p><p><span>${budget.pending ? '已定价税前小计' : '税前合计'}</span><strong>¥ ${escapeHTML(budget.knownSubtotal)}</strong></p><p><span>税金（${escapeHTML(budget.taxRate)}% / 一次）</span><strong>¥ ${escapeHTML(budget.knownTax)}</strong></p><p class="grand"><span>${budget.status === 'ready' ? '含税总预算' : '已定价部分含税小计'}</span><strong>¥ ${escapeHTML(budget.knownTotal)}</strong></p></section>${issues ? `<section><h2>工程检查与计量说明</h2><ul class="issues">${issues}</ul></section>` : ''}<footer class="footer">${metadataNotes(budget).map(escapeHTML).join('<br>')}<br>几何计量及用户单价用于当前方案报价。桥梁受力、交通组织和河流水流不在本表验算范围内。</footer></main></body></html>`;
}
const filename = (project) => (project.name || '工程').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
export function downloadProjectBudgetCSV(project, budget = calculateProjectBudget(project)) {
    downloadBlob(new Blob([projectBudgetToCSV(project, budget)], { type: 'text/csv;charset=utf-8' }), `${filename(project)}-工程总预算.csv`);
}
export function printProjectBudgetReport(project, budget = calculateProjectBudget(project)) {
    const popup = window.open('', '_blank');
    if (!popup)
        throw new Error('请允许本地软件打开总预算打印窗口。');
    popup.document.open();
    popup.document.write(renderProjectBudgetReport(project, budget));
    popup.document.close();
}
//# sourceMappingURL=project-budget-export.js.map