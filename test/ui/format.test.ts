import { describe, expect, it } from "vitest";
import { formatTime, initials, monthTitle, weekTitle } from "../../src/ui/format";

describe("format", () => {
  it("formats local times", () => {
    expect(formatTime(Date.UTC(2026, 9, 8, 15, 30))).toBe("17:30");
  });
  it("titles months and weeks", () => {
    expect(monthTitle(2026, 9, "en")).toBe("October 2026");
    expect(weekTitle(new Date(2026, 9, 19).getTime(), new Date(2026, 9, 25).getTime(), "en")).toBe("Oct 19 – Oct 25, 2026");
  });
  it.each([
    ["Acme Studio", "AS"],
    ["@acmestudio", "AC"],
    ["eventx.berlin", "EB"],
    ["Me", "ME"],
    ["", "?"],
  ])("initials(%s) = %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
