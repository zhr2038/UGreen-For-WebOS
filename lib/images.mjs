import sharp from 'sharp';

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

export class Thumbnails {
  constructor() { this.cache = new Map(); this.pending = new Map(); this.bytes = 0; this.active = 0; this.waiters = []; this.epoch = 0; }
  clear() { this.epoch++; this.cache.clear(); this.pending.clear(); this.bytes = 0; }
  async make(key, kind, load) {
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.generate(key, kind, load);
    this.pending.set(key, job);
    try { return await job; } finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }
  async generate(key, kind, load) {
    const epoch = this.epoch;
    if (this.active >= 2) await new Promise(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      if (epoch !== this.epoch) throw new Error('图片连接已切换');
      const source = await load();
      const result = await sharp(source, { limitInputPixels: 24_000_000 })
        .rotate().resize({ ...imageSizes[kind], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 3 }).toBuffer();
      if (epoch !== this.epoch) throw new Error('图片连接已切换');
      if (this.cache.has(key)) this.bytes -= this.cache.get(key).length;
      this.cache.set(key, result); this.bytes += result.length;
      while (this.cache.size && (this.bytes > 24 * 1024 * 1024 || this.cache.size > 128)) {
        const first = this.cache.keys().next().value; this.bytes -= this.cache.get(first).length; this.cache.delete(first);
      }
      return result;
    } finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
}
