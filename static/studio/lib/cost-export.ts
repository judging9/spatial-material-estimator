import type { CostItem, CostSummary } from './cost.js';
import { createCostItem, COST_SECTIONS } from './cost.js';
import { csvCell, escapeHTML, downloadBlob } from './export.js';
import { formatMoney } from './pricing.js';
export type CostExportMeta = { name: string; date?: string };
export function costToCSV(items: CostItem[], summary: CostSummary, meta: CostExportMeta): string {
  const rows: string[][] = [['序号', '专业', '项目编码', '项目名称', '项目特征', '计量单位', '工程量', '综合单价(元)', '合价(元)', '是否估算', '备注']];
  items.forEach((raw, index) => { const item = createCostItem(raw); rows.push([String(index + 1), item.section, item.code, item.name, item.feature,
    item.unit, item.quantity, item.unitPrice, item.amount, item.estimate ? '估算' : '几何计量',
    [item.group, item.priceStatus === 'missing' ? '待填写单价，当前合价按0列示' : item.priceStatus === 'reference' ? '参考单价，需按当地信息价确认' : '', item.note].filter(Boolean).join('；')]); });
  for (const [label, amount] of [['分部分项合计', summary.subtotal], ['措施项目合计', summary.measures], ['其他项目合计', summary.other], ['规费合计', summary.fees], ['税前合计', summary.beforeTax], ['税金', summary.tax], ['含税总价', summary.total]]) {
    rows.push(['', '', '', label, meta.name, '', '', '', amount, '', '本表为方案估算；未定价项不构成完整预算']);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function downloadCostCSV(items: CostItem[], summary: CostSummary, meta: CostExportMeta) {
  const name = meta.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  const date = (meta.date ?? new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  downloadBlob(new Blob([costToCSV(items, summary, meta)], { type: 'text/csv;charset=utf-8' }), `${name}-造价表-${date}.csv`);
}
export function renderCostReport(items: CostItem[], summary: CostSummary, meta: CostExportMeta): string {
  items = items.map(item => createCostItem(item));
  const sectionHTML = COST_SECTIONS.map(section => {
    const rows = items.filter(item => item.section === section);
    if (!rows.length) return '';
    return `<section><h2>${escapeHTML(section)}</h2><table><thead><tr><th>项目 / 特征</th><th>单位</th><th>工程量</th><th>单价</th><th>合价</th></tr></thead><tbody>${rows.map(item => `<tr><td><strong>${escapeHTML(item.name)}</strong>${item.estimate ? ' <span class="badge">估算</span>' : ''}<small>${escapeHTML(item.group || '')} · ${escapeHTML(item.code)}<br>${escapeHTML(item.feature)}<br>${escapeHTML(item.note)}${item.priceStatus === 'missing' ? '<br><span class="badge">待填写单价</span>' : item.priceStatus === 'reference' ? '<br><span class="badge">参考单价</span>' : ''}</small></td><td>${escapeHTML(item.unit)}</td><td>${escapeHTML(item.quantity)}</td><td>${escapeHTML(formatMoney(item.unitPrice))}</td><td>${escapeHTML(item.amount)}</td></tr>`).join('')}</tbody></table></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHTML(meta.name)} · 造价表</title><style>
  body{font:12px "Segoe UI","Microsoft YaHei",sans-serif;color:#29352f;margin:32px}h1{font-size:25px;font-weight:600}h2{font-size:16px;margin:28px 0 12px}small{display:block;color:#718076;font-size:10px;line-height:1.7;font-weight:400}table{width:100%;border-collapse:collapse;table-layout:fixed}th{text-align:left;background:#f4f6f1}th,td{padding:9px 8px;border-bottom:1px solid #e0e6dc;vertical-align:top;overflow-wrap:anywhere}th:first-child{width:48%}td:not(:first-child),th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}thead{display:table-header-group}tr{break-inside:avoid}.badge{font-size:10px;background:#fff2d7;color:#83602a;padding:2px 5px;border-radius:3px}.summary{margin-top:24px;border-top:1px solid #bfcabe;padding:16px 0}.summary p{display:flex;justify-content:space-between;padding:3px 0}.total{font-size:20px;color:#2d6754}.notice{padding:12px;background:#fff7e5;line-height:1.7}footer{color:#718076;margin-top:24px;line-height:1.7}.print-button{padding:8px 15px;float:right;background:white;border:1px solid #d8e0d3;border-radius:6px;cursor:pointer}
  @page{size:A4 portrait;margin:16mm;@bottom-right{content:"第 " counter(page) " 页 / 共 " counter(pages) " 页";font-size:9pt;color:#718076}}@media print{body{margin:0}.print-button{display:none}h2{break-after:avoid}}
  </style></head><body><button class="print-button" onclick="window.print()">打印 / 保存 PDF</button><h1>${escapeHTML(meta.name)}</h1><p>${escapeHTML(meta.date ?? new Date().toLocaleDateString('zh-CN'))} · 方案估算 · 含 ${summary.estimateCount} 项估算</p>${summary.missingPriceCount ? `<p class="notice">${summary.missingPriceCount} 项待填写单价，当前合价按 0 列示，金额为已定价部分，尚不构成完整预算。</p>` : ''}${summary.referencePriceCount ? '<p class="notice">包含参考单价，需按当地信息价、实际做法和施工条件确认。</p>' : ''}${sectionHTML}<div class="summary">${COST_SECTIONS.map(section => `<p><span>${section} · 分部分项</span><strong>${summary.bySection[section]}</strong></p>`).join('')}<p><span>措施项目（含已列措施及 ${summary.measureRate}% 费率措施）</span><strong>${summary.measures}</strong></p><p><span>其他项目</span><strong>${summary.other}</strong></p><p><span>规费</span><strong>${summary.fees}</strong></p><p><span>税前合计</span><strong>${summary.beforeTax}</strong></p><p><span>税金（${summary.taxRate}%）</span><strong>${summary.tax}</strong></p><p class="total"><span>${summary.missingPriceCount ? '已定价部分含税小计' : '含税总价'}</span><strong>¥ ${summary.total}</strong></p></div><footer>本表为方案估算，最终以施工图预算 / 结算为准。项目编码为示意，实际以当地清单规范为准。钢筋、水电和桥梁指标不是施工图精算。</footer></body></html>`;
}
export function printCostReport(items: CostItem[], summary: CostSummary, meta: CostExportMeta) {
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('请允许本地软件打开报价打印窗口');
  popup.document.open(); popup.document.write(renderCostReport(items, summary, meta)); popup.document.close();
}
