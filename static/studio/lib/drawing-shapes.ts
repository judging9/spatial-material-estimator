import type { Point } from './wall-plan.js';

export type ShapeSampling = { chordErrorCm?: number; maxStepDegrees?: number; maxSegments?: number; minimumSegmentLengthCm?: number };
export type DrawingShape = {
  kind: 'circle' | 'arc'; center: Point; radius: number; startDegrees: number; sweepDegrees: number;
  closed: boolean; points: Point[]; segmentCount: number;
  exactLength: number; polylineLength: number; lengthError: number; maxDeviation: number;
};
const TAU = Math.PI * 2, RAD = Math.PI / 180;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (p: Point) => {
  if (!p || ![p.x, p.y].every(Number.isFinite) || Math.abs(p.x) > 1_000_000 || Math.abs(p.y) > 1_000_000) throw new RangeError('圆与圆弧坐标必须是有效厘米坐标。');
};
const angleDegrees = (angle: number) => ((angle / RAD % 360) + 360) % 360;

/** Deterministic centimetre geometry. A sampled wall follows these chords;
 * exact curve length is disclosed separately and never substitutes its mesh. */
function sample(center: Point, radius: number, startDegrees: number, sweepDegrees: number, closed: boolean,
  options: ShapeSampling = {}, throughFraction?: number): DrawingShape {
  point(center);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 1_000_000) throw new RangeError('圆弧半径必须大于 0 且不超过 10000 m。');
  if (![startDegrees, sweepDegrees].every(Number.isFinite) || !sweepDegrees || Math.abs(sweepDegrees) > 360) throw new RangeError('圆弧角度必须有效，扫过角应在 -360° 至 360° 之间且不能为零。');
  const error = options.chordErrorCm ?? .5, step = options.maxStepDegrees ?? 5, budget = options.maxSegments ?? 200, minimum = options.minimumSegmentLengthCm ?? 1;
  if (!Number.isFinite(error) || error <= 0 || error > .5 || !Number.isFinite(step) || step <= 0 || step > 5 || !Number.isInteger(budget) || budget < 1 || budget > 200 || !Number.isFinite(minimum) || minimum < 1) throw new RangeError('曲线采样参数无效；弦偏差最多 0.5 cm、步角最多 5°、墙段最多 200 段。');
  const sagittaStep = 2 * Math.acos(Math.max(-1, 1 - error / radius)), maxAngle = Math.min(step * RAD, sagittaStep);
  if (!(maxAngle > 0)) throw new RangeError('所需曲线精度超出当前坐标范围。');
  const sweep = sweepDegrees * RAD, start = startDegrees * RAD, stops = throughFraction === undefined ? [0, 1] : [0, throughFraction, 1];
  const parameters: number[] = [0]; let maxDeviation = 0;
  for (let i = 1; i < stops.length; i++) {
    const span = stops[i] - stops[i - 1], count = Math.max(1, Math.ceil(Math.abs(sweep) * span / maxAngle - 1e-12));
    if (!Number.isFinite(count) || parameters.length - 1 + count > budget) throw new RangeError(`保持曲线精度需要超过 ${budget} 段墙，请缩小半径、缩短圆弧或释放墙段预算。`);
    const deviation = radius * (1 - Math.cos(Math.abs(sweep) * span / count / 2));
    maxDeviation = Math.max(maxDeviation, deviation);
    for (let segment = 1; segment <= count; segment++) parameters.push(stops[i - 1] + span * segment / count);
  }
  const points = parameters.slice(0, closed ? -1 : undefined).map(t => ({ x: center.x + radius * Math.cos(start + sweep * t), y: center.y + radius * Math.sin(start + sweep * t) }));
  points.forEach(point);
  let polylineLength = 0;
  for (let i = 0; i < (closed ? points.length : points.length - 1); i++) {
    const length = distance(points[i], points[(i + 1) % points.length]);
    if (length < minimum - 1e-7) throw new RangeError('圆弧过小或过短，采样后墙段不足 1 cm；请增大半径或扫过角。');
    polylineLength += length;
  }
  const exactLength = radius * Math.abs(sweep);
  return { kind: closed ? 'circle' : 'arc', center: { ...center }, radius, startDegrees: angleDegrees(start), sweepDegrees,
    closed, points, segmentCount: parameters.length - 1, exactLength, polylineLength, lengthError: exactLength - polylineLength, maxDeviation };
}

/** Circle points are a simple closed ring; its closing point is not repeated. */
export function makeCircle(center: Point, radius: number, options?: ShapeSampling): DrawingShape {
  return sample(center, radius, 0, 360, true, options);
}
export function circleFromPoints(center: Point, edge: Point, options?: ShapeSampling): DrawingShape {
  point(center); point(edge); return makeCircle(center, distance(center, edge), options);
}
/** Positive degrees turn clockwise in plan coordinates (Y increases down). */
export function makeArc(center: Point, radius: number, startDegrees: number, sweepDegrees: number, options?: ShapeSampling): DrawingShape {
  if (Math.abs(sweepDegrees) >= 360) throw new RangeError('完整一圈请使用画圆；圆弧扫过角必须小于 360°。');
  return sample(center, radius, startDegrees, sweepDegrees, false, options);
}

/** Circumcircle through three real points. Includes the clicked through point
 * as a vertex and retains the major arc when that is what the user drew. */
export function arcThroughPoints(start: Point, through: Point, end: Point, options?: ShapeSampling): DrawingShape {
  [start, through, end].forEach(point);
  const bx = through.x - start.x, by = through.y - start.y, cx = end.x - start.x, cy = end.y - start.y;
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy, determinant = 2 * (bx * cy - by * cx);
  if (Math.min(distance(start, through), distance(through, end), distance(start, end)) < 1e-7 || Math.abs(determinant) <= 1e-10 * Math.sqrt(b2 * c2)) throw new RangeError('圆弧的起点、经过点和终点不能重合或共线。');
  const center = { x: start.x + (cy * b2 - by * c2) / determinant, y: start.y + (bx * c2 - cx * b2) / determinant };
  const first = Math.atan2(start.y - center.y, start.x - center.x), middle = Math.atan2(through.y - center.y, through.x - center.x), last = Math.atan2(end.y - center.y, end.x - center.x);
  const positive = (a: number) => ((a % TAU) + TAU) % TAU;
  const endSweep = positive(last - first), throughSweep = positive(middle - first);
  const sweep = throughSweep < endSweep ? endSweep : endSweep - TAU;
  const part = sweep > 0 ? throughSweep : throughSweep - TAU;
  const shape = sample(center, distance(center, start), first / RAD, sweep / RAD, false, options, part / sweep);
  shape.points[0] = { ...start }; shape.points[shape.points.length - 1] = { ...end };
  const index = shape.points.findIndex(p => distance(p, through) < 1e-5);
  if (index < 0) throw new RangeError('圆弧经过点无法可靠采样。');
  shape.points[index] = { ...through };
  // Keep disclosed measured length tied to the exact returned coordinates.
  shape.polylineLength = shape.points.slice(1).reduce((sum, p, i) => sum + distance(p, shape.points[i]), 0);
  shape.lengthError = shape.exactLength - shape.polylineLength;
  return shape;
}
