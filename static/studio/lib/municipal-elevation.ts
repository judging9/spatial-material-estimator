import type { MunicipalElement, Point, Project } from '../types.js';
import { municipalElementPreset, municipalScale, validateMunicipalElements } from './municipal-design.js';
import { createRoadProfile, roadPointAtStation, roadProfileElevation, roadStations, validateRoadProfile, type RoadProfilePoint } from './road-profile.js';
import { compileTerrain, terrainElevation, type TerrainMesh, type TerrainModel, type TerrainTriangle } from './terrain.js';

/** Public distances and elevations are metres. Persisted element.elevation
 * and pipeline point.z retain the existing centimetre representation. */
export type MunicipalTerrainAlignment = { offset?: number; follow?: boolean };
export type MunicipalElevationSummary = {
  elevation: number;
  anchorElevation: number;
  groundElevation: number | null;
  anchorDelta: number | null;
  reference: 'top' | 'base' | 'center' | 'water';
  referenceLabel: string;
  profileEnabled: boolean;
  terrainAvailable: boolean;
  sampledPointCount: number;
  coveredPointCount: number;
  sampleCoverage: 'none' | 'partial' | 'complete';
  sampleScope: 'anchor' | 'control-points-and-midpoints';
  minSampleOffset: number | null;
  maxSampleOffset: number | null;
  sampledBelowTerrain: boolean;
  warnings: string[];
};

const MAX_ELEVATION = 1000;
const MAX_PROFILE_POINTS = 100;
const MAX_SEGMENT_BREAKS = 100000;
const EPS = 1e-9;
const numeric = (value: number, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name}须为有效的米制数字。`);
  return value;
};
const validElevation = (value: number): number => {
  numeric(value, '标高');
  if (Math.abs(value) > MAX_ELEVATION) throw new RangeError('市政标高须在 −1000 m 至 +1000 m 之间。');
  return value === 0 ? 0 : value;
};
const elementIn = (project: Project, elementOrId: MunicipalElement | string): MunicipalElement => {
  if (typeof elementOrId !== 'string') {
    if (!elementOrId?.points?.length) throw new RangeError('请先选择有效的市政对象。');
    return elementOrId;
  }
  const element = project.municipalElements?.find(item => item.id === elementOrId);
  if (!element) throw new RangeError('市政对象不存在，请重新选择。');
  return element;
};
const datumElevation = (element: MunicipalElement): number => element.kind === 'road' && element.roadProfile?.enabled
  ? element.roadProfile.points[0].elevation : element.elevation / 100;
const anchorElevation = (element: MunicipalElement): number => element.kind === 'pipeline'
  ? (element.points[0].z ?? element.elevation) / 100 : datumElevation(element);

function editableProject(project: Project, id: string): { project: Project; element: MunicipalElement } {
  const source = elementIn(project, id);
  if (source.locked) throw new RangeError('此对象已锁定，请先解锁再调整高度。');
  validateMunicipalElements([source], project);
  validateRoadProfile(project, source);
  const next = structuredClone(project);
  return { project: next, element: elementIn(next, id) };
}

function finish(project: Project, element: MunicipalElement): Project {
  validElevation(element.elevation / 100);
  for (const point of element.points) if (point.z !== undefined) validElevation(point.z / 100);
  if (element.kind === 'road' && element.roadProfile?.enabled) {
    for (const point of element.roadProfile.points) validElevation(point.elevation);
  }
  validateMunicipalElements([element], project);
  validateRoadProfile(project, element);
  return project;
}

function translateElevation(element: MunicipalElement, elevation: number): void {
  const previous = element.elevation, delta = elevation - datumElevation(element);
  if (element.kind === 'road' && element.roadProfile?.enabled) {
    element.roadProfile.points = element.roadProfile.points.map(point => ({ ...point, elevation: validElevation(point.elevation + delta) }));
  }
  element.elevation = validElevation(elevation) * 100;
  element.points = element.points.map(point => element.kind === 'pipeline'
    ? { ...point, z: validElevation(((point.z ?? previous) / 100) + delta) * 100 }
    : point.z === undefined ? point : { ...point, z: element.elevation });
}

/** Set the absolute datum; preserve grade differences, curves and pricing.
 * For a graded road the datum is its profile start. For a pipeline it is the
 * existing element datum, so explicit per-node height differences survive. */
export function setMunicipalElevation(project: Project, id: string, elevationMeters: number): Project {
  validElevation(elevationMeters);
  const draft = editableProject(project, id);
  translateElevation(draft.element, elevationMeters);
  return finish(draft.project, draft.element);
}

/** An overall vertical translation; no plan coordinates or stations change. */
export function shiftMunicipalElevation(project: Project, id: string, deltaMeters: number): Project {
  numeric(deltaMeters, '高度变化');
  const draft = editableProject(project, id);
  translateElevation(draft.element, validElevation(datumElevation(draft.element) + deltaMeters));
  return finish(draft.project, draft.element);
}

/** A simple start/end grade on the full horizontal alignment. Replaces old
 * intermediate grades and curves while retaining all other profile options. */
export function setRoadEndpointElevations(project: Project, id: string, startMeters: number, endMeters: number): Project {
  validElevation(startMeters); validElevation(endMeters);
  const draft = editableProject(project, id), road = draft.element;
  if (road.kind !== 'road') throw new RangeError('起终点纵坡仅适用于道路。');
  const length = roadStations(draft.project, road)?.at(-1);
  if (!length || length <= EPS) throw new RangeError('请先校准图纸并画出有效的道路中心线。');
  const profile = road.roadProfile ?? createRoadProfile(draft.project, road);
  profile.enabled = true;
  profile.points = [
    { id: `endpoint-grade-${road.id}-0`, station: 0, elevation: startMeters },
    { id: `endpoint-grade-${road.id}-1`, station: length, elevation: endMeters },
  ];
  road.roadProfile = profile;
  road.elevation = startMeters * 100;
  road.points = road.points.map(point => point.z === undefined ? point : { ...point, z: road.elevation });
  return finish(draft.project, road);
}

function terrainContext(project: Project): { model: TerrainModel; mesh: TerrainMesh; scale: number } {
  const scale = municipalScale(project);
  if (!scale) throw new RangeError('请先校准图纸比例，才能匹配实际地形高程。');
  const model = project.municipalTerrain;
  if (!model) throw new RangeError('请先创建或导入地形，再将对象贴地。');
  const mesh = compileTerrain(model);
  if (!mesh.triangles.length) throw new RangeError('地形尚未形成有效表面，请补充测点或有效栅格。');
  return { model, mesh, scale };
}

/** The real ground elevation at the first plan anchor; never extrapolated
 * outside measured coverage and independent of canvas zoom or terrain visibility. */
export function terrainReferenceElevation(project: Project, elementOrId: MunicipalElement | string): number | null {
  const element = elementIn(project, elementOrId), scale = municipalScale(project);
  if (!scale || !project.municipalTerrain) return null;
  const mesh = compileTerrain(project.municipalTerrain), point = element.points[0];
  return terrainElevation(project.municipalTerrain, point.x * scale, point.y * scale, mesh);
}

const defaultOffset = (element: MunicipalElement): number => element.kind === 'river' ? 0 : municipalElementPreset(element).elevation / 100;
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const vector = (a: Point, b: Point): Point => ({ x: b.x - a.x, y: b.y - a.y });
const bounds = (points: Point[]) => ({ minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) });
const meet = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) => a.minX <= b.maxX + EPS && a.maxX >= b.minX - EPS && a.minY <= b.maxY + EPS && a.maxY >= b.minY - EPS;

/** Intersections with every terrain edge partition a line into intervals
 * lying on one measured affine triangle, including paths along shared edges.
 * This finds short peaks and NoData holes that regular sampling would miss. */
function edgeBreaks(a: Point, b: Point, triangles: { triangle: TerrainTriangle; bounds: ReturnType<typeof bounds> }[]): number[] {
  const r = vector(a, b), lengthSquared = r.x * r.x + r.y * r.y, box = bounds([a, b]), result = [0, 1];
  const add = (t: number) => { if (t >= -1e-12 && t <= 1 + 1e-12) result.push(Math.max(0, Math.min(1, t))); };
  for (const target of triangles) {
    if (!meet(box, target.bounds)) continue;
    for (let i = 0; i < 3; i++) {
      const c = target.triangle[i], d = target.triangle[(i + 1) % 3], s = vector(c, d), w = vector(a, c), det = cross(r, s);
      const tolerance = Number.EPSILON * 64 * Math.max(1, Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y));
      if (Math.abs(det) > tolerance) {
        const t = cross(w, s) / det, u = cross(w, r) / det;
        if (u >= -1e-12 && u <= 1 + 1e-12) add(t);
      } else {
        const collinearTolerance = Number.EPSILON * 64 * Math.max(1, Math.hypot(r.x, r.y) * Math.hypot(w.x, w.y));
        if (Math.abs(cross(r, w)) <= collinearTolerance) {
          add((w.x * r.x + w.y * r.y) / lengthSquared);
          const end = vector(a, d); add((end.x * r.x + end.y * r.y) / lengthSquared);
        }
      }
    }
    if (result.length > MAX_SEGMENT_BREAKS) throw new RangeError('道路与地形边界交点过多，请缩小范围或降低地形网格密度。');
  }
  result.sort((a, b) => a - b);
  const length = Math.sqrt(lengthSquared), tolerance = Math.max(1e-10, Number.EPSILON * 64 * length);
  const unique = [0];
  for (const t of result) {
    if (t <= 0 || t >= 1) continue;
    if ((t - unique.at(-1)) * length > tolerance && (1 - t) * length > tolerance) unique.push(t);
  }
  unique.push(1);
  return unique;
}

/** Remove only round-off-collinear controls, never approximate away an
 * actual ridge. Streaming keeps long affine grids small and memory bounded. */
function appendControl(points: RoadProfilePoint[], station: number, elevation: number): void {
  if (points.length && Math.abs(points.at(-1).station - station) <= EPS) {
    if (Math.abs(points.at(-1).elevation - elevation) > 1e-8) throw new RangeError('地形高程在道路节点不连续，请核对测量数据。');
    return;
  }
  const point: RoadProfilePoint = { id: '', station, elevation };
  while (points.length >= 2) {
    const a = points[points.length - 2], b = points[points.length - 1];
    const predicted = a.elevation + (point.elevation - a.elevation) * (b.station - a.station) / (point.station - a.station);
    const tolerance = Number.EPSILON * 128 * Math.max(1, Math.abs(a.elevation), Math.abs(b.elevation), Math.abs(point.elevation));
    if (Math.abs(predicted - b.elevation) > tolerance) break;
    points.pop();
  }
  points.push(point);
  // Only the last point can disappear on a later append. With 102 controls,
  // at least 101 controls are already indispensable, beyond the file format.
  if (points.length > MAX_PROFILE_POINTS + 1) throw new RangeError('地形沿线超过 100 个实际坡折，无法完整生成纵断面；请缩小道路范围或降低网格密度。');
}

function terrainRoadProfile(project: Project, road: MunicipalElement, offset: number, context: ReturnType<typeof terrainContext>): void {
  const stations = roadStations(project, road);
  if (!stations?.at(-1)) throw new RangeError('请先画出有效的道路中心线。');
  const triangles = context.mesh.triangles.map(triangle => ({ triangle, bounds: bounds(triangle) })), points: RoadProfilePoint[] = [];
  const groundAt = (a: Point, b: Point, t: number) => terrainElevation(context.model, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, context.mesh);
  for (let i = 1; i < road.points.length; i++) {
    const a = { x: road.points[i - 1].x * context.scale, y: road.points[i - 1].y * context.scale };
    const b = { x: road.points[i].x * context.scale, y: road.points[i].y * context.scale };
    const breaks = edgeBreaks(a, b, triangles), length = stations[i] - stations[i - 1];
    for (let j = 0; j < breaks.length; j++) {
      if (j && groundAt(a, b, (breaks[j - 1] + breaks[j]) / 2) === null) {
        throw new RangeError('道路中段存在地形未覆盖或 NoData 区域，不能自动贴地；请补充地形或调整路线。');
      }
      const ground = groundAt(a, b, breaks[j]);
      if (ground === null) throw new RangeError('道路节点超出有效地形范围，不能自动贴地。');
      appendControl(points, stations[i - 1] + length * breaks[j], validElevation(ground + offset));
    }
  }
  if (points.length > MAX_PROFILE_POINTS) throw new RangeError('地形沿线超过 100 个实际坡折，无法完整生成纵断面；请缩小道路范围或降低网格密度。');
  const profile = road.roadProfile ?? createRoadProfile(project, road);
  profile.enabled = true;
  profile.points = points.map((point, i) => ({ ...point, id: `terrain-grade-${road.id}-${i}` }));
  // Replacing the PVI controls deliberately replaces old vertical curves.
  // Crossfall, side slopes, graph interval, earthwork rates and all source
  // metadata stay intact. Tunnel intervals use unchanged horizontal stations.
  road.roadProfile = profile;
  road.elevation = profile.points[0].elevation * 100;
  road.points = road.points.map(point => point.z === undefined ? point : { ...point, z: road.elevation });
}

/** Place at actual measured ground + an explicit relative offset. By default
 * the first anchor defines an overall translation. follow=true creates an
 * exact terrain-grade road profile or matches each original pipeline node.
 * Any uncovered point, hole or invalid result rejects the entire operation. */
export function alignMunicipalToTerrain(project: Project, id: string, options: MunicipalTerrainAlignment = {}): Project {
  if (!options || typeof options !== 'object' || options.follow !== undefined && typeof options.follow !== 'boolean') throw new RangeError('地形匹配选项无效。');
  if (options.offset !== undefined) numeric(options.offset, '相对地形高度');
  const draft = editableProject(project, id), context = terrainContext(draft.project), element = draft.element;
  const offset = options.offset ?? defaultOffset(element);
  if (options.follow && element.kind === 'road') terrainRoadProfile(draft.project, element, offset, context);
  else if (options.follow && element.kind === 'pipeline') {
    element.points = element.points.map(point => {
      const ground = terrainElevation(context.model, point.x * context.scale, point.y * context.scale, context.mesh);
      if (ground === null) throw new RangeError('管线节点超出有效地形范围，不能自动匹配埋深。');
      return { ...point, z: validElevation(ground + offset) * 100 };
    });
    element.elevation = element.points[0].z;
  } else {
    if (options.follow) throw new RangeError('随地形逐点匹配仅适用于道路和管线，其它对象请使用整体贴地。');
    const point = element.points[0], ground = terrainElevation(context.model, point.x * context.scale, point.y * context.scale, context.mesh);
    if (ground === null) throw new RangeError('对象锚点超出有效地形范围，请调整位置或补充地形。');
    // Pipeline datum can differ from its first node on imported projects.
    // Translate by the real anchor delta so the first pipe centre is at the
    // requested burial depth without destroying the original pipe gradient.
    const target = element.kind === 'pipeline' ? datumElevation(element) + ground + offset - anchorElevation(element) : ground + offset;
    translateElevation(element, validElevation(target));
  }
  return finish(draft.project, element);
}

function reference(element: MunicipalElement): Pick<MunicipalElevationSummary, 'reference' | 'referenceLabel'> {
  if (element.kind === 'pipeline') return { reference: 'center', referenceLabel: '管中心标高' };
  if (element.kind === 'river') return { reference: 'water', referenceLabel: '水面标高' };
  if (['streetlight', 'trafficlight', 'facility', 'fence', 'kerb', 'manhole'].includes(element.kind)) return { reference: 'base', referenceLabel: element.kind === 'manhole' ? '井底标高' : '底部标高' };
  return { reference: 'top', referenceLabel: element.kind === 'bridge' ? '桥面标高' : '顶面标高' };
}

/** Coverage and burial warnings below are explicitly control-point/midpoint
 * samples, not a whole-surface grading certificate. Exact continuous terrain
 * coverage is required independently by the road-follow operation above. */
export function municipalElevationSummary(project: Project, elementOrId: MunicipalElement | string): MunicipalElevationSummary {
  const element = elementIn(project, elementOrId), scale = municipalScale(project), profileEnabled = element.kind === 'road' && Boolean(element.roadProfile?.enabled);
  const result: MunicipalElevationSummary = { ...reference(element), elevation: datumElevation(element), anchorElevation: anchorElevation(element), groundElevation: null, anchorDelta: null,
    profileEnabled, terrainAvailable: false, sampledPointCount: 0, coveredPointCount: 0, sampleCoverage: 'none', sampleScope: element.points.length > 1 ? 'control-points-and-midpoints' : 'anchor',
    minSampleOffset: null, maxSampleOffset: null, sampledBelowTerrain: false, warnings: [] };
  if (!scale || !project.municipalTerrain) {
    result.warnings.push(!scale ? '图纸尚未校准，无法比较实际地形高程。' : '尚无地形，对象使用用户设定的绝对标高。');
    return result;
  }
  const model = project.municipalTerrain, mesh = compileTerrain(model), samples: { x: number; y: number; z: number }[] = [];
  result.terrainAvailable = mesh.triangles.length > 0;
  const anchor = element.points[0];
  result.groundElevation = terrainElevation(model, anchor.x * scale, anchor.y * scale, mesh);
  result.anchorDelta = result.groundElevation === null ? null : result.anchorElevation - result.groundElevation;
  if (element.kind === 'road') {
    const stations = roadStations(project, element), control = [...new Set([...(stations ?? []), ...(profileEnabled ? element.roadProfile.points.map(point => point.station) : [])])].sort((a, b) => a - b);
    const all = [...control, ...control.slice(1).map((station, i) => (control[i] + station) / 2)];
    for (const station of all) {
      const point = roadPointAtStation(project, element, station);
      if (point) samples.push({ ...point, z: profileEnabled ? roadProfileElevation(element.roadProfile, station) : result.elevation });
    }
  } else {
    const points = element.points.map(point => ({ x: point.x * scale, y: point.y * scale, z: element.kind === 'pipeline' ? (point.z ?? element.elevation) / 100 : result.elevation }));
    samples.push(...points);
    const last = ['paving', 'green'].includes(element.kind) ? points.length : points.length - 1;
    for (let i = 0; i < last; i++) {
      const a = points[i], b = points[(i + 1) % points.length]; samples.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
    }
  }
  const offsets: number[] = [];
  for (const point of samples) { const ground = terrainElevation(model, point.x, point.y, mesh); if (ground !== null) offsets.push(point.z - ground); }
  result.sampledPointCount = samples.length;
  result.coveredPointCount = offsets.length;
  result.sampleCoverage = !offsets.length ? 'none' : offsets.length === samples.length ? 'complete' : 'partial';
  result.minSampleOffset = offsets.length ? Math.min(...offsets) : null;
  result.maxSampleOffset = offsets.length ? Math.max(...offsets) : null;
  result.sampledBelowTerrain = offsets.some(offset => offset < -1e-6);
  if (result.groundElevation === null) result.warnings.push('首个锚点未被有效地形覆盖，无法确定相对地形高度。');
  if (result.sampleCoverage !== 'complete') result.warnings.push('部分控制点或中点未被有效地形覆盖；此提示仅检查采样点。');
  if (element.kind === 'road' && result.sampledBelowTerrain) result.warnings.push('部分道路采样点低于地形；请确认纵断面、开挖设计或设置隧道。');
  return result;
}
