import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Browser modules are .js files. Import this dependency-free file via a data URL
// so `node --test` works without imposing package.json/module settings on Python.
const source = await readFile(new URL("../static/studio/lib/geometry.js", import.meta.url), "utf8");
const geometry = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const {
  polygonArea, polygonPerimeter, validatePolygon, validateRegion,
  regionMetrics, pointInRegion, polygonIntersectionArea, intersectionArea,
  worldToScreen, screenToWorld, regionInteriorPoint,
} = geometry;

const points = coordinates => coordinates.map(([x, y]) => ({ x, y }));
const rectangle = (x, y, width, height) => points([
  [x, y], [x + width, y], [x + width, y + height], [x, y + height],
]);
const region = (id, outline, holes = []) => ({ id, name: `区域${id}`, points: outline, holes, hidden: false });
const close = (actual, expected, epsilon = 1e-8) => assert.ok(
  Math.abs(actual - expected) <= epsilon,
  `expected ${expected}, received ${actual}`,
);

test("rectangle and triangle use image-coordinate shoelace area", () => {
  const outline = rectangle(0, 0, 100, 50);
  assert.equal(polygonArea(outline), 5000);
  assert.equal(polygonPerimeter(outline), 300);
  assert.equal(polygonArea([...outline].reverse()), 5000);
  assert.equal(polygonArea(points([[0, 0], [100, 0], [0, 100]])), 5000);
  assert.equal(polygonArea([]), 0);
  assert.equal(polygonPerimeter([]), 0);
});

test("concave polygon retains its actual area rather than bounding-box area", () => {
  const outline = points([[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]);
  assert.equal(validatePolygon(outline).valid, true);
  assert.equal(polygonArea(outline), 20);
  assert.equal(polygonPerimeter(outline), 24);
  // In the missing corner, bounding boxes overlap but polygon areas do not.
  assert.equal(polygonIntersectionArea(outline, rectangle(3, 3, 2, 2)), 0);
  assert.equal(validateRegion(region("a", outline), [region("b", rectangle(3, 3, 2, 2))]).valid, true);
});

test("collinear boundary vertices are valid and triangulate without duplicated area", () => {
  const outline = points([[0, 0], [2, 0], [4, 0], [4, 4], [2, 4], [0, 4], [0, 2]]);
  assert.equal(validatePolygon(outline).valid, true);
  close(polygonIntersectionArea(outline, rectangle(1, 1, 2, 2)), 4);
  close(polygonIntersectionArea(outline, [...outline].reverse()), 16);
});

test("uncalibrated physical metrics are null; calibration uses squared scale for area", () => {
  const shape = region("a", rectangle(0, 0, 100, 50));
  for (const calibration of [undefined, {}, { metersPerPixel: null }, { metersPerPixel: 0 },
    { metersPerPixel: -1 }, { metersPerPixel: NaN }, { metersPerPixel: Infinity }]) {
    assert.deepEqual(regionMetrics(shape, calibration),
      { netArea: null, perimeter: null, grossArea: null, holesArea: null });
  }
  assert.deepEqual(regionMetrics(shape, { metersPerPixel: 0.02 }),
    { netArea: 2, perimeter: 6, grossArea: 2, holesArea: 0 });
});

test("holes subtract area and add their boundary length", () => {
  const shape = region("a", rectangle(0, 0, 10, 10), [rectangle(3, 3, 2, 2)]);
  assert.equal(validateRegion(shape).valid, true);
  assert.deepEqual(regionMetrics(shape, { metersPerPixel: 0.5 }),
    { netArea: 24, perimeter: 24, grossArea: 25, holesArea: 1 });
  assert.equal(pointInRegion({ x: 1, y: 1 }, shape), true);
  assert.equal(pointInRegion({ x: 0, y: 5 }, shape), true);
  assert.equal(pointInRegion({ x: 4, y: 4 }, shape), false);
  assert.equal(pointInRegion({ x: 3, y: 4 }, shape), false);
  assert.equal(pointInRegion({ x: 20, y: 20 }, shape), false);
});

test("zoom and pan round-trip without changing geometric area or calibrated quantity", () => {
  const shape = region("a", rectangle(10, 20, 100, 50));
  const original = JSON.stringify(shape);
  for (const viewport of [{ zoom: 0.1, panX: 340, panY: -180 }, { zoom: 7, panX: -1000, panY: 30 }]) {
    for (const point of shape.points) {
      const converted = screenToWorld(worldToScreen(point, viewport), viewport);
      close(converted.x, point.x);
      close(converted.y, point.y);
    }
    assert.equal(regionMetrics(shape, { metersPerPixel: 0.02 }).netArea, 2);
  }
  assert.equal(JSON.stringify(shape), original);
});

test("self-crossing, repeated points, zero area and folded adjacent edges are invalid", () => {
  assert.equal(validatePolygon(points([[0, 0], [4, 4], [0, 4], [4, 0]])).code, "self_intersection");
  assert.equal(validatePolygon(points([[0, 0], [4, 0], [4, 4], [0, 0]])).code, "duplicate_point");
  assert.equal(validatePolygon(points([[0, 0], [4, 0], [2, 0], [2, 4], [0, 4]])).code, "degenerate_edge");
  assert.equal(validatePolygon(points([[0, 0], [1, 0], [2, 0]])).valid, false);
  assert.equal(validatePolygon(points([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]])).code, "self_intersection");
  assert.equal(validatePolygon(points([[0, 0], [4, 0]])).code, "too_few_points");
  assert.equal(validatePolygon([{ x: 0, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: 1 }]).code, "invalid_coordinate");
});

test("holes must be strictly interior, including edges bridging a concave notch", () => {
  assert.equal(validateRegion(region("a", rectangle(0, 0, 10, 10), [rectangle(0, 1, 2, 2)])).code, "hole_outside");
  assert.equal(validateRegion(region("a", rectangle(0, 0, 10, 10), [rectangle(9, 1, 2, 2)])).code, "hole_outside");
  const u = points([[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]]);
  const bridge = rectangle(1, 3, 4, 2); // every vertex is inside one arm.
  assert.equal(validateRegion(region("u", u, [bridge])).code, "hole_outside");
});

test("holes cannot overlap, touch, or nest", () => {
  const outer = rectangle(0, 0, 20, 20);
  for (const second of [rectangle(4, 4, 4, 4), rectangle(6, 2, 2, 2), rectangle(3, 3, 1, 1)]) {
    assert.equal(validateRegion(region("a", outer, [rectangle(2, 2, 4, 4), second])).code, "holes_intersect");
  }
  assert.equal(validateRegion(region("a", outer, [rectangle(2, 2, 4, 4), rectangle(10, 10, 4, 4)])).valid, true);
});

test("adjacent edges, corner contact, and rotated boundary contact permit separate regions", () => {
  const first = region("a", rectangle(0, 0, 10, 10));
  for (const second of [region("b", rectangle(10, 0, 10, 10)), region("b", rectangle(10, 10, 4, 4))]) {
    assert.equal(intersectionArea(first, second), 0);
    assert.equal(validateRegion(first, [second]).valid, true);
  }
  const triangleA = region("a", points([[0, 0], [4, 0], [4, 4]]));
  const triangleB = region("b", points([[0, 0], [4, 4], [0, 4]]));
  assert.equal(intersectionArea(triangleA, triangleB), 0);
  assert.equal(validateRegion(triangleA, [triangleB]).valid, true);
});

test("positive overlap is rejected for partial, contained, identical, and thin regions", () => {
  const first = region("a", rectangle(0, 0, 10, 10));
  for (const [outline, expected] of [
    [rectangle(5, 2, 10, 4), 20], [rectangle(2, 2, 2, 2), 4],
    [rectangle(0, 0, 10, 10), 100], [rectangle(9.999, 1, 3, 8), 0.008],
  ]) {
    const second = region("b", outline);
    close(intersectionArea(first, second), expected);
    assert.equal(validateRegion(first, [second]).code, "regions_overlap");
  }
});

test("arbitrary-angle crossing with no vertex containment is detected", () => {
  const horizontal = region("a", rectangle(-5, -1, 10, 2));
  const vertical = region("b", rectangle(-1, -5, 2, 10));
  assert.equal(intersectionArea(horizontal, vertical), 4);
  assert.equal(validateRegion(horizontal, [vertical]).code, "regions_overlap");
  const rotate = (outline, angle) => outline.map(({ x, y }) => ({
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  }));
  const crossing = region("b", rotate(rectangle(-5, -1, 10, 2), Math.PI / 4));
  close(intersectionArea(horizontal, crossing), 4 * Math.sqrt(2));
  assert.equal(validateRegion(horizontal, [crossing]).code, "regions_overlap");
});

test("a separate region entirely in a hole is legal; crossing the hole edge is not", () => {
  const donut = region("a", rectangle(0, 0, 10, 10), [rectangle(2, 2, 6, 6)]);
  const island = region("b", rectangle(3, 3, 4, 4));
  const exactHole = region("b", rectangle(2, 2, 6, 6));
  assert.equal(intersectionArea(donut, island), 0);
  assert.equal(intersectionArea(donut, exactHole), 0);
  assert.equal(validateRegion(island, [donut]).valid, true);
  assert.equal(validateRegion(exactHole, [donut]).valid, true);
  const crossing = region("b", rectangle(7, 3, 2, 2));
  assert.equal(intersectionArea(donut, crossing), 2);
  assert.equal(validateRegion(crossing, [donut]).code, "regions_overlap");
});

test("both regions' holes are accounted for with inclusion/exclusion", () => {
  const first = region("a", rectangle(0, 0, 10, 10), [rectangle(2, 2, 4, 4)]);
  const second = region("b", rectangle(0, 0, 10, 10), [rectangle(4, 4, 4, 4)]);
  // 100 - 16 - 16 + 4 = 72, without double-subtracting shared hole area.
  assert.equal(intersectionArea(first, second), 72);
  assert.equal(intersectionArea(second, first), 72);
});

test("translation to large coordinates preserves area, overlap, and orientation", () => {
  const translate = (outline, dx, dy) => outline.map(({ x, y }) => ({ x: x + dx, y: y + dy }));
  const first = region("a", translate(rectangle(0, 0, 10, 10), 1e9, -1e9));
  const second = region("b", translate(rectangle(5, 5, 10, 10), 1e9, -1e9));
  assert.equal(polygonArea(first.points), 100);
  close(intersectionArea(first, second), 25, 1e-5);
  assert.equal(validateRegion(first, [second]).code, "regions_overlap");
});

test("editing validation ignores the previous version of the same ID but checks hidden regions", () => {
  const original = region("a", rectangle(0, 0, 10, 10));
  const changed = region("a", rectangle(0, 0, 12, 10));
  assert.equal(validateRegion(changed, [original]).valid, true);
  const neighbour = region("b", rectangle(10, 0, 10, 10));
  neighbour.hidden = true;
  assert.equal(validateRegion(changed, [original, neighbour]).code, "regions_overlap");
  const invalidEdit = region("a", points([[0, 0], [12, 12], [0, 12], [12, 0]]));
  assert.equal(validateRegion(invalidEdit, [original, neighbour]).code, "self_intersection");
});

test("intersection symmetry and conservation hold for concave partitions", () => {
  const concave = points([[0, 0], [8, 0], [8, 2], [5, 2], [5, 6], [3, 6], [3, 2], [0, 2]]);
  const covering = rectangle(-1, -1, 10, 10);
  close(polygonIntersectionArea(concave, covering), polygonArea(concave));
  for (const cut of [rectangle(1, 1, 5, 3), rectangle(2, 0, 4, 6), rectangle(0, 0, 4, 8)]) {
    close(polygonIntersectionArea(concave, cut), polygonIntersectionArea(cut, concave));
    assert.ok(polygonIntersectionArea(concave, cut) <= Math.min(polygonArea(concave), polygonArea(cut)) + 1e-8);
  }
});

test("deterministic complex concave shapes conserve area across triangulation and winding", () => {
  let seed = 0x54d6281;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const radialPolygon = (count, dx = 0, dy = 0) => Array.from({ length: count }, (_, index) => {
    const angle = (index + random() * 0.4) * Math.PI * 2 / count;
    const radius = 2 + random() * 8;
    return { x: dx + Math.cos(angle) * radius, y: dy + Math.sin(angle) * radius };
  });
  for (let sample = 0; sample < 64; sample += 1) {
    const first = radialPolygon(8 + sample % 19);
    const second = radialPolygon(9 + sample % 17, random() * 14 - 7, random() * 14 - 7);
    assert.equal(validatePolygon(first).valid, true);
    assert.equal(validatePolygon(second).valid, true);
    close(polygonIntersectionArea(first, [...first].reverse()), polygonArea(first), 1e-7);
    const overlap = polygonIntersectionArea(first, second);
    close(overlap, polygonIntersectionArea(second, first), 1e-7);
    assert.ok(overlap >= 0);
    assert.ok(overlap <= Math.min(polygonArea(first), polygonArea(second)) + 1e-7);
  }
});

test("label anchors stay inside concave regions and outside their holes", () => {
  const concave = region('l', points([[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]));
  const donut = region('d', rectangle(0, 0, 10, 10), [rectangle(2, 2, 6, 6)]);
  const multiHole = region('h', rectangle(0, 0, 20, 12), [rectangle(2, 2, 6, 8), rectangle(12, 2, 6, 8)]);
  for (const shape of [concave, donut, multiHole]) {
    const original = JSON.stringify(shape);
    const anchor = regionInteriorPoint(shape);
    assert.ok(anchor);
    assert.equal(pointInRegion(anchor, shape), true);
    assert.equal(JSON.stringify(shape), original);
    const moved = { ...shape,
      points: shape.points.map(({ x, y }) => ({ x: x * 3 + 19, y: y * 3 - 12 })),
      holes: shape.holes.map(hole => hole.map(({ x, y }) => ({ x: x * 3 + 19, y: y * 3 - 12 }))),
    };
    const movedAnchor = regionInteriorPoint(moved);
    assert.ok(movedAnchor);
    assert.equal(pointInRegion(movedAnchor, moved), true);
  }
  assert.deepEqual(regionInteriorPoint(region('r', rectangle(0, 0, 10, 8))), { x: 5, y: 4 });
  assert.equal(regionInteriorPoint(region('bad', points([[0, 0], [4, 4], [0, 4], [4, 0]]))), null);
});
