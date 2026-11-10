import { addLevel, switchLevel } from '../static/studio/lib/levels.js';
import { createCivilElement } from '../static/studio/lib/civil.js';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';

const rectangle = (x, y, width, depth) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
const material = (id, price, waste = '0', labor = '0') => ({ id, materialId: id, materialName: '用户确认材料', color: '#82958e', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: price, wasteRate: waste, laborRate: labor, additionalCost: '0' });
const room = (id, points, price, waste, labor) => ({ id, name: id, points, holes: [], hidden: false, items: [material(id + '-material', price, waste, labor)], additionalCost: '0' });
const furniture = (id, kind, price, extra = '0') => ({ id, name: id, kind, position: { x: 200, y: 200 }, width: 100, depth: 60, height: 80, rotation: 0, quantity: '1', unitPrice: price, additionalCost: extra });

/** Deliberate dimensions and prices for independently checkable mixed works:
 * decoration 2394, civil 220, municipal 750, fixed 100, 9% tax 311.76. */
export function budgetFixture({ pending = false } = {}) {
  let p = {
    version: 1, id: 'budget-acceptance', name: '综合工程验收', workspaceMode: 'plan',
    drawing: { id: 'metric-plan', name: '按尺寸绘制', type: 'plan', width: 6000, height: 5000, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' },
    calibration: { metersPerPixel: .01, method: 'metric-plan' },
    regions: [room('首层客厅', rectangle(100, 100, 400, 300), '100', '10', '20')],
    walls: [], wallHeight: 280, wallThickness: 20,
    furniture: [furniture('首层沙发', 'sofa', '250', '10')], civilElements: [],
    additionalCost: '100', taxRate: '9', view: { labels: true, drawingOpacity: 1 },
    budget: { client: '验收甲方', reference: 'BJ-20261108', note: '按实际工程范围计价', included: { decoration: true, civil: true, municipal: true } },
  };
  p.regions[0].ceiling = { enabled: true, items: [material('首层吊顶', '5', '0', '2')], additionalCost: '0' };
  p.civilElements.push({ ...createCivilElement('padFooting', { x: 800, y: 600 }, p), id: 'ground-foundation', name: '首层基础', width: 100, depth: 100, height: 50, unitPrice: '100', laborRate: '10' });
  p = addLevel(p, { name: '二楼' });
  p.regions.push(room('二楼卧室', rectangle(100, 100, 200, 200), '80', '0', '5'));
  p.furniture.push(furniture('二楼床', 'bed', pending ? '' : '150'));
  p.civilElements.push({ ...createCivilElement('column', { x: 800, y: 600 }, p), id: 'upper-column', name: '二楼柱', width: 50, depth: 50, height: 300, unitPrice: '200', laborRate: '20' });
  p = switchLevel(p, p.levels[0].id);
  p.municipalElements = [{ ...createMunicipalElement('road', [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }], p), id: 'site-road', name: '场地道路', width: 600, unitPrice: '10', wasteRate: '5', laborRate: '2' }];
  return p;
}
