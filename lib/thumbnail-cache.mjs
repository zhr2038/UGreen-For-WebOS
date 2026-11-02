const cancelled = () => Object.assign(new Error('图片读取已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
const changed = () => Object.assign(new Error('图片连接已切换'), { name: 'AbortError', status: 410 });

/** Shared compressed-image cache. A request owns a subscription, not the
 * underlying NAS read: only the last cancellation aborts that read. */
export class ThumbnailCache {
  constructor({ transform, maxEntries = 96, timeoutMs = 20000, concurrency = 2 } = {}) {
    if (typeof transform !== 'function') throw new TypeError('Image transform required');
    this.transform = transform; this.maximum = concurrency === 1 ? 1 : 2;
    this.maxEntries = Math.min(128, Math.max(1, maxEntries)); this.timeoutMs = Math.min(20000, Math.max(1, timeoutMs));
    this.cache = new Map(); this.pending = new Map(); this.running = new Set(); this.queue = [];
    this.bytes = 0; this.active = 0; this.epoch = 0;
  }
  async make(key, kind, load, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    let job = this.pending.get(key);
    if (!job) {
      if (this.pending.size >= 128) throw Object.assign(new Error('图片请求过多，请稍后重试'), { status: 429 });
      job = { key, kind, load, epoch: this.epoch, controller: new AbortController(), consumers: new Set(), started: false };
      this.pending.set(key, job); this.queue.push(job);
    }
    const result = new Promise((resolve, reject) => {
      const consumer = { finish: (error, bytes) => {
        if (!job.consumers.delete(consumer)) return;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(bytes);
      } };
      const abort = () => { consumer.finish(cancelled()); if (!job.consumers.size) this.retire(job, cancelled()); };
      job.consumers.add(consumer); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
    this.pump(); return result;
  }
  retire(job, error) {
    clearTimeout(job.timer);
    if (this.pending.get(job.key) === job) this.pending.delete(job.key);
    const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
    job.controller.abort(error);
    for (const consumer of [...job.consumers]) consumer.finish(error);
  }
  check(job) {
    if (job.epoch !== this.epoch) throw changed();
    if (job.controller.signal.aborted || !job.consumers.size || this.pending.get(job.key) !== job) throw cancelled();
  }
  pump() {
    while (this.active < this.maximum && this.queue.length) {
      const job = this.queue.shift();
      if (this.pending.get(job.key) !== job || !job.consumers.size || job.controller.signal.aborted) continue;
      this.run(job);
    }
  }
  async run(job) {
    this.active++; this.running.add(job); job.started = true;
    job.timer = setTimeout(() => this.retire(job, Object.assign(new Error('图片读取超时'), { status: 504 })), this.timeoutMs); job.timer.unref?.();
    try {
      const source = await job.load(job.controller.signal); this.check(job);
      if (!Buffer.isBuffer(source) || source.length > 12 * 1024 * 1024) throw new Error('图片预览过大或无效');
      const bytes = await this.transform(source, job.kind, job.controller.signal); this.check(job);
      if (this.cache.has(job.key)) this.bytes -= this.cache.get(job.key).length;
      this.cache.set(job.key, bytes); this.bytes += bytes.length;
      while (this.cache.size && (this.bytes > 24 * 1024 * 1024 || this.cache.size > this.maxEntries)) {
        const first = this.cache.keys().next().value; this.bytes -= this.cache.get(first).length; this.cache.delete(first);
      }
      for (const consumer of [...job.consumers]) consumer.finish(null, bytes);
    } catch (error) { for (const consumer of [...job.consumers]) consumer.finish(error); }
    finally {
      clearTimeout(job.timer); if (this.pending.get(job.key) === job) this.pending.delete(job.key);
      this.running.delete(job); this.active--; this.pump();
    }
  }
  clear() {
    this.epoch++; this.cache.clear(); this.bytes = 0;
    for (const job of new Set([...this.pending.values(), ...this.running])) this.retire(job, changed());
    // Abort callbacks may synchronously subscribe in the replacement epoch.
    this.queue = this.queue.filter(job => job.epoch === this.epoch && !job.controller.signal.aborted && job.consumers.size);
  }
  stats() { return { active: this.active, pending: this.pending.size, queued: this.queue.length, cacheBytes: this.bytes, cacheEntries: this.cache.size }; }
}
