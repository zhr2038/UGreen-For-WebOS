// NAS photo preview endpoints already return derivatives. Keep their bytes in a
// bounded cache; webOS JS services cannot load sharp's native addon. The UI also
// releases offscreen images so full poster walls do not stay decoded in memory.
export class NativeThumbnails {
  constructor() { this.cache = new Map(); this.pending = new Map(); this.bytes = 0; this.active = 0; this.waiters = []; this.epoch = 0; }
  clear() { this.epoch++; this.cache.clear(); this.pending.clear(); this.bytes = 0; }
  async make(key, kind, load) {
    if (this.cache.has(key)) { const b = this.cache.get(key); this.cache.delete(key); this.cache.set(key, b); return b; }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.generate(key, load); this.pending.set(key, job);
    try { return await job; } finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }
  async generate(key, load) {
    const epoch = this.epoch;
    if (this.active >= 2) await new Promise(resolve => this.waiters.push(resolve)); else this.active++;
    try {
      if (epoch !== this.epoch) throw new Error('图片连接已切换');
      const bytes = await load();
      if (epoch !== this.epoch) throw new Error('图片连接已切换');
      if (bytes.length > 12 * 1024 * 1024) throw new Error('图片预览过大');
      const signature = bytes.subarray(0, 4).toString();
      if (bytes[0] !== 0xff && bytes[0] !== 0x89 && signature !== 'RIFF' && !signature.startsWith('GIF')) throw new Error('NAS 返回了无效图片');
      this.cache.set(key, bytes); this.bytes += bytes.length;
      while (this.bytes > 24 * 1024 * 1024 || this.cache.size > 96) { const k = this.cache.keys().next().value; this.bytes -= this.cache.get(k).length; this.cache.delete(k); }
      return bytes;
    } finally { if (this.waiters.length) this.waiters.shift()(); else this.active--; }
  }
}
