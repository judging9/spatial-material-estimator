import type { Wall, Point } from './wall-plan.js';
import { normalizeWalls } from './wall-plan.js';
import { intersectionArea, polygonArea, pointInRegion, validatePolygon } from './geometry.js';
import { continuousWallFaces } from './wall-selection.js';
import { wallFootprints, type WallJoinStyle } from './wall-joins.js';
import { validateOpeningQuote, type OpeningQuoteConfig } from './opening-pricing.js';

export type SolidVector = { x: number; y: number; z: number };
export type WallOpening = { id: string; wallId: string; kind: 'door' | 'window' | 'hole'; shape: 'rectangle' | 'ellipse' | 'polygon'; offset: number; bottom: number; width: number; height: number; depth: number; points?: Point[]; name?: string; locked?: boolean; quote?: OpeningQuoteConfig };
export type SolidSurface = { id: string; wallId: string; sourceIds: string[]; side: 'left' | 'right' | 'end' | 'top' | 'bottom' | 'reveal'; points: SolidVector[]; normal: SolidVector; color?: string; materialImage?: string; openingId?: string };
export type SolidInsert = { id: string; wallId: string; kind: 'door' | 'window'; depth: number; surfaces: SolidSurface[] };
/** Finish quantities cover exposed long sides only. End/reveal fields describe
 * the physical solid and are deliberately excluded from every billed measure. */
export type WallSurfaceMetrics = { id: string; side: 'both' | 'left' | 'right'; grossArea: number; openingArea: number; netArea: number; leftArea: number; rightArea: number; endArea: number; revealArea: number; perimeter: number };
export type WallSolidProject = { walls?: Wall[]; openings?: WallOpening[]; wallHeight?: number; wallJoinStyle?: WallJoinStyle };
export type WallSolid = { surfaces: SolidSurface[]; inserts: SolidInsert[]; metrics: WallSurfaceMetrics[]; openings: WallOpening[] };

const EPS = 1e-7;
/** A deterministic 128-edge ellipse: display, holes and quantities use one ring. */
export const ELLIPSE_SEGMENTS = 128;
type Box = { wall: Wall; minX: number; maxX: number; minZ: number; maxZ: number; height: number; fullHeight: number; axis: 'x' | 'z'; sign: number; length: number };
type Face = { axis: 'x' | 'y' | 'z'; coordinate: number; direction: number; points: Point[]; side: SolidSurface['side'] };
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x:x0,y:y0 },{ x:x1,y:y0 },{ x:x1,y:y1 },{ x:x0,y:y1 }];
const signedArea = (ring:Point[]) => ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p.x*q.y-q.x*p.y;},0)/2;
const ccw = (ring:Point[]) => signedArea(ring)<0 ? [...ring].reverse() : ring;
const cross = (a:Point,b:Point,c:Point) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const clean = (ring:Point[]):Point[] => ring.filter((p,i)=>Math.hypot(p.x-ring[(i+ring.length-1)%ring.length].x,p.y-ring[(i+ring.length-1)%ring.length].y)>EPS);
function ringsTouch(a:Point[],b:Point[]):boolean{
  const on=(p:Point,q:Point,r:Point)=>Math.abs(cross(q,r,p))<=EPS*Math.max(1,Math.hypot(r.x-q.x,r.y-q.y))&&p.x>=Math.min(q.x,r.x)-EPS&&p.x<=Math.max(q.x,r.x)+EPS&&p.y>=Math.min(q.y,r.y)-EPS&&p.y<=Math.max(q.y,r.y)+EPS;
  for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){
    const p=a[i],q=a[(i+1)%a.length],r=b[j],s=b[(j+1)%b.length];
    if(on(p,r,s)||on(q,r,s)||on(r,p,q)||on(s,p,q))return true;
    if(cross(p,q,r)*cross(p,q,s)<0&&cross(r,s,p)*cross(r,s,q)<0)return true;
  }
  return false;
}

/** Clip one convex polygon to a half plane, keeping its vertex coordinates exact. */
function halfPlane(ring:Point[],a:Point,b:Point,inside:boolean):Point[]{
  if(!ring.length)return [];
  const result:Point[]=[];
  for(let i=0;i<ring.length;i++){
    const p=ring[i],q=ring[(i+1)%ring.length],dp=cross(a,b,p),dq=cross(a,b,q);
    const pIn=inside?dp>=-EPS:dp<=EPS,qIn=inside?dq>=-EPS:dq<=EPS;
    if(pIn)result.push({...p});
    if(pIn!==qIn){const t=dp/(dp-dq);result.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}
  }
  const cleaned=clean(result);return cleaned.length>=3&&polygonArea(cleaned)>EPS*EPS?cleaned:[];
}
/** Difference is a list of disjoint convex pieces, never a fan across a hole. */
function subtractConvex(subject:Point[],clip:Point[]):Point[][]{
  if(!subject.length)return [];
  const bounds=(ring:Point[])=>({minX:Math.min(...ring.map(p=>p.x)),maxX:Math.max(...ring.map(p=>p.x)),minY:Math.min(...ring.map(p=>p.y)),maxY:Math.max(...ring.map(p=>p.y))});
  const aBounds=bounds(subject),bBounds=bounds(clip);
  if(Math.min(aBounds.maxX,bBounds.maxX)-Math.max(aBounds.minX,bBounds.minX)<=EPS||Math.min(aBounds.maxY,bBounds.maxY)-Math.max(aBounds.minY,bBounds.minY)<=EPS)return [subject];
  let remainder=subject;const result:Point[][]=[];const cut=ccw(clip);
  for(let i=0;i<cut.length&&remainder.length;i++){
    const a=cut[i],b=cut[(i+1)%cut.length],outside=halfPlane(remainder,a,b,false);
    if(outside.length)result.push(outside);
    remainder=halfPlane(remainder,a,b,true);
  }
  return result;
}
function convexPieces(ring:Point[]):Point[][]{
  const points=ccw(ring),indices=points.map((_,i)=>i),result:Point[][]=[];
  while(indices.length>3){
    let found=false;
    for(let i=0;i<indices.length;i++){
      const a=indices[(i+indices.length-1)%indices.length],b=indices[i],c=indices[(i+1)%indices.length];
      if(cross(points[a],points[b],points[c])<=EPS)continue;
      if(indices.some(p=>p!==a&&p!==b&&p!==c&&cross(points[a],points[b],points[p])>=-EPS&&cross(points[b],points[c],points[p])>=-EPS&&cross(points[c],points[a],points[p])>=-EPS))continue;
      result.push([points[a],points[b],points[c]]);indices.splice(i,1);found=true;break;
    }
    if(!found)throw new RangeError('开孔轮廓不能可靠三角化，请检查顶点。');
  }
  result.push(indices.map(i=>points[i]));return result;
}
function subtractPolygons(pieces:Point[][],ring:Point[]):Point[][]{
  const polygon=ccw(ring);
  const isConvex=polygon.every((p,i)=>cross(p,polygon[(i+1)%polygon.length],polygon[(i+2)%polygon.length])>=-EPS);
  for(const clip of isConvex?[polygon]:convexPieces(polygon))pieces=pieces.flatMap(piece=>subtractConvex(piece,clip));
  return pieces;
}

/** Local elevation ring in centimetres, offset from the wall's start endpoint. */
export function openingPolygon(opening:WallOpening):Point[]{
  let ring:Point[];
  if(opening.shape==='rectangle')ring=rect(0,0,opening.width,opening.height);
  else if(opening.shape==='ellipse')ring=Array.from({length:ELLIPSE_SEGMENTS},(_,i)=>{const a=i*Math.PI*2/ELLIPSE_SEGMENTS;return {x:opening.width/2*(1+Math.cos(a)),y:opening.height/2*(1+Math.sin(a))};});
  else if(opening.shape==='polygon')ring=(opening.points||[]).map(p=>({...p}));
  else throw new RangeError('开孔形状应为矩形、椭圆或多边形。');
  return ccw(ring).map(p=>({x:p.x+opening.offset,y:p.y+opening.bottom}));
}
function boxesFor(walls:Wall[],fallback:number,cutaway?:number):Box[]{
  return walls.map(wall=>{
    const horizontal=Math.abs(wall.end.x-wall.start.x)>EPS,length=Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y),half=wall.thickness/2;
    const fullHeight=wall.height??fallback;
    return {wall,minX:Math.min(wall.start.x,wall.end.x)-half,maxX:Math.max(wall.start.x,wall.end.x)+half,minZ:Math.min(wall.start.y,wall.end.y)-half,maxZ:Math.max(wall.start.y,wall.end.y)+half,height:Math.min(fullHeight,cutaway===undefined?Infinity:cutaway*100),fullHeight,axis:horizontal?'x':'z',sign:Math.sign(horizontal?wall.end.x-wall.start.x:wall.end.y-wall.start.y),length};
  });
}
const sameBox = (a:Box,b:Box) => Math.abs(a.minX-b.minX)<EPS&&Math.abs(a.maxX-b.maxX)<EPS&&Math.abs(a.minZ-b.minZ)<EPS&&Math.abs(a.maxZ-b.maxZ)<EPS;
/** Physical geometry governs shared boundary ownership. IDs only distinguish
 * identical prisms, so drawing the same room with new UUIDs cannot change a
 * particular wall's exposed area, material preview or quotation. */
function compareBoxes(a:Box,b:Box):number{
  const axisOrder=(a.axis==='x'?0:1)-(b.axis==='x'?0:1);
  if(axisOrder)return axisOrder;
  for(const difference of [a.minX-b.minX,a.minZ-b.minZ,a.maxX-b.maxX,a.maxZ-b.maxZ,b.fullHeight-a.fullHeight,b.wall.thickness-a.wall.thickness])if(difference)return difference;
  return a.wall.id.localeCompare(b.wall.id);
}
const coordinateAlong = (box:Box,value:number) => (value-(box.axis==='x'?box.wall.start.x:box.wall.start.y))*box.sign;
const pointAlong = (box:Box,u:number,y:number,v:number):SolidVector => box.axis==='x'?{x:(box.wall.start.x+box.sign*u)/100,y:y/100,z:(box.wall.start.y+v)/100}:{x:(box.wall.start.x+v)/100,y:y/100,z:(box.wall.start.y+box.sign*u)/100};

/** Reject stale or ambiguous apertures before replacing any saved geometry. */
export function validateOpenings(project:WallSolidProject):WallOpening[]{
  const walls=normalizeWalls(project.walls||[]),fallback=project.wallHeight??280;
  if(project.wallJoinStyle==='clean'||walls.some(wall=>Math.abs(wall.end.x-wall.start.x)>EPS&&Math.abs(wall.end.y-wall.start.y)>EPS))return validateOrientedOpenings(project,walls,fallback,project.wallJoinStyle??'square');
  if(!Number.isFinite(fallback)||fallback<50||fallback>1000)throw new RangeError('默认墙高应为 0.5–10 m。');
  if(project.openings===undefined)return [];
  if(!Array.isArray(project.openings)||project.openings.length>200)throw new RangeError('开孔数据应为数组，最多支持 200 个门窗或孔洞。');
  const boxes=boxesFor(walls,fallback),ids=new Set<string>(),result:WallOpening[]=[];
  for(const value of project.openings){
    if(!value||typeof value.id!=='string'||!value.id.trim()||ids.has(value.id))throw new RangeError('门窗或孔洞编号不能为空或重复。');
    ids.add(value.id);const box=boxes.find(b=>b.wall.id===value.wallId);if(!box)throw new RangeError('门窗或孔洞对应的墙体不存在。');
    if(value.locked!==undefined&&typeof value.locked!=='boolean')throw new RangeError('门窗或孔洞锁定状态必须是布尔值。');
    if(value.name!==undefined&&(typeof value.name!=='string'||value.name.length>120))throw new RangeError('门窗或孔洞名称最多支持 120 字。');
    validateOpeningQuote(value);
    if(!['door','window','hole'].includes(value.kind))throw new RangeError('开孔类型应为门、窗或孔洞。');
    if(![value.offset,value.bottom,value.width,value.height,value.depth].every(Number.isFinite)||value.width<1||value.height<1||value.depth<.1||value.depth>100||value.offset<0||value.bottom<0)throw new RangeError('门窗和开孔尺寸必须有效：宽高至少 1 cm，厚度支持 0.1–100 cm。');
    if(value.offset+value.width>box.length+EPS||value.bottom+value.height>box.height+EPS)throw new RangeError('门窗或开孔超出墙长或墙高，请先调整开孔尺寸。');
    if(value.shape==='polygon'&&(!Array.isArray(value.points)||value.points.length>64||!value.points.every(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>=-EPS&&p.y>=-EPS&&p.x<=value.width+EPS&&p.y<=value.height+EPS)))throw new RangeError('自定义开孔需使用宽高范围内的 3–64 个有效顶点。');
    const ring=openingPolygon(value),valid=validatePolygon(ring);if(!valid.valid)throw new RangeError('开孔轮廓无效：'+valid.error);
    for(const old of result.filter(o=>o.wallId===value.wallId)){const previous=openingPolygon(old);if(intersectionArea({points:ring,holes:[]},{points:previous,holes:[]})>EPS||ringsTouch(ring,previous))throw new RangeError('同一墙面的门窗或开孔不能重叠或相接。');}
    // Cross-wall apertures at a T/cross junction have no unambiguous host face.
    // Reject them rather than showing an opening that is still filled by a neighbour.
    for(const other of boxes){
      if(other.wall.id===box.wall.id||sameBox(box,other))continue;
      const transverse=box.axis==='x'?Math.min(box.maxZ,other.maxZ)-Math.max(box.minZ,other.minZ):Math.min(box.maxX,other.maxX)-Math.max(box.minX,other.minX);
      if(transverse<=EPS)continue;
      const a=coordinateAlong(box,box.axis==='x'?other.minX:other.minZ),b=coordinateAlong(box,box.axis==='x'?other.maxX:other.maxZ);
      if(intersectionArea({points:ring,holes:[]},{points:rect(Math.min(a,b),0,Math.max(a,b),other.height),holes:[]})>EPS)throw new RangeError('开孔落在墙体交接或重叠位置，请移到墙面中间。');
    }
    result.push(structuredClone(value));
  }
  // Duplicate source walls describe one physical aperture; conflicting ones would
  // make the physical opening and its quantity depend on input order.
  for(let i=0;i<result.length;i++)for(let j=0;j<i;j++){
    const a=boxes.find(b=>b.wall.id===result[i].wallId),b=boxes.find(b=>b.wall.id===result[j].wallId);
    if(a.wall.id!==b.wall.id&&sameBox(a,b))throw new RangeError('重合墙体的开孔请集中设置在同一条墙线上。');
  }
  return result;
}

function facePoint(face:Face,p:Point):SolidVector{
  if(face.axis==='x')return {x:face.coordinate/100,y:p.y/100,z:p.x/100};
  if(face.axis==='z')return {x:p.x/100,y:p.y/100,z:face.coordinate/100};
  return {x:p.x/100,y:face.coordinate/100,z:p.y/100};
}
function faceNormal(face:Face):SolidVector{return {x:face.axis==='x'?face.direction:0,y:face.axis==='y'?face.direction:0,z:face.axis==='z'?face.direction:0};}
function boxFaces(box:Box):Face[]{
  const {minX,maxX,minZ,maxZ,height,axis,sign}=box;
  const leftNormal=axis==='x'?{axis:'z',direction:sign}:{axis:'x',direction:-sign};
  const side=(faceAxis:string,direction:number):SolidSurface['side']=>faceAxis===leftNormal.axis?(direction===leftNormal.direction?'left':'right'):'end';
  return [
    {axis:'x',coordinate:minX,direction:-1,points:rect(minZ,0,maxZ,height),side:side('x',-1)},
    {axis:'x',coordinate:maxX,direction:1,points:rect(minZ,0,maxZ,height),side:side('x',1)},
    {axis:'z',coordinate:minZ,direction:-1,points:rect(minX,0,maxX,height),side:side('z',-1)},
    {axis:'z',coordinate:maxZ,direction:1,points:rect(minX,0,maxX,height),side:side('z',1)},
    {axis:'y',coordinate:height,direction:1,points:rect(minX,minZ,maxX,maxZ),side:'top'},
    {axis:'y',coordinate:0,direction:-1,points:rect(minX,minZ,maxX,maxZ),side:'bottom'},
  ];
}
function coveringProjection(face:Face,other:Box,priority:boolean):Point[]|null{
  const [min,max]=face.axis==='x'?[other.minX,other.maxX]:face.axis==='z'?[other.minZ,other.maxZ]:[0,other.height];
  const sample=face.coordinate+face.direction*EPS*4;
  const covered=sample>min&&sample<max;
  const sameOuter=Math.abs(face.coordinate-(face.direction>0?max:min))<=EPS;
  if(sameOuter&&face.axis!=='y'){
    // At a room corner a neighbour's end cap lies in the continuous long side.
    // Let the actual long face own that coplanar strip, regardless of axis/UUID
    // priority. A perpendicular isolated end remains an end and is not priced.
    const otherIsLong=face.axis===(other.axis==='x'?'z':'x'),ownIsLong=face.side==='left'||face.side==='right';
    if(otherIsLong!==ownIsLong)priority=otherIsLong;
  }
  if(!covered&&!(sameOuter&&priority))return null;
  return face.axis==='x'?rect(other.minZ,0,other.maxZ,other.height):face.axis==='z'?rect(other.minX,0,other.maxX,other.height):rect(other.minX,other.minZ,other.maxX,other.maxZ);
}
function apertureOnFace(face:Face,box:Box,host:Box,opening:WallOpening):Point[][]{
  const ring=openingPolygon(opening);
  if((face.axis==='x'&&host.axis==='z')||(face.axis==='z'&&host.axis==='x')){
    return [ccw(ring.map(p=>({x:(host.axis==='x'?host.wall.start.x:host.wall.start.y)+host.sign*p.x,y:p.y})))];
  }
  if(face.axis==='y'){
    // Opening cross-section at floor/roof or at the cutaway cap. This correctly
    // removes a door's floor face and an ellipse's actual chord at cut height.
    const intervals=ringIntervals(ring,face.coordinate);
    const v=box.wall.thickness/2;
    return intervals.map(([a,b])=>{const pa=pointAlong(host,a,0,-v),pb=pointAlong(host,b,0,v);return rect(Math.min(pa.x,pb.x)*100,Math.min(pa.z,pb.z)*100,Math.max(pa.x,pb.x)*100,Math.max(pa.z,pb.z)*100);});
  }
  return [];
}
function ringIntervals(ring:Point[],y:number):number[][]{
  const xs:number[]=[];
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];
    if(Math.abs(a.y-y)<EPS)xs.push(a.x);
    if((a.y<y&&b.y>y)||(b.y<y&&a.y>y))xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));
  }
  const values=[...new Set(xs.map(x=>Math.round(x/EPS)*EPS))].sort((a,b)=>a-b),intervals:number[][]=[];
  for(let i=0;i<values.length-1;i++){
    const a=values[i],b=values[i+1];if(b-a>EPS&&pointInRegion({x:(a+b)/2,y},{points:ring,holes:[]}))intervals.push([a,b]);
  }
  return intervals;
}
const length3=(a:SolidVector,b:SolidVector)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function surfaceArea(points:SolidVector[]):number{
  const a=points[0];let total=0;
  for(let i=1;i<points.length-1;i++){
    const b={x:points[i].x-a.x,y:points[i].y-a.y,z:points[i].z-a.z},c={x:points[i+1].x-a.x,y:points[i+1].y-a.y,z:points[i+1].z-a.z};
    total+=Math.hypot(b.y*c.z-b.z*c.y,b.z*c.x-b.x*c.z,b.x*c.y-b.y*c.x)/2;
  }
  return total;
}
type OrientedPrism = { wall:Wall; u:Point; n:Point; length:number; half:number; height:number; fullHeight:number; footprint:Point[]; joinStyle?:WallJoinStyle };
type Plane3 = { normal:SolidVector; distance:number };
type OrientedFace = { side:SolidSurface['side']; points:SolidVector[]; normal:SolidVector };
const dot3=(a:SolidVector,b:SolidVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
function orientedPoint(prism:OrientedPrism,u:number,y:number,v:number):SolidVector{
  return {x:prism.wall.start.x+prism.u.x*u+prism.n.x*v,y,z:prism.wall.start.y+prism.u.y*u+prism.n.y*v};
}
function orientedPrisms(walls:Wall[],fallback:number,cutaway?:number,style:WallJoinStyle='square'):OrientedPrism[]{
  const actual=style==='clean'?new Map(wallFootprints(walls,style).map(footprint=>[footprint.wallId,footprint.points])):null;
  return walls.flatMap(wall=>{
    const dx=wall.end.x-wall.start.x,dz=wall.end.y-wall.start.y,length=Math.hypot(dx,dz),u={x:dx/length,y:dz/length},n={x:-u.y,y:u.x},half=wall.thickness/2,fullHeight=wall.height??fallback;
    const prism:OrientedPrism={wall,u,n,length,half,height:Math.min(fullHeight,cutaway===undefined?Infinity:cutaway*100),fullHeight,footprint:[],joinStyle:style};
    prism.footprint=actual?actual.get(wall.id)??[]:[[-half,-half],[length+half,-half],[length+half,half],[-half,half]].map(([along,across])=>{const p=orientedPoint(prism,along,0,across);return {x:p.x,y:p.z};});
    return prism.footprint.length?[prism]:[];
  });
}
function sameFootprint(a:OrientedPrism,b:OrientedPrism):boolean{
  if(!a||!b)return false;
  if(a.joinStyle==='clean'||b.joinStyle==='clean')return a.footprint.length===b.footprint.length&&a.footprint.every(p=>b.footprint.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<=EPS));
  if(Math.abs(a.half-b.half)>EPS||Math.abs(a.length-b.length)>EPS)return false;
  const same=(p:Point,q:Point)=>Math.hypot(p.x-q.x,p.y-q.y)<=EPS;
  return same(a.wall.start,b.wall.start)&&same(a.wall.end,b.wall.end)||same(a.wall.start,b.wall.end)&&same(a.wall.end,b.wall.start);
}
function comparePrisms(a:OrientedPrism,b:OrientedPrism):number{
  const canonical=(prism:OrientedPrism)=>[...prism.footprint].sort((p,q)=>p.x-q.x||p.y-q.y).flatMap(point=>[point.x,point.y]);
  const first=canonical(a),second=canonical(b);
  for(let i=0;i<first.length;i++)if(Math.abs(first[i]-second[i])>EPS)return first[i]-second[i];
  return b.fullHeight-a.fullHeight||b.half-a.half||a.wall.id.localeCompare(b.wall.id);
}
function prismPlanes(prism:OrientedPrism):Plane3[]{
  if(prism.joinStyle==='clean')return [...prism.footprint.map((a,i)=>{
    const b=prism.footprint[(i+1)%prism.footprint.length],dx=b.x-a.x,dz=b.y-a.y,length=Math.hypot(dx,dz),normal={x:dz/length,y:0,z:-dx/length};
    return {normal,distance:normal.x*a.x+normal.z*a.y};
  }),{normal:{x:0,y:1,z:0},distance:prism.height},{normal:{x:0,y:-1,z:0},distance:0}];
  const {u,n,wall,half,length,height}=prism,along=u.x*wall.start.x+u.y*wall.start.y,across=n.x*wall.start.x+n.y*wall.start.y;
  return [{normal:{x:u.x,y:0,z:u.y},distance:along+length+half},{normal:{x:-u.x,y:0,z:-u.y},distance:-along+half},
    {normal:{x:n.x,y:0,z:n.y},distance:across+half},{normal:{x:-n.x,y:0,z:-n.y},distance:-across+half},
    {normal:{x:0,y:1,z:0},distance:height},{normal:{x:0,y:-1,z:0},distance:0}];
}
function orientedFaces(prism:OrientedPrism):OrientedFace[]{
  if(prism.joinStyle==='clean'){
    const ring=prism.footprint,at=(p:Point,y:number):SolidVector=>({x:p.x,y,z:p.y});
    const faces:OrientedFace[]=ring.map((a,i)=>{
      const b=ring[(i+1)%ring.length],dx=b.x-a.x,dz=b.y-a.y,length=Math.hypot(dx,dz),normal={x:dz/length,y:0,z:-dx/length},sideDot=normal.x*prism.n.x+normal.z*prism.n.y;
      const side:SolidSurface['side']=sideDot>.9999999999?'left':sideDot<-.9999999999?'right':'end';
      return {side,normal,points:[at(a,0),at(a,prism.height),at(b,prism.height),at(b,0)]};
    });
    faces.push({side:'top',normal:{x:0,y:1,z:0},points:[...ring].reverse().map(p=>at(p,prism.height))},{side:'bottom',normal:{x:0,y:-1,z:0},points:ring.map(p=>at(p,0))});
    return faces;
  }
  const {half:h,length:l,height:y,u,n}=prism,p=(a:number,b:number,c:number)=>orientedPoint(prism,a,b,c);
  return [
    {side:'left',normal:{x:n.x,y:0,z:n.y},points:[p(-h,0,h),p(l+h,0,h),p(l+h,y,h),p(-h,y,h)]},
    {side:'right',normal:{x:-n.x,y:0,z:-n.y},points:[p(l+h,0,-h),p(-h,0,-h),p(-h,y,-h),p(l+h,y,-h)]},
    {side:'end',normal:{x:-u.x,y:0,z:-u.y},points:[p(-h,0,-h),p(-h,0,h),p(-h,y,h),p(-h,y,-h)]},
    {side:'end',normal:{x:u.x,y:0,z:u.y},points:[p(l+h,0,h),p(l+h,0,-h),p(l+h,y,-h),p(l+h,y,h)]},
    {side:'top',normal:{x:0,y:1,z:0},points:[p(-h,y,-h),p(-h,y,h),p(l+h,y,h),p(l+h,y,-h)]},
    {side:'bottom',normal:{x:0,y:-1,z:0},points:[p(-h,0,-h),p(l+h,0,-h),p(l+h,0,h),p(-h,0,h)]},
  ];
}
function clipPlane3(points:SolidVector[],plane:Plane3,inside:boolean):SolidVector[]{
  const result:SolidVector[]=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],da=dot3(a,plane.normal)-plane.distance,db=dot3(b,plane.normal)-plane.distance;
    const ia=inside?da<=EPS:da>=-EPS,ib=inside?db<=EPS:db>=-EPS;
    if(ia)result.push(a);
    if(ia!==ib){const t=da/(da-db);result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
  }
  const cleaned=result.filter((point,i)=>length3(point,result[(i+result.length-1)%result.length])>EPS);
  return cleaned.length>=3&&surfaceArea(cleaned)>EPS*EPS?cleaned:[];
}
/** Subtract the actual convex volume sliced by this face plane, never its AABB. */
function subtractVolume(points:SolidVector[],planes:Plane3[],faceNormal:SolidVector,priority:boolean):SolidVector[][]{
  for(const plane of planes){
    const distances=points.map(point=>dot3(point,plane.normal)-plane.distance);
    if(Math.min(...distances)>EPS)return [points];
    // A coincident outside plane is owned once. Adjacent opposite faces are buried.
    if(distances.every(distance=>Math.abs(distance)<=EPS)&&dot3(faceNormal,plane.normal)>.999999&&!priority)return [points];
  }
  let remainder=points;const result:SolidVector[][]=[];
  for(const plane of planes){
    if(!remainder.length)break;
    const distances=remainder.map(point=>dot3(point,plane.normal)-plane.distance);
    if(distances.every(distance=>Math.abs(distance)<=EPS))continue;
    const outside=clipPlane3(remainder,plane,false);if(outside.length)result.push(outside);
    remainder=clipPlane3(remainder,plane,true);
  }
  return result;
}
function intersectFootprints(a:Point[],b:Point[]):Point[]{
  let polygon=a;const cut=ccw(b);
  for(let i=0;i<cut.length&&polygon.length;i++)polygon=halfPlane(polygon,cut[i],cut[(i+1)%cut.length],true);
  return polygon;
}
/** An explicit clean T can meet a host side with zero volume overlap. Its
 * flush end cap still fills that portion of an aperture, so retain the actual
 * contact span. Curved neighbours and collinear extensions are not T joins. */
function junctionCoordinates(host:OrientedPrism,other:OrientedPrism):number[]{
  const local=(point:Point)=>({along:(point.x-host.wall.start.x)*host.u.x+(point.y-host.wall.start.y)*host.u.y,across:(point.x-host.wall.start.x)*host.n.x+(point.y-host.wall.start.y)*host.n.y});
  const overlap=intersectFootprints(host.footprint,other.footprint);
  if(overlap.length&&polygonArea(overlap)>EPS)return overlap.map(point=>local(point).along);
  if(host.joinStyle!=='clean'||Math.abs(host.u.x*other.u.y-host.u.y*other.u.x)<=EPS)return [];
  const explicitT=[other.wall.start,other.wall.end].some(point=>{const p=local(point);return Math.abs(p.across)<=EPS&&p.along>EPS&&p.along<host.length-EPS;});
  if(!explicitT)return [];
  const contact=other.footprint.map(local).filter(point=>Math.abs(Math.abs(point.across)-host.half)<=EPS&&point.along>=-EPS&&point.along<=host.length+EPS);
  return contact.length>=2?contact.map(point=>point.along):[];
}
/** Shared local elevation obstacles for continuous pointer movement. */
export function openingJunctionPolygons(project:WallSolidProject,wallId:string):Point[][]{
  const walls=normalizeWalls(project.walls??[]),prisms=orientedPrisms(walls,project.wallHeight??280,undefined,project.wallJoinStyle??'square'),host=prisms.find(prism=>prism.wall.id===wallId);
  if(!host)throw new RangeError('开孔对应的墙体不存在。');
  return prisms.flatMap(other=>{
    if(other===host||sameFootprint(host,other))return [];
    const coordinates=junctionCoordinates(host,other);
    return coordinates.length?[rect(Math.min(...coordinates),0,Math.max(...coordinates),other.height)]:[];
  });
}
function validateOrientedOpenings(project:WallSolidProject,walls:Wall[],fallback:number,style:WallJoinStyle='square'):WallOpening[]{
  if(!Number.isFinite(fallback)||fallback<50||fallback>1000)throw new RangeError('默认墙高应为 0.5–10 m。');
  if(project.openings===undefined)return [];
  if(!Array.isArray(project.openings)||project.openings.length>200)throw new RangeError('开孔数据应为数组，最多支持 200 个门窗或孔洞。');
  const prisms=orientedPrisms(walls,fallback,undefined,style),ids=new Set<string>(),result:WallOpening[]=[];
  for(const value of project.openings){
    if(!value||typeof value.id!=='string'||!value.id.trim()||ids.has(value.id))throw new RangeError('门窗或孔洞编号不能为空或重复。');
    ids.add(value.id);const host=prisms.find(prism=>prism.wall.id===value.wallId);if(!host)throw new RangeError('门窗或孔洞对应的墙体不存在。');
    if(value.locked!==undefined&&typeof value.locked!=='boolean')throw new RangeError('门窗或孔洞锁定状态必须是布尔值。');
    if(value.name!==undefined&&(typeof value.name!=='string'||value.name.length>120))throw new RangeError('门窗或孔洞名称最多支持 120 字。');
    validateOpeningQuote(value);
    if(!['door','window','hole'].includes(value.kind))throw new RangeError('开孔类型应为门、窗或孔洞。');
    if(![value.offset,value.bottom,value.width,value.height,value.depth].every(Number.isFinite)||value.width<1||value.height<1||value.depth<.1||value.depth>100||value.offset<0||value.bottom<0)throw new RangeError('门窗和开孔尺寸必须有效：宽高至少 1 cm，厚度支持 0.1–100 cm。');
    if(value.offset+value.width>host.length+EPS||value.bottom+value.height>host.height+EPS)throw new RangeError('门窗或开孔超出墙长或墙高，请先调整开孔尺寸。');
    if(value.shape==='polygon'&&(!Array.isArray(value.points)||value.points.length>64||!value.points.every(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>=-EPS&&p.y>=-EPS&&p.x<=value.width+EPS&&p.y<=value.height+EPS)))throw new RangeError('自定义开孔需使用宽高范围内的 3–64 个有效顶点。');
    const ring=openingPolygon(value),valid=validatePolygon(ring);if(!valid.valid)throw new RangeError('开孔轮廓无效：'+valid.error);
    if(style==='clean')for(const p of ring)for(const across of [-host.half,host.half]){
      const actual={x:host.wall.start.x+host.u.x*p.x+host.n.x*across,y:host.wall.start.y+host.u.y*p.x+host.n.y*across};
      if(host.footprint.some((a,i)=>{const b=host.footprint[(i+1)%host.footprint.length];return cross(a,b,actual)<-EPS*Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));}))throw new RangeError('开孔位于整理连接后裁掉的墙端，请向墙面中部移动或缩小开孔。');
    }
    for(const old of result.filter(opening=>opening.wallId===value.wallId)){const other=openingPolygon(old);if(intersectionArea({points:ring,holes:[]},{points:other,holes:[]})>EPS||ringsTouch(ring,other))throw new RangeError('同一墙面的门窗或开孔不能重叠或相接。');}
    for(const other of prisms){
      if(other===host||sameFootprint(host,other))continue;
      const coordinates=junctionCoordinates(host,other);if(!coordinates.length)continue;
      if(intersectionArea({points:ring,holes:[]},{points:rect(Math.min(...coordinates),0,Math.max(...coordinates),other.height),holes:[]})>EPS)throw new RangeError('开孔落在墙体交接或重叠位置，请移到墙面中间。');
    }
    result.push(structuredClone(value));
  }
  for(let i=0;i<result.length;i++)for(let j=0;j<i;j++)if(result[i].wallId!==result[j].wallId&&sameFootprint(prisms.find(p=>p.wall.id===result[i].wallId),prisms.find(p=>p.wall.id===result[j].wallId)))throw new RangeError('重合墙体的开孔请集中设置在同一条墙线上。');
  return result;
}
function aperturePlanes(prism:OrientedPrism,ring:Point[]):Plane3[]{
  const across=prism.n.x*prism.wall.start.x+prism.n.y*prism.wall.start.y,along=prism.u.x*prism.wall.start.x+prism.u.y*prism.wall.start.y;
  const planes:Plane3[]=[{normal:{x:prism.n.x,y:0,z:prism.n.y},distance:across+prism.half},{normal:{x:-prism.n.x,y:0,z:-prism.n.y},distance:-across+prism.half}];
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    planes.push({normal:{x:dy/length*prism.u.x,y:-dx/length,z:dy/length*prism.u.y},distance:(dy*(a.x+along)-dx*a.y)/length});
  }
  return planes;
}
function orientedOpeningSurfaces(prism:OrientedPrism,opening:WallOpening,depth:number,kind:'insert'|'reveal',heightLimit:number):SolidSurface[]{
  const local:Box={wall:{...prism.wall,start:{x:0,y:0},end:{x:prism.length,y:0}},axis:'x',sign:1,length:prism.length,minX:-prism.half,maxX:prism.length+prism.half,minZ:-prism.half,maxZ:prism.half,height:prism.height,fullHeight:prism.fullHeight};
  const surfaces=prismSurfaces(local,opening,depth,kind,heightLimit).map(surface=>({...surface,
    points:surface.points.map(point=>({x:prism.wall.start.x/100+prism.u.x*point.x+prism.n.x*point.z,y:point.y,z:prism.wall.start.y/100+prism.u.y*point.x+prism.n.y*point.z})),
    normal:{x:prism.u.x*surface.normal.x+prism.n.x*surface.normal.z,y:surface.normal.y,z:prism.u.y*surface.normal.x+prism.n.y*surface.normal.z}}));
  if(prism.joinStyle!=='clean'||kind!=='reveal')return surfaces;
  const planes=prismPlanes(prism).map(plane=>({...plane,distance:plane.distance/100}));
  return surfaces.flatMap(surface=>{
    // An aperture touching a real butt end has no masonry jamb on that edge.
    if(planes.some(plane=>dot3(plane.normal,surface.normal)<-.9999999999&&surface.points.every(p=>Math.abs(dot3(p,plane.normal)-plane.distance)<=EPS/100)))return [];
    let points=surface.points;
    for(const plane of planes){points=clipPlane3(points,plane,true);if(!points.length)return [];}
    return [{...surface,points}];
  });
}
function measuredSurfaces(walls:Wall[],surfaces:SolidSurface[],grossByWall:Map<string,{left:number;right:number;end:number}>):WallSurfaceMetrics[]{
  return walls.map(wall=>{
    const own=surfaces.filter(surface=>surface.wallId===wall.id),sum=(side:SolidSurface['side'])=>own.filter(surface=>surface.side===side).reduce((total,surface)=>total+surfaceArea(surface.points),0);
    const gross=grossByWall.get(wall.id)??{left:0,right:0,end:0},side=wall.finishSide??'both',leftArea=sum('left'),rightArea=sum('right'),endArea=sum('end'),revealArea=sum('reveal');
    const grossArea=side==='both'?gross.left+gross.right:gross[side],remaining=side==='both'?leftArea+rightArea:side==='left'?leftArea:rightArea;
    const faces=continuousWallFaces(own,wall.id,side),measure=(value:number)=>Number(value.toFixed(10));
    return {id:wall.id,side,grossArea:measure(grossArea),openingArea:measure(Math.max(0,grossArea-remaining)),netArea:measure(remaining),leftArea:measure(leftArea),rightArea:measure(rightArea),endArea:measure(endArea),revealArea:measure(revealArea),perimeter:measure(faces.reduce((sum,face)=>sum+face.perimeter,0))};
  });
}
function buildOrientedSolid(walls:Wall[],fallback:number,openings:WallOpening[],cutaway?:number,style:WallJoinStyle='square'):WallSolid{
  const prisms=orientedPrisms(walls,fallback,cutaway,style),ordered=style==='clean'?[...prisms]:[...prisms].sort(comparePrisms),surfaces:SolidSurface[]=[],inserts:SolidInsert[]=[],grossByWall=new Map<string,{left:number;right:number;end:number}>();
  const planes=new Map(ordered.map(prism=>[prism,prismPlanes(prism)]));
  const facesByPrism=new Map(ordered.map(prism=>[prism,orientedFaces(prism)]));
  for(let index=0;index<ordered.length;index++){
    const prism=ordered[index],group=ordered.filter(other=>sameFootprint(prism,other)),sourceIds=group.map(other=>other.wall.id),gross={left:0,right:0,end:0};grossByWall.set(prism.wall.id,gross);
    for(const [faceIndex,face] of facesByPrism.get(prism).entries()){
      let pieces=[face.points];
      for(let j=0;j<ordered.length&&pieces.length;j++)if(j!==index){
        let priority=j<index;
        const coplanar=facesByPrism.get(ordered[j]).find(other=>dot3(face.normal,other.normal)>.9999999999&&face.points.every(point=>Math.abs(dot3(point,other.normal)-dot3(other.points[0],other.normal))<=EPS));
        if(coplanar){
          const ownIsLong=face.side==='left'||face.side==='right',otherIsLong=coplanar.side==='left'||coplanar.side==='right';
          if(ownIsLong!==otherIsLong)priority=otherIsLong;
        }
        pieces=pieces.flatMap(piece=>subtractVolume(piece,planes.get(ordered[j]),face.normal,priority));
      }
      if(face.side==='left'||face.side==='right'||face.side==='end')gross[face.side]+=pieces.reduce((sum,piece)=>sum+surfaceArea(piece)/10000,0);
      for(const opening of openings){
        const host=prisms.find(value=>value.wall.id===opening.wallId);if(!sameFootprint(host,prism))continue;
        const ring=openingPolygon(opening),convex=ring.every((p,i)=>cross(p,ring[(i+1)%ring.length],ring[(i+2)%ring.length])>=-EPS);
        for(const clip of convex?[ring]:convexPieces(ring)){const aperture=aperturePlanes(host,clip);pieces=pieces.flatMap(piece=>subtractVolume(piece,aperture,face.normal,true));}
      }
      const selected=prism.wall.finishSide??'both',painted=selected==='both'?face.side==='left'||face.side==='right':selected===face.side,item=painted?prism.wall.items?.[0]:undefined;
      for(let i=0;i<pieces.length;i++)surfaces.push({id:`${prism.wall.id}-oriented-${faceIndex}-${face.side}-${i}`,wallId:prism.wall.id,sourceIds,side:face.side,points:pieces[i].map(point=>({x:point.x/100,y:point.y/100,z:point.z/100})),normal:face.normal,...(/^#[\da-f]{6}$/i.test(item?.color||'')?{color:item.color}:{}),...(item?.image?{materialImage:item.image}:{})});
    }
  }
  for(const opening of openings){
    const host=prisms.find(prism=>prism.wall.id===opening.wallId),group=ordered.filter(prism=>sameFootprint(host,prism)),heightLimit=cutaway===undefined?Infinity:cutaway*100,union={...host,height:Math.max(...group.map(prism=>prism.height))};
    const reveals=orientedOpeningSurfaces(union,opening,host.wall.thickness,'reveal',heightLimit),levels=[0,...new Set(group.map(prism=>prism.height/100))].sort((a,b)=>a-b);
    for(const reveal of reveals)for(let band=0;band<levels.length-1;band++){
      let points=clipSurfaceHeight(reveal.points,levels[band],true);if(points.length)points=clipSurfaceHeight(points,levels[band+1],false);if(!points.length)continue;
      const middle=points.reduce((sum,point)=>sum+point.y,0)/points.length;
      if(points.every(point=>Math.abs(point.y-middle)<EPS/100)&&band<levels.length-2&&Math.abs(middle-levels[band+1])<EPS/100)continue;
      const owner=group.find(prism=>prism.height/100>middle+EPS/100)||group.find(prism=>prism.height/100>=middle-EPS/100);if(!owner)continue;
      surfaces.push({...reveal,id:reveal.id+'-band'+band,points,wallId:owner.wall.id,sourceIds:group.map(prism=>prism.wall.id)});
    }
    if(opening.kind!=='hole')inserts.push({id:opening.id,wallId:opening.wallId,kind:opening.kind,depth:opening.depth/100,surfaces:orientedOpeningSurfaces(host,opening,opening.depth,'insert',heightLimit)});
  }
  return {surfaces,inserts,metrics:measuredSurfaces(walls,surfaces,grossByWall),openings};
}

function prismSurfaces(box:Box,opening:WallOpening,depth:number,kind:'insert'|'reveal',heightLimit:number):SolidSurface[]{
  const ring=openingPolygon(opening),limit=Math.min(box.height,heightLimit);
  const thickness=depth/2,points=(piece:Point[],side:number)=>piece.map(p=>pointAlong(box,p.x,p.y,side*thickness));
  const axis=box.axis==='x'?'z':'x',normal=(direction:number):SolidVector=>({x:axis==='x'?direction:0,y:0,z:axis==='z'?direction:0});
  const surfaces:SolidSurface[]=[],color=opening.kind==='door'?'#b8a28b':'#a7c1c4';
  const add=(points:SolidVector[],normal:SolidVector,index:string)=>surfaces.push({id:`${kind}-${opening.id}-${index}`,wallId:box.wall.id,sourceIds:[box.wall.id],openingId:opening.id,side:'reveal',points,normal,...(kind==='insert'?{color}:{} )});
  if(kind==='insert'){
    const isConvex=ring.every((p,i)=>cross(p,ring[(i+1)%ring.length],ring[(i+2)%ring.length])>=-EPS);
    const pieces=(isConvex?[ring]:convexPieces(ring)).map(piece=>halfPlane(piece,{x:0,y:limit},{x:1,y:limit},false)).filter(piece=>piece.length);
    for(let i=0;i<pieces.length;i++){add(points(pieces[i],-1),normal(-1),'front'+i);add(points(pieces[i],1),normal(1),'back'+i);}
    if(heightLimit<Infinity&&ring.some(p=>p.y>limit+EPS))for(const [a,b] of ringIntervals(ring,limit))add([pointAlong(box,a,limit,-thickness),pointAlong(box,b,limit,-thickness),pointAlong(box,b,limit,thickness),pointAlong(box,a,limit,thickness)],{x:0,y:1,z:0},'cap'+a);
  }
  for(let i=0;i<ring.length;i++){
    let a=ring[i],b=ring[(i+1)%ring.length];
    if(a.y>limit&&b.y>limit)continue;
    if(a.y>limit){const t=(limit-b.y)/(a.y-b.y);a={x:b.x+(a.x-b.x)*t,y:limit};}
    if(b.y>limit){const t=(limit-a.y)/(b.y-a.y);b={x:a.x+(b.x-a.x)*t,y:limit};}
    const edge=Math.hypot(b.x-a.x,b.y-a.y);
    if(edge<EPS)continue;
    // A through-door has no exposed reveal at the supporting ground plane.
    if(kind==='reveal'&&Math.abs(a.y)<EPS&&Math.abs(b.y)<EPS)continue;
    if(kind==='reveal'&&Math.abs(a.y-box.height)<EPS&&Math.abs(b.y-box.height)<EPS)continue;
    // The artificial low-wall cut plane remains the union cap, not a duplicate reveal.
    if(kind==='reveal'&&heightLimit<Infinity&&Math.abs(a.y-heightLimit)<EPS&&Math.abs(b.y-heightLimit)<EPS)continue;
    const sign=kind==='reveal'?-1:1,du=(b.y-a.y)/edge*sign,dy=-(b.x-a.x)/edge*sign;
    const n=box.axis==='x'?{x:du*box.sign,y:dy,z:0}:{x:0,y:dy,z:du*box.sign};
    add([pointAlong(box,a.x,a.y,-thickness),pointAlong(box,b.x,b.y,-thickness),pointAlong(box,b.x,b.y,thickness),pointAlong(box,a.x,a.y,thickness)],n,'edge'+i);
  }
  return surfaces;
}
function clipSurfaceHeight(points:SolidVector[],height:number,above:boolean):SolidVector[]{
  const result:SolidVector[]=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],aIn=above?a.y>=height-EPS/100:a.y<=height+EPS/100,bIn=above?b.y>=height-EPS/100:b.y<=height+EPS/100;
    if(aIn)result.push({...a});
    if(aIn!==bIn){const t=(height-a.y)/(b.y-a.y);result.push({x:a.x+(b.x-a.x)*t,y:height,z:a.z+(b.z-a.z)*t});}
  }
  return result.length>=3&&surfaceArea(result)>1e-12?result:[];
}

/** Actual boundary of the union of wall boxes, minus real through-apertures.
 * All clipping happens in centimetres; output vertices are in metres. */
export function buildWallSolid(project:WallSolidProject,cutawayHeight?:number):WallSolid{
  const walls=normalizeWalls(project.walls||[]),fallback=project.wallHeight??280,openings=validateOpenings(project);
  const style=project.wallJoinStyle??'square';if(!['square','clean'].includes(style))throw new RangeError('墙体连接方式无效。');
  if(cutawayHeight!==undefined&&(!Number.isFinite(cutawayHeight)||cutawayHeight<=0))throw new RangeError('剖切墙高必须大于零。');
  if(style==='clean'||walls.some(wall=>Math.abs(wall.end.x-wall.start.x)>EPS&&Math.abs(wall.end.y-wall.start.y)>EPS))return buildOrientedSolid(walls,fallback,openings,cutawayHeight,style);
  const boxes=boxesFor(walls,fallback,cutawayHeight),ordered=[...boxes].sort(compareBoxes),priority=new Map(ordered.map((box,index)=>[box,index]));
  const surfaces:SolidSurface[]=[],inserts:SolidInsert[]=[],grossByWall=new Map<string,{left:number;right:number;end:number}>();
  for(const box of ordered){
    const sourceIds=ordered.filter(other=>sameBox(box,other)).map(other=>other.wall.id),gross={left:0,right:0,end:0};grossByWall.set(box.wall.id,gross);
    for(const face of boxFaces(box)){
      let pieces=[face.points];
      for(const other of ordered){if(other===box)continue;const projection=coveringProjection(face,other,priority.get(other)<priority.get(box));if(projection)pieces=subtractPolygons(pieces,projection);if(!pieces.length)break;}
      if(face.side==='left'||face.side==='right'||face.side==='end')gross[face.side]+=pieces.reduce((sum,piece)=>sum+polygonArea(piece)/10000,0);
      for(const opening of openings){const host=boxes.find(b=>b.wall.id===opening.wallId);if(!sameBox(host,box))continue;
        for(const cut of apertureOnFace(face,box,host,opening))pieces=subtractPolygons(pieces,cut);
      }
      const selected=box.wall.finishSide??'both',painted=selected==='both'?(face.side==='left'||face.side==='right'):selected===face.side;
      const item=painted?box.wall.items?.[0]:undefined;
      for(let i=0;i<pieces.length;i++)surfaces.push({id:`${box.wall.id}-${face.axis}-${face.direction}-${face.side}-${i}`,wallId:box.wall.id,sourceIds,side:face.side,points:pieces[i].map(p=>facePoint(face,p)),normal:faceNormal(face),...(/^#[\da-f]{6}$/i.test(item?.color||'')?{color:item.color}:{}),...(item?.image?{materialImage:item.image}:{} )});
    }
  }
  for(const opening of openings){
    const box=boxes.find(b=>b.wall.id===opening.wallId),group=ordered.filter(b=>sameBox(box,b)),heightLimit=cutawayHeight===undefined?Infinity:cutawayHeight*100;
    const unionBox={...box,height:Math.max(...group.map(b=>b.height))},reveals=prismSurfaces(unionBox,opening,box.wall.thickness,'reveal',heightLimit);
    // Keep physical reveal ownership deterministic, independently of finishes.
    const levels=[0,...new Set(group.map(b=>b.height/100))].sort((a,b)=>a-b);
    for(const reveal of reveals)for(let band=0;band<levels.length-1;band++){
      let points=clipSurfaceHeight(reveal.points,levels[band],true);if(points.length)points=clipSurfaceHeight(points,levels[band+1],false);if(!points.length)continue;
      const middle=points.reduce((sum,p)=>sum+p.y,0)/points.length;
      if(points.every(p=>Math.abs(p.y-middle)<EPS/100)&&band<levels.length-2&&Math.abs(middle-levels[band+1])<EPS/100)continue;
      // Shared horizontal head surfaces lie beneath remaining solid volume.
      const owner=group.find(b=>b.height/100>middle+EPS/100)||group.find(b=>b.height/100>=middle-EPS/100);
      if(!owner)continue;
      surfaces.push({...reveal,id:reveal.id+'-band'+band,points,wallId:owner.wall.id,sourceIds:group.map(b=>b.wall.id)});
    }
    if(opening.kind!=='hole')inserts.push({id:opening.id,wallId:opening.wallId,kind:opening.kind,depth:opening.depth/100,surfaces:prismSurfaces(box,opening,opening.depth,'insert',heightLimit)});
  }
  return {surfaces,inserts,metrics:measuredSurfaces(walls,surfaces,grossByWall),openings};
}
export function wallSurfaceMetrics(project:WallSolidProject,wallId?:string):WallSurfaceMetrics[]|WallSurfaceMetrics|undefined{
  const metrics=buildWallSolid(project).metrics;return wallId===undefined?metrics:metrics.find(w=>w.id===wallId);
}
