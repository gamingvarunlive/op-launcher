'use strict';
// Tiny PNG reader (8-bit, non-interlaced) - enough to look at a Minecraft skin.
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Returns { width, height, data } with data = RGBA bytes, or null when the file is not something we can read.
function decodePng(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
    let pos = 8;
    let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const start = pos + 8;
      if (start + len + 4 > buf.length) return null;
      const body = buf.subarray(start, start + len);
      if (type === 'IHDR') {
        w = body.readUInt32BE(0); h = body.readUInt32BE(4);
        depth = body[8]; ctype = body[9]; interlace = body[12];
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      pos = start + len + 4;
    }
    if (!w || !h || w > 4096 || h > 4096 || depth !== 8 || interlace !== 0) return null;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    if (!channels) return null;
    if (ctype === 3 && !palette) return null;

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * channels;
    if (raw.length < (stride + 1) * h) return null;

    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const row = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? px[row + x - channels] : 0;
        const b = y > 0 ? px[row - stride + x] : 0;
        const c = x >= channels && y > 0 ? px[row - stride + x - channels] : 0;
        let v = raw[src + x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        } else if (ft !== 0) return null;
        px[row + x] = v & 255;
      }
    }

    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const s = i * channels;
      let r, g, b, a = 255;
      if (ctype === 6) { r = px[s]; g = px[s + 1]; b = px[s + 2]; a = px[s + 3]; }
      else if (ctype === 2) { r = px[s]; g = px[s + 1]; b = px[s + 2]; }
      else if (ctype === 0) { r = g = b = px[s]; }
      else if (ctype === 4) { r = g = b = px[s]; a = px[s + 1]; }
      else { const k = px[s]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
      const o = i * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    return { width: w, height: h, data: out };
  } catch (_) {
    return null;
  }
}

// Slim ("Alex") skins leave the last column of the right arm's front face empty.
function isSlimSkin(buf) {
  const img = decodePng(buf);
  if (!img || img.width !== 64 || img.height < 64) return false;
  for (let y = 20; y < 32; y++) {
    if (img.data[(y * 64 + 47) * 4 + 3] !== 0) return false;
  }
  return true;
}

const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 8x8 PNG of a skin's face (hat layer on top). This is all that is shared with friends.
function headPng(buf) {
  const img = decodePng(buf);
  if (!img || img.width !== 64 || img.height < 32) return null;
  const out = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const f = ((8 + y) * 64 + 8 + x) * 4, hat = ((8 + y) * 64 + 40 + x) * 4, o = (y * 8 + x) * 4;
    const ha = img.data[hat + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(img.data[hat + c] * ha + img.data[f + c] * (1 - ha));
    out[o + 3] = 255;
  }
  return encodePng(8, 8, out);
}

module.exports = { decodePng, isSlimSkin, headPng };
