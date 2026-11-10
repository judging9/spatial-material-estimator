import type { Drawing, Project, Material } from './types.js';
import { normalizeWalls, type Wall } from './lib/wall-plan.js';
import { escape, icon, openDialog, toast } from './ui.js';
import { newId } from './lib/materials.js';
import { renderItem } from './panels.js';
import { openingName } from './opening-editor.js';
import { measure, money } from './ui.js';
import { renderWallElevation } from './wall-elevation.js';

/** A local metric drawing, not a raster whose scale needs to be estimated. */
export async function createMetricDrawing(): Promise<Drawing> {
  const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1800;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(resolve, 'image/png'));
  return { id: newId('plan'), name: '二维平面图', type: 'plan', width: 2400, height: 1800, url: canvas.toDataURL('image/png'), blob };
}

export function renderWallInspector(wall: Wall, defaultHeight = 280, project?: Project, materials: Material[] = [], wallQuote?: any): string {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) / 100;
  const angle = (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180 / Math.PI + 360) % 360;
  const height = (wall.height ?? defaultHeight) / 100;
  const items = wall.items || [], openings = (project?.openings || []).filter(o => o.wallId === wall.id);
  const quotes = new Map<string, any>((wallQuote?.items || []).map(item => [item.id, item]));
  return `<section class="panel-section"><div class="section-head"><span class="eyebrow">Wall</span><span class="chip">墙体</span></div><label class="field-label">墙体名称</label><input class="inspector-name" data-wall-field="name" value="${escape(wall.name || '墙体')}" maxlength="120"></section>
  <section class="panel-section"><form id="wall-edit-form"><div class="field-grid"><label><span class="field-label">墙长（m）</span><input id="wall-edit-length" name="length" type="number" min="0.1" max="24" step="any" required value="${length.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}"></label><label><span class="field-label">墙高（m）</span><input id="wall-edit-height" name="height" type="number" min="0.5" max="10" step="any" required value="${height}"></label><label><span class="field-label">墙宽 / 厚度（cm）</span><input id="wall-edit-thickness" name="thickness" type="number" min="1" max="100" step="any" required value="${wall.thickness}"></label><label><span class="field-label">改长度时固定</span><select id="wall-edit-anchor" name="anchor"><option value="start">起点</option><option value="end">终点</option></select></label></div><details class="spaced"><summary class="field-label">墙线方向</summary><label class="spaced"><span class="field-label">方向角（°）</span><input id="wall-edit-angle" name="angle" type="number" min="0" max="360" step="any" value="${Number(angle.toFixed(6))}"></label><p class="help">从起点朝终点：0° 向右，90° 向下。留空时保持当前方向。</p></details><p class="help">墙长按中心线计量，修改长度保持相连墙的连接。墙高更新墙面用量，墙厚同时更新地面净面积。</p><button class="button primary full spaced" type="submit">应用尺寸</button></form></section>
  <section class="panel-section"><div class="section-head"><span class="eyebrow">Surface</span><h3>墙面用量</h3></div><label class="field-label">材料施工范围</label><select id="wall-finish-side" data-wall-field="finishSide">${[['both','左右两侧墙面'],['left','左侧墙面'],['right','右侧墙面']].map(([value,label]) => `<option value="${value}"${(wall.finishSide || 'both') === value ? ' selected' : ''}>${label}</option>`).join('')}</select><div class="measurement-feature spaced"><span class="field-label">净裸露面积</span><strong data-stat="wall-net-area">${wallQuote ? measure(wallQuote.netArea) : '—'}</strong><span class="inline-unit">m²</span></div><div class="stat-row"><span class="muted">开口扣除</span><span data-stat="wall-opening-area">${wallQuote ? measure(wallQuote.openingArea) : '—'} m²</span></div>${renderWallElevation(project, wall)}<p class="help">仅计算裸露的左、右侧墙面。左右以墙起点朝终点为准。</p></section>
  <section class="panel-section"><div class="section-head"><span class="eyebrow">Openings</span><h3>门窗与开孔</h3><span class="chip">${openings.length}</span></div><div class="opening-actions"><button class="button subtle" data-action="add-opening" data-kind="door">${icon('door', 15)}门</button><button class="button subtle" data-action="add-opening" data-kind="window">${icon('window', 15)}窗</button><button class="button subtle" data-action="add-opening" data-kind="hole">${icon('hole', 15)}开孔</button></div><div class="opening-list">${openings.map(o => `<button class="opening-row" data-action="select-opening" data-id="${escape(o.id)}"><span>${escape(o.name || openingName(o))}${o.locked?' · 已锁定':''}<small>${measure(o.width / 100)} × ${measure(o.height / 100)} m</small></span>${icon('chevron', 14)}</button>`).join('')}</div></section>
  <section class="panel-section inspector-materials"><div class="section-head"><span class="eyebrow">Materials</span><h3>墙面材料</h3><span class="chip">${items.length}</span></div>${items.map(item => renderItem(item, materials, quotes.get(item.id))).join('')}<button class="button subtle full" data-action="add-item">${icon('plus', 16)}添加墙面材料</button></section>
  <div class="property-total"><div class="stat-row"><span>墙面小计</span><strong class="cost-value" data-stat="wall-total">${!items.length ? '未配置墙材' : wallQuote?.pending ? '待填写用量' : '¥ ' + money(wallQuote?.total)}</strong></div><p class="muted">门窗本体无需选材，不单独计价。</p></div>
  <section class="panel-section"><button class="button subtle full" data-action="wall-defaults">${icon('layers', 16)}统一设置所有墙</button><button class="button subtle full spaced" data-action="delete-wall" data-id="${escape(wall.id)}">${icon('trash', 16)}删除墙体</button><p class="help">删除后可撤销，房间会重新计算。</p></section>`;
}

export function renderPlanGuide(project: Project, viewMode: '2d' | '3d' = '2d'): string {
  if (viewMode === '3d') return `<section class="empty-inspector plan-guide"><span class="empty-inspector-icon">${icon('cube', 30)}</span><span class="eyebrow">Your space</span><h3>查看你的空间</h3><p>点击墙体调整尺寸，点击地面选择材料。使用「低墙查看」看清室内布局。</p><div class="plan-guide-steps"><span><b>01</b> 拖动旋转，滚轮缩放</span><span><b>02</b> 设置墙高和墙宽 / 厚度</span><span><b>03</b> 选择材料，实时查看报价</span></div><button class="button primary full" data-action="wall-defaults">${icon('layers', 16)}统一墙体尺寸</button><button class="button subtle full" data-action="wall-tool">${icon('wall', 16)}回到 2D 画墙</button><button class="button subtle full spaced" data-action="room-template">${icon('rectangle', 16)}用尺寸快速加房间</button><p class="help">墙高改变空间高度；墙厚会同步调整室内净面积。地面与已配置墙面材料同步计价。</p>${project.planError ? `<div class="plan-notice">${escape(project.planError)}</div>` : ''}</section>`;
  return `<section class="empty-inspector plan-guide"><span class="empty-inspector-icon">${icon('wall', 30)}</span><span class="eyebrow">Draw your plan</span><h3>从墙线开始</h3><p>点击放置墙角，继续点击画墙。墙线闭合后，房间会自动出现。</p><div class="plan-guide-steps"><span><b>01</b> 按墙中心线长度画墙</span><span><b>02</b> 扣除墙厚，生成净施工区域</span><span><b>03</b> 点击房间选择材料</span></div><button class="button primary full" data-action="wall-tool">${icon('wall', 16)}画墙线</button><button class="button subtle full" data-action="room-template">${icon('rectangle', 16)}用长宽快速画房间</button><p class="help">只有室内净长宽时，用快捷房间。门窗处墙线保持连接；可画任意角度直墙，按住 Shift 画水平或垂直墙。</p>${project.planError ? `<div class="plan-notice">${escape(project.planError)}</div>` : ''}</section>`;
}

export function showRoomTemplate(onCreate: (name: string, width: number, depth: number, thickness: number, height: number) => void, defaults = { thickness: 20, height: 280 }): void {
  const dialog = openDialog('快速绘制房间', `<form id="room-template-form"><label class="field-label" for="room-name">房间名称</label><input id="room-name" name="name" required maxlength="120" value="房间"><div class="field-grid spaced"><label><span class="field-label">室内净宽（m）</span><input id="room-width" name="width" type="number" min="0.1" max="20" step="any" required value="4"></label><label><span class="field-label">室内净深（m）</span><input id="room-depth" name="depth" type="number" min="0.1" max="14" step="any" required value="3"></label><label><span class="field-label">墙高（m）</span><input id="room-height" name="height" type="number" min="0.5" max="10" step="any" required value="${defaults.height / 100}"></label><label><span class="field-label">墙厚（cm）</span><input id="room-thickness" name="thickness" type="number" min="1" max="100" step="any" required value="${defaults.thickness}"></label></div><p class="help">长宽是室内净尺寸。系统会生成四面墙，4 × 3 m 的净施工面积就是 12 m²。</p><button class="button primary full" type="submit">生成房间墙体</button></form>`, { subtitle: '输入长、宽、高，即可在二维和三维中查看。' });
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(dialog.querySelector('form'));
    try { onCreate(String(data.get('name')).trim(), Number(data.get('width')), Number(data.get('depth')), Number(data.get('thickness')), Number(data.get('height')) * 100); dialog.close(); }
    catch (error) { toast(error.message, true); }
  });
}

/** Resize along the current unit direction, or set a start-to-end angle in
 * screen degrees (0 right, 90 down). Translate connected straight support
 * lines and all their T endpoints together, preserving the fixed anchor. */
export function changeWallDimensions(walls: Wall[], id: string, length: number, thickness: number, anchor = 'start', angleDegrees?: number): Wall[] {
  if (![length, thickness].every(Number.isFinite) || length < .1 || length > 24 || thickness < 1 || thickness > 100) throw new Error('请输入有效的墙长和墙厚。');
  if (!['start', 'end'].includes(anchor)) throw new Error('固定端点应为起点或终点。');
  if (angleDegrees !== undefined && (!Number.isFinite(angleDegrees) || angleDegrees < 0 || angleDegrees > 360)) throw new Error('墙线方向角应为 0–360°。');
  const normalized = normalizeWalls(walls);
  const selected = normalized.find(w => w.id === id); if (!selected) throw new Error('墙线不存在。');
  const fixed = anchor === 'end' ? selected.end : selected.start;
  const moving = anchor === 'end' ? selected.start : selected.end;
  const previousLength = Math.hypot(moving.x - fixed.x, moving.y - fixed.y);
  const original = { x: (moving.x - fixed.x) / previousLength, y: (moving.y - fixed.y) / previousLength };
  const currentAngle = (Math.atan2(selected.end.y - selected.start.y, selected.end.x - selected.start.x) * 180 / Math.PI + 360) % 360;
  // The inspector displays a rounded length/angle. Submitting an unchanged
  // displayed value (e.g. editing height only) must preserve the exact geometry.
  const sameAngle = angleDegrees === undefined || angleDegrees % 360 === Number(currentAngle.toFixed(6)) % 360;
  const sameLength = length === previousLength / 100 || length === Number((previousLength / 100).toFixed(4));
  const radians = sameAngle ? undefined : angleDegrees * Math.PI / 180;
  const cardinal = (value: number) => Math.abs(value) < 1e-12 ? 0 : Math.abs(value - 1) < 1e-12 ? 1 : Math.abs(value + 1) < 1e-12 ? -1 : value;
  const direction = radians === undefined ? original : {
    x: cardinal(Math.cos(radians)) * (anchor === 'end' ? -1 : 1),
    y: cardinal(Math.sin(radians)) * (anchor === 'end' ? -1 : 1),
  };
  const target = sameAngle && sameLength ? { ...moving } : { x: fixed.x + direction.x * length * 100, y: fixed.y + direction.y * length * 100 };
  const shift = { x: target.x - moving.x, y: target.y - moving.y };
  const epsilon = .001;
  const equal = (a: typeof fixed, b: typeof fixed) => Math.hypot(a.x - b.x, a.y - b.y) <= epsilon;
  const support: { direction: typeof original; low: number; high: number }[] = [];
  for (const wall of normalized) {
    const delta = { x: wall.end.x - wall.start.x, y: wall.end.y - wall.start.y };
    const magnitude = Math.hypot(delta.x, delta.y), unit = { x: delta.x / magnitude, y: delta.y / magnitude };
    if (Math.abs(unit.x * original.y - unit.y * original.x) < 1e-8) continue;
    const distance = Math.abs(unit.x * (moving.y - wall.start.y) - unit.y * (moving.x - wall.start.x));
    const t = ((moving.x - wall.start.x) * unit.x + (moving.y - wall.start.y) * unit.y) / magnitude;
    if (distance > epsilon || t < -epsilon / magnitude || t > 1 + epsilon / magnitude) continue;
    if (support.some(line => Math.abs(line.direction.x * unit.y - line.direction.y * unit.x) < 1e-8)) continue;
    const coordinate = (p: typeof fixed) => (p.x - moving.x) * unit.x + (p.y - moving.y) * unit.y;
    const onLine = (p: typeof fixed) => Math.abs(unit.x * (p.y - moving.y) - unit.y * (p.x - moving.x)) <= epsilon;
    let low = 0, high = 0, expanded = true;
    while (expanded) {
      expanded = false;
      for (const other of normalized) {
        if (!onLine(other.start) || !onLine(other.end)) continue;
        const a = Math.min(coordinate(other.start), coordinate(other.end)), b = Math.max(coordinate(other.start), coordinate(other.end));
        if (a > high + epsilon || b < low - epsilon) continue;
        if (a < low || b > high) { low = Math.min(low, a); high = Math.max(high, b); expanded = true; }
      }
    }
    support.push({ direction: unit, low, high });
  }
  const move = (p: typeof fixed) => {
    if (equal(p, fixed)) return { ...p };
    const connected = equal(p, moving) || support.some(line => {
      const x = p.x - moving.x, y = p.y - moving.y;
      const position = x * line.direction.x + y * line.direction.y;
      return Math.abs(line.direction.x * y - line.direction.y * x) <= epsilon && position >= line.low - epsilon && position <= line.high + epsilon;
    });
    return connected ? { x: p.x + shift.x, y: p.y + shift.y } : { ...p };
  };
  return normalizeWalls(normalized.map(wall => ({
    ...wall, start: move(wall.start), end: move(wall.end), thickness: wall.id === id ? thickness : wall.thickness,
  })));
}
