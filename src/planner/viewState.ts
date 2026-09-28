import type { App } from "obsidian";
import { writable, type Writable } from "svelte/store";
import type { RowStatus } from "../index/queries";
import type { Platform } from "../model/platforms";

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

/** Temporary implementation; Task 3 replaces it with one persisted via workspace local storage. */
export function viewStateStore(_app: App): Writable<ViewState> {
  return writable(structuredClone(DEFAULT_VIEW_STATE));
}
