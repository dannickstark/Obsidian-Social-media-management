import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../../src/model/dates";
import type { PublishedInfo } from "../../../src/publish/orchestrator";
import { PhoneAlerts } from "../../../src/reminders/ntfy/alerts";
import type { NtfyMessage } from "../../../src/reminders/ntfy/client";
import { indexed, settle } from "../../helpers";
import { makeCtx, TEST_NOW } from "../../ui/ctx";

const content = { vaultName: () => "V", variant: () => ({ platform: "bluesky" as const, displayTitle: "Hi" }), channelName: () => "@you" };

function build(over: { enabled?: boolean; publisher?: boolean; fail?: boolean } = {}) {
  const sent: NtfyMessage[] = [];
  const warnings: string[] = [];
  const alerts = new PhoneAlerts({
    enabled: () => over.enabled ?? true,
    isPublisher: () => over.publisher ?? true,
    client: { publish: async (m) => (over.fail ? Promise.reject(new Error("The ntfy server had a problem (502).")) : (sent.push(m), { id: "x", at: 0 })) },
    content,
    warn: (m) => void warnings.push(m),
  });
  return { alerts, sent, warnings };
}

describe("PhoneAlerts", () => {
  it("pushes failures and confirmations on the publisher when enabled", async () => {
    const { alerts, sent } = build();
    alerts.failed({ path: "p.md", channelId: "bs/you", kind: "transient", error: "503" });
    alerts.published({ path: "p.md", channelId: "bs/you", url: "https://bsky.app/profile/you/post/1" });
    await settle();
    expect(sent.map((m) => m.title)).toEqual(["Couldn't publish · Bluesky", "Posted · Bluesky"]);
  });

  it("stays quiet when off or on another device, and only warns when a push fails", async () => {
    for (const over of [{ enabled: false }, { publisher: false }]) {
      const { alerts, sent } = build(over);
      alerts.failed({ path: "p.md", channelId: "bs/you", kind: "transient", error: "503" });
      await settle();
      expect(sent).toEqual([]);
    }
    const { alerts, warnings } = build({ fail: true });
    alerts.published({ path: "p.md", channelId: "bs/you" });
    await settle();
    expect(warnings).toEqual(["Phone alert not sent: The ntfy server had a problem (502)."]);
  });

  it("hears about API publishes from the orchestrator", async () => {
    const P = "Social/Posts/P.md";
    const c = await makeCtx({
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(TEST_NOW + 3_600_000) }, body: "Hi" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    const seen: PublishedInfo[] = [];
    c.ctx.publish.notifier = { due: () => undefined, failed: () => undefined, published: (i) => void seen.push(i) };
    await c.ctx.publish.orchestrator.run(P, "bs/you");
    expect(seen).toEqual([{ path: P, channelId: "bs/you", url: "https://bsky.app/profile/you/post/1" }]);
  });

  it("keeps an API publish published when the confirmation throws", async () => {
    const P = "Social/Posts/P.md";
    const c = await makeCtx({
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(TEST_NOW + 3_600_000) }, body: "Hi" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    c.ctx.publish.notifier = {
      due: () => undefined,
      failed: () => undefined,
      published: () => {
        throw new Error("notifier broke");
      },
    };
    expect(await c.ctx.publish.orchestrator.run(P, "bs/you")).toEqual({ status: "published", url: "https://bsky.app/profile/you/post/1" });
  });

  it("hears about a publish confirmed by lookup() when the startup check resolves it (M3 P8)", async () => {
    const P = "Social/Posts/P.md";
    const c = await makeCtx({
      notes: [
        {
          path: P,
          frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(TEST_NOW - 3_600_000), deliveries: { "bs/you": { status: "check_needed", error: "Obsidian closed." } } },
          body: "Hi",
        },
      ],
    });
    c.adapters.register({ platform: "bluesky", lookup: async () => ({ published: true, url: "https://bsky.app/profile/you/post/2", remoteId: "2" }) });
    const seen: PublishedInfo[] = [];
    c.ctx.publish.notifier = { due: () => undefined, failed: () => undefined, published: (i) => void seen.push(i) };
    await c.ctx.publish.resolveCheck(P, "bs/you");
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["bs/you"]?.status === "published");
    expect(seen).toEqual([{ path: P, channelId: "bs/you", url: "https://bsky.app/profile/you/post/2" }]);
  });
});
