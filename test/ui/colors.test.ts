import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../../src/model/platforms";
import { BADGE_TEXT, PLATFORM_COLORS, contrastRatio } from "../../src/ui/colors";

describe("platform colours", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it.each(PLATFORMS)("%s badge text has ≥ 4.5:1 contrast", (platform) => {
    expect(contrastRatio(PLATFORM_COLORS[platform], BADGE_TEXT)).toBeGreaterThanOrEqual(4.5);
  });
});
