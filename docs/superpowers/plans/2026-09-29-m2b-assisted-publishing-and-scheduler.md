# M2b — Assisted Publishing, Scheduler and Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click posting everywhere: a pre-filled compose page plus clipboard for every platform, a 3-step assisted publish flow that captures the live URL, a scheduler that runs deliveries on time, never twice and never silently late, a publish orchestrator (retry and error classes) ready for the M5/M6 adapters, desktop reminders, an actionable Overdue tray, a keyboard/mobile path to move posts, and a README that gets a new user to their first assisted post.

**Architecture:** `platforms/<name>/assisted.ts` builds each platform's pre-filled URL and clipboard steps. `publish/` holds the clipboard service, live-URL validation, delivery transitions for the assisted path, the `PublishOrchestrator` (claims `publishing` + timestamp before any network call, classifies errors, retries transient ones) and `PublishActions`, the context service the UI and the scheduler call. `scheduler/` is a 30-second loop with startup reconciliation, gated by an injectable `isPublisher()`. `reminders/` turns reminder offsets into deduplicated desktop notifications. Every delivery write goes through `SafeWriter.updateVariant` against fresh frontmatter.

**Tech Stack:** TypeScript 5.9 (strict), Svelte 5 (runes), Obsidian API 1.13 (`Notice`, `Menu`, `loadLocalStorage`, `registerDomEvent`), browser APIs (`navigator.clipboard`, `ClipboardItem`, `window.open`, `Notification`, `navigator.share`), Vitest 5 (jsdom) with fake timers.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§3 view 6 Assisted publish, §4 architecture, §4.1 adapter interface, §4.2 platform matrix, §4.3 publisher device, §4.4 desktop reminders, §5 lifecycle and reliability). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z (artboards 1 Calendar/Overdue tray, 3 Composer, 6 Assisted publish).

**Depends on:** M2a (`docs/superpowers/plans/2026-09-29-m2a-platforms-and-composer.md`) completed on the same branch `feat/m2-one-click-posting`.

**Issues covered:** #54 epic — #55 (Task 2), #56 (Task 3), #57 (Task 5), #58 (Task 4) · #59 epic — #60 (Task 7), #61 (Task 8), #62 (Task 6), #63 (Task 10), #64 (Task 9) · #52 Post now and Copy & open (Tasks 5 and 10) · #113 (Task 11) · #109 (Task 12). Task 1 closes the parked M1 item on unreadable delivery entries; Task 10 closes the parked items on drops onto past times and on schedule templates.

**Verified:** the code of Tasks 1–11 (on top of M2a) was applied in order to a scratch copy of `dev` while writing this plan: `npm test` (747 tests), `npm run typecheck`, `npm run lint` and the production build all pass. Line-level edits ("in X, replace … with …") refer to the file as the previous tasks leave it.

## Global Constraints

- All M1 and M2a constraints apply (SafeWriter for every frontmatter write, `transition()` for every status change, fresh-frontmatter plans inside `updateVariant`, per-key delivery patches, Notices and Undo, real controls, `setIcon`, no emoji, Obsidian CSS variables, `TZ=Europe/Berlin`).
- **Never write a whole `deliveries` map.** Every delivery write is a per-key patch computed against fresh frontmatter (`SafeWriter.updateVariant`, `updateDeliveries`, `transitionDelivery`).
- **Lifecycle (spec §5).** `scheduled → published` is illegal: the assisted path goes `scheduled → awaiting_you → published`, the API path `scheduled → publishing → published | failed`. `publishing` and a timestamp (`at`) are written **before** any network call.
- **Never auto-retry `publishing`.** A delivery found in `publishing` at startup becomes `check_needed`; `lookup()` resolves it where an adapter supports it, otherwise the user confirms.
- **No silent late posting.** A due delivery is dispatched only if it is at most `GRACE_MS` (2 minutes) late, or, when the "Post late items automatically" setting is on (default **off**, N = **15** minutes), at most N minutes late. Anything later becomes `overdue` and waits in the Overdue tray (Post now / Reschedule / Skip).
- **Error classes (spec §5.3).** Transient: retried after 1, 5 and 15 minutes (or the server's `Retry-After`, if longer), then `failed`. NeedsUser: `failed` at once and a notification with a **Fix** action. InvalidContent: blocked at schedule time by the M2a checks; if a platform still rejects content, it is `failed` at once like NeedsUser. Error text is redacted with `Secrets.redact` before it is stored or shown.
- **Only the publisher device runs deliveries (spec §4.3).** The publisher-device setting is M3 (#26). In M2 the `Scheduler` takes an injectable `isPublisher(): boolean`; `main.ts` passes `() => true` with a comment pointing to #26. When it returns false, the scheduler neither dispatches, nor marks overdue, nor reconciles; desktop reminders still fire on every device where they are enabled.
- **Unreadable delivery entries are frozen** (parked M1 item). An entry whose status can't be parsed (e.g. `Handed-Over`) is never dispatched, marked overdue, marked published or overwritten by a board schedule; checks report it as blocking.
- **No real network in tests and no real adapters in M2.** API adapters arrive in M5/M6. The orchestrator is fully implemented and tested with fake `PlatformAdapter`s; the plugin's `AdapterRegistry` stays empty, so the assisted flow is the only real publish path in M2.
- **Browser APIs are faked in tests** by `test/fakes/browser.ts` (clipboard, `ClipboardItem`, `window.open`, `Notification`, `document.hasFocus`), installed and reset in `test/setup.ts` (Task 3).
- `Social/_log.md` and ntfy phone reminders are M3: M2 records attempts through an `AttemptLog` interface with an in-memory implementation.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A delivery entry with a typo'd status** (`status: Handed-Over`) on a post whose time comes, or that the board schedules. It must never be published, marked overdue or overwritten, and the user should be told what to fix. Tests in Tasks 1 and 7.
2. **Obsidian quitting in the middle of a publish,** which leaves a delivery in `publishing`. At the next start it should become `check_needed`, never be retried automatically, and be resolved by `lookup()` when an adapter offers it. Test in Task 8.
3. **A laptop asleep across a post's due time.** When the scheduler wakes up, the post should become overdue instead of going out late, unless it is within the 2-minute grace or the optional auto-post window. Test in Task 7.
4. **A pasted live URL that is wrong** (another platform's link, plain text, `http` without a host, the Mastodon instance of someone else). It should be refused with an explanation, and nothing should be written. Tests in Task 4.
5. **The same reminder evaluated on several ticks, after a restart or after a snooze.** Exactly one notification should appear per reminder, plus one after each snooze. Tests in Task 9.

---

## File Structure

```
src/publish/eligibility.ts        unreadable(), effectiveDelivery()
src/platforms/share.ts            enc(), imageItems(), textItems(), mastodonInstance(), siteHost(), subreddit()
src/platforms/<platform>/assisted.ts  one builder per platform (13)
src/publish/assisted.ts           ASSISTED registry, assistedJob(), assistedTarget()
src/publish/clipboard.ts          ClipboardService, browserClipboard(), isMobile()
src/publish/liveUrl.ts            expectedHosts(), validateLiveUrl()
src/publish/transitions.ts        toAwaiting(), toPublished(), toSkipped()
src/publish/log.ts                AttemptEntry, AttemptLog, MemoryLog
src/publish/actions.ts            PublishActions (context service `publish`)
src/publish/assistedFlow.ts       assistedQueue()
src/publish/AssistedFlow.svelte   3-step assisted publish modal
src/publish/semaphore.ts          Semaphore (per-platform concurrency)
src/publish/orchestrator.ts       PublishOrchestrator, BACKOFF_MS, RunResult, FailureInfo
src/scheduler/due.ts              GRACE_MS, DueItem, dueItems(), decide()
src/scheduler/scheduler.ts        Scheduler, SchedulerPort, SchedulerDeps
src/scheduler/reconcile.ts        reconcilePlan()
src/reminders/reminders.ts        ReminderItem, dueReminders()
src/reminders/ledger.ts           NotifiedLedger (device-local dedupe)
src/reminders/notifier.ts         Notifier (in-app notice + system notification)
src/reminders/service.ts          ReminderService
src/ui/longpress.ts               `use:longpress` action
docs/qa/assisted-urls.md, docs/qa/m2b.md, docs/getting-started.md, README.md
test/fakes/browser.ts
```

Modified: `src/model/types.ts` (`Variant.invalidDeliveries`, `Delivery.reason`), `src/model/frontmatter.ts`, `src/model/writer.ts` (`DELIVERY_KEYS`), `src/index/queries.ts` (`channelRowStatus`), `src/planner/board.ts`, `src/planner/templates.ts` (`planTemplateMove`), `src/platforms/types.ts` (assisted types), `src/composer/actions.ts`, `src/composer/ActionsBar.svelte`, `src/ui/actions.ts` (past-time confirm, `pickTime`, `rowMenu`, `keyMenu`), `src/ui/context.ts` (`publish`), `src/views/Sidebar.svelte`, `src/views/Chip.svelte`, `src/views/BoardView.svelte`, `src/views/ListView.svelte`, `src/settings/settings.ts`, `src/settings/device.ts`, `src/settings/tab.ts`, `src/main.ts`, `test/setup.ts`, `test/fakes/obsidian.ts`, `test/ui/ctx.ts`, `test/main.test.ts`.

---

### Task 1: Unreadable delivery entries are frozen for publishing (parked M1 item)

**Files:**
- Create: `src/publish/eligibility.ts`, `test/publish/eligibility.test.ts`
- Modify: `src/model/types.ts` (`Variant.invalidDeliveries`), `src/model/frontmatter.ts` (`parseDeliveries`, `parseVariant`), `src/index/queries.ts` (`channelRowStatus`), `src/planner/board.ts` (`scheduleDeliveries`), `src/composer/actions.ts` (`check`), `test/ui/freshWrites.test.ts`

**Interfaces:**
- Consumes: `expandRows`, `RowStatus` (`src/index/queries.ts`); `Variant`, `Delivery`.
- Produces:
  - `Variant.invalidDeliveries?: string[]` — ids of `deliveries:` entries that exist but can't be read (not a map, or an unknown `status`). Set only when non-empty.
  - `channelRowStatus(v, channelId): RowStatus` — the status one listed channel shows (exactly what `expandRows` puts on the row; `expandRows` now uses it).
  - `unreadable(v, channelId): boolean`; `effectiveDelivery(v: Variant, channelId): Delivery | null` — the channel's record, or `{ status }` from its row status; `null` when the channel is not listed, its entry is unreadable, or the post is still an idea. Every publish-side write in this plan starts from it.
  - `scheduleDeliveries(v)` leaves unreadable entries alone (the board no longer overwrites a typo'd `Handed-Over` with `scheduled`).
  - `ComposerActions.check` adds a blocking issue `code: "unreadable-delivery"` per unreadable channel.

- [ ] **Step 1: Write the failing tests**

`test/publish/eligibility.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { channelRowStatus } from "../../src/index/queries";
import { parseVariant } from "../../src/model/frontmatter";
import type { Variant } from "../../src/model/types";
import { scheduleDeliveries } from "../../src/planner/board";
import { effectiveDelivery, unreadable } from "../../src/publish/eligibility";
import { makeCtx } from "../ui/ctx";

const base = { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme", "li/maker"], status: "scheduled", scheduled_at: "2026-10-12T09:00:00+02:00" };
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "scheduled",
  scheduledAt: 1,
  media: [],
  deliveries: {},
  ...extra,
});

describe("unreadable delivery entries", () => {
  it("are listed by the parser", () => {
    const r = parseVariant({ ...base, deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "Handed-Over" }, "li/maker": "oops" } }, "p.md");
    expect(r.value?.invalidDeliveries).toEqual(["li/acme", "li/maker"]);
    expect(r.value?.deliveries).toEqual({ "li/me": { status: "scheduled" } });
    expect(parseVariant({ ...base, deliveries: { "li/me": { status: "scheduled" } } }, "p.md").value?.invalidDeliveries).toBeUndefined();
  });

  it("are never scheduled over by the board", () => {
    const post = v({ status: "draft", invalidDeliveries: ["li/acme"] });
    expect(scheduleDeliveries(post)).toEqual({ "li/me": { status: "scheduled" } });
  });

  it("have no effective delivery", () => {
    expect(unreadable(v({ invalidDeliveries: ["li/acme"] }), "li/acme")).toBe(true);
    expect(effectiveDelivery(v({ invalidDeliveries: ["li/acme"] }), "li/acme")).toBeNull();
  });
});

describe("effectiveDelivery", () => {
  it.each([
    ["its own record", v({ deliveries: { "li/me": { status: "awaiting_you", at: 5 } } }), "li/me", { status: "awaiting_you", at: 5 }],
    ["the inherited status when siblings have records", v({ deliveries: { "li/me": { status: "published" } } }), "li/acme", { status: "scheduled" }],
    ["the stored status without records", v({ status: "published" }), "li/me", { status: "published" }],
    ["attention without records reads as failed", v({ status: "attention" }), "li/me", { status: "failed" }],
    ["nothing for an idea", v({ status: "idea" }), "li/me", null],
    ["nothing for a channel that is not listed", v(), "li/other", null],
  ])("%s", (_name, post, id, expected) => {
    expect(effectiveDelivery(post, id)).toEqual(expected);
  });

  it("matches the row statuses of the index", async () => {
    const { ctx } = await makeCtx({ seed: true });
    for (const row of ctx.actions.rows().filter((r) => r.channelId)) {
      expect(channelRowStatus(row.variant, row.channelId!)).toBe(row.status);
    }
  });
});

describe("checks", () => {
  it("block a post with an unreadable entry", async () => {
    const path = "Social/Posts/Typo.md";
    const { ctx, index } = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { ...base, channels: ["li/me", "li/acme-studio"], deliveries: { "li/acme-studio": { status: "Handed-Over" } } }, body: "Hi" }],
    });
    const post = index.getVariant(path)!;
    const issues = ctx.composer.check(post, await ctx.composer.content.load(post));
    expect(issues).toContainEqual({
      level: "error",
      field: "deliveries.li/acme-studio",
      code: "unreadable-delivery",
      message: "Fix the delivery status of Acme Studio in the note: it can't be read, so it won't be published.",
    });
  });
});
```

Add to `test/ui/freshWrites.test.ts`, inside `describe("UI writes against fresh frontmatter (G1)", …)`:
```ts
  it("board schedule never overwrites an unreadable delivery entry (parked M1 item)", async () => {
    const c = await makeCtx({ notes: [p1({ status: "draft" }, "draft")] });
    const v = c.index.getVariant(P1)!;
    await c.ctx.actions.schedule(v, T + DAY);
    const fm = await fmOf(c, P1);
    expect(fm.deliveries).toEqual({
      "li/me": { status: "scheduled" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/publish/eligibility.test.ts test/ui/freshWrites.test.ts`
Expected: FAIL — `eligibility` missing; `invalidDeliveries` undefined; the board overwrites `li/acme`.

- [ ] **Step 3: Record unreadable entries in the model**

In `src/model/types.ts`, add to `interface Variant` after `deliveries: Record<string, Delivery>;`:
```ts
  /** Ids of delivery entries that exist but can't be read (e.g. a typo'd status). They are frozen: never published or overwritten. */
  invalidDeliveries?: string[];
```

In `src/model/frontmatter.ts`, replace `parseDeliveries` with:
```ts
function parseDeliveries(raw: unknown, channels: string[], issues: Issue[], invalid: string[]): Record<string, Delivery> {
  const deliveries: Record<string, Delivery> = {};
  if (isBlank(raw)) return deliveries;
  if (!isRecord(raw)) {
    issues.push({ level: "warning", field: "deliveries", message: "deliveries must be a map of channel id → delivery" });
    return deliveries;
  }
  for (const [id, value] of Object.entries(raw)) {
    const field = `deliveries.${id}`;
    if (!isRecord(value)) {
      issues.push({ level: "warning", field, message: "Delivery must be an object" });
      invalid.push(id);
      continue;
    }
    const status = take(zDeliveryStatus, value.status, `${field}.status`, issues, "warning");
    if (!status) {
      invalid.push(id);
      continue;
    }
    const d: Delivery = { status };
    const at = takeDate(value.at, `${field}.at`, issues);
    if (at !== undefined) d.at = at;
    if (typeof value.url === "string" && value.url) d.url = value.url;
    if (!isBlank(value.remote_id)) d.remoteId = String(value.remote_id);
    if (typeof value.error === "string" && value.error) d.error = value.error;
    const attempts = take(zCount, value.attempts, `${field}.attempts`, issues, "warning");
    if (attempts !== undefined) d.attempts = attempts;
    if (!channels.includes(id)) {
      issues.push({ level: "warning", field, message: `Delivery for ${id}, which is not in channels` });
    }
    deliveries[id] = d;
  }
  return deliveries;
}
```
In `parseVariant`:
- before `const variant: Variant = {`, add `const invalidDeliveries: string[] = [];`
- change `deliveries: parseDeliveries(fm.deliveries, channels, issues),` to `deliveries: parseDeliveries(fm.deliveries, channels, issues, invalidDeliveries),`
- right after the `mediaMeta` lines (before `if (platform === "wordpress") {`), add:
```ts
  if (invalidDeliveries.length) variant.invalidDeliveries = invalidDeliveries;
```

In `src/index/queries.ts`:
- change `function missingChannelStatus(v: IndexedVariant): RowStatus {` to `function missingChannelStatus(v: Pick<IndexedVariant, "status" | "scheduledAt">): RowStatus {`
- add, after `missingChannelStatus`:
```ts
/** The status one listed channel shows as a row: its record, else what it inherits (exactly what expandRows uses). */
export function channelRowStatus(v: Pick<IndexedVariant, "channels" | "deliveries" | "status" | "scheduledAt">, channelId: string): RowStatus {
  const own = v.deliveries[channelId];
  if (own) return own.status;
  const hasRecords = v.channels.some((c) => v.deliveries[c] !== undefined);
  return hasRecords ? missingChannelStatus(v) : storedStatusToRow(v.status);
}
```
- in `expandRows`, replace the per-channel loop body's `status: v.deliveries[id]?.status ?? missing,` with `status: channelRowStatus(v, id),` and delete the three lines above the loop that are now unused (the `// Without records for listed channels…` comment and the `hasRecords` and `missing` constants).

In `src/planner/board.ts`, replace `scheduleDeliveries` with:
```ts
export function scheduleDeliveries(v: Pick<Variant, "channels" | "deliveries" | "invalidDeliveries">): Record<string, Delivery> {
  const out: Record<string, Delivery> = { ...v.deliveries };
  for (const id of v.channels) {
    // An unreadable entry (typo'd status) is frozen: writing `scheduled` over it could publish it twice.
    if (v.invalidDeliveries?.includes(id)) continue;
    const current = out[id] ?? { status: "draft" as const };
    if (canTransition(current.status, "scheduled")) out[id] = transition(current, "scheduled");
  }
  return out;
}
```

- [ ] **Step 4: Add the eligibility helpers and the blocking check**

`src/publish/eligibility.ts`:
```ts
import { channelRowStatus } from "../index/queries";
import type { Delivery, Variant } from "../model/types";

export function unreadable(v: Pick<Variant, "invalidDeliveries">, channelId: string): boolean {
  return v.invalidDeliveries?.includes(channelId) ?? false;
}

/**
 * The delivery a listed channel effectively has: its own record, or the status its row shows.
 * Null when it must not be touched: not listed, unreadable (frozen), or the post is still an idea.
 */
export function effectiveDelivery(v: Variant, channelId: string): Delivery | null {
  if (!v.channels.includes(channelId) || unreadable(v, channelId)) return null;
  const status = channelRowStatus(v, channelId);
  if (status === "idea") return null;
  return v.deliveries[channelId] ?? { status };
}
```

In `src/composer/actions.ts`, replace `check` with:
```ts
  check(v: Variant, content: LoadedContent): Issue[] {
    const issues = validateAll({ variant: v, body: content.body, media: content.media }, this.channelsOf(v));
    const frozen: Issue[] = (v.invalidDeliveries ?? [])
      .filter((id) => v.channels.includes(id))
      .map((id) => ({
        level: "error",
        field: `deliveries.${id}`,
        code: "unreadable-delivery",
        message: `Fix the delivery status of ${this.deps.channels.get(id)?.name ?? id} in the note: it can't be read, so it won't be published.`,
      }));
    return [...frozen, ...issues];
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (whole suite; `expandRows` behaves as before).

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "fix(model): freeze unreadable delivery entries for publishing and board scheduling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Pre-filled compose and submit URLs for every platform (#55)

**Files:**
- Create: `src/platforms/share.ts`, `src/platforms/{linkedin,x,instagram,facebook,mastodon,bluesky,telegram,discord,hackernews,indiehackers,reddit,whatsapp,wordpress}/assisted.ts`, `src/publish/assisted.ts`, `test/publish/assisted.test.ts`, `docs/qa/assisted-urls.md`
- Modify: `src/platforms/types.ts` (assisted types)

**Interfaces:**
- Consumes: `postItems` (M2a Task 2); `platformDef` (M2a Task 1); `LoadedContent` (M2a Task 8); `MediaInfo`.
- Produces:
  - `type ClipItem = { label: string; text: string } | { label: string; imagePath: string }`; `interface AssistedTarget { url: string | null; mobileUrl?: string; clipboard: ClipItem[]; hint: string }` — `clipboard[0]` is what gets copied when the page opens; `interface AssistedJob { variant; channel; text; items; media }`; `type AssistedBuilder = (job: AssistedJob) => AssistedTarget` (the spec's `assistedUrl()`, returning the page plus the clipboard steps).
  - `enc`, `imageItems(job)`, `threadItems(items)`, `hostOf(value?)`, `mastodonInstance(handle?)`, `subreddit(handle?)` in `src/platforms/share.ts`.
  - One `assisted.ts` per platform folder exporting `assisted: AssistedBuilder`.
  - `ASSISTED: Record<Platform, AssistedBuilder>`, `assistedJob(variant, channel, content): AssistedJob` (media dropped on platforms that show none), `assistedTarget(job): AssistedTarget` (appends "Then add the image(s)." when images must be added by hand).

- [ ] **Step 1: Write the failing test**

`test/publish/assisted.test.ts`:
```ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META, type Platform } from "../../src/model/platforms";
import type { Channel, Variant } from "../../src/model/types";
import type { AssistedBuilder, MediaInfo } from "../../src/platforms/types";
import { hostOf, mastodonInstance, subreddit } from "../../src/platforms/share";
import { ASSISTED, assistedJob, assistedTarget } from "../../src/publish/assisted";
import { channel, img, input } from "../platforms/fixtures";

const folders = import.meta.glob<{ assisted: AssistedBuilder }>("../../src/platforms/*/assisted.ts", { eager: true });

function target(platform: Platform, body: string, extra: Partial<Variant> = {}, ch: Partial<Channel> & { id?: string } = {}, media: MediaInfo[] = []) {
  const { id, ...rest } = ch;
  const c = channel(id ?? `${PLATFORM_META[platform].prefix}/you`, rest);
  return assistedTarget(assistedJob(input(platform, body, extra, media).variant, c, { body, media }));
}

describe("assisted builders", () => {
  it("exist for every platform, one per folder", () => {
    expect(Object.keys(folders)).toHaveLength(PLATFORMS.length);
    for (const p of PLATFORMS) expect(typeof ASSISTED[p]).toBe("function");
  });

  it("encodes newlines, emoji, # and &", () => {
    expect(target("x", "Line 1\nLine 2 #launch & more 🎉").url).toBe(
      "https://x.com/intent/post?text=Line%201%0ALine%202%20%23launch%20%26%20more%20%F0%9F%8E%89",
    );
  });

  it.each([
    ["LinkedIn profile", target("linkedin", "Hello world"), "https://www.linkedin.com/feed/?shareActive=true&text=Hello%20world", ["Post text"]],
    [
      "LinkedIn page with its company URL",
      target("linkedin", "Hi", {}, { id: "li/acme-studio", name: "Acme Studio", kind: "page", handle: "https://www.linkedin.com/company/acme-studio/" }),
      "https://www.linkedin.com/company/acme-studio/admin/page-posts/published/?share=true",
      ["Post text"],
    ],
    ["LinkedIn page without a handle", target("linkedin", "Hi", {}, { name: "Acme Studio", kind: "page" }), "https://www.linkedin.com/feed/", ["Post text"]],
    ["X thread", target("x", "One\n---\nTwo"), "https://x.com/intent/post?text=One", ["Post text", "Reply 2"]],
    ["Bluesky", target("bluesky", "Hi & bye"), "https://bsky.app/intent/compose?text=Hi%20%26%20bye", ["Post text"]],
    ["Mastodon on its instance", target("mastodon", "Toot", {}, { handle: "@you@mastodon.social" }), "https://mastodon.social/share?text=Toot", ["Post text"]],
    ["Mastodon without an instance", target("mastodon", "Toot"), null, ["Post text"]],
    ["Instagram", target("instagram", "Caption", {}, {}, [img("a.png")]), "https://www.instagram.com/", ["Caption", "Image 1"]],
    [
      "Facebook link share",
      target("facebook", "Hi", { url: "https://example.com/event-x" }),
      "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexample.com%2Fevent-x",
      ["Post text"],
    ],
    ["Telegram with a link", target("telegram", "Doors open", { url: "https://example.com" }), "https://t.me/share/url?url=https%3A%2F%2Fexample.com&text=Doors%20open", ["Post text"]],
    ["Telegram text only", target("telegram", "Doors open"), "https://t.me/share/url?url=Doors%20open", ["Post text"]],
    ["WhatsApp", target("whatsapp", "**Event X** 18:00"), "https://wa.me/?text=*Event%20X*%2018%3A00", ["Message"]],
    [
      "Discord channel link",
      target("discord", "Hey", {}, { handle: "https://discord.com/channels/1/2" }),
      "https://discord.com/channels/1/2",
      ["Message"],
    ],
    [
      "Hacker News link",
      target("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" }),
      "https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fexample.com&t=Show%20HN%3A%20OSMM",
      ["Title"],
    ],
    ["Hacker News text", target("hackernews", "Ask away", { title: "Ask HN: Planning?" }), "https://news.ycombinator.com/submit", ["Title", "Text"]],
    [
      "Reddit link",
      target("reddit", "", { title: "Hello", url: "https://example.com" }, { handle: "r/SideProject" }),
      "https://www.reddit.com/r/SideProject/submit?title=Hello&url=https%3A%2F%2Fexample.com",
      ["Title"],
    ],
    [
      "Reddit text",
      target("reddit", "Body text", { title: "Hello" }, { handle: "r/SideProject" }),
      "https://www.reddit.com/r/SideProject/submit?selftext=true&title=Hello&text=Body%20text",
      ["Title", "Text"],
    ],
    ["Indie Hackers", target("indiehackers", "Building in public.", { title: "Launch" }), "https://www.indiehackers.com/new-post", ["Title", "Text"]],
    ["WordPress", target("wordpress", "# Hi\n\nBody", { title: "Hi" }, { handle: "eventx.berlin" }), "https://eventx.berlin/wp-admin/post-new.php", ["Title", "Article"]],
  ])("%s", (_name, t, url, labels) => {
    expect(t.url).toBe(url);
    expect(t.clipboard.map((c) => c.label)).toEqual(labels);
    expect(t.hint.length).toBeGreaterThan(0);
  });

  it("puts the thread parts and images on the clipboard in order", () => {
    const t = target("bluesky", "One\n---\nTwo\n---\nThree", {}, {}, [img("a.png"), img("b.png")]);
    expect(t.clipboard).toEqual([
      { label: "Post text", text: "One" },
      { label: "Reply 2", text: "Two" },
      { label: "Reply 3", text: "Three" },
      { label: "Image 1", imagePath: "Social/a.png" },
      { label: "Image 2", imagePath: "Social/b.png" },
    ]);
    expect(t.hint).toBe("Post the first part, then reply to it with parts 2 to 3. Then add the 2 images.");
  });

  it("offers the Instagram app on phones and drops media where the platform shows none", () => {
    expect(target("instagram", "Caption", {}, {}, [img()]).mobileUrl).toBe("instagram://camera");
    expect(target("hackernews", "", { title: "T", url: "https://example.com" }, {}, [img()]).clipboard.map((c) => c.label)).toEqual(["Title"]);
  });
});

describe("share helpers", () => {
  it.each([
    ["@you@mastodon.social", "mastodon.social"],
    ["https://fosstodon.org/@you", "fosstodon.org"],
    ["@you", null],
    [undefined, null],
  ])("mastodonInstance(%s) = %s", (handle, expected) => {
    expect(mastodonInstance(handle)).toBe(expected);
  });

  it("reads hosts and subreddits", () => {
    expect(hostOf("eventx.berlin")).toBe("eventx.berlin");
    expect(hostOf("https://www.eventx.berlin/blog")).toBe("eventx.berlin");
    expect(hostOf("not a host")).toBeNull();
    expect(subreddit("r/SideProject")).toBe("SideProject");
    expect(subreddit("https://www.reddit.com/r/obsidianmd/")).toBe("obsidianmd");
    expect(subreddit("SideProject")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/publish/assisted.test.ts`
Expected: FAIL — `share` and `assisted` modules missing.

- [ ] **Step 3: Add the assisted types and the shared helpers**

Append to `src/platforms/types.ts`:
```ts
/** One thing for the user to paste: text, or an image file from the vault. */
export type ClipItem = { label: string; text: string } | { label: string; imagePath: string };

/** What the assisted flow opens and copies for one delivery (the spec's assistedUrl, plus the clipboard steps). */
export interface AssistedTarget {
  /** Pre-filled compose or submit page; null when there is none to open. */
  url: string | null;
  /** App deep link used on phones instead of `url`. */
  mobileUrl?: string;
  /** What to paste, in order; the first item is copied when the page opens. */
  clipboard: ClipItem[];
  /** One short instruction for the page. */
  hint: string;
}

export interface AssistedJob {
  variant: Variant;
  channel: Channel;
  /** The whole post as the platform receives it. */
  text: string;
  items: string[];
  media: MediaInfo[];
}

export type AssistedBuilder = (job: AssistedJob) => AssistedTarget;
```

`src/platforms/share.ts`:
```ts
import type { AssistedJob, ClipItem } from "./types";

export const enc = encodeURIComponent;

export function imageItems(job: AssistedJob): ClipItem[] {
  return job.media
    .filter((m) => m.kind === "image" && m.path)
    .map((m, i) => ({ label: `Image ${i + 1}`, imagePath: m.path! }));
}

/** The first thread item as the post, the others as replies. */
export function threadItems(items: readonly string[]): ClipItem[] {
  return items.map((text, i) => ({ label: i === 0 ? "Post text" : `Reply ${i + 1}`, text }));
}

export function threadHint(items: readonly string[], single: string): string {
  if (items.length < 2) return single;
  return `Post the first part, then reply to it with ${items.length === 2 ? "part 2" : `parts 2 to ${items.length}`}.`;
}

/** "eventx.berlin", "https://www.eventx.berlin/blog" → "eventx.berlin"; null unless it looks like a domain. */
export function hostOf(value?: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** "@you@mastodon.social" or "https://fosstodon.org/@you" → the instance host. */
export function mastodonInstance(handle?: string): string | null {
  const at = /^@?[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(handle?.trim() ?? "");
  return at ? at[1]!.toLowerCase() : hostOf(handle);
}

/** "r/SideProject" or "https://www.reddit.com/r/SideProject/" → "SideProject". */
export function subreddit(handle?: string): string | null {
  return /(?:^|\/)r\/([A-Za-z0-9_]{2,21})\/?$/.exec(handle?.trim() ?? "")?.[1] ?? null;
}
```

- [ ] **Step 4: Write the 13 builders**

`src/platforms/linkedin/assisted.ts`:
```ts
import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

const COMPANY_RE = /(?:company\/)?([A-Za-z0-9-]+)\/?$/;

export const assisted: AssistedBuilder = (job) => {
  const clipboard = [{ label: "Post text", text: job.text }, ...imageItems(job)];
  if (job.channel.kind === "page") {
    const company = job.channel.handle ? COMPANY_RE.exec(job.channel.handle.trim())?.[1] : undefined;
    return company
      ? { url: `https://www.linkedin.com/company/${company}/admin/page-posts/published/?share=true`, clipboard, hint: `Paste the text into ${job.channel.name}'s post box and post.` }
      : { url: "https://www.linkedin.com/feed/", clipboard, hint: `Switch to ${job.channel.name} (Me, then Pages), start a post and paste the text.` };
  }
  return { url: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(job.text)}`, clipboard, hint: "Check the pre-filled text and post." };
};
```

`src/platforms/x/assisted.ts`:
```ts
import { enc, imageItems, threadHint, threadItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: `https://x.com/intent/post?text=${enc(job.items[0] ?? "")}`,
  clipboard: [...threadItems(job.items), ...imageItems(job)],
  hint: threadHint(job.items, "Check the pre-filled text and post."),
});
```

`src/platforms/bluesky/assisted.ts`:
```ts
import { enc, imageItems, threadHint, threadItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: `https://bsky.app/intent/compose?text=${enc(job.items[0] ?? "")}`,
  clipboard: [...threadItems(job.items), ...imageItems(job)],
  hint: threadHint(job.items, "Check the pre-filled text and post."),
});
```

`src/platforms/mastodon/assisted.ts`:
```ts
import { enc, imageItems, mastodonInstance, threadHint, threadItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const instance = mastodonInstance(job.channel.handle);
  return {
    url: instance ? `https://${instance}/share?text=${enc(job.items[0] ?? "")}` : null,
    clipboard: [...threadItems(job.items), ...imageItems(job)],
    hint: instance
      ? threadHint(job.items, "Check the pre-filled text and post.")
      : "Set this channel's handle to @you@your.instance so the right server opens; for now, paste the text into a new post.",
  };
};
```

`src/platforms/instagram/assisted.ts`:
```ts
import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: "https://www.instagram.com/",
  mobileUrl: "instagram://camera",
  clipboard: [{ label: "Caption", text: job.text }, ...imageItems(job)],
  hint: "Instagram has no web composer: create the post in the app and paste the caption.",
});
```

`src/platforms/facebook/assisted.ts`:
```ts
import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

const PAGE_RE = /([A-Za-z0-9.]+)\/?$/;

export const assisted: AssistedBuilder = (job) => {
  const page = job.channel.handle ? PAGE_RE.exec(job.channel.handle.trim())?.[1] : undefined;
  const url = job.variant.url
    ? `https://www.facebook.com/sharer/sharer.php?u=${enc(job.variant.url)}`
    : page
      ? `https://www.facebook.com/${page}`
      : "https://www.facebook.com/";
  return { url, clipboard: [{ label: "Post text", text: job.text }, ...imageItems(job)], hint: "Facebook can't pre-fill text: paste it into the post box." };
};
```

`src/platforms/telegram/assisted.ts`:
```ts
import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: job.variant.url ? `https://t.me/share/url?url=${enc(job.variant.url)}&text=${enc(job.text)}` : `https://t.me/share/url?url=${enc(job.text)}`,
  clipboard: [{ label: "Post text", text: job.text }, ...imageItems(job)],
  hint: `Pick ${job.channel.name} and send.`,
});
```

`src/platforms/whatsapp/assisted.ts`:
```ts
import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: `https://wa.me/?text=${enc(job.text)}`,
  clipboard: [{ label: "Message", text: job.text }, ...imageItems(job)],
  hint: `Pick ${job.channel.name} and send.`,
});
```

`src/platforms/discord/assisted.ts`:
```ts
import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const handle = job.channel.handle?.trim() ?? "";
  return {
    url: handle.startsWith("https://discord.com/channels/") ? handle : "https://discord.com/channels/@me",
    clipboard: [{ label: "Message", text: job.text }, ...imageItems(job)],
    hint: `Open ${job.channel.name} and paste the message.`,
  };
};
```

`src/platforms/hackernews/assisted.ts`:
```ts
import { enc } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const title = job.variant.title ?? "";
  if (job.variant.url) {
    return {
      url: `https://news.ycombinator.com/submitlink?u=${enc(job.variant.url)}&t=${enc(title)}`,
      clipboard: [{ label: "Title", text: title }, ...(job.text ? [{ label: "First comment", text: job.text }] : [])],
      hint: job.text ? "Submit, then add the text as the first comment." : "Check the title and submit.",
    };
  }
  return {
    url: "https://news.ycombinator.com/submit",
    clipboard: [
      { label: "Title", text: title },
      { label: "Text", text: job.text },
    ],
    hint: "Paste the title and the text, then submit.",
  };
};
```

`src/platforms/reddit/assisted.ts`:
```ts
import { enc, imageItems, subreddit } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const sub = subreddit(job.channel.handle);
  const base = sub ? `https://www.reddit.com/r/${sub}/submit` : "https://www.reddit.com/submit";
  const title = job.variant.title ?? "";
  const url = job.variant.url
    ? `${base}?title=${enc(title)}&url=${enc(job.variant.url)}`
    : `${base}?selftext=true&title=${enc(title)}&text=${enc(job.text)}`;
  return {
    url,
    clipboard: [{ label: "Title", text: title }, ...(job.text ? [{ label: "Text", text: job.text }] : []), ...imageItems(job)],
    hint: sub ? "Check the title and post." : "Pick the subreddit, check the title and post.",
  };
};
```

`src/platforms/indiehackers/assisted.ts`:
```ts
import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: "https://www.indiehackers.com/new-post",
  clipboard: [
    { label: "Title", text: job.variant.title ?? "" },
    { label: "Text", text: job.text },
    ...imageItems(job),
  ],
  hint: "Paste the title and the text into the new post.",
});
```

`src/platforms/wordpress/assisted.ts`:
```ts
import { hostOf, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const site = hostOf(job.channel.handle);
  return {
    url: site ? `https://${site}/wp-admin/post-new.php` : null,
    clipboard: [
      { label: "Title", text: job.variant.title ?? "" },
      { label: "Article", text: job.text },
      ...imageItems(job),
    ],
    hint: site ? "Paste the title and the article, then publish or schedule it." : "Set this channel's handle to the site's domain; then paste the title and the article.",
  };
};
```

`src/publish/assisted.ts`:
```ts
import type { LoadedContent } from "../composer/content";
import type { Platform } from "../model/platforms";
import type { Channel, Variant } from "../model/types";
import { assisted as bluesky } from "../platforms/bluesky/assisted";
import { assisted as discord } from "../platforms/discord/assisted";
import { assisted as facebook } from "../platforms/facebook/assisted";
import { assisted as hackernews } from "../platforms/hackernews/assisted";
import { assisted as indiehackers } from "../platforms/indiehackers/assisted";
import { assisted as instagram } from "../platforms/instagram/assisted";
import { assisted as linkedin } from "../platforms/linkedin/assisted";
import { assisted as mastodon } from "../platforms/mastodon/assisted";
import { assisted as reddit } from "../platforms/reddit/assisted";
import { assisted as telegram } from "../platforms/telegram/assisted";
import { assisted as whatsapp } from "../platforms/whatsapp/assisted";
import { assisted as wordpress } from "../platforms/wordpress/assisted";
import { assisted as x } from "../platforms/x/assisted";
import { platformDef } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { AssistedBuilder, AssistedJob, AssistedTarget } from "../platforms/types";

export const ASSISTED: Readonly<Record<Platform, AssistedBuilder>> = {
  linkedin,
  x,
  instagram,
  facebook,
  mastodon,
  bluesky,
  telegram,
  discord,
  hackernews,
  indiehackers,
  reddit,
  whatsapp,
  wordpress,
};

export function assistedJob(variant: Variant, channel: Channel, content: Pick<LoadedContent, "body" | "media">): AssistedJob {
  const def = platformDef(variant.platform);
  const items = postItems(content.body, def);
  return { variant, channel, items, text: items.join("\n\n"), media: def.capabilities.media.maxCount > 0 ? content.media : [] };
}

export function assistedTarget(job: AssistedJob): AssistedTarget {
  const target = ASSISTED[job.variant.platform](job);
  const images = target.clipboard.filter((c) => "imagePath" in c).length;
  if (!images) return target;
  return { ...target, hint: `${target.hint} Then add the ${images === 1 ? "image" : `${images} images`}.` };
}
```

- [ ] **Step 5: Write the manual verification checklist**

`docs/qa/assisted-urls.md`:
```markdown
# Assisted URLs — manual verification

Run before each release, logged in to a test account on each platform. For each row, run
"Copy & open" from the composer on a seeded post and check what the page shows.

| Platform | Page that opens | Pre-filled | Check |
|---|---|---|---|
| LinkedIn profile | feed with the share box open | text | [ ] text appears, newlines kept |
| LinkedIn page (handle = company URL) | page admin, new post | nothing (paste) | [ ] page identity is selected |
| X | intent/post | first thread item | [ ] `#` and `&` survive; emoji intact |
| Bluesky | intent/compose | first thread item | [ ] text appears |
| Mastodon (handle `@you@instance`) | `<instance>/share` | first thread item | [ ] right instance, text appears |
| Instagram | instagram.com (desktop) / app camera (phone) | nothing | [ ] caption on the clipboard, image can be saved |
| Facebook | sharer (with url) or the page | link only | [ ] text is on the clipboard |
| Telegram | t.me/share | text (and link) | [ ] channel picker shows the channel |
| WhatsApp | wa.me | text | [ ] group picker; *bold* renders |
| Discord (handle = channel URL) | the channel | nothing | [ ] message on the clipboard |
| Hacker News | submitlink (url) or submit | title and url | [ ] both fields filled |
| Reddit (handle `r/<sub>`) | subreddit submit | title and url or text | [ ] fields filled in the new Reddit UI |
| Indie Hackers | new-post | nothing | [ ] URL still opens the editor (update `indiehackers/assisted.ts` if not) |
| WordPress (handle = domain) | wp-admin/post-new.php | nothing | [ ] pasted Markdown converts to blocks |
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/publish && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platforms src/publish/assisted.ts test/publish/assisted.test.ts docs/qa/assisted-urls.md
git commit -m "feat(publish): add pre-filled compose URLs and clipboard steps for every platform (refs #55)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Clipboard service and browser fakes (#56)

**Files:**
- Create: `src/publish/clipboard.ts`, `test/fakes/browser.ts`, `test/publish/clipboard.test.ts`
- Modify: `test/setup.ts`

**Interfaces:**
- Consumes: `ClipItem` (Task 2); `App.vault.readBinary/getFileByPath` (fake from M2a Task 5).
- Produces:
  - `type CopyResult = "copied" | "revealed" | "failed"`; `interface ClipboardEnv { writeText(text); writeImage(bytes, mime): Promise<boolean>; reveal(path): boolean }`; `browserClipboard(app): ClipboardEnv` — text via `navigator.clipboard.writeText`; images via Electron's `clipboard.writeImage(nativeImage…)` on desktop, else `ClipboardItem` for PNG; otherwise the file is revealed in the system file manager (`app.showInFolder`).
  - `class ClipboardService { constructor(app, env?); copyText(text): Promise<boolean>; copyImage(path): Promise<CopyResult>; copy(item: ClipItem): Promise<CopyResult>; share(text, imagePaths?): Promise<boolean> }` — `share` hands text and images to the system share sheet on phones.
  - Clipboard sequencing (step 1 text, step 2 comment, …) is the ordered `AssistedTarget.clipboard` list: the flow copies item 1 when the page opens and offers one button per further item (Task 5).
  - `isMobile(): boolean` (Obsidian puts `is-mobile` on `<body>`).
  - Test fakes: `browser` (`clipboard`, `opened`, `notifications`, `focused`), `FakeNotification` (`permission`, `requested`, `click()`), `FakeClipboardItem`, `installBrowserFakes()`, `resetBrowserFakes()`; installed once and reset before every test by `test/setup.ts`.

- [ ] **Step 1: Write the browser fakes**

`test/fakes/browser.ts`:
```ts
/**
 * Browser APIs the plugin uses that jsdom lacks or that must not really run in tests
 * (clipboard, window.open, system notifications, window focus). Installed by test/setup.ts.
 */
export type ClipboardWrite = { kind: "text"; text: string } | { kind: "blob"; type: string; size: number };

export class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requested = 0;
  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested++;
    return FakeNotification.permission;
  }
  onclick: ((ev: Event) => unknown) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    browser.notifications.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: the user clicks the system notification. */
  click(): void {
    this.onclick?.(new Event("click"));
  }
}

export class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
  get types(): string[] {
    return Object.keys(this.items);
  }
}

export const browser = {
  clipboard: [] as ClipboardWrite[],
  opened: [] as string[],
  notifications: [] as FakeNotification[],
  focused: true,
};

export function installBrowserFakes(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        browser.clipboard.push({ kind: "text", text });
      },
      write: async (items: FakeClipboardItem[]) => {
        for (const item of items) for (const [type, blob] of Object.entries(item.items)) browser.clipboard.push({ kind: "blob", type, size: blob.size });
      },
    },
  });
  Object.assign(globalThis, { ClipboardItem: FakeClipboardItem, Notification: FakeNotification });
  window.open = ((url?: string | URL) => {
    browser.opened.push(String(url));
    return null;
  }) as typeof window.open;
  document.hasFocus = () => browser.focused;
}

export function resetBrowserFakes(): void {
  browser.clipboard = [];
  browser.opened = [];
  browser.notifications = [];
  browser.focused = true;
  FakeNotification.permission = "granted";
  FakeNotification.requested = 0;
}
```

In `test/setup.ts`, add at the top of the file:
```ts
import { beforeEach } from "vitest";
import { installBrowserFakes, resetBrowserFakes } from "./fakes/browser";

installBrowserFakes();
beforeEach(() => resetBrowserFakes());
```

- [ ] **Step 2: Write the failing test**

`test/publish/clipboard.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipboardService, isMobile, type ClipboardEnv } from "../../src/publish/clipboard";
import { browser } from "../fakes/browser";
import { createApp } from "../helpers";
import { jpeg, png } from "../media/bytes";

async function vault() {
  const app = createApp();
  await app.vault.createFolder("Social");
  await app.vault.createBinary("Social/a.png", png(10, 10));
  await app.vault.createBinary("Social/b.jpg", jpeg(10, 10));
  return app;
}

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  document.body.classList.remove("is-mobile");
});

describe("ClipboardService", () => {
  it("copies text", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyText("Hello")).toBe(true);
    expect(browser.clipboard).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("reports a failed text copy", async () => {
    const env: ClipboardEnv = { writeText: async () => Promise.reject(new Error("denied")), writeImage: async () => false, reveal: () => false };
    expect(await new ClipboardService((await vault()) as never, env).copyText("Hello")).toBe(false);
  });

  it("copies a PNG with ClipboardItem when Electron is not available", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyImage("Social/a.png")).toBe("copied");
    expect(browser.clipboard).toEqual([{ kind: "blob", type: "image/png", size: 33 }]);
  });

  it("uses Electron's native image clipboard on desktop", async () => {
    const writeImage = vi.fn();
    (window as unknown as { require: (m: string) => unknown }).require = () => ({
      clipboard: { writeImage },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    });
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyImage("Social/b.jpg")).toBe("copied");
    expect(writeImage).toHaveBeenCalledOnce();
  });

  it("reveals the file when the image can't go on the clipboard", async () => {
    const app = await vault();
    const showInFolder = vi.fn();
    Object.assign(app, { showInFolder });
    expect(await new ClipboardService(app as never).copyImage("Social/b.jpg")).toBe("revealed");
    expect(showInFolder).toHaveBeenCalledWith("Social/b.jpg");
    expect(await new ClipboardService(app as never).copyImage("Social/missing.png")).toBe("failed");
  });

  it("copies a clipboard item of either kind", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copy({ label: "Post text", text: "A" })).toBe("copied");
    expect(await clip.copy({ label: "Image 1", imagePath: "Social/a.png" })).toBe("copied");
    expect(await clip.copy({ label: "Image 2", imagePath: "Social/gone.png" })).toBe("failed");
    expect(browser.clipboard).toEqual([
      { kind: "text", text: "A" },
      { kind: "blob", type: "image/png", size: 33 },
    ]);
  });

  it("hands text and images to the share sheet on phones", async () => {
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    document.body.classList.add("is-mobile");
    expect(isMobile()).toBe(true);
    expect(await new ClipboardService((await vault()) as never).share("Caption", ["Social/a.png"])).toBe(true);
    expect(shared[0]?.text).toBe("Caption");
    expect(shared[0]?.files?.map((f) => f.name)).toEqual(["a.png"]);
    Reflect.deleteProperty(navigator, "share");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/publish/clipboard.test.ts`
Expected: FAIL — `Cannot find module '../../src/publish/clipboard'`.

- [ ] **Step 4: Implement the clipboard service**

`src/publish/clipboard.ts`:
```ts
import type { App } from "obsidian";
import type { ClipItem } from "../platforms/types";

export type CopyResult = "copied" | "revealed" | "failed";

export interface ClipboardEnv {
  writeText(text: string): Promise<void>;
  /** Puts an image on the clipboard; false when this device can't. */
  writeImage(bytes: ArrayBuffer, mime: string): Promise<boolean>;
  /** Shows the file in the system file manager; false when unavailable (mobile). */
  reveal(path: string): boolean;
}

interface ElectronLike {
  clipboard?: { writeImage(image: unknown): void };
  nativeImage?: { createFromBuffer(buffer: Buffer): { isEmpty(): boolean } };
}

const MIME: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Obsidian adds `is-mobile` to <body> on phones and tablets. */
export function isMobile(): boolean {
  return document.body.classList.contains("is-mobile");
}

export function browserClipboard(app: App): ClipboardEnv {
  return {
    writeText: (text) => navigator.clipboard.writeText(text),
    async writeImage(bytes, mime) {
      const electron = (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as ElectronLike | undefined;
      if (electron?.clipboard && electron.nativeImage) {
        const image = electron.nativeImage.createFromBuffer(Buffer.from(bytes));
        if (!image.isEmpty()) {
          electron.clipboard.writeImage(image);
          return true;
        }
      }
      if (typeof ClipboardItem !== "undefined" && mime === "image/png") {
        await navigator.clipboard.write([new ClipboardItem({ [mime]: new Blob([bytes], { type: mime }) })]);
        return true;
      }
      return false;
    },
    reveal(path) {
      const show = (app as unknown as { showInFolder?: (path: string) => void }).showInFolder;
      if (!show) return false;
      show.call(app, path);
      return true;
    },
  };
}

export class ClipboardService {
  constructor(
    private readonly app: App,
    private readonly env: ClipboardEnv = browserClipboard(app),
  ) {}

  async copyText(text: string): Promise<boolean> {
    try {
      await this.env.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Image on the clipboard where possible; otherwise the file is revealed so it can be dragged in. */
  async copyImage(path: string): Promise<CopyResult> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return "failed";
    const mime = MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
    try {
      if (await this.env.writeImage(await this.app.vault.readBinary(file), mime)) return "copied";
    } catch {
      // fall back to revealing the file
    }
    return this.env.reveal(path) ? "revealed" : "failed";
  }

  async copy(item: ClipItem): Promise<CopyResult> {
    if ("text" in item) return (await this.copyText(item.text)) ? "copied" : "failed";
    return this.copyImage(item.imagePath);
  }

  /** Phones: hand the text and images to the system share sheet. */
  async share(text: string, imagePaths: readonly string[] = []): Promise<boolean> {
    const share = (navigator as unknown as { share?: (data: ShareData) => Promise<void> }).share;
    if (!share) return false;
    const files: File[] = [];
    for (const path of imagePaths) {
      const file = this.app.vault.getFileByPath(path);
      if (file) files.push(new File([await this.app.vault.readBinary(file)], file.name, { type: MIME[file.extension.toLowerCase()] ?? "" }));
    }
    try {
      await share.call(navigator, files.length ? { text, files } : { text });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (whole suite: the browser fakes are installed for every test file).

- [ ] **Step 6: Commit**

```bash
git add src/publish/clipboard.ts test/fakes/browser.ts test/setup.ts test/publish/clipboard.test.ts
git commit -m "feat(publish): add the clipboard service with image copy and share sheet (refs #56)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mark published / skip, live-URL validation and the publish service (#58)

**Files:**
- Create: `src/publish/liveUrl.ts`, `src/publish/transitions.ts`, `src/publish/log.ts`, `src/publish/actions.ts`, `test/publish/liveUrl.test.ts`, `test/publish/transitions.test.ts`, `test/publish/markPublished.test.ts`
- Modify: `src/model/types.ts` (`Delivery.reason`), `src/model/frontmatter.ts`, `src/model/writer.ts` (`DELIVERY_KEYS`), `src/ui/context.ts` (`publish`), `src/main.ts`, `test/ui/ctx.ts` (replace the file)

**Interfaces:**
- Consumes: `effectiveDelivery` (Task 1); `hostOf`, `mastodonInstance` (Task 2); `ClipboardService` (Task 3); `PlannerActions.write/undo/undoNotice` (M2a Task 8); `ComposerActions` (M2a); `transition`, `canTransition`.
- Produces:
  - `Delivery.reason?: string` (frontmatter `reason`) — why a delivery was skipped.
  - `expectedHosts(platform, channel?)`, `type LiveUrlCheck = { ok: true; url: string } | { ok: false; reason: string }`, `validateLiveUrl(platform, raw, channel?): LiveUrlCheck` — the link must be http(s), have a real host, and belong to the platform (Mastodon: the channel's instance; WordPress: the channel's site; any host when those are unknown).
  - `toAwaiting(d)`, `toPublished(d, patch?)`, `toSkipped(d, reason?)` — the assisted path of spec §5 (`draft/ready/failed/skipped → scheduled → awaiting_you → published`; `check_needed` and `handed_over` go straight to `published`), each `null` when not allowed.
  - `interface AttemptEntry { at; path; channelId; result: "published" | "failed" | "retry" | "skipped" | "awaiting_you" | "overdue" | "check_needed"; url?; error? }`, `interface AttemptLog { append(entry): void | Promise<void> }`, `class MemoryLog` (M3 #27 writes `Social/_log.md` instead).
  - `interface PublishDeps { app; writer; index; channels; planner; composer; adapters; clipboard; log; settings(); now() }`, `type MarkResult = { ok: true } | { ok: false; reason: string }`, `class PublishActions { context; startAssisted(path, channelId): Promise<boolean>; markPublished(path, channelId, url?): Promise<MarkResult>; skip(path, channelId, reason?): Promise<boolean> }`.
  - `OsmmContext.publish: PublishActions`; `TestCtx.adapters` and `TestCtx.log`.

- [ ] **Step 1: Write the failing tests**

`test/publish/liveUrl.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Platform } from "../../src/model/platforms";
import { validateLiveUrl } from "../../src/publish/liveUrl";

const NOT_A_LINK = "Paste the full link to the post, starting with https://";

describe("validateLiveUrl (review focus 4)", () => {
  it.each([
    ["linkedin", "https://www.linkedin.com/feed/update/urn:li:activity:1", undefined, true],
    ["x", "https://twitter.com/you/status/1", undefined, true],
    ["reddit", "https://old.reddit.com/r/x/comments/1", undefined, true],
    ["hackernews", "https://news.ycombinator.com/item?id=1", undefined, true],
    ["mastodon", "https://mastodon.social/@you/1", "@you@mastodon.social", true],
    ["mastodon", "https://any.instance/@you/1", undefined, true],
    ["wordpress", "https://eventx.berlin/2026/10/back/", "eventx.berlin", true],
  ] as Array<[Platform, string, string | undefined, boolean]>)("%s accepts %s", (platform, url, handle, ok) => {
    expect(validateLiveUrl(platform, `  ${url} `, { handle })).toEqual(ok ? { ok: true, url } : expect.anything());
  });

  it.each([
    ["linkedin", "https://x.com/you/status/1", undefined, "That isn't a LinkedIn link (expected linkedin.com)."],
    ["x", "see my post", undefined, NOT_A_LINK],
    ["bluesky", "http://", undefined, NOT_A_LINK],
    ["bluesky", "https://localhost/post", undefined, NOT_A_LINK],
    ["bluesky", "ftp://bsky.app/x", undefined, NOT_A_LINK],
    ["mastodon", "https://fosstodon.org/@you/1", "@you@mastodon.social", "That isn't a Mastodon link (expected mastodon.social)."],
    ["wordpress", "https://other.blog/post", "eventx.berlin", "That isn't a WordPress link (expected eventx.berlin)."],
  ] as Array<[Platform, string, string | undefined, string]>)("%s refuses %s", (platform, url, handle, reason) => {
    expect(validateLiveUrl(platform, url, { handle })).toEqual({ ok: false, reason });
  });
});
```

`test/publish/transitions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { DeliveryStatus } from "../../src/model/types";
import { toAwaiting, toPublished, toSkipped } from "../../src/publish/transitions";

describe("assisted transitions", () => {
  it.each([
    ["draft", "awaiting_you"],
    ["ready", "awaiting_you"],
    ["scheduled", "awaiting_you"],
    ["overdue", "awaiting_you"],
    ["failed", "awaiting_you"],
    ["skipped", "awaiting_you"],
    ["awaiting_you", "awaiting_you"],
    ["published", null],
    ["publishing", null],
    ["handed_over", null],
    ["check_needed", null],
  ] as Array<[DeliveryStatus, DeliveryStatus | null]>)("toAwaiting(%s) = %s", (from, to) => {
    expect(toAwaiting({ status: from })?.status ?? null).toBe(to);
  });

  it.each([
    ["scheduled", "published"],
    ["awaiting_you", "published"],
    ["check_needed", "published"],
    ["handed_over", "published"],
    ["draft", "published"],
    ["published", null],
    ["publishing", null],
  ] as Array<[DeliveryStatus, DeliveryStatus | null]>)("toPublished(%s) = %s", (from, to) => {
    expect(toPublished({ status: from }, { url: "https://x" })?.status ?? null).toBe(to);
  });

  it("never jumps from scheduled straight to published", () => {
    expect(toPublished({ status: "scheduled", at: 1 }, { url: "https://x", at: 2 })).toEqual({ status: "published", at: 2, url: "https://x" });
  });

  it("skips with a reason where the state machine allows it", () => {
    expect(toSkipped({ status: "awaiting_you" }, "Posted elsewhere")).toEqual({ status: "skipped", reason: "Posted elsewhere" });
    expect(toSkipped({ status: "handed_over" })).toBeNull();
    expect(toSkipped({ status: "published" })).toBeNull();
  });
});
```

`test/publish/markPublished.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { parseVariant, serializeDelivery } from "../../src/model/frontmatter";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const BS = "Social/Event X/Event X – Bluesky.md";
const LI = "Social/Event X/Event X – LinkedIn.md";

async function fm(c: TestCtx, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("PublishActions.markPublished", () => {
  it("records the live URL and rolls the status up at once", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.markPublished(BS, "bs/you", " https://bsky.app/profile/you/post/1 ")).toEqual({ ok: true });
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "published");
    expect(c.index.getVariant(BS)!.deliveries["bs/you"]).toEqual({ status: "published", at: TEST_NOW, url: "https://bsky.app/profile/you/post/1" });
    expect(c.ctx.actions.rows().find((r) => r.key === `${BS}#bs/you`)?.status).toBe("published");
    expect(c.log.entries).toEqual([{ at: TEST_NOW, path: BS, channelId: "bs/you", result: "published", url: "https://bsky.app/profile/you/post/1" }]);
  });

  it("refuses a link to another platform and writes nothing (review focus 4)", async () => {
    const c = await makeCtx({ seed: true });
    const before = await fm(c, BS);
    expect(await c.ctx.publish.markPublished(BS, "bs/you", "https://x.com/you/status/1")).toEqual({
      ok: false,
      reason: "That isn't a Bluesky link (expected bsky.app).",
    });
    expect(await fm(c, BS)).toEqual(before);
    expect(c.log.entries).toEqual([]);
  });

  it("can mark without a link, and undo it", async () => {
    const c = await makeCtx({ seed: true });
    await c.ctx.publish.markPublished(BS, "bs/you");
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "published");
    expect(Notice.messages.at(-1)).toBe("Marked @you.bsky.social as published. Undo");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "scheduled");
    expect(c.index.getVariant(BS)!.deliveries["bs/you"]).toEqual({ status: "scheduled" });
  });

  it("refuses a channel that is already published", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.markPublished(LI, "li/me", "https://www.linkedin.com/feed/update/2")).toEqual({
      ok: false,
      reason: "Me is already marked as published.",
    });
  });

  it("resolves a check-needed delivery", async () => {
    const path = "Social/Posts/Check.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "attention", deliveries: { "tg/event-x": { status: "check_needed" } } } }],
    });
    expect(await c.ctx.publish.markPublished(path, "tg/event-x", "https://t.me/eventx/12")).toEqual({ ok: true });
    await indexed(c.index, () => c.index.getVariant(path)?.status === "published");
  });
});

describe("PublishActions.skip and startAssisted", () => {
  it("skips with a reason", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.skip(BS, "bs/you", "Posted by hand elsewhere")).toBe(true);
    await vi.waitFor(async () => expect(((await fm(c, BS)).deliveries as Record<string, unknown>)["bs/you"]).toEqual({ status: "skipped", reason: "Posted by hand elsewhere" }));
    expect(c.log.entries.at(-1)).toMatchObject({ result: "skipped" });
  });

  it("walks a draft channel through scheduled to awaiting_you", async () => {
    const c = await makeCtx({ seed: true });
    const path = "Social/Posts/WhatsApp reminder.md";
    expect(await c.ctx.publish.startAssisted(path, "wa/makers-berlin")).toBe(true);
    await indexed(c.index, () => c.index.getVariant(path)?.deliveries["wa/makers-berlin"]?.status === "awaiting_you");
  });

  it("refuses unreadable and finished deliveries", async () => {
    const path = "Social/Posts/Typo.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me"], status: "scheduled", deliveries: { "li/me": { status: "Handed-Over" } } } }],
    });
    expect(await c.ctx.publish.startAssisted(path, "li/me")).toBe(false);
    expect(await c.ctx.publish.markPublished(path, "li/me")).toEqual({
      ok: false,
      reason: "Me can't be marked as published: fix its delivery status in the note first.",
    });
    expect(await c.ctx.publish.startAssisted(LI, "li/me")).toBe(false);
  });
});

describe("Delivery.reason", () => {
  it("round-trips through frontmatter", () => {
    expect(serializeDelivery({ status: "skipped", reason: "Duplicate" })).toEqual({ status: "skipped", reason: "Duplicate" });
    const v = parseVariant({ platform: "x", channels: ["x/you"], deliveries: { "x/you": { status: "skipped", reason: "Duplicate" } } }, "p.md");
    expect(v.value?.deliveries["x/you"]).toEqual({ status: "skipped", reason: "Duplicate" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/publish`
Expected: FAIL — `liveUrl`, `transitions` and `actions` modules missing; `ctx.publish` undefined.

- [ ] **Step 3: Add `reason` to deliveries**

In `src/model/types.ts`, add to `interface Delivery` after `attempts?: number;`:
```ts
  /** Why the delivery was skipped (optional, from the assisted flow). */
  reason?: string;
```
In `src/model/frontmatter.ts`:
- in `parseDeliveries`, after `if (attempts !== undefined) d.attempts = attempts;` add:
```ts
    if (typeof value.reason === "string" && value.reason.trim()) d.reason = value.reason.trim();
```
- in `serializeDelivery`, before `return out;` add:
```ts
  if (d.reason) out.reason = d.reason;
```
In `src/model/writer.ts`, change `DELIVERY_KEYS` to:
```ts
const DELIVERY_KEYS = ["status", "at", "url", "remote_id", "error", "attempts", "reason"];
```

- [ ] **Step 4: Write validation, transitions and the log**

`src/publish/liveUrl.ts`:
```ts
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel } from "../model/types";
import { hostOf, mastodonInstance } from "../platforms/share";

const HOSTS: Readonly<Record<Platform, readonly string[] | null>> = {
  linkedin: ["linkedin.com", "lnkd.in"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.com", "fb.watch"],
  mastodon: null,
  bluesky: ["bsky.app"],
  telegram: ["t.me", "telegram.me"],
  discord: ["discord.com", "discordapp.com"],
  hackernews: ["news.ycombinator.com"],
  indiehackers: ["indiehackers.com"],
  reddit: ["reddit.com", "redd.it"],
  whatsapp: ["whatsapp.com", "wa.me"],
  wordpress: null,
};

const NOT_A_LINK = "Paste the full link to the post, starting with https://";

/** Hosts a live link may point to; null when any host is fine (Mastodon instance or WordPress site unknown). */
export function expectedHosts(platform: Platform, channel?: Pick<Channel, "handle">): readonly string[] | null {
  if (platform === "mastodon") {
    const instance = mastodonInstance(channel?.handle);
    return instance ? [instance] : null;
  }
  if (platform === "wordpress") {
    const site = hostOf(channel?.handle);
    return site ? [site] : null;
  }
  return HOSTS[platform];
}

export type LiveUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export function validateLiveUrl(platform: Platform, raw: string, channel?: Pick<Channel, "handle">): LiveUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: NOT_A_LINK };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) return { ok: false, reason: NOT_A_LINK };
  const hosts = expectedHosts(platform, channel);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, reason: `That isn't a ${PLATFORM_META[platform].label} link (expected ${hosts[0]}).` };
  }
  return { ok: true, url: url.href };
}
```

`src/publish/transitions.ts`:
```ts
import { canTransition, transition } from "../model/stateMachine";
import type { Delivery } from "../model/types";

type Patch = Partial<Omit<Delivery, "status">>;

/** The assisted path of spec §5: into `awaiting_you`, via `scheduled` when needed. Null when not allowed. */
export function toAwaiting(d: Delivery): Delivery | null {
  switch (d.status) {
    case "awaiting_you":
      return d;
    case "scheduled":
    case "overdue":
      return transition(d, "awaiting_you");
    case "draft":
    case "ready":
    case "failed":
    case "skipped":
      return transition(transition(d, "scheduled"), "awaiting_you");
    default:
      return null;
  }
}

/** `scheduled → published` is illegal, so an assisted post passes through `awaiting_you`. */
export function toPublished(d: Delivery, patch: Patch = {}): Delivery | null {
  if (d.status === "check_needed" || d.status === "handed_over") return transition(d, "published", patch);
  const waiting = toAwaiting(d);
  return waiting ? transition(waiting, "published", patch) : null;
}

export function toSkipped(d: Delivery, reason?: string): Delivery | null {
  if (!canTransition(d.status, "skipped")) return null;
  return transition(d, "skipped", reason ? { reason } : {});
}
```

`src/publish/log.ts`:
```ts
export interface AttemptEntry {
  at: number;
  path: string;
  channelId: string;
  result: "published" | "failed" | "retry" | "skipped" | "awaiting_you" | "overdue" | "check_needed";
  url?: string;
  error?: string;
}

/** Every publish attempt is recorded (spec §5.6). M3 (#27) appends to Social/_log.md; M2 keeps them in memory. */
export interface AttemptLog {
  append(entry: AttemptEntry): void | Promise<void>;
}

export class MemoryLog implements AttemptLog {
  readonly entries: AttemptEntry[] = [];

  append(entry: AttemptEntry): void {
    this.entries.push(entry);
  }
}
```

- [ ] **Step 5: Write the publish service**

`src/publish/actions.ts`:
```ts
import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { SocialIndex } from "../index/socialIndex";
import type { SafeWriter } from "../model/writer";
import type { AdapterRegistry } from "../platforms/registry";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "../ui/actions";
import type { OsmmContext } from "../ui/context";
import type { ClipboardService } from "./clipboard";
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
}
```

- [ ] **Step 6: Put the service into the context**

In `src/ui/context.ts`, add `import type { PublishActions } from "../publish/actions";` and the field `publish: PublishActions;` after `composer`.

`test/ui/ctx.ts` (replace the file):
```ts
import { get, writable, type Writable } from "svelte/store";
import { App } from "../fakes/obsidian";
import { buildSeed } from "../../scripts/seedData";
import { ChannelRegistry } from "../../src/channels/registry";
import { ComposerActions } from "../../src/composer/actions";
import { SocialIndex } from "../../src/index/socialIndex";
import { indexStore } from "../../src/index/stores";
import { NoteFactory } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { DEFAULT_VIEW_STATE } from "../../src/planner/viewState";
import { AdapterRegistry } from "../../src/platforms/registry";
import { PublishActions } from "../../src/publish/actions";
import { ClipboardService } from "../../src/publish/clipboard";
import { MemoryLog } from "../../src/publish/log";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { PlannerActions } from "../../src/ui/actions";
import type { OsmmContext } from "../../src/ui/context";
import { settle, writeNote } from "../helpers";

export const TEST_NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin

export interface TestCtx {
  app: App;
  ctx: OsmmContext;
  index: SocialIndex;
  writer: SafeWriter;
  settings: Writable<OsmmSettings>;
  now: Writable<number>;
  adapters: AdapterRegistry;
  log: MemoryLog;
}

export async function makeCtx(
  opts: {
    seed?: boolean;
    now?: number;
    notes?: Array<{ path: string; frontmatter: Record<string, unknown>; body?: string }>;
  } = {},
): Promise<TestCtx> {
  const app = new App();
  const now = opts.now ?? TEST_NOW;
  const seed = buildSeed(now);
  const notes = [...(opts.seed ? seed.notes : []), ...(opts.notes ?? [])];
  for (const n of notes) await writeNote(app as never, n.path, n.frontmatter, n.body ?? "");
  await settle();

  const settings = writable(migrateSettings(seed.settings));
  const channels = new ChannelRegistry({
    read: () => get(settings),
    write: async (next) => settings.update((s) => ({ ...s, ...next })),
  });
  const writer = new SafeWriter(app as never);
  const factory = new NoteFactory(app as never, writer, { rootFolder: () => get(settings).rootFolder });
  const index = new SocialIndex(app as never, 0);
  await index.build();
  index.start();
  const nowStore = writable(now);
  const clock = () => get(nowStore);
  const actions = new PlannerActions({ app: app as never, writer, factory, channels, index, settings: () => get(settings), now: clock });
  const adapters = new AdapterRegistry();
  const composer = new ComposerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    planner: actions,
    adapters,
    settings: () => get(settings),
    now: clock,
  });
  const log = new MemoryLog();
  const publish = new PublishActions({
    app: app as never,
    writer,
    index,
    channels,
    planner: actions,
    composer,
    adapters,
    clipboard: new ClipboardService(app as never),
    log,
    settings: () => get(settings),
    now: clock,
  });
  const ctx: OsmmContext = {
    app: app as never,
    settings,
    snapshot: indexStore(index),
    now: nowStore,
    viewState: writable(structuredClone(DEFAULT_VIEW_STATE)),
    channels,
    actions,
    composer,
    publish,
  };
  actions.context = ctx;
  publish.context = ctx;
  return { app, ctx, index, writer, settings, now: nowStore, adapters, log };
}
```

In `src/main.ts`:
- add imports:
```ts
import { PublishActions } from "./publish/actions";
import { ClipboardService } from "./publish/clipboard";
import { MemoryLog } from "./publish/log";
```
- add the field `readonly log = new MemoryLog();` after `adapters`.
- in `uiContext()`, after the `composer` constant, add:
```ts
      const publish = new PublishActions({
        app: this.app,
        writer: this.writer,
        index: this.index,
        channels: this.channels,
        planner: actions,
        composer,
        adapters: this.adapters,
        clipboard: new ClipboardService(this.app),
        log: this.log,
        settings: () => this.settings,
        now: () => Date.now(),
      });
```
  add `publish,` to the `this.ui = { … }` literal after `composer,`, and after `actions.context = this.ui;` add `publish.context = this.ui;`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat(publish): mark published or skipped with live-URL validation (refs #58)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Assisted publish modal — 3 steps, channel by channel (#57, #52 "Copy & open")

**Files:**
- Create: `src/publish/assistedFlow.ts`, `src/publish/AssistedFlow.svelte`, `test/publish/assistedFlow.test.ts`
- Modify: `src/publish/actions.ts` (`target`, `copyItem`, `openTarget`, `openAssisted`), `src/composer/ActionsBar.svelte` ("Copy & open"), `src/styles/composer.css`

**Interfaces:**
- Consumes: `assistedJob`, `assistedTarget` (Task 2); `ClipboardService`, `isMobile`, `CopyResult` (Task 3); `startAssisted`, `markPublished`, `skip` (Task 4); `effectiveDelivery` (Task 1); `SvelteModal` (`src/ui/dialogs.ts`); `ComposerActions.content/preview/check` (M2a).
- Produces:
  - `assistedQueue(v, defaultStagger, only?): string[]` — channels still to post (not published, skipped, publishing, handed over or check-needed, and readable), in stagger order.
  - `PublishActions.target(v, channel, content): AssistedTarget`, `copyItem(item): Promise<CopyResult>` (images go to the share sheet on phones), `openTarget(path, channelId, target): Promise<CopyResult | null>` (copies the first clipboard item, opens `url` — or `mobileUrl` on phones — and marks the delivery `awaiting_you`), `openAssisted(path, channelIds?, startStep: 1 | 3 = 1): boolean`.
  - `<AssistedFlow path channelIds startStep? close>` — step 1 **Check** (preview and blocking issues), step 2 **Open and paste** (hint, "Open <Platform>", one "Copy …" button per further clipboard item), step 3 **Confirm** ("Link to the live post", **Mark published**, **Published, no link**, optional reason, **Skip this channel**); then the next channel. Closing midway leaves the delivery `awaiting_you`.
  - Composer action row: **Copy & open** (opens the flow for the post's pending channels).

- [ ] **Step 1: Write the failing test**

`test/publish/assistedFlow.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Modal, Notice } from "../fakes/obsidian";
import { browser } from "../fakes/browser";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import AssistedFlow from "../../src/publish/AssistedFlow.svelte";
import { assistedQueue } from "../../src/publish/assistedFlow";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const BS = "Social/Event X/Event X – Bluesky.md";

describe("assistedQueue", () => {
  it("lists the channels still to post, in stagger order", async () => {
    const { index } = await makeCtx({ seed: true });
    expect(assistedQueue(index.getVariant(LI)!, 15)).toEqual(["li/acme-studio", "li/maker-lab"]);
    const v = index.getVariant(LI)!;
    const swapped = { ...v, deliveries: { ...v.deliveries, "li/acme-studio": { status: "scheduled" as const, at: 3_000_000_000_000 } } };
    expect(assistedQueue(swapped, 15)).toEqual(["li/maker-lab", "li/acme-studio"]);
    expect(assistedQueue(v, 15, ["li/maker-lab", "li/me"])).toEqual(["li/maker-lab"]);
  });
});

describe("AssistedFlow", () => {
  it("walks each channel through check, open and confirm", async () => {
    const c = await makeCtx({ seed: true });
    const close = vi.fn();
    render(AssistedFlow, { props: { path: LI, channelIds: ["li/acme-studio", "li/maker-lab"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("figure", { name: "LinkedIn preview" })).toBeTruthy());
    expect(screen.getByText("LinkedIn · Acme Studio (1 of 2)")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open LinkedIn" }));
    await vi.waitFor(() => expect(browser.opened).toEqual(["https://www.linkedin.com/feed/"]));
    expect(browser.clipboard[0]).toEqual({ kind: "text", text: "I almost didn't host Event X.\n\nSix months ago I was shipping alone…" });

    await fireEvent.click(screen.getByRole("button", { name: "I've posted it" }));
    await fireEvent.input(screen.getByLabelText("Link to the live post"), { target: { value: "https://x.com/nope" } });
    await fireEvent.click(screen.getByRole("button", { name: "Mark published" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That isn't a LinkedIn link (expected linkedin.com)."));
    await fireEvent.input(screen.getByLabelText("Link to the live post"), { target: { value: "https://www.linkedin.com/feed/update/urn:li:activity:2" } });
    await fireEvent.click(screen.getByRole("button", { name: "Mark published" }));
    await indexed(c.index, () => c.index.getVariant(LI)!.deliveries["li/acme-studio"]?.status === "published");
    await vi.waitFor(() => expect(screen.getByText("LinkedIn · Maker Lab (2 of 2)")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open LinkedIn" }));
    await indexed(c.index, () => c.index.getVariant(LI)!.deliveries["li/maker-lab"]?.status === "awaiting_you");
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledOnce();
    expect(c.index.getVariant(LI)!.deliveries["li/maker-lab"]?.status).toBe("awaiting_you");
  });

  it("offers the further clipboard items, then skips with a reason", async () => {
    const c = await makeCtx({ seed: true });
    const close = vi.fn();
    const X = "Social/Event X/Event X – X.md";
    render(AssistedFlow, { props: { path: X, channelIds: ["x/you"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Copy reply 2" }));
    await vi.waitFor(() => expect(browser.clipboard).toEqual([{ kind: "text", text: "One evening, twelve makers…" }]));
    await fireEvent.click(screen.getByRole("button", { name: "I've posted it" }));
    await fireEvent.input(screen.getByLabelText("Reason (optional)"), { target: { value: "Posted from my phone" } });
    await fireEvent.click(screen.getByRole("button", { name: "Skip this channel" }));
    await indexed(c.index, () => c.index.getVariant(X)!.deliveries["x/you"]?.status === "skipped");
    expect(c.index.getVariant(X)!.deliveries["x/you"]).toEqual({ status: "skipped", reason: "Posted from my phone" });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("Copy & open", () => {
  it("opens the flow from the composer for the pending channels", async () => {
    const c = await makeCtx({ seed: true });
    render(ActionsBar, { props: { variant: c.index.getVariant(BS)! }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Copy & open" }));
    expect(Modal.opened.at(-1)?.titleEl.textContent).toBe("Post");
    expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Bluesky · @you.bsky.social (1 of 1)");
    Modal.opened.at(-1)?.close();
  });

  it("says when nothing is left to post", async () => {
    const c = await makeCtx({ seed: true });
    expect(c.ctx.publish.openAssisted("Social/Posts/Weekly devlog 12.md")).toBe(false);
    expect(Notice.messages.at(-1)).toBe("Nothing left to post for this note.");
  });

  it("can open straight at the confirm step", async () => {
    const c = await makeCtx({ seed: true });
    expect(c.ctx.publish.openAssisted(BS, ["bs/you"], 3)).toBe(true);
    expect(Modal.opened.at(-1)?.contentEl.querySelector("input[type=url]")).not.toBeNull();
    Modal.opened.at(-1)?.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/publish/assistedFlow.test.ts`
Expected: FAIL — `assistedFlow` and `AssistedFlow.svelte` missing.

- [ ] **Step 3: Write the queue and the service methods**

`src/publish/assistedFlow.ts`:
```ts
import { deliveryTime } from "../model/stateMachine";
import type { DeliveryStatus, Variant } from "../model/types";
import { effectiveDelivery } from "./eligibility";

/** Channels that no longer need posting. */
const DONE = new Set<DeliveryStatus>(["published", "skipped", "publishing", "handed_over", "check_needed"]);

/** Channels of a post that still need posting, in stagger order (earliest first). */
export function assistedQueue(v: Variant, defaultStagger: number, only?: readonly string[]): string[] {
  return v.channels
    .filter((id) => !only || only.includes(id))
    .filter((id) => {
      const d = effectiveDelivery(v, id);
      return d !== null && !DONE.has(d.status);
    })
    .sort((a, b) => (deliveryTime(v, a, defaultStagger) ?? 0) - (deliveryTime(v, b, defaultStagger) ?? 0) || v.channels.indexOf(a) - v.channels.indexOf(b));
}
```

In `src/publish/actions.ts`:
- add imports:
```ts
import type { LoadedContent } from "../composer/content";
import type { Channel, Variant } from "../model/types";
import type { AssistedTarget, ClipItem } from "../platforms/types";
import { SvelteModal } from "../ui/dialogs";
import { assistedJob, assistedTarget } from "./assisted";
import { assistedQueue } from "./assistedFlow";
import AssistedFlow from "./AssistedFlow.svelte";
import { isMobile, type CopyResult } from "./clipboard";
```
- add these methods to `PublishActions`:
```ts
  target(v: Variant, channel: Channel, content: LoadedContent): AssistedTarget {
    return assistedTarget(assistedJob(v, channel, content));
  }

  /** Text to the clipboard; images to the clipboard on desktop and to the share sheet on phones. */
  async copyItem(item: ClipItem): Promise<CopyResult> {
    if ("imagePath" in item && isMobile()) return (await this.deps.clipboard.share("", [item.imagePath])) ? "copied" : "failed";
    return this.deps.clipboard.copy(item);
  }

  /** Step 2: copy the first clipboard item, open the pre-filled page and mark the delivery as waiting for the user. */
  async openTarget(path: string, channelId: string, target: AssistedTarget): Promise<CopyResult | null> {
    const first = target.clipboard[0];
    const copied = first ? await this.copyItem(first) : null;
    const url = isMobile() && target.mobileUrl ? target.mobileUrl : target.url;
    if (url) window.open(url);
    await this.startAssisted(path, channelId);
    return copied;
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
```

- [ ] **Step 4: Write the modal**

`src/publish/AssistedFlow.svelte`:
```svelte
<script lang="ts">
  import { untrack } from "svelte";
  import type { LoadedContent } from "../composer/content";
  import { PLATFORM_META } from "../model/platforms";
  import type { ClipItem } from "../platforms/types";
  import Preview from "../previews/Preview.svelte";
  import { useOsmm } from "../ui/context";
  import { isMobile } from "./clipboard";

  let { path, channelIds, startStep = 1, close }: { path: string; channelIds: string[]; startStep?: 1 | 3; close: () => void } = $props();
  const { snapshot, channels, composer, publish } = useOsmm();

  let pos = $state(0);
  let step = $state<1 | 2 | 3>(untrack(() => startStep));
  let content = $state<LoadedContent | null>(null);
  let copied = $state<string[]>([]);
  let liveUrl = $state("");
  let reason = $state("");
  let error = $state("");

  const variant = $derived($snapshot.variants.find((v) => v.path === path));
  const channelId = $derived(channelIds[pos]);
  const channel = $derived(channelId ? channels.get(channelId) : undefined);
  const label = $derived(variant ? PLATFORM_META[variant.platform].label : "");

  let loadedFor = "";
  $effect(() => {
    const v = variant;
    if (!v || loadedFor === v.path) return;
    loadedFor = v.path;
    void composer.content.load(v).then((c) => (content = c));
  });

  const target = $derived(variant && channel && content ? publish.target(variant, channel, content) : null);
  const model = $derived(variant && content ? composer.preview(variant, content, channel) : null);
  const blocking = $derived(variant && content ? composer.check(variant, content).filter((i) => i.level === "error") : []);
  const opens = $derived(!!target && (!!target.url || (isMobile() && !!target.mobileUrl)));

  function nextChannel(): void {
    liveUrl = "";
    reason = "";
    error = "";
    copied = [];
    if (pos + 1 < channelIds.length) {
      pos += 1;
      step = 1;
    } else close();
  }

  async function open(): Promise<void> {
    if (!target || !channelId) return;
    const result = await publish.openTarget(path, channelId, target);
    const first = target.clipboard[0];
    if (first && result && result !== "failed") copied = [first.label];
  }

  async function copy(item: ClipItem): Promise<void> {
    if ((await publish.copyItem(item)) !== "failed") copied = [...copied, item.label];
  }

  async function mark(withLink: boolean): Promise<void> {
    if (!channelId) return;
    const result = await publish.markPublished(path, channelId, withLink ? liveUrl : "");
    if (result.ok) nextChannel();
    else error = result.reason;
  }

  async function skipChannel(): Promise<void> {
    if (channelId && (await publish.skip(path, channelId, reason))) nextChannel();
  }
</script>

<div class="osmm-assisted">
  <p class="osmm-progress">{label} · {channel?.name ?? channelId} ({pos + 1} of {channelIds.length})</p>
  <ol class="osmm-steps" aria-label="Steps">
    <li aria-current={step === 1 ? "step" : undefined}>Check</li>
    <li aria-current={step === 2 ? "step" : undefined}>Open and paste</li>
    <li aria-current={step === 3 ? "step" : undefined}>Confirm</li>
  </ol>

  {#if step === 1}
    {#if model}<Preview {model} />{:else}<p class="osmm-progress">Loading…</p>{/if}
    {#if blocking.length}
      <ul class="osmm-issue-list" role="alert">
        {#each blocking as issue, i (i)}<li class="is-error">{issue.message}</li>{/each}
      </ul>
    {/if}
    <div class="modal-button-container">
      <button type="button" class="mod-cta" disabled={!model} onclick={() => (step = 2)}>Next</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {:else if step === 2 && target}
    <p>{target.hint}</p>
    <div class="modal-button-container">
      <button type="button" class="mod-cta" onclick={() => void open()}>{opens ? `Open ${label}` : "Copy the text"}</button>
    </div>
    {#if target.clipboard.length > 1}
      <ul class="osmm-clip-list">
        {#each target.clipboard.slice(1) as item (item.label)}
          <li><button type="button" onclick={() => void copy(item)}>Copy {item.label.toLowerCase()}</button></li>
        {/each}
      </ul>
    {/if}
    {#if copied.length}<p class="osmm-progress" role="status">Copied: {copied.join(", ")}</p>{/if}
    <div class="modal-button-container">
      <button type="button" onclick={() => (step = 3)}>I've posted it</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {:else if step === 3}
    <label>Link to the live post<input type="url" placeholder="https://" bind:value={liveUrl} /></label>
    {#if error}<p class="osmm-issues" role="alert">{error}</p>{/if}
    <div class="modal-button-container">
      <button type="button" class="mod-cta" disabled={!liveUrl.trim()} onclick={() => void mark(true)}>Mark published</button>
      <button type="button" onclick={() => void mark(false)}>Published, no link</button>
    </div>
    <label>Reason (optional)<input type="text" bind:value={reason} /></label>
    <div class="modal-button-container">
      <button type="button" class="mod-warning" onclick={() => void skipChannel()}>Skip this channel</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {/if}
</div>
```

In `src/composer/ActionsBar.svelte`, change `const { channels, composer } = useOsmm();` to `const { channels, composer, publish } = useOsmm();` and add as the first button inside `<div class="osmm-chips">`:
```svelte
    <button type="button" class="mod-cta" onclick={() => publish.openAssisted(variant.path)}>Copy & open</button>
```

Append to `src/styles/composer.css`:
```css
.osmm-assisted { display: flex; flex-direction: column; gap: 12px; }
.osmm-steps { display: flex; gap: 16px; margin: 0; padding-left: 18px; color: var(--text-muted); }
.osmm-steps [aria-current="step"] { color: var(--text-normal); font-weight: 600; }
.osmm-clip-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.osmm-assisted label { display: flex; flex-direction: column; gap: 4px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(publish): add the 3-step assisted publish flow and Copy & open (refs #57, #52)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Publish orchestrator — claim, retry, classify, redact (#62)

**Files:**
- Create: `src/publish/semaphore.ts`, `src/publish/orchestrator.ts`, `test/publish/semaphore.test.ts`, `test/publish/orchestrator.test.ts`
- Modify: `src/publish/actions.ts` (`secrets` and `delay` deps, `orchestrator`, `notifier`, `runApi`), `test/ui/ctx.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `PlatformAdapter`, `DeliveryJob`, `classifyError`, `ErrorKind` (M2a Task 1); `AdapterRegistry`, `platformDef`, `postItems`; `effectiveDelivery` (Task 1); `AttemptLog` (Task 4); `ContentLoader` (M2a Task 8); `Secrets.get/redact` (M1).
- Produces:
  - `class Semaphore { constructor(limit); run<T>(fn: () => Promise<T>): Promise<T> }`.
  - `BACKOFF_MS = [1, 5, 15] minutes`, `interface FailureInfo { path; channelId; kind: ErrorKind; error }`, `type RunResult = { status: "published"; url } | { status: "failed"; kind; error } | { status: "refused"; reason }`, `interface OrchestratorDeps { writer; index; channels; adapters; secrets; content; log; now(); delay(ms); onFailure(info); concurrency? }`, `class PublishOrchestrator { run(path, channelId): Promise<RunResult> }`:
    1. refuses without an adapter that can `publish` (M2: always — the assisted flow is used instead);
    2. **claims** the delivery in one `updateVariant` on fresh frontmatter: `publishing` + `at` (now) + `attempts + 1`, written **before** the adapter call; a first claim starts from draft, ready, scheduled, overdue, failed or awaiting_you (via `scheduled` where the state machine needs it), a retry only from the `failed` it wrote itself — so a delivery that is `publishing`, published, skipped or rescheduled meanwhile is never sent;
    3. calls `adapter.publish(job)` inside a per-platform semaphore (1 at a time by default; released during back-off);
    4. writes `published` + `url` + `remoteId` + `at`, or `failed` + the redacted error; transient errors are retried after 1, 5, 15 minutes (or `Retry-After`, if longer) and the stored error says "(retrying in N min)"; the final failure calls `onFailure`.
  - `interface DeliveryNotifier { due(path, channelId): void; failed(info: FailureInfo): void }`, `PublishActions.notifier` (silent until Task 9), `PublishActions.orchestrator`, `PublishActions.runApi(path, channelId): Promise<RunResult>` (runs one API delivery and reports it in a Notice); `PublishDeps` gains `secrets: { get; redact }` and `delay(ms): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`test/publish/semaphore.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/publish/semaphore";

describe("Semaphore", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let max = 0;
    const job = async (n: number) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    };
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => gate.run(() => job(n))))).toEqual([1, 2, 3, 4, 5]);
    expect(max).toBe(2);
  });

  it("releases the slot when a job throws", async () => {
    const gate = new Semaphore(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "next")).toBe("next");
  });
});
```

`test/publish/orchestrator.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { AdapterRegistry } from "../../src/platforms/registry";
import type { PlatformAdapter } from "../../src/platforms/types";
import { PublishOrchestrator, type FailureInfo } from "../../src/publish/orchestrator";
import { Secrets } from "../../src/secrets/secrets";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Tg.md";
const note = (path = P, delivery: Record<string, unknown> = { status: "scheduled" }) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "telegram",
    channels: ["tg/event-x"],
    status: "scheduled",
    scheduled_at: "2026-10-08T10:00:00+02:00",
    deliveries: { "tg/event-x": delivery },
  },
  body: "Doors open at 18:00",
});
const http = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed, status ${status} (token SECRET-TOKEN-123)`), { status, headers });

async function fm(c: TestCtx, path = P): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

async function setup(publish: NonNullable<PlatformAdapter["publish"]>, opts: { notes?: ReturnType<typeof note>[]; onDelay?: (c: TestCtx) => Promise<void> } = {}) {
  const c = await makeCtx({ seed: true, notes: opts.notes ?? [note()] });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" });
  c.app.secretStorage.setSecret("osmm-channel-tg-event-x", "SECRET-TOKEN-123");
  const adapters = new AdapterRegistry();
  adapters.register({ platform: "telegram", publish });
  const delays: number[] = [];
  const failures: FailureInfo[] = [];
  const orchestrator = new PublishOrchestrator({
    writer: c.writer,
    index: c.index,
    channels: c.ctx.channels,
    adapters,
    secrets: new Secrets(c.app as never),
    content: c.ctx.composer.content,
    log: c.log,
    now: () => TEST_NOW,
    delay: async (ms) => {
      delays.push(ms);
      await opts.onDelay?.(c);
    },
    onFailure: (f) => failures.push(f),
  });
  return { c, orchestrator, delays, failures };
}

const MIN = 60_000;

describe("PublishOrchestrator", () => {
  it("writes publishing and a timestamp before the call, then the result", async () => {
    const seen: { deliveries?: unknown; secret?: string | null; text?: string } = {};
    const ref: { c?: TestCtx } = {};
    const { c, orchestrator } = await setup(async (job) => {
      seen.deliveries = (await fm(ref.c!)).deliveries;
      seen.secret = job.secret;
      seen.text = job.text;
      return { remoteId: "42", url: "https://t.me/eventx/42" };
    });
    ref.c = c;
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "published", url: "https://t.me/eventx/42" });
    expect(seen).toEqual({
      deliveries: { "tg/event-x": { status: "publishing", at: formatDateTime(TEST_NOW), attempts: 1 } },
      secret: "SECRET-TOKEN-123",
      text: "Doors open at 18:00",
    });
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({
      status: "published",
      at: TEST_NOW,
      url: "https://t.me/eventx/42",
      remoteId: "42",
      attempts: 1,
    });
  });

  it("retries transient errors after 1 and 5 minutes", async () => {
    let calls = 0;
    const { c, orchestrator, delays } = await setup(async () => {
      if (++calls < 3) throw http(429);
      return { remoteId: "7", url: "https://t.me/eventx/7" };
    });
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "published" });
    expect(delays).toEqual([1 * MIN, 5 * MIN]);
    expect(c.log.entries.map((e) => e.result)).toEqual(["retry", "retry", "published"]);
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.attempts).toBe(3);
  });

  it("waits for Retry-After when it is longer than the back-off", async () => {
    let calls = 0;
    const { orchestrator, delays } = await setup(async () => {
      if (++calls === 1) throw http(429, { "Retry-After": "600" });
      return { remoteId: "7", url: "https://t.me/eventx/7" };
    });
    await orchestrator.run(P, "tg/event-x");
    expect(delays).toEqual([10 * MIN]);
  });

  it("retries a timeout", async () => {
    let calls = 0;
    const { orchestrator, delays } = await setup(async () => {
      if (++calls === 1) throw new Error("net::ERR_TIMED_OUT");
      return { remoteId: "7", url: "https://t.me/eventx/7" };
    });
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "published" });
    expect(delays).toEqual([1 * MIN]);
  });

  it("fails at once on an expired token, redacts the error and asks the user to fix it", async () => {
    const { c, orchestrator, delays, failures } = await setup(async () => Promise.reject(http(401)));
    const error = "Request failed, status 401 (token •••)";
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "failed", kind: "needs_user", error });
    expect(delays).toEqual([]);
    expect(failures).toEqual([{ path: P, channelId: "tg/event-x", kind: "needs_user", error }]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({ status: "failed", at: TEST_NOW, attempts: 1, error });
    expect(JSON.stringify(c.log.entries)).not.toContain("SECRET-TOKEN-123");
  });

  it("fails at once when the platform rejects the content", async () => {
    const { orchestrator, failures } = await setup(async () => Promise.reject(http(400)));
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "failed", kind: "invalid_content" });
    expect(failures).toHaveLength(1);
  });

  it("gives up after 1, 5 and 15 minutes of transient errors", async () => {
    const { c, orchestrator, delays, failures } = await setup(async () => Promise.reject(http(503)));
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "failed", kind: "transient" });
    expect(delays).toEqual([1 * MIN, 5 * MIN, 15 * MIN]);
    expect(failures.map((f) => f.kind)).toEqual(["transient"]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.attempts === 4);
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({ status: "failed", error: "Request failed, status 503 (token •••)" });
  });

  it("never sends a delivery that is already publishing", async () => {
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        return { remoteId: "1", url: "https://t.me/x/1" };
      },
      { notes: [note(P, { status: "publishing", at: "2026-10-08T09:59:00+02:00" })] },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "refused", reason: "It is already being published." });
    expect(calls).toBe(0);
  });

  it("stops retrying when the user skips the delivery during the back-off", async () => {
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        throw http(429);
      },
      {
        onDelay: async (c) => {
          await c.writer.transitionDelivery(c.app.vault.getFileByPath(P)! as never, "tg/event-x", "skipped");
        },
      },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "refused", reason: "It is skipped." });
    expect(calls).toBe(1);
  });

  it("publishes one delivery per platform at a time", async () => {
    const P2 = "Social/Posts/Tg 2.md";
    let active = 0;
    let max = 0;
    const { orchestrator } = await setup(
      async (job) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { remoteId: job.variant.path, url: "https://t.me/x/1" };
      },
      { notes: [note(), note(P2)] },
    );
    const results = await Promise.all([orchestrator.run(P, "tg/event-x"), orchestrator.run(P2, "tg/event-x")]);
    expect(results.map((r) => r.status)).toEqual(["published", "published"]);
    expect(max).toBe(1);
  });

  it("refuses without an adapter or with an unreadable entry", async () => {
    const c = await makeCtx({ seed: true, notes: [note()] });
    const r = await c.ctx.publish.orchestrator.run(P, "tg/event-x");
    expect(r).toEqual({ status: "refused", reason: "There is no Telegram API adapter yet; use Copy & open." });
    let calls = 0;
    const { orchestrator } = await setup(
      async () => {
        calls++;
        return { remoteId: "1", url: "https://t.me/x/1" };
      },
      { notes: [note(P, { status: "Publishing!" })] },
    );
    expect(await orchestrator.run(P, "tg/event-x")).toMatchObject({ status: "refused" });
    expect(calls).toBe(0);
  });
});

describe("PublishActions.runApi", () => {
  it("runs through the plugin's adapters and reports the result", async () => {
    const c = await makeCtx({ seed: true, notes: [note()] });
    c.adapters.register({ platform: "telegram", publish: async () => ({ remoteId: "9", url: "https://t.me/eventx/9" }) });
    expect(await c.ctx.publish.runApi(P, "tg/event-x")).toMatchObject({ status: "published" });
    expect(Notice.messages.at(-1)).toBe("Published to Event X channel.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/publish/semaphore.test.ts test/publish/orchestrator.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the semaphore and the orchestrator**

`src/publish/semaphore.ts`:
```ts
/** Limits how many async jobs run at once; a finishing job hands its slot straight to the next waiter. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
```

`src/publish/orchestrator.ts`:
```ts
import type { TFile } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ContentLoader } from "../composer/content";
import type { SocialIndex } from "../index/socialIndex";
import { MINUTE } from "../model/dates";
import { PLATFORM_META, type Platform } from "../model/platforms";
import { transition } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import { classifyError, type ErrorKind } from "../platforms/errors";
import { platformDef, type AdapterRegistry } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { DeliveryJob, MediaInfo, PlatformAdapter } from "../platforms/types";
import { effectiveDelivery } from "./eligibility";
import type { AttemptLog } from "./log";
import { Semaphore } from "./semaphore";

export const BACKOFF_MS: readonly number[] = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];

export interface FailureInfo {
  path: string;
  channelId: string;
  kind: ErrorKind;
  error: string;
}

export type RunResult =
  | { status: "published"; url: string }
  | { status: "failed"; kind: ErrorKind; error: string }
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
  /** Called once when a delivery ends up failed. */
  onFailure(info: FailureInfo): void;
  /** Deliveries of one platform that may run at once (default 1). */
  concurrency?: number;
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
  publish: NonNullable<PlatformAdapter["publish"]>;
  items: string[];
  media: MediaInfo[];
  secret: string | null;
  redact(text: string): string;
}

/** Runs one delivery through its API adapter (spec §5): no duplicates, classified errors, retries, redaction. */
export class PublishOrchestrator {
  private readonly gates = new Map<Platform, Semaphore>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async run(path: string, channelId: string): Promise<RunResult> {
    const v = this.deps.index.getVariant(path);
    if (!v) return { status: "refused", reason: "The note is gone." };
    const channel = this.deps.channels.get(channelId);
    if (!channel) return { status: "refused", reason: `${channelId} is not set up in the channel settings.` };
    const adapter = this.deps.adapters.get(v.platform);
    if (!adapter?.publish) return { status: "refused", reason: `There is no ${PLATFORM_META[v.platform].label} API adapter yet; use Copy & open.` };
    const content = await this.deps.content.load(v);
    const def = platformDef(v.platform);
    const secretId = channel.secretId;
    const job: Prepared = {
      path,
      file: v.file,
      channelId,
      channel,
      publish: adapter.publish.bind(adapter),
      items: postItems(content.body, def),
      media: def.capabilities.media.maxCount > 0 ? content.media : [],
      secret: secretId ? this.deps.secrets.get(secretId) : null,
      redact: (text) => (secretId ? this.deps.secrets.redact(text, [secretId]) : text),
    };
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.gate(v.platform).run(() => this.attempt(job, attempt));
      if (outcome.done) return outcome.result;
      await this.deps.delay(outcome.wait);
    }
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
      await this.settle(p.file, p.channelId, (d) => transition(d, "published", { url: res.url, remoteId: res.remoteId, at }));
      void this.deps.log.append({ at, path: p.path, channelId: p.channelId, result: "published", url: res.url });
      return { done: true, result: { status: "published", url: res.url } };
    } catch (e) {
      const err = classifyError(e);
      const message = p.redact(err.message);
      const retry = err.kind === "transient" && attempt <= BACKOFF_MS.length;
      const wait = retry ? Math.max(BACKOFF_MS[attempt - 1]!, err.retryAfterMs ?? 0) : 0;
      const stored = retry ? `${message} (retrying in ${Math.round(wait / MINUTE)} min)` : message;
      await this.settle(p.file, p.channelId, (d) => transition(d, "failed", { error: stored }));
      void this.deps.log.append({ at: this.deps.now(), path: p.path, channelId: p.channelId, result: retry ? "retry" : "failed", error: message });
      if (retry) return { done: false, wait };
      this.deps.onFailure({ path: p.path, channelId: p.channelId, kind: err.kind, error: message });
      return { done: true, result: { status: "failed", kind: err.kind, error: message } };
    }
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

  private async settle(file: TFile, channelId: string, next: (d: Delivery) => Delivery): Promise<void> {
    await this.deps.writer.updateVariant(file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "publishing") return { refuse: "The delivery changed while it was being published." };
      return { deliveries: { [channelId]: next(d) } };
    });
  }
}
```

- [ ] **Step 4: Give the publish service its orchestrator**

In `src/publish/actions.ts`:
- add imports:
```ts
import { PublishOrchestrator, type FailureInfo, type RunResult } from "./orchestrator";
```
- add to `interface PublishDeps` (after `log: AttemptLog;`):
```ts
  secrets: { get(id: string): string | null; redact(text: string, ids: readonly string[]): string };
  /** Waits between API retries (a timer in the plugin; immediate in tests). */
  delay(ms: number): Promise<void>;
```
- add, above the class:
```ts
/** Where the publish service reports deliveries that need the user (Task 9 plugs in desktop notifications). */
export interface DeliveryNotifier {
  due(path: string, channelId: string): void;
  failed(info: FailureInfo): void;
}

const SILENT: DeliveryNotifier = { due: () => undefined, failed: () => undefined };
```
- replace the constructor with:
```ts
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
    });
  }
```
- add the method:
```ts
  /** Runs one API delivery and reports the outcome (failures are reported by the notifier). */
  async runApi(path: string, channelId: string): Promise<RunResult> {
    const result = await this.orchestrator.run(path, channelId);
    const name = this.channelName(channelId);
    if (result.status === "published") new Notice(`Published to ${name}.`);
    else if (result.status === "refused") new Notice(`${name}: ${result.reason}`);
    return result;
  }
```

In `test/ui/ctx.ts`, add `import { Secrets } from "../../src/secrets/secrets";` and add to the `PublishActions` deps (after `log,`):
```ts
    secrets: new Secrets(app as never),
    delay: async () => undefined,
```

In `src/main.ts`, add to the `PublishActions` deps (after `log: this.log,`):
```ts
        secrets: this.secrets,
        delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(publish): add the publish orchestrator with retries, error classes and redaction (refs #62)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scheduler loop — due exactly once, overdue after sleep, publisher-gated (#60)

**Files:**
- Create: `src/scheduler/due.ts`, `src/scheduler/scheduler.ts`, `test/scheduler/scheduler.test.ts`
- Modify: `src/publish/actions.ts` (`dispatch`, `markOverdue`), `src/main.ts` (start the loop), `test/fakes/obsidian.ts` (`Component.registerDomEvent`)

**Interfaces:**
- Consumes: `expandRows` (M1); `unreadable`, `effectiveDelivery` (Task 1); `effectiveMethod` (M2a Task 1); `PublishActions.startAssisted/runApi/notifier` (Tasks 4, 6).
- Produces:
  - `GRACE_MS = 2 minutes`, `interface DueItem { key: string; path: string; channelId: string; at: number; late: number }` (`key` = row key + `@` + due time, so a rescheduled delivery is a new item), `dueItems(variants, now, defaultStagger): DueItem[]` (scheduled, time reached, readable), `decide(item, autoPostLateMs): "dispatch" | "overdue"`.
  - `interface SchedulerPort { dispatch(item): Promise<void>; markOverdue(item): Promise<void> }` (Task 8 adds two methods), `interface SchedulerDeps { index; settings(); now(); isPublisher(); autoPostLateMs(); publish: SchedulerPort; onTick?(now, previous); warn(message); intervalMs?; timers? }`, `interface TickResult { dispatched: string[]; overdue: string[] }`, `class Scheduler { start(); stop(); tick(): Promise<TickResult> }`. Each item is handled at most once per process; `onTick` runs on every device, everything else only when `isPublisher()` is true.
  - `PublishActions.dispatch(item)` — `api` → `runApi` in the background; `assisted` → `awaiting_you` + `notifier.due`; `native` still pending at its time → posted now through the API if possible, else assisted (never a silent no-op). `PublishActions.markOverdue(item)` — `scheduled → overdue` on fresh frontmatter.
  - `OsmmPlugin.scheduler`, started after the index is built; `isPublisher: () => true` until M3 (#26); a tick also runs when the window becomes visible again (wake from sleep).
  - Fake: `Component.registerDomEvent(el, type, handler)`.

- [ ] **Step 1: Write the failing test**

`test/scheduler/scheduler.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { formatDateTime } from "../../src/model/dates";
import { decide, dueItems, GRACE_MS, type DueItem } from "../../src/scheduler/due";
import { Scheduler, type SchedulerDeps } from "../../src/scheduler/scheduler";
import { indexed } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const MIN = 60_000;
const A = "Social/Posts/A.md";
const B = "Social/Posts/B.md";
const note = (path: string, at: number, extra: Record<string, unknown> = {}) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "bluesky",
    channels: ["bs/you"],
    status: "scheduled",
    scheduled_at: formatDateTime(at),
    deliveries: { "bs/you": { status: "scheduled" } },
    ...extra,
  },
  body: "Hi",
});
const key = (path: string, at: number) => `${path}#bs/you@${at}`;

function build(c: TestCtx, over: Partial<SchedulerDeps> = {}) {
  const calls = { dispatched: [] as string[], overdue: [] as string[] };
  const warnings: string[] = [];
  const scheduler = new Scheduler({
    index: c.index,
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => true,
    autoPostLateMs: () => null,
    publish: {
      dispatch: async (i: DueItem) => void calls.dispatched.push(i.key),
      markOverdue: async (i: DueItem) => void calls.overdue.push(i.key),
    },
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { scheduler, calls, warnings };
}

describe("due items", () => {
  it("decides between posting now and the Overdue tray", () => {
    expect(decide({ late: GRACE_MS }, null)).toBe("dispatch");
    expect(decide({ late: GRACE_MS + 1 }, null)).toBe("overdue");
    expect(decide({ late: 20 * MIN }, 30 * MIN)).toBe("dispatch");
    expect(decide({ late: 40 * MIN }, 30 * MIN)).toBe("overdue");
  });

  it("lists scheduled deliveries whose time has come, with their stagger", async () => {
    const c = await makeCtx({ notes: [note(A, T, { platform: "linkedin", channels: ["li/me", "li/acme"], stagger_minutes: 15, deliveries: undefined })] });
    expect(dueItems(c.index.variants(), T + 16 * MIN, 15).map((i) => [i.channelId, i.late])).toEqual([
      ["li/me", 16 * MIN],
      ["li/acme", 1 * MIN],
    ]);
  });
});

describe("Scheduler", () => {
  it("dispatches a due delivery exactly once", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T - MIN });
    const { scheduler, calls } = build(c);
    await scheduler.tick();
    expect(calls.dispatched).toEqual([]);
    c.now.set(T + 10_000);
    expect((await scheduler.tick()).dispatched).toEqual([key(A, T)]);
    await scheduler.tick();
    c.now.set(T + 40_000);
    await scheduler.tick();
    expect(calls.dispatched).toEqual([key(A, T)]);
  });

  it("after a sleep, posts what just fell due and sends the rest to the Overdue tray (review focus 3)", async () => {
    const wake = T + 3 * 60 * MIN;
    const c = await makeCtx({ notes: [note(A, T), note(B, wake - MIN)], now: T - MIN });
    const { scheduler, calls } = build(c);
    await scheduler.tick();
    c.now.set(wake);
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(B, wake - MIN)], overdue: [key(A, T)] });
  });

  it("posts late items within the auto-post window when that setting is on", async () => {
    const c = await makeCtx({ notes: [note(A, T), note(B, T - 30 * MIN)], now: T + 20 * MIN });
    const { scheduler, calls } = build(c, { autoPostLateMs: () => 30 * MIN });
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(A, T)], overdue: [key(B, T - 30 * MIN)] });
  });

  it("stays passive when this device is not the publisher, but still ticks", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const ticks: Array<[number, number | null]> = [];
    const { scheduler, calls } = build(c, { isPublisher: () => false, onTick: (now, previous) => void ticks.push([now, previous]) });
    await scheduler.tick();
    c.now.set(T + 30_000);
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [], overdue: [] });
    expect(ticks).toEqual([
      [T, null],
      [T + 30_000, T],
    ]);
  });

  it("never dispatches an unreadable entry and warns once (review focus 1)", async () => {
    const c = await makeCtx({ notes: [note(A, T, { deliveries: { "bs/you": { status: "Scheduled!" } } })], now: T });
    const { scheduler, calls, warnings } = build(c);
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [], overdue: [] });
    expect(warnings).toEqual(["A: the delivery status of bs/you can't be read, so it won't be published. Fix it in the note."]);
  });

  it("ticks every 30 seconds until stopped", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const set = vi.fn((fn: () => void, _ms: number) => {
      fn();
      return 7;
    });
    const clear = vi.fn();
    const { scheduler, calls } = build(c, { timers: { set, clear } });
    scheduler.start();
    scheduler.start();
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]![1]).toBe(30_000);
    await vi.waitFor(() => expect(calls.dispatched).toEqual([key(A, T)]));
    scheduler.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });
});

describe("dispatch through PublishActions", () => {
  it("assisted: the delivery waits for the user and a reminder goes out", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const due = vi.fn();
    c.ctx.publish.notifier = { due, failed: vi.fn() };
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "awaiting_you");
    expect(due).toHaveBeenCalledWith(A, "bs/you");
  });

  it("api: the orchestrator publishes it", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.status === "published");
    expect(c.index.getVariant(A)!.deliveries["bs/you"]?.url).toBe("https://bsky.app/profile/you/post/1");
  });

  it("late: the delivery becomes overdue", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T + 60 * MIN });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "overdue");
    expect(c.log.entries.map((e) => e.result)).toEqual(["overdue"]);
  });

  it("native without an adapter falls back to the assisted flow", async () => {
    const M = "Social/Posts/M.md";
    const c = await makeCtx({ notes: [{ ...note(M, T), frontmatter: { ...note(M, T).frontmatter, platform: "mastodon", channels: ["ma/you"], deliveries: undefined } }], now: T });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.status === "awaiting_you");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/scheduler`
Expected: FAIL — `due` and `scheduler` modules missing.

- [ ] **Step 3: Write the due rules and the loop**

`src/scheduler/due.ts`:
```ts
import { expandRows } from "../index/queries";
import type { IndexedVariant } from "../index/socialIndex";
import { MINUTE } from "../model/dates";
import { unreadable } from "../publish/eligibility";

/** A delivery at most this late is still posted "on time": the 30-second tick plus a margin. */
export const GRACE_MS = 2 * MINUTE;

export interface DueItem {
  /** Row key plus due time: a rescheduled delivery is a new item. */
  key: string;
  path: string;
  channelId: string;
  at: number;
  late: number;
}

/** Scheduled deliveries whose time has come (stagger included), oldest first. Unreadable entries never are. */
export function dueItems(variants: readonly IndexedVariant[], now: number, defaultStagger: number): DueItem[] {
  const out: DueItem[] = [];
  for (const r of expandRows(variants, defaultStagger)) {
    if (r.channelId === null || r.status !== "scheduled" || r.at === undefined || r.at > now) continue;
    if (unreadable(r.variant, r.channelId)) continue;
    out.push({ key: `${r.key}@${r.at}`, path: r.variant.path, channelId: r.channelId, at: r.at, late: now - r.at });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** Spec §5.2: no silent late posting. Only the grace period, or the optional auto-post window, may still post. */
export function decide(item: Pick<DueItem, "late">, autoPostLateMs: number | null): "dispatch" | "overdue" {
  if (item.late <= GRACE_MS) return "dispatch";
  if (autoPostLateMs !== null && item.late <= autoPostLateMs) return "dispatch";
  return "overdue";
}
```

`src/scheduler/scheduler.ts`:
```ts
import type { SocialIndex } from "../index/socialIndex";
import type { OsmmSettings } from "../settings/settings";
import { decide, dueItems, type DueItem } from "./due";

export interface SchedulerPort {
  dispatch(item: DueItem): Promise<void>;
  markOverdue(item: DueItem): Promise<void>;
}

export interface SchedulerDeps {
  index: SocialIndex;
  settings(): OsmmSettings;
  now(): number;
  /**
   * Only the publisher device runs deliveries (spec §4.3). The publisher-device setting arrives in
   * M3 (#26); until then the plugin passes `() => true`.
   */
  isPublisher(): boolean;
  /** Late deliveries younger than this are still posted (the optional auto-post setting); null when off. */
  autoPostLateMs(): number | null;
  publish: SchedulerPort;
  /** Runs on every tick on every device, before the publisher check (desktop reminders). */
  onTick?(now: number, previous: number | null): void | Promise<void>;
  warn(message: string): void;
  intervalMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface TickResult {
  dispatched: string[];
  overdue: string[];
}

/** The 30-second loop (spec §4). A wake from sleep is simply a late tick: `decide` turns stale items into overdue ones. */
export class Scheduler {
  private handle: unknown = null;
  private lastTick: number | null = null;
  private running = false;
  private readonly handled = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  private get timers() {
    return (
      this.deps.timers ?? {
        set: (fn: () => void, ms: number) => window.setInterval(fn, ms),
        clear: (handle: unknown) => window.clearInterval(handle as number),
      }
    );
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.timers.set(() => void this.tick(), this.deps.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { dispatched: [], overdue: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.deps.now();
      const previous = this.lastTick;
      this.lastTick = now;
      await this.deps.onTick?.(now, previous);
      if (!this.deps.isPublisher()) return result;
      this.warnUnreadable();
      const stagger = this.deps.settings().defaultStaggerMinutes;
      const lateMs = this.deps.autoPostLateMs();
      for (const item of dueItems(this.deps.index.variants(), now, stagger)) {
        if (this.handled.has(item.key)) continue;
        this.handled.add(item.key);
        try {
          if (decide(item, lateMs) === "dispatch") {
            result.dispatched.push(item.key);
            await this.deps.publish.dispatch(item);
          } else {
            result.overdue.push(item.key);
            await this.deps.publish.markOverdue(item);
          }
        } catch (e) {
          this.deps.warn(`Could not run ${item.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private warnUnreadable(): void {
    for (const v of this.deps.index.variants()) {
      for (const id of v.invalidDeliveries ?? []) {
        if (!v.channels.includes(id)) continue;
        const key = `${v.path}#${id}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        this.deps.warn(`${v.file.basename}: the delivery status of ${id} can't be read, so it won't be published. Fix it in the note.`);
      }
    }
  }
}
```

- [ ] **Step 4: Dispatch and mark overdue in the publish service**

In `src/publish/actions.ts`, add imports:
```ts
import { transition } from "../model/stateMachine";
import { effectiveMethod } from "../platforms/registry";
import type { DueItem } from "../scheduler/due";
```
and these methods to `PublishActions`:
```ts
  /** Scheduler: a delivery's time has come. */
  async dispatch(item: DueItem): Promise<void> {
    const v = this.deps.index.getVariant(item.path);
    if (!v) return;
    const adapter = this.deps.adapters.get(v.platform);
    let method = effectiveMethod(v.mode, this.deps.channels.get(item.channelId), adapter);
    // Native channels are handed over when scheduled (M5). One still pending at its time is posted now, never skipped silently.
    if (method === "native") method = adapter?.publish ? "api" : "assisted";
    if (method === "api") {
      void this.runApi(item.path, item.channelId);
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
```

- [ ] **Step 5: Start the loop in the plugin**

In `test/fakes/obsidian.ts`, add to `class Component` after `registerEvent`:
```ts
  registerDomEvent(el: EventTarget, type: string, handler: (ev: Event) => unknown): void {
    el.addEventListener(type, handler);
    this.cleanups.push(() => el.removeEventListener(type, handler));
  }
```

In `src/main.ts`:
- add `import { Scheduler } from "./scheduler/scheduler";`
- add the field `scheduler!: Scheduler;` after `index!: SocialIndex;`
- right after `this.register(() => this.index.stop());` add:
```ts
    this.scheduler = new Scheduler({
      index: this.index,
      settings: () => this.settings,
      now: () => Date.now(),
      // M3 (#26) replaces this with the publisher-device setting; until then every device publishes.
      isPublisher: () => true,
      autoPostLateMs: () => null,
      publish: this.uiContext().publish,
      warn: (message) => new Notice(message, 0),
    });
    this.register(() => this.scheduler.stop());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.scheduler.tick();
    });
```
- replace the `onLayoutReady` callback with:
```ts
    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      this.index.start();
      await this.index.build();
      if (this.unloaded) return;
      this.scheduler.start();
      void this.scheduler.tick();
    });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat(scheduler): run due deliveries once, send late ones to the Overdue tray (refs #60)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Startup reconciliation — check_needed, overdue and the optional late auto-post (#61)

**Files:**
- Create: `src/scheduler/reconcile.ts`, `test/scheduler/reconcile.test.ts`
- Modify: `src/scheduler/scheduler.ts` (`SchedulerPort`, `reconcile`), `src/publish/orchestrator.ts` (`lookup`), `src/publish/actions.ts` (`markCheckNeeded`, `resolveCheck`), `src/settings/settings.ts`, `src/settings/tab.ts`, `src/main.ts`, `test/fakes/obsidian.ts` (`ToggleComponent`, `Setting.addToggle`), `test/main.test.ts`, `test/scheduler/scheduler.test.ts` (the test port gets the two new methods)

**Interfaces:**
- Consumes: `dueItems`, `decide` (Task 7); `PlatformAdapter.lookup`, `RemoteState` (M2a Task 1).
- Produces:
  - `type ReconcileAction = { kind: "check_needed"; path; channelId } | { kind: "dispatch"; item: DueItem } | { kind: "overdue"; item: DueItem }`, `reconcilePlan(variants, now, defaultStagger, autoPostLateMs): ReconcileAction[]`.
  - `SchedulerPort` gains `markCheckNeeded(path, channelId): Promise<boolean>` and `resolveCheck(path, channelId): Promise<void>`; `interface ReconcileSummary { checkNeeded; overdue; dispatched }`; `Scheduler.reconcile(): Promise<ReconcileSummary>` (publisher only; items it handles are not handled again by `tick`).
  - `PublishOrchestrator.lookup(path, channelId): Promise<RemoteState | null>`; `PublishActions.markCheckNeeded` (`publishing → check_needed` with an explanation in `error`; **never retried**), `PublishActions.resolveCheck` (`lookup()` says published → `published` with url; says not published → `failed`; can't tell → stays `check_needed` for the user).
  - Settings `autoPostLate: boolean` (default `false`) and `autoPostLateMinutes: number` (default `15`, 1–240); `autoPostLateMs(settings): number | null`; a "Publishing" section in the settings tab.
  - The plugin reconciles once after the index is built, then starts the loop.
  - Fake: `ToggleComponent` (`setValue`, `onChange`, `toggle(v)`), `Setting.addToggle`.

- [ ] **Step 1: Write the failing tests**

`test/scheduler/reconcile.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { formatDateTime } from "../../src/model/dates";
import type { RemoteState } from "../../src/platforms/types";
import { reconcilePlan } from "../../src/scheduler/reconcile";
import { Scheduler } from "../../src/scheduler/scheduler";
import { autoPostLateMs, migrateSettings } from "../../src/settings/settings";
import { indexed } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const MIN = 60_000;
const P = "Social/Posts/Tg.md";
const note = (path: string, at: number, delivery: Record<string, unknown>) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "telegram",
    channels: ["tg/event-x"],
    status: "scheduled",
    scheduled_at: formatDateTime(at),
    deliveries: { "tg/event-x": delivery },
  },
  body: "Doors open",
});

function scheduler(c: TestCtx, isPublisher = true) {
  return new Scheduler({
    index: c.index,
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => isPublisher,
    autoPostLateMs: () => autoPostLateMs(get(c.settings)),
    publish: c.ctx.publish,
    warn: () => undefined,
  });
}

async function withLookup(lookup: () => Promise<RemoteState | null>) {
  const c = await makeCtx({ notes: [note(P, T, { status: "publishing", at: formatDateTime(T) })], now: T + 10 * MIN });
  const publish = vi.fn(async () => ({ remoteId: "1", url: "https://t.me/eventx/1" }));
  c.adapters.register({ platform: "telegram", publish, lookup });
  return { c, publish };
}

describe("reconcilePlan", () => {
  it("marks stuck publishing, and sorts late items into dispatch or overdue", async () => {
    const c = await makeCtx({
      notes: [
        note("Social/Posts/Stuck.md", T, { status: "publishing" }),
        note("Social/Posts/Late.md", T - 60 * MIN, { status: "scheduled" }),
        note("Social/Posts/Now.md", T - MIN, { status: "scheduled" }),
      ],
    });
    const plan = reconcilePlan(c.index.variants(), T, 15, null);
    expect(plan.map((a) => (a.kind === "check_needed" ? `${a.kind}:${a.path}` : `${a.kind}:${a.item.path}`)).sort()).toEqual([
      "check_needed:Social/Posts/Stuck.md",
      "dispatch:Social/Posts/Now.md",
      "overdue:Social/Posts/Late.md",
    ]);
  });
});

describe("startup reconciliation (review focus 2)", () => {
  it("never retries a delivery found in publishing", async () => {
    const { c, publish } = await withLookup(async () => null);
    const s = scheduler(c);
    expect(await s.reconcile()).toEqual({ checkNeeded: 1, overdue: 0, dispatched: 0 });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
    await s.tick();
    c.now.set(T + 60 * MIN);
    await s.tick();
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({
      status: "check_needed",
      error: "Obsidian closed while this was being published. Check the platform, then mark it as published or not.",
    });
  });

  it("resolves with lookup() when the platform knows", async () => {
    const { c } = await withLookup(async () => ({ published: true, url: "https://t.me/eventx/5", remoteId: "5" }));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({
      status: "published",
      at: T,
      url: "https://t.me/eventx/5",
      remoteId: "5",
    });
  });

  it("marks it failed when lookup() finds nothing", async () => {
    const { c } = await withLookup(async () => ({ published: false }));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.error).toBe("Not found on the platform after an interrupted publish.");
  });

  it("leaves it for the user when lookup() fails", async () => {
    const { c } = await withLookup(async () => Promise.reject(new Error("offline")));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
  });

  it("sends past-due items to the Overdue tray, or posts them within the late window", async () => {
    const late = note(P, T - 40 * MIN, { status: "scheduled" });
    const c = await makeCtx({ notes: [late], now: T });
    expect(await scheduler(c).reconcile()).toEqual({ checkNeeded: 0, overdue: 1, dispatched: 0 });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "overdue");

    const c2 = await makeCtx({ notes: [late], now: T });
    c2.settings.update((s) => ({ ...s, autoPostLate: true, autoPostLateMinutes: 60 }));
    expect(await scheduler(c2).reconcile()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 1 });
    await indexed(c2.index, () => c2.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "awaiting_you");
  });

  it("does nothing on a device that is not the publisher", async () => {
    const { c } = await withLookup(async () => null);
    expect(await scheduler(c, false).reconcile()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 0 });
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.status).toBe("publishing");
  });
});

describe("late auto-post setting", () => {
  it("is off by default with a 15-minute window", () => {
    const s = migrateSettings({});
    expect([s.autoPostLate, s.autoPostLateMinutes, autoPostLateMs(s)]).toEqual([false, 15, null]);
    const on = migrateSettings({ autoPostLate: true, autoPostLateMinutes: 30 });
    expect(autoPostLateMs(on)).toBe(30 * MIN);
    expect(migrateSettings({ autoPostLate: "yes", autoPostLateMinutes: 999 })).toMatchObject({ autoPostLate: false, autoPostLateMinutes: 15 });
  });
});
```

In `test/main.test.ts`, in "renders the General settings and applies edits", change the expected names to:
```ts
    expect(Setting.all.map((s) => s.name)).toEqual([
      "General",
      "Root folder",
      "Week starts on",
      "Default reminders",
      "Default stagger",
      "Publishing",
      "Post late items automatically",
      "Late window (minutes)",
      "Channels",
      "Schedule templates",
      "Launch",
    ]);
```
and add, before `plugin.unload();` in that test:
```ts
    await (byName("Post late items automatically").components[0] as ToggleComponent).toggle(true);
    await (byName("Late window (minutes)").components[0] as TextComponent).change("45");
    expect([plugin.settings.autoPostLate, plugin.settings.autoPostLateMinutes]).toEqual([true, 45]);
```
(import `ToggleComponent` from `./fakes/obsidian` alongside `TextComponent`).

In `test/scheduler/scheduler.test.ts`, the `publish` port built in `build()` must satisfy the extended `SchedulerPort`; replace it with:
```ts
    publish: {
      dispatch: async (i: DueItem) => void calls.dispatched.push(i.key),
      markOverdue: async (i: DueItem) => void calls.overdue.push(i.key),
      markCheckNeeded: async () => false,
      resolveCheck: async () => undefined,
    },
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/scheduler/reconcile.test.ts test/main.test.ts`
Expected: FAIL — `reconcile` module missing; no Publishing settings.

- [ ] **Step 3: Add the setting**

In `src/settings/settings.ts`:
- add to `interface OsmmSettings` (after `defaultStaggerMinutes`):
```ts
  /** Spec §5.2: post items that are less than `autoPostLateMinutes` late instead of sending them to the Overdue tray. */
  autoPostLate: boolean;
  autoPostLateMinutes: number;
```
- add to `DEFAULT_SETTINGS` (after `defaultStaggerMinutes: 15,`):
```ts
  autoPostLate: false,
  autoPostLateMinutes: 15,
```
- in `sanitize`, add before `return {`:
```ts
  const lateMinutes = zMinutes.safeParse(raw.autoPostLateMinutes);
```
  and to the returned object (after `defaultStaggerMinutes`):
```ts
    autoPostLate: raw.autoPostLate === true,
    autoPostLateMinutes: lateMinutes.success && lateMinutes.data >= 1 && lateMinutes.data <= 240 ? lateMinutes.data : DEFAULT_SETTINGS.autoPostLateMinutes,
```
- add at the end of the file:
```ts
/** The late window in ms when late auto-posting is on, else null. */
export function autoPostLateMs(s: Pick<OsmmSettings, "autoPostLate" | "autoPostLateMinutes">): number | null {
  return s.autoPostLate ? s.autoPostLateMinutes * 60_000 : null;
}
```

In `src/settings/tab.ts`, after the "Default stagger" setting, add:
```ts
    new Setting(containerEl).setName("Publishing").setHeading();

    new Setting(containerEl)
      .setName("Post late items automatically")
      .setDesc("If Obsidian was closed at a post's time, post it anyway when it is less late than the window below. Otherwise it waits in the Overdue tray.")
      .addToggle((t) =>
        t.setValue(s.autoPostLate).onChange(async (value) => {
          await this.osmm.updateSettings({ autoPostLate: value });
        }),
      );

    new Setting(containerEl)
      .setName("Late window (minutes)")
      .setDesc("From 1 to 240 minutes.")
      .addText((t) =>
        t.setValue(String(s.autoPostLateMinutes)).onChange(async (value) => {
          const n = Number(value.trim());
          if (Number.isInteger(n) && n >= 1 && n <= 240) await this.osmm.updateSettings({ autoPostLateMinutes: n });
        }),
      );
```

In `test/fakes/obsidian.ts`, add before `class Setting`:
```ts
export class ToggleComponent {
  value = false;
  private cb: ((v: boolean) => unknown) | undefined;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(cb: (v: boolean) => unknown): this {
    this.cb = cb;
    return this;
  }
  /** Test helper: the user flips the toggle. */
  async toggle(v: boolean): Promise<void> {
    this.value = v;
    await this.cb?.(v);
  }
}
```
change the `components` field of `Setting` to `components: Array<TextComponent | DropdownComponent | TextAreaComponent | ButtonComponent | ToggleComponent> = [];` and add to `Setting`:
```ts
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    const c = new ToggleComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
```

- [ ] **Step 4: Write the plan and the reconcile pass**

`src/scheduler/reconcile.ts`:
```ts
import type { IndexedVariant } from "../index/socialIndex";
import { decide, dueItems, type DueItem } from "./due";

export type ReconcileAction =
  | { kind: "check_needed"; path: string; channelId: string }
  | { kind: "dispatch"; item: DueItem }
  | { kind: "overdue"; item: DueItem };

/**
 * Startup (spec §5.1–5.2): a delivery left in `publishing` becomes check_needed and is never retried;
 * a past-due scheduled delivery goes to the Overdue tray unless it is within the grace or auto-post window.
 */
export function reconcilePlan(
  variants: readonly IndexedVariant[],
  now: number,
  defaultStagger: number,
  autoPostLateMs: number | null,
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const v of variants) {
    for (const id of v.channels) if (v.deliveries[id]?.status === "publishing") actions.push({ kind: "check_needed", path: v.path, channelId: id });
  }
  for (const item of dueItems(variants, now, defaultStagger)) {
    actions.push({ kind: decide(item, autoPostLateMs) === "dispatch" ? "dispatch" : "overdue", item });
  }
  return actions;
}
```

In `src/scheduler/scheduler.ts`:
- add `import { reconcilePlan } from "./reconcile";`
- add to `interface SchedulerPort`:
```ts
  /** `publishing → check_needed`; false when the delivery changed meanwhile. */
  markCheckNeeded(path: string, channelId: string): Promise<boolean>;
  /** Asks the platform whether an interrupted publish went out, where the adapter can tell. */
  resolveCheck(path: string, channelId: string): Promise<void>;
```
- add after `TickResult`:
```ts
export interface ReconcileSummary {
  checkNeeded: number;
  overdue: number;
  dispatched: number;
}
```
- add to `class Scheduler`:
```ts
  /** Runs once at startup, before the loop (publisher only). */
  async reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { checkNeeded: 0, overdue: 0, dispatched: 0 };
    if (!this.deps.isPublisher()) return summary;
    const plan = reconcilePlan(this.deps.index.variants(), this.deps.now(), this.deps.settings().defaultStaggerMinutes, this.deps.autoPostLateMs());
    for (const action of plan) {
      try {
        if (action.kind === "check_needed") {
          if (await this.deps.publish.markCheckNeeded(action.path, action.channelId)) {
            summary.checkNeeded++;
            await this.deps.publish.resolveCheck(action.path, action.channelId);
          }
          continue;
        }
        if (this.handled.has(action.item.key)) continue;
        this.handled.add(action.item.key);
        if (action.kind === "dispatch") {
          summary.dispatched++;
          await this.deps.publish.dispatch(action.item);
        } else {
          summary.overdue++;
          await this.deps.publish.markOverdue(action.item);
        }
      } catch (e) {
        this.deps.warn(`Could not check ${action.kind === "check_needed" ? action.path : action.item.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return summary;
  }
```

In `src/publish/orchestrator.ts`, change the types import to `import type { DeliveryJob, MediaInfo, PlatformAdapter, RemoteState } from "../platforms/types";` and add to `PublishOrchestrator`:
```ts
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
    try {
      return await adapter.lookup({ variant: v, channel, delivery, text: items.join("\n\n"), items, media: content.media, secret });
    } catch {
      return null;
    }
  }
```

In `src/publish/actions.ts`, add to `PublishActions`:
```ts
  /** Startup: Obsidian closed mid-publish. The delivery is never retried automatically (spec §5.1). */
  async markCheckNeeded(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const result = await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "publishing") return { refuse: "The delivery changed." };
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
    await this.deps.writer.updateVariant(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "check_needed") return { refuse: "The delivery changed." };
      if (!state.published) return { deliveries: { [channelId]: transition(d, "failed", { error: "Not found on the platform after an interrupted publish." }) } };
      const next = transition(d, "published", { ...(state.url ? { url: state.url } : {}), ...(state.remoteId ? { remoteId: state.remoteId } : {}) });
      delete next.error;
      return { deliveries: { [channelId]: next } };
    });
  }
```

In `src/main.ts`:
- change the settings import to `import { autoPostLateMs, migrateSettings, type OsmmSettings } from "./settings/settings";`
- in the `Scheduler` deps, replace `autoPostLateMs: () => null,` with `autoPostLateMs: () => autoPostLateMs(this.settings),`
- in `onLayoutReady`, replace `this.scheduler.start();` with:
```ts
      await this.scheduler.reconcile();
      if (this.unloaded) return;
      this.scheduler.start();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(scheduler): reconcile at startup; never retry publishing; optional late auto-post (refs #61)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Desktop notifications for reminders, due posts and failures (#64)

**Files:**
- Create: `src/reminders/reminders.ts`, `src/reminders/ledger.ts`, `src/reminders/notifier.ts`, `src/reminders/service.ts`, `test/reminders/reminders.test.ts`, `test/reminders/notifier.test.ts`
- Modify: `src/settings/device.ts` (`notifications`), `src/settings/tab.ts`, `src/main.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: `PostRow` (M1); `effectiveMethod`, `AdapterRegistry` (M2a); `FailureInfo`, `DeliveryNotifier`, `PublishActions.openAssisted`, `ComposerActions.openComposer`; `Scheduler.onTick` (Task 7).
- Produces:
  - `interface ReminderItem { key; path; channelId; at; minutes; title }` (`key` = row key + due time + offset), `REMINDER_WINDOW_MS = 5 minutes`, `dueReminders(rows, now, previous, offsets): ReminderItem[]` — reminders whose time fell in `(previous, now]`, never older than 5 minutes (no burst of stale reminders at start-up), only for scheduled rows before their time, offsets > 0.
  - `class NotifiedLedger { constructor(app, now); has(key); add(key): boolean }` — device-local (`app.saveLocalStorage("osmm-notified")`), entries kept 14 days.
  - `interface NotifierDeps { ledger; enabled(); channelName(id); noteTitle(path); openAssisted(path, ids); openComposer(path); snoozeMs?; setTimer? }`, `class Notifier implements DeliveryNotifier { reminder(item); due(path, channelId); failed(info) }` — always an in-app Notice that stays until dismissed, with **Open & post** / **Snooze 10 min** (reminders), **Open & post** (due) or **Fix** (failures); plus a system notification when the Obsidian window is not focused (click = the first action); asks for permission once when it is still "default". A reminder is shown once per device (ledger), and again after each snooze.
  - `class ReminderService { offsets(row): readonly number[] | null; tick(now, previous): ReminderItem[] }` — offsets from the variant, else the channel, else the settings; only for channels that will not post by themselves (effective method `assisted`).
  - `DeviceSettings.notifications: boolean` (default `true`; device-local); the settings toggle "Desktop notifications on this device".
  - The plugin wires the notifier into `PublishActions.notifier` and runs `ReminderService.tick` from `Scheduler.onTick` (every device).

- [ ] **Step 1: Write the failing tests**

`test/reminders/reminders.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/model/dates";
import { dueReminders } from "../../src/reminders/reminders";
import { ReminderService } from "../../src/reminders/service";
import type { Notifier } from "../../src/reminders/notifier";
import type { ReminderItem } from "../../src/reminders/reminders";
import { makeCtx } from "../ui/ctx";
import { get } from "svelte/store";

const MIN = 60_000;
const AT = Date.UTC(2026, 9, 12, 16); // Mon 12 Oct 2026, 18:00 Berlin
const P = "Social/Posts/R.md";
const note = (extra: Record<string, unknown> = {}) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(AT), reminders: [60, 10, 0], ...extra },
  body: "Hi",
});

describe("dueReminders", () => {
  it.each([
    ["the 60-minute reminder between two ticks", AT - 60 * MIN - 30_000, AT - 60 * MIN + 30_000, [60]],
    ["the 10-minute reminder between two ticks", AT - 10 * MIN - 30_000, AT - 10 * MIN, [10]],
    ["nothing between reminders", AT - 30 * MIN, AT - 29 * MIN, []],
    ["a reminder just missed at start-up (within 5 minutes)", null, AT - 57 * MIN, [60]],
    ["no stale reminder at start-up", null, AT - 50 * MIN, []],
    ["nothing once the post time has passed", AT - 30_000, AT + 30_000, []],
  ])("%s", async (_name, previous, now, minutes) => {
    const c = await makeCtx({ notes: [note()] });
    const rows = c.ctx.actions.rows();
    expect(dueReminders(rows, now, previous, (r) => r.variant.reminders ?? null).map((i) => i.minutes)).toEqual(minutes);
  });

  it("keys each reminder by row, due time and offset", async () => {
    const c = await makeCtx({ notes: [note()] });
    expect(dueReminders(c.ctx.actions.rows(), AT - 60 * MIN, AT - 61 * MIN, () => [60])[0]).toEqual({
      key: `${P}#bs/you@${AT}:60`,
      path: P,
      channelId: "bs/you",
      at: AT,
      minutes: 60,
      title: "Hi",
    });
  });
});

describe("ReminderService", () => {
  it("reminds only for channels that won't post by themselves", async () => {
    const c = await makeCtx({ notes: [note({ reminders: undefined })] });
    const seen: ReminderItem[] = [];
    const service = new ReminderService({
      rows: () => c.ctx.actions.rows(),
      channels: c.ctx.channels,
      adapters: c.adapters,
      settings: () => get(c.settings),
      notifier: { reminder: (i: ReminderItem) => void seen.push(i) } as unknown as Notifier,
    });
    const row = c.ctx.actions.rows().find((r) => r.variant.path === P)!;
    expect(service.offsets(row)).toEqual([60, 10]);
    expect(service.tick(AT - 60 * MIN, AT - 61 * MIN).map((i) => i.minutes)).toEqual([60]);
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/x" }) });
    expect(service.offsets(c.ctx.actions.rows().find((r) => r.variant.path === P)!)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
```

`test/reminders/notifier.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { Notice } from "../fakes/obsidian";
import { browser, FakeNotification } from "../fakes/browser";
import { NotifiedLedger } from "../../src/reminders/ledger";
import { Notifier, type NotifierDeps } from "../../src/reminders/notifier";
import type { ReminderItem } from "../../src/reminders/reminders";
import { loadDeviceSettings, saveDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";

const item: ReminderItem = { key: "p.md#bs/you@1:10", path: "p.md", channelId: "bs/you", at: 1, minutes: 10, title: "Event X is back" };

function build(over: Partial<NotifierDeps> = {}, app = createApp()) {
  const opened: Array<[string, string[]]> = [];
  const composed: string[] = [];
  const timers: Array<() => void> = [];
  const notifier = new Notifier({
    ledger: new NotifiedLedger(app as never, () => 1_000),
    enabled: () => true,
    channelName: () => "@you.bsky.social",
    noteTitle: () => "Event X is back",
    openAssisted: (path, ids) => void opened.push([path, ids]),
    openComposer: (path) => void composed.push(path),
    setTimer: (fn) => void timers.push(fn),
    ...over,
  });
  return { notifier, opened, composed, timers, app };
}

const lastNoticeButton = (label: string) => [...Notice.last!.noticeEl.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("Notifier", () => {
  it("shows an in-app notice with Open & post and Snooze while Obsidian is focused", () => {
    const { notifier, opened } = build();
    notifier.reminder(item);
    expect(Notice.messages.at(-1)).toContain("In 10 min: Event X is back · Post to @you.bsky.social.");
    expect(browser.notifications).toEqual([]);
    lastNoticeButton("Open & post").click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
    expect(Notice.last!.hidden).toBe(true);
  });

  it("also raises a system notification when the window is in the background", () => {
    browser.focused = false;
    const { notifier, opened } = build();
    notifier.reminder(item);
    expect(browser.notifications.map((n) => [n.title, n.options.body])).toEqual([["In 10 min: Event X is back", "Post to @you.bsky.social."]]);
    browser.notifications[0]!.click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
  });

  it("asks for permission once instead of notifying when it hasn't been granted yet", () => {
    browser.focused = false;
    FakeNotification.permission = "default";
    build().notifier.reminder(item);
    expect(FakeNotification.requested).toBe(1);
    expect(browser.notifications).toEqual([]);
  });

  it("shows each reminder once per device, even after a restart (review focus 5)", () => {
    const app = createApp();
    const first = build({}, app);
    const count = Notice.messages.length;
    first.notifier.reminder(item);
    first.notifier.reminder(item);
    build({}, app).notifier.reminder(item);
    expect(Notice.messages.length).toBe(count + 1);
  });

  it("shows the reminder again after a snooze", () => {
    const { notifier, timers } = build();
    notifier.reminder(item);
    const count = Notice.messages.length;
    lastNoticeButton("Snooze 10 min").click();
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(Notice.messages.length).toBe(count + 1);
    expect(Notice.messages.at(-1)).toContain("In 10 min: Event X is back");
  });

  it("stays quiet when notifications are off on this device", () => {
    const { notifier } = build({ enabled: () => false });
    const count = Notice.messages.length;
    notifier.reminder(item);
    notifier.due("p.md", "bs/you");
    expect(Notice.messages.length).toBe(count);
  });

  it("reports due posts and failures with their actions", () => {
    const { notifier, opened, composed } = build();
    notifier.due("p.md", "bs/you");
    expect(Notice.messages.at(-1)).toContain("Time to post: Event X is back · @you.bsky.social is waiting for you.");
    lastNoticeButton("Open & post").click();
    notifier.failed({ path: "p.md", channelId: "bs/you", kind: "needs_user", error: "Token expired" });
    expect(Notice.messages.at(-1)).toContain("Couldn't publish: Event X is back · @you.bsky.social: Token expired");
    lastNoticeButton("Fix").click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
    expect(composed).toEqual(["p.md"]);
  });
});

describe("NotifiedLedger", () => {
  it("forgets entries after 14 days", () => {
    const app = createApp();
    let now = 0;
    const ledger = new NotifiedLedger(app as never, () => now);
    expect(ledger.add("a")).toBe(true);
    expect(ledger.add("a")).toBe(false);
    now = 15 * 86_400_000;
    ledger.add("b");
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("b")).toBe(true);
  });
});

describe("device notifications setting", () => {
  it("is on by default and persists per device", () => {
    const app = createApp();
    const device = loadDeviceSettings(app as never);
    expect(device.notifications).toBe(true);
    saveDeviceSettings(app as never, { ...device, notifications: false });
    expect(loadDeviceSettings(app as never).notifications).toBe(false);
  });
});

describe("Notifier timers", () => {
  it("snoozes with a real timer by default", () => {
    vi.useFakeTimers();
    try {
      const { notifier } = build({ setTimer: undefined });
      notifier.reminder({ ...item, key: "other" });
      const count = Notice.messages.length;
      lastNoticeButton("Snooze 10 min").click();
      vi.advanceTimersByTime(10 * 60_000);
      expect(Notice.messages.length).toBe(count + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

In `test/main.test.ts`, extend the expected settings names: after `"Late window (minutes)",` add `"Desktop notifications on this device",`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/reminders test/main.test.ts`
Expected: FAIL — `reminders` modules missing.

- [ ] **Step 3: Write reminders, ledger, notifier and service**

`src/reminders/reminders.ts`:
```ts
import type { PostRow } from "../index/queries";
import { MINUTE } from "../model/dates";

export interface ReminderItem {
  /** Row key + due time + offset: one reminder, whatever the number of ticks. */
  key: string;
  path: string;
  channelId: string;
  at: number;
  minutes: number;
  title: string;
}

/** Reminders missed by more than this (Obsidian closed, laptop asleep) are not shown. */
export const REMINDER_WINDOW_MS = 5 * MINUTE;

/**
 * Reminders whose time fell between the previous tick and now. `offsets` gives the minutes-before list
 * for a row, or null for rows that will post by themselves.
 */
export function dueReminders(
  rows: readonly PostRow[],
  now: number,
  previous: number | null,
  offsets: (row: PostRow) => readonly number[] | null,
): ReminderItem[] {
  const from = Math.max(previous ?? Number.NEGATIVE_INFINITY, now - REMINDER_WINDOW_MS);
  const out: ReminderItem[] = [];
  for (const row of rows) {
    if (!row.channelId || row.status !== "scheduled" || row.at === undefined || row.at <= now) continue;
    for (const minutes of offsets(row) ?? []) {
      if (minutes <= 0) continue;
      const fireAt = row.at - minutes * MINUTE;
      if (fireAt <= from || fireAt > now) continue;
      out.push({ key: `${row.key}@${row.at}:${minutes}`, path: row.variant.path, channelId: row.channelId, at: row.at, minutes, title: row.variant.displayTitle });
    }
  }
  return out.sort((a, b) => a.at - a.minutes * MINUTE - (b.at - b.minutes * MINUTE) || a.key.localeCompare(b.key));
}
```

`src/reminders/ledger.ts`:
```ts
import type { App } from "obsidian";
import { DAY } from "../model/dates";
import { isRecord } from "../model/frontmatter";

const KEY = "osmm-notified";
const KEEP_MS = 14 * DAY;

/** Device-local record of the reminders already shown, so each fires once per device, across restarts. */
export class NotifiedLedger {
  constructor(
    private readonly app: App,
    private readonly now: () => number,
  ) {}

  private read(): Record<string, number> {
    const raw: unknown = this.app.loadLocalStorage(KEY);
    const out: Record<string, number> = {};
    if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
    return out;
  }

  has(key: string): boolean {
    return key in this.read();
  }

  /** Records the key; false when it was already recorded. Entries older than 14 days are dropped. */
  add(key: string): boolean {
    const all = this.read();
    if (key in all) return false;
    const now = this.now();
    all[key] = now;
    for (const [k, t] of Object.entries(all)) if (now - t > KEEP_MS) delete all[k];
    this.app.saveLocalStorage(KEY, all);
    return true;
  }
}
```

`src/reminders/notifier.ts`:
```ts
import { Notice } from "obsidian";
import type { DeliveryNotifier } from "../publish/actions";
import type { FailureInfo } from "../publish/orchestrator";
import type { NotifiedLedger } from "./ledger";
import type { ReminderItem } from "./reminders";

export interface NotifierDeps {
  ledger: NotifiedLedger;
  /** The device-local "Desktop notifications on this device" setting. */
  enabled(): boolean;
  channelName(channelId: string): string;
  noteTitle(path: string): string;
  openAssisted(path: string, channelIds: string[]): void;
  openComposer(path: string): void;
  snoozeMs?: number;
  setTimer?(fn: () => void, ms: number): void;
}

interface NoticeAction {
  label: string;
  run(): void;
}

const SNOOZE_MS = 10 * 60_000;

/** Desktop reminders (spec §4.4): an in-app notice with actions, plus a system notification when Obsidian is in the background. */
export class Notifier implements DeliveryNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  reminder(item: ReminderItem): void {
    if (!this.deps.ledger.add(item.key)) return;
    this.showReminder(item);
  }

  due(path: string, channelId: string): void {
    const channel = this.deps.channelName(channelId);
    this.show(`Time to post: ${this.deps.noteTitle(path)}`, `${channel} is waiting for you.`, [
      { label: "Open & post", run: () => this.deps.openAssisted(path, [channelId]) },
    ]);
  }

  failed(info: FailureInfo): void {
    this.show(`Couldn't publish: ${this.deps.noteTitle(info.path)}`, `${this.deps.channelName(info.channelId)}: ${info.error}`, [
      { label: "Fix", run: () => this.deps.openComposer(info.path) },
    ]);
  }

  private showReminder(item: ReminderItem): void {
    const snoozeMs = this.deps.snoozeMs ?? SNOOZE_MS;
    this.show(`In ${item.minutes} min: ${item.title}`, `Post to ${this.deps.channelName(item.channelId)}.`, [
      { label: "Open & post", run: () => this.deps.openAssisted(item.path, [item.channelId]) },
      { label: `Snooze ${Math.round(snoozeMs / 60_000)} min`, run: () => this.snooze(item, snoozeMs) },
    ]);
  }

  private snooze(item: ReminderItem, ms: number): void {
    const set = this.deps.setTimer ?? ((fn: () => void, t: number) => void setTimeout(fn, t));
    set(() => this.showReminder(item), ms);
  }

  private show(title: string, body: string, actions: NoticeAction[]): void {
    if (!this.deps.enabled()) return;
    const fragment = document.createDocumentFragment();
    const text = document.createElement("div");
    text.textContent = `${title} · ${body}`;
    const buttons = actions.map((a) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = a.label;
      return button;
    });
    fragment.append(text, ...buttons);
    const notice = new Notice(fragment, 0);
    buttons.forEach((button, i) =>
      button.addEventListener("click", () => {
        actions[i]!.run();
        notice.hide();
      }),
    );
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    if (Notification.permission === "granted") {
      const system = new Notification(title, { body });
      system.onclick = () => {
        window.focus();
        actions[0]?.run();
        notice.hide();
        system.close();
      };
    } else if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }
}
```

`src/reminders/service.ts`:
```ts
import type { ChannelRegistry } from "../channels/registry";
import type { PostRow } from "../index/queries";
import { effectiveMethod, type AdapterRegistry } from "../platforms/registry";
import type { OsmmSettings } from "../settings/settings";
import type { Notifier } from "./notifier";
import { dueReminders, type ReminderItem } from "./reminders";

export interface ReminderServiceDeps {
  rows(): PostRow[];
  channels: ChannelRegistry;
  adapters: AdapterRegistry;
  settings(): OsmmSettings;
  notifier: Pick<Notifier, "reminder">;
}

/** Turns reminder offsets into notifications; runs on every tick on every device (spec §4.3). */
export class ReminderService {
  constructor(private readonly deps: ReminderServiceDeps) {}

  /** Minutes-before list for a row; null when the channel posts by itself (API or native). */
  offsets(row: PostRow): readonly number[] | null {
    if (!row.channelId) return null;
    const channel = this.deps.channels.get(row.channelId);
    if (effectiveMethod(row.variant.mode, channel, this.deps.adapters.get(row.variant.platform)) !== "assisted") return null;
    return row.variant.reminders ?? channel?.defaultReminders ?? this.deps.settings().defaultReminders;
  }

  tick(now: number, previous: number | null): ReminderItem[] {
    const items = dueReminders(this.deps.rows(), now, previous, (row) => this.offsets(row));
    for (const item of items) this.deps.notifier.reminder(item);
    return items;
  }
}
```

- [ ] **Step 4: Add the device setting and wire everything**

`src/settings/device.ts` (replace the file):
```ts
import type { App } from "obsidian";
import { isRecord } from "../model/frontmatter";

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
  /** Desktop notifications on this device (spec §4.3: each device fires its own if enabled). */
  notifications: boolean;
}

const KEY = "osmm-device";

export function loadDeviceSettings(app: App): DeviceSettings {
  const raw: unknown = app.loadLocalStorage(KEY);
  if (isRecord(raw) && typeof raw.deviceId === "string") return { deviceId: raw.deviceId, notifications: raw.notifications !== false };
  const created: DeviceSettings = { deviceId: crypto.randomUUID(), notifications: true };
  saveDeviceSettings(app, created);
  return created;
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  app.saveLocalStorage(KEY, settings);
}
```

In `src/settings/tab.ts`, add `import { saveDeviceSettings } from "./device";` and, after the "Late window (minutes)" setting:
```ts
    new Setting(containerEl)
      .setName("Desktop notifications on this device")
      .setDesc("Reminders before assisted posts, when a post is due, and when publishing fails. Stored on this device only.")
      .addToggle((t) =>
        t.setValue(this.osmm.device.notifications).onChange((value) => {
          this.osmm.device = { ...this.osmm.device, notifications: value };
          saveDeviceSettings(this.app, this.osmm.device);
        }),
      );
```

In `src/main.ts`:
- add imports:
```ts
import { NotifiedLedger } from "./reminders/ledger";
import { Notifier } from "./reminders/notifier";
import { ReminderService } from "./reminders/service";
```
- add the field `reminders!: ReminderService;` after `scheduler!: Scheduler;`
- replace the block that creates the scheduler (from `this.scheduler = new Scheduler({` to its closing `});`) with:
```ts
    const ui = this.uiContext();
    const notifier = new Notifier({
      ledger: new NotifiedLedger(this.app, () => Date.now()),
      enabled: () => this.device.notifications,
      channelName: (id) => this.channels.get(id)?.name ?? id,
      noteTitle: (path) => this.index.getVariant(path)?.displayTitle ?? path,
      openAssisted: (path, ids) => void ui.publish.openAssisted(path, ids),
      openComposer: (path) => void ui.composer.openComposer(path),
    });
    ui.publish.notifier = notifier;
    this.reminders = new ReminderService({
      rows: () => ui.actions.rows(),
      channels: this.channels,
      adapters: this.adapters,
      settings: () => this.settings,
      notifier,
    });
    this.scheduler = new Scheduler({
      index: this.index,
      settings: () => this.settings,
      now: () => Date.now(),
      // M3 (#26) replaces this with the publisher-device setting; until then every device publishes.
      isPublisher: () => true,
      autoPostLateMs: () => autoPostLateMs(this.settings),
      publish: ui.publish,
      onTick: (now, previous) => void this.reminders.tick(now, previous),
      warn: (message) => new Notice(message, 0),
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (`test/settings/settings.test.ts` still passes: loading twice returns equal settings, now with `notifications: true`).

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(reminders): desktop notifications for reminders, due posts and failures (refs #64)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Overdue tray actions, Needs attention, startup banner and Post now (#63, #52 "Post now")

**Files:**
- Create: `test/publish/overdueTray.test.ts`, `test/planner/templateMove.test.ts`
- Modify: `src/publish/actions.ts` (`postNow`, `resolveNotPublished`, `overdueBanner`), `src/views/Sidebar.svelte`, `src/views/CampaignTable.svelte` ("Post now" on overdue rows), `src/composer/ActionsBar.svelte` ("Post now", blocking), `src/composer/Composer.svelte`, `src/ui/actions.ts` (past-time confirm in `reschedule`; `applyTemplate`), `src/planner/templates.ts` (`templateMovable`, `planTemplateMove`), `src/main.ts` (banner), `src/styles/planner.css`, `test/ui/reschedule.test.ts`

**Interfaces:**
- Consumes: `assistedQueue`, `openAssisted` (Task 5); `runApi` (Task 6); `effectiveMethod`; `overdueRows` (M1); `activateView`, `VIEW_SIDEBAR` (M1); `Scheduler.reconcile` (Task 8).
- Produces:
  - `PublishActions.postNow(path, channelIds?)` — API-capable channels run through the orchestrator at once; the others open the assisted flow; "Nothing left to post" when the queue is empty.
  - `PublishActions.resolveNotPublished(path, channelId): Promise<boolean>` — the user checked: `check_needed → failed` ("Not published (checked by you)."), with Undo.
  - `PublishActions.overdueBanner(count)` — the startup banner: "N posts are overdue." with **Review** (opens the sidebar queue).
  - Sidebar: the Overdue tray gets **Post now** next to Reschedule and Skip; a new **Needs attention** section lists failed deliveries (**Post again**, **Fix**) and check-needed ones (**It went out** → assisted flow at the confirm step, **It didn't**). Counts update live from the index.
  - `social-variants` table (spec §2.1): an overdue variant's row gets **Post now**.
  - Composer action row: **Post now**; Post now and Copy & open are disabled while there are blocking issues (`<ActionsBar variant issues>`).
  - Parked M1 items: `PlannerActions.reschedule` asks before moving a post to a time in the past; `templateMovable(v)` and `planTemplateMove(fresh, to): VariantUpdate | { refuse }` — a template never moves a post that is publishing or check-needed, turns overdue deliveries back into scheduled ones, and moves explicit per-channel times with the post (drops them when the post had no time yet); `applyTemplate` uses it.

- [ ] **Step 1: Write the failing tests**

`test/publish/overdueTray.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { Modal, Notice } from "../fakes/obsidian";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import { VIEW_SIDEBAR } from "../../src/ui/actions";
import { osmmContext } from "../../src/ui/context";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const IG = "Social/Event X/Event X – Instagram.md";
const TG = "Social/Event X/Event X – Telegram.md";
const CHECK = "Social/Posts/Check.md";
const checkNote = {
  path: CHECK,
  frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "attention", deliveries: { "tg/event-x": { status: "check_needed" } } },
  body: "Doors open",
};

describe("Overdue tray", () => {
  it("posts an overdue item now through the assisted flow", async () => {
    const c = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(c.ctx) });
    const tray = screen.getByRole("region", { name: /Overdue/ });
    await fireEvent.click(within(tray).getByRole("button", { name: "Post One evening. Eighty makers. Laptops open. now" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Instagram · @acmestudio (1 of 1)"));
    Modal.opened.at(-1)?.close();
  });

  it("posts through the API where an adapter exists", async () => {
    const c = await makeCtx({ seed: true });
    c.adapters.register({ platform: "instagram", publish: async () => ({ remoteId: "1", url: "https://www.instagram.com/p/1" }) });
    await c.ctx.publish.postNow(IG);
    await indexed(c.index, () => c.index.getVariant(IG)?.status === "published");
  });

  it("updates its count live", async () => {
    const c = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Overdue · 2" })).toBeTruthy();
    await c.ctx.publish.skip(IG, "ig/acmestudio");
    await vi.waitFor(() => expect(screen.getByRole("region", { name: "Overdue · 1" })).toBeTruthy());
  });

  it("shows a startup banner that opens the queue", async () => {
    const c = await makeCtx({ seed: true });
    c.ctx.publish.overdueBanner(2);
    expect(Notice.messages.at(-1)).toBe("2 posts are overdue. Review");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType(VIEW_SIDEBAR)).toHaveLength(1));
    const count = Notice.messages.length;
    c.ctx.publish.overdueBanner(0);
    expect(Notice.messages.length).toBe(count);
  });
});

describe("Needs attention", () => {
  it("offers Post again and Fix for a failed delivery", async () => {
    const c = await makeCtx({ seed: true });
    const open = vi.spyOn(c.ctx.composer, "openComposer").mockResolvedValue();
    render(Sidebar, { context: osmmContext(c.ctx) });
    const section = screen.getByRole("region", { name: "Needs attention · 1" });
    expect(section.textContent).toContain("Bot is not an admin of the channel");
    await fireEvent.click(within(section).getByRole("button", { name: "Fix" }));
    expect(open).toHaveBeenCalledWith(TG);
    await fireEvent.click(within(section).getByRole("button", { name: "Post again" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Telegram · Event X channel (1 of 1)"));
    Modal.opened.at(-1)?.close();
  });

  it("resolves a check-needed delivery either way", async () => {
    const c = await makeCtx({ seed: true, notes: [checkNote] });
    render(Sidebar, { context: osmmContext(c.ctx) });
    const section = screen.getByRole("region", { name: "Needs attention · 2" });
    await fireEvent.click(within(section).getByRole("button", { name: "It went out" }));
    expect(Modal.opened.at(-1)?.contentEl.querySelector("input[type=url]")).not.toBeNull();
    Modal.opened.at(-1)?.close();
    await fireEvent.click(within(section).getByRole("button", { name: "It didn't" }));
    await indexed(c.index, () => c.index.getVariant(CHECK)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(CHECK)!.deliveries["tg/event-x"]?.error).toBe("Not published (checked by you).");
  });
});

describe("Campaign table Post now", () => {
  it("posts an overdue variant from the social-variants table", async () => {
    const c = await makeCtx({ seed: true });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Post Instagram variant now" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Instagram · @acmestudio (1 of 1)"));
    Modal.opened.at(-1)?.close();
    expect(screen.queryByRole("button", { name: "Post X variant now" })).toBeNull();
  });
});

describe("Composer Post now", () => {
  it("is disabled while there are blocking issues", async () => {
    const c = await makeCtx({ seed: true });
    const issues = [{ level: "error" as const, field: "media", message: "Instagram needs an image." }];
    render(ActionsBar, { props: { variant: c.index.getVariant(IG)!, issues }, context: osmmContext(c.ctx) });
    expect((screen.getByRole("button", { name: "Post now" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy & open" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when nothing is left to post", async () => {
    const c = await makeCtx({ seed: true });
    await c.ctx.publish.postNow("Social/Posts/Weekly devlog 12.md");
    expect(Notice.messages.at(-1)).toBe("Nothing left to post for this note.");
  });
});
```

`test/planner/templateMove.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { planTemplateMove, templateMovable } from "../../src/planner/templates";

const T = 1_000_000;
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "overdue",
  scheduledAt: T,
  media: [],
  deliveries: {},
  ...extra,
});

describe("planTemplateMove (parked M1 item)", () => {
  it("turns overdue deliveries back into scheduled ones and moves explicit times", () => {
    const post = v({ deliveries: { "li/me": { status: "overdue" }, "li/acme": { status: "scheduled", at: T + 900 } } });
    expect(planTemplateMove(post, T + 5000)).toEqual({
      fields: { scheduledAt: T + 5000 },
      deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled", at: T + 5900 } },
    });
  });

  it("drops explicit times when the post had no time yet", () => {
    const post = v({ scheduledAt: undefined, status: "draft", deliveries: { "li/acme": { status: "draft", at: T } } });
    expect(planTemplateMove(post, T + 5000)).toEqual({ fields: { scheduledAt: T + 5000 }, deliveries: { "li/acme": { status: "draft" } } });
  });

  it("never moves a post that is being published or needs a check", () => {
    expect(templateMovable(v({ deliveries: { "li/me": { status: "publishing" } } }))).toBe(false);
    expect(planTemplateMove(v({ deliveries: { "li/me": { status: "check_needed" } } }), T)).toEqual({ refuse: "locked" });
    expect(templateMovable(v())).toBe(true);
  });
});
```

Add to `test/ui/reschedule.test.ts`, inside `describe("PlannerActions.reschedule", …)`:
```ts
  it("asks before moving a post into the past (parked M1 item)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const asked: string[] = [];
    ctx.actions.confirm = async (message) => {
      asked.push(message);
      return false;
    };
    const row = ctx.actions.rowByKey("Social/Event X/Event X – Bluesky.md#bs/you")!;
    expect(await ctx.actions.reschedule(row, { at: TEST_NOW - 3_600_000 })).toBe(false);
    expect(asked).toEqual(["That time is in the past, so the post will show as overdue until you post or move it. Move it anyway?"]);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(row.variant.scheduledAt);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/publish/overdueTray.test.ts test/planner/templateMove.test.ts test/ui/reschedule.test.ts`
Expected: FAIL — `postNow` missing; no Post now button; no past-time confirm; `planTemplateMove` missing.

- [ ] **Step 3: Add the publish actions**

In `src/publish/actions.ts`, add imports:
```ts
import { VIEW_SIDEBAR } from "../ui/actions";
import { activateView } from "../views/PlannerView";
```
(change the existing `import type { PlannerActions } from "../ui/actions";` to `import { VIEW_SIDEBAR, type PlannerActions } from "../ui/actions";`) and add to `PublishActions`:
```ts
  /** Post now (Overdue tray, Needs attention, composer, context menu): API channels run at once, the rest opens the assisted flow. */
  async postNow(path: string, channelIds?: readonly string[]): Promise<void> {
    const v = this.deps.index.getVariant(path);
    if (!v) return;
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
    for (const id of viaApi) void this.runApi(path, id);
    const assisted = queue.filter((id) => !viaApi.includes(id));
    if (assisted.length) this.openAssisted(path, assisted);
  }

  /** The user checked the platform: the interrupted publish did not go out. */
  async resolveNotPublished(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const name = this.channelName(channelId);
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "check_needed") return { refuse: `${name} no longer needs a check.` };
      return { deliveries: { [channelId]: transition(d, "failed", { error: "Not published (checked by you)." }) } };
    });
    if (!result.ok) {
      new Notice(result.reason);
      return false;
    }
    this.deps.planner.undoNotice(`Marked ${name} as not published.`, () => this.deps.planner.undo([result.record]));
    return true;
  }

  /** The startup banner (artboard 6). */
  overdueBanner(count: number): void {
    if (count === 0) return;
    this.deps.planner.actionNotice(`${count} post${count === 1 ? " is" : "s are"} overdue.`, "Review", () => activateView(this.deps.app, VIEW_SIDEBAR, "right"));
  }
```

- [ ] **Step 4: Extend the sidebar and the composer action row**

`src/views/Sidebar.svelte` (replace the file):
```svelte
<script lang="ts">
  import { campaignProgress, expandRows, overdueRows, upcomingRows } from "../index/queries";
  import { startOfLocalDay, addLocalDays } from "../model/dates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  const { snapshot, settings, now, channels, actions, composer, publish } = useOsmm();
  const rows = $derived(expandRows($snapshot.variants, $settings.defaultStaggerMinutes));
  const overdue = $derived(overdueRows(rows, $now));
  const attention = $derived(rows.filter((r) => r.channelId !== null && (r.status === "failed" || r.status === "check_needed")));
  const endOfDay = $derived(addLocalDays(startOfLocalDay($now), 1));
  const upNext = $derived(upcomingRows(rows, $now, endOfDay - $now));
  const campaigns = $derived(
    $snapshot.campaigns
      .filter((c) => c.status === "active")
      .map((c) => ({ c, ...campaignProgress($snapshot.variants, c.path) }))
      .sort((a, b) => (a.c.anchorDate ?? Infinity) - (b.c.anchorDate ?? Infinity)),
  );
  const channelName = (id: string | null) => (id ? (channels.get(id)?.name ?? id) : "");
</script>

<div class="osmm-sidebar">
  <button type="button" class="mod-cta" onclick={() => actions.quickCreate("campaign")}>New campaign</button>
  {#if overdue.length}
    <section class="osmm-overdue" aria-label={`Overdue · ${overdue.length}`}>
      <h3 class="osmm-section-title">Overdue · {overdue.length}</h3>
      {#each overdue as r (r.key)}
        <div class="osmm-row">
          <PlatformBadge platform={r.variant.platform} />
          <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button>
        </div>
        <div class="osmm-row">
          <span class="osmm-progress">{r.at !== undefined ? `${formatShortDate(r.at)} ${formatTime(r.at)}` : ""}{r.channelId ? ` · ${channelName(r.channelId)}` : ""}</span>
          <span class="osmm-spacer"></span>
          <button type="button" class="mod-cta" aria-label={`Post ${r.variant.displayTitle} now`} onclick={() => void publish.postNow(r.variant.path, r.channelId ? [r.channelId] : undefined)}>Post now</button>
          <button type="button" onclick={(e) => actions.quickReschedule(e, r)}>Reschedule</button>
          <button type="button" aria-label={`Skip ${r.variant.displayTitle}`} onclick={() => void actions.skip(r)}>Skip</button>
        </div>
      {/each}
    </section>
  {/if}

  {#if attention.length}
    <section class="osmm-attention" aria-label={`Needs attention · ${attention.length}`}>
      <h3 class="osmm-section-title">Needs attention · {attention.length}</h3>
      {#each attention as r (r.key)}
        {@const error = r.channelId ? r.variant.deliveries[r.channelId]?.error : undefined}
        <div class="osmm-row">
          <PlatformBadge platform={r.variant.platform} />
          <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button>
        </div>
        <p class="osmm-progress">{channelName(r.channelId)}{error ? ` · ${error}` : ""}</p>
        <div class="osmm-row">
          <span class="osmm-spacer"></span>
          {#if r.status === "failed"}
            <button type="button" onclick={() => void publish.postNow(r.variant.path, [r.channelId!])}>Post again</button>
            <button type="button" onclick={() => void composer.openComposer(r.variant.path)}>Fix</button>
          {:else}
            <button type="button" onclick={() => publish.openAssisted(r.variant.path, [r.channelId!], 3)}>It went out</button>
            <button type="button" onclick={() => void publish.resolveNotPublished(r.variant.path, r.channelId!)}>It didn't</button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  <section aria-label="Up next · today">
    <h3 class="osmm-section-title">Up next · today</h3>
    {#each upNext as r (r.key)}
      <button type="button" class="osmm-row osmm-card" onclick={() => actions.openNote(r.variant.path)}>
        <span class="osmm-progress">{r.at !== undefined ? formatTime(r.at) : ""}</span>
        <PlatformBadge platform={r.variant.platform} />
        <span class="osmm-row-title">{r.variant.displayTitle}</span>
      </button>
    {:else}
      <p class="osmm-progress">Nothing else today.</p>
    {/each}
  </section>

  <section aria-label="Campaigns">
    <h3 class="osmm-section-title">Campaigns</h3>
    {#each campaigns as { c, published, total } (c.path)}
      <button type="button" class="osmm-row osmm-link" onclick={() => actions.openNote(c.path)}>
        <span class="osmm-row-title">{c.title}</span>
        <span class="osmm-progress">{published}/{total}</span>
      </button>
    {/each}
  </section>
</div>
```

Append to `src/styles/planner.css`:
```css
.osmm-attention { border: 1px solid rgba(var(--color-red-rgb), 0.55); background: rgba(var(--color-red-rgb), 0.08); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.osmm-attention p { margin: 0; }
```

In `src/composer/ActionsBar.svelte`:
- change the script to take the issues and compute `blocked`:
```ts
  import type { Issue } from "../model/types";
  import { blocking } from "../platforms/checks";
```
```ts
  let { variant, issues = [] }: { variant: IndexedVariant; issues?: Issue[] } = $props();
  const { channels, composer, publish } = useOsmm();
  const blocked = $derived(blocking(issues));
```
- replace the "Copy & open" button with:
```svelte
    <button type="button" class="mod-cta" disabled={blocked} onclick={() => void publish.postNow(variant.path)}>Post now</button>
    <button type="button" disabled={blocked} onclick={() => publish.openAssisted(variant.path)}>Copy & open</button>
```

In `src/composer/Composer.svelte`, change `<ActionsBar {variant} />` to `<ActionsBar {variant} {issues} />`.

In `src/views/CampaignTable.svelte`, change `const { snapshot, settings, actions, composer } = useOsmm();` to `const { snapshot, settings, actions, composer, publish } = useOsmm();` and, in the row's last cell after the "Compose" button, add:
```svelte
            {#if r.status === "overdue"}
              <button type="button" class="mod-cta" aria-label={`Post ${PLATFORM_META[r.variant.platform].label} variant now`} onclick={() => void publish.postNow(r.variant.path)}>Post now</button>
            {/if}
```

- [ ] **Step 5: Close the parked planner items**

In `src/ui/actions.ts`:
- in `reschedule`, right after the `if (plan.needsConfirm) { … }` block, add:
```ts
    if (plan.newAt < this.deps.now()) {
      const go = await this.confirm("That time is in the past, so the post will show as overdue until you post or move it. Move it anyway?", "Move");
      if (!go) return false;
    }
```
- change the templates import to `import { planTemplate, planTemplateMove, type TemplateProposal } from "../planner/templates";`
- in `applyTemplate`, replace the `write` call's plan with `(fresh) => planTemplateMove(fresh, p.to)`, and change the skipped summary to ``${skipped ? ` Skipped ${skipped} already published, handed over or being published.` : ""}``.

In `src/planner/templates.ts`:
- add imports:
```ts
import { transition } from "../model/stateMachine";
import type { Delivery, DeliveryStatus, Variant } from "../model/types";
import type { VariantUpdate } from "../model/writer";
```
- add after `templateLocked`:
```ts
/** Deliveries in flight: a template must not move their post either. */
const IN_FLIGHT = new Set<DeliveryStatus>(["publishing", "check_needed"]);
/** Deliveries whose explicit time is history, not a plan. */
const KEEPS_TIME = new Set<DeliveryStatus>(["published", "skipped", "handed_over"]);

export function templateMovable(v: Pick<Variant, "status" | "deliveries">): boolean {
  return !templateLocked(v) && !Object.values(v.deliveries).some((d) => IN_FLIGHT.has(d.status));
}

/**
 * A template move changes more than scheduled_at (parked M1 item): overdue deliveries become scheduled
 * again, and explicit per-channel times move with the post, or are dropped when it had no time yet.
 */
export function planTemplateMove(fresh: Variant, to: number): VariantUpdate | { refuse: string } {
  if (!templateMovable(fresh)) return { refuse: "locked" };
  const delta = fresh.scheduledAt === undefined ? null : to - fresh.scheduledAt;
  const deliveries: Record<string, Delivery> = {};
  for (const [id, d] of Object.entries(fresh.deliveries)) {
    let next: Delivery = d;
    if (d.at !== undefined && !KEEPS_TIME.has(d.status)) {
      next = { ...d };
      if (delta === null) delete next.at;
      else next.at = d.at + delta;
    }
    if (next.status === "overdue") next = transition(next, "scheduled");
    if (next !== d) deliveries[id] = next;
  }
  return { fields: { scheduledAt: to }, deliveries };
}
```
- in `planTemplate`, change `.filter((v) => !templateLocked(v))` to `.filter((v) => templateMovable(v))`.

In `src/main.ts`:
- add `import { overdueRows } from "./index/queries";`
- in `onLayoutReady`, after `await this.scheduler.reconcile();` add:
```ts
      ui.publish.overdueBanner(overdueRows(ui.actions.rows(), Date.now()).length);
```
  (`ui` is the `const ui = this.uiContext();` created in `onload`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (the existing sidebar and template tests still pass).

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat(publish): Post now from the Overdue tray and composer, Needs attention, startup banner (refs #63, #52)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Keyboard and mobile path to move posts — context menus (#113)

**Files:**
- Create: `src/ui/longpress.ts`, `test/ui/rowMenu.test.ts`
- Modify: `src/ui/actions.ts` (`pickTime`, `rowFor`, `rowMenu`, `keyMenu`; `quickReschedule` and `moveOnBoard` use `pickTime`), `src/views/Chip.svelte`, `src/views/BoardView.svelte`, `src/views/ListView.svelte`

**Interfaces:**
- Consumes: `planBoardMove`, `BOARD_COLUMNS`, `columnOf` (M1); `reschedule`, `moveOnBoard`, `skip` (M1); `ComposerActions.openComposer` (M2a); `PublishActions.postNow` (Task 10).
- Produces:
  - `PlannerActions.pickTime(title, initial): Promise<number | null>` (overridable in tests, like `confirm`).
  - `PlannerActions.rowFor(v): PostRow | undefined`, `PlannerActions.rowMenu(row, at: MouseEvent | { x; y }): Menu` — **Open note**, **Compose**, **Post now** (pending channels), **Reschedule…**, **Move to <column>** (only moves the board allows), **Skip**; every drag-and-drop action has an equivalent here, with the same guards, Notices and Undo.
  - `PlannerActions.keyMenu(event, row)` — the Menu key or Shift+F10 opens the menu under the focused element.
  - `use:longpress={handler}` — a 500 ms touch without moving more than 10 px calls `handler({ x, y })`, and swallows the click that follows.
  - Calendar chips and board cards open the menu on right click, Shift+F10 / Menu key and long press; list rows get an "Actions for …" button and right click.

- [ ] **Step 1: Write the failing test**

`test/ui/rowMenu.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Menu } from "../fakes/obsidian";
import { osmmContext } from "../../src/ui/context";
import BoardView from "../../src/views/BoardView.svelte";
import Chip from "../../src/views/Chip.svelte";
import ListView from "../../src/views/ListView.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "./ctx";

const BS = "Social/Event X/Event X – Bluesky.md";
const titles = () => Menu.last!.items.map((i) => i.title);
const click = (title: string) => Menu.last!.items.find((i) => i.title === title)!.click();

function touch(el: Element, type: string, x: number, y: number): void {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
  el.dispatchEvent(ev);
}

afterEach(() => {
  Menu.last = null;
  vi.useRealTimers();
});

describe("row menu", () => {
  it("offers every move for a scheduled post", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose", "Post now", "Reschedule…", "Move to Idea", "Move to Draft", "Move to Ready", "Skip"]);
  });

  it("offers only safe actions for a published channel", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey("Social/Event X/Event X – LinkedIn.md#li/me")!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose"]);
  });

  it("moves to a column with the same guards and undo as a drag", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    click("Move to Draft");
    await indexed(index, () => index.getVariant(BS)?.status === "draft");
  });

  it("reschedules through the date picker", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const target = new Date(2026, 9, 20, 11, 15).getTime();
    ctx.actions.pickTime = async () => target;
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    click("Reschedule…");
    await indexed(index, () => index.getVariant(BS)?.scheduledAt === target);
  });
});

describe("opening the menu without a mouse", () => {
  it("opens from the keyboard with Shift+F10 or the Menu key", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    await fireEvent.keyDown(chip, { key: "a" });
    expect(Menu.last).toBeNull();
    await fireEvent.keyDown(chip, { key: "F10", shiftKey: true });
    expect(titles()).toContain("Reschedule…");
    Menu.last = null;
    await fireEvent.keyDown(chip, { key: "ContextMenu" });
    expect(titles()).toContain("Reschedule…");
  });

  it("opens on right click", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    await fireEvent.contextMenu(screen.getByRole("button"));
    expect(titles()).toContain("Move to Draft");
  });

  it("opens on long press on phones and swallows the click that follows", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    vi.useFakeTimers();
    touch(chip, "touchstart", 10, 10);
    vi.advanceTimersByTime(500);
    expect(titles()).toContain("Skip");
    touch(chip, "touchend", 10, 10);
    const opened = app.workspace.opened.length;
    chip.click();
    expect(app.workspace.opened.length).toBe(opened);
  });

  it("does not open when the finger moves (scrolling)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    vi.useFakeTimers();
    touch(chip, "touchstart", 10, 10);
    touch(chip, "touchmove", 10, 40);
    vi.advanceTimersByTime(600);
    expect(Menu.last).toBeNull();
  });

  it("opens from board cards and list rows", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const { unmount } = render(BoardView, { props: { variants: [index.getVariant(BS)!] }, context: osmmContext(ctx) });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Event X is back/ }));
    expect(titles()).toContain("Move to Ready");
    unmount();
    Menu.last = null;
    render(ListView, { props: { rows: [ctx.actions.rowByKey(`${BS}#bs/you`)!] }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Actions for Event X is back on the 12th — one evening, 80 makers." }));
    expect(titles()).toContain("Post now");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/ui/rowMenu.test.ts`
Expected: FAIL — `rowMenu` is not a function.

- [ ] **Step 3: Write the long-press action**

`src/ui/longpress.ts`:
```ts
/**
 * Svelte action: after a 500 ms touch that stays within 10 px, calls `handler` with the touch point
 * (phones have no right click, #113). The click that follows the long press is swallowed.
 */
export function longpress(node: HTMLElement, handler: (point: { x: number; y: number }) => void) {
  let current = handler;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const onStart = (e: Event) => {
    const t = (e as TouchEvent).touches?.[0];
    if (!t) return;
    fired = false;
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      fired = true;
      current(start);
    }, 500);
  };
  const onMove = (e: Event) => {
    const t = (e as TouchEvent).touches?.[0];
    if (t && start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  };
  const onClick = (e: Event) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  node.addEventListener("touchstart", onStart, { passive: true });
  node.addEventListener("touchmove", onMove, { passive: true });
  node.addEventListener("touchend", cancel);
  node.addEventListener("touchcancel", cancel);
  node.addEventListener("click", onClick, true);
  return {
    update(next: (point: { x: number; y: number }) => void) {
      current = next;
    },
    destroy() {
      cancel();
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", cancel);
      node.removeEventListener("touchcancel", cancel);
      node.removeEventListener("click", onClick, true);
    },
  };
}
```

- [ ] **Step 4: Add the menus to PlannerActions**

In `src/ui/actions.ts`:
- change the board import to include `BOARD_COLUMNS` and `columnOf`:
```ts
import {
  BOARD_COLUMNS,
  columnOf,
  defaultScheduleTime,
  planBoardMove,
  scheduleDeliveries,
  UNSCHEDULE_BLOCKED,
  unscheduleBlocked,
  unscheduleDeliveries,
  type BoardColumn,
} from "../planner/board";
```
  and change the `../index/queries` import to `import { expandRows, type PostRow, type RowStatus } from "../index/queries";`.
- add, above the class:
```ts
const COLUMN_TITLE: Readonly<Record<BoardColumn, string>> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", published: "Published" };
/** Rows that can still be posted, rescheduled or skipped from a menu. */
const POSTABLE = new Set<RowStatus>(["draft", "ready", "scheduled", "overdue", "failed", "awaiting_you"]);
const NOT_MOVABLE = new Set<RowStatus>(["published", "publishing", "skipped"]);
```
- add after `confirm`:
```ts
  /** Overridable in tests. */
  pickTime(title: string, initial: number): Promise<number | null> {
    return pickDateTime(this.deps.app, title, initial);
  }
```
- in `quickReschedule`, replace `await pickDateTime(this.deps.app, "Reschedule", Math.max(base, now + DAY))` with `await this.pickTime("Reschedule", Math.max(base, now + DAY))`; in `moveOnBoard`, replace `await pickDateTime(this.deps.app, "Schedule post", …)` with `await this.pickTime("Schedule post", …)` (same arguments).
- add these methods:
```ts
  rowFor(v: IndexedVariant): PostRow | undefined {
    return this.rows().find((r) => r.variant.path === v.path);
  }

  /** The menu equivalent of every drag-and-drop action (#113), with the same guards, notices and undo. */
  rowMenu(row: PostRow, at: MouseEvent | { x: number; y: number }): Menu {
    const v = row.variant;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => this.openNote(v.path)));
    menu.addItem((i) => i.setTitle("Compose").setIcon("pencil-line").onClick(() => void this.context?.composer.openComposer(v.path)));
    if (row.channelId && POSTABLE.has(row.status)) {
      const channelId = row.channelId;
      menu.addItem((i) => i.setTitle("Post now").setIcon("send").onClick(() => void this.context?.publish.postNow(v.path, [channelId])));
    }
    menu.addSeparator();
    if (!NOT_MOVABLE.has(row.status)) {
      menu.addItem((i) =>
        i
          .setTitle("Reschedule…")
          .setIcon("calendar-clock")
          .onClick(async () => {
            const now = this.deps.now();
            const at = await this.pickTime("Reschedule", Math.max(row.at ?? now, now + HOUR));
            if (at !== null) await this.reschedule(row, { at });
          }),
      );
    }
    const current = columnOf(v.status);
    for (const col of BOARD_COLUMNS) {
      if (col === current || !planBoardMove(v, col).ok) continue;
      menu.addItem((i) => i.setTitle(`Move to ${COLUMN_TITLE[col]}`).onClick(() => void this.moveOnBoard(v, col)));
    }
    if (row.channelId && POSTABLE.has(row.status)) menu.addItem((i) => i.setTitle("Skip").setIcon("skip-forward").onClick(() => void this.skip(row)));
    if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
    else menu.showAtPosition(at);
    return menu;
  }

  /** The Menu key or Shift+F10 opens the row menu under the focused element. */
  keyMenu(event: KeyboardEvent, row: PostRow): void {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.rowMenu(row, { x: rect.left, y: rect.bottom });
  }
```

- [ ] **Step 5: Open the menu from chips, cards and list rows**

In `src/views/Chip.svelte`, add `import { longpress } from "../ui/longpress";` and add these attributes to the `<button>` (after `onmouseenter`):
```svelte
  oncontextmenu={(e) => {
    e.preventDefault();
    actions.rowMenu(row, e);
  }}
  onkeydown={(e) => actions.keyMenu(e, row)}
  use:longpress={(p) => actions.rowMenu(row, p)}
```

In `src/views/BoardView.svelte`, add `import { longpress } from "../ui/longpress";`, add this function to the script:
```ts
  function menuFor(v: IndexedVariant, at: MouseEvent | { x: number; y: number }): void {
    const row = actions.rowFor(v);
    if (row) actions.rowMenu(row, at);
  }
```
and add these attributes to the card `<button>` (after `onclick`):
```svelte
          oncontextmenu={(e) => {
            e.preventDefault();
            menuFor(v, e);
          }}
          onkeydown={(e) => {
            const row = actions.rowFor(v);
            if (row) actions.keyMenu(e, row);
          }}
          use:longpress={(p) => menuFor(v, p)}
```

In `src/views/ListView.svelte`:
- add `import { icon } from "../ui/icon";`
- in the header row, add a last cell `<th><span class="sr-only">Actions</span></th>`
- change each body row's `<tr>` to:
```svelte
      <tr
        oncontextmenu={(e) => {
          e.preventDefault();
          actions.rowMenu(r, e);
        }}>
```
  and add a last cell:
```svelte
        <td>
          <button type="button" class="clickable-icon" aria-label={`Actions for ${r.variant.displayTitle}`} onclick={(e) => actions.rowMenu(r, e)}><span use:icon={"more-horizontal"}></span></button>
        </td>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat(planner): context menus with keyboard and long press for every drag action (refs #113)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: README and getting-started guide (#109)

**Files:**
- Modify: `README.md` (replace the file)
- Create: `docs/getting-started.md`, `docs/images/planner.png`, `docs/images/composer.png`, `docs/images/assisted.png`

**Interfaces:**
- Consumes: the features of M1, M2a and M2b as built (command names, settings names, button labels).
- Produces: a README with what the plugin is, what works today, install via BRAT and a pointer to the 10-minute guide; `docs/getting-started.md`, which takes a new user from install to a published assisted post.

- [ ] **Step 1: Write the README**

`README.md` (replace the file):
```markdown
# Social Planner (OSMM) for Obsidian

Plan, preview, schedule and post your social media content, for every platform and every page you run, from your vault.

![The planner: month view with the Overdue tray](docs/images/planner.png)

## What it does

- **Plan** campaigns and standalone posts on a calendar (month and week), a pipeline board and a list. Drag to reschedule, or use the context menu (right click, Shift+F10, or a long press on a phone).
- **Write per-platform variants** from one campaign brief. Each variant is a normal note: its frontmatter holds the platform, the channels (profiles, pages, groups, sites), the time and the delivery status per channel.
- **Preview and check** every post the way each platform shows it (stylized, not pixel-perfect): character counts the way the platform counts them, thread splitting, image crops, hashtags, titles and links. Blocking problems stop you from scheduling.
- **Post in one click where there is no API yet:** "Copy & open" opens the platform's compose page, already filled in where the platform allows it, with the text on your clipboard. Paste the live link back and the post is marked published.
- **Never miss or double-post:** reminders before each assisted post (60 and 10 minutes by default), a desktop notification when it is due, an Overdue tray for anything whose time passed while Obsidian was closed, and a scheduler that never posts the same delivery twice and never posts late without asking.

Supported platforms: LinkedIn (profile and pages), X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit, WhatsApp and WordPress. Today every platform posts through the assisted flow; automatic posting through the platforms' APIs is on the roadmap (Telegram, Discord, Mastodon, Bluesky and WordPress first).

![The composer: live preview, channels, checks and schedule](docs/images/composer.png)

## Install

The plugin is not in the community catalogue yet. Install it with BRAT:

1. In Obsidian, install and enable **BRAT** from Community plugins.
2. Run **BRAT: Add a beta plugin for testing** and enter `dannickstark/Obsidian-Social-media-management`.
3. Enable **Social Planner (OSMM)** under Community plugins.

Obsidian 1.11.4 or newer is required. The plugin works on desktop and on phones; reminders on phones arrive with a later version.

## Get started in 10 minutes

Follow [the getting-started guide](docs/getting-started.md): add a channel, write a post, check it, schedule it, and post it with the assisted flow when the reminder comes.

![The assisted publish flow](docs/images/assisted.png)

## Your data

- Posts and campaigns are Markdown notes under `Social/` (configurable). Nothing leaves your vault unless you post it.
- Channels live in the plugin settings. Credentials (for the API posting that comes later) are kept in Obsidian's per-device secret storage, never in your notes or in synced settings.
- Reminders and notification settings are per device.

## Development

Requirements: Node 22+, Obsidian 1.11.4+.

    npm install
    npm run seed          # creates dev-vault/ with sample campaigns (add -- --large for 5,000 notes)
    npm run dev           # builds and copies the plugin into dev-vault/ on every change

Open `dev-vault/` as a vault in Obsidian and enable **Social Planner (OSMM)** under Community plugins.

    npm test              # unit tests (Vitest, TZ=Europe/Berlin)
    npm run typecheck && npm run lint

Design spec: `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` · implementation plans: `docs/superpowers/plans/` · manual QA: `docs/qa/`.
```

- [ ] **Step 2: Write the getting-started guide**

`docs/getting-started.md`:
```markdown
# Getting started: your first assisted post in 10 minutes

This guide takes you from a fresh install to a post that is live on a platform and marked as published in your vault. It uses Bluesky as the example; every other platform works the same way.

## 1. Add a channel (1 minute)

A channel is one place you post to: a profile, a page, a group, a server channel or a website.

1. Open **Settings → Social Planner (OSMM)**.
2. Under **Channels**, click **Add channel**.
3. Pick **Bluesky**, name it (for example `@you.bsky.social`), leave **Publishing** on **Assisted (remind + open)**, and save.

Tip: for Mastodon, set the handle to `@you@your.instance` so the right server opens. For a Reddit channel, set the handle to the subreddit (`r/SideProject`). For WordPress, set it to the site's domain.

## 2. Write a post (2 minutes)

1. Run the command **New post** (or click the calendar icon in the ribbon and use the planner).
2. Give it a title, pick **Bluesky** and your channel, and create it. The new note opens.
3. Write the text under the frontmatter. On X, Bluesky and Mastodon, a line with only `---` starts the next post of a thread.

## 3. Check it in the composer (2 minutes)

1. Run **Open composer for this post**. The composer opens next to the note.
2. The preview follows what you type. The **Checks** panel counts characters the way Bluesky does (300) and lists anything that would block the post.
3. Drop an image on **Media** if you want one, and give it alt text.

## 4. Schedule it (1 minute)

1. In **Schedule**, pick a date and a time a few minutes from now.
2. Keep the reminder chips (60 and 10 minutes before) or change them.
3. Click **Schedule**. The post appears in the planner and in **Up next · today** in the queue sidebar (**Open social queue (sidebar)**).

## 5. Post it when the reminder comes (3 minutes)

1. When it is time, a notice appears: **Time to post** with **Open & post**. (If Obsidian is in the background, you also get a system notification.)
2. **Open & post** opens the assisted flow:
   - **Check**: the preview one last time.
   - **Open and paste**: **Open Bluesky** opens the compose page with your text already in it, and puts the text on your clipboard too. Post it there.
   - **Confirm**: copy the link of the live post, paste it into **Link to the live post**, and click **Mark published**.
3. The post turns to **Published** everywhere in the planner.

You can start the same flow at any time with **Copy & open** in the composer, or **Post now** in the Overdue tray.

## When something goes wrong

- **The post's time passed while Obsidian was closed.** It is not posted late behind your back: it waits in the **Overdue** tray with **Post now**, **Reschedule** and **Skip**. (Settings → Publishing → **Post late items automatically** lets short delays go out anyway; it is off by default.)
- **A link is refused.** The link must be the post's page on that platform, starting with `https://`.
- **Needs attention.** Failed deliveries and ones that need a check are listed in the queue sidebar with the next step to take.
- **Wrong day?** Drag the post in the planner, or right click it (long press on a phone) and pick **Reschedule…**. Every move can be undone from the notice.
```

- [ ] **Step 3: Capture the screenshots**

Run `npm run seed && npm run dev`, open `dev-vault/` in Obsidian (default dark theme, window about 1400×900), and save three PNG screenshots:
- `docs/images/planner.png` — the planner in month view with the queue sidebar open (Overdue tray visible).
- `docs/images/composer.png` — "Event X – LinkedIn" in the composer next to its note (preview, Post as, Checks, Schedule).
- `docs/images/assisted.png` — the assisted flow on step 2 for "Event X – Bluesky".

- [ ] **Step 4: Check the guide against the UI**

Follow `docs/getting-started.md` on a new, empty vault with a stopwatch. Every command, button and setting name in the guide must match the UI exactly, and the whole guide must take under 10 minutes. Fix the guide (or the UI label, with its test) where they differ.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/getting-started.md docs/images
git commit -m "docs: add README and the getting-started guide (refs #109)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: M2 acceptance pass

**Files:**
- Create: `docs/qa/m2b.md`

**Interfaces:**
- Produces: a manual QA checklist for M2b, run once in Obsidian together with `docs/qa/m2a.md` and `docs/qa/assisted-urls.md`, with results recorded in the PR description.

- [ ] **Step 1: Write the checklist**

`docs/qa/m2b.md`:
```markdown
# M2b manual QA — assisted publishing, scheduler, reminders

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+, enable the plugin.
Run in the default dark and light themes. Also run `docs/qa/assisted-urls.md`.

## Assisted flow (mockup 6)
- [ ] Composer → Copy & open on Event X – LinkedIn walks Acme Studio, then Maker Lab (stagger order); "1 of 2", "2 of 2".
- [ ] Step 2 opens the page in the browser and the text is on the clipboard (paste it into any text field to check).
- [ ] X thread: "Copy reply 2" and "Copy reply 3" copy the next parts.
- [ ] Instagram: the image can be copied (desktop) or is revealed in the file manager; on a phone the share sheet opens.
- [ ] Step 3 refuses a link to another platform with a clear message; a correct link marks the channel published and the calendar chip turns published at once.
- [ ] Closing the modal after "Open" leaves the channel "Waiting for you".
- [ ] "Skip this channel" with a reason writes `reason` in the note.

## Scheduler and reliability (spec §5)
- [ ] Schedule a Bluesky post 2 minutes ahead: at its time a "Time to post" notice appears and the delivery is "Waiting for you"; it does not fire again on later ticks.
- [ ] Schedule a post 2 minutes ahead, quit Obsidian, wait 10 minutes, reopen: the post is in the Overdue tray (not posted), and the startup banner says so with "Review".
- [ ] Settings → Publishing → turn on "Post late items automatically" (15 min) and repeat with a 5-minute gap: the post runs at startup.
- [ ] Edit a note so a delivery reads `status: publishing`, restart Obsidian: it becomes "Check needed" in Needs attention, and is never retried; "It went out" asks for the link; "It didn't" marks it failed.
- [ ] Edit a delivery to `status: Handed-Over` (typo) on a post due in 2 minutes: nothing is posted, a notice explains which channel to fix, and the composer shows a blocking check. Dragging the post on the board to Scheduled leaves the typo untouched.
- [ ] Put the laptop to sleep across a post's time: on wake it goes to the Overdue tray.

## Reminders (spec §4.4)
- [ ] With a post 61 minutes ahead, the 60-minute reminder appears within a minute, once; after restarting Obsidian it does not repeat.
- [ ] "Snooze 10 min" brings it back 10 minutes later; "Open & post" opens the assisted flow.
- [ ] With Obsidian in the background, a system notification appears; clicking it opens the assisted flow.
- [ ] Settings → "Desktop notifications on this device" off: no reminders on this device.

## Overdue tray and Needs attention (mockup 1)
- [ ] Post now on the overdue Instagram item opens the assisted flow; Reschedule offers in 1 hour / tomorrow / pick a date; Skip removes it; the count updates at once.
- [ ] The failed Telegram post shows its error, "Post again" and "Fix" (opens the composer).

## Keyboard and phone (#113)
- [ ] Tab to a calendar chip, press Shift+F10 (or the Menu key): the menu offers Reschedule…, Move to …, Skip, Post now, Compose.
- [ ] On a phone, a long press on a chip or a board card opens the same menu and does not open the note.
- [ ] List view: "Actions for …" opens the menu; every move can be undone from its notice.
- [ ] Dropping a chip on a past time asks before moving it.

## Docs (#109)
- [ ] README renders on GitHub with the three screenshots; the getting-started guide takes a new user to a published assisted post in under 10 minutes.
```

- [ ] **Step 2: Run the full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 3: Walk through the checklists and fix what fails**

Work through `docs/qa/m2a.md`, `docs/qa/m2b.md` and `docs/qa/assisted-urls.md` in Obsidian. For each failure, add a failing test in the owning module first, fix the problem, and commit with `fix(...)`.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/qa/m2b.md
git commit -m "docs(qa): add M2b manual QA checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
gh pr create --base dev --title "M2: one-click posting" --body "Implements docs/superpowers/plans/2026-09-29-m2a-platforms-and-composer.md and docs/superpowers/plans/2026-09-29-m2b-assisted-publishing-and-scheduler.md. Refs #39 #40 #41 #42 #43 #44 #45 #46 #47 #48 #49 #50 #51 #52 #53 #54 #55 #56 #57 #58 #59 #60 #61 #62 #63 #64 #109 #113. QA: docs/qa/m2a.md, docs/qa/m2b.md, docs/qa/assisted-urls.md (results below).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## M2b Done Checklist

- [ ] All 13 tasks committed on `feat/m2-one-click-posting`; `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] `docs/qa/m2a.md`, `docs/qa/m2b.md` and `docs/qa/assisted-urls.md` checked in light and dark themes; results in the PR.
- [ ] Issues #52, #55–#58, #60–#64, #109 and #113 can be closed; epics #39, #47, #54 and #59 are complete.
- [ ] Open follow-ups for M3: the publisher-device setting replaces `isPublisher: () => true` in `src/main.ts` (#26); `MemoryLog` is replaced by the `Social/_log.md` writer (#27); ntfy phone reminders reuse `dueReminders` and the ledger keys.
