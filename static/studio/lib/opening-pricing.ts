import type { WallOpening } from './wall-solid.js';
import { openingPolygon } from './wall-solid.js';
import { polygonArea, validatePolygon } from './geometry.js';
import { addDecimal, multiplyDecimal, normalizeDecimal, formatMoney } from './pricing.js';
import { sourcePriceMetadata } from './price-provenance.js';

export type OpeningQuoteConfig = {
  enabled: boolean;
  unit: '件' | 'm²' | 'm';
  quantity: string;
  unitPrice: string;
  wasteRate: string;
  laborRate: string;
  additionalCost: string;
};
const title = (opening: WallOpening) => opening.name || ({door:'门',window:'窗',hole:'墙面开孔'}[opening.kind]);
const cents = (value: string) => BigInt(formatMoney(value).replace('.', ''));
const money = (amount: bigint) => { const sign=amount<0n?'-':'',digits=(amount<0n?-amount:amount).toString().padStart(3,'0');return sign+digits.slice(0,-2)+'.'+digits.slice(-2); };
const sum = (...amounts: string[]) => money(amounts.reduce((total,amount)=>total+cents(amount),0n));

/** Old projects opt in explicitly, preserving their saved wall-only budget.
 * A price is never supplied by a preset or inferred from an opening's shape. */
export function defaultOpeningQuote(opening?: WallOpening): OpeningQuoteConfig {
  return {enabled:false,unit:'件',quantity:'1',unitPrice:'',wasteRate:'0',laborRate:'0',additionalCost:'0',...(opening?.quote ?? {})};
}

export function validateOpeningQuote(opening: WallOpening): OpeningQuoteConfig | null {
  const supplied=opening.quote;
  if(supplied===undefined)return null;
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))throw new RangeError('开口报价应为有效配置。');
  if(typeof supplied.enabled!=='boolean')throw new RangeError('开口报价启用状态必须是布尔值。');
  const input=defaultOpeningQuote(opening);
  if(!['件','m²','m'].includes(input.unit))throw new RangeError('开口计价单位应为件、m²或m。');
  return {...input,quantity:normalizeDecimal(input.quantity,'开口计价数量'),
    unitPrice:input.unitPrice===''?'':normalizeDecimal(input.unitPrice,'开口单价'),
    wasteRate:normalizeDecimal(input.wasteRate,'开口损耗率'),laborRate:normalizeDecimal(input.laborRate,'开口人工单价'),
    additionalCost:normalizeDecimal(input.additionalCost,'开口固定费用')};
}

/** Geometric quantity is measured from the unpositioned real contour. Moving
 * an opening, orbiting, or changing a level cannot change its own quantity. */
export function openingQuoteMetrics(opening: WallOpening) {
  if(!Number.isFinite(opening.width)||!Number.isFinite(opening.height)||opening.width<=0||opening.height<=0)throw new RangeError('开口尺寸无效，无法计价。');
  const ring=openingPolygon({...opening,offset:0,bottom:0}),valid=validatePolygon(ring);
  if(!valid.valid)throw new RangeError('开口轮廓无效，无法计价：'+valid.error);
  const area=polygonArea(ring)/10000;
  const perimeter=ring.reduce((length,p,index)=>{const q=ring[(index+1)%ring.length];return length+Math.hypot(q.x-p.x,q.y-p.y);},0)/100;
  return {netArea:area,perimeter};
}

/** Independent object budget; physical wall deductions remain in wall-solid.
 * The caller aggregates already-rounded components and applies project tax. */
export function calculateOpeningQuote(opening: WallOpening) {
  const config=validateOpeningQuote(opening);if(!config?.enabled)return null;
  const metrics=openingQuoteMetrics(opening),name=title(opening);
  const quantityMode=config.unit==='件'?'manual':config.unit==='m²'?'area':'perimeter';
  const netQuantity=config.unit==='件'?config.quantity:normalizeDecimal(config.unit==='m²'?metrics.netArea:metrics.perimeter,'开口实际用量');
  const missingQuantity=netQuantity==='0',missingPrice=config.unitPrice==='';
  const pendingReasons=[...(missingQuantity?['请填写大于零的开口数量']:[]),...(missingPrice?[`${name}尚未填写单价`]:[])];
  const purchaseQuantity=missingQuantity?null:multiplyDecimal(netQuantity,addDecimal('1',multiplyDecimal(config.wasteRate,'.01')));
  const materialCost=missingQuantity||missingPrice?null:formatMoney(multiplyDecimal(purchaseQuantity,config.unitPrice));
  const laborCost=missingQuantity?null:formatMoney(multiplyDecimal(netQuantity,config.laborRate));
  const additionalCost=formatMoney(config.additionalCost),knownMaterialCost=materialCost??'0.00',knownLaborCost=laborCost??'0.00';
  const knownSubtotal=sum(knownMaterialCost,knownLaborCost,additionalCost),pending=pendingReasons.length>0;
  const item={id:opening.id+':quote',materialId:'opening:'+opening.kind,materialName:name,unit:config.unit,quantityMode,
    quantity:missingQuantity?null:netQuantity,netQuantity:missingQuantity?null:netQuantity,purchaseQuantity,
    unitPrice:config.unitPrice,wasteRate:config.wasteRate,laborRate:config.laborRate,additionalCost:'0.00',
    materialCost,laborCost,knownMaterialCost,knownLaborCost,knownTotal:sum(knownMaterialCost,knownLaborCost),
    pending,status:pending?'pending':'ready',pendingReasons,pendingReason:pendingReasons.join('；')||null,
    total:pending?null:sum(knownMaterialCost,knownLaborCost),...sourcePriceMetadata(config)};
  return {id:opening.id,name,kind:opening.kind,wallId:opening.wallId,surfaceType:'opening',shape:opening.shape,
    locked:Boolean(opening.locked),width:opening.width,height:opening.height,depth:opening.depth,offset:opening.offset,bottom:opening.bottom,
    netArea:metrics.netArea,perimeter:metrics.perimeter,unit:config.unit,quantity:config.quantity,netQuantity:item.netQuantity,purchaseQuantity,
    unitPrice:config.unitPrice,wasteRate:config.wasteRate,laborRate:config.laborRate,additionalCost,itemAdditionalCost:'0.00',items:[item],
    materialCost,laborCost,knownMaterialCost,knownLaborCost,knownSubtotal,knownTotal:knownSubtotal,
    pending,status:pending?'pending':'ready',pendingReasons,pendingReason:pendingReasons.join('；')||null,
    subtotal:pending?null:knownSubtotal,total:pending?null:knownSubtotal};
}
