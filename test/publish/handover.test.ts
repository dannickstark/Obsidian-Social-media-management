import { getFrontMatterInfo, parseYaml } from "obsidian";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { formatDateTime, HOUR, MINUTE } from "../../src/model/dates";
import { NeedsUserError, TransientError } from "../../src/platforms/errors";
import type { PlatformAdapter, RemoteState } from "../../src/platforms/types";
import { handOverCandidates, HandOverService, type HandOverDeps } from "../../src/publish/handover";
import type { FailureInfo, PublishedInfo } from "../../src/publish/orchestrator";
import { contentDigest } from "../../src/publish/sync";
import { Secrets } from "../../src/secrets/secrets";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + HOUR;
const BODY = "Doors open at 18:00";
const note = (delivery: Record<string, unknown> = { status: "scheduled" }, extra: Record<string, unknown> = {}, body = BODY) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": delivery }, ...extra },
  body,
});

async function fm(c: TestCtx): Promise<{ deliveries: Record<string, Record<string, unknown>> }> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as never;
}

async function setup(adapter: Partial<PlatformAdapter>, opts: { note?: ReturnType<typeof note>; publisher?: () => boolean; deps?: Partial<HandOverDeps> } = {}) {
  const c = await makeCtx({ seed: true, notes: [opts.note ?? note()] });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native", handle: "@you@mastodon.social", secretId: "osmm-channel-ma-you" });
  c.app.secretStorage.setSecret("osmm-channel-ma-you", "MASTODON-TOKEN-1234");
  const full = { platform: "mastodon" as const, minLeadMs: 5 * MINUTE, schedule: vi.fn(async () => ({ remoteId: "3221" })), publish: vi.fn(), update: vi.fn(), lookup: vi.fn(async (): Promise<RemoteState | null> => null), ...adapter };
  c.adapters.register(full);
  const failures: FailureInfo[] = [];
  const published: PublishedInfo[] = [];
  const warnings: string[] = [];
  const service = new HandOverService({
    writer: c.writer,
    index: c.index,
    channels: c.ctx.channels,
    adapters: c.adapters,
    secrets: new Secrets(c.app as never),
    content: c.ctx.composer.content,
    check: (v, content) => c.ctx.composer.check(v, content),
    flush: async () => undefined,
    log: c.log,
    now: () => get(c.now),
    isPublisher: opts.publisher ?? (() => true),
    defaultStaggerMinutes: () => 0,
    warn: (m) => void warnings.push(m),
    onFailure: (f) => void failures.push(f),
    onPublished: (p) => void published.push(p),
    ...opts.deps,
  });
  return { c, adapter: full, service, failures, published, warnings };
}

describe("handOverCandidates", () => {
  it("lists scheduled native deliveries at least the lead plus the margin ahead, and nothing else", async () => {
    const c = await makeCtx({
      seed: true,
      notes: [
        { ...note(), path: "Social/Posts/Far.md" },
        { ...note({ status: "scheduled" }, { scheduled_at: formatDateTime(TEST_NOW + 6 * MINUTE) }), path: "Social/Posts/Soon.md" },
        { ...note({ status: "scheduled" }, { mode: "assisted" }), path: "Social/Posts/Assisted.md" },
        { ...note({ status: "scheduled" }, { review: "claude" }), path: "Social/Posts/Held.md" },
        { ...note({ status: "handed_over", remote_id: "1" }), path: "Social/Posts/Done.md" },
      ],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native" });
    c.adapters.register({ platform: "mastodon", minLeadMs: 5 * MINUTE, schedule: async () => ({ remoteId: "1" }) });
    expect(handOverCandidates(c.index.variants(), c.adapters, c.ctx.channels, TEST_NOW, 0)).toEqual([{ path: "Social/Posts/Far.md", channelId: "ma/you", at: AT }]);
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "api" });
    expect(handOverCandidates(c.index.variants(), c.adapters, c.ctx.channels, TEST_NOW, 0)).toEqual([]);
  });
});

describe("HandOverService.handOver", () => {
  it("writes handed_over with remote_at and digest before the call, and the remote id after", async () => {
    const seen: { fm?: unknown } = {};
    const ref: { c?: TestCtx } = {};
    const { c, service, adapter } = await setup({
      schedule: vi.fn(async () => {
        seen.fm = (await fm(ref.c!)).deliveries["ma/you"];
        return { remoteId: "3221" };
      }),
    });
    ref.c = c;
    await service.run();
    const digest = contentDigest(c.index.getVariant(P)!, BODY);
    expect(seen.fm).toEqual({ status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), digest, attempts: 1 });
    expect(adapter.schedule).toHaveBeenCalledOnce();
    expect((await fm(c)).deliveries["ma/you"]).toEqual({ status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), digest, attempts: 1, remote_id: "3221" });
    expect(c.log.entries.at(-1)).toMatchObject({ path: P, channelId: "ma/you", result: "handed_over" });
  });

  it("does nothing on a device that is not the publisher", async () => {
    const { service, adapter } = await setup({}, { publisher: () => false });
    await service.run();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });

  it("never hands over a thread the platform can't schedule, and never asks again for the same time", async () => {
    const { service, adapter } = await setup({ scheduleRefusal: () => "Mastodon can't schedule a thread." }, { note: note({ status: "scheduled" }, {}, "One\n---\nTwo") });
    await service.run();
    await service.run();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });

  it("refuses to hand over a note that changed while it was being read (M2b P3)", async () => {
    const box: { c?: TestCtx } = {};
    const { c, service, adapter } = await setup(
      {},
      {
        deps: {
          content: {
            load: async (v) => {
              const loaded = await box.c!.ctx.composer.content.load(v);
              await box.c!.writer.updateVariant(v.file, () => ({ fields: { title: "Changed meanwhile" } }));
              return loaded;
            },
          },
        },
      },
    );
    box.c = c;
    expect(await service.handOver(P, "ma/you", AT)).toBe("refused");
    expect(adapter.schedule).not.toHaveBeenCalled();
    expect((await fm(c)).deliveries["ma/you"]!.status).toBe("scheduled");
  });

  it("puts it back to scheduled after a transient failure, and tries again after a minute", async () => {
    const { c, service, adapter } = await setup({ schedule: vi.fn(async () => Promise.reject(new TransientError("Mastodon: Service Unavailable (HTTP 503)"))) });
    await service.run();
    const d = (await fm(c)).deliveries["ma/you"]!;
    expect(d).toMatchObject({ status: "scheduled", error: "Not handed over to Mastodon: Mastodon: Service Unavailable (HTTP 503) It stays scheduled and goes out from Obsidian at its time." });
    expect(d.at).toBeUndefined();
    expect(d.attempts).toBeUndefined();
    expect(d.remote_at).toBeUndefined();
    expect(d.digest).toBeUndefined();
    expect(c.log.entries.at(-1)).toMatchObject({ result: "handover_failed" });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "scheduled");
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(1);
    c.now.set(TEST_NOW + MINUTE);
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(2);
  });

  it("warns once and stops trying after a needs-user failure", async () => {
    const { c, service, adapter, warnings } = await setup({ schedule: vi.fn(async () => Promise.reject(new NeedsUserError("Mastodon: The access token is invalid (HTTP 401)"))) });
    await service.run();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "scheduled");
    c.now.set(TEST_NOW + 30 * MINUTE);
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(["Doors open at 18:00: not handed over to Mastodon (Mastodon: The access token is invalid (HTTP 401)). It stays scheduled and goes out from Obsidian at its time, if this device is on."]);
  });

  it("parks an unanswered hand-over on check_needed, and returns it to handed_over when lookup finds it (M2b P4)", async () => {
    const lookup = vi.fn(async (): Promise<RemoteState | null> => ({ published: false, remoteId: "3221", scheduledAt: AT }));
    const { c, service, adapter } = await setup({ schedule: vi.fn(async () => Promise.reject(new Error("net::ERR_CONNECTION_RESET"))), lookup });
    expect(await service.handOver(P, "ma/you", AT)).toBe("handed_over");
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ delivery: expect.objectContaining({ status: "handed_over", remoteAt: AT }) }));
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "handed_over", remote_id: "3221", remote_at: formatDateTime(AT) });
    expect(adapter.schedule).toHaveBeenCalledOnce();
  });

  it("leaves an unanswered hand-over that lookup can't find to the user, and never sends it again", async () => {
    const { c, service, adapter, failures } = await setup({ schedule: vi.fn(async () => Promise.reject(new Error("timeout"))), lookup: vi.fn(async () => ({ published: false })) });
    expect(await service.handOver(P, "ma/you", AT)).toBe("check_needed");
    expect(failures).toEqual([{ path: P, channelId: "ma/you", kind: "unknown", error: "timeout" }]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "check_needed");
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledOnce();
  });
});

describe("edits after a hand-over (#66, review focus 3)", () => {
  it("never pushes an out-of-sync delivery by itself", async () => {
    const { service, adapter } = await setup({}, { note: note({ status: "handed_over", at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), remote_id: "3221", digest: "old" }, {}, "Edited text") });
    await service.run();
    expect(adapter.update).not.toHaveBeenCalled();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });
});

describe("HandOverService.settle", () => {
  const past = (extra: Record<string, unknown> = {}) => note({ status: "handed_over", at: formatDateTime(TEST_NOW - 10 * MINUTE), remote_at: formatDateTime(TEST_NOW - 10 * MINUTE), remote_id: "3221", digest: "d", ...extra });

  it("marks the post published at its platform time once the platform has it", async () => {
    const { c, service, published } = await setup({ lookup: vi.fn(async () => ({ published: true, remoteId: "9001", url: "https://mastodon.social/@you/9001" })) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "published", at: formatDateTime(TEST_NOW - 10 * MINUTE), url: "https://mastodon.social/@you/9001", remote_id: "9001" });
    expect(published).toEqual([{ path: P, channelId: "ma/you", url: "https://mastodon.social/@you/9001" }]);
    expect(c.log.entries.at(-1)).toMatchObject({ result: "published", url: "https://mastodon.social/@you/9001" });
  });

  it("records a time changed on the platform, and asks again only after 15 minutes", async () => {
    const lookup = vi.fn(async () => ({ published: false, remoteId: "3221", scheduledAt: TEST_NOW + 30 * MINUTE }));
    const { c, service } = await setup({ lookup }, { note: past() });
    await service.run();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.remoteAt === TEST_NOW + 30 * MINUTE);
    await service.run();
    expect(lookup).toHaveBeenCalledTimes(1);
    c.now.set(TEST_NOW + 40 * MINUTE);
    await service.run();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("fails a post the platform no longer has, and tells the user", async () => {
    const { c, service, failures } = await setup({ lookup: vi.fn(async () => ({ published: false, gone: true })) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "failed", error: "It is no longer scheduled on Mastodon, and it was not posted." });
    expect(failures.map((f) => f.kind)).toEqual(["needs_user"]);
  });

  it("asks the user after a day without an answer", async () => {
    const { c, service, failures } = await setup({ lookup: vi.fn(async () => null) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]!.status).toBe("handed_over");
    c.now.set(TEST_NOW + 25 * HOUR);
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "check_needed", error: "Mastodon hasn't confirmed this post a day after its time. Check Mastodon, then mark it as published or not." });
    expect(failures.map((f) => f.kind)).toEqual(["unknown"]);
  });
});
