import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.MUNICIPAL_BUILD ? pathToFileURL(resolve(process.env.MUNICIPAL_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const [{ DrawingViewer }, { createMunicipalElement, municipalMetrics }, { municipalConnectionPorts }, { municipalDrawingPreview }, { createMunicipalCatalogElement }] = await Promise.all([
  'canvas.js', 'lib/municipal-design.js', 'lib/municipal-connections.js', 'municipal-canvas.js', 'lib/municipal-catalog.js',
].map(file => import(new URL(file, modules))));

const fixture = () => ({ version: 1, id: 'drawing-controller', name: '场地', workspaceMode: 'municipal', drawing: { id: 'plan', type: 'plan', width: 120000, height: 90000 }, calibration: { metersPerPixel: .01 }, regions: [], walls: [], municipalElements: [], view: { labels: true } });
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

/** Real controller methods with a minimal canvas adapter: no browser, mocked
 * geometry or mocked interaction algorithm is involved. */
function harness(project = fixture(), zoom = .1) {
  const viewer = Object.create(DrawingViewer.prototype), captures = new Set(), created = [], errors = [], commits = [];
  const canvas = { style: {}, focus() {}, getBoundingClientRect: () => ({ left: 40, top: 24 }), setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  Object.assign(viewer, { project, canvas, selectedId: null, selectedMunicipalId: null, tool: 'select', view: { zoom, panX: 17, panY: -8 }, draft: [], municipalSettings: {}, municipalKind: null, municipalAnchorPort: null, municipalConnection: null, drag: null, guides: [], rectanglePoints: [], space: false, paintSoon() {} });
  viewer.callbacks = {
    error: message => errors.push(message), tool() {}, status() {}, select() {},
    createMunicipal: (kind, points, settings) => {
      const item = settings?.catalogId ? createMunicipalCatalogElement(settings.catalogId, points, project, settings) : createMunicipalElement(kind, points, project, settings);
      created.push({ kind, points, settings, item }); project.municipalElements.push(item);
    },
    previewMunicipal: (id, points) => { project.municipalElements.find(item => item.id === id).points = structuredClone(points); },
    commitMunicipal: (id, points) => { commits.push({ id, points }); project.municipalElements.find(item => item.id === id).points = structuredClone(points); },
  };
  const event = (point, extra = {}) => { const screen = viewer.toScreen(point); return { clientX: screen.x + 40, clientY: screen.y + 24, pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, preventDefault() {}, ...extra }; };
  const click = (point, extra = {}) => { viewer.pointerDown(event(point, extra)); viewer.pointerUp(event(point, extra)); };
  const drag = (start, end, extra = {}) => { viewer.pointerDown(event(start, extra)); viewer.pointerMove(event(end, extra)); viewer.pointerUp(event(end, extra)); };
  return { viewer, created, errors, project, event, click, drag, captures, commits };
}

for (const lanes of [2, 4, 6, 8]) test(`dragging a ${lanes}-lane road submits actual geometry, dimensions and reliable quantities`, () => {
  const h = harness(), layout = { lanes, laneWidth: 350, medianWidth: lanes > 2 ? 100 : 0 };
  h.viewer.beginMunicipalDrawing('road', { roadLayout: layout }); h.drag({ x: 10000, y: 10000 }, { x: 14000, y: 13000 });
  assert.equal(h.created.length, 1); assert.deepEqual(h.created[0].points, [{ x: 10000, y: 10000 }, { x: 14000, y: 13000 }]);
  assert.deepEqual(h.created[0].settings.roadLayout, layout); assert.equal(h.created[0].item.width, lanes * 350 + layout.medianWidth);
  near(municipalMetrics(h.created[0].item, h.project).area, 50 * (lanes * 3.5 + layout.medianWidth / 100));
  assert.equal(h.created[0].item.unitPrice, ''); assert.equal(h.viewer.tool, 'select'); assert.equal(h.captures.size, 0); assert.deepEqual(h.errors, []);
});

test('clicks preserve a polyline draft; Enter or an ending drag completes the entire line', () => {
  const h = harness(); h.viewer.beginMunicipalDrawing('road');
  h.click({ x: 10000, y: 10000 }); h.click({ x: 13000, y: 11000 });
  assert.equal(h.created.length, 0); assert.equal(h.viewer.draft.length, 2); assert.equal(h.captures.size, 0);
  h.drag({ x: 14000, y: 12000 }, { x: 16000, y: 13000 });
  assert.equal(h.created.length, 1); assert.equal(h.created[0].points.length, 4);
  h.viewer.beginMunicipalDrawing('kerb'); h.click({ x: 20000, y: 20000 }); h.click({ x: 24000, y: 22000 }); h.viewer.finish();
  assert.equal(h.created[1].kind, 'kerb'); near(municipalMetrics(h.created[1].item, h.project).length, Math.hypot(40, 20));
});

test('pointer cancellation restores the full previous draft without creating a project element', () => {
  const h = harness(); h.viewer.beginMunicipalDrawing('road', { width: 525 }); h.click({ x: 10000, y: 10000 });
  const before = structuredClone(h.project); h.viewer.pointerDown(h.event({ x: 12000, y: 11000 })); h.viewer.pointerMove(h.event({ x: 14000, y: 12000 })); h.viewer.cancelDrag();
  assert.deepEqual(h.viewer.draft, [{ x: 10000, y: 10000 }]); assert.deepEqual(h.viewer.getMunicipalDraftSettings(), { width: 525 }); assert.equal(h.created.length, 0); assert.deepEqual(h.project, before); assert.equal(h.captures.size, 0);
});

test('secondary pointers cannot move or complete the active road drag', () => {
  const h = harness(); h.viewer.beginMunicipalDrawing('road'); h.viewer.pointerDown(h.event({ x: 10000, y: 10000 }));
  h.viewer.pointerMove(h.event({ x: 14000, y: 14000 }, { pointerId: 2 })); h.viewer.pointerUp(h.event({ x: 14000, y: 14000 }, { pointerId: 2 }));
  assert.equal(h.created.length, 0); assert.equal(h.viewer.drag.pointerId, 1); h.viewer.pointerUp(h.event({ x: 13000, y: 12000 }));
  assert.equal(h.created.length, 1); assert.deepEqual(h.created[0].points[1], { x: 13000, y: 12000 });
});

test('a rotated junction port supplies exact start, elevation and implicit carriageway layout', () => {
  const p = fixture(), junction = createMunicipalElement('intersection', [{ x: 20000, y: 20000 }], p, { elevation: 125, roadLayout: { lanes: 8, laneWidth: 320, medianWidth: 80 }, junction: { arms: 8, armLength: 6000, rotation: 22.5, islandRadius: 600 } }); p.municipalElements.push(junction);
  const port = municipalConnectionPorts(p)[0], h = harness(p), start = { x: port.point.x + 30, y: port.point.y - 20 };
  h.viewer.beginMunicipalDrawing('road'); h.click(start);
  assert.deepEqual(h.viewer.draft[0], port.point); assert.deepEqual(h.viewer.getMunicipalDraftSettings(), { width: 2640, roadLayout: junction.roadLayout, elevation: 125 });
  const end = { x: port.point.x + port.direction.x * 4000 - port.direction.y * 8, y: port.point.y + port.direction.y * 4000 + port.direction.x * 8 };
  h.viewer.pointerDown(h.event(end)); h.viewer.pointerUp(h.event(end)); h.viewer.finish();
  assert.equal(h.created.length, 1); const delta = { x: h.created[0].points[1].x - port.point.x, y: h.created[0].points[1].y - port.point.y };
  near(delta.x * port.direction.y - delta.y * port.direction.x, 0); assert.equal(h.created[0].item.elevation, 125); assert.equal(h.created[0].item.width, 2640); assert.deepEqual(h.errors, []);
});

for (const angle of [0, 22.5]) test(`native aligned drawing preserves centimetre length at low zoom on a ${angle} degree approach`, () => {
  const p = fixture(), a = angle * Math.PI / 180, u = { x: Math.cos(a), y: Math.sin(a) };
  const target = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 10000 + 5000 * u.x, y: 10000 + 5000 * u.y }], p, { width: 1500 });
  p.municipalElements = [target];
  const anchor = target.points[1], h = harness(p, .02941);
  h.viewer.beginMunicipalDrawing('road');
  h.drag(anchor, { x: anchor.x + 3199.999529337294 * u.x - 50 * u.y, y: anchor.y + 3199.999529337294 * u.y + 50 * u.x });
  assert.equal(h.created.length, 1);
  const end = h.created[0].points[1];
  near(Math.hypot(end.x - anchor.x, end.y - anchor.y), 3200);
  near((end.x - anchor.x) * u.y - (end.y - anchor.y) * u.x, 0);
  near(municipalMetrics(h.created[0].item, p).area, 480);
});

test('aligned image drawing retains continuous calibrated coordinates', () => {
  const p = fixture(); p.drawing.type = 'image';
  const target = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p);
  p.municipalElements = [target];
  const h = harness(p, .02941); h.viewer.beginMunicipalDrawing('road');
  h.drag(target.points[1], { x: 18200.1234, y: 10050 });
  assert.equal(h.created.length, 1);
  near(h.created[0].points[1].x, 18200.1234); near(h.created[0].points[1].y, 10000);
});

test('cancelling the first snapped drag also removes inherited dimensions and elevation', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p, { width: 880, elevation: 350 }); p.municipalElements.push(road);
  const h = harness(p); h.viewer.beginMunicipalDrawing('road'); h.viewer.pointerDown(h.event({ x: 15020, y: 10010 }));
  assert.equal(h.viewer.getMunicipalDraftSettings().width, 880); h.viewer.cancelDrag();
  assert.deepEqual(h.viewer.getMunicipalDraftSettings(), {}); assert.equal(h.viewer.municipalAnchorPort, null); assert.deepEqual(h.viewer.draft, []);
});

test('removing the first vertex releases inherited properties before a different connection is selected', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p, { width: 880, elevation: 350 }); p.municipalElements.push(road);
  const h = harness(p); h.viewer.beginMunicipalDrawing('road'); h.click({ x: 15020, y: 10010 }); h.viewer.removeDraftPoint();
  assert.deepEqual(h.viewer.getMunicipalDraftSettings(), {}); assert.equal(h.viewer.municipalAnchorPort, null); h.click({ x: 25000, y: 20000 }); assert.deepEqual(h.viewer.getMunicipalDraftSettings(), {});
});

test('explicit road layout or width survives port snapping and new tool settings never leak', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p, { roadLayout: { lanes: 8, laneWidth: 350, medianWidth: 100 } }); p.municipalElements.push(road);
  for (const settings of [{ width: 490 }, { roadLayout: { lanes: 4, laneWidth: 300, medianWidth: 80 } }]) {
    const h = harness(structuredClone(p)); h.viewer.beginMunicipalDrawing('road', settings); h.click({ x: 15010, y: 10010 });
    assert.deepEqual(h.viewer.getMunicipalDraftSettings(), { ...settings, elevation: 0 });
  }
  const h = harness(); h.viewer.beginMunicipalDrawing('road', { roadLayout: { lanes: 8, laneWidth: 350, medianWidth: 100 } });
  const clone = h.viewer.getMunicipalDraftSettings(); clone.roadLayout.lanes = 2; assert.equal(h.viewer.getMunicipalDraftSettings().roadLayout.lanes, 8);
  h.viewer.beginMunicipalDrawing('facility', { catalogId: 'street-bench', rotation: 35 }); assert.equal(h.viewer.getMunicipalDraftKind(), 'facility'); assert.equal(h.viewer.getMunicipalDraftSettings().roadLayout, undefined);
  h.click({ x: 10000, y: 10000 }); assert.equal(h.created[0].item.catalogId, 'street-bench'); assert.equal(h.created[0].item.rotation, 35); assert.equal(h.viewer.getMunicipalDraftKind(), null);
  h.viewer.beginMunicipalDrawing('road'); assert.deepEqual(h.viewer.getMunicipalDraftSettings(), {});
});

test('Alt releases port and centimetre magnets while Shift retains the orthogonal axis', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p); p.municipalElements.push(road);
  const h = harness(p); h.viewer.beginMunicipalDrawing('road'); const point = { x: 15020.4, y: 10015.2 };
  h.click(point, { altKey: true }); near(h.viewer.draft[0].x, point.x); near(h.viewer.draft[0].y, point.y); assert.deepEqual(h.viewer.getMunicipalDraftSettings(), {});
  h.viewer.pointerMove(h.event({ x: 17000, y: 10900 }, { shiftKey: true })); near(h.viewer.cursor.y, point.y);
});

test('a different-elevation road cannot attract the final vertex through generic magnets', () => {
  const p = fixture(), upper = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p, { elevation: 350 }), lower = createMunicipalElement('road', [{ x: 19000, y: 14000 }, { x: 24000, y: 14000 }], p, { elevation: 0 }); p.municipalElements.push(upper, lower);
  const h = harness(p); h.viewer.beginMunicipalDrawing('road'); h.click({ x: 15020, y: 10010 }); h.click({ x: 19010, y: 14020 }); h.viewer.finish();
  assert.equal(h.created.length, 1); assert.deepEqual(h.created[0].points[1], { x: 19010, y: 14020 }); assert.equal(h.created[0].item.elevation, 350);
});

test('failed creation preserves existing project data and leaves a correctable draft', () => {
  const h = harness(), before = structuredClone(h.project); h.viewer.beginMunicipalDrawing('road', { roadLayout: { lanes: 8, laneWidth: 350, medianWidth: 100 } }); h.drag({ x: 10, y: 10 }, { x: 1500, y: 10 });
  assert.equal(h.created.length, 0); assert.equal(h.errors.length, 1); assert.equal(h.viewer.tool, 'municipal'); assert.equal(h.viewer.draft.length, 2); assert.deepEqual(h.project, before);
});

test('editing a kerb endpoint respects its own width when aligning to the outside road edge', () => {
  const p = fixture(), road = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 18000, y: 10000 }], p, { width: 1000 }), kerb = createMunicipalElement('kerb', [{ x: 10000, y: 11000 }, { x: 18000, y: 11000 }], p, { width: 30 }); p.municipalElements.push(road, kerb);
  const h = harness(p); h.viewer.selectedMunicipalId = kerb.id; h.drag(kerb.points[0], { x: 12000, y: 10517 });
  assert.equal(h.commits.length, 1); near(kerb.points[0].y, 10515); assert.equal(kerb.width, 30); assert.equal(h.viewer.municipalConnection, null);
});

test('dragging a whole road to an exact endpoint preserves segment lengths and cancellation restores them', () => {
  const p = fixture(), target = createMunicipalElement('road', [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], p), moving = createMunicipalElement('road', [{ x: 18000, y: 13000 }, { x: 21000, y: 14000 }], p); p.municipalElements.push(target, moving);
  const h = harness(p), original = structuredClone(moving.points); h.viewer.selectedMunicipalId = moving.id;
  h.viewer.pointerDown(h.event({ x: 19500, y: 13500 })); h.viewer.pointerMove(h.event({ x: 16520, y: 10510 }));
  assert.equal(h.viewer.drag.kind, 'municipal-move'); assert.deepEqual(moving.points[0], target.points[1]); near(Math.hypot(moving.points[1].x - moving.points[0].x, moving.points[1].y - moving.points[0].y), Math.hypot(3000, 1000));
  h.viewer.cancelDrag(); assert.deepEqual(moving.points, original); assert.equal(h.commits.length, 0);
});

test('preview geometry uses exactly the committed lane and catalog configuration', () => {
  const p = fixture(), points = [{ x: 10000, y: 10000 }, { x: 15000, y: 10000 }], settings = { roadLayout: { lanes: 6, laneWidth: 320, medianWidth: 90 }, elevation: 45 };
  const preview = municipalDrawingPreview('road', points, p, settings), committed = createMunicipalElement('road', points, p, settings); assert.equal(preview.width, committed.width); assert.equal(preview.elevation, 45); near(municipalMetrics(preview, p).area, municipalMetrics(committed, p).area);
  const facility = municipalDrawingPreview('facility', [points[0]], p, { catalogId: 'bus-shelter', rotation: 17 }); assert.equal(facility.name, '公交候车亭'); assert.equal(facility.width, 500); assert.equal(facility.rotation, 17);
});
