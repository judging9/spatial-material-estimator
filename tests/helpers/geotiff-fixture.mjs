import { deflateSync } from 'node:zlib';

/** Legal TIFF LZW fixture stream uses short literal runs and explicit clears.
 * Production decoder is independently checked against actual GDAL LZW files. */
export function encodeTIFFLiteralLZW(bytes){
  const codes=[];for(let at=0;at<bytes.length;at+=200){codes.push(256);for(const b of bytes.subarray(at,at+200))codes.push(b);}if(!codes.length)codes.push(256);codes.push(257);
  const output=Buffer.alloc(Math.ceil(codes.length*9/8));let bit=0;for(const code of codes)for(let shift=8;shift>=0;shift--,bit++)if(code>>shift&1)output[bit>>3]|=1<<(7-(bit&7));return output;
}

/** Standards-shaped binary fixtures: source X/Y are map east/north coordinates.
 * Production code never imports this generator or substitutes these samples. */
export function createGeoTIFF(options={}){
  const {rows=[[0,1],[2,3]],littleEndian=true,bits=32,sampleFormat=3,compression=1,predictor=1,storage='strips',cellSize=10,originX=0,originY=0,noData=null,pixelIsPoint=false}=options;
  const width=rows[0].length,height=rows.length,bps=bits/8,blockWidth=storage==='tiles'?(options.blockWidth??2):width,blockHeight=options.blockHeight??(storage==='tiles'?2:height),nx=storage==='tiles'?Math.ceil(width/blockWidth):1,ny=Math.ceil(height/blockHeight),blocks=[];
  const numberBuffer=(type,values)=>{const size={1:1,3:2,4:4,12:8}[type],buffer=Buffer.alloc(values.length*size);values.forEach((v,i)=>{if(type===1)buffer.writeUInt8(v,i);else if(type===3)littleEndian?buffer.writeUInt16LE(v,i*2):buffer.writeUInt16BE(v,i*2);else if(type===4)littleEndian?buffer.writeUInt32LE(v,i*4):buffer.writeUInt32BE(v,i*4);else littleEndian?buffer.writeDoubleLE(v,i*8):buffer.writeDoubleBE(v,i*8);});return buffer;};
  for(let br=0;br<ny;br++)for(let bc=0;bc<nx;bc++){
    const h=storage==='tiles'?blockHeight:Math.min(blockHeight,height-br*blockHeight),buffer=Buffer.alloc(blockWidth*h*bps);
    for(let r=0;r<h;r++){let prior=0;for(let c=0;c<blockWidth;c++){
      const raw=rows[br*blockHeight+r]?.[bc*blockWidth+c]??0,at=(r*blockWidth+c)*bps;
      if(sampleFormat===3){if(bits===32)littleEndian?buffer.writeFloatLE(raw,at):buffer.writeFloatBE(raw,at);else littleEndian?buffer.writeDoubleLE(raw,at):buffer.writeDoubleBE(raw,at);}
      else{const modulus=2**bits,unsigned=((raw%modulus)+modulus)%modulus,value=predictor===2?(unsigned-prior+modulus)%modulus:unsigned;prior=unsigned;
        if(bits===8)buffer.writeUInt8(value,at);else if(bits===16)littleEndian?buffer.writeUInt16LE(value,at):buffer.writeUInt16BE(value,at);else littleEndian?buffer.writeUInt32LE(value,at):buffer.writeUInt32BE(value,at);
      }
    }}
    let predicted=buffer;
    if(predictor===3){predicted=Buffer.alloc(buffer.length);for(let r=0;r<h;r++){const base=r*blockWidth*bps;for(let plane=0;plane<bps;plane++)for(let c=0;c<blockWidth;c++)predicted[base+plane*blockWidth+c]=buffer[base+c*bps+(littleEndian?bps-1-plane:plane)];for(let i=blockWidth*bps-1;i>0;i--)predicted[base+i]=(predicted[base+i]-predicted[base+i-1]+256)%256;}}
    blocks.push(compression===1?predicted:compression===5?encodeTIFFLiteralLZW(predicted):deflateSync(predicted));
  }
  const tags=[],add=(id,type,values)=>{const data=typeof values==='string'?Buffer.from(values+'\0'):numberBuffer(type,values);tags.push({id,type,count:typeof values==='string'?data.length:values.length,data});};
  add(256,4,[width]);add(257,4,[height]);add(258,3,[bits]);add(259,3,[compression]);add(262,3,[1]);add(274,3,[1]);add(277,3,[1]);add(284,3,[1]);add(317,3,[predictor]);add(339,3,[sampleFormat]);
  const offsetTag=storage==='tiles'?324:273,countTag=storage==='tiles'?325:279;
  if(storage==='tiles'){add(322,4,[blockWidth]);add(323,4,[blockHeight]);}else add(278,4,[blockHeight]);
  add(offsetTag,4,Array(blocks.length).fill(0));add(countTag,4,blocks.map(block=>block.length));
  add(33550,12,[cellSize,options.cellSizeY??cellSize,0]);
  add(33922,12,options.tiepoints??[0,0,0,originX,originY,0]);
  const geoKeys=options.geoKeys??[[1024,1],[1025,pixelIsPoint?2:1],[3072,3857],[3076,9001]];
  if(geoKeys.length)add(34735,3,[1,1,0,geoKeys.length,...geoKeys.flatMap(([key,value])=>[key,0,1,value])]);
  if(options.geoAscii!==undefined)add(34737,2,options.geoAscii);
  if(noData!==null)add(42113,2,String(noData));
  const items=[];if(options.bandScale!==undefined)items.push(`<Item name="scale" sample="0" role="scale">${options.bandScale}</Item>`);if(options.bandOffset!==undefined)items.push(`<Item name="offset" sample="0" role="offset">${options.bandOffset}</Item>`);if(options.unit!==undefined)items.push(`<Item name="unit" sample="0" role="unittype">${options.unit}</Item>`);if(items.length)add(42112,2,`<GDALMetadata>${items.join('')}</GDALMetadata>`);
  if(options.extraTags)for(const [id,type,values]of options.extraTags)add(id,type,values);
  tags.sort((a,b)=>a.id-b.id);const directoryBytes=2+tags.length*12+4,metadataStart=8+directoryBytes;let end=metadataStart;
  for(const tag of tags)if(tag.data.length>4){tag.offset=end;end+=tag.data.length;if(end%2)end++;}
  const dataStart=end;let blockAt=dataStart;const offsets=blocks.map(block=>{const value=blockAt;blockAt+=block.length;return value;});tags.find(tag=>tag.id===offsetTag).data=numberBuffer(4,offsets);
  const output=Buffer.alloc(blockAt);output.write(littleEndian?'II':'MM',0,'ascii');const u16=(value,at)=>littleEndian?output.writeUInt16LE(value,at):output.writeUInt16BE(value,at),u32=(value,at)=>littleEndian?output.writeUInt32LE(value,at):output.writeUInt32BE(value,at);
  u16(42,2);u32(8,4);u16(tags.length,8);
  tags.forEach((tag,i)=>{const at=10+i*12;u16(tag.id,at);u16(tag.type,at+2);u32(tag.count,at+4);if(tag.data.length<=4)tag.data.copy(output,at+8);else{u32(tag.offset,at+8);tag.data.copy(output,tag.offset);}});
  let at=dataStart;for(const block of blocks){block.copy(output,at);at+=block.length;}return output;
}

/** Binary mutation helper for rejection cases; handles classic inline tags. */
export function setGeoTIFFTag(buffer,id,value){
  const output=Buffer.from(buffer),little=output[0]===73,read16=p=>little?output.readUInt16LE(p):output.readUInt16BE(p),read32=p=>little?output.readUInt32LE(p):output.readUInt32BE(p),ifd=read32(4);
  for(let i=0;i<read16(ifd);i++){const at=ifd+2+i*12;if(read16(at)!==id)continue;const type=read16(at+2),count=read32(at+4);if(count!==1)throw new Error('Mutation requires scalar tag');if(type===3)little?output.writeUInt16LE(value,at+8):output.writeUInt16BE(value,at+8);else if(type===4)little?output.writeUInt32LE(value,at+8):output.writeUInt32BE(value,at+8);else throw new Error('Unsupported scalar mutation');return output;}throw new Error('Tag not found '+id);
}
