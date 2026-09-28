import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, TransientError, UnknownOutcomeError } from "../../src/platforms/errors";
import { ApiClient, header, isOk, kindForStatus, obsidianHttp, parseJson, RequestTimeoutError, retryAfterMs, send, type ApiFailure, type HttpResponse } from "../../src/platforms/http";
import { call, hang, json, netError, queue, text } from "./http";

const NOW = Date.UTC(2026, 9, 8, 8);
const errorText = (res: HttpResponse): ApiFailure => ({ message: String((JSON.parse(res.text) as { error?: string }).error) });
const client = (failure: (res: HttpResponse) => ApiFailure = errorText) => new ApiClient({ platform: "mastodon", http: obsidianHttp, now: () => NOW, timeoutMs: 30, failure });
const TOKEN_URL = "https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage";
const UNKNOWN_5XX = (status: number) => `Mastodon: the server answered with an error (HTTP ${status}) while posting, so it is not known whether it went out.`;

describe("send", () => {
  it("asks requestUrl not to throw and returns any status", async () => {
    queue(json(404, { error: "Record not found" }));
    const res = await send(obsidianHttp, { url: "https://x.example/a", method: "GET" }, 1000);
    expect(res.status).toBe(404);
    expect(call(0).throw).toBe(false);
  });

  it("gives up after the timeout, or after the request's own timeout", async () => {
    queue(hang, hang);
    await expect(send(obsidianHttp, { url: "https://x.example/a" }, 20)).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(send(obsidianHttp, { url: "https://x.example/a", timeoutMs: 20 }, 60_000)).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(call(1)).not.toHaveProperty("timeoutMs");
  });

  it("gives a binary answer an empty text", async () => {
    queue(() => ({
      status: 200,
      headers: { "content-type": "image/png" },
      json: null,
      get text(): string {
        throw new Error("not text");
      },
      arrayBuffer: new Uint8Array([1, 2]).buffer,
    }));
    const res = await send(obsidianHttp, { url: "https://x.example/a.png" }, 1000);
    expect(res.text).toBe("");
    expect(res.arrayBuffer.byteLength).toBe(2);
  });
});

describe("helpers", () => {
  it("reads headers in any case, parses JSON or gives null, and tells 2xx apart", () => {
    expect(header({ "Retry-After": "3" }, "retry-after")).toBe("3");
    expect(header({}, "retry-after")).toBeUndefined();
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("<html>")).toBeNull();
    const res = (status: number): HttpResponse => ({ status, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) });
    expect([199, 200, 204, 299, 300, 404].map((s) => isOk(res(s)))).toEqual([false, true, true, true, false, false]);
  });
});

describe("ApiClient phases (M2b P4, M5 P2)", () => {
  it("prepare: a failed connection is transient, says nothing was posted, and never shows the URL", async () => {
    queue(netError);
    const e = await client().prepare({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransientError);
    expect((e as Error).message).toBe("Mastodon: the connection failed before posting; nothing was posted.");
    expect((e as Error).message).not.toContain("SECRET");
  });

  it("prepare: no answer in time is transient", async () => {
    queue(hang);
    const e = await client().prepare({ url: "https://x.example/media", method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransientError);
    expect((e as Error).message).toBe("Mastodon: no answer in time before posting; nothing was posted.");
  });

  it("commit: a failed connection or no answer is an unknown outcome", async () => {
    queue(netError, hang);
    const failed = await client().commit({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(failed).toBeInstanceOf(UnknownOutcomeError);
    expect((failed as Error).message).toBe("Mastodon: the connection failed while posting, so it is not known whether it went out.");
    const e = await client().commit({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownOutcomeError);
    expect((e as Error).message).toBe("Mastodon: no answer in time while posting, so it is not known whether it went out.");
  });

  it("commit: a retry-safe commit is still unknown when the connection fails or times out", async () => {
    queue(netError, hang);
    await expect(client().commit({ url: TOKEN_URL, method: "POST" }, { retrySafe: true })).rejects.toBeInstanceOf(UnknownOutcomeError);
    await expect(client().commit({ url: TOKEN_URL, method: "POST" }, { retrySafe: true })).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it.each<[number, new (...args: never[]) => Error]>([
    [401, NeedsUserError],
    [403, NeedsUserError],
    [404, NeedsUserError],
    [409, NeedsUserError],
    [400, InvalidContentError],
    [413, InvalidContentError],
    [422, InvalidContentError],
    [408, TransientError],
    [429, TransientError],
    [500, TransientError],
    [503, TransientError],
  ])("classifies HTTP %i on a retry-safe commit", async (status, cls) => {
    queue(json(status, { error: "Nope" }));
    const e = await client().commit({ url: "https://x.example/p", method: "POST" }, { retrySafe: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(cls);
    expect((e as Error).message).toBe(`Mastodon: Nope (HTTP ${status})`);
  });

  it.each([500, 502, 503, 504])("commit: HTTP %i is an unknown outcome unless the commit is retry-safe (M5 P2)", async (status) => {
    queue(json(status, { error: "Bad gateway" }));
    const e = await client().commit({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownOutcomeError);
    expect((e as Error).message).toBe(UNKNOWN_5XX(status));
    expect((e as Error).message).not.toContain("SECRET");
  });

  it("commit: 408 and 429 stay transient, with the wait, even when not retry-safe", async () => {
    queue(json(408, { error: "Timeout" }), json(429, { error: "Slow down" }, { "Retry-After": "12" }));
    await expect(client().commit({ url: "https://x.example/p" })).rejects.toBeInstanceOf(TransientError);
    const e = await client().commit({ url: "https://x.example/p" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransientError);
    expect((e as TransientError).retryAfterMs).toBe(12_000);
  });

  it("commit: a 5xx that is not retry-safe stays unknown whatever the error body says", async () => {
    queue(text(502, "<html>Bad gateway</html>"), json(503, {}));
    await expect(client(() => ({ message: "try later", kind: "transient", retryAfterMs: 1000 })).commit({ url: "https://x.example/p" })).rejects.toBeInstanceOf(UnknownOutcomeError);
    await expect(client(() => ({ message: "no such chat", kind: "needs_user" })).commit({ url: "https://x.example/p" })).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it("prepare: a 5xx is transient; so are 408 and 429", async () => {
    queue(json(503, { error: "Down" }), json(408, { error: "Timeout" }), json(429, { error: "Slow down" }));
    for (const status of [503, 408, 429]) {
      const e = await client().prepare({ url: "https://x.example/media", method: "POST" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TransientError);
      expect((e as Error).message).toMatch(new RegExp(`\\(HTTP ${status}\\)$`));
    }
  });

  it("error(): a commit's HTTP answer from exchange is classified with the same rule", async () => {
    const res: HttpResponse = { status: 502, headers: {}, text: JSON.stringify({ error: "Bad gateway" }), arrayBuffer: new ArrayBuffer(0) };
    expect(client().error(res, { commit: true })).toBeInstanceOf(UnknownOutcomeError);
    expect(client().error(res, { commit: true }).message).toBe(UNKNOWN_5XX(502));
    expect(client().error(res, { commit: true, retrySafe: true })).toBeInstanceOf(TransientError);
    expect(client().error(res)).toBeInstanceOf(TransientError);
    expect(client().error({ ...res, status: 429 }, { commit: true })).toBeInstanceOf(TransientError);
  });

  it("reads the wait from Retry-After, in seconds or as a date", async () => {
    queue(json(429, { error: "Slow down" }, { "Retry-After": "30" }));
    expect(await client().commit({ url: "https://x.example/p" }).catch((e: TransientError) => e.retryAfterMs)).toBe(30_000);
    expect(retryAfterMs({ "retry-after": new Date(NOW + 90_000).toUTCString() }, NOW)).toBe(90_000);
    expect(retryAfterMs({ "retry-after": new Date(NOW - 90_000).toUTCString() }, NOW)).toBe(0);
    expect(retryAfterMs({ "retry-after": "soon" }, NOW)).toBeUndefined();
    expect(retryAfterMs({}, NOW)).toBeUndefined();
  });

  it("lets the platform's error body choose the class and the wait", async () => {
    queue(json(400, {}), json(429, {}, { "Retry-After": "1" }));
    await expect(client(() => ({ message: "chat not found", kind: "needs_user" })).commit({ url: "https://x.example/p" })).rejects.toBeInstanceOf(NeedsUserError);
    const waited = await client(() => ({ message: "retry after 7", retryAfterMs: 7000 }))
      .commit({ url: "https://x.example/p" })
      .catch((e: TransientError) => e.retryAfterMs);
    expect(waited).toBe(7000);
  });

  it("builds messages from the error body only, never from the URL or headers", async () => {
    queue(json(401, { error: "The access token is invalid" }));
    const e = await client()
      .commit({ url: TOKEN_URL, method: "POST", headers: { Authorization: "Bearer SECRET-TOKEN" } })
      .catch((x: unknown) => x);
    expect((e as Error).message).toBe("Mastodon: The access token is invalid (HTTP 401)");
  });

  it("read returns every status and lets network errors through as they are", async () => {
    queue(json(404, { error: "x" }), netError);
    expect((await client().read({ url: "https://x.example/p" })).status).toBe(404);
    await expect(client().read({ url: "https://x.example/p" })).rejects.toThrow("net::ERR_CONNECTION_RESET");
  });

  it("exchange applies the phase to network errors but returns HTTP errors to the caller", async () => {
    queue(json(400, { error: "ExpiredToken" }), netError, json(502, { error: "Bad gateway" }), netError);
    expect((await client().exchange("commit", { url: "https://x.example/p" })).status).toBe(400);
    await expect(client().exchange("commit", { url: "https://x.example/p" })).rejects.toBeInstanceOf(UnknownOutcomeError);
    expect((await client().exchange("commit", { url: "https://x.example/p" })).status).toBe(502);
    await expect(client().exchange("prepare", { url: "https://x.example/p" })).rejects.toBeInstanceOf(TransientError);
  });

  it("maps statuses to kinds", () => {
    expect([401, 403, 404, 400, 413, 422, 408, 429, 500].map(kindForStatus)).toEqual([
      "needs_user",
      "needs_user",
      "needs_user",
      "invalid_content",
      "invalid_content",
      "invalid_content",
      "transient",
      "transient",
      "transient",
    ]);
  });
});
