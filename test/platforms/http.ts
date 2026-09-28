import { requestUrlMock, type RequestUrlParam, type RequestUrlResponse } from "../fakes/obsidian";

/** One scripted answer of the fake requestUrl. */
export type Fixture = (req: RequestUrlParam) => RequestUrlResponse | Error | Promise<RequestUrlResponse | Error>;

const encoder = new TextEncoder();
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

export function text(status: number, body: string, headers: Record<string, string> = {}): Fixture {
  return () => ({ status, headers: { "content-type": "text/plain; charset=utf-8", ...headers }, text: body, json: null, arrayBuffer: buffer(encoder.encode(body)) });
}

export function html(status: number, body: string, headers: Record<string, string> = {}): Fixture {
  return text(status, body, { "content-type": "text/html; charset=utf-8", ...headers });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Fixture {
  const t = JSON.stringify(body);
  return () => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, text: t, json: body, arrayBuffer: buffer(encoder.encode(t)) });
}

export function bytes(status: number, data: Uint8Array, contentType: string): Fixture {
  return () => ({ status, headers: { "content-type": contentType }, text: "", json: null, arrayBuffer: buffer(data) });
}

/** The connection failed (no HTTP status). */
export const netError: Fixture = () => new Error("net::ERR_CONNECTION_RESET");
/** The server never answers. */
export const hang: Fixture = () => new Promise<never>(() => undefined);

export function queue(...fixtures: Fixture[]): void {
  requestUrlMock.queue.push(...fixtures);
}

export function call(i: number): RequestUrlParam {
  const c = requestUrlMock.calls[i];
  if (!c) throw new Error(`No request #${i}; ${requestUrlMock.calls.length} were made`);
  return c;
}

export function sentText(i: number): string {
  const body = call(i).body;
  if (body === undefined) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sentJson(i: number): any {
  return JSON.parse(sentText(i));
}

export interface FormPart {
  value?: string;
  filename?: string;
  type?: string;
  size: number;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parses a multipart/form-data body byte by byte (file parts report their size, text parts their value). */
export function parseForm(body: string | ArrayBuffer | undefined, contentType: string | undefined): Record<string, FormPart> {
  const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
  if (!boundary || !(body instanceof ArrayBuffer)) throw new Error("not a multipart body");
  const bytes = new Uint8Array(body);
  const delimiter = encoder.encode(`--${boundary}`);
  const blank = encoder.encode("\r\n\r\n");
  const out: Record<string, FormPart> = {};
  let start = indexOf(bytes, delimiter, 0);
  while (start !== -1) {
    const next = indexOf(bytes, delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = bytes.subarray(start + delimiter.length + 2, next - 2);
    const headEnd = indexOf(chunk, blank, 0);
    const head = new TextDecoder().decode(chunk.subarray(0, headEnd));
    const data = chunk.subarray(headEnd + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const type = /Content-Type: (.+)/i.exec(head)?.[1]?.trim();
    out[name] = filename !== undefined ? { filename, ...(type ? { type } : {}), size: data.length } : { value: new TextDecoder().decode(data), size: data.length };
    start = next;
  }
  return out;
}

export function formParts(i: number): Record<string, FormPart> {
  return parseForm(call(i).body, call(i).contentType);
}
