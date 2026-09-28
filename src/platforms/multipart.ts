import { randomString } from "../model/ids";

export type Part = { name: string; value: string } | { name: string; filename: string; contentType: string; data: ArrayBuffer };

const encoder = new TextEncoder();
/** Quotes, backslashes and control characters (CR, LF, NUL, ...) would end or corrupt the header. */
// eslint-disable-next-line no-control-regex
const safe = (s: string): string => s.replace(/[\x00-\x1f"\\]/g, "_");

/** A multipart/form-data body for requestUrl (which takes an ArrayBuffer and a content type). */
export function multipart(parts: readonly Part[], boundary = `osmm-${randomString(24)}`): { body: ArrayBuffer; contentType: string } {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const head =
      "value" in p
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"\r\n\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"; filename="${safe(p.filename)}"\r\nContent-Type: ${safe(p.contentType)}\r\n\r\n`;
    chunks.push(encoder.encode(head), "value" in p ? encoder.encode(p.value) : new Uint8Array(p.data), encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
