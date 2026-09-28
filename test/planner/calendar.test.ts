import { describe, expect, it } from "vitest";
import { dayKey, groupByDay, monthGrid, monthRange, shiftMonth, weekdayLabels } from "../../src/planner/calendar";
import type { PostRow } from "../../src/index/queries";

const today = new Date(2026, 9, 8, 10).getTime();

describe("monthGrid", () => {
  it("builds October 2026 with Monday start (matches mockup: starts Sep 28, 5 weeks)", () => {
    const weeks = monthGrid(2026, 9, 1, today);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]!.key).toBe("2026-09-28");
    expect(weeks[4]![6]!.key).toBe("2026-11-01");
    expect(weeks.flat().filter((c) => c.isToday).map((c) => c.key)).toEqual(["2026-10-08"]);
  });

  it("handles Sunday start and a 4-week February (review focus 2)", () => {
    const weeks = monthGrid(2026, 1, 0, today);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]!.key).toBe("2026-02-01");
  });

  it("has exactly one cell per day across the DST change", () => {
    const keys = monthGrid(2026, 9, 1, today).flat().map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("2026-10-25");
    expect(keys).toContain("2026-10-26");
  });

  it("gives the query range for the whole grid", () => {
    const { from, to } = monthRange(2026, 9, 1);
    expect(dayKey(from)).toBe("2026-09-28");
    expect(dayKey(to)).toBe("2026-11-02");
  });
});

describe("helpers", () => {
  it("labels weekdays for both week starts", () => {
    expect(weekdayLabels(1, "en")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayLabels(0, "en")[0]).toBe("Sun");
  });

  it("shifts months across years", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it("groups rows by local day, sorted by time", () => {
    const rows = [
      { key: "b", at: new Date(2026, 9, 8, 17).getTime() },
      { key: "a", at: new Date(2026, 9, 8, 9).getTime() },
      { key: "c", at: new Date(2026, 9, 9, 0, 30).getTime() },
      { key: "d" },
    ] as PostRow[];
    const grouped = groupByDay(rows);
    expect(grouped.get("2026-10-08")?.map((r) => r.key)).toEqual(["a", "b"]);
    expect(grouped.get("2026-10-09")?.map((r) => r.key)).toEqual(["c"]);
    expect([...grouped.keys()]).toHaveLength(2);
  });
});
