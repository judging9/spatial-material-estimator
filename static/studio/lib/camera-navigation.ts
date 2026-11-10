import type { Vec3 } from './camera3d.js';

export type CameraNavigationCode = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD' | 'Space' | 'ControlLeft' | 'ControlRight';
export type CameraNavigationAxes = { forward: number; right: number; up: number };
export const CAMERA_NAVIGATION_CODES: readonly CameraNavigationCode[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight'];
export const MAX_NAVIGATION_FRAME_SECONDS = .1;

/** Physical key codes continue to work with a non-Latin keyboard layout. */
export function cameraNavigationCode(event: Pick<KeyboardEvent, 'code' | 'key'>): CameraNavigationCode | null {
  if (CAMERA_NAVIGATION_CODES.includes(event.code as CameraNavigationCode)) return event.code as CameraNavigationCode;
  return ({ w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', ' ': 'Space', Control: 'ControlLeft' } as Record<string, CameraNavigationCode>)[event.key.length === 1 ? event.key.toLowerCase() : event.key] ?? null;
}

/** Opposing keys cancel; diagonals retain the same physical movement speed. */
export function cameraNavigationAxes(codes: Iterable<string>): CameraNavigationAxes {
  const pressed = new Set(codes);
  const axes = { forward: Number(pressed.has('KeyW')) - Number(pressed.has('KeyS')),
    right: Number(pressed.has('KeyD')) - Number(pressed.has('KeyA')),
    up: Number(pressed.has('Space')) - Number(pressed.has('ControlLeft') || pressed.has('ControlRight')) };
  const length = Math.hypot(axes.forward, axes.right, axes.up);
  if (length) for (const axis of ['forward', 'right', 'up'] as const) axes[axis] /= length;
  return axes;
}

/** Metres per second. The automatic speed follows actual scene dimensions. */
export function automaticNavigationSpeed(size: Vec3, viewDistance?: number): number {
  if (!size || ![size.x, size.y, size.z].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('三维场景尺寸应为有效的非负数。');
  if(viewDistance!==undefined&&(!Number.isFinite(viewDistance)||viewDistance<=0))throw new RangeError('三维视角距离应为有效的正数。');
  return Math.max(.5, Math.min(200, Math.hypot(size.x, size.y, size.z) / 8, viewDistance===undefined?Infinity:viewDistance/8));
}

/** Translate both eye and orbit target along the camera's horizontal heading.
 * Pitch never makes W drift vertically. A stalled/background frame cannot jump
 * across a site when animation resumes. The function does not mutate inputs. */
export function cameraNavigationTranslation(yaw: number, codes: Iterable<string>, speed: number, elapsedSeconds: number): Vec3 {
  if (!Number.isFinite(yaw) || !Number.isFinite(speed) || speed <= 0 || speed > 1000 || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new RangeError('三维移动角度、速度或时间无效。');
  const axes = cameraNavigationAxes(codes), travel = speed * Math.min(MAX_NAVIGATION_FRAME_SECONDS, elapsedSeconds);
  if(!travel||!Math.hypot(axes.forward,axes.right,axes.up))return{x:0,y:0,z:0};
  const x=(-Math.sin(yaw)*axes.forward+Math.cos(yaw)*axes.right)*travel,z=(-Math.cos(yaw)*axes.forward-Math.sin(yaw)*axes.right)*travel;
  return{x:x===0?0:x,y:axes.up*travel,z:z===0?0:z};
}
