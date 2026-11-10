import type { Point, Project, SurfacePart } from '../types.js';
import { pointInRegion } from './geometry.js';
import { municipalEffectiveWidth, municipalFootprints, municipalScale, municipalJunctionArms, municipalBridgeQuantities, municipalCorridor, MAX_BRIDGE_PIERS, type MunicipalElement } from './municipal-design.js';

/** Display geometry only. Markings and furniture must never alter net quantities. */
export type MunicipalDecoration = { id:string; kind:'lane'|'median'|'arrow'|'crosswalk'|'stop'|'island'; color:string; points:Point[]; lift:number };
export type MunicipalPathSample = { point:Point; direction:Point; station:number };
const EPS=1e-8;
const distance=(a:Point,b:Point)=>Math.hypot(b.x-a.x,b.y-a.y);
const WHITE='#e8e9df',YELLOW='#d5be78';

/** Arc length sampling is independent of camera zoom and preserves each segment direction. */
export function municipalPathSample(points:ReadonlyArray<Point>,station:number):MunicipalPathSample|null {
  if(points.length<2||!Number.isFinite(station)||station<0)return null;
  let traversed=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],length=distance(a,b);if(length<EPS)continue;
    if(station<=traversed+length+EPS){const t=Math.max(0,Math.min(1,(station-traversed)/length));return{point:{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},direction:{x:(b.x-a.x)/length,y:(b.y-a.y)/length},station};}
    traversed+=length;
  }
  return null;
}

function strip(a:Point,b:Point,width:number):Point[]{
  const length=distance(a,b);if(length<EPS)return[];
  const nx=-(b.y-a.y)/length*width/2,ny=(b.x-a.x)/length*width/2;
  return[{x:a.x+nx,y:a.y+ny},{x:b.x+nx,y:b.y+ny},{x:b.x-nx,y:b.y-ny},{x:a.x-nx,y:a.y-ny}];
}
function rectangle(center:Point,u:Point,length:number,width:number):Point[]{
  const v={x:-u.y,y:u.x};
  return[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:center.x+u.x*x*length/2+v.x*y*width/2,y:center.y+u.y*x*length/2+v.y*y*width/2}));
}
function arrow(center:Point,u:Point,length:number,halfWidth:number):Point[]{
  const v={x:-u.y,y:u.x};
  return[[-.5,-.2],[.05,-.2],[.05,-.5],[.5,0],[.05,.5],[.05,.2],[-.5,.2]].map(([x,y])=>({x:center.x+u.x*x*length+v.x*y*halfWidth*2,y:center.y+u.y*x*length+v.y*y*halfWidth*2}));
}
function within(points:Point[],parts:SurfacePart[]):boolean {
  if(!points.length)return false;
  // Short segments are intentionally discarded at ownership boundaries rather
  // than painting across a neighbouring road or a retained island.
  const center=points.reduce((p,q)=>({x:p.x+q.x/points.length,y:p.y+q.y/points.length}),{x:0,y:0});
  return [...points,center,...points.map((p,i)=>({x:(p.x+points[(i+1)%points.length].x)/2,y:(p.y+points[(i+1)%points.length].y)/2}))].every(p=>parts.some(part=>pointInRegion(p,part)));
}

export function municipalDecorations(element:MunicipalElement,project:Project):MunicipalDecoration[]{
  const scale=municipalScale(project);if(!scale)return[];
  const parts=municipalFootprints(element,project)??[],result:MunicipalDecoration[]=[],width=municipalEffectiveWidth(element)*.01/scale;
  const add=(kind:MunicipalDecoration['kind'],points:Point[],color=WHITE,lift=.012,clip=true)=>{
    if(result.length>=1024||points.length<3||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))||clip&&!within(points,parts))return;
    result.push({id:`${element.id}:decoration:${kind}:${result.length}`,kind,color,points,lift});
  };
  if(element.kind==='road'||element.kind==='bridge'){
    const layout=element.roadLayout,lanes=layout?.lanes??2,median=(layout?.medianWidth??0)*.01/scale;
    const laneWidth=(width-median)/lanes,total=element.points.slice(1).reduce((sum,p,i)=>sum+distance(element.points[i],p),0);
    const lineWidth=.12/scale,step=Math.max(6/scale,total/Math.max(1,Math.floor(640/(lanes+1))));
    const offsets=Array.from({length:lanes-1},(_,i)=>{const lane=i+1;return lane===lanes/2?0:-width/2+lane*laneWidth+(lane>lanes/2?median:0);});
    for(const offset of offsets)for(let station=1/scale;station<total-.2/scale;station+=step){
      const sample=municipalPathSample(element.points,station),end=municipalPathSample(element.points,Math.min(total-.1/scale,station+Math.min(step*.45,3/scale)));
      if(!sample||!end||sample.direction.x*end.direction.x+sample.direction.y*end.direction.y<.98)continue;
      const shifted=(p:MunicipalPathSample,o:number)=>({x:p.point.x-p.direction.y*o,y:p.point.y+p.direction.x*o});
      if(offset===0&&median>0){add('median',strip(shifted(sample,-median/2),shifted(end,-median/2),lineWidth),YELLOW);add('median',strip(shifted(sample,median/2),shifted(end,median/2),lineWidth),YELLOW);}
      else add(offset===0?'median':'lane',strip(shifted(sample,offset),shifted(end,offset),lineWidth),offset===0?YELLOW:WHITE);
    }
    // Sparse directional arrows remain legible on short or very large projects.
    const count=Math.min(3,Math.max(1,Math.floor(total/(24/scale))));
    for(let i=0;i<count;i++)for(let lane=0;lane<lanes;lane++){
      const sample=municipalPathSample(element.points,total*(i+1)/(count+1));if(!sample||total<6/scale)continue;
      const offset=-width/2+(lane+.5)*laneWidth+(lane>=lanes/2?median:0),forward=lane<lanes/2?-1:1,u={x:sample.direction.x*forward,y:sample.direction.y*forward},center={x:sample.point.x-sample.direction.y*offset,y:sample.point.y+sample.direction.x*offset};
      const length=Math.min(2/scale,total/7),half=Math.min(.42/scale,laneWidth*.16);
      add('arrow',arrow(center,u,length,half));
    }
  }
  if(element.kind==='intersection'||element.kind==='roundabout'){
    const junction=element.junction??{arms:4,armLength:1800,rotation:0,islandRadius:600},center=element.points[0],island=junction.islandRadius*.01/scale;
    const layout=element.roadLayout,lanes=layout?.lanes??2,median=(layout?.medianWidth??0)*.01/scale,laneWidth=(width-median)/lanes,lineWidth=.12/scale;
    if(element.kind==='roundabout')add('island',Array.from({length:64},(_,i)=>({x:center.x+island*Math.cos(i*Math.PI/32),y:center.y+island*Math.sin(i*Math.PI/32)})),'#8ba184',.14,false);
    // Keep approach markings outside the central conflict area. A T-junction
    // has 90-degree corners, like a four-arm junction, rather than 120 degrees.
    const inner=element.kind==='roundabout'?island+width:junction.arms===8?width/(2*Math.tan(Math.PI/8)):width/2;
    for(const arm of municipalJunctionArms(element,project)){
      const length=distance(center,arm.end),u={x:(arm.end.x-center.x)/length,y:(arm.end.y-center.y)/length},v={x:-u.y,y:u.x};
      const at=(station:number,offset=0)=>({x:center.x+u.x*station+v.x*offset,y:center.y+u.y*station+v.y*offset});
      const crossAt=Math.min(length-1.5/scale,inner+1.6/scale);if(crossAt<=inner)continue;
      for(let stripe=-width*.42;stripe<width*.42;stripe+=.9/scale){
        if(median>0&&Math.abs(stripe)<median/2+.2/scale)continue;
        add('crosswalk',rectangle(at(crossAt,stripe),u,2/scale,.4/scale));
      }
      // The negative-offset half of each approach is incoming, matching the
      // road arrows. A stop line never crosses the opposing carriageway.
      const stopAt=crossAt+1.65/scale,incomingWidth=(width-median)/2;
      add('stop',rectangle(at(stopAt,-(width+median)/4),u,.2/scale,Math.max(lineWidth,incomingWidth-.3/scale)));
      const start=stopAt+1/scale,end=length-.3/scale;
      if(end>start){
        const medians=median>0?[-median/2,median/2]:[0];
        for(const offset of medians)add('median',strip(at(start,offset),at(end,offset),lineWidth),YELLOW);
        const step=Math.max(6/scale,(end-start)/Math.max(1,Math.floor(480/(junction.arms*Math.max(1,lanes-2)))));
        for(let lane=1;lane<lanes;lane++){
          if(lane===lanes/2)continue;
          const offset=-width/2+lane*laneWidth+(lane>lanes/2?median:0);
          for(let station=start;station<end-lineWidth;station+=step)add('lane',strip(at(station,offset),at(Math.min(end,station+Math.min(step*.45,3/scale)),offset),lineWidth));
        }
        if(end-start>=2/scale)for(let lane=0;lane<lanes;lane++){
          const offset=-width/2+(lane+.5)*laneWidth+(lane>=lanes/2?median:0),forward=lane<lanes/2?-1:1;
          add('arrow',arrow(at((start+end)/2,offset),{x:u.x*forward,y:u.y*forward},Math.min(2/scale,(end-start)*.6),Math.min(.42/scale,laneWidth*.16)));
        }
      }
    }
    if(element.kind==='roundabout'){
      // Circulating lanes all travel in one direction. The full radial road
      // width is divided into lanes; a two-way approach median ends at entry.
      const circularLaneWidth=width/lanes,rotation=junction.rotation*Math.PI/180;
      const circlePoint=(radius:number,angle:number)=>({x:center.x+radius*Math.cos(angle),y:center.y+radius*Math.sin(angle)});
      for(let lane=1;lane<lanes;lane++){
        const radius=island+lane*circularLaneWidth,count=Math.min(64,Math.max(12,Math.ceil(Math.PI*2*radius/(6/scale))));
        for(let i=0;i<count;i++){
          const a=rotation+i*Math.PI*2/count,b=a+Math.PI*2/count*.45;
          add('lane',[circlePoint(radius-lineWidth/2,a),circlePoint(radius-lineWidth/2,b),circlePoint(radius+lineWidth/2,b),circlePoint(radius+lineWidth/2,a)]);
        }
      }
      for(let lane=0;lane<lanes;lane++)for(let i=0;i<4;i++){
        const angle=rotation+(i+.5)*Math.PI/2,radius=island+(lane+.5)*circularLaneWidth;
        add('arrow',arrow(circlePoint(radius,angle),{x:Math.sin(angle),y:-Math.cos(angle)},Math.min(2/scale,radius*.25),Math.min(.42/scale,circularLaneWidth*.16)));
      }
    }
  }
  return result;
}

export function municipalBridgeSupports(element:MunicipalElement,project:Project):MunicipalPathSample[]{
  const scale=municipalScale(project);if(!scale||element.kind!=='bridge')return[];
  const total=element.points.slice(1).reduce((sum,p,i)=>sum+distance(element.points[i],p),0),spacing=(element.bridgeOptions?.pierSpacing??1000)*.01/scale;
  if(!Number.isFinite(spacing)||spacing<=0)return[];
  const count=municipalBridgeQuantities(element,project).pierCount??0;
  if(count>MAX_BRIDGE_PIERS)throw new RangeError(`桥梁中间墩最多支持 ${MAX_BRIDGE_PIERS} 座，请增加桥墩间距。`);
  return Array.from({length:count},(_,i)=>municipalPathSample(element.points,(i+1)*total/(count+1))).filter((p):p is MunicipalPathSample=>!!p&&p.station<total);
}

/** The two offset boundaries exclude the end caps, exactly like railing pricing. */
export function municipalBridgeRailPaths(element:MunicipalElement,project:Project):Point[][]{
  const scale=municipalScale(project);if(!scale||element.kind!=='bridge')return[];
  const ring=municipalCorridor(element.points,municipalEffectiveWidth(element)*.01/scale),half=ring.length/2;
  return[ring.slice(0,half),ring.slice(half).reverse()];
}
