import { MUNICIPAL_PRESETS, municipalPreset, municipalScale, isMunicipalPath, isMunicipalPolygon, isMunicipalSurface } from './lib/municipal-design.js';
import { openDialog, toast } from './ui.js';
export function showMunicipalQuickCreate(project, onCreate, placement) {
    const scale = municipalScale(project);
    if (!scale)
        throw new Error('请先校准图纸比例。');
    const input = (name, label, value, min = '0', attrs = '') => `<label ${attrs}><span class="field-label">${label}</span><input name="${name}" type="number" min="${min}" step="any" value="${value}" required></label>`;
    const dialog = openDialog('按尺寸添加市政设施', `<form id="municipal-quick-form"><label><span class="field-label">设施类型</span><select id="municipal-quick-kind" name="kind">${MUNICIPAL_PRESETS.map(p => `<option value="${p.kind}">${p.name}</option>`).join('')}</select></label><div class="field-grid spaced">${input('x', '起点 / 中心 X（m）', 5)}${input('y', '起点 / 中心 Y（m）', 5)}${input('length', '长度（m）', 20, '.1', 'data-quick-path')}${input('angle', '方向角（°）', 0, '-360', 'data-quick-path')}<label><span class="field-label" id="municipal-quick-width-label">道路宽度（cm）</span><input id="municipal-quick-width" name="width" type="number" min=".1" step="any" value="600" required></label><label><span class="field-label" id="municipal-quick-height-label">主层厚度（cm）</span><input id="municipal-quick-height" name="height" type="number" min=".1" step="any" value="5" required></label>${input('elevation', '顶面标高（cm）', 0, '-100000')}</div><section data-quick-road class="municipal-quick-options spaced"><label><span class="field-label">车道布置</span><select name="lanes"><option value="0">按自定路宽</option>${[2, 4, 6, 8].map(n => `<option value="${n}">双向 ${n} 车道</option>`).join('')}</select></label><p class="help">选车道预设按每条 3.5 m、四车道以上中央分隔 1 m 生成，之后可修改。</p></section><section data-quick-junction class="field-grid spaced" hidden><label><span class="field-label">支路数量</span><select name="arms"><option value="3">三岔路口</option><option value="4" selected>十字路口</option><option value="8">八支路路口</option></select></label>${input('armLength', '支路延伸（m）', 18, '1')}${input('rotation', '整体旋转（°）', 0, '-360')}${input('islandRadius', '中心岛半径（m）', 6, '1', 'data-quick-island')}</section><p class="help" id="municipal-quick-note">创建实际尺寸的直线路线，随后可拖节点修改形状和填写价格。</p><p class="help" id="municipal-quick-error" role="status"></p><button class="button primary full" type="submit">添加到场地</button></form>`, { subtitle: '按真实尺寸创建，随后可以直接拖动修改' });
    const form = dialog.querySelector('form'), kindInput = dialog.querySelector('#municipal-quick-kind');
    if (placement) {
        kindInput.closest('label').insertAdjacentHTML('afterend', `<label class="spaced"><span class="field-label">放置高度</span><select id="municipal-quick-placement"><option value="terrain" ${placement.mode === 'terrain' ? 'selected' : ''}>贴合地形</option><option value="manual" ${placement.mode === 'manual' ? 'selected' : ''}>手动标高</option></select></label><p class="help" id="municipal-quick-placement-note"></p>`);
        const heightNote = () => { const mode = form.querySelector('#municipal-quick-placement').value; form.querySelector('#municipal-quick-placement-note').textContent = mode === 'manual' ? '按下方填写的绝对标高创建。修改后会用于下一次添加。' : project.municipalTerrain ? '按真实地形放置；下方绝对标高仅用于手动模式。道路跟随地形起伏，管线按默认埋深，桥面按默认离地高度。' : '暂无地形，使用下方设施标高。'; };
        form.querySelector('#municipal-quick-placement').addEventListener('change', heightNote);
        heightNote();
    }
    const updateDefaults = () => {
        const kind = kindInput.value, p = municipalPreset(kind), path = isMunicipalPath(kind), area = isMunicipalPolygon(kind), junction = ['intersection', 'roundabout'].includes(kind), road = ['road', 'bridge', 'intersection', 'roundabout'].includes(kind);
        dialog.querySelectorAll('[data-quick-path]').forEach(node => node.hidden = !path && !area);
        form.querySelector('[name="angle"]').closest('label').hidden = !path;
        dialog.querySelector('[data-quick-road]').hidden = !road;
        dialog.querySelector('[data-quick-junction]').hidden = !junction;
        dialog.querySelector('[data-quick-island]').hidden = kind !== 'roundabout';
        dialog.querySelector('#municipal-quick-width-label').textContent = area ? '矩形范围宽度（m）' : kind === 'pipeline' ? '管道外径（cm）' : kind === 'river' ? '水面宽度（cm）' : '宽度 / 直径（cm）';
        dialog.querySelector('#municipal-quick-width').value = String(area ? 5 : p.width);
        dialog.querySelector('#municipal-quick-height').value = String(p.height);
        dialog.querySelector('#municipal-quick-height-label').textContent = kind === 'pipeline' ? '管沟深度（cm）' : kind === 'manhole' ? '井深（cm）' : isMunicipalSurface(kind) ? '主层厚度（cm）' : '高度（cm）';
        const elevation = form.querySelector('[name="elevation"]');
        elevation.value = String(placement?.mode === 'manual' ? placement.elevation * 100 : p.elevation);
        elevation.closest('label').querySelector('.field-label').textContent = (kind === 'pipeline' ? '管线中心标高' : kind === 'manhole' ? '井底标高' : kind === 'river' ? '水面标高' : isMunicipalSurface(kind) ? '顶面标高' : '底标高') + '（cm）';
        if (junction)
            for (const name of ['x', 'y'])
                form.querySelector(`[name="${name}"]`).value = '80';
        dialog.querySelector('#municipal-quick-note').textContent = junction ? '点击中心放置完整路口，支路数、旋转和车道布置都可以继续修改。' : kind === 'river' ? '按中心线生成河道，可在属性中调整河深，并同步给地形开槽。' : '创建实际尺寸的设施，随后可拖动修改形状和填写价格。';
    };
    kindInput.addEventListener('change', updateDefaults);
    updateDefaults();
    const fitJunctionArms = () => {
        if (kindInput.value !== 'intersection')
            return;
        const lanes = Number(form.querySelector('[name="lanes"]').value), arms = Number(form.querySelector('[name="arms"]').value);
        const width = lanes ? lanes * 3.5 + (lanes > 2 ? 1 : 0) : Number(form.querySelector('[name="width"]').value) / 100;
        const minimum = Math.ceil(width / 2 * (arms === 8 ? 1 / Math.tan(Math.PI / 8) : 1)) + 1;
        const length = form.querySelector('[name="armLength"]');
        if (Number.isFinite(minimum) && Number(length.value) < minimum)
            length.value = String(minimum);
    };
    for (const name of ['lanes', 'arms'])
        form.querySelector(`[name="${name}"]`).addEventListener('change', fitJunctionArms);
    form.addEventListener('submit', event => {
        event.preventDefault();
        try {
            const data = new FormData(form), value = (key) => Number(data.get(key)), kind = kindInput.value, path = isMunicipalPath(kind), area = isMunicipalPolygon(kind);
            const x = value('x') / scale, y = value('y') / scale, angle = value('angle') * Math.PI / 180, length = value('length') / scale;
            if (![x, y, angle, length, value('width'), value('height'), value('elevation')].every(Number.isFinite))
                throw new Error('请填写有效尺寸。');
            let points = [{ x, y }];
            if (path)
                points.push({ x: x + length * Math.cos(angle), y: y + length * Math.sin(angle) });
            else if (area)
                points = [{ x, y }, { x: x + value('width') / scale, y }, { x: x + value('width') / scale, y: y + length }, { x, y: y + length }];
            const patch = { ...(!area ? { width: value('width') } : {}), height: value('height'), elevation: value('elevation') };
            const lanes = value('lanes');
            if (['road', 'bridge', 'intersection', 'roundabout'].includes(kind) && lanes) {
                patch.roadLayout = { lanes: lanes, laneWidth: 350, medianWidth: lanes > 2 ? 100 : 0 };
                patch.width = lanes * 350 + patch.roadLayout.medianWidth;
            }
            if (['intersection', 'roundabout'].includes(kind))
                patch.junction = { arms: value('arms'), armLength: value('armLength') * 100, rotation: value('rotation'), islandRadius: value('islandRadius') * 100 };
            const heightMode = form.querySelector('#municipal-quick-placement')?.value;
            onCreate(kind, points, patch, heightMode ? { mode: heightMode, elevation: value('elevation') / 100 } : undefined);
            dialog.close();
            toast('设施已按真实尺寸创建，填写单价后计算预算');
        }
        catch (error) {
            dialog.querySelector('#municipal-quick-error').textContent = error.message;
            toast(error.message, true);
        }
    });
}
//# sourceMappingURL=municipal-quick-create.js.map