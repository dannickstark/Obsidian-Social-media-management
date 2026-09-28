import { describe, expect, it } from "vitest";
import { DAY, HOUR, addLocalDays, formatDateTime, parseDateTime, startOfLocalDay } from "../../src/model/dates";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("parseDateTime (Europe/Berlin)", () => {
  it.each([
    ["2026-10-08T17:30:00+02:00", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T15:30:00Z", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T17:30:00+0200", at(2026, 10, 8, 15, 30)],
    ["2026-10-08 17:30", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T17:30", at(2026, 10, 8, 15, 30)],
    ["2026-12-08 17:30", at(2026, 12, 8, 16, 30)],
    ["2026-10-08", at(2026, 10, 7, 22, 0)],
    ["  2026-10-08 17:30  ", at(2026, 10, 8, 15, 30)],
  ])("parses %s", (input, expected) => {
    expect(parseDateTime(input)).toBe(expected);
  });

  it("accepts Date objects and epoch numbers", () => {
    expect(parseDateTime(new Date(at(2026, 10, 8)))).toBe(at(2026, 10, 8));
    expect(parseDateTime(at(2026, 10, 8))).toBe(at(2026, 10, 8));
  });

  it.each(["2026-02-30", "2026-10-08 25:00", "2026-10-08 12:61", "tomorrow", "", "2026/10/08"])(
    "rejects %s",
    (input) => {
      expect(parseDateTime(input)).toBeNull();
    },
  );

  it.each([null, undefined, {}, [], Number.NaN])("rejects %s", (input) => {
    expect(parseDateTime(input)).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("writes local time with the right offset for summer and winter", () => {
    expect(formatDateTime(at(2026, 10, 8, 15, 30))).toBe("2026-10-08T17:30:00+02:00");
    expect(formatDateTime(at(2026, 12, 8, 16, 30))).toBe("2026-12-08T17:30:00+01:00");
  });

  it("round-trips through parseDateTime", () => {
    for (const t of [at(2026, 3, 29, 1, 30), at(2026, 10, 25, 0, 30), at(2026, 10, 25, 1, 30), at(2027, 1, 1)]) {
      expect(parseDateTime(formatDateTime(t))).toBe(t);
    }
  });
});

describe("local day arithmetic across DST", () => {
  it("keeps wall-clock time when adding a day over the October change", () => {
    const sat = parseDateTime("2026-10-24 09:00")!;
    const sun = addLocalDays(sat, 1);
    expect(formatDateTime(sun)).toBe("2026-10-25T09:00:00+01:00");
    expect(sun - sat).toBe(DAY + HOUR);
  });

  it("finds the start of the local day", () => {
    expect(formatDateTime(startOfLocalDay(parseDateTime("2026-10-25 18:45")!))).toBe("2026-10-25T00:00:00+02:00");
  });
});
