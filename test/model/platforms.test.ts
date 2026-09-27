import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META, channelPlatform, isPlatform, platformByPrefix } from "../../src/model/platforms";

describe("platforms", () => {
  it("has metadata with a unique prefix for every platform", () => {
    const prefixes = PLATFORMS.map((p) => PLATFORM_META[p].prefix);
    expect(new Set(prefixes).size).toBe(PLATFORMS.length);
    for (const p of PLATFORMS) expect(PLATFORM_META[p].id).toBe(p);
  });

  it("recognises platform ids", () => {
    expect(isPlatform("linkedin")).toBe(true);
    expect(isPlatform("myspace")).toBe(false);
    expect(platformByPrefix("wp")).toBe("wordpress");
  });

  it.each([
    ["li/acme-studio", "linkedin"],
    ["x/you", "x"],
    ["wp/eventx-berlin", "wordpress"],
    ["zz/acme", undefined],
    ["li/Acme", undefined],
    ["li/-acme", undefined],
    ["li/acme-", undefined],
    ["li/", undefined],
  ])("channelPlatform(%s) = %s", (id, expected) => {
    expect(channelPlatform(id)).toBe(expected);
  });
});
