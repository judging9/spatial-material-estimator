import { applyProjectMaterialPrices, collectProjectSourceRows } from './lib/project-price-edit.js';
import { calculateProjectBudget } from './lib/project-budget.js';
import { describePriceSource, normalizePriceProvenance } from './lib/price-provenance.js';
import { normalizeDecimal } from './lib/pricing.js';
import { escape, icon, money, openDialog, toast, unitPrice } from './ui.js';
const sourceText = (material) => describePriceSource(material.provenance, material.demo);
const fingerprint = (material) => JSON.stringify([material.id, material.unit, material.unitPrice, material.provenance, material.demo]);
export function renderProjectPriceSources(rows, materials) {
    const supported = rows.filter(row => row.sourceLinkable);
    if (!supported.length)
        return '';
    return `<section class="panel-section price-source-inspector"><div class="section-head"><h3>价格来源</h3><span class="chip">可追溯报价</span></div><div class="price-source-lines">${supported.map(row => {
        const material = materials.find(item => item.id === row.materialId);
        return `<div class="project-source-line"><strong>${escape(row.name)}</strong><p>${escape(row.sourceNote || '用户手工报价')}</p>${row.provenance?.sourceUrl ? `<a href="${escape(row.provenance.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源</a>` : ''}${material ? `<small>关联：${escape(material.name)} · 库内 ¥ ${unitPrice(material.unitPrice)} / ${escape(material.unit)}</small>` : ''}<div class="project-source-actions"><button type="button" class="text-button" data-action="link-price-source" data-price-source-row="${escape(row.id)}">${material ? '更换来源' : '关联报价来源'}</button><button type="button" class="text-button" data-action="refresh-price-source" data-price-source-row="${escape(row.id)}">${icon('scan', 12)}刷新报价</button></div></div>`;
    }).join('')}</div><p class="help">读取实际来源后核对单价；损耗、人工和固定费保留原设置。</p></section>`;
}
export function showPriceSourceLink(rowId, context) {
    const row = collectProjectSourceRows(context.getProject()).find(item => item.id === rowId);
    if (!row?.sourceLinkable) {
        toast('此报价需要在对应专业工具中编辑。', true);
        return;
    }
    const available = context.getMaterials().filter(material => material.unit === row.unit);
    const dialog = openDialog('关联报价来源', `<p class="help">${escape(row.objectName)} / ${escape(row.name)} · 当前单价 ${row.values.unitPrice === '' ? '待填写' : '¥ ' + unitPrice(row.values.unitPrice)} / ${escape(row.unit)}</p><label><span class="field-label">选择同单位的报价材料</span><select id="source-material-choice"><option value="">请选择来源</option>${available.map(material => `<option value="${escape(material.id)}" ${row.materialId === material.id ? 'selected' : ''}>${escape(material.name)} · ¥ ${unitPrice(material.unitPrice)} / ${escape(material.unit)}${material.demo ? ' · Demo' : ''}</option>`).join('')}</select></label><div id="source-material-detail" class="source-material-detail"></div><p class="help">此操作关联报价并应用其单价，不改变已绘制的几何、材料外观、施工数量和其他费用。可在材料库中先导入或填写供应商报价。</p><p id="source-link-status" class="price-source-error" role="status"></p>`, { subtitle: '单位相同才能应用；先核对具体产品和规格。', footer: '<button id="source-open-library" class="button subtle" type="button">管理材料与来源</button><button id="source-link-apply" class="button primary" type="button">关联并应用单价</button>' });
    let selected;
    const draw = () => {
        selected = available.find(material => material.id === dialog.querySelector('#source-material-choice').value);
        dialog.querySelector('#source-material-detail').innerHTML = selected ? `<strong>${escape(selected.name)}</strong><p>${escape(sourceText(selected))}</p><p>${escape(selected.provenance?.spec || selected.description || '规格未注明')}</p>${selected.provenance?.sourceUrl ? `<a href="${escape(selected.provenance.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原报价网页</a>` : ''}<span>¥ ${unitPrice(selected.unitPrice)} / ${escape(selected.unit)}</span>` : '<p class="help">没有可用的同单位材料时，先在材料库添加实际报价。</p>';
        dialog.querySelector('#source-link-apply').disabled = !selected;
    };
    dialog.querySelector('#source-material-choice').addEventListener('change', draw);
    dialog.querySelector('#source-open-library').addEventListener('click', () => { dialog.close(); context.manage(); });
    dialog.querySelector('#source-link-apply').addEventListener('click', () => {
        try {
            const fresh = context.getMaterials().find(material => material.id === selected?.id);
            if (!fresh || fingerprint(fresh) !== fingerprint(selected))
                throw new RangeError('材料库报价已变化，请重新选择来源。');
            context.apply(applyProjectMaterialPrices(context.getProject(), [{ rowId, material: fresh, expectedPrice: row.values.unitPrice, expectedMaterialId: row.materialId ?? null }]));
            dialog.close();
            toast('已关联来源并应用单价，可一次撤销');
        }
        catch (error) {
            dialog.querySelector('#source-link-status').textContent = error.message;
        }
    });
    draw();
}
export function showProjectMaterialSync(context, materialIds) {
    const allowed = materialIds ? new Set(materialIds) : null, materials = context.getMaterials();
    const candidates = collectProjectSourceRows(context.getProject()).filter(row => row.sourceLinkable && row.materialId && (!allowed || allowed.has(row.materialId))).map(row => ({ row, material: materials.find(material => material.id === row.materialId) })).filter(entry => entry.material);
    if (!candidates.length) {
        toast('材料库已更新，当前项目没有关联这些报价的分项。');
        return;
    }
    const selected = new Set(candidates.filter(({ row, material }) => material.unit === row.unit).map(({ row }) => row.id));
    const dialog = openDialog('将最新报价应用到项目', `<p class="help">选择需要同步的分项，核对来源及项目总预算。项目保留绘图时的实际施工数量、损耗、人工和固定费；本次应用可一次撤销。</p><div class="source-sync-list">${candidates.map(({ row, material }) => `<label class="source-sync-row"><input type="checkbox" data-source-sync-row="${escape(row.id)}" ${selected.has(row.id) ? 'checked' : 'disabled'}><span><strong>${escape(row.objectName)} / ${escape(row.name)}</strong><small>${escape(row.levelName || ({ decoration: '装修', civil: '土建', municipal: '市政' })[row.section])} · ${escape(sourceText(material))}</small>${material.unit !== row.unit ? '<small class="price-source-error">来源单位已变化，不能覆盖项目单价</small>' : ''}</span><span>${row.values.unitPrice === '' ? '待填写' : '¥ ' + unitPrice(row.values.unitPrice)}<small>→ ¥ ${unitPrice(material.unitPrice)} / ${escape(material.unit)}</small></span></label>`).join('')}</div><div class="source-sync-summary"><span>当前含税总预算<strong id="source-sync-before"></strong></span><span>应用后的含税总预算<strong id="source-sync-after"></strong></span></div><p id="source-sync-status" class="price-source-error" role="status"></p>`, { wide: true, footer: '<button id="source-sync-skip" class="button subtle" type="button">保留项目原价</button><button id="source-sync-apply" class="button primary" type="button">应用选中报价</button>' });
    const changes = () => candidates.filter(({ row }) => selected.has(row.id)).map(({ row, material }) => ({ rowId: row.id, material, expectedPrice: row.values.unitPrice, expectedMaterialId: row.materialId ?? null }));
    const total = (budget) => budget.total === null ? '已确认 ¥ ' + money(budget.knownTotal) : '¥ ' + money(budget.total);
    const preview = () => {
        const button = dialog.querySelector('#source-sync-apply');
        try {
            const current = context.getProject(), result = applyProjectMaterialPrices(current, changes());
            dialog.querySelector('#source-sync-before').textContent = total(calculateProjectBudget(current));
            dialog.querySelector('#source-sync-after').textContent = total(calculateProjectBudget(result));
            button.disabled = !selected.size;
            dialog.querySelector('#source-sync-status').textContent = '';
        }
        catch (error) {
            button.disabled = true;
            dialog.querySelector('#source-sync-status').textContent = error.message;
        }
    };
    dialog.querySelector('.source-sync-list').addEventListener('change', event => {
        const input = event.target;
        if (input.dataset.sourceSyncRow) {
            if (input.checked)
                selected.add(input.dataset.sourceSyncRow);
            else
                selected.delete(input.dataset.sourceSyncRow);
            preview();
        }
    });
    dialog.querySelector('#source-sync-skip').addEventListener('click', () => dialog.close());
    dialog.querySelector('#source-sync-apply').addEventListener('click', () => {
        try {
            for (const { row, material } of candidates.filter(({ row }) => selected.has(row.id))) {
                const fresh = context.getMaterials().find(item => item.id === material.id);
                if (!fresh || fingerprint(fresh) !== fingerprint(material))
                    throw new RangeError('材料库报价已再次变化，请重新核对。');
            }
            context.apply(applyProjectMaterialPrices(context.getProject(), changes()));
            dialog.close();
            toast(`已同步 ${selected.size} 个报价分项，可一次撤销`);
        }
        catch (error) {
            dialog.querySelector('#source-sync-status').textContent = error.message;
        }
    });
    preview();
}
export function materialSourceFields(material) {
    const p = material?.provenance;
    const kind = p?.refresh?.kind ?? (p?.sourceUrl ? 'web' : 'manual');
    const field = (name, label, value = '', type = 'text') => `<label><span class="field-label">${label}</span><input name="${name}" type="${type}" value="${escape(value)}" maxlength="${type === 'url' ? 2048 : 240}"></label>`;
    return `<details class="material-source-fields" open><summary>价格来源与刷新</summary><div class="field-grid"><label><span class="field-label">来源类型</span><select name="sourceKind"><option value="manual" ${kind === 'manual' ? 'selected' : ''}>手工 / 文件报价</option><option value="web" ${kind === 'web' ? 'selected' : ''}>供应商 / 地方网页</option><option value="nbs" ${kind === 'nbs' ? 'selected' : ''}>国家统计局生产资料</option></select></label>${field('quoteSource', '来源名称', p?.source || '')}${field('quoteRegion', '地区', p?.region || '')}${field('quoteDate', '报价日期', p?.priceDate || '', 'date')}${field('quoteSupplier', '供应商', p?.supplier || '')}${field('quoteSpec', '报价规格', p?.spec || '')}${field('quoteName', '来源中的产品名称', p?.materialName || material?.name || '')}${field('quoteUrl', '来源网址', p?.sourceUrl || p?.refresh?.url || '', 'url')}</div><p class="help">网页支持真实 HTML 报价表。产品名称、规格和单位必须与源表一致；手工保存会注明录入方式，刷新读取后记录实际发布日期。</p></details>`;
}
export function readMaterialSource(form, material) {
    const get = (key) => String(form.get(key) || '').trim(), kind = get('sourceKind');
    const sourceUrl = get('quoteUrl') || (kind === 'nbs' ? 'https://www.stats.gov.cn/sj/zxfb/' : '');
    if (kind === 'web' && !sourceUrl)
        throw new RangeError('网页报价来源需要完整网址。');
    const data = { source: get('quoteSource') || (kind === 'nbs' ? '国家统计局·流通领域重要生产资料' : '用户手工报价'), materialName: get('quoteName') || get('name'), originalUnit: material?.unit === get('unit') ? material.provenance?.originalUnit || get('unit') : get('unit'), manual: true };
    for (const [field, key] of [['region', 'quoteRegion'], ['priceDate', 'quoteDate'], ['supplier', 'quoteSupplier'], ['spec', 'quoteSpec']])
        if (get(key))
            data[field] = get(key);
    if (sourceUrl)
        data.sourceUrl = sourceUrl;
    if (kind === 'web' || kind === 'nbs') {
        const old = material?.provenance?.refresh;
        const unchanged = old?.kind === kind && (old.url === sourceUrl || kind === 'nbs' && material?.provenance?.sourceUrl === sourceUrl);
        data.refresh = unchanged ? structuredClone(old) : { kind, url: kind === 'nbs' ? 'https://www.stats.gov.cn/sj/zxfb/' : sourceUrl };
    }
    const result = normalizePriceProvenance(data);
    if (material && normalizeDecimal(get('unitPrice')) === normalizeDecimal(material.unitPrice)) {
        const clean = (p) => p ? JSON.stringify([p.source, p.sourceUrl || '', p.region || '', p.priceDate || '', p.supplier || '', p.spec || '', p.materialName || material.name, p.originalUnit || material.unit, p.refresh]) : '';
        if (clean(result) === clean(material.provenance)) {
            result.manual = material.provenance?.manual;
            result.updatedAt = material.provenance?.updatedAt;
        }
    }
    return result;
}
//# sourceMappingURL=project-material-prices.js.map