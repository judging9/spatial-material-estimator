import { CIVIL_PRESETS, civilPreset } from './lib/civil.js';
import { escape, icon, measure, money, openDialog, toast } from './ui.js';
const categories = [{ id: 'all', name: '全部' }, { id: 'structure', name: '梁柱板' }, { id: 'foundation', name: '基础' }, { id: 'wall', name: '砌体' }, { id: 'soil', name: '土方' }];
export function civilSymbol(kind) {
    const shape = kind === 'roundColumn' ? '<ellipse cx="24" cy="10" rx="8" ry="4"/><path d="M16 10v27c0 5 16 5 16 0V10"/>' : kind === 'column' ? '<path d="m18 5 12 4v30l-12 4-6-4V9l6-4Zm0 0v38m0-30 12-4"/>' : ['beam', 'stripFooting', 'masonry', 'retainingWall'].includes(kind) ? '<path d="m5 19 32-9 6 5v14l-32 10-6-5V19Zm0 0 6 5 32-9M11 24v15"/>' : ['excavation', 'backfill'].includes(kind) ? '<path d="m5 13 19-6 19 6-19 7-19-7Zm0 0v16l19 12 19-12V13M24 20v21" stroke-dasharray="3 2"/><path d="m14 26 10 6 10-6"/>' : '<path d="m5 19 22-10 16 10-22 11L5 19Zm0 0v7l16 12 22-12v-7M21 30v8"/>';
    return `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
}
export function renderCivilLeft(project, selected, quote, category = 'all') {
    const items = project.civilElements ?? [], presets = CIVIL_PRESETS.filter(p => category === 'all' || (category === 'wall' ? ['masonry', 'retainingWall'].includes(p.kind) : category === 'soil' ? p.category === 'earthwork' : category === 'structure' ? p.category === 'structure' && !['masonry', 'retainingWall'].includes(p.kind) : p.category === category));
    return `<section class="panel-section civil-intro"><span class="eyebrow">Civil design</span><h2>设计构件，算清预算</h2><p class="help">选择柱、梁、板或基础，在图上放置。尺寸与价格由你确定。</p><button class="button subtle full" data-action="civil-template">${icon('layers', 15)}按尺寸生成框架</button></section>
    <section class="panel-section civil-library"><div class="section-head"><h3>土建构件</h3><span class="chip">${CIVIL_PRESETS.length}</span></div><div class="civil-categories" role="group" aria-label="土建构件分类">${categories.map(c => `<button data-civil-category="${c.id}" class="${category === c.id ? 'active' : ''}" aria-pressed="${category === c.id}">${c.name}</button>`).join('')}</div><div class="civil-presets">${presets.map(p => `<button class="civil-preset" data-place-civil="${p.kind}" aria-label="放置${escape(p.name)}"><span>${civilSymbol(p.kind)}</span><strong>${escape(p.name)}</strong><small>${p.width} × ${p.depth} cm</small></button>`).join('')}</div></section>
    <section class="panel-section"><div class="section-head"><h3>本层构件</h3><span class="chip">${items.length}</span></div>${items.map(item => { const row = quote.civilElements?.find(row => row.id === item.id); return `<div class="area-row${item.id === selected ? ' active' : ''}${item.hidden ? ' is-hidden' : ''}"><button class="area-main" data-action="select-civil" data-id="${escape(item.id)}" aria-pressed="${item.id === selected}"><span class="civil-list-symbol">${civilSymbol(item.kind)}</span><span class="area-text"><span class="area-title">${escape(item.name)}</span><span class="area-meta">${measure(row?.netVolume, 3)} m³${item.locked ? ' · 已锁定' : ''}</span></span></button><div class="area-actions"><button class="icon-button" data-action="toggle-civil" data-id="${escape(item.id)}" aria-label="${item.hidden ? '显示' : '隐藏'}构件">${icon(item.hidden ? 'eyeOff' : 'eye', 14)}</button><button class="icon-button" data-action="delete-civil" data-id="${escape(item.id)}" aria-label="删除构件">${icon('trash', 14)}</button></div></div>`; }).join('') || '<p class="help muted">从一个构件开始，或生成框架后逐件调整。</p>'}<div class="stat-row civil-known"><span class="muted">已填写金额（税前）</span><strong>¥ ${money(quote.knownSubtotal)}</strong></div></section>`;
}
export function renderCivilGuide(project, quote) {
    return `<section class="civil-guide"><div class="civil-guide-mark">${icon('cube', 28)}</div><span class="eyebrow">Design to estimate</span><h2>从尺寸开始</h2><p>在左侧选择构件，点击画布放置；拖动边框调尺寸，或在属性中精确输入。</p><div class="civil-guide-steps"><div><span>01</span><strong>布置构件</strong><small>逐件放置，或按柱网生成</small></div><div><span>02</span><strong>确定尺寸</strong><small>宽、深、高与本层标高</small></div><div><span>03</span><strong>填写单价</strong><small>净量、损耗、人工实时计算</small></div></div><button class="button primary full" data-action="civil-template">按尺寸生成框架</button>${!project.calibration.metersPerPixel ? '<button class="button subtle full" data-action="calibrate-drawing">先校准图纸比例</button>' : ''}<p class="help civil-method">框架模板用于布置与预算。钢筋指标法会标记为估算；此工作台不提供承载验算。</p><div class="civil-guide-total"><span>已填写金额（税前）</span><strong>¥ ${money(quote.knownSubtotal)}</strong><small>${quote.civilElements?.length || 0} 组构件 · ${quote.civilElements?.filter(r => r.pending).length || 0} 组待配置</small></div></section>`;
}
export function renderCivilInspector(project, item, row) {
    const locked = item.locked ? 'disabled' : '', shapeLocked = item.locked || item.sourceRegionId ? 'disabled' : '', round = item.kind === 'roundColumn', long = ['beam', 'stripFooting', 'masonry', 'retainingWall'].includes(item.kind);
    const field = (key, label, unit, value, attrs = '') => `<label class="item-field"><span class="field-label">${label}</span><span class="input-affix"><input id="civil-${key}" type="number" data-civil-field="${key}" value="${escape(value)}" ${attrs}><span>${unit}</span></span></label>`;
    return `<section class="panel-section inspector-identity"><div class="section-head"><span class="eyebrow">Civil inspector</span><span class="chip">${escape(civilPreset(item.kind).name)}</span></div><label class="field-label" for="civil-name">构件名称</label><input id="civil-name" class="inspector-name" data-civil-field="name" value="${escape(item.name)}" maxlength="120"><div class="civil-preview">${civilSymbol(item.kind)}</div></section>
    <section class="panel-section"><div class="section-head"><h3>尺寸与位置</h3><label class="civil-lock"><input id="civil-locked" type="checkbox" ${item.locked ? 'checked' : ''}>${icon(item.locked ? 'lock' : 'unlock', 14)}锁定</label></div><div class="field-grid">${field('width', round ? '直径' : long ? '截面宽度' : '宽度', 'cm', item.width, `min="1" max="100000" step="any" ${shapeLocked}`)}${!round ? field('depth', long ? '长度' : '深度', 'cm', item.depth, `min="1" max="100000" step="any" ${shapeLocked}`) : ''}${field('height', ['slab', 'raft', 'cushion'].includes(item.kind) ? '厚度' : '高度', 'cm', item.height, `min="0.1" max="2000" step="any" ${locked}`)}${field('elevation', '本层底标高', 'cm', item.elevation, `min="-5000" max="10000" step="any" ${locked}`)}${field('rotation', '平面角度', '°', item.rotation, `step="any" ${shapeLocked}`)}${field('quantity', '同规格数量', '件', item.quantity, 'min="1" max="1000000" step="1"')}</div>${item.sourceRegionId ? '<div class="civil-link"><span>轮廓跟随房间，保留楼板洞</span><button class="text-button" data-action="detach-civil" ' + locked + '>独立编辑</button></div>' : ''}<p class="help">${item.locked ? '已锁定位置、角度和尺寸，解锁后可编辑。' : item.sourceRegionId ? '轮廓随房间变化。点击独立编辑后保留当前轮廓与孔洞，再调整位置和尺寸。' : '拖动边框改宽深，拖动旋转手柄改方向，也可以输入准确数值。'}标高相对当前楼层地面；数量用于同规格预算，不会生成额外实体。</p></section>
    <section class="panel-section"><div class="section-head"><h3>实际工程量</h3><span class="chip">m³</span></div><div class="stat-row"><span>毛体积 / 件</span><strong data-civil-stat="grossVolume">${measure(row?.singleGrossVolume, 3)} m³</strong></div><div class="stat-row"><span>扣重叠后净体积</span><strong data-civil-stat="netVolume">${measure(row?.netVolume, 3)} m³</strong></div><div class="stat-row"><span>模板接触面积</span><strong data-civil-stat="formworkArea">${measure(row?.formworkArea, 3)} m²</strong></div><p class="help">混凝土交叠按基础、柱、梁、板顺序扣量。土方与砌体按各自施工操作计量。</p><div id="civil-warnings" class="civil-warnings">${(row?.warnings || []).map(w => `<p>${escape(w)}</p>`).join('')}</div></section>
    <section class="panel-section"><div class="section-head"><h3>构件计价</h3></div><div class="field-grid">${field('unitPrice', '材料单价', '元/m³', item.unitPrice, 'min="0" step="any" placeholder="待填写"')}${field('wasteRate', '材料损耗', '%', item.wasteRate, 'min="0" step="any"')}${field('laborRate', '施工人工', '元/m³', item.laborRate, 'min="0" step="any"')}${field('additionalCost', '本组固定费', '元', item.additionalCost, 'min="0" step="any"')}</div><label class="item-field civil-full-field"><span class="field-label">模板单价（空白表示不计）</span><span class="input-affix"><input id="civil-formworkRate" type="number" data-civil-field="formworkRate" value="${escape(item.formworkRate)}" min="0" step="any" placeholder="未启用"><span>元/m²</span></span></label><label class="item-field civil-full-field"><span class="field-label">钢筋计量</span><select id="civil-rebarMode"><option value="none" ${item.rebarMode === 'none' ? 'selected' : ''}>本项不计钢筋</option><option value="ratio" ${item.rebarMode === 'ratio' ? 'selected' : ''}>按体积指标估算</option><option value="manual" ${item.rebarMode === 'manual' ? 'selected' : ''}>输入实际用量</option></select></label>${item.rebarMode !== 'none' ? `<div class="field-grid">${item.rebarMode === 'ratio' ? field('rebarRatio', '估算指标', 'kg/m³', item.rebarRatio, 'min="0" step="any"') : field('rebarQuantity', '实际用量 / 件', 'kg', item.rebarQuantity, 'min="0" step="any"')}${field('rebarPrice', '钢筋单价', '元/kg', item.rebarPrice, 'min="0" step="any" placeholder="待填写"')}</div><p class="help">${item.rebarMode === 'ratio' ? '指标法仅供预算估算；可切换实际用量。' : '实际用量由你依据钢筋清单填写。'}</p>` : ''}</section>
    <div class="property-total"><div class="stat-row"><span>主材采购量</span><strong data-civil-stat="purchaseVolume">${row?.purchaseVolume === null ? '待校准' : measure(Number(row?.purchaseVolume || 0), 3)} m³</strong></div>${[['materialCost', '主材费'], ['laborCost', '人工费'], ['formworkCost', '模板费'], ['rebarCost', '钢筋费']].map(([key, label]) => `<div class="stat-row"><span>${label}</span><strong data-civil-stat="${key}">¥ ${money(row?.[key])}</strong></div>`).join('')}<div class="stat-row"><span>${row?.pending ? '已填写小计（税前）' : '本组构件小计'}</span><strong data-civil-stat="total">¥ ${money(row?.pending ? row?.knownTotal : row?.total)}</strong></div><p id="civil-price-state" class="help">${row?.pending ? escape(row.pendingReason) : '材料 + 人工 + 模板 + 钢筋 + 本组固定费'}</p></div><section class="panel-section"><div class="civil-actions"><button class="button subtle" data-action="duplicate-civil">${icon('copy', 14)}复制构件</button><button class="button subtle" data-action="delete-civil" data-id="${escape(item.id)}">${icon('trash', 14)}删除</button></div></section>`;
}
export function updateCivilNumbers(item, row) {
    for (const key of ['width', 'depth', 'height', 'rotation', 'elevation']) {
        const field = document.querySelector('#civil-' + key);
        if (field && document.activeElement !== field)
            field.value = String(item[key]);
    }
    for (const key of ['grossVolume', 'netVolume', 'formworkArea']) {
        const el = document.querySelector('[data-civil-stat="' + key + '"]');
        if (el)
            el.textContent = measure(row?.[key === 'grossVolume' ? 'singleGrossVolume' : key], 3) + (key === 'formworkArea' ? ' m²' : ' m³');
    }
    const purchase = document.querySelector('[data-civil-stat="purchaseVolume"]');
    if (purchase)
        purchase.textContent = (row?.purchaseVolume === null ? '待校准' : measure(Number(row?.purchaseVolume || 0), 3)) + ' m³';
    for (const key of ['materialCost', 'laborCost', 'formworkCost', 'rebarCost']) {
        const el = document.querySelector('[data-civil-stat="' + key + '"]');
        if (el)
            el.textContent = '¥ ' + money(row?.[key]);
    }
    const total = document.querySelector('[data-civil-stat="total"]');
    if (total)
        total.textContent = '¥ ' + money(row?.pending ? row?.knownTotal : row?.total);
    const state = document.querySelector('#civil-price-state');
    if (state)
        state.textContent = row?.pending ? row.pendingReason : '材料 + 人工 + 模板 + 钢筋 + 本组固定费';
    const warnings = document.querySelector('#civil-warnings');
    if (warnings)
        warnings.innerHTML = (row?.warnings || []).map(w => `<p>${escape(w)}</p>`).join('');
}
export function showCivilTemplate(project, onGenerate) {
    const dialog = openDialog('按尺寸生成框架', `<form id="civil-template-form"><p class="help">创建可编辑的柱、梁、板；可同时生成独立基础。先填写范围与柱网，生成后逐件调整。</p><div class="field-grid">${[['width', '范围宽度（m）', 8], ['depth', '范围深度（m）', 6], ['spanX', '横向柱网最大间距（m）', 4], ['spanY', '纵向柱网最大间距（m）', 3], ['floorHeight', '层高（m）', 3], ['columnSize', '方柱边长（cm）', 40], ['beamWidth', '梁宽（cm）', 25], ['beamHeight', '梁高（cm）', 45], ['slabThickness', '板厚（cm）', 12]].map(([key, label, value]) => `<label><span class="field-label">${label}</span><input name="${key}" id="civil-template-${key}" type="number" min="${['width', 'depth', 'spanX', 'spanY', 'floorHeight'].includes(String(key)) ? .1 : 1}" step="any" value="${value}" required></label>`).join('')}</div><label class="checkbox-label"><input name="foundation" type="checkbox" checked> 同时生成柱下独立基础</label><p class="help">原点距画板左上角 1 m，生成在当前楼层。模板不包含价格与承载验算。</p><button class="button primary full" type="submit">生成可编辑构件</button></form>`, { subtitle: '真实尺寸 · 柱网布置 · 逐件报价' });
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); try {
        const data = new FormData(dialog.querySelector('form')), config = { foundation: data.has('foundation'), origin: { x: 100, y: 100 } };
        for (const key of ['width', 'depth', 'spanX', 'spanY', 'floorHeight', 'columnSize', 'beamWidth', 'beamHeight', 'slabThickness']) {
            config[key] = Number(data.get(key)) * (['width', 'depth', 'spanX', 'spanY', 'floorHeight'].includes(key) ? 100 : 1);
            if (!Number.isFinite(config[key]) || config[key] <= 0)
                throw new Error('请输入大于零的有效尺寸。');
        }
        const count = onGenerate(config);
        dialog.close();
        toast(`已生成 ${count} 个构件，可选中编辑并填写单价`);
    }
    catch (error) {
        toast(error.message, true);
    } });
}
//# sourceMappingURL=civil-panel.js.map