import { openingShape } from './lib/floor-openings.js';
import { regionInteriorPoint } from './lib/geometry.js';
import { openDialog } from './ui.js';
export function showFloorOpeningEditor(project, region, existing, save) {
    const source = existing?.points, box = source ? { minX: Math.min(...source.map(p => p.x)), maxX: Math.max(...source.map(p => p.x)), minY: Math.min(...source.map(p => p.y)), maxY: Math.max(...source.map(p => p.y)) } : null;
    const center = box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : regionInteriorPoint(region) ?? { x: region.points[0].x, y: region.points[0].y };
    const width = box ? box.maxX - box.minX : 100, depth = box ? box.maxY - box.minY : 100;
    const inner = existing?.holes?.[0];
    const ratio = inner && box ? (Math.max(...inner.map(p => p.x)) - Math.min(...inner.map(p => p.x))) / width : .45;
    const choices = [['rectangle', '矩形'], ['circle', '圆形'], ['ellipse', '椭圆'], ['annulus', '圆环'], ...(existing?.shape === 'polygon' || existing && !existing.shape ? [['polygon', '保留自由轮廓']] : [])];
    const dialog = openDialog(existing ? '编辑楼板洞尺寸' : '按尺寸创建楼板洞', `<form id="floor-opening-form"><label><span class="field-label">洞口形状</span><select name="shape">${choices.map(([value, label]) => `<option value="${value}"${value === (existing?.shape ?? (existing ? 'polygon' : 'rectangle')) ? ' selected' : ''}>${label}</option>`).join('')}</select></label><div class="field-grid spaced"><label><span class="field-label">宽 / 直径（m）</span><input name="width" type="number" min=".05" max="40" step="any" value="${width / 100}" required></label><label><span class="field-label">深（m，椭圆 / 矩形）</span><input name="depth" type="number" min=".05" max="40" step="any" value="${depth / 100}" required></label></div><div class="field-grid spaced"><label><span class="field-label">中心横向位置（m）</span><input name="x" type="number" step="any" value="${center.x / 100}" required></label><label><span class="field-label">中心纵向位置（m）</span><input name="y" type="number" step="any" value="${center.y / 100}" required></label></div><label class="spaced"><span class="field-label">圆环内径比例（%）</span><input name="innerRatio" type="number" min="5" max="90" step="any" value="${ratio * 100}" required></label><p class="help spaced">位置默认沿用当前洞口或房间中心，按图纸左上角计量。贴墙和出界部分会按房间实际轮廓裁切，圆环中间保留楼板。${existing?.sourceStairId ? '修改后改为手动洞口，停止跟随楼梯。' : ''}</p><div class="dialog-error" role="alert" hidden></div><button class="button primary full spaced" type="submit">${existing ? '应用尺寸' : '创建楼板洞'}</button></form>`);
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            const values = new FormData(event.target), shape = String(values.get('shape'));
            const w = Number(values.get('width')) * 100, d = Number(values.get('depth')) * 100, c = { x: Number(values.get('x')) * 100, y: Number(values.get('y')) * 100 };
            if (![w, d, c.x, c.y].every(Number.isFinite) || w < 5 || d < 5)
                throw new Error('请输入有效位置与至少 5 cm 的洞口尺寸。');
            const opening = shape === 'polygon' ? { points: existing.points.map(p => ({ x: c.x + (p.x - center.x) * w / width, y: c.y + (p.y - center.y) * d / depth })), holes: (existing.holes ?? []).map(ring => ring.map(p => ({ x: c.x + (p.x - center.x) * w / width, y: c.y + (p.y - center.y) * d / depth }))), shape } : openingShape(shape, shape === 'circle' || shape === 'annulus' ? c : { x: c.x - w / 2, y: c.y - d / 2 }, shape === 'circle' || shape === 'annulus' ? { x: c.x + w / 2, y: c.y } : { x: c.x + w / 2, y: c.y + d / 2 }, { innerRatio: Number(values.get('innerRatio')) / 100 });
            save(opening);
            dialog.close();
        }
        catch (error) {
            const target = dialog.querySelector('.dialog-error');
            target.hidden = false;
            target.textContent = error.message;
        }
    });
}
//# sourceMappingURL=floor-opening-panel.js.map