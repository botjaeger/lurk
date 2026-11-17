// Renders icons/icon-{16,32,48,128}.png with no dependencies (node:zlib only).
// Same design as icons/icon.svg: black rounded square, two eyes peeking over a green bar.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLACK = [0x0b, 0x0c, 0x0b, 255];
const GREEN = [0x1f, 0xd5, 0x66, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

// Geometry in a 48x48 design space (matches the viewBox of icons/icon.svg).
const inRoundedRect = (x, y, [x0, y0, x1, y1, r]) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const TILE = [0, 0, 48, 48, 11];
const BAR = [8, 30, 40, 35, 2.5];
// Each eye is the top half of an ellipse (rx 5.5, ry 6.5) sitting on y = 30.
const inEye = (x, y, cx) => y <= 30 && ((x - cx) / 5.5) ** 2 + ((y - 30) / 6.5) ** 2 <= 1;
const inPupil = (x, y, cx) => (x - cx) ** 2 + (y - 27.6) ** 2 <= 2.2 * 2.2;

function colorAt(x, y) {
  if (!inRoundedRect(x, y, TILE)) return CLEAR;
  if (inRoundedRect(x, y, BAR)) return GREEN;
  if (inPupil(x, y, 20.6) || inPupil(x, y, 32.6)) return BLACK;
  if (inEye(x, y, 18) || inEye(x, y, 30)) return WHITE;
  return BLACK;
}

function render(size, ss = 6) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 48 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const c = colorAt((i + (si + 0.5) / ss) * scale, (j + (sj + 0.5) / ss) * scale);
          const ca = c[3] / 255;
          r += c[0] * ca;
          g += c[1] * ca;
          b += c[2] * ca;
          a += ca;
        }
      }
      const o = (j * size + i) * 4;
      const n = ss * ss;
      px[o] = a ? Math.round(r / a) : 0;
      px[o + 1] = a ? Math.round(g / a) : 0;
      px[o + 2] = a ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = fileURLToPath(new URL("../icons/", import.meta.url));
for (const size of [16, 32, 48, 128]) writeFileSync(`${outDir}icon-${size}.png`, render(size));
console.log("icons written to", outDir);
