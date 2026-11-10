// @ts-nocheck
// Legacy storage adapters retain their existing tested JavaScript behavior.
import { validateRegion } from './geometry.js';
import { calculateProject } from './pricing.js';
import { normalizeWalls } from './wall-plan.js';
import { validateOpenings } from './wall-solid.js';
import { validateWallShapes } from './wall-shapes.js';
import { validateProjectBoundary } from './plan-boundary.js';
import { validateLevels, levelProjects } from './levels.js';
import { validateServiceRoutes } from './services.js';
import { validateCivilElements } from './civil.js';
import { validateCivilProject, calculateCivilProject } from './civil-pricing.js';
import { validateMunicipalProject, calculateMunicipalProject } from './municipal-pricing.js';
import { validateTerrain } from './terrain.js';
import { validateHydraulicNetwork } from './hydraulics.js';
import { validateProjectBudgetOptions, projectBudgetSnapshot } from './project-budget.js';
const DATABASE_NAME = 'plan-material-studio-v1';
const clone = (value) => structuredClone(value);
function safeStructure(value) {
    if (!value || typeof value !== 'object' || value instanceof Blob)
        return;
    for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw new RangeError('工程文件包含不安全字段');
        safeStructure(child);
    }
}
function validPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}
export function validateProject(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project) || project.version !== 1) {
        throw new RangeError('不是受支持的图纸工程文件（版本 1）');
    }
    safeStructure(project);
    validateProjectBudgetOptions(project.budget);
    if (typeof project.id !== 'string' || !project.id.trim())
        throw new RangeError('工程编号不能为空');
    if (typeof project.name !== 'string' || !project.name.trim())
        throw new RangeError('工程名称不能为空');
    if (!Array.isArray(project.regions))
        throw new RangeError('区域数据格式不正确');
    // Effective floor fragments are derived from real rooms and apertures.
    // Imported JSON cannot supply fabricated measured fragments or prices.
    const storedContents = [project, ...(Array.isArray(project.levels) ? project.levels.map(level => level?.content).filter(Boolean) : [])];
    for (const content of storedContents) {
        if(content!==project&&['municipalElements','municipalTerrain','municipalHydraulics','municipalEarthworkTransfer'].some(field=>content[field]!==undefined))throw new RangeError('市政设施、地形与管网应保存在场地项目中，不能复制到设计楼层。');
        validateServiceRoutes(content.serviceRoutes);
        validateCivilElements(content.civilElements, content);
        for (const field of ['regions', 'wallRegionCache']) {
            if (!Array.isArray(content[field])) continue;
            for (const region of content[field]) if (region?.surfaceParts !== undefined)
                throw new RangeError('工程文件不能包含派生楼板轮廓，请保存原始房间和楼板洞。');
        }
    }
    if (project.workspaceMode !== undefined && !['plan', 'decoration', 'civil', 'municipal'].includes(project.workspaceMode))
        throw new RangeError('工作阶段应为绘图、装修、土建或市政。');
    if (project.wallJoinStyle !== undefined && !['square', 'clean'].includes(project.wallJoinStyle))
        throw new RangeError('墙体连接方式无效。');
    validateLevels(project);
    validateWallShapes(project);
    const boundary = validateProjectBoundary(project);
    if (!boundary.valid) throw new RangeError(boundary.error);
    if (project.walls !== undefined)
        normalizeWalls(project.walls);
    if (project.wallHeight !== undefined && (!Number.isFinite(project.wallHeight) || project.wallHeight < 50 || project.wallHeight > 1000))
        throw new RangeError('默认墙高应为 0.5–10 m。');
    if (project.wallThickness !== undefined && (!Number.isFinite(project.wallThickness) || project.wallThickness < 1 || project.wallThickness > 100))
        throw new RangeError('默认墙厚应为 1–100 cm。');
    validateOpenings(project);
    const scale = project.calibration?.metersPerPixel;
    if (scale !== null && scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
        throw new RangeError('校准比例必须是大于零的有限数字');
    }
    const regionIds = new Set();
    for (const region of project.regions) {
        if (!region || typeof region.id !== 'string' || !region.id || regionIds.has(region.id))
            throw new RangeError('区域编号不能为空或重复');
        regionIds.add(region.id);
        if (!Array.isArray(region.points) || !region.points.every(validPoint))
            throw new RangeError('区域坐标格式不正确');
        if (!Array.isArray(region.holes ?? []) || !(region.holes ?? []).every((hole) => Array.isArray(hole) && hole.every(validPoint))) {
            throw new RangeError('扣除区域坐标格式不正确');
        }
        if (!Array.isArray(region.items ?? []))
            throw new RangeError('区域材料数据格式不正确');
    }
    const drawnRegions = project.regions.filter((region) => region.points.length > 0);
    for (const region of drawnRegions) {
        const result = validateRegion(region, drawnRegions);
        if (!result.valid)
            throw new RangeError(result.error || '区域几何格式不正确');
    }
    if (project.drawing !== null && project.drawing !== undefined) {
        if (typeof project.drawing !== 'object' || !project.drawing.id)
            throw new RangeError('原图数据格式不正确');
        if (!Number.isFinite(project.drawing.width) || !Number.isFinite(project.drawing.height)
            || project.drawing.width <= 0 || project.drawing.height <= 0)
            throw new RangeError('原图尺寸必须大于零');
        if (/^\s*(?:javascript|vbscript):/i.test(project.drawing.url ?? ''))
            throw new RangeError('原图地址不安全');
    }
    // Pending input is valid unfinished work; invalid financial data is rejected
    // before importing/replacing the current project or reporting a save success.
    calculateProject(project);
    validateCivilProject(project);
    validateMunicipalProject(project);
    validateTerrain(project.municipalTerrain);
    validateHydraulicNetwork(project.municipalHydraulics);
    return project;
}
function persistedProject(project) {
    const copied = clone(validateProject(project));
    if (copied.drawing) {
        delete copied.drawing.blob;
        if (String(copied.drawing.url ?? '').startsWith('blob:') && copied.drawing.sourceUrl) {
            copied.drawing.url = copied.drawing.sourceUrl;
        }
    }
    return copied;
}
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'));
    });
}
class IndexedDBBackend {
    constructor(indexedDB, name) { this.indexedDB = indexedDB; this.name = name; this.opening = null; }
    open() {
        if (!this.indexedDB)
            return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法保存工程'));
        if (!this.opening) {
            this.opening = new Promise((resolve, reject) => {
                const request = this.indexedDB.open(this.name, 1);
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains('projects')) {
                        request.result.createObjectStore('projects', { keyPath: 'id' });
                    }
                };
                request.onerror = () => { this.opening = null; reject(request.error ?? new Error('无法打开本地工程数据库')); };
                request.onblocked = () => { this.opening = null; reject(new Error('其他窗口正在使用工程数据库，请关闭后重试')); };
                request.onsuccess = () => {
                    const database = request.result;
                    database.onversionchange = () => { database.close(); this.opening = null; };
                    resolve(database);
                };
            });
        }
        return this.opening;
    }
    async operation(mode, action) {
        const database = await this.open();
        const transaction = database.transaction('projects', mode);
        const done = new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error ?? new Error('本地数据库保存已取消'));
            transaction.onerror = () => reject(transaction.error ?? new Error('本地数据库保存失败'));
        });
        const request = action(transaction.objectStore('projects'));
        const [result] = await Promise.all([requestResult(request), done]);
        return result;
    }
    read(id) { return this.operation('readonly', (store) => store.get(id)); }
    list() { return this.operation('readonly', (store) => store.getAll()); }
    write(record) { return this.operation('readwrite', (store) => store.put(record)); }
    remove(id) { return this.operation('readwrite', (store) => store.delete(id)); }
}
function drawingBlobFrom(project, supplied) {
    const blob = supplied ?? project.drawing?.blob ?? null;
    if (blob !== null && !(blob instanceof Blob))
        throw new TypeError('原图缓存必须是 Blob 或 File');
    return blob;
}
function metadata(record) {
    return { id: record.id, name: record.project.name, createdAt: record.createdAt,
        updatedAt: record.updatedAt, drawingName: record.project.drawing?.name ?? '',
        regionCount: record.project.levels ? levelProjects(record.project).reduce((sum, layer) => sum + layer.project.regions.length, 0) : record.project.regions.length, hasDrawingBlob: Boolean(record.drawingBlob) };
}
export function createProjectStore({ indexedDB = globalThis.indexedDB, databaseName = DATABASE_NAME, backend } = {}) {
    const storage = backend ?? new IndexedDBBackend(indexedDB, databaseName);
    let writes = Promise.resolve();
    const enqueue = (operation) => {
        const result = writes.then(operation);
        writes = result.catch(() => undefined);
        return result;
    };
    return {
        saveProject(project, { drawingBlob } = {}) {
            const copied = persistedProject(project);
            const suppliedBlob = drawingBlobFrom(project, drawingBlob);
            return enqueue(async () => {
                const previous = await storage.read(copied.id);
                const sameDrawing = copied.drawing && previous?.project.drawing?.id === copied.drawing.id;
                const blob = copied.drawing ? suppliedBlob ?? (sameDrawing ? previous.drawingBlob : null) : null;
                const now = new Date().toISOString();
                const record = { id: copied.id, project: copied, drawingBlob: blob ?? null,
                    createdAt: previous?.createdAt ?? now, updatedAt: now };
                await storage.write(record);
                return metadata(record);
            });
        },
        async loadProject(id, { hydrateDrawing = true } = {}) {
            await writes;
            const record = await storage.read(id);
            if (!record)
                return null;
            const project = clone(record.project);
            if (project.drawing && record.drawingBlob) {
                project.drawing.blob = record.drawingBlob;
                if (hydrateDrawing && typeof globalThis.URL?.createObjectURL === 'function') {
                    project.drawing.sourceUrl = project.drawing.sourceUrl ?? project.drawing.url;
                    project.drawing.url = URL.createObjectURL(record.drawingBlob);
                }
            }
            return project;
        },
        async listProjects() {
            await writes;
            return (await storage.list()).map(metadata).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
        deleteProject(id) {
            return enqueue(async () => {
                const previous = await storage.read(id);
                if (!previous)
                    return false;
                await storage.remove(id);
                return true;
            });
        },
    };
}
export function createMemoryProjectStore() {
    const records = new Map();
    return createProjectStore({ backend: {
            async read(id) { return records.has(id) ? clone(records.get(id)) : undefined; },
            async list() { return [...records.values()].map(clone); },
            async write(record) { records.set(record.id, clone(record)); },
            async remove(id) { records.delete(id); },
        } });
}
let defaultStore;
const store = () => defaultStore ??= createProjectStore();
export const saveProject = (project, options) => store().saveProject(project, options);
export const loadProject = (id, options = {}) => store().loadProject(id, options);
export const listProjects = () => store().listProjects();
export const deleteProject = (id) => store().deleteProject(id);
export function revokeProjectDrawing(project) {
    const url = project?.drawing?.url;
    if (typeof url === 'string' && url.startsWith('blob:') && typeof globalThis.URL?.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
    }
}
const allowedMime = (type) => /^(?:image\/(?:png|jpeg|webp|gif|svg\+xml)|application\/pdf)$/i.test(type);
export async function blobToDataURL(blob, fallbackType = 'image/png') {
    if (!(blob instanceof Blob))
        throw new TypeError('原图缓存不是 Blob');
    const type = blob.type || fallbackType;
    if (!allowedMime(type))
        throw new RangeError('工程原图应是 PNG、JPEG、WebP、GIF、SVG 或 PDF');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 16384) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
    }
    return `data:${type};base64,${btoa(chunks.join(''))}`;
}
export function dataURLToBlob(url) {
    const match = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url);
    if (!match || !allowedMime(match[1]))
        throw new RangeError('工程原图 data URL 格式不正确');
    let bytes;
    try {
        if (match[2]) {
            const decoded = atob(match[3]);
            bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        }
        else {
            bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
        }
    }
    catch {
        throw new RangeError('工程原图数据已损坏');
    }
    return new Blob([bytes], { type: match[1] });
}
export async function exportProjectJSON(project, { drawingBlob, materials = [] } = {}) {
    const copied = persistedProject(project);
    copied.budgetSummary = projectBudgetSnapshot(project);
    copied.quoteSummary = project.workspaceMode === 'municipal'
        ? calculateMunicipalProject(project)
        : project.workspaceMode === 'civil'
            ? calculateCivilProject(project)
            : calculateProject(project);
    if (copied.drawing) {
        const blob = drawingBlobFrom(project, drawingBlob);
        if (blob) {
            copied.drawing.url = await blobToDataURL(blob, copied.drawing.type === 'pdf' ? 'application/pdf' : 'image/png');
        }
        else if (!String(copied.drawing.url ?? '').startsWith('data:')) {
            throw new Error('原图尚未缓存，无法完整导出工程；请重新上传原图后再导出');
        }
        else {
            dataURLToBlob(copied.drawing.url);
        }
        // The schema's URL is already self-contained. Avoid doubling large image
        // payloads; older exports with a separate dataUrl are still importable.
        delete copied.drawing.dataUrl;
        delete copied.drawing.sourceUrl;
    }
    const materialMap = new Map(materials.map((material) => [String(material.id), material]));
    const existingSnapshots = new Map((copied.materialsSnapshot ?? []).map((material) => [String(material.id), material]));
    const referenced = new Map();
    const contents = [copied, ...(copied.levels ?? []).filter(level => level.content).map(level => level.content)];
    const owners = contents.flatMap(content => [...(content.regions ?? []), ...(content.walls ?? []), ...(content.wallShapes ?? []), ...(content.regions ?? []).filter(region => region.ceiling).map(region => region.ceiling)]);
    for (const region of owners) {
        for (const item of region.items ?? []) {
            const material = materialMap.get(String(item.materialId)) ?? existingSnapshots.get(String(item.materialId));
            if (material) {
                referenced.set(String(material.id), clone(material));
                item.materialName ??= material.name;
                item.unit ??= material.unit;
                item.image ??= material.image;
                item.color ??= material.color;
            }
        }
    }
    copied.materialsSnapshot = [...referenced.values()];
    return JSON.stringify(copied, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value))
            throw new RangeError('工程含有无效数字，无法导出');
        return value;
    }, 2);
}
export async function importProjectJSON(text) {
    let project;
    try {
        project = JSON.parse(String(text));
    }
    catch {
        throw new RangeError('工程文件不是有效 JSON');
    }
    validateProject(project);
    if (project.drawing?.dataUrl)
        project.drawing.url = project.drawing.dataUrl;
    if (project.drawing && String(project.drawing.url ?? '').startsWith('data:')) {
        project.drawing.blob = dataURLToBlob(project.drawing.url);
    }
    return project;
}
export function createHistory(initial, { limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 2 || limit > 500)
        throw new RangeError('撤销历史容量应在 2 到 500 之间');
    let states = [clone(initial)];
    let index = 0;
    const current = () => clone(states[index]);
    return {
        current,
        canUndo: () => index > 0,
        canRedo: () => index < states.length - 1,
        push(next) {
            const snapshot = clone(next);
            if (JSON.stringify(snapshot) === JSON.stringify(states[index]))
                return current();
            states = states.slice(0, index + 1);
            states.push(snapshot);
            if (states.length > limit)
                states.shift();
            index = states.length - 1;
            return current();
        },
        undo() {
            if (index > 0)
                index -= 1;
            return current();
        },
        redo() {
            if (index < states.length - 1)
                index += 1;
            return current();
        },
        replace(next) { states[index] = clone(next); return current(); },
        reset(next) { states = [clone(next)]; index = 0; return current(); },
        get length() { return states.length; },
    };
}
