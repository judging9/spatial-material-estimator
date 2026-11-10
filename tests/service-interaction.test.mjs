import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceRouteAt, serviceVertexAt, snapServicePoint } from '../build/studio/lib/service-interaction.js';
const route = (id, points, hidden = false) => ({ id, points, hidden });
const project = (extra = {}) => ({ drawing: { type: 'plan', width: 1200, height: 1000 }, walls: [], furniture: [], serviceRoutes: [], ...extra });
test('small or vertical routes remain selectable with a screen-space tolerance at different zooms', () => {
  const line = route('network', [{ x: 100, y: 100, z: 0 }, { x: 400, y: 100, z: 0 }]);
  const vertical = route('riser', [{ x: 800, y: 200, z: 0 }, { x: 800, y: 200, z: 270 }]);
  const p = project({ serviceRoutes: [line, vertical] });
  for (const zoom of [.2, 1, 5]) { assert.equal(serviceRouteAt(p, { x: 200, y: 100 + 6 / zoom }, zoom).id, 'network'); assert.equal(serviceRouteAt(p, { x: 200, y: 100 + 8 / zoom }, zoom), null); assert.equal(serviceRouteAt(p, { x: 800 + 6 / zoom, y: 200 }, zoom).id, 'riser'); }
});
test('selected intersecting line retains picking priority and hidden routes cannot be selected', () => {
  const a = route('a', [{ x: 100, y: 200 }, { x: 400, y: 200 }]), b = route('b', [{ x: 250, y: 100 }, { x: 250, y: 400 }]);
  const p = project({ serviceRoutes: [a, b] }); assert.equal(serviceRouteAt(p, { x: 250, y: 200 }, 1).id, 'b'); assert.equal(serviceRouteAt(p, { x: 250, y: 200 }, 1, 'a').id, 'a');
  a.hidden = b.hidden = true; assert.equal(serviceRouteAt(p, { x: 250, y: 200 }, 1), null);
});
test('vertex picking distinguishes line handles and permits editing vertical endpoints', () => {
  const a = route('a', [{ x: 100, y: 100, z: 0 }, { x: 100, y: 100, z: 270 }, { x: 400, y: 100, z: 270 }]);
  assert.equal(serviceVertexAt(a, { x: 100, y: 100 }, .6), 1); assert.equal(serviceVertexAt(a, { x: 300, y: 100 }, 1), null); a.hidden = true; assert.equal(serviceVertexAt(a, { x: 100, y: 100 }, 1), null);
});
test('snapping connects to actual hardware and wall positions without changing saved geometry', () => {
  const p = project({ furniture: [{ position: { x: 310.7, y: 110.3 } }], walls: [{ start: { x: 100, y: 100 }, end: { x: 700, y: 400 } }] }); const before = structuredClone(p);
  assert.deepEqual(snapServicePoint(p, { x: 312, y: 111 }, 1), { x: 310.7, y: 110.3 }); assert.deepEqual(snapServicePoint(p, { x: 403, y: 244 }, 1), { x: 400, y: 250 }); assert.deepEqual(p, before);
});
test('orthogonal drawing preserves the chosen axis and image coordinates are not rounded to native centimetres', () => {
  const p = project(); assert.deepEqual(snapServicePoint(p, { x: 197, y: 137 }, 1, { x: 100, y: 133 }, true), { x: 195, y: 133 });
  p.drawing.type = 'png'; assert.deepEqual(snapServicePoint(p, { x: 197.345, y: 137.678 }, 1), { x: 197.345, y: 137.678 }); assert.deepEqual(snapServicePoint(p, { x: -20, y: 1400 }, 1), { x: 0, y: 1000 });
});
test('node edits do not snap back onto their own route but can snap to other visible lines', () => {
  const p = project({ serviceRoutes: [route('a', [{ x: 201.7, y: 150.2 }, { x: 400, y: 200 }]), route('b', [{ x: 205.3, y: 155.2 }, { x: 550, y: 400 }], true)] });
  assert.deepEqual(snapServicePoint(p, { x: 202, y: 152 }, 1, undefined, false, 'a'), { x: 200, y: 150 }); p.serviceRoutes[1].hidden = false; assert.deepEqual(snapServicePoint(p, { x: 202, y: 152 }, 1, undefined, false, 'a'), { x: 205.3, y: 155.2 });
});
