import type { Furniture, Point, Project } from '../types.js';
import { furnitureScale } from './furniture.js';

export const normalizedRotation = (degrees: number): number => { const value=degrees%360;return value<0?value+360:value||0; };

/** Mouse direction, in source coordinates, independent of pan and zoom. */
export function rotationFromPointer(center: Point, start: Point, current: Point, initial: number, snap = false): number {
  if (![center.x,center.y,start.x,start.y,current.x,current.y,initial].every(Number.isFinite)) throw new RangeError('旋转坐标无效。');
  if (Math.hypot(current.x-center.x,current.y-center.y) < 1e-8) return normalizedRotation(initial);
  const difference = Math.atan2(current.y-center.y,current.x-center.x)-Math.atan2(start.y-center.y,start.x-center.x);
  const degrees = normalizedRotation(initial+difference*180/Math.PI);
  return normalizedRotation(snap ? Math.round(degrees/15)*15 : Math.round(degrees*100)/100);
}

/** Handle stays 28 screen pixels beyond the object's local back edge. */
export function rotationHandle(item: Pick<Furniture,'position'|'rotation'|'depth'>, project: Pick<Project,'drawing'|'calibration'>, zoom: number): Point {
  const scale = furnitureScale(project), angle = item.rotation*Math.PI/180;
  const radius = (scale ? item.depth/200/scale : 12/zoom) + 28/zoom;
  return {x:item.position.x+Math.sin(angle)*radius,y:item.position.y-Math.cos(angle)*radius};
}
