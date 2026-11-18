// Generates apps/desktop/build/icon.ico — a branded app icon with no image-library dependency.
// An emerald rounded square (the UI accent) with a white "play" triangle (run-a-task). Encodes a
// 256x256 RGBA PNG by hand and wraps it in a (Vista+) PNG-payload ICO container.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const S = 256;
const rgba = Buffer.alloc(S * S * 4, 0); // transparent RGBA

const px = (x, y, r, g, b, a) => {
  const i = (y * S + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
};

// Rounded-rect membership: distance to the nearest corner centre in the corner zones.
const pad = 6;
const radius = 54;
function inRounded(x, y) {
  const x0 = pad,
    y0 = pad,
    x1 = S - 1 - pad,
    y1 = S - 1 - pad;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cxMin = x0 + radius,
    cxMax = x1 - radius,
    cyMin = y0 + radius,
    cyMax = y1 - radius;
  let dx = 0,
    dy = 0;
  if (x < cxMin) dx = cxMin - x;
  else if (x > cxMax) dx = x - cxMax;
  if (y < cyMin) dy = cyMin - y;
  else if (y > cyMax) dy = y - cyMax;
  return dx * dx + dy * dy <= radius * radius;
}

// Filled triangle via consistent edge-sign test.
const tri = [
  [104, 78],
  [104, 178],
  [186, 128],
];
function inTriangle(x, y) {
  const sign = (ax, ay, bx, by) => (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d1 = sign(tri[0][0], tri[0][1], tri[1][0], tri[1][1]);
  const d2 = sign(tri[1][0], tri[1][1], tri[2][0], tri[2][1]);
  const d3 = sign(tri[2][0], tri[2][1], tri[0][0], tri[0][1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRounded(x, y)) continue;
    if (inTriangle(x, y)) px(x, y, 255, 255, 255, 255);
    else px(x, y, 5, 150, 105, 255); // emerald-600
  }
}

// --- PNG ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// --- ICO (single 256x256 PNG entry) ---
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256 -> 0
entry[1] = 0; // height 256 -> 0
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12); // image offset
const ico = Buffer.concat([dir, entry, png]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon.ico'), ico);
writeFileSync(join(outDir, 'icon.png'), png);
console.log(`wrote build/icon.ico (${ico.length} bytes) + icon.png`);
