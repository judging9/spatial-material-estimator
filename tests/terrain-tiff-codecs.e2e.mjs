import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGeoTIFF,setGeoTIFFTag} from './helpers/geotiff-fixture.mjs';
import {parseTerrainGeoTIFF} from '../static/studio/lib/terrain-geotiff.js';

const artifacts=resolve('artifacts/terrain-codecs'),testRoot=await mkdtemp(join(tmpdir(),'studio-tiff-codecs-'));
await mkdir(artifacts,{recursive:true});
const python=process.env.PYTHON||(existsSync('D:/python/python.exe')?'D:/python/python.exe':'python');
const server=spawn(python,['-u','tests/studio_test_server.py'],{env:{...process.env,STUDIO_TEST_ROOT:testRoot,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
let browser,page,serverErrors='',outcome='failed';server.stderr.on('data',chunk=>serverErrors+=chunk);
const reports=[],runtimeErrors=[],pass=message=>{reports.push(message);process.stdout.write(`✓ ${message}\n`);};
const buffer=raw=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
const semantic=value=>JSON.parse(JSON.stringify(value));
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
try{
  const url=await new Promise((accept,reject)=>{
    const timer=setTimeout(()=>reject(new Error(serverErrors||'TIFF codec test server timeout')),20000);
    server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});
    server.on('exit',code=>{clearTimeout(timer);reject(new Error('Test server exited '+code));});
  });
  const executablePath=process.env.CHROME_PATH||['C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  page=await context.newPage();page.on('dialog',dialog=>dialog.accept());page.on('pageerror',error=>runtimeErrors.push(error.message));
  await page.goto(url);await page.waitForFunction(()=>window.planStudio?.getProject);
  const project=()=>page.evaluate(()=>window.planStudio.getProject());
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const edit=async()=>{await page.locator('#left-panel [data-action="edit-terrain"]').click();await page.locator('#terrain-form').waitFor();};
  const close=()=>page.locator('#dialog [data-dialog-close]').click();
  const apply=async()=>{await page.locator('#terrain-form [type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#dialog')?.open);await frame();};
  const upload=(data,name)=>page.locator('#terrain-file').setInputFiles({name,mimeType:'image/tiff',buffer:data});
  const importValid=async(data,name)=>{
    await upload(data,name);
    await page.waitForFunction(name=>document.querySelector('#terrain-source').textContent.includes(name)||!document.querySelector('#terrain-geotiff-confirm').hidden||!!document.querySelector('#terrain-error').textContent,name);
    if(await page.locator('#terrain-geotiff-confirm').isVisible()){
      assert.ok(await page.locator('#terrain-geotiff-retry').isDisabled());
      await page.locator('#terrain-geotiff-meters').check();await page.locator('#terrain-geotiff-retry').click();
    }else assert.equal(await page.locator('#terrain-error').textContent(),'');
    await page.waitForFunction(name=>document.querySelector('#terrain-source').textContent.includes(name),name);
    assert.equal(await page.locator('#terrain-error').textContent(),'');
  };
  const screenshot=async name=>{
    await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#toast')).opacity==='0');
    await frame();await page.screenshot({path:join(artifacts,name)});
  };
  await page.locator('#enter-municipal').click();await page.waitForFunction(()=>window.planStudio.getWorkspaceMode()==='municipal');

  const gdal=resolve('development_resources/gdal-master/gdal-master/autotest/gcore/data');
  const reference=await parseTerrainGeoTIFF(buffer(await readFile(join(gdal,'byte.tif'))),{confirmLocalMeters:true});
  for(const name of ['byte_LZW.tif','byte_LZW_tiled.tif','float32_LZW_predictor_3.tif','float32_lzw_predictor_3_big_endian.tif','float64_LZW_predictor_3.tif']){
    await edit();const before=await project();await importValid(await readFile(join(gdal,'gtiff',name)),name);
    assert.deepEqual(await project(),before);await apply();
    const t=(await project()).municipalTerrain;assert.deepEqual(t.raster.values,reference.raster.values,name);
    assert.equal(t.raster.values.length,400);assert.equal(t.raster.values.reduce((sum,v)=>sum+v,0),50706);
    assert.equal(t.rasterSource.compression,5);assert.deepEqual(t.rasterSource.pixelScale,[60,60,0]);
    assert.equal(t.rasterSource.originEasting,440720);assert.equal(t.rasterSource.originNorthing,3751320);
    if(name.includes('predictor_3'))assert.equal(t.rasterSource.predictor,3);
  }
  pass('实际上传5份独立GDAL LZW/瓦片/float32/float64/大端文件，全部400样本和米制来源一致');

  const rows=[[-1.25,2.125,3.0625],[0,5.5,10.75],[.125,-.25,20.5]],matrix=[];
  for(const compression of [5,8,32946])for(const bits of [32,64])for(const littleEndian of [true,false])for(const storage of ['strips','tiles']){
    const name=`c${compression}-f${bits}-${littleEndian?'II':'MM'}-${storage}.tif`;
    await edit();await importValid(createGeoTIFF({rows,compression,bits,littleEndian,storage,predictor:3,blockWidth:2,blockHeight:2}),name);await apply();
    const t=(await project()).municipalTerrain;assert.deepEqual(t.raster.values,rows.flat(),name);
    assert.equal(t.rasterSource.compression,compression);assert.equal(t.rasterSource.predictor,3);matrix.push(name);
  }
  assert.equal(matrix.length,24);pass('24种LZW/Deflate×float32/64×大小端×条带/瓦片实际上传并准确恢复原始高程');

  await edit();await page.locator('#terrain-geotiff-placement').selectOption('local');
  const survey=createGeoTIFF({rows:[[0,10,20],[30,NaN,50],[60,70,80]],compression:5,predictor:3,bits:64,littleEndian:false,storage:'tiles',blockWidth:2,blockHeight:2,noData:'nan',bandScale:.1,bandOffset:100,unit:'m',originX:13500000,originY:3500000});
  await writeFile(join(artifacts,'survey-lzw-predictor3.tif'),survey);await importValid(survey,'实测浮点LZW.tif');
  assert.equal(await page.locator('[data-terrain-cell="0"]').inputValue(),'100');await apply();
  const original=(await project()).municipalTerrain;assert.deepEqual(original.raster.values,[100,101,102,103,null,105,106,107,108]);
  assert.equal(original.rasterSource.compression,5);assert.equal(original.rasterSource.predictor,3);
  assert.equal(original.rasterSource.noData,'nan');assert.equal(original.rasterSource.originEasting,13500000);
  const geometry=await page.evaluate(async()=>{
    const {terrainStats,terrainElevation,calculateTerrainEarthworks}=await import('/studio/lib/terrain.js');
    const t=window.planStudio.getProject().municipalTerrain;
    const design=[[{x:5,y:5,z:110},{x:25,y:5,z:110},{x:25,y:25,z:110}],[{x:5,y:5,z:110},{x:25,y:25,z:110},{x:5,y:25,z:110}]];
    return{stats:terrainStats(t),center:terrainElevation(t,15,15),corner:terrainElevation(t,5,5),earthworks:calculateTerrainEarthworks(t,design)};
  });
  assert.equal(geometry.center,null);near(geometry.corner,100);near(geometry.stats.area,100);
  assert.equal(geometry.stats.triangleCount,2);near(geometry.earthworks.coveredArea,100);
  near(geometry.earthworks.fillVolume,600);near(geometry.earthworks.cutVolume,0);near(geometry.earthworks.uncoveredArea,300);
  pass('浮点NoData先移除再SCALE/OFFSET：100～108m，孔洞不跨填，100m²有效地形和600m³填方真实积分');

  await edit();const validDraft=await page.locator('#terrain-source').textContent();
  let oversized=createGeoTIFF({rows:Array.from({length:16},()=>Array(16).fill(5)),compression:5,predictor:3});
  for(const [id,value]of [[256,2],[257,2],[278,2]])oversized=setGeoTIFFTag(oversized,id,value);
  const invalid=[
    ['损坏LZW.tif',setGeoTIFFTag(createGeoTIFF(),259,5),'LZW'],
    ['超量LZW.tif',oversized,'超过实际'],
    ['整数预测器3.tif',createGeoTIFF({compression:5,predictor:3,sampleFormat:2,bits:16}),'预测'],
    ['浮点预测器2.tif',createGeoTIFF({compression:5,predictor:2}),'预测'],
    ['未压缩预测器3.tif',createGeoTIFF({predictor:3}),'预测'],
    ['未支持JPEG.tif',setGeoTIFFTag(createGeoTIFF(),259,7),'压缩']
  ];
  for(const [name,data,pattern]of invalid){
    await upload(data,name);await page.waitForFunction(pattern=>document.querySelector('#terrain-error').textContent.includes(pattern),pattern);
    assert.equal(await page.locator('#terrain-source').textContent(),validDraft);assert.equal(await page.locator('[data-terrain-cell="0"]').inputValue(),'100');
    assert.deepEqual((await project()).municipalTerrain,original);
  }
  await close();pass('损坏/超量LZW、错误Predictor组合与JPEG明确拒绝，原有效草稿及项目高程完整保留');

  await edit();await page.locator('[data-terrain-cell="0"]').fill('99.5');await page.locator('#terrain-origin-x').fill('12');await apply();
  const edited=(await project()).municipalTerrain;assert.equal(edited.raster.values[0],99.5);assert.equal(edited.raster.originX,12);
  assert.deepEqual(edited.rasterSource,original.rasterSource);await page.locator('#undo').click();assert.deepEqual((await project()).municipalTerrain,original);
  await page.locator('#redo').click();assert.deepEqual((await project()).municipalTerrain,edited);
  pass('原始压缩/预测器和地理元数据独立保留，手工编辑高程/位置可完整撤销与重做');

  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.ready&&window.planStudio.get3DStats()?.terrainTriangleCount===2);
  const scene=await page.evaluate(()=>window.planStudio.get3DStats());assert.equal(scene.terrainDrawBatches,1);
  for(const surface of scene.terrainSurfaces)for(const vertex of surface.points){
    const col=Math.round((vertex.x-12)/10-.5),row=Math.round(vertex.z/10-.5);
    near(vertex.x,12+(col+.5)*10);near(vertex.z,(row+.5)*10);near(vertex.y,edited.raster.values[row*3+col]);
    assert.notEqual(edited.raster.values[row*3+col],null);
  }
  await page.locator('#fit').click();await screenshot('lzw-predictor3-3d-1440.png');
  await page.locator('[data-view="2d"]').click();await page.locator('#fit').click();await screenshot('lzw-predictor3-2d-1440.png');
  pass('二维和三维使用真实像元中心与高程，NoData仅剩2面，三维保持1GPU批次');

  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存到本机');
  const saved=await project();await page.reload();await page.waitForFunction(()=>window.planStudio?.getProject);
  await page.locator('#open-project').click();await page.locator(`[data-open-project="${saved.id}"]`).click();
  await page.waitForFunction(id=>window.planStudio.getProject().id===id,saved.id);assert.deepEqual(semantic((await project()).municipalTerrain),semantic(saved.municipalTerrain));
  await page.locator('#export').click();const downloading=page.waitForEvent('download');await page.locator('[data-export="json"]').click();
  const download=await downloading;const exportedPath=join(artifacts,'lzw-predictor3-project.json');await download.saveAs(exportedPath);
  const exported=JSON.parse(await readFile(exportedPath,'utf8'));assert.deepEqual(exported.municipalTerrain,semantic(saved.municipalTerrain));
  await page.locator('#open-project').click();await page.locator('[data-action="import-project"]').click();await page.locator('#project-file').setInputFiles(exportedPath);
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('完整项目已导入'));
  assert.deepEqual(semantic((await project()).municipalTerrain),semantic(saved.municipalTerrain));
  pass('本机保存、刷新重开和JSON导出重导入保留全高程、compression5/predictor3及原始米制坐标');

  for(const width of [1440,1100]){
    await page.setViewportSize({width,height:1000});await edit();
    assert.ok(await page.locator('#dialog .dialog-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    assert.ok(await page.locator('#terrain-form [type="submit"]').evaluate(n=>{const b=n.getBoundingClientRect(),body=n.closest('.dialog-body').getBoundingClientRect();return b.top>=body.top&&b.bottom<=Math.min(body.bottom,innerHeight);}),`${width}px初屏应用按钮应可见`);
    await screenshot(`lzw-predictor3-editor-${width}.png`);await close();
  }
  pass('1440/1100编辑器无横向溢出，真实压缩地形信息、预览与初屏应用按钮可见');

  const largeRows=Array.from({length:128},(_,r)=>Array.from({length:128},(_,c)=>r+c/2));
  await edit();await importValid(createGeoTIFF({rows:largeRows,compression:5,predictor:3,bits:32,storage:'tiles',blockWidth:16,blockHeight:16,cellSize:1}),'完整128浮点LZW.tif');
  assert.equal(await page.locator('[data-terrain-cell]').count(),12);await apply();
  assert.deepEqual((await project()).municipalTerrain.raster.values,largeRows.flat());
  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.planStudio.get3DStats()?.terrainTriangleCount===32258);
  const largeStats=await page.evaluate(()=>{const s=window.planStudio.get3DStats();return{triangles:s.terrainTriangleCount,batches:s.terrainDrawBatches};});
  assert.equal(largeStats.batches,1);assert.deepEqual(runtimeErrors,[]);
  await page.locator('#fit').click();await screenshot('lzw-predictor3-128-3d.png');
  pass('128²浮点LZW全16384值准确保留，32258真实面和1GPU批次，所有主流程无浏览器异常');
  await writeFile(join(artifacts,'acceptance.json'),JSON.stringify({checks:reports.length,reports,matrix,runtimeErrors,geometry,original,edited,largeStats},null,2));
  outcome='passed';process.stdout.write(`\n${reports.length} 项TIFF压缩浏览器验收通过。\n`);
}catch(error){
  await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});
  await writeFile(join(artifacts,'failure-state.json'),JSON.stringify({error:String(error),reports,runtimeErrors,state:await page?.evaluate(()=>({project:window.planStudio?.getProject(),terrainError:document.querySelector('#terrain-error')?.textContent})).catch(()=>null)},null,2));
  throw error;
}finally{
  await browser?.close();server.kill();
  await writeFile(join(artifacts,'run-receipt.json'),JSON.stringify({outcome,node:process.version,nodeOptions:process.env.NODE_OPTIONS||'',browserClosed:true,isolatedServerStopped:true,isolatedStorage:testRoot},null,2));
}
