import { getFrontMatterInfo, parseYaml } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Channel, Variant } from "../../../src/model/types";
import { BlueskyAdapter, BLOB_MAX, blueskyFailure } from "../../../src/platforms/bluesky/api";
import { postRkey } from "../../../src/platforms/bluesky/tid";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, PNG, trackedJob } from "../contract/harness";
import { bytes, call, hang, json, netError, queue, sentJson, type Fixture } from "../http";
import { makeCtx } from "../../ui/ctx";
import { blueskyCase } from "./contract";
import { BS, BS_ACCESS, BS_DID, BS_PASSWORD, BS_PDS, BS_REFRESH, RKEY0, uriOf } from "./fixtures";

/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}, ch: Partial<Channel> = {}): DeliveryJob => {
  const base = blueskyCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant }, channel: { ...base.channel, ...ch } });
};
const make = (extra: Partial<AdapterDeps> = {}) => new BlueskyAdapter({ ...contractDeps(), ...extra });
const created = (i: number) => json(200, BS.created(postRkey(CONTRACT_NOW, i, "bs/you")));
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
    const ref = (i: number) => ({ uri: uriOf(postRkey(CONTRACT_NOW, i, "bs/you")), cid: BS.created("x").cid });
    expect(sentJson(1).record.reply).toBeUndefined();
    expect(sentJson(2)).toMatchObject({ rkey: postRkey(CONTRACT_NOW, 1, "bs/you"), record: { text: "Two", reply: { root: ref(0), parent: ref(0) } } });
    expect(sentJson(3)).toMatchObject({ rkey: postRkey(CONTRACT_NOW, 2, "bs/you"), record: { text: "Three", reply: { root: ref(0), parent: ref(1) } } });
  });

  it("keeps the thread's first post when a later part fails, and says so", async () => {
    queue(json(200, BS.session), created(0), json(400, BS.invalid));
    const res = await make().publish(job(THREAD));
    expect(res.remoteId).toBe(uriOf(RKEY0));
    expect(res.note).toBe(`Part 2 of 3 was not posted, nor any after it: Bluesky: ${BS.invalid.message} (HTTP 400)`);
  });

  it("says a later part may have been posted when its outcome is unknown: a timeout, a dropped connection or a 5xx (partialNote)", async () => {
    for (const answer of [hang, netError, json(502, BS.upstream)]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), created(0), answer);
      const res = await make().publish(job(THREAD));
      expect(res.remoteId).toBe(uriOf(RKEY0));
      expect(res.note).toMatch(/^Part 2 of 3 may have been posted; check on the platform\. Nothing after it was posted: Bluesky: /);
      expect(requestUrlMock.calls).toHaveLength(3);
    }
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

  it("on a retry, returns the post an earlier attempt already made (M2b P4 retry de-duplication)", async () => {
    queue(json(200, BS.session), json(200, BS.records("Doors open at 18:00", CONTRACT_NOW - 5 * 60_000)));
    const res = await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2 } }));
    expect(res).toEqual({ remoteId: uriOf("3l5aaaaaaaa22"), url: "https://bsky.app/profile/you.bsky.social/post/3l5aaaaaaaa22" });
    expect(requestUrlMock.calls).toHaveLength(2);
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&limit=10`);
  });

  it("on a retry, posts when the recent posts hold no copy: another text, or older than an hour", async () => {
    queue(json(200, BS.session), json(200, BS.records("Something else", CONTRACT_NOW - 5 * 60_000)), created(0));
    expect((await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2 } }))).remoteId).toBe(uriOf(RKEY0));
    requestUrlMock.reset();
    queue(json(200, BS.session), json(200, BS.records("Doors open at 18:00", CONTRACT_NOW - 61 * 60_000)), created(0));
    expect((await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2 } }))).remoteId).toBe(uriOf(RKEY0));
  });

  it("on a retry whose check can't answer, posts nothing and is transient (M5 P6)", async () => {
    const retry = () => job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 3 } });
    for (const answer of [json(502, BS.upstream), netError, hang, json(200, { nope: true })]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), answer);
      await expect(make().publish(retry())).rejects.toMatchObject({ kind: "transient", message: "Bluesky: could not check whether the earlier attempt went out; nothing was posted." });
      expect(requestUrlMock.calls.filter((c) => c.url.endsWith("createRecord"))).toHaveLength(0);
    }
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
  it("can't tell without a claim time", async () => {
    expect(await make().lookup(job({ delivery: { status: "check_needed" } }))).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("asks for the exact record key of the claim, and can't tell when the answer is anything but found or RecordNotFound (M5 P5)", async () => {
    queue(json(200, BS.session), json(200, BS.record(RKEY0)));
    await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW } }));
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&rkey=${RKEY0}`);
    for (const answer of [json(502, BS.upstream), json(400, BS.invalid), netError]) {
      requestUrlMock.reset();
      queue(json(200, BS.session), answer);
      expect(await make().lookup(job({ delivery: { status: "check_needed", at: CONTRACT_NOW } }))).toBeNull();
    }
  });

  it("names the account, or says why the login failed", async () => {
    queue(json(200, BS.session), json(401, BS.badLogin));
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: true, account: "@you.bsky.social" });
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: false, error: "Bluesky: Invalid identifier or password (HTTP 401)" });
  });
});

describe("a Bluesky post retried after a 5xx (M5 P2, P6)", () => {
  it("finds the copy the failed attempt made and publishes once, without a second createRecord", async () => {
    const P = "Social/Posts/Bs.md";
    const c = await makeCtx({
      seed: true,
      now: CONTRACT_NOW,
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "bs/you": { status: "scheduled" } } }, body: "Doors open at 18:00" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, handle: "you.bsky.social", secretId: "osmm-channel-bs-you" });
    c.app.secretStorage.setSecret("osmm-channel-bs-you", BS_PASSWORD);
    c.adapters.register(new BlueskyAdapter(contractDeps()));
    // The 502 came after the PDS stored the record: the retry finds it in the recent posts.
    queue(json(200, BS.session), json(502, BS.upstream), json(200, BS.records("Doors open at 18:00", CONTRACT_NOW)));
    expect(await c.ctx.publish.orchestrator.run(P, "bs/you")).toMatchObject({ status: "published", url: "https://bsky.app/profile/you.bsky.social/post/3l5aaaaaaaa22" });
    expect(requestUrlMock.calls.map((x) => x.url.split("/xrpc/")[1])).toEqual(["com.atproto.server.createSession", "com.atproto.repo.createRecord", `com.atproto.repo.listRecords?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&limit=10`]);
    const fm = parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, { status: string; remote_id?: string }> };
    expect(fm.deliveries["bs/you"]).toMatchObject({ status: "published", remote_id: uriOf("3l5aaaaaaaa22") });
  });
});
