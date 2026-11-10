import { compileTerrain, parseTerrainCSV, parseTerrainASCIIGrid, terrainStats, validateTerrain, MAX_TERRAIN_POINTS, MAX_TERRAIN_RASTER_CELLS } from './lib/terrain.js';
import { escape, icon, measure, openDialog, toast } from './ui.js';
import { parseTerrainGeoTIFF, GeoTIFFUnitConfirmationRequired, MAX_GEOTIFF_BYTES } from './lib/terrain-geotiff.js';
import { terrainAuthoringHTML, bindTerrainAuthoring } from './terrain-authoring-panel.js';
function terrainPreview(model) {
    const mesh = compileTerrain(model);
    if (model.raster)
        return '<canvas width="300" height="210" aria-label="真实 DEM 像元高程预览"></canvas>';
    if (!mesh.bounds)
        return '<div class="terrain-preview-empty">导入测点或实际 DEM<br><small>不会从图片猜测地形高程</small></div>';
    const box = mesh.bounds, scale = Math.min(250 / Math.max(.1, box.maxX - box.minX), 160 / Math.max(.1, box.maxY - box.minY)), x = (value) => 24 + (value - box.minX) * scale, y = (value) => 24 + (value - box.minY) * scale;
    return `<svg viewBox="0 0 300 210" aria-label="真实测点三角网预览">${mesh.triangles.map(triangle => `<path d="M${triangle.map(point => `${x(point.x)},${y(point.y)}`).join('L')}Z" fill="#edf3ed" stroke="#aab9ad" stroke-width=".6"/>`).join('')}${model.points.map(point => `<circle cx="${x(point.x)}" cy="${y(point.y)}" r="2" fill="#336b58"><title>${escape(point.id)} · ${escape(point.z)} m</title></circle>`).join('')}</svg>`;
}
function paintRasterPreview(canvas, raster) {
    const ctx = canvas.getContext('2d'), tile = document.createElement('canvas');
    tile.width = raster.ncols;
    tile.height = raster.nrows;
    const tileCtx = tile.getContext('2d'), pixels = tileCtx.createImageData(raster.ncols, raster.nrows), values = raster.values.filter((v) => v !== null), min = Math.min(...values), max = Math.max(...values);
    for (let index = 0; index < raster.values.length; index++) {
        const value = raster.values[index], shade = value === null ? 0 : max === min ? .5 : (value - min) / (max - min), offset = index * 4;
        const color = value === null ? ((Math.floor(index / raster.ncols) + index % raster.ncols) % 2 ? [238, 239, 235] : [249, 250, 247]) : [235 - 66 * shade, 241 - 55 * shade, 232 - 65 * shade];
        pixels.data.set([...color.map(Math.round), 255], offset);
    }
    tileCtx.putImageData(pixels, 0, 0);
    ctx.clearRect(0, 0, 300, 210);
    ctx.imageSmoothingEnabled = false;
    const scale = Math.min(252 / raster.ncols, 162 / raster.nrows), w = raster.ncols * scale, h = raster.nrows * scale;
    ctx.drawImage(tile, (300 - w) / 2, (210 - h) / 2, w, h);
    ctx.strokeStyle = '#b6c6b6';
    ctx.strokeRect((300 - w) / 2, (210 - h) / 2, w, h);
}
export function showTerrainEditor(project, onChange) {
    const existing = project.municipalTerrain;
    let draft = structuredClone(existing ?? { name: '场地测量地形', visible: true, points: [] });
    let mode = draft.raster ? 'dem' : 'tin', tinPoints = draft.points, savedRaster = draft.raster, savedRasterSource = draft.rasterSource, gridRow = 0, gridCol = 0, importSequence = 0, lastGeoTIFF, pendingGeoTIFF, confirmedGeoTIFF;
    let tinSourceName = mode === 'tin' ? draft.sourceName : undefined, rasterSourceName = mode === 'dem' ? draft.sourceName : undefined;
    let authoring;
    const windowColumns = 12;
    const dialog = openDialog('场地地形', `<form id="terrain-form"><div class="terrain-editor"><section class="terrain-edit-main">
    <div class="terrain-header-fields"><label><span class="field-label">地形名称</span><input id="terrain-name" maxlength="120" value="${escape(draft.name)}" required></label><label class="terrain-visible"><input id="terrain-editor-visible" type="checkbox" ${draft.visible ? 'checked' : ''}>显示地形</label></div>
    ${terrainAuthoringHTML(project)}
    <div class="terrain-mode-bar"><label><span class="field-label">地形数据</span><select id="terrain-mode"><option value="tin" ${mode === 'tin' ? 'selected' : ''}>实测点 · TIN</option><option value="dem" ${mode === 'dem' ? 'selected' : ''}>栅格高程 · DEM</option></select></label><span class="help">坐标、高程与像元尺寸均使用 m</span></div>
    <div id="terrain-dropzone" class="terrain-dropzone"><span>${icon('upload', 19)}</span><div><strong>导入实际地形数据</strong><p>CSV 测点、ASC 栅格或单波段 GeoTIFF（.tif）。支持拖入；自动读取真实高程与像元尺寸。</p></div><button type="button" class="button subtle" id="terrain-import">选择文件</button><input id="terrain-file" type="file" accept=".csv,.asc,.txt,.tif,.tiff,text/csv,text/plain,image/tiff" hidden></div>
    <p id="terrain-upload-state" class="help" role="status"></p>
    <div id="terrain-geotiff-options" class="terrain-geotiff-options" hidden><label><span class="field-label">GeoTIFF 放置位置</span><select id="terrain-geotiff-placement"><option value="local">放到项目左上角 0,0</option><option value="source">保留原始米制位置</option></select></label><p class="help">本地放置仅平移。原地理坐标独立保存，位置仍可微调。</p></div>
    <div id="terrain-geotiff-confirm" class="terrain-geotiff-confirm" hidden><p class="help">文件未声明米制投影单位。请确认实际数据单位，不能将经纬度当作米。</p><label><input id="terrain-geotiff-meters" type="checkbox">我确认原坐标、像元尺寸和高程均为本地米制</label><button type="button" id="terrain-geotiff-retry" class="button subtle" disabled>确认米制并导入</button></div>
    <details class="terrain-paste"><summary>粘贴或编辑测点 / ASC 文本</summary><textarea id="terrain-csv" rows="5" spellcheck="false" placeholder="CSV：x,y,z（单位 m）\nASC：ncols、nrows、xllcorner、yllcorner、cellsize 及逐行高程"></textarea><button type="button" class="button subtle" id="terrain-parse">读取并预览</button><span class="help terrain-paste-note">按文本重新读取为 CSV / ASC 草稿。GeoTIFF 原文件信息保留在项目中，应用新草稿后更新。</span></details>
    <p id="terrain-source" class="help"></p>
    <section id="terrain-tin-section"><div class="section-head terrain-point-head"><h3>测量点</h3><button type="button" class="button subtle" id="terrain-add">${icon('plus', 14)}添加测点</button></div><div class="terrain-table-wrap"><table class="terrain-points"><thead><tr><th>点号</th><th>X · m</th><th>Y · m</th><th>Z 高程 · m</th><th></th></tr></thead><tbody id="terrain-points"></tbody></table><div id="terrain-no-points" class="terrain-table-empty">尚未添加测点。至少 3 个非共线点才能形成地形。</div></div></section>
    <section id="terrain-dem-section" hidden><div id="terrain-dem-empty" class="terrain-table-empty">导入 .asc 栅格高程。至少 2×2，最多 ${MAX_TERRAIN_RASTER_CELLS.toLocaleString('zh-CN')} 个像元。</div><div id="terrain-dem-fields" hidden>
      <div class="terrain-dem-heading"><h3>位置与分辨率</h3><span id="terrain-grid-dimensions" class="help"></span></div>
      <div class="terrain-raster-location"><label><span class="field-label">项目左上 X · m</span><input id="terrain-origin-x" type="number" step="any" data-terrain-raster="originX" required></label><label><span class="field-label">项目左上 Y · m</span><input id="terrain-origin-y" type="number" step="any" data-terrain-raster="originY" required></label><label><span class="field-label">像元尺寸 · m</span><input id="terrain-cell-size" type="number" step="any" min="0.000000001" data-terrain-raster="cellSize" required></label></div>
      <p class="help terrain-coordinate-note">源数据首行为北侧，画布 Y 向下。请检查位置对齐场地；本地放置仅平移，不转换坐标投影。</p><p id="terrain-original-coordinates" class="help"></p>
      <div class="terrain-dem-heading"><h3>高程值</h3><span class="help">空白 = NoData</span></div>
      <div class="terrain-grid-window"><label class="terrain-grid-row-label">第 <input id="terrain-grid-row" type="number" min="1" step="1"> 行（从北侧）</label><div><button type="button" class="icon-button" id="terrain-grid-prev" aria-label="上一组列">${icon('chevronLeft', 14)}</button><span id="terrain-grid-window-label"></span><button type="button" class="icon-button" id="terrain-grid-next" aria-label="下一组列">${icon('chevronRight', 14)}</button></div></div>
      <div id="terrain-grid-values" class="terrain-grid-values"></div>
    </div></section>
  </section><aside class="terrain-edit-aside"><span class="eyebrow">Terrain</span><h3>高程与计算范围</h3><div id="terrain-preview" class="terrain-preview"></div><div id="terrain-statistics"></div><p id="terrain-method-note" class="help"></p><p class="help">图纸缩放不改变真实地形。道路仅在已有地形覆盖范围内计算高程及挖填，未覆盖范围单独列出。</p><p id="terrain-error" class="terrain-error" role="status"></p></aside></div>
  <footer class="terrain-editor-footer"><button type="button" class="button subtle" id="terrain-remove" ${!existing ? 'disabled' : ''}>移除地形</button><span class="help">应用后可撤销；关闭窗口不改变项目。</span><button type="submit" class="button primary">应用地形</button></footer></form>`, { wide: true, subtitle: '导入实测数据，或从平地开始制作可编辑的方案地形' });
    dialog.classList.add('terrain-dialog');
    const errorNode = dialog.querySelector('#terrain-error');
    if (existing?.rasterSource && existing.raster?.originX === existing.rasterSource.originEasting && existing.raster?.originY === -existing.rasterSource.originNorthing)
        dialog.querySelector('#terrain-geotiff-placement').value = 'source';
    if (existing) {
        const raster = existing.raster;
        const sentinel = raster && raster.noDataValue !== null && !raster.values.includes(raster.noDataValue) ? raster.noDataValue : -999999;
        dialog.querySelector('#terrain-csv').value = raster ? `ncols ${raster.ncols}\nnrows ${raster.nrows}\nxllcorner ${raster.xllcorner}\nyllcorner ${raster.yllcorner}\ncellsize ${raster.cellSize}\nNODATA_value ${sentinel}\n` + Array.from({ length: raster.nrows }, (_, row) => raster.values.slice(row * raster.ncols, (row + 1) * raster.ncols).map(value => value ?? sentinel).join(' ')).join('\n') : 'id,x,y,z\n' + existing.points.map(p => `"${p.id.replace(/"/g, '""')}",${p.x},${p.y},${p.z}`).join('\n');
    }
    const reportError = (error) => { errorNode.textContent = error instanceof Error ? error.message : '请核对地形数据。'; };
    const refreshSummary = () => {
        try {
            const s = terrainStats(draft);
            dialog.querySelector('#terrain-preview').innerHTML = terrainPreview(draft);
            if (draft.raster)
                paintRasterPreview(dialog.querySelector('#terrain-preview canvas'), draft.raster);
            dialog.querySelector('#terrain-statistics').innerHTML = `<div class="stat-row"><span>${s.sourceType === 'dem' ? '有效像元 / 总像元' : '测点 / 三角形'}</span><strong>${s.pointCount} / ${s.sourceType === 'dem' ? s.gridCells : s.triangleCount}</strong></div>${s.sourceType === 'dem' ? `<div class="stat-row"><span>NoData / 三角片</span><strong>${s.noDataCount} / ${s.triangleCount}</strong></div><div class="stat-row"><span>完整栅格边框面积</span><strong>${measure(s.fullRasterArea, 2)} m²</strong></div>` : ''}<div class="stat-row"><span>有效内插覆盖面积</span><strong>${measure(s.area, 2)} m²</strong></div><div class="stat-row"><span>最低 / 最高高程</span><strong>${s.minElevation === null ? '—' : measure(s.minElevation, 3)} / ${s.maxElevation === null ? '—' : measure(s.maxElevation, 3)} m</strong></div>${s.status === 'incomplete' ? '<p class="help">尚未形成有效三角面，当前不能计算地形高程与挖填。</p>' : ''}`;
            errorNode.textContent = '';
        }
        catch (error) {
            reportError(error);
        }
        dialog.querySelector('#terrain-source').textContent = draft.sourceName ? `来源：${draft.sourceName} · 当前坐标与高程可继续修改` : '手工测量 · 坐标和高程请填写实际值';
        dialog.querySelector('#terrain-method-note').textContent = mode === 'dem' ? '按相邻像元中心构成固定三角面，保留全部高程。NoData 不跨填，外缘半像元不外推；边框面积与有效计算覆盖面积分别列出。' : '测点构成真实 Delaunay 三角网，内部线性内插高程。不在测量凸包之外推测地形。';
    };
    const renderGrid = () => {
        const raster = draft.raster;
        if (!raster)
            return;
        gridRow = Math.max(0, Math.min(raster.nrows - 1, Number.isFinite(gridRow) ? gridRow : 0));
        gridCol = Math.max(0, Math.min(Math.floor((raster.ncols - 1) / windowColumns) * windowColumns, gridCol));
        const rowInput = dialog.querySelector('#terrain-grid-row');
        rowInput.value = String(gridRow + 1);
        rowInput.max = String(raster.nrows);
        const end = Math.min(raster.ncols, gridCol + windowColumns);
        dialog.querySelector('#terrain-grid-window-label').textContent = `列 ${gridCol + 1}–${end} / ${raster.ncols}`;
        dialog.querySelector('#terrain-grid-prev').disabled = gridCol === 0;
        dialog.querySelector('#terrain-grid-next').disabled = end === raster.ncols;
        dialog.querySelector('#terrain-grid-values').innerHTML = Array.from({ length: end - gridCol }, (_, i) => { const col = gridCol + i, index = gridRow * raster.ncols + col, value = raster.values[index]; return `<label><span>C${col + 1}</span><input type="number" step="any" data-terrain-cell="${index}" value="${value === null ? '' : Number.isFinite(value) ? value : ''}" placeholder="NoData" aria-label="栅格第${gridRow + 1}行第${col + 1}列高程米"></label>`; }).join('');
    };
    const renderRows = () => {
        dialog.querySelector('#terrain-mode').value = mode;
        dialog.querySelector('#terrain-tin-section').hidden = mode !== 'tin';
        dialog.querySelector('#terrain-dem-section').hidden = mode !== 'dem';
        dialog.querySelector('#terrain-geotiff-options').hidden = (!draft.rasterSource && !lastGeoTIFF) || mode !== 'dem' && !pendingGeoTIFF;
        dialog.querySelectorAll('#terrain-dem-section input').forEach(input => input.disabled = mode !== 'dem' || !draft.raster);
        dialog.querySelector('#terrain-points').innerHTML = mode === 'tin' ? draft.points.map((point, index) => `<tr data-terrain-row="${index}"><td><input data-terrain-index="${index}" data-terrain-axis="id" value="${escape(point.id)}" maxlength="120" aria-label="测点${index + 1}编号" required></td>${['x', 'y', 'z'].map(axis => `<td><input type="number" step="any" data-terrain-index="${index}" data-terrain-axis="${axis}" value="${Number.isFinite(point[axis]) ? point[axis] : ''}" aria-label="测点${index + 1}${axis.toUpperCase()}米" required></td>`).join('')}<td><button type="button" class="icon-button" data-terrain-delete="${index}" aria-label="删除测点${index + 1}">${icon('trash', 13)}</button></td></tr>`).join('') : '';
        dialog.querySelector('#terrain-no-points').hidden = !!draft.points.length;
        dialog.querySelector('#terrain-add').disabled = draft.points.length >= MAX_TERRAIN_POINTS;
        dialog.querySelector('#terrain-dem-empty').hidden = !!draft.raster;
        dialog.querySelector('#terrain-dem-fields').hidden = !draft.raster;
        if (draft.raster) {
            const raster = draft.raster;
            dialog.querySelector('#terrain-grid-dimensions').textContent = `${raster.ncols} × ${raster.nrows} · ${raster.values.length.toLocaleString('zh-CN')} 像元`;
            dialog.querySelectorAll('[data-terrain-raster]').forEach(input => input.value = String(raster[input.dataset.terrainRaster]));
            const source = draft.rasterSource;
            dialog.querySelector('#terrain-original-coordinates').textContent = source ? `原始 GeoTIFF 左上：E ${source.originEasting}，N ${source.originNorthing}；${source.projectedCrs ? 'EPSG:' + source.projectedCrs : '本地坐标'} · ${source.unitBasis === 'metadata' ? '文件确认米制' : '用户确认米制'}；原始 NoData：${source.noData ?? '未声明'}` : `原始 ASC 左下角：X ${raster.xllcorner}，Y ${raster.yllcorner}；NoData：${raster.noDataValue ?? '未声明'}`;
            renderGrid();
        }
        refreshSummary();
        authoring?.refresh();
    };
    authoring = bindTerrainAuthoring(dialog, () => draft, (model, refresh) => {
        importSequence++;
        lastGeoTIFF = undefined;
        pendingGeoTIFF = undefined;
        draft = model;
        mode = draft.raster ? 'dem' : 'tin';
        if (mode === 'dem') {
            savedRaster = draft.raster;
            savedRasterSource = draft.rasterSource;
            rasterSourceName = draft.sourceName;
        }
        else {
            tinPoints = draft.points;
            tinSourceName = draft.sourceName;
        }
        if (refresh)
            renderRows();
    }, reportError);
    const importData = (text, sourceName, asc = false) => {
        try {
            if (asc || /^\s*\uFEFF?\s*(?:ncols|nrows|xllcorner|yllcorner|xllcenter|yllcenter|cellsize|nodata_value)\s+/i.test(text)) {
                const raster = parseTerrainASCIIGrid(text);
                savedRaster = raster;
                savedRasterSource = undefined;
                rasterSourceName = sourceName;
                mode = 'dem';
                draft = { ...draft, points: [], raster, rasterSource: undefined, sourceName };
                gridRow = 0;
                gridCol = 0;
            }
            else {
                const points = parseTerrainCSV(text);
                tinPoints = points;
                tinSourceName = sourceName;
                mode = 'tin';
                draft = { ...draft, points, raster: undefined, rasterSource: undefined, sourceName };
            }
            dialog.querySelector('#terrain-csv').value = text;
            authoring?.reset();
            renderRows();
            toast(mode === 'dem' ? '真实 DEM 已读取，确认位置后应用' : '实际测点已读取，应用后更新项目');
            lastGeoTIFF = undefined;
            pendingGeoTIFF = undefined;
            dialog.querySelector('#terrain-geotiff-confirm').hidden = true;
            dialog.querySelector('#terrain-geotiff-options').hidden = true;
        }
        catch (error) {
            reportError(error);
            toast(errorNode.textContent, true);
        }
    };
    const importFile = async (file, confirmLocal = false) => {
        const sequence = ++importSequence, geotiff = /\.tiff?$/i.test(file.name), stateNode = dialog.querySelector('#terrain-upload-state');
        const confirmed = confirmedGeoTIFF === file || confirmLocal && pendingGeoTIFF === file && dialog.querySelector('#terrain-geotiff-meters').checked;
        pendingGeoTIFF = undefined;
        dialog.querySelector('#terrain-geotiff-confirm').hidden = true;
        if (file.size > (geotiff ? MAX_GEOTIFF_BYTES : 2_000_000)) {
            stateNode.textContent = '';
            dialog.querySelector('#terrain-dropzone').removeAttribute('aria-busy');
            reportError(new Error(geotiff ? 'GeoTIFF 文件应小于 8 MB。' : 'CSV / ASC 文件应小于 2 MB。'));
            return;
        }
        stateNode.textContent = `正在读取 ${file.name}…`;
        dialog.querySelector('#terrain-dropzone').setAttribute('aria-busy', 'true');
        try {
            if (geotiff) {
                lastGeoTIFF = file;
                const input = await file.arrayBuffer();
                if (sequence !== importSequence || !dialog.open)
                    return;
                const result = await parseTerrainGeoTIFF(input, { confirmLocalMeters: confirmed, placement: dialog.querySelector('#terrain-geotiff-placement').value });
                if (sequence !== importSequence || !dialog.open)
                    return;
                savedRaster = result.raster;
                savedRasterSource = result.source;
                rasterSourceName = file.name;
                mode = 'dem';
                draft = { ...draft, points: [], raster: result.raster, rasterSource: result.source, sourceName: file.name };
                gridRow = 0;
                gridCol = 0;
                pendingGeoTIFF = undefined;
                authoring?.reset();
                if (result.source.unitBasis === 'confirmed-local')
                    confirmedGeoTIFF = file;
                dialog.querySelector('#terrain-geotiff-confirm').hidden = true;
                const raster = result.raster, sentinel = raster.noDataValue !== null && !raster.values.includes(raster.noDataValue) ? raster.noDataValue : -999999;
                dialog.querySelector('#terrain-csv').value = `ncols ${raster.ncols}\nnrows ${raster.nrows}\nxllcorner ${raster.xllcorner}\nyllcorner ${raster.yllcorner}\ncellsize ${raster.cellSize}\nNODATA_value ${sentinel}\n` + Array.from({ length: raster.nrows }, (_, row) => raster.values.slice(row * raster.ncols, (row + 1) * raster.ncols).map(value => value ?? sentinel).join(' ')).join('\n');
                renderRows();
                toast('GeoTIFF 真实高程已读取，确认放置位置后应用');
            }
            else {
                const text = await file.text();
                if (sequence !== importSequence || !dialog.open)
                    return;
                importData(text, file.name, /\.asc$/i.test(file.name));
            }
        }
        catch (error) {
            if (sequence !== importSequence || !dialog.open)
                return;
            reportError(error);
            if (error instanceof GeoTIFFUnitConfirmationRequired) {
                pendingGeoTIFF = file;
                dialog.querySelector('#terrain-geotiff-confirm').hidden = false;
                dialog.querySelector('#terrain-geotiff-options').hidden = false;
                dialog.querySelector('#terrain-geotiff-meters').checked = false;
                dialog.querySelector('#terrain-geotiff-retry').disabled = true;
            }
        }
        finally {
            if (sequence === importSequence) {
                stateNode.textContent = '';
                dialog.querySelector('#terrain-dropzone').removeAttribute('aria-busy');
            }
        }
    };
    dialog.querySelector('#terrain-import').addEventListener('click', () => dialog.querySelector('#terrain-file').click());
    dialog.querySelector('#terrain-file').addEventListener('change', event => { const input = event.target; if (input.files?.[0])
        void importFile(input.files[0]); input.value = ''; });
    const dropzone = dialog.querySelector('#terrain-dropzone');
    dropzone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); dropzone.classList.remove('dragover'); if (event.dataTransfer.files?.[0])
        void importFile(event.dataTransfer.files[0]); });
    dialog.querySelector('#terrain-parse').addEventListener('click', () => { importSequence++; importData(dialog.querySelector('#terrain-csv').value, mode === 'dem' ? '粘贴 DEM 数据' : '粘贴测量数据', mode === 'dem'); });
    dialog.querySelector('#terrain-mode').addEventListener('change', event => { importSequence++; pendingGeoTIFF = undefined; dialog.querySelector('#terrain-geotiff-confirm').hidden = true; if (mode === 'tin') {
        tinPoints = draft.points;
        tinSourceName = draft.sourceName;
    }
    else {
        savedRaster = draft.raster;
        savedRasterSource = draft.rasterSource;
        rasterSourceName = draft.sourceName;
    } mode = event.target.value; draft = { ...draft, points: mode === 'tin' ? tinPoints : [], raster: mode === 'dem' ? savedRaster : undefined, rasterSource: mode === 'dem' ? savedRasterSource : undefined, sourceName: mode === 'dem' ? rasterSourceName : tinSourceName }; authoring?.reset(); renderRows(); });
    dialog.querySelector('#terrain-geotiff-meters').addEventListener('change', event => { dialog.querySelector('#terrain-geotiff-retry').disabled = !event.target.checked; });
    dialog.querySelector('#terrain-geotiff-retry').addEventListener('click', () => { if (pendingGeoTIFF)
        void importFile(pendingGeoTIFF, true); });
    dialog.querySelector('#terrain-geotiff-placement').addEventListener('change', () => {
        if (lastGeoTIFF) {
            void importFile(lastGeoTIFF, confirmedGeoTIFF === lastGeoTIFF);
            return;
        }
        if (!draft.rasterSource || !draft.raster)
            return;
        try {
            const source = draft.rasterSource, keep = dialog.querySelector('#terrain-geotiff-placement').value === 'source', originX = keep ? source.originEasting : 0, originY = keep ? -source.originNorthing : 0, raster = { ...draft.raster, originX, originY, xllcorner: originX, yllcorner: -originY - draft.raster.nrows * draft.raster.cellSize };
            validateTerrain({ ...draft, raster });
            draft.raster = raster;
            renderRows();
        }
        catch (error) {
            reportError(error);
        }
    });
    dialog.addEventListener('close', () => { importSequence++; });
    dialog.querySelector('#terrain-add').addEventListener('click', () => { let serial = draft.points.length + 1; while (draft.points.some(point => point.id === `P${serial}`))
        serial++; draft.points.push({ id: `P${serial}`, x: NaN, y: NaN, z: NaN }); renderRows(); dialog.querySelector(`[data-terrain-index="${draft.points.length - 1}"][data-terrain-axis="x"]`).focus(); });
    dialog.querySelector('#terrain-grid-row').addEventListener('change', event => { gridRow = Math.round(Number(event.target.value)) - 1; renderGrid(); });
    dialog.querySelector('#terrain-grid-prev').addEventListener('click', () => { gridCol -= windowColumns; renderGrid(); });
    dialog.querySelector('#terrain-grid-next').addEventListener('click', () => { gridCol += windowColumns; renderGrid(); });
    dialog.addEventListener('input', event => {
        const input = event.target;
        if (input.id === 'terrain-name')
            draft.name = input.value.trim();
        else if (input.id === 'terrain-editor-visible')
            draft.visible = input.checked;
        else if (input.dataset.terrainRaster && draft.raster)
            draft.raster[input.dataset.terrainRaster] = input.value.trim() ? Number(input.value) : NaN;
        else if (input.dataset.terrainCell !== undefined && draft.raster)
            draft.raster.values[Number(input.dataset.terrainCell)] = input.value.trim() ? Number(input.value) : input.validity.badInput ? NaN : null;
        else if (input.dataset.terrainIndex !== undefined) {
            const point = draft.points[Number(input.dataset.terrainIndex)], axis = input.dataset.terrainAxis;
            if (axis === 'id')
                point.id = input.value.trim();
            else if (axis === 'x' || axis === 'y' || axis === 'z')
                point[axis] = input.value.trim() ? Number(input.value) : NaN;
        }
        else
            return;
        refreshSummary();
        authoring?.refresh();
    });
    dialog.addEventListener('click', event => { const button = event.target.closest('[data-terrain-delete]'); if (button) {
        draft.points.splice(Number(button.dataset.terrainDelete), 1);
        renderRows();
    } });
    dialog.querySelector('#terrain-remove').addEventListener('click', () => { try {
        onChange(undefined);
        dialog.close();
        toast('地形已移除，可撤销恢复');
    }
    catch (error) {
        reportError(error);
    } });
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); try {
        if (mode === 'dem' && !draft.raster)
            throw new RangeError('请先生成或导入 DEM 栅格高程。');
        validateTerrain(draft);
        compileTerrain(draft);
        onChange(structuredClone(draft));
        dialog.close();
        toast(draft.sourceName?.includes('自建') || draft.sourceName?.includes('人工塑形') ? '方案地形已更新，可撤销' : draft.raster ? '真实 DEM 地形已更新' : draft.points.length >= 3 ? '真实测点地形已更新' : '测点已保存，补充至少 3 个非共线点后生成地形');
    }
    catch (error) {
        reportError(error);
    } });
    renderRows();
    return dialog;
}
//# sourceMappingURL=terrain-panel.js.map