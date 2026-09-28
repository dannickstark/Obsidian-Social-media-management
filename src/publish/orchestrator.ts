import type { TFile } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ContentLoader, LoadedContent } from "../composer/content";
import type { SocialIndex } from "../index/socialIndex";
import { MINUTE } from "../model/dates";
import { PLATFORM_META, type Platform } from "../model/platforms";
import { deliveryTime, transition } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import { classifyError, PublishError, statusOf, UnknownOutcomeError, type ErrorKind } from "../platforms/errors";
import { platformDef, type AdapterRegistry } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, RemoteState } from "../platforms/types";
import { GRACE_MS } from "../scheduler/due";
import { withTimeout } from "../util/time";
import { effectiveDelivery } from "./eligibility";
import type { AttemptLog } from "./log";
import { Semaphore } from "./semaphore";

export const BACKOFF_MS: readonly number[] = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
/** A lookup that has not answered by then counts as "can't tell" (it runs during reconciles and holds a platform slot). */
export const LOOKUP_TIMEOUT_MS = 30_000;

export interface FailureInfo {
  path: string;
  channelId: string;
  kind: ErrorKind;
  error: string;
}

export interface PublishedInfo {
  path: string;
  channelId: string;
  url?: string;
}

export type RunResult =
  | { status: "published"; url: string }
  | { status: "failed"; kind: ErrorKind; error: string }
  /** Ruling P4: the send's outcome is unknown; the delivery is parked on `check_needed`, not retried. */
  | { status: "check_needed" }
  | { status: "refused"; reason: string };

export interface OrchestratorDeps {
  writer: SafeWriter;
  index: SocialIndex;
  channels: ChannelRegistry;
  adapters: AdapterRegistry;
  secrets: { get(id: string): string | null; redact(text: string, ids: readonly string[]): string };
  content: Pick<ContentLoader, "load">;
  log: AttemptLog;
  now(): number;
  /** Waits between retries (a timer in the plugin, recorded in tests). */
  delay(ms: number): Promise<void>;
  /** Called once when a delivery ends up failed or check_needed. */
  onFailure(info: FailureInfo): void;
  /** Called once when a delivery is published through its API (phone confirmations, #70). */
  onPublished?(info: PublishedInfo): void;
  /** Deliveries of one platform that may run at once (default 1). */
  concurrency?: number;
  /**
   * How late a delivery may still go out (spec §5.2: the grace period, or the auto-post late window).
   * A Retry-After that would land past it fails the delivery instead of waiting. Default: GRACE_MS.
   */
  lateWindowMs?(): number;
  /** For the delivery's due time (stagger included). Default 0. */
  defaultStaggerMinutes?(): number;
  /** How long a lookup may take before it counts as "can't tell". Default: LOOKUP_TIMEOUT_MS. */
  lookupTimeoutMs?: number;
  /**
   * Final review 4: a run started on the publisher device retries only while this device still holds the role
   * (spec §4.3). A Post now started on another device retries as before. Default: never checked.
   */
  isPublisher?(): boolean;
}

/** A first claim may start from these; a retry only from the `failed` the orchestrator wrote itself. */
const CLAIMABLE = new Set<DeliveryStatus>(["draft", "ready", "scheduled", "overdue", "failed", "awaiting_you"]);
/** These reach `publishing` through `scheduled` (spec §5 state machine). */
const VIA_SCHEDULED = new Set<DeliveryStatus>(["draft", "ready", "awaiting_you"]);

type Attempt = { done: true; result: RunResult } | { done: false; wait: number };

interface Prepared {
  path: string;
  file: TFile;
  channelId: string;
  channel: Channel;
  platform: Platform;
  adapter: PlatformAdapter;
  publish: NonNullable<PlatformAdapter["publish"]>;
  items: string[];
  media: MediaInfo[];
  secret: string | null;
  redact(text: string): string;
  /** Final review Minor 6: no retry may be scheduled past this time. */
  deadline: number;
}

/**
 * Runs one delivery through its API adapter (spec §5): no duplicates, classified errors, retries, redaction.
 *
 * Ruling P4: a network error or timeout raised by `adapter.publish` may have happened after the request
 * reached the platform, so its outcome is unknown. Such an error is never auto-retried: the delivery moves
 * to `check_needed` and `adapter.lookup()` is tried, if the adapter has one. Only errors known to occur
 * before any send — an adapter's own classified `TransientError`/`NeedsUserError`/`InvalidContentError`
 * (e.g. a token refresh, a request that could not be built) — and HTTP 429/5xx (an explicit "not accepted,
 * try again" from the platform) are retried with back-off.
 */
export class PublishOrchestrator {
  private readonly gates = new Map<Platform, Semaphore>();
  /** Deliveries this orchestrator has claimed and not yet settled: their `publishing` is live, not stuck. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * `accept` (publish_now after approval, #77): checked against the exact text this run loads and sends; the
   * run is refused, before any claim, when it no longer matches what the user approved (M2b P3).
   */
  async run(path: string, channelId: string, accept?: (v: Variant, content: LoadedContent) => boolean): Promise<RunResult> {
    const v = this.deps.index.getVariant(path);
    if (!v) return { status: "refused", reason: "The note is gone." };
    const channel = this.deps.channels.get(channelId);
    if (!channel) return { status: "refused", reason: `${channelId} is not set up in the channel settings.` };
    const adapter = this.deps.adapters.get(v.platform);
    if (!adapter?.publish) return { status: "refused", reason: `There is no ${PLATFORM_META[v.platform].label} API adapter yet; use Copy & open.` };
    const content = await this.deps.content.load(v);
    if (accept && !accept(v, content)) return { status: "refused", reason: "The post changed after it was approved, so nothing was sent." };
    const def = platformDef(v.platform);
    const secretId = channel.secretId;
    const start = this.deps.now();
    const window = this.deps.lateWindowMs?.() ?? GRACE_MS;
    const due = deliveryTime(v, channelId, this.deps.defaultStaggerMinutes?.() ?? 0);
    // A scheduled run counts its lateness from the due time; a Post now (early, or of an overdue post) from now.
    const deadline = (due !== undefined && due <= start && start - due <= window ? due : start) + window;
    const job: Prepared = {
      deadline,
      path,
      file: v.file,
      channelId,
      channel,
      platform: v.platform,
      adapter,
      publish: adapter.publish.bind(adapter),
      items: postItems(content.body, def),
      media: def.capabilities.media.maxCount > 0 ? content.media : [],
      secret: secretId ? this.deps.secrets.get(secretId) : null,
      redact: (text) => (secretId ? this.deps.secrets.redact(text, [secretId]) : text),
    };
    const startedAsPublisher = this.deps.isPublisher?.() ?? false;
    const roleLost = () => startedAsPublisher && !this.deps.isPublisher!();
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.gate(job.platform).run(() => this.attempt(job, attempt));
      if (outcome.done) return outcome.result;
      if (!roleLost()) await this.deps.delay(outcome.wait);
      // The delivery stays `failed` with its "retrying in" note, as after an unload; the new publisher doesn't retry it.
      if (roleLost()) return { status: "refused", reason: "This device is no longer the publisher, so the retry was not sent." };
    }
  }

  /** True while this device's own run has the delivery in `publishing` (claimed, result not yet written). */
  isInFlight(path: string, channelId: string): boolean {
    return this.inFlight.has(inFlightKey(path, channelId));
  }

  /** Asks the platform whether an interrupted publish went out (spec §5.1); null when it can't tell. */
  async lookup(path: string, channelId: string): Promise<RemoteState | null> {
    const v = this.deps.index.getVariant(path);
    const channel = this.deps.channels.get(channelId);
    const adapter = v ? this.deps.adapters.get(v.platform) : undefined;
    const delivery = v?.deliveries[channelId];
    if (!v || !channel || !adapter?.lookup || !delivery) return null;
    const content = await this.deps.content.load(v);
    const items = postItems(content.body, platformDef(v.platform));
    const secret = channel.secretId ? this.deps.secrets.get(channel.secretId) : null;
    return this.timedLookup(() => adapter.lookup!({ variant: v, channel, delivery, text: items.join("\n\n"), items, media: content.media, secret }));
  }

  /** A confirmation push must never change a publish's outcome (a throw here would read as an unknown outcome). */
  private announcePublished(info: PublishedInfo): void {
    try {
      this.deps.onPublished?.(info);
    } catch {
      // The post is out; a failed confirmation is not worth more than that.
    }
  }

  /** Runs a lookup; an error, or no answer within the timeout, is "can't tell" (null). */
  private timedLookup(lookup: () => Promise<RemoteState | null>): Promise<RemoteState | null> {
    const answer = Promise.resolve()
      .then(lookup)
      .catch(() => null);
    return withTimeout(answer, this.deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, null);
  }

  private gate(platform: Platform): Semaphore {
    let gate = this.gates.get(platform);
    if (!gate) {
      gate = new Semaphore(this.deps.concurrency ?? 1);
      this.gates.set(platform, gate);
    }
    return gate;
  }

  private async attempt(p: Prepared, attempt: number): Promise<Attempt> {
    const claim = await this.claim(p.file, p.channelId, attempt === 1);
    if ("refuse" in claim) return { done: true, result: { status: "refused", reason: claim.refuse } };
    // Only the run that won the claim marks it, so a refused concurrent run never clears the mark.
    const key = inFlightKey(p.path, p.channelId);
    this.inFlight.add(key);
    try {
      return await this.send(p, attempt, claim);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async send(p: Prepared, attempt: number, claim: { variant: Variant; delivery: Delivery }): Promise<Attempt> {
    const job: DeliveryJob = {
      variant: claim.variant,
      channel: p.channel,
      delivery: claim.delivery,
      text: p.items.join("\n\n"),
      items: p.items,
      media: p.media,
      secret: p.secret,
    };
    try {
      const res = await p.publish(job);
      const at = this.deps.now();
      // Ruling (concern 1): the platform confirmed the post, so a check_needed set meanwhile is resolved to
      // published too; leaving it would invite a manual re-post. Failures and unknown outcomes still refuse.
      const settled = await this.settle(
        p.file,
        p.channelId,
        (d) => {
          const next = transition(d, "published", { url: res.url, remoteId: res.remoteId, at });
          delete next.error;
          return next;
        },
        FROM_PUBLISHING_OR_CHECK_NEEDED,
      );
      void this.deps.log.append({ at, path: p.path, channelId: p.channelId, result: "published", url: res.url });
      this.announcePublished({ path: p.path, channelId: p.channelId, url: res.url });
      if (settled !== true) return { done: true, result: changedUnderneath(settled) };
      return { done: true, result: { status: "published", url: res.url } };
    } catch (e) {
      // Ruling P4: an error the adapter did not classify itself, and which carries no HTTP status, is
      // ambiguous about whether the request was sent — treat it as an unknown outcome, never a retry.
      const outcomeUnknown = !(e instanceof PublishError) && statusOf(e) === undefined;
      const err = outcomeUnknown ? new UnknownOutcomeError(e instanceof Error ? e.message : String(e)) : classifyError(e);
      const message = p.redact(err.message);
      if (err.kind === "unknown") return this.checkNeeded(p, job, message);
      // Spec §5.2 (no silent late posting): a Retry-After landing past the late window fails instead of waiting.
      const tooLate = err.retryAfterMs !== undefined && this.deps.now() + err.retryAfterMs > p.deadline;
      const retry = err.kind === "transient" && attempt <= BACKOFF_MS.length && !tooLate;
      const wait = retry ? Math.max(BACKOFF_MS[attempt - 1]!, err.retryAfterMs ?? 0) : 0;
      const stored = retry
        ? `${message} (retrying in ${Math.round(wait / MINUTE)} min)`
        : tooLate && err.kind === "transient"
          ? `${message} (the platform asked to wait ${Math.max(1, Math.round(err.retryAfterMs! / MINUTE))} min, past the posting window; not retried)`
          : message;
      const settled = await this.settle(p.file, p.channelId, (d) => transition(d, "failed", { error: stored }));
      void this.deps.log.append({ at: this.deps.now(), path: p.path, channelId: p.channelId, result: retry && settled === true ? "retry" : "failed", error: message });
      // The state changed while the request was out (check_needed from a reconcile, a user decision): never retry over it.
      if (settled !== true) return { done: true, result: changedUnderneath(settled) };
      if (retry) return { done: false, wait };
      this.deps.onFailure({ path: p.path, channelId: p.channelId, kind: err.kind, error: stored });
      return { done: true, result: { status: "failed", kind: err.kind, error: stored } };
    }
  }

  /** Ruling P4: park on check_needed and try lookup() once; never retried automatically. */
  private async checkNeeded(p: Prepared, job: DeliveryJob, message: string): Promise<Attempt> {
    const parked = await this.settle(p.file, p.channelId, (d) => transition(d, "check_needed", { error: message }));
    if (parked !== true) {
      void this.deps.log.append({ at: this.deps.now(), path: p.path, channelId: p.channelId, result: "check_needed", error: message });
      return { done: true, result: changedUnderneath(parked) };
    }
    const lookup = p.adapter.lookup?.bind(p.adapter);
    const remote = lookup ? await this.timedLookup(() => lookup(job)) : null;
    if (remote?.published) {
      const at = this.deps.now();
      // The only settle allowed to start from check_needed: the lookup found the post on the platform.
      const settled = await this.settle(
        p.file,
        p.channelId,
        (d) => {
          const next = transition(d, "published", { url: remote.url, remoteId: remote.remoteId, at });
          delete next.error;
          return next;
        },
        FROM_CHECK_NEEDED,
      );
      void this.deps.log.append({ at, path: p.path, channelId: p.channelId, result: "published", url: remote.url });
      this.announcePublished({ path: p.path, channelId: p.channelId, ...(remote.url ? { url: remote.url } : {}) });
      if (settled !== true) return { done: true, result: changedUnderneath(settled) };
      return { done: true, result: { status: "published", url: remote.url ?? "" } };
    }
    void this.deps.log.append({ at: this.deps.now(), path: p.path, channelId: p.channelId, result: "check_needed", error: message });
    this.deps.onFailure({ path: p.path, channelId: p.channelId, kind: "unknown", error: message });
    return { done: true, result: { status: "check_needed" } };
  }

  /** Writes `publishing` + timestamp before any network call; the plan runs on fresh frontmatter, so nothing is claimed twice. */
  private async claim(file: TFile, channelId: string, first: boolean): Promise<{ variant: Variant; delivery: Delivery } | { refuse: string }> {
    const box: { variant?: Variant; delivery?: Delivery } = {};
    const result = await this.deps.writer.updateVariant(file, (fresh) => {
      const d = effectiveDelivery(fresh, channelId);
      if (!d) return { refuse: "Its delivery entry can't be read, or the channel is not on this post." };
      if (!(first ? CLAIMABLE.has(d.status) : d.status === "failed")) {
        return { refuse: d.status === "publishing" ? "It is already being published." : `It is ${d.status.replace(/_/g, " ")}.` };
      }
      const from = VIA_SCHEDULED.has(d.status) ? transition(d, "scheduled") : d;
      const next = transition(from, "publishing", { at: this.deps.now(), attempts: (d.attempts ?? 0) + 1 });
      delete next.error;
      box.variant = fresh;
      box.delivery = next;
      return { deliveries: { [channelId]: next } };
    });
    if ("refuse" in result) return result;
    return { variant: box.variant!, delivery: box.delivery! };
  }

  /**
   * Writes the next state only while the delivery is still where the orchestrator left it: `publishing`
   * (only a confirmed success — the adapter's response or the lookup — may start from `check_needed`). True when written; otherwise the status
   * found instead, and nothing is written.
   */
  private async settle(
    file: TFile,
    channelId: string,
    next: (d: Delivery) => Delivery,
    from: ReadonlySet<DeliveryStatus> = FROM_PUBLISHING,
  ): Promise<true | { found: DeliveryStatus | undefined }> {
    let found: DeliveryStatus | undefined;
    const result = await this.deps.writer.updateVariant(file, (fresh) => {
      const d = fresh.deliveries[channelId];
      found = d?.status;
      if (!d || !from.has(d.status)) return { refuse: "The delivery changed while it was being published." };
      return { deliveries: { [channelId]: next(d) } };
    });
    return "refuse" in result ? { found } : true;
  }
}

function inFlightKey(path: string, channelId: string): string {
  return `${path}\n${channelId}`;
}

const FROM_PUBLISHING: ReadonlySet<DeliveryStatus> = new Set(["publishing"]);
const FROM_CHECK_NEEDED: ReadonlySet<DeliveryStatus> = new Set(["check_needed"]);
/** A confirmed success (the adapter returned) may also resolve a check_needed set while the request was out. */
const FROM_PUBLISHING_OR_CHECK_NEEDED: ReadonlySet<DeliveryStatus> = new Set(["publishing", "check_needed"]);

/** Final review Important 4: a settle refused because the state changed underneath; never retried. */
function changedUnderneath(settled: { found: DeliveryStatus | undefined }): RunResult {
  if (settled.found === "check_needed") return { status: "check_needed" };
  return { status: "refused", reason: `It changed while it was being published${settled.found ? ` (it is ${settled.found.replace(/_/g, " ")} now)` : ""}.` };
}
