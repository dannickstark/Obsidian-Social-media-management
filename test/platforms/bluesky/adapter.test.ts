import { getFrontMatterInfo, parseYaml } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Channel, Variant } from "../../../src/model/types";
import { BlueskyAdapter, BLOB_MAX, blueskyFailure } from "../../../src/platforms/bluesky/api";
import { postRkey, tid, tidMicros, tidParts, TID_RE } from "../../../src/platforms/bluesky/tid";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, PNG, trackedJob } from "../contract/harness";
import { bytes, call, hang, json, netError, queue, sentJson, text, type Fixture } from "../http";
import { makeCtx } from "../../ui/ctx";
import { mcpCtx } from "../../mcp/helpers";
import { indexed } from "../../helpers";
import { expandRows } from "../../../src/index/queries";
import { blueskyCase } from "./contract";
import { BS, BS_ACCESS, BS_DID, BS_PASSWORD, BS_PDS, BS_REFRESH, RKEY0, uriOf } from "./fixtures";

/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}, ch: Partial<Channel> = {}): DeliveryJob => {
  const base = blueskyCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant }, channel: { ...base.channel, ...ch } });
};
const make = (extra: Partial<AdapterDeps> = {}) => new BlueskyAdapter({ ...contractDeps(), ...extra });
const created = (i: number) => json(200, BS.created(tidParts(RKEY0, i)));
/** An earlier send's key: its claim 20 minutes ago, with a random offset and clock id (M5 P17b). */
const EARLIER = CONTRACT_NOW - 20 * 60_000;
const KEY_E = tid(EARLIER * 1000 + 58, 211);
const CARD = { url: "https://event.example/x", title: "Event X", description: "Monthly makers evening", image: "https://event.example/cover.png" };
const THREAD = { items: ["One", "Two", "Three"], text: "One\n\nTwo\n\nThree" };

afterEach(() => expectDigestReads());

describe("BlueskyAdapter.publish", () => {
  it("logs in, then posts to the PDS with link and tag facets and a link card with its thumbnail", async () => {
    const linkCard = vi.fn(async () => CARD);
    queue(json(200, BS.session), bytes(200, PNG, "image/png"), json(200, BS.blob), created(0));
    const text = "Tickets: https://event.example/x #osmm";
    expect(await make({ linkCard }).publish(job({ text, items: [text] }))).toEqual({ remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` });
    expect(linkCard).toHaveBeenCalledWith("https://event.example/x");
    expect(call(0).url).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(sentJson(0)).toEqual({ identifier: "you.bsky.social", password: BS_PASSWORD });
    expect(call(1).url).toBe("https://event.example/cover.png");
    expect(call(1).headers).toBeUndefined();
    expect(call(2)).toMatchObject({ url: `${BS_PDS}/xrpc/com.atproto.repo.uploadBlob`, contentType: "image/png", headers: { Authorization: `Bearer ${BS_ACCESS}` } });
    expect(call(3).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.createRecord`);
    expect(sentJson(3)).toEqual({
      repo: BS_DID,
      collection: "app.bsky.feed.post",
      rkey: RKEY0,
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date(CONTRACT_NOW).toISOString(),
        facets: [
          { index: { byteStart: 9, byteEnd: 32 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://event.example/x" }] },
          { index: { byteStart: 33, byteEnd: 38 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "osmm" }] },
        ],
        embed: { $type: "app.bsky.embed.external", external: { uri: CARD.url, title: CARD.title, description: CARD.description, thumb: BS.blob.blob } },
      },
    });
  });

  it("logs in on the channel's own server when it has one (self-hosted PDS)", async () => {
    queue(json(200, BS.session), created(0));
    await make().publish(job({}, {}, { server: "https://pds.example.org" }));
    expect(call(0).url).toBe("https://pds.example.org/xrpc/com.atproto.server.createSession");
    // The DID document names where the repository lives.
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.createRecord`);
  });

  it("uploads images with alt text and aspect ratio, and then leaves the link card out", async () => {
    const linkCard = vi.fn(async () => CARD);
    queue(json(200, BS.session), json(200, BS.blob), json(200, BS.blob), created(0));
    await make({ linkCard }).publish(job({ media: [img("a.png", 1200, 800, { alt: "Stage" }), img("b.png", 800, 800, { alt: undefined })] }, { url: CARD.url }));
    expect(linkCard).not.toHaveBeenCalled();
    expect(call(1)).toMatchObject({ url: `${BS_PDS}/xrpc/com.atproto.repo.uploadBlob`, contentType: "image/png" });
    expect(sentJson(3).record.embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [
        { alt: "Stage", image: BS.blob.blob, aspectRatio: { width: 1200, height: 800 } },
        { alt: "", image: BS.blob.blob, aspectRatio: { width: 800, height: 800 } },
      ],
    });
  });

  it("waits UPLOAD_TIMEOUT_MS for an image upload, the client's timeout for the rest (Task 2 carry)", async () => {
    // The contract client times out after 50 ms; an answer after 120 ms still arrives for an upload, not for a post.
    const late = (f: Fixture): Fixture => (req) => new Promise((resolve) => window.setTimeout(() => resolve(f(req)), 120));
    const adapter = make();
    queue(json(200, BS.session), late(json(200, BS.blob)), created(0));
    expect((await adapter.publish(job({ media: [img("a.png")] }))).remoteId).toBe(uriOf(RKEY0));
    queue(late(created(0)));
    await expect(adapter.publish(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("refuses an image over 1 MB before posting anything", async () => {
    queue(json(200, BS.session));
    const big = make({ readBinary: async () => new Uint8Array(BLOB_MAX + 1).buffer });
    await expect(big.publish(job({ media: [img("big.png")] }))).rejects.toMatchObject({ kind: "invalid_content", message: "Bluesky: big.png is larger than 1 MB." });
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("treats a failed image upload as transient: nothing was posted", async () => {
    queue(json(200, BS.session), json(502, BS.upstream));
    await expect(make().publish(job({ media: [img("a.png")] }))).rejects.toMatchObject({ kind: "transient" });
    queue(json(200, BS.session), netError);
    await expect(make().publish(job({ media: [img("a.png")] }))).rejects.toMatchObject({ kind: "transient" });
    expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
  });

  it("posts without a card when the page can't be fetched (review focus 5)", async () => {
    queue(json(200, BS.session), created(0));
    await make({ linkCard: async () => null }).publish(job({}, { url: CARD.url }));
    expect(sentJson(1).record.embed).toBeUndefined();
    queue(json(200, BS.session), created(0));
    await make({ linkCard: async () => Promise.reject(new Error("offline")) }).publish(job({}, { url: CARD.url }));
    expect(sentJson(3).record.embed).toBeUndefined();
  });

  it("posts the card without a thumbnail when its image can't be fetched or uploaded, or is not a public https address", async () => {
    const card = (image: string) => async () => ({ ...CARD, image });
    const noThumb = { $type: "app.bsky.embed.external", external: { uri: CARD.url, title: CARD.title, description: CARD.description } };
    queue(json(200, BS.session), netError, created(0));
    await make({ linkCard: card(CARD.image) }).publish(job({}, { url: CARD.url }));
    expect(sentJson(2).record.embed).toEqual(noThumb);
    requestUrlMock.reset();
    queue(json(200, BS.session), bytes(200, PNG, "image/png"), json(502, BS.upstream), created(0));
    await make({ linkCard: card(CARD.image) }).publish(job({}, { url: CARD.url }));
    expect(sentJson(3).record.embed).toEqual(noThumb);
    requestUrlMock.reset();
    queue(json(200, BS.session), created(0));
    await make({ linkCard: card("https://127.0.0.1/cover.png") }).publish(job({}, { url: CARD.url }));
    expect(sentJson(1).record.embed).toEqual(noThumb);
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it("posts a thread as replies to the first post", async () => {
    queue(json(200, BS.session), created(0), created(1), created(2));
    await make().publish(job(THREAD));
    const ref = (i: number) => ({ uri: uriOf(tidParts(RKEY0, i)), cid: BS.created("x").cid });
    expect(sentJson(1).record.reply).toBeUndefined();
    expect(sentJson(2)).toMatchObject({ rkey: tidParts(RKEY0, 1), record: { text: "Two", reply: { root: ref(0), parent: ref(0) } } });
    expect(sentJson(3)).toMatchObject({ rkey: tidParts(RKEY0, 2), record: { text: "Three", reply: { root: ref(0), parent: ref(1) } } });
  });

  it("keeps the thread's first post when a later part fails, and says so", async () => {
    queue(json(200, BS.session), created(0), json(400, BS.invalid));
    const res = await make().publish(job(THREAD));
    expect(res.remoteId).toBe(uriOf(RKEY0));
    expect(res.note).toBe(`Part 2 of 3 was not posted, nor any after it: Bluesky: ${BS.invalid.message} (HTTP 400)`);
  });

  it("says a later part may have been posted when its outcome is unknown: a timeout or a dropped connection (partialNote)", async () => {
    for (const answer of [hang, netError]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), created(0), answer);
      const res = await make().publish(job(THREAD));
      expect(res.remoteId).toBe(uriOf(RKEY0));
      expect(res.note).toMatch(/^Part 2 of 3 may have been posted; check on the platform\. Nothing after it was posted: Bluesky: /);
      expect(requestUrlMock.calls).toHaveLength(3);
    }
  });

  it("retries a later part refused for now (5xx, 429), so the thread resumes where it stopped (M5 P17)", async () => {
    queue(json(200, BS.session), created(0), json(502, BS.upstream));
    await expect(make().publish(job(THREAD))).rejects.toMatchObject({
      kind: "transient",
      message: "Bluesky: part 2 of 3 is not posted yet; the parts before it are, and the retry continues the thread: Bluesky: Upstream Failure (HTTP 502)",
    });
    requestUrlMock.reset();
    queue(json(200, BS.session), created(0), json(429, BS.rateLimited, { "ratelimit-reset": String(CONTRACT_NOW / 1000 + 90) }));
    await expect(make().publish(job(THREAD))).rejects.toMatchObject({ kind: "transient", retryAfterMs: 90_000 });
  });

  it("refreshes an expired session and sends the post again", async () => {
    queue(json(200, BS.session), json(400, BS.expired), json(200, BS.refreshed), created(0));
    expect((await make().publish(job())).remoteId).toBe(uriOf(RKEY0));
    expect(call(2)).toMatchObject({ url: `${BS_PDS}/xrpc/com.atproto.server.refreshSession`, headers: { Authorization: `Bearer ${BS_REFRESH}` } });
    expect(call(3).headers).toEqual({ Authorization: `Bearer ${BS.refreshed.accessJwt}` });
  });

  it("treats a refresh that fails to connect as transient: the refused post was not processed", async () => {
    queue(json(200, BS.session), json(400, BS.expired), netError);
    await expect(make().publish(job())).rejects.toMatchObject({ kind: "transient" });
  });

  it("logs in once per session", async () => {
    const adapter = make();
    queue(json(200, BS.session), created(0), created(0));
    await adapter.publish(job());
    await adapter.publish(job());
    expect(requestUrlMock.calls.map((c) => c.url.split("/xrpc/")[1])).toEqual(["com.atproto.server.createSession", "com.atproto.repo.createRecord", "com.atproto.repo.createRecord"]);
  });

  it("logs in again when the app password changes", async () => {
    const adapter = make();
    queue(json(200, BS.session), created(0), json(200, BS.session), created(0));
    await adapter.publish(job());
    await adapter.publish(job({ secret: "wxyz-wxyz-wxyz-wxyz" }));
    expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createSession"))).toHaveLength(2);
  });

  it("adds a mention facet only for a handle that resolves", async () => {
    queue(json(200, BS.session), json(200, BS.resolved), created(0));
    await make().publish(job({ text: "Thanks @alice.bsky.social", items: ["Thanks @alice.bsky.social"] }));
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.identity.resolveHandle?handle=alice.bsky.social`);
    expect(sentJson(2).record.facets).toEqual([{ index: { byteStart: 7, byteEnd: 25 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }] }]);
    queue(json(200, BS.session), json(400, BS.unresolved), created(0));
    await make().publish(job({ text: "Thanks @alice.bsky.social", items: ["Thanks @alice.bsky.social"] }));
    expect(sentJson(5).record.facets).toBeUndefined();
  });

  it("derives every record key from the stored send key, not from the claim time of this attempt (M5 P17b)", async () => {
    queue(json(200, BS.session), json(200, BS.created(KEY_E)), json(200, BS.created(tidParts(KEY_E, 1))));
    await make().publish(job({ items: ["One", "Two"], text: "One\n\nTwo", delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1, sendAt: EARLIER, sendKey: KEY_E } }));
    expect([sentJson(1).rkey, sentJson(2).rkey]).toEqual([KEY_E, tidParts(KEY_E, 1)]);
  });

  it("on a retry, finds the parts an earlier attempt stored by their record keys and posts only the rest after them (M5 P17)", async () => {
    const key = (i: number) => tidParts(KEY_E, i);
    const adapter = make();
    // Attempt 1: the PDS stored part 1, then answered 502.
    queue(json(200, BS.session), json(200, BS.blob), json(502, BS.upstream));
    const first = { ...THREAD, media: [img("a.png")] };
    await expect(adapter.publish(job({ ...first, delivery: { status: "publishing", at: EARLIER, attempts: 1, sendAt: EARLIER, sendKey: KEY_E } }))).rejects.toMatchObject({ kind: "transient" });
    requestUrlMock.reset();
    // Attempt 2, 1 minute later: part 1 is there, parts 2 and 3 are not. Every part is checked before anything is posted.
    queue(json(200, BS.record(key(0), "One")), json(400, BS.notFound), json(400, BS.notFound), json(200, BS.created(key(1))), json(200, BS.created(key(2))));
    const res = await adapter.publish(job({ ...first, delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: EARLIER, sendKey: KEY_E } }));
    expect(res).toEqual({ remoteId: uriOf(key(0)), url: `https://bsky.app/profile/you.bsky.social/post/${key(0)}` });
    const q = (i: number) => `${BS_PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&rkey=${key(i)}`;
    expect(requestUrlMock.calls.map((c) => c.url)).toEqual([q(0), q(1), q(2), `${BS_PDS}/xrpc/com.atproto.repo.createRecord`, `${BS_PDS}/xrpc/com.atproto.repo.createRecord`]);
    // No second copy of part 1, no second upload of its image; the rest replies to the stored part 1.
    const root = { uri: uriOf(key(0)), cid: "bafyreirecord" };
    expect(sentJson(3)).toMatchObject({ rkey: key(1), record: { text: "Two", reply: { root, parent: root } } });
    expect(sentJson(4)).toMatchObject({ rkey: key(2), record: { text: "Three", reply: { root, parent: { uri: uriOf(key(1)) } } } });
  });

  it("a note with the same text, claimed in the same second as another, posts its own record and never takes the other's (M5 P17b)", async () => {
    const A = tid(CONTRACT_NOW * 1000 + 12, 5);
    const B = tid(CONTRACT_NOW * 1000 + 870, 902);
    queue(json(200, BS.session), json(200, BS.created(A)));
    await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW, sendKey: A } }));
    requestUrlMock.reset();
    // B is retried: it asks only for its own key, finds nothing, and creates it.
    queue(json(200, BS.session), json(400, BS.notFound), json(200, BS.created(B)));
    const res = await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: B } }));
    expect(call(1).url).toContain(`rkey=${B}`);
    expect(sentJson(2).rkey).toBe(B);
    expect(res.remoteId).toBe(uriOf(B));
  });

  it("never mixes versions: on a retry, a stored part whose text differs refuses before posting anything (M5 P17c)", async () => {
    const key = (i: number) => tidParts(KEY_E, i);
    const retry = { ...THREAD, delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 2, sendAt: EARLIER, sendKey: KEY_E } };
    const REFUSAL = "An earlier version of this post is partly live on Bluesky; delete it there or mark it published.";
    queue(json(200, BS.session), json(200, BS.record(key(0), "One (before the edit)")), json(400, BS.notFound), json(400, BS.notFound));
    await expect(make().publish(job(retry))).rejects.toMatchObject({ kind: "needs_user", message: REFUSAL });
    expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
    requestUrlMock.reset();
    // A later stored part that differs refuses too, even though part 1 matches.
    queue(json(200, BS.session), json(200, BS.record(key(0), "One")), json(200, BS.record(key(1), "Two, edited")), json(400, BS.notFound));
    await expect(make().publish(job(retry))).rejects.toMatchObject({ kind: "needs_user", message: REFUSAL });
    expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
  });

  it("resumes whenever the claim found a send key on disk, even when attempts can't be read (M5 P17c)", async () => {
    queue(json(200, BS.session), json(200, BS.record(RKEY0)));
    const res = await make().publish(job({ resume: true, delivery: { status: "publishing", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: RKEY0 } }));
    expect(res.remoteId).toBe(uriOf(RKEY0));
    expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
  });

  it("gives a job without a send key a fresh random one, never a key derived from the claim time (M5 P17c)", async () => {
    queue(json(200, BS.session), json(200, BS.created("x")));
    await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 } }));
    const rkey = sentJson(1).rkey as string;
    expect(rkey).toMatch(TID_RE);
    expect(Math.floor(tidMicros(rkey) / 1000)).toBe(CONTRACT_NOW);
    expect(rkey).not.toBe(postRkey(CONTRACT_NOW, 0, "bs/you"));
  });

  it("on a retry whose check can't answer, posts nothing and is transient (M5 P6)", async () => {
    const retry = () => job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 3, sendAt: EARLIER, sendKey: KEY_E } });
    for (const answer of [json(502, BS.upstream), json(400, BS.invalid), netError, hang, text(200, "<html>busy</html>")]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), answer);
      await expect(make().publish(retry())).rejects.toMatchObject({ kind: "transient", message: "Bluesky: could not check whether the earlier attempt went out; nothing was posted." });
      expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
    }
  });

  it("on a retry, checks again with getRecord when createRecord fails: found is posted, not found keeps the error (M5 P17)", async () => {
    const retry = () => job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW, sendKey: RKEY0 } });
    queue(json(200, BS.session), json(400, BS.notFound), json(502, BS.upstream), json(200, BS.record(RKEY0)));
    expect((await make().publish(retry())).remoteId).toBe(uriOf(RKEY0));
    requestUrlMock.reset();
    queue(json(200, BS.session), json(400, BS.notFound), json(400, BS.invalid), json(400, BS.notFound));
    await expect(make().publish(retry())).rejects.toMatchObject({ kind: "invalid_content", message: `Bluesky: ${BS.invalid.message} (HTTP 400)` });
    requestUrlMock.reset();
    queue(json(200, BS.session), json(400, BS.notFound), json(502, BS.upstream), netError);
    await expect(make().publish(retry())).rejects.toMatchObject({ kind: "transient", message: "Bluesky: could not check whether the earlier attempt went out; nothing was posted." });
  });

  it("refuses without a handle or an app password, before any request", async () => {
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an app password for bs/you on this device (Bluesky: Settings → Privacy and security → App passwords).");
    await expect(make().publish(job({}, {}, { handle: "" }))).rejects.toThrow("Set the handle of bs/you to its Bluesky handle (you.bsky.social).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});

describe("the app password and session tokens never reach a message (M5 G4)", () => {
  it("redacts them from error bodies that echo them, in every form", async () => {
    const messages: string[] = [];
    const collect = (e: Error) => void messages.push(e.message);
    queue(json(401, { error: "AuthenticationRequired", message: `Invalid password ${BS_PASSWORD}` }));
    await make().publish(job()).catch(collect);
    queue(json(200, BS.session), json(400, { error: "InvalidRequest", message: `bad token ${BS_ACCESS} / ${encodeURIComponent(BS_REFRESH)}` }));
    await make().publish(job()).catch(collect);
    queue(json(200, BS.session), json(400, BS.expired), json(401, { error: "InvalidToken", message: `refresh ${BS_REFRESH}` }), json(401, BS.badLogin));
    await make().publish(job()).catch(collect);
    queue(json(403, { error: "AccountTakedown", message: `password=${encodeURIComponent(BS_PASSWORD)}` }));
    const v = await make().verify(job().channel, BS_PASSWORD);
    if (!v.ok) messages.push(v.error);
    // A JWT of another session is caught by its shape.
    queue(json(200, BS.session), json(400, { error: "InvalidRequest", message: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghij" }));
    await make().publish(job()).catch(collect);
    expect(messages).toHaveLength(5);
    expect(messages.slice(0, 2)).toEqual(["Bluesky: Invalid password [secret] (HTTP 401)", "Bluesky: bad token [secret] / [secret] (HTTP 400)"]);
    for (const m of messages) for (const s of [BS_PASSWORD, encodeURIComponent(BS_PASSWORD), BS_ACCESS, BS_REFRESH, encodeURIComponent(BS_REFRESH), "eyJzdWIiOiJ4In0"]) expect(m).not.toContain(s);
  });

  it("blueskyFailure reads the rate-limit reset and the account errors", () => {
    const failure = blueskyFailure(() => CONTRACT_NOW);
    const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) });
    expect(failure(res(429, BS.rateLimited, { "RateLimit-Reset": String(CONTRACT_NOW / 1000 + 5) }))).toEqual({ message: "Rate Limit Exceeded", retryAfterMs: 5_000 });
    expect(failure(res(400, BS.takedown))).toEqual({ message: "Account has been taken down", kind: "needs_user" });
    expect(failure(res(400, BS.invalid))).toEqual({ message: BS.invalid.message });
  });
});

describe("BlueskyAdapter.lookup and verify", () => {
  it("can't tell without a send key", async () => {
    expect(await make().lookup(job({ delivery: { status: "check_needed" } }))).toBeNull();
    expect(await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW } }))).toBeNull();
    expect(await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW } }))).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("checks every part of a thread: all there is published; a missing later part is not, with a note, so Post again resumes (M5 P17c)", async () => {
    const key = (i: number) => tidParts(KEY_E, i);
    const check = () => job({ ...THREAD, delivery: { status: "check_needed", at: CONTRACT_NOW, attempts: 1, sendAt: EARLIER, sendKey: KEY_E } });
    queue(json(200, BS.session), json(200, BS.record(key(0), "One")), json(200, BS.record(key(1), "Two")), json(200, BS.record(key(2), "Three")));
    expect(await make().lookup(check())).toEqual({ published: true, remoteId: uriOf(key(0)), url: `https://bsky.app/profile/you.bsky.social/post/${key(0)}` });
    requestUrlMock.reset();
    queue(json(200, BS.session), json(200, BS.record(key(0), "One")), json(400, BS.notFound), json(400, BS.notFound));
    expect(await make().lookup(check())).toEqual({
      published: false,
      note: "Part 1 of 3 is on Bluesky, part 2 and after are not. Use Post again to post the rest after it.",
    });
    requestUrlMock.reset();
    queue(json(200, BS.session), json(400, BS.notFound));
    expect(await make().lookup(check())).toEqual({ published: false });
    requestUrlMock.reset();
    queue(json(200, BS.session), json(200, BS.record(key(0), "One")), json(502, BS.upstream));
    expect(await make().lookup(check())).toBeNull();
  });

  it("stays exact after a new attempt: it asks for the send key's record, not this attempt's (M5 P17)", async () => {
    queue(json(200, BS.session), json(200, BS.record(KEY_E)));
    const found = await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW, attempts: 2, sendAt: EARLIER, sendKey: KEY_E } }));
    expect(call(1).url).toContain(`rkey=${KEY_E}`);
    expect(found).toMatchObject({ published: true, remoteId: uriOf(KEY_E) });
  });

  it("asks for the exact record key of the claim, and can't tell when the answer is anything but found or RecordNotFound (M5 P5)", async () => {
    queue(json(200, BS.session), json(200, BS.record(RKEY0)));
    await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: RKEY0 } }));
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&rkey=${RKEY0}`);
    for (const answer of [json(502, BS.upstream), json(400, BS.invalid), netError]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), answer);
      expect(await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: RKEY0 } }))).toBeNull();
    }
  });

  it("names the account, or says why the login failed", async () => {
    queue(json(200, BS.session), json(401, BS.badLogin));
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: true, account: "@you.bsky.social" });
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: false, error: "Bluesky: Invalid identifier or password (HTTP 401)" });
  });
});

describe("a Bluesky thread retried after a 5xx (M5 P2, P17)", () => {
  it("finds the part the failed attempt stored, posts the rest after it, and keeps one send key throughout (M5 P17b)", async () => {
    const P = "Social/Posts/Bs.md";
    const c = await makeCtx({
      seed: true,
      now: CONTRACT_NOW,
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "bs/you": { status: "scheduled" } } }, body: "One\n---\nTwo\n---\nThree" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, handle: "you.bsky.social", secretId: "osmm-channel-bs-you" });
    c.app.secretStorage.setSecret("osmm-channel-bs-you", BS_PASSWORD);
    c.adapters.register(new BlueskyAdapter(contractDeps()));
    // The send key is random (made at the claim): the answers echo the record key each request asks for or sends.
    const rkeyOf = (req: { url: string; body?: unknown }): string => new URL(req.url).searchParams.get("rkey") ?? (JSON.parse(req.body as string) as { rkey: string }).rkey;
    const record: Fixture = (req) => json(200, BS.record(rkeyOf(req), "One"))(req);
    const made: Fixture = (req) => json(200, BS.created(rkeyOf(req)))(req);
    // The 502 came after the PDS stored part 1: the retry finds it by the stored key and posts parts 2 and 3 after it.
    queue(json(200, BS.session), json(502, BS.upstream), record, json(400, BS.notFound), json(400, BS.notFound), made, made);
    const res = await c.ctx.publish.orchestrator.run(P, "bs/you");
    const creates = requestUrlMock.calls.filter((x) => x.url.endsWith("createRecord")).map((x) => rkeyOf(x));
    const key = (i: number) => tidParts(creates[0]!, i);
    expect(creates).toEqual([key(0), key(1), key(2)]);
    expect(requestUrlMock.calls.find((x) => x.url.includes("getRecord"))?.url).toContain(`rkey=${key(0)}`);
    expect(res).toMatchObject({ status: "published", url: `https://bsky.app/profile/you.bsky.social/post/${key(0)}` });
    const fm = parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, Record<string, unknown>> };
    expect(fm.deliveries["bs/you"]).toMatchObject({ status: "published", remote_id: uriOf(key(0)), attempts: 2 });
    expect(fm.deliveries["bs/you"]).not.toHaveProperty("send_at");
    expect(fm.deliveries["bs/you"]).not.toHaveProperty("send_key");
  });
});

/**
 * A fake PDS for runs through the orchestrator: records by rkey, and a per-part answer to createRecord (`fail`):
 * "503" refuses it without storing it, "stored-then-hang" stores it and never answers.
 */
function fakePds() {
  const records = new Map<string, string>();
  const creates: string[] = [];
  const pds = { records, creates, fail: (_text: string): "503" | "stored-then-hang" | null => null };
  const route: Fixture = (req) => {
    const url = new URL(req.url);
    const method = url.pathname.split("/xrpc/")[1];
    if (method === "com.atproto.server.createSession") return json(200, BS.session)(req);
    if (method === "com.atproto.repo.getRecord") {
      const rkey = url.searchParams.get("rkey")!;
      const text = records.get(rkey);
      return text === undefined ? json(400, BS.notFound)(req) : json(200, BS.record(rkey, text))(req);
    }
    if (method === "com.atproto.repo.createRecord") {
      const body = JSON.parse(req.body as string) as { rkey: string; record: { text: string } };
      creates.push(body.rkey);
      const how = pds.fail(body.record.text);
      if (how === "503") return json(503, BS.upstream)(req);
      if (records.has(body.rkey)) return json(400, { error: "InvalidRequest", message: "Record already exists" })(req);
      records.set(body.rkey, body.record.text);
      if (how === "stored-then-hang") return hang(req);
      return json(200, BS.created(body.rkey))(req);
    }
    return json(404, { error: "MethodNotImplemented", message: method ?? "" })(req);
  };
  queue(...Array.from({ length: 80 }, () => route));
  return pds;
}

const THREAD_NOTE = "Social/Posts/BsThread.md";
const DAY = 86_400_000;

async function threadCtx() {
  const c = await mcpCtx({
    now: CONTRACT_NOW,
    notes: [{ path: THREAD_NOTE, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "bs/you": { status: "scheduled" } } }, body: "One\n---\nTwo\n---\nThree" }],
  });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, handle: "you.bsky.social", secretId: "osmm-channel-bs-you" });
  c.app.secretStorage.setSecret("osmm-channel-bs-you", BS_PASSWORD);
  c.adapters.register(new BlueskyAdapter(contractDeps()));
  const delivery = async () => (parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(THREAD_NOTE)!)).frontmatter) as { deliveries: Record<string, Record<string, unknown>> }).deliveries["bs/you"]!;
  return { c, delivery };
}

describe("a failed Bluesky thread re-planned and sent again (M5 P17c)", () => {
  /** Part 2 answers 503 on every try: the retries run out, and the delivery is failed with part 1 live. */
  async function failedThread() {
    const { c, delivery } = await threadCtx();
    const pds = fakePds();
    pds.fail = (text) => (text === "Two" ? "503" : null);
    expect(await c.ctx.publish.orchestrator.run(THREAD_NOTE, "bs/you")).toMatchObject({ status: "failed" });
    const failed = await delivery();
    const root = failed.send_key as string;
    expect(failed).toMatchObject({ status: "failed" });
    expect(root).toMatch(TID_RE);
    expect([...pds.records]).toEqual([[root, "One"]]);
    return { c, delivery, pds, root };
  }

  async function sendsAgainWithTheSameKey(t: Awaited<ReturnType<typeof failedThread>>) {
    const { c, delivery, pds, root } = t;
    await indexed(c.index, () => c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.sendKey === root);
    expect((await delivery()).send_key).toBe(root);
    pds.fail = () => null;
    expect(await c.ctx.publish.orchestrator.run(THREAD_NOTE, "bs/you")).toMatchObject({ status: "published", url: `https://bsky.app/profile/you.bsky.social/post/${root}` });
    // Part 1 was created exactly once, ever; parts 2 and 3 follow it under the same key.
    expect(pds.creates.filter((k) => k === root)).toHaveLength(1);
    expect([...pds.records]).toEqual([
      [root, "One"],
      [tidParts(root, 1), "Two"],
      [tidParts(root, 2), "Three"],
    ]);
    expect(await delivery()).not.toHaveProperty("send_key");
  }

  it("through the planner's Reschedule", async () => {
    const t = await failedThread();
    const row = expandRows(t.c.index.variants(), 15).find((r) => r.variant.path === THREAD_NOTE && r.channelId === "bs/you")!;
    expect(await t.c.ctx.actions.reschedule(row, { at: CONTRACT_NOW + DAY })).toBe(true);
    await indexed(t.c.index, () => t.c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.at === CONTRACT_NOW + DAY);
    await sendsAgainWithTheSameKey(t);
  });

  it("through the composer's Schedule", async () => {
    const t = await failedThread();
    const v = t.c.index.getVariant(THREAD_NOTE)!;
    expect(await t.c.ctx.composer.schedule(v, { at: CONTRACT_NOW + DAY, reminders: [] }, [])).toBe(true);
    await indexed(t.c.index, () => t.c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.status === "scheduled");
    await sendsAgainWithTheSameKey(t);
  });

  it("through MCP schedule", async () => {
    const t = await failedThread();
    expect(await t.c.call("schedule", { path: THREAD_NOTE, at: "2026-10-09T10:00:00+02:00" })).toMatchObject({ ok: true });
    await indexed(t.c.index, () => t.c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.status === "scheduled");
    await sendsAgainWithTheSameKey(t);
  });
});

describe("an interrupted Bluesky thread found half-posted (M5 P17c)", () => {
  it("check_needed → failed with the note and the key; Post again posts parts 2 and 3 only", async () => {
    const { c, delivery } = await threadCtx();
    const pds = fakePds();
    let first = true;
    // Part 1 is stored, but its answer never comes (the connection times out).
    pds.fail = (text) => (text === "One" && first ? ((first = false), "stored-then-hang") : null);
    expect(await c.ctx.publish.orchestrator.run(THREAD_NOTE, "bs/you")).toEqual({ status: "check_needed" });
    const root = (await delivery()).send_key as string;
    await indexed(c.index, () => c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.status === "check_needed");
    await c.ctx.publish.resolveCheck(THREAD_NOTE, "bs/you");
    const failed = await delivery();
    expect(failed).toMatchObject({ status: "failed", send_key: root, error: "Part 1 of 3 is on Bluesky, part 2 and after are not. Use Post again to post the rest after it." });
    await indexed(c.index, () => c.index.getVariant(THREAD_NOTE)?.deliveries["bs/you"]?.status === "failed");
    expect(await c.ctx.publish.orchestrator.run(THREAD_NOTE, "bs/you")).toMatchObject({ status: "published", url: `https://bsky.app/profile/you.bsky.social/post/${root}` });
    expect(pds.creates).toEqual([root, tidParts(root, 1), tidParts(root, 2)]);
    expect([...pds.records.values()]).toEqual(["One", "Two", "Three"]);
  });
});
