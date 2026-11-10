import type { Project, Material, Point } from './types.js';
import type { CostItem, CostSection, CostModuleState } from './lib/cost.js';
import { registerCostValidator } from './lib/cost.js';
import { summarize, createCostItem, COST_UNITS, COST_SECTIONS, validateItems } from './lib/cost.js';
import { formatMoney, normalizeDecimal } from './lib/pricing.js';
import { downloadCostCSV, printCostReport } from './lib/cost-export.js';
import { escape, icon, openDialog } from './ui.js';
export type CostContext = {
  getProject(): Project; getMaterials(): Material[];
  updateProject(mutator: (project: Project) => void, options?: { history?: boolean }): void;
  toast(message: string, error?: boolean): void;
  refresh(): void;
  requestRoute?(callback: (points: Point[]) => void): void;
};
export type CostModule = {
  id: 'structure' | 'finish' | 'municipal'; section: CostSection; title: string;
  calculate(project: Project): CostItem[];
  render(host: HTMLElement, ctx: CostContext): void;
  validate?(state: CostModuleState): void;
};
export const costModules = new Map<CostModule['id'], CostModule>();
const calculated = new Map<CostModule['id'], { key: string; items: CostItem[] }>();
export function registerCostModule(module: CostModule) {
  if (costModules.has(module.id)) throw new Error('造价专业重复注册：' + module.id);
  costModules.set(module.id, module);
  if (module.validate) registerCostValidator(module.id, module.validate);
}

type OpenOptions = {
  getProject?: () => Project; getMaterials?: () => Material[];
  onChange: (mutator: (project: Project) => void, options?: { history?: boolean }) => void;
  onClose?: () => void; toast: CostContext['toast']; requestRoute?: CostContext['requestRoute'];
};
let currentProject: Project, options: OpenOptions, activeTab: 'summary' | CostModule['id'] = 'summary';
let estimateOnly = false, highlightId: string | null = null;
function state() { return options?.getProject?.() ?? currentProject; }
export function getCostItems(project: Project): CostItem[] {
  // Each discipline depends on its own parameters. Geometry is shared only by
  // building disciplines; editing a road price does not rebuild room surfaces.
  const geometry = { drawing: project.drawing?.type, calibration: project.calibration,
    planError: project.planError, regions: project.regions.map(({ id, name, points, holes }) => ({ id, name, points, holes })),
    walls: project.walls, openings: project.openings, materialsSnapshot: project.materialsSnapshot };
  const items = [...costModules.values()].flatMap(module => {
    const key = JSON.stringify([project.cost?.modules?.[module.id], module.id === 'municipal' ? null : geometry,
      module.id === 'finish' ? project.regions.map(region => region.items) : null]);
    let cache = calculated.get(module.id);
    if (!cache || cache.key !== key) { cache = { key, items: module.calculate(project) }; calculated.set(module.id, cache); }
    return cache.items;
  });
  return [...items, ...(project.cost?.manualItems ?? []).map(createCostItem)];
}
export function getCostSummary(project: Project) { return summarize(getCostItems(project), { ...project.cost?.rates, otherAmount: project.cost?.otherCost ?? '0' }); }
export function isCostWorkbenchOpen() { return !!document.querySelector<HTMLElement>('#cost-view:not([hidden])'); }
export function openCostWorkbench(project: Project, input: OpenOptions) {
  currentProject = project; options = input; activeTab = 'summary'; estimateOnly = false;
  document.querySelector<HTMLElement>('#cost-view').hidden = false;
  document.body.classList.add('cost-open'); refreshCostWorkbench();
}
export function closeCostWorkbench() {
  document.querySelector<HTMLElement>('#cost-view').hidden = true;
  document.body.classList.remove('cost-open'); options?.onClose?.();
  document.querySelector<HTMLElement>('#open-cost')?.focus();
}
export function showCostTab(id: typeof activeTab) {
  activeTab = id; estimateOnly = false; refreshCostWorkbench();
  const content = document.querySelector<HTMLElement>('#cost-view .cost-content');
  if (highlightId) content?.querySelector<HTMLElement>(`[data-cost-row="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: 'center' });
  else if (content) content.scrollTop = 0;
}
function context(): CostContext {
  return { getProject: state, getMaterials: () => options.getMaterials?.() ?? [],
    updateProject: (mutator, settings) => { options.onChange(mutator, settings); refreshCostWorkbench(); },
    refresh: refreshCostWorkbench, toast: options.toast, requestRoute: options.requestRoute };
}
function priceLabel(item: CostItem) { return item.priceStatus === 'missing' ? '待定价' : item.priceStatus === 'reference' ? '参考价' : '已确认'; }
export function renderCostTable(items: CostItem[], editable = true): string {
  const rows = items.map(item => {
    const module = [...costModules.values()].find(module => module.section === item.section);
    const title = activeTab === 'summary' && module
      ? `<button class="cost-row-link" data-cost-tab="${module.id}" title="查看本专业明细">${escape(item.name)} ${icon('chevron', 12)}</button>`
      : `<strong>${escape(item.name)}</strong>`;
    return `<tr data-cost-row="${escape(item.id)}" class="${highlightId === item.id ? 'cost-highlight' : ''}">
      <td>${title}<small>${escape(item.feature)}</small>${item.source === 'manual' ? `<button class="cost-remove-manual" data-cost-remove="${escape(item.id)}">移除手工项</button>` : ''}</td>
      <td class="cost-code">${escape(item.code)}</td><td>${escape(item.unit)}</td><td class="cost-number">${escape(item.quantity)}</td>
      <td class="cost-number">${editable ? `<input type="number" min="0" step="any" value="${escape(item.unitPrice)}" data-cost-price="${escape(item.id)}" aria-label="${escape(item.name)}综合单价"><small class="${item.priceStatus === 'confirmed' ? '' : 'cost-warning-text'}">${priceLabel(item)}</small>` : escape(formatMoney(item.unitPrice))}</td>
      <td class="cost-number cost-amount" data-cost-amount="${escape(item.id)}">${escape(item.amount)}</td>
      <td class="cost-note">${item.estimate ? '<span class="cost-badge">估算</span> ' : ''}${item.priceStatus === 'missing' ? '<span class="cost-badge">待定价</span> ' : ''}${escape(item.note)}</td></tr>`;
  }).join('');
  return `<div class="cost-table-scroll"><table class="cost-table"><thead><tr><th>项目 / 特征</th><th>编码</th><th>单位</th><th>工程量</th><th>综合单价</th><th>合价</th><th>依据与备注</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function groupsHTML(items: CostItem[]) {
  const groups = new Map<string, CostItem[]>();
  for (const item of items) { const group = item.group || item.section; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(item); }
  return [...groups].map(([group, rows]) => `<details class="cost-group" open><summary>${escape(group)}<span>${rows.length} 项</span></summary>${renderCostTable(rows)}</details>`).join('');
}
function summaryHTML(project: Project, items: CostItem[]) {
  const summary = summarize(items, { ...project.cost?.rates, otherAmount: project.cost?.otherCost ?? '0' });
  return `<div class="cost-overview"><div class="cost-intro"><span class="eyebrow">PROJECT ESTIMATE</span><h2>从空间，到完整造价。</h2><p>各专业共用一份清单。工程量保留依据，费用统一汇总。</p></div><div class="cost-grand"><span>${summary.missingPriceCount ? '已定价部分含税小计' : '预计含税总价'}</span><strong data-cost-grand>¥ ${formatMoney(summary.total)}</strong><small>${items.length} 项清单 · 含 ${summary.estimateCount} 项估算</small></div></div>
    <div class="cost-summary-grid"><section class="cost-card"><h3>分部分项工程</h3>${COST_SECTIONS.map((section, index) => `<button class="cost-section-total" data-cost-tab="${['structure', 'finish', 'municipal'][index]}"><span><i>${String(index + 1).padStart(2, '0')}</i>${section}</span><strong data-cost-section="${section}">¥ ${formatMoney(summary.bySection[section])}</strong>${icon('chevron', 14)}</button>`).join('')}<p class="cost-sum-line"><span>分部分项合计</span><strong>${formatMoney(summary.subtotal)}</strong></p></section><section class="cost-card"><h3>费用与税金</h3><label class="cost-rate"><span>费率措施（%）</span><input data-cost-rate="measureRate" type="number" min="0" max="100" step="any" value="${project.cost?.rates?.measureRate ?? '2.5'}"></label><p class="cost-sum-line"><span>措施项目合计<small>已列措施 + 费率措施 ${summary.rateMeasures}</small></span><strong>${summary.measures}</strong></p><label class="cost-rate"><span>其他项目 / 暂列金额</span><input data-cost-other type="number" min="0" step="any" value="${project.cost?.otherCost ?? '0'}"></label><p class="cost-sum-line"><span>其他项目合计</span><strong>${summary.other}</strong></p>${summary.fees !== '0.00' ? `<p class="cost-sum-line"><span>规费</span><strong>${summary.fees}</strong></p>` : ''}<p class="cost-sum-line"><span>税前合计</span><strong>${summary.beforeTax}</strong></p><label class="cost-rate"><span>统一税率（%）</span><input data-cost-rate="taxRate" type="number" min="0" max="100" step="any" value="${project.cost?.rates?.taxRate ?? '9'}"></label><p class="cost-sum-line"><span>税金</span><strong>${summary.tax}</strong></p></section></div>
    ${summary.missingPriceCount ? `<p class="cost-notice">${summary.missingPriceCount} 项尚未填写单价，按 0 列示。当前金额仅为已定价部分，尚不构成完整预算。</p>` : ''}${summary.referencePriceCount ? `<p class="cost-notice">${summary.referencePriceCount} 项使用参考单价，请按当地信息价、实际规格及施工条件确认。</p>` : ''}
    <div class="cost-list-heading"><h3>总清单</h3><div><button class="button subtle ${estimateOnly ? 'active' : ''}" data-cost-estimates>含 ${summary.estimateCount} 项估算${estimateOnly ? ' · 仅显示估算' : ''}</button><button class="button subtle" data-cost-add>${icon('plus', 15)}手工项目</button></div></div>
    ${items.length ? COST_SECTIONS.map((section, index) => { const rows = items.filter(item => item.section === section && (!estimateOnly || item.estimate)); return rows.length ? `<details class="cost-group" open><summary><button data-cost-tab="${['structure', 'finish', 'municipal'][index]}">${section}</button><span>${rows.length} 项</span></summary>${renderCostTable(rows)}</details>` : ''; }).join('') : '<div class="cost-empty"><h3>准备第一份造价清单</h3><p>先在土建、装饰装修或市政中生成清单，也可添加手工项目。</p><button class="button primary" data-cost-tab="finish">开始装饰装修</button></div>'}`;
}
export function refreshCostWorkbench() {
  if (!isCostWorkbenchOpen() || !options) return;
  const host = document.querySelector<HTMLElement>('#cost-view');
  const focused = document.activeElement as HTMLInputElement;
  const focusKey = focused?.dataset?.costPrice; const focusId = focused?.id;
  const scroll = host.querySelector<HTMLElement>('.cost-content')?.scrollTop ?? 0;
  const project = state();
  let items: CostItem[] = [], errorText = '';
  try { items = getCostItems(project); const checked = validateItems(items); if (!checked.ok) throw new Error(checked.errors.join('；')); }
  catch (error) { errorText = error.message; }
  host.innerHTML = `<header class="cost-header"><div class="cost-brand">${icon('layers', 23)}<span><strong>造价工作台</strong><small>${escape(project.name)}</small></span></div><div><button class="button subtle" data-cost-save>${icon('save', 15)}保存项目</button><button class="button subtle" data-cost-csv>导出 CSV</button><button class="button subtle" data-cost-print>打印 / PDF</button><button class="button primary" data-cost-close>返回图纸</button></div></header><nav class="cost-tabs" aria-label="造价专业">${[['summary', '汇总'], ['structure', '土建'], ['finish', '装饰装修'], ['municipal', '市政']].map(([id, label]) => `<button data-cost-tab="${id}" class="${activeTab === id ? 'active' : ''}" aria-pressed="${activeTab === id}">${label}</button>`).join('')}<span>方案估算 · 编码以当地清单规范为准</span></nav><main class="cost-content">${project.levels?.length>1?`<p class="cost-notice">当前土建与装修方案按「${escape(project.levels.find(level=>level.id===project.activeLevelId)?.name||'当前层')}」户型生成；全楼层材料、家具与天花板预算请返回图纸查看。</p>`:''}${errorText ? `<p class="cost-notice cost-error">${escape(errorText)}</p>` : ''}<div id="cost-module-host"></div><div id="cost-items-host"></div></main><footer class="cost-footer"><span>指标估算不替代施工图预算与招标控制价；造价总表独立汇总，不再叠加原材料报价。</span><span>空间材料估算</span></footer>`;
  const body = host.querySelector<HTMLElement>('#cost-module-host'), table = host.querySelector<HTMLElement>('#cost-items-host');
  const historyControls = document.createElement('div'); historyControls.className = 'cost-history';
  historyControls.innerHTML = `<button class="icon-button" data-cost-undo aria-label="撤销造价修改" title="撤销 Ctrl+Z" ${document.querySelector<HTMLButtonElement>('#undo').disabled ? 'disabled' : ''}>${icon('undo', 16)}</button><button class="icon-button" data-cost-redo aria-label="重做造价修改" title="重做 Ctrl+Shift+Z" ${document.querySelector<HTMLButtonElement>('#redo').disabled ? 'disabled' : ''}>${icon('redo', 16)}</button>`;
  host.querySelector('.cost-tabs').insertBefore(historyControls, host.querySelector('.cost-tabs>span'));
  if (!errorText && activeTab === 'summary') body.innerHTML = summaryHTML(project, items);
  else if (activeTab !== 'summary') {
    const module = costModules.get(activeTab);
    if (!module) body.innerHTML = '<div class="cost-empty"><h3>本专业尚未接入</h3><p>返回汇总查看已有清单。</p></div>';
    else { try { module.render(body, context()); } catch (error) { body.innerHTML = `<p class="cost-notice cost-error">${escape(error.message)}</p>`; }
      const rows = items.filter(item => item.section === module.section && (!estimateOnly || item.estimate));
      table.innerHTML = `<div class="cost-list-heading"><h3>${module.section}清单 <small>${rows.length} 项</small></h3><div><button class="button subtle" data-cost-section-export>导出本专业</button><button class="button subtle" data-cost-clear>清空本专业</button></div></div>${rows.length ? groupsHTML(rows) : '<div class="cost-empty"><p>填写参数并生成本专业清单。</p></div>'}`;
    }
  }
  host.querySelector<HTMLElement>('.cost-content').scrollTop = scroll;
  const input = focusKey ? host.querySelector<HTMLInputElement>(`[data-cost-price="${CSS.escape(focusKey)}"]`) : focusId ? host.querySelector<HTMLInputElement>('#' + CSS.escape(focusId)) : null;
  input?.focus({ preventScroll: true });
}

function addManualItem() {
  const project = state(); let suffix = (project.cost?.manualItems?.length ?? 0) + 1;
  const dialog = openDialog('添加手工清单', `<form id="manual-cost-form"><div class="field-grid"><label>专业<select name="section">${COST_SECTIONS.map(section => `<option>${section}</option>`).join('')}</select></label><label>类别<select name="category"><option>分部分项</option><option>措施项目</option><option>其他项目</option></select></label><label>项目编码<input name="code" pattern="[0-9]{12}" value="099999999${String(suffix).padStart(3, '0')}" required></label><label>项目名称<input name="name" required maxlength="120"></label><label>单位<select name="unit">${COST_UNITS.map(unit => `<option>${unit}</option>`).join('')}</select></label><label>工程量<input name="quantity" type="number" min="0" step="any" required></label><label>综合单价（元）<input name="unitPrice" type="number" min="0" step="any" required></label><label>规格 / 做法<input name="feature" maxlength="500"></label></div><label class="field-label">依据与来源<input name="note" maxlength="2000"></label><button class="button primary full" type="submit">添加项目</button></form>`, { subtitle: '填写已核对的工程量和综合单价；手工数据也随项目保存。' });
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); try {
    const values = Object.fromEntries(new FormData(dialog.querySelector('form')));
    const item = createCostItem({ ...values, id: `manual-${Date.now()}-${suffix}`, source: 'manual', estimate: true, priceStatus: 'confirmed' } as any);
    if (getCostItems(state()).some(existing => existing.code === item.code)) throw new Error('项目编码已存在，请使用其他 12 位编码');
    options.onChange(next => { next.cost ??= {}; next.cost.manualItems ??= []; next.cost.manualItems.push(item); });
    dialog.close(); refreshCostWorkbench(); options.toast('手工项目已加入');
  } catch (error) { options.toast(error.message, true); } });
}
function editPrice(input: HTMLInputElement) {
  if (input.value === '') return;
  const id = input.dataset.costPrice;
  const item = getCostItems(state()).find(row => row.id === id); if (!item) return;
  try {
    const price = normalizeDecimal(input.value, '综合单价');
    options.onChange(next => {
      next.cost ??= {}; const manual = next.cost.manualItems?.find(row => row.id === id);
      if (manual) Object.assign(manual, createCostItem({ ...manual, unitPrice: price, priceStatus: 'confirmed' }));
      else { const module = [...costModules.values()].find(value => value.section === item.section);
        next.cost.modules ??= {}; next.cost.modules[module.id] ??= {}; next.cost.modules[module.id].priceOverrides ??= {};
        next.cost.modules[module.id].priceOverrides[id] = price; }
    }); refreshCostWorkbench();
  } catch (error) { options.toast(error.message, true); }
}
export function bindCostWorkbench() {
  const view = document.querySelector<HTMLElement>('#cost-view');
  view.addEventListener('input', event => { const input = event.target as HTMLInputElement; if (input.matches('[data-cost-price]')) editPrice(input); });
  view.addEventListener('change', event => { const input = event.target as HTMLInputElement; if (!input.matches('[data-cost-rate],[data-cost-other]')) return;
    try { const value = normalizeDecimal(input.value, input.hasAttribute('data-cost-other') ? '其他项目费' : '费率', { max: input.hasAttribute('data-cost-other') ? null : 100 });
      options.onChange(next => { next.cost ??= {}; next.cost.rates ??= { measureRate: '2.5', taxRate: '9' }; if (input.hasAttribute('data-cost-other')) next.cost.otherCost = value; else next.cost.rates[input.dataset.costRate] = value; }); refreshCostWorkbench();
    } catch (error) { options.toast(error.message, true); }
  });
  view.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLElement>('button'); if (!button) return;
    try {
      if (button.dataset.costTab) { highlightId = activeTab === 'summary' ? button.closest('tr')?.dataset.costRow ?? null : null; showCostTab(button.dataset.costTab as any); }
      else if (button.hasAttribute('data-cost-close')) closeCostWorkbench();
      else if (button.hasAttribute('data-cost-save')) document.querySelector<HTMLButtonElement>('#save').click();
      else if (button.hasAttribute('data-cost-undo') || button.hasAttribute('data-cost-redo')) document.querySelector<HTMLButtonElement>(button.hasAttribute('data-cost-undo') ? '#undo' : '#redo').click();
      else if (button.hasAttribute('data-cost-estimates')) { estimateOnly = !estimateOnly; refreshCostWorkbench(); }
      else if (button.hasAttribute('data-cost-add')) addManualItem();
      else if (button.dataset.costRemove && confirm('移除这项手工清单？可以撤销。')) { options.onChange(next => { next.cost.manualItems = next.cost.manualItems.filter(item => item.id !== button.dataset.costRemove); }); refreshCostWorkbench(); }
      else if (button.hasAttribute('data-cost-clear') && activeTab !== 'summary' && confirm('清空本专业的参数、清单及单价配置？可以撤销。')) { const id = activeTab as CostModule['id']; options.onChange(next => { next.cost ??= {}; if (next.cost.modules) delete next.cost.modules[id]; next.cost.manualItems = (next.cost.manualItems ?? []).filter(item => item.section !== costModules.get(id).section); }); refreshCostWorkbench(); }
      else if (button.hasAttribute('data-cost-csv') || button.hasAttribute('data-cost-section-export') || button.hasAttribute('data-cost-print')) {
        const project = state(), all = getCostItems(project);
        const section = activeTab !== 'summary' ? costModules.get(activeTab)?.section : undefined;
        const rows = button.hasAttribute('data-cost-section-export') && section ? all.filter(item => item.section === section) : all;
        const summary = summarize(rows, { ...project.cost?.rates, otherAmount: button.hasAttribute('data-cost-section-export') ? '0' : project.cost?.otherCost ?? '0' });
        if (button.hasAttribute('data-cost-print')) printCostReport(rows, summary, { name: project.name }); else downloadCostCSV(rows, summary, { name: project.name });
      }
    } catch (error) { options.toast(error.message, true); }
  });
  window.addEventListener('keydown', event => { if (isCostWorkbenchOpen() && event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); closeCostWorkbench(); } });
}
