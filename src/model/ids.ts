/**
 * Random ids from `crypto.getRandomValues`, which every Obsidian platform has
 * (`crypto.randomUUID` is missing on older iOS WebViews, #27).
 */
export function randomString(length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string {
  // Rejection sampling needs 1..256 symbols; outside that range it would loop forever or skip symbols.
  if (alphabet.length === 0 || alphabet.length > 256) throw new Error(`randomString needs an alphabet of 1 to 256 characters, got ${alphabet.length}`);
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  const byte = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(byte);
    if (byte[0]! < limit) out.push(alphabet[byte[0]! % alphabet.length]!);
  }
  return out.join("");
}

export function newDeviceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
