import type { Project } from '../types.js';
import type { SolidSurface } from './wall-solid.js';
import { compileTerrain } from './terrain.js';
import { cross3, normalize3, sub3 } from './camera3d.js';
import { buildTunnelGeometry, subtractTunnelVoids } from './tunnel-scene.js';

export function buildTerrainScene(project: Project): SolidSurface[] {
  if(project.workspaceMode!=='municipal'||!project.municipalTerrain?.visible)return[];
  const mesh = compileTerrain(project.municipalTerrain);
  const voids=(project.municipalElements??[]).filter(road=>!road.hidden&&road.kind==='road'&&road.tunnel?.enabled).flatMap(road=>buildTunnelGeometry(project,road).voids);
  let min = Infinity, max = -Infinity;
  for (const triangle of mesh.triangles) for (const point of triangle) { min = Math.min(min, point.z); max = Math.max(max, point.z); }
  return mesh.triangles.flatMap((triangle,index)=>{
    const points=triangle.map(p=>({x:p.x,y:p.z,z:p.y}));
    let normal=normalize3(cross3(sub3(points[1],points[0]),sub3(points[2],points[0])));
    if(normal.y<0){points.reverse();normal={x:-normal.x,y:-normal.y,z:-normal.z};}
    // Height and slope come from the same real vertices that define earthwork.
    // Muted vegetation-to-stone tones make steep mountains readable without
    // adding textures, extra geometry or an artificial elevation multiplier.
    const height = triangle.reduce((sum, p) => sum + p.z / 3, 0), t = max === min ? .35 : (height - min) / (max - min);
    const rocky = Math.max(0, Math.min(1, (1 - normal.y) * 1.2)), low = [190,206,178], high = [218,218,205], rock = [171,175,161];
    const color = '#' + low.map((channel, i) => Math.round((channel + (high[i] - channel) * t) * (1 - rocky) + rock[i] * rocky).toString(16).padStart(2,'0')).join('');
    return subtractTunnelVoids(points,voids).map((piece,part)=>({id:`terrain:${index}:${part}`,wallId:'terrain',sourceIds:[],side:'end' as const,points:piece,normal,color}));
  });
}
