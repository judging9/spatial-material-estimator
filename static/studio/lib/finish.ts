import type { Material, Point, Project, Region, QuoteItem } from '../types.js';
import { polygonArea, pointInRegion, regionMetrics, validateRegion } from './geometry.js';
import { openingPolygon, buildWallSolid, type SolidSurface, type SolidVector, type WallOpening } from './wall-solid.js';
import { createCostItem, applyModulePrices, type CostItem, type CostModuleState, type PriceStatus } from './cost.js';
import { formatQuantity, normalizeDecimal } from './pricing.js';

export type FinishGrade = 'basic' | 'standard' | 'high';
export type SpaceType = 'living' | 'bedroom' | 'dining' | 'kitchen' | 'bath' | 'balcony' | 'corridor' | 'study';
export type FinishPoints = { switches: number; sockets: number; lights: number; water: number; drains: number };
export type FinishPreference = { regionId: string; spaceType: SpaceType; grade?: FinishGrade; points?: Partial<FinishPoints> };
export type FinishConfig = {
  grade: FinishGrade; rooms: FinishPreference[]; wallHeight: number; wetUpstand: number; wetWallHeight: number;
  ceiling: boolean; lightCove: boolean; doorCasings: boolean; floorWasteRate: number; ceilingWasteRate: number;
  conduitPerArea: number; wireMultiplier: number; waterPerWetRoom: number; drainPerWetRoom: number;
  gradePrices: Partial<Record<FinishGrade, Record<string, string>>>; materials: Material[];
};
export type FinishRoom = FinishPreference & {
  name: string; netArea: number; perimeter: number; wallArea: number; wallTileArea: number; paintArea: number;
  doorWidth: number; windowArea: number; wet: boolean; doors: number; windows: number;
  openingIds: string[]; ownedDoorIds: string[]; ownedWindowIds: string[]; wallEstimate: boolean; estimatedBoundaryLength: number; points: FinishPoints;
};
export type FinishModel = { config: FinishConfig; rooms: FinishRoom[]; totalArea: number; warnings: string[] };
export const FINISH_GRADES: Record<FinishGrade, string> = { basic: '简装', standard: '中档', high: '精装' };
export const SPACE_TYPES: Record<SpaceType, string> = { living: '客厅', bedroom: '卧室', dining: '餐厅', kitchen: '厨房', bath: '卫生间', balcony: '阳台', corridor: '过道', study: '书房' };
export const FINISH_POINT_DEFAULTS: Record<SpaceType, FinishPoints> = {
  living: { switches: 2, sockets: 6, lights: 1, water: 0, drains: 0 },
  bedroom: { switches: 1, sockets: 4, lights: 1, water: 0, drains: 0 },
  dining: { switches: 1, sockets: 2, lights: 1, water: 0, drains: 0 },
  kitchen: { switches: 1, sockets: 6, lights: 1, water: 2, drains: 1 },
  bath: { switches: 1, sockets: 2, lights: 1, water: 3, drains: 2 },
  balcony: { switches: 1, sockets: 1, lights: 1, water: 1, drains: 1 },
  corridor: { switches: 1, sockets: 2, lights: 1, water: 0, drains: 0 },
  study: { switches: 1, sockets: 2, lights: 1, water: 0, drains: 0 },
};
const grades = Object.keys(FINISH_GRADES) as FinishGrade[];
const spaces = Object.keys(SPACE_TYPES) as SpaceType[];
const pointKeys = ['switches', 'sockets', 'lights', 'water', 'drains'] as const;
const EPS = 1e-7;

export function inferSpaceType(name: string): SpaceType {
  if (/卫生|厕所|浴室/.test(name)) return 'bath';
  if (/厨/.test(name)) return 'kitchen';
  if (/阳台/.test(name)) return 'balcony';
  if (/书房/.test(name)) return 'study';
  if (/走廊|过道|玄关/.test(name)) return 'corridor';
  if (/客厅|客餐/.test(name)) return 'living';
  if (/餐/.test(name)) return 'dining';
  return 'bedroom';
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label}应为 ${min}–${max} 的有限数字`);
  return value;
}

export function normalizeFinishConfig(input: Partial<FinishConfig> = {}): FinishConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RangeError('装修参数格式不正确');
  const grade = input.grade ?? 'standard';
  if (!grades.includes(grade)) throw new RangeError('装修档次不正确');
  const rooms = input.rooms ?? [];
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new RangeError('装修房间配置必须为不超过 1000 项的数组');
  const ids = new Set<string>();
  const preferences = rooms.map(room => {
    if (!room || typeof room !== 'object' || typeof room.regionId !== 'string' || !room.regionId || ids.has(room.regionId)) throw new RangeError('装修房间编号不能为空或重复');
    ids.add(room.regionId);
    if (!spaces.includes(room.spaceType) || room.grade !== undefined && !grades.includes(room.grade)) throw new RangeError('房间类型或装修档次不正确');
    const points: Partial<FinishPoints> = {};
    if (room.points !== undefined) {
      if (!room.points || typeof room.points !== 'object' || Array.isArray(room.points)) throw new RangeError('水电点位配置不正确');
      for (const key of pointKeys) if (room.points[key] !== undefined) {
        const count = number(room.points[key], '水电点位数量', 0, 1000);
        if (!Number.isInteger(count)) throw new RangeError('水电点位数量必须为整数');
        points[key] = count;
      }
    }
    return { regionId: room.regionId, spaceType: room.spaceType, ...(room.grade ? { grade: room.grade } : {}), ...(Object.keys(points).length ? { points } : {}) };
  });
  const bool = (key: 'ceiling' | 'lightCove' | 'doorCasings', fallback: boolean) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'boolean') throw new RangeError('装修工序开关必须为布尔值');
    return value;
  };
  const gradePrices: FinishConfig['gradePrices'] = {};
  if (input.gradePrices !== undefined) {
    if (!input.gradePrices || typeof input.gradePrices !== 'object' || Array.isArray(input.gradePrices)) throw new RangeError('档次单价配置不正确');
    for (const [key, values] of Object.entries(input.gradePrices)) {
      if (!grades.includes(key as FinishGrade) || !values || typeof values !== 'object' || Array.isArray(values)) throw new RangeError('档次单价配置不正确');
      gradePrices[key] = Object.fromEntries(Object.entries(values).map(([id, value]) => {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new RangeError('工序单价编号不正确');
        return [id, normalizeDecimal(value, '工序综合单价')];
      }));
    }
  }
  const materials = input.materials ?? [];
  if (!Array.isArray(materials) || materials.length > 10000) throw new RangeError('装修材料快照格式不正确');
  for (const material of materials) {
    if (!material || typeof material.name !== 'string' || typeof material.unit !== 'string') throw new RangeError('装修材料快照格式不正确');
    normalizeDecimal(material.unitPrice, '材料快照单价');
  }
  return {
    grade, rooms: preferences, wallHeight: number(input.wallHeight ?? 2.8, '估算墙高', .5, 10),
    wetUpstand: number(input.wetUpstand ?? .3, '防水上翻高度', 0, 3), wetWallHeight: number(input.wetWallHeight ?? 2.4, '湿区贴砖高度', 0, 10),
    ceiling: bool('ceiling', true), lightCove: bool('lightCove', true), doorCasings: bool('doorCasings', false),
    floorWasteRate: number(input.floorWasteRate ?? 3, '地面材料损耗率', 0, 100), ceilingWasteRate: number(input.ceilingWasteRate ?? 5, '吊顶面板损耗率', 0, 100),
    conduitPerArea: number(input.conduitPerArea ?? 2.5, '配管面积指标', 0, 100), wireMultiplier: number(input.wireMultiplier ?? 3, '配线倍数', 0, 30),
    waterPerWetRoom: number(input.waterPerWetRoom ?? 15, '湿区给水长度指标', 0, 1000), drainPerWetRoom: number(input.drainPerWetRoom ?? 8, '湿区排水长度指标', 0, 1000),
    gradePrices, materials: structuredClone(materials),
  };
}

export function validateFinishState(state: CostModuleState): void { normalizeFinishConfig(state.config ?? {}); }

type PlanVector = { x:number; z:number };
type Boundary = { room: FinishRoom; region: Region; u:PlanVector; n:PlanVector; plane: number; low: number; high: number; coverage: [number, number][] };
const planDot=(point:SolidVector|PlanVector,normal:PlanVector)=>point.x*normal.x+point.z*normal.z;
function boundaryFrame(dx:number,dz:number):{u:PlanVector;n:PlanVector}{
  const length=Math.hypot(dx,dz);let ux=dx/length,uz=dz/length;
  if(ux< -EPS||Math.abs(ux)<=EPS&&uz<0){ux=-ux;uz=-uz;}
  return {u:{x:ux,z:uz},n:{x:-uz,z:ux}};
}
function clipPlan(points:SolidVector[],normal:PlanVector,bound:number,above:boolean):SolidVector[]{
  const result:SolidVector[]=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],da=planDot(a,normal)-bound,db=planDot(b,normal)-bound;
    const ia=above?da>=-EPS:da<=EPS,ib=above?db>=-EPS:db<=EPS;
    if(ia)result.push(a);
    if(ia!==ib){const t=da/(da-db);result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
  }
  return result;
}
function clip(points: SolidVector[], axis: 'x' | 'y' | 'z', bound: number, keepAbove: boolean): SolidVector[] {
  if (!points.length) return [];
  const result: SolidVector[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const inA = keepAbove ? a[axis] >= bound - EPS : a[axis] <= bound + EPS;
    const inB = keepAbove ? b[axis] >= bound - EPS : b[axis] <= bound + EPS;
    if (inA) result.push(a);
    if (inA !== inB) {
      const t = (bound - a[axis]) / (b[axis] - a[axis]);
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, [axis]: bound });
    }
  }
  return result;
}
/** Project the already-computed planar surface; reuse the existing area engine. */
function area(points: SolidVector[], normal: SolidVector): number {
  if (points.length < 3) return 0;
  const axes = ['x', 'y', 'z'] as const;
  const dominant = axes.reduce((best, axis) => Math.abs(normal[axis]) > Math.abs(normal[best]) ? axis : best, 'x');
  const projected = axes.filter(axis => axis !== dominant);
  return polygonArea(points.map(point => ({ x: point[projected[0]], y: point[projected[1]] }))) / Math.abs(normal[dominant]);
}
function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1] + EPS) last[1] = Math.max(last[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}
function floorDoorWidth(opening: WallOpening): number {
  const ring = openingPolygon(opening), intervals: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.abs(a.y) < EPS && Math.abs(b.y) < EPS && Math.abs(a.x - b.x) > EPS) intervals.push([Math.min(a.x, b.x), Math.max(a.x, b.x)]);
  }
  return mergeIntervals(intervals).reduce((total, [a, b]) => total + b - a, 0) / 100;
}

/** Room measures always come from regionMetrics and actual wall-union faces. */
export function buildFinishModel(project: Project, configInput: Partial<FinishConfig> = {}): FinishModel {
  const config = normalizeFinishConfig(configInput);
  if (!project || !Array.isArray(project.regions)) throw new RangeError('工程房间数据不正确');
  if (!project.regions.length) return { config, rooms: [], totalArea: 0, warnings: [] };
  if (project.planError) throw new RangeError('墙线尚未闭合或净轮廓无效，请先完成平面图再生成装修造价');
  const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('请先校准图纸真实尺寸，再生成装修造价');
  const checked: { region: Region; minX: number; minY: number; maxX: number; maxY: number }[] = [];
  const regionIds = new Set<string>();
  for (const region of project.regions) {
    if (!region?.id || regionIds.has(region.id)) throw new RangeError('房间编号不能为空或重复');
    regionIds.add(region.id);
    const shape = validateRegion(region);
    if (!shape.valid) throw new RangeError(`${region.name || '房间'}：${shape.error}`);
    const bounds = { region, minX: Math.min(...region.points.map(p => p.x)), minY: Math.min(...region.points.map(p => p.y)), maxX: Math.max(...region.points.map(p => p.x)), maxY: Math.max(...region.points.map(p => p.y)) };
    const candidates = checked.filter(other => bounds.minX < other.maxX && bounds.maxX > other.minX && bounds.minY < other.maxY && bounds.maxY > other.minY).map(other => other.region);
    const overlap = candidates.length ? validateRegion(region, candidates) : shape;
    if (!overlap.valid) throw new RangeError(`${region.name || '房间'}：${overlap.error}`);
    checked.push(bounds);
  }
  const sortedRegions = [...project.regions].sort((a, b) => Math.min(...a.points.map(p => p.x)) - Math.min(...b.points.map(p => p.x)) || Math.min(...a.points.map(p => p.y)) - Math.min(...b.points.map(p => p.y)) || a.id.localeCompare(b.id));
  const rooms = sortedRegions.map(region => {
    const preference = config.rooms.find(room => room.regionId === region.id);
    const spaceType = preference?.spaceType ?? inferSpaceType(region.name);
    const metrics = regionMetrics(region, { metersPerPixel: scale });
    return {
      regionId: region.id, name: region.name || '房间', spaceType, grade: preference?.grade ?? config.grade,
      netArea: metrics.netArea, perimeter: metrics.perimeter, wallArea: 0, wallTileArea: 0, paintArea: 0,
      doorWidth: 0, windowArea: 0, wet: ['kitchen', 'bath', 'balcony'].includes(spaceType), doors: 0, windows: 0,
      openingIds: [], ownedDoorIds: [], ownedWindowIds: [], wallEstimate: false, estimatedBoundaryLength: 0,
      points: { ...FINISH_POINT_DEFAULTS[spaceType], ...preference?.points },
    } as FinishRoom;
  });
  const boundaries: Boundary[] = [];
  for (let index = 0; index < sortedRegions.length; index++) {
    const region = sortedRegions[index], room = rooms[index];
    for (const ring of [region.points, ...(region.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const {u,n}=boundaryFrame(b.x-a.x,b.y-a.y),pa={x:a.x*scale,z:a.y*scale},pb={x:b.x*scale,z:b.y*scale};
      boundaries.push({room,region,u,n,plane:planDot(pa,n),low:Math.min(planDot(pa,u),planDot(pb,u)),high:Math.max(planDot(pa,u),planDot(pb,u)),coverage:[]});
    }
  }
  const solid = project.walls?.length ? buildWallSolid(project) : null;
  const add = (room: FinishRoom, surface: SolidSurface, points: SolidVector[]) => {
    room.wallArea += area(points, surface.normal);
    if (room.wet) room.wallTileArea += area(clip(points, 'y', config.wetWallHeight, false), surface.normal);
  };
  const byPlane = new Map<string, Boundary[]>();
  const planeKey = (u:PlanVector,plane:number) => [u.x,u.z,plane].map(value=>Math.round(value*1e7)).join(':');
  for (const edge of boundaries) {
    const key = planeKey(edge.u, edge.plane);
    if (!byPlane.has(key)) byPlane.set(key, []);
    byPlane.get(key).push(edge);
  }
  for (const surface of solid?.surfaces ?? []) {
    if (!['left', 'right', 'end'].includes(surface.side)) continue;
    const {u,n}=boundaryFrame(surface.normal.z,-surface.normal.x);
    const candidates = byPlane.get(planeKey(u,planDot(surface.points[0],n))) ?? [];
    const ranges = new Map<FinishRoom, [number, number][]>();
    for (const edge of candidates) {
      const middle = (edge.low + edge.high) / 2;
      const probe = { x: edge.u.x*middle+edge.n.x*edge.plane + surface.normal.x * .00001, y: edge.u.z*middle+edge.n.z*edge.plane + surface.normal.z * .00001 };
      if (!pointInRegion({ x: probe.x / scale, y: probe.y / scale }, edge.region)) continue;
      const low = Math.max(edge.low, Math.min(...surface.points.map(point => planDot(point,u))));
      const high = Math.min(edge.high, Math.max(...surface.points.map(point => planDot(point,u))));
      if (high <= low + EPS) continue;
      edge.coverage.push([low, high]);
      if (!ranges.has(edge.room)) ranges.set(edge.room, []);
      ranges.get(edge.room).push([low, high]);
    }
    // End faces still establish a measured room boundary, so their excluded
    // finish area must not be reintroduced as an unmatched-boundary estimate.
    if (surface.side === 'left' || surface.side === 'right') {
      for (const [room, intervals] of ranges) for (const [low, high] of mergeIntervals(intervals)) {
        add(room, surface, clipPlan(clipPlan(surface.points,u,low,true),u,high,false));
      }
    }
  }
  const openingSides = new Map<string, { room: FinishRoom; normal:PlanVector; center: number; sign: number }[]>();
  for (const opening of solid?.openings ?? []) {
    const wall = project.walls.find(value => value.id === opening.wallId);
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    const ux = (wall.end.x - wall.start.x) / length, uz = (wall.end.y - wall.start.y) / length;
    const midpoint = { x: (wall.start.x + ux * (opening.offset + opening.width / 2)) / 100, z: (wall.start.y + uz * (opening.offset + opening.width / 2)) / 100 };
    const normal = { x: -uz, z: ux },frame=boundaryFrame(ux,uz);
    const sides = [];
    for (const sign of [-1, 1]) {
      const distance = wall.thickness / 200 + .00001;
      const probe = { x: (midpoint.x + normal.x * distance * sign) / scale, y: (midpoint.z + normal.z * distance * sign) / scale };
      const index = sortedRegions.findIndex(region => pointInRegion(probe, region));
      if (index < 0) continue;
      const room = rooms[index];
      room.openingIds.push(opening.id);
      if (opening.kind === 'door') { room.doorWidth += floorDoorWidth(opening); room.doors++; }
      if (opening.kind === 'window') { room.windowArea += polygonArea(openingPolygon(opening)) / 10000; room.windows++; }
      sides.push({ room,normal,center:planDot(midpoint,normal),sign });
      // A full-height doorway is a measured wall boundary even though no face remains above it.
      const facePoint={x:midpoint.x+normal.x*wall.thickness/200*sign,z:midpoint.z+normal.z*wall.thickness/200*sign};
      const plane = planDot(facePoint,frame.n),center = planDot(midpoint,frame.u), halfWidth = opening.width / 200;
      for (const edge of byPlane.get(planeKey(frame.u, plane)) ?? []) if (edge.room === room) {
        const low = Math.max(edge.low, center - halfWidth), high = Math.min(edge.high, center + halfWidth);
        if (high > low + EPS) edge.coverage.push([low, high]);
      }
    }
    openingSides.set(opening.id, sides);
    // Each physical insert is billed once, regardless of the number of rooms.
    const owner = sides.map(side => side.room).sort((a, b) => rooms.indexOf(a) - rooms.indexOf(b))[0];
    if (owner && opening.kind === 'door') owner.ownedDoorIds.push(opening.id);
    if (owner && opening.kind === 'window') owner.ownedWindowIds.push(opening.id);
  }
  const warnings: string[] = [];
  for (let index = 0; index < rooms.length; index++) {
    const room = rooms[index];
    const coveredLength = boundaries.filter(edge => edge.room === room).reduce((sum, edge) => sum + mergeIntervals(edge.coverage).reduce((total, [low, high]) => total + high - low, 0), 0);
    const missingLength = Math.max(0, room.perimeter - coveredLength);
    if (missingLength > 1e-5) {
      if (solid && sortedRegions[index].source === 'walls') throw new RangeError(`${room.name}的房间边界与实际墙体不匹配，请重新生成房间`);
      room.wallArea += missingLength * config.wallHeight;
      room.wallTileArea += room.wet ? missingLength * Math.min(config.wetWallHeight, config.wallHeight) : 0;
      room.wallEstimate = true;
      room.estimatedBoundaryLength = Number(formatQuantity(missingLength, 10));
      warnings.push(`${room.name}有 ${formatQuantity(missingLength)} m 边界未关联实际墙体，该部分按 ${config.wallHeight} m 高度估算；已关联部分按实际墙体计量`);
    }
    room.wallArea = Number(formatQuantity(Math.max(0, room.wallArea), 10));
    room.wallTileArea = Number(formatQuantity(Math.min(room.wallArea, Math.max(0, room.wallTileArea)), 10));
    room.paintArea = Number(formatQuantity(Math.max(0, room.wallArea - room.wallTileArea), 10));
    room.doorWidth = Number(formatQuantity(room.doorWidth, 10));
    room.windowArea = Number(formatQuantity(room.windowArea, 10));
  }
  const unassigned = (solid?.openings ?? []).filter(opening => opening.kind !== 'hole' && !openingSides.get(opening.id)?.length);
  if (unassigned.length) warnings.push(`${unassigned.length} 个门窗未关联房间，未自动计入本体费用`);
  return { config, rooms, totalArea: rooms.reduce((sum, room) => sum + room.netArea, 0), warnings };
}

export type FinishLayer = { id: string; code: string; name: string; group: string; unit: string; quantity(room: FinishRoom, config: FinishConfig): number; enabled?(room: FinishRoom, config: FinishConfig): boolean; estimate?: boolean; wall?: boolean; includesBase: boolean; feature: string; note: string };
const WET = (room: FinishRoom) => room.wet;
const FINISH_LAYER_DEFINITIONS: Omit<FinishLayer, 'includesBase'>[] = [
  { id: 'floor-level', code: '011101006', name: '平面砂浆找平层', group: '地面', unit: 'm²', quantity: r => r.netArea, feature: '20 mm 厚 1:3 水泥砂浆', note: '含基层清理；面层另列，不重复列基层清理' },
  { id: 'floor-waterproof', code: '010904002', name: '楼（地）面涂膜防水', group: '地面', unit: 'm²', quantity: (r, c) => r.netArea + r.perimeter * c.wetUpstand, enabled: WET, feature: '湿区地面涂膜防水', note: '仅湿区；地面净面积加周边上翻面积' },
  { id: 'floor-adhesive', code: '011102001', name: '地砖粘结层', group: '地面', unit: 'm²', quantity: r => r.netArea, feature: '瓷砖胶粘结层，厚度按产品施工要求', note: '不含找平、防水和面层材料' },
  { id: 'floor-surface', code: '011102003', name: '块料楼地面材料供应', group: '地面', unit: 'm²', quantity: (r, c) => r.netArea * (1 + c.floorWasteRate / 100), feature: '面层材料，规格由实际产品确认', note: '材料采购量含损耗；不含找平层、粘结层及铺装人工，人工按净面积另列' },
  { id: 'floor-install', code: '011102003', name: '楼地面面层铺装人工', group: '地面', unit: 'm²', quantity: r => r.netArea, feature: '面层铺装人工，基层工序另列', note: '按净施工面积计取，材料损耗不计人工' },
  { id: 'skirting', code: '011105003', name: '块料踢脚线', group: '地面', unit: 'm', quantity: r => Math.max(0, r.perimeter - r.doorWidth), feature: '成品踢脚线，规格由实际产品确认', note: '房间边界周长扣除门洞在地面的真实宽度' },
  { id: 'wall-base', code: '011201002', name: '墙面基层处理及界面剂', group: '墙面', unit: 'm²', quantity: r => r.wallArea, wall: true, feature: '界面剂及基层处理', note: '仅计室内实际裸露的墙体左右侧面，扣除真实洞口；不计墙端面及洞口内壁' },
  { id: 'wall-plaster', code: '011201001', name: '墙面一般抹灰', group: '墙面', unit: 'm²', quantity: r => r.wallArea, wall: true, feature: '15 mm 厚墙面抹灰', note: '墙面瓷砖不含基层抹灰，本项单列' },
  { id: 'wall-putty', code: '011407002', name: '墙面腻子两遍', group: '墙面', unit: 'm²', quantity: r => r.paintArea, wall: true, feature: '涂料 / 壁纸基层，两遍腻子', note: '只计涂料或壁纸区域，瓷砖区域不计腻子' },
  { id: 'wall-paint', code: '011407001', name: '墙面喷刷涂料 / 壁纸', group: '墙面', unit: 'm²', quantity: r => r.paintArea, wall: true, feature: '面层规格按装修档次及实际报价确定', note: '不含基层处理、抹灰和腻子；与湿区瓷砖区域互斥' },
  { id: 'wall-tile', code: '011204001', name: '墙面块料面层', group: '墙面', unit: 'm²', quantity: r => r.wallTileArea, enabled: WET, wall: true, feature: '湿区墙砖，建议 300 × 600 mm', note: '不含基层抹灰；按实际墙体表面在贴砖高度以下裁剪，真实扣除门窗轮廓' },
  { id: 'ceiling-base', code: '011301001', name: '天棚基层处理', group: '天棚', unit: 'm²', quantity: r => r.netArea, feature: '平面天棚基层处理', note: '按房间净投影面积；不含吊顶、灯具' },
  { id: 'ceiling-keel', code: '011302001', name: '吊顶天棚龙骨', group: '天棚', unit: 'm²', quantity: r => r.netArea, enabled: (_r, c) => c.ceiling, feature: '轻钢龙骨，间距及吊杆按施工做法确认', note: '龙骨按净投影面积；不含面板、灯具安装和开孔' },
  { id: 'ceiling-board', code: '011302001', name: '吊顶天棚面板材料', group: '天棚', unit: 'm²', quantity: (r, c) => r.netArea * (1 + c.ceilingWasteRate / 100), enabled: (_r, c) => c.ceiling, feature: '石膏板，建议 9.5 mm，实际规格待确认', note: '材料采购量含损耗；不含龙骨、饰面、灯具及安装开孔' },
  { id: 'ceiling-paint', code: '011407003', name: '天棚饰面', group: '天棚', unit: 'm²', quantity: r => r.netArea, feature: '天棚腻子及乳胶漆，按实际做法确认', note: '按净投影面积；不含龙骨和面板' },
  { id: 'light-cove', code: '011302002', name: '天棚跌级 / 灯槽', group: '天棚', unit: 'm', quantity: r => r.perimeter * .3, enabled: (_r, c) => c.ceiling && c.lightCove, estimate: true, feature: '按房间周长 × 0.3 的长度指标', note: '初步估算；实际灯槽长度需按吊顶图核对，不含灯具' },
  { id: 'door-body', code: '010801001', name: '木质门本体', group: '门窗', unit: '樘', quantity: r => r.ownedDoorIds.length, feature: '门洞实际宽、高、厚度见各门记录', note: '每个实际门只计一次；不含门套、五金及安装' },
  { id: 'door-hardware', code: '010801002', name: '门五金', group: '门窗', unit: '套', quantity: r => r.ownedDoorIds.length, feature: '锁具及合页，按选用五金规格确认', note: '本体和安装另列；共墙两侧不重复计价' },
  { id: 'door-install', code: '010801003', name: '门安装', group: '门窗', unit: '樘', quantity: r => r.ownedDoorIds.length, feature: '门安装人工及固定辅材', note: '不含门本体、五金和门套' },
  { id: 'door-casing', code: '010801004', name: '门套', group: '门窗', unit: '樘', quantity: r => r.ownedDoorIds.length, enabled: (_r, c) => c.doorCasings, feature: '门套规格和墙厚按实际门记录确认', note: '可选工序；门本体不含门套' },
  { id: 'window-body', code: '010807001', name: '金属窗本体', group: '门窗', unit: '樘', quantity: r => r.ownedWindowIds.length, feature: '窗洞实际宽、高、厚度见各窗记录', note: '每个实际窗只计一次；不含五金及安装' },
  { id: 'window-hardware', code: '010807002', name: '窗五金', group: '门窗', unit: '套', quantity: r => r.ownedWindowIds.length, feature: '执手及铰链，按实际产品确认', note: '本体和安装另列' },
  { id: 'window-install', code: '010807003', name: '窗安装', group: '门窗', unit: '樘', quantity: r => r.ownedWindowIds.length, feature: '窗安装人工及固定辅材', note: '不含窗本体及五金' },
  { id: 'switches', code: '030404034', name: '照明开关', group: '水电', unit: '个', quantity: r => r.points.switches, estimate: true, feature: '按空间类型建议点位，可调整', note: '初步估算，实际点位应按电气施工图核对' },
  { id: 'sockets', code: '030404035', name: '插座', group: '水电', unit: '个', quantity: r => r.points.sockets, estimate: true, feature: '按空间类型建议点位，可调整', note: '初步估算，实际点位应按电气施工图核对' },
  { id: 'lights', code: '030412005', name: '灯具', group: '水电', unit: '套', quantity: r => r.points.lights, estimate: true, feature: '按空间类型建议点位，可调整', note: '初步估算；吊顶工序不含灯具安装和开孔' },
  { id: 'conduit', code: '030411001', name: '配管', group: '水电', unit: 'm', quantity: (r, c) => r.netArea * c.conduitPerArea, estimate: true, feature: '照明及插座配管，管径按电气图确认', note: '初步估算：净面积 × 配管面积指标，非实际管线路径长度' },
  { id: 'wire', code: '030412001', name: '配线', group: '水电', unit: 'm', quantity: (r, c) => r.netArea * c.conduitPerArea * c.wireMultiplier, estimate: true, feature: '导线规格与回路按电气图确认', note: '初步估算：配管长度 × 导线倍数，非实际综合算量' },
  { id: 'water-pipe', code: '031001001', name: '给水管道', group: '水电', unit: 'm', quantity: (_r, c) => c.waterPerWetRoom, enabled: WET, estimate: true, feature: '湿区给水，管径和材质按实际设计确认', note: '初步估算：每个湿区按长度指标，未读取实际路径' },
  { id: 'drain-pipe', code: '031001006', name: '排水管道', group: '水电', unit: 'm', quantity: (_r, c) => c.drainPerWetRoom, enabled: WET, estimate: true, feature: '湿区排水，管径和材质按实际设计确认', note: '初步估算：每个湿区按长度指标，未读取实际路径' },
  { id: 'water-points', code: '031004001', name: '给水点安装', group: '水电', unit: '个', quantity: r => r.points.water, estimate: true, feature: '按空间类型建议点位，可调整', note: '初步估算，实际器具和点位应按给排水图核对' },
  { id: 'drain-points', code: '031004002', name: '排水点安装', group: '水电', unit: '个', quantity: r => r.points.drains, estimate: true, feature: '按空间类型建议点位，可调整', note: '初步估算，实际器具和点位应按给排水图核对' },
];
export const FINISH_LAYERS: FinishLayer[] = FINISH_LAYER_DEFINITIONS.map(layer => ({ ...layer, includesBase: ['floor-level', 'ceiling-paint'].includes(layer.id) }));

function savedPrice(item: QuoteItem, labor = false): { value: string; status: PriceStatus; note: string } {
  const value = normalizeDecimal(labor ? item.laborRate ?? '0' : item.unitPrice, labor ? '区域人工单价' : '区域材料单价');
  const provenance = item.provenance;
  const status = value === '0' ? 'missing' : item.demo ? 'reference' : 'confirmed';
  return { value, status, note: `${labor ? '人工' : '材料'}单价取已保存区域配置${item.demo ? '（示例价格，需替换）' : ''}；${provenance?.source || '用户材料配置'}${provenance?.region ? '；地区 ' + provenance.region : ''}${provenance?.priceDate ? '；日期 ' + provenance.priceDate : ''}${provenance?.spec ? '；规格 ' + provenance.spec : ''}` };
}

export function calculateFinish(project: Project): CostItem[] {
  const state = project.cost?.modules?.finish;
  if (!state?.enabled) return [];
  const model = buildFinishModel(project, state.config ?? {}), { config, rooms } = model;
  const codeCounts = new Map<string, number>();
  const items: CostItem[] = [];
  for (const room of rooms) {
    const region = project.regions.find(value => value.id === room.regionId);
    const selected = region.items?.find(item => item.unit === 'm²' && item.quantityMode === 'area');
    for (const layer of FINISH_LAYERS) {
      if (layer.enabled && !layer.enabled(room, config)) continue;
      const quantity = layer.quantity(room, config);
      if (quantity <= EPS) continue;
      const sequence = (codeCounts.get(layer.code) ?? 0) + 1;
      if (sequence > 999) throw new RangeError('同类装修工序超过 999 项，请拆分工程');
      codeCounts.set(layer.code, sequence);
      let value = '0', status: PriceStatus = 'missing', priceNote = '未提供施工报价，请填写实际工序单价';
      const configured = config.gradePrices[room.grade]?.[layer.id];
      if (configured !== undefined) { value = configured; status = 'confirmed'; priceNote = `${FINISH_GRADES[room.grade]}档次工序单价由用户配置`; }
      else if (selected && (layer.id === 'floor-surface' || layer.id === 'floor-install')) {
        const price = savedPrice(selected, layer.id === 'floor-install'); value = price.value; status = price.status; priceNote = price.note;
      } else if (layer.id === 'floor-surface') {
        const material = config.materials.find(material => material.unit === 'm²' && /瓷砖|地砖/.test(material.name));
        if (material) {
          value = normalizeDecimal(material.unitPrice, '材料库单价'); status = value === '0' ? 'missing' : material.demo ? 'reference' : 'confirmed';
          priceNote = `材料供应单价取生成时材料库快照：${material.name}；${material.provenance?.source || (material.demo ? '示例价格，需替换' : '用户材料库')}${material.provenance?.priceDate ? '；日期 ' + material.provenance.priceDate : ''}`;
        }
      }
      let feature = `${SPACE_TYPES[room.spaceType]} · ${FINISH_GRADES[room.grade]}；${layer.feature}`;
      if (layer.id === 'floor-surface') feature += `；采购损耗 ${config.floorWasteRate}%${selected ? '；' + (selected.materialName || '区域已选材料') : ''}`;
      if (layer.id === 'floor-waterproof') feature += `；上翻 ${formatQuantity(config.wetUpstand * 1000)} mm`;
      if (layer.id === 'wall-tile') feature += `；贴砖高度上限 ${config.wetWallHeight} m`;
      if (layer.id === 'ceiling-board') feature += `；采购损耗 ${config.ceilingWasteRate}%`;
      if (layer.id === 'door-body' || layer.id === 'window-body') {
        const ids = layer.id === 'door-body' ? room.ownedDoorIds : room.ownedWindowIds;
        feature += '；' + ids.map(id => { const opening = project.openings.find(value => value.id === id); return `${opening.name || (opening.kind === 'door' ? '门' : '窗')} ${opening.width / 100}×${opening.height / 100} m，厚 ${opening.depth} cm`; }).join(' / ');
      }
      items.push(createCostItem({ id: `finish:${room.regionId}:${layer.id}`, section: '装饰装修', category: '分部分项', code: layer.code + String(sequence).padStart(3, '0'),
        name: layer.id === 'floor-surface' && selected?.materialName ? `${selected.materialName}楼地面材料供应` : layer.name,
        feature, unit: layer.unit, quantity: formatQuantity(quantity, 10), unitPrice: value,
        ...(layer.id === 'floor-surface' ? { wasteRate: String(config.floorWasteRate) } : layer.id === 'ceiling-board' ? { wasteRate: String(config.ceilingWasteRate) } : {}),
        estimate: Boolean(layer.estimate || layer.wall && room.wallEstimate), priceStatus: status, source: 'generated',
        group: `${room.name} · ${layer.group}`, groupId: room.regionId, basis: `${room.name}；${layer.group}`,
        note: `${layer.note}；${layer.wall && room.wallEstimate ? `${formatQuantity(room.estimatedBoundaryLength)} m 未匹配边界按用户高度初步估算，其余按实际墙体；` : ''}${priceNote}；编码为示意，以当地清单规范为准` }));
    }
  }
  return applyModulePrices(items, state);
}
