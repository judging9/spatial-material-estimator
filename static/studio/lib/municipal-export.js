import { formatMoney, formatQuantity, normalizeDecimal } from './pricing.js';
import { municipalFootprints, municipalElementPreset, municipalEffectiveWidth, isMunicipalPath } from './municipal-design.js';
const measurement = (value) => value === null || value === undefined ? '待校准' : formatQuantity(value);
const balanceMeasurement = (value) => value === null || value === undefined || value === '' ? '待确认' : formatQuantity(value);
const isEarthworkCharge = (item) => ['earthwork-balance', 'earthwork-transfer'].includes(item.category);
const hasQuantityBasis = (item) => isEarthworkCharge(item) || ['bridge', 'tunnel'].includes(item.category);
const itemRate = (item) => item.unitPrice === '' ? ((isEarthworkCharge(item) || item.category === 'bridge') && item.netQuantity === '0' ? '零量无需单价' : '待填写单价') : normalizeDecimal(item.unitPrice, '单价');
const itemQuantity = (item, value) => isEarthworkCharge(item) ? balanceMeasurement(value) : measurement(value);
const transferDescription = (pricing) => pricing.earthworkTransfer?.enabled ? `跨道路土方调配：优先最大场内复用，再在同复用量下最小运输费；总调运 ${balanceMeasurement(pricing.earthworkTransfer.transferredNatural)} m³ 天然方；跨路运输按来源道路松方 × 用户运距计价，已计入来源道路分项` : '';
function balanceDetails(row) {
    const balance = row.roadEngineering?.earthworkBalance, config = row.roadEngineering?.earthworkBalanceConfig;
    if (!balance?.enabled)
        return [];
    const transfer = row.roadEngineering?.interRoadTransfer;
    const result = [transfer ? '已应用工程跨道路调配，以下借方和弃方为调运后的外部剩余量' : `土方调配按单条实绘道路，预算份数 ${row.quantity} 仅倍计费用`,
        `可利用挖方 ${balanceMeasurement(config?.usableCutPercent)} % / 压实填方转天然方 ${balanceMeasurement(config?.naturalPerCompactedFill)} / 天然方转松方 ${balanceMeasurement(config?.loosePerNatural)}`];
    if (balance.volumes) {
        const v = balance.volumes;
        result.push(`天然方：填筑需求 ${balanceMeasurement(v.fillDemandNatural)}、场内复用 ${balanceMeasurement(v.reuseNatural)}、借方 ${balanceMeasurement(v.borrowNatural)}、弃方 ${balanceMeasurement(v.spoilNatural)} m³`, `松方：场内复用 ${balanceMeasurement(v.reuseLoose)}、借方 ${balanceMeasurement(v.borrowLoose)}、弃方 ${balanceMeasurement(v.spoilLoose)} m³`);
    }
    else
        result.push('土方调配待确认：' + (balance.pendingReason ?? '请补完整测量和转换参数'));
    if (transfer)
        result.push(`跨路调入 ${balanceMeasurement(transfer.incomingNatural)} / 跨路调出 ${balanceMeasurement(transfer.outgoingNatural)} m³ 天然方；道路内部复用量不变`);
    for (const [key, name] of [['reuseHaul', '场内复用'], ['borrowHaul', '借方'], ['spoilHaul', '弃方']])
        if (config?.[key]?.enabled)
            result.push(`${name}运输距离 ${balanceMeasurement(config[key].distanceKm)} km；工程量按松方 × 运距`);
    return result;
}
const details = (row) => [municipalElementPreset(row).name, `实绘路径 ${measurement(row.pathLength)} m`, `平面净量 ${measurement(row.area)} m²`, `交叠扣量 ${measurement(row.overlapArea)} m²`,
    `宽 ${measurement(municipalEffectiveWidth(row))} cm`, `总厚 / 高 ${measurement(row.totalDepth)} cm`, `起点 / 统一标高 ${measurement(row.elevation)} cm`, `预算份数 ${row.quantity}`,
    ...(row.kind === 'facility' ? [`深 ${measurement(row.depth)} cm / 朝向 ${measurement(row.rotation ?? 0)}°`] : []),
    ...(row.roadLayout ? [`双向 ${row.roadLayout.lanes} 车道 / 单车道宽 ${measurement(row.roadLayout.laneWidth)} cm / 中央分隔带 ${measurement(row.roadLayout.medianWidth)} cm`] : []),
    ...(row.junction ? [`${row.junction.arms} 支路 / 支路长 ${measurement(row.junction.armLength)} cm / 朝向 ${measurement(row.junction.rotation)}°`, ...(row.kind === 'roundabout' ? [`中心岛半径 ${measurement(row.junction.islandRadius)} cm（不计路面）`] : [])] : []),
    ...(row.trafficSignal ? [`展示灯色 ${({ red: '红', amber: '黄', green: '绿' })[row.trafficSignal.phase]} / 朝向 ${measurement(row.trafficSignal.rotation)}°`] : []),
    ...(row.kind === 'river' ? [`矩形河槽深 ${measurement(row.depth)} cm，河槽体积 ${measurement(row.volume)} m³`] : []),
    ...(row.bridgeEngineering ? [`中间桥墩 ${measurement(row.bridgeEngineering.pierCount)} 件 / 两侧栏杆 ${measurement(row.bridgeEngineering.railingLength)} m`,
        `桥墩间距 ${measurement(row.bridgeOptions?.pierSpacing ?? 1000)} cm / 墩高 ${measurement(row.bridgeOptions?.pierHeight ?? 400)} cm / 栏高 ${measurement(row.bridgeOptions?.railingHeight ?? 110)} cm`,
        `桥墩${row.bridgeOptions?.pierPricingEnabled ? '独立计费' : '纳入主项综合报价范围'}；栏杆${row.bridgeOptions?.railingPricingEnabled ? '独立计费' : '纳入主项综合报价范围'}`] : []),
    ...(row.tunnelEngineering?.enabled ? [`隧道里程 ${measurement(row.tunnel.startStation)}–${measurement(row.tunnel.endStation)} m / ${row.tunnel.shape === 'arch' ? '拱形' : '矩形'}截面`,
        `净宽 ${measurement(row.tunnelEngineering.netWidth)} m / 净高 ${measurement(row.tunnelEngineering.clearHeight)} m / 衬砌厚 ${measurement(row.tunnel.liningThickness)} m`,
        `三维隧道长度 ${measurement(row.tunnelEngineering.length)} m / 水平长度 ${measurement(row.tunnelEngineering.horizontalLength)} m`,
        `净空体积 ${measurement(row.tunnelEngineering.voidVolume)} m³（几何说明，未独立按体积收费）`,
        row.tunnel.pricingEnabled ? '隧道独立计费：真实三维隧道路线长度 × 预算份数，按米综合计价' : '隧道独立计费未开启，未新增隧道费用',
        '道路铺筑仍保留；隧道段覆土不计入普通路床挖填'] : []),
    ...(row.roadEngineering ? [`设计路线 ${measurement(row.roadEngineering.designLength)} m`, `最大绝对纵坡 ${measurement(row.roadEngineering.maxAbsGrade * 100)} %`,
        ...(row.roadEngineering.verticalCurves?.length ? [`竖曲线 ${row.roadEngineering.verticalCurves.map(curve => `里程${measurement(curve.station)} m / 长${measurement(curve.length)} m`).join('、')}`, `控制弦高误差 ${measurement(row.roadEngineering.curveTolerance ?? .002)} m`] : []),
        ...(row.roadEngineering.crossfallPoints?.length ? [`横坡里程表 ${row.roadEngineering.crossfallPoints.map(point => `${measurement(point.station)} m：左 ${measurement(point.leftSlope)} / 右 ${measurement(point.rightSlope)} %`).join('、')}（按里程线性过渡，正值向外升高）`, `路面控制高程误差 ${measurement(row.roadEngineering.curveTolerance ?? .002)} m`] : row.roadEngineering.crossSection ? [`左右横坡 ${measurement(row.roadEngineering.crossSection.leftSlope)} / ${measurement(row.roadEngineering.crossSection.rightSlope)} %（正值向外升高）`] : []),
        ...(row.roadEngineering.sideSlopes?.enabled ? [`左右挖方边坡 H:V ${measurement(row.roadEngineering.sideSlopes.leftCut)}:1 / ${measurement(row.roadEngineering.sideSlopes.rightCut)}:1`, `左右填方边坡 H:V ${measurement(row.roadEngineering.sideSlopes.leftFill)}:1 / ${measurement(row.roadEngineering.sideSlopes.rightFill)}:1`, `边坡断面间距 ${measurement(row.roadEngineering.sideSlopes.interval ?? 2)} m / 最大找坡宽度 ${measurement(row.roadEngineering.sideSlopes.maxWidth)} m`] : []),
        ...(row.roadEngineering.earthworks ? [`路床挖方 ${measurement(row.roadEngineering.earthworks.cutVolume)} m³`, `路床填方 ${measurement(row.roadEngineering.earthworks.fillVolume)} m³`, `地形覆盖 ${measurement(row.roadEngineering.earthworks.coveredArea)} / ${measurement(row.roadEngineering.earthworks.designArea)} m²`] : [])] : []), ...balanceDetails(row), ...(row.warnings ?? [])].join('；');
/** Established 25-column quote format: item fixed fees, element fixed fees,
 * and the shared project fixed fee occupy their own scope exactly once. */
export function municipalToCSV(project, pricing, csvCell) {
    const headers = ['行类型', '工程名称', '市政设施名称', '平面净面积（m²）', '轮廓周长（m）', '分项名称', '单位', '计量方式', '净用量', '采购量（含损耗）', '单价（元）', '损耗率（%）', '人工单价（元）', '材料费（元）', '人工费（元）', '分项固定费（元）', '设施固定费（元）', '工程固定费（元）', '税前小计（元）', '税率（%）', '税额（元）', '总价（元）', '价格来源', '价格日期', '规格 / 结构层厚度'];
    const rows = [headers];
    for (const element of pricing.municipalElements) {
        for (const item of element.items) {
            const row = Array(25).fill('');
            Object.assign(row, { 0: '市政分项', 1: project.name, 2: element.name, 3: measurement(element.area), 4: measurement(element.perimeter), 5: item.name || item.materialName, 6: item.unit,
                7: hasQuantityBasis(item) ? item.quantityBasis : item.unit === '件' ? '用户预算数量' : item.unit === 'm' ? '实绘路径长度' : item.unit === 'm³' ? '净体积' : '净面积', 8: item.netQuantity ?? (isEarthworkCharge(item) ? '待确认' : '待校准'), 9: item.purchaseQuantity ?? (isEarthworkCharge(item) ? '待确认' : '待校准'),
                10: item.unitPrice === '' ? itemRate(item) : item.unitPrice, 11: item.wasteRate, 12: item.laborRate, 13: item.materialCost ?? (isEarthworkCharge(item) ? '待确认' : '待填写单价'), 14: item.laborCost ?? (isEarthworkCharge(item) ? '待确认' : '待校准'), 15: item.additionalCost,
                18: item.total ?? `已知部分 ${item.knownTotal}`, 24: `${details(element)}；${isEarthworkCharge(item) ? `本分项按${item.quantityBasis}计量；与原挖填综合单价的包含范围由用户确认${item.transferRoute ? `；${item.transferRoute.name}：天然方 ${balanceMeasurement(item.transferRoute.naturalQuantity)} m³ / 来源松方 ${balanceMeasurement(item.transferRoute.looseQuantity)} m³ / 运距 ${balanceMeasurement(item.transferRoute.distanceKm)} km` : ''}` : ['bridge', 'tunnel'].includes(item.category) ? item.quantityBasis : item.category === 'earthwork' ? '按真实设计路床与地形的高程差分别积分；单价为用户综合施工单价' : `本分项厚度 ${measurement(item.thickness)} cm`}` });
            row[22] = item.provenance?.source ?? '';
            row[23] = item.provenance?.priceDate ?? '';
            row[24] += [item.provenance?.region, item.provenance?.spec, item.provenance?.supplier, item.provenance?.sourceUrl].filter(Boolean).map(value => '；' + value).join('');
            rows.push(row);
        }
        const row = Array(25).fill('');
        Object.assign(row, { 0: '市政设施汇总', 1: project.name, 2: element.name, 3: measurement(element.area), 4: measurement(element.perimeter), 13: element.materialCost ?? '待确认', 14: element.laborCost ?? '待确认', 16: element.additionalCost, 18: element.total ?? `已知部分 ${element.knownSubtotal}`, 24: details(element) });
        rows.push(row);
    }
    const total = Array(25).fill('');
    Object.assign(total, { 0: pricing.pending ? '市政草稿汇总' : '市政工程汇总', 1: project.name, 3: measurement(pricing.netArea), 13: pricing.materialCost ?? '待确认', 14: pricing.laborCost ?? '待确认', 17: pricing.projectAdditionalCost, 18: pricing.subtotal ?? `已知部分 ${pricing.knownSubtotal}`, 19: pricing.taxRate, 20: pricing.tax ?? '待确认', 21: pricing.total ?? '待确认', 24: `实绘总长度 ${measurement(pricing.totalLength)} m；平面净面积 ${measurement(pricing.netArea)} m²${pricing.earthworkTransfer?.enabled ? '；' + transferDescription(pricing) : ''}` });
    rows.push(total);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function municipalDiagram(project, escape) {
    const drawing = project.drawing;
    if (!drawing)
        return '';
    const path = (parts) => parts.map(part => [part.points, ...(part.holes ?? [])].map(ring => ring.map((p, index) => `${index ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') + ' Z').join(' ')).join(' ');
    const polygons = (project.municipalElements ?? []).filter(element => !element.hidden).map(element => {
        const preset = municipalElementPreset(element), parts = municipalFootprints(element, project);
        const outline = parts?.length ? `<path d="${path(parts)}" fill="${preset.color}" fill-opacity=".24" fill-rule="evenodd" stroke="${preset.color}" stroke-width="${Math.max(1, drawing.width / 900)}"/>` : '';
        const route = element.points.length > 1 && isMunicipalPath(element.kind) ? `<polyline points="${element.points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${preset.color}" stroke-width="${Math.max(1, drawing.width / 900)}"/>` : '';
        const center = element.points[Math.floor(element.points.length / 2)];
        return `<g data-municipal-element-id="${escape(element.id)}">${outline}${route}${center ? `<text x="${center.x}" y="${center.y}" font-size="${Math.max(10, drawing.width / 95)}" fill="#34473c">${escape(element.name)}</text>` : ''}</g>`;
    }).join('');
    const safeURL = /^(?:data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]|blob:|\/(?!\/)|\.\.?\/)/i.test(drawing.url ?? '') ? drawing.url : '';
    return `<section class="site-diagram"><h2>实绘市政布置</h2><svg viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="真实市政道路、管线与设施">${safeURL ? `<image href="${escape(safeURL)}" width="${drawing.width}" height="${drawing.height}"/>` : ''}${polygons}</svg><p class="muted">${escape(drawing.name)} · 图示采用实际净占地和路径；预算份数不复制几何。</p></section>`;
}
function transferQuoteSection(pricing, escape) {
    const plan = pricing.earthworkTransfer;
    if (!plan?.enabled)
        return '';
    return `<section class="transfer-summary"><h2>跨道路土方调配</h2><p class="muted">${escape(transferDescription(pricing))}。仅使用已确认土料可用的用户路线。</p><table><thead><tr><th>运输路线</th><th>天然方 m³</th><th>来源松方 m³</th><th>运距 km</th><th>工程量 m³·km</th><th>单价 元/(m³·km)</th><th>运输费 元</th></tr></thead><tbody>${plan.routes.map(route => `<tr><td>${escape(route.name)}</td><td>${escape(balanceMeasurement(route.naturalQuantity))}</td><td>${escape(balanceMeasurement(route.looseQuantity))}</td><td>${escape(balanceMeasurement(route.distanceKm))}</td><td>${escape(balanceMeasurement(route.haulQuantity))}</td><td>${escape(route.unitPrice === '' && route.haulQuantity === '0' ? '零量无需单价' : route.unitPrice || '待填写')}</td><td>${escape(route.amount === null ? '待确认' : formatMoney(route.amount))}</td></tr>`).join('')}</tbody></table><p class="muted">${plan.pending ? escape(plan.pendingReason) : '此表用于说明调运依据；运输费用已列在来源道路分项，不重复加计。'}</p></section>`;
}
export function renderMunicipalQuoteHTML(project, pricing, options, escape) {
    const amount = (value) => value === null || value === undefined ? '待确认' : '¥ ' + formatMoney(value);
    const rate = (value) => value === '' ? '待填写单价' : normalizeDecimal(value, '单价');
    const elements = transferQuoteSection(pricing, escape) + pricing.municipalElements.map((element) => {
        const rows = element.items.map((item) => `<tr><td>${escape(item.name || item.materialName)}${item.category === 'tunnel' ? `<p class="muted">${escape(item.quantityBasis)}</p>` : ''}${item.provenance ? `<p class="muted">${escape([item.provenance.source, item.provenance.priceDate || '日期未注明', item.provenance.region, item.provenance.supplier, item.provenance.sourceUrl].filter(Boolean).join(' · '))}</p>` : ''}</td><td>${escape(item.unit)}</td><td>${escape(item.category === 'earthwork' || hasQuantityBasis(item) ? '—' : measurement(item.thickness))}</td><td>${escape(itemQuantity(item, item.netQuantity))}</td><td>${escape(itemQuantity(item, item.purchaseQuantity))}</td><td>${escape(itemRate(item))}</td><td>${escape(item.wasteRate)}%</td><td>${escape(rate(item.laborRate))}</td><td>${escape(amount(item.materialCost))}</td><td>${escape(amount(item.laborCost))}</td><td>${escape(amount(item.additionalCost))}</td><td>${escape(amount(item.total))}</td></tr>`).join('');
        return `<section class="element" data-quote-kind="municipal" data-municipal-id="${escape(element.id)}"><h2>${escape(element.name)}</h2><p class="muted">${escape(details(element))}</p><table><thead><tr><th>分项</th><th>单位</th><th>厚度 cm</th><th>净用量</th><th>采购量</th><th>单价</th><th>损耗</th><th>人工单价</th><th>材料费</th><th>人工费</th><th>分项固定费</th><th>小计</th></tr></thead><tbody>${rows}</tbody></table><p class="element-total">设施固定费 ${escape(amount(element.additionalCost))}　${element.pending ? '已知税前金额 ' + escape(amount(element.knownSubtotal)) : '合计 ' + escape(amount(element.total))}</p></section>`;
    }).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.name)} · 市政预算</title><style>
body{margin:0;padding:28px;background:#f4f5f1;color:#34473c;font:13px/1.6 "Microsoft YaHei",sans-serif}.sheet{max-width:1200px;margin:auto;background:#fff;padding:32px}header{display:flex;align-items:center;justify-content:space-between;gap:24px}h1{font-size:26px;font-weight:500;margin:0}h2{font-size:16px;font-weight:500;margin:24px 0 8px}.muted{color:#788677;font-size:11px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{text-align:right;border:1px solid #e0e5dc;padding:8px 5px}th{font-weight:500;background:#f3f6ef}td:first-child,th:first-child{text-align:left}.element{break-inside:avoid}.element-total{text-align:right;margin:10px 0}.summary{margin:24px 0 0 auto;max-width:350px}.summary p{display:flex;justify-content:space-between;border-bottom:1px solid #e2e7de;padding:10px 0;margin:0}.summary .grand{font-size:20px;color:#356b57}.draft{background:#f9f4e7;padding:12px;color:#927246}.print-action{border:1px solid #ccd8c8;border-radius:5px;padding:8px 16px;background:#356b57;color:#fff;cursor:pointer}.site-diagram svg{display:block;width:100%;max-height:560px;border:1px solid #e0e5dc}.footer{font-size:11px;color:#788677;margin-top:24px}@page{size:A4 landscape;margin:12mm}@media print{body{padding:0;background:#fff}.sheet{padding:0}.print-action{display:none}.site-diagram{break-before:page}th{print-color-adjust:exact}}
</style></head><body><main class="sheet"><header><div><h1>${escape(project.name)}</h1><p class="muted">市政设计预算 · ${escape(new Date().toLocaleDateString('zh-CN'))}</p></div><button class="print-action" type="button">打印 / 另存为 PDF</button></header>${pricing.pending ? `<p class="draft">预算草稿：${escape(pricing.pendingReason)}</p>` : ''}${elements}<section class="summary"><p><span>材料费</span><strong>${escape(amount(pricing.materialCost))}</strong></p><p><span>人工费</span><strong>${escape(amount(pricing.laborCost))}</strong></p><p><span>固定费用合计</span><strong>${escape(amount(pricing.additionalCost))}</strong></p><p><span>税前金额</span><strong>${escape(amount(pricing.subtotal))}</strong></p><p><span>税金（${escape(pricing.taxRate)}%）</span><strong>${escape(amount(pricing.tax))}</strong></p><p class="grand"><span>含税总预算</span><strong>${escape(amount(pricing.total))}</strong></p></section>${options.includeDrawing === false ? '' : municipalDiagram(project, escape)}<p class="footer">实绘路径与净占地用于计量，道路相交面积按实际几何扣重。材料采购包含损耗，人工按净量计价；单价均由用户填写。结构层、设施与项目固定费用各计一次，工程税率统一计算。${pricing.warnings?.length ? '<br>' + escape(pricing.warnings.join('；')) : ''}</p></main></body></html>`;
}
//# sourceMappingURL=municipal-export.js.map