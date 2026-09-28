import type { RequestUrlResponse } from "../../fakes/obsidian";

/**
 * Responses shaped like ntfy's documented JSON (message: {id, time, expires, event, topic, …};
 * error: {code, http, error, link}). QA (docs/qa/m3.md) replaces them with responses captured from ntfy.sh.
 */
function res(status: number, body: unknown, headers: Record<string, string> = {}): () => RequestUrlResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return () => ({ status, headers: { "content-type": "application/json", ...headers }, text, json: typeof body === "string" ? null : body, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer });
}

export const NTFY = {
  published: res(200, { id: "hwQ2YpKdmg", time: 1791216000, expires: 1791259200, event: "message", topic: "osmm-test", title: "t", message: "m" }),
  scheduled: res(200, { id: "Zr0Jk2fA9b", time: 1791219600, expires: 1791262800, event: "message", topic: "osmm-test", message: "m" }),
  cancelled: res(200, { id: "Zr0Jk2fA9b", time: 1791216000, event: "message_delete", topic: "osmm-test" }),
  forbidden: res(403, { code: 40301, http: 403, error: "forbidden", link: "https://ntfy.sh/docs/publish/#authentication" }),
  delayTooLarge: res(400, { code: 40006, http: 400, error: "invalid delay parameter: too large, please refer to https://ntfy.sh/docs/publish/#scheduled-delivery" }),
  rateLimited: res(429, { code: 42901, http: 429, error: "limit reached: too many requests" }, { "retry-after": "60" }),
  notFound: res(404, { code: 40401, http: 404, error: "page not found" }),
  badGateway: res(502, "<html>Bad gateway</html>"),
  echoesSecrets: res(400, { code: 40009, http: 400, error: "invalid topic osmm-SECRETTOPIC for token tk_SECRETTOKEN" }),
  garbled: res(200, "not json"),
};
