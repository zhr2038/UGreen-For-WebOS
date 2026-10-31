import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {decodeHeifRgba,isHeifBytes,readExifOrientation} from '../app-src/heif-core.mjs';
const require=createRequire(import.meta.url);let packageDir,module;
try{packageDir=dirname(require.resolve('libheif-js/package.json'));}catch{packageDir=resolve('.local/heif-review/package');}
let available=true;try{await access(join(packageDir,'libheif-wasm/libheif.js'));}catch(error){if(error.code==='ENOENT')available=false;else throw error;}
if(available)module=await require(join(packageDir,'libheif-wasm/libheif.js'))({wasmBinary:await readFile(join(packageDir,'libheif-wasm/libheif.wasm')),print(){},printErr(){}});
const fixtures=resolve('test/fixtures/heif'),expected=JSON.parse(await readFile(join(fixtures,'expected.json')));
for(const[name,reference]of Object.entries(expected))test('real HEVC decoding: '+name,{skip:!module&&'Install pinned libheif-js 1.23.5 to run real HEVC fixtures'},async()=>{
  const decoded=decodeHeifRgba(module,await readFile(join(fixtures,name)));assert.equal(decoded.sourceWidth,reference.width);assert.equal(decoded.sourceHeight,reference.height);assert.equal(decoded.width,reference.width);assert.equal(decoded.height,reference.height);assert.equal(decoded.orientationApplied,true);assert.equal(decoded.originalDecoded,true);
  const w=decoded.width,h=decoded.height,positions=[[w>>2,h>>2],[Math.floor(w*3/4),h>>2],[w>>2,Math.floor(h*3/4)],[Math.floor(w*3/4),Math.floor(h*3/4)]];
  for(let i=0;i<4;i++){const[x,y]=positions[i],at=(y*w+x)*4;for(let channel=0;channel<3;channel++)assert.ok(Math.abs(decoded.data[at+channel]-reference.colors[i][channel])<24,`wrong color/orientation in quadrant ${i}`);assert.equal(decoded.data[at+3],255);}
  if(name==='geometry-and-exif-6.heic'){assert.equal(decoded.heifGeometryApplied,true);assert.equal(decoded.exifOrientation,1);}else assert.equal(decoded.heifGeometryApplied,false);
});
test('WASM scaling transfers only target RGBA and preserves the true original dimensions',{skip:!module},async()=>{
  const result=decodeHeifRgba(module,await readFile(join(fixtures,'exif-6.heic')),{expectedWidth:96,expectedHeight:64,maxWidth:32,maxHeight:32});assert.equal(result.sourceWidth,64);assert.equal(result.sourceHeight,96);assert.equal(result.width,21);assert.equal(result.height,32);assert.equal(result.data.byteLength,21*32*4);
  assert.throws(()=>decodeHeifRgba(module,Buffer.alloc(16)),{code:'HEIF_INVALID_SOURCE'});assert.throws(()=>decodeHeifRgba(module,Buffer.alloc(32*1024*1024+1)),{code:'HEIF_INVALID_SOURCE'});
});
test('original dimension mismatch fails, never silently substitutes the smaller primary image',{skip:!module},async()=>{
  const bytes=await readFile(join(fixtures,'exif-1.heic'));assert.throws(()=>decodeHeifRgba(module,bytes,{expectedWidth:4032,expectedHeight:3024}),{code:'HEIF_DIMENSIONS_MISMATCH'});assert.throws(()=>decodeHeifRgba(module,bytes,{maxPixels:50000001}),{code:'HEIF_INVALID_OPTIONS'});
});
test('metadata parsing is bounded and malformed EXIF falls back to no extra rotation',()=>{
  assert.equal(readExifOrientation(new Uint8Array()),1);assert.equal(readExifOrientation(new Uint8Array(1024*1024+1)),1);assert.equal(isHeifBytes(new Uint8Array(24)),false);
});

test('a real 12MP original is decoded before downsizing and never copied into full-size JS RGBA',{skip:!module},async()=>{
  const result=decodeHeifRgba(module,await readFile(join(fixtures,'synthetic-12mp.heic')),{expectedWidth:4032,expectedHeight:3024});assert.equal(result.sourceWidth,4032);assert.equal(result.sourceHeight,3024);assert.equal(result.width,2880);assert.equal(result.height,2160);assert.equal(result.data.byteLength,24883200);assert.ok(result.wasmHeapBytes<=256*1024*1024);
});
