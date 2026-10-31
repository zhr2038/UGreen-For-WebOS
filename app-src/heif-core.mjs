/* libheif-js 1.23.5 raw wasm32 C API adapter. No native-image fallback. */
export const HEIF_LIMITS = Object.freeze({maxBytes:32*1024*1024,maxPixels:16_000_000,hardPixels:50_000_000,maxSide:20000,maxWidth:3840,maxHeight:2160,memoryBytes:256*1024*1024});
const fail = (code,message) => Object.assign(new Error(message),{code});
const fourcc = text => [...text].reduce((value,c)=>value*256+c.charCodeAt(0),0);
export function heifDimensions(width,height,maxPixels=HEIF_LIMITS.maxPixels) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>HEIF_LIMITS.maxSide||height>HEIF_LIMITS.maxSide||width*height>maxPixels)throw fail('HEIF_TOO_LARGE','HEIF 原图尺寸超过电视解码上限');
}
export function readExifOrientation(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<14||bytes.length>1024*1024)return 1;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let at=bytes[0]===0x49||bytes[0]===0x4d?0:bytes[0]===0x45&&bytes[1]===0x78?6:view.getUint32(0)+4;
  if(at<0||at+8>bytes.length)return 1;
  const little=bytes[at]===0x49&&bytes[at+1]===0x49;
  if(!little&&!(bytes[at]===0x4d&&bytes[at+1]===0x4d)||view.getUint16(at+2,little)!==42)return 1;
  const first=at+view.getUint32(at+4,little);if(first<at+8||first+2>bytes.length)return 1;
  const count=view.getUint16(first,little);if(count>128||first+2+count*12>bytes.length)return 1;
  for(let i=0;i<count;i++){const entry=first+2+i*12;if(view.getUint16(entry,little)===0x112&&view.getUint16(entry+2,little)===3&&view.getUint32(entry+4,little)===1){const value=view.getUint16(entry+8,little);return value>=1&&value<=8?value:1;}}
  return 1;
}
export function isHeifBytes(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<16||String.fromCharCode(...bytes.subarray(4,8))!=='ftyp')return false;
  const end=Math.min(bytes.length,new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0),128);
  for(let i=8;i+4<=end;i+=4)if(['heic','heix','hevc','hevx','mif1','msf1','heis','hevs'].includes(String.fromCharCode(...bytes.subarray(i,i+4))))return true;
  return false;
}
function rgba(module,image,width,height,orientation,alloc) {
  const stridePtr=alloc(4),plane=module._heif_image_get_plane_readonly2(image,10,stridePtr),stride=module.HEAPU32[stridePtr>>>2];
  const size=stride*height;if(!plane||stride<width*4||!Number.isSafeInteger(size)||plane+size>module.HEAPU8.length)throw fail('HEIF_INVALID_PLANE','HEIF 解码没有返回有效像素');
  const swap=orientation>=5,outWidth=swap?height:width,outHeight=swap?width:height,output=new Uint8ClampedArray(outWidth*outHeight*4),heap=module.HEAPU8;
  if(orientation===1){for(let y=0;y<height;y++)output.set(heap.subarray(plane+y*stride,plane+y*stride+width*4),y*width*4);}
  else for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let dx=x,dy=y;
    if(orientation===2)dx=width-1-x;
    if(orientation===3){dx=width-1-x;dy=height-1-y;}
    if(orientation===4)dy=height-1-y;
    if(orientation===5){dx=y;dy=x;}
    if(orientation===6){dx=height-1-y;dy=x;}
    if(orientation===7){dx=height-1-y;dy=width-1-x;}
    if(orientation===8){dx=y;dy=width-1-x;}
    const from=plane+y*stride+x*4,to=(dy*outWidth+dx)*4;output[to]=heap[from];output[to+1]=heap[from+1];output[to+2]=heap[from+2];output[to+3]=heap[from+3];
  }
  return{data:output,width:outWidth,height:outHeight};
}

/** Decode primary only, scale inside WASM, then copy at most one 4K RGBA plane. */
export function decodeHeifRgba(module,bytes,{maxPixels=HEIF_LIMITS.maxPixels,maxWidth=3840,maxHeight=2160,expectedWidth,expectedHeight,memoryBytes=HEIF_LIMITS.memoryBytes}={}) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>HEIF_LIMITS.maxBytes||!isHeifBytes(bytes))throw fail('HEIF_INVALID_SOURCE','请选择完整的 HEIF/HEIC 原图');
  if(!Number.isSafeInteger(maxPixels)||maxPixels<1||maxPixels>HEIF_LIMITS.hardPixels||!Number.isSafeInteger(memoryBytes)||memoryBytes<64*1024*1024||memoryBytes>512*1024*1024||!Number.isSafeInteger(maxWidth)||!Number.isSafeInteger(maxHeight)||maxWidth<1||maxHeight<1||maxWidth>3840||maxHeight>2160)throw fail('HEIF_INVALID_OPTIONS','HEIF 解码参数无效');
  if(expectedWidth!==undefined||expectedHeight!==undefined)heifDimensions(expectedWidth,expectedHeight,maxPixels);
  if(module?.heif_get_version?.()!=='1.23.5')throw fail('HEIF_LIBRARY_MISMATCH','HEIF 解码库版本不匹配');
  const allocated=[],images=new Set();let context=0,handle=0;
  const alloc=size=>{const ptr=module._malloc(size);if(!ptr)throw fail('HEIF_MEMORY_LIMIT','HEIF 解码内存不足');allocated.push(ptr);return ptr;};
  let error,out;const check=()=>{if(module.HEAP32[error>>>2]!==0)throw fail('HEIF_DECODE_FAILED','HEIF 原图解码失败或超过内存上限');};
  try {
    error=alloc(12);out=alloc(4);
    context=module._heif_context_alloc();if(!context)throw fail('HEIF_MEMORY_LIMIT','HEIF 解码内存不足');
    const limits=module._heif_context_get_security_limits(context);
    if(module.HEAPU8[limits]!==4)throw fail('HEIF_LIBRARY_MISMATCH','HEIF 解码库版本不匹配');
    // Pinned 1.23.5 wasm32 ABI: uint64 fields are 8-byte aligned. Keep all
    // other upstream security limits enabled; never use the disabled struct.
    const set64=(offset,value)=>{module.HEAPU32[(limits+offset)>>>2]=value>>>0;module.HEAPU32[(limits+offset+4)>>>2]=Math.floor(value/4294967296);};
    set64(8,maxPixels);set64(16,256);set64(40,Math.min(memoryBytes,Math.max(64*1024*1024,maxPixels*4+1024*1024)));set64(64,memoryBytes);
    module.HEAPU32[(limits+28)>>>2]=512;module.HEAPU32[(limits+32)>>>2]=4*1024*1024;
    module._heif_context_set_max_decoding_threads(context,0);
    const input=alloc(bytes.length);module.HEAPU8.set(bytes,input);const inputLength=bytes.length;bytes=null;
    module._heif_context_read_from_memory_without_copy(error,context,input,inputLength,0);check();
    module._heif_context_get_primary_image_handle(error,context,out);check();handle=module.HEAPU32[out>>>2];if(!handle||!module._heif_image_handle_is_primary_image(handle))throw fail('HEIF_PRIMARY_MISSING','HEIF 文件没有有效主图');
    const signaledWidth=module._heif_image_handle_get_width(handle),signaledHeight=module._heif_image_handle_get_height(handle),codedWidth=module._heif_image_handle_get_ispe_width(handle),codedHeight=module._heif_image_handle_get_ispe_height(handle);
    heifDimensions(signaledWidth,signaledHeight,maxPixels);heifDimensions(codedWidth,codedHeight,maxPixels);
    if(expectedWidth!==undefined&&!(expectedWidth===signaledWidth&&expectedHeight===signaledHeight||expectedWidth===signaledHeight&&expectedHeight===signaledWidth))throw fail('HEIF_DIMENSIONS_MISMATCH','读取到的文件与原图尺寸不符');
    const item=module._heif_image_handle_get_item_id(handle),propertyCount=module._heif_item_get_transformation_properties(context,item,0,0);
    if(propertyCount<0||propertyCount>64)throw fail('HEIF_INVALID_SOURCE','HEIF 方向属性无效');
    let hasGeometry=false;
    if(propertyCount){const list=alloc(propertyCount*4),count=module._heif_item_get_transformation_properties(context,item,list,propertyCount);for(let i=0;i<count;i++){const type=module._heif_item_get_property_type(context,item,module.HEAPU32[(list>>>2)+i]);if(type===fourcc('irot')||type===fourcc('imir'))hasGeometry=true;}}
    let orientation=1;
    if(!hasGeometry){
      const filter=alloc(5);module.HEAPU8.set([69,120,105,102,0],filter);const count=module._heif_image_handle_get_number_of_metadata_blocks(handle,filter);
      if(count>8)throw fail('HEIF_INVALID_SOURCE','HEIF 元数据超过解码上限');
      if(count>0){const ids=alloc(count*4),actual=module._heif_image_handle_get_list_of_metadata_block_IDs(handle,filter,ids,count);if(actual){const metadataId=module.HEAPU32[ids>>>2],size=module._heif_image_handle_get_metadata_size(handle,metadataId);if(size>1024*1024)throw fail('HEIF_INVALID_SOURCE','HEIF 元数据超过解码上限');if(size){const ptr=alloc(size);module._heif_image_handle_get_metadata(error,handle,metadataId,ptr);check();orientation=readExifOrientation(module.HEAPU8.subarray(ptr,ptr+size));}}}
    }
    module._heif_decode_image(error,handle,out,1,11,0);check();let image=module.HEAPU32[out>>>2];if(!image)throw fail('HEIF_DECODE_FAILED','HEIF 原图解码失败');images.add(image);
    const decodedWidth=module._heif_image_get_width(image,10),decodedHeight=module._heif_image_get_height(image,10);heifDimensions(decodedWidth,decodedHeight,maxPixels);
    if(decodedWidth!==signaledWidth||decodedHeight!==signaledHeight)throw fail('HEIF_DIMENSIONS_MISMATCH','HEIF 真实解码尺寸与文件声明不符');
    const swap=orientation>=5,sourceWidth=swap?decodedHeight:decodedWidth,sourceHeight=swap?decodedWidth:decodedHeight;
    const scale=Math.min(1,maxWidth/sourceWidth,maxHeight/sourceHeight),width=Math.max(1,Math.floor(sourceWidth*scale)),height=Math.max(1,Math.floor(sourceHeight*scale));
    const targetWidth=swap?height:width,targetHeight=swap?width:height;
    if(targetWidth!==decodedWidth||targetHeight!==decodedHeight){module._heif_image_scale_image(error,image,out,targetWidth,targetHeight,0);check();const scaled=module.HEAPU32[out>>>2];if(!scaled)throw fail('HEIF_DECODE_FAILED','HEIF 原图缩放失败');images.add(scaled);module._heif_image_release(image);images.delete(image);image=scaled;}
    const actualWidth=module._heif_image_get_width(image,10),actualHeight=module._heif_image_get_height(image,10);if(actualWidth!==targetWidth||actualHeight!==targetHeight)throw fail('HEIF_INVALID_PLANE','HEIF 缩放像素尺寸无效');
    return{...rgba(module,image,actualWidth,actualHeight,orientation,alloc),sourceWidth,sourceHeight,codedWidth,codedHeight,decodedWidth,decodedHeight,orientationApplied:true,exifOrientation:orientation,heifGeometryApplied:hasGeometry,originalDecoded:true,bitDepth:8,colorSpace:'srgb',hdrPreserved:false,wasmHeapBytes:module.HEAPU8.length,decoder:'libheif-js-1.23.5'};
  } finally {for(const image of images)module._heif_image_release(image);if(handle)module._heif_image_handle_release(handle);if(context)module._heif_context_free(context);for(const ptr of allocated.reverse())module._free(ptr);}
}
