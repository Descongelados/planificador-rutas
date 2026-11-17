// Genera los iconos PNG de la app (fondo azul con un marcador blanco). Uso: node scripts/make-icons.mjs
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// Devuelve true si el punto (x, y), en coordenadas 0..1, cae sobre el marcador blanco.
function inPin(x, y) {
  const dx = x - 0.5, dy = y - 0.42;
  const inCircle = dx * dx + dy * dy <= 0.17 * 0.17;
  const inHole = dx * dx + dy * dy <= 0.07 * 0.07;
  // Triángulo de la punta: de (0.5±0.15, 0.46) a (0.5, 0.73).
  const inTip = y >= 0.46 && y <= 0.73 && Math.abs(x - 0.5) <= 0.15 * (1 - (y - 0.46) / (0.73 - 0.46));
  return (inCircle || inTip) && !inHole;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size) {
  const SS = 3; // supersampling para suavizar los bordes
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++)
          if (inPin((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)) hits++;
      const t = hits / (SS * SS);
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(BLUE[c] + (WHITE[c] - BLUE[c]) * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const size of [192, 512]) writeFileSync(`public/icons/icon-${size}.png`, png(size));
console.log("Iconos generados en public/icons");
