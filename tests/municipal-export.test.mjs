import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.OPENING_QUOTE_BUILD?pathToFileURL(resolve(process.env.OPENING_QUOTE_BUILD)+'/'):new URL('../static/studio/',import.meta.url);
const {createMunicipalElement,createMunicipalLayer}=await import(new URL('lib/municipal-design.js',root));
const {calculateMunicipalProject}=await import(new URL('lib/municipal-pricing.js',root));
const {projectToCSV,renderExportHTML}=await import(new URL('lib/export.js',root));
const fixture=()=>({version:1,id:'site-export',name:'市政预算验收',workspaceMode:'municipal',drawing:{id:'drawing',type:'plan',name:'真实市政图',width:2400,height:1800,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},regions:[],municipalElements:[],additionalCost:'7.77',taxRate:'6',view:{labels:true,drawingOpacity:1}});
function project(){const p=fixture(),road=createMunicipalElement('road',[{x:200,y:500},{x:1200,y:500}],p);road.name='道路一';road.width=200;road.unitPrice='10';road.laborRate='2';road.wasteRate='5';road.additionalCost='3.33';const layer=createMunicipalLayer('基层混凝土',20);layer.unitPrice='100';layer.laborRate='10';layer.additionalCost='4.44';road.items.push(layer);p.municipalElements.push(road);return p;}
test('municipal exports select the independent municipal budget and all structural layers',()=>{
  const p=project(),q=calculateMunicipalProject(p),csv=projectToCSV(p),html=renderExportHTML(p,{includeDrawing:false});assert.equal(q.kind,'municipal');assert.equal(q.total,'747.87');assert.match(csv,/市政分项/);assert.match(csv,/市政工程汇总/);assert.match(csv,/基层混凝土/);assert.match(csv,/本分项厚度 20 cm/);assert.match(csv,/747\.87/);assert.match(html,/市政设计预算/);assert.match(html,/基层混凝土/);assert.match(html,/data-quote-kind="municipal"/);assert.match(html,/747\.87/);
});
test('CSV keeps 25 columns and separates structure, facility and project fixed fees',()=>{
  const p=project(),csv=projectToCSV(p),rows=csv.trim().split('\r\n').map(line=>line.match(/"(?:[^"]|"")*"/g));assert.ok(rows.every(row=>row.length===25));const item=rows.find(row=>row[5]==='"基层混凝土"'),element=rows.find(row=>row[0]==='"市政设施汇总"'),total=rows.at(-1);assert.equal(item[15],'"4.44"');assert.equal(element[16],'"3.33"');assert.equal(total[17],'"7.77"');assert.equal(total[19],'"6"');
});
test('physical net footprints and actual paths appear in the printable site diagram',()=>{
  const p=project(),pipe=createMunicipalElement('pipeline',[{x:400,y:700,z:-100},{x:1000,y:700,z:-130}],p);pipe.unitPrice='8';p.municipalElements.push(pipe);const html=renderExportHTML(p);assert.match(html,/实绘市政布置/);assert.match(html,new RegExp(`data-municipal-element-id="${p.municipalElements[0].id}"`));assert.match(html,new RegExp(`data-municipal-element-id="${pipe.id}"`));assert.match(html,/polyline/);assert.match(html,/实际|实绘/);
});
test('missing municipal prices prevent a formal quote and remain clear in drafts',()=>{
  const p=project();p.municipalElements[0].items[0].unitPrice='';assert.throws(()=>projectToCSV(p),/填写单价/);assert.throws(()=>renderExportHTML(p),/填写单价/);assert.match(projectToCSV(p,{allowDraft:true}),/待填写单价/);assert.match(renderExportHTML(p,{allowDraft:true}),/预算草稿/);
});
test('municipal quote text and labels escape HTML and spreadsheet formula prefixes',()=>{
  const p=project();p.municipalElements[0].name='=1+1<script>alert(1)</script>';p.municipalElements[0].items[0].name='<img src=x onerror=alert(1)>';const csv=projectToCSV(p),html=renderExportHTML(p);assert.match(csv,/'=1\+1/);assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/&lt;img/);
});
