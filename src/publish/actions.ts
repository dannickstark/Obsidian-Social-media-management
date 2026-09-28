import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import { openMarkdownView } from "../composer/session";
import type { LoadedContent } from "../composer/content";
import type { SocialIndex } from "../index/socialIndex";
import type { Channel, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import type { AssistedTarget, ClipItem } from "../platforms/types";
import type { AdapterRegistry } from "../platforms/registry";
import { autoPostLateMs, type OsmmSettings } from "../settings/settings";
import { VIEW_SIDEBAR, type PlannerActions } from "../ui/actions";
import { SvelteModal } from "../ui/dialogs";
import type { OsmmContext } from "../ui/context";
import { activateView } from "../views/PlannerView";
import { assistedJob, assistedTarget } from "./assisted";
import { assistedQueue } from "./assistedFlow";
import AssistedFlow from "./AssistedFlow.svelte";
import { isMobile, type ClipboardService, type CopyResult } from "./clipboard";
import { effectiveDelivery } from "./eligibility";
import { validateLiveUrl } from "./liveUrl";
import type { AttemptLog } from "./log";
import { PublishOrchestrator, type FailureInfo, type PublishedInfo, type RunResult } from "./orchestrator";
import { toAwaiting, toPublished, toSkipped } from "./transitions";
import { transition } from "../model/stateMachine";
import { effectiveMethod } from "../platforms/registry";
import { GRACE_MS, type DueItem } from "../scheduler/due";

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
  secrets: { get(id: string): string | null; redact(text: string, ids: readonly string[]): string };
  /** Waits between API retries (a timer in the plugin; immediate in tests). */
  delay(ms: number): Promise<void>;
  settings(): OsmmSettings;
  now(): number;
}

/** Where the publish service reports deliveries that need the user (Task 9 plugs in desktop notifications). */
export interface DeliveryNotifier {
  due(path: string, channelId: string): void;
  failed(info: FailureInfo): void;
  /** An API publish went out (phone confirmations, #70). */
  published?(info: PublishedInfo): void;
}

const SILENT: DeliveryNotifier = { due: () => undefined, failed: () => undefined };

export type MarkResult = { ok: true } | { ok: false; reason: string };

/** Side effects of publishing (assisted flow, scheduler dispatch, overdue tray). Every write is per key, on fresh frontmatter. */
export class PublishActions {
  /** Set by the plugin so actions can open Svelte modals with the same context. */
  context: OsmmContext | null = null;

  readonly orchestrator: PublishOrchestrator;
  notifier: DeliveryNotifier = SILENT;

  constructor(protected readonly deps: PublishDeps) {
    this.orchestrator = new PublishOrchestrator({
      writer: deps.writer,
      index: deps.index,
      channels: deps.channels,
      adapters: deps.adapters,
      secrets: deps.secrets,
      content: deps.composer.content,
      log: deps.log,
      now: () => deps.now(),
      delay: (ms) => deps.delay(ms),
      onFailure: (info) => this.notifier.failed(info),
      onPublished: (info) => this.notifier.published?.(info),
      lateWindowMs: () => Math.max(GRACE_MS, autoPostLateMs(deps.settings()) ?? 0),
      defaultStaggerMinutes: () => deps.settings().defaultStaggerMinutes,
    });
  }

  /** Runs one API delivery and reports the outcome (failures are reported by the notifier). */
  async runApi(path: string, channelId: string): Promise<RunResult> {
    const result = await this.orchestrator.run(path, channelId);
    const name = this.channelName(channelId);
    if (result.status === "published") new Notice(`Published to ${name}.`);
    else if (result.status === "refused") new Notice(`${name}: ${result.reason}`);
    return result;
  }

  /** Final review Minor 5: an API run started without awaiting it still reports a rejection. */
  private runApiInBackground(path: string, channelId: string): void {
    this.runApi(path, channelId).catch((e: unknown) => new Notice(`${this.channelName(channelId)}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** This device's own API run has the delivery in `publishing` right now: it is live, not stuck. */
  isInFlight(path: string, channelId: string): boolean {
    return this.orchestrator.isInFlight(path, channelId);
  }

  /** Whether "Check again" can ask the platform: the note's adapter has a lookup(). */
  canLookup(path: string): boolean {
    const v = this.deps.index.getVariant(path);
    return !!v && !!this.deps.adapters.get(v.platform)?.lookup;
  }

  protected channelName(channelId: string): string {
    return this.deps.channels.get(channelId)?.name ?? channelId;
  }

  /** The user starts the assisted flow: the delivery now waits for them. */
  async startAssisted(path: string, channelId: string): Promise<boolean> {
    return (await this.claimAssisted(path, channelId)) === null;
  }

  /**
   * The claim behind `startAssisted`, on fresh frontmatter: null when the delivery now waits for the user,
   * otherwise why it can't be posted (published, skipped, publishing, check needed, handed over, unreadable).
   */
  private async claimAssisted(path: string, channelId: string): Promise<string | null> {
    const v = this.deps.index.getVariant(path);
    const name = this.channelName(channelId);
    if (!v) return "That note is no longer available.";
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = effectiveDelivery(fresh, channelId);
      const next = d && d.status !== "skipped" ? toAwaiting(d) : null;
      if (!d || !next) return { refuse: `${name} can't be posted now${d ? ` (it is ${d.status.replace(/_/g, " ")})` : ""}.` };
      return next === d ? {} : { deliveries: { [channelId]: next } };
    });
    if ("refuse" in result) return result.refuse;
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "awaiting_you" });
    return null;
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

  /** Scheduler: a delivery's time has come. */
  async dispatch(item: DueItem): Promise<void> {
    const v = this.deps.index.getVariant(item.path);
    if (!v) return;
    const adapter = this.deps.adapters.get(v.platform);
    let method = effectiveMethod(v.mode, this.deps.channels.get(item.channelId), adapter);
    // Native channels are handed over when scheduled (M5). One still pending at its time is posted now, never skipped silently.
    if (method === "native") method = adapter?.publish ? "api" : "assisted";
    if (method === "api") {
      this.runApiInBackground(item.path, item.channelId);
      return;
    }
    if (await this.startAssisted(item.path, item.channelId)) this.notifier.due(item.path, item.channelId);
  }

  /** Scheduler: the time passed too long ago (spec §5.2); the delivery waits in the Overdue tray. */
  async markOverdue(item: DueItem): Promise<void> {
    const v = this.deps.index.getVariant(item.path);
    if (!v) return;
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = effectiveDelivery(fresh, item.channelId);
      if (d?.status !== "scheduled") return { refuse: "The delivery changed." };
      return { deliveries: { [item.channelId]: transition(d, "overdue") } };
    });
    if (!("refuse" in result)) void this.deps.log.append({ at: this.deps.now(), path: item.path, channelId: item.channelId, result: "overdue" });
  }

  /**
   * Startup: Obsidian closed mid-publish. The delivery is never retried automatically (spec §5.1).
   * A publish this device still has in flight is not stuck: it is left to its own run.
   */
  async markCheckNeeded(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v || this.isInFlight(path, channelId)) return false;
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "publishing" || this.isInFlight(path, channelId)) return { refuse: "The delivery changed." };
      const error = "Obsidian closed while this was being published. Check the platform, then mark it as published or not.";
      return { deliveries: { [channelId]: transition(d, "check_needed", { error }) } };
    });
    if ("refuse" in result) return false;
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "check_needed" });
    return true;
  }

  /** Resolves a check-needed delivery with the adapter's lookup(); leaves it to the user when that can't tell. */
  async resolveCheck(path: string, channelId: string): Promise<void> {
    const state = await this.orchestrator.lookup(path, channelId);
    const v = this.deps.index.getVariant(path);
    if (!state || !v) return;
    const at = this.deps.now();
    const error = "Not found on the platform after an interrupted publish.";
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "check_needed") return { refuse: "The delivery changed." };
      if (!state.published) return { deliveries: { [channelId]: transition(d, "failed", { error }) } };
      const next = transition(d, "published", { at, ...(state.url ? { url: state.url } : {}), ...(state.remoteId ? { remoteId: state.remoteId } : {}) });
      delete next.error;
      return { deliveries: { [channelId]: next } };
    });
    if ("refuse" in result) return;
    void this.deps.log.append(
      state.published ? { at, path, channelId, result: "published", ...(state.url ? { url: state.url } : {}) } : { at, path, channelId, result: "failed", error },
    );
    // M3 P8: a lookup that confirms the publish counts as an API publish for the phone confirmation.
    if (state.published) this.notifier.published?.({ path, channelId, ...(state.url ? { url: state.url } : {}) });
  }

  target(v: Variant, channel: Channel, content: LoadedContent): AssistedTarget {
    return assistedTarget(assistedJob(v, channel, content));
  }

  /** Text to the clipboard; images to the clipboard on desktop and to the share sheet on phones. */
  async copyItem(item: ClipItem): Promise<CopyResult> {
    if ("imagePath" in item && isMobile()) return (await this.deps.clipboard.share("", [item.imagePath])) ? "copied" : "failed";
    return this.deps.clipboard.copy(item);
  }

  /**
   * Ruling P3: before copying, opening or posting, flush an open editor for `path` to disk so what's
   * loaded next is the exact text on screen (the composer itself already tracks the live session body).
   */
  private async freshContent(path: string): Promise<{ v: Variant; content: LoadedContent } | null> {
    const v = this.deps.index.getVariant(path);
    if (!v) return null;
    const editor = openMarkdownView(this.deps.app, path);
    if (editor) await editor.save();
    const content = await this.deps.composer.content.load(v);
    return { v, content };
  }

  /**
   * Ruling P3: on top of `freshContent`'s flush, re-validates the exact text about to be sent and refuses
   * (Notice with the blocking issues) instead of copying, opening or posting. Shared by `freshTarget`
   * (Copy & open) and `postNow` (every entry point: composer, Overdue tray, Needs attention, banner) so
   * neither duplicates the check.
   */
  private async freshValidated(path: string): Promise<{ v: Variant; content: LoadedContent } | null> {
    const fresh = await this.freshContent(path);
    if (!fresh) return null;
    const issues = this.deps.composer.check(fresh.v, fresh.content).filter((i) => i.level === "error");
    if (issues.length) {
      new Notice(issues.map((i) => i.message).join(" "));
      return null;
    }
    return fresh;
  }

  /**
   * The assisted target built from the flushed, re-validated text (ruling P3). The assisted modal uses it
   * for every clipboard item after the first, so a reply or image never comes from the text loaded at mount.
   */
  async freshTarget(path: string, channelId: string): Promise<AssistedTarget | null> {
    const channel = this.deps.channels.get(channelId);
    if (!channel || !this.deps.index.getVariant(path)) {
      new Notice("That note or channel is no longer available.");
      return null;
    }
    const fresh = await this.freshValidated(path);
    if (!fresh) return null;
    return this.target(fresh.v, channel, fresh.content);
  }

  /**
   * Step 2: mark the delivery as waiting for the user, then copy the first clipboard item and open the
   * pre-filled page. The claim runs first, on fresh frontmatter: a delivery that is no longer postable
   * (published or skipped meanwhile, e.g. from a second flow, publishing, check needed, handed over) is
   * refused with a Notice and nothing is copied or opened. Returns the fresh target (after the P3
   * flush/re-validate) and what was actually copied from it; null when refused.
   */
  async openTarget(path: string, channelId: string): Promise<{ target: AssistedTarget; copied: { result: CopyResult; label: string } | null } | null> {
    const fresh = await this.freshTarget(path, channelId);
    if (!fresh) return null;
    const refused = await this.claimAssisted(path, channelId);
    if (refused) {
      new Notice(refused);
      return null;
    }
    const first = fresh.clipboard[0];
    const result = first ? await this.copyItem(first) : null;
    const url = isMobile() && fresh.mobileUrl ? fresh.mobileUrl : fresh.url;
    if (url) window.open(url);
    return { target: fresh, copied: first && result ? { result, label: first.label } : null };
  }

  /**
   * Post now (Overdue tray, Needs attention, composer, context menu): API channels run at once, the rest
   * opens the assisted flow. Ruling P3: flushes an open editor for `path` and re-validates the exact text
   * about to be sent first, from every entry point — refuses (Notice with the blocking issues) instead of
   * sending anything, whether by API or the assisted flow.
   */
  async postNow(path: string, channelIds?: readonly string[]): Promise<void> {
    const fresh = await this.freshValidated(path);
    if (!fresh) return;
    const { v } = fresh;
    const queue = assistedQueue(v, this.deps.settings().defaultStaggerMinutes, channelIds);
    if (!queue.length) {
      new Notice("Nothing left to post for this note.");
      return;
    }
    const adapter = this.deps.adapters.get(v.platform);
    const viaApi = queue.filter((id) => {
      const method = effectiveMethod(v.mode, this.deps.channels.get(id), adapter);
      return method === "api" || (method === "native" && !!adapter?.publish);
    });
    for (const id of viaApi) this.runApiInBackground(path, id);
    const assisted = queue.filter((id) => !viaApi.includes(id));
    if (assisted.length) this.openAssisted(path, assisted);
  }

  /** The user checked the platform: the interrupted publish did not go out. */
  async resolveNotPublished(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const name = this.channelName(channelId);
    const error = "Not published (checked by you).";
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "check_needed") return { refuse: `${name} no longer needs a check.` };
      return { deliveries: { [channelId]: transition(d, "failed", { error }) } };
    });
    if (!result.ok) {
      new Notice(result.reason);
      return false;
    }
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "failed", error });
    this.deps.planner.undoNotice(`Marked ${name} as not published.`, () => this.deps.planner.undo([result.record]));
    return true;
  }

  /** The startup banner (artboard 6). */
  overdueBanner(count: number): void {
    if (count === 0) return;
    this.deps.planner.actionNotice(`${count} post${count === 1 ? " is" : "s are"} overdue.`, "Review", () => activateView(this.deps.app, VIEW_SIDEBAR, "right"));
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
