import { budgetFixture } from './project-budget-fixture.mjs';

/** Actual dimensions and deliberate prices for a checked two-storey quote.
 * Before: two blank 16 m² floor materials + a blank bed, known total 1890.06.
 * Filling floor price100/waste5/labor25 and bed150 produces total3971.96. */
export function pricingFixture() {
  const p = budgetFixture({ pending: true });
  p.id = 'pricing-acceptance'; p.name = '集中报价工程';
  for (const region of [p.regions[0], p.levels[1].content.regions[0]]) {
    const material = region.items[0];
    material.materialId = 'tile-shared'; material.materialName = '防滑地砖';
    material.unitPrice = ''; material.wasteRate = '10'; material.laborRate = '20';
    material.provenance = { source: '用户提供的参考资料', region: '浙江', spec: '600×600 mm', supplier: '验收供货方', priceDate: '2026-11-01' };
  }
  return p;
}
