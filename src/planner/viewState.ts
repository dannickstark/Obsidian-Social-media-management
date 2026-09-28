import { writable, type Writable } from "svelte/store";
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { RowFilter, RowStatus } from "../index/queries";
import { isRecord } from "../model/frontmatter";
import { isPlatform, type Platform } from "../model/platforms";
import { DELIVERY_STATUSES } from "../model/schemas";

export const PLANNER_MODES = ["month", "week", "board", "list"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];

export interface PlannerFilter {
  platforms: Platform[];
  /** Channel ids or `group:<id>` references. */
  channels: string[];
  /** Campaign note paths; "" = standalone posts. */
  campaigns: string[];
  statuses: RowStatus[];
}

export interface ViewState {
  mode: PlannerMode;
  filter: PlannerFilter;
}

export const EMPTY_FILTER: PlannerFilter = { platforms: [], channels: [], campaigns: [], statuses: [] };
export const DEFAULT_VIEW_STATE: ViewState = { mode: "month", filter: EMPTY_FILTER };

const KEY = "osmm-view-state";

export function isRowStatus(value: unknown): value is RowStatus {
  return value === "idea" || (DELIVERY_STATUSES as readonly unknown[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function sanitizeViewState(raw: unknown): ViewState {
  if (!isRecord(raw)) return structuredClone(DEFAULT_VIEW_STATE);
  const f = isRecord(raw.filter) ? raw.filter : {};
  return {
    mode: (PLANNER_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as PlannerMode) : "month",
    filter: {
      platforms: strings(f.platforms).filter(isPlatform),
      channels: strings(f.channels),
      campaigns: strings(f.campaigns),
      statuses: strings(f.statuses).filter(isRowStatus),
    },
  };
}

export function viewStateStore(app: App): Writable<ViewState> {
  const store = writable(sanitizeViewState(app.loadLocalStorage(KEY)));
  store.subscribe((state) => app.saveLocalStorage(KEY, state));
  return store;
}

export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function activeFilterCount(f: PlannerFilter): number {
  return f.platforms.length + f.channels.length + f.campaigns.length + f.statuses.length;
}

/** Deleted channels and unknown groups expand to nothing, so a stale filter never hides everything. */
export function toRowFilter(f: PlannerFilter, registry: ChannelRegistry): RowFilter {
  return {
    platforms: f.platforms,
    channelIds: f.channels.length ? registry.expand(f.channels) : [],
    campaignPaths: f.campaigns,
    statuses: f.statuses,
  };
}
