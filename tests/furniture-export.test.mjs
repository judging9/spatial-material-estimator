import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProject } from '../static/studio/lib/pricing.js';
import { projectToCSV, renderExportHTML } from '../static/studio/lib/export.js';

const furniture=(overrides={})=>({id:'sofa',name:'双人沙发',kind:'sofa',position:{x:200,y:200},width:200,depth:100,height:85,rotation:0,quantity:'2',unitPrice:'1000.005',additionalCost:'75',...overrides});
const project=(overrides={})=>({version:1,id:'furniture-export',name:'家具报价',drawing:{id:'drawing',name:'平面图',type:'image',url:'data:image/png;base64,iVBORw0KGgo=',width:500,height:400},calibration:{metersPerPixel:.02},regions:[],furniture:[furniture()],additionalCost:'0',taxRate:'9',view:{labels:true,drawingOpacity:1},...overrides});
function parseCSV(csv) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=csv.charCodeAt(0)===0xfeff?1:0;i<csv.length;i++) {
    const char=csv[i];
    if(char==='"') {if(quoted&&csv[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(cell);cell='';}
    else if(char==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';}
    else if(char!=='\r'||quoted)cell+=char;
  }
  return rows;
}

test('家具CSV保持25列并包含件数、单价、安装运费、精确金额与总税额',()=>{
  const data=project(),quote=calculateProject(data),rows=parseCSV(projectToCSV(data));
  assert.equal(rows[0].length,25);assert.ok(rows.every(row=>row.length===25));
  const detail=rows.find(row=>row[0]==='家具明细'),summary=rows.find(row=>row[0]==='家具汇总'),total=rows.find(row=>row[0]==='工程汇总');
  assert.equal(detail[2],'双人沙发');assert.equal(detail[3],'');assert.equal(detail[4],'');
  assert.equal(detail[6],'件');assert.equal(detail[7],'按件数量');assert.equal(detail[8],'2');
  assert.equal(detail[10],'1000.005');assert.equal(detail[13],'2000.01');assert.equal(detail[15],'75.00');assert.equal(detail[18],'2075.01');
  assert.equal(summary[18],'2075.01');assert.equal(total[20],'186.75');assert.equal(total[21],'2261.76');
  assert.equal(total[21],quote.total);assert.match(detail[24],/200 × 100 × 85 cm/);
});

test('家具未填价格拒绝正式CSV与打印，草稿保留待填状态及真实件数',()=>{
  const data=project({furniture:[furniture({unitPrice:''})]});
  assert.throws(()=>projectToCSV(data),/家具.*单价/);assert.throws(()=>renderExportHTML(data),/家具.*单价/);
  const rows=parseCSV(projectToCSV(data,{allowDraft:true})),detail=rows.find(row=>row[0]==='家具明细');
  assert.equal(detail[8],'2');assert.equal(detail[10],'待填写单价');assert.equal(detail[18],calculateProject(data).furniture[0].pendingReason);
  const html=renderExportHTML(data,{allowDraft:true});assert.match(html,/待填写单价/);assert.match(html,/家具尚未填写单价/);
  assert.ok(!html.includes('NaN'));
});

test('打印家具行显示规格、按件报价及真实金额，转义名称且图示使用校准尺寸',()=>{
  const data=project({furniture:[furniture({name:'沙发 & <script>家具</script>'})]}),html=renderExportHTML(data);
  assert.match(html,/data-quote-kind="furniture"/);assert.match(html,/按件报价：2 件/);assert.match(html,/200 × 100 × 85 cm/);
  assert.match(html,/安装 \/ 运费/);assert.match(html,/2075\.01/);assert.match(html,/2261\.76/);
  assert.match(html,/沙发 &amp; &lt;script&gt;家具&lt;\/script&gt;/);assert.ok(!html.includes('<script>家具</script>'));
  assert.match(html,/data-furniture-id="sofa"/);assert.ok(html.includes('M 150 175 L 250 175 L 250 225 L 150 225 Z'));
});

test('家具隐藏只隐藏图示仍计件数费用，未校准底图不导出假尺寸脚印',()=>{
  const hidden=project({furniture:[furniture({hidden:true})]}),html=renderExportHTML(hidden);
  assert.match(html,/data-quote-kind="furniture"/);assert.match(html,/2261\.76/);assert.ok(!html.includes('data-furniture-id="sofa"'));
  const uncalibrated=project({calibration:{metersPerPixel:null}}),draft=renderExportHTML(uncalibrated);
  assert.ok(!draft.includes('data-furniture-id="sofa"'));assert.match(draft,/2261\.76/);
  const plan=project({drawing:{...project().drawing,type:'plan'},calibration:{metersPerPixel:null}});
  assert.ok(renderExportHTML(plan).includes('M 100 150 L 300 150 L 300 250 L 100 250 Z'));
});
