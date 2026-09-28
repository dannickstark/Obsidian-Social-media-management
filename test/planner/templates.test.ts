import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, campaignTimeline, formatTemplateLines, parseTemplateLines, planTemplate, relativeDayLabel } from "../../src/planner/templates";
import type { IndexedVariant } from "../../src/index/socialIndex";

const anchor = new Date(2026, 9, 12, 18).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const v = (path: string, platform: IndexedVariant["platform"], scheduledAt?: number, status: IndexedVariant["status"] = "draft") =>
  ({ path, platform, scheduledAt, status, channels: [], deliveries: {} }) as unknown as IndexedVariant;

describe("template lines", () => {
  it("parses and formats", () => {
    const { steps, errors } = parseTemplateLines("T-7 09:00 linkedin,x Announce\nT0 17:30 x\nT+1 09:00 linkedin Recap");
    expect(errors).toEqual([]);
    expect(steps).toEqual([
      { offsetDays: -7, time: "09:00", platforms: ["linkedin", "x"], label: "Announce" },
      { offsetDays: 0, time: "17:30", platforms: ["x"], label: "" },
      { offsetDays: 1, time: "09:00", platforms: ["linkedin"], label: "Recap" },
    ]);
    expect(formatTemplateLines(steps)).toBe("T-7 09:00 linkedin,x Announce\nT0 17:30 x\nT+1 09:00 linkedin Recap");
  });

  it("reports bad lines", () => {
    expect(parseTemplateLines("T-7 9am linkedin\nT-2 10:00 myspace").errors).toEqual([
      'Line 1: expected "T±days HH:mm platforms [label]"',
      "Line 2: unknown platform myspace",
    ]);
  });

  it("ships a Launch template", () => {
    expect(DEFAULT_TEMPLATES[0]!.name).toBe("Launch");
  });
});

describe("timeline", () => {
  it("labels days relative to the anchor", () => {
    expect(relativeDayLabel(at(5, 9), anchor)).toBe("T-7");
    expect(relativeDayLabel(at(12, 23), anchor)).toBe("T0");
    expect(relativeDayLabel(at(13, 9), anchor)).toBe("T+1");
  });

  it("groups variants by relative day", () => {
    const steps = campaignTimeline(anchor, [v("a", "linkedin", at(5, 9), "published"), v("b", "x", at(5, 9, 5), "published"), v("c", "instagram", at(12, 16))]);
    expect(steps.map((s) => [s.label, s.platforms, s.done])).toEqual([
      ["T-7", ["linkedin", "x"], true],
      ["T0", ["instagram"], false],
    ]);
  });
});

describe("planTemplate", () => {
  it("assigns steps to variants of matching platforms, in order", () => {
    const template = { id: "t", name: "T", steps: parseTemplateLines("T-7 09:00 linkedin,x\nT+1 09:00 linkedin").steps };
    // The pool is ordered by current schedule, so li.md (Oct 1) is used before li-recap.md (Oct 2).
    const proposals = planTemplate(template, anchor, [v("li-recap.md", "linkedin", at(2, 9)), v("li.md", "linkedin", at(1, 9)), v("x.md", "x"), v("pub.md", "x", at(1, 9), "published")]);
    expect(proposals.map((p) => [p.variant.path, p.to, p.label])).toEqual([
      ["li.md", at(5, 9), "T-7"],
      ["x.md", at(5, 9), "T-7"],
      ["li-recap.md", at(13, 9), "T+1"],
    ]);
  });
});
