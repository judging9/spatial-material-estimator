import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const modules=process.env.MUNICIPAL_SCENE_BUILD?pathToFileURL(join(resolve(process.env.MUNICIPAL_SCENE_BUILD),'lib')+'/'):new URL('../static/studio/lib/',import.meta.url);
const [{buildSceneMunicipal},{createMunicipalElement,createMunicipalLayer,municipalMetrics},{calculateMunicipalProject}]=await Promise.all(['municipal-scene.js','municipal-design.js','municipal-pricing.js'].map(file=>import(new URL(file,modules))));
const near=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const project=()=>({version:1,id:'municipal-scene',name:'市政场地',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:120000,height:90000,url:''},calibration:{metersPerPixel:.01},regions:[],walls:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1},municipalElements:[]});
const ring=(x,y,w,d)=>[{x,y},{x:x+w,y},{x:x+w,y:y+d},{x,y:y+d}];
const element=(p,kind,points,patch={})=>({...createMunicipalElement(kind,points,p),id:kind,unitPrice:'10',...patch});
const area=points=>Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.z-q.x*p.z;},0))/2;
const capArea=cap=>area(cap.points)-cap.holes.reduce((sum,hole)=>sum+area(hole),0);
const topArea=model=>model.horizontal.filter(cap=>cap.normalY===1&&cap.id.includes(':surface:')).reduce((sum,cap)=>sum+capArea(cap),0);
const bounds=model=>{const points=[...model.horizontal.flatMap(cap=>[...cap.points,...cap.holes.flat()]),...model.surfaces.flatMap(surface=>surface.points)];return{minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};};

test('road uses real centreline width, top elevation and independent structural layer thicknesses',()=>{
  const p=project(),layer={...createMunicipalLayer('基层',20),unitPrice:'100'};
  p.municipalElements=[element(p,'road',[{x:1000,y:1000},{x:2000,y:1000}],{elevation:40,items:[layer]})];
  const before=structuredClone(p),model=buildSceneMunicipal(p)[0],metrics=municipalMetrics(p.municipalElements[0],p);
  near(model.length,10);near(model.netArea,60);near(topArea(model),60);near(model.volume,3);near(metrics.totalDepth,25);
  near(bounds(model).maxY,.4);near(bounds(model).minY,.15);
  const layerTop=model.horizontal.find(cap=>cap.normalY===1&&cap.id.includes(':layer:0:'));
  near(layerTop.points[0].y,.35);near(capArea(layerTop),60);
  assert.deepEqual(p,before);
});
test('intersecting roads render exactly the same owned net footprint as the quantity engine',()=>{
  const p=project();p.municipalElements=[element(p,'road',[{x:1000,y:2000},{x:3000,y:2000}],{id:'first'}),element(p,'road',[{x:2000,y:1000},{x:2000,y:3000}],{id:'second'})];
  const models=buildSceneMunicipal(p);near(models[0].netArea,120);near(models[1].netArea,84);near(models.reduce((sum,m)=>sum+topArea(m),0),204);
  for(const model of models)near(topArea(model),municipalMetrics(p.municipalElements.find(item=>item.id===model.id),p).netArea);
  p.municipalElements[1].elevation=100;const separate=buildSceneMunicipal(p);near(separate[1].netArea,120);near(separate.reduce((sum,m)=>sum+topArea(m),0),240);
});
test('concave paving and a real internal hole retain identical top and bottom boundaries',()=>{
  const p=project(),outer=[{x:1000,y:1000},{x:1600,y:1000},{x:1600,y:1300},{x:1300,y:1300},{x:1300,y:1600},{x:1000,y:1600}];
  p.municipalElements=[element(p,'paving',outer,{holes:[ring(1100,1100,100,100)]})];
  const model=buildSceneMunicipal(p)[0];assert.equal(model.horizontal.length,2);assert.equal(model.horizontal[0].holes.length,1);assert.equal(model.horizontal[1].holes.length,1);
  near(topArea(model),26);near(model.netArea,26);near(model.volume,1.56);near(bounds(model).minY,-.06);assert.ok(model.surfaces.length>=10);
});
test('pipe follows actual XYZ nodes, absolute elevations and real diameter rather than adding default height twice',()=>{
  const p=project();p.municipalElements=[element(p,'pipeline',[{x:1000,y:1000,z:-80},{x:1300,y:1400,z:220}])];
  const model=buildSceneMunicipal(p)[0];near(model.segments[0].length,Math.sqrt(34));near(model.length,Math.sqrt(34));near(model.points[0].y,-.8);near(model.points[1].y,2.2);near(model.diameter,.3);
  const surface=model.surfaces.find(s=>s.id.endsWith(':start'));
  for(const point of surface.points)near(Math.hypot(point.x-model.points[0].x,point.y-model.points[0].y,point.z-model.points[0].z),.15);
  near(model.volume,4.8);assert.equal(model.horizontal.length,0);
  p.municipalElements[0].points=[{x:1000,y:1000},{x:1300,y:1400}];const fallback=buildSceneMunicipal(p)[0];near(fallback.points[0].y,-.8);near(fallback.length,5);
});
test('vertical pipe renders and measures its actual rise with zero horizontal trench estimate',()=>{
  const p=project();p.municipalElements=[element(p,'pipeline',[{x:1000,y:1000,z:-80},{x:1000,y:1000,z:220}])];
  const model=buildSceneMunicipal(p)[0];near(model.length,3);near(model.volume,0);assert.ok(model.surfaces.length===18);
});
test('default manhole has its lid at grade and streetlight has true six-metre height and twenty-centimetre diameter',()=>{
  const p=project();p.municipalElements=[element(p,'manhole',[{x:1000,y:1000}]),element(p,'streetlight',[{x:2000,y:1000}])];
  const [well,light]=buildSceneMunicipal(p);near(bounds(well).minY,-1.5);near(bounds(well).maxY,0);near(capArea(well.horizontal[0]),.81);
  near(bounds(light).minY,0);near(bounds(light).maxY,6);near(light.diameter,.2);near(light.segments[0].length,6);
});
test('site meshes are not copied per building storey or item quantity, and hidden work remains priced',()=>{
  const p=project();p.municipalElements=[element(p,'streetlight',[{x:1000,y:1000}],{quantity:'3'})];p.levels=[{id:'a',name:'一层',elevation:0,regions:[],walls:[]},{id:'b',name:'二层',elevation:300,regions:[],walls:[]}];p.activeLevelId='b';p.view.levelMode='all';
  assert.equal(buildSceneMunicipal(p).length,1);const total=calculateMunicipalProject(p).total;assert.equal(total,'30.00');p.municipalElements[0].hidden=true;assert.deepEqual(buildSceneMunicipal(p),[]);assert.equal(calculateMunicipalProject(p).total,total);
});
test('raster coordinates use calibration while uncalibrated drawings never invent scene area',()=>{
  const p=project();p.municipalElements=[element(p,'paving',ring(1000,1000,400,300))];p.drawing.type='png';p.calibration.metersPerPixel=.02;
  const model=buildSceneMunicipal(p)[0];near(model.netArea,48);near(topArea(model),48);near(model.horizontal[0].points[0].x,20);
  p.calibration.metersPerPixel=null;assert.deepEqual(buildSceneMunicipal(p),[]);assert.equal(calculateMunicipalProject(p).total,null);
});
