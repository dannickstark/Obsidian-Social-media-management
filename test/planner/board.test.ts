import { describe, expect, it } from "vitest";
import { columnOf, defaultScheduleTime, planBoardMove, scheduleDeliveries, unscheduleDeliveries } from "../../src/planner/board";
import type { IndexedVariant } from "../../src/index/socialIndex";

function v(partial: Partial<IndexedVariant>): IndexedVariant {
  return { path: "p.md", platform: "linkedin", channels: ["li/me"], mode: "auto", status: "draft", media: [], deliveries: {}, issues: [], excerpt: "", displayTitle: "", bodyChars: 0, file: {} as never, ...partial };
}

describe("board", () => {
  it.each([
    ["idea", "idea"],
    ["partial", "scheduled"],
    ["overdue", "scheduled"],
    ["attention", "scheduled"],
    ["published", "published"],
    ["skipped", null],
  ] as const)("columnOf(%s) = %s", (status, col) => {
    expect(columnOf(status)).toBe(col);
  });

  it("plans simple status moves", () => {
    expect(planBoardMove(v({ status: "idea" }), "ready")).toEqual({ ok: true, move: { kind: "setStatus", status: "ready" } });
  });

  it("needs channels to schedule", () => {
    expect(planBoardMove(v({ channels: [] }), "scheduled")).toEqual({ ok: false, reason: "Pick at least one channel before scheduling." });
    expect(planBoardMove(v({}), "scheduled")).toEqual({ ok: true, move: { kind: "schedule" } });
  });

  it("refuses to drag into or out of Published", () => {
    expect(planBoardMove(v({}), "published").ok).toBe(false);
    expect(planBoardMove(v({ status: "published" }), "draft").ok).toBe(false);
  });

  it("refuses to unschedule posts with handed-over or published channels (review focus 3)", () => {
    const post = v({ status: "partial", channels: ["li/me", "li/acme"], deliveries: { "li/me": { status: "published" }, "li/acme": { status: "scheduled" } } });
    expect(planBoardMove(post, "ready")).toEqual({ ok: false, reason: "Some channels were already handed over or published. Unschedule the remaining ones from the post itself." });
    expect(planBoardMove(v({ status: "scheduled", deliveries: { "li/me": { status: "scheduled" } } }), "draft")).toEqual({ ok: true, move: { kind: "unschedule", status: "draft" } });
  });

  it("schedules and unschedules deliveries through legal transitions", () => {
    const post = v({ channels: ["li/me", "li/acme"], deliveries: { "li/me": { status: "ready" } } });
    expect(scheduleDeliveries(post)).toEqual({ "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled" } });
    const scheduled = v({ channels: ["li/me"], deliveries: { "li/me": { status: "scheduled", at: 5 } } });
    expect(unscheduleDeliveries(scheduled, "ready")).toEqual({ "li/me": { status: "ready", at: 5 } });
  });

  it("proposes a sensible default time", () => {
    const now = new Date(2026, 9, 8, 10).getTime();
    expect(defaultScheduleTime(now, v({ scheduledAt: now + 3_600_000 }))).toBe(now + 3_600_000);
    expect(defaultScheduleTime(now, v({}), "08:30")).toBe(new Date(2026, 9, 9, 8, 30).getTime());
  });
});
