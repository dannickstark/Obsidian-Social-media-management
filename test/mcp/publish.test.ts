import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { MarkdownView, Modal, WorkspaceLeaf } from "../fakes/obsidian";
import { BUSY, CLOSED, TIMED_OUT } from "../../src/mcp/approval";
import type { OsmmSettings } from "../../src/settings/settings";
import { indexed, writeNote } from "../helpers";
import { mcpCtx, scriptedApprovals, type R } from "./helpers";

const TG = "Social/Posts/Tg.md";
const LI = "Social/Event X/Event X – LinkedIn.md";
const CHANGED = "changed after";
const tgNote = (delivery: Record<string, unknown> = { status: "scheduled" }, body = "Doors open at 18:00", extra: Record<string, unknown> = {}) => ({
  path: TG,
  frontmatter: {
    type: "social-post",
    platform: "telegram",
    title: "Doors open",
    channels: ["tg/event-x"],
    status: "scheduled",
    scheduled_at: "2026-10-08T14:00:00+02:00",
    deliveries: { "tg/event-x": delivery },
    ...extra,
  },
  body,
});

async function setup(
  answers: Parameters<typeof scriptedApprovals>[0] = [],
  opts: { timeoutMs?: number; note?: ReturnType<typeof tgNote>; publisher?: boolean; adapter?: boolean } = {},
) {
  // The policy is read from the test's synced settings, as the plugin reads OsmmSettings.publishWithoutAsking.
  let settings: (() => OsmmSettings) | null = null;
  const approvals = scriptedApprovals(answers, { timeoutMs: opts.timeoutMs, allowed: (id) => settings?.().publishWithoutAsking.includes(id) ?? false });
  const c = await mcpCtx({ notes: [opts.note ?? tgNote()], approvals: approvals.gate });
  settings = () => get(c.settings);
  const publish = vi.fn(async () => ({ remoteId: "42", url: "https://t.me/eventx/42" }));
  const update = vi.fn(async () => undefined);
  const register = () => c.adapters.register({ platform: "telegram", publish, update });
  if (opts.adapter !== false) register();
  if (opts.publisher !== false) await c.publisher.claim();
  return { c, publish, update, register, gate: approvals.gate, asked: approvals.asked };
}

type Ctx = Awaited<ReturnType<typeof mcpCtx>>;
const allow = (c: Ctx, ...ids: string[]) => c.settings.update((s) => ({ ...s, publishWithoutAsking: ids }));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** An open editor on `path` whose unsaved buffer is `buffer()`; publish flushes it first (M2b P3). */
function openEditor(c: Ctx, path: string, buffer: () => string): void {
  const leaf = new WorkspaceLeaf(c.app);
  const md = new MarkdownView(leaf);
  md.file = c.app.vault.getFileByPath(path) as never;
  md.editor = { getValue: buffer };
  leaf.view = md;
  leaf.viewType = "markdown";
  c.app.workspace.leaves.push(leaf);
}

const TG_HEAD = (title = "Doors open") =>
  `---\ntype: social-post\nplatform: telegram\ntitle: ${title}\nchannels:\n  - tg/event-x\nstatus: scheduled\nscheduled_at: 2026-10-08T14:00:00+02:00\ndeliveries:\n  tg/event-x:\n    status: scheduled\n---\n`;

describe("publish_now (#77)", () => {
  it("sends nothing without an answer under the default policy (#77 acceptance)", async () => {
    const { c, publish, asked } = await setup([]);
    const r = await c.call("publish_now", { path: TG, note: "The user asked to post it now." });
    expect(r).toMatchObject({ ok: false, approved: false, error: TIMED_OUT });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "publish", title: "Doors open", text: "Doors open at 18:00", note: "The user asked to post it now." });
    expect(asked[0]!.channels).toEqual([{ id: "tg/event-x", name: "Event X channel", how: "posts through the API now", status: "scheduled" }]);
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(TG)!.deliveries["tg/event-x"]!.status).toBe("scheduled");
    expect(c.log.entries).toEqual([]);
  });

  it("returns the user's refusal", async () => {
    const { c, publish } = await setup([{ approved: false, reason: "The user said no in Obsidian: not today" }]);
    expect((await c.call("publish_now", { path: TG })).error).toBe("The user said no in Obsidian: not today");
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes once after the user approves, and the run itself checks the text it sends", async () => {
    const { c, publish } = await setup([{ approved: true, how: "asked" }]);
    const run = vi.spyOn(c.ctx.publish.orchestrator, "run");
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: true, approved: true, approved_by: "user", started_api: ["tg/event-x"], opened_assisted: [] });
    await indexed(c.index, () => c.index.getVariant(TG)?.deliveries["tg/event-x"]?.status === "published");
    expect(publish).toHaveBeenCalledOnce();
    const accept = run.mock.calls[0]![2]!;
    const v = c.index.getVariant(TG)!;
    expect(accept(v, { body: "Doors open at 18:00", media: [] })).toBe(true);
    expect(accept(v, { body: "Doors open at 19:00", media: [] })).toBe(false);
  });

  it("skips the question for a channel the user allowed", async () => {
    const { c, publish, asked } = await setup([]);
    allow(c, "tg/event-x");
    expect(await c.call("publish_now", { path: TG })).toMatchObject({ ok: true, approved_by: "channel setting" });
    expect(asked).toEqual([]);
    await indexed(c.index, () => c.index.getVariant(TG)?.deliveries["tg/event-x"]?.status === "published");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("still asks when only some of the post's channels may publish without asking", async () => {
    const { c, asked } = await setup([]);
    allow(c, "li/maker-lab", "tg/event-x");
    const before = Modal.opened.length;
    const r = await c.call("publish_now", { path: LI });
    expect(r).toMatchObject({ ok: false, approved: false, error: TIMED_OUT });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.channels.map((ch) => ch.id)).toEqual(["li/acme-studio", "li/maker-lab"]);
    expect(Modal.opened.length).toBe(before);
  });

  it("sends nothing when the post changed while the question was open (P3, review focus 3)", async () => {
    const box = {} as { c: Ctx };
    const { c, publish } = await setup([
      async () => {
        await writeNote(box.c.app as never, TG, tgNote().frontmatter, "Doors open at 19:00");
        await indexed(box.c.index, () => box.c.index.getVariant(TG)!.excerpt.includes("19:00"));
        return { approved: true, how: "asked" };
      },
    ]);
    box.c = c;
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: false, approved: true });
    expect(r.error).toContain(CHANGED);
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(TG)!.deliveries["tg/event-x"]!.status).toBe("scheduled");
  });

  it("sends nothing when a channel approved for the assisted flow would now post through the API (ruling P3)", async () => {
    const box = {} as { c: Ctx };
    const assisted = tgNote({ status: "scheduled" }, "Doors open at 18:00", { mode: "assisted" });
    const { c, publish, asked } = await setup(
      [
        async () => {
          await writeNote(box.c.app as never, TG, { ...assisted.frontmatter, mode: "auto" }, assisted.body);
          await indexed(box.c.index, () => box.c.index.getVariant(TG)!.mode === "auto");
          return { approved: true, how: "asked" };
        },
      ],
      { note: assisted },
    );
    box.c = c;
    const before = Modal.opened.length;
    const r = await c.call("publish_now", { path: TG });
    expect(asked[0]!.channels).toEqual([{ id: "tg/event-x", name: "Event X channel", how: "opens the assisted flow in Obsidian; you post it", status: "scheduled" }]);
    expect(r).toMatchObject({ ok: false, approved: true });
    expect(r.error).toContain(CHANGED);
    expect(publish).not.toHaveBeenCalled();
    expect(Modal.opened.length).toBe(before);
  });

  it("sends nothing when an API adapter appears while the question was open (ruling P3)", async () => {
    const box = {} as { register: () => void };
    const s = await setup(
      [
        async () => {
          box.register();
          return { approved: true, how: "asked" };
        },
      ],
      { adapter: false },
    );
    box.register = s.register;
    const r = await s.c.call("publish_now", { path: TG });
    expect(s.asked[0]!.channels[0]!.how).toBe("opens the assisted flow in Obsidian; you post it");
    expect(r.error).toContain(CHANGED);
    expect(s.publish).not.toHaveBeenCalled();
  });

  it("an API run refuses when the text on disk no longer matches what was approved (P3 at send time)", async () => {
    const { c, publish } = await setup([]);
    const r = await c.ctx.publish.orchestrator.run(TG, "tg/event-x", () => false);
    expect(r.status).toBe("refused");
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(TG)!.deliveries["tg/event-x"]!.status).toBe("scheduled");
  });

  it("denies a second request while one question is open", async () => {
    const { c } = await setup([], { timeoutMs: 200 });
    const first = c.call("publish_now", { path: TG });
    await tick();
    expect((await c.call("publish_now", { path: TG })).error).toBe(BUSY);
    expect((await first).error).toBe(TIMED_OUT);
  });

  it("publishes once when two calls under the channel setting race", async () => {
    const { c, publish, asked } = await setup([]);
    allow(c, "tg/event-x");
    const results = await Promise.all([c.call("publish_now", { path: TG }), c.call("publish_now", { path: TG })]);
    expect(results.filter((r: R) => r.ok)).not.toHaveLength(0);
    await indexed(c.index, () => c.index.getVariant(TG)?.deliveries["tg/event-x"]?.status === "published");
    await tick(30);
    expect(publish).toHaveBeenCalledOnce();
    expect(asked).toEqual([]);
  });

  it("answers no to a pending question when the plugin unloads, and to every later one", async () => {
    const { c, gate, publish } = await setup([], { timeoutMs: 1_000 });
    allow(c);
    const first = c.call("publish_now", { path: TG });
    await tick();
    gate.dispose();
    expect(await first).toMatchObject({ ok: false, approved: false, error: CLOSED });
    allow(c, "tg/event-x");
    expect(await c.call("publish_now", { path: TG })).toMatchObject({ ok: false, error: CLOSED });
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses API channels on a device that is not the publisher, before asking", async () => {
    const { c, publish, asked } = await setup([{ approved: true, how: "asked" }], { publisher: false });
    const r = await c.call("publish_now", { path: TG });
    expect(r.error).toContain("publisher device");
    expect(asked).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses API channels on another publisher's device even under the channel setting", async () => {
    const { c, publish, asked } = await setup([], { publisher: false });
    c.settings.update((s) => ({ ...s, publisher: { deviceId: "other", name: "Studio iMac", since: 1 } }));
    allow(c, "tg/event-x");
    const r = await c.call("publish_now", { path: TG });
    expect(r.error).toBe("Posts go out through the API only from the publisher device (Studio iMac). Ask the user to publish from there.");
    expect(asked).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends nothing when this device stops being the publisher while the question is open", async () => {
    const box = {} as { c: Ctx };
    const { c, publish } = await setup([
      async () => {
        box.c.settings.update((s) => ({ ...s, publisher: { deviceId: "other", name: "Studio iMac", since: 2 } }));
        return { approved: true, how: "asked" };
      },
    ]);
    box.c = c;
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: false, approved: true });
    expect(r.error).toContain("publisher device (Studio iMac)");
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails closed without a publisher service (ruling P2)", async () => {
    const { c, publish, asked } = await setup([{ approved: true, how: "asked" }]);
    c.ctx.publish.context = null;
    expect(c.ctx.publish.apiBlockedReason()).toMatch(/^No device publishes through the API yet/);
    const r = await c.call("publish_now", { path: TG });
    expect(r.error).toMatch(/^No device publishes through the API yet/);
    expect(asked).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses a note Claude wrote while Obsidian was closed, even under the channel setting (ruling P6)", async () => {
    const { c, publish, asked } = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status: "scheduled" }, "Doors open at 18:00", { review: "claude" }) });
    allow(c, "tg/event-x");
    const r = await c.call("publish_now", { path: TG });
    expect(r.error).toBe(
      "Claude wrote this note while Obsidian was closed. The user approves it first in Obsidian (sidebar, Written by Claude); after that, schedule or publish it.",
    );
    expect(asked).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses blocking issues and deliveries that must not be retried, before asking (P3, P4)", async () => {
    const long = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status: "scheduled" }, "a".repeat(5000)) });
    const r = await long.c.call("publish_now", { path: TG });
    expect(r.issues.map((i: R) => i.code)).toContain("too-long");
    expect(long.asked).toEqual([]);
    for (const status of ["check_needed", "publishing"]) {
      const stuck = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status }) });
      allow(stuck.c, "tg/event-x");
      expect((await stuck.c.call("publish_now", { path: TG })).error).toBe("Nothing left to post for this note.");
      expect(stuck.asked).toEqual([]);
      expect(stuck.publish).not.toHaveBeenCalled();
    }
  });

  it("opens the assisted flow for channels without an API after approval", async () => {
    const { c } = await setup([{ approved: true, how: "asked" }]);
    const before = Modal.opened.length;
    const r = await c.call("publish_now", { path: LI });
    expect(r).toMatchObject({ ok: true, started_api: [], opened_assisted: ["li/acme-studio", "li/maker-lab"] });
    expect(r.message).toContain("assisted flow");
    expect(Modal.opened.length).toBe(before + 1);
  });
});

describe("push_update (#77)", () => {
  const live = { status: "published", at: "2026-10-08T09:00:00+02:00", url: "https://t.me/eventx/42", remote_id: "42" };

  it("pushes an edit to a live post after approval and logs it", async () => {
    const { c, update, asked } = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    const r = await c.call("push_update", { path: TG });
    expect(r).toMatchObject({ ok: true, updated: ["tg/event-x"], failed: [] });
    expect(asked[0]).toMatchObject({ action: "update", channels: [{ id: "tg/event-x", name: "Event X channel", how: "replaces the live text" }] });
    expect(update).toHaveBeenCalledOnce();
    expect((update.mock.calls[0] as unknown as [R])[0].delivery.remoteId).toBe("42");
    expect(c.log.entries).toEqual([expect.objectContaining({ channelId: "tg/event-x", result: "updated", url: "https://t.me/eventx/42" })]);
  });

  it("always asks, even when the channel may publish without asking", async () => {
    const silent = await setup([], { note: tgNote(live) });
    allow(silent.c, "tg/event-x");
    expect(await silent.c.call("push_update", { path: TG })).toMatchObject({ ok: false, approved: false, error: TIMED_OUT });
    expect(silent.asked).toHaveLength(1);
    expect(silent.update).not.toHaveBeenCalled();
    const yes = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    allow(yes.c, "tg/event-x");
    expect(await yes.c.call("push_update", { path: TG })).toMatchObject({ ok: true, updated: ["tg/event-x"] });
    expect(yes.asked).toHaveLength(1);
  });

  it("logs a failed update as update_failed, never as a failed post (ruling P7)", async () => {
    const { c, update } = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    update.mockRejectedValueOnce(new Error("message is not modified"));
    const r = await c.call("push_update", { path: TG });
    expect(r).toMatchObject({ ok: true, updated: [], failed: [{ id: "tg/event-x", error: "message is not modified" }] });
    expect(c.log.entries).toEqual([expect.objectContaining({ channelId: "tg/event-x", result: "update_failed", error: "message is not modified" })]);
    expect(c.index.getVariant(TG)!.deliveries["tg/event-x"]!.status).toBe("published");
  });

  it("sends nothing without an answer, or when the text changed after approval", async () => {
    const silent = await setup([], { note: tgNote(live) });
    expect(await silent.c.call("push_update", { path: TG })).toMatchObject({ ok: false, approved: false, error: TIMED_OUT });
    expect(silent.update).not.toHaveBeenCalled();
    const box = {} as { c: Ctx };
    const changed = await setup(
      [
        async () => {
          await writeNote(box.c.app as never, TG, tgNote(live).frontmatter, "Doors open at 19:00");
          await indexed(box.c.index, () => box.c.index.getVariant(TG)!.excerpt.includes("19:00"));
          return { approved: true, how: "asked" };
        },
      ],
      { note: tgNote(live) },
    );
    box.c = changed.c;
    const r = await changed.c.call("push_update", { path: TG });
    expect(r.error).toContain(CHANGED);
    expect(changed.update).not.toHaveBeenCalled();
  });

  it("refuses on a device that is not the publisher, before asking", async () => {
    const { c, update, asked } = await setup([{ approved: true, how: "asked" }], { note: tgNote(live), publisher: false });
    allow(c, "tg/event-x");
    expect((await c.call("push_update", { path: TG })).error).toMatch(/^No device publishes through the API yet/);
    expect(asked).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses without asking when nothing is live or the platform can't update", async () => {
    const none = await setup([{ approved: true, how: "asked" }]);
    expect((await none.c.call("push_update", { path: TG })).error).toBe("No channel of this post is live on the platform with a known id.");
    const noUpdate = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    noUpdate.c.adapters.register({ platform: "telegram", publish: noUpdate.publish });
    expect((await noUpdate.c.call("push_update", { path: TG })).error).toBe("Telegram posts can't be updated from Obsidian yet.");
    expect([...none.asked, ...noUpdate.asked]).toEqual([]);
  });
});

describe("what is approved is what is sent (fix round 1: C1)", () => {
  it("asks with the unsaved editor text and title, and sends nothing when the title changes in the editor after approval", async () => {
    let buffer = TG_HEAD("Doors open soon") + "Doors open at 19:00\n";
    const { c, publish, asked } = await setup([
      async () => {
        buffer = TG_HEAD("Something else") + "Doors open at 19:00\n";
        return { approved: true, how: "asked" };
      },
    ]);
    openEditor(c, TG, () => buffer);
    const r = await c.call("publish_now", { path: TG });
    expect(asked[0]).toMatchObject({ title: "Doors open soon", text: "Doors open at 19:00" });
    expect(r).toMatchObject({ ok: false, approved: true });
    expect(r.error).toContain(CHANGED);
    await tick(30);
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends nothing when the body changes in the editor after approval", async () => {
    let buffer = TG_HEAD() + "Doors open at 19:00\n";
    const { c, publish } = await setup([
      async () => {
        buffer = TG_HEAD() + "Doors open at 20:00\n";
        return { approved: true, how: "asked" };
      },
    ]);
    openEditor(c, TG, () => buffer);
    expect((await c.call("publish_now", { path: TG })).error).toContain(CHANGED);
    await tick(30);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a retry sends nothing when the title or link changed during the backoff; the delivery ends failed with a clear message", async () => {
    const { c, publish } = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status: "scheduled" }, "Doors open at 18:00", { url: "https://good.example/" }) });
    publish.mockImplementationOnce(async () => {
      await c.writer.setFields(c.index.getVariant(TG)!.file, { title: "Other title", url: "https://other.example/" });
      throw Object.assign(new Error("busy"), { status: 503 });
    });
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: true, started_api: ["tg/event-x"] });
    await indexed(c.index, () => /approved/.test(c.index.getVariant(TG)?.deliveries["tg/event-x"]?.error ?? ""));
    const d = c.index.getVariant(TG)!.deliveries["tg/event-x"]!;
    expect(d.status).toBe("failed");
    expect(d.error).toBe("The post changed after it was approved, so the retry was not sent. Publish it again to send the new version.");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("skips a channel removed from the post after approval", async () => {
    const LIN = "Social/Posts/Li.md";
    const note = {
      path: LIN,
      frontmatter: { type: "social-post", platform: "linkedin", title: "Hello", channels: ["li/me", "li/maker-lab"], status: "scheduled", scheduled_at: "2026-10-08T14:00:00+02:00", deliveries: { "li/me": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" } } },
      body: "Hello LinkedIn",
    };
    const box = {} as { c: Ctx };
    const approvals = scriptedApprovals([
      async () => {
        await writeNote(box.c.app as never, LIN, { ...note.frontmatter, channels: ["li/maker-lab"], deliveries: { "li/maker-lab": { status: "scheduled" } } }, note.body);
        await indexed(box.c.index, () => box.c.index.getVariant(LIN)!.channels.length === 1);
        return { approved: true, how: "asked" };
      },
    ]);
    const c = await mcpCtx({ notes: [note], approvals: approvals.gate });
    box.c = c;
    const publish = vi.fn(async () => ({ remoteId: "1", url: "https://www.linkedin.com/feed/update/1" }));
    c.adapters.register({ platform: "linkedin", publish });
    await c.publisher.claim();
    const r = await c.call("publish_now", { path: LIN });
    expect(approvals.asked[0]!.channels.map((ch) => ch.id)).toEqual(["li/me", "li/maker-lab"]);
    expect(r).toMatchObject({ ok: true, started_api: [], opened_assisted: ["li/maker-lab"] });
    await tick(30);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("the question shows everything that is sent (fix round 1: I1, I2, m2)", () => {
  it("shows the full text, unclipped, and every part of a thread", async () => {
    const long = await setup([], { note: tgNote({ status: "scheduled" }, "a".repeat(4090)) });
    await long.c.call("publish_now", { path: TG });
    expect(long.asked[0]!.text).toBe("a".repeat(4090));
    expect(long.asked[0]!.items).toEqual(["a".repeat(4090)]);
    const BS = "Social/Posts/Bs.md";
    const thread = { path: BS, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-10-08T14:00:00+02:00", deliveries: { "bs/you": { status: "scheduled" } } }, body: "Part one\n\n---\n\nPart two" };
    const approvals = scriptedApprovals([]);
    const c = await mcpCtx({ notes: [thread], approvals: approvals.gate });
    await c.call("publish_now", { path: BS });
    expect(approvals.asked[0]!.items).toEqual(["Part one", "Part two"]);
  });

  it("lists the link, the images with their alt text and the WordPress fields", async () => {
    const approvals = scriptedApprovals([]);
    const tg = tgNote({ status: "scheduled" }, "Doors open at 18:00", { url: "https://eventx.berlin/", media: ["cover.png"], media_meta: { "cover.png": { alt: "The venue at night" } } });
    const WP = "Social/Posts/Wp.md";
    const wp = {
      path: WP,
      frontmatter: {
        type: "social-post",
        platform: "wordpress",
        title: "Event X recap",
        channels: ["wp/eventx-berlin"],
        status: "scheduled",
        scheduled_at: "2026-10-08T14:00:00+02:00",
        deliveries: { "wp/eventx-berlin": { status: "scheduled" } },
        slug: "event-x-recap",
        categories: ["Events"],
        tags: ["berlin", "makers"],
        excerpt: "What happened",
        featured_image: "[[cover.png]]",
      },
      body: "Recap text",
    };
    const c = await mcpCtx({ notes: [tg, wp], approvals: approvals.gate });
    await c.app.vault.createBinary("cover.png", new ArrayBuffer(8));
    await c.call("publish_now", { path: TG });
    const rows = (i: number) => Object.fromEntries(approvals.asked[i]!.details.map((d) => [d.label, d.value]));
    expect(rows(0)).toMatchObject({ Title: "Doors open", Link: "https://eventx.berlin/", "Image 1": "cover.png, alt text: The venue at night" });
    await c.call("publish_now", { path: WP });
    expect(rows(1)).toMatchObject({ Title: "Event X recap", Slug: "event-x-recap", Categories: "Events", Tags: "berlin, makers", Excerpt: "What happened" });
    expect(rows(1)["Featured image"]).toContain("cover.png");
  });

  it("shows a channel waiting for the user, and the channel setting never sends it (m2)", async () => {
    const LIN = "Social/Posts/Li.md";
    const note = {
      path: LIN,
      frontmatter: { type: "social-post", platform: "linkedin", title: "Hello", channels: ["li/me", "li/maker-lab"], status: "scheduled", scheduled_at: "2026-10-08T14:00:00+02:00", deliveries: { "li/me": { status: "scheduled" }, "li/maker-lab": { status: "awaiting_you" } } },
      body: "Hello LinkedIn",
    };
    const asking = scriptedApprovals([]);
    const a = await mcpCtx({ notes: [note], approvals: asking.gate });
    await a.call("publish_now", { path: LIN });
    expect(asking.asked[0]!.channels.map((ch) => [ch.id, ch.status])).toEqual([
      ["li/me", "scheduled"],
      ["li/maker-lab", "waiting for you"],
    ]);

    const policy = scriptedApprovals([], { allowed: () => true });
    const c = await mcpCtx({ notes: [note], approvals: policy.gate });
    const publish = vi.fn(async () => ({ remoteId: "1", url: "https://www.linkedin.com/feed/update/1" }));
    c.adapters.register({ platform: "linkedin", publish });
    await c.publisher.claim();
    const before = Modal.opened.length;
    const r = await c.call("publish_now", { path: LIN });
    expect(r).toMatchObject({ ok: true, approved_by: "channel setting", started_api: ["li/me"], opened_assisted: [] });
    expect(Modal.opened.length).toBe(before);
    expect(policy.asked).toEqual([]);
  });
});
