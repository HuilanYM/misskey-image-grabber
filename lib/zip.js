// 零依赖 store-only ZIP 生成器（图片已压缩，STORE 即最优）
// 无 chrome 依赖，可在 Node 中测试

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

const enc = new TextEncoder();

export class StoreZip {
  constructor() {
    this.parts = []; // {head: Uint8Array, data: Uint8Array|Uint8Array[]}
    this.central = [];
    this.offset = 0;
    this.count = 0;
    this.bytes = 0;
  }

  /** 添加文件。data 可以是 Uint8Array（已持有字节） */
  add(name, data) {
    if (!(data instanceof Uint8Array)) throw new Error('StoreZip.add 需要 Uint8Array');
    const nameBytes = enc.encode(name);
    const { time, date } = dosDateTime();
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 名称
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, this.offset, true);
    cd.set(nameBytes, 46);

    this.parts.push(local, data);
    this.central.push(cd);
    this.offset += local.length + data.length;
    this.count++;
    this.bytes += data.length;
    return this;
  }

  /** 容量守卫：ZIP 无 ZIP64，条目数 uint16 / 偏移 uint32，超限会静默损坏——显式中止 */
  assertCapacity() {
    if (this.count > 65000) throw new Error('ZIP entry count ' + this.count + ' exceeds 65000 (format limit)');
    const cdSize = this.central.reduce((s, c) => s + c.length, 0);
    if (this.offset + cdSize + 22 > 0xffffffff) throw new Error('ZIP exceeds 4 GB (format limit)');
  }

  /** 生成最终 Blob（浏览器）/ Uint8Array（Node 测试用 buildBytes） */
  build() {
    this.assertCapacity();
    if (typeof Blob === 'function') {
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      const cdSize = this.central.reduce((s, c) => s + c.length, 0);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, this.count, true);
      ev.setUint16(10, this.count, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, eocd], { type: 'application/zip' });
    }
    return this.buildBytes();
  }

  buildBytes() {
    this.assertCapacity();
    const cdSize = this.central.reduce((s, c) => s + c.length, 0);
    const total = this.offset + cdSize + 22;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of this.parts) {
      out.set(part, p);
      p += part.length;
    }
    for (const c of this.central) {
      out.set(c, p);
      p += c.length;
    }
    const ev = new DataView(out.buffer, p);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, this.offset, true);
    return out;
  }
}
