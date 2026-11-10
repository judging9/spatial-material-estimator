import type { Project } from '../types.js';
import { createMunicipalElement, municipalScale, validateMunicipalElements, type MunicipalElement, type MunicipalKind } from './municipal-design.js';
import { createRoadProfile, validateRoadProfile } from './road-profile.js';

export type MunicipalStarter = 'crossroads' | 'eight-way' | 'roundabout' | 'river-bridge';
export type StarterSettings = { x: number; y: number; length: number; lanes: 2 | 4 | 6 | 8 };

/** Editable concept layouts, in real metres. No inferred prices or quantities. */
export function createMunicipalStarter(project: Project, preset: MunicipalStarter, settings: StarterSettings): MunicipalElement[] {
  if (!['crossroads', 'eight-way', 'roundabout', 'river-bridge'].includes(preset)) throw new RangeError('请选择有效的场地起步方案。');
  const scale = municipalScale(project);
  if (!scale) throw new RangeError('请先校准图纸比例。');
  if (![settings.x, settings.y, settings.length].every(Number.isFinite) || settings.x < 0 || settings.y < 0 || settings.length < 25 || settings.length > 500 || ![2, 4, 6, 8].includes(settings.lanes)) throw new RangeError('中心位置须有效，支路长度应为 25–500 m。');
  const elements: MunicipalElement[] = [], center = { x: settings.x / scale, y: settings.y / scale };
  const point = (x: number, y: number) => ({ x: center.x + x / scale, y: center.y + y / scale });
  const add = (kind: MunicipalKind, points: { x: number; y: number }[], patch: Partial<MunicipalElement>) => {
    const element = createMunicipalElement(kind, points, project, patch);
    elements.push(element);
    return element;
  };
  const roadLayout = { lanes: settings.lanes, laneWidth: 350, medianWidth: settings.lanes > 2 ? 100 : 0 };
  const width = roadLayout.lanes * roadLayout.laneWidth + roadLayout.medianWidth;
  if (preset === 'river-bridge') {
    add('river', [point(-settings.length, 0), point(settings.length, 0)], { name: '河道', width: 1200, depth: 200, elevation: -100 });
    add('bridge', [point(0, -12), point(0, 12)], { name: '跨河桥梁', width, height: 40, elevation: 500, roadLayout, bridgeOptions: { pierSpacing: 800, pierHeight: 800, railingHeight: 120, pierPricingEnabled: true, railingPricingEnabled: true, pierUnitPrice: '', railingUnitPrice: '' } });
    const north = add('road', [point(0, -settings.length), point(0, -12)], { name: '北侧桥头道路', width, roadLayout, elevation: 0 });
    const south = add('road', [point(0, 12), point(0, settings.length)], { name: '南侧桥头道路', width, roadLayout, elevation: 500 });
    for (const road of [north, south]) {
      road.roadProfile = createRoadProfile(project, road); road.roadProfile.enabled = true;
      road.roadProfile.points[0].elevation = road === north ? 0 : 5;
      road.roadProfile.points.at(-1).elevation = road === north ? 5 : 0;
      validateRoadProfile(project, road);
    }
  } else {
    const arms = preset === 'eight-way' ? 8 : 4, round = preset === 'roundabout';
    const armLength = Math.max(18, width / 100 * (arms === 8 ? 1.5 : 1));
    const junction = { arms: arms as 4 | 8, armLength: armLength * 100, rotation: 0, islandRadius: 600 };
    add(round ? 'roundabout' : 'intersection', [center], { name: round ? '环岛路口' : arms === 8 ? '八支路交汇' : '十字路口', width, roadLayout, junction });
    for (let index = 0; index < arms; index++) {
      const angle = index * Math.PI * 2 / arms, c = Math.cos(angle), s = Math.sin(angle);
      const start = round ? armLength + 6 + width / 100 : armLength;
      if (settings.length <= start + 1) throw new RangeError('当前车道数需要更长的支路，请增加支路长度。');
      add('road', [point(c * start, s * start), point(c * settings.length, s * settings.length)], { name: `支路 ${index + 1}`, width, roadLayout });
      if (!round) {
        const offset = width / 200 + 1, distance = armLength - 2;
        add('trafficlight', [point(c * distance - s * offset, s * distance + c * offset)], { name: `信号灯 ${index + 1}`, trafficSignal: { phase: 'red', rotation: angle * 180 / Math.PI + 90 } });
      }
    }
  }
  validateMunicipalElements([...(project.municipalElements ?? []), ...elements], project);
  return elements;
}
