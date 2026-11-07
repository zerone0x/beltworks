/**
 * A minimal PNG reader and writer for the art tools (8-bit RGBA, gray, gray +
 * alpha and RGB in; 8-bit RGBA out), on Node's zlib, so the packer needs no
 * dependencies. Output is deterministic: same pixels, same bytes.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** @typedef {{ width: number, height: number, data: Uint8Array }} Image RGBA, row-major, straight alpha. */

/** @param {number} width @param {number} height @returns {Image} */
export function createImage(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {number} a @param {number} b @param {number} c */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a non-interlaced 8-bit PNG into RGBA.
 * @param {Uint8Array} file
 * @returns {Image}
 */
export function decodePng(file) {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const length = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8 || !(colorType in CHANNELS) || body[12] !== 0) {
        throw new Error(
          `unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${body[12]})`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + length;
  }
  const channels = CHANNELS[/** @type {0 | 2 | 4 | 6} */ (colorType)];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      let out;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + b;
          break;
        case 3:
          out = v + ((a + b) >> 1);
          break;
        case 4:
          out = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }
  const image = createImage(width, height);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      image.data.set(pixels.subarray(s, s + 4), d);
    } else if (channels === 3) {
      image.data.set(pixels.subarray(s, s + 3), d);
      image.data[d + 3] = 255;
    } else {
      const g = pixels[s];
      image.data[d] = image.data[d + 1] = image.data[d + 2] = g;
      image.data[d + 3] = channels === 2 ? pixels[s + 1] : 255;
    }
  }
  return image;
}

/** @param {string} type @param {Uint8Array} body */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Encodes RGBA pixels as an 8-bit PNG (RGB when every pixel is opaque, else
 * RGBA), choosing each row's filter by the smallest sum of absolute
 * differences, at maximum compression.
 * @param {Image} image
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height } = image;
  let opaque = true;
  for (let i = 3; i < image.data.length && opaque; i += 4) opaque = image.data[i] === 255;
  const bpp = opaque ? 3 : 4;
  let data = image.data;
  if (opaque) {
    data = new Uint8Array(width * height * 3);
    for (let i = 0, o = 0; i < image.data.length; i += 4, o += 3) {
      data[o] = image.data[i];
      data[o + 1] = image.data[i + 1];
      data[o + 2] = image.data[i + 2];
    }
  }
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let bestScore = Infinity;
    let bestFilter = 0;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = data[row + x];
        const a = x >= bpp ? data[row + x - bpp] : 0;
        const b = y > 0 ? data[row - stride + x] : 0;
        const c = x >= bpp && y > 0 ? data[row - stride + x - bpp] : 0;
        let f;
        switch (filter) {
          case 0:
            f = v;
            break;
          case 1:
            f = v - a;
            break;
          case 2:
            f = v - b;
            break;
          case 3:
            f = v - ((a + b) >> 1);
            break;
          default:
            f = v - paeth(a, b, c);
        }
        f &= 0xff;
        candidate[x] = f;
        score += f < 128 ? f : 256 - f;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best.set(candidate);
      }
    }
    out[y * (stride + 1)] = bestFilter;
    out.set(best, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(out, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Copies the `w × h` rectangle at `(sx, sy)` of `src` to `(dx, dy)` in `dst`.
 * @param {Image} src @param {number} sx @param {number} sy @param {number} w @param {number} h
 * @param {Image} dst @param {number} dx @param {number} dy
 */
export function blit(src, sx, sy, w, h, dst, dx, dy) {
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * src.width + sx) * 4;
    dst.data.set(src.data.subarray(from, from + w * 4), ((dy + y) * dst.width + dx) * 4);
  }
}
