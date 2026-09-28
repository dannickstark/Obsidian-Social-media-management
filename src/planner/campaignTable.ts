import type { IndexedVariant } from "../index/socialIndex";
import { PLATFORMS, type Platform } from "../model/platforms";
import type { Channel, VariantStatus } from "../model/types";

export interface CampaignTableRow {
  variant: IndexedVariant;
  channels: Channel[];
  when?: number;
  chars: number;
  status: VariantStatus;
}

export function campaignTable(
  campaignPath: string,
  variants: readonly IndexedVariant[],
  channels: readonly Channel[],
): { rows: CampaignTableRow[]; missing: Platform[]; counts: { created: number; published: number; overdue: number } } {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const order = (p: Platform) => PLATFORMS.indexOf(p);
  const own = variants
    .filter((v) => v.campaignPath === campaignPath)
    .sort((a, b) => order(a.platform) - order(b.platform) || a.path.localeCompare(b.path));
  const rows = own.map((v) => ({
    variant: v,
    channels: v.channels.map((id) => byId.get(id)).filter((c): c is Channel => c !== undefined),
    when: v.scheduledAt,
    chars: v.bodyChars,
    status: v.status,
  }));
  const present = new Set(own.map((v) => v.platform));
  const configured = new Set(channels.map((c) => c.platform));
  const missing = PLATFORMS.filter((p) => configured.has(p) && !present.has(p));
  return {
    rows,
    missing,
    counts: {
      created: own.length,
      published: own.filter((v) => v.status === "published").length,
      overdue: own.filter((v) => v.status === "overdue").length,
    },
  };
}
