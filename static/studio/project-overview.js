import { calculateProjectBudget, validateProjectBudgetOptions } from './lib/project-budget.js';
import { downloadProjectBudgetCSV, printProjectBudgetReport } from './lib/project-budget-export.js';
import { calculateProjectReadiness } from './lib/project-readiness.js';
import { addDecimal, normalizeDecimal } from './lib/pricing.js';
import { escape, icon, money, openDialog, toast } from './ui.js';
const sectionMode = { decoration: 'decoration', civil: 'civil', municipal: 'municipal' };
const sectionIcon = { decoration: 'wall', civil: 'cube', municipal: 'route' };
const sectionDescription = {
    decoration: '地面、墙面、吊顶、门窗、家具与水电',
    civil: '柱梁板、基础、砌体与土方',
    municipal: '道路、河桥、场地与管网',
};
const budgetAmount = (value) => value == null ? '—' : `¥ ${money(value)}`;
const issueCounts = (issues) => ({ pending: issues.filter(issue => issue.severity === 'pending').length, info: issues.filter(issue => issue.severity === 'info').length });
const statusLabel = (budget, readiness) => budget.status === 'empty' ? '等待开始' : budget.pending ? '待完善' : readiness && !readiness.ready ? '设计待检查' : '可导出预算';
const sectionSubtotal = (budget) => budget.sections.filter(section => section.included).reduce((sum, section) => addDecimal(sum, section.knownSubtotal), '0');
const totalLabel = (budget, readiness) => budget.status === 'empty' ? '添加工程内容后计算' : budget.pending ? '已定价部分含税小计' : !readiness.ready ? '已确认参数的含税小计' : '预计含税总预算';
const totalNote = (budget, readiness) => budget.status === 'empty' ? '先选择专业并开始布置。' : budget.pending ? '仍有待填写事项，完整总预算暂不可确定。' : !readiness.ready ? '费用参数可计算，仍需完成下方设计检查。' : '按当前已勾选专业汇总。';
function nextActionLabel(action) {
    return { calibrate: '校准图纸比例', plan: '开始绘制户型', decoration: '继续室内装修', civil: '开始土建设计', municipal: '开始市政场地', review: '查看待处理项目', export: '查看导出选项' }[action] ?? '查看工程检查';
}
function visibleIssues(issues, view) {
    const query = String(view.query ?? '').trim().toLocaleLowerCase();
    const filter = view.filter ?? 'pending';
    return issues.filter(issue => (filter === 'all' || issue.severity === filter) && (!query || `${issue.title} ${issue.message} ${issue.section}`.toLocaleLowerCase().includes(query)));
}
function renderIssueList(issues, view, budget) {
    const shown = visibleIssues(issues, view), counts = issueCounts(issues);
    if (!shown.length) {
        const searching = !!view.query?.trim();
        const title = searching ? '没有匹配的检查项目' : budget.status === 'empty' ? '先添加第一项工程内容' : (view.filter ?? 'pending') === 'info' ? '当前没有额外计量说明' : counts.pending ? '当前筛选下没有检查项目' : '当前汇入范围的报价参数已完整';
        const description = searching ? '换个关键词，或切换检查类别。' : budget.status === 'empty' ? '选择一个专业开始，工程量和待填写事项会出现在这里。' : '导出前仍请核对实际施工范围、做法和用户填写的价格。';
        return `<div class="overview-check-empty">${icon(searching ? 'search' : budget.status === 'empty' ? 'plus' : 'check', 20)}<strong>${escape(title)}</strong><p>${escape(description)}</p></div>`;
    }
    return shown.map(issue => `<button type="button" class="overview-issue ${issue.severity === 'info' ? 'is-info' : ''}" data-overview-issue="${escape(issue.id)}"><span class="overview-issue-mark">${icon(issue.severity === 'pending' ? 'edit' : 'info', 14)}</span><span><strong>${escape(issue.title)}</strong><small>${escape(issue.message)}</small></span><span class="overview-issue-locate">${issue.targetId ? '定位' : '查看'}${icon('chevronRight', 12)}</span></button>`).join('');
}
function renderSections(budget) {
    return budget.sections.map(section => {
        const count = issueCounts(section.issues).pending;
        const state = !section.included ? '未汇入总预算' : !section.available ? '尚未布置' : count ? `${count} 项待处理` : '报价参数完整';
        return `<article class="overview-section ${section.included ? 'is-included' : ''}" data-overview-section="${section.id}"><label class="overview-include"><input type="checkbox" data-overview-include="${section.id}" ${section.included ? 'checked' : ''} aria-label="将${escape(section.label)}汇入工程总预算"><span class="overview-section-icon">${icon(sectionIcon[section.id], 18)}</span><strong>${escape(section.label)}</strong></label><button type="button" class="overview-section-open" data-overview-start="${sectionMode[section.id]}" aria-label="打开${escape(section.label)}工作区"><span class="overview-section-description">${sectionDescription[section.id]}</span><span class="overview-section-bottom"><span><small data-overview-section-count>${section.itemCount} 项工程内容</small><span class="overview-section-state ${count && section.included ? 'is-pending' : ''}" data-overview-section-state>${escape(state)}</span></span><strong data-overview-section-amount>${section.available ? budgetAmount(section.knownSubtotal) : '—'}</strong>${icon('chevronRight', 13)}</span></button></article>`;
    }).join('');
}
function renderBudgetSummary(project, budget, readiness) {
    const empty = budget.status === 'empty';
    return `<section class="overview-budget"><div class="overview-section-heading"><span class="eyebrow">工程总预算</span><span class="overview-status ${!readiness.ready ? 'is-pending' : ''}" data-overview-status>${escape(statusLabel(budget, readiness))}</span></div><span class="overview-total-label" data-overview-total-label>${totalLabel(budget, readiness)}</span><strong class="overview-total" data-overview-total>${empty ? '—' : budgetAmount(budget.knownTotal)}</strong><p class="overview-total-note" data-overview-total-note>${totalNote(budget, readiness)}</p><div class="overview-breakdown"><p><span>汇入专业 · 税前小计</span><strong data-overview-base>${empty ? '—' : budgetAmount(sectionSubtotal(budget))}</strong></p><label class="overview-rate-field"><span>项目固定费<small>整个工程只收取一次</small></span><span class="overview-affix"><input id="overview-additional-cost" data-overview-project-field="additionalCost" type="number" min="0" step="any" value="${escape(project.additionalCost ?? '0')}" aria-label="工程统一固定费"><span>元</span></span></label><label class="overview-rate-field"><span>统一税率</span><span class="overview-affix"><input id="overview-tax-rate" data-overview-project-field="taxRate" type="number" min="0" max="100" step="any" value="${escape(project.taxRate ?? '0')}" aria-label="工程统一税率"><span>%</span></span></label><p><span data-overview-tax-label>${budget.pending ? '已确认部分税金' : '税金'}</span><strong data-overview-tax>${empty ? '—' : budgetAmount(budget.knownTax)}</strong></p></div><p class="overview-scope-note">各专业按真实几何和填写的单价汇总，固定费与税金仅在这里计算一次。原「造价总表」方案清单独立保留，不重复加入。</p><p class="overview-field-error" id="overview-budget-error" role="status" aria-live="polite"></p></section>`;
}
function renderMetadata(project) {
    const metadata = project.budget;
    return `<details class="overview-metadata" ${metadata?.client || metadata?.reference || metadata?.note ? 'open' : ''}><summary><span>报价信息<span>可选</span></span>${icon('down', 14)}</summary><div><label class="overview-meta-field"><span>甲方 / 客户</span><input id="overview-client" data-overview-meta="client" maxlength="120" value="${escape(metadata?.client ?? '')}" placeholder="填写客户名称"></label><label class="overview-meta-field"><span>报价编号</span><input id="overview-reference" data-overview-meta="reference" maxlength="120" value="${escape(metadata?.reference ?? '')}" placeholder="例如 Q-2026-001"></label><label class="overview-meta-field"><span>范围与备注</span><textarea id="overview-note" data-overview-meta="note" maxlength="2000" rows="3" placeholder="填写施工范围、报价条件或未包含项目">${escape(metadata?.note ?? '')}</textarea></label><p>这些信息随工程保存，并写入总预算报价单。</p></div></details>`;
}
/** Pure HTML renderer; monetary and readiness state come from the tested engines. */
export function renderProjectOverview(project, view = {}) {
    const budget = calculateProjectBudget(project), readiness = calculateProjectReadiness(project, budget), counts = issueCounts(readiness.issues);
    return `<div class="project-overview-content"><section class="overview-next"><div><span class="eyebrow">下一步</span><h3 data-overview-next-title>${escape(readiness.nextStep.label)}</h3><p data-overview-next-description>${escape(readiness.nextStep.description)}</p></div><button class="button primary" type="button" data-overview-next-action="${readiness.nextStep.action}"><span>${nextActionLabel(readiness.nextStep.action)}</span>${icon('arrow', 15)}</button></section><nav class="overview-steps" aria-label="完成工程的步骤">${readiness.steps.map((step, index) => `<button type="button" data-overview-step="${step.id}" class="${step.complete ? 'is-complete' : ''} ${readiness.nextStep.id === step.id ? 'is-current' : ''}" aria-current="${readiness.nextStep.id === step.id ? 'step' : 'false'}"><span>${step.complete ? icon('check', 12) : String(index + 1).padStart(2, '0')}</span><strong>${escape(step.label)}</strong></button>`).join('')}</nav><div class="overview-layout"><main><section class="overview-professions"><div class="overview-section-heading"><h3>选择本次预算范围</h3><span data-overview-range>${budget.sections.filter(section => section.included).length} 个专业已汇入</span></div><p class="overview-intro">勾选需要汇总的专业，点击专业进入设计与报价。</p><div class="overview-section-list">${renderSections(budget)}</div><p class="overview-exclusion" data-overview-exclusion>${budget.sections.some(section => !section.included && section.available) ? '未勾选专业的工程内容仍保留，费用未加入本次总预算。' : '新添加的专业自动汇入；手动选择的范围随项目保存。'}</p></section><section class="overview-check" id="overview-check"><div class="overview-section-heading"><h3>工程检查</h3><span data-overview-issue-count>${counts.pending} 项待处理</span></div><div class="overview-check-controls"><div class="overview-check-filters" role="group" aria-label="检查类别">${[['pending', '待处理', counts.pending], ['info', '计量说明', counts.info], ['all', '全部', readiness.issues.length]].map(([value, label, count]) => `<button type="button" data-overview-filter="${value}" aria-pressed="${(view.filter ?? 'pending') === value}" class="${(view.filter ?? 'pending') === value ? 'active' : ''}">${label}<span data-overview-filter-count="${value}">${count}</span></button>`).join('')}</div><label class="overview-check-search">${icon('search', 14)}<input id="overview-search" type="search" placeholder="查找项目" value="${escape(view.query ?? '')}" aria-label="搜索工程检查项目"></label></div><div class="overview-issue-list" data-overview-issues>${renderIssueList(readiness.issues, view, budget)}</div><p class="overview-check-note">检查依据当前实际设计与报价参数。计量说明可帮助复核估算范围。</p></section></main><aside>${renderBudgetSummary(project, budget, readiness)}${renderMetadata(project)}</aside></div></div>`;
}
let activeOverview = null;
/** Called by the host's render cycle so undo/redo also update an open overview. */
export function refreshProjectOverview() {
    if (activeOverview?.dialog.open && document.querySelector('#dialog') === activeOverview.dialog)
        activeOverview.refresh();
}
export function openProjectOverview(project, callbacks) {
    const view = { filter: 'pending', query: '' };
    const dialog = openDialog('工程总览', renderProjectOverview(project, view), {
        wide: true,
        subtitle: '确定范围，完成设计，检查报价，然后交付工程',
        footer: `<span class="overview-action-status" role="status" aria-live="polite"></span><span class="overview-history" aria-label="撤销与重做"><button type="button" class="icon-button" data-overview-undo aria-label="撤销工程修改" title="撤销工程修改" disabled>${icon('undo', 15)}</button><button type="button" class="icon-button" data-overview-redo aria-label="重做工程修改" title="重做工程修改" disabled>${icon('redo', 15)}</button></span>${callbacks.onOpenPricing ? '<button type="button" class="button subtle" data-overview-pricing>批量报价</button><button type="button" class="button subtle" data-overview-quantities>用量清单</button>' : ''}<button type="button" class="button subtle" data-overview-save>${icon('save', 14)}保存项目</button><span class="overview-export-buttons"><button type="button" class="button" data-overview-export="json">项目文件</button><button type="button" class="button" data-overview-export="csv">CSV</button><button type="button" class="button primary" data-overview-export="pdf">${icon('export', 14)}打印 / PDF</button></span>`,
    });
    dialog.classList.add('project-overview-dialog');
    dialog.querySelector('.dialog-footer').id = 'overview-export-options';
    let budget = calculateProjectBudget(project), readiness = calculateProjectReadiness(project, budget), issueKey = '';
    const invalidMessages = new Map();
    const setText = (selector, value) => { const element = dialog.querySelector(selector); if (element && element.textContent !== value)
        element.textContent = value; };
    const errorMessage = (message = '') => { setText('#overview-budget-error', message); };
    const refreshIssues = () => {
        const counts = issueCounts(readiness.issues), nextKey = JSON.stringify([view, readiness.issues, budget.status]);
        setText('[data-overview-issue-count]', `${counts.pending} 项待处理`);
        for (const [filter, count] of [['pending', counts.pending], ['info', counts.info], ['all', readiness.issues.length]]) {
            setText(`[data-overview-filter-count="${filter}"]`, String(count));
            const button = dialog.querySelector(`[data-overview-filter="${filter}"]`);
            button?.classList.toggle('active', view.filter === filter);
            button?.setAttribute('aria-pressed', String(view.filter === filter));
        }
        if (issueKey !== nextKey) {
            dialog.querySelector('[data-overview-issues]').innerHTML = renderIssueList(readiness.issues, view, budget);
            issueKey = nextKey;
        }
    };
    const refresh = () => {
        try {
            const latest = callbacks.getProject();
            budget = calculateProjectBudget(latest);
            readiness = calculateProjectReadiness(latest, budget);
            setText('[data-overview-next-title]', readiness.nextStep.label);
            setText('[data-overview-next-description]', readiness.nextStep.description);
            const nextButton = dialog.querySelector('[data-overview-next-action]');
            nextButton.dataset.overviewNextAction = readiness.nextStep.action;
            setText('[data-overview-next-action]>span', nextActionLabel(readiness.nextStep.action));
            readiness.steps.forEach((step, index) => {
                const button = dialog.querySelector(`[data-overview-step="${step.id}"]`), isCurrent = readiness.nextStep.id === step.id;
                button?.classList.toggle('is-complete', step.complete);
                button?.classList.toggle('is-current', isCurrent);
                button?.setAttribute('aria-current', isCurrent ? 'step' : 'false');
                if (button)
                    button.querySelector('span').innerHTML = step.complete ? icon('check', 12) : String(index + 1).padStart(2, '0');
            });
            budget.sections.forEach(section => {
                const row = dialog.querySelector(`[data-overview-section="${section.id}"]`), counts = issueCounts(section.issues), input = row.querySelector('input');
                row.classList.toggle('is-included', section.included);
                input.checked = section.included;
                setText(`[data-overview-section="${section.id}"] [data-overview-section-count]`, `${section.itemCount} 项工程内容`);
                setText(`[data-overview-section="${section.id}"] [data-overview-section-state]`, !section.included ? '未汇入总预算' : !section.available ? '尚未布置' : counts.pending ? `${counts.pending} 项待处理` : '报价参数完整');
                row.querySelector('[data-overview-section-state]').classList.toggle('is-pending', section.included && counts.pending > 0);
                setText(`[data-overview-section="${section.id}"] [data-overview-section-amount]`, section.available ? budgetAmount(section.knownSubtotal) : '—');
            });
            const empty = budget.status === 'empty';
            setText('[data-overview-range]', `${budget.sections.filter(section => section.included).length} 个专业已汇入`);
            setText('[data-overview-exclusion]', budget.sections.some(section => !section.included && section.available) ? '未勾选专业的工程内容仍保留，费用未加入本次总预算。' : '新添加的专业自动汇入；手动选择的范围随项目保存。');
            setText('[data-overview-status]', statusLabel(budget, readiness));
            dialog.querySelector('[data-overview-status]').classList.toggle('is-pending', !readiness.ready);
            setText('[data-overview-total-label]', totalLabel(budget, readiness));
            setText('[data-overview-total]', empty ? '—' : budgetAmount(budget.knownTotal));
            setText('[data-overview-total-note]', totalNote(budget, readiness));
            setText('[data-overview-base]', empty ? '—' : budgetAmount(sectionSubtotal(budget)));
            setText('[data-overview-tax]', empty ? '—' : budgetAmount(budget.knownTax));
            setText('[data-overview-tax-label]', budget.pending ? '已确认部分税金' : '税金');
            for (const field of ['additionalCost', 'taxRate']) {
                const input = dialog.querySelector(`[data-overview-project-field="${field}"]`);
                if (document.activeElement !== input && !input.classList.contains('validation-error'))
                    input.value = String(latest[field] ?? '0');
            }
            for (const field of ['client', 'reference', 'note']) {
                const input = dialog.querySelector(`[data-overview-meta="${field}"]`);
                if (document.activeElement !== input && !input.classList.contains('validation-error'))
                    input.value = String(latest.budget?.[field] ?? '');
            }
            dialog.querySelectorAll('[data-overview-export="csv"], [data-overview-export="pdf"]').forEach(button => button.disabled = empty);
            dialog.querySelector('[data-overview-undo]').disabled = !callbacks.onUndo || !callbacks.canUndo?.();
            dialog.querySelector('[data-overview-redo]').disabled = !callbacks.onUndo || !callbacks.canRedo?.();
            refreshIssues();
        }
        catch (error) {
            errorMessage(error instanceof Error ? error.message : String(error));
        }
    };
    activeOverview = { dialog, refresh };
    dialog.addEventListener('close', () => { if (activeOverview?.dialog === dialog)
        activeOverview = null; }, { once: true });
    const review = () => {
        view.filter = 'pending';
        refreshIssues();
        dialog.querySelector('#overview-check').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const fieldsValid = () => {
        const invalid = dialog.querySelector('.validation-error');
        if (!invalid)
            return true;
        errorMessage([...invalidMessages.values()].join('；') || '请先修正填写错误，再保存或导出。');
        invalid.focus();
        return false;
    };
    const dispatchAction = (action) => {
        if (action === 'review') {
            review();
            return;
        }
        if (action === 'export') {
            dialog.querySelector('#overview-export-options').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            dialog.querySelector('[data-overview-export="csv"]').focus({ preventScroll: true });
            return;
        }
        dialog.close();
        if (action === 'calibrate') {
            if (callbacks.getProject().drawing && callbacks.onCalibrate)
                callbacks.onCalibrate();
            else
                callbacks.onStart('plan');
            return;
        }
        callbacks.onStart(['plan', 'decoration', 'civil', 'municipal'].includes(action) ? action : 'plan');
    };
    dialog.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || !dialog.contains(button))
            return;
        if (button.hasAttribute('data-overview-pricing') || button.hasAttribute('data-overview-quantities')) {
            if (!fieldsValid())
                return;
            dialog.close();
            callbacks.onOpenPricing?.(button.hasAttribute('data-overview-quantities') ? 'quantities' : 'pricing');
            return;
        }
        if (button.hasAttribute('data-overview-undo') || button.hasAttribute('data-overview-redo')) {
            callbacks.onUndo?.(button.hasAttribute('data-overview-redo'));
            refresh();
            return;
        }
        const start = button.dataset.overviewStart, filter = button.dataset.overviewFilter, issueId = button.dataset.overviewIssue, stepId = button.dataset.overviewStep, next = button.dataset.overviewNextAction, format = button.dataset.overviewExport;
        if (start) {
            dispatchAction(start);
            return;
        }
        if (next) {
            dispatchAction(next);
            return;
        }
        if (stepId) {
            const step = readiness.steps.find(item => item.id === stepId);
            if (step)
                dispatchAction(step.action);
            return;
        }
        if (filter) {
            view.filter = filter;
            refreshIssues();
            return;
        }
        if (issueId) {
            const issue = readiness.issues.find(item => item.id === issueId);
            if (issue) {
                dialog.close();
                callbacks.onLocate(issue);
            }
            return;
        }
        if (format) {
            if (!fieldsValid())
                return;
            try {
                const latest = callbacks.getProject(), current = calculateProjectBudget(latest);
                if (format === 'json')
                    callbacks.onExportProject();
                else if (format === 'csv') {
                    downloadProjectBudgetCSV(latest, current);
                    toast(current.pending ? '已导出总预算，待填写项已明确标注' : '工程总预算已导出');
                }
                else
                    printProjectBudgetReport(latest, current);
            }
            catch (error) {
                errorMessage(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (button.hasAttribute('data-overview-save')) {
            if (!fieldsValid())
                return;
            button.disabled = true;
            setText('.overview-action-status', '正在保存…');
            Promise.resolve().then(() => callbacks.onSave?.()).then(result => {
                if (result === false) {
                    setText('.overview-action-status', '保存未完成，请重试');
                    errorMessage('项目尚未保存，请检查当前绘图状态或顶部保存提示。');
                }
                else
                    setText('.overview-action-status', callbacks.onSave ? '项目已保存' : '修改已纳入项目，请使用顶部保存');
            }).catch(error => { setText('.overview-action-status', '保存失败，请重试'); errorMessage(error instanceof Error ? error.message : String(error)); }).finally(() => { button.disabled = false; });
        }
    });
    dialog.addEventListener('change', event => {
        const input = event.target;
        try {
            if (input.dataset.overviewInclude) {
                const section = input.dataset.overviewInclude, checked = input.checked;
                callbacks.onUpdate(next => { next.budget = { ...(next.budget ?? {}), included: { ...(next.budget?.included ?? {}), [section]: checked } }; });
            }
            else if (input.dataset.overviewProjectField) {
                const field = input.dataset.overviewProjectField;
                const value = normalizeDecimal(input.value, field === 'taxRate' ? '统一税率' : '工程统一固定费', { min: 0, max: field === 'taxRate' ? 100 : null });
                callbacks.onUpdate(next => { next[field] = value; });
                input.value = value;
            }
            else if (input.dataset.overviewMeta) {
                const field = input.dataset.overviewMeta, value = input.value;
                const options = { ...(callbacks.getProject().budget ?? {}), [field]: value };
                validateProjectBudgetOptions(options);
                callbacks.onUpdate(next => { next.budget = { ...(next.budget ?? {}), [field]: value }; });
            }
            else
                return;
            input.classList.remove('validation-error');
            invalidMessages.delete(input);
            errorMessage([...invalidMessages.values()].join('；'));
            setText('.overview-action-status', '修改已纳入项目');
            refresh();
        }
        catch (error) {
            input.classList.add('validation-error');
            invalidMessages.set(input, error instanceof Error ? error.message : String(error));
            errorMessage([...invalidMessages.values()].join('；'));
        }
    });
    dialog.querySelector('#overview-search').addEventListener('input', event => { view.query = event.target.value; refreshIssues(); });
    refresh();
    return dialog;
}
//# sourceMappingURL=project-overview.js.map