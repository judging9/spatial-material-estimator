import { openingPolygon } from './lib/wall-solid.js';
import { polygonArea } from './lib/geometry.js';
import { newId } from './lib/materials.js';
import { escape, icon, measure, money, openDialog, toast } from './ui.js';
import { renderOpeningPosition, updateOpeningPosition } from './opening-position.js';
import { calculateOpeningQuote, defaultOpeningQuote } from './lib/opening-pricing.js';
import { formatQuantity } from './lib/pricing.js';
export const openingName = (opening) => ({ door: '门', window: '窗', hole: '墙面开孔' }[opening.kind]);
function renderOpeningQuote(opening) {
    const config = defaultOpeningQuote(opening), row = calculateOpeningQuote(opening);
    const field = (key, label, value, placeholder = '0') => `<label><span class="field-label">${label}</span><input id="opening-quote-${key}" data-opening-quote-field="${key}" type="number" min="0" step="any" value="${escape(value)}" placeholder="${placeholder}"></label>`;
    return `<section class="panel-section opening-quote-section"><div class="section-head"><h3>${opening.kind === 'hole' ? '开孔施工报价' : '本体与安装报价'}</h3><label class="opening-lock"><input id="opening-quote-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}>计入预算</label></div>${!config.enabled ? '<p class="help">启用后填写你的实际单价，独立计入项目预算。墙面扣洞仍按真实形状计算。</p>' : `
    <label><span class="field-label">计价单位</span><select id="opening-quote-unit">${[['件', '按件 · 手填数量'], ['m²', '按面积 · 真实开口'], ['m', '按长度 · 开口轮廓']].map(([unit, label]) => `<option value="${unit}" ${config.unit === unit ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    ${config.unit === '件' ? field('quantity', '同规格数量（件）', config.quantity) : `<div class="stat-row"><span class="muted">${config.unit === 'm²' ? '真实开口面积' : '真实轮廓长度'}</span><strong data-opening-quote-value="netQuantity">${formatQuantity(row.netQuantity, 4)} ${config.unit}</strong></div>`}
    <div class="opening-quote-grid">${field('unitPrice', `单价（元 / ${config.unit}）`, config.unitPrice, '填写实际单价')}${field('laborRate', `人工（元 / ${config.unit}）`, config.laborRate)}${field('wasteRate', '采购损耗（%）', config.wasteRate)}${field('additionalCost', '固定费用（元）', config.additionalCost)}</div>
    <p id="opening-quote-feedback" class="opening-position-feedback">${row.pending ? escape(row.pendingReason) : '单价由你填写；固定费用每个开口计一次。'}</p>
    <div class="opening-quote-breakdown"><div class="stat-row"><span>采购预算用量</span><strong data-opening-quote-value="purchaseQuantity">${row.purchaseQuantity === null ? '待填数量' : formatQuantity(row.purchaseQuantity, 4) + ' ' + config.unit}</strong></div><div class="stat-row"><span>${opening.kind === 'hole' ? '施工 / 主材费' : '本体材料费'}</span><strong data-opening-quote-value="materialCost">${row.materialCost === null ? (row.netQuantity === null ? '待填数量' : '待填单价') : '¥ ' + money(row.materialCost)}</strong></div><div class="stat-row"><span>人工费</span><strong data-opening-quote-value="laborCost">${row.laborCost === null ? '待填数量' : '¥ ' + money(row.laborCost)}</strong></div></div>
    <div class="opening-quote-total"><span>${opening.kind === 'hole' ? '开孔' : '门窗'}小计</span><strong data-opening-quote-value="total">${row.pending ? '待完善报价' : '¥ ' + money(row.total)}</strong></div><p class="opening-edit-help">${opening.locked ? '位置已锁定，价格仍可编辑。 ' : ''}增加数量只调整预算，不复制图形。独立造价清单请核对范围，避免重复采购。</p>`}</section>`;
}
export function renderOpeningInspector(project, opening, wallQuote) {
    const wall = project.walls.find(w => w.id === opening.wallId);
    const disabled = opening.locked ? 'disabled' : '', field = (key, label, value) => `<label><span class="field-label">${label}</span><span class="input-affix"><input id="opening-position-${key}" type="number" data-opening-position-field="${key}" min="0" step="any" value="${Number(value.toFixed(4))}" ${disabled}><span>cm</span></span></label>`;
    return `<div class="opening-inspector"><section class="panel-section inspector-identity"><div class="section-head"><span class="eyebrow">Opening</span><span class="chip">${openingName(opening)}</span></div><label class="field-label" for="opening-name">名称</label><input id="opening-name" class="inspector-name" data-opening-name value="${escape(opening.name || openingName(opening))}" maxlength="120"><p class="help">开口与所属墙体同步，按真实形状扣除墙面用量。</p></section>
    <section class="panel-section"><div class="section-head"><h3>位置与尺寸</h3><label class="opening-lock"><input id="opening-locked" type="checkbox" ${opening.locked ? 'checked' : ''}>${icon(opening.locked ? 'lock' : 'unlock', 14)}锁定</label></div>${renderOpeningPosition(project, opening)}<div class="opening-position-controls">${field('offset', '距墙起点', opening.offset)}${field('bottom', opening.kind === 'door' ? '门底高度' : '窗台 / 孔底高度', opening.bottom)}</div><p id="opening-position-feedback" class="opening-position-feedback">${opening.locked ? '已锁定相对墙体的位置与尺寸，解锁后可编辑。' : opening.kind === 'door' ? '二维、三维或上方立面拖动可沿墙移动，门底高度保持；也可输入准确位置。' : '二维拖动沿墙移动；三维或上方立面可上下调整。Alt 精细移动，Esc 取消。'}</p><div class="stat-row"><span class="muted">宽 × 高</span><strong>${measure(opening.width / 100)} × ${measure(opening.height / 100)} m</strong></div><div class="stat-row"><span class="muted">真实开口面积</span><strong data-opening-area>${measure(polygonArea(openingPolygon(opening)) / 10000)} m²</strong></div>${opening.kind !== 'hole' ? `<div class="stat-row"><span class="muted">${opening.kind === 'door' ? '门扇' : '窗框'}厚度</span><strong>${measure(opening.depth)} cm</strong></div>` : ''}<button class="button primary full spaced" data-action="edit-opening" data-id="${escape(opening.id)}" ${disabled}>修改尺寸与形状</button><div class="opening-position-cost"><div class="stat-row"><span class="muted">所属墙面净用量</span><strong data-opening-wall-area>${wallQuote ? measure(wallQuote.netArea) + ' m²' : '—'}</strong></div><p class="help">移动不会改变开口自身面积；墙面净量和项目报价会重新计算。</p></div></section>
    ${renderOpeningQuote(opening)}<section class="panel-section"><button class="button subtle full" data-action="select-wall" data-id="${escape(wall.id)}">${icon('wall', 15)}查看所属墙体</button><div class="opening-inspector-actions"><button class="button subtle" data-action="duplicate-opening" data-id="${escape(opening.id)}">${icon('copy', 14)}复制${openingName(opening)}</button><button class="button subtle" data-action="delete-opening" data-id="${escape(opening.id)}">${icon('trash', 14)}移除</button></div><p class="opening-edit-help">开口本体按你填写的价格单独计价，墙面按真实开口扣量。位置、锁定、修改与删除均可撤销。</p></section></div>`;
}
export function updateOpeningInspectorNumbers(project, opening, wallQuote) {
    updateOpeningPosition(project, opening);
    const area = document.querySelector('[data-opening-area]');
    if (area)
        area.textContent = measure(polygonArea(openingPolygon(opening)) / 10000) + ' m²';
    const net = document.querySelector('[data-opening-wall-area]');
    if (net)
        net.textContent = wallQuote ? measure(wallQuote.netArea) + ' m²' : '—';
    const row = calculateOpeningQuote(opening);
    if (!row)
        return;
    for (const key of ['netQuantity', 'purchaseQuantity', 'materialCost', 'laborCost', 'total']) {
        const element = document.querySelector(`[data-opening-quote-value="${key}"]`);
        if (!element)
            continue;
        element.textContent = key === 'netQuantity' || key === 'purchaseQuantity' ? row[key] === null ? '待填数量' : formatQuantity(row[key], 4) + ' ' + row.unit : row[key] === null ? key === 'total' ? '待完善报价' : key === 'laborCost' || row.netQuantity === null ? '待填数量' : '待填单价' : '¥ ' + money(row[key]);
    }
    const feedback = document.querySelector('#opening-quote-feedback');
    if (feedback)
        feedback.textContent = row.pending ? row.pendingReason : '单价由你填写；固定费用每个开口计一次。';
}
/** Dimension-first opening editor. Polygon vertices are real local cm coordinates. */
export function showOpeningEditor(project, wallId, kind, onSave, existing) {
    if (existing?.locked)
        throw new Error('请先在属性面板解锁，再修改开口尺寸。');
    const wall = project.walls.find(w => w.id === wallId);
    if (!wall)
        throw new Error('请先选择一面墙。');
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y), wallHeight = wall.height ?? project.wallHeight ?? 280;
    const editingExisting = existing && project.openings?.some(opening => opening.id === existing.id);
    const width = Math.min(kind === 'door' ? 90 : kind === 'window' ? 120 : 80, length - 2);
    const height = Math.min(kind === 'door' ? 210 : kind === 'window' ? 120 : 80, wallHeight - 2);
    const opening = existing ? structuredClone(existing) : { id: newId('opening'), wallId, kind, shape: 'rectangle', width, height, offset: Math.max(1, (length - width) / 2), bottom: kind === 'door' ? 0 : Math.max(1, Math.min(90, wallHeight - height - 1)), depth: Math.min(kind === 'door' ? 4 : 6, wall.thickness) };
    let ratios = opening.points?.map(p => ({ x: p.x / opening.width, y: p.y / opening.height })) || [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: .72 }, { x: .5, y: 1 }, { x: 0, y: .72 }];
    let collecting = false, dragged = null;
    const field = (name, label, value, unit = 'm') => `<label><span class="field-label">${label}（${unit}）</span><input name="${name}" id="opening-${name}" type="number" min="${name === 'bottom' || name === 'offset' ? '0' : '.01'}" step="any" required value="${unit === 'cm' ? value : value / 100}"></label>`;
    const dialog = openDialog(editingExisting ? `编辑${openingName(opening)}` : `添加${openingName(opening)}`, `<form id="opening-form"><div class="opening-preview"><svg id="opening-preview" role="img" aria-label="墙体立面与开口形状"></svg></div><p id="opening-preview-note" class="help">墙体立面预览 · 尺寸按米填写</p><div class="field-grid">${field('width', '开口宽度', opening.width)}${field('height', '开口高度', opening.height)}${field('offset', '距墙起点', opening.offset)}${field('bottom', '离地高度', opening.bottom)}${kind !== 'hole' ? field('depth', kind === 'door' ? '门扇厚度' : '窗框厚度', opening.depth, 'cm') : ''}<label><span class="field-label">开口形状</span><select name="shape" id="opening-shape"><option value="rectangle">矩形</option><option value="ellipse">圆 / 椭圆</option><option value="polygon">自定义多边形</option></select></label></div><div id="opening-polygon-tools" class="opening-polygon-tools" hidden><button type="button" class="button subtle" id="opening-redraw">重绘轮廓</button><button type="button" class="button subtle" id="opening-close">闭合轮廓</button><span class="help">拖动顶点修改；重绘时点击虚线框内放置顶点。</span></div><p class="help">开口须位于墙体内，不能相互重叠。门窗厚度独立于墙厚；开孔贯穿整面墙。${kind === 'door' ? '门通常从地面开始。' : ''}</p><button type="submit" class="button primary full">${editingExisting ? '应用修改' : '添加到墙体'}</button></form>`, { wide: true, subtitle: '设置一次，二维、三维与墙面报价同步更新。' });
    dialog.querySelector('#opening-shape').value = opening.shape;
    const svg = dialog.querySelector('#opening-preview');
    const nameLabel = document.createElement('label');
    nameLabel.className = 'opening-dialog-name';
    nameLabel.innerHTML = `<span class="field-label">名称</span><input name="openingName" maxlength="120" value="${escape(opening.name || openingName(opening))}" required>`;
    dialog.querySelector('.field-grid').before(nameLabel);
    svg.setAttribute('viewBox', `${-10} ${-10} ${length + 20} ${wallHeight + 20}`);
    const read = () => {
        const form = new FormData(dialog.querySelector('form'));
        const next = { ...opening, name: String(form.get('openingName')).trim(), shape: String(form.get('shape')), width: Number(form.get('width')) * 100, height: Number(form.get('height')) * 100, offset: Number(form.get('offset')) * 100, bottom: Number(form.get('bottom')) * 100, depth: kind === 'hole' ? wall.thickness : Number(form.get('depth')) };
        if (next.shape === 'polygon')
            next.points = ratios.map(p => ({ x: p.x * next.width, y: p.y * next.height }));
        else
            delete next.points;
        return next;
    };
    const path = (points, current) => points.map(p => `${p.x},${wallHeight - p.y}`).join(' ');
    const paint = () => {
        const next = read();
        if (next.shape !== 'polygon')
            collecting = false;
        dialog.querySelector('#opening-polygon-tools').hidden = next.shape !== 'polygon';
        let points = [];
        try {
            points = openingPolygon(next);
        }
        catch {
            if (next.shape === 'polygon')
                points = next.points || [];
        }
        const peers = (project.openings || []).filter(o => o.wallId === wallId && o.id !== opening.id).map(o => `<polygon points="${path(openingPolygon(o), o)}" fill="#e8eae3" stroke="#bdc7ba" stroke-width="1"/>`).join('');
        const validBounds = next.offset >= 0 && next.bottom >= 0 && next.offset + next.width <= length && next.bottom + next.height <= wallHeight;
        svg.innerHTML = `<rect width="${length}" height="${wallHeight}" rx="2" fill="#f1f3ec" stroke="#bbc8b9" stroke-width="1"/>${peers}<rect x="${next.offset}" y="${wallHeight - next.bottom - next.height}" width="${next.width}" height="${next.height}" fill="none" stroke="#9dad9b" stroke-dasharray="4 4"/><${collecting ? 'polyline' : 'polygon'} points="${path(points, next)}" fill="${collecting ? 'none' : '#ffffff'}" stroke="${validBounds ? '#356b57' : '#a45e47'}" stroke-width="2"/>${next.shape === 'polygon' ? ratios.map((p, i) => `<circle data-opening-vertex="${i}" cx="${next.offset + p.x * next.width}" cy="${wallHeight - next.bottom - p.y * next.height}" r="${Math.max(2, length / 160)}" fill="#fff" stroke="#356b57" stroke-width="1.5"/>`).join('') : ''}`;
        dialog.querySelector('#opening-preview-note').textContent = !validBounds ? '开口超出墙体，请调整宽高、位置或离地高度。' : collecting ? `已放置 ${ratios.length} 个顶点，至少三个顶点后点击闭合。` : points.length >= 3 ? `墙体 ${measure(length / 100)} × ${measure(wallHeight / 100)} m · 开口 ${measure(polygonArea(points) / 10000)} m²` : '在虚线框内绘制至少三个顶点。';
    };
    dialog.querySelector('form').addEventListener('input', paint);
    dialog.querySelector('#opening-redraw').addEventListener('click', () => { ratios = []; collecting = true; paint(); });
    dialog.querySelector('#opening-close').addEventListener('click', () => { if (ratios.length < 3) {
        toast('至少放置三个顶点。', true);
        return;
    } collecting = false; paint(); });
    const cursor = (event) => {
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse()), next = read();
        return { x: Math.max(0, Math.min(1, (point.x - next.offset) / next.width)), y: Math.max(0, Math.min(1, (wallHeight - point.y - next.bottom) / next.height)) };
    };
    svg.addEventListener('pointerdown', event => {
        if (read().shape !== 'polygon')
            return;
        const node = event.target.closest('[data-opening-vertex]');
        if (node) {
            dragged = Number(node.getAttribute('data-opening-vertex'));
            svg.setPointerCapture(event.pointerId);
            event.preventDefault();
        }
        else if (collecting) {
            ratios.push(cursor(event));
            paint();
        }
    });
    svg.addEventListener('pointermove', event => { if (dragged !== null) {
        ratios[dragged] = cursor(event);
        paint();
    } });
    svg.addEventListener('pointerup', () => { dragged = null; });
    svg.addEventListener('pointercancel', () => { dragged = null; });
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            if (collecting)
                throw new Error('先点击“闭合轮廓”完成多边形。');
            onSave(read());
            dialog.close();
        }
        catch (error) {
            toast(error.message, true);
        }
    });
    paint();
}
//# sourceMappingURL=opening-editor.js.map