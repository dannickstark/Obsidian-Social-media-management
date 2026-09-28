import { describe, expect, it } from "vitest";
import { imageSize } from "../../src/media/imageSize";
import { gif, jpeg, png, webpExtended, webpLossless, webpLossy } from "./bytes";

describe("imageSize", () => {
  it.each([
    ["PNG", png(1080, 1350), { width: 1080, height: 1350, mime: "image/png" }],
    ["GIF", gif(480, 270), { width: 480, height: 270, mime: "image/gif" }],
    ["JPEG", jpeg(640, 480), { width: 640, height: 480, mime: "image/jpeg" }],
    ["WebP extended", webpExtended(1080, 1350), { width: 1080, height: 1350, mime: "image/webp" }],
    ["WebP lossless", webpLossless(300, 200), { width: 300, height: 200, mime: "image/webp" }],
    ["WebP lossy", webpLossy(1200, 628), { width: 1200, height: 628, mime: "image/webp" }],
  ])("reads %s headers", (_name, bytes, expected) => {
    expect(imageSize(new Uint8Array(bytes))).toEqual(expected);
  });

  it("returns null for anything else", () => {
    expect(imageSize(new TextEncoder().encode("hello, not an image"))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });
});
