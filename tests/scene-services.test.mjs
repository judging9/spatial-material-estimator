import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
const modules=process.env.SERVICES_SCENE_BUILD?pathToFileURL(join(resolve(process.env.SERVICES_SCENE_BUILD),'lib')+'/'):new URL('../static/studio/lib/',import.meta.url);
const [{buildSceneServices,rayServiceSegment},{createServiceRoute,serviceMetrics},{ensureLevels,addLevel,switchLevel},{calculateProject},{projectToCSV,renderExportHTML}]=await Promise.all(['scene-services.js','services.js','levels.js','pricing.js','export.js'].map(file=>import(new URL(file,modules))));

const near=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const source=()=>({version:1,id:'service-scene',name:'室内管线',drawing:{id:'plan',name:'户型图',type:'plan',width:1200,height:1000,url:'data:image/png;base64,a'},calibration:{metersPerPixel:.01},regions:[],walls:[],wallHeight:280,wallThickness:20,additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const route=(overrides={})=>({...createServiceRoute('cat6',[{x:100,y:200,z:30},{x:400,y:600,z:30},{x:400,y:600,z:130}]),id:'network-route',diameter:2,unitPrice:'2.125',runs:'3',extraLength:'.5',wasteRate:'10',laborRate:'.5',additionalCost:'7',...overrides});
const parseCSV=source=>{const rows=[];let row=[],cell='',quoted=false;for(let i=source.charCodeAt(0)===0xfeff?1:0;i<source.length;i++){const char=source[i];if(char==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell='';}else if(char==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=char;}if(cell||row.length){row.push(cell);rows.push(row);}assert.equal(quoted,false);return rows;};
const twoLevels=()=>{let project=ensureLevels({...source(),serviceRoutes:[route()]});const lowerId=project.activeLevelId;project=addLevel(project,{name:'二楼',copyLayout:false});const upperId=project.activeLevelId;project.serviceRoutes=[route({id:'upper-route',name:'二楼网线',points:[{x:100,y:100,z:270},{x:200,y:100,z:270}],runs:'1',extraLength:'0',wasteRate:'0',laborRate:'0',additionalCost:'0',unitPrice:'4'})];return{project,lowerId,upperId};};

test('service geometry uses true horizontal scale, vertical heights and centimetre diameter',()=>{
  const project={...source(),serviceRoutes:[route()]},before=structuredClone(project),model=buildSceneServices(project)[0];
  assert.equal(model.kind,'service');assert.equal(model.serviceRouteId,'network-route');assert.equal(model.segments.length,2);near(model.diameter,.02);
  assert.deepEqual(model.points,[{x:1,y:.3,z:2},{x:4,y:.3,z:6},{x:4,y:1.3,z:6}]);near(model.segments[0].length,5);near(model.segments[1].length,1);
  near(model.segments.reduce((sum,segment)=>sum+segment.length,0),serviceMetrics(project.serviceRoutes[0],project).pathLength);
  const vertical=model.surfaces.filter(surface=>surface.id.includes('segment:1:side:'));
  for(const surface of vertical)for(const point of surface.points)near(Math.hypot(point.x-4,point.z-6),.01);
  assert.ok(model.surfaces.every(surface=>surface.points.every(point=>[point.x,point.y,point.z].every(Number.isFinite))));assert.deepEqual(project,before);
});

test('price, procurement run count, wastage and camera changes do not invent service placements',()=>{
  const project={...source(),serviceRoutes:[route()]},first=buildSceneServices(project);
  project.serviceRoutes[0]={...project.serviceRoutes[0],unitPrice:'9999',runs:'50',extraLength:'100',wasteRate:'75',laborRate:'99'};project.view={...project.view,zoom:200,pan:{x:300,y:-500}};
  assert.deepEqual(buildSceneServices(project),first);assert.equal(first.length,1);
});

test('an uncalibrated raster never produces guessed pipe lengths or vertical-only 3D geometry',()=>{
  const project={...source(),drawing:{...source().drawing,type:'image'},calibration:{metersPerPixel:null},serviceRoutes:[route()]};
  assert.deepEqual(buildSceneServices(project),[]);assert.equal(serviceMetrics(project.serviceRoutes[0],project).pathLength,null);
  project.calibration.metersPerPixel=.02;const model=buildSceneServices(project)[0];near(model.points[0].x,2);near(model.points[0].y,.3);near(model.segments[0].length,10);near(model.segments[1].length,1);
});

test('all-level geometry retains storey elevations, active view filters routes and hiding retains quotation',()=>{
  const {project,lowerId,upperId}=twoLevels(),before=structuredClone(project),all=buildSceneServices(project);assert.equal(all.length,2);
  const lower=all.find(route=>route.levelId===lowerId),upper=all.find(route=>route.levelId===upperId);near(lower.points[0].y,.3);near(upper.points[0].y,project.levels.find(level=>level.id===upperId).elevation/100+2.7);assert.deepEqual(project,before);
  project.view.levelMode='active';assert.deepEqual(buildSceneServices(project).map(route=>route.id),['upper-route']);const total=calculateProject(project).total;
  project.serviceRoutes[0].hidden=true;assert.deepEqual(buildSceneServices(project),[]);assert.equal(calculateProject(project).total,total);
  const lowerProject=switchLevel(project,lowerId);assert.equal(buildSceneServices(lowerProject)[0].id,'network-route');
});

test('service picking measures finite segments and forward rays rather than infinite construction lines',()=>{
  const segment={start:{x:0,y:0,z:0},end:{x:5,y:0,z:0},length:5};
  const middle=rayServiceSegment({x:2.5,y:3,z:.05},{x:0,y:-1,z:0},segment);near(middle.rayDistance,3);near(middle.distance,.05);near(middle.point.x,2.5);
  const end=rayServiceSegment({x:10,y:3,z:0},{x:0,y:-1,z:0},segment);near(end.point.x,5);near(end.distance,5);
  const behind=rayServiceSegment({x:2,y:-3,z:0},{x:0,y:-1,z:0},segment);near(behind.rayDistance,0);near(behind.distance,3);
  const parallel=rayServiceSegment({x:0,y:.1,z:0},{x:1,y:0,z:0},segment);near(parallel.distance,.1);assert.equal(rayServiceSegment({x:0,y:0,z:0},{x:0,y:0,z:0},segment),null);
});

test('CSV keeps 25 columns and exports physical length, run count, allowance, procurement and one owner fee',()=>{
  const {project}=twoLevels(),quote=calculateProject(project),rows=parseCSV(projectToCSV(project));assert.ok(rows.every(row=>row.length===25));
  const details=rows.filter(row=>row[0]==='管线明细'),totals=rows.filter(row=>row[0]==='管线汇总');assert.equal(details.length,2);assert.equal(totals.length,2);
  const network=details.find(row=>row[2].includes('六类网线'));assert.equal(network[6],'m');near(Number(network[8]),19.5);near(Number(network[9]),21.45);assert.equal(network[10],'2.125');assert.equal(network[11],'10');assert.equal(network[12],'0.5');assert.equal(network[13],'45.58');assert.equal(network[14],'9.75');assert.equal(network[15],'0.00');assert.ok(network[24].includes('实际路径 6 m'));assert.ok(network[24].includes('并行 3 路'));assert.ok(network[24].includes('余量 0.5 m'));
  assert.equal(totals.find(row=>row[2].includes('六类网线'))[16],'7.00');assert.equal(quote.total,'66.33');assert.equal(rows.at(-1)[21],quote.total);
});

test('PDF diagrams retain actual service path and elevation legends and hidden routes are still priced',()=>{
  const {project}=twoLevels(),html=renderExportHTML(project);assert.equal((html.match(/data-quote-kind="service"/g)||[]).length,2);assert.equal((html.match(/data-service-route-id=/g)||[]).length,2);
  assert.match(html,/points="100,200 400,600 400,600"/);assert.match(html,/本层标高 0.3–1.3 m/);assert.match(html,/并行 3 路/);assert.match(html,/实际路径 6 m/);assert.match(html,/¥ 66.33/);
  project.serviceRoutes[0].hidden=true;const hidden=renderExportHTML(project);assert.equal((hidden.match(/data-service-route-id=/g)||[]).length,1);assert.equal((hidden.match(/data-quote-kind="service"/g)||[]).length,2);assert.match(hidden,/¥ 66.33/);
});

test('missing service unit price blocks a formal quote and draft exports clearly retain known costs',()=>{
  const project={...source(),serviceRoutes:[route({unitPrice:'',name:'=网线 <script>bad</script>',spec:'规格 & <svg>'})]};assert.throws(()=>projectToCSV(project),/单价/);assert.throws(()=>renderExportHTML(project),/单价/);
  const rows=parseCSV(projectToCSV(project,{allowDraft:true})),detail=rows.find(row=>row[0]==='管线明细'),quote=calculateProject(project);assert.ok(detail[2].startsWith("'="));assert.equal(detail[10],'待填写单价');assert.equal(detail[13],quote.serviceRoutes[0].pendingReason);assert.equal(detail[14],'9.75');assert.equal(rows.at(-1)[21],quote.pendingReason);
  const html=renderExportHTML(project,{allowDraft:true});assert.match(html,/报价草稿/);assert.match(html,/待填写单价/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.ok(!html.includes('<script>bad</script>'));assert.match(html,/规格 &amp; &lt;svg&gt;/);
});
