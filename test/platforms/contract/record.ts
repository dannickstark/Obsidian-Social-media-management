import type { HttpFn, HttpResponse } from "../../../src/platforms/http";
import { json, type Fixture } from "../http";

export interface RecordedExchange {
  request: { method: string; url: string; contentType?: string; body?: string };
  response: { status: number; headers: Record<string, string>; text: string };
}

const MASK = "•••";
/** Response keys whose string values are credentials minted during the exchange (session tokens, JWTs, cookies). */
const SECRET_KEY = /token|jwt|secret|password|session|cookie|authorization|api[-_]?key/i;

/** Collects string values under credential-shaped keys anywhere in a JSON body. */
function mintedSecrets(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (SECRET_KEY.test(key) && v.length >= 8) found.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(parsed, "");
  return found;
}

/**
 * Wraps a real HttpFn and keeps every exchange with the given secrets masked, so a live run (QA) can be
 * saved as a fixture file. Binary bodies are summarised, never stored. Credentials the platform returns during
 * the run (session tokens, JWTs, cookies) are learnt from the answers and masked too, in that exchange and every
 * later one. Recordings live under test/platforms/<platform>/recorded/, which is git-ignored (M5 P1).
 */
export function recordingHttp(inner: HttpFn, secrets: readonly string[]): { http: HttpFn; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];
  const known = [...secrets];
  const mask = (s: string) => known.filter((x) => x.length >= 4).reduce((t, x) => t.split(x).join(MASK), s);
  const http: HttpFn = async (req) => {
    const res: HttpResponse = await inner(req);
    known.push(...mintedSecrets(res.text));
    for (const [k, v] of Object.entries(res.headers)) if (SECRET_KEY.test(k) && v.length >= 8) known.push(v);
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
