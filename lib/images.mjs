import sharp from 'sharp';
import { ThumbnailCache } from './thumbnail-cache.mjs';

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 24 });

// Bound the decoded image sizes delivered to the TV. CSS dimensions alone do
// not prevent full-resolution poster images from consuming decoder memory.
export const imageSizes = {
  poster: { width: 480, height: 720 },
  cover: { width: 720, height: 416 },
  backdrop: { width: 1920, height: 1080 },
  logo: { width: 640, height: 320 },
  photoTile: { width: 640, height: 480 },
  photoView: { width: 1920, height: 1080 },
};

export class Thumbnails extends ThumbnailCache {
  constructor(options = {}) { super({ ...options, maxEntries: 128, transform: (source, kind) => sharp(source, { limitInputPixels: 24_000_000 })
    .rotate().resize({ ...imageSizes[kind], fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 3 }).toBuffer() }); }
}
