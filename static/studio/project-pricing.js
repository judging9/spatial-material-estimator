import { collectProjectPriceRows, previewProjectPriceChanges } from './lib/project-price-edit.js';
import { calculateProjectQuantities, downloadProjectQuantitiesCSV, printProjectQuantitiesReport } from './lib/project-quantities.js';
import { escape, icon, money, openDialog, toast } from './ui.js';
const fieldNames = { unitPrice: '单价', laborRate: '人工单价', wasteRate: '损耗率' };
const labels = { decoration: '装修', civil: '土建', municipal: '市政' };
const priceFields = ['unitPrice', 'laborRate', 'wasteRate'];
const asMoney = (value) => value === null ? '—' : `¥ ${money(value)}`;
const budgetAmount = (budget) => budget.status === 'empty' ? '—' : asMoney(budget.knownTotal);
const budgetLabel = (budget) => budget.pending ? '已定价部分 · 含税' : budget.status === 'empty' ? '尚无计价内容' : '含税总预算';
const sourceSignature = (project) => JSON.stringify(project, (key, value) => ['quoteSummary', 'budgetSummary', 'savedAt', 'updatedAt'].includes(key) ? undefined : value);
const quantityText = (value, unit) => value === null ? '待确认' : `${escape(value)} <small>${escape(unit)}</small>`;
const rowNote = (row) => [row.pendingReasons.join('；'), row.sourceNote, row.editNote].filter(Boolean).join(' · ');
const emptyPriceLabel = (pending) => pending ? '待填' : '零量无需单价';
const issueFor = (row, message = '查看对象的计量与报价配置') => ({
    id: `pricing-locate:${row.section}:${row.levelId ?? ''}:${row.targetType}:${row.targetId ?? ''}`, section: row.section,
    levelId: row.levelId, targetType: row.targetType, targetId: row.targetId, title: row.objectName, message, severity: 'info',
});
let activePricing = null;
export function refreshProjectPricing() {
    if (activePricing?.dialog.open && document.querySelector('#dialog') === activePricing.dialog)
        activePricing.refresh();
}
/** A quote draft keeps raw geometry and confirmed project prices intact until application. */
export function openProjectPricing(project, callbacks, initialTab = 'pricing') {
    let baseProject = structuredClone(project), baseline = sourceSignature(project), tab = initialTab;
    let baseRows = collectProjectPriceRows(baseProject), draftRows = baseRows;
    let preview = previewProjectPriceChanges(baseProject, []);
    let changes = new Map(), selected = new Set();
    const invalid = new Map();
    const filters = { section: 'all', level: 'all', status: baseRows.some(row => row.pending) ? 'pending' : 'all', unit: 'all', query: '' };
    let stale = false, applying = false, rowKey = '';
    const dialog = openDialog('报价与工程用量', `
    <nav class="pricing-tabs" aria-label="报价与清单"><button type="button" data-pricing-tab="pricing">${icon('edit', 15)}批量报价<span data-pricing-row-count></span></button><button type="button" data-pricing-tab="quantities">${icon('layers', 15)}工程用量<span data-pricing-group-count></span></button></nav>
    <section data-pricing-pane="pricing"><div class="pricing-intro"><div><h3>把报价一次填完整</h3><p>数量沿用实际几何。可逐行填写，也可选择同单位项目统一填价。</p></div><span class="pricing-draft-state" data-pricing-draft-state>当前工程</span></div>
      <div class="pricing-filters"><label class="pricing-search">${icon('search', 14)}<input id="pricing-search" type="search" placeholder="查找材料、对象或规格" aria-label="搜索报价项目"></label><select id="pricing-section" aria-label="筛选专业"><option value="all">全部专业</option>${Object.entries(labels).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select><select id="pricing-level" aria-label="筛选楼层"><option value="all">全部楼层</option></select><select id="pricing-unit" aria-label="筛选计量单位"><option value="all">全部单位</option></select><select id="pricing-status" aria-label="筛选报价状态"><option value="all">全部项目</option><option value="pending">待完善</option><option value="changed">已修改</option></select></div>
      <div class="pricing-bulk"><div class="pricing-selection"><strong data-pricing-selected>选择项目</strong><button type="button" class="text-button" data-pricing-clear-selection>清除</button></div><label><span>统一单价</span><input id="pricing-bulk-unit-price" type="number" min="0" step="any" placeholder="不修改" aria-label="批量统一单价"></label><label><span>统一人工</span><input id="pricing-bulk-labor-rate" type="number" min="0" step="any" placeholder="不修改" aria-label="批量统一人工单价"></label><label><span>统一损耗 %</span><input id="pricing-bulk-waste-rate" type="number" min="0" step="any" placeholder="不修改" aria-label="批量统一损耗率"></label><button type="button" class="button" data-pricing-bulk-apply>填入所选项目</button><p data-pricing-bulk-note>先勾选需要一起填写的项目；空白字段保持原值。</p></div>
      <div class="pricing-worksheet"><div class="pricing-row pricing-column-head"><label><input type="checkbox" data-pricing-select-all aria-label="选择当前显示的可编辑报价项目"></label><span>项目 / 规格</span><span>净用量</span><span>单价</span><span>人工</span><span>损耗 %</span><span>分项金额</span><span></span></div><div data-pricing-rows></div></div><p class="pricing-scope-note">仅列出已汇入总预算且已启用的计价项。项目固定费、工程量和几何在原工程中维护。</p>
    </section>
    <section data-pricing-pane="quantities" hidden><div class="pricing-intro"><div><h3>按实际规格核对工程用量</h3><p>同规格、同单价及同来源的项目归并，点击来源可定位到原对象。</p></div><span class="pricing-draft-state" data-quantities-state></span></div><div class="quantities-summary" data-quantities-summary></div><p class="pricing-quantity-draft" data-quantities-draft hidden>报价草稿尚未应用，清单仍按当前工程显示。应用草稿后可导出更新后的清单。</p><div data-quantity-groups></div><div class="quantities-notes" data-quantities-notes></div></section>
    <p id="pricing-error" class="pricing-error" role="status" aria-live="polite"></p>`, {
        wide: true, subtitle: '集中确认价格，核对用量，再应用到工程',
        footer: `<div class="pricing-footer-left"><button type="button" class="text-button" data-pricing-back>${icon('chevronLeft', 13)}工程总览</button><span class="pricing-history"><button type="button" class="icon-button" data-pricing-undo aria-label="撤销工程报价" title="撤销工程报价">${icon('undo', 15)}</button><button type="button" class="icon-button" data-pricing-redo aria-label="重做工程报价" title="重做工程报价">${icon('redo', 15)}</button></span></div><div class="pricing-preview"><span><small data-pricing-before-label>当前</small><strong data-pricing-before></strong></span><span class="pricing-preview-arrow">${icon('arrow', 14)}</span><span><small data-pricing-after-label>应用后</small><strong data-pricing-after></strong></span></div><div class="pricing-footer-actions"><button type="button" class="button subtle" data-pricing-discard>放弃草稿</button><button type="button" class="button" data-pricing-save>${icon('save', 13)}保存</button><button type="button" class="button primary" data-pricing-apply>应用报价</button><button type="button" class="button" data-quantity-export="csv" hidden>用量 CSV</button><button type="button" class="button primary" data-quantity-export="pdf" hidden>打印 / PDF</button></div><p class="pricing-footer-status" data-pricing-feedback role="status" aria-live="polite"></p>`,
    });
    dialog.classList.add('project-pricing-dialog');
    const query = (selector) => dialog.querySelector(selector);
    const setText = (selector, value) => { const element = query(selector); if (element && element.textContent !== value)
        element.textContent = value; };
    const dirty = () => changes.size > 0 || invalid.size > 0;
    const error = (message = '') => setText('#pricing-error', message || [...invalid.values()].map(item => item.message).join('；'));
    const visibleRows = () => draftRows.filter(row => (filters.section === 'all' || row.section === filters.section) && (filters.level === 'all' || (row.levelId ?? 'site') === filters.level) && (filters.unit === 'all' || row.unit === filters.unit) && (filters.status === 'all' || filters.status === 'pending' && (row.pending || changes.has(row.id)) || filters.status === 'changed' && changes.has(row.id)) && (!filters.query || `${row.objectName} ${row.name} ${row.spec} ${row.levelName ?? ''} ${labels[row.section]}`.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())));
    const changeKey = (rowId, field) => JSON.stringify([rowId, field]);
    const rowChanges = (row) => {
        const original = baseRows.find(item => item.id === row.id), change = changes.get(row.id);
        if (!original || !change)
            return '';
        return priceFields.filter(field => change.values[field] !== undefined).map(field => `${fieldNames[field]} ${original.values[field] === '' ? '待填' : original.values[field]} → ${row.values[field] === '' ? '待填' : row.values[field]}${field === 'wasteRate' ? '%' : ' 元/' + row.unit}`).join(' · ');
    };
    const renderRows = (force = false) => {
        const rows = visibleRows(), nextKey = JSON.stringify(rows.map(row => row.id));
        if (!force && nextKey === rowKey)
            return;
        rowKey = nextKey;
        query('[data-pricing-rows]').innerHTML = rows.length ? rows.map(row => `<article class="pricing-row ${row.pending ? 'is-pending' : ''} ${changes.has(row.id) ? 'is-changed' : ''} ${selected.has(row.id) ? 'is-selected' : ''}" data-price-row="${escape(row.id)}">
      <label class="pricing-row-select"><input type="checkbox" data-price-select="${escape(row.id)}" ${selected.has(row.id) ? 'checked' : ''} ${!row.editableFields.length ? 'disabled' : ''} aria-label="选择${escape(row.objectName)}的${escape(row.name)}"></label><div class="pricing-row-description"><strong>${escape(row.name)}</strong><small>${escape(row.levelName ? row.levelName + ' / ' : '')}${escape(row.objectName)}<span>${labels[row.section]}</span></small>${row.spec ? `<p>${escape(row.spec)}</p>` : ''}<p class="pricing-row-note" data-price-note>${escape(rowNote(row))}</p><p class="pricing-row-changes" data-price-changes ${changes.has(row.id) ? '' : 'hidden'}>${escape(rowChanges(row))}</p></div>
      <span class="pricing-net" data-price-net>${quantityText(row.netQuantity, row.unit)}</span>${priceFields.map(field => { const invalidField = invalid.get(changeKey(row.id, field)); return `<label class="pricing-price-field"><span>${fieldNames[field]}</span><input type="number" min="0" step="any" data-price-field="${field}" data-price-id="${escape(row.id)}" value="${escape(invalidField?.value ?? row.values[field])}" ${row.editableFields.includes(field) ? '' : 'disabled'} class="${invalidField ? 'validation-error' : ''}" placeholder="${field === 'unitPrice' ? emptyPriceLabel(row.pending) : '0'}" aria-label="${escape(row.objectName + ' ' + row.name + ' ' + fieldNames[field])}" title="${escape(row.editableFields.includes(field) ? field === 'wasteRate' ? '百分比' : '元/' + row.unit : '此计价项不适用，沿用原计价方式')}"></label>`; }).join('')}<div class="pricing-row-amount"><strong data-price-total>${asMoney(row.knownTotal)}</strong><small data-price-status>${row.pending ? '已定价部分' : '税前'}</small></div><button type="button" class="icon-button" data-price-locate="${escape(row.id)}" aria-label="定位${escape(row.objectName)}" title="定位到原对象">${icon('chevronRight', 14)}</button></article>`).join('') : `<div class="pricing-empty">${icon(draftRows.length ? 'search' : 'edit', 24)}<strong>${draftRows.length ? '没有匹配的报价项目' : '先添加工程内容与计价项'}</strong><p>${draftRows.length ? '调整搜索、专业、楼层或单位筛选。' : '在对象中选择材料或启用报价后，即可在这里集中填写。'}</p></div>`;
    };
    const refreshRows = () => {
        dialog.querySelectorAll('[data-price-row]').forEach(element => {
            const row = draftRows.find(row => row.id === element.dataset.priceRow);
            if (!row)
                return;
            element.classList.toggle('is-changed', changes.has(row.id));
            element.classList.toggle('is-pending', row.pending);
            element.classList.toggle('is-selected', selected.has(row.id));
            for (const field of priceFields) {
                const input = element.querySelector(`[data-price-field="${field}"]`), bad = invalid.get(changeKey(row.id, field));
                input.classList.toggle('validation-error', !!bad);
                if (field === 'unitPrice')
                    input.placeholder = emptyPriceLabel(row.pending);
                if (document.activeElement !== input)
                    input.value = bad?.value ?? row.values[field];
            }
            element.querySelector('[data-price-net]').innerHTML = quantityText(row.netQuantity, row.unit);
            element.querySelector('[data-price-total]').textContent = asMoney(row.knownTotal);
            element.querySelector('[data-price-status]').textContent = row.pending ? '已定价部分' : '税前';
            element.querySelector('[data-price-note]').textContent = rowNote(row);
            const changeNote = element.querySelector('[data-price-changes]');
            changeNote.textContent = rowChanges(row);
            changeNote.hidden = !changes.has(row.id);
        });
    };
    const refreshSelection = () => {
        const rows = draftRows.filter(row => selected.has(row.id)), units = new Set(rows.map(row => row.unit));
        setText('[data-pricing-selected]', rows.length ? `已选 ${rows.length} 项` : '选择项目');
        for (const [field, selector] of [['unitPrice', '#pricing-bulk-unit-price'], ['laborRate', '#pricing-bulk-labor-rate'], ['wasteRate', '#pricing-bulk-waste-rate']]) {
            query(selector).disabled = !rows.length || !rows.every(row => row.editableFields.includes(field)) || field !== 'wasteRate' && units.size > 1;
        }
        query('[data-pricing-bulk-apply]').disabled = !rows.length || stale;
        setText('[data-pricing-bulk-note]', units.size > 1 ? '所选项目单位不同，请按单位筛选后统一填价；共同支持的损耗率仍可填写。' : rows.length ? '只填写需要更改的字段。空白保持原值，不支持的字段已停用。' : '先勾选需要一起填写的项目；空白字段保持原值。');
        const visible = visibleRows().filter(row => row.editableFields.length);
        const all = query('[data-pricing-select-all]');
        all.disabled = !visible.length;
        all.checked = !!visible.length && visible.every(row => selected.has(row.id));
        all.indeterminate = visible.some(row => selected.has(row.id)) && !all.checked;
    };
    const refreshPreview = () => {
        query('.pricing-preview').classList.toggle('has-draft', dirty());
        setText('[data-pricing-before]', budgetAmount(preview.before));
        setText('[data-pricing-after]', budgetAmount(preview.after));
        setText('[data-pricing-before-label]', `当前 · ${budgetLabel(preview.before)}`);
        setText('[data-pricing-after-label]', dirty() ? `应用后 · ${budgetLabel(preview.after)}` : `当前 · ${budgetLabel(preview.after)}`);
        setText('[data-pricing-draft-state]', stale ? '工程已变化' : dirty() ? `${preview.changedRows} 项报价草稿` : '当前工程');
        setText('[data-pricing-row-count]', String(draftRows.length));
        query('[data-pricing-apply]').disabled = !changes.size || invalid.size > 0 || stale;
        query('[data-pricing-discard]').disabled = !dirty() && !stale;
        query('[data-pricing-save]').disabled = dirty() || !callbacks.onSave;
        query('[data-pricing-undo]').disabled = dirty() || !callbacks.onUndo || !callbacks.canUndo?.();
        query('[data-pricing-redo]').disabled = dirty() || !callbacks.onUndo || !callbacks.canRedo?.();
        query('[data-pricing-apply]').textContent = changes.size ? `应用 ${preview.changedRows} 项报价` : '应用报价';
        query('[data-quantities-draft]').toggleAttribute('hidden', !dirty());
        if (dirty() && !invalid.size && !stale)
            setText('[data-pricing-feedback]', `${preview.changedRows} 项价格将被更新。原几何和数量规则保留，运输分配按新单价重算。应用后可一次撤销。`);
        if (stale)
            error('当前工程已有其他修改，请放弃草稿后重新填写，避免覆盖更新。');
    };
    const renderQuantities = () => {
        const result = calculateProjectQuantities(callbacks.getProject());
        setText('[data-pricing-group-count]', String(result.groups.length));
        setText('[data-quantities-state]', result.pending ? '含待确认事项' : result.itemCount ? '已按规格汇总' : '尚无计价内容');
        query('[data-quantities-summary]').innerHTML = `<div><span>规格分组</span><strong>${result.groups.length}</strong></div><div><span>材料与计价主项费</span><strong>${asMoney(result.totals.materialCost)}</strong></div><div><span>人工费</span><strong>${asMoney(result.totals.laborCost)}</strong></div><div><span>${result.pending ? '已确认含税小计' : '含税总预算'}</span><strong>${result.itemCount ? asMoney(result.totals.knownTotal) : '—'}</strong></div>`;
        query('[data-quantity-groups]').innerHTML = result.groups.length ? result.groups.map(group => renderQuantityGroup(group)).join('') : `<div class="pricing-empty">${icon('layers', 24)}<strong>暂无工程用量</strong><p>添加实际计价项，或在工程总览勾选需要汇入的专业。</p></div>`;
        query('[data-quantities-notes]').innerHTML = result.notes.length ? `<h4>计量范围</h4>${result.notes.map(note => `<p>${escape(note)}</p>`).join('')}` : '';
        dialog.querySelectorAll('[data-quantity-export]').forEach(button => button.disabled = !result.itemCount || dirty());
    };
    const refreshTabs = () => {
        dialog.querySelectorAll('[data-pricing-pane]').forEach(pane => pane.hidden = pane.dataset.pricingPane !== tab);
        dialog.querySelectorAll('[data-pricing-tab]').forEach(button => { const active = button.dataset.pricingTab === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
        query('[data-pricing-apply]').toggleAttribute('hidden', tab !== 'pricing');
        dialog.querySelectorAll('[data-quantity-export]').forEach(button => button.hidden = tab !== 'quantities');
    };
    const resetDraft = () => {
        baseProject = structuredClone(callbacks.getProject());
        baseline = sourceSignature(baseProject);
        baseRows = collectProjectPriceRows(baseProject);
        draftRows = baseRows;
        changes.clear();
        invalid.clear();
        preview = previewProjectPriceChanges(baseProject, []);
        stale = false;
        selected = new Set([...selected].filter(id => baseRows.some(row => row.id === id)));
        rowKey = '';
        const levels = [...new Map(baseRows.filter(row => row.levelId).map(row => [row.levelId, row.levelName || row.levelId])).entries()];
        query('#pricing-level').innerHTML = `<option value="all">全部楼层</option>${levels.map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}${baseRows.some(row => !row.levelId) ? '<option value="site">场地</option>' : ''}`;
        query('#pricing-unit').innerHTML = `<option value="all">全部单位</option>${[...new Set(baseRows.map(row => row.unit))].map(unit => `<option value="${escape(unit)}">${escape(unit)}</option>`).join('')}`;
        for (const key of ['level', 'unit', 'status']) {
            const select = query('#pricing-' + key);
            if (![...select.options].some(option => option.value === filters[key]))
                filters[key] = 'all';
            select.value = filters[key];
        }
        error();
        renderRows(true);
        refreshPreview();
        refreshSelection();
        renderQuantities();
        refreshTabs();
    };
    const updateDraft = (updates) => {
        const candidate = new Map(changes);
        for (const { rowId, field, value } of updates) {
            const row = baseRows.find(row => row.id === rowId);
            if (!row)
                throw new Error('计价项目已不存在，请重新打开报价。');
            const old = candidate.get(rowId);
            candidate.set(rowId, { rowId, values: { ...(old?.values ?? {}), [field]: value }, expected: { ...(old?.expected ?? {}), [field]: row.values[field] } });
        }
        const nextPreview = previewProjectPriceChanges(baseProject, [...candidate.values()]);
        const nextRows = collectProjectPriceRows(nextPreview.project), canonical = new Map();
        for (const entry of candidate.values()) {
            const row = nextRows.find(row => row.id === entry.rowId), original = baseRows.find(row => row.id === entry.rowId);
            const values = {}, expected = {};
            for (const field of Object.keys(entry.values))
                if (row.values[field] !== original.values[field]) {
                    values[field] = row.values[field];
                    expected[field] = original.values[field];
                }
            if (Object.keys(values).length)
                canonical.set(entry.rowId, { rowId: entry.rowId, values, expected });
        }
        changes = canonical;
        preview = nextPreview;
        draftRows = nextRows;
        for (const { rowId, field } of updates)
            invalid.delete(changeKey(rowId, field));
        error();
        refreshRows();
        refreshPreview();
        refreshSelection();
    };
    const discardPermission = () => !dirty() || confirm('报价草稿尚未应用。放弃草稿并离开？');
    const leave = (action) => { if (!discardPermission())
        return; dialog.close(); action(); };
    const refresh = () => {
        if (applying)
            return;
        if (dirty()) {
            if (sourceSignature(callbacks.getProject()) !== baseline)
                stale = true;
            refreshPreview();
        }
        else
            resetDraft();
    };
    activePricing = { dialog, refresh };
    dialog.addEventListener('close', () => { if (activePricing?.dialog === dialog)
        activePricing = null; }, { once: true });
    dialog.addEventListener('cancel', event => { if (!discardPermission())
        event.preventDefault(); });
    dialog.addEventListener('click', event => {
        const button = event.target.closest('[data-dialog-close]');
        if (button && !discardPermission()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, { capture: true });
    dialog.addEventListener('change', event => {
        const input = event.target;
        if (input.dataset.priceSelect) {
            input.checked ? selected.add(input.dataset.priceSelect) : selected.delete(input.dataset.priceSelect);
            refreshRows();
            refreshSelection();
            return;
        }
        if (input.hasAttribute('data-pricing-select-all')) {
            visibleRows().filter(row => row.editableFields.length).forEach(row => input.checked ? selected.add(row.id) : selected.delete(row.id));
            renderRows(true);
            refreshSelection();
            return;
        }
        if (input.dataset.priceField) {
            const rowId = input.dataset.priceId, field = input.dataset.priceField;
            try {
                if (stale)
                    throw new Error('工程已变化，请先放弃草稿并重新填写。');
                if (input.validity.badInput)
                    throw new Error('请填写有效的数字。');
                updateDraft([{ rowId, field, value: input.value }]);
                input.value = draftRows.find(row => row.id === rowId).values[field];
            }
            catch (failure) {
                invalid.set(changeKey(rowId, field), { value: input.value, message: failure instanceof Error ? failure.message : String(failure) });
                input.classList.add('validation-error');
                error();
                refreshPreview();
            }
        }
    });
    for (const key of ['section', 'level', 'status', 'unit'])
        query('#pricing-' + key).addEventListener('change', event => { filters[key] = event.target.value; renderRows(true); refreshSelection(); });
    query('#pricing-search').addEventListener('input', event => { filters.query = event.target.value.trim(); renderRows(true); refreshSelection(); });
    dialog.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || !dialog.contains(button))
            return;
        if (button.dataset.pricingTab) {
            tab = button.dataset.pricingTab;
            renderQuantities();
            refreshTabs();
            return;
        }
        if (button.hasAttribute('data-pricing-clear-selection')) {
            selected.clear();
            renderRows(true);
            refreshSelection();
            return;
        }
        if (button.hasAttribute('data-pricing-bulk-apply')) {
            try {
                const updates = [];
                for (const [field, selector] of [['unitPrice', '#pricing-bulk-unit-price'], ['laborRate', '#pricing-bulk-labor-rate'], ['wasteRate', '#pricing-bulk-waste-rate']]) {
                    const input = query(selector);
                    if (input.disabled)
                        continue;
                    if (input.validity.badInput) {
                        input.focus();
                        throw new Error(`统一${fieldNames[field]}必须是有效的数字。`);
                    }
                    if (input.value.trim() !== '')
                        for (const rowId of selected)
                            updates.push({ rowId, field, value: input.value });
                }
                if (!updates.length)
                    throw new Error('填写至少一个需要修改的价格或损耗字段。');
                updateDraft(updates);
                renderRows(true);
                setText('[data-pricing-feedback]', `${selected.size} 项已填入报价草稿，请核对预览后应用。`);
            }
            catch (failure) {
                error(failure instanceof Error ? failure.message : String(failure));
            }
            return;
        }
        if (button.hasAttribute('data-pricing-discard')) {
            if (discardPermission()) {
                resetDraft();
                setText('[data-pricing-feedback]', '报价草稿已放弃，原工程保持不变。');
            }
            return;
        }
        if (button.hasAttribute('data-pricing-back')) {
            leave(callbacks.onBack);
            return;
        }
        if (button.dataset.priceLocate) {
            const row = draftRows.find(row => row.id === button.dataset.priceLocate);
            if (row)
                leave(() => callbacks.onLocate(issueFor(row)));
            return;
        }
        if (button.dataset.quantityLocate) {
            const result = calculateProjectQuantities(callbacks.getProject()), group = result.groups.find(group => group.id === button.dataset.quantityGroupId), source = group?.sources[Number(button.dataset.quantityLocate)];
            if (group && source)
                leave(() => callbacks.onLocate(issueFor({ ...source, section: group.section })));
            return;
        }
        if (button.hasAttribute('data-pricing-apply')) {
            if (stale || !changes.size || invalid.size) {
                error(stale ? '工程已变化，请重新填写草稿。' : '请先修正填写错误。');
                return;
            }
            try {
                if (sourceSignature(callbacks.getProject()) !== baseline)
                    throw new Error('工程已有其他修改，请放弃草稿后重新填写。');
                const count = preview.changedRows;
                applying = true;
                callbacks.onApply(preview.project);
                applying = false;
                resetDraft();
                setText('[data-pricing-feedback]', `已应用 ${count} 项报价，可一次撤销。`);
                toast('报价已应用，工程总预算已更新');
            }
            catch (failure) {
                applying = false;
                error(failure instanceof Error ? failure.message : String(failure));
            }
            return;
        }
        if (button.hasAttribute('data-pricing-undo') || button.hasAttribute('data-pricing-redo')) {
            if (!dirty()) {
                callbacks.onUndo?.(button.hasAttribute('data-pricing-redo'));
                refresh();
            }
            return;
        }
        if (button.hasAttribute('data-pricing-save')) {
            if (dirty()) {
                error('先应用报价草稿，再保存当前工程。');
                return;
            }
            button.disabled = true;
            setText('[data-pricing-feedback]', '正在保存…');
            Promise.resolve().then(() => callbacks.onSave?.()).then(result => setText('[data-pricing-feedback]', result === false ? '保存未完成，请检查顶部保存提示。' : '工程已保存。')).catch(failure => error(failure instanceof Error ? failure.message : String(failure))).finally(() => refreshPreview());
            return;
        }
        if (button.dataset.quantityExport) {
            if (dirty()) {
                error('请先应用报价草稿，再导出当前工程用量。');
                return;
            }
            try {
                const latest = callbacks.getProject();
                if (button.dataset.quantityExport === 'csv') {
                    downloadProjectQuantitiesCSV(latest);
                    toast('工程用量清单已导出');
                }
                else
                    printProjectQuantitiesReport(latest);
            }
            catch (failure) {
                error(failure instanceof Error ? failure.message : String(failure));
            }
        }
    });
    resetDraft();
    return dialog;
}
function renderQuantityGroup(group) {
    const price = group.unitPrice === '' ? emptyPriceLabel(group.pending) : `${group.unitPrice} 元/${group.unit}`;
    const sources = group.sources.map((source, index) => `
    <button type="button" class="quantity-source" data-quantity-locate="${index}" data-quantity-group-id="${escape(group.id)}">
      <span><strong>${escape(source.levelName ? source.levelName + ' / ' : '')}${escape(source.objectName)}</strong>
      <small>净量 ${escape(source.netQuantity ?? '待确认')} · 计价量 ${escape(source.purchaseQuantity ?? '待确认')} ${escape(group.unit)}</small></span>${icon('chevronRight', 13)}
    </button>`).join('');
    return `<details class="quantity-group ${group.pending ? 'is-pending' : ''}" data-quantity-group="${escape(group.id)}">
    <summary>
      <div class="quantity-group-heading"><span class="quantity-category">${escape(group.categoryLabel)}</span><strong>${escape(group.materialName)}</strong><small>${escape(group.label)} · ${group.sourceCount} 项来源</small><p>${escape(group.spec)}</p></div>
      <div class="quantity-group-measure"><span>净计量</span><strong>${quantityText(group.netQuantity, group.unit)}</strong>${group.netQuantity === null ? `<small>已确认 ${escape(group.knownNetQuantity)} ${escape(group.unit)}</small>` : ''}</div>
      <div class="quantity-group-measure"><span>${group.category === 'material' || group.category === 'equipment' ? '含损耗用量' : '计价用量'}</span><strong>${quantityText(group.purchaseQuantity, group.unit)}</strong>${group.purchaseQuantity === null ? `<small>已确认 ${escape(group.knownPurchaseQuantity)} ${escape(group.unit)}</small>` : ''}</div>
      <div class="quantity-group-cost"><strong>${asMoney(group.knownTotal)}</strong><small>${group.pending ? '已确认部分 · 税前' : '税前'}</small></div>${icon('down', 14)}
    </summary>
    <div class="quantity-group-details">
      <div class="quantity-rates"><span>单价 ${escape(price)}</span><span>人工 ${escape(group.laborRate)} 元/${escape(group.unit)}</span><span>损耗 ${escape(group.wasteRate)}%</span></div>
      ${group.pendingReasons.length ? `<p class="quantity-pending-reason">${escape(group.pendingReasons.join('；'))}</p>` : ''}${sources}
    </div>
  </details>`;
}
//# sourceMappingURL=project-pricing.js.map