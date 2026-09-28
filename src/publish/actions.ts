import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import { openMarkdownView } from "../composer/session";
import type { LoadedContent } from "../composer/content";
import type { SocialIndex } from "../index/socialIndex";
import { PLATFORM_META } from "../model/platforms";
import type { Channel, Issue, Variant } from "../model/types";
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
import { effectiveDelivery, unreadable } from "./eligibility";
import { validateLiveUrl } from "./liveUrl";
import type { AttemptLog } from "./log";
import { PublishOrchestrator, type FailureInfo, type PublishedInfo, type RunResult } from "./orchestrator";
import { toAwaiting, toPublished, toSkipped } from "./transitions";
import { transition } from "../model/stateMachine";
import { effectiveMethod, platformDef } from "../platforms/registry";
import { postItems, postText } from "../platforms/text";
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
  /** This device holds the publisher role: a scheduled run stops retrying once it is lost (final review 4). */
  isPublisher?(): boolean;
}

/** Where the publish service reports deliveries that need the user (Task 9 plugs in desktop notifications). */
export interface DeliveryNotifier {
  due(path: string, channelId: string): void;
  failed(info: FailureInfo): void;
  /** An API publish went out (phone confirmations, #70). */
  published?(info: PublishedInfo): void;
}

/** What a send would post; an approved plan is only sent while this is unchanged (P3 for approvals). */
export function sendDigest(v: Variant, content: LoadedContent): string {
  return JSON.stringify([v.platform, v.title ?? "", v.url ?? "", content.body, v.media, v.mediaMeta ?? {}, v.wordpress ?? null]);
}

export interface SendPlan {
  path: string;
  queue: string[];
  api: string[];
  assisted: string[];
  /** The text as the platform receives it, for the approval dialog. */
  text: string;
  digest: string;
}

export interface UpdatePlan {
  path: string;
  channels: string[];
  text: string;
  digest: string;
}

export type SendRefusal = { refuse: string; issues?: Issue[] };

const GONE = "That note is no longer available.";
const BLOCKING = "The post has blocking issues, so nothing was sent.";
const CHANGED = "The post changed after it was approved, so nothing was sent. Ask again with the new text.";
const NOTHING = "Nothing left to post for this note.";
const HELD =
  "Claude wrote this note while Obsidian was closed. The user approves it first in Obsidian (sidebar, Written by Claude); after that, schedule or publish it.";
const LIVE = new Set(["published", "handed_over"]);

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
      ...(deps.isPublisher ? { isPublisher: () => deps.isPublisher!() } : {}),
    });
  }

  /** Runs one API delivery and reports the outcome (failures are reported by the notifier). */
  async runApi(path: string, channelId: string, accept?: (v: Variant, content: LoadedContent) => boolean): Promise<RunResult> {
    const result = await this.orchestrator.run(path, channelId, accept);
    const name = this.channelName(channelId);
    if (result.status === "published") new Notice(`Published to ${name}.`);
    else if (result.status === "refused") new Notice(`${name}: ${result.reason}`);
    return result;
  }

  /** Final review Minor 5: an API run started without awaiting it still reports a rejection. */
  private runApiInBackground(path: string, channelId: string, accept?: (v: Variant, content: LoadedContent) => boolean): void {
    this.runApi(path, channelId, accept).catch((e: unknown) => new Notice(`${this.channelName(channelId)}: ${e instanceof Error ? e.message : String(e)}`));
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
    if (!state.published) return;
    try {
      this.notifier.published?.({ path, channelId, ...(state.url ? { url: state.url } : {}) });
    } catch {
      // The post is out and recorded; a failed confirmation must not turn the check into an error.
    }
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
      new Notice(NOTHING);
      return;
    }
    const { api, assisted } = this.split(v, queue);
    for (const id of api) this.runApiInBackground(path, id);
    if (assisted.length) this.openAssisted(path, assisted);
  }

  /** Which queued channels run through their API now, and which open the assisted flow. */
  private split(v: Variant, queue: readonly string[]): { api: string[]; assisted: string[] } {
    const adapter = this.deps.adapters.get(v.platform);
    const api = queue.filter((id) => {
      const method = effectiveMethod(v.mode, this.deps.channels.get(id), adapter);
      return method === "api" || (method === "native" && !!adapter?.publish);
    });
    return { api, assisted: queue.filter((id) => !api.includes(id)) };
  }

  /**
   * Why API sends are refused on this device (spec §4.3: only the publisher dispatches), or null.
   * Ruling P2: fails closed when there is no way to tell (no `isPublisher` and no publisher service).
   */
  apiBlockedReason(): string | null {
    const publisher = this.context?.publisher;
    const isPublisher = this.deps.isPublisher ? this.deps.isPublisher() : (publisher?.isPublisher() ?? false);
    if (isPublisher) return null;
    const state = publisher?.state();
    return state?.kind === "other"
      ? `Posts go out through the API only from the publisher device (${state.name}). Ask the user to publish from there.`
      : "No device publishes through the API yet. The user can choose a publisher device in Obsidian's settings.";
  }

  /**
   * Ruling P6: a note Claude wrote while Obsidian was closed (`review: claude`) waits for the user's review.
   * Read from the note's frontmatter until the variant model parses `review` (Task 10).
   */
  private heldForReview(path: string): boolean {
    const file = this.deps.index.getVariant(path)?.file;
    const fm: unknown = file ? this.deps.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    return typeof fm === "object" && fm !== null && (fm as Record<string, unknown>).review === "claude";
  }

  /** Flush, then re-validate the exact text (M2b P3); a refusal when it's gone or has blocking issues. */
  private async freshChecked(path: string): Promise<{ v: Variant; content: LoadedContent } | SendRefusal> {
    const fresh = await this.freshContent(path);
    if (!fresh) return { refuse: GONE };
    if (this.heldForReview(path)) return { refuse: HELD };
    const errors = this.deps.composer.check(fresh.v, fresh.content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    return fresh;
  }

  /** MCP publish_now, before asking (#77): flush, re-validate the exact text, and fix what would be sent. */
  async prepareSend(path: string, channelIds?: readonly string[]): Promise<SendPlan | SendRefusal> {
    const fresh = await this.freshChecked(path);
    if ("refuse" in fresh) return fresh;
    const queue = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, channelIds);
    if (!queue.length) return { refuse: NOTHING };
    const { api, assisted } = this.split(fresh.v, queue);
    return { path, queue, api, assisted, text: postText(fresh.content.body, platformDef(fresh.v.platform)), digest: sendDigest(fresh.v, fresh.content) };
  }

  /**
   * After approval: flush and re-validate again, and send only what was approved (M2b P3). Ruling P3: a
   * channel that would now go through the API but was approved for the assisted flow refuses the whole send.
   * Each API run re-checks the digest against the exact text it loads and sends.
   */
  async sendApproved(plan: SendPlan): Promise<{ started: string[]; opened: string[] } | SendRefusal> {
    const fresh = await this.freshChecked(plan.path);
    if ("refuse" in fresh) return fresh;
    if (sendDigest(fresh.v, fresh.content) !== plan.digest) return { refuse: CHANGED };
    const queue = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, plan.queue);
    if (!queue.length) return { refuse: NOTHING };
    const { api, assisted } = this.split(fresh.v, queue);
    if (api.some((id) => !plan.api.includes(id))) return { refuse: CHANGED };
    const blocked = api.length ? this.apiBlockedReason() : null;
    if (blocked) return { refuse: blocked };
    const accept = (v: Variant, content: LoadedContent) => sendDigest(v, content) === plan.digest;
    for (const id of api) this.runApiInBackground(plan.path, id, accept);
    const opened = assisted.length && this.openAssisted(plan.path, assisted) ? assisted : [];
    if (!api.length && !opened.length) return { refuse: "Obsidian could not open the assisted flow, so nothing was sent." };
    return { started: api, opened };
  }

  /** MCP push_update, before asking: channels live on the platform with a known id, whose adapter can update them (spec §5.5). */
  async prepareUpdate(path: string, channelIds?: readonly string[]): Promise<UpdatePlan | SendRefusal> {
    const fresh = await this.freshChecked(path);
    if ("refuse" in fresh) return fresh;
    const { v, content } = fresh;
    const channels = v.channels.filter((id) => (!channelIds || channelIds.includes(id)) && !unreadable(v, id) && LIVE.has(v.deliveries[id]?.status ?? "") && !!v.deliveries[id]?.remoteId);
    if (!channels.length) return { refuse: "No channel of this post is live on the platform with a known id." };
    if (!this.deps.adapters.get(v.platform)?.update) return { refuse: `${PLATFORM_META[v.platform].label} posts can't be updated from Obsidian yet.` };
    return { path, channels, text: postText(content.body, platformDef(v.platform)), digest: sendDigest(v, content) };
  }

  /** After approval: re-validates and compares with what was approved, then updates each live channel. Ruling P7: a failure logs `update_failed`. */
  async updateApproved(plan: UpdatePlan): Promise<{ updated: string[]; failed: Array<{ id: string; error: string }> } | SendRefusal> {
    const fresh = await this.freshChecked(plan.path);
    if ("refuse" in fresh) return fresh;
    const { v, content } = fresh;
    if (sendDigest(v, content) !== plan.digest) return { refuse: CHANGED };
    const blocked = this.apiBlockedReason();
    if (blocked) return { refuse: blocked };
    const adapter = this.deps.adapters.get(v.platform);
    if (!adapter?.update) return { refuse: `${PLATFORM_META[v.platform].label} posts can't be updated from Obsidian yet.` };
    const def = platformDef(v.platform);
    const items = postItems(content.body, def);
    const updated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of plan.channels) {
      const d = v.deliveries[id];
      const channel = this.deps.channels.get(id);
      if (!channel || !d || unreadable(v, id) || !LIVE.has(d.status) || !d.remoteId) {
        failed.push({ id, error: "It is no longer live with a known id." });
        continue;
      }
      const secretId = channel.secretId;
      try {
        await adapter.update({
          variant: v,
          channel,
          delivery: d,
          text: items.join("\n\n"),
          items,
          media: def.capabilities.media.maxCount > 0 ? content.media : [],
          secret: secretId ? this.deps.secrets.get(secretId) : null,
        });
        updated.push(id);
        void this.deps.log.append({ at: this.deps.now(), path: plan.path, channelId: id, result: "updated", ...(d.url ? { url: d.url } : {}) });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const error = secretId ? this.deps.secrets.redact(raw, [secretId]) : raw;
        failed.push({ id, error });
        void this.deps.log.append({ at: this.deps.now(), path: plan.path, channelId: id, result: "update_failed", error });
      }
    }
    return { updated, failed };
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
