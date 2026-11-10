import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// New geometry and price fixtures are made solely with the real application
// controls. planStudio hooks only read state or convert actual coordinates.
const testRoot=await mkdtemp(join(tmpdir(),'studio-loft-'));
const artifacts=resolve('artifacts/loft');await mkdir(artifacts,{recursive:true});
const python=process.env.PYTHON||(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python');
const server=spawn(python,['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:testRoot,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let serverErrors='',browser,page;
server.stderr.on('data',chunk=>serverErrors+=chunk);
const reports=[],runtimeErrors=[];
const pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const near=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(Number(actual)-expected)<tolerance,`${actual} != ${expected} ± ${tolerance}`);
const bbox=points=>({minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))});
const parseCSV=source=>{const rows=[];let row=[],cell='',quoted=false;for(let i=source.charCodeAt(0)===0xfeff?1:0;i<source.length;i++){const char=source[i];if(char==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell='';}else if(char==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=char;}if(cell||row.length){row.push(cell);rows.push(row);}assert.equal(quoted,false);return rows;};

try{
  const baseURL=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error(serverErrors||'Test server timeout')),20000);server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});server.on('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${serverErrors}`));});});
  const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error=>runtimeErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const project=()=>page.evaluate(()=>window.planStudio.getProject());
  const quote=()=>page.evaluate(()=>window.planStudio.getQuote());
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const screen=async point=>{const location=await page.evaluate(point=>window.planStudio.toScreen(point),point),box=await page.locator('#drawing-canvas').boundingBox();assert.ok(box);return{x:box.x+location.x,y:box.y+location.y};};
  const click=async point=>{const position=await screen(point);await page.mouse.click(position.x,position.y);};
  const drag=async(from,to)=>{const a=await screen(from),b=await screen(to);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();await frame();};
  const selectRegion=async id=>page.locator(`[data-action="select-region"][data-id="${id}"]`).click();
  const selectFurniture=async id=>page.locator(`[data-action="select-furniture"][data-id="${id}"]`).click();
  const enterDecoration=async()=>{if(await page.evaluate(()=>window.planStudio.getWorkspaceMode())!=='decoration')await page.locator('#enter-decoration').click();await page.waitForFunction(()=>window.planStudio.getWorkspaceMode()==='decoration');};
  const returnPlan=async()=>{if(await page.evaluate(()=>window.planStudio.getWorkspaceMode())!=='plan')await page.locator('#return-plan').click();await page.waitForFunction(()=>window.planStudio.getWorkspaceMode()==='plan');};
  const templateRoom=async(name,width,depth)=>{await page.locator('#plan-controls [data-action="room-template"]').click();for(const[selector,value]of[['#room-name',name],['#room-width',String(width)],['#room-depth',String(depth)],['#room-height','2.8'],['#room-thickness','20']])await page.locator(selector).fill(value);await page.locator('#room-template-form [type="submit"]').click();await page.waitForFunction(()=>window.planStudio.getProject().regions.length===1);};
  const material=async(kind,values)=>{await page.locator('#inspector [data-action="add-item"]').click();await page.locator(`[data-pick-material="${kind}"]`).click();for(const[field,value]of Object.entries(values))await page.locator(`[data-item-field="${field}"]`).fill(String(value));await frame();};
  const switchLevel=async id=>{await page.locator('#active-level-select').selectOption(id);await page.waitForFunction(id=>window.planStudio.getProject().activeLevelId===id,id);await frame();};
  const captureInspector=async(name,selector)=>{for(const width of[1440,1100]){await page.setViewportSize({width,height:1000});await page.locator(selector).scrollIntoViewIfNeeded();await frame();await page.screenshot({path:join(artifacts,`${name}-${width}.png`)});}await page.setViewportSize({width:1440,height:1000});await frame();};
  const place=async(kind,point,price,extra='0')=>{const previous=(await project()).furniture?.length??0;await page.locator('#furniture-search').fill('');await page.locator('[data-decoration-category="all"]').click();await page.locator(`[data-place-furniture="${kind}"]`).click();await page.locator('#decoration-placement').waitFor({state:'visible'});await click(point);await page.waitForFunction(count=>(window.planStudio.getProject().furniture?.length??0)>count,previous);const values=(await project()).furniture,id=values.at(-1).id;await page.locator('#furniture-unitPrice').fill(String(price));await page.locator('#furniture-additionalCost').fill(extra);return id;};
  const rotateDrag=async(targetAngle,cancel=false)=>{const selected=await page.evaluate(()=>window.planStudio.getSelection().furnitureId),item=(await project()).furniture.find(item=>item.id===selected),center=await screen(item.position);const relative=await page.evaluate(()=>window.planStudio.getFurnitureRotationHandle());assert.ok(relative);const box=await page.locator('#drawing-canvas').boundingBox(),handle={x:box.x+relative.x,y:box.y+relative.y},radius=Math.hypot(handle.x-center.x,handle.y-center.y),start=Math.atan2(handle.y-center.y,handle.x-center.x),angle=start+(targetAngle-item.rotation)*Math.PI/180;await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(center.x+radius*Math.cos(angle),center.y+radius*Math.sin(angle),{steps:8});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();await frame();};

  await page.goto(baseURL);await page.waitForFunction(()=>window.planStudio?.getLevels&&window.planStudio?.getFurnitureRotationHandle);
  await page.locator('#draw-plan').click();await page.waitForFunction(()=>window.planStudio.getProject().drawing?.type==='plan');
  await page.locator('#project-name').fill('Loft 工程验收');await templateRoom('一楼客厅',6,4);
  let source=await project();const lowerRoom=source.regions[0],lowerBox=bbox(lowerRoom.points);
  near((await quote()).regions[0].netArea,24);assert.equal(source.levels,undefined);
  await selectRegion(lowerRoom.id);await material('demo-wood',{unitPrice:100,wasteRate:10,laborRate:20,additionalCost:0});
  assert.equal((await quote()).total,'3120.00');
  pass('旧单层绘图保持6×4m净面积24m²，损耗材料2640元、人工480元与原报价一致');

  await enterDecoration();assert.equal(Number(await page.locator('#furniture-catalog-count').textContent()),93);
  for(const[query,kind,category]of[['电视','tv','living'],['PC','computer','office'],['洗碗机','dishwasher','kitchen'],['灶台','cooktop','kitchen'],['洗衣机','washingMachine','appliances']]){await page.locator('[data-decoration-category="all"]').click();await page.locator('#furniture-search').fill(query);assert.ok(await page.locator(`[data-place-furniture="${kind}"]`).isVisible());await page.locator(`[data-decoration-category="${category}"]`).click();assert.ok(await page.locator(`[data-place-furniture="${kind}"]`).isVisible());}
  await page.locator('#furniture-search').fill('不存在的家具');assert.equal(await page.locator('#furniture-presets [data-place-furniture]').count(),0);await page.locator('#furniture-search').fill('');
  pass('93种预设可按电视、电脑别名、洗碗机、灶台、洗衣机搜索并分类，零匹配提示真实');
  const locations=[{x:lowerBox.minX+110,y:lowerBox.minY+95},{x:lowerBox.minX+310,y:lowerBox.minY+95},{x:lowerBox.minX+490,y:lowerBox.minY+95},{x:lowerBox.minX+120,y:lowerBox.minY+270},{x:lowerBox.minX+490,y:lowerBox.minY+280}];
  const configurations=[['tv',800],['computer',1200],['dishwasher',2300],['cooktop',900],['washingMachine',2200]],furnitureIds=[];
  for(let i=0;i<configurations.length;i++)furnitureIds.push(await place(configurations[i][0],locations[i],configurations[i][1]));
  assert.equal((await quote()).knownFurnitureCost,'7400.00');assert.equal((await quote()).total,'10520.00');
  pass('电视、电脑与厨电通过实际点击摆放，自填价格合计7400元，不改变24m²地面');
  await selectFurniture(furnitureIds[0]);await page.locator('#furniture-rotation').fill('37.27');await page.locator('[data-tool="select"]').click();
  near((await project()).furniture.find(item=>item.id===furnitureIds[0]).rotation,37.27);const beforeRotation=await quote();
  await rotateDrag(57.13);near((await project()).furniture.find(item=>item.id===furnitureIds[0]).rotation,57.13,.15);
  assert.equal((await quote()).total,beforeRotation.total);await page.locator('#undo').click();near((await project()).furniture.find(item=>item.id===furnitureIds[0]).rotation,37.27);await page.locator('#redo').click();
  const beforeCancel=await project();await rotateDrag(103.71,true);assert.deepEqual((await project()).furniture,beforeCancel.furniture);
  pass('家具角度输入37.27°与拖动手柄自由旋转有效，单次撤销/重做与Esc恢复原几何且金额不变');
  await selectFurniture(furnitureIds[1]);await page.locator('#furniture-mountHeight').fill('80');
  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);await frame();
  let stats=await page.evaluate(()=>window.planStudio.get3DStats());near(stats.furniture.find(item=>item.id===furnitureIds[1]).position.y,.8);assert.equal(stats.glError,0);
  await page.locator('[data-view="2d"]').click();
  pass('电脑离地80cm反映到实际三维模型，家具仍按自填件数报价');

  const lowerFurnitureBeforeLevels=(await project()).furniture;
  await page.locator('[data-action="manage-levels"]').click();
  for(const form of['#level-edit-form','#level-add-form']){const height=page.locator(`${form} [name="height"]`);assert.equal(await height.getAttribute('min'),'.5');assert.equal(await height.getAttribute('max'),'10');}
  await page.locator('#level-add-form [name="name"]').fill('二楼夹层');await page.locator('#level-add-form [name="height"]').fill('3');await page.locator('#level-add-form [name="copyLayout"]').selectOption('false');await page.locator('#level-add-form [type="submit"]').click();
  await page.waitForFunction(()=>window.planStudio.getProject().levels?.length===2);
  source=await project();const lowerLevel=source.levels[0],upperLevel=source.levels[1];assert.equal(source.activeLevelId,upperLevel.id);assert.equal(source.regions.length,0);assert.equal(source.furniture.length,0);near(upperLevel.elevation,300);
  await templateRoom('二楼卧室',6,2);source=await project();const upperRoom=source.regions[0],upperBox=bbox(upperRoom.points);
  assert.ok(upperBox.minX>=lowerBox.minX-1e-6&&upperBox.maxX<=lowerBox.maxX+1e-6&&upperBox.minY>=lowerBox.minY-1e-6&&upperBox.maxY<lowerBox.maxY-100);
  near((await quote()).regions.find(region=>region.id===upperRoom.id).netArea,12);
  await selectRegion(upperRoom.id);await material('demo-tile',{unitPrice:80,wasteRate:5,laborRate:15,additionalCost:0});
  await switchLevel(lowerLevel.id);assert.deepEqual((await project()).furniture,lowerFurnitureBeforeLevels);
  near((await quote()).regions.find(region=>region.id===lowerRoom.id).netArea,24);assert.equal((await project()).regions[0].items[0].unitPrice,'100');assert.equal((await project()).furniture.length,5);
  await switchLevel(upperLevel.id);
  pass('添加空白二楼独立设计6×2m半幅夹层，跨层相同XY合法，切回一楼保留墙体、家具、单价和24m²');

  await selectRegion(upperRoom.id);await page.locator('[data-action="draw-floor-hole"][data-hole-shape="polygon"]').click();
  const hole=[{x:upperBox.minX+250,y:upperBox.minY+50},{x:upperBox.minX+350,y:upperBox.minY+50},{x:upperBox.minX+350,y:upperBox.minY+150},{x:upperBox.minX+250,y:upperBox.minY+150}];
  for(const point of hole)await click(point);await page.keyboard.press('Enter');await page.waitForFunction(()=>window.planStudio.getProject().floorOpenings?.length===1);
  near((await quote()).regions.find(region=>region.id===upperRoom.id).netArea,11);near((await quote()).regions.find(region=>region.id===lowerRoom.id).netArea,24);
  await selectRegion(upperRoom.id);await page.locator('[data-action="select-surface"][data-surface="ceiling"]').click();await page.locator('#ceiling-enabled').check();await page.locator('#ceiling-height').fill('2.6');await page.locator('#ceiling-height').press('Tab');
  await material('demo-tile',{unitPrice:50,wasteRate:10,laborRate:12,additionalCost:0});
  const ceilingQuote=(await quote()).ceilings.find(ceiling=>ceiling.sourceRegionId===upperRoom.id);assert.ok(ceilingQuote);near(ceilingQuote.netArea,11);assert.equal(ceilingQuote.materialCost,'605.00');assert.equal(ceilingQuote.laborCost,'132.00');assert.equal(ceilingQuote.total,'737.00');
  await captureInspector('loft-ceiling-inspector','#ceiling-height');
  pass('真实1m²楼板洞只扣上层面积12→11m²，天花板同扣，损耗605元与人工132元分列计价');
  await switchLevel(lowerLevel.id);await enterDecoration();const stairId=await place('stairs',{x:(lowerBox.minX+lowerBox.maxX)/2,y:(lowerBox.minY+lowerBox.maxY)/2},1800,'100');
  let stair=(await project()).furniture.find(item=>item.id===stairId);assert.equal(stair.stairTargetLevelId,upperLevel.id);near(stair.height,300);await page.locator('#furniture-rotation').fill('180');
  await page.locator('#stair-target').selectOption('');assert.equal((await project()).furniture.find(item=>item.id===stairId).stairTargetLevelId,undefined);await page.locator('#stair-target').selectOption(upperLevel.id);near((await project()).furniture.find(item=>item.id===stairId).height,300);
  await page.locator('[data-action="manage-levels"]').click();await page.locator('#level-edit-form [name="height"]').fill('3.3');await page.locator('#level-edit-form [type="submit"]').click();
  near((await project()).furniture.find(item=>item.id===stairId).height,330);near((await project()).levels[1].elevation,330);
  await page.locator('[data-action="manage-levels"]').click();await page.locator('#level-edit-form [name="height"]').fill('3');await page.locator('#level-edit-form [type="submit"]').click();near((await project()).furniture.find(item=>item.id===stairId).height,300);
  await selectFurniture(stairId);await captureInspector('loft-stair-inspector','#stair-target');
  pass('直跑楼梯自动连接二楼并按真实层间升高生成，目标可改，层高改变同步更新而单价保留');

  await page.locator('#settings').click();await page.locator('#settings-form [name="additionalCost"]').fill('50');await page.locator('#settings-form [name="taxRate"]').fill('9');await page.locator('#settings-form [type="submit"]').click();
  let totalQuote=await quote();assert.equal(totalQuote.pending,false);assert.equal(totalQuote.levelSummaries.length,2);assert.equal(totalQuote.knownFurnitureCost,'9300.00');assert.equal(totalQuote.beforeTax,'14296.00');assert.equal(totalQuote.tax,'1286.64');assert.equal(totalQuote.total,'15582.64');
  assert.equal(totalQuote.regions.find(region=>region.id===upperRoom.id).total,'1089.00');
  pass('两层地面、天花板和家具统一税前14296元，50元项目费用与9%税只加一次，总价15582.64元');
  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready);await frame();
  stats=await page.evaluate(()=>window.planStudio.get3DStats());if(stats.levelMode!=='all'){await page.locator('#show-all-levels').click();await frame();}
  stats=await page.evaluate(()=>window.planStudio.get3DStats());assert.equal(stats.levelCount,2);assert.equal(stats.floorCount,2);assert.ok(stats.wallHeights.some(wall=>Math.abs(wall.base-3)<1e-6));assert.ok(stats.wallHeights.some(wall=>Math.abs(wall.base)<1e-6));
  const slab=stats.slabs.find(slab=>slab.levelId===upperLevel.id);assert.ok(slab);near(slab.top,3);near(slab.bottom,2.8);near(slab.netArea,11);assert.equal(slab.holeCount,1);
  near(stats.furniture.find(item=>item.id===stairId).size.height,3);assert.ok(stats.furniture.find(item=>item.id===stairId).surfaceCount>6);
  await page.locator('#show-ceilings').click();await frame();stats=await page.evaluate(()=>window.planStudio.get3DStats());assert.equal(stats.ceilingsVisible,true);assert.equal(stats.renderedCeilingCount,1);near(stats.ceilings.find(ceiling=>ceiling.levelId===upperLevel.id).height,5.6);near(stats.ceilings.find(ceiling=>ceiling.levelId===upperLevel.id).netArea,11);
  const pixels=await page.evaluate(()=>{const canvas=document.querySelector('#viewer3d canvas'),gl=canvas.getContext('webgl');gl.finish();const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);let colored=0;for(let i=0;i<data.length;i+=4)if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>12)colored++;return{colored,error:gl.getError()};});assert.ok(pixels.colored>300);assert.equal(pixels.error,0);assert.equal(stats.glError,0);
  await page.screenshot({path:join(artifacts,'loft-all-levels-3d.png')});await page.locator('#show-all-levels').click();await frame();assert.equal(await page.evaluate(()=>window.planStudio.get3DStats().levelCount),1);assert.equal((await quote()).total,totalQuote.total);await page.locator('#show-all-levels').click();await page.locator('#show-ceilings').click();
  pass('真实3D按0/3m叠放两层，楼板厚20cm及洞口准确，天花板5.6m；显示切换不改预算且像素不是空白');
  await page.locator('[data-view="2d"]').click();await switchLevel(upperLevel.id);
  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');const saved=await project();
  await page.reload();await page.waitForFunction(()=>window.planStudio?.getLevels);await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);
  assert.deepEqual((await project()).levels,saved.levels);assert.equal((await project()).activeLevelId,upperLevel.id);assert.deepEqual((await project()).floorOpenings,saved.floorOpenings);assert.equal((await quote()).total,totalQuote.total);
  await page.locator('#export').click();const jsonEvent=page.waitForEvent('download');await page.locator('[data-export="json"]').click();const jsonFile=await jsonEvent;await jsonFile.saveAs(join(artifacts,'loft-project.json'));const exported=JSON.parse(await readFile(await jsonFile.path(),'utf8'));assert.deepEqual(exported.levels,saved.levels);
  await page.locator('#open-project').click();await page.locator('[data-action="import-project"]').click();await page.locator('#project-file').setInputFiles(join(artifacts,'loft-project.json'));await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);assert.equal((await quote()).total,totalQuote.total);
  pass('两层项目本机保存、刷新重开和真实JSON导入保留楼板洞、天花板、家具、活动层及完整报价');
  await page.locator('#export').click();const csvEvent=page.waitForEvent('download');await page.locator('[data-export="csv"]').click();const csvFile=await csvEvent;await csvFile.saveAs(join(artifacts,'loft-quote.csv'));const csv=await readFile(await csvFile.path(),'utf8'),rows=parseCSV(csv);assert.ok(rows.every(row=>row.length===25));assert.ok(csv.includes('一楼')&&csv.includes('二楼夹层')&&csv.includes('天花板'));assert.ok(rows.some(row=>row.includes(totalQuote.total)));
  await page.locator('#export').click();const popupEvent=page.waitForEvent('popup');await page.locator('[data-export="pdf"]').click();const popup=await popupEvent;await popup.waitForLoadState('domcontentloaded');const text=await popup.locator('body').innerText();assert.ok(text.includes('一楼')&&text.includes('二楼夹层')&&text.includes('天花板'));await popup.pdf({path:join(artifacts,'loft-quote.pdf'),format:'A4',printBackground:true});await popup.close();
  pass('实际CSV保持25列并列明两层和天花板，真实打印PDF包含整栋项目报价');
  await page.locator('[data-action="manage-levels"]').click();await page.locator(`[data-level-delete="${upperLevel.id}"]`).click();await page.waitForFunction(()=>window.planStudio.getProject().levels.length===1);assert.equal((await quote()).levelSummaries.length,1);assert.ok(Number((await quote()).total)<Number(totalQuote.total));await page.locator('#undo').click();assert.equal((await project()).levels.length,2);assert.equal((await quote()).total,totalQuote.total);
  pass('删除二楼只移除该层预算，单次撤销恢复完整楼层与原总报价');
  const beforeCopy=await project();await switchLevel(upperLevel.id);
  await page.locator('[data-action="manage-levels"]').click();await page.locator('#level-add-form [name="name"]').fill('复制层验收');await page.locator('#level-add-form [name="copyLayout"]').selectOption('true');await page.locator('#level-add-form [type="submit"]').click();await page.waitForFunction(()=>window.planStudio.getProject().levels.length===3);
  const copied=await project(),copiedRoom=copied.regions[0],copiedLevel=copied.levels[2];assert.notEqual(copiedRoom.id,upperRoom.id);assert.deepEqual(copiedRoom.points,upperRoom.points);assert.equal(copiedRoom.items[0].unitPrice,'80');assert.equal(copiedRoom.ceiling.items[0].unitPrice,'50');assert.equal(copied.floorOpenings[0].regionId,copiedRoom.id);near((await quote()).levelSummaries.find(level=>level.id===copiedLevel.id).netArea,11);assert.equal(Number((await quote()).beforeTax)-Number(totalQuote.beforeTax),1826);
  await page.locator('[data-action="manage-levels"]').click();await page.locator(`[data-level-delete="${copiedLevel.id}"]`).click();assert.equal((await project()).levels.length,beforeCopy.levels.length);assert.equal((await quote()).total,totalQuote.total);
  pass('复制本层布局生成独立楼层和洞口编号，保留材料/天花板价格且只加一次1826元，删除复制层恢复原预算');
  await switchLevel(lowerLevel.id);await enterDecoration();
  for(const viewportWidth of[1440,1100]){await page.setViewportSize({width:viewportWidth,height:1000});await page.locator('#fit').click();await selectFurniture(furnitureIds[0]);await frame();const layout=await page.evaluate(()=>{const grid=document.querySelector('#furniture-presets'),canvas=document.querySelector('#drawing-canvas').getBoundingClientRect(),handle=window.planStudio.getFurnitureRotationHandle(),hit=handle&&document.elementFromPoint(canvas.left+handle.x,canvas.top+handle.y);return{scroll:document.documentElement.scrollWidth,width:innerWidth,selector:(()=>{const box=document.querySelector('#active-level-select').getBoundingClientRect();return{left:box.left,right:box.right};})(),grid:{height:grid.clientHeight,scroll:grid.scrollHeight,overflow:getComputedStyle(grid).overflowY},handleVisible:hit?.id==='drawing-canvas'};});assert.ok(layout.scroll<=layout.width);assert.ok(layout.selector.left>=0&&layout.selector.right<=viewportWidth);assert.ok(layout.grid.height>0&&layout.grid.height<=400);assert.ok(layout.grid.scroll>layout.grid.height);assert.equal(layout.grid.overflow,'auto');assert.equal(layout.handleVisible,true);await page.locator('[data-place-furniture="stairs"]').scrollIntoViewIfNeeded();assert.ok(await page.locator('[data-place-furniture="stairs"]').isVisible());await page.screenshot({path:join(artifacts,`loft-furniture-layout-${viewportWidth}.png`)});}
  await returnPlan();await switchLevel(upperLevel.id);
  for(const viewportWidth of[1440,1100]){await page.setViewportSize({width:viewportWidth,height:1000});await page.locator('#fit').click();await frame();const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,selector:(()=>{const box=document.querySelector('#active-level-select').getBoundingClientRect();return{left:box.left,right:box.right};})()}));assert.ok(layout.scroll<=layout.width);assert.ok(layout.selector.left>=0&&layout.selector.right<=viewportWidth);await page.screenshot({path:join(artifacts,`loft-two-dimensional-${viewportWidth}.png`)});}
  pass('1440/1100桌面宽度下无整页溢出，93预设内部滚动且末项可见，家具旋转手柄无遮挡');
  const boundaryContext=await browser.newContext({viewport:{width:1440,height:1000}});page=await boundaryContext.newPage();page.on('pageerror',error=>runtimeErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(baseURL);await page.waitForFunction(()=>window.planStudio?.getFurnitureRotationHandle);await page.locator('#draw-plan').click();await templateRoom('旋转边界验收',6,4);await selectRegion((await project()).regions[0].id);await material('demo-wood',{unitPrice:0,wasteRate:0,laborRate:0,additionalCost:0});
  // Keep the user's boundary inside the sheet, so boundary validation is
  // exercised independently of the existing sheet-edge furniture clamping.
  await page.locator('[data-action="plan-boundary"]').first().click();for(const[name,value]of[['x','0.5'],['y','0.5'],['width','9'],['depth','7']])await page.locator(`#plan-boundary-form [name="${name}"]`).fill(value);await page.locator('[form="plan-boundary-form"][type="submit"]').click();await enterDecoration();await page.locator('#fit').click();await page.locator('#zoom-out').click();await page.locator('#zoom-out').click();
  const boundaryTV=await place('tv',{x:500,y:70},20);assert.equal((await quote()).total,'20.00');const safe=await project();near(safe.furniture[0].rotation,0);
  await rotateDrag(90);near((await project()).furniture.find(item=>item.id===boundaryTV).rotation,0);assert.equal((await quote()).total,'20.00');await page.locator('#furniture-rotation').fill('90');assert.deepEqual((await project()).furniture,safe.furniture);assert.ok(await page.locator('#furniture-rotation').evaluate(input=>input.classList.contains('validation-error')));assert.equal((await quote()).total,'20.00');await page.screenshot({path:join(artifacts,'rotation-boundary-rejection.png')});
  pass('家具旋转后真实占地超出边界时，拖动手柄和角度输入均拒绝，原几何与20元预算保持');
  assert.deepEqual(runtimeErrors,[]);pass('新增家具、任意旋转、多楼层、楼梯和天花板全流程无浏览器运行时异常');
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,quote:totalQuote},null,2));process.stdout.write(`\n${reports.length} 项家具与Loft浏览器验收通过。\n`);
}catch(error){await page?.screenshot({path:join(artifacts,'loft-failure.png')}).catch(()=>{});if(page)process.stderr.write(JSON.stringify(await page.evaluate(()=>{const p=window.planStudio?.getProject?.(),q=window.planStudio?.getQuote?.();return{toast:document.querySelector('#toast')?.textContent,project:p&&{id:p.id,activeLevelId:p.activeLevelId,levels:p.levels?.map(level=>({id:level.id,name:level.name,elevation:level.elevation,height:level.height,regions:level.content?.regions?.length,furniture:level.content?.furniture?.length})),regionIds:p.regions?.map(region=>region.id),furniture:p.furniture,floorOpenings:p.floorOpenings},quote:q&&{pending:q.pending,pendingReason:q.pendingReason,regions:q.regions?.map(region=>({id:region.id,levelId:region.levelId,area:region.netArea,total:region.total})),ceilings:q.ceilings,levelSummaries:q.levelSummaries,total:q.total},selection:window.planStudio?.getSelection?.()};}).catch(()=>({})),null,2)+'\n');throw error;}
finally{await browser?.close();server.kill();}
