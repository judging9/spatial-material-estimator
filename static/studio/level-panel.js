import { activeLevel, levelProjects, ceilingHeight } from './lib/levels.js';
import { renderItem } from './panels.js';
import { escape, icon, measure, money, openDialog } from './ui.js';
import { incomingStairs, defaultStairSettings } from './lib/stair-links.js';
import { isStairKind } from './lib/stairs.js';
export function renderLevelSwitcher(project) {
    if (project.drawing?.type !== 'plan')
        return '';
    const current = activeLevel(project), levels = levelProjects(project);
    return `<div class="level-switcher"><span aria-hidden="true">${icon('layers', 14)}</span><select id="active-level-select" aria-label="当前设计楼层">${levels.map(level => `<option value="${escape(level.id)}"${level.id === current.id ? ' selected' : ''}>${escape(level.name)}</option>`).join('')}</select><button class="icon-button" data-action="manage-levels" title="管理楼层 / 添加二楼" aria-label="管理楼层">${icon('plus', 14)}</button></div>`;
}
export function showLevelManager(project, action) {
    const current = activeLevel(project), levels = levelProjects(project);
    const dialog = openDialog('楼层与 Loft', `<p class="help">每层独立画墙、选材和摆放家具。二楼可以只画部分面积，三维会保留挑空空间。</p><div class="level-manager-list">${levels.map((level, index) => `<div class="level-manager-row${level.id === current.id ? ' active' : ''}"><span class="level-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${escape(level.name)}</strong><small>地面标高 ${measure(level.elevation / 100)} m · 层高 ${measure(level.height / 100)} m</small></span>${levels.length > 1 ? `<button class="icon-button" data-level-delete="${escape(level.id)}" aria-label="删除${escape(level.name)}">${icon('trash', 14)}</button>` : ''}</div>`).join('')}</div><form id="level-edit-form"><span class="field-label">当前层设置</span><label class="spaced"><span class="field-label">楼层名称</span><input name="name" maxlength="80" value="${escape(current.name)}" required></label><div class="field-grid spaced"><label><span class="field-label">层高（m）</span><input name="height" type="number" min=".5" max="10" step="any" value="${current.height / 100}" required></label><label><span class="field-label">楼板厚度（cm）</span><input name="slabThickness" type="number" min="1" max="100" step="any" value="${current.slabThickness}" required></label></div><button class="button subtle full spaced" type="submit">保存本层设置</button></form><form id="level-add-form" class="level-add-form"><span class="field-label">添加楼层</span><input name="name" maxlength="80" value="${levels.length === 1 ? '二楼' : `${levels.length + 1} 楼`}" aria-label="新楼层名称" required><div class="field-grid spaced"><label><span class="field-label">新层层高（m）</span><input name="height" type="number" min=".5" max="10" step="any" value="3" required></label><label><span class="field-label">起始布局</span><select name="copyLayout"><option value="false">空白层，自由设计</option><option value="true">复制本层及材料家具</option></select></label></div><button class="button primary full spaced" type="submit">添加并前往新楼层</button></form><p class="help spaced">楼层总预算统一汇总，项目费用与税金只计一次。楼梯在较低楼层放置；上层选房间后可画楼板洞。</p><div class="dialog-error" role="alert" hidden></div>`);
    const error = (err) => { const target = dialog.querySelector('.dialog-error'); target.hidden = false; target.textContent = err.message; };
    dialog.querySelector('#level-edit-form').addEventListener('submit', event => { event.preventDefault(); try {
        const form = new FormData(event.target);
        action('edit', current.id, { name: String(form.get('name')).trim(), height: Number(form.get('height')) * 100, slabThickness: Number(form.get('slabThickness')) });
        dialog.close();
    }
    catch (err) {
        error(err);
    } });
    dialog.querySelector('#level-add-form').addEventListener('submit', event => { event.preventDefault(); try {
        const form = new FormData(event.target);
        action('add', '', { name: String(form.get('name')).trim(), height: Number(form.get('height')) * 100, copyLayout: form.get('copyLayout') === 'true' });
        dialog.close();
    }
    catch (err) {
        error(err);
    } });
    dialog.querySelectorAll('[data-level-delete]').forEach(button => button.addEventListener('click', () => { if (!confirm('删除此层的墙体、区域、家具及预算？可撤销恢复。'))
        return; try {
        action('delete', button.dataset.levelDelete);
        dialog.close();
    }
    catch (err) {
        error(err);
    } }));
}
export function renderSurfaceTabs(surface) {
    return `<div class="surface-tabs" role="group" aria-label="房间施工面"><button data-action="select-surface" data-surface="floor" class="${surface === 'floor' ? 'active' : ''}">地面</button><button data-action="select-surface" data-surface="ceiling" class="${surface === 'ceiling' ? 'active' : ''}">天花板</button></div>`;
}
export function renderCeilingInspector(project, region, materials, quote) {
    const ceiling = region.ceiling ?? { enabled: false, items: [], additionalCost: '0' };
    const items = new Map((quote?.items ?? []).map(item => [item.id, item]));
    return `<section class="panel-section"><span class="eyebrow">Ceiling</span><h3>${escape(region.name)} · 天花板</h3><p class="help spaced">按本房间实际轮廓和楼板洞计算净面积。</p><label class="checkbox-label spaced"><input id="ceiling-enabled" type="checkbox"${ceiling.enabled ? ' checked' : ''}>启用本房间天花板</label><label class="spaced"><span class="field-label">离本层地面高度（m）</span><input id="ceiling-height" type="number" min=".5" max="10" step="any" value="${ceilingHeight(project, region) / 100}"></label><div class="wall-area-display"><strong data-stat="ceiling-area">${measure(quote?.netArea)}</strong><span>m²</span></div></section><section class="panel-section"><div class="section-head"><h3>天花板材料</h3></div>${ceiling.items.map(item => renderItem(item, materials, items.get(item.id))).join('')}<button class="button subtle full" data-action="add-item">${icon('plus', 14)}添加天花板材料</button><p class="help spaced">采购面积含损耗，人工按净面积；没有材料配置时仅显示几何。</p></section><div class="property-total"><div class="stat-row"><span>天花板小计</span><strong data-stat="ceiling-total">${quote?.pending ? '待配置' : quote ? '¥ ' + money(quote.total) : '未配置'}</strong></div></div>`;
}
export function renderFloorOpenings(project, region) {
    const shapes = [['rectangle', 'rectangle', '矩形'], ['circle', 'circle', '圆形'], ['ellipse', 'circle', '椭圆'], ['annulus', 'hole', '圆环'], ['polygon', 'polygon', '自由绘制']];
    const names = { rectangle: '矩形', circle: '圆形', ellipse: '椭圆', annulus: '圆环', polygon: '多边形' };
    return `<section class="panel-section floor-opening-section"><div class="section-head"><h3>楼板与挑空</h3></div><div class="opening-shape-grid">${shapes.map(([shape, symbol, name]) => `<button class="button subtle" data-action="draw-floor-hole" data-hole-shape="${shape}" aria-label="绘制${name}楼板洞">${icon(symbol, 14)}${name}</button>`).join('')}</div><label class="opening-ring-field spaced"><span class="field-label">圆环内径比例</span><span class="unit-input"><input id="floor-hole-inner-ratio" type="number" min="5" max="90" step="1" value="45" aria-label="圆环内径比例"><span>%</span></span></label><button class="text-button full" data-action="floor-hole-dimensions">输入洞口尺寸</button><p class="help spaced">拖出形状即可完成；自由绘制按 Enter 闭合。贴墙吸附，出界部分自动裁切，圆环中央保留楼板。净地面与天花板用量同步更新。</p>${(project.floorOpenings ?? []).filter(opening => opening.regionId === region.id).map((opening, index) => `<div class="stat-row floor-opening-row"><span>${names[opening.shape ?? 'polygon']}洞 ${index + 1}${opening.sourceStairId ? '<small>随楼梯自动匹配</small>' : ''}</span><span><button class="icon-button" data-action="edit-floor-hole" data-id="${escape(opening.id)}" aria-label="编辑洞口尺寸">${icon('edit', 14)}</button><button class="icon-button" data-action="remove-floor-hole" data-id="${escape(opening.id)}" aria-label="移除楼板洞">${icon('trash', 14)}</button></span></div>`).join('')}</section>`;
}
export function renderIncomingStairList(project) {
    const stairs = incomingStairs(project);
    return stairs.length ? `<section class="panel-section incoming-stairs"><div class="section-head"><h3>通往本层的楼梯</h3><span class="chip">${stairs.length}</span></div>${stairs.map(source => `<button class="incoming-stair-row" data-action="select-incoming-stair" data-id="${escape(source.item.id)}" data-level-id="${escape(source.levelId)}"><span>${icon('layers', 16)}</span><span><strong>${escape(source.item.name)}</strong><small>来自${escape(source.levelName)} · 点击编辑</small></span>${icon('chevron', 12)}</button>`).join('')}<p class="help">二维和三维显示同一部楼梯，预算只在起始层计一次。</p></section>` : '';
}
export function renderStairConnection(project, item) {
    if (!isStairKind(item.kind) || project.drawing?.type !== 'plan')
        return '';
    const base = activeLevel(project), upper = levelProjects(project).filter(level => level.elevation > base.elevation);
    const settings = defaultStairSettings(item), round = /Spiral|Arc/.test(item.kind);
    const html = `<section class="panel-section stair-connection"><div class="section-head"><h3>楼梯连接与扶手</h3></div><label class="field-label">到达楼层</label><select id="stair-target"><option value="">独立楼梯，自填升高</option>${upper.map(level => `<option value="${escape(level.id)}"${level.id === item.stairTargetLevelId ? ' selected' : ''}>${escape(level.name)} · 升高 ${measure((level.elevation - base.elevation - (item.mountHeight ?? 0)) / 100)} m</option>`).join('')}</select><div class="field-grid spaced"><label><span class="field-label">栏杆扶手</span><select id="stair-railing">${[['both', '双侧'], ['left', '左侧'], ['right', '右侧'], ['none', '无扶手']].map(([value, label]) => `<option value="${value}"${settings.railing === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label><span class="field-label">扶手高度（cm）</span><input id="stair-railing-height" type="number" min="50" max="150" step="any" value="${settings.railingHeight}"></label></div>${round ? `<div class="field-grid spaced"><label><span class="field-label">内圈比例（%）</span><input id="stair-inner-ratio" type="number" min="5" max="85" value="${(settings.innerRatio ?? (item.kind.includes('Spiral') ? .18 : .5)) * 100}" step="any"></label><label><span class="field-label">旋转圈角（°）</span><input id="stair-turn-degrees" type="number" min="${item.kind.includes('Spiral') ? 180 : 45}" max="${item.kind.includes('Spiral') ? 720 : 300}" value="${settings.turnDegrees ?? (item.kind.includes('Spiral') ? 360 : 180)}" step="any"></label></div>` : ''}<div class="stair-opening-match spaced"><label><span class="field-label">洞口留量（cm）</span><input id="stair-opening-clearance" type="number" min="0" max="100" step="any" value="${settings.openingClearance ?? 5}"></label><button class="button primary full spaced" data-action="auto-stair-hole"${item.locked || !item.stairTargetLevelId ? ' disabled' : ''}>${icon('hole', 14)}${settings.autoOpening ? '更新匹配楼梯口' : '自动匹配楼梯口'}</button>${settings.autoOpening ? '<div class="stair-match-actions"><button class="text-button" data-action="view-stair-hole">查看楼梯口</button><button class="text-button" data-action="detach-stair-hole">改为手动洞口</button></div>' : ''}</div><p class="help spaced">自动洞口随楼梯移动、旋转与尺寸更新，按上层房间边界裁切。圆环楼梯保留中央楼板；踏步与扶手按真实升高生成。</p></section>`;
    return item.locked ? html.replace(/<(input|select)\b/g, '<$1 disabled') : html;
}
//# sourceMappingURL=level-panel.js.map