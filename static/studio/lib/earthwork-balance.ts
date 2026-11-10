import { addDecimal, formatMoney, formatQuantity, multiplyDecimal, normalizeDecimal } from './pricing.js';

export type EarthworkMaterialBudget = { enabled:boolean; unitPrice:string };
export type EarthworkHaulBudget = EarthworkMaterialBudget & { distanceKm:string };
/** All coefficients and prices are explicitly supplied decimal strings. */
export type RoadEarthworkBalance = {
  enabled:boolean;
  usableCutPercent:string;
  naturalPerCompactedFill:string;
  loosePerNatural:string;
  borrowMaterial:EarthworkMaterialBudget;
  reuseHaul:EarthworkHaulBudget;
  borrowHaul:EarthworkHaulBudget;
  spoilHaul:EarthworkHaulBudget;
};
export type EarthworkBalanceInput = {
  cutNaturalVolume:number|null;
  fillCompactedVolume:number|null;
  geometryComplete:boolean;
  geometryReasons?:string[];
};
export type EarthworkBalanceVolumes = {
  usableCutNatural:string;
  fillDemandNatural:string;
  reuseNatural:string;
  borrowNatural:string;
  spoilNatural:string;
  reuseLoose:string;
  borrowLoose:string;
  spoilLoose:string;
};
export type EarthworkBalanceItemKey = 'borrow-material'|'reuse-haul'|'borrow-haul'|'spoil-haul';
export type EarthworkBalanceItem = {
  key:EarthworkBalanceItemKey;
  name:string;
  quantity:string|null;
  unit:'m³'|'m³·km';
  unitPrice:string;
  amount:string|null;
  pending:boolean;
  pendingReasons:string[];
  pendingReason:string|null;
};
export type EarthworkBalanceResult = {
  enabled:boolean;
  complete:boolean;
  pending:boolean;
  pendingReasons:string[];
  pendingReason:string|null;
  cutNaturalVolume:number|null;
  fillCompactedVolume:number|null;
  volumes:EarthworkBalanceVolumes|null;
  items:EarthworkBalanceItem[];
  knownCost:string;
  totalCost:string|null;
};

/** No preset soil, price, haulage distance or stripping allowance. */
export function createEarthworkBalance():RoadEarthworkBalance {
  return {enabled:false,usableCutPercent:'',naturalPerCompactedFill:'',loosePerNatural:'',
    borrowMaterial:{enabled:false,unitPrice:''},
    reuseHaul:{enabled:false,distanceKm:'',unitPrice:''},
    borrowHaul:{enabled:false,distanceKm:'',unitPrice:''},
    spoilHaul:{enabled:false,distanceKm:'',unitPrice:''}};
}

function optionalDecimal(value:unknown,label:string,maximum?:number,positive=false):void {
  if(typeof value!=='string')throw new RangeError(`${label}须为十进制字符串，待填写时留空。`);
  if(value==='')return;
  const normalized=normalizeDecimal(value,label,maximum===undefined?{}:{max:maximum});
  if(positive&&normalized==='0')throw new RangeError(`${label}必须大于零。`);
}
export function validateEarthworkBalance(config?:RoadEarthworkBalance):void {
  if(config===undefined)return;
  if(!config||typeof config!=='object'||typeof config.enabled!=='boolean')throw new RangeError('土方平衡配置无效。');
  optionalDecimal(config.usableCutPercent,'可利用挖方比例',100);
  optionalDecimal(config.naturalPerCompactedFill,'每压实方所需天然方',1000,true);
  optionalDecimal(config.loosePerNatural,'天然方转松方系数',1000,true);
  for(const key of ['borrowMaterial','reuseHaul','borrowHaul','spoilHaul'] as const){
    const budget=config[key];
    if(!budget||typeof budget!=='object'||typeof budget.enabled!=='boolean')throw new RangeError('土方平衡计价开关无效。');
    optionalDecimal(budget.unitPrice,'土方平衡单价');
    if(key!=='borrowMaterial')optionalDecimal((budget as EarthworkHaulBudget).distanceKm,'土方运距');
  }
}

// Geometric quantities follow the same 9-place boundary as road quotation.
// Never pre-round with toFixed: that changes half-cent results at high prices.
const volumeDecimal=(volume:number)=>Math.abs(volume)<5e-10?'0':formatQuantity(volume,9);
const subtract=(a:string,b:string)=>addDecimal(a,multiplyDecimal(b,'-1'));
const minimum=(a:string,b:string)=>subtract(a,b).startsWith('-')?a:b;

/** Single-road natural-volume conservation, followed by loose-volume haulage.
 * Incomplete surveyed geometry invalidates the whole balance, not just one side.
 * Existing cut/fill comprehensive costs are deliberately outside this engine. */
export function calculateEarthworkBalance(input:EarthworkBalanceInput,config?:RoadEarthworkBalance):EarthworkBalanceResult {
  validateEarthworkBalance(config);
  if(!input||typeof input.geometryComplete!=='boolean')throw new RangeError('土方测量完整性状态无效。');
  for(const value of [input.cutNaturalVolume,input.fillCompactedVolume])if(value!==null&&(!Number.isFinite(value)||(value<0&&Math.abs(value)>=5e-10)))throw new RangeError('土方几何量必须为非负有限数。');
  const result:EarthworkBalanceResult={enabled:Boolean(config?.enabled),complete:true,pending:false,pendingReasons:[],pendingReason:null,
    cutNaturalVolume:input.cutNaturalVolume,fillCompactedVolume:input.fillCompactedVolume,volumes:null,items:[],knownCost:'0.00',totalCost:'0.00'};
  if(!config?.enabled)return result;
  const reasons:string[]=[];
  if(!input.geometryComplete||input.cutNaturalVolume===null||input.fillCompactedVolume===null)reasons.push(...(input.geometryReasons?.filter(Boolean).length?input.geometryReasons.filter(Boolean):['测量地形或道路设计范围不完整，土方平衡须待完整几何确认']));
  for(const [field,label] of [['usableCutPercent','可利用挖方比例'],['naturalPerCompactedFill','每压实方所需天然方'],['loosePerNatural','天然方转松方系数']] as const)if(config[field]==='')reasons.push(`${label}待填写`);
  if(!reasons.length){
    const cut=volumeDecimal(input.cutNaturalVolume),fill=volumeDecimal(input.fillCompactedVolume),usableCutNatural=multiplyDecimal(cut,multiplyDecimal(config.usableCutPercent,'.01')),
      fillDemandNatural=multiplyDecimal(fill,config.naturalPerCompactedFill),reuseNatural=minimum(usableCutNatural,fillDemandNatural),
      borrowNatural=subtract(fillDemandNatural,reuseNatural),spoilNatural=subtract(cut,reuseNatural);
    result.volumes={usableCutNatural,fillDemandNatural,reuseNatural,borrowNatural,spoilNatural,
      reuseLoose:multiplyDecimal(reuseNatural,config.loosePerNatural),borrowLoose:multiplyDecimal(borrowNatural,config.loosePerNatural),spoilLoose:multiplyDecimal(spoilNatural,config.loosePerNatural)};
  }
  const definitions:[EarthworkBalanceItemKey,string,EarthworkMaterialBudget|EarthworkHaulBudget,string|null,boolean][]=[
    ['borrow-material','借方材料（天然方）',config.borrowMaterial,result.volumes?.borrowNatural??null,false],
    ['reuse-haul','场内复用运输（松方×运距）',config.reuseHaul,result.volumes?.reuseLoose??null,true],
    ['borrow-haul','借方运输（松方×运距）',config.borrowHaul,result.volumes?.borrowLoose??null,true],
    ['spoil-haul','弃方运输（松方×运距）',config.spoilHaul,result.volumes?.spoilLoose??null,true]
  ];
  // Each item depends on the same stable geometry/coefficient prerequisites.
  // Aggregate reasons below must never feed back into subsequent item reasons.
  const baseReasons=[...new Set(reasons)];
  for(const [key,name,budget,volume,haul] of definitions){
    if(!budget.enabled)continue;
    const pendingReasons=volume===null?[...baseReasons]:[];
    let quantity=volume;
    if(haul&&volume!==null&&volume!=='0'){
      const distance=(budget as EarthworkHaulBudget).distanceKm;
      if(distance===''){quantity=null;pendingReasons.push(`${name}运距待填写（km）`);}
      else quantity=multiplyDecimal(volume,distance);
    }
    if(quantity!==null&&quantity!=='0'&&budget.unitPrice==='')pendingReasons.push(`${name}单价待填写`);
    const pending=pendingReasons.length>0,amount=pending?null:quantity==='0'?'0.00':formatMoney(multiplyDecimal(quantity,budget.unitPrice));
    result.items.push({key,name,quantity,unit:haul?'m³·km':'m³',unitPrice:budget.unitPrice===''?'':normalizeDecimal(budget.unitPrice),amount,pending,pendingReasons,pendingReason:pendingReasons.join('；')||null});
    result.knownCost=formatMoney(addDecimal(result.knownCost,amount??'0'));
    reasons.push(...pendingReasons);
  }
  result.pendingReasons=[...new Set(reasons)];result.pendingReason=result.pendingReasons.join('；')||null;
  result.pending=result.pendingReasons.length>0;result.complete=!result.pending;result.totalCost=result.pending?null:result.knownCost;
  return result;
}
