import { expect } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Platform } from "../../../src/model/platforms";
import { createAdapters, type AdapterDeps } from "../../../src/platforms/adapters";
import { classifyError, PublishError } from "../../../src/platforms/errors";
import { obsidianHttp } from "../../../src/platforms/http";
import type { DeliveryJob, PlatformAdapter, RemoteState } from "../../../src/platforms/types";
import { DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../../src/publish/sync";
import type { Fixture } from "../http";

/** Thu 8 Oct 2026, 10:00 Berlin: the time every contract job is claimed at. */
export const CONTRACT_NOW = Date.UTC(2026, 9, 8, 8);
export const CONTRACT_TIMEOUT_MS = 50;
/** A tiny PNG signature: what readBinary returns for any image in a contract job. */
export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * One adapter's answers to the suite. Every list holds the fake requestUrl's answers in request order;
 * `before` is what the adapter asks before its post request (login, webhook info); the scenario lists
 * start with the post request's answer.
 */
export interface ContractCase {
  platform: Platform;
  /** A valid single-item post without media, claimed at CONTRACT_NOW, with its credential. */
  job(): DeliveryJob;
  before: Fixture[];
  success: { post: Fixture[]; expect: { remoteId: string; url: string } };
  rateLimited: { post: Fixture[]; retryAfterMs: number };
  authExpired: Fixture[];
  forbidden: Fixture[];
  rejected: Fixture[];
  /**
   * A 5xx answer to the post request (M5 P2): "unknown" when the publish commit is not retry-safe (Telegram,
   * Discord: the post may be out), "transient" when a retry is exactly de-duplicated or idempotent.
   */
  serverError: { post: Fixture[]; kind: "transient" | "unknown" };
  /** Strings that must never appear in an error message: tokens, webhook URLs, session JWTs, auth headers. */
  sensitive: string[];
  /**
   * Adapters with lookup(): a check_needed job, the answers for "found" and "not found". `notFoundAnswer` (M5 P5):
   * "not_found" for an exact lookup, which answers `{ published: false }`; "unknown" for a heuristic one, which
   * answers null (can't tell).
   */
  lookup?: { job(): DeliveryJob; found: Fixture[]; expect: RemoteState | null; notFound: Fixture[]; notFoundAnswer: "not_found" | "unknown" };
}

export function contractDeps(): AdapterDeps {
  return {
    http: obsidianHttp,
    now: () => CONTRACT_NOW,
    readBinary: async () => PNG.slice().buffer,
    sleep: async () => undefined,
    timeoutMs: CONTRACT_TIMEOUT_MS,
    resolveEmbed: () => null,
    instagramMediaHost: {
      create: async (file) => ({ url: `https://cdn.example.net/${encodeURIComponent(file.name)}` }),
    },
    // Contract fixtures stand in for externally verified X OAuth scopes and API-tier access.
    xApiAccessVerified: true,
    // Contract fixtures stand in for separately verified LinkedIn member and Community Management access.
    linkedInMemberAccessVerified: true,
    linkedInCommunityManagementAccessVerified: true,
    linkedInGrantedScopes: ["w_member_social", "w_organization_social", "r_organization_admin"],
  };
}

/** The adapter the plugin registers for this platform (not a copy built for the test). */
export function adapterFor(platform: Platform, deps: AdapterDeps = contractDeps()): PlatformAdapter {
  const adapter = createAdapters(deps).find((a) => a.platform === platform);
  if (!adapter) throw new Error(`createAdapters() has no ${platform} adapter`);
  return adapter;
}

export type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; kind: string; message: string; retryAfterMs?: number; classifiedByAdapter: boolean };

/** Runs one adapter call against scripted answers; a thrown error is reported with the class the orchestrator would see. */
export async function attempt(run: () => Promise<unknown>, fixtures: readonly Fixture[]): Promise<Outcome> {
  requestUrlMock.reset();
  requestUrlMock.queue.push(...fixtures);
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const err = classifyError(e);
    return { ok: false, kind: err.kind, message: err.message, ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}), classifiedByAdapter: e instanceof PublishError };
  }
}

/**
 * Records every top-level field read from `target`, including `in` checks and property descriptors (M5 P8); "*" when
 * it is spread or enumerated (M4 carry).
 */
export function recordReads<T extends object>(target: T): { proxy: T; reads: Set<string> } {
  const reads = new Set<string>();
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(t, key, receiver) as unknown;
    },
    has(t, key) {
      if (typeof key === "string") reads.add(key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "string") reads.add(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    ownKeys(t) {
      reads.add("*");
      return Reflect.ownKeys(t);
    },
  });
  return { proxy, reads };
}

/** The variant fields an adapter may read (M5 G8). */
export const ALLOWED_VARIANT_READS: ReadonlySet<string> = new Set<string>([...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS]);

const tracked: Array<Set<string>> = [];

/** The job with its variant behind the read guard (M5 P8); `expectDigestReads()` checks every tracked job. */
export function trackedJob(job: DeliveryJob): DeliveryJob {
  const { proxy, reads } = recordReads(job.variant);
  tracked.push(reads);
  return { ...job, variant: proxy };
}

/**
 * For `afterEach` in every adapter test file (M5 P8): fails when any job wrapped by `trackedJob` since the last
 * check had a variant field read outside DIGESTED_VARIANT_FIELDS and IDENTITY_VARIANT_FIELDS, or was spread or
 * enumerated ("*"). Clears the tracked jobs.
 */
export function expectDigestReads(): void {
  const outside = new Set<string>();
  for (const reads of tracked.splice(0)) for (const key of reads) if (!ALLOWED_VARIANT_READS.has(key)) outside.add(key);
  expect([...outside].sort(), "variant fields read outside the digest (M4 carry, M5 P8)").toEqual([]);
}
