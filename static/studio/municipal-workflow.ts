import type { Project, MunicipalElement } from './types.js';
import { municipalEffectiveWidth, municipalBridgeQuantities } from './lib/municipal-design.js';
import { createMunicipalStarter, type MunicipalStarter } from './lib/municipal-starters.js';
import { escape, icon, measure, openDialog, toast } from './ui.js';
import { findMunicipalCatalogPreset } from './lib/municipal-catalog.js';
import { assetSymbol } from './municipal-authoring.js';

const numberField = (group: string, key: string, label: string, value: number | string, unit: string, disabled = '', min = '0') => `<label class="item-field"><span class="field-label">${label}</span><span class="input-affix"><input data-municipal-option="${group}" data-option-field="${key}" type="number" value="${escape(value)}" min="${min}" step="any" ${disabled}><span>${unit}</span></span></label>`;

export function renderMunicipalOptions(item: MunicipalElement, project?: Project): string {
  const disabled = item.locked ? 'disabled' : '', road = ['road', 'bridge', 'intersection', 'roundabout'].includes(item.kind);
  let html = '';
  const catalog = findMunicipalCatalogPreset(item.catalogId);
  if (catalog) html += `<section class="panel-section"><div class="urban-inspector-asset">${assetSymbol(catalog.symbol)}<strong>${escape(catalog.name)}</strong></div><p class="help">${escape(catalog.description)}</p></section>`;
  if (item.kind === 'facility') html += `<section class="panel-section"><label><span class="field-label">设施朝向 · °</span><input id="municipal-rotation" data-municipal-field="rotation" type="number" step="any" value="${item.rotation ?? 0}" ${disabled}></label><p class="help">旋转和尺寸同步显示在二维、三维；报价按实际件数计算。</p></section>`;
  if (road) {
    const layout = item.roadLayout;
    html += `<section class="panel-section municipal-layout"><div class="section-head"><h3>道路布置</h3><span class="chip">${layout ? layout.lanes + ' 车道' : '自定路宽'}</span></div><label class="item-field"><span class="field-label">车道预设</span><select data-municipal-option="roadLayout" data-option-field="lanes" ${disabled}><option value="0" ${!layout ? 'selected' : ''}>按自定路宽</option>${[2, 4, 6, 8].map(n => `<option value="${n}" ${layout?.lanes === n ? 'selected' : ''}>双向 ${n} 车道 · 每向 ${n / 2} 条</option>`).join('')}</select></label>${layout ? `<div class="field-grid spaced">${numberField('roadLayout', 'laneWidth', '单车道宽', layout.laneWidth, 'cm', disabled, '100')}${numberField('roadLayout', 'medianWidth', '中央分隔宽', layout.medianWidth, 'cm', disabled)}</div>` : ''}<p class="help">${layout ? `路面总宽 ${(municipalEffectiveWidth(item) / 100).toFixed(2)} m，由车道和分隔宽度计算。` : '选预设自动计算路宽；也可直接编辑上方宽度。'}标线用于方案表达，可继续设置实际道路尺寸。</p></section>`;
  }
  if (['intersection', 'roundabout'].includes(item.kind)) {
    const j = item.junction;
    html += `<section class="panel-section"><div class="section-head"><h3>${item.kind === 'roundabout' ? '环岛与支路' : '路口形状'}</h3></div><label class="item-field"><span class="field-label">支路数量</span><select data-municipal-option="junction" data-option-field="arms" ${disabled}>${[3, 4, 8].map(n => `<option value="${n}" ${j?.arms === n ? 'selected' : ''}>${n === 3 ? '三岔' : n === 4 ? '十字' : '八支路'}路口</option>`).join('')}</select></label><div class="field-grid spaced">${numberField('junction', 'armLength', '支路延伸', j?.armLength ?? 1800, 'cm', disabled, '100')}${numberField('junction', 'rotation', '整体旋转', j?.rotation ?? 0, '°', disabled, '-360')}${item.kind === 'roundabout' ? numberField('junction', 'islandRadius', '中心岛半径', j?.islandRadius ?? 600, 'cm', disabled, '100') : ''}</div><p class="help">拖动中心点移动整座路口；调整车道数和支路数后，边界和工程量同步更新。</p></section>`;
  }
  if (road) html += `<section class="panel-section"><div class="section-head"><h3>设施衔接</h3></div><div class="municipal-connection-actions"><button type="button" class="button subtle full" data-action="municipal-kerbs">${icon('plus', 14)}沿两侧生成路缘石</button>${item.kind === 'roundabout' ? '<button type="button" class="button subtle full" data-action="municipal-island-kerbs">沿中心岛生成路缘石</button>' : ''}</div><p class="help">沿实际边界生成，可一次撤销。路口入口保持通行，已覆盖的同规格路缘石不会重复添加；生成后分别填写价格。</p></section>`;
  if (item.kind === 'trafficlight') html += `<section class="panel-section"><div class="section-head"><h3>信号灯</h3></div><label class="item-field"><span class="field-label">显示状态</span><select data-municipal-option="trafficSignal" data-option-field="phase" ${disabled}>${[['red', '红灯'], ['amber', '黄灯'], ['green', '绿灯']].map(([value, name]) => `<option value="${value}" ${(item.trafficSignal?.phase ?? 'red') === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label><div class="spaced">${numberField('trafficSignal', 'rotation', '朝向', item.trafficSignal?.rotation ?? 0, '°', disabled, '-360')}</div><p class="help">灯杆、灯头和当前灯色在二维、三维同步显示。按套填写设备与安装价格。</p></section>`;
  if (item.kind === 'bridge') {
    const b = item.bridgeOptions;
    html += `<section class="panel-section"><div class="section-head"><h3>桥墩与栏杆</h3></div><div class="field-grid">${numberField('bridgeOptions', 'pierSpacing', '最大墩间距', b?.pierSpacing ?? 800, 'cm', disabled, '100')}${numberField('bridgeOptions', 'pierHeight', '桥墩高度', b?.pierHeight ?? 500, 'cm', disabled, '1')}${numberField('bridgeOptions', 'railingHeight', '栏杆高度', b?.railingHeight ?? 120, 'cm', disabled, '1')}</div><p class="help">桥面标高决定通行面高度，桥墩从桥面下沿向下生成。每座墩包含一组墩柱与盖梁；墩和栏杆可在下方独立报价。</p></section>`;
    const quantities = project ? municipalBridgeQuantities(item, project) : { pierCount: null, railingLength: null };
    html += `<section class="panel-section municipal-bridge-pricing"><div class="section-head"><h3>桥梁分项报价</h3></div>${[['pier', '桥墩', '件', quantities.pierCount], ['railing', '两侧栏杆', 'm', quantities.railingLength]].map(([key, name, unit, quantity]) => { const enabled = b?.[key + 'PricingEnabled'] === true; return `<div class="municipal-bridge-price"><label class="field-label"><input type="checkbox" data-municipal-option="bridgeOptions" data-option-field="${key}PricingEnabled" ${enabled ? 'checked' : ''}>${name}独立报价</label><p class="help" data-bridge-quantity="${key}">净量 ${measure(quantity as number, 2)} ${unit}</p>${enabled ? numberField('bridgeOptions', key + 'UnitPrice', '综合单价', b?.[key + 'UnitPrice'] ?? '', '元/' + unit) : '<p class="help">此分项不另收费，请确认已包含在桥面主项综合价中。</p>'}</div>`; }).join('')}</section>`;
  }
  if (item.kind === 'river') html += `<section class="panel-section"><div class="section-head"><h3>河道与地形</h3></div><p class="help">宽度表示水面范围，河深用于河道体积；水面标高与地形使用同一基准。可按此路径生成对应的地形河槽。</p><button class="button subtle full" data-action="carve-municipal-river" ${disabled}>${icon('layers', 14)}按这条河流开槽</button></section>`;
  return html;
}

export function renderMunicipalProgress(project: Project, quote: any): string {
  const rows = quote.municipalElements ?? [], geometryReady = !!project.calibration.metersPerPixel, hasRows = rows.length > 0;
  return `<section class="panel-section municipal-progress"><div class="section-head"><h3>完成工程</h3><button class="text-button" data-action="municipal-check">检查 ${icon('chevronRight', 12)}</button></div><div class="municipal-progress-list"><span class="${geometryReady ? 'complete' : ''}">${icon(geometryReady ? 'check' : 'ruler', 13)}确定真实尺寸</span><span class="${hasRows ? 'complete' : ''}">${icon(hasRows ? 'check' : 'plus', 13)}布置场地设施</span><span class="${hasRows && !quote.pending ? 'complete' : ''}">${icon(hasRows && !quote.pending ? 'check' : 'edit', 13)}填写价格与检查</span></div><button class="button primary full" data-action="municipal-start">${icon('plus', 14)}用预设开始场地</button><p class="help">十字路口、八支路、环岛或跨河桥梁，一次生成后逐项修改。</p></section>`;
}

export function showMunicipalStarter(project: Project, onCreate: (elements: MunicipalElement[]) => void): void {
  const dialog = openDialog('从场地预设开始', `<form id="municipal-starter-form"><div class="municipal-starter-options">${[['crossroads', '十字路口', '四条支路 + 信号灯'], ['eight-way', '八支路交汇', '八条支路 + 信号灯'], ['roundabout', '环岛道路', '中心岛 + 环形路 + 支路'], ['river-bridge', '跨河桥梁', '河流 + 桥梁 + 两侧道路']].map(([value, name, note], i) => `<label><input name="preset" type="radio" value="${value}" ${i === 0 ? 'checked' : ''}><span><strong>${name}</strong><small>${note}</small></span></label>`).join('')}</div><div class="field-grid spaced"><label><span class="field-label">中心 X（m）</span><input name="x" type="number" value="150" min="0" step="any" required></label><label><span class="field-label">中心 Y（m）</span><input name="y" type="number" value="150" min="0" step="any" required></label><label><span class="field-label">支路延伸至（m）</span><input name="length" type="number" value="100" min="25" max="500" step="any" required></label><label><span class="field-label">道路车道数</span><select name="lanes">${[2, 4, 6, 8].map(n => `<option value="${n}" ${n === 4 ? 'selected' : ''}>双向 ${n} 车道</option>`).join('')}</select></label></div><p class="help">这是可编辑的方案起点，全部价格留空，由你填写。不会替换已有设计。尺寸较大时请相应增加中心位置和支路长度。</p><p class="help" id="municipal-starter-error" role="status"></p><button class="button primary full" type="submit">生成可编辑场地</button></form>`, { subtitle: '选一个方案，设置尺寸，随后直接在二维或三维中调整' });
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const form = new FormData(dialog.querySelector('form'));
      const elements = createMunicipalStarter(project, String(form.get('preset')) as MunicipalStarter, { x: Number(form.get('x')), y: Number(form.get('y')), length: Number(form.get('length')), lanes: Number(form.get('lanes')) as 2 | 4 | 6 | 8 });
      onCreate(elements); dialog.close(); toast('场地已生成，选中设施调整尺寸和填写价格，可撤销');
    } catch (error) { dialog.querySelector('#municipal-starter-error').textContent = error.message; }
  });
}

export function showMunicipalCheck(project: Project, quote: any, onLocate: (id: string) => void): void {
  const rows = quote.municipalElements ?? [], issues = rows.flatMap(row => [...(row.pendingReasons ?? []).map(message => ({ id: row.id, name: row.name, message, warning: false })), ...(row.warnings ?? []).map(message => ({ id: row.id, name: row.name, message, warning: true }))]);
  const dialog = openDialog('场地工程检查', `<div class="municipal-check-summary"><strong>${rows.length} 项设施</strong><span>${rows.filter(row => row.pending).length} 项待完善</span><span>${measure(quote.netArea, 1)} m² 净面积</span></div>${!rows.length ? '<p class="help">先用预设开始场地，或绘制第一项设施。</p>' : issues.length ? `<div class="municipal-check-list">${issues.map(issue => `<button data-locate-municipal="${escape(issue.id)}"><span class="chip">${issue.warning ? '计量说明' : '待处理'}</span><span><strong>${escape(issue.name)}</strong><small>${escape(issue.message)}</small></span>${icon('chevronRight', 14)}</button>`).join('')}</div>` : `<div class="municipal-check-ready">${icon('check', 24)}<strong>当前报价参数已完整</strong><p class="help">仍请核对工程范围、单价来源和实际施工做法。</p></div>`}<p class="help">这里汇集当前工程量与报价检查；道路等级、交通组织和桥梁结构仍需按实际设计复核。</p>`, { subtitle: '点击条目定位到对应设施，完成修改后再次检查' });
  dialog.querySelectorAll<HTMLElement>('[data-locate-municipal]').forEach(button => button.addEventListener('click', () => { dialog.close(); onLocate(button.dataset.locateMunicipal); }));
}
