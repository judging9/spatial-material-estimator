import { furnitureScale } from './furniture.js';
const vectors = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
const finiteObject = (item) => [item.position?.x, item.position?.y, item.width, item.depth, item.rotation].every(Number.isFinite) && item.width > 0 && item.depth > 0;
const copy = (item) => ({ position: { ...item.position }, width: item.width, depth: item.depth });
const fromLocal = (item, point) => { const angle = item.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle); return { x: item.position.x + point.x * c - point.y * s, y: item.position.y + point.x * s + point.y * c }; };
/** Real drawing-coordinate handles, independent of viewport zoom or pan. */
export function furnitureResizeHandles(item, project) {
    const scale = furnitureScale(project);
    if (!scale || !finiteObject(item) || item.locked)
        return [];
    return Object.entries(vectors).map(([key, [x, y]]) => {
        const degrees = (Math.atan2(y, x) * 180 / Math.PI + item.rotation + 360) % 180;
        const sector = Math.round(degrees / 45) % 4;
        const cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][sector];
        return { key, point: fromLocal(item, { x: x * item.width / 200 / scale, y: y * item.depth / 200 / scale }), cursor };
    });
}
/** Pointer deltas are evaluated in the starting object's rotated coordinates.
 * The opposite edge / corner remains fixed. Crossing it stops at minimum size;
 * dimensions are actual centimetres, never canvas pixels. No object is mutated. */
export function furnitureResizeFromPointer(item, key, start, current, project, options = {}) {
    if (!finiteObject(item) || ![start.x, start.y, current.x, current.y].every(Number.isFinite) || !vectors[key])
        throw new RangeError('尺寸拖动坐标无效。');
    if (item.locked)
        return copy(item);
    const scale = furnitureScale(project);
    if (!scale)
        throw new RangeError('先校准图纸比例，再拖动实际尺寸。');
    const min = options.min ?? 1, max = options.max ?? 2000;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min)
        throw new RangeError('尺寸范围无效。');
    const [hx, hy] = vectors[key], angle = item.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const dx = current.x - start.x, dy = current.y - start.y;
    const localX = (dx * c + dy * s) * scale * 100, localY = (-dx * s + dy * c) * scale * 100;
    const rawWidth = item.width + (hx ? hx * localX : 0), rawDepth = item.depth + (hy ? hy * localY : 0);
    let width = Math.max(min, Math.min(max, rawWidth)), depth = Math.max(min, Math.min(max, rawDepth));
    if (options.circle || options.preserveRatio) {
        const ratio = options.circle ? 1 : item.width / item.depth;
        let targetWidth = hx && (!hy || Math.abs(rawWidth / item.width - 1) >= Math.abs(rawDepth / item.depth - 1)) ? rawWidth : rawDepth * ratio;
        targetWidth = Math.max(Math.max(min, min * ratio), Math.min(Math.min(max, max * ratio), targetWidth));
        width = targetWidth;
        depth = targetWidth / ratio;
    }
    width = Math.round(width * 100) / 100;
    depth = Math.round(depth * 100) / 100;
    // Independent centring on an untouched axis makes edge drags intuitive.
    const centre = fromLocal(item, { x: hx * (width - item.width) / 200 / scale, y: hy * (depth - item.depth) / 200 / scale });
    return { position: centre, width, depth };
}
//# sourceMappingURL=furniture-resize.js.map