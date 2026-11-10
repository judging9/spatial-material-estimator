import test from 'node:test';
import assert from 'node:assert/strict';
import { createMunicipalElement } from '../static/studio/lib/municipal-design.js';
import { createRoadProfile, roadProfileAnalysis, roadSideSlopeDesign } from '../static/studio/lib/road-profile.js';
import { syncMunicipalEngineering, previewRoadGeometry } from '../static/studio/municipal-engineering.js';
import { municipalTunnelPlanPath } from '../static/studio/municipal-canvas.js';
const fixture=()=>({version:1,id:'tunnel-integrated',name:'测试道路',workspaceMode:'municipal',drawing:{id:'plan',type:'plan',name:'场地',width:20000,height:20000,url:'data:image/png;base64,iVBORw0KGgo='},calibration:{metersPerPixel:.01},municipalElements:[],regions:[],walls:[],additionalCost:'0',taxRate:'0',view:{labels:true,drawingOpacity:1}});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
function project(){const p=fixture(),road=createMunicipalElement('road',[{x:2000,y:4000},{x:12000,y:4000}],p,{width:400,height:10,unitPrice:'0'});road.roadProfile=createRoadProfile(p,road);road.roadProfile.earthwork={enabled:true,cutUnitPrice:'0',fillUnitPrice:'0'};road.tunnel={enabled:true,startStation:20,endStation:80,clearHeight:5,liningThickness:.4,shape:'box',unitPrice:'0',laborRate:'0',additionalCost:'0',pricingEnabled:true};p.municipalElements=[road];p.municipalTerrain={name:'平顶山',visible:true,points:[{id:'a',x:0,y:0,z:50},{id:'b',x:150,y:0,z:50},{id:'c',x:150,y:100,z:50},{id:'d',x:0,y:100,z:50}]};return p;}
test('road open-cut quantity excludes only tunnel chainage and restores when disabled',()=>{
 const p=project(),road=p.municipalElements[0],withTunnel=roadProfileAnalysis(p,road);
 near(withTunnel.earthworks.designArea,160);near(withTunnel.earthworks.cutVolume,8016);assert.equal(withTunnel.earthworks.complete,true);
 road.tunnel.enabled=false;const restored=roadProfileAnalysis(p,road);near(restored.earthworks.designArea,400);near(restored.earthworks.cutVolume,20040);
});
test('full tunnel does not request daylight slopes through the overlying mountain',()=>{
 const p=project(),road=p.municipalElements[0];road.tunnel.startStation=0;road.tunnel.endStation=100;road.roadProfile.sideSlopes={enabled:true,leftCut:1,rightCut:1,leftFill:1,rightFill:1,maxWidth:5,interval:2};
 const slope=roadSideSlopeDesign(p,road);assert.equal(slope.complete,true);assert.equal(slope.sections.length,0);
 const analysis=roadProfileAnalysis(p,road);assert.equal(analysis.earthworks.complete,true);near(analysis.earthworks.cutVolume,0);near(analysis.earthworks.designArea,0);
});
test('committed node changes scale persisted tunnel stations once and keep pricing untouched',()=>{
 const p=project(),next=structuredClone(p);next.municipalElements[0].points[1].x+=10000;syncMunicipalEngineering(next,p);
 const road=next.municipalElements[0];near(road.tunnel.startStation,40);near(road.tunnel.endStation,160);near(road.roadProfile.points.at(-1).station,200);assert.equal(road.tunnel.unitPrice,'0');
 syncMunicipalEngineering(next,next);near(road.tunnel.endStation,160);near(p.municipalElements[0].tunnel.endStation,80);
});
test('flat road tunnel stations also follow route changes without a profile',()=>{
 const p=project();delete p.municipalElements[0].roadProfile;const next=structuredClone(p);next.municipalElements[0].points[1].x=7000;syncMunicipalEngineering(next,p);near(next.municipalElements[0].tunnel.startStation,10);near(next.municipalElements[0].tunnel.endStation,40);
});
test('node preview scales tunnel and profile together without touching entered fees',()=>{
 const p=project(),road=p.municipalElements[0];road.points[1].x=7000;previewRoadGeometry(p,road,100);near(road.tunnel.startStation,10);near(road.tunnel.endStation,40);near(road.roadProfile.points.at(-1).station,50);
});
test('explicit invalid tunnel edit is rejected instead of silently rescaled',()=>{
 const p=project(),next=structuredClone(p);next.municipalElements[0].tunnel.endStation=120;assert.throws(()=>syncMunicipalEngineering(next,p),/超出/);
});
test('2D tunnel path follows exact horizontal stations through a diagonal bend',()=>{
 const p=project(),road=p.municipalElements[0];delete road.roadProfile;road.points=[{x:2000,y:4000},{x:5000,y:8000},{x:10000,y:8000}];road.tunnel.startStation=25;road.tunnel.endStation=75;
 assert.deepEqual(municipalTunnelPlanPath(road,p),[{x:3500,y:6000},{x:5000,y:8000},{x:7500,y:8000}]);
 road.tunnel.enabled=false;assert.deepEqual(municipalTunnelPlanPath(road,p),[]);
});
