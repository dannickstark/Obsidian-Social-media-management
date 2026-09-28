import { expandRows, type PostRow, type RowStatus } from "../index/queries";
import type { IndexedVariant } from "../index/socialIndex";
import { PLATFORM_META } from "../model/platforms";

export type SortKey = "at" | "platform" | "channel" | "campaign" | "status" | "title";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortRows(
  rows: readonly PostRow[],
  key: SortKey,
  dir: "asc" | "desc",
  campaignTitle: (path: string | undefined) => string = (p) => p ?? "",
): PostRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const text = (r: PostRow): string => {
    switch (key) {
      case "platform":
        return PLATFORM_META[r.variant.platform].label;
      case "channel":
        return r.channelId ?? "";
      case "campaign":
        return campaignTitle(r.variant.campaignPath);
      case "status":
        return r.status;
      default:
        return r.variant.displayTitle;
    }
  };
  return [...rows].sort((a, b) => {
    if (key === "at") {
      if (a.at === undefined && b.at === undefined) return 0;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return sign * (a.at - b.at);
    }
    return sign * collator.compare(text(a), text(b));
  });
}

export function uniqueVariants(rows: readonly PostRow[]): IndexedVariant[] {
  const seen = new Map<string, IndexedVariant>();
  for (const r of rows) if (!seen.has(r.variant.path)) seen.set(r.variant.path, r.variant);
  return [...seen.values()];
}

const FROZEN_FOR_MOVE = new Set<RowStatus>(["published", "publishing", "handed_over", "skipped"]);
const EDITABLE = new Set<RowStatus>(["idea", "draft", "ready"]);

/**
 * One rule for bulk moves, judged on row statuses (so a stored `status: published` without delivery
 * records counts): frozen when any row is published, publishing, handed over or skipped.
 */
export function frozenForMove(v: IndexedVariant, defaultStagger: number): boolean {
  return expandRows([v], defaultStagger).some((r) => FROZEN_FOR_MOVE.has(r.status));
}

/** A bulk status change applies only when every row is still idea, draft or ready. */
export function statusEditable(v: IndexedVariant, defaultStagger: number): boolean {
  return expandRows([v], defaultStagger).every((r) => EDITABLE.has(r.status));
}
