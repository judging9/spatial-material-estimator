import type { Project, Region, FloorOpening } from '../types.js';
import { validateRegion, polygonArea, regionMetrics } from './geometry.js';
import { openingRegionParts, openingNetArea, validateOpeningShape } from './floor-openings.js';
import { isStairKind } from './stairs.js';
import { normalizeWalls } from './wall-plan.js';
import { validateFurniture } from './furniture.js';
import { validateServiceRoutes } from './services.js';
import { validateCivilElements } from './civil.js';
import { validateWallShapes } from './wall-shapes.js';
import { validateOpenings } from './wall-solid.js';
import { validateProjectBoundary } from './plan-boundary.js';

export type { FloorOpening } from '../types.js';
export type LevelContent = Pick<Project, 'regions'> & Partial<Pick<Project, 'walls' | 'wallShapes' | 'openings' | 'furniture' | 'serviceRoutes' | 'civilElements' | 'planBoundary' | 'wallHeight' | 'wallThickness' | 'wallJoinStyle'>> & { wallRegionCache?: Region[]; planError?: string | null; floorOpenings?: FloorOpening[] };
export type ProjectLevel = { id: string; name: string; elevation: number; height: number; slabThickness: number; content?: LevelContent };
export type LevelProject = { id: string; name: string; elevation: number; height: number; slabThickness: number; project: Project };
export const MAX_LEVELS = 8;
const contentFields = ['regions', 'walls', 'wallShapes', 'openings', 'furniture', 'serviceRoutes', 'civilElements', 'planBoundary', 'wallHeight', 'wallThickness', 'wallJoinStyle', 'wallRegionCache', 'planError', 'floorOpenings'] as const;
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
const sourceLevels = (project: Project): ProjectLevel[] | undefined => project.levels as ProjectLevel[] | undefined;
const storeyHeight = (project: Project) => Math.min(1000, Math.max(project.wallHeight ?? 280, ...(project.walls ?? []).map(wall => wall.height ?? project.wallHeight ?? 280)) + 20);

/** The current storey remains in the existing top-level fields. Only inactive
 * storeys keep content snapshots, so neither persistence nor quotes double it. */
export function activeLevel(project: Project): ProjectLevel {
  const levels = sourceLevels(project);
  if (!levels) return { id: 'level-ground', name: '一楼', elevation: 0, height: storeyHeight(project), slabThickness: 20 };
  const active = levels.find(level => level.id === project.activeLevelId);
  if (!active) throw new RangeError('活动楼层不存在。');
  return active;
}

function capture(project: Project): LevelContent {
  const content = { regions: [] } as LevelContent;
  for (const field of contentFields) if (project[field] !== undefined) (content as any)[field] = clone(project[field]);
  return content;
}
function restore(project: Project, content: LevelContent): void {
  // Explicit undefined also clears fields when app applies this pure result
  // using Object.assign(next, result). JSON persistence omits undefined values.
  for (const field of contentFields) (project as any)[field] = undefined;
  Object.assign(project, clone(content));
  project.regions ??= [];
}

export function ensureLevels(project: Project): Project {
  if (sourceLevels(project)) { validateLevels(project); return clone(project); }
  if (project.drawing?.type !== 'plan') throw new RangeError('请先按真实尺寸画平面图，再添加楼层。');
  const next = clone(project), first = { ...activeLevel(project), id: uid('level') };
  next.levels = [first]; next.activeLevelId = first.id;
  validateLevels(next); return next;
}

/** Raw per-storey project; effectiveLevelProject applies slab holes separately.
 * Shared drawing, project name and financial parameters remain at project root. */
export function levelProjects(project: Project): LevelProject[] {
  const levels = sourceLevels(project) ?? [activeLevel(project)];
  return levels.map(level => {
    const current = !sourceLevels(project) || level.id === project.activeLevelId;
    const raw = { ...project };
    delete raw.levels; delete raw.activeLevelId;
    if (!current) restore(raw, level.content ?? { regions: [] });
    return { id: level.id, name: level.name, elevation: level.elevation, height: level.height, slabThickness: level.slabThickness, project: raw };
  });
}

/** Real slab voids are stored independently from wall-derived room holes. */
export function effectiveLevelProject(project: Project): Project {
  const openings = project.floorOpenings as FloorOpening[] | undefined;
  if (!openings?.length) return project;
  const regions = project.regions.map(region => {
    const cuts = openings.filter(opening => opening.regionId === region.id);
    return cuts.length ? { ...region, surfaceParts: openingRegionParts(region, cuts) } : region;
  });
  const result = { ...project, regions };
  // The returned view is already effective; a renderer may pass it onwards.
  delete result.floorOpenings;
  return result;
}

export function ceilingHeight(project: Project, region: Region): number {
  const ceiling = (region as any).ceiling;
  if (ceiling?.height !== undefined) return ceiling.height;
  const heights = (project.walls ?? []).filter(wall => region.wallIds?.includes(wall.id)).map(wall => wall.height ?? project.wallHeight ?? 280);
  return heights.length ? Math.max(...heights) : project.wallHeight ?? 280;
}

function validateCeilings(project: Project): void {
  for (const region of project.regions) {
    const ceiling = (region as any).ceiling;
    if (ceiling === undefined) continue;
    if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling) || typeof ceiling.enabled !== 'boolean' || !Array.isArray(ceiling.items)) throw new RangeError('天花板设置格式不正确。');
    const height = ceilingHeight(project, region);
    if (!Number.isFinite(height) || height < 50 || height > 1000) throw new RangeError('天花板高度应为 0.5–10 m。');
    if (ceiling.additionalCost !== undefined && !['string','number'].includes(typeof ceiling.additionalCost)) throw new RangeError('天花板附加费格式不正确。');
  }
}

export function validateFloorOpenings(project: Project): void {
  const openings = project.floorOpenings as FloorOpening[] | undefined;
  if (openings === undefined) return;
  if (!Array.isArray(openings) || openings.length > 200) throw new RangeError('楼板洞口数据格式不正确，最多支持 200 个。');
  const ids = new Set<string>();
  for (const opening of openings) {
    if (!opening || typeof opening.id !== 'string' || !opening.id.trim() || ids.has(opening.id) || !project.regions.some(region => region.id === opening.regionId)) throw new RangeError('楼板洞口编号重复或所属房间不存在。');
    ids.add(opening.id);
    validateOpeningShape(opening);
    if (opening.shape !== undefined && !['polygon','rectangle','circle','ellipse','annulus'].includes(opening.shape)) throw new RangeError('楼板洞口图形类型不正确。');
    for (const field of ['sourceStairId','sourceLevelId'] as const) if (opening[field] !== undefined && (typeof opening[field] !== 'string' || !opening[field].trim())) throw new RangeError('楼板洞口楼梯关联格式不正确。');
    if (opening.clearance !== undefined && (!Number.isFinite(opening.clearance) || opening.clearance < 0 || opening.clearance > 200)) throw new RangeError('楼板洞口余量应为 0–200 cm。');
    const region = project.regions.find(region => region.id === opening.regionId)!;
    const originalArea = regionMetrics(region, { metersPerPixel: 1 }).netArea;
    if (originalArea - openingNetArea(region, [opening]) <= 1e-6) throw new RangeError('楼板洞口必须与房间地面相交，请画在房间内或靠近边界。');
  }
  const effective = effectiveLevelProject(project);
  for (const region of effective.regions) {
    const validity = validateRegion(region, effective.regions);
    if (!validity.valid) throw new RangeError('楼板洞口无效：' + validity.error);
    const netArea = regionMetrics(region, { metersPerPixel: 1 }).netArea;
    if (!Number.isFinite(netArea) || netArea <= 1e-6) throw new RangeError('楼板洞口不能移除整个房间地面。');
  }
}

function validateLevelGeometry(project: Project): void {
  if (!Array.isArray(project.regions)) throw new RangeError('楼层区域数据格式不正确。');
  if (project.wallJoinStyle !== undefined && !['clean','square'].includes(project.wallJoinStyle)) throw new RangeError('楼层墙体连接方式不正确。');
  normalizeWalls(project.walls ?? []);
  if (project.wallHeight !== undefined && (!Number.isFinite(project.wallHeight) || project.wallHeight < 50 || project.wallHeight > 1000)) throw new RangeError('默认墙高应为 0.5–10 m。');
  if (project.wallThickness !== undefined && (!Number.isFinite(project.wallThickness) || project.wallThickness < 1 || project.wallThickness > 100)) throw new RangeError('默认墙厚应为 1–100 cm。');
  validateFurniture(project.furniture); validateServiceRoutes(project.serviceRoutes); validateCivilElements(project.civilElements, project); validateWallShapes(project); validateOpenings(project);
  const boundary = validateProjectBoundary(project); if (!boundary.valid) throw new RangeError(boundary.error);
  const regions = project.regions.filter(region => region.points?.length > 0);
  const ids = new Set<string>();
  for (const region of project.regions) {
    if (!region || typeof region.id !== 'string' || !region.id.trim() || ids.has(region.id) || !Array.isArray(region.points) || !Array.isArray(region.holes ?? []) || !Array.isArray(region.items ?? [])) throw new RangeError('楼层区域编号或数据格式不正确。');
    ids.add(region.id);
  }
  for (const region of regions) { const valid = validateRegion(region, regions); if (!valid.valid) throw new RangeError(valid.error); }
  validateFloorOpenings(project); validateCeilings(project);
}

/** Validate each storey's geometry independently. Overlapping XY coordinates
 * on different floors are legitimate, while duplicate object IDs are not. */
export function validateLevels(project: Project): void {
  const levels = sourceLevels(project);
  if (levels === undefined) {
    if (project.activeLevelId !== undefined) throw new RangeError('活动楼层需要楼层列表。');
    if (project.furniture?.some(item => item.stairTargetLevelId !== undefined)) throw new RangeError('楼梯绑定需要有效的目标楼层。');
    validateFloorOpenings(project); validateCeilings(project); validateServiceRoutes(project.serviceRoutes); validateCivilElements(project.civilElements, project); return;
  }
  if (project.drawing?.type !== 'plan' || !Array.isArray(levels) || !levels.length || levels.length > MAX_LEVELS) throw new RangeError('多楼层需要真实尺寸平面图，支持 1–8 层。');
  const ids = new Set<string>(); let elevation = 0;
  for (const level of levels) {
    if (!level || typeof level.id !== 'string' || !level.id.trim() || ids.has(level.id) || typeof level.name !== 'string' || !level.name.trim() || level.name.length > 120) throw new RangeError('楼层编号或名称不正确。');
    ids.add(level.id);
    if (!Number.isFinite(level.height) || level.height < 50 || level.height > 1000 || !Number.isFinite(level.slabThickness) || level.slabThickness < 1 || level.slabThickness > 100 || level.slabThickness >= level.height || !Number.isFinite(level.elevation) || Math.abs(level.elevation - elevation) > 1e-6) throw new RangeError('楼层高度、板厚或标高不正确，楼层应按层高依次叠放。');
    elevation += level.height;
    if (level.id === project.activeLevelId) { if (level.content !== undefined) throw new RangeError('活动楼层不能重复保存内容快照。'); }
    else if (!level.content || typeof level.content !== 'object' || Array.isArray(level.content) || Object.keys(level.content).some(key => !contentFields.includes(key as any))) throw new RangeError('非活动楼层内容缺失或包含跨层字段。');
  }
  if (!ids.has(String(project.activeLevelId))) throw new RangeError('活动楼层不存在。');
  const objectIds = new Set<string>();
  for (const layer of levelProjects(project)) {
    validateLevelGeometry(layer.project);
    const groups = [layer.project.regions, layer.project.walls ?? [], layer.project.wallShapes ?? [], layer.project.openings ?? [], layer.project.furniture ?? [], layer.project.serviceRoutes ?? [], layer.project.civilElements ?? [], (layer.project.floorOpenings ?? []) as FloorOpening[]];
    for (const group of groups) for (const object of group) {
      if (objectIds.has(object.id)) throw new RangeError('不同楼层的对象编号不能重复。');
      objectIds.add(object.id);
    }
    for (const furniture of layer.project.furniture ?? []) {
      const targetId = furniture.stairTargetLevelId;
      if (targetId === undefined) continue;
      const target = levels.find(level => level.id === targetId);
      if (!isStairKind(furniture.kind) || !target || target.elevation <= layer.elevation) throw new RangeError('楼梯目标必须是本层之上的有效楼层。');
      const rise = target.elevation - layer.elevation - (furniture.mountHeight ?? 0);
      if (!Number.isFinite(rise) || rise < 1 || rise > 2000 || Math.abs(furniture.height - rise) > 1e-6) throw new RangeError('楼梯实际升高必须准确连接目标层；请调整离地高度、层高或解除目标绑定后自定高度。');
    }
  }
}

export function switchLevel(project: Project, id: string): Project {
  const next = ensureLevels(project), levels = sourceLevels(next)!, previous = activeLevel(next), target = levels.find(level => level.id === id);
  if (!target) throw new RangeError('请选择存在的楼层。');
  if (previous.id === target.id) return next;
  previous.content = capture(next); restore(next, target.content!); delete target.content; next.activeLevelId = target.id;
  validateLevels(next); return next;
}

function copiedContent(project: Project): LevelContent {
  const content = capture(project), idMap = new Map<string,string>();
  const replace = (id: string, prefix: string) => { if (!idMap.has(id)) idMap.set(id, uid(prefix)); return idMap.get(id)!; };
  for (const [field,prefix] of [['regions','area'],['walls','wall'],['wallShapes','wall-shape'],['openings','opening'],['furniture','furniture'],['serviceRoutes','service'],['civilElements','civil'],['floorOpenings','floor-opening'],['wallRegionCache','area']] as const) for (const item of (content as any)[field] ?? []) replace(item.id,prefix);
  const owners = [...(content.regions ?? []), ...(content.walls ?? []), ...(content.wallShapes ?? []), ...(content.wallRegionCache ?? [])];
  for (const owner of owners) { owner.id = replace(owner.id,'object'); for (const item of owner.items ?? []) item.id = uid('item'); if ((owner as any).wallIds) (owner as any).wallIds = (owner as any).wallIds.map((id:string) => replace(id,'wall')); if ((owner as any).ceiling) for (const item of (owner as any).ceiling.items) item.id = uid('item'); }
  for (const opening of content.openings ?? []) { opening.id = replace(opening.id,'opening'); opening.wallId = replace(opening.wallId,'wall'); }
  for (const opening of content.floorOpenings ?? []) { opening.id = replace(opening.id,'floor-opening'); opening.regionId = replace(opening.regionId,'area'); delete opening.sourceStairId; delete opening.sourceLevelId; }
  for (const furniture of content.furniture ?? []) { furniture.id = replace(furniture.id,'furniture'); delete (furniture as any).stairTargetLevelId; }
  for (const route of content.serviceRoutes ?? []) route.id = replace(route.id,'service');
  for (const element of content.civilElements ?? []) { element.id = replace(element.id,'civil'); if (element.sourceRegionId) element.sourceRegionId = replace(element.sourceRegionId,'area'); }
  return content;
}

export function addLevel(project: Project, options: { name?: string; height?: number; slabThickness?: number; copyLayout?: boolean } = {}): Project {
  const next = ensureLevels(project), levels = sourceLevels(next)!;
  if (levels.length >= MAX_LEVELS) throw new RangeError('当前最多支持 8 个楼层。');
  const previous = activeLevel(next), last = levels[levels.length-1];
  const content: LevelContent = options.copyLayout ? copiedContent(next) : { regions: [], walls: [], wallShapes: [], openings: [], furniture: [], serviceRoutes: [], civilElements: [], floorOpenings: [], wallRegionCache: [], planError: null, wallHeight: next.wallHeight ?? 280, wallThickness: next.wallThickness ?? 20, wallJoinStyle: next.wallJoinStyle ?? 'clean', planBoundary: clone(next.planBoundary ?? null) };
  previous.content = capture(next);
  const level: ProjectLevel = { id: uid('level'), name: options.name?.trim() || `${levels.length + 1} 楼`, elevation: last.elevation + last.height, height: options.height ?? 300, slabThickness: options.slabThickness ?? 20 };
  levels.push(level); restore(next, content); next.activeLevelId = level.id;
  validateLevels(next); return next;
}

function recomputeElevations(levels: ProjectLevel[]): void { let elevation = 0; for (const level of levels) { level.elevation = elevation; elevation += level.height; } }
/** Update exact bound rise after metadata moves a target landing. Caller owns
 * a cloned project; no geometry or price of the original state is mutated. */
function syncBoundStairs(project: Project): void {
  const levels = sourceLevels(project)!;
  for (const level of levels) {
    const content = level.id === project.activeLevelId ? project : level.content!;
    for (const item of content.furniture ?? []) {
      if (item.stairTargetLevelId === undefined) continue;
      const target = levels.find(target => target.id === item.stairTargetLevelId);
      const rise = target ? target.elevation - level.elevation - (item.mountHeight ?? 0) : NaN;
      if (!Number.isFinite(rise) || rise < 1 || rise > 2000) throw new RangeError('楼梯实际升高必须大于零且不超过 20 m，请调整离地高度或目标楼层。');
      if (item.locked && Math.abs(item.height - rise) > 1e-6) throw new RangeError(`${item.name}已锁定，修改层高会改变楼梯升高，请先解锁该楼梯。`);
      item.height = rise;
    }
  }
}
export function updateLevel(project: Project, id: string, changes: { name?: string; height?: number; slabThickness?: number }): Project {
  const next = ensureLevels(project), level = sourceLevels(next)!.find(level => level.id === id);
  if (!level) throw new RangeError('楼层不存在。');
  Object.assign(level, changes); if (changes.name !== undefined) level.name = changes.name.trim();
  if (changes.height !== undefined) {
    const content = level.id === next.activeLevelId ? next : level.content!;
    content.wallHeight = Math.max(50, Math.min(content.wallHeight ?? 280, changes.height));
  }
  recomputeElevations(sourceLevels(next)!); syncBoundStairs(next); validateLevels(next); return next;
}
export function deleteLevel(project: Project, id: string): Project {
  let next = ensureLevels(project), levels = sourceLevels(next)!;
  if (levels.length === 1) throw new RangeError('至少保留一个楼层。');
  const position = levels.findIndex(level => level.id === id); if (position < 0) throw new RangeError('楼层不存在。');
  if (id === next.activeLevelId) { next = switchLevel(next, levels[position ? position-1 : 1].id); levels = sourceLevels(next)!; }
  next.levels = levels.filter(level => level.id !== id); recomputeElevations(sourceLevels(next)!);
  const furnitureLists = [next.furniture ?? [], ...sourceLevels(next)!.map(level => level.content?.furniture ?? [])];
  for (const list of furnitureLists) for (const furniture of list) if ((furniture as any).stairTargetLevelId === id) delete (furniture as any).stairTargetLevelId;
  syncBoundStairs(next); validateLevels(next); return next;
}
