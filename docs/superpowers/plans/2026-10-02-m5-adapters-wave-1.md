# M5 — Auto-publish Adapters, Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Posts on Telegram, Discord, Mastodon, Bluesky and WordPress go out by themselves from the publisher device. Mastodon and WordPress posts are handed over to the platform's own scheduler, so they go out with Obsidian closed. A handed-over post that is edited or moved in Obsidian shows "Out of sync" and is only pushed when the user says so. One contract suite holds every adapter to the same error rules.

**Architecture:** `src/platforms/http.ts` wraps Obsidian's `requestUrl` (always `throw: false`, with a timeout) in an `ApiClient` that sorts every request into a phase. A **prepare** request runs before the post exists (login, upload, taxonomy lookup); any failure there is `Transient`, because nothing was posted. A **commit** request creates or changes the post; a network error or timeout there is `UnknownOutcomeError` (M2b P4: the delivery goes to `check_needed`, `lookup()` runs, and it is never retried). HTTP answers are classified by status and by the platform's own error body. Each platform has one adapter class (`src/platforms/<p>/api.ts`), registered through `createAdapters()` (`src/platforms/adapters.ts`). The contract suite (`test/platforms/contract/`) runs against exactly that list. Native scheduling is a new `HandOverService` (`src/publish/handover.ts`) that the scheduler starts, without awaiting it, on the publisher device after each tick. It claims a delivery by writing `handed_over` (with the platform time `remote_at` and a content `digest`, no `remote_id` yet) before it calls `adapter.schedule()`. It fills in `remote_id` on success, and later asks the platform (`lookup()`) whether the post went out. "Out of sync" (#66) compares the note's content digest (computed by the index) and its local time with the baseline stored on the delivery. The Update, Revert time and Unschedule-on-platform actions go through `PublishActions`, with the M2b P3 flush and re-validation first. `src/platforms/og.ts` fetches link cards for Bluesky and for the previews.

**Tech Stack:** TypeScript 5.9 (strict, `noUncheckedIndexedAccess`), Svelte 5 (runes), Obsidian API 1.13 (`requestUrl`, `SecretStorage`, `DOMParser` in the app's web view), zod 4.6, Vitest 5 (jsdom) with the in-memory Obsidian fake and a scripted `requestUrl`. No new runtime dependency: the Markdown → HTML converter for WordPress and the multipart encoder are written here.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§1.2, §1.3.2 and §1.3.5, §2.2 `deliveries`, §2.3 WordPress variant, §2.4 channels, §2.6 secrets, §3 view 9 "Scheduled on WordPress" / Update, §4.1 adapter interface and `requestUrl`, §4.2 platform matrix, §4.3 publisher device, §5 lifecycle (`handed_over`, `check_needed`, error classes, rule 5 "edits after hand-over"), §7 adapter contract suite and manual smoke checklist, §8 M5). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z. Binding rulings: the M2a, M2b, M3 and M4 ledgers (reproduced in the controller's `global-constraints.md`), in particular M2b P3/P4, M3 P2/P5/P11, and the M4 Task 8 carry: "every variant field an adapter reads must be in `sendDigest`".

**Depends on:** M4 complete on `feat/m4-claude-mcp-and-skill`, including its final fix wave (HEAD `0928bd8` when this plan was written). Work on a new branch `feat/m5-adapters-wave-1` created from that HEAD, or from `dev` once M4 is merged there.

**Issues covered:** epic #86: #87 (Tasks 2–3), #88 (Task 5), #89 (Task 6), #90 (Task 9), #91 (Tasks 7–8), #92 (Tasks 10–11), #93 (Task 4). #66 (Tasks 13–15). #111 (Task 16). Channel setup for all five platforms: Task 12.

**Not pre-verified:** the code was written against the source read file by file at `0928bd8`, but it was not applied to a scratch copy. Where a signature in the repo differs from what a step shows, make the minimal correction and report it in the task's review notes. The API request and response shapes come from each platform's public documentation. Every **(QA)** item needs a live account; Task 16 collects them in `docs/qa/m5-smoke.md`.

## Global Constraints

- All M1–M4 constraints apply: `SafeWriter` / `PlannerActions.write` for every frontmatter write, per key (never a whole `deliveries` map); `transition()` for every status change; plans computed on fresh frontmatter inside the write; real labelled controls, `setIcon`, Obsidian CSS variables, **no emoji anywhere in UI text, notices, log lines or code strings**; `TZ=Europe/Berlin` in tests.
- **HTTP only through `requestUrl`** (spec §4.1), called with `throw: false`, through `src/platforms/http.ts`. Every request has a timeout: `HTTP_TIMEOUT_MS = 30_000`, `UPLOAD_TIMEOUT_MS = 120_000` for requests that carry files. Only `https://` URLs are requested by adapters. `fetch`, `XMLHttpRequest` and Node modules are never used in `src/`.
- **Error classes (M2b P4):** a failure of a *prepare* request (auth, upload, lookup of ids) is `TransientError` (retried with the existing back-off 1, 5, 15 min). A network error or timeout of a *commit* request (the one that creates, changes or deletes the post) is `UnknownOutcomeError`: the delivery goes to `check_needed`, `lookup()` runs where the adapter has one, and it is **never** retried automatically. HTTP answers: 401/403 → `NeedsUserError`; 408/429/5xx → `TransientError` with the platform's wait (`Retry-After`, Telegram `retry_after`, Discord `retry_after`, Bluesky `ratelimit-reset`, Mastodon `X-RateLimit-Reset`); 400/413/422 → `InvalidContentError`; any other status → `NeedsUserError`. A platform error body may override this (for example Telegram "chat not found" is `NeedsUser`).
- **Error messages never contain a credential.** They are built from the platform's error text and a fixed sentence, never from the request URL or headers. Telegram's token is part of the URL, Discord's webhook URL is itself the secret, and Bluesky session tokens and WordPress Basic auth are derived secrets. The contract suite checks every failure message against a `sensitive` list. The orchestrator's existing redaction stays as a second layer.
- **Secrets only in `app.secretStorage`** (spec §2.6), through `Channel.secretId`: Telegram bot token, Discord webhook URL, Mastodon access token, Bluesky app password, WordPress application password. Bluesky session tokens are kept **in memory only** (never written anywhere). Non-secret connection settings are new optional channel fields (settings schema 5): `server` (https URL: Mastodon instance, Bluesky PDS, WordPress site), `login` (WordPress user name), `postAsName` / `postAsAvatar` (Discord).
- **Only the publisher device dispatches** (spec §4.3). Scheduled API sends and every native hand-over, platform check and settle run only while `isPublisher()` is true. They start from `Scheduler.tick()` behind the M3 P2 ready/generation gate, and are **not awaited** by the tick (M3 P5). The user's own Post now, Push update, Revert time and Unschedule on platform work from any device that holds the credential, as Post now does today.
- **M2b P3 before any send or push:** flush the open editor, re-read the note, re-validate the exact text, and refuse on blocking issues. This covers Push update, the hand-over (which skips a note with blocking issues) and the existing paths.
- **M4 carry, digest coverage:** an adapter reads post content only from `job.text`, `job.items`, `job.media`, `job.featured` and the variant fields in `DIGESTED_VARIANT_FIELDS` (`platform`, `title`, `url`, `wordpress`, `media`, `mediaMeta`). It may also read the identity and timing fields in `IDENTITY_VARIANT_FIELDS`. It never spreads, enumerates or serialises `job.variant`. The contract suite fails when an adapter reads anything else.
- **Hand-over (#66):** a delivery is `handed_over` from the moment of the claim. `remote_id` is written only after the platform answers. `remote_at` (the platform's time) and `digest` (the content handed over) form the sync baseline. **Edits never push automatically:** nothing but an explicit Push update (UI) or `push_update` (MCP, approved) calls `adapter.update()`.
- **`handed_over` without `remote_id`** found at startup (and not in flight on this device) becomes `check_needed` like a stuck `publishing` (spec §5.1). A lookup that finds it on the platform's schedule returns it to `handed_over` (new transition `check_needed → handed_over`).
- **M3 P11:** a lookup that answers "not found" moves a `check_needed` publish to `failed` only once the claim is at least `LATE_SUCCESS_WINDOW_MS = 15 * MINUTE` old. A hand-over claim that is not found stays `check_needed` for the user. Until then a late success from another device can still settle it.
- Settings schema **5** (migration 4 → 5 adds nothing but the version, so an older device refuses the newer data instead of stripping the new channel fields).
- Unreadable (frozen) delivery entries are never claimed, handed over, updated or cancelled. Notes held for review (`review: claude`) are never handed over.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The connection drops right after a post request went out, on a platform with no lookup** (Telegram or Discord on a train, a laptop lid closed mid-request). Expected: the delivery ends in `check_needed`, exactly one request was made, it is never retried, and the user is asked to check. Test: Task 5 ("an unanswered sendMessage parks the delivery on check_needed and never sends twice"), which runs the real Telegram adapter through the orchestrator.
2. **Text the platform parses by bytes or markup:** emoji with skin tones, accented letters, CJK next to a mention, link and hashtag on Bluesky; `<`, `>` and `&` in a Telegram post (HTML parse mode). Expected: facets cover exactly the mention, link and tag, and the Telegram message shows the characters literally instead of failing with "can't parse entities". Tests: Task 7 (emoji and accented byte offsets) and Task 5 (`telegramHtml` escaping).
3. **The user edits or moves a handed-over post** (text, image alt, title, calendar drag, composer reschedule) and does nothing else. Expected: the platform keeps the old version, the post shows "Out of sync" in the composer, the calendar chip and the campaign table, and no adapter call happens until Push update. A Push update closer to the platform time than the adapter's lead is refused. Tests: Task 13 ("never pushes an out-of-sync delivery by itself") and Task 14 ("refuses a push too close to the platform time", "moves the local time of a handed-over channel with a baseline, so it shows as out of sync").
4. **A wrong, revoked or missing credential on the publisher device.** Expected: `NeedsUser` with a sentence that names where to fix it (channel settings), and no token, webhook URL, JWT or Basic auth string in the error, the log or a Notice. Tests: the contract suite's "never puts a credential in an error message" (Task 3, run for every adapter), plus the missing-credential tests in Tasks 5, 6, 8, 9 and 11.
5. **A link whose page has no OpenGraph tags, isn't HTML, is very large, answers 404 or never answers.** Expected: the card falls back to the page title or host, or is left out, and the post still goes out. Tests: Task 4 (fallbacks, non-HTML, 404, timeout, cache) and Task 8 ("posts without a card when the page can't be fetched").

## Decisions made while writing this plan (spec gaps)

- **Hand-over happens as early as possible.** On each publisher tick, a `scheduled` delivery on a `native` channel of an `auto` post is handed over once it is at least the adapter's lead (Mastodon 5 min, WordPress 1 min) plus `HANDOVER_MARGIN_MS = 2 min` ahead. Handing over early gives the most "posted with Obsidian closed" coverage. Later edits then show "Out of sync". A delivery too close for a hand-over is posted through the API at its time, as M2 already does for native channels.
- **Mastodon threads are never handed over** (`in_reply_to_id` needs a posted parent). `scheduleRefusal()` says so, and the thread is posted item by item through the API at its time (issue #90: "threads … immediate mode only").
- **A failed hand-over leaves the post `scheduled`** with the reason in `error`. It is retried after 1, 5 and 15 min for transient errors and not again this session for `NeedsUser`/`InvalidContent`, and a Notice says it will be posted from Obsidian at its time instead. The log gets a new result `handover_failed` ("hand-over failed"), never `failed`, because nothing failed to post (same reasoning as M4 P7).
- **Sync baseline on the delivery:** `remote_at` (the time the platform holds) and `digest` (a 53-bit `cyrb53` of platform, title, url, body, media targets with their alt and focus, WordPress fields and featured-image meta). The index computes the same digest for every note (`IndexedVariant.digest`), so a badge needs no file read. Legacy `handed_over` entries without a baseline show no badge ("Handed over", sync unknown).
- **Composer reschedule of a handed-over channel** now moves its local `at` (when it has a baseline), so the post shows "Out of sync (time)". The existing confirmation text ("won't change it there until you push an update") already promised this. MCP `schedule` still refuses posts with handed-over channels.
- **"Revert" in #66 means Revert time.** The plugin stores a digest, not the handed-over text, so it can't restore content; a content change is resolved with Push update, or by undoing the edit (Undo, file history). The third action, **Unschedule on <platform>**, takes the post off the platform's schedule (Mastodon: delete the scheduled status; WordPress: set the post back to draft) and returns the channel to `draft` (`handed_over → scheduled → draft`). Log result `cancelled` ("taken off the platform's schedule").
- **Updating a handed-over Mastodon post** changes only the time with `PUT /api/v1/scheduled_statuses/:id`. Mastodon can't edit a scheduled post's text, so a content change deletes the scheduled status first and schedules a new one. If the new one fails after the delete, the adapter throws `RemoteRemovedError`, and the channel returns to `scheduled` (posted by the hand-over again, or through the API at its time). Deleting first avoids two scheduled copies (a double post).
- **Hand-over settle:** from `SETTLE_AFTER_MS = 3 min` after the platform time, the publisher asks `lookup()` at most every 15 min. `published` → `published` with the URL. Still scheduled → keep, and record a platform-side time change in `remote_at`. `gone` (the adapter is sure: WordPress draft/trash/404) → `failed`. No answer for 24 h → `check_needed`. Mastodon deletes a scheduled status's id when it fires, so it finds the published status by content fingerprint and time. If that fails it answers "can't tell", never "gone".
- **Retry de-duplication** for 5xx retries (retried per M2b P4): Mastodon sends an `Idempotency-Key` derived from path, channel, item and time. Bluesky (attempt ≥ 2) looks for a record with the same text from the last hour before posting. WordPress (attempt ≥ 2) looks for the post by slug first. Telegram and Discord can't de-duplicate. This is a documented residual risk for a 5xx after the platform accepted the post.
- **Bluesky record keys are deterministic:** TID(claim time in µs + item index, clock id from the channel id). `lookup()` is an exact `getRecord` for the first item.
- **Telegram and Discord have no `lookup()`**: the Bot API can't read a channel's history, and a webhook message can only be fetched by the id the lost answer carried. Their `check_needed` stays for the user (Mark published / Not published).
- **`url:` on Telegram, Discord and Mastodon** is appended on its own line when the text doesn't already contain it, matching the assisted share links and the preview's link card. Bluesky uses it for the external link card. WordPress ignores it (its validator already warns).
- **Discord:** `allowed_mentions: { parse: [] }` is sent, so a post never pings `@everyone` or roles by accident. Alt text goes into each attachment's `description`.
- **WordPress:** images embedded in the body and `featured_image` are uploaded to `/wp/v2/media`; `media:` items not embedded in the body are appended as images after the article. Uploads are cached for the session by site, path and size, so a Push update doesn't duplicate them. Note embeds (`![[Other note]]`) and raw HTML are not carried over: raw HTML is escaped, never passed through. Categories and tags are found by name (case-insensitive), or created. The REST root is `<site>/wp-json/wp/v2` **(QA: sites without pretty permalinks)**. Only `https://` sites are accepted (application passwords need HTTPS).
- **Bluesky session:** `createSession` with the handle and app password, `refreshSession` on `ExpiredToken`, and a new login if the refresh fails. Sessions live in memory for the plugin's lifetime. Requests go to the PDS named in the session's DID document, else to the channel's `server`, else to `https://bsky.social`.
- **Link cards:** fetched with `requestUrl` (8 s timeout, at most 512 KB parsed, cached 1 h, failures 5 min, 100 entries). Missing OpenGraph → `twitter:*`, then `<title>` and `meta description`, then the host name. A non-HTML page → a host-only card. A failed fetch → no card (Bluesky posts without one; the preview keeps its current domain-and-URL card).
- **Channel credentials without a secret on the publisher device** make the API send fail with a `NeedsUser` message pointing to the channel settings, instead of silently falling back to the assisted flow. `effectiveMethod` is unchanged. The settings show "no credential" per channel.
- **Token health (spec §5.4)** and "posted" confirmations beyond the existing M3 phone alerts are not in the M5 issues and are left out. Only a per-channel **Test connection** button is added.
- **Smoke checklist file name:** issue #111 names `docs/qa/smoke.md`. This plan writes `docs/qa/m5-smoke.md` (the naming of `docs/qa/m1.md`–`m4.md`), with a release-notes template that links it.

---

## File Structure

```
src/platforms/http.ts                 HttpFn, obsidianHttp, send, ApiClient (prepare/commit/read/exchange/error), kindForStatus, retryAfterMs, header, parseJson, HTTP_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, RequestTimeoutError
src/platforms/multipart.ts            multipart(parts) → { body, contentType }
src/platforms/adapters.ts             AdapterDeps, EmbedFile, createAdapters(deps)
src/platforms/files.ts                readMedia(deps, media), fileName(media), partialNote(i, n, e)
src/platforms/og.ts                   LinkCard, parseLinkCard, LinkCardFetcher
src/platforms/telegram/html.ts        telegramHtml, visibleLength
src/platforms/telegram/api.ts         TelegramAdapter, telegramFailure, messageUrl, TelegramChat
src/platforms/discord/api.ts          DiscordAdapter, parseWebhook, discordFailure
src/platforms/bluesky/richtext.ts     buildFacets, findLinks, findMentions, findTags, utf8Length, Facet
src/platforms/bluesky/tid.ts          tid, tidMicros, postRkey, TID_RE
src/platforms/bluesky/api.ts          BlueskyAdapter, blueskyFailure, BSKY_SERVICE, BLOB_MAX
src/platforms/mastodon/api.ts         MastodonAdapter, mastodonFailure, mastodonBase, toMastodonFocus, fingerprint, MASTODON_MIN_LEAD_MS
src/platforms/wordpress/markdown.ts   markdownToHtml, imageEmbeds
src/platforms/wordpress/api.ts        WordPressAdapter, wordpressFailure, gmt, WP_MIN_LEAD_MS
src/publish/job.ts                    deliveryJob(v, channel, delivery, content, secret)
src/publish/sync.ts                   DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS, contentDigest, syncInfo, handedOverChannels, outOfSync
src/publish/handover.ts               HandOverService, handOverCandidates, settleCandidates, HANDOVER_MARGIN_MS, SETTLE_AFTER_MS, …
src/composer/SyncPanel.svelte         "Scheduled on <platform>" panel with Push update / Revert time / Unschedule
test/platforms/http.ts                json, text, bytes, netError, hang, queue, sentJson, sentText, formParts (test helpers)
test/platforms/contract/{harness.ts,cases.ts,contract.test.ts,harness.test.ts,record.ts,record.test.ts}
test/platforms/<platform>/{fixtures.ts,contract.ts,adapter.test.ts}   for telegram, discord, bluesky, mastodon, wordpress
test/platforms/{http.test.ts,multipart.test.ts,og.test.ts}
test/platforms/telegram/html.test.ts, test/platforms/bluesky/{richtext.test.ts,tid.test.ts}, test/platforms/wordpress/markdown.test.ts
test/publish/{job.test.ts,sync.test.ts,handover.test.ts,syncActions.test.ts}
test/composer/syncPanel.test.ts
docs/qa/m5-smoke.md, .github/release-notes.md
```

Modified: `src/model/types.ts` (`Delivery.remoteAt`, `Delivery.digest`), `src/model/frontmatter.ts`, `src/model/writer.ts` (`DELIVERY_KEYS`), `src/model/stateMachine.ts` (`check_needed → handed_over`), `src/model/schemas.ts` (channel fields, `zHttpsUrl`), `src/settings/settings.ts` (schema 5), `src/platforms/types.ts`, `src/platforms/errors.ts` (`RemoteRemovedError`), `src/platforms/text.ts` (`withLink`), `src/media/mediaInfo.ts` (export `IMAGE_MIME`), `src/publish/orchestrator.ts`, `src/publish/actions.ts`, `src/publish/log.ts`, `src/publish/vaultLog.ts`, `src/scheduler/scheduler.ts`, `src/scheduler/reconcile.ts`, `src/index/socialIndex.ts` (`digest`), `src/composer/schedule.ts`, `src/composer/Composer.svelte`, `src/settings/ChannelForm.svelte`, `src/views/Chip.svelte`, `src/views/CampaignTable.svelte`, `src/ui/actions.ts` (row menu, row label), `src/ui/context.ts` (`linkCards?`), `src/previews/PvLinkCard.svelte`, `src/styles/{previews.css,composer.css,planner.css}`, `src/main.ts`, `test/fakes/obsidian.ts` (async `requestUrl` handlers), `test/settings/settings.test.ts`, `test/model/{frontmatter,stateMachine}.test.ts`, `test/scheduler/{reconcile,scheduler}.test.ts`, `test/composer/schedule.test.ts`, `test/settings/channelForm.test.ts`, `.github/workflows/release.yml`, `README.md`, `docs/getting-started.md`.

---
### Task 1: Delivery sync baseline, adapter types, the job builder and digest fields

**Files:**
- Modify: `src/model/types.ts`, `src/model/frontmatter.ts:109-141,260-268`, `src/model/writer.ts:23`, `src/model/stateMachine.ts:13`, `src/model/schemas.ts`, `src/settings/settings.ts:14,52-57`, `src/platforms/types.ts`, `src/platforms/errors.ts`, `src/publish/orchestrator.ts`, `src/publish/actions.ts` (`runApi`, `updateApproved`), `src/publish/log.ts`, `src/publish/vaultLog.ts:18-28`
- Create: `src/publish/job.ts`, `src/publish/sync.ts`
- Test: `test/model/frontmatter.test.ts`, `test/model/stateMachine.test.ts`, `test/settings/settings.test.ts`, `test/publish/job.test.ts`, `test/publish/sync.test.ts`, `test/publish/orchestrator.test.ts`, `test/publish/vaultLog.test.ts`

**Interfaces:**
- Consumes: `Delivery`, `Variant`, `Channel` (`src/model/types.ts`); `postItems`, `platformDef`; `LoadedContent` (`src/composer/content.ts`); `cyrb53` (`src/util/hash.ts`); `sendDigest` (`src/publish/actions.ts`).
- Produces:
  - `Delivery.remoteAt?: number` (frontmatter `remote_at`), `Delivery.digest?: string` (frontmatter `digest`).
  - `TRANSITIONS.check_needed` also allows `"handed_over"`.
  - `zHttpsUrl`; `Channel.server?`, `Channel.login?`, `Channel.postAsName?`, `Channel.postAsAvatar?`; `SETTINGS_VERSION = 5`.
  - In `src/platforms/types.ts`: `DeliveryJob.featured?: MediaInfo`; `RemoteState { published: boolean; url?; remoteId?; scheduledAt?: number; gone?: boolean }`; `PublishResult { remoteId: string; url: string; note?: string }`; `ScheduleResult { remoteId: string; url?: string }`; `SyncChange { content: boolean; time: boolean }`; `VerifyResult = { ok: true; account: string } | { ok: false; error: string }`; `PlatformAdapter` gains `readonly minLeadMs?: number`, `scheduleRefusal?(job): string | null`, `update?(job, change?: SyncChange): Promise<{ remoteId?: string } | void>`, `verify?(channel, secret): Promise<VerifyResult>`, and `publish` returns `PublishResult`, `schedule` returns `ScheduleResult`.
  - `RemoteRemovedError` (kind `needs_user`) in `src/platforms/errors.ts`.
  - `deliveryJob(v: Variant, channel: Channel, delivery: Delivery, content: LoadedContent, secret: string | null): DeliveryJob` in `src/publish/job.ts`.
  - `DIGESTED_VARIANT_FIELDS`, `IDENTITY_VARIANT_FIELDS`, `contentDigest(v, body): string` in `src/publish/sync.ts`.
  - `RunResult` published case gains `note?: string`; `AttemptEntry.result` gains `"handed_over" | "handover_failed" | "cancelled"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/model/frontmatter.test.ts` (add `serializeDelivery` to the import from `../../src/model/frontmatter`, and `import { formatDateTime } from "../../src/model/dates";`):
```ts
describe("hand-over baseline (#66)", () => {
  it("reads and writes remote_at and digest on a delivery", () => {
    const at = "2026-10-08T18:00:00+02:00";
    const remoteAt = "2026-10-08T17:30:00+02:00";
    const fm = {
      type: "social-post",
      platform: "mastodon",
      channels: ["ma/you"],
      status: "scheduled",
      deliveries: { "ma/you": { status: "handed_over", at, remote_at: remoteAt, remote_id: "3221", digest: "k3j2h1" } },
    };
    const d = parseVariant(fm, "Social/P.md").value!.deliveries["ma/you"]!;
    expect(d).toEqual({ status: "handed_over", at: Date.parse(at), remoteAt: Date.parse(remoteAt), remoteId: "3221", digest: "k3j2h1" });
    expect(serializeDelivery(d)).toEqual({
      status: "handed_over",
      at: formatDateTime(Date.parse(at)),
      remote_at: formatDateTime(Date.parse(remoteAt)),
      remote_id: "3221",
      digest: "k3j2h1",
    });
  });
});
```

In `test/model/stateMachine.test.ts`, add `["check_needed", "handed_over"],` to the list of allowed transitions (after `["check_needed", "published"],`).

In `test/settings/settings.test.ts`, change the three `toBe(4)` assertions on `schemaVersion` to `toBe(5)`, and append inside `describe("migrateSettings", …)`:
```ts
  it("migrates schema 4 to 5 and keeps the M5 channel fields", () => {
    const s = migrateSettings({
      schemaVersion: 4,
      channels: [
        { id: "wp/blog", platform: "wordpress", name: "Blog", kind: "site", avatarColor: "#888888", method: "native", server: "https://blog.example.com/", login: "editor" },
        { id: "dc/news", platform: "discord", name: "News", kind: "server_channel", avatarColor: "#888888", method: "api", postAsName: "OSMM", postAsAvatar: "https://example.com/a.png" },
      ],
    });
    expect(s.schemaVersion).toBe(5);
    expect(s.channels[0]).toMatchObject({ server: "https://blog.example.com", login: "editor" });
    expect(s.channels[1]).toMatchObject({ postAsName: "OSMM", postAsAvatar: "https://example.com/a.png" });
  });

  it("accepts only https for a channel's server", () => {
    const wp = { id: "wp/blog", platform: "wordpress", name: "Blog", kind: "site", avatarColor: "#888888", method: "native" };
    expect(zChannel.safeParse({ ...wp, server: "http://blog.example.com" }).success).toBe(false);
    expect(zChannel.safeParse({ ...wp, server: "https://blog.example.com/wp" }).success).toBe(true);
  });
```
(add `import { zChannel } from "../../src/model/schemas";`).

Create `test/publish/job.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { deliveryJob } from "../../src/publish/job";
import { channel, img } from "../platforms/fixtures";

const variant = (platform: Variant["platform"], extra: Partial<Variant> = {}): Variant => ({
  path: "Social/P.md",
  platform,
  channels: [],
  mode: "auto",
  status: "scheduled",
  media: [],
  deliveries: {},
  ...extra,
});

describe("deliveryJob", () => {
  it("splits a thread and keeps the media of platforms that show media", () => {
    const job = deliveryJob(variant("mastodon"), channel("ma/you"), { status: "publishing", at: 1 }, { body: "One\n---\nTwo", media: [img()] }, "tok");
    expect(job).toMatchObject({ text: "One\n\nTwo", items: ["One", "Two"], media: [img()], secret: "tok", delivery: { status: "publishing", at: 1 } });
    expect(job.featured).toBeUndefined();
  });

  it("drops media on platforms that show none, and carries the featured image", () => {
    expect(deliveryJob(variant("hackernews"), channel("hn/you"), { status: "publishing" }, { body: "Hi", media: [img()] }, null).media).toEqual([]);
    const wp = deliveryJob(variant("wordpress"), channel("wp/blog"), { status: "handed_over" }, { body: "# Title", media: [], featured: img("cover.png") }, null);
    expect(wp.featured).toEqual(img("cover.png"));
  });
});
```

Create `test/publish/sync.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { sendDigest } from "../../src/publish/actions";
import { contentDigest, DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../src/publish/sync";
import { img } from "../platforms/fixtures";

const base: Variant = {
  path: "Social/P.md",
  platform: "wordpress",
  channels: ["wp/blog"],
  mode: "auto",
  status: "scheduled",
  title: "Hello",
  url: "https://example.com",
  media: ["a.png"],
  mediaMeta: { "a.png": { alt: "A", focus: [0.5, 0.5] }, "cover.png": { alt: "Cover" } },
  deliveries: {},
  wordpress: { slug: "hello", categories: ["News"], tags: [], featuredImage: "cover.png" },
};

describe("contentDigest (#66)", () => {
  it("is stable for the same content", () => {
    expect(contentDigest({ ...base }, "Body")).toBe(contentDigest(base, "Body"));
  });

  it.each<[string, Partial<Variant>]>([
    ["platform", { platform: "mastodon" }],
    ["title", { title: "Hello again" }],
    ["url", { url: "https://example.com/2" }],
    ["media", { media: ["b.png"] }],
    ["mediaMeta (image alt)", { mediaMeta: { ...base.mediaMeta, "a.png": { alt: "Another" } } }],
    ["mediaMeta (featured alt)", { mediaMeta: { ...base.mediaMeta, "cover.png": { alt: "New cover" } } }],
    ["wordpress", { wordpress: { ...base.wordpress!, slug: "hello-2" } }],
  ])("changes when %s changes", (_field, patch) => {
    expect(contentDigest({ ...base, ...patch }, "Body")).not.toBe(contentDigest(base, "Body"));
  });

  it("changes with the body and ignores who, where and when", () => {
    expect(contentDigest(base, "Body!")).not.toBe(contentDigest(base, "Body"));
    const moved = { ...base, scheduledAt: 5, channels: [], status: "draft" as const, deliveries: { "wp/blog": { status: "draft" as const } }, review: "claude" };
    expect(contentDigest(moved, "Body")).toBe(contentDigest(base, "Body"));
  });
});

describe("variant field classes (M4 carry, #87)", () => {
  it("classify every Variant field exactly once", () => {
    // Required<Variant> makes this fail to compile when a field is added to Variant without classifying it here.
    const every: Required<Variant> = {
      ...base,
      campaignLink: "Event X",
      scheduledAt: 1,
      staggerMinutes: 0,
      reminders: [],
      mediaMeta: {},
      invalidDeliveries: [],
      wordpress: base.wordpress!,
      title: "t",
      url: "u",
      review: "claude",
    };
    const classified = [...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(every).sort());
  });

  it("every digested field reaches sendDigest (through the resolved media for media and mediaMeta)", () => {
    const content = { body: "Body", media: [img("a.png")], featured: img("cover.png") };
    const patches: Array<Partial<Variant>> = [{ platform: "mastodon" }, { title: "Other" }, { url: "https://example.com/other" }, { wordpress: { ...base.wordpress!, tags: ["x"] } }];
    for (const patch of patches) expect(sendDigest({ ...base, ...patch }, content)).not.toBe(sendDigest(base, content));
    expect(sendDigest(base, { ...content, media: [img("a.png", 1080, 1080, { alt: "Other" })] })).not.toBe(sendDigest(base, content));
    expect(sendDigest(base, { ...content, featured: img("cover.png", 1080, 1080, { alt: "Other" }) })).not.toBe(sendDigest(base, content));
  });
});
```

Append to `test/publish/orchestrator.test.ts`, inside `describe("PublishOrchestrator", …)`:
```ts
  it("keeps a partial-thread note on the published delivery and in the log (M5)", async () => {
    const note = "Part 2 of 3 was not posted, nor any after it: Telegram: Bad Request (HTTP 400)";
    const { c, orchestrator } = await setup(async () => ({ remoteId: "42", url: "https://t.me/eventx/42", note }));
    expect(await orchestrator.run(P, "tg/event-x")).toEqual({ status: "published", url: "https://t.me/eventx/42", note });
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({ status: "published", error: note });
    expect(c.log.entries.at(-1)).toMatchObject({ result: "published", url: "https://t.me/eventx/42", error: note });
  });
```

Append to `describe("formatLogLine", …)` in `test/publish/vaultLog.test.ts`:
```ts
  it("labels the hand-over results (M5)", () => {
    expect(formatLogLine(entry({ result: "handed_over", url: undefined }), "x", (t) => t)).toContain(" · handed over to the platform");
    expect(formatLogLine(entry({ result: "handover_failed", url: undefined, error: "422" }), "x", (t) => t)).toContain(" · hand-over failed, stays scheduled · 422");
    expect(formatLogLine(entry({ result: "cancelled", url: undefined }), "x", (t) => t)).toContain(" · taken off the platform's schedule");
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/model test/settings/settings.test.ts test/publish/job.test.ts test/publish/sync.test.ts test/publish/orchestrator.test.ts test/publish/vaultLog.test.ts`
Expected: FAIL. `remoteAt`/`digest` are not parsed, `check_needed → handed_over` is illegal, `schemaVersion` is 4, `src/publish/job.ts` and `src/publish/sync.ts` don't exist, the note is dropped, and the new log results have no label (type error).

- [ ] **Step 3: Model and settings**

`src/model/types.ts`, in `Delivery` after `reason?`:
```ts
  /** Native hand-over (#66): the time the platform holds for this post (it moves only when an update is pushed). */
  remoteAt?: number;
  /** Native hand-over (#66): `contentDigest` of what was handed over; the note differs from the platform when it changes. */
  digest?: string;
```

`src/model/frontmatter.ts`, in `parseDeliveries` after the `reason` line:
```ts
    const remoteAt = takeDate(value.remote_at, `${field}.remote_at`, issues);
    if (remoteAt !== undefined) d.remoteAt = remoteAt;
    if (typeof value.digest === "string" && value.digest.trim()) d.digest = value.digest.trim();
```
and in `serializeDelivery` before `return out;`:
```ts
  if (d.remoteAt !== undefined) out.remote_at = formatDateTime(d.remoteAt);
  if (d.digest) out.digest = d.digest;
```

`src/model/writer.ts`:
```ts
const DELIVERY_KEYS = ["status", "at", "url", "remote_id", "error", "attempts", "reason", "remote_at", "digest"];
```

`src/model/stateMachine.ts`:
```ts
  // M5: a lookup that finds an interrupted hand-over on the platform's schedule returns it to handed_over.
  check_needed: ["published", "failed", "scheduled", "skipped", "handed_over"],
```

`src/model/schemas.ts`, after `zSecretId`:
```ts
/** An https address without a trailing slash: a Mastodon instance, a Bluesky PDS, a WordPress site (M5). */
export const zHttpsUrl = z
  .string()
  .trim()
  .regex(/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/, "Use an https:// address")
  .transform((s) => s.replace(/\/+$/, ""));
```
and in the `zChannel` object after `maxChars`:
```ts
    /** Mastodon instance, Bluesky PDS or WordPress site (M5). */
    server: zHttpsUrl.optional(),
    /** WordPress user name for the application password (M5). */
    login: z.string().trim().min(1).max(120).optional(),
    /** Discord webhook: post under this name and avatar (M5). */
    postAsName: z.string().trim().min(1).max(80).optional(),
    postAsAvatar: zHttpsUrl.optional(),
```

`src/settings/settings.ts`: `export const SETTINGS_VERSION = 5;` and add to `MIGRATIONS`:
```ts
  // M5: optional channel fields (server, login, postAsName, postAsAvatar). Nothing to convert; the bump makes an
  // older plugin refuse this data instead of saving it back without those fields.
  4: (raw) => ({ ...raw, schemaVersion: 5 }),
```

- [ ] **Step 4: Adapter types and the new error**

In `src/platforms/types.ts`, add `featured` to `DeliveryJob` and replace `RemoteState` and `PlatformAdapter`:
```ts
export interface DeliveryJob {
  variant: Variant;
  channel: Channel;
  delivery: Delivery;
  /** The whole post as the platform receives it. */
  text: string;
  /** Thread items (a single item on platforms without threads). */
  items: string[];
  media: MediaInfo[];
  /** WordPress: the resolved `featured_image` (part of `sendDigest`). */
  featured?: MediaInfo;
  /** The channel's credential on this device, if any. */
  secret: string | null;
}

/** What the platform says about a post. `published: false` with nothing else means "not found". */
export interface RemoteState {
  published: boolean;
  url?: string;
  remoteId?: string;
  /** Still waiting in the platform's own schedule (native hand-over), at this time. */
  scheduledAt?: number;
  /** The platform is sure it no longer has the post (deleted or taken off its schedule there). */
  gone?: boolean;
}

export interface PublishResult {
  remoteId: string;
  url: string;
  /** The post is out, but not all of it (a thread cut short); shown to the user and kept on the delivery. */
  note?: string;
}

export interface ScheduleResult {
  remoteId: string;
  url?: string;
}

/** What differs from the platform's copy of a handed-over post (#66). */
export interface SyncChange {
  content: boolean;
  time: boolean;
}

export type VerifyResult = { ok: true; account: string } | { ok: false; error: string };

/**
 * Network operations of one platform (spec §4.1). Every request goes through `ApiClient` (src/platforms/http.ts),
 * and every adapter passes the contract suite (test/platforms/contract). An adapter reads post content only from
 * the job and from DIGESTED_VARIANT_FIELDS (src/publish/sync.ts).
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** How far ahead a native hand-over must be (Mastodon: 5 minutes). */
  readonly minLeadMs?: number;
  publish?(job: DeliveryJob): Promise<PublishResult>;
  /** Hands the post over to the platform's scheduler for `job.delivery.at`. */
  schedule?(job: DeliveryJob): Promise<ScheduleResult>;
  /** Why this job can't be handed over (a Mastodon thread), or null. */
  scheduleRefusal?(job: DeliveryJob): string | null;
  /** Pushes the note's current version (#66). `change` is absent for a live post edited through push_update. */
  update?(job: DeliveryJob, change?: SyncChange): Promise<{ remoteId?: string } | void>;
  /** Takes a handed-over post off the platform's schedule. */
  cancel?(job: DeliveryJob): Promise<void>;
  lookup?(job: DeliveryJob): Promise<RemoteState | null>;
  /** Channel settings "Test connection". Never throws. */
  verify?(channel: Channel, secret: string | null): Promise<VerifyResult>;
}
```

Append to `src/platforms/errors.ts`:
```ts
/**
 * M5 (#66): the platform's copy of a handed-over post is gone (a Mastodon content update removed the scheduled
 * post and could not schedule the new one; a WordPress post was deleted on the site). The caller returns the
 * delivery to `scheduled`, so the post still goes out from Obsidian.
 */
export class RemoteRemovedError extends PublishError {
  constructor(message: string) {
    super("needs_user", message);
    this.name = "RemoteRemovedError";
  }
}
```

- [ ] **Step 5: The job builder and the digest fields**

Create `src/publish/job.ts`:
```ts
import type { LoadedContent } from "../composer/content";
import type { Channel, Delivery, Variant } from "../model/types";
import { platformDef } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { DeliveryJob } from "../platforms/types";

/** Everything an adapter receives for one delivery, built one way for publish, schedule, update, cancel and lookup. */
export function deliveryJob(v: Variant, channel: Channel, delivery: Delivery, content: LoadedContent, secret: string | null): DeliveryJob {
  const def = platformDef(v.platform);
  const items = postItems(content.body, def);
  return {
    variant: v,
    channel,
    delivery,
    text: items.join("\n\n"),
    items,
    media: def.capabilities.media.maxCount > 0 ? content.media : [],
    ...(content.featured ? { featured: content.featured } : {}),
    secret,
  };
}
```

Create `src/publish/sync.ts`:
```ts
import type { Variant } from "../model/types";
import { cyrb53 } from "../util/hash";

/**
 * Variant fields that are post content. `sendDigest` covers each of them (media and mediaMeta through the
 * resolved media), so an approved or handed-over post is only sent while they are unchanged. An adapter may
 * read content only from these and from the job's text, items, media and featured image (M4 carry, #87).
 */
export const DIGESTED_VARIANT_FIELDS = ["platform", "title", "url", "media", "mediaMeta", "wordpress"] as const;

/** Variant fields that say who, where and when, not what: adapters may read them freely. */
export const IDENTITY_VARIANT_FIELDS = [
  "path",
  "campaignLink",
  "channels",
  "mode",
  "status",
  "scheduledAt",
  "staggerMinutes",
  "reminders",
  "deliveries",
  "invalidDeliveries",
  "review",
] as const;

type DigestedField = (typeof DIGESTED_VARIANT_FIELDS)[number];

/**
 * What a hand-over sent, as a short string (#66): computed by the index for every note and stored on the delivery
 * at hand-over. Built from the note itself (no file reads), so it covers the same content as `sendDigest`
 * except the resolved vault paths of the media.
 */
export function contentDigest(v: Pick<Variant, DigestedField>, body: string): string {
  const meta = (target: string) => [v.mediaMeta?.[target]?.alt ?? null, v.mediaMeta?.[target]?.focus ?? null];
  const featured = v.wordpress?.featuredImage;
  const parts = [v.platform, v.title ?? "", v.url ?? "", body, v.media.map((t) => [t, ...meta(t)]), v.wordpress ?? null, featured ? meta(featured) : null];
  return cyrb53(JSON.stringify(parts)).toString(36);
}
```

- [ ] **Step 6: Use the job builder in the orchestrator and PublishActions; keep a partial-thread note**

In `src/publish/orchestrator.ts`:
- Import `deliveryJob` from `./job` and `PublishResult` type is not needed (the adapter's return type carries it).
- `RunResult`: `| { status: "published"; url: string; note?: string }`.
- In `Prepared`, remove `items` and `media` (the job builder derives them from `content`); in `run()`, remove `items: postItems(content.body, def),` and `media: def.capabilities.media.maxCount > 0 ? content.media : [],` and the now-unused `def` constant; remove the `postItems` import if it becomes unused.
- In `send()`, replace the literal job with:
```ts
    const job = deliveryJob(claim.variant, p.channel, claim.delivery, p.content, p.secret);
```
and the success branch with:
```ts
      const res = await p.publish(job);
      const at = this.deps.now();
      // A thread cut short: the post is out, so it is published; the note says what is missing (redacted like any error).
      const note = res.note ? p.redact(res.note) : undefined;
      const settled = await this.settle(
        p.file,
        p.channelId,
        (d) => {
          const next = transition(d, "published", { url: res.url, remoteId: res.remoteId, at });
          delete next.error;
          if (note) next.error = note;
          return next;
        },
        FROM_PUBLISHING_OR_CHECK_NEEDED,
      );
      void this.deps.log.append({ at, path: p.path, channelId: p.channelId, result: "published", url: res.url, ...(note ? { error: note } : {}) });
      this.announcePublished({ path: p.path, channelId: p.channelId, url: res.url });
      if (settled !== true) return { done: true, result: changedUnderneath(settled) };
      return { done: true, result: { status: "published", url: res.url, ...(note ? { note } : {}) } };
```
- In `lookup()`, replace the job literal:
```ts
    const content = await this.deps.content.load(v);
    const secret = channel.secretId ? this.deps.secrets.get(channel.secretId) : null;
    return this.timedLookup(() => adapter.lookup!(deliveryJob(v, channel, delivery, content, secret)));
```

In `src/publish/actions.ts`:
- `runApi`, the published branch:
```ts
    if (result.status === "published") new Notice(result.note ? `Published to ${name}. ${result.note}` : `Published to ${name}.`);
```
- `updateApproved`: replace the `adapter.update({ … })` literal with `await adapter.update(deliveryJob(v, channel, d, content, secretId ? this.deps.secrets.get(secretId) : null));` and drop the now-unused `def`/`items` locals (import `deliveryJob` from `./job`).

- [ ] **Step 7: Log results**

`src/publish/log.ts`:
```ts
  result:
    | "published"
    | "failed"
    | "retry"
    | "skipped"
    | "awaiting_you"
    | "overdue"
    | "check_needed"
    | "updated"
    | "update_failed"
    | "handed_over"
    | "handover_failed"
    | "cancelled";
```
`src/publish/vaultLog.ts`, in `RESULT_LABEL`:
```ts
  handed_over: "handed over to the platform",
  handover_failed: "hand-over failed, stays scheduled",
  cancelled: "taken off the platform's schedule",
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run test/model test/settings test/publish`
Expected: PASS.

- [ ] **Step 9: Run the whole gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass. Where a test outside these files builds a `RunResult` or a `DeliveryJob` literal, TypeScript points at it; add the missing optional field only where the compiler asks.

- [ ] **Step 10: Commit**

```bash
git add src/model/types.ts src/model/frontmatter.ts src/model/writer.ts src/model/stateMachine.ts src/model/schemas.ts src/settings/settings.ts src/platforms/types.ts src/platforms/errors.ts src/publish/job.ts src/publish/sync.ts src/publish/orchestrator.ts src/publish/actions.ts src/publish/log.ts src/publish/vaultLog.ts test/model/frontmatter.test.ts test/model/stateMachine.test.ts test/settings/settings.test.ts test/publish/job.test.ts test/publish/sync.test.ts test/publish/orchestrator.test.ts test/publish/vaultLog.test.ts
git commit -m "feat(publish): hand-over baseline on deliveries, adapter result types, one job builder, digest field classes (#66, #87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: HTTP client with phases, multipart and shared adapter helpers (#87, part 1)

**Files:**
- Create: `src/platforms/http.ts`, `src/platforms/multipart.ts`, `src/platforms/files.ts`, `test/platforms/http.ts`, `test/platforms/http.test.ts`, `test/platforms/multipart.test.ts`, `test/platforms/files.test.ts`
- Modify: `src/platforms/text.ts` (`withLink`), `test/platforms/text.test.ts`, `test/fakes/obsidian.ts:864-884` (async handlers)

**Interfaces:**
- Consumes: `requestUrl` (Obsidian), `withTimeout` (`src/util/time.ts`), the error classes (`src/platforms/errors.ts`), `PLATFORM_META`, `randomString` (`src/model/ids.ts`), `MediaInfo`.
- Produces:
  - `HTTP_TIMEOUT_MS = 30_000`, `UPLOAD_TIMEOUT_MS = 120_000`; `interface HttpResponse { status; headers; text; arrayBuffer }`; `type HttpFn = (req: RequestUrlParam) => Promise<HttpResponse>`; `interface HttpRequest extends RequestUrlParam { timeoutMs?: number }`; `obsidianHttp: HttpFn`; `send(http, req, timeoutMs): Promise<HttpResponse>`; `RequestTimeoutError`; `header(headers, name)`; `parseJson(text)`; `isOk(res)`; `retryAfterMs(headers, now)`; `kindForStatus(status)`.
  - `interface ApiFailure { message: string; kind?: ErrorKind; retryAfterMs?: number }`; `type Phase = "prepare" | "commit" | "read"`; `class ApiClient { constructor({ platform, http, now, timeoutMs?, failure(res): ApiFailure }); prepare(req); commit(req); read(req); exchange(phase, req); error(res): PublishError }`.
  - `type Part`, `multipart(parts, boundary?) → { body: ArrayBuffer; contentType: string }`.
  - `readMedia(read, media): Promise<ArrayBuffer>`, `fileName(media): string`, `partialNote(index, total, error): string` in `src/platforms/files.ts`.
  - `withLink(text, url): string` in `src/platforms/text.ts`.
  - Test helpers: `Fixture`, `json`, `text`, `html`, `bytes`, `netError`, `hang`, `queue`, `call`, `sentText`, `sentJson`, `parseForm`, `formParts`.

- [ ] **Step 1: Let the fake requestUrl answer asynchronously**

In `test/fakes/obsidian.ts`:
```ts
/** Test-only: queue one handler per expected request; every request is recorded in `calls`. A handler may return a promise (a slow or silent server). */
export const requestUrlMock = {
  queue: [] as Array<(req: RequestUrlParam) => RequestUrlResponse | Error | Promise<RequestUrlResponse | Error>>,
  calls: [] as RequestUrlParam[],
  reset(): void {
    this.queue = [];
    this.calls = [];
  },
};

export async function requestUrl(req: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const param = typeof req === "string" ? { url: req } : req;
  requestUrlMock.calls.push(param);
  const handler = requestUrlMock.queue.shift();
  if (!handler) throw new Error(`No requestUrl fixture for ${param.url}`);
  const res = await handler(param);
  if (res instanceof Error) throw res;
  if (res.status >= 400 && param.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${res.status}`), { status: res.status, headers: res.headers });
  }
  return res;
}
```

- [ ] **Step 2: Write the test helpers**

Create `test/platforms/http.ts`:
```ts
import { requestUrlMock, type RequestUrlParam, type RequestUrlResponse } from "../fakes/obsidian";

/** One scripted answer of the fake requestUrl. */
export type Fixture = (req: RequestUrlParam) => RequestUrlResponse | Error | Promise<RequestUrlResponse | Error>;

const encoder = new TextEncoder();
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

export function text(status: number, body: string, headers: Record<string, string> = {}): Fixture {
  return () => ({ status, headers: { "content-type": "text/plain; charset=utf-8", ...headers }, text: body, json: null, arrayBuffer: buffer(encoder.encode(body)) });
}

export function html(status: number, body: string, headers: Record<string, string> = {}): Fixture {
  return text(status, body, { "content-type": "text/html; charset=utf-8", ...headers });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Fixture {
  const t = JSON.stringify(body);
  return () => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, text: t, json: body, arrayBuffer: buffer(encoder.encode(t)) });
}

export function bytes(status: number, data: Uint8Array, contentType: string): Fixture {
  return () => ({ status, headers: { "content-type": contentType }, text: "", json: null, arrayBuffer: buffer(data) });
}

/** The connection failed (no HTTP status). */
export const netError: Fixture = () => new Error("net::ERR_CONNECTION_RESET");
/** The server never answers. */
export const hang: Fixture = () => new Promise<never>(() => undefined);

export function queue(...fixtures: Fixture[]): void {
  requestUrlMock.queue.push(...fixtures);
}

export function call(i: number): RequestUrlParam {
  const c = requestUrlMock.calls[i];
  if (!c) throw new Error(`No request #${i}; ${requestUrlMock.calls.length} were made`);
  return c;
}

export function sentText(i: number): string {
  const body = call(i).body;
  if (body === undefined) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sentJson(i: number): any {
  return JSON.parse(sentText(i));
}

export interface FormPart {
  value?: string;
  filename?: string;
  type?: string;
  size: number;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parses a multipart/form-data body byte by byte (file parts report their size, text parts their value). */
export function parseForm(body: string | ArrayBuffer | undefined, contentType: string | undefined): Record<string, FormPart> {
  const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
  if (!boundary || !(body instanceof ArrayBuffer)) throw new Error("not a multipart body");
  const bytes = new Uint8Array(body);
  const delimiter = encoder.encode(`--${boundary}`);
  const blank = encoder.encode("\r\n\r\n");
  const out: Record<string, FormPart> = {};
  let start = indexOf(bytes, delimiter, 0);
  while (start !== -1) {
    const next = indexOf(bytes, delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = bytes.subarray(start + delimiter.length + 2, next - 2);
    const headEnd = indexOf(chunk, blank, 0);
    const head = new TextDecoder().decode(chunk.subarray(0, headEnd));
    const data = chunk.subarray(headEnd + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const type = /Content-Type: (.+)/i.exec(head)?.[1]?.trim();
    out[name] = filename !== undefined ? { filename, ...(type ? { type } : {}), size: data.length } : { value: new TextDecoder().decode(data), size: data.length };
    start = next;
  }
  return out;
}

export function formParts(i: number): Record<string, FormPart> {
  return parseForm(call(i).body, call(i).contentType);
}
```

- [ ] **Step 3: Write the failing tests**

Create `test/platforms/http.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, TransientError, UnknownOutcomeError } from "../../src/platforms/errors";
import { ApiClient, kindForStatus, obsidianHttp, RequestTimeoutError, retryAfterMs, send, type ApiFailure, type HttpResponse } from "../../src/platforms/http";
import { call, hang, json, netError, queue } from "./http";

const NOW = Date.UTC(2026, 9, 8, 8);
const errorText = (res: HttpResponse): ApiFailure => ({ message: String((JSON.parse(res.text) as { error?: string }).error) });
const client = (failure: (res: HttpResponse) => ApiFailure = errorText) => new ApiClient({ platform: "mastodon", http: obsidianHttp, now: () => NOW, timeoutMs: 30, failure });
const TOKEN_URL = "https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage";

describe("send", () => {
  it("asks requestUrl not to throw and returns any status", async () => {
    queue(json(404, { error: "Record not found" }));
    const res = await send(obsidianHttp, { url: "https://x.example/a", method: "GET" }, 1000);
    expect(res.status).toBe(404);
    expect(call(0).throw).toBe(false);
  });

  it("gives up after the timeout, or after the request's own timeout", async () => {
    queue(hang, hang);
    await expect(send(obsidianHttp, { url: "https://x.example/a" }, 20)).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(send(obsidianHttp, { url: "https://x.example/a", timeoutMs: 20 }, 60_000)).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});

describe("ApiClient phases (M2b P4)", () => {
  it("prepare: a failed connection is transient, says nothing was posted, and never shows the URL", async () => {
    queue(netError);
    const e = await client().prepare({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransientError);
    expect((e as Error).message).toBe("Mastodon: the connection failed before posting; nothing was posted.");
    expect((e as Error).message).not.toContain("SECRET");
  });

  it("prepare: no answer in time is transient", async () => {
    queue(hang);
    const e = await client().prepare({ url: "https://x.example/media", method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransientError);
    expect((e as Error).message).toBe("Mastodon: no answer in time before posting; nothing was posted.");
  });

  it("commit: a failed connection or no answer is an unknown outcome", async () => {
    queue(netError, hang);
    await expect(client().commit({ url: TOKEN_URL, method: "POST" })).rejects.toBeInstanceOf(UnknownOutcomeError);
    const e = await client().commit({ url: TOKEN_URL, method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownOutcomeError);
    expect((e as Error).message).toBe("Mastodon: no answer in time while posting, so it is not known whether it went out.");
  });

  it.each<[number, new (...args: never[]) => Error]>([
    [401, NeedsUserError],
    [403, NeedsUserError],
    [404, NeedsUserError],
    [409, NeedsUserError],
    [400, InvalidContentError],
    [413, InvalidContentError],
    [422, InvalidContentError],
    [408, TransientError],
    [429, TransientError],
    [500, TransientError],
    [503, TransientError],
  ])("classifies HTTP %i", async (status, cls) => {
    queue(json(status, { error: "Nope" }));
    const e = await client().commit({ url: "https://x.example/p", method: "POST" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(cls);
    expect((e as Error).message).toBe(`Mastodon: Nope (HTTP ${status})`);
  });

  it("reads the wait from Retry-After, in seconds or as a date", async () => {
    queue(json(429, { error: "Slow down" }, { "Retry-After": "30" }));
    expect(await client().commit({ url: "https://x.example/p" }).catch((e: TransientError) => e.retryAfterMs)).toBe(30_000);
    expect(retryAfterMs({ "retry-after": new Date(NOW + 90_000).toUTCString() }, NOW)).toBe(90_000);
    expect(retryAfterMs({}, NOW)).toBeUndefined();
  });

  it("lets the platform's error body choose the class and the wait", async () => {
    queue(json(400, {}), json(429, {}, { "Retry-After": "1" }));
    await expect(client(() => ({ message: "chat not found", kind: "needs_user" })).commit({ url: "https://x.example/p" })).rejects.toBeInstanceOf(NeedsUserError);
    const waited = await client(() => ({ message: "retry after 7", retryAfterMs: 7000 }))
      .commit({ url: "https://x.example/p" })
      .catch((e: TransientError) => e.retryAfterMs);
    expect(waited).toBe(7000);
  });

  it("read returns every status and lets network errors through as they are", async () => {
    queue(json(404, { error: "x" }), netError);
    expect((await client().read({ url: "https://x.example/p" })).status).toBe(404);
    await expect(client().read({ url: "https://x.example/p" })).rejects.toThrow("net::ERR_CONNECTION_RESET");
  });

  it("exchange applies the phase to network errors but returns HTTP errors to the caller", async () => {
    queue(json(400, { error: "ExpiredToken" }), netError);
    expect((await client().exchange("commit", { url: "https://x.example/p" })).status).toBe(400);
    await expect(client().exchange("commit", { url: "https://x.example/p" })).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it("maps statuses to kinds", () => {
    expect([401, 403, 404, 400, 422, 429, 500].map(kindForStatus)).toEqual(["needs_user", "needs_user", "needs_user", "invalid_content", "invalid_content", "transient", "transient"]);
  });
});
```

Create `test/platforms/multipart.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { multipart } from "../../src/platforms/multipart";
import { parseForm } from "./http";

describe("multipart", () => {
  it("encodes text fields and files with their names and types", () => {
    const photo = new Uint8Array([1, 2, 3, 13, 10]).buffer;
    const { body, contentType } = multipart(
      [
        { name: "chat_id", value: "@eventx" },
        { name: "caption", value: "Café 👋" },
        { name: "photo", filename: "cover.png", contentType: "image/png", data: photo },
      ],
      "b0undary",
    );
    expect(contentType).toBe("multipart/form-data; boundary=b0undary");
    expect(parseForm(body, contentType)).toEqual({
      chat_id: { value: "@eventx", size: 7 },
      caption: { value: "Café 👋", size: 10 },
      photo: { filename: "cover.png", type: "image/png", size: 5 },
    });
  });

  it("never lets a name or file name break the part header", () => {
    const { body, contentType } = multipart([
      { name: 'a"b', value: "x" },
      { name: "f", filename: 'x"\r\n.png', contentType: "image/png", data: new Uint8Array([1]).buffer },
    ]);
    expect(parseForm(body, contentType)).toEqual({ a_b: { value: "x", size: 1 }, f: { filename: "x___.png", type: "image/png", size: 1 } });
  });
});
```

Create `test/platforms/files.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, UnknownOutcomeError } from "../../src/platforms/errors";
import { fileName, partialNote, readMedia } from "../../src/platforms/files";
import { img } from "./fixtures";

describe("adapter file helpers", () => {
  it("reads a resolved image and refuses a missing or unreadable one as needs-user", async () => {
    const data = new Uint8Array([1, 2]).buffer;
    expect(await readMedia(async () => data, img())).toBe(data);
    await expect(readMedia(async () => data, img("gone.png", 1, 1, { path: undefined, kind: "missing" }))).rejects.toThrow(new NeedsUserError("gone.png can't be found in the vault."));
    await expect(readMedia(async () => Promise.reject(new Error("EACCES")), img())).rejects.toThrow(new NeedsUserError("a.png can't be read from the vault."));
  });

  it("makes a safe upload file name", () => {
    expect(fileName(img("Event X cover (final).png", 1, 1, { path: "Social/Event X cover (final).png" }))).toBe("Event-X-cover-final-.png");
  });

  it("says which thread part stopped, and whether it may have gone out", () => {
    expect(partialNote(1, 3, new InvalidContentError("Bluesky: too long (HTTP 400)"))).toBe("Part 2 of 3 was not posted, nor any after it: Bluesky: too long (HTTP 400)");
    expect(partialNote(2, 3, new UnknownOutcomeError("Bluesky: no answer in time while posting, so it is not known whether it went out."))).toBe(
      "Part 3 of 3 may not have been posted, nor any after it: Bluesky: no answer in time while posting, so it is not known whether it went out.",
    );
  });
});
```

Append to `test/platforms/text.test.ts` (import `withLink` from `../../src/platforms/text`):
```ts
describe("withLink", () => {
  it("adds the link on its own line unless the text already has it", () => {
    expect(withLink("Doors open", "https://event.example/x")).toBe("Doors open\n\nhttps://event.example/x");
    expect(withLink("See https://event.example/x", "https://event.example/x")).toBe("See https://event.example/x");
    expect(withLink("", "https://event.example/x")).toBe("https://event.example/x");
    expect(withLink("Doors open", undefined)).toBe("Doors open");
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run test/platforms/http.test.ts test/platforms/multipart.test.ts test/platforms/files.test.ts test/platforms/text.test.ts`
Expected: FAIL (modules and `withLink` missing).

- [ ] **Step 5: Implement the HTTP client**

Create `src/platforms/http.ts`:
```ts
import { requestUrl, type RequestUrlParam } from "obsidian";
import { PLATFORM_META, type Platform } from "../model/platforms";
import { withTimeout } from "../util/time";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, UnknownOutcomeError, type ErrorKind } from "./errors";

/** requestUrl has no timeout of its own (M3 final review 2). */
export const HTTP_TIMEOUT_MS = 30_000;
/** Requests that carry files: uploads, Telegram photos, Discord attachments. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** One HTTP exchange: resolves for every status, rejects when the connection fails. */
export type HttpFn = (req: RequestUrlParam) => Promise<HttpResponse>;

export interface HttpRequest extends RequestUrlParam {
  /** This request's own timeout (uploads); otherwise the client's. */
  timeoutMs?: number;
}

/** Obsidian's requestUrl (no CORS limits, works on phones), always with `throw: false`. */
export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({ ...req, throw: false });
  let text = "";
  try {
    text = res.text;
  } catch {
    // A binary body (an image) has no text.
  }
  return { status: res.status, headers: res.headers ?? {}, text, arrayBuffer: res.arrayBuffer };
};

export class RequestTimeoutError extends Error {
  constructor() {
    super("No answer in time.");
    this.name = "RequestTimeoutError";
  }
}

const TIMED_OUT = Symbol("timed out");

/** Sends one request; a request with no answer within the timeout rejects with RequestTimeoutError. */
export async function send(http: HttpFn, req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
  const { timeoutMs: own, ...param } = req;
  const res = await withTimeout(http({ ...param, throw: false }), own ?? timeoutMs, TIMED_OUT);
  if (res === TIMED_OUT) throw new RequestTimeoutError();
  return res;
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const isOk = (res: HttpResponse): boolean => res.status >= 200 && res.status < 300;

/** Retry-After in seconds or as an HTTP date. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | undefined {
  const raw = header(headers, "retry-after");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Spec §5.3 by HTTP status; a platform's error body may say more (ApiFailure.kind). */
export function kindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "needs_user";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status === 400 || status === 413 || status === 422) return "invalid_content";
  return "needs_user";
}

export interface ApiFailure {
  /** Readable text from the platform's error body. Never the request URL or headers: they may carry the credential. */
  message: string;
  kind?: ErrorKind;
  retryAfterMs?: number;
}

/** prepare: before the post exists; commit: creates, changes or deletes it; read: lookups and connection tests. */
export type Phase = "prepare" | "commit" | "read";

export interface ApiClientOptions {
  platform: Platform;
  http: HttpFn;
  now(): number;
  timeoutMs?: number;
  failure(res: HttpResponse): ApiFailure;
}

/**
 * The only way adapters talk to a platform (M2b P4). A failed connection before posting is transient (nothing
 * went out, retrying is safe); during the request that posts, it is an unknown outcome (check_needed, never
 * retried). HTTP errors are classified from the status and the platform's error body.
 */
export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private get label(): string {
    return PLATFORM_META[this.opts.platform].label;
  }

  /** A request made before the post exists (login, upload, id lookups). */
  async prepare(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.exchange("prepare", req);
    if (!isOk(res)) throw this.error(res);
    return res;
  }

  /** The request that creates, changes or deletes the post. */
  async commit(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.exchange("commit", req);
    if (!isOk(res)) throw this.error(res);
    return res;
  }

  /** Lookups and connection tests: every status comes back, and connection failures reject as they are. */
  read(req: HttpRequest): Promise<HttpResponse> {
    return this.exchange("read", req);
  }

  /** Like the phase's method, but HTTP errors come back to the caller (an expired session, a 404 that means "gone"). */
  async exchange(phase: Phase, req: HttpRequest): Promise<HttpResponse> {
    try {
      return await send(this.opts.http, req, this.opts.timeoutMs ?? HTTP_TIMEOUT_MS);
    } catch (e) {
      if (phase === "read") throw e;
      const why = e instanceof RequestTimeoutError ? "no answer in time" : "the connection failed";
      if (phase === "prepare") throw new TransientError(`${this.label}: ${why} before posting; nothing was posted.`);
      throw new UnknownOutcomeError(`${this.label}: ${why} while posting, so it is not known whether it went out.`);
    }
  }

  /** The classified error for an HTTP answer that isn't 2xx. */
  error(res: HttpResponse): PublishError {
    const f = this.opts.failure(res);
    const message = `${this.label}: ${f.message} (HTTP ${res.status})`;
    switch (f.kind ?? kindForStatus(res.status)) {
      case "transient":
        return new TransientError(message, f.retryAfterMs ?? retryAfterMs(res.headers, this.opts.now()));
      case "invalid_content":
        return new InvalidContentError(message);
      case "unknown":
        return new UnknownOutcomeError(message);
      case "needs_user":
        return new NeedsUserError(message);
    }
  }
}
```

- [ ] **Step 6: Implement multipart, the file helpers and withLink**

Create `src/platforms/multipart.ts`:
```ts
import { randomString } from "../model/ids";

export type Part = { name: string; value: string } | { name: string; filename: string; contentType: string; data: ArrayBuffer };

const encoder = new TextEncoder();
/** Quotes, CR and LF would end the header early. */
const safe = (s: string): string => s.replace(/["\r\n\\]/g, "_");

/** A multipart/form-data body for requestUrl (which takes an ArrayBuffer and a content type). */
export function multipart(parts: readonly Part[], boundary = `osmm-${randomString(24)}`): { body: ArrayBuffer; contentType: string } {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const head =
      "value" in p
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"\r\n\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${safe(p.name)}"; filename="${safe(p.filename)}"\r\nContent-Type: ${safe(p.contentType)}\r\n\r\n`;
    chunks.push(encoder.encode(head), "value" in p ? encoder.encode(p.value) : new Uint8Array(p.data), encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
```

Create `src/platforms/files.ts`:
```ts
import { classifyError, NeedsUserError } from "./errors";
import type { MediaInfo } from "./types";

/** The bytes of a resolved image. Checks block missing media before scheduling; this covers a file deleted since. */
export async function readMedia(read: (path: string) => Promise<ArrayBuffer>, m: Pick<MediaInfo, "path" | "target">): Promise<ArrayBuffer> {
  if (!m.path) throw new NeedsUserError(`${m.target} can't be found in the vault.`);
  try {
    return await read(m.path);
  } catch {
    throw new NeedsUserError(`${m.target} can't be read from the vault.`);
  }
}

/** An upload file name without spaces, quotes or path parts. */
export function fileName(m: Pick<MediaInfo, "path" | "target">): string {
  const name = (m.path ?? m.target).split("/").pop() ?? "";
  return name.replace(/[^\w.-]+/g, "-") || "image";
}

/** A thread stopped after its first part(s): the post is out, the rest is not (or may not be). */
export function partialNote(index: number, total: number, e: unknown): string {
  const err = classifyError(e);
  const what = err.kind === "unknown" ? "may not have been posted" : "was not posted";
  return `Part ${index + 1} of ${total} ${what}, nor any after it: ${err.message}`;
}
```

Append to `src/platforms/text.ts`:
```ts
/** The text with `url` on its own last line, unless the text already contains it (Telegram, Discord, Mastodon). */
export function withLink(text: string, url: string | undefined): string {
  if (!url || text.includes(url)) return text;
  return text ? `${text}\n\n${url}` : url;
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run test/platforms test/fakes`
Expected: PASS.

- [ ] **Step 8: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass.
```bash
git add src/platforms/http.ts src/platforms/multipart.ts src/platforms/files.ts src/platforms/text.ts test/fakes/obsidian.ts test/platforms/http.ts test/platforms/http.test.ts test/platforms/multipart.test.ts test/platforms/files.test.ts test/platforms/text.test.ts
git commit -m "feat(platforms): requestUrl client with prepare/commit phases, multipart encoder, shared adapter helpers (#87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Adapter registry and the contract suite (#87, part 2)

**Files:**
- Create: `src/platforms/adapters.ts`, `test/platforms/contract/harness.ts`, `test/platforms/contract/cases.ts`, `test/platforms/contract/contract.test.ts`, `test/platforms/contract/harness.test.ts`, `test/platforms/contract/record.ts`, `test/platforms/contract/record.test.ts`
- Modify: `src/main.ts` (register the adapters), `src/media/mediaInfo.ts:6` (export `IMAGE_MIME`), `test/main.test.ts`

**Interfaces:**
- Consumes: `HttpFn`, `obsidianHttp`, `ApiClient` (Task 2); `PlatformAdapter`, `DeliveryJob`, `RemoteState` (Task 1); `DIGESTED_VARIANT_FIELDS`, `IDENTITY_VARIANT_FIELDS` (Task 1); `classifyError`, `PublishError`; test helpers `Fixture`, `json`, `netError`, `hang` (Task 2).
- Produces:
  - `interface EmbedFile { path: string; name: string; mime: string }`; `interface AdapterDeps { http: HttpFn; now(): number; readBinary(path): Promise<ArrayBuffer>; sleep(ms): Promise<void>; timeoutMs?: number; resolveEmbed?(target, fromPath): EmbedFile | null }` (Task 4 adds `linkCard?`); `createAdapters(deps): PlatformAdapter[]` (empty until Task 5).
  - `OsmmPlugin.adapterDeps(): AdapterDeps` (private) and the registration loop in `onload`.
  - Test side: `interface ContractCase { platform; job(); before; success: { post; expect }; rateLimited: { post; retryAfterMs }; authExpired; forbidden; rejected; serverError; sensitive; lookup?: { job(); found; expect; notFound } }`; `CONTRACT_NOW`, `CONTRACT_TIMEOUT_MS`, `contractDeps()`, `adapterFor(platform, deps?)`, `attempt(run, fixtures): Promise<Outcome>`, `recordReads(obj)`; `CASES: ContractCase[]` (each adapter task adds its case); `recordingHttp(inner, secrets)`, `replay(exchanges)`.

- [ ] **Step 1: Write the harness**

Create `test/platforms/contract/harness.ts`:
```ts
import { requestUrlMock } from "../../fakes/obsidian";
import type { Platform } from "../../../src/model/platforms";
import { createAdapters, type AdapterDeps } from "../../../src/platforms/adapters";
import { classifyError, PublishError } from "../../../src/platforms/errors";
import { obsidianHttp } from "../../../src/platforms/http";
import type { DeliveryJob, PlatformAdapter, RemoteState } from "../../../src/platforms/types";
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
  serverError: Fixture[];
  /** Strings that must never appear in an error message: tokens, webhook URLs, session JWTs, auth headers. */
  sensitive: string[];
  /** Adapters with lookup(): a check_needed job, the answers for "found" and "not found". */
  lookup?: { job(): DeliveryJob; found: Fixture[]; expect: RemoteState; notFound: Fixture[] };
}

export function contractDeps(): AdapterDeps {
  return {
    http: obsidianHttp,
    now: () => CONTRACT_NOW,
    readBinary: async () => PNG.slice().buffer,
    sleep: async () => undefined,
    timeoutMs: CONTRACT_TIMEOUT_MS,
    resolveEmbed: () => null,
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

/** Records every top-level field read from `target`; "*" when it is spread or enumerated (M4 carry). */
export function recordReads<T extends object>(target: T): { proxy: T; reads: Set<string> } {
  const reads = new Set<string>();
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(t, key, receiver) as unknown;
    },
    ownKeys(t) {
      reads.add("*");
      return Reflect.ownKeys(t);
    },
  });
  return { proxy, reads };
}
```

Create `test/platforms/contract/cases.ts`:
```ts
import type { ContractCase } from "./harness";

/** One case per registered API adapter; contract.test.ts fails when createAdapters() has a platform missing here. */
export const CASES: ContractCase[] = [];
```

- [ ] **Step 2: Write the suite and the harness self-test**

Create `test/platforms/contract/contract.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { createAdapters } from "../../../src/platforms/adapters";
import { DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../../src/publish/sync";
import { hang, netError, type Fixture } from "../http";
import { CASES } from "./cases";
import { adapterFor, attempt, contractDeps, recordReads, type ContractCase } from "./harness";

const ALLOWED = new Set<string>([...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS]);

describe("adapter registry (#87)", () => {
  it("has a contract case for every registered API adapter", () => {
    const registered = createAdapters(contractDeps()).map((a) => a.platform);
    expect(CASES.map((c) => c.platform).sort()).toEqual([...registered].sort());
  });
});

function scenarios(c: ContractCase): Array<[string, Fixture[]]> {
  return [
    ["rate limited", [...c.before, ...c.rateLimited.post]],
    ["auth expired", [...c.before, ...c.authExpired]],
    ["forbidden", [...c.before, ...c.forbidden]],
    ["content rejected", [...c.before, ...c.rejected]],
    ["server error", [...c.before, ...c.serverError]],
    ["timeout", [...c.before, hang]],
    ["connection dropped", [...c.before, netError]],
  ];
}

describe.each(CASES.map((c) => [c.platform, c] as const))("%s adapter contract (#87)", (platform, c) => {
  const publish = (job = c.job()) => () => adapterFor(platform).publish!(job);

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
    const job = c.job();
    const { proxy, reads } = recordReads(job.variant);
    await attempt(publish({ ...job, variant: proxy }), [...c.before, ...c.success.post]);
    expect([...reads].filter((k) => !ALLOWED.has(k))).toEqual([]);
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

  it("classifies a 5xx as transient", async () => {
    expect(await attempt(publish(), [...c.before, ...c.serverError])).toMatchObject({ ok: false, kind: "transient" });
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
    for (const [name, fixtures] of scenarios(c)) {
      const out = await attempt(publish(), fixtures);
      expect(out.ok, name).toBe(false);
      if (out.ok) continue;
      for (const secret of c.sensitive) expect(out.message, `${name}: ${out.message}`).not.toContain(secret);
    }
  });

  it.runIf(!!c.lookup)("finds an interrupted post with lookup(), and reports one it can't find", async () => {
    const l = c.lookup!;
    const found = await attempt(() => adapterFor(platform).lookup!(l.job()), l.found);
    expect(found).toEqual({ ok: true, value: expect.objectContaining(l.expect) });
    const missing = await attempt(() => adapterFor(platform).lookup!(l.job()), l.notFound);
    expect(missing).toEqual({ ok: true, value: expect.objectContaining({ published: false }) });
  });
});
```

Create `test/platforms/contract/harness.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ApiClient, obsidianHttp } from "../../../src/platforms/http";
import { DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../../src/publish/sync";
import { hang, json } from "../http";
import { attempt, CONTRACT_NOW, recordReads } from "./harness";

const api = new ApiClient({ platform: "discord", http: obsidianHttp, now: () => CONTRACT_NOW, timeoutMs: 30, failure: () => ({ message: "no" }) });

describe("contract harness", () => {
  it("reports the class the orchestrator would see", async () => {
    expect(await attempt(() => api.commit({ url: "https://x.example/p" }), [json(401, {})])).toMatchObject({ ok: false, kind: "needs_user", message: "Discord: no (HTTP 401)", classifiedByAdapter: true });
    expect(await attempt(() => api.commit({ url: "https://x.example/p" }), [hang])).toMatchObject({ ok: false, kind: "unknown", classifiedByAdapter: true });
    expect(await attempt(async () => 1, [])).toEqual({ ok: true, value: 1 });
  });

  it("flags a field outside the digest lists, and spreading the variant", () => {
    const { proxy, reads } = recordReads({ platform: "telegram", title: "x", firstComment: "hi" } as Record<string, unknown>);
    void proxy.title;
    void proxy.firstComment;
    void { ...proxy };
    const allowed = new Set<string>([...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS]);
    expect([...reads].filter((k) => !allowed.has(k)).sort()).toEqual(["*", "firstComment"]);
  });
});
```

- [ ] **Step 3: Write the recording helper and its test**

Create `test/platforms/contract/record.ts`:
```ts
import type { HttpFn, HttpResponse } from "../../../src/platforms/http";
import { json, type Fixture } from "../http";

export interface RecordedExchange {
  request: { method: string; url: string; contentType?: string; body?: string };
  response: { status: number; headers: Record<string, string>; text: string };
}

const MASK = "•••";

/**
 * Wraps a real HttpFn and keeps every exchange with the given secrets masked, so a live run (QA) can be
 * saved as a fixture file. Binary bodies are summarised, never stored.
 */
export function recordingHttp(inner: HttpFn, secrets: readonly string[]): { http: HttpFn; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];
  const mask = (s: string) => secrets.filter((x) => x.length >= 4).reduce((t, x) => t.split(x).join(MASK), s);
  const http: HttpFn = async (req) => {
    const res: HttpResponse = await inner(req);
    const body = req.body === undefined ? undefined : typeof req.body === "string" ? mask(req.body) : `<binary ${req.body.byteLength} bytes>`;
    exchanges.push({
      request: { method: req.method ?? "GET", url: mask(req.url), ...(req.contentType ? { contentType: req.contentType } : {}), ...(body !== undefined ? { body } : {}) },
      response: { status: res.status, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, mask(v)])), text: mask(res.text) },
    });
    return res;
  };
  return { http, exchanges };
}

/** Turns a recording back into answers for the fake requestUrl. */
export function replay(exchanges: readonly RecordedExchange[]): Fixture[] {
  return exchanges.map((x) => {
    let parsed: unknown = x.response.text;
    try {
      parsed = JSON.parse(x.response.text);
    } catch {
      // Keep text bodies as they are.
    }
    return json(x.response.status, parsed, x.response.headers);
  });
}
```

Create `test/platforms/contract/record.test.ts`:
```ts
// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpFn } from "../../../src/platforms/http";
import { recordingHttp, replay } from "./record";

describe("recordingHttp", () => {
  it("masks secrets in the URL, the body and the answer, and summarises binary bodies", async () => {
    const inner: HttpFn = async () => ({ status: 200, headers: { "x-token": "SECRET-1234" }, text: '{"token":"SECRET-1234"}', arrayBuffer: new ArrayBuffer(0) });
    const { http, exchanges } = recordingHttp(inner, ["SECRET-1234"]);
    await http({ url: "https://api.telegram.org/botSECRET-1234/getMe", method: "POST", body: '{"a":"SECRET-1234"}' });
    await http({ url: "https://x.example/upload", method: "POST", body: new Uint8Array([1, 2, 3]).buffer });
    expect(JSON.stringify(exchanges)).not.toContain("SECRET-1234");
    expect(exchanges[1]!.request.body).toBe("<binary 3 bytes>");
    expect(replay(exchanges)).toHaveLength(2);
  });
});

/**
 * Live recording (QA, never in CI): OSMM_RECORD=telegram OSMM_SECRET=… OSMM_HANDLE=@chan npx vitest run test/platforms/contract/record.test.ts
 * writes test/platforms/<platform>/recorded/publish.json. Compare it with the doc-written fixtures, then delete it or
 * turn it into a fixture. Uses Node's fetch, so it can run outside Obsidian.
 */
describe.skipIf(!process.env.OSMM_RECORD)("live recording", () => {
  it("records one publish", async () => {
    (globalThis as { window?: unknown }).window ??= globalThis;
    const { createAdapters } = await import("../../../src/platforms/adapters");
    const { channel } = await import("../fixtures");
    const platform = process.env.OSMM_RECORD ?? "";
    const secret = process.env.OSMM_SECRET ?? "";
    const fetchHttp: HttpFn = async (req) => {
      const headers = { ...(req.headers ?? {}), ...(req.contentType ? { "Content-Type": req.contentType } : {}) };
      const res = await fetch(req.url, { method: req.method ?? "GET", headers, ...(req.body !== undefined ? { body: req.body } : {}) });
      const arrayBuffer = await res.arrayBuffer();
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
    };
    const { http, exchanges } = recordingHttp(fetchHttp, [secret]);
    const adapter = createAdapters({ http, now: () => Date.now(), readBinary: async () => new ArrayBuffer(0), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }).find((a) => a.platform === platform)!;
    const prefix = { telegram: "tg", discord: "dc", mastodon: "ma", bluesky: "bs", wordpress: "wp" }[platform] ?? "x";
    const text = `OSMM fixture recording ${new Date().toISOString()}`;
    await adapter.publish!({
      variant: { path: "Social/Record.md", platform: platform as never, channels: [], mode: "auto", status: "scheduled", media: [], deliveries: {}, title: text, wordpress: { slug: `osmm-record-${Date.now()}`, categories: [], tags: [] } },
      channel: channel(`${prefix}/record`, { handle: process.env.OSMM_HANDLE, server: process.env.OSMM_SERVER, login: process.env.OSMM_LOGIN }),
      delivery: { status: "publishing", at: Date.now(), attempts: 1 },
      text,
      items: [text],
      media: [],
      secret,
    }).finally(() => {
      const file = join("test/platforms", platform, "recorded", "publish.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(exchanges, null, 2)}\n`);
    });
    expect(exchanges.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Add the main test**

Append to `describe("OsmmPlugin", …)` in `test/main.test.ts` (add `import { createAdapters } from "../src/platforms/adapters";` and `import { PLATFORMS } from "../src/model/platforms";`):
```ts
  it("registers every API adapter the plugin ships (M5)", async () => {
    const { plugin } = await loaded();
    const shipped = createAdapters({ http: async () => ({ status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }), now: () => 0, readBinary: async () => new ArrayBuffer(0), sleep: async () => undefined })
      .map((a) => a.platform)
      .sort();
    expect(PLATFORMS.filter((p) => plugin.adapters.get(p)).sort()).toEqual(shipped);
  });
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `npx vitest run test/platforms/contract test/main.test.ts`
Expected: FAIL (`src/platforms/adapters.ts` missing).

- [ ] **Step 6: Implement the registry and wire it**

Create `src/platforms/adapters.ts`:
```ts
import type { HttpFn } from "./http";
import type { PlatformAdapter } from "./types";

/** A file embedded in a note's body, resolved in the vault (WordPress uploads it). */
export interface EmbedFile {
  path: string;
  name: string;
  mime: string;
}

/** What adapters get from the plugin; tests pass the fake requestUrl and short timeouts. */
export interface AdapterDeps {
  http: HttpFn;
  now(): number;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Waits between polls (Mastodon media processing). */
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  /** Resolves an image embedded in a body (`![[cover.png]]`) to a vault file; null when it isn't an image in the vault. */
  resolveEmbed?(target: string, fromPath: string): EmbedFile | null;
}

/** Every API adapter the plugin ships. The contract suite (test/platforms/contract) runs against exactly this list. */
export function createAdapters(_deps: AdapterDeps): PlatformAdapter[] {
  return [];
}
```

In `src/media/mediaInfo.ts`, export the map: `export const IMAGE_MIME: Readonly<Record<string, string>> = { … };` (unchanged content).

In `src/main.ts`, import `createAdapters, type AdapterDeps` from `./platforms/adapters`, `obsidianHttp` from `./platforms/http` and `IMAGE_MIME` from `./media/mediaInfo`. Right after `this.secrets = new Secrets(this.app);` add:
```ts
    // M5: the API adapters (spec §4.2). Registered on every device; only the publisher dispatches through them.
    for (const adapter of createAdapters(this.adapterDeps())) this.adapters.register(adapter);
```
and add the method (after `setDevice`):
```ts
  private adapterDeps(): AdapterDeps {
    return {
      http: obsidianHttp,
      now: () => Date.now(),
      readBinary: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error(`${path} is not in the vault.`);
        return this.app.vault.readBinary(file);
      },
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      resolveEmbed: (target, fromPath) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(target, fromPath);
        const mime = file ? IMAGE_MIME[file.extension.toLowerCase()] : undefined;
        return file && mime ? { path: file.path, name: file.name, mime } : null;
      },
    };
  }
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run test/platforms/contract test/main.test.ts`
Expected: PASS (the per-adapter suite has no cases yet; the registry test, the harness self-test and the recording test pass; the live recording is skipped).

- [ ] **Step 8: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/adapters.ts src/main.ts src/media/mediaInfo.ts test/main.test.ts test/platforms/contract
git commit -m "test(platforms): adapter contract suite with error classes, digest-read guard and fixture recording (#87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Link cards and the OpenGraph fetcher (#93)

**Files:**
- Create: `src/platforms/og.ts`, `test/platforms/og.test.ts`
- Modify: `src/platforms/adapters.ts` (`AdapterDeps.linkCard?`), `src/ui/context.ts` (`linkCards?`), `src/previews/PvLinkCard.svelte`, `src/styles/previews.css`, `src/main.ts`, `test/previews/pvLinkCard.test.ts`

**Interfaces:**
- Consumes: `send`, `header`, `HttpFn`, `obsidianHttp` (Task 2); `AdapterDeps` (Task 3).
- Produces:
  - `interface LinkCard { url: string; title: string; description: string; image?: string; siteName?: string }`.
  - `parseLinkCard(html: string, url: string): LinkCard`.
  - `class LinkCardFetcher { constructor({ http, now, timeoutMs? }); get(url): Promise<LinkCard | null>; peek(url): LinkCard | null | undefined }`; `CARD_TIMEOUT_MS = 8_000`, `CARD_TTL_MS`, `CARD_FAILURE_TTL_MS`, `CARD_CACHE_SIZE = 100`.
  - `AdapterDeps.linkCard?(url: string): Promise<LinkCard | null>` (Bluesky uses it in Task 8).
  - `OsmmContext.linkCards?: Pick<LinkCardFetcher, "get" | "peek">`; `OsmmPlugin.linkCards: LinkCardFetcher`.

- [ ] **Step 1: Write the failing tests**

Create `test/platforms/og.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../fakes/obsidian";
import { obsidianHttp } from "../../src/platforms/http";
import { CARD_FAILURE_TTL_MS, CARD_TTL_MS, LinkCardFetcher, parseLinkCard } from "../../src/platforms/og";
import { bytes, call, hang, html, json, queue } from "./http";

const URL = "https://event.example/x";
const FULL = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Event X, Berlin">
  <meta property="og:description" content="Monthly makers evening">
  <meta property="og:image" content="/img/cover.png">
  <meta property="og:site_name" content="Event X">
</head><body></body></html>`;

function fetcher(now = { t: 0 }) {
  return { now, cards: new LinkCardFetcher({ http: obsidianHttp, now: () => now.t, timeoutMs: 20 }) };
}

describe("parseLinkCard", () => {
  it("reads OpenGraph and resolves a relative image", () => {
    expect(parseLinkCard(FULL, URL)).toEqual({ url: URL, title: "Event X, Berlin", description: "Monthly makers evening", image: "https://event.example/img/cover.png", siteName: "Event X" });
  });

  it("falls back to twitter tags, then the title and meta description, then the host", () => {
    expect(parseLinkCard('<meta name="twitter:title" content="T"><meta name="twitter:description" content="D">', URL)).toMatchObject({ title: "T", description: "D" });
    expect(parseLinkCard('<title> Plain page </title><meta name="description" content="About it">', URL)).toEqual({ url: URL, title: "Plain page", description: "About it" });
    expect(parseLinkCard("<p>No head at all</p>", URL)).toEqual({ url: URL, title: "event.example", description: "" });
  });

  it("drops an image that is not http(s)", () => {
    expect(parseLinkCard('<meta property="og:title" content="T"><meta property="og:image" content="javascript:alert(1)">', URL).image).toBeUndefined();
  });

  it("clips very long titles and descriptions", () => {
    const card = parseLinkCard(`<meta property="og:title" content="${"t".repeat(500)}"><meta property="og:description" content="${"d".repeat(2000)}">`, URL);
    expect(card.title.length).toBe(300);
    expect(card.description.length).toBe(1000);
  });
});

describe("LinkCardFetcher", () => {
  it("fetches once and serves the cache for an hour", async () => {
    const { now, cards } = fetcher();
    queue(html(200, FULL));
    expect(await cards.get(URL)).toMatchObject({ title: "Event X, Berlin" });
    expect(await cards.get(URL)).toMatchObject({ title: "Event X, Berlin" });
    expect(requestUrlMock.calls).toHaveLength(1);
    expect(call(0)).toMatchObject({ url: URL, method: "GET", throw: false });
    expect(cards.peek(URL)).toMatchObject({ title: "Event X, Berlin" });
    now.t = CARD_TTL_MS + 1;
    expect(cards.peek(URL)).toBeUndefined();
  });

  it("gives a host-only card for a page that is not HTML", async () => {
    queue(bytes(200, new Uint8Array([37, 80, 68, 70]), "application/pdf"));
    expect(await fetcher().cards.get("https://event.example/flyer.pdf")).toEqual({ url: "https://event.example/flyer.pdf", title: "event.example", description: "" });
  });

  it("returns null for an error page or no answer, and retries after five minutes", async () => {
    const { now, cards } = fetcher();
    queue(json(404, {}));
    expect(await cards.get(URL)).toBeNull();
    expect(await cards.get(URL)).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(1);
    now.t = CARD_FAILURE_TTL_MS + 1;
    queue(hang);
    expect(await cards.get(URL)).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it("shares one request between callers and never fetches a non-http link", async () => {
    const { cards } = fetcher();
    queue(html(200, FULL));
    const [a, b] = await Promise.all([cards.get(URL), cards.get(URL)]);
    expect(a).toEqual(b);
    expect(await cards.get("javascript:alert(1)")).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(1);
  });
});
```

Append to `test/previews/pvLinkCard.test.ts` (import `osmmContext` from `../../src/ui/context` and `makeCtx` from `../ui/ctx`):
```ts
  it("shows the fetched title, description and image when the plugin has a card (#93)", async () => {
    const { ctx } = await makeCtx();
    const card = { url: "https://example.com/page", title: "Event X, Berlin", description: "Monthly makers evening", image: "https://example.com/cover.png" };
    ctx.linkCards = { peek: () => undefined, get: async () => card };
    const { container } = render(PvLinkCard, { props: { card: { url: card.url, domain: "example.com" } }, context: osmmContext(ctx) });
    expect(await screen.findByText("Event X, Berlin")).toBeTruthy();
    expect(screen.getByText("Monthly makers evening")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/cover.png");
  });

  it("keeps the plain card when no card could be fetched", async () => {
    const { ctx } = await makeCtx();
    ctx.linkCards = { peek: () => null, get: async () => null };
    const { container } = render(PvLinkCard, { props: { card: { url: "https://example.com/page", domain: "example.com" } }, context: osmmContext(ctx) });
    await Promise.resolve();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link").textContent).toContain("https://example.com/page");
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/platforms/og.test.ts test/previews/pvLinkCard.test.ts`
Expected: FAIL (`src/platforms/og.ts` missing; `linkCards` not in the context type).

- [ ] **Step 3: Implement the fetcher**

Create `src/platforms/og.ts`:
```ts
import { header, send, type HttpFn } from "./http";

/** A link preview: what Bluesky's external embed and the previews show (#93). */
export interface LinkCard {
  url: string;
  title: string;
  description: string;
  image?: string;
  siteName?: string;
}

export const CARD_TIMEOUT_MS = 8_000;
export const CARD_TTL_MS = 60 * 60_000;
export const CARD_FAILURE_TTL_MS = 5 * 60_000;
export const CARD_CACHE_SIZE = 100;
/** Only the start of a page is read: the head is at the top. */
const MAX_HTML = 512 * 1024;
const SAFE_URL = /^https?:\/\//i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function absolute(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base).toString();
    return SAFE_URL.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** Reads OpenGraph, then Twitter tags, then the title and meta description; the host when a page has none. */
export function parseLinkCard(html: string, url: string): LinkCard {
  const doc = new DOMParser().parseFromString(html.slice(0, MAX_HTML), "text/html");
  const meta = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const title = meta("og:title", "twitter:title") ?? (doc.querySelector("title")?.textContent?.trim() || hostOf(url));
  const description = meta("og:description", "twitter:description", "description") ?? "";
  const raw = meta("og:image", "og:image:url", "twitter:image");
  const image = raw ? absolute(raw, url) : undefined;
  const siteName = meta("og:site_name");
  return { url, title: clip(title, 300), description: clip(description, 1000), ...(image ? { image } : {}), ...(siteName ? { siteName } : {}) };
}

/** Fetches link cards with requestUrl, with a timeout, a cache and one request per link at a time. Never rejects. */
export class LinkCardFetcher {
  private readonly cache = new Map<string, { card: LinkCard | null; until: number }>();
  private readonly pending = new Map<string, Promise<LinkCard | null>>();

  constructor(private readonly deps: { http: HttpFn; now(): number; timeoutMs?: number }) {}

  /** The cached answer: a card, null when the last fetch failed, undefined when there is none (or it expired). */
  peek(url: string): LinkCard | null | undefined {
    const hit = this.cache.get(url);
    if (!hit) return undefined;
    if (hit.until <= this.deps.now()) {
      this.cache.delete(url);
      return undefined;
    }
    return hit.card;
  }

  get(url: string): Promise<LinkCard | null> {
    const cached = this.peek(url);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!SAFE_URL.test(url)) return Promise.resolve(null);
    const running = this.pending.get(url);
    if (running) return running;
    const task = this.fetch(url).then((card) => {
      this.pending.delete(url);
      this.remember(url, card);
      return card;
    });
    this.pending.set(url, task);
    return task;
  }

  private remember(url: string, card: LinkCard | null): void {
    this.cache.delete(url);
    this.cache.set(url, { card, until: this.deps.now() + (card ? CARD_TTL_MS : CARD_FAILURE_TTL_MS) });
    while (this.cache.size > CARD_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetch(url: string): Promise<LinkCard | null> {
    try {
      const res = await send(this.deps.http, { url, method: "GET", headers: { Accept: "text/html,application/xhtml+xml" } }, this.deps.timeoutMs ?? CARD_TIMEOUT_MS);
      if (res.status < 200 || res.status >= 300) return null;
      if (!/html/i.test(header(res.headers, "content-type") ?? "")) return { url, title: hostOf(url), description: "" };
      return parseLinkCard(res.text, url);
    } catch {
      return null;
    }
  }
}
```

In `src/platforms/adapters.ts`, import `type LinkCard` from `./og` and add to `AdapterDeps`:
```ts
  /** The link card for a URL (Bluesky's external embed); null when there is none. */
  linkCard?(url: string): Promise<LinkCard | null>;
```

- [ ] **Step 4: Show fetched cards in the previews**

In `src/ui/context.ts`, import `type LinkCardFetcher` from `../platforms/og` and add to `OsmmContext`:
```ts
  /** Fetched link cards for the previews (#93); absent in contexts that don't fetch (some tests). */
  linkCards?: Pick<LinkCardFetcher, "get" | "peek">;
```

Replace `src/previews/PvLinkCard.svelte`:
```svelte
<script lang="ts">
  import { getContext } from "svelte";
  import type { LinkCard } from "../platforms/og";
  import { OSMM_KEY, type OsmmContext } from "../ui/context";

  /** Only http(s) links are ever rendered as clickable; javascript:, data:, vbscript:, relative and obsidian: links render as plain text. */
  const SAFE_URL_RE = /^https?:\/\//i;

  let { card }: { card: { url: string; domain: string } } = $props();
  // Previews also render outside the plugin (tests); there is simply no fetched card then.
  const ctx = getContext<OsmmContext | undefined>(OSMM_KEY);
  const safe = $derived(SAFE_URL_RE.test(card.url));
  let fetched = $state<LinkCard | null>(null);

  $effect(() => {
    const url = card.url;
    const cards = ctx?.linkCards;
    fetched = cards?.peek(url) ?? null;
    if (!cards || !SAFE_URL_RE.test(url)) return;
    let live = true;
    void cards.get(url).then((c) => {
      if (live) fetched = c;
    });
    return () => {
      live = false;
    };
  });

  const image = $derived(fetched?.image && SAFE_URL_RE.test(fetched.image) ? fetched.image : null);
</script>

{#if safe}
  <a class="osmm-pv-card" href={card.url} target="_blank" rel="noopener">
    {#if image}<img class="osmm-pv-card-image" src={image} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
    <span class="osmm-pv-card-domain">{card.domain}</span>
    {#if fetched?.title}<span class="osmm-pv-card-title">{fetched.title}</span>{/if}
    {#if fetched?.description}<span class="osmm-pv-card-desc">{fetched.description}</span>{/if}
    <span class="osmm-pv-card-url">{card.url}</span>
  </a>
{:else}
  <div class="osmm-pv-card">
    <span class="osmm-pv-card-domain">{card.domain}</span>
    <span class="osmm-pv-card-url">{card.url}</span>
  </div>
{/if}
```

Append to `src/styles/previews.css`:
```css
.osmm-pv-card-image { width: 100%; max-height: 180px; object-fit: cover; border-radius: var(--radius-s); }
.osmm-pv-card-title { font-weight: var(--font-semibold); color: var(--text-normal); }
.osmm-pv-card-desc {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

In `src/main.ts`: add the field `linkCards!: LinkCardFetcher;` and, before the adapter registration loop, `this.linkCards = new LinkCardFetcher({ http: obsidianHttp, now: () => Date.now() });`. In `adapterDeps()` add `linkCard: (url) => this.linkCards.get(url),`. In `uiContext()`, add `linkCards: this.linkCards,` to the context object.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms/og.test.ts test/previews test/main.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/og.ts src/platforms/adapters.ts src/ui/context.ts src/previews/PvLinkCard.svelte src/styles/previews.css src/main.ts test/platforms/og.test.ts test/previews/pvLinkCard.test.ts
git commit -m "feat(previews): OpenGraph link cards with timeout, cache and fallbacks, shown in the previews (#93)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Telegram adapter (#88)

**Files:**
- Create: `src/platforms/telegram/html.ts`, `src/platforms/telegram/api.ts`, `test/platforms/telegram/fixtures.ts`, `test/platforms/telegram/contract.ts`, `test/platforms/telegram/html.test.ts`, `test/platforms/telegram/adapter.test.ts`
- Modify: `src/platforms/adapters.ts`, `test/platforms/contract/cases.ts`

**Interfaces:**
- Consumes: `ApiClient`, `parseJson`, `UPLOAD_TIMEOUT_MS`, `HttpResponse`, `ApiFailure` (Task 2); `multipart`, `readMedia`, `fileName`, `withLink` (Task 2); `AdapterDeps` (Task 3); `PublishResult`, `VerifyResult` (Task 1); `ContractCase`, `CONTRACT_NOW` (Task 3).
- Produces:
  - `telegramHtml(text: string): string` (the `telegram` dialect → Bot API HTML, escaped), `visibleLength(html: string): number`.
  - `class TelegramAdapter implements PlatformAdapter { platform: "telegram"; publish; verify; findChats(secret: string | null): Promise<TelegramChat[]> }`; `interface TelegramChat { id: string; title: string; username?: string }`; `telegramFailure(res)`; `messageUrl(chat, id)`; `TELEGRAM_API`, `CAPTION_MAX = 1024`.
  - `telegramCase: ContractCase`; fixtures `TG`, `TG_TOKEN`.

Channel setup: the credential is the bot token (from @BotFather); the handle is the channel's chat id, `@name` for a public channel or `-100…` for a private one. The bot must be an admin of the channel with "Post messages".

- [ ] **Step 1: Write the fixtures (from core.telegram.org/bots/api)**

Create `test/platforms/telegram/fixtures.ts`:
```ts
import { CONTRACT_NOW } from "../contract/harness";

export const TG_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

const chat = { id: -1001234567890, title: "Event X", username: "eventx", type: "channel" };
const privateChat = { id: -1009876543210, title: "Private news", type: "channel" };
const date = Math.floor(CONTRACT_NOW / 1000);
const message = (id: number, extra: Record<string, unknown> = {}) => ({ message_id: id, sender_chat: chat, chat, date, ...extra });

/** Bot API answers: `{ ok, result }` on success, `{ ok: false, error_code, description, parameters? }` on failure. */
export const TG = {
  sendMessage: { ok: true, result: message(42, { text: "Doors open at 18:00" }) },
  sendMessagePrivate: { ok: true, result: { message_id: 7, sender_chat: privateChat, chat: privateChat, date, text: "Doors open" } },
  sendPhoto: { ok: true, result: message(43, { photo: [{ file_id: "AgACAgQAAx0", file_unique_id: "AQAD", width: 1080, height: 1080, file_size: 8 }], caption: "Doors open" }) },
  sendMediaGroup: { ok: true, result: [message(44, { media_group_id: "1370", photo: [] }), message(45, { media_group_id: "1370", photo: [] }), message(46, { media_group_id: "1370", photo: [] })] },
  tooMany: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } },
  unauthorized: { ok: false, error_code: 401, description: "Unauthorized" },
  kicked: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
  tooLong: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
  chatNotFound: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
  badEntities: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0" },
  badGateway: { ok: false, error_code: 502, description: "Bad Gateway" },
  getMe: { ok: true, result: { id: 123456789, is_bot: true, first_name: "OSMM", username: "osmm_bot", can_join_groups: true } },
  getChat: { ok: true, result: { ...chat } },
  admin: { ok: true, result: { status: "administrator", user: { id: 123456789, is_bot: true, first_name: "OSMM" }, can_post_messages: true } },
  member: { ok: true, result: { status: "left", user: { id: 123456789, is_bot: true, first_name: "OSMM" } } },
  getUpdates: {
    ok: true,
    result: [
      { update_id: 1, my_chat_member: { chat, from: { id: 1, is_bot: false, first_name: "You" }, date, old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } } },
      { update_id: 2, channel_post: { message_id: 3, sender_chat: privateChat, chat: privateChat, date, text: "hi" } },
      { update_id: 3, channel_post: { message_id: 4, sender_chat: chat, chat, date, text: "again" } },
    ],
  },
  webhookConflict: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" },
};
```

Create `test/platforms/telegram/contract.ts`:
```ts
import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { TG, TG_TOKEN } from "./fixtures";

export const telegramCase: ContractCase = {
  platform: "telegram",
  job: () => ({
    variant: { path: "Social/Posts/Tg.md", platform: "telegram", channels: ["tg/event-x"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
    channel: channel("tg/event-x", { handle: "@eventx", method: "api", secretId: "osmm-channel-tg-event-x" }),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
    text: "Doors open at 18:00",
    items: ["Doors open at 18:00"],
    media: [],
    secret: TG_TOKEN,
  }),
  before: [],
  success: { post: [json(200, TG.sendMessage)], expect: { remoteId: "42", url: "https://t.me/eventx/42" } },
  rateLimited: { post: [json(429, TG.tooMany)], retryAfterMs: 7000 },
  authExpired: [json(401, TG.unauthorized)],
  forbidden: [json(403, TG.kicked)],
  rejected: [json(400, TG.tooLong)],
  serverError: [json(502, TG.badGateway)],
  sensitive: [TG_TOKEN, TG_TOKEN.split(":")[1]!],
};
```
Add it to `test/platforms/contract/cases.ts`: `import { telegramCase } from "../telegram/contract";` and `export const CASES: ContractCase[] = [telegramCase];`.

- [ ] **Step 2: Write the failing tests**

Create `test/platforms/telegram/html.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { telegramHtml, visibleLength } from "../../../src/platforms/telegram/html";

describe("telegramHtml (HTML parse mode)", () => {
  it("escapes <, > and & so the text shows as written (review focus 2)", () => {
    expect(telegramHtml("5 < 6 & 7 > 3 <b>not bold</b>")).toBe("5 &lt; 6 &amp; 7 &gt; 3 &lt;b&gt;not bold&lt;/b&gt;");
  });

  it("turns the dialect's markers into tags", () => {
    expect(telegramHtml("**Doors** open *now*, ~~late~~ `a<b` and __bold__ _it_")).toBe("<b>Doors</b> open <i>now</i>, <s>late</s> <code>a&lt;b</code> and <b>bold</b> <i>it</i>");
  });

  it("makes links from Markdown links, keeping & in the address valid", () => {
    expect(telegramHtml("[Tickets](https://event.example/t?a=1&b=2)")).toBe('<a href="https://event.example/t?a=1&amp;b=2">Tickets</a>');
  });

  it("leaves underscores and asterisks inside words and URLs alone", () => {
    expect(telegramHtml("snake_case_name and https://x.example/a_b_c and 2*3*4")).toBe("snake_case_name and https://x.example/a_b_c and 2*3*4");
  });

  it("keeps code blocks as preformatted text", () => {
    expect(telegramHtml("Run:\n```sh\nnpm i <pkg>\n```\nDone")).toBe('Run:\n<pre><code class="language-sh">npm i &lt;pkg&gt;</code></pre>\nDone');
  });

  it("measures what the reader sees", () => {
    expect(visibleLength(telegramHtml("**Hi** & <you>"))).toBe("Hi & <you>".length);
  });
});
```

Create `test/platforms/telegram/adapter.test.ts`:
```ts
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { TelegramAdapter } from "../../../src/platforms/telegram/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW } from "../contract/harness";
import { call, formParts, hang, json, queue, sentJson } from "../http";
import { telegramCase } from "./contract";
import { TG, TG_TOKEN } from "./fixtures";
import { makeCtx } from "../../ui/ctx";

const adapter = () => new TelegramAdapter(contractDeps());
const job = (extra: Partial<DeliveryJob> = {}): DeliveryJob => ({ ...telegramCase.job(), ...extra });
const API = `https://api.telegram.org/bot${TG_TOKEN}`;

describe("TelegramAdapter.publish", () => {
  it("sends text as HTML to the channel and links the message", async () => {
    queue(json(200, TG.sendMessage));
    expect(await adapter().publish(job({ text: "**Doors** open & free" }))).toEqual({ remoteId: "42", url: "https://t.me/eventx/42" });
    expect(call(0)).toMatchObject({ url: `${API}/sendMessage`, method: "POST", contentType: "application/json", throw: false });
    expect(sentJson(0)).toEqual({ chat_id: "@eventx", text: "<b>Doors</b> open &amp; free", parse_mode: "HTML" });
  });

  it("links a message in a private channel through t.me/c", async () => {
    queue(json(200, TG.sendMessagePrivate));
    const j = job();
    j.channel = { ...j.channel, handle: "-1009876543210" };
    expect((await adapter().publish(j)).url).toBe("https://t.me/c/9876543210/7");
    expect(sentJson(0).chat_id).toBe("-1009876543210");
  });

  it("adds the post's url on its own line when the text doesn't have it", async () => {
    queue(json(200, TG.sendMessage));
    const j = job();
    j.variant = { ...j.variant, url: "https://event.example/x" };
    await adapter().publish(j);
    expect(sentJson(0).text).toBe("Doors open at 18:00\n\nhttps://event.example/x");
  });

  it("sends one photo with the text as its caption", async () => {
    queue(json(200, TG.sendPhoto));
    expect(await adapter().publish(job({ text: "Doors open", media: [img("cover.png")] }))).toEqual({ remoteId: "43", url: "https://t.me/eventx/43" });
    expect(call(0).url).toBe(`${API}/sendPhoto`);
    expect(formParts(0)).toEqual({
      chat_id: { value: "@eventx", size: 7 },
      caption: { value: "Doors open", size: 10 },
      parse_mode: { value: "HTML", size: 4 },
      photo: { filename: "cover.png", type: "image/png", size: 8 },
    });
  });

  it("splits a long caption: the photo first, then the text as a message (#88)", async () => {
    queue(json(200, TG.sendPhoto), json(200, TG.sendMessage));
    const long = "x".repeat(1500);
    expect(await adapter().publish(job({ text: long, media: [img("cover.png")] }))).toEqual({ remoteId: "42", url: "https://t.me/eventx/42" });
    expect(formParts(0).caption).toBeUndefined();
    expect(sentJson(1)).toEqual({ chat_id: "@eventx", text: long, parse_mode: "HTML" });
  });

  it("keeps the photo as the post when the text after it fails, and says so", async () => {
    queue(json(200, TG.sendPhoto), json(400, TG.tooLong));
    const res = await adapter().publish(job({ text: "x".repeat(1500), media: [img("cover.png")] }));
    expect(res).toMatchObject({ remoteId: "43", url: "https://t.me/eventx/43" });
    expect(res.note).toBe("The photo was posted, but the text after it was not: Telegram: Bad Request: message is too long (HTTP 400)");
  });

  it("sends an album with the caption on the first photo", async () => {
    queue(json(200, TG.sendMediaGroup));
    expect(await adapter().publish(job({ text: "Three photos", media: [img("a.png"), img("b.png"), img("c.png")] }))).toEqual({ remoteId: "44", url: "https://t.me/eventx/44" });
    const parts = formParts(0);
    expect(call(0).url).toBe(`${API}/sendMediaGroup`);
    expect(JSON.parse(parts.media!.value!)).toEqual([
      { type: "photo", media: "attach://photo0", caption: "Three photos", parse_mode: "HTML" },
      { type: "photo", media: "attach://photo1" },
      { type: "photo", media: "attach://photo2" },
    ]);
    expect(Object.keys(parts).sort()).toEqual(["chat_id", "media", "photo0", "photo1", "photo2"]);
  });

  it("refuses without a token or a chat id, before any request", async () => {
    await expect(adapter().publish(job({ secret: null }))).rejects.toThrow("Add this channel's bot token on this device (Settings → Social Planner → Channels).");
    const j = job();
    j.channel = { ...j.channel, handle: "Event X" };
    await expect(adapter().publish(j)).rejects.toThrow("Set the handle of tg/event-x to the channel's chat id: @name for a public channel, -100… for a private one.");
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("treats a missing chat or missing admin rights as needs-user, and bad markup as invalid content", async () => {
    queue(json(400, TG.chatNotFound), json(400, TG.badEntities));
    await expect(adapter().publish(job())).rejects.toMatchObject({ kind: "needs_user", message: "Telegram: Bad Request: chat not found (HTTP 400)" });
    await expect(adapter().publish(job())).rejects.toMatchObject({ kind: "invalid_content" });
  });
});

describe("TelegramAdapter.verify and findChats", () => {
  it("checks the token, the chat and the bot's admin rights", async () => {
    queue(json(200, TG.getMe), json(200, TG.getChat), json(200, TG.admin));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: true, account: "Event X, posting as @osmm_bot" });
    expect(sentJson(2)).toEqual({ chat_id: "@eventx", user_id: 123456789 });
    queue(json(200, TG.getMe), json(200, TG.getChat), json(200, TG.member));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: false, error: "The bot is not an admin of Event X. Add it as an administrator with permission to post messages." });
    queue(json(401, TG.unauthorized));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: false, error: "Telegram: Unauthorized (HTTP 401)" });
  });

  it("lists the channels the bot has seen, newest first, without duplicates", async () => {
    queue(json(200, TG.getUpdates));
    expect(await adapter().findChats(TG_TOKEN)).toEqual([
      { id: "-1001234567890", title: "Event X", username: "eventx" },
      { id: "-1009876543210", title: "Private news" },
    ]);
    expect(sentJson(0)).toEqual({ allowed_updates: ["channel_post", "my_chat_member"], limit: 100 });
  });

  it("explains a webhook conflict", async () => {
    queue(json(409, TG.webhookConflict));
    await expect(adapter().findChats(TG_TOKEN)).rejects.toThrow("This bot has a webhook, so Telegram won't list its chats here. Enter the chat id by hand (@name or -100…).");
  });
});

describe("an interrupted Telegram post (review focus 1)", () => {
  it("an unanswered sendMessage parks the delivery on check_needed and never sends twice", async () => {
    const P = "Social/Posts/Tg.md";
    const c = await makeCtx({
      seed: true,
      now: CONTRACT_NOW,
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "tg/event-x": { status: "scheduled" } } }, body: "Doors open at 18:00" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, handle: "@eventx", secretId: "osmm-channel-tg-event-x" });
    c.app.secretStorage.setSecret("osmm-channel-tg-event-x", TG_TOKEN);
    c.adapters.register(new TelegramAdapter(contractDeps()));
    queue(hang);
    expect(await c.ctx.publish.orchestrator.run(P, "tg/event-x")).toEqual({ status: "check_needed" });
    expect(requestUrlMock.calls).toHaveLength(1);
    const fm = parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, { status: string }> };
    expect(fm.deliveries["tg/event-x"]!.status).toBe("check_needed");
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/platforms/telegram test/platforms/contract`
Expected: FAIL (modules missing; the registry test fails because `CASES` has Telegram and `createAdapters()` doesn't).

- [ ] **Step 4: Implement the HTML conversion**

Create `src/platforms/telegram/html.ts`:
```ts
const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Bold, strike and italic on already-escaped text; markers inside words (snake_case, 2*3) stay as they are. */
function spans(t: string): string {
  return t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "<b>$2</b>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/gm, "$1<i>$2</i>")
    .replace(/(^|[^_\w/])_(?=\S)([^_\n]*?\S)_(?![_\w])/gm, "$1<i>$2</i>");
}

function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${escape(part.slice(1, -1))}</code>` : spans(escape(part))))
    .join("");
}

/**
 * The `telegram` dialect (renderText) → Bot API HTML (parse_mode "HTML"). Everything the user wrote is escaped
 * first, so `<`, `>` and `&` show as written; only the dialect's own markers become tags.
 */
export function telegramHtml(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part);
      if (!fence) return inline(part);
      const lang = (fence[1] ?? "").trim();
      const code = escape((fence[2] ?? "").replace(/\n$/, ""));
      return lang ? `<pre><code class="language-${escape(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`;
    })
    .join("");
}

/** The length the reader sees (tags dropped, entities as one character): what Telegram's 1024-character caption limit counts. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:lt|gt|amp|quot);/g, "_").length;
}
```

- [ ] **Step 5: Implement the adapter**

Create `src/platforms/telegram/api.ts`:
```ts
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { classifyError, NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpResponse } from "../http";
import { multipart, type Part } from "../multipart";
import { withLink } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, VerifyResult } from "../types";
import { telegramHtml, visibleLength } from "./html";

export const TELEGRAM_API = "https://api.telegram.org";
export const CAPTION_MAX = 1024;
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{5,})$/;
const NEEDS_USER_400 = /chat not found|not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|bot was kicked|have no rights/i;

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
}
interface TgReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface TelegramChat {
  id: string;
  title: string;
  username?: string;
}

export function telegramFailure(res: HttpResponse): ApiFailure {
  const body = parseJson(res.text) as TgReply<unknown> | null;
  const message = typeof body?.description === "string" ? body.description : `HTTP ${res.status}`;
  const migrated = body?.parameters?.migrate_to_chat_id;
  if (migrated) return { message: `${message}. The chat moved to ${migrated}; put that id in the channel's handle.`, kind: "needs_user" };
  const retry = body?.parameters?.retry_after;
  if (typeof retry === "number") return { message, retryAfterMs: retry * 1000 };
  if (res.status === 400 && NEEDS_USER_400.test(message)) return { message, kind: "needs_user" };
  return { message };
}

/** https://t.me/<username>/<id> for public channels, https://t.me/c/<internal id>/<id> for private ones. */
export function messageUrl(chat: TgChat, id: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${id}`;
  return `https://t.me/c/${String(chat.id).replace(/^-100/, "")}/${id}`;
}

/** Channels through a bot that is an admin of the channel (#88). No lookup: the Bot API can't read a channel's history. */
export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram" as const;
  private readonly api: ApiClient;

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "telegram", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: telegramFailure });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const token = this.token(job.secret);
    const chatId = this.chatId(job.channel);
    const html = telegramHtml(withLink(job.text, job.variant.url));
    const images = job.media.filter((m) => m.kind === "image");
    if (!images.length) return this.result(await this.message(token, chatId, html));
    const fits = visibleLength(html) <= CAPTION_MAX;
    const caption = fits ? html : "";
    const first = images.length === 1 ? await this.photo(token, chatId, images[0]!, caption) : await this.album(token, chatId, images, caption);
    if (fits || !html) return this.result(first);
    // #88: a caption over 1024 characters is sent as a message right after the photos.
    try {
      return this.result(await this.message(token, chatId, html));
    } catch (e) {
      const err = classifyError(e);
      const what = images.length === 1 ? "The photo was" : "The photos were";
      return { ...this.result(first), note: `${what} posted, but the text after it ${err.kind === "unknown" ? "may not have been" : "was not"}: ${err.message}` };
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const token = this.token(secret);
      const chatId = this.chatId(channel);
      const me = await this.read<{ id: number; username?: string }>(token, "getMe", {});
      const chat = await this.read<TgChat>(token, "getChat", { chat_id: chatId });
      const member = await this.read<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: chatId, user_id: me.id });
      const title = chat.title ?? chatId;
      const admin = member.status === "creator" || (member.status === "administrator" && member.can_post_messages !== false);
      if (!admin) return { ok: false, error: `The bot is not an admin of ${title}. Add it as an administrator with permission to post messages.` };
      return { ok: true, account: `${title}, posting as @${me.username ?? "bot"}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Channel settings, "Find chat id": the channels the bot saw recently (added as admin, or a post in the channel). */
  async findChats(secret: string | null): Promise<TelegramChat[]> {
    const token = this.token(secret);
    const res = await this.api.read({ url: `${TELEGRAM_API}/bot${token}/getUpdates`, method: "POST", contentType: "application/json", body: JSON.stringify({ allowed_updates: ["channel_post", "my_chat_member"], limit: 100 }) });
    if (res.status === 409) throw new Error("This bot has a webhook, so Telegram won't list its chats here. Enter the chat id by hand (@name or -100…).");
    if (!isOk(res)) throw this.api.error(res);
    const updates = (parseJson(res.text) as TgReply<Array<{ channel_post?: { chat: TgChat }; my_chat_member?: { chat: TgChat } }>> | null)?.result ?? [];
    const seen = new Map<string, TelegramChat>();
    for (const u of [...updates].reverse()) {
      const chat = u.my_chat_member?.chat ?? u.channel_post?.chat;
      if (!chat || !["channel", "supergroup", "group"].includes(chat.type)) continue;
      const id = String(chat.id);
      if (!seen.has(id)) seen.set(id, { id, title: chat.title ?? id, ...(chat.username ? { username: chat.username } : {}) });
    }
    return [...seen.values()].sort((a, b) => Number(!a.username) - Number(!b.username));
  }

  private token(secret: string | null): string {
    if (!secret) throw new NeedsUserError("Add this channel's bot token on this device (Settings → Social Planner → Channels).");
    if (!TOKEN_RE.test(secret.trim())) throw new NeedsUserError("The saved Telegram credential doesn't look like a bot token (123456:ABC…). Paste the token from @BotFather.");
    return secret.trim();
  }

  private chatId(channel: Channel): string {
    const handle = (channel.handle ?? "").trim();
    if (!CHAT_ID_RE.test(handle)) throw new NeedsUserError(`Set the handle of ${channel.name} to the channel's chat id: @name for a public channel, -100… for a private one.`);
    return handle;
  }

  private result(msg: TgMessage): PublishResult {
    return { remoteId: String(msg.message_id), url: messageUrl(msg.chat, msg.message_id) };
  }

  private parsed<T>(res: HttpResponse): T {
    const body = parseJson(res.text) as TgReply<T> | null;
    if (!body?.ok || body.result === undefined) throw new UnknownOutcomeError("Telegram: the answer could not be read, so it is not known whether the post went out.");
    return body.result;
  }

  private async message(token: string, chatId: string, html: string): Promise<TgMessage> {
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendMessage`, method: "POST", contentType: "application/json", body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }) });
    return this.parsed<TgMessage>(res);
  }

  private async photo(token: string, chatId: string, m: MediaInfo, caption: string): Promise<TgMessage> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    const parts: Part[] = [{ name: "chat_id", value: chatId }];
    if (caption) parts.push({ name: "caption", value: caption }, { name: "parse_mode", value: "HTML" });
    parts.push({ name: "photo", filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data });
    const form = multipart(parts);
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendPhoto`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    return this.parsed<TgMessage>(res);
  }

  private async album(token: string, chatId: string, images: MediaInfo[], caption: string): Promise<TgMessage> {
    const files = await Promise.all(images.map((m) => readMedia((p) => this.deps.readBinary(p), m)));
    const media = images.map((_m, i) => ({ type: "photo", media: `attach://photo${i}`, ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}) }));
    const form = multipart([
      { name: "chat_id", value: chatId },
      { name: "media", value: JSON.stringify(media) },
      ...images.map((m, i) => ({ name: `photo${i}`, filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data: files[i]! })),
    ]);
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendMediaGroup`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const sent = this.parsed<TgMessage[]>(res);
    if (!sent[0]) throw new UnknownOutcomeError("Telegram: the answer listed no messages, so it is not known whether the post went out.");
    return sent[0];
  }

  private async read<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await this.api.read({ url: `${TELEGRAM_API}/bot${token}/${method}`, method: "POST", contentType: "application/json", body: JSON.stringify(payload) }).catch(() => {
      throw new Error("Couldn't reach Telegram.");
    });
    if (!isOk(res)) throw this.api.error(res);
    const body = parseJson(res.text) as TgReply<T> | null;
    if (!body?.ok || body.result === undefined) throw new Error("Telegram sent an answer that could not be read.");
    return body.result;
  }
}
```
The "refuses without … a chat id" test expects `tg/event-x` in the message because the test's `channel()` fixture sets `name` to the id.

In `src/platforms/adapters.ts`: `import { TelegramAdapter } from "./telegram/api";` and `return [new TelegramAdapter(deps)];`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run test/platforms`
Expected: PASS, including every Telegram contract scenario.

- [ ] **Step 7: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/telegram src/platforms/adapters.ts test/platforms/telegram test/platforms/contract/cases.ts
git commit -m "feat(telegram): bot API adapter with HTML text, photos, albums, long-caption split, chat id discovery (#88)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Discord adapter (#89)

**Files:**
- Create: `src/platforms/discord/api.ts`, `test/platforms/discord/fixtures.ts`, `test/platforms/discord/contract.ts`, `test/platforms/discord/adapter.test.ts`
- Modify: `src/platforms/adapters.ts`, `test/platforms/contract/cases.ts`

**Interfaces:**
- Consumes: as Task 5 (`ApiClient`, `multipart`, `readMedia`, `fileName`, `withLink`, `AdapterDeps`, `ContractCase`).
- Produces: `class DiscordAdapter implements PlatformAdapter { platform: "discord"; publish; verify }`; `parseWebhook(secret): { id: string; token: string; base: string } | null`; `discordFailure(res)`; `discordCase`; fixtures `DC`, `DC_WEBHOOK`.

Channel setup: the credential is the channel's webhook URL (Server settings → Integrations → Webhooks → Copy Webhook URL); it contains the webhook's token, so it is kept in secret storage. Optional `postAsName` and `postAsAvatar` override the webhook's name and avatar.

- [ ] **Step 1: Write the fixtures (from discord.com/developers/docs/resources/webhook)**

Create `test/platforms/discord/fixtures.ts`:
```ts
export const DC_TOKEN = "Xk2d8sP3qLw9vN0tR5yU1aB7cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4yZ6";
export const DC_WEBHOOK = `https://discord.com/api/webhooks/1200000000000000001/${DC_TOKEN}`;

/** GET /webhooks/{id}/{token}: the webhook object (the token variant carries no user). */
const webhook = { type: 1, id: "1200000000000000001", name: "OSMM", avatar: null, channel_id: "1100000000000000002", guild_id: "1000000000000000003", application_id: null, token: DC_TOKEN };

export const DC = {
  webhook,
  /** POST /webhooks/{id}/{token}?wait=true: the created message. */
  message: {
    id: "1300000000000000004",
    type: 0,
    content: "Doors open at 18:00",
    channel_id: "1100000000000000002",
    author: { id: "1200000000000000001", username: "OSMM", bot: true },
    attachments: [],
    embeds: [],
    timestamp: "2026-10-08T08:00:00.000000+00:00",
    webhook_id: "1200000000000000001",
  },
  rateLimited: { message: "You are being rate limited.", retry_after: 1.5, global: false },
  unauthorized: { message: "401: Unauthorized", code: 0 },
  unknownWebhook: { message: "Unknown Webhook", code: 10015 },
  missingPermissions: { message: "Missing Permissions", code: 50013 },
  invalidForm: { message: "Invalid Form Body", code: 50035, errors: { content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." }] } } },
  serverError: { message: "500: Internal Server Error", code: 0 },
};
```

Create `test/platforms/discord/contract.ts`:
```ts
import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { DC, DC_TOKEN, DC_WEBHOOK } from "./fixtures";

export const discordCase: ContractCase = {
  platform: "discord",
  job: () => ({
    variant: { path: "Social/Posts/Dc.md", platform: "discord", channels: ["dc/maker-lab"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
    channel: channel("dc/maker-lab", { method: "api", secretId: "osmm-channel-dc-maker-lab" }),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
    text: "Doors open at 18:00",
    items: ["Doors open at 18:00"],
    media: [],
    secret: DC_WEBHOOK,
  }),
  before: [json(200, DC.webhook)],
  success: { post: [json(200, DC.message)], expect: { remoteId: "1300000000000000004", url: "https://discord.com/channels/1000000000000000003/1100000000000000002/1300000000000000004" } },
  rateLimited: { post: [json(429, DC.rateLimited, { "Retry-After": "2" })], retryAfterMs: 1500 },
  authExpired: [json(401, DC.unauthorized)],
  forbidden: [json(403, DC.missingPermissions)],
  rejected: [json(400, DC.invalidForm)],
  serverError: [json(500, DC.serverError)],
  sensitive: [DC_WEBHOOK, DC_TOKEN],
};
```
Add `discordCase` to `CASES`.

- [ ] **Step 2: Write the failing tests**

Create `test/platforms/discord/adapter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { DiscordAdapter, parseWebhook } from "../../../src/platforms/discord/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps } from "../contract/harness";
import { call, formParts, json, queue, sentJson } from "../http";
import { discordCase } from "./contract";
import { DC, DC_TOKEN, DC_WEBHOOK } from "./fixtures";

const job = (extra: Partial<DeliveryJob> = {}): DeliveryJob => ({ ...discordCase.job(), ...extra });
const BASE = `https://discord.com/api/v10/webhooks/1200000000000000001/${DC_TOKEN}`;

describe("parseWebhook", () => {
  it("accepts discord.com, discordapp.com, canary and ptb webhook URLs, and nothing else", () => {
    expect(parseWebhook(DC_WEBHOOK)).toEqual({ id: "1200000000000000001", token: DC_TOKEN, base: BASE });
    expect(parseWebhook(`https://canary.discordapp.com/api/v9/webhooks/1/${DC_TOKEN}/`)?.id).toBe("1");
    expect(parseWebhook("https://evil.example/api/webhooks/1/abc")).toBeNull();
    expect(parseWebhook(null)).toBeNull();
  });
});

describe("DiscordAdapter.publish", () => {
  it("posts JSON with ?wait=true, no mention pings, and the post-as overrides", async () => {
    queue(json(200, DC.webhook), json(200, DC.message));
    const j = job();
    j.channel = { ...j.channel, postAsName: "Event X", postAsAvatar: "https://event.example/logo.png" };
    j.variant = { ...j.variant, url: "https://event.example/x" };
    expect(await new DiscordAdapter(contractDeps()).publish(j)).toEqual(discordCase.success.expect);
    expect(call(0)).toMatchObject({ url: BASE, method: "GET" });
    expect(call(1)).toMatchObject({ url: `${BASE}?wait=true`, method: "POST", contentType: "application/json" });
    expect(sentJson(1)).toEqual({
      content: "Doors open at 18:00\n\nhttps://event.example/x",
      allowed_mentions: { parse: [] },
      username: "Event X",
      avatar_url: "https://event.example/logo.png",
    });
  });

  it("uploads images as attachments with their alt text", async () => {
    queue(json(200, DC.webhook), json(200, DC.message));
    await new DiscordAdapter(contractDeps()).publish(job({ media: [img("cover.png", 1080, 1080, { alt: "Crowd at the door" }), img("map.png", 1080, 1080, { alt: undefined })] }));
    const parts = formParts(1);
    expect(JSON.parse(parts.payload_json!.value!)).toEqual({
      content: "Doors open at 18:00",
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: "cover.png", description: "Crowd at the door" },
        { id: 1, filename: "map.png" },
      ],
    });
    expect(parts["files[0]"]).toEqual({ filename: "cover.png", type: "image/png", size: 8 });
    expect(parts["files[1]"]).toMatchObject({ filename: "map.png" });
  });

  it("asks for the webhook's server once per session", async () => {
    const adapter = new DiscordAdapter(contractDeps());
    queue(json(200, DC.webhook), json(200, DC.message), json(200, DC.message));
    await adapter.publish(job());
    await adapter.publish(job());
    expect(requestUrlMock.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
  });

  it("refuses a missing or wrong credential before any request", async () => {
    await expect(new DiscordAdapter(contractDeps()).publish(job({ secret: null }))).rejects.toThrow(
      "Paste the webhook URL of dc/maker-lab as its credential on this device (Discord: Server settings → Integrations → Webhooks).",
    );
    await expect(new DiscordAdapter(contractDeps()).publish(job({ secret: "not a url" }))).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("says what to do when the webhook was deleted", async () => {
    queue(json(404, DC.unknownWebhook));
    await expect(new DiscordAdapter(contractDeps()).publish(job())).rejects.toMatchObject({
      kind: "needs_user",
      message: "Discord: Unknown Webhook. The webhook was deleted; create a new one and save its URL as this channel's credential. (HTTP 404)",
    });
  });
});

describe("DiscordAdapter.verify", () => {
  it("names the webhook, or explains why it can't be used", async () => {
    queue(json(200, DC.webhook), json(404, DC.unknownWebhook));
    const adapter = new DiscordAdapter(contractDeps());
    expect(await adapter.verify(job().channel, DC_WEBHOOK)).toEqual({ ok: true, account: 'webhook "OSMM"' });
    expect(await new DiscordAdapter(contractDeps()).verify(job().channel, DC_WEBHOOK)).toMatchObject({ ok: false });
    expect(await adapter.verify(job().channel, null)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/platforms/discord test/platforms/contract`
Expected: FAIL (module missing; registry test lists Discord in `CASES` only).

- [ ] **Step 4: Implement the adapter**

Create `src/platforms/discord/api.ts`:
```ts
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpResponse } from "../http";
import { multipart } from "../multipart";
import { withLink } from "../text";
import type { DeliveryJob, PlatformAdapter, PublishResult, VerifyResult } from "../types";

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/;

interface DcWebhook {
  id: string;
  name?: string | null;
  channel_id: string;
  guild_id?: string | null;
}
interface DcMessage {
  id: string;
  channel_id?: string;
}

export function parseWebhook(secret: string | null): { id: string; token: string; base: string } | null {
  const m = WEBHOOK_RE.exec((secret ?? "").trim());
  if (!m) return null;
  const id = m[1]!;
  const token = m[2]!;
  return { id, token, base: `https://discord.com/api/v10/webhooks/${id}/${token}` };
}

export function discordFailure(res: HttpResponse): ApiFailure {
  const body = parseJson(res.text) as { message?: string; retry_after?: number } | null;
  const message = typeof body?.message === "string" ? body.message : `HTTP ${res.status}`;
  if (res.status === 429 && typeof body?.retry_after === "number") return { message, retryAfterMs: Math.ceil(body.retry_after * 1000) };
  if (res.status === 404) return { message: `${message}. The webhook was deleted; create a new one and save its URL as this channel's credential.`, kind: "needs_user" };
  return { message };
}

/** Server channels through a webhook (#89). No lookup: a webhook message can only be fetched by the id the lost answer carried. */
export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord" as const;
  private readonly api: ApiClient;
  /** Webhook id → its server and channel, to build the message link. */
  private readonly hooks = new Map<string, DcWebhook>();

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "discord", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: discordFailure });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const hook = this.webhook(job.channel, job.secret);
    const info = await this.info(hook);
    const payload: Record<string, unknown> = { content: withLink(job.text, job.variant.url), allowed_mentions: { parse: [] } };
    if (job.channel.postAsName) payload.username = job.channel.postAsName;
    if (job.channel.postAsAvatar) payload.avatar_url = job.channel.postAsAvatar;
    const images = job.media.filter((m) => m.kind === "image");
    let res: HttpResponse;
    if (!images.length) {
      res = await this.api.commit({ url: `${hook.base}?wait=true`, method: "POST", contentType: "application/json", body: JSON.stringify(payload) });
    } else {
      const files = await Promise.all(images.map((m) => readMedia((p) => this.deps.readBinary(p), m)));
      payload.attachments = images.map((m, i) => ({ id: i, filename: fileName(m), ...(m.alt ? { description: m.alt.slice(0, 1024) } : {}) }));
      const form = multipart([
        { name: "payload_json", value: JSON.stringify(payload) },
        ...images.map((m, i) => ({ name: `files[${i}]`, filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data: files[i]! })),
      ]);
      res = await this.api.commit({ url: `${hook.base}?wait=true`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    }
    const msg = parseJson(res.text) as DcMessage | null;
    if (!msg?.id) throw new UnknownOutcomeError("Discord: the answer had no message id, so it is not known whether the post went out.");
    const channel = msg.channel_id ?? info.channel_id;
    return { remoteId: msg.id, url: `https://discord.com/channels/${info.guild_id ?? "@me"}/${channel}/${msg.id}` };
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const hook = this.webhook(channel, secret);
      const res = await this.api.read({ url: hook.base, method: "GET" }).catch(() => {
        throw new Error("Couldn't reach Discord.");
      });
      if (!isOk(res)) throw this.api.error(res);
      const info = parseJson(res.text) as DcWebhook | null;
      if (info) this.hooks.set(hook.id, info);
      return { ok: true, account: `webhook "${info?.name ?? hook.id}"` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private webhook(channel: Channel, secret: string | null): { id: string; token: string; base: string } {
    if (!secret) throw new NeedsUserError(`Paste the webhook URL of ${channel.name} as its credential on this device (Discord: Server settings → Integrations → Webhooks).`);
    const hook = parseWebhook(secret);
    if (!hook) throw new NeedsUserError(`The credential of ${channel.name} is not a Discord webhook URL (https://discord.com/api/webhooks/…).`);
    return hook;
  }

  private async info(hook: { id: string; base: string }): Promise<DcWebhook> {
    const cached = this.hooks.get(hook.id);
    if (cached) return cached;
    const res = await this.api.prepare({ url: hook.base, method: "GET" });
    const info = parseJson(res.text) as DcWebhook | null;
    if (!info?.channel_id) throw new NeedsUserError("Discord: the webhook's channel could not be read. Check the webhook URL.");
    this.hooks.set(hook.id, info);
    return info;
  }
}
```

In `src/platforms/adapters.ts`: `import { DiscordAdapter } from "./discord/api";` and return `[new TelegramAdapter(deps), new DiscordAdapter(deps)]`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms`
Expected: PASS, including every Discord contract scenario.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/discord src/platforms/adapters.ts test/platforms/discord test/platforms/contract/cases.ts
git commit -m "feat(discord): webhook adapter with ?wait=true message links, image attachments with alt text, post-as overrides (#89)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Bluesky rich text facets and record keys (#91, part 1)

**Files:**
- Create: `src/platforms/bluesky/richtext.ts`, `src/platforms/bluesky/tid.ts`, `test/platforms/bluesky/richtext.test.ts`, `test/platforms/bluesky/tid.test.ts`

**Interfaces:**
- Consumes: `cyrb53` (`src/util/hash.ts`).
- Produces:
  - `utf8Length(s): number`; `type Feature` (link / mention / tag); `interface Facet { index: { byteStart; byteEnd }; features: Feature[] }`; `findLinks(text)`, `findMentions(text)`, `findTags(text)` (UTF-16 spans); `buildFacets(text, resolve: (handle) => Promise<string | null>): Promise<Facet[]>`.
  - `tid(micros: number, clockId: number): string`, `tidMicros(tid): number`, `postRkey(claimAt: number, index: number, channelId: string): string`, `TID_RE`.

The AT Protocol indexes facets by UTF-8 byte offsets of the post text (`byteStart` inclusive, `byteEnd` exclusive). A mention facet covers the `@handle` and carries the resolved DID; a tag facet covers `#tag` and carries the tag without `#`. A record key for a post is a TID: 13 base32-sortable characters encoding 53 bits of microseconds and a 10-bit clock id.

- [ ] **Step 1: Write the failing tests**

Create `test/platforms/bluesky/richtext.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildFacets, findLinks, findMentions, findTags, utf8Length } from "../../../src/platforms/bluesky/richtext";

const resolve = async (handle: string) => (handle === "alice.bsky.social" ? "did:plc:alice" : null);

describe("Bluesky facets (byte offsets, review focus 2)", () => {
  it("counts emoji with a skin tone as eight bytes", async () => {
    const text = "Hi 👋🏽 @alice.bsky.social see https://example.com #osmm";
    expect(utf8Length("👋🏽")).toBe(8);
    expect(await buildFacets(text, resolve)).toEqual([
      { index: { byteStart: 12, byteEnd: 30 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }] },
      { index: { byteStart: 35, byteEnd: 54 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
      { index: { byteStart: 55, byteEnd: 60 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "osmm" }] },
    ]);
  });

  it("counts accented letters and CJK by their UTF-8 length", async () => {
    expect(await buildFacets("Café #über", resolve)).toEqual([{ index: { byteStart: 6, byteEnd: 12 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "über" }] }]);
    expect(await buildFacets("東京 https://example.jp", resolve)).toEqual([{ index: { byteStart: 7, byteEnd: 25 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.jp" }] }]);
  });

  it("leaves out a mention whose handle doesn't resolve", async () => {
    expect(await buildFacets("Thanks @nobody.example.com!", resolve)).toEqual([]);
  });

  it("trims punctuation after a link, and ignores mentions and tags inside links", () => {
    expect(findLinks("See https://example.com/a. Or (https://example.com/b)!")).toEqual([
      { start: 4, end: 25, uri: "https://example.com/a" },
      { start: 31, end: 52, uri: "https://example.com/b" },
    ]);
    expect(findMentions("https://example.com/@alice.bsky.social and mail me@alice.example.com")).toEqual([]);
    expect(findTags("https://example.com/#top #1 #2026 #v2")).toEqual([{ start: 34, end: 37, tag: "v2" }]);
  });

  it("finds a mention at the start and after a parenthesis", () => {
    expect(findMentions("@alice.bsky.social (@bob.test)").map((m) => m.handle)).toEqual(["alice.bsky.social", "bob.test"]);
  });
});
```

Create `test/platforms/bluesky/tid.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { postRkey, tid, tidMicros, TID_RE } from "../../../src/platforms/bluesky/tid";

describe("TID record keys", () => {
  it("has the TID shape and round-trips the time", () => {
    const micros = Date.UTC(2026, 9, 8, 8) * 1000 + 3;
    const key = tid(micros, 517);
    expect(key).toMatch(TID_RE);
    expect(tidMicros(key)).toBe(micros);
    expect(tid(0, 0)).toBe("2222222222222");
  });

  it("sorts by time as a string", () => {
    expect(tid(1_000, 1) < tid(2_000, 0)).toBe(true);
  });

  it("gives each thread part its own key, stable for a claim and a channel", () => {
    const at = Date.UTC(2026, 9, 8, 8);
    expect(postRkey(at, 0, "bs/you")).toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 1, "bs/you")).not.toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 0, "bs/other")).not.toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 0, "bs/you")).toMatch(TID_RE);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/platforms/bluesky`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the facets**

Create `src/platforms/bluesky/richtext.ts`:
```ts
const encoder = new TextEncoder();

export const utf8Length = (s: string): number => encoder.encode(s).length;

export type Feature =
  | { $type: "app.bsky.richtext.facet#link"; uri: string }
  | { $type: "app.bsky.richtext.facet#mention"; did: string }
  | { $type: "app.bsky.richtext.facet#tag"; tag: string };

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Feature[];
}

interface Span {
  /** UTF-16 index, inclusive. */
  start: number;
  /** UTF-16 index, exclusive. */
  end: number;
}

const LINK_RE = /https?:\/\/[^\s<>"'`]+/g;
const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)/g;
/** A tag starts after a space (or the start), and has at least one letter or underscore (so #1 or #2026 are not tags). */
const TAG_RE = /(^|\s)#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/gu;

export function findLinks(text: string): Array<Span & { uri: string }> {
  return [...text.matchAll(LINK_RE)].map((m) => {
    const uri = m[0].replace(/[.,;:!?)\]]+$/, "");
    const start = m.index ?? 0;
    return { start, end: start + uri.length, uri };
  });
}

const inside = (spans: readonly Span[], i: number): boolean => spans.some((s) => i >= s.start && i < s.end);

export function findMentions(text: string): Array<Span & { handle: string }> {
  const links = findLinks(text);
  return [...text.matchAll(MENTION_RE)]
    .map((m) => {
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      const handle = m[2] ?? "";
      return { start, end: start + 1 + handle.length, handle };
    })
    .filter((m) => /\.[a-zA-Z]{2,}$/.test(m.handle) && !inside(links, m.start));
}

export function findTags(text: string): Array<Span & { tag: string }> {
  const links = findLinks(text);
  return [...text.matchAll(TAG_RE)]
    .map((m) => {
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      const tag = m[2] ?? "";
      return { start, end: start + 1 + tag.length, tag };
    })
    .filter((t) => [...t.tag].length <= 64 && !inside(links, t.start));
}

/** Links, mentions (only those whose handle resolves to a DID) and tags, indexed by UTF-8 byte offsets. */
export async function buildFacets(text: string, resolve: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const bytes = (i: number) => utf8Length(text.slice(0, i));
  const index = (s: Span) => ({ byteStart: bytes(s.start), byteEnd: bytes(s.end) });
  const facets: Facet[] = findLinks(text).map((l) => ({ index: index(l), features: [{ $type: "app.bsky.richtext.facet#link", uri: l.uri }] }));
  for (const m of findMentions(text)) {
    const did = await resolve(m.handle.toLowerCase()).catch(() => null);
    if (did) facets.push({ index: index(m), features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
  }
  for (const t of findTags(text)) facets.push({ index: index(t), features: [{ $type: "app.bsky.richtext.facet#tag", tag: t.tag }] });
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
```

- [ ] **Step 4: Implement the record keys**

Create `src/platforms/bluesky/tid.ts`:
```ts
import { cyrb53 } from "../../util/hash";

const S32 = "234567abcdefghijklmnopqrstuvwxyz";
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** A TID: 0 | 53 bits of microseconds | 10 bits of clock id, as 13 base32-sortable characters. */
export function tid(micros: number, clockId: number): string {
  let v = (BigInt(Math.floor(micros)) << 10n) | BigInt(clockId & 1023);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = S32[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

export function tidMicros(key: string): number {
  let v = 0n;
  for (const ch of key) v = v * 32n + BigInt(S32.indexOf(ch));
  return Number(v >> 10n);
}

/**
 * The record key of thread part `index` of a delivery claimed at `claimAt` (ms): the same for the publish and
 * for the lookup after an interrupted publish (M2b P4), different per part and per channel.
 */
export function postRkey(claimAt: number, index: number, channelId: string): string {
  return tid(claimAt * 1000 + index, cyrb53(channelId) % 1024);
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms/bluesky`
Expected: PASS.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/bluesky/richtext.ts src/platforms/bluesky/tid.ts test/platforms/bluesky/richtext.test.ts test/platforms/bluesky/tid.test.ts
git commit -m "feat(bluesky): link, mention and tag facets with UTF-8 byte offsets; deterministic TID record keys (#91)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Bluesky adapter (#91, part 2)

**Files:**
- Create: `src/platforms/bluesky/api.ts`, `test/platforms/bluesky/fixtures.ts`, `test/platforms/bluesky/contract.ts`, `test/platforms/bluesky/adapter.test.ts`
- Modify: `src/platforms/adapters.ts`, `test/platforms/contract/cases.ts`

**Interfaces:**
- Consumes: `buildFacets`, `postRkey` (Task 7); `ApiClient`, `send`, `header`, `isOk`, `parseJson`, `HTTP_TIMEOUT_MS`, `UPLOAD_TIMEOUT_MS`, `Phase`, `HttpRequest` (Task 2); `readMedia`, `partialNote` (Task 2); `urlsIn` (`src/platforms/text.ts`); `AdapterDeps.linkCard` (Task 4); `cyrb53`.
- Produces: `class BlueskyAdapter implements PlatformAdapter { platform: "bluesky"; publish; lookup; verify }`; `blueskyFailure(now)`; `BSKY_SERVICE = "https://bsky.social"`; `BLOB_MAX = 1_000_000`; `blueskyCase`; fixtures `BS`, `BS_*`, `uriOf`, `RKEY0`.

Channel setup: the handle is the account handle (`you.bsky.social`, with or without `@`), the credential is an **app password**, and `server` is only needed for a self-hosted PDS.

- [ ] **Step 1: Write the fixtures (from docs.bsky.app, com.atproto.server/repo/identity lexicons)**

Create `test/platforms/bluesky/fixtures.ts`:
```ts
import { postRkey } from "../../../src/platforms/bluesky/tid";
import { CONTRACT_NOW } from "../contract/harness";

export const BS_PASSWORD = "abcd-efgh-ijkl-mnop";
export const BS_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const BS_PDS = "https://morel.us-east.host.bsky.network";
export const BS_ACCESS = "eyJhbGciOiJFUzI1NksifQ.YWNjZXNz.c2lnbmF0dXJlLWFjY2Vzcw";
export const BS_REFRESH = "eyJhbGciOiJFUzI1NksifQ.cmVmcmVzaA.c2lnbmF0dXJlLXJlZnJlc2g";
export const RKEY0 = postRkey(CONTRACT_NOW, 0, "bs/you");
export const uriOf = (rkey: string): string => `at://${BS_DID}/app.bsky.feed.post/${rkey}`;

const didDoc = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  id: BS_DID,
  alsoKnownAs: ["at://you.bsky.social"],
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: BS_PDS }],
};

export const BS = {
  /** com.atproto.server.createSession */
  session: { did: BS_DID, didDoc, handle: "you.bsky.social", email: "you@example.com", emailConfirmed: true, accessJwt: BS_ACCESS, refreshJwt: BS_REFRESH, active: true },
  /** com.atproto.server.refreshSession */
  refreshed: { did: BS_DID, didDoc, handle: "you.bsky.social", accessJwt: "eyJhbGciOiJFUzI1NksifQ.bmV3.YWNjZXNzMg", refreshJwt: "eyJhbGciOiJFUzI1NksifQ.bmV3.cmVmcmVzaDI", active: true },
  /** com.atproto.repo.createRecord */
  created: (rkey: string) => ({ uri: uriOf(rkey), cid: "bafyreihzyk4ehbxt6k3fmrk2fyrx3uxcg5nyq4cxqvxhz7tzm6cy4vudcq", commit: { cid: "bafyreicommit", rev: "3l5abc2def" }, validationStatus: "valid" }),
  /** com.atproto.repo.uploadBlob */
  blob: { blob: { $type: "blob", ref: { $link: "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy" }, mimeType: "image/png", size: 8 } },
  /** com.atproto.identity.resolveHandle */
  resolved: { did: "did:plc:alice" },
  unresolved: { error: "InvalidRequest", message: "Unable to resolve handle" },
  /** com.atproto.repo.getRecord */
  record: (rkey: string) => ({ uri: uriOf(rkey), cid: "bafyreirecord", value: { $type: "app.bsky.feed.post", text: "Doors open at 18:00", createdAt: new Date(CONTRACT_NOW).toISOString() } }),
  notFound: { error: "RecordNotFound", message: `Could not locate record: ${uriOf(RKEY0)}` },
  /** com.atproto.repo.listRecords */
  records: (text: string, createdAt: number) => ({ records: [{ uri: uriOf("3l5aaaaaaaa22"), cid: "bafyreiold", value: { $type: "app.bsky.feed.post", text, createdAt: new Date(createdAt).toISOString() } }], cursor: "3l5aaaaaaaa22" }),
  expired: { error: "ExpiredToken", message: "Token has expired" },
  badLogin: { error: "AuthenticationRequired", message: "Invalid identifier or password" },
  takedown: { error: "AccountTakedown", message: "Account has been taken down" },
  rateLimited: { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
  invalid: { error: "InvalidRequest", message: "Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes" },
  upstream: { error: "UpstreamFailure", message: "Upstream Failure" },
};

/** The PDS's rate-limit headers; ratelimit-reset is in epoch seconds. */
export const RATE_HEADERS = { "ratelimit-limit": "5000", "ratelimit-remaining": "0", "ratelimit-reset": String(CONTRACT_NOW / 1000 + 30), "ratelimit-policy": "5000;w=3600" };
```

Create `test/platforms/bluesky/contract.ts`:
```ts
import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { BS, BS_ACCESS, BS_PASSWORD, BS_REFRESH, RATE_HEADERS, RKEY0, uriOf } from "./fixtures";

const job = () => ({
  variant: { path: "Social/Posts/Bs.md", platform: "bluesky" as const, channels: ["bs/you"], mode: "auto" as const, status: "scheduled" as const, media: [], deliveries: {} },
  channel: channel("bs/you", { handle: "@you.bsky.social", method: "api" as const, secretId: "osmm-channel-bs-you" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1 },
  text: "Doors open at 18:00",
  items: ["Doors open at 18:00"],
  media: [],
  secret: BS_PASSWORD,
});

export const blueskyCase: ContractCase = {
  platform: "bluesky",
  job,
  before: [json(200, BS.session)],
  success: { post: [json(200, BS.created(RKEY0))], expect: { remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` } },
  rateLimited: { post: [json(429, BS.rateLimited, RATE_HEADERS)], retryAfterMs: 30_000 },
  // The token expired, the refresh token too, and logging in again is refused.
  authExpired: [json(400, BS.expired), json(400, BS.expired), json(401, BS.badLogin)],
  forbidden: [json(403, BS.takedown)],
  rejected: [json(400, BS.invalid)],
  serverError: [json(502, BS.upstream)],
  sensitive: [BS_PASSWORD, BS_ACCESS, BS_REFRESH],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW } }),
    found: [json(200, BS.session), json(200, BS.record(RKEY0))],
    expect: { published: true, remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` },
    notFound: [json(200, BS.session), json(400, BS.notFound)],
  },
};
```
Add `blueskyCase` to `CASES`.

- [ ] **Step 2: Write the failing tests**

Create `test/platforms/bluesky/adapter.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { BlueskyAdapter } from "../../../src/platforms/bluesky/api";
import { postRkey } from "../../../src/platforms/bluesky/tid";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, PNG } from "../contract/harness";
import { bytes, call, json, queue, sentJson } from "../http";
import { blueskyCase } from "./contract";
import { BS, BS_ACCESS, BS_DID, BS_PASSWORD, BS_PDS, BS_REFRESH, RKEY0, uriOf } from "./fixtures";

const job = (extra: Partial<DeliveryJob> = {}): DeliveryJob => ({ ...blueskyCase.job(), ...extra });
const make = (extra: Partial<AdapterDeps> = {}) => new BlueskyAdapter({ ...contractDeps(), ...extra });
const created = (i: number) => json(200, BS.created(postRkey(CONTRACT_NOW, i, "bs/you")));
const CARD = { url: "https://event.example/x", title: "Event X", description: "Monthly makers evening", image: "https://event.example/cover.png" };

describe("BlueskyAdapter.publish", () => {
  it("logs in, then posts to the PDS with link and tag facets and a link card with its thumbnail", async () => {
    const linkCard = vi.fn(async () => CARD);
    queue(json(200, BS.session), bytes(200, PNG, "image/png"), json(200, BS.blob), created(0));
    const text = "Tickets: https://event.example/x #osmm";
    expect(await make({ linkCard }).publish(job({ text, items: [text] }))).toEqual({ remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` });
    expect(linkCard).toHaveBeenCalledWith("https://event.example/x");
    expect(call(0).url).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(sentJson(0)).toEqual({ identifier: "you.bsky.social", password: BS_PASSWORD });
    expect(call(1).url).toBe("https://event.example/cover.png");
    expect(call(2)).toMatchObject({ url: `${BS_PDS}/xrpc/com.atproto.repo.uploadBlob`, contentType: "image/png", headers: { Authorization: `Bearer ${BS_ACCESS}` } });
    expect(call(3).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.createRecord`);
    expect(sentJson(3)).toEqual({
      repo: BS_DID,
      collection: "app.bsky.feed.post",
      rkey: RKEY0,
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date(CONTRACT_NOW).toISOString(),
        facets: [
          { index: { byteStart: 9, byteEnd: 32 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://event.example/x" }] },
          { index: { byteStart: 33, byteEnd: 38 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "osmm" }] },
        ],
        embed: { $type: "app.bsky.embed.external", external: { uri: CARD.url, title: CARD.title, description: CARD.description, thumb: BS.blob.blob } },
      },
    });
  });

  it("uploads images with alt text and aspect ratio, and then leaves the link card out", async () => {
    const linkCard = vi.fn(async () => CARD);
    queue(json(200, BS.session), json(200, BS.blob), json(200, BS.blob), created(0));
    const j = job({ media: [img("a.png", 1200, 800, { alt: "Stage" }), img("b.png", 800, 800, { alt: undefined })] });
    j.variant = { ...j.variant, url: CARD.url };
    await make({ linkCard }).publish(j);
    expect(linkCard).not.toHaveBeenCalled();
    expect(sentJson(3).record.embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [
        { alt: "Stage", image: BS.blob.blob, aspectRatio: { width: 1200, height: 800 } },
        { alt: "", image: BS.blob.blob, aspectRatio: { width: 800, height: 800 } },
      ],
    });
  });

  it("posts without a card when the page can't be fetched (review focus 5)", async () => {
    queue(json(200, BS.session), created(0));
    const j = job();
    j.variant = { ...j.variant, url: CARD.url };
    await make({ linkCard: async () => null }).publish(j);
    expect(sentJson(1).record.embed).toBeUndefined();
    queue(json(200, BS.session), created(0));
    await make({ linkCard: async () => Promise.reject(new Error("offline")) }).publish(j);
    expect(sentJson(3).record.embed).toBeUndefined();
  });

  it("posts a thread as replies to the first post", async () => {
    queue(json(200, BS.session), created(0), created(1), created(2));
    await make().publish(job({ items: ["One", "Two", "Three"], text: "One\n\nTwo\n\nThree" }));
    const ref = (i: number) => ({ uri: uriOf(postRkey(CONTRACT_NOW, i, "bs/you")), cid: BS.created("x").cid });
    expect(sentJson(1).record.reply).toBeUndefined();
    expect(sentJson(2)).toMatchObject({ rkey: postRkey(CONTRACT_NOW, 1, "bs/you"), record: { text: "Two", reply: { root: ref(0), parent: ref(0) } } });
    expect(sentJson(3)).toMatchObject({ rkey: postRkey(CONTRACT_NOW, 2, "bs/you"), record: { text: "Three", reply: { root: ref(0), parent: ref(1) } } });
  });

  it("keeps the thread's first post when a later part fails, and says so", async () => {
    queue(json(200, BS.session), created(0), json(400, BS.invalid));
    const res = await make().publish(job({ items: ["One", "Two", "Three"], text: "One\n\nTwo\n\nThree" }));
    expect(res.remoteId).toBe(uriOf(RKEY0));
    expect(res.note).toBe(`Part 2 of 3 was not posted, nor any after it: Bluesky: ${BS.invalid.message} (HTTP 400)`);
  });

  it("refreshes an expired session and sends the post again", async () => {
    queue(json(200, BS.session), json(400, BS.expired), json(200, BS.refreshed), created(0));
    expect((await make().publish(job())).remoteId).toBe(uriOf(RKEY0));
    expect(call(2)).toMatchObject({ url: `${BS_PDS}/xrpc/com.atproto.server.refreshSession`, headers: { Authorization: `Bearer ${BS_REFRESH}` } });
    expect(call(3).headers).toEqual({ Authorization: `Bearer ${BS.refreshed.accessJwt}` });
  });

  it("logs in once per session", async () => {
    const adapter = make();
    queue(json(200, BS.session), created(0), created(0));
    await adapter.publish(job());
    await adapter.publish(job());
    expect(requestUrlMock.calls.map((c) => c.url.split("/xrpc/")[1])).toEqual(["com.atproto.server.createSession", "com.atproto.repo.createRecord", "com.atproto.repo.createRecord"]);
  });

  it("adds a mention facet only for a handle that resolves", async () => {
    queue(json(200, BS.session), json(200, BS.resolved), created(0));
    await make().publish(job({ text: "Thanks @alice.bsky.social", items: ["Thanks @alice.bsky.social"] }));
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.identity.resolveHandle?handle=alice.bsky.social`);
    expect(sentJson(2).record.facets).toEqual([{ index: { byteStart: 7, byteEnd: 25 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }] }]);
    queue(json(200, BS.session), json(400, BS.unresolved), created(0));
    await make().publish(job({ text: "Thanks @alice.bsky.social", items: ["Thanks @alice.bsky.social"] }));
    expect(sentJson(5).record.facets).toBeUndefined();
  });

  it("on a retry, returns the post an earlier attempt already made (M2b P4 retry de-duplication)", async () => {
    queue(json(200, BS.session), json(200, BS.records("Doors open at 18:00", CONTRACT_NOW - 5 * 60_000)));
    const res = await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2 } }));
    expect(res).toEqual({ remoteId: uriOf("3l5aaaaaaaa22"), url: "https://bsky.app/profile/you.bsky.social/post/3l5aaaaaaaa22" });
    expect(requestUrlMock.calls).toHaveLength(2);
    expect(call(1).url).toBe(`${BS_PDS}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(BS_DID)}&collection=app.bsky.feed.post&limit=10`);
  });

  it("refuses without a handle or an app password, before any request", async () => {
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an app password for bs/you on this device (Bluesky: Settings → Privacy and security → App passwords).");
    const j = job();
    j.channel = { ...j.channel, handle: "" };
    await expect(make().publish(j)).rejects.toThrow("Set the handle of bs/you to its Bluesky handle (you.bsky.social).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});

describe("BlueskyAdapter.lookup and verify", () => {
  it("can't tell without a claim time", async () => {
    expect(await make().lookup(job({ delivery: { status: "check_needed" } }))).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("names the account, or says why the login failed", async () => {
    queue(json(200, BS.session), json(401, BS.badLogin));
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: true, account: "@you.bsky.social" });
    expect(await make().verify(job().channel, BS_PASSWORD)).toEqual({ ok: false, error: "Bluesky: Invalid identifier or password (HTTP 401)" });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/platforms/bluesky test/platforms/contract`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement the adapter**

Create `src/platforms/bluesky/api.ts`:
```ts
import type { Channel } from "../../model/types";
import { cyrb53 } from "../../util/hash";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, TransientError, UnknownOutcomeError } from "../errors";
import { partialNote, readMedia } from "../files";
import { ApiClient, header, HTTP_TIMEOUT_MS, isOk, parseJson, send, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse, type Phase } from "../http";
import { urlsIn } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, VerifyResult } from "../types";
import { buildFacets } from "./richtext";
import { postRkey } from "./tid";

export const BSKY_SERVICE = "https://bsky.social";
/** app.bsky.embed.images / external thumb: at most 1,000,000 bytes per blob. */
export const BLOB_MAX = 1_000_000;
const POST = "app.bsky.feed.post";
const HOUR = 60 * 60_000;
const NEEDS_USER = new Set(["ExpiredToken", "InvalidToken", "AuthenticationRequired", "AccountTakedown", "AccountDeactivated", "AuthFactorTokenRequired"]);

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** Where the account's repository lives (from the DID document). */
  pds: string;
}
interface StrongRef {
  uri: string;
  cid: string;
}
interface Xrpc {
  path: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  json?: unknown;
  body?: ArrayBuffer;
  contentType?: string;
}
type Who = Pick<DeliveryJob, "channel" | "secret">;

export function blueskyFailure(now: () => number): (res: HttpResponse) => ApiFailure {
  return (res) => {
    const body = parseJson(res.text) as { error?: string; message?: string } | null;
    const message = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const reset = Number(header(res.headers, "ratelimit-reset"));
      return { message, ...(Number.isFinite(reset) && reset > 0 ? { retryAfterMs: Math.max(0, reset * 1000 - now()) } : {}) };
    }
    if (NEEDS_USER.has(body?.error ?? "")) return { message, kind: "needs_user" };
    return { message };
  };
}

function pdsOf(didDoc: unknown): string | null {
  const services = (didDoc as { service?: Array<{ id?: string; serviceEndpoint?: unknown }> } | null)?.service;
  const pds = services?.find((s) => s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds"))?.serviceEndpoint;
  return typeof pds === "string" && pds.startsWith("https://") ? pds.replace(/\/+$/, "") : null;
}

function expired(res: HttpResponse): boolean {
  if (res.status !== 400 && res.status !== 401) return false;
  const error = (parseJson(res.text) as { error?: string } | null)?.error;
  return error === "ExpiredToken" || error === "InvalidToken";
}

/**
 * Posts through the AT Protocol with an app password (#91). Record keys are derived from the claim time, so
 * lookup() finds an interrupted post exactly. Sessions stay in memory only.
 */
export class BlueskyAdapter implements PlatformAdapter {
  readonly platform = "bluesky" as const;
  private readonly api: ApiClient;
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "bluesky", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: blueskyFailure(deps.now) });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const session = await this.session(job);
    if ((job.delivery.attempts ?? 1) > 1) {
      const earlier = await this.findRecent(job, session).catch(() => null);
      if (earlier) return earlier;
    }
    const claimAt = job.delivery.at ?? this.deps.now();
    const root = await this.post(job, session, 0, claimAt);
    let parent = root;
    for (let i = 1; i < job.items.length; i++) {
      try {
        parent = await this.post(job, session, i, claimAt, { root, parent });
      } catch (e) {
        return { ...this.result(session, root.uri), note: partialNote(i, job.items.length, e) };
      }
    }
    return this.result(session, root.uri);
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    const at = job.delivery.at;
    if (at === undefined) return null;
    try {
      const s = await this.session(job);
      const rkey = postRkey(at, 0, job.channel.id);
      const res = await this.xrpc(job, "read", { path: "com.atproto.repo.getRecord", method: "GET", query: { repo: s.did, collection: POST, rkey } });
      if (isOk(res)) return { published: true, ...this.result(s, (parseJson(res.text) as { uri?: string } | null)?.uri ?? `at://${s.did}/${POST}/${rkey}`) };
      const error = (parseJson(res.text) as { error?: string } | null)?.error;
      return res.status === 400 && error === "RecordNotFound" ? { published: false } : null;
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const s = await this.session({ channel, secret });
      return { ok: true, account: `@${s.handle}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private result(s: Session, uri: string): { remoteId: string; url: string } {
    return { remoteId: uri, url: `https://bsky.app/profile/${s.handle}/post/${uri.split("/").pop() ?? ""}` };
  }

  private identity(who: Who): { identifier: string; password: string; service: string } {
    const identifier = (who.channel.handle ?? "").trim().replace(/^@/, "");
    if (!identifier) throw new NeedsUserError(`Set the handle of ${who.channel.name} to its Bluesky handle (you.bsky.social).`);
    if (!who.secret) throw new NeedsUserError(`Add an app password for ${who.channel.name} on this device (Bluesky: Settings → Privacy and security → App passwords).`);
    return { identifier, password: who.secret, service: who.channel.server ?? BSKY_SERVICE };
  }

  private key(who: Who): string {
    return `${who.channel.id}\n${cyrb53(who.secret ?? "")}`;
  }

  private async session(who: Who): Promise<Session> {
    const id = this.identity(who);
    const cached = this.sessions.get(this.key(who));
    if (cached) return cached;
    const res = await this.api.prepare({
      url: `${id.service}/xrpc/com.atproto.server.createSession`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ identifier: id.identifier, password: id.password }),
    });
    const s = this.parseSession(res, id.service);
    this.sessions.set(this.key(who), s);
    return s;
  }

  private parseSession(res: HttpResponse, fallbackPds: string): Session {
    const body = parseJson(res.text) as { did?: string; handle?: string; accessJwt?: string; refreshJwt?: string; didDoc?: unknown } | null;
    if (!body?.did || !body.accessJwt || !body.refreshJwt) throw new TransientError("Bluesky: the login answer could not be read; nothing was posted.");
    return { did: body.did, handle: body.handle ?? body.did, accessJwt: body.accessJwt, refreshJwt: body.refreshJwt, pds: pdsOf(body.didDoc) ?? fallbackPds };
  }

  /** ExpiredToken: refresh the session; when the refresh is refused too, log in again. */
  private async refresh(who: Who, s: Session): Promise<Session> {
    this.sessions.delete(this.key(who));
    const res = await this.api.exchange("prepare", { url: `${s.pds}/xrpc/com.atproto.server.refreshSession`, method: "POST", headers: { Authorization: `Bearer ${s.refreshJwt}` } });
    if (!isOk(res)) return this.session(who);
    const next = { ...this.parseSession(res, s.pds), pds: s.pds };
    this.sessions.set(this.key(who), next);
    return next;
  }

  private request(s: Session, call: Xrpc): HttpRequest {
    const query = call.query ? `?${new URLSearchParams(call.query).toString()}` : "";
    const req: HttpRequest = { url: `${s.pds}/xrpc/${call.path}${query}`, method: call.method, headers: { Authorization: `Bearer ${s.accessJwt}` } };
    if (call.json !== undefined) return { ...req, contentType: "application/json", body: JSON.stringify(call.json) };
    if (call.body) return { ...req, contentType: call.contentType ?? "application/octet-stream", body: call.body, timeoutMs: UPLOAD_TIMEOUT_MS };
    return req;
  }

  /** One XRPC call with the session; an expired token is refreshed and the call sent once more (it was refused, not processed). */
  private async xrpc(who: Who, phase: Phase, call: Xrpc): Promise<HttpResponse> {
    let s = await this.session(who);
    let res = await this.api.exchange(phase, this.request(s, call));
    if (expired(res)) {
      s = await this.refresh(who, s);
      res = await this.api.exchange(phase, this.request(s, call));
    }
    return res;
  }

  private async post(job: DeliveryJob, s: Session, i: number, claimAt: number, reply?: { root: StrongRef; parent: StrongRef }): Promise<StrongRef> {
    const text = job.items[i] ?? "";
    const record: Record<string, unknown> = { $type: POST, text, createdAt: new Date(this.deps.now()).toISOString() };
    const facets = await buildFacets(text, (handle) => this.resolveHandle(job, handle));
    if (facets.length) record.facets = facets;
    if (reply) record.reply = reply;
    if (i === 0) {
      const embed = await this.embed(job);
      if (embed) record.embed = embed;
    }
    const res = await this.xrpc(job, "commit", { path: "com.atproto.repo.createRecord", method: "POST", json: { repo: s.did, collection: POST, rkey: postRkey(claimAt, i, job.channel.id), record } });
    if (!isOk(res)) throw this.api.error(res);
    const ref = parseJson(res.text) as Partial<StrongRef> | null;
    if (!ref?.uri || !ref.cid) throw new UnknownOutcomeError("Bluesky: the answer had no record id, so it is not known whether the post went out.");
    return { uri: ref.uri, cid: ref.cid };
  }

  /** Images when there are any (Bluesky shows one or the other), else the link card of the post's url or last link. */
  private async embed(job: DeliveryJob): Promise<Record<string, unknown> | null> {
    const images = job.media.filter((m) => m.kind === "image").slice(0, 4);
    if (images.length) {
      const list: Array<Record<string, unknown>> = [];
      for (const m of images) {
        list.push({ alt: m.alt ?? "", image: await this.upload(job, m), ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}) });
      }
      return { $type: "app.bsky.embed.images", images: list };
    }
    const url = job.variant.url ?? urlsIn(job.items.join("\n")).at(-1);
    if (!url || !this.deps.linkCard) return null;
    const card = await this.deps.linkCard(url).catch(() => null);
    if (!card) return null;
    const thumb = card.image ? await this.thumb(job, card.image) : null;
    return { $type: "app.bsky.embed.external", external: { uri: card.url, title: card.title, description: card.description, ...(thumb ? { thumb } : {}) } };
  }

  private async upload(job: DeliveryJob, m: MediaInfo): Promise<unknown> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    if (data.byteLength > BLOB_MAX) throw new InvalidContentError(`Bluesky: ${m.target} is larger than 1 MB.`);
    return this.blob(job, data, m.mime ?? "application/octet-stream");
  }

  private async blob(job: DeliveryJob, data: ArrayBuffer, mime: string): Promise<unknown> {
    const res = await this.xrpc(job, "prepare", { path: "com.atproto.repo.uploadBlob", method: "POST", body: data, contentType: mime });
    if (!isOk(res)) throw this.api.error(res);
    const blob = (parseJson(res.text) as { blob?: unknown } | null)?.blob;
    if (!blob) throw new TransientError("Bluesky: the upload answer had no blob; nothing was posted.");
    return blob;
  }

  /** The card's image as a blob; any failure means a card without an image. */
  private async thumb(job: DeliveryJob, imageUrl: string): Promise<unknown> {
    if (!imageUrl.startsWith("https://")) return null;
    try {
      const res = await send(this.deps.http, { url: imageUrl, method: "GET" }, this.deps.timeoutMs ?? HTTP_TIMEOUT_MS);
      const type = (header(res.headers, "content-type") ?? "").split(";")[0]!.trim();
      if (!isOk(res) || !type.startsWith("image/") || res.arrayBuffer.byteLength > BLOB_MAX) return null;
      return await this.blob(job, res.arrayBuffer, type);
    } catch {
      return null;
    }
  }

  private async resolveHandle(who: Who, handle: string): Promise<string | null> {
    try {
      const res = await this.xrpc(who, "read", { path: "com.atproto.identity.resolveHandle", method: "GET", query: { handle } });
      return isOk(res) ? ((parseJson(res.text) as { did?: string } | null)?.did ?? null) : null;
    } catch {
      return null;
    }
  }

  /** A retry (M2b P4 allows it after a 5xx): a post with the same text from the last hour means the earlier attempt went out. */
  private async findRecent(job: DeliveryJob, s: Session): Promise<PublishResult | null> {
    const res = await this.xrpc(job, "read", { path: "com.atproto.repo.listRecords", method: "GET", query: { repo: s.did, collection: POST, limit: "10" } });
    if (!isOk(res)) return null;
    const records = (parseJson(res.text) as { records?: Array<{ uri: string; value?: { text?: string; createdAt?: string } }> } | null)?.records ?? [];
    const since = this.deps.now() - HOUR;
    const hit = records.find((r) => r.value?.text === job.items[0] && Date.parse(r.value?.createdAt ?? "") >= since);
    return hit ? this.result(s, hit.uri) : null;
  }
}
```

In `src/platforms/adapters.ts`: import `BlueskyAdapter` and add `new BlueskyAdapter(deps)` to the list.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms`
Expected: PASS, including every Bluesky contract scenario and the lookup scenario.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/bluesky/api.ts src/platforms/adapters.ts test/platforms/bluesky test/platforms/contract/cases.ts
git commit -m "feat(bluesky): AT Protocol adapter with app-password sessions, facets, image blobs, link cards, threads and exact lookup (#91)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Mastodon adapter with native scheduling (#90)

**Files:**
- Create: `src/platforms/mastodon/api.ts`, `test/platforms/mastodon/fixtures.ts`, `test/platforms/mastodon/contract.ts`, `test/platforms/mastodon/adapter.test.ts`
- Modify: `src/platforms/adapters.ts`, `test/platforms/contract/cases.ts`

**Interfaces:**
- Consumes: `ApiClient`, `header`, `isOk`, `parseJson`, `UPLOAD_TIMEOUT_MS`, `HttpRequest` (Task 2); `multipart`, `readMedia`, `fileName`, `partialNote`, `withLink` (Task 2); `RemoteRemovedError`, `SyncChange`, `ScheduleResult` (Task 1); `mastodonInstance` (`src/platforms/share.ts`); `cyrb53`; `MINUTE`.
- Produces: `class MastodonAdapter implements PlatformAdapter { platform: "mastodon"; minLeadMs = MASTODON_MIN_LEAD_MS; publish; schedule; scheduleRefusal; update; cancel; lookup; verify }`; `MASTODON_MIN_LEAD_MS = 5 * MINUTE`; `mastodonBase(channel)`; `mastodonFailure(now)`; `toMastodonFocus(focus)`; `fingerprint(text)`; `mastodonCase`; fixtures `MA`, `MA_TOKEN`, `MA_AT`, `MA_RATE`.

Channel setup: the handle `@you@instance` names the server (or `server` overrides it); the credential is an access token from Preferences → Development (scopes `read` and `write`, or at least `read:accounts read:statuses write:statuses write:media`). A `native` channel hands posts over with `scheduled_at` (at least 5 minutes ahead). A thread is never handed over, and is posted from Obsidian at its time with `in_reply_to_id`.

- [ ] **Step 1: Write the fixtures (from docs.joinmastodon.org: statuses, scheduled_statuses, media, accounts)**

Create `test/platforms/mastodon/fixtures.ts`:
```ts
import { CONTRACT_NOW } from "../contract/harness";

export const MA_TOKEN = "ZA-Yj3aBD8U8Cm7lKUp-lm9O9BmDgdhHzDeqsY8tlL0";
/** Thu 8 Oct 2026, 17:30 Berlin: the time posts are handed over for. */
export const MA_AT = Date.UTC(2026, 9, 8, 15, 30);

const account = { id: "109000000000000001", username: "you", acct: "you", display_name: "You", url: "https://mastodon.social/@you" };

export const MA = {
  /** GET /api/v1/accounts/verify_credentials */
  account,
  /** POST /api/v1/statuses → Status */
  status: (id = "113258473000000001", text = "Doors open at 18:00", created = CONTRACT_NOW) => ({
    id,
    created_at: new Date(created).toISOString(),
    in_reply_to_id: null,
    sensitive: false,
    spoiler_text: "",
    visibility: "public",
    language: "en",
    uri: `https://mastodon.social/users/you/statuses/${id}`,
    url: `https://mastodon.social/@you/${id}`,
    content: `<p>${text}</p>`,
    media_attachments: [],
    mentions: [],
    tags: [],
    account,
  }),
  /** POST /api/v1/statuses with scheduled_at, GET /api/v1/scheduled_statuses/:id → ScheduledStatus */
  scheduled: (id = "3221", at = MA_AT, text = "Doors open at 18:00") => ({
    id,
    scheduled_at: new Date(at).toISOString(),
    params: { text, poll: null, media_ids: null, sensitive: null, spoiler_text: null, visibility: null, in_reply_to_id: null, language: null, application_id: 1, scheduled_at: null, idempotency: null, with_rate_limit: false },
    media_attachments: [],
  }),
  /** POST /api/v2/media → 200 MediaAttachment (processed) */
  media: {
    id: "22348641",
    type: "image",
    url: "https://files.mastodon.social/media_attachments/files/022/348/641/original/cover.png",
    preview_url: "https://files.mastodon.social/media_attachments/files/022/348/641/small/cover.png",
    remote_url: null,
    description: "Crowd at the door",
    meta: { focus: { x: -0.16, y: 0.69 } },
    blurhash: "UFBWY:8_0Jxv4mof",
  },
  /** POST /api/v2/media → 202 (still processing: url is null); GET /api/v1/media/:id → 206 until done */
  processing: { id: "22348642", type: "image", url: null, preview_url: null, description: null },
  invalidToken: { error: "The access token is invalid" },
  scope: { error: "This action is outside the authorized scopes" },
  tooLong: { error: "Validation failed: Text character limit of 500 exceeded" },
  tooSoon: { error: "Validation failed: Scheduled at The scheduled date must be at least 5 minutes in the future" },
  notFound: { error: "Record not found" },
  tooMany: { error: "Too many requests" },
  unavailable: { error: "Service Unavailable" },
};

/** Mastodon's rate-limit headers; the reset is an ISO time. */
export const MA_RATE = { "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": new Date(CONTRACT_NOW + 30_000).toISOString() };
```

Create `test/platforms/mastodon/contract.ts`:
```ts
import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { MA, MA_RATE, MA_TOKEN } from "./fixtures";

const job = () => ({
  variant: { path: "Social/Posts/Ma.md", platform: "mastodon" as const, channels: ["ma/you"], mode: "auto" as const, status: "scheduled" as const, media: [], deliveries: {} },
  channel: channel("ma/you", { handle: "@you@mastodon.social", method: "native" as const, secretId: "osmm-channel-ma-you" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1 },
  text: "Doors open at 18:00",
  items: ["Doors open at 18:00"],
  media: [],
  secret: MA_TOKEN,
});

export const mastodonCase: ContractCase = {
  platform: "mastodon",
  job,
  before: [],
  success: { post: [json(200, MA.status())], expect: { remoteId: "113258473000000001", url: "https://mastodon.social/@you/113258473000000001" } },
  rateLimited: { post: [json(429, MA.tooMany, MA_RATE)], retryAfterMs: 30_000 },
  authExpired: [json(401, MA.invalidToken)],
  forbidden: [json(403, MA.scope)],
  rejected: [json(422, MA.tooLong)],
  serverError: [json(503, MA.unavailable)],
  sensitive: [MA_TOKEN],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW } }),
    found: [json(200, MA.account), json(200, [MA.status()])],
    expect: { published: true, remoteId: "113258473000000001", url: "https://mastodon.social/@you/113258473000000001" },
    notFound: [json(200, MA.account), json(200, [])],
  },
};
```
Add `mastodonCase` to `CASES`.

- [ ] **Step 2: Write the failing tests**

Create `test/platforms/mastodon/adapter.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import { RemoteRemovedError } from "../../../src/platforms/errors";
import { fingerprint, MastodonAdapter, toMastodonFocus } from "../../../src/platforms/mastodon/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW } from "../contract/harness";
import { call, formParts, hang, json, queue, sentJson } from "../http";
import { mastodonCase } from "./contract";
import { MA, MA_AT, MA_TOKEN } from "./fixtures";

const job = (extra: Partial<DeliveryJob> = {}): DeliveryJob => ({ ...mastodonCase.job(), ...extra });
const handedOver = (extra: Partial<DeliveryJob["delivery"]> = {}): DeliveryJob => job({ delivery: { status: "handed_over", at: MA_AT, remoteAt: MA_AT, remoteId: "3221", ...extra } });
const make = (sleep = vi.fn(async () => undefined)) => new MastodonAdapter({ ...contractDeps(), sleep });
const BASE = "https://mastodon.social";
const AUTH = { Authorization: `Bearer ${MA_TOKEN}` };
const thread = (): Partial<DeliveryJob> => ({ items: ["One", "Two", "Three"], text: "One\n\nTwo\n\nThree" });

describe("MastodonAdapter.publish", () => {
  it("posts to the instance from the handle, with a stable idempotency key", async () => {
    queue(json(200, MA.status()), json(200, MA.status()));
    expect(await make().publish(job())).toEqual(mastodonCase.success.expect);
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/statuses`, method: "POST", contentType: "application/json", headers: AUTH });
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00" });
    const key = call(0).headers!["Idempotency-Key"];
    expect(key).toMatch(/^osmm-[0-9a-z]+$/);
    await make().publish(job());
    expect(call(1).headers!["Idempotency-Key"]).toBe(key);
  });

  it("uploads images with alt text and a converted focal point", async () => {
    queue(json(200, MA.media), json(200, MA.status()));
    await make().publish(job({ media: [img("cover.png", 1080, 1080, { alt: "Crowd at the door", focus: [0.42, 0.155] })] }));
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v2/media`, method: "POST", headers: AUTH });
    expect(formParts(0)).toEqual({ file: { filename: "cover.png", type: "image/png", size: 8 }, description: { value: "Crowd at the door", size: 17 }, focus: { value: "-0.16,0.69", size: 10 } });
    expect(sentJson(1)).toEqual({ status: "Doors open at 18:00", media_ids: ["22348641"] });
  });

  it("waits for an image that is still processing", async () => {
    const sleep = vi.fn(async () => undefined);
    queue(json(202, MA.processing), json(206, MA.processing), json(200, { ...MA.processing, url: "https://files.mastodon.social/x.png" }), json(200, MA.status()));
    await make(sleep).publish(job({ media: [img("cover.png")] }));
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe(`${BASE}/api/v1/media/22348642`);
    expect(sentJson(3).media_ids).toEqual(["22348642"]);
  });

  it("posts a thread as replies, and keeps the first post when a later part fails", async () => {
    queue(json(200, MA.status("1")), json(200, MA.status("2")), json(200, MA.status("3")));
    await make().publish(job(thread()));
    expect(sentJson(1)).toEqual({ status: "Two", in_reply_to_id: "1" });
    expect(sentJson(2)).toEqual({ status: "Three", in_reply_to_id: "2" });
    queue(json(200, MA.status("1")), json(422, MA.tooLong));
    const res = await make().publish(job(thread()));
    expect(res).toMatchObject({ remoteId: "1" });
    expect(res.note).toBe("Part 2 of 3 was not posted, nor any after it: Mastodon: Validation failed: Text character limit of 500 exceeded (HTTP 422)");
  });

  it("refuses without an instance or a token, before any request", async () => {
    const noInstance = job();
    noInstance.channel = { ...noInstance.channel, handle: "you" };
    await expect(make().publish(noInstance)).rejects.toThrow("Set the handle of ma/you to @you@your.instance (or set its server address).");
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an access token for ma/you on this device (Mastodon: Preferences → Development → New application, scopes read and write).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});

describe("MastodonAdapter native scheduling (#90)", () => {
  it("hands a post over with scheduled_at", async () => {
    queue(json(200, MA.scheduled()));
    expect(await make().schedule(job({ delivery: { status: "handed_over", at: MA_AT, remoteAt: MA_AT } }))).toEqual({ remoteId: "3221" });
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00", scheduled_at: "2026-10-08T15:30:00.000Z" });
  });

  it("never hands over a thread", async () => {
    const j = job({ ...thread(), delivery: { status: "handed_over", at: MA_AT } });
    expect(make().scheduleRefusal(j)).toBe("Mastodon can't schedule a thread, so this one is posted from Obsidian at its time.");
    await expect(make().schedule(j)).rejects.toMatchObject({ kind: "invalid_content" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("moves a handed-over post to its new time", async () => {
    queue(json(200, MA.scheduled("3221", MA_AT + 30 * 60_000)));
    expect(await make().update(handedOver({ at: MA_AT + 30 * 60_000 }), { content: false, time: true })).toEqual({});
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "PUT" });
    expect(sentJson(0)).toEqual({ scheduled_at: "2026-10-08T16:00:00.000Z" });
  });

  it("replaces a handed-over post whose text changed: remove first, then schedule the new one", async () => {
    queue(json(200, {}), json(200, MA.scheduled("3222")));
    const j = handedOver();
    j.items = ["Doors open at 18:30"];
    j.text = "Doors open at 18:30";
    expect(await make().update(j, { content: true, time: false })).toEqual({ remoteId: "3222" });
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "DELETE" });
    expect(sentJson(1)).toEqual({ status: "Doors open at 18:30", scheduled_at: "2026-10-08T15:30:00.000Z" });
  });

  it("says the platform copy is gone when the new version can't be scheduled after the removal", async () => {
    queue(json(200, {}), json(422, MA.tooSoon));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toBeInstanceOf(RemoteRemovedError);
  });

  it("changes nothing when the scheduled post is already gone", async () => {
    queue(json(404, MA.notFound));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("checks whether an unanswered removal happened before scheduling again", async () => {
    queue(hang, json(404, MA.notFound), json(200, MA.scheduled("3222")));
    expect(await make().update(handedOver(), { content: true, time: false })).toEqual({ remoteId: "3222" });
    expect(call(1)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "GET" });
    queue(hang, json(200, MA.scheduled()));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toMatchObject({ kind: "transient" });
  });

  it("edits a live post, but not a live thread", async () => {
    queue(json(200, MA.status()));
    await make().update(job({ delivery: { status: "published", remoteId: "113258473000000001" } }));
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/statuses/113258473000000001`, method: "PUT" });
    expect(sentJson(0)).toEqual({ status: "Doors open at 18:00", media_ids: [] });
    await expect(make().update(job({ ...thread(), delivery: { status: "published", remoteId: "1" } }))).rejects.toMatchObject({ kind: "invalid_content" });
  });

  it("takes a post off the schedule, and refuses when it is no longer there", async () => {
    queue(json(200, {}), json(404, MA.notFound));
    await make().cancel(handedOver());
    expect(call(0)).toMatchObject({ url: `${BASE}/api/v1/scheduled_statuses/3221`, method: "DELETE" });
    await expect(make().cancel(handedOver())).rejects.toMatchObject({ kind: "needs_user" });
  });
});

describe("MastodonAdapter.lookup", () => {
  it("reports a handed-over post that is still scheduled, and its platform time", async () => {
    queue(json(200, MA.scheduled("3221", MA_AT + 60_000)));
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "3221", scheduledAt: MA_AT + 60_000 });
  });

  it("finds the published post once the scheduled one is gone, and can't tell when it finds nothing", async () => {
    queue(json(404, MA.notFound), json(200, MA.account), json(200, [MA.status("5", "Doors open at 18:00", MA_AT)]));
    expect(await make().lookup(handedOver())).toEqual({ published: true, remoteId: "5", url: "https://mastodon.social/@you/5" });
    expect(call(2).url).toBe(`${BASE}/api/v1/accounts/109000000000000001/statuses?limit=40`);
    queue(json(404, MA.notFound), json(200, MA.account), json(200, []));
    expect(await make().lookup(handedOver())).toBeNull();
  });

  it("finds an interrupted hand-over in the scheduled list", async () => {
    queue(json(200, [MA.scheduled("3999", MA_AT + 3_600_000, "Other"), MA.scheduled("3221")]));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false, remoteId: "3221", scheduledAt: MA_AT });
    expect(call(0).url).toBe(`${BASE}/api/v1/scheduled_statuses?limit=40`);
  });

  it("matches by text regardless of HTML and case", () => {
    expect(fingerprint("Doors open at 18:00!")).toBe(fingerprint("doors OPEN at 18:00"));
    expect(toMastodonFocus([0.5, 0.5])).toBe("0.00,0.00");
  });
});

describe("MastodonAdapter.verify", () => {
  it("names the account", async () => {
    queue(json(200, MA.account), json(401, MA.invalidToken));
    expect(await make().verify(job().channel, MA_TOKEN)).toEqual({ ok: true, account: "@you@mastodon.social" });
    expect(await make().verify(job().channel, MA_TOKEN)).toEqual({ ok: false, error: "Mastodon: The access token is invalid (HTTP 401)" });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/platforms/mastodon test/platforms/contract`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement the adapter**

Create `src/platforms/mastodon/api.ts`:
```ts
import { MINUTE } from "../../model/dates";
import type { Channel } from "../../model/types";
import { cyrb53 } from "../../util/hash";
import type { AdapterDeps } from "../adapters";
import { classifyError, InvalidContentError, NeedsUserError, RemoteRemovedError, TransientError, UnknownOutcomeError } from "../errors";
import { fileName, partialNote, readMedia } from "../files";
import { ApiClient, header, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse } from "../http";
import { multipart, type Part } from "../multipart";
import { mastodonInstance } from "../share";
import { withLink } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, ScheduleResult, SyncChange, VerifyResult } from "../types";

/** Mastodon refuses a scheduled_at less than 5 minutes ahead. */
export const MASTODON_MIN_LEAD_MS = 5 * MINUTE;
const MEDIA_POLL_MS = 1_000;
const MEDIA_POLL_TRIES = 30;
const enc = encodeURIComponent;

interface MaStatus {
  id: string;
  url?: string | null;
  uri: string;
  created_at: string;
  content: string;
}
interface MaScheduled {
  id: string;
  scheduled_at: string;
  params?: { text?: string | null };
}
interface Target {
  base: string;
  auth: Record<string, string>;
  host: string;
}

export function mastodonBase(channel: Channel): string | null {
  if (channel.server) return channel.server;
  const instance = mastodonInstance(channel.handle);
  return instance ? `https://${instance}` : null;
}

export function mastodonFailure(now: () => number): (res: HttpResponse) => ApiFailure {
  return (res) => {
    const body = parseJson(res.text) as { error?: string; error_description?: string } | null;
    const message = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const reset = Date.parse(header(res.headers, "x-ratelimit-reset") ?? "");
      if (Number.isFinite(reset)) return { message, retryAfterMs: Math.max(0, reset - now()) };
    }
    return { message };
  };
}

/** Our focal point (0..1 from the left and from the top) → Mastodon's (-1..1, y pointing up). */
export function toMastodonFocus([x, y]: [number, number]): string {
  return `${(x * 2 - 1).toFixed(2)},${(1 - y * 2).toFixed(2)}`;
}

/** The letters and digits of a post's start: how a post is recognised in a list (Mastodon returns HTML). */
export function fingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 80);
}

function plain(html: string): string {
  return new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/p>/gi, " "), "text/html").body.textContent ?? "";
}

/**
 * Instance-specific posting with an access token (#90): immediate posts and threads, media with alt text and focus,
 * native hand-over with scheduled_at (single posts only), time and content updates, cancel, and lookup.
 */
export class MastodonAdapter implements PlatformAdapter {
  readonly platform = "mastodon" as const;
  readonly minLeadMs = MASTODON_MIN_LEAD_MS;
  private readonly api: ApiClient;

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "mastodon", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: mastodonFailure(deps.now) });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const t = this.target(job);
    const mediaIds = await this.uploadAll(t, job);
    const first = await this.status(t, job, 0, { status: this.firstText(job), ...(mediaIds.length ? { media_ids: mediaIds } : {}) });
    let parent = first;
    for (let i = 1; i < job.items.length; i++) {
      try {
        parent = await this.status(t, job, i, { status: job.items[i] ?? "", in_reply_to_id: parent.id });
      } catch (e) {
        return { ...this.result(first), note: partialNote(i, job.items.length, e) };
      }
    }
    return this.result(first);
  }

  scheduleRefusal(job: DeliveryJob): string | null {
    return job.items.length > 1 ? "Mastodon can't schedule a thread, so this one is posted from Obsidian at its time." : null;
  }

  async schedule(job: DeliveryJob): Promise<ScheduleResult> {
    const refusal = this.scheduleRefusal(job);
    if (refusal) throw new InvalidContentError(`Mastodon: ${refusal}`);
    const at = job.delivery.at;
    if (at === undefined) throw new InvalidContentError("Mastodon: a scheduled post needs a time.");
    const t = this.target(job);
    const mediaIds = await this.uploadAll(t, job);
    const payload = { status: this.firstText(job), ...(mediaIds.length ? { media_ids: mediaIds } : {}), scheduled_at: new Date(at).toISOString() };
    const res = await this.api.commit(this.post(t, "/api/v1/statuses", payload, this.key(job, 0, at)));
    const s = parseJson(res.text) as Partial<MaScheduled> | null;
    if (!s?.id || !s.scheduled_at) throw new UnknownOutcomeError("Mastodon: the answer had no scheduled post id, so it is not known whether it was scheduled.");
    return { remoteId: s.id };
  }

  async update(job: DeliveryJob, change?: SyncChange): Promise<{ remoteId?: string }> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("Mastodon: this post has no id to update.");
    if (job.delivery.status === "handed_over") {
      const at = job.delivery.at;
      if (at === undefined) throw new InvalidContentError("Mastodon: a scheduled post needs a time.");
      if (change && !change.content) {
        await this.api.commit({ url: `${t.base}/api/v1/scheduled_statuses/${enc(id)}`, method: "PUT", headers: t.auth, contentType: "application/json", body: JSON.stringify({ scheduled_at: new Date(at).toISOString() }) });
        return {};
      }
      // Mastodon can't edit a scheduled post's text. Remove it first, so there are never two scheduled copies.
      await this.removeScheduled(t, id);
      try {
        return { remoteId: (await this.schedule(job)).remoteId };
      } catch (e) {
        throw new RemoteRemovedError(`Mastodon: the old scheduled post was removed, but the new one could not be scheduled (${classifyError(e).message}). It will be posted from Obsidian at its time.`);
      }
    }
    if (job.items.length > 1) throw new InvalidContentError("Mastodon: only a single post can be edited, not a thread.");
    const mediaIds = await this.uploadAll(t, job);
    await this.api.commit({ url: `${t.base}/api/v1/statuses/${enc(id)}`, method: "PUT", headers: t.auth, contentType: "application/json", body: JSON.stringify({ status: this.firstText(job), media_ids: mediaIds }) });
    return {};
  }

  async cancel(job: DeliveryJob): Promise<void> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("Mastodon: this post has no scheduled id to remove.");
    const res = await this.api.exchange("commit", { url: `${t.base}/api/v1/scheduled_statuses/${enc(id)}`, method: "DELETE", headers: t.auth });
    if (res.status === 404) throw new NeedsUserError("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon.");
    if (!isOk(res)) throw this.api.error(res);
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    try {
      const t = this.target(job);
      const d = job.delivery;
      const text = this.firstText(job);
      if (d.remoteAt !== undefined) {
        if (d.remoteId) {
          const res = await this.api.read({ url: `${t.base}/api/v1/scheduled_statuses/${enc(d.remoteId)}`, method: "GET", headers: t.auth });
          if (isOk(res)) {
            const s = parseJson(res.text) as Partial<MaScheduled> | null;
            return { published: false, remoteId: d.remoteId, ...(s?.scheduled_at ? { scheduledAt: Date.parse(s.scheduled_at) } : {}) };
          }
          if (res.status !== 404) return null;
          // A scheduled post loses its id when it goes out: look for it among the published ones.
          const found = await this.findPublished(t, text, d.remoteAt);
          return found?.published ? found : null;
        }
        // An interrupted hand-over: look for it in the schedule, then among the published posts.
        const res = await this.api.read({ url: `${t.base}/api/v1/scheduled_statuses?limit=40`, method: "GET", headers: t.auth });
        if (!isOk(res)) return null;
        const want = fingerprint(text);
        const hit = ((parseJson(res.text) as MaScheduled[] | null) ?? []).find((s) => Date.parse(s.scheduled_at) === d.remoteAt && fingerprint(s.params?.text ?? "") === want);
        if (hit) return { published: false, remoteId: hit.id, scheduledAt: Date.parse(hit.scheduled_at) };
        return await this.findPublished(t, text, d.remoteAt);
      }
      if (d.at === undefined) return null;
      return await this.findPublished(t, text, d.at);
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const t = this.target({ channel, secret });
      const res = await this.api.read({ url: `${t.base}/api/v1/accounts/verify_credentials`, method: "GET", headers: t.auth }).catch(() => {
        throw new Error(`Couldn't reach ${t.host}.`);
      });
      if (!isOk(res)) throw this.api.error(res);
      const acct = (parseJson(res.text) as { acct?: string } | null)?.acct ?? "";
      return { ok: true, account: `@${acct}@${t.host}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private target(who: Pick<DeliveryJob, "channel" | "secret">): Target {
    const base = mastodonBase(who.channel);
    if (!base) throw new NeedsUserError(`Set the handle of ${who.channel.name} to @you@your.instance (or set its server address).`);
    if (!who.secret) throw new NeedsUserError(`Add an access token for ${who.channel.name} on this device (Mastodon: Preferences → Development → New application, scopes read and write).`);
    return { base, auth: { Authorization: `Bearer ${who.secret}` }, host: new URL(base).host };
  }

  private firstText(job: DeliveryJob): string {
    return withLink(job.items[0] ?? "", job.variant.url);
  }

  /**
   * Mastodon keeps an Idempotency-Key for an hour: a retry after a 5xx returns the first post instead of a second
   * one. The key covers the part's text and time, and the id being replaced, so a new version gets a new key.
   */
  private key(job: DeliveryJob, i: number, at?: number): string {
    const parts = [job.variant.path, job.channel.id, String(i), job.items[i] ?? "", at === undefined ? "" : String(at), job.delivery.remoteId ?? ""];
    return `osmm-${cyrb53(parts.join("\n")).toString(36)}`;
  }

  private post(t: Target, path: string, payload: Record<string, unknown>, key?: string): HttpRequest {
    return { url: `${t.base}${path}`, method: "POST", headers: { ...t.auth, ...(key ? { "Idempotency-Key": key } : {}) }, contentType: "application/json", body: JSON.stringify(payload) };
  }

  private async status(t: Target, job: DeliveryJob, i: number, payload: Record<string, unknown>): Promise<MaStatus> {
    const res = await this.api.commit(this.post(t, "/api/v1/statuses", payload, this.key(job, i)));
    const s = parseJson(res.text) as MaStatus | null;
    if (!s?.id) throw new UnknownOutcomeError("Mastodon: the answer had no post id, so it is not known whether it went out.");
    return s;
  }

  private result(s: MaStatus): PublishResult {
    return { remoteId: s.id, url: s.url ?? s.uri };
  }

  private async uploadAll(t: Target, job: DeliveryJob): Promise<string[]> {
    const ids: string[] = [];
    for (const m of job.media.filter((x) => x.kind === "image").slice(0, 4)) ids.push(await this.upload(t, m));
    return ids;
  }

  private async upload(t: Target, m: MediaInfo): Promise<string> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    const parts: Part[] = [{ name: "file", filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data }];
    if (m.alt) parts.push({ name: "description", value: m.alt.slice(0, 1500) });
    if (m.focus) parts.push({ name: "focus", value: toMastodonFocus(m.focus) });
    const form = multipart(parts);
    const res = await this.api.prepare({ url: `${t.base}/api/v2/media`, method: "POST", headers: t.auth, contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const media = parseJson(res.text) as { id?: string; url?: string | null } | null;
    if (!media?.id) throw new TransientError("Mastodon: the upload answer had no media id; nothing was posted.");
    if (res.status === 202 || !media.url) await this.processed(t, media.id);
    return media.id;
  }

  /** A large image is processed after the upload (202); the post may only use it once GET /media/:id answers 200. */
  private async processed(t: Target, id: string): Promise<void> {
    for (let i = 0; i < MEDIA_POLL_TRIES; i++) {
      await this.deps.sleep(MEDIA_POLL_MS);
      const res = await this.api.prepare({ url: `${t.base}/api/v1/media/${enc(id)}`, method: "GET", headers: t.auth });
      if (res.status === 200) return;
    }
    throw new TransientError("Mastodon: the image is still being processed; nothing was posted.");
  }

  /** Removes a scheduled post before a new version is scheduled. Never schedules again unless the old one is surely gone. */
  private async removeScheduled(t: Target, id: string): Promise<void> {
    const url = `${t.base}/api/v1/scheduled_statuses/${enc(id)}`;
    let res: HttpResponse;
    try {
      res = await this.api.exchange("commit", { url, method: "DELETE", headers: t.auth });
    } catch {
      const check = await this.api.read({ url, method: "GET", headers: t.auth }).catch(() => null);
      if (check?.status === 404) return;
      throw new TransientError("Mastodon: the old scheduled post could not be removed, so nothing was changed. Try again.");
    }
    if (res.status === 404) throw new NeedsUserError("Mastodon: the post is no longer scheduled there (it went out, or it was deleted on Mastodon); nothing was changed.");
    if (!isOk(res)) throw this.api.error(res);
  }

  private async findPublished(t: Target, text: string, since: number): Promise<RemoteState | null> {
    const me = await this.api.read({ url: `${t.base}/api/v1/accounts/verify_credentials`, method: "GET", headers: t.auth });
    const id = isOk(me) ? (parseJson(me.text) as { id?: string } | null)?.id : undefined;
    if (!id) return null;
    const res = await this.api.read({ url: `${t.base}/api/v1/accounts/${enc(id)}/statuses?limit=40`, method: "GET", headers: t.auth });
    if (!isOk(res)) return null;
    const want = fingerprint(text);
    const hit = ((parseJson(res.text) as MaStatus[] | null) ?? []).find((s) => Date.parse(s.created_at) >= since - MINUTE && fingerprint(plain(s.content)) === want);
    return hit ? { published: true, remoteId: hit.id, url: hit.url ?? hit.uri } : { published: false };
  }
}
```

In `src/platforms/adapters.ts`: import `MastodonAdapter` and add `new MastodonAdapter(deps)`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms`
Expected: PASS, including every Mastodon contract scenario and the lookup scenario.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/mastodon/api.ts src/platforms/adapters.ts test/platforms/mastodon test/platforms/contract/cases.ts
git commit -m "feat(mastodon): adapter with media v2, threads, idempotency keys, scheduled_at hand-over, update, cancel and lookup (#90)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Markdown → HTML for WordPress (#92, part 1)

**Files:**
- Create: `src/platforms/wordpress/markdown.ts`, `test/platforms/wordpress/markdown.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure).
- Produces: `interface HtmlOptions { image(target: string): { src: string; alt?: string } | null }`; `markdownToHtml(md: string, opts: HtmlOptions): string`; `imageEmbeds(md: string): string[]`.

The converter covers what an Obsidian article uses: headings, paragraphs (a single newline is a line break, as in Obsidian's default), bold, italic, strikethrough, highlight, inline code, fenced code, links, bare URLs, wikilinks (their label; the target note has no address on the site), image embeds (`![[x.png]]`, `![[x.png|alt]]`, `![[x.png|300]]`, `![alt](path.png)`, remote images), callouts, blockquotes, nested lists, tables, rules and `%%comments%%`. Everything the user wrote is escaped: raw HTML shows as text and is never passed through. Note embeds and images that aren't uploaded are left out. The output uses plain, block-editor-friendly tags (`wp-block-image`, `wp-block-quote`, `wp-block-code`, `wp-block-table` classes).

- [ ] **Step 1: Write the failing tests**

Create `test/platforms/wordpress/markdown.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { imageEmbeds, markdownToHtml, type HtmlOptions } from "../../../src/platforms/wordpress/markdown";

const UPLOADED: Record<string, { src: string; alt?: string }> = {
  "cover.png": { src: "https://eventx.berlin/wp-content/uploads/2026/10/cover.png", alt: "Meta alt" },
  "img/map.png": { src: "https://eventx.berlin/wp-content/uploads/2026/10/map.png" },
};
const opts: HtmlOptions = { image: (target) => UPLOADED[target] ?? null };
const html = (md: string) => markdownToHtml(md, opts);
const COVER = "https://eventx.berlin/wp-content/uploads/2026/10/cover.png";

describe("markdownToHtml (#92)", () => {
  it("turns headings and paragraphs into HTML, a single newline into a line break", () => {
    expect(html("# Event X\n\nDoors open\nat 18:00.\n\n## Program")).toBe("<h1>Event X</h1>\n<p>Doors open<br />\nat 18:00.</p>\n<h2>Program</h2>");
    expect(html("Text\n## Heading")).toBe("<p>Text</p>\n<h2>Heading</h2>");
  });

  it("styles text inline", () => {
    expect(html("**Bold** and *it* and _it2_, ~~old~~, ==new== and `a<b>`")).toBe(
      "<p><strong>Bold</strong> and <em>it</em> and <em>it2</em>, <del>old</del>, <mark>new</mark> and <code>a&lt;b&gt;</code></p>",
    );
  });

  it("escapes raw HTML instead of passing it through", () => {
    expect(html('<script>alert("x")</script> & co')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>");
  });

  it("writes wikilinks as their label", () => {
    expect(html("See [[Event X]], [[Notes/Event X|the event]] and [[#Program]].")).toBe("<p>See Event X, the event and Program.</p>");
  });

  it("links http(s) and mailto links and bare URLs, and drops other link targets", () => {
    expect(html("[Tickets](https://event.example/t?a=1&b=2) and [bad](javascript:void)")).toBe('<p><a href="https://event.example/t?a=1&amp;b=2">Tickets</a> and bad</p>');
    expect(html("More at https://event.example/x.")).toBe('<p>More at <a href="https://event.example/x">https://event.example/x</a>.</p>');
  });

  it("turns embedded images into figures with the uploaded address and alt text", () => {
    expect(html("![[cover.png]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Meta alt" /></figure>`);
    expect(html("![[cover.png|Crowd at the door]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Crowd at the door" /></figure>`);
    expect(html("![[cover.png|300]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Meta alt" /></figure>`);
    expect(html("![A map](img/map.png)")).toBe('<figure class="wp-block-image"><img src="https://eventx.berlin/wp-content/uploads/2026/10/map.png" alt="A map" /></figure>');
    expect(html("![x](https://cdn.example/a.png)")).toBe('<figure class="wp-block-image"><img src="https://cdn.example/a.png" alt="x" /></figure>');
    expect(html("Look ![[cover.png]] here")).toBe(`<p>Look <img src="${COVER}" alt="Meta alt" /> here</p>`);
  });

  it("leaves out images that weren't uploaded and embedded notes", () => {
    expect(html("![[missing.png]]\n\n![[Other note]]\n\nText")).toBe("<p>Text</p>");
  });

  it("turns callouts and quotes into blockquotes", () => {
    expect(html("> [!tip] Bring a friend\n> Free entry for two.")).toBe(
      '<blockquote class="wp-block-quote osmm-callout osmm-callout-tip"><p><strong>Bring a friend</strong></p><p>Free entry for two.</p></blockquote>',
    );
    expect(html("> [!NOTE]\n> Hi")).toBe('<blockquote class="wp-block-quote osmm-callout osmm-callout-note"><p><strong>Note</strong></p><p>Hi</p></blockquote>');
    expect(html("> Quote line\n> more")).toBe('<blockquote class="wp-block-quote"><p>Quote line<br />\nmore</p></blockquote>');
  });

  it("nests lists and keeps ordered ones ordered", () => {
    expect(html("- One\n- Two\n  - Two a\n- Three\n\n1. First\n2. Second")).toBe("<ul><li>One</li><li>Two<ul><li>Two a</li></ul></li><li>Three</li></ul>\n<ol><li>First</li><li>Second</li></ol>");
  });

  it("keeps code blocks as escaped code", () => {
    expect(html("```ts\nconst a = 1 < 2;\n```")).toBe('<pre class="wp-block-code"><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it("builds tables", () => {
    expect(html("| Day | Time |\n| --- | ---: |\n| Thu | 18:00 |")).toBe(
      '<figure class="wp-block-table"><table><thead><tr><th>Day</th><th>Time</th></tr></thead><tbody><tr><td>Thu</td><td>18:00</td></tr></tbody></table></figure>',
    );
  });

  it("drops comments and turns a rule into <hr />", () => {
    expect(html("Visible %%hidden%% text\n\n%%\nblock\n%%\nEnd")).toBe("<p>Visible  text</p>\n<p>End</p>");
    expect(html("Before\n\n---\n\nAfter")).toBe("<p>Before</p>\n<hr />\n<p>After</p>");
  });
});

describe("imageEmbeds", () => {
  it("lists local image targets once, in order, outside comments", () => {
    expect(imageEmbeds("![[a.png]] text ![b](img/b.png) ![[a.png]] ![c](https://x.example/c.png) %%![[hidden.png]]%%")).toEqual(["a.png", "img/b.png"]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/platforms/wordpress/markdown.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the converter**

Create `src/platforms/wordpress/markdown.ts`:
```ts
export interface HtmlOptions {
  /** The uploaded address (and media_meta alt text) of an image embedded in the body; null leaves the embed out. */
  image(target: string): { src: string; alt?: string } | null;
}

interface Embed {
  target: string;
  alt: string;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SAFE_HREF = /^(https?:|mailto:)/i;
const REMOTE = /^https?:\/\//i;
/** Marks a piece of finished HTML inside text that is still to be escaped and styled. */
const PH = "\u0000";

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LONE_EMBED_RE = /^\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/;
const EMBED_ANY = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g;
const WIKI_EMBED = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/;
const MD_EMBED = /^!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)$/;

const stripComments = (md: string): string => md.replace(/%%[\s\S]*?%%/g, "");

function embedOf(e: string): Embed | null {
  const wiki = WIKI_EMBED.exec(e);
  if (wiki) {
    const label = (wiki[2] ?? "").trim();
    // `![[x.png|300]]` and `|300x200` are sizes, not alt text.
    return { target: wiki[1]!.trim(), alt: /^\d+(x\d+)?$/.test(label) ? "" : label };
  }
  const md = MD_EMBED.exec(e);
  if (!md) return null;
  let target = md[2]!;
  try {
    target = decodeURI(target);
  } catch {
    // Keep a malformed escape as written.
  }
  return { target, alt: md[1]! };
}

/** The local image targets embedded in a body, in order and once each (what the WordPress adapter uploads). */
export function imageEmbeds(md: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(md).matchAll(EMBED_ANY)) {
    const e = embedOf(m[0]);
    if (e && !REMOTE.test(e.target) && !out.includes(e.target)) out.push(e.target);
  }
  return out;
}

function img(e: Embed, opts: HtmlOptions): string | null {
  if (REMOTE.test(e.target)) return `<img src="${escapeHtml(e.target)}" alt="${escapeHtml(e.alt)}" />`;
  const found = opts.image(e.target);
  return found ? `<img src="${escapeHtml(found.src)}" alt="${escapeHtml(e.alt || found.alt || "")}" />` : null;
}

function spans(text: string, opts: HtmlOptions): string {
  const saved: string[] = [];
  const keep = (html: string): string => `${PH}${saved.push(html) - 1}${PH}`;
  const marked = text
    .replace(EMBED_ANY, (raw) => {
      const e = embedOf(raw);
      const html = e ? img(e, opts) : null;
      return html ? keep(html) : "";
    })
    .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]+))?\]\]/g, (_m, target: string, heading: string | undefined, alias: string | undefined) =>
      keep(escapeHtml((alias ?? (target.trim() ? (target.split("/").pop() ?? target) : (heading ?? ""))).trim())),
    )
    .replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?\)/g, (_m, label: string, href: string) =>
      keep(SAFE_HREF.test(href) ? `<a href="${escapeHtml(href)}">${spans(label, opts)}</a>` : spans(label, opts)),
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
      const clean = url.replace(/[.,;:!?]+$/, "");
      return keep(`<a href="${escapeHtml(clean)}">${escapeHtml(clean)}</a>`) + url.slice(clean.length);
    });
  return escapeHtml(marked)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<del>$1</del>")
    .replace(/==(?=\S)([^\n]*?\S)==/g, "<mark>$1</mark>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_m, n: string) => saved[Number(n)] ?? "");
}

function inline(raw: string, opts: HtmlOptions): string {
  return raw
    .split(/(`[^`\n]+`)/g)
    .map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : spans(part, opts)))
    .join("");
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s*>/.test(line) ||
    LIST_RE.test(line) ||
    LONE_EMBED_RE.test(line) ||
    (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? ""))
  );
}

const width = (indent: string): number => indent.replace(/\t/g, "    ").length;

function list(lines: readonly string[], start: number, opts: HtmlOptions): { html: string; next: number } {
  const first = LIST_RE.exec(lines[start]!)!;
  const indent = width(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST_RE.exec(line);
    if (!m) {
      // An indented line under an item continues it.
      if (line.trim() && /^\s+/.test(line) && items.length) {
        items[items.length - 1] += ` ${inline(line.trim(), opts)}`;
        i++;
        continue;
      }
      break;
    }
    const level = width(m[1]!);
    if (level < indent) break;
    if (level > indent && items.length) {
      const sub = list(lines, i, opts);
      items[items.length - 1] += sub.html;
      i = sub.next;
      continue;
    }
    if (/\d/.test(m[2]!) !== ordered) break;
    items.push(inline(m[3]!, opts));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`, next: i };
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function table(lines: readonly string[], start: number, opts: HtmlOptions): { html: string; next: number } {
  const head = cells(lines[start]!);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
  const th = head.map((c) => `<th>${inline(c, opts)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`).join("");
  return { html: `<figure class="wp-block-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></figure>`, next: i };
}

function quote(lines: readonly string[], opts: HtmlOptions): string {
  const callout = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[0] ?? "");
  if (!callout) return `<blockquote class="wp-block-quote">${blocks(lines, opts).join("")}</blockquote>`;
  const type = callout[1]!.toLowerCase();
  const title = callout[2]!.trim() || type.charAt(0).toUpperCase() + type.slice(1);
  return `<blockquote class="wp-block-quote osmm-callout osmm-callout-${escapeHtml(type)}"><p><strong>${inline(title, opts)}</strong></p>${blocks(lines.slice(1), opts).join("")}</blockquote>`;
}

function blocks(lines: readonly string[], opts: HtmlOptions): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) code.push(lines[i++]!);
      i++;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
      out.push(`<pre class="wp-block-code"><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const n = heading[1]!.length;
      out.push(`<h${n}>${inline(heading[2]!, opts)}</h${n}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*> ?/, ""));
      out.push(quote(quoted, opts));
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = list(lines, i, opts);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      const r = table(lines, i, opts);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const lone = LONE_EMBED_RE.exec(line);
    if (lone) {
      const e = embedOf(lone[1]!);
      const html = e ? img(e, opts) : null;
      if (html) out.push(`<figure class="wp-block-image">${html}</figure>`);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]!.trim());
    out.push(`<p>${para.map((l) => inline(l, opts)).join("<br />\n")}</p>`);
  }
  return out;
}

/** An article body (Obsidian Markdown) → HTML for the WordPress REST API (#92, spec §2.3). */
export function markdownToHtml(md: string, opts: HtmlOptions): string {
  return blocks(stripComments(md).replace(/\r\n?/g, "\n").split("\n"), opts).join("\n");
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run test/platforms/wordpress/markdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/wordpress/markdown.ts test/platforms/wordpress/markdown.test.ts
git commit -m "feat(wordpress): Markdown to block-friendly HTML with wikilinks, image embeds, callouts, lists and tables (#92)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: WordPress adapter with native scheduling (#92, part 2)

**Files:**
- Create: `src/platforms/wordpress/api.ts`, `test/platforms/wordpress/fixtures.ts`, `test/platforms/wordpress/contract.ts`, `test/platforms/wordpress/adapter.test.ts`
- Modify: `src/platforms/adapters.ts`, `test/platforms/contract/cases.ts`

**Interfaces:**
- Consumes: `markdownToHtml`, `imageEmbeds` (Task 10); `ApiClient`, `isOk`, `parseJson`, `UPLOAD_TIMEOUT_MS`, `HttpRequest` (Task 2); `readMedia`, `fileName` (Task 2); `AdapterDeps.resolveEmbed`, `EmbedFile` (Task 3); `RemoteRemovedError`, `ScheduleResult`, `SyncChange` (Task 1); `MINUTE`, `HOUR`.
- Produces: `class WordPressAdapter implements PlatformAdapter { platform: "wordpress"; minLeadMs = WP_MIN_LEAD_MS; publish; schedule; update; cancel; lookup; verify }`; `WP_MIN_LEAD_MS = MINUTE`; `gmt(at)`; `wordpressFailure(res)`; `wordpressCase`; fixtures `WP`, `WP_SITE`, `WP_PASSWORD`, `WP_AT`.

Channel setup (per site): `server` is the site address (`https://…` only), `login` the WordPress user name, and the credential an **application password** (Users → Profile → Application passwords). Requests go to `<site>/wp-json/wp/v2` with HTTP Basic auth. A `native` channel hands the article over with `status: "future"` and `date_gmt`; WordPress publishes it on time with Obsidian closed.

- [ ] **Step 1: Write the fixtures (from developer.wordpress.org/rest-api/reference: posts, media, categories, tags, users)**

Create `test/platforms/wordpress/fixtures.ts`:
```ts
export const WP_SITE = "https://eventx.berlin";
export const WP_API = `${WP_SITE}/wp-json/wp/v2`;
export const WP_PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
export const WP_BASIC = btoa(`editor:${WP_PASSWORD}`);
/** Thu 8 Oct 2026, 17:30 Berlin. */
export const WP_AT = Date.UTC(2026, 9, 8, 15, 30);

const post = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 412,
  date: "2026-10-08T10:00:00",
  date_gmt: "2026-10-08T08:00:00",
  modified_gmt: "2026-10-08T08:00:00",
  slug: "hosting-event-x-again",
  status,
  type: "post",
  link: status === "publish" ? "https://eventx.berlin/hosting-event-x-again/" : "https://eventx.berlin/?p=412",
  title: { raw: "We're hosting Event X again", rendered: "We&#8217;re hosting Event X again" },
  ...extra,
});

export const WP = {
  /** POST /wp/v2/posts → 201, GET /wp/v2/posts/:id?context=edit → 200 */
  post,
  future: () => post("future", { date: "2026-10-08T17:30:00", date_gmt: "2026-10-08T15:30:00" }),
  /** POST /wp/v2/media → 201 */
  media: (id: number, file: string) => ({ id, slug: file.replace(/\.\w+$/, ""), type: "attachment", media_type: "image", mime_type: "image/png", alt_text: "", source_url: `https://eventx.berlin/wp-content/uploads/2026/10/${file}` }),
  /** GET /wp/v2/categories?search=… (names are HTML-escaped) */
  categories: [
    { id: 5, name: "Community" },
    { id: 6, name: "Community &amp; Events" },
  ],
  createdTag: { id: 12, name: "events", slug: "events", taxonomy: "post_tag" },
  termExists: { code: "term_exists", message: "A term with the name provided already exists in this taxonomy.", data: { status: 400, term_id: 9 } },
  /** GET /wp/v2/users/me?context=edit */
  me: { id: 3, name: "Editor" },
  incorrectPassword: { code: "incorrect_password", message: "The provided password is an invalid application password.", data: { status: 401 } },
  cannotCreate: { code: "rest_cannot_create", message: "Sorry, you are not allowed to create posts as this user.", data: { status: 403 } },
  invalidParam: { code: "rest_invalid_param", message: "Invalid parameter(s): slug", data: { status: 400, params: { slug: "slug is not of type string." } } },
  critical: { code: "internal_server_error", message: "<p>There has been a critical error on this website.</p>", data: { status: 500 } },
  invalidId: { code: "rest_post_invalid_id", message: "Invalid post ID.", data: { status: 404 } },
  tooMany: { code: "too_many_requests", message: "Too many requests." },
};
```

Create `test/platforms/wordpress/contract.ts`:
```ts
import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { WP, WP_BASIC, WP_PASSWORD, WP_SITE } from "./fixtures";

const job = () => ({
  variant: {
    path: "Social/Event X/Event X – WordPress.md",
    platform: "wordpress" as const,
    channels: ["wp/eventx-berlin"],
    mode: "auto" as const,
    status: "scheduled" as const,
    title: "We're hosting Event X again",
    media: [],
    deliveries: {},
    wordpress: { slug: "hosting-event-x-again", categories: [], tags: [] },
  },
  channel: channel("wp/eventx-berlin", { kind: "site" as const, server: WP_SITE, login: "editor", method: "native" as const, secretId: "osmm-channel-wp-eventx-berlin" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1 },
  text: "Six months ago we hosted the first Event X.",
  items: ["Six months ago we hosted the first Event X."],
  media: [],
  secret: WP_PASSWORD,
});

export const wordpressCase: ContractCase = {
  platform: "wordpress",
  job,
  before: [],
  success: { post: [json(201, WP.post("publish"))], expect: { remoteId: "412", url: "https://eventx.berlin/hosting-event-x-again/" } },
  rateLimited: { post: [json(429, WP.tooMany, { "Retry-After": "30" })], retryAfterMs: 30_000 },
  authExpired: [json(401, WP.incorrectPassword)],
  forbidden: [json(403, WP.cannotCreate)],
  rejected: [json(400, WP.invalidParam)],
  serverError: [json(500, WP.critical)],
  sensitive: [WP_PASSWORD, WP_BASIC],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW, remoteId: "412" } }),
    found: [json(200, WP.post("publish"))],
    expect: { published: true, remoteId: "412", url: "https://eventx.berlin/hosting-event-x-again/" },
    notFound: [json(404, WP.invalidId)],
  },
};
```
Add `wordpressCase` to `CASES`.

- [ ] **Step 2: Write the failing tests**

Create `test/platforms/wordpress/adapter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import { RemoteRemovedError } from "../../../src/platforms/errors";
import type { DeliveryJob } from "../../../src/platforms/types";
import { WordPressAdapter } from "../../../src/platforms/wordpress/api";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW } from "../contract/harness";
import { call, json, queue, sentJson } from "../http";
import { wordpressCase } from "./contract";
import { WP, WP_API, WP_AT, WP_BASIC, WP_PASSWORD, WP_SITE } from "./fixtures";

const job = (extra: Partial<DeliveryJob> = {}): DeliveryJob => ({ ...wordpressCase.job(), ...extra });
const resolveEmbed: AdapterDeps["resolveEmbed"] = (target) => (target === "cover.png" ? { path: "Social/cover.png", name: "cover.png", mime: "image/png" } : null);
const make = () => new WordPressAdapter({ ...contractDeps(), resolveEmbed });
const handedOver = (extra: Partial<DeliveryJob["delivery"]> = {}): DeliveryJob => job({ delivery: { status: "handed_over", at: WP_AT, remoteAt: WP_AT, remoteId: "412", ...extra } });
const UPLOADS = "https://eventx.berlin/wp-content/uploads/2026/10";

describe("WordPressAdapter.publish", () => {
  it("posts the article as HTML with Basic auth", async () => {
    queue(json(201, WP.post("publish")));
    expect(await make().publish(job())).toEqual(wordpressCase.success.expect);
    expect(call(0)).toMatchObject({ url: `${WP_API}/posts`, method: "POST", contentType: "application/json", headers: { Authorization: `Basic ${WP_BASIC}` } });
    expect(sentJson(0)).toEqual({ title: "We're hosting Event X again", content: "<p>Six months ago we hosted the first Event X.</p>", status: "publish", slug: "hosting-event-x-again", categories: [], tags: [] });
  });

  it("uploads body images, extra media and the featured image, and resolves or creates categories and tags", async () => {
    queue(
      json(201, WP.media(77, "cover.png")),
      json(200, { ...WP.media(77, "cover.png"), alt_text: "Crowd" }),
      json(201, WP.media(78, "map.png")),
      json(201, WP.media(79, "hero.png")),
      json(200, WP.categories),
      json(200, []),
      json(201, WP.createdTag),
      json(201, WP.post("publish")),
    );
    const j = job({ text: "![[cover.png]]\n\nText", items: ["![[cover.png]]\n\nText"], media: [img("map.png", 1080, 1080, { alt: undefined })], featured: img("hero.png", 1080, 1080, { alt: undefined }) });
    j.variant = { ...j.variant, mediaMeta: { "cover.png": { alt: "Crowd" } }, wordpress: { slug: "hosting-event-x-again", categories: ["Community & Events"], tags: ["events"], excerpt: "Short" } };
    await make().publish(j);
    expect(call(0)).toMatchObject({ url: `${WP_API}/media`, contentType: "image/png", headers: { "Content-Disposition": 'attachment; filename="cover.png"' } });
    expect(sentJson(1)).toEqual({ alt_text: "Crowd" });
    expect(call(4).url).toBe(`${WP_API}/categories?search=Community%20%26%20Events&per_page=100&_fields=id,name`);
    expect(sentJson(6)).toEqual({ name: "events" });
    expect(sentJson(7)).toEqual({
      title: "We're hosting Event X again",
      content: `<figure class="wp-block-image"><img src="${UPLOADS}/cover.png" alt="Crowd" /></figure>\n<p>Text</p>\n<figure class="wp-block-image"><img src="${UPLOADS}/map.png" alt="" /></figure>`,
      status: "publish",
      slug: "hosting-event-x-again",
      excerpt: "Short",
      categories: [6],
      tags: [12],
      featured_media: 79,
    });
  });

  it("uses the id of a term that already exists", async () => {
    queue(json(200, []), json(400, WP.termExists), json(201, WP.post("publish")));
    const j = job();
    j.variant = { ...j.variant, wordpress: { slug: "hosting-event-x-again", categories: ["News"], tags: [] } };
    await make().publish(j);
    expect(sentJson(2).categories).toEqual([9]);
  });

  it("uploads an image once per session, so an update doesn't duplicate it", async () => {
    const adapter = make();
    const j = job({ text: "![[cover.png]]", items: ["![[cover.png]]"] });
    queue(json(201, WP.media(77, "cover.png")), json(201, WP.post("publish")), json(200, WP.post("publish")));
    await adapter.publish(j);
    await adapter.update({ ...j, delivery: { status: "published", remoteId: "412" } });
    expect(requestUrlMock.calls.map((c) => c.url)).toEqual([`${WP_API}/media`, `${WP_API}/posts`, `${WP_API}/posts/412`]);
  });

  it("on a retry, returns the article an earlier attempt already made", async () => {
    queue(json(200, [WP.post("publish")]));
    expect(await make().publish(job({ delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 2 } }))).toEqual(wordpressCase.success.expect);
    expect(call(0).url).toBe(`${WP_API}/posts?slug=hosting-event-x-again&status=publish,future,draft,pending,private&context=edit&_fields=id,link,status,date_gmt,modified_gmt`);
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("refuses a site that isn't https, or a missing user name or password, before any request", async () => {
    const http = job();
    http.channel = { ...http.channel, server: "http://eventx.berlin" };
    await expect(make().publish(http)).rejects.toThrow("wp/eventx-berlin: WordPress needs an https:// site address; application passwords only work over HTTPS.");
    const noLogin = job();
    noLogin.channel = { ...noLogin.channel, login: undefined };
    await expect(make().publish(noLogin)).rejects.toThrow("Set the WordPress user name of wp/eventx-berlin in its channel settings.");
    await expect(make().publish(job({ secret: null }))).rejects.toThrow("Add an application password for wp/eventx-berlin on this device (WordPress: Users → Profile → Application passwords).");
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});

describe("WordPressAdapter native scheduling (#92)", () => {
  it("hands the article over as a future post in UTC", async () => {
    queue(json(201, WP.future()));
    expect(await make().schedule(handedOver({ remoteId: undefined }))).toEqual({ remoteId: "412", url: "https://eventx.berlin/?p=412" });
    expect(sentJson(0)).toMatchObject({ status: "future", date_gmt: "2026-10-08T15:30:00" });
  });

  it("updates a handed-over article with its new time, and a live one without touching its status", async () => {
    queue(json(200, WP.future()), json(200, WP.post("publish")));
    await make().update(handedOver({ at: WP_AT + 3_600_000 }), { content: true, time: true });
    expect(call(0).url).toBe(`${WP_API}/posts/412`);
    expect(sentJson(0)).toMatchObject({ status: "future", date_gmt: "2026-10-08T16:30:00" });
    await make().update(job({ delivery: { status: "published", remoteId: "412" } }));
    expect(sentJson(1).status).toBeUndefined();
    expect(sentJson(1).date_gmt).toBeUndefined();
  });

  it("says the platform copy is gone when a handed-over article was deleted on the site", async () => {
    queue(json(404, WP.invalidId), json(404, WP.invalidId));
    await expect(make().update(handedOver(), { content: true, time: false })).rejects.toBeInstanceOf(RemoteRemovedError);
    await expect(make().update(job({ delivery: { status: "published", remoteId: "412" } }))).rejects.toMatchObject({ kind: "needs_user" });
  });

  it("takes a scheduled article back to draft, but never unpublishes a live one", async () => {
    queue(json(200, WP.future()), json(200, WP.post("draft")));
    await make().cancel(handedOver());
    expect(call(1)).toMatchObject({ url: `${WP_API}/posts/412`, method: "POST" });
    expect(sentJson(1)).toEqual({ status: "draft" });
    queue(json(200, WP.post("publish")));
    await expect(make().cancel(handedOver())).rejects.toThrow("WordPress: this article is already published. Unpublish it in WordPress if you want it gone.");
    expect(requestUrlMock.calls).toHaveLength(3);
  });
});

describe("WordPressAdapter.lookup", () => {
  it("reads a post's state: published, still scheduled, or gone", async () => {
    queue(json(200, WP.future()), json(200, WP.post("draft")), json(404, WP.invalidId));
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "412", scheduledAt: WP_AT });
    expect(await make().lookup(handedOver())).toEqual({ published: false, remoteId: "412", gone: true });
    expect(await make().lookup(handedOver())).toEqual({ published: false, gone: true });
  });

  it("finds an interrupted hand-over by its slug and time", async () => {
    queue(json(200, [WP.future()]));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false, remoteId: "412", scheduledAt: WP_AT });
    queue(json(200, []));
    expect(await make().lookup(handedOver({ remoteId: undefined }))).toEqual({ published: false });
  });
});

describe("WordPressAdapter.verify", () => {
  it("names the user and the site, or says what is wrong", async () => {
    queue(json(200, WP.me), json(401, WP.incorrectPassword), json(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." }));
    const channel = job().channel;
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: true, account: "Editor on eventx.berlin" });
    expect(call(0).url).toBe(`${WP_API}/users/me?context=edit&_fields=id,name`);
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: false, error: "WordPress: The provided password is an invalid application password. (HTTP 401)" });
    expect(await make().verify(channel, WP_PASSWORD)).toEqual({ ok: false, error: `No WordPress REST API at ${WP_SITE}/wp-json/. Check the site address.` });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/platforms/wordpress test/platforms/contract`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement the adapter**

Create `src/platforms/wordpress/api.ts`:
```ts
import { HOUR, MINUTE } from "../../model/dates";
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, RemoteRemovedError, TransientError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse } from "../http";
import type { DeliveryJob, PlatformAdapter, PublishResult, RemoteState, ScheduleResult, SyncChange, VerifyResult } from "../types";
import { imageEmbeds, markdownToHtml } from "./markdown";

/** A future post needs a date after "now" on the site; one minute of margin (plus the hand-over margin). */
export const WP_MIN_LEAD_MS = MINUTE;
const NEEDS_USER_CODES = new Set([
  "rest_post_invalid_id",
  "rest_cannot_edit",
  "rest_cannot_create",
  "rest_cannot_publish",
  "rest_cannot_assign_term",
  "rest_cannot_create_term",
  "rest_upload_user_quota_exceeded",
  "rest_forbidden",
  "rest_not_logged_in",
  "incorrect_password",
  "invalid_username",
  "invalid_email",
  "application_passwords_disabled",
]);
const ANY_STATUS = "publish,future,draft,pending,private";
const enc = encodeURIComponent;

interface WpPost {
  id: number;
  link: string;
  status: string;
  date_gmt?: string;
  modified_gmt?: string;
}
interface Target {
  site: string;
  api: string;
  host: string;
  auth: Record<string, string>;
}
interface Upload {
  path?: string;
  target: string;
  name: string;
  mime?: string;
  alt?: string;
}

/** WordPress dates without a zone, in UTC ("2026-10-08T15:30:00"). */
export const gmt = (at: number): string => new Date(at).toISOString().slice(0, 19);
const fromGmt = (s: string | undefined): number => (s ? Date.parse(`${s}Z`) : Number.NaN);
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** WordPress error messages and term names may contain HTML or entities. */
function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() || undefined;
}

function base64(s: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(s)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function wordpressFailure(res: HttpResponse): ApiFailure {
  const body = parseJson(res.text) as { code?: string; message?: string } | null;
  const message = plainText(body?.message) ?? `HTTP ${res.status}`;
  if (body?.code && NEEDS_USER_CODES.has(body.code)) return { message, kind: "needs_user" };
  return { message };
}

/**
 * Articles through the REST API with an application password (#92): Markdown → HTML, local images uploaded to the
 * media library, categories and tags resolved or created, `status: future` hand-over, update, cancel and lookup.
 */
export class WordPressAdapter implements PlatformAdapter {
  readonly platform = "wordpress" as const;
  readonly minLeadMs = WP_MIN_LEAD_MS;
  private readonly api: ApiClient;
  /** "<site>\n<path>\n<bytes>" → the uploaded media, for this session. */
  private readonly uploads = new Map<string, { id: number; url: string }>();
  /** "<site>\n<taxonomy>\n<name>" → term id, for this session. */
  private readonly terms = new Map<string, number>();

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "wordpress", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: wordpressFailure });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const t = this.target(job);
    if ((job.delivery.attempts ?? 1) > 1) {
      // A retry (after a 5xx, M2b P4): the earlier attempt may have created the post.
      const earlier = await this.bySlug(t, job).catch(() => null);
      if (earlier?.published && earlier.remoteId && earlier.url) return { remoteId: earlier.remoteId, url: earlier.url };
    }
    const res = await this.api.commit(this.json(t, "/posts", await this.article(t, job, "publish")));
    return this.posted(res);
  }

  async schedule(job: DeliveryJob): Promise<ScheduleResult> {
    const t = this.target(job);
    if (job.delivery.at === undefined) throw new InvalidContentError("WordPress: a scheduled article needs a time.");
    const res = await this.api.commit(this.json(t, "/posts", await this.article(t, job, "future")));
    return this.posted(res);
  }

  async update(job: DeliveryJob, _change?: SyncChange): Promise<{ remoteId?: string }> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("WordPress: this article has no id to update.");
    const handedOver = job.delivery.status === "handed_over";
    const res = await this.api.exchange("commit", this.json(t, `/posts/${enc(id)}`, await this.article(t, job, handedOver ? "future" : undefined)));
    if (res.status === 404 || res.status === 410) {
      if (handedOver) throw new RemoteRemovedError("WordPress: the article is no longer on the site (it was deleted there). It will be posted from Obsidian at its time.");
      throw new NeedsUserError("WordPress: the article is no longer on the site.");
    }
    if (!isOk(res)) throw this.api.error(res);
    return {};
  }

  async cancel(job: DeliveryJob): Promise<void> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("WordPress: this article has no id.");
    const current = await this.api.read({ url: `${t.api}/posts/${enc(id)}?context=edit&_fields=id,link,status,date_gmt`, method: "GET", headers: t.auth }).catch(() => {
      throw new TransientError("WordPress: couldn't reach the site; nothing was changed.");
    });
    if (current.status === 404 || current.status === 410) return;
    if (!isOk(current)) throw this.api.error(current);
    if ((parseJson(current.text) as WpPost | null)?.status === "publish") {
      throw new NeedsUserError("WordPress: this article is already published. Unpublish it in WordPress if you want it gone.");
    }
    await this.api.commit(this.json(t, `/posts/${enc(id)}`, { status: "draft" }));
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    try {
      const t = this.target(job);
      const id = job.delivery.remoteId;
      if (!id) return await this.bySlug(t, job);
      const res = await this.api.read({ url: `${t.api}/posts/${enc(id)}?context=edit&_fields=id,link,status,date_gmt`, method: "GET", headers: t.auth });
      if (res.status === 404 || res.status === 410) return { published: false, gone: true };
      return isOk(res) ? this.state(parseJson(res.text) as WpPost | null) : null;
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const t = this.target({ channel, secret });
      const res = await this.api.read({ url: `${t.api}/users/me?context=edit&_fields=id,name`, method: "GET", headers: t.auth }).catch(() => {
        throw new Error(`Couldn't reach ${t.host}.`);
      });
      if (res.status === 404) return { ok: false, error: `No WordPress REST API at ${t.site}/wp-json/. Check the site address.` };
      if (!isOk(res)) throw this.api.error(res);
      return { ok: true, account: `${(parseJson(res.text) as { name?: string } | null)?.name ?? channel.login ?? "user"} on ${t.host}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private target(who: Pick<DeliveryJob, "channel" | "secret">): Target {
    const { channel, secret } = who;
    const site = channel.server;
    if (!site) throw new NeedsUserError(`Set the site address (https://…) of ${channel.name} in its channel settings.`);
    if (!site.startsWith("https://")) throw new NeedsUserError(`${channel.name}: WordPress needs an https:// site address; application passwords only work over HTTPS.`);
    if (!channel.login) throw new NeedsUserError(`Set the WordPress user name of ${channel.name} in its channel settings.`);
    if (!secret) throw new NeedsUserError(`Add an application password for ${channel.name} on this device (WordPress: Users → Profile → Application passwords).`);
    return { site, api: `${site}/wp-json/wp/v2`, host: new URL(site).host, auth: { Authorization: `Basic ${base64(`${channel.login}:${secret}`)}` } };
  }

  private json(t: Target, path: string, body: Record<string, unknown>): HttpRequest {
    return { url: `${t.api}${path}`, method: "POST", headers: t.auth, contentType: "application/json", body: JSON.stringify(body) };
  }

  private posted(res: HttpResponse): PublishResult {
    const p = parseJson(res.text) as Partial<WpPost> | null;
    if (!p?.id) throw new UnknownOutcomeError("WordPress: the answer had no post id, so it is not known whether the article went out.");
    return { remoteId: String(p.id), url: p.link ?? "" };
  }

  private state(p: WpPost | null): RemoteState | null {
    if (!p?.id) return null;
    const remoteId = String(p.id);
    if (p.status === "publish") return { published: true, remoteId, url: p.link };
    if (p.status === "future") {
      const at = fromGmt(p.date_gmt);
      return { published: false, remoteId, ...(Number.isFinite(at) ? { scheduledAt: at } : {}) };
    }
    // draft, pending, private, trash: WordPress will not publish it by itself.
    return { published: false, remoteId, gone: true };
  }

  /** The post with the note's slug: for a hand-over, the one scheduled at its time; for a publish, one changed since the claim. */
  private async bySlug(t: Target, job: DeliveryJob): Promise<RemoteState | null> {
    const slug = job.variant.wordpress?.slug;
    if (!slug) return null;
    const res = await this.api.read({
      url: `${t.api}/posts?slug=${enc(slug)}&status=${ANY_STATUS}&context=edit&_fields=id,link,status,date_gmt,modified_gmt`,
      method: "GET",
      headers: t.auth,
    });
    if (!isOk(res)) return null;
    const posts = (parseJson(res.text) as WpPost[] | null) ?? [];
    const d = job.delivery;
    const hit =
      d.remoteAt !== undefined
        ? posts.find((p) => fromGmt(p.date_gmt) === d.remoteAt)
        : posts.find((p) => fromGmt(p.modified_gmt) >= (d.at ?? this.deps.now() - HOUR) - 5 * MINUTE);
    return hit ? this.state(hit) : { published: false };
  }

  private async article(t: Target, job: DeliveryJob, status?: "publish" | "future"): Promise<Record<string, unknown>> {
    const v = job.variant;
    const wp = v.wordpress;
    if (!v.title?.trim()) throw new InvalidContentError("WordPress: the article needs a title.");
    const embedded = imageEmbeds(job.text);
    const addresses = new Map<string, { src: string; alt?: string }>();
    for (const target of embedded) {
      const file = this.deps.resolveEmbed?.(target, v.path);
      if (!file) continue;
      const alt = v.mediaMeta?.[target]?.alt;
      const up = await this.upload(t, { path: file.path, target, name: file.name, mime: file.mime, ...(alt ? { alt } : {}) });
      addresses.set(target, { src: up.url, ...(alt ? { alt } : {}) });
    }
    let content = markdownToHtml(job.text, { image: (target) => addresses.get(target) ?? null });
    // media: items not embedded in the body follow the article.
    for (const m of job.media) {
      if (m.kind !== "image" || embedded.includes(m.target)) continue;
      const up = await this.upload(t, { path: m.path, target: m.target, name: fileName(m), mime: m.mime, ...(m.alt ? { alt: m.alt } : {}) });
      content += `\n<figure class="wp-block-image"><img src="${escapeAttr(up.url)}" alt="${escapeAttr(m.alt ?? "")}" /></figure>`;
    }
    const f = job.featured;
    const featured = f?.kind === "image" ? await this.upload(t, { path: f.path, target: f.target, name: fileName(f), mime: f.mime, ...(f.alt ? { alt: f.alt } : {}) }) : null;
    const categories = await this.termIds(t, "categories", wp?.categories ?? []);
    const tags = await this.termIds(t, "tags", wp?.tags ?? []);
    return {
      title: v.title,
      content,
      ...(status ? { status } : {}),
      ...(status === "future" && job.delivery.at !== undefined ? { date_gmt: gmt(job.delivery.at) } : {}),
      ...(wp?.slug ? { slug: wp.slug } : {}),
      ...(wp?.excerpt ? { excerpt: wp.excerpt } : {}),
      categories,
      tags,
      ...(featured ? { featured_media: featured.id } : {}),
    };
  }

  private async upload(t: Target, f: Upload): Promise<{ id: number; url: string }> {
    const data = await readMedia((p) => this.deps.readBinary(p), f);
    const key = `${t.site}\n${f.path ?? f.target}\n${data.byteLength}`;
    const cached = this.uploads.get(key);
    if (cached) return cached;
    const name = f.name.replace(/[^\w.-]+/g, "-") || "image";
    const res = await this.api.prepare({
      url: `${t.api}/media`,
      method: "POST",
      headers: { ...t.auth, "Content-Disposition": `attachment; filename="${name}"` },
      contentType: f.mime ?? "application/octet-stream",
      body: data,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const media = parseJson(res.text) as { id?: number; source_url?: string } | null;
    if (!media?.id || !media.source_url) throw new TransientError("WordPress: the upload answer had no media id; nothing was posted.");
    // Alt text is set on the media item; if that fails, the article still goes out.
    if (f.alt) await this.api.prepare(this.json(t, `/media/${media.id}`, { alt_text: f.alt })).catch(() => undefined);
    const up = { id: media.id, url: media.source_url };
    this.uploads.set(key, up);
    return up;
  }

  private async termIds(t: Target, taxonomy: "categories" | "tags", names: readonly string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const key = `${t.site}\n${taxonomy}\n${name.toLowerCase()}`;
      let id = this.terms.get(key);
      if (id === undefined) {
        const res = await this.api.prepare({ url: `${t.api}/${taxonomy}?search=${enc(name)}&per_page=100&_fields=id,name`, method: "GET", headers: t.auth });
        const found = ((parseJson(res.text) as Array<{ id: number; name: string }> | null) ?? []).find((term) => (plainText(term.name) ?? term.name).toLowerCase() === name.toLowerCase());
        id = found?.id ?? (await this.createTerm(t, taxonomy, name));
        this.terms.set(key, id);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private async createTerm(t: Target, taxonomy: "categories" | "tags", name: string): Promise<number> {
    const res = await this.api.exchange("prepare", this.json(t, `/${taxonomy}`, { name }));
    const body = parseJson(res.text) as { id?: number; code?: string; data?: { term_id?: number } } | null;
    if (isOk(res) && body?.id) return body.id;
    if (body?.code === "term_exists" && body.data?.term_id) return body.data.term_id;
    throw isOk(res) ? new TransientError("WordPress: the new category or tag has no id; nothing was posted.") : this.api.error(res);
  }
}
```

In `src/platforms/adapters.ts`: import `WordPressAdapter` and add `new WordPressAdapter(deps)`. The list is now Telegram, Discord, Bluesky, Mastodon, WordPress.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/platforms`
Expected: PASS, including every WordPress contract scenario and the lookup scenario.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/platforms/wordpress/api.ts src/platforms/adapters.ts test/platforms/wordpress test/platforms/contract/cases.ts
git commit -m "feat(wordpress): REST adapter with media uploads, taxonomies, future-post hand-over, update, cancel and lookup (#92)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Channel setup for the API platforms: fields, methods, Test connection, Find chat id

**Files:**
- Modify: `src/settings/ChannelForm.svelte`, `src/publish/actions.ts` (`verifyChannel`, `canVerify`, `findTelegramChats`, `VERIFY_TIMEOUT_MS`), `test/settings/channelForm.test.ts`

**Interfaces:**
- Consumes: `Channel.server/login/postAsName/postAsAvatar`, `zChannel`, `zodIssues` (Task 1); `PlatformAdapter.verify`, `VerifyResult` (Task 1); `TelegramAdapter.findChats`, `TelegramChat` (Task 5); `platformDef`; `withTimeout`.
- Produces:
  - `PublishActions.verifyChannel(channel: Channel): Promise<VerifyResult>` (never throws, redacts the channel's secret, times out after `VERIFY_TIMEOUT_MS = 20_000`).
  - `PublishActions.canVerify(platform: Platform): boolean`.
  - `PublishActions.findTelegramChats(secretId: string): Promise<TelegramChat[] | { error: string }>`.
  - ChannelForm: platform-specific fields ("Chat id (@name or -100…)", "Server (optional)", "PDS (optional)", "Site address (https://…)", "User name", "Post as name (optional)", "Post as avatar URL (optional)"), a credential hint per platform, "Publishing" options limited to what the platform supports, **Test connection** and (Telegram) **Find chat id**.

- [ ] **Step 1: Write the failing tests**

Append to `test/settings/channelForm.test.ts` (add imports: `import { TelegramAdapter } from "../../src/platforms/telegram/api";`, `import { contractDeps } from "../platforms/contract/harness";`, `import { json, queue } from "../platforms/http";`, `import { TG, TG_TOKEN } from "../platforms/telegram/fixtures";`), inside `describe("ChannelForm", …)`:
```ts
  const pick = (value: string) => fireEvent.change(screen.getByLabelText("Platform"), { target: { value } });
  const methods = () => [...(screen.getByLabelText("Publishing") as HTMLSelectElement).options].map((o) => o.value);

  it("offers only the publishing methods the platform supports (M5)", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("hackernews");
    expect(methods()).toEqual(["assisted"]);
    await pick("telegram");
    expect(methods()).toEqual(["api", "assisted"]);
    await pick("wordpress");
    expect(methods()).toEqual(["api", "native", "assisted"]);
  });

  it("saves a WordPress site address and user name, and refuses a site without https", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("wordpress");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Event X blog" } });
    await fireEvent.input(screen.getByLabelText("Site address (https://…)"), { target: { value: "http://eventx.berlin" } });
    await fireEvent.input(screen.getByLabelText("User name"), { target: { value: "editor" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("server: Use an https:// address");
    await fireEvent.input(screen.getByLabelText("Site address (https://…)"), { target: { value: "https://eventx.berlin/" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("wp/event-x-blog")).toMatchObject({ server: "https://eventx.berlin", login: "editor" });
  });

  it("saves Discord's post-as name and avatar", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("discord");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "News" } });
    await fireEvent.input(screen.getByLabelText("Post as name (optional)"), { target: { value: "Event X" } });
    await fireEvent.input(screen.getByLabelText("Post as avatar URL (optional)"), { target: { value: "https://event.example/logo.png" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("dc/news")).toMatchObject({ postAsName: "Event X", postAsAvatar: "https://event.example/logo.png" });
  });

  it("tests the connection with this device's credential, and never shows the secret", async () => {
    const c = await makeCtx({ seed: true });
    c.app.secretStorage.setSecret("osmm-channel-tg-event-x", "SECRET-TOKEN-1234");
    c.adapters.register({ platform: "telegram", verify: async (_channel, secret) => ({ ok: false, error: `Telegram refused ${secret ?? ""}` }) });
    const channel = { ...c.ctx.channels.get("tg/event-x")!, handle: "@eventx", secretId: "osmm-channel-tg-event-x" };
    render(ChannelForm, { props: { channel, close: () => {} }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toBe("Telegram refused •••");
  });

  it("shows the account when the connection works", async () => {
    const c = await makeCtx({ seed: true });
    c.adapters.register({ platform: "telegram", verify: async () => ({ ok: true, account: "Event X, posting as @osmm_bot" }) });
    render(ChannelForm, { props: { channel: c.ctx.channels.get("tg/event-x")!, close: () => {} }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toBe("Connected: Event X, posting as @osmm_bot");
  });

  it("has no Test connection where the plugin has no API adapter", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("hackernews");
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("finds a Telegram chat id from what the bot has seen", async () => {
    const c = await makeCtx({ seed: true });
    c.app.secretStorage.setSecret("osmm-channel-tg-event-x", TG_TOKEN);
    c.adapters.register(new TelegramAdapter(contractDeps()));
    const channel = { ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" };
    render(ChannelForm, { props: { channel, close: () => {} }, context: osmmContext(c.ctx) });
    queue(json(200, TG.getUpdates));
    await fireEvent.click(screen.getByRole("button", { name: "Find chat id" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use Event X (@eventx)" }));
    expect((screen.getByLabelText("Chat id (@name or -100…)") as HTMLInputElement).value).toBe("@eventx");
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/settings/channelForm.test.ts`
Expected: FAIL (no such labels or buttons; `verifyChannel` missing).

- [ ] **Step 3: Add the PublishActions helpers**

In `src/publish/actions.ts`, import `withTimeout` from `../util/time`, `type Platform` from `../model/platforms`, `type VerifyResult` from `../platforms/types` and `TelegramAdapter, type TelegramChat` from `../platforms/telegram/api`, then add:
```ts
/** How long "Test connection" waits for the platform. */
export const VERIFY_TIMEOUT_MS = 20_000;
```
and, in the class:
```ts
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
```

- [ ] **Step 4: Update the channel form**

Replace the `<script>` of `src/settings/ChannelForm.svelte`:
```svelte
<script lang="ts">
  import { untrack } from "svelte";
  import { PLATFORMS, PLATFORM_META, type Platform } from "../model/platforms";
  import { CHANNEL_KINDS, PUBLISH_METHODS, zChannel, zodIssues } from "../model/schemas";
  import type { Channel, Issue } from "../model/types";
  import { platformDef } from "../platforms/registry";
  import type { TelegramChat } from "../platforms/telegram/api";
  import { useOsmm } from "../ui/context";
  import { secretField } from "../ui/secretField";
  import { PLATFORM_COLORS } from "../ui/colors";

  let { channel, close }: { channel?: Channel; close: () => void } = $props();
  const { app, channels, publish } = useOsmm();
  /** Snapshot the prop once: this form only ever initializes from it, never reacts to later changes. */
  const initial = untrack(() => channel);
  const editing = !!initial;

  let platform = $state<Platform>(initial?.platform ?? "linkedin");
  let name = $state(initial?.name ?? "");
  let id = $state(initial?.id ?? "");
  let idTouched = $state(editing);
  let kind = $state(initial?.kind ?? "profile");
  let handle = $state(initial?.handle ?? "");
  let method = $state(initial?.method ?? "assisted");
  let avatarColor = $state(initial?.avatarColor ?? PLATFORM_COLORS.linkedin);
  let defaultTime = $state(initial?.defaultTime ?? "");
  let secretId = $state(initial?.secretId ?? "");
  let maxChars = $state<number | null | undefined>(initial?.maxChars);
  let server = $state(initial?.server ?? "");
  let login = $state(initial?.login ?? "");
  let postAsName = $state(initial?.postAsName ?? "");
  let postAsAvatar = $state(initial?.postAsAvatar ?? "");
  let issues = $state<Issue[]>([]);
  let testing = $state(false);
  let testResult = $state("");
  let chats = $state<TelegramChat[]>([]);
  let chatNote = $state("");

  $effect(() => {
    if (!idTouched) id = name.trim() ? channels.suggestId(platform, name) : "";
  });

  const KIND_LABEL: Record<string, string> = { profile: "Profile", page: "Page", group: "Group", server_channel: "Server channel", site: "Website", account: "Account" };
  const METHOD_LABEL: Record<string, string> = { api: "API (auto-post)", native: "API with native scheduling", assisted: "Assisted (remind + open)" };
  const HANDLE_LABEL: Partial<Record<Platform, string>> = {
    telegram: "Chat id (@name or -100…)",
    mastodon: "Handle (@you@your.instance)",
    bluesky: "Handle (you.bsky.social)",
  };
  const SERVER_LABEL: Partial<Record<Platform, string>> = { mastodon: "Server (optional)", bluesky: "PDS (optional)", wordpress: "Site address (https://…)" };
  const CREDENTIAL_HINT: Partial<Record<Platform, string>> = {
    telegram: "The bot token from @BotFather. The bot must be an admin of the channel that can post messages.",
    discord: "The channel's webhook URL (Server settings → Integrations → Webhooks → Copy Webhook URL).",
    mastodon: "An access token (Preferences → Development → New application, scopes read and write).",
    bluesky: "An app password (Settings → Privacy and security → App passwords), not your account password.",
    wordpress: "An application password (Users → Profile → Application passwords).",
  };

  const def = $derived(platformDef(platform));
  /** Only what the platform can do: native scheduling needs nativeSchedule, the API needs an API (spec §4.2). */
  const methods = $derived(PUBLISH_METHODS.filter((m) => m === "assisted" || (m === "api" && def.capabilities.api) || (m === "native" && def.capabilities.nativeSchedule)));
  $effect(() => {
    if (!methods.includes(method)) method = "assisted";
  });

  function input(): Record<string, unknown> {
    return {
      id: editing ? initial!.id : id,
      platform,
      name,
      kind,
      handle: handle || undefined,
      method,
      avatarColor,
      defaultTime: defaultTime || undefined,
      secretId: secretId || undefined,
      defaultReminders: initial?.defaultReminders,
      maxChars: platform === "mastodon" && maxChars ? maxChars : undefined,
      server: SERVER_LABEL[platform] && server.trim() ? server.trim() : undefined,
      login: platform === "wordpress" && login.trim() ? login.trim() : undefined,
      postAsName: platform === "discord" && postAsName.trim() ? postAsName.trim() : undefined,
      postAsAvatar: platform === "discord" && postAsAvatar.trim() ? postAsAvatar.trim() : undefined,
    };
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // Editing never renames (that would orphan notes using the old id); adding never overwrites.
    const result = editing ? await channels.upsertChannel(input()) : await channels.createChannel(input());
    if (!result.ok) {
      issues = result.issues;
      return;
    }
    close();
  }

  async function testConnection(): Promise<void> {
    testResult = "";
    const parsed = zChannel.safeParse(input());
    if (!parsed.success) {
      issues = zodIssues(parsed.error);
      return;
    }
    issues = [];
    testing = true;
    const answer = await publish.verifyChannel(parsed.data);
    testing = false;
    testResult = answer.ok ? `Connected: ${answer.account}` : answer.error;
  }

  async function findChats(): Promise<void> {
    chats = [];
    chatNote = "";
    const found = await publish.findTelegramChats(secretId);
    if ("error" in found) chatNote = found.error;
    else if (!found.length) chatNote = "No channels yet. Add the bot to the channel as an admin, post something there, then try again.";
    else chats = found;
  }

  function useChat(c: TelegramChat): void {
    handle = c.username ? `@${c.username}` : c.id;
    chats = [];
  }
</script>
```

In the markup, replace the `Handle / URL` label and the `Publishing` select, and add the new fields and buttons:
```svelte
  <label>{HANDLE_LABEL[platform] ?? "Handle / URL"}<input type="text" bind:value={handle} /></label>
  {#if platform === "telegram"}
    <div class="osmm-row">
      <button type="button" disabled={!secretId} onclick={() => void findChats()}>Find chat id</button>
      {#if chatNote}<span class="osmm-progress" role="status">{chatNote}</span>{/if}
    </div>
    {#if chats.length}
      <div class="osmm-chips" role="group" aria-label="Channels the bot can see">
        {#each chats as c (c.id)}
          <button type="button" onclick={() => useChat(c)}>Use {c.title}{c.username ? ` (@${c.username})` : ""}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if SERVER_LABEL[platform]}
    <label>{SERVER_LABEL[platform]}<input type="url" placeholder="https://" bind:value={server} /></label>
  {/if}
  {#if platform === "wordpress"}
    <label>User name<input type="text" autocomplete="off" bind:value={login} /></label>
  {/if}
  {#if platform === "discord"}
    <label>Post as name (optional)<input type="text" bind:value={postAsName} /></label>
    <label>Post as avatar URL (optional)<input type="url" placeholder="https://" bind:value={postAsAvatar} /></label>
  {/if}
  {#if platform === "mastodon"}
    <label>Character limit<input type="number" min="1" max="100000" placeholder="500" bind:value={maxChars} /></label>
  {/if}
  <label>
    Publishing
    <select bind:value={method}>{#each methods as m (m)}<option value={m}>{METHOD_LABEL[m]}</option>{/each}</select>
  </label>
```
and replace the credential block with:
```svelte
  <div>
    <span>Credential (stored only on this device)</span>
    {#if CREDENTIAL_HINT[platform]}<p class="osmm-progress">{CREDENTIAL_HINT[platform]}</p>{/if}
    <div use:secretField={{ app, value: secretId, onchange: (v) => (secretId = v) }}></div>
  </div>
  {#if publish.canVerify(platform)}
    <div class="osmm-row">
      <button type="button" disabled={testing} onclick={() => void testConnection()}>Test connection</button>
      {#if testResult}<span class="osmm-progress" role="status">{testResult}</span>{/if}
    </div>
  {/if}
```
(Keep the Platform select, Name, Channel id, Kind, Colour, Default time, the issues list and the Save/Cancel buttons as they are; the old `Character limit` block moves into the place shown above.)

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/settings test/main.test.ts`
Expected: PASS (the main test's list of settings names still finds "Publishing").

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/settings/ChannelForm.svelte src/publish/actions.ts test/settings/channelForm.test.ts
git commit -m "feat(settings): per-platform connection fields, supported methods only, Test connection and Telegram chat id discovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Native hand-over engine: claim, schedule, settle, startup check and late successes (#90, #92, #66)

**Files:**
- Create: `src/publish/handover.ts`, `test/publish/handover.test.ts`
- Modify: `src/publish/actions.ts` (constructor, `handover`, `background`, `isInFlight`, `markCheckNeeded`, `resolveCheck`), `src/publish/orchestrator.ts` (`LATE_SUCCESS_WINDOW_MS`), `src/scheduler/scheduler.ts` (`SchedulerPort.background`, call in `tick`), `src/scheduler/reconcile.ts`, `test/scheduler/reconcile.test.ts`, `test/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `deliveryJob` (Task 1), `contentDigest` (Task 1), `PlatformAdapter.schedule/scheduleRefusal/lookup/minLeadMs`, `RemoteState.scheduledAt/gone` (Task 1), `transition` with `check_needed → handed_over` (Task 1); `expandRows`, `heldForReview`; `effectiveMethod`; `effectiveDelivery`, `unreadable`; `blocking`; `FailureInfo`, `PublishedInfo`, `LOOKUP_TIMEOUT_MS` (orchestrator); `openMarkdownView` (`src/composer/session.ts`).
- Produces:
  - `HANDOVER_MARGIN_MS = 2 * MINUTE`, `HANDOVER_BACKOFF_MS = [1, 5, 15 min]`, `SETTLE_AFTER_MS = 3 * MINUTE`, `SETTLE_EVERY_MS = 15 * MINUTE`, `CONFIRM_WITHIN_MS = 24 * HOUR`, `MAX_PER_RUN = 10`.
  - `handOverCandidates(variants, adapters, channels, now, defaultStagger): HandOverCandidate[]`, `settleCandidates(variants, now, defaultStagger): SettleCandidate[]`.
  - `interface HandOverDeps { writer; index; channels; adapters; secrets; content; check(v, content): Issue[]; flush(path): Promise<void>; log; now(); isPublisher(); defaultStaggerMinutes(); warn(message); onFailure(info); onPublished?(info); lookupTimeoutMs? }`.
  - `class HandOverService { isInFlight(path, channelId): boolean; run(): Promise<void>; handOver(path, channelId, at): Promise<HandOverOutcome>; settle(path, channelId): Promise<void> }`, `type HandOverOutcome = "handed_over" | "check_needed" | "published" | "kept" | "refused"`.
  - `PublishActions.handover: HandOverService`; `PublishActions.background(now: number): void`.
  - `SchedulerPort.background?(now: number): void`, called by `Scheduler.tick()` after the dispatch loop, only while the tick is current and on the publisher.
  - `LATE_SUCCESS_WINDOW_MS = 15 * MINUTE` (orchestrator.ts).

State flow (spec §5): `scheduled` → **claim** writes `handed_over` with `at` = `remote_at` = the due time, `digest` and `attempts`, without `remote_id` → `adapter.schedule()` → `remote_id` written (still `handed_over`). A definite failure returns the delivery to `scheduled`, with the reason in `error` and without `remote_at`/`digest`. An unknown outcome parks it on `check_needed`, then runs `lookup()`: if the post is found on the platform's schedule it returns to `handed_over`, if found published it becomes `published`, otherwise it stays for the user. After the platform time, `settle()` asks `lookup()` again: `published` → `published`, still scheduled → keep (and record a changed `remote_at`), `gone` → `failed`, no answer for 24 h → `check_needed`.

- [ ] **Step 1: Write the failing tests**

Create `test/publish/handover.test.ts`:
```ts
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { formatDateTime, HOUR, MINUTE } from "../../src/model/dates";
import { NeedsUserError, TransientError } from "../../src/platforms/errors";
import type { PlatformAdapter, RemoteState } from "../../src/platforms/types";
import { handOverCandidates, HandOverService, type HandOverDeps } from "../../src/publish/handover";
import type { FailureInfo, PublishedInfo } from "../../src/publish/orchestrator";
import { contentDigest } from "../../src/publish/sync";
import { Secrets } from "../../src/secrets/secrets";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + HOUR;
const BODY = "Doors open at 18:00";
const note = (delivery: Record<string, unknown> = { status: "scheduled" }, extra: Record<string, unknown> = {}, body = BODY) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": delivery }, ...extra },
  body,
});

async function fm(c: TestCtx): Promise<{ deliveries: Record<string, Record<string, unknown>> }> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as never;
}

async function setup(adapter: Partial<PlatformAdapter>, opts: { note?: ReturnType<typeof note>; publisher?: () => boolean; deps?: Partial<HandOverDeps> } = {}) {
  const c = await makeCtx({ seed: true, notes: [opts.note ?? note()] });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native", handle: "@you@mastodon.social", secretId: "osmm-channel-ma-you" });
  c.app.secretStorage.setSecret("osmm-channel-ma-you", "MASTODON-TOKEN-1234");
  const full = { platform: "mastodon" as const, minLeadMs: 5 * MINUTE, schedule: vi.fn(async () => ({ remoteId: "3221" })), publish: vi.fn(), update: vi.fn(), lookup: vi.fn(async (): Promise<RemoteState | null> => null), ...adapter };
  c.adapters.register(full);
  const failures: FailureInfo[] = [];
  const published: PublishedInfo[] = [];
  const warnings: string[] = [];
  const service = new HandOverService({
    writer: c.writer,
    index: c.index,
    channels: c.ctx.channels,
    adapters: c.adapters,
    secrets: new Secrets(c.app as never),
    content: c.ctx.composer.content,
    check: (v, content) => c.ctx.composer.check(v, content),
    flush: async () => undefined,
    log: c.log,
    now: () => get(c.now),
    isPublisher: opts.publisher ?? (() => true),
    defaultStaggerMinutes: () => 0,
    warn: (m) => void warnings.push(m),
    onFailure: (f) => void failures.push(f),
    onPublished: (p) => void published.push(p),
    ...opts.deps,
  });
  return { c, adapter: full, service, failures, published, warnings };
}

describe("handOverCandidates", () => {
  it("lists scheduled native deliveries at least the lead plus the margin ahead, and nothing else", async () => {
    const c = await makeCtx({
      seed: true,
      notes: [
        { ...note(), path: "Social/Posts/Far.md" },
        { ...note({ status: "scheduled" }, { scheduled_at: formatDateTime(TEST_NOW + 6 * MINUTE) }), path: "Social/Posts/Soon.md" },
        { ...note({ status: "scheduled" }, { mode: "assisted" }), path: "Social/Posts/Assisted.md" },
        { ...note({ status: "scheduled" }, { review: "claude" }), path: "Social/Posts/Held.md" },
        { ...note({ status: "handed_over", remote_id: "1" }), path: "Social/Posts/Done.md" },
      ],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native" });
    c.adapters.register({ platform: "mastodon", minLeadMs: 5 * MINUTE, schedule: async () => ({ remoteId: "1" }) });
    expect(handOverCandidates(c.index.variants(), c.adapters, c.ctx.channels, TEST_NOW, 0)).toEqual([{ path: "Social/Posts/Far.md", channelId: "ma/you", at: AT }]);
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "api" });
    expect(handOverCandidates(c.index.variants(), c.adapters, c.ctx.channels, TEST_NOW, 0)).toEqual([]);
  });
});

describe("HandOverService.handOver", () => {
  it("writes handed_over with remote_at and digest before the call, and the remote id after", async () => {
    const seen: { fm?: unknown } = {};
    const ref: { c?: TestCtx } = {};
    const { c, service, adapter } = await setup({
      schedule: vi.fn(async () => {
        seen.fm = (await fm(ref.c!)).deliveries["ma/you"];
        return { remoteId: "3221" };
      }),
    });
    ref.c = c;
    await service.run();
    const digest = contentDigest(c.index.getVariant(P)!, BODY);
    expect(seen.fm).toEqual({ status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), digest, attempts: 1 });
    expect(adapter.schedule).toHaveBeenCalledOnce();
    expect((await fm(c)).deliveries["ma/you"]).toEqual({ status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), digest, attempts: 1, remote_id: "3221" });
    expect(c.log.entries.at(-1)).toMatchObject({ path: P, channelId: "ma/you", result: "handed_over" });
  });

  it("does nothing on a device that is not the publisher", async () => {
    const { service, adapter } = await setup({}, { publisher: () => false });
    await service.run();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });

  it("never hands over a thread the platform can't schedule, and never asks again for the same time", async () => {
    const { service, adapter } = await setup({ scheduleRefusal: () => "Mastodon can't schedule a thread." }, { note: note({ status: "scheduled" }, {}, "One\n---\nTwo") });
    await service.run();
    await service.run();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });

  it("refuses to hand over a note that changed while it was being read (M2b P3)", async () => {
    const box: { c?: TestCtx } = {};
    const { c, service, adapter } = await setup(
      {},
      {
        deps: {
          content: {
            load: async (v) => {
              const loaded = await box.c!.ctx.composer.content.load(v);
              await box.c!.writer.updateVariant(v.file, () => ({ fields: { title: "Changed meanwhile" } }));
              return loaded;
            },
          },
        },
      },
    );
    box.c = c;
    expect(await service.handOver(P, "ma/you", AT)).toBe("refused");
    expect(adapter.schedule).not.toHaveBeenCalled();
    expect((await fm(c)).deliveries["ma/you"]!.status).toBe("scheduled");
  });

  it("puts it back to scheduled after a transient failure, and tries again after a minute", async () => {
    const { c, service, adapter } = await setup({ schedule: vi.fn(async () => Promise.reject(new TransientError("Mastodon: Service Unavailable (HTTP 503)"))) });
    await service.run();
    const d = (await fm(c)).deliveries["ma/you"]!;
    expect(d).toMatchObject({ status: "scheduled", error: "Not handed over to Mastodon: Mastodon: Service Unavailable (HTTP 503) It stays scheduled and goes out from Obsidian at its time." });
    expect(d.remote_at).toBeUndefined();
    expect(d.digest).toBeUndefined();
    expect(c.log.entries.at(-1)).toMatchObject({ result: "handover_failed" });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "scheduled");
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(1);
    c.now.set(TEST_NOW + MINUTE);
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(2);
  });

  it("warns once and stops trying after a needs-user failure", async () => {
    const { c, service, adapter, warnings } = await setup({ schedule: vi.fn(async () => Promise.reject(new NeedsUserError("Mastodon: The access token is invalid (HTTP 401)"))) });
    await service.run();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "scheduled");
    c.now.set(TEST_NOW + 30 * MINUTE);
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(["Doors open at 18:00: not handed over to Mastodon (Mastodon: The access token is invalid (HTTP 401)). It stays scheduled and goes out from Obsidian at its time, if this device is on."]);
  });

  it("parks an unanswered hand-over on check_needed, and returns it to handed_over when lookup finds it (M2b P4)", async () => {
    const lookup = vi.fn(async (): Promise<RemoteState | null> => ({ published: false, remoteId: "3221", scheduledAt: AT }));
    const { c, service, adapter } = await setup({ schedule: vi.fn(async () => Promise.reject(new Error("net::ERR_CONNECTION_RESET"))), lookup });
    expect(await service.handOver(P, "ma/you", AT)).toBe("handed_over");
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ delivery: expect.objectContaining({ status: "handed_over", remoteAt: AT }) }));
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "handed_over", remote_id: "3221", remote_at: formatDateTime(AT) });
    expect(adapter.schedule).toHaveBeenCalledOnce();
  });

  it("leaves an unanswered hand-over that lookup can't find to the user, and never sends it again", async () => {
    const { c, service, adapter, failures } = await setup({ schedule: vi.fn(async () => Promise.reject(new Error("timeout"))), lookup: vi.fn(async () => ({ published: false })) });
    expect(await service.handOver(P, "ma/you", AT)).toBe("check_needed");
    expect(failures).toEqual([{ path: P, channelId: "ma/you", kind: "unknown", error: "timeout" }]);
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.status === "check_needed");
    await service.run();
    expect(adapter.schedule).toHaveBeenCalledOnce();
  });
});

describe("edits after a hand-over (#66, review focus 3)", () => {
  it("never pushes an out-of-sync delivery by itself", async () => {
    const { service, adapter } = await setup({}, { note: note({ status: "handed_over", at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), remote_id: "3221", digest: "old" }, {}, "Edited text") });
    await service.run();
    expect(adapter.update).not.toHaveBeenCalled();
    expect(adapter.schedule).not.toHaveBeenCalled();
  });
});

describe("HandOverService.settle", () => {
  const past = (extra: Record<string, unknown> = {}) => note({ status: "handed_over", at: formatDateTime(TEST_NOW - 10 * MINUTE), remote_at: formatDateTime(TEST_NOW - 10 * MINUTE), remote_id: "3221", digest: "d", ...extra });

  it("marks the post published at its platform time once the platform has it", async () => {
    const { c, service, published } = await setup({ lookup: vi.fn(async () => ({ published: true, remoteId: "9001", url: "https://mastodon.social/@you/9001" })) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "published", at: formatDateTime(TEST_NOW - 10 * MINUTE), url: "https://mastodon.social/@you/9001", remote_id: "9001" });
    expect(published).toEqual([{ path: P, channelId: "ma/you", url: "https://mastodon.social/@you/9001" }]);
    expect(c.log.entries.at(-1)).toMatchObject({ result: "published", url: "https://mastodon.social/@you/9001" });
  });

  it("records a time changed on the platform, and asks again only after 15 minutes", async () => {
    const lookup = vi.fn(async () => ({ published: false, remoteId: "3221", scheduledAt: TEST_NOW + 30 * MINUTE }));
    const { c, service } = await setup({ lookup }, { note: past() });
    await service.run();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.remoteAt === TEST_NOW + 30 * MINUTE);
    await service.run();
    expect(lookup).toHaveBeenCalledTimes(1);
    // 40 minutes on: past the new platform time (plus SETTLE_AFTER_MS) and past SETTLE_EVERY_MS since the last question.
    c.now.set(TEST_NOW + 40 * MINUTE);
    await service.run();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("fails a post the platform no longer has, and tells the user", async () => {
    const { c, service, failures } = await setup({ lookup: vi.fn(async () => ({ published: false, gone: true })) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "failed", error: "It is no longer scheduled on Mastodon, and it was not posted." });
    expect(failures.map((f) => f.kind)).toEqual(["needs_user"]);
  });

  it("asks the user after a day without an answer", async () => {
    const { c, service, failures } = await setup({ lookup: vi.fn(async () => null) }, { note: past() });
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]!.status).toBe("handed_over");
    c.now.set(TEST_NOW + 25 * HOUR);
    await service.run();
    expect((await fm(c)).deliveries["ma/you"]).toMatchObject({ status: "check_needed", error: "Mastodon hasn't confirmed this post a day after its time. Check Mastodon, then mark it as published or not." });
    expect(failures.map((f) => f.kind)).toEqual(["unknown"]);
  });
});
```

Append to `test/scheduler/reconcile.test.ts`:
- Change the helper to take the time: `async function withLookup(lookup: () => Promise<RemoteState | null>, now = T + 10 * MIN)` and use `now` in `makeCtx`.
- Change "marks it failed when lookup() finds nothing" to call `withLookup(async () => ({ published: false }), T + 20 * MIN)` (the claim is 20 minutes old; M3 P11).
- Add:
```ts
  it("keeps a recent interrupted publish on check_needed when lookup() finds nothing (M3 P11)", async () => {
    const { c } = await withLookup(async () => ({ published: false }));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.error?.startsWith("Not found on the platform yet") === true);
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]!.status).toBe("check_needed");
    expect(c.log.entries.map((e) => e.result)).toEqual(["check_needed"]);
  });

  it("checks an interrupted hand-over at startup and returns it to handed_over when the platform has it (M5)", async () => {
    const M = "Social/Posts/Ma.md";
    const c = await makeCtx({
      notes: [{ path: M, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(T + 60 * MIN), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(T + 60 * MIN), remote_at: formatDateTime(T + 60 * MIN), digest: "d" } } }, body: "Hi" }],
      now: T,
    });
    const schedule = vi.fn(async () => ({ remoteId: "x" }));
    c.adapters.register({ platform: "mastodon", schedule, lookup: async () => ({ published: false, remoteId: "3221", scheduledAt: T + 60 * MIN }) });
    expect(await scheduler(c).reconcile()).toMatchObject({ checkNeeded: 1 });
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.remoteId === "3221");
    expect(c.index.getVariant(M)!.deliveries["ma/you"]).toMatchObject({ status: "handed_over", remoteAt: T + 60 * MIN });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("leaves an interrupted hand-over the platform doesn't have to the user", async () => {
    const M = "Social/Posts/Ma.md";
    const c = await makeCtx({
      notes: [{ path: M, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(T + 60 * MIN), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(T + 60 * MIN), remote_at: formatDateTime(T + 60 * MIN), digest: "d" } } }, body: "Hi" }],
      now: T + 60 * MIN,
    });
    c.adapters.register({ platform: "mastodon", schedule: async () => ({ remoteId: "x" }), lookup: async () => ({ published: false }) });
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.error?.startsWith("Not found in the platform's scheduled posts") === true);
    expect(c.index.getVariant(M)!.deliveries["ma/you"]!.status).toBe("check_needed");
  });
```
- In `describe("reconcilePlan", …)`, add a note `note("Social/Posts/Handing.md", T + 60 * MIN, { status: "handed_over", at: formatDateTime(T + 60 * MIN) })` and a note `note("Social/Posts/Handed.md", T + 60 * MIN, { status: "handed_over", remote_id: "7" })` to the first test's notes, and `"check_needed:Social/Posts/Handing.md"` to its expected list (the one with a `remote_id` is left alone).

Append to `test/scheduler/scheduler.test.ts`:
```ts
describe("background hand-over (M5)", () => {
  it("starts the background pass after the due items, on the publisher only", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const order: string[] = [];
    const background = vi.fn(() => void order.push("background"));
    let publisher = true;
    const port = {
      dispatch: async () => void order.push("dispatch"),
      markOverdue: async () => undefined,
      markCheckNeeded: async () => false,
      resolveCheck: async () => undefined,
      background,
    };
    const { scheduler } = await build(c, { publish: port, isPublisher: () => publisher });
    await scheduler.tick();
    expect(order).toEqual(["dispatch", "background"]);
    expect(background).toHaveBeenCalledWith(T);
    publisher = false;
    await scheduler.tick();
    expect(background).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/publish/handover.test.ts test/scheduler`
Expected: FAIL (`src/publish/handover.ts` missing; reconcile ignores `handed_over`; `resolveCheck` fails recent publishes; no `background` call).

- [ ] **Step 3: Implement the hand-over service**

Create `src/publish/handover.ts`:
```ts
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

/**
 * Native scheduling (#90, #92): hands posts over to the platform on the publisher device and follows them until
 * they are out. Never pushes an edit (#66): only PublishActions' Push update and push_update call update().
 */
export class HandOverService {
  private running = false;
  private readonly inFlight = new Set<string>();
  /** attemptKey → when to try again (Infinity: not this session) and how many transient failures so far. */
  private readonly retryAt = new Map<string, { at: number; failures: number }>();
  private readonly checkedAt = new Map<string, number>();

  constructor(private readonly deps: HandOverDeps) {}

  /** True while this device's own hand-over has the delivery claimed (a startup check leaves it alone). */
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
    const digest = contentDigest(v, content.body);
    const stagger = this.deps.defaultStaggerMinutes();
    const box: { v?: Variant; d?: Delivery } = {};
    // The claim (spec §5.1 applied to hand-overs): handed_over is on disk before the platform hears of it.
    const claimed = await this.deps.writer.updateVariant(v.file, (fresh) => {
      if (heldForReview(fresh)) return { refuse: "The note is held for review." };
      const d = effectiveDelivery(fresh, channelId);
      if (d?.status !== "scheduled") return { refuse: "It is no longer scheduled." };
      if (deliveryTime(fresh, channelId, stagger) !== at) return { refuse: "Its time changed." };
      if (contentDigest(fresh, content.body) !== digest) return { refuse: "It changed while it was being read." };
      const next = transition(d, "handed_over", { at, remoteAt: at, digest, attempts: (d.attempts ?? 0) + 1 });
      delete next.remoteId;
      delete next.url;
      delete next.error;
      box.v = fresh;
      box.d = next;
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
      // M2b P4: an error with no HTTP status that the adapter did not classify may have reached the platform.
      const unknown = !(e instanceof PublishError) && statusOf(e) === undefined;
      const err = unknown ? new UnknownOutcomeError(e instanceof Error ? e.message : String(e)) : classifyError(e);
      const message = redact(err.message);
      if (err.kind === "unknown") return await this.unknown(v.file, path, channelId, job, adapter, message, label);
      await this.write(v.file, channelId, WAITING, (d) => {
        const back = transition(d, "scheduled", { error: `Not handed over to ${label}: ${message} It stays scheduled and goes out from Obsidian at its time.` });
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
      // Still waiting on the platform; its time may have been changed there.
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

  /** M2b P4 for hand-overs: park on check_needed, look once, never schedule again by itself. */
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

  /** Writes only while the delivery still is what `accept` expects; true when written. */
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
```

- [ ] **Step 4: Wire it into PublishActions, the reconcile and the scheduler**

In `src/publish/orchestrator.ts`, next to `LOOKUP_TIMEOUT_MS`:
```ts
/** M3 P11: a publish that lookup() can't find is only called failed once a late success is this unlikely. */
export const LATE_SUCCESS_WINDOW_MS = 15 * MINUTE;
```

In `src/publish/actions.ts`:
- Import `HandOverService` from `./handover` and `LATE_SUCCESS_WINDOW_MS` from `./orchestrator`.
- Add the field `readonly handover: HandOverService;` and, at the end of the constructor:
```ts
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
      // Fails closed: without a publisher service nothing is handed over (spec §4.3).
      isPublisher: () => deps.isPublisher?.() ?? false,
      defaultStaggerMinutes: () => deps.settings().defaultStaggerMinutes,
      warn: (message) => void new Notice(message, 0),
      onFailure: (info) => this.notifier.failed(info),
      onPublished: (info) => this.notifier.published?.(info),
    });
```
- Add:
```ts
  /** Scheduler, after each tick on the publisher (M5): hand-overs and platform checks, never awaited (M3 P5). */
  background(_now: number): void {
    this.handover.run().catch(() => undefined);
  }
```
- `isInFlight`: `return this.orchestrator.isInFlight(path, channelId) || this.handover.isInFlight(path, channelId);`
- `markCheckNeeded`, inside the write:
```ts
      const d = fresh.deliveries[channelId];
      // A hand-over claim without the platform's id is as stuck as a publishing one (M5).
      const handing = d?.status === "handed_over" && !d.remoteId;
      if (!d || (d.status !== "publishing" && !handing) || this.isInFlight(path, channelId)) return { refuse: "The delivery changed." };
      const error = handing
        ? "Obsidian closed while this was being handed over to the platform. Check its scheduled posts, then mark it as published or not."
        : "Obsidian closed while this was being published. Check the platform, then mark it as published or not.";
      return { deliveries: { [channelId]: transition(d, "check_needed", { error }) } };
```
- Replace `resolveCheck`:
```ts
  /**
   * Resolves a check-needed delivery with the adapter's lookup() (spec §5.1). Found published → published; found on
   * the platform's schedule (an interrupted hand-over) → handed_over. Not found: M3 P11 — a publish becomes failed
   * only once its claim is LATE_SUCCESS_WINDOW_MS old (a late success from another device can still settle it),
   * and a hand-over is never assumed lost. It stays check_needed with a note, for the user.
   */
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
      if (state.scheduledAt !== undefined && state.remoteId) {
        outcome = "handed_over";
        const next = transition(d, "handed_over", { remoteId: state.remoteId, remoteAt: state.scheduledAt, ...(d.at === undefined ? { at: state.scheduledAt } : {}) });
        delete next.error;
        return { deliveries: { [channelId]: next } };
      }
      if (d.remoteAt !== undefined) return { deliveries: { [channelId]: { ...d, error: NOT_SCHEDULED } } };
      if (at - (d.at ?? 0) < LATE_SUCCESS_WINDOW_MS) return { deliveries: { [channelId]: { ...d, error: NOT_FOUND_YET } } };
      outcome = "failed";
      return { deliveries: { [channelId]: transition(d, "failed", { error: NOT_FOUND }) } };
    });
    if ("refuse" in result || outcome === "kept") return;
    if (outcome === "failed") {
      void this.deps.log.append({ at, path, channelId, result: "failed", error: NOT_FOUND });
      return;
    }
    if (outcome === "handed_over") {
      void this.deps.log.append({ at, path, channelId, result: "handed_over" });
      return;
    }
    void this.deps.log.append({ at, path, channelId, result: "published", ...(state.url ? { url: state.url } : {}) });
    // M3 P8: a lookup that confirms the publish counts as an API publish for the phone confirmation.
    try {
      this.notifier.published?.({ path, channelId, ...(state.url ? { url: state.url } : {}) });
    } catch {
      // The post is out and recorded; a failed confirmation must not turn the check into an error.
    }
  }
```
with the messages next to the other constants:
```ts
const NOT_FOUND = "Not found on the platform after an interrupted publish.";
const NOT_FOUND_YET = "Not found on the platform yet. A late answer can still settle it; if it stays missing, mark it as not published.";
const NOT_SCHEDULED = "Not found in the platform's scheduled posts. Check there: if it is missing, mark it as not published and schedule it again.";
```

In `src/scheduler/reconcile.ts`, replace the `publishing` check:
```ts
      const d = v.deliveries[id];
      // A hand-over claim without the platform's id is as stuck as a publishing one (M5).
      const stuck = d?.status === "publishing" || (d?.status === "handed_over" && !d.remoteId);
      if (stuck && !inFlight(v.path, id)) actions.push({ kind: "check_needed", path: v.path, channelId: id });
```
and update the doc comment ("a delivery left in `publishing`, or handed over without the platform's id, becomes check_needed").

In `src/scheduler/scheduler.ts`, add to `SchedulerPort`:
```ts
  /** Native hand-overs and platform checks (M5): started after the due items, never awaited (M3 P5). */
  background?(now: number): void;
```
and, in `tick()`, after the `for` loop over `dueItems` and before `return result;`:
```ts
      // Only while this tick is still current and this device the publisher (spec §4.3, M3 P2).
      if (current()) {
        try {
          this.deps.publish.background?.(now);
        } catch (e) {
          this.deps.warn(e instanceof Error ? e.message : String(e));
        }
      }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/publish test/scheduler test/reminders test/settings/publisher.test.ts`
Expected: PASS. Existing tests that build a `SchedulerPort` literal need no change (`background` is optional).

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/publish/handover.ts src/publish/actions.ts src/publish/orchestrator.ts src/scheduler/scheduler.ts src/scheduler/reconcile.ts test/publish/handover.test.ts test/scheduler/reconcile.test.ts test/scheduler/scheduler.test.ts
git commit -m "feat(publish): native hand-over on the publisher with claim, lookup, settle and startup check; late successes kept (#66, #90, #92, M3 P11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Hand-over sync state and the Push update / Revert time / Unschedule actions (#66)

**Files:**
- Modify: `src/publish/sync.ts` (`SyncInfo`, `syncInfo`, `handedOverChannels`, `outOfSync`, `syncChange`), `src/index/socialIndex.ts` (`IndexedVariant.digest`), `src/composer/schedule.ts` (`planComposerSchedule`), `src/publish/actions.ts` (`syncOf`, `pushUpdate`, `revertTime`, `unscheduleRemote`, private `updateChannel`, `updateApproved`)
- Create: `test/publish/syncActions.test.ts`
- Test: `test/publish/sync.test.ts`, `test/index/socialIndex.test.ts`, `test/composer/schedule.test.ts`

**Interfaces:**
- Consumes: `contentDigest` (Task 1), `Delivery.remoteAt/digest` (Task 1), `RemoteRemovedError`, `SyncChange` (Task 1), `deliveryJob` (Task 1), `HANDOVER_MARGIN_MS` (Task 13), `LIVE_STATUSES` (`src/index/queries.ts`), `PlannerActions.write/afterWrite/confirm`.
- Produces:
  - `interface SyncInfo { channelId; state: "in_sync" | "out_of_sync" | "unknown"; content: boolean; time: boolean; remoteAt?: number; at?: number }`.
  - `syncInfo(v, channelId): SyncInfo | null` (null unless `handed_over` with a `remote_id` and readable), `handedOverChannels(v): SyncInfo[]`, `outOfSync(v, channelId?): boolean`, `syncChange(v, body, d): SyncChange`.
  - `IndexedVariant.digest?: string` (`contentDigest` of the note, computed by the index).
  - `PublishActions.syncOf(path, channelId)`, `pushUpdate(path, channelId): Promise<boolean>`, `revertTime(path, channelId): Promise<boolean>`, `unscheduleRemote(path, channelId): Promise<boolean>`.
  - `planComposerSchedule` moves a handed-over channel's local `at` when it has a `remote_at` (the platform keeps its own).

Rules: "Out of sync" is `content` (the note's digest differs from the delivery's `digest`) or `time` (`at` differs from `remote_at`). Nothing here runs by itself. Push update needs the local time to be at least the adapter's lead plus `HANDOVER_MARGIN_MS` ahead. After a successful push the baseline becomes the pushed version (`digest`, `remote_at = at`, and a new `remote_id` if the platform replaced the post). A `RemoteRemovedError` returns the channel to `scheduled`, so it is handed over again or posted from Obsidian. MCP `push_update` (`updateApproved`) goes through the same per-channel update and writes the same baseline.

- [ ] **Step 1: Write the failing tests**

Append to `test/publish/sync.test.ts` (import `handedOverChannels, outOfSync, syncInfo` from `../../src/publish/sync`):
```ts
describe("syncInfo (#66)", () => {
  const v = (d: Record<string, unknown>, digest = "D") => ({ channels: ["ma/you"], deliveries: { "ma/you": { status: "handed_over", remoteId: "1", ...d } }, digest }) as never;

  it("is in sync when the digest and the time match the platform's copy", () => {
    expect(syncInfo(v({ at: 5, remoteAt: 5, digest: "D" }), "ma/you")).toEqual({ channelId: "ma/you", state: "in_sync", content: false, time: false, remoteAt: 5, at: 5 });
  });

  it("is out of sync when the content or the time changed", () => {
    expect(syncInfo(v({ at: 5, remoteAt: 5, digest: "OLD" }), "ma/you")).toMatchObject({ state: "out_of_sync", content: true, time: false });
    expect(syncInfo(v({ at: 9, remoteAt: 5, digest: "D" }), "ma/you")).toMatchObject({ state: "out_of_sync", content: false, time: true });
    expect(outOfSync(v({ at: 9, remoteAt: 5, digest: "D" }))).toBe(true);
  });

  it("can't tell for a hand-over without a baseline, and ignores claims in progress and other statuses", () => {
    expect(syncInfo(v({ at: 5 }), "ma/you")).toMatchObject({ state: "unknown" });
    expect(syncInfo(v({ remoteId: undefined, at: 5, remoteAt: 5, digest: "D" }), "ma/you")).toBeNull();
    expect(syncInfo({ channels: ["ma/you"], deliveries: { "ma/you": { status: "scheduled" } } } as never, "ma/you")).toBeNull();
    expect(handedOverChannels(v({ at: 5, remoteAt: 5, digest: "D" })).map((s) => s.channelId)).toEqual(["ma/you"]);
  });
});
```

Append to `describe("SocialIndex", …)` in `test/index/socialIndex.test.ts` (import `contentDigest` from `../../src/publish/sync`):
```ts
  it("computes each post's content digest (#66)", async () => {
    const { app, index } = await vaultWithCampaign();
    const path = "Social/Event X/Event X – LinkedIn.md";
    const before = index.getVariant(path)!;
    expect(before.digest).toBe(contentDigest(before, "\n# I almost didn't host Event X.\n\nMore text"));
    await writeNote(app, path, { type: "social-post", campaign: "[[Event X]]", platform: "linkedin", channels: ["li/me"] }, "Changed");
    await indexed(index, () => index.getVariant(path)?.digest !== before.digest);
  });
```

Append to `describe("planComposerSchedule", …)` in `test/composer/schedule.test.ts`:
```ts
  it("moves the local time of a handed-over channel with a baseline, so it shows as out of sync (#66)", () => {
    const post = v({ deliveries: { "li/maker": { status: "handed_over", remoteId: "9", at: T + 30 * 60_000, remoteAt: T + 30 * 60_000, digest: "d" } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toMatchObject({
      deliveries: { "li/maker": { status: "handed_over", remoteId: "9", at: NEW + 30 * 60_000, remoteAt: T + 30 * 60_000, digest: "d" } },
    });
  });
```

Create `test/publish/syncActions.test.ts`:
```ts
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { Notice } from "../fakes/obsidian";
import { formatDateTime, HOUR, MINUTE } from "../../src/model/dates";
import { RemoteRemovedError } from "../../src/platforms/errors";
import type { PlatformAdapter } from "../../src/platforms/types";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + 2 * HOUR;

async function fm(c: TestCtx): Promise<Record<string, unknown>> {
  const deliveries = (parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, Record<string, unknown>> }).deliveries;
  return deliveries["ma/you"]!;
}

/** A Mastodon post handed over for AT, in sync with the note, then `edit` applied to the note. */
async function setup(adapter: Partial<PlatformAdapter> = {}, edit: { body?: string; at?: number } = {}) {
  const c = await makeCtx({
    seed: true,
    notes: [{ path: P, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(AT), remote_at: formatDateTime(AT), remote_id: "3221", digest: "pending" } } }, body: "Doors open at 18:00" }],
  });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("ma/you")!, method: "native", handle: "@you@mastodon.social", secretId: "osmm-channel-ma-you" });
  const full = { platform: "mastodon" as const, minLeadMs: 5 * MINUTE, update: vi.fn(async () => ({ remoteId: "3222" })), cancel: vi.fn(async () => undefined), ...adapter };
  c.adapters.register(full);
  const v = c.index.getVariant(P)!;
  await c.writer.updateVariant(v.file, (fresh) => ({ deliveries: { "ma/you": { ...fresh.deliveries["ma/you"]!, digest: v.digest!, ...(edit.at !== undefined ? { at: edit.at } : {}) } } }));
  if (edit.body !== undefined) await c.writer.editBody(v.file, () => edit.body!);
  await indexed(c.index, () => c.index.getVariant(P)?.deliveries["ma/you"]?.digest === v.digest && (edit.body === undefined || c.index.getVariant(P)?.digest !== v.digest));
  return { c, adapter: full, digest: v.digest! };
}

describe("Push update (#66)", () => {
  it("pushes changed text, then records the new version and the platform's new id", async () => {
    const { c, adapter, digest } = await setup({}, { body: "Doors open at 18:30" });
    expect(c.ctx.publish.syncOf(P, "ma/you")).toMatchObject({ state: "out_of_sync", content: true, time: false });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(true);
    expect(adapter.update).toHaveBeenCalledWith(expect.objectContaining({ items: ["Doors open at 18:30"], delivery: expect.objectContaining({ remoteId: "3221" }) }), { content: true, time: false });
    const d = await fm(c);
    expect(d).toMatchObject({ status: "handed_over", remote_id: "3222", remote_at: formatDateTime(AT) });
    expect(d.digest).not.toBe(digest);
    await indexed(c.index, () => c.ctx.publish.syncOf(P, "ma/you")?.state === "in_sync");
    expect(c.log.entries.at(-1)).toMatchObject({ result: "updated", channelId: "ma/you" });
  });

  it("pushes a new time", async () => {
    const { c, adapter } = await setup({}, { at: AT + HOUR });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(true);
    expect(adapter.update).toHaveBeenCalledWith(expect.anything(), { content: false, time: true });
    expect(await fm(c)).toMatchObject({ at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT + HOUR) });
  });

  it("refuses a push too close to the platform time (review focus 3)", async () => {
    const { c, adapter } = await setup({}, { body: "Late edit" });
    c.now.set(AT - 5 * MINUTE);
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    expect(adapter.update).not.toHaveBeenCalled();
    expect(Notice.messages.at(-1)).toBe("@you@mastodon.social: It is too close to its time on Mastodon to change it now. It goes out as it was handed over.");
  });

  it("refuses a version with blocking issues (M2b P3)", async () => {
    const { c, adapter } = await setup({}, { body: "x".repeat(600) });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("returns the channel to scheduled when the platform copy is gone", async () => {
    const { c } = await setup({ update: vi.fn(async () => Promise.reject(new RemoteRemovedError("Mastodon: the old scheduled post was removed, but the new one could not be scheduled."))) }, { body: "New" });
    expect(await c.ctx.publish.pushUpdate(P, "ma/you")).toBe(false);
    const d = await fm(c);
    expect(d).toMatchObject({ status: "scheduled", error: "Mastodon: the old scheduled post was removed, but the new one could not be scheduled." });
    expect(d.remote_id).toBeUndefined();
    expect(d.remote_at).toBeUndefined();
    expect(d.digest).toBeUndefined();
    expect(c.log.entries.at(-1)).toMatchObject({ result: "update_failed" });
  });

  it("writes the same baseline when Claude's push_update is approved", async () => {
    const { c, digest } = await setup({}, { body: "From Claude" });
    await c.publisher.claim();
    const plan = await c.ctx.publish.prepareUpdate(P);
    if ("refuse" in plan) throw new Error(plan.refuse);
    expect(await c.ctx.publish.updateApproved(plan)).toEqual({ updated: ["ma/you"], failed: [] });
    expect((await fm(c)).digest).not.toBe(digest);
  });
});

describe("Revert time and Unschedule on the platform (#66)", () => {
  it("puts the platform's time back on the note, with Undo", async () => {
    const { c } = await setup({}, { at: AT + HOUR });
    expect(await c.ctx.publish.revertTime(P, "ma/you")).toBe(true);
    expect((await fm(c)).at).toBe(formatDateTime(AT));
  });

  it("takes the post off the platform's schedule after asking, and makes the channel a draft again", async () => {
    const { c, adapter } = await setup();
    c.ctx.actions.confirm = async () => true;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(true);
    expect(adapter.cancel).toHaveBeenCalledWith(expect.objectContaining({ delivery: expect.objectContaining({ remoteId: "3221" }) }));
    expect(await fm(c)).toEqual({ status: "draft" });
    expect(c.log.entries.at(-1)).toMatchObject({ result: "cancelled" });
  });

  it("changes nothing when the user says no or the platform refuses", async () => {
    const { c, adapter } = await setup({ cancel: vi.fn(async () => Promise.reject(new Error("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon."))) });
    c.ctx.actions.confirm = async () => false;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(false);
    expect(adapter.cancel).not.toHaveBeenCalled();
    c.ctx.actions.confirm = async () => true;
    expect(await c.ctx.publish.unscheduleRemote(P, "ma/you")).toBe(false);
    expect((await fm(c)).status).toBe("handed_over");
    expect(Notice.messages.at(-1)).toBe("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon.");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/publish/sync.test.ts test/index/socialIndex.test.ts test/composer/schedule.test.ts test/publish/syncActions.test.ts`
Expected: FAIL (`syncInfo` missing, no `digest` on indexed posts, the composer keeps the handed-over time, no `pushUpdate`).

- [ ] **Step 3: Sync state**

Append to `src/publish/sync.ts`:
```ts
import type { IndexedVariant } from "../index/socialIndex";
import type { Delivery } from "../model/types";
import type { SyncChange } from "../platforms/types";

/** A handed-over channel compared with the platform's copy (#66). */
export interface SyncInfo {
  channelId: string;
  /** unknown: handed over before M5, with no baseline to compare with. */
  state: "in_sync" | "out_of_sync" | "unknown";
  /** The note's content differs from what was handed over. */
  content: boolean;
  /** The note's time differs from the platform's. */
  time: boolean;
  remoteAt?: number;
  at?: number;
}

type SyncView = Pick<IndexedVariant, "channels" | "deliveries" | "invalidDeliveries" | "digest">;

/** Null unless the channel is handed over with the platform's id and its entry is readable. */
export function syncInfo(v: SyncView, channelId: string): SyncInfo | null {
  const d = v.deliveries[channelId];
  if (d?.status !== "handed_over" || !d.remoteId || v.invalidDeliveries?.includes(channelId)) return null;
  const content = d.digest !== undefined && v.digest !== undefined && d.digest !== v.digest;
  const time = d.remoteAt !== undefined && d.at !== undefined && d.at !== d.remoteAt;
  const state = content || time ? "out_of_sync" : d.digest === undefined && d.remoteAt === undefined ? "unknown" : "in_sync";
  return { channelId, state, content, time, ...(d.remoteAt !== undefined ? { remoteAt: d.remoteAt } : {}), ...(d.at !== undefined ? { at: d.at } : {}) };
}

export function handedOverChannels(v: SyncView): SyncInfo[] {
  return v.channels.map((id) => syncInfo(v, id)).filter((s): s is SyncInfo => s !== null);
}

export function outOfSync(v: SyncView, channelId?: string): boolean {
  return (channelId ? [channelId] : v.channels).some((id) => syncInfo(v, id)?.state === "out_of_sync");
}

/** What a push would change for this delivery; without a baseline, everything. */
export function syncChange(v: Pick<Variant, DigestedField>, body: string, d: Delivery): SyncChange {
  return { content: d.digest === undefined || d.digest !== contentDigest(v, body), time: d.remoteAt === undefined || d.at !== d.remoteAt };
}
```
(Move these imports to the top of the file with the existing ones.)

- [ ] **Step 4: Digest in the index**

In `src/index/socialIndex.ts`, import `contentDigest` from `../publish/sync`, add to `IndexedVariant`:
```ts
  /** contentDigest of the note (#66): compared with a handed-over delivery's digest for "Out of sync". */
  digest?: string;
```
and in `read()`, next to `bodyChars`: `digest: contentDigest(r.value, body),`.

- [ ] **Step 5: The composer's schedule moves the local time of a handed-over channel**

In `src/composer/schedule.ts`, import `MINUTE` from `../model/dates`, and at the top of the `if (d && KEEP.has(d.status))` block:
```ts
      // #66: a handed-over channel with a sync baseline follows the new time here and shows "Out of sync" until an
      // update is pushed; the platform keeps its own time. Without a baseline it stays where it is, as before.
      if (d.status === "handed_over" && d.remoteAt !== undefined) {
        deliveries[id] = { ...d, at: req.at + Math.max(0, fresh.channels.indexOf(id)) * (fresh.staggerMinutes ?? defaultStagger) * MINUTE };
        continue;
      }
```

- [ ] **Step 6: The actions**

In `src/publish/actions.ts`, import `contentDigest, syncChange, syncInfo, type SyncInfo` from `./sync`, `HANDOVER_MARGIN_MS` from `./handover`, `RemoteRemovedError` from `../platforms/errors`, `type SyncChange` from `../platforms/types`, `type Delivery` from `../model/types`, `formatShortDate, formatTime` from `../ui/format`. Add:
```ts
  /** #66: a handed-over channel compared with the platform's copy. */
  syncOf(path: string, channelId: string): SyncInfo | null {
    const v = this.deps.index.getVariant(path);
    return v ? syncInfo(v, channelId) : null;
  }

  /**
   * #66 "Push update": the note's current version and time go to the platform for one handed-over channel. Only
   * ever on the user's click (edits never push by themselves); M2b P3 first (flush, re-read, re-validate).
   */
  async pushUpdate(path: string, channelId: string): Promise<boolean> {
    const fresh = await this.freshChecked(path);
    if ("refuse" in fresh) {
      new Notice([fresh.refuse, ...(fresh.issues ?? []).map((i) => i.message)].join(" "));
      return false;
    }
    const { v, content } = fresh;
    const d = v.deliveries[channelId];
    const name = this.channelName(channelId);
    if (d?.status !== "handed_over") {
      new Notice(`${name} is not waiting on ${PLATFORM_META[v.platform].label}'s schedule.`);
      return false;
    }
    const result = await this.updateChannel(v, content, channelId, syncChange(v, content.body, d));
    new Notice(result.ok ? `Updated on ${PLATFORM_META[v.platform].label} for ${name}.` : `${name}: ${result.error}`);
    return result.ok;
  }

  /** #66 "Revert time": the note takes the platform's time again (local only, with Undo). */
  async revertTime(path: string, channelId: string): Promise<boolean> {
    const v = this.deps.index.getVariant(path);
    if (!v) return false;
    const label = PLATFORM_META[v.platform].label;
    let back = 0;
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const d = fresh.deliveries[channelId];
      if (d?.status !== "handed_over" || d.remoteAt === undefined || unreadable(fresh, channelId)) return { refuse: `${this.channelName(channelId)} has no time on ${label} to go back to.` };
      back = d.remoteAt;
      return { deliveries: { [channelId]: { ...d, at: d.remoteAt } } };
    });
    this.deps.planner.afterWrite(result, `Back to ${formatShortDate(back)} ${formatTime(back)}, the time on ${label}.`);
    return result.ok;
  }

  /** #66 "Unschedule on <platform>": takes the post off the platform's schedule; the channel is a draft again here. */
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

  /**
   * One channel's update, for Push update and push_update. A handed-over channel must still be far enough ahead;
   * after the push its baseline is the pushed version. RemoteRemovedError returns it to scheduled.
   */
  private async updateChannel(v: IndexedVariant, content: LoadedContent, channelId: string, change?: SyncChange): Promise<{ ok: true } | { ok: false; error: string }> {
    const d = v.deliveries[channelId];
    const channel = this.deps.channels.get(channelId);
    const adapter = this.deps.adapters.get(v.platform);
    if (!channel || !d || !adapter?.update || unreadable(v, channelId) || !LIVE_STATUSES.has(d.status) || !d.remoteId) return { ok: false, error: "It is no longer live with a known id." };
    const label = PLATFORM_META[v.platform].label;
    if (d.status === "handed_over") {
      const at = d.at ?? d.remoteAt;
      if (at === undefined || at < this.deps.now() + (adapter.minLeadMs ?? 0) + HANDOVER_MARGIN_MS) {
        return { ok: false, error: `It is too close to its time on ${label} to change it now. It goes out as it was handed over.` };
      }
    }
    const secretId = channel.secretId;
    const redact = (text: string) => (secretId ? this.deps.secrets.redact(text, [secretId]) : text);
    try {
      const res = (await adapter.update(deliveryJob(v, channel, d, content, secretId ? this.deps.secrets.get(secretId) : null), change)) as { remoteId?: string } | undefined;
      if (d.status === "handed_over") {
        const digest = contentDigest(v, content.body);
        await this.deps.writer.updateVariant(v.file, (fresh) => {
          const now = fresh.deliveries[channelId];
          if (now?.status !== "handed_over" || now.remoteId !== d.remoteId) return { refuse: "The delivery changed." };
          const next: Delivery = { ...now, remoteId: res?.remoteId ?? now.remoteId!, remoteAt: d.at ?? now.remoteAt, digest };
          delete next.error;
          return { deliveries: { [channelId]: next } };
        });
      }
      void this.deps.log.append({ at: this.deps.now(), path: v.path, channelId, result: "updated", ...(d.url ? { url: d.url } : {}) });
      return { ok: true };
    } catch (e) {
      const error = redact(e instanceof Error ? e.message : String(e));
      if (e instanceof RemoteRemovedError && d.status === "handed_over") {
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
```
Replace the per-channel loop of `updateApproved` (after the digest, publisher and adapter checks) with:
```ts
    const updated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of plan.channels) {
      const d = v.deliveries[id];
      const r = await this.updateChannel(v, content, id, d?.status === "handed_over" ? syncChange(v, content.body, d) : undefined);
      if (r.ok) updated.push(id);
      else failed.push({ id, error: r.error });
    }
    return { updated, failed };
```
(the `def`, `items` and `secretId` locals of the old loop go away).

The "too close" Notice reads `${name}: It is too close…`, because `pushUpdate` prefixes every refusal with the channel name.

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run test/publish test/index test/composer test/mcp/publish.test.ts`
Expected: PASS (the existing `push_update` tests on a published Telegram post are unchanged).

- [ ] **Step 8: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/publish/sync.ts src/index/socialIndex.ts src/composer/schedule.ts src/publish/actions.ts test/publish/sync.test.ts test/publish/syncActions.test.ts test/index/socialIndex.test.ts test/composer/schedule.test.ts
git commit -m "feat(publish): out-of-sync state for handed-over posts with Push update, Revert time and Unschedule on the platform (#66)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: "Out of sync" in the composer, the calendar chips, the row menu and the campaign table (#66)

**Files:**
- Create: `src/composer/SyncPanel.svelte`, `test/composer/syncPanel.test.ts`
- Modify: `src/composer/Composer.svelte` (after `<SchedulePanel …/>`), `src/views/Chip.svelte`, `src/views/CampaignTable.svelte`, `src/ui/actions.ts` (`rowLabel`, `rowMenu`), `src/styles/planner.css`, `src/styles/composer.css`, `test/ui/rowMenu.test.ts`, `test/views/campaignTable.test.ts`

**Interfaces:**
- Consumes: `syncInfo`, `handedOverChannels`, `outOfSync`, `SyncInfo` (Task 14); `PublishActions.pushUpdate/revertTime/unscheduleRemote` (Task 14); `icon` action (`src/ui/icon.ts`); `formatShortDate`, `formatTime`.
- Produces: `SyncPanel.svelte` (props `{ variant: IndexedVariant }`, a section labelled "Scheduled on <platform>", one row per handed-over channel with "Out of sync", a sentence saying what differs, and the buttons **Push update** (unless in sync), **Revert time** (time drift only) and **Unschedule on <platform>**, each with an `aria-label` naming the channel); the chip's `.osmm-chip-sync` icon and the "out of sync with the platform" part of its label; the "Out of sync" pill in the campaign table's Status cell; the same three actions in the row menu of a handed-over row.

- [ ] **Step 1: Write the failing tests**

Create `test/composer/syncPanel.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import SyncPanel from "../../src/composer/SyncPanel.svelte";
import { formatDateTime, HOUR } from "../../src/model/dates";
import { osmmContext } from "../../src/ui/context";
import { formatShortDate, formatTime } from "../../src/ui/format";
import { makeCtx, TEST_NOW } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + 2 * HOUR;
const when = (at: number) => `${formatShortDate(at)} ${formatTime(at)}`;
const handedOver = (delivery: Record<string, unknown>) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", remote_id: "3221", ...delivery } } },
  body: "Doors open at 18:00",
});

describe("SyncPanel (#66)", () => {
  it("shows an out-of-sync channel with what differs and the three actions", async () => {
    const c = await makeCtx({ seed: true, notes: [handedOver({ at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), digest: "old" })] });
    const push = vi.spyOn(c.ctx.publish, "pushUpdate").mockResolvedValue(true);
    const revert = vi.spyOn(c.ctx.publish, "revertTime").mockResolvedValue(true);
    const unschedule = vi.spyOn(c.ctx.publish, "unscheduleRemote").mockResolvedValue(true);
    render(SyncPanel, { props: { variant: c.index.getVariant(P)! }, context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Scheduled on Mastodon" })).toBeTruthy();
    expect(screen.getByText("Out of sync")).toBeTruthy();
    expect(screen.getByText(`Mastodon has the version for ${when(AT)}; the text or media changed, and the time here is ${when(AT + HOUR)}.`)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Push update for @you@mastodon.social" }));
    await fireEvent.click(screen.getByRole("button", { name: "Revert time for @you@mastodon.social" }));
    await fireEvent.click(screen.getByRole("button", { name: "Unschedule @you@mastodon.social on Mastodon" }));
    expect(push).toHaveBeenCalledWith(P, "ma/you");
    expect(revert).toHaveBeenCalledWith(P, "ma/you");
    expect(unschedule).toHaveBeenCalledWith(P, "ma/you");
  });

  it("shows an in-sync channel with its platform time and no Push update", async () => {
    const c = await makeCtx({ seed: true, notes: [handedOver({ at: formatDateTime(AT), remote_at: formatDateTime(AT) })] });
    const v = c.index.getVariant(P)!;
    // The note's own digest on the delivery: in sync.
    render(SyncPanel, { props: { variant: { ...v, deliveries: { "ma/you": { ...v.deliveries["ma/you"]!, digest: v.digest! } } } }, context: osmmContext(c.ctx) });
    expect(screen.getByText(`Scheduled on Mastodon for ${when(AT)}.`)).toBeTruthy();
    expect(screen.queryByText("Out of sync")).toBeNull();
    expect(screen.queryByRole("button", { name: /Push update/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Unschedule @you@mastodon.social on Mastodon" })).toBeTruthy();
  });

  it("renders nothing for a post with no handed-over channel", async () => {
    const c = await makeCtx({ seed: true, notes: [{ ...handedOver({}), frontmatter: { ...handedOver({}).frontmatter, deliveries: { "ma/you": { status: "scheduled" } } } }] });
    const { container } = render(SyncPanel, { props: { variant: c.index.getVariant(P)! }, context: osmmContext(c.ctx) });
    expect(container.textContent?.trim()).toBe("");
  });
});
```

Append to `test/ui/rowMenu.test.ts`, inside `describe("row menu", …)` (import `formatDateTime`, `HOUR` from `../../src/model/dates`, `TEST_NOW` from `./ctx`):
```ts
  it("offers Push update, Revert time and Unschedule for an out-of-sync handed-over post, and labels its chip (#66)", async () => {
    const MA = "Social/Posts/Ma.md";
    const AT = TEST_NOW + 2 * HOUR;
    const { ctx } = await makeCtx({
      seed: true,
      notes: [{ path: MA, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), remote_id: "3221", digest: "old" } } }, body: "Hi" }],
    });
    const row = ctx.actions.rowByKey(`${MA}#ma/you`)!;
    ctx.actions.rowMenu(row, { x: 0, y: 0 });
    expect(titles().slice(0, 5)).toEqual(["Open note", "Compose", "Push update", "Revert time", "Unschedule on Mastodon"]);
    const { container } = render(Chip, { props: { row }, context: osmmContext(ctx) });
    expect(container.querySelector(".osmm-chip-sync")).not.toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("out of sync with the platform");
  });
```

Append to `describe("CampaignTable", …)` in `test/views/campaignTable.test.ts`:
```ts
  it("marks a variant with an out-of-sync handed-over channel (#66)", async () => {
    const { ctx } = await makeCtx({
      seed: true,
      notes: [
        {
          path: "Social/Event X/Event X – Mastodon.md",
          frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: "2026-10-10T18:00:00+02:00", deliveries: { "ma/you": { status: "handed_over", at: "2026-10-10T19:00:00+02:00", remote_at: "2026-10-10T18:00:00+02:00", remote_id: "3221", digest: "old" } } },
          body: "Hi",
        },
      ],
    });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(ctx) });
    expect(screen.getByText("Out of sync")).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/composer/syncPanel.test.ts test/ui/rowMenu.test.ts test/views/campaignTable.test.ts`
Expected: FAIL (no `SyncPanel.svelte`; no sync items, icon or pill).

- [ ] **Step 3: The composer panel**

Create `src/composer/SyncPanel.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORM_META } from "../model/platforms";
  import { handedOverChannels, type SyncInfo } from "../publish/sync";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { variant }: { variant: IndexedVariant } = $props();
  const { channels, publish } = useOsmm();
  const rows = $derived(handedOverChannels(variant));
  const label = $derived(PLATFORM_META[variant.platform].label);

  const when = (at: number | undefined): string => (at === undefined ? "its time" : `${formatShortDate(at)} ${formatTime(at)}`);
  const name = (id: string): string => channels.get(id)?.name ?? id;

  /** #66: what the platform has, and what differs in the note. */
  function describe(s: SyncInfo): string {
    if (s.state === "unknown") return `Handed over to ${label}.`;
    if (s.state === "in_sync") return `Scheduled on ${label} for ${when(s.remoteAt)}.`;
    const what = [s.content ? "the text or media changed" : "", s.time ? `the time here is ${when(s.at)}` : ""].filter(Boolean).join(", and ");
    return `${label} has the version for ${when(s.remoteAt)}; ${what}.`;
  }
</script>

{#if rows.length}
  <section class="osmm-panel" aria-label={`Scheduled on ${label}`}>
    <h4>Scheduled on {label}</h4>
    <ul class="osmm-sync-list">
      {#each rows as s (s.channelId)}
        <li>
          <div class="osmm-row">
            <span class="osmm-row-title">{name(s.channelId)}</span>
            {#if s.state === "out_of_sync"}<span class="osmm-pill-sync">Out of sync</span>{/if}
          </div>
          <p class="osmm-progress">{describe(s)}</p>
          <div class="osmm-chips">
            {#if s.state !== "in_sync"}
              <button type="button" class="mod-cta" aria-label={`Push update for ${name(s.channelId)}`} onclick={() => void publish.pushUpdate(variant.path, s.channelId)}>Push update</button>
            {/if}
            {#if s.time}
              <button type="button" aria-label={`Revert time for ${name(s.channelId)}`} onclick={() => void publish.revertTime(variant.path, s.channelId)}>Revert time</button>
            {/if}
            <button type="button" aria-label={`Unschedule ${name(s.channelId)} on ${label}`} onclick={() => void publish.unscheduleRemote(variant.path, s.channelId)}>Unschedule on {label}</button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
```
In `src/composer/Composer.svelte`, import `SyncPanel from "./SyncPanel.svelte"` and render `<SyncPanel {variant} />` right after `<SchedulePanel {variant} {issues} />`.

- [ ] **Step 4: Chips, the row label, the row menu and the campaign table**

`src/views/Chip.svelte`: import `outOfSync` from `../publish/sync` and `icon` from `../ui/icon`; after the title span:
```svelte
  {#if row.channelId && outOfSync(row.variant, row.channelId)}<span class="osmm-chip-sync" aria-hidden="true" use:icon={"refresh-cw-off"}></span>{/if}
```

`src/ui/actions.ts`: import `outOfSync, syncInfo` from `../publish/sync`. In `rowLabel`, after `parts.push(STATUS_LABEL[row.status]);`:
```ts
    if (row.channelId && outOfSync(row.variant, row.channelId)) parts.push("out of sync with the platform");
```
In `rowMenu`, right after the "Compose" item (before the held / Post now branch):
```ts
    // #66: a handed-over channel's platform copy; nothing here pushes unless the user picks it.
    const sync = row.channelId && !held ? syncInfo(v, row.channelId) : null;
    if (sync) {
      const channelId = sync.channelId;
      const label = PLATFORM_META[v.platform].label;
      if (sync.state !== "in_sync") menu.addItem((i) => i.setTitle("Push update").setIcon("upload").onClick(() => void this.context?.publish.pushUpdate(v.path, channelId)));
      if (sync.time) menu.addItem((i) => i.setTitle("Revert time").setIcon("undo-2").onClick(() => void this.context?.publish.revertTime(v.path, channelId)));
      menu.addItem((i) => i.setTitle(`Unschedule on ${label}`).setIcon("calendar-x").onClick(() => void this.context?.publish.unscheduleRemote(v.path, channelId)));
    }
```

`src/views/CampaignTable.svelte`: import `outOfSync` from `../publish/sync`; in the Status cell:
```svelte
          <td>
            <span class="osmm-pill-status">{VARIANT_STATUS_LABEL[r.status]}</span>
            {#if outOfSync(r.variant)}<span class="osmm-pill-sync">Out of sync</span>{/if}
          </td>
```

Append to `src/styles/planner.css`:
```css
.osmm-pill-sync {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid var(--text-warning);
  color: var(--text-warning);
  font-size: var(--font-ui-smaller);
}
.osmm-chip-sync { display: inline-flex; color: var(--text-warning); }
.osmm-chip-sync svg { width: 12px; height: 12px; }
```
Append to `src/styles/composer.css`:
```css
.osmm-sync-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.osmm-sync-list p { margin: 2px 0 6px; }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/composer test/ui test/views`
Expected: PASS.

- [ ] **Step 6: Run the whole gate, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
```bash
git add src/composer/SyncPanel.svelte src/composer/Composer.svelte src/views/Chip.svelte src/views/CampaignTable.svelte src/ui/actions.ts src/styles/planner.css src/styles/composer.css test/composer/syncPanel.test.ts test/ui/rowMenu.test.ts test/views/campaignTable.test.ts
git commit -m "feat(ui): Out of sync badge in the composer, calendar chips, row menu and campaign table, with Push update, Revert time and Unschedule (#66)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: Docs, the per-platform smoke checklist and the release notes template (#111)

**Files:**
- Create: `docs/qa/m5-smoke.md`, `.github/release-notes.md`, `test/docs/m5.test.ts`
- Modify: `.github/workflows/release.yml`, `README.md`, `docs/getting-started.md`

**Interfaces:**
- Consumes: everything above. The docs describe only what Tasks 1–15 built.
- Produces: the manual smoke checklist per platform and per mode, with every **(QA)** item of this plan; a release-notes template the release workflow puts at the top of every release, linking the checklist; README and getting-started sections for automatic posting, native scheduling and "Out of sync".

- [ ] **Step 1: Write the failing test**

Create `test/docs/m5.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_META } from "../../src/model/platforms";
import { createAdapters } from "../../src/platforms/adapters";

// Vitest runs from the repo root (see test/claude/package.test.ts).
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shipped = () =>
  createAdapters({ http: async () => ({ status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }), now: () => 0, readBinary: async () => new ArrayBuffer(0), sleep: async () => undefined }).map((a) => a.platform);

describe("M5 smoke checklist (#111)", () => {
  it("has a section for every platform that posts through an API, and one for native scheduling", () => {
    const doc = read("docs/qa/m5-smoke.md");
    for (const p of shipped()) expect(doc).toContain(`## ${PLATFORM_META[p].label}`);
    expect(doc).toContain("## Native scheduling");
  });

  it("is linked from the release notes the release workflow publishes", () => {
    expect(read(".github/release-notes.md")).toContain("docs/qa/m5-smoke.md");
    expect(read(".github/workflows/release.yml")).toContain("--notes-file .github/release-notes.md");
  });

  it("no longer calls automatic posting a roadmap item", () => {
    expect(read("README.md")).not.toContain("automatic posting through the platforms' APIs is on the roadmap");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/docs/m5.test.ts`
Expected: FAIL (files missing; README still says roadmap).

- [ ] **Step 3: Write the smoke checklist**

Create `docs/qa/m5-smoke.md`:
```markdown
# M5 smoke checklist: automatic posting and native scheduling

Run on **test accounts** before each release (spec §7, #111), with a production build (`npm run build`) in a test vault, on one desktop (the publisher) and one phone. Keep a second desktop with the same vault open as a non-publisher. Every **(QA)** item checks something the automated tests could only fake: record the result, and when an item fails, add a failing test in the owning module before fixing it. The live recorder can save real answers for comparison: `OSMM_RECORD=<platform> OSMM_SECRET=… OSMM_HANDLE=… [OSMM_SERVER=… OSMM_LOGIN=…] npx vitest run test/platforms/contract/record.test.ts` writes `test/platforms/<platform>/recorded/publish.json` with secrets masked.

## General
- [ ] Settings → Channels → edit each API channel: the fields match the platform, "Publishing" offers only what it supports, **Test connection** says "Connected: …" with the right account, and a wrong credential gives a readable error without the credential in it.
- [ ] Only the publisher posts and hands over: schedule a post 15 minutes out on each platform; the non-publisher desktop never sends (watch `Social/_log.md`: one line per attempt, written by the publisher).
- [ ] `data.json`, `localStorage`, `Social/_log.md` and every Notice: no token, webhook URL, app password or `Basic …` string appears.
- [ ] Remove a channel's credential on the publisher: its next post fails with "Add … on this device" and a Fix-style notification; nothing is posted.
- [ ] Turn Wi-Fi off right after clicking **Post now** on Telegram (the send must already be out): the delivery ends **Check needed**, is never retried, and the log shows one attempt. **(QA)**: timing this needs a slow network (throttle to "offline" in the OS mid-request).
- [ ] An older plugin version on a second device refuses the synced settings (schema 5) with a notice instead of stripping the new channel fields.
- [ ] Phone (iOS and Android) as the publisher for one test: Telegram and Bluesky posts go out; link cards show in the previews. **(QA)** `requestUrl` multipart uploads from a phone.

## Telegram
- [ ] Create a bot with @BotFather, add it to a test channel as an admin that can post; save the token as the credential; **Find chat id** lists the channel after a post in it; **Use** fills `@name` (or `-100…` for a private channel).
- [ ] Text with **bold**, *italic*, `code`, a link, and the characters `< > &`: shows as written, formatted. **(QA)** HTML parse mode accepts every tag `telegramHtml` produces.
- [ ] One photo with a short text: one message with a caption. One photo with more than 1024 characters: the photo, then the text as a second message; the delivery links the text message. **(QA)** Telegram's caption count matches `visibleLength` for emoji and entities.
- [ ] Three photos: one album, caption on the first photo.
- [ ] The link on a private channel (`https://t.me/c/…/…`) opens the message.
- [ ] Remove the bot's admin right, post: **Failed** with "not enough rights" (needs you), not retried.

## Discord
- [ ] Webhook URL as the credential; **Test connection** names the webhook.
- [ ] A post with `@everyone` in the text does **not** ping anyone (`allowed_mentions`).
- [ ] Post as name and avatar override the webhook's own.
- [ ] Two images with alt text: both attached; **(QA)** the alt text shows as the image description.
- [ ] The delivery's link opens the message in the server channel.
- [ ] Delete the webhook in Discord, post: **Failed** with "The webhook was deleted; create a new one…".

## Mastodon
- [ ] Access token with read and write scopes; the handle `@you@instance` finds the server; **Test connection** shows `@you@instance`.
- [ ] An immediate post with an image, alt text and a focal point: the alt text and the crop look right. **(QA)** a large image answers 202 and the post waits until it is processed.
- [ ] A thread of three: replies in order.
- [ ] Post the same text twice within an hour by retrying after a forced 5xx (or by replaying with the same Idempotency-Key using curl): **(QA)** only one status exists.
- [ ] **(QA)** After an interruption, **Check again** finds the post by its text, including a text that mentions `@someone@other.instance` (the fingerprint drops the domain on Mastodon's side).

## Bluesky
- [ ] Handle and app password; **Test connection** shows `@you.bsky.social`.
- [ ] A post with an emoji with skin tone, an accented word, a mention of a real account, a link and a hashtag: the mention, link and tag are clickable and cover exactly their text.
- [ ] A post with a link and no image: a link card with title, description and image. A page without OpenGraph tags: a card with the page title or the host.
- [ ] A post with images: images with alt text, no card.
- [ ] A thread of three: replies in order; the delivery links the first post.
- [ ] **(QA)** The session's DID document names the PDS and posts go there; a self-hosted PDS works with `server`.
- [ ] **(QA)** `createRecord` accepts the plugin's record key (TID from the claim time); after a forced interruption, **Check again** finds the post by that key.
- [ ] **(QA)** A 300-grapheme post with a long URL: Bluesky's own count agrees with the composer's.

## WordPress
- [ ] Site address (https), user name and application password; **Test connection** shows "<name> on <host>". An `http://` site is refused in the channel form.
- [ ] An article with headings, a callout, a list, a table, a code block, an image embedded in the body, `media:` images and a featured image: the page looks right in the theme; the images are in the media library with their alt text; categories that exist are reused and new ones are created.
- [ ] **(QA)** A site without pretty permalinks (`/wp-json/` answers 404): **Test connection** says so; note the site and whether `?rest_route=` is needed (follow-up).
- [ ] **(QA)** Security plugins (Wordfence, iThemes) that block application passwords or the REST API: the error is readable.

## Native scheduling (Mastodon and WordPress)
- [ ] Schedule a post 30 minutes out on a `native` channel: within one tick (30 s) on the publisher it shows **Handed over**, and the log says "handed over to the platform". Mastodon: **(QA)** it is in the instance's scheduled list (`GET /api/v1/scheduled_statuses` with the token, or a client that shows scheduled posts). WordPress: it is **Scheduled** in WP admin.
- [ ] Close Obsidian on every device. At its time the post goes out on the platform. Open Obsidian: within 15 minutes the delivery becomes **Published** with the live link. (#92 acceptance: the WordPress article publishes on time with Obsidian closed.) **(QA)** WordPress on a low-traffic site ("Missed schedule"): the delivery stays handed over, then **Check needed** after a day.
- [ ] Edit the text of a handed-over post: the composer, the calendar chip and the campaign table show **Out of sync**; nothing changes on the platform. **Push update**: Mastodon removes the old scheduled post and schedules the new one (one scheduled post only); WordPress updates the post. The badge goes away.
- [ ] Drag a handed-over post to another time: **Out of sync** (time). **Revert time** puts it back; **Push update** instead moves it on the platform.
- [ ] Try **Push update** less than 7 minutes (Mastodon) or 3 minutes (WordPress) before its time: refused, nothing changes.
- [ ] **Unschedule on Mastodon/WordPress**: gone from the platform's schedule (WordPress: back to draft), the channel is a draft here, the log says "taken off the platform's schedule".
- [ ] A Mastodon thread on a native channel is not handed over; it posts from Obsidian at its time.
- [ ] Quit Obsidian during a hand-over (hard to time; **(QA)** throttle the network): at the next start the delivery is **Check needed**, and **Check again** finds it on the platform's schedule and returns it to **Handed over**.
```

- [ ] **Step 4: The release notes template and the workflow**

Create `.github/release-notes.md`:
```markdown
## Before publishing this pre-release

Run the manual smoke checklist on test accounts: [docs/qa/m5-smoke.md](https://github.com/dannickstark/Obsidian-Social-media-management/blob/HEAD/docs/qa/m5-smoke.md), one section per platform and per mode. Tick each section here, or list what failed.

- [ ] General (publisher device, secrets, phones)
- [ ] Telegram
- [ ] Discord
- [ ] Mastodon
- [ ] Bluesky
- [ ] WordPress
- [ ] Native scheduling (Mastodon and WordPress)
```

In `.github/workflows/release.yml`, change the last command to:
```yaml
        run: gh release create "$GITHUB_REF_NAME" main.js manifest.json styles.css --title "$GITHUB_REF_NAME" --notes-file .github/release-notes.md --generate-notes --prerelease
```
(`gh` appends the generated notes after the file's text. **(QA)** check the first M5 pre-release shows both.)

- [ ] **Step 5: README and getting started**

In `README.md`, add to "What it does" after the "Post in one click" bullet:
```markdown
- **Post automatically** to Telegram channels, Discord server channels (webhooks), Mastodon, Bluesky and WordPress sites from the publisher device, with images, alt text, threads and link cards. Mastodon and WordPress posts can be **handed over** to the platform's own scheduler, so they go out on time even with Obsidian closed; edit one afterwards and it shows **Out of sync** until you push the update. A post whose outcome is unknown (the connection dropped while it was sent) is never sent twice: the plugin asks the platform, or asks you.
```
Replace the "Supported platforms" paragraph with:
```markdown
Supported platforms: LinkedIn (profile and pages), X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit, WhatsApp and WordPress. Telegram, Discord, Mastodon, Bluesky and WordPress post through their APIs; the others use the assisted flow for now (Facebook, Instagram, X and LinkedIn are next).
```
Add to "Your data":
```markdown
- API credentials (bot tokens, webhook URLs, access tokens, app passwords, WordPress application passwords) stay in each device's secret storage; set them up on the publisher device. Bluesky sessions are kept in memory only. Posts, images and link-card requests go straight from your device to each platform; there is no server in between.
```

In `docs/getting-started.md`, before "When something goes wrong", add:
```markdown
## 9. Post automatically (5 minutes per platform, optional)

On the publisher device, open **Settings → Social Planner → Channels**, edit a channel, set **Publishing** to **API (auto-post)** and add its credential:

- **Telegram:** a bot token from @BotFather. Add the bot to your channel as an admin that can post, post something in the channel, then click **Find chat id** and **Use** it.
- **Discord:** the channel's webhook URL (Server settings → Integrations → Webhooks). Optionally a name and avatar to post as.
- **Mastodon:** an access token (Preferences → Development → New application, scopes read and write). Your handle `@you@your.instance` tells the plugin which server to use.
- **Bluesky:** an app password (Settings → Privacy and security → App passwords) and your handle.
- **WordPress:** the site address (https only), your user name and an application password (Users → Profile → Application passwords).

Click **Test connection**. Scheduled posts on these channels now go out by themselves while the publisher device runs Obsidian.

For Mastodon and WordPress, choose **API with native scheduling** instead: a scheduled post is handed over to the platform (at least 7 minutes ahead on Mastodon, 3 on WordPress) and goes out even when Obsidian is closed. If you edit or move it afterwards, it shows **Out of sync**: the platform keeps the old version until you click **Push update** (in the composer, or right click the post). **Revert time** takes the platform's time back, and **Unschedule on …** takes it off the platform's schedule. A Mastodon thread is never handed over; it posts from Obsidian at its time.
```
and add to "When something goes wrong":
```markdown
- **Check needed after a dropped connection.** The post may or may not have gone out, so it is never sent again by itself. Where the platform can tell (Mastodon, Bluesky, WordPress), the plugin asks it and settles the post; otherwise look on the platform and mark it as published or not.
- **Not handed over.** The platform refused the hand-over (a wrong token, a time too close). The post stays scheduled and goes out from Obsidian at its time, as long as the publisher device is on.
- **Out of sync.** You changed a post after it was handed over. Nothing is sent until you click **Push update**.
```

- [ ] **Step 6: Run the test, then the whole suite**

Run: `npx vitest run test/docs/m5.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes. Compare `main.js` with the M4 build: it should grow by no more than about 80 KB (five adapters, the Markdown converter; no new dependency).

- [ ] **Step 7: Commit**

```bash
git add docs/qa/m5-smoke.md .github/release-notes.md .github/workflows/release.yml README.md docs/getting-started.md test/docs/m5.test.ts
git commit -m "docs: automatic posting, native scheduling and Out of sync; per-platform smoke checklist and release notes template (#111)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Walk through the checklist**

Work through `docs/qa/m5-smoke.md` on test accounts. For each failure, add a failing test in the owning module first, fix it and commit with `fix(...)`. The live walkthrough may be deferred to the user, as in M2b–M4; the first M5 pre-release is not published until it is done (#111 acceptance).

---

## M5 Done Checklist

- [ ] All 16 tasks committed on `feat/m5-adapters-wave-1`; `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] The contract suite runs for Telegram, Discord, Bluesky, Mastodon and WordPress, and fails for any adapter added to `createAdapters()` without a case (#87, #86 DoD 1).
- [ ] `docs/qa/m5-smoke.md` passed on test accounts, including every **(QA)** item (#86 DoD 2, #88–#92 acceptance), or deferred to the user with a ruling.
- [ ] Issues #87–#93, #66 and #111 can be closed; epic #86 is complete.
- [ ] Follow-ups for M6+: token health and expiry reminders (spec §5.4); `?rest_route=` fallback for WordPress sites without pretty permalinks, if QA finds one; Telegram/Discord edit of live posts through `push_update`; Facebook Pages native scheduling reuses `HandOverService` (`status: "scheduled"`, `scheduled_publish_time`).
