import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Uses the application's real parametric meshes. No downloaded/raster assets.
const compiled = resolve(process.env.FURNITURE_BUILD_ROOT || 'build/studio');
const { FURNITURE_TEMPLATES } = await import(pathToFileURL(join(compiled,'lib/furniture-catalog.js')));
const { buildFurniture3D } = await import(pathToFileURL(join(compiled,'lib/furniture3d.js')));
const { isFixtureKind } = await import(pathToFileURL(join(compiled,'lib/fixtures.js')));
const assetRoot = resolve(process.env.FURNITURE_ASSET_OUTPUT || 'static/studio/assets');
const directory = join(assetRoot,'furniture');
await mkdir(directory,{recursive:true});
const original = new Set(['sofa','bed','table','chair','cabinet','nightstand','wardrobe','custom']);
const models = [];
const escape = text => String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));

// Tiny panels have virtually no depth. Centroid sorting lets one broad body
// face cover half its sockets. Order overlapping convex projections using the
// actual face planes, so these SVGs show the same details as depth-tested 3D.
function orderHardwareFaces(faces, project, vertical) {
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const area=ring=>ring.reduce((sum,p,i)=>sum+p.x*ring[(i+1)%ring.length].y-ring[(i+1)%ring.length].x*p.y,0)/2;
  const intersect=(subject,clip)=>{
    let ring=subject;const sign=Math.sign(area(clip));
    for(let edge=0;edge<clip.length&&ring.length;edge++){
      const a=clip[edge],b=clip[(edge+1)%clip.length],input=ring;ring=[];
      for(let i=0;i<input.length;i++){
        const p=input[i],q=input[(i+1)%input.length],dp=cross(a,b,p)*sign,dq=cross(a,b,q)*sign;
        if(dp>=-1e-12)ring.push(p);
        if((dp>=0)!==(dq>=0)){const t=dp/(dp-dq);ring.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}
      }
    }
    return ring;
  };
  const view={x:1,y:.84*vertical,z:1};
  const records=faces.map((face,index)=>{
    const polygon=face.points.map(project),n=face.normal,p=face.points[0];
    return {face,index,polygon,minX:Math.min(...polygon.map(p=>p.x)),maxX:Math.max(...polygon.map(p=>p.x)),minY:Math.min(...polygon.map(p=>p.y)),maxY:Math.max(...polygon.map(p=>p.y)),
      plane:n.x*p.x+n.y*p.y+n.z*p.z,denominator:n.x*view.x+n.y*view.y+n.z*view.z};
  });
  const depthAt=(record,point)=>{
    const base={x:point.x/1.64,y:-point.y*vertical,z:-point.x/1.64},n=record.face.normal;
    return(record.plane-n.x*base.x-n.y*base.y-n.z*base.z)/record.denominator;
  };
  const edges=records.map(()=>new Set()),incoming=records.map(()=>0);
  const add=(a,b)=>{if(!edges[a].has(b)){edges[a].add(b);incoming[b]++;}};
  for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
    const a=records[i],b=records[j];
    if(a.maxX<=b.minX+1e-12||b.maxX<=a.minX+1e-12||a.maxY<=b.minY+1e-12||b.maxY<=a.minY+1e-12)continue;
    const overlap=intersect(a.polygon,b.polygon);
    if(overlap.length<3||Math.abs(area(overlap))<1e-12)continue;
    const point={x:overlap.reduce((sum,p)=>sum+p.x,0)/overlap.length,y:overlap.reduce((sum,p)=>sum+p.y,0)/overlap.length};
    const difference=depthAt(a,point)-depthAt(b,point);
    if(Math.abs(difference)>1e-10)add(difference<0?i:j,difference<0?j:i);
    else if(Number(a.face.id.includes(':detail:'))>Number(b.face.id.includes(':detail:')))add(j,i);
    else add(i,j);
  }
  const remaining=new Set(records.map(record=>record.index)),ordered=[];
  while(remaining.size){
    const index=[...remaining].find(index=>incoming[index]===0)??remaining.values().next().value;
    ordered.push(records[index].face);remaining.delete(index);
    for(const target of edges[index])incoming[target]--;
  }
  return ordered;
}

for(const template of FURNITURE_TEMPLATES.filter(template=>!original.has(template.kind))) {
  // View the right-turn L from its open corner so both flights and the landing
  // remain visible. Only the preview instance rotates; its structure and
  // catalogue dimensions are the same geometry used by the application.
  const previewRotation = template.kind === 'stairsLRight' ? 270 : 0;
  const model = buildFurniture3D({drawing:{type:'plan'},calibration:{metersPerPixel:.01},furniture:[{...template,id:template.kind,position:{x:0,y:0},mountHeight:0,rotation:previewRotation,quantity:'1',unitPrice:'',additionalCost:'0'}]})[0];
  // Ceiling points are previewed from below, so their actual detector / light
  // face is visible. The exported model and installation height stay unchanged.
  const vertical = ['downlight','wirelessAP','smokeDetector','linearLight','powerPlug'].includes(template.kind) ? -1 : 1;
  let surfaces = model.surfaces.filter(face=>isFixtureKind(template.kind)?face.normal.x+face.normal.y*.84*vertical+face.normal.z>1e-10:face.normal.x*.7+face.normal.y*.9+face.normal.z*.7>0);
  const project = p=>({x:(p.x-p.z)*.82,y:(p.x+p.z)*.42-p.y*vertical});
  const points=surfaces.flatMap(face=>face.points.map(project));
  const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
  const scale=Math.min(170/(maxX-minX),136/(maxY-minY));
  const map=p=>{const q=project(p);return `${(100+(q.x-(minX+maxX)/2)*scale).toFixed(2)},${(80+(q.y-(minY+maxY)/2)*scale).toFixed(2)}`;};
  const shade = face=>{
    const factor=.81+.19*Math.max(0,face.normal.y*.7*vertical+face.normal.x*.2+face.normal.z*.1);
    return '#'+[1,3,5].map(index=>Math.round(parseInt(face.color.slice(index,index+2),16)*factor).toString(16).padStart(2,'0')).join('');
  };
  // Decorative disks sit on exposed front/top faces. Paint their true polygon
  // last; tiny centroid differences must not put a burner behind a broad cap.
  if(isFixtureKind(template.kind))surfaces=orderHardwareFaces(surfaces,project,vertical);
  else surfaces.sort((a,b)=>Number(a.id.includes(':detail:'))-Number(b.id.includes(':detail:'))||a.points.reduce((sum,p)=>sum+p.x+p.z,0)/a.points.length-b.points.reduce((sum,p)=>sum+p.x+p.z,0)/b.points.length);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160"><title>${escape(template.name)} · 原创参数模型预览</title>${surfaces.map(face=>`<polygon points="${face.points.map(map).join(' ')}" fill="${shade(face)}"/>`).join('')}</svg>\n`;
  await writeFile(join(directory,`${template.kind}.svg`),svg,'utf8');
  models.push({kind:template.kind,preview:`furniture/${template.kind}.svg`,faces:model.surfaces.length});
}
await writeFile(join(assetRoot,'furniture-catalog-manifest.json'),JSON.stringify({schema:1,license:'CC0-1.0',source:'Original procedural furniture meshes rendered as local SVG previews',models},null,2)+'\n');
process.stdout.write(`${models.length} local furniture previews generated.\n`);
