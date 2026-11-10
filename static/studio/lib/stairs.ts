import type { Furniture, Point, Project, StairSettings } from '../types.js';
import type { SolidSurface, SolidVector } from './wall-solid.js';
import type { Furniture3D } from './furniture3d.js';
import { polygonArea, validatePolygon } from './geometry.js';

export const STAIR_KINDS = ['stairs','stairsLanding','stairsLLeft','stairsLRight','stairsU','stairsSpiralLeft','stairsSpiralRight','stairsArcLeft','stairsArcRight'] as const;
export function isStairKind(kind: unknown): boolean { return STAIR_KINDS.includes(kind as typeof STAIR_KINDS[number]); }
export type StairPlanGeometry = { steps: Point[][]; outline: Point[]; holes: Point[][]; ascentPath: Point[]; opening: { points: Point[]; holes: Point[][]; shape: 'polygon' | 'rectangle' | 'annulus' }; stepCount: number; treadHeights: number[] };
type LocalStep = { points: Point[]; height: number; landing?: boolean };
type RailPoint = Point & { height: number };
type Layout = { steps: LocalStep[]; outline: Point[]; holes: Point[][]; path: Point[]; left: RailPoint[]; right: RailPoint[]; shape: StairPlanGeometry['opening']['shape'] };
const TAU = Math.PI * 2;
const EPS = 1e-8;
const scaleFor = (project: Pick<Project,'drawing'|'calibration'>): number | null => project.drawing?.type === 'plan' ? .01 : Number.isFinite(project.calibration?.metersPerPixel) && project.calibration.metersPerPixel > 0 ? project.calibration.metersPerPixel : null;
const rect = (x0:number,y0:number,x1:number,y1:number):Point[] => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
const signedArea = (ring: Point[]) => ring.reduce((sum,p,i)=>sum+p.x*ring[(i+1)%ring.length].y-ring[(i+1)%ring.length].x*p.y,0)/2;

export function stairSettings(item: Furniture): StairSettings {
  return {railing:'both',railingHeight:90,innerRatio:item.kind.includes('Spiral')?.18:.5,turnDegrees:item.kind.includes('Spiral')?360:180,openingClearance:5,...item.stair};
}
export function validateStairSettings(item: Furniture): void {
  if (item.stair === undefined) return;
  if (!isStairKind(item.kind)) throw new RangeError('只有楼梯可以配置扶手和楼梯口。');
  const value=item.stair;
  if (!value || typeof value!=='object' || Array.isArray(value) || !['none','left','right','both'].includes(value.railing) || !Number.isFinite(value.railingHeight) || value.railingHeight<50 || value.railingHeight>150) throw new RangeError('楼梯扶手设置不正确，高度应为 50–150 cm。');
  if (value.innerRatio!==undefined && (!Number.isFinite(value.innerRatio)||value.innerRatio<.05||value.innerRatio>.85)) throw new RangeError('楼梯内径比例应为 5%–85%。');
  if (value.turnDegrees!==undefined) {
    const spiral=item.kind.includes('Spiral');
    if (!Number.isFinite(value.turnDegrees)||value.turnDegrees<(spiral?180:45)||value.turnDegrees>(spiral?720:300)) throw new RangeError(spiral?'螺旋楼梯转角应为 180–720°。':'弧形楼梯转角应为 45–300°。');
  }
  if (value.openingClearance!==undefined && (!Number.isFinite(value.openingClearance)||value.openingClearance<0||value.openingClearance>100)) throw new RangeError('楼梯口预留边距应为 0–100 cm。');
  if (value.autoOpening!==undefined && typeof value.autoOpening!=='boolean') throw new RangeError('楼梯口联动设置不正确。');
}

function addFlight(layout: Layout, start:Point, end:Point, width:number, count:number, first:number, total:number, rise:number):void {
  const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length;
  const edge=(t:number,side:number)=>({x:start.x+dx*t+nx*width/2*side,y:start.y+dy*t+ny*width/2*side});
  for(let i=0;i<count;i++) {
    const height=(first+i+1)*rise/total,points=[edge(i/count,1),edge(i/count,-1),edge((i+1)/count,-1),edge((i+1)/count,1)];
    layout.steps.push({points,height});
    for(const [key,side] of [['left',1],['right',-1]] as const) {
      const railWidth=Math.max(width/2-Math.min(3,width*.08),width*.3),endInset=Math.min(3/length,.05),point=(t:number)=>{const position=Math.max(endInset,Math.min(1-endInset,t));return{x:start.x+dx*position+nx*railWidth*side,y:start.y+dy*position+ny*railWidth*side,height};};
      if(i===0)layout[key].push(point(0));layout[key].push(point((i+1)/count));
    }
    layout.path.push({x:start.x+dx*(i+.5)/count,y:start.y+dy*(i+.5)/count});
  }
}
function basicLayout(item: Furniture): Layout {
  const w=item.width,d=item.depth,rise=item.height,n=Math.max(3,Math.min(112,Math.ceil(rise/18))),n1=Math.floor(n/2),n2=n-n1;
  const layout:Layout={steps:[],outline:rect(-w/2,-d/2,w/2,d/2),holes:[],path:[],left:[],right:[],shape:'rectangle'};
  if(item.kind==='stairs')addFlight(layout,{x:0,y:-d/2},{x:0,y:d/2},w,n,0,n,rise);
  else if(item.kind==='stairsLanding') {
    const landing=d*.2;
    addFlight(layout,{x:0,y:-d/2},{x:0,y:-landing/2},w,n1,0,n,rise);
    layout.steps.push({points:rect(-w/2,-landing/2,w/2,landing/2),height:n1*rise/n,landing:true});
    addFlight(layout,{x:0,y:landing/2},{x:0,y:d/2},w,n2,n1,n,rise);
  } else if(item.kind==='stairsLLeft'||item.kind==='stairsLRight') {
    const fw=Math.min(w,d)*.32;
    layout.outline=[{x:-w/2,y:-d/2},{x:-w/2+fw,y:-d/2},{x:-w/2+fw,y:d/2-fw},{x:w/2,y:d/2-fw},{x:w/2,y:d/2},{x:-w/2,y:d/2}];layout.shape='polygon';
    addFlight(layout,{x:-w/2+fw/2,y:-d/2},{x:-w/2+fw/2,y:d/2-fw},fw,n1,0,n,rise);
    layout.steps.push({points:rect(-w/2,d/2-fw,-w/2+fw,d/2),height:n1*rise/n,landing:true});
    addFlight(layout,{x:-w/2+fw,y:d/2-fw/2},{x:w/2,y:d/2-fw/2},fw,n2,n1,n,rise);
    if(item.kind==='stairsLLeft') {
      const mirror=(p:Point)=>({...p,x:-p.x});layout.outline=layout.outline.map(mirror).reverse();layout.steps=layout.steps.map(step=>({...step,points:step.points.map(mirror).reverse()}));layout.path=layout.path.map(mirror);
      const oldLeft=layout.left;layout.left=layout.right.map(p=>({...p,x:-p.x}));layout.right=oldLeft.map(p=>({...p,x:-p.x}));
    }
  } else if(item.kind==='stairsU') {
    const gap=Math.min(w*.12,30),fw=(w-gap)/2,landing=Math.min(fw,d*.25);
    layout.outline=[{x:-w/2,y:-d/2},{x:-gap/2,y:-d/2},{x:-gap/2,y:d/2-landing},{x:gap/2,y:d/2-landing},{x:gap/2,y:-d/2},{x:w/2,y:-d/2},{x:w/2,y:d/2},{x:-w/2,y:d/2}];layout.shape='polygon';
    addFlight(layout,{x:-gap/2-fw/2,y:-d/2},{x:-gap/2-fw/2,y:d/2-landing},fw,n1,0,n,rise);
    layout.steps.push({points:rect(-w/2,d/2-landing,w/2,d/2),height:n1*rise/n,landing:true});
    // The route crosses the rear of the landing, while the return flight runs
    // alongside the first flight, rather than overlapping it.
    for(const key of ['left','right'] as const) {
      const last=layout[key].at(-1);layout[key].push({...last,y:d/2-Math.min(3,landing*.1)});
      const x=key==='left'?w/2-Math.min(3,fw*.08):gap/2+Math.min(3,fw*.08);layout[key].push({x,y:d/2-Math.min(3,landing*.1),height:n1*rise/n});
    }
    layout.path.push({x:0,y:d/2-landing/2});
    addFlight(layout,{x:gap/2+fw/2,y:d/2-landing},{x:gap/2+fw/2,y:-d/2},fw,n2,n1,n,rise);
  }
  return layout;
}

function circleSegments(radius:number,sweep=TAU): number {
  const maxAngle=2*Math.acos(Math.max(-1,1-Math.min(.5,Math.max(radius*.01,.005))/Math.max(radius,.01)));
  return Math.max(8,Math.min(200,Math.ceil(Math.abs(sweep)/Math.max(maxAngle,.01))));
}
function curvedLayout(item: Furniture):Layout {
  const settings=stairSettings(item),spiral=item.kind.includes('Spiral'),direction=item.kind.endsWith('Left')?-1:1,sweep=settings.turnDegrees*Math.PI/180*direction,start=Math.PI/2,ratio=settings.innerRatio,n=Math.max(3,Math.min(112,Math.ceil(item.height/18)));
  // Fit the actual swept envelope to width/depth; a half-circle's width is
  // not silently interpreted as a full-circle diameter.
  const samples=Array.from({length:201},(_,i)=>{const a=start+sweep*i/200;return[{x:Math.cos(a),y:Math.sin(a)},{x:Math.cos(a)*ratio,y:Math.sin(a)*ratio}];}).flat();
  for(const a of [0,Math.PI/2,Math.PI,Math.PI*1.5])for(let k=-2;k<=2;k++){const value=a+k*TAU,t=(value-start)/sweep;if(t>=0&&t<=1)samples.push({x:Math.cos(value),y:Math.sin(value)},{x:Math.cos(value)*ratio,y:Math.sin(value)*ratio});}
  const minX=Math.min(...samples.map(p=>p.x)),maxX=Math.max(...samples.map(p=>p.x)),minY=Math.min(...samples.map(p=>p.y)),maxY=Math.max(...samples.map(p=>p.y)),sx=item.width/(maxX-minX),sy=item.depth/(maxY-minY),cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  const p=(angle:number,r=1)=>({x:(Math.cos(angle)*r-cx)*sx,y:(Math.sin(angle)*r-cy)*sy});
  const arc=(a:number,b:number,r=1)=>{
    const count=circleSegments(Math.max(sx,sy)*r,b-a),angles=Array.from({length:count+1},(_,i)=>a+(b-a)*i/count);
    for(let k=Math.floor(Math.min(a,b)/(Math.PI/2));k<=Math.ceil(Math.max(a,b)/(Math.PI/2));k++){const value=k*Math.PI/2;if(value>Math.min(a,b)+EPS&&value<Math.max(a,b)-EPS)angles.push(value);}
    angles.sort((x,y)=>(x-y)*Math.sign(b-a));return angles.filter((value,i)=>!i||Math.abs(value-angles[i-1])>EPS).map(value=>p(value,r));
  };
  const full=Math.abs(sweep)>=TAU-EPS,outer=full?arc(0,TAU).slice(0,-1):arc(start,start+sweep),inner=full?arc(0,TAU,ratio).slice(0,-1):arc(start,start+sweep,ratio).reverse();
  const layout:Layout={steps:[],outline:full?outer:[...outer,...inner],holes:full?[inner]:[],path:[],left:[],right:[],shape:full?'annulus':'polygon'};
  for(let i=0;i<n;i++) {
    const a=start+sweep*i/n,b=start+sweep*(i+1)/n,height=(i+1)*item.height/n,points=[...arc(a,b),...arc(b,a,ratio)];
    if(signedArea(points)<0)points.reverse();layout.steps.push({points,height});layout.path.push(p((a+b)/2,(1+ratio)/2));
    const railInset=Math.min(3/Math.min(sx,sy),(1-ratio)*.1),innerRail=ratio+railInset,outerRail=1-railInset;
    for(const [key,radius]of [['left',direction>0?outerRail:innerRail],['right',direction>0?innerRail:outerRail]]as const){
      const endInset=Math.min(3/(Math.min(sx,sy)*radius),Math.abs(sweep)*.02),onRail=(angle:number)=>{const progress=(angle-start)*direction;return p(start+Math.max(endInset,Math.min(Math.abs(sweep)-endInset,progress))*direction,radius);};
      if(i===0)layout[key].push({...onRail(a),height});for(let j=1,divisions=Math.max(1,Math.ceil(Math.abs(b-a)/.1));j<=divisions;j++)layout[key].push({...onRail(a+(b-a)*j/divisions),height:Math.max(1,i+j/divisions)*item.height/n});
    }
  }
  if(signedArea(layout.outline)<0)layout.outline.reverse();
  return layout;
}
function layoutFor(item: Furniture):Layout { return item.kind.includes('Spiral')||item.kind.includes('Arc')?curvedLayout(item):basicLayout(item); }

/** Parallel-edge offset in centimetres. Re-entrant corners are retained; no
 * screenshot pixels or current zoom participate in matching an aperture. */
function offsetRing(ring:Point[],margin:number):Point[] {
  if(!margin)return ring.map(p=>({...p}));
  const sign=signedArea(ring)>=0?1:-1;
  return ring.map((p,i)=>{
    const a=ring[(i+ring.length-1)%ring.length],b=ring[(i+1)%ring.length],u={x:p.x-a.x,y:p.y-a.y},v={x:b.x-p.x,y:b.y-p.y},lu=Math.hypot(u.x,u.y),lv=Math.hypot(v.x,v.y),n1={x:u.y/lu*sign,y:-u.x/lu*sign},n2={x:v.y/lv*sign,y:-v.x/lv*sign},den=u.x*v.y-u.y*v.x;
    if(Math.abs(den)<EPS)return{x:p.x+n2.x*margin,y:p.y+n2.y*margin};
    const q={x:p.x+n1.x*margin,y:p.y+n1.y*margin},r={x:p.x+n2.x*margin,y:p.y+n2.y*margin},t=((r.x-q.x)*v.y-(r.y-q.y)*v.x)/den;return{x:q.x+u.x*t,y:q.y+u.y*t};
  });
}
export function stairPlanGeometry(item:Furniture,project:Pick<Project,'drawing'|'calibration'>):StairPlanGeometry|null {
  if(!isStairKind(item.kind))return null;const scale=scaleFor(project);if(!scale)return null;validateStairSettings(item);
  const layout=layoutFor(item),angle=item.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),factor=1/(100*scale),map=(p:Point)=>({x:item.position.x+(p.x*c-p.y*s)*factor,y:item.position.y+(p.x*s+p.y*c)*factor});
  const margin=stairSettings(item).openingClearance,opening=offsetRing(layout.outline,margin);
  // A wide clearance closes the U-shaped well; the real buffered envelope then
  // becomes its full rectangle, rather than an invalid self-intersection.
  let points=opening;
  if(!validatePolygon(points).valid&&item.kind==='stairsU')points=rect(-item.width/2-margin,-item.depth/2-margin,item.width/2+margin,item.depth/2+margin);
  const holes=layout.holes.filter(hole=>Math.max(...hole.map(p=>p.x))-Math.min(...hole.map(p=>p.x))>2*margin+EPS&&Math.max(...hole.map(p=>p.y))-Math.min(...hole.map(p=>p.y))>2*margin+EPS).map(hole=>offsetRing(hole,-margin)).filter(hole=>validatePolygon(hole).valid&&polygonArea(hole)>EPS);
  return {steps:layout.steps.map(step=>step.points.map(map)),outline:layout.outline.map(map),holes:layout.holes.map(hole=>hole.map(map)),ascentPath:layout.path.map(map),opening:{points:points.map(map),holes:holes.map(hole=>hole.map(map)),shape:layout.shape},stepCount:layout.steps.filter(step=>!step.landing).length,treadHeights:layout.steps.map(step=>step.height)};
}

const vectorCross=(a:SolidVector,b:SolidVector):SolidVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const norm=(p:SolidVector):SolidVector=>{const length=Math.hypot(p.x,p.y,p.z);return{x:p.x/length,y:p.y/length,z:p.z/length};};
const subtract=(a:SolidVector,b:SolidVector)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});

/** Treads, landings, posts and continuous sloping rails share the same layout
 * as 2D and the matched aperture. Rise excludes railing height. */
export function buildStair3D(item:Furniture,project:Pick<Project,'drawing'|'calibration'>):Furniture3D|null {
  if(!isStairKind(item.kind))return null;const scale=scaleFor(project);if(!scale)return null;validateStairSettings(item);
  const layout=layoutFor(item),settings=stairSettings(item),angle=item.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),position={x:item.position.x*scale,y:(item.mountHeight??0)/100,z:item.position.y*scale},surfaces:SolidSurface[]=[];
  const world=(p:SolidVector)=>({x:position.x+(p.x*c-p.z*s)/100,y:position.y+p.y/100,z:position.z+(p.x*s+p.z*c)/100});
  const face=(points:SolidVector[],name:string,color:string,side:SolidSurface['side']='end')=>{
    const normal=norm(vectorCross(subtract(points[1],points[0]),subtract(points[2],points[0])));if(![normal.x,normal.y,normal.z].every(Number.isFinite))return;
    surfaces.push({id:`furniture:${item.id}:${name}`,wallId:`furniture:${item.id}`,sourceIds:[],points:points.map(world),normal:{x:normal.x*c-normal.z*s,y:normal.y,z:normal.x*s+normal.z*c},color,side});
  };
  const prism=(ring:Point[],bottom:number,top:number,name:string,color:string)=>{
    const points=signedArea(ring)>0?ring:[...ring].reverse();
    face(points.map(p=>({x:p.x,y:top,z:p.y})).reverse(),`${name}:top`,color,'top');face(points.map(p=>({x:p.x,y:bottom,z:p.y})),`${name}:bottom`,color,'bottom');
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];face([{x:a.x,y:bottom,z:a.y},{x:a.x,y:top,z:a.y},{x:b.x,y:top,z:b.y},{x:b.x,y:bottom,z:b.y}],`${name}:side:${i}`,color);}
  };
  const helical=item.kind.includes('Spiral')||item.kind.includes('Arc'),treadThickness=Math.min(8,item.height/Math.max(3,Math.ceil(item.height/18))*.55);
  layout.steps.forEach((step,i)=>prism(step.points,helical?Math.max(0,step.height-treadThickness):0,step.height,`${step.landing?'landing':'step'}:${i}`,'#c4b69d'));
  const beam=(a:SolidVector,b:SolidVector,width:number,name:string,color='#a0aaa2')=>{
    const axis=subtract(b,a),length=Math.hypot(axis.x,axis.y,axis.z);if(length<EPS)return;const direction=norm(axis),u=norm(vectorCross(direction,Math.abs(direction.y)>.9?{x:1,y:0,z:0}:{x:0,y:1,z:0})),v=vectorCross(direction,u),corners=(p:SolidVector)=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([su,sv])=>({x:p.x+(u.x*su+v.x*sv)*width/2,y:p.y+(u.y*su+v.y*sv)*width/2,z:p.z+(u.z*su+v.z*sv)*width/2})),first=corners(a),last=corners(b);
    face([...first].reverse(),`${name}:a`,color);face(last,`${name}:b`,color);for(let i=0;i<4;i++)face([first[i],first[(i+1)%4],last[(i+1)%4],last[i]],`${name}:side:${i}`,color);
  };
  if(helical) {
    // Open space beneath a helical flight is real geometry. Thin wedge treads
    // rest on sloping stringers, rather than tall wedges forming a solid tower.
    const first=layout.path[0];beam({x:first.x,y:0,z:first.y},{x:first.x,y:layout.steps[0].height-treadThickness,z:first.y},Math.min(8,item.width*.04,item.depth*.04),'foot','#9ba69c');
    for(const key of ['left','right']as const)for(let i=1;i<layout[key].length;i++){const a=layout[key][i-1],b=layout[key][i];beam({x:a.x,y:Math.max(0,a.height-treadThickness),z:a.y},{x:b.x,y:Math.max(0,b.height-treadThickness),z:b.y},3.5,`stringer:${key}:${i}`,'#a8ad9f');}
    if(layout.holes.length) {
      const ring=layout.holes[0],minX=Math.min(...ring.map(p=>p.x)),maxX=Math.max(...ring.map(p=>p.x)),minY=Math.min(...ring.map(p=>p.y)),maxY=Math.max(...ring.map(p=>p.y)),rx=(maxX-minX)*.30,ry=(maxY-minY)*.30,cx=(maxX+minX)/2,cy=(maxY+minY)/2;
      prism(Array.from({length:16},(_,i)=>({x:cx+Math.cos(TAU*i/16)*rx,y:cy+Math.sin(TAU*i/16)*ry})),0,item.height,'centre-post','#adb5a9');
    }
  }
  for(const key of ['left','right']as const) {
    if(settings.railing!=='both'&&settings.railing!==key)continue;const rail=layout[key];
    // Every tread has a post. Curved handrails add short tangent segments so
    // the visible rail follows the spiral, rather than cutting across it.
    const postStride=item.kind.includes('Spiral')||item.kind.includes('Arc')?Math.max(1,Math.round(rail.length/(layout.steps.length+1))):1;
    for(let i=0;i<rail.length;i++) {
      const p=rail[i],top={x:p.x,y:p.height+settings.railingHeight,z:p.y};
      if(i===0||i===rail.length-1||i%postStride===0)beam({x:p.x,y:p.height,z:p.y},top,2.8,`post:${key}:${i}`);
      if(i){const old=rail[i-1];beam({x:old.x,y:old.height+settings.railingHeight,z:old.y},top,3.8,`rail:${key}:${i}`,'#8f9c92');beam({x:old.x,y:old.height+settings.railingHeight*.5,z:old.y},{x:p.x,y:p.height+settings.railingHeight*.5,z:p.y},1.8,`rail-mid:${key}:${i}`);}
    }
  }
  return{id:item.id,name:item.name,kind:item.kind,position,size:{width:item.width/100,depth:item.depth/100,height:item.height/100},rotation:item.rotation,surfaces,geometrySource:'parametric'};
}
