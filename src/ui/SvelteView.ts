import { ItemView, MarkdownRenderChild, type WorkspaceLeaf } from "obsidian";
import type { Component } from "svelte";
import { mountSvelte, type Mounted } from "./mount";
import { osmmContext, type OsmmContext } from "./context";

export abstract class SvelteItemView<P extends Record<string, unknown> = Record<string, never>> extends ItemView {
  private mounted: Mounted | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    protected readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  protected abstract component(): Component<P>;
  protected abstract props(): P;

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(this.contentEl, this.component(), this.props(), osmmContext(this.ctx));
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
  }
}

/** Mounts a Svelte component inside rendered Markdown (code-block processors). */
export class SvelteRenderChild<P extends Record<string, unknown>> extends MarkdownRenderChild {
  private mounted: Mounted | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly component: Component<P>,
    private readonly props: P,
    private readonly ctx: OsmmContext,
  ) {
    super(containerEl);
  }

  override onload(): void {
    this.containerEl.addClass("osmm");
    this.mounted = mountSvelte(this.containerEl, this.component, this.props, osmmContext(this.ctx));
  }

  override onunload(): void {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
