import { describe, expect, it } from "vitest";
import { layoutDay, minutesOfDay, weekCells, weekRange, dropMinutes } from "../../src/planner/calendar";
import type { PostRow } from "../../src/index/queries";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe("week helpers", () => {
  it("builds the DST week Mon 19 – Sun 25 Oct 2026 (review focus 2)", () => {
    const cells = weekCells(at(25, 12), 1, at(22, 9));
    expect(cells.map((c) => c.key)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(cells.find((c) => c.isToday)?.key).toBe("2026-10-22");
    const { from, to } = weekRange(at(25, 12), 1);
    expect(to - from).toBe(7 * 86_400_000 + 3_600_000);
  });

  it("uses local wall-clock minutes on the DST day", () => {
    expect(minutesOfDay(at(25, 9))).toBe(540);
  });

  it("puts overlapping posts in lanes", () => {
    const rows = [
      { key: "a", at: at(8, 9) },
      { key: "b", at: at(8, 9, 15) },
      { key: "c", at: at(8, 10) },
    ] as PostRow[];
    expect(layoutDay(rows).map((p) => [p.row.key, p.top, p.lane, p.lanes])).toEqual([
      ["a", 540, 0, 2],
      ["b", 555, 1, 2],
      ["c", 600, 0, 1],
    ]);
  });
});

describe("dropMinutes (G2)", () => {
  // PX_PER_MINUTE is 0.8, so one hour is 48px.
  it("maps the column top to 00:00", () => {
    expect(dropMinutes(100, 100)).toBe(0);
    expect(dropMinutes(90, 100)).toBe(0);
  });

  it("maps a point in the middle of the column to its time", () => {
    expect(dropMinutes(100 + 12 * 48, 100)).toBe(720);
  });

  it("rounds to 15 minutes", () => {
    expect(dropMinutes(100 + 7 * 0.8, 100)).toBe(0);
    expect(dropMinutes(100 + 8 * 0.8, 100)).toBe(15);
    expect(dropMinutes(100 + 23 * 0.8, 100)).toBe(30);
  });

  it("clamps the bottom to 23:45 so a drop never rolls over to the next day", () => {
    expect(dropMinutes(100 + 24 * 48, 100)).toBe(1425);
    expect(dropMinutes(100 + 24 * 48 - 1, 100)).toBe(1425);
    expect(dropMinutes(5000, 100)).toBe(1425);
  });
});
