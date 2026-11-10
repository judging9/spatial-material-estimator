import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWallSolid } from '../build/studio/lib/wall-solid.js';
import { continuousWallFaces, pricedWallSurfaces, projectWallSelection, selectedWallSurfaceSide, wallSelection, wallSelectionElevation, wallSurfaceArea } from '../build/studio/lib/wall-selection.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const wall = (id = 'wall', extra = {}) => ({ id, start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 280, ...extra });
const project = (extra = {}) => ({ walls: [wall()], openings: [], wallHeight: 280, ...extra });
const opening = (extra = {}) => ({ id: 'opening', wallId: 'wall', kind: 'hole', shape: 'rectangle', offset: 100, bottom: 100, width: 100, height: 100, depth: 20, ...extra });

test('left and right select actual billed faces; both covers long sides only and never ends, reveals or caps', () => {
  const solid = buildWallSolid(project());
  for (const side of ['left', 'right', 'both']) {
    const selected = wallSelection(solid.surfaces, 'wall', side);
    near(selected.area, side === 'both' ? 23.52 : 11.76);
    assert.ok(selected.surfaces.every(surface => side === 'both' ? ['left', 'right'].includes(surface.side) : surface.side === side));
    assert.ok(!selected.surfaces.some(surface => ['top', 'bottom'].includes(surface.side)));
    assert.equal(selected.surfaceIds.length, selected.surfaces.length);
  }
  const left = wallSelection(solid.surfaces, 'wall', 'left');
  near(left.bounds.min.z, .1); near(left.bounds.max.z, .1);
  const right = wallSelection(solid.surfaces, 'wall', 'right');
  near(right.bounds.min.z, -.1); near(right.bounds.max.z, -.1);
});

test('selection follows the pricing side for real door, ellipse, polygon and window cutouts', () => {
  for (const aperture of [opening(), opening({ shape: 'ellipse' }),
    opening({ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }] }),
    opening({ kind: 'door', bottom: 0, height: 210, depth: 4 }), opening({ kind: 'window', depth: 8 })]) {
    for (const side of ['left', 'right', 'both']) {
      const value = project(); value.walls[0].finishSide = side; value.openings = [aperture];
      const solid = buildWallSolid(value), selected = wallSelection(solid.surfaces, 'wall', side);
      near(selected.area, solid.metrics[0].netArea);
      assert.ok(selected.surfaces.every(surface => !surface.id.startsWith('insert-')));
      assert.ok(selected.area < (side === 'both' ? 23.52 : 11.76));
    }
  }
});

test('door and window inserts cannot become priced wall selection even if passed with wall surfaces', () => {
  const solid = buildWallSolid(project({ openings: [opening({ kind: 'window', depth: 8 })] }));
  const withInserts = [...solid.surfaces, ...solid.inserts.flatMap(insert => insert.surfaces)];
  assert.deepEqual(wallSelection(withInserts, 'wall'), wallSelection(solid.surfaces, 'wall'));
});

test('buried and duplicate source walls select only their actual owned exposed boundaries', () => {
  const solid = buildWallSolid(project({ walls: [wall('tall', { height: 300 }), wall('short', { height: 180 })] }));
  assert.equal(wallSelection(solid.surfaces, 'short').area, 0);
  assert.deepEqual(wallSelection(solid.surfaces, 'short').surfaces, []);
  assert.ok(solid.surfaces.some(surface => surface.sourceIds.includes('short')));
  assert.ok(wallSelection(solid.surfaces, 'tall').area > 0);
  const partial = buildWallSolid(project({ walls: [wall('a'), wall('b', { start: { x: 200, y: 0 }, end: { x: 600, y: 0 } })] }));
  for (const metric of partial.metrics) near(wallSelection(partial.surfaces, metric.id).area, metric.netArea);
});

test('low-wall selection uses clipped true faces without including the artificial top cap', () => {
  const value = project({ openings: [opening({ kind: 'door', bottom: 0, height: 210, depth: 4 })] });
  const full = wallSelection(buildWallSolid(value).surfaces, 'wall', 'left');
  const cut = wallSelection(buildWallSolid(value, .6).surfaces, 'wall', 'left');
  assert.ok(cut.area < full.area); near(cut.bounds.max.y, .6);
  assert.ok(cut.surfaces.every(surface => surface.side === 'left'));
});

test('world polygon area is accurate for translated concave and diagonal planar faces', () => {
  const points = [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, { x: 4, y: 3, z: 4 },
    { x: 2, y: 1, z: 2 }, { x: 0, y: 3, z: 0 }];
  near(wallSurfaceArea(points), 8 * Math.SQRT2);
  near(wallSurfaceArea(points.map(p => ({ x: p.x + 1000000, y: p.y + 1000, z: p.z - 1000000 }))), 8 * Math.SQRT2);
  near(wallSurfaceArea([...points].reverse()), 8 * Math.SQRT2);
  assert.equal(wallSurfaceArea([]), 0);
  assert.throws(() => wallSurfaceArea([{ x: 0, y: 0, z: 0 }, { x: NaN, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }]));
});

test('actual oblique wall selection follows its geometric left normal and pricing area', () => {
  const value = project({ walls: [wall('diagonal', { end: { x: 300, y: 400 }, finishSide: 'left' })] });
  const solid = buildWallSolid(value), selected = wallSelection(solid.surfaces, 'diagonal', 'left');
  near(selected.area, solid.metrics[0].netArea);
  near(selected.area, 5.2 * 2.8);
  for (const surface of selected.surfaces) { near(surface.normal.x, -.8); near(surface.normal.z, .6); }
  const projected = projectWallSelection(solid.surfaces, 'diagonal', 'left');
  assert.ok(projected.segments.length > 0);
  const reverse = project({ walls: [wall('diagonal', { start: { x: 300, y: 400 }, end: { x: 0, y: 0 }, finishSide: 'left' })] });
  for (const surface of wallSelection(buildWallSolid(reverse).surfaces, 'diagonal', 'left').surfaces) { near(surface.normal.x, .8); near(surface.normal.z, -.6); }
});

test('plan projection keeps the chosen offset face and elevation preserves actual polygon holes', () => {
  const solid = buildWallSolid(project({ openings: [opening()] }));
  const projected = projectWallSelection(solid.surfaces, 'wall', 'left', .01);
  assert.equal(projected.faces.length, 1);
  assert.ok(projected.faces.every(face => face.points.every(p => Math.abs(p.y - 10) < 1e-7)));
  assert.ok(projected.segments.every(segment => Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) > 0));
  near(projected.area, 10.76);
  const elevation = wallSelectionElevation(solid.surfaces, wall(), 'left');
  assert.equal(elevation.length, projected.faces.length);
  assert.equal(elevation[0].points.length, 4);
  assert.equal(elevation[0].holes.length, 1);
  assert.ok(elevation[0].holes[0].some(p => Math.abs(p.y - 1) < 1e-8));
  assert.throws(() => projectWallSelection(solid.surfaces, 'wall', 'left', 0));
});

test('only a true left or right side hit changes the selected side', () => {
  assert.equal(selectedWallSurfaceSide({ side: 'left' }), 'left');
  assert.equal(selectedWallSurfaceSide({ side: 'right' }), 'right');
  for (const side of ['top', 'bottom', 'end', 'reveal']) assert.equal(selectedWallSurfaceSide({ side }), undefined);
});

test('selection helpers do not change geometry, apertures or price configuration', () => {
  const source = project({ openings: [opening()] }), before = structuredClone(source);
  const solid = buildWallSolid(source), solidBefore = structuredClone(solid);
  wallSelection(solid.surfaces, 'wall', 'left'); projectWallSelection(solid.surfaces, 'wall', 'right');
  wallSelectionElevation(solid.surfaces, wall(), 'right');
  assert.deepEqual(source, before); assert.deepEqual(solid, solidBefore);
  assert.deepEqual(pricedWallSurfaces(solid.surfaces, null), []);
  assert.deepEqual(wallSelection(solid.surfaces, 'unknown').bounds, null);
  assert.throws(() => pricedWallSurfaces(solid.surfaces, 'wall', 'invalid'));
});

test('rectangle opening merges four subtraction fragments into one full face and one real hole', () => {
  const solid = buildWallSolid(project({ openings: [opening()] }));
  const selected = wallSelection(solid.surfaces, 'wall', 'left');
  assert.ok(selected.surfaces.length > 1);
  assert.equal(selected.faces.length, 1);
  const face = selected.faces[0];
  assert.equal(face.points.length, 4); assert.equal(face.holes.length, 1); assert.equal(face.holes[0].length, 4);
  near(face.area, 10.76); near(face.perimeter, 18); near(selected.area, face.area);
  assert.equal(selected.boundary.length, 16);
  assert.deepEqual(face.sourceSurfaceIds, selected.surfaceIds.sort());
  near(wallSurfaceArea(face.points) - face.holes.reduce((sum, ring) => sum + wallSurfaceArea(ring), 0), face.area);
  // Every visible edge belongs to the outer rectangle or the actual aperture;
  // no artificial clipping diagonal survives in the outline.
  const elevation = wallSelectionElevation(solid.surfaces, wall(), 'left')[0];
  for (const ring of [elevation.points, ...elevation.holes]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]; assert.ok(Math.abs(a.x - b.x) < 1e-8 || Math.abs(a.y - b.y) < 1e-8);
  }
});

test('floor-touching door is a continuous outer notch and low-wall clipping produces two actual components', () => {
  const value = project({ openings: [opening({ kind: 'door', bottom: 0, height: 210, depth: 4 })] });
  const solid = buildWallSolid(value), full = wallSelection(solid.surfaces, 'wall', 'left');
  assert.equal(full.faces.length, 1); assert.equal(full.faces[0].holes.length, 0); assert.equal(full.faces[0].points.length, 8);
  near(full.area, 9.66); near(full.faces[0].perimeter, 18.2);
  const cut = wallSelection(buildWallSolid(value, .6).surfaces, 'wall', 'left');
  assert.equal(cut.faces.length, 2); assert.ok(cut.faces.every(face => face.holes.length === 0 && face.points.length === 4));
  near(cut.area, 3.2 * .6); near(cut.faces.reduce((sum, face) => sum + face.perimeter, 0), 8.8);
});

test('ellipse and concave polygon holes retain their actual ring without mesh seams or bounding rectangles', () => {
  const apertures = [opening({ shape: 'ellipse' }), opening({ shape: 'polygon', points: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ] })];
  for (const aperture of apertures) {
    const solid = buildWallSolid(project({ openings: [aperture] }));
    for (const side of ['left', 'right']) {
      const selected = wallSelection(solid.surfaces, 'wall', side), face = selected.faces[0];
      assert.equal(selected.faces.length, 1); assert.equal(face.holes.length, 1);
      assert.equal(face.points.length, 4); assert.equal(face.holes[0].length, aperture.shape === 'ellipse' ? 128 : 6);
      near(selected.area, solid.metrics[0][side + 'Area']);
      near(wallSurfaceArea(face.points) - wallSurfaceArea(face.holes[0]), face.area);
    }
  }
});

test('T junction is one continuous height notch or two separated faces, with all buried strips excluded', () => {
  for (const height of [180, 280]) {
    const value = project({ walls: [wall(), wall('partition', { start: { x: 200, y: 0 }, end: { x: 200, y: 200 }, height })] });
    const solid = buildWallSolid(value), left = wallSelection(solid.surfaces, 'wall', 'left');
    const right = wallSelection(solid.surfaces, 'wall', 'right');
    near(left.area, 11.76 - .2 * height / 100); near(right.area, 11.76);
    assert.equal(left.faces.length, height === 180 ? 1 : 2); assert.equal(right.faces.length, 1);
    assert.ok(left.faces.every(face => face.holes.length === 0));
    if (height === 180) { assert.equal(left.faces[0].points.length, 8); near(left.faces[0].perimeter, 17.6); }
    else near(left.faces.reduce((sum, face) => sum + face.perimeter, 0), 19.2);
    near(wallSelection(solid.surfaces, 'wall').area, solid.metrics.find(metric => metric.id === 'wall').netArea);
  }
});

test('closed 6 by 4 metre net room has continuous full corner sides, real holes and independent perimeter area', () => {
  const value = project({ walls: [wall('north', { start: { x: 100, y: 100 }, end: { x: 720, y: 100 } }),
    wall('east', { start: { x: 720, y: 100 }, end: { x: 720, y: 520 } }),
    wall('south', { start: { x: 720, y: 520 }, end: { x: 100, y: 520 } }),
    wall('west', { start: { x: 100, y: 520 }, end: { x: 100, y: 100 } })] });
  let solid = buildWallSolid(value);
  near(solid.metrics.reduce((sum, metric) => sum + metric.netArea, 0), (20 + 21.6) * 2.8);
  assert.ok(solid.metrics.every(metric => metric.endArea === 0));
  const before = wallSelection(solid.surfaces, 'north');
  assert.equal(before.faces.length, 2); assert.ok(before.faces.every(face => face.points.length === 4 && face.holes.length === 0)); near(before.area, 34.72);
  value.openings = [opening({ wallId: 'north' })]; solid = buildWallSolid(value);
  const after = wallSelection(solid.surfaces, 'north');
  assert.equal(after.faces.length, 2); assert.ok(after.faces.every(face => face.holes.length === 1)); near(after.area, 32.72);
  near(solid.metrics.reduce((sum, metric) => sum + metric.netArea, 0), 114.48);
});

test('reversed and translated diagonal pierced walls preserve continuous boundaries, area and priced perimeter', () => {
  for (const angle of [.13, .73, 1.2]) for (const reverse of [false, true]) {
    const c = Math.cos(angle), s = Math.sin(angle), start = { x: 999000, y: -999000 }, end = { x: start.x + 400 * c, y: start.y + 400 * s };
    const value = project({ walls: [wall('wall', { start: reverse ? end : start, end: reverse ? start : end })], openings: [opening({ shape: 'ellipse' })] });
    const solid = buildWallSolid(value);
    for (const side of ['left', 'right', 'both']) {
      const selected = wallSelection(solid.surfaces, 'wall', side);
      assert.equal(selected.faces.length, side === 'both' ? 2 : 1);
      assert.ok(selected.faces.every(face => face.points.length === 4 && face.holes.length === 1 && face.holes[0].length === 128));
      near(selected.area, side === 'both' ? solid.metrics[0].netArea : solid.metrics[0][side + 'Area']);
      if (side === 'both') near(selected.faces.reduce((sum, face) => sum + face.perimeter, 0), solid.metrics[0].perimeter);
    }
  }
});

test('duplicate fragments and duplicate/buried source walls cannot duplicate continuous outlines or quantity', () => {
  const value = project({ openings: [opening()] }), solid = buildWallSolid(value);
  const unique = wallSelection(solid.surfaces, 'wall', 'left');
  const repeated = wallSelection([...solid.surfaces, ...solid.surfaces], 'wall', 'left');
  near(repeated.area, unique.area); assert.deepEqual(repeated.faces[0].points, unique.faces[0].points); assert.deepEqual(repeated.faces[0].holes, unique.faces[0].holes);
  const buried = buildWallSolid(project({ walls: [wall('short', { height: 180 }), wall('tall', { height: 300 })] }));
  assert.deepEqual(continuousWallFaces(buried.surfaces, 'short'), []);
  assert.equal(continuousWallFaces(buried.surfaces, 'tall').length, 2);
  for (const face of continuousWallFaces(buried.surfaces, 'tall')) { assert.equal(face.points.length, 4); assert.equal(face.holes.length, 0); near(face.area, 12.6); }
});
