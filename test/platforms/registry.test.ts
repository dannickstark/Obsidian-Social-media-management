/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META } from "../../src/model/platforms";
import type { Channel } from "../../src/model/types";
import { AdapterRegistry, PLATFORM_DEFS, effectiveMethod, platformDef } from "../../src/platforms/registry";
import { createAdapters } from "../../src/platforms/adapters";
import type { PlatformAdapter, PlatformDef } from "../../src/platforms/types";

const folders = import.meta.glob<{ def: PlatformDef }>("../../src/platforms/*/index.ts", { eager: true });

const channel = (method: Channel["method"]): Channel => ({
  id: "li/me",
  platform: "linkedin",
  name: "Me",
  kind: "profile",
  avatarColor: "#c9c3b8",
  method,
});

describe("platform registry", () => {
  it("has one folder per platform, and the registry lists every folder", () => {
    const ids = Object.values(folders).map((m) => m.def.id).sort();
    expect(ids).toEqual([...PLATFORMS].sort());
    for (const m of Object.values(folders)) expect(PLATFORM_DEFS[m.def.id]).toBe(m.def);
  });

  it.each(PLATFORMS)("%s capabilities agree with the platform metadata", (p) => {
    const def = platformDef(p);
    expect(def.id).toBe(p);
    expect(def.capabilities.threads).toBe(PLATFORM_META[p].threads);
    expect(def.capabilities.limits.maxChars).toBeGreaterThan(0);
    expect(def.capabilities.media.video).toBe(false);
  });

  it("follows the spec §4.2 platform matrix", () => {
    expect(PLATFORMS.filter((p) => platformDef(p).capabilities.nativeSchedule)).toEqual(["facebook", "mastodon", "wordpress"]);
    expect(PLATFORMS.filter((p) => !platformDef(p).capabilities.api)).toEqual(["hackernews", "indiehackers", "reddit", "whatsapp"]);
  });
});

describe("effectiveMethod", () => {
  const publisher: PlatformAdapter = { platform: "linkedin", publish: async () => ({ remoteId: "1", url: "https://x" }) };
  const scheduler: PlatformAdapter = { ...publisher, schedule: async () => ({ remoteId: "1" }) };

  it("is assisted without an adapter, whatever the channel says (M2 has no adapters)", () => {
    expect(effectiveMethod("auto", channel("api"), undefined)).toBe("assisted");
    expect(effectiveMethod("auto", channel("native"), undefined)).toBe("assisted");
  });

  it("uses the adapter when the channel and the post allow it", () => {
    expect(effectiveMethod("auto", channel("api"), publisher)).toBe("api");
    expect(effectiveMethod("auto", channel("native"), scheduler)).toBe("native");
    expect(effectiveMethod("auto", channel("native"), publisher)).toBe("api");
  });

  it("is assisted when the post or the channel is assisted, or the channel is unknown", () => {
    expect(effectiveMethod("assisted", channel("api"), publisher)).toBe("assisted");
    expect(effectiveMethod("auto", channel("assisted"), publisher)).toBe("assisted");
    expect(effectiveMethod("auto", undefined, publisher)).toBe("assisted");
  });

  it("registers adapters per platform", () => {
    const registry = new AdapterRegistry();
    expect(registry.get("linkedin")).toBeUndefined();
    registry.register(publisher);
    expect(registry.get("linkedin")).toBe(publisher);
  });

  it("does not register Instagram API publishing without a public media host", () => {
    const adapters = createAdapters({
      http: async () => ({ status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }),
      now: () => 0,
      readBinary: async () => new ArrayBuffer(0),
      sleep: async () => undefined,
    });
    expect(adapters.some((adapter) => adapter.platform === "instagram")).toBe(false);
    const igChannel = { ...channel("api"), id: "ig/me", platform: "instagram" as const };
    expect(effectiveMethod("auto", igChannel, undefined)).toBe("assisted");
  });
});
