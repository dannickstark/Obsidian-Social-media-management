import { deflateSync } from "node:zlib";

const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc(out.subarray(4, out.length - 4)));
  return out;
}

/** Fully structured RGBA PNG fixture; unlike test/media/bytes.ts it has IDAT and IEND chunks. */
export function validPng(width: number, height: number, shade = 0): ArrayBuffer {
  const ihdr = new Uint8Array(13);
  const dimensions = new DataView(ihdr.buffer);
  dimensions.setUint32(0, width);
  dimensions.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = new Uint8Array(width * 4 + 1);
  row.fill(shade, 1);
  const pixels = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) pixels.set(row, y * row.length);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out.buffer;
}
