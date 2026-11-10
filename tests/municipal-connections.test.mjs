import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceRoot = new URL('../static/studio/', import.meta.url);
let connectionURL = new URL('lib/municipal-connections.js', sourceRoot);
if (process.env.MUNICIPAL_CONNECTIONS_TS) {
  const ts = await import('typescript');
  const source = await readFile(new URL('lib/municipal-connections.ts', sourceRoot), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/from ['"](\.\/.+?)['"]/g, (_, path) => `from ${JSON.stringify(new URL(path, new URL('lib/', sourceRoot)).href)}`);
  connectionURL = new URL('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
const { municipalConnectionPorts, snapMunicipalConnection, createRoadsideKerbs, createJunctionKerbs } = await import(connectionURL);
const { createMunicipalElement, municipalMetrics, municipalJunctionArms, validateMunicipalElements } = await import(new URL('lib/municipal-design.js', sourceRoot));
const { calculateMunicipalProject } = await import(new URL('lib/municipal-pricing.js', sourceRoot));
const { createRoadProfile } = await import(new URL('lib/road-profile.js', sourceRoot));
const fixture = () => ({ version: 1, id: 'connections', name: '道路衔接', drawing: { id: 'plan', type: 'plan', name: '实际场地', width: 30000, height: 30000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } });
const makeRoad = (p, patch = {}) => createMunicipalElement('road', [{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }], p, { id: 'road', width: 200, unitPrice: '10', ...patch });
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const nearPoint = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
const totalLength = (p, kerbs) => kerbs.reduce((sum, kerb) => sum + municipalMetrics(kerb, { ...p, municipalElements: kerbs }).length, 0);

test('四支路口实际端帽提供四个连接口，不吸附到路口中心', () => {
  const p = fixture(), junction = createMunicipalElement('intersection', [{ x: 10000, y: 10000 }], p, { id: 'cross', junction: { arms: 4, armLength: 1800, rotation: 0, islandRadius: 600 }, roadLayout: { lanes: 4, laneWidth: 350, medianWidth: 100 } });
  p.municipalElements = [junction]; const before = structuredClone(p), ports = municipalConnectionPorts(p);
  assert.equal(ports.length, 4); nearPoint(ports[0].point, { x: 11800, y: 10000 }); nearPoint(ports[0].direction, { x: 1, y: 0 });
  assert.equal(ports[0].widthCm, 1500); assert.deepEqual(ports[0].roadLayout, junction.roadLayout); assert.equal(ports[0].elevation, 0);
  const snap = snapMunicipalConnection(p, 'road', { x: 11806, y: 10004 }, { tolerance: 10 });
  nearPoint(snap.point, ports[0].point); assert.equal(snap.port.targetId, 'cross'); assert.equal(snap.port.position, 'arm'); assert.equal(snap.port.kind, 'junction');
  assert.equal(snapMunicipalConnection(p, 'road', { x: 10000, y: 10000 }, { tolerance: 10 }), null); assert.deepEqual(p, before);
});

test('旋转八支路口和斜线桥端采用真实单位方向与端帽位置', () => {
  const p = fixture(), junction = createMunicipalElement('intersection', [{ x: 10000, y: 10000 }], p, { id: 'eight', junction: { arms: 8, armLength: 2500, rotation: 22.5, islandRadius: 600 } });
  const bridge = createMunicipalElement('bridge', [{ x: 18000, y: 15000 }, { x: 19000, y: 16000 }], p, { id: 'bridge', elevation: 400 }); p.municipalElements = [junction, bridge];
  const ports = municipalConnectionPorts(p); assert.equal(ports.length, 10);
  const angle = Math.PI / 8; nearPoint(ports[0].point, { x: 10000 + 2500 * Math.cos(angle), y: 10000 + 2500 * Math.sin(angle) });
  for (const port of ports) near(Math.hypot(port.direction.x, port.direction.y), 1);
  nearPoint(ports[8].direction, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }); nearPoint(ports[9].direction, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
  assert.equal(ports[8].elevation, 400); assert.equal(ports[9].kind, 'bridge');
});

test('环岛连接口位于实际外环加支路长度，中心岛没有道路连接口', () => {
  const p = fixture(), junction = createMunicipalElement('roundabout', [{ x: 10000, y: 10000 }], p, { id: 'ring', width: 600, junction: { arms: 4, armLength: 1800, rotation: 0, islandRadius: 800 } }); p.municipalElements = [junction];
  const ports = municipalConnectionPorts(p); assert.equal(ports.length, 4); nearPoint(ports[0].point, { x: 13200, y: 10000 });
  assert.equal(snapMunicipalConnection(p, 'road', { x: 10800, y: 10000 }, { tolerance: 15 }), null);
});

test('隐藏设施不提供吸附目标，锁定设施仍可连接且排除自身对象', () => {
  const p = fixture(), visible = makeRoad(p, { locked: true }), hidden = makeRoad(p, { id: 'hidden', hidden: true, points: [{ x: 7000, y: 5000 }, { x: 8000, y: 5000 }] }); p.municipalElements = [visible, hidden];
  assert.equal(municipalConnectionPorts(p).length, 2); assert.ok(snapMunicipalConnection(p, 'road', { x: 6001, y: 5000 }, { tolerance: 5 }));
  assert.equal(snapMunicipalConnection(p, 'road', { x: 8001, y: 5000 }, { tolerance: 5 }), null);
  assert.equal(snapMunicipalConnection(p, 'road', { x: 6000, y: 5000 }, { tolerance: 5, excludeId: visible.id }), null);
  assert.equal(snapMunicipalConnection(p, 'road', { x: 6000, y: 5000 }, { tolerance: 5, excludedId: visible.id }), null);
});

test('新道路可继承桥端标高，已确定标高的道路不会误接到高架桥', () => {
  const p = fixture(), bridge = createMunicipalElement('bridge', [{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }], p, { elevation: 400 }); p.municipalElements = [bridge];
  const first = snapMunicipalConnection(p, 'road', { x: 6001, y: 5001 }, { tolerance: 5 }); assert.equal(first.elevation, 400);
  assert.equal(snapMunicipalConnection(p, 'road', { x: 6001, y: 5001 }, { tolerance: 5, elevation: 0 }), null);
  assert.ok(snapMunicipalConnection(p, 'road', { x: 6001, y: 5001 }, { tolerance: 5, elevation: 400 }));
});

test('中间接入道路的投影在真实中心线上，方向按参考点同向', () => {
  const p = fixture(), road = makeRoad(p, { points: [{ x: 5000, y: 5000 }, { x: 6000, y: 6000 }] }); p.municipalElements = [road];
  const snap = snapMunicipalConnection(p, 'road', { x: 5504, y: 5500 }, { tolerance: 8, reference: { x: 5600, y: 5600 } });
  nearPoint(snap.point, { x: 5502, y: 5502 }); nearPoint(snap.port.direction, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }); assert.equal(snap.port.position, 'segment');
});

test('路缘石在道路真实边缘外偏半宽，不被吸到中心线或路内', () => {
  const p = fixture(), road = makeRoad(p); p.municipalElements = [road];
  const left = snapMunicipalConnection(p, 'kerb', { x: 5500, y: 5104 }, { tolerance: 10, widthCm: 15 });
  nearPoint(left.point, { x: 5500, y: 5107.5 }); assert.equal(left.kind, 'edge'); assert.equal(left.port.kind, 'edge');
  const right = snapMunicipalConnection(p, 'kerb', { x: 5500, y: 4896 }, { tolerance: 10, widthCm: 15 }); nearPoint(right.point, { x: 5500, y: 4892.5 });
  assert.equal(snapMunicipalConnection(p, 'kerb', { x: 5500, y: 5000 }, { tolerance: 10 }), null);
});

test('多车道路宽与斜线路缘石投影不依赖画布缩放或包围盒', () => {
  const p = fixture(), road = makeRoad(p, { points: [{ x: 5000, y: 5000 }, { x: 6000, y: 6000 }], roadLayout: { lanes: 4, laneWidth: 350, medianWidth: 100 } }); p.municipalElements = [road];
  const offset = 757.5, expected = { x: 5500 - offset * Math.SQRT1_2, y: 5500 + offset * Math.SQRT1_2 };
  const snap = snapMunicipalConnection(p, 'kerb', { x: expected.x + 2, y: expected.y - 2 }, { tolerance: 10 }); nearPoint(snap.point, expected);
  assert.equal(snap.port.widthCm, 1500); assert.equal(snap.port.roadLayout.lanes, 4);
});

test('不同图片比例下，真实米制连接与路缘石宽度一致', () => {
  for (const scale of [.01, .025]) {
    const p = fixture(); p.drawing.type = 'png'; p.calibration.metersPerPixel = scale;
    const road = makeRoad(p, { points: [{ x: 50 / scale, y: 50 / scale }, { x: 60 / scale, y: 50 / scale }] }); p.municipalElements = [road];
    const snap = snapMunicipalConnection(p, 'kerb', { x: 55 / scale, y: 51.05 / scale }, { tolerance: .1 / scale });
    near(snap.point.x * scale, 55); near(snap.point.y * scale, 51.075);
    const kerbs = createRoadsideKerbs(p, road); near(totalLength(p, kerbs), 20);
  }
});

test('未校准没有猜测吸附位置，不能生成有真实尺寸的路缘石', () => {
  const p = fixture(), road = makeRoad(p); p.drawing.type = 'png'; p.calibration.metersPerPixel = null; p.municipalElements = [road];
  assert.deepEqual(municipalConnectionPorts(p), []); assert.equal(snapMunicipalConnection(p, 'road', { x: 6000, y: 5000 }, { tolerance: 10 }), null);
  assert.throws(() => createRoadsideKerbs(p, road), /校准/);
});

test('两侧路缘石是真实独立对象，单价为空、没有更改道路或原项目', () => {
  const p = fixture(), road = makeRoad(p); p.municipalElements = [road]; const before = structuredClone(p), kerbs = createRoadsideKerbs(p, road);
  assert.equal(kerbs.length, 2); assert.ok(kerbs.every(kerb => kerb.kind === 'kerb' && kerb.unit === 'm' && kerb.unitPrice === '' && kerb.quantity === '1'));
  nearPoint(kerbs[0].points[0], { x: 5000, y: 5107.5 }); nearPoint(kerbs[1].points[0], { x: 5000, y: 4892.5 });
  near(totalLength(p, kerbs), 20); assert.deepEqual(p, before); assert.doesNotThrow(() => validateMunicipalElements(kerbs, p));
});

test('斜线和转角的真实外侧路径量随边界变化，左右之和不会随机变化', () => {
  const p = fixture(), road = makeRoad(p, { points: [{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }, { x: 6000, y: 6000 }] });
  const kerbs = createRoadsideKerbs(p, road); assert.equal(kerbs.length, 2); near(totalLength(p, kerbs), 40);
  near(municipalMetrics(kerbs[0], p).length, 17.85); near(municipalMetrics(kerbs[1], p).length, 22.15);
  const reversed = createRoadsideKerbs(p, { ...road, points: [...road.points].reverse() }); near(municipalMetrics(reversed[0], p).length, 22.15);
});

test('重复生成不重复计价，反向已存在的道缘仍被准确扣除', () => {
  const p = fixture(), road = makeRoad(p), kerbs = createRoadsideKerbs(p, road); p.municipalElements = [road, ...kerbs];
  assert.deepEqual(createRoadsideKerbs(p, road), []); kerbs[0].points.reverse(); assert.deepEqual(createRoadsideKerbs(p, road), []);
});

test('已存在半段路缘石只保留真实未铺余段而不重复收费', () => {
  const p = fixture(), road = makeRoad(p), left = createRoadsideKerbs(p, road, { side: 'left' })[0];
  left.points[1].x = 5500; p.municipalElements = [road, left];
  const remaining = createRoadsideKerbs(p, road, { side: 'left' }); assert.equal(remaining.length, 1); near(totalLength(p, remaining), 5); nearPoint(remaining[0].points[0], { x: 5500, y: 5107.5 });
});

test('隐藏已铺道缘仍扣除已存在长度；异标高和不同规格的施工对象不被错误删掉', () => {
  const p = fixture(), road = makeRoad(p), left = createRoadsideKerbs(p, road, { side: 'left' })[0]; left.hidden = true; p.municipalElements = [road, left];
  assert.deepEqual(createRoadsideKerbs(p, road, { side: 'left' }), []);
  left.elevation = 50; assert.equal(createRoadsideKerbs(p, road, { side: 'left' }).length, 1);
  left.elevation = 0; left.width = 20; assert.equal(createRoadsideKerbs(p, road, { side: 'left' }).length, 1);
});

test('道路工程量不因配套道缘改变，路缘石损耗、人工与材料费用真实计入', () => {
  const p = fixture(), road = makeRoad(p), before = municipalMetrics(road, p), kerbs = createRoadsideKerbs(p, road, { side: 'both', unitPrice: '5', laborRate: '2', wasteRate: '10' });
  p.municipalElements = [road, ...kerbs]; const quote = calculateMunicipalProject(p);
  near(municipalMetrics(road, p).area, before.area); assert.equal(quote.total, '350.00');
  const lines = quote.municipalElements.filter(row => row.kind === 'kerb'); assert.ok(lines.every(row => row.netQuantity === '10' && row.items[0].purchaseQuantity === '11' && row.items[0].materialCost === '55.00' && row.items[0].laborCost === '20.00'));
});

test('三维纵坡端口用真实设计高程，统一标高道缘不会伪造随坡模型', () => {
  const p = fixture(), road = makeRoad(p); road.roadProfile = createRoadProfile(p, road); road.roadProfile.points[0].elevation = 0; road.roadProfile.points.at(-1).elevation = 1; p.municipalElements = [road];
  const ports = municipalConnectionPorts(p); near(ports[0].elevation, 0); near(ports[1].elevation, 100);
  assert.equal(snapMunicipalConnection(p, 'road', road.points[1], { tolerance: 10, elevation: 0 }), null);
  assert.throws(() => createRoadsideKerbs(p, road), /标高变化/);
});

test('四支与旋转八支路口外围道缘保留支路入口，不产生横向阻挡边', () => {
  for (const arms of [4, 8]) {
    const p = fixture(), junction = createMunicipalElement('intersection', [{ x: 15000, y: 15000 }], p, { junction: { arms, armLength: 2500, rotation: 13, islandRadius: 600 } });
    const kerbs = createJunctionKerbs(p, junction); assert.equal(kerbs.length, arms);
    assert.doesNotThrow(() => validateMunicipalElements(kerbs, p));
    for (const arm of municipalJunctionArms(junction, p)) {
      const direction = { x: (arm.end.x - arm.start.x) / 2500, y: (arm.end.y - arm.start.y) / 2500 };
      for (const kerb of kerbs) for (let index = 1; index < kerb.points.length; index++) {
        const a = kerb.points[index - 1], b = kerb.points[index], middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        assert.ok(Math.hypot(middle.x - arm.end.x, middle.y - arm.end.y) > 100, '入口中心不能铺设横向道缘');
        const dot = (b.x - a.x) * direction.x + (b.y - a.y) * direction.y;
        if (Math.abs(dot) < 1e-6) assert.ok(Math.abs((middle.x - arm.end.x) * direction.x + (middle.y - arm.end.y) * direction.y) > 10);
      }
    }
    p.municipalElements = [junction, ...kerbs]; assert.deepEqual(createRoadsideKerbs(p, junction), []);
  }
});

test('环岛外围与中心岛道缘可分别生成，中心岛闭环拆成有效开放路径', () => {
  const p = fixture(), junction = createMunicipalElement('roundabout', [{ x: 15000, y: 15000 }], p, { junction: { arms: 4, armLength: 1800, rotation: 0, islandRadius: 800 } });
  const outer = createJunctionKerbs(p, junction), island = createJunctionKerbs(p, junction, { side: 'both', boundary: 'island' });
  assert.equal(outer.length, 4); assert.equal(island.length, 2); assert.ok(island.every(kerb => kerb.name.includes('中心岛')));
  near(totalLength(p, island), 2 * 128 * (800 - 7.5 / Math.cos(Math.PI / 128)) * Math.sin(Math.PI / 128) * .01, 1e-7);
  assert.doesNotThrow(() => validateMunicipalElements([...outer, ...island], p));
  p.municipalElements = [junction, ...outer, ...island]; assert.deepEqual(createJunctionKerbs(p, junction, { side: 'both', boundary: 'both' }), []);
});

test('非法吸附参数和配套尺寸整次拒绝，不修改源工程', () => {
  const p = fixture(), road = makeRoad(p); p.municipalElements = [road]; const before = structuredClone(p);
  assert.throws(() => snapMunicipalConnection(p, 'road', { x: NaN, y: 5000 }, { tolerance: 10 }));
  assert.throws(() => snapMunicipalConnection(p, 'road', { x: 5000, y: 5000 }, { tolerance: -1 }));
  assert.throws(() => createRoadsideKerbs(p, road, { side: 'both', width: -15 }));
  assert.throws(() => createRoadsideKerbs(p, road, { side: 'both', unitPrice: '-1' })); assert.deepEqual(p, before);
});
