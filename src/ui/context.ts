import { getContext } from "svelte";
import { readable, type Readable, type Writable } from "svelte/store";
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { IndexSnapshot } from "../index/stores";
import type { ViewState } from "../planner/viewState";
import type { PublishActions } from "../publish/actions";
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
