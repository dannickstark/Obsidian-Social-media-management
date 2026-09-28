export interface ImageSize {
  width: number;
  height: number;
  mime: string;
}

const ascii = (b: Uint8Array, offset: number, length: number): string => String.fromCharCode(...b.subarray(offset, offset + length));

function jpegSize(b: Uint8Array, dv: DataView): ImageSize | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7), mime: "image/jpeg" };
    }
    o += 2 + dv.getUint16(o + 2);
  }
  return null;
}

function webpSize(b: Uint8Array, dv: DataView): ImageSize | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { width: w, height: h, mime: "image/webp" };
  }
  if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, mime: "image/webp" };
  if (chunk === "VP8L") {
    const bits = dv.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" };
  }
  return null;
}

/** Width and height from the file header of a PNG, JPEG, GIF or WebP image; null for anything else. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") {
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: "image/png" };
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), mime: "image/gif" };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes, dv);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, dv);
  return null;
}
