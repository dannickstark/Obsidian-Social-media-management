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
    expect(sentJson(2)).toEqual({ id: "media-1", metadata: { alt_text: { text: "A cover" } } });
    expect(call(3).url).toBe("https://api.x.com/2/tweets");
    expect(sentJson(3)).toEqual({ text: "Hello", media: { media_ids: ["media-1"] } });
    expect(result.remoteId).toBe(X_ID);
  });

  it("does not treat timeline text matches as proof of this send without an exact send-key binding", async () => {
    const postText = "Read https://example.com/article.";
    const lookupJob = job({ text: postText, items: [postText], delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } });
    await expect(make().lookup(lookupJob)).resolves.toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("does not treat matching media metadata as proof of this send", async () => {
    const text = "A launch";
    const media = img("cover.png", 800, 600, { alt: "Launch cover" });
    const lookupJob = job({ text, items: [text], media: [media], delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } });
    await expect(make().lookup(lookupJob)).resolves.toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("refuses to attach a reply to a heuristic timeline match on resume", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW - 60_000, sendKey: "send-key-x-1" } };
    queue(json(200, X_USER));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("no valid confirmed-part checkpoint") });
    expect(requestUrlMock.calls.filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(0);
  });

  it("propagates a later thread part 400 with confirmed part IDs as a resumable invalid-content error", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"] };
    const adapter = make();
    queue(json(200, X_USER), json(201, { data: { id: X_ID, text: "First", created_at: new Date(CONTRACT_NOW).toISOString() } }), json(400, { title: "Invalid Request", detail: "temporarily rejected" }));
    await expect(adapter.publish(job(thread))).rejects.toMatchObject({
      kind: "invalid_content",
      message: expect.stringContaining("part 2 could not be posted; earlier parts are live"),
      adapterState: expect.any(String),
    });
  });

  it("resumes from persisted remote IDs only after validating the exact confirmed thread chain", async () => {
    const secondId = "2000000000000000000";
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond\n\nThird", items: ["First", "Second", "Third"] };
    const initial = make();
    queue(
      json(200, X_USER),
      json(201, { data: { id: X_ID, text: "First", author_id: "42" } }),
      json(201, { data: { id: secondId, text: "Second", author_id: "42", referenced_tweets: [{ type: "replied_to", id: X_ID }] } }),
      json(400, { title: "Invalid Request", detail: "temporarily rejected" }),
    );
    let state: string | undefined;
    try { await initial.publish(job(thread)); } catch (e) { state = (e as { adapterState?: string }).adapterState; }
    expect(JSON.parse(state ?? "{}").partIds).toEqual([X_ID, secondId]);

    const retry = make();
    const retryStart = requestUrlMock.calls.length;
    queue(
      json(200, X_USER),
      json(200, { data: { id: X_ID, text: "First", author_id: "42" } }),
      json(200, { data: { id: secondId, text: "Second", author_id: "42", referenced_tweets: [{ type: "replied_to", id: X_ID }] } }),
      json(201, { data: { id: "3000000000000000000", text: "Third" } }),
    );
    const result = await retry.publish(job({ ...thread, delivery: { status: "failed", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1", adapterState: state } }));
    expect(result.remoteId).toBe(X_ID);
    expect(call(retryStart + 1).url).toContain(`/2/tweets/${X_ID}?`);
    expect(call(retryStart + 2).url).toContain(`/2/tweets/${secondId}?`);
    expect(call(retryStart + 3).url).toBe("https://api.x.com/2/tweets");
    expect(sentJson(retryStart + 3)).toEqual({ text: "Third", reply: { in_reply_to_tweet_id: secondId } });
  });

  it("refuses a persisted thread checkpoint when the post text has changed", async () => {
    const checkpoint = JSON.stringify({ version: 1, accountId: "42", sendKey: "send-key-x-1", fingerprint: "old", partIds: [X_ID], mediaKeys: [], nextPart: 1 });
    const thread = { text: "Edited\n\nSecond", items: ["Edited", "Second"], delivery: { status: "failed" as const, at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1", adapterState: checkpoint } };
    queue(json(200, X_USER));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("does not match the saved X thread checkpoint") });
    expect(requestUrlMock.calls.filter((entry) => entry.url.includes("/2/tweets/") || entry.url.endsWith("/2/tweets"))).toHaveLength(0);
  });

  it("refuses a persisted thread checkpoint bound to a different authenticated account", async () => {
    const checkpoint = JSON.stringify({ version: 1, accountId: "99", sendKey: "send-key-x-1", fingerprint: "unused", partIds: [X_ID], nextPart: 1 });
    const thread = { text: "First\n\nSecond", items: ["First", "Second"], delivery: { status: "failed" as const, at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1", adapterState: checkpoint } };
    queue(json(200, X_USER));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("no valid confirmed-part checkpoint") });
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("refuses to resume when the confirmed root's remote media no longer matches", async () => {
    const media = img("cover.png", 800, 600, { alt: "Expected cover" });
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], media: [media] };
    const initial = make();
    queue(
      json(200, X_USER),
      json(201, { data: { id: "media-1" } }),
      json(200, { data: { associated_metadata: { id: "media-1" } } }),
      json(201, { data: { id: X_ID, text: "First", author_id: "42" } }),
      json(200, {
        data: { id: X_ID, text: "First", author_id: "42", attachments: { media_keys: ["3_abc"] } },
        includes: { media: [{ media_key: "3_abc", alt_text: "Expected cover" }] },
      }),
      json(400, { title: "Invalid Request", detail: "temporarily rejected" }),
    );
    let state: string | undefined;
    try { await initial.publish(job(thread)); } catch (e) { state = (e as { adapterState?: string }).adapterState; }
    expect(state).toEqual(expect.any(String));

    const retry = make();
    const retryStart = requestUrlMock.calls.length;
    queue(json(200, X_USER), json(200, {
      data: { id: X_ID, text: "First", author_id: "42", attachments: { media_keys: ["3_abc"] } },
      includes: { media: [{ media_key: "3_abc", alt_text: "Different cover" }] },
    }));
    await expect(retry.publish(job({ ...thread, delivery: { status: "failed", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1", adapterState: state } }))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("media identity") });
    expect(requestUrlMock.calls.slice(retryStart).filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(0);
  });

  it.each([
    ["same alt text", "Expected cover", "Expected cover"],
    ["empty alt text", "", null],
  ])("refuses resume when the remote image key changed despite %s", async (_label, localAlt, remoteAlt) => {
    const media = img("cover.png", 800, 600, { alt: localAlt });
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], media: [media] };
    const initial = make();
    const initialFixtures = [json(200, X_USER), json(201, { data: { id: "media-1" } })];
    if (localAlt) initialFixtures.push(json(200, { data: { associated_metadata: { id: "media-1" } } }));
    initialFixtures.push(
      json(201, { data: { id: X_ID, text: "First", author_id: "42" } }),
      json(200, {
        data: { id: X_ID, text: "First", author_id: "42", attachments: { media_keys: ["3_original"] } },
        includes: { media: [{ media_key: "3_original", ...(localAlt ? { alt_text: localAlt } : {}) }] },
      }),
      json(400, { title: "Invalid Request", detail: "temporarily rejected" }),
    );
    queue(...initialFixtures);
    let state: string | undefined;
    try { await initial.publish(job(thread)); } catch (e) { state = (e as { adapterState?: string }).adapterState; }
    expect(state).toEqual(expect.any(String));

    const retry = make();
    const retryStart = requestUrlMock.calls.length;
    const remoteMedia = { media_key: "3_different", ...(remoteAlt ? { alt_text: remoteAlt } : {}) };
    queue(
      json(200, X_USER),
      json(200, {
        data: { id: X_ID, text: "First", author_id: "42", attachments: { media_keys: ["3_different"] } },
        includes: { media: [remoteMedia] },
      }),
      json(201, { data: { id: "2000000000000000000", text: "Second" } }),
    );
    await expect(retry.publish(job({ ...thread, delivery: { status: "failed", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1", adapterState: state } }))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("media identity") });
    expect(requestUrlMock.calls.slice(retryStart).filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(0);
  });

  it("does not attach replies when exact root media identity cannot be recovered", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], media: [img("cover.png", 800, 600)] };
    queue(
      json(200, X_USER),
      json(201, { data: { id: "media-1" } }),
      json(201, { data: { id: X_ID, text: "First", author_id: "42" } }),
      json(200, { data: { id: X_ID, text: "First", author_id: "42" } }),
    );
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "unknown", message: expect.stringContaining("exact remote media identity could not be confirmed") });
    expect(requestUrlMock.calls.filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(1);
  });

  it("propagates reply authorization failures after earlier parts went live", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"] };
    queue(json(200, X_USER), json(201, { data: { id: X_ID, text: "First" } }), json(403, { title: "Forbidden", detail: "This endpoint is not available on your API tier." }));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("earlier parts are live") });
  });

  it("refuses automatic retry when a confirmed part has no persistable checkpoint", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], delivery: { status: "publishing", attempts: 1 } as DeliveryJob["delivery"] };
    queue(json(200, X_USER), json(201, { data: { id: X_ID, text: "First" } }), json(400, { title: "Invalid Request", detail: "reply rejected" }));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "unknown", message: expect.stringContaining("safe thread checkpoint could not be saved") });
  });

  it("does not resume a failed partial thread from an unbound timeline match", async () => {
    const thread: Partial<DeliveryJob> = { text: "First\n\nSecond", items: ["First", "Second"], delivery: { status: "failed", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } };
    queue(json(200, X_USER));
    await expect(make().publish(job(thread))).rejects.toMatchObject({ kind: "needs_user", message: expect.stringContaining("no valid confirmed-part checkpoint") });
    expect(requestUrlMock.calls.filter((entry) => entry.url.endsWith("/2/tweets"))).toHaveLength(0);
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
