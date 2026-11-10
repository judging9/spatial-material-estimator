import { regionMetrics } from './lib/geometry.js';
import { escape, icon, measure, money } from './ui.js';
import { renderFurnitureList } from './furniture-panel.js';
import { effectivePriceProvenance, describePriceSource } from './lib/price-provenance.js';
const safeColor = (value) => /^#[\da-f]{6}$/i.test(String(value ?? '')) ? String(value) : '#b8ada4';
const unitFor = (item) => item.unit || (item.quantityMode === 'perimeter' ? 'm' : item.quantityMode === 'manual' ? '件' : 'm²');
function pendingLabel(quote, needsMaterial = false, needsQuantity = false) {
    const reasons = [quote?.pendingReason, ...(quote?.pendingReasons ?? [])].filter(Boolean).join('；');
    if (needsMaterial || reasons.includes('选择材料'))
        return '待选材';
    if (needsQuantity || reasons.includes('手工数量'))
        return '待填写用量';
    if (reasons.includes('校准'))
        return '待校准';
    return '待计算';
}
function quantityOptions(item) {
    const unit = unitFor(item);
    const modes = [
        ...(unit === 'm²' ? [{ value: 'area', label: '净施工面积（m²）' }] : []),
        ...(unit === 'm' ? [{ value: 'perimeter', label: '施工边界长度（m）' }] : []),
        { value: 'manual', label: '手动输入用量' },
    ];
    const mismatch = !modes.some(mode => mode.value === item.quantityMode);
    return `${mismatch ? '<option value="" selected disabled>请选择数量依据</option>' : ''}${modes.map(mode => `<option value="${mode.value}"${item.quantityMode === mode.value ? ' selected' : ''}>${mode.label}</option>`).join('')}`;
}
function iconButton(action, label, symbol, attributes = '', disabled = false) {
    return `<button type="button" class="icon-button" data-action="${escape(action)}" ${attributes} aria-label="${escape(label)}" title="${escape(label)}"${disabled ? ' disabled' : ''}>${icon(symbol, 15)}</button>`;
}
function formattedArea(value) {
    return value === null ? '待校准' : `${measure(value)} <span class="inline-unit">m²</span>`;
}
function formattedQuantity(value) {
    if (value === null || value === undefined)
        return '—';
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '—';
}
/** Left sidebar: actual project overview, selectable region list and drawing layers. */
export function renderLeft(project, selectedId, selectedWallId = null, quote, selectedFurnitureId = null, planSettings = '') {
    const metrics = project.regions.map(region => regionMetrics(region, project.calibration));
    const calibrated = Number.isFinite(project.calibration.metersPerPixel) && project.calibration.metersPerPixel > 0;
    const totalArea = calibrated && metrics.every(metric => metric.netArea !== null)
        ? metrics.reduce((sum, metric) => sum + metric.netArea, 0) : null;
    const regions = project.regions.map((region, index) => {
        const active = region.id === selectedId;
        const material = region.items[0];
        const attrs = `data-id="${escape(region.id)}"`;
        return `<div class="area-row${active ? ' active' : ''}${region.hidden ? ' is-hidden' : ''}">
      <button type="button" class="area-main" data-action="select-region" ${attrs} aria-pressed="${active}">
        <span class="color-dot" style="--area-color:${safeColor(material?.color)};background:${safeColor(material?.color)}"></span>
        <span class="area-text"><span class="area-title">${escape(region.name || '未命名区域')}</span><span class="area-meta" title="${escape(region.items.map(item => item.materialName).filter(Boolean).join('、'))}">${formattedArea(metrics[index].netArea)}<span aria-hidden="true"> · </span>${escape(material?.materialName || '待选材')}${region.items.length > 1 ? ` +${region.items.length - 1}` : ''}${region.hidden ? ' · 已隐藏' : ''}</span></span>
      </button>
      <div class="area-actions">
        ${iconButton('rename-region', '重命名区域', 'edit', attrs)}
        ${iconButton('toggle-region', region.hidden ? '显示区域' : '隐藏区域', region.hidden ? 'eyeOff' : 'eye', attrs)}
        ${iconButton('delete-region', '删除区域', 'trash', attrs)}
      </div>
    </div>`;
    }).join('');
    const drawingVisible = project.view.drawingOpacity > 0;
    const grouped = new Set(project.wallShapes?.flatMap(shape => shape.wallIds) || []);
    const straight = (project.walls || []).filter(wall => !grouped.has(wall.id));
    const wallRows = [...straight.map((wall, i) => `<button class="area-row area-main${wall.id === selectedWallId ? ' active' : ''}" data-action="select-wall" data-id="${escape(wall.id)}"><span class="color-dot" style="background:${safeColor(wall.items?.[0]?.color)}"></span><span class="area-text"><span class="area-title">${escape(wall.name || `墙体 ${String(i + 1).padStart(2, '0')}`)}</span><span class="area-meta">${measure(quote?.walls?.find(w => w.id === wall.id)?.netArea)} m² · ${escape(wall.items?.[0]?.materialName || '未配置墙材')}</span></span></button>`), ...(project.wallShapes || []).map(shape => `<button class="area-row area-main${shape.wallIds.includes(selectedWallId) ? ' active' : ''}" data-action="select-wall-shape" data-id="${escape(shape.id)}"><span class="color-dot" style="background:${safeColor(shape.items?.[0]?.color)}"></span><span class="area-text"><span class="area-title">${escape(shape.name)}</span><span class="area-meta">R ${measure(shape.radius / 100)} m · ${measure(quote?.walls?.find(w => w.id === shape.id)?.netArea)} m²</span></span>${icon(shape.kind === 'circle' ? 'circle' : 'arc', 14)}</button>`)].join('');
    return `<section class="panel-section">
      <div class="section-head"><span class="eyebrow">Overview</span></div>
      <div class="overview-name" title="${escape(project.name)}">${escape(project.name || '未命名工程')}</div>
      <div class="stat-row"><span class="muted">区域数量</span><strong>${project.regions.length}</strong></div>
      <div class="stat-row"><span class="muted">净面积合计</span><strong data-stat="total-net-area">${formattedArea(totalArea)}</strong></div>
    </section>
    ${planSettings}<section class="panel-section areas-section">
      <div class="section-head"><div><span class="eyebrow">Areas</span><h3>区域</h3></div><span class="chip">${project.regions.length}</span></div>
      <div class="area-list">${regions || `<div class="empty-panel">${icon(project.drawing?.type === 'plan' ? 'wall' : 'polygon', 24)}<p>${project.drawing?.type === 'plan' ? '墙线闭合后生成房间' : project.drawing ? '从图纸上圈出第一个区域' : '从画墙或导入图纸开始'}</p><span class="muted">房间面积与材料方案会显示在这里。</span></div>`}</div>
    </section>
    ${project.walls?.length ? `<section class="panel-section walls-section"><details${selectedWallId ? ' open' : ''}><summary><span><span class="eyebrow">Walls</span><h3>墙体</h3></span><span class="chip">${straight.length + (project.wallShapes?.length || 0)}</span></summary><div class="wall-list">${wallRows}</div></details></section>` : ''}
    ${renderFurnitureList(project, selectedFurnitureId, quote)}
    <section class="panel-section layers-section">
      <div class="section-head"><div><span class="eyebrow">Layers</span><h3>图层</h3></div>${icon('layers', 16)}</div>
      <div class="layer-row"><span>${icon('image', 16)}<span class="layer-name" title="${escape(project.drawing?.name || '暂无图纸')}">${escape(project.drawing?.name || '暂无图纸')}</span></span><div class="layer-actions">
        ${iconButton('toggle-drawing', drawingVisible ? '隐藏图纸底图' : '显示图纸底图', drawingVisible ? 'eye' : 'eyeOff', `aria-pressed="${drawingVisible}"`, !project.drawing)}
        ${iconButton('remove-drawing', '移除图纸底图', 'trash', '', !project.drawing)}
      </div></div>
      <button type="button" class="layer-row layer-toggle" data-action="toggle-labels" aria-pressed="${project.view.labels}"><span>${icon('polygon', 16)}<span>区域名称</span></span>${icon(project.view.labels ? 'eye' : 'eyeOff', 15)}</button>
      <button type="button" class="button subtle full" data-action="upload">${icon('upload', 15)}<span>${project.drawing ? '更换图纸' : '上传图纸'}</span></button>
      <button type="button" class="text-button full spaced" data-action="update-prices">${icon('refresh', 14)}更新 / 导入材料价格</button>
    </section>`;
}
function itemInput(item, field, label, affix, options = {}) {
    const id = `item-${item.id}-${field}`;
    const value = options.value ?? String(item[field] ?? '0');
    return `<label class="item-field" for="${escape(id)}"><span class="field-label">${escape(label)}</span><span class="input-affix"><input id="${escape(id)}" type="number" inputmode="decimal" min="${options.required ? '0.000001' : '0'}" step="any" data-item-field="${field}" data-item-id="${escape(item.id)}" value="${escape(value)}"${options.required ? ' required placeholder="请输入用量"' : ''}><span>${escape(affix)}</span></span></label>`;
}
export function renderItem(item, materials, quote) {
    const catalogMaterial = materials.find(material => material.id === item.materialId);
    const provenance = effectivePriceProvenance(item);
    const snapshot = item;
    const name = item.materialName || catalogMaterial?.name || '待选择材料';
    const image = item.image ?? catalogMaterial?.image ?? '';
    const color = safeColor(item.color ?? catalogMaterial?.color);
    const demo = snapshot.demo ?? catalogMaterial?.demo ?? false;
    const unit = unitFor(item);
    const manualMissing = item.quantityMode === 'manual'
        && (!String(item.quantity ?? '').trim() || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0);
    const pending = !quote || Boolean(quote.pending) || manualMissing;
    const pendingText = pendingLabel(quote, false, manualMissing);
    const amount = pending ? pendingText : `¥ ${money(quote.total)}`;
    const netQuantity = pending ? '—' : formattedQuantity(quote.netQuantity);
    const purchaseQuantity = pending ? '—' : formattedQuantity(quote.purchaseQuantity);
    const materialAmount = pending ? '—' : `¥ ${money(quote.materialCost)}`;
    const laborAmount = pending ? '—' : `¥ ${money(quote.laborCost)}`;
    return `<article class="item-card" data-item-card="${escape(item.id)}">
    <div class="item-head"><span class="field-label">材料方案</span>${iconButton('remove-item', `移除${name}`, 'close', `data-item-id="${escape(item.id)}"`)}</div>
    <button type="button" class="material-card" data-action="choose-material" data-item-id="${escape(item.id)}" aria-label="更换材料：${escape(name)}">
      <span class="material-preview" style="background:${color}">${image ? `<img src="${escape(image)}" alt="${escape(name)}" loading="lazy">` : icon('image', 24)}</span>
      <span class="material-text"><strong>${escape(name)}</strong><span class="muted">${escape(catalogMaterial?.category || '已保存的材料配置')}<span aria-hidden="true"> · </span>${escape(unit)}</span>${demo ? '<span class="demo-badge">演示材料 · 价格示例</span>' : ''}</span>
      ${icon('chevron', 15)}
    </button>
    ${!catalogMaterial && item.materialId ? '<p class="material-missing muted">材料已移出材料库，当前方案沿用已保存的配置。</p>' : ''}
    <p class="price-provenance help">${provenance?.sourceUrl && /^https?:\/\//i.test(provenance.sourceUrl) ? `<a href="${escape(provenance.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escape(describePriceSource(provenance, item.demo, item.unitPrice === ''))}</a>` : escape(describePriceSource(provenance, item.demo, item.unitPrice === ''))}</p>
    ${catalogMaterial && String(catalogMaterial.unitPrice) !== String(item.unitPrice) ? `<button class="text-button price-refresh" data-action="refresh-item-price" data-item-id="${escape(item.id)}">应用材料库单价 ¥ ${money(catalogMaterial.unitPrice)}</button>` : ''}
    <div class="item-fields field-grid">
      ${itemInput(item, 'unitPrice', '材料单价', `元 / ${unit}`)}
      ${itemInput(item, 'wasteRate', '损耗率', '%')}
      ${itemInput(item, 'laborRate', '人工单价', `元 / ${unit}`)}
      ${itemInput(item, 'additionalCost', '项目附加费', '元')}
    </div>
    <label class="field-label" for="item-${escape(item.id)}-quantity-mode">数量依据</label>
    <select id="item-${escape(item.id)}-quantity-mode" data-item-field="quantityMode" data-item-id="${escape(item.id)}">
      ${quantityOptions(item)}
    </select>
    ${item.quantityMode === 'manual' ? `<div class="manual-quantity">${itemInput(item, 'quantity', '手工用量', unit, { required: true, value: manualMissing ? '' : item.quantity })}</div>${manualMissing ? '<p class="help muted">填写用量后计算本项费用。</p>' : ''}` : ''}
    <div class="cost-breakdown">
      <div class="stat-row"><span class="muted">净用量</span><span>${netQuantity}${pending ? '' : ` <span class="inline-unit">${escape(unit)}</span>`}</span></div>
      <div class="stat-row"><span class="muted">含损耗采购量</span><span>${purchaseQuantity}${pending ? '' : ` <span class="inline-unit">${escape(unit)}</span>`}</span></div>
      <div class="stat-row"><span class="muted">材料费</span><span>${materialAmount}</span></div>
      <div class="stat-row"><span class="muted">人工费</span><span>${laborAmount}</span></div>
    </div>
    <div class="item-cost"><span class="muted">本项小计</span><strong class="cost-value" data-item-total="${escape(item.id)}">${amount}</strong></div>
  </article>`;
}
/** Right sidebar: read-only geometry and editable snapshot-based material items. */
export function renderInspector(project, region, materials, regionQuote) {
    if (!region) {
        return `<div class="empty-inspector"><span class="empty-inspector-icon">${icon(project.drawing ? 'pointer' : 'wall', 30)}</span><span class="eyebrow">Inspector</span><h3>${project.drawing ? '选择一个区域' : '从你的空间开始'}</h3><p>${project.drawing ? '点击图纸上的区域，查看净面积并搭配材料。' : '直接按尺寸画墙，或上传已有平面图。'}</p>${project.drawing ? '<span class="muted">材料、损耗与费用会在这里实时更新。</span>' : `<button type="button" class="button primary" data-action="start-plan">${icon('wall', 15)}开始画图</button><button type="button" class="button subtle" data-action="upload">${icon('upload', 15)}上传图纸</button>`}</div>`;
    }
    const metrics = regionMetrics(region, project.calibration);
    const quoteItems = new Map((regionQuote?.items ?? []).map((item) => [item.id, item]));
    const manualMissing = region.items.some(item => item.quantityMode === 'manual'
        && (!String(item.quantity ?? '').trim() || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0));
    const needsMaterial = region.items.length === 0;
    const pending = Boolean(regionQuote?.pending) || manualMissing || needsMaterial;
    const pendingText = pendingLabel(regionQuote, needsMaterial, manualMissing);
    const pendingHelp = needsMaterial ? '添加材料后计算区域小计。'
        : regionQuote?.pendingReason || (manualMissing ? '填写手工用量后更新小计。' : '完善材料配置后更新小计。');
    const total = !regionQuote || pending ? pendingText : `¥ ${money(regionQuote.total ?? regionQuote.subtotal)}`;
    return `<section class="panel-section inspector-identity">
      <div class="section-head"><span class="eyebrow">Inspector</span><span class="chip">区域</span></div>
      <label class="field-label" for="inspector-region-name">区域名称</label>
      <input id="inspector-region-name" class="inspector-name" type="text" data-region-field="name" data-id="${escape(region.id)}" value="${escape(region.name)}" maxlength="120" autocomplete="off">
    </section>
    <section class="panel-section">
      <div class="section-head"><div><span class="eyebrow">Measurements</span><h3>测量</h3></div>${icon('ruler', 16)}</div>
      <div class="measurement-feature"><span class="field-label">净面积</span><strong data-stat="region-net-area">${metrics.netArea === null ? '待校准' : measure(metrics.netArea)}</strong>${metrics.netArea === null ? '' : '<span class="inline-unit">m²</span>'}</div>
      ${metrics.netArea === null ? '<p class="help muted">校准图纸尺寸后显示实际面积与周长。</p>' : ''}
      <div class="stat-row"><span class="muted">轮廓面积</span><span>${formattedArea(metrics.grossArea)}</span></div>
      <div class="stat-row"><span class="muted">孔洞扣除</span><span>${formattedArea(metrics.holesArea)}</span></div>
      <div class="stat-row"><span class="muted">周长</span><span>${metrics.perimeter === null ? '待校准' : `${measure(metrics.perimeter)} <span class="inline-unit">m</span>`}</span></div>
      <div class="stat-row"><span class="muted">孔洞数量</span><span data-stat="opening-count">${region.holes.length + (project.floorOpenings ?? []).filter(opening => opening.regionId === region.id).length}</span></div>
      ${region.holes.map((hole, index) => `<div class="hole-row"><span class="muted">扣除 ${String(index + 1).padStart(2, '0')}</span><span>${formattedArea(regionMetrics({ points: hole, holes: [] }, project.calibration).netArea)}</span>${iconButton('remove-hole', `移除孔洞${index + 1}`, 'close', `data-hole="${index}"`)}</div>`).join('')}
    </section>
    <section class="panel-section inspector-materials">
      <div class="section-head"><div><span class="eyebrow">Materials</span><h3>材料选配</h3></div><span class="chip">${region.items.length}</span></div>
      ${region.items.map(item => renderItem(item, materials, quoteItems.get(item.id))).join('') || '<p class="help muted">选择材料，为这个区域建立第一项方案。</p>'}
      <button type="button" class="button subtle full" data-action="add-item" data-id="${escape(region.id)}">${icon('plus', 16)}<span>添加材料</span></button>
    </section>
    <section class="panel-section inspector-additional">
      <label class="field-label" for="region-additional-cost">区域固定附加费</label>
      <div class="input-affix"><input id="region-additional-cost" type="number" min="0" step="any" inputmode="decimal" data-region-field="additionalCost" data-id="${escape(region.id)}" value="${escape(region.additionalCost || '0')}"><span>元</span></div>
    </section>
    <div class="property-total"><div class="stat-row"><span>区域小计</span><strong class="cost-value" data-stat="region-total">${total}</strong></div><p class="muted">${pending ? escape(pendingHelp) : '包含材料、人工与附加费。'}</p></div>`;
}
//# sourceMappingURL=panels.js.map