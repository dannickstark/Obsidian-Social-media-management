/** Structural PNG validation before untrusted bytes are saved in the vault. */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let i = start; i < end; i++) value = CRC_TABLE[(value ^ bytes[i]!) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function allowedDepth(depth: number, color: number): boolean {
  if (color === 0) return [1, 2, 4, 8, 16].includes(depth);
  if (color === 2 || color === 4 || color === 6) return depth === 8 || depth === 16;
  if (color === 3) return [1, 2, 4, 8].includes(depth);
  return false;
}

/** Checks PNG signature, complete chunks/CRCs, IHDR, IDAT and terminal IEND. */
export function pngStructure(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 57 || SIGNATURE.some((part, i) => bytes[i] !== part)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let endedData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return null;
    const type = chunkName(bytes, offset + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (crc32(bytes, offset + 4, dataEnd) !== view.getUint32(dataEnd)) return null;
    if (!sawHeader && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (sawHeader || length !== 13) return null;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000 ||
          !allowedDepth(bytes[dataStart + 8]!, bytes[dataStart + 9]!) ||
          bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || ![0, 1].includes(bytes[dataStart + 12]!)) return null;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (endedData || length === 0) return null;
      if (!sawData) {
        // IDAT is a zlib stream: require deflate compression and a valid header checksum.
        if (length < 6) return null;
        const cmf = bytes[dataStart]!;
        const flg = bytes[dataStart + 1]!;
        if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0) return null;
      }
      sawData = true;
    } else if (type === "IEND") {
      return sawHeader && sawData && length === 0 && dataEnd + 4 === bytes.length ? { width, height } : null;
    } else if (sawData) {
      endedData = true;
    }
    offset = dataEnd + 4;
  }
  return null;
}
