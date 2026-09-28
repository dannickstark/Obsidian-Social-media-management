# M2a — Platforms, Previews and Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every platform knows its limits, validates a post and renders a stylized preview; an all-platform preview grid shows a whole campaign; and a Composer next to Obsidian's editor lets the user pick channels, see live checks, attach media and schedule a variant.

**Architecture:** A `platforms/` module with one folder per platform (capabilities, limits, extra checks), a shared rule engine (`checks.ts`) and a text renderer (`text.ts`) that turns the note's Markdown into what each platform receives. `media/` reads image sizes from the vault and computes crops. `previews/` turns a post into a pure `PreviewModel` that small Svelte components draw. `composer/` holds pure planners (channels, schedule) plus `ComposerActions`, which writes through `PlannerActions.write()` (SafeWriter `updateVariant`, fresh frontmatter, Undo). The Composer and the Preview grid are `ItemView`s with view state.

**Tech Stack:** TypeScript 5.9 (strict), Svelte 5 (runes), Obsidian API 1.13 (`ItemView` view state, `editor-change`, `readBinary`/`createBinary`, `getAvailablePathForAttachment`), zod 4, Vitest 5 (jsdom) + @testing-library/svelte 5.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§3 views 3 and 5, §4 architecture, §4.1 adapter interface, §4.2 platform matrix, §5 lifecycle). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z (artboards 3 Composer and 5 All-platform preview).

**Depends on:** M1 (M1a + M1b) merged into `dev`. Branch `feat/m2-one-click-posting` from `dev`. M2b (`docs/superpowers/plans/2026-09-29-m2b-assisted-publishing-and-scheduler.md`) builds on this plan.

**Issues covered:** #39 epic — #40 (Task 1), #41 (Task 3), #42 (Task 4), #43 (Task 6), #44 (Task 7), #45 (Tasks 5 and 14), #46 (Task 8) · #47 epic — #48 (Task 9), #49 (Task 10), #50 (Task 11), #51 (Task 12), #52 (Task 13; Post now and Copy & open are in M2b Tasks 5 and 10), #53 (Task 14). Task 2 (text rendering) serves #41–#44.

**Verified:** the code of Tasks 1–14 was applied in order to a scratch copy of `dev` while writing this plan: `npm test` (577 tests), `npm run typecheck`, `npm run lint` and the production build all pass. Line-level edits ("in X, replace … with …") refer to the file as the previous tasks leave it.

## Global Constraints

- All M1 constraints still apply: every frontmatter write goes through `SafeWriter`; dates via `formatDateTime`/`parseDateTime`; secrets only in `app.secretStorage`; tests run with `TZ=Europe/Berlin`; colours from Obsidian CSS variables (platform badge colours from `PLATFORM_COLORS`); only real controls (`<button>`, `<input>`, `<select>`) are interactive and icon-only buttons have an `aria-label`; icons via `setIcon` (the `use:icon` action); **no emoji** in UI text or code; every UI write shows a `Notice`, and edits offer **Undo** where safe.
- Writes to `deliveries` go **per key** through `SafeWriter` (`updateVariant` via `PlannerActions.write()`, `updateDeliveries`, `transitionDelivery`), whose `applyDeliveryPatch` keeps other raw entries verbatim. Plans are computed against the **fresh** frontmatter inside `updateVariant`; nothing ever writes a whole `deliveries` map.
- Delivery status changes use `transition()` from `src/model/stateMachine.ts` (spec §5). `scheduled → published` is illegal.
- Platform previews are **stylized approximations**, not pixel copies: they use the channel's name and avatar colour, the M1 platform badge and Obsidian CSS variables. No platform logos.
- Validator issues: `level: "error"` is **blocking** (disables Schedule, and Post now in M2b); `level: "warning"` is **advisory**.
- Limits named in the issues are exact: X 280 weighted (URL = 23), media ≤ 4; Bluesky 300 graphemes, images ≤ 4; Mastodon 500 by default, configurable per channel, media ≤ 4; LinkedIn 3 000 with a fold at about 210; Instagram image required, caption 2 200, hashtags ≤ 30, ratio 4:5 to 1.91:1; Telegram 4 096 / caption 1 024; Discord 2 000; HN title ≤ 80 plus url; Reddit title ≤ 300; WordPress title and slug required. Every other number (file sizes, fold on Instagram and Facebook, media counts) is marked *approximate* in code and is checked in the QA pass (Task 15).
- There are **no API adapters in M2** (they arrive in M5/M6). The plugin's `AdapterRegistry` is empty, so every channel resolves to the assisted method; tests register fake adapters.
- Features of later milestones are not rendered, not even disabled: Post now and Copy & open (M2b), Trim with Claude (M4), Out of sync (M5).
- New Obsidian API surface used by the plugin is added to `test/fakes/obsidian.ts` in the task that first needs it; `src/` never imports the fake.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Text near a platform limit that contains URLs, emoji, CJK characters or hashtags.** It should be counted the way the platform counts (URL = 23 and emoji = 2 on X, graphemes on Bluesky, URL = 23 on Mastodon), so a post that fits is not blocked and one that does not fit is. Tests in Task 3.
2. **`media:` entries that do not resolve, point at a video, or point at a non-image file.** Checks should flag each with a clear message, and inspection and previews should keep working instead of throwing. Tests in Tasks 4 and 5.
3. **Hand-edited `media_meta` with the wrong shape** (a string instead of a map, `focus: "0.5, 2"`, an empty alt). Bad parts should be ignored with a warning while the valid alt text is still read. Test in Task 5.
4. **Deselecting, in the Post-as picker, a channel that was already published or handed over.** The change should be refused with an explanation, and the delivery record must stay untouched. Test in Task 10.
5. **Scheduling from the Composer a post where one channel is already published (a partial post).** The published channel should keep its status and its time, and only the pending channels should move. Test in Task 12.

---

## File Structure

```
src/platforms/types.ts           Limits, MediaRules, Capabilities, MediaInfo, ComposeInput, PlatformDef, DeliveryJob, PlatformAdapter, MB
src/platforms/errors.ts          PublishError + Transient/NeedsUser/InvalidContent, classifyError()
src/platforms/<platform>/index.ts  one folder per platform (13): `export const def: PlatformDef`
src/platforms/registry.ts        PLATFORM_DEFS, platformDef(), AdapterRegistry, effectiveMethod()
src/platforms/text.ts            renderText(), postItems(), postText(), countFor(), hashtags(), urlsIn()
src/platforms/checks.ts          rule engine: textChecks … mediaChecks, validateFor(), validateAll(), blocking(), counters()
src/media/imageSize.ts           PNG/JPEG/GIF/WebP header parser
src/media/mediaInfo.ts           MediaInspector (resolve, kind, bytes, size, alt, focus)
src/media/crop.ts                cropRect(), clampRatio(), feedRatio(), focusFromPoint()
src/previews/model.ts            Segment, segments(), PreviewModel, previewModel(), objectPosition(), articleBlocks()
src/previews/Preview.svelte      layout dispatch
src/previews/FeedPreview.svelte, ChatPreview.svelte, LinkPreview.svelte, ArticlePreview.svelte
src/previews/PvHeader.svelte, PvText.svelte, PvMedia.svelte, PvLinkCard.svelte
src/previews/PreviewGrid.svelte  all-platform preview grid
src/previews/PreviewGridView.ts  VIEW_PREVIEW_GRID item view
src/composer/content.ts          ContentLoader (body + media + featured image)
src/composer/actions.ts          ComposerActions (context service for grid and composer)
src/composer/session.ts          composerSession(): live body from the editor (debounced)
src/composer/channels.ts         planToggleChannel(), planSelectGroup()
src/composer/schedule.ts         planComposerSchedule(), scheduleNeeds(), bestSlot(), reminderDefaults()
src/composer/fixes.ts            slugify()
src/composer/ComposerView.ts     VIEW_COMPOSER item view
src/composer/Composer.svelte, PostAs.svelte, Checks.svelte, SchedulePanel.svelte, ActionsBar.svelte, MediaPanel.svelte
src/styles/previews.css, src/styles/composer.css
docs/qa/m2a.md                   manual QA checklist
```

Modified: `src/model/types.ts` (Issue.code, MediaMeta, Variant.mediaMeta), `src/model/body.ts` (Mastodon counter), `src/model/schemas.ts` (Channel.maxChars), `src/model/frontmatter.ts` (media_meta), `src/settings/ChannelForm.svelte`, `src/ui/actions.ts` (public `write`/`afterWrite`, `actionNotice`, new view ids), `src/ui/context.ts` (`composer`), `src/main.ts`, `src/commands.ts`, `src/views/CampaignTable.svelte`, `src/styles/index.css`, `test/fakes/obsidian.ts`, `test/ui/ctx.ts`, `test/commands.test.ts`.

---

### Task 1: Platform registry and adapter interface (#40)

**Files:**
- Create: `src/platforms/types.ts`, `src/platforms/errors.ts`, `src/platforms/registry.ts`, and `src/platforms/{linkedin,x,instagram,facebook,mastodon,bluesky,telegram,discord,hackernews,indiehackers,reddit,whatsapp,wordpress}/index.ts`
- Test: `test/platforms/registry.test.ts`, `test/platforms/errors.test.ts`

**Interfaces:**
- Consumes: `Platform`, `PLATFORMS`, `PLATFORM_META` (`src/model/platforms.ts`); `Channel`, `Delivery`, `Issue`, `PostMode`, `Variant` (`src/model/types.ts`); `CharCounter` (`src/model/body.ts`).
- Produces:
  - Types `TextDialect = "plain" | "markdown" | "telegram" | "whatsapp" | "html"`, `PreviewLayout = "feed" | "thread" | "chat" | "link" | "article"`, `Limits`, `MediaRules`, `Capabilities`, `MediaInfo`, `ComposeInput { variant: Variant; body: string; media: MediaInfo[] }`, `PlatformDef { id; capabilities; dialect; preview; validate?(input, channel?) }`, `DeliveryJob`, `RemoteState`, `PlatformAdapter { platform; publish?; schedule?; update?; cancel?; lookup? }`, const `MB`.
  - `PublishError(kind, message, retryAfterMs?)`, `TransientError`, `NeedsUserError`, `InvalidContentError`, `type ErrorKind = "transient" | "needs_user" | "invalid_content"`, `classifyError(e: unknown): PublishError`.
  - `PLATFORM_DEFS: Readonly<Record<Platform, PlatformDef>>`, `platformDef(p): PlatformDef`, `class AdapterRegistry { register(a); get(p) }`, `type EffectiveMethod = "api" | "native" | "assisted"`, `effectiveMethod(mode, channel?, adapter?): EffectiveMethod`.

- [ ] **Step 1: Write the failing tests**

`test/platforms/registry.test.ts`:
```ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META } from "../../src/model/platforms";
import type { Channel } from "../../src/model/types";
import { AdapterRegistry, PLATFORM_DEFS, effectiveMethod, platformDef } from "../../src/platforms/registry";
import type { PlatformAdapter, PlatformDef } from "../../src/platforms/types";

const folders = import.meta.glob<{ def: PlatformDef }>("../../src/platforms/*/index.ts", { eager: true });

const channel = (method: Channel["method"]): Channel => ({
  id: "li/me",
  platform: "linkedin",
  name: "Me",
  kind: "profile",
  avatarColor: "#c9c3b8",
  method,
});

describe("platform registry", () => {
  it("has one folder per platform, and the registry lists every folder", () => {
    const ids = Object.values(folders).map((m) => m.def.id).sort();
    expect(ids).toEqual([...PLATFORMS].sort());
    for (const m of Object.values(folders)) expect(PLATFORM_DEFS[m.def.id]).toBe(m.def);
  });

  it.each(PLATFORMS)("%s capabilities agree with the platform metadata", (p) => {
    const def = platformDef(p);
    expect(def.id).toBe(p);
    expect(def.capabilities.threads).toBe(PLATFORM_META[p].threads);
    expect(def.capabilities.limits.maxChars).toBeGreaterThan(0);
    expect(def.capabilities.media.video).toBe(false);
  });

  it("follows the spec §4.2 platform matrix", () => {
    expect(PLATFORMS.filter((p) => platformDef(p).capabilities.nativeSchedule)).toEqual(["facebook", "mastodon", "wordpress"]);
    expect(PLATFORMS.filter((p) => !platformDef(p).capabilities.api)).toEqual(["hackernews", "indiehackers", "reddit", "whatsapp"]);
  });
});

describe("effectiveMethod", () => {
  const publisher: PlatformAdapter = { platform: "linkedin", publish: async () => ({ remoteId: "1", url: "https://x" }) };
  const scheduler: PlatformAdapter = { ...publisher, schedule: async () => ({ remoteId: "1" }) };

  it("is assisted without an adapter, whatever the channel says (M2 has no adapters)", () => {
    expect(effectiveMethod("auto", channel("api"), undefined)).toBe("assisted");
    expect(effectiveMethod("auto", channel("native"), undefined)).toBe("assisted");
  });

  it("uses the adapter when the channel and the post allow it", () => {
    expect(effectiveMethod("auto", channel("api"), publisher)).toBe("api");
    expect(effectiveMethod("auto", channel("native"), scheduler)).toBe("native");
    expect(effectiveMethod("auto", channel("native"), publisher)).toBe("api");
  });

  it("is assisted when the post or the channel is assisted, or the channel is unknown", () => {
    expect(effectiveMethod("assisted", channel("api"), publisher)).toBe("assisted");
    expect(effectiveMethod("auto", channel("assisted"), publisher)).toBe("assisted");
    expect(effectiveMethod("auto", undefined, publisher)).toBe("assisted");
  });

  it("registers adapters per platform", () => {
    const registry = new AdapterRegistry();
    expect(registry.get("linkedin")).toBeUndefined();
    registry.register(publisher);
    expect(registry.get("linkedin")).toBe(publisher);
  });
});
```

`test/platforms/errors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, classifyError } from "../../src/platforms/errors";

const http = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed, status ${status}`), { status, headers });

describe("classifyError", () => {
  it.each([
    [http(401), "needs_user"],
    [http(403), "needs_user"],
    [http(404), "needs_user"],
    [http(408), "transient"],
    [http(429), "transient"],
    [http(500), "transient"],
    [http(503), "transient"],
    [http(400), "invalid_content"],
    [http(413), "invalid_content"],
    [http(422), "invalid_content"],
    [new Error("net::ERR_TIMED_OUT"), "transient"],
    ["boom", "transient"],
  ])("%s → %s", (error, kind) => {
    expect(classifyError(error).kind).toBe(kind);
  });

  it("keeps errors that are already classified", () => {
    const e = new NeedsUserError("Token expired");
    expect(classifyError(e)).toBe(e);
    expect(new TransientError("slow")).toBeInstanceOf(PublishError);
    expect(new InvalidContentError("too long").kind).toBe("invalid_content");
  });

  it("reads Retry-After in seconds, in any header case", () => {
    expect(classifyError(http(429, { "Retry-After": "30" })).retryAfterMs).toBe(30_000);
    expect(classifyError(http(429, { "retry-after": "soon" })).retryAfterMs).toBeUndefined();
  });

  it("keeps the original message", () => {
    expect(classifyError(http(401)).message).toBe("Request failed, status 401");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/platforms`
Expected: FAIL — `Cannot find module '../../src/platforms/registry'` (and `errors`).

- [ ] **Step 3: Write the types and errors**

`src/platforms/types.ts`:
```ts
import type { CharCounter } from "../model/body";
import type { Platform } from "../model/platforms";
import type { Channel, Delivery, Issue, Variant } from "../model/types";

export const MB = 1024 * 1024;

/** How the note's Markdown becomes the text the platform receives (see text.ts). */
export type TextDialect = "plain" | "markdown" | "telegram" | "whatsapp" | "html";

/** Which preview renderer draws the platform. */
export type PreviewLayout = "feed" | "thread" | "chat" | "link" | "article";

export interface Limits {
  /** Maximum characters per post; on thread platforms, per thread item. */
  maxChars: number;
  counter: CharCounter;
  /** A stricter limit for the text when media is attached (a Telegram caption). */
  maxCharsWithMedia?: number;
  /** Characters visible before the platform folds the text ("…see more"). */
  foldAt?: number;
  titleRequired?: boolean;
  titleMax?: number;
  /** `required`: needs `url`; `url-or-text`: needs `url` or a body; `none`: `url` is not used. */
  link: "optional" | "required" | "url-or-text" | "none";
  maxHashtags?: number;
}

export interface MediaRules {
  /** 0 means the platform shows no attached media. */
  maxCount: number;
  required: boolean;
  maxBytes: number;
  /** Accepted aspect ratios, width / height. */
  ratio?: { min: number; max: number };
  /** Ratio the feed crops a single image to, for the crop preview. */
  cropRatio?: number;
  /** Video upload is not supported anywhere in v1. */
  video: false;
}

export interface Capabilities {
  api: boolean;
  nativeSchedule: boolean;
  threads: boolean;
  media: MediaRules;
  limits: Limits;
}

export interface MediaInfo {
  /** Link target as written in `media:` (e.g. "event-x-cover.png"). */
  target: string;
  /** Vault path when the link resolves. */
  path?: string;
  kind: "image" | "video" | "unsupported" | "missing";
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  alt?: string;
  /** Focal point, 0..1 from the left and from the top. */
  focus?: [number, number];
}

/** What validators and previews look at: the note's fields, its Markdown body and its resolved media. */
export interface ComposeInput {
  variant: Variant;
  body: string;
  media: MediaInfo[];
}

/** The static half of spec §4.1: capabilities, limits and checks. Network operations live in PlatformAdapter. */
export interface PlatformDef {
  id: Platform;
  capabilities: Capabilities;
  dialect: TextDialect;
  preview: PreviewLayout;
  /** Platform-specific checks, run after the shared rule checks. */
  validate?(input: ComposeInput, channel?: Channel): Issue[];
}

/** Everything an adapter needs to run one delivery. */
export interface DeliveryJob {
  variant: Variant;
  channel: Channel;
  delivery: Delivery;
  /** The whole post as the platform receives it. */
  text: string;
  /** Thread items (a single item on platforms without threads). */
  items: string[];
  media: MediaInfo[];
  /** The channel's credential on this device, if any. */
  secret: string | null;
}

export interface RemoteState {
  published: boolean;
  url?: string;
  remoteId?: string;
}

/** Network operations of one platform (spec §4.1). Real adapters arrive in M5/M6; M2 only has test fakes. */
export interface PlatformAdapter {
  readonly platform: Platform;
  publish?(job: DeliveryJob): Promise<{ remoteId: string; url: string }>;
  schedule?(job: DeliveryJob): Promise<{ remoteId: string }>;
  update?(job: DeliveryJob): Promise<void>;
  cancel?(job: DeliveryJob): Promise<void>;
  lookup?(job: DeliveryJob): Promise<RemoteState | null>;
}
```

`src/platforms/errors.ts`:
```ts
export type ErrorKind = "transient" | "needs_user" | "invalid_content";

/** Spec §4.1: every adapter error is normalised into one of three classes. */
export class PublishError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export class TransientError extends PublishError {
  constructor(message: string, retryAfterMs?: number) {
    super("transient", message, retryAfterMs);
    this.name = "TransientError";
  }
}

export class NeedsUserError extends PublishError {
  constructor(message: string) {
    super("needs_user", message);
    this.name = "NeedsUserError";
  }
}

export class InvalidContentError extends PublishError {
  constructor(message: string) {
    super("invalid_content", message);
    this.name = "InvalidContentError";
  }
}

function statusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null || !("status" in e)) return undefined;
  const status = (e as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function retryAfterMs(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null || !("headers" in e)) return undefined;
  const headers = (e as { headers: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const entry = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === "retry-after");
  const seconds = Number(entry?.[1]);
  return entry && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Normalise anything an adapter throws. HTTP errors come from `requestUrl`, which attaches
 * `status` and `headers`; errors without a status are network failures or timeouts.
 */
export function classifyError(e: unknown): PublishError {
  if (e instanceof PublishError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  if (status === undefined) return new TransientError(message);
  if (status === 401 || status === 403) return new NeedsUserError(message);
  if (status === 408 || status === 429 || status >= 500) return new TransientError(message, retryAfterMs(e));
  if (status === 400 || status === 413 || status === 422) return new InvalidContentError(message);
  return new NeedsUserError(message);
}
```

- [ ] **Step 4: Write the 13 platform folders**

Each folder holds only data now; Tasks 3 and 4 add `validate` where a platform needs its own checks. Numbers marked *approximate* are verified in Task 15.

`src/platforms/linkedin/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "linkedin",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 3000, counter: "graphemes", foldAt: 210, link: "optional" },
    // approximate: image count and size
    media: { maxCount: 9, required: false, maxBytes: 8 * MB, video: false },
  },
};
```

`src/platforms/x/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "x",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: true,
    limits: { maxChars: 280, counter: "x-weighted", link: "optional" },
    // approximate: file size and feed crop
    media: { maxCount: 4, required: false, maxBytes: 5 * MB, cropRatio: 16 / 9, video: false },
  },
};
```

`src/platforms/instagram/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "instagram",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    // approximate: fold
    limits: { maxChars: 2200, counter: "graphemes", foldAt: 125, maxHashtags: 30, link: "none" },
    // approximate: carousel size and file size
    media: { maxCount: 10, required: true, maxBytes: 8 * MB, ratio: { min: 0.8, max: 1.91 }, video: false },
  },
};
```

`src/platforms/facebook/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "facebook",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: fold
    limits: { maxChars: 63206, counter: "graphemes", foldAt: 480, link: "optional" },
    // approximate: image count and size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
```

`src/platforms/mastodon/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "mastodon",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: true,
    // 500 is the default instance limit; a channel can override it (Channel.maxChars, Task 3).
    limits: { maxChars: 500, counter: "graphemes", link: "optional" },
    // approximate: file size (instance dependent) and feed crop
    media: { maxCount: 4, required: false, maxBytes: 8 * MB, cropRatio: 16 / 9, video: false },
  },
};
```

`src/platforms/bluesky/index.ts`:
```ts
import { type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "bluesky",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: true,
    limits: { maxChars: 300, counter: "graphemes", link: "optional" },
    // approximate: Bluesky's blob limit is about 1 MB per image
    media: { maxCount: 4, required: false, maxBytes: 1_000_000, video: false },
  },
};
```

`src/platforms/telegram/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "telegram",
  dialect: "telegram",
  preview: "chat",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 4096, maxCharsWithMedia: 1024, counter: "graphemes", link: "optional" },
    // approximate: album size and photo size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
```

`src/platforms/discord/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "discord",
  dialect: "markdown",
  preview: "chat",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 2000, counter: "graphemes", link: "optional" },
    // approximate: attachments per message and webhook upload size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
```

`src/platforms/whatsapp/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "whatsapp",
  dialect: "whatsapp",
  preview: "chat",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: message length and media
    limits: { maxChars: 65536, counter: "graphemes", link: "optional" },
    media: { maxCount: 30, required: false, maxBytes: 16 * MB, video: false },
  },
};
```

`src/platforms/hackernews/index.ts`:
```ts
import { type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "hackernews",
  dialect: "plain",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: text length
    limits: { maxChars: 4000, counter: "graphemes", titleRequired: true, titleMax: 80, link: "url-or-text" },
    media: { maxCount: 0, required: false, maxBytes: 0, video: false },
  },
};
```

`src/platforms/indiehackers/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "indiehackers",
  dialect: "markdown",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: text and title length, image size
    limits: { maxChars: 40000, counter: "graphemes", titleRequired: true, titleMax: 150, link: "optional" },
    media: { maxCount: 10, required: false, maxBytes: 5 * MB, video: false },
  },
};
```

`src/platforms/reddit/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "reddit",
  dialect: "markdown",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: self-text length, gallery size and image size
    limits: { maxChars: 40000, counter: "graphemes", titleRequired: true, titleMax: 300, link: "url-or-text" },
    media: { maxCount: 20, required: false, maxBytes: 20 * MB, video: false },
  },
};
```

`src/platforms/wordpress/index.ts`:
```ts
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "wordpress",
  dialect: "html",
  preview: "article",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: article length and upload size (site dependent)
    limits: { maxChars: 1_000_000, counter: "graphemes", titleRequired: true, link: "none" },
    media: { maxCount: 50, required: false, maxBytes: 20 * MB, video: false },
  },
};
```

- [ ] **Step 5: Write the registry**

`src/platforms/registry.ts`:
```ts
import type { Platform } from "../model/platforms";
import type { Channel, PostMode } from "../model/types";
import { def as bluesky } from "./bluesky";
import { def as discord } from "./discord";
import { def as facebook } from "./facebook";
import { def as hackernews } from "./hackernews";
import { def as indiehackers } from "./indiehackers";
import { def as instagram } from "./instagram";
import { def as linkedin } from "./linkedin";
import { def as mastodon } from "./mastodon";
import { def as reddit } from "./reddit";
import { def as telegram } from "./telegram";
import { def as whatsapp } from "./whatsapp";
import { def as wordpress } from "./wordpress";
import { def as x } from "./x";
import type { PlatformAdapter, PlatformDef } from "./types";

/** Adding a platform = adding a folder with `index.ts` and one line here; the registry test enumerates the folders. */
export const PLATFORM_DEFS: Readonly<Record<Platform, PlatformDef>> = {
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

export function platformDef(platform: Platform): PlatformDef {
  return PLATFORM_DEFS[platform];
}

/** The API adapters available on this device. Empty in M2; M5/M6 register real ones. */
export class AdapterRegistry {
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: Platform): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }
}

export type EffectiveMethod = "api" | "native" | "assisted";

/**
 * How a delivery will actually run. The channel's configured method is a wish; without an adapter
 * that can do it, every channel falls back to the assisted flow (spec §10: assisted fallback everywhere).
 */
export function effectiveMethod(mode: PostMode, channel: Channel | undefined, adapter: PlatformAdapter | undefined): EffectiveMethod {
  if (mode === "assisted" || !channel || channel.method === "assisted") return "assisted";
  if (channel.method === "native" && adapter?.schedule) return "native";
  if (adapter?.publish) return "api";
  return "assisted";
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/platforms && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platforms test/platforms
git commit -m "feat(platforms): add platform registry, capabilities and adapter interface (refs #40)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Post text rendering per platform dialect (serves #41–#44)

**Files:**
- Create: `src/platforms/text.ts`
- Test: `test/platforms/text.test.ts`

**Interfaces:**
- Consumes: `splitThread`, `countChars` (`src/model/body.ts`); `PlatformDef`, `TextDialect` (Task 1).
- Produces: `renderText(markdown: string, dialect: TextDialect): string`, `postItems(body: string, def: PlatformDef): string[]`, `postText(body: string, def: PlatformDef): string`, `countFor(text: string, def: PlatformDef): number`, `hashtags(text: string): string[]`, `urlsIn(text: string): string[]`. Validators, previews and (in M2b) the clipboard text all use these, so what is counted, previewed and copied is the same string.

Dialect rules (from the note's Markdown):

| Dialect | Platforms | Embeds, comments, wikilinks | `[label](url)` | `**bold**`, `~~strike~~` | Headings |
|---|---|---|---|---|---|
| plain | LinkedIn, X, Instagram, Facebook, Mastodon, Bluesky, HN | removed / removed / label | `label (url)`, or just `url` when the label is the url | markers removed | `#` removed |
| whatsapp | WhatsApp | same | same as plain | `*bold*`, `~strike~`, Markdown `*italic*` → `_italic_` | `#` removed |
| telegram | Telegram | same | kept (Markdown) | kept | turned into `**bold**` |
| markdown | Discord, Reddit, Indie Hackers | same | kept | kept | kept |
| html | WordPress | same | kept | kept | kept (the article renderer handles them) |

- [ ] **Step 1: Write the failing test**

`test/platforms/text.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { platformDef } from "../../src/platforms/registry";
import { countFor, hashtags, postItems, postText, renderText, urlsIn } from "../../src/platforms/text";

describe("renderText", () => {
  it.each([
    [
      "plain",
      "**Big** news: see [[Event X|the event]] and [the site](https://example.com).\n\n![[cover.png]]\n%%note to self%%",
      "Big news: see the event and the site (https://example.com).",
    ],
    ["plain", "# Launch day\nRSVP → [example.com/event-x](https://example.com/event-x)", "Launch day\nRSVP → https://example.com/event-x"],
    ["plain", "Keep *single stars* and ~~drop~~ strike", "Keep *single stars* and drop strike"],
    ["whatsapp", "**Event X** · _18:00_ ~~free~~ *soon*", "*Event X* · _18:00_ ~free~ _soon_"],
    ["whatsapp", "# Title\n[RSVP](https://e.x/r)", "Title\nRSVP (https://e.x/r)"],
    ["telegram", "## Details\n**18:00** at [the lab](https://lab.example)", "**Details**\n**18:00** at [the lab](https://lab.example)"],
    ["markdown", "[[Notes/Event X#Agenda]] and [[#Agenda]] **bold**", "Event X and Agenda **bold**"],
    ["html", "Intro\n\n---\n\n## Part two  \n![alt](cover.png)", "Intro\n\n---\n\n## Part two"],
  ] as const)("%s: %j", (dialect, input, expected) => {
    expect(renderText(input, dialect)).toBe(expected);
  });

  it("collapses the blank lines left by removed embeds", () => {
    expect(renderText("One\n\n![[a.png]]\n\n![[b.png]]\n\nTwo", "plain")).toBe("One\n\nTwo");
  });
});

describe("postItems", () => {
  it("splits threads only on thread platforms", () => {
    expect(postItems("One\n---\nTwo\n\n---\n", platformDef("x"))).toEqual(["One", "Two"]);
    expect(postItems("One\n---\nTwo", platformDef("linkedin"))).toEqual(["One\n---\nTwo"]);
    expect(postText("One\n---\nTwo", platformDef("bluesky"))).toBe("One\n\nTwo");
  });

  it("returns no items for an empty or embed-only body", () => {
    expect(postItems("", platformDef("x"))).toEqual([]);
    expect(postItems("![[a.png]]\n", platformDef("linkedin"))).toEqual([]);
  });
});

describe("counting helpers", () => {
  it("counts with the platform's counter", () => {
    expect(countFor("Read https://example.com/very/long/path now", platformDef("x"))).toBe(32);
    expect(countFor("Read https://example.com/very/long/path now", platformDef("bluesky"))).toBe(43);
  });

  it("finds hashtags and urls", () => {
    expect(hashtags("Ship it #buildinpublic #Obsidian_md and #2026 but not a#b")).toEqual(["buildinpublic", "Obsidian_md", "2026"]);
    expect(urlsIn("See https://example.com/x, and http://a.b/c?d=1.")).toEqual(["https://example.com/x", "http://a.b/c?d=1"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/platforms/text.test.ts`
Expected: FAIL — `Cannot find module '../../src/platforms/text'`.

- [ ] **Step 3: Implement the renderer**

`src/platforms/text.ts`:
```ts
import { countChars, splitThread } from "../model/body";
import type { PlatformDef, TextDialect } from "./types";

const COMMENT_RE = /%%[\s\S]*?%%/g;
const WIKI_EMBED_RE = /!\[\[[^\]]*\]\]/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const HEADING_RE = /^#{1,6}[ \t]+(.+)$/gm;
const BOLD_RE = /(\*\*|__)(?=\S)([^\n]*?\S)\1/g;
const STRIKE_RE = /~~(?=\S)([^\n]*?\S)~~/g;
const ITALIC_STAR_RE = /(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/gm;
/** Placeholder for WhatsApp bold while Markdown italics are converted. */
const MARK = "\u0000";

function wikiLabel(target: string, alias: string | undefined): string {
  if (alias?.trim()) return alias.trim();
  const [note = "", heading = ""] = target.split("#");
  const name = note.trim() ? (note.split("/").pop() ?? note) : heading;
  return name.trim();
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function plainLink(label: string, url: string): string {
  return bare(label) === bare(url) ? url : `${label} (${url})`;
}

/** The note's Markdown → the text a platform receives (see the dialect table in the M2a plan, Task 2). */
export function renderText(markdown: string, dialect: TextDialect): string {
  let t = markdown.replace(COMMENT_RE, "").replace(WIKI_EMBED_RE, "").replace(MD_IMAGE_RE, "");
  t = t.replace(WIKILINK_RE, (_m, target: string, alias: string | undefined) => wikiLabel(target, alias));
  if (dialect === "plain" || dialect === "whatsapp") {
    t = t.replace(MD_LINK_RE, (_m, label: string, url: string) => plainLink(label, url));
  }
  switch (dialect) {
    case "plain":
      t = t.replace(HEADING_RE, "$1").replace(BOLD_RE, "$2").replace(STRIKE_RE, "$1");
      break;
    case "whatsapp":
      t = t
        .replace(HEADING_RE, "$1")
        .replace(BOLD_RE, `${MARK}$2${MARK}`)
        .replace(ITALIC_STAR_RE, "$1_$2_")
        .replace(STRIKE_RE, "~$1~")
        .split(MARK)
        .join("*");
      break;
    case "telegram":
      t = t.replace(HEADING_RE, "**$1**");
      break;
    case "markdown":
    case "html":
      break;
  }
  return t
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Thread items on thread platforms (split on `---` lines); one item otherwise. Empty items are dropped. */
export function postItems(body: string, def: PlatformDef): string[] {
  if (!def.capabilities.threads) {
    const text = renderText(body, def.dialect);
    return text ? [text] : [];
  }
  return splitThread(body)
    .map((part) => renderText(part, def.dialect))
    .filter((part) => part.length > 0);
}

export function postText(body: string, def: PlatformDef): string {
  return postItems(body, def).join("\n\n");
}

export function countFor(text: string, def: PlatformDef): number {
  return countChars(text, def.capabilities.limits.counter);
}

const HASHTAG_RE = /(^|\s)#([\p{L}\p{N}_]+)/gu;

export function hashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_RE)].map((m) => m[2] ?? "");
}

const LINK_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(LINK_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/platforms/text.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/text.ts test/platforms/text.test.ts
git commit -m "feat(platforms): render post text per platform dialect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Validators for short-form and thread platforms — X, Bluesky, Mastodon (#41)

**Files:**
- Create: `src/platforms/checks.ts`, `test/platforms/fixtures.ts`, `test/platforms/shortForm.test.ts`
- Modify: `src/model/types.ts` (`Issue.code`), `src/model/body.ts` (Mastodon counter), `src/model/schemas.ts` (`Channel.maxChars`), `src/settings/ChannelForm.svelte` (Mastodon character limit), `src/platforms/mastodon/index.ts`, `src/platforms/bluesky/index.ts`, `test/settings/channelForm.test.ts`

**Interfaces:**
- Consumes: `postItems`, `countFor`, `urlsIn` (Task 2); `platformDef` (Task 1).
- Produces:
  - `Issue.code?: string` — a stable id for an issue (`"too-long"`, `"empty-body"`, …) that quick fixes key on (Task 11).
  - `CharCounter` gains `"mastodon"` (graphemes, every URL counts 23).
  - `Channel.maxChars?: number` (1–100 000) — per-channel character limit, used for Mastodon instances.
  - `fmt(n): string`, `limitFor(def, channel?): number`, `textChecks(input, def, channel?): Issue[]`, `mediaCountChecks(input, def): Issue[]`, `validateFor(input, def, channel?): Issue[]`, `validateAll(input, channels): Issue[]` (per channel, de-duplicated, errors first), `blocking(issues): boolean`, `interface Counter { label: string; value: number; limit: number }`, `counters(input, def, channel?): Counter[]`.
  - Test fixtures `input(platform, body, extra?, media?)`, `img(target?, width?, height?, extra?)`, `channel(id, extra?)`, `messages(issues)`.

- [ ] **Step 1: Write the fixtures and the failing tests**

`test/platforms/fixtures.ts`:
```ts
import { channelPlatform, type Platform } from "../../src/model/platforms";
import type { Channel, Issue, Variant } from "../../src/model/types";
import type { ComposeInput, MediaInfo } from "../../src/platforms/types";

export function input(platform: Platform, body: string, extra: Partial<Variant> = {}, media: MediaInfo[] = []): ComposeInput {
  return {
    variant: {
      path: "Social/Posts/P.md",
      platform,
      channels: [],
      mode: "auto",
      status: "draft",
      media: media.map((m) => m.target),
      deliveries: {},
      ...extra,
    },
    body,
    media,
  };
}

export function img(target = "a.png", width = 1080, height = 1080, extra: Partial<MediaInfo> = {}): MediaInfo {
  return { target, path: `Social/${target}`, kind: "image", mime: "image/png", bytes: 200_000, width, height, alt: "An image", ...extra };
}

export function channel(id: string, extra: Partial<Channel> = {}): Channel {
  return { id, platform: channelPlatform(id)!, name: id, kind: "profile", avatarColor: "#888888", method: "assisted", ...extra };
}

export const messages = (issues: readonly Issue[]): string[] => issues.map((i) => `${i.level}:${i.field}:${i.message}`);
```

`test/platforms/shortForm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { countChars } from "../../src/model/body";
import { blocking, counters, validateAll, validateFor } from "../../src/platforms/checks";
import { platformDef } from "../../src/platforms/registry";
import { channel, img, input, messages } from "./fixtures";

const X = platformDef("x");
const BS = platformDef("bluesky");
const MA = platformDef("mastodon");

describe("X (280 weighted, URL = 23, media ≤ 4)", () => {
  it.each([
    ["280 Latin characters", "a".repeat(280), []],
    ["281 Latin characters", "a".repeat(281), ["error:body:The text is 281/280 characters."]],
    ["140 CJK characters (weight 2)", "界".repeat(140), []],
    ["141 CJK characters", "界".repeat(141), ["error:body:The text is 282/280 characters."]],
    ["140 emoji (weight 2)", "🎉".repeat(140), []],
    ["a long URL counts 23", `${"a".repeat(256)} https://example.com/${"x".repeat(200)}`, []],
    ["an empty post", "", ["error:body:Write the post text first."]],
  ])("%s", (_name, body, expected) => {
    expect(messages(validateFor(input("x", body), X))).toEqual(expected);
  });

  it("validates each thread item", () => {
    expect(messages(validateFor(input("x", `short\n---\n${"b".repeat(281)}`), X))).toEqual(["error:body.2:Part 2 is 281/280 characters."]);
  });

  it("allows at most four images", () => {
    const media = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((t) => img(t));
    expect(messages(validateFor(input("x", "Hi", {}, media), X))).toEqual(["error:media:X allows at most 4 images; this post has 5."]);
    expect(validateFor(input("x", "Hi", {}, media.slice(0, 4)), X)).toEqual([]);
  });
});

describe("Bluesky (300 graphemes, images ≤ 4, link card)", () => {
  it.each([
    ["300 family emoji (one grapheme each)", "👨‍👩‍👧".repeat(300), []],
    ["301 characters", "a".repeat(301), ["error:body:The text is 301/300 characters."]],
  ])("%s", (_name, body, expected) => {
    expect(messages(validateFor(input("bluesky", body), BS))).toEqual(expected);
  });

  it("warns that a link card and images don't go together", () => {
    const warning = "warning:media:Bluesky shows either images or a link card, not both. The link card will be left out.";
    expect(messages(validateFor(input("bluesky", "Hi", { url: "https://example.com" }, [img()]), BS))).toEqual([warning]);
    expect(messages(validateFor(input("bluesky", "See https://example.com", {}, [img()]), BS))).toEqual([warning]);
    expect(validateFor(input("bluesky", "See https://example.com"), BS)).toEqual([]);
  });
});

describe("Mastodon (500 by default, per-channel limit, URL = 23)", () => {
  it("counts every URL as 23 characters", () => {
    const body = `${"a".repeat(470)} https://example.com/${"b".repeat(200)}`;
    expect(countChars(body, "mastodon")).toBe(494);
    expect(validateFor(input("mastodon", body), MA)).toEqual([]);
  });

  it("uses the instance limit of the channel", () => {
    expect(messages(validateFor(input("mastodon", "a".repeat(501)), MA))).toEqual(["error:body:The text is 501/500 characters."]);
    expect(validateFor(input("mastodon", "a".repeat(700)), MA, channel("ma/you", { maxChars: 1000 }))).toEqual([]);
  });

  it("allows at most four images", () => {
    const media = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((t) => img(t));
    expect(messages(validateFor(input("mastodon", "Hi", {}, media), MA))).toEqual(["error:media:Mastodon allows at most 4 images; this post has 5."]);
  });
});

describe("validateAll, blocking and counters", () => {
  it("runs per selected channel and reports each issue once", () => {
    const issues = validateAll(input("x", "a".repeat(281)), [channel("x/you"), channel("x/brand")]);
    expect(messages(issues)).toEqual(["error:body:The text is 281/280 characters."]);
    expect(blocking(issues)).toBe(true);
  });

  it("puts blocking issues first", () => {
    const issues = validateAll(input("bluesky", "a".repeat(301), { url: "https://example.com" }, [img()]), []);
    expect(issues.map((i) => i.level)).toEqual(["error", "warning"]);
  });

  it("reports the strictest limit when channels differ", () => {
    const issues = validateAll(input("mastodon", "a".repeat(700)), [channel("ma/big", { maxChars: 1000 }), channel("ma/you")]);
    expect(messages(issues)).toEqual(["error:body:The text is 700/500 characters."]);
  });

  it("counts per thread item", () => {
    expect(counters(input("x", "Hello\n---\nWorld!"), X)).toEqual([
      { label: "Part 1", value: 5, limit: 280 },
      { label: "Part 2", value: 6, limit: 280 },
    ]);
    expect(counters(input("mastodon", "Hi"), MA, channel("ma/you", { maxChars: 1000 }))).toEqual([{ label: "Length", value: 2, limit: 1000 }]);
  });
});
```

Add to `test/settings/channelForm.test.ts`, inside `describe("ChannelForm", …)`:
```ts
  it("saves a character limit for Mastodon channels only (#41)", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    expect(screen.queryByLabelText("Character limit")).toBeNull();
    await fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "mastodon" } });
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Fosstodon" } });
    await fireEvent.input(screen.getByLabelText("Character limit"), { target: { value: "1000" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("ma/fosstodon")?.maxChars).toBe(1000);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/platforms/shortForm.test.ts test/settings/channelForm.test.ts`
Expected: FAIL — `checks` module missing; no "Character limit" field.

- [ ] **Step 3: Extend the model**

In `src/model/types.ts`, replace the `Issue` interface with:
```ts
export interface Issue {
  level: "error" | "warning";
  field: string;
  message: string;
  /** Stable id of the check (e.g. "too-long"); quick fixes key on it. */
  code?: string;
}
```

In `src/model/body.ts`, replace the `CharCounter` type and `countChars` with:
```ts
export type CharCounter = "graphemes" | "x-weighted" | "mastodon";
```
```ts
export function countChars(text: string, counter: CharCounter = "graphemes"): number {
  if (counter === "graphemes") return [...segmenter.segment(text)].length;
  let total = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    total += 23;
    return "";
  });
  // Mastodon: graphemes, and every URL counts 23 no matter its length.
  if (counter === "mastodon") return total + [...segmenter.segment(withoutUrls)].length;
  for (const { segment } of segmenter.segment(withoutUrls)) total += xWeight(segment);
  return total;
}
```

In `src/model/schemas.ts`, add to the `zChannel` object (after `defaultReminders`):
```ts
    /** Per-channel character limit (a Mastodon instance's own limit). */
    maxChars: z.coerce.number().int().min(1).max(100_000).optional(),
```

In `src/settings/ChannelForm.svelte`:
- after `let secretId = $state(initial?.secretId ?? "");` add:
```ts
  let maxChars = $state<number | null | undefined>(initial?.maxChars);
```
- in the `input` object inside `save`, after `defaultReminders: initial?.defaultReminders,` add:
```ts
      maxChars: platform === "mastodon" && maxChars ? maxChars : undefined,
```
- after the `Handle / URL` label add:
```svelte
  {#if platform === "mastodon"}
    <label>Character limit<input type="number" min="1" max="100000" placeholder="500" bind:value={maxChars} /></label>
  {/if}
```

In `src/platforms/mastodon/index.ts`, change `counter: "graphemes"` to `counter: "mastodon"`.

- [ ] **Step 4: Write the rule engine**

`src/platforms/checks.ts`:
```ts
import { PLATFORM_META } from "../model/platforms";
import type { Channel, Issue } from "../model/types";
import { platformDef } from "./registry";
import { countFor, postItems } from "./text";
import type { ComposeInput, PlatformDef } from "./types";

export const fmt = (n: number): string => n.toLocaleString("en-US");
const label = (def: PlatformDef): string => PLATFORM_META[def.id].label;

export function limitFor(def: PlatformDef, channel?: Channel): number {
  return channel?.maxChars ?? def.capabilities.limits.maxChars;
}

/** Empty text and per-item length (thread items on thread platforms). */
export function textChecks(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  const { limits, media } = def.capabilities;
  const items = postItems(input.body, def);
  if (items.length === 0) {
    // Link submissions (HN, Reddit) can go without text; linkChecks (Task 4) covers them.
    if (limits.link === "required" || limits.link === "url-or-text") return [];
    return [{ level: media.required ? "warning" : "error", field: "body", code: "empty-body", message: "Write the post text first." }];
  }
  const limit = limitFor(def, channel);
  const many = items.length > 1;
  const issues: Issue[] = [];
  items.forEach((text, i) => {
    const n = countFor(text, def);
    if (n <= limit) return;
    issues.push({
      level: "error",
      field: many ? `body.${i + 1}` : "body",
      code: "too-long",
      message: many ? `Part ${i + 1} is ${fmt(n)}/${fmt(limit)} characters.` : `The text is ${fmt(n)}/${fmt(limit)} characters.`,
    });
  });
  return issues;
}

export function mediaCountChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const n = input.media.length;
  const { maxCount } = def.capabilities.media;
  if (n > 0 && maxCount === 0) {
    return [{ level: "warning", field: "media", code: "media-ignored", message: `${label(def)} doesn't show attached images; they won't be posted.` }];
  }
  if (n > maxCount) {
    return [{ level: "error", field: "media", code: "too-many-media", message: `${label(def)} allows at most ${maxCount} images; this post has ${n}.` }];
  }
  return [];
}

export function validateFor(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  return [...textChecks(input, def, channel), ...mediaCountChecks(input, def), ...(def.validate?.(input, channel) ?? [])];
}

/** Validate for every selected channel (limits can differ per channel); each issue is reported once, errors first. */
export function validateAll(input: ComposeInput, channels: readonly Channel[]): Issue[] {
  const def = platformDef(input.variant.platform);
  const runs = channels.length ? channels.map((c) => validateFor(input, def, c)) : [validateFor(input, def)];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of runs.flat()) {
    const key = `${issue.level}|${issue.field}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

export function blocking(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export interface Counter {
  label: string;
  value: number;
  limit: number;
}

export function counters(input: ComposeInput, def: PlatformDef, channel?: Channel): Counter[] {
  const items = postItems(input.body, def);
  const limit = limitFor(def, channel);
  if (items.length > 1) return items.map((t, i) => ({ label: `Part ${i + 1}`, value: countFor(t, def), limit }));
  return [{ label: "Length", value: countFor(items[0] ?? "", def), limit }];
}
```

`src/platforms/bluesky/index.ts` (replace the file):
```ts
import { urlsIn } from "../text";
import type { PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "bluesky",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: true,
    limits: { maxChars: 300, counter: "graphemes", link: "optional" },
    // approximate: Bluesky's blob limit is about 1 MB per image
    media: { maxCount: 4, required: false, maxBytes: 1_000_000, video: false },
  },
  validate(input) {
    const hasLink = !!input.variant.url || urlsIn(input.body).length > 0;
    if (!hasLink || input.media.length === 0) return [];
    return [
      {
        level: "warning",
        field: "media",
        code: "bluesky-card",
        message: "Bluesky shows either images or a link card, not both. The link card will be left out.",
      },
    ];
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/platforms test/settings test/model && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platforms src/model src/settings/ChannelForm.svelte test/platforms test/settings/channelForm.test.ts
git commit -m "feat(platforms): validate X, Bluesky and Mastodon posts (refs #41)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Validators for long-form and link platforms (#42)

**Files:**
- Modify: `src/platforms/checks.ts` (title, link, caption, hashtag and media checks; `validateFor` and `counters` replaced), `src/platforms/linkedin/index.ts`, `src/platforms/reddit/index.ts`, `src/platforms/wordpress/index.ts`
- Test: `test/platforms/longForm.test.ts`

**Interfaces:**
- Consumes: Task 3 engine and fixtures; `postText`, `hashtags`, `urlsIn` (Task 2); `countChars` (`src/model/body.ts`).
- Produces: `titleChecks(input, def)`, `linkChecks(input, def)`, `captionChecks(input, def)`, `hashtagChecks(input, def)`, `mediaChecks(input, def)` (includes `mediaCountChecks`). `validateFor` now runs, in order: title, text, caption, hashtags, link, media, platform `validate`. `counters` adds `Fold`, `Title` and `Hashtags` counters where the platform has those limits. Issue codes introduced here: `missing-title`, `title-too-long`, `missing-url`, `url-ignored`, `caption-too-long`, `too-many-hashtags`, `media-required`, `media-missing`, `video-unsupported`, `media-type`, `media-too-large`, `media-ratio`, `missing-alt`, `link-in-body`, `missing-subreddit`, `missing-slug`, `bad-slug`, `missing-featured`.

- [ ] **Step 1: Write the failing test**

`test/platforms/longForm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { blocking, counters, validateFor } from "../../src/platforms/checks";
import { platformDef } from "../../src/platforms/registry";
import type { WordPressFields } from "../../src/model/types";
import { MB } from "../../src/platforms/types";
import { channel, img, input, messages } from "./fixtures";

const check = (...args: Parameters<typeof input>) => messages(validateFor(input(...args), platformDef(args[0])));

describe("LinkedIn", () => {
  it.each([
    ["3 000 characters", "a".repeat(3000), []],
    ["3 001 characters", "a".repeat(3001), ["error:body:The text is 3,001/3,000 characters."]],
    [
      "a link in the text (advisory)",
      "Join us https://example.com/event",
      ["warning:body:Posts with a link in the text often reach fewer people on LinkedIn. Consider moving the link to the first comment."],
    ],
  ])("%s", (_name, body, expected) => {
    expect(check("linkedin", body)).toEqual(expected);
  });

  it("shows where the text folds", () => {
    expect(counters(input("linkedin", "a".repeat(250)), platformDef("linkedin"))).toEqual([
      { label: "Length", value: 250, limit: 3000 },
      { label: "Fold", value: 250, limit: 210 },
    ]);
  });
});

describe("Instagram", () => {
  it("needs an image", () => {
    expect(check("instagram", "Hi")).toEqual(["error:media:Instagram needs an image."]);
  });

  it("accepts 4:5 to 1.91:1 images", () => {
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 1350)])).toEqual([]);
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 566)])).toEqual([]);
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 1920)])).toEqual(["error:media.a.png:a.png is 0.56:1; Instagram accepts 0.80:1 to 1.91:1."]);
  });

  it("limits hashtags and the caption, and ignores url", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(check("instagram", tags, {}, [img()])).toEqual(["error:body:Instagram allows at most 30 hashtags; this post has 31."]);
    expect(check("instagram", "a".repeat(2201), {}, [img()])).toEqual(["error:body:The text is 2,201/2,200 characters."]);
    expect(check("instagram", "Hi", { url: "https://example.com" }, [img()])).toEqual([
      "warning:url:Instagram doesn't use the url field; put the link in the text if you need it.",
    ]);
  });

  it("counts hashtags", () => {
    expect(counters(input("instagram", "Hi #a #b", {}, [img()]), platformDef("instagram"))).toContainEqual({ label: "Hashtags", value: 2, limit: 30 });
  });
});

describe("chat platforms", () => {
  it("Telegram: 4 096 characters, 1 024 with media", () => {
    expect(check("telegram", "a".repeat(4096))).toEqual([]);
    expect(check("telegram", "a".repeat(1025), {}, [img()])).toEqual(["error:body:With media, Telegram allows 1,024 characters; the text is 1,025."]);
  });

  it("Discord: 2 000 characters", () => {
    expect(check("discord", "a".repeat(2001))).toEqual(["error:body:The text is 2,001/2,000 characters."]);
  });

  it("WhatsApp: a normal message passes", () => {
    expect(check("whatsapp", "*Event X* at 18:00")).toEqual([]);
  });
});

describe("link platforms", () => {
  it("Hacker News: title ≤ 80 and a url or text", () => {
    expect(check("hackernews", "")).toEqual(["error:title:Hacker News needs a title.", "error:url:Hacker News needs a link (url) or text."]);
    expect(check("hackernews", "", { title: "a".repeat(81), url: "https://example.com" })).toEqual(["error:title:The title is 81/80 characters."]);
    expect(check("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" })).toEqual([]);
    expect(check("hackernews", "Ask away", { title: "Ask HN: planning posts?" })).toEqual([]);
    expect(check("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" }, [img()])).toEqual([
      "warning:media:Hacker News doesn't show attached images; they won't be posted.",
    ]);
  });

  it("Reddit: title ≤ 300 and a subreddit on the channel", () => {
    const reddit = platformDef("reddit");
    const ok = input("reddit", "", { title: "Hello", url: "https://example.com" });
    expect(messages(validateFor(ok, reddit, channel("rd/side", { name: "Side projects", handle: "r/SideProject" })))).toEqual([]);
    expect(messages(validateFor(ok, reddit, channel("rd/side", { name: "Side projects" })))).toEqual([
      "error:channels:Set the subreddit (e.g. r/SideProject) as the handle of Side projects.",
    ]);
    expect(check("reddit", "", { title: "a".repeat(301), url: "https://example.com" })).toEqual(["error:title:The title is 301/300 characters."]);
  });

  it("Indie Hackers: needs a title", () => {
    expect(check("indiehackers", "Building in public.")).toEqual(["error:title:Indie Hackers needs a title."]);
  });
});

describe("WordPress", () => {
  const wp = (extra: Partial<WordPressFields>): WordPressFields => ({ categories: [], tags: [], ...extra });

  it("needs a title and a slug, and suggests a featured image", () => {
    expect(check("wordpress", "Article body")).toEqual([
      "error:title:WordPress needs a title.",
      "error:slug:WordPress needs a slug.",
      "warning:featured_image:No featured image set.",
    ]);
  });

  it("checks the slug format", () => {
    expect(check("wordpress", "Body", { title: "We're back", wordpress: wp({ slug: "Bad Slug", featuredImage: "c.png" }) })).toEqual([
      "error:slug:Use lowercase letters, digits and dashes in the slug.",
    ]);
    expect(check("wordpress", "Body", { title: "We're back", wordpress: wp({ slug: "we-re-back", featuredImage: "c.png" }) })).toEqual([]);
  });
});

describe("media problems (review focus 2)", () => {
  it("flags missing files, videos, other files, oversized images and missing alt text", () => {
    const media = [
      { target: "gone.png", kind: "missing" as const },
      { target: "clip.mp4", kind: "video" as const, path: "clip.mp4" },
      { target: "doc.pdf", kind: "unsupported" as const, path: "doc.pdf" },
      img("big.png", 1000, 1000, { bytes: 9 * MB, alt: "" }),
    ];
    expect(check("linkedin", "Hi", {}, media)).toEqual([
      "error:media.gone.png:gone.png was not found in the vault.",
      "error:media.clip.mp4:clip.mp4: video isn't supported yet. Remove it or use an image.",
      "error:media.doc.pdf:doc.pdf: use a PNG, JPG, WebP or GIF image.",
      "error:media.big.png:big.png is 9.0 MB; LinkedIn accepts up to 8.0 MB.",
      "warning:media.big.png:big.png has no alt text.",
    ]);
  });

  it("tells blocking from advisory issues", () => {
    expect(blocking(validateFor(input("linkedin", "Hi", {}, [img("a.png", 10, 10, { alt: "" })]), platformDef("linkedin")))).toBe(false);
    expect(blocking(validateFor(input("instagram", "Hi"), platformDef("instagram")))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/platforms/longForm.test.ts`
Expected: FAIL — missing titles, slugs and media issues are not reported yet.

- [ ] **Step 3: Extend the rule engine**

In `src/platforms/checks.ts`:
- change the imports to:
```ts
import { countChars } from "../model/body";
import { PLATFORM_META } from "../model/platforms";
import type { Channel, Issue } from "../model/types";
import { platformDef } from "./registry";
import { countFor, hashtags, postItems, postText } from "./text";
import { MB, type ComposeInput, type PlatformDef } from "./types";
```
- add, after `mediaCountChecks`:
```ts
export function titleChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const { limits } = def.capabilities;
  const title = input.variant.title?.trim() ?? "";
  if (!title) {
    return limits.titleRequired ? [{ level: "error", field: "title", code: "missing-title", message: `${label(def)} needs a title.` }] : [];
  }
  const n = countChars(title);
  if (limits.titleMax && n > limits.titleMax) {
    return [{ level: "error", field: "title", code: "title-too-long", message: `The title is ${fmt(n)}/${fmt(limits.titleMax)} characters.` }];
  }
  return [];
}

export function linkChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const { link } = def.capabilities.limits;
  const url = input.variant.url;
  if (link === "required" && !url) {
    return [{ level: "error", field: "url", code: "missing-url", message: `${label(def)} needs a link (url).` }];
  }
  if (link === "url-or-text" && !url && postItems(input.body, def).length === 0) {
    return [{ level: "error", field: "url", code: "missing-url", message: `${label(def)} needs a link (url) or text.` }];
  }
  if (link === "none" && url) {
    return [{ level: "warning", field: "url", code: "url-ignored", message: `${label(def)} doesn't use the url field; put the link in the text if you need it.` }];
  }
  return [];
}

export function captionChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const max = def.capabilities.limits.maxCharsWithMedia;
  if (!max || input.media.length === 0) return [];
  const n = countFor(postText(input.body, def), def);
  if (n <= max) return [];
  return [{ level: "error", field: "body", code: "caption-too-long", message: `With media, ${label(def)} allows ${fmt(max)} characters; the text is ${fmt(n)}.` }];
}

export function hashtagChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const max = def.capabilities.limits.maxHashtags;
  if (!max) return [];
  const n = hashtags(postText(input.body, def)).length;
  if (n <= max) return [];
  return [{ level: "error", field: "body", code: "too-many-hashtags", message: `${label(def)} allows at most ${max} hashtags; this post has ${n}.` }];
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

export function mediaChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const rules = def.capabilities.media;
  const issues = mediaCountChecks(input, def);
  if (rules.required && !input.media.some((m) => m.kind === "image")) {
    issues.push({ level: "error", field: "media", code: "media-required", message: `${label(def)} needs an image.` });
  }
  if (rules.maxCount === 0) return issues;
  for (const m of input.media) {
    const field = `media.${m.target}`;
    if (m.kind === "missing") {
      issues.push({ level: "error", field, code: "media-missing", message: `${m.target} was not found in the vault.` });
    } else if (m.kind === "video") {
      issues.push({ level: "error", field, code: "video-unsupported", message: `${m.target}: video isn't supported yet. Remove it or use an image.` });
    } else if (m.kind === "unsupported") {
      issues.push({ level: "error", field, code: "media-type", message: `${m.target}: use a PNG, JPG, WebP or GIF image.` });
    } else {
      if (m.bytes !== undefined && m.bytes > rules.maxBytes) {
        issues.push({ level: "error", field, code: "media-too-large", message: `${m.target} is ${mb(m.bytes)}; ${label(def)} accepts up to ${mb(rules.maxBytes)}.` });
      }
      if (rules.ratio && m.width && m.height) {
        const r = m.width / m.height;
        if (r < rules.ratio.min - 0.005 || r > rules.ratio.max + 0.005) {
          issues.push({
            level: "error",
            field,
            code: "media-ratio",
            message: `${m.target} is ${r.toFixed(2)}:1; ${label(def)} accepts ${rules.ratio.min.toFixed(2)}:1 to ${rules.ratio.max.toFixed(2)}:1.`,
          });
        }
      }
      if (!m.alt?.trim()) issues.push({ level: "warning", field, code: "missing-alt", message: `${m.target} has no alt text.` });
    }
  }
  return issues;
}
```
- replace `validateFor` with:
```ts
export function validateFor(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  return [
    ...titleChecks(input, def),
    ...textChecks(input, def, channel),
    ...captionChecks(input, def),
    ...hashtagChecks(input, def),
    ...linkChecks(input, def),
    ...mediaChecks(input, def),
    ...(def.validate?.(input, channel) ?? []),
  ];
}
```
- replace `counters` with:
```ts
export function counters(input: ComposeInput, def: PlatformDef, channel?: Channel): Counter[] {
  const { limits } = def.capabilities;
  const items = postItems(input.body, def);
  const limit = input.media.length > 0 && limits.maxCharsWithMedia ? limits.maxCharsWithMedia : limitFor(def, channel);
  const out: Counter[] =
    items.length > 1
      ? items.map((t, i) => ({ label: `Part ${i + 1}`, value: countFor(t, def), limit }))
      : [{ label: "Length", value: countFor(items[0] ?? "", def), limit }];
  if (limits.foldAt) out.push({ label: "Fold", value: countFor(items[0] ?? "", def), limit: limits.foldAt });
  if (limits.titleMax) out.push({ label: "Title", value: countChars(input.variant.title?.trim() ?? ""), limit: limits.titleMax });
  if (limits.maxHashtags) out.push({ label: "Hashtags", value: hashtags(items.join("\n\n")).length, limit: limits.maxHashtags });
  return out;
}
```

- [ ] **Step 4: Add the platform-specific checks**

`src/platforms/linkedin/index.ts` (replace the file):
```ts
import { postText, urlsIn } from "../text";
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "linkedin",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 3000, counter: "graphemes", foldAt: 210, link: "optional" },
    // approximate: image count and size
    media: { maxCount: 9, required: false, maxBytes: 8 * MB, video: false },
  },
  validate(input) {
    if (urlsIn(postText(input.body, def)).length === 0) return [];
    return [
      {
        level: "warning",
        field: "body",
        code: "link-in-body",
        message: "Posts with a link in the text often reach fewer people on LinkedIn. Consider moving the link to the first comment.",
      },
    ];
  },
};
```

`src/platforms/reddit/index.ts` (replace the file):
```ts
import { MB, type PlatformDef } from "../types";

const SUBREDDIT_RE = /^r\/[A-Za-z0-9_]{2,21}$/;

export const def: PlatformDef = {
  id: "reddit",
  dialect: "markdown",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: self-text length, gallery size and image size
    limits: { maxChars: 40000, counter: "graphemes", titleRequired: true, titleMax: 300, link: "url-or-text" },
    media: { maxCount: 20, required: false, maxBytes: 20 * MB, video: false },
  },
  validate(_input, channel) {
    if (!channel || SUBREDDIT_RE.test(channel.handle ?? "")) return [];
    return [
      {
        level: "error",
        field: "channels",
        code: "missing-subreddit",
        message: `Set the subreddit (e.g. r/SideProject) as the handle of ${channel.name}.`,
      },
    ];
  },
};
```

`src/platforms/wordpress/index.ts` (replace the file):
```ts
import type { Issue } from "../../model/types";
import { MB, type PlatformDef } from "../types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const def: PlatformDef = {
  id: "wordpress",
  dialect: "html",
  preview: "article",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: article length and upload size (site dependent)
    limits: { maxChars: 1_000_000, counter: "graphemes", titleRequired: true, link: "none" },
    media: { maxCount: 50, required: false, maxBytes: 20 * MB, video: false },
  },
  validate(input) {
    const wp = input.variant.wordpress;
    const issues: Issue[] = [];
    if (!wp?.slug) issues.push({ level: "error", field: "slug", code: "missing-slug", message: "WordPress needs a slug." });
    else if (!SLUG_RE.test(wp.slug)) {
      issues.push({ level: "error", field: "slug", code: "bad-slug", message: "Use lowercase letters, digits and dashes in the slug." });
    }
    if (!wp?.featuredImage) issues.push({ level: "warning", field: "featured_image", code: "missing-featured", message: "No featured image set." });
    return issues;
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/platforms && npm run typecheck`
Expected: PASS (Task 3 tests still pass: their images carry alt text and sizes within limits).

- [ ] **Step 6: Commit**

```bash
git add src/platforms test/platforms
git commit -m "feat(platforms): validate long-form, chat, link and article platforms (refs #42)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Media inspection, `media_meta` and crop geometry (#45, part 1)

**Files:**
- Create: `src/media/imageSize.ts`, `src/media/mediaInfo.ts`, `src/media/crop.ts`, `test/media/bytes.ts`, `test/media/imageSize.test.ts`, `test/media/mediaInfo.test.ts`, `test/media/crop.test.ts`, `test/model/mediaMeta.test.ts`
- Modify: `src/model/types.ts` (`MediaMeta`, `Variant.mediaMeta`), `src/model/frontmatter.ts` (`media_meta` parse/serialize, `VariantPatch.mediaMeta`), `test/fakes/obsidian.ts` (binary files, resource paths, link resolution of non-Markdown files)

**Interfaces:**
- Consumes: `MediaInfo`, `MediaRules` (Task 1).
- Produces:
  - `interface MediaMeta { alt?: string; focus?: [number, number] }`; `Variant.mediaMeta?: Record<string, MediaMeta>` keyed by link target. Frontmatter: `media_meta: { "cover.png": { alt: "…", focus: [0.5, 0.3] } }`. The focal point persists here, and the M5/M6 adapters crop with it.
  - `VariantPatch` accepts `mediaMeta`; `variantFields` writes `media_meta` (focus rounded to 2 decimals; empty → key deleted); `serializeMediaMeta(meta?)`.
  - `imageSize(bytes: Uint8Array): { width: number; height: number; mime: string } | null` (PNG, JPEG, GIF, WebP VP8/VP8L/VP8X).
  - `mediaKind(extension): MediaInfo["kind"]`, `class MediaInspector { constructor(app); resolve(target, sourcePath): TFile | null; inspect(v: Pick<Variant, "path" | "media" | "mediaMeta">): Promise<MediaInfo[]>; resourceUrl(path): string }` (sizes cached per path and mtime).
  - `interface Rect { x; y; width; height }`, `cropRect(size, ratio, focus?): Rect`, `clampRatio(ratio, range?): number`, `feedRatio(rules: MediaRules, size): number | null`, `focusFromPoint(x, y, box): [number, number]`.
  - Fake: `Vault.createBinary(path, data)`, `Vault.readBinary(file)`, `Vault.getResourcePath(file)`; `getFirstLinkpathDest` resolves links with an extension (e.g. `cover.png`) without appending `.md`.

- [ ] **Step 1: Write the byte builders and the failing tests**

`test/media/bytes.ts`:
```ts
/** Minimal image headers — enough for imageSize(), not valid images. */
export function png(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b.buffer;
}

export function gif(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(13);
  b.set([...new TextEncoder().encode("GIF89a")]);
  const dv = new DataView(b.buffer);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  return b.buffer;
}

export function jpeg(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dv = new DataView(b.buffer);
  dv.setUint16(13, height);
  dv.setUint16(15, width);
  return b.buffer;
}

function riff(chunk: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32);
  const enc = new TextEncoder();
  b.set(enc.encode("RIFF"), 0);
  b.set(enc.encode("WEBP"), 8);
  b.set(enc.encode(chunk), 12);
  return b;
}

export function webpExtended(width: number, height: number): ArrayBuffer {
  const b = riff("VP8X");
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return b.buffer;
}

export function webpLossless(width: number, height: number): ArrayBuffer {
  const b = riff("VP8L");
  b[20] = 0x2f;
  new DataView(b.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return b.buffer;
}

export function webpLossy(width: number, height: number): ArrayBuffer {
  const b = riff("VP8 ");
  b.set([0x9d, 0x01, 0x2a], 23);
  const dv = new DataView(b.buffer);
  dv.setUint16(26, width, true);
  dv.setUint16(28, height, true);
  return b.buffer;
}
```

`test/media/imageSize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { imageSize } from "../../src/media/imageSize";
import { gif, jpeg, png, webpExtended, webpLossless, webpLossy } from "./bytes";

describe("imageSize", () => {
  it.each([
    ["PNG", png(1080, 1350), { width: 1080, height: 1350, mime: "image/png" }],
    ["GIF", gif(480, 270), { width: 480, height: 270, mime: "image/gif" }],
    ["JPEG", jpeg(640, 480), { width: 640, height: 480, mime: "image/jpeg" }],
    ["WebP extended", webpExtended(1080, 1350), { width: 1080, height: 1350, mime: "image/webp" }],
    ["WebP lossless", webpLossless(300, 200), { width: 300, height: 200, mime: "image/webp" }],
    ["WebP lossy", webpLossy(1200, 628), { width: 1200, height: 628, mime: "image/webp" }],
  ])("reads %s headers", (_name, bytes, expected) => {
    expect(imageSize(new Uint8Array(bytes))).toEqual(expected);
  });

  it("returns null for anything else", () => {
    expect(imageSize(new TextEncoder().encode("hello, not an image"))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });
});
```

`test/media/crop.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clampRatio, cropRect, feedRatio, focusFromPoint } from "../../src/media/crop";
import { platformDef } from "../../src/platforms/registry";

describe("crop geometry", () => {
  it("crops a landscape image to a square around the focal point", () => {
    expect(cropRect({ width: 1600, height: 900 }, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(cropRect({ width: 1600, height: 900 }, 1, [0, 0.5])).toEqual({ x: 0, y: 0, width: 900, height: 900 });
    expect(cropRect({ width: 1600, height: 900 }, 1, [1, 0.5])).toEqual({ x: 700, y: 0, width: 900, height: 900 });
  });

  it("crops a portrait image to 16:9", () => {
    expect(cropRect({ width: 1080, height: 1350 }, 16 / 9)).toEqual({ x: 0, y: 371, width: 1080, height: 608 });
  });

  it("clamps ratios into the accepted range", () => {
    expect(clampRatio(0.5, { min: 0.8, max: 1.91 })).toBe(0.8);
    expect(clampRatio(3, { min: 0.8, max: 1.91 })).toBe(1.91);
    expect(clampRatio(1.2)).toBe(1.2);
  });

  it("picks the ratio a feed shows", () => {
    expect(feedRatio(platformDef("x").capabilities.media, { width: 1080, height: 1350 })).toBeCloseTo(16 / 9);
    expect(feedRatio(platformDef("instagram").capabilities.media, { width: 1080, height: 1920 })).toBe(0.8);
    expect(feedRatio(platformDef("linkedin").capabilities.media, { width: 1080, height: 1920 })).toBeNull();
  });

  it("turns a click into a focal point", () => {
    expect(focusFromPoint(150, 75, { left: 100, top: 50, width: 200, height: 100 })).toEqual([0.25, 0.25]);
    expect(focusFromPoint(0, 500, { left: 100, top: 50, width: 200, height: 100 })).toEqual([0, 1]);
  });
});
```

`test/media/mediaInfo.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { MediaInspector, mediaKind } from "../../src/media/mediaInfo";
import { createApp } from "../helpers";
import { png } from "./bytes";

async function vault() {
  const app = createApp();
  await app.vault.createFolder("Social/Event X");
  await app.vault.createBinary("Social/Event X/cover.png", png(1080, 1350));
  await app.vault.createBinary("Social/Event X/clip.mp4", new Uint8Array([0, 0, 0]).buffer);
  await app.vault.createBinary("Social/Event X/doc.pdf", new Uint8Array([1, 2]).buffer);
  await app.vault.createBinary("Social/Event X/broken.png", new TextEncoder().encode("not a png").buffer);
  return app;
}

const variant = {
  path: "Social/Event X/Event X – Instagram.md",
  media: ["cover.png", "clip.mp4", "doc.pdf", "gone.png", "broken.png"],
  mediaMeta: { "cover.png": { alt: "Makers at laptops", focus: [0.5, 0.3] as [number, number] } },
};

describe("MediaInspector", () => {
  it("resolves each media link and reads kind, size and dimensions (review focus 2)", async () => {
    const inspector = new MediaInspector((await vault()) as never);
    expect(await inspector.inspect(variant)).toEqual([
      {
        target: "cover.png",
        path: "Social/Event X/cover.png",
        kind: "image",
        mime: "image/png",
        bytes: 33,
        width: 1080,
        height: 1350,
        alt: "Makers at laptops",
        focus: [0.5, 0.3],
      },
      { target: "clip.mp4", path: "Social/Event X/clip.mp4", kind: "video", bytes: 3 },
      { target: "doc.pdf", path: "Social/Event X/doc.pdf", kind: "unsupported", bytes: 2 },
      { target: "gone.png", kind: "missing" },
      { target: "broken.png", path: "Social/Event X/broken.png", kind: "image", mime: "image/png", bytes: 9 },
    ]);
  });

  it("reads each image once until it changes", async () => {
    const app = await vault();
    const spy = vi.spyOn(app.vault, "readBinary");
    const inspector = new MediaInspector(app as never);
    await inspector.inspect({ path: variant.path, media: ["cover.png"] });
    await inspector.inspect({ path: variant.path, media: ["cover.png"] });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("gives a resource URL for previews", async () => {
    const inspector = new MediaInspector((await vault()) as never);
    expect(inspector.resourceUrl("Social/Event X/cover.png")).toBe("app://local/Social/Event X/cover.png");
    expect(inspector.resourceUrl("nope.png")).toBe("");
  });

  it.each([
    ["PNG", "image"],
    ["jpeg", "image"],
    ["webp", "image"],
    ["gif", "image"],
    ["mov", "video"],
    ["pdf", "unsupported"],
  ])("%s is %s", (ext, kind) => {
    expect(mediaKind(ext)).toBe(kind);
  });
});
```

`test/model/mediaMeta.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseVariant, variantFields } from "../../src/model/frontmatter";
import { SafeWriter } from "../../src/model/writer";
import { createApp, writeNote } from "../helpers";

const base = { type: "social-post", platform: "instagram", channels: ["ig/acmestudio"] };

describe("media_meta", () => {
  it("reads alt text and focal points keyed by link target", () => {
    const r = parseVariant(
      { ...base, media_meta: { "cover.png": { alt: " Makers ", focus: "0.5, 0.3" }, "[[b.png]]": { focus: [0.2, 0.8] } } },
      "p.md",
    );
    expect(r.value?.mediaMeta).toEqual({ "cover.png": { alt: "Makers", focus: [0.5, 0.3] }, "b.png": { focus: [0.2, 0.8] } });
    expect(r.issues).toEqual([]);
  });

  it("ignores badly shaped entries with a warning and keeps the valid parts (review focus 3)", () => {
    const wrongType = parseVariant({ ...base, media_meta: "cover.png" }, "p.md");
    expect(wrongType.value?.mediaMeta).toBeUndefined();
    expect(wrongType.issues).toEqual([{ level: "warning", field: "media_meta", message: "media_meta must be a map of image → { alt, focus }" }]);

    const badFocus = parseVariant({ ...base, media_meta: { "a.png": { alt: "Crowd", focus: "0.5, 2" }, "b.png": { alt: "" } } }, "p.md");
    expect(badFocus.value?.mediaMeta).toEqual({ "a.png": { alt: "Crowd" }, "b.png": {} });
    expect(badFocus.issues).toEqual([
      { level: "warning", field: "media_meta.a.png.focus", message: "focus must be two numbers between 0 and 1, e.g. 0.5, 0.3" },
    ]);
  });

  it("serializes with rounded focus and drops empty entries", () => {
    expect(variantFields({ mediaMeta: { "a.png": { alt: "A", focus: [0.123, 0.5] }, "b.png": {} } })).toEqual({
      media_meta: { "a.png": { alt: "A", focus: [0.12, 0.5] } },
    });
    expect(variantFields({ mediaMeta: {} })).toEqual({ media_meta: undefined });
  });

  it("round-trips through SafeWriter", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Posts/P.md", base, "Hi\n");
    const writer = new SafeWriter(app as never);
    await writer.updateVariant(file as never, () => ({ fields: { mediaMeta: { "cover.png": { alt: "Makers", focus: [0.25, 0.75] } } } }));
    const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
    expect(fm.media_meta).toEqual({ "cover.png": { alt: "Makers", focus: [0.25, 0.75] } });
    expect(parseVariant(fm, file.path).value?.mediaMeta).toEqual({ "cover.png": { alt: "Makers", focus: [0.25, 0.75] } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/media test/model/mediaMeta.test.ts`
Expected: FAIL — modules missing and `createBinary` is not a function.

- [ ] **Step 3: Extend the Obsidian fake**

In `test/fakes/obsidian.ts`:
- change the `Entry` interface to:
```ts
interface Entry {
  file: TFile;
  content: string;
  binary?: ArrayBuffer;
}
```
- add these methods to `class Vault`, after `create`:
```ts
  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error("File already exists.");
    const dir = parentOf(p);
    if (!this.folders.has(dir)) throw new Error(`Folder ${dir} does not exist.`);
    const file = new TFile(this);
    setPath(file, p);
    file.stat = { ctime: Date.now(), mtime: Date.now(), size: data.byteLength };
    this.files.set(p, { file, content: "", binary: data.slice(0) });
    this.trigger("create", file);
    this.app.metadataCache.fileChanged(file, "");
    return file;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.entry(file);
    return entry.binary ? entry.binary.slice(0) : new TextEncoder().encode(entry.content).buffer;
  }

  getResourcePath(file: TFile): string {
    return `app://local/${file.path}`;
  }
```
- in `MetadataCache.getFirstLinkpathDest`, replace the line `const withExt = target.endsWith(".md") ? target : \`${target}.md\`;` with:
```ts
    const name = target.split("/").pop() ?? target;
    const withExt = /\.[a-z0-9]+$/i.test(name) ? target : `${target}.md`;
```

- [ ] **Step 4: Implement `imageSize`, `crop` and `MediaInspector`**

`src/media/imageSize.ts`:
```ts
export interface ImageSize {
  width: number;
  height: number;
  mime: string;
}

const ascii = (b: Uint8Array, offset: number, length: number): string => String.fromCharCode(...b.subarray(offset, offset + length));

function jpegSize(b: Uint8Array, dv: DataView): ImageSize | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7), mime: "image/jpeg" };
    }
    o += 2 + dv.getUint16(o + 2);
  }
  return null;
}

function webpSize(b: Uint8Array, dv: DataView): ImageSize | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { width: w, height: h, mime: "image/webp" };
  }
  if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, mime: "image/webp" };
  if (chunk === "VP8L") {
    const bits = dv.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" };
  }
  return null;
}

/** Width and height from the file header of a PNG, JPEG, GIF or WebP image; null for anything else. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") {
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: "image/png" };
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), mime: "image/gif" };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes, dv);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, dv);
  return null;
}
```

`src/media/crop.ts`:
```ts
import type { MediaRules } from "../platforms/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampRatio(ratio: number, range?: { min: number; max: number }): number {
  if (!range) return ratio;
  return Math.min(range.max, Math.max(range.min, ratio));
}

/** The part of the image (in source pixels) a feed with `ratio` shows, centred on the focal point. */
export function cropRect(size: { width: number; height: number }, ratio: number, focus: [number, number] = [0.5, 0.5]): Rect {
  let width = size.width;
  let height = size.height;
  if (size.width / size.height > ratio) width = Math.round(size.height * ratio);
  else height = Math.round(size.width / ratio);
  const x = Math.round(Math.min(Math.max(focus[0] * size.width - width / 2, 0), size.width - width));
  const y = Math.round(Math.min(Math.max(focus[1] * size.height - height / 2, 0), size.height - height));
  return { x, y, width, height };
}

/** The ratio a feed shows a single image at, or null when the platform shows images uncropped. */
export function feedRatio(rules: MediaRules, size: { width: number; height: number }): number | null {
  if (rules.cropRatio) return rules.cropRatio;
  if (rules.ratio) return clampRatio(size.width / size.height, rules.ratio);
  return null;
}

/** A click inside `box` → focal point (0..1, two decimals). */
export function focusFromPoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }): [number, number] {
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  return [clamp((x - box.left) / box.width), clamp((y - box.top) / box.height)];
}
```

`src/media/mediaInfo.ts`:
```ts
import type { App, TFile } from "obsidian";
import type { Variant } from "../model/types";
import type { MediaInfo } from "../platforms/types";
import { imageSize } from "./imageSize";

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

export function mediaKind(extension: string): MediaInfo["kind"] {
  const ext = extension.toLowerCase();
  if (ext in IMAGE_MIME) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "unsupported";
}

type Size = { width: number; height: number } | null;

/** Resolves `media:` links and reads what checks and previews need. Image sizes are cached per path and mtime. */
export class MediaInspector {
  private readonly sizes = new Map<string, { mtime: number; size: Size }>();

  constructor(private readonly app: App) {}

  resolve(target: string, sourcePath: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  }

  inspect(v: Pick<Variant, "path" | "media" | "mediaMeta">): Promise<MediaInfo[]> {
    return Promise.all(v.media.map((target) => this.one(target, v)));
  }

  resourceUrl(path: string): string {
    const file = this.app.vault.getFileByPath(path);
    return file ? this.app.vault.getResourcePath(file) : "";
  }

  private async one(target: string, v: Pick<Variant, "path" | "mediaMeta">): Promise<MediaInfo> {
    const meta = v.mediaMeta?.[target];
    const base: MediaInfo = { target, kind: "missing" };
    if (meta?.alt) base.alt = meta.alt;
    if (meta?.focus) base.focus = meta.focus;
    const file = this.resolve(target, v.path);
    if (!file) return base;
    const kind = mediaKind(file.extension);
    const info: MediaInfo = { ...base, path: file.path, kind, bytes: file.stat.size };
    if (kind !== "image") return info;
    info.mime = IMAGE_MIME[file.extension.toLowerCase()];
    const size = await this.size(file);
    return size ? { ...info, width: size.width, height: size.height } : info;
  }

  private async size(file: TFile): Promise<Size> {
    const cached = this.sizes.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.size;
    const found = imageSize(new Uint8Array(await this.app.vault.readBinary(file)));
    const size = found ? { width: found.width, height: found.height } : null;
    this.sizes.set(file.path, { mtime: file.stat.mtime, size });
    return size;
  }
}
```

- [ ] **Step 5: Add `media_meta` to the model**

In `src/model/types.ts`, add before `interface Variant`:
```ts
/** Per-image settings from `media_meta`, keyed by the link target used in `media:`. */
export interface MediaMeta {
  alt?: string;
  /** Focal point, 0..1 from the left and from the top; adapters crop around it. */
  focus?: [number, number];
}
```
and add to `interface Variant`, after `media: string[];`:
```ts
  mediaMeta?: Record<string, MediaMeta>;
```

In `src/model/frontmatter.ts`:
- change the types import to `import type { Campaign, Delivery, Issue, MediaMeta, Parsed, Variant } from "./types";`
- add, before `parseVariant`:
```ts
function parseFocus(value: unknown): [number, number] | undefined {
  const parts: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (parts.length !== 2) return undefined;
  const nums = parts.map((p) => (typeof p === "number" ? p : typeof p === "string" && p.trim() ? Number(p) : Number.NaN));
  return nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ? [nums[0]!, nums[1]!] : undefined;
}

function parseMediaMeta(raw: unknown, issues: Issue[]): Record<string, MediaMeta> | undefined {
  if (isBlank(raw)) return undefined;
  if (!isRecord(raw)) {
    issues.push({ level: "warning", field: "media_meta", message: "media_meta must be a map of image → { alt, focus }" });
    return undefined;
  }
  const out: Record<string, MediaMeta> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = linkTarget(key) ?? key;
    const field = `media_meta.${target}`;
    if (!isRecord(value)) {
      issues.push({ level: "warning", field, message: "Each entry must be a map with alt and focus" });
      continue;
    }
    const meta: MediaMeta = {};
    if (typeof value.alt === "string" && value.alt.trim()) meta.alt = value.alt.trim();
    if (!isBlank(value.focus)) {
      const focus = parseFocus(value.focus);
      if (focus) meta.focus = focus;
      else issues.push({ level: "warning", field: `${field}.focus`, message: "focus must be two numbers between 0 and 1, e.g. 0.5, 0.3" });
    }
    out[target] = meta;
  }
  return out;
}

export function serializeMediaMeta(meta: Record<string, MediaMeta> | undefined): Record<string, unknown> | undefined {
  const entries = Object.entries(meta ?? {})
    .map(([target, m]) => {
      const out: Record<string, unknown> = {};
      if (m.alt) out.alt = m.alt;
      if (m.focus) out.focus = m.focus.map((n) => Math.round(n * 100) / 100);
      return [target, out] as const;
    })
    .filter(([, out]) => Object.keys(out).length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
```
- in `parseVariant`, right before `if (platform === "wordpress") {`, add:
```ts
  const mediaMeta = parseMediaMeta(fm.media_meta, issues);
  if (mediaMeta) variant.mediaMeta = mediaMeta;
```
- in `VariantPatch`, add `"mediaMeta"` to the picked keys:
```ts
export type VariantPatch = Partial<
  Pick<
    Variant,
    | "channels"
    | "mode"
    | "status"
    | "scheduledAt"
    | "staggerMinutes"
    | "reminders"
    | "media"
    | "mediaMeta"
    | "title"
    | "url"
    | "deliveries"
  >
>;
```
- in `variantFields`, after the `media` line add:
```ts
  if ("mediaMeta" in patch) out.media_meta = serializeMediaMeta(patch.mediaMeta);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (the whole suite: the fake change only affects links that carry a file extension).

- [ ] **Step 7: Commit**

```bash
git add src/media src/model test/media test/model/mediaMeta.test.ts test/fakes/obsidian.ts
git commit -m "feat(media): read image sizes, store alt text and focal points, compute crops (refs #45)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Preview model and social feed previews (#43)

**Files:**
- Create: `src/previews/model.ts`, `src/previews/Preview.svelte`, `src/previews/FeedPreview.svelte`, `src/previews/PvHeader.svelte`, `src/previews/PvText.svelte`, `src/previews/PvMedia.svelte`, `src/previews/PvLinkCard.svelte`, `src/styles/previews.css`, `test/previews/helpers.ts`, `test/previews/model.test.ts`, `test/previews/feed.test.ts`
- Modify: `src/styles/index.css`

**Interfaces:**
- Consumes: `postItems`, `countFor`, `urlsIn` (Task 2); `limitFor` (Task 3); `cropRect`, `feedRatio`, `Rect` (Task 5); `initials` (`src/ui/format.ts`); `MediaInfo`, `PlatformDef` (Task 1).
- Produces:
  - `interface Segment { text; bold?; italic?; strike?; code?; tag?; href? }`, `segments(text, dialect): Segment[]` (what the text looks like on the platform: Markdown emphasis for markdown/telegram, WhatsApp `*bold*` / `_italic_` / `~strike~`, links and hashtags everywhere).
  - `interface PreviewAuthor { name; handle?; color; initials; round }`, `interface PreviewMedia { target; src; kind; alt?; crop? }`, `interface PreviewItem { segments; chars; limit; over }`, `interface PreviewModel { platform; label; layout; dialect; author; title?; url?; domain?; items; fold?; media; linkCard?; featured?; excerpt?; markdown }`.
  - `interface PreviewInput { def; variant: Pick<Variant, "title" | "url" | "wordpress">; body; media; featured?; channel?; resource(path): string }`, `previewModel(input): PreviewModel`, `objectPosition(crop): string`, `domainOf(url): string`.
  - `<Preview model width?="mobile"|"desktop">` — a `<figure aria-label="<Platform> preview">`. In this task every layout renders through `FeedPreview`; Task 7 adds the chat, link and article layouts.
  - Test helper `pv(platform, body, extra?, media?, channel?)`.

- [ ] **Step 1: Write the test helper and the failing tests**

`test/previews/helpers.ts`:
```ts
import type { Platform } from "../../src/model/platforms";
import type { Channel, Variant } from "../../src/model/types";
import { previewModel, type PreviewModel } from "../../src/previews/model";
import { platformDef } from "../../src/platforms/registry";
import type { MediaInfo } from "../../src/platforms/types";
import { input } from "../platforms/fixtures";

export function pv(platform: Platform, body: string, extra: Partial<Variant> = {}, media: MediaInfo[] = [], channel?: Channel, featured?: MediaInfo): PreviewModel {
  return previewModel({
    def: platformDef(platform),
    variant: input(platform, body, extra, media).variant,
    body,
    media,
    featured,
    channel,
    resource: (path) => `app://local/${path}`,
  });
}
```

`test/previews/model.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cropRect } from "../../src/media/crop";
import { domainOf, objectPosition, segments } from "../../src/previews/model";
import { channel, img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("segments", () => {
  it("renders Markdown emphasis, links, urls and hashtags", () => {
    expect(segments("Hi **you** and *me* see [site](https://a.b) or https://c.d/e. #tag", "markdown")).toEqual([
      { text: "Hi " },
      { text: "you", bold: true },
      { text: " and " },
      { text: "me", italic: true },
      { text: " see " },
      { text: "site", href: "https://a.b" },
      { text: " or " },
      { text: "https://c.d/e", href: "https://c.d/e" },
      { text: ". " },
      { text: "#tag", tag: true },
    ]);
  });

  it("renders WhatsApp formatting", () => {
    expect(segments("*Event X* · _18:00_ ~free~", "whatsapp")).toEqual([
      { text: "Event X", bold: true },
      { text: " · " },
      { text: "18:00", italic: true },
      { text: " " },
      { text: "free", strike: true },
    ]);
  });

  it("leaves Markdown markers alone on plain platforms", () => {
    expect(segments("**not bold** https://x.y", "plain")).toEqual([{ text: "**not bold** " }, { text: "https://x.y", href: "https://x.y" }]);
  });
});

describe("previewModel", () => {
  it("folds LinkedIn text after 210 characters", () => {
    const m = pv("linkedin", "a".repeat(250));
    expect(m.fold).toEqual([{ text: "a".repeat(210) }]);
    expect(m.items).toEqual([{ segments: [{ text: "a".repeat(250) }], chars: 250, limit: 3000, over: false }]);
  });

  it("splits an X thread and shows a link card for the last link", () => {
    const m = pv("x", "One\n---\nTwo #launch\n---\nhttps://example.com/rsvp");
    expect(m.items.map((i) => i.segments)).toEqual([
      [{ text: "One" }],
      [{ text: "Two " }, { text: "#launch", tag: true }],
      [{ text: "https://example.com/rsvp", href: "https://example.com/rsvp" }],
    ]);
    expect(m.linkCard).toEqual({ url: "https://example.com/rsvp", domain: "example.com" });
  });

  it("crops Instagram images to the accepted ratio around the focal point", () => {
    const m = pv("instagram", "Caption", {}, [img("a.png", 1080, 1920, { focus: [0.5, 0.2] })]);
    const crop = { ratio: 0.8, rect: cropRect({ width: 1080, height: 1920 }, 0.8, [0.5, 0.2]), width: 1080, height: 1920 };
    expect(m.media).toEqual([{ target: "a.png", src: "app://local/Social/a.png", kind: "image", alt: "An image", crop }]);
    expect(objectPosition(crop)).toBe("50% 0%");
    expect(m.linkCard).toBeUndefined();
  });

  it("drops media on platforms that show none", () => {
    expect(pv("hackernews", "", { title: "Show HN", url: "https://example.com" }, [img()]).media).toEqual([]);
  });

  it("uses the channel's name, handle, colour and shape", () => {
    const acme = channel("li/acme-studio", { name: "Acme Studio", kind: "page", avatarColor: "#6ea3e6" });
    expect(pv("linkedin", "Hi", {}, [], acme).author).toEqual({ name: "Acme Studio", handle: undefined, color: "#6ea3e6", initials: "AS", round: false });
    expect(pv("linkedin", "Hi").author).toMatchObject({ name: "You", round: true });
  });

  it("flags items over the limit", () => {
    expect(pv("bluesky", "a".repeat(301)).items[0]).toMatchObject({ chars: 301, limit: 300, over: true });
  });

  it("reads the domain of a url", () => {
    expect(domainOf("https://www.example.com/a")).toBe("example.com");
    expect(domainOf("not a url")).toBe("not a url");
  });

  const SAMPLE = "**Event X** is back on the 12th.\n\nEighty makers, one evening. #events\n\nRSVP: https://example.com/event-x";
  const IDS = { linkedin: "li/you", x: "x/you", instagram: "ig/you", facebook: "fb/you", mastodon: "ma/you", bluesky: "bs/you" } as const;
  it.each(Object.keys(IDS) as Array<keyof typeof IDS>)("%s model snapshot", (platform) => {
    const ch = channel(IDS[platform], { name: "Event X", handle: "@eventx" });
    expect(pv(platform, SAMPLE, {}, [img("cover.png", 1600, 900)], ch)).toMatchSnapshot();
  });
});
```

`test/previews/feed.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Preview from "../../src/previews/Preview.svelte";
import { img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("feed previews", () => {
  it("folds long LinkedIn text behind “…see more”", async () => {
    render(Preview, { props: { model: pv("linkedin", "a".repeat(250)) } });
    const figure = screen.getByRole("figure", { name: "LinkedIn preview" });
    expect(figure.textContent).toContain("a".repeat(210));
    expect(figure.textContent).not.toContain("a".repeat(211));
    await fireEvent.click(screen.getByRole("button", { name: "…see more" }));
    expect(figure.textContent).toContain("a".repeat(250));
  });

  it("renders an X thread as numbered posts", () => {
    render(Preview, { props: { model: pv("x", "One\n---\nTwo\n---\nThree") } });
    const posts = screen.getByRole("figure", { name: "X preview" }).querySelectorAll(".osmm-pv-post");
    expect([...posts].map((p) => p.querySelector(".osmm-pv-meta")?.textContent)).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("shows hashtags and links, plus a link card", () => {
    const { container } = render(Preview, { props: { model: pv("mastodon", "Hi #launch https://example.com/x") } });
    expect(container.querySelector(".osmm-pv-tag")?.textContent).toBe("#launch");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["https://example.com/x", "https://example.com/x"]);
  });

  it("puts Instagram images before the caption", () => {
    const { container } = render(Preview, { props: { model: pv("instagram", "Caption", {}, [img("a.png", 1080, 1350)]) } });
    const tile = container.querySelector(".osmm-pv-tile")!;
    const text = container.querySelector(".osmm-pv-text")!;
    expect(tile.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("img", { name: "An image" }).getAttribute("src")).toBe("app://local/Social/a.png");
  });

  it("shows a missing image as a labelled placeholder", () => {
    render(Preview, { props: { model: pv("linkedin", "Hi", {}, [{ target: "gone.png", kind: "missing" }]) } });
    expect(screen.getByRole("img", { name: "gone.png is not shown" })).toBeTruthy();
  });

  it("flags a post over the limit", () => {
    render(Preview, { props: { model: pv("bluesky", "a".repeat(301)) } });
    expect(screen.getByRole("status").textContent).toBe("301/300 characters");
  });

  it("switches between mobile and desktop widths", () => {
    render(Preview, { props: { model: pv("facebook", "Hi"), width: "desktop" } });
    expect(screen.getByRole("figure").getAttribute("data-width")).toBe("desktop");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/previews`
Expected: FAIL — `Cannot find module '../../src/previews/model'`.

- [ ] **Step 3: Implement the preview model**

`src/previews/model.ts`:
```ts
import { countChars } from "../model/body";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel, Variant } from "../model/types";
import { cropRect, feedRatio, type Rect } from "../media/crop";
import { limitFor } from "../platforms/checks";
import { countFor, postItems, urlsIn } from "../platforms/text";
import type { MediaInfo, PlatformDef, PreviewLayout, TextDialect } from "../platforms/types";
import { initials } from "../ui/format";

export interface Segment {
  text: string;
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  tag?: true;
  href?: string;
}

const URL_SRC = String.raw`(?<url>https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])`;
const TAG_SRC = String.raw`(?<tag>(?<=^|\s)#[\p{L}\p{N}_]+)`;
const MARKDOWN_SRC = [
  String.raw`\[(?<lt>[^\]\n]+)\]\((?<lu>[^)\s]+)\)`,
  String.raw`\*\*(?<b>[^*\n]+)\*\*`,
  String.raw`~~(?<s>[^~\n]+)~~`,
  String.raw`\x60(?<c>[^\x60\n]+)\x60`,
  String.raw`(?<![\w*])[*_](?<i>[^*_\n]+)[*_](?![\w*])`,
];
const WHATSAPP_SRC = [
  String.raw`\x60\x60\x60(?<c>[^\x60]+)\x60\x60\x60`,
  String.raw`(?<![\w*])\*(?<b>[^*\n]+)\*(?![\w*])`,
  String.raw`(?<![\w_])_(?<i>[^_\n]+)_(?![\w_])`,
  String.raw`(?<![\w~])~(?<s>[^~\n]+)~(?![\w~])`,
];

const REGEX = new Map<TextDialect, RegExp>();

function regexFor(dialect: TextDialect): RegExp {
  let re = REGEX.get(dialect);
  if (!re) {
    const parts =
      dialect === "markdown" || dialect === "telegram"
        ? [...MARKDOWN_SRC, URL_SRC, TAG_SRC]
        : dialect === "whatsapp"
          ? [...WHATSAPP_SRC, URL_SRC, TAG_SRC]
          : [URL_SRC, TAG_SRC];
    re = new RegExp(parts.join("|"), "gu");
    REGEX.set(dialect, re);
  }
  return re;
}

/** How the text looks on the platform: emphasis per dialect, plus links and hashtags. */
export function segments(text: string, dialect: TextDialect): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(regexFor(dialect))) {
    const g = m.groups ?? {};
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (g.url !== undefined) out.push({ text: g.url, href: g.url });
    else if (g.tag !== undefined) out.push({ text: g.tag, tag: true });
    else if (g.lt !== undefined) out.push({ text: g.lt, href: g.lu });
    else if (g.b !== undefined) out.push({ text: g.b, bold: true });
    else if (g.i !== undefined) out.push({ text: g.i, italic: true });
    else if (g.s !== undefined) out.push({ text: g.s, strike: true });
    else if (g.c !== undefined) out.push({ text: g.c, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export interface PreviewAuthor {
  name: string;
  handle?: string;
  color: string;
  initials: string;
  round: boolean;
}

export interface PreviewMedia {
  target: string;
  src: string;
  kind: MediaInfo["kind"];
  alt?: string;
  crop?: { ratio: number; rect: Rect; width: number; height: number };
}

export interface PreviewItem {
  segments: Segment[];
  chars: number;
  limit: number;
  over: boolean;
}

export interface PreviewModel {
  platform: Platform;
  label: string;
  layout: PreviewLayout;
  dialect: TextDialect;
  author: PreviewAuthor;
  title?: string;
  url?: string;
  domain?: string;
  items: PreviewItem[];
  /** The first item cut at the platform's fold, when it is longer. */
  fold?: Segment[];
  media: PreviewMedia[];
  linkCard?: { url: string; domain: string };
  featured?: PreviewMedia;
  excerpt?: string;
  /** The raw Markdown, for the article layout. */
  markdown: string;
}

export interface PreviewInput {
  def: PlatformDef;
  variant: Pick<Variant, "title" | "url" | "wordpress">;
  body: string;
  media: MediaInfo[];
  featured?: MediaInfo;
  channel?: Channel;
  resource(path: string): string;
}

/** Platforms whose feed turns a link into a card. */
const LINK_CARDS = new Set<Platform>(["linkedin", "x", "facebook", "mastodon", "bluesky", "telegram", "discord", "whatsapp"]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncate(text: string, n: number): string {
  return [...graphemes.segment(text)]
    .slice(0, n)
    .map((s) => s.segment)
    .join("")
    .trimEnd();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function previewMedia(m: MediaInfo, def: PlatformDef, resource: (path: string) => string): PreviewMedia {
  const out: PreviewMedia = { target: m.target, src: m.path ? resource(m.path) : "", kind: m.kind };
  if (m.alt) out.alt = m.alt;
  if (m.kind === "image" && m.width && m.height) {
    const size = { width: m.width, height: m.height };
    const ratio = feedRatio(def.capabilities.media, size);
    if (ratio) out.crop = { ratio, rect: cropRect(size, ratio, m.focus), width: m.width, height: m.height };
  }
  return out;
}

/** CSS object-position that shows `crop.rect` of the image inside an `object-fit: cover` box. */
export function objectPosition(crop: NonNullable<PreviewMedia["crop"]>): string {
  const x = crop.width > crop.rect.width ? (crop.rect.x / (crop.width - crop.rect.width)) * 100 : 50;
  const y = crop.height > crop.rect.height ? (crop.rect.y / (crop.height - crop.rect.height)) * 100 : 50;
  return `${Math.round(x)}% ${Math.round(y)}%`;
}

export function previewModel(p: PreviewInput): PreviewModel {
  const { def, variant, channel } = p;
  const items = postItems(p.body, def);
  const limit = limitFor(def, channel);
  const name = channel?.name ?? "You";
  const model: PreviewModel = {
    platform: def.id,
    label: PLATFORM_META[def.id].label,
    layout: def.preview,
    dialect: def.dialect,
    author: {
      name,
      handle: channel?.handle,
      color: channel?.avatarColor ?? "#888888",
      initials: initials(name),
      round: !channel || channel.kind === "profile" || channel.kind === "account",
    },
    items: items.map((text) => {
      const chars = countFor(text, def);
      return { segments: segments(text, def.dialect), chars, limit, over: chars > limit };
    }),
    media: def.capabilities.media.maxCount > 0 ? p.media.map((m) => previewMedia(m, def, p.resource)) : [],
    markdown: p.body,
  };
  if (variant.title) model.title = variant.title;
  if (variant.url) {
    model.url = variant.url;
    model.domain = domainOf(variant.url);
  }
  const foldAt = def.capabilities.limits.foldAt;
  const first = items[0] ?? "";
  if (foldAt && countChars(first) > foldAt) model.fold = segments(truncate(first, foldAt), def.dialect);
  const cardUrl = variant.url ?? urlsIn(items.join("\n")).at(-1);
  if (cardUrl && model.media.length === 0 && LINK_CARDS.has(def.id)) model.linkCard = { url: cardUrl, domain: domainOf(cardUrl) };
  if (p.featured) model.featured = previewMedia(p.featured, def, p.resource);
  if (variant.wordpress?.excerpt) model.excerpt = variant.wordpress.excerpt;
  return model;
}
```

- [ ] **Step 4: Write the preview primitives and the feed layout**

`src/previews/PvText.svelte`:
```svelte
<script lang="ts">
  import type { Segment } from "./model";

  let { segments }: { segments: Segment[] } = $props();
</script>

<p class="osmm-pv-text">{#each segments as s, i (i)}{#if s.href}<a class="osmm-pv-link" href={s.href} target="_blank" rel="noopener">{s.text}</a>{:else if s.tag}<span class="osmm-pv-tag">{s.text}</span>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else if s.strike}<s>{s.text}</s>{:else if s.code}<code>{s.text}</code>{:else}{s.text}{/if}{/each}</p>
```

`src/previews/PvHeader.svelte`:
```svelte
<script lang="ts">
  import type { PreviewAuthor } from "./model";

  let { author, meta = "" }: { author: PreviewAuthor; meta?: string } = $props();
</script>

<div class="osmm-pv-head">
  <span class="osmm-pv-avatar" class:is-round={author.round} style:--osmm-avatar={author.color} aria-hidden="true">{author.initials}</span>
  <span class="osmm-pv-who">
    <strong>{author.name}</strong>
    {#if author.handle}<span class="osmm-pv-handle">{author.handle}</span>{/if}
  </span>
  {#if meta}<span class="osmm-pv-meta">{meta}</span>{/if}
</div>
```

`src/previews/PvMedia.svelte`:
```svelte
<script lang="ts">
  import { objectPosition, type PreviewMedia } from "./model";

  let { media }: { media: PreviewMedia[] } = $props();
  const shown = $derived(media.slice(0, 4));
</script>

{#if shown.length}
  <div class="osmm-pv-media" data-count={shown.length}>
    {#each shown as m (m.target)}
      {#if m.kind === "image" && m.src}
        <div class="osmm-pv-tile" style:aspect-ratio={shown.length === 1 && m.crop ? String(m.crop.ratio) : null}>
          <img src={m.src} alt={m.alt ?? ""} style:object-position={m.crop ? objectPosition(m.crop) : null} />
        </div>
      {:else}
        <div class="osmm-pv-tile is-missing" role="img" aria-label={`${m.target} is not shown`}>{m.target}</div>
      {/if}
    {/each}
  </div>
{/if}
```

`src/previews/PvLinkCard.svelte`:
```svelte
<script lang="ts">
  let { card }: { card: { url: string; domain: string } } = $props();
</script>

<a class="osmm-pv-card" href={card.url} target="_blank" rel="noopener">
  <span class="osmm-pv-card-domain">{card.domain}</span>
  <span class="osmm-pv-card-url">{card.url}</span>
</a>
```

`src/previews/FeedPreview.svelte`:
```svelte
<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvHeader from "./PvHeader.svelte";
  import PvLinkCard from "./PvLinkCard.svelte";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  let expanded = $state(false);
  const posts = $derived(model.items.length ? model.items : [{ segments: [], chars: 0, limit: 0, over: false }]);
  const numbered = $derived(model.layout === "thread" && model.items.length > 1);
  const mediaFirst = $derived(model.platform === "instagram");
</script>

<article class="osmm-pv-feed" data-layout={model.layout}>
  {#each posts as item, i (i)}
    <div class="osmm-pv-post" class:is-reply={i > 0}>
      <PvHeader author={model.author} meta={numbered ? `${i + 1}/${model.items.length}` : "now"} />
      {#if i === 0 && mediaFirst}<PvMedia media={model.media} />{/if}
      {#if i === 0 && model.fold && !expanded}
        <PvText segments={model.fold} />
        <button type="button" class="osmm-pv-more" onclick={() => (expanded = true)}>…see more</button>
      {:else}
        <PvText segments={item.segments} />
      {/if}
      {#if i === 0 && !mediaFirst}<PvMedia media={model.media} />{/if}
      {#if i === 0 && model.linkCard}<PvLinkCard card={model.linkCard} />{/if}
      {#if item.over}<p class="osmm-pv-over" role="status">{item.chars}/{item.limit} characters</p>{/if}
    </div>
  {/each}
</article>
```

`src/previews/Preview.svelte`:
```svelte
<script lang="ts">
  import type { PreviewModel } from "./model";
  import FeedPreview from "./FeedPreview.svelte";

  let { model, width = "mobile" }: { model: PreviewModel; width?: "mobile" | "desktop" } = $props();
</script>

<figure class="osmm-preview" data-width={width} data-platform={model.platform} aria-label={`${model.label} preview`}>
  <FeedPreview {model} />
</figure>
```

`src/styles/previews.css`:
```css
/* Stylized platform previews: approximations built from Obsidian variables, not copies of each platform's design. */
.osmm-preview { margin: 0; color: var(--text-normal); font-size: var(--font-ui-small); }
.osmm-preview[data-width="mobile"] { max-width: 380px; }
.osmm-preview[data-width="desktop"] { max-width: 560px; }
.osmm-pv-feed, .osmm-pv-chat, .osmm-pv-link, .osmm-pv-article {
  border: 1px solid var(--osmm-border);
  border-radius: 12px;
  background: var(--background-primary);
  overflow: hidden;
}
.osmm-pv-post { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.osmm-pv-post.is-reply { border-top: 1px solid var(--osmm-border); }
.osmm-pv-head { display: flex; align-items: center; gap: 8px; }
.osmm-pv-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--osmm-avatar);
  color: var(--osmm-badge-text);
  font-size: 11px;
  font-weight: 700;
}
.osmm-pv-avatar.is-round { border-radius: 50%; }
.osmm-pv-who { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.osmm-pv-handle, .osmm-pv-meta { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.osmm-pv-meta { margin-left: auto; }
.osmm-pv-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.osmm-pv-link, .osmm-pv-tag { color: var(--text-accent); }
.osmm-pv-more { align-self: flex-start; height: auto; padding: 0; background: transparent; box-shadow: none; color: var(--text-muted); }
.osmm-pv-media { display: grid; gap: 2px; border-radius: 10px; overflow: hidden; }
.osmm-pv-media:not([data-count="1"]) { grid-template-columns: 1fr 1fr; }
.osmm-pv-tile { min-height: 80px; background: var(--background-secondary); }
.osmm-pv-tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.osmm-pv-tile.is-missing { display: flex; align-items: center; justify-content: center; padding: 12px; color: var(--text-faint); font-size: var(--font-ui-smaller); }
.osmm-pv-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px;
  border: 1px solid var(--osmm-border);
  border-radius: 10px;
  color: var(--text-normal);
  text-decoration: none;
}
.osmm-pv-card-domain { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.osmm-pv-card-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osmm-pv-over { margin: 0; color: var(--text-error); font-family: var(--font-monospace); font-size: var(--font-ui-smaller); }
```

In `src/styles/index.css`, add after the existing imports:
```css
@import "./previews.css";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/previews && npm run typecheck`
Expected: PASS. The first run writes `test/previews/__snapshots__/model.test.ts.snap`; read it once to check each platform's model looks right (fold only on LinkedIn/Instagram/Facebook, crops on X, Instagram and Mastodon, no link card when an image is attached).

- [ ] **Step 6: Commit**

```bash
git add src/previews src/styles test/previews
git commit -m "feat(previews): add preview model and social feed previews (refs #43)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Chat, link and article previews (#44)

**Files:**
- Create: `src/previews/ChatPreview.svelte`, `src/previews/LinkPreview.svelte`, `src/previews/ArticlePreview.svelte`, `test/previews/blocks.test.ts`, `test/previews/otherLayouts.test.ts`
- Modify: `src/previews/model.ts` (article blocks, embed sources), `src/previews/PvText.svelte` (inline mode), `src/previews/Preview.svelte` (layout dispatch), `src/styles/previews.css`

**Interfaces:**
- Consumes: Task 6 model and primitives; `renderText` (Task 2); `extractEmbeds` (`src/model/body.ts`).
- Produces:
  - `type Block = heading | paragraph | list | quote | rule | image`, `articleBlocks(markdown: string, title?: string): Block[]` (a leading `# <title>` that repeats the title is dropped).
  - `PreviewInput.embedSrc?(target: string): string` and `PreviewModel.embeds?: Record<string, string>` — image sources for embeds inside an article body.
  - `<PvText segments inline?>` renders a `<span>` when `inline` is set (for headings and list items).
  - `<Preview>` now dispatches: `chat` → `ChatPreview` (Telegram channel post, Discord message, WhatsApp bubble), `link` → `LinkPreview` (HN, Reddit, Indie Hackers), `article` → `ArticlePreview` (neutral WordPress article), anything else → `FeedPreview`.

- [ ] **Step 1: Write the failing tests**

`test/previews/blocks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { articleBlocks } from "../../src/previews/model";

describe("articleBlocks", () => {
  it("parses headings, paragraphs, lists, quotes, rules and images", () => {
    const md = "# Title\n\nIntro with **bold** and [[Event X]].\nSecond line\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n![[cover.png]]\n%%hidden%%\n";
    expect(articleBlocks(md)).toEqual([
      { kind: "heading", level: 1, segments: [{ text: "Title" }] },
      { kind: "paragraph", segments: [{ text: "Intro with " }, { text: "bold", bold: true }, { text: " and Event X.\nSecond line" }] },
      { kind: "list", ordered: false, items: [[{ text: "one" }], [{ text: "two" }]] },
      { kind: "list", ordered: true, items: [[{ text: "first" }]] },
      { kind: "quote", segments: [{ text: "quote" }] },
      { kind: "rule" },
      { kind: "image", target: "cover.png" },
    ]);
  });

  it("drops a leading H1 that repeats the title", () => {
    expect(articleBlocks("# We're back\n\nHello", "We're back")).toEqual([{ kind: "paragraph", segments: [{ text: "Hello" }] }]);
    expect(articleBlocks("# Another\n\nHello", "We're back")[0]).toMatchObject({ kind: "heading" });
  });
});
```

`test/previews/otherLayouts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import Preview from "../../src/previews/Preview.svelte";
import { channel, img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("chat previews", () => {
  it("shows WhatsApp bold as bold (formatting differs per platform)", () => {
    const { container } = render(Preview, { props: { model: pv("whatsapp", "**Event X** at 18:00") } });
    expect(container.querySelector(".osmm-pv-chat strong")?.textContent).toBe("Event X");
    expect(container.textContent).not.toContain("*");
  });

  it("shows a Telegram channel post with its heading turned bold", () => {
    const tg = channel("tg/event-x", { name: "Event X channel", kind: "page" });
    const { container } = render(Preview, { props: { model: pv("telegram", "## Details\n**18:00**", {}, [], tg) } });
    expect(container.querySelector(".osmm-pv-channel")?.textContent).toBe("Event X channel");
    expect([...container.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(["Event X channel", "Details", "18:00"]);
  });

  it("shows a Discord message with its author", () => {
    const dc = channel("dc/maker-lab", { name: "Maker Lab #announcements", kind: "server_channel" });
    render(Preview, { props: { model: pv("discord", "@everyone Event X is on!", {}, [], dc) } });
    expect(screen.getByRole("figure", { name: "Discord preview" }).textContent).toContain("Maker Lab #announcements");
  });
});

describe("link previews", () => {
  it("shows a Hacker News submission with title and domain", () => {
    render(Preview, { props: { model: pv("hackernews", "", { title: "Show HN: OSMM", url: "https://www.example.com/osmm" }) } });
    expect(screen.getByRole("heading").textContent).toBe("Show HN: OSMM (example.com)");
    expect(screen.getByRole("figure").textContent).toContain("1 point by you");
  });

  it("shows the subreddit of a Reddit post", () => {
    const rd = channel("rd/side", { name: "Side projects", handle: "r/SideProject" });
    render(Preview, { props: { model: pv("reddit", "Text post body", { title: "Hello" }, [], rd) } });
    expect(screen.getByRole("figure").textContent).toContain("r/SideProject");
  });
});

describe("article preview", () => {
  it("renders a neutral WordPress article", () => {
    const site = channel("wp/eventx-berlin", { name: "eventx.berlin", kind: "site" });
    const body = "# We're back\n\nIntro **bold**\n\n## Agenda\n- talks\n- demos\n\n![[inline.png]]";
    const model = pv(
      "wordpress",
      body,
      { title: "We're back", wordpress: { categories: [], tags: [], excerpt: "Short intro" } },
      [],
      site,
      img("cover.png", 1600, 900, { alt: "Cover" }),
    );
    render(Preview, { props: { model } });
    expect(screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "We're back"],
      ["H3", "Agenda"],
    ]);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["talks", "demos"]);
    expect(screen.getByRole("img", { name: "Cover" }).getAttribute("src")).toBe("app://local/Social/cover.png");
    expect(screen.getByRole("img", { name: "inline.png is not shown" })).toBeTruthy();
    expect(screen.getByRole("figure").textContent).toContain("Short intro");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/previews`
Expected: FAIL — `articleBlocks` is not exported; chat, link and article layouts render as feeds.

- [ ] **Step 3: Add article blocks and embed sources to the model**

In `src/previews/model.ts`:
- change the first import to `import { countChars, extractEmbeds } from "../model/body";` and add `import { countFor, postItems, renderText, urlsIn } from "../platforms/text";` in place of the existing `../platforms/text` import.
- add to `interface PreviewModel`, after `excerpt?: string;`:
```ts
  /** Image sources for embeds in an article body, by link target ("" when unresolved). */
  embeds?: Record<string, string>;
```
- add to `interface PreviewInput`, after `resource(path: string): string;`:
```ts
  /** Resolves an embed in the body to an image source (article layout). */
  embedSrc?(target: string): string;
```
- in `previewModel`, before `return model;`, add:
```ts
  if (def.preview === "article") {
    model.embeds = Object.fromEntries(extractEmbeds(p.body).map((target) => [target, p.embedSrc?.(target) ?? ""]));
  }
```
- append at the end of the file:
```ts
export type Block =
  | { kind: "heading"; level: number; segments: Segment[] }
  | { kind: "paragraph"; segments: Segment[] }
  | { kind: "list"; ordered: boolean; items: Segment[][] }
  | { kind: "quote"; segments: Segment[] }
  | { kind: "rule" }
  | { kind: "image"; target: string };

const inline = (text: string): Segment[] => segments(renderText(text, "markdown"), "markdown");
const WIKI_IMAGE_RE = /^!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/;
const MD_IMAGE_RE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;

/** A small Markdown block parser for the neutral article preview (not a full CommonMark renderer). */
export function articleBlocks(markdown: string, title?: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Segment[][] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", segments: inline(para.join("\n")) });
    para = [];
  };
  const flush = () => {
    flushPara();
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  for (const raw of markdown.replace(/%%[\s\S]*?%%/g, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    let m: RegExpExecArray | null;
    if (!trimmed) {
      flush();
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ kind: "heading", level: m[1]!.length, segments: inline(m[2]!) });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if ((m = WIKI_IMAGE_RE.exec(trimmed) ?? MD_IMAGE_RE.exec(trimmed))) {
      flush();
      blocks.push({ kind: "image", target: m[1]!.trim() });
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const ordered = /\d/.test(m[1]!);
      flushPara();
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(inline(m[2]!));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      blocks.push({ kind: "quote", segments: inline(m[1]!) });
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  const first = blocks[0];
  const plain = (s: Segment[]) => s.map((x) => x.text).join("").trim();
  if (title && first?.kind === "heading" && first.level === 1 && plain(first.segments) === title.trim()) blocks.shift();
  return blocks;
}
```

- [ ] **Step 4: Write the layouts**

`src/previews/PvText.svelte` (replace the file):
```svelte
<script lang="ts">
  import type { Segment } from "./model";

  let { segments, inline = false }: { segments: Segment[]; inline?: boolean } = $props();
</script>

<svelte:element this={inline ? "span" : "p"} class="osmm-pv-text">{#each segments as s, i (i)}{#if s.href}<a class="osmm-pv-link" href={s.href} target="_blank" rel="noopener">{s.text}</a>{:else if s.tag}<span class="osmm-pv-tag">{s.text}</span>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else if s.strike}<s>{s.text}</s>{:else if s.code}<code>{s.text}</code>{:else}{s.text}{/if}{/each}</svelte:element>
```

`src/previews/ChatPreview.svelte`:
```svelte
<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvHeader from "./PvHeader.svelte";
  import PvLinkCard from "./PvLinkCard.svelte";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  const over = $derived(model.items.filter((i) => i.over));
</script>

<article class="osmm-pv-chat" data-platform={model.platform}>
  {#if model.platform === "discord"}<PvHeader author={model.author} meta="Today" />{/if}
  <div class="osmm-pv-bubble">
    {#if model.platform === "telegram"}<strong class="osmm-pv-channel">{model.author.name}</strong>{/if}
    <PvMedia media={model.media} />
    {#each model.items as item, i (i)}<PvText segments={item.segments} />{/each}
    {#if model.linkCard}<PvLinkCard card={model.linkCard} />{/if}
    <span class="osmm-pv-time">now</span>
  </div>
  {#each over as item, i (i)}<p class="osmm-pv-over" role="status">{item.chars}/{item.limit} characters</p>{/each}
</article>
```

`src/previews/LinkPreview.svelte`:
```svelte
<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
</script>

<article class="osmm-pv-link" data-platform={model.platform}>
  {#if model.platform === "reddit"}<div class="osmm-pv-sub">{model.author.handle ?? model.author.name} · posted by you</div>{/if}
  <h4 class="osmm-pv-title">{model.title ?? "Untitled"}{#if model.domain}{" "}<span class="osmm-pv-domain">({model.domain})</span>{/if}</h4>
  {#if model.platform === "hackernews"}<div class="osmm-pv-meta">1 point by you · just now</div>{/if}
  {#each model.items as item, i (i)}<PvText segments={item.segments} />{/each}
  <PvMedia media={model.media} />
</article>
```

`src/previews/ArticlePreview.svelte`:
```svelte
<script lang="ts">
  import { articleBlocks, type PreviewModel } from "./model";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  const blocks = $derived(articleBlocks(model.markdown, model.title));
</script>

<article class="osmm-pv-article">
  <div class="osmm-pv-site">{model.author.name}</div>
  {#if model.featured}<PvMedia media={[model.featured]} />{/if}
  <h1 class="osmm-pv-article-title">{model.title ?? "Untitled"}</h1>
  {#if model.excerpt}<p class="osmm-pv-excerpt">{model.excerpt}</p>{/if}
  {#each blocks as block, i (i)}
    {#if block.kind === "heading"}
      <svelte:element this={`h${Math.min(block.level + 1, 6)}`} class="osmm-pv-h"><PvText segments={block.segments} inline /></svelte:element>
    {:else if block.kind === "paragraph"}
      <PvText segments={block.segments} />
    {:else if block.kind === "list"}
      <svelte:element this={block.ordered ? "ol" : "ul"}>
        {#each block.items as item, j (j)}<li><PvText segments={item} inline /></li>{/each}
      </svelte:element>
    {:else if block.kind === "quote"}
      <blockquote><PvText segments={block.segments} /></blockquote>
    {:else if block.kind === "rule"}
      <hr />
    {:else if model.embeds?.[block.target]}
      <img class="osmm-pv-inline-img" src={model.embeds[block.target]} alt="" />
    {:else}
      <div class="osmm-pv-tile is-missing" role="img" aria-label={`${block.target} is not shown`}>{block.target}</div>
    {/if}
  {/each}
</article>
```

`src/previews/Preview.svelte` (replace the file):
```svelte
<script lang="ts">
  import type { PreviewModel } from "./model";
  import ArticlePreview from "./ArticlePreview.svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import FeedPreview from "./FeedPreview.svelte";
  import LinkPreview from "./LinkPreview.svelte";

  let { model, width = "mobile" }: { model: PreviewModel; width?: "mobile" | "desktop" } = $props();
</script>

<figure class="osmm-preview" data-width={width} data-platform={model.platform} aria-label={`${model.label} preview`}>
  {#if model.layout === "chat"}
    <ChatPreview {model} />
  {:else if model.layout === "link"}
    <LinkPreview {model} />
  {:else if model.layout === "article"}
    <ArticlePreview {model} />
  {:else}
    <FeedPreview {model} />
  {/if}
</figure>
```

Append to `src/styles/previews.css`:
```css
.osmm-pv-chat { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--background-secondary); }
.osmm-pv-bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 90%;
  padding: 8px 10px;
  border-radius: 12px 12px 12px 4px;
  background: var(--background-primary);
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.08);
}
.osmm-pv-chat[data-platform="whatsapp"] .osmm-pv-bubble { align-self: flex-end; border-radius: 12px 12px 4px 12px; background: rgba(var(--color-green-rgb), 0.18); }
.osmm-pv-chat[data-platform="discord"] .osmm-pv-bubble { max-width: none; padding: 0 0 0 40px; background: transparent; box-shadow: none; }
.osmm-pv-channel { color: var(--text-accent); }
.osmm-pv-time { align-self: flex-end; color: var(--text-faint); font-size: 10.5px; }
.osmm-pv-link { display: flex; flex-direction: column; gap: 6px; padding: 12px; }
.osmm-pv-title { margin: 0; font-size: var(--font-ui-medium); }
.osmm-pv-domain, .osmm-pv-sub { color: var(--text-muted); font-size: var(--font-ui-smaller); font-weight: normal; }
.osmm-pv-link[data-platform="hackernews"] { border-top: 3px solid var(--color-orange); }
.osmm-pv-article { display: flex; flex-direction: column; gap: 10px; padding: 16px; font-family: var(--font-text); }
.osmm-pv-site { color: var(--text-muted); font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.06em; }
.osmm-pv-article-title { margin: 0; font-size: 1.5em; line-height: 1.2; }
.osmm-pv-excerpt { margin: 0; color: var(--text-muted); font-style: italic; }
.osmm-pv-h { margin: 6px 0 0; }
.osmm-pv-inline-img { max-width: 100%; border-radius: 6px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/previews && npm run typecheck`
Expected: PASS (Task 6 tests and snapshots unchanged: `embeds` is only set for articles).

- [ ] **Step 6: Commit**

```bash
git add src/previews src/styles/previews.css test/previews
git commit -m "feat(previews): add chat, link and article previews (refs #44)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: All-platform preview grid and the composer service (#46)

**Files:**
- Create: `src/composer/content.ts`, `src/composer/actions.ts`, `src/previews/PreviewGrid.svelte`, `src/previews/PreviewGridView.ts`, `src/styles/composer.css`, `test/previews/grid.test.ts`
- Modify: `src/ui/actions.ts` (view ids, public `write`/`afterWrite`, `actionNotice`), `src/ui/context.ts` (`composer`), `src/planner/status.ts` (`VARIANT_STATUS_LABEL`), `src/views/CampaignTable.svelte` ("Preview all"), `src/main.ts`, `src/commands.ts`, `src/styles/index.css`, `test/ui/ctx.ts`, `test/commands.test.ts`, `test/fakes/obsidian.ts` (view state)

**Interfaces:**
- Consumes: `validateAll`, `blocking`, `counters` (Tasks 3–4); `previewModel` (Tasks 6–7); `MediaInspector` (Task 5); `AdapterRegistry`, `platformDef` (Task 1); `scheduleDeliveries` (`src/planner/board.ts`); `deliveryChanges`, `WriteRecord` (`src/planner/changes.ts`).
- Produces:
  - `VIEW_COMPOSER = "osmm-composer"`, `VIEW_PREVIEW_GRID = "osmm-preview-grid"` (in `src/ui/actions.ts`).
  - `PlannerActions.write(file, plan): Promise<WriteResult>` and `PlannerActions.afterWrite(result, message): void` are now **public**; `export type WriteResult = { ok: true; record: WriteRecord } | { ok: false; reason: string }`; `PlannerActions.actionNotice(message, label, run): void` (a Notice with one button; `undoNotice` uses it).
  - `interface LoadedContent { body: string; media: MediaInfo[]; featured?: MediaInfo }`, `class ContentLoader { body(v); load(v): Promise<LoadedContent> }`.
  - `interface ComposerDeps { app; writer; factory; channels; index; planner: PlannerActions; adapters: AdapterRegistry; settings(); now() }`, `interface CardAction { label; icon; run(v) }`, `class ComposerActions { media; content; cardActions; channelsOf(v); check(v, content): Issue[]; counters(v, content, channel?): Counter[]; preview(v, content, channel?): PreviewModel; approveReady(variants): Promise<{ approved; skipped }>; openPreviewGrid(campaignPath); previewActiveCampaign(checking): boolean }`.
  - `OsmmContext.composer: ComposerActions`; `makeCtx()` builds it.
  - `VARIANT_STATUS_LABEL: Record<VariantStatus, string>`.
  - `class PreviewGridView` (view state `{ campaignPath }`), `<PreviewGrid campaign: Readable<string | null>>`; command `preview-campaign`; "Preview all" button in the `social-variants` table.
  - Fake: `ItemView.setState/getState`; `WorkspaceLeaf.setViewState({ type, active?, state? })` keeps the view when the type is unchanged and passes `state` to `view.setState`.

- [ ] **Step 1: Write the failing tests**

`test/previews/grid.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { Notice } from "../fakes/obsidian";
import PreviewGrid from "../../src/previews/PreviewGrid.svelte";
import { PreviewGridView } from "../../src/previews/PreviewGridView";
import { VIEW_PREVIEW_GRID } from "../../src/ui/actions";
import { osmmContext } from "../../src/ui/context";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const CAMPAIGN = "Social/Event X/Event X.md";
const ready = (name: string, platform: string, channel: string, body: string, when = "2026-10-20T09:00:00+02:00") => ({
  path: `Social/Event X/Event X – ${name}.md`,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform, channels: [channel], status: "ready", scheduled_at: when },
  body,
});

describe("PreviewGrid", () => {
  it("shows every variant of the campaign side by side, 12+ included", async () => {
    const extra = [
      ready("Mastodon", "mastodon", "ma/you", "Toot"),
      ready("Facebook", "facebook", "fb/event-x-berlin", "Hello Facebook"),
      ready("WhatsApp", "whatsapp", "wa/makers-berlin", "*Event X* tonight"),
      ready("Discord 2", "discord", "dc/maker-lab", "Doors open at 18:00"),
    ];
    const { ctx } = await makeCtx({ seed: true, notes: extra });
    render(PreviewGrid, { props: { campaign: readable(CAMPAIGN) }, context: osmmContext(ctx) });
    await vi.waitFor(() => expect(screen.getAllByRole("figure")).toHaveLength(13));
    expect(screen.getAllByRole("region", { name: /variant$/ })).toHaveLength(13);
    expect(screen.getByText(/^13 variants/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Instagram variant" }).textContent).toContain("event-x-cover.png was not found in the vault.");
    expect(screen.getByRole("button", { name: "Approve all ready (4)" })).toBeTruthy();
  });

  it("approves ready variants without blocking issues and offers undo", async () => {
    const good = ready("Mastodon", "mastodon", "ma/you", "Toot");
    const bad = ready("X 2", "x", "x/you", "a".repeat(300));
    const { ctx, index } = await makeCtx({ seed: true, notes: [good, bad] });
    expect(await ctx.composer.approveReady(index.variantsOf(CAMPAIGN))).toEqual({ approved: 1, skipped: 1 });
    await indexed(index, () => index.getVariant(good.path)?.status === "scheduled");
    expect(index.getVariant(good.path)?.deliveries).toEqual({ "ma/you": { status: "scheduled" } });
    expect(index.getVariant(bad.path)?.status).toBe("ready");
    expect(Notice.messages.at(-1)).toBe("Approved 1 post. Skipped 1 with blocking issues, no channel, or no future time. Undo");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => index.getVariant(good.path)?.status === "ready");
    expect(index.getVariant(good.path)?.deliveries).toEqual({});
  });

  it("opens from the campaign table with the campaign as view state", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    app.workspace.viewFactories.set(VIEW_PREVIEW_GRID, (leaf) => new PreviewGridView(leaf as never, ctx) as never);
    render(CampaignTable, { props: { campaignPath: CAMPAIGN }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Preview all" }));
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType(VIEW_PREVIEW_GRID)).toHaveLength(1));
    const view = app.workspace.getLeavesOfType(VIEW_PREVIEW_GRID)[0]!.view as unknown as PreviewGridView;
    expect(view.getState()).toEqual({ campaignPath: CAMPAIGN });
    await vi.waitFor(() => expect(view.contentEl.querySelectorAll("figure")).toHaveLength(9));
  });
});
```

In `test/commands.test.ts`, change the first test's expectation to:
```ts
    expect(ids).toEqual(["open-planner", "open-board", "open-sidebar", "new-campaign", "new-post", "new-variant-for-campaign", "preview-campaign"]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/previews/grid.test.ts test/commands.test.ts`
Expected: FAIL — `PreviewGrid.svelte` missing; `ctx.composer` undefined; command list differs.

- [ ] **Step 3: Extend the fake with view state**

In `test/fakes/obsidian.ts`:
- replace `WorkspaceLeaf.setViewState` with:
```ts
  async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
    if (!this.view || this.viewType !== state.type) {
      await this.view?.onClose();
      this.viewType = state.type;
      const factory = this.app.workspace.viewFactories.get(state.type);
      this.view = factory ? factory(this) : null;
      if (this.view) await this.view.onOpen();
    }
    if (this.view && state.state !== undefined) await this.view.setState(state.state, { history: false });
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
  }
```
- add to `class ItemView`, after `getIcon()`:
```ts
  async setState(_state: unknown, _result: { history: boolean }): Promise<void> {}
  getState(): Record<string, unknown> {
    return {};
  }
```

- [ ] **Step 4: Open up PlannerActions**

In `src/ui/actions.ts`:
- after `export const VIEW_SIDEBAR = "osmm-sidebar";` add:
```ts
export const VIEW_COMPOSER = "osmm-composer";
export const VIEW_PREVIEW_GRID = "osmm-preview-grid";
```
- change `type WriteResult = …` to `export type WriteResult = { ok: true; record: WriteRecord } | { ok: false; reason: string };`
- replace `undoNotice` with:
```ts
  /** A notice with one action button (Undo, Open, …); clicking it runs the action and hides the notice. */
  actionNotice(message: string, label: string, run: () => unknown): void {
    const fragment = document.createDocumentFragment();
    const text = document.createElement("span");
    text.textContent = `${message} `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    fragment.append(text, button);
    const notice = new Notice(fragment, 8000);
    button.addEventListener("click", () => {
      void run();
      notice.hide();
    });
  }

  undoNotice(message: string, undo: () => unknown): void {
    this.actionNotice(message, "Undo", undo);
  }
```
- change `private async write(file: TFile, plan: VariantPlan): Promise<WriteResult> {` to `async write(file: TFile, plan: VariantPlan): Promise<WriteResult> {`
- change `private afterWrite(result: WriteResult, message: string): void {` to `afterWrite(result: WriteResult, message: string): void {`

In `src/planner/status.ts`, change the types import to `import type { Channel, VariantStatus } from "../model/types";` and add:
```ts
export const VARIANT_STATUS_LABEL: Readonly<Record<VariantStatus, string>> = {
  idea: "Idea",
  draft: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  partial: "Partly published",
  published: "Published",
  overdue: "Overdue",
  attention: "Needs attention",
  skipped: "Skipped",
};
```

- [ ] **Step 5: Write the content loader and the composer service**

`src/composer/content.ts`:
```ts
import type { App } from "obsidian";
import type { IndexedVariant } from "../index/socialIndex";
import { bodyOf } from "../model/body";
import type { MediaInspector } from "../media/mediaInfo";
import type { MediaInfo } from "../platforms/types";

export interface LoadedContent {
  body: string;
  media: MediaInfo[];
  featured?: MediaInfo;
}

/** Reads what checks and previews need from a variant note: its body and its resolved media. */
export class ContentLoader {
  constructor(
    private readonly app: App,
    private readonly media: MediaInspector,
  ) {}

  async body(v: Pick<IndexedVariant, "file">): Promise<string> {
    return bodyOf(await this.app.vault.cachedRead(v.file));
  }

  async load(v: IndexedVariant): Promise<LoadedContent> {
    const [body, media] = await Promise.all([this.body(v), this.media.inspect(v)]);
    const target = v.wordpress?.featuredImage;
    if (!target) return { body, media };
    const [featured] = await this.media.inspect({ path: v.path, media: [target], mediaMeta: v.mediaMeta });
    return { body, media, featured };
  }
}
```

`src/composer/actions.ts`:
```ts
import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import type { Channel, Issue, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import { MediaInspector } from "../media/mediaInfo";
import { scheduleDeliveries } from "../planner/board";
import { deliveryChanges, type WriteRecord } from "../planner/changes";
import { blocking, counters, validateAll, type Counter } from "../platforms/checks";
import { platformDef, type AdapterRegistry } from "../platforms/registry";
import { previewModel, type PreviewModel } from "../previews/model";
import type { OsmmSettings } from "../settings/settings";
import { VIEW_PREVIEW_GRID, type PlannerActions } from "../ui/actions";
import { ContentLoader, type LoadedContent } from "./content";

export interface ComposerDeps {
  app: App;
  writer: SafeWriter;
  factory: NoteFactory;
  channels: ChannelRegistry;
  index: SocialIndex;
  planner: PlannerActions;
  adapters: AdapterRegistry;
  settings(): OsmmSettings;
  now(): number;
}

export interface CardAction {
  label: string;
  icon: string;
  run(v: IndexedVariant): void;
}

/** Side effects of the preview grid and the composer; writes go through PlannerActions.write (fresh frontmatter, undo). */
export class ComposerActions {
  readonly media: MediaInspector;
  readonly content: ContentLoader;
  /** Extra buttons on each preview-grid card. M4 adds "Trim with Claude" here; empty in M2. */
  readonly cardActions: CardAction[] = [];

  constructor(protected readonly deps: ComposerDeps) {
    this.media = new MediaInspector(deps.app);
    this.content = new ContentLoader(deps.app, this.media);
  }

  channelsOf(v: Pick<Variant, "channels">): Channel[] {
    return v.channels.map((id) => this.deps.channels.get(id)).filter((c): c is Channel => c !== undefined);
  }

  check(v: Variant, content: LoadedContent): Issue[] {
    return validateAll({ variant: v, body: content.body, media: content.media }, this.channelsOf(v));
  }

  counters(v: Variant, content: LoadedContent, channel?: Channel): Counter[] {
    return counters({ variant: v, body: content.body, media: content.media }, platformDef(v.platform), channel ?? this.channelsOf(v)[0]);
  }

  preview(v: Variant, content: LoadedContent, channel?: Channel): PreviewModel {
    return previewModel({
      def: platformDef(v.platform),
      variant: v,
      body: content.body,
      media: content.media,
      featured: content.featured,
      channel: channel ?? this.channelsOf(v)[0],
      resource: (path) => this.media.resourceUrl(path),
      embedSrc: (target) => {
        const file = this.media.resolve(target, v.path);
        return file ? this.media.resourceUrl(file.path) : "";
      },
    });
  }

  /** Ready → Scheduled for every ready variant that has channels, a future time and no blocking issue. */
  async approveReady(variants: readonly IndexedVariant[]): Promise<{ approved: number; skipped: number }> {
    const records: WriteRecord[] = [];
    let skipped = 0;
    const now = this.deps.now();
    for (const v of variants.filter((x) => x.status === "ready")) {
      if (blocking(this.check(v, await this.content.load(v)))) {
        skipped++;
        continue;
      }
      const result = await this.deps.planner.write(v.file, (fresh) => {
        if (fresh.status !== "ready") return { refuse: "The post changed since." };
        if (!fresh.channels.length || fresh.scheduledAt === undefined || fresh.scheduledAt < now) return { refuse: "No channel or no future time." };
        return { deliveries: deliveryChanges(fresh, scheduleDeliveries(fresh)) };
      });
      if (result.ok) records.push(result.record);
      else skipped++;
    }
    const n = records.length;
    const summary = `Approved ${n} post${n === 1 ? "" : "s"}.${skipped ? ` Skipped ${skipped} with blocking issues, no channel, or no future time.` : ""}`;
    if (n) this.deps.planner.undoNotice(summary, () => this.deps.planner.undo(records));
    else new Notice(summary);
    return { approved: n, skipped };
  }

  async openPreviewGrid(campaignPath: string): Promise<void> {
    const { workspace } = this.deps.app;
    const leaf = workspace.getLeavesOfType(VIEW_PREVIEW_GRID)[0] ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_PREVIEW_GRID, active: true, state: { campaignPath } });
    await workspace.revealLeaf(leaf);
  }

  /** Command check callback: available when the active note is an indexed campaign. */
  previewActiveCampaign(checking: boolean): boolean {
    const file = this.deps.app.workspace.getActiveFile();
    const campaign = file ? this.deps.index.getCampaign(file.path) : undefined;
    if (!campaign) return false;
    if (!checking) void this.openPreviewGrid(campaign.path);
    return true;
  }
}
```

In `src/ui/context.ts`, add `import type { ComposerActions } from "../composer/actions";` and the field `composer: ComposerActions;` to `OsmmContext` (after `actions`).

In `test/ui/ctx.ts`:
- add imports `import { ComposerActions } from "../../src/composer/actions";` and `import { AdapterRegistry } from "../../src/platforms/registry";`
- after the `actions` constant, add:
```ts
  const composer = new ComposerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    planner: actions,
    adapters: new AdapterRegistry(),
    settings: () => get(settings),
    now: () => get(nowStore),
  });
```
- add `composer,` to the `ctx` object literal (after `actions,`).

- [ ] **Step 6: Write the grid and its view**

`src/previews/PreviewGrid.svelte`:
```svelte
<script lang="ts">
  import type { Readable } from "svelte/store";
  import type { LoadedContent } from "../composer/content";
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { VARIANT_STATUS_LABEL } from "../planner/status";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import Preview from "./Preview.svelte";

  let { campaign }: { campaign: Readable<string | null> } = $props();
  const { snapshot, composer, actions } = useOsmm();

  let path = $state<string | null>(null);
  $effect(() => campaign.subscribe((p) => (path = p)));

  const byPlatform = (a: IndexedVariant, b: IndexedVariant) =>
    PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.path.localeCompare(b.path);
  const title = $derived($snapshot.campaigns.find((c) => c.path === path)?.title ?? "Campaign");
  const variants = $derived(path ? $snapshot.variants.filter((v) => v.campaignPath === path).sort(byPlatform) : []);

  let loaded = $state(new Map<string, LoadedContent>());
  $effect(() => {
    const list = variants;
    let cancelled = false;
    void Promise.all(list.map(async (v) => [v.path, await composer.content.load(v)] as const)).then((entries) => {
      if (!cancelled) loaded = new Map(entries);
    });
    return () => {
      cancelled = true;
    };
  });

  const cards = $derived(
    variants.map((v) => {
      const content = loaded.get(v.path);
      return content
        ? { v, issues: composer.check(v, content), counters: composer.counters(v, content), model: composer.preview(v, content) }
        : { v, issues: [], counters: [], model: null };
    }),
  );
  const blocked = $derived(cards.filter((c) => c.issues.some((i) => i.level === "error")).length);
  const warnings = $derived(cards.reduce((n, c) => n + c.issues.filter((i) => i.level === "warning").length, 0));
  const ready = $derived(variants.filter((v) => v.status === "ready"));
</script>

<div class="osmm-grid-view">
  <header class="osmm-toolbar">
    <h2 class="osmm-title">{title}</h2>
    <span class="osmm-progress">{variants.length} variants · {blocked} blocked · {warnings} warnings</span>
    <span class="osmm-spacer"></span>
    <button type="button" class="mod-cta" disabled={ready.length === 0} onclick={() => void composer.approveReady(ready)}>Approve all ready ({ready.length})</button>
  </header>
  {#if !path}
    <p class="osmm-empty">Open a campaign to preview its variants.</p>
  {:else if !variants.length}
    <p class="osmm-empty">This campaign has no variants yet.</p>
  {/if}
  <div class="osmm-grid">
    {#each cards as card (card.v.path)}
      <section class="osmm-grid-card" aria-label={`${PLATFORM_META[card.v.platform].label} variant`}>
        <header class="osmm-row">
          <PlatformBadge platform={card.v.platform} size="md" />
          <strong class="osmm-row-title">{PLATFORM_META[card.v.platform].label}</strong>
          <span class="osmm-pill-status">{VARIANT_STATUS_LABEL[card.v.status]}</span>
        </header>
        <div class="osmm-grid-counters">
          {#each card.counters as c (c.label)}
            <span class="osmm-progress" class:is-over={c.value > c.limit && c.label !== "Fold"}>{c.label} {c.value.toLocaleString()}/{c.limit.toLocaleString()}</span>
          {/each}
        </div>
        {#if card.issues.length}
          <ul class="osmm-issue-list">
            {#each card.issues as issue, i (i)}<li class={issue.level === "error" ? "is-error" : "is-warning"}>{issue.message}</li>{/each}
          </ul>
        {/if}
        {#if card.model}<Preview model={card.model} />{:else}<p class="osmm-progress">Loading…</p>{/if}
        <footer class="osmm-row">
          <button type="button" onclick={() => actions.openNote(card.v.path)}>Open note</button>
          {#each composer.cardActions as action (action.label)}<button type="button" onclick={() => action.run(card.v)}>{action.label}</button>{/each}
        </footer>
      </section>
    {/each}
  </div>
</div>
```

`src/previews/PreviewGridView.ts`:
```ts
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { get, writable } from "svelte/store";
import { isRecord } from "../model/frontmatter";
import { VIEW_PREVIEW_GRID } from "../ui/actions";
import { osmmContext, type OsmmContext } from "../ui/context";
import { mountSvelte, type Mounted } from "../ui/mount";
import PreviewGrid from "./PreviewGrid.svelte";

/** All-platform preview (artboard 5). View state: `{ campaignPath }`. */
export class PreviewGridView extends ItemView {
  private mounted: Mounted | null = null;
  private readonly campaign = writable<string | null>(null);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_PREVIEW_GRID;
  }

  getDisplayText(): string {
    return "All-platform preview";
  }

  override getIcon(): string {
    return "layout-grid";
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isRecord(state) && typeof state.campaignPath === "string") this.campaign.set(state.campaignPath);
    await super.setState(state, result);
  }

  override getState(): Record<string, unknown> {
    return { campaignPath: get(this.campaign) };
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(this.contentEl, PreviewGrid, { campaign: this.campaign }, osmmContext(this.ctx));
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
```

`src/styles/composer.css`:
```css
.osmm-grid-view { display: flex; flex-direction: column; height: 100%; }
.osmm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  align-items: start;
  padding: 0 16px 16px;
  overflow: auto;
}
.osmm-grid-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--osmm-border);
  border-radius: 12px;
  background: var(--background-secondary);
}
.osmm-grid-counters { display: flex; flex-wrap: wrap; gap: 8px; }
.osmm-progress.is-over { color: var(--text-error); }
.osmm-issue-list { margin: 0; padding-left: 18px; font-size: var(--font-ui-smaller); }
.osmm-issue-list .is-error { color: var(--text-error); }
.osmm-issue-list .is-warning { color: var(--text-warning); }
.osmm-empty { padding: 16px; color: var(--text-muted); }
```

In `src/styles/index.css`, add `@import "./composer.css";` after the previews import.

- [ ] **Step 7: Wire the plugin, the command and the campaign table**

In `src/main.ts`:
- add imports:
```ts
import { ComposerActions } from "./composer/actions";
import { AdapterRegistry } from "./platforms/registry";
import { PreviewGridView } from "./previews/PreviewGridView";
```
  and add `VIEW_PREVIEW_GRID` to the `./ui/actions` import.
- add the field `readonly adapters = new AdapterRegistry();` after `index!: SocialIndex;`.
- after `this.registerView(VIEW_SIDEBAR, …);` add:
```ts
    this.registerView(VIEW_PREVIEW_GRID, (leaf) => new PreviewGridView(leaf, this.uiContext()));
```
- replace `uiContext()` with:
```ts
  uiContext(): OsmmContext {
    if (!this.ui) {
      const actions = new PlannerActions({
        app: this.app,
        writer: this.writer,
        factory: this.factory,
        channels: this.channels,
        index: this.index,
        settings: () => this.settings,
        now: () => Date.now(),
      });
      const composer = new ComposerActions({
        app: this.app,
        writer: this.writer,
        factory: this.factory,
        channels: this.channels,
        index: this.index,
        planner: actions,
        adapters: this.adapters,
        settings: () => this.settings,
        now: () => Date.now(),
      });
      this.ui = {
        app: this.app,
        settings: this.settingsStore,
        snapshot: indexStore(this.index),
        now: clock(30_000),
        viewState: viewStateStore(this.app),
        channels: this.channels,
        actions,
        composer,
      };
      actions.context = this.ui;
    }
    return this.ui;
  }
```

In `src/commands.ts`, add at the end of `registerCommands`:
```ts
  plugin.addCommand({
    id: "preview-campaign",
    name: "Preview all variants of this campaign",
    checkCallback: (checking) => plugin.uiContext().composer.previewActiveCampaign(checking),
  });
```

In `src/views/CampaignTable.svelte`:
- change `const { snapshot, settings, actions } = useOsmm();` to `const { snapshot, settings, actions, composer } = useOsmm();`
- in the header, before the "Apply schedule template" button, add:
```svelte
    <button type="button" onclick={() => void composer.openPreviewGrid(campaignPath)}>Preview all</button>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (whole suite: `ctx.composer` now exists everywhere `makeCtx` is used).

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat(previews): add the all-platform preview grid with Approve all ready (refs #46)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Composer view shell — editor, live preview, platform tabs (#48)

**Files:**
- Create: `src/composer/session.ts`, `src/composer/ComposerView.ts`, `src/composer/Composer.svelte`, `test/composer/shell.test.ts`
- Modify: `src/composer/actions.ts` (`session`, `openComposer`, `composeActiveNote`), `src/main.ts`, `src/commands.ts`, `src/views/CampaignTable.svelte` ("Compose"), `src/previews/PreviewGrid.svelte` ("Compose"), `src/styles/composer.css`, `test/fakes/obsidian.ts` (`WorkspaceLeaf.openFile`), `test/commands.test.ts`

**Interfaces:**
- Consumes: `ComposerActions` (Task 8), `Preview` (Tasks 6–7), `bodyOf` (`src/model/body.ts`), `VIEW_COMPOSER` (Task 8).
- Produces:
  - `interface ComposerSession { path: Writable<string | null>; body: Readable<string>; dispose(): void }`, `composerSession(app, index, debounceMs = 100): ComposerSession` — the body comes from the vault, and from Obsidian's editor buffer (`editor-change`, debounced 100 ms) while the user types; a read that finishes after a newer one is dropped.
  - `ComposerActions.session(): ComposerSession`, `ComposerActions.openComposer(path): Promise<void>` (opens the note in the editor leaf and the composer in a split next to it, reusing an open composer), `ComposerActions.composeActiveNote(checking): boolean`.
  - `class ComposerView` (`VIEW_COMPOSER`, view state `{ path }`, `editorLeaf: WorkspaceLeaf | null`, `showVariant(path)`).
  - `<Composer session openVariant>` — platform tabs (campaign siblings), preview with a "Preview as" channel picker and Mobile/Desktop toggle, and an `<aside class="osmm-composer-side" aria-label="Composer panels">` that Tasks 10–14 fill (each adds its panel right before `</aside>`).
  - Command `open-composer` ("Open composer for this post"); "Compose" buttons in the campaign table and the preview grid.
  - Fake: `WorkspaceLeaf.file` and `WorkspaceLeaf.openFile(file)`.

- [ ] **Step 1: Write the failing tests**

`test/composer/shell.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { WorkspaceLeaf } from "../fakes/obsidian";
import { ComposerView } from "../../src/composer/ComposerView";
import { composerSession } from "../../src/composer/session";
import { VIEW_COMPOSER } from "../../src/ui/actions";
import { settle, writeNote } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const BS = "Social/Event X/Event X – Bluesky.md";

function register(c: TestCtx): void {
  c.app.workspace.viewFactories.set(VIEW_COMPOSER, (leaf) => new ComposerView(leaf as never, c.ctx) as never);
}

async function openView(c: TestCtx, path: string): Promise<ComposerView> {
  register(c);
  const leaf = new WorkspaceLeaf(c.app);
  await leaf.setViewState({ type: VIEW_COMPOSER, state: { path } });
  return leaf.view as unknown as ComposerView;
}

describe("Composer shell", () => {
  it("previews the note and updates within 150 ms of typing", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, BS);
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Event X is back on the 12th"));
    const file = c.app.vault.getFileByPath(BS)!;
    c.app.workspace.trigger("editor-change", { getValue: () => "---\ntype: social-post\n---\nFresh words from the editor" }, { file });
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Fresh words from the editor"), { timeout: 150, interval: 5 });
  });

  it("ignores typing in other notes", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, BS);
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Event X is back on the 12th"));
    c.app.workspace.trigger("editor-change", { getValue: () => "Other note" }, { file: c.app.vault.getFileByPath(LI) });
    await settle(130);
    expect(view.contentEl.textContent).not.toContain("Other note");
  });

  it("falls back gracefully for a note that is not a social post", async () => {
    const c = await makeCtx({ seed: true });
    await writeNote(c.app as never, "Notes/Plain.md", { title: "Just a note" }, "Hello");
    const view = await openView(c, "Notes/Plain.md");
    expect(view.contentEl.textContent).toContain("Open a social post note to compose it here.");
  });

  it("shows a tab per campaign variant and switches the note in the editor", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, LI);
    const editor = new WorkspaceLeaf(c.app);
    view.editorLeaf = editor as never;
    const tabs = within(view.contentEl).getAllByRole("tab");
    expect(tabs).toHaveLength(9);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual(["inLinkedIn"]);
    await fireEvent.click(tabs.find((t) => t.textContent?.includes("Bluesky"))!);
    await vi.waitFor(() => expect(view.getState()).toEqual({ path: BS }));
    expect(editor.file?.path).toBe(BS);
  });

  it("keeps the newest note's body when switching quickly", async () => {
    const c = await makeCtx({ seed: true });
    const read = c.app.vault.cachedRead.bind(c.app.vault);
    vi.spyOn(c.app.vault, "cachedRead").mockImplementation(async (file) => {
      if (file.path === LI) await settle(30);
      return read(file);
    });
    const session = composerSession(c.app as never, c.index);
    session.path.set(LI);
    session.path.set(BS);
    await settle(60);
    expect(get(session.body)).toContain("Event X is back on the 12th");
    session.dispose();
  });

  it("opens next to the active post from the command", async () => {
    const c = await makeCtx({ seed: true });
    register(c);
    c.app.workspace.activeFile = c.app.vault.getFileByPath(BS);
    expect(c.ctx.composer.composeActiveNote(true)).toBe(true);
    c.ctx.composer.composeActiveNote(false);
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType(VIEW_COMPOSER)).toHaveLength(1));
    const view = c.app.workspace.getLeavesOfType(VIEW_COMPOSER)[0]!.view as unknown as ComposerView;
    expect(view.getState()).toEqual({ path: BS });
    expect((view.editorLeaf as unknown as WorkspaceLeaf).file?.path).toBe(BS);
    c.app.workspace.activeFile = c.app.vault.getFileByPath("Social/Event X/Event X.md");
    expect(c.ctx.composer.composeActiveNote(true)).toBe(false);
  });
});
```

In `test/commands.test.ts`, change the first expectation to:
```ts
    expect(ids).toEqual(["open-planner", "open-board", "open-sidebar", "new-campaign", "new-post", "new-variant-for-campaign", "preview-campaign", "open-composer"]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/composer/shell.test.ts test/commands.test.ts`
Expected: FAIL — `ComposerView` and `session` modules missing.

- [ ] **Step 3: Extend the fake leaf**

In `test/fakes/obsidian.ts`, in `class WorkspaceLeaf`, add after `viewType: string | null = null;`:
```ts
  file: TFile | null = null;
```
and after `setViewState`:
```ts
  async openFile(file: TFile): Promise<void> {
    this.file = file;
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
  }
```

- [ ] **Step 4: Write the session and the view**

`src/composer/session.ts`:
```ts
import type { App, Editor, MarkdownFileInfo, MarkdownView } from "obsidian";
import { writable, type Readable, type Writable } from "svelte/store";
import type { SocialIndex } from "../index/socialIndex";
import { bodyOf } from "../model/body";

export interface ComposerSession {
  path: Writable<string | null>;
  body: Readable<string>;
  dispose(): void;
}

/**
 * The body the composer previews: read from the vault when the note changes, and taken from the
 * editor buffer (debounced) while the user types, so the preview follows keystrokes, not saves.
 */
export function composerSession(app: App, index: SocialIndex, debounceMs = 100): ComposerSession {
  const path = writable<string | null>(null);
  const body = writable("");
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;

  const load = async (): Promise<void> => {
    const mine = ++token;
    const file = current ? app.vault.getFileByPath(current) : null;
    const text = file ? bodyOf(await app.vault.cachedRead(file)) : "";
    if (mine === token) body.set(text);
  };

  const unsubscribe = path.subscribe((p) => {
    current = p;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void load();
  });

  const ref = app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
    if (!current || info.file?.path !== current) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      token++; // a vault read still in flight must not overwrite what was just typed
      body.set(bodyOf(editor.getValue()));
    }, debounceMs);
  });

  const offIndex = index.onChange((change) => {
    if (current && timer === null && change.changed.includes(current)) void load();
  });

  return {
    path,
    body,
    dispose() {
      unsubscribe();
      app.workspace.offref(ref);
      offIndex();
      if (timer) clearTimeout(timer);
    },
  };
}
```

`src/composer/ComposerView.ts`:
```ts
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { get } from "svelte/store";
import { isRecord } from "../model/frontmatter";
import { VIEW_COMPOSER } from "../ui/actions";
import { osmmContext, type OsmmContext } from "../ui/context";
import { mountSvelte, type Mounted } from "../ui/mount";
import Composer from "./Composer.svelte";
import type { ComposerSession } from "./session";

/** Composer (artboard 3), opened in a split next to Obsidian's own editor. View state: `{ path }`. */
export class ComposerView extends ItemView {
  private mounted: Mounted | null = null;
  private session: ComposerSession | null = null;
  /** The Markdown leaf the composer sits next to; platform tabs open sibling notes there. */
  editorLeaf: WorkspaceLeaf | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_COMPOSER;
  }

  getDisplayText(): string {
    return "Composer";
  }

  override getIcon(): string {
    return "pencil-line";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.session = this.ctx.composer.session();
    this.mounted = mountSvelte(
      this.contentEl,
      Composer,
      { session: this.session, openVariant: (path: string) => void this.showVariant(path) },
      osmmContext(this.ctx),
    );
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isRecord(state) && typeof state.path === "string") this.session?.path.set(state.path);
    await super.setState(state, result);
  }

  override getState(): Record<string, unknown> {
    return { path: this.session ? get(this.session.path) : null };
  }

  async showVariant(path: string): Promise<void> {
    this.session?.path.set(path);
    const file = this.app.vault.getFileByPath(path);
    if (file && this.editorLeaf) await this.editorLeaf.openFile(file);
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
    this.session?.dispose();
    this.session = null;
  }
}
```

In `src/composer/actions.ts`:
- change the obsidian import to `import { Notice, type App, type WorkspaceLeaf } from "obsidian";`, add `VIEW_COMPOSER` to the `../ui/actions` import, and add `import { composerSession, type ComposerSession } from "./session";`.
- add these methods to `ComposerActions`:
```ts
  session(): ComposerSession {
    return composerSession(this.deps.app, this.deps.index);
  }

  /** Opens the note in the editor and the composer in a split next to it (reusing an open composer). */
  async openComposer(path: string): Promise<void> {
    const { workspace, vault } = this.deps.app;
    const file = vault.getFileByPath(path);
    if (!file) {
      new Notice("That note no longer exists.");
      return;
    }
    const existing = workspace.getLeavesOfType(VIEW_COMPOSER)[0];
    const known = (existing?.view as unknown as { editorLeaf?: WorkspaceLeaf | null } | undefined)?.editorLeaf;
    let editor = known ?? workspace.getLeaf(false);
    if (editor === existing) editor = workspace.getLeaf("tab");
    await editor.openFile(file);
    const leaf = existing ?? workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type: VIEW_COMPOSER, active: true, state: { path } });
    const view = leaf.view as unknown as { editorLeaf?: WorkspaceLeaf | null } | null;
    if (view && "editorLeaf" in view) view.editorLeaf = editor;
    await workspace.revealLeaf(leaf);
  }

  /** Command check callback: available when the active note is an indexed social post. */
  composeActiveNote(checking: boolean): boolean {
    const file = this.deps.app.workspace.getActiveFile();
    if (!file || !this.deps.index.getVariant(file.path)) return false;
    if (!checking) void this.openComposer(file.path);
    return true;
  }
```

- [ ] **Step 5: Write the composer component**

`src/composer/Composer.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { VARIANT_STATUS_LABEL } from "../planner/status";
  import type { MediaInfo } from "../platforms/types";
  import Preview from "../previews/Preview.svelte";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import type { ComposerSession } from "./session";

  let { session, openVariant }: { session: ComposerSession; openVariant: (path: string) => void } = $props();
  const { snapshot, composer } = useOsmm();

  let path = $state<string | null>(null);
  let body = $state("");
  $effect(() => session.path.subscribe((p) => (path = p)));
  $effect(() => session.body.subscribe((b) => (body = b)));

  const byPlatform = (a: IndexedVariant, b: IndexedVariant) =>
    PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.path.localeCompare(b.path);
  const variant = $derived($snapshot.variants.find((v) => v.path === path));
  const siblings = $derived(
    variant?.campaignPath ? $snapshot.variants.filter((v) => v.campaignPath === variant.campaignPath).sort(byPlatform) : variant ? [variant] : [],
  );

  let media = $state<MediaInfo[]>([]);
  let featured = $state<MediaInfo | undefined>(undefined);
  $effect(() => {
    const v = variant;
    if (!v) return;
    let cancelled = false;
    void composer.content.load(v).then((c) => {
      if (cancelled) return;
      media = c.media;
      featured = c.featured;
    });
    return () => {
      cancelled = true;
    };
  });
  const content = $derived({ body, media, featured });

  const variantChannels = $derived(variant ? composer.channelsOf(variant) : []);
  let previewChannelId = $state("");
  $effect(() => {
    if (variant && !variant.channels.includes(previewChannelId)) previewChannelId = variant.channels[0] ?? "";
  });
  const previewChannel = $derived(variantChannels.find((c) => c.id === previewChannelId) ?? variantChannels[0]);
  let width = $state<"mobile" | "desktop">("mobile");
  const model = $derived(variant ? composer.preview(variant, content, previewChannel) : null);
</script>

{#if !variant}
  <div class="osmm-composer-empty">
    <p>Open a social post note to compose it here.</p>
  </div>
{:else}
  <div class="osmm-composer">
    <div class="osmm-tabs" role="tablist" aria-label="Platforms">
      {#each siblings as s (s.path)}
        <button type="button" role="tab" aria-selected={s.path === variant.path} onclick={() => openVariant(s.path)}>
          <PlatformBadge platform={s.platform} />{PLATFORM_META[s.platform].label}
        </button>
      {/each}
    </div>
    <div class="osmm-composer-main">
      <section class="osmm-composer-preview" aria-label="Preview">
        <div class="osmm-row">
          {#if variantChannels.length > 1}
            <label class="osmm-row">
              Preview as
              <select bind:value={previewChannelId}>
                {#each variantChannels as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
              </select>
            </label>
          {/if}
          <span class="osmm-spacer"></span>
          <div class="osmm-segmented" role="group" aria-label="Preview width">
            <button type="button" class:is-active={width === "mobile"} aria-pressed={width === "mobile"} onclick={() => (width = "mobile")}>Mobile</button>
            <button type="button" class:is-active={width === "desktop"} aria-pressed={width === "desktop"} onclick={() => (width = "desktop")}>Desktop</button>
          </div>
        </div>
        <div class="osmm-phone" data-width={width}>
          {#if model}<Preview {model} {width} />{/if}
        </div>
      </section>
      <aside class="osmm-composer-side" aria-label="Composer panels">
        <p class="osmm-progress">{PLATFORM_META[variant.platform].label} · {VARIANT_STATUS_LABEL[variant.status]}</p>
      </aside>
    </div>
  </div>
{/if}
```

Append to `src/styles/composer.css`:
```css
.osmm-composer { display: flex; flex-direction: column; height: 100%; container-type: inline-size; }
.osmm-composer-empty { padding: 24px; color: var(--text-muted); }
.osmm-tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--osmm-border); overflow-x: auto; }
.osmm-tabs [role="tab"] { display: inline-flex; align-items: center; gap: 6px; background: transparent; box-shadow: none; color: var(--text-muted); white-space: nowrap; }
.osmm-tabs [role="tab"][aria-selected="true"] { background: var(--osmm-hover); color: var(--text-normal); }
.osmm-composer-main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; flex: 1; min-height: 0; padding: 12px; overflow: auto; }
@container (min-width: 720px) {
  .osmm-composer-main { grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); }
}
.osmm-composer-preview { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.osmm-phone { align-self: center; width: 100%; max-width: 400px; padding: 12px; border: 1px solid var(--osmm-border); border-radius: 28px; background: var(--background-secondary); box-sizing: border-box; }
.osmm-phone[data-width="desktop"] { max-width: 600px; border-radius: 12px; }
.osmm-composer-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.osmm-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--osmm-border); border-radius: 10px; }
```

- [ ] **Step 6: Wire the view, the command and the entry points**

In `src/main.ts`, add `import { ComposerView } from "./composer/ComposerView";`, add `VIEW_COMPOSER` to the `./ui/actions` import, and after the preview-grid `registerView` add:
```ts
    this.registerView(VIEW_COMPOSER, (leaf) => new ComposerView(leaf, this.uiContext()));
```

In `src/commands.ts`, add at the end of `registerCommands`:
```ts
  plugin.addCommand({
    id: "open-composer",
    name: "Open composer for this post",
    checkCallback: (checking) => plugin.uiContext().composer.composeActiveNote(checking),
  });
```

In `src/views/CampaignTable.svelte`, replace the row's last cell with:
```svelte
          <td>
            <button type="button" onclick={() => actions.openNote(r.variant.path)}>Open</button>
            <button type="button" aria-label={`Compose ${PLATFORM_META[r.variant.platform].label} variant`} onclick={() => void composer.openComposer(r.variant.path)}>Compose</button>
          </td>
```

In `src/previews/PreviewGrid.svelte`, in the card footer, after the "Open note" button add:
```svelte
          <button type="button" onclick={() => void composer.openComposer(card.v.path)}>Compose</button>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat(composer): add the composer view with live preview and platform tabs (refs #48)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: "Post as" channel picker with groups and stagger (#49)

**Files:**
- Create: `src/composer/channels.ts`, `src/composer/PostAs.svelte`, `test/composer/channels.test.ts`, `test/composer/postAs.test.ts`
- Modify: `src/composer/actions.ts` (`toggleChannel`, `selectGroup`, `setStagger`), `src/composer/Composer.svelte`, `src/styles/composer.css`

**Interfaces:**
- Consumes: `inheritedStatus` (`src/model/stateMachine.ts`); `VariantUpdate` (`src/model/writer.ts`); `PlannerActions.write/afterWrite` (Task 8).
- Produces:
  - `planToggleChannel(fresh: Variant, channel: Pick<Channel, "id" | "name" | "platform">, on: boolean): VariantUpdate | { refuse: string }` — adding writes `channels` and, when the post already has delivery records, a record for the new channel with the post's inherited status; removing deletes only that channel's delivery key, and is refused for published, publishing, handed-over and check-needed channels, and for the last channel of a scheduled post.
  - `planSelectGroup(fresh, channels): VariantUpdate` — adds the group's channels of this platform that are missing.
  - `ComposerActions.toggleChannel(v, channel, on): Promise<boolean>`, `selectGroup(v, group): Promise<void>`, `setStagger(v, minutes): Promise<void>` — each a single `PlannerActions.write` with a Notice and Undo.
  - `<PostAs variant>` — toggle buttons (`aria-pressed`, `aria-label` = channel name), "Add group: …" buttons, "Minutes between channels" input.

- [ ] **Step 1: Write the failing tests**

`test/composer/channels.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { planSelectGroup, planToggleChannel } from "../../src/composer/channels";
import type { Variant } from "../../src/model/types";

const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "draft",
  media: [],
  deliveries: {},
  ...extra,
});
const ch = (id: string, name = id, platform: Variant["platform"] = "linkedin") => ({ id, name, platform });

describe("planToggleChannel", () => {
  it("adds a channel; with delivery records it gets the post's status", () => {
    expect(planToggleChannel(v(), ch("li/osmm"), true)).toEqual({ fields: { channels: ["li/me", "li/acme", "li/osmm"] } });
    const scheduled = v({ status: "scheduled", scheduledAt: 1, deliveries: { "li/me": { status: "scheduled" } } });
    expect(planToggleChannel(scheduled, ch("li/osmm"), true)).toEqual({
      fields: { channels: ["li/me", "li/acme", "li/osmm"] },
      deliveries: { "li/osmm": { status: "scheduled" } },
    });
  });

  it("refuses a channel of another platform", () => {
    expect(planToggleChannel(v(), ch("x/you", "@you", "x"), true)).toEqual({ refuse: "@you is not a LinkedIn channel." });
  });

  it("removes a channel and only its delivery key", () => {
    const post = v({ deliveries: { "li/me": { status: "draft" }, "li/acme": { status: "draft" } } });
    expect(planToggleChannel(post, ch("li/acme"), false)).toEqual({ fields: { channels: ["li/me"] }, deliveries: { "li/acme": null } });
  });

  it.each([
    ["published", "Me was already published, so it stays on this post."],
    ["publishing", "Me is being published right now, so it stays on this post."],
    ["handed_over", "Me was handed over to the platform, so it stays on this post."],
    ["check_needed", "Me needs a check after an interrupted publish, so it stays on this post."],
  ] as const)("refuses to remove a %s channel (review focus 4)", (status, reason) => {
    expect(planToggleChannel(v({ deliveries: { "li/me": { status } } }), ch("li/me", "Me"), false)).toEqual({ refuse: reason });
  });

  it("refuses to remove a channel of a post stored as published without records", () => {
    expect(planToggleChannel(v({ status: "published" }), ch("li/me", "Me"), false)).toEqual({ refuse: "Me was already published, so it stays on this post." });
  });

  it("refuses to remove the last channel of a scheduled post", () => {
    const post = v({ channels: ["li/me"], status: "scheduled", scheduledAt: 1 });
    expect(planToggleChannel(post, ch("li/me", "Me"), false)).toEqual({ refuse: "A scheduled post needs at least one channel. Unschedule it first." });
  });

  it("does nothing when the channel is already in the wanted state", () => {
    expect(planToggleChannel(v(), ch("li/me"), true)).toEqual({});
    expect(planToggleChannel(v(), ch("li/osmm"), false)).toEqual({});
  });
});

describe("planSelectGroup", () => {
  it("adds the group's missing channels of this platform only", () => {
    const group = [ch("li/acme"), ch("li/osmm"), ch("x/you", "@you", "x"), ch("li/maker")];
    expect(planSelectGroup(v(), group)).toEqual({ fields: { channels: ["li/me", "li/acme", "li/osmm", "li/maker"] } });
    expect(planSelectGroup(v({ channels: ["li/acme", "li/osmm", "li/maker"] }), group)).toEqual({});
  });
});
```

`test/composer/postAs.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Notice } from "../fakes/obsidian";
import PostAs from "../../src/composer/PostAs.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";

describe("PostAs", () => {
  it("refuses to deselect a published channel and leaves its delivery untouched (review focus 4)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const before = structuredClone(index.getVariant(LI)!.deliveries);
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    expect(screen.getByRole("button", { name: "Me" }).getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: "Me" }));
    await vi.waitFor(() => expect(Notice.messages.at(-1)).toBe("Me was already published, so it stays on this post."));
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio", "li/maker-lab"]);
    expect(index.getVariant(LI)!.deliveries).toEqual(before);
  });

  it("adds a channel with the post's delivery status, and undoes it", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "OSMM" }));
    await indexed(index, () => index.getVariant(LI)!.channels.includes("li/osmm"));
    expect(index.getVariant(LI)!.deliveries["li/osmm"]).toEqual({ status: "scheduled" });
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => !index.getVariant(LI)!.channels.includes("li/osmm"));
    expect(index.getVariant(LI)!.deliveries["li/osmm"]).toBeUndefined();
  });

  it("adds a group's channels and sets the stagger", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Add group: All LinkedIn pages" }));
    await indexed(index, () => index.getVariant(LI)!.channels.length === 5);
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    await fireEvent.change(screen.getByLabelText("Minutes between channels"), { target: { value: "30" } });
    await indexed(index, () => index.getVariant(LI)!.staggerMinutes === 30);
    expect(index.getVariant(LI)!.staggerMinutes).toBe(30);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/composer/channels.test.ts test/composer/postAs.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the planners**

`src/composer/channels.ts`:
```ts
import { PLATFORM_META } from "../model/platforms";
import { inheritedStatus } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant, VariantStatus } from "../model/types";
import type { VariantUpdate } from "../model/writer";

/** Channels in these states are part of the post's history and cannot be deselected. */
const STAYS: Partial<Record<DeliveryStatus, string>> = {
  published: "was already published",
  publishing: "is being published right now",
  handed_over: "was handed over to the platform",
  check_needed: "needs a check after an interrupted publish",
};
const PUBLISHED = new Set<VariantStatus>(["published", "partial"]);
const SCHEDULED = new Set<VariantStatus>(["scheduled", "partial", "overdue", "attention"]);

function hasRecords(v: Pick<Variant, "channels" | "deliveries">): boolean {
  return v.channels.some((c) => v.deliveries[c] !== undefined);
}

function withChannels(fresh: Variant, ids: readonly string[]): VariantUpdate {
  const channels = [...fresh.channels, ...ids];
  if (!hasRecords(fresh)) return { fields: { channels } };
  const status = inheritedStatus(fresh);
  return { fields: { channels }, deliveries: Object.fromEntries(ids.map((id) => [id, { status } satisfies Delivery])) };
}

export function planToggleChannel(
  fresh: Variant,
  channel: Pick<Channel, "id" | "name" | "platform">,
  on: boolean,
): VariantUpdate | { refuse: string } {
  const has = fresh.channels.includes(channel.id);
  if (on) {
    if (has) return {};
    if (channel.platform !== fresh.platform) return { refuse: `${channel.name} is not a ${PLATFORM_META[fresh.platform].label} channel.` };
    return withChannels(fresh, [channel.id]);
  }
  if (!has) return {};
  const d = fresh.deliveries[channel.id];
  const why = d ? STAYS[d.status] : !hasRecords(fresh) && PUBLISHED.has(fresh.status) ? STAYS.published : undefined;
  if (why) return { refuse: `${channel.name} ${why}, so it stays on this post.` };
  const channels = fresh.channels.filter((c) => c !== channel.id);
  if (!channels.length && fresh.scheduledAt !== undefined && SCHEDULED.has(fresh.status)) {
    return { refuse: "A scheduled post needs at least one channel. Unschedule it first." };
  }
  return d ? { fields: { channels }, deliveries: { [channel.id]: null } } : { fields: { channels } };
}

export function planSelectGroup(fresh: Variant, channels: readonly Pick<Channel, "id" | "platform">[]): VariantUpdate {
  const ids = channels.filter((c) => c.platform === fresh.platform && !fresh.channels.includes(c.id)).map((c) => c.id);
  return ids.length ? withChannels(fresh, ids) : {};
}
```

- [ ] **Step 4: Add the actions and the panel**

In `src/composer/actions.ts`:
- change the types import to `import type { Channel, ChannelGroup, Issue, Variant } from "../model/types";` and add `import { planSelectGroup, planToggleChannel } from "./channels";`.
- add these methods to `ComposerActions`:
```ts
  async toggleChannel(v: IndexedVariant, channel: Channel, on: boolean): Promise<boolean> {
    const result = await this.deps.planner.write(v.file, (fresh) => planToggleChannel(fresh, channel, on));
    this.deps.planner.afterWrite(result, on ? `Added ${channel.name}.` : `Removed ${channel.name}.`);
    return result.ok;
  }

  async selectGroup(v: IndexedVariant, group: ChannelGroup): Promise<void> {
    const members = group.channelIds.map((id) => this.deps.channels.get(id)).filter((c): c is Channel => c !== undefined);
    const result = await this.deps.planner.write(v.file, (fresh) => planSelectGroup(fresh, members));
    this.deps.planner.afterWrite(result, `Added the channels of ${group.name}.`);
  }

  async setStagger(v: IndexedVariant, minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      new Notice("Use a whole number of minutes between 0 and 1440.");
      return;
    }
    const result = await this.deps.planner.write(v.file, () => ({ fields: { staggerMinutes: minutes } }));
    this.deps.planner.afterWrite(result, `Channels are now ${minutes} min apart.`);
  }
```

`src/composer/PostAs.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORM_META } from "../model/platforms";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import { useOsmm } from "../ui/context";

  let { variant }: { variant: IndexedVariant } = $props();
  const { settings, composer } = useOsmm();
  const options = $derived($settings.channels.filter((c) => c.platform === variant.platform));
  const groups = $derived($settings.channelGroups.filter((g) => g.channelIds.some((id) => options.some((c) => c.id === id))));
  const unknown = $derived(variant.channels.filter((id) => !options.some((c) => c.id === id)));
</script>

<section class="osmm-panel" aria-label="Post as">
  <h4 class="osmm-section-title">Post as</h4>
  <div class="osmm-chips">
    {#each options as c (c.id)}
      {@const on = variant.channels.includes(c.id)}
      <button type="button" class="osmm-toggle" aria-pressed={on} aria-label={c.name} onclick={() => void composer.toggleChannel(variant, c, !on)}>
        <ChannelAvatar channel={c} size={18} />{c.name}
      </button>
    {:else}
      <p class="osmm-progress">No {PLATFORM_META[variant.platform].label} channels yet. Add one in settings.</p>
    {/each}
  </div>
  {#if unknown.length}<p class="osmm-progress">Not in settings: {unknown.join(", ")}</p>{/if}
  {#if groups.length}
    <div class="osmm-chips">
      {#each groups as g (g.id)}<button type="button" onclick={() => void composer.selectGroup(variant, g)}>Add group: {g.name}</button>{/each}
    </div>
  {/if}
  {#if variant.channels.length > 1}
    <label>
      Minutes between channels
      <input
        type="number"
        min="0"
        max="1440"
        value={variant.staggerMinutes ?? $settings.defaultStaggerMinutes}
        onchange={(e) => void composer.setStagger(variant, Number(e.currentTarget.value))} />
    </label>
  {/if}
</section>
```

In `src/composer/Composer.svelte`, add `import PostAs from "./PostAs.svelte";` and, right before `</aside>`, add:
```svelte
        <PostAs {variant} />
```

Append to `src/styles/composer.css`:
```css
.osmm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.osmm-toggle { display: inline-flex; align-items: center; gap: 6px; }
.osmm-toggle[aria-pressed="true"] { background: var(--interactive-accent); color: var(--text-on-accent); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/composer && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/composer src/styles/composer.css test/composer
git commit -m "feat(composer): add the Post as channel picker with groups and stagger (refs #49)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Live checks panel with counters and quick fixes (#50)

**Files:**
- Create: `src/composer/fixes.ts`, `src/composer/Checks.svelte`, `test/composer/checks.test.ts`
- Modify: `src/composer/actions.ts` (`quickFix`), `src/composer/Composer.svelte`, `src/styles/composer.css`

**Interfaces:**
- Consumes: `Issue.code` (Task 3), issue codes of Task 4, `Counter` (Task 3), `ComposerActions.check/counters` (Task 8).
- Produces:
  - `slugify(text): string`.
  - `interface QuickFix { label: string; run(): Promise<void> }`, `ComposerActions.quickFix(v, issue): QuickFix | null` — `missing-url` → "Use the campaign link" (when the campaign has `link`), `missing-slug` → `Use slug "<slug>"` (from the title). Both write through SafeWriter and offer Undo.
  - `<Checks variant issues counters>` — counters with a length bar, then **Blocking** (errors) and **Advisory** (warnings) lists, each issue with its quick fix button when there is one.
  - `Composer.svelte` computes `issues` (`composer.check`) and `counterList` (`composer.counters`) from the live body; Task 12 uses `issues` to disable Schedule.

- [ ] **Step 1: Write the failing tests**

`test/composer/checks.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import Checks from "../../src/composer/Checks.svelte";
import { slugify } from "../../src/composer/fixes";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

async function renderChecks(c: TestCtx, path: string) {
  const v = c.index.getVariant(path)!;
  const content = await c.ctx.composer.content.load(v);
  return render(Checks, {
    props: { variant: v, issues: c.ctx.composer.check(v, content), counters: c.ctx.composer.counters(v, content) },
    context: osmmContext(c.ctx),
  });
}

async function frontmatter(c: TestCtx, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("slugify", () => {
  it.each([
    ["We're hosting Event X again", "we-re-hosting-event-x-again"],
    ["Café à Berlin!", "cafe-a-berlin"],
    ["  --  ", ""],
  ])("%s → %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });
});

describe("Checks", () => {
  it("shows counters and says when there is nothing to fix", async () => {
    const c = await makeCtx({ seed: true });
    await renderChecks(c, "Social/Event X/Event X – Hacker News.md");
    const panel = screen.getByRole("region", { name: "Checks" });
    expect(panel.textContent).toContain("Title");
    expect(panel.textContent).toContain("47/80");
    expect(panel.textContent).toContain("No problems found.");
  });

  it("lists blocking issues and fills the url from the campaign link", async () => {
    const path = "Social/Event X/Event X – HN 2.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "hackernews", channels: ["hn/you"], title: "Show HN: Event X" } }],
    });
    await renderChecks(c, path);
    expect(screen.getByRole("region", { name: "Checks" }).textContent).toContain("Blocking · 1");
    await fireEvent.click(screen.getByRole("button", { name: "Use the campaign link" }));
    await indexed(c.index, () => c.index.getVariant(path)?.url === "https://example.com/event-x");
    expect(c.index.getVariant(path)?.url).toBe("https://example.com/event-x");
  });

  it("suggests a slug from the title, with undo", async () => {
    const path = "Social/Posts/Article.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "wordpress", channels: ["wp/eventx-berlin"], title: "We're back" }, body: "Hello" }],
    });
    await renderChecks(c, path);
    await fireEvent.click(screen.getByRole("button", { name: 'Use slug "we-re-back"' }));
    await vi.waitFor(async () => expect((await frontmatter(c, path)).slug).toBe("we-re-back"));
    Notice.last!.noticeEl.querySelector("button")!.click();
    await vi.waitFor(async () => expect((await frontmatter(c, path)).slug).toBeUndefined());
  });

  it("separates blocking from advisory issues", async () => {
    const path = "Social/Posts/Linky.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me"] }, body: `${"a".repeat(3001)} https://example.com` }],
    });
    await renderChecks(c, path);
    const panel = screen.getByRole("region", { name: "Checks" });
    expect(panel.textContent).toContain("Blocking · 1");
    expect(panel.textContent).toContain("Advisory · 1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/composer/checks.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the fixes and the panel**

`src/composer/fixes.ts`:
```ts
/** A WordPress-style slug: lowercase ASCII letters, digits and single dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}
```

In `src/composer/actions.ts`, add `import { slugify } from "./fixes";`, export the interface below at module level, and add the method to `ComposerActions`:
```ts
export interface QuickFix {
  label: string;
  run(): Promise<void>;
}
```
```ts
  /** A one-click fix for an issue, when there is an obvious one. */
  quickFix(v: IndexedVariant, issue: Issue): QuickFix | null {
    if (issue.code === "missing-url") {
      const link = v.campaignPath ? this.deps.index.getCampaign(v.campaignPath)?.link : undefined;
      if (!link) return null;
      return {
        label: "Use the campaign link",
        run: async () => {
          const result = await this.deps.planner.write(v.file, (fresh) => (fresh.url ? {} : { fields: { url: link } }));
          this.deps.planner.afterWrite(result, "Link set from the campaign.");
        },
      };
    }
    if (issue.code === "missing-slug" && v.title) {
      const slug = slugify(v.title);
      if (!slug) return null;
      return {
        label: `Use slug "${slug}"`,
        run: async () => {
          await this.deps.writer.run(v.file, (fm) => {
            if (!fm.slug) fm.slug = slug;
          });
          this.deps.planner.undoNotice(`Slug set to ${slug}.`, () =>
            this.deps.writer.run(v.file, (fm) => {
              if (fm.slug === slug) delete fm.slug;
            }),
          );
        },
      };
    }
    return null;
  }
```

`src/composer/Checks.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import type { Issue } from "../model/types";
  import type { Counter } from "../platforms/checks";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";

  let { variant, issues, counters }: { variant: IndexedVariant; issues: Issue[]; counters: Counter[] } = $props();
  const { composer } = useOsmm();
  const groups = $derived(
    [
      { title: "Blocking", list: issues.filter((i) => i.level === "error"), glyph: "circle-x", cls: "is-error" },
      { title: "Advisory", list: issues.filter((i) => i.level === "warning"), glyph: "alert-triangle", cls: "is-warning" },
    ].filter((g) => g.list.length > 0),
  );
  const pct = (c: Counter) => Math.min(100, Math.round((c.value / Math.max(c.limit, 1)) * 100));
</script>

<section class="osmm-panel" aria-label="Checks">
  <h4 class="osmm-section-title">Checks</h4>
  <ul class="osmm-counters">
    {#each counters as c (c.label)}
      <li>
        <span>{c.label}</span>
        <span class="osmm-lenbar" aria-hidden="true"><span style:width="{pct(c)}%"></span></span>
        <span class="osmm-progress" class:is-over={c.value > c.limit && c.label !== "Fold"}>{c.value.toLocaleString("en-US")}/{c.limit.toLocaleString("en-US")}</span>
      </li>
    {/each}
  </ul>
  {#if !issues.length}
    <p class="osmm-ok"><span use:icon={"check"} aria-hidden="true"></span>No problems found.</p>
  {/if}
  {#each groups as g (g.title)}
    <h5 class="osmm-issue-head">{g.title} · {g.list.length}</h5>
    <ul class="osmm-issue-list">
      {#each g.list as issue, i (i)}
        {@const fix = composer.quickFix(variant, issue)}
        <li class={g.cls}>
          <span use:icon={g.glyph} aria-hidden="true"></span>
          <span>{issue.message}</span>
          {#if fix}<button type="button" onclick={() => void fix.run()}>{fix.label}</button>{/if}
        </li>
      {/each}
    </ul>
  {/each}
</section>
```

In `src/composer/Composer.svelte`:
- add `import Checks from "./Checks.svelte";`
- after `const model = $derived(…);` add:
```ts
  const issues = $derived(variant ? composer.check(variant, content) : []);
  const counterList = $derived(variant ? composer.counters(variant, content, previewChannel) : []);
```
- right before `</aside>`, add:
```svelte
        <Checks {variant} {issues} counters={counterList} />
```

Append to `src/styles/composer.css`:
```css
.osmm-counters { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.osmm-counters li { display: grid; grid-template-columns: 90px 1fr auto; align-items: center; gap: 8px; }
.osmm-lenbar > span { display: block; height: 100%; border-radius: 2px; background: var(--interactive-accent); }
.osmm-ok { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--text-success); }
.osmm-issue-head { margin: 4px 0 0; font-size: var(--font-ui-smaller); }
.osmm-issue-list li { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composer src/styles/composer.css test/composer
git commit -m "feat(composer): add the live checks panel with counters and quick fixes (refs #50)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Schedule panel — date, time, reminders, mode (#51)

**Files:**
- Create: `src/composer/schedule.ts`, `src/composer/SchedulePanel.svelte`, `test/composer/schedule.test.ts`, `test/composer/schedulePanel.test.ts`
- Modify: `src/composer/actions.ts` (`schedule`, `setMode`, `methodFor`), `src/composer/Composer.svelte`, `src/styles/composer.css`

**Interfaces:**
- Consumes: `transition`, `deliveryTime` (`src/model/stateMachine.ts`); `defaultScheduleTime` (`src/planner/board.ts`); `deliveryChanges` (`src/planner/changes.ts`); `blocking` (Task 3); `effectiveMethod`, `AdapterRegistry` (Task 1); `PlannerActions.write/afterWrite/confirm/unschedule`.
- Produces:
  - `interface ScheduleRequest { at: number; reminders: number[] }`, `type SchedulePlan = { fields: { scheduledAt; reminders }; deliveries: Record<string, Delivery> } | { refuse: string }`.
  - `planComposerSchedule(fresh, req, defaultStagger): SchedulePlan` — pending channels (draft, ready, scheduled, overdue, failed, awaiting_you) become `scheduled` via `transition()`, lose any explicit `at` and `error`, and follow `scheduled_at` + stagger; published, skipped, handed-over and check-needed channels keep their status, and their current time is pinned (`at`) so they don't move. Refused with no channels, while publishing, or for a post stored as published without records.
  - `scheduleNeeds(v, at, now): { past: boolean; handedOver: boolean }`, `bestSlot(channels): { time: string; channel: string } | null`, `reminderDefaults(v, channels, settings): number[]` (variant, then first channel with defaults, then settings).
  - `ComposerActions.schedule(v, req, issues): Promise<boolean>` — one `PlannerActions.write` for `scheduled_at`, `reminders` and delivery states; refuses with blocking issues; confirms a past time and a change to a handed-over post. `setMode(v, mode)`, `methodFor(v, channel): EffectiveMethod`.
  - `<SchedulePanel variant issues>` — Date and Time inputs (local time zone shown), best-slot hint, reminder chips with add/remove, Mode select, per-channel method, **Schedule** / **Update schedule** (disabled while blocked) and **Unschedule**.

- [ ] **Step 1: Write the failing tests**

`test/composer/schedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bestSlot, planComposerSchedule, reminderDefaults, scheduleNeeds } from "../../src/composer/schedule";
import type { Variant } from "../../src/model/types";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { channel } from "../platforms/fixtures";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const NEW = T + 2 * 86_400_000;
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme", "li/maker"],
  mode: "auto",
  status: "draft",
  scheduledAt: T,
  staggerMinutes: 15,
  media: [],
  deliveries: {},
  ...extra,
});

describe("planComposerSchedule", () => {
  it("moves only the pending channels of a partly published post (review focus 5)", () => {
    const post = v({
      status: "partial",
      deliveries: {
        "li/me": { status: "published", url: "https://li/1" },
        "li/acme": { status: "overdue", at: T + 900_000 },
        "li/maker": { status: "failed", error: "Rate limited", attempts: 2 },
      },
    });
    expect(planComposerSchedule(post, { at: NEW, reminders: [60] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [60] },
      deliveries: {
        "li/me": { status: "published", url: "https://li/1", at: T },
        "li/acme": { status: "scheduled" },
        "li/maker": { status: "scheduled", attempts: 2 },
      },
    });
  });

  it("schedules channels without records and keeps handed-over ones where they are", () => {
    const post = v({ deliveries: { "li/maker": { status: "handed_over", remoteId: "9" } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [] },
      deliveries: {
        "li/me": { status: "scheduled" },
        "li/acme": { status: "scheduled" },
        "li/maker": { status: "handed_over", remoteId: "9", at: T + 30 * 60_000 },
      },
    });
  });

  it.each([
    [v({ channels: [] }), "Pick at least one channel before scheduling."],
    [v({ deliveries: { "li/me": { status: "publishing" } } }), "This post is being published right now."],
    [v({ status: "published" }), "This post was already published."],
  ])("refuses %#", (post, reason) => {
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({ refuse: reason });
  });
});

describe("schedule helpers", () => {
  it("says what needs confirming", () => {
    expect(scheduleNeeds(v(), T - 1, T)).toEqual({ past: true, handedOver: false });
    expect(scheduleNeeds(v({ deliveries: { "li/acme": { status: "handed_over" } } }), T + 1, T)).toEqual({ past: false, handedOver: true });
  });

  it("finds the best slot from the channels' usual times", () => {
    expect(bestSlot([channel("li/me"), channel("li/acme", { name: "Acme Studio", defaultTime: "08:30" })])).toEqual({ time: "08:30", channel: "Acme Studio" });
    expect(bestSlot([channel("li/me")])).toBeNull();
  });

  it("picks reminders from the post, then the channel, then the settings", () => {
    const acme = channel("li/acme", { defaultReminders: [30] });
    expect(reminderDefaults(v({ reminders: [5] }), [acme], DEFAULT_SETTINGS)).toEqual([5]);
    expect(reminderDefaults(v(), [channel("li/me"), acme], DEFAULT_SETTINGS)).toEqual([30]);
    expect(reminderDefaults(v(), [channel("li/me")], DEFAULT_SETTINGS)).toEqual([60, 10]);
  });
});
```

`test/composer/schedulePanel.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import SchedulePanel from "../../src/composer/SchedulePanel.svelte";
import { formatDateTime } from "../../src/model/dates";
import { osmmContext } from "../../src/ui/context";
import { makeCtx, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/P.md";
const note = { path: P, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme-studio"], status: "draft" }, body: "Hello" };

async function fm(c: TestCtx, path = P): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

async function setWhen(date: string, time: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText("Date"), { target: { value: date } });
  await fireEvent.input(screen.getByLabelText("Time"), { target: { value: time } });
}

describe("SchedulePanel", () => {
  it("writes scheduled_at, reminders and delivery states in one write", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const spy = vi.spyOn(c.writer, "updateVariant");
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-20", "09:30");
    await fireEvent.click(screen.getByRole("button", { name: "Remove reminder 10 min before" }));
    await fireEvent.input(screen.getByLabelText("Add a reminder (minutes before)"), { target: { value: "30" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await vi.waitFor(async () => expect((await fm(c)).status).toBe("scheduled"));
    expect(await fm(c)).toMatchObject({
      scheduled_at: formatDateTime(new Date(2026, 9, 20, 9, 30).getTime()),
      reminders: [60, 30],
      deliveries: { "li/me": { status: "scheduled" }, "li/acme-studio": { status: "scheduled" } },
    });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("disables Schedule while there are blocking issues", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const issues = [{ level: "error" as const, field: "body", message: "The text is 3,001/3,000 characters." }];
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues }, context: osmmContext(c.ctx) });
    expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toBe("Fix the blocking issues to schedule.");
  });

  it("asks before scheduling in the past", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const asked: string[] = [];
    c.ctx.actions.confirm = async (message) => {
      asked.push(message);
      return false;
    };
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-01", "09:00");
    await fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await vi.waitFor(() => expect(asked).toEqual(["That time is in the past, so the post will show as overdue right away. Schedule anyway?"]));
    expect((await fm(c)).scheduled_at).toBeUndefined();
  });

  it("keeps a published channel untouched when rescheduling a partial post (review focus 5)", async () => {
    const c = await makeCtx({ seed: true });
    const LI = "Social/Event X/Event X – LinkedIn.md";
    const before = (await fm(c, LI)).deliveries as Record<string, unknown>;
    render(SchedulePanel, { props: { variant: c.index.getVariant(LI)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-15", "17:30");
    await fireEvent.click(screen.getByRole("button", { name: "Update schedule" }));
    await vi.waitFor(async () => expect((await fm(c, LI)).scheduled_at).toBe(formatDateTime(new Date(2026, 9, 15, 17, 30).getTime())));
    const after = (await fm(c, LI)).deliveries as Record<string, unknown>;
    expect(after["li/me"]).toEqual(before["li/me"]);
    expect(after["li/acme-studio"]).toEqual({ status: "scheduled" });
    expect(after["li/maker-lab"]).toEqual({ status: "scheduled" });
  });

  it("changes the mode and shows how each channel will post", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Schedule" }).textContent).toContain("Reminder + pre-filled composer");
    await fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "assisted" } });
    await vi.waitFor(async () => expect((await fm(c)).mode).toBe("assisted"));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/composer/schedule.test.ts test/composer/schedulePanel.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the schedule planner**

`src/composer/schedule.ts`:
```ts
import { deliveryTime, transition } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant } from "../model/types";
import type { OsmmSettings } from "../settings/settings";

export interface ScheduleRequest {
  at: number;
  reminders: number[];
}

export type SchedulePlan =
  | { fields: { scheduledAt: number; reminders: number[] }; deliveries: Record<string, Delivery> }
  | { refuse: string };

/** Channels that keep their status and their time: done, in flight, or already on the platform. */
const KEEP = new Set<DeliveryStatus>(["published", "skipped", "publishing", "handed_over", "check_needed"]);

export function planComposerSchedule(fresh: Variant, req: ScheduleRequest, defaultStagger: number): SchedulePlan {
  if (!fresh.channels.length) return { refuse: "Pick at least one channel before scheduling." };
  if (fresh.channels.some((id) => fresh.deliveries[id]?.status === "publishing")) return { refuse: "This post is being published right now." };
  const hasRecords = fresh.channels.some((id) => fresh.deliveries[id] !== undefined);
  if (!hasRecords && (fresh.status === "published" || fresh.status === "partial")) return { refuse: "This post was already published." };
  const deliveries: Record<string, Delivery> = {};
  for (const id of fresh.channels) {
    const d = fresh.deliveries[id];
    if (d && KEEP.has(d.status)) {
      if (d.at === undefined) {
        const effective = deliveryTime(fresh, id, defaultStagger);
        if (effective !== undefined) deliveries[id] = { ...d, at: effective };
      }
      continue;
    }
    const base: Delivery = d ?? { status: "draft" };
    const next: Delivery = base.status === "scheduled" ? { ...base } : transition(base, "scheduled");
    delete next.at;
    delete next.error;
    deliveries[id] = next;
  }
  return { fields: { scheduledAt: req.at, reminders: req.reminders }, deliveries };
}

export function scheduleNeeds(v: Pick<Variant, "channels" | "deliveries">, at: number, now: number): { past: boolean; handedOver: boolean } {
  return { past: at < now, handedOver: v.channels.some((id) => v.deliveries[id]?.status === "handed_over") };
}

/** Static in v1: the first selected channel with a usual posting time. */
export function bestSlot(channels: readonly Channel[]): { time: string; channel: string } | null {
  const c = channels.find((x) => x.defaultTime);
  return c?.defaultTime ? { time: c.defaultTime, channel: c.name } : null;
}

export function reminderDefaults(v: Pick<Variant, "reminders">, channels: readonly Channel[], settings: Pick<OsmmSettings, "defaultReminders">): number[] {
  return [...(v.reminders ?? channels.find((c) => c.defaultReminders)?.defaultReminders ?? settings.defaultReminders)];
}
```

- [ ] **Step 4: Add the actions**

In `src/composer/actions.ts`:
- change the types import to `import type { Channel, ChannelGroup, Delivery, Issue, PostMode, Variant } from "../model/types";`, change the registry import to `import { effectiveMethod, platformDef, type AdapterRegistry, type EffectiveMethod } from "../platforms/registry";`, and add:
```ts
import { formatShortDate, formatTime } from "../ui/format";
import { planComposerSchedule, scheduleNeeds, type ScheduleRequest } from "./schedule";
```
- add these methods to `ComposerActions`:
```ts
  methodFor(v: Pick<Variant, "mode" | "platform">, channel: Channel): EffectiveMethod {
    return effectiveMethod(v.mode, channel, this.deps.adapters.get(v.platform));
  }

  async setMode(v: IndexedVariant, mode: PostMode): Promise<void> {
    const result = await this.deps.planner.write(v.file, () => ({ fields: { mode } }));
    this.deps.planner.afterWrite(result, mode === "assisted" ? "This post will always be assisted." : "This post will auto-post where possible.");
  }

  /** Writes scheduled_at, reminders and delivery states in one write. */
  async schedule(v: IndexedVariant, req: ScheduleRequest, issues: readonly Issue[]): Promise<boolean> {
    const { planner } = this.deps;
    if (blocking(issues)) {
      new Notice("Fix the blocking issues first.");
      return false;
    }
    const needs = scheduleNeeds(v, req.at, this.deps.now());
    if (needs.past && !(await planner.confirm("That time is in the past, so the post will show as overdue right away. Schedule anyway?", "Schedule"))) return false;
    if (
      needs.handedOver &&
      !(await planner.confirm("Some channels were already handed over to the platform. Changing the time here won't change it there until you push an update. Continue?", "Continue"))
    ) {
      return false;
    }
    const stagger = this.deps.settings().defaultStaggerMinutes;
    const result = await planner.write(v.file, (fresh) => {
      const plan = planComposerSchedule(fresh, req, stagger);
      if ("refuse" in plan) return plan;
      return { fields: plan.fields, deliveries: deliveryChanges(fresh, plan.deliveries as Record<string, Delivery>) };
    });
    planner.afterWrite(result, `Scheduled for ${formatShortDate(req.at)} ${formatTime(req.at)}.`);
    return result.ok;
  }
```

- [ ] **Step 5: Write the panel**

`src/composer/SchedulePanel.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import type { Issue, PostMode } from "../model/types";
  import { defaultScheduleTime } from "../planner/board";
  import { blocking } from "../platforms/checks";
  import type { EffectiveMethod } from "../platforms/registry";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";
  import { bestSlot, reminderDefaults } from "./schedule";

  let { variant, issues }: { variant: IndexedVariant; issues: Issue[] } = $props();
  const { settings, now, composer, actions } = useOsmm();

  const METHOD: Record<EffectiveMethod, string> = {
    api: "Auto-post",
    native: "Scheduled on the platform",
    assisted: "Reminder + pre-filled composer",
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const channelList = $derived(composer.channelsOf(variant));
  const slot = $derived(bestSlot(channelList));
  let date = $state("");
  let time = $state("");
  let reminders = $state<number[]>([]);
  let newReminder = $state<number | null>(null);
  let loadedFor = "";

  // Reset the inputs when another note is shown or the note's schedule changes elsewhere.
  $effect(() => {
    const key = `${variant.path}|${variant.scheduledAt ?? ""}|${(variant.reminders ?? []).join(",")}`;
    if (key === loadedFor) return;
    loadedFor = key;
    const d = new Date(variant.scheduledAt ?? defaultScheduleTime($now, variant, slot?.time));
    date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    reminders = reminderDefaults(variant, channelList, $settings);
  });

  const at = $derived.by(() => {
    const [y, m, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    if (!y || !m || !d || h === undefined || mi === undefined || Number.isNaN(h) || Number.isNaN(mi)) return null;
    return new Date(y, m - 1, d, h, mi).getTime();
  });
  const blocked = $derived(blocking(issues));
  const scheduled = $derived(["scheduled", "partial", "overdue", "attention"].includes(variant.status));

  function addReminder(): void {
    const n = Number(newReminder);
    if (newReminder !== null && Number.isInteger(n) && n >= 0 && n <= 20160 && !reminders.includes(n)) {
      reminders = [...reminders, n].sort((a, b) => b - a);
    }
    newReminder = null;
  }
</script>

<section class="osmm-panel" aria-label="Schedule">
  <h4 class="osmm-section-title">Schedule</h4>
  <div class="osmm-row">
    <label>Date<input type="date" bind:value={date} /></label>
    <label>Time<input type="time" bind:value={time} /></label>
  </div>
  <p class="osmm-progress">{zone}{#if slot} · Best slot: {slot.time} ({slot.channel}){/if}</p>
  <div class="osmm-chips" role="group" aria-label="Reminders">
    {#each reminders as r (r)}
      <span class="osmm-chip-token">
        {r} min before
        <button type="button" class="clickable-icon" aria-label={`Remove reminder ${r} min before`} onclick={() => (reminders = reminders.filter((x) => x !== r))}><span use:icon={"x"}></span></button>
      </span>
    {/each}
  </div>
  <div class="osmm-row">
    <input type="number" min="0" max="20160" placeholder="min" aria-label="Add a reminder (minutes before)" bind:value={newReminder} />
    <button type="button" onclick={addReminder}>Add reminder</button>
  </div>
  <label>
    Mode
    <select value={variant.mode} onchange={(e) => void composer.setMode(variant, e.currentTarget.value as PostMode)}>
      <option value="auto">Auto-post when possible</option>
      <option value="assisted">Always assisted</option>
    </select>
  </label>
  <ul class="osmm-methods">
    {#each channelList as c (c.id)}
      <li><span>{c.name}</span><span class="osmm-progress">{METHOD[composer.methodFor(variant, c)]}</span></li>
    {/each}
  </ul>
  <div class="osmm-row">
    <button
      type="button"
      class="mod-cta"
      disabled={blocked || at === null || variant.channels.length === 0}
      onclick={() => {
        if (at !== null) void composer.schedule(variant, { at, reminders }, issues);
      }}>{scheduled ? "Update schedule" : "Schedule"}</button>
    {#if scheduled}<button type="button" onclick={() => void actions.unschedule(variant, "ready")}>Unschedule</button>{/if}
  </div>
  {#if blocked}<p class="osmm-progress" role="note">Fix the blocking issues to schedule.</p>{/if}
</section>
```

In `src/composer/Composer.svelte`, add `import SchedulePanel from "./SchedulePanel.svelte";` and, right before `</aside>`:
```svelte
        <SchedulePanel {variant} {issues} />
```

Append to `src/styles/composer.css`:
```css
.osmm-chip-token { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 10px; background: var(--osmm-hover); }
.osmm-methods { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.osmm-methods li { display: flex; justify-content: space-between; gap: 8px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/composer && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/composer src/styles/composer.css test/composer
git commit -m "feat(composer): add the schedule panel with reminders and mode (refs #51)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Composer action row with "Fork for this page" (#52, M2a part)

**Files:**
- Create: `src/composer/ActionsBar.svelte`, `test/composer/actionsBar.test.ts`
- Modify: `src/composer/actions.ts` (`fork`), `src/composer/Composer.svelte`

**Interfaces:**
- Consumes: `NoteFactory.forkVariant(file, channelId, channelName)` (M1); `PlannerActions.actionNotice` (Task 8); `ComposerActions.openComposer/openPreviewGrid` (Tasks 8–9).
- Produces:
  - `ComposerActions.fork(v, channelId): Promise<string | null>` — forks one channel into its own note, shows "Forked … into its own note." with an **Open in composer** button, or the factory's error as a Notice. Forking creates a file, so it has no Undo.
  - `<ActionsBar variant>` — the Composer's action row: **Fork for this page…** (a menu of the post's channels; only with 2+ channels) and **Preview campaign**. M2b adds **Post now** and **Copy & open** to this row.

- [ ] **Step 1: Write the failing test**

`test/composer/actionsBar.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Menu, Notice } from "../fakes/obsidian";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const FORK = "Social/Event X/Event X – LinkedIn – Acme Studio.md";

describe("ActionsBar", () => {
  it("forks one channel into its own note and offers to open it", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const open = vi.spyOn(ctx.composer, "openComposer").mockResolvedValue();
    render(ActionsBar, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Fork for this page…" }));
    expect(Menu.last!.items.map((i) => i.title)).toEqual(["Me", "Acme Studio", "Maker Lab"]);
    Menu.last!.items[1]!.click();
    await indexed(index, () => index.getVariant(FORK) !== undefined && index.getVariant(LI)!.channels.length === 2);
    expect(index.getVariant(FORK)!.channels).toEqual(["li/acme-studio"]);
    expect(index.getVariant(FORK)!.deliveries["li/acme-studio"]?.status).toBe("awaiting_you");
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/maker-lab"]);
    expect(Notice.messages.at(-1)).toBe("Forked Acme Studio into its own note. Open in composer");
    Notice.last!.noticeEl.querySelector("button")!.click();
    expect(open).toHaveBeenCalledWith(FORK);
  });

  it("offers no fork for a single-channel post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(ActionsBar, { props: { variant: index.getVariant("Social/Event X/Event X – X.md")! }, context: osmmContext(ctx) });
    expect(screen.queryByRole("button", { name: "Fork for this page…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview campaign" })).toBeTruthy();
  });

  it("explains a failed fork", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    vi.spyOn(ctx.composer["deps"].factory, "forkVariant").mockRejectedValue(new Error("Cannot fork the only channel of a post"));
    expect(await ctx.composer.fork(index.getVariant(LI)!, "li/me")).toBeNull();
    expect(Notice.messages.at(-1)).toBe("Cannot fork the only channel of a post");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/composer/actionsBar.test.ts`
Expected: FAIL — `ActionsBar.svelte` missing.

- [ ] **Step 3: Add the fork action and the action row**

In `src/composer/actions.ts`, add to `ComposerActions`:
```ts
  /** Moves one channel into its own note (spec §2.2). Creates a file, so there is no undo. */
  async fork(v: IndexedVariant, channelId: string): Promise<string | null> {
    const name = this.deps.channels.get(channelId)?.name ?? channelId;
    try {
      const file = await this.deps.factory.forkVariant(v.file, channelId, name);
      this.deps.planner.actionNotice(`Forked ${name} into its own note.`, "Open in composer", () => this.openComposer(file.path));
      return file.path;
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
```

`src/composer/ActionsBar.svelte`:
```svelte
<script lang="ts">
  import { Menu } from "obsidian";
  import type { IndexedVariant } from "../index/socialIndex";
  import { useOsmm } from "../ui/context";

  let { variant }: { variant: IndexedVariant } = $props();
  const { channels, composer } = useOsmm();

  function forkMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const id of variant.channels) {
      menu.addItem((item) => item.setTitle(channels.get(id)?.name ?? id).onClick(() => void composer.fork(variant, id)));
    }
    menu.showAtMouseEvent(event);
  }
</script>

<section class="osmm-panel" aria-label="Actions">
  <div class="osmm-chips">
    {#if variant.channels.length > 1}<button type="button" onclick={forkMenu}>Fork for this page…</button>{/if}
    {#if variant.campaignPath}
      <button type="button" onclick={() => void composer.openPreviewGrid(variant.campaignPath!)}>Preview campaign</button>
    {/if}
  </div>
</section>
```

In `src/composer/Composer.svelte`, add `import ActionsBar from "./ActionsBar.svelte";` and, right before `</aside>`:
```svelte
        <ActionsBar {variant} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composer test/composer
git commit -m "feat(composer): add the action row with Fork for this page (refs #52)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Media attach, alt text and crop preview in the Composer (#53, #45 part 2)

**Files:**
- Create: `src/composer/MediaPanel.svelte`, `test/composer/media.test.ts`
- Modify: `src/composer/actions.ts` (`attachFiles`, `moveMedia`, `removeMedia`, `setAlt`, `setFocus`), `src/composer/Composer.svelte`, `src/styles/composer.css`, `test/fakes/obsidian.ts` (`FileManager.getAvailablePathForAttachment`)

**Interfaces:**
- Consumes: `MediaMeta`, `VariantPatch.mediaMeta` (Task 5); `cropRect`, `feedRatio`, `focusFromPoint` (Task 5); `MediaInspector` (Task 5, via `composer.media`); `platformDef` (Task 1).
- Produces:
  - `ComposerActions.attachFiles(v, files: readonly File[]): Promise<number>` — PNG, JPG, WebP and GIF are saved with `fileManager.getAvailablePathForAttachment` + `vault.createBinary` and appended to `media:`; videos are accepted but checks flag them as unsupported (Task 4); other files are refused with a Notice.
  - `moveMedia(v, target, delta: -1 | 1)`, `removeMedia(v, target)` (also drops its `media_meta` entry), `setAlt(v, target, alt)`, `setFocus(v, target, focus)` — each one `PlannerActions.write` with Undo.
  - `<MediaPanel variant media>` — drop zone and "Add image…" file input; per item: thumbnail with the platform's crop box, a button that sets the focal point on click (arrow keys nudge it by 0.05), size and dimensions, an "Alt text" input, and move up / move down / remove buttons.
  - Fake: `FileManager.getAvailablePathForAttachment(filename, sourcePath?)` — next to the source note, `name 1.ext`, `name 2.ext`, … on collisions.

- [ ] **Step 1: Write the failing test**

`test/composer/media.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Notice } from "../fakes/obsidian";
import MediaPanel from "../../src/composer/MediaPanel.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { png } from "../media/bytes";
import { makeCtx, type TestCtx } from "../ui/ctx";

const IG = "Social/Event X/Event X – Instagram.md";
const image = (name: string, width = 1080, height = 1350) => new File([png(width, height)], name, { type: "image/png" });

async function attach(c: TestCtx, ...files: File[]): Promise<void> {
  await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, files);
}

async function renderPanel(c: TestCtx): Promise<void> {
  const v = c.index.getVariant(IG)!;
  render(MediaPanel, { props: { variant: v, media: await c.ctx.composer.media.inspect(v) }, context: osmmContext(c.ctx) });
}

describe("media attach", () => {
  it("saves an image next to the note and adds it to media:", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, [image("crowd.png")])).toBe(1);
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    expect(c.app.vault.getFileByPath("Social/Event X/crowd.png")).not.toBeNull();
    const info = await c.ctx.composer.media.inspect(c.index.getVariant(IG)!);
    expect(info.find((m) => m.target === "crowd.png")).toMatchObject({ kind: "image", width: 1080, height: 1350 });
  });

  it("keeps both files when names collide", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd 1.png"));
    expect(c.index.getVariant(IG)!.media).toEqual(["event-x-cover.png", "crowd.png", "crowd 1.png"]);
  });

  it("refuses other files and flags videos as unsupported", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, [new File(["x"], "doc.pdf")])).toBe(0);
    expect(Notice.messages.at(-1)).toBe("doc.pdf: use a PNG, JPG, WebP or GIF image.");
    await attach(c, new File([new Uint8Array([0, 0, 0])], "clip.mp4", { type: "video/mp4" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("clip.mp4"));
    const v = c.index.getVariant(IG)!;
    const issues = c.ctx.composer.check(v, await c.ctx.composer.content.load(v));
    expect(issues.map((i) => i.message)).toContain("clip.mp4: video isn't supported yet. Remove it or use an image.");
  });

  it("edits alt text and the focal point from the panel", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await renderPanel(c);
    await fireEvent.change(screen.getByLabelText("Alt text"), { target: { value: "Makers at laptops" } });
    await indexed(c.index, () => c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.alt === "Makers at laptops");
    await fireEvent.keyDown(screen.getByRole("button", { name: "Set the focal point of crowd.png" }), { key: "ArrowRight" });
    await indexed(c.index, () => c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.focus?.[0] === 0.55);
    expect(c.index.getVariant(IG)!.mediaMeta).toEqual({ "crowd.png": { alt: "Makers at laptops", focus: [0.55, 0.5] } });
  });

  it("reorders and removes media, with undo", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await renderPanel(c);
    await fireEvent.click(screen.getByRole("button", { name: "Move crowd.png up" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media[0] === "crowd.png");
    await fireEvent.click(screen.getByRole("button", { name: "Remove event-x-cover.png" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.length === 1);
    expect(c.index.getVariant(IG)!.media).toEqual(["crowd.png"]);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(c.index, () => c.index.getVariant(IG)!.media.length === 2);
    expect(c.index.getVariant(IG)!.media).toEqual(["crowd.png", "event-x-cover.png"]);
  });

  it("attaches files dropped on the panel", async () => {
    const c = await makeCtx({ seed: true });
    await renderPanel(c);
    await fireEvent.drop(screen.getByRole("group", { name: "Drop images here" }), { dataTransfer: { files: [image("drop.png")] } });
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("drop.png"));
    expect(c.index.getVariant(IG)!.media).toEqual(["event-x-cover.png", "drop.png"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/composer/media.test.ts`
Expected: FAIL — `attachFiles` is not a function; `MediaPanel.svelte` missing.

- [ ] **Step 3: Extend the fake file manager**

In `test/fakes/obsidian.ts`, add to `class FileManager`:
```ts
  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const folder = sourcePath?.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    const prefix = folder ? `${folder}/` : "";
    let candidate = `${prefix}${filename}`;
    for (let n = 1; this.app.vault.getAbstractFileByPath(candidate); n++) candidate = `${prefix}${base} ${n}${ext}`;
    return candidate;
  }
```

- [ ] **Step 4: Add the media actions**

In `src/composer/actions.ts`, change the types import to `import type { Channel, ChannelGroup, Delivery, Issue, MediaMeta, PostMode, Variant } from "../model/types";`, add these module-level helpers above the class:
```ts
const ATTACHABLE_RE = /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i;

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}
```
and these methods to `ComposerActions`:
```ts
  /** Saves files to the attachments folder and appends them to `media:`. Videos are kept; checks flag them. */
  async attachFiles(v: IndexedVariant, files: readonly File[]): Promise<number> {
    const added: string[] = [];
    for (const f of files) {
      if (!ATTACHABLE_RE.test(f.name)) {
        new Notice(`${f.name}: use a PNG, JPG, WebP or GIF image.`);
        continue;
      }
      const path = await this.deps.app.fileManager.getAvailablePathForAttachment(f.name, v.path);
      const created = await this.deps.app.vault.createBinary(path, await readFile(f));
      added.push(created.name);
    }
    if (!added.length) return 0;
    const result = await this.deps.planner.write(v.file, (fresh) => ({
      fields: { media: [...fresh.media, ...added.filter((a) => !fresh.media.includes(a))] },
    }));
    this.deps.planner.afterWrite(result, `Attached ${added.length} file${added.length === 1 ? "" : "s"}.`);
    return added.length;
  }

  async moveMedia(v: IndexedVariant, target: string, delta: -1 | 1): Promise<void> {
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const i = fresh.media.indexOf(target);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= fresh.media.length) return {};
      const media = [...fresh.media];
      [media[i], media[j]] = [media[j]!, media[i]!];
      return { fields: { media } };
    });
    this.deps.planner.afterWrite(result, "Media reordered.");
  }

  async removeMedia(v: IndexedVariant, target: string): Promise<void> {
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const mediaMeta = { ...fresh.mediaMeta };
      delete mediaMeta[target];
      return { fields: { media: fresh.media.filter((m) => m !== target), mediaMeta } };
    });
    this.deps.planner.afterWrite(result, `Removed ${target} from the post.`);
  }

  setAlt(v: IndexedVariant, target: string, alt: string): Promise<void> {
    return this.patchMediaMeta(v, target, { alt: alt.trim() }, "Alt text saved.");
  }

  setFocus(v: IndexedVariant, target: string, focus: [number, number]): Promise<void> {
    return this.patchMediaMeta(v, target, { focus }, "Focal point saved.");
  }

  private async patchMediaMeta(v: IndexedVariant, target: string, patch: MediaMeta, message: string): Promise<void> {
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const next: MediaMeta = { ...fresh.mediaMeta?.[target], ...patch };
      if (!next.alt) delete next.alt;
      return { fields: { mediaMeta: { ...fresh.mediaMeta, [target]: next } } };
    });
    this.deps.planner.afterWrite(result, message);
  }
```

- [ ] **Step 5: Write the panel**

`src/composer/MediaPanel.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { cropRect, feedRatio, focusFromPoint } from "../media/crop";
  import { platformDef } from "../platforms/registry";
  import type { MediaInfo } from "../platforms/types";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";

  let { variant, media }: { variant: IndexedVariant; media: MediaInfo[] } = $props();
  const { composer } = useOsmm();
  let dragging = $state(false);
  const rules = $derived(platformDef(variant.platform).capabilities.media);

  const size = (n?: number) => (n === undefined ? "" : n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 100) / 100));

  /** The crop box the current platform's feed shows, as CSS percentages of the thumbnail. */
  function cropBox(m: MediaInfo): string | null {
    if (m.kind !== "image" || !m.width || !m.height) return null;
    const ratio = feedRatio(rules, { width: m.width, height: m.height });
    if (!ratio) return null;
    const r = cropRect({ width: m.width, height: m.height }, ratio, m.focus);
    return `left:${(r.x / m.width) * 100}%;top:${(r.y / m.height) * 100}%;width:${(r.width / m.width) * 100}%;height:${(r.height / m.height) * 100}%`;
  }

  function pickFocus(event: MouseEvent, m: MediaInfo): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    void composer.setFocus(variant, m.target, focusFromPoint(event.clientX, event.clientY, box));
  }

  function nudgeFocus(event: KeyboardEvent, m: MediaInfo): void {
    const [x, y] = m.focus ?? [0.5, 0.5];
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [x - 0.05, y],
      ArrowRight: [x + 0.05, y],
      ArrowUp: [x, y - 0.05],
      ArrowDown: [x, y + 0.05],
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    void composer.setFocus(variant, m.target, [clamp(next[0]), clamp(next[1])]);
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) await composer.attachFiles(variant, files);
  }

  async function onChoose(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) await composer.attachFiles(variant, files);
  }
</script>

<section class="osmm-panel" aria-label="Media">
  <h4 class="osmm-section-title">Media</h4>
  <div
    class="osmm-dropzone"
    class:is-drop={dragging}
    role="group"
    aria-label="Drop images here"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => void onDrop(e)}>
    <span>Drop images here, or</span>
    <label class="osmm-file">
      Add image…
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/*" multiple onchange={(e) => void onChoose(e)} />
    </label>
  </div>
  <ol class="osmm-media-list">
    {#each media as m, i (m.target)}
      {@const box = cropBox(m)}
      <li class="osmm-media-item">
        {#if m.kind === "image" && m.path}
          <button
            type="button"
            class="osmm-crop"
            aria-label={`Set the focal point of ${m.target}`}
            onclick={(e) => pickFocus(e, m)}
            onkeydown={(e) => nudgeFocus(e, m)}>
            <img src={composer.media.resourceUrl(m.path)} alt={m.alt ?? ""} />
            {#if box}<span class="osmm-crop-box" style={box}></span>{/if}
          </button>
        {:else}
          <span class="osmm-media-missing">{m.kind === "missing" ? "Not found" : m.kind === "video" ? "Video" : "File"}</span>
        {/if}
        <div class="osmm-media-meta">
          <span class="osmm-row-title">{m.target}</span>
          <span class="osmm-progress">{m.width && m.height ? `${m.width}×${m.height} · ` : ""}{size(m.bytes)}</span>
          {#if m.kind === "image"}
            <label>Alt text<input type="text" value={m.alt ?? ""} onchange={(e) => void composer.setAlt(variant, m.target, e.currentTarget.value)} /></label>
          {/if}
          <div class="osmm-row">
            <button type="button" class="clickable-icon" aria-label={`Move ${m.target} up`} disabled={i === 0} onclick={() => void composer.moveMedia(variant, m.target, -1)}><span use:icon={"arrow-up"}></span></button>
            <button type="button" class="clickable-icon" aria-label={`Move ${m.target} down`} disabled={i === media.length - 1} onclick={() => void composer.moveMedia(variant, m.target, 1)}><span use:icon={"arrow-down"}></span></button>
            <button type="button" class="clickable-icon" aria-label={`Remove ${m.target}`} onclick={() => void composer.removeMedia(variant, m.target)}><span use:icon={"trash-2"}></span></button>
          </div>
        </div>
      </li>
    {/each}
  </ol>
</section>
```

In `src/composer/Composer.svelte`, add `import MediaPanel from "./MediaPanel.svelte";` and, right before `<ActionsBar {variant} />`:
```svelte
        <MediaPanel {variant} {media} />
```

Append to `src/styles/composer.css`:
```css
.osmm-dropzone { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px; border: 1px dashed var(--text-faint); border-radius: 8px; color: var(--text-muted); }
.osmm-dropzone.is-drop { border-color: var(--interactive-accent); background: rgba(var(--interactive-accent-rgb), 0.08); }
.osmm-file { display: inline-flex; align-items: center; color: var(--text-accent); cursor: pointer; }
.osmm-file input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.osmm-media-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.osmm-media-item { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; }
.osmm-crop { position: relative; width: 96px; height: auto; padding: 0; overflow: hidden; background: var(--background-secondary); box-shadow: none; cursor: crosshair; }
.osmm-crop img { display: block; width: 100%; }
.osmm-crop-box { position: absolute; border: 2px solid var(--interactive-accent); box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.45); pointer-events: none; }
.osmm-media-missing { display: flex; align-items: center; justify-content: center; width: 96px; height: 72px; border-radius: 6px; background: var(--background-secondary); color: var(--text-faint); font-size: var(--font-ui-smaller); }
.osmm-media-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (whole suite).

- [ ] **Step 7: Commit**

```bash
git add src/composer src/styles/composer.css test/composer test/fakes/obsidian.ts
git commit -m "feat(composer): attach media with alt text, focal point and crop preview (refs #53, #45)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: M2a acceptance pass

**Files:**
- Create: `docs/qa/m2a.md`

**Interfaces:**
- Produces: a manual QA checklist, run once in Obsidian, with results recorded in the PR description.

- [ ] **Step 1: Write the checklist**

`docs/qa/m2a.md`:
```markdown
# M2a manual QA — platforms, previews, composer

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+, enable the plugin.
Run every check in the default dark and light themes and one community theme (e.g. Minimal).

## Composer (mockup 3)
- [ ] "Open composer for this post" on a variant opens the composer in a split next to the note; on a campaign or plain note the command is not offered.
- [ ] Typing in the editor updates the preview almost at once (well under a second); switching notes never shows the previous note's text.
- [ ] Platform tabs list the campaign's variants; clicking one opens that note in the editor pane, not in the composer pane.
- [ ] Mobile / Desktop toggle changes the preview width; "Preview as" switches the channel name and avatar colour.
- [ ] Post as: toggling a channel writes `channels:`; toggling off the published "Me" channel on Event X – LinkedIn is refused with a notice; "Add group: All LinkedIn pages" adds the pages; Undo works.
- [ ] Checks: counters update while typing; a LinkedIn text over 3 000 characters shows Blocking and disables Schedule; a link in the text shows an Advisory.
- [ ] Quick fixes: an HN variant without url in Event X offers "Use the campaign link"; a WordPress post without slug offers `Use slug "…"`, with Undo.
- [ ] Schedule: date/time, reminder chips (add/remove), Mode; Schedule writes `scheduled_at`, `reminders` and deliveries in one change (check the note); a past time asks first; Update schedule on Event X – LinkedIn leaves the published "Me" delivery untouched.
- [ ] Fork for this page… on Event X – LinkedIn creates "Event X – LinkedIn – Acme Studio" and offers "Open in composer".
- [ ] Media: drop a PNG, a JPG, a WebP and a GIF from the desktop; each lands next to the note and in `media:`; an MP4 is attached and flagged "video isn't supported yet"; a PDF is refused.
- [ ] Media: alt text persists in `media_meta`; clicking the thumbnail moves the crop box (X: 16:9, Instagram: 4:5 to 1.91:1) and the focal point persists; arrow keys nudge it; move up/down/remove work and Remove can be undone.

## Previews (mockups 3 and 5)
- [ ] Every platform renders: LinkedIn fold with "…see more", X/Bluesky/Mastodon threads numbered, Instagram image first, Facebook link card, Telegram channel post with bold heading, Discord message, WhatsApp bubble with *bold*, HN title + (domain), Reddit subreddit, Indie Hackers title, WordPress article with featured image and headings.
- [ ] Previews look like stylized approximations in both themes (no broken contrast, no platform logos).
- [ ] "Preview all" in the `social-variants` table and "Preview all variants of this campaign" open the grid; 12+ variants wrap without horizontal scrolling; blocking/advisory counts are right.
- [ ] "Approve all ready" schedules the ready variants that have a future time and no blocking issue, and Undo restores them.

## Platform numbers marked approximate in code
Check each against the platform's current documentation and note differences in the PR:
- [ ] LinkedIn: image count (9) and size (8 MB).
- [ ] X: image size (5 MB), timeline crop (16:9).
- [ ] Instagram: fold (125), carousel (10), size (8 MB).
- [ ] Facebook: fold (480), images (10), size (10 MB).
- [ ] Mastodon: image size (8 MB default instance), crop (16:9).
- [ ] Bluesky: image size (about 1 MB).
- [ ] Telegram: album (10), photo size (10 MB). Discord: attachments (10), size (10 MB).
- [ ] WhatsApp: message length (65 536), media. HN: text length (4 000). Indie Hackers: title (150), text, image size. Reddit: self-text (40 000), gallery (20), size (20 MB). WordPress: upload size (20 MB).
```

- [ ] **Step 2: Run the full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 3: Walk through the checklist and fix what fails**

Work through `docs/qa/m2a.md` in Obsidian. For each failure, add a failing test in the owning module first, fix the problem, and commit with `fix(...)`. Correct any approximate number that turned out wrong in the platform's folder and in the test that pins it.

- [ ] **Step 4: Commit**

```bash
git add docs/qa/m2a.md
git commit -m "docs(qa): add M2a manual QA checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M2a Done Checklist

- [ ] All 15 tasks committed on `feat/m2-one-click-posting`; `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] Every item in `docs/qa/m2a.md` checked in light and dark themes.
- [ ] Issues #40–#46 and #48–#51, #53 can be closed; #52 stays open until M2b adds Post now and Copy & open.
- [ ] Continue with M2b: `docs/superpowers/plans/2026-09-29-m2b-assisted-publishing-and-scheduler.md`.
