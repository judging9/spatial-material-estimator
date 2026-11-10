import type { Project, Region } from '../types.js';
import { normalizeWalls, type Point, type Wall } from './wall-plan.js';
import { validateRegion } from './geometry.js';
import { buildWallSolid, type SolidSurface, type SolidInsert } from './wall-solid.js';
import { wallFootprints, type WallJoinStyle } from './wall-joins.js';
import { levelProjects, effectiveLevelProject, ceilingHeight } from './levels.js';
import { buildSceneCivil, type SceneCivilElement } from './scene-civil.js';

/** Scene coordinates are metres: plan X → X, plan Y → Z, height → Y. */
export type Vector3Data = { x: number; y: number; z: number };
export type SceneWall = {
  id: string;
  sourceIds: string[];
  start: Vector3Data;
  end: Vector3Data;
  position: Vector3Data;
  size: { length: number; height: number; thickness: number };
  rotationY: number;
  levelId?: string;
  levelName?: string;
};
export type SceneFloor = {
  id: string;
  name: string;
  points: Vector3Data[];
  holes: Vector3Data[][];
  color: string;
  materialImage?: string;
  levelId?: string;
  levelName?: string;
  surfaceType?: 'floor' | 'ceiling' | 'slab-bottom' | 'civil';
  normalY?: number;
  regionId?: string;
  partIndex?: number;
  partCount?: number;
};
export type SceneSurface = SolidSurface & { levelId?: string; levelName?: string; regionId?: string };
export type SceneInsert = SolidInsert & { levelId?: string; levelName?: string };
export type SceneSlab = { id: string; regionId: string; levelId: string; levelName: string; top: number; bottom: number; floor: SceneFloor; underside: SceneFloor; surfaces: SceneSurface[] };
export type SceneLevel = { id: string; name: string; elevation: number; height: number; slabThickness: number };
export type SceneModel = {
  wallJoinStyle?: WallJoinStyle;
  walls: SceneWall[];
  floors: SceneFloor[];
  surfaces?: SceneSurface[];
  inserts?: SceneInsert[];
  ceilings?: SceneFloor[];
  slabs?: SceneSlab[];
  levels?: SceneLevel[];
  civilElements?: SceneCivilElement[];
  bounds: { min: Vector3Data; max: Vector3Data; center: Vector3Data; size: Vector3Data };
};

function wallHeight(wall: Wall, fallback: number): number {
  const height = wall.height ?? fallback;
  if (!Number.isFinite(height) || height < 50 || height > 1000) throw new RangeError('墙高应为 0.5–10 m。');
  return height;
}
function keyFor(wall: Wall): string {
  const pointKey = (point: Point) => `${point.x},${point.y}`;
  return [pointKey(wall.start), pointKey(wall.end)].sort().join('|') + `|${wall.thickness}`;
}
function sceneFloor(region: Region, scale: number, derivedPart = false): SceneFloor {
  // A clipped circular opening may touch the room at a single point. The
  // effective-geometry validator permits that true topology without moving it.
  const validity = validateRegion(derivedPart ? { ...region, surfaceParts: [{ points: region.points, holes: region.holes }] } : region);
  if (!validity.valid) throw new RangeError('三维地面轮廓无效：' + validity.error);
  const to3D = (point: Point): Vector3Data => {
    const x = point.x * scale, z = point.y * scale;
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError('三维地面尺寸超出有效范围，请检查图纸比例。');
    return { x, y: 0, z };
  };
  const color = region.items?.[0]?.color;
  const image = region.items?.[0]?.image;
  return {
    id: region.id, name: region.name || '房间', points: region.points.map(to3D),
    holes: (region.holes || []).map(hole => hole.map(to3D)),
    color: /^#[\da-f]{6}$/i.test(color || '') ? color : '#ddd9cf',
    ...(typeof image === 'string' && image ? { materialImage: image } : {}),
  };
}

/**
 * Pure, renderer-independent model built from the same measured polygons used
 * by pricing. Wall height affects extrusion and camera bounds only, not floor
 * area. Square wall caps match the footprint used by the 2D geometry engine.
 */
function buildSingleSceneModel(project: Project): SceneModel {
  if (!project || !Array.isArray(project.regions)) throw new TypeError('项目数据格式不正确。');
  const input = normalizeWalls(project.walls || []);
  const joinStyle:WallJoinStyle = project.wallJoinStyle ?? 'square';
  const footprintById = new Map(wallFootprints(input, joinStyle).map(footprint => [footprint.wallId, footprint.points]));
  const fallbackHeight = project.wallHeight ?? 280;
  if (!Number.isFinite(fallbackHeight) || fallbackHeight < 50 || fallbackHeight > 1000) throw new RangeError('默认墙高应为 0.5–10 m。');
  const grouped = new Map<string, { wall: Wall; height: number; sourceIds: string[] }>();
  for (const wall of input) {
    const key = keyFor(wall), height = wallHeight(wall, fallbackHeight);
    const existing = grouped.get(key);
    if (existing) {
      existing.height = Math.max(existing.height, height);
      existing.sourceIds.push(wall.id);
    } else grouped.set(key, { wall, height, sourceIds: [wall.id] });
  }
  const walls: SceneWall[] = [...grouped.values()].map(({ wall, height, sourceIds }) => {
    sourceIds.sort();
    const start = { x: wall.start.x / 100, y: 0, z: wall.start.y / 100 };
    const end = { x: wall.end.x / 100, y: 0, z: wall.end.y / 100 };
    const thickness = wall.thickness / 100, heightMeters = height / 100;
    const length = Math.hypot(end.x-start.x,end.z-start.z),ux=(end.x-start.x)/length,uz=(end.z-start.z)/length;
    const projected=(footprintById.get(wall.id)??[]).map(point=>(point.x/100-start.x)*ux+(point.y/100-start.z)*uz);
    const low=projected.length?Math.min(...projected):0,high=projected.length?Math.max(...projected):0,along=(low+high)/2;
    return {
      id: sourceIds[0], sourceIds, start, end,
      position: joinStyle==='square'?{ x: (start.x+end.x)/2, y: heightMeters/2, z: (start.z+end.z)/2 }:{ x: start.x+ux*along, y: heightMeters / 2, z: start.z+uz*along },
      size: { length: joinStyle==='square'?length+thickness:high-low, height: heightMeters, thickness },
      rotationY: -Math.atan2(end.z - start.z, end.x - start.x) || 0,
    };
  });
  const visibleRegions = project.regions.filter(region => !region.hidden);
  const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
  if (visibleRegions.length && (!Number.isFinite(scale) || scale <= 0)) throw new RangeError('请先校准图纸真实尺寸，再查看三维地面。');
  const floors = visibleRegions.flatMap(region => {
    const parts = region.surfaceParts;
    if (!parts) return [sceneFloor(region, scale)];
    return parts.map((part, index) => {
      const local = { ...region, points: part.points, holes: part.holes };
      delete local.surfaceParts;
      const floor = sceneFloor(local, scale, true);
      return { ...floor, id: parts.length === 1 ? region.id : `${region.id}:part:${index}`, regionId: region.id, partIndex: index, partCount: parts.length };
    });
  });
  const positions: Vector3Data[] = floors.flatMap(floor => floor.points);
  const solid = buildWallSolid(project);
  // Camera bounds follow the real union vertices, including rotated square caps.
  for (const surface of solid.surfaces) positions.push(...surface.points);
  for (const insert of solid.inserts) positions.push(...insert.surfaces.flatMap(surface => surface.points));
  const min = { x: 0, y: 0, z: 0 }, max = { ...min };
  if (positions.length) for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] = Math.min(...positions.map(position => position[axis]));
    max[axis] = Math.max(...positions.map(position => position[axis]));
  }
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  return { wallJoinStyle:joinStyle, walls, floors, surfaces: solid.surfaces, inserts: solid.inserts, bounds: { min, max, center, size } };
}

const translated = (point: Vector3Data, elevation: number): Vector3Data => ({ ...point, y: point.y + elevation });
const translatedSurface = (surface: SolidSurface, elevation: number, level: { id: string; name: string }): SceneSurface => ({ ...surface, points: surface.points.map(point => translated(point, elevation)), levelId: level.id, levelName: level.name });
function sceneBounds(points: Vector3Data[]): SceneModel['bounds'] {
  const min = {x:0,y:0,z:0}, max = {...min};
  if (points.length) {
    Object.assign(min,points[0]);Object.assign(max,points[0]);
    for (const point of points) for (const axis of ['x','y','z'] as const) {min[axis]=Math.min(min[axis],point[axis]);max[axis]=Math.max(max[axis],point[axis]);}
  }
  return { min, max, center: {x:(min.x+max.x)/2,y:(min.y+max.y)/2,z:(min.z+max.z)/2}, size: {x:max.x-min.x,y:max.y-min.y,z:max.z-min.z} };
}
function slabForFloor(floor: SceneFloor, thickness: number): SceneSlab {
  const top = floor.points[0]?.y ?? 0, bottom = top - thickness;
  const regionId = floor.regionId ?? floor.id;
  const underside: SceneFloor = {...floor,id:`slab:${floor.id}:bottom`,regionId,points:floor.points.map(point=>({...point,y:bottom})),holes:floor.holes.map(ring=>ring.map(point=>({...point,y:bottom}))),color:'#e1dfd5',materialImage:undefined,surfaceType:'slab-bottom',normalY:-1};
  const surfaces: SceneSurface[] = [];
  for (const [ringIndex, ring] of [floor.points,...floor.holes].entries()) {
    const signedArea = ring.reduce((sum,p,i)=>sum+p.x*ring[(i+1)%ring.length].z-ring[(i+1)%ring.length].x*p.z,0);
    for (let i=0;i<ring.length;i++) {
      const a=ring[i],b=ring[(i+1)%ring.length],dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz),sign=(signedArea>=0?1:-1)*(ringIndex? -1:1);
      if (length<=1e-10) continue;
      surfaces.push({id:`slab:${floor.id}:side:${ringIndex}:${i}`,wallId:`slab:${floor.id}`,sourceIds:[],side:'end',regionId,levelId:floor.levelId,levelName:floor.levelName,color:'#d8d7cd',normal:{x:sign*dz/length,y:0,z:-sign*dx/length},points:[{...a,y:bottom},{...b,y:bottom},{...b,y:top},{...a,y:top}]});
    }
  }
  return {id:`slab:${floor.id}`,regionId,levelId:floor.levelId,levelName:floor.levelName,top,bottom,floor,underside,surfaces};
}

/** Shared source coordinates stay local to a level. Only this scene assembly
 * applies the physical elevation, never the saved geometry or quotation. */
export function buildSceneModel(project: Project, cutawayHeight?: number): SceneModel {
  if (project.workspaceMode === 'civil') {
    const civilElements = buildSceneCivil(project), levels = project.levels?.length ? levelProjects(project).filter(level => project.view?.levelMode !== 'active' || !project.activeLevelId || level.id === project.activeLevelId)
      .map(level => ({ id: level.id, name: level.name, elevation: level.elevation / 100, height: level.height / 100, slabThickness: level.slabThickness / 100 })) : undefined;
    const positions = civilElements.flatMap(element => [...element.horizontal.flatMap(cap => cap.points), ...element.surfaces.flatMap(surface => surface.points)]);
    return { walls: [], floors: [], surfaces: [], inserts: [], ceilings: [], slabs: [], civilElements, ...(levels ? { levels } : {}), bounds: sceneBounds(positions) };
  }
  const enhanced = !!project.levels?.length || !!project.floorOpenings?.length || project.regions.some(region => region.ceiling?.enabled || region.surfaceParts);
  if (!enhanced) {
    const model = buildSingleSceneModel(project);
    if (cutawayHeight !== undefined) {
      const solid = buildWallSolid(project,cutawayHeight);
      return {...model,surfaces:solid.surfaces,inserts:solid.inserts};
    }
    return model;
  }
  const layers = levelProjects(project).filter(level=>project.view?.levelMode!=='active'||!project.activeLevelId||level.id===project.activeLevelId);
  const walls: SceneWall[]=[],floors: SceneFloor[]=[],surfaces: SceneSurface[]=[],inserts: SceneInsert[]=[],ceilings: SceneFloor[]=[],slabs: SceneSlab[]=[],levels: SceneLevel[]=[];
  for (const level of layers) {
    const source = effectiveLevelProject(level.project), elevation=level.elevation/100;
    // Material styling is derived for rendering; the group still owns one quote.
    const wallGroups=new Map((source.wallShapes??[]).flatMap(shape=>shape.wallIds.map(id=>[id,shape] as const)));
    const styled={...source,walls:source.walls?.map(wall=>{const group=wallGroups.get(wall.id);return group?{...wall,items:group.items,finishSide:group.finishSide??'both'}:wall;})};
    const local=buildSingleSceneModel(styled),solid=cutawayHeight===undefined?{surfaces:local.surfaces??[],inserts:local.inserts??[]}:buildWallSolid(styled,cutawayHeight);
    levels.push({id:level.id,name:level.name,elevation,height:level.height/100,slabThickness:level.slabThickness/100});
    walls.push(...local.walls.map(wall=>({...wall,levelId:level.id,levelName:level.name,start:translated(wall.start,elevation),end:translated(wall.end,elevation),position:translated(wall.position,elevation)})));
    surfaces.push(...solid.surfaces.map(surface=>translatedSurface(surface,elevation,level)));
    inserts.push(...solid.inserts.map(insert=>({...insert,levelId:level.id,levelName:level.name,surfaces:insert.surfaces.map(surface=>translatedSurface(surface,elevation,level))})));
    for (const floor of local.floors) {
      const lifted: SceneFloor={...floor,levelId:level.id,levelName:level.name,surfaceType:'floor',normalY:1,points:floor.points.map(point=>translated(point,elevation)),holes:floor.holes.map(ring=>ring.map(point=>translated(point,elevation)))};
      floors.push(lifted);
      if (level.slabThickness>0) slabs.push(slabForFloor(lifted,level.slabThickness/100));
      const region=source.regions.find(region=>region.id===(floor.regionId??floor.id)),ceiling=region?.ceiling;
      if (ceiling?.enabled) {
        const height=ceilingHeight(source,region);
        if (!Number.isFinite(height)||height<50||height>1000) throw new RangeError('天花板高度应为 0.5–10 m。');
        const material=ceiling.items?.[0],y=elevation+height/100;
        ceilings.push({...lifted,id:`ceiling:${floor.id}`,regionId:floor.regionId??floor.id,points:lifted.points.map(point=>({...point,y})),holes:lifted.holes.map(ring=>ring.map(point=>({...point,y}))),color:/^#[\da-f]{6}$/i.test(material?.color??'')?material.color:'#eae8df',materialImage:material?.image,surfaceType:'ceiling',normalY:-1});
      }
    }
  }
  const positions:Vector3Data[]=[...floors,...ceilings,...slabs.map(slab=>slab.underside)].flatMap(floor=>floor.points);
  positions.push(...surfaces.flatMap(surface=>surface.points),...inserts.flatMap(insert=>insert.surfaces.flatMap(surface=>surface.points)),...slabs.flatMap(slab=>slab.surfaces.flatMap(surface=>surface.points)));
  return {wallJoinStyle:project.wallJoinStyle??'square',walls,floors,surfaces,inserts,ceilings,slabs,levels,bounds:sceneBounds(positions)};
}
