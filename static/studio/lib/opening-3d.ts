import type { Wall } from './wall-plan.js';
import type { WallOpening } from './wall-solid.js';
import { openingPolygon } from './wall-solid.js';
import type { Vec3 } from './camera3d.js';

/** Walls and local opening coordinates are centimetres; scene rays are metres.
 * The frame always follows the source wall direction, including reversed and
 * diagonal hosts. A source level elevation only offsets the vertical origin. */
export function openingWallFrame(wall: Wall, elevation = 0, side = 0) {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (!Number.isFinite(length) || length < 1e-8 || !Number.isFinite(elevation) || !Number.isFinite(side)) return null;
  const along = { x: (wall.end.x - wall.start.x) / length, y: 0, z: (wall.end.y - wall.start.y) / length };
  const normal = { x: -along.z, y: 0, z: along.x };
  const origin = { x: wall.start.x / 100 + normal.x * side, y: elevation / 100, z: wall.start.y / 100 + normal.z * side };
  return { origin, along, normal, length };
}

export function rayOpeningWall(origin: Vec3, direction: Vec3, wall: Wall, elevation = 0, side = 0) {
  const frame = openingWallFrame(wall, elevation, side);
  if (!frame || ![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)) return null;
  const denominator = direction.x * frame.normal.x + direction.z * frame.normal.z;
  if (Math.abs(denominator) < 1e-9) return null;
  const distance = ((frame.origin.x - origin.x) * frame.normal.x + (frame.origin.z - origin.z) * frame.normal.z) / denominator;
  if (!Number.isFinite(distance) || distance < 0) return null;
  const point = { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
  return { distance, point, x: ((point.x - frame.origin.x) * frame.along.x + (point.z - frame.origin.z) * frame.along.z) * 100, y: (point.y - frame.origin.y) * 100 };
}

export function openingContour3D(opening: WallOpening, wall: Wall, elevation = 0, side = 0): Vec3[] {
  const frame = openingWallFrame(wall, elevation, side);
  if (!frame) return [];
  return openingPolygon(opening).map(point => ({ x: frame.origin.x + frame.along.x * point.x / 100, y: frame.origin.y + point.y / 100, z: frame.origin.z + frame.along.z * point.x / 100 }));
}
