import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { get } from "svelte/store";
import { isRecord } from "../model/frontmatter";
import { VIEW_COMPOSER } from "../ui/actions";
import { osmmContext, type OsmmContext } from "../ui/context";
import { mountSvelte, type Mounted } from "../ui/mount";
import Composer from "./Composer.svelte";
import type { ComposerSession } from "./session";

/** Composer (artboard 3), opened in a split next to Obsidian's own editor. View state: `{ path }`. */
export class ComposerView extends ItemView {
  private mounted: Mounted | null = null;
  private session: ComposerSession | null = null;
  /** The Markdown leaf the composer sits next to; platform tabs open sibling notes there. */
  editorLeaf: WorkspaceLeaf | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_COMPOSER;
  }

  getDisplayText(): string {
    return "Composer";
  }

  override getIcon(): string {
    return "pencil-line";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.session = this.ctx.composer.session();
    this.mounted = mountSvelte(
      this.contentEl,
      Composer,
      { session: this.session, openVariant: (path: string) => void this.showVariant(path) },
      osmmContext(this.ctx),
    );
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isRecord(state) && typeof state.path === "string") this.session?.path.set(state.path);
    await super.setState(state, result);
  }

  override getState(): Record<string, unknown> {
    return { path: this.session ? get(this.session.path) : null };
  }

  async showVariant(path: string): Promise<void> {
    this.session?.path.set(path);
    const file = this.app.vault.getFileByPath(path);
    if (file && this.editorLeaf) await this.editorLeaf.openFile(file);
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
    this.session?.dispose();
    this.session = null;
  }
}
