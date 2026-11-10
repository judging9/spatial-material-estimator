import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWallSolid, validateOpenings, openingPolygon, ELLIPSE_SEGMENTS } from '../static/studio/lib/wall-solid.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { polygonArea, polygonPerimeter, intersectionArea, pointInRegion } from '../static/studio/lib/geometry.js';
import { normalizeWalls } from '../static/studio/lib/wall-plan.js';
import { wallFootprint } from '../static/studio/lib/wall-plan.js';

const wall=(id='w',start={x:200,y:200},end={x:600,y:200},extra={})=>({id,start,end,thickness:20,height:280,...extra});
const p=(walls=[wall()],openings=[])=>({version:1,id:'solid',name:'墙体项目',walls,openings,wallHeight:280,drawing:null,calibration:{metersPerPixel:.01},regions:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const hole=(extra={})=>({id:'hole',wallId:'w',kind:'hole',shape:'rectangle',offset:100,bottom:90,width:100,height:100,depth:20,...extra});
const close=(actual,expected,epsilon=1e-8)=>assert.ok(Math.abs(actual-expected)<epsilon,`${actual} ≠ ${expected}`);
const material=(extra={})=>({id:'paint',materialId:'paint',materialName:'墙面涂料',unit:'m²',unitPrice:'100',wasteRate:'10',laborRate:'20',additionalCost:'5',quantityMode:'area',quantity:'0',color:'#8baa9c',...extra});
const rectangle=()=>[
  wall('top'),wall('right',{x:600,y:200},{x:600,y:500}),wall('bottom',{x:600,y:500},{x:200,y:500}),wall('left',{x:200,y:500},{x:200,y:200}),
];

test('孤立墙仅计真实左右裸露侧面，端面与顶底保留实体但不计饰面',()=>{
  const project=p(),before=structuredClone(project),solid=buildWallSolid(project),m=solid.metrics[0];
  assert.deepEqual(m,{id:'w',side:'both',grossArea:23.52,openingArea:0,netArea:23.52,leftArea:11.76,rightArea:11.76,endArea:1.12,revealArea:0,perimeter:28});
  assert.equal(solid.surfaces.length,6);assert.deepEqual(project,before);
  project.walls[0].finishSide='left';close(buildWallSolid(project).metrics[0].netArea,11.76);
  project.walls[0].finishSide='right';close(buildWallSolid(project).metrics[0].netArea,11.76);
});
test('闭合矩形内外墙面守恒，L/T/交叉接点去除埋藏面且顺序不影响总量',()=>{
  const source=p(rectangle()),solid=buildWallSolid(source),sum=solid.metrics.reduce((n,m)=>n+m.netArea,0);
  // outer perimeter 14.8 m + inner perimeter 13.2 m, height 2.8 m.
  // Coplanar neighbour caps belong to the continuous long side, not end faces.
  close(sum,78.4);close(solid.metrics.reduce((n,m)=>n+m.endArea,0),0);
  close(solid.metrics.find(m=>m.id==='top').netArea,22.4);
  close(solid.metrics.find(m=>m.id==='left').netArea,16.8);
  const reversed=buildWallSolid({...source,walls:[...source.walls].reverse()});
  close(reversed.metrics.reduce((n,m)=>n+m.netArea,0),sum);
  source.walls.push(wall('middle',{x:400,y:200},{x:400,y:500}));
  const t=buildWallSolid(source);assert.ok(t.metrics.reduce((n,m)=>n+m.netArea,0)<sum+24);
  source.walls.push(wall('cross',{x:200,y:350},{x:600,y:350}));
  const cross=buildWallSolid(source);assert.ok(cross.metrics.every(m=>m.netArea>=0));
  const polygons=cross.surfaces.filter(s=>s.side!=='reveal');
  for(let i=0;i<polygons.length;i++)for(let j=0;j<i;j++){
    const a=polygons[i],b=polygons[j],axis=Math.abs(a.normal.x)>0?'x':Math.abs(a.normal.z)>0?'z':'y';
    if(a.normal[axis]!==b.normal[axis]||a.points[0][axis]!==b.points[0][axis])continue;
    const to2D=p=>axis==='x'?{x:p.z,y:p.y}:axis==='z'?{x:p.x,y:p.y}:{x:p.x,y:p.z};
    close(intersectionArea({points:a.points.map(to2D),holes:[]},{points:b.points.map(to2D),holes:[]}),0);
  }
});
test('同一房间每面墙的计量及报价由物理几何决定，不随随机UUID或输入顺序改变',()=>{
  const fixture=rectangle().map((wall,index)=>({...wall,name:['北墙','东墙','南墙','西墙'][index],items:[material({unitPrice:String([100,80,50,60][index])})]}));
  const original=p(fixture);
  const reference=calculateProject(original);
  const fields=['grossArea','openingArea','netArea','leftArea','rightArea','endArea','revealArea','perimeter','materialCost','laborCost','total'];
  for(const ids of [['z-uuid','a-uuid','m-uuid','b-uuid'],['a-uuid','z-uuid','b-uuid','m-uuid'],['0003','0002','0001','0000']]){
    const renamed=p(fixture.map((wall,index)=>({...wall,id:ids[index]})).reverse());
    const quote=calculateProject(renamed);
    assert.equal(quote.total,reference.total);
    for(const wall of reference.walls){
      const actual=quote.walls.find(candidate=>candidate.name===wall.name);
      for(const field of fields)assert.equal(actual[field],wall[field],`${wall.name} ${field} 不应取决于UUID`);
    }
  }
  // The regression also covers single-sided finishes and walls at T/cross joints.
  for(const side of ['left','right']){
    const base=p([...fixture.map(wall=>({...wall,finishSide:side})),wall('partition',{x:400,y:200},{x:400,y:500},{name:'分隔墙',items:[material()]})]);
    const alternate=p(base.walls.map((wall,index)=>({...wall,id:String(base.walls.length-index)})).reverse());
    const a=calculateProject(base),b=calculateProject(alternate);assert.equal(a.total,b.total);
    for(const measured of a.walls){const actual=b.walls.find(wall=>wall.name===measured.name);for(const field of fields)assert.equal(actual[field],measured[field]);}
  }
  const overlapping=p([wall('a',undefined,undefined,{height:200,name:'矮墙'}),wall('z',undefined,undefined,{height:300,name:'高墙'})]);
  const swapped=p(overlapping.walls.map(wall=>({...wall,id:wall.id==='a'?'z':'a'})));
  for(const height of [undefined,.6]){
    const a=buildWallSolid(overlapping,height),b=buildWallSolid(swapped,height);
    for(let index=0;index<a.metrics.length;index++){const {id,...measurement}=a.metrics[index],{id:otherId,...other}=b.metrics[index];assert.deepEqual(other,measurement);}
  }
});
test('重合及部分重合墙段形成唯一表面，重合材料不会重复收费',()=>{
  const source=p([wall('a'),wall('b')]);source.walls.forEach(w=>w.items=[material()]);
  let solid=buildWallSolid(source);close(solid.metrics.reduce((sum,m)=>sum+m.netArea,0),23.52);
  assert.equal(solid.metrics.find(m=>m.id==='b').netArea,0);
  source.walls[1]=wall('b',{x:400,y:200},{x:800,y:200},{items:[material()]});
  solid=buildWallSolid(source);close(solid.metrics.reduce((sum,m)=>sum+m.netArea,0),34.72);
  const sameId=p([wall('a'),wall('a')]);sameId.walls.forEach(w=>w.items=[material({wasteRate:'0',laborRate:'0',additionalCost:'0'})]);
  assert.equal(calculateProject(sameId).total,'2352.00');
});
test('矩形门窗和多边形孔洞扣真实面积，门底不产生虚构地面内壁',()=>{
  const source=p([wall()],[hole({kind:'door',bottom:0,height:210,depth:4})]);
  let solid=buildWallSolid(source),m=solid.metrics[0];
  close(m.openingArea,4.2);close(m.revealArea,1.04);close(m.netArea,19.32);
  assert.equal(solid.inserts.length,1);assert.equal(solid.inserts[0].depth,.04);
  source.openings=[hole({kind:'window',depth:8})];solid=buildWallSolid(source);m=solid.metrics[0];
  close(m.openingArea,2);close(m.revealArea,.8);close(m.netArea,21.52);
  source.openings=[hole({shape:'polygon',points:[{x:0,y:0},{x:100,y:0},{x:100,y:40},{x:40,y:40},{x:40,y:100},{x:0,y:100}]})];
  solid=buildWallSolid(source);m=solid.metrics[0];close(m.openingArea,1.28);close(m.revealArea,.8);
  assert.equal(solid.inserts.length,0);
  source.walls[0].finishSide='left';close(buildWallSolid(source).metrics[0].netArea,11.12);
});
test('椭圆采用同一个128边轮廓渲染与计价，不使用外包矩形面积',()=>{
  const opening=hole({shape:'ellipse'}),ring=openingPolygon(opening),solid=buildWallSolid(p([wall()],[opening])),m=solid.metrics[0];
  assert.equal(ring.length,ELLIPSE_SEGMENTS);assert.equal(ELLIPSE_SEGMENTS,128);
  close(m.openingArea,2*polygonArea(ring)/10000);
  close(m.revealArea,polygonPerimeter(ring)*20/10000);
  assert.ok(m.openingArea<1.6&&m.openingArea>1.57);
  assert.ok(solid.surfaces.filter(s=>s.side==='reveal').length===128);
});
test('真实低墙剖切保留门洞及孔洞弦长且不改变正式计价面积',()=>{
  const source=p([wall()],[hole({shape:'ellipse',bottom:30,height:100})]),before=buildWallSolid(source),cut=buildWallSolid(source,.6);
  assert.ok(cut.surfaces.every(s=>s.points.every(p=>p.y<=.6+1e-9)));
  assert.ok(cut.metrics[0].openingArea>0);
  assert.deepEqual(buildWallSolid(source).metrics,before.metrics);
  source.openings=[hole({kind:'door',bottom:0,height:210})];
  const door=buildWallSolid(source,.6);close(door.metrics[0].openingArea,1.2);
  assert.ok(door.inserts[0].surfaces.every(s=>s.points.every(p=>p.y<=.6+1e-9)));
});
test('开孔无效或墙尺寸改变导致孔越界时拒绝，墙交接位置不能伪造通孔',()=>{
  const invalid=[hole({width:-1}),hole({height:Infinity}),hole({depth:0}),hole({offset:350}),hole({bottom:270}),hole({kind:'door',bottom:181}),hole({shape:'polygon',points:[{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}]})];
  for(const opening of invalid)assert.throws(()=>validateOpenings(p([wall()],[opening])));
  assert.throws(()=>validateOpenings(p([wall()],[hole(),hole({id:'other',offset:120})])),/重叠/);
  assert.throws(()=>validateOpenings(p([wall()],[hole(),hole({id:'other',offset:200})])),/相接/);
  assert.throws(()=>validateOpenings(p([wall()],[hole({wallId:'missing'})])),/不存在/);
  assert.throws(()=>validateOpenings(p([wall('w'),wall('t',{x:350,y:200},{x:350,y:500})],[hole()])),/交接/);
  const source=p([wall()],[hole()]);source.walls[0].height=150;assert.throws(()=>validateOpenings(source),/超出/);
});
test('垂直和反向墙的开孔位置以宿主起点计量，门窗厚度沿实际墙法线',()=>{
  for(const endPoints of [[{x:300,y:200},{x:300,y:600}],[{x:300,y:600},{x:300,y:200}]]){
    const source=p([wall('w',...endPoints)],[hole({kind:'door',depth:4,bottom:0,height:210})]),solid=buildWallSolid(source);
    close(solid.metrics[0].netArea,19.32);
    const front=solid.inserts[0].surfaces.find(s=>s.id.includes('front'));
    assert.ok(front.points.every(p=>Math.abs(p.x-2.98)<1e-9));
    const zs=front.points.map(p=>p.z),expected=endPoints[0].y===200?[3,4]:[4,5];close(Math.min(...zs),expected[0]);close(Math.max(...zs),expected[1]);
  }
});
test('不同墙高和厚度的交叠体只留下并集边界，面积归属不重复',()=>{
  const source=p([wall('short',{x:200,y:200},{x:600,y:200},{height:200}),wall('tall',{x:200,y:200},{x:600,y:200},{height:300,thickness:40})]);
  // The smaller prism is completely inside the larger one.
  const solid=buildWallSolid(source);close(solid.metrics.find(m=>m.id==='short').netArea,0);close(solid.metrics.find(m=>m.id==='tall').netArea,26.4);
  assert.ok(solid.surfaces.filter(s=>s.wallId==='short'&&s.side!=='bottom').length===0);
  assert.deepEqual(buildWallSolid({...source,walls:[...source.walls].reverse()}).surfaces,solid.surfaces);
  const sameFootprint=p([wall('a',undefined,undefined,{height:200}),wall('b',undefined,undefined,{height:300})],[hole({kind:'window',wallId:'a',bottom:100,height:100})]);
  const aperture=buildWallSolid(sameFootprint);close(aperture.metrics.reduce((sum,m)=>sum+m.revealArea,0),.8);
  close(aperture.metrics.reduce((sum,m)=>sum+m.netArea,0),23.2);
});
test('凹形开孔在低墙高度截成多个片区，不使用跨越空隙的伪多边形',()=>{
  const opening=hole({kind:'window',shape:'polygon',bottom:0,width:100,height:100,points:[{x:0,y:0},{x:30,y:0},{x:30,y:70},{x:70,y:70},{x:70,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],depth:8});
  const source=p([wall()],[opening]),solid=buildWallSolid(source,.6);
  close(solid.metrics[0].openingArea,.72);
  const upperCaps=solid.inserts[0].surfaces.filter(s=>s.normal.y===1&&s.points.every(p=>Math.abs(p.y-.6)<1e-9));
  assert.equal(upperCaps.length,2);
  for(const surface of solid.inserts[0].surfaces){
    const first=surface.points[0];assert.ok(surface.points.every(p=>p.y<=.6+1e-9));
    assert.ok(surface.points.length>=3);
    if(Math.abs(surface.normal.z)>0)assert.ok(surface.points.every(p=>p.x<=3.3+1e-9)||surface.points.every(p=>p.x>=3.7-1e-9));
  }
});
test('墙面材料、人工、损耗、固定费和税与地面报价按分精确合并',()=>{
  const source=p();source.walls[0].items=[material()];source.walls[0].additionalCost='7';source.additionalCost='3';source.taxRate='6';
  let quote=calculateProject(source);assert.equal(quote.walls[0].netArea,23.52);assert.equal(quote.walls[0].items[0].purchaseQuantity,'25.872');
  assert.equal(quote.materialCost,'2587.20');assert.equal(quote.laborCost,'470.40');assert.equal(quote.subtotal,'3072.60');assert.equal(quote.tax,'184.36');assert.equal(quote.total,'3256.96');
  source.openings=[hole({kind:'window',depth:8})];quote=calculateProject(source);assert.equal(quote.walls[0].netArea,21.52);assert.equal(quote.materialCost,'2367.20');
  source.walls[0].items=[];assert.equal(calculateProject(source).pending,false);
  const normalized=normalizeWalls([wall('w',undefined,undefined,{items:[material()],name:'客厅北墙',finishSide:'left'})])[0];
  assert.equal(normalized.name,'客厅北墙');assert.equal(normalized.items[0].materialName,'墙面涂料');assert.equal(normalized.finishSide,'left');
});

const rotatePlan=(source,angle)=>{
  const c=Math.cos(angle),s=Math.sin(angle),rotate=point=>({x:point.x*c-point.y*s,y:point.x*s+point.y*c});
  return {...structuredClone(source),walls:source.walls.map(wall=>({...structuredClone(wall),start:rotate(wall.start),end:rotate(wall.end)}))};
};
const area3=points=>{
  const a=points[0];let area=0;
  for(let i=1;i<points.length-1;i++){const b=points[i],c=points[i+1],ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,vx=c.x-a.x,vy=c.y-a.y,vz=c.z-a.z;area+=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)/2;}
  return area;
};

test('任意角度孤立墙是旋转方帽棱柱，侧面面积/周长与真实米制法向准确',()=>{
  const source=p([wall('diagonal',{x:200,y:200},{x:440,y:520})]),solid=buildWallSolid(source),m=solid.metrics[0];
  close(m.grossArea,23.52);close(m.leftArea,11.76);close(m.rightArea,11.76);close(m.endArea,1.12);close(m.perimeter,28);
  assert.equal(solid.surfaces.length,6);
  const left=solid.surfaces.find(surface=>surface.side==='left');close(left.normal.x,-.8);close(left.normal.z,.6);
  for(const surface of solid.surfaces){
    close(Math.hypot(surface.normal.x,surface.normal.y,surface.normal.z),1);
    const origin=surface.points[0];for(const point of surface.points)close((point.x-origin.x)*surface.normal.x+(point.y-origin.y)*surface.normal.y+(point.z-origin.z)*surface.normal.z,0);
  }
  const top=solid.surfaces.find(surface=>surface.side==='top');close(area3(top.points),.84);
  const dx=Math.max(...top.points.map(point=>point.x))-Math.min(...top.points.map(point=>point.x)),dz=Math.max(...top.points.map(point=>point.z))-Math.min(...top.points.map(point=>point.z));
  assert.ok(dx*dz>area3(top.points)*5,'不能把斜墙外包矩形冒充实体');
});

test('整间旋转户型保持真实内外裸露面积及墙占地，正交算法不是面积替代品',()=>{
  const source=p(rectangle()),original=buildWallSolid(source);
  for(const angle of [.23,.73,1.37]){
    const value=rotatePlan(source,angle),solid=buildWallSolid(value);
    close(solid.metrics.reduce((sum,m)=>sum+m.netArea,0),78.4);
    close(solid.metrics.reduce((sum,m)=>sum+m.netArea+m.endArea,0),78.4);
    close(solid.surfaces.filter(surface=>surface.side==='top').reduce((sum,surface)=>sum+area3(surface.points),0),2.8);
    close(solid.metrics.reduce((sum,m)=>sum+m.openingArea,0),0);
    const before=structuredClone(value);assert.deepEqual(buildWallSolid(value),solid);assert.deepEqual(value,before);
  }
  close(original.metrics.reduce((sum,m)=>sum+m.netArea,0),78.4);
});

test('斜墙矩形/椭圆/凹形孔洞按局部真实轮廓贯通，插入厚度沿墙法线',()=>{
  const base=p([wall()]);
  for(const opening of [hole({kind:'door',bottom:0,height:210,depth:4}),hole({shape:'ellipse'}),hole({shape:'polygon',points:[{x:0,y:0},{x:100,y:0},{x:100,y:40},{x:40,y:40},{x:40,y:100},{x:0,y:100}]})]){
    const source={...base,openings:[opening]},expected=buildWallSolid(source).metrics[0],rotated=rotatePlan(source,.71),solid=buildWallSolid(rotated),actual=solid.metrics[0];
    for(const field of ['grossArea','openingArea','netArea','leftArea','rightArea','endArea','revealArea','perimeter'])close(actual[field],expected[field]);
    const w=rotated.walls[0],length=Math.hypot(w.end.x-w.start.x,w.end.y-w.start.y),u={x:(w.end.x-w.start.x)/length,z:(w.end.y-w.start.y)/length},n={x:-u.z,z:u.x};
    const coords=point=>({x:(point.x-w.start.x/100)*u.x*100+(point.z-w.start.y/100)*u.z*100,y:point.y*100});
    for(const surface of solid.surfaces.filter(surface=>surface.side==='left'||surface.side==='right')){
      const mid=surface.points.reduce((a,b)=>({x:a.x+b.x/surface.points.length,y:a.y+b.y/surface.points.length,z:a.z+b.z/surface.points.length}),{x:0,y:0,z:0});
      assert.equal(pointInRegion(coords(mid),{points:openingPolygon(opening),holes:[]}),false,'斜墙洞口内部不应产生填充侧面');
    }
    for(const insert of solid.inserts){const transverse=insert.surfaces.flatMap(surface=>surface.points).map(point=>(point.x-w.start.x/100)*n.x+(point.z-w.start.y/100)*n.z);close(Math.max(...transverse)-Math.min(...transverse),opening.depth/100);}
  }
});

test('斜墙低墙剖切真实孔洞弦，凹形窗的两片盖不跨中间空洞',()=>{
  const opening=hole({kind:'window',shape:'polygon',bottom:0,points:[{x:0,y:0},{x:30,y:0},{x:30,y:70},{x:70,y:70},{x:70,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],depth:8});
  const source=rotatePlan(p([wall()],[opening]),.64),solid=buildWallSolid(source,.6);
  assert.ok(solid.surfaces.every(surface=>surface.points.every(point=>point.y<=.6+1e-9)));close(solid.metrics[0].openingArea,.72);
  const caps=solid.inserts[0].surfaces.filter(surface=>surface.normal.y===1&&surface.points.every(point=>Math.abs(point.y-.6)<1e-9));
  assert.equal(caps.length,2);close(caps.reduce((sum,surface)=>sum+area3(surface.points),0),.048);
});

test('任意角度真实斜交墙去埋藏面，顶面等于二维多边形并集而非AABB并集',()=>{
  const source=p([wall('horizontal',{x:200,y:200},{x:600,y:200}),wall('angled',{x:400,y:200},{x:650,y:550})]);
  const footprints=source.walls.map(wallFootprint),expectedArea=(polygonArea(footprints[0].points)+polygonArea(footprints[1].points)-intersectionArea(footprints[0],footprints[1]))/10000;
  const solid=buildWallSolid(source),topArea=solid.surfaces.filter(surface=>surface.side==='top').reduce((sum,surface)=>sum+area3(surface.points),0);close(topArea,expectedArea);
  const reversed=buildWallSolid({...source,walls:[...source.walls].reverse()});assert.deepEqual(reversed.surfaces,solid.surfaces);
  for(const surface of solid.surfaces){
    const midpoint=surface.points.reduce((sum,point)=>({x:sum.x+point.x/surface.points.length,y:sum.y+point.y/surface.points.length,z:sum.z+point.z/surface.points.length}),{x:0,y:0,z:0});
    if(midpoint.y<.0001||midpoint.y>2.8-.0001)continue;
    const outside={x:(midpoint.x+surface.normal.x*.000001)*100,y:(midpoint.z+surface.normal.z*.000001)*100};
    assert.equal(footprints.some(footprint=>pointInRegion(outside,footprint)),false,'埋藏面应从union实体中剔除');
  }
});

test('斜墙部分共线重复墙形成唯一实体，反向left/right依真实箭头互换',()=>{
  const source=rotatePlan(p([wall('a'),wall('b',{x:400,y:200},{x:800,y:200})]),.58),solid=buildWallSolid(source);
  close(solid.metrics.reduce((sum,m)=>sum+m.netArea,0),34.72);
  const withT=rotatePlan(p([wall('host'),wall('branch',{x:400,y:200},{x:400,y:500})]),.58),forward=buildWallSolid(withT).metrics.find(m=>m.id==='host');
  const host=withT.walls[0];withT.walls[0]={...host,start:host.end,end:host.start};
  const backward=buildWallSolid(withT).metrics.find(m=>m.id==='host');close(backward.leftArea,forward.rightArea);close(backward.rightArea,forward.leftArea);close(backward.netArea,forward.netArea);
  withT.walls[0].finishSide='left';close(buildWallSolid(withT).metrics.find(m=>m.id==='host').netArea,backward.leftArea);
});

test('开孔校验用真实斜墙占地，AABB相交的远墙不误拒绝，实际交接处拒绝',()=>{
  const source=p([wall('host',{x:200,y:200},{x:600,y:600}),wall('remote',{x:400,y:200},{x:600,y:200})],[hole({wallId:'host',offset:250})]);
  assert.equal(validateOpenings(source).length,1);assert.equal(buildWallSolid(source).openings.length,1);
  source.walls[1]=wall('remote',{x:450,y:450},{x:600,y:200});assert.throws(()=>validateOpenings(source),/交接|重叠/);
});
