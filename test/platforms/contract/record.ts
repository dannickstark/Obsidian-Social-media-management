import type { HttpFn, HttpResponse } from "../../../src/platforms/http";
import { json, type Fixture } from "../http";

export interface RecordedExchange {
  request: { method: string; url: string; contentType?: string; body?: string };
  response: { status: number; headers: Record<string, string>; text: string };
}

const MASK = "•••";

/**
 * Wraps a real HttpFn and keeps every exchange with the given secrets masked, so a live run (QA) can be
 * saved as a fixture file. Binary bodies are summarised, never stored.
 */
export function recordingHttp(inner: HttpFn, secrets: readonly string[]): { http: HttpFn; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];
  const mask = (s: string) => secrets.filter((x) => x.length >= 4).reduce((t, x) => t.split(x).join(MASK), s);
  const http: HttpFn = async (req) => {
    const res: HttpResponse = await inner(req);
    const body = req.body === undefined ? undefined : typeof req.body === "string" ? mask(req.body) : `<binary ${req.body.byteLength} bytes>`;
    exchanges.push({
      request: { method: req.method ?? "GET", url: mask(req.url), ...(req.contentType ? { contentType: req.contentType } : {}), ...(body !== undefined ? { body } : {}) },
      response: { status: res.status, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, mask(v)])), text: mask(res.text) },
    });
    return res;
  };
  return { http, exchanges };
}

/** Turns a recording back into answers for the fake requestUrl. */
export function replay(exchanges: readonly RecordedExchange[]): Fixture[] {
  return exchanges.map((x) => {
    let parsed: unknown = x.response.text;
    try {
      parsed = JSON.parse(x.response.text);
    } catch {
      // Keep text bodies as they are.
    }
    return json(x.response.status, parsed, x.response.headers);
  });
}
