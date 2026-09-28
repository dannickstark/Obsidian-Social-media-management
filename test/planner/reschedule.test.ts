import { describe, expect, it } from "vitest";
import { planReschedule } from "../../src/planner/reschedule";
import type { PostRow } from "../../src/index/queries";
import type { IndexedVariant } from "../../src/index/socialIndex";

const T = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

function variant(partial: Partial<IndexedVariant>): IndexedVariant {
  return { path: "p.md", platform: "linkedin", channels: ["li/me", "li/acme"], mode: "auto", status: "scheduled", media: [], deliveries: {}, issues: [], excerpt: "", displayTitle: "", file: {} as never, scheduledAt: T(8, 17, 30), staggerMinutes: 15, ...partial };
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

  it.each(["published", "publishing", "skipped"] as const)("refuses to move %s rows", (status) => {
    const v = variant({});
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), status), { at: T(9, 9) }).ok).toBe(false);
  });
});
