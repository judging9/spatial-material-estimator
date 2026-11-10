import type { Point, Wall } from './wall-plan.js';
import type { SolidSurface, SolidVector } from './wall-solid.js';

export type WallFinishSide = 'both' | 'left' | 'right';
export type WallSelectionBounds = { min: SolidVector; max: SolidVector };
export type ContinuousWallFace = {
  id: string; wallId: string; side: 'left' | 'right'; normal: SolidVector;
  points: SolidVector[]; holes: SolidVector[][]; sourceSurfaceIds: string[];
  area: number; perimeter: number;
};
export type WallSelection = {
  wallId: string | null; side: WallFinishSide; surfaces: SolidSurface[];
  faces: ContinuousWallFace[];
  surfaceIds: string[]; area: number; bounds: WallSelectionBounds | null;
  boundary: SolidVector[];
};

/** Planar polygon area, including concave rings, in the solid's metre units. */
export function wallSurfaceArea(points: readonly SolidVector[]): number {
  if (points.length < 3) return 0;
  if (points.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) throw new RangeError('墙面选择坐标必须是有限数字。');
  const origin = points[0], normal = { x: 0, y: 0, z: 0 };
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1];
    const ax = a.x - origin.x, ay = a.y - origin.y, az = a.z - origin.z;
    const bx = b.x - origin.x, by = b.y - origin.y, bz = b.z - origin.z;
    normal.x += ay * bz - az * by;
    normal.y += az * bx - ax * bz;
    normal.z += ax * by - ay * bx;
  }
  return Math.hypot(normal.x, normal.y, normal.z) / 2;
}

/** Match the pricing engine's actual owned boundary, never a source wall box.
 * Duplicate sourceIds identify the same prism; only its canonical wallId owns
 * the billed surface. Inserts are separate solids and are not wall finishes. */
export function pricedWallSurfaces(surfaces: readonly SolidSurface[], wallId: string | null, side: WallFinishSide = 'both'): SolidSurface[] {
  if (!['both', 'left', 'right'].includes(side)) throw new RangeError('墙面选择范围应为左侧、右侧或全部侧面。');
  if (!wallId) return [];
  return surfaces.filter(surface => surface.wallId === wallId && !surface.id.startsWith('insert-') &&
    (side === 'both' ? surface.side === 'left' || surface.side === 'right' : surface.side === side) &&
    wallSurfaceArea(surface.points) > 1e-12);
}

const JOIN_EPS = 1e-8;
const dot = (a: SolidVector, b: SolidVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const signedArea = (ring: Point[]) => {
  const first = ring[0];
  return ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length];
    return sum + (p.x - first.x) * (q.y - first.y) - (q.x - first.x) * (p.y - first.y); }, 0) / 2;
};
const ringLength = (ring: Point[]) => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + Math.hypot(p.x - q.x, p.y - q.y); }, 0);
function contains(ring: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function simplifyRing(points: Point[]): Point[] {
  const ring = points.filter((p, i) => Math.hypot(p.x - points[(i + points.length - 1) % points.length].x, p.y - points[(i + points.length - 1) % points.length].y) > JOIN_EPS);
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], p = ring[i], b = ring[(i + 1) % ring.length];
      const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y;
      if (Math.abs(ax * by - ay * bx) <= JOIN_EPS * Math.max(1, Math.hypot(ax, ay) + Math.hypot(bx, by)) && ax * bx + ay * by >= 0) {
        ring.splice(i, 1); changed = true; break;
      }
    }
  }
  const start = ring.reduce((best, p, i) => p.x < ring[best].x - JOIN_EPS || Math.abs(p.x - ring[best].x) <= JOIN_EPS && p.y < ring[best].y ? i : best, 0);
  return [...ring.slice(start), ...ring.slice(0, start)];
}

/** Union boundary for the disjoint convex fragments emitted by wall-solid.
 * Collinear edges are split at every endpoint before opposite directions cancel,
 * so T splits and aperture triangulation never survive as a finish seam. */
function continuousRings(polygons: Point[][]): Point[][] {
  type Line = { dx: number; dy: number; offset: number; intervals: { start: number; end: number; sign: number }[] };
  const lines = new Map<string, Line>();
  for (const polygon of polygons) {
    const ring = signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length <= JOIN_EPS) continue;
      let dx = (b.x - a.x) / length, dy = (b.y - a.y) / length, sign = 1;
      if (dx < -JOIN_EPS || Math.abs(dx) <= JOIN_EPS && dy < 0) { dx = -dx; dy = -dy; sign = -1; }
      const offset = -dy * a.x + dx * a.y;
      const key = [dx, dy, offset].map(value => Math.round(value / JOIN_EPS)).join('|');
      const line = lines.get(key) ?? { dx, dy, offset, intervals: [] };
      const t0 = dx * a.x + dy * a.y, t1 = dx * b.x + dy * b.y;
      line.intervals.push({ start: Math.min(t0, t1), end: Math.max(t0, t1), sign }); lines.set(key, line);
    }
  }
  const segments: { start: Point; end: Point; used: boolean; startId?: number; endId?: number }[] = [];
  for (const line of lines.values()) {
    const raw = line.intervals.flatMap(interval => [{ t: interval.start, change: interval.sign }, { t: interval.end, change: -interval.sign }]).sort((a, b) => a.t - b.t);
    const events: { t: number; change: number }[] = [];
    for (const event of raw) {
      const last = events.at(-1);
      if (last && Math.abs(last.t - event.t) <= JOIN_EPS) last.change += event.change;
      else events.push({ ...event });
    }
    let count = 0;
    const at = (t: number): Point => ({ x: line.dx * t - line.dy * line.offset, y: line.dy * t + line.dx * line.offset });
    for (let i = 0; i < events.length - 1; i++) {
      count += events[i].change;
      if (count && events[i + 1].t - events[i].t > JOIN_EPS) {
        const a = at(events[i].t), b = at(events[i + 1].t);
        segments.push({ start: count > 0 ? a : b, end: count > 0 ? b : a, used: false });
      }
    }
  }
  // Rounding alone cannot join two nearly identical points that straddle a
  // grid boundary. Weld through adjacent spatial buckets within the tolerance.
  const vertices: Point[] = [], buckets = new Map<string, number[]>();
  const weld = (p: Point): number => {
    const x = Math.floor(p.x / JOIN_EPS), y = Math.floor(p.y / JOIN_EPS);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const id of buckets.get(`${x + dx},${y + dy}`) ?? []) {
        if (Math.hypot(p.x - vertices[id].x, p.y - vertices[id].y) <= JOIN_EPS) return id;
      }
    }
    const id = vertices.length, key = `${x},${y}`, values = buckets.get(key) ?? [];
    vertices.push(p); values.push(id); buckets.set(key, values); return id;
  };
  const outgoing = new Map<number, number[]>();
  segments.forEach((segment, i) => {
    segment.startId = weld(segment.start); segment.endId = weld(segment.end);
    segment.start = vertices[segment.startId]; segment.end = vertices[segment.endId];
    const edges = outgoing.get(segment.startId) ?? []; edges.push(i); outgoing.set(segment.startId, edges);
  });
  const rings: Point[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (segments[start].used) continue;
    const ring: Point[] = []; let index = start;
    for (let guard = 0; guard <= segments.length; guard++) {
      const segment = segments[index]; segment.used = true; ring.push(segment.start);
      if (segment.endId === segments[start].startId) break;
      const next = (outgoing.get(segment.endId) ?? []).filter(i => !segments[i].used);
      if (!next.length) throw new RangeError('墙面连续轮廓未闭合，请重新生成墙体。');
      // Walk the boundary with its interior on the left. At a point contact,
      // choose the outgoing edge clockwise from the incoming edge's reverse.
      const reverse = Math.atan2(segment.start.y - segment.end.y, segment.start.x - segment.end.x);
      const turn = (i: number) => (reverse - Math.atan2(segments[i].end.y - segments[i].start.y, segments[i].end.x - segments[i].start.x) + Math.PI * 2) % (Math.PI * 2);
      index = next.reduce((best, i) => turn(i) < turn(best) ? i : best, next[0]);
      if (guard === segments.length) throw new RangeError('墙面连续轮廓无法可靠重建。');
    }
    const clean = simplifyRing(ring);
    if (clean.length >= 3 && Math.abs(signedArea(clean)) > 1e-12) rings.push(clean);
  }
  return rings;
}

/** Actual coplanar faces, with concave outer rings and real aperture holes.
 * Mesh fragments stay available for rendering; these rings are the finish
 * surface for selection outlines, elevation previews and measured perimeters. */
export function continuousWallFaces(surfaces: readonly SolidSurface[], wallId: string | null, side: WallFinishSide = 'both'): ContinuousWallFace[] {
  const selected = pricedWallSurfaces(surfaces, wallId, side), groups = new Map<string, SolidSurface[]>();
  for (const surface of selected) {
    const key = [surface.side, surface.normal.x, surface.normal.y, surface.normal.z, dot(surface.points[0], surface.normal)].map(value => typeof value === 'number' ? Math.round(value / JOIN_EPS) : value).join('|');
    const values = groups.get(key) ?? []; values.push(surface); groups.set(key, values);
  }
  const result: ContinuousWallFace[] = [];
  for (const [key, fragments] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = fragments[0], origin = first.points[0], normal = first.normal;
    const tangentLength = Math.hypot(normal.x, normal.z);
    if (tangentLength < .999999) throw new RangeError('墙体左右侧面必须为有效竖直平面。');
    const u = { x: normal.z / tangentLength, y: 0, z: -normal.x / tangentLength };
    const project = (p: SolidVector): Point => ({ x: (p.x - origin.x) * u.x + (p.z - origin.z) * u.z, y: p.y - origin.y });
    const world = (p: Point): SolidVector => ({ x: origin.x + u.x * p.x, y: origin.y + p.y, z: origin.z + u.z * p.x });
    const rings = continuousRings(fragments.map(fragment => fragment.points.map(project)));
    const outers = rings.filter(ring => signedArea(ring) > 0).sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y);
    const holes = rings.filter(ring => signedArea(ring) < 0);
    for (const [i, outer] of outers.entries()) {
      const inner = holes.filter(hole => contains(outer, hole[0]));
      const sourceSurfaceIds = fragments.filter(fragment => {
        const center = fragment.points.reduce((p, q) => ({ x: p.x + q.x / fragment.points.length, y: p.y + q.y / fragment.points.length, z: p.z + q.z / fragment.points.length }), { x: 0, y: 0, z: 0 });
        return contains(outer, project(center));
      }).map(fragment => fragment.id).sort();
      result.push({ id: `${wallId}-continuous-${key}-${i}`, wallId: wallId!, side: first.side as 'left' | 'right', normal: { ...normal },
        points: outer.map(world), holes: inner.map(ring => ring.map(world)), sourceSurfaceIds,
        area: signedArea(outer) + inner.reduce((sum, ring) => sum + signedArea(ring), 0),
        perimeter: ringLength(outer) + inner.reduce((sum, ring) => sum + ringLength(ring), 0) });
    }
  }
  return result;
}

export function selectedWallSurfaceSide(surface: Pick<SolidSurface, 'side'>): 'left' | 'right' | undefined {
  return surface.side === 'left' || surface.side === 'right' ? surface.side : undefined;
}

export function wallSelection(surfaces: readonly SolidSurface[], wallId: string | null, side: WallFinishSide = 'both'): WallSelection {
  const selected = pricedWallSurfaces(surfaces, wallId, side);
  const faces = continuousWallFaces(selected, wallId, side);
  const points = selected.flatMap(surface => surface.points);
  let bounds: WallSelectionBounds | null = null;
  if (points.length) {
    const min = { ...points[0] }, max = { ...points[0] };
    for (const point of points) for (const axis of ['x', 'y', 'z'] as const) {
      min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
    }
    bounds = { min, max };
  }
  const boundary = faces.flatMap(face => [face.points, ...face.holes].flatMap(ring => ring.flatMap((p, i) => [{ ...p }, { ...ring[(i + 1) % ring.length] }])));
  return { wallId, side, surfaces: selected, faces, surfaceIds: selected.map(surface => surface.id),
    area: faces.reduce((total, face) => total + face.area, 0), bounds, boundary };
}

/** Exact plan projection of selected faces. Vertical faces become lines.
 * Polygon rings and heights let a 2D renderer keep selection and quote scope
 * consistent even where a hole removes only part of a wall's elevation. */
export function projectWallSelection(surfaces: readonly SolidSurface[], wallId: string | null, side: WallFinishSide = 'both', metersPerDrawingUnit = .01) {
  if (!Number.isFinite(metersPerDrawingUnit) || metersPerDrawingUnit <= 0) throw new RangeError('墙面投影比例必须大于零。');
  const selection = wallSelection(surfaces, wallId, side);
  const project = (p: SolidVector): Point => ({ x: p.x / metersPerDrawingUnit, y: p.z / metersPerDrawingUnit });
  const segments: { start: Point; end: Point }[] = [], keys = new Set<string>();
  for (let index = 0; index < selection.boundary.length; index += 2) {
    const start = project(selection.boundary[index]), end = project(selection.boundary[index + 1]);
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-7) continue;
    const key = [start, end].map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort().join('|');
    if (!keys.has(key)) { keys.add(key); segments.push({ start, end }); }
  }
  return { wallId, side, area: selection.area, segments,
    faces: selection.faces.map(face => ({ id: face.id, side: face.side,
      points: face.points.map(project), holes: face.holes.map(ring => ring.map(project)), area: face.area, perimeter: face.perimeter,
      minHeight: Math.min(...face.points.map(p => p.y)), maxHeight: Math.max(...face.points.map(p => p.y)) })) };
}

/** Metre coordinates along a wall and above the ground for an elevation UI. */
export function wallSelectionElevation(surfaces: readonly SolidSurface[], wall: Pick<Wall, 'id' | 'start' | 'end'>, side: WallFinishSide = 'both') {
  const dx = wall.end.x - wall.start.x, dz = wall.end.y - wall.start.y, length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError('墙面立面需要有效墙长。');
  const project = (p: SolidVector): Point => ({ x: ((p.x - wall.start.x / 100) * dx + (p.z - wall.start.y / 100) * dz) / length, y: p.y });
  return continuousWallFaces(surfaces, wall.id, side).map(face => ({ id: face.id, side: face.side, normal: face.normal,
    points: face.points.map(project), holes: face.holes.map(ring => ring.map(project)), area: face.area, perimeter: face.perimeter, sourceSurfaceIds: face.sourceSurfaceIds }));
}
