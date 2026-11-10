import type { Project } from '../types.js';
import { levelProjects, effectiveLevelProject } from './levels.js';
import { buildFurniture3D, type Furniture3D, type FurnitureAssets } from './furniture3d.js';
import { isStairKind } from './stairs.js';

export type LeveledFurniture = Furniture3D & {
  levelId?: string; levelName?: string;
  sourceLevelId?: string; sourceLevelName?: string;
  targetLevelId?: string; isIncoming?: boolean;
};

/** A stair belongs to its source storey for editing and pricing. Showing it
 * at the target landing never creates a second instance or changes elevation. */
export function buildLevelFurniture(project: Project, assets?: FurnitureAssets): LeveledFurniture[] {
  if (!project.levels?.length) return buildFurniture3D(project, assets);
  const activeOnly = project.view?.levelMode === 'active';
  return levelProjects(project).flatMap(level => {
    const ownLayer = !activeOnly || level.id === project.activeLevelId;
    const visibleFurniture = (level.project.furniture ?? []).filter(item => ownLayer ||
      isStairKind(item.kind) && item.stairTargetLevelId === project.activeLevelId);
    if (!visibleFurniture.length) return [];
    const rawById = new Map(visibleFurniture.map(item => [item.id, item]));
    const source = { ...effectiveLevelProject(level.project), furniture: visibleFurniture };
    const offset = level.elevation / 100;
    return buildFurniture3D(source, assets).map(item => ({
      ...item, levelId: level.id, levelName: level.name,
      sourceLevelId: level.id, sourceLevelName: level.name,
      targetLevelId: rawById.get(item.id)?.stairTargetLevelId,
      isIncoming: activeOnly && !ownLayer,
      position: { ...item.position, y: item.position.y + offset },
      surfaces: item.surfaces.map(surface => ({ ...surface,
        points: surface.points.map(point => ({ ...point, y: point.y + offset })) })),
    }));
  });
}
