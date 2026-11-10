import { compileTerrain } from './lib/terrain.js';
import { applyTerrainBrush, carveTerrainRiver, createTerrainGrid, sculptTerrainFeature, terrainSectionProfile } from './lib/terrain-authoring.js';
import { icon, measure } from './ui.js';
const labels = { view: '查看', raise: '凸起', lower: '凹陷', flatten: '平整', smooth: '平滑', river: '河槽', peak: '山峰', hollow: '低谷', ridge: '山脊', canyon: '峡谷' };
const featureTools = ['peak', 'hollow', 'ridge', 'canyon'];
const lineFeature = (tool) => tool === 'ridge' || tool === 'canyon';
export function terrainAuthoringHTML(project) {
    const scale = project.drawing?.type === 'plan' ? .01 : project.calibration?.metersPerPixel;
    const width = Math.max(10, Math.min(5000, Math.round((project.drawing?.width ?? 10000) * (scale ?? .01))));
    const length = Math.max(10, Math.min(5000, Math.round((project.drawing?.height ?? 10000) * (scale ?? .01))));
    const spacing = Math.max(1, Math.ceil(Math.max(width, length) / 60));
    const field = (id, title, value, min) => `<label><span class="field-label">${title}</span><input id="${id}" type="number" step="any" ${min === undefined ? '' : `min="${min}"`} value="${value}"></label>`;
    return `<section class="terrain-authoring"><div class="section-head"><div><h3>设计高山与低谷</h3><p class="help">选一种地貌，填写山高或谷深。也可以在已有地形上放山峰、拖出山脊。</p></div><span class="terrain-concept-tag">方案地形</span></div>
  <details class="terrain-generation" ${project.municipalTerrain ? '' : 'open'}><summary>新建地形与地貌</summary><div class="terrain-landscape-choices" aria-label="选择高山低谷预设">${[['mountain', '高山', '单峰与山坡'], ['ridge', '山脉', '连绵山脊'], ['canyon', '峡谷', '连续谷地']].map(([id, name, note]) => `<button type="button" data-terrain-landscape="${id}" aria-pressed="false"><strong>${name}</strong><span>${note}</span></button>`).join('')}</div><div class="terrain-generation-grid">
    ${field('terrain-create-width', '场地宽 · m', width, .001)}${field('terrain-create-length', '场地长 · m', length, .001)}${field('terrain-create-spacing', '网格间距 · m', spacing, .001)}${field('terrain-create-elevation', '基准高程 · m', 0)}${field('terrain-create-relief', '起伏高度 / 谷深 · m', 5, 0)}
    <label><span class="field-label">地形预设</span><select id="terrain-create-preset"><option value="flat">平地</option><option value="hill">丘陵</option><option value="basin">盆地</option><option value="valley">河谷</option><option value="mountain">高山</option><option value="ridge">山脉</option><option value="canyon">峡谷</option></select></label>${field('terrain-create-rotation', '山脉 / 峡谷走向 · °', 0)}
  </div><div class="terrain-generation-footer"><p class="help">按完整网格向上取整。自建地形保留用户设定高程，用于方案设计。</p><button type="button" id="terrain-create" class="button subtle">${icon('plus', 14)}生成地形</button></div></details>
  <div class="terrain-sculpt-toolbar" role="toolbar" aria-label="地形塑形工具">${Object.keys(labels).map(tool => `<button type="button" data-terrain-tool="${tool}" class="${tool === 'view' ? 'active' : ''}" aria-pressed="${tool === 'view'}">${labels[tool]}</button>`).join('')}<button type="button" id="terrain-sculpt-undo" title="撤销本窗口上一步塑形" disabled>${icon('undo', 14)}撤销</button></div>
  <div class="terrain-brush-fields" id="terrain-brush-fields" hidden>${field('terrain-brush-radius', '笔刷半径 · m', Math.max(3, spacing * 3), .001)}${field('terrain-brush-strength', '每次最大变化 · m', 1, 0)}<span id="terrain-flatten-field" hidden>${field('terrain-flatten-elevation', '目标高程 · m', 0)}</span></div>
  <div class="terrain-feature-fields" id="terrain-feature-fields" hidden>${field('terrain-feature-radius', '影响半径 · m', Math.max(10, Math.min(width, length) / 6), .001)}${field('terrain-feature-relief', '山高 / 谷深 · m', 100, .001)}<p class="help">以原有高程为基准，一次增加山高或降低谷深。山峰、低谷点击放置；山脊、峡谷拖动后松开完成。</p></div>
  <div class="terrain-brush-fields" id="terrain-river-fields" hidden>${field('terrain-river-width', '河底宽 · m', 6, .001)}${field('terrain-river-depth', '河槽深 · m', 2, .001)}${field('terrain-river-slope', '岸坡水平系数 · 1:n', 1.5, 0)}<div class="terrain-river-actions"><button type="button" id="terrain-river-finish" class="button subtle">完成河槽</button><button type="button" id="terrain-river-cancel" class="button subtle">取消路径</button></div></div>
  <div class="terrain-sculpt-preview"><canvas id="terrain-sculpt-canvas" width="680" height="360" tabindex="0" aria-label="地形高程编辑画布"></canvas><span id="terrain-sculpt-empty">生成或导入地形后，在这里塑造高程</span></div>
  <div class="terrain-sculpt-footer"><p id="terrain-sculpt-guide" class="help" role="status">选择山峰、低谷或笔刷，在预览中点击或拖动。</p><span id="terrain-sculpt-range" class="help"></span></div>
  <section class="terrain-height-profile"><div class="section-head"><h4>高程剖面</h4><select id="terrain-section-axis" aria-label="地形剖面方向"><option value="x">左右方向</option><option value="y">上下方向</option></select></div><canvas id="terrain-section-canvas" width="680" height="128" aria-label="按真实高程生成的地形剖面"></canvas><p id="terrain-section-note" class="help">将鼠标移到地形上查看该位置的剖面。</p></section>
  <p class="help terrain-concept-note">自建或人工塑形的地形属于设计方案，不替代实测地形。山高、谷深与高程均为米；缺失高程不填补，河槽仅修改河床几何。</p></section>`;
}
export function bindTerrainAuthoring(dialog, getModel, setModel, reportError) {
    const canvas = dialog.querySelector('#terrain-sculpt-canvas'), ctx = canvas.getContext('2d');
    const guide = dialog.querySelector('#terrain-sculpt-guide'), undo = dialog.querySelector('#terrain-sculpt-undo');
    let tool = 'view', path = [], cursor = null, history = [], stroke = null, lastPoint = null;
    let strokePointer = null, featurePath = [], strokeError = null;
    let viewport = null;
    const number = (id) => { const input = dialog.querySelector('#' + id); return input.value.trim() ? Number(input.value) : NaN; };
    const remember = (model) => { history.push(structuredClone(model)); if (history.length > 20)
        history.shift(); undo.disabled = false; };
    const clearSection = (message = '生成或导入地形后查看真实高程剖面。') => {
        const profileCanvas = dialog.querySelector('#terrain-section-canvas');
        profileCanvas.getContext('2d').clearRect(0, 0, profileCanvas.width, profileCanvas.height);
        profileCanvas.setAttribute('aria-label', '按真实高程生成的地形剖面');
        dialog.querySelector('#terrain-section-note').textContent = message;
    };
    const emptyPreview = () => {
        viewport = null;
        dialog.querySelector('#terrain-sculpt-empty').hidden = false;
        dialog.querySelector('#terrain-sculpt-range').textContent = '';
        clearSection();
    };
    const renderSection = (model, minX, minY, width, height) => {
        const profileCanvas = dialog.querySelector('#terrain-section-canvas'), pc = profileCanvas.getContext('2d');
        clearSection();
        const r = model.raster, inset = r ? r.cellSize / 2 : 0, axis = dialog.querySelector('#terrain-section-axis').value;
        const atX = Math.max(minX + inset, Math.min(minX + width - inset, cursor?.x ?? minX + width / 2));
        const atY = Math.max(minY + inset, Math.min(minY + height - inset, cursor?.y ?? minY + height / 2));
        const from = axis === 'x' ? { x: minX + inset, y: atY } : { x: atX, y: minY + inset };
        const to = axis === 'x' ? { x: minX + width - inset, y: atY } : { x: atX, y: minY + height - inset };
        if (Math.hypot(to.x - from.x, to.y - from.y) <= 1e-9) {
            clearSection('当前方向的有效跨度不足；请补充高程点或切换剖面方向。');
            return;
        }
        const section = terrainSectionProfile(model, from, to), heights = section.flatMap(sample => sample.elevation === null ? [] : [sample.elevation]);
        if (!heights.length) {
            dialog.querySelector('#terrain-section-note').textContent = '当前剖面没有有效高程；缺失范围保持空白。';
            return;
        }
        const low = Math.min(...heights), high = Math.max(...heights), spread = Math.max(2, high - low), lower = low - spread * .1, upper = high + spread * .1;
        const left = 54, right = 12, top = 16, bottom = 23, w = profileCanvas.width - left - right, h = profileCanvas.height - top - bottom;
        const length = section.at(-1).distance, sx = (distance) => left + distance / length * w, sy = (z) => top + (upper - z) / (upper - lower) * h;
        pc.font = '10px "Microsoft YaHei",sans-serif';
        pc.fillStyle = '#7b8c79';
        pc.strokeStyle = '#e3e9de';
        pc.lineWidth = 1;
        for (const z of new Set([low, (low + high) / 2, high])) {
            pc.beginPath();
            pc.moveTo(left, sy(z));
            pc.lineTo(left + w, sy(z));
            pc.stroke();
            pc.fillText(measure(z, 1), 4, sy(z) + 3);
        }
        pc.fillText('0 m', left, profileCanvas.height - 4);
        pc.textAlign = 'right';
        pc.fillText(measure(length, 1) + ' m', left + w, profileCanvas.height - 4);
        pc.textAlign = 'left';
        let run = [];
        const drawRun = () => {
            if (!run.length)
                return;
            pc.beginPath();
            pc.moveTo(run[0].x, top + h);
            run.forEach(p => pc.lineTo(p.x, p.y));
            pc.lineTo(run.at(-1).x, top + h);
            pc.closePath();
            pc.fillStyle = '#b7cab526';
            pc.fill();
            pc.beginPath();
            run.forEach((p, index) => index ? pc.lineTo(p.x, p.y) : pc.moveTo(p.x, p.y));
            pc.strokeStyle = '#477b61';
            pc.lineWidth = 1.8;
            pc.stroke();
            run = [];
        };
        for (const sample of section) {
            if (sample.elevation === null)
                drawRun();
            else
                run.push({ x: sx(sample.distance), y: sy(sample.elevation) });
        }
        drawRun();
        profileCanvas.setAttribute('aria-label', `真实高程剖面，最低 ${measure(low, 2)} m，最高 ${measure(high, 2)} m，全长 ${measure(length, 2)} m`);
        dialog.querySelector('#terrain-section-note').textContent = `${axis === 'x' ? '左右剖面 · Y' : '上下剖面 · X'} = ${measure(axis === 'x' ? atY : atX, 1)} m · 纵轴随真实高程范围缩放；缺失高程处断开。`;
    };
    const render = () => {
        const model = getModel(), raster = model.raster;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f6f8f3';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        let minX, minY, width, height, min, max;
        try {
            const values = raster ? raster.values.filter((z) => z !== null) : model.points.map(p => p.z);
            if (!values.length || values.some(z => !Number.isFinite(z))) {
                emptyPreview();
                return;
            }
            min = Math.min(...values);
            max = Math.max(...values);
            if (raster) {
                minX = raster.originX;
                minY = raster.originY;
                width = raster.ncols * raster.cellSize;
                height = raster.nrows * raster.cellSize;
            }
            else {
                const mesh = compileTerrain(model);
                if (!mesh.bounds) {
                    emptyPreview();
                    return;
                }
                minX = mesh.bounds.minX;
                minY = mesh.bounds.minY;
                width = mesh.bounds.maxX - minX;
                height = mesh.bounds.maxY - minY;
            }
            const scale = Math.min((canvas.width - 64) / Math.max(.001, width), (canvas.height - 48) / Math.max(.001, height)), x = (canvas.width - width * scale) / 2, y = (canvas.height - height * scale) / 2;
            viewport = { x, y, scale, minX, minY, w: width * scale, h: height * scale };
            const color = (z) => { const t = max === min ? .5 : (z - min) / (max - min); return `rgb(${Math.round(228 - t * 92)},${Math.round(236 - t * 71)},${Math.round(219 - t * 89)})`; };
            if (raster) {
                const tile = document.createElement('canvas');
                tile.width = raster.ncols;
                tile.height = raster.nrows;
                const tc = tile.getContext('2d'), pixels = tc.createImageData(raster.ncols, raster.nrows);
                for (let i = 0; i < raster.values.length; i++) {
                    const z = raster.values[i], t = z === null ? .5 : max === min ? .5 : (z - min) / (max - min), missing = z === null;
                    pixels.data.set(missing ? [248, 247, 243, 255] : [Math.round(228 - t * 92), Math.round(236 - t * 71), Math.round(219 - t * 89), 255], i * 4);
                }
                tc.putImageData(pixels, 0, 0);
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(tile, x, y, width * scale, height * scale);
            }
            else {
                for (const triangle of compileTerrain(model).triangles) {
                    ctx.beginPath();
                    triangle.forEach((p, i) => { const px = x + (p.x - minX) * scale, py = y + (p.y - minY) * scale; if (i === 0)
                        ctx.moveTo(px, py);
                    else
                        ctx.lineTo(px, py); });
                    ctx.closePath();
                    ctx.fillStyle = color(triangle.reduce((sum, p) => sum + p.z, 0) / 3);
                    ctx.fill();
                    ctx.strokeStyle = '#d3ddcd';
                    ctx.lineWidth = .5;
                    ctx.stroke();
                }
            }
            ctx.strokeStyle = '#aabbaa';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, width * scale, height * scale);
            if (cursor && (['raise', 'lower', 'flatten', 'smooth'].includes(tool) || featureTools.includes(tool))) {
                const radius = number(featureTools.includes(tool) ? 'terrain-feature-radius' : 'terrain-brush-radius');
                if (Number.isFinite(radius) && radius > 0) {
                    ctx.beginPath();
                    ctx.arc(x + (cursor.x - minX) * scale, y + (cursor.y - minY) * scale, Math.min(2000, radius * scale), 0, Math.PI * 2);
                    ctx.strokeStyle = '#28674e';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    ctx.fillStyle = '#28674e16';
                    ctx.fill();
                }
            }
            const drawnPath = tool === 'river' ? path : featurePath;
            if (drawnPath.length) {
                ctx.beginPath();
                drawnPath.forEach((p, i) => { const px = x + (p.x - minX) * scale, py = y + (p.y - minY) * scale; if (!i)
                    ctx.moveTo(px, py);
                else
                    ctx.lineTo(px, py); });
                ctx.strokeStyle = '#467f99';
                ctx.lineWidth = 3;
                ctx.stroke();
                for (const p of drawnPath) {
                    ctx.beginPath();
                    ctx.arc(x + (p.x - minX) * scale, y + (p.y - minY) * scale, 3, 0, Math.PI * 2);
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    ctx.strokeStyle = '#467f99';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }
            dialog.querySelector('#terrain-sculpt-empty').hidden = true;
            dialog.querySelector('#terrain-sculpt-range').textContent = `${measure(min, 2)}–${measure(max, 2)} m`;
            renderSection(model, minX, minY, width, height);
        }
        catch (error) {
            emptyPreview();
            reportError(error);
        }
    };
    const coordinate = (event) => {
        if (!viewport)
            return null;
        const rect = canvas.getBoundingClientRect(), px = (event.clientX - rect.left) * canvas.width / rect.width, py = (event.clientY - rect.top) * canvas.height / rect.height;
        if (px < viewport.x || py < viewport.y || px > viewport.x + viewport.w || py > viewport.y + viewport.h)
            return null;
        return { x: viewport.minX + (px - viewport.x) / viewport.scale, y: viewport.minY + (py - viewport.y) / viewport.scale };
    };
    const stamp = (point) => {
        const model = applyTerrainBrush(getModel(), point, { mode: tool, radius: number('terrain-brush-radius'), strength: number('terrain-brush-strength'), targetElevation: number('terrain-flatten-elevation') });
        setModel(model, false);
    };
    const releaseStroke = () => {
        const pointer = strokePointer;
        strokePointer = null;
        stroke = null;
        lastPoint = null;
        featurePath = [];
        if (pointer !== null && canvas.hasPointerCapture(pointer))
            canvas.releasePointerCapture(pointer);
    };
    const cancelStroke = () => {
        const before = stroke;
        releaseStroke();
        strokeError = null;
        if (before)
            setModel(before, true);
        render();
    };
    const featurePreview = (point, append = false) => {
        if (!stroke)
            return;
        let previewPath;
        if (lineFeature(tool)) {
            if (append && Math.hypot(point.x - featurePath.at(-1).x, point.y - featurePath.at(-1).y) > .001) {
                if (featurePath.length >= 200)
                    throw new RangeError('一段山脊或峡谷最多 200 个点，请分段塑形。');
                featurePath.push(point);
            }
            previewPath = [...featurePath];
            if (Math.hypot(point.x - previewPath.at(-1).x, point.y - previewPath.at(-1).y) > .001)
                previewPath.push(point);
            if (previewPath.length < 2)
                return;
        }
        else
            previewPath = featurePath = [point];
        const next = sculptTerrainFeature(stroke, previewPath, { mode: tool, radius: number('terrain-feature-radius'), relief: number('terrain-feature-relief') });
        setModel(next, false);
        strokeError = null;
    };
    const finishStroke = () => {
        if (stroke) {
            const before = stroke, failure = strokeError, valid = !failure && (!lineFeature(tool) || featurePath.length > 1);
            releaseStroke();
            strokeError = null;
            if (valid) {
                remember(before);
                setModel(getModel(), true);
                if (featureTools.includes(tool))
                    guide.textContent = `${labels[tool]}已按真实高程生成，可继续放置或撤销。`;
            }
            else {
                setModel(before, true);
                if (failure)
                    reportError(failure);
                else
                    guide.textContent = '拖动一段路径后松开，即可生成山脊或峡谷。';
            }
        }
        render();
    };
    const finishRiver = () => {
        try {
            const before = getModel(), next = carveTerrainRiver(before, path, { width: number('terrain-river-width'), depth: number('terrain-river-depth'), bankSlope: number('terrain-river-slope') });
            remember(before);
            path = [];
            setModel(next, true);
            guide.textContent = '河槽已刻入真实高程，可继续画下一段或撤销。';
            render();
        }
        catch (error) {
            reportError(error);
        }
    };
    dialog.querySelector('#terrain-create').addEventListener('click', () => {
        try {
            const before = getModel(), model = createTerrainGrid({ width: number('terrain-create-width'), length: number('terrain-create-length'), cellSize: number('terrain-create-spacing'), baseElevation: number('terrain-create-elevation'), relief: number('terrain-create-relief'), rotation: number('terrain-create-rotation'), preset: dialog.querySelector('#terrain-create-preset').value });
            remember(before);
            path = [];
            setModel(model, true);
            dialog.querySelector('#terrain-name').value = model.name;
            guide.textContent = `已生成 ${model.raster.ncols} × ${model.raster.nrows} 个高程点，内插跨度 ${measure((model.raster.ncols - 1) * model.raster.cellSize, 2)} × ${measure((model.raster.nrows - 1) * model.raster.cellSize, 2)} m。选择笔刷开始塑形。`;
            render();
        }
        catch (error) {
            reportError(error);
        }
    });
    dialog.querySelectorAll('[data-terrain-tool]').forEach(button => button.addEventListener('click', () => {
        finishStroke();
        tool = button.dataset.terrainTool;
        path = [];
        dialog.querySelectorAll('[data-terrain-tool]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
        dialog.querySelector('#terrain-brush-fields').hidden = tool === 'view' || tool === 'river' || featureTools.includes(tool);
        dialog.querySelector('#terrain-feature-fields').hidden = !featureTools.includes(tool);
        dialog.querySelector('#terrain-flatten-field').hidden = tool !== 'flatten';
        dialog.querySelector('#terrain-river-fields').hidden = tool !== 'river';
        canvas.style.cursor = tool === 'view' ? 'default' : 'crosshair';
        guide.textContent = tool === 'river' ? '沿河槽逐点点击，点击「完成河槽」或按 Enter；Esc 取消路径。' : featureTools.includes(tool) ? lineFeature(tool) ? `${labels[tool]}：在地形上按住拖动，松开一次成形；Esc 取消。` : `${labels[tool]}：点击选择中心，按输入山高 / 谷深一次成形；Esc 取消。` : tool === 'view' ? '查看当前高程和剖面。选择工具后可点击或拖动。' : `${labels[tool]}：点击或拖动；只修改已有有效高程，NoData 不会被填补。`;
        render();
    }));
    undo.addEventListener('click', () => { cancelStroke(); const model = history.pop(); if (model) {
        path = [];
        setModel(model, true);
        dialog.querySelector('#terrain-name').value = model.name;
        undo.disabled = !history.length;
        guide.textContent = '已撤销本窗口上一步。应用前可以继续编辑。';
        render();
    } });
    dialog.querySelector('#terrain-river-finish').addEventListener('click', finishRiver);
    dialog.querySelector('#terrain-river-cancel').addEventListener('click', () => { path = []; render(); });
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || tool === 'view' || stroke || event.isPrimary === false)
            return;
        const point = coordinate(event);
        if (!point) {
            guide.textContent = '请先生成或导入地形，并在有高程的预览范围内操作。';
            return;
        }
        event.preventDefault();
        canvas.focus();
        cursor = point;
        if (tool === 'river') {
            if (path.length < 200 && (!path.length || Math.hypot(point.x - path.at(-1).x, point.y - path.at(-1).y) > .001))
                path.push(point);
            guide.textContent = `河槽路径 ${path.length} 点 · 至少两点后完成`;
            render();
            return;
        }
        try {
            if (featureTools.includes(tool)) {
                const radius = number('terrain-feature-radius'), relief = number('terrain-feature-relief');
                if (!Number.isFinite(radius) || radius < .001 || radius > 1e7 || !Number.isFinite(relief) || relief < .001 || relief > 1e5)
                    throw new RangeError('请填写有效的影响半径与山高 / 谷深。');
                stroke = structuredClone(getModel());
                featurePath = [point];
                if (!lineFeature(tool))
                    featurePreview(point);
            }
            else {
                const before = structuredClone(getModel());
                stamp(point);
                stroke = before;
            }
            lastPoint = point;
            strokePointer = event.pointerId;
            strokeError = null;
            canvas.setPointerCapture(event.pointerId);
            render();
        }
        catch (error) {
            cancelStroke();
            reportError(error);
        }
    });
    canvas.addEventListener('pointermove', event => {
        if (event.isPrimary === false || strokePointer !== null && event.pointerId !== strokePointer)
            return;
        const point = coordinate(event);
        cursor = point;
        if (stroke && point && lastPoint) {
            const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y), spacing = Math.max(.001, number(featureTools.includes(tool) ? 'terrain-feature-radius' : 'terrain-brush-radius') / 4);
            if (featureTools.includes(tool)) {
                try {
                    featurePreview(point, distance >= spacing);
                    if (!lineFeature(tool) || distance >= spacing)
                        lastPoint = point;
                }
                catch (error) {
                    strokeError = error;
                    reportError(error);
                }
                render();
                return;
            }
            if (distance >= spacing) {
                try {
                    const count = Math.min(64, Math.ceil(distance / spacing)), from = lastPoint;
                    for (let i = 1; i <= count; i++)
                        stamp({ x: from.x + (point.x - from.x) * i / count, y: from.y + (point.y - from.y) * i / count });
                    lastPoint = point;
                }
                catch (error) {
                    strokeError = error;
                    finishStroke();
                }
            }
        }
        render();
    });
    canvas.addEventListener('pointerup', event => {
        if (strokePointer !== null && event.pointerId !== strokePointer)
            return;
        if (stroke && featureTools.includes(tool)) {
            const point = coordinate(event);
            if (point)
                try {
                    featurePreview(point, true);
                }
                catch (error) {
                    strokeError = error;
                }
        }
        finishStroke();
    });
    canvas.addEventListener('pointercancel', event => { if (strokePointer === event.pointerId)
        cancelStroke(); });
    canvas.addEventListener('lostpointercapture', event => { if (strokePointer === event.pointerId)
        cancelStroke(); });
    canvas.addEventListener('pointerleave', () => { cursor = null; if (!stroke)
        render(); });
    canvas.addEventListener('keydown', event => { if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        path = [];
        cancelStroke();
        guide.textContent = '已取消绘制，地形保持原值。';
    } if (event.key === 'Enter' && tool === 'river') {
        event.preventDefault();
        event.stopPropagation();
        finishRiver();
    } });
    const choosePreset = (value) => {
        dialog.querySelector('#terrain-create-preset').value = value;
        const relief = dialog.querySelector('#terrain-create-relief');
        if (!relief.dataset.userEdited)
            relief.value = String({ mountain: 500, ridge: 300, canyon: 180 }[value] ?? 5);
        dialog.querySelectorAll('[data-terrain-landscape]').forEach(button => { const active = button.dataset.terrainLandscape === value; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    };
    dialog.querySelectorAll('[data-terrain-landscape]').forEach(button => button.addEventListener('click', () => choosePreset(button.dataset.terrainLandscape)));
    dialog.querySelector('#terrain-create-preset').addEventListener('change', event => choosePreset(event.target.value));
    dialog.querySelector('#terrain-section-axis').addEventListener('change', render);
    dialog.addEventListener('input', event => { const id = event.target.id; if (id === 'terrain-create-relief')
        event.target.dataset.userEdited = 'true'; if (['terrain-brush-radius', 'terrain-feature-radius'].includes(id))
        render(); });
    const blur = () => { if (stroke)
        cancelStroke(); };
    window.addEventListener('blur', blur);
    dialog.addEventListener('close', () => { cancelStroke(); window.removeEventListener('blur', blur); });
    return { refresh: render, reset: () => { releaseStroke(); strokeError = null; history = []; path = []; cursor = null; undo.disabled = true; render(); } };
}
//# sourceMappingURL=terrain-authoring-panel.js.map