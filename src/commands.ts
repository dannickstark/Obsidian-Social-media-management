import type OsmmPlugin from "./main";
import { VIEW_PLANNER, VIEW_SIDEBAR } from "./ui/actions";
import { activateView } from "./views/PlannerView";

export function registerCommands(plugin: OsmmPlugin): void {
  const { app } = plugin;
  const openPlanner = () => void activateView(app, VIEW_PLANNER, "tab");

  plugin.addRibbonIcon("calendar-days", "Open social planner", openPlanner);
  plugin.addCommand({ id: "open-planner", name: "Open planner", callback: openPlanner });
  plugin.addCommand({
    id: "open-board",
    name: "Open pipeline board",
    callback: () => {
      plugin.uiContext().viewState.update((s) => ({ ...s, mode: "board" }));
      openPlanner();
    },
  });
  plugin.addCommand({ id: "open-sidebar", name: "Open social queue (sidebar)", callback: () => void activateView(app, VIEW_SIDEBAR, "right") });
  plugin.addCommand({ id: "new-campaign", name: "New campaign", callback: () => plugin.uiContext().actions.quickCreate("campaign") });
  plugin.addCommand({ id: "new-post", name: "New post", callback: () => plugin.uiContext().actions.quickCreate("post") });
  plugin.addCommand({
    id: "new-variant-for-campaign",
    name: "New platform variant for this campaign",
    checkCallback: (checking) => plugin.uiContext().actions.newVariantForActiveCampaign(checking),
  });
  plugin.addCommand({
    id: "preview-campaign",
    name: "Preview all variants of this campaign",
    checkCallback: (checking) => plugin.uiContext().composer.previewActiveCampaign(checking),
  });
  plugin.addCommand({
    id: "open-composer",
    name: "Open composer for this post",
    checkCallback: (checking) => plugin.uiContext().composer.composeActiveNote(checking),
  });
}
