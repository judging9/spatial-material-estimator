import { MUNICIPAL_CATALOG, MUNICIPAL_CATALOG_GROUPS, searchMunicipalCatalog } from './lib/municipal-catalog.js';
import { escape, icon } from './ui.js';
export function renderRoadAuthoring(settings) {
    const layout = settings.roadLayout;
    const width = layout ? layout.lanes * layout.laneWidth + layout.medianWidth : settings.width ?? 600;
    return `<section class="panel-section road-authoring">
    <div class="section-head"><h3>拖出一条道路</h3><span class="chip">${(width / 100).toFixed(1)} m</span></div>
    <div class="road-lane-choices" aria-label="选择新道路车道数">${[2, 4, 6, 8].map(lanes => `<button type="button" data-road-lanes="${lanes}" class="${layout?.lanes === lanes ? 'active' : ''}" aria-pressed="${layout?.lanes === lanes}"><strong>${lanes}</strong><span>双向车道</span></button>`).join('')}</div>
    ${layout ? `<div class="field-grid spaced"><label><span class="field-label">单车道宽 · m</span><input type="number" data-road-draft-field="laneWidth" min="1" max="10" step=".1" value="${layout.laneWidth / 100}"></label><label><span class="field-label">中央分隔 · m</span><input type="number" data-road-draft-field="medianWidth" min="0" max="20" step=".1" value="${layout.medianWidth / 100}"></label></div>` : ''}
    <p class="help">选择车道数，在画布上拖出道路。逐点点击可画折线；靠近连接口会自动对齐，Alt 可临时关闭吸附。</p><p class="help">下方基础道路入口可跟随连接口的路宽与车道；这里的车道快选保留你设定的尺寸。</p>
  </section>`;
}
/** The library is separate from project prices. Every asset starts unpriced. */
export function renderUrbanCatalog(query = '', group = 'all') {
    return `<section class="panel-section urban-catalog">
    <div class="section-head"><h3>城市设施预设</h3><span class="chip">${MUNICIPAL_CATALOG.length}</span></div>
    <label class="urban-catalog-search">${icon('search', 14)}<input id="urban-catalog-search" type="search" value="${escape(query)}" placeholder="搜索座椅、车位、充电桩…" aria-label="搜索城市设施预设"></label>
    <select id="urban-catalog-group" aria-label="筛选城市设施类别"><option value="all" ${group === 'all' ? 'selected' : ''}>全部城市设施</option>${MUNICIPAL_CATALOG_GROUPS.map(category => `<option value="${category.id}" ${group === category.id ? 'selected' : ''}>${escape(category.name)}</option>`).join('')}</select>
    <div class="urban-catalog-grid" id="urban-catalog-grid">${renderUrbanCatalogEntries(query, group)}</div>
    <p class="help">预设提供尺寸与形状，实际单价由你填写。</p>
  </section>`;
}
export function renderUrbanCatalogEntries(query = '', group = 'all') {
    const entries = searchMunicipalCatalog(query, group);
    return entries.length ? entries.map(preset => `<button type="button" class="urban-asset" data-municipal-catalog="${escape(preset.id)}" aria-label="添加${escape(preset.name)}"><span class="urban-asset-icon">${assetSymbol(preset.symbol)}</span><span><strong>${escape(preset.name)}</strong><small>${preset.kind === 'fence' || preset.kind === 'kerb' ? '拖拽或逐点画线' : preset.kind === 'paving' || preset.kind === 'green' ? '圈选实际范围' : '点击放置'} · ${escape(preset.unit)}</small></span>${icon('plus', 13)}</button>`).join('') : '<p class="help urban-catalog-empty">没有匹配的设施，换一个名称或类别。</p>';
}
export function assetSymbol(symbol) {
    const drawings = {
        bench: '<path d="M7 14h18v4H7zM9 9h14v3H9zM10 18v7m12-7v7M5 13v7m22-7v7"/>',
        bin: '<path d="M10 10h12l-1 17H11L10 10ZM8 7h16M13 7V5h6v2M14 13v10m4-10v10"/>',
        recycling: '<path d="M5 11h9v16H5zM18 11h9v16h-9zM4 8h11m2 0h11M8 15h3m10 0h3"/>',
        'bus-stop': '<rect x="8" y="5" width="16" height="14" rx="2"/><path d="M16 19v10M11 8h10v5H11zM11 16h2m6 0h2"/>',
        shelter: '<path d="M4 9h24L25 5H7L4 9ZM7 9v19m18-19v19M9 9v13h14V9M9 24h14"/>',
        sign: '<path d="M5 7h22v12H5zM16 19v10m-5-15 10-4m-3-2 3 2-1 3"/>',
        bollard: '<path d="M12 28V8a4 4 0 0 1 8 0v20M8 28h16M12 12h8m-8 4h8"/>',
        hydrant: '<path d="M12 27V10h8v17M9 27h14M10 10h12M12 7a4 4 0 0 1 8 0M12 16H7v4h5m8-4h5v4h-5"/>',
        charger: '<rect x="8" y="5" width="13" height="22" rx="2"/><path d="m16 9-4 6h5l-4 6m8-12h3v10q0 4 3 4M7 28h16"/>',
        parking: '<rect x="6" y="4" width="20" height="20" rx="2"/><path d="M13 20V8h5a4 4 0 0 1 0 8h-5M16 24v5"/>',
        bicycle: '<circle cx="8" cy="22" r="5"/><circle cx="25" cy="22" r="5"/><path d="m8 22 6-12 8 12H8Zm6-12h5m2-4h3l3 16"/>',
        tree: '<path d="M16 28V16M10 28h12"/><path d="M16 3C4 4 2 19 10 21c3 1 5-1 6-3 1 2 3 4 6 3C30 19 28 4 16 3Z"/>',
        planter: '<path d="M6 18h20l-3 10H9L6 18ZM16 18V8m0 5q-8-9-9-3 0 5 9 3m0-2q8-9 9-3 0 5-9 3"/>',
        building: '<path d="M5 28V8l11-5 11 5v20H5ZM13 28V18h6v10M9 11h3m8 0h3M9 15h3m8 0h3"/>',
        cabinet: '<rect x="7" y="4" width="18" height="24" rx="1"/><path d="M16 4v24m-4-13v4m8-4v4M9 8h4m6 0h4M9 23h4m6 0h4"/>',
        transformer: '<path d="M5 13h22v15H5zM9 4v9m7-9v9m7-9v9M7 7h4m3 0h4m3 0h4M11 18h10m-10 4h10"/>',
        grate: '<path d="M5 7h22v18H5zM9 9v14m5-14v14m5-14v14m4-14v14"/>',
        speedbump: '<path d="M3 25q13-18 26 0H3ZM8 20l3 5m3-9 4 9m2-8 4 8"/>',
        crosswalk: '<path d="M5 7h22M5 25h22M7 10v12m5-12v12m5-12v12m5-12v12m5-12v12"/>',
        playground: '<path d="M3 27 10 5h12l7 22M10 5l12 22M7 14h13M4 24h14m-2-9v8m5-8v8"/>',
        fountain: '<path d="M4 25h24l-4 4H8L4 25ZM16 24V9m0 7q-10-12-11 2m11-6q10-12 11 2M16 9V3"/>',
        art: '<path d="M6 28h20M10 25h12l-2-6-5-3 7-7-7-5-5 8 4 6-4 7Z"/>',
        fence: '<path d="M4 28V5m8 23V5m8 23V5m8 23V5M4 11h24M4 21h24"/>',
        paving: '<path d="M4 7h24v20H4zM4 14h24M4 21h24M10 7v7m12-7v7M16 14v7M10 21v6m12-6v6"/>',
        ramp: '<path d="M4 26h24V9L4 26ZM7 23h15m-8-5h8m-1-5h1M4 29h24"/>',
    };
    return `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[symbol] ?? drawings.building}</svg>`;
}
//# sourceMappingURL=municipal-authoring.js.map