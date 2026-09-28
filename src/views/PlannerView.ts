import type { App } from "obsidian";
import { VIEW_PLANNER } from "../ui/actions";
import { SvelteItemView } from "../ui/SvelteView";
import Planner from "./Planner.svelte";

export class PlannerView extends SvelteItemView {
  getViewType(): string {
    return VIEW_PLANNER;
  }
  getDisplayText(): string {
    return "Social planner";
  }
  override getIcon(): string {
    return "calendar-days";
  }
  protected component() {
    return Planner;
  }
  protected props() {
    return {};
  }
}

/** Reveal an existing view of `type`, or open one in a new tab / the right sidebar. */
export async function activateView(app: App, type: string, where: "tab" | "right"): Promise<void> {
  const existing = app.workspace.getLeavesOfType(type)[0];
  const leaf = existing ?? (where === "right" ? app.workspace.getRightLeaf(false) : app.workspace.getLeaf("tab"));
  if (!leaf) return;
  if (!existing) await leaf.setViewState({ type, active: true });
  await app.workspace.revealLeaf(leaf);
}
