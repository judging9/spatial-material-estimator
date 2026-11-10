import test from 'node:test';
import assert from 'node:assert/strict';
import { addLevel, switchLevel } from '../static/studio/lib/levels.js';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { projectToCSV, renderExportHTML } from '../static/studio/lib/export.js';
const rectangle=(x,y,w,d)=>[{x,y},{x:x+w,y},{x:x+w,y:y+d},{x,y:y+d}];
const material=(id,price,waste='0',labor='0')=>({id,materialId:'material-'+id,materialName:id,unit:'m²',quantityMode:'area',quantity:'0',unitPrice:price,wasteRate:waste,laborRate:labor,additionalCost:'0'});
const room=(id,points,price)=>({id,name:id,points,holes:[],hidden:false,items:[material(id+'-item',price)],additionalCost:'0'});
const furniture=(id,kind,price,quantity='1',extra='0')=>({id,name:id,kind,position:{x:450,y:350},width:100,depth:60,height:80,rotation:37.5,mountHeight:10,quantity,unitPrice:price,additionalCost:extra});
const fixture=()=>{
  const source={version:1,id:'export-multi',name:'正式楼层报价',drawing:{id:'plan',name:'自绘平面',type:'plan',width:2400,height:1800,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},regions:[room('首层客厅',rectangle(200,200,600,400),'100')],walls:[],wallHeight:280,wallThickness:20,additionalCost:'20',taxRate:'9',view:{labels:true,drawingOpacity:1}};
  source.regions[0].ceiling={enabled:true,items:[],additionalCost:'50'};source.furniture=[furniture('电脑','computer','100')];
  const next=addLevel(source,{name:'二楼'});next.regions.push(room('夹层卧室',rectangle(200,200,300,200),'200'));next.regions[0].ceiling={enabled:true,items:[material('吊顶板','5','10','2')],additionalCost:'10'};next.furniture.push(furniture('床','bed','350','2','20'));
  return switchLevel(next,next.levels[0].id);
};
function parseCSV(csv){
  const rows=[];let row=[],cell='',quoted=false;const text=csv.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\r'&&text[i+1]==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';i++;}else cell+=c;}
  assert.equal(quoted,false);return rows;
}

test('CSV and printable quote include every storey, fee-only ceiling, accurate furniture and one project tax',()=>{
  const p=fixture(),quote=calculateProject(p);assert.equal(quote.total,'4954.05');assert.equal(quote.beforeTax,'4545.00');assert.equal(quote.tax,'409.05');
  const rows=parseCSV(projectToCSV(p));assert.ok(rows.every(row=>row.length===25));assert.equal(rows.filter(row=>row[0]==='楼层汇总').length,2);
  const ceilings=rows.filter(row=>row[0]==='天花板汇总');assert.equal(ceilings.length,2);assert.equal(ceilings.find(row=>row[2].startsWith('一楼 /'))[18],'50.00');assert.equal(ceilings.find(row=>row[2].startsWith('二楼 /'))[18],'55.00');
  const beds=rows.filter(row=>row[0]==='家具明细'&&row[2].startsWith('二楼 /'));assert.equal(beds.length,1);assert.equal(beds[0][8],'2');assert.equal(beds[0][15],'20.00');assert.equal(beds[0][18],'720.00');assert.match(beds[0][24],/朝向 37.5°.*离地 10 cm/);
  assert.equal(rows.at(-1)[17],'20.00');assert.equal(rows.at(-1)[20],'409.05');assert.equal(rows.at(-1)[21],quote.total);assert.equal(rows.filter(row=>row[20]!=='').length,2);
  const html=renderExportHTML(p);assert.ok(html.includes('一楼 / 首层客厅 · 天花板'));assert.ok(html.includes('二楼 / 夹层卧室 · 天花板'));assert.ok(html.includes('¥ 4954.05'));assert.ok(html.includes('¥ 50.00'));assert.ok(html.includes('二楼 · 标高 3 m'));assert.ok(html.includes('离地 10 cm'));
});

test('upper-floor slab void changes inactive-storey quantities and both export totals exactly once',()=>{
  let p=fixture();const upper=p.levels[1].id;p=switchLevel(p,upper);p.floorOpenings=[{id:'stairs-void',regionId:'夹层卧室',points:rectangle(250,250,100,50)}];p=switchLevel(p,p.levels[0].id);
  const q=calculateProject(p);assert.equal(q.regions.find(row=>row.levelId===upper).netArea,5.5);assert.equal(q.ceilings.find(row=>row.levelId===upper).netArea,5.5);assert.equal(q.total,'4840.96');
  const rows=parseCSV(projectToCSV(p)),ceiling=rows.find(row=>row[0]==='天花板材料明细');assert.equal(ceiling[3],'5.5');assert.equal(ceiling[8],'5.5');assert.equal(ceiling[9],'6.05');assert.equal(ceiling[13],'30.25');assert.equal(ceiling[14],'11.00');assert.equal(rows.at(-1)[21],'4840.96');
  assert.ok(renderExportHTML(p).includes('¥ 4840.96'));assert.equal(p.levels[1].content.regions[0].holes.length,0);
});

test('inactive furniture missing price blocks formal exports; labels and user text remain safe in draft',()=>{
  const p=fixture();p.levels[1].content.furniture[0].unitPrice='';p.levels[1].name='=二楼<script>alert(1)</script>';
  assert.throws(()=>projectToCSV(p),/家具尚未填写单价/);assert.throws(()=>renderExportHTML(p),/家具尚未填写单价/);
  const rows=parseCSV(projectToCSV(p,{allowDraft:true}));assert.ok(rows.filter(row=>row[2].includes('=二楼')).every(row=>row[2].startsWith("'=")));assert.equal(rows.at(-1)[0],'工程草稿汇总');
  const html=renderExportHTML(p,{allowDraft:true});assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(html.includes('报价草稿'));
});
