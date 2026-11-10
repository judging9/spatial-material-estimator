/* 材料报价系统 - 前端 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v) => num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (v) => num(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const S = {
  view: 'quotes',
  quoteId: null,
  quote: null,
  region: '全国',
  materials: [],
  stats: null,
  lastPreview: null,
};

/* ------------------------------------------------------------------ 基础 */

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.raw !== undefined) {
    init.headers['Content-Type'] = 'application/octet-stream';
    init.body = opts.raw;
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    throw new Error('无法连接本地服务，请确认 app.py 仍在运行');
  }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('服务器返回异常（HTTP ' + r.status + '）'); }
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j.data;
}

function openModal({ title, body, footer, wide }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-h"><b>${esc(title)}</b><span class="x">✕</span></div>
    <div class="modal-b">${body}</div>
    ${footer ? `<div class="modal-f">${footer}</div>` : ''}
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('.x', root).onclick = close;
  $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
  return { root, close, el: $('.modal', root), body: $('.modal-b', root), footer: $('.modal-f', root) };
}

/* ------------------------------------------------------------------ 路由 */

const VIEWS = { quotes: viewQuotes, materials: viewMaterials, prices: viewPrices, sources: viewSources, help: viewHelp };

async function go(view, opts = {}) {
  S.view = view;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view !== 'quotes') S.quoteId = null;
  try {
    await VIEWS[view](opts);
  } catch (e) {
    $('#main').innerHTML = `<div class="card"><div class="empty"><div class="big">!</div>${esc(e.message)}</div></div>`;
  }
  refreshStats();
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    S.stats = s;
    $('#stats').innerHTML = `材料 <b>${s.materials}</b> · 价格 <b>${s.prices}</b><br>报价单 <b>${s.quotes}</b>`;
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ 报价单列表 */

async function viewQuotes() {
  if (S.quoteId !== null) return renderEditor();
  const list = await api('/api/quotes');
  const cards = list.map((q) => `
    <div class="qcard" data-id="${q.id}">
      <div class="t"><span>${esc(q.title)}</span><span class="tag">${esc(q.quote_date)}</span></div>
      <div class="c">${esc(q.client || '未填客户')} · ${esc(q.region || '全国')} · ${q.items.length} 项材料</div>
      <div class="meta">
        <span class="amt">¥ ${fmt(q.total)}</span>
        <span class="small muted">材料 ${fmt(q.material_subtotal)}｜税 ${fmt(q.tax)}</span>
      </div>
    </div>`).join('');

  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1>报价单</h1><div class="sub">按最新市场材料价自动套价，人工/运费/损耗/税金一次性算清</div></div>
      <button class="btn primary" id="btn-new">＋ 新建报价单</button>
    </div>
    ${list.length ? `<div class="qlist">${cards}</div>` : `
      <div class="card"><div class="empty"><div class="big">▤</div>
        还没有报价单。点右上角「新建报价单」，或先到「价格更新」抓一批最新材料价。</div></div>`}`;

  $('#btn-new').onclick = newQuote;
  $$('.qcard').forEach((el) => { el.onclick = () => openQuote(+el.dataset.id); });
}

function newQuote() {
  S.quoteId = 0;
  S.quote = {
    id: null, title: '材料报价单', client: '', region: S.region || '全国',
    quote_date: today(), labor: 0, freight: 0, other_fee: 0, tax_rate: 9, note: '', items: [],
  };
  renderEditor();
}

async function openQuote(id) {
  S.quote = await api('/api/quotes/' + id);
  S.quoteId = id;
  renderEditor();
}

async function loadMaterials(region) {
  S.materials = await api('/api/materials?region=' + encodeURIComponent(region || '全国'));
}

/* ------------------------------------------------------------------ 报价单编辑 */

function renderEditor() {
  const q = S.quote;
  $('#main').innerHTML = `
    <div class="toolbar no-print">
      <button class="btn" id="btn-back">← 返回列表</button>
      <div class="spacer"></div>
      <button class="btn" id="btn-del">删除</button>
      <button class="btn" id="btn-print">打印 / PDF</button>
      <button class="btn" id="btn-export">导出 Excel</button>
      <button class="btn primary" id="btn-save">保存</button>
    </div>
    <div class="doc">
      <div class="doc-head">
        <input class="doc-title" id="q-title" value="${esc(q.title)}" placeholder="报价单标题">
      </div>
      <div class="meta-grid">
        <div class="field"><label class="f">客户 / 项目</label><input type="text" id="q-client" value="${esc(q.client)}" placeholder="甲方名称"></div>
        <div class="field"><label class="f">价格地区</label><input type="text" id="q-region" value="${esc(q.region)}" list="region-list" placeholder="全国 / 广州市">
          <datalist id="region-list"></datalist></div>
        <div class="field"><label class="f">报价日期</label><input type="date" id="q-date" value="${esc(q.quote_date)}"></div>
        <div class="field"><label class="f">税率（%）</label><input type="number" step="0.1" id="q-tax" value="${num(q.tax_rate)}"></div>
      </div>

      <table class="items">
        <thead><tr>
          <th style="width:34px">#</th><th>材料名称</th><th style="width:170px">规格型号</th>
          <th style="width:64px">单位</th><th style="width:96px">数量</th><th style="width:110px">单价(元)</th>
          <th style="width:80px">损耗%</th><th style="width:120px" class="num">小计(元)</th><th style="width:32px"></th>
        </tr></thead>
        <tbody id="items-body"></tbody>
      </table>

      <div class="add-row no-print">
        <input type="text" id="mat-search" placeholder="输入材料名搜索（如 水泥 / 螺纹钢），回车添加" autocomplete="off">
        <button class="btn sm" id="btn-blank">加空行</button>
        <div class="suggest" id="suggest"></div>
      </div>

      <div class="totals">
        <table>
          <tr><td class="lbl">材料小计</td><td class="val" id="t-sub">0.00</td></tr>
          <tr><td class="lbl">人工费</td><td class="val"><input type="number" step="0.01" id="q-labor" value="${num(q.labor)}" style="text-align:right;height:28px"></td></tr>
          <tr><td class="lbl">运费</td><td class="val"><input type="number" step="0.01" id="q-freight" value="${num(q.freight)}" style="text-align:right;height:28px"></td></tr>
          <tr><td class="lbl">其他费用</td><td class="val"><input type="number" step="0.01" id="q-other" value="${num(q.other_fee)}" style="text-align:right;height:28px"></td></tr>
          <tr><td class="lbl">不含税合计</td><td class="val" id="t-before">0.00</td></tr>
          <tr><td class="lbl">税金</td><td class="val" id="t-tax">0.00</td></tr>
          <tr class="grand"><td class="lbl">合计（含税）</td><td class="val" id="t-total">0.00</td></tr>
        </table>
      </div>

      <div style="margin-top:14px">
        <label class="f">备注（付款方式、交货期、价格有效期等）</label>
        <textarea id="q-note" rows="2" placeholder="例如：以上价格含税含运，有效期 7 天。">${esc(q.note)}</textarea>
      </div>
    </div>`;

  renderItems();
  bindEditor();

  // 地区候选
  api('/api/prices/recent').then((rows) => {
    const regions = Array.from(new Set(rows.map((r) => r.region))).slice(0, 40);
    const dl = $('#region-list');
    if (dl) dl.innerHTML = regions.map((r) => `<option value="${esc(r)}">`).join('');
  }).catch(() => {});
}

function renderItems() {
  const tbody = $('#items-body');
  if (!tbody) return;
  const q = S.quote;
  if (!q.items.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty" style="padding:22px">还没有材料。在下面搜索添加，或用「加空行」。</div></td></tr>`;
  } else {
    tbody.innerHTML = q.items.map((it, i) => `
      <tr data-i="${i}">
        <td class="idx">${i + 1}</td>
        <td><input type="text" class="i-name" value="${esc(it.name)}"></td>
        <td><input type="text" class="i-spec" value="${esc(it.spec)}"></td>
        <td><input type="text" class="i-unit" value="${esc(it.unit)}"></td>
        <td><input type="number" step="0.001" class="i-qty num" value="${num(it.qty)}"></td>
        <td><input type="number" step="0.01" class="i-price num" value="${num(it.unit_price)}"></td>
        <td><input type="number" step="0.1" class="i-loss num" value="${num(it.loss_rate)}"></td>
        <td class="num line">${fmt(lineTotal(it))}</td>
        <td class="del no-print">✕</td>
      </tr>`).join('');
  }
  updateTotals();
}

function lineTotal(it) {
  return num(it.qty) * num(it.unit_price) * (1 + num(it.loss_rate) / 100);
}

function updateTotals() {
  const q = S.quote;
  let sub = 0;
  q.items.forEach((it, i) => {
    const lt = lineTotal(it);
    sub += lt;
    const cell = $(`#items-body tr[data-i="${i}"] .line`);
    if (cell) cell.textContent = fmt(lt);
  });
  const before = sub + num(q.labor) + num(q.freight) + num(q.other_fee);
  const tax = before * num(q.tax_rate) / 100;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = fmt(v); };
  set('#t-sub', sub); set('#t-before', before); set('#t-tax', tax); set('#t-total', before + tax);
  q.material_subtotal = sub; q.before_tax = before; q.tax = tax; q.total = before + tax;
  return { sub, before, tax, total: before + tax };
}

function bindEditor() {
  $('#btn-back').onclick = () => { S.quoteId = null; S.quote = null; go('quotes'); };
  $('#btn-save').onclick = () => saveQuote();
  $('#btn-print').onclick = () => window.print();
  $('#btn-export').onclick = exportQuote;
  $('#btn-del').onclick = async () => {
    if (!S.quoteId) { S.quoteId = null; return go('quotes'); }
    if (!confirm('确定删除这张报价单？')) return;
    await api('/api/quotes/' + S.quoteId, { method: 'DELETE' });
    toast('已删除');
    S.quoteId = null; go('quotes');
  };

  const q = S.quote;
  const bind = (sel, key, cast) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      q[key] = cast ? cast(el.value) : el.value;
      if (['labor', 'freight', 'other_fee', 'tax_rate'].includes(key)) updateTotals();
    });
  };
  bind('#q-title', 'title');
  bind('#q-client', 'client');
  bind('#q-date', 'quote_date');
  bind('#q-tax', 'tax_rate', Number);
  bind('#q-labor', 'labor', Number);
  bind('#q-freight', 'freight', Number);
  bind('#q-other', 'other_fee', Number);
  bind('#q-note', 'note');

  const regionEl = $('#q-region');
  regionEl.addEventListener('change', async () => {
    q.region = regionEl.value.trim() || '全国';
    S.region = q.region;
    try { await loadMaterials(q.region); toast('已切换到 ' + q.region + ' 的价格'); } catch (e) { /* ignore */ }
  });

  const tbody = $('#items-body');
  tbody.addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i;
    const it = q.items[i];
    const cls = e.target.className;
    if (cls.includes('i-name')) it.name = e.target.value;
    if (cls.includes('i-spec')) it.spec = e.target.value;
    if (cls.includes('i-unit')) it.unit = e.target.value;
    if (cls.includes('i-qty')) it.qty = num(e.target.value);
    if (cls.includes('i-price')) it.unit_price = num(e.target.value);
    if (cls.includes('i-loss')) it.loss_rate = num(e.target.value);
    updateTotals();
  });
  tbody.addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    const tr = e.target.closest('tr[data-i]');
    S.quote.items.splice(+tr.dataset.i, 1);
    renderItems();
  });

  // 材料搜索
  const inp = $('#mat-search');
  const box = $('#suggest');
  let active = -1;

  const showSug = () => {
    const kw = inp.value.trim();
    if (!kw) { box.style.display = 'none'; return; }
    const hits = S.materials.filter((m) => (m.name + m.spec + m.category).includes(kw)).slice(0, 9);
    if (!hits.length) { box.innerHTML = `<div class="muted">没有匹配的材料，回车可加为空行</div>`; box.style.display = 'block'; return; }
    box.innerHTML = hits.map((m, i) => `
      <div data-i="${i}" data-id="${m.id}" class="${i === active ? 'on' : ''}">
        <span>${esc(m.name)} <span class="muted small">${esc(m.spec)}</span></span>
        <span class="p">${m.price == null ? '无价格' : '¥' + fmt(m.price) + '/' + esc(m.unit)}</span>
      </div>`).join('');
    box.style.display = 'block';
    box._hits = hits;
  };

  inp.addEventListener('input', () => { active = -1; showSug(); });
  inp.addEventListener('focus', showSug);
  inp.addEventListener('keydown', (e) => {
    const hits = box._hits || [];
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, hits.length - 1); showSug(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); showSug(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && hits[active]) addMaterialItem(hits[active]);
      else if (hits.length === 1) addMaterialItem(hits[0]);
      else addBlankItem(inp.value.trim());
      inp.value = ''; box.style.display = 'none'; active = -1;
    } else if (e.key === 'Escape') { box.style.display = 'none'; }
  });
  box.addEventListener('mousedown', (e) => {
    const d = e.target.closest('div[data-id]');
    if (!d) return;
    const m = (box._hits || []).find((x) => x.id === +d.dataset.id);
    if (m) addMaterialItem(m);
    inp.value = ''; box.style.display = 'none';
  });
  $('#btn-blank').onclick = () => { addBlankItem(''); inp.focus(); };
}

function addMaterialItem(m) {
  S.quote.items.push({
    material_id: m.id, name: m.name, spec: m.spec || '', unit: m.unit || '',
    qty: 1, unit_price: m.price == null ? 0 : m.price, loss_rate: 0,
  });
  renderItems();
  const rows = $$('#items-body tr[data-i]');
  const last = rows[rows.length - 1];
  if (last) { const q = $('.i-qty', last); if (q) { q.focus(); q.select(); } }
}

function addBlankItem(name) {
  S.quote.items.push({ material_id: null, name: name || '', spec: '', unit: '', qty: 1, unit_price: 0, loss_rate: 0 });
  renderItems();
}

async function saveQuote(silent) {
  const q = S.quote;
  const payload = {
    id: S.quoteId || null, title: q.title, client: q.client, region: q.region,
    quote_date: q.quote_date, labor: q.labor, freight: q.freight, other_fee: q.other_fee,
    tax_rate: q.tax_rate, note: q.note,
    items: q.items.map((it) => ({
      material_id: it.material_id, name: it.name, spec: it.spec, unit: it.unit,
      qty: it.qty, unit_price: it.unit_price, loss_rate: it.loss_rate,
    })),
  };
  const saved = await api('/api/quotes', { method: 'POST', body: payload });
  S.quoteId = saved.id;
  S.quote = saved;
  if (!silent) toast('已保存（合计 ¥' + fmt(saved.total) + '）');
  refreshStats();
  return saved;
}

async function exportQuote() {
  try {
    if (!S.quoteId) await saveQuote(true);
    window.location.href = '/api/quotes/' + S.quoteId + '/export.xlsx';
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ 材料库 */

async function viewMaterials() {
  const list = await api('/api/materials?region=' + encodeURIComponent(S.region));
  S.materials = list;
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1>材料库</h1><div class="sub">共 ${list.length} 种材料 · 当前价地区：<b>${esc(S.region)}</b></div></div>
      <div class="row">
        <button class="btn" id="btn-region">切换地区</button>
        <button class="btn primary" id="btn-new-mat">＋ 新增材料</button>
      </div>
    </div>
    <div class="card" style="padding:12px 16px">
      <div class="row">
        <input type="text" id="mat-kw" placeholder="搜索名称 / 规格 / 分类" style="max-width:340px">
        <span class="spacer"></span>
        <span class="muted small">价格为该地区最新一条记录，无地区价时回退到全国价</span>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-top:14px">
      <table>
        <thead><tr>
          <th>材料名称</th><th>规格型号</th><th style="width:70px">单位</th><th style="width:90px">分类</th>
          <th style="width:110px" class="num">当前价</th><th style="width:90px">地区</th><th style="width:100px">价格日期</th>
          <th style="width:150px">来源</th><th style="width:190px"></th>
        </tr></thead>
        <tbody id="mat-body"></tbody>
      </table>
    </div>`;

  const render = (kw) => {
    const rows = list.filter((m) => !kw || (m.name + m.spec + m.category).includes(kw));
    $('#mat-body').innerHTML = rows.map((m) => `
      <tr>
        <td><b>${esc(m.name)}</b></td>
        <td class="muted">${esc(m.spec)}</td>
        <td>${esc(m.unit)}</td>
        <td><span class="tag">${esc(m.category || '未分类')}</span></td>
        <td class="num">${m.price == null ? '<span class="muted">—</span>' : '¥ ' + fmt(m.price)}</td>
        <td class="small muted">${esc(m.price_region || '')}</td>
        <td class="small muted">${esc(m.price_date || '')}</td>
        <td class="small muted" title="${esc(m.price_source)}">${esc((m.price_source || '').slice(0, 16))}</td>
        <td class="no-print">
          <button class="btn sm ghost" data-act="price" data-id="${m.id}">改价</button>
          <button class="btn sm ghost" data-act="hist" data-id="${m.id}">历史</button>
          <button class="btn sm ghost" data-act="edit" data-id="${m.id}">编辑</button>
          <button class="btn sm ghost" data-act="drop" data-id="${m.id}" style="color:#d93025">删除</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="9"><div class="empty">没有匹配的材料</div></td></tr>`;
  };
  render('');

  $('#mat-kw').addEventListener('input', (e) => render(e.target.value.trim()));
  $('#btn-new-mat').onclick = () => materialForm();
  $('#btn-region').onclick = async () => {
    const r = prompt('输入地区（如 广州市 / 全国）：', S.region);
    if (!r) return;
    S.region = r.trim();
    go('materials');
  };
  $('#mat-body').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = +b.dataset.id;
    const m = list.find((x) => x.id === id);
    if (b.dataset.act === 'price') priceForm(m);
    if (b.dataset.act === 'hist') historyModal(m);
    if (b.dataset.act === 'edit') materialForm(m);
    if (b.dataset.act === 'drop') {
      if (!confirm(`删除材料「${m.name} ${m.spec}」及其全部价格记录？`)) return;
      await api('/api/materials/' + id, { method: 'DELETE' });
      toast('已删除'); go('materials');
    }
  });
}

function materialForm(m) {
  m = m || { name: '', spec: '', unit: '', category: '', note: '' };
  const mo = openModal({
    title: m.id ? '编辑材料' : '新增材料',
    body: `
      <div class="grid grid-2">
        <div><label class="f">材料名称 *</label><input type="text" id="m-name" value="${esc(m.name)}"></div>
        <div><label class="f">规格型号</label><input type="text" id="m-spec" value="${esc(m.spec)}"></div>
        <div><label class="f">单位</label><input type="text" id="m-unit" value="${esc(m.unit)}" placeholder="吨 / 立方米 / 张"></div>
        <div><label class="f">分类</label><input type="text" id="m-cat" value="${esc(m.category)}" placeholder="钢材 / 水泥 / 砂石"></div>
      </div>
      <div style="margin-top:12px"><label class="f">备注</label><input type="text" id="m-note" value="${esc(m.note)}"></div>`,
    footer: `<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">保存</button>`,
  });
  $('#m-cancel', mo.root).onclick = mo.close;
  $('#m-ok', mo.root).onclick = async () => {
    try {
      await api('/api/materials', {
        method: 'POST',
        body: {
          id: m.id || null, name: $('#m-name', mo.root).value, spec: $('#m-spec', mo.root).value,
          unit: $('#m-unit', mo.root).value, category: $('#m-cat', mo.root).value, note: $('#m-note', mo.root).value,
        },
      });
      mo.close(); toast('已保存'); go('materials');
    } catch (e) { toast(e.message, true); }
  };
}

function priceForm(m) {
  const mo = openModal({
    title: '录入价格 · ' + m.name + (m.spec ? ' ' + m.spec : ''),
    body: `
      <div class="grid grid-2">
        <div><label class="f">价格（元/${esc(m.unit || '单位')}）*</label><input type="number" step="0.01" id="p-price" value="${m.price == null ? '' : m.price}"></div>
        <div><label class="f">地区</label><input type="text" id="p-region" value="${esc(m.price_region || S.region)}"></div>
        <div><label class="f">价格日期</label><input type="date" id="p-date" value="${esc(m.price_date || today())}"></div>
        <div><label class="f">来源</label><input type="text" id="p-source" value="手工录入"></div>
      </div>
      <div style="margin-top:12px"><label class="f">供应商 / 备注</label><input type="text" id="p-supplier" placeholder="可选"></div>`,
    footer: `<button class="btn" id="p-cancel">取消</button><button class="btn primary" id="p-ok">保存价格</button>`,
  });
  $('#p-cancel', mo.root).onclick = mo.close;
  $('#p-ok', mo.root).onclick = async () => {
    const price = num($('#p-price', mo.root).value);
    if (!price) return toast('请填写价格', true);
    try {
      await api('/api/prices', {
        method: 'POST',
        body: {
          material_id: m.id, price,
          region: $('#p-region', mo.root).value || '全国',
          price_date: $('#p-date', mo.root).value || today(),
          source: $('#p-source', mo.root).value || '手工录入',
          supplier: $('#p-supplier', mo.root).value,
        },
      });
      mo.close(); toast('价格已保存'); go('materials');
    } catch (e) { toast(e.message, true); }
  };
}

async function historyModal(m) {
  const rows = await api('/api/materials/' + m.id + '/prices');
  const body = rows.length ? `
    <div style="margin-bottom:12px" class="muted small">单位：元/${esc(m.unit)} · 共 ${rows.length} 条</div>
    ${sparkline(rows)}
    <table style="margin-top:12px"><thead><tr><th>价格日期</th><th>地区</th><th class="num">单价</th><th>来源</th><th>供应商</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.price_date)}</td><td>${esc(r.region)}</td>
        <td class="num">¥ ${fmt(r.price)}</td><td class="small muted">${esc(r.source)}</td><td class="small muted">${esc(r.supplier)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">还没有价格记录</div>`;
  openModal({ title: '价格历史 · ' + m.name, body, wide: true });
}

function sparkline(rows) {
  const data = rows.slice().reverse();
  if (data.length < 2) return '';
  const vals = data.map((r) => num(r.price));
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 640, h = 90, pad = 6;
  const x = (i) => pad + (w - pad * 2) * (i / (data.length - 1));
  const y = (v) => max === min ? h / 2 : pad + (h - pad * 2) * (1 - (v - min) / (max - min));
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${pts} ${w - pad},${h - pad}`;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:90px;background:#fbfcfe;border:1px solid #eef1f5;border-radius:8px">
    <polygon points="${area}" fill="rgba(11,107,203,.08)"></polygon>
    <polyline points="${pts}" fill="none" stroke="#0b6bcb" stroke-width="1.6"></polyline>
  </svg>`;
}

/* ------------------------------------------------------------------ 价格更新 */

async function viewPrices() {
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1>价格更新</h1><div class="sub">先把价格拿进来，报价单里就能按最新价自动套价</div></div>
    </div>

    <div class="card" id="auto-card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="flex:1">
          <h2 style="margin:0 0 6px">自动更新 <span class="tag" id="auto-tag">…</span></h2>
          <div class="hint" id="auto-msg">正在读取状态…</div>
        </div>
        <div class="row" style="gap:10px;align-items:center;white-space:nowrap">
          <button class="btn" id="btn-auto-check">立即检查</button>
          <label class="row" style="gap:6px;align-items:center;cursor:pointer">
            <input type="checkbox" id="auto-toggle"> 启用
          </label>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h2>① 国家统计局 · 每旬自动抓取 <span class="tag ok">推荐</span></h2>
        <div class="hint">
          数据源：<b>流通领域重要生产资料市场价格</b>（全国均价，每月 3 次）。含螺纹钢、线材、中板、热卷、无缝钢管、角钢、铝锭、水泥、浮法玻璃等。
          点下面的按钮，程序会自动找到最新一期并解析，导入前可核对。
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="btn-nbs">抓取最新一期</button>
          <span class="muted small" id="nbs-msg"></span>
        </div>
      </div>

      <div class="card">
        <h2>② 导入信息价（Excel / CSV）</h2>
        <div class="hint">
          省市造价站每月发布的《工程造价信息》多为 Excel/PDF。下载后整理成模板表头即可导入；
          没有的地区价会用全国价兜底。
        </div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn primary" id="btn-pick">选择文件</button>
          <a class="btn" href="/api/template.xlsx">下载模板</a>
          <input type="file" id="file" accept=".xlsx,.xls,.csv,.txt" style="display:none">
          <span class="muted small" id="imp-msg"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>③ 直接粘贴</h2>
      <div class="hint">每行一条，列之间用 Tab 或逗号分隔：<b>名称, 规格, 单位, 价格, 地区(可选), 日期(可选)</b>。从 Excel 复制单元格直接粘贴即可。</div>
      <textarea id="paste" rows="5" style="margin-top:10px" placeholder="普通硅酸盐水泥, P.O 42.5 散装, 吨, 415, 广州市, 2026-10-31
螺纹钢, HRB400E Φ20, 吨, 3520, 广州市, 2026-10-31"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="btn-paste">解析并预览</button>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">最近价格记录</h2>
        <span class="muted small">最新 200 条</span>
      </div>
      <table><thead><tr>
        <th>材料</th><th>规格</th><th style="width:64px">单位</th><th style="width:100px">地区</th>
        <th style="width:110px" class="num">价格</th><th style="width:100px">日期</th><th>来源</th>
      </tr></thead><tbody id="recent"></tbody></table>
    </div>`;

  const recent = await api('/api/prices/recent');  $('#recent').innerHTML = recent.map((r) => `
    <tr><td>${esc(r.name)}</td><td class="muted small">${esc(r.spec)}</td><td>${esc(r.unit)}</td>
    <td>${esc(r.region)}</td><td class="num">¥ ${fmt(r.price)}</td><td class="small">${esc(r.price_date)}</td>
    <td class="small muted">${esc(r.source)}</td></tr>`).join('')
    || `<tr><td colspan="7"><div class="empty">还没有价格记录</div></td></tr>`;

  // ---- 自动更新状态
  const renderAuto = (s) => {
    $('#auto-toggle').checked = s.enabled;
    const tag = $('#auto-tag');
    tag.className = 'tag' + (s.enabled ? ' ok' : '');
    tag.textContent = s.enabled ? '已开启' : '已关闭';
    const parts = [];
    if (s.last_period) parts.push('当前数据：' + s.last_period);
    if (s.last_update) parts.push('上次更新：' + s.last_update);
    if (s.last_check) parts.push('上次检查：' + s.last_check);
    const head = s.last_result ? s.last_result + ' · ' : '';
    $('#auto-msg').textContent = head + (parts.join(' · ')
      || `开启后每 ${s.interval_hours} 小时自动检查一次（软件需保持运行）`);
  };
  try { renderAuto(await api('/api/auto')); } catch (e) { /* 忽略 */ }

  $('#auto-toggle').onchange = async (e) => {
    try {
      const s = await api('/api/auto', { method: 'POST', body: { enabled: e.target.checked } });
      renderAuto(s);
      toast(s.enabled ? '已开启自动更新' : '已关闭自动更新');
    } catch (err) { toast('设置失败：' + err.message, true); }
  };

  $('#btn-auto-check').onclick = async () => {
    const b = $('#btn-auto-check');
    b.disabled = true;
    $('#auto-msg').textContent = '正在检查统计局是否发布新一期…';
    try {
      const r = await api('/api/auto/check', { method: 'POST', body: {} });
      toast(r.message || '检查完成');
      if (r.status === 'updated') { viewPrices(); return; }
      renderAuto(await api('/api/auto'));
    } catch (err) {
      $('#auto-msg').textContent = '检查失败：' + err.message;
      toast('检查失败：' + err.message, true);
    } finally { b.disabled = false; }
  };

  $('#btn-nbs').onclick = async () => {
    const btn = $('#btn-nbs');
    btn.disabled = true; $('#nbs-msg').textContent = '正在抓取…';
    try {
      const res = await api('/api/scrape/nbs/preview', { method: 'POST', body: {} });
      $('#nbs-msg').textContent = res.period || '';
      if (!res.rows.length) throw new Error('没有解析到建材类价格');
      previewRows(`统计局 ${res.period}（${res.price_date}）`, res.rows, async (rows) => {
        const out = await api('/api/scrape/apply', { method: 'POST', body: { rows } });
        toast(`导入完成：${out.prices} 条价格` + (out.created_materials ? `，新建 ${out.created_materials} 种材料` : ''));
        go('prices');
      });
    } catch (e) { toast(e.message, true); $('#nbs-msg').textContent = ''; }
    btn.disabled = false;
  };

  $('#btn-pick').onclick = () => $('#file').click();
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#imp-msg').textContent = '解析中…';
    try {
      const buf = await f.arrayBuffer();
      const res = await api('/api/import/preview?name=' + encodeURIComponent(f.name), { raw: buf, method: 'POST' });
      $('#imp-msg').textContent = `识别 ${res.rows.length} 行`;
      previewRows('导入预览 · ' + f.name, res.rows, async (rows) => {
        const out = await api('/api/import/apply', { method: 'POST', body: { rows } });
        toast(`导入完成：${out.prices} 条价格` + (out.created_materials ? `，新建 ${out.created_materials} 种材料` : ''));
        go('prices');
      });
    } catch (err) { toast(err.message, true); $('#imp-msg').textContent = ''; }
    e.target.value = '';
  };

  $('#btn-paste').onclick = () => {
    const lines = $('#paste').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return toast('先粘贴几行数据', true);
    const rows = [];
    for (const line of lines) {
      const p = line.split(/\t|,|，|\s{2,}/).map((s) => s.trim()).filter((s) => s !== '');
      if (!p.length || /名称|材料/.test(p[0]) && p.length > 2 && isNaN(parseFloat(p[3]))) continue;
      if (p.length < 2) continue;
      const price = parseFloat(String(p[3] != null ? p[3] : p[1]).replace(/[^\d.]/g, ''));
      if (isNaN(price)) continue;
      rows.push({
        name: p[0], spec: p[1] || '', unit: p[2] || '', price,
        region: p[4] || S.region, price_date: p[5] || today(), source: '粘贴导入',
      });
    }
    if (!rows.length) return toast('没有解析出有效数据，检查格式：名称,规格,单位,价格', true);
    previewRows('粘贴导入预览', rows, async (sel) => {
      const out = await api('/api/import/apply', { method: 'POST', body: { rows: sel } });
      toast(`导入完成：${out.prices} 条价格`);
      go('prices');
    });
  };
}

function previewRows(title, rows, onApply) {
  const body = `
    <div class="row" style="margin-bottom:10px">
      <span class="muted small">共 ${rows.length} 条，已全选。取消勾选不需要的行。</span>
      <span class="spacer"></span>
      <button class="btn sm" id="sel-all">全选</button>
      <button class="btn sm" id="sel-none">全不选</button>
    </div>
    <table><thead><tr><th style="width:34px"></th><th>名称</th><th>规格</th><th style="width:60px">单位</th>
      <th style="width:90px">地区</th><th style="width:100px" class="num">价格</th><th style="width:96px">日期</th><th>来源</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td><input type="checkbox" class="chk" data-i="${i}" checked></td>
        <td>${esc(r.name)}</td><td class="muted small">${esc(r.spec)}</td><td>${esc(r.unit)}</td>
        <td>${esc(r.region)}</td><td class="num">¥ ${fmt(r.price)}</td><td class="small">${esc(r.price_date)}</td>
        <td class="small muted">${esc(r.source)}</td></tr>`).join('')}</tbody></table>`;

  const mo = openModal({
    title, body, wide: true,
    footer: `<button class="btn" id="pv-cancel">取消</button>
             <button class="btn primary" id="pv-ok">导入选中</button>`,
  });
  const picked = () => $$('.chk', mo.root).filter((c) => c.checked).map((c) => rows[+c.dataset.i]);
  const label = () => { $('#pv-ok', mo.root).textContent = `导入选中（${picked().length}）`; };
  $$('.chk', mo.root).forEach((c) => { c.onchange = label; });
  $('#sel-all', mo.root).onclick = () => { $$('.chk', mo.root).forEach((c) => { c.checked = true; }); label(); };
  $('#sel-none', mo.root).onclick = () => { $$('.chk', mo.root).forEach((c) => { c.checked = false; }); label(); };
  $('#pv-cancel', mo.root).onclick = mo.close;
  $('#pv-ok', mo.root).onclick = async () => {
    const sel = picked();
    if (!sel.length) return toast('没有选中任何行', true);
    $('#pv-ok', mo.root).disabled = true;
    try { await onApply(sel); mo.close(); } catch (e) { toast(e.message, true); $('#pv-ok', mo.root).disabled = false; }
  };
  label();
}

/* ------------------------------------------------------------------ 抓取源 */

async function viewSources() {
  const list = await api('/api/sources');
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1>抓取源</h1><div class="sub">把你常看的价格网页存成一条规则，以后一键更新</div></div>
      <button class="btn primary" id="btn-new-src">＋ 新增抓取源</button>
    </div>
    <div class="card">
      <div class="hint">
        适用于<b>公开可访问、价格直接写在 HTML 表格里</b>的页面（政府造价信息网、协会行情页、企业报价页等）。
        中国水泥网、我的钢铁网、造价通等把价格放在会员区，抓不到具体数字，这类请用「导入」或手工录入。
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-top:14px">
      <table><thead><tr><th>名称</th><th>类型</th><th>网址</th><th style="width:100px">地区</th><th style="width:150px">上次运行</th><th style="width:150px"></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><b>${esc(s.name)}</b></td>
        <td><span class="tag ${s.kind === 'nbs' ? 'ok' : ''}">${s.kind === 'nbs' ? '统计局' : '通用表格'}</span></td>
        <td class="small muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.url)}</td>
        <td>${esc(s.region)}</td>
        <td class="small muted">${esc(s.last_run || '从未')}</td>
        <td><button class="btn sm" data-run="${s.id}">立即抓取</button>
            <button class="btn sm ghost" data-del="${s.id}" style="color:#d93025">删除</button></td>
      </tr>`).join('') || `<tr><td colspan="6"><div class="empty">还没有保存的抓取源</div></td></tr>`}</tbody></table>
    </div>`;

  $('#btn-new-src').onclick = sourceForm;
  $$('button[data-run]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '抓取中…';
      try {
        const out = await api('/api/sources/' + b.dataset.run + '/run', { method: 'POST', body: {} });
        toast(`更新 ${out.prices} 条价格` + (out.created_materials ? `，新建 ${out.created_materials} 种材料` : ''));
        go('sources');
      } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = '立即抓取'; }
    };
  });
  $$('button[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这条抓取源？')) return;
      await api('/api/sources/' + b.dataset.del, { method: 'DELETE' });
      go('sources');
    };
  });
}

function sourceForm() {
  const mo = openModal({
    title: '新增抓取源',
    wide: true,
    body: `
      <div class="grid grid-2">
        <div><label class="f">名称</label><input type="text" id="s-name" placeholder="例如：广州造价信息-钢材"></div>
        <div><label class="f">地区（可选）</label><input type="text" id="s-region" value="全国"></div>
      </div>
      <div style="margin-top:12px"><label class="f">页面网址 *</label>
        <div class="row"><input type="text" id="s-url" placeholder="https://…">
        <button class="btn" id="s-parse">解析表格</button></div></div>
      <div id="s-result" style="margin-top:14px"></div>`,
    footer: `<button class="btn" id="s-cancel">取消</button><button class="btn primary" id="s-save" disabled>保存</button>`,
  });
  let chosen = null;
  $('#s-cancel', mo.root).onclick = mo.close;

  $('#s-parse', mo.root).onclick = async () => {
    const url = $('#s-url', mo.root).value.trim();
    if (!url.startsWith('http')) return toast('请填写完整网址', true);
    $('#s-result', mo.root).innerHTML = '<div class="muted small">正在抓取并解析…</div>';
    try {
      const res = await api('/api/scrape/preview', { method: 'POST', body: { url } });
      if (!res.tables.length) throw new Error('页面里没有找到表格');
      $('#s-result', mo.root).innerHTML = `
        <label class="f">选择价格所在的表格（共 ${res.tables.length} 个）</label>
        ${res.tables.map((t) => `<label style="display:block;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:pointer">
          <input type="radio" name="tbl" value="${t.index}" style="width:auto;height:auto;margin-right:6px">
          <b>表 ${t.index + 1}</b> <span class="muted small">${t.rows} 行 × ${t.cols} 列</span>
          <div class="small muted" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${(t.sample[0] || []).map((c) => esc(c)).join(' ｜ ')}</div>
          <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${(t.sample[1] || []).map((c) => esc(c)).join(' ｜ ')}</div>
        </label>`).join('')}
        <div id="s-map"></div>`;
      $$('input[name=tbl]', mo.root).forEach((r) => {
        r.onchange = () => { chosen = res.tables.find((t) => t.index === +r.value); renderMap(); };
      });
    } catch (e) { $('#s-result', mo.root).innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };

  const renderMap = () => {
    const head = chosen.sample[0] || [];
    const opts = (sel) => head.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>第 ${i + 1} 列：${esc(h || '(空)')}</option>`).join('');
    $('#s-map', mo.root).innerHTML = `
      <div class="grid grid-3" style="margin-top:12px">
        <div><label class="f">名称列 *</label><select id="c-name">${opts(0)}</select></div>
        <div><label class="f">价格列 *</label><select id="c-price">${opts(4)}</select></div>
        <div><label class="f">单位列</label><select id="c-unit"><option value="-1">不映射</option>${opts(2)}</select></div>
        <div><label class="f">规格列</label><select id="c-spec"><option value="-1">不映射</option>${opts(1)}</select></div>
        <div><label class="f">日期列</label><select id="c-date"><option value="-1">不映射</option>${opts(-1)}</select></div>
        <div><label class="f">供应商列</label><select id="c-supplier"><option value="-1">不映射</option>${opts(-1)}</select></div>
      </div>
      <div class="hint" style="margin-top:10px">保存后可在「抓取源」里一键更新；也能先点「保存并立即抓取」看效果。</div>`;
    $('#s-save', mo.root).disabled = false;
  };

  $('#s-save', mo.root).onclick = async () => {
    if (!chosen) return toast('先解析并选择一个表格', true);
    const url = $('#s-url', mo.root).value.trim();
    const mapping = {
      table_index: chosen.index,
      name: $('#c-name', mo.root).value,
      price: $('#c-price', mo.root).value,
      unit: $('#c-unit', mo.root).value,
      spec: $('#c-spec', mo.root).value,
      date: $('#c-date', mo.root).value,
      supplier: $('#c-supplier', mo.root).value,
    };
    const src = await api('/api/sources', {
      method: 'POST',
      body: { name: $('#s-name', mo.root).value || url, url, kind: 'table', mapping, region: $('#s-region', mo.root).value || '全国' },
    });
    try {
      const out = await api('/api/scrape/apply', {
        method: 'POST',
        body: { url, table_index: chosen.index, mapping, region: $('#s-region', mo.root).value || '全国', allow_new: true },
      });
      toast(`已保存并抓取 ${out.prices} 条价格`);
    } catch (e) { toast('已保存，但抓取失败：' + e.message, true); }
    mo.close();
    go('sources');
  };
}

/* ------------------------------------------------------------------ 说明 */

function viewHelp() {
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>使用说明</h1><div class="sub">口径、数据来源与常见问题</div></div></div>

    <div class="card">
      <h2>总价怎么算</h2>
      <div class="hint" style="line-height:2">
        行小计 = 数量 × 单价 ×（1 + 损耗率）<br>
        材料小计 = Σ 行小计<br>
        不含税合计 = 材料小计 + 人工费 + 运费 + 其他费用<br>
        税金 = 不含税合计 × 税率<br>
        <b>合计（含税）= 不含税合计 + 税金</b>
      </div>
    </div>

    <div class="card">
      <h2>价格从哪来</h2>
      <table>
        <thead><tr><th style="width:200px">来源</th><th>说明</th><th style="width:120px">地区</th></tr></thead>
        <tbody>
          <tr><td><b>国家统计局</b> 流通领域重要生产资料价格</td>
              <td>每旬（10 天）发布，全国均价，免费可抓；覆盖面为钢材、水泥、玻璃、有色金属等大宗品，适合做概算与趋势判断。</td>
              <td>全国</td></tr>
          <tr><td><b>省市造价信息</b>（Excel/CSV 导入）</td>
              <td>各地定额站每月发布的《工程造价信息》，包含当地砂浆、砌块、管材、线缆等细项，是结算与投标的常用依据。整理成模板表头后导入即可。</td>
              <td>按城市</td></tr>
          <tr><td><b>手工录入 / 供应商报价</b></td>
              <td>临时询价、品牌差异、运输半径导致的价差，直接在材料库里改价，保留历史可追溯。</td>
              <td>任意</td></tr>
        </tbody>
      </table>
      <div class="hint" style="margin-top:12px">
        说明：中国水泥网、我的钢铁网、造价通等站的具体成交价在会员区，程序抓不到；这些站点可以抓“涨跌/行情”，具体数值请走导入或手工录入。
      </div>
    </div>

    <div class="card">
      <h2>口径提醒</h2>
      <div class="hint" style="line-height:2">
        · 报价单选了地区后，优先取该地区最新价，没有则回退到“全国”价。<br>
        · 每条价格都有日期与来源，同一材料同一地区同一日期同一来源重复导入会覆盖，不会重复累加。<br>
        · 报价单里可以手工改单价（比如供应商让价），改完不影响材料库。<br>
        · 税率常见：一般计税 9%（建筑服务）、13%（货物）、小规模 3%，按合同填。
      </div>
    </div>

    <div class="card">
      <h2>数据与备份</h2>
      <div class="hint" style="line-height:2">
        所有数据在 <b>data/app.db</b>（SQLite 单文件）。备份就是复制这个文件；换电脑把它拷过去即可。<br>
        关闭启动窗口即停止服务；重新运行 <b>启动.bat</b>（或 <b>python app.py</b>）再打开。
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ 启动 */

(async function boot() {
  $('#nav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-view]');
    if (a) go(a.dataset.view);
  });
  refreshStats();
  try { await loadMaterials(S.region); } catch (e) { /* 首次可能无数据 */ }
  go('quotes');
})();
