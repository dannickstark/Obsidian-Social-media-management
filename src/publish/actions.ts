import { getFrontMatterInfo, Notice, parseYaml, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import { openMarkdownView } from "../composer/session";
import type { LoadedContent } from "../composer/content";
import { HELD_REFUSAL, heldForReview, LIVE_STATUSES } from "../index/queries";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { bodyOf, excerpt } from "../model/body";
import { isRecord, parseVariant } from "../model/frontmatter";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel, Delivery, Issue, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import type { AssistedTarget, ClipItem, MediaInfo, SyncChange, VerifyResult } from "../platforms/types";
import { RemoteRemovedError, ReplacementUnknownError } from "../platforms/errors";
import type { AdapterRegistry } from "../platforms/registry";
import { FacebookAdapter, type FacebookPageChoice } from "../platforms/facebook/api";
import { LinkedInAdapter } from "../platforms/linkedin/api";
import type { LinkedInAccountChoice } from "../platforms/linkedin/accounts";
import { TelegramAdapter, type TelegramChat } from "../platforms/telegram/api";
import { autoPostLateMs, type OsmmSettings } from "../settings/settings";
import { VIEW_SIDEBAR, type PlannerActions } from "../ui/actions";
import { SvelteModal } from "../ui/dialogs";
import type { OsmmContext } from "../ui/context";
import { activateView } from "../views/PlannerView";
import { formatShortDate, formatTime } from "../ui/format";
import { assistedJob, assistedTarget } from "./assisted";
import { assistedQueue } from "./assistedFlow";
import AssistedFlow from "./AssistedFlow.svelte";
import { isMobile, type ClipboardService, type CopyResult } from "./clipboard";
import { effectiveDelivery, unreadable } from "./eligibility";
import { deliveryJob } from "./job";
import { validateLiveUrl } from "./liveUrl";
import type { AttemptLog } from "./log";
import { LATE_SUCCESS_WINDOW_MS, PublishOrchestrator, type FailureInfo, type PublishedInfo, type RunResult } from "./orchestrator";
import { HANDOVER_MARGIN_MS, HandOverService } from "./handover";
import { toAwaiting, toPublished, toSkipped } from "./transitions";
import { transition } from "../model/stateMachine";
import { effectiveMethod, platformDef } from "../platforms/registry";
import { postItems, postText } from "../platforms/text";
import { imageEmbeds } from "../platforms/wordpress/markdown";
import { GRACE_MS, type DueItem } from "../scheduler/due";
import { withTimeout } from "../util/time";
import { contentDigest, syncChange, syncInfo, type SyncInfo } from "./sync";

/** How long "Test connection" waits for the platform. */
export const VERIFY_TIMEOUT_MS = 20_000;

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

/**
 * What a send would post: every field an adapter receives besides the delivery itself (title, link, body,
 * resolved media with alt text and focus, WordPress fields). An approved plan is only sent while this is
 * unchanged (M2b P3 for approvals), and the approval question shows each of these fields.
 */
export function sendDigest(v: Variant, content: LoadedContent): string {
  const media = (m: MediaInfo | undefined) => (m ? [
    m.target, m.path ?? null, m.alt ?? null, m.focus ?? null,
    v.mediaMeta?.[m.target]?.sourcePath ?? null, v.mediaMeta?.[m.target]?.cropPath ?? null,
    v.mediaMeta?.[m.target]?.cropRatio ?? null, m.fingerprint ?? null, m.sourceFingerprint ?? null,
  ] : null);
  // Media a platform never sends (maxCount 0) is neither shown nor part of the digest.
  const sent = platformDef(v.platform).capabilities.media.maxCount > 0 ? content.media : [];
  const bodyImages = v.platform === "wordpress" ? imageEmbeds(content.body).map((target) => [
    target, v.mediaMeta?.[target]?.alt ?? null, v.mediaMeta?.[target]?.sourcePath ?? null,
    v.mediaMeta?.[target]?.cropPath ?? null, v.mediaMeta?.[target]?.cropRatio ?? null,
  ]) : [];
  return JSON.stringify([v.platform, v.title ?? "", v.url ?? "", content.body, bodyImages, sent.map(media), media(content.featured), v.wordpress ?? null]);
}

/** One labelled line of the approval question ("Link", "Image 1", "Slug" …). */
export interface ShownField {
  label: string;
  value: string;
}

/** What the approval question shows: the title as the planner shows it, each part of the text in full, and every other field that is sent. */
interface Shown {
  title: string;
  /** The text as the platform receives it, part by part (one item unless it is a thread). */
  items: string[];
  details: ShownField[];
}

export interface SendPlan extends Shown {
  path: string;
  queue: string[];
  api: string[];
  assisted: string[];
  /** Each queued channel's delivery status, as the user reads it ("scheduled", "waiting for you"). */
  statuses: Record<string, string>;
  /** Queued channels the user is posting by hand right now (awaiting_you). */
  waiting: string[];
  /** The text as the platform receives it, for the approval dialog. */
  text: string;
  digest: string;
}

export interface UpdatePlan extends Shown {
  path: string;
  channels: string[];
  statuses: Record<string, string>;
  text: string;
  digest: string;
}

export type SendRefusal = { refuse: string; issues?: Issue[] };

const GONE = "That note is no longer available.";
const BLOCKING = "The post has blocking issues, so nothing was sent.";
const CHANGED = "The post changed after it was approved, so nothing was sent. Ask again with the new text.";
const NOTHING = "Nothing left to post for this note.";
const NOT_FOUND = "Not found on the platform after an interrupted publish.";
const NOT_FOUND_YET = "Not found on the platform yet. A late answer can still settle it; if it stays missing, mark it as not published.";
const NOT_SCHEDULED = "Not found in the platform's scheduled posts. Check there: if it is missing, mark it as not published and schedule it again.";
export const ALL_WAITING = "The channels left are waiting for the user to post them by hand, so nothing was sent.";
// Fix round 1 (m4): say how it is released, not just where to approve it. Unlike HELD_REFUSAL (a Notice for
// the user in Obsidian), this one goes back to Claude through publish_now/push_update, so it names both ways out.
const HELD =
  "Claude wrote this note while Obsidian was closed. It is released once the user agrees in this conversation and Claude schedules it, or once they approve it in Obsidian (sidebar, Written by Claude).";

const SILENT: DeliveryNotifier = { due: () => undefined, failed: () => undefined };

export type MarkResult = { ok: true } | { ok: false; reason: string };

/** Side effects of publishing (assisted flow, scheduler dispatch, overdue tray). Every write is per key, on fresh frontmatter. */
export class PublishActions {
  /** Set by the plugin so actions can open Svelte modals with the same context. */
  context: OsmmContext | null = null;

  /** Channel settings, "Test connection" (M5): asks the platform with this device's credential. Never throws; never shows the secret. */
  async verifyChannel(channel: Channel): Promise<VerifyResult> {
    const label = PLATFORM_META[channel.platform].label;
    const adapter = this.deps.adapters.get(channel.platform);
    if (!adapter?.verify) return { ok: false, error: `${label} has no API connection in this version; it uses the assisted flow.` };
    const secret = channel.secretId ? this.deps.secrets.get(channel.secretId) : null;
    const asked = adapter.verify(channel, secret).catch((e: unknown): VerifyResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    const answer = await withTimeout(asked, VERIFY_TIMEOUT_MS, { ok: false, error: `${label} did not answer in time.` } as VerifyResult);
    if (answer.ok || !channel.secretId) return answer;
    return { ok: false, error: this.deps.secrets.redact(answer.error, [channel.secretId]) };
  }

  canVerify(platform: Platform): boolean {
    return !!this.deps.adapters.get(platform)?.verify;
  }

  /** Channel settings, Telegram "Find chat id": the channels the bot saw recently. */
  async findTelegramChats(secretId: string): Promise<TelegramChat[] | { error: string }> {
    const telegram = this.deps.adapters.get("telegram");
    if (!(telegram instanceof TelegramAdapter)) return { error: "Telegram isn't connected in this version." };
    try {
      return await telegram.findChats(secretId ? this.deps.secrets.get(secretId) : null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: secretId ? this.deps.secrets.redact(message, [secretId]) : message };
    }
  }

  /** Channel settings, Facebook "Find Pages": only Page names, ids and publish eligibility leave the adapter. */
  async findFacebookPages(secretId: string): Promise<FacebookPageChoice[] | { error: string }> {
    const facebook = this.deps.adapters.get("facebook");
    if (!(facebook instanceof FacebookAdapter)) return { error: "Facebook Pages publishing isn't connected in this version." };
    try {
      return await facebook.findPages(secretId ? this.deps.secrets.get(secretId) : null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: secretId ? this.deps.secrets.redact(message, [secretId]) : message };
    }
  }

  /** Channel settings, LinkedIn account discovery: only account ids, names and verified permission states leave the adapter. */
  async findLinkedInAccounts(secretId: string): Promise<LinkedInAccountChoice[] | { error: string }> {
    const linkedin = this.deps.adapters.get("linkedin");
    if (!(linkedin instanceof LinkedInAdapter)) return { error: "LinkedIn account discovery isn't connected in this version." };
    try {
      return await linkedin.findAccounts(secretId ? this.deps.secrets.get(secretId) : null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: secretId ? this.deps.secrets.redact(message, [secretId]) : message };
    }
  }

  canPublishLinkedIn(kind: "profile" | "page", secretId?: string): boolean {
    const linkedin = this.deps.adapters.get("linkedin");
    if (!(linkedin instanceof LinkedInAdapter)) return false;
    const token = secretId ? this.deps.secrets.get(secretId) : null;
    return linkedin.canPublishToken(kind, token);
  }

  readonly orchestrator: PublishOrchestrator;
  readonly handover: HandOverService;
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
    this.handover = new HandOverService({
      writer: deps.writer,
      index: deps.index,
      channels: deps.channels,
      adapters: deps.adapters,
      secrets: deps.secrets,
      content: deps.composer.content,
      check: (v, content) => deps.composer.check(v, content),
      flush: async (path) => {
        const editor = openMarkdownView(deps.app, path);
        if (editor) await editor.save();
      },
      log: deps.log,
      now: () => deps.now(),
      isPublisher: () => deps.isPublisher?.() ?? false,
      defaultStaggerMinutes: () => deps.settings().defaultStaggerMinutes,
      warn: (message) => void new Notice(message, 0),
      onFailure: (info) => this.notifier.failed(info),
      onPublished: (info) => this.notifier.published?.(info),
    });
  }

  /** Scheduler: starts native hand-overs and platform checks without holding the tick. */
  background(_now: number): void {
    this.handover.run().catch(() => undefined);
  }

  /** Runs one API delivery and reports the outcome (failures are reported by the notifier). */
  async runApi(path: string, channelId: string, accept?: (v: Variant, content: LoadedContent) => boolean): Promise<RunResult> {
    const result = await this.orchestrator.run(path, channelId, accept);
    const name = this.channelName(channelId);
    if (result.status === "published") new Notice(result.note ? `Published to ${name}. ${result.note}` : `Published to ${name}.`);
    // A refusal the failure notifier already reported (a retry refused after a change) is not shown twice.
    else if (result.status === "refused" && !result.notified) new Notice(`${name}: ${result.reason}`);
    return result;
  }

  /** Final review Minor 5: an API run started without awaiting it still reports a rejection. */
  private runApiInBackground(path: string, channelId: string, accept?: (v: Variant, content: LoadedContent) => boolean): void {
    this.runApi(path, channelId, accept).catch((e: unknown) => new Notice(`${this.channelName(channelId)}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** This device's own API run has the delivery in `publishing` right now: it is live, not stuck. */
  isInFlight(path: string, channelId: string): boolean {
    return this.orchestrator.isInFlight(path, channelId) || this.handover.isInFlight(path, channelId);
  }

  /** Whether "Check again" can ask the platform: the note's adapter has a lookup(). */
  canLookup(path: string): boolean {
    const v = this.deps.index.getVariant(path);
    return !!v && !!this.deps.adapters.get(v.platform)?.lookup;
  }

  /** A handed-over channel compared with the platform's copy. */
  syncOf(path: string, channelId: string): SyncInfo | null {
    const v = this.deps.index.getVariant(path);
    return v ? syncInfo(v, channelId) : null;
  }

  /** Pushes the current text and local time to one handed-over platform copy, only on the user's click. */
  async pushUpdate(path: string, channelId: string): Promise<boolean> {
    const fresh = await this.freshChecked(path);
    if ("refuse" in fresh) {
      const reason = fresh.refuse === HELD ? HELD_REFUSAL : fresh.refuse;
      new Notice([reason, ...(fresh.issues ?? []).map((issue) => issue.message)].join(" "));
      return false;
    }
    const { v, content } = fresh;
    const d = v.deliveries[channelId];
    const name = this.channelName(channelId);
    if (d?.status !== "handed_over") {
      new Notice(`${name} is not waiting on ${PLATFORM_META[v.platform].label}'s schedule.`);
      return false;
    }
    const result = await this.updateChannel(v, content, channelId, syncChange(v, content.body, d, [...content.media, ...(content.featured ? [content.featured] : [])]));
    new Notice(result.ok ? `Updated on ${PLATFORM_META[v.platform].label} for ${name}.` : `${name}: ${result.error}`);
    return result.ok;
  }

  /** Puts the platform's time back on the note, locally and with Undo. */
  async revertTime(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const label = PLATFORM_META[v.platform].label;
    let back = 0;
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "handed_over" || d.remoteAt === undefined || unreadable(fresh, channelId)) {
        return { refuse: `${this.channelName(channelId)} has no time on ${label} to go back to.` };
      }
      back = d.remoteAt;
      return { deliveries: { [channelId]: { ...d, at: d.remoteAt } } };
    });
    this.deps.planner.afterWrite(result, `Back to ${formatShortDate(back)} ${formatTime(back)}, the time on ${label}.`);
    return result.ok;
  }

  /** Takes the post off the platform's schedule and returns this channel to a local draft. */
  async unscheduleRemote(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    const channel = this.deps.channels.get(channelId);
    if (!v || !channel) return false;
    const label = PLATFORM_META[v.platform].label;
    const adapter = this.deps.adapters.get(v.platform);
    const d = v.deliveries[channelId];
    if (!adapter?.cancel || d?.status !== "handed_over" || !d.remoteId || unreadable(v, channelId)) {
      new Notice(`${channel.name} is not on ${label}'s schedule.`);
      return false;
    }
    if (!(await this.deps.planner.confirm(`Take this post off ${label}'s schedule for ${channel.name}? It won't be posted there, and becomes a draft here.`, "Unschedule"))) return false;
    const secretId = channel.secretId;
    try {
      await adapter.cancel(deliveryJob(v, channel, d, await this.deps.composer.content.load(v), secretId ? this.deps.secrets.get(secretId) : null));
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      new Notice(secretId ? this.deps.secrets.redact(raw, [secretId]) : raw);
      return false;
    }
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const now = fresh.deliveries[channelId];
      if (now?.status !== "handed_over" || now.remoteId !== d.remoteId) return { refuse: "The delivery changed." };
      const draft = transition(transition(now, "scheduled"), "draft");
      for (const field of ["at", "remoteId", "remoteAt", "digest", "url", "error"] as const) delete draft[field];
      return { deliveries: { [channelId]: draft } };
    });
    if ("refuse" in result) return false;
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "cancelled" });
    new Notice(`Taken off ${label}'s schedule. ${channel.name} is a draft again.`);
    return true;
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
      // The note may have changed since it was scheduled. Flush and validate the exact saved content before any
      // automatic send, then make the orchestrator re-check that same snapshot inside its fresh claim.
      const fresh = await this.freshContent(item.path);
      if (!fresh) return;
      const issues = this.deps.composer.check(fresh.v, fresh.content).filter((issue) => issue.level === "error");
      if (heldForReview(fresh.v) || issues.length) {
        const error = heldForReview(fresh.v) ? HELD_REFUSAL : issues.map((issue) => issue.message).join(" ");
        this.notifier.failed({ path: item.path, channelId: item.channelId, kind: "invalid_content", error });
        new Notice(error);
        return;
      }
      const digest = sendDigest(fresh.v, fresh.content);
      this.runApiInBackground(
        item.path,
        item.channelId,
        (claimed, content) =>
          !heldForReview(claimed) &&
          sendDigest(claimed, content) === digest &&
          !this.deps.composer.check(claimed, content).some((issue) => issue.level === "error"),
      );
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

  /** Startup: an interrupted API publish or native hand-over becomes check_needed and is never retried. */
  async markCheckNeeded(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v || this.isInFlight(path, channelId)) return false;
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      const handing = d?.status === "handed_over" && !d.remoteId;
      if (!d || (d.status !== "publishing" && !handing) || this.isInFlight(path, channelId)) return { refuse: "The delivery changed." };
      const error = handing
        ? "Obsidian closed while this was being handed over to the platform. Check its scheduled posts, then mark it as published or not."
        : "Obsidian closed while this was being published. Check the platform, then mark it as published or not.";
      return { deliveries: { [channelId]: transition(d, "check_needed", { error }) } };
    });
    if ("refuse" in result) return false;
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "check_needed" });
    return true;
  }

  /** Resolve a startup check without risking a duplicate or losing an uncertain native hand-over. */
  async resolveCheck(path: string, channelId: string): Promise<void> {
    const state = await this.orchestrator.lookup(path, channelId);
    const v = this.deps.index.getVariant(path);
    if (!state || !v) return;
    const at = this.deps.now();
    let outcome: "published" | "handed_over" | "failed" | "kept" = "kept";
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "check_needed") return { refuse: "The delivery changed." };
      if (state.published) {
        outcome = "published";
        const next = transition(d, "published", { at, ...(state.url ? { url: state.url } : {}), ...(state.remoteId ? { remoteId: state.remoteId } : {}) });
        delete next.error;
        return { deliveries: { [channelId]: next } };
      }
      // An immediate publish has no hand-over baseline. Seeing some scheduled post (or a gone result) does not
      // prove that this plugin's request failed, so leave it for the user rather than inventing a state.
      if (d.remoteAt === undefined && (state.scheduledAt !== undefined || state.gone)) return {};
      // P11: only a claim known to be a native hand-over may return to handed_over.
      if (d.remoteAt !== undefined && state.scheduledAt !== undefined && state.remoteId) {
        outcome = "handed_over";
        const next = transition(d, "handed_over", { remoteId: state.remoteId, remoteAt: state.scheduledAt, ...(d.at === undefined ? { at: state.scheduledAt } : {}) });
        delete next.error;
        return { deliveries: { [channelId]: next } };
      }
      if (d.remoteAt !== undefined) return { deliveries: { [channelId]: { ...d, error: NOT_SCHEDULED } } };
      // A partial-thread note means the platform positively found an incomplete live send. Mark it failed now
      // so the retained send key can resume the missing parts; this is not an ambiguous late-success miss.
      if (state.note) {
        outcome = "failed";
        return { deliveries: { [channelId]: transition(d, "failed", { error: state.note }) } };
      }
      if (at - (d.at ?? 0) < LATE_SUCCESS_WINDOW_MS) return { deliveries: { [channelId]: { ...d, error: NOT_FOUND_YET } } };
      outcome = "failed";
      return { deliveries: { [channelId]: transition(d, "failed", { error: state.note ?? NOT_FOUND }) } };
    });
    if ("refuse" in result || outcome === "kept") return;
    if (outcome === "failed") {
      void this.deps.log.append({ at, path, channelId, result: "failed", error: state.note ?? NOT_FOUND });
      return;
    }
    if (outcome === "handed_over") {
      void this.deps.log.append({ at, path, channelId, result: "handed_over" });
      return;
    }
    void this.deps.log.append({ at, path, channelId, result: "published", ...(state.url ? { url: state.url } : {}) });
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
   * `fromComposer`: the call comes from the composer's own Post now, the one place allowed to post a held note.
   */
  async postNow(path: string, channelIds?: readonly string[], opts: { fromComposer?: boolean } = {}): Promise<void> {
    const fresh = await this.freshValidated(path);
    if (!fresh) return;
    const { v } = fresh;
    // Fix round 1 (I3), final review 8: only the composer's own Post now may post a held note (the user is
    // looking at it); doing so releases the hold, in a write of its own before anything sends (so the
    // orchestrator's own held-note guard, m2, never sees it as still held). Every other entry point refuses.
    if (heldForReview(v) && !opts.fromComposer) {
      new Notice(HELD_REFUSAL);
      return;
    }
    if (heldForReview(v)) {
      const file = this.deps.index.getVariant(path)?.file;
      if (file) await this.deps.writer.updateVariant(file, (f) => (heldForReview(f) ? { fields: { review: undefined } } : {}));
    }
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
   * Fix round 1 (C1): flush the open editor, then read the note back from disk and parse its frontmatter
   * there, so the digest, the split and the title shown all come from what is on disk now, never from an
   * index that may lag behind the flush. Ruling P6: a note Claude wrote while Obsidian was closed
   * (`review: claude`) waits for the user's review. Then M2b P3: re-validate the exact text.
   */
  private async freshChecked(path: string): Promise<{ v: IndexedVariant; content: LoadedContent } | SendRefusal> {
    const indexed = this.deps.index.getVariant(path);
    if (!indexed) return { refuse: GONE };
    const editor = openMarkdownView(this.deps.app, path);
    if (editor) await editor.save();
    const raw = await this.deps.app.vault.read(indexed.file);
    const info = getFrontMatterInfo(raw);
    const fm: unknown = info.exists ? parseYaml(info.frontmatter) : null;
    const parsed = isRecord(fm) ? parseVariant(fm, path) : null;
    if (!isRecord(fm) || !parsed?.value) return { refuse: GONE };
    if (heldForReview(parsed.value)) return { refuse: HELD };
    const body = bodyOf(raw);
    const v: IndexedVariant = { ...indexed, ...parsed.value, file: indexed.file, issues: parsed.issues, displayTitle: parsed.value.title ?? (excerpt(body) || indexed.file.basename) };
    const content = { ...(await this.deps.composer.content.load(v)), body };
    const errors = this.deps.composer.check(v, content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    return { v, content };
  }

  /** Fix round 1 (I1, I2): everything the approval question shows, from the same fresh read as the digest. */
  private shown(v: IndexedVariant, content: LoadedContent): Shown {
    const details: ShownField[] = [];
    const add = (label: string, value: string | undefined) => {
      if (value) details.push({ label, value });
    };
    const image = (m: MediaInfo) =>
      [m.target, m.alt ? `alt text: ${m.alt}` : "no alt text", ...(m.focus ? [`focus: ${m.focus[0]}, ${m.focus[1]}`] : [])].join(", ");
    add("Title", v.title);
    add("Link", v.url);
    if (platformDef(v.platform).capabilities.media.maxCount > 0) content.media.forEach((m, i) => add(`${m.kind === "video" ? "Video" : "Image"} ${i + 1}`, image(m)));
    if (v.wordpress) {
      imageEmbeds(content.body).forEach((target, i) => {
        const alt = v.mediaMeta?.[target]?.alt;
        add(`Image in text ${i + 1}`, [target, alt ? `alt text: ${alt}` : "no alt text"].join(", "));
      });
      add("Slug", v.wordpress.slug);
      add("Categories", v.wordpress.categories.join(", "));
      add("Tags", v.wordpress.tags.join(", "));
      add("Excerpt", v.wordpress.excerpt);
      add("Featured image", content.featured ? image(content.featured) : v.wordpress.featuredImage);
    }
    for (const id of v.channels) {
      const d = v.deliveries[id];
      if (d?.status !== "handed_over" || d.at === undefined || d.remoteAt === undefined || d.at === d.remoteAt) continue;
      add(
        `Time on ${this.channelName(id)}`,
        `${formatShortDate(d.at)} ${formatTime(d.at)} (${PLATFORM_META[v.platform].label} has ${formatShortDate(d.remoteAt)} ${formatTime(d.remoteAt)})`,
      );
    }
    return { title: v.displayTitle, items: postItems(content.body, platformDef(v.platform)), details };
  }

  /** Approval digest for updates: content plus each handed-over channel's local time. */
  private updateDigest(v: IndexedVariant, content: LoadedContent, channels: readonly string[]): string {
    return JSON.stringify([
      sendDigest(v, content),
      channels.map((id) => {
        const d = v.deliveries[id];
        return [id, d?.status === "handed_over" ? (d.at ?? null) : null];
      }),
    ]);
  }

  private statusOf(v: Variant, id: string): string {
    const status = effectiveDelivery(v, id)?.status ?? "draft";
    return status === "awaiting_you" ? "waiting for you" : status.replace(/_/g, " ");
  }

  /** MCP publish_now, before asking (#77): flush, re-validate the exact text, and fix what would be sent. */
  async prepareSend(path: string, channelIds?: readonly string[]): Promise<SendPlan | SendRefusal> {
    const fresh = await this.freshChecked(path);
    if ("refuse" in fresh) return fresh;
    const queue = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, channelIds);
    if (!queue.length) return { refuse: NOTHING };
    const { api, assisted } = this.split(fresh.v, queue);
    const statuses = Object.fromEntries(queue.map((id) => [id, this.statusOf(fresh.v, id)]));
    const waiting = queue.filter((id) => effectiveDelivery(fresh.v, id)?.status === "awaiting_you");
    return {
      path,
      queue,
      api,
      assisted,
      statuses,
      waiting,
      ...this.shown(fresh.v, fresh.content),
      text: postText(fresh.content.body, platformDef(fresh.v.platform)),
      digest: sendDigest(fresh.v, fresh.content),
    };
  }

  /**
   * After approval: flush and re-validate again, and send only what was approved (M2b P3). Ruling P3: a
   * channel that would now go through the API but was approved for the assisted flow refuses the whole send.
   * Each API run re-checks the digest against the exact text it loads and sends.
   */
  async sendApproved(plan: SendPlan, opts: { skipWaiting?: boolean } = {}): Promise<{ started: string[]; opened: string[] } | SendRefusal> {
    const fresh = await this.freshChecked(plan.path);
    if ("refuse" in fresh) return fresh;
    if (sendDigest(fresh.v, fresh.content) !== plan.digest) return { refuse: CHANGED };
    const all = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, plan.queue);
    if (!all.length) return { refuse: NOTHING };
    // Ruling m2: an approval by the channel setting never sends a channel the user is posting by hand, even one
    // that started waiting between prepareSend and now.
    const queue = opts.skipWaiting ? all.filter((id) => effectiveDelivery(fresh.v, id)?.status !== "awaiting_you") : all;
    if (!queue.length) return { refuse: ALL_WAITING };
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
    const channels = v.channels.filter((id) => (!channelIds || channelIds.includes(id)) && !unreadable(v, id) && LIVE_STATUSES.has(v.deliveries[id]?.status ?? "") && !!v.deliveries[id]?.remoteId);
    if (!channels.length) return { refuse: "No channel of this post is live on the platform with a known id." };
    if (!this.deps.adapters.get(v.platform)?.update) return { refuse: `${PLATFORM_META[v.platform].label} posts can't be updated from Obsidian yet.` };
    const statuses = Object.fromEntries(channels.map((id) => [id, this.statusOf(v, id)]));
    return { path, channels, statuses, ...this.shown(v, content), text: postText(content.body, platformDef(v.platform)), digest: this.updateDigest(v, content, channels) };
  }

  /** One live channel's update. A handed-over copy must still be far enough ahead; successful pushes replace its baseline. */
  private async updateChannel(v: IndexedVariant, content: LoadedContent, channelId: string, change?: SyncChange): Promise<{ ok: true } | { ok: false; error: string }> {
    const d = v.deliveries[channelId];
    const channel = this.deps.channels.get(channelId);
    const adapter = this.deps.adapters.get(v.platform);
    if (!channel || !d || !adapter?.update || unreadable(v, channelId) || !LIVE_STATUSES.has(d.status) || !d.remoteId) {
      return { ok: false, error: "It is no longer live with a known id." };
    }
    const label = PLATFORM_META[v.platform].label;
    if (d.status === "handed_over") {
      const at = d.at ?? d.remoteAt;
      if (at === undefined || at < this.deps.now() + (adapter.minLeadMs ?? 0) + HANDOVER_MARGIN_MS) {
        return { ok: false, error: `It is too close to its time on ${label} to change it now. It goes out as it was handed over.` };
      }
      if (change && !change.content && !change.time) return { ok: true };
    }
    const secretId = channel.secretId;
    const redact = (text: string) => (secretId ? this.deps.secrets.redact(text, [secretId]) : text);
    const digest = contentDigest(v, content.body, [...content.media, ...(content.featured ? [content.featured] : [])]);
    const pushedAt = d.at ?? d.remoteAt;
    try {
      const res = (await adapter.update(deliveryJob(v, channel, d, content, secretId ? this.deps.secrets.get(secretId) : null), change)) as { remoteId?: string } | undefined;
      if (d.status === "handed_over") {
        const written = await this.deps.writer.updateVariant(v.file, (fresh) => {
          const now = fresh.deliveries[channelId];
          if (now?.status !== "handed_over" || now.remoteId !== d.remoteId) return { refuse: "The delivery changed." };
          const next: Delivery = { ...now, remoteId: res?.remoteId ?? now.remoteId!, remoteAt: pushedAt ?? now.remoteAt, digest };
          delete next.error;
          return { deliveries: { [channelId]: next } };
        });
        if ("refuse" in written) return { ok: false, error: written.refuse };
      }
      void this.deps.log.append({ at: this.deps.now(), path: v.path, channelId, result: "updated", ...(d.url ? { url: d.url } : {}) });
      return { ok: true };
    } catch (e) {
      const error = redact(e instanceof Error ? e.message : String(e));
      if (e instanceof ReplacementUnknownError && d.status === "handed_over") {
        await this.deps.writer.updateVariant(v.file, (fresh) => {
          const now = fresh.deliveries[channelId];
          if (now?.status !== "handed_over" || now.remoteId !== d.remoteId) return { refuse: "The delivery changed." };
          const checking = transition(now, "check_needed", { error, remoteAt: pushedAt ?? now.remoteAt, digest });
          delete checking.remoteId;
          delete checking.url;
          return { deliveries: { [channelId]: checking } };
        });
      } else if (e instanceof RemoteRemovedError && d.status === "handed_over") {
        await this.deps.writer.updateVariant(v.file, (fresh) => {
          const now = fresh.deliveries[channelId];
          if (now?.status !== "handed_over" || now.remoteId !== d.remoteId) return { refuse: "The delivery changed." };
          const back = transition(now, "scheduled", { error });
          for (const field of ["remoteId", "remoteAt", "digest", "url"] as const) delete back[field];
          return { deliveries: { [channelId]: back } };
        });
      }
      void this.deps.log.append({ at: this.deps.now(), path: v.path, channelId, result: "update_failed", error });
      return { ok: false, error };
    }
  }

  /** After approval: re-checks the approved content and local push times before every channel update. */
  async updateApproved(plan: UpdatePlan): Promise<{ updated: string[]; failed: Array<{ id: string; error: string }> } | SendRefusal> {
    const fresh = await this.freshChecked(plan.path);
    if ("refuse" in fresh) return fresh;
    if (this.updateDigest(fresh.v, fresh.content, plan.channels) !== plan.digest) return { refuse: CHANGED };
    const blocked = this.apiBlockedReason();
    if (blocked) return { refuse: blocked };
    if (!this.deps.adapters.get(fresh.v.platform)?.update) return { refuse: `${PLATFORM_META[fresh.v.platform].label} posts can't be updated from Obsidian yet.` };
    const updated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    let current = fresh;
    for (let i = 0; i < plan.channels.length; i++) {
      const id = plan.channels[i]!;
      if (i > 0) {
        const next = await this.freshChecked(plan.path);
        if ("refuse" in next || this.updateDigest(next.v, next.content, plan.channels) !== plan.digest) {
          for (const remaining of plan.channels.slice(i)) failed.push({ id: remaining, error: "refuse" in next ? next.refuse : CHANGED });
          break;
        }
        current = next;
      }
      const role = this.apiBlockedReason();
      if (role) {
        for (const remaining of plan.channels.slice(i)) failed.push({ id: remaining, error: role });
        break;
      }
      const d = current.v.deliveries[id];
      const result = await this.updateChannel(current.v, current.content, id, d?.status === "handed_over" ? syncChange(current.v, current.content.body, d, [...current.content.media, ...(current.content.featured ? [current.content.featured] : [])]) : undefined);
      if (result.ok) updated.push(id);
      else failed.push({ id, error: result.error });
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
