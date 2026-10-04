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

const MAX_COMPRESSED = 20 * 1024 * 1024;
const MAX_DECOMPRESSED = 80 * 1024 * 1024;

async function validPixels(parts: readonly Uint8Array[], width: number, height: number, depth: number, color: number): Promise<boolean> {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels) return false;
  const rowLength = Math.ceil(width * channels * depth / 8) + 1;
  const expected = rowLength * height;
  const compressedLength = parts.reduce((sum, part) => sum + part.length, 0);
  if (expected > MAX_DECOMPRESSED || compressedLength < 6 || compressedLength > MAX_COMPRESSED || typeof DecompressionStream === "undefined") return false;
  const compressed = new Uint8Array(new ArrayBuffer(compressedLength));
  let at = 0;
  for (const part of parts) { compressed.set(part, at); at += part.length; }
  const cmf = compressed[0]!;
  const flg = compressed[1]!;
  if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(compressed);
        controller.close();
      },
    });
    reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
    let total = 0;
    let position = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) return total === expected;
      for (const byte of value) {
        if (total >= expected || (position === 0 && byte > 4)) {
          await reader.cancel();
          return false;
        }
        total++;
        position = (position + 1) % rowLength;
      }
    }
  } catch {
    await reader?.cancel().catch(() => undefined);
    return false;
  }
}

/** Checks complete chunks/CRCs and bounded, decodable scanlines before saving an image. */
export async function pngStructure(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  if (bytes.length < 57 || bytes.length > MAX_COMPRESSED || SIGNATURE.some((part, i) => bytes[i] !== part)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let endedData = false;
  let depth = 0;
  let color = 0;
  const idat: Uint8Array[] = [];
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
      depth = bytes[dataStart + 8]!;
      color = bytes[dataStart + 9]!;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000 ||
          !allowedDepth(depth, color) ||
          bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0) return null;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (endedData) return null;
      idat.push(bytes.subarray(dataStart, dataEnd));
      sawData = true;
    } else if (type === "IEND") {
      return sawHeader && sawData && length === 0 && dataEnd + 4 === bytes.length && await validPixels(idat, width, height, depth, color) ? { width, height } : null;
    } else if (sawData) {
      endedData = true;
    }
    offset = dataEnd + 4;
  }
  return null;
}
