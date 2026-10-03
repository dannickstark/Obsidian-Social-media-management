import { describe, expect, it } from "vitest";
import { cropFromFocus } from "../../src/images/crops";
import { png } from "../media/bytes";

describe("focal-point image crops", () => {
  it("selects a centered square from a landscape image without changing source bytes", async () => {
    const source = png(1600, 900);
    let rectangle: unknown;
    const cropped = await cropFromFocus(source, 1, [0.5, 0.5], async (_bytes, rect) => {
      rectangle = rect;
      return png(rect.width, rect.height);
    });
    expect(rectangle).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(new Uint8Array(cropped)).toEqual(new Uint8Array(png(900, 900)));
    expect(new Uint8Array(source)).toEqual(new Uint8Array(png(1600, 900)));
  });

  it("clamps focal points to the image edges", async () => {
    const rectangles: unknown[] = [];
    const renderer = async (_bytes: ArrayBuffer, rect: { x: number; y: number; width: number; height: number }) => {
      rectangles.push(rect);
      return png(rect.width, rect.height);
    };
    await cropFromFocus(png(1600, 900), 1, [-5, 0.5], renderer);
    await cropFromFocus(png(1600, 900), 1, [7, 0.5], renderer);
    expect(rectangles).toEqual([
      { x: 0, y: 0, width: 900, height: 900 },
      { x: 700, y: 0, width: 900, height: 900 },
    ]);
  });

  it("rejects invalid ratios and non-images before attempting a crop", async () => {
    await expect(cropFromFocus(png(10, 10), 0, [0.5, 0.5])).rejects.toThrow(/ratio/i);
    await expect(cropFromFocus(new ArrayBuffer(2), 1, [0.5, 0.5])).rejects.toThrow(/image/i);
  });
});
