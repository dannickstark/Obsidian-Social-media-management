import { describe, expect, it } from "vitest";
import { clampRatio, cropRect, feedRatio, focusFromPoint } from "../../src/media/crop";
import { platformDef } from "../../src/platforms/registry";

describe("crop geometry", () => {
  it("crops a landscape image to a square around the focal point", () => {
    expect(cropRect({ width: 1600, height: 900 }, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(cropRect({ width: 1600, height: 900 }, 1, [0, 0.5])).toEqual({ x: 0, y: 0, width: 900, height: 900 });
    expect(cropRect({ width: 1600, height: 900 }, 1, [1, 0.5])).toEqual({ x: 700, y: 0, width: 900, height: 900 });
  });

  it("crops a portrait image to 16:9", () => {
    expect(cropRect({ width: 1080, height: 1350 }, 16 / 9)).toEqual({ x: 0, y: 371, width: 1080, height: 608 });
  });

  it("clamps ratios into the accepted range", () => {
    expect(clampRatio(0.5, { min: 0.8, max: 1.91 })).toBe(0.8);
    expect(clampRatio(3, { min: 0.8, max: 1.91 })).toBe(1.91);
    expect(clampRatio(1.2)).toBe(1.2);
  });

  it("picks the ratio a feed shows", () => {
    expect(feedRatio(platformDef("x").capabilities.media, { width: 1080, height: 1350 })).toBeCloseTo(16 / 9);
    expect(feedRatio(platformDef("instagram").capabilities.media, { width: 1080, height: 1920 })).toBe(0.8);
    expect(feedRatio(platformDef("linkedin").capabilities.media, { width: 1080, height: 1920 })).toBeNull();
  });

  it("turns a click into a focal point", () => {
    expect(focusFromPoint(150, 75, { left: 100, top: 50, width: 200, height: 100 })).toEqual([0.25, 0.25]);
    expect(focusFromPoint(0, 500, { left: 100, top: 50, width: 200, height: 100 })).toEqual([0, 1]);
  });
});
