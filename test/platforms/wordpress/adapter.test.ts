import { afterEach, describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Variant } from "../../../src/model/types";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import { RemoteRemovedError, UnknownOutcomeError } from "../../../src/platforms/errors";
import type { DeliveryJob } from "../../../src/platforms/types";
import { WordPressAdapter } from "../../../src/platforms/wordpress/api";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, trackedJob } from "../contract/harness";
import { call, hang, json, netError, queue, sentJson, text } from "../http";
import { wordpressCase } from "./contract";
import { WP, WP_API, WP_AT, WP_BASIC, WP_PASSWORD, WP_SITE } from "./fixtures";

/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}): DeliveryJob => {
  const base = wordpressCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant } });
};
const resolveEmbed: AdapterDeps["resolveEmbed"] = (target) =>
  target === "cover.png" ? { path: "Social/cover.png", name: "cover.png", mime: "image/png" } : null;
const make = () => new WordPressAdapter({ ...contractDeps(), resolveEmbed });
const handedOver = (extra: Partial<DeliveryJob["delivery"]> = {}): DeliveryJob =>
  job({ delivery: { status: "handed_over", at: WP_AT, remoteAt: WP_AT, remoteId: "412", ...extra } });
const UPLOADS = "https://eventx.berlin/wp-content/uploads/2026/10";

afterEach(() => expectDigestReads());

describe("WordPressAdapter.publish", () => {
  it("posts the raw Markdown body as HTML with Basic auth", async () => {
    queue(json(201, WP.post("publish")));
    expect(await make().publish(job({ text: "Text with embeds stripped", body: "Six months ago we hosted the first Event X." }))).toEqual(wordpressCase.success.expect);
    expect(call(0)).toMatchObject({ url: `${WP_API}/posts`, method: "POST", contentType: "application/json", headers: { Authorization: `Basic ${WP_BASIC}` } });
    expect(sentJson(0)).toEqual({ title: "We're hosting Event X again", content: "<p>Six months ago we hosted the first Event X.</p>", status: "publish", slug: "hosting-event-x-again", categories: [], tags: [] });
  });

  it("uploads body images, extra media and the featured image, and resolves or creates categories and tags", async () => {
    queue(
      json(201, WP.media(77, "cover.png")),
      json(200, { ...WP.media(77, "cover.png"), alt_text: "Crowd" }),
      json(201, WP.media(78, "map.png")),
      json(201, WP.media(79, "hero.png")),
      json(200, WP.categories),
      json(200, []),
      json(201, WP.createdTag),
      json(201, WP.post("publish")),
    );
    const j = job(
      { text: "Text", items: ["Text"], body: "![[cover.png]]\n\nText", media: [img("map.png", 1080, 1080, { alt: undefined })], featured: img("hero.png", 1080, 1080, { alt: undefined }) },
      { mediaMeta: { "cover.png": { alt: "Crowd" } }, wordpress: { slug: "hosting-event-x-again", categories: ["Community & Events"], tags: ["events"], excerpt: "Short" } },
    );
    await make().publish(j);
    expect(call(0)).toMatchObject({ url: `${WP_API}/media`, contentType: "image/png", headers: { "Content-Disposition": 'attachment; filename="cover.png"' } });
    expect(sentJson(1)).toEqual({ alt_text: "Crowd" });
    expect(call(4).url).toBe(`${WP_API}/categories?search=Community%20%26%20Events&per_page=100&_fields=id,name`);
    expect(sentJson(6)).toEqual({ name: "events" });
    expect(sentJson(7)).toEqual({
      title: "We're hosting Event X again",
      content: `<figure class="wp-block-image"><img src="${UPLOADS}/cover.png" alt="Crowd" /></figure>\n<p>Text</p>\n<figure class="wp-block-image"><img src="${UPLOADS}/map.png" alt="" /></figure>`,
      status: "publish",
      slug: "hosting-event-x-again",
      excerpt: "Short",
      categories: [6],
      tags: [12],
      featured_media: 79,
    });
  });

  it("uses the id of a term that already exists", async () => {
    queue(json(200, []), json(400, WP.termExists), json(201, WP.post("publish")));
    await make().publish(job({}, { wordpress: { slug: "hosting-event-x-again", categories: ["News"], tags: [] } }));
    expect(sentJson(2).categories).toEqual([9]);
  });

  it("uploads an image once per session, so an update doesn't duplicate it", async () => {
    const adapter = make();
    const j = job({ text: "", items: [""], body: "![[cover.png]]" });
    queue(json(201, WP.media(77, "cover.png")), json(201, WP.post("publish")), json(200, WP.post("publish")));
    await adapter.publish(j);
    await adapter.update(job({ ...j, delivery: { status: "published", remoteId: "412" } }));
    expect(requestUrlMock.calls.map((c) => c.url)).toEqual([`${WP_API}/media`, `${WP_API}/posts`, `${WP_API}/posts/412`]);
  });

  it("on a resumed send, returns the article made by an earlier attempt using the stable send time", async () => {
    const sentAt = CONTRACT_NOW - 20 * 60_000;
    queue(json(200, [WP.post("publish", { modified_gmt: new Date(sentAt).toISOString().slice(0, 19) })]));
    expect(await make().publish(job({ resume: true, delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: sentAt } }))).toEqual(wordpressCase.success.expect);
    expect(call(0).url).toBe(`${WP_API}/posts?slug=hosting-event-x-again&status=publish,future,draft,pending,private&context=edit&_fields=id,link,status,date_gmt,modified_gmt`);
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("fails closed when the retry check cannot answer, and posts nothing", async () => {
    for (const answer of [netError, json(503, WP.critical)]) {
      queue(answer);
      await expect(make().publish(job({ resume: true, delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2, sendAt: CONTRACT_NOW - 6 * 60_000 } }))).rejects.toMatchObject({
        kind: "transient",
        message: "WordPress: could not check whether the earlier attempt went out; nothing was posted.",
      });
      expect(requestUrlMock.calls).toHaveLength(1);
      requestUrlMock.reset();
    }
  });

  it("refuses an insecure site or a missing user name or password before any request", async () => {
    const insecure = job();
    insecure.channel = { ...insecure.channel, server: "http://eventx.berlin" };
    await expect(make().publish(insecure)).rejects.toThrow("wp/eventx-berlin: WordPress needs an https:// site address; application passwords only work over HTTPS.");
    const noLogin = job();
    noLogin.channel = { ...noLogin.channel, login: undefined };
    await expect(make().publish(noLogin)).rejects.toThrow("Set the WordPress user name of wp/eventx-berlin in its channel settings.");
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an application password for wp/eventx-berlin on this device (WordPress: Users → Profile → Application passwords).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("never exposes the application password or its Basic-auth value in an error", async () => {
    queue(json(401, { code: "incorrect_password", message: `Credential ${WP_PASSWORD}; Authorization Basic ${WP_BASIC}` }));
    let message = "";
    try {
      await make().publish(job());
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(WP_PASSWORD);
    expect(message).not.toContain(WP_BASIC);
  });
});

describe("WordPressAdapter native scheduling (#92)", () => {
  it("hands the article over as a future post in UTC", async () => {
    queue(json(201, WP.future()));
    expect(await make().schedule(handedOver({ remoteId: undefined }))).toEqual({ remoteId: "412", url: "https://eventx.berlin/?p=412" });
    expect(sentJson(0)).toMatchObject({ status: "future", date_gmt: "2026-10-08T15:30:00" });
  });

  it("treats a hand-over 5xx, timeout or unreadable answer as unknown, never retry-safe", async () => {
    for (const answer of [json(503, WP.critical), hang, json(201, {}), text(201, "busy")]) {
      queue(answer);
      await expect(make().schedule(handedOver({ remoteId: undefined }))).rejects.toBeInstanceOf(UnknownOutcomeError);
      requestUrlMock.reset();
    }
  });

  it("updates a handed-over article with its new time, and a live one without touching its status", async () => {
    queue(json(200, WP.future()), json(200, WP.post("publish")));
    await make().update(handedOver({ at: WP_AT + 3_600_000 }), { content: true, time: true });
    expect(call(0).url).toBe(`${WP_API}/posts/412`);
    expect(sentJson(0)).toMatchObject({ status: "future", date_gmt: "2026-10-08T16:30:00" });
    await make().update(job({ delivery: { status: "published", remoteId: "412" } }));
    expect(sentJson(1).status).toBeUndefined();
    expect(sentJson(1).date_gmt).toBeUndefined();
  });

  it("treats only a definite missing-post response as removed", async () => {
    queue(json(404, WP.invalidId), json(404, WP.invalidId));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toBeInstanceOf(RemoteRemovedError);
    await expect(make().update(job({ delivery: { status: "published", remoteId: "412" } }))).rejects.toMatchObject({ kind: "needs_user" });
    queue(json(404, WP.noRoute));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toMatchObject({ kind: "needs_user" });
  });

  it("takes a scheduled article back to draft, but never unpublishes a live one", async () => {
    queue(json(200, WP.future()), json(200, WP.post("draft")));
    await make().cancel(handedOver());
    expect(call(1)).toMatchObject({ url: `${WP_API}/posts/412`, method: "POST" });
    expect(sentJson(1)).toEqual({ status: "draft" });
    queue(json(200, WP.post("publish")));
    await expect(make().cancel(handedOver())).rejects.toThrow("WordPress: this article is already published. Unpublish it in WordPress if you want it gone.");
    expect(requestUrlMock.calls).toHaveLength(3);
  });

  it("only accepts a definite missing-post response while cancelling", async () => {
    queue(json(404, WP.invalidId));
    await expect(make().cancel(handedOver())).resolves.toBeUndefined();
    queue(json(404, WP.noRoute));
    await expect(make().cancel(handedOver())).rejects.toMatchObject({ kind: "needs_user" });
  });
});

describe("WordPressAdapter.lookup", () => {
  it("reads a post's state: published, still scheduled, or definitely gone", async () => {
    queue(json(200, WP.future()), json(200, WP.post("draft")), json(404, WP.invalidId));
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "412", scheduledAt: WP_AT });
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "412", gone: true });
    expect(await make().lookup(handedOver())).toEqual({ published: false, gone: true });
  });

  it("can't tell when a 404 is a missing REST route rather than a missing post", async () => {
    queue(json(404, WP.noRoute));
    expect(await make().lookup(handedOver())).toBeNull();
  });

  it("finds an interrupted hand-over by its slug and exact time", async () => {
    queue(json(200, [WP.future()]));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false, remoteId: "412", scheduledAt: WP_AT });
    queue(json(200, []));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false });
  });
});

describe("WordPressAdapter.verify", () => {
  it("names the user and the site, or says what is wrong", async () => {
    queue(json(200, WP.me), json(401, WP.incorrectPassword), json(404, WP.noRoute));
    const channel = wordpressCase.job().channel;
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: true, account: "Editor on eventx.berlin" });
    expect(call(0).url).toBe(`${WP_API}/users/me?context=edit&_fields=id,name`);
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: false, error: "WordPress: The provided password is an invalid application password. (HTTP 401)" });
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: false, error: `No WordPress REST API at ${WP_SITE}/wp-json/. Check the site address.` });
  });
});
