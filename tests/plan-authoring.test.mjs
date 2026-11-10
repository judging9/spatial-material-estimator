import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoomPoints, roomBounds, isRectangle, resizeRoom, translateRegion, snapRoomTranslation, findRoomPlacement } from '../static/studio/lib/plan-authoring.js';
import { polygonArea, regionMetrics, validateRegion } from '../static/studio/lib/geometry.js';

const room = (id, width, depth, origin = { x: 0, y: 0 }, shape = 'rectangle') => ({ id, name: id, points: makeRoomPoints(shape, width, depth, origin), holes: [], items: [{ unitPrice: '120' }] });

test('输入真实净尺寸生成厘米坐标，面积与比例计算一致', () => {
  const living = room('living', 4.2, 4, { x: 125, y: 270 });
  assert.deepEqual(roomBounds(living), { x: 125, y: 270, width: 420, depth: 400 });
  assert.equal(polygonArea(living.points), 168000);
  assert.equal(regionMetrics(living, { metersPerPixel: .01 }).netArea, 16.8);
  assert.equal(isRectangle(living.points), true);
});

test('L形缺口由真实尺寸决定，不能把外包矩形面积作为净面积', () => {
  const points = makeRoomPoints('l-shape', 6, 4, { x: 20, y: 30 }, 2, 1);
  assert.equal(points.length, 6);
  assert.equal(validateRegion({ points, holes: [] }).valid, true);
  assert.equal(polygonArea(points), 220000);
  assert.equal(regionMetrics({ points }, { metersPerPixel: .01 }).netArea, 22);
  assert.equal(isRectangle(points), false);
  assert.equal(polygonArea(makeRoomPoints('l-shape', 4, 4)), 120000);
});

test('矩形长宽编辑保留房间位置和材料配置；拒绝孔洞和非矩形', () => {
  const original = room('living', 4, 3, { x: 110, y: 210 });
  const resized = resizeRoom(original, 5, 3.5);
  assert.deepEqual(roomBounds(resized), { x: 110, y: 210, width: 500, depth: 350 });
  assert.equal(regionMetrics(resized, { metersPerPixel: .01 }).netArea, 17.5);
  assert.deepEqual(resized.items, original.items);
  assert.equal(resized.id, original.id);
  assert.equal(roomBounds(original).width, 400);
  assert.throws(() => resizeRoom({ ...original, holes: [makeRoomPoints('rectangle', .5, .5, { x: 200, y: 300 })] }, 5, 4), /孔洞/);
  assert.throws(() => resizeRoom(room('l', 4, 4, { x: 0, y: 0 }, 'l-shape'), 5, 4), /矩形/);
  assert.equal(isRectangle([{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}]), false);
});

test('拖动整个房间同时平移孔洞，净面积和材料配置保持不变', () => {
  const original = room('living', 4, 3, { x: 100, y: 100 });
  original.holes = [makeRoomPoints('rectangle', .5, .5, { x: 200, y: 200 })];
  const translated = translateRegion(original, 123, 71);
  assert.deepEqual(translated.holes[0][0], { x: 323, y: 271 });
  assert.deepEqual(translated.points[0], { x: 223, y: 171 });
  assert.deepEqual(translated.items, original.items);
  assert.equal(regionMetrics(translated, { metersPerPixel: .01 }).netArea, regionMetrics(original, { metersPerPixel: .01 }).netArea);
  assert.deepEqual(original.points[0], { x: 100, y: 100 });
});

test('相邻房间边缘磁吸优先于网格，使房间准确贴边且面积不重叠', () => {
  const fixed = room('a', 4.23, 3, { x: 100, y: 100 });
  const moving = room('b', 3, 2, { x: 800, y: 100 });
  const snapped = snapRoomTranslation(moving, -282, 2, [fixed, moving], 1);
  assert.equal(snapped.dx, -277);
  assert.equal(snapped.dy, 0);
  assert.ok(snapped.guides.some(g => g.axis === 'x' && g.value === 523));
  assert.equal(validateRegion(translateRegion(moving, snapped.dx, snapped.dy), [fixed]).valid, true);
});

test('吸附距离以屏幕像素为准，远处房间不吸附，关闭网格保留原移动', () => {
  const fixed = room('a', 4.23, 3, { x: 100, y: 100 });
  const moving = room('b', 3, 2, { x: 800, y: 100 });
  const unsnapped = snapRoomTranslation(moving, -286, 0, [fixed], 1, { grid: false });
  assert.equal(unsnapped.dx, -286);
  assert.equal(unsnapped.guides.filter(g => g.axis === 'x').length, 0);
  const zoomedOut = snapRoomTranslation(moving, -286, 0, [fixed], .5, { grid: false });
  assert.equal(zoomedOut.dx, -277);
  const farAway = room('distant', 4.23, 3, { x: 100, y: 1500 });
  const distant = snapRoomTranslation(moving, -282, 3, [farAway], 1, { grid: false });
  assert.deepEqual(distant, { dx: -282, dy: 3, guides: [] });
});

test('自动放置房间选择相邻空位，隐藏房间仍不允许重复计面积', () => {
  const first = room('a', 4, 3, { x: 100, y: 100 });
  const nextPoints = makeRoomPoints('rectangle', 3, 2);
  assert.deepEqual(findRoomPlacement(nextPoints, []), { x: 100, y: 100 });
  const origin = findRoomPlacement(nextPoints, [{ ...first, hidden: true }]);
  assert.deepEqual(origin, { x: 500, y: 100 });
  const second = room('b', 3, 2, origin);
  assert.equal(validateRegion(second, [first]).valid, true);
  assert.throws(() => findRoomPlacement(makeRoomPoints('rectangle', 4, 3), [room('full', 4, 3)], 400, 300), /没有合适/);
  assert.throws(() => findRoomPlacement(nextPoints, [], 100, 100), /超出/);
});

test('非法尺寸、缺口、坐标和吸附设置明确报错', () => {
  for (const width of [0, -.1, .09, 101, NaN, Infinity]) assert.throws(() => makeRoomPoints('rectangle', width, 3), RangeError);
  assert.throws(() => makeRoomPoints('l-shape', 4, 3, {x:0,y:0}, 4, 1), /缺口/);
  assert.throws(() => makeRoomPoints('l-shape', 4, 3, {x:0,y:0}, 1, 0), /缺口/);
  assert.throws(() => makeRoomPoints('rectangle', 4, 3, {x:NaN,y:0}), /位置/);
  assert.throws(() => translateRegion(room('a', 4, 3), Infinity, 0), /距离/);
  assert.throws(() => snapRoomTranslation(room('a', 4, 3), 0, 0, [], 0), /吸附/);
  assert.throws(() => snapRoomTranslation(room('a', 4, 3), 0, 0, [], 1, {step:0}), /吸附/);
});
