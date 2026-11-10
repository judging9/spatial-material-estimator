import type { Point } from './wall-plan.js';
import type { SolidSurface, SolidVector } from './wall-solid.js';
import { wallSelection, type WallFinishSide, type WallSelection } from './wall-selection.js';

const EPS = 1e-8;
const dot = (a: SolidVector, b: SolidVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: SolidVector, b: SolidVector) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: SolidVector, b: SolidVector) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const quantize = (value: number) => Math.round(value / EPS);

/** Cancel shared boundary intervals after splitting at every actual endpoint.
 * This works across different face planes and partial-height opening splits;
 * no bounding box or imaginary straight replacement is used. */
export function cancelSharedBoundary(boundary: readonly SolidVector[]): SolidVector[] {
  type Line = { direction: SolidVector; origin: SolidVector; intervals: { start: number; end: number }[] };
  const groups = new Map<string, Line>();
  for (let i = 0; i < boundary.length; i += 2) {
    const a = boundary[i], b = boundary[i + 1];
    if (!a || !b || ![a.x,a.y,a.z,b.x,b.y,b.z].every(Number.isFinite)) throw new RangeError('曲面边界坐标无效。');
    const delta = sub(b, a), length = Math.hypot(delta.x, delta.y, delta.z); if (length <= EPS) continue;
    let direction = { x: delta.x / length, y: delta.y / length, z: delta.z / length };
    const first = Math.abs(direction.x) > EPS ? direction.x : Math.abs(direction.y) > EPS ? direction.y : direction.z;
    if (first < 0) direction = { x: -direction.x, y: -direction.y, z: -direction.z };
    const moment = cross(direction, a), key = [direction.x,direction.y,direction.z,moment.x,moment.y,moment.z].map(quantize).join('|');
    const sameLine = (line: Line) => {
      const angle = cross(direction,line.direction), da=cross(sub(a,line.origin),line.direction), db=cross(sub(b,line.origin),line.direction);
      return Math.hypot(angle.x,angle.y,angle.z)<1e-9 && Math.hypot(da.x,da.y,da.z)<=EPS && Math.hypot(db.x,db.y,db.z)<=EPS;
    };
    // Equal physical edges can straddle a rounded hash-cell boundary after
    // translation. Verify the line itself and use a geometric fallback.
    let line = groups.get(key);
    if (!line || !sameLine(line)) line = [...groups.values()].find(sameLine);
    if (!line) { line={direction,origin:{...a},intervals:[]};groups.set(groups.has(key)?key+'|'+groups.size:key,line); }
    const start = dot(sub(a, line.origin), line.direction), end = dot(sub(b, line.origin), line.direction);
    line.intervals.push({ start: Math.min(start, end), end: Math.max(start, end) });
  }
  const result: SolidVector[] = [];
  for (const line of groups.values()) {
    const values = line.intervals.flatMap(edge => [edge.start, edge.end]).sort((a,b) => a-b);
    const stops = values.filter((t,i) => !i || t-values[i-1]>EPS);
    const at = (t: number): SolidVector => ({ x: line.origin.x + line.direction.x*t, y: line.origin.y + line.direction.y*t, z: line.origin.z + line.direction.z*t });
    for (let i = 1; i < stops.length; i++) {
      const start = stops[i-1], end = stops[i], middle = (start+end)/2;
      if (end-start<=EPS) continue;
      const count = line.intervals.filter(edge => edge.start < middle && edge.end > middle).length;
      if (count % 2) result.push(at(start), at(end));
    }
  }
  return result;
}

export function wallShapeSelection(surfaces: readonly SolidSurface[], wallIds: readonly string[], side: WallFinishSide = 'both'): WallSelection & { wallIds: string[]; perimeter: number } {
  if (!Array.isArray(wallIds) || wallIds.length>200 || wallIds.some(id => typeof id !== 'string') || new Set(wallIds).size !== wallIds.length || !['both','left','right'].includes(side)) throw new RangeError('曲线墙成员或施工侧面无效。');
  const selected = wallIds.map(id => wallSelection(surfaces, id, side));
  const pieces = selected.flatMap(selection => selection.surfaces), faces = selected.flatMap(selection => selection.faces);
  const boundary = cancelSharedBoundary(selected.flatMap(selection => selection.boundary));
  const points = pieces.flatMap(surface => surface.points); let bounds: WallSelection['bounds'] = null;
  if (points.length) {
    const min = { ...points[0] }, max = { ...points[0] };
    for (const p of points) for (const axis of ['x','y','z'] as const) { min[axis]=Math.min(min[axis],p[axis]); max[axis]=Math.max(max[axis],p[axis]); }
    bounds = { min, max };
  }
  let perimeter = 0;
  for (let i=0;i<boundary.length;i+=2) perimeter += Math.hypot(boundary[i+1].x-boundary[i].x,boundary[i+1].y-boundary[i].y,boundary[i+1].z-boundary[i].z);
  return { wallId: wallIds.length === 1 ? wallIds[0] : null, wallIds: [...wallIds], side, surfaces: pieces, faces,
    surfaceIds: pieces.map(surface=>surface.id), area: selected.reduce((sum,selection)=>sum+selection.area,0), bounds, boundary, perimeter };
}

/** Same 2D projection contract as straight-wall selection, including faces and
 * their real holes. Shared vertical seams are absent from projected boundary. */
export function projectWallShapeSelection(surfaces: readonly SolidSurface[], wallIds: readonly string[], side: WallFinishSide = 'both', metersPerDrawingUnit = .01) {
  if (!Number.isFinite(metersPerDrawingUnit) || metersPerDrawingUnit <= 0) throw new RangeError('曲线墙投影比例必须大于零。');
  const selection = wallShapeSelection(surfaces, wallIds, side), project = (p: SolidVector): Point => ({ x: p.x/metersPerDrawingUnit, y: p.z/metersPerDrawingUnit });
  const segments: {start:Point;end:Point}[] = [], keys = new Set<string>();
  for (let i=0;i<selection.boundary.length;i+=2) {
    const start = project(selection.boundary[i]), end = project(selection.boundary[i+1]);
    if (Math.hypot(end.x-start.x,end.y-start.y)<1e-7) continue;
    const key = [start,end].map(p=>`${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort().join('|');
    if (!keys.has(key)) { keys.add(key); segments.push({start,end}); }
  }
  return { wallId: selection.wallId, wallIds: [...wallIds], side, area: selection.area, perimeter: selection.perimeter, segments,
    faces: selection.faces.map(face=>({id:face.id,side:face.side,points:face.points.map(project),holes:face.holes.map(ring=>ring.map(project)),area:face.area,perimeter:face.perimeter,
      minHeight:Math.min(...face.points.map(p=>p.y)),maxHeight:Math.max(...face.points.map(p=>p.y))})) };
}
