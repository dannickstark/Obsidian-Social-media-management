import { MarkdownView, Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { LoadedContent } from "../composer/content";
import type { SocialIndex } from "../index/socialIndex";
import type { Channel, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import type { AssistedTarget, ClipItem } from "../platforms/types";
import type { AdapterRegistry } from "../platforms/registry";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "../ui/actions";
import { SvelteModal } from "../ui/dialogs";
import type { OsmmContext } from "../ui/context";
import { assistedJob, assistedTarget } from "./assisted";
import { assistedQueue } from "./assistedFlow";
import AssistedFlow from "./AssistedFlow.svelte";
import { isMobile, type ClipboardService, type CopyResult } from "./clipboard";
import { effectiveDelivery } from "./eligibility";
import { validateLiveUrl } from "./liveUrl";
import type { AttemptLog } from "./log";
import { toAwaiting, toPublished, toSkipped } from "./transitions";

export interface PublishDeps {
  app: App;
  writer: SafeWriter;
  index: SocialIndex;
  channels: ChannelRegistry;
  planner: PlannerActions;
  composer: ComposerActions;
  adapters: AdapterRegistry;
  clipboard: ClipboardService;
  log: AttemptLog;
  settings(): OsmmSettings;
  now(): number;
}

export type MarkResult = { ok: true } | { ok: false; reason: string };

/** Side effects of publishing (assisted flow, scheduler dispatch, overdue tray). Every write is per key, on fresh frontmatter. */
export class PublishActions {
  /** Set by the plugin so actions can open Svelte modals with the same context. */
  context: OsmmContext | null = null;

  constructor(protected readonly deps: PublishDeps) {}

  protected channelName(channelId: string): string {
    return this.deps.channels.get(channelId)?.name ?? channelId;
  }

  /** The user starts the assisted flow: the delivery now waits for them. */
  async startAssisted(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = effectiveDelivery(fresh, channelId);
      const next = d ? toAwaiting(d) : null;
      if (!d || !next) return { refuse: `${this.channelName(channelId)} can't be posted now.` };
      return next === d ? {} : { deliveries: { [channelId]: next } };
    });
    if ("refuse" in result) return false;
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "awaiting_you" });
    return true;
  }

  /** Close the loop of an assisted post: published, with the live URL when there is one. */
  async markPublished(path: string, channelId: string, rawUrl = ""): Promise<MarkResult> {
    const v = this.deps.index.getVariant(path);
    if (!v) return { ok: false, reason: "The note is gone." };
    const name = this.channelName(channelId);
    let url: string | undefined;
    if (rawUrl.trim()) {
      const check = validateLiveUrl(v.platform, rawUrl, this.deps.channels.get(channelId));
      if (!check.ok) return check;
      url = check.url;
    }
    const at = this.deps.now();
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = effectiveDelivery(fresh, channelId);
      if (!d) return { refuse: `${name} can't be marked as published: fix its delivery status in the note first.` };
      if (d.status === "published") return { refuse: `${name} is already marked as published.` };
      const next = toPublished(d, url ? { at, url } : { at });
      if (!next) return { refuse: `${name} is being published right now.` };
      delete next.error;
      return { deliveries: { [channelId]: next } };
    });
    if (!result.ok) return result;
    void this.deps.log.append({ at, path, channelId, result: "published", ...(url ? { url } : {}) });
    this.deps.planner.undoNotice(`Marked ${name} as published.`, () => this.deps.planner.undo([result.record]));
    return { ok: true };
  }

  async skip(path: string, channelId: string, reason = ""): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const name = this.channelName(channelId);
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = effectiveDelivery(fresh, channelId);
      const next = d ? toSkipped(d, reason.trim() || undefined) : null;
      if (!next) return { refuse: `${name} can't be skipped now.` };
      return { deliveries: { [channelId]: next } };
    });
    if (!result.ok) {
      new Notice(result.reason);
      return false;
    }
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "skipped" });
    this.deps.planner.undoNotice(`Skipped ${name}.`, () => this.deps.planner.undo([result.record]));
    return true;
  }

  target(v: Variant, channel: Channel, content: LoadedContent): AssistedTarget {
    return assistedTarget(assistedJob(v, channel, content));
  }

  /** Text to the clipboard; images to the clipboard on desktop and to the share sheet on phones. */
  async copyItem(item: ClipItem): Promise<CopyResult> {
    if ("imagePath" in item && isMobile()) return (await this.deps.clipboard.share("", [item.imagePath])) ? "copied" : "failed";
    return this.deps.clipboard.copy(item);
  }

  /** An open editor for `path`, if any: its buffer can be newer than the file on disk. */
  private openEditorFor(path: string): MarkdownView | null {
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return view;
    }
    return null;
  }

  /**
   * Ruling P3: before copying or opening, flush an open editor for `path` to disk and re-validate the
   * exact text about to be sent. Refuses (Notice with the blocking issues) instead of copying/opening.
   */
  private async freshTarget(path: string, channelId: string): Promise<AssistedTarget | null> {
    const v = this.deps.index.getVariant(path);
    const channel = this.deps.channels.get(channelId);
    if (!v || !channel) {
      new Notice("That note or channel is no longer available.");
      return null;
    }
    const editor = this.openEditorFor(path);
    if (editor) await editor.save();
    const content = await this.deps.composer.content.load(v);
    const issues = this.deps.composer.check(v, content).filter((i) => i.level === "error");
    if (issues.length) {
      new Notice(issues.map((i) => i.message).join(" "));
      return null;
    }
    return this.target(v, channel, content);
  }

  /**
   * Step 2: copy the first clipboard item, open the pre-filled page and mark the delivery as waiting for the
   * user. Returns what was actually copied (the fresh item, after the P3 flush/re-validate), not the caller's
   * possibly-stale guess — null when nothing was copied (refused, or no clipboard item to copy).
   */
  async openTarget(path: string, channelId: string): Promise<{ result: CopyResult; label: string } | null> {
    const fresh = await this.freshTarget(path, channelId);
    if (!fresh) return null;
    const first = fresh.clipboard[0];
    const result = first ? await this.copyItem(first) : null;
    const url = isMobile() && fresh.mobileUrl ? fresh.mobileUrl : fresh.url;
    if (url) window.open(url);
    await this.startAssisted(path, channelId);
    return first && result ? { result, label: first.label } : null;
  }

  /** The 3-step assisted flow (artboard 6) over the channels still to post, in stagger order. */
  openAssisted(path: string, channelIds?: readonly string[], startStep: 1 | 3 = 1): boolean {
    const v = this.deps.index.getVariant(path);
    if (!v || !this.context) return false;
    const queue = startStep === 3 ? [...(channelIds ?? [])] : assistedQueue(v, this.deps.settings().defaultStaggerMinutes, channelIds);
    if (!queue.length) {
      new Notice("Nothing left to post for this note.");
      return false;
    }
    new SvelteModal(this.deps.app, "Post", AssistedFlow, { path, channelIds: queue, startStep }, this.context).open();
    return true;
  }
}
