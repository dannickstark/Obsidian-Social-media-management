import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { AdapterRegistry } from "../../src/platforms/registry";
import { TransientError } from "../../src/platforms/errors";
import type { PlatformAdapter } from "../../src/platforms/types";
import { PublishOrchestrator, type FailureInfo } from "../../src/publish/orchestrator";
import { Secrets } from "../../src/secrets/secrets";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Tg.md";
const note = (path = P, delivery: Record<string, unknown> = { status: "scheduled" }) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "telegram",
    channels: ["tg/event-x"],
    status: "scheduled",
    scheduled_at: "2026-10-08T10:00:00+02:00",
    deliveries: { "tg/event-x": delivery },
  },
  body: "Doors open at 18:00",
});
const http = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed, status ${status} (token SECRET-TOKEN-123)`), { status, headers });

async function fm(c: TestCtx, path = P): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

async function setup(
  publish: NonNullable<PlatformAdapter["publish"]>,
  opts: { notes?: ReturnType<typeof note>[]; onDelay?: (c: TestCtx) => Promise<void>; lookup?: PlatformAdapter["lookup"] } = {},
) {
  const c = await makeCtx({ seed: true, notes: opts.notes ?? [note()] });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" });
  c.app.secretStorage.setSecret("osmm-channel-tg-event-x", "SECRET-TOKEN-123");
  const adapters = new AdapterRegistry();
  adapters.register({ platform: "telegram", publish, lookup: opts.lookup });
  const delays: number[] = [];
  const failures: FailureInfo[] = [];
  const orchestrator = new PublishOrchestrator({
    writer: c.writer,
    index: c.index,
    channels: c.ctx.channels,
    adapters,
    secrets: new Secrets(c.app as never),
    content: c.ctx.composer.content,
    log: c.log,
    now: () => TEST_NOW,
    delay: async (ms) => {
      delays.push(ms);
      await opts.onDelay?.(c);
    },
    onFailure: (f) => failures.push(f),
  });
  return { c, orchestrator, delays, failures };
}

const MIN = 60_000;

describe("PublishOrchestrator", () => {
  it("writes publishing and a timestamp before the call, then the result", async () => {
    const seen: { deliveries?: unknown; secret?: string | null; text?: string } = {};
    const ref: { c?: TestCtx } = {};
    const { c, orchestrator } = await setup(async (job) => {
      seen.deliveries = (await fm(ref.c!)).deliveries;
      seen.secret = job.secret;
      seen.text = job.text;
      return { remoteId: "42", url: "https://t.me/eventx/42" };
    });
    ref.c = c;
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "published", url: "https://t.me/eventx/42" });
    expect(seen).toEqual({
      deliveries: { "tg/event-x": { status: "publishing", at: formatDateTime(TEST_NOW), attempts: 1 } },
      secret: "SECRET-TOKEN-123",
      text: "Doors open at 18:00",
    });
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({
      status: "published",
      at: TEST_NOW,
      url: "https://t.me/eventx/42",
      remoteId: "42",
      attempts: 1,
    });
  });

  it("retries transient errors after 1 and 5 minutes", async () => {
    let calls = 0;
    const { c, orchestrator, delays } = await setup(async () => {
      if (++calls < 3) throw http(429);
      return { remoteId: "7", url: "https://t.me/eventx/7" };
    });
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "published" });
    expect(delays).toEqual([1 * MIN, 5 * MIN]);
    expect(c.log.entries.map((e) => e.result)).toEqual(["retry", "retry", "published"]);
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.attempts).toBe(3);
  });

  it("waits for Retry-After when it is longer than the back-off", async () => {
    let calls = 0;
    const { orchestrator, delays } = await setup(async () => {
      if (++calls === 1) throw http(429, { "Retry-After": "600" });
      return { remoteId: "7", url: "https://t.me/eventx/7" };
    });
    await orchestrator.run(P, "tg/event-x");
    expect(delays).toEqual([10 * MIN]);
  });

  // Ruling P4: a network error/timeout during adapter.publish is "outcome unknown" (the request may
  // have gone through). It is never auto-retried; it lands on check_needed and lookup() is tried.
  it("moves a timeout to check_needed instead of retrying, with no second publish call", async () => {
    let calls = 0;
    const { c, orchestrator, delays, failures } = await setup(
      async () => {
        calls++;
        throw new Error("net::ERR_TIMED_OUT");
      },
      { lookup: async () => null },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "check_needed" });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ path: P, channelId: "tg/event-x", kind: "unknown" });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({ status: "check_needed", attempts: 1 });
  });

  it("resolves check_needed to published when lookup finds it went through", async () => {
    let calls = 0;
    const { c, orchestrator } = await setup(
      async () => {
        calls++;
        throw new Error("net::ERR_TIMED_OUT");
      },
      { lookup: async () => ({ published: true, url: "https://t.me/eventx/9", remoteId: "9" }) },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "published", url: "https://t.me/eventx/9" });
    expect(calls).toBe(1);
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({ status: "published", url: "https://t.me/eventx/9", remoteId: "9" });
    // Exactly one log row for this outcome: lookup already resolved it, so no separate "check_needed" row.
    expect(c.log.entries.map((e) => e.result)).toEqual(["published"]);
  });

  it("retries a pre-send TransientError with no HTTP status, then publishes", async () => {
    let calls = 0;
    const { c, orchestrator, delays } = await setup(async () => {
      calls++;
      if (calls < 2) throw new TransientError("Could not build the request");
      return { remoteId: "3", url: "https://t.me/eventx/3" };
    });
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "published", url: "https://t.me/eventx/3" });
    expect(calls).toBe(2);
    expect(delays).toEqual([1 * MIN]);
    expect(c.log.entries.map((e) => e.result)).toEqual(["retry", "published"]);
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.attempts).toBe(2);
  });

  it("runs only one of two concurrent run() calls for the same delivery", async () => {
    let calls = 0;
    const { orchestrator } = await setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { remoteId: "1", url: "https://t.me/eventx/1" };
    });
    const results = await Promise.all([orchestrator.run(P, "tg/event-x"), orchestrator.run(P, "tg/event-x")]);
    expect(calls).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(["published", "refused"]);
  });

  it("leaves check_needed alone when there is no lookup on the adapter", async () => {
    let calls = 0;
    const { c, orchestrator } = await setup(async () => {
      calls++;
      throw new Error("net::ERR_TIMED_OUT");
    });
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "check_needed" });
    expect(calls).toBe(1);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
  });

  it("fails at once on an expired token, redacts the error and asks the user to fix it", async () => {
    const { c, orchestrator, delays, failures } = await setup(async () => Promise.reject(http(401)));
    const error = "Request failed, status 401 (token •••)";
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "failed", kind: "needs_user", error });
    expect(delays).toEqual([]);
    expect(failures).toEqual([{ path: P, channelId: "tg/event-x", kind: "needs_user", error }]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({ status: "failed", at: TEST_NOW, attempts: 1, error });
    expect(JSON.stringify(c.log.entries)).not.toContain("SECRET-TOKEN-123");
  });

  it("fails at once when the platform rejects the content", async () => {
    const { orchestrator, failures } = await setup(async () => Promise.reject(http(400)));
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "failed", kind: "invalid_content" });
    expect(failures).toHaveLength(1);
  });

  it("gives up after 1, 5 and 15 minutes of transient errors", async () => {
    const { c, orchestrator, delays, failures } = await setup(async () => Promise.reject(http(503)));
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "failed", kind: "transient" });
    expect(delays).toEqual([1 * MIN, 5 * MIN, 15 * MIN]);
    expect(failures.map((f) => f.kind)).toEqual(["transient"]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.attempts === 4);
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({ status: "failed", error: "Request failed, status 503 (token •••)" });
  });

  it("never sends a delivery that is already publishing", async () => {
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        return { remoteId: "1", url: "https://t.me/x/1" };
      },
      { notes: [note(P, { status: "publishing", at: "2026-10-08T09:59:00+02:00" })] },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "refused", reason: "It is already being published." });
    expect(calls).toBe(0);
  });

  it("stops retrying when the user skips the delivery during the back-off", async () => {
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        throw http(429);
      },
      {
        onDelay: async (c) => {
          await c.writer.transitionDelivery(c.app.vault.getFileByPath(P)! as never, "tg/event-x", "skipped");
        },
      },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "refused", reason: "It is skipped." });
    expect(calls).toBe(1);
  });

  it("publishes one delivery per platform at a time", async () => {
    const P2 = "Social/Posts/Tg 2.md";
    let active = 0;
    let max = 0;
    const { orchestrator } = await setup(
      async (job) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { remoteId: job.variant.path, url: "https://t.me/x/1" };
      },
      { notes: [note(), note(P2)] },
    );
    const results = await Promise.all([orchestrator.run(P, "tg/event-x"), orchestrator.run(P2, "tg/event-x")]);
    expect(results.map((r) => r.status)).toEqual(["published", "published"]);
    expect(max).toBe(1);
  });

  it("refuses without an adapter or with an unreadable entry", async () => {
    const c = await makeCtx({ seed: true, notes: [note()] });
    const r = await c.ctx.publish.orchestrator.run(P, "tg/event-x");
    expect(r).toEqual({ status: "refused", reason: "There is no Telegram API adapter yet; use Copy & open." });
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        return { remoteId: "1", url: "https://t.me/x/1" };
      },
      { notes: [note(P, { status: "Publishing!" })] },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "refused" });
    expect(calls).toBe(0);
  });
});

describe("PublishActions.runApi", () => {
  it("runs through the plugin's adapters and reports the result", async () => {
    const c = await makeCtx({ seed: true, notes: [note()] });
    c.adapters.register({ platform: "telegram", publish: async () => ({ remoteId: "9", url: "https://t.me/eventx/9" }) });
    expect(await c.ctx.publish.runApi(P, "tg/event-x")).toMatchObject({ status: "published" });
    expect(Notice.messages.at(-1)).toBe("Published to Event X channel.");
  });
});
