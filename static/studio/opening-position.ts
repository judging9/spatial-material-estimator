import type { Point, Project } from './types.js';
import { openingPolygon, type WallOpening } from './lib/wall-solid.js';
import { openingPositionFromElevationDrag, openingPositionValidity } from './lib/opening-interaction.js';
import { escape, measure } from './ui.js';

export type OpeningPosition = { offset: number; bottom: number };
const location = (opening: WallOpening): OpeningPosition => ({offset:opening.offset,bottom:opening.bottom});
const samePosition = (a: OpeningPosition, b: OpeningPosition) => Math.abs(a.offset-b.offset)<1e-7&&Math.abs(a.bottom-b.bottom)<1e-7;

export function openingElevationContents(project: Project, opening: WallOpening): string {
  const wall=project.walls?.find(wall=>wall.id===opening.wallId);if(!wall)return '';
  const length=Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y),height=wall.height??project.wallHeight??280;
  const path=(item:WallOpening)=>openingPolygon(item).map((point,index)=>`${index?'L':'M'} ${point.x} ${height-point.y}`).join(' ')+' Z';
  const peers=(project.openings??[]).filter(item=>item.wallId===opening.wallId&&item.id!==opening.id).map(item=>`<path d="${path(item)}" fill="#fff" stroke="#bfcac0" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  const centerX=opening.offset+opening.width/2,centerY=height-opening.bottom-opening.height/2;
  return `<rect width="${length}" height="${height}" fill="#f1f4ee" stroke="#c6d0c4" stroke-width="1" vector-effect="non-scaling-stroke"/>${peers}<path data-opening-position-hit d="${path(opening)}" fill="#dfede3" stroke="#3f7e64" stroke-width="1.5" vector-effect="non-scaling-stroke"/><path d="M${centerX-5} ${centerY}h10 M${centerX} ${centerY-5}v10" stroke="#67907c" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
}
export function renderOpeningPosition(project: Project, opening: WallOpening): string {
  const wall=project.walls?.find(wall=>wall.id===opening.wallId);if(!wall)return '';
  const length=Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y),height=wall.height??project.wallHeight??280,pad=Math.max(length,height)*.04;
  return `<div class="opening-position-diagram${opening.locked?' is-locked':''}"><div class="opening-position-heading"><span>墙体立面 · ${measure(length/100)} × ${measure(height/100)} m</span><span>${opening.locked?'已锁定':'拖动绿色开口'}</span></div><svg id="opening-position-preview" data-opening-position-svg viewBox="${-pad} ${-pad} ${length+pad*2} ${height+pad*2}" tabindex="0" role="img" aria-label="${escape(opening.name||({door:'门',window:'窗',hole:'墙面孔洞'}[opening.kind]))}位置，拖动调整">${openingElevationContents(project,opening)}</svg></div>`;
}
export function updateOpeningPosition(project: Project, opening: WallOpening): void {
  for(const key of ['offset','bottom'] as const){const input=document.querySelector<HTMLInputElement>('#opening-position-'+key);if(input&&document.activeElement!==input){input.value=String(Number(opening[key].toFixed(4)));input.classList.remove('validation-error');}}
  const svg=document.querySelector<SVGSVGElement>('#opening-position-preview');if(svg)svg.innerHTML=openingElevationContents(project,opening);
}

type Callbacks={project:()=>Project;selected:()=>WallOpening|null;preview:(id:string,patch:OpeningPosition)=>void;commit:(id:string,patch:OpeningPosition)=>void;error:(message:string)=>void;status?:(message:string)=>void};
type Drag={id:number;svg:SVGSVGElement;original:WallOpening;project:Project;start:Point;screen:Point;last:OpeningPosition;moved:boolean};
/** A measured elevation editor sharing the same collision rules as 2D/3D.
 * The SVG node survives previews, keeping pointer capture and a single commit. */
export class OpeningPositionInteraction {
  private drag: Drag|null=null;
  get isEditing():boolean{return this.drag!==null;}
  constructor(private callbacks:Callbacks){
    document.addEventListener('pointerdown',this.down);
    document.addEventListener('pointermove',this.move);
    document.addEventListener('pointerup',this.up);
    document.addEventListener('pointercancel',this.pointerCancel);
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.drag){event.preventDefault();this.cancel();}});
    window.addEventListener('blur',()=>this.cancel());
  }
  private local(svg:SVGSVGElement,event:PointerEvent,project:Project,opening:WallOpening):Point|null{
    const transform=svg.getScreenCTM(),wall=project.walls?.find(wall=>wall.id===opening.wallId);if(!transform||!wall)return null;
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse());
    return{x:point.x,y:(wall.height??project.wallHeight??280)-point.y};
  }
  private down=(event:PointerEvent)=>{
    if(event.button!==0||this.drag)return;
    const hit=(event.target as Element).closest?.('[data-opening-position-hit]'),svg=hit?.closest<SVGSVGElement>('[data-opening-position-svg]');if(!svg)return;
    const original=this.callbacks.selected();if(!original)return;
    event.preventDefault();svg.focus({preventScroll:true});
    if(original.locked){this.callbacks.status?.('已锁定，请先解锁再调整位置');return;}
    const project=structuredClone(this.callbacks.project()),start=this.local(svg,event,project,original);if(!start)return;
    this.drag={id:event.pointerId,svg,project,original:structuredClone(original),start,screen:{x:event.clientX,y:event.clientY},last:location(original),moved:false};
    svg.setPointerCapture(event.pointerId);svg.classList.add('is-dragging');
  };
  private move=(event:PointerEvent)=>{
    const drag=this.drag;if(!drag||drag.id!==event.pointerId)return;
    const current=this.callbacks.selected();if(!drag.svg.isConnected||current?.id!==drag.original.id||current.locked){this.cancel();return;}
    if(!drag.moved&&Math.hypot(event.clientX-drag.screen.x,event.clientY-drag.screen.y)<2)return;
    const point=this.local(drag.svg,event,drag.project,drag.original);if(!point)return;
    const matrix=drag.svg.getScreenCTM(),tolerance=matrix?6/Math.hypot(matrix.a,matrix.b):3;
    try{
      const patch=openingPositionFromElevationDrag(drag.project,drag.original,drag.start,point,{snap:!event.altKey,snapTolerance:tolerance,shift:event.shiftKey});
      const checked=openingPositionValidity(drag.project,{...drag.original,...patch});
      if(!checked.valid){this.callbacks.status?.(checked.error);return;}
      if(samePosition(drag.last,patch))return;
      drag.last=patch;drag.moved=true;this.callbacks.preview(drag.original.id,patch);
      this.callbacks.status?.(`沿墙 ${measure(patch.offset/100)} m · 门底 / 窗台 ${measure(patch.bottom/100)} m`);
    }catch(error){this.callbacks.status?.(error.message);}
  };
  private finish(drag:Drag):void{
    this.drag=null;drag.svg.classList.remove('is-dragging');
    if(drag.svg.hasPointerCapture(drag.id))drag.svg.releasePointerCapture(drag.id);
  }
  private up=(event:PointerEvent)=>{
    const drag=this.drag;if(!drag||drag.id!==event.pointerId)return;
    this.finish(drag);
    if(!drag.moved||samePosition(drag.last,location(drag.original)))return;
    try{this.callbacks.preview(drag.original.id,location(drag.original));this.callbacks.commit(drag.original.id,drag.last);this.callbacks.status?.('位置已更新，可撤销');}
    catch(error){this.callbacks.preview(drag.original.id,location(drag.original));this.callbacks.error(error.message);}
  };
  private pointerCancel=(event:PointerEvent)=>{if(this.drag?.id===event.pointerId)this.cancel();};
  cancel():void{const drag=this.drag;if(!drag)return;this.finish(drag);if(drag.moved)this.callbacks.preview(drag.original.id,location(drag.original));this.callbacks.status?.('已取消移动，恢复原位置');}
}
