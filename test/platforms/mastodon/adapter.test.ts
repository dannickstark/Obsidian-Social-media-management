import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Variant } from "../../../src/model/types";
import { ReplacementUnknownError, RemoteRemovedError, UnknownOutcomeError } from "../../../src/platforms/errors";
import { fingerprint, MastodonAdapter, mastodonBase, toMastodonFocus } from "../../../src/platforms/mastodon/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { channel, img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, trackedJob } from "../contract/harness";
import { call, formParts, hang, json, netError, queue, sentJson, text } from "../http";
import { mastodonCase } from "./contract";
import { MA, MA_AT, MA_KEY, MA_TOKEN } from "./fixtures";

/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}): DeliveryJob => {
  const base = mastodonCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant } });
};
const handedOver = (extra: Partial<DeliveryJob["delivery"]> = {}): DeliveryJob => job({ delivery: { status: "handed_over", at: MA_AT, remoteAt: MA_AT, remoteId: "3221", ...extra } });
/** A later attempt of the same send (M5 P17c): the claim found the send key on disk. */
const resumed = (extra: Partial<DeliveryJob> = {}, delivery: Partial<DeliveryJob["delivery"]> = {}): DeliveryJob =>
  job({ resume: true, delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW - 6 * 60_000, sendKey: MA_KEY, ...delivery }, ...extra });
const make = (sleep = vi.fn(async () => undefined)) => new MastodonAdapter({ ...contractDeps(), sleep });
const BASE = "https://mastodon.social";
const AUTH = { Authorization: `Bearer ${MA_TOKEN}` };
const thread = (): Partial<DeliveryJob> => ({ items: ["One", "Two", "Three"], text: "One\n\nTwo\n\nThree" });
const keyOf = (i: number) => call(i).headers?.["Idempotency-Key"];

afterEach(() => expectDigestReads());

describe("MastodonAdapter.publish", () => {
  it("posts to the instance from the handle, with an idempotency key from the send key", async () => {
    queue(json(200, MA.status()), json(200, MA.status()));
    expect(await make().publish(job())).toEqual(mastodonCase.success.expect);
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/statuses`, method: "POST", contentType: "application/json", headers: AUTH });
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00" });
    expect(keyOf(0)).toBe(`osmm-${MA_KEY}-0`);
    // M5 P17: every attempt of the send uses the same key, whatever its claim time.
    await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW + 60_000, attempts: 2, sendAt: CONTRACT_NOW, sendKey: MA_KEY } }));
    expect(keyOf(1)).toBe(`osmm-${MA_KEY}-0`);
  });

  it("appends the link to the first part only (Task 6 carry)", async () => {
    queue(json(200, MA.status("1")), json(200, MA.status("2")));
    await make().publish(job({ items: ["One", "Two"], text: "One\n\nTwo" }, { url: "https://event.example/x" }));
    expect(sentJson(0)).toEqual({ status: "One\n\nhttps://event.example/x" });
    expect(sentJson(1)).toEqual({ status: "Two", in_reply_to_id: "1" });
  });

  it("uploads images with alt text and a converted focal point", async () => {
    queue(json(200, MA.media), json(200, MA.status()));
    await make().publish(job({ media: [img("cover.png", 1080, 1080, { alt: "Crowd at the door", focus: [0.42, 0.155] })] }));
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v2/media`, method: "POST", headers: AUTH });
    expect(keyOf(0)).toBeUndefined();
    expect(formParts(0)).toEqual({ file: { filename: "cover.png", type: "image/png", size: 8 }, description: { value: "Crowd at the door", size: 17 }, focus: { value: "-0.16,0.69", size: 10 } });
    expect(sentJson(1)).toEqual({ status: "Doors open at 18:00", media_ids: ["22348641"] });
  });

  it("waits for an image that is still processing", async () => {
    const sleep = vi.fn(async () => undefined);
    queue(json(202, MA.processing), json(206, MA.processing), json(200, { ...MA.processing, url: "https://files.mastodon.social/x.png" }), json(200, MA.status()));
    await make(sleep).publish(job({ media: [img("cover.png")] }));
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe(`${BASE}/api/v1/media/22348642`);
    expect(sentJson(3).media_ids).toEqual(["22348642"]);
  });

  it("treats a failed upload or processing as transient: nothing was posted", async () => {
    queue(json(503, MA.unavailable));
    await expect(make().publish(job({ media: [img("cover.png")] }))).rejects.toMatchObject({ kind: "transient" });
    queue(json(202, MA.processing), json(500, MA.unavailable));
    await expect(make().publish(job({ media: [img("cover.png")] }))).rejects.toMatchObject({ kind: "transient" });
    expect(requestUrlMock.calls.map((c) => c.url)).not.toContain(`${BASE}/api/v1/statuses`);
  });

  it("posts a thread as replies, each part with its own key, and keeps the first post when a later part is refused", async () => {
    queue(json(200, MA.status("1")), json(200, MA.status("2")), json(200, MA.status("3")));
    await make().publish(job(thread()));
    expect(sentJson(1)).toEqual({ status: "Two", in_reply_to_id: "1" });
    expect(sentJson(2)).toEqual({ status: "Three", in_reply_to_id: "2" });
    expect([keyOf(0), keyOf(1), keyOf(2)]).toEqual([`osmm-${MA_KEY}-0`, `osmm-${MA_KEY}-1`, `osmm-${MA_KEY}-2`]);
    queue(json(200, MA.status("1")), json(422, MA.tooLong));
    const res = await make().publish(job(thread()));
    expect(res).toMatchObject({ remoteId: "1" });
    expect(res.note).toBe("Part 2 of 3 was not posted, nor any after it: Mastodon: Validation failed: Text character limit of 500 exceeded (HTTP 422)");
  });

  it("retries a thread cut short by a 5xx, and the retry continues it without posting a live part again (M5 P17c)", async () => {
    queue(json(200, MA.status("1", "One")), json(503, MA.unavailable));
    const err = await make()
      .publish(job(thread()))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "transient", message: expect.stringContaining("part 2 of 3 is not posted yet; the parts before it are, and the retry continues the thread") });
    requestUrlMock.reset();
    // Mastodon answers a repeated Idempotency-Key with the post it already made (for an hour).
    queue(json(200, MA.status("1", "One")), json(200, MA.status("2", "Two")), json(200, MA.status("3", "Three")));
    expect(await make().publish(resumed(thread()))).toEqual({ remoteId: "1", url: "https://mastodon.social/@you/1" });
    expect([keyOf(0), keyOf(1), keyOf(2)]).toEqual([`osmm-${MA_KEY}-0`, `osmm-${MA_KEY}-1`, `osmm-${MA_KEY}-2`]);
    expect(sentJson(1)).toEqual({ status: "Two", in_reply_to_id: "1" });
  });

  it("refuses to mix versions: a resumed send whose live part holds other text posts nothing more (M5 P17c)", async () => {
    queue(json(200, MA.status("1", "An older first part")));
    await expect(make().publish(resumed(thread()))).rejects.toMatchObject({
      kind: "needs_user",
      message: "Mastodon: an earlier version of this post is partly live on Mastodon; delete it there or mark it published.",
    });
    expect(requestUrlMock.calls).toHaveLength(1);
    queue(json(200, MA.status("1", "One")), json(200, MA.status("2", "An older second part")));
    await expect(make().publish(resumed(thread()))).rejects.toMatchObject({ kind: "needs_user" });
  });

  it("recognises a resumed live part regardless of mentions, links and HTML", async () => {
    const t = "Hi @anna@example.social, see https://event.example/x";
    queue(json(200, { ...MA.status("1"), content: '<p>Hi <span class="h-card"><a href="https://example.social/@anna">@<span>anna</span></a></span>, see <a href="https://event.example/x"><span class="invisible">https://</span><span class="">event.example/x</span><span class="invisible"></span></a></p>' }));
    expect(await make().publish(resumed({ items: [t], text: t }))).toMatchObject({ remoteId: "1" });
  });

  it("checks the profile before a resumed send whose keys Mastodon may have forgotten (over an hour)", async () => {
    const late = { sendAt: CONTRACT_NOW - 2 * 3_600_000 };
    queue(json(200, MA.account), json(200, [MA.status("1", "One", CONTRACT_NOW - 2 * 3_600_000 + 1_000)]));
    await expect(make().publish(resumed(thread(), late))).rejects.toMatchObject({
      kind: "needs_user",
      message: "Mastodon: an earlier attempt at this post is live on Mastodon, and Mastodon only recognises a repeat within an hour; delete it there or mark it published.",
    });
    expect(requestUrlMock.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(call(1).url).toBe(`${BASE}/api/v1/accounts/109000000000000001/statuses?limit=40&exclude_reblogs=true`);
    requestUrlMock.reset();
    // A boost of the same text is someone else's post: never taken for ours.
    const boost = { ...MA.status("98", "Doors open at 18:00", CONTRACT_NOW - 3_600_000), reblog: MA.status("55") };
    queue(json(200, MA.account), json(200, [MA.status("9", "Something else"), boost]), json(200, MA.status()));
    expect(await make().publish(resumed({}, late))).toEqual(mastodonCase.success.expect);
    requestUrlMock.reset();
    // A check that can't answer posts nothing (M5 P6).
    queue(json(200, MA.account), json(500, MA.unavailable));
    await expect(make().publish(resumed({}, late))).rejects.toMatchObject({ kind: "transient", message: "Mastodon: could not check whether the earlier attempt went out; nothing was posted." });
    expect(requestUrlMock.calls).toHaveLength(2);
    requestUrlMock.reset();
    // Without a send time, every post in the list counts, however old (no time filter).
    queue(json(200, MA.account), json(200, [MA.status("1", "One", CONTRACT_NOW - 5 * 3_600_000)]));
    await expect(make().publish(resumed(thread(), { sendAt: undefined }))).rejects.toMatchObject({ kind: "needs_user" });
  });

  it("runs the late-key check at each part's commit, after the uploads (Task 9 fix round 1)", async () => {
    let clock = CONTRACT_NOW;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const adapter = new MastodonAdapter({ ...contractDeps(), now: () => clock, sleep });
    // 55 minutes old only once the image is processed.
    const sendAt = CONTRACT_NOW - 55 * 60_000 + 500;
    queue(json(202, MA.processing), json(200, { ...MA.processing, url: "https://files.mastodon.social/x.png" }), json(200, MA.account), json(200, []), json(200, MA.status()));
    expect(await adapter.publish(resumed({ media: [img("cover.png")] }, { sendAt }))).toEqual(mastodonCase.success.expect);
    expect(requestUrlMock.calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`)).toEqual([
      "POST /api/v2/media",
      "GET /api/v1/media/22348642",
      "GET /api/v1/accounts/verify_credentials",
      "GET /api/v1/accounts/109000000000000001/statuses?limit=40&exclude_reblogs=true",
      "POST /api/v1/statuses",
    ]);
    requestUrlMock.reset();
    // The window closes between two parts: the parts still to send are checked, not the ones this attempt holds.
    const times = [CONTRACT_NOW, CONTRACT_NOW + 10 * 60_000];
    const late = new MastodonAdapter({ ...contractDeps(), now: () => times.shift() ?? CONTRACT_NOW + 10 * 60_000 });
    queue(json(200, MA.status("1", "One")), json(200, MA.account), json(200, [MA.status("1", "One")]), json(200, MA.status("2", "Two")), json(200, MA.status("3", "Three")));
    expect(await late.publish(resumed(thread(), { sendAt: CONTRACT_NOW - 50 * 60_000 }))).toMatchObject({ remoteId: "1" });
    expect(requestUrlMock.calls).toHaveLength(5);
    requestUrlMock.reset();
    const times2 = [CONTRACT_NOW, CONTRACT_NOW + 10 * 60_000];
    const late2 = new MastodonAdapter({ ...contractDeps(), now: () => times2.shift() ?? CONTRACT_NOW + 10 * 60_000 });
    queue(json(200, MA.status("1", "One")), json(200, MA.account), json(200, [MA.status("2", "Two", CONTRACT_NOW - 49 * 60_000)]));
    await expect(late2.publish(resumed(thread(), { sendAt: CONTRACT_NOW - 50 * 60_000 }))).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(3);
  });

  it("refuses without an instance or a token, before any request", async () => {
    const noInstance = job();
    noInstance.channel = { ...noInstance.channel, handle: "you" };
    await expect(make().publish(noInstance)).rejects.toThrow("Set the handle of ma/you to @you@your.instance (or set its server address).");
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an access token for ma/you on this device (Mastodon: Preferences → Development → New application, scopes read and write).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("uses the channel's server when it is set, else the exact host and port of the handle, and never guesses", () => {
    const base = (handle: string, server?: string) => mastodonBase(channel("ma/you", { handle, ...(server ? { server } : {}) }));
    expect(base("@you@mastodon.social", "https://social.example:8443")).toBe("https://social.example:8443");
    expect(base("@you@mastodon.social")).toBe("https://mastodon.social");
    expect(base("you@Social.Example:8443")).toBe("https://social.example:8443");
    expect(base("https://www.masto.example/@you")).toBe("https://www.masto.example");
    expect(base("https://masto.example:8443/@you")).toBe("https://masto.example:8443");
    // Ambiguous: no account on an instance. The server address is needed.
    for (const handle of ["you", "mastodon.social", "https://mastodon.social", "http://masto.example/@you"]) expect(base(handle), handle).toBeNull();
  });

  it("never shows the access token, whole or URL-encoded, even when the server echoes it", async () => {
    for (const echoed of [MA_TOKEN, encodeURIComponent(MA_TOKEN), `Bearer ${MA_TOKEN}`]) {
      queue(json(401, { error: `The access token ${echoed} is invalid` }));
      const err = (await make()
        .publish(job())
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("[secret]");
      expect(err.message).not.toContain(MA_TOKEN);
      expect(err.message).not.toContain(encodeURIComponent(MA_TOKEN));
    }
  });
});

describe("MastodonAdapter native scheduling (#90)", () => {
  it("hands a post over with scheduled_at, without an Idempotency-Key", async () => {
    queue(json(200, MA.scheduled()));
    expect(await make().schedule(job({ delivery: { status: "handed_over", at: MA_AT, remoteAt: MA_AT } }))).toEqual({ remoteId: "3221" });
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/statuses`, method: "POST" });
    expect(call(0).headers).toEqual(AUTH);
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00", scheduled_at: "2026-10-08T15:30:00.000Z" });
  });

  it("treats a 5xx, a timeout or an unreadable answer to the hand-over as an unknown outcome (M5 P2)", async () => {
    const handOver = () => make().schedule(job({ delivery: { status: "handed_over", at: MA_AT, remoteAt: MA_AT } }));
    queue(json(503, MA.unavailable));
    await expect(handOver()).rejects.toMatchObject({ kind: "unknown", message: "Mastodon: the server answered with an error (HTTP 503) while posting, so it is not known whether it went out." });
    queue(hang);
    await expect(handOver()).rejects.toBeInstanceOf(UnknownOutcomeError);
    queue(json(200, {}));
    await expect(handOver()).rejects.toMatchObject({ kind: "unknown" });
    queue(text(200, "<html>busy</html>"));
    await expect(handOver()).rejects.toMatchObject({ kind: "unknown" });
    queue(json(422, MA.tooSoon));
    await expect(handOver()).rejects.toMatchObject({ kind: "invalid_content" });
  });

  it("never hands over a thread", async () => {
    const j = job({ ...thread(), delivery: { status: "handed_over", at: MA_AT } });
    expect(make().scheduleRefusal(j)).toBe("Mastodon can't schedule a thread, so this one is posted from Obsidian at its time.");
    await expect(make().schedule(j)).rejects.toMatchObject({ kind: "invalid_content" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("moves a handed-over post to its new time", async () => {
    queue(json(200, MA.scheduled("3221", MA_AT + 30 * 60_000)));
    expect(await make().update(handedOver({ at: MA_AT + 30 * 60_000 }), { content: false, time: true })).toEqual({});
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "PUT" });
    expect(sentJson(0)).toEqual({ scheduled_at: "2026-10-08T16:00:00.000Z" });
    // A retry-safe change to an existing object (M5 P2): a 5xx is transient.
    queue(json(502, MA.unavailable));
    await expect(make().update(handedOver({ at: MA_AT + 30 * 60_000 }), { content: false, time: true })).rejects.toMatchObject({ kind: "transient" });
    queue(json(404, MA.notFound));
    await expect(make().update(handedOver({ at: MA_AT + 30 * 60_000 }), { content: false, time: true })).rejects.toMatchObject({
      kind: "needs_user",
      message: "Mastodon: the post is no longer scheduled there (it went out, or it was deleted on Mastodon); nothing was changed.",
    });
  });

  it("replaces a handed-over post whose text changed: remove first, then schedule the new one", async () => {
    queue(json(200, {}), json(200, MA.scheduled("3222")));
    const j = handedOver();
    j.items = ["Doors open at 18:30"];
    j.text = "Doors open at 18:30";
    expect(await make().update(j, { content: true, time: false })).toEqual({ remoteId: "3222" });
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "DELETE" });
    expect(sentJson(1)).toEqual({ status: "Doors open at 18:30", scheduled_at: "2026-10-08T15:30:00.000Z" });
  });

  it("says the platform copy is gone when the new version is refused after the removal", async () => {
    queue(json(200, {}), json(422, MA.tooSoon));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toBeInstanceOf(RemoteRemovedError);
  });

  it("never says the copy is gone when the new version's outcome is unknown after the removal (M5 P4)", async () => {
    for (const answer of [hang, netError, json(503, MA.unavailable), json(200, {})]) {
      requestUrlMock.reset();
      queue(json(200, {}), answer);
      const err = await make()
        .update(handedOver(), { content: true, time: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplacementUnknownError);
      expect(err).not.toBeInstanceOf(RemoteRemovedError);
      expect(err).toMatchObject({ kind: "unknown", message: expect.stringMatching(/^Mastodon: the old scheduled post was removed; the new one may or may not be scheduled\. \(Mastodon: .+\)$/) });
    }
  });

  it("changes nothing when the scheduled post is already gone", async () => {
    queue(json(404, MA.notFound));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("checks whether an unanswered removal happened before scheduling again", async () => {
    queue(hang, json(404, MA.notFound), json(200, MA.scheduled("3222")));
    expect(await make().update(handedOver(), { content: true, time: false })).toEqual({ remoteId: "3222" });
    expect(call(1)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "GET" });
    requestUrlMock.reset();
    queue(hang, json(200, MA.scheduled()));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toMatchObject({ kind: "transient" });
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it("checks a removal answered with a 5xx the same way, and says nothing changed only when the old post is still there", async () => {
    const replace = () =>
      make()
        .update(handedOver(), { content: true, time: false })
        .catch((e: unknown) => e);
    // P3a: the old post is gone after all: the new version is scheduled.
    queue(json(503, MA.unavailable), json(404, MA.notFound), json(200, MA.scheduled("3222")));
    expect(await replace()).toEqual({ remoteId: "3222" });
    expect(call(1)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "GET" });
    // P3b: the old post is still there: nothing was changed.
    requestUrlMock.reset();
    queue(json(503, MA.unavailable), json(200, MA.scheduled()));
    expect(await replace()).toMatchObject({ kind: "transient", message: "Mastodon: the old scheduled post could not be removed, so nothing was changed. Try again." });
    expect(requestUrlMock.calls).toHaveLength(2);
    // P3c: the check can't tell: the old post may be gone, and nothing new was scheduled (Task 14 parks it on check_needed).
    for (const [first, check] of [
      [json(503, MA.unavailable), hang],
      [json(503, MA.unavailable), json(500, MA.unavailable)],
      [hang, hang],
      [netError, json(502, MA.unavailable)],
    ] as const) {
      requestUrlMock.reset();
      queue(first, check);
      const err = await replace();
      expect(err).toBeInstanceOf(ReplacementUnknownError);
      expect(err).toMatchObject({ kind: "unknown", message: "Mastodon: the old scheduled post may have been removed; nothing new was scheduled." });
      expect(requestUrlMock.calls).toHaveLength(2);
    }
  });

  it("edits a live post, but not a live thread", async () => {
    queue(json(200, MA.status()));
    await make().update(job({ delivery: { status: "published", remoteId: "113258473000000001" } }));
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/statuses/113258473000000001`, method: "PUT" });
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00", media_ids: [] });
    await expect(make().update(job({ ...thread(), delivery: { status: "published", remoteId: "1" } }))).rejects.toMatchObject({ kind: "invalid_content" });
    queue(text(200, "<html>busy</html>"));
    await expect(make().update(job({ delivery: { status: "published", remoteId: "113258473000000001" } }))).rejects.toMatchObject({ kind: "unknown" });
  });

  it("takes a post off the schedule, and refuses when it is no longer there", async () => {
    queue(json(200, {}), json(404, MA.notFound));
    await make().cancel(handedOver());
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "DELETE" });
    await expect(make().cancel(handedOver())).rejects.toMatchObject({ kind: "needs_user" });
    queue(json(503, MA.unavailable));
    await expect(make().cancel(handedOver())).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("MastodonAdapter.lookup", () => {
  it("reports a handed-over post that is still scheduled, and its platform time", async () => {
    queue(json(200, MA.scheduled("3221", MA_AT + 60_000)));
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "3221", scheduledAt: MA_AT + 60_000 });
  });

  it("finds the published post once the scheduled one is gone, and can't tell when it finds nothing", async () => {
    queue(json(404, MA.notFound), json(200, MA.account), json(200, [MA.status("5", "Doors open at 18:00", MA_AT)]));
    expect(await make().lookup(handedOver())).toEqual({ published: true, remoteId: "5", url: "https://mastodon.social/@you/5" });
    expect(call(2).url).toBe(`${BASE}/api/v1/accounts/109000000000000001/statuses?limit=40&exclude_reblogs=true`);
    queue(json(404, MA.notFound), json(200, MA.account), json(200, []));
    expect(await make().lookup(handedOver())).toBeNull();
  });

  it("finds an interrupted hand-over in the scheduled list, and says not found when it is nowhere", async () => {
    queue(json(200, [MA.scheduled("3999", MA_AT + 3_600_000, "Other"), MA.scheduled("3221")]));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false, remoteId: "3221", scheduledAt: MA_AT });
    expect(call(0).url).toBe(`${BASE}/api/v1/scheduled_statuses?limit=40`);
    queue(json(200, []), json(200, MA.account), json(200, []));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false });
  });

  it("looks for an interrupted post from the send's first claim, and can't tell when it misses (M5 P5)", async () => {
    // Created by the first attempt; the second attempt (claimed later) timed out after Mastodon replayed it.
    const d = { status: "check_needed" as const, at: CONTRACT_NOW + 6 * 60_000, sendAt: CONTRACT_NOW, sendKey: MA_KEY };
    queue(json(200, MA.account), json(200, [MA.status("7", "Doors open at 18:00", CONTRACT_NOW + 2_000)]));
    expect(await make().lookup(job({ delivery: d }))).toEqual({ published: true, remoteId: "7", url: "https://mastodon.social/@you/7" });
    queue(json(200, MA.account), json(500, MA.unavailable));
    expect(await make().lookup(job({ delivery: d }))).toBeNull();
  });

  it("checks every part of a thread, and says which part is missing (whole-thread lookup)", async () => {
    const d = { status: "check_needed" as const, at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: MA_KEY };
    const reply = (id: string, t: string, parent: string) => ({ ...MA.status(id, t, CONTRACT_NOW + 2_000), in_reply_to_id: parent });
    const root = [MA.status("1", "One", CONTRACT_NOW + 1_000)];
    queue(json(200, MA.account), json(200, root), json(200, { ancestors: [], descendants: [reply("2", "Two", "1"), reply("8", "Three", "1"), reply("3", "Three", "2")] }));
    expect(await make().lookup(job({ ...thread(), delivery: d }))).toEqual({ published: true, remoteId: "1", url: "https://mastodon.social/@you/1" });
    expect(call(2).url).toBe(`${BASE}/api/v1/statuses/1/context`);
    queue(json(200, MA.account), json(200, root), json(200, { ancestors: [], descendants: [reply("2", "Two", "1"), reply("8", "Three", "1")] }));
    expect(await make().lookup(job({ ...thread(), delivery: d }))).toEqual({
      published: false,
      note: "Part 2 of 3 is on Mastodon, part 3 and after are not. Post again posts the rest only within about 55 minutes of the first attempt; after that it is refused by design, so post the rest on Mastodon yourself and mark it published.",
    });
    // The replies can't be read: can't tell.
    queue(json(200, MA.account), json(200, root), json(500, MA.unavailable));
    expect(await make().lookup(job({ ...thread(), delivery: d }))).toBeNull();
    // The first part isn't found: can't tell (a text search, M5 P5).
    queue(json(200, MA.account), json(200, []));
    expect(await make().lookup(job({ ...thread(), delivery: d }))).toBeNull();
  });

  it("can't tell for an image-only or emoji-only post, and never takes a boost for the post", async () => {
    const d = { status: "check_needed" as const, at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: MA_KEY };
    expect(await make().lookup(job({ items: [""], text: "", media: [img("cover.png")], delivery: d }))).toBeNull();
    expect(await make().lookup(job({ items: ["\u{1F389}\u{1F389}"], text: "\u{1F389}\u{1F389}", delivery: d }))).toBeNull();
    expect(await make().lookup({ ...handedOver({ remoteId: undefined }), items: ["\u{1F389}"], text: "\u{1F389}" })).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
    const boost = { ...MA.status("99", "Doors open at 18:00", CONTRACT_NOW + 30_000), reblog: MA.status("55") };
    queue(json(200, MA.account), json(200, [boost]));
    expect(await make().lookup(job({ delivery: d }))).toBeNull();
    expect(call(1).url).toBe(`${BASE}/api/v1/accounts/109000000000000001/statuses?limit=40&exclude_reblogs=true`);
  });

  it("matches by text regardless of HTML, case, mentions and links (M5 P5)", () => {
    expect(fingerprint("Doors open at 18:00!")).toBe(fingerprint("doors OPEN at 18:00"));
    expect(fingerprint("Thanks @anna@example.social! https://event.example/x?a=1")).toBe(fingerprint("Thanks @anna!"));
    expect(fingerprint("Doors open")).not.toBe(fingerprint("Doors closed"));
    expect(toMastodonFocus([0.5, 0.5])).toBe("0.00,0.00");
  });
});

describe("MastodonAdapter.verify", () => {
  it("names the account", async () => {
    queue(json(200, MA.account), json(401, MA.invalidToken));
    expect(await make().verify(job().channel, MA_TOKEN)).toEqual({ ok: true, account: "@you@mastodon.social" });
    expect(await make().verify(job().channel, MA_TOKEN)).toEqual({ ok: false, error: "Mastodon: The access token is invalid (HTTP 401)" });
  });
});
