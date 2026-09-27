import { readable, type Readable } from "svelte/store";
import type { IndexedCampaign, IndexedVariant, SocialIndex } from "./socialIndex";

export interface IndexSnapshot {
  revision: number;
  campaigns: IndexedCampaign[];
  variants: IndexedVariant[];
}

export function indexStore(index: SocialIndex): Readable<IndexSnapshot> {
  const snapshot = (): IndexSnapshot => ({
    revision: index.revision,
    campaigns: index.campaigns(),
    variants: index.variants(),
  });
  return readable(snapshot(), (set) => index.onChange(() => set(snapshot())));
}
