import type { RowStatus } from "../index/queries";

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
