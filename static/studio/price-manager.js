import { escape, icon, openDialog, toast, unitPrice } from './ui.js';
import { applyPriceRows, findPriceTarget, normalizePriceRows, parsePriceText } from './lib/material-prices.js';
import { applySavedMaterialPrices, readSavedMaterialPrices, savedMaterialPriceSource, normalizeMaterialRefreshSource } from './lib/material-price-refresh.js';
import { describePriceSource } from './lib/price-provenance.js';
const style = `<style>
.price-source-block{padding:16px;border:1px solid var(--line);border-radius:8px;margin-bottom:20px}.price-source-block .button{margin-top:14px}.price-source-block h3{margin:0 0 8px}.price-actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.price-actions .button{font-size:12px}.price-state{font-size:12px;line-height:1.8;color:var(--muted);min-height:20px}.price-state.error{color:#a05b48}.price-import-list{max-height:340px;overflow:auto;margin-top:16px}.price-row{padding:14px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:18px minmax(0,1fr) 145px;gap:12px;align-items:start}.price-row input[type=checkbox]{width:16px;height:16px;padding:0;margin:3px 0;accent-color:var(--accent)}.price-row strong{font-size:12px;font-weight:500}.price-row p{font-size:10px;line-height:1.8;margin:4px 0;color:var(--muted);overflow-wrap:anywhere}.price-row select{font-size:11px;max-width:145px;padding:8px}.price-row .price-value{color:var(--ink);font-size:14px;font-variant-numeric:tabular-nums;margin:0 0 9px}.price-row.unsupported{opacity:.65}.price-source-link{color:var(--accent);font-size:11px;text-decoration:underline;overflow-wrap:anywhere}.price-search{margin-top:16px}.price-errors{margin-top:12px;color:#a05b48;font-size:11px;line-height:1.8}.price-map-sample{overflow:auto;max-height:180px;border:1px solid var(--line);border-radius:6px;margin:16px 0}.price-map-sample table{border-collapse:collapse;font-size:10px;min-width:100%}.price-map-sample td{padding:7px;border-bottom:1px solid var(--line);white-space:nowrap}.price-field-label{font-size:11px;color:var(--muted);margin-bottom:7px;display:block}
</style>`;
const refreshStyle = `<style>
.saved-price-list{display:grid;gap:0;margin-top:16px;max-height:52vh;overflow:auto;scrollbar-width:thin}.saved-price-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:start;gap:12px;padding:16px 0;border-bottom:1px solid var(--line)}.saved-price-row input[type=checkbox]{padding:0;width:15px;height:15px;margin-top:4px;accent-color:var(--accent)}.saved-price-row strong{font-size:12px;font-weight:500}.saved-price-row p{font-size:10px;color:var(--muted);margin:5px 0;line-height:1.8;overflow-wrap:anywhere}.saved-price-value{font-size:14px;font-variant-numeric:tabular-nums;color:var(--ink);margin-bottom:8px;white-space:nowrap}.saved-price-value del{font-size:11px;color:var(--muted);margin-right:8px}.saved-price-row .button{padding:6px 9px;font-size:10px}.saved-price-row .price-source-link{font-size:10px}.saved-price-reason{color:#946e4e!important}.saved-price-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.saved-price-toolbar input{flex:1;min-width:120px;font-size:12px}.saved-price-toolbar .button{font-size:11px}.saved-price-count{font-size:11px;color:var(--muted)}.saved-price-note{margin:16px 0;font-size:11px;line-height:1.9;color:var(--muted)}@media(max-width:600px){.saved-price-row{grid-template-columns:18px minmax(0,1fr)}.saved-price-row>div:last-child{grid-column:2}.saved-price-value{margin:2px 0}.saved-price-list{max-height:44vh}}
</style>`;
async function request(path, body, signal, raw = false) {
    const response = await fetch(path, { method: 'POST', headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body), signal });
    const result = await response.json();
    if (!response.ok || !result.ok)
        throw new Error(result.error || '无法读取报价，请稍后再试');
    return result.data;
}
const value = (dialog, selector) => dialog.querySelector(selector)?.value.trim() || '';
const sourceHref = (url) => {
    try {
        const parsed = new URL(String(url));
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
    }
    catch {
        return '';
    }
};
/** Saved-source refresh never writes a rate before the user has reviewed the
 * exact matched identity and the actual response from its online source. */
export function openSavedPriceRefresh(materials, onCommit, options = {}) {
    const dialog = openDialog('刷新材料来源报价', `${style}${refreshStyle}<p class="help">按已关联的真实来源读取报价，严格核对名称、规格、单位、地区和供应商。确认后写入材料库，再核对需要同步的项目分项。</p><div class="saved-price-toolbar spaced"><input id="price-refresh-search" placeholder="搜索材料或价格来源" aria-label="搜索已保存材料报价"><button id="price-refresh-read" type="button" class="button primary">${icon('scan', 14)}读取选中来源</button></div><p id="price-refresh-status" class="price-state spaced" role="status" aria-live="polite">没有在线来源的示例、手工或文件报价，可以先关联报价来源。</p><div id="price-refresh-list" class="saved-price-list"></div><p class="saved-price-note">只更新已确认的材料单价和来源日期，损耗、人工与固定费用保留原设置。来源未提供报价日期时会明确显示，网络失败保留原价。</p>`, {
        wide: true, subtitle: '来源清楚，核对差异，再更新报价',
        footer: '<span id="price-refresh-count" class="saved-price-count"></span><button id="price-refresh-back" type="button" class="button subtle">导入其他报价</button><button id="price-refresh-apply" type="button" class="button primary" disabled>应用已核对报价</button>',
    });
    let busy = false, entries = [], controller = null;
    const readable = new Set(materials.filter(material => savedMaterialPriceSource(material).eligible).map(material => material.id));
    const selected = new Set(options.materialId ? readable.has(options.materialId) ? [options.materialId] : [] : [...readable]);
    const checked = new Set(), status = dialog.querySelector('#price-refresh-status');
    const current = () => options.getMaterials?.() ?? materials;
    const draw = () => {
        const q = value(dialog, '#price-refresh-search').toLowerCase();
        const filtered = materials.filter(material => (material.name + ' ' + describePriceSource(material.provenance, material.demo)).toLowerCase().includes(q));
        dialog.querySelector('#price-refresh-list').innerHTML = filtered.map(material => {
            const source = savedMaterialPriceSource(material), entry = entries.find(entry => entry.materialId === material.id), candidate = entry?.candidate;
            const linked = source.eligible, ready = entry?.state === 'ready', checkedRow = ready ? checked.has(material.id) : selected.has(material.id), href = sourceHref(candidate?.sourceUrl ?? material.provenance?.sourceUrl ?? source.source?.url);
            return `<div class="saved-price-row" data-price-refresh-material="${escape(material.id)}"><input type="checkbox" ${checkedRow ? 'checked' : ''} ${!linked || busy ? 'disabled' : ''} data-price-refresh-select="${escape(material.id)}" aria-label="选择${escape(material.name)}来源报价"><div><strong>${escape(material.name)}</strong><p>${escape(candidate ? [candidate.source, candidate.region, candidate.priceDate || '报价日期未提供', candidate.supplier].filter(Boolean).join(' · ') : describePriceSource(material.provenance, material.demo))}</p>${material.provenance?.spec ? `<p>规格：${escape(material.provenance.spec)}</p>` : ''}${href ? `<a class="price-source-link" href="${escape(href)}" target="_blank" rel="noopener noreferrer">查看报价来源</a>` : ''}${entry ? `<p class="${ready ? '' : 'saved-price-reason'}" data-price-refresh-state="${escape(material.id)}">${escape(ready ? entry.reason : entry.reason + ' 原报价保留。')}</p>` : !linked ? `<p class="saved-price-reason">${escape(source.reason)}</p>` : ''}</div><div><div class="saved-price-value">${candidate ? `<del>¥ ${unitPrice(material.unitPrice)}</del>→ ` : ''}¥ ${unitPrice(candidate?.unitPrice ?? material.unitPrice)}<span style="font-size:10px;color:var(--muted)"> / ${escape(material.unit)}</span></div><button type="button" class="button subtle" ${busy ? 'disabled' : ''} ${linked ? 'data-price-refresh-id' : 'data-price-link-id'}="${escape(material.id)}">${linked ? '刷新报价' : '关联来源'}</button></div></div>`;
        }).join('') || '<p class="help">没有匹配的材料。</p>';
        const count = checked.size, button = dialog.querySelector('#price-refresh-apply');
        button.disabled = busy || !count;
        button.textContent = count ? `应用已核对报价（${count}）` : '应用已核对报价';
        dialog.querySelector('#price-refresh-read').disabled = busy || !selected.size;
        dialog.querySelector('#price-refresh-count').textContent = `${readable.size} 项在线来源 · ${count} 项已核对`;
    };
    const read = async (ids) => {
        if (busy || !ids.length)
            return;
        busy = true;
        controller = new AbortController();
        for (const id of ids)
            selected.add(id);
        const timer = setTimeout(() => controller?.abort(), 40000);
        status.classList.remove('error');
        status.textContent = `正在读取 ${ids.length} 项材料的真实来源报价…`;
        draw();
        try {
            const result = await readSavedMaterialPrices(current(), { materialIds: ids, signal: controller.signal });
            if (!dialog.open)
                return;
            entries = [...entries.filter(entry => !ids.includes(entry.materialId)), ...result];
            for (const id of ids)
                checked.delete(id);
            for (const entry of result)
                if (entry.state === 'ready')
                    checked.add(entry.materialId);
            const ready = result.filter(entry => entry.state === 'ready').length;
            status.textContent = `已核对 ${ready} 项报价${result.length > ready ? `，${result.length - ready} 项未能更新，保留原报价` : ''}。请核对价格和来源日期后应用。`;
            if (!ready)
                status.classList.add('error');
        }
        catch (error) {
            if (!dialog.open)
                return;
            status.textContent = (error.name === 'AbortError' ? '读取超时或已取消。' : '读取失败：' + error.message + '。') + '原报价保留。';
            status.classList.add('error');
        }
        finally {
            clearTimeout(timer);
            controller = null;
            busy = false;
            if (dialog.open)
                draw();
        }
    };
    dialog.addEventListener('close', () => controller?.abort(), { once: true });
    dialog.querySelector('#price-refresh-search').addEventListener('input', draw);
    dialog.querySelector('#price-refresh-list').addEventListener('change', event => {
        const input = event.target, id = input.dataset.priceRefreshSelect;
        if (!id || busy)
            return;
        input.checked ? selected.add(id) : selected.delete(id);
        if (entries.some(entry => entry.materialId === id && entry.state === 'ready'))
            input.checked ? checked.add(id) : checked.delete(id);
        draw();
    });
    dialog.querySelector('#price-refresh-list').addEventListener('click', event => {
        const button = event.target.closest('[data-price-refresh-id],[data-price-link-id]');
        if (!button || busy)
            return;
        if (button.dataset.priceRefreshId)
            void read([button.dataset.priceRefreshId]);
        else
            openPriceManager(current(), onCommit, { ...options, materialId: button.dataset.priceLinkId });
    });
    dialog.querySelector('#price-refresh-read').addEventListener('click', () => void read([...selected]));
    dialog.querySelector('#price-refresh-back').addEventListener('click', () => openPriceManager(current(), onCommit, options));
    dialog.querySelector('#price-refresh-apply').addEventListener('click', () => {
        if (busy)
            return;
        try {
            const ids = [...checked], next = applySavedMaterialPrices(current(), entries, ids);
            onCommit(next, ids);
            dialog.close();
            toast(`已更新 ${ids.length} 项来源报价`);
        }
        catch (error) {
            status.textContent = error.message;
            status.classList.add('error');
        }
    });
    draw();
}
/** Source preview is separate from committing prices into the material library. */
export function openPriceManager(materials, onCommit, options = {}) {
    const dialog = openDialog('更新与导入材料报价', `${style}<section class="price-source-block"><h3>已关联来源的材料</h3><p class="help">按材料保存的官方或地方来源刷新报价。先核对实际价格，再同步需要更新的项目分项。</p><button id="price-refresh-saved" type="button" class="button subtle">${icon('scan', 14)}刷新已保存来源</button></section><section class="price-source-block"><h3>国家统计局公开报价</h3><p class="help">读取最新一期流通领域生产资料价格，保留原始计价单位、全国参考价和发布日期。具体品牌、地方施工材料请以当地报价为准。</p><button id="price-official-update" type="button" class="button primary">${icon('scan', 16)}更新官方报价</button><a class="price-source-link spaced" href="https://www.stats.gov.cn/sj/zxfb/" target="_blank" rel="noopener noreferrer" style="display:block">查看国家统计局官方网站</a></section><h3>地方网站 / 供应商报价</h3><div class="field-grid"><label><span class="price-field-label">地区（缺省行使用）</span><input id="price-region" maxlength="80" placeholder="例如：浙江杭州"></label><label><span class="price-field-label">报价日期（按来源核对）</span><input id="price-date" type="date"></label><label><span class="price-field-label">来源名称</span><input id="price-source" maxlength="120" placeholder="网站或供应商名称"></label><label><span class="price-field-label">来源网址（可选）</span><input id="price-source-url" type="url" placeholder="https://…"></label></div><div class="price-actions"><button id="price-file-button" type="button" class="button subtle">${icon('upload', 16)}导入 CSV / Excel</button><button id="price-web-button" type="button" class="button subtle">${icon('scan', 16)}读取网页表格</button><a class="button subtle" href="/api/template.xlsx" download>下载导入模板</a></div><input id="price-import-file" type="file" accept=".csv,.xlsx,.txt" hidden><label class="price-field-label" for="price-paste">或从网页、Excel 复制含表头的报价表</label><textarea id="price-paste" rows="5" placeholder="名称　规格　单位　单价　地区　日期　来源"></textarea><button id="price-paste-button" class="button subtle spaced" type="button">预览粘贴报价</button><p id="price-status" class="price-state spaced" role="status" aria-live="polite">先读取报价，再核对材料与单位后写入材料库。项目单价按选择的分项同步。</p>`, { wide: true, subtitle: options.materialId ? '为选中的材料关联真实报价来源' : '官方价格和地方价格都有来源；导入前先核对。' });
    dialog.querySelector('#price-refresh-saved').addEventListener('click', () => openSavedPriceRefresh(options.getMaterials?.() ?? materials, onCommit, options));
    let busy = false;
    const context = () => ({ source: value(dialog, '#price-source'), sourceUrl: value(dialog, '#price-source-url'), region: value(dialog, '#price-region'), priceDate: value(dialog, '#price-date') });
    const job = async (message, run) => {
        if (busy)
            return;
        busy = true;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 40000);
        const onClose = () => controller.abort();
        dialog.addEventListener('close', onClose, { once: true });
        const status = dialog.querySelector('#price-status');
        status.textContent = message;
        status.classList.remove('error');
        dialog.querySelectorAll('button:not([data-dialog-close])').forEach(button => button.disabled = true);
        try {
            await run(controller.signal);
        }
        catch (error) {
            if (!dialog.open)
                return;
            status.textContent = error.name === 'AbortError' ? '读取超时，请检查网络后重试。材料库中的价格保持原值。' : '读取失败：' + error.message + '。材料库中的价格保持原值。';
            status.classList.add('error');
        }
        finally {
            clearTimeout(timer);
            dialog.removeEventListener('close', onClose);
            busy = false;
            dialog.querySelectorAll('button:not([data-dialog-close])').forEach(button => button.disabled = false);
        }
    };
    dialog.querySelector('#price-official-update').addEventListener('click', () => job('正在读取国家统计局最新一期报价…', async (signal) => {
        const result = await request('/api/scrape/nbs/preview', {}, signal);
        previewPrices(materials, onCommit, result.rows, { sourceUrl: result.url, source: '国家统计局·流通领域重要生产资料', region: '全国', priceDate: result.price_date, refresh: { kind: 'nbs', url: 'https://www.stats.gov.cn/sj/zxfb/' } }, result.title || '国家统计局最新报价', [], options);
    }));
    dialog.querySelector('#price-file-button').addEventListener('click', () => dialog.querySelector('#price-import-file').click());
    dialog.querySelector('#price-import-file').addEventListener('change', event => {
        const input = event.target, file = input.files?.[0];
        if (!file)
            return;
        job('正在解析 ' + file.name + '…', async (signal) => {
            if (file.size > 10 * 1024 * 1024)
                throw new Error('报价文件不能超过 10 MB');
            const result = await request('/api/import/preview?name=' + encodeURIComponent(file.name), await file.arrayBuffer(), signal, true);
            previewPrices(materials, onCommit, result.rows, { ...context(), source: context().source || file.name }, '文件报价预览', result.errors, options);
        });
        input.value = '';
    });
    dialog.querySelector('#price-paste-button').addEventListener('click', () => job('正在解析粘贴报价…', async () => {
        previewPrices(materials, onCommit, parsePriceText(value(dialog, '#price-paste')), context(), '粘贴报价预览', [], options);
    }));
    dialog.querySelector('#price-web-button').addEventListener('click', () => job('正在读取网页中的实际 HTML 表格…', async (signal) => {
        const ctx = context();
        if (!/^https?:\/\//i.test(ctx.sourceUrl))
            throw new Error('请填写完整的来源网址');
        const result = await request('/api/scrape/preview', { url: ctx.sourceUrl }, signal);
        if (!result.tables?.length)
            throw new Error('该网页没有可读取的 HTML 表格，可下载报价文件或复制表格导入');
        mapWebsite(materials, onCommit, result.tables, ctx, options);
    }));
}
function previewPrices(materials, onCommit, rows, context, title, extraErrors = [], options = {}) {
    const normalized = normalizePriceRows(rows, context), candidates = normalized.candidates;
    const errors = [...extraErrors, ...normalized.errors];
    const dialog = openDialog('核对并更新材料报价', `${style}<p class="help">${escape(title)} · ${candidates.length} 条可核对数据。按实际单位新增材料，或选择单位相同的已有材料更新。</p>${context.sourceUrl ? `<a class="price-source-link" href="${escape(context.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源网页</a>` : ''}<input id="price-preview-search" class="price-search" placeholder="搜索材料、地区或规格" aria-label="搜索报价"><div id="price-preview-list" class="price-import-list"></div>${errors.length ? `<p class="price-errors">${errors.slice(0, 12).map(escape).join('<br>')}${errors.length > 12 ? `<br>另有 ${errors.length - 12} 条无效数据…` : ''}</p>` : ''}<p id="price-preview-status" class="price-state spaced" role="status">单位不同的报价不能直接覆盖。未提供日期的行会明确标注。</p>`, { wide: true, subtitle: '选中条目后写入材料库，保留来源、地区和报价日期。', footer: '<button id="price-preview-back" type="button" class="button subtle">返回</button><button id="price-apply" type="button" class="button primary">更新选中报价</button>' });
    const selection = new Map(candidates.filter(row => row.supported).map(row => [row.id, { id: row.id, targetId: findPriceTarget(materials, row) }]));
    const draw = () => {
        const q = value(dialog, '#price-preview-search').toLowerCase(), filtered = candidates.filter(row => `${row.name} ${row.spec} ${row.region}`.toLowerCase().includes(q));
        dialog.querySelector('#price-preview-list').innerHTML = filtered.length ? filtered.map(row => `<div class="price-row ${row.supported ? '' : 'unsupported'}"><input type="checkbox" data-price-row="${row.id}" ${selection.has(row.id) ? 'checked' : ''} ${row.supported ? '' : 'disabled'} aria-label="选择${escape(row.name)}报价"><div><strong>${escape(row.name)}${row.spec ? ' · ' + escape(row.spec) : ''}</strong><p>${escape(row.region)} · ${escape(row.priceDate || '日期未提供')}<br>${escape(row.source)}${row.supplier ? ' · ' + escape(row.supplier) : ''}${row.error ? '<br>' + escape(row.error) : ''}</p></div><div><p class="price-value">¥ ${unitPrice(row.unitPrice)} <span style="font-size:10px">/ ${escape(row.unit || '?')}</span></p>${row.supported ? `<select data-price-target="${row.id}" aria-label="${escape(row.name)}报价写入位置"><option value="">新增为材料</option>${materials.filter(material => material.unit === row.unit).map(material => `<option value="${escape(material.id)}" ${selection.get(row.id)?.targetId === material.id ? 'selected' : ''}>更新：${escape(material.name)}</option>`).join('')}</select>` : ''}</div></div>`).join('') : '<p class="help">没有匹配的报价数据。</p>';
        const apply = dialog.querySelector('#price-apply');
        apply.disabled = !selection.size;
        apply.textContent = selection.size ? `更新选中报价（${selection.size}）` : '请选择报价';
    };
    dialog.querySelector('#price-preview-search').addEventListener('input', draw);
    dialog.querySelector('#price-preview-list').addEventListener('change', event => {
        const input = event.target;
        if (input.dataset.priceRow) {
            if (input.checked)
                selection.set(input.dataset.priceRow, { id: input.dataset.priceRow, targetId: dialog.querySelector(`[data-price-target="${input.dataset.priceRow}"]`)?.value || null });
            else
                selection.delete(input.dataset.priceRow);
        }
        if (input.dataset.priceTarget && selection.has(input.dataset.priceTarget))
            selection.set(input.dataset.priceTarget, { id: input.dataset.priceTarget, targetId: input.value || null });
        const button = dialog.querySelector('#price-apply');
        button.disabled = !selection.size;
        button.textContent = selection.size ? `更新选中报价（${selection.size}）` : '请选择报价';
    });
    dialog.querySelector('#price-preview-back').addEventListener('click', () => openPriceManager(options.getMaterials?.() ?? materials, onCommit, options));
    dialog.querySelector('#price-apply').addEventListener('click', () => {
        try {
            const current = options.getMaterials?.() ?? materials, priorIds = new Set(current.map(material => material.id));
            const next = applyPriceRows(current, candidates, [...selection.values()]);
            const targets = new Set([...selection.values()].map(row => row.targetId).filter(Boolean));
            const updatedIds = next.filter(material => targets.has(material.id) || !priorIds.has(material.id)).map(material => material.id);
            onCommit(next, updatedIds);
            dialog.close();
            toast(`已更新 ${selection.size} 条材料来源报价`);
        }
        catch (error) {
            const status = dialog.querySelector('#price-preview-status');
            status.textContent = error.message;
            status.classList.add('error');
        }
    });
    draw();
}
function mapWebsite(materials, onCommit, tables, context, options = {}) {
    const columnOptions = (sample, selected, optional = false) => `${optional ? '<option value="-1">不指定</option>' : ''}${sample[0].map((label, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>第 ${i + 1} 列：${escape(String(label).slice(0, 20))}</option>`).join('')}`;
    const dialog = openDialog('选择网页表格与列', `${style}<p class="help">读取全部数据前，先选择真实表格，指定名称、单位和价格所在的列。</p><label><span class="price-field-label">网页中的表格</span><select id="price-web-table">${tables.map(table => `<option value="${table.index}">表格 ${table.index + 1} · ${table.rows} 行 / ${table.cols} 列</option>`).join('')}</select></label><div id="price-web-mapping"></div><p id="price-web-status" class="price-state spaced" role="status"></p>`, { wide: true, footer: '<button id="price-web-back" class="button subtle" type="button">返回</button><button id="price-web-preview" class="button primary" type="button">预览全部报价</button>' });
    const draw = () => {
        const table = tables.find(table => String(table.index) === value(dialog, '#price-web-table')), sample = table.sample;
        const guessed = (aliases, fallback) => { const index = sample[0].findIndex(label => aliases.includes(String(label).trim())); return index >= 0 ? index : fallback; };
        dialog.querySelector('#price-web-mapping').innerHTML = `<div class="price-map-sample"><table>${sample.slice(0, 6).map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</table></div><div class="field-grid">${[
            ['name', '材料名称', guessed(['名称', '材料名称', '品名'], 0), false], ['unit', '计价单位', guessed(['单位', '计价单位'], 1), false], ['price', '单价', guessed(['价格', '单价', '信息价'], 2), false], ['spec', '规格', guessed(['规格', '规格型号'], -1), true], ['date', '报价日期', guessed(['日期', '价格日期'], -1), true], ['supplier', '供应商', guessed(['厂家', '供应商'], -1), true], ['region', '地区', guessed(['地区', '城市', '省市'], -1), true], ['source', '数据来源', guessed(['来源', '数据来源'], -1), true],
        ].map(([field, label, index, optional]) => `<label><span class="price-field-label">${label}</span><select data-web-column="${field}">${columnOptions(sample, Number(index), Boolean(optional))}</select></label>`).join('')}</div><label class="checkbox-label"><input id="price-web-header" type="checkbox" checked>第一行是表头</label>`;
    };
    dialog.querySelector('#price-web-table').addEventListener('change', draw);
    draw();
    dialog.querySelector('#price-web-back').addEventListener('click', () => openPriceManager(options.getMaterials?.() ?? materials, onCommit, options));
    dialog.querySelector('#price-web-preview').addEventListener('click', async () => {
        const button = dialog.querySelector('#price-web-preview'), status = dialog.querySelector('#price-web-status');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
        button.disabled = true;
        status.textContent = '正在读取全部报价行…';
        try {
            const mapping = Object.fromEntries([...dialog.querySelectorAll('[data-web-column]')].map(input => [input.dataset.webColumn, input.value]));
            const result = await request('/api/scrape/rows/preview', { url: context.sourceUrl, table_index: Number(value(dialog, '#price-web-table')), mapping, region: context.region, source: context.source, has_header: dialog.querySelector('#price-web-header').checked }, controller.signal);
            if (!result.rows.length)
                throw new Error('没有解析到有效报价，请检查列选择');
            const refresh = normalizeMaterialRefreshSource({ kind: 'web', url: context.sourceUrl, tableIndex: Number(value(dialog, '#price-web-table')),
                mapping: Object.fromEntries(Object.entries(mapping).map(([key, index]) => [key, Number(index)]).filter(([, index]) => Number(index) >= 0)), hasHeader: dialog.querySelector('#price-web-header').checked });
            previewPrices(options.getMaterials?.() ?? materials, onCommit, result.rows, { ...context, refresh }, '网页报价预览', [], options);
        }
        catch (error) {
            status.textContent = '读取失败：' + (error.name === 'AbortError' ? '请求超时' : error.message);
            status.classList.add('error');
        }
        finally {
            clearTimeout(timer);
            button.disabled = false;
        }
    });
}
//# sourceMappingURL=price-manager.js.map