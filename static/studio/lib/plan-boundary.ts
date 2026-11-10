import { intersectionArea, pointInRegion, polygonArea, polygonPerimeter, validatePolygon, validateRegion } from './geometry.js';
import { normalizeWalls, wallFootprint, type Point, type Wall } from './wall-plan.js';
import { wallFootprints, type WallJoinStyle } from './wall-joins.js';
import { furnitureFootprint, validateFurniture } from './furniture.js';
import type { Project, Furniture } from '../types.js';

export type PlanBoundary = { points: Point[] };
export type BoundaryValidation = { valid: boolean; error: string | null; code?: string; wallId?: string; regionId?: string; furnitureId?: string; outsideArea?: number };
export type BoundaryFootprint = { wallId: string; points: Point[] };
type PolygonRegion = { id?: string; points: Point[]; holes?: Point[][] };
type BoundaryProject = { walls?: Wall[]; regions?: PolygonRegion[]; planBoundary?: PlanBoundary | null; wallJoinStyle?: WallJoinStyle;
  furniture?: Furniture[]; drawing?: Project['drawing']; calibration?: Project['calibration'] };
const valid = (): BoundaryValidation => ({ valid: true, error: null });
const invalid = (error: string, code: string, extra: Partial<BoundaryValidation> = {}): BoundaryValidation => ({ valid: false, error, code, ...extra });
const finite = (p: Point) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });

/** A boundary is a simple drawing-coordinate ring, without a repeated end. */
export function validatePlanBoundary(boundary?: PlanBoundary | null): BoundaryValidation {
  if (boundary == null) return valid();
  if (!boundary || !Array.isArray(boundary.points)) return invalid('项目边界必须是有效多边形。', 'invalid_boundary');
  if (boundary.points.length > 200) return invalid('项目边界最多支持 200 个顶点。', 'boundary_limit');
  if (boundary.points.some(p => !finite(p) || Math.abs(p.x) > 1_000_000 || Math.abs(p.y) > 1_000_000)) return invalid('项目边界坐标超出有效范围。', 'invalid_coordinate');
  const result = validatePolygon(boundary.points);
  return result.valid ? valid() : invalid('项目边界无效：' + result.error, result.code || 'invalid_boundary');
}

/** Test every interval split by boundary intersections. Endpoint checks alone
 * would accept a segment crossing the missing notch of a concave boundary. */
export function segmentWithinBoundary(start: Point, end: Point, boundary?: PlanBoundary | null): boolean {
  if (!finite(start) || !finite(end) || !validatePlanBoundary(boundary).valid) return false;
  if (!boundary) return true;
  const region = { points: boundary.points, holes: [] };
  if (!pointInRegion(start, region) || !pointInRegion(end, region)) return false;
  const direction = sub(end, start), length = Math.hypot(direction.x, direction.y);
  if (length < 1e-9) return true;
  const epsilon = Math.max(1e-8, length * 1e-12), cuts = [0, 1];
  const parameter = (p: Point) => ((p.x - start.x) * direction.x + (p.y - start.y) * direction.y) / (length * length);
  for (let i = 0; i < boundary.points.length; i++) {
    const a = boundary.points[i], b = boundary.points[(i + 1) % boundary.points.length], edge = sub(b, a), offset = sub(a, start), edgeLength = Math.hypot(edge.x, edge.y);
    const denominator = cross(direction, edge);
    if (Math.abs(denominator) <= 1e-12 * length * edgeLength) {
      if (Math.abs(cross(direction, offset)) > epsilon * length) continue;
      for (const p of [a, b]) { const t = parameter(p); if (t > 0 && t < 1) cuts.push(t); }
    } else {
      const t = cross(offset, edge) / denominator, u = cross(offset, direction) / denominator;
      if (t >= -epsilon / length && t <= 1 + epsilon / length && u >= -epsilon / edgeLength && u <= 1 + epsilon / edgeLength) cuts.push(Math.max(0, Math.min(1, t)));
    }
  }
  const ordered = cuts.sort((a, b) => a - b).filter((t, i, all) => !i || (t - all[i - 1]) * length > epsilon);
  for (let i = 1; i < ordered.length; i++) {
    const t = (ordered[i - 1] + ordered[i]) / 2;
    if (!pointInRegion({ x: start.x + direction.x * t, y: start.y + direction.y * t }, region)) return false;
  }
  return true;
}

/** Real polygon intersection, in coordinate-units squared. The geometry may
 * touch the boundary, but positive area outside is rejected instead of clipped. */
export function validateRegionWithinBoundary(region: PolygonRegion, boundary?: PlanBoundary | null): BoundaryValidation {
  const boundaryResult = validatePlanBoundary(boundary);
  if (!boundaryResult.valid) return boundaryResult;
  if (!boundary) return valid();
  const result = validateRegion(region);
  if (!result.valid) return invalid('图形无效：' + result.error, result.code || 'invalid_polygon', { regionId: region?.id });
  try {
    const rings = [region.points, ...(region.holes ?? [])], area = polygonArea(region.points) - (region.holes ?? []).reduce((sum, ring) => sum + polygonArea(ring), 0);
    const insideArea = intersectionArea(region, { points: boundary.points, holes: [] });
    const outsideArea = Math.max(0, area - insideArea), perimeter = rings.reduce((sum, ring) => sum + polygonPerimeter(ring), 0);
    const magnitude = Math.max(1, ...rings.flat().flatMap(p => [Math.abs(p.x), Math.abs(p.y)])), epsilon = Math.max(1e-8, magnitude * Number.EPSILON * 16);
    const areaTolerance = Math.max(1e-7, area * 1e-10, perimeter * epsilon * 4);
    if (outsideArea > areaTolerance || rings.some(ring => ring.some((p, i) => !segmentWithinBoundary(p, ring[(i + 1) % ring.length], boundary)))) return invalid('图形超出项目边界，请调整位置、尺寸或边界。', 'outside_boundary', { regionId: region.id, outsideArea });
    return valid();
  } catch (error) {
    return invalid(error instanceof Error ? error.message : '无法可靠检查项目边界。', 'intersection_error', { regionId: region.id });
  }
}

export function validateRegionsWithinBoundary(regions: PolygonRegion[], boundary?: PlanBoundary | null): BoundaryValidation {
  const result = validatePlanBoundary(boundary); if (!result.valid || !boundary) return result;
  if (!Array.isArray(regions)) return invalid('区域数据无效。', 'invalid_regions');
  for (const region of regions) { const result = validateRegionWithinBoundary(region, boundary); if (!result.valid) return result; }
  return valid();
}

/** Third argument accepts the actual joined wall's convex pieces. Omitting it
 * retains legacy square-cap semantics only; projects should use the wrapper. */
export function validateWallsWithinBoundary(walls: Wall[], boundary?: PlanBoundary | null, footprints?: BoundaryFootprint[]): BoundaryValidation {
  const boundaryResult = validatePlanBoundary(boundary); if (!boundaryResult.valid || !boundary) return boundaryResult;
  try {
    const normalized = normalizeWalls(walls), actual = footprints ?? normalized.map(w => ({ wallId: w.id, points: wallFootprint(w).points }));
    // A flush branch entirely covered by its host legitimately has no pieces.
    if (!Array.isArray(actual) || actual.some(piece => !normalized.some(w => w.id === piece.wallId))) return invalid('墙体实际占地轮廓无效。', 'invalid_footprints');
    for (const wall of normalized) if (!segmentWithinBoundary(wall.start, wall.end, boundary)) return invalid('墙线超出项目边界，请调整墙线或边界。', 'wall_outside_boundary', { wallId: wall.id });
    for (const piece of actual) {
      const result = validateRegionWithinBoundary({ points: piece.points }, boundary);
      if (!result.valid) return { ...result, error: '墙体厚度或接点超出项目边界，请调整墙体或边界。', wallId: piece.wallId, code: 'wall_outside_boundary' };
    }
    return valid();
  } catch (error) { return invalid(error instanceof Error ? error.message : '墙体边界检查失败。', 'invalid_walls'); }
}

/** Validation never clips, edits or deletes existing geometry. A proposed
 * boundary or edit is committed only after this complete check succeeds. */
export function validateProjectBoundary(project: BoundaryProject): BoundaryValidation {
  const result = validatePlanBoundary(project.planBoundary); if (!result.valid || !project.planBoundary) return result;
  try {
    const walls = project.walls ?? [], wallResult = validateWallsWithinBoundary(walls, project.planBoundary, wallFootprints(walls, project.wallJoinStyle ?? 'square'));
    if (!wallResult.valid) return wallResult;
    const regionResult = validateRegionsWithinBoundary(project.regions ?? [], project.planBoundary); if (!regionResult.valid) return regionResult;
    validateFurniture(project.furniture);
    const context = {drawing:project.drawing??null,calibration:project.calibration??{metersPerPixel:null}};
    for (const furniture of project.furniture??[]) {
      const points = furnitureFootprint(furniture,context);
      // An uncalibrated image has no invented physical furniture footprint.
      if (!points) continue;
      const result = validateRegionWithinBoundary({points},project.planBoundary);
      if (!result.valid) return {...result,error:'家具实际占地超出项目边界，请调整位置、尺寸或边界。',code:'furniture_outside_boundary',furnitureId:furniture.id};
    }
    return valid();
  } catch (error) { return invalid(error instanceof Error ? error.message : '项目边界检查失败。', 'invalid_walls'); }
}
