import type { TFile } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ContentLoader, LoadedContent } from "../composer/content";
import { expandRows, heldForReview } from "../index/queries";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { HOUR, MINUTE } from "../model/dates";
import { PLATFORM_META } from "../model/platforms";
import { deliveryTime, transition } from "../model/stateMachine";
import type { Delivery, Issue, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import { blocking } from "../platforms/checks";
import { classifyError, PublishError, statusOf, UnknownOutcomeError } from "../platforms/errors";
import { effectiveMethod, type AdapterRegistry } from "../platforms/registry";
import type { DeliveryJob, PlatformAdapter, RemoteState } from "../platforms/types";
import { withTimeout } from "../util/time";
import { effectiveDelivery, unreadable } from "./eligibility";
import { deliveryJob } from "./job";
import type { AttemptLog } from "./log";
import { LOOKUP_TIMEOUT_MS, type FailureInfo, type PublishedInfo } from "./orchestrator";
import { contentDigest } from "./sync";

/** On top of the adapter's own lead: room for the tick, the request and clock differences. */
export const HANDOVER_MARGIN_MS = 2 * MINUTE;
/** Retries of a hand-over that failed transiently; after them the post goes out through the API at its time. */
export const HANDOVER_BACKOFF_MS: readonly number[] = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
/** A note with blocking issues is looked at again after this long. */
const BLOCKED_RETRY_MS = 5 * MINUTE;
/** How long after the platform's time the publisher first asks whether the post went out. */
export const SETTLE_AFTER_MS = 3 * MINUTE;
/** Between two questions about the same post. */
export const SETTLE_EVERY_MS = 15 * MINUTE;
/** With no answer this long after its time, the delivery goes to check_needed. */
export const CONFIRM_WITHIN_MS = 24 * HOUR;
/** Hand-overs, and separately platform checks, per background run: a backlog is spread over ticks. */
export const MAX_PER_RUN = 10;

export interface HandOverCandidate {
  path: string;
  channelId: string;
  at: number;
}

export interface SettleCandidate {
  path: string;
  channelId: string;
  remoteAt: number;
}

export type HandOverOutcome = "handed_over" | "check_needed" | "published" | "kept" | "refused";

export interface HandOverDeps {
  writer: SafeWriter;
  index: SocialIndex;
  channels: ChannelRegistry;
  adapters: AdapterRegistry;
  secrets: { get(id: string): string | null; redact(text: string, ids: readonly string[]): string };
  content: Pick<ContentLoader, "load">;
  /** The composer's checks: nothing with a blocking issue is handed over (M2b P3). */
  check(v: IndexedVariant, content: LoadedContent): Issue[];
  /** Saves an open editor of the note, so what is handed over is what is on screen (M2b P3). */
  flush(path: string): Promise<void>;
  log: AttemptLog;
  now(): number;
  isPublisher(): boolean;
  defaultStaggerMinutes(): number;
  /** A hand-over that won't be tried again this session (the post still goes out from Obsidian). */
  warn(message: string): void;
  onFailure(info: FailureInfo): void;
  onPublished?(info: PublishedInfo): void;
  lookupTimeoutMs?: number;
}

const key = (path: string, channelId: string): string => `${path}\n${channelId}`;
const attemptKey = (c: HandOverCandidate): string => `${key(c.path, c.channelId)}@${c.at}`;
/** A claim whose platform answer is not written yet. */
const WAITING = (d: Delivery): boolean => d.status === "handed_over" && !d.remoteId;

/** Scheduled deliveries on native channels of auto posts, far enough ahead to hand over now (spec §4.2, §5). */
export function handOverCandidates(variants: readonly IndexedVariant[], adapters: AdapterRegistry, channels: ChannelRegistry, now: number, defaultStagger: number): HandOverCandidate[] {
  const out: HandOverCandidate[] = [];
  for (const r of expandRows(variants, defaultStagger)) {
    if (r.channelId === null || r.status !== "scheduled" || r.at === undefined) continue;
    const v = r.variant;
    if (unreadable(v, r.channelId) || heldForReview(v)) continue;
    const adapter = adapters.get(v.platform);
    if (!adapter || effectiveMethod(v.mode, channels.get(r.channelId), adapter) !== "native") continue;
    if (r.at < now + (adapter.minLeadMs ?? 0) + HANDOVER_MARGIN_MS) continue;
    out.push({ path: v.path, channelId: r.channelId, at: r.at });
  }
  return out.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
}

/** Handed-over deliveries whose platform time is at least SETTLE_AFTER_MS past. */
export function settleCandidates(variants: readonly IndexedVariant[], now: number, defaultStagger: number): SettleCandidate[] {
  const out: SettleCandidate[] = [];
  for (const v of variants) {
    for (const id of v.channels) {
      const d = v.deliveries[id];
      if (d?.status !== "handed_over" || !d.remoteId || unreadable(v, id)) continue;
      const remoteAt = d.remoteAt ?? deliveryTime(v, id, defaultStagger);
      if (remoteAt === undefined || remoteAt + SETTLE_AFTER_MS > now) continue;
      out.push({ path: v.path, channelId: id, remoteAt });
    }
  }
  return out.sort((a, b) => a.remoteAt - b.remoteAt);
}

/** Hands posts to native schedulers and follows them until they are published. */
export class HandOverService {
  private running = false;
  private readonly inFlight = new Set<string>();
  private readonly retryAt = new Map<string, { at: number; failures: number }>();
  private readonly checkedAt = new Map<string, number>();

  constructor(private readonly deps: HandOverDeps) {}

  isInFlight(path: string, channelId: string): boolean {
    return this.inFlight.has(key(path, channelId));
  }

  /** One background pass, on the publisher only, one at a time; never rejects. */
  async run(): Promise<void> {
    if (this.running || !this.deps.isPublisher()) return;
    this.running = true;
    try {
      const now = this.deps.now();
      const stagger = this.deps.defaultStaggerMinutes();
      const variants = this.deps.index.variants();
      const due = handOverCandidates(variants, this.deps.adapters, this.deps.channels, now, stagger)
        .filter((c) => (this.retryAt.get(attemptKey(c))?.at ?? 0) <= now)
        .slice(0, MAX_PER_RUN);
      for (const c of due) {
        if (!this.deps.isPublisher()) return;
        await this.handOver(c.path, c.channelId, c.at).catch((e: unknown) => this.deps.warn(`Could not hand over ${c.path}: ${e instanceof Error ? e.message : String(e)}`));
      }
      const checks = settleCandidates(this.deps.index.variants(), now, stagger)
        .filter((c) => (this.checkedAt.get(key(c.path, c.channelId)) ?? Number.NEGATIVE_INFINITY) + SETTLE_EVERY_MS <= now)
        .slice(0, MAX_PER_RUN);
      for (const c of checks) {
        if (!this.deps.isPublisher()) return;
        await this.settle(c.path, c.channelId).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  async handOver(path: string, channelId: string, at: number): Promise<HandOverOutcome> {
    const v = this.deps.index.getVariant(path);
    const channel = this.deps.channels.get(channelId);
    const adapter = v ? this.deps.adapters.get(v.platform) : undefined;
    if (!v || !channel || !adapter?.schedule) return "refused";
    const label = PLATFORM_META[v.platform].label;
    const tryKey = attemptKey({ path, channelId, at });
    const now = this.deps.now();
    await this.deps.flush(path);
    const content = await this.deps.content.load(v);
    if (blocking(this.deps.check(v, content))) {
      this.retryAt.set(tryKey, { at: now + BLOCKED_RETRY_MS, failures: this.retryAt.get(tryKey)?.failures ?? 0 });
      return "kept";
    }
    const secret = channel.secretId ? this.deps.secrets.get(channel.secretId) : null;
    if (adapter.scheduleRefusal?.(deliveryJob(v, channel, { status: "handed_over", at, remoteAt: at }, content, secret))) {
      this.retryAt.set(tryKey, { at: Number.POSITIVE_INFINITY, failures: 0 });
      return "kept";
    }
    const digest = contentDigest(v, content.body, [...content.media, ...(content.featured ? [content.featured] : [])]);
    const stagger = this.deps.defaultStaggerMinutes();
    const box: { v?: Variant; d?: Delivery; before?: Delivery } = {};
    const claimed = await this.deps.writer.updateVariant(v.file, (fresh) => {
      if (heldForReview(fresh)) return { refuse: "The note is held for review." };
      const d = effectiveDelivery(fresh, channelId);
      if (d?.status !== "scheduled") return { refuse: "It is no longer scheduled." };
      if (deliveryTime(fresh, channelId, stagger) !== at) return { refuse: "Its time changed." };
      if (contentDigest(fresh, content.body, [...content.media, ...(content.featured ? [content.featured] : [])]) !== digest) return { refuse: "It changed while it was being read." };
      const next = transition(d, "handed_over", { at, remoteAt: at, digest, attempts: (d.attempts ?? 0) + 1 });
      delete next.remoteId;
      delete next.url;
      delete next.error;
      box.v = fresh;
      box.d = next;
      box.before = { ...d };
      return { deliveries: { [channelId]: next } };
    });
    if ("refuse" in claimed) return "refused";
    const job = deliveryJob(box.v!, channel, box.d!, content, secret);
    const redact = (text: string) => (channel.secretId ? this.deps.secrets.redact(text, [channel.secretId]) : text);
    const k = key(path, channelId);
    this.inFlight.add(k);
    try {
      const res = await adapter.schedule(job);
      const written = await this.write(v.file, channelId, WAITING, (d) => ({ ...d, remoteId: res.remoteId, ...(res.url ? { url: res.url } : {}) }));
      void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "handed_over", ...(res.url ? { url: res.url } : {}) });
      this.retryAt.delete(tryKey);
      return written ? "handed_over" : "refused";
    } catch (e) {
      const unknown = !(e instanceof PublishError) && statusOf(e) === undefined;
      const err = unknown ? new UnknownOutcomeError(e instanceof Error ? e.message : String(e)) : classifyError(e);
      const message = redact(err.message);
      if (err.kind === "unknown") return await this.unknown(v.file, path, channelId, job, adapter, message, label);
      await this.write(v.file, channelId, WAITING, () => {
        const back = { ...box.before!, error: `Not handed over to ${label}: ${message} It stays scheduled and goes out from Obsidian at its time.` };
        delete back.remoteAt;
        delete back.digest;
        return back;
      });
      void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "handover_failed", error: message });
      const failures = (this.retryAt.get(tryKey)?.failures ?? 0) + 1;
      const retry = err.kind === "transient" && failures <= HANDOVER_BACKOFF_MS.length;
      const wait = retry ? Math.max(HANDOVER_BACKOFF_MS[failures - 1]!, err.retryAfterMs ?? 0) : Number.POSITIVE_INFINITY;
      this.retryAt.set(tryKey, { at: this.deps.now() + wait, failures });
      if (!retry) this.deps.warn(`${v.displayTitle}: not handed over to ${label} (${message}). It stays scheduled and goes out from Obsidian at its time, if this device is on.`);
      return "kept";
    } finally {
      this.inFlight.delete(k);
    }
  }

  /** Asks the platform about a handed-over post whose time has passed. */
  async settle(path: string, channelId: string): Promise<void> {
    const v = this.deps.index.getVariant(path);
    const channel = this.deps.channels.get(channelId);
    const adapter = v ? this.deps.adapters.get(v.platform) : undefined;
    const d = v?.deliveries[channelId];
    if (!v || !channel || !adapter?.lookup || d?.status !== "handed_over" || !d.remoteId) return;
    const now = this.deps.now();
    this.checkedAt.set(key(path, channelId), now);
    const label = PLATFORM_META[v.platform].label;
    const content = await this.deps.content.load(v);
    const secret = channel.secretId ? this.deps.secrets.get(channel.secretId) : null;
    const lookup = adapter.lookup.bind(adapter);
    const state = await this.timed(() => lookup(deliveryJob(v, channel, d, content, secret)));
    const remoteAt = state?.scheduledAt ?? d.remoteAt ?? deliveryTime(v, channelId, this.deps.defaultStaggerMinutes()) ?? now;
    const same = (x: Delivery) => x.status === "handed_over" && x.remoteId === d.remoteId;
    if (state?.published) {
      const url = state.url ?? d.url;
      const ok = await this.write(v.file, channelId, same, (x) => {
        const next = transition(x, "published", { at: remoteAt, remoteId: state.remoteId ?? x.remoteId!, ...(url ? { url } : {}) });
        delete next.error;
        return next;
      });
      if (!ok) return;
      void this.deps.log.append({ at: now, path, channelId, result: "published", ...(url ? { url } : {}) });
      this.deps.onPublished?.({ path, channelId, ...(url ? { url } : {}) });
      return;
    }
    if (state?.scheduledAt !== undefined && now - state.scheduledAt <= CONFIRM_WITHIN_MS) {
      if (state.scheduledAt !== d.remoteAt) await this.write(v.file, channelId, same, (x) => ({ ...x, remoteAt: state.scheduledAt! }));
      return;
    }
    if (state?.gone) {
      const error = `It is no longer scheduled on ${label}, and it was not posted.`;
      if (await this.write(v.file, channelId, same, (x) => transition(x, "failed", { error }))) {
        void this.deps.log.append({ at: now, path, channelId, result: "failed", error });
        this.deps.onFailure({ path, channelId, kind: "needs_user", error });
      }
      return;
    }
    if (now - remoteAt > CONFIRM_WITHIN_MS) {
      const error = `${label} hasn't confirmed this post a day after its time. Check ${label}, then mark it as published or not.`;
      if (await this.write(v.file, channelId, same, (x) => transition(x, "check_needed", { error }))) {
        void this.deps.log.append({ at: now, path, channelId, result: "check_needed", error });
        this.deps.onFailure({ path, channelId, kind: "unknown", error });
      }
    }
  }

  /** Parks an uncertain hand-over, looks it up once, and never schedules it again automatically. */
  private async unknown(file: TFile, path: string, channelId: string, job: DeliveryJob, adapter: PlatformAdapter, message: string, label: string): Promise<HandOverOutcome> {
    const parked = await this.write(file, channelId, WAITING, (d) => transition(d, "check_needed", { error: `${message} Check ${label}'s scheduled posts.` }));
    void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "check_needed", error: message });
    if (!parked) return "refused";
    const lookup = adapter.lookup?.bind(adapter);
    const state = lookup ? await this.timed(() => lookup(job)) : null;
    const checking = (d: Delivery) => d.status === "check_needed";
    if (state?.published) {
      const at = this.deps.now();
      await this.write(file, channelId, checking, (d) => {
        const next = transition(d, "published", { at, ...(state.url ? { url: state.url } : {}), ...(state.remoteId ? { remoteId: state.remoteId } : {}) });
        delete next.error;
        return next;
      });
      void this.deps.log.append({ at, path, channelId, result: "published", ...(state.url ? { url: state.url } : {}) });
      this.deps.onPublished?.({ path, channelId, ...(state.url ? { url: state.url } : {}) });
      return "published";
    }
    if (state?.scheduledAt !== undefined && state.remoteId) {
      await this.write(file, channelId, checking, (d) => {
        const next = transition(d, "handed_over", { remoteId: state.remoteId!, remoteAt: state.scheduledAt! });
        delete next.error;
        return next;
      });
      void this.deps.log.append({ at: this.deps.now(), path, channelId, result: "handed_over" });
      return "handed_over";
    }
    this.deps.onFailure({ path, channelId, kind: "unknown", error: message });
    return "check_needed";
  }

  private async write(file: TFile, channelId: string, accept: (d: Delivery) => boolean, next: (d: Delivery) => Delivery): Promise<boolean> {
    const result = await this.deps.writer.updateVariant(file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (!d || unreadable(fresh, channelId) || !accept(d)) return { refuse: "The delivery changed." };
      return { deliveries: { [channelId]: next(d) } };
    });
    return !("refuse" in result);
  }

  private timed(lookup: () => Promise<RemoteState | null>): Promise<RemoteState | null> {
    const answer = Promise.resolve()
      .then(lookup)
      .catch(() => null);
    return withTimeout(answer, this.deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, null);
  }
}
