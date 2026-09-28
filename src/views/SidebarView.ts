import { VIEW_SIDEBAR } from "../ui/actions";
import { SvelteItemView } from "../ui/SvelteView";
import Sidebar from "./Sidebar.svelte";

export class SidebarView extends SvelteItemView {
  getViewType(): string {
    return VIEW_SIDEBAR;
  }
  getDisplayText(): string {
    return "Social queue";
  }
  override getIcon(): string {
    return "list-todo";
  }
  protected component() {
    return Sidebar;
  }
  protected props() {
    return {};
  }
}
