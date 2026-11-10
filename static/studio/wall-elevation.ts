import type { Project } from './types.js';
import type { Wall } from './lib/wall-plan.js';
import { buildWallSolid } from './lib/wall-solid.js';
import { wallSelectionElevation } from './lib/wall-selection.js';
import { escape, measure } from './ui.js';

let geometryKey = '';
let solid: ReturnType<typeof buildWallSolid> | null = null;

/** Draw actual merged side boundaries; internal fragments never become lines. */
export function renderWallElevation(project: Project | undefined, wall: Wall): string {
  if (!project) return '';
  const key = JSON.stringify([project.walls?.map(({ id, start, end, thickness, height }) => ({ id, start, end, thickness, height })), project.openings, project.wallHeight, project.wallJoinStyle]);
  if (!solid || geometryKey !== key) { solid = buildWallSolid(project); geometryKey = key; }
  const side = wall.finishSide ?? 'both';
  const faces = wallSelectionElevation(solid.surfaces, wall, side);
  const sides = side === 'both' ? ['left', 'right'] as const : [side];
  const cards = sides.map(value => {
    const selected = faces.filter(face => face.side === value);
    if (!selected.length) return `<div class="wall-elevation"><div>${value === 'left' ? '左侧' : '右侧'}施工面<span>无裸露面</span></div></div>`;
    const points = selected.flatMap(face => face.points), minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const width = Math.max(.01, maxX - minX), height = Math.max(.01, maxY - minY), pad = Math.max(width, height) * .06;
    const path = ring => ring.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(8)} ${(-p.y).toFixed(8)}`).join(' ') + ' Z';
    return `<div class="wall-elevation"><div><span>${value === 'left' ? '左侧' : '右侧'}施工面</span><span>${measure(selected.reduce((sum, face) => sum + face.area, 0))} m²</span></div><svg viewBox="${minX - pad} ${-maxY - pad} ${width + pad * 2} ${height + pad * 2}" role="img" aria-label="${value === 'left' ? '左侧' : '右侧'}连续墙面，孔洞留空" data-side="${value}" data-face-count="${selected.length}" data-hole-count="${selected.reduce((sum, face) => sum + face.holes.length, 0)}">${selected.map(face => `<path data-face-id="${escape(face.id)}" d="${path(face.points)} ${face.holes.map(path).join(' ')}" fill-rule="evenodd" clip-rule="evenodd" fill="#dbe8dd" stroke="#54836b" stroke-width="1.2"/>`).join('')}</svg></div>`;
  }).join('');
  return `<div id="wall-finish-preview" class="wall-finish-preview" data-side="${side}">${cards}</div><p class="wall-elevation-meta">连续边界 · 已扣孔洞与埋藏部分 · 不计墙端、顶底及洞口内壁</p>`;
}
