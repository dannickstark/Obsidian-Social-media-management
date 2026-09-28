/** Minimal image headers — enough for imageSize(), not valid images. */
export function png(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b.buffer;
}

export function gif(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(13);
  b.set([...new TextEncoder().encode("GIF89a")]);
  const dv = new DataView(b.buffer);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  return b.buffer;
}

export function jpeg(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dv = new DataView(b.buffer);
  dv.setUint16(13, height);
  dv.setUint16(15, width);
  return b.buffer;
}

function riff(chunk: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32);
  const enc = new TextEncoder();
  b.set(enc.encode("RIFF"), 0);
  b.set(enc.encode("WEBP"), 8);
  b.set(enc.encode(chunk), 12);
  return b;
}

export function webpExtended(width: number, height: number): ArrayBuffer {
  const b = riff("VP8X");
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return b.buffer;
}

export function webpLossless(width: number, height: number): ArrayBuffer {
  const b = riff("VP8L");
  b[20] = 0x2f;
  new DataView(b.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return b.buffer;
}

export function webpLossy(width: number, height: number): ArrayBuffer {
  const b = riff("VP8 ");
  b.set([0x9d, 0x01, 0x2a], 23);
  const dv = new DataView(b.buffer);
  dv.setUint16(26, width, true);
  dv.setUint16(28, height, true);
  return b.buffer;
}
