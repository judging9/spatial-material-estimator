import type { Furniture, FurnitureKind, Point, Project } from '../types.js';

/** Hardware is kept at its actual size; only UI picking may add a screen halo. */
export const FIXTURE_KINDS: readonly FurnitureKind[] = [
  'socketFive', 'socketWaterproof', 'socketFloor', 'socketUsb', 'socketAirConditioner', 'powerPlug',
  'switchSingle', 'switchDouble', 'switchTriple', 'switchTwoWay', 'switchDimmer',
  'distributionBox', 'lowVoltageBox', 'networkPanel', 'tvPanel',
  'waterOutletCold', 'waterOutletHot', 'floorDrain', 'waterValve', 'manifold',
  'downlight', 'spotlight', 'ledStripController', 'wallLight', 'pendantLight', 'linearLight',
  'router', 'wirelessAP', 'radiator', 'freshAirVent', 'exhaustFan', 'thermostat', 'smokeDetector', 'smartPanel', 'doorbell',
];
const fixtureKinds = new Set<unknown>(FIXTURE_KINDS);
const wallFixtures = new Set<unknown>([
  'socketFive', 'socketWaterproof', 'socketUsb', 'socketAirConditioner',
  'switchSingle', 'switchDouble', 'switchTriple', 'switchTwoWay', 'switchDimmer',
  'distributionBox', 'lowVoltageBox', 'networkPanel', 'tvPanel', 'waterOutletCold', 'waterOutletHot',
  'waterValve', 'manifold', 'wallLight', 'radiator', 'freshAirVent', 'exhaustFan', 'thermostat', 'smartPanel', 'doorbell',
]);

export function isFixtureKind(kind: unknown): kind is FurnitureKind { return fixtureKinds.has(kind); }
export function isWallFixtureKind(kind: unknown): kind is FurnitureKind { return wallFixtures.has(kind); }

export type FixtureWallPlacement = { position: Point; rotation: number; snapped: boolean; wallId: string | null };

/** Attach the back (-depth/2) to the clicked face, front (+depth/2) outward.
 * Walls and native plans use centimetres. A remote click, image or floor /
 * ceiling appliance retains free placement, rather than inventing a host.
 * This does not bind furniture to walls or impose electrical installation rules. */
export function fixtureWallPlacement(
  item: Pick<Furniture, 'kind' | 'width' | 'depth' | 'rotation'>, point: Point,
  project: Pick<Project, 'walls' | 'drawing' | 'calibration'>, maxDistanceCm = 24,
): FixtureWallPlacement {
  const free: FixtureWallPlacement = { position: { ...point }, rotation: item.rotation, snapped: false, wallId: null };
  if (!isWallFixtureKind(item.kind) || project.drawing?.type !== 'plan' ||
      ![point.x, point.y, item.width, item.depth, maxDistanceCm].every(Number.isFinite) || maxDistanceCm < 0) return free;
  let best: FixtureWallPlacement | null = null, bestDistance = Infinity;
  for (const wall of project.walls ?? []) {
    if (![wall.start?.x, wall.start?.y, wall.end?.x, wall.end?.y, wall.thickness].every(Number.isFinite) || wall.thickness <= 0) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, length = Math.hypot(dx, dy);
    if (length < item.width || length < 1) continue;
    const ux = dx / length, uy = dy / length, nx = -uy, ny = ux;
    const along = (point.x - wall.start.x) * ux + (point.y - wall.start.y) * uy;
    const signed = (point.x - wall.start.x) * nx + (point.y - wall.start.y) * ny;
    const margin = item.width / 2, clippedAlong = Math.max(margin, Math.min(length - margin, along));
    const distance = Math.hypot(along - clippedAlong, Math.max(0, Math.abs(signed) - wall.thickness / 2));
    if (distance > maxDistanceCm || distance >= bestDistance) continue;
    const angle = item.rotation * Math.PI / 180;
    const oldFrontDot = -Math.sin(angle) * nx + Math.cos(angle) * ny;
    const side = Math.abs(signed) > 1e-8 ? Math.sign(signed) : Math.abs(oldFrontDot) > 1e-8 ? Math.sign(oldFrontDot) : (ny > 0 || Math.abs(ny) < 1e-8 && nx >= 0 ? 1 : -1);
    const offset = side * (wall.thickness + item.depth) / 2;
    const rotation = ((Math.atan2(dy, dx) * 180 / Math.PI + (side < 0 ? 180 : 0)) % 360 + 360) % 360;
    best = { position: { x: wall.start.x + ux * clippedAlong + nx * offset, y: wall.start.y + uy * clippedAlong + ny * offset }, rotation, snapped: true, wallId: wall.id };
    bestDistance = distance;
  }
  return best ?? free;
}
