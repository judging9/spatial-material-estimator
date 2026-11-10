import { escape, measure } from './ui.js';
import { calculateStructureModel, calculateStructureItems, normalizeStructureConfig, validateStructureState } from './lib/structure.js';
const fields = (name, label, value, min, max, step = 'any') => `<label><span class="field-label">${label}</span><input id="structure-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required></label>`;
function select(name, label, value, options) {
    return `<label><span class="field-label">${label}</span><select id="structure-${name}" name="${name}">${Object.entries(options).map(([key, text]) => `<option value="${key}" ${key === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
}
function planPreview(model) {
    const f = model.footprint, scale = Math.min(280 / f.width, 190 / f.height), x = (value) => 20 + (value - f.x) * scale, y = (value) => 20 + (value - f.y) * scale;
    return `<svg class="cost-preview-svg" viewBox="0 0 320 240" role="img" aria-label="按当前外轮廓生成的参考柱网，非结构施工图"><g fill="none" stroke="#c0cec4" stroke-width="1">${model.beams.map(beam => `<line x1="${x(beam.start.x)}" y1="${y(beam.start.y)}" x2="${x(beam.end.x)}" y2="${y(beam.end.y)}"/>`).join('')}</g><g fill="none" stroke="#547d69" stroke-width="2">${f.outline.map(edge => `<line x1="${x(edge.start.x)}" y1="${y(edge.start.y)}" x2="${x(edge.end.x)}" y2="${y(edge.end.y)}"/>`).join('')}</g><g fill="#2d6754">${model.columns.map(column => { const side = Math.max(3, column.size * scale); return `<rect x="${x(column.x) - side / 2}" y="${y(column.y) - side / 2}" width="${side}" height="${side}" rx=".5"/>`; }).join('')}</g><text x="20" y="230" font-size="11" fill="#778578">${measure(f.width)} × ${measure(f.height)} m · 柱网 ${model.gridX} × ${model.gridY} 跨</text></svg>`;
}
function modelPreview(model) {
    const q = model.quantities;
    const rows = [['建筑面积', q.buildingArea, 'm²'], ['基坑开挖', q.excavation, 'm³'], ['基础 / 垫层', `${measure(q.foundation)} / ${measure(q.cushion)}`, 'm³'],
        ['柱混凝土', q.columns, 'm³'], ['梁混凝土', q.beams, 'm³'], ['板混凝土', q.slabs, 'm³'], ['砌体', q.masonry, 'm³'],
        ['模板接触面（方案）', q.foundationFormwork + q.columnFormwork + q.beamFormwork + q.slabFormwork + q.wallFormwork, 'm²'], ['钢筋指标', q.rebar, 't']];
    return `<section class="cost-module-preview"><div class="cost-module-heading"><div><h3>已生成结构方案</h3><p class="help">${model.columns.length} 个柱网节点 · ${model.beams.length} 段主梁 · 标准层投影 ${measure(model.footprint.area)} m²</p></div><span class="cost-estimate-badge">方案估算</span></div><div class="cost-structure-preview">${planPreview(model)}<dl class="cost-quantity-list">${rows.map(([label, value, unit]) => `<div><dt>${label}</dt><dd>${typeof value === 'number' ? measure(value) : value} <small>${unit}</small></dd></div>`).join('')}</dl></div><p class="help">${escape(model.footprint.note)}</p><details class="cost-advanced"><summary>查看工程量口径</summary><ul class="cost-basis-list">${model.estimateFlags.map(note => `<li>${escape(note)}</li>`).join('')}</ul><p class="help">柱止于板下；梁只计板下净体积；基础、垫层与土方只计一次。钢筋为用户填写的含量指标，未作配筋设计。</p></details></section>`;
}
function formConfig(form) {
    const data = new FormData(form), numeric = ['floors', 'floorHeight', 'columnSize', 'slabThickness', 'embedDepth', 'rebarIndex', 'gridX', 'gridY', 'width', 'depth', 'concreteWallLength'];
    const values = Object.fromEntries(data);
    for (const key of numeric)
        values[key] = Number(data.get(key));
    return normalizeStructureConfig(values);
}
function renderStructure(host, ctx) {
    const project = ctx.getProject(), state = project.cost?.modules?.structure ?? {}, config = normalizeStructureConfig(state.config);
    let model;
    if (state.modelGenerated || state.enabled)
        model = calculateStructureModel(project, config);
    const hasPlan = project.regions.length > 0;
    host.innerHTML = `<div class="cost-module-heading"><div><span class="eyebrow">STRUCTURE</span><h2>主体结构方案</h2><p class="help">设置标准层参数，生成柱网和工程量，再进入统一造价清单。</p></div><button class="button subtle" id="structure-clear" ${state.modelGenerated || state.enabled ? '' : 'disabled'}>清空本专业</button></div>
  <div class="cost-notice">这是方案估算。单价参考值需按当地信息价确认；结构形式和抗震等级仅作项目特征，不进行结构设计或验算。</div>
  <form id="structure-form" class="cost-parameter-form"><div class="field-grid">
    ${select('system', '结构形式', config.system, { frame: '框架', masonry: '砖混', 'frame-shear': '框架-剪力墙' })}
    ${fields('floors', '地上层数', config.floors, 1, 30, '1')}${fields('floorHeight', '层高（m）', config.floorHeight, 2.4, 6)}
    ${select('foundation', '基础形式', config.foundation, { spread: '独立基础', strip: '条形基础', raft: '筏板基础' })}
    ${select('concreteGrade', '混凝土强度', config.concreteGrade, { C25: 'C25', C30: 'C30', C35: 'C35', C40: 'C40' })}
    ${select('footprintSource', '标准层轮廓', config.footprintSource, { auto: hasPlan ? '当前户型外轮廓' : '矩形方案（尚无户型）', rectangle: '按矩形方案输入' })}
  </div><details class="cost-advanced" ${!hasPlan || config.footprintSource === 'rectangle' ? 'open' : ''}><summary>矩形方案长宽</summary><div class="field-grid">${fields('width', '外轮廓长度（m）', config.width, 1, 200)}${fields('depth', '外轮廓宽度（m）', config.depth, 1, 200)}</div><p class="help">仅在没有户型或选择矩形方案时使用。这里输入外轮廓尺寸，按其水平投影估算标准层。</p></details>
  <details class="cost-advanced"><summary>高级参数与柱网</summary><div class="field-grid">
    ${fields('columnSize', '柱边长（mm）', config.columnSize, 250, 1200)}${fields('slabThickness', '板厚（mm）', config.slabThickness, 100, 500)}
    ${fields('embedDepth', '基础埋深（m）', config.embedDepth, .2, 10)}${fields('rebarIndex', '钢筋含量指标（kg/m²）', config.rebarIndex, 0, 300)}
    ${fields('gridX', 'X 向跨数（0 自动）', config.gridX, 0, 40, '1')}${fields('gridY', 'Y 向跨数（0 自动）', config.gridY, 0, 40, '1')}
    ${fields('concreteWallLength', '框剪混凝土墙总长（m）', config.concreteWallLength, 0, 10000)}
    ${select('seismicGrade', '抗震等级（项目特征）', config.seismicGrade, { '未指定': '未指定', '一级': '一级', '二级': '二级', '三级': '三级', '四级': '四级' })}
  </div><p class="help">框架-剪力墙需填写混凝土墙长度。该参数仅用于方案算量，不推断哪些墙承担结构作用。</p></details>
  <div class="cost-actions"><button id="structure-generate" class="button primary" type="submit">生成结构</button><button id="structure-generate-cost" class="button subtle" type="button" ${model ? '' : 'disabled'}>生成造价表</button><span class="help">参数修改后点击生成；清单单价可直接编辑。</span></div></form>${model ? modelPreview(model) : '<div class="cost-module-empty"><p>填写参数后生成结构，查看可核对的柱网和工程量。</p></div>'}`;
    const form = host.querySelector('#structure-form');
    form.addEventListener('submit', event => {
        event.preventDefault();
        try {
            const nextConfig = formConfig(form), model = calculateStructureModel(ctx.getProject(), nextConfig), materials = structuredClone(ctx.getMaterials());
            ctx.updateProject(next => { next.cost ??= {}; next.cost.modules ??= {}; next.cost.modules.structure = { ...(next.cost.modules.structure ?? {}), config: nextConfig, modelGenerated: true, model, materials }; }, { history: false });
            ctx.toast(`已生成 ${nextConfig.floors} 层结构方案，${model.columns.length} 个柱网节点、${model.beams.length} 段主梁`);
            ctx.refresh();
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    });
    host.querySelector('#structure-generate-cost').addEventListener('click', () => {
        try {
            const nextConfig = formConfig(form), model = calculateStructureModel(ctx.getProject(), nextConfig), materials = structuredClone(ctx.getMaterials());
            ctx.updateProject(next => { next.cost ??= {}; next.cost.modules ??= {}; next.cost.modules.structure = { ...(next.cost.modules.structure ?? {}), config: nextConfig, modelGenerated: true, enabled: true, model, materials }; }, { history: false });
            ctx.toast('土建清单已生成；请核对参考单价和待填写项');
            ctx.refresh();
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    });
    host.querySelector('#structure-clear').addEventListener('click', () => {
        if (!confirm('清空当前土建方案、清单与单价覆盖？'))
            return;
        ctx.updateProject(next => { if (next.cost?.modules)
            delete next.cost.modules.structure; }, { history: false });
        ctx.toast('土建专业已清空');
        ctx.refresh();
    });
}
export const structureModule = { id: 'structure', section: '土建', title: '土建', calculate: calculateStructureItems, render: renderStructure, validate: validateStructureState };
//# sourceMappingURL=structure-module.js.map