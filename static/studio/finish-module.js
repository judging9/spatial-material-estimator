import { escape, measure } from './ui.js';
import { formatMoney, normalizeDecimal } from './lib/pricing.js';
import { summarize } from './lib/cost.js';
import { buildFinishModel, calculateFinish, normalizeFinishConfig, validateFinishState, inferSpaceType, FINISH_GRADES, SPACE_TYPES, FINISH_LAYERS, FINISH_POINT_DEFAULTS } from './lib/finish.js';
const options = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${value}"${selected === value ? ' selected' : ''}>${escape(label)}</option>`).join('');
const numberField = (name, label, value, min = 0, max = 100) => `<label><span class="field-label">${escape(label)}</span><input name="${name}" type="number" min="${min}" max="${max}" step="any" value="${value}" required></label>`;
const pointNames = { switches: '开关', sockets: '插座', lights: '灯具', water: '给水点', drains: '排水点' };
// Keep valid, unapplied form edits when the user visits another trade tab.
const drafts = new Map();
function renderFinish(host, ctx) {
    const project = ctx.getProject(), state = project.cost?.modules?.finish ?? {};
    const signature = JSON.stringify(state.config ?? {}), draft = drafts.get(project.id);
    const config = normalizeFinishConfig(draft?.signature === signature ? draft.config : state.config ?? {});
    if (draft?.signature !== signature)
        drafts.delete(project.id);
    let model;
    let measurementError = '';
    try {
        model = buildFinishModel(project, config);
    }
    catch (error) {
        measurementError = error.message;
    }
    let summary;
    if (!measurementError && state.enabled) {
        try {
            summary = summarize(calculateFinish(project), { measureRate: '0', taxRate: '0' });
        }
        catch (error) {
            measurementError = error.message;
        }
    }
    const measured = new Map((model?.rooms ?? []).map(room => [room.regionId, room]));
    host.innerHTML = `<div class="cost-module-head"><div><span class="eyebrow">Interior finishes</span><h2>装饰装修</h2><p class="help">给房间选择空间类型和档次，生成地面、墙面、天棚、门窗与水电做法。</p></div><button type="button" id="finish-one-click" class="button primary">一键精装</button></div>
    <p class="cost-notice">工序分层计价：面层不含找平和粘结层，墙砖不含抹灰，吊顶不含灯具，门不含门套。材料与安装人工分列；没有报价的工序保持待填单价。</p>
    ${measurementError ? `<p class="cost-notice" role="alert">${escape(measurementError)}</p>` : ''}
    <form id="finish-form">
      <section class="cost-card"><div class="cost-fields"><label><span class="field-label">全局装修档次</span><select id="finish-grade" name="grade">${options(FINISH_GRADES, config.grade)}</select></label><div><span class="field-label">当前房间</span><strong>${project.regions.length} 间 · ${model ? measure(model.totalArea) + ' m² 净面积' : '面积待校准'}</strong><p class="help">一键精装使用中档方案，保留空间类型；施工报价需要填写或核对。</p></div>${summary ? `<div><span class="field-label">${summary.missingPriceCount ? '已定价部分' : '装修工程小计'}（不含统一措施与税金）</span><strong>¥ ${formatMoney(summary.total)}</strong><p class="help">${summary.estimateCount} 项估算 · ${summary.missingPriceCount} 项待填单价</p></div>` : ''}</div></section>
      <section class="cost-card"><div class="section-head"><h3>房间与空间类型</h3><span class="chip">${project.regions.length}</span></div>
        ${project.regions.length ? `<div class="cost-actions"><label class="field-label"><input id="finish-select-all" type="checkbox"> 全选房间</label><select id="finish-batch-type" aria-label="批量空间类型">${options(SPACE_TYPES, 'bedroom')}</select><button id="finish-batch-apply" type="button" class="button subtle">应用到选中房间</button></div><div class="finish-room-list">${project.regions.map(region => {
        const pref = config.rooms.find(room => room.regionId === region.id), type = pref?.spaceType ?? inferSpaceType(region.name), room = measured.get(region.id);
        const points = { ...FINISH_POINT_DEFAULTS[type], ...pref?.points };
        return `<div class="finish-room-row" data-finish-room="${escape(region.id)}"><div class="cost-fields"><label><input type="checkbox" data-finish-select="${escape(region.id)}"> <strong>${escape(region.name || '房间')}</strong></label><label><span class="field-label">空间类型</span><select data-finish-room-type="${escape(region.id)}">${options(SPACE_TYPES, type)}</select></label><label><span class="field-label">单房间档次</span><select data-finish-room-grade="${escape(region.id)}"><option value="">跟随全局</option>${options(FINISH_GRADES, pref?.grade ?? '')}</select></label></div>
            <details><summary>测量与水电点位${room?.wet ? ' · 湿区' : ''}</summary><p class="help">${room ? `净面积 ${measure(room.netArea)} m² · 周长 ${measure(room.perimeter)} m · 内墙 ${measure(room.wallArea)} m²${room.wallEstimate ? `（${measure(room.estimatedBoundaryLength)} m 边界按高度初估）` : '（实际墙体）'} · 门 ${room.doors} 樘 · 窗 ${room.windows} 樘` : '请先校准图纸真实尺寸；内墙高度无模型时按输入高度初步估算。'}</p><div class="cost-fields">${Object.entries(pointNames).map(([key, label]) => `<label><span class="field-label">${label}（${key === 'lights' ? '套' : '个'}，初估）</span><input data-finish-point="${key}"${pref?.points?.[key] !== undefined ? ' data-edited="true"' : ''} type="number" min="0" max="1000" step="1" value="${points[key]}" required></label>`).join('')}</div></details></div>`;
    }).join('')}</div>` : '<p class="help">先返回绘图工作台，画墙闭合生成房间，或上传图纸、校准并圈选区域。</p>'}
      </section>
      <details class="cost-card"><summary>施工范围与高级参数</summary><div class="cost-actions"><label><input type="checkbox" name="ceiling"${config.ceiling ? ' checked' : ''}> 吊顶龙骨与面板</label><label><input type="checkbox" name="lightCove"${config.lightCove ? ' checked' : ''}> 跌级 / 灯槽初估</label><label><input type="checkbox" name="doorCasings"${config.doorCasings ? ' checked' : ''}> 门套（精装可启用）</label></div><div class="cost-fields">
        ${numberField('wallHeight', '无实际墙体时的估算墙高（m）', config.wallHeight, .5, 10)}
        ${numberField('wetWallHeight', '湿区墙砖高度上限（m）', config.wetWallHeight, 0, 10)}
        ${numberField('wetUpstand', '地面防水上翻高度（m）', config.wetUpstand, 0, 3)}
        ${numberField('floorWasteRate', '地面材料采购损耗（%）', config.floorWasteRate)}
        ${numberField('ceilingWasteRate', '吊顶面板采购损耗（%）', config.ceilingWasteRate)}
        ${numberField('conduitPerArea', '配管初估（m / m²）', config.conduitPerArea)}
        ${numberField('wireMultiplier', '配线 / 配管长度倍数', config.wireMultiplier, 0, 30)}
        ${numberField('waterPerWetRoom', '每间湿区给水管初估（m）', config.waterPerWetRoom, 0, 1000)}
        ${numberField('drainPerWetRoom', '每间湿区排水管初估（m）', config.drainPerWetRoom, 0, 1000)}
      </div><p class="help">档次本身不改变净面积、周长或共享工序数量。是否吊顶、灯槽和门套由独立施工范围开关决定；水电管线与建议点位均为初步估算。</p></details>
      <div class="cost-actions"><button id="finish-generate" type="submit" class="button primary">生成装修造价</button><button id="finish-clear" type="button" class="button subtle">清空本专业</button></div>
    </form>
    <details class="cost-card"><summary>配置不同档次的实际工序报价</summary><p class="help">填入供应商或施工单位提供的真实单价。没有数据时留空；软件不会凭档次自动编造加价。明细表的单行确认价格优先保留。</p><form id="finish-grade-prices"><label><span class="field-label">工序</span><select id="finish-price-layer">${FINISH_LAYERS.map(layer => `<option value="${layer.id}">${escape(layer.group + ' · ' + layer.name)}（${layer.unit}）</option>`).join('')}</select></label><div class="cost-fields">${Object.entries(FINISH_GRADES).map(([grade, label]) => `<label><span class="field-label">${label}单价（元 / 当前工序单位）</span><input data-finish-grade-price="${grade}" type="number" min="0" step="any" placeholder="未提供报价"></label>`).join('')}</div><button type="submit" class="button subtle">保存档次报价</button></form></details>
    ${model?.warnings.length ? `<div class="cost-notice">${model.warnings.map(escape).join('<br>')}</div>` : ''}
    <p class="help">清单编码为示意，以当地清单规范为准。本表用于方案估算；水电未读取实际管线路径，不能替代施工图预算。</p>`;
    const mainForm = host.querySelector('#finish-form');
    const readConfig = () => {
        const form = new FormData(mainForm);
        const next = { ...config, grade: String(form.get('grade')), rooms: project.regions.map(region => {
                const row = [...host.querySelectorAll('[data-finish-room]')].find(row => row.dataset.finishRoom === region.id);
                const grade = row.querySelector('[data-finish-room-grade]').value;
                const points = Object.fromEntries([...row.querySelectorAll('[data-finish-point]')].filter(input => input.dataset.edited).map(input => [input.dataset.finishPoint, Number(input.value)]));
                return { regionId: region.id, spaceType: row.querySelector('[data-finish-room-type]').value, ...(grade ? { grade } : {}), points };
            }), ceiling: form.has('ceiling'), lightCove: form.has('lightCove'), doorCasings: form.has('doorCasings') };
        for (const key of ['wallHeight', 'wetWallHeight', 'wetUpstand', 'floorWasteRate', 'ceilingWasteRate', 'conduitPerArea', 'wireMultiplier', 'waterPerWetRoom', 'drainPerWetRoom'])
            next[key] = Number(form.get(key));
        return normalizeFinishConfig(next);
    };
    const generate = (oneClick = false) => {
        try {
            if (!mainForm.reportValidity())
                return;
            const next = readConfig();
            if (oneClick) {
                next.grade = 'standard';
                next.rooms = next.rooms.map(room => ({ ...room, grade: undefined }));
            }
            next.materials = ctx.getMaterials().filter(material => material.unit === 'm²' && /瓷砖|地砖/.test(material.name)).slice(0, 50).map(material => ({ ...structuredClone(material), image: '' }));
            const generated = buildFinishModel(project, next);
            if (!generated.rooms.length)
                throw new RangeError('请先绘制或圈选至少一个房间');
            drafts.delete(project.id);
            ctx.updateProject(current => {
                current.cost ??= {};
                current.cost.modules ??= {};
                current.cost.modules.finish = { ...current.cost.modules.finish, config: next, enabled: true, modelGenerated: true, model: generated };
            }, { history: false });
            ctx.refresh();
            ctx.toast(`已生成 ${generated.rooms.length} 间房的装修做法；请核对待填单价与水电估算`);
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    };
    mainForm.addEventListener('submit', event => { event.preventDefault(); generate(); });
    const captureDraft = () => {
        try {
            if (mainForm.checkValidity())
                drafts.set(project.id, { signature, config: readConfig() });
        }
        catch { /* Invalid input is reported by the form when the user generates. */ }
    };
    mainForm.addEventListener('input', captureDraft);
    mainForm.addEventListener('change', captureDraft);
    host.querySelector('#finish-one-click').addEventListener('click', () => generate(true));
    host.querySelector('#finish-clear').addEventListener('click', () => {
        if (!confirm('清空本专业的参数、单价和生成清单？其他专业及图纸保留。'))
            return;
        drafts.delete(project.id);
        ctx.updateProject(current => { if (current.cost?.modules)
            delete current.cost.modules.finish; }, { history: false });
        ctx.refresh();
        ctx.toast('已清空装修专业');
    });
    const updateDefaults = (row) => {
        const type = row.querySelector('[data-finish-room-type]').value;
        for (const input of row.querySelectorAll('[data-finish-point]'))
            if (!input.dataset.edited)
                input.value = String(FINISH_POINT_DEFAULTS[type][input.dataset.finishPoint]);
    };
    for (const row of host.querySelectorAll('[data-finish-room]')) {
        row.querySelector('[data-finish-room-type]').addEventListener('change', () => updateDefaults(row));
        for (const input of row.querySelectorAll('[data-finish-point]'))
            input.addEventListener('input', () => input.dataset.edited = 'true');
    }
    host.querySelector('#finish-select-all')?.addEventListener('change', event => {
        for (const input of host.querySelectorAll('[data-finish-select]'))
            input.checked = event.target.checked;
    });
    host.querySelector('#finish-batch-apply')?.addEventListener('click', () => {
        const type = host.querySelector('#finish-batch-type').value;
        let count = 0;
        for (const row of host.querySelectorAll('[data-finish-room]'))
            if (row.querySelector('[data-finish-select]').checked) {
                row.querySelector('[data-finish-room-type]').value = type;
                updateDefaults(row);
                count++;
            }
        captureDraft();
        ctx.toast(count ? `已为 ${count} 间房设置空间类型，点击生成应用` : '请先勾选房间', !count);
    });
    const priceForm = host.querySelector('#finish-grade-prices');
    const fillGradePrices = () => {
        const id = host.querySelector('#finish-price-layer').value;
        for (const input of host.querySelectorAll('[data-finish-grade-price]'))
            input.value = config.gradePrices[input.dataset.finishGradePrice]?.[id] ?? '';
    };
    fillGradePrices();
    host.querySelector('#finish-price-layer').addEventListener('change', fillGradePrices);
    priceForm.addEventListener('submit', event => {
        event.preventDefault();
        try {
            const next = readConfig(), id = host.querySelector('#finish-price-layer').value;
            for (const input of host.querySelectorAll('[data-finish-grade-price]')) {
                const grade = input.dataset.finishGradePrice;
                next.gradePrices[grade] ??= {};
                if (input.value.trim())
                    next.gradePrices[grade][id] = normalizeDecimal(input.value, '工序单价');
                else
                    delete next.gradePrices[grade][id];
            }
            drafts.delete(project.id);
            ctx.updateProject(current => {
                current.cost ??= {};
                current.cost.modules ??= {};
                current.cost.modules.finish = { ...current.cost.modules.finish, config: normalizeFinishConfig(next) };
            }, { history: true });
            ctx.refresh();
            ctx.toast('已保存档次工序报价；生成后可在明细中确认单行价格');
        }
        catch (error) {
            ctx.toast(error.message, true);
        }
    });
}
export const finishModule = { id: 'finish', section: '装饰装修', title: '装饰装修', calculate: calculateFinish, render: renderFinish, validate: validateFinishState };
//# sourceMappingURL=finish-module.js.map