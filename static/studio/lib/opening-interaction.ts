import type { Point, Wall } from './wall-plan.js';
import { normalizeWalls } from './wall-plan.js';
import { openingPolygon, openingJunctionPolygons, validateOpenings, type WallOpening, type WallSolidProject } from './wall-solid.js';
import { wallFootprints } from './wall-joins.js';
import { intersectionArea } from './geometry.js';

export type OpeningPosition = Pick<WallOpening, 'offset' | 'bottom'>;
export type OpeningDragOptions = { snap?: boolean; snapTolerance?: number; shift?: boolean };
export type OpeningValidity = { valid: boolean; error: string | null };
type Frame = { wall: Wall; u: Point; n: Point; length: number; height: number; footprint: Point[] };
const EPS = 1e-7;
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const at = (a: Point, b: Point, t: number): Point => ({ x: a.x + b.x * t, y: a.y + b.y * t });
const position = (opening: WallOpening): OpeningPosition => ({ offset: opening.offset, bottom: opening.bottom });
const finitePoint = (point: Point) => point && Number.isFinite(point.x) && Number.isFinite(point.y);
function requirePoint(point: Point) { if (!finitePoint(point)) throw new RangeError('拖动位置必须是有限坐标。'); }
function frameFor(project: WallSolidProject, opening: WallOpening): Frame {
  const walls = normalizeWalls(project.walls ?? []), wall = walls.find(wall => wall.id === opening.wallId);
  if (!wall) throw new RangeError('门窗或孔洞所在墙体不存在。');
  const vector = subtract(wall.end, wall.start), length = Math.hypot(vector.x, vector.y), u = { x: vector.x / length, y: vector.y / length };
  const footprint = wallFootprints(walls, project.wallJoinStyle ?? 'square').find(part => part.wallId === wall.id)?.points;
  if (!footprint?.length) throw new RangeError('实际墙面不存在，无法移动开孔。');
  return { wall, u, n: { x: -u.y, y: u.x }, length, height: wall.height ?? project.wallHeight ?? 280, footprint };
}

/** Validate either a complete aperture or an explicit id-based position patch.
 * This never snaps, resets a door sill, changes wall or mutates the project. */
export function openingPositionValidity(project: WallSolidProject, value: WallOpening | (Partial<WallOpening> & OpeningPosition), id?: string): OpeningValidity {
  try {
    const source = project.openings?.find(opening => opening.id === (id ?? value.id));
    const candidate = value.wallId ? value as WallOpening : source ? { ...source, ...value } : null;
    if (!candidate) throw new RangeError('门窗或孔洞不存在。');
    const openings = [...(project.openings ?? []).filter(opening => opening.id !== candidate.id), candidate];
    validateOpenings({ ...project, openings }); return { valid: true, error: null };
  } catch (error) { return { valid: false, error: error instanceof Error ? error.message : '开孔位置无效。' }; }
}

/** A top-view aperture is its actual elevation-polygon projection, through
 * the host wall's thickness. Door symbols outside the wall do not enlarge it. */
export function openingAtPlanPoint(project: WallSolidProject, point: Point, toleranceWorld = 0, selectedId?: string | null): WallOpening | null {
  requirePoint(point);
  if (!Number.isFinite(toleranceWorld) || toleranceWorld < 0) throw new RangeError('开孔选择容差必须是非负数。');
  const choices = [...(project.openings ?? [])].reverse(), selected = choices.find(opening => opening.id === selectedId);
  if (selected) { choices.splice(choices.indexOf(selected), 1); choices.unshift(selected); }
  for (const opening of choices) {
    const wall = project.walls?.find(wall => wall.id === opening.wallId); if (!wall) continue;
    const vector = subtract(wall.end, wall.start), length = Math.hypot(vector.x, vector.y); if (!length) continue;
    const u = { x: vector.x / length, y: vector.y / length }, local = subtract(point, wall.start), along = dot(local, u), across = Math.abs(cross(u, local));
    const ring = openingPolygon(opening), left = Math.min(...ring.map(p => p.x)), right = Math.max(...ring.map(p => p.x));
    const dx = Math.max(left - along, along - right, 0), dy = Math.max(across - (wall.thickness ?? 20) / 2, 0);
    if (Math.hypot(dx, dy) <= toleranceWorld + EPS) return structuredClone(opening);
  }
  return null;
}
export function openingPlanPoint(project: WallSolidProject, opening: WallOpening): Point {
  const frame = frameFor(project, opening), ring = openingPolygon(opening);
  const along = (Math.min(...ring.map(p => p.x)) + Math.max(...ring.map(p => p.x))) / 2;
  return at(frame.wall.start, frame.u, along);
}

/** Full-width placement bounds derived from each real clean-wall half-plane,
 * not from a universal half-thickness inset or an axis-aligned bounding box. */
export function openingMoveBounds(project: WallSolidProject, opening: WallOpening) {
  const frame = frameFor(project, opening);
  let minOffset = 0, maxOffset = frame.length - opening.width;
  if (project.wallJoinStyle === 'clean') {
    const localRing = openingPolygon(opening).map(point => ({ x: point.x - opening.offset, y: point.y - opening.bottom }));
    for (let i = 0; i < frame.footprint.length; i++) {
      const a = frame.footprint[i], b = frame.footprint[(i + 1) % frame.footprint.length], edge = subtract(b, a), coefficient = cross(edge, frame.u);
      for (const point of localRing) for (const across of [-frame.wall.thickness / 2, frame.wall.thickness / 2]) {
        const actual = { x: frame.wall.start.x + frame.u.x * point.x + frame.n.x * across, y: frame.wall.start.y + frame.u.y * point.x + frame.n.y * across };
        const constant = cross(edge, subtract(actual, a));
        if (Math.abs(coefficient) <= Number.EPSILON * Math.max(1, Math.hypot(edge.x, edge.y)) * 64) {
          if (constant < -EPS * Math.max(1, Math.hypot(edge.x, edge.y))) throw new RangeError('开孔厚度范围超出实际墙面。');
        } else if (coefficient > 0) minOffset = Math.max(minOffset, -constant / coefficient);
        else maxOffset = Math.min(maxOffset, -constant / coefficient);
      }
    }
  }
  return { minOffset, maxOffset, minBottom: 0, maxBottom: frame.height - opening.height };
}
function snapValue(value: number, candidates: number[], tolerance: number) {
  let best: number | null = null, distance = tolerance;
  for (const candidate of candidates) { const d = Math.abs(candidate - value); if (d <= distance) { best = candidate; distance = d; } }
  return best ?? Math.round(value);
}
function snappedPosition(project: WallSolidProject, original: WallOpening, requested: OpeningPosition, options: OpeningDragOptions): OpeningPosition {
  const bounds = openingMoveBounds(project, original);
  if (bounds.minOffset > bounds.maxOffset + EPS || bounds.maxBottom < 0) return position(original);
  let offset = Math.max(bounds.minOffset, Math.min(bounds.maxOffset, requested.offset));
  let bottom = original.kind === 'door' ? original.bottom : Math.max(bounds.minBottom, Math.min(bounds.maxBottom, requested.bottom));
  if (options.snap !== false) {
    const tolerance = options.snapTolerance ?? 3; if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('吸附容差必须为非负厘米数。');
    const local = openingPolygon(original).map(point => ({ x: point.x - original.offset, y: point.y - original.bottom }));
    const minX = Math.min(...local.map(p => p.x)), maxX = Math.max(...local.map(p => p.x)), minY = Math.min(...local.map(p => p.y)), maxY = Math.max(...local.map(p => p.y));
    const peers = (project.openings ?? []).filter(opening => opening.wallId === original.wallId && opening.id !== original.id).map(openingPolygon);
    if (Math.abs(requested.offset - original.offset) > EPS) offset = snapValue(offset, [bounds.minOffset, bounds.maxOffset, (bounds.minOffset + bounds.maxOffset) / 2,
      ...peers.flatMap(ring => { const min = Math.min(...ring.map(p => p.x)), max = Math.max(...ring.map(p => p.x)); return [min - maxX - 1, max - minX + 1, min - minX, max - maxX]; })], tolerance);
    if (original.kind !== 'door' && Math.abs(requested.bottom - original.bottom) > EPS) bottom = snapValue(bottom, [bounds.minBottom, bounds.maxBottom, (bounds.minBottom + bounds.maxBottom) / 2,
      ...peers.flatMap(ring => { const min = Math.min(...ring.map(p => p.y)), max = Math.max(...ring.map(p => p.y)); return [min - maxY - 1, max - minY + 1, min - minY, max - maxY]; })], tolerance);
  }
  return { offset: Math.max(bounds.minOffset, Math.min(bounds.maxOffset, offset)), bottom: original.kind === 'door' ? original.bottom : Math.max(bounds.minBottom, Math.min(bounds.maxBottom, bottom)) };
}
type Obstacle = { ring: Point[]; touchingBlocks: boolean };
function obstacles(project: WallSolidProject, original: WallOpening): Obstacle[] {
  const result = (project.openings ?? []).filter(opening => opening.wallId === original.wallId && opening.id !== original.id).map(opening => ({ ring: openingPolygon(opening), touchingBlocks: true }));
  result.push(...openingJunctionPolygons(project, original.wallId).map(ring => ({ ring, touchingBlocks: false })));
  return result;
}
/** Time of a moving point meeting a fixed edge. Collinear paths use interval
 * projection, so a very thin peer or a long pointer jump cannot be skipped. */
function pointEdgeTime(point: Point, velocity: Point, a: Point, b: Point): number | null {
  const edge = subtract(b, a), q = subtract(a, point), denominator = cross(velocity, edge), length = Math.hypot(velocity.x, velocity.y);
  const parallelTolerance = Number.EPSILON * Math.max(1, length * Math.hypot(edge.x, edge.y)) * 64;
  if (Math.abs(denominator) > parallelTolerance) {
    const t = cross(q, edge) / denominator, u = cross(q, velocity) / denominator;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? Math.max(0, Math.min(1, t)) : null;
  }
  if (!length || Math.abs(cross(q, velocity)) > EPS * Math.max(1, length)) return null;
  const square = length ** 2, ta = dot(subtract(a, point), velocity) / square, tb = dot(subtract(b, point), velocity) / square;
  const min = Math.min(ta, tb), max = Math.max(ta, tb); return max >= 0 && min <= 1 ? Math.max(0, min) : null;
}
function sweepEvents(moving: Point[], velocity: Point, fixed: Point[]): number[] {
  const times: number[] = [];
  for (const point of moving) for (let i = 0; i < fixed.length; i++) { const t = pointEdgeTime(point, velocity, fixed[i], fixed[(i + 1) % fixed.length]); if (t !== null) times.push(t); }
  const reverse = { x: -velocity.x, y: -velocity.y };
  for (const point of fixed) for (let i = 0; i < moving.length; i++) { const t = pointEdgeTime(point, reverse, moving[i], moving[(i + 1) % moving.length]); if (t !== null) times.push(t); }
  return [...new Set(times)].sort((a, b) => a - b);
}

/** Project a drag onto its first reachable legal position. Continuous swept
 * polygon contact prevents tunnelling through peers/junctions. It never swaps
 * host walls, changes dimensions or resets an existing door's sill height. */
export function projectToValidOpeningPosition(project: WallSolidProject, original: WallOpening, requested: OpeningPosition, options: OpeningDragOptions = {}): OpeningPosition {
  if (original.locked || project.openings?.find(opening => opening.id === original.id)?.locked) return position(original);
  if (![requested.offset, requested.bottom].every(Number.isFinite)) throw new RangeError('开孔位置必须是有效厘米数。');
  if (!openingPositionValidity(project, original).valid) return position(original);
  const desired = snappedPosition(project, original, requested, options), velocity = { x: desired.offset - original.offset, y: desired.bottom - original.bottom }, distance = Math.hypot(velocity.x, velocity.y);
  if (distance < EPS) return position(original);
  const ring = openingPolygon(original); let first = 1, collision = false;
  for (const obstacle of obstacles(project, original)) for (const t of sweepEvents(ring, velocity, obstacle.ring)) {
    if (t > first) break;
    const after = Math.min(1, t + Math.max(1e-8, 1e-3 / distance));
    const entering = obstacle.touchingBlocks || after > t && intersectionArea({ points: ring.map(point => at(point, velocity, after)), holes: [] }, { points: obstacle.ring, holes: [] }) > EPS;
    if (entering) { first = t; collision = true; break; }
  }
  const travel = collision ? Math.max(0, first - Math.max(1e-10, 1e-4 / distance)) : 1;
  const candidate = (t: number): OpeningPosition => ({ offset: original.offset + velocity.x * t, bottom: original.kind === 'door' ? original.bottom : original.bottom + velocity.y * t });
  const valid = (t: number) => openingPositionValidity(project, { ...original, ...candidate(t) }).valid;
  if (valid(travel)) return candidate(travel);
  // Numerical contact tolerances may be tighter in the shared solid engine.
  // Bisect only the collision-free prefix; never choose a far-side valid island.
  let left = 0, right = travel;
  for (let i = 0; i < 36; i++) { const middle = (left + right) / 2; if (valid(middle)) left = middle; else right = middle; }
  return candidate(left);
}
export function moveOpening(project: WallSolidProject, id: string, requested: OpeningPosition, options: OpeningDragOptions = {}): OpeningPosition {
  const original = project.openings?.find(opening => opening.id === id); if (!original) throw new RangeError('门窗或孔洞不存在。');
  return projectToValidOpeningPosition(project, original, requested, options);
}
export function openingPositionFromPlanDrag(project: WallSolidProject, original: WallOpening, start: Point, current: Point, options: OpeningDragOptions = {}): OpeningPosition {
  requirePoint(start); requirePoint(current); const frame = frameFor(project, original);
  return projectToValidOpeningPosition(project, original, { offset: original.offset + dot(subtract(current, start), frame.u), bottom: original.bottom }, options);
}
export const openingMoveFromPointer = openingPositionFromPlanDrag;
export function openingPositionFromElevationDrag(project: WallSolidProject, original: WallOpening, startLocal: Point, currentLocal: Point, options: OpeningDragOptions = {}): OpeningPosition {
  requirePoint(startLocal); requirePoint(currentLocal); const delta = subtract(currentLocal, startLocal);
  if (options.shift && original.kind !== 'door') { if (Math.abs(delta.x) >= Math.abs(delta.y)) delta.y = 0; else delta.x = 0; }
  return projectToValidOpeningPosition(project, original, { offset: original.offset + delta.x, bottom: original.kind === 'door' ? original.bottom : original.bottom + delta.y }, options);
}
