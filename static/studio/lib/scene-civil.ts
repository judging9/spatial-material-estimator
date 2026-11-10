import type { Project, CivilElement } from '../types.js';
import type { SceneFloor } from './scene-model.js';
import type { SolidSurface, SolidVector } from './wall-solid.js';
import { buildCivilQuantities, CIVIL_PRESETS } from './civil.js';

export type SceneCivilElement = {
  id: string; name: string; kind: CivilElement['kind']; civilElementId: string;
  levelId?: string; levelName?: string; color: string; netVolume: number | null;
  horizontal: SceneFloor[]; surfaces: SolidSurface[];
  slices: { bottom: number; top: number; parts: { points: SolidVector[]; holes: SolidVector[][] }[] }[];
};
export const CIVIL_SCENE_COLORS: Record<CivilElement['kind'], string> = {
  column: '#a5b6ac', roundColumn: '#a5b6ac', beam: '#93a79b', slab: '#c3ccc1',
  padFooting: '#bdc2b2', stripFooting: '#bdc2b2', raft: '#bfc5b7', cushion: '#d4d1c1',
  masonry: '#c1afa0', retainingWall: '#a7b3a7', excavation: '#c6b499', backfill: '#d0bfa5',
};

/** Extrude the engine's net horizontal slices, including real holes and
 * retained islands. Quantities multiply procurement, never scene instances. */
export function buildSceneCivil(project: Project): SceneCivilElement[] {
    const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
    // Ownership is computed across the whole building before display filtering.
    // A tall column crossing storeys must retain the same net solid in any view.
    const quantities = buildCivilQuantities(project);
    if (!Number.isFinite(scale) || scale <= 0) return [];
    return quantities.filter(record => !record.element.hidden && record.metrics.slices?.length &&
      (project.view?.levelMode !== 'active' || !record.levelId || !project.activeLevelId || record.levelId === project.activeLevelId)).map(record => {
      const element = record.element, elevation = record.levelElevation ?? 0, color = CIVIL_PRESETS.find(preset => preset.kind === element.kind)?.color ?? CIVIL_SCENE_COLORS[element.kind], horizontal: SceneFloor[] = [], surfaces: SolidSurface[] = [];
      const slices = record.metrics.slices.map((slice, sliceIndex) => {
        const bottom = (elevation + slice.elevation) / 100, top = bottom + slice.height / 100;
        const parts = slice.parts.map((part, partIndex) => {
          const ring = (points: { x: number; y: number }[], height: number) => points.map(point => ({ x: point.x * scale, y: height, z: point.y * scale }));
          const points = ring(part.points, top), holes = (part.holes ?? []).map(hole => ring(hole, top));
          const base = `civil:${element.id}:slice:${sliceIndex}:part:${partIndex}`;
          for (const [label, height, normalY] of [['top', top, 1], ['bottom', bottom, -1]] as const) horizontal.push({ id: `${base}:${label}`, name: element.name, regionId: element.id,
            points: ring(part.points, height), holes: (part.holes ?? []).map(hole => ring(hole, height)), color, surfaceType:'civil', normalY, partIndex, partCount: slice.parts.length });
          for (const [ringIndex, boundary] of [points, ...holes].entries()) {
            const signed = boundary.reduce((sum, point, index) => { const next = boundary[(index + 1) % boundary.length]; return sum + point.x * next.z - next.x * point.z; }, 0);
            for (let index = 0; index < boundary.length; index++) {
              const a = boundary[index], b = boundary[(index + 1) % boundary.length], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
              if (length < 1e-10) continue;
              const sign = (signed >= 0 ? 1 : -1) * (ringIndex ? -1 : 1);
              surfaces.push({ id: `${base}:side:${ringIndex}:${index}`, wallId: `civil:${element.id}`, sourceIds: [], side: 'end', color,
                normal: { x: sign * dz / length, y: 0, z: -sign * dx / length }, points: [{ ...a, y: bottom }, { ...b, y: bottom }, { ...b, y: top }, { ...a, y: top }] });
            }
          }
          return { points, holes };
        });
        return { bottom, top, parts };
      });
      return { id: element.id, civilElementId: element.id, name: element.name, kind: element.kind, color, netVolume: record.metrics.netVolume, slices, horizontal, surfaces,
        levelId: record.levelId, levelName: record.levelName };
    });
}
