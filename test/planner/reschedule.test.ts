import { describe, expect, it } from "vitest";
import { planReschedule } from "../../src/planner/reschedule";
import type { PostRow } from "../../src/index/queries";
import type { IndexedVariant } from "../../src/index/socialIndex";

const T = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

function variant(partial: Partial<IndexedVariant>): IndexedVariant {
  return { path: "p.md", platform: "linkedin", channels: ["li/me", "li/acme"], mode: "auto", status: "scheduled", media: [], deliveries: {}, issues: [], excerpt: "", displayTitle: "", bodyChars: 0, file: {} as never, scheduledAt: T(8, 17, 30), staggerMinutes: 15, ...partial };
}
const rowOf = (v: IndexedVariant, channelId: string, at: number, status: PostRow["status"] = "scheduled"): PostRow => ({ key: `${v.path}#${channelId}`, variant: v, channelId, status, at });

describe("planReschedule", () => {
  it("moves a staggered second channel exactly to the drop time, shifting the whole post (review focus 1)", () => {
    const v = variant({});
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 17, 45)), { at: T(9, 10, 0) });
    expect(plan).toMatchObject({ ok: true, newAt: T(9, 10, 0), needsConfirm: false });
    if (!plan.ok) throw new Error();
    expect(plan.patch.scheduledAt).toBe(T(9, 9, 45));
    expect(plan.previous.scheduledAt).toBe(T(8, 17, 30));
  });

  it("keeps the time of day when dropped on a month day", () => {
    const v = variant({ channels: ["li/me"] });
    const plan = planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { day: T(12, 0) });
    expect(plan.ok && plan.patch.scheduledAt).toBe(T(12, 17, 30));
  });

  it("uses the default time for unscheduled posts", () => {
    const v = variant({ channels: [], scheduledAt: undefined, status: "draft" });
    const plan = planReschedule({ key: "p.md#", variant: v, channelId: null, status: "draft" }, { day: T(12, 0) }, "08:30");
    expect(plan.ok && plan.patch.scheduledAt).toBe(T(12, 8, 30));
  });

  it("drops the send key of a failed channel it moves, and keeps the one of a channel waiting for a check (M5 P17)", () => {
    const v = variant({ deliveries: { "li/me": { status: "failed", attempts: 2, sendAt: T(8, 17, 30), sendKey: "3mxdyj6ws22jm" }, "li/acme": { status: "check_needed", sendAt: T(8, 17, 45), sendKey: "3mxdyj6ws22jn" } } });
    const whole = planReschedule(rowOf(v, "li/me", T(8, 17, 30), "failed"), { at: T(9, 10, 0) });
    if (!whole.ok) throw new Error();
    expect(whole.patch.deliveries?.["li/me"]).toEqual({ status: "failed", attempts: 2 });
    expect(whole.patch.deliveries?.["li/acme"]).toMatchObject({ sendAt: T(8, 17, 45), sendKey: "3mxdyj6ws22jn" });
    const own = variant({ deliveries: { "li/acme": { status: "failed", at: T(8, 20), sendAt: T(8, 20) } } });
    const one = planReschedule(rowOf(own, "li/acme", T(8, 20), "failed"), { at: T(9, 8) });
    if (!one.ok) throw new Error();
    expect(one.patch.deliveries?.["li/acme"]).toEqual({ status: "failed", at: T(9, 8) });
  });

  it("moves only the channel when it has an explicit time", () => {
    const v = variant({ deliveries: { "li/acme": { status: "scheduled", at: T(8, 20) } } });
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 20)), { at: T(9, 8) });
    if (!plan.ok) throw new Error();
    expect(plan.patch.scheduledAt).toBe(T(8, 17, 30));
    expect(plan.patch.deliveries?.["li/acme"]?.at).toBe(T(9, 8));
  });

  it("re-schedules overdue deliveries it moves", () => {
    const v = variant({ channels: ["li/me"], deliveries: { "li/me": { status: "overdue" } } });
    const plan = planReschedule(rowOf(v, "li/me", T(6, 18), "overdue"), { at: T(9, 18) });
    expect(plan.ok && plan.patch.deliveries?.["li/me"]?.status).toBe("scheduled");
  });

  it("asks for confirmation when a moved delivery was handed over (review focus 3)", () => {
    const v = variant({ channels: ["li/me"], deliveries: { "li/me": { status: "handed_over" } } });
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), "handed_over"), { at: T(9, 9) })).toMatchObject({ ok: true, needsConfirm: true });
  });

  it("asks for confirmation when a moved delivery is awaiting the user (ruling P2)", () => {
    const v = variant({ channels: ["li/me"], deliveries: { "li/me": { status: "awaiting_you" } } });
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), "awaiting_you"), { at: T(9, 9) })).toMatchObject({
      ok: true,
      needsConfirm: true,
      awaitingYou: true,
    });
  });

  it("still asks for an awaiting-you sibling without its own time, which moves with the post (ruling P2)", () => {
    const v = variant({ deliveries: { "li/acme": { status: "awaiting_you" } } });
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { at: T(9, 9) })).toMatchObject({ ok: true, needsConfirm: true, awaitingYou: true });
  });

  it("does not ask for confirmation for an awaiting-you sibling with its own time, which does not move (ruling P2)", () => {
    const v = variant({ deliveries: { "li/acme": { status: "awaiting_you", at: T(8, 20) } } });
    const plan = planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { at: T(9, 9) });
    expect(plan).toMatchObject({ ok: true, needsConfirm: false });
    expect(plan.ok && plan.patch.deliveries?.["li/acme"]).toEqual({ status: "awaiting_you", at: T(8, 20) });
  });

  it("does not ask for confirmation for a handed-over sibling with its own time, which does not move (G5)", () => {
    const v = variant({ deliveries: { "li/acme": { status: "handed_over", at: T(8, 20) } } });
    const plan = planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { at: T(9, 9) });
    expect(plan).toMatchObject({ ok: true, needsConfirm: false });
    expect(plan.ok && plan.patch.deliveries?.["li/acme"]).toEqual({ status: "handed_over", at: T(8, 20) });
  });

  it("still asks for a handed-over sibling without its own time, which moves with the post (G5)", () => {
    const v = variant({ deliveries: { "li/acme": { status: "handed_over" } } });
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { at: T(9, 9) })).toMatchObject({ ok: true, needsConfirm: true });
  });

  it.each(["published", "publishing", "skipped"] as const)("refuses to move %s rows", (status) => {
    const v = variant({});
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), status), { at: T(9, 9) }).ok).toBe(false);
  });

  it("keeps a published sibling channel's time unchanged when the whole post shifts", () => {
    const v = variant({ channels: ["li/me", "li/acme", "li/team"], deliveries: { "li/me": { status: "published" } } });
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 17, 45)), { at: T(9, 10, 0) });
    if (!plan.ok) throw new Error();
    expect(plan.patch.scheduledAt).toBe(T(9, 9, 45));
    expect(plan.patch.deliveries?.["li/me"]).toMatchObject({ status: "published", at: T(8, 17, 30) });
  });

  it("keeps a skipped sibling channel's time unchanged when the whole post shifts", () => {
    const v = variant({ channels: ["li/me", "li/acme", "li/team"], deliveries: { "li/me": { status: "skipped" } } });
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 17, 45)), { at: T(9, 10, 0) });
    if (!plan.ok) throw new Error();
    expect(plan.patch.deliveries?.["li/me"]).toMatchObject({ status: "skipped", at: T(8, 17, 30) });
  });

  it("copies deliveries into `previous` instead of aliasing the live object", () => {
    const v = variant({ deliveries: { "li/acme": { status: "scheduled" } } });
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 17, 45)), { at: T(9, 10, 0) });
    if (!plan.ok) throw new Error();
    expect(plan.previous.deliveries).not.toBe(v.deliveries);
    expect(plan.previous.deliveries).toEqual(v.deliveries);
  });
});
