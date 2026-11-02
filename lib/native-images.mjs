// NAS photo preview endpoints already return derivatives. Keep their bytes in a
// bounded cache; webOS JS services cannot load sharp's native addon. The UI also
// releases offscreen images so full poster walls do not stay decoded in memory.
import { ThumbnailCache } from './thumbnail-cache.mjs';
export class NativeThumbnails extends ThumbnailCache {
  constructor(options = {}) { super({ ...options, maxEntries: 96, transform(bytes) {
    const signature = bytes.subarray(0, 4).toString();
    if (bytes[0] !== 0xff && bytes[0] !== 0x89 && signature !== 'RIFF' && !signature.startsWith('GIF')) throw new Error('NAS 返回了无效图片');
    return bytes;
  } }); }
}
