import { getFrontMatterInfo, parseYaml } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { Notice } from "../fakes/obsidian";
import { formatDateTime, HOUR, MINUTE } from "../../src/model/dates";
import { RemoteRemovedError, ReplacementUnknownError } from "../../src/platforms/errors";
import type { PlatformAdapter } from "../../src/platforms/types";
import { HELD_REFUSAL } from "../../src/index/queries";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + 2 * HOUR;

async function fm(c: TestCtx): Promise<Record<string, unknown>> {
  const deliveries = (parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, Record<string, unknown>> }).deliveries;
  return deliveries["ma/you"]!;
}

/** A Mastodon post handed over for AT, in sync with the note, then `edit` applied to the note. */
async function setup(adapter: Partial<PlatformAdapter> = {}, edit: { body?: string; at?: number } = {}) {
  const c = await makeCtx({
    seed: true,
    notes: [{ path: P, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), remote_id: "3221", digest: "pending" } } }, body: "Doors open at 18:00" }],
  });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native", handle: "@you@mastodon.social", secretId: "osmm-channel-ma-you" });
  const full = { platform: "mastodon" as const, minLeadMs: 5 * MINUTE, update: vi.fn(async () => ({ remoteId: "3222" })), cancel: vi.fn(async () => undefined), ...adapter };
  c.adapters.register(full);
  const v = c.index.getVariant(P)!;
  await c.writer.updateVariant(v.file, (fresh) => ({ deliveries: { "ma/you": { ...fresh.deliveries["ma/you"]!, digest: v.digest!, ...(edit.at !== undefined ? { at: edit.at } : {}) } } }));
  if (edit.body !== undefined) await c.writer.editBody(v.file, () => edit.body!);
  await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.digest === v.digest && (edit.body === undefined || c.index.getVariant(P)?.digest !== v.digest));
  return { c, adapter: full, digest: v.digest! };
}

describe("Push update (#66)", () => {
  it("pushes changed text, then records the new version and the platform's new id", async () => {
    const { c, adapter, digest } = await setup({}, { body: "Doors open at 18:30" });
    expect(c.ctx.publish.syncOf(P, "ma/you")).toMatchObject({ state: "out_of_sync", content: true, time: false });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(true);
    expect(adapter.update).toHaveBeenCalledWith(expect.objectContaining({ items: ["Doors open at 18:30"], delivery: expect.objectContaining({ remoteId: "3221" }) }), { content: true, time: false });
    const d = await fm(c);
    expect(d).toMatchObject({ status: "handed_over", remote_id: "3222", remote_at: formatDateTime(AT) });
    expect(d.digest).not.toBe(digest);
    await indexed(c.index, () => c.ctx.publish.syncOf(P, "ma/you")?.state === "in_sync");
    expect(c.log.entries.at(-1)).toMatchObject({ result: "updated", channelId: "ma/you" });
  });

  it("pushes a new time", async () => {
    const { c, adapter } = await setup({}, { at: AT + HOUR });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(true);
    expect(adapter.update).toHaveBeenCalledWith(expect.anything(), { content: false, time: true });
    expect(await fm(c)).toMatchObject({ at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT + HOUR) });
  });

  it("refuses a push too close to the platform time (review focus 3)", async () => {
    const { c, adapter } = await setup({}, { body: "Late edit" });
    c.now.set(AT - 5 * MINUTE);
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    expect(adapter.update).not.toHaveBeenCalled();
    expect(Notice.messages.at(-1)).toBe("@you@mastodon.social: It is too close to its time on Mastodon to change it now. It goes out as it was handed over.");
  });

  it("refuses a version with blocking issues (M2b P3)", async () => {
    const { c, adapter } = await setup({}, { body: "x".repeat(600) });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("returns the channel to scheduled when the platform copy is gone", async () => {
    const { c } = await setup({ update: vi.fn(async () => Promise.reject(new RemoteRemovedError("Mastodon: the old scheduled post was removed, but the new one could not be scheduled."))) }, { body: "New" });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    const d = await fm(c);
    expect(d).toMatchObject({ status: "scheduled", error: "Mastodon: the old scheduled post was removed, but the new one could not be scheduled." });
    expect(d.remote_id).toBeUndefined();
    expect(d.remote_at).toBeUndefined();
    expect(d.digest).toBeUndefined();
    expect(c.log.entries.at(-1)).toMatchObject({ result: "update_failed" });
  });

  it("parks an uncertain Mastodon replacement on check needed with the pushed baseline", async () => {
    const { c } = await setup({ update: vi.fn(async () => Promise.reject(new ReplacementUnknownError())) }, { body: "Maybe replaced", at: AT + HOUR });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    const d = await fm(c);
    expect(d).toMatchObject({ status: "check_needed", remote_at: formatDateTime(AT + HOUR), error: expect.stringContaining("may or may not be scheduled") });
    expect(d.remote_id).toBeUndefined();
    expect(d.digest).toBe(c.index.getVariant(P)?.digest);
  });

  it("shows the pushed time for approval and refuses when it changes afterwards", async () => {
    const { c } = await setup({}, { at: AT + HOUR });
    await c.publisher.claim();
    const plan = await c.ctx.publish.prepareUpdate(P);
    if ("refuse" in plan) throw new Error(plan.refuse);
    expect(plan.details).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Time on @you@mastodon.social", value: expect.stringContaining("Mastodon has") })]));
    await c.writer.updateVariant(c.index.getVariant(P)!.file, (fresh) => ({ deliveries: { "ma/you": { ...fresh.deliveries["ma/you"]!, at: AT + 2 * HOUR } } }));
    expect(await c.ctx.publish.updateApproved(plan)).toEqual({ refuse: "The post changed after it was approved, so nothing was sent. Ask again with the new text." });
  });

  it("shows the user-facing held-note refusal from Push update", async () => {
    const { c } = await setup({}, { body: "Held edit" });
    await c.writer.updateVariant(c.index.getVariant(P)!.file, () => ({ fields: { review: "claude" } }));
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    expect(Notice.messages.at(-1)).toBe(HELD_REFUSAL);
  });

  it("writes the same baseline when Claude's push_update is approved", async () => {
    const { c, digest } = await setup({}, { body: "From Claude" });
    await c.publisher.claim();
    const plan = await c.ctx.publish.prepareUpdate(P);
    if ("refuse" in plan) throw new Error(plan.refuse);
    expect(await c.ctx.publish.updateApproved(plan)).toEqual({ updated: ["ma/you"], failed: [] });
    expect((await fm(c)).digest).not.toBe(digest);
  });

  it("re-reads the note before every approved channel update", async () => {
    const other = "ma/other";
    const c = await makeCtx({
      seed: true,
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you", other], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), remote_id: "1", digest: "pending" }, [other]: { status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), remote_id: "2", digest: "pending" } } }, body: "Approved text" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native" });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, id: other, name: "Other", method: "native" });
    const indexedVariant = c.index.getVariant(P)!;
    await c.writer.updateVariant(indexedVariant.file, (fresh) => ({ deliveries: Object.fromEntries(["ma/you", other].map((id) => [id, { ...fresh.deliveries[id]!, digest: indexedVariant.digest! }])) }));
    await c.writer.editBody(indexedVariant.file, () => "Approved edit");
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries[other]?.digest === indexedVariant.digest && c.index.getVariant(P)?.digest !== indexedVariant.digest);
    let calls = 0;
    c.adapters.register({
      platform: "mastodon",
      minLeadMs: 5 * MINUTE,
      update: vi.fn(async () => {
        calls++;
        if (calls === 1) await c.writer.editBody(indexedVariant.file, () => "Changed during the first update");
        return {};
      }),
    });
    await c.publisher.claim();
    const plan = await c.ctx.publish.prepareUpdate(P);
    if ("refuse" in plan) throw new Error(plan.refuse);
    expect(await c.ctx.publish.updateApproved(plan)).toEqual({
      updated: ["ma/you"],
      failed: [{ id: other, error: "The post changed after it was approved, so nothing was sent. Ask again with the new text." }],
    });
  });
});

describe("Revert time and Unschedule on the platform (#66)", () => {
  it("puts the platform's time back on the note, with Undo", async () => {
    const { c } = await setup({}, { at: AT + HOUR });
    expect(await c.ctx.publish.revertTime(P, "ma/you")).toBe(true);
    expect((await fm(c)).at).toBe(formatDateTime(AT));
  });

  it("takes the post off the platform's schedule after asking, and makes the channel a draft again", async () => {
    const { c, adapter } = await setup();
    c.ctx.actions.confirm = async () => true;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(true);
    expect(adapter.cancel).toHaveBeenCalledWith(expect.objectContaining({ delivery: expect.objectContaining({ remoteId: "3221" }) }));
    expect(await fm(c)).toEqual({ status: "draft" });
    expect(c.log.entries.at(-1)).toMatchObject({ result: "cancelled" });
  });

  it("changes nothing when the user says no or the platform refuses", async () => {
    const { c, adapter } = await setup({ cancel: vi.fn(async () => Promise.reject(new Error("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon."))) });
    c.ctx.actions.confirm = async () => false;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(false);
    expect(adapter.cancel).not.toHaveBeenCalled();
    c.ctx.actions.confirm = async () => true;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(false);
    expect((await fm(c)).status).toBe("handed_over");
    expect(Notice.messages.at(-1)).toBe("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon.");
  });
});
