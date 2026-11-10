import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildFinishModel, calculateFinish, normalizeFinishConfig, validateFinishState, inferSpaceType, FINISH_LAYERS } from '../build/studio/lib/finish.js';
import { summarize, validateItems } from '../build/studio/lib/cost.js';
import { detectPlanRooms } from '../static/studio/lib/wall-plan.js';
import { buildWallSolid } from '../build/studio/lib/wall-solid.js';
import { wallSurfaceArea } from '../build/studio/lib/wall-selection.js';
import { pointInRegion } from '../static/studio/lib/geometry.js';

const near = (value, expected, tolerance = 1e-8) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} ≠ ${expected}`);
const wall = (id, start, end, extra = {}) => ({ id, start, end, thickness: 20, height: 280, ...extra });
const region = (id = 'room', x = 100, y = 100, width = 400, depth = 300, extra = {}) => ({
  id, name: '卧室', points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }],
  holes: [], hidden: false, items: [], additionalCost: '0', ...extra,
});
const door = (extra = {}) => ({ id: 'door', wallId: 'north', name: '室内门', kind: 'door', shape: 'rectangle', offset: 50, width: 90, height: 210, bottom: 0, depth: 4, ...extra });
function project({ width = 400, depth = 300, openings = [], config = {}, walls = true, name = '卧室' } = {}) {
  return { version: 1, id: 'finish-test', name: '装修测试', drawing: { type: 'plan' }, calibration: { metersPerPixel: .01 },
    regions: [region('room', 100, 100, width, depth, { name, ...(walls ? { source: 'walls', wallIds: ['north', 'east', 'south', 'west'] } : {}) })],
    walls: walls ? [wall('north', { x: 90, y: 90 }, { x: width + 110, y: 90 }),
      wall('east', { x: width + 110, y: 90 }, { x: width + 110, y: depth + 110 }),
      wall('south', { x: width + 110, y: depth + 110 }, { x: 90, y: depth + 110 }),
      wall('west', { x: 90, y: depth + 110 }, { x: 90, y: 90 })] : [], openings,
    additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 }, cost: { modules: { finish: { enabled: true, config } } } };
}
const getItem = (items, id, roomId = 'room') => items.find(item => item.id === `finish:${roomId}:${id}`);
const selectedMaterial = (extra = {}) => ({ id: 'item', materialId: 'tile', materialName: '实际瓷砖', unit: 'm²', quantityMode: 'area', quantity: '0',
  unitPrice: '100', laborRate: '20', wasteRate: '3', additionalCost: '0', provenance: { source: '供应商报价', priceDate: '2026-11-07', spec: '600 × 600 mm' }, ...extra });

test('4 × 3 m 房间仅计实际室内侧面并扣门洞，不计洞口内壁，踢脚线 13.1 m', () => {
  const value = project({ openings: [door()] });
  const measured = buildFinishModel(value).rooms[0];
  near(measured.netArea, 12); near(measured.perimeter, 14); near(measured.wallArea, 37.31);
  near(measured.doorWidth, .9); assert.equal(measured.wallEstimate, false);
  const items = calculateFinish(value);
  near(Number(getItem(items, 'skirting').quantity), 13.1);
  near(Number(getItem(items, 'wall-plaster').quantity), 37.31);
  assert.equal(getItem(items, 'door-body').quantity, '1');
  assert.equal(validateItems(items).ok, true);
});

test('2 × 2 m 卫生间防水 6.4 m²，贴砖上限 2.4 m，剩余墙面计涂料', () => {
  const value = project({ width: 200, depth: 200, name: '卫生间' });
  const measured = buildFinishModel(value).rooms[0], items = calculateFinish(value);
  near(measured.wallArea, 22.4); near(measured.wallTileArea, 19.2); near(measured.paintArea, 3.2);
  near(Number(getItem(items, 'floor-waterproof').quantity), 6.4);
  assert.equal(getItem(items, 'floor-waterproof').estimate, false);
  assert.match(getItem(items, 'floor-waterproof').feature, /300 mm/);
  const dry = calculateFinish(project());
  assert.equal(getItem(dry, 'floor-waterproof'), undefined);
  assert.equal(getItem(dry, 'wall-tile'), undefined);
});

test('跨贴砖高度的窗洞按真实表面裁剪，瓷砖和涂料区域互斥', () => {
  const value = project({ width: 200, depth: 200, name: '厨房', openings: [door({ kind: 'window', bottom: 180, height: 80, depth: 8 })] });
  const measured = buildFinishModel(value).rooms[0];
  near(measured.windowArea, .72); near(measured.wallArea, 21.68); near(measured.wallTileArea, 18.66); near(measured.paintArea, 3.02);
  near(measured.wallTileArea + measured.paintArea, measured.wallArea);
  assert.equal(measured.doorWidth, 0);
});

test('共墙门两房间均扣踢脚线，本体、五金、安装全工程只计一次', () => {
  const value = project();
  value.regions = [region('left', 100, 100, 390, 300, { source: 'walls' }), region('right', 510, 100, 390, 300, { source: 'walls' })];
  value.walls = [wall('north', { x: 90, y: 90 }, { x: 910, y: 90 }), wall('east', { x: 910, y: 90 }, { x: 910, y: 410 }),
    wall('south', { x: 910, y: 410 }, { x: 90, y: 410 }), wall('west', { x: 90, y: 410 }, { x: 90, y: 90 }), wall('partition', { x: 500, y: 90 }, { x: 500, y: 410 })];
  value.openings = [door({ wallId: 'partition' })];
  const measured = buildFinishModel(value).rooms, items = calculateFinish(value);
  assert.equal(measured.length, 2);
  for (const room of measured) { near(room.doorWidth, .9); near(room.wallArea, 36.75); }
  for (const id of ['door-body', 'door-hardware', 'door-install']) assert.equal(items.filter(item => item.id.endsWith(`:${id}`)).reduce((sum, item) => sum + Number(item.quantity), 0), 1);
  for (const id of ['left', 'right']) near(Number(getItem(items, 'skirting', id).quantity), 12.9);
});

test('高外墙跨两房间和异高共墙，按各房间边界裁剪而不以整面中心归属', () => {
  const value = project();
  value.regions = [region('left', 100, 100, 390, 300, { source: 'walls' }), region('right', 510, 100, 390, 300, { source: 'walls' })];
  value.walls = [wall('north', { x: 90, y: 90 }, { x: 910, y: 90 }, { height: 350 }), wall('east', { x: 910, y: 90 }, { x: 910, y: 410 }),
    wall('south', { x: 910, y: 410 }, { x: 90, y: 410 }), wall('west', { x: 90, y: 410 }, { x: 90, y: 90 }), wall('partition', { x: 500, y: 90 }, { x: 500, y: 410 }, { height: 180 })];
  const measured = buildFinishModel(value).rooms;
  for (const room of measured) { near(room.wallArea, 38.37); assert.equal(room.wallEstimate, false); }
  const original = calculateFinish(value);
  value.walls.reverse(); value.regions.reverse();
  assert.deepEqual(calculateFinish(value), original);
});

test('材料采购含损耗、人工按净面积，金额走共享定点内核且不重复列基层', () => {
  const value = project({ config: { gradePrices: { standard: { 'floor-level': '30.125' } } } });
  value.regions[0].items = [selectedMaterial()];
  const items = calculateFinish(value), material = getItem(items, 'floor-surface'), labor = getItem(items, 'floor-install');
  near(Number(material.quantity), 12.36); assert.equal(material.amount, '1236.00');
  assert.equal(labor.quantity, '12'); assert.equal(labor.amount, '240.00'); assert.equal(getItem(items, 'floor-level').amount, '361.50');
  assert.equal(summarize(items, { measureRate: '0', taxRate: '0' }).total, '1837.50');
  assert.match(material.note, /不含找平层/); assert.match(getItem(items, 'wall-tile')?.note ?? FINISH_LAYERS.find(layer => layer.id === 'wall-tile').note, /不含基层抹灰/);
  assert.equal(FINISH_LAYERS.find(layer => layer.id === 'floor-level').includesBase, true);
  assert.equal(FINISH_LAYERS.find(layer => layer.id === 'floor-surface').includesBase, false);
  assert.equal(FINISH_LAYERS.some(layer => /基层清理/.test(layer.name)), false);
});

test('三档使用用户真实工序报价，公共工序工程量完全不变', () => {
  const value = project({ config: { grade: 'basic', gradePrices: { basic: { 'floor-surface': '50' }, standard: { 'floor-surface': '80' }, high: { 'floor-surface': '120' } } } });
  const low = calculateFinish(value);
  value.cost.modules.finish.config.grade = 'high';
  const high = calculateFinish(value);
  assert.deepEqual(low.map(item => [item.id, item.quantity]), high.map(item => [item.id, item.quantity]));
  assert.equal(getItem(low, 'floor-surface').amount, '618.00'); assert.equal(getItem(high, 'floor-surface').amount, '1483.20');
  assert.equal(getItem(high, 'floor-surface').priceStatus, 'confirmed');
  assert.equal(getItem(calculateFinish(project()), 'floor-surface').priceStatus, 'missing');
});

test('材料库快照保留真实来源，Demo 价格标参考，函数不读取外部材料库', () => {
  const material = { id: 'demo', name: 'Demo 地砖', category: '地面', unit: 'm²', unitPrice: '88.8', wasteRate: '3', image: '', color: '#abc', description: '示例', demo: true };
  const value = project({ config: { materials: [material] } });
  const items = calculateFinish(value);
  assert.equal(getItem(items, 'floor-surface').unitPrice, '88.8'); assert.equal(getItem(items, 'floor-surface').priceStatus, 'reference');
  assert.match(getItem(items, 'floor-surface').note, /示例价格，需替换/);
  material.unitPrice = '0';
  const normalized = normalizeFinishConfig({ materials: [material] }); material.unitPrice = '999';
  assert.equal(normalized.materials[0].unitPrice, '0');
});

test('无实际墙体的手绘房间及孔洞保留净面积，墙面明确按高度估算', () => {
  const value = project({ walls: false });
  value.regions[0].holes = [[{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }]];
  const model = buildFinishModel(value), room = model.rooms[0];
  near(room.netArea, 11); near(room.perimeter, 18); near(room.wallArea, 50.4); near(room.estimatedBoundaryLength, 18);
  assert.equal(room.wallEstimate, true); assert.equal(model.warnings.length, 1);
  assert.equal(getItem(calculateFinish(value), 'wall-plaster').estimate, true);
});

test('手绘房间只有一面实际墙时补估缺失边界，不漏计或覆盖实际墙高', () => {
  const value = project({ walls: false });
  value.walls = [wall('north', { x: 90, y: 90 }, { x: 510, y: 90 }, { height: 300 })];
  const model = buildFinishModel(value), room = model.rooms[0];
  near(room.wallArea, 40); near(room.estimatedBoundaryLength, 10); assert.equal(room.wallEstimate, true);
  assert.match(model.warnings[0], /10 m 边界/);
  assert.match(getItem(calculateFinish(value), 'wall-plaster').note, /其余按实际墙体/);
});

test('全高门不会被当作未匹配墙面补估，椭圆只触地不扣外包宽度', () => {
  const full = buildFinishModel(project({ openings: [door({ height: 280 })] })).rooms[0];
  assert.equal(full.wallEstimate, false); assert.equal(full.estimatedBoundaryLength, 0); assert.ok(full.wallArea >= 0 && full.wallArea < 39.2);
  const ellipse = buildFinishModel(project({ openings: [door({ shape: 'ellipse' })] })).rooms[0];
  assert.equal(ellipse.doorWidth, 0); assert.ok(ellipse.wallArea > 0);
});

test('修改房间尺寸重新算量，保留手工单行价格；重复生成不变且不修改输入', () => {
  const value = project({ walls: false }), state = value.cost.modules.finish;
  state.priceOverrides = { 'finish:room:floor-surface': '100.25' };
  const before = structuredClone(value), first = calculateFinish(value);
  assert.deepEqual(value, before); assert.deepEqual(calculateFinish(value), first);
  value.regions[0].points[1].x = 600; value.regions[0].points[2].x = 600;
  const modified = calculateFinish(value);
  near(Number(getItem(modified, 'floor-surface').quantity), 15.45);
  assert.equal(getItem(modified, 'floor-surface').unitPrice, '100.25'); assert.equal(getItem(modified, 'floor-surface').amount, '1548.86');
});

test('水电按空间点位与指标初估，可独立改点位，所有相关清单标估算', () => {
  const value = project({ name: '厨房', config: { rooms: [{ regionId: 'room', spaceType: 'kitchen', points: { sockets: 9 } }] } });
  const items = calculateFinish(value);
  assert.equal(getItem(items, 'sockets').quantity, '9'); assert.equal(getItem(items, 'conduit').quantity, '30');
  assert.equal(getItem(items, 'wire').quantity, '90'); assert.equal(getItem(items, 'water-pipe').quantity, '15');
  assert.equal(getItem(items, 'drain-pipe').quantity, '8');
  for (const item of items.filter(item => item.group.endsWith('水电'))) assert.equal(item.estimate, true);
  assert.equal(inferSpaceType('客厅'), 'living'); assert.equal(inferSpaceType('厕所'), 'bath'); assert.equal(inferSpaceType('未命名'), 'bedroom');
});

test('空项目、未启用正常返回空清单，未校准和无效几何拒绝精确报价', () => {
  const empty = project(); empty.regions = []; assert.deepEqual(calculateFinish(empty), []);
  assert.equal(summarize(calculateFinish(empty)).total, '0.00');
  const disabled = project(); disabled.cost.modules.finish.enabled = false; assert.deepEqual(calculateFinish(disabled), []);
  const pending = project({ walls: false }); pending.drawing = null; pending.calibration.metersPerPixel = null;
  assert.throws(() => calculateFinish(pending), /校准/);
  pending.calibration.metersPerPixel = .01; pending.planError = '未闭合'; assert.throws(() => calculateFinish(pending), /闭合/);
  const bad = project(); bad.regions[0].points = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }];
  assert.throws(() => calculateFinish(bad));
  const overlap = project({ walls: false }); overlap.regions.push(region('overlap', 150, 150));
  assert.throws(() => calculateFinish(overlap), /重叠/);
  const mismatch = project(); mismatch.regions[0].points[1].x += 20; mismatch.regions[0].points[2].x += 20;
  assert.throws(() => calculateFinish(mismatch), /不匹配/);
});

test('参数覆盖零值、负数、NaN、缺省、超限、重复房间和非法报价', () => {
  assert.equal(normalizeFinishConfig().grade, 'standard');
  assert.equal(normalizeFinishConfig({ wetUpstand: 0, floorWasteRate: 0, ceiling: false }).wetUpstand, 0);
  const invalid = [null, [], { wallHeight: -1 }, { wallHeight: 11 }, { wetUpstand: NaN }, { floorWasteRate: 101 }, { ceiling: 'yes' },
    { grade: 'premium' }, { gradePrices: { high: { 'floor-surface': '-1' } } }, { gradePrices: { unknown: {} } },
    { rooms: [{ regionId: 'r', spaceType: 'bath', points: { sockets: 1.5 } }] }, { rooms: [{ regionId: 'r', spaceType: 'unknown' }] },
    { rooms: [{ regionId: 'r', spaceType: 'bath' }, { regionId: 'r', spaceType: 'living' }] }, { rooms: Array(1001).fill({}) }, { materials: [{ name: '砖', unit: 'm²', unitPrice: Infinity }] }];
  for (const value of invalid) assert.throws(() => normalizeFinishConfig(value));
  assert.throws(() => validateFinishState({ config: { wireMultiplier: -1 } }));
});

test('100 个手绘房间的全专业清单生成性能基准', () => {
  const value = project({ walls: false });
  value.regions = Array.from({ length: 100 }, (_, index) => region(`r-${index}`, (index % 10) * 500, Math.floor(index / 10) * 400));
  const start = performance.now(), items = calculateFinish(value), duration = performance.now() - start;
  assert.equal(items.filter(item => item.id.endsWith(':floor-level')).length, 100);
  assert.equal(validateItems(items).ok, true);
  console.log(`finish 100 rooms: ${duration.toFixed(1)} ms, ${items.length} rows`);
  assert.ok(duration < 300, `100 房间生成耗时 ${duration} ms，应小于 300 ms`);
});

test('100 个共墙房间使用实际墙体并集面，内墙不重复且生成小于 300 ms', () => {
  const value = project();
  value.regions = Array.from({ length: 100 }, (_, index) => region(`grid-${index}`, (index % 10) * 420 + 10, Math.floor(index / 10) * 320 + 10, 400, 300, { source: 'walls' }));
  value.walls = [
    ...Array.from({ length: 11 }, (_, index) => wall(`v-${index}`, { x: index * 420, y: 0 }, { x: index * 420, y: 3200 })),
    ...Array.from({ length: 11 }, (_, index) => wall(`h-${index}`, { x: 0, y: index * 320 }, { x: 4200, y: index * 320 })),
  ];
  const start = performance.now(), model = buildFinishModel(value), items = calculateFinish(value), duration = performance.now() - start;
  assert.equal(model.rooms.length, 100);
  for (const room of model.rooms) { near(room.wallArea, 39.2); assert.equal(room.wallEstimate, false); }
  assert.equal(validateItems(items).ok, true);
  console.log(`finish 100 wall-derived rooms, measures and pricing: ${duration.toFixed(1)} ms`);
  assert.ok(duration < 300, `100 实际墙体房间测量与生成耗时 ${duration} ms，应小于 300 ms`);
});

test('旋转房间墙面/湿区墙砖/门洞扣量与原房间一致，不把斜边界补成估算', () => {
  const original=project({name:'卫生间',openings:[door()]});
  const expected=buildFinishModel(original).rooms[0];
  for(const angle of [.23,.71,1.19]){
    const value=structuredClone(original),c=Math.cos(angle),s=Math.sin(angle),rotate=point=>({x:point.x*c-point.y*s,y:point.x*s+point.y*c});
    value.walls=value.walls.map(wall=>({...wall,start:rotate(wall.start),end:rotate(wall.end)}));
    value.regions=value.regions.map(region=>({...region,points:region.points.map(rotate),holes:region.holes.map(hole=>hole.map(rotate))}));
    const room=buildFinishModel(value).rooms[0];
    for(const field of ['netArea','perimeter','wallArea','wallTileArea','paintArea','doorWidth'])near(room[field],expected[field]);
    assert.equal(room.wallEstimate,false);assert.equal(room.estimatedBoundaryLength,0);
    const items=calculateFinish(value);near(Number(getItem(items,'skirting').quantity),13.1);
  }
});

test('手绘斜房间部分边界匹配实际墙，其余按真实边长估算',()=>{
  const value=project({walls:false}),angle=.73,c=Math.cos(angle),s=Math.sin(angle),rotate=point=>({x:point.x*c-point.y*s,y:point.x*s+point.y*c});
  value.walls=[wall('north',rotate({x:90,y:90}),rotate({x:510,y:90}),{height:300})];
  value.regions[0].points=value.regions[0].points.map(rotate);
  const room=buildFinishModel(value).rooms[0];near(room.wallArea,40);near(room.estimatedBoundaryLength,10);assert.equal(room.wallEstimate,true);
});

test('实际画墙生成斜梯形及斜孔洞房间，净边界与实体内墙相符',()=>{
  const fixtures=[
    [[{x:100,y:100},{x:650,y:100},{x:500,y:450},{x:100,y:450}]],
    [[{x:100,y:100},{x:900,y:100},{x:900,y:900},{x:100,y:900}],[{x:300,y:400},{x:500,y:300},{x:650,y:500},{x:450,y:650}]],
  ];
  for(const rings of fixtures){
    const value=project();
    value.walls=rings.flatMap((ring,k)=>ring.map((start,i)=>wall(`w-${k}-${i}`,start,ring[(i+1)%ring.length])));
    value.regions=detectPlanRooms(value.walls).map((room,i)=>({...room,id:`r-${i}`,name:'实际斜房间',source:'walls',hidden:false,items:[],additionalCost:'0'}));
    const model=buildFinishModel(value),solid=buildWallSolid(value);assert.equal(model.rooms.length,rings.length);
    for(const room of model.rooms){
      const region=value.regions.find(region=>region.id===room.regionId);
      const indoor=solid.surfaces.filter(surface=>{
        if(!['left','right','end'].includes(surface.side))return false;
        const center=surface.points.reduce((p,q)=>({x:p.x+q.x/surface.points.length,z:p.z+q.z/surface.points.length}),{x:0,z:0});
        return pointInRegion({x:(center.x+surface.normal.x*.00001)*100,y:(center.z+surface.normal.z*.00001)*100},region);
      });
      const ends=indoor.filter(surface=>surface.side==='end').reduce((sum,surface)=>sum+wallSurfaceArea(surface.points),0);
      const sides=indoor.filter(surface=>surface.side!=='end').reduce((sum,surface)=>sum+wallSurfaceArea(surface.points),0);
      assert.equal(room.wallEstimate,false);near(room.wallArea,sides);near(room.wallArea+ends,room.perimeter*2.8);assert.ok(room.netArea>0);
    }
    assert.equal(validateItems(calculateFinish(value)).ok,true);
  }
});
