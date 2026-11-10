import type { FurnitureKind } from '../types.js';
import { isStairKind } from './stairs.js';
import { fixtureFurnitureForm } from './furniture-fixtures.js';

export type FurnitureBoxPart = { x: number; z: number; bottom: number; top: number; width: number; depth: number; color: string };
export type FurnitureEllipsePart = { x: number; y: number; z: number; radiusX: number; radiusOther: number; axis: 'y' | 'z'; color: string; facing?: 1 | -1 };
export type FurnitureCylinderPart = { x: number; y: number; z: number; radiusA: number; radiusB: number; axis: 'x' | 'y' | 'z'; length: number; color: string };
export type FurnitureForm = { boxes: FurnitureBoxPart[]; ellipses: FurnitureEllipsePart[]; cylinders?: FurnitureCylinderPart[] };

/** Original normalized product forms. Every part stays within the requested
 * width/depth/height, and no procurement quantity creates extra instances. */
export function catalogFurnitureForm(kind: FurnitureKind, heightCm: number): FurnitureForm | null {
  const fixture = fixtureFurnitureForm(kind);
  if (fixture) return fixture;
  // Stair treads and railings use the shared layout in stairs.ts; do not
  // maintain a second box-only model that can disagree with 2D or apertures.
  if (isStairKind(kind)) return null;
  if (['sofa','bed','table','chair','cabinet','nightstand','wardrobe','custom'].includes(kind)) return null;
  const boxes: FurnitureBoxPart[] = [], ellipses: FurnitureEllipsePart[] = [];
  const wood = '#c5b59c', pale = '#e2e1d6', dark = '#59665f', metal = '#a7b0a8', body = '#d6dad1';
  const box = (x: number, z: number, bottom: number, top: number, width: number, depth: number, color = body) => boxes.push({x,z,bottom,top,width,depth,color});
  const ellipse = (x: number, y: number, z: number, radiusX: number, radiusOther: number, axis: 'y'|'z', color: string) => ellipses.push({x,y,z,radiusX,radiusOther,axis,color});
  const legs = (top: number) => { for (const x of [-.43,.43]) for (const z of [-.43,.43]) box(x,z,0,top,.14,.14,wood); };
  const cabinet = (doors = 2, drawers = false) => {
    box(0,-.005,0,1,1,.99,wood);
    for (let i=0;i<doors;i++) {
      const x = -.5 + (i+.5)/doors;
      box(x,.495,.04,.95,.92/doors,.01,pale);
      if (drawers) for (const y of [.31,.62]) box(x,.497,y,y+.012,.9/doors,.006,metal);
      box(x+.25/doors,.499,.43,.56,.025,.002,dark);
    }
  };
  const screen = (computer = false) => {
    box(computer?-.15:0,-.28,.17,1,computer?.70:1,.1,dark);
    box(computer?-.15:0,-.226,.24,.94,computer?.60:.90,.006,'#aec3bc');
    box(computer?-.15:0,-.28,.02,.24,.08,.13,metal);
    box(computer?-.15:0,0,0,.025,computer?.60:1,1,dark);
    if (computer) { box(.40,.02,0,.88,.20,.88,dark); box(.40,.464,.66,.81,.14,.008,metal); }
  };
  const appliance = (window = true) => {
    box(0,-.005,0,1,1,.99,body); box(0,.496,.83,.99,.98,.008,pale);
    if (window) box(-.05,.497,.14,.75,.76,.006,dark);
    box(.33,.499,.88,.94,.08,.002,dark);
  };
  const basin = (cabinetBody = false) => {
    if (cabinetBody) { cabinet(2); box(0,0,.88,1,1,1,pale); }
    else { box(0,0,0,.68,1,1,pale); }
    const top = cabinetBody ? .993 : .685;
    ellipse(0,top,0,.37,.34,'y','#a9b7b0');
    box(0,-.37,top,1,.045,.045,metal); box(0,-.27,.95,1,.05,.22,metal);
  };
  switch (kind) {
    case 'tv': case 'monitor': screen(); break;
    case 'computer': screen(true); break;
    case 'tvStand': cabinet(3,true); break;
    case 'shoeCabinet': case 'sideboard': case 'kitchenBase': case 'kitchenWall': cabinet(2,kind!=='kitchenWall'); break;
    case 'coffeeTable': case 'desk': case 'bench': case 'countertop': case 'barStool':
      legs(.88); box(0,0,.88,1,1,1,wood);
      if (kind==='desk') box(.32,.1,.27,.88,.32,.74,pale);
      break;
    case 'armchair':
      box(0,0,0,.44,1,1,wood); box(0,0,.44,.64,.8,.80,pale);
      box(0,-.40,.35,1,1,.20,body); for (const x of [-.44,.44]) box(x,0,.35,.86,.12,1,body);
      break;
    case 'bookcase':
      box(0,-.47,0,1,1,.06,wood); for (const x of [-.47,.47]) box(x,0,0,1,.06,1,wood);
      for (const y of [0,.245,.49,.735,.97]) box(0,0,y,y+.03,1,1,wood);
      for (const [x,y,color] of [[-.23,.03,'#b3c1b4'],[.22,.28,'#cfbda4'],[-.12,.53,'#b3c1b4'],[.17,.77,'#d5d2c4']] as const) box(x,-.09,y,y+.19,.20,.65,color);
      break;
    case 'officeChair':
      box(0,0,0,.06,1,.12,dark); box(0,0,0,.06,.12,1,dark); box(0,0,.06,.46,.12,.12,metal);
      box(0,.02,.43,.53,.80,.80,body); box(0,-.38,.48,1,.8,.12,dark);
      for(const x of[-.44,.44])box(x,.0,.51,.70,.12,.6,dark); break;
    case 'laptop':
      box(0,0,0,.06,1,1,dark); box(0,-.44,.06,1,1,.12,dark);
      box(0,-.376,.15,.91,.88,.008,'#aec3bc'); box(0,.08,.06,.07,.76,.53,metal); break;
    case 'printer':
      box(0,0,0,.75,1,1,body); box(0,-.13,.75,1,1,.74,pale);
      box(0,.489,.23,.54,.83,.022,dark); box(.25,.46,.64,.71,.23,.07,dark); break;
    case 'kitchenIsland':
      cabinet(3); box(0,0,.94,1,1,1,pale); break;
    case 'sink': case 'basin': basin(); break;
    case 'vanity': basin(true); break;
    case 'cooktop':
      box(0,0,0,.85,1,1,dark);
      for(const x of[-.25,.25])for(const z of[-.21,.21])ellipse(x,.86,z,.16,.20,'y',metal);
      for(const x of[-.3,-.1,.1,.3])box(x,.43,.85,1,.06,.06,metal); break;
    case 'rangeHood':
      box(0,0,0,.24,1,1,metal); box(0,-.22,.24,1,.40,.44,body);
      box(0,.49,.03,.19,.88,.02,dark); break;
    case 'refrigerator':
      cabinet(1); box(0,.497,.29,.307,.97,.006,metal); box(.35,.499,.39,.59,.027,.002,dark); break;
    case 'microwave': case 'oven': case 'dishwasher': appliance(kind!=='dishwasher');
      box(0,.499,.77,.795,.70,.002,metal); break;
    case 'washingMachine': case 'dryer':
      appliance(false); ellipse(0,.45,.498,.33,.28,'z',dark); ellipse(0,.45,.499,.26,.22,'z','#a7bdb5');
      box(-.25,.499,.88,.93,.18,.002,dark); break;
    case 'toilet':
      box(0,-.35,0,1,.80,.30,pale); box(0,.03,0,.49,.66,.60,pale);
      ellipse(0,.50,.07,.50,.43,'y',pale); ellipse(0,.503,.07,.31,.27,'y','#b6c0b8');
      box(0,-.35,.97,1,1,.30,pale); break;
    case 'bathtub':
      box(0,0,0,.92,1,1,pale);
      for(const x of[-.47,.47])box(x,0,.92,1,.06,1,pale);
      for(const z of[-.46,.46])box(0,z,.92,1,1,.08,pale);
      ellipse(0,.925,0,.43,.36,'y','#a9bbb2'); break;
    case 'shower':
      box(0,0,0,.04,1,1,pale);
      for(const x of[-.48,.48])box(x,.47,.04,1,.04,.06,metal);
      box(0,.49,.08,.94,.95,.02,'#bdccc4'); box(-.49,0,.04,.98,.02,1,'#bdccc4');
      box(0,-.46,.20,.89,.035,.035,metal); box(0,-.42,.85,.89,.20,.12,metal); break;
    case 'waterHeater':
      box(0,0,.08,.94,1,1,pale); box(0,-.1,0,.08,.10,.10,metal); box(.20,-.10,0,.08,.10,.10,metal);
      box(0,.493,.35,.64,.40,.014,metal); box(0,0,.94,1,.90,.90,pale); break;
    case 'airConditioner':
      box(0,0,0,1,1,1,pale); box(0,.495,.15,.37,.93,.01,dark);
      for(const y of[.19,.24,.29,.34])box(0,.498,y,y+.015,.92,.004,metal); break;
    case 'floorLamp': case 'bedsideLamp':
      box(0,0,0,.04,1,1,wood); box(0,0,.04,.83,.06,.06,metal);
      box(0,0,.76,1,1,1,pale); break;
    case 'ceilingLight':
      box(0,0,0,.93,1,1,pale); box(0,0,.93,1,.88,.88,metal); break;
    case 'dresser':
      legs(.52); box(0,0,.52,.60,1,1,wood); box(-.28,.03,.08,.52,.44,.84,pale);
      box(0,-.46,.60,1,.70,.08,wood); box(0,-.417,.65,.95,.60,.006,'#b7cac1'); break;
    case 'singleBed':
      box(0,0,0,.38,1,1,wood); box(0,.02,.38,.82,.96,.92,pale);
      box(0,-.47,.20,1,1,.06,wood); box(0,-.29,.82,.95,.80,.23,'#eeece0'); break;
    case 'bunkBed':
      for(const x of[-.46,.46])for(const z of[-.46,.46])box(x,z,0,1,.08,.08,wood);
      for(const y of[.20,.77]){box(0,0,y,y+.06,1,1,wood);box(0,0,y+.06,y+.15,.94,.95,pale);}
      for(const x of[-.47,.47])box(x,0,.92,1,.06,1,wood);
      for(const y of[.1,.25,.40,.55,.70,.85])box(.44,.36,y,y+.025,.12,.22,metal); break;
    default: return null;
  }
  return {boxes,ellipses};
}
