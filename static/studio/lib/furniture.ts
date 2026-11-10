import type { Furniture, Point, Project } from '../types.js';
import { normalizeDecimal } from './pricing.js';
import { FURNITURE_TEMPLATES } from './furniture-catalog.js';
import { isStairKind, stairPlanGeometry, validateStairSettings } from './stairs.js';
import { pointInRegion } from './geometry.js';
export { FURNITURE_TEMPLATES, FURNITURE_CATEGORIES, searchFurnitureTemplates } from './furniture-catalog.js';

/** Templates suggest dimensions only. All prices are entered by the project owner. */

export function validateFurniture(items: unknown): asserts items is Furniture[] | undefined {
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length > 1000) throw new RangeError('家具数据格式不正确，最多支持 1000 项。');
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new RangeError('家具编号不能为空或重复。');
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) throw new RangeError('请填写家具名称（最多 120 字）。');
    if (!FURNITURE_TEMPLATES.some(template => template.kind === item.kind)) throw new RangeError('家具类型不正确。');
    if (!Number.isFinite(item.position?.x) || !Number.isFinite(item.position?.y)) throw new RangeError('家具位置必须是有限坐标。');
    for (const field of ['width', 'depth', 'height']) if (!Number.isFinite(item[field]) || item[field] < 1 || item[field] > 2000) throw new RangeError('家具尺寸应为 1–2000 cm。');
    if (!Number.isFinite(item.rotation) || Math.abs(item.rotation) > 36000) throw new RangeError('家具角度不正确。');
    if (item.mountHeight !== undefined && (!Number.isFinite(item.mountHeight) || item.mountHeight < 0 || item.mountHeight > 2000)) throw new RangeError('家具离地高度应为 0–2000 cm。');
    if (!/^\d+$/.test(String(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 1000000) throw new RangeError('家具数量应为 1–1000000 的整数。');
    if (item.unitPrice !== '') normalizeDecimal(item.unitPrice, '家具单价');
    normalizeDecimal(item.additionalCost, '家具安装 / 运费');
    if (item.hidden !== undefined && typeof item.hidden !== 'boolean') throw new RangeError('家具显示状态不正确。');
    if (item.locked !== undefined && typeof item.locked !== 'boolean') throw new RangeError('家具锁定状态必须为是或否。');
    validateStairSettings(item);
  }
}

export function furnitureScale(project: Pick<Project, 'drawing' | 'calibration'>): number | null {
  if (project.drawing?.type === 'plan') return .01;
  const scale = project.calibration?.metersPerPixel;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** Corners in drawing coordinates; no uncalibrated footprint is invented. */
export function furnitureFootprint(item: Furniture, project: Pick<Project, 'drawing' | 'calibration'>): Point[] | null {
  const scale = furnitureScale(project); if (!scale) return null;
  if (isStairKind(item.kind)) return stairPlanGeometry(item, project).outline;
  const x = item.width / 200 / scale, y = item.depth / 200 / scale, angle = item.rotation * Math.PI / 180;
  return [[-x, -y], [x, -y], [x, y], [-x, y]].map(([dx, dy]) => ({ x: item.position.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: item.position.y + dx * Math.sin(angle) + dy * Math.cos(angle) }));
}

export function furnitureContains(item: Furniture, point: Point, project: Pick<Project, 'drawing' | 'calibration'>): boolean {
  const scale = furnitureScale(project); if (!scale || item.hidden) return false;
  if (isStairKind(item.kind)) {
    const plan=stairPlanGeometry(item,project);
    return pointInRegion(point,{points:plan.outline,holes:plan.holes});
  }
  const angle = -item.rotation * Math.PI / 180, dx = point.x - item.position.x, dy = point.y - item.position.y;
  return Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) <= item.width / 200 / scale && Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) <= item.depth / 200 / scale;
}

export function clampFurniturePosition(item: Furniture, position: Point, project: Pick<Project, 'drawing' | 'calibration'>): Point {
  const d = project.drawing; if (!d) return position;
  const footprint = furnitureFootprint({ ...item, position: { x: 0, y: 0 } }, project);
  if (!footprint) return { x: Math.max(0, Math.min(d.width, position.x)), y: Math.max(0, Math.min(d.height, position.y)) };
  const halfX = Math.max(...footprint.map(p => Math.abs(p.x))), halfY = Math.max(...footprint.map(p => Math.abs(p.y)));
  // Calibration can reveal that an existing object is larger than the sheet.
  // Keep its true size and centre the affected axis, so it remains editable.
  return { x: halfX * 2 > d.width ? d.width / 2 : Math.max(halfX, Math.min(d.width - halfX, position.x)), y: halfY * 2 > d.height ? d.height / 2 : Math.max(halfY, Math.min(d.height - halfY, position.y)) };
}
