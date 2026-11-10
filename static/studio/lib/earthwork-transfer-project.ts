import type { Project } from '../types.js';
import type { EarthworkBalanceResult, RoadEarthworkBalance, EarthworkHaulBudget } from './earthwork-balance.js';
import { calculateEarthworkTransfer, createEarthworkTransfer, validateEarthworkTransferConfig, type EarthworkTransferConfig, type EarthworkTransferResult } from './earthwork-transfer.js';
import { roadProfileAnalysis } from './road-profile.js';
import { addDecimal, multiplyDecimal, normalizeDecimal, formatMoney } from './pricing.js';

const subtract=(a:string,b:string)=>addDecimal(a,multiplyDecimal(b,'-1'));

/** Measures the actual selected roads. A budget multiplier is never interpreted
 * as a second physical excavation or a second source of reusable soil. */
export function analyzeProjectEarthworkTransfer(project:Project,config:EarthworkTransferConfig=project.municipalEarthworkTransfer??createEarthworkTransfer()):EarthworkTransferResult {
  validateEarthworkTransferConfig(config);
  if(!config.enabled)return calculateEarthworkTransfer({roads:[]},config);
  const elements=new Map((project.municipalElements??[]).map(element=>[element.id,element]));
  const roads=config.roadIds.flatMap(id=>{
    const element=elements.get(id);if(!element)return[];
    const profile=element.roadProfile;
    const reasons:string[]=[];
    if(element.kind!=='road')reasons.push('所选对象不是道路');
    if(!profile?.enabled)reasons.push('请先启用道路纵断面');
    if(!profile?.earthworkBalance?.enabled)reasons.push('请先启用并填写道路土方平衡');
    if(normalizeDecimal(element.quantity)!=='1')reasons.push('跨道路调配要求每条实绘道路的预算份数为 1');
    const analysis=element.kind==='road'&&profile?.enabled?roadProfileAnalysis(project,element):null;
    const volumes=analysis?.earthworkBalance.volumes;
    if(analysis&&!volumes)reasons.push(...analysis.earthworkBalance.pendingReasons);
    // Pricing prerequisites do not invalidate physical quantities. Transfer can
    // remove a borrow/spoil charge entirely, making its blank rate unnecessary.
    return[{id,name:element.name,availableNatural:volumes?subtract(volumes.usableCutNatural,volumes.reuseNatural):null,
      borrowNatural:volumes?.borrowNatural??null,spoilNatural:volumes?.spoilNatural??null,
      loosePerNatural:profile?.earthworkBalance?.loosePerNatural||null,complete:reasons.length===0&&Boolean(volumes),pendingReasons:[...new Set(reasons)]}];
  });
  return calculateEarthworkTransfer({roads},config);
}

/** Preserve local reuse, then replace only external borrow and spoil quantities.
 * Re-evaluate optional charges from their final quantities, before rounding. */
export function applyEarthworkTransferToBalance(base:EarthworkBalanceResult,config:RoadEarthworkBalance,plan:EarthworkTransferResult,roadId:string):EarthworkBalanceResult {
  const road=plan.roads.find(road=>road.id===roadId);
  if(!plan.enabled||!road)return base;
  const result=structuredClone(base),ready=!plan.pending;
  if(ready&&result.volumes){
    Object.assign(result.volumes,{borrowNatural:road.residualBorrowNatural,spoilNatural:road.residualSpoilNatural,
      borrowLoose:multiplyDecimal(road.residualBorrowNatural,config.loosePerNatural),spoilLoose:multiplyDecimal(road.residualSpoilNatural,config.loosePerNatural)});
  }else result.volumes=null;
  const reasons=ready?[]:[...plan.pendingReasons];
  result.items=result.items.map(item=>{
    if(item.key==='reuse-haul')return item;
    const budget=item.key==='borrow-material'?config.borrowMaterial:item.key==='borrow-haul'?config.borrowHaul:config.spoilHaul;
    const haul=item.key!=='borrow-material';
    let quantity=ready?(item.key==='spoil-haul'?result.volumes?.spoilLoose:item.key==='borrow-haul'?result.volumes?.borrowLoose:result.volumes?.borrowNatural)??null:null;
    const pendingReasons=quantity===null?[...plan.pendingReasons]:[];
    if(haul&&quantity!==null&&quantity!=='0'){
      const distance=(budget as EarthworkHaulBudget).distanceKm;
      if(distance===''){quantity=null;pendingReasons.push(item.name+'运距待填写（km）');}
      else quantity=multiplyDecimal(quantity,distance);
    }
    if(quantity!==null&&quantity!=='0'&&budget.unitPrice==='')pendingReasons.push(item.name+'单价待填写');
    const pending=pendingReasons.length>0,amount=pending?null:quantity==='0'?'0.00':formatMoney(multiplyDecimal(quantity,budget.unitPrice));
    return{...item,quantity,amount,pending,pendingReasons,pendingReason:pendingReasons.join('；')||null};
  });
  result.pendingReasons=[...new Set([...reasons,...result.items.flatMap(item=>item.pendingReasons)])];
  result.pending=result.pendingReasons.length>0;result.complete=!result.pending;result.pendingReason=result.pendingReasons.join('；')||null;
  result.knownCost=formatMoney(result.items.reduce((total,item)=>addDecimal(total,item.amount??'0'),'0'));
  result.totalCost=result.pending?null:result.knownCost;
  return result;
}
