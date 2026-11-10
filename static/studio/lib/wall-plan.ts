/**
 * Straight architectural walls in centimetres → true net floor polygons.
 * Room face topology is adapted from OpenPlan3D (MIT, theLodgeStudio 2026).
 * See vendor/openplan for the preserved licence and THIRD_PARTY_NOTICES.md.
 *
 * This wrapper never prices OpenPlan3D's rounded centreline area. It offsets
 * each actual face edge by its wall's half thickness, expands child holes,
 * and verifies that no returned floor area intersects any wall footprint.
 */
import { resolveRoomGeometry } from '../vendor/openplan/roomDetection.js';
import { roomHoles } from '../vendor/openplan/roomNesting.js';
import { intersectionArea, pointInRegion, polygonArea, validatePolygon, validateRegion } from './geometry.js';
import type { QuoteItem } from '../types.js';
import { wallFootprints, type WallJoinStyle } from './wall-joins.js';

export type Point = { x: number; y: number };
export type Wall = { id: string; start: Point; end: Point; thickness: number; height?: number; name?: string; items?: QuoteItem[]; finishSide?: 'both' | 'left' | 'right'; additionalCost?: string };
export type PlanRoom = { key: string; points: Point[]; holes: Point[][]; centerlinePoints: Point[] };
const EPS = 1e-6;
const copyPoint = (point: Point): Point => ({ x: point.x, y: point.y });
const equal = (a: Point, b: Point) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
const finitePoint = (point: Point) => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const signedArea = (ring: Point[]) => ring.reduce((sum, p, i) => sum + cross(subtract(p, ring[0]), subtract(ring[(i + 1) % ring.length], ring[0])), 0) / 2;

/** Validate straight walls; explicit snaps define joins at arbitrary angles. */
export function normalizeWalls(input: Wall[]): Wall[] {
  if (!Array.isArray(input)) throw new TypeError('墙线数据必须是数组。');
  if (input.length > 200) throw new RangeError('当前简易绘图最多支持 200 段墙线，请拆分项目。');
  const walls: Wall[] = [];
  const ids = new Map<string, Wall>();
  for (const source of input) {
    if (!source || typeof source.id !== 'string' || !source.id.trim()) throw new TypeError('每段墙线需要有效编号。');
    if (!finitePoint(source.start) || !finitePoint(source.end)) throw new TypeError('墙线坐标必须是有限数字。');
    if ([source.start.x, source.start.y, source.end.x, source.end.y].some(value => Math.abs(value) > 1_000_000)) throw new RangeError('墙线坐标超出当前绘图范围。');
    const thickness = source.thickness ?? 20;
    if (!Number.isFinite(thickness) || thickness < 1 || thickness > 100) throw new RangeError('墙厚应为 1–100 cm。');
    const height = source.height ?? 280;
    if (!Number.isFinite(height) || height < 50 || height > 1000) throw new RangeError('墙高应为 0.5–10 m。');
    const start = copyPoint(source.start), end = copyPoint(source.end);
    const dx = end.x - start.x, dy = end.y - start.y;
    if (Math.hypot(dx, dy) < 1) throw new RangeError('墙线长度至少为 1 cm。');
    if (Math.abs(dx) <= EPS) end.x = start.x;
    if (Math.abs(dy) <= EPS) end.y = start.y;
    if (source.finishSide !== undefined && !['both', 'left', 'right'].includes(source.finishSide)) throw new RangeError('墙面计量方向应为全部侧面、左侧或右侧。');
    if (source.items !== undefined && !Array.isArray(source.items)) throw new TypeError('墙面材料项目应为数组。');
    const wall: Wall = { ...source, id: source.id, start, end, thickness, ...(source.height !== undefined ? { height } : {}) };
    const previous = ids.get(wall.id);
    if (previous) {
      const sameSegment = equal(previous.start, start) && equal(previous.end, end) || equal(previous.start, end) && equal(previous.end, start);
      if (!sameSegment || previous.thickness !== thickness || (previous.height ?? 280) !== height) throw new RangeError('同一墙线编号不能对应不同的几何、厚度或高度。');
      continue;
    }
    walls.push(wall); ids.set(wall.id, wall);
  }
  return walls;
}

function onSegment(point: Point, a: Point, b: Point): boolean {
  return Math.abs(cross(subtract(b, a), subtract(point, a))) <= EPS * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    && point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS
    && point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS;
}

function edgeThickness(a: Point, b: Point, walls: Wall[]): number {
  const matches = walls.filter(wall => onSegment(a, wall.start, wall.end) && onSegment(b, wall.start, wall.end));
  if (!matches.length) throw new RangeError('房间边界未能对应墙线，请检查连接位置。');
  // Coincident walls occupy one footprint. The widest of them governs the edge.
  return Math.max(...matches.map(wall => wall.thickness));
}

/** Offset actual straight edge lines by their individual half wall thickness. */
function offsetRing(ring: Point[], walls: Wall[], inward: boolean): Point[] {
  const original = validatePolygon(ring);
  if (!original.valid) throw new RangeError('墙线围合轮廓无效：' + original.error);
  const winding = signedArea(ring) > 0 ? 1 : -1;
  const offsets = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const distance = edgeThickness(a, b, walls) / 2 * winding * (inward ? 1 : -1);
    const normal = { x: -dy / length * distance, y: dx / length * distance };
    return { a: { x: a.x + normal.x, y: a.y + normal.y }, b: { x: b.x + normal.x, y: b.y + normal.y }, direction: { x: dx, y: dy } };
  });
  const points = offsets.map((current, i) => {
    const previous = offsets[(i + offsets.length - 1) % offsets.length];
    const denominator = cross(previous.direction, current.direction);
    if (Math.abs(denominator) < EPS) {
      if (!onSegment(current.a, previous.a, previous.b) && !equal(current.a, previous.b)) throw new RangeError('同一直线的相邻墙段厚度不同，请统一墙厚后计算。');
      return copyPoint(current.a);
    }
    const t = cross(subtract(current.a, previous.a), current.direction) / denominator;
    return { x: previous.a.x + t * previous.direction.x, y: previous.a.y + t * previous.direction.y };
  });
  for (let i = 0; i < points.length; i++) {
    const originalEdge = subtract(ring[(i + 1) % ring.length], ring[i]);
    const newEdge = subtract(points[(i + 1) % points.length], points[i]);
    if (originalEdge.x * newEdge.x + originalEdge.y * newEdge.y <= EPS) throw new RangeError('墙厚超过房间或通道的净尺寸，无法生成可靠施工区域。');
  }
  const valid = validatePolygon(points);
  if (!valid.valid || Math.sign(signedArea(points)) !== winding) throw new RangeError('扣除墙厚后轮廓无效，请调整房间或墙厚。');
  if (inward && (polygonArea(points) >= polygonArea(ring) || points.some(point => !pointInRegion(point, { points: ring, holes: [] })))) throw new RangeError('扣除墙厚后的边界超出原房间。');
  return points;
}

/** The same rotated square end caps used by the physical wall solid. */
export function wallFootprint(wall: Wall) {
  return { points: wallFootprints([wall], 'square')[0]?.points ?? [], holes: [] };
}

/** Exact planar boundary of a face minus its real wall footprints. At an
 * oblique corner a square end cap need not coincide with an infinite miter:
 * use segment intersections, classify both sides, then trace the boundary.
 * No raster/grid approximation or bounding-box area is involved. */
function netAngledFace(outer: Point[], holes: Point[][], walls: Wall[], style: WallJoinStyle = 'square'): { points: Point[]; holes: Point[][] } {
  const rings = [outer, ...holes];
  for (const ring of rings) {
    const valid = validatePolygon(ring);
    if (!valid.valid) throw new RangeError('墙线围合轮廓无效：' + valid.error);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const incoming = subtract(b, a), outgoing = subtract(c, b);
      if (style === 'square' && Math.abs(cross(incoming, outgoing)) <= EPS * Math.max(1, Math.hypot(incoming.x, incoming.y), Math.hypot(outgoing.x, outgoing.y))
        && Math.abs(edgeThickness(a, b, walls) - edgeThickness(b, c, walls)) > EPS) {
        throw new RangeError('同一直线的相邻墙段厚度不同，请统一墙厚后计算。');
      }
    }
  }
  const boundaryWalls = walls.filter(wall => rings.some(ring => ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return onSegment(a, wall.start, wall.end) && onSegment(b, wall.start, wall.end);
  })));
  const boundaryIds = new Set(boundaryWalls.map(wall => wall.id));
  const footprints = wallFootprints(walls, style).filter(footprint => boundaryIds.has(footprint.wallId)).map(footprint => ({ points: footprint.points, holes: [] }));
  const candidates = [...rings, ...footprints.map(footprint => footprint.points)];
  const segments = candidates.flatMap(ring => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], cuts: [0, 1] })));
  const parameter = (point: Point, a: Point, direction: Point) => {
    const lengthSq = direction.x * direction.x + direction.y * direction.y;
    return ((point.x - a.x) * direction.x + (point.y - a.y) * direction.y) / lengthSq;
  };
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (Math.max(a.a.x, a.b.x) < Math.min(b.a.x, b.b.x) - EPS || Math.max(b.a.x, b.b.x) < Math.min(a.a.x, a.b.x) - EPS
      || Math.max(a.a.y, a.b.y) < Math.min(b.a.y, b.b.y) - EPS || Math.max(b.a.y, b.b.y) < Math.min(a.a.y, a.b.y) - EPS) continue;
    const u = subtract(a.b, a.a), v = subtract(b.b, b.a), delta = subtract(b.a, a.a);
    const denominator = cross(u, v), lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
    if (Math.abs(denominator) <= 1e-12 * lu * lv) {
      if (Math.abs(cross(u, delta)) > EPS * lu) continue;
      for (const p of [b.a, b.b]) if (onSegment(p, a.a, a.b)) a.cuts.push(Math.max(0, Math.min(1, parameter(p, a.a, u))));
      for (const p of [a.a, a.b]) if (onSegment(p, b.a, b.b)) b.cuts.push(Math.max(0, Math.min(1, parameter(p, b.a, v))));
    } else {
      const t = cross(delta, v) / denominator, s = cross(delta, u) / denominator;
      if (t >= -EPS / lu && t <= 1 + EPS / lu && s >= -EPS / lv && s <= 1 + EPS / lv) {
        a.cuts.push(Math.max(0, Math.min(1, t))); b.cuts.push(Math.max(0, Math.min(1, s)));
      }
    }
  }
  const region = { points: outer, holes };
  const inside = (point: Point) => pointInRegion(point, region) && !footprints.some(footprint => pointInRegion(point, footprint));
  const vertices: Point[] = [], edges: { from: number; to: number }[] = [], unique = new Set<string>();
  const vertex = (p: Point) => {
    let index = vertices.findIndex(other => equal(other, p));
    if (index < 0) { index = vertices.length; vertices.push(copyPoint(p)); }
    return index;
  };
  for (const segment of segments) {
    const direction = subtract(segment.b, segment.a), length = Math.hypot(direction.x, direction.y);
    const cuts = segment.cuts.sort((a, b) => a - b).filter((value, index, all) => !index || (value - all[index - 1]) * length > EPS);
    for (let k = 1; k < cuts.length; k++) {
      const low = cuts[k - 1], high = cuts[k], span = (high - low) * length;
      if (span <= EPS) continue;
      const middle = (low + high) / 2, offset = Math.min(span / 10, Math.max(1e-5, length * 1e-9));
      const midpoint = { x: segment.a.x + direction.x * middle, y: segment.a.y + direction.y * middle };
      const normal = { x: -direction.y / length * offset, y: direction.x / length * offset };
      const left = inside({ x: midpoint.x + normal.x, y: midpoint.y + normal.y });
      const right = inside({ x: midpoint.x - normal.x, y: midpoint.y - normal.y });
      if (left === right) continue;
      const from = vertex({ x: segment.a.x + direction.x * (left ? low : high), y: segment.a.y + direction.y * (left ? low : high) });
      const to = vertex({ x: segment.a.x + direction.x * (left ? high : low), y: segment.a.y + direction.y * (left ? high : low) });
      const key = from + ':' + to;
      if (from !== to && !unique.has(key)) { unique.add(key); edges.push({ from, to }); }
    }
  }
  const used = new Set<number>(), loops: Point[][] = [];
  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    const walk: Point[] = [], first = edges[start].from;
    let current = start, closed = false;
    for (let steps = 0; steps <= edges.length; steps++) {
      if (used.has(current)) break;
      used.add(current); const edge = edges[current]; walk.push(copyPoint(vertices[edge.from]));
      if (edge.to === first) { closed = true; break; }
      const back = Math.atan2(vertices[edge.from].y - vertices[edge.to].y, vertices[edge.from].x - vertices[edge.to].x);
      const outgoing = edges.map((next, index) => ({ next, index })).filter(({ next, index }) => next.from === edge.to && !used.has(index));
      if (!outgoing.length) break;
      outgoing.sort((a, b) => {
        const turn = (next: typeof edge) => {
          const angle = Math.atan2(vertices[next.to].y - vertices[next.from].y, vertices[next.to].x - vertices[next.from].x);
          return (back - angle + Math.PI * 2) % (Math.PI * 2);
        };
        return turn(a.next) - turn(b.next);
      });
      current = outgoing[0].index;
    }
    if (!closed) throw new RangeError('扣除斜墙占地后的边界无法可靠闭合，请检查连接和墙厚。');
    let changed = true;
    while (changed && walk.length > 3) {
      changed = false;
      for (let k = 0; k < walk.length; k++) if (onSegment(walk[k], walk[(k + walk.length - 1) % walk.length], walk[(k + 1) % walk.length])) {
        walk.splice(k, 1); changed = true; break;
      }
    }
    if (polygonArea(walk) > EPS) loops.push(walk);
  }
  const outers = loops.filter(ring => signedArea(ring) > 0), inner = loops.filter(ring => signedArea(ring) < 0);
  if (outers.length !== 1) throw new RangeError('墙厚超过净尺寸或使净施工区域分裂，请调整墙厚与连接。');
  return { points: outers[0], holes: inner };
}

/** Produce genuine net floor polygons; unsupported shapes fail explicitly. */
export function detectPlanRooms(input: Wall[], style: WallJoinStyle = 'square'): PlanRoom[] {
  const walls = normalizeWalls(input);
  const sourceWalls = walls.map(wall => ({ ...wall, height: 260, color: '#54675b' }));
  const faces = resolveRoomGeometry({ walls: sourceWalls, rooms: [] });
  const centerlineHoles = roomHoles(faces.map(face => face.polygon));
  const footprints = wallFootprints(walls, style).map(footprint => ({ points: footprint.points, holes: [] }));
  const rooms: PlanRoom[] = [];
  for (const [index, face] of faces.entries()) {
    const childHoles = centerlineHoles[index];
    const angled = [face.polygon, ...childHoles].some(ring => ring.some((a, i) => {
      const b = ring[(i + 1) % ring.length]; return Math.abs(b.x - a.x) > EPS && Math.abs(b.y - a.y) > EPS;
    }));
    const net = angled || style === 'clean' ? netAngledFace(face.polygon, childHoles, walls, style)
      : { points: offsetRing(face.polygon, walls, true), holes: childHoles.map(hole => offsetRing(hole, walls, false)) };
    const room: PlanRoom = {
      key: JSON.stringify([...face.room.walls].sort()),
      ...net,
      centerlinePoints: face.polygon.map(copyPoint),
    };
    const validation = validateRegion({ ...room, id: room.key }, rooms.map((other, i) => ({ ...other, id: other.key || String(i) })));
    if (!validation.valid) throw new RangeError('净施工区域无效：' + validation.error);
    // Internal stubs and nearby walls can occupy floor without being face edges.
    // Never silently ignore their footprint and inflate the construction area.
    for (const footprint of footprints) {
      if (intersectionArea(room, footprint) > 1e-5) throw new RangeError('房间内还有未闭合墙段，或墙厚导致区域相交。请补齐墙线后计算净面积。');
    }
    rooms.push(room);
  }
  return rooms;
}

/** 10 cm grid and 8 screen-pixel endpoint/wall magnets. Orthogonal is the
 * backward-compatible default; free drawing retains any straight direction. */
export function snapWallPoint(point: Point, input: Wall[], zoom: number, previous?: Point, options: { orthogonal?: boolean } = {}): Point {
  if (!finitePoint(point) || previous && !finitePoint(previous)) throw new TypeError('吸附点需要有效坐标。');
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('画布缩放必须为正数。');
  const walls = normalizeWalls(input);
  const constrained = !!previous && options.orthogonal !== false;
  const horizontal = constrained ? Math.abs(point.x - previous.x) >= Math.abs(point.y - previous.y) : null;
  const constrain = (p: Point): Point => constrained ? horizontal ? { x: p.x, y: previous.y } : { x: previous.x, y: p.y } : copyPoint(p);
  const cursor = constrain(point);
  const grid = constrain({ x: Math.round(cursor.x / 10) * 10, y: Math.round(cursor.y / 10) * 10 });
  const radius = 8 / zoom;
  const aligned = (p: Point) => !constrained || (horizontal ? Math.abs(p.y - previous.y) <= EPS : Math.abs(p.x - previous.x) <= EPS);
  let best: Point | null = null, distance = radius;
  for (const wall of walls) for (const endpoint of [wall.start, wall.end]) {
    if (!aligned(endpoint)) continue;
    const d = Math.hypot(cursor.x - endpoint.x, cursor.y - endpoint.y);
    if (d <= distance) { best = copyPoint(endpoint); distance = d; }
  }
  if (best) return constrain(best);
  for (const wall of walls) {
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    let projection: Point;
    if (constrained && horizontal && Math.abs(dy) > EPS) {
      const t = (previous.y - wall.start.y) / dy;
      projection = { x: wall.start.x + dx * t, y: previous.y };
    }
    else if (constrained && !horizontal && Math.abs(dx) > EPS) {
      const t = (previous.x - wall.start.x) / dx;
      projection = { x: previous.x, y: wall.start.y + dy * t };
    }
    else {
      const source = options.orthogonal === false ? cursor : grid;
      const t = Math.max(0, Math.min(1, ((source.x - wall.start.x) * dx + (source.y - wall.start.y) * dy) / (dx * dx + dy * dy)));
      projection = { x: wall.start.x + dx * t, y: wall.start.y + dy * t };
    }
    if (!aligned(projection) || !onSegment(projection, wall.start, wall.end)) continue;
    const d = Math.hypot(cursor.x - projection.x, cursor.y - projection.y);
    if (d <= distance) { best = projection; distance = d; }
  }
  return best ? constrain(best) : grid;
}
