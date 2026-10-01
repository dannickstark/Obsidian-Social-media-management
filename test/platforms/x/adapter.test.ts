import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../../src/model/types";
import { XAdapter, xWeightedLength, xUrlLength } from "../../../src/platforms/x/api";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { requestUrlMock } from "../../fakes/obsidian";
import { CONTRACT_NOW, contractDeps, expectDigestReads, trackedJob } from "../contract/harness";
import { call, formParts, json, queue, sentJson, type Fixture } from "../http";
import { X_ID, X_POST, X_TOKEN, X_USER, xCase } from "./contract";

const job = (extra: Partial<DeliveryJob> = {}, ch: Partial<Channel> = {}): DeliveryJob => {
  const base = xCase.job();
  return trackedJob({ ...base, ...extra, channel: { ...base.channel, ...ch } });
};
const make = (extra: Partial<AdapterDeps> = {}) => new XAdapter({
  ...contractDeps(),
  http: async (request) => {
    requestUrlMock.calls.push(request);
    const fixture = requestUrlMock.queue.shift() as Fixture | undefined;
    if (!fixture) throw new Error(`No X fixture for ${request.url}`);
    const answer = await fixture(request);
    if (answer instanceof Error) throw answer;
    return answer;
  },
  ...extra,
});

beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout }));
afterEach(() => { expectDigestReads(); vi.unstubAllGlobals(); });

describe("XAdapter", () => {
  it("looks up the authenticated account and publishes with a bearer user token", async () => {
    queue(json(200, X_USER), json(201, X_POST));
    expect(requestUrlMock.queue).toHaveLength(2);
    const result = await make().publish(job());
    expect(result).toEqual({ remoteId: X_ID, url: `https://x.com/ada/status/${X_ID}` });
    expect(call(0).url).toBe("https://api.x.com/2/users/me");
    expect(call(1)).toMatchObject({ url: "https://api.x.com/2/tweets", headers: { Authorization: `Bearer ${X_TOKEN}` } });
    expect(sentJson(1)).toEqual({ text: "Hello" });
  });

  it("refuses to verify or publish when the token belongs to a different channel account", async () => {
    const adapter = make();
    queue(json(200, { data: { id: "99", username: "other" } }));
    await expect(adapter.verify(job().channel, X_TOKEN)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("does not match") });
    queue(json(200, { data: { id: "99", username: "other" } }));
    await expect(adapter.publish(job())).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("does not match") });
    expect(requestUrlMock.calls.filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(0);
  });

  it("reports identity-only verification and refuses API publishing without verified write and media access", async () => {
    const api = new XAdapter({ ...contractDeps(), xApiAccessVerified: false });
    queue(json(200, X_USER));
    await expect(api.verify(job().channel, X_TOKEN)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("identity verified") });
    await expect(api.publish(job())).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("API publishing is disabled") });
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("uses X's weighted length and fixed t.co URL length", () => {
    expect(xUrlLength("https://example.com/a-long-path")).toBe(23);
    expect(xWeightedLength("é 😀 https://example.com/a-long-path")).toBe(1 + 1 + 2 + 1 + 23);
  });

  it("rejects content above the weighted 280 character limit before sending", async () => {
    await expect(make().publish(job({ text: "x".repeat(281), items: ["x".repeat(281)] }))).rejects.toMatchObject({ kind: "invalid_content", message: expect.stringContaining("281/280") });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("uploads image bytes and alt text before attaching media to the first thread post", async () => {
    queue(json(200, X_USER), json(201, { data: { id: "media-1" } }), json(200, { data: { associated_metadata: { id: "media-1" } } }), json(201, X_POST));
    const result = await make().publish(job({ media: [img("cover.png", 800, 600, { alt: "A cover" })] }));
    expect(call(1)).toMatchObject({ url: "https://api.x.com/2/media/upload", contentType: expect.stringContaining("multipart/form-data") });
    expect(formParts(1).media).toMatchObject({ filename: "cover.png", type: "image/png" });
    expect(call(2).url).toBe("https://api.x.com/2/media/metadata");
    expect(sentJson(2)).toEqual({ id: "media-1", metadata: { text: "A cover" } });
    expect(call(3).url).toBe("https://api.x.com/2/tweets");
    expect(sentJson(3)).toEqual({ text: "Hello", media: { media_ids: ["media-1"] } });
    expect(result.remoteId).toBe(X_ID);
  });

  it("normalizes X short URLs to their expanded source and refuses duplicate recovery matches", async () => {
    const postText = "Read https://example.com/article.";
    const entry = { id: X_ID, text: "Read https://t.co/short.", author_id: "42", created_at: new Date(CONTRACT_NOW).toISOString(), entities: { urls: [{ url: "https://t.co/short", expanded_url: "https://example.com/article" }] } };
    const lookupJob = job({ text: postText, items: [postText], delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } });
    queue(json(200, X_USER), json(200, { data: [entry] }));
    await expect(make().lookup(lookupJob)).resolves.toMatchObject({ published: true, remoteId: X_ID });
    queue(json(200, X_USER), json(200, { data: [entry, { ...entry, id: "2000000000000000000" }] }));
    await expect(make().lookup(lookupJob)).resolves.toBeNull();
  });

  it("uses attached image metadata to disambiguate lookup matches", async () => {
    const text = "A launch";
    const media = img("cover.png", 800, 600, { alt: "Launch cover" });
    const lookupJob = job({ text, items: [text], media: [media], delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } });
    const found = { data: [{ id: X_ID, text, author_id: "42", created_at: new Date(CONTRACT_NOW).toISOString(), attachments: { media_keys: ["3_abc"] } }], includes: { media: [{ media_key: "3_abc", alt_text: "Launch cover" }] } };
    queue(json(200, X_USER), json(200, found));
    await expect(make().lookup(lookupJob)).resolves.toMatchObject({ published: true, remoteId: X_ID });
    queue(json(200, X_USER), json(200, { ...found, includes: { media: [{ media_key: "3_abc", alt_text: "Different image" }] } }));
    await expect(make().lookup(lookupJob)).resolves.toBeNull();
  });

  it("sequences replies and resumes from sent thread parts using the persisted send key", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW - 60_000, sendKey: "send-key-x-1" } };
    queue(json(200, X_USER), json(200, { data: [{ id: X_ID, text: "First", author_id: "42", created_at: new Date(CONTRACT_NOW).toISOString() }] }), json(201, { data: { id: "2000000000000000000", text: "Second" } }));
    const result = await make().publish(job(thread));
    expect(result.remoteId).toBe(X_ID);
    expect(call(1).url).toContain("/2/users/42/tweets");
    expect(call(2).headers).toMatchObject({ "Idempotency-Key": "osmm-send-key-x-1-1" });
    expect(sentJson(2)).toEqual({ text: "Second", reply: { in_reply_to_tweet_id: X_ID } });
  });

  it("reports a later thread part as partial and resumes it without reposting the root", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"] };
    const adapter = make();
    queue(json(200, X_USER), json(201, { data: { id: X_ID, text: "First", created_at: new Date(CONTRACT_NOW).toISOString() } }), json(400, { title: "Invalid Request", detail: "temporarily rejected" }));
    const partial = await adapter.publish(job(thread));
    expect(partial.note).toContain("Part 2 of 2 was not posted");
    requestUrlMock.queue.push(
      json(200, { data: [{ id: X_ID, text: "First", author_id: "42", created_at: new Date(CONTRACT_NOW).toISOString() }] }),
      json(201, { data: { id: "2000000000000000000", text: "Second" } }),
    );
    const resumed = await adapter.publish(job({ ...thread, delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } }));
    expect(resumed.remoteId).toBe(X_ID);
    expect(requestUrlMock.calls.filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(3);
    expect(sentJson(4)).toEqual({ text: "Second", reply: { in_reply_to_tweet_id: X_ID } });
  });

  it("propagates reply authorization failures after earlier parts went live", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"] };
    queue(json(200, X_USER), json(201, { data: { id: X_ID, text: "First" } }), json(403, { title: "Forbidden", detail: "This endpoint is not available on your API tier." }));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("earlier parts are live") });
  });

  it("refuses unsupported or excess media instead of silently omitting it", async () => {
    await expect(make().publish(job({ media: [img("a.png"), img("b.png"), img("c.png"), img("d.png"), img("e.png")] }))).rejects.toMatchObject({ kind: "invalid_content", message: expect.stringContaining("at most 4") });
    await expect(make().publish(job({ media: [{ ...img("movie.mp4"), kind: "video" }] }))).rejects.toMatchObject({ kind: "invalid_content", message: expect.stringContaining("image files only") });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("refuses API-tier errors visibly while leaving verify as assisted-mode guidance", async () => {
    queue(json(200, X_USER), json(403, { title: "Forbidden", detail: "This endpoint is not available on your API tier." }));
    await expect(make().publish(job())).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("API tier") });
  });

  it("treats a post timeout as an unknown outcome", async () => {
    queue(json(200, X_USER), () => new Promise(() => undefined));
    await expect(make({ timeoutMs: 1 }).publish(job())).rejects.toMatchObject({ kind: "unknown" });
  });
});
