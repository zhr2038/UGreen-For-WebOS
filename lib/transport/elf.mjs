// Read-only ELF ABI inspection. It does not dlopen/execute an APK library.
export function inspectElf(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 52 || b.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('不是 ELF 文件');
  const bits = b[4] === 1 ? 32 : b[4] === 2 ? 64 : 0;
  if (!bits || ![1, 2].includes(b[5]) || b.length < (bits === 64 ? 64 : 52)) throw new Error('不支持的 ELF 头');
  const little = b[5] === 1;
  const u16 = n => little ? b.readUInt16LE(n) : b.readUInt16BE(n);
  const u32 = n => little ? b.readUInt32LE(n) : b.readUInt32BE(n);
  const u64 = n => { const v = little ? b.readBigUInt64LE(n) : b.readBigUInt64BE(n); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF 偏移超出范围'); return Number(v); };
  const machine = u16(18), entrySize = u16(bits === 32 ? 42 : 54), count = u16(bits === 32 ? 44 : 56), table = bits === 32 ? u32(28) : u64(32);
  if (count > 1024 || (count && entrySize < (bits === 32 ? 32 : 56)) || table + entrySize * count > b.length) throw new Error('ELF 程序头无效');
  const segments = []; let interpreter = '';
  for (let i = 0; i < count; i++) {
    const p = table + i * entrySize, type = u32(p), offset = bits === 32 ? u32(p + 4) : u64(p + 8), address = bits === 32 ? u32(p + 8) : u64(p + 16), size = bits === 32 ? u32(p + 16) : u64(p + 32);
    if (offset + size > b.length) throw new Error('ELF 段超出文件范围');
    segments.push({ type, offset, address, size });
    if (type === 3) interpreter = b.subarray(offset, offset + size).toString().replace(/\0.*$/, '');
  }
  let strAddress, strSize = 0; const neededOffsets = [];
  for (const s of segments.filter(s => s.type === 2)) {
    const size = bits === 32 ? 8 : 16;
    for (let p = s.offset; p + size <= s.offset + s.size; p += size) {
      const tag = bits === 32 ? u32(p) : u64(p), value = bits === 32 ? u32(p + 4) : u64(p + 8);
      if (!tag) break;
      if (tag === 1) neededOffsets.push(value);
      if (tag === 5) strAddress = value;
      if (tag === 10) strSize = value;
    }
  }
  const load = segments.find(s => s.type === 1 && strAddress >= s.address && strAddress < s.address + s.size);
  const dependencies = [];
  if (load && strSize) {
    const start = load.offset + strAddress - load.address;
    if (start + strSize > b.length) throw new Error('ELF 字符串表无效');
    for (const offset of neededOffsets) {
      if (offset >= strSize) throw new Error('ELF 依赖名称无效');
      const end = b.indexOf(0, start + offset);
      if (end < 0 || end >= start + strSize) throw new Error('ELF 依赖名称未结束');
      dependencies.push(b.subarray(start + offset, end).toString());
    }
  }
  const android = dependencies.some(n => ['liblog.so', 'libandroid.so', 'libjnigraphics.so'].includes(n)) || interpreter.startsWith('/system/bin/linker');
  return { bits, machine, architecture: machine === 40 ? 'arm' : machine === 183 ? 'arm64' : machine === 62 ? 'x64' : 'unknown', interpreter, dependencies, android, flags: u32(bits === 32 ? 36 : 48) };
}

export function elfCompatibility(info, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux') return { compatible: false, reason: 'PLATFORM_MISMATCH' };
  if (info.android) return { compatible: false, reason: 'ANDROID_ABI_REQUIRES_PORT' };
  if (info.architecture !== arch || (arch === 'arm' && info.bits !== 32)) return { compatible: false, reason: 'CPU_ABI_MISMATCH' };
  return { compatible: true, reason: null, note: 'ELF 头兼容仍不证明依赖、SDK 协议或 P2P 数据通道可用' };
}
