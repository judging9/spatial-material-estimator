import type { Project } from './types.js';
import { buildSceneModel, type SceneModel, type SceneFloor, type SceneSurface, type SceneInsert } from './lib/scene-model.js';
import { levelProjects } from './lib/levels.js';
import { buildLevelFurniture, type LeveledFurniture } from './lib/scene-furniture.js';
import { buildSceneServices, rayServiceSegment, type SceneServiceRoute } from './lib/scene-services.js';
import type { SceneCivilElement } from './lib/scene-civil.js';
import { buildSceneMunicipal, type SceneMunicipalElement } from './lib/municipal-scene.js';
import { buildTerrainScene } from './lib/terrain-scene.js';
import { compileTerrainOccluders, nearestTerrainRayDistance, terrainCoversInspectionPoints, terrainDisplaySettings, tunnelInspectionCamera, type TerrainDisplayMode, type TerrainOccluder, type TunnelInspectionGeometry, type TunnelInspectionPosition } from './lib/scene-visibility.js';
import { buildWallSolid, openingPolygon, type WallOpening, type SolidSurface, type SolidInsert } from './lib/wall-solid.js';
import type { Wall } from './lib/wall-plan.js';
import { pointInRegion } from './lib/geometry.js';
import { openingPositionFromElevationDrag } from './lib/opening-interaction.js';
import { openingContour3D, rayOpeningWall } from './lib/opening-3d.js';
import { wallShapeSelection } from './lib/wall-shape-selection.js';
import { pricedWallSurfaces, wallSelection, wallSurfaceArea, selectedWallSurfaceSide, type WallFinishSide } from './lib/wall-selection.js';
import { validateFurnitureAssets, FURNITURE_ASSET_URL, type FurnitureAssets } from './lib/furniture3d.js';
import { lookAt4, multiply4, perspective4, transform4, screenRay, rayTriangle, pointInRingXZ, triangulateXZ, triangulateSurface, rayMesh, creaseSegments, floorLabelData, normalize3, sub3, type Vec3 } from './lib/camera3d.js';
import { automaticNavigationSpeed, cameraNavigationCode, cameraNavigationTranslation, type CameraNavigationCode } from './lib/camera-navigation.js';

type OpeningPatch = { offset: number; bottom: number };
type Callbacks = { selectWall:(id:string|null,side?:'left'|'right')=>void; selectRegion:(id:string|null)=>void; selectCeiling?:(id:string)=>void; selectOpening?:(id:string|null)=>void; previewOpening?:(id:string,patch:OpeningPatch)=>void; commitOpening?:(id:string,patch:OpeningPatch)=>void; selectFurniture?:(id:string|null)=>void; selectServiceRoute?:(id:string|null)=>void; selectCivilElement?:(id:string|null)=>void; selectMunicipalElement?:(id:string|null)=>void; selectLevel?:(id:string)=>void|Promise<void>; error:(message:string)=>void; status?:(message:string)=>void };
type OpeningTarget = { opening:WallOpening; wall:Wall; levelId?:string; elevation:number; sides:{side:number;points:Vec3[]}[]; outline:Mesh };
type OpeningDrag = { id:string; original:WallOpening; wall:Wall; levelId?:string; elevation:number; side:number; project:Project; start:{x:number;y:number}; patch:OpeningPatch };
type Mesh = { buffer:WebGLBuffer; count:number; mode:number };
type FloorMesh = { source:SceneFloor; mesh:Mesh; holes:Mesh[]; outline:Mesh; indices:number[]; texture?:WebGLTexture };
type WallMesh = { source:SceneSurface; mesh:Mesh; outline:Mesh; indices:number[]; texture?:WebGLTexture };
type InsertMesh = { source:SceneInsert; surfaces:WallMesh[] };
type FurnitureMesh = { source:LeveledFurniture; surfaces:{source:SolidSurface;indices:number[]}[]; batches:{mesh:Mesh;color:string}[]; outline:Mesh };
type ServiceMesh = { source:SceneServiceRoute; surfaces:{source:SolidSurface;indices:number[]}[]; mesh:Mesh; centreline:Mesh };
type CivilMesh = { source:SceneCivilElement; surfaces:WallMesh[]; horizontal:FloorMesh[] };
type MunicipalMesh = { source:SceneMunicipalElement; surfaces:{source:SolidSurface;indices:number[]}[]; batches:{color:string;mesh:Mesh}[]; outline:Mesh; horizontal:FloorMesh[]; centreline:Mesh };
type TextureTarget = { source:{color?:string;materialImage?:string}; texture?:WebGLTexture };
type RoomLabel={node:HTMLDivElement;id:string;name:string;point:Vec3;netArea:number;screen?:{x:number;y:number;width:number;height:number}};
const EMPTY:SceneModel={walls:[],floors:[],bounds:{min:{x:0,y:0,z:0},max:{x:0,y:0,z:0},center:{x:0,y:0,z:0},size:{x:0,y:0,z:0}}};
const vertexShader=`
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uVP;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUV;
void main(){vNormal=aNormal;vPosition=aPosition;vUV=aUV;gl_Position=uVP*vec4(aPosition,1.0);}`;
const fragmentShader=`
precision mediump float;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUV;
uniform vec3 uColor;
uniform sampler2D uTexture;
uniform float uTextureMix;
uniform float uGrid;
uniform float uUnlit;
uniform float uOpacity;
void main(){
  vec3 color=mix(uColor,texture2D(uTexture,vUV).rgb,uTextureMix);
  float light=0.76+0.24*max(dot(normalize(vNormal),normalize(vec3(-0.3,0.85,0.45))),0.0);
  color*=mix(light,1.0,uUnlit);
  if(uGrid>0.5){
    vec2 line=abs(fract(vPosition.xz+0.5)-0.5);
    float grid=1.0-step(0.012,min(line.x,line.y));
    color=mix(vec3(0.949,0.945,0.929),vec3(0.879,0.887,0.866),grid*0.45);
  }
  gl_FragColor=vec4(color,uOpacity);
}`;
const rgb=(hex:string):number[]=>[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255);
const vertex=(p:Vec3,n:Vec3={x:0,y:1,z:0})=>[p.x,p.y,p.z,n.x,n.y,n.z,p.x,p.z];
const FLOOR_Y=.012;

/** Real WebGL view of the measured project, without changing geometry or quote data. */
export class Viewer3D {
  readonly canvas:HTMLCanvasElement;
  private gl:WebGLRenderingContext|null=null;
  private program:WebGLProgram|null=null;
  private attributes:{position:number;normal:number;uv:number};
  private uniforms:Record<string,WebGLUniformLocation>={};
  private whiteTexture:WebGLTexture|null=null;
  private model:SceneModel=EMPTY;
  private wallMeshes:WallMesh[]=[];
  private insertMeshes:InsertMesh[]=[];
  private openingTargets:OpeningTarget[]=[];
  private openingDrag:OpeningDrag|null=null;
  private furnitureData:LeveledFurniture[]=[];
  private furnitureMeshes:FurnitureMesh[]=[];
  private serviceData:SceneServiceRoute[]=[];
  private serviceMeshes:ServiceMesh[]=[];
  private selectedServiceRouteId:string|null=null;
  private civilMeshes:CivilMesh[]=[];
  private selectedCivilElementId:string|null=null;
  private selectedMunicipalElementId:string|null=null;
  private municipalData:SceneMunicipalElement[]=[];
  private municipalMeshes:MunicipalMesh[]=[];
  private terrainData:SolidSurface[]=[];
  private terrainMesh:Mesh|null=null;
  private terrainOccluders:TerrainOccluder[]=[];
  private terrainDisplayMode:TerrainDisplayMode='solid';
  private terrainControls:HTMLDivElement;
  private inspectionControls:HTMLDivElement;
  private furnitureAssets:FurnitureAssets|null=null;
  private furnitureAssetsState:'loading'|'ready'|'fallback'='loading';
  private furnitureAssetsRequest=new AbortController();
  private textureCache=new Map<string,{texture?:WebGLTexture;targets:TextureTarget[]}>();
  private project:Project|null=null;
  private floorMeshes:FloorMesh[]=[];
  private slabMeshes:WallMesh[]=[];
  private ground:Mesh|null=null;
  private wallOutline:Mesh|null=null;
  private selectionOutline:Mesh|null=null;
  private selectionOutlineKey='';
  private selectedRegionId:string|null=null;
  private selectedWallId:string|null=null;
  private selectedWallSide:WallFinishSide='both';
  private selectedWallIds:string[]=[];
  private cachedJoinStyle:Project['wallJoinStyle'];
  private selectedOpeningId:string|null=null;
  private selectedFurnitureId:string|null=null;
  private visible=false;
  private cutaway=true;
  private signature='';
  private inputSignature='';
  private contextLost=false;
  private sceneError:string|null=null;
  private contextError:string|null=null;
  private frame=0;
  private generation=0;
  private disposed=false;
  private viewport={width:1,height:1};
  private camera={target:{x:0,y:.5,z:0},distance:12,yaw:Math.PI/4,pitch:Math.PI/3};
  private navigationEnabled=true;
  private navigationKeys=new Set<CameraNavigationCode>();
  private navigationLastTime:number|null=null;
  private navigationSpeed:number|null=null;
  private navigation:HTMLDivElement;
  private navigationToggle:HTMLButtonElement;
  private navigationSelect:HTMLSelectElement;
  private navigationGuide:HTMLParagraphElement;
  private viewProjection=new Float32Array(16);
  private observer:ResizeObserver;
  private overlay:HTMLDivElement;
  private labelLayer:HTMLDivElement;
  private roomLabels:RoomLabel[]=[];
  private showLabels=true;
  private pointer:{id:number;x:number;y:number;lastX:number;lastY:number;pan:boolean;moved:boolean;openingBlocked?:boolean}|null=null;

  constructor(private container:HTMLElement,private callbacks:Callbacks){
    this.canvas=document.createElement('canvas');this.canvas.className='scene-canvas';
    this.canvas.tabIndex=0;
    this.canvas.setAttribute('aria-label','三维视图：点击画布后，WASD 前后左右移动，空格上升，Ctrl 下降，Esc 释放键盘。拖动旋转，右键或 Shift 拖动平移，滚轮缩放。');
    Object.assign(this.canvas.style,{width:'100%',height:'100%',display:'block',touchAction:'none',cursor:'grab'});
    this.overlay=document.createElement('div');this.overlay.className='scene-empty';
    Object.assign(this.overlay.style,{position:'absolute',inset:'0',display:'grid',placeItems:'center',pointerEvents:'none',padding:'32px',color:'#66716c',textAlign:'center',fontSize:'13px'});
    this.labelLayer=document.createElement('div');this.labelLayer.className='scene-labels';
    Object.assign(this.labelLayer.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'});
    this.container.append(this.canvas,this.labelLayer,this.overlay);
    this.navigation=document.createElement('div');this.navigation.className='scene-navigation';
    this.navigation.innerHTML='<div class="scene-navigation-head"><button type="button" class="scene-navigation-toggle" id="navigation-toggle" title="聚焦三维画布并使用键盘移动">开始移动</button><label class="scene-navigation-speed"><span>速度</span><select id="navigation-speed" aria-label="三维移动速度"><option value="auto">自动</option><option value="0.5">精细 · 0.5 m/s</option><option value="2">步行 · 2 m/s</option><option value="10">场地 · 10 m/s</option><option value="50">远景 · 50 m/s</option><option value="200">山地 · 200 m/s</option></select></label></div><p class="scene-navigation-keys"><kbd>W A S D</kbd> 前后左右 · <kbd>Space</kbd> 上升 · <kbd>Ctrl</kbd> 下降</p><p class="scene-navigation-guide" id="scene-navigation-guide">点击画布后移动 · Esc 释放键盘</p>';
    this.navigationToggle=this.navigation.querySelector('#navigation-toggle');
    this.navigationSelect=this.navigation.querySelector('#navigation-speed');
    this.navigationGuide=this.navigation.querySelector('#scene-navigation-guide');
    this.terrainControls=document.createElement('div');this.terrainControls.className='scene-terrain-controls';this.terrainControls.hidden=true;
    this.terrainControls.innerHTML='<span class="scene-terrain-label">地形</span><div class="scene-terrain-segments" role="group" aria-label="三维地形显示"><button type="button" id="terrain-display-solid" data-terrain-display="solid" aria-pressed="true" title="显示真实地形，遮挡地下设施">实景</button><button type="button" id="terrain-display-cutaway" data-terrain-display="cutaway" aria-pressed="false" title="半透明地形，查看与选择地下设施">剖视</button><button type="button" id="terrain-display-hidden" data-terrain-display="hidden" aria-pressed="false" title="暂时隐藏地形，查看地下设施">隐藏</button></div>';
    this.navigation.insertBefore(this.terrainControls,this.navigation.querySelector('.scene-navigation-keys'));
    this.terrainControls.addEventListener('click',this.onTerrainDisplay);
    this.inspectionControls=document.createElement('div');this.inspectionControls.className='scene-inspection-controls';this.inspectionControls.hidden=true;
    this.inspectionControls.innerHTML='<p class="scene-inspection-summary" id="scene-inspection-summary"></p><div class="scene-inspection-actions"><button type="button" id="scene-road-overview" data-scene-inspect="road">查看道路</button><button type="button" id="scene-tunnel-entry" data-scene-inspect="start">洞口</button><button type="button" id="scene-tunnel-inside" data-scene-inspect="inside">洞内</button></div><p class="scene-inspection-note" id="scene-inspection-note" aria-live="polite"></p>';
    this.navigation.insertBefore(this.inspectionControls,this.navigation.querySelector('.scene-navigation-keys'));
    this.inspectionControls.addEventListener('click',this.onSceneInspect);
    this.canvas.setAttribute('aria-describedby','scene-navigation-guide');
    this.container.append(this.navigation);
    this.navigationToggle.addEventListener('click',this.onNavigationToggle);
    this.navigationSelect.addEventListener('change',this.onNavigationSpeed);
    this.initialize();
    this.observer=new ResizeObserver(()=>this.requestRender());this.observer.observe(container);
    this.canvas.addEventListener('pointerdown',this.onPointerDown);
    this.canvas.addEventListener('pointermove',this.onPointerMove);
    this.canvas.addEventListener('pointerup',this.onPointerUp);
    this.canvas.addEventListener('pointercancel',this.onPointerCancel);
    this.canvas.addEventListener('wheel',this.onWheel,{passive:false});
    this.canvas.addEventListener('contextmenu',this.onContextMenu);
    this.canvas.addEventListener('webglcontextlost',this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored',this.onContextRestored);
    window.addEventListener('keydown',this.onKeyDown,true);
    window.addEventListener('keyup',this.onKeyUp,true);
    window.addEventListener('blur',this.onBlur);
    window.addEventListener('focus',this.onWindowFocus);
    this.canvas.addEventListener('focus',this.onCanvasFocus);
    this.canvas.addEventListener('blur',this.onCanvasBlur);
    document.addEventListener('visibilitychange',this.onDocumentVisibility);
    this.updateOverlay();
    this.updateNavigationUI();
    void this.loadFurnitureAssets();
  }

  private async loadFurnitureAssets(){
    try{
      const response=await fetch(FURNITURE_ASSET_URL,{signal:this.furnitureAssetsRequest.signal});
      if(!response.ok)throw new Error('Furniture asset unavailable');
      const assets=validateFurnitureAssets(await response.json());
      if(this.disposed)return;
      this.furnitureAssets=assets;this.furnitureAssetsState='ready';
      // Asset loading changes shape only; preserve the current camera and quote.
      this.inputSignature='';
      if(this.project)this.setProject(this.project,this.selectedRegionId,this.selectedWallId,this.selectedOpeningId,this.selectedWallSide);
    }catch{
      if(this.disposed)return;
      // The measured parameter model remains usable when a local asset is absent.
      this.furnitureAssetsState='fallback';this.requestRender();
    }
  }

  private initialize(){
    try{
      const gl=this.canvas.getContext('webgl',{alpha:false,depth:true,stencil:true,antialias:true,preserveDrawingBuffer:true});
      if(!gl)throw new Error('当前浏览器无法启动三维画布。请使用支持 WebGL 的浏览器，或继续使用二维设计。');
      this.gl=gl;
      if(!gl.getParameter(gl.STENCIL_BITS))throw new Error('当前三维画布不支持孔洞渲染，请使用二维设计。');
      const compile=(type:number,source:string)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error);}return shader;};
      const vs=compile(gl.VERTEX_SHADER,vertexShader),fs=compile(gl.FRAGMENT_SHADER,fragmentShader),program=gl.createProgram();
      gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
      this.program=program;
      this.attributes={position:gl.getAttribLocation(program,'aPosition'),normal:gl.getAttribLocation(program,'aNormal'),uv:gl.getAttribLocation(program,'aUV')};
      for(const name of ['uVP','uColor','uTexture','uTextureMix','uGrid','uUnlit','uOpacity'])this.uniforms[name]=gl.getUniformLocation(program,name);
      this.whiteTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.whiteTexture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);
      this.contextLost=false;this.contextError=null;
    }catch(error){this.contextError=error instanceof Error?error.message:'三维画布启动失败。';this.callbacks.error(this.contextError);}
  }

  setProject(project:Project,selectedRegionId:string|null=null,selectedWallId:string|null=null,selectedOpeningId:string|null=null,selectedWallSide?:WallFinishSide|null){
    if(this.project?.id!==project.id)this.terrainDisplayMode='solid';
    this.selectedRegionId=selectedRegionId;this.selectedWallId=selectedWallId;this.selectedOpeningId=selectedOpeningId;
    this.selectedWallSide=selectedWallSide??project.walls?.find(wall=>wall.id===selectedWallId)?.finishSide??'both';
    this.showLabels=project.view?.labels!==false;
    if(this.project&&(this.project.id!==project.id||this.project.workspaceMode!==project.workspaceMode||this.project.activeLevelId!==project.activeLevelId))this.clearNavigation();
    this.project=structuredClone(project);
    try{
      // Selection and price edits need a redraw, not another polygon union.
      const style=(items:{color?:string;image?:string}[]=[])=>items.map(item=>({color:item.color,image:item.image}));
      const civilShape=(source:any)=>(source.civilElements??[]).map(element=>({id:element.id,name:element.name,kind:element.kind,position:element.position,width:element.width,depth:element.depth,height:element.height,rotation:element.rotation,elevation:element.elevation,hidden:element.hidden,sourceRegionId:element.sourceRegionId,profile:element.profile}));
      const layerSignature=(source:any)=>({walls:source.walls?.map(wall=>({...wall,items:style(wall.items),additionalCost:undefined})),wallShapes:source.wallShapes?.map(shape=>({...shape,items:style(shape.items),additionalCost:undefined})),wallJoinStyle:source.wallJoinStyle,openings:source.openings,wallHeight:source.wallHeight,regions:source.regions?.map(region=>({...region,items:style(region.items),additionalCost:undefined,ceiling:region.ceiling?{enabled:region.ceiling.enabled,height:region.ceiling.height,items:style(region.ceiling.items)}:undefined})),floorOpenings:source.floorOpenings,furniture:source.furniture?.map(item=>({id:item.id,name:item.name,kind:item.kind,position:item.position,width:item.width,depth:item.depth,height:item.height,rotation:item.rotation,mountHeight:item.mountHeight,stairTargetLevelId:item.stairTargetLevelId,stair:item.stair,hidden:item.hidden})),serviceRoutes:source.serviceRoutes?.map(route=>({id:route.id,name:route.name,presetId:route.presetId,points:route.points,diameter:route.diameter,hidden:route.hidden}))});
      const municipalShape=(project.municipalElements??[]).map(element=>({id:element.id,name:element.name,kind:element.kind,catalogId:element.catalogId,rotation:element.rotation,points:element.points,holes:element.holes,width:element.width,depth:element.depth,height:element.height,elevation:element.elevation,hidden:element.hidden,roadLayout:element.roadLayout,junction:element.junction,trafficSignal:element.trafficSignal,bridgeOptions:element.bridgeOptions?{pierSpacing:element.bridgeOptions.pierSpacing,pierHeight:element.bridgeOptions.pierHeight,railingHeight:element.bridgeOptions.railingHeight}:undefined,items:element.items?.map(item=>({id:item.id,name:item.name,thickness:item.thickness}))}));
      for(const [index,element]of(project.municipalElements??[]).entries())Object.assign(municipalShape[index],{roadProfile:element.roadProfile?{enabled:element.roadProfile.enabled,points:element.roadProfile.points,curveTolerance:element.roadProfile.curveTolerance,crossSection:element.roadProfile.crossSection,crossfallPoints:element.roadProfile.crossfallPoints,sideSlopes:element.roadProfile.sideSlopes}:undefined});
      for(const [index,element]of(project.municipalElements??[]).entries()){
        const tunnel=(element as {tunnel?:{enabled:boolean;startStation:number;endStation:number;clearHeight:number;liningThickness:number;shape:string}}).tunnel;
        Object.assign(municipalShape[index],{tunnel:tunnel?{enabled:tunnel.enabled,startStation:tunnel.startStation,endStation:tunnel.endStation,clearHeight:tunnel.clearHeight,liningThickness:tunnel.liningThickness,shape:tunnel.shape}:undefined});
      }
      const inputSignature=JSON.stringify({...layerSignature(project),municipalElements:municipalShape,municipalTerrain:project.municipalTerrain,civilElements:civilShape(project),workspaceMode:project.workspaceMode,levels:project.levels?.map(level=>({...level,content:level.content?{...layerSignature(level.content),civilElements:civilShape(level.content)}:undefined})),activeLevelId:project.activeLevelId,levelMode:project.view?.levelMode,ceilings:project.view?.ceilings,calibration:project.calibration,drawingType:project.drawing?.type});
      const unchanged=inputSignature===this.inputSignature&&this.cachedJoinStyle===project.wallJoinStyle;
      const furniture=unchanged?this.furnitureData:['civil','municipal'].includes(project.workspaceMode)?[]:buildLevelFurniture(project,this.furnitureAssets??undefined);
      const services=unchanged?this.serviceData:['civil','municipal'].includes(project.workspaceMode)?[]:buildSceneServices(project);
      const municipal=unchanged?this.municipalData:project.workspaceMode==='municipal'?buildSceneMunicipal(project):[];
      const terrain=unchanged?this.terrainData:buildTerrainScene(project);
      const model=unchanged?this.model:this.sceneObjectBounds(project.workspaceMode==='municipal'?EMPTY:buildSceneModel(project),[...furniture,...services,...municipal,...(terrain.length?[{surfaces:terrain}]:[])]),signature=unchanged?this.signature:JSON.stringify({model,furniture,services,municipal,terrain,ceilings:project.view?.ceilings??false});
      this.inputSignature=inputSignature;
      this.cachedJoinStyle=project.wallJoinStyle;
      if(signature!==this.signature){
        const wasEmpty=!this.hasGeometry();
        this.model=model;this.furnitureData=furniture;this.serviceData=services;this.municipalData=municipal;this.terrainData=terrain;this.signature=signature;this.sceneError=null;
        this.terrainOccluders=compileTerrainOccluders(terrain);
        if(this.gl&&!this.contextLost&&this.program)this.rebuild();
        if(wasEmpty&&this.hasGeometry())this.fit();
      }
      if(this.gl&&this.program&&!this.contextLost)this.sceneError=null;
    }catch(error){
      const message=error instanceof Error?error.message:'三维几何生成失败。';
      if(this.sceneError!==message)this.callbacks.error(message);
      this.sceneError=message;this.model=EMPTY;this.furnitureData=[];this.serviceData=[];this.municipalData=[];this.terrainData=[];this.signature='';this.inputSignature='';this.releaseMeshes();
      this.terrainOccluders=[];
    }
    this.updateOverlay();this.updateNavigationUI();this.updateTerrainDisplayUI();this.requestRender();
  }
  setVisible(visible:boolean){if(!visible)this.cancel();this.visible=visible;this.container.hidden=!visible;this.updateNavigationUI();if(visible)this.requestRender();}
  get isEditing(){return this.openingDrag!==null;}
  cancel(){
    this.clearNavigation();
    const drag=this.openingDrag,pointer=this.pointer;this.openingDrag=null;this.pointer=null;
    if(pointer&&this.canvas.hasPointerCapture(pointer.id))this.canvas.releasePointerCapture(pointer.id);
    this.canvas.style.cursor='grab';
    if(drag)this.callbacks.previewOpening?.(drag.id,{offset:drag.original.offset,bottom:drag.original.bottom});
    this.requestRender();
  }
  setSelectedFurniture(id:string|null){this.selectedFurnitureId=id;this.requestRender();}
  setSelectedServiceRoute(id:string|null){this.selectedServiceRouteId=id;this.requestRender();}
  setSelectedCivilElement(id:string|null){this.selectedCivilElementId=id;this.requestRender();}
  setSelectedMunicipalElement(id:string|null){this.selectedMunicipalElementId=id;this.updateInspectionUI();this.requestRender();}
  /** A dedicated inspection action reveals measured geometry without changing
   * facility elevations, terrain, project history or any quotation values. */
  inspectMunicipalElement(id:string):boolean{
    const item=this.municipalData.find(value=>value.id===id);if(!item||!this.focusMunicipalElement(id))return false;
    this.selectedMunicipalElementId=id;
    const roadPoints=item.segments.flatMap(segment=>[segment.start,{x:(segment.start.x+segment.end.x)/2,y:(segment.start.y+segment.end.y)/2,z:(segment.start.z+segment.end.z)/2},segment.end]);
    const caps=item.horizontal.filter(cap=>(cap.normalY??1)>0).flatMap(cap=>{
      const indices=triangulateXZ(cap.points),centers:Vec3[]=[];
      for(let i=0;i<indices.length;i+=3){
        const triangle=indices.slice(i,i+3).map(index=>cap.points[index]);
        const center=triangle.reduce((sum,p)=>({x:sum.x+p.x/3,y:sum.y+p.y/3,z:sum.z+p.z/3}),{x:0,y:0,z:0});
        if(!cap.holes.some(hole=>pointInRingXZ(center,hole)))centers.push(center);
      }
      const midpoint=cap.points.reduce((sum,p)=>({x:sum.x+p.x/cap.points.length,y:sum.y+p.y/cap.points.length,z:sum.z+p.z/cap.points.length}),{x:0,y:0,z:0});
      if(pointInRingXZ(midpoint,cap.points)&&!cap.holes.some(hole=>pointInRingXZ(midpoint,hole)))centers.push(midpoint);
      return [...cap.points,...centers];
    });
    const top=item.surfaces.filter(surface=>surface.normal.y>.05).map(surface=>surface.points.reduce((sum,p)=>({x:sum.x+p.x/surface.points.length,y:sum.y+p.y/surface.points.length,z:sum.z+p.z/surface.points.length}),{x:0,y:0,z:0}));
    const candidates=[...roadPoints,...caps,...top],stride=Math.max(1,Math.ceil(candidates.length/64));
    const points=candidates.filter((_,index)=>index%stride===0);
    if(this.terrainDisplayMode==='solid'&&terrainCoversInspectionPoints(this.terrainOccluders,points))this.setTerrainDisplayMode('cutaway');
    this.updateTerrainDisplayUI();this.requestRender();return true;
  }
  focusMunicipalElement(id:string):boolean{
    const item=this.municipalData.find(item=>item.id===id);if(!item)return false;
    this.clearNavigation();
    const detail=item.kind==='trafficlight'?item.surfaces.filter(surface=>/signal-(housing|lens)/.test(surface.id)):item.surfaces;
    const points=[...detail.flatMap(surface=>surface.points),...(item.kind==='trafficlight'?[]:item.horizontal.flatMap(cap=>cap.points))];
    if(!points.length)return false;
    const min={...points[0]},max={...points[0]};for(const point of points)for(const axis of ['x','y','z'] as const){min[axis]=Math.min(min[axis],point[axis]);max[axis]=Math.max(max[axis],point[axis]);}
    this.camera.target={x:(min.x+max.x)/2,y:(min.y+max.y)/2,z:(min.z+max.z)/2};
    const rect=this.container.getBoundingClientRect(),fov=Math.PI/4,horizontal=2*Math.atan(Math.tan(fov/2)*Math.max(.2,rect.width/Math.max(1,rect.height)));
    this.camera.distance=Math.max(1,Math.hypot(max.x-min.x,max.y-min.y,max.z-min.z))/(2*Math.sin(Math.min(fov,horizontal)/2))*1.25;
    const source=this.project.municipalElements?.find(value=>value.id===id);
    this.camera.yaw=item.kind==='trafficlight'?Math.PI-(source?.trafficSignal?.rotation??0)*Math.PI/180:Math.PI/4;
    this.camera.pitch=item.kind==='trafficlight'?.12:Math.PI/6;
    this.updateNavigationUI();this.requestRender();return true;
  }
  setTerrainDisplayMode(mode:TerrainDisplayMode){
    terrainDisplaySettings(mode);
    if(this.terrainDisplayMode===mode)return;
    this.terrainDisplayMode=mode;this.updateTerrainDisplayUI();this.requestRender();
  }
  private updateTerrainDisplayUI(){
    if(!this.terrainControls)return;
    this.terrainControls.hidden=!this.terrainData.length;
    for(const button of this.terrainControls.querySelectorAll<HTMLButtonElement>('[data-terrain-display]')){
      button.setAttribute('aria-pressed',String(button.dataset.terrainDisplay===this.terrainDisplayMode));
      button.disabled=!!(this.contextLost||this.sceneError||!this.gl);
    }
    this.updateInspectionUI();
  }
  private inspectionRoad(tunnelOnly=false):SceneMunicipalElement|undefined{
    const roads=this.municipalData.filter(item=>item.kind==='road'&&(!tunnelOnly||item.tunnel?.enabled));
    return roads.find(item=>item.id===this.selectedMunicipalElementId)??roads.find(item=>item.tunnel?.enabled)??roads[0];
  }
  private updateInspectionUI(){
    if(!this.inspectionControls)return;
    const roads=this.municipalData.filter(item=>item.kind==='road'),tunnels=roads.filter(item=>item.tunnel?.enabled);
    this.inspectionControls.hidden=!roads.length;
    this.inspectionControls.querySelector('#scene-inspection-summary').textContent=`已生成 ${roads.length} 条道路 · ${tunnels.length} 段隧道`;
    for(const button of this.inspectionControls.querySelectorAll<HTMLButtonElement>('[data-scene-inspect]'))button.disabled=!!(this.contextLost||this.sceneError||!this.gl)||!(button.dataset.sceneInspect==='road'?roads.length:tunnels.length);
    const selected=roads.find(item=>item.id===this.selectedMunicipalElementId);
    this.inspectionControls.querySelector('#scene-inspection-note').textContent=selected?`${this.terrainDisplayMode==='cutaway'?'剖视 · ':this.terrainDisplayMode==='hidden'?'地形已隐藏 · ':''}${selected.name}`:'点击查看道路，自动定位可见模型';
  }
  private onSceneInspect=(event:MouseEvent)=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-scene-inspect]');if(!button||button.disabled)return;
    const position=button.dataset.sceneInspect,item=this.inspectionRoad(position!=='road');if(!item)return;
    this.callbacks.selectMunicipalElement?.(item.id);
    if(position==='road')this.inspectMunicipalElement(item.id);else this.focusTunnel(item.id,position as TunnelInspectionPosition);
    this.updateInspectionUI();
  };
  private onTerrainDisplay=(event:MouseEvent)=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-terrain-display]');
    if(!button||button.disabled)return;
    this.setTerrainDisplayMode(button.dataset.terrainDisplay as TerrainDisplayMode);
  };
  focusTunnel(id:string,position:TunnelInspectionPosition='inside'):boolean{
    const item=this.municipalData.find(item=>item.id===id) as SceneMunicipalElement&{tunnel?:TunnelInspectionGeometry};
    const camera=item?.tunnel?tunnelInspectionCamera(item.tunnel,position):null;if(!camera)return false;
    this.clearNavigation();this.camera=camera;
    this.selectedMunicipalElementId=id;this.setNavigationEnabled(true);this.canvas.focus({preventScroll:true});
    this.updateNavigationUI();this.updateInspectionUI();this.requestRender();return true;
  }
  setCutaway(enabled:boolean){if(this.cutaway===enabled)return;this.cutaway=enabled;if(this.gl&&!this.contextLost)this.rebuild();this.requestRender();}
  zoom(factor:number){if(!Number.isFinite(factor)||factor<=0)return;this.camera.distance=Math.min(2000,Math.max(.25,this.camera.distance/factor));this.updateNavigationUI();this.requestRender();}
  fit(){
    this.clearNavigation();
    const {size,center}=this.model.bounds;
    this.camera.target={x:center.x,y:['civil','municipal'].includes(this.project?.workspaceMode)||this.model.levels?.length?center.y:Math.max(.15,size.y*.25),z:center.z};
    const rect=this.container.getBoundingClientRect(),aspect=rect.width/Math.max(1,rect.height),fov=Math.PI/4;
    const horizontalFov=2*Math.atan(Math.tan(fov/2)*Math.max(.2,aspect));
    const diameter=Math.max(2,Math.hypot(size.x,size.z,size.y));
    this.camera.distance=diameter/(2*Math.sin(Math.min(fov,horizontalFov)/2))*1.16;
    this.camera.yaw=Math.PI/4;this.camera.pitch=Math.PI/3;
    this.updateNavigationUI();this.requestRender();
  }
  private sceneObjectBounds(model:SceneModel,objects:{surfaces:SolidSurface[];horizontal?:SceneFloor[]}[]):SceneModel{
    if(!objects.length)return model;
    const points=objects.flatMap(item=>[...item.surfaces.flatMap(surface=>surface.points),...(item.horizontal??[]).flatMap(cap=>cap.points)]);
    if(!points.length)return model;
    if(model.walls.length||model.floors.length)points.push(model.bounds.min,model.bounds.max);
    const min={...points[0]},max={...points[0]};
    for(const point of points)for(const axis of ['x','y','z'] as const){min[axis]=Math.min(min[axis],point[axis]);max[axis]=Math.max(max[axis],point[axis]);}
    return {...model,bounds:{min,max,center:{x:(min.x+max.x)/2,y:(min.y+max.y)/2,z:(min.z+max.z)/2},size:{x:max.x-min.x,y:max.y-min.y,z:max.z-min.z}}};
  }
  private hasGeometry(){return !!(this.model.walls.length||this.model.floors.length||this.furnitureData.length||this.serviceData.length||this.model.civilElements?.length||this.municipalData.length||this.terrainData.length);}
  private updateOverlay(){
    const error=this.contextLost?'三维画布连接中断。恢复后将自动重绘；也可切回二维继续设计。':this.contextError||this.sceneError;
    this.overlay.textContent=error||(!this.hasGeometry()?this.project?.workspaceMode==='municipal'?'先在二维绘制道路、管线或设施，三维场地会自动生成。':'先在二维画墙线或划分区域，三维视图会自动生成。':'');
    this.overlay.style.display=this.overlay.textContent?'grid':'none';
  }
  private makeMesh(data:number[],mode:number=this.gl.TRIANGLES):Mesh{
    const gl=this.gl,buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
    return {buffer,count:data.length/8,mode};
  }
  private floorData(points:Vec3[],indices:number[],height=FLOOR_Y,normalY=1){return indices.flatMap(i=>vertex({...points[i],y:height},{x:0,y:normalY,z:0}));}
  private ringLines(rings:Vec3[][],height:number){
    const data:number[]=[];for(const ring of rings)for(let i=0;i<ring.length;i++)data.push(...vertex({...ring[i],y:height}),...vertex({...ring[(i+1)%ring.length],y:height}));return data;
  }
  private surfaceMesh(source:SceneSurface):WallMesh{
    const indices=triangulateSurface(source.points,source.normal),normal=source.normal;
    const data=indices.flatMap(index=>{
      const p=source.points[index],u=Math.abs(normal.y)>.9?p.x:normal.z*p.x-normal.x*p.z,v=Math.abs(normal.y)>.9?p.z:p.y;
      return [p.x,p.y,p.z,normal.x,normal.y,normal.z,u,v];
    });
    const lines=source.points.flatMap((p,index)=>[...vertex(p),...vertex(source.points[(index+1)%source.points.length])]);
    return {source,indices,mesh:this.makeMesh(data),outline:this.makeMesh(lines,this.gl.LINES)};
  }
  private releaseMeshes(){
    if(!this.gl)return;const gl=this.gl;
    for(const wall of this.wallMeshes){gl.deleteBuffer(wall.mesh.buffer);gl.deleteBuffer(wall.outline.buffer);}
    for(const slab of this.slabMeshes){gl.deleteBuffer(slab.mesh.buffer);gl.deleteBuffer(slab.outline.buffer);}
    for(const insert of this.insertMeshes)for(const surface of insert.surfaces){gl.deleteBuffer(surface.mesh.buffer);gl.deleteBuffer(surface.outline.buffer);}
    for(const target of this.openingTargets)gl.deleteBuffer(target.outline.buffer);
    for(const furniture of this.furnitureMeshes){for(const batch of furniture.batches)gl.deleteBuffer(batch.mesh.buffer);gl.deleteBuffer(furniture.outline.buffer);}
    for(const service of this.serviceMeshes){gl.deleteBuffer(service.mesh.buffer);gl.deleteBuffer(service.centreline.buffer);}
    for(const element of this.civilMeshes){for(const surface of element.surfaces){gl.deleteBuffer(surface.mesh.buffer);gl.deleteBuffer(surface.outline.buffer);}for(const cap of element.horizontal)for(const mesh of [cap.mesh,cap.outline,...cap.holes])gl.deleteBuffer(mesh.buffer);}
    for(const element of this.municipalMeshes){for(const batch of element.batches)gl.deleteBuffer(batch.mesh.buffer);gl.deleteBuffer(element.outline.buffer);for(const cap of element.horizontal)for(const mesh of[cap.mesh,cap.outline,...cap.holes])gl.deleteBuffer(mesh.buffer);gl.deleteBuffer(element.centreline.buffer);}
    if(this.terrainMesh)gl.deleteBuffer(this.terrainMesh.buffer);this.terrainMesh=null;
    for(const floor of this.floorMeshes)for(const mesh of [floor.mesh,floor.outline,...floor.holes])gl.deleteBuffer(mesh.buffer);
    for(const cached of this.textureCache.values())if(cached.texture)gl.deleteTexture(cached.texture);
    this.textureCache.clear();
    if(this.ground)gl.deleteBuffer(this.ground.buffer);
    if(this.wallOutline)gl.deleteBuffer(this.wallOutline.buffer);
    if(this.selectionOutline)gl.deleteBuffer(this.selectionOutline.buffer);
    this.wallOutline=null;this.selectionOutline=null;this.selectionOutlineKey='';
    this.wallMeshes=[];this.slabMeshes=[];this.insertMeshes=[];this.openingTargets=[];this.furnitureMeshes=[];this.serviceMeshes=[];this.civilMeshes=[];this.municipalMeshes=[];this.floorMeshes=[];this.ground=null;this.generation++;
    this.roomLabels=[];this.labelLayer.replaceChildren();
  }
  private rebuild(){
    this.releaseMeshes();const gl=this.gl,generation=this.generation;
    const span=Math.max(8,this.model.bounds.size.x,this.model.bounds.size.z)*2,center=this.model.bounds.center;
    const groundY=['civil','municipal'].includes(this.project?.workspaceMode)?Math.min(0,this.model.bounds.min.y)-.04:-.04;
    const ground=[{x:center.x-span,y:groundY,z:center.z-span},{x:center.x+span,y:groundY,z:center.z-span},{x:center.x+span,y:groundY,z:center.z+span},{x:center.x-span,y:groundY,z:center.z+span}];
    if(!this.terrainData.length)this.ground=this.makeMesh(this.floorData(ground,[0,1,2,0,2,3],groundY));
    // Terrain is a background layer: retain every real triangle and normal in
    // one draw batch rather than allocating two GPU buffers per DEM triangle.
    const terrainVertices:number[]=[];
    for(const [surfaceIndex,surface]of this.terrainData.entries())for(const index of this.terrainOccluders[surfaceIndex].indices)terrainVertices.push(...vertex(surface.points[index],surface.normal));
    if(terrainVertices.length)this.terrainMesh=this.makeMesh(terrainVertices);
    if(this.project&&!['civil','municipal'].includes(this.project.workspaceMode)){
      const solid=this.cutaway?(this.project.levels?.length?buildSceneModel(this.project,.6):buildWallSolid(this.project,.6)):{surfaces:this.model.surfaces??[],inserts:this.model.inserts??[]};
      for(const source of solid.surfaces){const surface=this.surfaceMesh(source);this.wallMeshes.push(surface);if(source.materialImage&&source.side!=='reveal')this.loadTexture(surface,generation);}
      for(const source of solid.inserts)if(source.surfaces.length)this.insertMeshes.push({source,surfaces:source.surfaces.map(surface=>this.surfaceMesh(surface))});
      this.wallOutline=this.makeMesh(creaseSegments(solid.surfaces).flatMap(point=>vertex(point)),gl.LINES);
      const layers=this.project.levels?.length?levelProjects(this.project).filter(level=>this.model.levels?.some(visible=>visible.id===level.id)):[{id:undefined,elevation:0,project:this.project}];
      for(const layer of layers)for(const opening of layer.project.openings??[]){
        const wall=layer.project.walls?.find(wall=>wall.id===opening.wallId);if(!wall)continue;
        const sides=[-wall.thickness/200-.0005,wall.thickness/200+.0005].map(side=>({side,points:openingContour3D(opening,wall,layer.elevation,side)}));
        const lines=sides.flatMap(({points})=>points.flatMap((point,index)=>[...vertex(point),...vertex(points[(index+1)%points.length])]));
        this.openingTargets.push({opening,wall,levelId:layer.id,elevation:layer.elevation,sides,outline:this.makeMesh(lines,gl.LINES)});
      }
    }
    for(const slab of this.model.slabs??[])for(const surface of slab.surfaces)this.slabMeshes.push(this.surfaceMesh(surface));
    for(const source of this.furnitureData){
      const colors=new Map<string,number[]>();
      const surfaces=source.surfaces.map(surface=>{
        const indices=triangulateSurface(surface.points,surface.normal),color=surface.color||'#c5c9be';
        const data=colors.get(color)??[];
        for(const index of indices)data.push(...vertex(surface.points[index],surface.normal));
        colors.set(color,data);return {source:surface,indices};
      });
      this.furnitureMeshes.push({source,surfaces,batches:[...colors].map(([color,data])=>({color,mesh:this.makeMesh(data)})),
        outline:this.makeMesh(creaseSegments(source.surfaces).flatMap(point=>vertex(point)),gl.LINES)});
    }
    for(const source of this.serviceData){
      const data:number[]=[];
      const surfaces=source.surfaces.map(surface=>{const indices=triangulateSurface(surface.points,surface.normal);for(const index of indices)data.push(...vertex(surface.points[index],surface.normal));return {source:surface,indices};});
      this.serviceMeshes.push({source,surfaces,mesh:this.makeMesh(data),centreline:this.makeMesh(source.segments.flatMap(segment=>[...vertex(segment.start),...vertex(segment.end)]),gl.LINES)});
    }
    for(const source of this.model.civilElements??[]){
      const horizontal=source.horizontal.map(cap=>{const height=cap.points[0]?.y??0,normalY=cap.normalY??1,indices=triangulateXZ(cap.points);return {source:cap,indices,mesh:this.makeMesh(this.floorData(cap.points,indices,height,normalY)),holes:cap.holes.map(hole=>this.makeMesh(this.floorData(hole,triangulateXZ(hole),height,normalY))),outline:this.makeMesh(this.ringLines([cap.points,...cap.holes],height),gl.LINES)};});
      this.civilMeshes.push({source,horizontal,surfaces:source.surfaces.map(surface=>this.surfaceMesh(surface))});
    }
    for(const source of this.municipalData){
      const horizontal=source.horizontal.map(cap=>{const height=cap.points[0]?.y??0,normalY=cap.normalY??1,indices=triangulateXZ(cap.points);return{source:cap,indices,mesh:this.makeMesh(this.floorData(cap.points,indices,height,normalY)),holes:cap.holes.map(hole=>this.makeMesh(this.floorData(hole,triangulateXZ(hole),height,normalY))),outline:this.makeMesh(this.ringLines([cap.points,...cap.holes],height),gl.LINES)};});
      const centreline=source.segments.flatMap(segment=>[...vertex(segment.start),...vertex(segment.end)]);
      const colors=new Map<string,number[]>();
      const surfaces=source.surfaces.map(surface=>{
        const indices=triangulateSurface(surface.points,surface.normal),color=surface.color??source.color,data=colors.get(color)??[];
        for(const index of indices)data.push(...vertex(surface.points[index],surface.normal));
        colors.set(color,data);return{source:surface,indices};
      });
      this.municipalMeshes.push({source,horizontal,surfaces,batches:[...colors].map(([color,data])=>({color,mesh:this.makeMesh(data)})),outline:this.makeMesh(creaseSegments(source.surfaces).flatMap(point=>vertex(point)),gl.LINES),centreline:this.makeMesh(centreline,gl.LINES)});
    }
    // A ring void can leave a centre island, and a boundary cut can split the
    // floor. Keep one room label with the total area, anchored on its largest part.
    const labelFloors = new Map<string,{floor:SceneFloor;label:ReturnType<typeof floorLabelData>;area:number}>();
    for (const floor of this.model.floors) {
      const key=`${floor.levelId??''}:${floor.regionId??floor.id}`,label=floorLabelData(floor);
      if (!label) continue;
      const current=labelFloors.get(key);
      if (!current) labelFloors.set(key,{floor,label,area:label.netArea});
      else { current.area+=label.netArea; if (label.netArea>current.label.netArea) { current.floor=floor;current.label=label; } }
    }
    const horizontal=[...this.model.floors,...(this.model.slabs??[]).map(slab=>slab.underside),...(this.project?.view?.ceilings?this.model.ceilings??[]:[])];
    for(const floor of horizontal){
      const height=(floor.points[0]?.y??0)+(floor.surfaceType==='slab-bottom'?-.002:floor.surfaceType==='ceiling'?0:FLOOR_Y),normalY=floor.normalY??1;
      const indices=triangulateXZ(floor.points),mesh:FloorMesh={source:floor,indices,mesh:this.makeMesh(this.floorData(floor.points,indices,height,normalY)),holes:floor.holes.map(hole=>this.makeMesh(this.floorData(hole,triangulateXZ(hole),height,normalY))),outline:this.makeMesh(this.ringLines([floor.points,...floor.holes],height+.008),gl.LINES)};
      this.floorMeshes.push(mesh);if(floor.materialImage)this.loadTexture(mesh,generation);
      if(floor.surfaceType==='ceiling'||floor.surfaceType==='slab-bottom')continue;
      const group=labelFloors.get(`${floor.levelId??''}:${floor.regionId??floor.id}`);
      const label=group?.floor===floor?{...group.label,netArea:group.area}:null;
      if(label){
        const regionId=floor.regionId??floor.id;
        const node=document.createElement('div');node.className='scene-room-label';node.dataset.regionId=regionId;
        Object.assign(node.style,{position:'absolute',transform:'translate(-50%, -50%)',padding:'6px 10px',maxWidth:'148px',width:'max-content',background:'rgba(255,255,255,.93)',border:'1px solid rgba(85,106,94,.18)',borderRadius:'6px',color:'#36443d',textAlign:'center',fontSize:'12px',lineHeight:'16px',pointerEvents:'none'});
        const labelName=this.model.levels?.length>1?`${floor.levelName} · ${floor.name}`:floor.name;
        const name=document.createElement('div');name.textContent=labelName;Object.assign(name.style,{fontWeight:'600',maxWidth:'126px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
        const area=document.createElement('div');area.textContent=label.netArea.toFixed(2)+' m²';Object.assign(area.style,{fontSize:'11px',color:'#738177',fontVariantNumeric:'tabular-nums'});
        node.append(name,area);this.labelLayer.append(node);this.roomLabels.push({node,id:regionId,name:labelName,...label,point:floor.levelId?{...label.point,y:(floor.points[0]?.y??0)+.02}:label.point});
      }
    }
  }
  private loadTexture(target:TextureTarget,generation:number){
    const url=target.source.materialImage,cached=this.textureCache.get(url);
    if(cached){cached.targets.push(target);if(cached.texture)target.texture=cached.texture;return;}
    const record:{texture?:WebGLTexture;targets:TextureTarget[]}={targets:[target]};this.textureCache.set(url,record);
    const image=new Image();image.crossOrigin='anonymous';
    image.onload=()=>{
      if(this.disposed||this.contextLost||generation!==this.generation)return;
      try{
        const surface=document.createElement('canvas');surface.width=surface.height=256;const context=surface.getContext('2d');
        context.fillStyle=target.source.color||'#e9e8e0';context.fillRect(0,0,256,256);context.drawImage(image,0,0,256,256);
        const gl=this.gl,texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,surface);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
        record.texture=texture;for(const pending of record.targets)pending.texture=texture;this.requestRender();
      }catch{this.callbacks.status?.('部分材质预览无法载入，已保留材料颜色。');}
    };
    image.onerror=()=>{if(generation===this.generation)this.callbacks.status?.('部分材质预览无法载入，已保留材料颜色。');};
    image.src=url;
  }
  private cameraEye():Vec3{
    const {distance,yaw,pitch,target}=this.camera;
    return {x:target.x+distance*Math.cos(pitch)*Math.sin(yaw),y:target.y+distance*Math.sin(pitch),z:target.z+distance*Math.cos(pitch)*Math.cos(yaw)};
  }
  private updateCamera(){
    const rect=this.container.getBoundingClientRect(),width=Math.max(1,rect.width),height=Math.max(1,rect.height),ratio=Math.min(2,window.devicePixelRatio||1);
    this.viewport={width,height};const pixelWidth=Math.round(width*ratio),pixelHeight=Math.round(height*ratio);
    if(this.canvas.width!==pixelWidth||this.canvas.height!==pixelHeight){this.canvas.width=pixelWidth;this.canvas.height=pixelHeight;}
    // A distant site overview needs enough depth precision to separate its
    // centimetre-high markings from the road surface. Scale the near plane
    // with the orbit distance while retaining the 5 mm close-inspection limit.
    const near=Math.max(.005,this.camera.distance/100),far=Math.max(100,this.camera.distance*20+Math.hypot(this.model.bounds.size.x,this.model.bounds.size.z));
    this.viewProjection=multiply4(perspective4(Math.PI/4,width/height,near,far),lookAt4(this.cameraEye(),this.camera.target));
  }
  private requestRender(){if(this.disposed||!this.visible||this.frame)return;this.frame=requestAnimationFrame(timestamp=>{this.frame=0;this.advanceNavigation(timestamp);this.render();if(this.navigationKeys.size)this.requestRender();});}
  private draw(mesh:Mesh,color:number[],texture?:WebGLTexture,grid=false,unlit=false,opacity=1){
    const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,mesh.buffer);
    for(const [attribute,size,offset] of [[this.attributes.position,3,0],[this.attributes.normal,3,12],[this.attributes.uv,2,24]]){gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,size,gl.FLOAT,false,32,offset);}
    gl.uniform3fv(this.uniforms.uColor,color);gl.uniform1f(this.uniforms.uTextureMix,texture?.65:0);gl.uniform1f(this.uniforms.uGrid,+grid);gl.uniform1f(this.uniforms.uUnlit,+unlit);
    gl.uniform1f(this.uniforms.uOpacity,opacity);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture||this.whiteTexture);gl.uniform1i(this.uniforms.uTexture,0);gl.drawArrays(mesh.mode,0,mesh.count);
  }
  private render(){
    if(!this.gl||!this.program||this.contextLost||this.disposed)return;
    const gl=this.gl;this.updateCamera();gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.clearColor(.97,.97,.954,1);gl.stencilMask(255);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);gl.useProgram(this.program);gl.uniformMatrix4fv(this.uniforms.uVP,false,this.viewProjection);
    if(this.sceneError||!this.hasGeometry()){this.labelLayer.hidden=true;return;}
    const terrainDisplay=terrainDisplaySettings(this.terrainDisplayMode);
    if(this.ground&&!this.terrainData.length)this.draw(this.ground,[.95,.95,.94],undefined,true);
    if(this.terrainMesh&&terrainDisplay.writeDepth)this.draw(this.terrainMesh,rgb('#c2ceba'));
    for(const floor of this.floorMeshes){
      if(floor.holes.length){
        gl.stencilMask(255);gl.clear(gl.STENCIL_BUFFER_BIT);gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.ALWAYS,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);
        gl.colorMask(false,false,false,false);gl.depthMask(false);gl.disable(gl.DEPTH_TEST);
        for(const hole of floor.holes)this.draw(hole,[1,1,1]);
        gl.colorMask(true,true,true,true);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.stencilMask(0);gl.stencilFunc(gl.EQUAL,0,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);
      }
      const selected=(floor.source.regionId??floor.source.id)===this.selectedRegionId&&floor.source.surfaceType!=='slab-bottom';
      this.draw(floor.mesh,rgb(floor.source.color),floor.texture);
      gl.disable(gl.STENCIL_TEST);
      if(selected)this.draw(floor.outline,rgb('#1c7664'),undefined,false,true);
    }
    for(const slab of this.slabMeshes)this.draw(slab.mesh,rgb(slab.source.color||'#d8d7cd'));
    gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);
    for(const wall of this.wallMeshes){
      const selected=wall.source.openingId===this.selectedOpeningId&&!!this.selectedOpeningId;
      this.draw(wall.mesh,rgb(wall.source.color||(selected?'#73a99c':'#e9e8e0')),wall.texture);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if(this.wallOutline)this.draw(this.wallOutline,rgb('#c1c4bb'),undefined,false,true);
    this.renderFurniture();
    this.renderInserts();
    this.renderServices();
    this.renderCivil();
    this.renderMunicipal();
    if(this.terrainMesh&&terrainDisplay.drawTerrain&&!terrainDisplay.writeDepth){
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
      this.draw(this.terrainMesh,rgb('#c2ceba'),undefined,false,false,terrainDisplay.opacity);
      gl.depthMask(true);gl.disable(gl.BLEND);
    }
    this.renderSelectedWallFaces();
    this.renderSelectionOutline();
    this.renderOpeningGuides();
    gl.stencilMask(255);
    this.renderLabels();
  }
  private renderFurniture(){
    const gl=this.gl;
    gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);
    for(const furniture of this.furnitureMeshes)for(const batch of furniture.batches)this.draw(batch.mesh,rgb(batch.color));
    gl.disable(gl.POLYGON_OFFSET_FILL);
    for(const furniture of this.furnitureMeshes)if(furniture.source.geometrySource==='parametric'||furniture.source.id===this.selectedFurnitureId)this.draw(furniture.outline,rgb(furniture.source.id===this.selectedFurnitureId?'#1c7664':'#a5a79b'),undefined,false,true);
    const selected=this.furnitureMeshes.find(item=>item.source.id===this.selectedFurnitureId);
    if(selected){gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1,-1);
      for(const batch of selected.batches)this.draw(batch.mesh,rgb('#2b8a76'),undefined,false,true,.2);
      gl.disable(gl.POLYGON_OFFSET_FILL);gl.depthMask(true);gl.disable(gl.BLEND);}
  }
  private renderServices(){
    const gl=this.gl;
    for(const service of this.serviceMeshes){
      const selected=service.source.id===this.selectedServiceRouteId;
      this.draw(service.mesh,rgb(selected?'#1c7664':service.source.color),undefined,false,selected);
      // A one-pixel centreline makes narrow wires readable without changing
      // their physical diameter. Depth testing keeps concealed runs concealed.
      this.draw(service.centreline,rgb(selected?'#164f43':service.source.color),undefined,false,true);
    }
  }
  private renderCivil(){
    const gl=this.gl;
    for(const element of this.civilMeshes){
      const selected=element.source.id===this.selectedCivilElementId,color=rgb(selected?'#80a89a':element.source.color);
      for(const surface of element.surfaces)this.draw(surface.mesh,color);
      for(const cap of element.horizontal){
        if(cap.holes.length){gl.stencilMask(255);gl.clear(gl.STENCIL_BUFFER_BIT);gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.ALWAYS,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);gl.colorMask(false,false,false,false);gl.depthMask(false);gl.disable(gl.DEPTH_TEST);for(const hole of cap.holes)this.draw(hole,[1,1,1]);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.stencilMask(0);gl.stencilFunc(gl.EQUAL,0,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);}
        this.draw(cap.mesh,color);gl.disable(gl.STENCIL_TEST);
        if(selected)this.draw(cap.outline,rgb('#1c7664'),undefined,false,true);
      }
      if(selected)for(const surface of element.surfaces)this.draw(surface.outline,rgb('#1c7664'),undefined,false,true);
    }
  }
  private renderMunicipal(){
    const gl=this.gl;
    for(const element of this.municipalMeshes){
      const selected=element.source.id===this.selectedMunicipalElementId;
      // Resolve coplanar road/terrain depth ties in the rasterizer only. Actual
      // surveyed elevations and underground occlusion remain unchanged.
      if(element.source.kind==='road'){gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1,-1);}
      for(const batch of element.batches)this.draw(batch.mesh,rgb(batch.color));
      for(const cap of element.horizontal){
        if(cap.holes.length){gl.stencilMask(255);gl.clear(gl.STENCIL_BUFFER_BIT);gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.ALWAYS,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);gl.colorMask(false,false,false,false);gl.depthMask(false);gl.disable(gl.DEPTH_TEST);for(const hole of cap.holes)this.draw(hole,[1,1,1]);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.stencilMask(0);gl.stencilFunc(gl.EQUAL,0,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);}
        this.draw(cap.mesh,rgb(cap.source.color));gl.disable(gl.STENCIL_TEST);
        if(selected)this.draw(cap.outline,rgb('#1c7664'),undefined,false,true);
      }
      if(element.source.kind==='road')gl.disable(gl.POLYGON_OFFSET_FILL);
      if(element.source.segments.length&&!['trafficlight','streetlight'].includes(element.source.kind))this.draw(element.centreline,rgb(selected?'#1c7664':element.source.color),undefined,false,true);
      if(selected)this.draw(element.outline,rgb('#1c7664'),undefined,false,true);
    }
  }
  setSelectedWallGroup(ids:string[]=[] ){this.selectedWallIds=[...ids];this.requestRender();}
  private selectedFaces(surfaces:SolidSurface[]){return this.selectedWallIds.length?wallShapeSelection(surfaces,this.selectedWallIds,this.selectedWallSide):wallSelection(surfaces,this.selectedWallId,this.selectedWallSide);}
  private renderSelectedWallFaces(){
    if(!this.selectedWallId||this.selectedOpeningId)return;
    const ids=new Set(this.selectedFaces(this.wallMeshes.map(mesh=>mesh.source)).surfaces.map(surface=>surface.id));
    if(!ids.size)return;
    const gl=this.gl;
    // Blend on selected polygons after inserts. Depth testing retains real
    // occlusion instead of colouring buried wall faces or filled apertures.
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1,-1);
    for(const wall of this.wallMeshes)if(ids.has(wall.source.id))this.draw(wall.mesh,rgb('#2b8a76'),undefined,false,true,.28);
    gl.disable(gl.POLYGON_OFFSET_FILL);gl.depthMask(true);gl.disable(gl.BLEND);
  }
  private renderInserts(){
    const gl=this.gl;
    for(const insert of this.insertMeshes.filter(insert=>insert.source.kind==='door')){
      for(const surface of insert.surfaces)this.draw(surface.mesh,rgb(insert.source.id===this.selectedOpeningId?'#80afa4':'#bca58a'));
      for(const surface of insert.surfaces)this.draw(surface.outline,rgb('#8c8679'),undefined,false,true);
    }
    const eye=this.cameraEye(),distance=(surface:WallMesh)=>{
      const center=surface.source.points.reduce((sum,p)=>({x:sum.x+p.x/surface.source.points.length,y:sum.y+p.y/surface.source.points.length,z:sum.z+p.z/surface.source.points.length}),{x:0,y:0,z:0});
      return (center.x-eye.x)**2+(center.y-eye.y)**2+(center.z-eye.z)**2;
    };
    const panes=this.insertMeshes.filter(insert=>insert.source.kind==='window').flatMap(insert=>insert.surfaces.map(surface=>({surface,id:insert.source.id}))).sort((a,b)=>distance(b.surface)-distance(a.surface));
    if(panes.length){
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
      for(const {surface,id} of panes)this.draw(surface.mesh,rgb(id===this.selectedOpeningId?'#5caa9f':'#a9c8ca'),undefined,false,false,.38);
      gl.depthMask(true);gl.disable(gl.BLEND);
      for(const {surface} of panes)this.draw(surface.outline,rgb('#7b9290'),undefined,false,true);
    }
  }
  private renderSelectionOutline(){
    const key=`${this.selectedWallId||''}|${this.selectedWallSide}|${this.selectedOpeningId||''}|${this.selectedWallIds.join(',')}`;
    if(key!==this.selectionOutlineKey){
      if(this.selectionOutline)this.gl.deleteBuffer(this.selectionOutline.buffer);
      let boundary:Vec3[];
      if(this.selectedOpeningId){
        const surfaces=this.wallMeshes.filter(surface=>surface.source.openingId===this.selectedOpeningId).map(surface=>surface.source);
        for(const insert of this.insertMeshes)if(insert.source.id===this.selectedOpeningId)surfaces.push(...insert.source.surfaces);
        boundary=creaseSegments(surfaces);
      }else boundary=this.selectedFaces(this.wallMeshes.map(mesh=>mesh.source)).boundary;
      this.selectionOutline=boundary.length?this.makeMesh(boundary.flatMap(point=>vertex(point)),this.gl.LINES):null;
      this.selectionOutlineKey=key;
    }
    if(this.selectionOutline)this.draw(this.selectionOutline,rgb('#1c7664'),undefined,false,true);
  }
  private renderOpeningGuides(){
    // Contours are interaction guides, never a filled insert over a through-hole.
    // Keep complete apertures visible above the artificial low-wall cut height.
    for(const target of this.openingTargets)if(this.cutaway||target.opening.id===this.selectedOpeningId)
      this.draw(target.outline,rgb(target.opening.id===this.selectedOpeningId?'#1c7664':'#9aada3'),undefined,false,true);
  }
  private renderLabels(){
    this.labelLayer.hidden=!this.showLabels||!this.cutaway||this.contextLost||!!this.sceneError;
    for(const label of this.roomLabels){label.node.hidden=true;label.screen=undefined;}
    if(this.labelLayer.hidden)return;
    const eye=this.cameraEye(),placed:{x:number;y:number;width:number;height:number}[]=[];
    const labels=[...this.roomLabels].sort((a,b)=>(+(b.id===this.selectedRegionId)-+(a.id===this.selectedRegionId))||b.netArea-a.netArea);
    for(const label of labels){
      const p=this.projectToScreen(label.point);if(!p.visible||p.depth< -1||p.depth>1)continue;
      const direction=normalize3(sub3(label.point,eye)),distance=Math.hypot(label.point.x-eye.x,label.point.y-eye.y,label.point.z-eye.z);
      const opaque=[...this.wallMeshes,...this.slabMeshes,...this.insertMeshes.filter(insert=>insert.source.kind==='door').flatMap(insert=>insert.surfaces),...this.furnitureMeshes.flatMap(item=>item.surfaces)];
      const occluded=opaque.some(surface=>{const hit=rayMesh(eye,direction,surface.source.points,surface.indices);return hit!==null&&hit<distance-.01;});
      const horizontalOccluded=this.floorMeshes.some(floor=>{if((floor.source.regionId??floor.source.id)===label.id)return false;const hit=this.horizontalHit(floor,eye,direction);return hit!==null&&hit<distance-.01;});
      if(occluded||horizontalOccluded)continue;
      const selected=label.id===this.selectedRegionId;
      label.node.style.borderColor=selected?'rgba(28,118,100,.65)':'rgba(85,106,94,.18)';label.node.style.color=selected?'#1c7664':'#36443d';
      label.node.style.left=p.x+'px';label.node.style.top=p.y+'px';label.node.hidden=false;
      const width=label.node.offsetWidth,height=label.node.offsetHeight,box={x:p.x-width/2,y:p.y-height/2,width,height};
      if(box.x<8||box.y<8||box.x+width>this.viewport.width-8||box.y+height>this.viewport.height-8||placed.some(other=>box.x<other.x+other.width+4&&box.x+width+4>other.x&&box.y<other.y+other.height+4&&box.y+height+4>other.y)){label.node.hidden=true;continue;}
      placed.push(box);label.screen=box;
    }
  }
  private horizontalHit(floor:FloorMesh,origin:Vec3,direction:Vec3):number|null{
    const height=(floor.source.points[0]?.y??0)+(floor.source.surfaceType==='slab-bottom'?-.002:floor.source.surfaceType==='ceiling'||floor.source.surfaceType==='civil'?0:FLOOR_Y);
    if(Math.abs(direction.y)<1e-12)return null;
    const hit=(height-origin.y)/direction.y;if(hit<0)return null;
    const point={x:origin.x+direction.x*hit,y:height,z:origin.z+direction.z*hit};
    return pointInRingXZ(point,floor.source.points)&&!floor.source.holes.some(hole=>pointInRingXZ(point,hole))?hit:null;
  }
  private hitTest(x:number,y:number){
    if(!this.hasGeometry()||this.sceneError)return;
    this.updateCamera();const ray=screenRay(x,y,this.viewport.width,this.viewport.height,this.viewProjection);
    const terrainLimit=terrainDisplaySettings(this.terrainDisplayMode).occludesPicking?(nearestTerrainRayDistance(ray.origin,ray.direction,this.terrainOccluders)??Infinity):Infinity;
    let closest=terrainLimit+1e-5,wallId:string|null=null,floorId:string|null=null,openingId:string|null=null,furnitureId:string|null=null,serviceRouteId:string|null=null,civilElementId:string|null=null,municipalElementId:string|null=null,ceilingId:string|null=null,levelId:string|null=null,wallSide:'left'|'right'|undefined;
    for(const wall of this.wallMeshes){
      const hit=rayMesh(ray.origin,ray.direction,wall.source.points,wall.indices);
      if(hit!==null&&hit<closest){closest=hit;levelId=wall.source.levelId??null;wallId=wall.source.wallId;wallSide=selectedWallSurfaceSide(wall.source);floorId=null;openingId=wall.source.openingId||null;}
    }
    for(const insert of this.insertMeshes)for(const surface of insert.surfaces){
      const hit=rayMesh(ray.origin,ray.direction,surface.source.points,surface.indices);
      if(hit!==null&&hit<closest){closest=hit;levelId=insert.source.levelId??null;openingId=insert.source.id;wallId=insert.source.wallId;wallSide=undefined;floorId=null;}
    }
    for(const furniture of this.furnitureMeshes)for(const surface of furniture.surfaces){
      const hit=rayMesh(ray.origin,ray.direction,surface.source.points,surface.indices);
      if(hit!==null&&hit<closest){closest=hit;levelId=furniture.source.levelId??null;furnitureId=furniture.source.id;wallId=null;wallSide=undefined;openingId=null;floorId=null;}
    }
    for(const slab of this.slabMeshes){
      const hit=rayMesh(ray.origin,ray.direction,slab.source.points,slab.indices);
      if(hit!==null&&hit<closest){closest=hit;levelId=slab.source.levelId??null;floorId=slab.source.regionId;wallId=null;wallSide=undefined;openingId=null;furnitureId=null;}
    }
    for(const floor of this.floorMeshes){
      const hit=this.horizontalHit(floor,ray.origin,ray.direction);
      if(hit===null||hit>=closest)continue;
      closest=hit;levelId=floor.source.levelId??null;floorId=floor.source.regionId??floor.source.id;ceilingId=floor.source.surfaceType==='ceiling'?floorId:null;wallId=null;wallSide=undefined;openingId=null;furnitureId=null;
    }
    for(const service of this.serviceMeshes)for(const surface of service.surfaces){
      const hit=rayMesh(ray.origin,ray.direction,surface.source.points,surface.indices);
      if(hit!==null&&hit<closest){closest=hit;levelId=service.source.levelId??null;serviceRouteId=service.source.id;furnitureId=null;floorId=null;ceilingId=null;wallId=null;wallSide=undefined;openingId=null;}
    }
    if(!serviceRouteId){
      let bestPixels=7;
      for(const service of this.serviceMeshes)for(const segment of service.source.segments){
        const hit=rayServiceSegment(ray.origin,ray.direction,segment);if(!hit||hit.rayDistance<=0)continue;
        const radius=service.source.diameter/2,perPixel=2*hit.rayDistance*Math.tan(Math.PI/8)/Math.max(1,this.viewport.height);
        const pixels=Math.max(0,hit.distance-radius)/perPixel;
        if(pixels>bestPixels||hit.rayDistance>terrainLimit+.003||hit.rayDistance-radius>closest+.003)continue;
        bestPixels=pixels;levelId=service.source.levelId??null;serviceRouteId=service.source.id;furnitureId=null;floorId=null;ceilingId=null;wallId=null;wallSide=undefined;openingId=null;
      }
    }
    for(const element of this.civilMeshes){
      for(const surface of element.surfaces){const hit=rayMesh(ray.origin,ray.direction,surface.source.points,surface.indices);if(hit!==null&&hit<closest){closest=hit;civilElementId=element.source.id;levelId=element.source.levelId??null;}}
      for(const cap of element.horizontal){const hit=this.horizontalHit(cap,ray.origin,ray.direction);if(hit!==null&&hit<closest){closest=hit;civilElementId=element.source.id;levelId=element.source.levelId??null;}}
    }
    for(const element of this.municipalMeshes){
      for(const surface of element.surfaces){const hit=rayMesh(ray.origin,ray.direction,surface.source.points,surface.indices);if(hit!==null&&hit<closest){closest=hit;municipalElementId=element.source.id;levelId=null;wallId=floorId=openingId=furnitureId=serviceRouteId=civilElementId=ceilingId=null;}}
      for(const cap of element.horizontal){const hit=this.horizontalHit(cap,ray.origin,ray.direction);if(hit!==null&&hit<closest){closest=hit;municipalElementId=element.source.id;levelId=null;wallId=floorId=openingId=furnitureId=serviceRouteId=civilElementId=ceilingId=null;}}
    }
    if(this.project?.workspaceMode==='municipal'&&!municipalElementId){
      let bestPixels=7;
      for(const element of this.municipalMeshes)for(const segment of element.source.segments){const hit=rayServiceSegment(ray.origin,ray.direction,segment);if(!hit||hit.rayDistance<=0)continue;const radius=element.source.diameter/2,perPixel=2*hit.rayDistance*Math.tan(Math.PI/8)/Math.max(1,this.viewport.height),pixels=Math.max(0,hit.distance-radius)/perPixel;if(pixels>bestPixels||hit.rayDistance>terrainLimit+.003||hit.rayDistance-radius>closest+.003)continue;bestPixels=pixels;municipalElementId=element.source.id;levelId=null;}
    }
    let openingSide:number|undefined;
    for(const target of this.openingTargets)for(const side of target.sides){
      const hit=rayOpeningWall(ray.origin,ray.direction,target.wall,target.elevation,side.side);
      if(!hit||hit.distance>closest+.002||!pointInRegion({x:hit.x,y:hit.y},{points:openingPolygon(target.opening),holes:[]}))continue;
      closest=hit.distance;openingId=target.opening.id;openingSide=side.side;wallId=target.opening.wallId;levelId=target.levelId??null;
      floorId=null;wallSide=undefined;furnitureId=null;serviceRouteId=null;civilElementId=null;ceilingId=null;
    }
    return {wallId,floorId,openingId,furnitureId,serviceRouteId,civilElementId,municipalElementId,ceilingId,levelId,wallSide,openingSide};
  }
  private async pick(x:number,y:number){
    const hit=this.hitTest(x,y);if(!hit)return;
    const {wallId,floorId,openingId,furnitureId,serviceRouteId,civilElementId,municipalElementId,ceilingId,levelId,wallSide}=hit;
    if(this.project?.workspaceMode==='municipal'){this.callbacks.selectMunicipalElement?.(municipalElementId);return;}
    if(this.project?.levels?.length&&levelId&&levelId!==this.project.activeLevelId&&this.callbacks.selectLevel)await this.callbacks.selectLevel(levelId);
    if(civilElementId&&this.callbacks.selectCivilElement){this.callbacks.selectServiceRoute?.(null);this.callbacks.selectOpening?.(null);this.callbacks.selectRegion(null);this.callbacks.selectWall(null);this.callbacks.selectFurniture?.(null);this.callbacks.selectCivilElement(civilElementId);return;}
    this.callbacks.selectCivilElement?.(null);
    if(serviceRouteId&&this.callbacks.selectServiceRoute){this.callbacks.selectOpening?.(null);this.callbacks.selectRegion(null);this.callbacks.selectWall(null);this.callbacks.selectFurniture?.(null);this.callbacks.selectServiceRoute(serviceRouteId);return;}
    this.callbacks.selectServiceRoute?.(null);
    if(furnitureId&&this.callbacks.selectFurniture){this.callbacks.selectOpening?.(null);this.callbacks.selectRegion(null);this.callbacks.selectWall(null);this.callbacks.selectFurniture(furnitureId);}
    else if(openingId&&this.callbacks.selectOpening){this.callbacks.selectFurniture?.(null);this.callbacks.selectOpening(openingId);}
    else if(wallId){this.callbacks.selectFurniture?.(null);this.callbacks.selectOpening?.(null);this.callbacks.selectRegion(null);this.callbacks.selectWall(wallId,wallSide);}
    else{this.callbacks.selectFurniture?.(null);this.callbacks.selectOpening?.(null);this.callbacks.selectWall(null);if(ceilingId&&this.callbacks.selectCeiling)this.callbacks.selectCeiling(ceilingId);else this.callbacks.selectRegion(floorId);}
  }
  private onPointerDown=(event:PointerEvent)=>{
    if(event.button!==0&&event.button!==2)return;event.preventDefault();
    this.canvas.focus({preventScroll:true});
    this.pointer={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,pan:event.button===2||event.shiftKey,moved:false};
    this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';
    if(event.button===0&&this.selectedOpeningId&&this.callbacks.previewOpening&&this.callbacks.commitOpening){
      const rect=this.canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,hit=this.hitTest(x,y);
      if(hit?.openingId!==this.selectedOpeningId)return;
      const target=this.openingTargets.find(target=>target.opening.id===hit.openingId&&target.levelId===(hit.levelId??undefined));if(!target)return;
      if((target.opening as WallOpening&{locked?:boolean}).locked){this.pointer.openingBlocked=true;this.pointer.pan=false;this.canvas.style.cursor='not-allowed';return;}
      this.updateCamera();const ray=screenRay(x,y,this.viewport.width,this.viewport.height,this.viewProjection),side=hit.openingSide??0,start=rayOpeningWall(ray.origin,ray.direction,target.wall,target.elevation,side);if(!start)return;
      this.pointer.pan=false;this.openingDrag={id:target.opening.id,original:structuredClone(target.opening),wall:structuredClone(target.wall),levelId:target.levelId,elevation:target.elevation,side,project:structuredClone(this.project),start:{x:start.x,y:start.y},patch:{offset:target.opening.offset,bottom:target.opening.bottom}};
      this.canvas.style.cursor='move';
    }
  };
  private onPointerMove=(event:PointerEvent)=>{
    const pointer=this.pointer;if(!pointer||pointer.id!==event.pointerId)return;
    const dx=event.clientX-pointer.lastX,dy=event.clientY-pointer.lastY;pointer.lastX=event.clientX;pointer.lastY=event.clientY;
    if(Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>4)pointer.moved=true;
    if(!pointer.moved)return;
    if(pointer.openingBlocked)return;
    if(this.openingDrag){
      const drag=this.openingDrag,rect=this.canvas.getBoundingClientRect();this.updateCamera();
      const ray=screenRay(event.clientX-rect.left,event.clientY-rect.top,this.viewport.width,this.viewport.height,this.viewProjection),current=rayOpeningWall(ray.origin,ray.direction,drag.wall,drag.elevation,drag.side);
      if(!current)return;
      try{const patch=openingPositionFromElevationDrag(drag.project,drag.original,drag.start,{x:current.x,y:current.y},{shift:event.shiftKey,snap:!event.altKey});
        if(patch.offset!==drag.patch.offset||patch.bottom!==drag.patch.bottom){drag.patch=patch;this.callbacks.previewOpening?.(drag.id,patch);}
      }catch(error){this.callbacks.status?.(error instanceof Error?error.message:'此位置无法放置门窗或孔洞。');}
      return;
    }
    if(pointer.pan){
      const scale=2*this.camera.distance*Math.tan(Math.PI/8)/Math.max(1,this.viewport.height),{yaw,pitch}=this.camera;
      const right={x:Math.cos(yaw),y:0,z:-Math.sin(yaw)},up={x:-Math.sin(pitch)*Math.sin(yaw),y:Math.cos(pitch),z:-Math.sin(pitch)*Math.cos(yaw)};
      for(const axis of ['x','y','z'] as const)this.camera.target[axis]+=(-dx*right[axis]+dy*up[axis])*scale;
    }else{this.camera.yaw-=dx*.008;this.camera.pitch=Math.min(1.48,Math.max(.16,this.camera.pitch+dy*.006));}
    this.requestRender();
  };
  private onPointerUp=(event:PointerEvent)=>{
    const pointer=this.pointer;if(!pointer||pointer.id!==event.pointerId)return;this.pointer=null;this.canvas.style.cursor='grab';
    if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
    const drag=this.openingDrag;this.openingDrag=null;
    if(drag){
      if(drag.patch.offset!==drag.original.offset||drag.patch.bottom!==drag.original.bottom){this.callbacks.previewOpening?.(drag.id,{offset:drag.original.offset,bottom:drag.original.bottom});this.callbacks.commitOpening?.(drag.id,drag.patch);}
      return;
    }
    if(pointer.openingBlocked)return;
    if(!pointer.moved&&!pointer.pan){const rect=this.canvas.getBoundingClientRect();this.pick(event.clientX-rect.left,event.clientY-rect.top);}
  };
  private onPointerCancel=()=>this.cancel();
  private canKeyboardNavigate():boolean{
    return !!(this.navigationEnabled&&this.visible&&!this.disposed&&!this.contextLost&&!this.sceneError&&this.gl&&this.hasGeometry()
      &&!this.isEditing&&!document.hidden&&document.hasFocus()&&document.activeElement===this.canvas&&!document.querySelector('dialog[open],#cost-view:not([hidden])'));
  }
  private effectiveNavigationSpeed():number{return this.navigationSpeed??automaticNavigationSpeed(this.model.bounds.size,this.camera.distance);}
  private clearNavigation(){this.navigationKeys.clear();this.navigationLastTime=null;this.updateNavigationUI();}
  private updateNavigationUI(){
    if(!this.navigation)return;
    const active=this.canKeyboardNavigate(),ready=!!(this.gl&&!this.contextLost&&!this.sceneError&&this.hasGeometry());
    this.navigation.classList.toggle('is-active',active);this.navigationToggle.disabled=!ready;
    this.navigationToggle.textContent=active?'移动中 · Esc 退出':'开始移动';
    this.navigationGuide.textContent=!ready?'先生成三维模型，再移动查看':active?'拖动旋转 · 右键平移 · Esc 释放键盘':'点击画布后移动 · Esc 释放键盘';
    this.navigationSelect.options[0].textContent=`自动 · ${Number(this.effectiveNavigationSpeed().toFixed(1))} m/s`;
    this.navigationSelect.value=this.navigationSpeed===null?'auto':String(this.navigationSpeed);
  }
  setNavigationEnabled(enabled:boolean){this.navigationEnabled=!!enabled;if(!enabled)this.clearNavigation();this.updateNavigationUI();}
  setNavigationSpeed(speed:number|null){
    if(speed!==null&&(!Number.isFinite(speed)||speed<=0||speed>1000))throw new RangeError('三维移动速度应大于 0，且不超过 1000 m/s。');
    this.navigationSpeed=speed;this.clearNavigation();
  }
  private advanceNavigation(timestamp:number){
    if(!this.navigationKeys.size){this.navigationLastTime=null;return;}
    if(!this.canKeyboardNavigate()){this.clearNavigation();return;}
    const previous=this.navigationLastTime??timestamp;this.navigationLastTime=timestamp;
    const delta=cameraNavigationTranslation(this.camera.yaw,this.navigationKeys,this.effectiveNavigationSpeed(),Math.max(0,(timestamp-previous)/1000));
    this.camera.target={x:this.camera.target.x+delta.x,y:this.camera.target.y+delta.y,z:this.camera.target.z+delta.z};
  }
  private onNavigationToggle=()=>{this.setNavigationEnabled(true);this.canvas.focus({preventScroll:true});this.updateNavigationUI();};
  private onNavigationSpeed=()=>this.setNavigationSpeed(this.navigationSelect.value==='auto'?null:Number(this.navigationSelect.value));
  private onCanvasFocus=()=>this.updateNavigationUI();
  private onCanvasBlur=()=>this.clearNavigation();
  private onWindowFocus=()=>this.updateNavigationUI();
  private onDocumentVisibility=()=>{if(document.hidden)this.clearNavigation();};
  private onKeyDown=(event:KeyboardEvent)=>{
    if(event.defaultPrevented)return;
    if(event.key==='Escape'&&this.isEditing){event.preventDefault();event.stopPropagation();this.cancel();return;}
    if(!this.canKeyboardNavigate())return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.clearNavigation();this.canvas.blur();return;}
    const code=cameraNavigationCode(event);
    // Keep Save/Undo and common browser commands available. Ctrl alone remains
    // the downward key; modifiers used for another command cannot keep moving.
    if(event.metaKey||event.altKey||event.ctrlKey&&['KeyS','KeyZ','KeyY','KeyO','KeyP','KeyF'].includes(event.code||code)){
      this.clearNavigation();return;
    }
    if(!code)return;
    event.preventDefault();event.stopPropagation();
    if(!this.navigationKeys.size)this.navigationLastTime=performance.now();
    this.navigationKeys.add(code);this.requestRender();
  };
  private onKeyUp=(event:KeyboardEvent)=>{
    const code=cameraNavigationCode(event);if(!code)return;
    this.navigationKeys.delete(code);if(!this.navigationKeys.size)this.navigationLastTime=null;
  };
  private onBlur=()=>{this.clearNavigation();if(this.isEditing)this.cancel();};
  private onWheel=(event:WheelEvent)=>{event.preventDefault();if(!this.isEditing)this.zoom(Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.002));};
  private onContextMenu=(event:Event)=>event.preventDefault();
  private onContextLost=(event:Event)=>{event.preventDefault();this.cancel();this.contextLost=true;this.generation++;this.labelLayer.hidden=true;this.updateOverlay();this.updateNavigationUI();this.updateTerrainDisplayUI();this.callbacks.error('三维画布连接中断，可以切回二维继续设计。');};
  private onContextRestored=()=>{this.initialize();if(!this.sceneError){this.rebuild();this.updateOverlay();this.updateNavigationUI();this.updateTerrainDisplayUI();this.requestRender();this.callbacks.status?.('三维画布已恢复。');}};

  projectToScreen(point:Vec3){
    this.updateCamera();const p=transform4(this.viewProjection,[point.x,point.y,point.z,1]);
    return {x:(p[0]/p[3]+1)*this.viewport.width/2,y:(1-p[1]/p[3])*this.viewport.height/2,depth:p[2]/p[3],visible:p[3]>0&&Math.abs(p[0]/p[3])<=1&&Math.abs(p[1]/p[3])<=1};
  }
  private wallSelectionStats(){
    const id=this.selectedOpeningId?null:this.selectedWallId;
    const full=this.selectedOpeningId?wallSelection([],null,this.selectedWallSide):this.selectedFaces(this.model.surfaces??[]);
    const visible=this.selectedOpeningId?wallSelection([],null,this.selectedWallSide):this.selectedFaces(this.wallMeshes.map(mesh=>mesh.source));
    return {
      selectedWallId:id,selectedWallSide:this.selectedWallSide,
      selectedWallArea:full.area,selectedWallVisibleArea:visible.area,
      selectedWallFaceCount:full.faces.length,selectedWallFaces:structuredClone(full.faces),
      selectedWallVisibleFaceCount:visible.faces.length,selectedWallVisibleFaces:structuredClone(visible.faces),
      selectedWallBounds:structuredClone(full.bounds),selectedWallVisibleBounds:structuredClone(visible.bounds),
      selectedWallSurfaceCount:visible.surfaces.length,
      selectedWallSurfaces:structuredClone(visible.surfaces.map(surface=>({id:surface.id,wallId:surface.wallId,side:surface.side,area:wallSurfaceArea(surface.points),points:surface.points,normal:surface.normal}))),
      selectedWallQuotedSurfaceIds:[...full.surfaceIds],
    };
  }
  private furnitureStats(){
    return {furnitureCount:this.furnitureData.length,renderedFurnitureCount:this.furnitureMeshes.length,selectedFurnitureId:this.selectedFurnitureId,
      furnitureAssetsReady:this.furnitureAssetsState==='ready',furnitureAssetsState:this.furnitureAssetsState,
      furniture:structuredClone(this.furnitureData.map(item=>({id:item.id,name:item.name,kind:item.kind,position:item.position,size:item.size,rotation:item.rotation,levelId:item.levelId,levelName:item.levelName,sourceLevelId:item.sourceLevelId,sourceLevelName:item.sourceLevelName,targetLevelId:item.targetLevelId,isIncoming:!!item.isIncoming,surfaceCount:item.surfaces.length,geometrySource:item.geometrySource}))),
      incomingStairCount:this.furnitureData.filter(item=>item.isIncoming).length,
      incomingStairs:structuredClone(this.furnitureData.filter(item=>item.isIncoming).map(item=>({id:item.id,sourceLevelId:item.sourceLevelId,targetLevelId:item.targetLevelId,base:item.position.y,rise:item.size.height}))),
      furnitureBatchCount:this.furnitureMeshes.reduce((sum,item)=>sum+item.batches.length,0),
      furnitureTriangles:this.furnitureMeshes.reduce((sum,item)=>sum+item.batches.reduce((n,batch)=>n+batch.mesh.count/3,0),0)};
  }
  getStats(){
    const furniture=this.furnitureStats();
    const openingRecords=this.project?.levels?.length?levelProjects(this.project).filter(level=>this.model.levels?.some(visible=>visible.id===level.id)).flatMap(level=>(level.project.openings??[]).map(opening=>({...opening,levelId:level.id,levelName:level.name}))):this.project?.openings??[];
    const horizontalInfo=(floor:SceneFloor)=>({id:floor.id,regionId:floor.regionId??floor.id,partIndex:floor.partIndex??0,partCount:floor.partCount??1,levelId:floor.levelId,levelName:floor.levelName,height:floor.points[0]?.y??0,netArea:floorLabelData(floor)?.netArea??0,points:floor.points,holes:floor.holes});
    const services={serviceRouteCount:this.serviceData.length,serviceSegmentCount:this.serviceData.reduce((sum,route)=>sum+route.segments.length,0),renderedServiceRouteCount:this.serviceMeshes.length,selectedServiceRouteId:this.selectedServiceRouteId,
      serviceRoutes:structuredClone(this.serviceData.map(route=>({id:route.id,serviceRouteId:route.id,name:route.name,kind:route.kind,presetId:route.presetId,levelId:route.levelId,levelName:route.levelName,color:route.color,diameter:route.diameter,points:route.points,segments:route.segments,surfaceCount:route.surfaces.length}))),
      serviceTriangles:this.serviceMeshes.reduce((sum,route)=>sum+route.mesh.count/3,0)};
    const civil={civilElementCount:this.model.civilElements?.length??0,renderedCivilElementCount:this.civilMeshes.length,civilSliceCount:(this.model.civilElements??[]).reduce((sum,element)=>sum+element.slices.length,0),civilPartCount:(this.model.civilElements??[]).reduce((sum,element)=>sum+element.slices.reduce((n,slice)=>n+slice.parts.length,0),0),selectedCivilElementId:this.selectedCivilElementId,
      civilElements:structuredClone((this.model.civilElements??[]).map(element=>({id:element.id,civilElementId:element.id,name:element.name,kind:element.kind,levelId:element.levelId,levelName:element.levelName,color:element.color,netVolume:element.netVolume,slices:element.slices,surfaceCount:element.surfaces.length,horizontalCount:element.horizontal.length}))),
      civilTriangles:this.civilMeshes.reduce((sum,element)=>sum+element.surfaces.reduce((n,surface)=>n+surface.mesh.count/3,0)+element.horizontal.reduce((n,cap)=>n+cap.mesh.count/3,0),0)};
    const municipal={municipalElementCount:this.municipalData.length,renderedMunicipalElementCount:this.municipalMeshes.length,selectedMunicipalElementId:this.selectedMunicipalElementId,
      municipalElements:structuredClone(this.municipalData.map(element=>({id:element.id,name:element.name,kind:element.kind,points:element.points,netArea:element.netArea,length:element.length,volume:element.volume,segments:element.segments,horizontal:element.horizontal,surfaceCount:element.surfaces.length,tunnel:element.tunnel}))),
      municipalTriangles:this.municipalMeshes.reduce((sum,element)=>sum+element.batches.reduce((n,batch)=>n+batch.mesh.count/3,0)+element.horizontal.reduce((n,cap)=>n+cap.mesh.count/3,0),0),municipalDrawBatches:this.municipalMeshes.reduce((sum,element)=>sum+element.batches.length,0)};
    const terrainDisplay=terrainDisplaySettings(this.terrainDisplayMode);
    return {...this.wallSelectionStats(),...furniture,...services,...civil,...municipal,terrainTriangleCount:this.terrainData.length,terrainDrawBatches:this.terrainMesh?1:0,terrainSurfaces:structuredClone(this.terrainData),
      terrainDisplayMode:this.terrainDisplayMode,terrainOpacity:terrainDisplay.opacity,terrainOccludesPicking:terrainDisplay.occludesPicking,terrainRenderedDrawBatches:this.terrainMesh&&terrainDisplay.drawTerrain?1:0,
      ready:!!this.gl&&!!this.program&&!this.contextLost&&!this.sceneError&&!this.contextError,visible:this.visible,cutaway:this.cutaway,error:this.contextError||this.sceneError,
      wallCount:this.model.walls.length,roomCount:new Set(this.model.floors.map(floor=>floor.regionId??floor.id)).size,floorCount:this.model.floors.length,floorPartCount:this.model.floors.length,holeCount:this.model.floors.reduce((sum,floor)=>sum+floor.holes.length,0),
      openingCount:openingRecords.length,openings:structuredClone(openingRecords),selectedOpeningId:this.selectedOpeningId,openingEditing:this.isEditing,openingGuideCount:this.openingTargets.length,openingGuides:structuredClone(this.openingTargets.map(target=>({id:target.opening.id,wallId:target.wall.id,levelId:target.levelId,elevation:target.elevation,locked:!!(target.opening as WallOpening&{locked?:boolean}).locked,sides:target.sides}))),renderedInsertCount:this.insertMeshes.length,wallSurfaceCount:this.wallMeshes.length,
      texturedWallSurfaceCount:this.wallMeshes.filter(wall=>wall.texture).length,texturedFloorCount:this.floorMeshes.filter(floor=>floor.texture&&floor.source.surfaceType!=='ceiling'&&floor.source.surfaceType!=='slab-bottom').length,
      labelsEnabled:this.showLabels,visibleLabelCount:this.roomLabels.filter(label=>label.screen&&!this.labelLayer.hidden).length,
      levels:structuredClone(this.model.levels??[]),levelCount:this.model.levels?.length??1,activeLevelId:this.project?.activeLevelId??null,levelMode:this.project?.view?.levelMode??'all',
      floors:structuredClone(this.model.floors.map(horizontalInfo)),ceilings:structuredClone((this.model.ceilings??[]).map(horizontalInfo)),ceilingCount:this.model.ceilings?.length??0,ceilingsVisible:!!this.project?.view?.ceilings,renderedCeilingCount:this.floorMeshes.filter(floor=>floor.source.surfaceType==='ceiling').length,
      slabs:structuredClone((this.model.slabs??[]).map(slab=>({id:slab.id,regionId:slab.regionId,levelId:slab.levelId,levelName:slab.levelName,top:slab.top,bottom:slab.bottom,netArea:floorLabelData(slab.floor)?.netArea??0,holeCount:slab.floor.holes.length,sideSurfaceCount:slab.surfaces.length}))),
      wallHeights:this.model.walls.map(wall=>({id:wall.id,height:wall.size.height,thickness:wall.size.thickness,displayedHeight:this.cutaway?Math.min(wall.size.height,.6):wall.size.height,levelId:wall.levelId,base:wall.start.y})),
      camera:{...this.camera,target:{...this.camera.target},eye:this.cameraEye()},navigation:{enabled:this.navigationEnabled,focused:document.activeElement===this.canvas,active:this.canKeyboardNavigate(),moving:!!this.navigationKeys.size,keys:[...this.navigationKeys],speed:this.effectiveNavigationSpeed(),speedMode:this.navigationSpeed===null?'auto':'manual'},bounds:structuredClone(this.model.bounds),viewport:{...this.viewport},
      triangles:this.wallMeshes.reduce((sum,wall)=>sum+wall.mesh.count/3,0)+this.slabMeshes.reduce((sum,slab)=>sum+slab.mesh.count/3,0)+this.insertMeshes.reduce((sum,insert)=>sum+insert.surfaces.reduce((n,surface)=>n+surface.mesh.count/3,0),0)+this.floorMeshes.reduce((sum,floor)=>sum+floor.mesh.count/3,0)+furniture.furnitureTriangles+services.serviceTriangles+civil.civilTriangles+municipal.municipalTriangles,
      glError:this.gl&&!this.contextLost?this.gl.getError():null};
  }
  async capturePNG():Promise<Blob>{
    if(!this.gl||!this.program||this.contextLost||this.sceneError||!this.hasGeometry())throw new Error('请先生成有效的三维户型，再导出图片。');
    this.render();this.gl.finish();
    const output=document.createElement('canvas');output.width=this.canvas.width;output.height=this.canvas.height;
    const context=output.getContext('2d');context.drawImage(this.canvas,0,0);
    context.scale(output.width/this.viewport.width,output.height/this.viewport.height);
    if(!this.labelLayer.hidden)for(const label of this.roomLabels){
      if(!label.screen)continue;const {x,y,width,height}=label.screen,selected=label.id===this.selectedRegionId;
      context.fillStyle='rgba(255,255,255,.93)';context.strokeStyle=selected?'rgba(28,118,100,.65)':'rgba(85,106,94,.18)';context.lineWidth=1;
      context.beginPath();context.roundRect(x,y,width,height,6);context.fill();context.stroke();
      context.textAlign='center';context.textBaseline='alphabetic';context.fillStyle=selected?'#1c7664':'#36443d';context.font='600 12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      let name=label.name;while(context.measureText(name).width>126&&name.length>1)name=name.slice(0,-1);if(name!==label.name)name=name.slice(0,-1)+'…';
      context.fillText(name,x+width/2,y+19);context.fillStyle='#738177';context.font='11px "Segoe UI", sans-serif';context.fillText(label.netArea.toFixed(2)+' m²',x+width/2,y+35);
    }
    return new Promise((resolve,reject)=>output.toBlob(blob=>blob?resolve(blob):reject(new Error('三维图片导出失败。')),'image/png'));
  }
  dispose(){
    this.cancel();window.removeEventListener('keydown',this.onKeyDown,true);window.removeEventListener('keyup',this.onKeyUp,true);window.removeEventListener('blur',this.onBlur);window.removeEventListener('focus',this.onWindowFocus);document.removeEventListener('visibilitychange',this.onDocumentVisibility);
    this.canvas.removeEventListener('focus',this.onCanvasFocus);this.canvas.removeEventListener('blur',this.onCanvasBlur);
    this.navigationToggle.removeEventListener('click',this.onNavigationToggle);this.navigationSelect.removeEventListener('change',this.onNavigationSpeed);
    this.terrainControls.removeEventListener('click',this.onTerrainDisplay);
    this.inspectionControls.removeEventListener('click',this.onSceneInspect);
    this.disposed=true;this.furnitureAssetsRequest.abort();cancelAnimationFrame(this.frame);this.observer.disconnect();this.releaseMeshes();
    for(const [event,handler] of [['pointerdown',this.onPointerDown],['pointermove',this.onPointerMove],['pointerup',this.onPointerUp],['pointercancel',this.onPointerCancel],['wheel',this.onWheel],['contextmenu',this.onContextMenu],['webglcontextlost',this.onContextLost],['webglcontextrestored',this.onContextRestored]] as const)this.canvas.removeEventListener(event,handler as EventListener);
    if(this.gl){this.gl.deleteTexture(this.whiteTexture);this.gl.deleteProgram(this.program);}this.canvas.remove();this.labelLayer.remove();this.overlay.remove();this.navigation.remove();
  }
}
