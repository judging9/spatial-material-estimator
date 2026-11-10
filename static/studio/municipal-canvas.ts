import type { Point, Project, SurfacePart } from './types.js';
import { pointInRegion, regionInteriorPoint } from './lib/geometry.js';
import { createMunicipalElement, isMunicipalPath, isMunicipalPolygon, isMunicipalSurface, municipalFootprints, rawMunicipalFootprints, municipalMetrics, municipalElementPreset, municipalEffectiveWidth, municipalScale, type MunicipalElement, type MunicipalKind, type MunicipalPoint } from './lib/municipal-design.js';
import { municipalDecorations, municipalBridgeSupports } from './lib/municipal-decoration.js';
import { createMunicipalCatalogElement, municipalFacilityPlanSymbol } from './lib/municipal-catalog.js';
import type { MunicipalConnectionPort, MunicipalConnectionSnap } from './lib/municipal-connections.js';
import { roadStations, roadPointAtStation } from './lib/road-profile.js';

const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
/** Plan coordinates are display only; chainage is measured in actual metres. */
export function municipalTunnelPlanPath(element:MunicipalElement,project:Project):Point[]{
  const tunnel=element.tunnel,scale=municipalScale(project);if(element.kind!=='road'||!tunnel?.enabled||!scale)return[];
  const stations=roadStations(project,element)??[];
  return[tunnel.startStation,...stations.filter(s=>s>tunnel.startStation&&s<tunnel.endStation),tunnel.endStation].map(station=>{const p=roadPointAtStation(project,element,station);return{x:p.x/scale,y:p.y/scale};});
}
function segmentDistance(point:Point,a:Point,b:Point){const dx=b.x-a.x,dy=b.y-a.y,square=dx*dx+dy*dy,t=square?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/square)):0;return distance(point,{x:a.x+t*dx,y:a.y+t*dy});}
export function municipalVertexAt(element:MunicipalElement|null|undefined,point:Point,tolerance:number):number|null{
  if(!element||element.hidden||element.locked)return null;
  let index:number|null=null,best=tolerance;
  element.points.forEach((vertex,i)=>{const d=distance(vertex,point);if(d<=best){best=d;index=i;}});return index;
}
export function municipalAtPoint(project:Project,point:Point,tolerance:number,selectedId?:string|null):MunicipalElement|null{
  const elements=[...(project.municipalElements??[])].reverse();
  for(const element of elements){
    if(element.hidden)continue;
    const footprints=municipalFootprints(element,project);
    if(footprints?.some(part=>pointInRegion(point,part)))return element;
    if(isMunicipalPath(element.kind)&&element.points.some((a,i)=>i>0&&segmentDistance(point,element.points[i-1],a)<=tolerance))return element;
    if(!isMunicipalPath(element.kind)&&!isMunicipalPolygon(element.kind)&&!isMunicipalSurface(element.kind)&&distance(point,element.points[0])<=tolerance)return element;
  }
  return null;
}
export function snapMunicipalPoint(project:Project,point:Point,zoom:number,reference?:Point,shift=false,alt=false,excludedId?:string):Point{
  let snapped={...point};
  const horizontal=reference&&Math.abs(point.x-reference.x)>=Math.abs(point.y-reference.y);
  if(shift&&reference){if(horizontal)snapped.y=reference.y;else snapped.x=reference.x;}
  if(alt)return snapped;
  if(project.drawing?.type==='plan')snapped={x:Math.round(snapped.x),y:Math.round(snapped.y)};
  if(shift&&reference){if(horizontal)snapped.y=reference.y;else snapped.x=reference.x;}
  let best=8/zoom;
  for(const element of project.municipalElements??[])if(!element.hidden&&element.id!==excludedId)for(const vertex of element.points){
    if(shift&&reference&&(horizontal?Math.abs(vertex.y-reference.y):Math.abs(vertex.x-reference.x))>1e-7)continue;
    const d=distance(snapped,vertex);if(d<best){best=d;snapped={x:vertex.x,y:vertex.y};}
  }
  return snapped;
}

type DrawOptions={ctx:CanvasRenderingContext2D;project:Project;selectedId:string|null;toScreen:(point:Point)=>Point;zoom:number;draft:Point[];cursor:Point|null;kind:MunicipalKind|null;drawing:boolean;settings?:Partial<MunicipalElement>;connection?:MunicipalConnectionSnap|null;anchorPort?:MunicipalConnectionPort|null};
export function municipalDrawingPreview(kind:MunicipalKind,points:ReadonlyArray<Point>,project:Project,settings:Partial<MunicipalElement>={}):MunicipalElement {
  return settings.catalogId ? createMunicipalCatalogElement(settings.catalogId,points,project,settings) : createMunicipalElement(kind,points,project,settings);
}

/** Small physical objects keep a legible plan symbol over their true footprint.
 * The symbol is a display aid; picking and pricing use original geometry. */
function facilitySymbol(ctx:CanvasRenderingContext2D,element:MunicipalElement,project:Project,toScreen:(point:Point)=>Point,zoom:number,selected:boolean) {
  const p=toScreen(element.points[0]),scale=municipalScale(project)??.01,symbol=municipalFacilityPlanSymbol(element);
  const width=Math.max(14,Math.min(150,element.width*.01/scale*zoom)),depth=Math.max(14,Math.min(100,element.depth*.01/scale*zoom));
  ctx.save();ctx.translate(p.x,p.y);ctx.rotate((element.rotation??0)*Math.PI/180);ctx.strokeStyle=selected?'#276853':'#566e60';ctx.fillStyle='#fffffff0';ctx.lineWidth=selected?1.5:1;
  const line=(points:number[][],close=false)=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x*width,y*depth):ctx.moveTo(x*width,y*depth));if(close)ctx.closePath();ctx.stroke();};
  const box=(x:number,y:number,w:number,d:number)=>{ctx.beginPath();ctx.roundRect(x*width,y*depth,w*width,d*depth,Math.min(3,w*width/6,d*depth/6));ctx.fill();ctx.stroke();};
  const oval=(x:number,y:number,rx:number,ry:number)=>{ctx.beginPath();ctx.ellipse(x*width,y*depth,rx*width,ry*depth,0,0,Math.PI*2);ctx.fill();ctx.stroke();};
  if(symbol==='tree'){ctx.fillStyle='#d8e4d0cc';oval(0,0,.43,.43);oval(-.14,-.1,.2,.21);oval(.16,.06,.2,.22);}
  else if(symbol==='bollard'||symbol==='hydrant'||symbol==='fountain'){oval(0,0,.32,.32);if(symbol==='hydrant'){line([[-.48,0],[.48,0]]);line([[0,-.46],[0,.46]]);}if(symbol==='fountain'){ctx.fillStyle='#bddbdccc';oval(0,0,.19,.19);}}
  else if(symbol==='bench'){box(-.46,-.33,.92,.66);for(const y of [-.17,.04,.24])line([[-.42,y],[.42,y]]);line([[-.33,-.44],[-.33,-.3]]);line([[.33,-.44],[.33,-.3]]);}
  else if(symbol==='bin'||symbol==='recycling'){box(-.4,-.42,.8,.84);line([[-.47,-.28],[.47,-.28]]);if(symbol==='recycling')for(const x of [-.13,.13])line([[x,-.26],[x,.38]]);else line([[-.16,-.1],[-.16,.26]]);}
  else if(symbol==='parking'){ctx.beginPath();ctx.rect(-width*.46,-depth*.46,width*.92,depth*.92);ctx.stroke();ctx.font=`500 ${Math.min(24,depth*.7)}px "Segoe UI",sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#566e60';ctx.fillText('P',0,0);}
  else if(symbol==='bicycle'){for(const x of [-.28,0,.28])oval(x,0,.09,.34);}
  else if(symbol==='shelter'){box(-.48,-.45,.96,.9);line([[-.48,-.28],[.48,-.28]]);line([[-.35,.27],[.35,.27]]);line([[-.38,-.38],[-.38,.38]]);line([[.38,-.38],[.38,.38]]);}
  else if(symbol==='planter'){box(-.46,-.46,.92,.92);ctx.fillStyle='#d4e2ccbb';oval(0,0,.32,.32);}
  else if(symbol==='crosswalk'||symbol==='speedbump'||symbol==='grate'){box(-.48,-.46,.96,.92);for(let x=-.37;x<=.38;x+=.15)line([[x,-.4],[x,.4]]);}
  else if(symbol==='sign'||symbol==='bus-stop'){box(-.43,-.26,.86,.52);line([[0,.26],[0,.46]]);if(symbol==='bus-stop'){line([[-.21,-.1],[.21,-.1],[.21,.1],[-.21,.1],[-.21,-.1]]);}}
  else if(symbol==='charger'){box(-.38,-.46,.76,.92);line([[.12,-.27],[-.12,.02],[.12,.02],[-.12,.29]]);}
  else if(symbol==='playground'){oval(0,0,.33,.33);line([[-.47,.34],[.47,-.34]]);}
  else if(symbol==='art'){line([[0,-.43],[.36,0],[0,.43],[-.36,0],[0,-.43]]);}
  else{box(-.44,-.4,.88,.8);line([[-.44,-.16],[0,-.35],[.44,-.16]]);line([[-.2,.4],[-.2,.23],[.2,.23],[.2,.4]]);}
  ctx.restore();
}
function centerlineMiddle(points:Point[]):Point{
  const lengths=points.slice(1).map((point,i)=>distance(points[i],point)),half=lengths.reduce((sum,length)=>sum+length,0)/2;let traversed=0;
  for(let i=0;i<lengths.length;i++){if(traversed+lengths[i]>=half){const t=lengths[i]?(half-traversed)/lengths[i]:0;return{x:points[i].x+(points[i+1].x-points[i].x)*t,y:points[i].y+(points[i+1].y-points[i].y)*t};}traversed+=lengths[i];}
  return points[0];
}
export function paintMunicipal(options:DrawOptions):void{
  const {ctx,project,selectedId,toScreen,zoom}=options;
  const labelCandidates:{selected:boolean;x:number;y:number;width:number;title:string;text:string}[]=[];
  const ring=(points:Point[])=>{points.forEach((point,i)=>{const p=toScreen(point);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.closePath();};
  const path=(points:Point[])=>{points.forEach((point,i)=>{const p=toScreen(point);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});};
  const footprint=(parts:SurfacePart[],color:string,selected:boolean,alpha=.38)=>{
    ctx.beginPath();for(const part of parts){ring(part.points);part.holes.forEach(ring);}ctx.fillStyle=color;ctx.globalAlpha=alpha;ctx.fill('evenodd');ctx.globalAlpha=1;
    if(selected){ctx.lineWidth=4;ctx.strokeStyle='#fffffff0';ctx.stroke();}ctx.lineWidth=selected?1.7:1;ctx.strokeStyle=selected?'#276853':color;ctx.stroke();
  };
  ctx.save();
  for(const element of project.municipalElements??[]){
    if(element.hidden)continue;const selected=element.id===selectedId,color=municipalElementPreset(element).color,parts=municipalFootprints(element,project);
    if(parts?.length)footprint(parts,color,selected,['road','bridge','intersection','roundabout'].includes(element.kind)?.72:element.kind==='green'?.28:element.kind==='river'?.66:.4);
    for(const mark of municipalDecorations(element,project)){
      ctx.beginPath();ring(mark.points);ctx.fillStyle=mark.color;ctx.fill();
      if(mark.kind==='island'){ctx.strokeStyle=selected?'#276853':'#738a70';ctx.lineWidth=1;ctx.stroke();}
    }
    if(element.kind==='bridge'){
      for(const sample of municipalBridgeSupports(element,project)){const p=toScreen(sample.point);ctx.beginPath();ctx.arc(p.x,p.y,2.2,0,Math.PI*2);ctx.fillStyle='#536c60';ctx.fill();}
    }
    if(element.kind==='road'&&element.tunnel?.enabled){
      const route=municipalTunnelPlanPath(element,project),scale=municipalScale(project);
      if(route.length>1&&scale){
        ctx.save();ctx.beginPath();path(route);ctx.strokeStyle=selected?'#235f4c':'#62776a';ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.stroke();ctx.setLineDash([]);
        const half=municipalEffectiveWidth(element)/200/scale*zoom;
        for(const [p,q] of [[route[0],route[1]],[route.at(-1),route.at(-2)]]){
          const at=toScreen(p),length=distance(p,q),normal={x:-(q.y-p.y)/length,y:(q.x-p.x)/length};
          ctx.beginPath();ctx.moveTo(at.x-normal.x*half,at.y-normal.y*half);ctx.lineTo(at.x+normal.x*half,at.y+normal.y*half);ctx.lineWidth=3;ctx.strokeStyle='#fff';ctx.stroke();ctx.lineWidth=1.5;ctx.strokeStyle=selected?'#235f4c':'#62776a';ctx.stroke();
        }ctx.restore();
      }
    }
    if(isMunicipalPath(element.kind)){
      if(!['road','bridge'].includes(element.kind)){
      ctx.beginPath();path(element.points);ctx.strokeStyle=selected?'#276853':color;ctx.lineWidth=element.kind==='pipeline'?selected?3.5:2.5:1;
      ctx.setLineDash(element.kind==='river'?[3,7]:[]);ctx.stroke();ctx.setLineDash([]);
      }
      if(element.kind==='fence'){
        const scale=municipalScale(project)??.01;
        for(let i=1;i<element.points.length;i++){
          const a=element.points[i-1],b=element.points[i],length=distance(a,b),count=Math.min(60,Math.max(1,Math.ceil(length*scale/2))),nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length;
          if(!length)continue;for(let n=0;n<=count;n++){const p=toScreen({x:a.x+(b.x-a.x)*n/count,y:a.y+(b.y-a.y)*n/count});ctx.beginPath();ctx.moveTo(p.x-nx*3,p.y-ny*3);ctx.lineTo(p.x+nx*3,p.y+ny*3);ctx.stroke();}
        }
      }
    }else if(!isMunicipalPolygon(element.kind)&&!isMunicipalSurface(element.kind)){
      if(element.kind==='facility')facilitySymbol(ctx,element,project,toScreen,zoom,selected);
      else{
      const p=toScreen(element.points[0]);ctx.beginPath();ctx.arc(p.x,p.y,selected?7:5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=selected?1.7:1.2;ctx.strokeStyle=selected?'#276853':color;ctx.stroke();
      if(element.kind==='streetlight'){ctx.beginPath();ctx.moveTo(p.x,p.y-3);ctx.lineTo(p.x,p.y+3);ctx.moveTo(p.x-3,p.y);ctx.lineTo(p.x+3,p.y);ctx.stroke();}
      if(element.kind==='trafficlight'){
        ctx.save();ctx.translate(p.x,p.y);ctx.rotate((element.trafficSignal?.rotation??0)*Math.PI/180);ctx.beginPath();ctx.roundRect(-5,-12,10,24,3);ctx.fillStyle='#36443b';ctx.fill();
        for(const [index,phase]of ['red','amber','green'].entries()){ctx.beginPath();ctx.arc(0,-7+index*7,2.3,0,Math.PI*2);ctx.fillStyle=phase===(element.trafficSignal?.phase??'red')?phase==='red'?'#d96b62':phase==='amber'?'#ddb85e':'#68b18c':'#647469';ctx.fill();}ctx.restore();
      }
      }
    }
    if(selected&&element.holes?.length){const raw=rawMunicipalFootprints(element,project);if(raw){ctx.beginPath();raw.forEach(part=>{ring(part.points);part.holes.forEach(ring);});ctx.strokeStyle='#67927b';ctx.lineWidth=1;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);}}
    if(selected&&!element.locked){for(const point of element.points){const p=toScreen(point);ctx.beginPath();ctx.arc(p.x,p.y,4.5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#276853';ctx.lineWidth=1.5;ctx.stroke();}}
    if(project.view.labels||selected){
      const metrics=municipalMetrics(element,project);let labelPoint:Point;
      if(isMunicipalPath(element.kind))labelPoint=centerlineMiddle(element.points);
      else if(isMunicipalPolygon(element.kind))labelPoint=parts?.length?regionInteriorPoint(parts[0])??element.points[0]:element.points[0];
      else labelPoint=element.points[0];
      const p=toScreen(labelPoint),isPoint=!isMunicipalPath(element.kind)&&!isMunicipalPolygon(element.kind)&&!isMunicipalSurface(element.kind),y=p.y+(isPoint?35:isMunicipalPath(element.kind)?-Math.max(28,municipalEffectiveWidth(element)*.01/(municipalScale(project)??.01)*zoom/2+28):0),value=isMunicipalPath(element.kind)?metrics.length:metrics.area;
      const text=isPoint?'1 处':value==null?'待校准':`${value.toFixed(2)} ${isMunicipalPath(element.kind)?'m':'m²'}`;
      let title=element.name.length>18?element.name.slice(0,17)+'…':element.name;if(element.tunnel?.enabled)title+=' · 隧道';if(element.locked)title+=' · 已锁定';
      ctx.font='500 11px "Segoe UI", "Microsoft YaHei UI", sans-serif';const width=Math.max(ctx.measureText(title).width,ctx.measureText(text).width)+20;
      const vertices=(parts??[]).flatMap(part=>part.points),span=vertices.length?Math.max(Math.max(...vertices.map(v=>v.x))-Math.min(...vertices.map(v=>v.x)),Math.max(...vertices.map(v=>v.y))-Math.min(...vertices.map(v=>v.y)))*zoom:0;
      if(selected||(isPoint?zoom/(municipalScale(project)??.01)>=20:span>=width*1.5))labelCandidates.push({selected,x:p.x,y,width,title,text});
    }
  }
  const occupied:{x:number;y:number;width:number}[]=[];
  for(const label of labelCandidates.sort((a,b)=>Number(b.selected)-Number(a.selected))){
    if(!label.selected&&occupied.some(other=>Math.abs(other.x-label.x)<(other.width+label.width)/2+8&&Math.abs(other.y-label.y)<47))continue;
    occupied.push(label);ctx.font='500 11px "Segoe UI", "Microsoft YaHei UI", sans-serif';ctx.beginPath();ctx.roundRect(label.x-label.width/2,label.y-19,label.width,39,5);ctx.fillStyle='#fffffff0';ctx.fill();ctx.textAlign='center';ctx.fillStyle=label.selected?'#235c49':'#36443d';ctx.fillText(label.title,label.x,label.y-4);
    ctx.font='10px "Segoe UI", sans-serif';ctx.fillStyle='#78867b';ctx.fillText(label.text,label.x,label.y+10);ctx.textAlign='left';
  }
  if(options.drawing&&options.kind){
    const points=options.cursor?[...options.draft,options.cursor]:options.draft,kind=options.kind;
    if(points.length>=(isMunicipalPolygon(kind)?3:isMunicipalPath(kind)?2:1))try{
      const preview=municipalDrawingPreview(kind,points,project,options.settings),parts=rawMunicipalFootprints(preview,project);if(parts?.length){ctx.setLineDash([5,4]);footprint(parts,'#276853',false,.1);ctx.setLineDash([]);}
      for(const mark of municipalDecorations(preview,project)){ctx.beginPath();ring(mark.points);ctx.globalAlpha=.7;ctx.fillStyle=mark.color;ctx.fill();ctx.globalAlpha=1;}
      if(kind==='facility')facilitySymbol(ctx,preview,project,toScreen,zoom,true);
    }catch{}
    if(points.length){ctx.beginPath();path(points);if(isMunicipalPolygon(kind)&&points.length>=3)ctx.closePath();ctx.lineWidth=1.5;ctx.strokeStyle='#276853';ctx.setLineDash([5,4]);ctx.stroke();ctx.setLineDash([]);}
    for(const [index,point]of options.draft.entries()){const p=toScreen(point);ctx.beginPath();ctx.arc(p.x,p.y,index?3.5:5,0,Math.PI*2);ctx.fillStyle=index?'#fff':'#276853';ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#276853';ctx.stroke();}
  }
  const port=options.connection?.port??(options.drawing?options.anchorPort:null);
  if(port){
    const p=toScreen(port.point),scale=municipalScale(project)??.01,half=Math.min(120,port.widthCm*.01/scale*zoom/2),normal={x:-port.direction.y,y:port.direction.x};
    ctx.beginPath();ctx.moveTo(p.x-normal.x*half,p.y-normal.y*half);ctx.lineTo(p.x+normal.x*half,p.y+normal.y*half);ctx.lineWidth=2;ctx.strokeStyle='#2e6954';ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();
    const layout=options.settings?.roadLayout,width=layout?layout.lanes*layout.laneWidth+layout.medianWidth:options.settings?.width;
    let label=`对齐 ${port.targetName}`;
    if(width!==undefined&&['road','bridge'].includes(options.kind)&&Math.abs(width-port.widthCm)>.1)label+=` · 目标 ${(port.widthCm/100).toFixed(2)} m / 本段 ${(width/100).toFixed(2)} m`;
    ctx.font='10px "Segoe UI","Microsoft YaHei UI",sans-serif';ctx.fillStyle='#2e6954';ctx.textAlign='left';ctx.fillText(label.slice(0,70),p.x+9,p.y-11);
  }
  ctx.restore();
}
