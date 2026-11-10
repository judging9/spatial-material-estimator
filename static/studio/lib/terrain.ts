/** Local metre-coordinate terrain. A deterministic Delaunay TIN uses only
 * supplied survey elevations; interpolation never extends beyond its hull. */
export type TerrainVertex = { x: number; y: number; z: number };
export type TerrainPoint = TerrainVertex & { id: string };
export type TerrainTriangle = [TerrainVertex, TerrainVertex, TerrainVertex];
/** ESRI row zero is the north row. Project Y increases downwards; original
 * georeferencing is retained while originX/originY locate the outer top-left. */
export type TerrainRaster = { format: 'esri-ascii' | 'geotiff'; ncols: number; nrows: number; xllcorner: number; yllcorner: number; cellSize: number; noDataValue: number | null; values: (number | null)[]; coordinateUnit: 'm'; yDirection: 'north-up'; originX: number; originY: number };
/** Original file metadata remains separate from editable project positioning. */
export type TerrainGeoTIFFSource = { format: 'geotiff'; byteOrder: 'little' | 'big'; compression: 1 | 5 | 8 | 32946; storage: 'strips' | 'tiles'; width: number; height: number; bitsPerSample: 8 | 16 | 32 | 64; sampleFormat: 1 | 2 | 3; predictor: 1 | 2 | 3; rasterType: 'area' | 'point'; pixelScale: number[]; tiepoints: number[]; originEasting: number; originNorthing: number; geoKeyDirectory: number[]; geoDoubleParams: number[]; geoAsciiParams: string; modelType: number | null; projectedCrs: number | null; linearUnit: number | null; unitBasis: 'metadata' | 'confirmed-local'; noData: string | null; bandScale: number; bandOffset: number };
export type TerrainModel = { name: string; sourceName?: string; visible: boolean; points: TerrainPoint[]; raster?: TerrainRaster; rasterSource?: TerrainGeoTIFFSource };
export type TerrainMesh = { triangles: TerrainTriangle[]; bounds: { minX: number; minY: number; maxX: number; maxY: number } | null; area: number };
export type TerrainEarthworks = { cutVolume: number; fillVolume: number; coveredArea: number; uncoveredArea: number; designArea: number; status: 'uncovered' | 'partial' | 'complete' };
export const MAX_TERRAIN_POINTS = 1000;
export const MAX_TERRAIN_RASTER_CELLS = 16384;
const cache = new WeakMap<TerrainModel, { signature: string; mesh: TerrainMesh }>();
const cross = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const triangleArea = (a: TerrainVertex, b: TerrainVertex, c: TerrainVertex) => Math.abs(cross(a,b,c))/2;
const extent = (points: {x:number;y:number}[]) => {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
  return {minX,minY,maxX,maxY};
};
function validatePoints(points: TerrainPoint[]): void {
  if(!Array.isArray(points)||points.length>MAX_TERRAIN_POINTS)throw new RangeError(`地形最多支持 ${MAX_TERRAIN_POINTS} 个测点。`);
  const ids=new Set<string>(),xy=new Map<string,TerrainPoint>();
  for(const point of points){
    if(!point||typeof point.id!=='string'||!point.id.trim()||point.id.length>120||ids.has(point.id))throw new RangeError('测点编号不能为空或重复。');
    ids.add(point.id);
    if(![point.x,point.y,point.z].every(value=>typeof value==='number'&&Number.isFinite(value)))throw new RangeError('测点 X、Y、Z 必须填写有效数字，单位为米。');
    if(Math.abs(point.x)>1e7||Math.abs(point.y)>1e7||Math.abs(point.z)>1e5)throw new RangeError('测点平面坐标范围为 ±10000000 m，高程范围为 ±100000 m。');
    const key=`${point.x},${point.y}`,old=xy.get(key);
    if(old)throw new RangeError(old.z===point.z?'测点平面位置重复，请只保留一个测点。':'同一平面位置存在不同高程，请核对测量数据。');
    xy.set(key,point);
  }
  if(points.length>=3){
    const box=extent(points),span=Math.max(box.maxX-box.minX,box.maxY-box.minY);
    const normalized=points.map(point=>({x:(point.x-box.minX)/span,y:(point.y-box.minY)/span}));
    const first=normalized[0],farthest=normalized.reduce((best,p)=>Math.hypot(p.x-first.x,p.y-first.y)>Math.hypot(best.x-first.x,best.y-first.y)?p:best,normalized[1]);
    if(!normalized.some(point=>Math.abs(cross(first,farthest,point))>1e-12))throw new RangeError('地形测点不能全部共线，请补充离开当前测线的真实测点。');
  }
}
export function validateTerrain(model: TerrainModel | undefined | null): void {
  if(model==null)return;
  if(typeof model!=='object'||typeof model.name!=='string'||!model.name.trim()||model.name.length>120||typeof model.visible!=='boolean'||model.sourceName!==undefined&&(typeof model.sourceName!=='string'||model.sourceName.length>240))throw new RangeError('地形数据格式不正确。');
  validatePoints(model.points);
  if(model.raster!==undefined)validateRaster(model.raster);
  if(model.rasterSource!==undefined){validateTerrainGeoTIFFSource(model.rasterSource);if(!model.raster||model.raster.format!=='geotiff'||model.raster.ncols!==model.rasterSource.width||model.raster.nrows!==model.rasterSource.height)throw new RangeError('GeoTIFF 原数据与项目栅格尺寸不一致。');}
}

export function knownMetreProjectedCrs(code:number|null):boolean{return code===3857||code===3395||code!==null&&(code>=32601&&code<=32660||code>=32701&&code<=32760||code>=4491&&code<=4554);}
export function validateTerrainGeoTIFFSource(source:TerrainGeoTIFFSource):void{
  if(!source||source.format!=='geotiff'||!['little','big'].includes(source.byteOrder)||![1,5,8,32946].includes(source.compression)||!['strips','tiles'].includes(source.storage)||![8,16,32,64].includes(source.bitsPerSample)||![1,2,3].includes(source.sampleFormat)||![1,2,3].includes(source.predictor)||!['area','point'].includes(source.rasterType)||!['metadata','confirmed-local'].includes(source.unitBasis))throw new RangeError('GeoTIFF 来源元数据格式不正确。');
  if(!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<2||source.height<2||source.width*source.height>MAX_TERRAIN_RASTER_CELLS)throw new RangeError('GeoTIFF 来源栅格尺寸无效。');
  for(const key of ['pixelScale','tiepoints','geoKeyDirectory','geoDoubleParams'] as const)if(!Array.isArray(source[key])||source[key].length>4096||source[key].some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new RangeError('GeoTIFF 来源坐标或 GeoKey 参数无效。');
  if(source.pixelScale.length!==3||source.pixelScale[0]<=0||source.pixelScale[1]<=0||Math.abs(source.pixelScale[0]-source.pixelScale[1])>Math.max(source.pixelScale[0],source.pixelScale[1])*1e-10||!source.tiepoints.length||source.tiepoints.length%6!==0)throw new RangeError('GeoTIFF 来源应为具有实际定位点的等距北向栅格。');
  if(source.geoKeyDirectory.length&&(source.geoKeyDirectory.length<4||source.geoKeyDirectory[0]!==1||source.geoKeyDirectory[1]!==1||![0,1].includes(source.geoKeyDirectory[2])||source.geoKeyDirectory.length!==4+source.geoKeyDirectory[3]*4||source.geoKeyDirectory.some(value=>!Number.isInteger(value)||value<0||value>65535)))throw new RangeError('保存的 GeoTIFF GeoKey 目录无效。');
  for(const key of ['modelType','projectedCrs','linearUnit'] as const)if(source[key]!==null&&(!Number.isInteger(source[key])||source[key]<0||source[key]>65535))throw new RangeError('GeoTIFF 坐标系编号无效。');
  if(source.modelType!==null&&![1,32767].includes(source.modelType)||source.linearUnit!==null&&source.linearUnit!==9001||source.unitBasis==='metadata'&&source.linearUnit!==9001&&!knownMetreProjectedCrs(source.projectedCrs))throw new RangeError('GeoTIFF 来源必须具有明确米制投影，或确认使用本地米制数据。');
  if(typeof source.geoAsciiParams!=='string'||source.geoAsciiParams.length>65536||source.noData!==null&&(typeof source.noData!=='string'||source.noData.length>120)||![source.bandScale,source.bandOffset,source.originEasting,source.originNorthing].every(value=>typeof value==='number'&&Number.isFinite(value)))throw new RangeError('GeoTIFF 来源说明、原始定位或高程比例与偏移无效。');
  for(let i=0;i<source.tiepoints.length;i+=6){const half=source.rasterType==='point'?source.pixelScale[0]/2:0,east=source.tiepoints[i+3]-source.tiepoints[i]*source.pixelScale[0]-half,north=source.tiepoints[i+4]+source.tiepoints[i+1]*source.pixelScale[1]+half;if(Math.abs(east-source.originEasting)>source.pixelScale[0]*1e-7||Math.abs(north-source.originNorthing)>source.pixelScale[1]*1e-7)throw new RangeError('保存的 GeoTIFF 原始定位与定位点不一致。');}
  if(source.sampleFormat===3&&![32,64].includes(source.bitsPerSample)||source.sampleFormat!==3&&source.bitsPerSample===64||source.predictor===2&&source.sampleFormat===3||source.predictor===3&&(source.sampleFormat!==3||source.compression===1))throw new RangeError('GeoTIFF 来源样本精度或预测器组合不受支持。');
}

function validateRasterShape(raster: TerrainRaster): void {
  if(!raster||!['esri-ascii','geotiff'].includes(raster.format)||raster.coordinateUnit!=='m'||raster.yDirection!=='north-up')throw new RangeError('DEM 必须使用受支持的栅格格式及米制坐标。');
  if(!Number.isInteger(raster.ncols)||!Number.isInteger(raster.nrows)||raster.ncols<2||raster.nrows<2||raster.ncols*raster.nrows>MAX_TERRAIN_RASTER_CELLS)throw new RangeError(`DEM 至少需要 2×2 像元，最多 ${MAX_TERRAIN_RASTER_CELLS} 个像元。`);
  if(![raster.xllcorner,raster.yllcorner,raster.originX,raster.originY,raster.cellSize].every(value=>typeof value==='number'&&Number.isFinite(value))||raster.cellSize<=0)throw new RangeError('DEM 坐标及像元尺寸必须是有效米制数字，像元尺寸必须大于 0。');
  if([raster.xllcorner,raster.yllcorner,raster.originX,raster.originY,raster.originX+raster.ncols*raster.cellSize,raster.originY+raster.nrows*raster.cellSize].some(value=>Math.abs(value)>1e7))throw new RangeError('DEM 平面坐标及边界范围为 ±10000000 m；请先转换为本地米制坐标。');
  if(raster.noDataValue!==null&&(typeof raster.noDataValue!=='number'||!Number.isFinite(raster.noDataValue)))throw new RangeError('DEM NoData 标记必须是有限数字或 null。');
  if(!Array.isArray(raster.values)||raster.values.length!==raster.ncols*raster.nrows)throw new RangeError('DEM 像元数量与行列数不一致。');
}
export function validateRaster(raster: TerrainRaster): void {
  validateRasterShape(raster);
  let valid=0;
  for(const value of raster.values){if(value===null)continue;if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e5)throw new RangeError('DEM 高程必须是 ±100000 m 内的有限数字；缺失像元使用 NoData。');valid++;}
  if(!valid)throw new RangeError('DEM 全部为 NoData，没有实际高程。');
}
export function terrainRasterBounds(raster: TerrainRaster) {return {minX:raster.originX,minY:raster.originY,maxX:raster.originX+raster.ncols*raster.cellSize,maxY:raster.originY+raster.nrows*raster.cellSize};}
/** Two fixed triangles per neighbour cell. Missing samples remove only their
 * incident triangles, so neither triangulation nor querying bridges NoData. */
function rasterCellTriangles(raster:TerrainRaster,row:number,col:number):TerrainTriangle[]{
  if(row<0||col<0||row>=raster.nrows-1||col>=raster.ncols-1)return[];
  const sample=(r:number,c:number):TerrainVertex|null=>{const z=raster.values[r*raster.ncols+c];return typeof z==='number'&&Number.isFinite(z)?{x:raster.originX+(c+.5)*raster.cellSize,y:raster.originY+(r+.5)*raster.cellSize,z}:null;};
  const nw=sample(row,col),ne=sample(row,col+1),se=sample(row+1,col+1),sw=sample(row+1,col),triangles:TerrainTriangle[]=[];
  if(nw&&ne&&sw)triangles.push([nw,ne,sw]);
  if(ne&&se&&sw)triangles.push([ne,se,sw]);
  return triangles;
}
type Node = {x:number;y:number};
type TriangleIndices = [number,number,number];
function inCircumcircle(point: Node, triangle: TriangleIndices, nodes: Node[]): boolean {
  const [a,b,c]=triangle.map(index=>({x:nodes[index].x-point.x,y:nodes[index].y-point.y}));
  const det=(a.x*a.x+a.y*a.y)*(b.x*c.y-b.y*c.x)-(b.x*b.x+b.y*b.y)*(a.x*c.y-a.y*c.x)+(c.x*c.x+c.y*c.y)*(a.x*b.y-a.y*b.x);
  return det>=-1e-12;
}
function buildTIN(points: TerrainPoint[]): TerrainTriangle[] {
  if(points.length<3)return[];
  const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y),box=extent(sorted),span=Math.max(box.maxX-box.minX,box.maxY-box.minY);
  const nodes:Node[]=sorted.map(point=>({x:(point.x-box.minX)/span,y:(point.y-box.minY)/span}));
  const count=nodes.length;nodes.push({x:-32,y:-16},{x:32,y:-16},{x:0,y:32});
  let triangles:TriangleIndices[]=[[count,count+1,count+2]];
  for(let index=0;index<count;index++){
    const bad=new Set<TriangleIndices>(),edges=new Map<string,{a:number;b:number;count:number}>();
    for(const triangle of triangles)if(inCircumcircle(nodes[index],triangle,nodes)){
      bad.add(triangle);
      for(let edge=0;edge<3;edge++){const a=triangle[edge],b=triangle[(edge+1)%3],key=[a,b].sort((x,y)=>x-y).join(':');const old=edges.get(key);if(old)old.count++;else edges.set(key,{a,b,count:1});}
    }
    if(!bad.size)throw new RangeError('地形三角网无法可靠构建，请核对极近的测点或坐标精度。');
    triangles=triangles.filter(triangle=>!bad.has(triangle));
    for(const edge of edges.values())if(edge.count===1){
      const area=cross(nodes[edge.a],nodes[edge.b],nodes[index]);
      if(Math.abs(area)<=1e-14)continue;
      triangles.push(area>0?[edge.a,edge.b,index]:[edge.b,edge.a,index]);
    }
  }
  const result=triangles.filter(triangle=>triangle.every(index=>index<count)).map(([a,b,c]):TerrainTriangle=>[sorted[a],sorted[b],sorted[c]]);
  if(!result.length)throw new RangeError('地形三角网为空，请提供非共线测点。');
  return result;
}
export function compileTerrain(model: TerrainModel | undefined | null): TerrainMesh {
  if(!model)return{triangles:[],bounds:null,area:0};
  validateTerrain(model);
  const signature=JSON.stringify(model.raster??model.points.map(({id,x,y,z})=>[id,x,y,z]));
  const existing=cache.get(model);if(existing?.signature===signature)return existing.mesh;
  const triangles:TerrainTriangle[]=[];
  if(model.raster){for(let row=0;row<model.raster.nrows-1;row++)for(let col=0;col<model.raster.ncols-1;col++)triangles.push(...rasterCellTriangles(model.raster,row,col));}
  else triangles.push(...buildTIN(model.points));
  const mesh={triangles,bounds:model.raster?terrainRasterBounds(model.raster):model.points.length?extent(model.points):null,area:triangles.reduce((sum,[a,b,c])=>sum+triangleArea(a,b,c),0)};
  cache.set(model,{signature,mesh});return mesh;
}
export function triangulateTerrain(model: TerrainModel | undefined | null): TerrainTriangle[] {return compileTerrain(model).triangles;}
/** Barycentric weights use local differences, retaining precision for survey
 * eastings without translating absolute elevations into fabricated values. */
export function triangleElevation(triangle: TerrainTriangle, x: number, y: number): number {
  const [a,b,c]=triangle,denominator=cross(a,b,c),point={x,y};
  const bWeight=cross(a,point,c)/denominator,cWeight=cross(a,b,point)/denominator;
  return a.z+bWeight*(b.z-a.z)+cWeight*(c.z-a.z);
}
export function terrainElevation(model: TerrainModel | undefined | null, x: number, y: number, mesh?: TerrainMesh): number|null {
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new RangeError('地形查询位置必须是有效米制坐标。');
  let triangles:TerrainTriangle[];
  if(model?.raster){
    // A query inspects at most four cells, even on a shared sample boundary.
    // No mesh compilation, JSON signature or full value scan is needed here.
    const raster=model.raster;validateRasterShape(raster);
    let u=(x-raster.originX)/raster.cellSize-.5,v=(y-raster.originY)/raster.cellSize-.5;
    if(u<-1e-10||v<-1e-10||u>raster.ncols-1+1e-10||v>raster.nrows-1+1e-10)return null;
    if(Math.abs(u-Math.round(u))<1e-10)u=Math.round(u);
    if(Math.abs(v-Math.round(v))<1e-10)v=Math.round(v);
    const col=Math.min(raster.ncols-2,Math.max(0,Math.floor(u))),row=Math.min(raster.nrows-2,Math.max(0,Math.floor(v)));
    const cols=new Set([col]),rows=new Set([row]);
    if(Math.abs(u-Math.round(u))<1e-10&&col>0)cols.add(col-1);
    if(Math.abs(v-Math.round(v))<1e-10&&row>0)rows.add(row-1);
    triangles=[];for(const r of rows)for(const c of cols)triangles.push(...rasterCellTriangles(raster,r,c));
  }else triangles=(mesh??compileTerrain(model)).triangles;
  for(const triangle of triangles){
    const [a,b,c]=triangle,p={x,y},eps=Math.max(1e-12,Math.abs(cross(a,b,c))*Number.EPSILON*64);
    if(cross(a,b,p)>=-eps&&cross(b,c,p)>=-eps&&cross(c,a,p)>=-eps)return triangleElevation(triangle,x,y);
  }
  return null;
}
export function terrainStats(model: TerrainModel | undefined | null) {
  const mesh=compileTerrain(model),raster=model?.raster,heights=raster?raster.values.filter((value):value is number=>value!==null):(model?.points??[]).map(point=>point.z);
  return {sourceType:raster?'dem' as const:'tin' as const,pointCount:heights.length,gridCells:raster?raster.values.length:0,noDataCount:raster?raster.values.length-heights.length:0,fullRasterArea:raster?raster.ncols*raster.nrows*raster.cellSize**2:0,triangleCount:mesh.triangles.length,area:mesh.area,bounds:mesh.bounds,minElevation:heights.length?Math.min(...heights):null,maxElevation:heights.length?Math.max(...heights):null,status:mesh.triangles.length?'ready' as const:'incomplete' as const};
}
type XY = {x:number;y:number};
function clipTriangle(subject: XY[], triangle: TerrainTriangle): XY[] {
  let polygon=subject;
  const oriented=cross(triangle[0],triangle[1],triangle[2])>0?triangle:[triangle[0],triangle[2],triangle[1]];
  for(let i=0;i<3&&polygon.length;i++){
    const a=oriented[i],b=oriented[(i+1)%3],next:XY[]=[],eps=Math.max(1e-12,(Math.abs(b.x-a.x)+Math.abs(b.y-a.y))**2*Number.EPSILON*32);
    for(let j=0;j<polygon.length;j++){
      const p=polygon[j],q=polygon[(j+1)%polygon.length],dp=cross(a,b,p),dq=cross(a,b,q),insideP=dp>=-eps,insideQ=dq>=-eps;
      if(insideP)next.push(p);
      if(insideP!==insideQ){const t=dp/(dp-dq);next.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}
    }
    polygon=next;
  }
  return polygon;
}
type DifferenceVertex = XY & {difference:number};
function clipDifference(points:DifferenceVertex[],sign:1|-1):DifferenceVertex[]{
  const result:DifferenceVertex[]=[];
  for(let i=0;i<points.length;i++){
    const p=points[i],q=points[(i+1)%points.length],insideP=p.difference*sign>=0,insideQ=q.difference*sign>=0;
    if(insideP)result.push(p);
    if(insideP!==insideQ){const t=p.difference/(p.difference-q.difference);result.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,difference:0});}
  }
  return result;
}
const ringArea=(points:XY[])=>{let result=0;for(let i=1;i<points.length-1;i++)result+=Math.abs(cross(points[0],points[i],points[i+1]))/2;return result;};
function integrateDifference(points:DifferenceVertex[],sign:1|-1):number{
  let volume=0;
  for(let i=1;i<points.length-1;i++)volume+=Math.abs(cross(points[0],points[i],points[i+1]))/2*(points[0].difference+points[i].difference+points[i+1].difference)/3*sign;
  return Math.max(0,volume);
}
/** Design triangles must describe a nonoverlapping piecewise planar footprint.
 * True triangle intersections are split at the zero cut/fill contour before
 * integrating their affine elevation differences. Missing terrain is reported. */
export function calculateTerrainEarthworks(model:TerrainModel|undefined|null,designTriangles:TerrainTriangle[]):TerrainEarthworks{
  if(!Array.isArray(designTriangles)||designTriangles.length>12000)throw new RangeError('设计面三角形数量不正确。');
  for(const triangle of designTriangles)if(!Array.isArray(triangle)||triangle.length!==3||triangle.some(point=>![point?.x,point?.y,point?.z].every(Number.isFinite))||triangleArea(...triangle)<=1e-14)throw new RangeError('设计面必须由有效的非退化 XYZ 三角形组成。');
  const designs=designTriangles.map(triangle=>({triangle,box:extent(triangle)})).sort((a,b)=>a.box.minX-b.box.minX);
  for(let i=0;i<designs.length;i++)for(let j=i+1;j<designs.length&&designs[j].box.minX<designs[i].box.maxX;j++){
    const a=designs[i],b=designs[j];if(a.box.maxY<=b.box.minY||a.box.minY>=b.box.maxY)continue;
    const intersection=clipTriangle(a.triangle,b.triangle),tolerance=Math.max(1e-10,Math.min(triangleArea(...a.triangle),triangleArea(...b.triangle))*1e-10);
    if(intersection.length>=3&&ringArea(intersection)>tolerance)throw new RangeError('设计面三角形重复覆盖，不能重复计算挖填量。');
  }
  const mesh=compileTerrain(model),designArea=designTriangles.reduce((sum,triangle)=>sum+triangleArea(...triangle),0);
  const raster=model?.raster;
  const grounds=raster?[]:mesh.triangles.map(triangle=>({triangle,box:extent(triangle)})).sort((a,b)=>a.box.minX-b.box.minX);
  let cutVolume=0,fillVolume=0,coveredArea=0;
  for(const design of designTriangles){
    const box=extent(design);
    let candidates=grounds;
    if(raster){
      // Locate only neighbour cells intersecting this design bbox. Large DEMs
      // do not force every narrow road triangle to scan the entire mesh.
      const colMin=Math.max(0,Math.floor((box.minX-raster.originX)/raster.cellSize-.5)),colMax=Math.min(raster.ncols-2,Math.floor((box.maxX-raster.originX)/raster.cellSize-.5));
      const rowMin=Math.max(0,Math.floor((box.minY-raster.originY)/raster.cellSize-.5)),rowMax=Math.min(raster.nrows-2,Math.floor((box.maxY-raster.originY)/raster.cellSize-.5));
      candidates=[];for(let row=rowMin;row<=rowMax;row++)for(let col=colMin;col<=colMax;col++)for(const triangle of rasterCellTriangles(raster,row,col))candidates.push({triangle,box:extent(triangle)});
    }
    for(const {triangle:ground,box:groundBox} of candidates){
      if(groundBox.minX>box.maxX){if(!raster)break;continue;}
      if(box.minX>groundBox.maxX||box.maxY<groundBox.minY||box.minY>groundBox.maxY)continue;
      const intersection=clipTriangle(design,ground);if(intersection.length<3)continue;
      const area=ringArea(intersection);if(area<=1e-14)continue;coveredArea+=area;
      const difference=intersection.map(point=>({...point,difference:triangleElevation(design,point.x,point.y)-triangleElevation(ground,point.x,point.y)}));
      fillVolume+=integrateDifference(clipDifference(difference,1),1);
      cutVolume+=integrateDifference(clipDifference(difference,-1),-1);
    }
  }
  if(coveredArea>designArea+Math.max(1e-8,designArea*1e-9))throw new RangeError('地形覆盖计算出现重复，请核对设计面三角形。');
  coveredArea=Math.min(designArea,coveredArea);
  const uncoveredArea=Math.max(0,designArea-coveredArea),status=coveredArea<=1e-12?'uncovered':uncoveredArea<=Math.max(1e-8,designArea*1e-9)?'complete':'partial';
  return{cutVolume,fillVolume,coveredArea,uncoveredArea,designArea,status};
}
export const integrateEarthworks=calculateTerrainEarthworks;

function csvRows(text:string):string[][]{
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()&&!line.trim().startsWith('#'));
  if(!lines.length)throw new RangeError('测点文件为空。');
  const first=lines[0],separator=first.includes(',')?',':first.includes(';')?';':first.includes('\t')?'\t':null;
  if(!separator)return lines.map(line=>line.trim().split(/\s+/));
  return lines.map(line=>{const cells:string[]=[],chars=[...line];let cell='',quoted=false;for(let i=0;i<chars.length;i++){const char=chars[i];if(char==='"'){if(quoted&&chars[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===separator&&!quoted){cells.push(cell.trim());cell='';}else cell+=char;}if(quoted)throw new RangeError('CSV 引号未闭合。');cells.push(cell.trim());return cells;});
}
export function parseTerrainCSV(text:string):TerrainPoint[]{
  if(typeof text!=='string'||text.length>2_000_000)throw new RangeError('测点 CSV 文件应小于 2 MB。');
  const rows=csvRows(text),normalize=(value:string)=>value.toLowerCase().replace(/\s/g,'').replace(/[（(](?:m|米)[)）]/g,'');
  const headers=rows[0].map(normalize),names={x:['x','东坐标','横坐标','easting'],y:['y','北坐标','纵坐标','northing'],z:['z','高程','标高','elevation'],id:['id','编号','点号','点名','name']};
  const header=rows[0].some(cell=>!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(cell));
  const column=(key:keyof typeof names)=>headers.findIndex(value=>names[key].includes(value));
  const indexes=header?{x:column('x'),y:column('y'),z:column('z'),id:column('id')}:{x:0,y:1,z:2,id:-1};
  if([indexes.x,indexes.y,indexes.z].some(index=>index<0))throw new RangeError('CSV 需要 X、Y、Z 三列，单位为 m；支持 x,y,z 或点号,x,y,z 表头。');
  const body=header?rows.slice(1):rows;
  if(body.length<3)throw new RangeError('导入至少需要 3 个非共线真实测点。');
  const points=body.map((row,index)=>{
    if(!header&&row.length!==3||row.length!==rows[0].length)throw new RangeError(`CSV 第 ${index+(header?2:1)} 行列数不一致。`);
    const value=(axis:'x'|'y'|'z')=>{const raw=row[indexes[axis]];if(!raw?.trim()||!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(raw))throw new RangeError(`CSV 第 ${index+(header?2:1)} 行 ${axis.toUpperCase()} 不是有效米制数字。`);return Number(raw);};
    return{id:indexes.id>=0?row[indexes.id]||`terrain-${index+1}`:`terrain-${index+1}`,x:value('x'),y:value('y'),z:value('z')};
  });
  validatePoints(points);compileTerrain({name:'导入地形',visible:true,points});return points;
}

/** Strict ESRI ASCII Grid ingestion; rows remain north-to-south. ASC contains
 * no CRS declaration: callers must confirm local metre coordinates themselves. */
export function parseTerrainASCIIGrid(text:string):TerrainRaster{
  if(typeof text!=='string'||text.length>2_000_000)throw new RangeError('DEM ASCII Grid 文件应小于 2 MB。');
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(!lines.length)throw new RangeError('DEM 文件为空。');
  const headers=new Map<string,number>(),headerKeys=new Set(['ncols','nrows','xllcorner','yllcorner','xllcenter','yllcenter','cellsize','nodata_value']);
  const numeric=/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
  let firstData=0;
  for(;firstData<lines.length;firstData++){
    const cells=lines[firstData].split(/\s+/),key=cells[0].toLowerCase();
    if(!headerKeys.has(key)){if(!numeric.test(cells[0]))throw new RangeError(`DEM 不支持的头字段：${cells[0]}。`);break;}
    if(cells.length!==2||!numeric.test(cells[1])||!Number.isFinite(Number(cells[1])))throw new RangeError(`DEM 头字段 ${key} 必须有一个有限数值。`);
    if(headers.has(key))throw new RangeError(`DEM 头字段 ${key} 重复。`);
    headers.set(key,Number(cells[1]));
  }
  for(const key of ['ncols','nrows','cellsize'])if(!headers.has(key))throw new RangeError(`DEM 缺少头字段 ${key}。`);
  if(headers.has('xllcorner')===headers.has('xllcenter')||headers.has('yllcorner')===headers.has('yllcenter'))throw new RangeError('DEM 每个坐标轴需要且只能使用一种 corner 或 center 头字段。');
  const ncols=headers.get('ncols'),nrows=headers.get('nrows'),cellSize=headers.get('cellsize');
  const xllcorner=headers.has('xllcorner')?headers.get('xllcorner'):headers.get('xllcenter')-cellSize/2,yllcorner=headers.has('yllcorner')?headers.get('yllcorner'):headers.get('yllcenter')-cellSize/2;
  const raster:TerrainRaster={format:'esri-ascii',ncols,nrows,xllcorner,yllcorner,cellSize,noDataValue:headers.get('nodata_value')??null,values:[],coordinateUnit:'m',yDirection:'north-up',originX:xllcorner,originY:-(yllcorner+nrows*cellSize)||0};
  // Check dimensions before allocating or interpreting all input values.
  if(!Number.isInteger(ncols)||!Number.isInteger(nrows)||ncols<2||nrows<2||ncols*nrows>MAX_TERRAIN_RASTER_CELLS)throw new RangeError(`DEM 至少需要 2×2 像元，最多 ${MAX_TERRAIN_RASTER_CELLS} 个像元。`);
  if(lines.length-firstData!==nrows)throw new RangeError(`DEM 需要 ${nrows} 行高程，实际为 ${lines.length-firstData} 行。`);
  for(let row=0;row<nrows;row++){
    const cells=lines[firstData+row].split(/\s+/);
    if(cells.length!==ncols)throw new RangeError(`DEM 第 ${row+1} 行需要 ${ncols} 个高程，实际为 ${cells.length} 个。`);
    for(const raw of cells){if(!numeric.test(raw)||!Number.isFinite(Number(raw)))throw new RangeError(`DEM 第 ${row+1} 行包含无效高程。`);const value=Number(raw);raster.values.push(raster.noDataValue!==null&&value===raster.noDataValue?null:value);}
  }
  validateRaster(raster);return raster;
}
export const parseTerrainASC=parseTerrainASCIIGrid;
