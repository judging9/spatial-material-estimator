import { createEarthworkTransfer, validateEarthworkTransferConfig } from './lib/earthwork-transfer.js';
import { analyzeProjectEarthworkTransfer } from './lib/earthwork-transfer-project.js';
import { roadProfileAnalysis } from './lib/road-profile.js';
import { addDecimal, multiplyDecimal, normalizeDecimal } from './lib/pricing.js';
import { escape, icon, measure, money, openDialog, toast } from './ui.js';
const quantity = (value) => value === null || value === undefined ? '待确认' : measure(Number(value), 3);
function roadCandidate(project, road) {
    const base = { id: road.id, name: road.name, available: null, demand: null, reason: null };
    try {
        if (!road.roadProfile?.enabled)
            return { ...base, reason: '先设置道路纵断面' };
        if (!road.roadProfile.earthworkBalance?.enabled)
            return { ...base, reason: '先启用道路土方平衡并填写转换系数' };
        if (normalizeDecimal(road.quantity) !== '1')
            return { ...base, reason: '跨路调配须将道路预算份数设为 1' };
        const balance = roadProfileAnalysis(project, road).earthworkBalance;
        if (!balance.volumes)
            return { ...base, reason: balance.pendingReason ?? '实测地形或转换参数待确认' };
        return { ...base, available: addDecimal(balance.volumes.usableCutNatural, multiplyDecimal(balance.volumes.reuseNatural, '-1')), demand: balance.volumes.borrowNatural };
    }
    catch (error) {
        return { ...base, reason: error instanceof Error ? error.message : '请核对道路参数' };
    }
}
function resultSum(result, key) {
    if (result.pending || result.roads.some(road => road[key] === null))
        return null;
    return result.roads.reduce((sum, road) => addDecimal(sum, road[key]), '0');
}
function preview(result) {
    if (!result.enabled)
        return `<div class="et-empty">${icon('route', 22)}<strong>道路之间，让土方更好地利用</strong><p>启用调配后，先在所选道路间复用可用余土，再核对剩余外购与弃方。</p></div>`;
    const summary = [['transferredNatural', '场内调运', result.transferredNatural, 'm³'], ['residualBorrowNatural', '剩余外购', resultSum(result, 'residualBorrowNatural'), 'm³'], ['residualSpoilNatural', '剩余弃方', resultSum(result, 'residualSpoilNatural'), 'm³']];
    return `<div class="et-summary">${summary.map(([key, name, value, unit]) => `<div><span>${name}</span><strong data-transfer-stat="${key}">${quantity(value)} <small>${unit}</small></strong></div>`).join('')}</div>
    <div class="et-result-cost"><span>跨路运输费用</span><strong data-transfer-stat="totalHaulCost">${result.totalHaulCost === null ? '待确认' : '¥ ' + money(result.totalHaulCost)}</strong></div>
    ${result.pendingReasons.length ? `<div class="et-pending" role="status">${result.pendingReasons.map(reason => `<p>${escape(reason)}</p>`).join('')}</div>` : result.routes.length ? '<p class="help">先使场内调运量最大；相同调运量下，选择运输费用较低的组合。</p>' : '<p class="help">尚无允许调运的路线，当前不会在道路之间转移土方。</p>'}
    ${result.routes.length ? `<div class="et-result-routes">${result.routes.map(route => `<div class="et-result-route" data-transfer-result-route="${escape(route.id)}"><strong>${escape(route.name)}</strong><div><span>天然方 <b>${quantity(route.naturalQuantity)} m³</b></span><span>松方 × 运距 <b>${quantity(route.haulQuantity)} m³·km</b></span></div><span class="et-route-amount">${route.amount === null ? '待确认' : '¥ ' + money(route.amount)}</span></div>`).join('')}</div>` : ''}
    ${result.roads.length ? `<details class="et-road-results"><summary>各道路收发与剩余量</summary>${result.roads.map(road => `<div class="et-road-result"><strong>${escape(road.name)}</strong><span>调入 ${quantity(road.incomingNatural)} / 调出 ${quantity(road.outgoingNatural)} m³</span><small>剩余借方 ${quantity(road.residualBorrowNatural)} / 弃方 ${quantity(road.residualSpoilNatural)} m³</small></div>`).join('')}</details>` : ''}`;
}
export function renderEarthworkTransferEntry(project) {
    const config = project.municipalEarthworkTransfer;
    let caption = '跨道路复用、借方与弃方';
    if (config?.enabled) {
        try {
            const result = analyzeProjectEarthworkTransfer(project);
            caption = result.pending ? `待完善 · ${config.roadIds.length} 条道路` : `${quantity(result.transferredNatural)} m³ 场内调运`;
        }
        catch {
            caption = '调配参数待核对';
        }
    }
    return `<button class="engineering-entry" data-action="earthwork-transfer"><span>${icon('route', 17)}</span><span><strong>土方调配</strong><small>${escape(caption)}</small></span>${icon('chevronRight', 13)}</button>`;
}
/** A reversible project draft; only explicit application changes the estimate. */
export function showEarthworkTransferEditor(project, onChange) {
    const draft = structuredClone(project.municipalEarthworkTransfer ?? createEarthworkTransfer());
    const candidates = (project.municipalElements ?? []).filter(road => road.kind === 'road').map(road => roadCandidate(project, road));
    const candidateMap = new Map(candidates.map(road => [road.id, road]));
    const name = (id) => candidateMap.get(id)?.name ?? '已删除道路 · ' + id;
    const dialog = openDialog('跨道路土方调配', `<form id="earthwork-transfer-form"><div class="et-master"><label><input id="earthwork-transfer-enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}>启用跨道路调配</label><span class="help">使用实际道路土方，按用户确认的路线运输</span></div><div class="et-layout"><section class="et-config"><div class="et-step-head"><span>01</span><div><h3>选择参与的道路</h3><p class="help">先完成各道路的纵断面与土方平衡，预算份数须为 1。</p></div><small id="transfer-road-count"></small></div><div id="transfer-road-list" class="et-road-list"></div><p class="help et-natural-note">可用余方已扣除本路复用，排除不可用土料；余方与借方均为天然体积。</p><div class="et-step-head et-routes-head"><span>02</span><div><h3>确认运输路线</h3><p class="help">土料适用性、实际运距和运输单价由你确认。</p></div></div><div class="et-add-route"><label><span class="field-label">从哪条道路</span><select id="transfer-from" aria-label="调运起点"><option value="">选择来源</option></select></label><span class="et-add-arrow">${icon('arrow', 16)}</span><label><span class="field-label">运往哪条道路</span><select id="transfer-to" aria-label="调运目标"><option value="">选择目标</option></select></label><button id="transfer-add-route" type="button" class="button subtle">${icon('plus', 14)}添加</button></div><div id="transfer-route-list"></div><p id="transfer-selection-note" class="help" role="status"></p><p class="help et-scope-note">只采用明确允许的路线，运距不会按两条道路的直线距离代填。未确认或未勾选的路线不参与调配。</p></section><aside class="et-preview-aside"><span class="eyebrow">Earthwork balance</span><h3>调配后的工程量</h3><div id="transfer-preview" aria-live="polite"></div><p class="help et-budget-note">应用后，剩余借料与弃方运输量同步更新到原道路报价，跨路运输费用只计一次。</p></aside></div><p id="transfer-error" class="et-error" role="status"></p></form>`, { wide: true, subtitle: '确认路线与价格，核对场内复用、外购和弃方', footer: '<span id="transfer-draft-state" class="help">应用后可撤销，关闭窗口保留原报价。</span><button id="transfer-cancel" type="button" class="button subtle">取消</button><button id="transfer-apply" class="button primary" type="submit" form="earthwork-transfer-form">应用调配方案</button>' });
    dialog.classList.add('earthwork-transfer-dialog');
    const errorNode = dialog.querySelector('#transfer-error');
    const selectionNote = dialog.querySelector('#transfer-selection-note');
    const reportError = (error) => { errorNode.textContent = error instanceof Error ? error.message : '请核对调配参数'; };
    const refreshPreview = () => {
        try {
            validateEarthworkTransferConfig(draft);
            const result = analyzeProjectEarthworkTransfer(project, draft);
            dialog.querySelector('#transfer-preview').innerHTML = preview(result);
            errorNode.textContent = '';
            dialog.querySelector('#transfer-draft-state').textContent = result.enabled && result.pending ? '当前为待完善方案，可保存后继续填写。' : '应用后可撤销，关闭窗口保留原报价。';
        }
        catch (error) {
            reportError(error);
            dialog.querySelector('#transfer-preview').innerHTML = '<div class="et-empty"><strong>请先核对输入</strong><p>纠正下方提示后，真实工程量和费用会重新计算。</p></div>';
        }
    };
    const renderRoads = () => {
        const rows = [...candidates, ...draft.roadIds.filter(id => !candidateMap.has(id)).map(id => ({ id, name: name(id), available: null, demand: null, reason: '道路已删除；移除该项后可重新选择', missing: true }))];
        dialog.querySelector('#transfer-road-count').textContent = `${draft.roadIds.length} / 12`;
        dialog.querySelector('#transfer-road-list').innerHTML = rows.length ? `<div class="et-road-head"><span>道路</span><span>可用余方</span><span>借方需求</span></div>${rows.map(road => `<label class="et-road-choice${draft.roadIds.includes(road.id) ? ' selected' : ''}${road.missing ? ' missing' : ''}"><span><input type="checkbox" data-transfer-road="${escape(road.id)}" ${draft.roadIds.includes(road.id) ? 'checked' : ''}><span><strong>${escape(road.name)}</strong>${road.reason ? `<small>${escape(road.reason)}</small>` : ''}</span></span><b>${quantity(road.available)}${road.available === null ? '' : ' m³'}</b><b>${quantity(road.demand)}${road.demand === null ? '' : ' m³'}</b></label>`).join('')}` : '<div class="et-list-empty">尚无道路。请先在场地中画道路，再设置纵断面和土方平衡。</div>';
    };
    const renderRouteSelectors = () => {
        for (const [id, placeholder] of [['transfer-from', '选择来源'], ['transfer-to', '选择目标']]) {
            const input = dialog.querySelector('#' + id), previous = input.value;
            input.innerHTML = `<option value="">${placeholder}</option>` + draft.roadIds.filter(id => candidateMap.has(id)).map(id => `<option value="${escape(id)}">${escape(name(id))}</option>`).join('');
            input.value = draft.roadIds.includes(previous) ? previous : '';
        }
        dialog.querySelector('#transfer-add-route').disabled = draft.roadIds.filter(id => candidateMap.has(id)).length < 2;
    };
    const renderRoutes = () => {
        dialog.querySelector('#transfer-route-list').innerHTML = draft.routes.length ? draft.routes.map(route => `<section class="et-route-card" data-transfer-route-row="${escape(route.id)}"><div class="et-route-heading"><strong>${escape(name(route.fromRoadId))}<span>${icon('arrow', 13)}</span>${escape(name(route.toRoadId))}</strong><button type="button" class="icon-button" data-transfer-remove-route="${escape(route.id)}" aria-label="删除从${escape(name(route.fromRoadId))}到${escape(name(route.toRoadId))}的路线">${icon('trash', 14)}</button></div><label class="et-route-confirm"><input type="checkbox" data-transfer-route-enabled="${escape(route.id)}" ${route.enabled ? 'checked' : ''}>允许调运 · 已确认土料可用于目标道路</label><div class="et-route-fields"><label><span class="field-label">实际运输距离</span><span class="input-affix"><input data-transfer-route="${escape(route.id)}" data-transfer-field="distanceKm" type="number" min="0" step="any" value="${escape(route.distanceKm)}" placeholder="待填写" aria-label="${escape(name(route.fromRoadId))}到${escape(name(route.toRoadId))}运距"><span>km</span></span></label><label><span class="field-label">松方运输单价</span><span class="input-affix"><input data-transfer-route="${escape(route.id)}" data-transfer-field="unitPrice" type="number" min="0" step="any" value="${escape(route.unitPrice)}" placeholder="待填写" aria-label="${escape(name(route.fromRoadId))}到${escape(name(route.toRoadId))}单价"><span>元/(m³·km)</span></span></label></div></section>`).join('') : '<div class="et-list-empty et-no-routes">选择来源和目标，添加实际可用的运输路线。</div>';
    };
    dialog.addEventListener('input', event => {
        const input = event.target;
        if (!input.dataset.transferRoute || !input.dataset.transferField)
            return;
        const route = draft.routes.find(route => route.id === input.dataset.transferRoute);
        if (!route)
            return;
        route[input.dataset.transferField] = input.value.trim();
        refreshPreview();
    });
    dialog.addEventListener('change', event => {
        const input = event.target;
        if (input.id === 'earthwork-transfer-enabled') {
            draft.enabled = input.checked;
            refreshPreview();
            return;
        }
        if (input.dataset.transferRoad) {
            const id = input.dataset.transferRoad;
            selectionNote.textContent = '';
            if (input.checked) {
                if (draft.roadIds.length >= 12) {
                    input.checked = false;
                    selectionNote.textContent = '一个调配方案最多选择 12 条道路。';
                    return;
                }
                if (!draft.roadIds.includes(id))
                    draft.roadIds.push(id);
            }
            else {
                draft.roadIds = draft.roadIds.filter(value => value !== id);
                const count = draft.routes.filter(route => route.fromRoadId === id || route.toRoadId === id).length;
                draft.routes = draft.routes.filter(route => route.fromRoadId !== id && route.toRoadId !== id);
                if (count)
                    selectionNote.textContent = `已同时移除这条道路的 ${count} 条运输路线；应用后可撤销。`;
            }
            renderRoads();
            renderRouteSelectors();
            renderRoutes();
            refreshPreview();
            return;
        }
        if (input.dataset.transferRouteEnabled) {
            const route = draft.routes.find(route => route.id === input.dataset.transferRouteEnabled);
            if (route) {
                route.enabled = input.checked;
                refreshPreview();
            }
        }
    });
    dialog.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target)
            return;
        if (target.id === 'transfer-cancel') {
            dialog.close();
            return;
        }
        if (target.id === 'transfer-add-route') {
            const fromRoadId = dialog.querySelector('#transfer-from').value, toRoadId = dialog.querySelector('#transfer-to').value;
            if (!fromRoadId || !toRoadId) {
                selectionNote.textContent = '请选择这条路线的来源和目标道路。';
                return;
            }
            if (fromRoadId === toRoadId) {
                selectionNote.textContent = '来源和目标须为不同道路。';
                return;
            }
            if (draft.routes.some(route => route.fromRoadId === fromRoadId && route.toRoadId === toRoadId)) {
                selectionNote.textContent = '这条运输路线已存在，可直接修改其运距和单价。';
                return;
            }
            draft.routes.push({ id: 'transfer-' + crypto.randomUUID(), fromRoadId, toRoadId, enabled: false, distanceKm: '', unitPrice: '' });
            selectionNote.textContent = '新增路线尚未参与调配，请先确认土料适用性，再填写运距和单价。';
            renderRoutes();
            refreshPreview();
            return;
        }
        if (target.dataset.transferRemoveRoute) {
            draft.routes = draft.routes.filter(route => route.id !== target.dataset.transferRemoveRoute);
            selectionNote.textContent = '路线已从当前方案移除，应用后可撤销。';
            renderRoutes();
            refreshPreview();
        }
    });
    dialog.querySelector('#earthwork-transfer-form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            validateEarthworkTransferConfig(draft);
            analyzeProjectEarthworkTransfer(project, draft);
            onChange(structuredClone(draft));
            dialog.close();
            toast('土方调配方案已应用，道路预算同步更新');
        }
        catch (error) {
            reportError(error);
            toast(error instanceof Error ? error.message : '请核对调配参数', true);
        }
    });
    renderRoads();
    renderRouteSelectors();
    renderRoutes();
    refreshPreview();
    return dialog;
}
//# sourceMappingURL=earthwork-transfer-panel.js.map