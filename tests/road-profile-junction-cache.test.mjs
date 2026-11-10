import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.ROAD_PROFILE_BUILD ? pathToFileURL(resolve(process.env.ROAD_PROFILE_BUILD) + '/') : new URL('../static/studio/', import.meta.url);
const { createMunicipalElement, municipalMetrics } = await import(new URL('lib/municipal-design.js', root));
const { createRoadProfile, roadDesignTriangles, roadEarthworkDesignTriangles, roadProfileAnalysis, roadControlStations } = await import(new URL('lib/road-profile.js', root));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const area = triangles => triangles.reduce((sum, [a, b, c]) => sum + Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2, 0);

function fixture(kind = 'intersection') {
  const p = { version: 1, id: 'junction-cache', name: '真实交接道路', workspaceMode: 'municipal',
    drawing: { id: 'plan', type: 'plan', width: 12000, height: 12000, url: 'data:image/png;base64,iVBORw0KGgo=' }, calibration: { metersPerPixel: .01 },
    regions: [], walls: [], municipalElements: [], additionalCost: '0', taxRate: '0', view: { labels: true },
    municipalTerrain: { name: '测量平地', visible: true, points: [{ id: 'a', x: 0, y: 0, z: -1 }, { id: 'b', x: 120, y: 0, z: -1 }, { id: 'c', x: 120, y: 120, z: -1 }, { id: 'd', x: 0, y: 120, z: -1 }] },
  };
  const junction = createMunicipalElement(kind, [{ x: 4000, y: 4000 }], p, { unitPrice: '0' });
  const points = kind === 'roundabout' ? [{ x: 5500, y: 4000 }, { x: 8000, y: 4000 }] : [{ x: 3000, y: 4000 }, { x: 7000, y: 4000 }];
  const road = createMunicipalElement('road', points, p, { height: 10, unitPrice: '0', items: [{ id: 'base', name: '基层', thickness: 20, unit: 'm³', unitPrice: '0', wasteRate: '0', laborRate: '0', additionalCost: '0' }] });
  road.roadProfile = createRoadProfile(p, road);
  road.roadProfile.earthwork = { enabled: true, cutUnitPrice: '0', fillUnitPrice: '2.015' };
  p.municipalElements = [junction, road];
  return { p, junction, road };
}

function checkMeasured(p, road, expectedArea) {
  const analysis = roadProfileAnalysis(p, road);
  near(municipalMetrics(road, p).area, expectedArea);
  near(area(roadDesignTriangles(p, road)), expectedArea);
  near(area(roadEarthworkDesignTriangles(p, road)), expectedArea);
  near(analysis.earthworks.formationDepth, .3);
  near(analysis.earthworks.fillVolume, expectedArea * .7);
  near(analysis.earthworks.cutVolume, 0);
  assert.equal(analysis.earthworks.complete, true);
  return analysis;
}

let freshId = 0;
function independent(p) {
  const copied = structuredClone(p);
  copied.municipalElements.forEach(element => element.id += '-fresh-' + (++freshId));
  return { p: copied, road: copied.municipalElements[1] };
}

test('changing junction arm length refreshes owned road roof and formation earthwork without moving IDs', () => {
  const { p, junction, road } = fixture();
  assert.equal(checkMeasured(p, road, 72).earthworks.fillCost, '101.56');
  const ids = p.municipalElements.map(element => element.id);
  junction.junction.armLength = 1000;
  assert.equal(checkMeasured(p, road, 120).earthworks.fillCost, '169.26');
  assert.deepEqual(p.municipalElements.map(element => element.id), ids);
  junction.junction.armLength = 1800;
  checkMeasured(p, road, 72);
});

test('junction rotation and arm count invalidate clipped roof using actual edited contours', () => {
  const { p, junction, road } = fixture();
  const previousArea = area(roadDesignTriangles(p, road));
  for (const next of [{ rotation: 45 }, { arms: 8, armLength: 1800 }, { arms: 3, rotation: 30, armLength: 1200 }]) {
    Object.assign(junction.junction, next);
    const expected = independent(p), expectedArea = municipalMetrics(expected.road, expected.p).area;
    checkMeasured(p, road, expectedArea);
    near(area(roadDesignTriangles(expected.p, expected.road)), expectedArea);
  }
  assert.notEqual(area(roadDesignTriangles(p, road)), previousArea);
});

test('roundabout island radius, approach length and rotation refresh the adjoining graded road', () => {
  const { p, junction, road } = fixture('roundabout');
  checkMeasured(p, road, 60);
  junction.junction.islandRadius = 300;
  checkMeasured(p, road, 78);
  junction.junction.armLength = 2300;
  checkMeasured(p, road, 48);
  junction.junction.rotation = 45;
  checkMeasured(p, road, 150);
});

test('daylight control stations refresh at moved ownership boundaries rather than reusing the old junction edge', () => {
  const { p, junction, road } = fixture();
  road.roadProfile.sideSlopes = { enabled: true, leftCut: 2, rightCut: 2, leftFill: 2, rightFill: 2, maxWidth: 10, interval: 3 };
  const before = roadControlStations(p, road);
  assert.ok(before.some(station => Math.abs(station - 28) < 1e-7));
  junction.junction.armLength = 1150;
  const current = roadControlStations(p, road), fresh = independent(p);
  assert.deepEqual(current, roadControlStations(fresh.p, fresh.road));
  assert.ok(current.some(station => Math.abs(station - 21.5) < 1e-7));
  assert.ok(!current.some(station => Math.abs(station - 28) < 1e-7));
  near(area(roadDesignTriangles(p, road)), municipalMetrics(road, p).area);
});

test('price, waste, labor, fixed fees and budget count change cost without altering design geometry', () => {
  const { p, junction, road } = fixture();
  const roof = roadDesignTriangles(p, road), formation = roadEarthworkDesignTriangles(p, road), controls = roadControlStations(p, road);
  const initial = roadProfileAnalysis(p, road);
  Object.assign(road, { name: '用户道路名称', quantity: '3', unitPrice: '120.345', laborRate: '7', wasteRate: '12', additionalCost: '8.50' });
  Object.assign(junction, { quantity: '2', unitPrice: '44.5', wasteRate: '5', laborRate: '3', additionalCost: '6' });
  Object.assign(road.items[0], { name: '新结构层名称', unitPrice: '3.45', laborRate: '4', wasteRate: '7', additionalCost: '5' });
  road.roadProfile.earthwork.fillUnitPrice = '3.015';
  road.roadProfile.sampleInterval = 5;
  p.additionalCost = '500'; p.taxRate = '9';
  assert.deepEqual(roadDesignTriangles(p, road), roof);
  assert.deepEqual(roadEarthworkDesignTriangles(p, road), formation);
  assert.deepEqual(roadControlStations(p, road), controls);
  const current = roadProfileAnalysis(p, road);
  near(current.earthworks.fillVolume, initial.earthworks.fillVolume);
  assert.equal(current.earthworks.fillCost, '151.96');
  assert.notEqual(current.earthworks.fillCost, initial.earthworks.fillCost);
});
