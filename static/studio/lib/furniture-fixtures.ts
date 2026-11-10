import type { FurnitureKind } from '../types.js';
import type { FurnitureBoxPart, FurnitureCylinderPart, FurnitureEllipsePart, FurnitureForm } from './furniture-forms.js';
import { isFixtureKind } from './fixtures.js';

/** Original hardware shapes, normalized to user width / depth / height.
 * A panel faces local +z. All pieces stay inside the actual footprint.
 * Dark inlays depict recessed sockets, not electrical engineering cut-outs. */
export function fixtureFurnitureForm(kind: FurnitureKind): FurnitureForm | null {
  if (!isFixtureKind(kind)) return null;
  const boxes: FurnitureBoxPart[] = [], ellipses: FurnitureEllipsePart[] = [], cylinders: FurnitureCylinderPart[] = [];
  const white = '#e6e8e2', rim = '#c9d0c8', metal = '#a1ada6', dark = '#45554d', screen = '#718f85', glow = '#f4efd8';
  const box = (x: number, z: number, bottom: number, top: number, width: number, depth: number, color = white) => boxes.push({ x, z, bottom, top, width, depth, color });
  const cylinder = (x: number, y: number, z: number, radiusA: number, radiusB: number, length: number, axis: 'x'|'y'|'z', color = white) => cylinders.push({x,y,z,radiusA,radiusB,length,axis,color});
  const disc = (x: number, y: number, z: number, radiusX: number, radiusOther: number, axis: 'y'|'z', color: string, facing: 1|-1 = 1) => ellipses.push({x,y,z,radiusX,radiusOther,axis,color,facing});
  const front = (x: number, y: number, width: number, height: number, color = dark) => box(x,.499,y-height/2,y+height/2,width,.002,color);
  const panel = (bodyColor = white) => {
    box(0,-.025,0,1,1,.95,bodyColor);
    box(0,.469,.07,.93,.86,.04,rim);
    box(0,.488,.09,.91,.82,.014,white);
  };
  const fiveHoles = (yShift = 0, size = 1) => {
    for (const x of [-.16,.16]) front(x*size,.69+yShift,.052*size,.13*size);
    front(0,.41+yShift,.055*size,.12*size);
    for (const x of [-.17,.17]) front(x*size,.27+yShift,.07*size,.11*size);
  };
  const slats = (count: number, bottom: number, top: number) => {
    for (let i=0;i<count;i++) front(0,bottom+(top-bottom)*(i+.5)/count,.76,(top-bottom)/count*.37);
  };
  switch(kind) {
    case 'socketFive': panel(); fiveHoles(); break;
    case 'socketUsb':
      panel(); fiveHoles(.08,.75); front(-.15,.19,.19,.055); front(.15,.19,.14,.045);
      front(-.15,.19,.135,.022,metal); front(.15,.19,.09,.016,metal); break;
    case 'socketAirConditioner':
      panel(); front(0,.66,.065,.17); front(-.20,.39,.085,.15); front(.20,.39,.085,.15); front(0,.18,.23,.025,metal); break;
    case 'socketWaterproof':
      panel(rim); fiveHoles(-.02,.9); box(0,.33,.87,1,.90,.32,metal);
      for(const x of[-.45,.45])box(x,.29,.08,.9,.08,.40,rim);
      box(0,.34,.01,.09,.90,.30,rim); break;
    case 'socketFloor':
      box(0,0,0,.40,1,1,metal); box(0,0,.40,.77,.91,.91,rim); box(0,0,.77,1,.83,.83,white);
      for(const x of[-.15,.15])box(x,-.19,.99,1,.045,.14,dark);
      box(0,.09,.99,1,.05,.13,dark);for(const x of[-.18,.18])box(x,.24,.99,1,.065,.12,dark);
      box(0,.415,.79,1,.32,.025,metal); break;
    case 'powerPlug':
      cylinder(0,.62,0,.5,.5,.76,'y',white); box(0,0,.99,1,.16,.22,rim);
      for(const x of[-.22,.22])box(x,.08,0,.30,.10,.13,metal);
      box(0,-.21,0,.34,.11,.13,metal); box(0,.465,.4,.67,.34,.07,rim); break;
    case 'switchSingle': case 'switchDouble': case 'switchTriple': case 'switchTwoWay': {
      panel(); const count = kind==='switchDouble'?2:kind==='switchTriple'?3:1;
      for(let i=0;i<count;i++){
        const x = -.36+(i+.5)*.72/count;
        box(x,.47,.15,.85,.65/count,.06,'#d6ddd4'); front(x,.21,.13/count,.015,metal);
      }
      if(kind==='switchTwoWay'){front(-.08,.72,.075,.017,screen);front(.08,.62,.075,.017,screen);front(0,.67,.02,.11,screen);}
      break;
    }
    case 'switchDimmer':
      box(0,-.25,0,1,1,.50,white);box(0,.035,.07,.93,.86,.07,rim);box(0,.075,.09,.91,.82,.01,white);
      cylinder(0,.50,.24,.25,.25,.48,'z',white); cylinder(0,.50,.477,.22,.22,.046,'z',rim);
      front(0,.66,.02,.09,screen); front(0,.16,.12,.018,metal); break;
    case 'distributionBox':
      panel(); front(0,.50,.79,.64,dark);
      for(let i=0;i<8;i++){const x=-.31+i*.088;front(x,.53,.07,.32,white);front(x,.59,.042,.09,screen);front(x,.38,.052,.012,metal);}
      box(0,.48,.08,.16,.78,.04,rim); front(.36,.50,.018,.13,metal); break;
    case 'lowVoltageBox':
      panel(); front(0,.61,.71,.40,dark); front(-.19,.61,.23,.25,metal);
      for(const x of[-.02,.08,.18,.28])front(x,.61,.055,.07,screen);
      slats(4,.15,.30); break;
    case 'networkPanel':
      panel(); for(const x of[-.20,.20]){front(x,.53,.25,.23);front(x,.41,.12,.05);for(let i=0;i<6;i++)front(x-.08+i*.032,.58,.012,.05,metal);front(x,.28,.18,.013,metal);} break;
    case 'tvPanel':
      panel(); cylinder(0,.55,.443,.20,.20,.114,'z',metal);disc(0,.55,.501-.001,.135,.135,'z',dark);disc(0,.55,.5,.04,.04,'z',metal);
      front(0,.22,.20,.018,metal);break;
    case 'waterOutletCold': case 'waterOutletHot':
      cylinder(0,.5,-.425,.5,.5,.15,'z',metal);
      cylinder(0,.5,.03,.24,.24,.94,'z',rim);
      disc(0,.5,.5,.18,.18,'z',kind==='waterOutletCold'?'#72999b':'#ad8675');
      disc(0,.5,.5,.10,.10,'z',dark);break;
    case 'floorDrain':
      box(0,0,0,1,1,1,metal);box(0,0,.97,1,.83,.83,dark);
      for(let i=0;i<7;i++)box(-.33+i*.11,0,.99,1,.034,.79,white);
      for(const x of[-.44,.44])for(const z of[-.44,.44])disc(x,1,z,.026,.026,'y',dark);break;
    case 'waterValve':
      cylinder(0,.25,0,.50,.25,1,'x',metal);cylinder(0,.61,0,.10,.13,.40,'y',metal);
      box(0,0,.85,1,.77,.22,screen);box(0,0,.77,.85,.16,.25,metal);break;
    case 'manifold':
      for(const y of[.32,.75])cylinder(0,y,0,.14,.065,1,'x',metal);
      for(let i=0;i<5;i++){
        const x=-.36+i*.18;cylinder(x,.33,0,.032,.09,.66,'y',metal);cylinder(x,.785,0,.033,.09,.43,'y',metal);
        box(x,.365,.69,.85,.075,.27,'#ad8675');box(x,.365,.25,.41,.075,.27,screen);
      }
      for(const x of[-.43,.43])box(x,-.45,.09,.95,.055,.10,rim);break;
    case 'router':
      box(0,0,0,.30,1,1,white);box(0,0,.30,.34,.92,.92,rim);
      for(const x of[-.40,.40])cylinder(x,.63,-.35,.032,.05,.74,'y',dark);
      for(let i=0;i<5;i++){box(-.32+i*.16,-.05,.34,.343,.018,.40,metal);front(-.30+i*.12,.14,.036,.025,screen);}break;
    case 'wirelessAP':
      cylinder(0,.5,0,.5,.5,1,'y',white);cylinder(0,.07,0,.43,.43,.14,'y',rim);
      disc(0,0,0,.37,.37,'y',white,-1);disc(0,0,.22,.035,.035,'y',screen,-1);break;
    case 'downlight':
      cylinder(0,.47,0,.36,.36,.94,'y',metal);cylinder(0,.95,0,.50,.50,.10,'y',white);
      cylinder(0,.05,0,.43,.43,.10,'y',white);disc(0,0,0,.33,.33,'y',dark,-1);disc(0,0,0,.25,.25,'y',glow,-1);break;
    case 'spotlight':
      box(0,-.30,.89,1,1,.40,rim);box(0,-.27,.58,.93,.10,.16,metal);
      cylinder(0,.34,.055,.48,.33,.89,'z',dark);cylinder(0,.34,.455,.50,.34,.09,'z',metal);
      disc(0,.34,.5,.37,.26,'z',glow);break;
    case 'ledStripController':
      box(0,0,0,1,1,1,rim);box(0,0,.96,1,.63,.72,white);
      for(const x of[-.43,.43])for(const z of[-.25,0,.25])box(x,z,.97,1,.08,.095,dark);
      for(let i=0;i<7;i++)box(-.22+i*.075,0,.995,1,.021,.46,metal);break;
    case 'wallLight':
      box(0,-.46,.20,.8,.55,.08,metal);box(0,-.08,.28,.40,.10,.68,metal);
      cylinder(0,.46,.10,.5,.4,.92,'y',white);disc(0,0,.10,.44,.35,'y',glow,-1);box(0,.1,.92,1,.12,.12,rim);break;
    case 'pendantLight':
      cylinder(0,.965,0,.18,.18,.07,'y',metal);cylinder(0,.54,0,.017,.017,.78,'y',dark);
      cylinder(0,.12,0,.50,.50,.24,'y',white);disc(0,0,0,.44,.44,'y',glow,-1);break;
    case 'linearLight':
      box(0,0,0,1,1,1,rim);box(0,0,0,.06,.94,.77,glow);box(0,0,.96,1,.97,.84,white);break;
    case 'radiator':
      for(let i=0;i<12;i++)box(-.46+i*.0836,0,0,1,.077,1,white);
      for(const y of[.13,.84])cylinder(0,y,0,.11,.035,1,'x',metal);
      box(.46,.43,.02,.11,.08,.14,rim);break;
    case 'freshAirVent':
      panel();front(0,.50,.84,.79,dark);
      for(let i=0;i<7;i++)box(0,.48,.16+i*.10,.194+i*.10,.79,.04,rim);break;
    case 'exhaustFan':
      panel();disc(0,.50,.497,.40,.40,'z',dark);
      for(const [x,y,w,h] of[[0,.70,.16,.25],[.20,.50,.25,.16],[0,.30,.16,.25],[-.20,.50,.25,.16]])front(x,y,w,h,metal);
      cylinder(0,.5,.46,.13,.13,.08,'z',white);break;
    case 'thermostat':
      panel();front(0,.61,.66,.35,screen);front(-.12,.63,.12,.16,white);front(.12,.63,.12,.16,white);
      for(const x of[-.23,0,.23])front(x,.24,.10,.043,metal);break;
    case 'smokeDetector':
      cylinder(0,.5,0,.5,.5,1,'y',white);cylinder(0,.07,0,.37,.37,.14,'y',rim);
      for(let i=0;i<12;i++){const a=i*Math.PI/6;disc(Math.cos(a)*.30,0,Math.sin(a)*.30,.032,.032,'y',dark,-1);}
      disc(0,0,0,.09,.09,'y',white,-1);disc(.10,0,.10,.028,.028,'y',screen,-1);break;
    case 'smartPanel':
      panel(dark);front(0,.54,.85,.69,screen);for(const x of[-.27,0,.27])for(const y of[.39,.68])front(x,y,.15,.11,white);
      front(0,.15,.12,.017,metal);break;
    case 'doorbell':
      panel(dark);cylinder(0,.73,.478,.29,.115,.044,'z',metal);disc(0,.73,.5,.20,.08,'z',dark);
      cylinder(0,.29,.48,.27,.105,.04,'z',rim);disc(0,.29,.5,.18,.07,'z',white);
      for(const y of[.45,.48,.51])front(0,y,.46,.009,metal);break;
  }
  return {boxes,ellipses,cylinders};
}
