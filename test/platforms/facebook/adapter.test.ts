import { afterEach, describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { createAdapters } from "../../../src/platforms/adapters";
import { effectiveMethod, platformDef } from "../../../src/platforms/registry";
import { CONTRACT_NOW, contractDeps, expectDigestReads, trackedJob } from "../contract/harness";
import { img } from "../fixtures";
import { call, formParts, json, netError, queue, sentJson } from "../http";
import { InvalidContentError } from "../../../src/platforms/errors";
import {
  before,
  facebookJob,
  live,
  PAGE,
  PAGE_TOKEN,
  permissions,
  scheduled,
  USER_TOKEN,
} from "./contract";

const adapter = () => createAdapters(contractDeps()).find((a) => a.platform === "facebook")!;
const job = () => trackedJob(facebookJob());
const handedOver = () =>
  trackedJob({
    ...facebookJob(),
    delivery: { status: "handed_over", at: CONTRACT_NOW + 3_600_000, remoteId: "11_42" },
  });
afterEach(expectDigestReads);

describe("Facebook Pages", () => {
  it("registers a usable Page publisher", () => {
    expect(adapter()?.publish).toBeTypeOf("function");
  });
  it("posts text with the selected Page token, never the user token", async () => {
    queue(...before(), json(200, { id: "11_42" }));
    expect(await adapter().publish!(job())).toEqual({ remoteId: "11_42", url: live.permalink_url });
    expect(call(2).headers?.Authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(sentJson(2)).toEqual({ message: "Doors open" });
    expect(call(2).url).toBe("https://graph.facebook.com/v24.0/11/feed");
    expect(requestUrlMock.calls.every((r) => !r.url.includes("SECRET"))).toBe(true);
  });
  it("uploads images privately before publishing their ids as one feed post", async () => {
    queue(
      ...before(),
      json(200, { id: "51" }),
      json(200, { id: "52" }),
      json(200, { id: "11_42" }),
    );
    await adapter().publish!({ ...job(), media: [img(), img("b.png")] });
    expect(formParts(2).published?.value).toBe("false");
    expect(formParts(2).source?.size).toBe(8);
    expect(formParts(2).alt_text_custom?.value).toBe("An image");
    expect(sentJson(4)).toEqual({
      message: "Doors open",
      attached_media: [{ media_fbid: "51" }, { media_fbid: "52" }],
    });
  });
  it("marks scheduled image uploads temporary and declares scheduled feed content", async () => {
    queue(...before(), json(200, { id: "51" }), json(200, { id: "11_42" }));
    const j = handedOver();
    delete j.delivery.remoteId;
    j.media = [img()];
    await adapter().schedule!(j);
    expect(formParts(2).published?.value).toBe("false");
    expect(formParts(2).temporary?.value).toBe("true");
    expect(sentJson(3)).toEqual({
      message: "Doors open",
      attached_media: [{ media_fbid: "51" }],
      published: false,
      scheduled_publish_time: 1791450000,
      unpublished_content_type: "SCHEDULED",
    });
  });
  it("refuses an image post with a link instead of silently dropping the URL", async () => {
    queue(...before(), json(200, { id: "51" }), json(200, { id: "11_42" }));
    const j = job();
    j.media = [img()];
    j.variant.url = "https://example.com";
    await expect(adapter().publish!(j)).rejects.toBeInstanceOf(InvalidContentError);
  });
  it("hands over using integer seconds and refuses a time inside ten minutes", async () => {
    queue(...before(), json(200, { id: "11_42" }));
    const j = handedOver();
    delete j.delivery.remoteId;
    expect(await adapter().schedule!(j)).toMatchObject({ remoteId: "11_42" });
    expect(sentJson(2)).toEqual({
      message: "Doors open",
      published: false,
      scheduled_publish_time: 1791450000,
    });
    requestUrlMock.reset();
    await expect(
      adapter().schedule!({
        ...job(),
        delivery: { status: "handed_over", at: CONTRACT_NOW + 599_999 },
      }),
    ).rejects.toMatchObject({ kind: "invalid_content" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });
  it("rechecks the lead time after slow image preparation", async () => {
    let now = CONTRACT_NOW;
    const a = createAdapters({
      ...contractDeps(),
      now: () => now,
      readBinary: async () => {
        now += 600_000;
        return new ArrayBuffer(8);
      },
    }).find((a) => a.platform === "facebook")!;
    queue(...before(), json(200, { id: "51" }));
    await expect(
      a.schedule!({
        ...job(),
        media: [img()],
        delivery: { status: "handed_over", at: CONTRACT_NOW + 900_000 },
      }),
    ).rejects.toMatchObject({ kind: "invalid_content" });
    expect(requestUrlMock.calls.filter((r) => r.url.endsWith("/feed"))).toHaveLength(0);
  });
  it.each([netError, json(503, {}), json(200, {})])(
    "parks an ambiguous native hand-over without retrying or falling back: %j",
    async (answer) => {
      queue(...before(), answer);
      const j = handedOver();
      delete j.delivery.remoteId;
      await expect(adapter().schedule!(j)).rejects.toMatchObject({ kind: "unknown" });
      expect(requestUrlMock.calls.filter((r) => r.url.endsWith("/feed"))).toHaveLength(1);
    },
  );
  it.each([live, scheduled])("looks up persisted remote state after restart: %j", async (state) => {
    queue(...before(), json(200, state));
    const result = await adapter().lookup!(handedOver());
    expect(result).toMatchObject(
      state.is_published
        ? { published: true, remoteId: "11_42", url: live.permalink_url }
        : { published: false, scheduledAt: CONTRACT_NOW + 3_600_000 },
    );
  });
  it.each([
    {},
    { id: "11_42" },
    { id: "other", is_published: true },
    { id: "11_42", is_published: false },
  ])("keeps unreadable state unknown: %j", async (state) => {
    queue(...before(), json(200, state));
    expect(await adapter().lookup!(handedOver())).toBeNull();
  });
  it("keeps ambiguous code 100 missing-object responses unknown, including HTTP 404", async () => {
    queue(
      ...before(),
      json(404, {
        error: {
          message:
            "Unsupported get request. Object with ID '11_42' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
          type: "GraphMethodException",
          code: 100,
        },
      }),
    );
    expect(await adapter().lookup!(handedOver())).toBeNull();
    queue(...before(), json(400, { error: { code: 100, error_subcode: 33 } }));
    expect(await adapter().lookup!(handedOver())).toBeNull();
  });
  it("does not infer a missing commit from an absent remote id", async () => {
    expect(await adapter().lookup!(job())).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });
  it("updates text and native time, validating acknowledgement", async () => {
    queue(...before(), json(200, scheduled), json(200, { success: true }));
    await adapter().update!(handedOver(), { content: true, time: true });
    expect(sentJson(3)).toEqual({ message: "Doors open", scheduled_publish_time: 1791450000 });
    expect(call(3).url).toBe("https://graph.facebook.com/v24.0/11_42");
    queue(...before(), json(200, scheduled), json(200, {}));
    await expect(
      adapter().update!(handedOver(), { content: true, time: false }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });
  it("refuses attachment edits and a scheduled update after publication", async () => {
    queue(...before(), json(200, { ...scheduled, attachments: { data: [{ type: "photo" }] } }));
    await expect(
      adapter().update!(handedOver(), { content: true, time: false }),
    ).rejects.toMatchObject({ kind: "needs_user" });
    queue(...before(), json(200, live));
    await expect(
      adapter().update!(handedOver(), { content: false, time: true }),
    ).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("does not return an ambiguous missing-object hand-over to the local scheduler", async () => {
    queue(
      ...before(),
      json(404, {
        error: {
          message:
            "Unsupported get request. Object with ID '11_42' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
          type: "GraphMethodException",
          code: 100,
        },
      }),
    );
    await expect(
      adapter().update!(handedOver(), { content: true, time: false }),
    ).rejects.toMatchObject({
      kind: "needs_user",
    });
  });
  it("does not treat an ambiguous missing-object response as a confirmed cancellation", async () => {
    queue(
      ...before(),
      json(404, {
        error: {
          message:
            "Unsupported get request. Object with ID '11_42' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
          type: "GraphMethodException",
          code: 100,
        },
      }),
    );
    await expect(adapter().cancel!(handedOver())).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls.some((r) => r.method === "DELETE")).toBe(false);
  });
  it("cancels a confirmed future post and requires success acknowledgement", async () => {
    queue(...before(), json(200, scheduled), json(200, { success: true }));
    await adapter().cancel!(handedOver());
    expect(call(3).method).toBe("DELETE");
    queue(...before(), json(200, scheduled), json(200, {}));
    await expect(adapter().cancel!(handedOver())).rejects.toMatchObject({ kind: "unknown" });
  });
  it.each([live, {}, { ...scheduled, scheduled_publish_time: CONTRACT_NOW / 1000 }])(
    "never deletes live, due, or unreadable posts: %j",
    async (state) => {
      queue(...before(), json(200, state));
      await expect(adapter().cancel!(handedOver())).rejects.toMatchObject({ kind: "needs_user" });
      expect(requestUrlMock.calls.some((r) => r.method === "DELETE")).toBe(false);
    },
  );
  it.each([netError, json(503, {}), json(200, {})])(
    "parks ambiguous commits without retries",
    async (answer) => {
      queue(...before(), answer);
      await expect(adapter().publish!(job())).rejects.toMatchObject({ kind: "unknown" });
      expect(requestUrlMock.calls.filter((r) => r.method === "POST")).toHaveLength(1);
    },
  );
  it("verifies the selected Page and its publishing grant without writing", async () => {
    queue(...before());
    expect(await adapter().verify!(job().channel, USER_TOKEN)).toEqual({
      ok: true,
      account: "Event X",
    });
    expect(requestUrlMock.calls.every((r) => r.method === "GET")).toBe(true);
  });
  it.each([null, "user"])("refuses invalid Page targets before network: %s", async (handle) => {
    const j = job();
    j.channel.handle = handle ?? undefined;
    expect((await adapter().verify!(j.channel, USER_TOKEN)).ok).toBe(false);
    expect(requestUrlMock.calls).toHaveLength(0);
  });
  it.each([
    { ...PAGE, tasks: ["ANALYZE"] },
    { ...PAGE, id: "12" },
  ])("requires content task and selected Page: %j", async (page) => {
    queue(json(200, { data: [page] }), json(200, permissions));
    expect((await adapter().verify!(job().channel, USER_TOKEN)).ok).toBe(false);
  });
  it("rejects missing publish permissions while retaining assisted eligibility", async () => {
    queue(
      json(200, { data: [PAGE] }),
      json(200, { data: [{ permission: "pages_manage_posts", status: "declined" }] }),
    );
    expect((await adapter().verify!(job().channel, USER_TOKEN)).ok).toBe(false);
    expect(effectiveMethod("auto", { ...job().channel, secretId: undefined }, adapter())).toBe(
      "assisted",
    );
    expect(effectiveMethod("auto", { ...job().channel, kind: "profile" }, adapter())).toBe(
      "assisted",
    );
    expect(
      platformDef("facebook").validate?.(
        { variant: job().variant, body: "Hi", media: [] },
        { ...job().channel, kind: "profile" },
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ level: "error" })]));
    expect(
      platformDef("facebook").validate?.(
        {
          variant: { ...facebookJob().variant, url: "https://example.com" },
          body: "Hi",
          media: [img()],
        },
        job().channel,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          field: "url",
          message: expect.stringContaining("cannot also include a link"),
        }),
      ]),
    );
  });
});
