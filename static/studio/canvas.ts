import type { Furniture, Point, Project, Region, Tool, FloorOpening, FloorOpeningShape, ServicePoint, ServiceRoute, CivilElement } from './types.js';
import { pointInRegion, regionMetrics, regionInteriorPoint, validateRegion } from './lib/geometry.js';
import { snapRoomTranslation, translateRegion } from './lib/plan-authoring.js';
import { snapWallPoint } from './lib/wall-plan.js';
import { furnitureContains, furnitureFootprint, furnitureScale, clampFurniturePosition } from './lib/furniture.js';
import { buildWallSolid, type WallOpening } from './lib/wall-solid.js';
import { projectWallSelection } from './lib/wall-selection.js';
import { wallFootprints } from './lib/wall-joins.js';
import { circleFromPoints, arcThroughPoints, type DrawingShape } from './lib/drawing-shapes.js';
import { validateProjectBoundary, validatePlanBoundary, validateRegionWithinBoundary } from './lib/plan-boundary.js';
import { projectWallShapeSelection } from './lib/wall-shape-selection.js';
import { rotationHandle, rotationFromPointer } from './lib/furniture-rotation.js';
import { activeLevel, levelProjects } from './lib/levels.js';
import { openingShape, snapOpeningPoint, openingRegionParts } from './lib/floor-openings.js';
import { isStairKind, stairPlanGeometry } from './lib/stairs.js';
import { incomingStairs } from './lib/stair-links.js';
import { servicePreset, serviceMetrics, validateServiceRoutes } from './lib/services.js';
import { serviceRouteAt, serviceVertexAt, snapServicePoint } from './lib/service-interaction.js';
import { isFixtureKind, fixtureWallPlacement } from './lib/fixtures.js';
import { furnitureResizeHandles, furnitureResizeFromPointer, type FurnitureResizePatch, type ResizeKey } from './lib/furniture-resize.js';
import { civilFootprint, civilParts, civilResolvedElement, CIVIL_PRESETS } from './lib/civil.js';
import { openingAtPlanPoint, openingPlanPoint, openingPositionFromPlanDrag, openingPositionValidity } from './lib/opening-interaction.js';
import { isMunicipalPath, isMunicipalPolygon, municipalPreset, municipalFootprints, municipalScale, validateMunicipalElements, type MunicipalElement, type MunicipalKind, type MunicipalPoint, type RoadLayout } from './lib/municipal-design.js';
import { municipalAtPoint, municipalVertexAt, snapMunicipalPoint, paintMunicipal } from './municipal-canvas.js';
import { snapMunicipalConnection, type MunicipalConnectionPort, type MunicipalConnectionSnap } from './lib/municipal-connections.js';
import { paintTerrain } from './terrain-render.js';
import { compileTerrain } from './lib/terrain.js';

export type CivilTransformPatch = Partial<Pick<CivilElement,'position'|'width'|'depth'|'rotation'|'sourceRegionId'>>;
export type MunicipalDraftSettings = { roadLayout?: RoadLayout; width?: number; depth?: number; height?: number; elevation?: number; catalogId?: string; rotation?: number };

type Callbacks = {
  select: (id: string | null) => void;
  create: (points: Point[], hole: boolean) => void;
  preview: (id: string, points: Point[], holes: Point[][]) => void;
  commit: (id: string, points: Point[], holes: Point[][]) => void;
  calibrate: (points: Point[]) => void;
  error: (message: string) => void;
  status: (message: string, zoom: number) => void;
  tool: (tool: Tool) => void;
  wall?: (start: Point, end: Point) => void;
  selectWall?: (id: string | null, side?: 'left' | 'right') => void;
  selectFurniture?: (id: string | null) => void;
  previewFurniture?: (id: string, position: Point) => void;
  commitFurniture?: (id: string, position: Point) => void;
  previewFurnitureResize?: (id: string, patch: FurnitureResizePatch) => void;
  commitFurnitureResize?: (id: string, patch: FurnitureResizePatch) => void;
  placeFurniture?: (kind: Furniture['kind'], position: Point) => void;
  selectOpening?: (id: string | null) => void;
  previewOpening?: (id: string, patch: Pick<WallOpening,'offset'|'bottom'>) => void;
  commitOpening?: (id: string, patch: Pick<WallOpening,'offset'|'bottom'>) => void;
  route?: (points: Point[]) => void;
  shape?: (shape: DrawingShape) => void;
  boundary?: (points: Point[]) => void;
  floorOpening?: (regionId: string, opening: Pick<FloorOpening,'points'|'holes'|'shape'>) => void;
  selectIncomingStair?: (levelId: string, id: string) => void;
  previewRotation?: (id: string, rotation: number) => void;
  commitRotation?: (id: string, rotation: number) => void;
  serviceRoute?: (points: Point[]) => void;
  selectService?: (id: string | null) => void;
  previewService?: (id: string, points: ServicePoint[]) => void;
  commitService?: (id: string, points: ServicePoint[]) => void;
  selectCivil?: (id: string | null) => void;
  placeCivil?: (kind: CivilElement['kind'], position: Point) => void;
  previewCivil?: (id: string, patch: CivilTransformPatch) => void;
  commitCivil?: (id: string, patch: CivilTransformPatch) => void;
  selectMunicipal?: (id: string | null) => void;
  createMunicipal?: (kind: MunicipalKind, points: MunicipalPoint[], settings?: MunicipalDraftSettings) => void;
  previewMunicipal?: (id: string, points: MunicipalPoint[]) => void;
  commitMunicipal?: (id: string, points: MunicipalPoint[]) => void;
};
const clonePoints = (points: Point[]) => points.map(p => ({ ...p }));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const floorHoleTool = (tool: Tool) => tool.startsWith('floor-hole');
const floorHoleShape = (tool: Tool): FloorOpeningShape => tool === 'floor-hole' ? 'polygon' : tool.slice('floor-hole-'.length) as FloorOpeningShape;

export class DrawingViewer {
  private ctx: CanvasRenderingContext2D;
  project: Project;
  selectedId: string | null = null;
  tool: Tool = 'select';
  view = { zoom: 1, panX: 0, panY: 0 };
  private image: HTMLImageElement | null = null;
  private imageKey = '';
  private width = 0;
  private height = 0;
  private dpr = window.devicePixelRatio || 1;
  private raf = 0;
  private draft: Point[] = [];
  private cursor: Point | null = null;
  private calibrationPoints: Point[] = [];
  private space = false;
  private activeVertex: { hole: number; index: number } | null = null;
  private drag: { kind: 'pan' | 'vertex' | 'region' | 'rectangle' | 'furniture' | 'rotation' | 'resize' | 'civil-move' | 'civil-rotation' | 'civil-resize' | 'wall-opening' | 'floor-opening' | 'service' | 'municipal-vertex' | 'municipal-move' | 'municipal-draw'; municipal?:MunicipalElement; municipalIndex?:number; municipalSettings?:MunicipalDraftSettings; municipalAnchorPort?:MunicipalConnectionPort|null; pointerId: number; start: Point; furniture?: Furniture; civil?: CivilElement; opening?: WallOpening; resizeKey?: ResizeKey; service?: ServiceRoute; serviceIndex?: number; view?: typeof this.view; region?: Region; vertex?: { hole: number; index: number }; points?: Point[]; holes?: Point[][]; changed?: boolean; end?: Point; valid?: boolean } | null = null;
  private candidates: Region[] = [];
  private guides: Array<{ axis: 'x' | 'y'; value: number }> = [];
  private rectanglePoints: Point[] = [];
  private wallStart: Point | null = null;
  private selectedWallId: string | null = null;
  private selectedOpeningId: string | null = null;
  private selectedFurnitureId: string | null = null;
  private selectedServiceId: string | null = null;
  private selectedCivilId: string | null = null;
  private selectedMunicipalId: string | null = null;
  private municipalKind: MunicipalKind | null = null;
  private municipalSettings: MunicipalDraftSettings = {};
  private municipalBaseSettings: MunicipalDraftSettings = {};
  private municipalAnchorPort: MunicipalConnectionPort | null = null;
  private municipalConnection: MunicipalConnectionSnap | null = null;
  private selectedWallSide: 'left' | 'right' | null = null;
  private selectedWallIds: string[] = [];
  private footprintsKey = '';
  private footprints: ReturnType<typeof wallFootprints> = [];
  private wallSelectionKey = '';
  private wallSelectionProjection: ReturnType<typeof projectWallSelection> | null = null;
  private furnitureTemplate: Pick<Furniture, 'kind' | 'name' | 'width' | 'depth' | 'height'> | null = null;
  private civilTemplate: Pick<CivilElement,'kind'|'name'|'width'|'depth'|'height'> | null = null;
  private floorOpeningDraft: Pick<FloorOpening,'points'|'holes'|'shape'> | null = null;
  private holeInnerRatio = .45;
  setHoleInnerRatio(ratio: number) { this.holeInnerRatio = Math.max(.05, Math.min(.9, ratio)); this.paintSoon(); }
  private native() { return this.project?.drawing?.type === 'plan'; }

  constructor(private canvas: HTMLCanvasElement, private callbacks: Callbacks) {
    this.ctx = canvas.getContext('2d');
    canvas.tabIndex = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    canvas.addEventListener('pointermove', event => this.pointerMove(event));
    canvas.addEventListener('pointerup', event => this.pointerUp(event));
    canvas.addEventListener('pointercancel', event => { if (!this.drag || this.drag.pointerId === event.pointerId) this.cancelDrag(); });
    canvas.addEventListener('lostpointercapture', event => { if (this.drag?.pointerId === event.pointerId) this.cancelDrag(); });
    canvas.addEventListener('dblclick', event => { if (['polygon','hole','floor-hole','route','service-route','municipal'].includes(this.tool)) { event.preventDefault(); this.finish(); } });
    canvas.addEventListener('wheel', event => { event.preventDefault(); this.zoomAt(Math.exp(-event.deltaY * .0012), this.screen(event)); }, { passive: false });
    canvas.addEventListener('contextmenu', event => { event.preventDefault(); this.removeDraftPoint(); });
    window.addEventListener('keydown', event => this.keydown(event));
    window.addEventListener('keyup', event => { if (event.code === 'Space') { this.space = false; this.updateCursor(); } });
    window.addEventListener('blur', () => { this.space = false; this.cancelDrag(); });
    this.resize();
  }

  setProject(project: Project, selectedId = this.selectedId) {
    const drawing = project.drawing;
    const key = drawing ? `${drawing.id}:${drawing.page}:${drawing.url}` : '';
    const contextChanged = key !== this.imageKey || (this.project && (project.id !== this.project.id || project.activeLevelId !== this.project.activeLevelId));
    const selected = project.regions.find(region => region.id === selectedId);
    const furnitureDrag = ['furniture','rotation','resize'].includes(this.drag?.kind);
    const civilDrag = ['civil-move','civil-rotation','civil-resize'].includes(this.drag?.kind);
    const openingDrag=this.drag?.kind==='wall-opening';
    const municipalDrag=['municipal-vertex','municipal-move'].includes(this.drag?.kind);
    const municipalDragValid=municipalDrag&&project.municipalElements?.some(item=>item.id===this.drag.municipal.id&&!item.hidden&&!item.locked);
    const furnitureDragValid = furnitureDrag && project.furniture?.some(item => item.id === this.drag.furniture.id && !item.hidden && !item.locked);
    const civilDragValid = civilDrag && project.civilElements?.some(item => item.id === this.drag.civil.id && !item.hidden && !item.locked && !item.sourceRegionId);
    const openingDragValid=openingDrag&&project.openings?.some(opening=>opening.id===this.drag.opening.id&&!opening.locked&&opening.wallId===this.drag.opening.wallId)&&project.walls?.some(wall=>wall.id===this.drag.opening.wallId);
    if (contextChanged || selectedId !== this.selectedId || furnitureDrag&&!furnitureDragValid || civilDrag&&!civilDragValid || openingDrag&&!openingDragValid || municipalDrag&&!municipalDragValid || !municipalDragValid&&!furnitureDragValid&&!civilDragValid&&!openingDragValid && selectedId !== null && (!selected || selected.hidden)) {
      this.cancelDrag(!contextChanged);
      this.activeVertex = null;
      if (contextChanged || this.tool === 'hole' || floorHoleTool(this.tool)) {
        this.tool = 'select'; this.draft = []; this.calibrationPoints = []; this.cursor = null;
        if (contextChanged) { this.wallStart = null; this.selectedWallId = null; this.furnitureTemplate = null; this.civilTemplate = null; this.municipalKind = null; this.municipalSettings = {}; this.municipalBaseSettings = {}; this.municipalAnchorPort = null; this.municipalConnection = null; }
        this.callbacks.tool('select');
      }
      this.updateCursor();
    }
    this.project = project;
    this.selectedId = selected ? selectedId : null;
    if (key !== this.imageKey) {
      this.imageKey = key;
      this.image = null;
      if (drawing?.type === 'plan') this.fit();
      else if (drawing) {
        const image = new Image();
        image.onload = () => { if (this.imageKey !== key) return; this.image = image; this.fit(); };
        image.onerror = () => { if (this.imageKey === key) this.callbacks.error('图纸无法显示，请重新上传或重新打开项目。'); };
        image.src = drawing.url;
      }
    }
    this.paintSoon();
  }

  setTool(tool: Tool) {
    if(this.project?.workspaceMode==='municipal'&&!['select','pan','municipal','calibrate'].includes(tool)){this.callbacks.error('请切换到「绘图」或「装修」，再使用对应工具。');return;}
    if(this.project?.workspaceMode==='civil'&&!['select','pan','civil','calibrate'].includes(tool)){this.callbacks.error('请切换到「绘图」或「装修」，再使用对应工具。');return;}
    if (this.project?.workspaceMode === 'decoration' && (floorHoleTool(tool) || ['wall', 'rectangle', 'polygon', 'hole', 'circle', 'arc', 'boundary'].includes(tool))) { this.callbacks.error('请先点击顶部「绘图」，再修改户型边界。'); return; }
    if (!this.native() && ['circle', 'arc', 'boundary'].includes(tool)) { this.callbacks.error('请先新建二维平面图，再绘制圆墙、圆弧或边界。'); return; }
    if (this.native() && (tool === 'polygon' || tool === 'hole')) { this.callbacks.error('直接绘图模式请使用墙线或矩形墙线；内圈墙线可生成孔洞。'); return; }
    if (this.native() && tool === 'calibrate') { this.callbacks.error('绘图模式使用真实尺寸，无需比例校准。'); return; }
    if (!this.native() && tool === 'rectangle') { this.callbacks.error('请先新建二维平面图，再拖拽绘制房间。'); return; }
    if (!this.native() && tool === 'wall') { this.callbacks.error('请先新建二维平面图，再绘制墙线。'); return; }
    if (tool === 'hole' && !this.project?.regions.some(region => region.id === this.selectedId && !region.hidden)) { this.callbacks.error('先选择一个可见区域，再绘制扣除孔洞。'); return; }
    if (floorHoleTool(tool) && (!this.native() || !this.project?.regions.some(region => region.id === this.selectedId && !region.hidden))) { this.callbacks.error('先选择本层房间，再绘制楼板洞。'); return; }
    if (!this.project?.drawing && tool !== 'select' && tool !== 'pan') { this.callbacks.error('先上传一张图纸。'); return; }
    if (tool === 'municipal' && !municipalScale(this.project)) { this.callbacks.error('先校准图纸比例，再按实际尺寸绘制市政设施。'); return; }
    if (tool === 'civil' && !furnitureScale(this.project)) { this.callbacks.error('先校准图纸比例，再按实际尺寸放置土建构件。'); return; }
    this.cancelDrag();
    this.tool = tool;
    this.draft = [];
    this.calibrationPoints = [];
    this.wallStart = null;
    this.activeVertex = null;
    if (tool !== 'furniture') this.furnitureTemplate = null;
    if (tool !== 'civil') this.civilTemplate = null;
    this.municipalAnchorPort = null; this.municipalConnection = null;
    if (tool !== 'municipal') this.municipalKind = null;
    this.callbacks.tool(tool);
    this.updateCursor();
    this.paintSoon();
  }

  setCandidates(regions: Region[]) { this.candidates = regions; this.paintSoon(); }
  setSelectedWall(id: string | null, side: 'left' | 'right' | null = null) { this.selectedWallId = id; this.selectedWallSide = side; this.paintSoon(); }
  setSelectedWallGroup(ids: string[] = []) { this.selectedWallIds = [...ids]; this.paintSoon(); }
  setSelectedOpening(id: string | null) { if(id!==this.selectedOpeningId&&this.drag?.kind==='wall-opening')this.cancelDrag();this.selectedOpeningId = id; this.paintSoon(); }
  setSelectedFurniture(id: string | null) { if (id !== this.selectedFurnitureId && ['furniture','rotation','resize'].includes(this.drag?.kind)) this.cancelDrag(); this.selectedFurnitureId = id; this.paintSoon(); }
  setSelectedService(id: string | null) { if (id !== this.selectedServiceId && this.drag?.kind === 'service') this.cancelDrag(); this.selectedServiceId = id; this.paintSoon(); }
  setSelectedCivil(id: string | null) { if(id!==this.selectedCivilId&&['civil-move','civil-rotation','civil-resize'].includes(this.drag?.kind))this.cancelDrag();this.selectedCivilId=id;this.paintSoon(); }
  setSelectedMunicipal(id:string|null){if(id!==this.selectedMunicipalId&&['municipal-vertex','municipal-move'].includes(this.drag?.kind))this.cancelDrag();this.selectedMunicipalId=id;this.paintSoon();}
  getMunicipalVertexHandles(){const item=this.project?.municipalElements?.find(item=>item.id===this.selectedMunicipalId&&!item.hidden&&!item.locked);return item?item.points.map((point,index)=>({index,...this.toScreen(point)})):[];}
  setMunicipalDraftSettings(settings: MunicipalDraftSettings) { this.municipalSettings = structuredClone(settings); this.municipalBaseSettings = structuredClone(settings); this.paintSoon(); }
  getMunicipalDraftSettings(): MunicipalDraftSettings { return structuredClone(this.municipalSettings); }
  getMunicipalDraftKind(): MunicipalKind | null { return this.tool === 'municipal' ? this.municipalKind : null; }
  beginMunicipalDrawing(kind:MunicipalKind,settings:MunicipalDraftSettings={}){this.setTool('municipal');if(this.tool!=='municipal')return;this.municipalKind=kind;this.setMunicipalDraftSettings(settings);this.cursor=null;this.paintSoon();}
  getFurnitureRotationHandle() { const item=this.project?.furniture?.find(item=>item.id===this.selectedFurnitureId&&!item.hidden&&!item.locked);return item ? this.toScreen(rotationHandle(item,this.project,this.view.zoom)) : null; }
  getFurnitureResizeHandles() { const item=this.project?.furniture?.find(item=>item.id===this.selectedFurnitureId&&!item.hidden);return item?furnitureResizeHandles(item,this.project).map(handle=>({key:handle.key,cursor:handle.cursor,...this.toScreen(handle.point)})):[]; }
  getCivilResizeHandles() { const item=this.project?.civilElements?.find(item=>item.id===this.selectedCivilId&&!item.hidden);return item&&!item.sourceRegionId?furnitureResizeHandles(item,this.project).map(handle=>({key:handle.key,cursor:handle.cursor,...this.toScreen(handle.point)})):[]; }
  getCivilRotationHandle() { const item=this.project?.civilElements?.find(item=>item.id===this.selectedCivilId&&!item.hidden&&!item.locked&&!item.sourceRegionId);return item?this.toScreen(rotationHandle(item,this.project,this.view.zoom)):null; }
  beginFurniturePlacement(template: Pick<Furniture, 'kind' | 'name' | 'width' | 'depth' | 'height'>) { this.setTool('furniture'); this.furnitureTemplate = { ...template }; this.cursor = null; this.paintSoon(); }
  beginCivilPlacement(template: Pick<CivilElement,'kind'|'name'|'width'|'depth'|'height'>) {this.setTool('civil');if(this.tool!=='civil')return;this.civilTemplate={...template};this.cursor=null;this.paintSoon();}
  getWallSelection() {
    const wall = this.project?.walls?.find(wall => wall.id === this.selectedWallId);
    if (!wall) return null;
    const side = this.selectedWallSide || wall.finishSide || 'both';
    const key = JSON.stringify([this.project.walls, this.project.openings, this.project.wallHeight, this.project.wallJoinStyle, wall.id, side, this.selectedWallIds]);
    if (key !== this.wallSelectionKey) { const surfaces = buildWallSolid(this.project).surfaces; this.wallSelectionProjection = this.selectedWallIds.length ? projectWallShapeSelection(surfaces, this.selectedWallIds, side) : projectWallSelection(surfaces, wall.id, side); this.wallSelectionKey = key; }
    return structuredClone(this.wallSelectionProjection);
  }
  finishWalls() { this.wallStart = null; this.setTool('select'); }
  /** Exact real-length entry bypasses grid rounding and leaves the next wall ready. */
  addWallByLength(meters: number, direction: 'right' | 'down' | 'left' | 'up' | number): boolean {
    try {
      if (!this.native()) throw new Error('请先新建二维平面图。');
      if (this.project?.workspaceMode === 'decoration'||this.project?.workspaceMode==='civil') throw new Error('请先点击顶部「绘图」，再继续画墙。');
      if (!Number.isFinite(meters) || meters < .1 || meters > 50) throw new Error('墙长须在 0.1–50 米之间。');
      const vectors = { right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1] };
      const vector = typeof direction === 'number' && Number.isFinite(direction) ? [Math.cos(direction * Math.PI / 180), Math.sin(direction * Math.PI / 180)] : vectors[direction]; if (!vector) throw new Error('请选择有效的绘制方向。');
      const start = this.wallStart ? { ...this.wallStart } : { x: 200, y: 200 };
      const end = { x: start.x + vector[0] * meters * 100, y: start.y + vector[1] * meters * 100 };
      if (!this.onDrawing(start) || !this.onDrawing(end)) throw new Error('这段墙超出画布范围，请选择其他方向或长度。');
      if (!this.callbacks.wall) throw new Error('墙体编辑尚未连接，请重新打开工作台。');
      this.cancelDrag(); this.tool = 'wall'; this.draft = []; this.calibrationPoints = []; this.activeVertex = null;
      this.callbacks.tool('wall'); this.callbacks.wall(start, end); this.wallStart = end; this.cursor = { ...end };
      this.updateCursor(); this.paintSoon(); return true;
    } catch (error) { this.callbacks.error(error.message); return false; }
  }
  get hasWallDraft() { return !!this.wallStart; }
  get hasDraft() { return this.draft.length > 0 || this.calibrationPoints.length > 0 || !!this.wallStart || !!this.furnitureTemplate || !!this.civilTemplate || !!this.municipalKind; }
  get hasActiveVertex() { return !!this.activeVertex; }
  /** Transient geometry must not be persisted until a drag or drawing commits. */
  get isEditing() { return this.hasDraft || !!this.drag && this.drag.kind !== 'pan'; }

  private resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    this.width = box.width; this.height = box.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.paintSoon();
  }

  fit() {
    const drawing = this.project?.drawing;
    if (!drawing || !this.width || !this.height) return;
    if(this.project.workspaceMode==='municipal'){
      const terrainScale=municipalScale(this.project);
      const terrainBounds=this.project.municipalTerrain?.visible&&terrainScale?compileTerrain(this.project.municipalTerrain).bounds:null;
      const terrainPoints=terrainBounds?[{x:terrainBounds.minX/terrainScale,y:terrainBounds.minY/terrainScale},{x:terrainBounds.maxX/terrainScale,y:terrainBounds.maxY/terrainScale}]:[];
      const points=[...terrainPoints,...(this.project.municipalElements??[]).filter(item=>!item.hidden).flatMap(item=>municipalFootprints(item,this.project)?.flatMap(part=>part.points)??item.points)];
      if(points.length){
        const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)),scale=municipalScale(this.project)??.01,padding=8/scale;
        this.view.zoom=Math.max(.0001,Math.min((this.width-112)/(maxX-minX+padding),(this.height-164)/(maxY-minY+padding),2));
        this.view.panX=this.width/2-(minX+maxX)/2*this.view.zoom;this.view.panY=this.height/2+20-(minY+maxY)/2*this.view.zoom;
      }else if(this.native()){
        const width=Math.min(drawing.width,8000),height=Math.min(drawing.height,6000);
        this.view.zoom=Math.max(.0001,Math.min((this.width-112)/width,(this.height-164)/height,2));
        this.view.panX=(this.width-width*this.view.zoom)/2;this.view.panY=(this.height-height*this.view.zoom)/2+20;
      }else{
        this.view.zoom=Math.max(.0001,Math.min((this.width-112)/drawing.width,(this.height-164)/drawing.height,2));
        this.view.panX=(this.width-drawing.width*this.view.zoom)/2;this.view.panY=(this.height-drawing.height*this.view.zoom)/2;
      }
      this.paintSoon();return;
    }
    if(this.project.workspaceMode==='civil'){
      const points=(this.project.civilElements??[]).filter(item=>!item.hidden).flatMap(item=>civilParts(item,this.project)?.flatMap(part=>part.points)??[]);
      if(points.length){
        const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
        const padding=this.native()?160:160/(furnitureScale(this.project)??.01)*.01;
        this.view.zoom=Math.max(.04,Math.min((this.width-112)/(maxX-minX+padding),(this.height-128)/(maxY-minY+padding),2));
        this.view.panX=this.width/2-(minX+maxX)/2*this.view.zoom;this.view.panY=this.height/2-(minY+maxY)/2*this.view.zoom;
      }else{
        this.view.zoom=Math.max(.04,Math.min((this.width-112)/drawing.width,(this.height-128)/drawing.height,2));
        this.view.panX=(this.width-drawing.width*this.view.zoom)/2;this.view.panY=(this.height-drawing.height*this.view.zoom)/2;
      }
      this.paintSoon();return;
    }
    if (this.native() && (this.project.regions.length || this.project.walls?.length || this.project.planBoundary || this.project.furniture?.some(item => !item.hidden) || this.project.serviceRoutes?.some(route => !route.hidden) || this.project.civilElements?.some(item=>!item.hidden))) {
      const points = [...this.project.regions.flatMap(region => region.points), ...this.actualFootprints().flatMap(piece => piece.points), ...(this.project.furniture ?? []).filter(item => !item.hidden).flatMap(item => furnitureFootprint(item, this.project) ?? [item.position]), ...(this.project.serviceRoutes ?? []).filter(route => !route.hidden).flatMap(route => route.points), ...(this.project.civilElements??[]).filter(item=>!item.hidden).flatMap(item=>civilFootprint(item,this.project)??[item.position]), ...(!this.project.walls?.length ? this.project.planBoundary?.points || [] : [])];
      const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
      const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
      this.view.zoom = Math.max(.04, Math.min((this.width - 112) / (maxX - minX + 160), (this.height - 128) / (maxY - minY + 160), 2));
      this.view.panX = this.width / 2 - (minX + maxX) / 2 * this.view.zoom;
      this.view.panY = this.height / 2 - (minY + maxY) / 2 * this.view.zoom;
      this.paintSoon(); return;
    }
    this.view.zoom = Math.min((this.width - 112) / drawing.width, (this.height - 128) / drawing.height, 2);
    this.view.zoom = Math.max(.04, this.view.zoom);
    this.view.panX = (this.width - drawing.width * this.view.zoom) / 2;
    this.view.panY = (this.height - drawing.height * this.view.zoom) / 2;
    this.paintSoon();
  }

  /** Navigation changes only the viewport; the measured drawing coordinates stay intact. */
  focusSelection(): boolean {
    if (!this.project?.drawing || !this.width || !this.height) return false;
    let points: Point[] = [];
    const region = this.project.regions.find(region => region.id === this.selectedId);
    const furniture = this.project.furniture?.find(item => item.id === this.selectedFurnitureId);
    const service = this.project.serviceRoutes?.find(item => item.id === this.selectedServiceId);
    const civil = this.project.civilElements?.find(item => item.id === this.selectedCivilId);
    const municipal = this.project.municipalElements?.find(item => item.id === this.selectedMunicipalId);
    const opening = this.project.openings?.find(item => item.id === this.selectedOpeningId);
    if (municipal) points = municipalFootprints(municipal, this.project)?.flatMap(part => part.points) ?? municipal.points;
    else if (civil) points = civilParts(civil, this.project)?.flatMap(part => part.points) ?? [civil.position];
    else if (furniture) points = furnitureFootprint(furniture, this.project) ?? [furniture.position];
    else if (service) points = service.points;
    else if (opening) points = [openingPlanPoint(this.project, opening)];
    else if (this.selectedWallId) {
      const ids = new Set([this.selectedWallId, ...this.selectedWallIds]);
      points = this.actualFootprints().filter(part => ids.has(part.wallId)).flatMap(part => part.points);
    } else if (region) points = region.points;
    if (!points.length || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return false;
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    const scale = this.native() ? .01 : this.project.calibration.metersPerPixel;
    const context = scale ? 2 / scale : 80;
    this.view.zoom = Math.max(.0001, Math.min(4, Math.max(48, this.width - 144) / (maxX - minX + context), Math.max(48, this.height - 208) / (maxY - minY + context)));
    this.view.panX = this.width / 2 - (minX + maxX) / 2 * this.view.zoom;
    this.view.panY = this.height / 2 - (minY + maxY) / 2 * this.view.zoom;
    this.paintSoon();
    return true;
  }

  zoom(factor: number) { this.zoomAt(factor, { x: this.width / 2, y: this.height / 2 }); }
  private zoomAt(factor: number, point: Point) {
    if (!this.project?.drawing) return;
    const before = this.toWorld(point);
    this.view.zoom = Math.max(this.project.workspaceMode==='municipal'?.0001:.035, Math.min(12, this.view.zoom * factor));
    this.view.panX = point.x - before.x * this.view.zoom;
    this.view.panY = point.y - before.y * this.view.zoom;
    this.paintSoon();
  }
  toScreen(point: Point): Point { return { x: point.x * this.view.zoom + this.view.panX, y: point.y * this.view.zoom + this.view.panY }; }
  toWorld(point: Point): Point { return { x: (point.x - this.view.panX) / this.view.zoom, y: (point.y - this.view.panY) / this.view.zoom }; }
  private screen(event: PointerEvent | WheelEvent): Point { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  private bounded(point: Point): Point { const d = this.project.drawing; return { x: Math.max(0, Math.min(d.width, point.x)), y: Math.max(0, Math.min(d.height, point.y)) }; }
  private snapped(point: Point): Point { return this.bounded(this.native() ? { x: Math.round(point.x / 10) * 10, y: Math.round(point.y / 10) * 10 } : point); }
  private snappedOpening(point: Point): Point {
    const region = this.project.regions.find(region => region.id === this.selectedId);
    if (!region) return this.bounded(point);
    return snapOpeningPoint(this.bounded(point), region, 10 / this.view.zoom);
  }
  private onDrawing(point: Point): boolean { const d = this.project?.drawing; return !!d && point.x >= 0 && point.y >= 0 && point.x <= d.width && point.y <= d.height; }

  private actualFootprints() {
    const key = JSON.stringify([this.project.walls?.map(({id,start,end,thickness}) => ({id,start,end,thickness})), this.project.wallJoinStyle]);
    if (this.footprintsKey !== key) { this.footprints = wallFootprints(this.project.walls || [], this.project.wallJoinStyle ?? 'square'); this.footprintsKey = key; }
    return this.footprints;
  }
  private wallsFit(points: Point[], closed: boolean): boolean {
    if (!points.every(point => this.onDrawing(point))) return false;
    const count = closed ? points.length : points.length - 1;
    const walls = [...(this.project.walls || []), ...Array.from({length: count}, (_,i) => ({id:`preview-${i}`,start:points[i],end:points[(i+1)%points.length],thickness:Number(this.project.wallThickness || 20),height:Number(this.project.wallHeight || 280)}))];
    return validateProjectBoundary({...this.project,walls}).valid;
  }
  private snappedWall(point: Point, orthogonal = false): Point {
    const walls = this.project.walls || [], snapped = snapWallPoint(point,walls,this.view.zoom,this.wallStart || undefined,{orthogonal});
    // Preserve corner magnets. Clicking an actual wall body also connects to
    // its centreline, so geometric joins never rely on an arbitrary near band.
    if (!orthogonal && !walls.some(wall => [wall.start,wall.end].some(endpoint => dist(endpoint,snapped)<1e-6))) {
      const piece = this.actualFootprints().find(piece => pointInRegion(point,{points:piece.points,holes:[]}));
      const wall = piece && walls.find(wall => wall.id === piece.wallId);
      if (wall) { const dx=wall.end.x-wall.start.x,dy=wall.end.y-wall.start.y,t=Math.max(0,Math.min(1,((point.x-wall.start.x)*dx+(point.y-wall.start.y)*dy)/(dx*dx+dy*dy))); return this.bounded({x:wall.start.x+t*dx,y:wall.start.y+t*dy}); }
    }
    return this.bounded(snapped);
  }
  private wallAt(point: Point): string | null {
    const containing = this.actualFootprints().find(piece => pointInRegion(point,{points:piece.points,holes:[]}));
    if (containing) return containing.wallId;
    if (this.project.wallJoinStyle === 'clean') return null;
    let nearest = Infinity, id: string | null = null;
    for (const wall of this.project.walls || []) {
      const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, square = dx * dx + dy * dy;
      if (!square) continue;
      const t = Math.max(0, Math.min(1, ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / square));
      const distance = dist(point, { x: wall.start.x + dx * t, y: wall.start.y + dy * t });
      if (distance <= Math.max(8 / this.view.zoom, (wall.thickness || 20) / 2) && distance < nearest) { nearest = distance; id = wall.id; }
    }
    return id;
  }
  private rectangle(a: Point, b: Point): Point[] {
    const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y), maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y);
    return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  }

  private openingAt(point: Point): string | null {
    return openingAtPlanPoint(this.project,point,8/this.view.zoom,this.selectedOpeningId)?.id??null;
  }

  /** Screen-distance aids snap to exact geometric ports without rounding the
   * resulting coordinates or changing a user-selected carriageway width. */
  private municipalSnapped(point: Point, event: Pick<PointerEvent,'shiftKey'|'altKey'>, reference = this.draft.at(-1), excludedId?: string, kind = this.municipalKind, elevation?: number, widthCm?: number): Point {
    // Road connectivity is elevation-aware. Generic vertex magnets would
    // otherwise move an endpoint to a road on a different storey first.
    const snapProject = ['road','bridge','kerb'].includes(kind) ? {...this.project,municipalElements:[]} : this.project;
    let candidate = snapMunicipalPoint(snapProject,point,this.view.zoom,reference,event.shiftKey,event.altKey,excludedId);
    this.municipalConnection = null;
    if (event.altKey || !kind) return this.bounded(candidate);
    if (!event.shiftKey && !excludedId && this.municipalAnchorPort && this.draft.length === 1) {
      const anchor = this.draft[0], direction = this.municipalAnchorPort.direction;
      const dx = point.x - anchor.x, dy = point.y - anchor.y, along = dx * direction.x + dy * direction.y;
      if (along >= 0 && Math.abs(dx * direction.y - dy * direction.x) * this.view.zoom <= 12) {
        // Preserve the native centimetre grid along the approach axis, including
        // oblique axes. Screen round-off must not change an intended whole-cm
        // length merely because the endpoint is aligned to a connection.
        const station = this.project.drawing?.type === 'plan' ? Math.round(along) : along;
        candidate = { x: anchor.x + station * direction.x, y: anchor.y + station * direction.y };
      }
    }
    const snap = snapMunicipalConnection(this.project,kind,candidate,{tolerance:12/this.view.zoom,reference,excludedId,
      elevation:elevation ?? (this.draft.length ? this.municipalSettings.elevation : undefined), widthCm:widthCm ?? this.municipalSettings.width});
    if (snap && !(reference && dist(snap.point,reference) < 1e-7 && dist(candidate,reference) > 1e-7)) {
      const horizontal = reference && Math.abs(point.x-reference.x) >= Math.abs(point.y-reference.y);
      if (!event.shiftKey || !reference || (horizontal ? Math.abs(snap.point.y-reference.y) : Math.abs(snap.point.x-reference.x)) < 1e-7) {
        candidate = { x:snap.point.x,y:snap.point.y }; this.municipalConnection = snap;
      }
    }
    return this.bounded(candidate);
  }

  private inheritMunicipalConnection() {
    const port = this.municipalConnection?.port;
    this.municipalAnchorPort = port ? structuredClone(port) : null;
    if (!port) return;
    this.municipalSettings.elevation = port.elevation;
    if (['road','bridge'].includes(this.municipalKind) && !this.municipalSettings.roadLayout && this.municipalSettings.width === undefined) {
      this.municipalSettings.width = port.widthCm;
      if (port.roadLayout) this.municipalSettings.roadLayout = structuredClone(port.roadLayout);
    }
  }

  private pointerDown(event: PointerEvent) {
    if (!this.project?.drawing || this.drag || event.isPrimary === false) return;
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const screen = this.screen(event);
    const point = this.toWorld(screen);
    if (this.space || this.tool === 'pan' || event.button === 1 || event.button === 2 && !this.draft.length) {
      this.drag = { kind: 'pan', pointerId: event.pointerId, start: screen, view: { ...this.view } };
      this.canvas.setPointerCapture(event.pointerId); this.canvas.style.cursor = 'grabbing'; return;
    }
    if (event.button !== 0) return;
    if(this.tool==='municipal'&&this.municipalKind){
      if(!this.onDrawing(point))return;
      const kind=this.municipalKind,previous=clonePoints(this.draft),previousSettings=structuredClone(this.municipalSettings),previousAnchor=this.municipalAnchorPort?structuredClone(this.municipalAnchorPort):null,clicked=this.municipalSnapped(point,event);
      if(!isMunicipalPath(kind)&&!isMunicipalPolygon(kind)){try{this.callbacks.createMunicipal?.(kind,[clicked],structuredClone(this.municipalSettings));this.setTool('select');}catch(error){this.callbacks.error(error.message);}return;}
      if(isMunicipalPolygon(kind)&&this.draft.length>=3&&dist(screen,this.toScreen(this.draft[0]))<11){this.finish();return;}
      if(!this.draft.length)this.inheritMunicipalConnection();
      if(!this.draft.length||dist(clicked,this.draft.at(-1))>.5/this.view.zoom)this.draft.push(clicked);
      this.cursor=clicked;
      if(['road','bridge','kerb','fence'].includes(kind)){
        this.drag={kind:'municipal-draw',pointerId:event.pointerId,start:screen,points:previous,municipalSettings:previousSettings,municipalAnchorPort:previousAnchor,end:clicked,changed:false};
        this.canvas.setPointerCapture(event.pointerId);
      }
      this.paintSoon();return;
    }
    if (this.tool === 'boundary') {
      if (!this.onDrawing(point)) return;
      if (this.draft.length >= 3 && dist(screen, this.toScreen(this.draft[0])) < 11) { this.finish(); return; }
      if (!this.draft.length || dist(point,this.draft[this.draft.length-1]) > 1) this.draft.push(this.snapped(point));
      this.paintSoon(); return;
    }
    if (this.tool === 'circle' || this.tool === 'arc') {
      if (!this.onDrawing(point)) { this.callbacks.error('请在画板内绘制。'); return; }
      const clicked = this.tool === 'circle' ? this.snapped(point) : this.snappedWall(point, false);
      const complete = this.draft.length === (this.tool === 'circle' ? 1 : 2);
      if (complete) {
        try { const shape = this.tool === 'circle' ? circleFromPoints(this.draft[0],clicked,{maxSegments:200-(this.project.walls?.length || 0)}) : arcThroughPoints(this.draft[0],this.draft[1],clicked,{maxSegments:200-(this.project.walls?.length || 0)}); this.callbacks.shape?.(shape); this.setTool('select'); }
        catch (error) { this.callbacks.error(error.message); }
      } else if (!this.draft.length || dist(clicked,this.draft[this.draft.length-1]) > 1) this.draft.push(clicked);
      this.paintSoon(); return;
    }
    if (this.tool === 'furniture' && this.furnitureTemplate) {
      if (!this.onDrawing(point)) return;
      const item = { ...this.furnitureTemplate, position: point, rotation: 0 } as Furniture;
      try { this.callbacks.placeFurniture?.(item.kind, point); this.setTool('select'); }
      catch (error) { this.callbacks.error(error.message); }
      return;
    }
    if (this.tool === 'civil' && this.civilTemplate) {
      if(!this.onDrawing(point))return;
      try{this.callbacks.placeCivil?.(this.civilTemplate.kind,point);this.setTool('select');}
      catch(error){this.callbacks.error(error.message);}
      return;
    }
    if (this.tool === 'wall') {
      if (!this.onDrawing(point)) return;
      const end = this.snappedWall(point, event.shiftKey);
      if (this.wallStart) {
        if (dist(this.wallStart, end) < 10) { this.callbacks.error('墙段长度至少为 0.1 m。'); return; }
        try { this.callbacks.wall?.({ ...this.wallStart }, { ...end }); }
        catch (error) { this.callbacks.error(error.message); return; }
      }
      this.wallStart = end; this.paintSoon(); return;
    }
    if (this.tool === 'rectangle') {
      if (!this.onDrawing(point)) return;
      this.drag = { kind: 'rectangle', pointerId: event.pointerId, start: this.snapped(point), end: this.snapped(point), valid: false };
      this.rectanglePoints = [];
      this.canvas.setPointerCapture(event.pointerId); return;
    }
    if (this.tool === 'route' || this.tool === 'service-route') {
      if (!this.onDrawing(point)) return;
      const clicked = this.tool === 'service-route' ? snapServicePoint(this.project, point, this.view.zoom, this.draft.at(-1), event.shiftKey) : point;
      if (!this.draft.length || dist(clicked, this.draft[this.draft.length - 1]) > .5 / this.view.zoom) this.draft.push({ ...clicked });
      this.paintSoon(); return;
    }
    if (floorHoleTool(this.tool) && this.tool !== 'floor-hole') {
      if (!this.onDrawing(point)) return;
      const start = this.snappedOpening(point);
      this.drag = {kind:'floor-opening',pointerId:event.pointerId,start,end:start,valid:false};
      this.floorOpeningDraft = null;
      this.canvas.setPointerCapture(event.pointerId); this.paintSoon(); return;
    }
    if (this.tool === 'polygon' || this.tool === 'hole' || this.tool === 'floor-hole') {
      if (!this.onDrawing(point)) return;
      if (this.draft.length >= 3 && dist(screen, this.toScreen(this.draft[0])) < 11) { this.finish(); return; }
      const vertex = this.tool === 'floor-hole' ? this.snappedOpening(point) : this.snapped(point);
      if (!this.draft.length || dist(vertex, this.draft[this.draft.length - 1]) > .5 / this.view.zoom) this.draft.push(vertex);
      this.paintSoon(); return;
    }
    if (this.tool === 'calibrate') {
      if (!this.onDrawing(point) || this.calibrationPoints.length >= 2) return;
      this.calibrationPoints.push(point);
      if (this.calibrationPoints.length === 2) {
        if (dist(...this.calibrationPoints as [Point, Point]) < 1) { this.callbacks.error('两个校准点过近，请重新选择。'); this.calibrationPoints = []; }
        else this.callbacks.calibrate(clonePoints(this.calibrationPoints));
      }
      this.paintSoon(); return;
    }
    if(this.project.workspaceMode==='municipal'){
      const selected=this.project.municipalElements?.find(item=>item.id===this.selectedMunicipalId&&!item.hidden);
      const index=municipalVertexAt(selected,point,9/this.view.zoom);
      if(index!==null){this.drag={kind:'municipal-vertex',pointerId:event.pointerId,start:point,municipal:structuredClone(selected),municipalIndex:index,changed:false};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='move';return;}
      const hit=municipalAtPoint(this.project,point,8/this.view.zoom,this.selectedMunicipalId);this.callbacks.selectMunicipal?.(hit?.id??null);
      if(hit&&!hit.locked&&!hit.holes?.length){this.drag={kind:'municipal-move',pointerId:event.pointerId,start:point,municipal:structuredClone(hit),changed:false};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';}
      this.paintSoon();return;
    }
    if(this.project.workspaceMode==='civil'){
      const selected=this.project.civilElements?.find(item=>item.id===this.selectedCivilId&&!item.hidden&&!item.locked&&!item.sourceRegionId);
      const handle=this.getCivilResizeHandles().filter(handle=>dist(screen,handle)<=9).sort((a,b)=>dist(screen,a)-dist(screen,b))[0];
      if(selected&&handle){this.drag={kind:'civil-resize',pointerId:event.pointerId,start:point,civil:structuredClone(selected),resizeKey:handle.key,changed:false};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor=handle.cursor;this.paintSoon();return;}
      const rotate=this.getCivilRotationHandle();
      if(selected&&rotate&&dist(screen,rotate)<=11){this.drag={kind:'civil-rotation',pointerId:event.pointerId,start:point,civil:structuredClone(selected),changed:false};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='crosshair';this.paintSoon();return;}
      const hit=[...(this.project.civilElements??[])].reverse().find(item=>!item.hidden&&civilParts(item,this.project)?.some(part=>pointInRegion(point,part)));
      this.callbacks.selectCivil?.(hit?.id??null);
      if(hit&&!hit.locked&&!hit.sourceRegionId){this.drag={kind:'civil-move',pointerId:event.pointerId,start:point,civil:structuredClone(hit),changed:false};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';}
      this.paintSoon();return;
    }
    const service = this.project.serviceRoutes?.find(route => route.id === this.selectedServiceId);
    const serviceIndex = serviceVertexAt(service, point, this.view.zoom);
    if (serviceIndex !== null) {
      this.drag = { kind: 'service', pointerId: event.pointerId, start: point, service: structuredClone(service), serviceIndex, changed: false };
      this.canvas.setPointerCapture(event.pointerId); this.canvas.style.cursor = 'move'; this.paintSoon(); return;
    }
    const rotationItem=this.project.furniture?.find(item=>item.id===this.selectedFurnitureId&&!item.hidden&&!item.locked);
    const resizeHandle=this.getFurnitureResizeHandles().filter(handle=>dist(screen,handle)<=9).sort((a,b)=>dist(screen,a)-dist(screen,b))[0];
    if(rotationItem&&resizeHandle){
      this.drag={kind:'resize',pointerId:event.pointerId,start:point,furniture:structuredClone(rotationItem),resizeKey:resizeHandle.key,changed:false};
      this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor=resizeHandle.cursor;this.paintSoon();return;
    }
    if (rotationItem && dist(screen,this.toScreen(rotationHandle(rotationItem,this.project,this.view.zoom)))<=11) {
      this.drag={kind:'rotation',pointerId:event.pointerId,start:point,furniture:structuredClone(rotationItem),changed:false};
      this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='crosshair';this.paintSoon();return;
    }
    if(this.native()){
      const openingId=this.openingAt(point),opening=this.project.openings?.find(value=>value.id===openingId);
      if(opening){
        this.selectedWallId=null;this.selectedOpeningId=opening.id;this.callbacks.selectOpening?.(opening.id);
        if(!opening.locked){this.drag={kind:'wall-opening',pointerId:event.pointerId,start:point,opening:structuredClone(opening),changed:false,valid:true};this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';}
        else this.canvas.style.cursor='pointer';
        this.paintSoon();return;
      }
    }
    const furniture = [...(this.project.furniture ?? [])].reverse().find(item => !item.hidden && (furnitureContains(item, point, this.project) || (isFixtureKind(item.kind) ? dist(screen, this.toScreen(item.position)) < 8 : !furnitureScale(this.project) && dist(screen, this.toScreen(item.position)) < 16)));
    if (furniture) {
      this.callbacks.selectFurniture?.(furniture.id);
      if(furniture.locked){this.canvas.style.cursor='default';this.paintSoon();return;}
      this.drag = { kind: 'furniture', pointerId: event.pointerId, start: point, furniture: structuredClone(furniture), changed: false };
      this.canvas.setPointerCapture(event.pointerId); this.canvas.style.cursor = 'grabbing'; this.paintSoon(); return;
    }
    const incoming = incomingStairs(this.project).slice().reverse().find(source => {
      const plan = stairPlanGeometry(source.item, source.project);
      return plan && pointInRegion(point,{points:plan.outline,holes:plan.holes});
    });
    if (incoming) { this.callbacks.selectIncomingStair?.(incoming.levelId,incoming.item.id); return; }
    const hitRoute = serviceRouteAt(this.project, point, this.view.zoom, this.selectedServiceId);
    if (hitRoute) { this.callbacks.selectService?.(hitRoute.id); this.paintSoon(); return; }
    const selected = this.project.regions.find(r => r.id === this.selectedId && !r.hidden);
    if (selected && selected.source !== 'walls' && this.project.workspaceMode !== 'decoration') {
      const contours = [selected.points, ...selected.holes];
      for (let hole = 0; hole < contours.length; hole++) {
        for (let index = 0; index < contours[hole].length; index++) {
          if (dist(screen, this.toScreen(contours[hole][index])) < 10) {
            this.activeVertex = { hole: hole - 1, index };
            this.drag = { kind: 'vertex', pointerId: event.pointerId, start: screen, region: selected, vertex: { ...this.activeVertex }, points: clonePoints(selected.points), holes: selected.holes.map(clonePoints), changed: false };
            this.canvas.setPointerCapture(event.pointerId); this.paintSoon(); return;
          }
        }
      }
    }
    this.activeVertex = null;
    if (this.native()) {
      const wallId = this.wallAt(point);
      if (wallId) { this.callbacks.select(null); this.selectedWallId = wallId; this.callbacks.selectWall?.(wallId); this.paintSoon(); return; }
      this.selectedWallId = null; this.callbacks.selectWall?.(null);
    }
    const region = [...this.project.regions].reverse().find(r => !r.hidden && pointInRegion(point, r));
    this.callbacks.select(region?.id || null);
    // Selection changes may cancel old edits. Capture the move only after the
    // parent has synchronised its selection and project with this viewer.
    if (region && this.native() && region.source !== 'walls' && this.project.workspaceMode !== 'decoration') {
      this.drag = { kind: 'region', pointerId: event.pointerId, start: point,
        region: { ...region, points: clonePoints(region.points), holes: region.holes.map(clonePoints) },
        points: clonePoints(region.points), holes: region.holes.map(clonePoints), changed: false };
      this.canvas.setPointerCapture(event.pointerId); this.canvas.style.cursor = 'grabbing';
    }
  }

  private pointerMove(event: PointerEvent) {
    if (event.isPrimary === false || (this.drag && event.pointerId !== this.drag.pointerId)) return;
    const screen = this.screen(event);
    this.cursor = this.toWorld(screen);
    if (this.tool === 'wall') this.cursor = this.snappedWall(this.cursor, event.shiftKey);
    if (this.tool === 'service-route') this.cursor = snapServicePoint(this.project, this.cursor, this.view.zoom, this.draft.at(-1), event.shiftKey);
    if (floorHoleTool(this.tool)) this.cursor = this.snappedOpening(this.cursor);
    if(this.tool==='municipal')this.cursor=this.municipalSnapped(this.cursor,event);
    if (this.drag?.kind === 'pan') {
      this.view.panX = this.drag.view.panX + screen.x - this.drag.start.x;
      this.view.panY = this.drag.view.panY + screen.y - this.drag.start.y;
    } else if(this.drag?.kind==='municipal-draw'){
      this.drag.end={...this.cursor};
      this.drag.changed ||= dist(screen,this.drag.start)>=6;
      this.canvas.style.cursor=this.onDrawing(this.cursor)?'crosshair':'not-allowed';
    } else if(['municipal-vertex','municipal-move'].includes(this.drag?.kind)){
      const drag=this.drag,original=drag.municipal,current=this.project.municipalElements?.find(item=>item.id===original.id&&!item.hidden&&!item.locked);
      if(!current){this.cancelDrag();return;}
      const points=structuredClone(original.points);
      if(drag.kind==='municipal-vertex'){
        const clicked=this.municipalSnapped(this.cursor,{shiftKey:false,altKey:event.altKey},undefined,original.id,original.kind,original.elevation,original.width);points[drag.municipalIndex]={...points[drag.municipalIndex],...clicked};
      }else{
        const dx=this.cursor.x-drag.start.x,dy=this.cursor.y-drag.start.y;for(const point of points){point.x+=dx;point.y+=dy;}
        this.municipalConnection=null;
        if(!event.altKey&&['road','bridge','kerb'].includes(original.kind)){
          const snaps=[points[0],points.at(-1)].map(point=>snapMunicipalConnection(this.project,original.kind,point,{tolerance:12/this.view.zoom,excludedId:original.id,elevation:original.elevation,widthCm:original.width})).filter(Boolean).sort((a,b)=>a.distance-b.distance);
          const snap=snaps[0];if(snap){const endpoint=dist(points[0],snap.point)<=dist(points.at(-1),snap.point)?points[0]:points.at(-1),sx=snap.point.x-endpoint.x,sy=snap.point.y-endpoint.y;for(const point of points){point.x+=sx;point.y+=sy;}this.municipalConnection=snap;}
        }
      }
      try{
        const candidate={...original,points};
        validateMunicipalElements((this.project.municipalElements??[]).map(item=>item.id===original.id?candidate:item),this.project);
        if(!points.every(point=>this.onDrawing(point))||municipalFootprints(candidate,this.project)?.some(part=>!part.points.every(point=>this.onDrawing(point))))throw new Error('设施超出画板范围。');
        if(drag.changed||dist(screen,this.toScreen(drag.start))>2){drag.changed=true;this.callbacks.previewMunicipal?.(original.id,points);this.canvas.style.cursor=drag.kind==='municipal-vertex'?'move':'grabbing';}
      }catch{this.canvas.style.cursor='not-allowed';}
    } else if(this.drag?.kind==='wall-opening'){
      const drag=this.drag,current=this.project.openings?.find(opening=>opening.id===drag.opening.id);
      if(!current||current.locked||current.wallId!==drag.opening.wallId){this.cancelDrag();return;}
      try{
        const patch=openingPositionFromPlanDrag(this.project,drag.opening,drag.start,this.cursor,{snap:!event.altKey}),validity=openingPositionValidity(this.project,{...current,...patch});
        drag.valid=validity.valid;
        if(!validity.valid){this.canvas.style.cursor='not-allowed';this.paintSoon();return;}
        if(drag.changed||dist(screen,this.toScreen(drag.start))>2){
          drag.changed=true;this.callbacks.previewOpening?.(current.id,patch);this.canvas.style.cursor='grabbing';
        }
      }catch{drag.valid=false;this.canvas.style.cursor='not-allowed';}
    } else if (['civil-move','civil-rotation','civil-resize'].includes(this.drag?.kind)) {
      const drag=this.drag,item=drag.civil;
      if(!this.project.civilElements?.some(value=>value.id===item.id&&!value.hidden&&!value.locked&&!value.sourceRegionId)){this.cancelDrag();return;}
      let patch:CivilTransformPatch;
      if(drag.kind==='civil-resize')patch=furnitureResizeFromPointer(item,drag.resizeKey,drag.start,this.cursor,this.project,{min:1,max:100000,circle:item.kind==='roundColumn',preserveRatio:event.shiftKey});
      else if(drag.kind==='civil-rotation')patch={rotation:rotationFromPointer(item.position,drag.start,this.cursor,item.rotation,event.shiftKey)};
      else patch={position:{x:item.position.x+this.cursor.x-drag.start.x,y:item.position.y+this.cursor.y-drag.start.y}};
      const geometry={...item,...patch},parts=civilParts(geometry,this.project);
      if(parts?.some(part=>!part.points.every(point=>this.onDrawing(point))||!validateRegionWithinBoundary(part,this.project.planBoundary).valid)){this.canvas.style.cursor='not-allowed';this.paintSoon();return;}
      if(drag.changed||dist(screen,this.toScreen(drag.start))>2){
        drag.changed=true;this.callbacks.previewCivil?.(item.id,patch);
        this.canvas.style.cursor=drag.kind==='civil-move'?'grabbing':drag.kind==='civil-rotation'?'crosshair':furnitureResizeHandles(item,this.project).find(handle=>handle.key===drag.resizeKey)?.cursor??'nwse-resize';
      }
    } else if (this.drag?.kind === 'service') {
      const drag = this.drag;
      if (!this.project.serviceRoutes?.some(route => route.id === drag.service.id && !route.hidden)) { this.cancelDrag(); return; }
      const points = structuredClone(drag.service.points);
      const clicked = snapServicePoint(this.project, this.cursor, this.view.zoom, undefined, false, drag.service.id);
      points[drag.serviceIndex] = { ...points[drag.serviceIndex], ...clicked };
      try { validateServiceRoutes([{ ...drag.service, points }]); drag.changed = true; this.callbacks.previewService?.(drag.service.id, points); this.canvas.style.cursor = 'move'; }
      catch { this.canvas.style.cursor = 'not-allowed'; }
    } else if (this.drag?.kind === 'furniture') {
      const drag = this.drag, item = drag.furniture;
      if (!this.project.furniture?.some(value => value.id === item.id && !value.hidden&&!value.locked)) { this.cancelDrag(); return; }
      const target = { x: item.position.x + this.cursor.x - drag.start.x, y: item.position.y + this.cursor.y - drag.start.y };
      const placement = fixtureWallPlacement(item, target, this.project);
      const position = dist(target, item.position) < 1e-7 ? { ...item.position } : clampFurniturePosition({ ...item, rotation: placement.rotation }, placement.position, this.project);
      const footprint = furnitureFootprint({...item,position,rotation:placement.rotation},this.project);
      if (footprint && !validateRegionWithinBoundary({points:footprint},this.project.planBoundary).valid) { this.canvas.style.cursor = 'not-allowed'; this.paintSoon(); return; }
      if (drag.changed || dist(position, item.position) > 2 / this.view.zoom) { drag.changed = true; this.callbacks.previewFurniture?.(item.id, position); if (placement.snapped) this.callbacks.previewRotation?.(item.id, placement.rotation); }
    } else if (this.drag?.kind === 'resize') {
      const drag=this.drag,item=drag.furniture;
      if(!this.project.furniture?.some(value=>value.id===item.id&&!value.hidden&&!value.locked)){this.cancelDrag();return;}
      const patch=furnitureResizeFromPointer(item,drag.resizeKey,drag.start,this.cursor,this.project,{preserveRatio:event.shiftKey});
      const footprint=furnitureFootprint({...item,...patch},this.project);
      if(footprint&&(!footprint.every(point=>this.onDrawing(point))||!validateRegionWithinBoundary({points:footprint},this.project.planBoundary).valid)){this.canvas.style.cursor='not-allowed';this.paintSoon();return;}
      if(drag.changed||dist(screen,this.toScreen(drag.start))>2){drag.changed=true;this.callbacks.previewFurnitureResize?.(item.id,patch);this.canvas.style.cursor=furnitureResizeHandles(item,this.project).find(handle=>handle.key===drag.resizeKey)?.cursor??'nwse-resize';}
    } else if (this.drag?.kind === 'rotation') {
      const drag=this.drag,item=drag.furniture;
      if(!this.project.furniture?.some(value=>value.id===item.id&&!value.hidden&&!value.locked)){this.cancelDrag();return;}
      const rotation=rotationFromPointer(item.position,drag.start,this.cursor,item.rotation,event.shiftKey);
      const footprint=furnitureFootprint({...item,rotation},this.project);
      if(footprint&&(!footprint.every(point=>this.onDrawing(point))||!validateRegionWithinBoundary({points:footprint},this.project.planBoundary).valid)){this.canvas.style.cursor='not-allowed';this.paintSoon();return;}
      drag.changed=true;this.callbacks.previewRotation?.(item.id,rotation);this.canvas.style.cursor='crosshair';
    } else if (this.drag?.kind === 'floor-opening') {
      this.drag.end = this.cursor;
      try {
        const draft = openingShape(floorHoleShape(this.tool),this.drag.start,this.cursor,{innerRatio:this.holeInnerRatio});
        const region = this.project.regions.find(region => region.id === this.selectedId);
        const parts = region && openingRegionParts(region,[draft]);
        this.floorOpeningDraft = draft;
        this.drag.valid = !!parts?.length;
        this.canvas.style.cursor = this.drag.valid ? 'crosshair' : 'not-allowed';
      } catch { this.drag.valid = false; this.floorOpeningDraft = null; this.canvas.style.cursor = 'not-allowed'; }
    } else if (this.drag?.kind === 'rectangle') {
      this.drag.end = this.snapped(this.cursor);
      this.rectanglePoints = this.rectangle(this.drag.start, this.drag.end);
      const width = Math.abs(this.drag.end.x - this.drag.start.x), depth = Math.abs(this.drag.end.y - this.drag.start.y);
      this.drag.valid = width >= 10 && depth >= 10 && this.wallsFit(this.rectanglePoints, true) && validateRegion({ id: '', points: this.rectanglePoints, holes: [] }, this.project.regions).valid;
      this.canvas.style.cursor = this.drag.valid ? 'crosshair' : 'not-allowed';
    } else if (this.drag?.kind === 'region') {
      const drag = this.drag;
      if (!this.project.regions.some(region => region.id === drag.region.id && !region.hidden)) { this.cancelDrag(); return; }
      const move = snapRoomTranslation(drag.region, this.cursor.x - drag.start.x, this.cursor.y - drag.start.y,
        this.project.regions, this.view.zoom, { grid: true, step: 10 });
      const region = translateRegion(drag.region, move.dx, move.dy);
      const valid = region.points.every(point => this.onDrawing(point)) && validateRegionWithinBoundary(region,this.project.planBoundary).valid && validateRegion(region, this.project.regions).valid;
      if (valid && dist(screen, this.toScreen(drag.start)) > 2) {
        drag.changed = true; this.guides = move.guides; this.canvas.style.cursor = 'grabbing';
        this.callbacks.preview(region.id, region.points, region.holes);
      } else if (!valid) { this.guides = []; this.canvas.style.cursor = 'not-allowed'; }
    } else if (this.drag?.kind === 'vertex') {
      const drag = this.drag;
      if (!this.project?.drawing || !this.project.regions.some(region => region.id === drag.region.id && !region.hidden)) { this.cancelDrag(); return; }
      const region = { ...drag.region, points: clonePoints(drag.points), holes: drag.holes.map(clonePoints) };
      const contour = drag.vertex.hole < 0 ? region.points : region.holes[drag.vertex.hole];
      if (!contour?.[drag.vertex.index]) { this.activeVertex = null; this.cancelDrag(); return; }
      contour[drag.vertex.index] = this.snapped(this.cursor);
      const validation = validateRegion(region, this.project.regions);
      if (validation.valid && this.onDrawing(contour[drag.vertex.index]) && validateRegionWithinBoundary(region,this.project.planBoundary).valid) {
        drag.changed = true;
        this.canvas.style.cursor = 'move';
        this.callbacks.preview(region.id, region.points, region.holes);
      } else this.canvas.style.cursor = 'not-allowed';
    } else if (this.tool === 'select' && this.project.workspaceMode==='civil') {
      const handle=this.getCivilResizeHandles().filter(handle=>dist(screen,handle)<=9).sort((a,b)=>dist(screen,a)-dist(screen,b))[0],rotate=this.getCivilRotationHandle();
      const hit=[...(this.project.civilElements??[])].reverse().find(item=>!item.hidden&&civilParts(item,this.project)?.some(part=>pointInRegion(this.cursor,part)));
      this.canvas.style.cursor=handle?.cursor??(rotate&&dist(screen,rotate)<=11?'crosshair':hit?hit.locked||hit.sourceRegionId?'pointer':'grab':'default');
    } else if(this.tool==='select'&&this.project?.workspaceMode==='municipal'){
      const selected=this.project.municipalElements?.find(item=>item.id===this.selectedMunicipalId),handle=municipalVertexAt(selected,this.cursor,9/this.view.zoom),hit=municipalAtPoint(this.project,this.cursor,8/this.view.zoom,this.selectedMunicipalId);
      this.canvas.style.cursor=handle!==null?'move':hit?hit.locked||hit.holes?.length?'pointer':'grab':'default';
    } else if (this.tool === 'select') {
      const selected = this.project?.regions.find(r => r.id === this.selectedId && !r.hidden);
      const handle = selected && selected.source !== 'walls' && this.project.workspaceMode !== 'decoration' && [selected.points, ...selected.holes].some(points => points.some(p => dist(screen, this.toScreen(p)) < 10));
      const region = this.native() && this.project?.regions.some(region => !region.hidden && region.source !== 'walls' && pointInRegion(this.cursor, region));
      const furniture = this.project?.furniture?.find(item => !item.hidden && (furnitureContains(item, this.cursor, this.project) || (isFixtureKind(item.kind) ? dist(screen, this.toScreen(item.position)) < 8 : !furnitureScale(this.project) && dist(screen, this.toScreen(item.position)) < 16)));
      const rotationPoint=this.getFurnitureRotationHandle();
      const resizeHandle=this.getFurnitureResizeHandles().filter(handle=>dist(screen,handle)<=9).sort((a,b)=>dist(screen,a)-dist(screen,b))[0];
      const service = this.project.serviceRoutes?.find(route => route.id === this.selectedServiceId);
      const opening=this.native()?this.project.openings?.find(value=>value.id===this.openingAt(this.cursor)):null;
      this.canvas.style.cursor = resizeHandle?.cursor ?? (serviceVertexAt(service, this.cursor, this.view.zoom) !== null ? 'move' : rotationPoint&&dist(screen,rotationPoint)<=11 ? 'crosshair' : opening?opening.locked?'pointer':'grab':handle ? 'move' : furniture ? furniture.locked?'pointer':'grab' : region ? 'grab' : serviceRouteAt(this.project, this.cursor, this.view.zoom) ? 'pointer' : 'default');
    }
    this.paintSoon();
  }

  private pointerUp(event: PointerEvent) {
    if (this.drag && event.pointerId !== this.drag.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    this.guides = [];
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.updateCursor();
    if(drag?.kind==='municipal-draw'){
      const end=this.municipalSnapped(this.toWorld(this.screen(event)),event);
      if(drag.changed||dist(this.screen(event),drag.start)>=6){
        if(!this.draft.length||dist(end,this.draft.at(-1))>.5/this.view.zoom)this.draft.push(end);
        this.cursor=end;this.finish();
      }
      this.paintSoon();return;
    }
    if(['municipal-vertex','municipal-move'].includes(drag?.kind)&&drag.changed){
      const item=this.project.municipalElements?.find(item=>item.id===drag.municipal.id);
      if(item){const points=structuredClone(item.points);try{this.callbacks.previewMunicipal?.(item.id,structuredClone(drag.municipal.points));this.callbacks.commitMunicipal?.(item.id,points);}catch(error){this.callbacks.previewMunicipal?.(item.id,structuredClone(drag.municipal.points));this.callbacks.error(error.message);}}
      this.municipalConnection=null;this.paintSoon();return;
    }
    if(drag?.kind==='wall-opening'&&drag.changed){
      const opening=this.project.openings?.find(value=>value.id===drag.opening.id);
      if(opening&&!opening.locked&&opening.wallId===drag.opening.wallId){
        try{this.callbacks.commitOpening?.(opening.id,{offset:opening.offset,bottom:opening.bottom});}
        catch(error){this.callbacks.previewOpening?.(drag.opening.id,{offset:drag.opening.offset,bottom:drag.opening.bottom});this.callbacks.error(error.message);}
      }
      this.paintSoon();return;
    }
    if(['civil-move','civil-rotation','civil-resize'].includes(drag?.kind)&&drag.changed){
      const item=this.project.civilElements?.find(item=>item.id===drag.civil.id);
      if(item){try{this.callbacks.commitCivil?.(item.id,{position:{...item.position},width:item.width,depth:item.depth,rotation:item.rotation,sourceRegionId:item.sourceRegionId});}
        catch(error){this.callbacks.previewCivil?.(drag.civil.id,{position:{...drag.civil.position},width:drag.civil.width,depth:drag.civil.depth,rotation:drag.civil.rotation,sourceRegionId:drag.civil.sourceRegionId});this.callbacks.error(error.message);}}
      this.paintSoon();return;
    }
    if(drag?.kind==='resize'&&drag.changed){
      const item=this.project.furniture?.find(item=>item.id===drag.furniture.id);
      if(item){try{this.callbacks.commitFurnitureResize?.(item.id,{position:{...item.position},width:item.width,depth:item.depth});}
        catch(error){this.callbacks.previewFurnitureResize?.(drag.furniture.id,{position:{...drag.furniture.position},width:drag.furniture.width,depth:drag.furniture.depth});this.callbacks.error(error.message);}}
      this.paintSoon();return;
    }
    if (drag?.kind === 'service' && drag.changed) { const route = this.project.serviceRoutes?.find(route => route.id === drag.service.id); if (route) this.callbacks.commitService?.(route.id, structuredClone(route.points)); this.paintSoon(); return; }
    if (drag?.kind === 'floor-opening') {
      const draft=this.floorOpeningDraft; this.floorOpeningDraft=null;
      if (draft && drag.valid && dist(drag.start,drag.end)>1e-6) {
        try { this.callbacks.floorOpening?.(this.selectedId,draft); this.setTool('select'); }
        catch (error) { this.callbacks.error(error.message); }
      } else this.callbacks.error('请拖出有面积的洞口，并与本层房间相交。');
      this.paintSoon(); return;
    }
    if(drag?.kind==='rotation'&&drag.changed){const item=this.project.furniture?.find(item=>item.id===drag.furniture.id);if(item){try{this.callbacks.commitRotation?.(item.id,item.rotation);}catch(error){this.callbacks.previewRotation?.(item.id,drag.furniture.rotation);this.callbacks.error(error.message);}}this.paintSoon();return;}
    if (drag?.kind === 'furniture' && drag.changed) { const item = this.project.furniture?.find(item => item.id === drag.furniture.id); if (item) this.callbacks.commitFurniture?.(item.id, { ...item.position }); this.paintSoon(); return; }
    if (drag?.kind === 'rectangle') {
      const points = clonePoints(this.rectanglePoints); this.rectanglePoints = [];
      if (drag.valid) {
        const validation = validateRegion({ id: '', points, holes: [] }, this.project.regions);
        if (validation.valid) {
          try { this.callbacks.create(points, false); this.setTool('select'); }
          catch (error) { this.callbacks.error(error.message); }
        }
        else this.callbacks.error(validation.error);
      } else if (drag.end && dist(drag.start, drag.end) >= 10) this.callbacks.error(this.project.planBoundary ? '房间完整墙厚与连接处必须位于边界内，轮廓不能重叠，长宽至少为 0.1 m。' : '房间轮廓不能重叠，且长宽至少为 0.1 m。');
      this.paintSoon(); return;
    }
    if ((drag?.kind === 'vertex' || drag?.kind === 'region') && drag.changed) {
      const current = this.project.regions.find(r => r.id === drag.region.id);
      if (current) {
        const validation = validateRegion(current, this.project.regions);
        if (validation.valid) this.callbacks.commit(current.id, clonePoints(current.points), current.holes.map(clonePoints));
        else { this.callbacks.preview(drag.region.id, drag.points, drag.holes); this.callbacks.error(validation.error); }
      }
    }
  }

  private cancelDrag(restore = true) {
    this.floorOpeningDraft = null;
    const drag = this.drag;
    this.drag = null;
    this.guides = []; this.rectanglePoints = [];
    if (drag && this.canvas.hasPointerCapture(drag.pointerId)) this.canvas.releasePointerCapture(drag.pointerId);
    if(restore&&drag?.kind==='municipal-draw'){
      this.draft=clonePoints(drag.points??[]);this.municipalConnection=null;
      this.municipalSettings=structuredClone(drag.municipalSettings??{});this.municipalAnchorPort=drag.municipalAnchorPort?structuredClone(drag.municipalAnchorPort):null;
    }
    if(['municipal-vertex','municipal-move'].includes(drag?.kind))this.municipalConnection=null;
    if(restore&&['municipal-vertex','municipal-move'].includes(drag?.kind)&&drag.changed&&this.project?.municipalElements?.some(item=>item.id===drag.municipal.id))this.callbacks.previewMunicipal?.(drag.municipal.id,structuredClone(drag.municipal.points));
    if(restore&&drag?.kind==='wall-opening'&&drag.changed&&this.project?.openings?.some(opening=>opening.id===drag.opening.id))this.callbacks.previewOpening?.(drag.opening.id,{offset:drag.opening.offset,bottom:drag.opening.bottom});
    if (restore && (drag?.kind === 'vertex' || drag?.kind === 'region') && drag.changed && this.project?.regions.some(region => region.id === drag.region.id)) this.callbacks.preview(drag.region.id, clonePoints(drag.points), drag.holes.map(clonePoints));
    if (restore && drag?.kind === 'furniture' && drag.changed && this.project?.furniture?.some(item => item.id === drag.furniture.id)) this.callbacks.previewFurniture?.(drag.furniture.id, { ...drag.furniture.position });
    if (restore && drag?.kind === 'furniture' && drag.changed && isFixtureKind(drag.furniture.kind)) this.callbacks.previewRotation?.(drag.furniture.id, drag.furniture.rotation);
    if (restore && drag?.kind === 'rotation' && drag.changed && this.project?.furniture?.some(item => item.id === drag.furniture.id)) this.callbacks.previewRotation?.(drag.furniture.id,drag.furniture.rotation);
    if(restore&&drag?.kind==='resize'&&drag.changed&&this.project?.furniture?.some(item=>item.id===drag.furniture.id))this.callbacks.previewFurnitureResize?.(drag.furniture.id,{position:{...drag.furniture.position},width:drag.furniture.width,depth:drag.furniture.depth});
    if(restore&&['civil-move','civil-rotation','civil-resize'].includes(drag?.kind)&&drag.changed&&this.project?.civilElements?.some(item=>item.id===drag.civil.id))this.callbacks.previewCivil?.(drag.civil.id,{position:{...drag.civil.position},width:drag.civil.width,depth:drag.civil.depth,rotation:drag.civil.rotation,sourceRegionId:drag.civil.sourceRegionId});
    if (restore && drag?.kind === 'service' && drag.changed && this.project?.serviceRoutes?.some(route => route.id === drag.service.id)) this.callbacks.previewService?.(drag.service.id, structuredClone(drag.service.points));
    this.updateCursor();
    this.paintSoon();
  }

  finish() {
    if(this.tool==='municipal'&&this.municipalKind){
      const kind=this.municipalKind,min=isMunicipalPolygon(kind)?3:isMunicipalPath(kind)?2:1;
      if(this.draft.length<min){this.callbacks.error(isMunicipalPolygon(kind)?'至少三个顶点才能形成面域。':'至少两个不同的点才能形成路线。');return;}
      try{this.callbacks.createMunicipal?.(kind,clonePoints(this.draft),structuredClone(this.municipalSettings));this.setTool('select');}catch(error){this.callbacks.error(error.message);}return;
    }
    if(this.tool==='floor-hole'){
      const region=this.project.regions.find(region=>region.id===this.selectedId);
      if(!region){this.callbacks.error('请先选择本层房间。');return;}
      const opening = {points:clonePoints(this.draft),holes:[],shape:'polygon' as const};
      try { openingRegionParts(region,[opening]); this.callbacks.floorOpening?.(region.id,opening);this.setTool('select'); }
      catch(error){this.callbacks.error(error.message);}return;
    }
    if (this.tool === 'boundary') {
      const validation = validatePlanBoundary({points:this.draft});
      if (!validation.valid) { this.callbacks.error(validation.error); return; }
      try { this.callbacks.boundary?.(clonePoints(this.draft)); this.setTool('select'); }
      catch (error) { this.callbacks.error(error.message); }
      return;
    }
    if (this.tool === 'circle' || this.tool === 'arc') { this.callbacks.error(this.tool === 'circle' ? '请点击半径位置完成圆形墙。' : '请点击圆弧终点完成绘制。'); return; }
    if (this.tool === 'route' || this.tool === 'service-route') {
      if (this.draft.length < 2) { this.callbacks.error(this.tool === 'service-route' ? '线路至少需要两个不同的点。' : '道路中心线至少需要两个点。'); return; }
      const points = clonePoints(this.draft), service = this.tool === 'service-route';
      try { if (service) this.callbacks.serviceRoute?.(points); else this.callbacks.route?.(points); this.draft = []; this.setTool('select'); }
      catch (error) { this.callbacks.error(error.message); } return;
    }
    if (this.draft.length < 3) { this.callbacks.error('至少需要三个顶点才能创建区域。'); return; }
    const points = clonePoints(this.draft);
    const region = this.tool === 'hole' ? this.project.regions.find(r => r.id === this.selectedId) : { id: '', points, holes: [] };
    if (!region) { this.callbacks.error('区域已移除，请重新选择。'); this.cancel(); return; }
    const candidate = this.tool === 'hole' ? { ...region, holes: [...region.holes, points] } : region;
    const validation = validateRegion(candidate, this.project.regions);
    if (!validation.valid) { this.callbacks.error(validation.error); return; }
    this.callbacks.create(points, this.tool === 'hole');
    this.draft = []; this.cursor = null;
    this.setTool('select');
  }

  cancel() { this.draft = []; this.calibrationPoints = []; this.cancelDrag(); this.setTool('select'); }

  deleteVertex(): boolean {
    if (!this.activeVertex) return false;
    this.cancelDrag();
    const original = this.project.regions.find(r => r.id === this.selectedId);
    if (!original || original.hidden || original.source === 'walls') { this.activeVertex = null; return false; }
    const region = { ...original, points: clonePoints(original.points), holes: original.holes.map(clonePoints) };
    const contour = this.activeVertex.hole < 0 ? region.points : region.holes[this.activeVertex.hole];
    if (!contour || !contour[this.activeVertex.index]) { this.activeVertex = null; return false; }
    if (contour.length <= 3) { this.callbacks.error('一个多边形至少保留三个顶点。'); return true; }
    contour.splice(this.activeVertex.index, 1);
    const validation = validateRegion(region, this.project.regions);
    if (!validation.valid) { this.callbacks.error(validation.error); return true; }
    this.callbacks.commit(region.id, region.points, region.holes);
    this.activeVertex = null; this.paintSoon(); return true;
  }

  private keydown(event: KeyboardEvent) {
    if (document.querySelector('dialog[open],#cost-view:not([hidden])') || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
    if (event.code === 'Space') { event.preventDefault(); this.space = true; this.updateCursor(); }
    if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
    if (event.key === 'Enter' && this.wallStart) { event.preventDefault(); this.finishWalls(); }
    if (event.key === 'Enter' && this.draft.length) { event.preventDefault(); this.finish(); }
    if ((event.key === 'Backspace' || event.key === 'Delete') && this.draft.length) { event.preventDefault(); this.removeDraftPoint(); }
  }

  private removeDraftPoint() {
    if (!this.draft.length) return;
    this.draft.pop();
    if (this.tool === 'municipal' && !this.draft.length) { this.municipalSettings = structuredClone(this.municipalBaseSettings); this.municipalAnchorPort = null; this.municipalConnection = null; }
    this.paintSoon();
  }

  private updateCursor() { this.canvas.style.cursor = this.space || this.tool === 'pan' ? 'grab' : this.tool === 'select' ? 'default' : 'crosshair'; }
  private paintSoon() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); }); }

  private path(points: Point[]) {
    const ctx = this.ctx;
    points.forEach((point, i) => { const p = this.toScreen(point); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.closePath();
  }

  private grid() {
    const ctx = this.ctx, drawing = this.project.drawing;
    const first = this.toWorld({ x: 0, y: 0 }), last = this.toWorld({ x: this.width, y: this.height });
    const fromX = Math.max(0, first.x), toX = Math.min(drawing.width, last.x);
    const fromY = Math.max(0, first.y), toY = Math.min(drawing.height, last.y);
    const steps = this.project.workspaceMode==='municipal'?[Math.max(100,10**Math.ceil(Math.log10(40/this.view.zoom)))]:this.view.zoom >= .75 ? [10, 100] : [100];
    ctx.save();
    const top = this.toScreen({ x: 0, y: 0 }); ctx.beginPath(); ctx.rect(top.x, top.y, drawing.width * this.view.zoom, drawing.height * this.view.zoom); ctx.clip();
    for (const step of steps) {
      ctx.beginPath(); ctx.strokeStyle = step === 100 ? '#e2e8de' : '#f0f3ec'; ctx.lineWidth = 1;
      for (let x = Math.ceil(fromX / step) * step; x <= toX; x += step) { const p = this.toScreen({ x, y: 0 }); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height); }
      for (let y = Math.ceil(fromY / step) * step; y <= toY; y += step) { const p = this.toScreen({ x: 0, y }); ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y); }
      ctx.stroke();
    }
    ctx.restore();
  }

  private dimensions(points: Point[], color = '#638071') {
    // A T junction can split one straight boundary into several facets. Show
    // its full edge length so dimension labels remain easy to read.
    points = points.filter((point, index) => {
      const before = points[(index + points.length - 1) % points.length], after = points[(index + 1) % points.length];
      const dx = point.x - before.x, dy = point.y - before.y, ex = after.x - point.x, ey = after.y - point.y;
      return Math.abs(dx * ey - dy * ex) > 1e-6 || dx * ex + dy * ey <= 0;
    });
    const ctx = this.ctx;
    const signedArea = points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
    ctx.save(); ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length], a = this.toScreen(point), b = this.toScreen(next);
      const length = dist(a, b); if (length < 65) return;
      const sign = signedArea >= 0 ? 1 : -1;
      const x = (a.x + b.x) / 2 + (b.y - a.y) / length * sign * 17;
      const y = (a.y + b.y) / 2 - (b.x - a.x) / length * sign * 17;
      const text = (dist(point, next) / 100).toFixed(2) + ' m', width = ctx.measureText(text).width + 10;
      ctx.fillStyle = '#fffffff0'; ctx.beginPath(); ctx.roundRect(x - width / 2, y - 9, width, 18, 3); ctx.fill();
      ctx.fillStyle = color; ctx.fillText(text, x, y);
    });
    ctx.restore();
  }

  private paintWalls() {
    const ctx = this.ctx;
    ctx.save(); ctx.lineCap = 'butt';
    // Fill adjacent pieces together so shared curve edges have no antialiasing
    // cracks. Earlier walls retain their colour where new walls overlap them.
    const wallsById = new Map((this.project.walls || []).map(wall => [wall.id, wall]));
    let fillColor: string | null = null;
    for (const piece of [...this.actualFootprints()].reverse()) {
      const color = wallsById.get(piece.wallId)?.items?.[0]?.color || '#a5b1a2';
      if (color !== fillColor) {
        if (fillColor !== null) { ctx.fillStyle = fillColor; ctx.fill(); }
        ctx.beginPath(); fillColor = color;
      }
      this.path(piece.points);
    }
    if (fillColor !== null) { ctx.fillStyle = fillColor; ctx.fill(); }
    for (const wall of this.project.walls || []) {
      const a = this.toScreen(wall.start), b = this.toScreen(wall.end), selected = wall.id === this.selectedWallId;
      const grouped = this.project.wallShapes?.some(shape => shape.wallIds.includes(wall.id));
      if (!grouped) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineWidth = 1; ctx.strokeStyle = '#6e7e6b'; ctx.stroke(); }
      if (selected && !this.selectedWallIds.length) {
        for (const point of [a, b]) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#276853'; ctx.lineWidth = 1.5; ctx.stroke(); }
        const text = (dist(wall.start, wall.end) / 100).toFixed(2) + ' m';
        ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#276853';
        ctx.fillText(text, (a.x + b.x) / 2 + (Math.abs(a.x - b.x) < 1 ? 24 : 0), (a.y + b.y) / 2 - (Math.abs(a.y - b.y) < 1 ? 16 : 0));
      }
    }
    for (const opening of this.project.openings || []) {
      const wall = this.project.walls.find(w => w.id === opening.wallId); if (!wall) continue;
      const length = dist(wall.start, wall.end), dx = (wall.end.x - wall.start.x) / length, dy = (wall.end.y - wall.start.y) / length;
      const a = this.toScreen({ x: wall.start.x + dx * opening.offset, y: wall.start.y + dy * opening.offset });
      const b = this.toScreen({ x: wall.start.x + dx * (opening.offset + opening.width), y: wall.start.y + dy * (opening.offset + opening.width) });
      const selected = opening.id === this.selectedOpeningId;
      ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineWidth = Math.max(3, wall.thickness * this.view.zoom); ctx.strokeStyle = selected ? '#ddede3' : '#f6f8f2'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineWidth = selected ? 2 : 1.5; ctx.strokeStyle = selected ? '#276853' : opening.kind === 'window' ? '#80a5a0' : '#a0ad9b'; ctx.setLineDash(opening.kind === 'hole' ? [3, 3] : []); ctx.stroke(); ctx.setLineDash([]);
      for (const point of [a, b]) { ctx.beginPath(); ctx.moveTo(point.x - dy * wall.thickness * this.view.zoom / 2, point.y + dx * wall.thickness * this.view.zoom / 2); ctx.lineTo(point.x + dy * wall.thickness * this.view.zoom / 2, point.y - dx * wall.thickness * this.view.zoom / 2); ctx.stroke(); }
      if (selected) {
        const half=Math.max(1.5,wall.thickness*this.view.zoom/2),corners=[{x:a.x-dy*half,y:a.y+dx*half},{x:b.x-dy*half,y:b.y+dx*half},{x:b.x+dy*half,y:b.y-dx*half},{x:a.x+dy*half,y:a.y-dx*half}];
        ctx.beginPath();corners.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.closePath();ctx.strokeStyle='#ffffffcc';ctx.lineWidth=4;ctx.stroke();ctx.strokeStyle='#276853';ctx.lineWidth=1.5;ctx.stroke();
        const title=opening.name||({door:'门',window:'窗',hole:'开孔'})[opening.kind],text=(title.length>20?title.slice(0,19)+'…':title)+(opening.locked?' · 已锁定':'');
        ctx.font='11px "Microsoft YaHei UI", sans-serif';ctx.textAlign='center';const width=ctx.measureText(text).width+14,gap=half+8+Math.abs(dy)*width/2+Math.abs(dx)*11,x=(a.x+b.x)/2+dy*gap,y=(a.y+b.y)/2-dx*gap;
        ctx.fillStyle='#fffffff2';ctx.beginPath();ctx.roundRect(x-width/2,y-10,width,21,3);ctx.fill();ctx.fillStyle='#276853';ctx.fillText(text,x,y+4);
      }
    }
    const selectedWall = this.project.walls?.find(wall => wall.id === this.selectedWallId);
    if (selectedWall) {
      const scope = this.selectedWallSide || selectedWall.finishSide || 'both';
      const selection = this.getWallSelection();
      ctx.save(); ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      // In a plan view, vertical wall faces project to exact boundary lines.
      for (const width of [6, 2.5]) {
        ctx.beginPath(); for (const segment of selection.segments) { const a = this.toScreen(segment.start), b = this.toScreen(segment.end); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        ctx.strokeStyle = width === 6 ? '#ffffffcc' : '#276853'; ctx.lineWidth = width; ctx.stroke();
      }
      const a = this.toScreen(selectedWall.start), b = this.toScreen(selectedWall.end);
      const length = dist(a, b), offset = scope === 'right' ? 1 : -1;
      const x = (a.x + b.x) / 2 + (b.y - a.y) / Math.max(1, length) * offset * 24, y = (a.y + b.y) / 2 - (b.x - a.x) / Math.max(1, length) * offset * 24;
      const text = `${this.selectedWallIds.length ? '整组 · ' : ''}${scope === 'left' ? '左侧' : scope === 'right' ? '右侧' : '左右两侧'} · ${selection.area.toFixed(2)} m²`;
      ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif'; ctx.textAlign = 'center'; const tw = ctx.measureText(text).width + 12;
      ctx.fillStyle = '#fffffff0'; ctx.beginPath(); ctx.roundRect(x - tw / 2, y - 10, tw, 20, 3); ctx.fill(); ctx.fillStyle = '#276853'; ctx.fillText(text, x, y + 4); ctx.restore();
    }
    if (this.wallStart && this.cursor) {
      const a = this.toScreen(this.wallStart), b = this.toScreen(this.cursor);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineWidth = 2; ctx.strokeStyle = '#276853'; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      for (const point of [a, b]) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
      const length = dist(this.wallStart, this.cursor) / 100;
      if (length > 0) { ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#276853'; ctx.fillText(length.toFixed(2) + ' m', (a.x + b.x) / 2 + (Math.abs(a.x - b.x) < 1 ? 25 : 0), (a.y + b.y) / 2 - (Math.abs(a.y - b.y) < 1 ? 15 : 0)); }
    }
    ctx.restore();
  }

  private paintFurniture() {
    const ctx = this.ctx, scale = furnitureScale(this.project);
    for (const item of this.project.furniture ?? []) {
      if (item.hidden) continue;
      if (isStairKind(item.kind) && scale) { this.paintStair(item,this.project,item.id===this.selectedFurnitureId);if(item.id===this.selectedFurnitureId&&this.tool==='select')this.paintTransformHandles(item,this.getFurnitureResizeHandles(),this.getFurnitureRotationHandle());continue; }
      const p = this.toScreen(item.position), selected = item.id === this.selectedFurnitureId;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(item.rotation * Math.PI / 180);
      const w = scale ? item.width / 100 / scale * this.view.zoom : 24, d = scale ? item.depth / 100 / scale * this.view.zoom : 24;
      ctx.beginPath(); ctx.roundRect(-w / 2, -d / 2, w, d, Math.min(4, w / 8, d / 8));
      ctx.fillStyle = selected ? '#e2eee7' : '#eeeae4'; ctx.fill(); ctx.strokeStyle = selected ? '#276853' : '#9b9387'; ctx.lineWidth = selected ? 2 : 1.2; ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = selected ? '#54836b' : '#b5ac9e';
      if (scale && w > 14 && d > 14) {
        ctx.beginPath();
        if (item.kind === 'sofa') { ctx.rect(-w * .4, -d * .4, w * .8, d * .18); ctx.moveTo(-w * .32, -d * .2); ctx.lineTo(-w * .32, d * .35); ctx.moveTo(w * .32, -d * .2); ctx.lineTo(w * .32, d * .35); ctx.moveTo(0, -d * .2); ctx.lineTo(0, d * .35); }
        else if (item.kind === 'bed') { ctx.rect(-w * .4, -d * .38, w * .35, d * .18); ctx.rect(w * .05, -d * .38, w * .35, d * .18); ctx.moveTo(-w / 2, -d * .1); ctx.lineTo(w / 2, -d * .1); }
        else if (item.kind === 'cabinet' || item.kind === 'wardrobe') { ctx.moveTo(0, -d / 2); ctx.lineTo(0, d / 2); ctx.moveTo(-w * .08, -d * .08); ctx.lineTo(-w * .08, d * .08); ctx.moveTo(w * .08, -d * .08); ctx.lineTo(w * .08, d * .08); }
        else if (item.kind === 'nightstand') { ctx.moveTo(-w * .2, d * .28); ctx.lineTo(w * .2, d * .28); }
        else if (item.kind === 'chair') { ctx.rect(-w * .4, -d * .4, w * .8, d * .22); }
        ctx.stroke();
      }
      ctx.restore();
      if (isFixtureKind(item.kind) && Math.min(w, d) < 12) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(item.rotation * Math.PI / 180);
        ctx.beginPath(); ctx.roundRect(-7, -5, 14, 10, 2); ctx.fillStyle = selected ? '#dcece3' : '#fff'; ctx.fill(); ctx.strokeStyle = selected ? '#276853' : '#6f8b78'; ctx.lineWidth = selected ? 1.8 : 1.2; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-2, -2); ctx.lineTo(-2, 2); ctx.moveTo(2, -2); ctx.lineTo(2, 2); ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
      }
      if (selected || this.project.view.labels) {
        const text = item.name + (selected ? item.unitPrice === '' ? ' · 待填单价' : ' · ¥ ' + item.unitPrice + ' / 件' : '');
        ctx.save(); ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif'; ctx.textAlign = 'center';
        const tw = ctx.measureText(text).width + 12;
        const angle = item.rotation * Math.PI / 180, halfHeight = Math.abs(w * Math.sin(angle)) / 2 + Math.abs(d * Math.cos(angle)) / 2;
        const handle = selected&&!item.locked ? this.toScreen(rotationHandle(item,this.project,this.view.zoom)) : null;
        const labelY = selected && (!handle||handle.y <= p.y) ? p.y + halfHeight + 18 : p.y - halfHeight - 14;
        ctx.fillStyle = '#fffffff0'; ctx.beginPath(); ctx.roundRect(p.x - tw / 2, labelY - 9, tw, 19, 3); ctx.fill();
        ctx.fillStyle = selected ? '#235c49' : '#6c665d'; ctx.fillText(text, p.x, labelY + 4); ctx.restore();
      }
      if(selected&&this.tool==='select')this.paintTransformHandles(item,this.getFurnitureResizeHandles(),this.getFurnitureRotationHandle());
    }
    for (const source of incomingStairs(this.project)) this.paintStair(source.item,source.project,false,`来自${source.levelName} · 上行楼梯`);
  }

  private paintTransformHandles(item:{position:Point;width:number;depth:number;rotation:number;locked?:boolean},handles:Array<{key:ResizeKey;x:number;y:number;cursor:string}>,rotate:Point|null){
    if(item.locked)return;
    const ctx=this.ctx,scale=furnitureScale(this.project),frame=furnitureResizeHandles(item,this.project);
    ctx.save();ctx.strokeStyle='#276853';ctx.lineWidth=1;
    if(frame.length){ctx.beginPath();for(const key of['nw','ne','se','sw']){const p=this.toScreen(frame.find(handle=>handle.key===key).point);if(key==='nw')ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.closePath();ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);}
    for(const handle of handles){const size=handle.key.length===2?7:6;ctx.beginPath();ctx.roundRect(handle.x-size/2,handle.y-size/2,size,size,1);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=1.3;ctx.stroke();}
    if(rotate){
      const center=this.toScreen(item.position),angle=item.rotation*Math.PI/180,r=scale?item.depth/200/scale*this.view.zoom:12;
      const edge={x:center.x+Math.sin(angle)*r,y:center.y-Math.cos(angle)*r};
      ctx.beginPath();ctx.moveTo(edge.x,edge.y);ctx.lineTo(rotate.x,rotate.y);ctx.lineWidth=1;ctx.stroke();
      ctx.beginPath();ctx.arc(rotate.x,rotate.y,6,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=1.5;ctx.stroke();
      ctx.beginPath();ctx.arc(rotate.x,rotate.y,2,0,Math.PI*2);ctx.fillStyle='#276853';ctx.fill();
    }
    ctx.restore();
  }

  private paintCivil(){
    const ctx=this.ctx,civilMode=this.project.workspaceMode==='civil';
    for(const item of this.project.civilElements??[]){
      if(item.hidden)continue;
      const parts=civilParts(item,this.project);if(!parts?.length)continue;
      const selected=item.id===this.selectedCivilId&&civilMode,color=CIVIL_PRESETS.find(preset=>preset.kind===item.kind)?.color??'#83988b';
      ctx.save();ctx.beginPath();for(const part of parts){this.path(part.points);part.holes.forEach(hole=>this.path(hole));}
      ctx.fillStyle=selected?'#276853':color;ctx.globalAlpha=selected?.22:civilMode?.15:.07;ctx.fill('evenodd');ctx.globalAlpha=civilMode?1:.45;
      ctx.lineWidth=selected?2:1.2;ctx.strokeStyle=selected?'#276853':color;ctx.stroke();ctx.globalAlpha=1;
      if(civilMode&&(selected||this.project.view.labels)){
        const points=parts.flatMap(part=>part.points).map(point=>this.toScreen(point)),x=(Math.min(...points.map(p=>p.x))+Math.max(...points.map(p=>p.x)))/2,y=Math.max(...points.map(p=>p.y))+20;
        const dimensions=civilResolvedElement(item,this.project);
        const text=item.name+(selected?` · ${dimensions.width.toFixed(2)} × ${dimensions.depth.toFixed(2)} cm${item.locked?' · 已锁定':item.sourceRegionId?' · 随房间':''}`:'');
        ctx.font='11px "Segoe UI", "Microsoft YaHei UI", sans-serif';ctx.textAlign='center';const w=ctx.measureText(text).width+14;
        ctx.fillStyle='#fffffff2';ctx.beginPath();ctx.roundRect(x-w/2,y-10,w,21,3);ctx.fill();ctx.fillStyle=selected?'#276853':'#627668';ctx.fillText(text,x,y+4);
      }
      ctx.restore();
      if(selected&&this.tool==='select'&&!item.sourceRegionId)this.paintTransformHandles(item,this.getCivilResizeHandles(),this.getCivilRotationHandle());
    }
  }

  private paintServices() {
    const ctx = this.ctx;
    for (const route of this.project.serviceRoutes ?? []) {
      if (route.hidden) continue;
      const selected = route.id === this.selectedServiceId, preset = servicePreset(route.presetId);
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const trace = () => { ctx.beginPath(); route.points.forEach((point, index) => { const p = this.toScreen(point); if (index) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); };
      trace(); ctx.strokeStyle = '#fff'; ctx.lineWidth = selected ? 7 : 4.5; ctx.stroke();
      trace(); ctx.strokeStyle = selected ? '#276853' : preset.color; ctx.lineWidth = selected ? 3 : 1.8; ctx.stroke();
      const planNodes = new Map<string, { point: Point; indices: number[] }>();
      route.points.forEach((point, index) => { const key = `${point.x}:${point.y}`, node = planNodes.get(key); if (node) node.indices.push(index + 1); else planNodes.set(key, { point, indices: [index + 1] }); });
      for (const { point, indices } of planNodes.values()) { const p = this.toScreen(point); ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 5 : indices.includes(1) || indices.includes(route.points.length) ? 2.5 : 1.5, 0, Math.PI * 2); ctx.fillStyle = selected ? '#fff' : preset.color; ctx.fill(); if (selected) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#276853'; ctx.stroke(); ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillStyle = '#276853'; ctx.textAlign = 'left'; ctx.fillText(indices.join('·'), p.x + 8, p.y - 8); } }
      if (selected) { const middle = this.toScreen(route.points[Math.floor(route.points.length / 2)]), metrics = serviceMetrics(route, this.project); const text = `${route.name} · ${metrics.pathLength === null ? '待校准' : metrics.pathLength.toFixed(2) + ' m'}`; ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif'; ctx.textAlign = 'center'; const w = ctx.measureText(text).width + 16; ctx.fillStyle = '#fffffff2'; ctx.beginPath(); ctx.roundRect(middle.x - w / 2, middle.y + 12, w, 22, 4); ctx.fill(); ctx.fillStyle = '#276853'; ctx.fillText(text, middle.x, middle.y + 27); }
      ctx.restore();
    }
  }

  private paintStair(item: Furniture, source: Project, selected: boolean, incomingLabel?: string) {
    const plan = stairPlanGeometry(item,source);
    if (!plan) return;
    const ctx=this.ctx;
    ctx.save(); ctx.beginPath(); this.path(plan.outline);plan.holes.forEach(hole=>this.path(hole));
    ctx.fillStyle=selected?'#dcece3':incomingLabel?'#e8ede7':'#ede7dc';ctx.fill('evenodd');
    ctx.lineWidth=selected?2:1.2;ctx.strokeStyle=selected?'#276853':incomingLabel?'#749481':'#9b9387';ctx.stroke();
    ctx.strokeStyle=selected?'#65927a':incomingLabel?'#8ca390':'#b4a78e';ctx.lineWidth=.8;
    for(const step of plan.steps){ctx.beginPath();this.path(step);ctx.stroke();}
    const path=plan.ascentPath.map(point=>this.toScreen(point));
    if(path.length>1){
      ctx.beginPath();path.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.strokeStyle='#3d725a';ctx.lineWidth=1.4;ctx.stroke();
      const a=path[path.length-2],b=path[path.length-1],angle=Math.atan2(b.y-a.y,b.x-a.x);
      ctx.beginPath();ctx.moveTo(b.x-7*Math.cos(angle-.5),b.y-7*Math.sin(angle-.5));ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-7*Math.cos(angle+.5),b.y-7*Math.sin(angle+.5));ctx.stroke();
    }
    if(selected||this.project.view.labels||incomingLabel){
      const screenPoints=plan.outline.map(point=>this.toScreen(point));
      const x=(Math.min(...screenPoints.map(p=>p.x))+Math.max(...screenPoints.map(p=>p.x)))/2;
      const handle=selected&&!item.locked?this.toScreen(rotationHandle(item,this.project,this.view.zoom)):null,center=this.toScreen(item.position);
      const y=selected&&(!handle||handle.y<=center.y)?Math.max(...screenPoints.map(p=>p.y))+20:Math.min(...screenPoints.map(p=>p.y))-15;
      const text=incomingLabel??(item.name+(selected?(item.unitPrice===''?' · 待填单价':' · ¥ '+item.unitPrice+' / 件'):''));
      ctx.font='11px "Segoe UI", "Microsoft YaHei UI", sans-serif';ctx.textAlign='center';const width=ctx.measureText(text).width+12;
      ctx.fillStyle='#fffffff0';ctx.beginPath();ctx.roundRect(x-width/2,y-9,width,19,3);ctx.fill();ctx.fillStyle='#39654e';ctx.fillText(text,x,y+4);
    }
    ctx.restore();
  }

  private paintLowerReference(){
    if(!this.project.levels?.length)return;
    const current=activeLevel(this.project),lower=levelProjects(this.project).filter(level=>level.elevation<current.elevation).at(-1);
    if(!lower)return;
    const ctx=this.ctx;ctx.save();ctx.globalAlpha=.25;ctx.beginPath();
    for(const piece of wallFootprints(lower.project.walls??[],lower.project.wallJoinStyle??'square'))this.path(piece.points);
    ctx.fillStyle='#95a68e';ctx.fill();ctx.restore();
  }

  private paintBoundary() {
    const points = this.project.planBoundary?.points;
    if (!points?.length) return;
    const ctx = this.ctx; ctx.save();
    ctx.beginPath(); ctx.rect(0,0,this.width,this.height); this.path(points); ctx.fillStyle = '#e5e8e0'; ctx.globalAlpha = .38; ctx.fill('evenodd'); ctx.globalAlpha = 1;
    ctx.beginPath(); this.path(points); ctx.strokeStyle = '#94a68c'; ctx.lineWidth = 1.2; ctx.setLineDash([6,5]); ctx.stroke(); ctx.setLineDash([]);
    const first = this.toScreen(points[0]); ctx.font = '10px "Segoe UI", "Microsoft YaHei UI", sans-serif'; ctx.fillStyle = '#7d8f75'; ctx.textAlign = 'left'; ctx.fillText('绘图边界',first.x+6,first.y-8); ctx.restore();
  }

  private paintShapeDraft() {
    if (!this.draft.length || !['circle','arc','boundary'].includes(this.tool)) return;
    const ctx = this.ctx; let points = this.draft, closed = this.tool === 'boundary' && points.length > 2;
    try {
      const shape = this.cursor && (this.tool === 'circle' ? circleFromPoints(this.draft[0],this.cursor) : this.tool === 'arc' && this.draft.length === 2 ? arcThroughPoints(this.draft[0],this.draft[1],this.cursor) : null);
      if (shape) { points = shape.points; closed = shape.closed; }
      else if (this.cursor) points = [...points,this.cursor];
    } catch { if (this.cursor) points = [...points,this.cursor]; }
    ctx.save(); ctx.beginPath(); points.forEach((point,i) => { const p=this.toScreen(point); if (i) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y); }); if(closed)ctx.closePath();
    ctx.lineWidth=1.5;ctx.strokeStyle='#276853';ctx.setLineDash([5,4]);ctx.stroke();ctx.setLineDash([]);
    for (const point of this.draft) { const p=this.toScreen(point);ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke(); }
    if(this.tool==='circle'&&this.cursor){const center=this.toScreen(this.draft[0]), edge=this.toScreen(this.cursor);ctx.beginPath();ctx.moveTo(center.x,center.y);ctx.lineTo(edge.x,edge.y);ctx.stroke();ctx.fillStyle='#276853';ctx.font='11px "Segoe UI", sans-serif';ctx.textAlign='center';ctx.fillText(`R ${(dist(this.draft[0],this.cursor)/100).toFixed(2)} m`,(center.x+edge.x)/2,(center.y+edge.y)/2-10);}
    ctx.restore();
  }

  private paint() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#f3f4f1'; ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#dde2dc';
    for (let x = 12; x < this.width; x += 24) for (let y = 12; y < this.height; y += 24) { ctx.beginPath(); ctx.arc(x, y, .6, 0, Math.PI * 2); ctx.fill(); }
    const drawing = this.project?.drawing;
    if (!drawing) return;
    const top = this.toScreen({ x: 0, y: 0 });
    const width = drawing.width * this.view.zoom, height = drawing.height * this.view.zoom;
    ctx.fillStyle = '#fff'; ctx.fillRect(top.x, top.y, width, height);
    ctx.strokeStyle = '#d7dcd4'; ctx.lineWidth = 1; ctx.strokeRect(top.x, top.y, width, height);
    if (this.native()) this.grid();
    else if (this.image) { ctx.globalAlpha = this.project.view.drawingOpacity; ctx.drawImage(this.image, top.x, top.y, width, height); ctx.globalAlpha = 1; }
    if(this.project.workspaceMode==='municipal'){
      paintTerrain(ctx,this.project,point=>this.toScreen(point));
      paintMunicipal({ctx,project:this.project,selectedId:this.selectedMunicipalId,toScreen:point=>this.toScreen(point),zoom:this.view.zoom,draft:this.draft,cursor:this.cursor,kind:this.municipalKind,drawing:this.tool==='municipal',settings:this.municipalSettings,connection:this.municipalConnection,anchorPort:this.municipalAnchorPort});
      if(this.calibrationPoints.length){ctx.beginPath();this.calibrationPoints.forEach((point,i)=>{const p=this.toScreen(point);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});if(this.cursor&&this.calibrationPoints.length===1){const p=this.toScreen(this.cursor);ctx.lineTo(p.x,p.y);}ctx.strokeStyle='#276853';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.stroke();ctx.setLineDash([]);}
      this.callbacks.status(this.tool==='municipal'?isMunicipalPolygon(this.municipalKind)?'逐点圈选面域 · 点击起点或 Enter 闭合 · Esc 取消':isMunicipalPath(this.municipalKind)?['road','bridge','kerb','fence'].includes(this.municipalKind)?'拖画一段 · 点选可连续折线 · Enter 完成 · Alt 暂停吸附 · Esc 取消':'逐点绘制路线 · Shift 约束方向 · Enter 完成 · Esc 取消':'点击放置设施 · Esc 取消':this.tool==='calibrate'?'选择两个已知距离端点校准图纸':this.tool==='pan'?'拖动平移场地':'点选市政设施 · 拖动顶点编辑 · 空格平移 · 滚轮缩放',this.view.zoom);return;
    }
    this.paintLowerReference();
    this.paintBoundary();
    for (const region of this.project.regions) {
      if (region.hidden) continue;
      const selected = region.id === this.selectedId;
      const color = region.items[0]?.color || '#83998d';
      ctx.beginPath(); for(const part of region.surfaceParts??[region]){this.path(part.points);part.holes.forEach(h => this.path(h));}
      ctx.fillStyle = color; ctx.globalAlpha = selected ? .21 : .12; ctx.fill('evenodd'); ctx.globalAlpha = 1;
      ctx.strokeStyle = selected ? '#276853' : color; ctx.lineWidth = selected ? 2 : 1.1; ctx.stroke();
      if (this.project.view.labels) this.label(region, selected);
      if (selected && this.tool === 'select' && region.source !== 'walls' && this.project.workspaceMode !== 'decoration') {
        [region.points, ...region.holes].forEach((points, hole) => points.forEach((point, index) => {
          const screen = this.toScreen(point);
          ctx.beginPath(); ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = this.activeVertex?.hole === hole - 1 && this.activeVertex.index === index ? '#276853' : 'white'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = '#276853'; ctx.stroke();
        }));
      }
    }
    if (this.native()) {
      this.paintWalls();
      const selected = this.project.regions.find(region => region.id === this.selectedId && !region.hidden);
      if (selected) this.dimensions(selected.points);
    }
    this.paintServices();
    this.paintFurniture();
    this.paintCivil();
    if(this.floorOpeningDraft){
      const draft=this.floorOpeningDraft;ctx.save();ctx.beginPath();this.path(draft.points);(draft.holes??[]).forEach(hole=>this.path(hole));
      ctx.fillStyle=this.drag?.valid?'#276853':'#9c7561';ctx.globalAlpha=.13;ctx.fill('evenodd');ctx.globalAlpha=1;ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.stroke();ctx.setLineDash([]);
      this.dimensions(draft.points,ctx.strokeStyle);ctx.restore();
    }
    if(floorHoleTool(this.tool)&&this.cursor){const p=this.toScreen(this.cursor);ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#276853';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();}
    if (this.tool === 'furniture' && this.furnitureTemplate && this.cursor && this.onDrawing(this.cursor)) {
      const item = { ...this.furnitureTemplate, position: this.cursor, rotation: 0 } as Furniture;
      const placement = fixtureWallPlacement(item, this.cursor, this.project);
      const position = clampFurniturePosition({ ...item, rotation: placement.rotation }, placement.position, this.project), points = furnitureFootprint({ ...item, position, rotation: placement.rotation }, this.project);
      ctx.save(); ctx.strokeStyle = '#276853'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      if (points) { ctx.beginPath(); this.path(points); ctx.globalAlpha = .12; ctx.fillStyle = '#276853'; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); }
      else { const p = this.toScreen(position); ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    }
    if(this.tool==='civil'&&this.civilTemplate&&this.cursor&&this.onDrawing(this.cursor)){
      const template=this.civilTemplate,scale=furnitureScale(this.project);
      if(scale){
        const w=template.width/200/scale,d=template.depth/200/scale,position=this.cursor;
        const points=template.kind==='roundColumn'?Array.from({length:64},(_,i)=>({x:position.x+w*Math.cos(i*Math.PI/32),y:position.y+d*Math.sin(i*Math.PI/32)})):[{x:position.x-w,y:position.y-d},{x:position.x+w,y:position.y-d},{x:position.x+w,y:position.y+d},{x:position.x-w,y:position.y+d}];
        ctx.save();ctx.beginPath();this.path(points);ctx.fillStyle='#276853';ctx.globalAlpha=.12;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle='#276853';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.stroke();ctx.restore();
      }
    }
    if (this.rectanglePoints.length) {
      ctx.beginPath(); this.path(this.rectanglePoints); ctx.fillStyle = this.drag?.valid ? '#276853' : '#9c7561'; ctx.globalAlpha = .1; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = this.drag?.valid ? '#276853' : '#9c7561'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      this.dimensions(this.rectanglePoints, ctx.strokeStyle);
    }
    if (this.guides.length) {
      ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = '#79a88b';
      for (const guide of this.guides) { const p = this.toScreen(guide.axis === 'x' ? { x: guide.value, y: 0 } : { x: 0, y: guide.value }); ctx.beginPath(); if (guide.axis === 'x') { ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height); } else { ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y); } ctx.stroke(); }
      ctx.restore();
    }
    for (const region of this.candidates) {
      ctx.beginPath(); this.path(region.points); (region.holes || []).forEach(h => this.path(h));
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#548b74'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    this.paintShapeDraft();
    if (this.draft.length && !['circle','arc','boundary'].includes(this.tool)) {
      ctx.beginPath(); const points = this.cursor ? [...this.draft, this.cursor] : this.draft;
      points.forEach((point, i) => { const p = this.toScreen(point); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#276853'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
      this.draft.forEach((point, index) => { const p = this.toScreen(point); ctx.beginPath(); ctx.arc(p.x, p.y, index ? 3.5 : 5, 0, Math.PI * 2); ctx.fillStyle = index ? 'white' : '#276853'; ctx.fill(); ctx.stroke(); });
    }
    if (this.calibrationPoints.length) {
      const points = this.calibrationPoints.length === 1 && this.cursor ? [...this.calibrationPoints, this.cursor] : this.calibrationPoints;
      ctx.beginPath(); points.forEach((point, i) => { const p = this.toScreen(point); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.strokeStyle = '#276853'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      this.calibrationPoints.forEach(point => { const p = this.toScreen(point); ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = 'white'; ctx.fill(); ctx.stroke(); });
    }
    const selectedOpening=this.project.openings?.find(opening=>opening.id===this.selectedOpeningId);
    const hints: Partial<Record<Tool, string>> = { civil:`点击放置${this.civilTemplate?.name??'土建构件'} · Esc 取消`,furniture: `点击放置${this.furnitureTemplate?.name || '家具'} · 墙面设备自动贴墙 · Esc 取消`, 'service-route': '逐点画线路 · 点位与墙边吸附 · Shift 锁方向 · Enter 完成', route: '点击绘制道路中心线 · Enter 完成 · Esc 取消', select:this.project.workspaceMode==='civil'?'点选构件 · 方点改尺寸 · 圆点旋转 · 空格平移':selectedOpening?selectedOpening.locked?'开口已锁定 · 解锁后可沿墙拖动':'沿墙拖动开口 · 右侧调整离地高度 · Esc 取消':this.native() ? '点击房间、墙面、设备或线路 · 空格平移' : '点击选择区域、设备或线路 · 滚轮缩放 · 空格拖动', pan: '拖动平移图纸', polygon: '点击绘制 · 点击起点或 Enter 闭合 · Esc 取消', hole: '在选中区域内绘制孔洞 · Enter 闭合', calibrate: this.calibrationPoints.length ? '选择第二个校准点' : '选择第一个校准点', rectangle: '拖拽绘制房间 · 10 cm 网格吸附 · Esc 取消', wall: this.wallStart ? '可画斜墙 · Shift 水平 / 垂直 · 闭合生成房间 · Enter 结束' : '点击起点开始画墙 · 可画任意斜线 · Shift 正交' };
    const shapeHint = floorHoleTool(this.tool) ? (this.tool==='floor-hole'?'逐点圈选 · Enter 闭合':'floor-hole-circle floor-hole-annulus'.includes(this.tool)?'按住圆心，拖出半径':'按住起点，拖出洞口')+' · 自动吸附墙边并裁切 · Esc 取消' : this.tool === 'circle' ? this.draft.length ? '点击半径位置完成圆形墙 · Esc 取消' : '点击圆心开始画圆形墙 · Esc 取消' : this.tool === 'arc' ? ['点击圆弧起点 · Esc 取消','点击圆弧经过点 · Esc 取消','点击圆弧终点完成 · Esc 取消'][this.draft.length] : this.tool === 'boundary' ? '逐点定义边界 · 点击起点或 Enter 闭合 · Esc 取消' : '';
    this.callbacks.status(shapeHint || hints[this.tool], this.view.zoom);
  }

  private label(region: Region, selected: boolean) {
    const center = regionInteriorPoint(region);
    if (!center) return;
    const p = this.toScreen(center);
    const metric = regionMetrics(region, this.project.calibration);
    const area = metric.netArea == null ? '待校准' : metric.netArea.toFixed(2) + ' m²';
    const ctx = this.ctx;
    ctx.font = '500 12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    const width = Math.max(ctx.measureText(region.name).width, ctx.measureText(area).width) + 20;
    ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.beginPath(); ctx.roundRect(p.x - width / 2, p.y - 23, width, 43, 5); ctx.fill();
    ctx.textAlign = 'center'; ctx.fillStyle = selected ? '#235c49' : '#36443d'; ctx.fillText(region.name, p.x, p.y - 5);
    ctx.font = '11px "Segoe UI", sans-serif'; ctx.fillStyle = '#738177'; ctx.fillText(area, p.x, p.y + 10); ctx.textAlign = 'left';
  }
}
