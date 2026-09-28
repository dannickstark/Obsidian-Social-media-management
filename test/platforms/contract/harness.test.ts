import { describe, expect, it } from "vitest";
import { ApiClient, obsidianHttp } from "../../../src/platforms/http";
import type { DeliveryJob } from "../../../src/platforms/types";
import { DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../../src/publish/sync";
import { channel } from "../fixtures";
import { hang, json, text } from "../http";
import { attempt, CONTRACT_NOW, expectDigestReads, recordReads, trackedJob } from "./harness";

const api = new ApiClient({ platform: "discord", http: obsidianHttp, now: () => CONTRACT_NOW, timeoutMs: 30, failure: () => ({ message: "no" }) });
const post = { url: "https://x.example/p" };

function job(): DeliveryJob {
  return {
    variant: { path: "Social/P.md", platform: "telegram", channels: ["tg/news"], mode: "auto", status: "scheduled", media: [], deliveries: {}, firstComment: "hi" } as DeliveryJob["variant"],
    channel: channel("tg/news"),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
    text: "Hello",
    items: ["Hello"],
    body: "Hello",
    media: [],
    secret: "SECRET",
  };
}

describe("contract harness", () => {
  it("reports the class the orchestrator would see", async () => {
    expect(await attempt(() => api.commit(post), [json(401, {})])).toMatchObject({ ok: false, kind: "needs_user", message: "Discord: no (HTTP 401)", classifiedByAdapter: true });
    expect(await attempt(() => api.commit(post), [hang])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
    expect(await attempt(async () => 1, [])).toEqual({ ok: true, value: 1 });
  });

  it("reports a 5xx on a commit that is not retry-safe as an unknown outcome, and on a retry-safe one as transient (M5 P2)", async () => {
    expect(await attempt(() => api.commit(post), [json(502, {})])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
    expect(await attempt(() => api.commit(post, { retrySafe: true }), [json(502, {})])).toMatchObject({ ok: false, kind: "transient", classifiedByAdapter: true });
    expect(await attempt(() => api.prepare(post), [json(502, {})])).toMatchObject({ ok: false, kind: "transient", classifiedByAdapter: true });
  });

  it("reports an unclassified error the way the orchestrator would (an unreadable 2xx an adapter didn't turn into UnknownOutcomeError)", async () => {
    const out = await attempt(async () => {
      const res = await api.commit(post);
      return JSON.parse(res.text) as unknown;
    }, [text(200, "<html>")]);
    expect(out).toMatchObject({ ok: false, classifiedByAdapter: false });
  });

  it("flags a field outside the digest lists, and spreading the variant", () => {
    const { proxy, reads } = recordReads({ platform: "telegram", title: "x", firstComment: "hi" } as Record<string, unknown>);
    void proxy.title;
    void proxy.firstComment;
    void { ...proxy };
    const allowed = new Set<string>([...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS]);
    expect([...reads].filter((k) => !allowed.has(k)).sort()).toEqual(["*", "firstComment"]);
  });

  it("records `in` checks and property descriptors (M5 P8)", () => {
    const { proxy, reads } = recordReads({ platform: "telegram" } as Record<string, unknown>);
    void ("firstComment" in proxy);
    void Object.getOwnPropertyDescriptor(proxy, "notes");
    void Object.prototype.hasOwnProperty.call(proxy, "labels");
    expect([...reads].sort()).toEqual(["firstComment", "labels", "notes"]);
  });

  it("fails an adapter that reads a variant field that is not digested, and passes one that doesn't (M4 carry)", () => {
    const good = trackedJob(job());
    void good.variant.platform;
    void good.variant.media;
    void good.variant.deliveries;
    expectDigestReads();

    const bad = trackedJob(job());
    void (bad.variant as unknown as Record<string, unknown>).firstComment;
    expect(() => expectDigestReads()).toThrow(/firstComment/);

    const spread = trackedJob(job());
    void JSON.stringify(spread.variant);
    expect(() => expectDigestReads()).toThrow(/\*/);

    // Each check starts clean.
    expectDigestReads();
  });
});
