import type { Project, Point, MunicipalElement, SurfacePart } from '../types.js';
import { municipalScale, municipalFootprints } from './municipal-design.js';
import { normalizeDecimal, multiplyDecimal, addDecimal, formatMoney, formatQuantity } from './pricing.js';
import { calculateTerrainEarthworks, terrainElevation, triangulateTerrain } from './terrain.js';
import type { TerrainTriangle, TerrainModel } from './terrain.js';
import { calculateEarthworkBalance, validateEarthworkBalance, type RoadEarthworkBalance } from './earthwork-balance.js';
import { excludeTunnelEarthworkTriangles } from './road-tunnel.js';

export type RoadProfilePoint = { id: string; station: number; elevation: number; curveLength?: number };
export type RoadEarthwork = { enabled: boolean; cutUnitPrice: string; fillUnitPrice: string };
/** Crossfall is percent: negative means the edge falls away from the centre. */
export type RoadCrossSection = { leftSlope: number; rightSlope: number };
export type RoadCrossfallPoint = RoadCrossSection & { id:string; station:number };
/** Each side slope is a horizontal : vertical ratio; distances are metres. */
export type RoadSideSlopes = { enabled: boolean; leftCut: number; rightCut: number; leftFill: number; rightFill: number; maxWidth: number; interval?: number };
export type RoadProfile = { enabled: boolean; points: RoadProfilePoint[]; sampleInterval: number; earthwork?: RoadEarthwork; earthworkBalance?:RoadEarthworkBalance; curveTolerance?: number; crossSection?: RoadCrossSection; crossfallPoints?:RoadCrossfallPoint[]; sideSlopes?: RoadSideSlopes };
export type RoadVerticalCurve = { id:string; pviStation:number; pviElevation:number; startStation:number; endStation:number; length:number; startElevation:number; endElevation:number; startGrade:number; endGrade:number; curvature:number };
export type RoadDaylight = { status:'complete'|'uncovered'|'limit'; kind:'cut'|'fill'|'level'; width:number; edge:Vertex; outer:Vertex; groundElevation:number|null };
export type RoadSideSlopeDesign = { triangles:TerrainTriangle[]; sections:{station:number;left:RoadDaylight;right:RoadDaylight}[]; enabled:boolean; complete:boolean; warnings:string[]; unresolvedCount:number; interval:number };
type ProfileRoad = MunicipalElement & { roadProfile?: RoadProfile };
type ProfileProject = Project & { municipalTerrain?: TerrainModel };
type Vertex = { x: number; y: number; z: number };
type Section = { left: Point; right: Point; center: Point; station: number };
const EPS = 1e-9;
const designCache = new Map<string,TerrainTriangle[]>();
const slopeCache = new Map<string,RoadSideSlopeDesign>();
const controlCache = new Map<string,number[]>();
export const DEFAULT_ROAD_CURVE_TOLERANCE = .002;
export const MAX_ROAD_CONTROL_STATIONS = 4000;
const uid = () => 'grade-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
const cross = (a: Point, b: Point, c: Point) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const interpolate = (a: Vertex,b: Vertex,t: number): Vertex => ({ x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t });
const area = (ring: Point[]) => {
  if(ring.length<3)return 0;
  const origin=ring[0];
  return Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+(p.x-origin.x)*(q.y-origin.y)-(q.x-origin.x)*(p.y-origin.y);},0))/2;
};
/** Quoting and graph density do not invalidate expensive design geometry. */
const profileGeometrySignature=(profile:RoadProfile|undefined)=>profile?{enabled:profile.enabled,points:profile.points,curveTolerance:profile.curveTolerance,crossSection:profile.crossSection,crossfallPoints:profile.crossfallPoints,sideSlopes:profile.sideSlopes}:null;
// A neighbouring surface can change this road's owned footprint without
// moving its anchor or changing its width, e.g. a rotated junction or island.
// Share the actual shape dependencies across roof, control and slope caches;
// user prices, quoted counts and graph sampling never define design geometry.
const municipalGeometrySignature=(element:MunicipalElement)=>({id:element.id,kind:element.kind,catalogId:element.catalogId,points:element.points,holes:element.holes,width:element.width,depth:element.depth,height:element.height,elevation:element.elevation,rotation:element.rotation,roadLayout:element.roadLayout,junction:element.junction,layerThicknesses:element.items?.map(layer=>layer.thickness),roadProfile:profileGeometrySignature(element.roadProfile),tunnel:element.tunnel?.enabled?{start:element.tunnel.startStation,end:element.tunnel.endStation,height:element.tunnel.clearHeight,thickness:element.tunnel.liningThickness,shape:element.tunnel.shape}:null});

/** Chainage is horizontal distance along the actual centreline, in metres. */
export function roadStations(project: Project, item: MunicipalElement): number[] | null {
  const scale = municipalScale(project);
  if (!scale) return null;
  const result = [0];
  for (let i=1;i<item.points.length;i++) result.push(result[i-1]+Math.hypot(item.points[i].x-item.points[i-1].x,item.points[i].y-item.points[i-1].y)*scale);
  return result;
}
export function createRoadProfile(project: Project, item: MunicipalElement): RoadProfile {
  if (item.kind !== 'road') throw new RangeError('纵断面仅用于道路。');
  const stations=roadStations(project,item),length=stations?.at(-1);
  if (!length || length<=EPS) throw new RangeError('请先校准图纸，并画出有效道路中心线。');
  return { enabled:true, points:[{id:uid(),station:0,elevation:item.elevation/100},{id:uid(),station:length,elevation:item.elevation/100}], sampleInterval:Math.min(10,Math.max(.1,length/20)), earthwork:{enabled:false,cutUnitPrice:'',fillUnitPrice:''} };
}
/** Geometry edits retain heights while proportionally moving grade stations. */
export function normalizeRoadProfile(project: Project, item: ProfileRoad): RoadProfile | undefined {
  if (!item.roadProfile) return undefined;
  const profile=structuredClone(item.roadProfile),length=roadStations(project,item)?.at(-1),oldLength=profile.points.at(-1)?.station;
  if (length && oldLength>0) {
    profile.points=profile.points.map((point,index)=>({...point,station:index===profile.points.length-1?length:point.station*length/oldLength,...(point.curveLength!==undefined?{curveLength:point.curveLength*length/oldLength}:{})}));
    profile.points[0].station=0;
    if(profile.crossfallPoints){profile.crossfallPoints=profile.crossfallPoints.map((point,index)=>({...point,station:index===profile.crossfallPoints.length-1?length:point.station*length/oldLength}));profile.crossfallPoints[0].station=0;}
  }
  return profile;
}
export function validateRoadProfile(project: Project, item: MunicipalElement, profile?: RoadProfile): void {
  profile ??= (item as ProfileRoad).roadProfile;
  if (profile===undefined) return;
  if (item.kind!=='road'||!profile||typeof profile.enabled!=='boolean') throw new RangeError('道路纵断面配置无效。');
  if (!Array.isArray(profile.points)||profile.points.length<2||profile.points.length>100) throw new RangeError('纵断面需要 2–100 个变坡点。');
  const ids=new Set<string>();
  profile.points.forEach((point,index)=>{
    if (!point||typeof point.id!=='string'||!point.id.trim()||ids.has(point.id)||![point.station,point.elevation].every(Number.isFinite)||point.station<0||Math.abs(point.elevation)>100000) throw new RangeError('纵断面里程、高程或变坡点编号无效。');
    ids.add(point.id);
    if(index&&point.station-profile.points[index-1].station<=EPS) throw new RangeError('变坡点里程必须严格递增，不能重合或倒序。');
    if(point.curveLength!==undefined&&(!Number.isFinite(point.curveLength)||point.curveLength<0))throw new RangeError('竖曲线长度必须是非负的米制数字。');
    if((index===0||index===profile.points.length-1)&&(point.curveLength??0)>0)throw new RangeError('起点和终点不能设置竖曲线。');
    if(index>0&&index<profile.points.length-1&&point.curveLength>0){const half=point.curveLength/2;if(point.station-half<profile.points[index-1].station-EPS||point.station+half>profile.points[index+1].station+EPS)throw new RangeError('竖曲线不能越过相邻变坡点或道路端点。');}
  });
  const length=roadStations(project,item)?.at(-1),tolerance=Math.max(1e-7,(length??1)*1e-9);
  if(Math.abs(profile.points[0].station)>tolerance) throw new RangeError('纵断面起点里程必须为 0 m。');
  if(length!==undefined&&length!==null&&Math.abs(profile.points.at(-1).station-length)>tolerance) throw new RangeError('纵断面终点里程应与道路实际长度一致。');
  if(!Number.isFinite(profile.sampleInterval)||profile.sampleInterval<.1||profile.sampleInterval>10000) throw new RangeError('纵断面采样间距应为 0.1–10000 m。');
  if(profile.curveTolerance!==undefined&&(!Number.isFinite(profile.curveTolerance)||profile.curveTolerance<.0001||profile.curveTolerance>.05))throw new RangeError('路面离散高程误差应为 0.1–50 mm。');
  const curves=roadVerticalCurves(profile);for(let i=1;i<curves.length;i++)if(curves[i].startStation<curves[i-1].endStation-EPS)throw new RangeError('相邻竖曲线不能重叠，请减小曲线长度。');
  if(profile.crossSection!==undefined){if(!profile.crossSection||typeof profile.crossSection!=='object')throw new RangeError('横坡配置无效。');for(const side of ['leftSlope','rightSlope'] as const)if(!Number.isFinite(profile.crossSection[side])||Math.abs(profile.crossSection[side])>25)throw new RangeError('左右横坡使用百分数，范围为 −25% 至 +25%。');}
  if(profile.crossfallPoints!==undefined){
    if(!Array.isArray(profile.crossfallPoints)||profile.crossfallPoints.length<2||profile.crossfallPoints.length>100)throw new RangeError('横坡过渡表需要 2–100 个里程点。');
    const crossfallIds=new Set<string>();profile.crossfallPoints.forEach((point,index)=>{if(!point||typeof point.id!=='string'||!point.id.trim()||crossfallIds.has(point.id)||![point.station,point.leftSlope,point.rightSlope].every(Number.isFinite)||point.station<0||Math.abs(point.leftSlope)>25||Math.abs(point.rightSlope)>25)throw new RangeError('横坡里程、编号或坡度无效，左右横坡应为 −25% 至 +25%。');crossfallIds.add(point.id);if(index&&point.station-profile.crossfallPoints[index-1].station<=EPS)throw new RangeError('横坡里程必须严格递增，不能重合或倒序。');});
    if(Math.abs(profile.crossfallPoints[0].station)>tolerance||Math.abs(profile.crossfallPoints.at(-1).station-profile.points.at(-1).station)>tolerance)throw new RangeError('横坡过渡表起点须为 0 m，终点须等于道路实际长度。');
  }
  if(profile.sideSlopes!==undefined){const slopes=profile.sideSlopes;if(!slopes||typeof slopes!=='object'||typeof slopes.enabled!=='boolean')throw new RangeError('放坡开关无效。');for(const key of ['leftCut','rightCut','leftFill','rightFill'] as const)if(!Number.isFinite(slopes[key])||slopes[key]<.05||slopes[key]>20)throw new RangeError('挖填边坡 H:V 比应为 0.05–20，不能为零。');if(!Number.isFinite(slopes.maxWidth)||slopes.maxWidth<.1||slopes.maxWidth>500)throw new RangeError('最大找坡宽度应为 0.1–500 m。');if(slopes.interval!==undefined&&(!Number.isFinite(slopes.interval)||slopes.interval<.1||slopes.interval>100))throw new RangeError('放坡控制断面间距应为 0.1–100 m。');}
  if(profile.earthwork){
    if(typeof profile.earthwork.enabled!=='boolean') throw new RangeError('土方计价开关无效。');
    for(const key of ['cutUnitPrice','fillUnitPrice'] as const){if(typeof profile.earthwork[key]!=='string')throw new RangeError('土方单价须为有效十进制金额。');if(profile.earthwork[key]!=='')normalizeDecimal(profile.earthwork[key],'土方单价');}
  }
  validateEarthworkBalance(profile.earthworkBalance);
  if(profile.enabled&&length) roadSections(project,item);
}
/** User-specified signed percent; no design-speed or road-class inference. */
export function roadCrossSectionAtStation(profile:RoadProfile,station:number):RoadCrossSection{
  if(!Number.isFinite(station))throw new RangeError('横坡里程无效。');
  const points=profile.crossfallPoints;if(!points?.length)return{...(profile.crossSection??{leftSlope:0,rightSlope:0})};
  if(station<=points[0].station)return{leftSlope:points[0].leftSlope,rightSlope:points[0].rightSlope};if(station>=points.at(-1).station)return{leftSlope:points.at(-1).leftSlope,rightSlope:points.at(-1).rightSlope};
  const index=points.findIndex(point=>point.station>=station),a=points[index-1],b=points[index],t=(station-a.station)/(b.station-a.station);return{leftSlope:a.leftSlope+(b.leftSlope-a.leftSlope)*t,rightSlope:a.rightSlope+(b.rightSlope-a.rightSlope)*t};
}
export function roadVerticalCurves(profile:RoadProfile):RoadVerticalCurve[]{
  return profile.points.slice(1,-1).flatMap((point,index)=>{const length=point.curveLength??0;if(!length)return[];const previous=profile.points[index],next=profile.points[index+2],startGrade=(point.elevation-previous.elevation)/(point.station-previous.station),endGrade=(next.elevation-point.elevation)/(next.station-point.station);return[{id:point.id,pviStation:point.station,pviElevation:point.elevation,startStation:point.station-length/2,endStation:point.station+length/2,length,startElevation:point.elevation-startGrade*length/2,endElevation:point.elevation+endGrade*length/2,startGrade,endGrade,curvature:(endGrade-startGrade)/length}];});
}
export function roadProfileElevation(profile: RoadProfile, station: number): number {
  const points=profile.points;
  if(!Number.isFinite(station)||!points?.length) throw new RangeError('纵断面里程无效。');
  if(station<=points[0].station)return points[0].elevation;
  if(station>=points.at(-1).station)return points.at(-1).elevation;
  const curve=roadVerticalCurves(profile).find(curve=>station>=curve.startStation&&station<=curve.endStation);
  if(curve){const x=station-curve.startStation;return curve.startElevation+curve.startGrade*x+curve.curvature*x*x/2;}
  const end=points.findIndex(point=>point.station>=station),a=points[end-1],b=points[end];
  return a.elevation+(b.elevation-a.elevation)*(station-a.station)/(b.station-a.station);
}
export function roadProfileGrade(profile:RoadProfile,station:number):number{
  if(!Number.isFinite(station))throw new RangeError('纵断面里程无效。');
  const curve=roadVerticalCurves(profile).find(curve=>station>=curve.startStation&&station<=curve.endStation);if(curve)return curve.startGrade+curve.curvature*(station-curve.startStation);
  const end=Math.max(1,profile.points.findIndex((point,index)=>index>0&&point.station>station)),index=station>=profile.points.at(-1).station?profile.points.length-1:end,a=profile.points[index-1],b=profile.points[index];return(b.elevation-a.elevation)/(b.station-a.station);
}
function curveLengthBetween(curve:RoadVerticalCurve,start:number,end:number):number{
  const first=curve.startGrade+curve.curvature*(start-curve.startStation),last=curve.startGrade+curve.curvature*(end-curve.startStation);
  if(Math.abs(curve.curvature)<1e-10)return(end-start)*Math.hypot(1,(first+last)/2);
  const primitive=(grade:number)=>(grade*Math.hypot(1,grade)+Math.asinh(grade))/2;
  return(primitive(last)-primitive(first))/curve.curvature;
}
export function roadProfileSegments(project: Project, item: ProfileRoad) {
  const profile=item.roadProfile;
  if(!profile?.enabled)return[];
  validateRoadProfile(project,item,profile);
  const curves=roadVerticalCurves(profile),breaks=[0,profile.points.at(-1).station,...profile.points.filter(point=>!point.curveLength).map(point=>point.station),...curves.flatMap(curve=>[curve.startStation,curve.endStation])].sort((a,b)=>a-b).filter((value,index,array)=>index===0||value-array[index-1]>EPS);
  return breaks.slice(1).map((endStation,index)=>{const startStation=breaks[index],horizontalLength=endStation-startStation,startElevation=roadProfileElevation(profile,startStation),endElevation=roadProfileElevation(profile,endStation),middle=(startStation+endStation)/2,curve=curves.find(value=>middle>value.startStation&&middle<value.endStation),grade=(endElevation-startElevation)/horizontalLength,startGrade=curve?curve.startGrade+curve.curvature*(startStation-curve.startStation):roadProfileGrade(profile,middle),endGrade=curve?curve.startGrade+curve.curvature*(endStation-curve.startStation):startGrade;return{id:curve?.id??'tangent-'+index,kind:curve?'curve':'line',startStation,endStation,startElevation,endElevation,horizontalLength,grade,gradePercent:grade*100,startGrade,endGrade,startGradePercent:startGrade*100,endGradePercent:endGrade*100,designLength:curve?curveLengthBetween(curve,startStation,endStation):Math.hypot(horizontalLength,endElevation-startElevation)};});
}
export function roadPointAtStation(project: Project, item: MunicipalElement, station: number): Point | null {
  const stations=roadStations(project,item),scale=municipalScale(project);
  if(!stations||!scale)return null;
  const target=Math.max(0,Math.min(stations.at(-1),station));
  let index=stations.findIndex((value,i)=>i>0&&value>=target);if(index<0)index=stations.length-1;
  const a=item.points[index-1],b=item.points[index],t=(target-stations[index-1])/(stations[index]-stations[index-1]);
  return{x:(a.x+(b.x-a.x)*t)*scale,y:(a.y+(b.y-a.y)*t)*scale};
}
export function roadStationAtPlanPoint(project: Project, item: MunicipalElement, point: Point): number|null {
  const scale=municipalScale(project),stations=roadStations(project,item);if(!scale||!stations)return null;
  let nearest=Infinity,result=0;
  for(let i=1;i<item.points.length;i++){const a=item.points[i-1],b=item.points[i],dx=b.x-a.x,dy=b.y-a.y,square=dx*dx+dy*dy,t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/square)),distance=Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);if(distance<nearest){nearest=distance;result=stations[i-1]+t*(stations[i]-stations[i-1]);}}
  return result;
}

function roadSections(project: Project,item: MunicipalElement): Section[] {
  const scale=municipalScale(project),stations=roadStations(project,item);
  if(!scale||!stations)return[];
  const points=item.points.map(point=>({x:point.x*scale,y:point.y*scale})),half=item.width/200;
  const directions=points.slice(1).map((point,i)=>{const length=Math.hypot(point.x-points[i].x,point.y-points[i].y);if(length<=EPS)throw new RangeError('道路中心线相邻节点不能重合。');return{x:(point.x-points[i].x)/length,y:(point.y-points[i].y)/length};});
  const offset=(point:Point,direction:Point,sign:number)=>({x:point.x-direction.y*half*sign,y:point.y+direction.x*half*sign});
  const at=(index:number,sign:number)=>{
    const p=points[index];
    if(index===0)return offset(p,directions[0],sign);
    if(index===points.length-1)return offset(p,directions.at(-1),sign);
    const before=directions[index-1],after=directions[index],a=offset(p,before,sign),b=offset(p,after,sign),turn=before.x*after.y-before.y*after.x;
    if(Math.abs(turn)<1e-10){if(before.x*after.x+before.y*after.y<0)throw new RangeError('纵断面道路不能原路折返。');return a;}
    const dx=b.x-a.x,dy=b.y-a.y,t=(dx*after.y-dy*after.x)/turn,result={x:a.x+before.x*t,y:a.y+before.y*t};
    if(Math.hypot(result.x-p.x,result.y-p.y)>half*4+EPS)throw new RangeError('当前转角过尖，无法可靠构造纵断面截面。请调整路线转角或减小路宽。');
    return result;
  };
  return points.map((center,i)=>({center,station:stations[i],left:at(i,1),right:at(i,-1)}));
}
function sectionAt(sections:Section[],station:number):Section{
  let index=sections.findIndex((section,i)=>i>0&&section.station>=station-EPS);if(index<0)index=sections.length-1;
  const a=sections[index-1],b=sections[index],t=Math.max(0,Math.min(1,(station-a.station)/(b.station-a.station))),point=(a:Point,b:Point)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
  return{station,center:point(a.center,b.center),left:point(a.left,b.left),right:point(a.right,b.right)};
}
function sectionVertex(item:ProfileRoad,section:Section,side:'left'|'center'|'right',formation=false):Vertex{
  const slope=side==='center'?0:roadCrossSectionAtStation(item.roadProfile,section.station)[side==='left'?'leftSlope':'rightSlope']/100;
  const depth=formation?(item.height+(item.items??[]).reduce((sum,layer)=>sum+layer.thickness,0))/100:0;
  return{...section[side],z:roadProfileElevation(item.roadProfile,section.station)+slope*item.width/200-depth};
}
function segmentCrossing(a:Point,b:Point,c:Point,d:Point):number|null{
  const ux=b.x-a.x,uy=b.y-a.y,vx=d.x-c.x,vy=d.y-c.y,det=ux*vy-uy*vx;if(Math.abs(det)<EPS)return null;
  const wx=c.x-a.x,wy=c.y-a.y,t=(wx*vy-wy*vx)/det,s=(wx*uy-wy*ux)/det;return t>EPS&&t<1-EPS&&s>=-EPS&&s<=1+EPS?t:null;
}
/** For each left/centre or centre/right strip, the reference surface is
 * z(s,r)=zCentre(s)+r*d(s). Its plan map at a miter is
 * X=s+r*(a+k*s), Y=r*halfWidth. A triangle's station shift is bounded by
 * |k|*Δs/(4*min(1,1+k)); parabolic and bilinear interpolation add the other
 * two terms below. This also bounds interior points, not just edge chords. */
function surfaceErrorParts(item:ProfileRoad,sections:Section[],start:number,end:number):{quadratic:number;linear:number}{
  const profile=item.roadProfile,span=end-start,middle=(start+end)/2,curve=roadVerticalCurves(profile).find(curve=>middle>curve.startStation&&middle<curve.endStation),curvature=Math.abs(curve?.curvature??0),quadratic=curvature*span*span/8;
  if(!profile.crossfallPoints)return{quadratic,linear:0};
  const first=roadCrossSectionAtStation(profile,start),last=roadCrossSectionAtStation(profile,end),maxGrade=curve?Math.max(Math.abs(curve.startGrade+curve.curvature*(start-curve.startStation)),Math.abs(curve.startGrade+curve.curvature*(end-curve.startStation))):Math.abs(roadProfileGrade(profile,middle));
  const index=sections.findIndex((section,i)=>i>0&&section.station>=middle),a=sections[index-1],b=sections[index],length=b.station-a.station,direction={x:(b.center.x-a.center.x)/length,y:(b.center.y-a.center.y)/length};
  let linear=0;
  for(const side of ['left','right'] as const){
    const field=side==='left'?'leftSlope':'rightSlope',dPrime=item.width/200*(last[field]-first[field])/100/span;
    const along=(section:Section)=>(section[side].x-section.center.x)*direction.x+(section[side].y-section.center.y)*direction.y,k=(along(b)-along(a))/length,jacobian=Math.min(1,1+k);
    if(jacobian<=1e-8)throw new RangeError('转角路缘沿线折返，无法保证横坡过渡路面的精度；请拉长相邻路段或减小路宽。');
    linear=Math.max(linear,Math.abs(dPrime)*span/4+(maxGrade+Math.abs(dPrime))*Math.abs(k)*span/(4*jacobian));
  }
  return{quadratic,linear};
}
/** A control interval may not straddle a grade, crossfall or alignment break. */
export function roadSurfaceErrorBound(project:Project,item:ProfileRoad,start:number,end:number):number{
  if(!item.roadProfile?.enabled)return 0;
  const sections=roadSections(project,item),profile=item.roadProfile,length=sections.at(-1)?.station;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||length===undefined||end>length+EPS)throw new RangeError('路面误差检查区间无效。');
  const breaks=[...sections.map(section=>section.station),...profile.points.map(point=>point.station),...(profile.crossfallPoints??[]).map(point=>point.station),...roadVerticalCurves(profile).flatMap(curve=>[curve.startStation,curve.endStation])];
  if(breaks.some(station=>station>start+1e-8&&station<end-1e-8))throw new RangeError('误差检查区间不能跨过路线、纵坡或横坡控制点。');
  const parts=surfaceErrorParts(item,sections,start,end);return parts.quadratic+parts.linear;
}
/** Control geometry never uses the graph sampling interval. Parabolic chord
 * error is bounded by |z''| Δs² / 8; optional daylight sections use their own
 * explicit longitudinal interval and actual TIN/ownership break locations. */
export function roadControlStations(project:ProfileProject,item:ProfileRoad):number[]{
  const profile=item.roadProfile,sections=roadSections(project,item);if(!profile?.enabled||!sections.length)return[];
  const cacheKey=sideSlopeKey(project,item),cached=controlCache.get(cacheKey);if(cached)return[...cached];
  const length=sections.at(-1).station,tolerance=profile.curveTolerance??DEFAULT_ROAD_CURVE_TOLERANCE,stations=[...sections.map(section=>section.station),...profile.points.map(point=>point.station),...(profile.crossfallPoints??[]).map(point=>point.station)];
  for(const curve of roadVerticalCurves(profile)){
    const count=Math.max(1,Math.ceil(Math.sqrt(Math.abs(curve.curvature)*curve.length*curve.length/(8*tolerance))));
    if(count>MAX_ROAD_CONTROL_STATIONS)throw new RangeError('竖曲线控制断面过多，请增大高程误差上限或调整设计。');
    for(let i=0;i<=count;i++)stations.push(curve.startStation+curve.length*i/count);
  }
  if(profile.sideSlopes?.enabled){
    const interval=profile.sideSlopes.interval??2,count=Math.ceil(length/interval);if(count>MAX_ROAD_CONTROL_STATIONS)throw new RangeError('放坡控制断面过多，请增大放坡断面间距。');
    for(let i=0;i<=count;i++)stations.push(length*i/Math.max(1,count));
    const terrain=triangulateTerrain(project.municipalTerrain),scale=municipalScale(project),rings=(municipalFootprints(item,project)??[]).flatMap(part=>[part.points,...part.holes]).map(ring=>ring.map(point=>({x:point.x*scale,y:point.y*scale})));
    const edges=[...terrain.flatMap(triangle=>triangle.map((point,index)=>[point,triangle[(index+1)%3]])),...rings.flatMap(ring=>ring.map((point,index)=>[point,ring[(index+1)%ring.length]]))];
    for(let i=1;i<sections.length;i++)for(const side of ['left','right'] as const)for(const [a,b]of edges){const t=segmentCrossing(sections[i-1][side],sections[i][side],a,b);if(t!==null)stations.push(sections[i-1].station+(sections[i].station-sections[i-1].station)*t);}
    // Add real cut/fill transitions so no artificial strip spans a zero-depth
    // crossing. Terrain breaks above keep this bisection within measured data.
    const initial=[...new Set(stations)].sort((a,b)=>a-b);
    const difference=(station:number,side:'left'|'right')=>{const edge=sectionVertex(item,sectionAt(sections,station),side,true),ground=terrainElevation(project.municipalTerrain,edge.x,edge.y);return ground===null?null:ground-edge.z;};
    for(let i=1;i<initial.length;i++)for(const side of ['left','right'] as const){let a=initial[i-1],b=initial[i],fa=difference(a,side),fb=difference(b,side);if(fa===null||fb===null||fa*fb>=0)continue;for(let iteration=0;iteration<45;iteration++){const middle=(a+b)/2,fm=difference(middle,side);if(fm===null)break;if(fa*fm<=0){b=middle;fb=fm;}else{a=middle;fa=fm;}}stations.push((a+b)/2);}
  }
  let result=stations.filter(value=>value>=-EPS&&value<=length+EPS).map(value=>Math.max(0,Math.min(length,value))).sort((a,b)=>a-b).filter((value,index,array)=>index===0||value-array[index-1]>1e-8);
  if(profile.crossfallPoints){
    const refined=[result[0]];
    for(let i=1;i<result.length;i++){
      const start=result[i-1],end=result[i],parts=surfaceErrorParts(item,sections,start,end),count=Math.max(1,Math.ceil((parts.linear+Math.sqrt(parts.linear*parts.linear+4*tolerance*parts.quadratic))/(2*tolerance)));
      if(refined.length+count>MAX_ROAD_CONTROL_STATIONS)throw new RangeError('横坡过渡路面控制断面超过 4000 个，请增大路面误差上限或调整过渡长度、路线与路宽。');
      for(let j=1;j<=count;j++)refined.push(start+(end-start)*j/count);
    }
    result=refined;
  }
  if(result.length>MAX_ROAD_CONTROL_STATIONS)throw new RangeError('道路控制断面超过 4000 个，请调整曲线精度或放坡间距。');
  controlCache.set(cacheKey,result);if(controlCache.size>12)controlCache.delete(controlCache.keys().next().value);return[...result];
}
/** Exact vertical trapezoid partition handles concave footprints and holes. */
function footprintTriangles(parts:SurfacePart[],scale:number):TerrainTriangle[]{
  const triangles:TerrainTriangle[]=[];
  for(const part of parts){
    const rings=[part.points,...part.holes].map(ring=>ring.map(point=>({x:point.x*scale,y:point.y*scale})));
    const xs=[...new Set(rings.flatMap(ring=>ring.map(point=>point.x)))].sort((a,b)=>a-b);
    for(let column=1;column<xs.length;column++){
      const x1=xs[column-1],x2=xs[column],middle=(x1+x2)/2;if(x2-x1<=EPS)continue;
      const hits:{y:number;at:(x:number)=>number}[]=[];
      for(const ring of rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if(middle<=Math.min(a.x,b.x)||middle>=Math.max(a.x,b.x))continue;const at=(x:number)=>a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x);hits.push({y:at(middle),at});}
      hits.sort((a,b)=>a.y-b.y);
      if(hits.length%2)throw new RangeError('道路净轮廓无法可靠分解，请检查边界。');
      for(let i=0;i<hits.length;i+=2){const lower=hits[i],upper=hits[i+1],ring=[{x:x1,y:lower.at(x1),z:0},{x:x2,y:lower.at(x2),z:0},{x:x2,y:upper.at(x2),z:0},{x:x1,y:upper.at(x1),z:0}];for(const triangle of [[ring[0],ring[1],ring[2]],[ring[0],ring[2],ring[3]]] as TerrainTriangle[])if(area(triangle)>EPS)triangles.push(triangle);}
    }
  }
  return triangles;
}
function clipTriangle(subject:Vertex[],clip:TerrainTriangle):Vertex[]{
  let result=subject;const direction=cross(clip[0],clip[1],clip[2])>=0?1:-1;
  for(let i=0;i<3&&result.length;i++){
    const a=clip[i],b=clip[(i+1)%3],output:Vertex[]=[];
    for(let j=0;j<result.length;j++){const p=result[j],q=result[(j+1)%result.length],fp=cross(a,b,p)*direction,fq=cross(a,b,q)*direction,insideP=fp>=-EPS,insideQ=fq>=-EPS;if(insideP)output.push(p);if(insideP!==insideQ)output.push(interpolate(p,q,fp/(fp-fq)));}
    result=output;
  }
  return result.filter((point,index,ring)=>Math.hypot(point.x-ring[(index+ring.length-1)%ring.length].x,point.y-ring[(index+ring.length-1)%ring.length].y)>EPS);
}
/** Actual design roof, partitioned at alignment bends and every grade change.
 * XY are metres; z is absolute elevation. Owned footprints remove billed area
 * overlaps, including internal holes. No full-width rectangle surrogate. */
function cachedRoadDesignTriangles(project: Project,item: ProfileRoad):TerrainTriangle[]{
  const profile=item.roadProfile,scale=municipalScale(project);
  if(!profile?.enabled||!scale)return[];
  validateRoadProfile(project,item,profile);
  const key=JSON.stringify([scale,municipalGeometrySignature(item),profile.sideSlopes?.enabled?project.municipalTerrain:null,(project.municipalElements??[]).map(municipalGeometrySignature)]);
  const cached=designCache.get(key);if(cached)return cached;
  const sections=roadSections(project,item),controls=roadControlStations(project,item),net=footprintTriangles(municipalFootprints(item,project)??[],scale),result:TerrainTriangle[]=[];
  const bounds=(ring:Point[])=>({minX:Math.min(...ring.map(p=>p.x)),maxX:Math.max(...ring.map(p=>p.x)),minY:Math.min(...ring.map(p=>p.y)),maxY:Math.max(...ring.map(p=>p.y))});
  const nets=net.map(triangle=>({triangle,bounds:bounds(triangle)}));
  for(let i=1;i<sections.length;i++){
    const a=sections[i-1],b=sections[i],stations=[a.station,...controls.filter(station=>station>a.station+EPS&&station<b.station-EPS),b.station];
    const section=(station:number)=>{const at=sectionAt(sections,station);return{left:sectionVertex(item,at,'left'),center:sectionVertex(item,at,'center'),right:sectionVertex(item,at,'right')};};
    for(let j=1;j<stations.length;j++){
      const start=section(stations[j-1]),end=section(stations[j]);
      const roof:TerrainTriangle[]=[[start.left,start.center,end.center],[start.left,end.center,end.left],[start.center,start.right,end.right],[start.center,end.right,end.center]];
      for(const triangle of roof){if(area(triangle)<=EPS)continue;const box=bounds(triangle);for(const target of nets){if(box.maxX<target.bounds.minX-EPS||box.minX>target.bounds.maxX+EPS||box.maxY<target.bounds.minY-EPS||box.minY>target.bounds.maxY+EPS)continue;const clipped=clipTriangle(triangle,target.triangle);for(let k=1;k<clipped.length-1;k++){const piece:TerrainTriangle=[clipped[0],clipped[k],clipped[k+1]];if(area(piece)>EPS)result.push(piece);}}}
    }
  }
  designCache.set(key,result);if(designCache.size>12)designCache.delete(designCache.keys().next().value);
  return result;
}
export function roadDesignTriangles(project:Project,item:ProfileRoad):TerrainTriangle[]{return structuredClone(cachedRoadDesignTriangles(project,item));}

type RayInterval={start:number;end:number;elevation:number;grade:number};
/** Clip a horizontal ray against each measured triangle. Its barycentric
 * coordinates and interpolated elevation are affine in ray distance. */
function terrainRayIntervals(terrain:TerrainTriangle[],edge:Vertex,direction:Point,maxWidth:number):RayInterval[]{
  const intervals:RayInterval[]=[];
  const endPoint={x:edge.x+direction.x*maxWidth,y:edge.y+direction.y*maxWidth},rayBounds={minX:Math.min(edge.x,endPoint.x),maxX:Math.max(edge.x,endPoint.x),minY:Math.min(edge.y,endPoint.y),maxY:Math.max(edge.y,endPoint.y)};
  for(const triangle of terrain){
    const bounds=triangleBounds(triangle);if(bounds.maxX<rayBounds.minX-EPS||bounds.minX>rayBounds.maxX+EPS||bounds.maxY<rayBounds.minY-EPS||bounds.minY>rayBounds.maxY+EPS)continue;
    const denominator=cross(triangle[0],triangle[1],triangle[2]);if(Math.abs(denominator)<=EPS)continue;
    const barycentric=(point:Point)=>{const a=cross(triangle[1],triangle[2],point)/denominator,b=cross(triangle[2],triangle[0],point)/denominator;return[a,b,1-a-b];};
    const at=barycentric(edge),next=barycentric({x:edge.x+direction.x,y:edge.y+direction.y}),delta=next.map((value,i)=>value-at[i]);
    let start=0,end=maxWidth;
    for(let i=0;i<3;i++){if(Math.abs(delta[i])<1e-12){if(at[i]<-1e-8){end=-1;break;}}else if(delta[i]>0)start=Math.max(start,-at[i]/delta[i]);else end=Math.min(end,-at[i]/delta[i]);}
    if(end>=start-1e-8&&end>=0&&start<=maxWidth)intervals.push({start:Math.max(0,start),end:Math.min(maxWidth,end),elevation:at.reduce((sum,value,i)=>sum+value*triangle[i].z,0),grade:delta.reduce((sum,value,i)=>sum+value*triangle[i].z,0)});
  }
  return intervals.sort((a,b)=>a.start-b.start||b.end-a.end);
}
function daylight(terrain:TerrainTriangle[],edge:Vertex,direction:Point,cutRatio:number,fillRatio:number,maxWidth:number):RoadDaylight{
  const intervals=terrainRayIntervals(terrain,edge,direction,maxWidth),initial=intervals.find(interval=>interval.start<=1e-7&&interval.end>EPS);
  if(!initial)return{status:'uncovered',kind:'level',width:0,edge,outer:{...edge},groundElevation:null};
  const groundElevation=initial.elevation,difference=groundElevation-edge.z;
  if(Math.abs(difference)<1e-8)return{status:'complete',kind:'level',width:0,edge,outer:{...edge,z:groundElevation},groundElevation};
  const kind=difference>0?'cut':'fill',slope=kind==='cut'?1/cutRatio:-1/fillRatio,outer=(width:number)=>({x:edge.x+direction.x*width,y:edge.y+direction.y*width,z:edge.z+slope*width});
  let distance=0;
  for(let count=0;count<=intervals.length;count++){
    const candidates=intervals.filter(interval=>interval.start<=distance+1e-7&&interval.end>distance+1e-8),segment=candidates.sort((a,b)=>b.end-a.end)[0];
    if(!segment)return{status:'uncovered',kind,width:distance,edge,outer:outer(distance),groundElevation};
    const intercept=segment.elevation-edge.z,derivative=segment.grade-slope;
    if(Math.abs(derivative)>1e-12){const hit=-intercept/derivative;if(hit>=distance-1e-7&&hit<=segment.end+1e-7&&hit<=maxWidth+1e-7){const width=Math.max(0,Math.min(maxWidth,hit));return{status:'complete',kind,width,edge,outer:outer(width),groundElevation};}}
    distance=segment.end;
    if(distance>=maxWidth-1e-7)return{status:'limit',kind,width:maxWidth,edge,outer:outer(maxWidth),groundElevation};
  }
  return{status:'uncovered',kind,width:distance,edge,outer:outer(distance),groundElevation};
}
const triangleBounds=(triangle:Point[])=>({minX:Math.min(...triangle.map(point=>point.x)),maxX:Math.max(...triangle.map(point=>point.x)),minY:Math.min(...triangle.map(point=>point.y)),maxY:Math.max(...triangle.map(point=>point.y))});
const boundsOverlap=(a:ReturnType<typeof triangleBounds>,b:ReturnType<typeof triangleBounds>)=>a.maxX>b.minX+EPS&&b.maxX>a.minX+EPS&&a.maxY>b.minY+EPS&&b.maxY>a.minY+EPS;
function intersectsTriangles(left:TerrainTriangle[],right:TerrainTriangle[]):boolean{
  const targets=right.map(triangle=>({triangle,bounds:triangleBounds(triangle)}));
  for(const triangle of left){const bounds=triangleBounds(triangle);for(const target of targets)if(boundsOverlap(bounds,target.bounds)&&area(clipTriangle(triangle,target.triangle))>1e-7)return true;}
  return false;
}
function formationTriangles(project:Project,item:ProfileRoad):TerrainTriangle[]{const depth=(item.height+(item.items??[]).reduce((sum,layer)=>sum+layer.thickness,0))/100;return cachedRoadDesignTriangles(project,item).map(triangle=>triangle.map(point=>({...point,z:point.z-depth})) as TerrainTriangle);}
function sideSlopeKey(project:ProfileProject,item:ProfileRoad):string{return JSON.stringify([municipalScale(project),municipalGeometrySignature(item),project.municipalTerrain,(project.municipalElements??[]).map(municipalGeometrySignature)]);}
/** Raw daylight design has no cross-road recursion. Partial owned roadways
 * require junction grading, so slopes are held for confirmation rather than
 * quietly charged along a centreline that no longer owns the surface. */
function rawSideSlopeDesign(project:ProfileProject,item:ProfileRoad):RoadSideSlopeDesign{
  const slopes=item.roadProfile?.sideSlopes,interval=slopes?.interval??2,empty:RoadSideSlopeDesign={enabled:Boolean(item.roadProfile?.enabled&&slopes?.enabled),complete:true,triangles:[],sections:[],warnings:[],unresolvedCount:0,interval};
  if(!empty.enabled)return empty;
  validateRoadProfile(project,item);
  const scale=municipalScale(project);if(!scale)return{...empty,complete:false,warnings:['图纸尚未校准，边坡待确认'],unresolvedCount:1};
  const key=sideSlopeKey(project,item),cached=slopeCache.get(key);if(cached)return cached;
  const formation=formationTriangles(project,item),ownedArea=formation.reduce((sum,triangle)=>sum+area(triangle),0),fullArea=roadStations(project,item).at(-1)*item.width/100;
  if(ownedArea<=1e-7)return empty;
  if(Math.abs(ownedArea-fullArea)>Math.max(1e-6,fullArea*1e-7))return{...empty,complete:false,warnings:['道路净轮廓被其它施工面扣减，需要确认交接边坡；本路边坡未计量'],unresolvedCount:1};
  const tunnel=item.tunnel?.enabled?item.tunnel:null,roadLength=roadStations(project,item).at(-1);
  const outsideTunnel=(station:number)=>!tunnel||station<tunnel.startStation-EPS||station>tunnel.endStation+EPS||Math.abs(station-tunnel.startStation)<=EPS&&tunnel.startStation>EPS||Math.abs(station-tunnel.endStation)<=EPS&&tunnel.endStation<roadLength-EPS;
  const terrain=triangulateTerrain(project.municipalTerrain),sections=roadSections(project,item),controls=[...new Set([...roadControlStations(project,item),...(tunnel?[tunnel.startStation,tunnel.endStation]:[])])].filter(outsideTunnel).sort((a,b)=>a-b),rows=controls.map(station=>{
    const at=sectionAt(sections,station),side=(side:'left'|'right')=>{const edge=sectionVertex(item,at,side,true),dx=edge.x-at.center.x,dy=edge.y-at.center.y,distance=Math.hypot(dx,dy);return daylight(terrain,edge,{x:dx/distance,y:dy/distance},slopes[side==='left'?'leftCut':'rightCut'],slopes[side==='left'?'leftFill':'rightFill'],slopes.maxWidth);};return{station,left:side('left'),right:side('right')};
  });
  const triangles:TerrainTriangle[]=[],warnings=new Set<string>();let unresolvedCount=rows.reduce((sum,row)=>sum+Number(row.left.status!=='complete')+Number(row.right.status!=='complete'),0);
  if(rows.some(row=>[row.left,row.right].some(side=>side.status==='uncovered')))warnings.add('部分边坡未被测量地形连续覆盖，未外推找坡');
  if(rows.some(row=>[row.left,row.right].some(side=>side.status==='limit')))warnings.add('部分边坡在最大找坡宽度内未与地形相交，请调整参数或确认设计');
  for(let i=1;i<rows.length;i++)for(const side of ['left','right'] as const){
    if(tunnel&&(rows[i-1].station+rows[i].station)/2>tunnel.startStation-EPS&&(rows[i-1].station+rows[i].station)/2<tunnel.endStation+EPS)continue;
    const a=rows[i-1][side],b=rows[i][side];if(a.status!=='complete'||b.status!=='complete')continue;
    const strip:TerrainTriangle[]=([[a.edge,b.edge,b.outer],[a.edge,b.outer,a.outer]] as TerrainTriangle[]).filter(triangle=>area(triangle)>EPS);
    if(intersectsTriangles(strip,formation)||intersectsTriangles(strip,triangles)||strip.length===2&&intersectsTriangles([strip[0]],[strip[1]])){warnings.add('转角边坡相交，未自动接坡设计；冲突边坡未计量');unresolvedCount++;continue;}
    triangles.push(...strip);
  }
  const result={...empty,triangles,sections:rows,complete:unresolvedCount===0,warnings:[...warnings],unresolvedCount};slopeCache.set(key,result);if(slopeCache.size>12)slopeCache.delete(slopeCache.keys().next().value);return result;
}
/** Daylight and pricing share this exact mesh. A junction with another road
 * or slope is deliberately unresolved; an automatic grading design would
 * require a common civil surface, which this editor does not invent. */
export function roadSideSlopeDesign(project:ProfileProject,item:ProfileRoad):RoadSideSlopeDesign{
  const result=rawSideSlopeDesign(project,item);if(!result.enabled||!result.triangles.length)return structuredClone(result);
  for(const other of project.municipalElements??[]){
    if(other.id===item.id||other.kind!=='road')continue;
    const road=other as ProfileRoad,scale=municipalScale(project),otherSurface=footprintTriangles(municipalFootprints(other,project)??[],scale).map(triangle=>triangle.map(point=>({...point,z:other.elevation/100})) as TerrainTriangle),otherSlopes=rawSideSlopeDesign(project,road).triangles;
    if(intersectsTriangles(result.triangles,otherSurface)||intersectsTriangles(result.triangles,otherSlopes))return{...structuredClone(result),triangles:[],complete:false,unresolvedCount:result.unresolvedCount+1,warnings:[...result.warnings,'本路边坡与其它道路或边坡相交，需要统一接坡设计；本路边坡未计量']};
  }
  return structuredClone(result);
}
export function roadEarthworkDesignTriangles(project:ProfileProject,item:ProfileRoad):TerrainTriangle[]{return excludeTunnelEarthworkTriangles(project,item,[...formationTriangles(project,item),...roadSideSlopeDesign(project,item).triangles],{extraWidth:item.roadProfile?.sideSlopes?.enabled?item.roadProfile.sideSlopes.maxWidth:0});}
function elevationInTriangle(point:Point,triangle:TerrainTriangle):number|null {
  const denominator=cross(triangle[0],triangle[1],triangle[2]);if(Math.abs(denominator)<=EPS)return null;
  const first=cross(triangle[1],triangle[2],point)/denominator,second=cross(triangle[2],triangle[0],point)/denominator,third=1-first-second;
  return Math.min(first,second,third)>=-1e-7?first*triangle[0].z+second*triangle[1].z+third*triangle[2].z:null;
}
export function roadElevationAtPlanPoint(project:Project,item:ProfileRoad,point:Point):number|null{
  const profile=item.roadProfile,scale=municipalScale(project);if(!profile?.enabled)return item.elevation/100;if(!scale)return null;
  const physical={x:point.x*scale,y:point.y*scale};
  for(const triangle of cachedRoadDesignTriangles(project,item)){const elevation=elevationInTriangle(physical,triangle);if(elevation!==null)return elevation;}
  const station=roadStationAtPlanPoint(project,item,point);return station===null?null:roadProfileElevation(profile,station);
}
export function roadProfileAnalysis(project:ProfileProject,item:ProfileRoad){
  const profile=item.roadProfile,stations=roadStations(project,item),length=stations?.at(-1)??null;
  if(!profile?.enabled){const earthworkBalance=calculateEarthworkBalance({cutNaturalVolume:null,fillCompactedVolume:null,geometryComplete:false,geometryReasons:['请先启用道路纵断面，确认真实路床挖填量']},profile?.earthworkBalance);return{enabled:false,horizontalLength:length,designLength:length,maxAbsGrade:0,rows:[],segments:[],earthworks:null,earthworkBalance,pending:earthworkBalance.pending,pendingReasons:earthworkBalance.pendingReasons,verticalCurves:[],curveTolerance:DEFAULT_ROAD_CURVE_TOLERANCE,controlCount:0,crossSection:{leftSlope:0,rightSlope:0},sideSlopeDesign:roadSideSlopeDesign(project,item)};}
  validateRoadProfile(project,item,profile);
  const segments=roadProfileSegments(project,item),controls=roadControlStations(project,item),sampleStations=[...profile.points.map(point=>point.station),...(stations??[]),...controls];
  if(length!==null){const count=Math.min(2000,Math.max(1,Math.ceil(length/profile.sampleInterval)));for(let i=0;i<=count;i++)sampleStations.push(length*i/count);}
  const samples=[...new Set(sampleStations.map(value=>Number(value.toFixed(9))))].sort((a,b)=>a-b);
  const depth=(item.height+(item.items??[]).reduce((total,layer)=>total+layer.thickness,0))/100;
  const rows=samples.map(station=>{const point=roadPointAtStation(project,item,station),designElevation=roadProfileElevation(profile,station),groundElevation=point&&project.municipalTerrain?terrainElevation(project.municipalTerrain,point.x,point.y):null,crossSection=roadCrossSectionAtStation(profile,station);return{station,x:point?.x??null,y:point?.y??null,designElevation,leftElevation:designElevation+item.width/200*crossSection.leftSlope/100,rightElevation:designElevation+item.width/200*crossSection.rightSlope/100,...crossSection,formationElevation:designElevation-depth,groundElevation,cutDepth:groundElevation===null?null:Math.max(0,groundElevation-designElevation+depth),fillDepth:groundElevation===null?null:Math.max(0,designElevation-depth-groundElevation)};});
  const designTriangles=roadDesignTriangles(project,item),sideSlopeDesign=roadSideSlopeDesign(project,item),earthworkTriangles=excludeTunnelEarthworkTriangles(project,item,[...formationTriangles(project,item),...sideSlopeDesign.triangles],{extraWidth:profile.sideSlopes?.enabled?profile.sideSlopes.maxWidth:0});
  const designArea=earthworkTriangles.reduce((total,triangle)=>total+area(triangle),0);
  const volumes=project.municipalTerrain?calculateTerrainEarthworks(project.municipalTerrain,earthworkTriangles):{cutVolume:0,fillVolume:0,coveredArea:0,uncoveredArea:designArea,designArea};
  const enabled=Boolean(profile.earthwork?.enabled),coverageComplete=length!==null&&volumes.uncoveredArea<=Math.max(1e-7,volumes.designArea*1e-8),complete=coverageComplete&&sideSlopeDesign.complete,pendingReasons:string[]=[];
  if(enabled&&!coverageComplete)pendingReasons.push(length===null?'图纸尚未校准，纵断面及土方量待确认':'地形未完整覆盖道路施工范围，不能确定完整土方量');
  if(enabled&&!sideSlopeDesign.complete)pendingReasons.push(...sideSlopeDesign.warnings);
  // Fix geometric floating-point noise at the declared quantity precision
  // before exact money arithmetic (e.g. a 1e-48 m³ boundary sliver).
  const cost=(volume:number,price:string)=>price===''?null:formatMoney(multiplyDecimal(Math.abs(volume)<5e-10?'0':formatQuantity(volume,9),price));
  const cutCost=enabled?cost(volumes.cutVolume,profile.earthwork.cutUnitPrice):'0.00',fillCost=enabled?cost(volumes.fillVolume,profile.earthwork.fillUnitPrice):'0.00';
  if(enabled&&cutCost===null)pendingReasons.push('挖方尚未填写单价');if(enabled&&fillCost===null)pendingReasons.push('填方尚未填写单价');
  const knownCost=formatMoney(addDecimal(cutCost??'0',fillCost??'0')),pending=Boolean(pendingReasons.length);
  const earthworkBalance=calculateEarthworkBalance({cutNaturalVolume:volumes.cutVolume,fillCompactedVolume:volumes.fillVolume,geometryComplete:complete,
    geometryReasons:[...(!coverageComplete?[length===null?'图纸尚未校准，土方平衡须待真实尺寸确认':'地形未完整覆盖道路施工范围，不能用部分挖填量作完整土方平衡']:[]),...(!sideSlopeDesign.complete?sideSlopeDesign.warnings:[])]},profile.earthworkBalance);
  return{enabled:true,horizontalLength:length,designLength:segments.reduce((sum,segment)=>sum+segment.designLength,0),maxAbsGrade:Math.max(0,...segments.flatMap(segment=>[Math.abs(segment.startGrade),Math.abs(segment.endGrade)])),rows,segments,designTriangles,verticalCurves:roadVerticalCurves(profile),curveTolerance:profile.curveTolerance??DEFAULT_ROAD_CURVE_TOLERANCE,controlCount:controls.length,crossSection:profile.crossSection??{leftSlope:0,rightSlope:0},sideSlopeDesign,earthworkBalance,earthworks:{...volumes,formationDepth:depth,complete,coverageComplete,enabled,cutCost,fillCost,knownCost,total:pending?null:knownCost,pending,pendingReasons,pendingReason:pendingReasons.join('；')||null},pending:pending||earthworkBalance.pending,pendingReasons:[...pendingReasons,...earthworkBalance.pendingReasons]};
}
