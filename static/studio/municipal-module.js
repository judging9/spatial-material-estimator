import { escape, measure } from './ui.js';
import { calculateMunicipal, getMunicipalConfig, generateMunicipalItems, municipalRouteLength, normalizeMunicipalConfig, validateMunicipalState } from './lib/municipal.js';
const field = (name, label, value, min = 0, max = 1000000, step = 'any') => `<label class="cost-field"><span class="field-label">${escape(label)}</span><input name="${name}" id="municipal-${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required></label>`;
const check = (name, label, value) => `<label class="cost-checkbox"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}> ${escape(label)}</label>`;
const optionalField = (name, label, value, min = 0, max = 1000000) => `<label class="cost-field"><span class="field-label">${escape(label)}</span><input name="${name}" type="number" min="${min}" max="${max}" step="any" value="${value ?? ''}" placeholder="留空使用方案假设"></label>`;
export function municipalCrossSection(config) {
    const { road } = config, width = road.carriageway + road.sidewalk * 2;
    const left = 58, total = 480, walk = width > 0 ? road.sidewalk / width * total : 0;
    let bottom = 78;
    const colors = ['#697573', '#89958f', '#b8bfb2', '#d5d9ce'];
    const layers = road.layers.map((layer, index) => {
        const depth = Math.max(9, Math.min(30, layer.thickness * .85));
        const x = layer.scope === 'carriageway' ? left + walk : left, w = layer.scope === 'carriageway' ? Math.max(0, total - walk * 2) : total;
        const out = `<rect x="${x}" y="${bottom}" width="${w}" height="${depth}" fill="${colors[index % colors.length]}" stroke="#fff" stroke-width="1"/><text x="550" y="${bottom + depth / 2 + 4}" font-size="11" fill="#637166">${layer.thickness} cm</text>`;
        bottom += depth;
        return out;
    }).join('');
    return `<svg class="municipal-cross-section" viewBox="0 0 640 ${Math.max(190, bottom + 42)}" role="img" aria-label="道路横断面参数示意图">
    <path d="M58 44H538M58 39V49M538 39V49" fill="none" stroke="#9eac9c"/>
    <text x="298" y="31" text-anchor="middle" font-size="12" fill="#536557">有效路幅 ${measure(width)} m · 红线 ${measure(road.width)} m</text>
    <rect x="58" y="61" width="${walk}" height="17" fill="#d8ddcf"/><rect x="${538 - walk}" y="61" width="${walk}" height="17" fill="#d8ddcf"/>
    <path d="M${left + walk} 55V78M${538 - walk} 55V78" stroke="#859980" stroke-width="3"/>
    <text x="${left + walk / 2}" y="57" text-anchor="middle" font-size="10" fill="#637166">人行道 ${road.sidewalk}m</text>
    <text x="298" y="65" text-anchor="middle" font-size="12" fill="#526a58">车行道 ${road.carriageway}m</text>
    <text x="${538 - walk / 2}" y="57" text-anchor="middle" font-size="10" fill="#637166">人行道 ${road.sidewalk}m</text>
    ${layers}<path d="M58 ${bottom + 8}H538" stroke="#a6b19e" stroke-dasharray="4 4"/>
    <text x="58" y="${bottom + 31}" font-size="10" fill="#899580">参数示意，竖向不按比例；沥青面层与人行道面层分开计量。</text>
  </svg>`;
}
function preview(model) {
    const { road, config, drainage, lighting, greening, stations } = model;
    return `<section class="cost-card cost-preview"><div class="cost-module-heading"><div><h3>沿线工程量</h3><p class="help">${measure(config.road.length)} m 道路 · 按所填断面和方案系数计算</p></div></div>
    <div class="cost-metric-grid"><div><span>路床面积</span><strong>${measure(road.formation)} <small>m²</small></strong></div><div><span>检查井</span><strong>${drainage.reduce((sum, item) => sum + item.manholes, 0)} <small>座</small></strong></div><div><span>路灯</span><strong>${lighting.poles} <small>套</small></strong></div><div><span>绿化面积</span><strong>${measure(greening.area)} <small>m²</small></strong></div></div>
    ${municipalCrossSection(config)}
    <details class="cost-details"><summary>里程桩号核对 · ${stations.length} 段</summary><div class="cost-table-wrap"><table class="cost-table"><thead><tr><th>起点桩号</th><th>终点桩号</th><th>段长（m）</th><th>路床面积（m²）</th></tr></thead><tbody>${stations.slice(0, 30).map(station => `<tr><td>${stationLabel(station.from)}</td><td>${stationLabel(station.to)}</td><td>${measure(station.length)}</td><td>${measure(station.formationArea)}</td></tr>`).join('')}</tbody></table></div>${stations.length > 30 ? `<p class="help">显示前 30 段，全部 ${stations.length} 段保存在工程量模型中。</p>` : ''}</details>
  </section>`;
}
function stationLabel(value) {
    const centimetres = Math.round(value * 100), whole = Math.floor(centimetres / 100), fraction = centimetres % 100;
    return `K${Math.floor(whole / 1000)}+${String(whole % 1000).padStart(3, '0')}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}
function fromForm(form, original) {
    const data = new FormData(form), n = (key) => Number(data.get(key)), yes = (key) => data.has(key);
    const optional = (key) => String(data.get(key) ?? '').trim() ? n(key) : undefined;
    return normalizeMunicipalConfig({
        road: { ...original.road, length: n('length'), grade: data.get('grade'), width: n('width'), carriageway: n('carriageway'), sidewalk: n('sidewalk'),
            layers: original.road.layers.map((layer, index) => ({ ...layer, thickness: n(`layer-${index}-thickness`), unit: data.get(`layer-${index}-unit`), scope: data.get(`layer-${index}-scope`), density: n(`layer-${index}-density`) })) },
        drainage: { rain: yes('rain'), sewer: yes('sewer'), diameterRain: n('diameterRain'), diameterSewer: n('diameterSewer'), depth: n('depth'), manholeSpacing: n('manholeSpacing'),
            manholeSize: n('manholeSize'), outerDiameterRain: optional('outerDiameterRain'), outerDiameterSewer: optional('outerDiameterSewer') },
        lighting: { enabled: yes('lighting'), spacing: n('lightingSpacing'), side: data.get('lightingSide'), height: n('lightingHeight') },
        greening: { enabled: yes('greening'), beltWidth: n('beltWidth'), treeSpacing: n('treeSpacing') },
        bridge: { enabled: yes('bridge'), span: n('bridgeSpan'), width: n('bridgeWidth') },
        allowances: { clearanceDepth: n('clearanceDepth'), roadFillRatio: n('roadFillRatio'), trenchFactor: n('trenchFactor'), fenceLength: optional('fenceLength'), traffic: yes('traffic'), temporaryDrainage: yes('temporaryDrainage') },
    });
}
function writeConfig(ctx, config, generated) {
    const model = generated ? calculateMunicipal(config) : undefined;
    ctx.updateProject(project => {
        project.cost ??= {};
        project.cost.modules ??= {};
        const previous = project.cost.modules.municipal ?? {};
        project.cost.modules.municipal = { ...previous, config, ...(generated ? { enabled: true, modelGenerated: true, model } : {}) };
    }, { history: false });
}
function renderMunicipal(host, ctx) {
    const project = ctx.getProject(), config = getMunicipalConfig(project), state = project.cost?.modules?.municipal;
    const { road, drainage, lighting, greening, bridge, allowances } = config;
    const model = state?.modelGenerated || state?.enabled ? calculateMunicipal(config) : null;
    host.innerHTML = `<div class="cost-module-heading"><div><h2>市政工程</h2><p class="help">输入路线长度与横断面，生成道路、管网、路灯和绿化清单。</p></div><button class="button subtle" id="municipal-clear" ${state ? '' : 'disabled'}>清空本专业</button></div>
    <form id="municipal-form" class="cost-config-form">
      <section class="cost-card"><div class="cost-module-heading"><h3>道路参数</h3><button type="button" id="municipal-route" class="button subtle" ${ctx.requestRoute ? '' : 'disabled'}>在图纸上画中心线</button></div>
      <div class="cost-form-grid field-grid">
        ${field('length', '道路长度（m）', road.length)}
        <label class="cost-field"><span class="field-label">道路等级</span><select name="grade" id="municipal-grade"><option value="branch" ${road.grade === 'branch' ? 'selected' : ''}>支路</option><option value="secondary" ${road.grade === 'secondary' ? 'selected' : ''}>次干路</option><option value="arterial" ${road.grade === 'arterial' ? 'selected' : ''}>主干路</option></select></label>
        ${field('width', '红线宽度（m）', road.width, .1, 1000)}${field('carriageway', '车行道宽（m）', road.carriageway, 0, 1000)}${field('sidewalk', '单侧人行道宽（m）', road.sidewalk, 0, 1000)}
      </div><p class="help">中心线按图纸校准后的真实长度读取，也可手工填写。改参数后点击生成；等级只提供宽度建议，结构层须核对设计。</p>
      <details class="cost-details"><summary>结构层 · ${road.layers.length} 层</summary><div class="municipal-layer-list">${road.layers.map((layer, index) => `<div class="municipal-layer-row"><strong>${escape(layer.name)}</strong>${field(`layer-${index}-thickness`, '厚度（cm）', layer.thickness, .1, 200)}<label class="cost-field"><span class="field-label">计量单位</span><select name="layer-${index}-unit">${['m³', 'm²', 't'].map(unit => `<option value="${unit}" ${unit === layer.unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></label><label class="cost-field"><span class="field-label">铺设范围</span><select name="layer-${index}-scope"><option value="carriageway" ${layer.scope === 'carriageway' ? 'selected' : ''}>仅车行道</option><option value="full" ${layer.scope === 'full' ? 'selected' : ''}>全路幅</option></select></label>${field(`layer-${index}-density`, '密度（t/m³，仅吨计量）', layer.density ?? 2.4, .1, 20)}</div>`).join('')}</div><p class="help">沥青默认密度 2.4 t/m³ 为初估参数，可替换为实际材料密度；按面积计价时厚度只作为项目特征。人行道面层另列。</p></details></section>
      <details class="cost-card cost-details"><summary>排水管网</summary><div class="cost-checkbox-row">${check('rain', '雨水', drainage.rain)}${check('sewer', '污水', drainage.sewer)}</div><div class="cost-form-grid field-grid">${field('diameterRain', '雨水管径 DN（mm）', drainage.diameterRain, 50, 5000)}${field('diameterSewer', '污水管径 DN（mm）', drainage.diameterSewer, 50, 5000)}${field('depth', '沟槽槽底埋深（m）', drainage.depth, .1, 30)}${field('manholeSpacing', '检查井间距（m）', drainage.manholeSpacing, 1, 10000)}${field('manholeSize', '检查井外宽（m）', drainage.manholeSize, .3, 10)}${optionalField('outerDiameterRain', '雨水管实际外径（mm）', drainage.outerDiameterRain, 50, 6000)}${optionalField('outerDiameterSewer', '污水管实际外径（mm）', drainage.outerDiameterSewer, 50, 6000)}</div><p class="help">外径留空时按 DN 暂估。井与管道占位不重复扣除，回填同时扣基础；井外扩挖、土质与运距需另行核对。</p></details>
      <details class="cost-card cost-details"><summary>路灯与电气</summary>${check('lighting', '计入路灯、电缆及手孔井', lighting.enabled)}<div class="cost-form-grid field-grid">${field('lightingSpacing', '灯杆间距（m）', lighting.spacing, 1, 10000)}${field('lightingHeight', '灯杆高度（m）', lighting.height, 1, 40)}<label class="cost-field"><span class="field-label">布置侧别</span><select name="lightingSide"><option value="left" ${lighting.side === 'left' ? 'selected' : ''}>左侧</option><option value="right" ${lighting.side === 'right' ? 'selected' : ''}>右侧</option><option value="both" ${lighting.side === 'both' ? 'selected' : ''}>双侧</option></select></label></div></details>
      <details class="cost-card cost-details"><summary>绿化工程</summary>${check('greening', '计入乔木、色带、草坪及种植土', greening.enabled)}<div class="cost-form-grid field-grid">${field('beltWidth', '绿化带总宽（m）', greening.beltWidth, 0, 1000)}${field('treeSpacing', '乔木网格株距（m）', greening.treeSpacing, .1, 1000)}</div><p class="help">绿化面积＝路线长度×绿化带总宽；按网格密度、30% 色带和 70% 草坪初估，绿化位置须核对红线范围。</p></details>
      <details class="cost-card cost-details"><summary>桥梁 · 仅指标估算</summary>${check('bridge', '计入桥梁投资匡算', bridge.enabled)}<div class="cost-form-grid field-grid">${field('bridgeSpan', '跨度（m）', bridge.span, 0, 1000)}${field('bridgeWidth', '桥宽（m）', bridge.width, .1, 200)}</div><p class="cost-warning">按桥面面积综合指标估算，不含征地拆迁、管线迁改、交通导改，误差可达 ±40%，仅用于投资匡算。默认单价是任务书参考区间中值，可在清单中替换。</p></details>
      <details class="cost-card cost-details"><summary>土方假设与措施项目</summary><div class="cost-form-grid field-grid">${field('clearanceDepth', '平均清表深度（m）', allowances.clearanceDepth, 0, 10)}${field('roadFillRatio', '路基回填比例（0–1）', allowances.roadFillRatio, 0, 1)}${field('trenchFactor', '沟槽放坡超挖系数', allowances.trenchFactor, 1, 3)}${optionalField('fenceLength', '实际围挡长度（m）', allowances.fenceLength, 0, 2000000)}</div><div class="cost-checkbox-row">${check('traffic', '交通导行', allowances.traffic)}${check('temporaryDrainage', '临时排水', allowances.temporaryDrainage)}</div><p class="help">围挡留空按两侧 2L 初估。显式措施清单与汇总费率分别列示，可在汇总中调整总体措施费率。</p></details>
      <div class="cost-form-actions"><button id="municipal-generate" type="submit" class="button primary">生成市政造价</button><span class="help">单价未提供时留待填写；所有指标项会标注「估算」。</span></div>
    </form>${model ? preview(model) : '<div class="cost-module-empty"><p>先填写道路长度或绘制中心线，再生成沿线工程量。</p></div>'}`;
    const form = host.querySelector('#municipal-form');
    form.addEventListener('submit', event => {
        event.preventDefault();
        try {
            const next = fromForm(form, config);
            writeConfig(ctx, next, true);
            ctx.toast(next.road.length > 0 ? '市政工程量已生成，请核对估算依据并填写当地综合单价' : '道路长度为 0，未生成工程量');
            ctx.refresh();
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    });
    host.querySelector('#municipal-grade').addEventListener('change', () => {
        const grade = form.elements.namedItem('grade').value;
        const widths = grade === 'arterial' ? [40, 26, 4] : grade === 'secondary' ? [24, 16, 3] : [12, 8, 2];
        ['width', 'carriageway', 'sidewalk'].forEach((name, index) => form.elements.namedItem(name).value = String(widths[index]));
    });
    host.querySelector('#municipal-clear').addEventListener('click', () => {
        if (!confirm('清空市政参数、清单和已填写单价？其他专业不受影响。'))
            return;
        ctx.updateProject(next => { if (next.cost?.modules)
            delete next.cost.modules.municipal; }, { history: false });
        ctx.toast('市政清单已清空');
        ctx.refresh();
    });
    host.querySelector('#municipal-route').addEventListener('click', () => {
        try {
            writeConfig(ctx, fromForm(form, config), false);
            ctx.requestRoute?.((points) => {
                try {
                    const latest = getMunicipalConfig(ctx.getProject());
                    latest.road.points = points.map(point => ({ ...point }));
                    latest.road.length = Number(municipalRouteLength(points).toFixed(6));
                    writeConfig(ctx, latest, false);
                    ctx.toast(`中心线长度 ${measure(latest.road.length)} m 已读取，点击生成市政造价`);
                    ctx.refresh();
                }
                catch (error) {
                    ctx.toast(error.message, true);
                }
            });
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    });
}
export const municipalModule = {
    id: 'municipal', section: '市政', title: '市政', calculate: generateMunicipalItems,
    render: renderMunicipal, validate: validateMunicipalState,
};
//# sourceMappingURL=municipal-module.js.map