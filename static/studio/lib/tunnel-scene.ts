import type { Project } from '../types.js';
import type { MunicipalElement } from './municipal-design.js';
import type { Vec3 } from './camera3d.js';
import { roadTunnelGeometry, roadTunnelGeometryKey, roadTunnelAnalysis, subtractConvexPlanes, type TunnelVoid, type TunnelGeometry, type TunnelBounds } from './road-tunnel.js';

/** Shared by municipal lining and terrain portal clipping. Prices never define geometry. */
const cache=new Map<string,TunnelGeometry>();
export function buildTunnelGeometry(project:Project,road:MunicipalElement):TunnelGeometry {
  if(!road.tunnel?.enabled)return roadTunnelGeometry(project,road);
  const key=roadTunnelGeometryKey(project,road)+JSON.stringify(project.municipalTerrain??null);
  const previous=cache.get(key);if(previous)return previous;
  const base=roadTunnelGeometry(project,road),geometry={...base,analysis:roadTunnelAnalysis(project,road)};
  if(cache.size>=12)cache.delete(cache.keys().next().value);
  cache.set(key,geometry);return geometry;
}

type Tree = { bounds:TunnelBounds; children?:[Tree,Tree]; items?:TunnelVoid[] };
const indexCache=new WeakMap<TunnelVoid[],Tree>();
const intersects=(a:TunnelBounds,b:TunnelBounds)=>a.min.x<=b.max.x+1e-8&&a.max.x>=b.min.x-1e-8&&a.min.y<=b.max.y+1e-8&&a.max.y>=b.min.y-1e-8&&a.min.z<=b.max.z+1e-8&&a.max.z>=b.min.z-1e-8;
function bounds(points:Vec3[]):TunnelBounds {
  let min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
  for(const p of points)for(const axis of ['x','y','z'] as const){min[axis]=Math.min(min[axis],p[axis]);max[axis]=Math.max(max[axis],p[axis]);}
  return{min,max};
}
function buildTree(items:TunnelVoid[]):Tree{
  const box=bounds(items.flatMap(item=>[item.bounds.min,item.bounds.max]));if(items.length<=8)return{bounds:box,items};
  const axis=(['x','y','z'] as const).reduce((best,a)=>box.max[a]-box.min[a]>box.max[best]-box.min[best]?a:best,'x'),ordered=[...items].sort((a,b)=>a.bounds.min[axis]+a.bounds.max[axis]-b.bounds.min[axis]-b.bounds.max[axis]),middle=Math.floor(ordered.length/2);
  return{bounds:box,children:[buildTree(ordered.slice(0,middle)),buildTree(ordered.slice(middle))]};
}
function query(tree:Tree,box:TunnelBounds,out:TunnelVoid[]):void {
  if(!intersects(tree.bounds,box))return;
  if(tree.items){for(const item of tree.items)if(intersects(item.bounds,box))out.push(item);}else{query(tree.children[0],box,out);query(tree.children[1],box,out);}
}

/** Subtract a union without overlapping output. Surface above the roof remains
 * intact; only surveyed portal/slope triangles inside real clearance are cut. */
export function subtractTunnelVoids(points:Vec3[],voids:TunnelVoid[]):Vec3[][] {
  if(!voids.length||points.length<3)return[points];
  let tree=indexCache.get(voids);if(!tree){tree=buildTree(voids);indexCache.set(voids,tree);}
  const candidates:TunnelVoid[]=[];query(tree,bounds(points),candidates);
  let pieces=[points];
  for(const solid of candidates){
    pieces=pieces.flatMap(piece=>intersects(bounds(piece),solid.bounds)?subtractConvexPlanes(piece,solid.planes):[piece]);
    if(pieces.length>10000)throw new RangeError('单个地形面隧道裁切片数过多，请简化路线。');
    if(!pieces.length)break;
  }
  return pieces;
}
