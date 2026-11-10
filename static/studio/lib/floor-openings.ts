import type { Point, Region, FloorOpening, SurfacePart } from '../types.js';
import { polygonArea, polygonPerimeter, pointInRegion, validatePolygon, validateRegion, regionInteriorPoint } from './geometry.js';

export type OpeningShapeKind = NonNullable<FloorOpening['shape']>;
type Shape = Pick<FloorOpening, 'points' | 'holes' | 'shape'>;
type Polygon = { points: Point[]; holes?: Point[][] };
type Segment = { a: Point; b: Point; cuts: number[] };
const cross = (a: Point, b: Point) => a.x*b.y-a.y*b.x;
const delta = (a: Point, b: Point): Point => ({x:a.x-b.x,y:a.y-b.y});
const signedArea = (ring: Point[]) => {const origin=ring[0];return ring.reduce((sum,p,i)=>sum+cross(delta(p,origin),delta(ring[(i+1)%ring.length],origin)),0)/2;};
const distance = (a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
const cloneRing=(ring:Point[])=>ring.map(point=>({...point}));
const pointValid=(point:Point)=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y);
// A price edit or camera movement does not change any aperture geometry. Bound
// the cache to recent shapes and never expose its mutable coordinate arrays.
const geometryCache=new Map<string,SurfacePart[]>();
const MAX_CACHED_GEOMETRIES=32;
function contains(ring:Point[],point:Point):boolean {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
const inside=(shape:Polygon,point:Point)=>contains(shape.points,point)&&!(shape.holes??[]).some(ring=>contains(ring,point));
const partArea=(part:Polygon)=>polygonArea(part.points)-(part.holes??[]).reduce((sum,ring)=>sum+polygonArea(ring),0);

/** Rectangle/ellipse use opposite bounding-box corners. Circle/annulus use a
 * centre and radius point. Display and cost use the same sampled coordinates. */
export function openingShape(kind:OpeningShapeKind,start:Point,end:Point,options:{innerRatio?:number}={}):Shape {
  if(!pointValid(start)||!pointValid(end))throw new RangeError('楼板洞坐标必须是有限数字。');
  const minX=Math.min(start.x,end.x),maxX=Math.max(start.x,end.x),minY=Math.min(start.y,end.y),maxY=Math.max(start.y,end.y);
  if(kind==='rectangle'){
    if(maxX-minX<1||maxY-minY<1)throw new RangeError('楼板洞宽、深至少为 1 cm。');
    return{shape:kind,points:[{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}],holes:[]};
  }
  if(!['circle','ellipse','annulus'].includes(kind))throw new RangeError('请逐点绘制多边形洞口。');
  const circular=kind!=='ellipse',cx=circular?start.x:(minX+maxX)/2,cy=circular?start.y:(minY+maxY)/2;
  const rx=circular?distance(start,end):(maxX-minX)/2,ry=circular?rx:(maxY-minY)/2;
  if(rx<.5||ry<.5)throw new RangeError('楼板洞直径至少为 1 cm。');
  const radius=Math.max(rx,ry),angle=2*Math.acos(Math.max(-1,Math.min(1,1-.5/radius)));
  const count=Math.max(32,Math.ceil(Math.PI*2/angle));
  if(count>200)throw new RangeError('洞口过大，请缩小尺寸，以保证曲线计算精度。');
  const ring=(ratio:number)=>Array.from({length:count},(_,i)=>({x:cx+rx*ratio*Math.cos(i*Math.PI*2/count),y:cy+ry*ratio*Math.sin(i*Math.PI*2/count)}));
  const innerRatio=options.innerRatio??.45;
  if(kind==='annulus'&&(!Number.isFinite(innerRatio)||innerRatio<=0||innerRatio>=1))throw new RangeError('圆环内径必须小于外径且大于零。');
  return{shape:kind,points:ring(1),holes:kind==='annulus'?[ring(innerRatio)]:[]};
}

/** Boundary magnets are exact coordinates, not a fictitious inset. A nearby
 * click outside the room is projected onto its edge. Further overflow is
 * permitted as a drawing gesture and clipped by the boolean operation. */
export function snapOpeningPoint(point:Point,region:Pick<Region,'points'|'holes'>,threshold:number):Point {
  if(!pointValid(point))throw new RangeError('楼板洞坐标必须是有限数字。');
  if(!Number.isFinite(threshold)||threshold<0)return{...point};
  const rings=[region.points,...(region.holes??[])];
  const vertices=rings.flat();let nearest:Point|null=null,best=threshold;
  for(const vertex of vertices){const d=distance(vertex,point);if(d<=best){nearest=vertex;best=d;}}
  if(nearest)return{...nearest};
  for(const ring of rings)for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length],dx=b.x-a.x,dy=b.y-a.y,square=dx*dx+dy*dy;
    if(square===0)continue;
    const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/square)),projection={x:a.x+t*dx,y:a.y+t*dy},d=distance(point,projection);
    if(d<=best){nearest=projection;best=d;}
  }
  return nearest?{...nearest}:{...point};
}

export function validateOpeningShape(opening:Polygon):void {
  if(!opening||!Array.isArray(opening.points)||opening.points.length>200||!Array.isArray(opening.holes??[])||(opening.holes??[]).length>8||(opening.holes??[]).some(ring=>!Array.isArray(ring)||ring.length>200))throw new RangeError('楼板洞口轮廓无效，单个轮廓最多支持 200 个顶点。');
  const result=validateRegion(opening);
  if(!result.valid)throw new RangeError('楼板洞口无效：'+result.error);
}

function splitCrossings(first:Segment,second:Segment,eps:number):void {
  const r=delta(first.b,first.a),s=delta(second.b,second.a),q=delta(second.a,first.a),den=cross(r,s);
  const lr=Math.hypot(r.x,r.y),ls=Math.hypot(s.x,s.y),tolerance=eps*(lr+ls);
  if(Math.abs(den)>tolerance){
    const t=cross(q,s)/den,u=cross(q,r)/den;
    if(t>=-eps/lr&&t<=1+eps/lr&&u>=-eps/ls&&u<=1+eps/ls){first.cuts.push(Math.max(0,Math.min(1,t)));second.cuts.push(Math.max(0,Math.min(1,u)));}
    return;
  }
  if(Math.abs(cross(q,r))>eps*lr)return;
  const push=(target:Segment,point:Point)=>{const direction=delta(target.b,target.a),square=direction.x**2+direction.y**2,t=((point.x-target.a.x)*direction.x+(point.y-target.a.y)*direction.y)/square;if(t>=-eps/Math.sqrt(square)&&t<=1+eps/Math.sqrt(square))target.cuts.push(Math.max(0,Math.min(1,t)));};
  push(first,second.a);push(first,second.b);push(second,first.a);push(second,first.b);
}
function simplify(ring:Point[],eps:number):Point[]{
  const result=ring.filter((point,i)=>distance(point,ring[(i+ring.length-1)%ring.length])>eps).map(point=>({...point}));
  let changed=true;
  while(changed&&result.length>3){changed=false;for(let i=0;i<result.length;i++){
    const a=result[(i+result.length-1)%result.length],b=result[i],c=result[(i+1)%result.length],ab=delta(b,a),bc=delta(c,b);
    if(Math.abs(cross(ab,bc))<=eps*(distance(a,b)+distance(b,c))&&ab.x*bc.x+ab.y*bc.y>=0){result.splice(i,1);changed=true;break;}
  }}
  return result;
}

/** Regularized planar difference. Every input edge is split at all exact
 * intersections, then only edges separating retained/removed material remain.
 * This builds real concave boundaries and islands, including edge-aligned
 * cuts, rather than pretending a boundary-touching opening has a tiny gap. */
function differenceParts(room:Polygon&{surfaceParts?:SurfacePart[]},openings:Polygon[]):SurfacePart[]{
  const sourceParts=room.surfaceParts??[room];
  const rings=[...sourceParts.flatMap(part=>[part.points,...(part.holes??[])]),...openings.flatMap(opening=>[opening.points,...(opening.holes??[])])],points=rings.flat();
  const xs=points.map(point=>point.x),ys=points.map(point=>point.y),extent=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const eps=Math.max(1e-8,extent*1e-11,Math.max(...points.map(point=>Math.max(Math.abs(point.x),Math.abs(point.y))))*Number.EPSILON*32);
  const segments:Segment[]=rings.flatMap(ring=>ring.map((a,i)=>({a,b:ring[(i+1)%ring.length],cuts:[0,1]})));
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
    const a=segments[i],b=segments[j];
    if(Math.max(a.a.x,a.b.x)<Math.min(b.a.x,b.b.x)-eps||Math.max(b.a.x,b.b.x)<Math.min(a.a.x,a.b.x)-eps||Math.max(a.a.y,a.b.y)<Math.min(b.a.y,b.b.y)-eps||Math.max(b.a.y,b.b.y)<Math.min(a.a.y,a.b.y)-eps)continue;
    splitCrossings(a,b,eps);
  }
  const retained=(point:Point)=>sourceParts.some(part=>inside(part,point))&&!openings.some(opening=>inside(opening,point));
  const vertices:Point[]=[],buckets=new Map<string,number[]>(),outgoing=new Map<number,number[]>(),edgeKeys=new Set<string>();
  const weld=(point:Point)=>{
    const x=Math.round(point.x/eps),y=Math.round(point.y/eps);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const id of buckets.get(`${x+dx},${y+dy}`)??[])if(distance(vertices[id],point)<=eps*2)return id;
    const id=vertices.length;vertices.push({...point});const key=`${x},${y}`,ids=buckets.get(key)??[];ids.push(id);buckets.set(key,ids);return id;
  };
  const edges:{start:number;end:number;used:boolean}[]=[];
  for(const segment of segments){
    const length=distance(segment.a,segment.b),direction=delta(segment.b,segment.a),cuts=segment.cuts.sort((a,b)=>a-b).filter((t,i,array)=>i===0||(t-array[i-1])*length>eps);
    for(let i=0;i<cuts.length-1;i++){
      const t=cuts[i],u=cuts[i+1];if((u-t)*length<=eps)continue;
      const a={x:segment.a.x+t*direction.x,y:segment.a.y+t*direction.y},b={x:segment.a.x+u*direction.x,y:segment.a.y+u*direction.y},mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const offset=Math.min(eps*8,distance(a,b)*.001),normal={x:-direction.y/length*offset,y:direction.x/length*offset};
      const left=retained({x:mid.x+normal.x,y:mid.y+normal.y}),right=retained({x:mid.x-normal.x,y:mid.y-normal.y});
      if(left===right)continue;
      const start=weld(left?a:b),end=weld(left?b:a);if(start===end)continue;
      const key=`${start}:${end}`;if(edgeKeys.has(key))continue;edgeKeys.add(key);
      const id=edges.length;edges.push({start,end,used:false});const next=outgoing.get(start)??[];next.push(id);outgoing.set(start,next);
    }
  }
  const loops:Point[][]=[];
  const splitTouching=(ids:number[])=>{
    const seen=new Map<number,number>();for(let i=0;i<ids.length;i++){
      const previous=seen.get(ids[i]);if(previous!==undefined){const inner=ids.slice(previous,i),outer=[...ids.slice(0,previous),...ids.slice(i)];if(inner.length>=3)splitTouching(inner);if(outer.length>=3)splitTouching(outer);return;}seen.set(ids[i],i);
    }
    const ring=simplify(ids.map(id=>vertices[id]),eps);if(ring.length>=3&&Math.abs(signedArea(ring))>eps*eps*16)loops.push(ring);
  };
  for(let start=0;start<edges.length;start++){
    if(edges[start].used)continue;const ring:number[]=[];let current=start,closed=false;
    for(let guard=0;guard<=edges.length;guard++){
      const edge=edges[current];edge.used=true;ring.push(edge.start);if(edge.end===edges[start].start){closed=true;break;}
      const candidates=(outgoing.get(edge.end)??[]).filter(id=>!edges[id].used);
      if(!candidates.length)throw new RangeError('楼板洞边界无法可靠闭合，请调整过近的顶点。');
      const a=vertices[edge.start],b=vertices[edge.end],reverse=Math.atan2(a.y-b.y,a.x-b.x),turn=(id:number)=>{const next=edges[id],p=vertices[next.start],q=vertices[next.end];return(reverse-Math.atan2(q.y-p.y,q.x-p.x)+Math.PI*2)%(Math.PI*2);};
      current=candidates.reduce((best,id)=>turn(id)<turn(best)?id:best,candidates[0]);
    }
    if(!closed)throw new RangeError('楼板洞边界无法可靠重建。');splitTouching(ring);
  }
  const outers=loops.filter(ring=>signedArea(ring)>0).sort((a,b)=>polygonArea(b)-polygonArea(a)||a[0].x-b[0].x||a[0].y-b[0].y),holes=loops.filter(ring=>signedArea(ring)<0);
  const parts:SurfacePart[]=outers.map(points=>({points,holes:[]}));
  for(const hole of holes){
    const anchor=regionInteriorPoint({points:hole,holes:[]})??hole[0];
    // A retained island nested in a void is another outer, not another owner.
    const hosts=parts.filter(part=>polygonArea(part.points)>polygonArea(hole)+eps*eps&&contains(part.points,anchor)).sort((a,b)=>polygonArea(a.points)-polygonArea(b.points));
    if(!hosts.length)throw new RangeError('楼板洞内轮廓无法匹配实际地板。');hosts[0].holes.push(hole);
  }
  return parts;
}

/** Subtract the union of actual apertures from a room. Parts remain one priced
 * room; an annulus returns the surrounding floor plus its retained centre. */
export function openingRegionParts(region:Pick<Region,'points'|'holes'|'surfaceParts'>,openings:Pick<FloorOpening,'points'|'holes'>[]):SurfacePart[]{
  const validity=validateRegion(region);if(!validity.valid)throw new RangeError('楼板所属房间无效：'+validity.error);
  if(!openings.length)return(region.surfaceParts??[region]).map(part=>({points:cloneRing(part.points),holes:(part.holes??[]).map(cloneRing)}));
  openings.forEach(validateOpeningShape);
  const key=JSON.stringify([region.points,region.holes??[],region.surfaceParts??null,openings.map(opening=>[opening.points,opening.holes??[]])]);
  const cached=geometryCache.get(key);
  if(cached){geometryCache.delete(key);geometryCache.set(key,cached);return structuredClone(cached);}
  const parts=differenceParts(region,openings);
  for(const part of parts){const validity=validatePolygon(part.points);if(!validity.valid)throw new RangeError('楼板洞边界无效：'+validity.error);for(const hole of part.holes){const validity=validatePolygon(hole);if(!validity.valid)throw new RangeError('楼板洞边界无效：'+validity.error);}}
  geometryCache.set(key,structuredClone(parts));
  if(geometryCache.size>MAX_CACHED_GEOMETRIES)geometryCache.delete(geometryCache.keys().next().value);
  return parts;
}
export function openingNetArea(region:Pick<Region,'points'|'holes'>,openings:Pick<FloorOpening,'points'|'holes'>[]):number{return openingRegionParts(region,openings).reduce((sum,part)=>sum+partArea(part),0);}
export function openingNetPerimeter(region:Pick<Region,'points'|'holes'>,openings:Pick<FloorOpening,'points'|'holes'>[]):number{return openingRegionParts(region,openings).reduce((sum,part)=>sum+polygonPerimeter(part.points)+part.holes.reduce((length,ring)=>length+polygonPerimeter(ring),0),0);}
