import { DrawingViewer } from './canvas.js';
import { renderInspector, renderLeft } from './panels.js';
import { icon, escape, money, unitPrice, measure, toast, openDialog, askNumber } from './ui.js';
import { regionMetrics, validateRegion } from './lib/geometry.js';
import { calculateProject, normalizeDecimal, addDecimal } from './lib/pricing.js';
import { createMaterialSnapshot, DEMO_MATERIALS, loadMaterials, newId, normalizeMaterial, saveMaterials } from './lib/materials.js';
import { createHistory, deleteProject, importProjectJSON, listProjects, loadProject, saveProject, validateProject } from './lib/persistence.js';
import { downloadCSV, downloadProjectJSON, printQuote } from './lib/export.js';
import { createMetricDrawing, renderWallInspector, renderPlanGuide, showRoomTemplate, changeWallDimensions } from './wall-editor.js';
import { normalizeWalls } from './lib/wall-plan.js';
import { rebuildWallRegions } from './lib/wall-regions.js';
import { findRoomPlacement } from './lib/plan-authoring.js';
import { validateOpenings } from './lib/wall-solid.js';
import { openingName, renderOpeningInspector, showOpeningEditor, updateOpeningInspectorNumbers } from './opening-editor.js';
import { OpeningPositionInteraction } from './opening-position.js';
import { defaultOpeningQuote } from './lib/opening-pricing.js';
import { openingPositionValidity } from './lib/opening-interaction.js';
import { openPriceManager, openSavedPriceRefresh } from './price-manager.js';
import { materialSourceFields, readMaterialSource, renderProjectPriceSources, showPriceSourceLink, showProjectMaterialSync } from './project-material-prices.js';
import { describePriceSource } from './lib/price-provenance.js';
import { openCostWorkbench, closeCostWorkbench, refreshCostWorkbench, isCostWorkbenchOpen, bindCostWorkbench, registerCostModule, getCostItems, getCostSummary, showCostTab } from './cost-workbench.js';
import { structureModule } from './structure-module.js';
import { finishModule } from './finish-module.js';
import { municipalModule } from './municipal-module.js';
import { FURNITURE_TEMPLATES, clampFurniturePosition, validateFurniture } from './lib/furniture.js';
import { renderFurnitureInspector, showFurniturePicker } from './furniture-panel.js';
import { regionInteriorPoint } from './lib/geometry.js';
import { renderDecorationLeft, renderDecorationGuide } from './decoration-panel.js';
import { renderDecorationTabs, renderServiceLeft, renderServiceInspector, renderServiceGuide, renderServicePresets, updateServiceNumbers } from './service-panel.js';
import { createServiceRoute, servicePreset, validateServiceRoutes } from './lib/services.js';
import { fixtureWallPlacement } from './lib/fixtures.js';
import { renderWallElevation } from './wall-elevation.js';
import { validateProjectBoundary, validatePlanBoundary } from './lib/plan-boundary.js';
import { wallFootprints } from './lib/wall-joins.js';
import { makeCircle, makeArc } from './lib/drawing-shapes.js';
import { validateWallShapes } from './lib/wall-shapes.js';
import { renderPlanTools, renderWallShapeInspector, showBoundaryEditor, showShapeParameters, shapeParameters } from './plan-tools.js';
import { activeLevel, ensureLevels, levelProjects, switchLevel, addLevel, updateLevel, deleteLevel, effectiveLevelProject, validateLevels } from './lib/levels.js';
import { renderLevelSwitcher, showLevelManager, renderSurfaceTabs, renderCeilingInspector, renderFloorOpenings, renderStairConnection } from './level-panel.js';
import { renderIncomingStairList } from './level-panel.js';
import { isStairKind } from './lib/stairs.js';
import { incomingStairs, syncLinkedStairOpenings, defaultStairSettings, detachStairOpening } from './lib/stair-links.js';
import { showFloorOpeningEditor } from './floor-opening-panel.js';
import { civilPreset, createCivilElement, generateCivilLayout, civilResolvedElement, detachCivilElement } from './lib/civil.js';
import { calculateCivilProject } from './lib/civil-pricing.js';
import { renderCivilLeft, renderCivilGuide, renderCivilInspector, updateCivilNumbers, showCivilTemplate } from './civil-panel.js';
import { createMunicipalElement, municipalPreset } from './lib/municipal-design.js';
import { calculateMunicipalProject, validateMunicipalProject } from './lib/municipal-pricing.js';
import { calculateProjectBudget, projectBudgetSnapshot, validateProjectBudgetOptions } from './lib/project-budget.js';
import { openProjectOverview, refreshProjectOverview } from './project-overview.js';
import { openProjectPricing, refreshProjectPricing } from './project-pricing.js';
import { collectProjectPriceRows, collectProjectSourceRows } from './lib/project-price-edit.js';
import { calculateProjectQuantities } from './lib/project-quantities.js';
import { renderMunicipalLeft, renderMunicipalInspector, renderMunicipalGuide, updateMunicipalNumbers, showMunicipalQuickCreate } from './municipal-panel.js';
import { renderRoadAuthoring, renderUrbanCatalogEntries } from './municipal-authoring.js';
import { municipalCatalogPreset, createMunicipalCatalogElement } from './lib/municipal-catalog.js';
import { createRoadsideKerbs, createJunctionKerbs, municipalConnectionPorts } from './lib/municipal-connections.js';
import { showMunicipalStarter, showMunicipalCheck, renderMunicipalProgress } from './municipal-workflow.js';
import { changeMunicipalOption } from './lib/municipal-options.js';
import { createTerrainGrid, carveTerrainRiver } from './lib/terrain-authoring.js';
import { renderMunicipalEngineering, syncMunicipalEngineering, previewRoadGeometry } from './municipal-engineering.js';
import { showTerrainEditor } from './terrain-panel.js';
import { showRoadProfileEditor, renderRoadProfileSummary } from './road-profile-panel.js';
import { showHydraulicsEditor } from './hydraulics-panel.js';
import { showEarthworkTransferEditor } from './earthwork-transfer-panel.js';
import { renderSitePlacement, showSiteAlignment, showRoadEndpoints, showRoadTunnel } from './site-placement.js';
import { setMunicipalElevation, shiftMunicipalElevation, alignMunicipalToTerrain, setRoadEndpointElevations } from './lib/municipal-elevation.js';
import { roadStations } from './lib/road-profile.js';
registerCostModule(structureModule);
registerCostModule(finishModule);
registerCostModule(municipalModule);
const $ = (selector) => document.querySelector(selector);
const copy = (value) => structuredClone(value);
function freshProject() {
    return { version: 1, id: newId('project'), name: '未命名项目', drawing: null, wallJoinStyle: 'clean', calibration: { metersPerPixel: null, method: null }, regions: [], additionalCost: '0', taxRate: '0', view: { labels: true, drawingOpacity: 1 } };
}
let project = freshProject();
let selectedId = null;
let selectedSurface = 'floor';
let selectedWallId = null;
let selectedOpeningId = null;
let selectedFurnitureId = null;
let selectedServiceId = null;
let selectedCivilId = null;
let selectedMunicipalId = null;
let municipalCategory = 'all';
let municipalCatalogSearch = '', municipalCatalogGroup = 'all';
let municipalDraftSettings = { width: 600 };
let sitePlacement = { mode: 'terrain', elevation: 0 };
let civilCategory = 'all';
let decorationTab = 'fixtures';
let serviceSystem = 'all';
let serviceSearch = '';
let serviceDrawing = null;
let selectedWallSide = null;
let viewMode = '2d';
let threeViewer = null;
let loading3D = null;
let viewRequest = 0;
let cutaway = false;
let decorationCategory = 'all';
const workspaceMode = () => project.workspaceMode ?? 'plan';
const canDecorate = (value = project) => Boolean(value.drawing && (value.drawing.type !== 'plan' || value.regions.length > 0 && !value.planError));
let materials;
try {
    materials = loadMaterials();
}
catch (error) {
    materials = DEMO_MATERIALS.map(m => ({ ...m }));
    toast(error.message, true);
}
let history = createHistory(project);
let savedSignature = '';
let autoSaveTimer;
let pendingGeometryFrame = 0;
let uploading = false;
let routeDone = null;
let inspectorSelection;
let priceSourceInspectorHTML = '';
let quote = calculateProject(project);
const signature = (value) => JSON.stringify(value, (key, item) => ['quoteSummary', 'budgetSummary', 'savedAt', 'updatedAt'].includes(key) ? undefined : item);
const selectedRegion = () => project.regions.find(r => r.id === selectedId) || null;
const selectedCivil = () => { const item = project.civilElements?.find(item => item.id === selectedCivilId); return item ? civilResolvedElement(item, project) : null; };
const computeQuote = (value) => value.workspaceMode === 'municipal' ? calculateMunicipalProject(value) : value.workspaceMode === 'civil' ? calculateCivilProject(value) : calculateProject(value);
const selectedWall = () => project.walls?.find(w => w.id === selectedWallId) || null;
const selectedWallShape = (next = project) => next.wallShapes?.find(shape => shape.wallIds.includes(selectedWallId)) || null;
const itemOwner = (next = project) => {
    if (selectedWallId)
        return selectedWallShape(next) || next.walls?.find(wall => wall.id === selectedWallId);
    const region = next.regions.find(region => region.id === selectedId);
    if (!region || selectedSurface === 'floor')
        return region;
    if (region.ceiling)
        return region.ceiling;
    const ceiling = { enabled: true, items: [], additionalCost: '0' };
    if (next !== project)
        region.ceiling = ceiling;
    return ceiling;
};
function renderProject() {
    const effective = effectiveLevelProject(project);
    const display = { ...effective, civilElements: effective.civilElements?.map(item => civilResolvedElement(item, effective)) };
    if (!display.wallShapes?.length)
        return display;
    return { ...display, walls: display.walls.map(wall => { const group = display.wallShapes.find(shape => shape.wallIds.includes(wall.id)); return group ? { ...wall, items: group.items, finishSide: group.finishSide || 'both' } : wall; }) };
}
const selectedWallQuote = () => quote.walls?.find(wall => wall.id === (selectedWallShape()?.id || selectedWallId));
function openingFeedback(message, error = false) {
    const feedback = $('#opening-position-feedback');
    if (feedback) {
        feedback.textContent = message;
        feedback.classList.toggle('error', error);
    }
}
function previewOpening(id, patch) {
    const opening = project.openings?.find(opening => opening.id === id);
    if (!opening)
        return;
    Object.assign(opening, patch);
    if (!pendingGeometryFrame)
        pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
}
function commitOpening(id, patch) {
    update(next => {
        const opening = next.openings?.find(opening => opening.id === id);
        if (!opening)
            throw new Error('开口已不存在。');
        if (opening.locked)
            throw new Error('请先解锁开口。');
        Object.assign(opening, patch);
    }, { inspector: false });
}
const viewer = new DrawingViewer($('#drawing-canvas'), {
    select(id) { selectObject('region', id); },
    selectWall(id, side) { selectObject('wall', id, side); },
    selectOpening(id) { selectObject('opening', id); },
    previewOpening,
    commitOpening,
    selectFurniture(id) { selectObject('furniture', id); },
    selectService(id) { selectObject('service', id); },
    selectCivil(id) { selectObject('civil', id); },
    selectMunicipal(id) { selectObject('municipal', id); },
    createMunicipal(kind, points, patch) { createMunicipal(kind, points, patch); },
    previewMunicipal(id, points) {
        const item = project.municipalElements?.find(item => item.id === id);
        if (!item)
            return;
        const previousLength = item.tunnel ? roadStations(project, item)?.at(-1) : null;
        item.points = points;
        previewRoadGeometry(project, item, previousLength);
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
    },
    commitMunicipal(id, points) { update(next => { const item = next.municipalElements?.find(item => item.id === id); if (item)
        item.points = points; }, { inspector: false }); },
    placeCivil(kind, position) { placeCivil(kind, position); },
    previewCivil(id, patch) {
        const item = project.civilElements?.find(item => item.id === id);
        if (!item)
            return;
        Object.assign(item, patch);
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
    },
    commitCivil(id, patch) { update(next => { const item = next.civilElements?.find(item => item.id === id); if (item)
        Object.assign(item, patch); }, { inspector: false }); },
    previewService(id, points) { const route = project.serviceRoutes?.find(route => route.id === id); if (route) {
        route.points = points;
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
    } },
    commitService(id, points) { update(next => { const route = next.serviceRoutes?.find(route => route.id === id); if (route)
        route.points = points; }, { inspector: false }); },
    serviceRoute(points) {
        if (!serviceDrawing)
            throw new Error('请先选择一种线材或管道。');
        const z = Number($('#service-draw-height').value);
        if (!Number.isFinite(z) || z < -100 || z > 2000)
            throw new Error('安装高度应为 -100–2000 cm。');
        const drawing = serviceDrawing, route = createServiceRoute(drawing.presetId, points.map(point => ({ ...point, z })), project);
        update(next => { const existing = next.serviceRoutes?.find(item => item.id === drawing.replacingId); if (existing) {
            existing.points = route.points;
            selectedServiceId = existing.id;
        }
        else {
            (next.serviceRoutes ??= []).push(route);
            selectedServiceId = route.id;
        } selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = null; });
        serviceDrawing = null;
        toast('线路已创建，长度已计算，可填写单价和施工费');
    },
    previewFurniture(id, position) { const item = project.furniture?.find(item => item.id === id); if (item) {
        item.position = position;
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
    } },
    commitFurniture(id, position) { update(next => { const item = next.furniture?.find(item => item.id === id); if (item)
        item.position = position; }, { inspector: false }); },
    previewFurnitureResize(id, patch) { const item = project.furniture?.find(item => item.id === id); if (item) {
        Object.assign(item, patch);
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); });
    } },
    commitFurnitureResize(id, patch) { update(next => { const item = next.furniture?.find(item => item.id === id); if (item)
        Object.assign(item, patch); }, { inspector: false }); },
    placeFurniture(kind, position) { placeFurniture(kind, position); },
    shape(shape) { addDrawingShape(shape); },
    boundary(points) { applyBoundary(points); },
    floorOpening(regionId, opening) { update(next => (next.floorOpenings ??= []).push({ id: newId('floor-opening'), regionId, ...opening })); toast('楼板洞已按房间裁切，净面积与天花板用量已更新'); },
    async selectIncomingStair(levelId, id) { await changeActiveLevel(levelId); selectObject('furniture', id); },
    previewRotation(id, rotation) { const item = project.furniture?.find(item => item.id === id); if (item) {
        item.rotation = rotation;
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render({ inspector: false }); const field = $('#furniture-rotation'); if (field)
                field.value = String(rotation); });
    } },
    commitRotation(id, rotation) { update(next => { const item = next.furniture?.find(item => item.id === id); if (item)
        item.rotation = rotation; }, { inspector: false }); },
    route(points) { const scale = project.drawing?.type === 'plan' ? .01 : project.calibration.metersPerPixel; if (!scale) {
        toast('请先校准图纸比例。', true);
        return;
    } const complete = routeDone; routeDone = null; $('#route-controls').hidden = true; complete?.(points.map(point => ({ x: point.x * scale, y: point.y * scale }))); openCosts(); showCostTab('municipal'); },
    wall(start, end) { changeWalls(next => next.walls.push({ id: newId('wall'), start, end, thickness: Number(next.wallThickness || 20), height: Number(next.wallHeight || 280) })); },
    create(points, hole) {
        if (project.drawing?.type === 'plan' && !hole) {
            changeWalls(next => points.forEach((point, i) => next.walls.push({ id: newId('wall'), start: point, end: points[(i + 1) % points.length], thickness: Number(next.wallThickness || 20), height: Number(next.wallHeight || 280) })));
            return;
        }
        update(next => {
            if (hole)
                next.regions.find(r => r.id === selectedId).holes.push(points);
            else {
                const region = { id: newId('area'), name: `区域 ${String(next.regions.length + 1).padStart(2, '0')}`, points, holes: [], hidden: false, items: [], additionalCost: '0' };
                next.regions.push(region);
                selectedId = region.id;
            }
        });
        toast(hole ? '孔洞已扣除，可继续编辑边界' : '区域已创建，选择材料开始报价');
    },
    preview(id, points, holes) {
        const region = project.regions.find(r => r.id === id);
        if (!region)
            return;
        region.points = points;
        region.holes = holes;
        if (!pendingGeometryFrame)
            pendingGeometryFrame = requestAnimationFrame(() => { pendingGeometryFrame = 0; render(); });
    },
    commit(id, points, holes) {
        update(next => { const region = next.regions.find(r => r.id === id); if (region) {
            region.points = points;
            region.holes = holes;
        } });
    },
    async calibrate(points) {
        const pixels = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const distance = await askNumber('校准真实尺寸', '这两个点之间的实际距离（米）', '1', '请选择图纸中标注尺寸的两个端点，填写实际距离。');
        if (distance != null) {
            update(next => next.calibration = { metersPerPixel: distance / pixels, method: 'two-points', points, distance });
            toast('比例已校准，区域面积与报价已更新');
        }
        viewer.setTool('select');
    },
    error(message) { toast(message, true); },
    status(message, zoom) { if (viewMode === '2d') {
        $('#canvas-hint').textContent = message;
        $('#zoom').textContent = Math.round(zoom * 100) + '%';
        $('#drawing-shape-hint').textContent = message;
    } },
    tool(tool) {
        $('#service-drawing').hidden = tool !== 'service-route';
        $('#municipal-drawing').hidden = tool !== 'municipal';
        if (tool !== 'service-route')
            serviceDrawing = null;
        document.querySelectorAll('[data-tool]').forEach(button => { button.classList.toggle('active', button.dataset.tool === tool); button.setAttribute('aria-pressed', String(button.dataset.tool === tool)); });
        if ($('#decoration-placement'))
            $('#decoration-placement').hidden = tool !== 'furniture';
        if ($('#plan-ready'))
            $('#plan-ready').hidden = workspaceMode() !== 'plan' || !canDecorate() || tool !== 'select';
        $('#drawing-shape-status').hidden = !['circle', 'arc', 'boundary', 'floor-hole'].includes(tool);
        $('#civil-placement').hidden = tool !== 'civil';
        $('#plan-controls').hidden = project.drawing?.type !== 'plan' || viewMode === '3d' || workspaceMode() !== 'plan' || ['circle', 'arc', 'boundary', 'floor-hole'].includes(tool);
    }
});
const openingPositionInteraction = new OpeningPositionInteraction({
    project: () => project,
    selected: () => project.openings?.find(opening => opening.id === selectedOpeningId) || null,
    preview: previewOpening,
    commit: commitOpening,
    error: message => { openingFeedback(message, true); toast(message, true); },
    status: message => openingFeedback(message)
});
function isEditing() { return viewer.isEditing || !!threeViewer?.isEditing || openingPositionInteraction.isEditing; }
function cancelEditing() { viewer.cancel(); threeViewer?.cancel(); openingPositionInteraction.cancel(); }
function selectObject(kind, id, side) {
    const current = { region: selectedId, wall: selectedWallId, opening: selectedOpeningId, furniture: selectedFurnitureId, service: selectedServiceId, civil: selectedCivilId, municipal: selectedMunicipalId }[kind];
    if (isEditing() && (current !== id || id === null))
        cancelEditing();
    selectedId = kind === 'region' ? id : null;
    selectedWallId = kind === 'wall' ? id : null;
    selectedOpeningId = kind === 'opening' ? id : null;
    selectedFurnitureId = kind === 'furniture' ? id : null;
    selectedServiceId = kind === 'service' ? id : null;
    selectedCivilId = kind === 'civil' ? id : null;
    selectedMunicipalId = kind === 'municipal' ? id : null;
    if (kind === 'service' && id)
        decorationTab = 'services';
    selectedSurface = 'floor';
    // The inspector's priced side is the authority for selection and quantity.
    selectedWallSide = null;
    render();
}
async function switchWorkspace(mode) {
    if (mode === 'decoration' && !canDecorate()) {
        toast(project.planError ? String(project.planError) : '先画出闭合房间，或上传已有图纸，再开始装修。', true);
        return;
    }
    cancelEditing();
    closeCostWorkbench();
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = selectedCivilId = null;
    selectedMunicipalId = null;
    if ((mode === 'civil' || mode === 'municipal') && !project.drawing) {
        const drawing = await createMetricDrawing();
        if (mode === 'municipal') {
            drawing.name = '市政场地';
            drawing.width = 120000;
            drawing.height = 90000;
        }
        update(next => { next.drawing = drawing; next.walls = []; next.calibration = { metersPerPixel: .01, method: 'metric-plan' }; next.workspaceMode = mode; }, { history: false });
    }
    else
        update(next => next.workspaceMode = mode, { history: false });
    await switchView('2d');
    viewer.fit();
}
async function prepareMunicipalDrawing() {
    if (workspaceMode() !== 'municipal')
        await switchWorkspace('municipal');
    if (!project.calibration.metersPerPixel) {
        toast('先校准已有图纸，再绘制真实尺寸的市政设施。', true);
        return false;
    }
    if (project.drawing.type === 'plan' && (project.drawing.width < 120000 || project.drawing.height < 90000))
        update(next => { next.drawing.width = Math.max(next.drawing.width, 120000); next.drawing.height = Math.max(next.drawing.height, 90000); }, { history: false });
    await switchView('2d');
    cancelEditing();
    return true;
}
async function beginMunicipalDrawing(kind, catalogId, autoLayout = false) {
    if (!await prepareMunicipalDrawing())
        return;
    selectObject('municipal', null);
    let settings = {};
    if (catalogId) {
        const preset = municipalCatalogPreset(catalogId);
        settings = { catalogId, width: preset.width, depth: preset.depth, height: preset.height, elevation: preset.elevation, rotation: 0 };
    }
    else if (['road', 'bridge', 'intersection', 'roundabout'].includes(kind)) {
        settings = copy(municipalDraftSettings);
        // The untouched base tool has no user-selected width. Keep its standalone
        // preset, while allowing an actual connection port to supply its layout.
        if (['road', 'bridge'].includes(kind)) {
            if (autoLayout)
                settings = {};
            else if (!settings.roadLayout)
                delete settings.width;
        }
    }
    $('#municipal-drawing-name').textContent = catalogId ? municipalCatalogPreset(catalogId).name : municipalPreset(kind).name;
    viewer.beginMunicipalDrawing(kind, settings);
}
function createMunicipal(kind, points, patch = {}, placement = sitePlacement) {
    const item = patch.catalogId ? createMunicipalCatalogElement(patch.catalogId, points, project, patch) : createMunicipalElement(kind, points, project, patch);
    update(next => {
        (next.municipalElements ??= []).push(item);
        if (placement.mode === 'manual')
            Object.assign(next, setMunicipalElevation(next, item.id, placement.elevation));
        else if (next.municipalTerrain)
            Object.assign(next, alignMunicipalToTerrain(next, item.id, { follow: kind === 'road' }));
        selectedMunicipalId = item.id;
        selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedCivilId = selectedServiceId = null;
    });
    viewer.setTool('select');
    toast('市政设施已创建，填写单价与人工后实时计算预算');
}
async function quickMunicipal() {
    if (!await prepareMunicipalDrawing())
        return;
    showMunicipalQuickCreate(project, (kind, points, patch, placement) => { if (placement)
        sitePlacement = placement; createMunicipal(kind, points, patch, placement ?? sitePlacement); viewer.fit(); }, sitePlacement);
}
async function startMunicipalProject() {
    if (!await prepareMunicipalDrawing())
        return;
    showMunicipalStarter(project, elements => {
        update(next => { (next.municipalElements ??= []).push(...elements); selectedMunicipalId = elements[0]?.id ?? null; });
        viewer.setTool('select');
        viewer.fit();
    });
}
function carveSelectedRiver() {
    const river = project.municipalElements?.find(item => item.id === selectedMunicipalId);
    if (!river || river.kind !== 'river')
        return;
    if (river.locked)
        throw new Error('请先解锁河流。');
    const scale = project.calibration.metersPerPixel;
    if (!scale)
        throw new Error('请先校准图纸。');
    const path = river.points.map(point => ({ x: point.x * scale, y: point.y * scale })), width = river.width / 100, depth = river.depth / 100;
    const dialog = openDialog('沿河流生成地形河槽', `<form id="river-carve-form"><p class="help">河底目标高程 ${(river.elevation / 100 - depth).toFixed(2)} m，路径和河宽来自「${escape(river.name)}」。${project.municipalTerrain ? '修改当前地形，保留缺测区域。' : '自动建立覆盖河流的平地，再开槽。'}</p><label><span class="field-label">河岸边坡 1 : n</span><input name="bankSlope" type="number" min="0" max="10" step="any" value="1" required></label><p class="help">此操作用于概念地形塑形，可撤销。河槽只降低现状；缺测区域不会自动补高程。</p><button class="button primary full" type="submit">生成地形河槽</button></form>`);
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            const bankSlope = Number(new FormData(dialog.querySelector('form')).get('bankSlope'));
            const padding = width + depth * bankSlope + 10, minX = Math.max(0, Math.min(...path.map(p => p.x)) - padding), minY = Math.max(0, Math.min(...path.map(p => p.y)) - padding);
            const spanX = Math.max(...path.map(p => p.x)) + padding - minX, spanY = Math.max(...path.map(p => p.y)) + padding - minY;
            const terrain = project.municipalTerrain ?? createTerrainGrid({ width: spanX, length: spanY, cellSize: Math.max(.5, Math.ceil(Math.max(spanX, spanY) / 80)), baseElevation: 0, relief: 0, preset: 'flat', originX: minX, originY: minY });
            const carved = carveTerrainRiver(terrain, path, { width, depth, bankSlope, bedElevation: river.elevation / 100 - depth });
            update(next => next.municipalTerrain = carved);
            dialog.close();
            toast('河槽已写入真实地形高程，可撤销');
        }
        catch (error) {
            toast(error.message, true);
        }
    });
}
async function beginCivilPlacement(kind) {
    if (workspaceMode() !== 'civil')
        await switchWorkspace('civil');
    if (!project.calibration.metersPerPixel) {
        toast('先校准图纸比例，再按真实尺寸放置构件。', true);
        return;
    }
    await switchView('2d');
    cancelEditing();
    selectObject('civil', null);
    const template = createCivilElement(kind, { x: 0, y: 0 }, project);
    $('#civil-placement-name').textContent = civilPreset(kind).name;
    viewer.beginCivilPlacement(template);
}
function placeCivil(kind, position) {
    const item = createCivilElement(kind, position, project);
    update(next => { (next.civilElements ??= []).push(item); selectedCivilId = item.id; });
    viewer.setTool('select');
    toast('构件已放置，拖动边框或输入尺寸，再填写单价');
}
function civilTemplate() {
    cancelEditing();
    if (!project.calibration.metersPerPixel) {
        toast('请先校准图纸比例。', true);
        return;
    }
    showCivilTemplate(project, config => {
        const items = generateCivilLayout(project, config);
        update(next => { (next.civilElements ??= []).push(...items); selectedCivilId = items[0]?.id ?? null; });
        viewer.fit();
        if (viewMode === '3d')
            threeViewer?.fit();
        return items.length;
    });
}
function configureNewStair(item) {
    if (!isStairKind(item.kind) || !project.levels?.length)
        return;
    const current = activeLevel(project), target = project.levels.find(level => level.elevation > current.elevation);
    if (target) {
        item.stairTargetLevelId = target.id;
        item.height = target.elevation - current.elevation - (item.mountHeight ?? 0);
    }
}
function syncStairHeight(next, item) {
    if (!item.stairTargetLevelId)
        return;
    const base = activeLevel(next), target = next.levels?.find(level => level.id === item.stairTargetLevelId);
    if (!target)
        throw new Error('请选择有效的楼梯目标层。');
    const height = target.elevation - base.elevation - (item.mountHeight ?? 0);
    if (item.locked && Math.abs(height - item.height) > 1e-6)
        throw new Error('楼梯已锁定，请先解锁再改变升高。');
    item.height = height;
}
async function changeActiveLevel(id) {
    if (!project.levels || id === project.activeLevelId)
        return;
    cancelEditing();
    closeCostWorkbench();
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = selectedCivilId = null;
    selectedSurface = 'floor';
    update(next => Object.assign(next, switchLevel(next, id)));
    viewer.fit();
    if (viewMode === '3d')
        threeViewer?.fit();
    toast(`正在设计${activeLevel(project).name}`);
}
function manageLevels() {
    cancelEditing();
    if (!project.levels)
        update(next => Object.assign(next, ensureLevels(next)), { history: false });
    showLevelManager(project, (kind, id, values) => {
        cancelEditing();
        update(next => Object.assign(next, kind === 'add' ? addLevel(next, values) : kind === 'edit' ? updateLevel(next, id, values) : deleteLevel(next, id)));
        selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = null;
        selectedSurface = 'floor';
        render();
        viewer.fit();
        if (viewMode === '3d')
            threeViewer?.fit();
        toast(kind === 'add' ? '楼层已添加，开始画本层户型' : kind === 'edit' ? '楼层设置已更新' : '楼层已删除，可撤销恢复');
    });
}
function placeFurniture(kind, position) {
    const template = FURNITURE_TEMPLATES.find(item => item.kind === kind);
    if (!template || !project.drawing)
        throw new Error('请选择有效的家具预设，并先准备图纸。');
    const item = { ...template, id: newId('furniture'), position, rotation: 0, quantity: '1', unitPrice: '', additionalCost: '0' };
    configureNewStair(item);
    const placement = fixtureWallPlacement(item, position, project);
    item.rotation = placement.rotation;
    item.position = clampFurniturePosition(item, placement.position, project);
    update(next => { (next.furniture ??= []).push(item); selectedId = selectedWallId = selectedOpeningId = selectedServiceId = null; selectedFurnitureId = item.id; selectedWallSide = null; });
    toast(`${item.name}已放置，在右侧填写单价`);
}
async function beginFurniturePlacement(kind) {
    if (workspaceMode() !== 'decoration')
        await switchWorkspace('decoration');
    if (workspaceMode() !== 'decoration')
        return;
    cancelEditing();
    await switchView('2d');
    const template = FURNITURE_TEMPLATES.find(item => item.kind === kind);
    if (!template)
        return;
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = null;
    decorationTab = 'fixtures';
    render();
    viewer.beginFurniturePlacement(template);
    $('#decoration-placement-name').textContent = template.name;
}
async function beginServiceDrawing(presetId, replacingId) {
    if (!project.drawing)
        throw new Error('请先画户型或上传图纸。');
    const scale = project.drawing.type === 'plan' ? .01 : project.calibration.metersPerPixel;
    if (!scale) {
        toast('先校准图纸比例，再绘制实际线路。', true);
        calibrations();
        return;
    }
    const preset = servicePreset(presetId), previous = project.serviceRoutes?.find(route => route.id === replacingId);
    if (workspaceMode() !== 'decoration')
        await switchWorkspace('decoration');
    if (workspaceMode() !== 'decoration')
        return;
    cancelEditing();
    await switchView('2d');
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = null;
    decorationTab = 'services';
    render();
    serviceDrawing = { presetId, replacingId };
    viewer.setTool('service-route');
    $('#service-drawing-name').textContent = previous ? '重新绘制 ' + previous.name : preset.name;
    $('#service-draw-height').value = String(previous?.points[0]?.z ?? preset.defaultHeight);
}
async function addFurniture() {
    if (!project.drawing) {
        toast('请先画平面图或上传图纸。', true);
        return;
    }
    cancelEditing();
    await switchView('2d');
    showFurniturePicker(kind => {
        const template = FURNITURE_TEMPLATES.find(item => item.kind === kind);
        const region = selectedRegion();
        const center = region ? regionInteriorPoint(region) : viewer.toWorld({ x: $('#stage').clientWidth / 2, y: $('#stage').clientHeight / 2 });
        const item = { ...template, id: newId('furniture'), position: center, rotation: 0, quantity: '1', unitPrice: '', additionalCost: '0' };
        configureNewStair(item);
        item.position = clampFurniturePosition(item, center, project);
        const placement = fixtureWallPlacement(item, center, project);
        item.position = placement.position;
        item.rotation = placement.rotation;
        update(next => { (next.furniture ??= []).push(item); selectedId = selectedWallId = selectedOpeningId = selectedServiceId = null; selectedFurnitureId = item.id; selectedWallSide = null; });
        toast('家具已添加，拖动摆放并在右侧填写单价');
    });
}
function update(mutator, options = {}) {
    const next = copy(project);
    const selection = { selectedId, selectedWallId, selectedOpeningId, selectedFurnitureId, selectedServiceId, selectedCivilId, selectedMunicipalId, selectedWallSide, selectedSurface };
    try {
        mutator(next);
        syncMunicipalEngineering(next, project);
        syncLinkedStairOpenings(next);
        if (next.workspaceMode === 'decoration' && !canDecorate(next))
            next.workspaceMode = 'plan';
        const boundary = validateProjectBoundary(next);
        if (!boundary.valid)
            throw new Error(boundary.error);
        validateWallShapes(next);
        validateOpenings(next);
        validateLevels(next);
        validateProjectBudgetOptions(next.budget);
        calculateProject(next);
        calculateCivilProject(next);
        validateMunicipalProject(next);
    }
    catch (error) {
        ({ selectedId, selectedWallId, selectedOpeningId, selectedFurnitureId, selectedServiceId, selectedCivilId, selectedMunicipalId, selectedWallSide, selectedSurface } = selection);
        throw error;
    }
    project = next;
    if (options.history === false)
        history.replace(project);
    else
        history.push(project);
    render(options);
    scheduleSave();
}
function changeWalls(mutator) {
    let notice;
    const hadRooms = project.regions.some(r => r.source === 'walls');
    update(next => {
        next.walls ||= [];
        mutator(next);
        next.walls = normalizeWalls(next.walls);
        if (next.drawing?.type === 'plan' && next.walls.some(w => [w.start, w.end].some(p => p.x < 0 || p.y < 0 || p.x > next.drawing.width || p.y > next.drawing.height)))
            throw new Error('墙线超出当前画板范围，请缩短墙长或调整位置。');
        const previous = [...next.regions, ...(next.wallRegionCache || []).filter(old => !next.regions.some(region => region.id === old.id))];
        const rebuilt = rebuildWallRegions(next.walls, previous, undefined, next.wallJoinStyle ?? 'square');
        next.regions = rebuilt.regions;
        next.wallRegionCache = rebuilt.cache;
        next.planError = rebuilt.error;
        notice = rebuilt.notice;
        if (selectedId && !next.regions.some(r => r.id === selectedId))
            selectedId = null;
        if (selectedWallId && !next.walls.some(w => w.id === selectedWallId))
            selectedWallId = null;
    });
    if (!hadRooms && project.regions.some(r => r.source === 'walls'))
        viewer.fit();
    if (notice)
        toast(notice);
}
function applyBoundary(points) {
    if (project.drawing?.type !== 'plan')
        throw new Error('请先新建二维平面图。');
    const checked = validatePlanBoundary(points ? { points } : null);
    if (!checked.valid)
        throw new Error(checked.error);
    if (points?.some(point => point.x < 0 || point.y < 0 || point.x > project.drawing.width || point.y > project.drawing.height))
        throw new Error('边界必须位于当前画板内。');
    update(next => next.planBoundary = points ? { points: copy(points) } : null);
    toast(points ? '绘图边界已设置，墙体和编辑会检查越界' : '边界已清除，可使用整个画板');
}
function addDrawingShape(shape, dimensions, replacingId) {
    if (project.drawing?.type !== 'plan')
        throw new Error('请先新建二维平面图。');
    if (shape.points.some(point => point.x < 0 || point.y < 0 || point.x > project.drawing.width || point.y > project.drawing.height))
        throw new Error('圆或圆弧超出当前画板，请调整圆心和半径。');
    const previous = project.wallShapes?.find(value => value.id === replacingId);
    if (previous && project.openings?.some(opening => previous.wallIds.includes(opening.wallId)))
        throw new Error('此组墙上已有门窗，请先移除开口再调整圆弧。');
    const thickness = dimensions?.thickness ?? Number(project.wallThickness || 20), height = dimensions?.height ?? Number(project.wallHeight || 280);
    const wallIds = Array.from({ length: shape.segmentCount }, (_, i) => previous?.wallIds[i] || newId('wall'));
    const group = { id: previous?.id || newId('wall-shape'), kind: shape.kind, name: previous?.name || `${shape.kind === 'circle' ? '圆形墙' : '圆弧墙'} ${String((project.wallShapes?.length || 0) + 1).padStart(2, '0')}`, wallIds, center: shape.center, radius: shape.radius, startDegrees: shape.startDegrees, sweepDegrees: shape.sweepDegrees, maxDeviation: shape.maxDeviation, items: previous?.items || [], finishSide: previous?.finishSide || 'both', additionalCost: previous?.additionalCost || '0' };
    changeWalls(next => {
        next.wallJoinStyle = 'clean';
        if (previous)
            next.walls = next.walls.filter(wall => !previous.wallIds.includes(wall.id));
        next.walls.push(...wallIds.map((id, i) => ({ id, start: shape.points[i], end: shape.points[(i + 1) % shape.points.length], thickness, height, items: [] })));
        next.wallShapes = [...(next.wallShapes || []).filter(value => value.id !== replacingId), group];
    });
    selectedId = selectedOpeningId = selectedFurnitureId = selectedServiceId = null;
    selectedWallId = wallIds[0];
    selectedWallSide = null;
    render();
    toast(previous ? '整组曲线墙已更新，面积与报价同步计算' : '曲线墙已生成，可按整组选材与报价');
}
function createParametricShape(value, replacingId) {
    const previous = project.wallShapes?.find(shape => shape.id === replacingId);
    const budget = 200 - (project.walls?.length || 0) + (previous?.wallIds.length || 0);
    const shape = value.kind === 'circle' ? makeCircle(value.center, value.radius, { maxSegments: budget }) : makeArc(value.center, value.radius, value.startDegrees, value.sweepDegrees, { maxSegments: budget });
    addDrawingShape(shape, value, replacingId);
}
async function startPlan() {
    if (uploading || !await leaveCurrent())
        return;
    const drawing = await createMetricDrawing();
    const next = freshProject();
    next.name = '我的平面图';
    next.drawing = drawing;
    next.walls = [];
    next.wallThickness = 20;
    next.wallHeight = 280;
    next.calibration = { metersPerPixel: .01, method: 'metric-plan' };
    activate(next);
    savedSignature = '';
    $('#dialog').close();
    viewer.setTool('wall');
    scheduleSave();
    toast('先放置墙角，或直接输入第一段墙的长度');
}
function roomTemplate() {
    if (project.drawing?.type !== 'plan') {
        toast('请先点击“开始画平面图”。');
        return;
    }
    showRoomTemplate((name, width, depth, thickness, height) => {
        if (!name || ![width, depth, thickness, height].every(Number.isFinite) || width < .1 || depth < .1 || thickness < 1 || thickness > 100 || height < 50 || height > 1000)
            throw new Error('请输入有效的净尺寸、墙高与墙厚。');
        cancelEditing();
        const centerWidth = width * 100 + thickness, centerDepth = depth * 100 + thickness;
        const local = [{ x: 0, y: 0 }, { x: centerWidth, y: 0 }, { x: centerWidth, y: centerDepth }, { x: 0, y: centerDepth }];
        const origin = findRoomPlacement(local, project.regions, project.drawing.width - 100, project.drawing.height - 100);
        // Keep separate templates clear of the footprint of an existing wall.
        const bounds = project.walls?.flatMap(w => [w.start, w.end]) || [];
        if (bounds.length) {
            origin.x = Math.max(...bounds.map(p => p.x)) + thickness + 40;
            origin.y = Math.min(...bounds.map(p => p.y));
        }
        const points = local.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
        if (points.some(p => p.x > project.drawing.width - 20 || p.y > project.drawing.height - 20))
            throw new Error('当前画板空间不足，请缩小房间尺寸。');
        const before = new Set(project.regions.map(r => r.id));
        changeWalls(next => { next.wallThickness = thickness; next.wallHeight = height; points.forEach((point, i) => next.walls.push({ id: newId('wall'), start: point, end: points[(i + 1) % points.length], thickness, height })); });
        const room = project.regions.find(r => !before.has(r.id));
        if (!room)
            throw new Error(String(project.planError || '未能生成房间，请检查墙线。'));
        update(next => next.regions.find(r => r.id === room.id).name = name);
        selectedId = room.id;
        selectedWallId = null;
        viewer.setSelectedWall(null);
        render();
        viewer.fit();
        if (viewMode === '3d')
            threeViewer?.fit();
        toast('房间已生成，点击添加材料开始报价');
    }, { thickness: Number(project.wallThickness || 20), height: Number(project.wallHeight || 280) });
}
async function switchView(mode) {
    const request = ++viewRequest;
    const entering3D = mode === '3d' && viewMode !== '3d';
    if (mode === '3d' && project.drawing?.type !== 'plan') {
        toast('先按真实尺寸绘制墙体，再查看三维模型。');
        return;
    }
    if (mode !== viewMode) {
        threeViewer?.cancel();
        openingPositionInteraction.cancel();
        if (mode === '2d')
            cancelEditing();
    }
    if (mode === '2d') {
        viewMode = '2d';
        threeViewer?.setVisible(false);
        render();
        return;
    }
    viewer.finishWalls();
    viewer.setTool('select');
    if (!threeViewer) {
        $('#view-switch').setAttribute('aria-busy', 'true');
        toast('正在准备三维视图…');
        if (!loading3D)
            loading3D = (async () => {
                const { Viewer3D } = await import('./viewer3d.js');
                threeViewer = new Viewer3D($('#viewer3d'), {
                    selectWall(id, side) { selectObject('wall', id, side); },
                    selectRegion(id) { selectObject('region', id); },
                    selectOpening(id) { selectObject('opening', id); },
                    previewOpening,
                    commitOpening,
                    selectFurniture(id) { selectObject('furniture', id); },
                    selectServiceRoute(id) { selectObject('service', id); },
                    selectCivilElement(id) { selectObject('civil', id); },
                    selectMunicipalElement(id) { selectObject('municipal', id); },
                    async selectLevel(id) { await changeActiveLevel(id); },
                    selectCeiling(id) { selectObject('region', id); selectedSurface = 'ceiling'; render(); },
                    error(message) { toast(message, true); },
                    status(message) { if (viewMode === '3d')
                        $('#canvas-hint').textContent = message; }
                });
            })();
        try {
            await loading3D;
        }
        catch (error) {
            loading3D = null;
            toast('三维视图暂时无法打开：' + error.message, true);
            return;
        }
        finally {
            $('#view-switch').removeAttribute('aria-busy');
        }
    }
    if (request !== viewRequest || project.drawing?.type !== 'plan')
        return;
    try {
        viewMode = '3d';
        threeViewer.setCutaway(cutaway);
        render();
        if (viewMode === '3d') {
            threeViewer.setVisible(true);
            threeViewer.fit();
            if (entering3D && workspaceMode() === 'municipal' && project.municipalElements?.find(item => item.id === selectedMunicipalId)?.kind === 'road')
                threeViewer.inspectMunicipalElement(selectedMunicipalId);
        }
    }
    catch (error) {
        viewMode = '2d';
        threeViewer?.setVisible(false);
        render();
        toast('三维视图暂时无法打开：' + error.message, true);
    }
}
function wallDefaults() {
    if (project.drawing?.type !== 'plan') {
        toast('请先创建平面图。');
        return;
    }
    const dialog = openDialog('统一墙体尺寸', `<form id="wall-defaults-form"><div class="field-grid"><label><span class="field-label">墙高（m）</span><input id="default-wall-height" type="number" name="height" min="0.5" max="10" step="any" value="${Number(project.wallHeight || 280) / 100}" required></label><label><span class="field-label">墙宽 / 厚度（cm）</span><input id="default-wall-thickness" type="number" name="thickness" min="1" max="100" step="any" value="${Number(project.wallThickness || 20)}" required></label></div><label class="checkbox-label"><input id="apply-wall-dimensions" name="apply" type="checkbox" checked> 同时应用到已有墙体</label><p class="help">以后画的墙会使用这些尺寸。墙高改变三维高度；墙厚会更新地面净面积和报价。</p><button class="button primary full" type="submit">应用尺寸</button></form>`, { subtitle: '统一设置一次，也可以点击单面墙分别修改。' });
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            const values = new FormData(dialog.querySelector('form'));
            const height = Number(values.get('height')) * 100, thickness = Number(values.get('thickness'));
            if (![height, thickness].every(Number.isFinite) || height < 50 || height > 1000 || thickness < 1 || thickness > 100)
                throw new Error('墙高支持 0.5–10 m，墙厚支持 1–100 cm。');
            cancelEditing();
            const mutate = (next) => { next.wallHeight = height; next.wallThickness = thickness; if (values.has('apply'))
                next.walls = next.walls.map(wall => ({ ...wall, height, thickness })); };
            if (values.has('apply'))
                changeWalls(mutate);
            else
                update(mutate);
            dialog.close();
            toast(values.has('apply') ? '墙体尺寸已统一更新，可撤销' : '新墙默认尺寸已保存');
        }
        catch (error) {
            toast(error.message, true);
        }
    });
}
async function capture3D() {
    if (!threeViewer || viewMode !== '3d')
        return;
    try {
        const blob = await threeViewer.capturePNG();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = project.name.replace(/[\\/:*?"<>|]/g, '_') + '-3D.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast('三维视图已导出为 PNG');
    }
    catch (error) {
        toast(error.message, true);
    }
}
function render({ inspector = true } = {}) {
    if (selectedServiceId && !project.serviceRoutes?.some(route => route.id === selectedServiceId))
        selectedServiceId = null;
    if (selectedCivilId && !project.civilElements?.some(item => item.id === selectedCivilId))
        selectedCivilId = null;
    if (workspaceMode() !== 'civil')
        selectedCivilId = null;
    if (workspaceMode() !== 'municipal' || !project.municipalElements?.some(item => item.id === selectedMunicipalId))
        selectedMunicipalId = null;
    quote = computeQuote(project);
    const displayProject = renderProject();
    const decorating = workspaceMode() === 'decoration';
    const civil = workspaceMode() === 'civil';
    const municipal = workspaceMode() === 'municipal';
    const leftScroll = $('#left-panel').scrollTop;
    $('#left-panel').innerHTML = municipal ? renderRoadAuthoring(municipalDraftSettings) + renderSitePlacement(project, sitePlacement) + renderMunicipalLeft(project, selectedMunicipalId, quote, municipalCategory, municipalCatalogSearch, municipalCatalogGroup) + renderMunicipalProgress(project, quote) + renderMunicipalEngineering(project) : civil ? renderCivilLeft(displayProject, selectedCivilId, quote, civilCategory) : renderIncomingStairList(project) + (decorating ? renderDecorationTabs(decorationTab) + (decorationTab === 'services' ? renderServiceLeft(displayProject, selectedServiceId, quote, serviceSystem, serviceSearch) : renderDecorationLeft(displayProject, selectedFurnitureId, selectedId, quote, decorationCategory)) : renderLeft(displayProject, selectedId, selectedWallId, quote, selectedFurnitureId, renderPlanTools(project)));
    $('#left-panel').scrollTop = leftScroll;
    const region = selectedRegion();
    const nativePlan = project.drawing?.type === 'plan';
    if (!nativePlan && viewMode === '3d') {
        viewMode = '2d';
        threeViewer?.setVisible(false);
    }
    const activeWall = selectedWall();
    const activeShape = selectedWallShape();
    const activeOpening = project.openings?.find(o => o.id === selectedOpeningId);
    const openingWallQuote = activeOpening ? quote.walls?.find(wall => wall.id === (project.wallShapes?.find(shape => shape.wallIds.includes(activeOpening.wallId))?.id || activeOpening.wallId)) : null;
    const activeFurniture = project.furniture?.find(item => item.id === selectedFurnitureId);
    const activeService = project.serviceRoutes?.find(route => route.id === selectedServiceId);
    const activeCivil = selectedCivil();
    const activeMunicipal = project.municipalElements?.find(item => item.id === selectedMunicipalId);
    const municipalQuote = quote.municipalElements?.find(row => row.id === selectedMunicipalId);
    const civilQuote = quote.civilElements?.find(row => row.id === selectedCivilId);
    const serviceQuote = quote.serviceRoutes?.find(row => row.id === selectedServiceId);
    const furnitureQuote = quote.furniture?.find(item => item.id === selectedFurnitureId);
    const regionalQuote = selectedSurface === 'ceiling' ? quote.ceilings?.find(row => row.sourceRegionId === selectedId) : quote.regions.find(r => r.id === selectedId);
    const displayRegion = displayProject.regions.find(row => row.id === selectedId) || region;
    const inspectorProject = { ...displayProject, floorOpenings: project.floorOpenings };
    if (inspector) {
        const panel = $('#inspector');
        panel.innerHTML = municipal ? activeMunicipal ? renderMunicipalInspector(project, activeMunicipal, municipalQuote) : renderMunicipalGuide(project, quote) : civil ? activeCivil ? renderCivilInspector(project, activeCivil, civilQuote) : renderCivilGuide(project, quote) : activeService ? renderServiceInspector(project, activeService, serviceQuote) : activeFurniture ? renderFurnitureInspector(project, activeFurniture, furnitureQuote) + renderStairConnection(project, activeFurniture) : activeOpening ? renderOpeningInspector(project, activeOpening, openingWallQuote) : activeShape ? renderWallShapeInspector(project, activeShape, materials, selectedWallQuote()) : activeWall ? renderWallInspector(activeWall, Number(project.wallHeight || 280), displayProject, materials, selectedWallQuote()) : decorating && !region ? decorationTab === 'services' ? renderServiceGuide() : renderDecorationGuide(project, quote) : nativePlan && !region ? renderPlanGuide(project, viewMode) : region && nativePlan ? renderSurfaceTabs(selectedSurface) + (selectedSurface === 'ceiling' ? renderCeilingInspector(displayProject, displayRegion, materials, regionalQuote) : renderInspector(inspectorProject, displayRegion, materials, regionalQuote) + renderFloorOpenings(project, region)) : renderInspector(inspectorProject, displayRegion, materials, regionalQuote);
        const inspectorKey = (selectedMunicipalId || selectedCivilId || selectedServiceId || selectedFurnitureId || selectedOpeningId || selectedWallId || selectedId || workspaceMode() + decorationTab) + selectedSurface;
        if (inspectorSelection !== inspectorKey) {
            panel.scrollTop = 0;
            if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
                panel.animate([{ opacity: .7, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' });
            inspectorSelection = inspectorKey;
        }
    }
    else if (activeMunicipal)
        updateMunicipalNumbers(project, activeMunicipal, municipalQuote);
    else if (activeOpening)
        updateOpeningInspectorNumbers(project, activeOpening, openingWallQuote);
    else if (activeCivil)
        updateCivilNumbers(activeCivil, civilQuote);
    else if (activeService)
        updateServiceNumbers(project, activeService, serviceQuote);
    else if (activeFurniture) {
        for (const key of ['width', 'depth', 'height', 'rotation', 'mountHeight']) {
            const input = $('#furniture-' + key);
            if (input && document.activeElement !== input)
                input.value = String(activeFurniture[key] ?? 0);
        }
        const total = $('[data-stat="furniture-total"]');
        if (total)
            total.textContent = furnitureQuote?.pending ? '待填单价' : '¥ ' + money(furnitureQuote?.total);
        if (isStairKind(activeFurniture.kind)) {
            const height = $('#furniture-height');
            if (height && document.activeElement !== height)
                height.value = String(activeFurniture.height);
            const target = $('#stair-target');
            if (target)
                target.value = activeFurniture.stairTargetLevelId ?? '';
            const match = $('[data-action="auto-stair-hole"]');
            if (match) {
                match.disabled = !!activeFurniture.locked || !activeFurniture.stairTargetLevelId;
                match.lastChild.textContent = activeFurniture.stair?.autoOpening && activeFurniture.stairTargetLevelId ? '更新匹配楼梯口' : '自动匹配楼梯口';
            }
            const actions = $('.stair-match-actions');
            if (actions)
                actions.hidden = !activeFurniture.stair?.autoOpening || !activeFurniture.stairTargetLevelId;
        }
    }
    else
        updateInspectorNumbers(activeWall ? selectedWallQuote() : regionalQuote);
    const sourceTarget = activeMunicipal ? ['municipal', activeMunicipal.id] : activeCivil ? ['civil', activeCivil.id] : activeService ? ['service', activeService.id] : activeFurniture ? ['furniture', activeFurniture.id] : activeOpening ? ['opening', activeOpening.id] : activeShape ? ['wall', activeShape.id] : activeWall ? ['wall', activeWall.id] : region ? [selectedSurface === 'ceiling' ? 'ceiling' : 'region', region.id] : null;
    const sourceRows = sourceTarget ? collectProjectSourceRows(project).filter(row => row.targetType === sourceTarget[0] && row.targetId === sourceTarget[1] && (row.section === 'municipal' || !project.levels || row.levelId === project.activeLevelId)) : [];
    const sourceHTML = renderProjectPriceSources(sourceRows, materials);
    if (inspector || sourceHTML !== priceSourceInspectorHTML) {
        $('#inspector .price-source-inspector')?.remove();
        $('#inspector').insertAdjacentHTML('beforeend', sourceHTML);
        priceSourceInspectorHTML = sourceHTML;
    }
    viewer.setProject(displayProject, selectedId);
    viewer.setSelectedWall(selectedWallId, selectedWallSide);
    viewer.setSelectedWallGroup(activeShape?.wallIds || []);
    viewer.setSelectedOpening(selectedOpeningId);
    viewer.setSelectedFurniture(selectedFurnitureId);
    viewer.setSelectedService(selectedServiceId);
    viewer.setSelectedCivil(selectedCivilId);
    viewer.setSelectedMunicipal(selectedMunicipalId);
    $('#drawing-canvas').hidden = viewMode === '3d';
    $('#viewer3d').hidden = viewMode !== '3d';
    $('#canvas-tools').hidden = viewMode === '3d';
    $('#three-tools').hidden = viewMode !== '3d';
    $('#view-switch').hidden = !nativePlan;
    $('#wall-defaults').hidden = !nativePlan || civil || municipal;
    $('#level-switcher').innerHTML = renderLevelSwitcher(project);
    $('#level-switcher').hidden = !nativePlan || municipal;
    $('#show-all-levels').hidden = !project.levels?.length || municipal;
    $('#show-all-levels').textContent = project.view.levelMode === 'active' ? '查看全部楼层' : '只看当前层';
    $('#show-ceilings').textContent = project.view.ceilings ? '隐藏天花板' : '显示天花板';
    $('#show-ceilings').setAttribute('aria-pressed', String(!!project.view.ceilings));
    document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === viewMode); button.setAttribute('aria-pressed', String(button.dataset.view === viewMode)); });
    $('#stage').classList.toggle('view-is-3d', viewMode === '3d');
    document.body.classList.toggle('decoration-mode', decorating);
    document.body.classList.toggle('civil-mode', civil);
    document.body.classList.toggle('municipal-mode', municipal);
    document.querySelectorAll('[data-workspace]').forEach(button => { button.classList.toggle('active', button.dataset.workspace === workspaceMode()); button.setAttribute('aria-pressed', String(button.dataset.workspace === workspaceMode())); if (button.dataset.workspace === 'decoration') {
        button.disabled = !canDecorate();
        button.title = canDecorate() ? '进入装修，摆放家具和填写价格' : '先画出闭合房间或上传图纸';
    } });
    $('#plan-ready').hidden = decorating || civil || municipal || !canDecorate() || viewer.tool !== 'select';
    $('#decoration-placement').hidden = viewer.tool !== 'furniture';
    $('#civil-placement').hidden = viewer.tool !== 'civil';
    $('#municipal-drawing').hidden = viewer.tool !== 'municipal';
    $('#service-drawing').hidden = viewer.tool !== 'service-route';
    if (threeViewer && viewMode === '3d') {
        try {
            threeViewer.setProject(displayProject, selectedId, selectedWallId, selectedOpeningId, selectedWallSide);
            threeViewer.setSelectedWallGroup(activeShape?.wallIds || []);
            threeViewer.setSelectedFurniture?.(selectedFurnitureId);
            threeViewer.setSelectedServiceRoute?.(selectedServiceId);
            threeViewer.setSelectedCivilElement?.(selectedCivilId);
            threeViewer.setSelectedMunicipalElement(selectedMunicipalId);
        }
        catch (error) {
            viewMode = '2d';
            threeViewer.setVisible(false);
            render({ inspector });
            toast('三维模型未更新：' + error.message, true);
            return;
        }
        $('#zoom').textContent = '3D';
        $('#canvas-hint').textContent = municipal ? '拖动旋转 · 右键平移 · 滚轮缩放 · 点击选择市政设施' : civil ? '拖动旋转 · 右键平移 · 滚轮缩放 · 点击选择构件' : '拖动旋转 · 右键平移 · 滚轮缩放 · 点击墙体或房间';
    }
    $('#empty-state').hidden = !!project.drawing;
    $('#drawing-name').textContent = project.drawing ? project.drawing.name + (project.drawing.type === 'pdf' ? ` · 第 ${project.drawing.page} 页` : '') : '图纸工作台';
    $('#drawing-resolution').textContent = nativePlan ? '按米绘制 · 自动吸附' : project.drawing ? `${project.drawing.width} × ${project.drawing.height} px` : '';
    $('#plan-controls').hidden = !nativePlan || viewMode === '3d' || decorating || civil || municipal || viewer.tool.startsWith('floor-hole') || ['circle', 'arc', 'boundary'].includes(viewer.tool);
    $('#plan-notice').hidden = !nativePlan || municipal || !project.planError;
    $('#plan-notice').textContent = String(project.planError || '');
    $('#stage').classList.toggle('metric-plan', nativePlan);
    for (const tool of ['wall', 'rectangle', 'circle', 'arc', 'boundary'])
        $(`[data-tool="${tool}"]`).hidden = !nativePlan || decorating || civil || municipal;
    for (const tool of ['polygon', 'hole'])
        $(`[data-tool="${tool}"]`).hidden = nativePlan || decorating || civil || municipal;
    $('[data-tool="calibrate"]').hidden = nativePlan;
    $('#recognize').hidden = nativePlan || decorating || civil || municipal;
    $('#recognize-divider').hidden = nativePlan || decorating || civil || municipal;
    $('#pdf-pages').hidden = project.drawing?.type !== 'pdf';
    $('#pdf-pages').textContent = project.drawing?.type === 'pdf' ? `第 ${project.drawing.page} / ${project.drawing.pages} 页` : '';
    const calibrated = !!project.calibration.metersPerPixel;
    $('#calibration-status').textContent = nativePlan ? '真实尺寸绘图' : calibrated ? '比例已校准' : '校准图纸比例';
    $('#calibration').classList.toggle('calibrated', calibrated);
    const metrics = quote.regions || [];
    $('#total-area').textContent = !metrics.length ? '—' : calibrated ? measure(metrics.reduce((sum, m) => sum + m.netArea, 0)) : '待校准';
    const hasQuoteItems = quote.regions.length || quote.walls?.some(w => w.items?.length) || quote.ceilings?.some(row => row.items.length) || quote.furniture?.length || quote.serviceRoutes?.length || quote.openings?.length;
    $('#material-cost').textContent = hasQuoteItems ? money(quote.materialCost) : '—';
    $('#labor-cost').textContent = hasQuoteItems ? money(quote.laborCost) : '—';
    $('#total-cost').textContent = hasQuoteItems ? money(quote.total) : '—';
    const partialQuote = hasQuoteItems && quote.pending;
    $('#quote-total-label').textContent = partialQuote ? '已填写金额（税前）' : '预计总报价';
    if (partialQuote) {
        $('#total-cost').textContent = money(quote.knownSubtotal);
        $('#material-cost').textContent = money(quote.knownMaterialCost);
        $('#labor-cost').textContent = money(quote.knownLaborCost);
    }
    const quotedWallCount = (project.walls?.filter(wall => wall.items?.length).length || 0) + (project.wallShapes?.filter(shape => shape.items.length).length || 0);
    $('#quote-status').textContent = project.planError ? String(project.planError) : !project.drawing ? '准备好，开始你的项目' : !project.regions.length && !project.furniture?.length && !project.serviceRoutes?.length && !quote.openings?.length && !quotedWallCount ? nativePlan ? '墙线闭合后自动生成房间' : '圈选第一个区域，开始材料选配' : quote.pending ? quote.pendingReason || '报价配置尚未完成' : [...(project.regions.length ? [`${project.regions.length} 个地面区域`] : []), ...(quotedWallCount ? [`${quotedWallCount} 组墙材`] : []), ...(project.furniture?.length ? [`${project.furniture.length} 组设备 / 家具`] : []), ...(project.serviceRoutes?.length ? [`${project.serviceRoutes.length} 条管线`] : []), ...(quote.openings?.length ? [`${quote.openings.length} 项门窗 / 开孔报价`] : []), '已实时计算'].join(' · ');
    if (project.levels?.length > 1)
        $('#quote-status').textContent = `${project.levels.length} 层预算 · ${quote.pending ? quote.pendingReason : '已实时计算'}`;
    $('#total-area').closest('.summary-metric').querySelector('span').textContent = project.levels?.length > 1 ? '全楼层净面积' : '地面净面积';
    $('#total-area').closest('.summary-metric').querySelector('small').textContent = 'm²';
    $('#material-cost').closest('.summary-metric').querySelector('span').textContent = '材料 / 家具费';
    if (civil) {
        const hasElements = Boolean(quote.civilElements?.length);
        $('#total-area').closest('.summary-metric').querySelector('span').textContent = project.levels?.length > 1 ? '全楼层净体积' : '构件净体积';
        $('#total-area').closest('.summary-metric').querySelector('small').textContent = 'm³';
        $('#material-cost').closest('.summary-metric').querySelector('span').textContent = '材料 / 模板 / 钢筋';
        $('#total-area').textContent = hasElements ? measure(quote.netVolume, 3) : '—';
        $('#material-cost').textContent = hasElements ? money([quote.knownMaterialCost, quote.knownFormworkCost, quote.knownRebarCost].reduce((sum, value) => addDecimal(sum, value || '0'), '0')) : '—';
        $('#labor-cost').textContent = hasElements ? money(quote.pending ? quote.knownLaborCost : quote.laborCost) : '—';
        $('#total-cost').textContent = hasElements ? money(quote.pending ? quote.knownSubtotal : quote.total) : '—';
        $('#quote-total-label').textContent = quote.pending ? '已填写金额（税前）' : '土建总预算';
        $('#quote-status').textContent = !hasElements ? '选择构件放置，或按尺寸生成框架' : quote.pending ? `${quote.civilElements.filter(row => row.pending).length} 组待配置 · 点击总价查看明细` : `${quote.civilElements.length} 组土建构件 · 已实时计算`;
        $('#quote-status').title = quote.pendingReason || '';
        $('#plan-notice').hidden = true;
        $('#show-ceilings').hidden = true;
        $('#cutaway').hidden = true;
    }
    else {
        $('#show-ceilings').hidden = false;
        $('#cutaway').hidden = false;
        $('#quote-status').title = '';
    }
    if (municipal) {
        if (activeMunicipal?.kind === 'road') {
            const summary = $('.rp-inspector');
            if (summary)
                summary.outerHTML = renderRoadProfileSummary(project, activeMunicipal);
            else
                $('#inspector').insertAdjacentHTML('beforeend', renderRoadProfileSummary(project, activeMunicipal));
            if (activeMunicipal.roadProfile?.enabled) {
                const label = $('#municipal-elevation')?.closest('label')?.querySelector('.field-label');
                if (label)
                    label.textContent = '起点顶面标高';
            }
            if (activeMunicipal.roadProfile?.earthwork?.enabled) {
                const label = $('[data-municipal-stat="materialCost"]')?.parentElement?.querySelector('span');
                if (label)
                    label.textContent = '材料 / 结构层 / 土方';
            }
        }
        const hasElements = Boolean(quote.municipalElements?.length);
        $('#total-area').closest('.summary-metric').querySelector('span').textContent = '场地净施工面积';
        $('#total-area').closest('.summary-metric').querySelector('small').textContent = 'm²';
        $('#total-area').textContent = hasElements ? (quote.netArea === null ? '待校准' : measure(quote.netArea, 3)) : '—';
        $('#material-cost').closest('.summary-metric').querySelector('span').textContent = quote.municipalElements?.some(row => row.items.some(item => item.category === 'earthwork')) ? '材料 / 结构层 / 土方' : '材料 / 结构层';
        $('#material-cost').textContent = hasElements ? money(quote.knownMaterialCost) : '—';
        $('#labor-cost').textContent = hasElements ? money(quote.knownLaborCost) : '—';
        $('#total-cost').textContent = hasElements ? money(quote.pending ? quote.knownSubtotal : quote.total) : '—';
        $('#quote-total-label').textContent = quote.pending ? '已填写金额（税前）' : '市政总预算';
        $('#quote-status').textContent = !hasElements ? '画一段路线或圈定范围，开始场地预算' : quote.pending ? quote.pendingReason : `${quote.municipalElements.length} 项市政设施 · 中心线路径 ${measure(quote.totalLength, 3)} m · 已实时计算`;
        $('#quote-status').title = quote.pendingReason || '';
        $('#show-ceilings').hidden = true;
        $('#cutaway').hidden = true;
    }
    $('.quote-status').classList.toggle('pending', quote.pending);
    $('#undo').toggleAttribute('disabled', !history.canUndo());
    $('#redo').toggleAttribute('disabled', !history.canRedo());
    $('#recognize').toggleAttribute('disabled', !project.drawing || uploading);
    saveStatus();
    refreshCostWorkbench();
    refreshProjectOverview();
    refreshProjectPricing();
}
function updateInspectorNumbers(regionQuote) {
    if (!regionQuote)
        return;
    const ceilingTotal = $('[data-stat="ceiling-total"]');
    if (ceilingTotal)
        ceilingTotal.textContent = regionQuote.pending ? '待配置' : '¥ ' + money(regionQuote.total);
    const ceilingArea = $('[data-stat="ceiling-area"]');
    if (ceilingArea)
        ceilingArea.textContent = measure(regionQuote.netArea);
    for (const item of regionQuote.items) {
        const card = document.querySelector(`[data-item-card="${CSS.escape(item.id)}"]`);
        if (!card)
            continue;
        const spans = card.querySelectorAll('.cost-breakdown .stat-row>span:last-child');
        const unit = itemOwner()?.items?.find(i => i.id === item.id)?.unit || 'm²';
        const quantities = [item.netQuantity, item.purchaseQuantity];
        spans.forEach((span, index) => { span.textContent = index < 2 ? item.pending ? '—' : `${Number(quantities[index]).toLocaleString('zh-CN', { maximumFractionDigits: 4 })} ${unit}` : item.pending ? '—' : '¥ ' + money(index === 2 ? item.materialCost : item.laborCost); });
        const total = card.querySelector('[data-item-total]');
        if (total)
            total.textContent = item.pending ? item.pendingReason || '待配置' : '¥ ' + money(item.total);
        const quantityHelp = card.querySelector('.manual-quantity + .help');
        if (quantityHelp)
            quantityHelp.hidden = !item.pending;
    }
    const total = $('[data-stat="region-total"]');
    if (total)
        total.textContent = regionQuote.pending ? regionQuote.pendingReason || '待配置' : '¥ ' + money(regionQuote.total);
    const wallTotal = $('[data-stat="wall-total"]');
    if (wallTotal)
        wallTotal.textContent = itemOwner()?.items?.length ? regionQuote.pending ? '待填写用量' : '¥ ' + money(regionQuote.total) : '未配置墙材';
    const wallNet = $('[data-stat="wall-net-area"]');
    if (wallNet)
        wallNet.textContent = measure(regionQuote.netArea);
    const wallHole = $('[data-stat="wall-opening-area"]');
    if (wallHole)
        wallHole.textContent = measure(regionQuote.openingArea) + ' m²';
    const wallPreview = $('#wall-finish-preview');
    if (wallPreview && selectedWall()) {
        const host = document.createElement('div');
        host.innerHTML = renderWallElevation(project, selectedWall());
        wallPreview.replaceWith(host.firstElementChild);
    }
    const help = $('.property-total p');
    if (help)
        help.textContent = regionQuote.pending ? regionQuote.pendingReason || '完善材料配置后更新小计。' : '包含材料、人工与附加费。';
}
function saveStatus(text) { $('#save-status').textContent = text || (!savedSignature ? '尚未保存' : signature(project) === savedSignature ? '已保存到本机' : '有未保存更改'); }
function scheduleSave() { clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(() => save(true), 1300); }
async function save(quiet = false) {
    if (isEditing() || uploading) {
        if (quiet)
            scheduleSave();
        else
            toast('先完成当前绘制或图纸上传，再保存项目。', true);
        return false;
    }
    const snapshot = copy(project);
    const originalSignature = signature(snapshot);
    snapshot.quoteSummary = computeQuote(snapshot);
    snapshot.budgetSummary = projectBudgetSnapshot(snapshot);
    saveStatus('正在保存…');
    try {
        await saveProject(snapshot, { drawingBlob: snapshot.drawing?.blob });
        if (project.id === snapshot.id) {
            savedSignature = originalSignature;
            localStorage.setItem('plan-material-studio.last-project', snapshot.id);
            saveStatus();
        }
        if (!quiet)
            toast('项目已保存，图纸和报价都保存在本机');
        return true;
    }
    catch (error) {
        saveStatus('保存失败');
        toast(error.message, true);
        return false;
    }
}
async function api(path, options = {}) {
    const response = await fetch(path, options);
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new Error('本地服务未响应，请确认程序仍在运行。');
    }
    if (!response.ok || !body.ok)
        throw new Error(body.error || '操作失败，请重试。');
    return body.data;
}
function busy(active) { uploading = active; $('#upload-loading').hidden = !active; $('#stage').classList.toggle('busy', active); $('#recognize').toggleAttribute('disabled', active || !project.drawing); }
function hasDrawingDesign() {
    if (project.municipalTerrain?.points.length || project.municipalTerrain?.raster || project.municipalHydraulics?.nodes.length)
        return true;
    if (project.municipalElements?.length)
        return true;
    const fields = ['regions', 'walls', 'wallShapes', 'openings', 'floorOpenings', 'furniture', 'serviceRoutes', 'civilElements'];
    return levelProjects(project).some(({ project: level }) => fields.some(field => level[field]?.length));
}
function clearDrawingDesign(next) {
    next.regions = [];
    next.furniture = [];
    next.serviceRoutes = [];
    next.civilElements = [];
    next.municipalElements = [];
    next.municipalTerrain = undefined;
    next.municipalHydraulics = undefined;
    next.municipalEarthworkTransfer = undefined;
    next.walls = [];
    next.wallShapes = [];
    next.openings = [];
    next.floorOpenings = [];
    next.levels = undefined;
    next.activeLevelId = undefined;
    next.planBoundary = null;
    next.wallRegionCache = [];
    next.planError = null;
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = selectedCivilId = null;
    selectedMunicipalId = null;
    selectedWallSide = null;
    selectedSurface = 'floor';
}
async function upload(file, demo = false) {
    if (!file)
        return;
    if (uploading) {
        toast('图纸仍在处理中，请稍候。');
        return;
    }
    if (file.size > 64 * 1024 * 1024) {
        toast('图纸不能超过 64 MB。', true);
        return;
    }
    if (hasDrawingDesign() && !demo && !confirm('更换图纸会清除所有楼层的区域、墙体、开口、家具、管线、土建构件、市政设施、地形、水力网络与比例校准。更换后可撤销恢复。继续吗？'))
        return;
    cancelEditing();
    busy(true);
    try {
        const drawing = await api('/api/drawings?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        drawing.blob = await (await fetch(drawing.url)).blob();
        update(next => { next.drawing = drawing; clearDrawingDesign(next); next.calibration = { metersPerPixel: demo ? .01 : null, method: demo ? 'demo-known-dimensions' : null }; if (next.name === '未命名项目')
            next.name = demo ? '材料选配 · 示例项目' : file.name.replace(/\.[^.]+$/, ''); });
        $('#project-name').value = project.name;
        toast(demo ? '示例图纸已打开 · 已知比例 100 px / m，请手动圈选区域' : '图纸已准备好，先校准真实尺寸');
        if (drawing.type === 'pdf' && drawing.pages > 1)
            pdfPages();
    }
    catch (error) {
        toast(error.message, true);
    }
    finally {
        busy(false);
        scheduleSave();
    }
}
async function pdfPages() {
    const drawing = project.drawing;
    if (!drawing || drawing.type !== 'pdf')
        return;
    const dialog = openDialog('选择 PDF 图纸页', `<form id="pdf-form"><label class="field-label">PDF 页码（共 ${drawing.pages} 页）</label><input id="pdf-page" type="number" min="1" max="${drawing.pages}" step="1" required value="${drawing.page}"><p class="help">每次编辑一页。切换页面后需要重新划分区域和校准。</p><button class="button primary full" type="submit">打开选中页</button></form>`);
    dialog.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const page = Number(dialog.querySelector('#pdf-page').value);
        if (page === drawing.page) {
            dialog.close();
            return;
        }
        if (hasDrawingDesign() && !confirm('切换页面会清除当前区域、家具、管线、土建构件与校准；可以撤销恢复。继续吗？'))
            return;
        dialog.close();
        cancelEditing();
        busy(true);
        try {
            const nextDrawing = await api(`/api/drawings/${drawing.id}/page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page }) });
            nextDrawing.blob = await (await fetch(nextDrawing.url)).blob();
            update(next => { next.drawing = nextDrawing; clearDrawingDesign(next); next.calibration = { metersPerPixel: null }; });
            toast(`第 ${page} 页已打开`);
        }
        catch (error) {
            toast(error.message, true);
        }
        finally {
            busy(false);
            scheduleSave();
        }
    });
}
function calibrations() {
    cancelEditing();
    if (project.drawing?.type === 'plan') {
        toast('当前图纸按真实尺寸绘制，无需比例校准。');
        return;
    }
    if (!project.drawing) {
        $('#drawing-file').click();
        return;
    }
    const dialog = openDialog('确定图纸的真实尺寸', `<div class="choice-list"><button class="choice-button" data-calibration="points">${icon('ruler', 24)}<span><strong>两点校准 <span class="demo-badge">推荐</span></strong><small>选取图纸上的两个端点，输入实际距离</small></span>${icon('chevron', 16)}</button><button class="choice-button" data-calibration="ratio">${icon('layers', 24)}<span><strong>输入图纸比例尺</strong><small>使用 1 : n 与图像 DPI 换算真实尺寸</small></span>${icon('chevron', 16)}</button><button class="choice-button" data-calibration="width">${icon('fit', 24)}<span><strong>已知实际尺寸</strong><small>使用选中区域或整张图纸的真实宽度</small></span>${icon('chevron', 16)}</button></div>`, { subtitle: '画布缩放只改变观看大小，不影响实际面积。' });
    dialog.querySelectorAll('[data-calibration]').forEach(button => button.addEventListener('click', async () => {
        const method = button.dataset.calibration;
        dialog.close();
        if (method === 'points')
            viewer.setTool('calibrate');
        else if (method === 'ratio') {
            const next = openDialog('输入比例尺', `<form id="ratio-form"><div class="field-grid"><label><span class="field-label">比例尺 1 : n</span><input id="ratio-number" type="number" min="1" step="any" value="100" required></label><label><span class="field-label">图纸输出 / 扫描 DPI</span><input id="ratio-dpi" type="number" min="1" step="any" value="${project.drawing.dpi || 300}" required></label></div><p class="help">图片被缩放或重新扫描后，原比例尺可能失效；DPI 不确定时请使用两点校准。</p><button type="submit" class="button primary full">应用比例尺</button></form>`);
            next.querySelector('form').addEventListener('submit', event => { event.preventDefault(); const denominator = Number(next.querySelector('#ratio-number').value); const dpi = Number(next.querySelector('#ratio-dpi').value); if (![denominator, dpi].every(n => Number.isFinite(n) && n > 0))
                return; update(p => p.calibration = { metersPerPixel: .0254 * denominator / dpi, method: 'drawing-ratio', denominator, dpi }); next.close(); toast('图纸比例尺已应用'); });
        }
        else {
            const region = selectedRegion();
            const points = region?.points;
            const pixels = points ? Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) : project.drawing.width;
            const width = await askNumber('已知实际宽度', `${region ? region.name + ' 的外包边界' : '整张上传图片覆盖范围'}真实宽度（米）`, '10', region ? '使用区域最左与最右边界间的真实水平距离。' : '这个宽度包含图片的全部绘图区和白边；不确定时请使用两点校准。');
            if (width && pixels > 0) {
                update(p => p.calibration = { metersPerPixel: width / pixels, method: 'known-width', distance: width });
                toast('实际尺寸已应用');
            }
        }
    }));
}
function chooseMaterial(itemId) {
    const owner = itemOwner();
    if (!owner)
        return;
    const dialog = openDialog('为这个区域选择材料', `<div class="material-filter"><input id="material-search" type="search" placeholder="搜索材料或规格" aria-label="搜索材料"><select id="material-category" aria-label="材料分类"><option value="">全部类别</option>${[...new Set(materials.map(m => m.category))].map(c => `<option>${escape(c)}</option>`).join('')}</select></div><div id="material-grid" class="material-grid"></div>`, { wide: true, subtitle: '示例材料和演示价格已明确标注，可替换为实际产品报价。', footer: `<button class="button subtle" data-action="manage-materials">管理材料库</button><button class="button primary" data-action="new-material">${icon('plus', 16)}自定义材料</button>` });
    const draw = () => {
        const query = dialog.querySelector('#material-search').value.trim().toLowerCase();
        const category = dialog.querySelector('#material-category').value;
        const matching = materials.filter(m => (!category || m.category === category) && (m.name + m.description).toLowerCase().includes(query));
        dialog.querySelector('#material-grid').innerHTML = matching.map(m => `<button class="material-option" data-pick-material="${escape(m.id)}"><img src="${escape(m.image || 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${m.color}"/></svg>`))}" alt="${escape(m.name)}"><div class="material-option-body"><span><strong>${escape(m.name)}</strong><p>${escape(m.category)}</p>${m.demo ? '<span class="demo-badge">示例材料 · 参考价格</span>' : ''}</span><span class="material-price">¥ ${unitPrice(m.unitPrice)}<p>每 ${escape(m.unit)}</p></span></div></button>`).join('') || '<p class="help">没有找到材料，可以添加自定义材料。</p>';
        dialog.querySelectorAll('[data-pick-material]').forEach(button => {
            const material = materials.find(material => material.id === button.dataset.pickMaterial);
            button.querySelector('.material-option-body > span').insertAdjacentHTML('beforeend', `<p class="material-option-source" title="${escape(describePriceSource(material.provenance, material.demo))}">${escape(describePriceSource(material.provenance, material.demo))}</p>`);
        });
        dialog.querySelectorAll('[data-pick-material]').forEach(button => button.addEventListener('click', () => {
            const material = materials.find(m => m.id === button.dataset.pickMaterial);
            update(next => { const current = itemOwner(next); if (!current)
                return; current.items ||= []; const existing = current.items.find(i => i.id === itemId); const overrides = existing ? { id: existing.id, laborRate: existing.laborRate, additionalCost: existing.additionalCost, ...(existing.unit === material.unit ? { quantityMode: existing.quantityMode, quantity: existing.quantity } : {}) } : {}; const item = createMaterialSnapshot(material, overrides); if (existing)
                current.items[current.items.indexOf(existing)] = item;
            else
                current.items.push(item); });
            dialog.close();
            toast('材料方案已更新');
            const added = itemOwner()?.items?.find(i => i.materialId === material.id);
            if (added?.quantityMode === 'manual')
                $(`#item-${CSS.escape(added.id)}-quantity`)?.focus();
        }));
    };
    dialog.querySelector('#material-search').addEventListener('input', draw);
    dialog.querySelector('#material-category').addEventListener('change', draw);
    draw();
}
function materialForm(material) {
    let image = material?.image || '';
    const dialog = openDialog(material ? '编辑材料' : '自定义材料', `<form id="material-form"><div class="field-grid"><label><span class="field-label">材料名称</span><input name="name" required maxlength="120" value="${escape(material?.name || '')}"></label><label><span class="field-label">类别</span><input name="category" value="${escape(material?.category || '地面')}"></label><label><span class="field-label">单位</span><select name="unit">${['m²', 'm', '件', 'kg', '吨', 'm³'].map(u => `<option${material?.unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select></label><label><span class="field-label">单价（元 / 单位）</span><input name="unitPrice" type="number" min="0" step="any" required value="${escape(material?.unitPrice || '0')}"></label><label><span class="field-label">默认损耗（%）</span><input name="wasteRate" type="number" min="0" step="any" required value="${escape(material?.wasteRate || '5')}"></label><label><span class="field-label">画布标记颜色</span><input name="color" type="color" value="${escape(material?.color || '#899f8c')}"></label></div><label><span class="field-label">材料说明 / 规格</span><textarea name="description">${escape(material?.description || '')}</textarea></label><label class="image-upload-label">${icon('image', 16)} 上传材料图片（可选）<input id="material-image" type="file" accept="image/png,image/jpeg" hidden></label><p id="material-image-status" class="help"></p><button class="button primary full" type="submit">保存材料</button></form>`);
    dialog.querySelector('#material-form > button[type="submit"]').insertAdjacentHTML('beforebegin', materialSourceFields(material));
    dialog.querySelector('#material-image').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file)
            return;
        if (file.size > 5 * 1024 * 1024) {
            toast('材料图片不能超过 5 MB。', true);
            return;
        }
        image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        dialog.querySelector('#material-image-status').textContent = '已选择：' + file.name;
    });
    dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            const form = new FormData(dialog.querySelector('form'));
            const fields = Object.fromEntries(['name', 'category', 'unit', 'unitPrice', 'wasteRate', 'color', 'description'].map(key => [key, form.get(key)]));
            const next = normalizeMaterial({ ...(material || {}), ...fields, image, demo: false, provenance: readMaterialSource(form, material) });
            materials = saveMaterials(material ? materials.map(m => m.id === material.id ? next : m) : [...materials, next]);
            dialog.close();
            render();
            toast('材料库已保存；已有报价保留原单价');
            if (selectedId || selectedWallId)
                chooseMaterial();
        }
        catch (error) {
            toast(error.message, true);
        }
    });
}
function manageMaterials() {
    cancelEditing();
    const dialog = openDialog('材料库', `<div>${materials.map(m => `<div class="material-manage-row"><span><span class="color-dot" style="background:${escape(m.color)}"></span><span><strong>${escape(m.name)}</strong><p class="help">¥ ${unitPrice(m.unitPrice)} / ${escape(m.unit)} ${m.demo ? ' · 示例价格' : ''}</p></span></span><div class="material-manage-actions"><button class="icon-button" data-edit-material="${escape(m.id)}" aria-label="编辑${escape(m.name)}">${icon('edit', 16)}</button><button class="icon-button" data-delete-material="${escape(m.id)}" aria-label="删除${escape(m.name)}">${icon('trash', 16)}</button></div></div>`).join('')}</div>`, { subtitle: '材料库独立保存。修改默认价格不会改变已保存的项目配置。', footer: '<button class="button primary" data-action="new-material">添加材料</button>' });
    dialog.querySelectorAll('[data-edit-material]').forEach(button => button.addEventListener('click', () => materialForm(materials.find(m => m.id === button.dataset.editMaterial))));
    dialog.querySelectorAll('.material-manage-row').forEach((row, index) => row.querySelector('p.help').insertAdjacentHTML('afterend', `<p class="help material-source-note">${escape(describePriceSource(materials[index].provenance, materials[index].demo))}</p>`));
    dialog.querySelector('.dialog-footer').insertAdjacentHTML('afterbegin', '<button class="button subtle" data-action="update-prices">导入报价</button><button class="button subtle" data-action="refresh-material-prices">刷新来源报价</button><button class="button subtle" data-action="sync-project-prices">同步项目单价</button>');
    dialog.querySelectorAll('[data-delete-material]').forEach(button => button.addEventListener('click', () => { if (!confirm('从材料库删除这项材料？已保存的报价配置仍会保留。'))
        return; materials = saveMaterials(materials.filter(m => m.id !== button.dataset.deleteMaterial)); manageMaterials(); render(); }));
}
function updateMaterialPrices() {
    openPriceManager(materials, commitMaterialPrices, { getMaterials: () => materials });
}
const priceSourceContext = {
    getProject: () => project, getMaterials: () => materials,
    apply: result => { cancelEditing(); update(next => Object.assign(next, result)); },
    refresh: materialId => { cancelEditing(); openSavedPriceRefresh(materials, commitMaterialPrices, { materialId, getMaterials: () => materials }); },
    manage: manageMaterials,
};
function commitMaterialPrices(next, updatedIds) {
    materials = saveMaterials(next);
    render();
    if (collectProjectSourceRows(project).some(row => row.sourceLinkable && updatedIds.includes(row.materialId)))
        queueMicrotask(() => showProjectMaterialSync(priceSourceContext, updatedIds));
}
function openingEditor(kind, existing) {
    if (existing?.locked) {
        toast('请先解锁，再修改开口尺寸。', true);
        return;
    }
    if (!existing && selectedWallShape()) {
        toast('圆弧整组暂不支持跨段门窗；请在直墙上添加门窗。', true);
        return;
    }
    const wallId = existing?.wallId || selectedWallId;
    if (!wallId) {
        toast('先选择一面墙，再添加门窗或开孔。');
        return;
    }
    cancelEditing();
    showOpeningEditor(project, wallId, kind, opening => {
        update(next => { next.openings ||= []; const index = next.openings.findIndex(o => o.id === opening.id); if (index >= 0)
            next.openings[index] = opening;
        else
            next.openings.push(opening); });
        selectObject('opening', opening.id);
        toast('墙体开口已更新，可撤销');
    }, existing);
}
function duplicateOpening(id) {
    cancelEditing();
    const source = project.openings?.find(opening => opening.id === id);
    if (!source)
        return;
    const wall = project.walls?.find(wall => wall.id === source.wallId);
    if (!wall)
        return;
    const duplicate = { ...copy(source), id: newId('opening'), locked: false, name: (source.name || openingName(source)).slice(0, 116) + ' 副本' };
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    const offsets = [source.offset + source.width + 10, source.offset - source.width - 10, 1, (length - source.width) / 2, length - source.width - 1,
        ...(project.openings || []).filter(opening => opening.wallId === wall.id).flatMap(opening => [opening.offset + opening.width + 10, opening.offset - source.width - 10])];
    const free = offsets.find(offset => openingPositionValidity(project, { ...duplicate, offset }).valid);
    if (free !== undefined)
        duplicate.offset = free;
    else
        toast('当前墙面没有足够空位，请为副本调整尺寸或高度后再添加。');
    openingEditor(duplicate.kind, duplicate);
}
function settings() {
    cancelEditing();
    const dialog = openDialog('项目设置', `<form id="settings-form"><div class="field-grid"><label><span class="field-label">项目固定附加费（元）</span><input name="additionalCost" type="number" min="0" step="any" value="${escape(project.additionalCost)}" required></label><label><span class="field-label">报价税率（%）</span><input name="taxRate" type="number" min="0" step="any" value="${escape(project.taxRate)}" required></label></div><label class="field-label"><input name="labels" type="checkbox" ${project.view.labels ? 'checked' : ''}> 显示区域名称与面积</label><p class="help">${workspaceMode() === 'civil' ? '土建人工按净体积计价，主材采购体积包含损耗；模板和钢筋单独计算。' : '净施工面积用于人工计价；采购面积包含材料损耗。'}</p><p class="help">空间材料估算 · 版本 1.2.0</p><button type="submit" class="button primary full">应用设置</button></form>`, { footer: '<button class="button subtle" data-action="manage-materials">材料库</button><a class="button subtle" href="/legacy" target="_blank">材料与价格管理</a>' });
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); try {
        const form = new FormData(dialog.querySelector('form'));
        const additionalCost = normalizeDecimal(form.get('additionalCost'), '项目附加费');
        const taxRate = normalizeDecimal(form.get('taxRate'), '税率');
        update(next => { next.additionalCost = additionalCost; next.taxRate = taxRate; next.view.labels = form.has('labels'); });
        dialog.close();
        toast('项目设置已应用');
    }
    catch (error) {
        toast(error.message, true);
    } });
}
function quoteDetails() {
    if (quote.kind === 'municipal') {
        const rows = (quote.municipalElements || []).map(row => `<div class="details-line"><span>${escape(row.name)}<small class="muted">${row.netQuantity === null ? '待校准' : measure(Number(row.netQuantity), 3)} ${escape(row.unit)}${row.items.length > 1 ? ' · ' + (row.items.length - 1) + ' 个附加结构层' : ''}</small></span><strong>${row.pending ? '¥ ' + money(row.knownTotal) + ' · 待完善' : '¥ ' + money(row.total)}</strong></div>`).join('');
        openDialog('市政预算明细', `${rows || '<p class="help">绘制设施并填写价格后显示预算。</p>'}<div class="details-line"><span>项目固定附加费</span><strong>¥ ${money(project.additionalCost)}</strong></div><div class="details-line"><span>税金（${escape(project.taxRate)}%）</span><strong>${quote.pending ? '待完善报价' : '¥ ' + money(quote.tax)}</strong></div><div class="details-line details-total"><span>${quote.pending ? '已填写金额（税前）' : '市政总预算'}</span><strong>¥ ${money(quote.pending ? quote.knownSubtotal : quote.total)}</strong></div>`, { subtitle: quote.pending ? quote.pendingReason : '按实际场地用量与用户填写单价逐项计算', footer: '<button class="button primary" data-action="export">导出市政预算</button>' });
        return;
    }
    if (quote.kind === 'civil') {
        const rows = (quote.civilElements || []).map(row => `<div class="details-line"><span>${row.levelName ? escape(row.levelName) + ' / ' : ''}${escape(row.name)}<small class="muted">${escape(row.quantity)} 件 · 净量 ${measure(row.netVolume, 3)} m³</small></span><strong>${row.pending ? escape(row.pendingReason) : '¥ ' + money(row.total)}</strong></div>`).join('');
        openDialog('土建预算明细', `${rows || '<p class="help">放置构件并填写价格后显示预算明细。</p>'}<div class="details-line"><span>项目固定附加费</span><strong>¥ ${money(project.additionalCost)}</strong></div><div class="details-line"><span>税金（${escape(project.taxRate)}%）</span><strong>¥ ${money(quote.tax)}</strong></div><div class="details-line details-total"><span>${quote.pending ? '已填写金额（税前）' : '土建总预算'}</span><strong>¥ ${money(quote.pending ? quote.knownSubtotal : quote.total)}</strong></div>`, { subtitle: quote.pending ? quote.pendingReason : '按实际尺寸计量，材料、人工、模板、钢筋与税费逐项计算', footer: '<button class="button primary" data-action="export">导出土建预算</button>' });
        return;
    }
    const rows = [...quote.regions, ...(quote.walls || []).filter(w => w.items.length || Number(w.additionalCost) > 0), ...(quote.ceilings || []).filter(row => row.items.length || Number(row.additionalCost) > 0), ...(quote.furniture || []), ...(quote.serviceRoutes || []), ...(quote.openings || [])].map(r => `<div class="details-line"><span>${r.levelName ? escape(r.levelName) + ' / ' : ''}${escape(r.name)} <small class="muted">${r.surfaceType === 'opening' ? '门窗 / 开孔 · ' + escape(r.quantity) + ' ' + escape(r.unit) : r.surfaceType === 'service' ? '管线 · ' + measure(r.netQuantity, 3) + ' m' : r.surfaceType === 'furniture' ? '设备 / 家具 · ' + escape(r.quantity) + ' 件' : (r.surfaceType === 'wall' ? '墙面 · ' : r.surfaceType === 'ceiling' ? '天花板 · ' : '') + measure(r.netArea) + ' m²'}</small></span><strong>${r.pending ? escape(r.pendingReason || '待配置') : '¥ ' + money(r.total)}</strong></div>`).join('');
    openDialog('项目报价明细', `${rows || '<p class="help">添加区域或家具后，这里会显示报价明细。</p>'}<div class="details-line"><span>项目固定附加费</span><span>¥ ${money(project.additionalCost)}</span></div><div class="details-line"><span>税金（${escape(project.taxRate)}%）</span><span>¥ ${money(quote.tax)}</span></div>${quote.pending ? `<div class="details-line"><span>已填写金额（税前）</span><strong>¥ ${money(quote.knownSubtotal)}</strong></div>` : ''}<div class="details-line details-total"><span>预计总报价</span><strong>¥ ${money(quote.total)}</strong></div>`, { subtitle: quote.pending ? quote.pendingReason : '材料 / 家具费 + 人工费 + 固定附加费 + 税金', footer: '<button class="button primary" data-action="export">导出完整报价</button>' });
}
async function startFromOverview(mode) {
    try {
        if (mode === 'plan' && !project.drawing) {
            const drawing = await createMetricDrawing();
            update(next => {
                next.drawing = drawing;
                next.walls = [];
                next.wallThickness ??= 20;
                next.wallHeight ??= 280;
                next.calibration = { metersPerPixel: .01, method: 'metric-plan' };
                next.workspaceMode = 'plan';
            });
            await switchView('2d');
            viewer.setTool('wall');
            viewer.fit();
            toast('已建立米制画板，可输入墙长或用房间模板开始');
            return;
        }
        await switchWorkspace(mode);
        if (mode === 'municipal' && workspaceMode() === mode && !project.municipalElements?.length) {
            showMunicipalStarter(project, elements => update(next => (next.municipalElements ??= []).push(...elements)));
        }
    }
    catch (error) {
        toast(error.message, true);
    }
}
async function locateBudgetIssue(issue) {
    try {
        if (issue.levelId && project.levels?.some(level => level.id === issue.levelId))
            await changeActiveLevel(issue.levelId);
        const mode = issue.section === 'decoration' ? canDecorate() ? 'decoration' : 'plan' : issue.section;
        await switchWorkspace(mode);
        if (issue.targetType === 'project') {
            if (!project.calibration.metersPerPixel && project.drawing)
                calibrations();
            else
                toast(issue.message);
            return;
        }
        if (!issue.targetId)
            return;
        if (issue.targetType === 'ceiling') {
            selectObject('region', issue.targetId);
            selectedSurface = 'ceiling';
            render();
        }
        else if (issue.targetType === 'wall') {
            const shape = project.wallShapes?.find(shape => shape.id === issue.targetId);
            selectObject('wall', shape?.wallIds[0] ?? issue.targetId);
        }
        else
            selectObject(issue.targetType, issue.targetId);
        viewer.focusSelection();
        const owner = issue.targetType === 'region' || issue.targetType === 'ceiling' ? selectedRegion()
            : issue.targetType === 'wall' ? selectedWall()
                : ({ opening: project.openings, furniture: project.furniture, service: project.serviceRoutes, civil: project.civilElements, municipal: project.municipalElements }[issue.targetType])?.find(item => item.id === issue.targetId);
        toast(owner && 'hidden' in owner && owner.hidden ? '已定位属性；此对象当前已隐藏，可在属性中显示' : '已定位到对应对象，在右侧完善配置');
    }
    catch (error) {
        toast(error.message, true);
    }
}
function projectOverview() {
    if (isEditing() || uploading) {
        toast('请先完成编辑或按 Esc 取消，再查看工程总览。', true);
        return;
    }
    closeCostWorkbench();
    openProjectOverview(project, {
        getProject: () => project, onUpdate: update, onLocate: locateBudgetIssue, onStart: startFromOverview,
        onCalibrate: () => project.drawing ? calibrations() : startFromOverview('plan'), onSave: () => save(),
        onUndo: undo, canUndo: () => history.canUndo(), canRedo: () => history.canRedo(),
        onOpenPricing: projectPricing,
        onExportProject: async () => {
            try {
                await downloadProjectJSON(project, { materials, drawingBlob: project.drawing?.blob });
                toast('完整项目文件已导出');
            }
            catch (error) {
                toast(error.message, true);
            }
        },
    });
}
function projectPricing(tab = 'pricing') {
    if (isEditing() || uploading) {
        toast('请先完成当前编辑，再整理报价。', true);
        return;
    }
    closeCostWorkbench();
    openProjectPricing(project, {
        getProject: () => project,
        onApply: next => { update(current => Object.assign(current, next)); toast('报价已一次应用，可撤销；工程量已重新计算'); },
        onLocate: locateBudgetIssue, onBack: projectOverview, onSave: () => save(),
        onUndo: undo, canUndo: () => history.canUndo(), canRedo: () => history.canRedo(),
    }, tab);
}
function exports() {
    if (isEditing() || uploading) {
        toast('请先完成编辑或按 Esc 取消，再导出。', true);
        return;
    }
    const dialog = openDialog('导出项目', `<div class="choice-list"><button class="choice-button" data-export="csv">${icon('export', 23)}<span><strong>完整报价 CSV</strong><small>含区域、墙面、设备、管线、材料用量、人工与税金</small></span>${icon('chevron', 16)}</button><button class="choice-button" data-export="pdf">${icon('layers', 23)}<span><strong>打印 / 保存 PDF 报价单</strong><small>打开排版后的报价单，通过浏览器保存为 PDF</small></span>${icon('chevron', 16)}</button><button class="choice-button" data-export="json">${icon('folder', 23)}<span><strong>完整项目文件</strong><small>包含图纸、楼层、区域、设备、管线及材料配置</small></span>${icon('chevron', 16)}</button></div>`, { subtitle: quote.pending ? '项目配置尚未完成，仍可导出项目文件继续编辑。' : '报价按当前保存的材料和家具单价计算。' });
    if (quote.kind === 'municipal') {
        dialog.querySelector('[data-export="csv"] small').textContent = '道路、结构层、管线、设施、净量、材料、人工与税金';
        dialog.querySelector('[data-export="json"] small').textContent = '完整市政场地设计、报价参数与现有建筑配置';
    }
    if (quote.kind === 'civil') {
        dialog.querySelector('[data-export="csv"] small').textContent = '土建构件、扣重叠净量、损耗、模板、钢筋、人工与税金';
        dialog.querySelector('[data-export="json"] small').textContent = '保存土建设计与全部室内配置，可重新导入继续编辑';
        dialog.querySelector('.dialog-head p').textContent = quote.pending ? '部分单价尚未填写，导出会明确标记待配置。' : '按实际土建设计尺寸和你填写的价格生成预算。';
    }
    dialog.querySelector('.choice-list').insertAdjacentHTML('afterbegin', `<button class="choice-button" data-open-budget>${icon('layers', 23)}<span><strong>工程总预算</strong><small>选择装修、土建与市政，固定费和税金合并计算一次</small></span>${icon('chevron', 16)}</button>`);
    dialog.querySelector('[data-open-budget]').addEventListener('click', projectOverview);
    dialog.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', async () => {
        try {
            const options = { pricing: quote, materials, drawingBlob: project.drawing?.blob };
            if (button.dataset.export === 'csv')
                downloadCSV(project, options);
            else if (button.dataset.export === 'pdf')
                printQuote(project, options);
            else
                await downloadProjectJSON(project, options);
            dialog.close();
            toast(button.dataset.export === 'pdf' ? '报价页已打开，点击打印可保存 PDF' : '导出文件已准备好');
        }
        catch (error) {
            toast(error.message, true);
        }
    }));
}
async function openProjects() {
    cancelEditing();
    try {
        const projects = await listProjects();
        const dialog = openDialog('打开项目', `<div>${projects.map(p => `<div class="project-row"><button class="project-choice" data-open-project="${escape(p.id)}"><strong>${escape(p.name)}</strong><small>${p.regionCount} 个区域 · ${new Date(p.updatedAt).toLocaleString('zh-CN')}</small></button><button class="icon-button" data-delete-project="${escape(p.id)}" aria-label="删除项目">${icon('trash', 16)}</button></div>`).join('') || '<p class="help">还没有保存的项目，可以先上传一张图纸。</p>'}</div>`, { footer: '<button class="button subtle" data-action="import-project">导入项目文件</button><button class="button primary" data-action="new-project">新建项目</button>' });
        dialog.querySelectorAll('[data-open-project]').forEach(button => button.addEventListener('click', async () => { try {
            if (!await leaveCurrent())
                return;
            const next = await loadProject(button.dataset.openProject);
            if (!next)
                throw new Error('项目不存在');
            activate(next);
            dialog.close();
            toast('项目已重新加载');
        }
        catch (error) {
            toast(error.message, true);
        } }));
        dialog.querySelectorAll('[data-delete-project]').forEach(button => button.addEventListener('click', async () => { if (!confirm('删除这个保存的项目？此操作不会删除当前工作台上的编辑。'))
            return; await deleteProject(button.dataset.deleteProject); if (button.dataset.deleteProject === project.id)
            savedSignature = ''; openProjects(); saveStatus(); }));
    }
    catch (error) {
        toast(error.message, true);
    }
}
async function leaveCurrent() {
    if (isEditing() || uploading) {
        toast('请先完成当前编辑或图纸处理。', true);
        return false;
    }
    if (signature(project) === savedSignature || !project.drawing && !project.regions.length && !project.cost)
        return true;
    // Use a separate dialog so an open project picker keeps its handlers and content.
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<header class="dialog-head"><h2>保存当前项目？</h2></header><div class="dialog-body"><p class="help">当前项目有未保存的修改。保存后再切换，或放弃本次修改。</p></div><footer class="dialog-footer"><button class="button subtle" data-leave="cancel">取消</button><button class="button subtle" data-leave="discard">放弃修改</button><button class="button primary" data-leave="save">保存并继续</button></footer>`;
    document.body.append(dialog);
    dialog.showModal();
    return new Promise(resolve => {
        let handled = false;
        dialog.addEventListener('close', () => { dialog.remove(); if (!handled)
            resolve(false); }, { once: true });
        dialog.querySelectorAll('[data-leave]').forEach(button => button.addEventListener('click', async () => {
            if (handled)
                return;
            const choice = button.dataset.leave;
            if (choice === 'save') {
                dialog.querySelectorAll('button').forEach(b => b.disabled = true);
                if (!await save()) {
                    dialog.querySelectorAll('button').forEach(b => b.disabled = false);
                    return;
                }
            }
            handled = true;
            dialog.close();
            resolve(choice !== 'cancel');
        }));
    });
}
function activate(next) {
    if (next.drawing?.type === 'plan') {
        next.calibration = { metersPerPixel: .01, method: 'metric-plan' };
        next.walls = normalizeWalls(next.walls || []);
        const rebuilt = rebuildWallRegions(next.walls, [...next.regions, ...(next.wallRegionCache || []).filter(old => !next.regions.some(r => r.id === old.id))], undefined, next.wallJoinStyle ?? 'square');
        next.regions = rebuilt.regions;
        next.wallRegionCache = rebuilt.cache;
        next.planError = rebuilt.error;
    }
    if (next.workspaceMode === 'decoration' && !canDecorate(next))
        next.workspaceMode = 'plan';
    validateProject(next);
    const importedMaterials = (next.materialsSnapshot || []).map(material => normalizeMaterial(material));
    const mergedMaterials = [...materials];
    for (const material of importedMaterials)
        if (!mergedMaterials.some(m => m.id === material.id))
            mergedMaterials.push(material);
    cancelEditing();
    viewRequest++;
    viewMode = '2d';
    threeViewer?.setVisible(false);
    clearTimeout(autoSaveTimer);
    project = next;
    selectedId = selectedWallId = selectedOpeningId = selectedFurnitureId = selectedServiceId = selectedCivilId = null;
    selectedWallSide = null;
    viewer.setSelectedWall(null);
    history = createHistory(project);
    savedSignature = signature(project);
    $('#project-name').value = project.name;
    materials = mergedMaterials;
    try {
        saveMaterials(materials);
    }
    catch (error) {
        toast('材料库暂未写入本机：' + error.message, true);
    }
    render();
}
async function recognize() {
    if (!project.drawing || uploading)
        return;
    cancelEditing();
    busy(true);
    try {
        const result = await api(`/api/drawings/${project.drawing.id}/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: project.drawing.page || 1 }) });
        const candidates = result.candidates.map((c, index) => ({ id: newId('candidate'), name: `识别区域 ${index + 1}`, points: c.points, holes: c.holes || [], hidden: false, items: [], additionalCost: '0' }));
        if (!candidates.length) {
            toast('没有找到可靠的封闭区域，可使用多边形工具手动绘制。');
            return;
        }
        viewer.setCandidates(candidates);
        const dialog = openDialog('确认识别的区域', `<p class="help">基于图纸实际像素提取封闭边界；文字、家具和线条可能需要人工修正。候选轮廓已在画布上预览。</p><div>${candidates.map((candidate, i) => `<label class="candidate-row"><input type="checkbox" data-candidate="${i}" checked><span><strong>${escape(candidate.name)}</strong><small>${candidate.points.length} 个顶点 · ${candidate.holes.length} 个孔洞 · ${project.calibration.metersPerPixel ? measure(regionMetrics(candidate, project.calibration).netArea) + ' m²' : '待校准'}</small></span></label>`).join('')}</div>`, { footer: '<button id="accept-candidates" class="button primary">将选中候选加入项目</button>' });
        dialog.addEventListener('close', () => viewer.setCandidates([]), { once: true });
        dialog.querySelector('#accept-candidates').addEventListener('click', () => {
            const selected = [...dialog.querySelectorAll('[data-candidate]:checked')].map(input => candidates[Number(input.dataset.candidate)]);
            let added = 0, skipped = 0;
            update(next => { for (const candidate of selected) {
                const validation = validateRegion(candidate, next.regions);
                if (!validation.valid) {
                    skipped++;
                    continue;
                }
                candidate.name = `区域 ${String(next.regions.length + 1).padStart(2, '0')}`;
                next.regions.push(candidate);
                selectedId = candidate.id;
                added++;
            } });
            dialog.close();
            toast(`已加入 ${added} 个区域${skipped ? `，${skipped} 个重叠或无效候选已跳过` : '，可以手动编辑边界'}`);
        });
    }
    catch (error) {
        toast(error.message, true);
    }
    finally {
        busy(false);
    }
}
async function demo() {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 820;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1200, 820);
    ctx.strokeStyle = '#454c43';
    ctx.lineWidth = 5;
    ctx.strokeRect(100, 160, 1000, 520);
    for (const [x, y, w, h] of [[140, 210, 420, 400], [600, 210, 320, 240], [600, 490, 320, 120]])
        ctx.strokeRect(x, y, w, h);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#697060';
    ctx.fillText('操作示例 · 已知尺寸平面图', 100, 90);
    ctx.font = '16px sans-serif';
    ctx.fillText('客厅 4.2 × 4.0 m', 270, 400);
    ctx.fillText('卧室 3.2 × 2.4 m', 680, 335);
    ctx.fillText('厨房 3.2 × 1.2 m', 680, 558);
    ctx.fillText('图纸覆盖尺寸已知：100 px = 1 m；示例不是自动识别结果。', 100, 760);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await upload(new File([blob], '示例平面图.png', { type: 'image/png' }), true);
}
document.addEventListener('click', async (event) => {
    const control = event.target.closest('[data-workspace],[data-place-furniture],[data-decoration-category],[data-decoration-tab],[data-draw-service],[data-service-system],[data-place-civil],[data-civil-category],[data-draw-municipal],[data-municipal-category],[data-road-lanes],[data-municipal-catalog]');
    if (control) {
        try {
            if (control.dataset.workspace)
                await switchWorkspace(control.dataset.workspace);
            else if (control.dataset.roadLanes) {
                const lanes = Number(control.dataset.roadLanes);
                if (![2, 4, 6, 8].includes(lanes))
                    return;
                const previousLayout = municipalDraftSettings.roadLayout;
                municipalDraftSettings = { roadLayout: { lanes, laneWidth: previousLayout?.laneWidth ?? 350, medianWidth: lanes > 2 ? previousLayout && previousLayout.lanes > 2 ? previousLayout.medianWidth : 100 : 0 } };
                municipalDraftSettings.width = lanes * municipalDraftSettings.roadLayout.laneWidth + municipalDraftSettings.roadLayout.medianWidth;
                await beginMunicipalDrawing('road');
            }
            else if (control.dataset.municipalCatalog) {
                const preset = municipalCatalogPreset(control.dataset.municipalCatalog);
                await beginMunicipalDrawing(preset.kind, preset.id);
            }
            else if (control.dataset.drawMunicipal)
                await beginMunicipalDrawing(control.dataset.drawMunicipal, undefined, true);
            else if (control.dataset.municipalCategory) {
                municipalCategory = control.dataset.municipalCategory;
                render({ inspector: false });
            }
            else if (control.dataset.placeCivil)
                await beginCivilPlacement(control.dataset.placeCivil);
            else if (control.dataset.civilCategory) {
                civilCategory = control.dataset.civilCategory;
                render({ inspector: false });
            }
            else if (control.dataset.placeFurniture)
                await beginFurniturePlacement(control.dataset.placeFurniture);
            else if (control.dataset.decorationTab) {
                cancelEditing();
                decorationTab = control.dataset.decorationTab;
                selectedServiceId = selectedFurnitureId = null;
                render();
                $('#left-panel').scrollTop = 0;
            }
            else if (control.dataset.drawService)
                await beginServiceDrawing(control.dataset.drawService);
            else if (control.dataset.serviceSystem) {
                serviceSystem = control.dataset.serviceSystem;
                render({ inspector: false });
            }
            else {
                decorationCategory = control.dataset.decorationCategory;
                render({ inspector: false });
            }
        }
        catch (error) {
            toast(error.message, true);
        }
        return;
    }
    const button = event.target.closest('[data-action]');
    if (!button)
        return;
    const action = button.dataset.action, id = button.dataset.id;
    try {
        if (action === 'edit-terrain') {
            cancelEditing();
            showTerrainEditor(project, model => { update(next => next.municipalTerrain = model); if (viewMode === '2d')
                viewer.fit();
            else
                threeViewer?.fit(); });
        }
        else if (action === 'municipal-hydraulics') {
            cancelEditing();
            showHydraulicsEditor(project, network => update(next => next.municipalHydraulics = network));
        }
        else if (action === 'earthwork-transfer') {
            cancelEditing();
            showEarthworkTransferEditor(project, config => update(next => next.municipalEarthworkTransfer = config));
        }
        else if (action === 'road-profile') {
            const item = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (item?.kind === 'road') {
                cancelEditing();
                showRoadProfileEditor(project, item, profile => update(next => { const road = next.municipalElements.find(value => value.id === item.id); road.roadProfile = profile; if (profile.enabled) {
                    road.elevation = profile.points[0].elevation * 100;
                    road.points = road.points.map(point => point.z === undefined ? point : { ...point, z: road.elevation });
                } }));
            }
        }
        else if (action === 'site-shift') {
            if (selectedMunicipalId)
                update(next => Object.assign(next, shiftMunicipalElevation(next, selectedMunicipalId, Number(button.dataset.delta))));
        }
        else if (action === 'site-align') {
            const item = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (item)
                showSiteAlignment(project, item, (offset, follow) => update(next => Object.assign(next, alignMunicipalToTerrain(next, item.id, { offset, follow }))));
        }
        else if (action === 'site-endpoints') {
            const item = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (item?.kind === 'road')
                showRoadEndpoints(item, (start, end) => update(next => Object.assign(next, setRoadEndpointElevations(next, item.id, start, end))));
        }
        else if (action === 'site-tunnel') {
            const item = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (item?.kind === 'road')
                showRoadTunnel(project, item, tunnel => update(next => { const road = next.municipalElements.find(value => value.id === item.id); if (road.locked)
                    throw new Error('请先解锁道路。'); road.tunnel = tunnel; }));
        }
        else if (action === 'site-cutaway') {
            await switchView('3d');
            threeViewer?.setTerrainDisplayMode('cutaway');
            if (selectedMunicipalId)
                threeViewer?.focusMunicipalElement(selectedMunicipalId);
        }
        else if (action === 'site-inspect') {
            await switchView('3d');
            if (selectedMunicipalId && !threeViewer?.inspectMunicipalElement(selectedMunicipalId))
                toast('请先选择可见的道路。', true);
        }
        else if (action === 'site-tunnel-view') {
            await switchView('3d');
            if (!threeViewer?.focusTunnel(selectedMunicipalId, button.dataset.position))
                toast('请先启用一段有效的隧道。', true);
        }
        else if (action === 'municipal-start')
            await startMunicipalProject();
        else if (action === 'municipal-kerbs' || action === 'municipal-island-kerbs') {
            cancelEditing();
            const road = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (!road)
                return;
            const kerbs = action === 'municipal-island-kerbs' ? createJunctionKerbs(project, road, { side: 'both', boundary: 'island' }) : createRoadsideKerbs(project, road, { side: 'both' });
            if (!kerbs.length) {
                toast('这些边界已配置同规格路缘石');
                return;
            }
            update(next => { (next.municipalElements ??= []).push(...kerbs); });
            toast(`已生成 ${kerbs.length} 段路缘石，填写价格后计入预算，可一次撤销`);
        }
        else if (action === 'focus-municipal') {
            if (selectedMunicipalId) {
                await switchView('3d');
                if (!threeViewer?.inspectMunicipalElement(selectedMunicipalId))
                    toast('请先选择可见的市政设施。', true);
            }
        }
        else if (action === 'municipal-check')
            showMunicipalCheck(project, quote, id => { viewer.setTool('select'); selectObject('municipal', id); });
        else if (action === 'carve-municipal-river')
            carveSelectedRiver();
        else if (action === 'quick-municipal')
            await quickMunicipal();
        else if (action === 'finish-municipal')
            viewer.finish();
        else if (action === 'select-municipal') {
            viewer.setTool('select');
            selectObject('municipal', id);
        }
        else if (action === 'toggle-municipal') {
            cancelEditing();
            update(next => { const item = next.municipalElements?.find(item => item.id === id); if (item)
                item.hidden = !item.hidden; });
        }
        else if (action === 'delete-municipal') {
            cancelEditing();
            update(next => { next.municipalElements = (next.municipalElements || []).filter(item => item.id !== id); if (selectedMunicipalId === id)
                selectedMunicipalId = null; });
            toast('市政设施已删除，可撤销');
        }
        else if (action === 'duplicate-municipal') {
            cancelEditing();
            const original = project.municipalElements?.find(item => item.id === selectedMunicipalId);
            if (!original)
                return;
            const delta = 2 / project.calibration.metersPerPixel, item = { ...copy(original), id: newId('municipal'), name: original.name.slice(0, 116) + ' 副本', locked: false, hidden: false };
            item.points = item.points.map(p => ({ ...p, x: p.x + delta, y: p.y + delta }));
            item.holes = item.holes.map(hole => hole.map(p => ({ ...p, x: p.x + delta, y: p.y + delta })));
            if (item.items)
                item.items = item.items.map(layer => ({ ...layer, id: newId('municipal-layer') }));
            update(next => { (next.municipalElements ??= []).push(item); selectedMunicipalId = item.id; });
            toast('设施已复制，尺寸与价格保留，可撤销');
        }
        else if (action === 'add-municipal-layer') {
            cancelEditing();
            update(next => { const item = next.municipalElements?.find(item => item.id === selectedMunicipalId); if (item?.locked)
                throw new Error('请先解锁设施。'); if (item && ['road', 'paving', 'intersection', 'roundabout', 'bridge'].includes(item.kind))
                (item.items ??= []).push({ id: newId('municipal-layer'), name: '基层', thickness: 20, unit: 'm³', unitPrice: '', wasteRate: '0', laborRate: '0', additionalCost: '0' }); });
        }
        else if (action === 'remove-municipal-layer') {
            cancelEditing();
            update(next => { const item = next.municipalElements?.find(item => item.id === selectedMunicipalId); if (item?.locked)
                throw new Error('请先解锁设施。'); if (item)
                item.items = (item.items || []).filter(layer => layer.id !== id); });
        }
        else if (action === 'remove-municipal-point') {
            cancelEditing();
            update(next => { const item = next.municipalElements?.find(item => item.id === selectedMunicipalId); if (item?.locked)
                throw new Error('请先解锁设施。'); if (item)
                item.points.splice(Number(button.dataset.point), 1); });
        }
        else if (action === 'civil-template')
            civilTemplate();
        else if (action === 'select-civil') {
            viewer.setTool('select');
            selectObject('civil', id);
        }
        else if (action === 'toggle-civil') {
            cancelEditing();
            update(next => { const item = next.civilElements?.find(item => item.id === id); if (item)
                item.hidden = !item.hidden; });
        }
        else if (action === 'delete-civil') {
            cancelEditing();
            update(next => { next.civilElements = (next.civilElements ?? []).filter(item => item.id !== id); if (selectedCivilId === id)
                selectedCivilId = null; });
            toast('构件已删除，可撤销恢复');
        }
        else if (action === 'duplicate-civil') {
            cancelEditing();
            const original = selectedCivil();
            if (!original)
                return;
            const item = { ...detachCivilElement(original, project), id: newId('civil'), name: original.name.replace(/（副本）$/, '') + '（副本）', hidden: false, locked: false };
            const scale = project.drawing?.type === 'plan' ? .01 : project.calibration.metersPerPixel;
            item.position = { x: item.position.x + .5 / scale, y: item.position.y + .5 / scale };
            update(next => { (next.civilElements ??= []).push(item); selectedCivilId = item.id; });
            toast('构件已复制，尺寸与价格保留，可撤销');
        }
        else if (action === 'detach-civil') {
            cancelEditing();
            update(next => { const item = next.civilElements?.find(item => item.id === selectedCivilId); if (item && !item.locked) {
                const detached = detachCivilElement(item, next);
                delete item.sourceRegionId;
                Object.assign(item, detached);
            } });
            toast('已解除房间关联，当前轮廓和孔洞保留，可独立编辑');
        }
        else if (action === 'select-region') {
            viewer.setTool('select');
            selectObject('region', id);
        }
        else if (action === 'manage-levels')
            manageLevels();
        else if (action === 'select-surface') {
            selectedSurface = button.dataset.surface;
            render();
        }
        else if (action === 'draw-floor-hole') {
            const regionId = selectedId, shape = button.dataset.holeShape ?? 'polygon', ratio = Number($('#floor-hole-inner-ratio')?.value ?? 45) / 100;
            if (workspaceMode() === 'decoration')
                await switchWorkspace('plan');
            selectObject('region', regionId);
            await switchView('2d');
            viewer.setHoleInnerRatio(ratio);
            viewer.setTool(shape === 'polygon' ? 'floor-hole' : `floor-hole-${shape}`);
        }
        else if (action === 'floor-hole-dimensions' || action === 'edit-floor-hole') {
            cancelEditing();
            const existing = project.floorOpenings?.find(opening => opening.id === id), region = project.regions.find(region => region.id === (existing?.regionId ?? selectedId));
            if (!region)
                throw new Error('请先选中本层房间。');
            showFloorOpeningEditor(project, region, existing, opening => update(next => {
                if (existing?.sourceStairId)
                    detachStairOpening(next, existing.sourceStairId);
                const target = existing && next.floorOpenings.find(value => value.id === existing.id);
                if (target)
                    Object.assign(target, opening);
                else
                    (next.floorOpenings ??= []).push({ id: newId('floor-opening'), regionId: region.id, ...opening });
            }));
        }
        else if (action === 'remove-floor-hole') {
            cancelEditing();
            update(next => { const opening = next.floorOpenings?.find(opening => opening.id === id); if (opening?.sourceStairId)
                detachStairOpening(next, opening.sourceStairId, true); next.floorOpenings = (next.floorOpenings ?? []).filter(opening => opening.id !== id); });
            toast('楼板洞已移除，可撤销');
        }
        else if (action === 'select-incoming-stair') {
            cancelEditing();
            await changeActiveLevel(button.dataset.levelId);
            selectObject('furniture', id);
        }
        else if (action === 'auto-stair-hole') {
            cancelEditing();
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (item?.locked)
                throw new Error('请先解锁楼梯。'); if (!item?.stairTargetLevelId)
                throw new Error('先选择楼梯到达的楼层。'); item.stair = { ...defaultStairSettings(item), autoOpening: true }; });
            toast('楼梯口已匹配到上层，会随楼梯同步更新');
        }
        else if (action === 'view-stair-hole') {
            const item = project.furniture?.find(item => item.id === selectedFurnitureId), target = levelProjects(project).find(level => level.id === item?.stairTargetLevelId), opening = target?.project.floorOpenings?.find(opening => opening.sourceStairId === item.id);
            if (!opening)
                throw new Error('尚无匹配楼梯口，请先自动匹配。');
            await changeActiveLevel(target.id);
            selectObject('region', opening.regionId);
            await switchView('2d');
            viewer.fit();
        }
        else if (action === 'detach-stair-hole') {
            cancelEditing();
            update(next => detachStairOpening(next, selectedFurnitureId));
            toast('楼梯口已改为手动，形状保留，可撤销');
        }
        else if (action === 'select-wall-shape') {
            const shape = project.wallShapes.find(value => value.id === id);
            viewer.setTool('select');
            selectObject('wall', shape.wallIds[0]);
        }
        else if (action === 'select-wall') {
            viewer.setTool('select');
            selectObject('wall', id);
        }
        else if (action === 'select-opening') {
            viewer.setTool('select');
            selectObject('opening', id);
        }
        else if (action === 'select-furniture') {
            viewer.setTool('select');
            selectObject('furniture', id);
        }
        else if (action === 'select-service') {
            viewer.setTool('select');
            selectObject('service', id);
        }
        else if (action === 'finish-service') {
            viewer.finish();
        }
        else if (action === 'redraw-service') {
            const route = project.serviceRoutes?.find(route => route.id === selectedServiceId);
            if (route)
                await beginServiceDrawing(route.presetId, route.id);
        }
        else if (action === 'toggle-service') {
            cancelEditing();
            update(next => { const route = next.serviceRoutes?.find(route => route.id === id); if (route)
                route.hidden = !route.hidden; });
        }
        else if (action === 'delete-service') {
            cancelEditing();
            update(next => { next.serviceRoutes = (next.serviceRoutes ?? []).filter(route => route.id !== id); if (selectedServiceId === id)
                selectedServiceId = null; });
            toast('线路已移除，可撤销恢复');
        }
        else if (action === 'duplicate-service') {
            cancelEditing();
            const original = project.serviceRoutes?.find(route => route.id === selectedServiceId);
            if (!original)
                return;
            const item = { ...copy(original), id: newId('service'), name: original.name.replace(/（副本）$/, '') + '（副本）', hidden: false };
            const scale = project.drawing?.type === 'plan' ? .01 : project.calibration.metersPerPixel, offset = scale ? .2 / scale : 20;
            if (item.points.every(point => point.x + offset <= project.drawing.width && point.y + offset <= project.drawing.height))
                item.points = item.points.map(point => ({ ...point, x: point.x + offset, y: point.y + offset }));
            update(next => { (next.serviceRoutes ??= []).push(item); selectedServiceId = item.id; });
            toast('线路已复制，规格与单价保留，可撤销');
        }
        else if (action === 'remove-service-point') {
            cancelEditing();
            update(next => { const route = next.serviceRoutes?.find(route => route.id === selectedServiceId); if (!route || route.points.length <= 2)
                throw new Error('线路至少保留两个节点。'); route.points.splice(Number(button.dataset.point), 1); });
        }
        else if (action === 'add-service-riser') {
            const z = Number($('#service-riser-height').value);
            if (!Number.isFinite(z) || z < -100 || z > 2000)
                throw new Error('竖向到达高度应为 -100–2000 cm。');
            cancelEditing();
            update(next => { const route = next.serviceRoutes?.find(route => route.id === selectedServiceId); if (!route)
                return; const last = route.points.at(-1); if (last.z === z)
                throw new Error('请填写不同于末端的到达高度。'); route.points.push({ ...last, z }); });
            toast('竖向段已添加，真实长度已计入预算');
        }
        else if (action === 'add-furniture')
            await addFurniture();
        else if (action === 'cancel-placement')
            cancelEditing();
        else if (action === 'calibrate-drawing')
            calibrations();
        else if (action === 'duplicate-furniture') {
            cancelEditing();
            const original = project.furniture?.find(item => item.id === selectedFurnitureId);
            if (!original)
                return;
            const scale = project.drawing?.type === 'plan' ? .01 : project.calibration.metersPerPixel;
            const offset = scale ? .3 / scale : 20;
            const item = { ...copy(original), id: newId('furniture'), name: original.name.replace(/（副本）$/, '') + '（副本）', quantity: '1', hidden: false };
            item.position = clampFurniturePosition(item, { x: original.position.x + offset, y: original.position.y + offset }, project);
            update(next => { next.furniture.push(item); selectedFurnitureId = item.id; });
            toast('家具已复制，单价保留，可撤销');
        }
        else if (action === 'toggle-furniture') {
            cancelEditing();
            update(next => { const item = next.furniture.find(item => item.id === id); item.hidden = !item.hidden; });
        }
        else if (action === 'delete-furniture') {
            cancelEditing();
            update(next => { next.furniture = next.furniture.filter(item => item.id !== id); if (selectedFurnitureId === id)
                selectedFurnitureId = null; });
            toast('家具已移除，可撤销恢复');
        }
        else if (action === 'rotate-furniture') {
            cancelEditing();
            update(next => { const item = next.furniture.find(item => item.id === selectedFurnitureId); if (item.locked)
                throw new Error('请先解锁家具。'); item.rotation = (item.rotation + 90) % 360; item.position = clampFurniturePosition(item, item.position, next); });
        }
        else if (action === 'add-opening')
            openingEditor(button.dataset.kind);
        else if (action === 'edit-opening') {
            const opening = project.openings.find(o => o.id === id);
            openingEditor(opening.kind, opening);
        }
        else if (action === 'duplicate-opening') {
            duplicateOpening(id);
        }
        else if (action === 'delete-opening') {
            cancelEditing();
            update(next => { next.openings = next.openings.filter(o => o.id !== id); selectedOpeningId = null; });
            toast('开口已移除，可撤销');
        }
        else if (action === 'update-prices')
            updateMaterialPrices();
        else if (action === 'refresh-material-prices')
            priceSourceContext.refresh();
        else if (action === 'sync-project-prices')
            showProjectMaterialSync(priceSourceContext);
        else if (action === 'link-price-source')
            showPriceSourceLink(button.dataset.priceSourceRow, priceSourceContext);
        else if (action === 'refresh-price-source') {
            const row = collectProjectSourceRows(project).find(row => row.id === button.dataset.priceSourceRow);
            if (row?.materialId && materials.some(material => material.id === row.materialId))
                priceSourceContext.refresh(row.materialId);
            else
                showPriceSourceLink(button.dataset.priceSourceRow, priceSourceContext);
        }
        else if (action === 'refresh-item-price') {
            const owner = itemOwner(), item = owner?.items?.find(i => i.id === button.dataset.itemId), material = materials.find(m => m.id === item?.materialId);
            if (!material)
                throw new Error('这个材料已移出材料库，请重新选择材料。');
            if (item.unit !== material.unit)
                throw new Error('材料单位已改变，请重新选择材料和计量方式。');
            update(next => { const current = itemOwner(next).items.find(i => i.id === item.id); current.unitPrice = material.unitPrice; current.priceMaterialId = material.id; current.priceSourceUnitPrice = material.unitPrice; current.provenance = copy(material.provenance); current.demo = material.demo; }, { inspector: true });
            toast('已应用材料库单价，可撤销');
        }
        else if (action === 'start-plan')
            await startPlan();
        else if (action === 'wall-tool') {
            await switchView('2d');
            viewer.setTool('wall');
        }
        else if (action === 'room-template')
            roomTemplate();
        else if (action === 'wall-defaults')
            wallDefaults();
        else if (action === 'plan-boundary') {
            if (project.drawing?.type !== 'plan')
                throw new Error('请先新建平面图。');
            cancelEditing();
            showBoundaryEditor(project, applyBoundary, () => { switchWorkspace('plan').then(() => viewer.setTool('boundary')); });
        }
        else if (action === 'shape-parameters') {
            if (project.drawing?.type !== 'plan')
                throw new Error('请先新建平面图。');
            if (workspaceMode() !== 'plan')
                await switchWorkspace('plan');
            showShapeParameters(project, value => createParametricShape(value));
        }
        else if (action === 'clean-walls') {
            cancelEditing();
            changeWalls(next => next.wallJoinStyle = 'clean');
            toast('墙体连接已整理，二维、三维与用量同步更新，可撤销');
        }
        else if (action === 'delete-wall-shape') {
            const group = project.wallShapes.find(value => value.id === id);
            if (!confirm(`删除「${group.name}」整组墙体？可以撤销。`))
                return;
            cancelEditing();
            changeWalls(next => { next.walls = next.walls.filter(wall => !group.wallIds.includes(wall.id)); next.wallShapes = next.wallShapes.filter(shape => shape.id !== id); next.openings = (next.openings || []).filter(opening => !group.wallIds.includes(opening.wallId)); });
            selectedWallId = null;
            render();
        }
        else if (action === 'delete-wall') {
            if (!confirm('删除这条墙线？房间将重新计算，可以撤销。'))
                return;
            cancelEditing();
            changeWalls(next => { next.walls = next.walls.filter(w => w.id !== id); next.openings = (next.openings || []).filter(o => o.wallId !== id); });
        }
        else if (action === 'upload')
            $('#drawing-file').click();
        else if (action === 'rename-region') {
            const region = project.regions.find(r => r.id === id);
            const name = prompt('区域名称', region.name);
            if (name?.trim())
                update(next => next.regions.find(r => r.id === id).name = name.trim().slice(0, 120));
        }
        else if (action === 'toggle-region')
            update(next => { const region = next.regions.find(r => r.id === id); region.hidden = !region.hidden; });
        else if (action === 'delete-region') {
            const region = project.regions.find(r => r.id === id);
            if (region?.source === 'walls') {
                toast('这个房间由墙线生成，选中墙线并删除，或移除材料方案。');
                return;
            }
            if (!confirm('删除这个区域及其材料方案？删除后可撤销。'))
                return;
            cancelEditing();
            update(next => { next.regions = next.regions.filter(r => r.id !== id); if (selectedId === id)
                selectedId = null; });
        }
        else if (action === 'remove-hole') {
            cancelEditing();
            update(next => { const region = next.regions.find(r => r.id === selectedId); region.holes.splice(Number(button.dataset.hole), 1); const validation = validateRegion(region, next.regions); if (!validation.valid)
                throw new Error(validation.error); });
            toast('孔洞已移除，可撤销恢复');
        }
        else if (action === 'toggle-labels')
            update(next => next.view.labels = !next.view.labels);
        else if (action === 'toggle-drawing')
            update(next => next.view.drawingOpacity = next.view.drawingOpacity ? 0 : 1);
        else if (action === 'remove-drawing') {
            if (!confirm('移除图纸并清除全部设计与校准？可以撤销恢复。'))
                return;
            cancelEditing();
            update(next => { next.drawing = null; clearDrawingDesign(next); next.calibration = { metersPerPixel: null }; });
        }
        else if (action === 'add-item' || action === 'choose-material')
            chooseMaterial(button.dataset.itemId);
        else if (action === 'remove-item')
            update(next => { const region = itemOwner(next); region.items = region.items.filter(i => i.id !== button.dataset.itemId); });
        else if (action === 'new-material')
            materialForm();
        else if (action === 'manage-materials')
            manageMaterials();
        else if (action === 'export')
            exports();
        else if (action === 'import-project')
            $('#project-file').click();
        else if (action === 'new-project') {
            if (await leaveCurrent()) {
                activate(freshProject());
                savedSignature = '';
                $('#dialog').close();
                saveStatus();
            }
        }
    }
    catch (error) {
        toast(error.message, true);
    }
});
document.addEventListener('input', event => {
    const input = event.target;
    const itemField = input.dataset.itemField, regionField = input.dataset.regionField, wallField = input.dataset.wallField, furnitureField = input.dataset.furnitureField;
    if (input.id === 'urban-catalog-search') {
        municipalCatalogSearch = input.value;
        $('#urban-catalog-grid').innerHTML = renderUrbanCatalogEntries(municipalCatalogSearch, municipalCatalogGroup);
        return;
    }
    if (input.id === 'site-placement-mode') {
        sitePlacement.mode = input.value;
        render({ inspector: false });
        return;
    }
    if (input.id === 'site-placement-elevation') {
        const value = input.value.trim() ? Number(input.value) : NaN;
        if (!Number.isFinite(value) || Math.abs(value) > 1000) {
            input.classList.add('validation-error');
            return;
        }
        sitePlacement.elevation = value;
        input.classList.remove('validation-error');
        return;
    }
    if (input.hasAttribute('data-site-elevation')) {
        try {
            const value = input.value.trim() ? Number(input.value) : NaN;
            update(next => Object.assign(next, setMunicipalElevation(next, selectedMunicipalId, value)), { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.id === 'urban-catalog-group') {
        municipalCatalogGroup = input.value;
        $('#urban-catalog-grid').innerHTML = renderUrbanCatalogEntries(municipalCatalogSearch, municipalCatalogGroup);
        return;
    }
    if (input.dataset.roadDraftField) {
        try {
            if (!municipalDraftSettings.roadLayout || input.validity.badInput || !input.value.trim())
                throw new Error('请填写有效的道路尺寸。');
            const field = input.dataset.roadDraftField;
            if (!['laneWidth', 'medianWidth'].includes(field))
                return;
            const value = Number(input.value) * 100;
            if (!Number.isFinite(value) || field === 'laneWidth' && (value < 100 || value > 1000) || field === 'medianWidth' && (value < 0 || value > 2000))
                throw new Error('单车道宽为 1–10 m，中央分隔为 0–20 m。');
            municipalDraftSettings.roadLayout = { ...municipalDraftSettings.roadLayout, [field]: value };
            municipalDraftSettings.width = municipalDraftSettings.roadLayout.lanes * municipalDraftSettings.roadLayout.laneWidth + municipalDraftSettings.roadLayout.medianWidth;
            if (['road', 'bridge', 'intersection', 'roundabout'].includes(viewer.getMunicipalDraftKind() ?? ''))
                viewer.setMunicipalDraftSettings(municipalDraftSettings);
            const width = document.querySelector('.road-authoring .chip');
            if (width)
                width.textContent = (municipalDraftSettings.width / 100).toFixed(1) + ' m';
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.dataset.municipalOption) {
        try {
            update(next => { const index = next.municipalElements?.findIndex(item => item.id === selectedMunicipalId); if (index === undefined || index < 0)
                return; next.municipalElements[index] = changeMunicipalOption(next.municipalElements[index], input.dataset.municipalOption, input.dataset.optionField, input.type === 'checkbox' ? input.checked : input.value); }, { inspector: input.tagName === 'SELECT' || input.type === 'checkbox' });
            input.classList.remove('validation-error');
        }
        catch (error) {
            input.classList.add('validation-error');
            toast(error.message, true);
        }
        return;
    }
    if (input.type === 'checkbox' && (furnitureField === 'locked' || input.id === 'civil-locked' || input.id === 'opening-locked' || input.id === 'municipal-locked' || input.id === 'opening-quote-enabled'))
        return;
    if (input.dataset.openingQuoteField) {
        try {
            update(next => { const opening = next.openings?.find(opening => opening.id === selectedOpeningId); if (!opening)
                return; opening.quote = { ...defaultOpeningQuote(opening), ...(opening.quote || {}) }; const field = input.dataset.openingQuoteField; opening.quote[field] = field === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '开口报价参数'); }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.dataset.municipalField || input.dataset.municipalPoint !== undefined || input.dataset.municipalLayer) {
        const field = input.dataset.municipalField, layerField = input.dataset.municipalLayerField;
        try {
            update(next => {
                const item = next.municipalElements?.find(item => item.id === selectedMunicipalId);
                if (!item)
                    return;
                if (input.dataset.municipalLayer) {
                    const layer = item.items?.find(layer => layer.id === input.dataset.municipalLayer);
                    if (!layer)
                        return;
                    if (layerField === 'name')
                        layer.name = input.value.trim() || '结构层';
                    else if (layerField === 'unit')
                        layer.unit = input.value;
                    else if (layerField === 'thickness') {
                        if (item.locked)
                            throw new Error('请先解锁设施。');
                        layer.thickness = input.value.trim() ? Number(input.value) : NaN;
                    }
                    else
                        layer[layerField] = layerField === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '结构层报价');
                }
                else if (input.dataset.municipalPoint !== undefined) {
                    if (item.locked)
                        throw new Error('请先解锁设施。');
                    const scale = next.calibration.metersPerPixel;
                    if (!scale)
                        throw new Error('请先校准图纸。');
                    const point = item.points[Number(input.dataset.municipalPoint)], axis = input.dataset.municipalAxis, value = input.value.trim() ? Number(input.value) : NaN;
                    if (point)
                        point[axis] = axis === 'z' ? value : value / (scale * 100);
                }
                else if (field === 'name')
                    item.name = input.value.trim() || '市政设施';
                else if (['width', 'depth', 'height', 'elevation', 'rotation'].includes(field)) {
                    if (item.locked)
                        throw new Error('请先解锁设施。');
                    const value = input.value.trim() ? Number(input.value) : NaN;
                    if (field === 'elevation')
                        Object.assign(next, setMunicipalElevation(next, item.id, value / 100));
                    else
                        item[field] = value;
                }
                else
                    item[field] = field === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '市政报价参数');
            }, { inspector: layerField === 'unit' });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.hasAttribute('data-opening-name')) {
        try {
            update(next => { const opening = next.openings?.find(opening => opening.id === selectedOpeningId); if (opening)
                opening.name = input.value.trim() || openingName(opening); }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.dataset.openingPositionField) {
        const field = input.dataset.openingPositionField;
        try {
            if (!['offset', 'bottom'].includes(field))
                return;
            const opening = project.openings?.find(opening => opening.id === selectedOpeningId);
            if (!opening)
                return;
            if (opening.locked)
                throw new Error('请先解锁开口。');
            const value = input.value.trim() ? Number(input.value) : NaN;
            if (!Number.isFinite(value))
                throw new Error('请输入有效的厘米数值。');
            const checked = openingPositionValidity(project, { ...opening, [field]: value });
            if (!checked.valid)
                throw new Error(checked.error);
            commitOpening(opening.id, { offset: opening.offset, bottom: opening.bottom, [field]: value });
            input.classList.remove('validation-error');
            openingFeedback('位置已更新，可撤销');
        }
        catch (error) {
            input.classList.add('validation-error');
            openingFeedback(error.message, true);
        }
        return;
    }
    if (input.dataset.civilField) {
        const field = input.dataset.civilField;
        try {
            update(next => {
                const item = next.civilElements?.find(item => item.id === selectedCivilId);
                if (!item)
                    return;
                if (field === 'name')
                    item.name = input.value || '未命名构件';
                else if (['width', 'depth', 'height', 'rotation', 'elevation'].includes(field)) {
                    if (item.locked)
                        throw new Error('请先解锁构件。');
                    if (item.sourceRegionId && ['width', 'depth', 'rotation'].includes(field))
                        throw new Error('此构件跟随房间轮廓，请先点击独立编辑。');
                    item[field] = input.value.trim() ? Number(input.value) : NaN;
                    if (item.kind === 'roundColumn' && field === 'width')
                        item.depth = item.width;
                    if (['width', 'depth', 'rotation'].includes(field))
                        delete item.sourceRegionId;
                }
                else if (field === 'quantity')
                    item.quantity = input.value;
                else
                    item[field] = ['unitPrice', 'formworkRate', 'rebarPrice'].includes(field) && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '土建计价参数');
            }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.id === 'service-search') {
        serviceSearch = input.value;
        const grid = $('#service-presets');
        if (grid)
            grid.innerHTML = renderServicePresets(serviceSystem, serviceSearch);
        return;
    }
    if (input.dataset.serviceField || input.dataset.servicePoint !== undefined) {
        try {
            update(next => {
                const route = next.serviceRoutes?.find(route => route.id === selectedServiceId);
                if (!route)
                    return;
                const field = input.dataset.serviceField;
                if (input.dataset.servicePoint !== undefined) {
                    const scale = next.drawing?.type === 'plan' ? .01 : next.calibration.metersPerPixel;
                    if (!scale)
                        throw new Error('请先校准图纸。');
                    const index = Number(input.dataset.servicePoint), axis = input.dataset.serviceAxis, value = input.value.trim() ? Number(input.value) : NaN;
                    const position = axis === 'z' ? value : value / scale;
                    if (axis !== 'z' && (!Number.isFinite(position) || position < 0 || position > next.drawing[axis === 'x' ? 'width' : 'height']))
                        throw new Error('节点应位于图纸范围内。');
                    route.points[index][axis] = position;
                }
                else if (field === 'name')
                    route.name = input.value || '未命名线路';
                else if (field === 'spec')
                    route.spec = input.value;
                else if (field === 'diameter')
                    route.diameter = input.value.trim() ? Number(input.value) : NaN;
                else
                    route[field] = field === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '管线计价参数');
                validateServiceRoutes(next.serviceRoutes);
            }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    const stairFields = { 'stair-railing-height': 'railingHeight', 'stair-inner-ratio': 'innerRatio', 'stair-turn-degrees': 'turnDegrees', 'stair-opening-clearance': 'openingClearance' };
    if (stairFields[input.id]) {
        try {
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (!item)
                return; if (item.locked)
                throw new Error('请先解锁楼梯。'); item.stair = { ...defaultStairSettings(item), [stairFields[input.id]]: Number(input.value) * (input.id === 'stair-inner-ratio' ? .01 : 1) }; }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (input.id === 'floor-hole-inner-ratio') {
        viewer.setHoleInnerRatio(Number(input.value) / 100);
        return;
    }
    if (furnitureField) {
        try {
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (!item)
                return; if (furnitureField === 'name')
                item.name = input.value || '未命名家具';
            else if (['width', 'depth', 'height', 'rotation', 'mountHeight'].includes(furnitureField)) {
                if (item.locked)
                    throw new Error('请先解锁家具。');
                item[furnitureField] = input.value.trim() ? Number(input.value) : NaN;
                if (furnitureField === 'height')
                    delete item.stairTargetLevelId;
                if (furnitureField === 'mountHeight')
                    syncStairHeight(next, item);
                item.position = clampFurniturePosition(item, item.position, next);
            }
            else if (furnitureField === 'quantity')
                item.quantity = input.value;
            else
                item[furnitureField] = furnitureField === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '家具价格'); validateFurniture(next.furniture); }, { inspector: false });
            input.classList.remove('validation-error');
        }
        catch {
            input.classList.add('validation-error');
        }
        return;
    }
    if (!itemField && !regionField && !wallField)
        return;
    try {
        update(next => {
            const region = itemOwner(next);
            if (!region)
                return;
            if (wallField) {
                region[wallField] = input.value;
                selectedWallSide = null;
                return;
            }
            if (regionField) {
                if (regionField === 'name') {
                    const source = next.regions.find(region => region.id === selectedId);
                    if (source)
                        source.name = input.value || '未命名区域';
                }
                else
                    region.additionalCost = normalizeDecimal(input.value || '0', '附加费');
            }
            else {
                const item = region.items.find(item => item.id === input.dataset.itemId);
                if (itemField === 'quantityMode')
                    item.quantityMode = input.value;
                else {
                    const value = itemField === 'unitPrice' && !input.value.trim() ? '' : normalizeDecimal(input.value || '0', '计价参数');
                    if (itemField === 'unitPrice' && item.unitPrice !== value) {
                        const source = item.provenance;
                        item.provenance = { source: '用户调整单价', ...(source?.spec ? { spec: source.spec } : {}), ...(source?.region ? { region: source.region } : {}) };
                    }
                    item[itemField] = value;
                }
            }
        }, { inspector: itemField === 'quantityMode' });
        input.classList.remove('validation-error');
    }
    catch {
        input.classList.add('validation-error');
    }
});
document.addEventListener('change', async (event) => {
    const input = event.target;
    if (input.dataset.municipalOption)
        return;
    try {
        if (input.id === 'opening-quote-enabled' || input.id === 'opening-quote-unit') {
            update(next => { const opening = next.openings?.find(opening => opening.id === selectedOpeningId); if (!opening)
                return; opening.quote = { ...defaultOpeningQuote(opening), ...(opening.quote || {}) }; if (input.id === 'opening-quote-enabled')
                opening.quote.enabled = input.checked;
            else
                opening.quote.unit = input.value; });
        }
        else if (input.id === 'municipal-locked') {
            cancelEditing();
            update(next => { const item = next.municipalElements?.find(item => item.id === selectedMunicipalId); if (item)
                item.locked = input.checked; });
        }
        else if (input.id === 'terrain-visible') {
            update(next => { if (next.municipalTerrain)
                next.municipalTerrain.visible = input.checked; });
        }
        else if (input.id === 'municipal-unit') {
            update(next => { const item = next.municipalElements?.find(item => item.id === selectedMunicipalId); if (item)
                item.unit = input.value; });
        }
        else if (input.id === 'opening-locked') {
            const checked = input.checked;
            cancelEditing();
            update(next => { const opening = next.openings?.find(opening => opening.id === selectedOpeningId); if (opening)
                opening.locked = checked; });
        }
        else if (input.dataset.furnitureField === 'locked') {
            cancelEditing();
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (item)
                item.locked = input.checked; });
        }
        else if (input.id === 'civil-locked') {
            cancelEditing();
            update(next => { const item = next.civilElements?.find(item => item.id === selectedCivilId); if (item)
                item.locked = input.checked; });
        }
        else if (input.id === 'civil-rebarMode') {
            update(next => { const item = next.civilElements?.find(item => item.id === selectedCivilId); if (item)
                item.rebarMode = input.value; });
        }
        else if (input.id === 'active-level-select')
            await changeActiveLevel(input.value);
        else if (input.id === 'ceiling-enabled' || input.id === 'ceiling-height') {
            update(next => { const region = next.regions.find(region => region.id === selectedId); if (!region)
                return; region.ceiling ??= { enabled: false, items: [], additionalCost: '0' }; if (input.id === 'ceiling-enabled')
                region.ceiling.enabled = input.checked;
            else
                region.ceiling.height = Number(input.value) * 100; });
        }
        else if (input.id === 'stair-railing') {
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (item?.locked)
                throw new Error('请先解锁楼梯。'); if (item)
                item.stair = { ...defaultStairSettings(item), railing: input.value }; });
        }
        else if (input.id === 'stair-target') {
            update(next => { const item = next.furniture?.find(item => item.id === selectedFurnitureId); if (!item)
                return; if (item.locked)
                throw new Error('请先解锁楼梯。'); if (input.value)
                item.stairTargetLevelId = input.value;
            else
                delete item.stairTargetLevelId; syncStairHeight(next, item); });
        }
    }
    catch (error) {
        toast(error.message, true);
    }
});
document.addEventListener('submit', event => {
    if (event.target.id === 'shape-edit-form') {
        event.preventDefault();
        try {
            const group = selectedWallShape();
            cancelEditing();
            createParametricShape(shapeParameters(new FormData(event.target)), group.id);
        }
        catch (error) {
            toast(error.message, true);
        }
        return;
    }
    if (event.target.id !== 'wall-edit-form')
        return;
    event.preventDefault();
    const form = new FormData(event.target);
    try {
        const height = Number(form.get('height')) * 100;
        if (!Number.isFinite(height) || height < 50 || height > 1000)
            throw new Error('墙高支持 0.5–10 m。');
        const wall = selectedWall(), lengthInput = $('#wall-edit-length'), angleInput = $('#wall-edit-angle');
        const length = lengthInput.value === lengthInput.defaultValue ? Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) / 100 : Number(form.get('length'));
        const angle = !angleInput.value.trim() || angleInput.value === angleInput.defaultValue ? undefined : Number(form.get('angle'));
        cancelEditing();
        changeWalls(next => next.walls = changeWallDimensions(next.walls, selectedWallId, length, Number(form.get('thickness')), String(form.get('anchor')), angle).map(wall => wall.id === selectedWallId ? { ...wall, height } : wall));
    }
    catch (error) {
        toast(error.message, true);
    }
});
$('#project-name').addEventListener('input', event => update(next => next.name = event.target.value || '未命名项目', { inspector: false }));
$('#project-name').addEventListener('blur', () => $('#project-name').value = project.name);
$('#drawing-file').addEventListener('change', event => { const input = event.target; if (input.files[0])
    upload(input.files[0]); input.value = ''; });
$('#project-file').addEventListener('change', async (event) => { const input = event.target; try {
    if (input.files[0]) {
        if (input.files[0].size > 96 * 1024 * 1024)
            throw new Error('项目文件过大');
        const next = await importProjectJSON(await input.files[0].text());
        if (await leaveCurrent()) {
            activate(next);
            $('#dialog').close();
            scheduleSave();
            toast('完整项目已导入');
        }
    }
}
catch (error) {
    toast(error.message, true);
}
finally {
    input.value = '';
} });
document.querySelectorAll('[data-tool]').forEach(button => { button.innerHTML = icon({ select: 'pointer', pan: 'hand', polygon: 'polygon', hole: 'hole', calibrate: 'ruler', wall: 'wall', rectangle: 'rectangle', circle: 'circle', arc: 'arc', boundary: 'boundary' }[button.dataset.tool]); button.addEventListener('click', () => { threeViewer?.cancel(); openingPositionInteraction.cancel(); viewer.setTool(button.dataset.tool); }); });
const buttonIcons = { undo: 'undo', redo: 'redo', 'open-project': 'folder', settings: 'settings', 'collapse-left': 'collapse', 'zoom-in': 'plus', 'zoom-out': 'minus', fit: 'fit', recognize: 'scan' };
for (const [id, symbol] of Object.entries(buttonIcons))
    $('#' + id).innerHTML = icon(symbol, id === 'collapse-left' ? 14 : 18);
$('#upload').innerHTML = icon('upload', 17) + '上传图纸';
$('#upload').addEventListener('click', () => $('#drawing-file').click());
$('#demo').addEventListener('click', demo);
$('#draw-plan').innerHTML = icon('wall', 17) + '开始画平面图';
$('#draw-plan').addEventListener('click', startPlan);
$('#show-all-levels').addEventListener('click', () => { cancelEditing(); update(next => next.view.levelMode = next.view.levelMode === 'active' ? 'all' : 'active', { history: false }); });
$('#show-ceilings').addEventListener('click', () => { cancelEditing(); update(next => next.view.ceilings = !next.view.ceilings, { history: false }); });
$('#plan-controls [data-action="room-template"]').innerHTML = icon('rectangle', 17);
$('#wall-length-form').addEventListener('submit', event => { event.preventDefault(); const direction = $('#wall-direction').value; viewer.addWallByLength(Number($('#wall-length').value), direction === 'angle' ? Number($('#wall-angle').value) : direction); });
$('#wall-direction').addEventListener('change', () => { $('#wall-angle-field').hidden = $('#wall-direction').value !== 'angle'; });
$('#wall-done').addEventListener('click', () => { viewer.finishWalls(); viewer.setTool('select'); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
$('#cutaway').addEventListener('click', () => { cancelEditing(); cutaway = !cutaway; threeViewer?.setCutaway(cutaway); $('#cutaway').textContent = cutaway ? '恢复墙高' : '低墙查看'; $('#cutaway').setAttribute('aria-pressed', String(cutaway)); });
$('#capture-3d').addEventListener('click', capture3D);
$('#calibration').addEventListener('click', calibrations);
$('#pdf-pages').addEventListener('click', pdfPages);
$('#settings').addEventListener('click', settings);
$('#project-overview').innerHTML = icon('layers', 14) + '<span>工程总览</span>';
$('#project-overview').addEventListener('click', projectOverview);
function openCosts() {
    routeDone = null;
    $('#route-controls').hidden = true;
    cancelEditing();
    openCostWorkbench(project, { getProject: () => project, getMaterials: () => materials,
        onChange: (mutator, settings) => update(next => { mutator(next); next.cost ??= {}; next.cost.updatedAt = new Date().toISOString(); }, { history: settings?.history }),
        toast, requestRoute: callback => {
            if (!project.drawing || !project.calibration.metersPerPixel) {
                toast('请先绘制平面图或校准底图；也可以直接输入道路长度。', true);
                return;
            }
            closeCostWorkbench();
            routeDone = callback;
            switchView('2d');
            viewer.setTool('route');
            $('#route-controls').hidden = false;
        } });
}
bindCostWorkbench();
$('#open-cost').addEventListener('click', openCosts);
$('#route-finish').addEventListener('click', () => viewer.finish());
function cancelRoute() { routeDone = null; cancelEditing(); $('#route-controls').hidden = true; openCosts(); showCostTab('municipal'); }
$('#route-cancel').addEventListener('click', cancelRoute);
window.addEventListener('keydown', event => {
    if (routeDone && event.key === 'Escape' && !$('dialog[open]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRoute();
    }
}, { capture: true });
$('#export').addEventListener('click', exports);
$('#save').addEventListener('click', () => save());
$('#open-project').addEventListener('click', openProjects);
$('#quote-details').addEventListener('click', quoteDetails);
$('#recognize').addEventListener('click', recognize);
$('#zoom-in').addEventListener('click', () => viewMode === '3d' ? threeViewer?.zoom(1.2) : viewer.zoom(1.2));
$('#zoom-out').addEventListener('click', () => viewMode === '3d' ? threeViewer?.zoom(1 / 1.2) : viewer.zoom(1 / 1.2));
$('#fit').addEventListener('click', () => viewMode === '3d' ? threeViewer?.fit() : viewer.fit());
$('#collapse-left').addEventListener('click', () => { $('.workspace').classList.toggle('left-collapsed'); setTimeout(() => viewMode === '3d' ? threeViewer?.fit() : viewer.fit(), 200); });
function undo(redo = false) { cancelEditing(); if (redo ? history.canRedo() : history.canUndo()) {
    const mode = workspaceMode();
    project = (redo ? history.redo() : history.undo());
    if (canDecorate() || mode === 'plan' || ['civil', 'municipal'].includes(mode) && project.drawing)
        project.workspaceMode = mode;
    else
        project.workspaceMode = 'plan';
    history.replace(project);
    if (!project.regions.some(r => r.id === selectedId))
        selectedId = null;
    if (!project.walls?.some(w => w.id === selectedWallId))
        selectedWallId = null;
    if (!project.openings?.some(o => o.id === selectedOpeningId))
        selectedOpeningId = null;
    if (!project.furniture?.some(item => item.id === selectedFurnitureId))
        selectedFurnitureId = null;
    if (!project.serviceRoutes?.some(route => route.id === selectedServiceId))
        selectedServiceId = null;
    if (!project.civilElements?.some(item => item.id === selectedCivilId))
        selectedCivilId = null;
    $('#project-name').value = project.name;
    render();
    scheduleSave();
} }
$('#undo').addEventListener('click', () => undo());
$('#redo').addEventListener('click', () => undo(true));
window.addEventListener('keydown', event => {
    if (event.defaultPrevented || $('dialog[open]'))
        return;
    if (uploading)
        return;
    const editable = event.target.closest('input,select,textarea,[contenteditable]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
        return;
    }
    if (editable)
        return;
    if (isCostWorkbenchOpen() && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'))
        return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo(event.shiftKey);
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedWallShape()) {
        event.preventDefault();
        $(`[data-action="delete-wall-shape"][data-id="${CSS.escape(selectedWallShape().id)}"]`)?.click();
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedFurnitureId) {
        event.preventDefault();
        cancelEditing();
        update(next => { next.furniture = next.furniture.filter(item => item.id !== selectedFurnitureId); selectedFurnitureId = null; });
        toast('家具已移除，可撤销恢复');
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedServiceId) {
        event.preventDefault();
        $(`[data-action="delete-service"][data-id="${CSS.escape(selectedServiceId)}"]`)?.click();
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMunicipalId) {
        event.preventDefault();
        $(`[data-action="delete-municipal"][data-id="${CSS.escape(selectedMunicipalId)}"]`)?.click();
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCivilId) {
        event.preventDefault();
        $(`[data-action="delete-civil"][data-id="${CSS.escape(selectedCivilId)}"]`)?.click();
    }
    else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedWallId) {
            event.preventDefault();
            if (selectedWallShape())
                $('#inspector [data-action="delete-wall-shape"]').click();
            else if (confirm('删除选中的墙线？可以撤销。')) {
                cancelEditing();
                changeWalls(next => { next.walls = next.walls.filter(w => w.id !== selectedWallId); next.openings = (next.openings || []).filter(o => o.wallId !== selectedWallId); });
            }
        }
        else if (viewer.deleteVertex())
            event.preventDefault();
        else if (selectedId) {
            event.preventDefault();
            const region = selectedRegion();
            if (region.source === 'walls') {
                toast('自动房间由墙线维护，请选中墙线编辑。');
                return;
            }
            if (confirm(`删除“${region.name}”？可以撤销。`))
                update(next => { next.regions = next.regions.filter(r => r.id !== selectedId); selectedId = null; });
        }
    }
    else if (!event.ctrlKey && !event.metaKey) {
        const tool = { v: 'select', h: 'pan', p: 'polygon', o: 'hole', r: 'calibrate', w: 'wall', b: 'rectangle', c: 'circle', a: 'arc' }[event.key.toLowerCase()];
        if (tool) {
            if (['civil', 'municipal'].includes(workspaceMode()) && !['select', 'pan', 'calibrate'].includes(tool))
                return;
            if (viewMode === '3d') {
                if (['wall', 'rectangle', 'circle', 'arc'].includes(tool))
                    switchView('2d').then(() => viewer.setTool(tool));
            }
            else
                viewer.setTool(tool);
        }
    }
});
let dragCount = 0;
window.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files'))
    event.preventDefault(); });
$('#stage').addEventListener('dragenter', event => { if ([...event.dataTransfer.types].includes('Files')) {
    event.preventDefault();
    dragCount++;
    $('#drop-overlay').hidden = false;
} });
$('#stage').addEventListener('dragleave', () => { dragCount--; if (dragCount <= 0)
    $('#drop-overlay').hidden = true; });
$('#stage').addEventListener('drop', event => { event.preventDefault(); dragCount = 0; $('#drop-overlay').hidden = true; const file = event.dataTransfer.files[0]; if (file)
    upload(file); });
window.addEventListener('beforeunload', event => { if ((project.drawing || project.cost) && signature(project) !== savedSignature) {
    event.preventDefault();
    event.returnValue = '';
} });
render();
viewer.setTool('select');
// A read-only inspection hook helps integration tests verify the same data shown in the UI.
window.planStudio = { getProject: () => copy(project), getQuote: () => copy(quote), getCostItems: () => copy(getCostItems(project)), getCostSummary: () => copy(getCostSummary(project)), getViewport: () => ({ ...viewer.view }), toScreen: (point) => viewer.toScreen(point), get3DStats: () => threeViewer?.getStats() || null, get2DWallSelection: () => viewer.getWallSelection(), getSelection: () => ({ municipalElementId: selectedMunicipalId, regionId: selectedId, wallId: selectedWallId, openingId: selectedOpeningId, furnitureId: selectedFurnitureId, serviceRouteId: selectedServiceId, civilElementId: selectedCivilId }), getWorkspaceMode: () => workspaceMode(), toScreen3D: (point) => threeViewer?.projectToScreen(point), getViewMode: () => viewMode };
window.planStudio.getServiceRoutes = () => copy(project.serviceRoutes ?? []);
window.planStudio.getProjectBudget = () => copy(calculateProjectBudget(project));
window.planStudio.getPriceRows = () => copy(collectProjectPriceRows(project));
window.planStudio.getQuantities = () => copy(calculateProjectQuantities(project));
window.planStudio.getMunicipalConnections = () => copy(municipalConnectionPorts(project));
window.planStudio.getWallFootprints = () => copy(wallFootprints(project.walls || [], project.wallJoinStyle ?? 'square'));
window.planStudio.getLevels = () => levelProjects(project).map(level => ({ id: level.id, name: level.name, elevation: level.elevation, height: level.height, slabThickness: level.slabThickness }));
window.planStudio.getFurnitureRotationHandle = () => copy(viewer.getFurnitureRotationHandle());
window.planStudio.getCivilElements = () => copy(project.civilElements ?? []);
window.planStudio.getMunicipalElements = () => copy(project.municipalElements ?? []);
window.planStudio.getMunicipalVertexHandles = () => copy(viewer.getMunicipalVertexHandles());
window.planStudio.getFurnitureResizeHandles = () => copy(viewer.getFurnitureResizeHandles());
window.planStudio.getCivilResizeHandles = () => copy(viewer.getCivilResizeHandles());
window.planStudio.getIncomingStairs = () => incomingStairs(project).map(source => ({ id: source.item.id, kind: source.item.kind, levelId: source.levelId, levelName: source.levelName, elevation: source.elevation }));
window.planStudio.getFloorGeometry = () => copy(effectiveLevelProject(project).regions.map(region => ({ id: region.id, parts: region.surfaceParts ?? [{ points: region.points, holes: region.holes }], metrics: regionMetrics(region, project.calibration) })));
window.planStudio.getMaterials = () => copy(materials);
window.planStudio.getSourceRows = () => copy(collectProjectSourceRows(project));
//# sourceMappingURL=app.js.map