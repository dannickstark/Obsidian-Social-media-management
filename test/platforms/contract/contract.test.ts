import { afterEach, describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Platform } from "../../../src/model/platforms";
import { createAdapters } from "../../../src/platforms/adapters";
import { hang, json, netError, text, type Fixture } from "../http";
import { CASES } from "./cases";
import { adapterFor, attempt, contractDeps, expectDigestReads, trackedJob, type ContractCase } from "./harness";

/**
 * M5 P2: what a 5xx answer to each platform's publish commit must be. Telegram sends and Discord webhook executes are
 * not retry-safe (the post may be out); Mastodon (Idempotency-Key), Bluesky (record keys from the send key, M5 P17) and WordPress (bySlug) are.
 * A case whose platform is missing here fails: add the platform with its P2 class first.
 */
const EXPECTED_PUBLISH_5XX: Partial<Record<Platform, "unknown" | "transient">> = {
  telegram: "unknown",
  discord: "unknown",
  facebook: "unknown",
  instagram: "unknown",
  mastodon: "transient",
  bluesky: "transient",
  x: "unknown",
  wordpress: "transient",
};

/** Answers of 2xx to the post request that say nothing readable about the post (Task 2 carry). */
const UNREADABLE: Array<[string, Fixture]> = [
  ["not JSON", text(200, "<html><body>Service temporarily busy</body></html>")],
  ["JSON without the post", json(200, {})],
];

// M5 P8: every job in this file goes through the read guard, and every test checks it.
afterEach(() => expectDigestReads());

describe("adapter registry (#87)", () => {
  it("has a contract case for every registered API adapter", () => {
    const registered = createAdapters(contractDeps()).map((a) => a.platform);
    expect(CASES.map((c) => c.platform).sort()).toEqual([...registered].sort());
  });

  it("declares the 5xx class M5 P2 fixes for every case's platform", () => {
    for (const c of CASES) {
      expect(EXPECTED_PUBLISH_5XX[c.platform], `${c.platform} has no entry in EXPECTED_PUBLISH_5XX (M5 P2)`).toBeDefined();
      expect(c.serverError.kind, `${c.platform}: serverError.kind`).toBe(EXPECTED_PUBLISH_5XX[c.platform]);
    }
  });
});
function scenarios(c: ContractCase): Array<[string, Fixture[]]> {
  return [
    ["rate limited", [...c.before, ...c.rateLimited.post]],
    ["auth expired", [...c.before, ...c.authExpired]],
    ["forbidden", [...c.before, ...c.forbidden]],
    ["content rejected", [...c.before, ...c.rejected]],
    ["server error", [...c.before, ...c.serverError.post]],
    ["timeout", [...c.before, hang]],
    ["connection dropped", [...c.before, netError]],
    ...UNREADABLE.map(([name, answer]): [string, Fixture[]] => [`unreadable success (${name})`, [...c.before, answer]]),
    ...(c.before.length > 0
      ? [
          ["server error before posting", [json(502, {})]] as [string, Fixture[]],
          ["connection dropped before posting", [netError]] as [string, Fixture[]],
        ]
      : []),
  ];
}

describe.each(CASES.map((c) => [c.platform, c] as const))("%s adapter contract (#87)", (platform, c) => {
  const publish = (job = c.job()) => () => adapterFor(platform).publish!(trackedJob(job));

  it("publishes and returns the remote id and an https url, over https only, never throwing on HTTP errors", async () => {
    const out = await attempt(publish(), [...c.before, ...c.success.post]);
    expect(out).toEqual({ ok: true, value: expect.objectContaining(c.success.expect) });
    expect(c.success.expect.url).toMatch(/^https:\/\//);
    for (const call of requestUrlMock.calls) {
      expect(call.url).toMatch(/^https:\/\//);
      expect(call.throw).toBe(false);
    }
  });

  it("reads post content only from digested variant fields (M4 carry)", async () => {
    await attempt(publish(), [...c.before, ...c.success.post]);
    expectDigestReads();
  });

  it("classifies a rate limit as transient, with the platform's wait", async () => {
    expect(await attempt(publish(), [...c.before, ...c.rateLimited.post])).toMatchObject({ ok: false, kind: "transient", retryAfterMs: c.rateLimited.retryAfterMs });
  });

  it("classifies expired or wrong credentials as needs-user", async () => {
    expect(await attempt(publish(), [...c.before, ...c.authExpired])).toMatchObject({ ok: false, kind: "needs_user" });
  });

  it("classifies forbidden as needs-user", async () => {
    expect(await attempt(publish(), [...c.before, ...c.forbidden])).toMatchObject({ ok: false, kind: "needs_user" });
  });

  it("classifies rejected content as invalid-content", async () => {
    expect(await attempt(publish(), [...c.before, ...c.rejected])).toMatchObject({ ok: false, kind: "invalid_content" });
  });

  it(`classifies a 5xx on the post request as ${c.serverError.kind} (M5 P2)`, async () => {
    const out = await attempt(publish(), [...c.before, ...c.serverError.post]);
    if (c.serverError.kind === "unknown") {
      // Not retry-safe: the platform may have accepted the post before failing, so it is never retried.
      expect(out).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true, message: expect.stringContaining("not known whether it went out") });
    } else {
      expect(out).toMatchObject({ ok: false, kind: "transient", classifiedByAdapter: true });
    }
  });

  it.runIf(c.before.length > 0)("classifies a 5xx before the post request as transient (nothing was sent, M5 P2)", async () => {
    expect(await attempt(publish(), [json(502, {})])).toMatchObject({ ok: false, kind: "transient", classifiedByAdapter: true });
  });

  it.each(UNREADABLE)("treats a 2xx it can't read on the post request (%s) as an unknown outcome (Task 2 carry)", async (_name, answer) => {
    expect(await attempt(publish(), [...c.before, answer])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
  });

  it("treats a timeout on the post request as an unknown outcome (never retried, M2b P4)", async () => {
    expect(await attempt(publish(), [...c.before, hang])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
  });

  it("treats a dropped connection on the post request as an unknown outcome", async () => {
    expect(await attempt(publish(), [...c.before, netError])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
  });

  it.runIf(c.before.length > 0)("treats a dropped connection before the post request as transient (nothing was sent)", async () => {
    expect(await attempt(publish(), [netError])).toMatchObject({ ok: false, kind: "transient", classifiedByAdapter: true });
  });

  it("never puts a credential in an error message", async () => {
    expect(c.sensitive.length).toBeGreaterThan(0);
    for (const [name, fixtures] of scenarios(c)) {
      const out = await attempt(publish(), fixtures);
      expect(out.ok, name).toBe(false);
      if (out.ok) continue;
      for (const secret of c.sensitive) expect(out.message, `${name}: ${out.message}`).not.toContain(secret);
    }
  });

  it.runIf(!!c.lookup)("finds an interrupted post with lookup(), and reports one it can't find (M5 P5)", async () => {
    const l = c.lookup!;
    const found = await attempt(() => adapterFor(platform).lookup!(trackedJob(l.job())), l.found);
    expect(found).toEqual({ ok: true, value: expect.objectContaining(l.expect) });
    const missing = await attempt(() => adapterFor(platform).lookup!(trackedJob(l.job())), l.notFound);
    if (l.notFoundAnswer === "unknown") expect(missing).toEqual({ ok: true, value: null });
    else expect(missing).toEqual({ ok: true, value: expect.objectContaining({ published: false }) });
  });
});
