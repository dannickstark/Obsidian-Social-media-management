import { BlueskyAdapter } from "./bluesky/api";
import { DiscordAdapter } from "./discord/api";
import { FacebookAdapter } from "./facebook/api";
import { InstagramAdapter } from "./instagram/api";
import type { InstagramMediaHost } from "./instagram/media";
import type { HttpFn } from "./http";
import { MastodonAdapter } from "./mastodon/api";
import { MetaClient } from "./meta/client";
import type { LinkCard } from "./og";
import { TelegramAdapter } from "./telegram/api";
import type { PlatformAdapter } from "./types";
import { WordPressAdapter } from "./wordpress/api";

/** A file embedded in a note's body, resolved in the vault (WordPress uploads it). */
export interface EmbedFile {
  path: string;
  name: string;
  mime: string;
}

/** What adapters get from the plugin; tests pass the fake requestUrl and short timeouts. */
export interface AdapterDeps {
  http: HttpFn;
  now(): number;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Waits between polls (Mastodon media processing). */
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  /** Optional provider-reachable image host; defaults to an explicit assisted-only refusal. */
  instagramMediaHost?: InstagramMediaHost;
  /** Resolves an image embedded in a body (`![[cover.png]]`) to a vault file; null when it isn't an image in the vault. */
  resolveEmbed?(target: string, fromPath: string): EmbedFile | null;
  /** The link card for a URL (Bluesky's external embed); null when there is none. */
  linkCard?(url: string): Promise<LinkCard | null>;
}

/** Every API adapter the plugin ships. The contract suite (test/platforms/contract) runs against exactly this list. */
export function createAdapters(deps: AdapterDeps): PlatformAdapter[] {
  return [
    new TelegramAdapter(deps),
    new DiscordAdapter(deps),
    new BlueskyAdapter(deps),
    new MastodonAdapter(deps),
    new WordPressAdapter(deps),
    new FacebookAdapter(deps),
    new InstagramAdapter(deps, deps.instagramMediaHost),
  ];
}

/** Shared Graph discovery for future Facebook and Instagram adapters, using this device's HTTP dependency. */
export function createMetaClient(
  deps: Pick<AdapterDeps, "http" | "now" | "timeoutMs">,
): MetaClient {
  return new MetaClient({
    http: deps.http,
    now: deps.now,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
}
