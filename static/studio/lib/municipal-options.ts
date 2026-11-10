import { municipalEffectiveWidth, type MunicipalElement } from './municipal-design.js';
import { normalizeDecimal } from './pricing.js';

/** Shared inspector command. Geometry and prices remain distinct when locked. */
export function changeMunicipalOption(element: MunicipalElement, group: string, field: string, value: string | boolean): MunicipalElement {
  const next = structuredClone(element), price = ['pierUnitPrice', 'railingUnitPrice', 'pierPricingEnabled', 'railingPricingEnabled'].includes(field);
  if (next.locked && !price) throw new RangeError('请先解锁设施。');
  const number = () => { const n = typeof value === 'string' && value.trim() ? Number(value) : NaN; if (!Number.isFinite(n)) throw new RangeError('请输入有效数字。'); return n; };
  if (group === 'roadLayout') {
    if (!['road', 'bridge', 'intersection', 'roundabout'].includes(next.kind) || !['lanes', 'laneWidth', 'medianWidth'].includes(field)) throw new RangeError('道路参数不适用于此设施。');
    const n = number();
    if (field === 'lanes' && n === 0) { next.width = municipalEffectiveWidth(next); delete next.roadLayout; return next; }
    next.roadLayout = { lanes: 2, laneWidth: 350, medianWidth: 0, ...(next.roadLayout ?? {}) };
    if (field === 'lanes') { if (![2, 4, 6, 8].includes(n)) throw new RangeError('请选择 2、4、6 或 8 车道。'); next.roadLayout.lanes = n as 2 | 4 | 6 | 8; if (!element.roadLayout) next.roadLayout.medianWidth = n > 2 ? 100 : 0; }
    else next.roadLayout[field] = n;
    next.width = municipalEffectiveWidth(next);
  } else if (group === 'junction') {
    if (!['intersection', 'roundabout'].includes(next.kind) || !['arms', 'armLength', 'rotation', 'islandRadius'].includes(field)) throw new RangeError('路口参数不适用于此设施。');
    next.junction = { arms: 4, armLength: 1800, rotation: 0, islandRadius: 600, ...(next.junction ?? {}) };
    next.junction[field] = number() as never;
  } else if (group === 'trafficSignal') {
    if (next.kind !== 'trafficlight' || !['phase', 'rotation'].includes(field)) throw new RangeError('信号参数不适用于此设施。');
    next.trafficSignal = { phase: 'red', rotation: 0, ...(next.trafficSignal ?? {}) };
    if (field === 'phase') { if (!['red', 'amber', 'green'].includes(String(value))) throw new RangeError('请选择有效的信号灯状态。'); next.trafficSignal.phase = value as 'red' | 'amber' | 'green'; }
    else next.trafficSignal.rotation = number();
  } else if (group === 'bridgeOptions') {
    if (next.kind !== 'bridge' || !['pierSpacing', 'pierHeight', 'railingHeight', 'pierUnitPrice', 'railingUnitPrice', 'pierPricingEnabled', 'railingPricingEnabled'].includes(field)) throw new RangeError('桥梁参数不适用于此设施。');
    next.bridgeOptions = { pierSpacing: 800, pierHeight: 500, railingHeight: 120, ...(next.bridgeOptions ?? {}) };
    if (field.endsWith('PricingEnabled')) next.bridgeOptions[field] = Boolean(value);
    else if (field.endsWith('UnitPrice')) next.bridgeOptions[field] = String(value).trim() ? normalizeDecimal(value, '桥梁分项单价') : '';
    else next.bridgeOptions[field] = number();
  } else throw new RangeError('设施参数组不存在。');
  return next;
}
