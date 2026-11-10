import type { Project, ServicePoint, ServiceRoute, Point } from '../types.js';
import { normalizeDecimal } from './pricing.js';

export type ServiceSystem = 'power' | 'data' | 'water' | 'climate' | 'lighting';
export type ServicePreset = { id: string; name: string; system: ServiceSystem; spec: string; color: string; diameter: number; defaultHeight: number };
export const SERVICE_SYSTEMS: ReadonlyArray<{ id: ServiceSystem; name: string }> = [
  {id:'power',name:'强电'},{id:'data',name:'弱电与网络'},{id:'water',name:'给排水'},{id:'climate',name:'空调与暖通'},{id:'lighting',name:'照明'},
];
/** Editable nominal sizes and installation heights, never market prices or
 * an assumed code-compliant installation design. Dimensions are centimetres. */
export const SERVICE_PRESETS: ReadonlyArray<ServicePreset> = [
  {id:'bv15',name:'BV 1.5 电线',system:'power',spec:'BV 铜芯电线 1.5 mm²',color:'#b78969',diameter:.30,defaultHeight:270},
  {id:'bv25',name:'BV 2.5 电线',system:'power',spec:'BV 铜芯电线 2.5 mm²',color:'#b78969',diameter:.35,defaultHeight:270},
  {id:'bv4',name:'BV 4 电线',system:'power',spec:'BV 铜芯电线 4 mm²',color:'#b78969',diameter:.43,defaultHeight:270},
  {id:'bv6',name:'BV 6 电线',system:'power',spec:'BV 铜芯电线 6 mm²',color:'#b78969',diameter:.50,defaultHeight:270},
  {id:'bvr25',name:'BVR 2.5 软线',system:'power',spec:'BVR 铜芯软电线 2.5 mm²',color:'#b78969',diameter:.36,defaultHeight:270},
  {id:'power-conduit16',name:'强电穿线管 Ø16',system:'power',spec:'电工穿线管 外径 16 mm',color:'#bdad93',diameter:1.6,defaultHeight:270},
  {id:'power-conduit20',name:'强电穿线管 Ø20',system:'power',spec:'电工穿线管 外径 20 mm',color:'#bdad93',diameter:2,defaultHeight:270},
  {id:'power-conduit25',name:'强电穿线管 Ø25',system:'power',spec:'电工穿线管 外径 25 mm',color:'#bdad93',diameter:2.5,defaultHeight:270},
  {id:'data-conduit20',name:'弱电穿线管 Ø20',system:'data',spec:'弱电穿线管 外径 20 mm',color:'#8d9fbb',diameter:2,defaultHeight:270},
  {id:'cat6',name:'六类网线',system:'data',spec:'Cat 6 四对双绞线',color:'#8299b0',diameter:.65,defaultHeight:270},
  {id:'cat6a',name:'超六类网线',system:'data',spec:'Cat 6A 四对双绞线',color:'#8299b0',diameter:.80,defaultHeight:270},
  {id:'fiber',name:'入户光纤',system:'data',spec:'室内光纤线缆',color:'#8299b0',diameter:.30,defaultHeight:270},
  {id:'coaxial',name:'同轴电视线',system:'data',spec:'75 Ω 同轴电视线缆',color:'#8299b0',diameter:.70,defaultHeight:270},
  {id:'speaker',name:'音响线',system:'data',spec:'双芯音响连接线',color:'#8299b0',diameter:.50,defaultHeight:270},
  {id:'ppr-cold20',name:'PPR 冷水管 Ø20',system:'water',spec:'PPR 冷水管 外径 20 mm',color:'#749eaa',diameter:2,defaultHeight:20},
  {id:'ppr-hot20',name:'PPR 热水管 Ø20',system:'water',spec:'PPR 热水管 外径 20 mm',color:'#b98579',diameter:2,defaultHeight:20},
  {id:'ppr-cold25',name:'PPR 冷水管 Ø25',system:'water',spec:'PPR 冷水管 外径 25 mm',color:'#749eaa',diameter:2.5,defaultHeight:20},
  {id:'ppr-hot25',name:'PPR 热水管 Ø25',system:'water',spec:'PPR 热水管 外径 25 mm',color:'#b98579',diameter:2.5,defaultHeight:20},
  {id:'pvc-drain50',name:'PVC 排水管 Ø50',system:'water',spec:'PVC 排水管 外径 50 mm',color:'#91a08a',diameter:5,defaultHeight:5},
  {id:'pvc-drain110',name:'PVC 排水管 Ø110',system:'water',spec:'PVC 排水管 外径 110 mm',color:'#91a08a',diameter:11,defaultHeight:5},
  {id:'condensate25',name:'空调冷凝水管 Ø25',system:'climate',spec:'空调冷凝水排水管 外径 25 mm',color:'#829d91',diameter:2.5,defaultHeight:270},
  {id:'refrigerant635',name:'空调冷媒铜管 Ø6.35',system:'climate',spec:'冷媒铜管 外径 6.35 mm',color:'#b79b7e',diameter:.635,defaultHeight:270},
  {id:'refrigerant127',name:'空调冷媒铜管 Ø12.7',system:'climate',spec:'冷媒铜管 外径 12.7 mm',color:'#b79b7e',diameter:1.27,defaultHeight:270},
  {id:'fresh-air160',name:'新风圆形风管 Ø160',system:'climate',spec:'圆形新风风管 外径 160 mm',color:'#90a7a3',diameter:16,defaultHeight:260},
  {id:'floor-heating16',name:'地暖管 Ø16',system:'climate',spec:'地暖盘管 外径 16 mm',color:'#bba984',diameter:1.6,defaultHeight:-5},
  {id:'led-strip',name:'LED 灯带',system:'lighting',spec:'LED 灯带，实际规格由用户填写',color:'#bba974',diameter:1,defaultHeight:260},
  {id:'custom-line',name:'自定义线材 / 管道',system:'power',spec:'自定义规格与施工做法',color:'#83988d',diameter:1,defaultHeight:0},
];

export function servicePreset(id:string):ServicePreset {
  const preset=SERVICE_PRESETS.find(preset=>preset.id===id);
  if(!preset)throw new RangeError('管线预设不存在，请重新选择。');
  return preset;
}
export function validateServiceRoutes(value:unknown):asserts value is ServiceRoute[]|undefined {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>500)throw new RangeError('管线数据格式不正确，最多支持 500 条。');
  const ids=new Set<string>();
  for(const route of value){
    if(!route||typeof route.id!=='string'||!route.id.trim()||ids.has(route.id))throw new RangeError('管线编号不能为空或重复。');
    ids.add(route.id);servicePreset(route.presetId);
    if(typeof route.name!=='string'||!route.name.trim()||route.name.length>120)throw new RangeError('请填写管线名称（最多 120 字）。');
    if(typeof route.spec!=='string'||route.spec.length>200)throw new RangeError('管线规格格式不正确（最多 200 字）。');
    if(!Number.isFinite(route.diameter)||route.diameter<.02||route.diameter>100)throw new RangeError('管线外径应为 0.02–100 cm。');
    if(!Array.isArray(route.points)||route.points.length<2||route.points.length>200)throw new RangeError('一条管线需 2–200 个实际坐标点。');
    for(const point of route.points){
      if(!point||![point.x,point.y,point.z].every(Number.isFinite)||Math.abs(point.x)>1e9||Math.abs(point.y)>1e9||point.z< -100||point.z>2000)throw new RangeError('管线坐标必须有效，离本层地面高度应为 -100–2000 cm。');
    }
    if(!route.points.some((point,i)=>i>0&&(point.x!==route.points[i-1].x||point.y!==route.points[i-1].y||point.z!==route.points[i-1].z)))throw new RangeError('管线长度不能为零，请添加不同位置或高度的点。');
    if(!/^\d+$/.test(String(route.runs))||Number(route.runs)<1||Number(route.runs)>1000000)throw new RangeError('并行条数应为 1–1000000 的整数。');
    normalizeDecimal(route.extraLength,'每条预留长度');
    if(route.unitPrice!=='')normalizeDecimal(route.unitPrice,'管线单价');
    normalizeDecimal(route.wasteRate,'管线损耗率');normalizeDecimal(route.laborRate,'管线人工单价');normalizeDecimal(route.additionalCost,'管线固定费用');
    if(route.hidden!==undefined&&typeof route.hidden!=='boolean')throw new RangeError('管线显示状态不正确。');
  }
}

export function createServiceRoute(presetId:string,points:ReadonlyArray<Point&Partial<Pick<ServicePoint,'z'>>>,project?:Pick<Project,'serviceRoutes'>):ServiceRoute {
  const preset=servicePreset(presetId),count=(project?.serviceRoutes??[]).filter(route=>route.presetId===presetId).length;
  const route:ServiceRoute={id:'service-'+(globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+Math.random().toString(36).slice(2)),name:preset.name+(count?' '+(count+1):''),presetId,points:points.map(point=>({...point,z:point.z??preset.defaultHeight})),spec:preset.spec,diameter:preset.diameter,runs:'1',extraLength:'0',unitPrice:'',wasteRate:'0',laborRate:'0',additionalCost:'0',hidden:false};
  validateServiceRoutes([route]);return route;
}
export type ServiceMetrics={pathLength:number|null;netQuantity:number|null;purchaseQuantity:number|null};
/** The 3D polyline is measured in physical metres. Camera zoom/pan, line
 * diameter, visibility and template appearance never enter its length. */
export function serviceMetrics(route:ServiceRoute,project:Pick<Project,'drawing'|'calibration'>):ServiceMetrics {
  validateServiceRoutes([route]);
  const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
  if(!Number.isFinite(scale)||scale<=0)return{pathLength:null,netQuantity:null,purchaseQuantity:null};
  let pathLength=0,compensation=0;
  for(let i=1;i<route.points.length;i++){
    const a=route.points[i-1],b=route.points[i],segment=Math.hypot((b.x-a.x)*scale,(b.y-a.y)*scale,(b.z-a.z)*.01),corrected=segment-compensation,next=pathLength+corrected;compensation=(next-pathLength)-corrected;pathLength=next;
  }
  const netQuantity=(pathLength+Number(route.extraLength))*Number(route.runs),purchaseQuantity=netQuantity*(1+Number(route.wasteRate)/100);
  if(![pathLength,netQuantity,purchaseQuantity].every(Number.isFinite))throw new RangeError('管线长度超出可计算范围。');
  return{pathLength,netQuantity,purchaseQuantity};
}
export const routeMetrics=serviceMetrics;

/** Finds the closest existing actual node for a UI endpoint magnet. The
 * returned point is a copy; editing a draft cannot mutate a saved route. */
export function nearestServicePoint(point:Point,routes:ServiceRoute[]|undefined,tolerance:number):ServicePoint|null {
  let nearest:ServicePoint|null=null,best=tolerance;
  for(const route of routes??[])if(!route.hidden)for(const candidate of route.points){const distance=Math.hypot(candidate.x-point.x,candidate.y-point.y);if(distance<=best){nearest=candidate;best=distance;}}
  return nearest?{...nearest}:null;
}
