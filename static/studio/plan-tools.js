import { renderItem } from './panels.js';
import { escape, icon, measure, money, openDialog, toast } from './ui.js';
export function renderPlanTools(project) {
    if (project.drawing?.type !== 'plan')
        return '';
    const points = project.planBoundary?.points;
    const width = points ? (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) / 100 : null;
    const depth = points ? (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) / 100 : null;
    return `<section class="panel-section plan-design-tools"><div class="section-head"><h3>绘图设置</h3><span class="chip">${project.wallJoinStyle === 'clean' ? '自然连接' : '原连接'}</span></div><button class="plan-boundary-row" data-action="plan-boundary">${icon('boundary', 15)}<span>绘图边界<small>${points ? `${points.length} 个顶点 · ${measure(width)} × ${measure(depth)} m` : '未设置 · 使用画板范围'}</small></span>${icon('chevron', 13)}</button><div class="plan-design-actions"><button class="button subtle" data-action="shape-parameters">${icon('circle', 14)}圆 / 圆弧</button><button class="button subtle" data-action="clean-walls">${icon('wall', 14)}整理墙体</button></div></section>`;
}
export function showBoundaryEditor(project, apply, draw) {
    const current = project.planBoundary?.points;
    const drawing = project.drawing;
    const minX = current ? Math.min(...current.map(p => p.x)) : 50, minY = current ? Math.min(...current.map(p => p.y)) : 50;
    const width = current ? Math.max(...current.map(p => p.x)) - minX : Math.min(1200, drawing.width - 100);
    const depth = current ? Math.max(...current.map(p => p.y)) - minY : Math.min(900, drawing.height - 100);
    const dialog = openDialog('设置绘图边界', `<p class="help">按实际尺寸定义可绘制范围。墙厚和连接处也必须在边界内，已有墙体超出时会保留项目并提示调整。</p><form id="plan-boundary-form"><div class="field-grid">${[['x', '左侧位置', minX / 100], ['y', '上侧位置', minY / 100], ['width', '边界宽度', width / 100], ['depth', '边界进深', depth / 100]].map(([key, label, value]) => `<label><span class="field-label">${label}（m）</span><input name="${key}" type="number" min="${key === 'x' || key === 'y' ? '0' : '.1'}" max="24" step="any" value="${value}" required></label>`).join('')}</div><p class="help spaced">也可以在画布逐点定义不规则边界，点击起点或按 Enter 闭合。</p><div class="boundary-dialog-actions"><button class="button subtle" type="button" data-boundary-draw>${icon('polygon', 15)}手动画多边形</button>${current ? '<button class="button subtle" type="button" data-boundary-clear>清除边界</button>' : ''}</div><div class="dialog-error" role="alert" hidden></div></form>`, { footer: '<button type="submit" form="plan-boundary-form" class="button primary">应用矩形边界</button>' });
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            const form = new FormData(event.target), x = Number(form.get('x')) * 100, y = Number(form.get('y')) * 100, w = Number(form.get('width')) * 100, d = Number(form.get('depth')) * 100;
            if (![x, y, w, d].every(Number.isFinite) || x < 0 || y < 0 || w < 10 || d < 10 || x + w > drawing.width || y + d > drawing.height)
                throw new Error('请输入画板范围内的有效尺寸。');
            apply([{ x, y }, { x: x + w, y }, { x: x + w, y: y + d }, { x, y: y + d }]);
            dialog.close();
        }
        catch (error) {
            const target = dialog.querySelector('.dialog-error');
            target.hidden = false;
            target.textContent = error.message;
        }
    });
    dialog.querySelector('[data-boundary-draw]').addEventListener('click', () => { dialog.close(); draw(); });
    dialog.querySelector('[data-boundary-clear]')?.addEventListener('click', () => { try {
        apply(null);
        dialog.close();
    }
    catch (error) {
        toast(error.message, true);
    } });
}
export function shapeParameters(form) {
    const value = { kind: form.get('kind'), center: { x: Number(form.get('x')) * 100, y: Number(form.get('y')) * 100 }, radius: Number(form.get('radius')) * 100, startDegrees: Number(form.get('startDegrees')), sweepDegrees: Number(form.get('sweepDegrees')), thickness: Number(form.get('thickness')), height: Number(form.get('height')) * 100 };
    if (![value.center.x, value.center.y, value.radius, value.startDegrees, value.sweepDegrees, value.thickness, value.height].every(Number.isFinite) || !['circle', 'arc'].includes(value.kind) || value.radius < 10 || value.thickness < 1 || value.thickness > 100 || value.height < 50 || value.height > 1000)
        throw new Error('请填写有效的圆心、半径、墙高和墙厚。');
    if (value.kind === 'circle') {
        value.startDegrees = 0;
        value.sweepDegrees = 360;
    }
    return value;
}
function shapeFields(value, selectKind = false) {
    return `${selectKind ? `<label><span class="field-label">形状</span><select name="kind"><option value="circle">圆形墙</option><option value="arc">圆弧墙</option></select></label>` : `<input name="kind" type="hidden" value="${value.kind}">`}<div class="field-grid spaced">${[['x', '圆心水平位置（m）', value.center.x / 100], ['y', '圆心竖向位置（m）', value.center.y / 100], ['radius', '半径（m）', value.radius / 100], ['thickness', '墙宽 / 厚度（cm）', value.thickness], ['height', '墙高（m）', value.height / 100]].map(([key, label, number]) => `<label><span class="field-label">${label}</span><input type="number" name="${key}" value="${number}" step="any" required min="${key === 'radius' ? '.1' : key === 'thickness' ? '1' : key === 'height' ? '.5' : '0'}"></label>`).join('')}</div><div class="field-grid spaced arc-parameter-fields"${value.kind === 'circle' && !selectKind ? ' hidden' : ''}><label><span class="field-label">起始角（°）</span><input name="startDegrees" type="number" step="any" value="${value.startDegrees}" required></label><label><span class="field-label">转角（°）</span><input name="sweepDegrees" type="number" min="-360" max="360" step="any" value="${value.sweepDegrees}" required></label></div><p class="help spaced">0° 向右，90° 向下；正转角顺时针，负转角逆时针。弧墙可连接直墙闭合房间。</p>`;
}
export function showShapeParameters(project, apply) {
    const value = { kind: 'circle', center: { x: 600, y: 500 }, radius: 200, startDegrees: 0, sweepDegrees: 90, thickness: Number(project.wallThickness || 20), height: Number(project.wallHeight || 280) };
    const dialog = openDialog('按尺寸绘制圆 / 圆弧', `<form id="shape-parameters-form">${shapeFields(value, true)}<div class="dialog-error" role="alert" hidden></div></form>`, { footer: '<button class="button primary" type="submit" form="shape-parameters-form">生成墙体</button>' });
    const select = dialog.querySelector('[name="kind"]'), fields = dialog.querySelector('.arc-parameter-fields');
    fields.hidden = true;
    select.addEventListener('change', () => fields.hidden = select.value !== 'arc');
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); try {
        apply(shapeParameters(new FormData(event.target)));
        dialog.close();
    }
    catch (error) {
        const target = dialog.querySelector('.dialog-error');
        target.hidden = false;
        target.textContent = error.message;
    } });
}
export function renderWallShapeInspector(project, shape, materials, quote) {
    const first = project.walls.find(wall => wall.id === shape.wallIds[0]);
    const quotes = new Map((quote?.items || []).map(item => [item.id, item]));
    const value = { ...shape, thickness: first.thickness, height: first.height ?? project.wallHeight ?? 280 };
    return `<section class="panel-section"><div class="section-head"><span class="eyebrow">${shape.kind === 'circle' ? 'Circle wall' : 'Arc wall'}</span><span class="chip">${shape.kind === 'circle' ? '圆形墙' : '圆弧墙'}</span></div><label class="field-label">墙体名称</label><input class="inspector-name" data-wall-field="name" value="${escape(shape.name)}" maxlength="120"></section><section class="panel-section"><form id="shape-edit-form">${shapeFields(value)}<button class="button primary full spaced" type="submit">应用尺寸</button></form><p class="help spaced">按同一组几何同步更新二维、三维与材料用量。曲线弦偏差不超过 0.5 cm，按实际折线几何计量。</p></section><section class="panel-section"><div class="section-head"><span class="eyebrow">Surface</span><h3>整组墙面用量</h3></div><label class="field-label">材料施工范围</label><select id="wall-finish-side" data-wall-field="finishSide">${[['both', '左右两侧墙面'], ['left', '左侧墙面'], ['right', '右侧墙面']].map(([value, label]) => `<option value="${value}"${(shape.finishSide || 'both') === value ? ' selected' : ''}>${label}</option>`).join('')}</select><div class="wall-area-display"><strong data-stat="wall-net-area">${measure(quote?.netArea)}</strong><span>m²</span></div><p class="help">按整组实际裸露面计量，只计算左右侧面，不计端面、顶底和洞口内壁。</p></section><section class="panel-section inspector-materials"><div class="section-head"><span class="eyebrow">Materials</span><h3>整组墙面材料</h3></div>${shape.items.map(item => renderItem(item, materials, quotes.get(item.id))).join('')}<button class="button subtle full" data-action="add-item">${icon('plus', 16)}添加整组材料</button></section><div class="property-total"><div class="stat-row"><span>整组墙面小计</span><strong data-stat="wall-total">${!shape.items.length ? '未配置墙材' : quote?.pending ? '待配置' : '¥ ' + money(quote?.total)}</strong></div><p class="help">损耗、人工与固定费用按整组计价。</p></div><section class="panel-section"><button class="button subtle full" data-action="delete-wall-shape" data-id="${escape(shape.id)}">${icon('trash', 16)}删除整组墙体</button><p class="help spaced">可撤销恢复，房间会重新计算。</p></section>`;
}
//# sourceMappingURL=plan-tools.js.map