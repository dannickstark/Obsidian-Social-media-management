import type { PostRow, RowStatus } from "../index/queries";
import type { Channel } from "../model/types";

export const STATUS_LABEL: Readonly<Record<RowStatus, string>> = {
  idea: "Idea",
  draft: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  handed_over: "Handed over",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  awaiting_you: "Waiting for you",
  skipped: "Skipped",
  overdue: "Overdue",
  check_needed: "Check needed",
};

export type ChipStyle = "published" | "auto" | "assisted" | "overdue" | "attention" | "draft";

export const FILTERABLE_STATUSES: readonly RowStatus[] = [
  "idea",
  "draft",
  "ready",
  "scheduled",
  "awaiting_you",
  "handed_over",
  "overdue",
  "failed",
  "published",
  "skipped",
];

export function chipStyle(row: PostRow, now: number, channel?: Channel): ChipStyle {
  switch (row.status) {
    case "published":
      return "published";
    case "failed":
    case "check_needed":
      return "attention";
    case "overdue":
      return "overdue";
    case "idea":
    case "draft":
    case "ready":
    case "skipped":
      return "draft";
  }
  if ((row.status === "scheduled" || row.status === "awaiting_you") && row.at !== undefined && row.at < now) return "overdue";
  const assisted = row.status === "awaiting_you" || row.variant.mode === "assisted" || channel?.method === "assisted";
  return assisted ? "assisted" : "auto";
}
