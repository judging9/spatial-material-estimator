import type { Furniture, Project } from '../types.js';
import type { SolidSurface, SolidVector } from './wall-solid.js';
import { furnitureScale, validateFurniture } from './furniture.js';
import { catalogFurnitureForm } from './furniture-forms.js';
import { buildStair3D, isStairKind } from './stairs.js';

export type Furniture3D = {
  id: string; name: string; kind: Furniture['kind']; position: SolidVector;
  size: { width: number; depth: number; height: number }; rotation: number;
  surfaces: SolidSurface[];
  geometrySource: 'original-mesh' | 'parametric';
};
export type FurnitureAssetFace = { points: [number, number, number][]; normal: [number, number, number]; color: string };
export type FurnitureAssets = { schema: 1; models: Record<string, { faces: FurnitureAssetFace[]; triangles: number }>; license: string; creator: string; units: string };
export const FURNITURE_ASSET_URL = new URL('../assets/furniture-original.json', import.meta.url).href;

/** Reject malformed asset geometry before it reaches the rendering context. */
export function validateFurnitureAssets(value: unknown): FurnitureAssets {
  const input = value as FurnitureAssets;
  if (!input || input.schema !== 1 || input.units !== 'normalized-metres' || !input.models || typeof input.models !== 'object' || Array.isArray(input.models) || Object.keys(input.models).length > 128) throw new RangeError('家具模型文件格式不正确。');
  for (const model of Object.values(input.models)) {
    if (!model || !Array.isArray(model.faces) || !model.faces.length || model.faces.length > 2000 || !Number.isInteger(model.triangles)) throw new RangeError('家具模型面数量不正确。');
    for (const face of model.faces) {
      if (!face || !Array.isArray(face.points) || face.points.length < 3 || face.points.length > 16 || !face.points.every(p => Array.isArray(p) && p.length === 3 && p.every((n, axis) => Number.isFinite(n) && n >= (axis === 1 ? -.001 : -.501) && n <= (axis === 1 ? 1.001 : .501)))) throw new RangeError('家具模型坐标不正确。');
      if (!Array.isArray(face.normal) || face.normal.length !== 3 || !face.normal.every(Number.isFinite) || Math.abs(Math.hypot(...face.normal) - 1) > .01 || !/^#[\da-f]{6}$/i.test(face.color)) throw new RangeError('家具模型材质或法向不正确。');
    }
    if (model.triangles !== model.faces.reduce((sum, face) => sum + face.points.length - 2, 0)) throw new RangeError('家具模型三角形数量不正确。');
  }
  return structuredClone(input);
}
type Part = { x: number; z: number; bottom: number; top: number; width: number; depth: number; color: string };

/** Compact furniture forms in actual dimensions, independent of WebGL. One
 * placed entry is one instance; procurement quantity never invents positions. */
export function buildFurniture3D(project: Pick<Project, 'furniture' | 'drawing' | 'calibration'>, assets?: FurnitureAssets): Furniture3D[] {
  validateFurniture(project.furniture);
  const scale = furnitureScale(project);
  if (!scale) return [];
  return (project.furniture ?? []).filter(item => !item.hidden).map(item => {
    if (isStairKind(item.kind)) return buildStair3D(item, project);
    const width = item.width / 100, depth = item.depth / 100, height = item.height / 100;
    const position = { x: item.position.x * scale, y: (item.mountHeight ?? 0) / 100, z: item.position.y * scale };
    const angle = item.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const asset = assets?.models[item.kind];
    if (asset) {
      const surfaces: SolidSurface[] = asset.faces.map((face, index) => {
        const nx = face.normal[0] / width, ny = face.normal[1] / height, nz = face.normal[2] / depth, length = Math.hypot(nx, ny, nz);
        return { id: `furniture:${item.id}:asset:${index}`, wallId: `furniture:${item.id}`, sourceIds: [], side: 'end', color: face.color,
          points: face.points.map(([x,y,z]) => ({ x: position.x + x * width * c - z * depth * s, y: position.y + y * height, z: position.z + x * width * s + z * depth * c })),
          normal: { x: (nx * c - nz * s) / length, y: ny / length, z: (nx * s + nz * c) / length } };
      });
      return { id: item.id, name: item.name, kind: item.kind, position, size: { width, depth, height }, rotation: item.rotation, surfaces, geometrySource: 'original-mesh' as const };
    }
    const parts: Part[] = [], add = (x: number, z: number, bottom: number, top: number, w: number, d: number, color: string) => parts.push({ x, z, bottom, top, width: w, depth: d, color });
    const legs = (top: number) => {
      const w = Math.min(width * .12, .09), d = Math.min(depth * .12, .09);
      for (const x of [-1, 1]) for (const z of [-1, 1]) add(x * (width / 2 - w), z * (depth / 2 - d), 0, top, w, d, '#a89176');
    };
    const catalogForm = catalogFurnitureForm(item.kind,item.height);
    if (catalogForm) {
      parts.push(...catalogForm.boxes.map(part => ({...part,x:part.x*width,z:part.z*depth,bottom:part.bottom*height,top:part.top*height,width:part.width*width,depth:part.depth*depth})));
    } else if (item.kind === 'sofa') {
      add(0, 0, 0, height * .48, width, depth, '#c7c7b9');
      add(0, -depth * .41, height * .40, height, width, depth * .18, '#bbbfae');
      add(0, depth * .08, height * .48, height * .68, width * .78, depth * .72, '#deddd1');
      for (const side of [-1, 1]) add(side * width * .445, 0, height * .43, height * .85, width * .11, depth, '#c2c6b7');
    } else if (item.kind === 'bed') {
      add(0, 0, 0, height * .40, width, depth, '#ae967c');
      add(0, depth * .025, height * .40, height * .83, width * .96, depth * .92, '#e4e1d5');
      add(0, -depth * .475, height * .2, height, width, depth * .05, '#bfa991');
      for (const side of [-1, 1]) add(side * width * .235, -depth * .29, height * .83, height * .95, width * .40, depth * .22, '#f1efe7');
    } else if (item.kind === 'table') {
      legs(height * .9); add(0, 0, height * .9, height, width, depth, '#c2aa8c');
    } else if (item.kind === 'chair') {
      legs(height * .45); add(0, 0, height * .45, height * .55, width, depth, '#c4b397');
      add(0, -depth * .45, height * .50, height, width, depth * .1, '#b7a78c');
    } else if (item.kind === 'nightstand') {
      add(0, 0, 0, height, width, depth, '#cdbca4');
      for (const y of [.30, .65]) add(0, depth * .495, height * y, height * (y + .25), width * .90, depth * .01, '#d2d0c4');
    } else if (item.kind === 'wardrobe') {
      add(0, 0, 0, height, width, depth, '#cdbca4');
      for (const x of [-.245, .245]) add(width * x, depth * .495, height * .05, height * .95, width * .47, depth * .01, '#d2d0c4');
    } else {
      add(0, 0, 0, height, width, depth, item.kind === 'cabinet' ? '#c6c2b4' : '#c5c9be');
    }
    const transform = (p: SolidVector): SolidVector => ({ x: position.x + p.x * c - p.z * s, y: position.y + p.y, z: position.z + p.x * s + p.z * c });
    const normal = (p: SolidVector): SolidVector => ({ x: p.x * c - p.z * s, y: p.y, z: p.x * s + p.z * c });
    const surfaces: SolidSurface[] = [];
    for (const [partIndex, part] of parts.entries()) {
      const x0 = part.x - part.width / 2, x1 = part.x + part.width / 2, z0 = part.z - part.depth / 2, z1 = part.z + part.depth / 2;
      const y0 = part.bottom, y1 = part.top;
      const faces: { points: number[][]; normal: SolidVector; side: SolidSurface['side'] }[] = [
        { points: [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]], normal: { x: -1, y: 0, z: 0 }, side: 'end' },
        { points: [[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]], normal: { x: 1, y: 0, z: 0 }, side: 'end' },
        { points: [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]], normal: { x: 0, y: 0, z: -1 }, side: 'right' },
        { points: [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], normal: { x: 0, y: 0, z: 1 }, side: 'left' },
        { points: [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]], normal: { x: 0, y: 1, z: 0 }, side: 'top' },
        { points: [[x0,y0,z1],[x0,y0,z0],[x1,y0,z0],[x1,y0,z1]], normal: { x: 0, y: -1, z: 0 }, side: 'bottom' },
      ];
      for (const [faceIndex, face] of faces.entries()) surfaces.push({ id: `furniture:${item.id}:${partIndex}:${faceIndex}`, wallId: `furniture:${item.id}`, sourceIds: [],
        side: face.side, points: face.points.map(([x,y,z]) => transform({x,y,z})), normal: normal(face.normal), color: part.color });
    }
    for (const [index, ellipse] of (catalogForm?.ellipses ?? []).entries()) {
      const facing = ellipse.facing ?? 1;
      const points: SolidVector[] = Array.from({length:32},(_,i) => {
        const angle = i*Math.PI/16*(ellipse.axis==='y'?-1:1)*facing, x = (ellipse.x+ellipse.radiusX*Math.cos(angle))*width;
        const other = ellipse.radiusOther*Math.sin(angle);
        return transform({x,y:(ellipse.y+(ellipse.axis==='z'?other:0))*height,z:(ellipse.z+(ellipse.axis==='y'?other:0))*depth});
      });
      surfaces.push({id:`furniture:${item.id}:detail:${index}`,wallId:`furniture:${item.id}`,sourceIds:[],side:'end',points,
        normal:normal(ellipse.axis==='y'?{x:0,y:facing,z:0}:{x:0,y:0,z:facing}),color:ellipse.color});
    }
    for (const [index, cylinder] of (catalogForm?.cylinders ?? []).entries()) {
      const axis = cylinder.axis, scales = { x: width, y: height, z: depth };
      const centre: SolidVector = { x: cylinder.x*width, y: cylinder.y*height, z: cylinder.z*depth };
      const half = cylinder.length*scales[axis]/2;
      const axial = (amount: number): SolidVector => ({x:axis==='x'?amount:0,y:axis==='y'?amount:0,z:axis==='z'?amount:0});
      const ring = (offset: number): SolidVector[] => Array.from({length:32},(_,i)=>{
        const theta = i*Math.PI/16, a = cylinder.radiusA*Math.cos(theta), b = cylinder.radiusB*Math.sin(theta);
        return axis==='x' ? {x:centre.x+offset,y:centre.y+b*height,z:centre.z+a*depth}
          : axis==='y' ? {x:centre.x+a*width,y:centre.y+offset,z:centre.z+b*depth}
          : {x:centre.x+a*width,y:centre.y+b*height,z:centre.z+offset};
      });
      const low = ring(-half), high = ring(half);
      const emit = (points: SolidVector[], outward: SolidVector, suffix: string, side: SolidSurface['side'] = 'end') => {
        const a = points[0], b = points[1], d = points[2], u = {x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}, v = {x:d.x-a.x,y:d.y-a.y,z:d.z-a.z};
        let n = {x:u.y*v.z-u.z*v.y,y:u.z*v.x-u.x*v.z,z:u.x*v.y-u.y*v.x};
        const length = Math.hypot(n.x,n.y,n.z);
        if (length < 1e-15) return;
        n = {x:n.x/length,y:n.y/length,z:n.z/length};
        if (n.x*outward.x+n.y*outward.y+n.z*outward.z<0) {points=[...points].reverse();n={x:-n.x,y:-n.y,z:-n.z};}
        surfaces.push({id:`furniture:${item.id}:cylinder:${index}:${suffix}`,wallId:`furniture:${item.id}`,sourceIds:[],side,points:points.map(transform),normal:normal(n),color:cylinder.color});
      };
      for(let i=0;i<32;i++){
        const j=(i+1)%32, outward={x:(low[i].x+low[j].x)/2-centre.x,y:(low[i].y+low[j].y)/2-centre.y,z:(low[i].z+low[j].z)/2-centre.z};
        outward[axis]=0;
        emit([low[i],low[j],high[j],high[i]],outward,String(i));
      }
      emit(low,axial(-1),'low',axis==='y'?'bottom':'end');
      emit(high,axial(1),'high',axis==='y'?'top':'end');
    }
    // Face inlays share a cap plane. Emit them after the cylinder body, while
    // real depth testing still keeps deeper fan housings behind front blades.
    surfaces.sort((a,b)=>Number(a.id.includes(':detail:'))-Number(b.id.includes(':detail:')));
    return { id: item.id, name: item.name, kind: item.kind, position, size: { width, depth, height }, rotation: item.rotation, surfaces, geometrySource: 'parametric' as const };
  });
}
