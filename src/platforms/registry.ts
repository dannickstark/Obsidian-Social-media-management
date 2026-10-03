import type { Platform } from "../model/platforms";
import type { Channel, PostMode } from "../model/types";
import { def as bluesky } from "./bluesky";
import { def as discord } from "./discord";
import { def as facebook } from "./facebook";
import { def as hackernews } from "./hackernews";
import { def as indiehackers } from "./indiehackers";
import { def as instagram } from "./instagram";
import { def as linkedin } from "./linkedin";
import { def as mastodon } from "./mastodon";
import { def as reddit } from "./reddit";
import { def as telegram } from "./telegram";
import { def as whatsapp } from "./whatsapp";
import { def as wordpress } from "./wordpress";
import { def as x } from "./x";
import type { PlatformAdapter, PlatformDef } from "./types";

/** Adding a platform = adding a folder with `index.ts` and one line here; the registry test enumerates the folders. */
export const PLATFORM_DEFS: Readonly<Record<Platform, PlatformDef>> = {
  linkedin,
  x,
  instagram,
  facebook,
  mastodon,
  bluesky,
  telegram,
  discord,
  hackernews,
  indiehackers,
  reddit,
  whatsapp,
  wordpress,
};

export function platformDef(platform: Platform): PlatformDef {
  return PLATFORM_DEFS[platform];
}

/** The API adapters available on this device. Empty in M2; M5/M6 register real ones. */
export class AdapterRegistry {
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: Platform): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  /** A provider may report expiry through verify or a future refresh implementation. */
  canRefresh(platform: Platform): boolean {
    return !!this.adapters.get(platform)?.refreshCredential;
  }
}

export type EffectiveMethod = "api" | "native" | "assisted";

/**
 * How a delivery will actually run. The channel's configured method is a wish; without an adapter
 * that can do it, every channel falls back to the assisted flow (spec §10: assisted fallback everywhere).
 */
export function effectiveMethod(
  mode: PostMode,
  channel: Channel | undefined,
  adapter: PlatformAdapter | undefined,
): EffectiveMethod {
  if (mode === "assisted" || !channel || channel.method === "assisted") return "assisted";
  if (!PLATFORM_DEFS[channel.platform].capabilities.api) return "assisted";
  if (
    channel.platform === "facebook" &&
    (!channel.secretId || channel.kind !== "page" || !/^\d+$/.test(channel.handle ?? ""))
  )
    return "assisted";
  if (adapter?.apiAvailable && !adapter.apiAvailable(channel)) return "assisted";
  if (
    channel.method === "native" &&
    PLATFORM_DEFS[channel.platform].capabilities.nativeSchedule &&
    adapter?.schedule
  ) return "native";
  if (adapter?.publish) return "api";
  return "assisted";
}
