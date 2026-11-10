import type { Project } from '../types.js';
import { addDecimal, multiplyDecimal, normalizeDecimal, formatMoney, formatQuantity } from './pricing.js';
import { buildMunicipalQuantities, municipalElementPreset, municipalBridgeQuantities, isMunicipalSurface, isMunicipalPath, type MunicipalElement, type MunicipalLayer, type MunicipalMetrics } from './municipal-design.js';
import { roadProfileAnalysis, validateRoadProfile } from './road-profile.js';
import { validateTerrain } from './terrain.js';
import { analyzeProjectEarthworkTransfer, applyEarthworkTransferToBalance } from './earthwork-transfer-project.js';
import type { EarthworkTransferResult } from './earthwork-transfer.js';
import { sourcePriceMetadata } from './price-provenance.js';
import { roadTunnelAnalysis } from './road-tunnel.js';
const cents=(value:string)=>BigInt(formatMoney(value).replace('.',''));
const money=(value:bigint)=>{const negative=value<0n,digits=(negative?-value:value).toString().padStart(3,'0');return`${negative?'-':''}${digits.slice(0,-2)}.${digits.slice(-2)}`;};
const sum=(values:string[])=>money(values.reduce((total,value)=>total+cents(value??'0'),0n));
const percent=(value:string)=>multiplyDecimal(value,'.01');
// Geometry is measured in IEEE coordinates. Quantize to 9 physical decimal
// places before exact pricing, preventing an immaterial rotation round-off
// from flipping an exact half-cent (20m² must stay 20m² in every orientation).
// Clipping can also leave subnormal positive volumes. Values below half the
// same quantum round to zero before reaching the bounded decimal parser.
const scaled=(value:number|null,count:string)=>value===null?null:multiplyDecimal(Math.abs(value)<5e-10?'0':formatQuantity(value,9),count);
function amount(input:{id:string;name:string;unit:string;netQuantity:string|null;unitPrice:string;wasteRate:string;laborRate:string;additionalCost:string;thickness?:number}){
  const missingQuantity=input.netQuantity===null,missingPrice=input.unitPrice==='';
  const purchaseQuantity=missingQuantity?null:multiplyDecimal(input.netQuantity,addDecimal('1',percent(input.wasteRate)));
  const materialCost=missingQuantity||missingPrice?null:formatMoney(multiplyDecimal(purchaseQuantity,input.unitPrice));
  const laborCost=missingQuantity?null:formatMoney(multiplyDecimal(input.netQuantity,input.laborRate));
  const additionalCost=formatMoney(input.additionalCost),knownMaterialCost=materialCost??'0.00',knownLaborCost=laborCost??'0.00';
  const reasons=[...(missingQuantity?['请校准图纸，实际工程量待确认']:[]),...(missingPrice?[input.name+'尚未填写单价']:[])],pending=Boolean(reasons.length),knownTotal=sum([knownMaterialCost,knownLaborCost,additionalCost]);
  return{...input,materialId:input.id,materialName:input.name,quantity:input.netQuantity,quantityMode:'manual',purchaseQuantity,materialCost,laborCost,additionalCost,knownMaterialCost,knownLaborCost,knownTotal,pending,pendingReasons:reasons,pendingReason:reasons.join('；')||null,total:pending?null:knownTotal,status:pending?'pending':'ready'};
}
function netQuantity(element:MunicipalElement,metrics:MunicipalMetrics){
  if(element.unit==='件')return normalizeDecimal(element.quantity,'市政数量');
  return scaled(element.unit==='m'?metrics.length:element.unit==='m³'?metrics.volume:metrics.area,element.quantity);
}
function priceElement(input:ReturnType<typeof buildMunicipalQuantities>[number],project:Project,transfer:EarthworkTransferResult){
  const {element,metrics}=input,preset=municipalElementPreset(element);
  const primary=amount({id:element.id+':main',name:preset.name+(element.kind==='pipeline'&&element.unit==='m³'?'管沟开挖':''),unit:element.unit,netQuantity:netQuantity(element,metrics),unitPrice:element.unitPrice,wasteRate:element.wasteRate,laborRate:element.laborRate,additionalCost:'0',thickness:element.height});
  Object.assign(primary,sourcePriceMetadata(element));
  const items=[primary,...(element.items??[]).map(layer=>Object.assign(amount({id:layer.id,name:layer.name,unit:layer.unit,netQuantity:metrics.area===null?null:multiplyDecimal(scaled(metrics.area,element.quantity),layer.unit==='m³'?multiplyDecimal(layer.thickness,'.01'):'1'),unitPrice:layer.unitPrice,wasteRate:layer.wasteRate,laborRate:layer.laborRate,additionalCost:layer.additionalCost,thickness:layer.thickness}),sourcePriceMetadata(layer)))];
  const tunnelEngineering=element.kind==='road'&&element.tunnel?.enabled?roadTunnelAnalysis(project,element):undefined;
  if(tunnelEngineering?.enabled&&element.tunnel.pricingEnabled){
    const item=amount({id:element.id+':tunnel',name:'隧道综合施工',unit:'m',netQuantity:scaled(tunnelEngineering.length,element.quantity),unitPrice:element.tunnel.unitPrice,wasteRate:'0',laborRate:element.tunnel.laborRate,additionalCost:element.tunnel.additionalCost});
    items.push(Object.assign(item,sourcePriceMetadata(element.tunnel),{category:'tunnel',measuredLength:tunnelEngineering.length,quantityBasis:'真实三维隧道路线长度 × 预算份数，按米综合计价'}));
  }
  const bridgeEngineering=element.kind==='bridge'?municipalBridgeQuantities(element,project):undefined;
  if(bridgeEngineering)for(const [key,name,unit,enabled,price,measured] of [
    ['piers','中间桥墩','件',element.bridgeOptions?.pierPricingEnabled,element.bridgeOptions?.pierUnitPrice??'',bridgeEngineering.pierCount],
    ['railings','两侧桥栏杆','m',element.bridgeOptions?.railingPricingEnabled,element.bridgeOptions?.railingUnitPrice??'',bridgeEngineering.railingLength]
  ] as const){
    if(!enabled)continue;
    const net=scaled(measured,element.quantity),item=amount({id:element.id+':bridge:'+key,name,unit,netQuantity:net,unitPrice:net==='0'&&price===''?'0':price,wasteRate:'0',laborRate:'0',additionalCost:'0'});
    item.unitPrice=price;
    items.push(Object.assign(item,{category:'bridge',bridgePart:key,quantityBasis:key==='piers'?'实际轴长按墩间距设置中间墩，不含端部桥台':'真实桥面两侧边界长，不含端部横栏'}));
  }
  const analysis=element.kind==='road'&&element.roadProfile&&(element.roadProfile.enabled||element.roadProfile.earthworkBalance?.enabled)?roadProfileAnalysis(project,element):null,earth=analysis?.earthworks;
  const transferRoad=transfer.enabled?transfer.roads.find(road=>road.id===element.id):undefined;
  const balance=analysis?.earthworkBalance?.enabled&&transferRoad?applyEarthworkTransferToBalance(analysis.earthworkBalance,element.roadProfile.earthworkBalance,transfer,element.id):analysis?.earthworkBalance;
  if(earth?.enabled)for(const [key,name,price]of [['cutVolume','路床挖方',element.roadProfile.earthwork.cutUnitPrice],['fillVolume','路床填方',element.roadProfile.earthwork.fillUnitPrice]]as const){
    const item=amount({id:element.id+':'+key,name,unit:'m³',netQuantity:earth.complete?scaled(earth[key],element.quantity):null,unitPrice:price,wasteRate:'0',laborRate:'0',additionalCost:'0'});
    if(!earth.complete){
      item.pendingReasons=[earth.pendingReason??'地形未完整覆盖道路施工范围，完整路床土方量待确认',...item.pendingReasons.filter(reason=>!reason.includes('校准'))];item.pendingReason=item.pendingReasons.join('；');
      item.knownMaterialCost=price===''?'0.00':formatMoney(multiplyDecimal(scaled(earth[key],element.quantity),price));item.knownTotal=item.knownMaterialCost;
    }
    items.push(Object.assign(item,{category:'earthwork',measuredCoveredVolume:earth[key],coverageArea:earth.coveredArea,designArea:earth.designArea}));
  }
  if(balance?.enabled)for(const source of balance.items){
    const quantity=source.quantity===null?null:multiplyDecimal(source.quantity,element.quantity);
    // Zero measured flow has zero cost even while its future unit rate is blank.
    // Keep the user's blank rate in the quote; no market price is inferred.
    const calculationPrice=quantity==='0'&&source.unitPrice===''?'0':source.unitPrice;
    const item=amount({id:element.id+':balance:'+source.key,name:source.name,unit:source.unit,netQuantity:quantity,unitPrice:calculationPrice,wasteRate:'0',laborRate:'0',additionalCost:'0'});
    item.unitPrice=source.unitPrice;
    if(source.pending){item.pending=true;item.status='pending';item.pendingReasons=[...source.pendingReasons];item.pendingReason=source.pendingReason;item.total=null;}
    items.push(Object.assign(item,{category:'earthwork-balance',balanceKey:source.key,quantityBasis:source.unit==='m³·km'?'松方 × 运距':'借方天然体积'}));
  }
  if(transfer.enabled)for(const route of transfer.routes.filter(route=>route.fromRoadId===element.id)){
    const quantity=route.haulQuantity,calculationPrice=quantity==='0'&&route.unitPrice===''?'0':route.unitPrice;
    const item=amount({id:element.id+':transfer:'+route.id,name:'跨道路运输：'+route.name,unit:'m³·km',netQuantity:quantity,unitPrice:calculationPrice,wasteRate:'0',laborRate:'0',additionalCost:'0'});
    item.unitPrice=route.unitPrice;
    if(route.pending){item.pending=true;item.status='pending';item.pendingReasons=[...route.pendingReasons];item.pendingReason=route.pendingReason;item.total=null;}
    items.push(Object.assign(item,{category:'earthwork-transfer',transferRouteId:route.id,quantityBasis:'来源道路松方 × 运距',transferRoute:route}));
  }
  const additionalCost=formatMoney(element.additionalCost),itemAdditionalCost=sum(items.map(item=>item.additionalCost));
  const knownMaterialCost=sum(items.map(item=>item.knownMaterialCost)),knownLaborCost=sum(items.map(item=>item.knownLaborCost)),knownSubtotal=sum([knownMaterialCost,knownLaborCost,additionalCost,itemAdditionalCost]);
  const pendingReasons=[...new Set([...items.flatMap(item=>item.pendingReasons),...(balance?.enabled&&balance.pending?balance.pendingReasons:[])])],pending=Boolean(pendingReasons.length);
  const engineeringWarnings=[...(tunnelEngineering?.warnings??[]),...(tunnelEngineering?.enabled?['隧道段保留道路铺筑工程量；隧道覆土不计入普通路床挖填。隧道施工费用仅在开启独立计费时按真实三维长度计米，请核对主项综合价包含范围。']:[]),...(analysis?[
    ...(element.roadProfile.points.some(point=>(point.curveLength??0)>0)?[`竖曲线按 ${element.roadProfile.curveTolerance??.002} m 最大弦高误差构造控制面，挖填量按该控制面计量。`]:[]),
    ...(element.roadProfile.crossfallPoints?.length?[`左右横坡按用户里程表线性过渡，路面按 ${element.roadProfile.curveTolerance??.002} m 高程误差上限构造；未自动套用道路等级或超高规范。`]:[]),
    ...(balance?.enabled?[transferRoad?'已应用工程跨道路调配：优先最大场内复用，再在同复用量下最小运输费用；原挖填综合单价是否包含运输请按报价范围确认。':'土方调配按单条实绘道路计算，借方与运输费用仅按勾选项计入；请按实际报价范围确认其与原挖填综合单价的包含关系。']:[]),
    ...(element.roadProfile.sideSlopes?.enabled?[`边坡按 ${element.roadProfile.sideSlopes.interval??2} m 沿线断面构造控制面，未测范围不外推。`]:[])
  ]:[])];
  const roadEngineering=analysis?{
    horizontalLength:analysis.horizontalLength,designLength:analysis.designLength,maxAbsGrade:analysis.maxAbsGrade,
    crossSection:element.roadProfile.crossSection,crossfallPoints:element.roadProfile.crossfallPoints,
    sideSlopes:element.roadProfile.sideSlopes,curveTolerance:element.roadProfile.curveTolerance,
    verticalCurves:element.roadProfile.points.filter(point=>(point.curveLength??0)>0).map(point=>({station:point.station,elevation:point.elevation,length:point.curveLength})),earthworks:earth,
    earthworkBalance:balance,earthworkBalanceConfig:element.roadProfile.earthworkBalance,
    ...(transferRoad?{interRoadTransfer:transferRoad,earthworkBalanceBeforeTransfer:analysis.earthworkBalance}: {})
  }:undefined;
  return{...element,surfaceType:'municipal',category:preset.category,color:preset.color,...metrics,warnings:[...metrics.warnings,...engineeringWarnings],items,roadEngineering,bridgeEngineering,tunnelEngineering,netQuantity:primary.netQuantity,purchaseQuantity:primary.purchaseQuantity,materialCost:pending?null:knownMaterialCost,laborCost:pending?null:knownLaborCost,knownMaterialCost,knownLaborCost,additionalCost,itemAdditionalCost,knownSubtotal,knownTotal:knownSubtotal,subtotal:pending?null:knownSubtotal,total:pending?null:knownSubtotal,pending,status:pending?'pending':'ready',pendingReasons,pendingReason:pendingReasons.join('；')||null};
}
/** An outdoor site budget independent from building storeys, room coverings,
 * structural design and the earlier municipal indicator cost worksheet. */
export function calculateMunicipalProject(project: Project){
  if(!project||!Array.isArray(project.regions))throw new RangeError('市政项目数据格式不正确。');
  validateTerrain(project.municipalTerrain);for(const element of project.municipalElements??[])validateRoadProfile(project,element);
  const transfer=analyzeProjectEarthworkTransfer(project);
  const rows=buildMunicipalQuantities(project).map(input=>priceElement(input,project,transfer)),projectAdditionalCost=formatMoney(normalizeDecimal(project.additionalCost??'0','项目固定费用')),taxRate=normalizeDecimal(project.taxRate??'0','税率');
  const knownMaterialCost=sum(rows.map(row=>row.knownMaterialCost)),knownLaborCost=sum(rows.map(row=>row.knownLaborCost));
  const additionalCost=sum([projectAdditionalCost,...rows.map(row=>row.additionalCost),...rows.map(row=>row.itemAdditionalCost)]),knownSubtotal=sum([knownMaterialCost,knownLaborCost,additionalCost]);
  const tax=formatMoney(multiplyDecimal(knownSubtotal,percent(taxRate))),pendingReasons=[...new Set([...rows.flatMap(row=>row.pendingReasons.map(reason=>row.name+'：'+reason)),...transfer.pendingReasons])],pending=Boolean(pendingReasons.length);
  const surfaceRows=rows.filter(row=>isMunicipalSurface(row.kind)),pathRows=rows.filter(row=>isMunicipalPath(row.kind));
  const quantities=(source:typeof rows,field:string)=>source.some(row=>row[field]===null)?null:Number(source.reduce((total,row)=>addDecimal(total,row[field]),'0'));
  return{kind:'municipal',projectId:project.id,name:project.name,currency:'CNY',status:pending?'pending':'ready',pending,pendingReasons,pendingReason:pendingReasons.join('；')||null,warnings:[...new Set(rows.flatMap(row=>row.warnings))],regions:[],walls:[],furniture:[],ceilings:[],serviceRoutes:[],civilElements:[],municipalElements:rows,...(project.municipalEarthworkTransfer?{earthworkTransfer:transfer}:{}),netArea:quantities(surfaceRows,'area'),grossArea:quantities(surfaceRows,'grossArea'),totalLength:quantities(pathRows,'length'),length:quantities(pathRows,'length'),netVolume:quantities(surfaceRows,'volume'),knownMaterialCost,knownLaborCost,materialCost:pending?null:knownMaterialCost,laborCost:pending?null:knownLaborCost,additionalCost,projectAdditionalCost,taxRate,tax:pending?null:tax,knownTax:tax,knownSubtotal,knownTotal:knownSubtotal,subtotal:pending?null:knownSubtotal,beforeTax:pending?null:knownSubtotal,total:pending?null:sum([knownSubtotal,tax]),knownFurnitureCost:'0.00',knownServiceCost:'0.00',serviceLength:0,servicePathLength:0};
}
export function validateMunicipalProject(project: Project): void {calculateMunicipalProject(project);}
