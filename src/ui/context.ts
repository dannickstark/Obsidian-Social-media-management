import { getContext } from "svelte";
import { readable, type Readable, type Writable } from "svelte/store";
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { IndexSnapshot } from "../index/stores";
import type { McpStatus } from "../mcp/service";
import type { LinkCardFetcher } from "../platforms/og";
import type { ViewState } from "../planner/viewState";
import type { PublishActions } from "../publish/actions";
import type { PublisherService } from "../settings/publisher";
import type { CredentialHealthStore, DeviceSettings } from "../settings/device";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "./actions";

export const OSMM_KEY = Symbol("osmm");

export interface OsmmContext {
  app: App;
  settings: Readable<OsmmSettings>;
  snapshot: Readable<IndexSnapshot>;
  now: Readable<number>;
  viewState: Writable<ViewState>;
  channels: ChannelRegistry;
  actions: PlannerActions;
  composer: ComposerActions;
  publish: PublishActions;
  publisher: PublisherService;
  /** Per-device status and reminder state. Never synced with vault settings. */
  device: Readable<DeviceSettings>;
  credentialHealth: CredentialHealthStore;
  /** The local MCP server's state (desktop); absent where there is none (phones, tests). */
  mcp?: { status: Readable<McpStatus> };
  /** Fetched link cards for the previews (#93); absent in contexts that don't fetch (some tests). */
  linkCards?: Pick<LinkCardFetcher, "get" | "peek">;
}

export function osmmContext(ctx: OsmmContext): Map<unknown, unknown> {
  return new Map<unknown, unknown>([[OSMM_KEY, ctx]]);
}

export function useOsmm(): OsmmContext {
  const ctx = getContext<OsmmContext | undefined>(OSMM_KEY);
  if (!ctx) throw new Error("OSMM context is missing — mount components with osmmContext()");
  return ctx;
}

/** A store with the current time, refreshed every `intervalMs`. */
export function clock(intervalMs = 30_000): Readable<number> {
  return readable(Date.now(), (set) => {
    const id = setInterval(() => set(Date.now()), intervalMs);
    return () => clearInterval(id);
  });
}
