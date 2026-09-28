# M3 — Phone Reminders, Publisher Device and Publish Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminders reach the phone even when the laptop is closed (ntfy pushes booked on a rolling 72-hour window), exactly one device publishes (a publisher-device setting with takeover), every publish attempt is appended to `Social/_log.md`, and the plugin loads and works on iOS and Android.

**Architecture:** `publish/vaultLog.ts` replaces the in-memory `MemoryLog` with a serialized, redacted, append-only Markdown log with monthly archives. `settings/publisher.ts` decides which device publishes: the device id and name stay in device-local storage, the synced settings record `{ deviceId, name, since }` of the publisher, and `Scheduler.isPublisher()` reads it. `reminders/ntfy/` holds the ntfy client (`requestUrl` only), a device-local booking ledger, the `NtfyBooker` that diffs "reminders due in the next 72 h" (the same `reminderSlots` the desktop reminders use) against what is booked, the notification content (click = pre-filled page; actions = `obsidian://osmm-post` and `obsidian://open`), and the optional result alerts. A mobile pass guards Electron-only code behind `Platform.isDesktopApp` and gives phones an agenda instead of the month/week grids.

**Tech Stack:** TypeScript 5.9 (strict), Svelte 5 (runes), Obsidian API 1.13 (`requestUrl`, `Platform`, `SecretStorage`, `registerObsidianProtocolHandler`, `loadLocalStorage`), ntfy JSON publishing API, Vitest 5 (jsdom) with the in-memory Obsidian fake.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§2.5 `_log.md`, §2.6 secrets, §3 view 7 Phone, §4 architecture, §4.3 publisher device, §4.4 reminders, §5 lifecycle, §5.6 audit, §7 testing, §10 ntfy risks). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z (artboard 7 Phone). Binding rulings: `.superpowers/sdd/2026-09-29-m2b-assisted-publishing-and-scheduler/progress.md` (P1–P5 and the Task-N rulings).

**Depends on:** M2a and M2b completed on branch `feat/m2-one-click-posting` (HEAD `3de6b7b`, 801 tests green).

**Issues covered:** #65 (Task 1) · #26 (Tasks 2 and 3) · #27 (Task 4) · epic #67 — #68 (Task 5), #69 (Tasks 6 and 7), #70 (Task 8), #71 (Task 9) · acceptance and docs (Task 10).

**Not pre-verified:** unlike M2b, this plan's code was written against the current source (read file by file) but not applied to a scratch copy. Where a signature in the repo differs from what a step shows, make the minimal correction and report it in the task's review notes.

## Global Constraints

- All M1, M2a and M2b constraints apply: SafeWriter for every frontmatter write, `transition()` for every status change, fresh-frontmatter plans inside `updateVariant`, per-key delivery patches (never a whole `deliveries` map), Notices with Undo for user writes, real controls, `setIcon`, no emoji in the UI, Obsidian CSS variables, `TZ=Europe/Berlin` in tests.
- **Rulings P1–P5 and the M2b Task-N rulings still hold.** In particular: `publishing` and `check_needed` are **never** auto-retried (P4); every delivery write goes through `SafeWriter` per key; **unreadable delivery entries stay frozen**: they are never published, marked, reminded about or booked on ntfy.
- **Only the publisher device** (spec §4.3) dispatches, marks overdue, runs the startup reconcile, books ntfy reminders and pushes result alerts. Desktop reminders still fire on every device where they are enabled. The device id and name live in device-local storage (`app.saveLocalStorage("osmm-device")`) and are never synced; the synced `data.json` records only `publisher: { deviceId, name, since } | null`.
- **HTTP only through `requestUrl` from `obsidian`** (works on mobile, no CORS). The ntfy client takes an injectable `http` function; tests use the fake `requestUrl` in `test/fakes/obsidian.ts` (`requestUrlMock.queue` / `requestUrlMock.calls`). No real network in tests.
- **Secrets only in `app.secretStorage`** through `Secrets`: `osmm-ntfy-topic` and `osmm-ntfy-token`. They are never written to `data.json`, `localStorage`, vault files, `_log.md`, Notices, thrown error messages or the console. The ntfy client scrubs both from every error it raises; the log redacts every known secret.
- **ntfy limits (spec §4.4, §10):** delayed delivery at most 3 days on ntfy.sh → booking window `72 h − 10 min`; minimum delay 10 s (anything sooner is sent without a delay); at most 3 action buttons; at most 20 bookings per run; a failed run pauses booking 5 minutes (or the server's `Retry-After`, if longer) and warns once per failure streak. Cancelling uses `DELETE <server>/<topic>/<message id>`; when the server refuses it, the stale push is left alone and the new time gets a fresh booking.
- **Publish log (spec §2.5, §5.6):** `<root>/_log.md`, one Markdown list line per attempt: time · channel · `[[variant]]` · result · URL or error. Appends are serialized. The first entry of a new month moves the previous month's file to `<root>/_log/YYYY-MM.md`.
- **Mobile (#27):** `manifest.json` keeps `"isDesktopOnly": false`. Electron/Node-only code (`window.require("electron")`, `Buffer`, `app.showInFolder`, system `Notification`) runs only behind `Platform.isDesktopApp`. No `crypto.randomUUID` (missing on older iOS WebViews): ids come from `crypto.getRandomValues`.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A post rescheduled, published early or skipped after its phone reminders were booked.** The old pushes must be cancelled where the server supports it, otherwise left alone, and the new time booked once; no key is ever booked twice. Tests in Task 7.
2. **Two devices open at once, or a takeover while the old publisher still runs.** Only the device recorded in the synced settings dispatches or books; a device that loses the role withdraws its own bookings; a device that gains it runs the startup reconcile (stuck `publishing` → `check_needed`, never retried). Tests in Tasks 2 and 7.
3. **The ntfy server is down, rate-limits, or rejects the token.** No request storm every 30 seconds (5-minute pause), one warning per streak, desktop reminders unaffected, and no error text ever contains the topic or the token. Tests in Tasks 5 and 7.
4. **Several channels finishing at the same moment, and the month boundary.** Log lines must not interleave or get lost, user edits to `_log.md` must survive, and an entry that arrives slightly out of order across midnight on the 1st must not archive the wrong month. Tests in Task 1.
5. **Tapping a phone reminder when Obsidian starts cold, or when the post is already out.** The `obsidian://osmm-post` link must wait until the index is ready, then open the assisted flow once, or say there is nothing left to post; it never marks anything by itself. Tests in Task 8.

## Decisions made while writing this plan (spec gaps)

- **No publisher by default.** A fresh install (or an upgrade from M2, where every device published) has `publisher: null`: nothing is dispatched or marked overdue until the user picks a device. A startup notice, the sidebar banner and the settings offer "Make this device the publisher". Auto-claiming was rejected: two devices starting inside one sync window would both claim and could post twice (spec §1.3.5).
- **Takeover is immediate on this device and reaches the other one through sync.** The confirmation says so; the gap cannot be closed without a server.
- **Log rollover is monthly, always** (not size-based): `_log.md` holds the current month, older months live in `_log/YYYY-MM.md`. An entry older than the file's first month is simply appended (no re-archiving).
- **ntfy topic and token are per device secrets; server, on/off and "results" are device-local settings.** Only the publisher books, and spec §2.6 says each publishing device is set up on its own.
- **Cancel by message id.** ntfy cancels a delayed message with `DELETE /<topic>/<sequence id>`, and a message published without a sequence id uses its message id. Servers that answer 400/404/405 are treated as "cannot cancel" (spec §4.4 fallback). Verify once against ntfy.sh during QA (docs/qa/m3.md).
- **Notification actions (artboard 7 vs #70):** tapping the notification opens the pre-filled platform page (mobile deep link preferred). Buttons: **Copy & open** (`obsidian://osmm-post`, opens the assisted flow on the phone, which copies and opens), **Open note** (`obsidian://open`), and **Snooze 10 min** (an ntfy `http` action that re-posts the same push with a 10-minute delay). With an access token the snooze would need the token inside the notification, so the third button becomes **Done** (the assisted flow at step 3, paste the link) instead. ntfy's `copy` action is not used: its docs say it is not shown on iOS.
- **Changing the server, topic or token forgets the ledger without cancelling** (the old target's credentials are gone); turning phone reminders off or choosing "New topic" cancels first. A stale push to an old topic can still arrive for up to 72 h.
- **Recorded fixtures:** ntfy responses in `test/reminders/ntfy/fixtures.ts` follow ntfy's documented JSON (`{id, time, expires, event, topic, …}` and `{code, http, error, link}`); the QA checklist asks to replace them with captured responses.

---

## File Structure

```
src/publish/vaultLog.ts               VaultLog (AttemptLog → <root>/_log.md), formatLogLine(), monthKey(), LOG_HEADER
src/model/ids.ts                      randomString(), newDeviceId() (getRandomValues, mobile-safe)
src/settings/publisher.ts             PublisherService, publisherState(), publisherDescription(), takeoverMessage()
src/views/PublisherBanner.svelte      "Publishing happens on <device>" / "No device publishes" banner
src/planner/agenda.ts                 agendaDays()
src/views/AgendaView.svelte           phone agenda for month/week
src/reminders/ntfy/config.ts          NtfyConfig, DEFAULT_NTFY_SERVER, TOPIC_RE, normalizeServer(), randomTopic(), ntfyTarget()
src/reminders/ntfy/client.ts          NtfyClient, NtfyMessage, NtfyAction, NtfyError, testMessage()
src/reminders/ntfy/bookings.ts        BookingLedger (device-local), Booking
src/reminders/ntfy/booker.ts          NtfyBooker, BOOKING_WINDOW_MS, MAX_BOOKINGS_PER_RUN, RETRY_MS
src/reminders/ntfy/content.ts         reminderMessage(), failureMessage(), publishedMessage(), postUri(), openNoteUri(), POST_ACTION
src/reminders/ntfy/alerts.ts          PhoneAlerts
docs/qa/m3.md
test/publish/vaultLog.test.ts, test/settings/publisher.test.ts, test/views/publisherBanner.test.ts,
test/mobile.test.ts, test/views/agenda.test.ts, test/reminders/ntfy/{fixtures.ts,client.test.ts,bookings.test.ts,booker.test.ts,content.test.ts,alerts.test.ts}
```

Modified: `src/main.ts`, `src/publish/log.ts` (comment), `src/secrets/secrets.ts` (`ntfyTopic`, `allSecretIds`), `src/settings/settings.ts` (schema 3, `publisher`), `src/settings/device.ts` (`deviceName`, `ntfy`), `src/settings/tab.ts`, `src/scheduler/scheduler.ts` (doc comment), `src/ui/context.ts` (`publisher`), `src/views/Sidebar.svelte`, `src/views/Planner.svelte`, `src/publish/clipboard.ts`, `src/reminders/notifier.ts`, `src/reminders/reminders.ts` (`reminderSlots`, `fireTime`), `src/publish/orchestrator.ts` (`onPublished`), `src/publish/actions.ts` (`DeliveryNotifier.published`), `src/styles/planner.css`, `src/styles/composer.css`, `test/fakes/obsidian.ts` (`Platform`, `setPlatform`, `requestUrlMock.calls/reset`, `registerObsidianProtocolHandler`, `Vault.getName`), `test/setup.ts`, `test/ui/ctx.ts`, `test/main.test.ts`, `test/settings/settings.test.ts`, `test/secrets/secrets.test.ts`, `test/reminders/reminders.test.ts`, `README.md`, `docs/getting-started.md`.

---

### Task 1: Publish audit log in `Social/_log.md` (#65)

**Files:**
- Create: `src/publish/vaultLog.ts`, `test/publish/vaultLog.test.ts`
- Modify: `src/publish/log.ts` (comment only), `src/secrets/secrets.ts`, `src/main.ts`, `test/secrets/secrets.test.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: `AttemptEntry`, `AttemptLog` (`src/publish/log.ts`); `formatDateTime` (`src/model/dates.ts`); `Secrets.redact(text, ids)`; `ChannelRegistry.list()/get()`.
- Produces:
  - `SecretIds.ntfyTopic = "osmm-ntfy-topic"`; `allSecretIds(channels: readonly Channel[]): string[]` — every secret id the plugin may hold (channel secrets, ntfy topic and token, OpenAI key, MCP bearer).
  - `monthKey(ms: number): string` (`"2026-10"`, local time); `formatLogLine(entry: AttemptEntry, channelName: string, redact: (t: string) => string): string`; `LOG_HEADER: string`.
  - `interface VaultLogDeps { app: App; rootFolder(): string; redact(text: string): string; channelName(channelId: string): string; warn(message: string): void }`
  - `class VaultLog implements AttemptLog { readonly path: string (getter); archivePath(month: string): string; append(entry): Promise<void> /* never rejects */; flush(): Promise<void> }`.
  - `OsmmPlugin.log: VaultLog` (was `MemoryLog`; `MemoryLog` stays for tests via `test/ui/ctx.ts`).

- [ ] **Step 1: Write the failing tests**

`test/publish/vaultLog.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App } from "../fakes/obsidian";
import { SecretIds, Secrets } from "../../src/secrets/secrets";
import { formatLogLine, LOG_HEADER, monthKey, VaultLog, type VaultLogDeps } from "../../src/publish/vaultLog";
import type { AttemptEntry } from "../../src/publish/log";

const OCT = Date.UTC(2026, 9, 8, 15, 30); // Thu 8 Oct 2026, 17:30 Berlin
const NOV = Date.UTC(2026, 10, 2, 8, 0); // Mon 2 Nov 2026, 09:00 Berlin
const entry = (over: Partial<AttemptEntry> = {}): AttemptEntry => ({
  at: OCT,
  path: "Social/Event X/Event X – LinkedIn.md",
  channelId: "li/acme",
  result: "published",
  url: "https://www.linkedin.com/feed/update/urn:li:share:1",
  ...over,
});

function build(over: Partial<VaultLogDeps> = {}) {
  const app = new App();
  const secrets = new Secrets(app as never);
  const warnings: string[] = [];
  const log = new VaultLog({
    app: app as never,
    rootFolder: () => "Social",
    redact: (text) => secrets.redact(text, [SecretIds.ntfyTopic, SecretIds.ntfyToken, "osmm-channel-li-acme"]),
    channelName: (id) => (id === "li/acme" ? "Acme Studio" : id),
    warn: (m) => void warnings.push(m),
    ...over,
  });
  const read = async (path = "Social/_log.md") => {
    const file = app.vault.getFileByPath(path);
    return file ? app.vault.read(file) : null;
  };
  return { app, secrets, log, warnings, read };
}

describe("formatLogLine", () => {
  it("writes time, channel, variant link, result and URL on one line", () => {
    expect(formatLogLine(entry(), "Acme Studio", (t) => t)).toBe(
      "- 2026-10-08T17:30:00+02:00 · Acme Studio (li/acme) · [[Social/Event X/Event X – LinkedIn]] · published · https://www.linkedin.com/feed/update/urn:li:share:1",
    );
  });

  it("flattens multi-line errors, strips link syntax and caps the length", () => {
    const line = formatLogLine(entry({ result: "failed", url: undefined, error: `Bad [[thing]]\n  | ${"x".repeat(400)}` }), "li/acme", (t) => t);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("[[thing");
    expect(line.startsWith("- 2026-10-08T17:30:00+02:00 · li/acme · [[Social/Event X/Event X – LinkedIn]] · failed · Bad thing / xxx")).toBe(true);
    expect(line.length).toBeLessThan(420);
  });

  it("labels every result", () => {
    expect(formatLogLine(entry({ result: "retry", url: undefined, error: "503" }), "x", (t) => t)).toContain(" · failed, will retry · 503");
    expect(formatLogLine(entry({ result: "check_needed", url: undefined }), "x", (t) => t)).toContain(" · check needed");
  });

  it("keys months in local time", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe("2026-11"); // 00:30 on 1 Nov in Berlin
  });
});

describe("VaultLog", () => {
  it("creates Social/_log.md with a header and appends one line per attempt", async () => {
    const { log, read } = build();
    await log.append(entry());
    await log.append(entry({ channelId: "li/me", result: "awaiting_you", url: undefined }));
    expect(await read()).toBe(
      `${LOG_HEADER}- 2026-10-08T17:30:00+02:00 · Acme Studio (li/acme) · [[Social/Event X/Event X – LinkedIn]] · published · https://www.linkedin.com/feed/update/urn:li:share:1\n` +
        "- 2026-10-08T17:30:00+02:00 · li/me · [[Social/Event X/Event X – LinkedIn]] · waiting for you\n",
    );
  });

  it("serializes appends that race (review focus 4)", async () => {
    const { log, read } = build();
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(entry({ at: OCT + i * 1000, url: `https://example.com/${i}` }))));
    const lines = (await read())!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(20);
    expect(lines.map((l) => l.split("/").pop())).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it("never writes a secret", async () => {
    const { log, read, secrets } = build();
    secrets.set(SecretIds.ntfyTopic, "osmm-SECRETTOPIC123");
    secrets.set("osmm-channel-li-acme", "tok_ABCDEF");
    await log.append(entry({ result: "failed", url: "https://ntfy.sh/osmm-SECRETTOPIC123", error: "401 for tok_ABCDEF" }));
    const text = (await read())!;
    expect(text).not.toContain("SECRETTOPIC123");
    expect(text).not.toContain("tok_ABCDEF");
    expect(text).toContain("401 for •••");
  });

  it("keeps the user's own edits to the log", async () => {
    const { app, log, read } = build();
    await log.append(entry());
    const file = app.vault.getFileByPath("Social/_log.md")!;
    await app.vault.modify(file, `${await app.vault.read(file)}Note to self: LinkedIn was slow today`);
    await log.append(entry({ at: OCT + 60_000 }));
    expect(await read()).toContain("Note to self: LinkedIn was slow today\n- 2026-10-08T17:31:00+02:00");
  });

  it("moves last month to _log/YYYY-MM.md on the first entry of a new month (review focus 4)", async () => {
    const { log, read } = build();
    await log.append(entry());
    await log.append(entry({ at: NOV }));
    expect(await read("Social/_log/2026-10.md")).toContain("- 2026-10-08T17:30:00+02:00");
    expect(await read()).toBe(`${LOG_HEADER}${formatLogLine(entry({ at: NOV }), "Acme Studio", (t) => t)}\n`);
  });

  it("appends an entry older than the file's month instead of archiving again", async () => {
    const { log, read } = build();
    await log.append(entry({ at: NOV }));
    await log.append(entry({ at: OCT }));
    expect(await read("Social/_log/2026-11.md")).toBeNull();
    expect((await read())!.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("merges into an existing archive", async () => {
    const { app, log, read } = build();
    await app.vault.createFolder("Social/_log");
    await app.vault.create("Social/_log/2026-10.md", "- 2026-10-01T09:00:00+02:00 · earlier\n");
    await app.vault.create("Social/_log.md", `${LOG_HEADER}- 2026-10-20T09:00:00+02:00 · later\n`);
    await log.append(entry({ at: NOV }));
    expect(await read("Social/_log/2026-10.md")).toBe("- 2026-10-01T09:00:00+02:00 · earlier\n- 2026-10-20T09:00:00+02:00 · later\n");
    expect(await read()).toContain("2026-11-02T09:00:00+01:00");
  });

  it("warns once per failure streak and keeps working afterwards", async () => {
    const { app, log, read, warnings } = build();
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async () => {
      throw new Error("disk full");
    };
    await log.append(entry());
    await log.append(entry());
    expect(warnings).toEqual(["Couldn't write to the publish log: disk full"]);
    app.vault.create = create;
    await log.append(entry());
    expect(await read()).toContain("published");
    app.vault.create = async () => {
      throw new Error("disk full");
    };
    await app.vault.delete(app.vault.getFileByPath("Social/_log.md")!);
    await log.append(entry());
    expect(warnings).toHaveLength(2);
  });

  it("follows the configured root folder", async () => {
    const { log, read } = build({ rootFolder: () => "Content/Social" });
    await log.append(entry());
    expect(await read("Content/Social/_log.md")).toContain("published");
  });
});
```

Add to `test/secrets/secrets.test.ts` (inside `describe("secret ids", …)`):
```ts
  it("lists every secret id the plugin may hold, for redaction", () => {
    const channel = { id: "tg/event-x", platform: "telegram", name: "Event X", kind: "server_channel", avatarColor: "#000", method: "api", secretId: "osmm-channel-tg-event-x" } as never;
    expect(allSecretIds([channel])).toEqual(["osmm-channel-tg-event-x", "osmm-ntfy-topic", "osmm-ntfy-token", "osmm-openai-key", "osmm-mcp-bearer"]);
  });
```
and change its import to `import { allSecretIds, SecretIds, Secrets, toSecretId } from "../../src/secrets/secrets";`.

Add to `test/main.test.ts` (inside `describe("OsmmPlugin", …)`):
```ts
  it("records publish attempts in Social/_log.md (#65)", async () => {
    const { app, plugin } = await loaded();
    await plugin.log.append({ at: Date.UTC(2026, 9, 8, 15, 30), path: "Social/Posts/A.md", channelId: "li/me", result: "published", url: "https://www.linkedin.com/feed/update/1" });
    const file = app.vault.getFileByPath("Social/_log.md")!;
    expect(await app.vault.read(file)).toContain("- 2026-10-08T17:30:00+02:00 · li/me · [[Social/Posts/A]] · published · https://www.linkedin.com/feed/update/1");
    plugin.unload();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/publish/vaultLog.test.ts test/secrets/secrets.test.ts test/main.test.ts`
Expected: FAIL — `src/publish/vaultLog` is missing, `allSecretIds` is not exported.

- [ ] **Step 3: Add the secret ids**

In `src/secrets/secrets.ts`, add `import type { Channel } from "../model/types";` at the top, replace the `SecretIds` object with:
```ts
export const SecretIds = {
  channel: (channelId: string) => toSecretId("osmm", "channel", channelId),
  ntfyTopic: "osmm-ntfy-topic",
  ntfyToken: "osmm-ntfy-token",
  openaiKey: "osmm-openai-key",
  mcpBearer: "osmm-mcp-bearer",
} as const;

/** Every secret id the plugin may hold; text that leaves the plugin (log, notices) is redacted against all of them. */
export function allSecretIds(channels: readonly Channel[]): string[] {
  const ids = channels.flatMap((c) => (c.secretId ? [c.secretId] : []));
  return [...new Set([...ids, SecretIds.ntfyTopic, SecretIds.ntfyToken, SecretIds.openaiKey, SecretIds.mcpBearer])];
}
```

- [ ] **Step 4: Write the vault log**

`src/publish/vaultLog.ts`:
```ts
import { normalizePath, type App, type TFile } from "obsidian";
import { formatDateTime } from "../model/dates";
import type { AttemptEntry, AttemptLog } from "./log";

export interface VaultLogDeps {
  app: App;
  rootFolder(): string;
  /** Removes every known secret value from a piece of text (spec §2.6). */
  redact(text: string): string;
  channelName(channelId: string): string;
  /** Reports a failed append (a Notice in the plugin); called once per failure streak. */
  warn(message: string): void;
}

export const LOG_HEADER =
  "# Publish log\n\nOne line per publish attempt, oldest first: time · channel · post · result · link or error. Written by Social Planner; earlier months move to the _log folder.\n\n";

const RESULT_LABEL: Readonly<Record<AttemptEntry["result"], string>> = {
  published: "published",
  failed: "failed",
  retry: "failed, will retry",
  skipped: "skipped",
  awaiting_you: "waiting for you",
  overdue: "overdue",
  check_needed: "check needed",
};

/** First entry line of a log file: "- 2026-10-08T…". */
const ENTRY_MONTH_RE = /^- (\d{4}-\d{2})-\d{2}T/m;
const MAX_ERROR = 300;

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** One line stays one line: whitespace collapses, `[[`/`]]` go, and `|` can't open a table or alias. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\[\[|\]\]/g, "").replace(/\|/g, "/").trim();
}

export function formatLogLine(entry: AttemptEntry, channelName: string, redact: (text: string) => string): string {
  const clean = (text: string) => flat(redact(text));
  const channel = channelName && channelName !== entry.channelId ? `${clean(channelName)} (${clean(entry.channelId)})` : clean(entry.channelId);
  const parts = [formatDateTime(entry.at), channel, `[[${clean(entry.path.replace(/\.md$/, ""))}]]`, RESULT_LABEL[entry.result]];
  if (entry.url) parts.push(clean(entry.url));
  if (entry.error) parts.push(clean(entry.error).slice(0, MAX_ERROR));
  return `- ${parts.join(" · ")}`;
}

/**
 * Spec §5.6: every attempt is appended to `<root>/_log.md`. Appends run one after another (a promise
 * queue), so lines never interleave; the file is read-modify-written with `vault.process`, so the user's
 * own edits stay. The first entry of a newer month moves the file to `<root>/_log/YYYY-MM.md`.
 */
export class VaultLog implements AttemptLog {
  private queue: Promise<void> = Promise.resolve();
  private failing = false;

  constructor(private readonly deps: VaultLogDeps) {}

  get path(): string {
    return normalizePath(`${this.deps.rootFolder()}/_log.md`);
  }

  archivePath(month: string): string {
    return normalizePath(`${this.deps.rootFolder()}/_log/${month}.md`);
  }

  /** Never rejects: a failed write is reported through `warn` (the publish itself already happened). */
  append(entry: AttemptEntry): Promise<void> {
    const line = formatLogLine(entry, this.deps.channelName(entry.channelId), (t) => this.deps.redact(t));
    const month = monthKey(entry.at);
    this.queue = this.queue
      .then(() => this.write(line, month))
      .then(
        () => {
          this.failing = false;
        },
        (e: unknown) => {
          if (this.failing) return;
          this.failing = true;
          this.deps.warn(`Couldn't write to the publish log: ${this.deps.redact(e instanceof Error ? e.message : String(e))}`);
        },
      );
    return this.queue;
  }

  /** Resolves once every append queued so far is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  private async write(line: string, month: string): Promise<void> {
    const { vault } = this.deps.app;
    let file: TFile | null = vault.getFileByPath(this.path);
    if (file) {
      const first = ENTRY_MONTH_RE.exec(await vault.read(file))?.[1];
      if (first && first < month) {
        await this.archive(file, first);
        file = null;
      }
    }
    if (!file) {
      await this.ensureFolderOf(this.path);
      await vault.create(this.path, `${LOG_HEADER}${line}\n`);
      return;
    }
    await vault.process(file, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  private async archive(file: TFile, month: string): Promise<void> {
    const { vault } = this.deps.app;
    const target = this.archivePath(month);
    const existing = vault.getFileByPath(target);
    if (!existing) {
      await this.ensureFolderOf(target);
      await vault.rename(file, target);
      return;
    }
    const lines = (await vault.read(file))
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .join("\n");
    await vault.process(existing, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines}\n`);
    await this.deps.app.fileManager.trashFile(file);
  }

  private async ensureFolderOf(filePath: string): Promise<void> {
    const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (!dir || this.deps.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.deps.app.vault.createFolder(dir);
    } catch {
      // created by a concurrent write
    }
  }
}
```

In `src/publish/log.ts`, replace the comment above `AttemptLog` with:
```ts
/** Every publish attempt is recorded (spec §5.6). The plugin appends to `<root>/_log.md` (VaultLog); tests use MemoryLog. */
```

- [ ] **Step 5: Wire it into the plugin**

In `src/main.ts`:
- replace `import { MemoryLog } from "./publish/log";` with `import { VaultLog } from "./publish/vaultLog";`
- replace `import { Secrets } from "./secrets/secrets";` with `import { allSecretIds, Secrets } from "./secrets/secrets";`
- replace the field `readonly log = new MemoryLog();` with `log!: VaultLog;`
- directly after the `this.channels = new ChannelRegistry({ … });` statement, add:
```ts
    this.log = new VaultLog({
      app: this.app,
      rootFolder: () => this.settings.rootFolder,
      redact: (text) => this.secrets.redact(text, allSecretIds(this.channels.list())),
      channelName: (id) => this.channels.get(id)?.name ?? id,
      warn: (message) => new Notice(message, 0),
    });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/publish/vaultLog.test.ts test/secrets/secrets.test.ts test/main.test.ts && npm test`
Expected: PASS (all suites; `test/ui/ctx.ts` still uses `MemoryLog`).

- [ ] **Step 7: Commit**

```bash
git add src/publish/vaultLog.ts src/publish/log.ts src/secrets/secrets.ts src/main.ts test/publish/vaultLog.test.ts test/secrets/secrets.test.ts test/main.test.ts
git commit -m "feat(publish): append every publish attempt to Social/_log.md with monthly archives (#65)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Publisher device — model, gating and two-device tests (#26)

**Files:**
- Create: `src/model/ids.ts`, `src/settings/publisher.ts`, `test/settings/publisher.test.ts`
- Modify: `src/settings/settings.ts` (schema 3, `publisher`), `src/settings/device.ts` (`deviceName`, mobile-safe id), `src/scheduler/scheduler.ts` (doc comment), `src/main.ts`, `test/fakes/obsidian.ts` (`Platform`, `setPlatform`), `test/setup.ts`, `test/settings/settings.test.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: `Scheduler` (`isPublisher`, `reconcile`, `tick`), `loadDeviceSettings`, `migrateSettings`, `OsmmPlugin.updateSettings`.
- Produces:
  - `randomString(length: number, alphabet?: string): string`; `newDeviceId(): string` (UUID v4 shape from `crypto.getRandomValues`).
  - `DeviceSettings.deviceName: string`; `defaultDeviceName(): string` (from `Platform`: "iPhone", "iPad", "Android phone", "Android tablet", "Mac", "Windows PC", "Linux PC", "This device"); `cleanDeviceName(raw: unknown): string | null` (trimmed, ≤ 40 chars).
  - `SETTINGS_VERSION = 3`; `interface PublisherRecord { deviceId: string; name: string; since: number }`; `OsmmSettings.publisher: PublisherRecord | null` (default `null`).
  - `type PublisherState = { kind: "this" } | { kind: "other"; name: string; since: number } | { kind: "none" }`; `publisherState(publisher, deviceId)`; `publisherDescription(state): string`; `takeoverMessage(name): string`.
  - `interface PublisherDeps { device(): Pick<DeviceSettings, "deviceId" | "deviceName">; settings(): Pick<OsmmSettings, "publisher">; update(patch: { publisher: PublisherRecord | null }): Promise<void>; now(): number }`
  - `class PublisherService { readonly deviceId: string (getter); state(); isPublisher(); claim(); takeOver(confirm: (message: string) => Promise<boolean>): Promise<boolean>; release(); renamed() }`.
  - `OsmmPlugin.publisher: PublisherService`; the scheduler's `isPublisher` reads it; when this device becomes the publisher after start-up, the plugin runs `scheduler.reconcile()` then `tick()`.
  - Test fake: `Platform` (desktop Mac by default) and `setPlatform(kind: "desktop" | "iphone" | "android")`, reset before every test.

- [ ] **Step 1: Add the Platform fake**

In `test/fakes/obsidian.ts`, after `export const moment = momentLib;`, add:
```ts
const DESKTOP_PLATFORM = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
  isSafari: false,
  resourcePathPrefix: "app://local/",
};

/** Mutable copy of Obsidian's `Platform`; tests switch it with `setPlatform` (reset to desktop before each test). */
export const Platform = { ...DESKTOP_PLATFORM };

export function setPlatform(kind: "desktop" | "iphone" | "android"): void {
  Object.assign(Platform, DESKTOP_PLATFORM);
  if (kind === "desktop") return;
  Object.assign(Platform, {
    isDesktop: false,
    isMobile: true,
    isDesktopApp: false,
    isMobileApp: true,
    isPhone: true,
    isIosApp: kind === "iphone",
    isAndroidApp: kind === "android",
    isMacOS: kind === "iphone",
    isSafari: kind === "iphone",
    resourcePathPrefix: "file:///",
  });
}
```

Replace `test/setup.ts`'s first lines (imports and `beforeEach`) with:
```ts
import { beforeEach } from "vitest";
import { installBrowserFakes, resetBrowserFakes } from "./fakes/browser";
import { setPlatform } from "./fakes/obsidian";

installBrowserFakes();
beforeEach(() => {
  resetBrowserFakes();
  setPlatform("desktop");
});
```

- [ ] **Step 2: Write the failing tests**

`test/settings/publisher.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { App, setPlatform } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { newDeviceId, randomString } from "../../src/model/ids";
import type { DueItem } from "../../src/scheduler/due";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanDeviceName, defaultDeviceName, loadDeviceSettings } from "../../src/settings/device";
import { PublisherService, publisherDescription, publisherState } from "../../src/settings/publisher";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { makeCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin

/** Two devices sharing one synced data.json, each with its own device-local storage. */
function twoDevices() {
  let synced: OsmmSettings = migrateSettings(null);
  const device = (app: App) => {
    const local = loadDeviceSettings(app as never);
    return new PublisherService({
      device: () => local,
      settings: () => synced,
      update: async (patch) => {
        synced = migrateSettings({ ...synced, ...patch });
      },
      now: () => T,
    });
  };
  return { laptop: device(new App()), phone: device(new App()), synced: () => synced };
}

describe("ids", () => {
  it("makes UUID-shaped device ids and random strings without randomUUID", () => {
    expect(newDeviceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newDeviceId()).not.toBe(newDeviceId());
    expect(randomString(24)).toMatch(/^[a-z0-9]{24}$/);
  });
});

describe("device name", () => {
  it("defaults to the kind of device and is editable", () => {
    expect(defaultDeviceName()).toBe("Mac");
    setPlatform("iphone");
    expect(defaultDeviceName()).toBe("iPhone");
    setPlatform("android");
    expect(defaultDeviceName()).toBe("Android phone");
    expect(cleanDeviceName("  Studio   iMac ")).toBe("Studio iMac");
    expect(cleanDeviceName("   ")).toBeNull();
    expect(cleanDeviceName("x".repeat(60))).toHaveLength(40);
  });

  it("is stored on the device, next to the device id", () => {
    const app = new App();
    const first = loadDeviceSettings(app as never);
    expect(first.deviceName).toBe("Mac");
    expect(app.loadLocalStorage("osmm-device")).toMatchObject({ deviceId: first.deviceId, deviceName: "Mac" });
  });
});

describe("PublisherService", () => {
  it("nobody publishes until a device is chosen", () => {
    const { laptop, phone } = twoDevices();
    expect([laptop.isPublisher(), phone.isPublisher()]).toEqual([false, false]);
    expect(laptop.state()).toEqual({ kind: "none" });
  });

  it("only the claimed device publishes; the other one sees its name (two fake devices)", async () => {
    const { laptop, phone, synced } = twoDevices();
    await laptop.claim();
    expect(synced().publisher).toEqual({ deviceId: laptop.deviceId, name: "Mac", since: T });
    expect(laptop.isPublisher()).toBe(true);
    expect(phone.isPublisher()).toBe(false);
    expect(phone.state()).toEqual({ kind: "other", name: "Mac", since: T });
  });

  it("asks before taking over, and moves the role only when confirmed", async () => {
    const { laptop, phone } = twoDevices();
    await laptop.claim();
    const asked: string[] = [];
    expect(await phone.takeOver(async (m) => (asked.push(m), false))).toBe(false);
    expect(laptop.isPublisher()).toBe(true);
    expect(asked[0]).toMatch(/^Publishing happens on Mac\. Make this device the publisher instead\?/);
    expect(await phone.takeOver(async () => true)).toBe(true);
    expect([laptop.isPublisher(), phone.isPublisher()]).toEqual([false, true]);
  });

  it("claims without asking when no device publishes", async () => {
    const { laptop } = twoDevices();
    let asked = false;
    await laptop.takeOver(async () => (asked = true));
    expect(asked).toBe(false);
    expect(laptop.isPublisher()).toBe(true);
  });

  it("releases the role only on the publisher", async () => {
    const { laptop, phone, synced } = twoDevices();
    await laptop.claim();
    await phone.release();
    expect(laptop.isPublisher()).toBe(true);
    await laptop.release();
    expect(synced().publisher).toBeNull();
  });

  it("keeps the synced name in step after a rename", async () => {
    let synced = migrateSettings(null);
    const local = { deviceId: "d1", deviceName: "Mac" };
    const service = new PublisherService({ device: () => local, settings: () => synced, update: async (p) => void (synced = { ...synced, ...p }), now: () => T });
    await service.renamed();
    expect(synced.publisher).toBeNull();
    await service.claim();
    local.deviceName = "Studio iMac";
    await service.renamed();
    expect(synced.publisher).toEqual({ deviceId: "d1", name: "Studio iMac", since: T });
  });

  it("describes each state", () => {
    expect(publisherState(null, "a")).toEqual({ kind: "none" });
    expect(publisherDescription({ kind: "other", name: "Work laptop", since: 0 })).toContain("Publishing happens on Work laptop.");
    expect(publisherDescription({ kind: "this" })).toContain("This device posts scheduled items");
  });
});

describe("Scheduler on two devices (#26 acceptance)", () => {
  it("runs deliveries only on the publisher", async () => {
    const A = "Social/Posts/A.md";
    const c = await makeCtx({
      notes: [{ path: A, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(T), deliveries: { "bs/you": { status: "scheduled" } } }, body: "Hi" }],
      now: T,
    });
    const { laptop, phone } = twoDevices();
    await laptop.claim();
    const run = (who: PublisherService) => {
      const dispatched: string[] = [];
      const scheduler = new Scheduler({
        index: c.index,
        settings: () => get(c.settings),
        now: () => T,
        isPublisher: () => who.isPublisher(),
        autoPostLateMs: () => null,
        publish: {
          dispatch: async (i: DueItem) => void dispatched.push(i.key),
          markOverdue: async () => undefined,
          markCheckNeeded: async () => false,
          resolveCheck: async () => undefined,
        },
        warn: () => undefined,
      });
      return { scheduler, dispatched };
    };
    const onPhone = run(phone);
    const onLaptop = run(laptop);
    await onPhone.scheduler.tick();
    await onLaptop.scheduler.tick();
    expect(onPhone.dispatched).toEqual([]);
    expect(onLaptop.dispatched).toEqual([`${A}#bs/you@${T}`]);
  });
});
```

In `test/settings/settings.test.ts`: change the three `toBe(2)` schema expectations to `toBe(3)`, rename the test "migrates v1 settings to v2 with default templates" to "migrates v1 settings to v3 with default templates", and add inside `describe("migrateSettings", …)`:
```ts
  it("migrates v2 settings to v3 with no publisher device", () => {
    expect(migrateSettings({ schemaVersion: 2, rootFolder: "Social" }).publisher).toBeNull();
  });

  it("keeps a valid publisher record and drops a malformed one", () => {
    const publisher = { deviceId: "d-1", name: "Studio iMac", since: 5 };
    expect(migrateSettings({ schemaVersion: 3, publisher }).publisher).toEqual(publisher);
    expect(migrateSettings({ schemaVersion: 3, publisher: { name: "x" } }).publisher).toBeNull();
    expect(migrateSettings({ schemaVersion: 3, publisher: { deviceId: "d-1", name: " ", since: "x" } }).publisher).toEqual({ deviceId: "d-1", name: "another device", since: 0 });
  });
```

Add to `test/main.test.ts` (import `indexed` and `writeNote` from `./helpers` next to `nextChange, settle`):
```ts
  it("runs the startup check once this device becomes the publisher (#26)", async () => {
    const app = new App();
    await writeNote(app as never, "Social/Posts/P.md", {
      type: "social-post",
      platform: "bluesky",
      channels: ["bs/you"],
      status: "scheduled",
      scheduled_at: "2026-10-08T10:00:00+02:00",
      deliveries: { "bs/you": { status: "publishing", at: "2026-10-08T10:00:00+02:00" } },
    }, "Hi");
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    await settle(20);
    expect(plugin.publisher.isPublisher()).toBe(false);
    expect(plugin.index.getVariant("Social/Posts/P.md")?.deliveries["bs/you"]?.status).toBe("publishing");
    await plugin.publisher.claim();
    await indexed(plugin.index, () => plugin.index.getVariant("Social/Posts/P.md")?.deliveries["bs/you"]?.status === "check_needed");
    plugin.unload();
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/settings test/main.test.ts`
Expected: FAIL — `src/model/ids`, `src/settings/publisher` missing; schema is 2.

- [ ] **Step 4: Write the ids and the device settings**

`src/model/ids.ts`:
```ts
/**
 * Random ids from `crypto.getRandomValues`, which every Obsidian platform has
 * (`crypto.randomUUID` is missing on older iOS WebViews, #27).
 */
export function randomString(length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string {
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  const byte = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(byte);
    if (byte[0]! < limit) out.push(alphabet[byte[0]! % alphabet.length]!);
  }
  return out.join("");
}

export function newDeviceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
```

Replace `src/settings/device.ts` with:
```ts
import { Platform, type App } from "obsidian";
import { isRecord } from "../model/frontmatter";
import { newDeviceId } from "../model/ids";

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
  /** Shown on other devices as "Publishing happens on <name>" (spec §4.3). */
  deviceName: string;
  /** Desktop notifications on this device (spec §4.3: each device fires its own if enabled). */
  notifications: boolean;
}

const KEY = "osmm-device";
const MAX_NAME = 40;

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows PC";
  if (Platform.isLinux) return "Linux PC";
  return "This device";
}

export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return name || null;
}

function sanitize(raw: Record<string, unknown>, deviceId: string): DeviceSettings {
  return {
    deviceId,
    deviceName: cleanDeviceName(raw.deviceName) ?? defaultDeviceName(),
    notifications: raw.notifications !== false,
  };
}

export function loadDeviceSettings(app: App): DeviceSettings {
  const raw: unknown = app.loadLocalStorage(KEY);
  const record = isRecord(raw) ? raw : {};
  const id = typeof record.deviceId === "string" && record.deviceId ? record.deviceId : newDeviceId();
  const settings = sanitize(record, id);
  saveDeviceSettings(app, settings);
  return settings;
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  app.saveLocalStorage(KEY, settings);
}
```

- [ ] **Step 5: Add the synced publisher record (schema 3)**

In `src/settings/settings.ts`:
- change `export const SETTINGS_VERSION = 2;` to `export const SETTINGS_VERSION = 3;`
- after the imports add:
```ts
/** The device that publishes (spec §4.3), as recorded in the synced settings. The device id itself never syncs. */
export interface PublisherRecord {
  deviceId: string;
  name: string;
  since: number;
}
```
- in `interface OsmmSettings`, after `autoPostLateMinutes: number;` add:
```ts
  /** Null until the user picks a publisher device: nothing is dispatched or marked overdue meanwhile. */
  publisher: PublisherRecord | null;
```
- in `DEFAULT_SETTINGS`, after `autoPostLateMinutes: 15,` add `publisher: null,`
- in `MIGRATIONS`, after the `1:` entry add:
```ts
  2: (raw) => ({ ...raw, schemaVersion: 3, publisher: null }),
```
- before `function sanitize`, add:
```ts
function sanitizePublisher(raw: unknown): PublisherRecord | null {
  if (!isRecord(raw) || typeof raw.deviceId !== "string" || !raw.deviceId) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "another device";
  const since = typeof raw.since === "number" && Number.isFinite(raw.since) ? raw.since : 0;
  return { deviceId: raw.deviceId, name, since };
}
```
- in `sanitize`'s returned object, after the `autoPostLateMinutes:` line add `publisher: sanitizePublisher(raw.publisher),`

- [ ] **Step 6: Write the publisher service**

`src/settings/publisher.ts`:
```ts
import type { DeviceSettings } from "./device";
import type { OsmmSettings, PublisherRecord } from "./settings";

export type PublisherState = { kind: "this" } | { kind: "other"; name: string; since: number } | { kind: "none" };

export function publisherState(publisher: PublisherRecord | null, deviceId: string): PublisherState {
  if (!publisher) return { kind: "none" };
  return publisher.deviceId === deviceId ? { kind: "this" } : { kind: "other", name: publisher.name, since: publisher.since };
}

export function publisherDescription(state: PublisherState): string {
  switch (state.kind) {
    case "this":
      return "This device posts scheduled items, moves late ones to the Overdue tray and books phone reminders. Keep Obsidian open here at posting times.";
    case "other":
      return `Publishing happens on ${state.name}. This device shows the plan and its own desktop reminders only.`;
    case "none":
      return "No device publishes yet, so scheduled posts are neither posted nor marked overdue. Choose one device, usually the computer that is on most.";
  }
}

export function takeoverMessage(name: string): string {
  return `Publishing happens on ${name}. Make this device the publisher instead? ${name} stops publishing as soon as this change reaches it through sync. Until then, avoid having both open at a post's time, or it could be posted twice.`;
}

export interface PublisherDeps {
  device(): Pick<DeviceSettings, "deviceId" | "deviceName">;
  settings(): Pick<OsmmSettings, "publisher">;
  update(patch: { publisher: PublisherRecord | null }): Promise<void>;
  now(): number;
}

/** Spec §4.3: exactly one device publishes. The choice is synced; each device knows only its own id. */
export class PublisherService {
  constructor(private readonly deps: PublisherDeps) {}

  get deviceId(): string {
    return this.deps.device().deviceId;
  }

  state(): PublisherState {
    return publisherState(this.deps.settings().publisher, this.deviceId);
  }

  isPublisher(): boolean {
    return this.state().kind === "this";
  }

  async claim(): Promise<void> {
    const d = this.deps.device();
    await this.deps.update({ publisher: { deviceId: d.deviceId, name: d.deviceName, since: this.deps.now() } });
  }

  /** Claims the role; asks first when another device holds it. False when the user declined. */
  async takeOver(confirm: (message: string) => Promise<boolean>): Promise<boolean> {
    const s = this.state();
    if (s.kind === "this") return true;
    if (s.kind === "other" && !(await confirm(takeoverMessage(s.name)))) return false;
    await this.claim();
    return true;
  }

  async release(): Promise<void> {
    if (this.isPublisher()) await this.deps.update({ publisher: null });
  }

  /** Keeps the synced name in step after this device is renamed. */
  async renamed(): Promise<void> {
    const current = this.deps.settings().publisher;
    const d = this.deps.device();
    if (current?.deviceId === d.deviceId && current.name !== d.deviceName) await this.deps.update({ publisher: { ...current, name: d.deviceName } });
  }
}
```

- [ ] **Step 7: Gate the scheduler on it**

In `src/scheduler/scheduler.ts`, replace the doc comment of `isPublisher()` in `SchedulerDeps` with:
```ts
  /** Only the publisher device runs deliveries (spec §4.3); the plugin reads `PublisherService.isPublisher()`. */
```

In `src/main.ts`:
- add `import { PublisherService } from "./settings/publisher";`
- add fields `publisher!: PublisherService;` (after `device!: DeviceSettings;`) and `private started = false;` (after `private unloaded = false;`)
- after `this.device = loadDeviceSettings(this.app);` add:
```ts
    this.publisher = new PublisherService({
      device: () => this.device,
      settings: () => this.settings,
      update: (patch) => this.updateSettings(patch),
      now: () => Date.now(),
    });
```
- in the `Scheduler` deps, replace the two lines
```ts
      // M3 (#26) replaces this with the publisher-device setting; until then every device publishes.
      isPublisher: () => true,
```
with
```ts
      isPublisher: () => this.publisher.isPublisher(),
```
- after `this.register(() => this.scheduler.stop());` add:
```ts
    // A device that becomes the publisher after start-up runs the startup check it skipped (spec §5.1).
    let wasPublisher = this.publisher.isPublisher();
    this.register(
      this.settingsStore.subscribe(() => {
        const now = this.publisher.isPublisher();
        if (now && !wasPublisher && this.started) void this.scheduler.reconcile().then(() => this.scheduler.tick());
        wasPublisher = now;
      }),
    );
```
- in `onLayoutReady`, after `void this.scheduler.tick();` add `this.started = true;`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/settings test/main.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/model/ids.ts src/settings/publisher.ts src/settings/settings.ts src/settings/device.ts src/scheduler/scheduler.ts src/main.ts test/fakes/obsidian.ts test/setup.ts test/settings test/main.test.ts
git commit -m "feat(settings): publisher device recorded in synced settings; only it runs deliveries (#26)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Publisher device — settings, banner and takeover UI (#26)

**Files:**
- Create: `src/views/PublisherBanner.svelte`, `test/views/publisherBanner.test.ts`
- Modify: `src/ui/context.ts` (`publisher`), `src/main.ts` (`uiContext`, `setDevice`, startup notice), `src/settings/tab.ts`, `src/views/Sidebar.svelte`, `src/views/Planner.svelte`, `src/styles/planner.css`, `test/ui/ctx.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: `PublisherService`, `publisherState`, `publisherDescription`, `cleanDeviceName`, `saveDeviceSettings` (Task 2); `confirmDialog` (`src/ui/dialogs.ts`); `PlannerActions.confirm/actionNotice`.
- Produces:
  - `OsmmContext.publisher: PublisherService`; `TestCtx.publisher` (device id `"test-device"`, name `"Test laptop"`).
  - `OsmmPlugin.setDevice(patch: Partial<Omit<DeviceSettings, "deviceId">>): void` — updates and saves the device-local settings.
  - `PublisherBanner.svelte` (no props) — `role="status"`: "Publishing happens on {name}." with **Publish from this device instead**, or "No device publishes scheduled posts yet…" with **Make this device the publisher**; nothing on the publisher. Shown at the top of the sidebar and under the planner toolbar.
  - Settings section **This device**: "Device name" (text) and "Publisher device" (description from `publisherDescription`, button **Make this device the publisher** / **Stop publishing here**, with confirmations).
  - Start-up notice when no device publishes: "No device publishes scheduled posts yet." with **Publish from this device**.

- [ ] **Step 1: Write the failing tests**

`test/views/publisherBanner.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { Modal } from "../fakes/obsidian";
import { osmmContext } from "../../src/ui/context";
import PublisherBanner from "../../src/views/PublisherBanner.svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { settle } from "../helpers";
import { makeCtx } from "../ui/ctx";

describe("PublisherBanner", () => {
  it("says where publishing happens and offers a confirmed takeover", async () => {
    const c = await makeCtx();
    c.settings.update((s) => ({ ...s, publisher: { deviceId: "other", name: "Work laptop", since: 1 } }));
    render(Sidebar, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("status").textContent).toContain("Publishing happens on Work laptop.");
    await fireEvent.click(screen.getByRole("button", { name: "Publish from this device instead" }));
    (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
    await settle();
    expect(get(c.settings).publisher?.deviceId).toBe("test-device");
  });

  it("asks for a publisher when there is none, and disappears on the publisher", async () => {
    const c = await makeCtx();
    render(PublisherBanner, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("status").textContent).toContain("No device publishes scheduled posts yet");
    await fireEvent.click(screen.getByRole("button", { name: "Make this device the publisher" }));
    await settle();
    expect(c.publisher.isPublisher()).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
```

In `test/main.test.ts`:
- extend the fake import to `import { App, Modal, Notice, Setting, type ButtonComponent, type TextComponent, type DropdownComponent, type ToggleComponent } from "./fakes/obsidian";`
- in "renders the General settings and applies edits", replace the expected names array with:
```ts
    expect(Setting.all.map((s) => s.name)).toEqual([
      "General",
      "Root folder",
      "Week starts on",
      "Default reminders",
      "Default stagger",
      "This device",
      "Device name",
      "Publisher device",
      "Publishing",
      "Post late items automatically",
      "Late window (minutes)",
      "Desktop notifications on this device",
      "Channels",
      "Schedule templates",
      "Launch",
    ]);
```
- add:
```ts
  it("names this device and makes it the publisher from the settings (#26)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    await (last("Device name").components[0] as TextComponent).change("Studio iMac");
    expect(plugin.device.deviceName).toBe("Studio iMac");
    expect(app.loadLocalStorage("osmm-device")).toMatchObject({ deviceName: "Studio iMac" });
    expect(last("Publisher device").desc).toContain("No device publishes yet");
    await (last("Publisher device").components[0] as ButtonComponent).click();
    expect(plugin.settings.publisher).toMatchObject({ deviceId: plugin.device.deviceId, name: "Studio iMac" });

    await plugin.updateSettings({ publisher: { deviceId: "other", name: "Work laptop", since: 1 } });
    tab.display();
    expect(last("Publisher device").desc).toContain("Publishing happens on Work laptop.");
    const clicked = (last("Publisher device").components[0] as ButtonComponent).click();
    (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
    await clicked;
    expect(plugin.publisher.isPublisher()).toBe(true);
    plugin.unload();
  });

  it("tells the user at start-up when no device publishes (#26)", async () => {
    Notice.messages = [];
    const { plugin } = await loaded();
    await settle(20);
    expect(Notice.messages).toContain("No device publishes scheduled posts yet. Publish from this device");
    plugin.unload();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/views/publisherBanner.test.ts test/main.test.ts`
Expected: FAIL — `PublisherBanner.svelte` missing; `publisher` not in the context; settings names differ.

- [ ] **Step 3: Put the service in the UI context**

In `src/ui/context.ts`, add `import type { PublisherService } from "../settings/publisher";` and, in `interface OsmmContext`, after `publish: PublishActions;` add `publisher: PublisherService;`.

In `test/ui/ctx.ts`:
- add imports `import type { DeviceSettings } from "../../src/settings/device";` and `import { PublisherService } from "../../src/settings/publisher";`
- add `publisher: PublisherService;` to `interface TestCtx`
- before `const ctx: OsmmContext = {`, add:
```ts
  const device: DeviceSettings = { deviceId: "test-device", deviceName: "Test laptop", notifications: true };
  const publisher = new PublisherService({
    device: () => device,
    settings: () => get(settings),
    update: async (patch) => settings.update((s) => ({ ...s, ...patch })),
    now: clock,
  });
```
- add `publisher,` to the `ctx` object (after `publish,`) and to the returned object.

In `src/main.ts`, in `uiContext()`, add `publisher: this.publisher,` after `publish,` in the `this.ui = { … }` object, and add the method (after `updateSettings`):
```ts
  setDevice(patch: Partial<Omit<DeviceSettings, "deviceId">>): void {
    this.device = { ...this.device, ...patch };
    saveDeviceSettings(this.app, this.device);
  }
```
with `saveDeviceSettings` added to the `./settings/device` import. In `onLayoutReady`, after `ui.publish.overdueBanner(…);` add:
```ts
      if (this.publisher.state().kind === "none") {
        ui.actions.actionNotice("No device publishes scheduled posts yet.", "Publish from this device", () => this.publisher.claim());
      }
```

- [ ] **Step 4: Write the banner and place it**

`src/views/PublisherBanner.svelte`:
```svelte
<script lang="ts">
  import { publisherState } from "../settings/publisher";
  import { useOsmm } from "../ui/context";

  const { settings, publisher, actions } = useOsmm();
  const state = $derived(publisherState($settings.publisher, publisher.deviceId));

  function claim(): void {
    void publisher.takeOver((message) => actions.confirm(message, "Make this device the publisher"));
  }
</script>

{#if state.kind === "other"}
  <p class="osmm-banner" role="status">
    Publishing happens on {state.name}.
    <button type="button" class="osmm-link" onclick={claim}>Publish from this device instead</button>
  </p>
{:else if state.kind === "none"}
  <p class="osmm-banner is-warning" role="status">
    No device publishes scheduled posts yet, so nothing is posted or marked overdue.
    <button type="button" class="osmm-link" onclick={claim}>Make this device the publisher</button>
  </p>
{/if}
```

In `src/views/Sidebar.svelte`, add `import PublisherBanner from "./PublisherBanner.svelte";` to the script and insert `<PublisherBanner />` as the first child of `<div class="osmm-sidebar">` (before the New campaign button).

In `src/views/Planner.svelte`, add `import PublisherBanner from "./PublisherBanner.svelte";` and insert `<PublisherBanner />` between the closing `</div>` of `osmm-subbar` and `<div class="osmm-body">`.

Append to `src/styles/planner.css`:
```css
.osmm-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--background-secondary); color: var(--osmm-muted); font-size: var(--font-ui-small); }
.osmm-planner > .osmm-banner { margin: 0 16px 8px; }
.osmm-banner.is-warning { background: rgba(var(--color-orange-rgb), 0.1); color: var(--text-normal); }
```

- [ ] **Step 5: Add the settings section**

In `src/settings/tab.ts`:
- replace `import { saveDeviceSettings } from "./device";` with `import { cleanDeviceName } from "./device";` and add `import { confirmDialog } from "../ui/dialogs";` and `import { publisherDescription } from "./publisher";`
- replace the "Desktop notifications on this device" toggle's `onChange` body with `this.osmm.setDevice({ notifications: value });`
- insert, after the "Default stagger" setting and before `new Setting(containerEl).setName("Publishing").setHeading();`:
```ts
    new Setting(containerEl).setName("This device").setHeading();

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Other devices show this name when this device publishes. Stored on this device only.")
      .addText((t) =>
        t.setValue(this.osmm.device.deviceName).onChange(async (value) => {
          const name = cleanDeviceName(value);
          if (!name) return;
          this.osmm.setDevice({ deviceName: name });
          await this.osmm.publisher.renamed();
        }),
      );

    const publisher = this.osmm.publisher.state();
    new Setting(containerEl)
      .setName("Publisher device")
      .setDesc(publisherDescription(publisher))
      .addButton((b) =>
        b.setButtonText(publisher.kind === "this" ? "Stop publishing here" : "Make this device the publisher").onClick(async () => {
          if (publisher.kind === "this") {
            const ok = await confirmDialog(this.app, "Stop publishing from this device? Until another device is chosen, scheduled posts are neither posted nor marked overdue.", "Stop publishing");
            if (ok) await this.osmm.publisher.release();
          } else {
            await this.osmm.publisher.takeOver((message) => confirmDialog(this.app, message, "Make this device the publisher"));
          }
          this.display();
        }),
      );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/views test/main.test.ts && npm test && npm run typecheck`
Expected: PASS (existing sidebar tests still find their regions; the banner is an extra `status`).

- [ ] **Step 7: Commit**

```bash
git add src/views/PublisherBanner.svelte src/views/Sidebar.svelte src/views/Planner.svelte src/styles/planner.css src/ui/context.ts src/main.ts src/settings/tab.ts test/ui/ctx.ts test/views/publisherBanner.test.ts test/main.test.ts
git commit -m "feat(settings): choose and take over the publisher device; banner on the other devices (#26)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Mobile compatibility pass (#27)

**Files:**
- Create: `src/planner/agenda.ts`, `src/views/AgendaView.svelte`, `test/views/agenda.test.ts`, `test/mobile.test.ts`
- Modify: `src/publish/clipboard.ts`, `src/reminders/notifier.ts`, `src/views/Planner.svelte`, `src/styles/planner.css`, `src/styles/composer.css`

**Interfaces:**
- Consumes: `Platform` (obsidian; fake from Task 2), `groupByDay`, `dayKey` (`src/planner/calendar.ts`), `startOfLocalDay`, `Chip.svelte`, `formatShortDate`.
- Produces:
  - `interface AgendaDay { key: string; date: number; rows: PostRow[]; isToday: boolean }`; `agendaDays(rows: readonly PostRow[], from: number, to: number, now: number): AgendaDay[]` — the days of `[from, to)` that have posts, in order, plus today when it falls in the range.
  - `AgendaView.svelte` props `{ rows: PostRow[]; from: number; to: number }` — `<ol aria-label="Agenda">`, one `<li>` per day with its chips (same `Chip`, so the context menu, long press and keyboard menu keep working).
  - `Planner.svelte` shows the agenda instead of the month and week grids when `Platform.isPhone` or the planner is narrower than 560 px; the board scrolls sideways one column at a time on narrow panes.
  - `browserClipboard(app)` touches `window.require("electron")`, `Buffer` and `app.showInFolder` only when `Platform.isDesktopApp`; `isMobile()` is also true when `Platform.isMobile`.
  - `Notifier` raises system notifications only on the desktop app (in-app notices everywhere).

- [ ] **Step 1: Write the failing tests**

`test/views/agenda.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/svelte";
import { setPlatform } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { agendaDays } from "../../src/planner/agenda";
import { osmmContext } from "../../src/ui/context";
import Planner from "../../src/views/Planner.svelte";
import { makeCtx, TEST_NOW } from "../ui/ctx";

const DAY = 86_400_000;
const post = (path: string, at: number) => ({
  path,
  frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(at) },
  body: path,
});

describe("agendaDays", () => {
  it("lists the days that have posts, in order, plus today", async () => {
    const c = await makeCtx({ notes: [post("Social/Posts/B.md", TEST_NOW + 3 * DAY), post("Social/Posts/A.md", TEST_NOW + DAY)] });
    const days = agendaDays(c.ctx.actions.rows(), TEST_NOW - 2 * DAY, TEST_NOW + 10 * DAY, TEST_NOW);
    expect(days.map((d) => [d.key, d.rows.length, d.isToday])).toEqual([
      ["2026-10-08", 0, true],
      ["2026-10-09", 1, false],
      ["2026-10-11", 1, false],
    ]);
  });

  it("leaves out posts outside the range and today when it is not in it", async () => {
    const c = await makeCtx({ notes: [post("Social/Posts/A.md", TEST_NOW + 20 * DAY)] });
    expect(agendaDays(c.ctx.actions.rows(), TEST_NOW + DAY, TEST_NOW + 10 * DAY, TEST_NOW)).toEqual([]);
  });
});

describe("Planner on a phone (#27)", () => {
  it("shows an agenda instead of the month grid", async () => {
    setPlatform("iphone");
    const c = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(c.ctx) });
    const agenda = screen.getByRole("list", { name: "Agenda" });
    expect(within(agenda).getAllByRole("listitem").filter((li) => li.classList.contains("is-today"))[0]!.textContent).toContain("Today · ");
    expect(agenda.textContent).toContain("Event X is back");
    expect(screen.queryByRole("grid", { name: "Month" })).toBeNull();
  });

  it("keeps the month grid on the desktop", async () => {
    const c = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("grid", { name: "Month" })).toBeTruthy();
  });
});
```

`test/mobile.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Notice, setPlatform } from "./fakes/obsidian";
import { browser } from "./fakes/browser";
import OsmmPlugin from "../src/main";
import { browserClipboard, isMobile } from "../src/publish/clipboard";
import { NotifiedLedger } from "../src/reminders/ledger";
import { Notifier } from "../src/reminders/notifier";
import { VIEW_COMPOSER, VIEW_PLANNER, VIEW_PREVIEW_GRID, VIEW_SIDEBAR } from "../src/ui/actions";
import { indexed, settle, writeNote } from "./helpers";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };
const saved = { Notification: globalThis.Notification };

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  Object.assign(globalThis, saved);
});

describe("on a phone (#27)", () => {
  it.each(["iphone", "android"] as const)("the plugin loads with no errors on %s", async (kind) => {
    setPlatform(kind);
    Object.assign(globalThis, { Notification: undefined });
    const app = new App();
    await writeNote(app as never, "Social/Posts/P.md", { type: "social-post", platform: "x", channels: [], status: "draft" }, "Hi");
    await settle();
    Notice.messages = [];
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    for (const view of [VIEW_PLANNER, VIEW_SIDEBAR, VIEW_PREVIEW_GRID, VIEW_COMPOSER]) expect(app.workspace.viewFactories.has(view)).toBe(true);
    expect(plugin.device.deviceName).toBe(kind === "iphone" ? "iPhone" : "Android phone");
    expect(Notice.messages.filter((m) => /error|cannot|undefined/i.test(m))).toEqual([]);
    plugin.unload();
  });

  it("never reaches for Electron, Buffer or the file manager", async () => {
    setPlatform("iphone");
    const electron = vi.fn();
    (window as unknown as { require: unknown }).require = electron;
    const app = new App();
    const env = browserClipboard(app as never);
    expect(await env.writeImage(new ArrayBuffer(4), "image/jpeg")).toBe(false);
    expect(env.reveal("Social/a.png")).toBe(false);
    expect(electron).not.toHaveBeenCalled();
    expect(isMobile()).toBe(true);
  });

  it("keeps reminders in-app instead of raising system notifications", () => {
    setPlatform("android");
    browser.focused = false;
    const notifier = new Notifier({
      ledger: new NotifiedLedger(new App() as never, () => 1),
      enabled: () => true,
      channelName: () => "@you",
      noteTitle: () => "Hello",
      openAssisted: () => undefined,
      openComposer: () => undefined,
    });
    notifier.reminder({ key: "k", path: "p.md", channelId: "bs/you", at: 1, minutes: 10, title: "Hello" });
    expect(Notice.messages.at(-1)).toContain("In 10 min: Hello");
    expect(browser.notifications).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/views/agenda.test.ts test/mobile.test.ts`
Expected: FAIL — `src/planner/agenda` missing; the clipboard calls `window.require` on a phone; the notifier raises a system notification.

- [ ] **Step 3: Guard the desktop-only code**

In `src/publish/clipboard.ts`:
- change the first import to `import { Platform, type App } from "obsidian";`
- replace `isMobile()` with:
```ts
/** Phones and tablets: Obsidian's Platform flag, or the `is-mobile` class it puts on <body>. */
export function isMobile(): boolean {
  return Platform.isMobile || document.body.classList.contains("is-mobile");
}
```
- in `browserClipboard`, replace the first line of `writeImage` (`const electron = …`) and the `if (electron?.clipboard …)` block with:
```ts
      // Electron (and Node's Buffer) exist only in the desktop app (#27).
      if (Platform.isDesktopApp) {
        const electron = (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as ElectronLike | undefined;
        if (electron?.clipboard && electron.nativeImage) {
          const image = electron.nativeImage.createFromBuffer(Buffer.from(bytes));
          if (!image.isEmpty()) {
            electron.clipboard.writeImage(image);
            return true;
          }
        }
      }
```
- in `reveal(path)`, add as the first line: `if (!Platform.isDesktopApp) return false;`

In `src/reminders/notifier.ts`:
- change `import { Notice } from "obsidian";` to `import { Notice, Platform } from "obsidian";`
- replace `if (typeof Notification === "undefined" || document.hasFocus()) return;` with:
```ts
    // System notifications only in the desktop app; phones get the in-app notice (and ntfy pushes, M3).
    if (!Platform.isDesktopApp || typeof Notification === "undefined" || document.hasFocus()) return;
```

- [ ] **Step 4: Write the agenda**

`src/planner/agenda.ts`:
```ts
import type { PostRow } from "../index/queries";
import { startOfLocalDay } from "../model/dates";
import { dayKey, groupByDay } from "./calendar";

export interface AgendaDay {
  key: string;
  date: number;
  rows: PostRow[];
  isToday: boolean;
}

/** Phone agenda (#27): the days of [from, to) that have posts, in order, plus today when it is in the range. */
export function agendaDays(rows: readonly PostRow[], from: number, to: number, now: number): AgendaDay[] {
  const byDay = groupByDay(rows.filter((r) => r.at !== undefined && r.at >= from && r.at < to));
  const today = startOfLocalDay(now);
  const todayKey = dayKey(today);
  if (today >= from && today < to && !byDay.has(todayKey)) byDay.set(todayKey, []);
  return [...byDay.entries()]
    .map(([key, list]) => ({ key, date: list[0]?.at !== undefined ? startOfLocalDay(list[0].at) : today, rows: list, isToday: key === todayKey }))
    .sort((a, b) => a.date - b.date);
}
```

`src/views/AgendaView.svelte`:
```svelte
<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { agendaDays } from "../planner/agenda";
  import { useOsmm } from "../ui/context";
  import { formatShortDate } from "../ui/format";
  import Chip from "./Chip.svelte";

  let { rows, from, to }: { rows: PostRow[]; from: number; to: number } = $props();
  const { now } = useOsmm();
  const days = $derived(agendaDays(rows, from, to, $now));
</script>

<ol class="osmm-agenda" aria-label="Agenda">
  {#each days as day (day.key)}
    <li class="osmm-agenda-day" class:is-today={day.isToday}>
      <h3 class="osmm-agenda-date">{day.isToday ? "Today · " : ""}{formatShortDate(day.date)}</h3>
      {#each day.rows as row (row.key)}
        <Chip {row} />
      {:else}
        <p class="osmm-progress">Nothing planned.</p>
      {/each}
    </li>
  {:else}
    <li class="osmm-progress">Nothing planned in this period.</li>
  {/each}
</ol>
```

- [ ] **Step 5: Use it on phones and narrow panes**

In `src/views/Planner.svelte`:
- add to the script imports `import { Platform } from "obsidian";` and `import AgendaView from "./AgendaView.svelte";`
- after `let anchor = $state(startOfLocalDay(get(now)));` add:
```ts
  let width = $state(0);
  /** Phones and narrow panes get the agenda instead of the 7-column grids (#27). jsdom reports 0. */
  const compact = $derived(Platform.isPhone || (width > 0 && width < 560));
```
- change `<div class="osmm-planner">` to `<div class="osmm-planner" bind:clientWidth={width}>`
- replace `{#if mode === "month"}` (the first branch inside `osmm-body`) with:
```svelte
    {#if (mode === "month" || mode === "week") && compact}
      <AgendaView rows={visible} from={range.from} to={range.to} />
    {:else if mode === "month"}
```

Append to `src/styles/planner.css`:
```css
.osmm-planner { container-type: inline-size; }
.osmm-toolbar { flex-wrap: wrap; }
.osmm-agenda { display: flex; flex-direction: column; gap: 14px; margin: 0; padding: 0; list-style: none; }
.osmm-agenda-day { display: flex; flex-direction: column; gap: 6px; }
.osmm-agenda-date { margin: 0; font-size: var(--font-ui-small); color: var(--osmm-muted); font-weight: 600; }
.osmm-agenda-day.is-today .osmm-agenda-date { color: var(--osmm-accent); }
.osmm-agenda .osmm-chip { width: 100%; min-height: 32px; }
@container (max-width: 700px) {
  .osmm-toolbar, .osmm-subbar { gap: 8px; padding: 8px 10px; }
  .osmm-body { padding: 0 10px 10px; }
  .osmm-legend { display: none; }
  .osmm-board { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(240px, 85%); overflow-x: auto; scroll-snap-type: x mandatory; }
  .osmm-column { scroll-snap-align: start; }
  .osmm-table { font-size: var(--font-ui-small); }
}
body.is-mobile .osmm-chip, body.is-mobile .osmm-card { min-height: 32px; }
```

Append to `src/styles/composer.css`:
```css
.osmm-steps { flex-wrap: wrap; }
body.is-phone .osmm-assisted button { min-height: 40px; }
body.is-phone .osmm-composer-main { padding: 8px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/views test/mobile.test.ts test/publish/clipboard.test.ts test/reminders && npm test && npm run typecheck && npm run build`
Expected: PASS; the production bundle builds.

- [ ] **Step 7: Commit**

```bash
git add src/planner/agenda.ts src/views/AgendaView.svelte src/views/Planner.svelte src/publish/clipboard.ts src/reminders/notifier.ts src/styles/planner.css src/styles/composer.css test/views/agenda.test.ts test/mobile.test.ts
git commit -m "feat(mobile): guard desktop-only code, agenda on phones, responsive board (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ntfy client and per-device configuration (#68)

**Files:**
- Create: `src/reminders/ntfy/config.ts`, `src/reminders/ntfy/client.ts`, `test/reminders/ntfy/fixtures.ts`, `test/reminders/ntfy/client.test.ts`
- Modify: `src/settings/device.ts` (`ntfy`), `test/fakes/obsidian.ts` (`requestUrlMock.calls`, `reset`, `contentType`), `test/setup.ts`, `test/ui/ctx.ts`

**Interfaces:**
- Consumes: `requestUrl`, `RequestUrlParam`, `RequestUrlResponse` (obsidian); `SecretIds.ntfyTopic/ntfyToken`, `Secrets.get` (Task 1); `randomString` (Task 2); `isRecord`.
- Produces:
  - `interface NtfyConfig { server: string; topic: string; token: string | null }`; `DEFAULT_NTFY_SERVER = "https://ntfy.sh"`; `TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/`; `normalizeServer(raw: string): string | null` (http(s), no query or hash, no trailing slash); `randomTopic(): string` (`osmm-` + 24 × `[a-z0-9]`); `ntfyTarget(device: Pick<DeviceSettings, "ntfy">, secrets: Pick<Secrets, "get">): NtfyConfig | null` (null without a valid server and topic; independent of `enabled`).
  - `interface NtfyDeviceSettings { enabled: boolean; server: string; results: boolean }`; `DeviceSettings.ntfy` (default `{ enabled: false, server: "https://ntfy.sh", results: false }`).
  - `type NtfyAction = { action: "view"; label; url; clear? } | { action: "http"; label; url; method?; headers?; body?; clear? }`; `interface NtfyMessage { title: string; message: string; priority?: 1|2|3|4|5; tags?: string[]; click?: string; actions?: NtfyAction[]; at?: number }`; `testMessage(): NtfyMessage`.
  - `type NtfyErrorKind = "setup" | "auth" | "rate_limited" | "rejected" | "unreachable" | "server"`; `class NtfyError extends Error { kind; retryAfterMs? }` — its message never contains the topic or the token.
  - `type Http = (req: RequestUrlParam) => Promise<RequestUrlResponse>`; `MIN_DELAY_MS = 10_000`; `class NtfyClient { constructor(target: () => NtfyConfig | null, http?: Http, now?: () => number); publish(msg): Promise<{ id: string; at: number }>; cancel(id: string): Promise<"cancelled" | "unsupported"> }`.
  - Fake: `requestUrlMock.calls: RequestUrlParam[]`, `requestUrlMock.reset()` (run before each test).

- [ ] **Step 1: Extend the requestUrl fake**

In `test/fakes/obsidian.ts`:
- add `contentType?: string;` to `interface RequestUrlParam` (after `method?`)
- replace `requestUrlMock` and `requestUrl` with:
```ts
/** Test-only: queue one handler per expected request; every request is recorded in `calls`. */
export const requestUrlMock = {
  queue: [] as Array<(req: RequestUrlParam) => RequestUrlResponse | Error>,
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
  const res = handler(param);
  if (res instanceof Error) throw res;
  if (res.status >= 400 && param.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${res.status}`), { status: res.status, headers: res.headers });
  }
  return res;
}
```

In `test/setup.ts`, change the fake import to `import { requestUrlMock, setPlatform } from "./fakes/obsidian";` and add `requestUrlMock.reset();` inside the `beforeEach`.

- [ ] **Step 2: Write the fixtures and the failing tests**

`test/reminders/ntfy/fixtures.ts`:
```ts
import type { RequestUrlResponse } from "../../fakes/obsidian";

/**
 * Responses shaped like ntfy's documented JSON (message: {id, time, expires, event, topic, …};
 * error: {code, http, error, link}). QA (docs/qa/m3.md) replaces them with responses captured from ntfy.sh.
 */
function res(status: number, body: unknown, headers: Record<string, string> = {}): () => RequestUrlResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return () => ({ status, headers: { "content-type": "application/json", ...headers }, text, json: typeof body === "string" ? null : body, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer });
}

export const NTFY = {
  published: res(200, { id: "hwQ2YpKdmg", time: 1791216000, expires: 1791259200, event: "message", topic: "osmm-test", title: "t", message: "m" }),
  scheduled: res(200, { id: "Zr0Jk2fA9b", time: 1791219600, expires: 1791262800, event: "message", topic: "osmm-test", message: "m" }),
  cancelled: res(200, { id: "Zr0Jk2fA9b", time: 1791216000, event: "message_delete", topic: "osmm-test" }),
  forbidden: res(403, { code: 40301, http: 403, error: "forbidden", link: "https://ntfy.sh/docs/publish/#authentication" }),
  delayTooLarge: res(400, { code: 40006, http: 400, error: "invalid delay parameter: too large, please refer to https://ntfy.sh/docs/publish/#scheduled-delivery" }),
  rateLimited: res(429, { code: 42901, http: 429, error: "limit reached: too many requests" }, { "retry-after": "60" }),
  notFound: res(404, { code: 40401, http: 404, error: "page not found" }),
  badGateway: res(502, "<html>Bad gateway</html>"),
  echoesSecrets: res(400, { code: 40009, http: 400, error: "invalid topic osmm-SECRETTOPIC for token tk_SECRETTOKEN" }),
  garbled: res(200, "not json"),
};
```

`test/reminders/ntfy/client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App, requestUrlMock } from "../../fakes/obsidian";
import { NtfyClient, NtfyError, MIN_DELAY_MS, testMessage, type NtfyMessage } from "../../../src/reminders/ntfy/client";
import { DEFAULT_NTFY_SERVER, normalizeServer, ntfyTarget, randomTopic, type NtfyConfig } from "../../../src/reminders/ntfy/config";
import { SecretIds, Secrets } from "../../../src/secrets/secrets";
import { loadDeviceSettings } from "../../../src/settings/device";
import { NTFY } from "./fixtures";

const NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin
const target: NtfyConfig = { server: "https://ntfy.sh", topic: "osmm-SECRETTOPIC", token: null };
const client = (t: NtfyConfig | null = target) => new NtfyClient(() => t, undefined, () => NOW);
const msg: NtfyMessage = {
  title: "In 10 min · LinkedIn",
  message: "Event X is back",
  priority: 4,
  tags: ["osmm", "linkedin"],
  click: "https://www.linkedin.com/feed/?shareActive=true",
  actions: [{ action: "view", label: "Open note", url: "obsidian://open?vault=V&file=a.md" }],
};
const body = (i = 0) => JSON.parse(String(requestUrlMock.calls[i]!.body)) as Record<string, unknown>;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as NtfyError;
  }
  throw new Error("expected a failure");
};

describe("NtfyClient contract (#68)", () => {
  it("publishes JSON to the server root with title, message, priority, tags, click and actions", async () => {
    requestUrlMock.queue.push(NTFY.published);
    expect(await client().publish(msg)).toEqual({ id: "hwQ2YpKdmg", at: 1791216000_000 });
    const call = requestUrlMock.calls[0]!;
    expect([call.url, call.method, call.contentType, call.throw]).toEqual(["https://ntfy.sh/", "POST", "application/json", false]);
    expect(call.headers).toEqual({});
    expect(body()).toEqual({ topic: "osmm-SECRETTOPIC", title: msg.title, message: msg.message, priority: 4, tags: ["osmm", "linkedin"], click: msg.click, actions: msg.actions });
  });

  it("books a delayed push with a unix-seconds delay", async () => {
    requestUrlMock.queue.push(NTFY.scheduled, NTFY.published);
    const at = NOW + 2 * 3_600_000;
    expect(await client().publish({ ...msg, at })).toEqual({ id: "Zr0Jk2fA9b", at });
    expect(body().delay).toBe(String(Math.floor(at / 1000)));
    await client().publish({ ...msg, at: NOW + MIN_DELAY_MS - 1 });
    expect(body(1).delay).toBeUndefined();
  });

  it("sends the access token as a bearer header, and at most three actions", async () => {
    requestUrlMock.queue.push(NTFY.published);
    const view = { action: "view" as const, label: "x", url: "https://example.com" };
    await client({ ...target, token: "tk_SECRETTOKEN" }).publish({ ...msg, actions: [view, view, view, view] });
    expect(requestUrlMock.calls[0]!.headers).toEqual({ Authorization: "Bearer tk_SECRETTOKEN" });
    expect(body().actions).toHaveLength(3);
  });

  it("cancels a delayed push, or reports that the server can't", async () => {
    requestUrlMock.queue.push(NTFY.cancelled, NTFY.notFound);
    expect(await client().cancel("Zr0Jk2fA9b")).toBe("cancelled");
    expect([requestUrlMock.calls[0]!.url, requestUrlMock.calls[0]!.method]).toEqual(["https://ntfy.sh/osmm-SECRETTOPIC/Zr0Jk2fA9b", "DELETE"]);
    expect(await client().cancel("Zr0Jk2fA9b")).toBe("unsupported");
    expect(await client().cancel("../bad")).toBe("unsupported");
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it.each([
    ["forbidden", NTFY.forbidden, "auth", undefined],
    ["delay too large", NTFY.delayTooLarge, "rejected", undefined],
    ["rate limited", NTFY.rateLimited, "rate_limited", 60_000],
    ["bad gateway", NTFY.badGateway, "server", undefined],
    ["an unexpected reply", NTFY.garbled, "server", undefined],
    ["a network error", () => new Error("net::ERR_NAME_NOT_RESOLVED https://ntfy.sh/osmm-SECRETTOPIC"), "unreachable", undefined],
  ])("classifies %s", async (_name, fixture, kind, retryAfterMs) => {
    requestUrlMock.queue.push(fixture);
    const e = await failure(client().publish(msg));
    expect(e).toBeInstanceOf(NtfyError);
    expect([e.kind, e.retryAfterMs]).toEqual([kind, retryAfterMs]);
  });

  it("never puts the topic or the token in an error (review focus 3)", async () => {
    const withToken = client({ ...target, token: "tk_SECRETTOKEN" });
    for (const fixture of [NTFY.echoesSecrets, () => new Error("https://ntfy.sh/osmm-SECRETTOPIC tk_SECRETTOKEN")]) {
      requestUrlMock.queue.push(fixture);
      const e = await failure(withToken.publish(msg));
      expect(e.message).not.toMatch(/SECRETTOPIC|SECRETTOKEN/);
    }
  });

  it("refuses to send before it is set up", async () => {
    const e = await failure(client(null).publish(testMessage()));
    expect(e.kind).toBe("setup");
    expect(requestUrlMock.calls).toEqual([]);
  });
});

describe("ntfy configuration", () => {
  it("normalizes the server address", () => {
    expect(normalizeServer(" https://ntfy.example.org/ ")).toBe("https://ntfy.example.org");
    expect(normalizeServer("http://192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
    expect(normalizeServer("ftp://x")).toBeNull();
    expect(normalizeServer("https://ntfy.sh/?a=1")).toBeNull();
    expect(normalizeServer("ntfy.sh")).toBeNull();
  });

  it("makes long random topics", () => {
    expect(randomTopic()).toMatch(/^osmm-[a-z0-9]{24}$/);
    expect(randomTopic()).not.toBe(randomTopic());
  });

  it("reads the topic and token from secret storage only", () => {
    const app = new App();
    const secrets = new Secrets(app as never);
    const device = loadDeviceSettings(app as never);
    expect(device.ntfy).toEqual({ enabled: false, server: DEFAULT_NTFY_SERVER, results: false });
    expect(ntfyTarget(device, secrets)).toBeNull();
    secrets.set(SecretIds.ntfyTopic, "osmm-abc");
    expect(ntfyTarget(device, secrets)).toEqual({ server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    secrets.set(SecretIds.ntfyToken, "tk_x");
    expect(ntfyTarget({ ntfy: { ...device.ntfy, server: "https://push.example.org/" } }, secrets)).toEqual({ server: "https://push.example.org", topic: "osmm-abc", token: "tk_x" });
    secrets.set(SecretIds.ntfyTopic, "has spaces");
    expect(ntfyTarget(device, secrets)).toBeNull();
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toContain("osmm-abc");
  });

  it("falls back to defaults for malformed device values", () => {
    const app = new App();
    app.saveLocalStorage("osmm-device", { deviceId: "d", ntfy: { enabled: "yes", server: "nope", results: 1 } });
    expect(loadDeviceSettings(app as never).ntfy).toEqual({ enabled: false, server: DEFAULT_NTFY_SERVER, results: false });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/reminders/ntfy`
Expected: FAIL — `src/reminders/ntfy/*` missing.

- [ ] **Step 4: Write the configuration**

`src/reminders/ntfy/config.ts`:
```ts
import { randomString } from "../../model/ids";
import { SecretIds, type Secrets } from "../../secrets/secrets";
import type { DeviceSettings } from "../../settings/device";

export interface NtfyConfig {
  /** Normalized, without a trailing slash. */
  server: string;
  topic: string;
  token: string | null;
}

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
/** ntfy topic names: letters, digits, - and _, at most 64 characters. */
export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export function normalizeServer(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash || !url.host) return null;
  return s;
}

/** A long random topic: on a public server, anyone who knows the topic can read the pushes (#71). */
export function randomTopic(): string {
  return `osmm-${randomString(24)}`;
}

/** Where pushes go: the device's server plus the topic and token from secret storage. Null until usable. */
export function ntfyTarget(device: Pick<DeviceSettings, "ntfy">, secrets: Pick<Secrets, "get">): NtfyConfig | null {
  const server = normalizeServer(device.ntfy.server);
  const topic = secrets.get(SecretIds.ntfyTopic);
  if (!server || !topic || !TOPIC_RE.test(topic)) return null;
  return { server, topic, token: secrets.get(SecretIds.ntfyToken) };
}
```

In `src/settings/device.ts`:
- add `import { DEFAULT_NTFY_SERVER, normalizeServer } from "../reminders/ntfy/config";`
- add, before `interface DeviceSettings`:
```ts
/** Phone reminders on this device (#71). The topic and the token live in secret storage, never here. */
export interface NtfyDeviceSettings {
  enabled: boolean;
  server: string;
  /** Also push automatic-post confirmations and failure alerts (#70, optional). */
  results: boolean;
}
```
- add `ntfy: NtfyDeviceSettings;` to `interface DeviceSettings` (after `notifications`)
- add before `function sanitize`:
```ts
function sanitizeNtfy(raw: unknown): NtfyDeviceSettings {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {};
  const server = typeof r.server === "string" ? normalizeServer(r.server) : null;
  return { enabled: r.enabled === true, server: server ?? DEFAULT_NTFY_SERVER, results: r.results === true };
}
```
- add `ntfy: sanitizeNtfy(raw.ntfy),` to the object `sanitize` returns.

In `test/ui/ctx.ts`, change the device literal to:
```ts
  const device: DeviceSettings = { deviceId: "test-device", deviceName: "Test laptop", notifications: true, ntfy: { enabled: false, server: "https://ntfy.sh", results: false } };
```

- [ ] **Step 5: Write the client**

`src/reminders/ntfy/client.ts`:
```ts
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { isRecord } from "../../model/frontmatter";
import type { NtfyConfig } from "./config";

export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | { action: "http"; label: string; url: string; method?: string; headers?: Record<string, string>; body?: string; clear?: boolean };

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** Opened when the notification itself is tapped. */
  click?: string;
  /** ntfy shows at most three. */
  actions?: NtfyAction[];
  /** Delivery time (epoch ms); sent at once when absent or less than 10 s ahead. */
  at?: number;
}

export type NtfyErrorKind = "setup" | "auth" | "rate_limited" | "rejected" | "unreachable" | "server";

/** A failed ntfy call. The message is safe to show: it never contains the topic or the token. */
export class NtfyError extends Error {
  constructor(
    readonly kind: NtfyErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NtfyError";
  }
}

export type Http = (req: RequestUrlParam) => Promise<RequestUrlResponse>;

/** ntfy.sh's minimum delay; a push due sooner is sent without one. */
export const MIN_DELAY_MS = 10_000;
const MAX_ACTIONS = 3;
const MESSAGE_ID_RE = /^[A-Za-z0-9]{1,64}$/;

export function testMessage(): NtfyMessage {
  return { title: "Social Planner test", message: "Phone reminders work. Reminders for your posts will arrive here.", priority: 3, tags: ["osmm"] };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Publishes to ntfy.sh or a self-hosted server with Obsidian's requestUrl (works on mobile, #68). */
export class NtfyClient {
  constructor(
    private readonly target: () => NtfyConfig | null,
    private readonly http: Http = (req) => requestUrl(req),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async publish(msg: NtfyMessage): Promise<{ id: string; at: number }> {
    const c = this.require();
    const body: Record<string, unknown> = { topic: c.topic, title: msg.title, message: msg.message };
    if (msg.priority) body.priority = msg.priority;
    if (msg.tags?.length) body.tags = msg.tags;
    if (msg.click) body.click = msg.click;
    if (msg.actions?.length) body.actions = msg.actions.slice(0, MAX_ACTIONS);
    const delayed = msg.at !== undefined && msg.at - this.now() >= MIN_DELAY_MS;
    if (delayed) body.delay = String(Math.floor(msg.at! / 1000));
    const res = await this.send(c, { url: `${c.server}/`, method: "POST", contentType: "application/json", headers: this.headers(c), body: JSON.stringify(body) });
    const json = parseJson(res.text);
    if (!isRecord(json) || typeof json.id !== "string") throw new NtfyError("server", "The ntfy server sent an unexpected reply.");
    const time = typeof json.time === "number" ? json.time * 1000 : this.now();
    return { id: json.id, at: delayed ? msg.at! : time };
  }

  /** Cancels a delayed push; "unsupported" when the server can't (older ntfy versions), and it stays booked. */
  async cancel(id: string): Promise<"cancelled" | "unsupported"> {
    const c = this.require();
    if (!MESSAGE_ID_RE.test(id)) return "unsupported";
    try {
      await this.send(c, { url: `${c.server}/${c.topic}/${id}`, method: "DELETE", headers: this.headers(c) });
      return "cancelled";
    } catch (e) {
      if (e instanceof NtfyError && e.kind === "rejected") return "unsupported";
      throw e;
    }
  }

  private require(): NtfyConfig {
    const c = this.target();
    if (!c) throw new NtfyError("setup", "Phone reminders aren't set up yet: choose a server and a topic in the settings.");
    return c;
  }

  private headers(c: NtfyConfig): Record<string, string> {
    return c.token ? { Authorization: `Bearer ${c.token}` } : {};
  }

  private async send(c: NtfyConfig, req: RequestUrlParam): Promise<RequestUrlResponse> {
    const scrub = (text: string) => [c.topic, c.token].reduce<string>((s, secret) => (secret ? s.split(secret).join("•••") : s), text);
    let res: RequestUrlResponse;
    try {
      res = await this.http({ ...req, throw: false });
    } catch {
      // The underlying error text can contain the URL, and so the topic: never pass it on.
      throw new NtfyError("unreachable", "Couldn't reach the ntfy server. Check the server address and the connection.");
    }
    if (res.status >= 200 && res.status < 300) return res;
    const json = parseJson(res.text);
    const detail = isRecord(json) && typeof json.error === "string" ? scrub(json.error).slice(0, 160) : "";
    if (res.status === 401 || res.status === 403) throw new NtfyError("auth", "The ntfy server refused this device: check the access token, or whether the topic is reserved by someone else.");
    if (res.status === 429) {
      const seconds = Number(header(res.headers, "retry-after"));
      throw new NtfyError("rate_limited", "The ntfy server is limiting how often this device can send.", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
    }
    if (res.status >= 500) throw new NtfyError("server", `The ntfy server had a problem (${res.status}).`);
    throw new NtfyError("rejected", `The ntfy server rejected the request (${res.status}${detail ? `: ${detail}` : ""}).`);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/reminders/ntfy test/fakes && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/reminders/ntfy/config.ts src/reminders/ntfy/client.ts src/settings/device.ts test/fakes/obsidian.ts test/setup.ts test/ui/ctx.ts test/reminders/ntfy
git commit -m "feat(reminders): ntfy client over requestUrl with scrubbed errors and cancel support (#68)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Reminder slots and the booking ledger (#69, part 1)

**Files:**
- Create: `src/reminders/ntfy/bookings.ts`, `test/reminders/ntfy/bookings.test.ts`
- Modify: `src/reminders/reminders.ts`, `test/reminders/reminders.test.ts`

**Interfaces:**
- Consumes: `PostRow`; `unreadable` (`src/publish/eligibility.ts`); `isRecord`.
- Produces:
  - `fireTime(item: Pick<ReminderItem, "at" | "minutes">): number` — when a reminder is due.
  - `reminderSlots(rows, from, to, postAfter, offsets): ReminderItem[]` — reminders of scheduled rows whose time is in `(from, to]`, for posts after `postAfter`, offsets > 0, **never for unreadable entries**; same keys as before (`<row key>@<post time>:<minutes>`), sorted by fire time. `dueReminders(rows, now, previous, offsets)` is now `reminderSlots(rows, max(previous, now − 5 min), now, now, offsets)`.
  - `interface Booking { key: string; rowKey: string; minutes: number; messageId: string; fireAt: number }`; `class BookingLedger { constructor(app); all(): Booking[]; get(key); put(b); remove(key); prune(before: number); clear(); size(): number }` stored device-locally under `osmm-ntfy-bookings` (never the topic or token).

- [ ] **Step 1: Write the failing tests**

Add to `test/reminders/reminders.test.ts` (import `reminderSlots` and `fireTime` next to `dueReminders`):
```ts
describe("reminderSlots", () => {
  it("lists every reminder due in a window, for posts still ahead", async () => {
    const c = await makeCtx({ notes: [note({ reminders: [60, 10] })] });
    const rows = c.ctx.actions.rows();
    const items = reminderSlots(rows, AT - 72 * 60 * MIN, AT + MIN, AT - 72 * 60 * MIN, (r) => r.variant.reminders ?? null);
    expect(items.map((i) => [i.minutes, fireTime(i)])).toEqual([
      [60, AT - 60 * MIN],
      [10, AT - 10 * MIN],
    ]);
    expect(reminderSlots(rows, AT - 30 * MIN, AT + 72 * 60 * MIN, AT - 30 * MIN, () => [60, 10]).map((i) => i.minutes)).toEqual([10]);
  });

  it("never reminds about an unreadable delivery entry", async () => {
    const c = await makeCtx({ notes: [note({ deliveries: { "bs/you": { status: "Scheduled!" } } })] });
    const rows = c.ctx.actions.rows();
    expect(dueReminders(rows, AT - 60 * MIN, AT - 61 * MIN, () => [60])).toEqual([]);
    expect(reminderSlots(rows, 0, AT, 0, () => [60, 10])).toEqual([]);
  });
});
```

`test/reminders/ntfy/bookings.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App } from "../../fakes/obsidian";
import { BookingLedger, type Booking } from "../../../src/reminders/ntfy/bookings";

const b = (key: string, fireAt: number): Booking => ({ key, rowKey: key.replace(/@\d+:\d+$/, ""), minutes: 10, messageId: `m${fireAt}`, fireAt });

describe("BookingLedger", () => {
  it("keeps bookings across restarts, on this device only", () => {
    const app = new App();
    new BookingLedger(app as never).put(b("p.md#bs/you@100:10", 50));
    const again = new BookingLedger(app as never);
    expect(again.all()).toEqual([b("p.md#bs/you@100:10", 50)]);
    expect(again.get("p.md#bs/you@100:10")?.messageId).toBe("m50");
    expect(again.size()).toBe(1);
  });

  it("replaces, removes, prunes and clears", () => {
    const ledger = new BookingLedger(new App() as never);
    ledger.put(b("a@1:10", 10));
    ledger.put(b("b@1:10", 20));
    ledger.put({ ...b("a@1:10", 10), messageId: "new" });
    expect(ledger.all().map((x) => [x.key, x.messageId])).toEqual([
      ["a@1:10", "new"],
      ["b@1:10", "m20"],
    ]);
    ledger.prune(15);
    expect(ledger.all().map((x) => x.key)).toEqual(["b@1:10"]);
    ledger.remove("b@1:10");
    expect(ledger.all()).toEqual([]);
    ledger.put(b("c@1:10", 30));
    ledger.clear();
    expect(ledger.size()).toBe(0);
  });

  it("ignores malformed entries and never stores the topic", () => {
    const app = new App();
    app.saveLocalStorage("osmm-ntfy-bookings", { good: { rowKey: "r", minutes: 10, messageId: "m", fireAt: 1 }, bad: { rowKey: 3 } });
    const ledger = new BookingLedger(app as never);
    expect(ledger.all().map((x) => x.key)).toEqual(["good"]);
    ledger.put(b("d@1:10", 5));
    expect(Object.keys(Object.values(app.loadLocalStorage("osmm-ntfy-bookings") as object)[0])).toEqual(["rowKey", "minutes", "messageId", "fireAt"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/reminders`
Expected: FAIL — `reminderSlots`, `fireTime` and `BookingLedger` missing; the unreadable entry still reminds.

- [ ] **Step 3: Split out the reminder window**

In `src/reminders/reminders.ts`, add `import { unreadable } from "../publish/eligibility";` and replace `dueReminders` with:
```ts
export function fireTime(item: Pick<ReminderItem, "at" | "minutes">): number {
  return item.at - item.minutes * MINUTE;
}

/**
 * Reminders whose time falls in (from, to], for scheduled posts after `postAfter`. `offsets` gives the
 * minutes-before list for a row, or null for rows that post by themselves. Unreadable delivery entries are
 * frozen: they never remind (desktop or phone).
 */
export function reminderSlots(
  rows: readonly PostRow[],
  from: number,
  to: number,
  postAfter: number,
  offsets: (row: PostRow) => readonly number[] | null,
): ReminderItem[] {
  const out: ReminderItem[] = [];
  for (const row of rows) {
    if (!row.channelId || row.status !== "scheduled" || row.at === undefined || row.at <= postAfter) continue;
    if (unreadable(row.variant, row.channelId)) continue;
    for (const minutes of offsets(row) ?? []) {
      if (minutes <= 0) continue;
      const fireAt = row.at - minutes * MINUTE;
      if (fireAt <= from || fireAt > to) continue;
      out.push({ key: `${row.key}@${row.at}:${minutes}`, path: row.variant.path, channelId: row.channelId, at: row.at, minutes, title: row.variant.displayTitle });
    }
  }
  return out.sort((a, b) => fireTime(a) - fireTime(b) || a.key.localeCompare(b.key));
}

/** Desktop: reminders whose time fell between the previous tick and now, never older than 5 minutes. */
export function dueReminders(
  rows: readonly PostRow[],
  now: number,
  previous: number | null,
  offsets: (row: PostRow) => readonly number[] | null,
): ReminderItem[] {
  return reminderSlots(rows, Math.max(previous ?? Number.NEGATIVE_INFINITY, now - REMINDER_WINDOW_MS), now, now, offsets);
}
```

- [ ] **Step 4: Write the ledger**

`src/reminders/ntfy/bookings.ts`:
```ts
import type { App } from "obsidian";
import { isRecord } from "../../model/frontmatter";

/** One push this device booked on ntfy (#69: {deliveryId, offset, messageId, at}). */
export interface Booking {
  /** The reminder key (`<row key>@<post time>:<minutes>`): a rescheduled post gets new keys. */
  key: string;
  /** The delivery: `<note path>#<channel id>`. */
  rowKey: string;
  minutes: number;
  /** The id the ntfy server gave the message; used to cancel it. */
  messageId: string;
  /** When the push is due on the phone (epoch ms). */
  fireAt: number;
}

const KEY = "osmm-ntfy-bookings";

/** Device-local ledger of booked pushes (never the topic or the token), so a restart does not book twice. */
export class BookingLedger {
  constructor(private readonly app: App) {}

  all(): Booking[] {
    const raw: unknown = this.app.loadLocalStorage(KEY);
    if (!isRecord(raw)) return [];
    const out: Booking[] = [];
    for (const [key, v] of Object.entries(raw)) {
      if (!isRecord(v)) continue;
      const { rowKey, minutes, messageId, fireAt } = v;
      if (typeof rowKey === "string" && typeof minutes === "number" && typeof messageId === "string" && typeof fireAt === "number") {
        out.push({ key, rowKey, minutes, messageId, fireAt });
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
  }

  size(): number {
    return this.all().length;
  }

  get(key: string): Booking | undefined {
    return this.all().find((b) => b.key === key);
  }

  put(booking: Booking): void {
    this.save([...this.all().filter((b) => b.key !== booking.key), booking]);
  }

  remove(key: string): void {
    this.save(this.all().filter((b) => b.key !== key));
  }

  /** Drops bookings whose push time is before `before` (they have gone out). */
  prune(before: number): void {
    const all = this.all();
    const kept = all.filter((b) => b.fireAt >= before);
    if (kept.length !== all.length) this.save(kept);
  }

  clear(): void {
    if (this.app.loadLocalStorage(KEY) !== null) this.app.saveLocalStorage(KEY, null);
  }

  private save(list: readonly Booking[]): void {
    if (!list.length) return this.clear();
    const out: Record<string, Omit<Booking, "key">> = {};
    for (const { key, rowKey, minutes, messageId, fireAt } of list) out[key] = { rowKey, minutes, messageId, fireAt };
    this.app.saveLocalStorage(KEY, out);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/reminders && npm test`
Expected: PASS (the existing `dueReminders` table still passes unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/reminders/reminders.ts src/reminders/ntfy/bookings.ts test/reminders/reminders.test.ts test/reminders/ntfy/bookings.test.ts
git commit -m "feat(reminders): reminder slots for any window, frozen unreadable entries, device-local booking ledger (#69)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Rolling 72-hour booking on the publisher device (#69, part 2)

**Files:**
- Create: `src/reminders/ntfy/booker.ts`, `test/reminders/ntfy/booker.test.ts`

**Interfaces:**
- Consumes: `reminderSlots`, `fireTime`, `REMINDER_WINDOW_MS`, `ReminderItem` (Task 6); `BookingLedger`, `Booking` (Task 6); `NtfyClient.publish/cancel`, `NtfyMessage`, `NtfyError` (Task 5); `PublisherService` (Task 2, in the two-device test).
- Produces:
  - `BOOKING_WINDOW_MS = 72 h − 10 min`, `MAX_BOOKINGS_PER_RUN = 20`, `RETRY_MS = 5 min`.
  - `interface BookerDeps { rows(): PostRow[]; offsets(row: PostRow): readonly number[] | null; isPublisher(): boolean; enabled(): boolean; client: Pick<NtfyClient, "publish" | "cancel">; ledger: BookingLedger; compose(item: ReminderItem): Promise<NtfyMessage>; now(): number; warn(message: string): void }`
  - `interface SyncResult { booked: string[]; cancelled: string[]; leftStale: string[]; failed: string[] }` (reminder keys).
  - `class NtfyBooker { sync(): Promise<SyncResult> /* single-flight, never rejects */; withdraw(): Promise<SyncResult> /* cancel every pending booking, clear the ledger */; forget(): void /* clear the ledger without cancelling */ }`.
  - Behaviour of `sync()`: prune bookings older than 1 h; when this device is not the publisher or phone reminders are off, withdraw what it booked; while paused after a failure, do nothing; cancel bookings that are no longer wanted and not yet due (published early, skipped, rescheduled, reminders changed); book wanted reminders not in the ledger, fire time in `(now − 5 min, now + 72 h − 10 min]`, at most 20 per run; on any failure stop the run, pause 5 minutes (or `retryAfterMs` if longer) and warn once per failure streak.

- [ ] **Step 1: Write the failing tests**

`test/reminders/ntfy/booker.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App } from "../../fakes/obsidian";
import { formatDateTime } from "../../../src/model/dates";
import { BookingLedger } from "../../../src/reminders/ntfy/bookings";
import { BOOKING_WINDOW_MS, NtfyBooker, RETRY_MS, type BookerDeps } from "../../../src/reminders/ntfy/booker";
import { NtfyError, type NtfyMessage } from "../../../src/reminders/ntfy/client";
import { PublisherService } from "../../../src/settings/publisher";
import { migrateSettings } from "../../../src/settings/settings";
import { indexed, writeNote } from "../../helpers";
import { makeCtx, type TestCtx } from "../../ui/ctx";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const A = "Social/Posts/A.md";
const B = "Social/Posts/B.md";
const fm = (at: number, extra: Record<string, unknown> = {}) => ({
  type: "social-post",
  platform: "bluesky",
  channels: ["bs/you"],
  status: "scheduled",
  scheduled_at: formatDateTime(at),
  reminders: [60, 10],
  ...extra,
});
const key = (path: string, at: number, minutes: number) => `${path}#bs/you@${at}:${minutes}`;

function fakeClient(opts: { cancel?: "cancelled" | "unsupported" } = {}) {
  const sent: NtfyMessage[] = [];
  const cancelled: string[] = [];
  let calls = 0;
  let fail: Error | null = null;
  return {
    sent,
    cancelled,
    calls: () => calls,
    failWith: (e: Error | null) => void (fail = e),
    client: {
      publish: async (m: NtfyMessage) => {
        calls++;
        if (fail) throw fail;
        sent.push(m);
        return { id: `m${sent.length}`, at: m.at ?? 0 };
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        return opts.cancel ?? ("cancelled" as const);
      },
    },
  };
}

function booker(c: TestCtx, fake: ReturnType<typeof fakeClient>, now: { t: number }, over: Partial<BookerDeps> = {}, app: App = c.app) {
  const warnings: string[] = [];
  const b = new NtfyBooker({
    rows: () => c.ctx.actions.rows(),
    offsets: (row) => row.variant.reminders ?? null,
    isPublisher: () => true,
    enabled: () => true,
    client: fake.client,
    ledger: new BookingLedger(app as never),
    compose: async (item) => ({ title: `In ${item.minutes} min`, message: item.title }),
    now: () => now.t,
    warn: (m) => void warnings.push(m),
    ...over,
  });
  return { b, warnings };
}

describe("NtfyBooker (#69, fake clock)", () => {
  it("books every reminder of the next 72 hours once, at its time", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }, { path: B, frontmatter: fm(T0 + 100 * HOUR), body: "B" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    expect((await b.sync()).booked).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    expect(fake.sent.map((m) => m.at)).toEqual([T0 + 9 * HOUR, T0 + 10 * HOUR - 10 * MIN]);
    now.t += 30_000;
    expect((await b.sync()).booked).toEqual([]);
    expect(fake.sent).toHaveLength(2);
  });

  it("books nothing beyond the window (ntfy.sh keeps delayed pushes at most 3 days)", async () => {
    const edge = T0 + BOOKING_WINDOW_MS + 60 * MIN;
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(edge, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    expect((await b.sync()).booked).toEqual([key(A, edge, 60)]);
    const late = await makeCtx({ notes: [{ path: A, frontmatter: fm(edge + MIN, { reminders: [60] }), body: "A" }] });
    expect((await booker(late, fakeClient(), { t: T0 }).b.sync()).booked).toEqual([]);
  });

  it("rebooks a rescheduled post and cancels the old pushes (review focus 1)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 12 * HOUR), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 12 * HOUR);
    const r = await b.sync();
    expect(r.cancelled).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    expect(r.booked).toEqual([key(A, T0 + 12 * HOUR, 60), key(A, T0 + 12 * HOUR, 10)]);
    expect(fake.cancelled).toEqual(["m1", "m2"]);
    expect(new BookingLedger(c.app as never).all().map((x) => x.key)).toEqual(r.booked);
  });

  it("leaves the old push alone when the server can't cancel, and still books the new time", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 11 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 11 * HOUR);
    const r = await b.sync();
    expect([r.leftStale, r.booked]).toEqual([[key(A, T0 + 10 * HOUR, 60)], [key(A, T0 + 11 * HOUR, 60)]]);
    expect(new BookingLedger(c.app as never).size()).toBe(1);
  });

  it("cancels pushes for a post published or skipped early", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60], status: "skipped", deliveries: { "bs/you": { status: "skipped" } } }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "skipped");
    expect((await b.sync()).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60)]);
  });

  it("neither rebooks nor forgets across a restart two days later", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }, { path: B, frontmatter: fm(T0 + 100 * HOUR), body: "B" }] });
    const fake = fakeClient();
    await booker(c, fake, { t: T0 }).b.sync();
    expect(fake.sent).toHaveLength(2);
    const restarted = booker(c, fake, { t: T0 + 48 * HOUR });
    expect((await restarted.b.sync()).booked).toEqual([key(B, T0 + 100 * HOUR, 60), key(B, T0 + 100 * HOUR, 10)]);
    expect(new BookingLedger(c.app as never).all().map((x) => x.key)).toEqual([key(B, T0 + 100 * HOUR, 60), key(B, T0 + 100 * HOUR, 10)]);
    expect((await restarted.b.sync()).booked).toEqual([]);
  });

  it("sends a reminder just missed (within 5 minutes) at once, but not older ones", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 60 * MIN, { reminders: [62, 70] }), body: "A" }] });
    const fake = fakeClient();
    const r = await booker(c, fake, { t: T0 }).b.sync();
    expect(r.booked).toEqual([key(A, T0 + 60 * MIN, 62)]);
    expect(fake.sent[0]!.at).toBe(T0 - 2 * MIN);
  });

  it("never books an unreadable delivery entry", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { deliveries: { "bs/you": { status: "Scheduled!" } } }), body: "A" }] });
    const fake = fakeClient();
    expect((await booker(c, fake, { t: T0 }).b.sync()).booked).toEqual([]);
    expect(fake.calls()).toBe(0);
  });

  it("books only on the publisher; a device that loses the role withdraws its bookings (two fake devices, review focus 2)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    let synced = migrateSettings(null);
    const service = (deviceId: string) =>
      new PublisherService({ device: () => ({ deviceId, deviceName: deviceId }), settings: () => synced, update: async (p) => void (synced = { ...synced, ...p }), now: () => T0 });
    const laptop = service("laptop");
    const phone = service("phone");
    const phoneApp = new App();
    const laptopFake = fakeClient();
    const phoneFake = fakeClient();
    const onLaptop = booker(c, laptopFake, { t: T0 }, { isPublisher: () => laptop.isPublisher() });
    const onPhone = booker(c, phoneFake, { t: T0 }, { isPublisher: () => phone.isPublisher() }, phoneApp);
    await laptop.claim();
    await onLaptop.b.sync();
    await onPhone.b.sync();
    expect([laptopFake.sent.length, phoneFake.sent.length]).toEqual([2, 0]);
    await phone.claim();
    expect((await onLaptop.b.sync()).cancelled).toHaveLength(2);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
    expect((await onPhone.b.sync()).booked).toHaveLength(2);
  });

  it("withdraws when phone reminders are turned off, and forgets without cancelling on a new target", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    await b.sync();
    enabled = false;
    expect((await b.sync()).cancelled).toHaveLength(2);
    enabled = true;
    await b.sync();
    b.forget();
    expect(new BookingLedger(c.app as never).size()).toBe(0);
    expect(fake.cancelled).toHaveLength(2);
  });

  it("pauses 5 minutes after a failure and warns once per streak (review focus 3)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b, warnings } = booker(c, fake, now);
    fake.failWith(new NtfyError("server", "The ntfy server had a problem (502)."));
    expect((await b.sync()).failed).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    now.t += 30_000;
    await b.sync();
    expect(fake.calls()).toBe(1);
    now.t = T0 + RETRY_MS + 1;
    await b.sync();
    expect(fake.calls()).toBe(2);
    expect(warnings).toEqual(["Phone reminders: The ntfy server had a problem (502). Trying again in 5 min."]);
    fake.failWith(null);
    now.t = T0 + 2 * RETRY_MS + 2;
    expect((await b.sync()).booked).toHaveLength(2);
    fake.failWith(new NtfyError("rate_limited", "The ntfy server is limiting how often this device can send.", 20 * MIN));
    await writeNote(c.app as never, B, fm(T0 + 20 * HOUR), "B");
    await indexed(c.index, () => !!c.index.getVariant(B));
    await b.sync();
    expect(warnings.at(-1)).toBe("Phone reminders: The ntfy server is limiting how often this device can send. Trying again in 20 min.");
  });

  it("books at most 20 per run and runs one sync at a time", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    const [first, second] = await Promise.all([b.sync(), b.sync()]);
    expect(first).toBe(second);
    expect(first!.booked).toHaveLength(20);
    expect((await b.sync()).booked).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/reminders/ntfy/booker.test.ts`
Expected: FAIL — `src/reminders/ntfy/booker` missing.

- [ ] **Step 3: Write the booker**

`src/reminders/ntfy/booker.ts`:
```ts
import type { PostRow } from "../../index/queries";
import { HOUR, MINUTE } from "../../model/dates";
import { fireTime, REMINDER_WINDOW_MS, reminderSlots, type ReminderItem } from "../reminders";
import type { Booking, BookingLedger } from "./bookings";
import { NtfyError, type NtfyClient, type NtfyMessage } from "./client";

/** ntfy.sh keeps delayed pushes at most 3 days (spec §4.4); 10 minutes of margin for clock skew. */
export const BOOKING_WINDOW_MS = 72 * HOUR - 10 * MINUTE;
/** Stay well under public-server rate limits; the rest is booked on the next run. */
export const MAX_BOOKINGS_PER_RUN = 20;
/** Pause after a failed run, so a down server is not called every 30 seconds. */
export const RETRY_MS = 5 * MINUTE;

export interface BookerDeps {
  rows(): PostRow[];
  /** Minutes-before list for a row; null for rows that post by themselves (ReminderService.offsets). */
  offsets(row: PostRow): readonly number[] | null;
  isPublisher(): boolean;
  /** Phone reminders are on for this device. */
  enabled(): boolean;
  client: Pick<NtfyClient, "publish" | "cancel">;
  ledger: BookingLedger;
  compose(item: ReminderItem): Promise<NtfyMessage>;
  now(): number;
  warn(message: string): void;
}

export interface SyncResult {
  booked: string[];
  cancelled: string[];
  /** Bookings that no longer apply but could not be cancelled; the push will still arrive. */
  leftStale: string[];
  failed: string[];
}

const emptyResult = (): SyncResult => ({ booked: [], cancelled: [], leftStale: [], failed: [] });
const rowKeyOf = (key: string) => key.replace(/@\d+:\d+$/, "");

/**
 * Spec §4.4: every run on the publisher device books the phone reminders due in the next 72 hours and
 * cancels the ones that no longer apply. Deliveries are only read, never written: booking is not publishing.
 */
export class NtfyBooker {
  private running: Promise<SyncResult> | null = null;
  private pausedUntil = 0;
  private warned = false;

  constructor(private readonly deps: BookerDeps) {}

  /** Single-flight: a call during a run gets that run's result. Never rejects. */
  sync(): Promise<SyncResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Cancels every pending booking (where the server allows it) and clears the ledger. */
  async withdraw(): Promise<SyncResult> {
    await this.running;
    const result = emptyResult();
    await this.cancelAll(result);
    return result;
  }

  /** Clears the ledger without cancelling (the server, topic or token changed). */
  forget(): void {
    this.deps.ledger.clear();
    this.pausedUntil = 0;
  }

  private async run(): Promise<SyncResult> {
    const result = emptyResult();
    let current = "";
    try {
      const now = this.deps.now();
      this.deps.ledger.prune(now - HOUR);
      if (!this.deps.isPublisher() || !this.deps.enabled()) {
        await this.cancelAll(result);
        return result;
      }
      if (now < this.pausedUntil) return result;
      const wanted = new Map<string, ReminderItem>();
      for (const item of reminderSlots(this.deps.rows(), now - REMINDER_WINDOW_MS, now + BOOKING_WINDOW_MS, now, (r) => this.deps.offsets(r))) {
        wanted.set(item.key, item);
      }
      const booked = this.deps.ledger.all();
      for (const b of booked) {
        if (wanted.has(b.key) || b.fireAt <= now) continue;
        current = b.key;
        await this.cancel(b, result);
      }
      const have = new Set(booked.map((b) => b.key));
      let budget = MAX_BOOKINGS_PER_RUN;
      for (const item of wanted.values()) {
        if (have.has(item.key)) continue;
        if (budget === 0) break;
        budget--;
        current = item.key;
        const message = await this.deps.compose(item);
        const sent = await this.deps.client.publish({ ...message, at: fireTime(item) });
        this.deps.ledger.put({ key: item.key, rowKey: rowKeyOf(item.key), minutes: item.minutes, messageId: sent.id, fireAt: fireTime(item) });
        result.booked.push(item.key);
      }
      this.warned = false;
    } catch (e) {
      this.pause(e, result, current);
    }
    return result;
  }

  private async cancel(b: Booking, result: SyncResult): Promise<void> {
    const outcome = await this.deps.client.cancel(b.messageId);
    this.deps.ledger.remove(b.key);
    (outcome === "cancelled" ? result.cancelled : result.leftStale).push(b.key);
  }

  private async cancelAll(result: SyncResult): Promise<void> {
    const now = this.deps.now();
    const all = this.deps.ledger.all();
    if (!all.length) return;
    for (const b of all) {
      if (b.fireAt <= now) continue;
      try {
        await this.cancel(b, result);
      } catch {
        result.leftStale.push(b.key);
      }
    }
    this.deps.ledger.clear();
  }

  private pause(e: unknown, result: SyncResult, key: string): void {
    const wait = e instanceof NtfyError && e.retryAfterMs ? Math.max(e.retryAfterMs, RETRY_MS) : RETRY_MS;
    this.pausedUntil = this.deps.now() + wait;
    if (key) result.failed.push(key);
    if (this.warned) return;
    this.warned = true;
    // Only NtfyError messages are shown: they are scrubbed of the topic and token by the client.
    const reason = e instanceof NtfyError ? e.message : "a reminder could not be prepared.";
    this.deps.warn(`Phone reminders: ${reason} Trying again in ${Math.round(wait / MINUTE)} min.`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/reminders && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reminders/ntfy/booker.ts test/reminders/ntfy/booker.test.ts
git commit -m "feat(reminders): rolling 72-hour ntfy booking with rebook, cancel and back-off on the publisher (#69)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Notification content, phone actions and result alerts (#70)

**Files:**
- Create: `src/reminders/ntfy/content.ts`, `src/reminders/ntfy/alerts.ts`, `test/reminders/ntfy/content.test.ts`, `test/reminders/ntfy/alerts.test.ts`
- Modify: `src/publish/orchestrator.ts` (`PublishedInfo`, `onPublished`), `src/publish/actions.ts` (`DeliveryNotifier.published`), `src/main.ts` (`ready`, `openFromLink`, protocol handler), `test/fakes/obsidian.ts` (`registerObsidianProtocolHandler`, `Vault.getName`), `test/main.test.ts`

**Interfaces:**
- Consumes: `ReminderItem` (Task 6); `NtfyMessage`, `NtfyAction`, `NtfyClient.publish` (Task 5); `NtfyConfig` (Task 5); `PLATFORM_META`; `formatTime`; `FailureInfo`; `PublishActions.openAssisted(path, ids, step)`.
- Produces:
  - `POST_ACTION = "osmm-post"`, `SNOOZE_MINUTES = 10`; `obsidianUri(action, params)`, `postUri(vault, path, channelId, step?: 3)`, `openNoteUri(vault, path)`, `leadTime(minutes)` (`"10 min"`, `"1 h"`).
  - `interface ReminderContentDeps { vaultName(): string; variant(path: string): { platform: Platform; displayTitle: string } | undefined; channelName(channelId: string): string; targetUrl(path: string, channelId: string): Promise<string | null> }`
  - `reminderMessage(item: ReminderItem, deps: ReminderContentDeps, target: Pick<NtfyConfig, "server" | "topic" | "token">): Promise<NtfyMessage>` — title `"In 10 min · LinkedIn"`, message `"<post title>\n<channel> · <HH:mm>"`, priority 4 (≤ 15 min) or 3, tags `["osmm", <platform>]`, click = pre-filled page (mobile deep link first) or the Copy & open link; actions **Copy & open**, **Open note**, and **Snooze 10 min** (no token) or **Done** (with a token). The token never appears in the message.
  - `failureMessage(info: FailureInfo, deps)`, `publishedMessage(info: PublishedInfo, deps)` (deps without `targetUrl`).
  - `class PhoneAlerts { constructor(deps: { enabled(): boolean; isPublisher(): boolean; client: Pick<NtfyClient, "publish">; content: Omit<ReminderContentDeps, "targetUrl">; warn(message: string): void }); failed(info: FailureInfo): void; published(info: PublishedInfo): void }` — immediate pushes, only on the publisher with "Push publishing results" on.
  - `interface PublishedInfo { path: string; channelId: string; url?: string }`; `OrchestratorDeps.onPublished?(info: PublishedInfo): void` (called once per API publish, including one confirmed by `lookup()`); `DeliveryNotifier.published?(info: PublishedInfo): void`.
  - `OsmmPlugin.ready: Promise<void>` (resolves after the index is built and the scheduler started); `OsmmPlugin.openFromLink(params: Record<string, string>): Promise<void>`; handler `obsidian://osmm-post?vault=…&path=…&channel=…[&step=3]`.
  - Fake: `Plugin.protocolHandlers: Map<string, (params: Record<string, string>) => unknown>`, `Plugin.registerObsidianProtocolHandler(action, handler)`, `Vault.getName(): string` (`"Test Vault"`).

- [ ] **Step 1: Extend the fake**

In `test/fakes/obsidian.ts`:
- in `class Vault`, after the constructor, add:
```ts
  getName(): string {
    return "Test Vault";
  }
```
- in `class Plugin`, add the field `protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();` and the method:
```ts
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.protocolHandlers.set(action, handler);
  }
```

- [ ] **Step 2: Write the failing tests**

`test/reminders/ntfy/content.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { failureMessage, leadTime, openNoteUri, postUri, publishedMessage, reminderMessage, type ReminderContentDeps } from "../../../src/reminders/ntfy/content";
import type { ReminderItem } from "../../../src/reminders/reminders";

const AT = Date.UTC(2026, 9, 12, 16); // Mon 12 Oct 2026, 18:00 Berlin
const PATH = "Social/Event X/Event X – LinkedIn.md";
const item: ReminderItem = { key: `${PATH}#li/acme@${AT}:10`, path: PATH, channelId: "li/acme", at: AT, minutes: 10, title: "Event X is back" };
const deps = (target: string | null = "https://www.linkedin.com/feed/?shareActive=true&text=Hi"): ReminderContentDeps => ({
  vaultName: () => "My Vault",
  variant: () => ({ platform: "linkedin", displayTitle: "Event X is back" }),
  channelName: () => "Acme Studio",
  targetUrl: async () => target,
});
const COPY_OPEN = "obsidian://osmm-post?vault=My%20Vault&path=Social%2FEvent%20X%2FEvent%20X%20%E2%80%93%20LinkedIn.md&channel=li%2Facme";
const OPEN_NOTE = "obsidian://open?vault=My%20Vault&file=Social%2FEvent%20X%2FEvent%20X%20%E2%80%93%20LinkedIn.md";

describe("reminder pushes (#70, artboard 7)", () => {
  it("says when, where and what, and opens the pre-filled page when tapped", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    expect({ ...msg, actions: msg.actions!.slice(0, 2) }).toEqual({
      title: "In 10 min · LinkedIn",
      message: "Event X is back\nAcme Studio · 18:00",
      priority: 4,
      tags: ["osmm", "linkedin"],
      click: "https://www.linkedin.com/feed/?shareActive=true&text=Hi",
      actions: [
        { action: "view", label: "Copy & open", url: COPY_OPEN, clear: true },
        { action: "view", label: "Open note", url: OPEN_NOTE },
      ],
    });
  });

  it("snoozes by re-posting the same push 10 minutes later", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    const snooze = msg.actions![2]!;
    expect(snooze).toMatchObject({ action: "http", label: "Snooze 10 min", url: "https://ntfy.sh/", method: "POST", headers: { "Content-Type": "application/json" }, clear: true });
    expect(JSON.parse((snooze as { body: string }).body)).toEqual({
      topic: "osmm-abc",
      title: "In 10 min · LinkedIn",
      message: "Event X is back\nAcme Studio · 18:00",
      priority: 4,
      tags: ["osmm", "linkedin"],
      click: "https://www.linkedin.com/feed/?shareActive=true&text=Hi",
      actions: msg.actions!.slice(0, 2),
      delay: "10m",
    });
  });

  it("offers Done instead of Snooze with an access token, and never includes the token", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://push.example.org", topic: "osmm-abc", token: "tk_SECRET" });
    expect(msg.actions![2]).toEqual({ action: "view", label: "Done", url: `${COPY_OPEN}&step=3`, clear: true });
    expect(JSON.stringify(msg)).not.toContain("tk_SECRET");
  });

  it("falls back to the Copy & open link when the platform has no page to pre-fill", async () => {
    const msg = await reminderMessage({ ...item, minutes: 60 }, deps(null), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    expect([msg.title, msg.priority, msg.click]).toEqual(["In 1 h · LinkedIn", 3, COPY_OPEN]);
  });

  it("formats lead times and links", () => {
    expect([leadTime(10), leadTime(60), leadTime(90), leadTime(120)]).toEqual(["10 min", "1 h", "90 min", "2 h"]);
    expect(postUri("V", "a b.md", "x/y", 3)).toBe("obsidian://osmm-post?vault=V&path=a%20b.md&channel=x%2Fy&step=3");
    expect(openNoteUri("V", "a b.md")).toBe("obsidian://open?vault=V&file=a%20b.md");
  });
});

describe("result pushes (#70, optional)", () => {
  const d = deps();
  it("alerts a failure with the note to fix", () => {
    expect(failureMessage({ path: PATH, channelId: "li/acme", kind: "needs_user", error: "Token expired" }, d)).toEqual({
      title: "Couldn't publish · LinkedIn",
      message: "Event X is back\nAcme Studio: Token expired",
      priority: 4,
      tags: ["osmm", "failed"],
      click: OPEN_NOTE,
      actions: [{ action: "view", label: "Open note", url: OPEN_NOTE }],
    });
  });

  it("confirms an automatic post with its link", () => {
    expect(publishedMessage({ path: PATH, channelId: "li/acme", url: "https://www.linkedin.com/feed/update/1" }, d)).toEqual({
      title: "Posted · LinkedIn",
      message: "Event X is back\nAcme Studio",
      priority: 2,
      tags: ["osmm", "published"],
      click: "https://www.linkedin.com/feed/update/1",
    });
  });
});
```

`test/reminders/ntfy/alerts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../../src/model/dates";
import type { PublishedInfo } from "../../../src/publish/orchestrator";
import { PhoneAlerts } from "../../../src/reminders/ntfy/alerts";
import type { NtfyMessage } from "../../../src/reminders/ntfy/client";
import { settle } from "../../helpers";
import { makeCtx, TEST_NOW } from "../../ui/ctx";

const content = { vaultName: () => "V", variant: () => ({ platform: "bluesky" as const, displayTitle: "Hi" }), channelName: () => "@you" };

function build(over: { enabled?: boolean; publisher?: boolean; fail?: boolean } = {}) {
  const sent: NtfyMessage[] = [];
  const warnings: string[] = [];
  const alerts = new PhoneAlerts({
    enabled: () => over.enabled ?? true,
    isPublisher: () => over.publisher ?? true,
    client: { publish: async (m) => (over.fail ? Promise.reject(new Error("The ntfy server had a problem (502).")) : (sent.push(m), { id: "x", at: 0 })) },
    content,
    warn: (m) => void warnings.push(m),
  });
  return { alerts, sent, warnings };
}

describe("PhoneAlerts", () => {
  it("pushes failures and confirmations on the publisher when enabled", async () => {
    const { alerts, sent } = build();
    alerts.failed({ path: "p.md", channelId: "bs/you", kind: "transient", error: "503" });
    alerts.published({ path: "p.md", channelId: "bs/you", url: "https://bsky.app/profile/you/post/1" });
    await settle();
    expect(sent.map((m) => m.title)).toEqual(["Couldn't publish · Bluesky", "Posted · Bluesky"]);
  });

  it("stays quiet when off or on another device, and only warns when a push fails", async () => {
    for (const over of [{ enabled: false }, { publisher: false }]) {
      const { alerts, sent } = build(over);
      alerts.failed({ path: "p.md", channelId: "bs/you", kind: "transient", error: "503" });
      await settle();
      expect(sent).toEqual([]);
    }
    const { alerts, warnings } = build({ fail: true });
    alerts.published({ path: "p.md", channelId: "bs/you" });
    await settle();
    expect(warnings).toEqual(["Phone alert not sent: The ntfy server had a problem (502)."]);
  });

  it("hears about API publishes from the orchestrator", async () => {
    const P = "Social/Posts/P.md";
    const c = await makeCtx({
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(TEST_NOW + 3_600_000) }, body: "Hi" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    const seen: PublishedInfo[] = [];
    c.ctx.publish.notifier = { due: () => undefined, failed: () => undefined, published: (i) => void seen.push(i) };
    await c.ctx.publish.orchestrator.run(P, "bs/you");
    expect(seen).toEqual([{ path: P, channelId: "bs/you", url: "https://bsky.app/profile/you/post/1" }]);
  });
});
```

Add to `test/main.test.ts` (extend the helpers import with `writeNote` and `indexed` if not already there):
```ts
  it("opens the assisted flow from a phone reminder link once the index is ready (#70, review focus 5)", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00" }, "Hi");
    await settle();
    let ready: (() => unknown) | undefined;
    app.workspace.onLayoutReady = (cb) => {
      ready = cb;
    };
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.updateSettings({ channels: [{ id: "bs/you", platform: "bluesky", name: "@you", kind: "account", avatarColor: "#c9c3b8", method: "assisted" }] as never });
    Modal.opened = [];
    const handler = (plugin as unknown as { protocolHandlers: Map<string, (p: Record<string, string>) => Promise<void>> }).protocolHandlers.get("osmm-post")!;
    const opening = handler({ action: "osmm-post", vault: "Test Vault", path: P, channel: "bs/you" });
    await settle(20);
    expect(Modal.opened).toEqual([]);
    await ready?.();
    await opening;
    expect(Modal.opened.at(-1)?.titleEl.textContent).toBe("Post");
    plugin.unload();
  });

  it("does not reopen a post that is already out from a phone link", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "published", deliveries: { "bs/you": { status: "published" } } }, "Hi");
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    Modal.opened = [];
    Notice.messages = [];
    await plugin.openFromLink({ path: P, channel: "bs/you", step: "3" });
    await plugin.openFromLink({ path: P, channel: "bs/you" });
    await plugin.openFromLink({ path: "Social/Posts/Gone.md", channel: "bs/you" });
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual(["bs/you is already done for this post.", "Nothing left to post for this note.", "That post is no longer in this vault."]);
    expect(plugin.index.getVariant(P)?.deliveries["bs/you"]?.status).toBe("published");
    plugin.unload();
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/reminders/ntfy test/main.test.ts`
Expected: FAIL — `content`/`alerts` missing, no `onPublished`, no protocol handler.

- [ ] **Step 4: Report API publishes from the orchestrator**

In `src/publish/orchestrator.ts`:
- after `export interface FailureInfo { … }`, add:
```ts
export interface PublishedInfo {
  path: string;
  channelId: string;
  url?: string;
}
```
- in `OrchestratorDeps`, after `onFailure(info: FailureInfo): void;`, add:
```ts
  /** Called once when a delivery is published through its API (phone confirmations, #70). */
  onPublished?(info: PublishedInfo): void;
```
- in `attempt()`, after the `void this.deps.log.append({ … result: "published", url: res.url });` line, add:
```ts
      this.deps.onPublished?.({ path: p.path, channelId: p.channelId, url: res.url });
```
- in `checkNeeded()`, after its `void this.deps.log.append({ … result: "published", url: remote.url });` line, add:
```ts
      this.deps.onPublished?.({ path: p.path, channelId: p.channelId, ...(remote.url ? { url: remote.url } : {}) });
```

In `src/publish/actions.ts`:
- change the orchestrator import to `import { PublishOrchestrator, type FailureInfo, type PublishedInfo, type RunResult } from "./orchestrator";`
- in `interface DeliveryNotifier`, add `published?(info: PublishedInfo): void;`
- in the `new PublishOrchestrator({ … })` call, after `onFailure: (info) => this.notifier.failed(info),` add `onPublished: (info) => this.notifier.published?.(info),`

- [ ] **Step 5: Write the content and the alerts**

`src/reminders/ntfy/content.ts`:
```ts
import { PLATFORM_META, type Platform } from "../../model/platforms";
import type { FailureInfo, PublishedInfo } from "../../publish/orchestrator";
import { formatTime } from "../../ui/format";
import type { ReminderItem } from "../reminders";
import type { NtfyAction, NtfyMessage } from "./client";
import type { NtfyConfig } from "./config";

/** `obsidian://osmm-post?vault=…&path=…&channel=…[&step=3]` opens the assisted flow for one channel. */
export const POST_ACTION = "osmm-post";
export const SNOOZE_MINUTES = 10;

export interface ReminderContentDeps {
  vaultName(): string;
  variant(path: string): { platform: Platform; displayTitle: string } | undefined;
  channelName(channelId: string): string;
  /** The pre-filled compose page for the delivery (mobile deep link first), or null when there is none. */
  targetUrl(path: string, channelId: string): Promise<string | null>;
}

export function obsidianUri(action: string, params: Record<string, string>): string {
  return `obsidian://${action}?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;
}

export function postUri(vault: string, path: string, channelId: string, step?: 3): string {
  return obsidianUri(POST_ACTION, { vault, path, channel: channelId, ...(step ? { step: String(step) } : {}) });
}

export function openNoteUri(vault: string, path: string): string {
  return obsidianUri("open", { vault, file: path });
}

export function leadTime(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

const label = (v: { platform: Platform } | undefined) => (v ? PLATFORM_META[v.platform].label : "Post");

/**
 * Artboard 7 / #70. Tapping the push opens the pre-filled page; the buttons open the assisted flow in
 * Obsidian (which copies the text and opens the page), open the note, and snooze. An ntfy `http` action
 * runs on the phone without credentials, so with an access token the third button is Done instead
 * (the token must never travel inside a notification).
 */
export async function reminderMessage(item: ReminderItem, deps: ReminderContentDeps, target: Pick<NtfyConfig, "server" | "topic" | "token">): Promise<NtfyMessage> {
  const v = deps.variant(item.path);
  const vault = deps.vaultName();
  const copyOpen = postUri(vault, item.path, item.channelId);
  const base = {
    title: `In ${leadTime(item.minutes)} · ${label(v)}`,
    message: `${item.title}\n${deps.channelName(item.channelId)} · ${formatTime(item.at)}`,
    priority: (item.minutes <= 15 ? 4 : 3) as 3 | 4,
    tags: ["osmm", ...(v ? [v.platform] : [])],
    click: (await deps.targetUrl(item.path, item.channelId)) ?? copyOpen,
  };
  const actions: NtfyAction[] = [
    { action: "view", label: "Copy & open", url: copyOpen, clear: true },
    { action: "view", label: "Open note", url: openNoteUri(vault, item.path) },
  ];
  const third: NtfyAction = target.token
    ? { action: "view", label: "Done", url: postUri(vault, item.path, item.channelId, 3), clear: true }
    : {
        action: "http",
        label: `Snooze ${SNOOZE_MINUTES} min`,
        url: `${target.server}/`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: target.topic, ...base, actions, delay: `${SNOOZE_MINUTES}m` }),
        clear: true,
      };
  return { ...base, actions: [...actions, third] };
}

export function failureMessage(info: FailureInfo, deps: Omit<ReminderContentDeps, "targetUrl">): NtfyMessage {
  const v = deps.variant(info.path);
  const note = openNoteUri(deps.vaultName(), info.path);
  return {
    title: `Couldn't publish · ${label(v)}`,
    message: `${v?.displayTitle ?? info.path}\n${deps.channelName(info.channelId)}: ${info.error}`,
    priority: 4,
    tags: ["osmm", "failed"],
    click: note,
    actions: [{ action: "view", label: "Open note", url: note }],
  };
}

export function publishedMessage(info: PublishedInfo, deps: Omit<ReminderContentDeps, "targetUrl">): NtfyMessage {
  const v = deps.variant(info.path);
  return {
    title: `Posted · ${label(v)}`,
    message: `${v?.displayTitle ?? info.path}\n${deps.channelName(info.channelId)}`,
    priority: 2,
    tags: ["osmm", "published"],
    click: info.url ?? openNoteUri(deps.vaultName(), info.path),
  };
}
```

`src/reminders/ntfy/alerts.ts`:
```ts
import type { FailureInfo, PublishedInfo } from "../../publish/orchestrator";
import type { NtfyClient, NtfyMessage } from "./client";
import { failureMessage, publishedMessage, type ReminderContentDeps } from "./content";

export interface PhoneAlertsDeps {
  /** Phone reminders on, plus "Push publishing results" on this device. */
  enabled(): boolean;
  isPublisher(): boolean;
  client: Pick<NtfyClient, "publish">;
  content: Omit<ReminderContentDeps, "targetUrl">;
  warn(message: string): void;
}

/** Optional pushes for automatic-post results (#70). Immediate, never booked; only the publisher sends them. */
export class PhoneAlerts {
  constructor(private readonly deps: PhoneAlertsDeps) {}

  failed(info: FailureInfo): void {
    this.send(() => failureMessage(info, this.deps.content));
  }

  published(info: PublishedInfo): void {
    this.send(() => publishedMessage(info, this.deps.content));
  }

  private send(build: () => NtfyMessage): void {
    if (!this.deps.enabled() || !this.deps.isPublisher()) return;
    void this.deps.client.publish(build()).catch((e: unknown) => {
      // NtfyError messages are scrubbed of the topic and token by the client.
      this.deps.warn(`Phone alert not sent: ${e instanceof Error ? e.message : "unknown error"}`);
    });
  }
}
```

- [ ] **Step 6: Handle `obsidian://osmm-post` in the plugin**

In `src/main.ts`:
- add `import { POST_ACTION } from "./reminders/ntfy/content";`
- add the fields (after `private started = false;`):
```ts
  private markReady: () => void = () => undefined;
  /** Resolves once the index is built and the scheduler runs; phone links wait for it (cold start). */
  readonly ready: Promise<void> = new Promise((resolve) => (this.markReady = resolve));
```
- in `onLayoutReady`, after `this.started = true;` add `this.markReady();`
- after `registerCommands(this);` add:
```ts
    this.registerObsidianProtocolHandler(POST_ACTION, (params) => this.openFromLink(params));
```
- add the method (after `setDevice`):
```ts
  /** A tap on a phone reminder (#70): opens the assisted flow once ready; never marks anything by itself. */
  async openFromLink(params: Record<string, string>): Promise<void> {
    const { path, channel } = params;
    if (!path || !channel) return;
    await this.ready;
    if (this.unloaded) return;
    const v = this.index.getVariant(path);
    if (!v) {
      new Notice("That post is no longer in this vault.");
      return;
    }
    const ui = this.uiContext();
    if (params.step === "3") {
      const status = v.deliveries[channel]?.status;
      if (status === "published" || status === "skipped") {
        new Notice(`${this.channels.get(channel)?.name ?? channel} is already done for this post.`);
        return;
      }
      ui.publish.openAssisted(path, [channel], 3);
      return;
    }
    ui.publish.openAssisted(path, [channel]);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/reminders test/publish test/main.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/reminders/ntfy/content.ts src/reminders/ntfy/alerts.ts src/publish/orchestrator.ts src/publish/actions.ts src/main.ts test/fakes/obsidian.ts test/reminders/ntfy/content.test.ts test/reminders/ntfy/alerts.test.ts test/main.test.ts
git commit -m "feat(reminders): phone push content with Copy & open, Open note and Snooze; result alerts (#70)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: ntfy settings, onboarding and plugin wiring (#71, epic #67)

**Files:**
- Modify: `src/settings/tab.ts`, `src/main.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: `NtfyClient`, `testMessage`, `NtfyError` (Task 5); `ntfyTarget`, `normalizeServer`, `randomTopic`, `TOPIC_RE`, `DEFAULT_NTFY_SERVER` (Task 5); `BookingLedger` (Task 6); `NtfyBooker` (Task 7); `reminderMessage`, `ReminderContentDeps`, `PhoneAlerts` (Task 8); `ReminderService.offsets`; `PublishActions.target`; `ComposerActions.content`; `PublisherService` (Task 2); `OsmmPlugin.setDevice` (Task 3); `ClipboardService.copyText`; `confirmDialog`; `SecretIds`.
- Produces:
  - `OsmmPlugin.ntfy: NtfyClient`, `OsmmPlugin.phone: NtfyBooker`.
  - Every scheduler tick runs the desktop reminders, then `phone.sync()` (the booker itself checks the publisher role and the on/off setting); index changes trigger a sync after 5 seconds of quiet.
  - `PublishActions.notifier` fans out to the desktop `Notifier` and to `PhoneAlerts`.
  - Settings section **Phone reminders (ntfy)**: "About phone reminders" (how it works, privacy of public topics), "Phone reminders on this device" (toggle; turning it on creates a random topic in secret storage; turning it off cancels the bookings), and, when on: "Server", "Topic" (+ Copy, New topic), "Access token" (password field, secret storage), "Set up your phone" (the three steps), "Send a test notification", "Push publishing results".

- [ ] **Step 1: Write the failing tests**

In `test/main.test.ts`:
- extend imports: `requestUrlMock` from `./fakes/obsidian`; `import { NTFY } from "./reminders/ntfy/fixtures";`; `import { formatDateTime } from "../src/model/dates";`
- in "renders the General settings and applies edits", insert after `"Desktop notifications on this device",`:
```ts
      "Phone reminders (ntfy)",
      "About phone reminders",
      "Phone reminders on this device",
```
- add:
```ts
  it("sets up phone reminders with the topic in secret storage only (#71)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    expect(last("About phone reminders").desc).toContain("anyone who knows the topic can read");
    await (last("Phone reminders on this device").components[0] as ToggleComponent).toggle(true);
    const topic = app.secretStorage.getSecret("osmm-ntfy-topic")!;
    expect(topic).toMatch(/^osmm-[a-z0-9]{24}$/);
    expect(plugin.device.ntfy.enabled).toBe(true);
    expect(Setting.all.map((s) => s.name)).toEqual(expect.arrayContaining(["Server", "Topic", "Access token", "Set up your phone", "Send a test notification", "Push publishing results"]));
    expect((last("Topic").components[0] as TextComponent).value).toBe(topic);

    await (last("Access token").components[0] as TextComponent).change(" tk_SECRETTOKEN ");
    expect(app.secretStorage.getSecret("osmm-ntfy-token")).toBe("tk_SECRETTOKEN");
    expect((last("Access token").components[0] as TextComponent).inputEl.type).toBe("password");
    for (const stored of [JSON.stringify(await plugin.loadData()), JSON.stringify(app.loadLocalStorage("osmm-device"))]) {
      expect(stored).not.toContain(topic);
      expect(stored).not.toContain("tk_SECRETTOKEN");
    }

    Notice.messages = [];
    requestUrlMock.queue.push(NTFY.published, NTFY.forbidden);
    await (last("Send a test notification").components[0] as ButtonComponent).click();
    await (last("Send a test notification").components[0] as ButtonComponent).click();
    expect(requestUrlMock.calls[0]!.headers).toEqual({ Authorization: "Bearer tk_SECRETTOKEN" });
    expect(Notice.messages[0]).toBe("Test sent. It should reach your phone within a few seconds.");
    expect(Notice.messages[1]).toMatch(/^Couldn't send the test: The ntfy server refused this device/);
    expect(Notice.messages.join(" ")).not.toContain(topic);

    await (last("Server").components[0] as TextComponent).change("https://push.example.org/");
    expect(plugin.device.ntfy.server).toBe("https://push.example.org");
    await (last("Server").components[0] as TextComponent).change("not a server");
    expect(plugin.device.ntfy.server).toBe("https://push.example.org");
    plugin.unload();
  });

  it("books phone reminders on the publisher and makes no request when they are off (#67)", async () => {
    const { app, plugin } = await loaded();
    await writeNote(app as never, "Social/Posts/R.md", { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + 2 * 3_600_000), reminders: [60] }, "Hi");
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    await plugin.scheduler.tick();
    await plugin.phone.sync();
    expect(requestUrlMock.calls).toEqual([]);

    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-maintesttopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    await plugin.phone.sync();
    expect(requestUrlMock.calls).toEqual([]); // enabled, but not the publisher

    // Becoming the publisher runs the startup check and a tick, and the tick books the reminder.
    requestUrlMock.queue.push(NTFY.scheduled);
    await plugin.publisher.claim();
    await settle(50);
    expect(requestUrlMock.calls).toHaveLength(1);
    const body = JSON.parse(String(requestUrlMock.calls[0]!.body));
    expect(body).toMatchObject({ topic: "osmm-maintesttopic", title: "In 1 h · Bluesky" });
    expect(Number(body.delay) * 1000).toBeGreaterThan(Date.now());
    expect((await plugin.phone.sync()).booked).toEqual([]);
    expect(JSON.stringify(app.loadLocalStorage("osmm-ntfy-bookings"))).not.toContain("osmm-maintesttopic");
    plugin.unload();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — no phone section in the settings; `plugin.phone` is undefined.

- [ ] **Step 3: Wire the client, the booker and the alerts into the plugin**

In `src/main.ts`:
- add imports:
```ts
import { PhoneAlerts } from "./reminders/ntfy/alerts";
import { NtfyBooker } from "./reminders/ntfy/booker";
import { BookingLedger } from "./reminders/ntfy/bookings";
import { NtfyClient } from "./reminders/ntfy/client";
import { ntfyTarget } from "./reminders/ntfy/config";
import { reminderMessage, type ReminderContentDeps } from "./reminders/ntfy/content";
```
  (merge `POST_ACTION` into the `./reminders/ntfy/content` import from Task 8)
- add the fields `ntfy!: NtfyClient;` and `phone!: NtfyBooker;` (after `reminders!: ReminderService;`)
- replace `ui.publish.notifier = notifier;` with nothing (it moves below), and directly after the `this.reminders = new ReminderService({ … });` statement add:
```ts
    this.ntfy = new NtfyClient(() => ntfyTarget(this.device, this.secrets));
    const phoneContent: ReminderContentDeps = {
      vaultName: () => this.app.vault.getName(),
      variant: (path) => this.index.getVariant(path),
      channelName: (id) => this.channels.get(id)?.name ?? id,
      targetUrl: async (path, channelId) => {
        const v = this.index.getVariant(path);
        const channel = this.channels.get(channelId);
        if (!v || !channel) return null;
        const target = ui.publish.target(v, channel, await ui.composer.content.load(v));
        return target.mobileUrl ?? target.url;
      },
    };
    this.phone = new NtfyBooker({
      rows: () => ui.actions.rows(),
      offsets: (row) => this.reminders.offsets(row),
      isPublisher: () => this.publisher.isPublisher(),
      enabled: () => this.device.ntfy.enabled,
      client: this.ntfy,
      ledger: new BookingLedger(this.app),
      compose: async (item) => {
        const target = ntfyTarget(this.device, this.secrets);
        if (!target) throw new Error("Phone reminders aren't set up.");
        return reminderMessage(item, phoneContent, target);
      },
      now: () => Date.now(),
      warn: (message) => new Notice(message, 0),
    });
    const alerts = new PhoneAlerts({
      enabled: () => this.device.ntfy.enabled && this.device.ntfy.results,
      isPublisher: () => this.publisher.isPublisher(),
      client: this.ntfy,
      content: phoneContent,
      warn: (message) => new Notice(message),
    });
    ui.publish.notifier = {
      due: (path, channelId) => notifier.due(path, channelId),
      failed: (info) => {
        notifier.failed(info);
        alerts.failed(info);
      },
      published: (info) => alerts.published(info),
    };
```
- in the `Scheduler` deps, replace the `onTick` entry with:
```ts
      onTick: (now, previous) =>
        Promise.resolve()
          .then(async () => {
            await this.reminders.tick(now, previous);
          })
          .catch((e) => void new Notice(e instanceof Error ? e.message : String(e), 0))
          // Phone bookings run on every tick; the booker itself checks the publisher role (spec §4.3–4.4).
          .then(() => this.phone.sync())
          .then(() => undefined),
```
- after `this.register(() => this.index.stop());` add:
```ts
    // Rebook soon after an edit (reschedule, skip, publish early) instead of waiting for the next tick.
    let pendingSync: number | null = null;
    this.register(
      this.index.onChange(() => {
        if (pendingSync !== null) window.clearTimeout(pendingSync);
        pendingSync = window.setTimeout(() => {
          pendingSync = null;
          void this.phone.sync();
        }, 5_000);
      }),
    );
    this.register(() => {
      if (pendingSync !== null) window.clearTimeout(pendingSync);
    });
```
  (this block uses `this.phone` lazily, so its position before the booker is created is fine as long as it stays after `this.index` is created)

- [ ] **Step 4: Add the settings section**

In `src/settings/tab.ts`:
- add imports:
```ts
import { Notice } from "obsidian";
import { ClipboardService } from "../publish/clipboard";
import { testMessage } from "../reminders/ntfy/client";
import { DEFAULT_NTFY_SERVER, normalizeServer, randomTopic, TOPIC_RE } from "../reminders/ntfy/config";
import { SecretIds } from "../secrets/secrets";
```
  (merge `Notice` into the existing `obsidian` import)
- add constants above the class:
```ts
const ABOUT_PHONE =
  "Pushes your reminders to the free ntfy app on your phone, so they arrive even when this computer is asleep. The publisher device books each reminder up to 72 hours ahead. Privacy: on a public server such as ntfy.sh, anyone who knows the topic can read these pushes (post titles and links). Keep the long random topic, or use your own ntfy server with an access token.";
const SETUP_PHONE =
  "1. Install ntfy from the App Store or Google Play. 2. In the app, tap + and enter the topic above; for your own server, turn on “Use another server” and enter its address. 3. Tap “Send test” below: it should arrive within a few seconds.";
```
- in `display()`, after the "Desktop notifications on this device" setting and before `new Setting(containerEl).setName("Channels").setHeading();`, add `this.phoneSection(containerEl);`
- add the method to the class:
```ts
  private phoneSection(containerEl: HTMLElement): void {
    const osmm = this.osmm;
    const ntfy = osmm.device.ntfy;
    const setNtfy = (patch: Partial<typeof ntfy>) => osmm.setDevice({ ntfy: { ...osmm.device.ntfy, ...patch } });

    new Setting(containerEl).setName("Phone reminders (ntfy)").setHeading();
    new Setting(containerEl).setName("About phone reminders").setDesc(ABOUT_PHONE);

    const role = osmm.publisher.state();
    new Setting(containerEl)
      .setName("Phone reminders on this device")
      .setDesc(
        role.kind === "this"
          ? "This device books a push for every reminder of the next 72 hours."
          : role.kind === "other"
            ? `Only the publisher device books phone reminders. Publishing happens on ${role.name}.`
            : "Only the publisher device books phone reminders. Choose one under This device.",
      )
      .addToggle((t) =>
        t.setValue(ntfy.enabled).onChange(async (value) => {
          if (!value) await osmm.phone.withdraw();
          if (value && !osmm.secrets.get(SecretIds.ntfyTopic)) osmm.secrets.set(SecretIds.ntfyTopic, randomTopic());
          setNtfy({ enabled: value });
          this.display();
        }),
      );
    if (!ntfy.enabled) return;

    new Setting(containerEl)
      .setName("Server")
      .setDesc("https://ntfy.sh, or the address of your own ntfy server.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_NTFY_SERVER)
          .setValue(ntfy.server)
          .onChange((value) => {
            const server = normalizeServer(value.trim() || DEFAULT_NTFY_SERVER);
            if (!server) return;
            osmm.phone.forget();
            setNtfy({ server });
          }),
      );

    new Setting(containerEl)
      .setName("Topic")
      .setDesc("Subscribe to this topic in the ntfy app. Letters, digits, - and _ only. Stored in this device's secret storage.")
      .addText((t) =>
        t.setValue(osmm.secrets.get(SecretIds.ntfyTopic) ?? "").onChange((value) => {
          const topic = value.trim();
          if (!TOPIC_RE.test(topic)) return;
          osmm.phone.forget();
          osmm.secrets.set(SecretIds.ntfyTopic, topic);
        }),
      )
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          const topic = osmm.secrets.get(SecretIds.ntfyTopic);
          if (topic && (await new ClipboardService(this.app).copyText(topic))) new Notice("Topic copied.");
        }),
      )
      .addButton((b) =>
        b.setButtonText("New topic").onClick(async () => {
          const ok = await confirmDialog(this.app, "Make a new random topic? Your phone must subscribe to it again. Reminders already booked on the old topic are cancelled where the server allows it.", "New topic");
          if (!ok) return;
          await osmm.phone.withdraw();
          osmm.secrets.set(SecretIds.ntfyTopic, randomTopic());
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Access token")
      .setDesc("Only for protected topics (your own server, or a reserved ntfy.sh topic). Stored in this device's secret storage.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("tk_…")
          .setValue(osmm.secrets.get(SecretIds.ntfyToken) ?? "")
          .onChange((value) => {
            osmm.phone.forget();
            osmm.secrets.set(SecretIds.ntfyToken, value.trim());
          });
      });

    new Setting(containerEl).setName("Set up your phone").setDesc(SETUP_PHONE);

    new Setting(containerEl).setName("Send a test notification").addButton((b) =>
      b.setButtonText("Send test").onClick(async () => {
        try {
          await osmm.ntfy.publish(testMessage());
          new Notice("Test sent. It should reach your phone within a few seconds.");
        } catch (e) {
          new Notice(`Couldn't send the test: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );

    new Setting(containerEl)
      .setName("Push publishing results")
      .setDesc("Also push a confirmation when a post goes out automatically, and an alert when one fails (sent by the publisher device).")
      .addToggle((t) => t.setValue(ntfy.results).onChange((value) => setNtfy({ results: value })));
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main.test.ts && npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS; the bundle builds.

- [ ] **Step 6: Commit**

```bash
git add src/settings/tab.ts src/main.ts test/main.test.ts
git commit -m "feat(reminders): ntfy settings with onboarding and test push; book phone reminders on every tick (#71, #67)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and M3 acceptance pass

**Files:**
- Create: `docs/qa/m3.md`
- Modify: `README.md`, `docs/getting-started.md`

**Interfaces:**
- Consumes: everything above.
- Produces: user docs for the publisher device, phone reminders and the publish log; a manual QA checklist for M3 (run on a desktop plus an iPhone and an Android phone).

- [ ] **Step 1: Update the README**

In `README.md`:
- replace the "Never miss or double-post" bullet with:
```markdown
- **Never miss or double-post:** reminders before each assisted post (60 and 10 minutes by default) on the desktop and, through the free ntfy app, on your phone even when the computer is asleep; an Overdue tray for anything whose time passed while Obsidian was closed; one publisher device, so a vault synced to several devices never posts twice; and a publish log in `Social/_log.md`.
```
- replace `The plugin works on desktop and on phones; reminders on phones arrive with a later version.` with `The plugin works on desktop and on phones (iOS and Android); phone reminders use the free ntfy app.`
- in "Your data", replace the second and third bullets with:
```markdown
- Channels live in the plugin settings. Credentials, the ntfy topic and the ntfy token are kept in Obsidian's per-device secret storage, never in your notes or in synced settings.
- Every publish attempt is appended to `Social/_log.md` (earlier months move to `Social/_log/`). Secrets are never written there.
- Reminders, notification settings, the device name and the phone-reminder setup are per device. The synced settings only record which device publishes.
```

- [ ] **Step 2: Extend the getting-started guide**

In `docs/getting-started.md`, insert before `## When something goes wrong`:
```markdown
## 6. Choose the publisher device (1 minute)

If your vault syncs to several devices, only one of them should post. Open **Settings → Social Planner → This device**, give the device a name (for example "Studio iMac") and click **Make this device the publisher**. Your other devices show "Publishing happens on Studio iMac" and only show the plan and their own desktop reminders. To move the role, click **Publish from this device instead** on the other device; the first one stops as soon as the change reaches it through sync.

## 7. Get reminders on your phone (2 minutes, optional)

On the publisher device, open **Settings → Social Planner → Phone reminders (ntfy)** and turn on **Phone reminders on this device**. A long random topic is created for you.

1. Install **ntfy** from the App Store or Google Play.
2. In the app, tap **+** and enter the topic shown in the settings (**Copy** puts it on the clipboard).
3. Click **Send test**. The test push should arrive within a few seconds.

From now on, each reminder arrives on the phone at its time, even when the computer is asleep. Tap the push to open the platform's compose page; **Copy & open** opens the post in Obsidian on the phone with the text ready to paste; **Snooze 10 min** brings it back later. Reminders are booked up to 72 hours ahead, so open Obsidian on the publisher device at least every couple of days.

Anyone who knows the topic can read these pushes on a public server. Keep the random topic private, or run your own ntfy server and add an access token.
```

- [ ] **Step 3: Write the QA checklist**

`docs/qa/m3.md`:
```markdown
# M3 manual QA — phone reminders, publisher device, publish log

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+ on a desktop, and sync the same vault to an iPhone and an Android phone (Obsidian Sync or iCloud). Install the ntfy app on both phones. Run in the dark and light themes.

## Publisher device (#26)
- [ ] Fresh vault: a start-up notice and the sidebar banner say no device publishes; a post due in 2 minutes is neither posted nor marked overdue.
- [ ] Desktop: rename the device, click "Make this device the publisher". The phone shows "Publishing happens on <name>" after sync.
- [ ] Phone: "Publish from this device instead" asks for confirmation; after sync the desktop's settings say "Publishing happens on <phone>" and it stops dispatching.
- [ ] Put a delivery in `status: publishing` on the non-publisher, then claim the role there: it becomes "Check needed" and is not retried.

## Phone reminders (#67–#71)
- [ ] Turn phone reminders on: a random `osmm-…` topic appears; subscribe on both phones; "Send test" arrives on both.
- [ ] Check that `data.json`, the vault and `localStorage` (devtools → Application) contain neither the topic nor the token.
- [ ] Schedule an assisted LinkedIn post 70 minutes ahead: within a minute two pushes are booked; with the laptop closed, "In 1 h · LinkedIn" and "In 10 min · LinkedIn" arrive on time.
- [ ] Tap the push: the pre-filled page (or the app) opens. "Copy & open" opens Obsidian on the phone with the assisted flow; "Open note" opens the note; "Snooze 10 min" brings the push back 10 minutes later.
- [ ] Reschedule a booked post by one hour: the old pushes do not arrive (ntfy.sh supports cancelling); the new ones do. Record whether your ntfy server cancelled (Settings → Community plugins → developer console shows no errors).
- [ ] Mark a booked post as published early: its pending pushes do not arrive.
- [ ] Quit Obsidian for two days with posts planned 3–4 days out; reopen: the newly-in-window reminders are booked, nothing is booked twice.
- [ ] Set a wrong token on a protected topic: one notice explains the refusal, no repeated notices, and the notice shows neither the topic nor the token.
- [ ] With an access token, the third button is "Done" (opens step 3 of the assisted flow).
- [ ] Capture real ntfy.sh responses (publish, delayed publish, delete, 403, 429) with `curl -i` and update `test/reminders/ntfy/fixtures.ts` if they differ.

## Mobile (#27)
- [ ] The plugin loads on iOS and Android with no errors (developer console on Android via chrome://inspect).
- [ ] Planner on a phone: month and week show the agenda; the board scrolls one column at a time; long press opens the context menu.
- [ ] Composer on a phone: preview above the checks, Post as and schedule; reachable buttons.
- [ ] Assisted flow on a phone: "Copy & open" copies the text and opens the platform app or page; Instagram hands the image to the share sheet; pasting the live link marks the post published.

## Publish log (#65)
- [ ] Every assisted open, published, skipped and overdue appears in `Social/_log.md` with a working link to the note.
- [ ] Add a line of your own to the log: later appends keep it.
- [ ] Change the system date to the 1st of next month and post: the previous month moves to `Social/_log/YYYY-MM.md`.
```

- [ ] **Step 4: Run the full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/getting-started.md docs/qa/m3.md
git commit -m "docs: publisher device, phone reminders and the publish log; M3 QA checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Walk through the checklist**

Work through `docs/qa/m3.md` on a desktop and two phones. For each failure, add a failing test in the owning module first, fix it and commit with `fix(...)`. The GUI walkthrough may be deferred to the user, as in M2b (see the Task 13 ruling in the M2b progress ledger).

---

## M3 Done Checklist

- [ ] All 10 tasks committed on `feat/m2-one-click-posting`; `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] `docs/qa/m3.md` checked on a desktop, an iPhone and an Android phone (or deferred to the user with a ruling).
- [ ] Issues #26, #27, #65, #68, #69, #70 and #71 can be closed; epic #67 is complete.
- [ ] Follow-ups for M4+: MCP `get_log` reads `Social/_log.md`; M5 adapters get confirmations for free through `onPublished`; token-health reminders (spec §5.4) can reuse `PhoneAlerts`.
