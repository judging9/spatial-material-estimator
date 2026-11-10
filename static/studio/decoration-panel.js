import { FURNITURE_TEMPLATES, furnitureScale } from './lib/furniture.js';
import { FURNITURE_CATEGORIES, furnitureMatches } from './lib/furniture-catalog.js';
import { escape, icon, money } from './ui.js';
import { renderFurnitureList } from './furniture-panel.js';
import { regionMetrics } from './lib/geometry.js';
export const DECORATION_CATEGORIES = FURNITURE_CATEGORIES.map(category => ({ ...category, kinds: FURNITURE_TEMPLATES.filter(template => template.category === category.id).map(template => template.kind) }));
let furnitureSearch = '';
function renderPresets(category, query) {
    const first = ['nightstand', 'wardrobe', 'sofa', 'bed', 'table', 'chair', 'cabinet', 'custom'];
    const templates = [...first.map(kind => FURNITURE_TEMPLATES.find(template => template.kind === kind)), ...FURNITURE_TEMPLATES.filter(template => !first.includes(template.kind))].filter(template => furnitureMatches(template, query, category));
    return templates.length ? templates.map(item => `<button class="decoration-preset" data-place-furniture="${item.kind}" aria-label="放置${item.name}"><span class="decoration-preset-preview"><img src="/studio/assets/furniture/${item.kind}.svg" alt="${item.name}" loading="lazy"></span><strong>${item.name}</strong><small>${item.width} × ${item.depth} cm</small></button>`).join('') : '<p class="help catalog-empty">没有匹配的预设，试试其他关键词。</p>';
}
if (typeof document !== 'undefined')
    document.addEventListener('input', event => {
        const input = event.target;
        if (input.id !== 'furniture-search')
            return;
        furnitureSearch = input.value;
        const grid = document.querySelector('#furniture-presets');
        if (!grid)
            return;
        grid.innerHTML = renderPresets(grid.dataset.catalogCategory || 'all', furnitureSearch);
        const count = document.querySelector('#furniture-catalog-count');
        if (count)
            count.textContent = String(grid.querySelectorAll('[data-place-furniture]').length);
    });
export function renderDecorationLeft(project, selectedFurnitureId, selectedRegionId, quote, category = 'all', query = furnitureSearch) {
    const filter = DECORATION_CATEGORIES.find(value => value.id === category) ?? DECORATION_CATEGORIES[0];
    const templates = FURNITURE_TEMPLATES.filter(template => furnitureMatches(template, query, filter.id));
    return `<section class="panel-section decoration-intro"><span class="eyebrow">Furnish your space</span><h2>布置你的空间</h2><p class="help">家具、插座、灯具与智能设备，点选后在图上放置。</p></section>
    <section class="panel-section decoration-library"><div class="section-head"><h3>家具与设备</h3><span id="furniture-catalog-count" class="chip">${templates.length}</span></div><input id="furniture-search" class="catalog-search" type="search" value="${escape(query)}" placeholder="搜索插座、开关、灯具、家具…" aria-label="搜索家具或设备"><div class="decoration-categories" role="group" aria-label="家具分类">${DECORATION_CATEGORIES.map(item => `<button data-decoration-category="${item.id}" class="${item.id === filter.id ? 'active' : ''}" aria-pressed="${item.id === filter.id}">${item.name}</button>`).join('')}</div>
    <div id="furniture-presets" class="decoration-presets" data-catalog-category="${filter.id}">${renderPresets(filter.id, query)}</div><p class="help">${FURNITURE_TEMPLATES.length} 种常用预设 · 尺寸可改，价格由你填写。</p></section>
    <section class="panel-section decoration-rooms"><div class="section-head"><h3>房间与饰面</h3><span class="chip">${project.regions.length}</span></div>${project.regions.map(region => `<button class="decoration-room${region.id === selectedRegionId ? ' active' : ''}" data-action="select-region" data-id="${escape(region.id)}"><span>${escape(region.name)}</span><small>${regionMetrics(region, project.calibration).netArea === null ? '待校准' : regionMetrics(region, project.calibration).netArea.toFixed(2) + ' m²'} ${icon('chevron', 12)}</small></button>`).join('') || '<p class="help">可以返回绘图划分房间。</p>'}</section>
    ${renderFurnitureList(project, selectedFurnitureId, quote)}`;
}
export function renderDecorationGuide(project, quote) {
    const items = quote.furniture ?? [];
    return `<section class="decoration-guide"><div class="decoration-guide-mark">${icon('cube', 27)}</div><span class="eyebrow">A place for everything</span><h2>从一件家具开始</h2><p>选择家具、水电点位或灯具，在图上摆放并填写价格。电线、网线和水管切换到「水电 · 管线」绘制。</p><div class="decoration-guide-steps"><div><span>01</span><strong>选外形</strong><small>床头柜、衣柜、沙发等</small></div><div><span>02</span><strong>放入空间</strong><small>拖动摆放，旋转方向</small></div><div><span>03</span><strong>填写价格</strong><small>按数量实时计算报价</small></div></div>${!furnitureScale(project) ? '<button class="button subtle full" data-action="calibrate-drawing">校准图纸实际尺寸</button><p class="help">校准后按实际尺寸显示家具。</p>' : ''}<div class="decoration-guide-total"><span>${project.levels?.length > 1 ? '全楼层已填写家具小计' : '已填写家具小计'}</span><strong>¥ ${money(quote.knownFurnitureCost)}</strong><small>${items.length} 组家具 · ${items.filter(item => item.pending).length} 组待填价格</small></div><button class="button subtle full" data-workspace="plan">${icon('edit', 14)}返回修改户型</button></section>`;
}
//# sourceMappingURL=decoration-panel.js.map