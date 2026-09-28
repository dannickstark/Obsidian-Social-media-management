import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { get, writable } from "svelte/store";
import { isRecord } from "../model/frontmatter";
import { VIEW_PREVIEW_GRID } from "../ui/actions";
import { osmmContext, type OsmmContext } from "../ui/context";
import { mountSvelte, type Mounted } from "../ui/mount";
import PreviewGrid from "./PreviewGrid.svelte";

/** All-platform preview (artboard 5). View state: `{ campaignPath }`. */
export class PreviewGridView extends ItemView {
  private mounted: Mounted | null = null;
  private readonly campaign = writable<string | null>(null);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_PREVIEW_GRID;
  }

  getDisplayText(): string {
    return "All-platform preview";
  }

  override getIcon(): string {
    return "layout-grid";
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isRecord(state) && typeof state.campaignPath === "string") this.campaign.set(state.campaignPath);
    await super.setState(state, result);
  }

  override getState(): Record<string, unknown> {
    return { campaignPath: get(this.campaign) };
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(this.contentEl, PreviewGrid, { campaign: this.campaign }, osmmContext(this.ctx));
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
