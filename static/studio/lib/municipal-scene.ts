import type { Project } from '../types.js';
import type { SceneFloor } from './scene-model.js';
import type { SolidSurface } from './wall-solid.js';
import type { Vec3 } from './camera3d.js';
import { municipalEffectiveWidth, isMunicipalLayered, municipalFootprints, municipalMetrics, municipalElementPreset, municipalScale, validateMunicipalElements, type MunicipalElement, type MunicipalKind } from './municipal-design.js';
import { municipalFacilityPlanSymbol } from './municipal-catalog.js';
import { roadDesignTriangles, roadElevationAtPlanPoint, roadControlStations, roadPointAtStation, roadProfileElevation, roadSideSlopeDesign } from './road-profile.js';
import { municipalDecorations, municipalBridgeSupports, municipalBridgeRailPaths } from './municipal-decoration.js';
import { buildTunnelGeometry } from './tunnel-scene.js';
import type { RoadTunnelAnalysis } from './road-tunnel.js';

export type SceneMunicipalElement={id:string;name:string;kind:MunicipalKind;color:string;diameter:number;horizontal:SceneFloor[];surfaces:SolidSurface[];points:Vec3[];segments:{start:Vec3;end:Vec3;length:number}[];netArea:number|null;length:number|null;volume:number|null;tunnel?:RoadTunnelAnalysis};
const subtract=(a:Vec3,b:Vec3):Vec3=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const cross=(a:Vec3,b:Vec3):Vec3=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const normalize=(v:Vec3):Vec3=>{const length=Math.hypot(v.x,v.y,v.z);return{x:v.x/length,y:v.y/length,z:v.z/length};};

function cylinder(surfaces:SolidSurface[],id:string,start:Vec3,end:Vec3,diameter:number,color:string):void{
  const direction=subtract(end,start),length=Math.hypot(direction.x,direction.y,direction.z);if(length<1e-9||diameter<=0)return;
  const axis=normalize(direction),u=normalize(cross(axis,Math.abs(axis.y)<.9?{x:0,y:1,z:0}:{x:1,y:0,z:0})),v=cross(axis,u),sides=16;
  const ring=(center:Vec3)=>Array.from({length:sides},(_,i)=>{const angle=i/sides*Math.PI*2,r=diameter/2;return{x:center.x+r*(u.x*Math.cos(angle)+v.x*Math.sin(angle)),y:center.y+r*(u.y*Math.cos(angle)+v.y*Math.sin(angle)),z:center.z+r*(u.z*Math.cos(angle)+v.z*Math.sin(angle))};});
  const first=ring(start),last=ring(end),surface=(suffix:string,points:Vec3[],normal:Vec3)=>surfaces.push({id:`${id}:${suffix}`,wallId:id,sourceIds:[],side:'end',points,normal,color});
  for(let i=0;i<sides;i++){const next=(i+1)%sides,angle=(i+.5)/sides*Math.PI*2;surface(`side:${i}`,[first[i],first[next],last[next],last[i]],{x:u.x*Math.cos(angle)+v.x*Math.sin(angle),y:u.y*Math.cos(angle)+v.y*Math.sin(angle),z:u.z*Math.cos(angle)+v.z*Math.sin(angle)});}
  surface('start',[...first].reverse(),{x:-axis.x,y:-axis.y,z:-axis.z});surface('end',last,axis);
}

function cuboid(surfaces:SolidSurface[],owner:string,id:string,center:Vec3,width:number,height:number,depth:number,color:string,rotation=0):void{
  const u={x:Math.cos(rotation),z:Math.sin(rotation)},v={x:-u.z,z:u.x};
  const point=(x:number,y:number,z:number):Vec3=>({x:center.x+u.x*x*width/2+v.x*z*depth/2,y:center.y+y*height/2,z:center.z+u.z*x*width/2+v.z*z*depth/2});
  const faces=[[[1,-1,-1],[1,-1,1],[1,1,1],[1,1,-1]],[[-1,-1,1],[-1,-1,-1],[-1,1,-1],[-1,1,1]],[[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]],[[1,-1,-1],[-1,-1,-1],[-1,-1,1],[1,-1,1]],[[-1,-1,1],[-1,1,1],[1,1,1],[1,-1,1]],[[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,-1]]];
  for(const [index,face]of faces.entries()){const points=face.map(([x,y,z])=>point(x,y,z)),normal=normalize(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));surfaces.push({id:`${id}:${index}`,wallId:owner,sourceIds:[],side:'end',points,normal,color});}
}

/** Original parametric street assets. All components stay within the user's
 * physical width/depth/height and rotate around the stored plan anchor. */
function facilityFurniture(element:MunicipalElement,surfaces:SolidSurface[],anchor:Vec3):void{
  const owner=`municipal:${element.id}`,w=element.width/100,d=element.depth/100,h=element.height/100,angle=(element.rotation??0)*Math.PI/180;
  const color=municipalElementPreset(element).color,metal='#73887e',dark='#52675b',light='#c6cebe',glass='#a9c0ba';
  const at=(x:number,y:number,z:number):Vec3=>({x:anchor.x+Math.cos(angle)*x*w-Math.sin(angle)*z*d,y:anchor.y+y*h,z:anchor.z+Math.sin(angle)*x*w+Math.cos(angle)*z*d});
  const box=(id:string,x:number,y:number,z:number,bw:number,bh:number,bd:number,tint=color)=>cuboid(surfaces,owner,`${owner}:${id}`,at(x,y,z),bw*w,bh*h,bd*d,tint,angle);
  const tube=(id:string,a:Vec3,b:Vec3,diameter:number,tint=metal)=>{const before=surfaces.length;cylinder(surfaces,`${owner}:${id}`,a,b,diameter,tint);for(let i=before;i<surfaces.length;i++)surfaces[i].wallId=owner;};
  const ellipsoid=(id:string,x:number,y:number,z:number,rw:number,rh:number,rd:number,tint=color)=>{
    const center=at(x,y,z),rings=Array.from({length:13},(_,j)=>{const latitude=-Math.PI/2+j*Math.PI/12;
      if(j===0||j===12)return[at(x,y+(j===0?-rh:rh),z)];
      return Array.from({length:24},(_,i)=>{const longitude=i*Math.PI/12;return at(x+rw*Math.cos(latitude)*Math.cos(longitude),y+rh*Math.sin(latitude),z+rd*Math.cos(latitude)*Math.sin(longitude));});});
    let index=0;
    for(let j=0;j<12;j++)for(let i=0;i<24;i++){
      const a=rings[j],b=rings[j+1],points=a.length===1?[a[0],b[(i+1)%24],b[i]]:b.length===1?[a[i],a[(i+1)%24],b[0]]:[a[i],a[(i+1)%24],b[(i+1)%24],b[i]];
      let normal=normalize(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));
      const radial=subtract(points.find(p=>Math.hypot(p.x-center.x,p.z-center.z)>1e-8)??points[0],center);
      if(normal.x*radial.x+normal.y*radial.y+normal.z*radial.z<0){points.reverse();normal={x:-normal.x,y:-normal.y,z:-normal.z};}
      surfaces.push({id:`${owner}:${id}:${index++}`,wallId:owner,sourceIds:[],side:'end',points,normal,color:tint});
    }
  };
  const symbol=municipalFacilityPlanSymbol(element);
  if(symbol==='bench'){
    box('seat',0,.45,0,1,.1,.85,color);box('back',0,.76,.39,1,.48,.1,color);
    for(const x of [-.35,.35])for(const z of [-.3,.3])box(`leg:${x}:${z}`,x,.2,z,.08,.4,.08,metal);
    for(const x of [-.45,.45])box(`arm:${x}`,x,.62,0,.1,.06,.85,metal);
  }else if(symbol==='bin'||symbol==='recycling'){
    const centers=symbol==='recycling'?[-.34,0,.34]:[0],bw=symbol==='recycling'?.28:.9;
    for(const [i,x]of centers.entries()){
      box(`bin:${i}`,x,.43,0,bw,.86,.88,[color,'#7f9d90','#a9a782'][i]??color);
      box(`lid:${i}`,x,.89,0,bw,.08,.92,metal);box(`slot:${i}`,x,.73,-.45,bw*.6,.1,.02,dark);
    }
    if(symbol==='recycling'){box('cover',0,.965,0,1,.07,1,color);for(const x of [-.47,.47])box(`support:${x}`,x,.465,.44,.06,.93,.08,metal);}
    else box('top',0,.975,0,1,.05,1,color);
  }else if(symbol==='shelter'){
    box('roof',0,.96,0,1,.08,1,color);box('rear-glass',0,.47,.4,.94,.84,.025,glass);
    for(const x of [-.45,0,.45])box(`post:${x}`,x,.46,.4,.035,.92,.035,metal);
    for(const x of [-.45,.45])box(`side:${x}`,x,.47,0,.025,.84,.8,glass);
    box('seat',0,.2,.14,.7,.04,.26,'#a49980');for(const x of [-.26,.26])box(`seat-leg:${x}`,x,.09,.14,.025,.18,.08,metal);
  }else if(symbol==='bus-stop'||symbol==='sign'){
    tube('post',at(0,0,0),at(0,1,0),Math.min(w,d)*.22,metal);
    box('panel',0,.78,0,1,.44,.35,color);box('face',0,.78,-.19,.9,.36,.02,light);
    if(symbol==='bus-stop')box('route-panel',0,.36,0,.65,.36,.35,glass);
  }else if(symbol==='bollard'){
    tube('bollard',at(0,0,0),at(0,.92,0),Math.min(w,d),metal);
    ellipsoid('cap',0,.92,0,.5,.08,.5,color);
    box('reflector',0,.73,-.47,.55,.06,.025,'#d0c69b');
  }else if(symbol==='hydrant'){
    tube('body',at(0,0,0),at(0,.82,0),Math.min(w,d)*.55,color);
    tube('outlets',at(-.42,.62,0),at(.42,.62,0),Math.min(w,d)*.3,color);
    ellipsoid('cap',0,.88,0,.28,.12,.35,color);box('base',0,.055,0,1,.11,1,color);
  }else if(symbol==='charger'||symbol==='cabinet'||symbol==='transformer'){
    box('body',0,.5,0,.94,.92,.94,color);box('plinth',0,.035,0,1,.07,1,metal);box('top',0,.975,0,1,.05,1,metal);
    box('door',0,.45,-.479,.81,.69,.01,light);
    if(symbol==='charger'){box('screen',0,.74,-.49,.55,.16,.018,dark);box('connector',.35,.46,-.49,.13,.12,.018,metal);}
    if(symbol==='transformer')for(const x of [-.3,0,.3])box(`vent:${x}`,x,.54,-.49,.09,.45,.018,metal);
  }else if(symbol==='parking'||symbol==='crosswalk'||symbol==='speedbump'||symbol==='grate'){
    if(symbol==='parking'){
      box('left-line',-.48,.5,0,.04,1,1,light);box('right-line',.48,.5,0,.04,1,1,light);box('back-line',0,.5,.48,1,1,.04,light);
      if(element.catalogId==='accessible-parking'){box('access-marker',0,.5,0,.4,1,.35,'#84aea0');}
    }else if(symbol==='crosswalk')for(let i=0;i<9;i++)box(`stripe:${i}`,0,.5,-.44+i*.11,1,1,.055,light);
    else if(symbol==='speedbump'){box('bump',0,.5,0,1,1,.84,color);for(let i=0;i<7;i++)box(`band:${i}`,-.43+i*.143,.94,0,.065,.12,.9,dark);}
    else{box('grate-frame',0,.5,0,1,1,1,metal);for(let i=0;i<7;i++)box(`grate-slot:${i}`,-.42+i*.14,.96,0,.07,.08,.8,dark);}
  }else if(symbol==='bicycle'){
    for(const x of [-.4,-.13,.13,.4]){
      tube(`left:${x}`,at(x,0,-.37),at(x,.9,-.37),Math.min(w,d)*.07);
      tube(`top:${x}`,at(x,.9,-.37),at(x,.9,.37),Math.min(w,d)*.07);
      tube(`right:${x}`,at(x,.9,.37),at(x,0,.37),Math.min(w,d)*.07);
    }
    box('base',0,.02,0,1,.04,1,metal);
  }else if(symbol==='tree'){
    tube('trunk',at(0,0,0),at(0,.64,0),Math.min(w,d)*.08,'#a29176');
    ellipsoid('canopy',0,.73,0,.5,.27,.5,color);
  }else if(symbol==='planter'){
    box('container',0,.32,0,1,.64,1,color);box('soil',0,.65,0,.9,.02,.9,'#9d947c');
    for(const x of [-.31,0,.31])ellipsoid(`plant:${x}`,x,.83,0,.17,.17,.42,'#8ba47d');
  }else if(symbol==='building'){
    box('body',0,.44,0,1,.88,1,color);box('roof',0,.94,0,1,.12,1,metal);
    box('door',.19,.32,-.494,.2,.62,.012,dark);box('window',-.2,.58,-.494,.35,.32,.012,glass);
    if(element.catalogId==='public-toilet')box('name-panel',0,.78,-.493,.65,.12,.014,light);
  }else if(symbol==='ramp'){
    const ring=[at(-.5,0,-.5),at(.5,0,-.5),at(.5,1,.5),at(-.5,1,.5)],base=[at(-.5,0,-.5),at(.5,0,-.5),at(.5,0,.5),at(-.5,0,.5)];
    const emit=(id:string,points:Vec3[])=>{const normal=normalize(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));if(Number.isFinite(normal.x))surfaces.push({id:`${owner}:${id}`,wallId:owner,sourceIds:[],side:'end',points,normal,color});};
    emit('ramp-top',[...ring].reverse());emit('ramp-bottom',base);emit('ramp-left',[base[0],base[3],ring[3]]);emit('ramp-right',[base[1],ring[2],base[2]]);emit('ramp-back',[base[3],base[2],ring[2],ring[3]]);
  }else if(symbol==='playground'){
    box('platform',-.2,.38,0,.38,.06,.6,color);for(const x of [-.36,-.04])for(const z of [-.26,.26])box(`post:${x}:${z}`,x,.44,z,.05,.88,.05,metal);
    box('roof',-.2,.96,0,.6,.08,.8,color);box('ladder',-.43,.2,0,.08,.4,.7,metal);
    const slide=[at(-.01,.4,-.2),at(.49,.02,-.2),at(.49,.02,.2),at(-.01,.4,.2)];
    const normal=normalize(cross(subtract(slide[1],slide[0]),subtract(slide[2],slide[0])));surfaces.push({id:`${owner}:slide`,wallId:owner,sourceIds:[],side:'end',points:slide,normal,color:'#bdb080'});
  }else if(symbol==='fountain'){
    ellipsoid('basin',0,.13,0,.5,.13,.5,color);ellipsoid('water',0,.26,0,.44,.012,.44,'#a0bdb4');
    tube('pedestal',at(0,.22,0),at(0,.7,0),Math.min(w,d)*.12,color);tube('jet',at(0,.7,0),at(0,1,0),Math.min(w,d)*.024,'#b6ccc7');
  }else if(symbol==='art'){
    box('plinth',0,.08,0,1,.16,1,metal);ellipsoid('sculpture',0,.56,0,.28,.44,.28,color);
  }else box('body',0,.5,0,1,1,1,color);
}

function fenceFurniture(element:MunicipalElement,surfaces:SolidSurface[],points:Vec3[]):void{
  const owner=`municipal:${element.id}`,height=element.height/100,diameter=element.width/100,color=municipalElementPreset(element).color,before=surfaces.length,railDiameter=Math.min(diameter*.7,height*.3);
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.z-a.z),count=Math.min(100,Math.max(1,Math.ceil(length/2)));
    const at=(t:number,y:number):Vec3=>({x:a.x+(b.x-a.x)*t,y:a.y+y,z:a.z+(b.z-a.z)*t});
    const postDiameter=Math.min(diameter,length),inset=Math.min(postDiameter/2,length/2);
    for(let j=0;j<=count;j++){const t=(inset+j/count*(length-2*inset))/length;cylinder(surfaces,`${owner}:post:${i}:${j}`,at(t,0),at(t,height),postDiameter,color);}
    for(const ratio of [.4,.8,.98]){const railHeight=Math.max(railDiameter/2,Math.min(height-railDiameter/2,height*ratio));cylinder(surfaces,`${owner}:rail:${i}:${ratio}`,at(0,railHeight),at(1,railHeight),railDiameter,color);}
    if(element.catalogId==='site-fence')for(let j=0;j<count*3;j++)cylinder(surfaces,`${owner}:picket:${i}:${j}`,at((j+.5)/(count*3),0),at((j+.5)/(count*3),height*.94),Math.min(diameter*.35,length/(count*3)),color);
  }
  for(let i=before;i<surfaces.length;i++)surfaces[i].wallId=owner;
}

function bridgeFurniture(project:Project,element:MunicipalElement,surfaces:SolidSurface[],scale:number):void{
  const owner=`municipal:${element.id}`,top=element.elevation/100,bottom=top-element.height/100,width=municipalEffectiveWidth(element)/100,options=element.bridgeOptions??{pierSpacing:1000,pierHeight:400,railingHeight:110};
  const before=surfaces.length,piers=municipalBridgeSupports(element,project),diameter=Math.min(1.2,Math.max(.35,width*.08)),height=options.pierHeight/100;
  for(const [i,sample]of piers.entries()){
    const p={x:sample.point.x*scale,y:bottom,z:sample.point.y*scale},u=sample.direction,angle=Math.atan2(u.y,u.x);
    for(const side of [-1,1]){const column={x:p.x-u.y*width*.3*side,y:bottom-height,z:p.z+u.x*width*.3*side};cylinder(surfaces,`${owner}:pier:${i}:${side}`,column,{...column,y:bottom-.15},diameter,'#aeb5ad');cuboid(surfaces,owner,`${owner}:footing:${i}:${side}`,{...column,y:column.y-.18},diameter*1.8,.36,diameter*1.8,'#b9beb4',angle);}
    cuboid(surfaces,owner,`${owner}:pier-cap:${i}`,{...p,y:bottom-.18},.65,.36,width*.85,'#bdc3ba',angle);
  }
  const railing=options.railingHeight/100;
  for(const [side,path]of municipalBridgeRailPaths(element,project).entries())for(let i=1;i<path.length;i++){
    const a=path[i-1],b=path[i],length=Math.hypot(b.x-a.x,b.y-a.y)*scale;if(length<1e-8)continue;
    const posts=Math.min(80,Math.max(1,Math.ceil(length/2)));
      const at=(t:number,y:number):Vec3=>({x:(a.x+(b.x-a.x)*t)*scale,y,z:(a.y+(b.y-a.y)*t)*scale});
      for(const height of [railing,railing*.5])cylinder(surfaces,`${owner}:rail:${i}:${side}:${height}`,at(0,top+height),at(1,top+height),.07,'#657a72');
      for(let post=0;post<=posts;post++)cylinder(surfaces,`${owner}:rail-post:${i}:${side}:${post}`,at(post/posts,top),at(post/posts,top+railing),.07,'#6f8078');
  }
  for(let i=before;i<surfaces.length;i++)surfaces[i].wallId=owner;
}

function signalFurniture(element:MunicipalElement,surfaces:SolidSurface[],p:Vec3):void{
  const owner=`municipal:${element.id}`,height=element.height/100,rotation=(element.trafficSignal?.rotation??0)*Math.PI/180,front={x:Math.sin(rotation),y:0,z:-Math.cos(rotation)},before=surfaces.length;
  cylinder(surfaces,`${owner}:signal-pole`,p,{...p,y:p.y+height-.75},Math.min(.16,element.width/100),'#68796f');
  const center={...p,y:p.y+height-.45};cuboid(surfaces,owner,`${owner}:signal-housing`,center,.38,.9,.24,'#36433e',rotation);
  const phase=element.trafficSignal?.phase??'red';
  for(const [index,state]of ['red','amber','green'].entries()){
    const light={x:center.x+front.x*.13,y:center.y+.27-index*.27,z:center.z+front.z*.13},end={x:light.x+front.x*.03,y:light.y,z:light.z+front.z*.03};
    const color=state===phase?state==='red'?'#d96b62':state==='amber'?'#ddb85e':'#68b18c':'#4e5c52';
    cylinder(surfaces,`${owner}:signal-lens:${state}`,light,end,.19,color);
  }
  for(let i=before;i<surfaces.length;i++)surfaces[i].wallId=owner;
}

function roadDecorationSurfaces(project:Project,element:MunicipalElement,surfaces:SolidSurface[],horizontal:SceneFloor[],scale:number):void{
  if(element.kind==='road'&&!element.roadLayout)return;
  for(const mark of municipalDecorations(element,project)){
    const owner=`municipal:${element.id}`,at=(p:{x:number;y:number}):Vec3=>({x:p.x*scale,y:(element.kind==='road'&&element.roadProfile?.enabled?roadElevationAtPlanPoint(project,element,p):element.elevation/100)+mark.lift,z:p.y*scale});
    const points=mark.points.map(at);
    if(mark.kind==='island'){horizontal.push({id:`municipal:${mark.id}`,name:element.name,regionId:element.id,points,holes:[],normalY:1,color:mark.color,surfaceType:'civil'});continue;}
    let normal=normalize(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));if(![normal.x,normal.y,normal.z].every(Number.isFinite))continue;
    if(normal.y<0){points.reverse();normal={x:-normal.x,y:-normal.y,z:-normal.z};}
    surfaces.push({id:`municipal:${mark.id}`,wallId:owner,sourceIds:[],side:'end',points,normal,color:mark.color});
  }
}

function slopedRoad(project:Project,element:MunicipalElement,surfaces:SolidSurface[],color:string):void{
  const triangles=roadDesignTriangles(project,element);
  const edges=new Map<string,{a:Vec3;b:Vec3;count:number}>();
  const key=(p:Vec3)=>[p.x,p.y,p.z].map(v=>Math.round(v*1e8)).join(',');
  const topTriangles=triangles.map(triangle=>triangle.map(p=>({x:p.x,y:p.z,z:p.y})));
  for(const points of topTriangles)for(let i=0;i<3;i++){
    const a=points[i],b=points[(i+1)%3],k=[key(a),key(b)].sort().join('|'),old=edges.get(k);
    if(old)old.count++;else edges.set(k,{a,b,count:1});
  }
  const add=(id:string,points:Vec3[],up?:boolean)=>{
    let normal=normalize(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));
    if(up!==undefined&&((normal.y>0)!==up)){points.reverse();normal={x:-normal.x,y:-normal.y,z:-normal.z};}
    surfaces.push({id,wallId:`municipal:${element.id}`,sourceIds:[],side:'end',points,normal,color});
  };
  let offset=0;
  const layers=[{thickness:element.height,color},...(element.items??[]).map((layer,i)=>({thickness:layer.thickness,color:i%2?'#c6c2b6':'#b0bab1'}))];
  for(const [layerIndex,layer]of layers.entries()){
    const thickness=layer.thickness/100,base=`municipal:${element.id}:profile:${layerIndex}`;
    const before=surfaces.length;
    for(const [index,triangle]of topTriangles.entries()){
      add(`${base}:top:${index}`,triangle.map(p=>({...p,y:p.y-offset})),true);
      add(`${base}:bottom:${index}`,triangle.map(p=>({...p,y:p.y-offset-thickness})),false);
    }
    for(const [edgeIndex,edge]of [...edges.values()].filter(edge=>edge.count===1).entries())
      add(`${base}:edge:${edgeIndex}`,[{...edge.a,y:edge.a.y-offset-thickness},{...edge.b,y:edge.b.y-offset-thickness},{...edge.b,y:edge.b.y-offset},{...edge.a,y:edge.a.y-offset}]);
    for(let i=before;i<surfaces.length;i++)surfaces[i].color=layer.color;
    offset+=thickness;
  }
  for(const [index,triangle]of roadSideSlopeDesign(project,element).triangles.entries()){
    const points=triangle.map(point=>({x:point.x,y:point.z,z:point.y}));
    add(`municipal:${element.id}:slope:${index}`,points,true);
    surfaces[surfaces.length-1].color='#b8ad94';
  }
}

/** Metres in the scene: XY plan coordinates map to XZ, centimetre elevation
 * maps to Y. Net paved footprints are exactly those used by the pricing engine.
 * Municipal work belongs to the site once, regardless of building storeys. */
export function buildSceneMunicipal(project:Project):SceneMunicipalElement[]{
  validateMunicipalElements(project.municipalElements??[],project);
  const scale=municipalScale(project);if(!scale)return[];
  return(project.municipalElements??[]).filter(element=>!element.hidden).map(element=>{
    // Asphalt stays distinct from muted terrain and light tunnel lining.
    const color=element.kind==='road'?'#596562':municipalElementPreset(element).color,metrics=municipalMetrics(element,project),horizontal:SceneFloor[]=[],surfaces:SolidSurface[]=[],segments:SceneMunicipalElement['segments']=[];
    const elevation=element.elevation/100,points=element.points.map(point=>({x:point.x*scale,y:(point.z??element.elevation)/100,z:point.y*scale}));
    if(element.kind==='road'&&element.roadProfile?.enabled)for(const [i,point]of element.points.entries())points[i].y=roadElevationAtPlanPoint(project,element,point);
    const extrude=(top:number,bottom:number,layerColor:string,suffix:string)=>{
      for(const [partIndex,part]of(municipalFootprints(element,project)??[]).entries()){
        const at=(ring:{x:number;y:number}[],y:number)=>ring.map(point=>({x:point.x*scale,y,z:point.y*scale})),base=`municipal:${element.id}:${suffix}:${partIndex}`;
        horizontal.push({id:`${base}:top`,name:element.name,regionId:element.id,points:at(part.points,top),holes:part.holes.map(hole=>at(hole,top)),normalY:1,color:layerColor,surfaceType:'civil'});
        if(Math.abs(top-bottom)<1e-9)continue;
        horizontal.push({id:`${base}:bottom`,name:element.name,regionId:element.id,points:at(part.points,bottom),holes:part.holes.map(hole=>at(hole,bottom)),normalY:-1,color:layerColor,surfaceType:'civil'});
        for(const [ringIndex,ring]of[part.points,...part.holes].entries()){
          const signed=ring.reduce((sum,p,i)=>{const next=ring[(i+1)%ring.length];return sum+p.x*next.y-next.x*p.y;},0),sign=(signed>=0?1:-1)*(ringIndex?-1:1);
          for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],dx=(b.x-a.x)*scale,dz=(b.y-a.y)*scale,length=Math.hypot(dx,dz);if(length<1e-9)continue;
            surfaces.push({id:`${base}:side:${ringIndex}:${i}`,wallId:`municipal:${element.id}`,sourceIds:[],side:'end',color:layerColor,normal:{x:sign*dz/length,y:0,z:-sign*dx/length},points:[{x:a.x*scale,y:bottom,z:a.y*scale},{x:b.x*scale,y:bottom,z:b.y*scale},{x:b.x*scale,y:top,z:b.y*scale},{x:a.x*scale,y:top,z:a.y*scale}]});}
        }
      }
    };
    if(element.kind==='facility')facilityFurniture(element,surfaces,points[0]);
    else if(element.kind==='fence'){
      fenceFurniture(element,surfaces,points);
      for(let i=1;i<points.length;i++)segments.push({start:points[i-1],end:points[i],length:Math.hypot(points[i].x-points[i-1].x,points[i].z-points[i-1].z)});
    }else if(element.kind==='road'&&element.roadProfile?.enabled){
      slopedRoad(project,element,surfaces,color);
      const alignment=roadControlStations(project,element).map(station=>{const point=roadPointAtStation(project,element,station);return{x:point.x,y:roadProfileElevation(element.roadProfile,station),z:point.y};});
      for(let i=1;i<alignment.length;i++)segments.push({start:alignment[i-1],end:alignment[i],length:Math.hypot(alignment[i].x-alignment[i-1].x,alignment[i].y-alignment[i-1].y,alignment[i].z-alignment[i-1].z)});
    }else if(element.kind==='pipeline'){
      for(let i=1;i<points.length;i++){const start=points[i-1],end=points[i],length=Math.hypot(end.x-start.x,end.y-start.y,end.z-start.z);segments.push({start,end,length});cylinder(surfaces,`municipal:${element.id}:pipe:${i}`,start,end,element.width/100,color);}
    }else if(element.kind==='trafficlight'){
      signalFurniture(element,surfaces,points[0]);segments.push({start:points[0],end:{...points[0],y:points[0].y+element.height/100},length:element.height/100});
    }else if(element.kind==='streetlight'){
      const p=points[0],height=element.height/100,diameter=Math.min(element.width,element.depth)/100,cap=Math.min(.12,height*.08);
      cylinder(surfaces,`municipal:${element.id}:pole`,p,{...p,y:p.y+height-cap},diameter,color);
      cylinder(surfaces,`municipal:${element.id}:light`,{...p,y:p.y+height-cap},{...p,y:p.y+height},diameter,'#e9e5d7');
      segments.push({start:p,end:{...p,y:p.y+height},length:height});
    }else if(element.kind==='manhole')extrude(elevation+element.height/100,elevation,color,'well');
    else if(element.kind==='kerb')extrude(elevation+element.height/100,elevation,color,'kerb');
    else if(element.kind==='river'){
      extrude(elevation,elevation-element.depth/100,color,'surface');
      for(const surface of surfaces)surface.color='#a4b39d';
      const width=municipalEffectiveWidth(element)/100;
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.z-a.z);if(length<1e-8)continue;
        const nx=-(b.z-a.z)/length,nz=(b.x-a.x)/length;
        for(const side of [-1,1]){const p=(v:Vec3,offset:number,y:number)=>({x:v.x+nx*side*offset,y,z:v.z+nz*side*offset}),ring=[p(a,width/2,elevation),p(b,width/2,elevation),p(b,width/2+.6,elevation+element.height/100),p(a,width/2+.6,elevation+element.height/100)];let normal=normalize(cross(subtract(ring[1],ring[0]),subtract(ring[2],ring[0])));if(normal.y<0){ring.reverse();normal={x:-normal.x,y:-normal.y,z:-normal.z};}surfaces.push({id:`municipal:${element.id}:bank:${i}:${side}`,wallId:`municipal:${element.id}`,sourceIds:[],side:'end',points:ring,normal,color:'#aab69a'});}
      }
    }else{
      let top=elevation;extrude(top,top-element.height/100,color,'surface');top-=element.height/100;
      if(isMunicipalLayered(element.kind))for(const [index,layer]of(element.items??[]).entries()){const bottom=top-layer.thickness/100;extrude(top,bottom,index%2?'#c6c2b6':'#b0bab1',`layer:${index}`);top=bottom;}
    }
    if(element.kind==='bridge')bridgeFurniture(project,element,surfaces,scale);
    if(['road','bridge','intersection','roundabout'].includes(element.kind))roadDecorationSurfaces(project,element,surfaces,horizontal,scale);
    const tunnel=element.kind==='road'&&element.tunnel?.enabled?buildTunnelGeometry(project,element):null;
    if(tunnel)surfaces.push(...tunnel.surfaces);
    return{id:element.id,name:element.name,kind:element.kind,color,diameter:element.kind==='pipeline'?element.width/100:element.kind==='streetlight'?Math.min(element.width,element.depth)/100:0,horizontal,surfaces,points,segments,netArea:metrics.area,length:metrics.length,volume:metrics.volume,...(tunnel?{tunnel:tunnel.analysis}:{})};
  });
}
