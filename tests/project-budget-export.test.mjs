import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PROJECT_BUDGET_BUILD ? pathToFileURL(resolve(process.env.PROJECT_BUDGET_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { calculateProjectBudget } = await import(new URL('lib/project-budget.js', root));
const { projectBudgetToCSV, renderProjectBudgetReport } = await import(new URL('lib/project-budget-export.js', root));
const { createMunicipalElement } = await import(new URL('lib/municipal-design.js', root));
const { createCivilElement } = await import(new URL('lib/civil.js', root));

function fixture() {
  const p = { version: 1, id: 'budget-export', name: '甲方正式预算', drawing: { id: 'drawing', type: 'plan', name: '真实平面', width: 10000, height: 10000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], civilElements: [], municipalElements: [], additionalCost: '11', taxRate: '6', view: { labels: true, drawingOpacity: 1 }, budget: { client: '甲方建设', reference: 'B-2026', note: '根据实际施工范围报价\n单价经用户确认' } };
  p.regions = [{ id: 'room', name: '客厅', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], holes: [], hidden: false, additionalCost: '7', items: [{ id: 'tile', materialId: 'tile', materialName: '地砖', unit: 'm²', quantityMode: 'area', quantity: '0', unitPrice: '100', wasteRate: '10', laborRate: '20', additionalCost: '5' }] }];
  p.civilElements = [{ ...createCivilElement('column', { x: 1000, y: 1000 }, p), id: 'column', unitPrice: '1000', laborRate: '100', formworkRate: '10', rebarMode: 'ratio', rebarRatio: '100', rebarPrice: '5', additionalCost: '4' }];
  p.municipalElements = [createMunicipalElement('road', [{ x: 2000, y: 1000 }, { x: 3000, y: 1000 }], p, { width: 200, unitPrice: '50', wasteRate: '5', laborRate: '5', additionalCost: '6' })];
  return p;
}
function csvRows(csv) {
  // Quoted cells may contain actual CRLF/newlines; parse their string values.
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = csv.charCodeAt(0) === 0xfeff ? 1 : 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') { if (quoted && csv[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) { if (char === '\r' && csv[i + 1] === '\n') i++; row.push(field); rows.push(row); field = ''; row = []; }
    else field += char;
  }
  if (row.length || field) { row.push(field); rows.push(row); } return rows;
}

test('完整报价CSV列宽一致且专业与全工程税前/含税汇总可明确区分', () => {
  const p = fixture(), rows = csvRows(projectBudgetToCSV(p)); assert.ok(rows.every(row => row.length === 20));
  const totals = rows.filter(row => row[0] === '专业税前汇总'); assert.deepEqual(totals.map(row => row[17]), ['1572.00', '820.00', '1156.00']);
  assert.equal(rows.filter(row => row[0] === '工程固定费').length, 1); assert.equal(rows.filter(row => row[0] === '工程税金').length, 1);
  assert.equal(rows.at(-1)[17], '3772.54'); assert.equal(rows.find(row => row[0] === '工程税金')[17], '213.54');
});

test('材料分项保留净施工量、含损耗采购量、人工和分项/对象固定费', () => {
  const rows = csvRows(projectBudgetToCSV(fixture())), tile = rows.find(row => row[0] === '专业分项' && row[5] === '地砖');
  assert.equal(tile[8], '12'); assert.equal(tile[9], '13.2'); assert.equal(tile[13], '1320.00'); assert.equal(tile[14], '240.00'); assert.equal(tile[15], '5.00');
  assert.equal(rows.find(row => row[0] === '计价对象汇总' && row[4] === '客厅')[16], '7.00'); assert.match(tile[7], /净面积/);
});

test('结构模板与钢筋各自保留实际单位和指标依据', () => {
  const rows = csvRows(projectBudgetToCSV(fixture())), form = rows.find(row => row[5] === '模板'), steel = rows.find(row => /钢筋（指标估算）/.test(row[5]));
  assert.equal(form[6], 'm²'); assert.equal(form[8], '4.8'); assert.match(form[7], /真实模板面积/);
  assert.equal(steel[6], 'kg'); assert.equal(steel[8], '48'); assert.match(steel[7], /用户钢筋指标/);
});

test('取消专业后报告标明排除范围，分项不混入已选报价', () => {
  const p = fixture(); p.budget.included = { civil: false }; const csv = projectBudgetToCSV(p), html = renderProjectBudgetReport(p);
  const rows = csvRows(csv); assert.equal(rows.at(-1)[17], '2903.34'); assert.ok(rows.some(row => row[0] === '排除专业' && row[2] === '土建'));
  assert.ok(!rows.some(row => row[0] === '专业分项' && row[2] === '土建')); assert.match(html, /土建<\/strong>未纳入/); assert.doesNotMatch(html, /data-budget-section="civil"/);
});

test('未填价项以已定价部分展示，打印与CSV保留可核对的待完善说明', () => {
  const p = fixture(); p.civilElements[0].unitPrice = ''; const csv = projectBudgetToCSV(p), html = renderProjectBudgetReport(p);
  assert.match(csv, /待填写/); assert.match(csv, /已定价部分含税小计/); assert.match(html, /不构成完整总预算/); assert.match(html, /已定价部分 \/ 待完善/);
  const rows = csvRows(csv); assert.equal(rows.at(-1)[17], '3263.74'); assert.ok(rows.some(row => row[0] === '工程检查' && /单价/.test(row[19])));
});

test('未校准用量不伪造面积，仍输出实际固定金额', () => {
  const p = fixture(); p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  const rows = csvRows(projectBudgetToCSV(p)); assert.ok(rows.some(row => row[0] === '专业分项' && /待校准/.test(row[8])));
  assert.equal(rows.at(-1)[17], '34.98'); assert.match(renderProjectBudgetReport(p), /待校准 \/ 待确认/);
});

test('甲方资料、编号和多行报价说明在CSV与打印中完整保留', () => {
  const p = fixture(), csv = projectBudgetToCSV(p), html = renderProjectBudgetReport(p), rows = csvRows(csv);
  assert.equal(rows.find(row => row[5] === '报价说明')[19], p.budget.note); assert.match(html, /甲方建设/); assert.match(html, /B-2026/); assert.match(html, /根据实际施工范围报价\n单价经用户确认/);
});

test('所有用户文字按HTML和CSV公式规则转义', () => {
  const p = fixture(); p.name = '=1+1<script>alert(1)</script>'; p.budget.client = '<img src=x onerror=alert(1)>'; p.budget.note = '@SUM(1,2)'; p.regions[0].items[0].materialName = '<svg onload=alert(1)>';
  const csv = projectBudgetToCSV(p), html = renderProjectBudgetReport(p); assert.match(csv, /'=1\+1/); assert.match(csv, /'@SUM/); assert.doesNotMatch(html, /<script>|<img src=x|<svg onload=/); assert.match(html, /&lt;img/);
});

test('桥墩与栏杆分项输出真实数量与计量依据', () => {
  const p = fixture(); const bridge = createMunicipalElement('bridge', [{ x: 4000, y: 4000 }, { x: 6400, y: 4000 }], p, { width: 1500, unitPrice: '10', bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '1000', railingUnitPrice: '20' } }); p.municipalElements = [bridge];
  const rows = csvRows(projectBudgetToCSV(p)); const piers = rows.find(row => row[5] === '中间桥墩'), rails = rows.find(row => row[5] === '两侧桥栏杆');
  assert.equal(piers[8], '2'); assert.match(piers[7], /不含端部桥台/); assert.equal(rails[8], '48'); assert.match(rails[7], /真实桥面两侧边界长/);
});

test('总预算打印保留真实工程检查及示例材料/概念地形/河槽边界', () => {
  const p = fixture(); p.regions[0].items[0].demo = true;
  const html = renderProjectBudgetReport(p), csv = projectBudgetToCSV(p); assert.match(html, /示例材料/); assert.match(csv, /示例材料/); assert.match(html, /工程检查与计量说明/);
  assert.match(html, /原造价工作台方案表独立保存/); assert.match(html, /固定费及税金仅在总汇中计算一次/);
});

test('按件价格可计算时不把缺比例设计误标为工程完成', () => {
  const p = fixture(); p.regions = []; p.civilElements = []; p.municipalElements = []; p.drawing.type = 'image'; p.calibration.metersPerPixel = null;
  p.furniture = [{ id: 'chair', name: '椅子', kind: 'chair', position: { x: 100, y: 100 }, width: 40, depth: 40, height: 80, rotation: 0, quantity: '2', unitPrice: '100', additionalCost: '0' }];
  const budget = calculateProjectBudget(p); assert.equal(budget.status, 'ready'); assert.equal(budget.total, '223.66');
  assert.match(projectBudgetToCSV(p, budget), /计价参数已完整，设计待完善/); assert.match(renderProjectBudgetReport(p, budget), /计价参数已完整，设计待完善/);
});

test('空范围导出清楚标明尚未选择计价对象', () => {
  const p = fixture(); p.budget.included = { decoration: false, civil: false, municipal: false };
  assert.match(projectBudgetToCSV(p), /尚未选择计价对象/); assert.match(renderProjectBudgetReport(p), /尚未选择计价对象/); assert.doesNotMatch(renderProjectBudgetReport(p), /报价参数完整/);
});
