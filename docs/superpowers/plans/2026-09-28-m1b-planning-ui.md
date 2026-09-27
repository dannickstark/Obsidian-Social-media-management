# M1b — Planning UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the user a visual planning surface inside Obsidian: a Planner view (Month / Week / Board / List) with filters and drag-and-drop, a sidebar (Overdue, Up next, Campaigns), an interactive `social-variants` table with a campaign timeline and schedule templates, quick-create commands, and a Channels settings UI.

**Architecture:** Svelte 5 components mounted in Obsidian `ItemView`s, modals and a `MarkdownRenderChild`. Every component reads one `OsmmContext` (Svelte context), which provides stores (`settings`, `snapshot`, `now`, `viewState`), the `ChannelRegistry` and `PlannerActions`. All decision logic lives in pure modules under `src/planner/`, tested first; components stay thin and call `PlannerActions`, which writes through `SafeWriter` / `NoteFactory` from M1a.

**Tech Stack:** Svelte 5 (runes), Obsidian API (`ItemView`, `Modal`, `Menu`, `Notice`, `setIcon`, `SecretComponent`), @testing-library/svelte 5, Vitest 5 (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§3 UX, §2.4 channels). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z (artboards 1 Calendar, 2 Campaign, 4 Board, 8 Channels).

**Depends on:** M1a (`docs/superpowers/plans/2026-09-27-m1a-core-engine.md`) merged. Branch `feat/m1b-planning-ui` from the M1a branch.

**Issues covered:** #8 (theming) · #25 (channels UI) · #29 #30 #31 #32 #33 #34 #35 #36 #37 #38 (E4).

## Global Constraints

- All M1a global constraints apply: SafeWriter for every frontmatter write, dates via `formatDateTime`/`parseDateTime`, secrets only in `app.secretStorage`, and tests run in `TZ=Europe/Berlin`.
- Colours come from Obsidian CSS variables, except the platform badge colours in `PLATFORM_COLORS`, which always use `#141418` text and must have contrast ≥ 4.5:1.
- Only real controls are interactive (`<button>`, `<input>`, `<select>`). Icon-only buttons have an `aria-label`.
- Icons use Obsidian's `setIcon` (Lucide names), through the `icon` Svelte action. No emoji.
- Features from later milestones (Post now, composer, Claude actions, token health) are **not** rendered in M1b, not even as disabled buttons.
- Device-local UI state (planner mode, filters) is stored in `app.saveLocalStorage("osmm-view-state")`, never in `data.json`.
- Every write triggered from the UI shows a `Notice`. Moves and bulk edits offer **Undo**.

## Review Focus

1. **Dragging the second channel of a staggered multi-channel post.** The dragged row should land exactly where it was dropped and the other channels should move with it, keeping their stagger. Test in Task 6.
2. **A week or month that spans the DST change (25 Oct 2026)**, and a Sunday week start. Days must not duplicate or go missing, and 09:00 must render at 09:00. Tests in Tasks 4 and 5.
3. **Moving a post that was already handed over or published** (board or calendar). The move should be refused with an explanation, or require confirmation, and must never silently rewrite delivery history. Tests in Tasks 6 and 7.
4. **Filters pointing at channels or campaigns that no longer exist** (deleted channel, renamed campaign). The view should still show posts, not an empty screen. Test in Task 3.
5. **Bulk status changes on posts where some channels are already published.** Those posts should be skipped and reported, not partially rewritten. Test in Task 8.

---

## File Structure

```
src/styles/index.css            imports the files below
src/styles/tokens.css           .osmm token layer + badges + chip styles (#8)
src/styles/planner.css          toolbar, month, week, board, list, sidebar, table
src/ui/colors.ts                PLATFORM_COLORS, contrastRatio()
src/ui/format.ts                formatTime, formatShortDate, monthTitle, weekTitle, initials
src/ui/icon.ts                  `use:icon` Svelte action
src/ui/context.ts               OsmmContext, osmmContext(), useOsmm(), clock()
src/ui/SvelteView.ts            SvelteItemView base class + SvelteRenderChild
src/ui/dialogs.ts               confirmDialog(), pickDateTime(), SvelteModal
src/ui/actions.ts               PlannerActions (all UI side effects)
src/ui/PlatformBadge.svelte     badge
src/ui/ChannelAvatar.svelte     initials avatar
src/planner/status.ts           chipStyle(), STATUS_LABEL, FILTERABLE_STATUSES
src/planner/viewState.ts        PlannerMode, PlannerFilter, viewStateStore(), toRowFilter()
src/planner/calendar.ts         monthGrid, weekCells, groupByDay, layoutDay, ranges
src/planner/reschedule.ts       planReschedule()
src/planner/board.ts            columnOf, planBoardMove, schedule/unschedule deliveries
src/planner/list.ts             sortRows, bulk planning
src/planner/campaignTable.ts    campaignTable()
src/planner/templates.ts        ScheduleTemplate, parse/format lines, planTemplate, timeline
src/views/PlannerView.ts        VIEW_PLANNER
src/views/SidebarView.ts        VIEW_SIDEBAR
src/views/Planner.svelte        toolbar + mode switch
src/views/ViewSwitcher.svelte, FilterBar.svelte, Legend.svelte, Chip.svelte
src/views/MonthView.svelte, WeekView.svelte, BoardView.svelte, ListView.svelte
src/views/Sidebar.svelte
src/views/CampaignTable.svelte, Timeline.svelte, TemplatePreview.svelte
src/views/QuickCreate.svelte
src/settings/ChannelsSection.svelte, ChannelForm.svelte, GroupForm.svelte
src/commands.ts                 command + ribbon registration
test/ui/ctx.ts                  makeCtx() test context
```

---

### Task 1: Theming tokens, platform colours and badges (#8)

**Files:**
- Create: `src/styles/tokens.css`, `src/styles/planner.css`, `src/ui/colors.ts`, `src/ui/format.ts`, `src/ui/icon.ts`, `src/ui/PlatformBadge.svelte`, `src/ui/ChannelAvatar.svelte`, `test/ui/colors.test.ts`, `test/ui/format.test.ts`, `test/ui/badge.test.ts`
- Modify: `src/styles/index.css`, `test/fakes/obsidian.ts` (add `setIcon`), `test/setup.ts` (add `addClass`/`removeClass`/`toggleClass`)

**Interfaces:**
- Produces: `PLATFORM_COLORS: Record<Platform, string>`, `BADGE_TEXT = "#141418"`, `contrastRatio(a: string, b: string): number`; `formatTime(ms)`, `formatShortDate(ms, locale?)`, `monthTitle(year, month, locale?)`, `weekTitle(from, to, locale?)`, `initials(name)`; the Svelte action `icon(node, name)`; components `<PlatformBadge platform size?>` and `<ChannelAvatar channel size?>`.

- [ ] **Step 1: Write the failing tests**

`test/ui/colors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../../src/model/platforms";
import { BADGE_TEXT, PLATFORM_COLORS, contrastRatio } from "../../src/ui/colors";

describe("platform colours", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it.each(PLATFORMS)("%s badge text has ≥ 4.5:1 contrast", (platform) => {
    expect(contrastRatio(PLATFORM_COLORS[platform], BADGE_TEXT)).toBeGreaterThanOrEqual(4.5);
  });
});
```

`test/ui/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatTime, initials, monthTitle, weekTitle } from "../../src/ui/format";

describe("format", () => {
  it("formats local times", () => {
    expect(formatTime(Date.UTC(2026, 9, 8, 15, 30))).toBe("17:30");
  });
  it("titles months and weeks", () => {
    expect(monthTitle(2026, 9, "en")).toBe("October 2026");
    expect(weekTitle(new Date(2026, 9, 19).getTime(), new Date(2026, 9, 25).getTime(), "en")).toBe("Oct 19 – Oct 25, 2026");
  });
  it.each([
    ["Acme Studio", "AS"],
    ["@acmestudio", "AC"],
    ["eventx.berlin", "EB"],
    ["Me", "ME"],
    ["", "?"],
  ])("initials(%s) = %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
```

`test/ui/badge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import PlatformBadge from "../../src/ui/PlatformBadge.svelte";

describe("PlatformBadge", () => {
  it("shows the short badge with an accessible label", () => {
    render(PlatformBadge, { props: { platform: "linkedin" } });
    const badge = screen.getByRole("img", { name: "LinkedIn" });
    expect(badge.textContent).toBe("in");
    expect(badge.getAttribute("style")).toContain("--osmm-platform: #6ea3e6");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/ui`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement colours, format and the icon action**

`src/ui/colors.ts`:
```ts
import type { Platform } from "../model/platforms";

/** Badge text colour; every platform colour must keep ≥ 4.5:1 against it. */
export const BADGE_TEXT = "#141418";

export const PLATFORM_COLORS: Readonly<Record<Platform, string>> = {
  linkedin: "#6ea3e6",
  x: "#e6e4df",
  instagram: "#e38bb4",
  facebook: "#8aa3f0",
  mastodon: "#a99bf6",
  bluesky: "#68b9f2",
  telegram: "#5cc6d6",
  discord: "#a0a7f3",
  hackernews: "#f29a5c",
  indiehackers: "#6fc4ae",
  reddit: "#f08a6a",
  whatsapp: "#7fd39a",
  wordpress: "#b9b3a6",
};

function channelLuminance(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((n >> 16) & 255) +
    0.7152 * channelLuminance((n >> 8) & 255) +
    0.0722 * channelLuminance(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
```

`src/ui/format.ts`:
```ts
const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatShortDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}

export function monthTitle(year: number, month: number, locale?: string): string {
  return new Date(year, month, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
}

export function weekTitle(from: number, to: number, locale?: string): string {
  const a = new Date(from).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const b = new Date(to).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  return `${a} – ${b}`;
}

export function initials(name: string): string {
  const words = name.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}
```

`src/ui/icon.ts`:
```ts
import { setIcon } from "obsidian";

/** Svelte action: `<span use:icon={"calendar-days"}></span>` renders an Obsidian (Lucide) icon. */
export function icon(node: HTMLElement, name: string) {
  setIcon(node, name);
  return {
    update(next: string) {
      node.replaceChildren();
      setIcon(node, next);
    },
  };
}
```

Add to `test/fakes/obsidian.ts`:
```ts
export function setIcon(el: HTMLElement, name: string): void {
  el.dataset.icon = name;
}
```

Add to `test/setup.ts` (inside the `declare global` block and below it):
```ts
declare global {
  interface HTMLElement {
    empty(): void;
    addClass(...cls: string[]): void;
    removeClass(...cls: string[]): void;
    toggleClass(cls: string, value: boolean): void;
  }
}

HTMLElement.prototype.addClass = function addClass(this: HTMLElement, ...cls: string[]) {
  this.classList.add(...cls);
};
HTMLElement.prototype.removeClass = function removeClass(this: HTMLElement, ...cls: string[]) {
  this.classList.remove(...cls);
};
HTMLElement.prototype.toggleClass = function toggleClass(this: HTMLElement, cls: string, value: boolean) {
  this.classList.toggle(cls, value);
};
```

- [ ] **Step 4: Implement the badge and avatar components**

`src/ui/PlatformBadge.svelte`:
```svelte
<script lang="ts">
  import { PLATFORM_META, type Platform } from "../model/platforms";
  import { PLATFORM_COLORS } from "./colors";

  let { platform, size = "sm" }: { platform: Platform; size?: "sm" | "md" } = $props();
  const meta = $derived(PLATFORM_META[platform]);
</script>

<span class="osmm-badge" data-size={size} role="img" aria-label={meta.label} style:--osmm-platform={PLATFORM_COLORS[platform]}>{meta.badge}</span>
```

`src/ui/ChannelAvatar.svelte`:
```svelte
<script lang="ts">
  import type { Channel } from "../model/types";
  import { initials } from "./format";

  let { channel, size = 22 }: { channel: Channel; size?: number } = $props();
</script>

<span
  class="osmm-avatar"
  class:is-round={channel.kind === "profile"}
  role="img"
  aria-label={channel.name}
  style:--osmm-avatar={channel.avatarColor}
  style:width="{size}px"
  style:height="{size}px">{initials(channel.name)}</span>
```

- [ ] **Step 5: Write the stylesheets**

`src/styles/index.css`:
```css
/* OSMM Social Planner */
@import "./tokens.css";
@import "./planner.css";
```

`src/styles/tokens.css`:
```css
.osmm {
  --osmm-radius: 6px;
  --osmm-gap: 8px;
  --osmm-border: var(--background-modifier-border);
  --osmm-hover: var(--background-modifier-hover);
  --osmm-muted: var(--text-muted);
  --osmm-faint: var(--text-faint);
  --osmm-accent: var(--interactive-accent);
  --osmm-badge-text: #141418;
  font-size: var(--font-ui-small);
}

.osmm-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--osmm-platform);
  color: var(--osmm-badge-text);
  font-family: var(--font-monospace);
  font-size: 9.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.osmm-badge[data-size="md"] { min-width: 22px; height: 20px; font-size: 10.5px; border-radius: 5px; }

.osmm-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: var(--osmm-avatar);
  color: var(--osmm-badge-text);
  font-size: 9.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.osmm-avatar.is-round { border-radius: 50%; }

.osmm-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 22px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-normal);
  font-size: var(--font-ui-smaller);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
  box-shadow: none;
}
.osmm-chip-time { font-family: var(--font-monospace); font-size: 10.5px; opacity: 0.8; }
.osmm-chip-title { overflow: hidden; text-overflow: ellipsis; }
.osmm-chip[data-style="auto"] { background: var(--osmm-hover); border-color: var(--osmm-border); }
.osmm-chip[data-style="assisted"] { border: 1px dashed var(--text-faint); }
.osmm-chip[data-style="overdue"] { border-color: var(--color-orange); background: rgba(var(--color-orange-rgb), 0.15); }
.osmm-chip[data-style="attention"] { border-color: var(--color-red); background: rgba(var(--color-red-rgb), 0.12); }
.osmm-chip[data-style="draft"] { border: 1px dotted var(--text-faint); color: var(--text-muted); font-style: italic; }
.osmm-chip[data-style="published"] { color: var(--text-faint); }
.osmm-chip[data-style="published"] .osmm-badge { opacity: 0.55; }
.osmm-chip:focus-visible { outline: 2px solid var(--osmm-accent); outline-offset: 1px; }
```

`src/styles/planner.css`:
```css
.osmm-planner { display: flex; flex-direction: column; height: 100%; }
.osmm-toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--osmm-border); }
.osmm-title { margin: 0; font-size: var(--font-ui-large); font-weight: 600; }
.osmm-spacer { flex: 1; }
.osmm-nav { display: flex; gap: 4px; }
.osmm-subbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 16px; }
.osmm-body { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 16px; }
.osmm-segmented { display: flex; padding: 2px; border: 1px solid var(--osmm-border); border-radius: 7px; }
.osmm-segmented button { box-shadow: none; background: transparent; color: var(--osmm-muted); }
.osmm-segmented button.is-active { background: var(--osmm-hover); color: var(--text-normal); }
.osmm-filterbar { display: flex; gap: 6px; align-items: center; }
.osmm-legend { display: flex; gap: 14px; color: var(--osmm-muted); font-size: var(--font-ui-smaller); }
.osmm-legend .osmm-chip { width: auto; height: 16px; padding: 0 5px; }

.osmm-month { display: grid; grid-template-rows: auto; }
.osmm-month-head, .osmm-month-row { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.osmm-month-head div { padding: 4px 6px; color: var(--osmm-faint); text-transform: uppercase; font-size: var(--font-ui-smaller); }
.osmm-day { min-height: 110px; padding: 6px; display: flex; flex-direction: column; gap: 3px; border-right: 1px solid var(--osmm-border); border-bottom: 1px solid var(--osmm-border); min-width: 0; }
.osmm-month-row:first-of-type .osmm-day { border-top: 1px solid var(--osmm-border); }
.osmm-month-row .osmm-day:first-child { border-left: 1px solid var(--osmm-border); }
.osmm-day.is-muted { background: var(--background-secondary); }
.osmm-day.is-today .osmm-day-num { background: var(--osmm-accent); color: var(--text-on-accent); border-radius: 10px; padding: 0 6px; }
.osmm-day.is-drop { outline: 2px dashed var(--osmm-accent); outline-offset: -2px; }
.osmm-day-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.osmm-day-num { font-weight: 600; font-size: var(--font-ui-smaller); }
.osmm-anchor { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; background: rgba(var(--interactive-accent-rgb), 0.2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osmm-more { box-shadow: none; background: transparent; color: var(--osmm-muted); font-size: var(--font-ui-smaller); padding: 0 6px; height: 20px; align-self: flex-start; }

.osmm-week { display: grid; grid-template-columns: 52px repeat(7, minmax(0, 1fr)); }
.osmm-week-head { position: sticky; top: 0; z-index: 2; background: var(--background-primary); padding: 6px; border-bottom: 1px solid var(--osmm-border); font-size: var(--font-ui-smaller); }
.osmm-week-head.is-today { color: var(--osmm-accent); font-weight: 600; }
.osmm-hours { position: relative; }
.osmm-hour { position: absolute; right: 6px; font-size: 10.5px; color: var(--osmm-faint); transform: translateY(-50%); }
.osmm-week-col { position: relative; border-left: 1px solid var(--osmm-border); background-image: linear-gradient(var(--osmm-border) 1px, transparent 1px); background-size: 100% 48px; }
.osmm-week-item { position: absolute; padding: 0 2px; box-sizing: border-box; }
.osmm-now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--color-red); z-index: 1; }

.osmm-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; height: 100%; }
.osmm-column { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 10px; background: var(--background-secondary); min-height: 0; overflow: auto; }
.osmm-column.is-drop { outline: 2px dashed var(--osmm-accent); }
.osmm-column-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.osmm-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 8px; border: 1px solid var(--osmm-border); background: var(--background-primary); text-align: left; cursor: grab; box-shadow: none; height: auto; white-space: normal; }
.osmm-card.is-late { border-color: var(--color-orange); }
.osmm-card-meta { display: flex; gap: 8px; color: var(--osmm-muted); font-size: var(--font-ui-smaller); }

.osmm-table { width: 100%; border-collapse: collapse; }
.osmm-table th, .osmm-table td { padding: 6px 8px; border-bottom: 1px solid var(--osmm-border); text-align: left; }
.osmm-table th button { box-shadow: none; background: transparent; padding: 0; font-weight: 600; }
.osmm-bulkbar { display: flex; gap: 8px; align-items: center; padding: 8px 0; }

.osmm-sidebar { display: flex; flex-direction: column; gap: 16px; padding: 12px; }
.osmm-section-title { font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.06em; color: var(--osmm-muted); font-weight: 600; margin: 0 0 6px; }
.osmm-overdue { border: 1px solid rgba(var(--color-orange-rgb), 0.6); background: rgba(var(--color-orange-rgb), 0.1); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.osmm-row { display: flex; align-items: center; gap: 8px; }
.osmm-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osmm-progress { font-family: var(--font-monospace); color: var(--osmm-muted); }

.osmm-variants { border: 1px solid var(--osmm-border); border-radius: 12px; overflow: hidden; }
.osmm-variants-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--osmm-border); }
.osmm-lenbar { height: 3px; background: var(--osmm-border); border-radius: 2px; }
.osmm-pill-status { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 10px; background: var(--osmm-hover); font-size: var(--font-ui-smaller); }
.osmm-timeline { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--osmm-border); }
.osmm-link { box-shadow: none; background: transparent; padding: 0; height: auto; color: var(--text-accent); text-align: left; cursor: pointer; }
.osmm-form { display: flex; flex-direction: column; gap: 10px; }
.osmm-form label { display: flex; flex-direction: column; gap: 4px; }
.osmm-issues { color: var(--text-error); margin: 0; padding-left: 18px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/ui && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): add theme tokens, platform colours, badges and formatting helpers (refs #8)"
```

---

### Task 2: UI context, actions, Svelte views and test harness

**Files:**
- Create: `src/ui/context.ts`, `src/ui/SvelteView.ts`, `src/ui/dialogs.ts`, `src/ui/actions.ts`, `test/ui/ctx.ts`, `test/ui/svelteView.test.ts`
- Modify: `test/fakes/obsidian.ts` (workspace/view/modal/menu fakes), `src/main.ts` (settings store + `uiContext()`)

**Interfaces:**
- Consumes: M1a `SocialIndex`, `indexStore`, `SafeWriter`, `NoteFactory`, `ChannelRegistry`, `OsmmSettings`, `PostRow`, `expandRows`.
- Produces:
  - `context.ts`: `interface OsmmContext { app; settings: Readable<OsmmSettings>; snapshot: Readable<IndexSnapshot>; now: Readable<number>; viewState: Writable<ViewState>; channels: ChannelRegistry; actions: PlannerActions }`, `OSMM_KEY`, `osmmContext(ctx): Map`, `useOsmm(): OsmmContext`, `clock(ms): Readable<number>`. (`ViewState` is defined in Task 3; this task imports it as a type, so Task 3's file must exist first. Create `src/planner/viewState.ts` here with the Task 3 contents' **types only** and complete it in Task 3.)
  - `SvelteView.ts`: `abstract class SvelteItemView<P> extends ItemView` (mounts on `onOpen`, destroys on `onClose`, adds class `osmm`); `class SvelteRenderChild<P> extends MarkdownRenderChild`.
  - `dialogs.ts`: `confirmDialog(app, message, cta?): Promise<boolean>`; `pickDateTime(app, title, initial: number): Promise<number | null>`; `class SvelteModal<P> extends Modal`.
  - `actions.ts`: `interface ActionDeps { app; writer; factory; channels; index; settings(): OsmmSettings; now(): number }`; `class PlannerActions { openNote(path, newLeaf?); hoverPreview(event, path); rowLabel(row): string; rows(): PostRow[]; rowByKey(key): PostRow | undefined; confirm(message, cta?): Promise<boolean>; undoNotice(message, undo): void }`.
  - `main.ts`: `settingsStore: Writable<OsmmSettings>` kept in sync by `updateSettings` and channel writes; `uiContext(): OsmmContext`.
  - `test/ui/ctx.ts`: `makeCtx(opts?): Promise<TestCtx>`.

- [ ] **Step 1: Extend the Obsidian fake**

Replace the `Workspace` class and the `App` constructor in `test/fakes/obsidian.ts`. Add the classes below **after the `Component` class**, because `ItemView` and `MarkdownRenderChild` extend it:
```ts
export class WorkspaceLeaf {
  view: ItemView | null = null;
  viewType: string | null = null;
  constructor(public app: App) {}
  async setViewState(state: { type: string; active?: boolean }): Promise<void> {
    this.viewType = state.type;
    const factory = this.app.workspace.viewFactories.get(state.type);
    if (factory) {
      this.view = factory(this);
      await this.view.onOpen();
    }
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
  }
  async detach(): Promise<void> {
    await this.view?.onClose();
    this.app.workspace.leaves = this.app.workspace.leaves.filter((l) => l !== this);
  }
}

export class Workspace extends Events {
  leaves: WorkspaceLeaf[] = [];
  viewFactories = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();
  opened: Array<{ linktext: string; newLeaf: boolean }> = [];
  activeFile: TFile | null = null;
  constructor(private readonly app: App) {
    super();
  }
  onLayoutReady(cb: () => void): void {
    cb();
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.viewType === type);
  }
  getLeaf(_newLeaf?: unknown): WorkspaceLeaf {
    return new WorkspaceLeaf(this.app);
  }
  getRightLeaf(_split: boolean): WorkspaceLeaf {
    return new WorkspaceLeaf(this.app);
  }
  async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {}
  async openLinkText(linktext: string, _sourcePath: string, newLeaf?: boolean): Promise<void> {
    this.opened.push({ linktext, newLeaf: !!newLeaf });
  }
  getActiveFile(): TFile | null {
    return this.activeFile;
  }
}

export class ItemView extends Component {
  app: App;
  containerEl = document.createElement("div");
  contentEl = document.createElement("div");
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.containerEl.appendChild(this.contentEl);
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

export class Modal {
  static opened: Modal[] = [];
  contentEl = document.createElement("div");
  titleEl = document.createElement("div");
  modalEl = document.createElement("div");
  isOpen = false;
  constructor(public app: App) {}
  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }
  open(): void {
    this.isOpen = true;
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class MenuItem {
  title = "";
  checked: boolean | null = null;
  disabled = false;
  private cb: ((evt: MouseEvent) => unknown) | undefined;
  setTitle(title: string | DocumentFragment): this {
    this.title = typeof title === "string" ? title : (title.textContent ?? "");
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }
  setIcon(_icon: string | null): this {
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.cb = cb;
    return this;
  }
  click(): void {
    void this.cb?.(new MouseEvent("click"));
  }
}

export class Menu {
  static last: Menu | null = null;
  items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    this.items.push(item);
    cb(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): this {
    Menu.last = this;
    return this;
  }
  showAtPosition(_pos: { x: number; y: number }): this {
    Menu.last = this;
    return this;
  }
}
```

Change the `App` class so that `workspace` gets the app:
```ts
export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  workspace: Workspace;
  secretStorage = new SecretStorage();
  private local = new Map<string, unknown>();

  constructor() {
    this.vault = new Vault(this);
    this.metadataCache = new MetadataCache(this);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace(this);
  }
  // loadLocalStorage / saveLocalStorage unchanged
}
```

Add `trashFile` to `FileManager`:
```ts
  async trashFile(file: TFile): Promise<void> {
    await this.app.vault.delete(file);
  }
```

Replace `Notice` so it accepts fragments, and give it a `noticeEl`:
```ts
export class Notice {
  static messages: string[] = [];
  static last: Notice | null = null;
  noticeEl = document.createElement("div");
  hidden = false;
  constructor(message: string | DocumentFragment, _duration?: number) {
    if (typeof message === "string") this.noticeEl.textContent = message;
    else this.noticeEl.append(message);
    Notice.messages.push(this.noticeEl.textContent ?? "");
    Notice.last = this;
  }
  hide(): void {
    this.hidden = true;
  }
}
```

Extend `Plugin` with view/command/ribbon/processor registration:
```ts
export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

// inside class Plugin:
  commands: Command[] = [];
  codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: any) => unknown>();
  ribbon: Array<{ icon: string; title: string; cb: () => unknown }> = [];
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => ItemView): void {
    this.app.workspace.viewFactories.set(type, factory);
  }
  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  addRibbonIcon(icon: string, title: string, cb: () => unknown): HTMLElement {
    this.ribbon.push({ icon, title, cb });
    return document.createElement("div");
  }
  registerMarkdownCodeBlockProcessor(lang: string, handler: (source: string, el: HTMLElement, ctx: any) => unknown): void {
    this.codeBlockProcessors.set(lang, handler);
  }
  registerHoverLinkSource(_id: string, _info: { display: string; defaultMod: boolean }): void {}
```

- [ ] **Step 2: Write the view-state types (completed in Task 3)**

`src/planner/viewState.ts`:
```ts
import type { RowStatus } from "../index/queries";
import type { Platform } from "../model/platforms";

export const PLANNER_MODES = ["month", "week", "board", "list"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];

export interface PlannerFilter {
  platforms: Platform[];
  /** Channel ids or `group:<id>` references. */
  channels: string[];
  /** Campaign note paths; "" = standalone posts. */
  campaigns: string[];
  statuses: RowStatus[];
}

export interface ViewState {
  mode: PlannerMode;
  filter: PlannerFilter;
}

export const EMPTY_FILTER: PlannerFilter = { platforms: [], channels: [], campaigns: [], statuses: [] };
export const DEFAULT_VIEW_STATE: ViewState = { mode: "month", filter: EMPTY_FILTER };
```

- [ ] **Step 3: Write the failing test**

`test/ui/svelteView.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../fakes/obsidian";
import { SvelteItemView } from "../../src/ui/SvelteView";
import Hello from "../fixtures/Hello.svelte";
import { makeCtx } from "./ctx";
import { Notice } from "../fakes/obsidian";

describe("SvelteItemView", () => {
  it("mounts on open and destroys on close", async () => {
    const { app, ctx } = await makeCtx();
    const onGone = vi.fn();
    class TestView extends SvelteItemView<{ name: string; onGone: () => void }> {
      getViewType() {
        return "test";
      }
      getDisplayText() {
        return "Test";
      }
      protected component() {
        return Hello;
      }
      protected props() {
        return { name: "Ada", onGone };
      }
    }
    const view = new TestView(new WorkspaceLeaf(app as never) as never, ctx);
    await view.onOpen();
    expect(view.contentEl.textContent).toContain("Hello, Ada!");
    expect(view.contentEl.classList.contains("osmm")).toBe(true);
    await view.onClose();
    expect(onGone).toHaveBeenCalledOnce();
  });
});

describe("PlannerActions basics", () => {
  it("opens notes and labels rows", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.channelId === "li/acme-studio")!;
    expect(ctx.actions.rowLabel(row)).toMatch(/^LinkedIn · Acme Studio · .+ \d\d:\d\d · Waiting for you — I almost didn't host Event X\.$/);
    ctx.actions.openNote(row.variant.path, true);
    expect(app.workspace.opened).toEqual([{ linktext: row.variant.path, newLeaf: true }]);
    expect(ctx.actions.rowByKey(row.key)).toBe(row);
  });

  it("offers undo in a notice", async () => {
    const { ctx } = await makeCtx();
    const undo = vi.fn();
    ctx.actions.undoNotice("Moved", undo);
    Notice.last!.noticeEl.querySelector("button")!.click();
    expect(undo).toHaveBeenCalledOnce();
    expect(Notice.last!.hidden).toBe(true);
  });
});
```

- [ ] **Step 4: Write the test context helper**

`test/ui/ctx.ts`:
```ts
import { get, writable, type Writable } from "svelte/store";
import { App } from "../fakes/obsidian";
import { buildSeed } from "../../scripts/seedData";
import { ChannelRegistry } from "../../src/channels/registry";
import { SocialIndex } from "../../src/index/socialIndex";
import { indexStore } from "../../src/index/stores";
import { NoteFactory } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { PlannerActions } from "../../src/ui/actions";
import type { OsmmContext } from "../../src/ui/context";
import { DEFAULT_VIEW_STATE } from "../../src/planner/viewState";
import { settle, writeNote } from "../helpers";

export const TEST_NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin

export interface TestCtx {
  app: App;
  ctx: OsmmContext;
  index: SocialIndex;
  writer: SafeWriter;
  settings: Writable<OsmmSettings>;
  now: Writable<number>;
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
  const actions = new PlannerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    settings: () => get(settings),
    now: () => get(nowStore),
  });
  const ctx: OsmmContext = {
    app: app as never,
    settings,
    snapshot: indexStore(index),
    now: nowStore,
    viewState: writable(structuredClone(DEFAULT_VIEW_STATE)),
    channels,
    actions,
  };
  return { app, ctx, index, writer, settings, now: nowStore };
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run test/ui/svelteView.test.ts`
Expected: FAIL. `src/ui/SvelteView`, `src/ui/actions` and `src/ui/context` don't exist yet.

- [ ] **Step 6: Implement context, views, dialogs and actions**

`src/ui/context.ts`:
```ts
import { getContext } from "svelte";
import { readable, type Readable, type Writable } from "svelte/store";
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { IndexSnapshot } from "../index/stores";
import type { ViewState } from "../planner/viewState";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "./actions";

export const OSMM_KEY = Symbol("osmm");

export interface OsmmContext {
  app: App;
  settings: Readable<OsmmSettings>;
  snapshot: Readable<IndexSnapshot>;
  now: Readable<number>;
  viewState: Writable<ViewState>;
  channels: ChannelRegistry;
  actions: PlannerActions;
}

export function osmmContext(ctx: OsmmContext): Map<unknown, unknown> {
  return new Map<unknown, unknown>([[OSMM_KEY, ctx]]);
}

export function useOsmm(): OsmmContext {
  const ctx = getContext<OsmmContext | undefined>(OSMM_KEY);
  if (!ctx) throw new Error("OSMM context is missing — mount components with osmmContext()");
  return ctx;
}

/** A store with the current time, refreshed every `intervalMs`. */
export function clock(intervalMs = 30_000): Readable<number> {
  return readable(Date.now(), (set) => {
    const id = setInterval(() => set(Date.now()), intervalMs);
    return () => clearInterval(id);
  });
}
```

`src/ui/SvelteView.ts`:
```ts
import { ItemView, MarkdownRenderChild, type WorkspaceLeaf } from "obsidian";
import type { Component } from "svelte";
import { mountSvelte, type Mounted } from "./mount";
import { osmmContext, type OsmmContext } from "./context";

export abstract class SvelteItemView<P extends Record<string, unknown> = Record<string, never>> extends ItemView {
  private mounted: Mounted | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    protected readonly ctx: OsmmContext,
  ) {
    super(leaf);
  }

  protected abstract component(): Component<P>;
  protected abstract props(): P;

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(this.contentEl, this.component(), this.props(), osmmContext(this.ctx));
  }

  override async onClose(): Promise<void> {
    this.mounted?.destroy();
    this.mounted = null;
  }
}

/** Mounts a Svelte component inside rendered Markdown (code-block processors). */
export class SvelteRenderChild<P extends Record<string, unknown>> extends MarkdownRenderChild {
  private mounted: Mounted | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly component: Component<P>,
    private readonly props: P,
    private readonly ctx: OsmmContext,
  ) {
    super(containerEl);
  }

  override onload(): void {
    this.containerEl.addClass("osmm");
    this.mounted = mountSvelte(this.containerEl, this.component, this.props, osmmContext(this.ctx));
  }

  override onunload(): void {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
```

`src/ui/dialogs.ts`:
```ts
import { Modal, type App } from "obsidian";
import type { Component } from "svelte";
import { mountSvelte, type Mounted } from "./mount";
import { osmmContext, type OsmmContext } from "./context";

function button(text: string, cta: boolean, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  if (cta) el.className = "mod-cta";
  el.addEventListener("click", onClick);
  return el;
}

export function confirmDialog(app: App, message: string, cta = "Continue"): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        const text = document.createElement("p");
        text.textContent = message;
        const row = document.createElement("div");
        row.className = "modal-button-container";
        row.append(
          button(cta, true, () => {
            answered = true;
            resolve(true);
            this.close();
          }),
          button("Cancel", false, () => this.close()),
        );
        this.contentEl.append(text, row);
      }
      override onClose(): void {
        this.contentEl.replaceChildren();
        if (!answered) resolve(false);
      }
    })(app);
    modal.open();
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

export function pickDateTime(app: App, title: string, initial: number): Promise<number | null> {
  return new Promise((resolve) => {
    let result: number | null = null;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        const d = new Date(initial);
        const date = document.createElement("input");
        date.type = "date";
        date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        date.setAttribute("aria-label", "Date");
        const time = document.createElement("input");
        time.type = "time";
        time.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        time.setAttribute("aria-label", "Time");
        const row = document.createElement("div");
        row.className = "modal-button-container";
        row.append(
          button("Schedule", true, () => {
            const [y, m, day] = date.value.split("-").map(Number);
            const [h, min] = time.value.split(":").map(Number);
            if (y && m && day && h !== undefined && min !== undefined) result = new Date(y, m - 1, day, h, min).getTime();
            this.close();
          }),
          button("Cancel", false, () => this.close()),
        );
        this.contentEl.append(date, time, row);
      }
      override onClose(): void {
        this.contentEl.replaceChildren();
        resolve(result);
      }
    })(app);
    modal.open();
  });
}

/** A modal whose body is a Svelte component. The component gets a `close` prop. */
export class SvelteModal<P extends Record<string, unknown>> extends Modal {
  private mounted: Mounted | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly component: Component<P & { close: () => void }>,
    private readonly props: P,
    private readonly ctx: OsmmContext,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(
      this.contentEl,
      this.component,
      { ...this.props, close: () => this.close() } as P & { close: () => void },
      osmmContext(this.ctx),
    );
  }

  override onClose(): void {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
```

`src/ui/actions.ts`:
```ts
import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import { expandRows, type PostRow } from "../index/queries";
import type { SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import { PLATFORM_META } from "../model/platforms";
import type { SafeWriter } from "../model/writer";
import { STATUS_LABEL } from "../planner/status";
import type { OsmmSettings } from "../settings/settings";
import { confirmDialog } from "./dialogs";
import { formatShortDate, formatTime } from "./format";

export const VIEW_PLANNER = "osmm-planner";
export const VIEW_SIDEBAR = "osmm-sidebar";

export interface ActionDeps {
  app: App;
  writer: SafeWriter;
  factory: NoteFactory;
  channels: ChannelRegistry;
  index: SocialIndex;
  settings(): OsmmSettings;
  now(): number;
}

/** Every UI side effect goes through this class; components stay declarative. */
export class PlannerActions {
  private readonly hoverParent = { hoverPopover: null };

  constructor(protected readonly deps: ActionDeps) {}

  openNote(path: string, newLeaf = false): void {
    void this.deps.app.workspace.openLinkText(path, "", newLeaf);
  }

  hoverPreview(event: MouseEvent, path: string): void {
    this.deps.app.workspace.trigger("hover-link", {
      event,
      source: VIEW_PLANNER,
      hoverParent: this.hoverParent,
      targetEl: event.currentTarget,
      linktext: path,
    });
  }

  rows(): PostRow[] {
    return expandRows(this.deps.index.variants(), this.deps.settings().defaultStaggerMinutes);
  }

  rowByKey(key: string): PostRow | undefined {
    return this.rows().find((r) => r.key === key);
  }

  rowLabel(row: PostRow): string {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const parts = [PLATFORM_META[row.variant.platform].label];
    if (channel) parts.push(channel.name);
    parts.push(row.at === undefined ? "unscheduled" : `${formatShortDate(row.at)} ${formatTime(row.at)}`);
    parts.push(STATUS_LABEL[row.status]);
    return `${parts.join(" · ")} — ${row.variant.displayTitle}`;
  }

  /** Overridable in tests. */
  confirm(message: string, cta?: string): Promise<boolean> {
    return confirmDialog(this.deps.app, message, cta);
  }

  undoNotice(message: string, undo: () => unknown): void {
    const fragment = document.createDocumentFragment();
    const text = document.createElement("span");
    text.textContent = `${message} `;
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = "Undo";
    fragment.append(text, link);
    const notice = new Notice(fragment, 8000);
    link.addEventListener("click", () => {
      void undo();
      notice.hide();
    });
  }
}
```

`actions.ts` needs the status labels, so create `src/planner/status.ts` now (Task 3 extends it):
```ts
import type { RowStatus } from "../index/queries";

export const STATUS_LABEL: Readonly<Record<RowStatus, string>> = {
  idea: "Idea",
  draft: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  handed_over: "Handed over",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  awaiting_you: "Waiting for you",
  skipped: "Skipped",
  overdue: "Overdue",
  check_needed: "Check needed",
};
```

- [ ] **Step 7: Keep a settings store in the plugin**

In `src/main.ts`, add the imports:
```ts
import { writable, type Writable } from "svelte/store";
import { indexStore } from "./index/stores";
import { viewStateStore } from "./planner/viewState";
import { PlannerActions } from "./ui/actions";
import { clock, type OsmmContext } from "./ui/context";
```
Add the fields `settingsStore!: Writable<OsmmSettings>;` and `private ui: OsmmContext | undefined;`. In `onload`, right after `this.settings = migrateSettings(...)`:
```ts
    this.settingsStore = writable(this.settings);
```
Change the channel store's `write` to also publish:
```ts
      write: async (next) => {
        this.settings = { ...this.settings, ...next };
        this.settingsStore.set(this.settings);
        await this.saveSettings();
      },
```
Change `updateSettings`:
```ts
  async updateSettings(patch: Partial<Omit<OsmmSettings, "schemaVersion">>): Promise<void> {
    this.settings = migrateSettings({ ...this.settings, ...patch });
    this.settingsStore.set(this.settings);
    await this.saveSettings();
  }
```
Add:
```ts
  uiContext(): OsmmContext {
    this.ui ??= {
      app: this.app,
      settings: this.settingsStore,
      snapshot: indexStore(this.index),
      now: clock(30_000),
      viewState: viewStateStore(this.app),
      channels: this.channels,
      actions: new PlannerActions({
        app: this.app,
        writer: this.writer,
        factory: this.factory,
        channels: this.channels,
        index: this.index,
        settings: () => this.settings,
        now: () => Date.now(),
      }),
    };
    return this.ui;
  }
```
`viewStateStore` is implemented in Task 3. Until then, add this temporary implementation at the bottom of `src/planner/viewState.ts`; Task 3 replaces it:
```ts
import { writable, type Writable } from "svelte/store";
import type { App } from "obsidian";
export function viewStateStore(_app: App): Writable<ViewState> {
  return writable(structuredClone(DEFAULT_VIEW_STATE));
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (all suites); no type errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(ui): add OSMM context, Svelte views, dialogs and planner actions"
```

---

### Task 3: View state, filter bar and view switcher (#34)

**Files:**
- Modify: `src/planner/viewState.ts` (complete it), `src/planner/status.ts` (add `chipStyle`, `FILTERABLE_STATUSES`)
- Create: `src/views/ViewSwitcher.svelte`, `src/views/FilterBar.svelte`, `src/views/Legend.svelte`, `test/planner/viewState.test.ts`, `test/views/filterBar.test.ts`, `test/planner/status.test.ts`

**Interfaces:**
- Produces: `sanitizeViewState(raw): ViewState`; `viewStateStore(app): Writable<ViewState>` (persists to `osmm-view-state`); `toggle<T>(list, value): T[]`; `activeFilterCount(f): number`; `toRowFilter(f, registry): RowFilter`; `isRowStatus(v): v is RowStatus`; `type ChipStyle`; `chipStyle(row, now, channel?): ChipStyle`; `FILTERABLE_STATUSES`; components `<ViewSwitcher modes value onchange>`, `<FilterBar>`, `<Legend>`.

- [ ] **Step 1: Write the failing tests**

`test/planner/viewState.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { App } from "../fakes/obsidian";
import { ChannelRegistry } from "../../src/channels/registry";
import {
  DEFAULT_VIEW_STATE,
  activeFilterCount,
  sanitizeViewState,
  toRowFilter,
  toggle,
  viewStateStore,
} from "../../src/planner/viewState";

describe("view state", () => {
  it("sanitizes unknown or partial data", () => {
    expect(sanitizeViewState(null)).toEqual(DEFAULT_VIEW_STATE);
    expect(sanitizeViewState({ mode: "timeline", filter: { platforms: ["linkedin", "myspace"], statuses: ["published", "posted"], channels: [1, "li/me"] } })).toEqual({
      mode: "month",
      filter: { platforms: ["linkedin"], channels: ["li/me"], campaigns: [], statuses: ["published"] },
    });
  });

  it("persists to device-local storage", () => {
    const app = new App();
    const store = viewStateStore(app as never);
    store.update((s) => ({ ...s, mode: "board" }));
    expect(get(viewStateStore(app as never)).mode).toBe("board");
  });

  it("toggles values and counts active filters", () => {
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(activeFilterCount({ platforms: ["x"], channels: [], campaigns: ["", "c.md"], statuses: [] })).toBe(3);
  });

  it("expands channel groups and ignores deleted channels (review focus 4)", () => {
    const registry = new ChannelRegistry({
      read: () => ({
        channels: [
          { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" },
          { id: "li/acme", platform: "linkedin", name: "Acme", kind: "page", avatarColor: "#6ea3e6", method: "assisted" },
        ],
        channelGroups: [{ id: "pages", name: "Pages", channelIds: ["li/acme"] }],
      }),
      write: async () => {},
    });
    expect(toRowFilter({ platforms: [], channels: ["group:pages", "li/me"], campaigns: [], statuses: [] }, registry).channelIds).toEqual(["li/acme", "li/me"]);
    expect(toRowFilter({ platforms: [], channels: ["li/deleted"], campaigns: [], statuses: [] }, registry).channelIds).toEqual([]);
  });
});
```

`test/planner/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chipStyle } from "../../src/planner/status";
import type { PostRow } from "../../src/index/queries";

const row = (status: PostRow["status"], at?: number, mode: "auto" | "assisted" = "auto") =>
  ({ key: "k", channelId: "li/me", status, at, variant: { mode } }) as unknown as PostRow;

describe("chipStyle", () => {
  it.each<[PostRow, string]>([
    [row("published"), "published"],
    [row("failed"), "attention"],
    [row("check_needed"), "attention"],
    [row("overdue"), "overdue"],
    [row("scheduled", 0), "overdue"],
    [row("scheduled", 10_000), "auto"],
    [row("scheduled", 10_000, "assisted"), "assisted"],
    [row("awaiting_you", 10_000), "assisted"],
    [row("handed_over", 0), "auto"],
    [row("draft"), "draft"],
    [row("skipped"), "draft"],
  ])("%o → %s", (r, expected) => {
    expect(chipStyle(r, 5_000)).toBe(expected);
  });

  it("uses the channel method", () => {
    expect(chipStyle(row("scheduled", 10_000), 5_000, { method: "assisted" } as never)).toBe("assisted");
  });
});
```

`test/views/filterBar.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { Menu } from "../fakes/obsidian";
import FilterBar from "../../src/views/FilterBar.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("FilterBar", () => {
  it("filters by platform through a checkable menu and clears", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(FilterBar, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Platform" }));
    const item = Menu.last!.items.find((i) => i.title === "LinkedIn")!;
    expect(item.checked).toBe(false);
    item.click();
    await tick();
    expect(get(ctx.viewState).filter.platforms).toEqual(["linkedin"]);
    expect(screen.getByRole("button", { name: "Platform (1)" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(get(ctx.viewState).filter.platforms).toEqual([]);
  });

  it("lists channel groups before channels", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(FilterBar, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(Menu.last!.items[0]!.title).toBe("All LinkedIn pages (group)");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner test/views`
Expected: FAIL. The functions and components are missing.

- [ ] **Step 3: Complete `viewState.ts`**

Replace the whole file:
```ts
import { writable, type Writable } from "svelte/store";
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { RowFilter, RowStatus } from "../index/queries";
import { isRecord } from "../model/frontmatter";
import { isPlatform, type Platform } from "../model/platforms";
import { DELIVERY_STATUSES } from "../model/schemas";

export const PLANNER_MODES = ["month", "week", "board", "list"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];

export interface PlannerFilter {
  platforms: Platform[];
  /** Channel ids or `group:<id>` references. */
  channels: string[];
  /** Campaign note paths; "" = standalone posts. */
  campaigns: string[];
  statuses: RowStatus[];
}

export interface ViewState {
  mode: PlannerMode;
  filter: PlannerFilter;
}

export const EMPTY_FILTER: PlannerFilter = { platforms: [], channels: [], campaigns: [], statuses: [] };
export const DEFAULT_VIEW_STATE: ViewState = { mode: "month", filter: EMPTY_FILTER };

const KEY = "osmm-view-state";

export function isRowStatus(value: unknown): value is RowStatus {
  return value === "idea" || (DELIVERY_STATUSES as readonly unknown[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function sanitizeViewState(raw: unknown): ViewState {
  if (!isRecord(raw)) return structuredClone(DEFAULT_VIEW_STATE);
  const f = isRecord(raw.filter) ? raw.filter : {};
  return {
    mode: (PLANNER_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as PlannerMode) : "month",
    filter: {
      platforms: strings(f.platforms).filter(isPlatform),
      channels: strings(f.channels),
      campaigns: strings(f.campaigns),
      statuses: strings(f.statuses).filter(isRowStatus),
    },
  };
}

export function viewStateStore(app: App): Writable<ViewState> {
  const store = writable(sanitizeViewState(app.loadLocalStorage(KEY)));
  store.subscribe((state) => app.saveLocalStorage(KEY, state));
  return store;
}

export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function activeFilterCount(f: PlannerFilter): number {
  return f.platforms.length + f.channels.length + f.campaigns.length + f.statuses.length;
}

/** Deleted channels and unknown groups expand to nothing, so a stale filter never hides everything. */
export function toRowFilter(f: PlannerFilter, registry: ChannelRegistry): RowFilter {
  return {
    platforms: f.platforms,
    channelIds: f.channels.length ? registry.expand(f.channels) : [],
    campaignPaths: f.campaigns,
    statuses: f.statuses,
  };
}
```

A stale campaign filter (the campaign was renamed or deleted) would otherwise match nothing. So in the Planner (Task 4), drop campaign paths the index doesn't know before calling `toRowFilter`.

- [ ] **Step 4: Extend `status.ts`**

Append:
```ts
import type { PostRow } from "../index/queries";
import type { Channel } from "../model/types";

export type ChipStyle = "published" | "auto" | "assisted" | "overdue" | "attention" | "draft";

export const FILTERABLE_STATUSES: readonly RowStatus[] = [
  "idea",
  "draft",
  "ready",
  "scheduled",
  "awaiting_you",
  "handed_over",
  "overdue",
  "failed",
  "published",
  "skipped",
];

export function chipStyle(row: PostRow, now: number, channel?: Channel): ChipStyle {
  switch (row.status) {
    case "published":
      return "published";
    case "failed":
    case "check_needed":
      return "attention";
    case "overdue":
      return "overdue";
    case "idea":
    case "draft":
    case "ready":
    case "skipped":
      return "draft";
  }
  if ((row.status === "scheduled" || row.status === "awaiting_you") && row.at !== undefined && row.at < now) return "overdue";
  const assisted = row.status === "awaiting_you" || row.variant.mode === "assisted" || channel?.method === "assisted";
  return assisted ? "assisted" : "auto";
}
```
Merge the imports at the top of the file (`import type { PostRow, RowStatus } from "../index/queries";`).

- [ ] **Step 5: Implement the components**

`src/views/ViewSwitcher.svelte`:
```svelte
<script lang="ts">
  import type { PlannerMode } from "../planner/viewState";

  let { modes, value, onchange }: { modes: readonly PlannerMode[]; value: PlannerMode; onchange: (mode: PlannerMode) => void } = $props();
  const LABEL: Record<PlannerMode, string> = { month: "Month", week: "Week", board: "Board", list: "List" };
</script>

<div class="osmm-segmented" role="group" aria-label="View">
  {#each modes as mode (mode)}
    <button type="button" class:is-active={mode === value} aria-pressed={mode === value} onclick={() => onchange(mode)}>{LABEL[mode]}</button>
  {/each}
</div>
```

`src/views/FilterBar.svelte`:
```svelte
<script lang="ts">
  import { Menu } from "obsidian";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { FILTERABLE_STATUSES, STATUS_LABEL } from "../planner/status";
  import { EMPTY_FILTER, activeFilterCount, toggle, type PlannerFilter } from "../planner/viewState";
  import { useOsmm } from "../ui/context";

  type Item = { title: string; checked: boolean; onClick: () => void } | "separator";

  const { viewState, snapshot, channels } = useOsmm();
  const filter = $derived($viewState.filter);

  function update(patch: Partial<PlannerFilter>): void {
    viewState.update((s) => ({ ...s, filter: { ...s.filter, ...patch } }));
  }

  function show(event: MouseEvent, items: Item[]): void {
    const menu = new Menu();
    for (const it of items) {
      if (it === "separator") menu.addSeparator();
      else menu.addItem((i) => i.setTitle(it.title).setChecked(it.checked).onClick(it.onClick));
    }
    menu.showAtMouseEvent(event);
  }

  function platformMenu(event: MouseEvent): void {
    show(
      event,
      PLATFORMS.map((p) => ({
        title: PLATFORM_META[p].label,
        checked: filter.platforms.includes(p),
        onClick: () => update({ platforms: toggle(filter.platforms, p) }),
      })),
    );
  }

  function channelMenu(event: MouseEvent): void {
    const groups: Item[] = channels.groups().map((g) => ({
      title: `${g.name} (group)`,
      checked: filter.channels.includes(`group:${g.id}`),
      onClick: () => update({ channels: toggle(filter.channels, `group:${g.id}`) }),
    }));
    const list: Item[] = channels.list().map((c) => ({
      title: `${PLATFORM_META[c.platform].label} · ${c.name}`,
      checked: filter.channels.includes(c.id),
      onClick: () => update({ channels: toggle(filter.channels, c.id) }),
    }));
    show(event, groups.length ? [...groups, "separator", ...list] : list);
  }

  function campaignMenu(event: MouseEvent): void {
    show(event, [
      { title: "Standalone posts", checked: filter.campaigns.includes(""), onClick: () => update({ campaigns: toggle(filter.campaigns, "") }) },
      "separator",
      ...$snapshot.campaigns.map((c) => ({
        title: c.title,
        checked: filter.campaigns.includes(c.path),
        onClick: () => update({ campaigns: toggle(filter.campaigns, c.path) }),
      })),
    ]);
  }

  function statusMenu(event: MouseEvent): void {
    show(
      event,
      FILTERABLE_STATUSES.map((s) => ({
        title: STATUS_LABEL[s],
        checked: filter.statuses.includes(s),
        onClick: () => update({ statuses: toggle(filter.statuses, s) }),
      })),
    );
  }

  const label = (name: string, n: number) => (n ? `${name} (${n})` : name);
</script>

<div class="osmm-filterbar" role="toolbar" aria-label="Filters">
  <button type="button" onclick={platformMenu}>{label("Platform", filter.platforms.length)}</button>
  <button type="button" onclick={channelMenu}>{label("Channel", filter.channels.length)}</button>
  <button type="button" onclick={campaignMenu}>{label("Campaign", filter.campaigns.length)}</button>
  <button type="button" onclick={statusMenu}>{label("Status", filter.statuses.length)}</button>
  {#if activeFilterCount(filter) > 0}
    <button type="button" class="mod-warning" onclick={() => update(EMPTY_FILTER)}>Clear filters</button>
  {/if}
</div>
```

`src/views/Legend.svelte`:
```svelte
<script lang="ts">
  const ITEMS = [
    { style: "auto", label: "Auto-post" },
    { style: "assisted", label: "Assisted (reminder + open)" },
    { style: "overdue", label: "Overdue" },
    { style: "attention", label: "Needs attention" },
    { style: "draft", label: "Draft / idea" },
    { style: "published", label: "Published" },
  ];
</script>

<ul class="osmm-legend" aria-label="Legend">
  {#each ITEMS as item (item.style)}
    <li class="osmm-row"><span class="osmm-chip" data-style={item.style} aria-hidden="true">&nbsp;</span>{item.label}</li>
  {/each}
</ul>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/planner test/views && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(planner): add persisted view state, filter bar and view switcher (refs #34)"
```

---

### Task 4: Planner view with the month calendar (#29)

**Files:**
- Create: `src/planner/calendar.ts`, `src/views/Chip.svelte`, `src/views/MonthView.svelte`, `src/views/Planner.svelte`, `src/views/PlannerView.ts`, `test/planner/calendar.test.ts`, `test/views/month.test.ts`
- Modify: `src/main.ts` (register view, ribbon, command, hover source)

**Interfaces:**
- Produces: `interface DayCell { key; date; day; inMonth; isToday }`; `dayKey(ms)`; `monthGrid(year, month, weekStartsOn, today): DayCell[][]`; `monthRange(year, month, weekStartsOn): { from; to }`; `weekdayLabels(weekStartsOn, locale?)`; `groupByDay(rows): Map<string, PostRow[]>`; `anchorsByDay(campaigns): Map<string, IndexedCampaign[]>`; `shiftMonth(year, month, delta)`; `<Chip row showTime?>`; `<MonthView year month rows>`; `<Planner>`; `class PlannerView`; `activateView(app, type, where)` in `src/views/PlannerView.ts`.

- [ ] **Step 1: Write the failing tests**

`test/planner/calendar.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dayKey, groupByDay, monthGrid, monthRange, shiftMonth, weekdayLabels } from "../../src/planner/calendar";
import type { PostRow } from "../../src/index/queries";

const today = new Date(2026, 9, 8, 10).getTime();

describe("monthGrid", () => {
  it("builds October 2026 with Monday start (matches mockup: starts Sep 28, 5 weeks)", () => {
    const weeks = monthGrid(2026, 9, 1, today);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]!.key).toBe("2026-09-28");
    expect(weeks[4]![6]!.key).toBe("2026-11-01");
    expect(weeks.flat().filter((c) => c.isToday).map((c) => c.key)).toEqual(["2026-10-08"]);
  });

  it("handles Sunday start and a 4-week February (review focus 2)", () => {
    const weeks = monthGrid(2026, 1, 0, today);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]!.key).toBe("2026-02-01");
  });

  it("has exactly one cell per day across the DST change", () => {
    const keys = monthGrid(2026, 9, 1, today).flat().map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("2026-10-25");
    expect(keys).toContain("2026-10-26");
  });

  it("gives the query range for the whole grid", () => {
    const { from, to } = monthRange(2026, 9, 1);
    expect(dayKey(from)).toBe("2026-09-28");
    expect(dayKey(to)).toBe("2026-11-02");
  });
});

describe("helpers", () => {
  it("labels weekdays for both week starts", () => {
    expect(weekdayLabels(1, "en")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayLabels(0, "en")[0]).toBe("Sun");
  });

  it("shifts months across years", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it("groups rows by local day, sorted by time", () => {
    const rows = [
      { key: "b", at: new Date(2026, 9, 8, 17).getTime() },
      { key: "a", at: new Date(2026, 9, 8, 9).getTime() },
      { key: "c", at: new Date(2026, 9, 9, 0, 30).getTime() },
      { key: "d" },
    ] as PostRow[];
    const grouped = groupByDay(rows);
    expect(grouped.get("2026-10-08")?.map((r) => r.key)).toEqual(["a", "b"]);
    expect(grouped.get("2026-10-09")?.map((r) => r.key)).toEqual(["c"]);
    expect([...grouped.keys()]).toHaveLength(2);
  });
});
```

`test/views/month.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Planner from "../../src/views/Planner.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("Planner — month", () => {
  it("renders the current month with chips on the right days", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
    const today = document.querySelector('[data-day="2026-10-08"]')!;
    expect(today.textContent).toContain("Event X is back");
    expect(document.querySelector('[data-day="2026-10-12"] .osmm-anchor')?.textContent).toBe("Event X");
  });

  it("opens the note when a chip is clicked", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    const chip = screen.getAllByRole("button", { name: /^Bluesky/ })[0]!;
    await fireEvent.click(chip);
    expect(app.workspace.opened[0]?.linktext).toBe("Social/Event X/Event X – Bluesky.md");
  });

  it("navigates months", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "November 2026" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
  });

  it("collapses busy days into a '+N more' menu", async () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({
      path: `Social/Posts/P${i}.md`,
      frontmatter: { type: "social-post", platform: "x", title: `P${i}`, scheduled_at: `2026-10-20 1${i}:00` },
    }));
    const { ctx } = await makeCtx({ notes });
    render(Planner, { context: osmmContext(ctx) });
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
  });
});
```

The month tests render month names in the default locale. If CI runs with a non-English locale, add `LANG=en_US.UTF-8` to the CI test step environment.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/calendar.test.ts test/views/month.test.ts`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement `calendar.ts`**

```ts
import type { IndexedCampaign } from "../index/socialIndex";
import type { PostRow } from "../index/queries";

export interface DayCell {
  key: string;
  /** Local midnight, epoch ms. */
  date: number;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cell(y: number, m: number, d: number, month: number, todayKey: string): DayCell {
  const date = new Date(y, m, d);
  const ms = date.getTime();
  const key = dayKey(ms);
  return { key, date: ms, day: date.getDate(), inMonth: date.getMonth() === month, isToday: key === todayKey };
}

function firstVisibleDay(year: number, month: number, weekStartsOn: 0 | 1): Date {
  const offset = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  return new Date(year, month, 1 - offset);
}

export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1, today: number): DayCell[][] {
  const start = firstVisibleDay(year, month, weekStartsOn);
  const offset = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  const weeks = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7);
  const todayKey = dayKey(today);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) =>
      cell(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i, month, todayKey),
    ),
  );
}

export function monthRange(year: number, month: number, weekStartsOn: 0 | 1): { from: number; to: number } {
  const weeks = monthGrid(year, month, weekStartsOn, 0);
  const last = weeks[weeks.length - 1]![6]!;
  const end = new Date(last.date);
  return { from: weeks[0]![0]!.date, to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime() };
}

export function weekdayLabels(weekStartsOn: 0 | 1, locale?: string): string[] {
  // 4 Jan 2026 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2026, 0, 4 + weekStartsOn + i).toLocaleDateString(locale, { weekday: "short" }),
  );
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function groupByDay(rows: readonly PostRow[]): Map<string, PostRow[]> {
  const map = new Map<string, PostRow[]>();
  for (const row of [...rows].filter((r) => r.at !== undefined).sort((a, b) => a.at! - b.at!)) {
    const key = dayKey(row.at!);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function anchorsByDay(campaigns: readonly IndexedCampaign[]): Map<string, IndexedCampaign[]> {
  const map = new Map<string, IndexedCampaign[]>();
  for (const c of campaigns) {
    if (c.anchorDate === undefined || c.status === "archived") continue;
    const key = dayKey(c.anchorDate);
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return map;
}
```

- [ ] **Step 4: Implement the Chip, the MonthView and the Planner**

`src/views/Chip.svelte`:
```svelte
<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { chipStyle } from "../planner/status";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatTime } from "../ui/format";

  let { row, showTime = true }: { row: PostRow; showTime?: boolean } = $props();
  const { now, channels, actions } = useOsmm();
  const channel = $derived(row.channelId ? channels.get(row.channelId) : undefined);
  const style = $derived(chipStyle(row, $now, channel));
  const label = $derived(actions.rowLabel(row));
</script>

<button
  type="button"
  class="osmm-chip"
  data-style={style}
  aria-label={label}
  title={label}
  onclick={(e) => actions.openNote(row.variant.path, e.metaKey || e.ctrlKey)}
  onmouseenter={(e) => actions.hoverPreview(e, row.variant.path)}>
  <PlatformBadge platform={row.variant.platform} />
  {#if showTime && row.at !== undefined}<span class="osmm-chip-time">{formatTime(row.at)}</span>{/if}
  <span class="osmm-chip-title">{row.variant.displayTitle}</span>
  {#if style === "published"}<span aria-hidden="true">✓</span>{/if}
</button>
```

`src/views/MonthView.svelte`:
```svelte
<script lang="ts">
  import { Menu } from "obsidian";
  import type { PostRow } from "../index/queries";
  import { anchorsByDay, groupByDay, monthGrid, weekdayLabels } from "../planner/calendar";
  import { useOsmm } from "../ui/context";
  import Chip from "./Chip.svelte";

  let { year, month, rows }: { year: number; month: number; rows: PostRow[] } = $props();
  const { settings, now, snapshot, actions } = useOsmm();
  const MAX = 4;

  const weeks = $derived(monthGrid(year, month, $settings.weekStartsOn, $now));
  const byDay = $derived(groupByDay(rows));
  const anchors = $derived(anchorsByDay($snapshot.campaigns));

  function more(event: MouseEvent, list: PostRow[]): void {
    const menu = new Menu();
    for (const r of list) menu.addItem((i) => i.setTitle(actions.rowLabel(r)).onClick(() => actions.openNote(r.variant.path)));
    menu.showAtMouseEvent(event);
  }
</script>

<div class="osmm-month" role="grid" aria-label="Month">
  <div class="osmm-month-head" role="row">
    {#each weekdayLabels($settings.weekStartsOn) as label (label)}<div role="columnheader">{label}</div>{/each}
  </div>
  {#each weeks as week, w (w)}
    <div class="osmm-month-row" role="row">
      {#each week as cell (cell.key)}
        {@const list = byDay.get(cell.key) ?? []}
        <div role="gridcell" class="osmm-day" class:is-muted={!cell.inMonth} class:is-today={cell.isToday} data-day={cell.key}>
          <div class="osmm-day-head">
            <span class="osmm-day-num">{cell.day}</span>
            {#each anchors.get(cell.key) ?? [] as c (c.path)}<span class="osmm-anchor" title={c.title}>{c.title}</span>{/each}
          </div>
          {#each list.slice(0, MAX) as row (row.key)}<Chip {row} />{/each}
          {#if list.length > MAX}
            <button type="button" class="osmm-more" onclick={(e) => more(e, list.slice(MAX))}>+{list.length - MAX} more</button>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
</div>
```

`src/views/Planner.svelte`:
```svelte
<script lang="ts">
  import { get } from "svelte/store";
  import { expandRows, filterRows, rowsBetween } from "../index/queries";
  import { monthRange, shiftMonth } from "../planner/calendar";
  import { toRowFilter, type PlannerMode } from "../planner/viewState";
  import { useOsmm } from "../ui/context";
  import { monthTitle } from "../ui/format";
  import { icon } from "../ui/icon";
  import FilterBar from "./FilterBar.svelte";
  import Legend from "./Legend.svelte";
  import MonthView from "./MonthView.svelte";
  import ViewSwitcher from "./ViewSwitcher.svelte";

  const { snapshot, settings, viewState, channels, now } = useOsmm();
  const MODES: PlannerMode[] = ["month"];

  const start = new Date(get(now));
  let cursor = $state({ year: start.getFullYear(), month: start.getMonth() });

  const mode = $derived(MODES.includes($viewState.mode) ? $viewState.mode : "month");
  const knownCampaigns = $derived(new Set(["", ...$snapshot.campaigns.map((c) => c.path)]));
  const filter = $derived({ ...$viewState.filter, campaigns: $viewState.filter.campaigns.filter((p) => knownCampaigns.has(p)) });
  const rows = $derived(filterRows(expandRows($snapshot.variants, $settings.defaultStaggerMinutes), toRowFilter(filter, channels)));
  const range = $derived(monthRange(cursor.year, cursor.month, $settings.weekStartsOn));
  const visible = $derived(rowsBetween(rows, range.from, range.to));

  function step(delta: number): void {
    cursor = shiftMonth(cursor.year, cursor.month, delta);
  }
  function today(): void {
    const d = new Date($now);
    cursor = { year: d.getFullYear(), month: d.getMonth() };
  }
  function setMode(next: PlannerMode): void {
    viewState.update((s) => ({ ...s, mode: next }));
  }
</script>

<div class="osmm-planner">
  <header class="osmm-toolbar">
    <h2 class="osmm-title">{monthTitle(cursor.year, cursor.month)}</h2>
    <div class="osmm-nav">
      <button type="button" aria-label="Previous" onclick={() => step(-1)}><span use:icon={"chevron-left"}></span></button>
      <button type="button" aria-label="Next" onclick={() => step(1)}><span use:icon={"chevron-right"}></span></button>
      <button type="button" onclick={today}>Today</button>
    </div>
    <div class="osmm-spacer"></div>
    <ViewSwitcher modes={MODES} value={mode} onchange={setMode} />
  </header>
  <div class="osmm-subbar">
    <FilterBar />
    <div class="osmm-spacer"></div>
    <Legend />
  </div>
  <div class="osmm-body">
    {#if mode === "month"}
      <MonthView year={cursor.year} month={cursor.month} rows={visible} />
    {/if}
  </div>
</div>
```

`src/views/PlannerView.ts`:
```ts
import type { App } from "obsidian";
import { VIEW_PLANNER } from "../ui/actions";
import { SvelteItemView } from "../ui/SvelteView";
import Planner from "./Planner.svelte";

export class PlannerView extends SvelteItemView {
  getViewType(): string {
    return VIEW_PLANNER;
  }
  getDisplayText(): string {
    return "Social planner";
  }
  override getIcon(): string {
    return "calendar-days";
  }
  protected component() {
    return Planner;
  }
  protected props() {
    return {};
  }
}

/** Reveal an existing view of `type`, or open one in a new tab / the right sidebar. */
export async function activateView(app: App, type: string, where: "tab" | "right"): Promise<void> {
  const existing = app.workspace.getLeavesOfType(type)[0];
  const leaf = existing ?? (where === "right" ? app.workspace.getRightLeaf(false) : app.workspace.getLeaf("tab"));
  if (!leaf) return;
  if (!existing) await leaf.setViewState({ type, active: true });
  await app.workspace.revealLeaf(leaf);
}
```

- [ ] **Step 5: Register the view in the plugin**

In `src/main.ts`, add the imports `import { PlannerView, activateView } from "./views/PlannerView";` and `import { VIEW_PLANNER } from "./ui/actions";`. Then at the end of `onload`:
```ts
    this.registerView(VIEW_PLANNER, (leaf) => new PlannerView(leaf, this.uiContext()));
    this.registerHoverLinkSource(VIEW_PLANNER, { display: "Social planner", defaultMod: true });
    this.addRibbonIcon("calendar-days", "Open social planner", () => void activateView(this.app, VIEW_PLANNER, "tab"));
    this.addCommand({ id: "open-planner", name: "Open planner", callback: () => void activateView(this.app, VIEW_PLANNER, "tab") });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: PASS; the build succeeds.

- [ ] **Step 7: Manual check in the dev vault**

Run: `npm run seed && npm run dev`, then click the calendar ribbon icon in Obsidian.
Expected: October 2026 renders like mockup artboard 1: chips styled by status, an Event X marker on its day, today highlighted, hover preview with the modifier key.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(planner): add planner view with month calendar (refs #29)"
```

---

### Task 5: Week view with a time grid (#30)

**Files:**
- Modify: `src/planner/calendar.ts` (week helpers), `src/views/Planner.svelte` (week mode)
- Create: `src/views/WeekView.svelte`, `test/planner/week.test.ts`, `test/views/week.test.ts`

**Interfaces:**
- Produces: `weekCells(anchor, weekStartsOn, today): DayCell[]`; `weekRange(anchor, weekStartsOn): { from; to }`; `minutesOfDay(ms): number`; `interface PlacedRow { row; top; lane; lanes }`; `layoutDay(rows, blockMinutes?): PlacedRow[]`; `PX_PER_MINUTE = 0.8`; `<WeekView anchor rows>`. The Planner's cursor becomes an `anchor` epoch (local day), with `step()` moving one month or one week depending on the mode.

- [ ] **Step 1: Write the failing tests**

`test/planner/week.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { layoutDay, minutesOfDay, weekCells, weekRange } from "../../src/planner/calendar";
import type { PostRow } from "../../src/index/queries";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe("week helpers", () => {
  it("builds the DST week Mon 19 – Sun 25 Oct 2026 (review focus 2)", () => {
    const cells = weekCells(at(25, 12), 1, at(22, 9));
    expect(cells.map((c) => c.key)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(cells.find((c) => c.isToday)?.key).toBe("2026-10-22");
    const { from, to } = weekRange(at(25, 12), 1);
    expect(to - from).toBe(7 * 86_400_000 + 3_600_000);
  });

  it("uses local wall-clock minutes on the DST day", () => {
    expect(minutesOfDay(at(25, 9))).toBe(540);
  });

  it("puts overlapping posts in lanes", () => {
    const rows = [
      { key: "a", at: at(8, 9) },
      { key: "b", at: at(8, 9, 15) },
      { key: "c", at: at(8, 10) },
    ] as PostRow[];
    expect(layoutDay(rows).map((p) => [p.row.key, p.top, p.lane, p.lanes])).toEqual([
      ["a", 540, 0, 2],
      ["b", 555, 1, 2],
      ["c", 600, 0, 1],
    ]);
  });
});
```

`test/views/week.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Planner from "../../src/views/Planner.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("Planner — week", () => {
  it("switches to week mode and positions chips by time", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("heading").textContent).toMatch(/Oct 5 – Oct 11, 2026/);
    const item = document.querySelector('[data-row-key="Social/Event X/Event X – Bluesky.md#bs/you"]') as HTMLElement;
    expect(item.style.top).toBe(`${11 * 60 * 0.8}px`);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/week.test.ts test/views/week.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the week helpers to `calendar.ts`**

```ts
export const PX_PER_MINUTE = 0.8;

export function weekCells(anchor: number, weekStartsOn: 0 | 1, today: number): DayCell[] {
  const d = new Date(anchor);
  const offset = (d.getDay() - weekStartsOn + 7) % 7;
  const todayKey = dayKey(today);
  return Array.from({ length: 7 }, (_, i) => {
    const c = cell(d.getFullYear(), d.getMonth(), d.getDate() - offset + i, -1, todayKey);
    return { ...c, inMonth: true };
  });
}

export function weekRange(anchor: number, weekStartsOn: 0 | 1): { from: number; to: number } {
  const cells = weekCells(anchor, weekStartsOn, 0);
  const first = new Date(cells[0]!.date);
  return { from: first.getTime(), to: new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7).getTime() };
}

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export interface PlacedRow {
  row: PostRow;
  /** Minutes since local midnight. */
  top: number;
  lane: number;
  lanes: number;
}

/** Greedy lane assignment: posts closer than `blockMinutes` share a cluster and get side-by-side lanes. */
export function layoutDay(rows: readonly PostRow[], blockMinutes = 30): PlacedRow[] {
  const sorted = [...rows].filter((r) => r.at !== undefined).sort((a, b) => a.at! - b.at!);
  const placed: PlacedRow[] = [];
  let cluster: PlacedRow[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const row of sorted) {
    const top = minutesOfDay(row.at!);
    if (top >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= top);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(top + blockMinutes);
    } else laneEnds[lane] = top + blockMinutes;
    clusterEnd = Math.max(clusterEnd, top + blockMinutes);
    const p: PlacedRow = { row, top, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
  }
  close();
  return placed;
}
```

- [ ] **Step 4: Implement `WeekView.svelte`**

```svelte
<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { PX_PER_MINUTE, groupByDay, layoutDay, minutesOfDay, weekCells } from "../planner/calendar";
  import { useOsmm } from "../ui/context";
  import Chip from "./Chip.svelte";

  let { anchor, rows }: { anchor: number; rows: PostRow[] } = $props();
  const { settings, now } = useOsmm();
  const HOURS = Array.from({ length: 24 }, (_, h) => h);

  const cells = $derived(weekCells(anchor, $settings.weekStartsOn, $now));
  const byDay = $derived(groupByDay(rows));
  let scroller: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (scroller) scroller.scrollTop = 7 * 60 * PX_PER_MINUTE;
  });
</script>

<div class="osmm-week-scroll" bind:this={scroller} style:height="100%" style:overflow="auto">
  <div class="osmm-week" role="grid" aria-label="Week">
    <div class="osmm-week-head" role="columnheader"></div>
    {#each cells as c (c.key)}
      <div class="osmm-week-head" class:is-today={c.isToday} role="columnheader">
        {new Date(c.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
      </div>
    {/each}
    <div class="osmm-hours" style:height="{24 * 60 * PX_PER_MINUTE}px">
      {#each HOURS as h (h)}<span class="osmm-hour" style:top="{h * 60 * PX_PER_MINUTE}px">{String(h).padStart(2, "0")}:00</span>{/each}
    </div>
    {#each cells as c (c.key)}
      <div class="osmm-week-col" role="gridcell" data-day={c.key} style:height="{24 * 60 * PX_PER_MINUTE}px">
        {#if c.isToday}<div class="osmm-now-line" style:top="{minutesOfDay($now) * PX_PER_MINUTE}px"></div>{/if}
        {#each layoutDay(byDay.get(c.key) ?? []) as p (p.row.key)}
          <div
            class="osmm-week-item"
            data-row-key={p.row.key}
            style:top="{p.top * PX_PER_MINUTE}px"
            style:left="{(p.lane / p.lanes) * 100}%"
            style:width="{100 / p.lanes}%">
            <Chip row={p.row} />
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
```

- [ ] **Step 5: Switch the Planner to an anchor cursor and add week mode**

Replace the `<script>` of `src/views/Planner.svelte` with:
```svelte
<script lang="ts">
  import { get } from "svelte/store";
  import { expandRows, filterRows, rowsBetween } from "../index/queries";
  import { monthRange, weekCells, weekRange } from "../planner/calendar";
  import { toRowFilter, type PlannerMode } from "../planner/viewState";
  import { addLocalDays, startOfLocalDay } from "../model/dates";
  import { useOsmm } from "../ui/context";
  import { monthTitle, weekTitle } from "../ui/format";
  import { icon } from "../ui/icon";
  import FilterBar from "./FilterBar.svelte";
  import Legend from "./Legend.svelte";
  import MonthView from "./MonthView.svelte";
  import ViewSwitcher from "./ViewSwitcher.svelte";
  import WeekView from "./WeekView.svelte";

  const { snapshot, settings, viewState, channels, now } = useOsmm();
  const MODES: PlannerMode[] = ["month", "week"];

  let anchor = $state(startOfLocalDay(get(now)));
  const mode = $derived(MODES.includes($viewState.mode) ? $viewState.mode : "month");
  const year = $derived(new Date(anchor).getFullYear());
  const month = $derived(new Date(anchor).getMonth());

  const knownCampaigns = $derived(new Set(["", ...$snapshot.campaigns.map((c) => c.path)]));
  const filter = $derived({ ...$viewState.filter, campaigns: $viewState.filter.campaigns.filter((p) => knownCampaigns.has(p)) });
  const rows = $derived(filterRows(expandRows($snapshot.variants, $settings.defaultStaggerMinutes), toRowFilter(filter, channels)));
  const range = $derived(mode === "week" ? weekRange(anchor, $settings.weekStartsOn) : monthRange(year, month, $settings.weekStartsOn));
  const visible = $derived(rowsBetween(rows, range.from, range.to));
  const title = $derived.by(() => {
    if (mode !== "week") return monthTitle(year, month);
    const cells = weekCells(anchor, $settings.weekStartsOn, 0);
    return weekTitle(cells[0]!.date, cells[6]!.date);
  });

  function step(delta: number): void {
    if (mode === "week") anchor = addLocalDays(anchor, 7 * delta);
    else anchor = new Date(year, month + delta, 1).getTime();
  }
  function today(): void {
    anchor = startOfLocalDay($now);
  }
  function setMode(next: PlannerMode): void {
    viewState.update((s) => ({ ...s, mode: next }));
  }
</script>
```

In the markup, change the heading to `<h2 class="osmm-title">{title}</h2>`, and the body to:
```svelte
  <div class="osmm-body">
    {#if mode === "month"}
      <MonthView {year} {month} rows={visible} />
    {:else if mode === "week"}
      <WeekView {anchor} rows={visible} />
    {/if}
  </div>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(planner): add week view with time grid and lanes (refs #30)"
```

---

### Task 6: Drag-and-drop rescheduling with undo (#31)

**Files:**
- Create: `src/planner/reschedule.ts`, `test/planner/reschedule.test.ts`, `test/ui/reschedule.test.ts`
- Modify: `src/ui/actions.ts` (reschedule, drag/drop), `src/views/Chip.svelte` (draggable), `src/views/MonthView.svelte` (day drop targets), `src/views/WeekView.svelte` (slot drop targets)

**Interfaces:**
- Consumes: `transition` (M1a), `VariantPatch` (M1a), `SafeWriter.patchVariant`.
- Produces: `type RescheduleTarget = { day: number } | { at: number }`; `type ReschedulePlan = { ok: true; patch: VariantPatch; previous: VariantPatch; needsConfirm: boolean; newAt: number } | { ok: false; reason: string }`; `planReschedule(row, target, defaultTime?): ReschedulePlan`; `ROW_MIME = "text/x-osmm-row"`; `PlannerActions.reschedule(row, target): Promise<boolean>`, `dragStart(event, row)`, `dropOnDay(event, day)`, `dropOnSlot(event, day, minutes)`.

- [ ] **Step 1: Write the failing tests**

`test/planner/reschedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { planReschedule } from "../../src/planner/reschedule";
import type { PostRow } from "../../src/index/queries";
import type { IndexedVariant } from "../../src/index/socialIndex";

const T = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

function variant(partial: Partial<IndexedVariant>): IndexedVariant {
  return { path: "p.md", platform: "linkedin", channels: ["li/me", "li/acme"], mode: "auto", status: "scheduled", media: [], deliveries: {}, issues: [], excerpt: "", displayTitle: "", file: {} as never, scheduledAt: T(8, 17, 30), staggerMinutes: 15, ...partial };
}
const rowOf = (v: IndexedVariant, channelId: string, at: number, status: PostRow["status"] = "scheduled"): PostRow => ({ key: `${v.path}#${channelId}`, variant: v, channelId, status, at });

describe("planReschedule", () => {
  it("moves a staggered second channel exactly to the drop time, shifting the whole post (review focus 1)", () => {
    const v = variant({});
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 17, 45)), { at: T(9, 10, 0) });
    expect(plan).toMatchObject({ ok: true, newAt: T(9, 10, 0), needsConfirm: false });
    if (!plan.ok) throw new Error();
    expect(plan.patch.scheduledAt).toBe(T(9, 9, 45));
    expect(plan.previous.scheduledAt).toBe(T(8, 17, 30));
  });

  it("keeps the time of day when dropped on a month day", () => {
    const v = variant({ channels: ["li/me"] });
    const plan = planReschedule(rowOf(v, "li/me", T(8, 17, 30)), { day: T(12, 0) });
    expect(plan.ok && plan.patch.scheduledAt).toBe(T(12, 17, 30));
  });

  it("uses the default time for unscheduled posts", () => {
    const v = variant({ channels: [], scheduledAt: undefined, status: "draft" });
    const plan = planReschedule({ key: "p.md#", variant: v, channelId: null, status: "draft" }, { day: T(12, 0) }, "08:30");
    expect(plan.ok && plan.patch.scheduledAt).toBe(T(12, 8, 30));
  });

  it("moves only the channel when it has an explicit time", () => {
    const v = variant({ deliveries: { "li/acme": { status: "scheduled", at: T(8, 20) } } });
    const plan = planReschedule(rowOf(v, "li/acme", T(8, 20)), { at: T(9, 8) });
    if (!plan.ok) throw new Error();
    expect(plan.patch.scheduledAt).toBe(T(8, 17, 30));
    expect(plan.patch.deliveries?.["li/acme"]?.at).toBe(T(9, 8));
  });

  it("re-schedules overdue deliveries it moves", () => {
    const v = variant({ channels: ["li/me"], deliveries: { "li/me": { status: "overdue" } } });
    const plan = planReschedule(rowOf(v, "li/me", T(6, 18), "overdue"), { at: T(9, 18) });
    expect(plan.ok && plan.patch.deliveries?.["li/me"]?.status).toBe("scheduled");
  });

  it("asks for confirmation when a moved delivery was handed over (review focus 3)", () => {
    const v = variant({ channels: ["li/me"], deliveries: { "li/me": { status: "handed_over" } } });
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), "handed_over"), { at: T(9, 9) })).toMatchObject({ ok: true, needsConfirm: true });
  });

  it.each(["published", "publishing", "skipped"] as const)("refuses to move %s rows", (status) => {
    const v = variant({});
    expect(planReschedule(rowOf(v, "li/me", T(8, 17, 30), status), { at: T(9, 9) }).ok).toBe(false);
  });
});
```

`test/ui/reschedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW } from "./ctx";
import { settle } from "../helpers";

describe("PlannerActions.reschedule", () => {
  it("writes the new time and restores it on undo", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.key === "Social/Event X/Event X – Bluesky.md#bs/you")!;
    const target = TEST_NOW + 2 * 86_400_000;
    expect(await ctx.actions.reschedule(row, { at: target })).toBe(true);
    await settle(5);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(target);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await settle(5);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(row.variant.scheduledAt);
  });

  it("does nothing when confirmation is declined", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    ctx.actions.confirm = async () => false;
    const row = ctx.actions.rows().find((r) => r.status === "handed_over")!;
    expect(await ctx.actions.reschedule(row, { at: TEST_NOW })).toBe(false);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(row.variant.scheduledAt);
  });

  it("explains refusals in a notice", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.status === "published")!;
    expect(await ctx.actions.reschedule(row, { at: TEST_NOW })).toBe(false);
    expect(Notice.messages.at(-1)).toBe("Published or skipped posts can't be rescheduled.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/reschedule.test.ts test/ui/reschedule.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `reschedule.ts`**

```ts
import type { PostRow, RowStatus } from "../index/queries";
import type { VariantPatch } from "../model/frontmatter";
import { transition } from "../model/stateMachine";
import type { Delivery } from "../model/types";

export type RescheduleTarget = { day: number } | { at: number };

export type ReschedulePlan =
  | { ok: true; patch: VariantPatch; previous: VariantPatch; needsConfirm: boolean; newAt: number }
  | { ok: false; reason: string };

const FROZEN = new Set<RowStatus>(["published", "publishing", "skipped"]);

function onDay(day: number, currentAt: number | undefined, defaultTime: string): number {
  const d = new Date(day);
  let h: number;
  let m: number;
  if (currentAt !== undefined) {
    const c = new Date(currentAt);
    h = c.getHours();
    m = c.getMinutes();
  } else {
    [h, m] = defaultTime.split(":").map(Number) as [number, number];
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

export function planReschedule(row: PostRow, target: RescheduleTarget, defaultTime = "09:00"): ReschedulePlan {
  if (FROZEN.has(row.status)) {
    return {
      ok: false,
      reason: row.status === "publishing" ? "This post is being published right now." : "Published or skipped posts can't be rescheduled.",
    };
  }
  const v = row.variant;
  const newAt = "at" in target ? target.at : onDay(target.day, row.at, defaultTime);
  const deliveries: Record<string, Delivery> = { ...v.deliveries };
  const explicit = row.channelId !== null && v.deliveries[row.channelId]?.at !== undefined;

  let scheduledAt = v.scheduledAt;
  if (explicit) deliveries[row.channelId!] = { ...deliveries[row.channelId!]!, at: newAt };
  else scheduledAt = row.at === undefined || v.scheduledAt === undefined ? newAt : v.scheduledAt + (newAt - row.at);

  const affected = explicit ? [row.channelId!] : v.channels;
  for (const id of affected) {
    const d = deliveries[id];
    if (d?.status === "overdue") deliveries[id] = transition(d, "scheduled");
  }
  const needsConfirm = affected.some((id) => deliveries[id]?.status === "handed_over");

  return {
    ok: true,
    newAt,
    needsConfirm,
    previous: { scheduledAt: v.scheduledAt, deliveries: v.deliveries },
    patch: { scheduledAt, deliveries },
  };
}
```

- [ ] **Step 4: Add the reschedule and drag/drop actions**

Add to `src/ui/actions.ts` (imports: `import { planReschedule, type RescheduleTarget } from "../planner/reschedule";`):
```ts
export const ROW_MIME = "text/x-osmm-row";

// inside PlannerActions:
  async reschedule(row: PostRow, target: RescheduleTarget): Promise<boolean> {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const plan = planReschedule(row, target, channel?.defaultTime ?? "09:00");
    if (!plan.ok) {
      new Notice(plan.reason);
      return false;
    }
    if (plan.needsConfirm) {
      const go = await this.confirm(
        "This post was already handed over to the platform. Moving it here won't change it on the platform until you push an update. Move anyway?",
        "Move",
      );
      if (!go) return false;
    }
    const file = row.variant.file;
    await this.deps.writer.patchVariant(file, plan.patch);
    this.undoNotice(`Moved to ${formatShortDate(plan.newAt)} ${formatTime(plan.newAt)}.`, () =>
      this.deps.writer.patchVariant(file, plan.previous),
    );
    return true;
  }

  dragStart(event: DragEvent, row: PostRow): void {
    event.dataTransfer?.setData(ROW_MIME, row.key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  private dropped(event: DragEvent): PostRow | undefined {
    event.preventDefault();
    const key = event.dataTransfer?.getData(ROW_MIME);
    return key ? this.rowByKey(key) : undefined;
  }

  dropOnDay(event: DragEvent, day: number): void {
    const row = this.dropped(event);
    if (row) void this.reschedule(row, { day });
  }

  dropOnSlot(event: DragEvent, day: number, minutes: number): void {
    const row = this.dropped(event);
    if (!row) return;
    const d = new Date(day);
    void this.reschedule(row, { at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime() });
  }
```

- [ ] **Step 5: Wire drag sources and drop targets**

In `src/views/Chip.svelte`, add to the `<button>` (non-draggable when frozen):
```svelte
  draggable={!["published", "publishing", "skipped"].includes(row.status)}
  ondragstart={(e) => actions.dragStart(e, row)}
```

In `src/views/MonthView.svelte`, add `let dropKey = $state<string | null>(null);` to the script, and add these to the day `<div>`:
```svelte
          class:is-drop={dropKey === cell.key}
          ondragover={(e) => { e.preventDefault(); dropKey = cell.key; }}
          ondragleave={() => (dropKey = null)}
          ondrop={(e) => { dropKey = null; actions.dropOnDay(e, cell.date); }}
```
Also add `actions` to the `useOsmm()` destructuring there (it's already present).

In `src/views/WeekView.svelte`, add `actions` to the destructuring (`const { settings, now, actions } = useOsmm();`) and add these to each `.osmm-week-col`:
```svelte
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => actions.dropOnSlot(e, c.date, Math.round(e.offsetY / PX_PER_MINUTE / 15) * 15)}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Manual check**

In the dev vault, drag the LinkedIn chip for Acme Studio to another day. The whole post moves, the Acme chip lands on the target day at 17:45, and Undo restores it. Drag onto a week slot and check the time snaps to 15 minutes. Drag a WordPress (handed-over) chip and check the confirmation appears.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(planner): reschedule by drag and drop with undo (refs #31)"
```

---

### Task 7: Pipeline board (#32)

**Files:**
- Create: `src/planner/board.ts`, `src/views/BoardView.svelte`, `test/planner/board.test.ts`, `test/ui/board.test.ts`
- Modify: `src/ui/actions.ts` (board moves, schedule/unschedule), `src/views/Planner.svelte` (board mode)

**Interfaces:**
- Produces: `BOARD_COLUMNS = ["idea","draft","ready","scheduled","published"]`, `type BoardColumn`; `columnOf(status: VariantStatus): BoardColumn | null`; `type BoardMove = { kind: "setStatus"; status: "idea" | "draft" | "ready" } | { kind: "schedule" } | { kind: "unschedule"; status: "idea" | "draft" | "ready" }`; `planBoardMove(v, to): { ok: true; move } | { ok: false; reason }`; `scheduleDeliveries(v): Record<string, Delivery>`; `unscheduleDeliveries(v, to: "draft" | "ready"): Record<string, Delivery>`; `defaultScheduleTime(now, v, defaultTime?): number`; `PlannerActions.moveOnBoard(v, to)`, `schedule(v, at)`, `unschedule(v, status)`, `setStatus(v, status)`; `<BoardView rows>`.

- [ ] **Step 1: Write the failing tests**

`test/planner/board.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { columnOf, defaultScheduleTime, planBoardMove, scheduleDeliveries, unscheduleDeliveries } from "../../src/planner/board";
import type { IndexedVariant } from "../../src/index/socialIndex";

function v(partial: Partial<IndexedVariant>): IndexedVariant {
  return { path: "p.md", platform: "linkedin", channels: ["li/me"], mode: "auto", status: "draft", media: [], deliveries: {}, issues: [], excerpt: "", displayTitle: "", file: {} as never, ...partial };
}

describe("board", () => {
  it.each([
    ["idea", "idea"],
    ["partial", "scheduled"],
    ["overdue", "scheduled"],
    ["attention", "scheduled"],
    ["published", "published"],
    ["skipped", null],
  ] as const)("columnOf(%s) = %s", (status, col) => {
    expect(columnOf(status)).toBe(col);
  });

  it("plans simple status moves", () => {
    expect(planBoardMove(v({ status: "idea" }), "ready")).toEqual({ ok: true, move: { kind: "setStatus", status: "ready" } });
  });

  it("needs channels to schedule", () => {
    expect(planBoardMove(v({ channels: [] }), "scheduled")).toEqual({ ok: false, reason: "Pick at least one channel before scheduling." });
    expect(planBoardMove(v({}), "scheduled")).toEqual({ ok: true, move: { kind: "schedule" } });
  });

  it("refuses to drag into or out of Published", () => {
    expect(planBoardMove(v({}), "published").ok).toBe(false);
    expect(planBoardMove(v({ status: "published" }), "draft").ok).toBe(false);
  });

  it("refuses to unschedule posts with handed-over or published channels (review focus 3)", () => {
    const post = v({ status: "partial", channels: ["li/me", "li/acme"], deliveries: { "li/me": { status: "published" }, "li/acme": { status: "scheduled" } } });
    expect(planBoardMove(post, "ready")).toEqual({ ok: false, reason: "Some channels were already handed over or published. Unschedule the remaining ones from the post itself." });
    expect(planBoardMove(v({ status: "scheduled", deliveries: { "li/me": { status: "scheduled" } } }), "draft")).toEqual({ ok: true, move: { kind: "unschedule", status: "draft" } });
  });

  it("schedules and unschedules deliveries through legal transitions", () => {
    const post = v({ channels: ["li/me", "li/acme"], deliveries: { "li/me": { status: "ready" } } });
    expect(scheduleDeliveries(post)).toEqual({ "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled" } });
    const scheduled = v({ channels: ["li/me"], deliveries: { "li/me": { status: "scheduled", at: 5 } } });
    expect(unscheduleDeliveries(scheduled, "ready")).toEqual({ "li/me": { status: "ready", at: 5 } });
  });

  it("proposes a sensible default time", () => {
    const now = new Date(2026, 9, 8, 10).getTime();
    expect(defaultScheduleTime(now, v({ scheduledAt: now + 3_600_000 }))).toBe(now + 3_600_000);
    expect(defaultScheduleTime(now, v({}), "08:30")).toBe(new Date(2026, 9, 9, 8, 30).getTime());
  });
});
```

`test/ui/board.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW } from "./ctx";
import { settle } from "../helpers";

describe("board actions", () => {
  it("schedules a ready post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const post = index.variants().find((x) => x.status === "ready")!;
    await ctx.actions.schedule(post, TEST_NOW + 86_400_000);
    await settle(5);
    const after = index.getVariant(post.path)!;
    expect(after.status).toBe("scheduled");
    expect(after.scheduledAt).toBe(TEST_NOW + 86_400_000);
  });

  it("explains a refused move", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const published = index.variants().find((x) => x.status === "published")!;
    await ctx.actions.moveOnBoard(published, "draft");
    expect(Notice.messages.at(-1)).toBe("Published posts stay published.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/board.test.ts test/ui/board.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `board.ts`**

```ts
import type { IndexedVariant } from "../index/socialIndex";
import { canTransition, transition } from "../model/stateMachine";
import type { Delivery, DeliveryStatus, Variant, VariantStatus } from "../model/types";

export const BOARD_COLUMNS = ["idea", "draft", "ready", "scheduled", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
type EditableStatus = "idea" | "draft" | "ready";

export type BoardMove =
  | { kind: "setStatus"; status: EditableStatus }
  | { kind: "schedule" }
  | { kind: "unschedule"; status: EditableStatus };

export function columnOf(status: VariantStatus): BoardColumn | null {
  switch (status) {
    case "idea":
    case "draft":
    case "ready":
      return status;
    case "scheduled":
    case "partial":
    case "overdue":
    case "attention":
      return "scheduled";
    case "published":
      return "published";
    case "skipped":
      return null;
  }
}

const UNSCHEDULABLE = new Set<DeliveryStatus>(["draft", "ready", "scheduled", "overdue", "skipped"]);

export function planBoardMove(
  v: IndexedVariant,
  to: BoardColumn,
): { ok: true; move: BoardMove } | { ok: false; reason: string } {
  const from = columnOf(v.status);
  if (from === to) return { ok: false, reason: "The post is already in this column." };
  if (from === "published") return { ok: false, reason: "Published posts stay published." };
  if (to === "published") return { ok: false, reason: "Posts move to Published when they are posted, not by dragging." };
  if (to === "scheduled") {
    return v.channels.length ? { ok: true, move: { kind: "schedule" } } : { ok: false, reason: "Pick at least one channel before scheduling." };
  }
  if (from === "scheduled") {
    const blocked = Object.values(v.deliveries).some((d) => !UNSCHEDULABLE.has(d.status));
    if (blocked) return { ok: false, reason: "Some channels were already handed over or published. Unschedule the remaining ones from the post itself." };
    return { ok: true, move: { kind: "unschedule", status: to } };
  }
  return { ok: true, move: { kind: "setStatus", status: to } };
}

export function scheduleDeliveries(v: Pick<Variant, "channels" | "deliveries">): Record<string, Delivery> {
  const out: Record<string, Delivery> = { ...v.deliveries };
  for (const id of v.channels) {
    const current = out[id] ?? { status: "draft" as const };
    if (canTransition(current.status, "scheduled")) out[id] = transition(current, "scheduled");
  }
  return out;
}

export function unscheduleDeliveries(v: Pick<Variant, "deliveries">, to: "draft" | "ready"): Record<string, Delivery> {
  const out: Record<string, Delivery> = {};
  for (const [id, d] of Object.entries(v.deliveries)) {
    out[id] = d.status === "scheduled" || d.status === "overdue" ? transition(d.status === "overdue" ? transition(d, "scheduled") : d, to) : d;
  }
  return out;
}

export function defaultScheduleTime(now: number, v: Pick<Variant, "scheduledAt">, defaultTime = "09:00"): number {
  if (v.scheduledAt !== undefined && v.scheduledAt >= now) return v.scheduledAt;
  const [h, m] = defaultTime.split(":").map(Number) as [number, number];
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
}
```

- [ ] **Step 4: Add the board actions**

Add to `src/ui/actions.ts` (imports: `import { Notice } from "obsidian";` if not present, `import { defaultScheduleTime, planBoardMove, scheduleDeliveries, unscheduleDeliveries, type BoardColumn } from "../planner/board";`, `import { pickDateTime } from "./dialogs";`, `import type { IndexedVariant } from "../index/socialIndex";`):
```ts
  async setStatus(v: IndexedVariant, status: "idea" | "draft" | "ready"): Promise<void> {
    await this.deps.writer.patchVariant(v.file, { status });
  }

  async schedule(v: IndexedVariant, at: number): Promise<void> {
    const previous = { scheduledAt: v.scheduledAt, deliveries: v.deliveries, status: v.status };
    await this.deps.writer.patchVariant(v.file, { scheduledAt: at, deliveries: scheduleDeliveries(v) });
    this.undoNotice(`Scheduled for ${formatShortDate(at)} ${formatTime(at)}.`, () => this.deps.writer.patchVariant(v.file, previous));
  }

  async unschedule(v: IndexedVariant, status: "idea" | "draft" | "ready"): Promise<void> {
    const previous = { deliveries: v.deliveries, status: v.status };
    const deliveries = unscheduleDeliveries(v, status === "ready" ? "ready" : "draft");
    await this.deps.writer.patchVariant(v.file, { status, deliveries });
    this.undoNotice("Unscheduled.", () => this.deps.writer.patchVariant(v.file, previous));
  }

  async moveOnBoard(v: IndexedVariant, to: BoardColumn): Promise<void> {
    const plan = planBoardMove(v, to);
    if (!plan.ok) {
      new Notice(plan.reason);
      return;
    }
    const { move } = plan;
    if (move.kind === "setStatus") return this.setStatus(v, move.status);
    if (move.kind === "unschedule") return this.unschedule(v, move.status);
    const channel = this.deps.channels.get(v.channels[0] ?? "");
    const at = await pickDateTime(this.deps.app, "Schedule post", defaultScheduleTime(this.deps.now(), v, channel?.defaultTime));
    if (at !== null) await this.schedule(v, at);
  }
```

- [ ] **Step 5: Implement `BoardView.svelte` and add board mode**

```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { BOARD_COLUMNS, columnOf, type BoardColumn } from "../planner/board";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { variants }: { variants: IndexedVariant[] } = $props();
  const { snapshot, now, actions } = useOsmm();
  const TITLES: Record<BoardColumn, string> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", published: "Published" };
  const MIME = "text/x-osmm-variant";
  let dropColumn = $state<BoardColumn | null>(null);

  const campaignTitle = $derived(new Map($snapshot.campaigns.map((c) => [c.path, c.title])));
  const columns = $derived(
    BOARD_COLUMNS.map((col) => ({
      col,
      cards: variants.filter((v) => columnOf(v.status) === col).sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity)),
    })),
  );

  function drop(event: DragEvent, col: BoardColumn): void {
    event.preventDefault();
    dropColumn = null;
    const path = event.dataTransfer?.getData(MIME);
    const v = variants.find((x) => x.path === path);
    if (v) void actions.moveOnBoard(v, col);
  }
</script>

<div class="osmm-board">
  {#each columns as { col, cards } (col)}
    <section
      class="osmm-column"
      class:is-drop={dropColumn === col}
      aria-label={TITLES[col]}
      ondragover={(e) => { e.preventDefault(); dropColumn = col; }}
      ondragleave={() => (dropColumn = null)}
      ondrop={(e) => drop(e, col)}>
      <h3 class="osmm-column-head">{TITLES[col]} <span class="osmm-progress">{cards.length}</span></h3>
      {#each cards as v (v.path)}
        {@const late = v.status === "overdue" || (v.status === "scheduled" && v.scheduledAt !== undefined && v.scheduledAt < $now)}
        <button
          type="button"
          class="osmm-card"
          class:is-late={late}
          draggable="true"
          ondragstart={(e) => e.dataTransfer?.setData(MIME, v.path)}
          onclick={() => actions.openNote(v.path)}>
          <span class="osmm-row"><PlatformBadge platform={v.platform} size="md" /><strong class="osmm-row-title">{v.displayTitle}</strong></span>
          {#if v.excerpt && v.excerpt !== v.displayTitle}<span>{v.excerpt}</span>{/if}
          <span class="osmm-card-meta">
            <span>{v.campaignPath ? (campaignTitle.get(v.campaignPath) ?? "") : "Standalone"}</span>
            <span class="osmm-spacer"></span>
            <span>{v.scheduledAt !== undefined ? `${formatShortDate(v.scheduledAt)} ${formatTime(v.scheduledAt)}` : "—"}</span>
          </span>
        </button>
      {/each}
    </section>
  {/each}
</div>
```

In `Planner.svelte`: set `MODES` to `["month", "week", "board"]` and import `BoardView`. Add a derived value for filtered variants, and a board branch:
```ts
  const boardVariants = $derived.by(() => {
    const keep = new Set(rows.map((r) => r.variant.path));
    return $snapshot.variants.filter((v) => keep.has(v.path));
  });
```
```svelte
    {:else if mode === "board"}
      <BoardView variants={boardVariants} />
```
In board mode, the toolbar title shows "Pipeline" and the prev/next buttons are hidden. Change the `title` derivation's first line to `if (mode === "board") return "Pipeline";` and wrap `.osmm-nav` in `{#if mode === "month" || mode === "week"}`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(planner): add pipeline board with guarded status moves (refs #32)"
```

---

### Task 8: List view with sorting and bulk actions (#33)

**Files:**
- Create: `src/planner/list.ts`, `src/views/ListView.svelte`, `test/planner/list.test.ts`, `test/ui/bulk.test.ts`
- Modify: `src/ui/actions.ts` (bulk actions), `src/views/Planner.svelte` (list mode)

**Interfaces:**
- Produces: `type SortKey = "at" | "platform" | "channel" | "campaign" | "status" | "title"`; `sortRows(rows, key, dir: "asc" | "desc", campaignTitle?: (path) => string): PostRow[]`; `uniqueVariants(rows): IndexedVariant[]`; `PlannerActions.bulkShift(rows, deltaMs): Promise<{ moved: number; skipped: number }>`, `bulkSetStatus(rows, status): Promise<{ changed: number; skipped: number }>`, `bulkTrash(rows): Promise<number>`; `<ListView rows>`.

- [ ] **Step 1: Write the failing tests**

`test/planner/list.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sortRows, uniqueVariants } from "../../src/planner/list";
import type { PostRow } from "../../src/index/queries";

const row = (key: string, at: number | undefined, platform: string, title: string): PostRow =>
  ({ key, at, status: "scheduled", channelId: null, variant: { path: key.split("#")[0], platform, displayTitle: title } }) as unknown as PostRow;

describe("list", () => {
  const rows = [row("a.md#", 3, "x", "Beta"), row("b.md#", undefined, "linkedin", "alpha"), row("c.md#", 1, "bluesky", "Gamma")];

  it("sorts by time with unscheduled rows last", () => {
    expect(sortRows(rows, "at", "asc").map((r) => r.key)).toEqual(["c.md#", "a.md#", "b.md#"]);
    expect(sortRows(rows, "at", "desc").map((r) => r.key)).toEqual(["a.md#", "c.md#", "b.md#"]);
  });

  it("sorts by title case-insensitively and by platform label", () => {
    expect(sortRows(rows, "title", "asc").map((r) => r.key)).toEqual(["b.md#", "a.md#", "c.md#"]);
    expect(sortRows(rows, "platform", "asc").map((r) => r.key)).toEqual(["c.md#", "b.md#", "a.md#"]);
  });

  it("deduplicates variants", () => {
    const v = { path: "p.md" };
    expect(uniqueVariants([{ variant: v }, { variant: v }] as unknown as PostRow[])).toHaveLength(1);
  });
});
```

`test/ui/bulk.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeCtx } from "./ctx";
import { settle } from "../helpers";

describe("bulk actions", () => {
  it("shifts every selected post once and skips frozen ones", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    // Selects "Event X – LinkedIn" (one channel published → skipped), "LinkedIn recap" and "Bluesky" (both moved).
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("Event X – LinkedIn") || r.variant.path.includes("Bluesky"));
    const before = new Map(rows.map((r) => [r.variant.path, r.variant.scheduledAt!]));
    const result = await ctx.actions.bulkShift(rows, 86_400_000);
    await settle(5);
    expect(result).toEqual({ moved: 2, skipped: 1 });
    for (const [path, at] of before) {
      const expected = path.endsWith("Event X – LinkedIn.md") ? at : at + 86_400_000;
      expect(index.getVariant(path)?.scheduledAt).toBe(expected);
    }
  });

  it("skips posts with channels beyond ready when changing status (review focus 5)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("OSMM launch") || r.variant.path.includes("Event X – LinkedIn.md"));
    const result = await ctx.actions.bulkSetStatus(rows, "draft");
    await settle(5);
    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(index.getVariant("Social/Event X/Event X – LinkedIn.md")?.status).toBe("partial");
    expect(index.getVariant("Social/OSMM launch/OSMM launch – Indie Hackers.md")?.status).toBe("draft");
  });

  it("moves selected notes to the trash after confirmation", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    ctx.actions.confirm = async () => true;
    const rows = ctx.actions.rows().filter((r) => r.variant.path.startsWith("Social/Posts/"));
    expect(await ctx.actions.bulkTrash(rows)).toBe(2);
    expect(app.vault.getFileByPath("Social/Posts/WhatsApp reminder.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/list.test.ts test/ui/bulk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `list.ts`**

```ts
import type { PostRow } from "../index/queries";
import type { IndexedVariant } from "../index/socialIndex";
import { PLATFORM_META } from "../model/platforms";

export type SortKey = "at" | "platform" | "channel" | "campaign" | "status" | "title";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortRows(
  rows: readonly PostRow[],
  key: SortKey,
  dir: "asc" | "desc",
  campaignTitle: (path: string | undefined) => string = (p) => p ?? "",
): PostRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const text = (r: PostRow): string => {
    switch (key) {
      case "platform":
        return PLATFORM_META[r.variant.platform].label;
      case "channel":
        return r.channelId ?? "";
      case "campaign":
        return campaignTitle(r.variant.campaignPath);
      case "status":
        return r.status;
      default:
        return r.variant.displayTitle;
    }
  };
  return [...rows].sort((a, b) => {
    if (key === "at") {
      if (a.at === undefined && b.at === undefined) return 0;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return sign * (a.at - b.at);
    }
    return sign * collator.compare(text(a), text(b));
  });
}

export function uniqueVariants(rows: readonly PostRow[]): IndexedVariant[] {
  const seen = new Map<string, IndexedVariant>();
  for (const r of rows) if (!seen.has(r.variant.path)) seen.set(r.variant.path, r.variant);
  return [...seen.values()];
}
```

- [ ] **Step 4: Add the bulk actions**

Add to `src/ui/actions.ts` (import `uniqueVariants` from `../planner/list`):
```ts
  async bulkShift(rows: PostRow[], deltaMs: number): Promise<{ moved: number; skipped: number }> {
    let moved = 0;
    let skipped = 0;
    for (const v of uniqueVariants(rows)) {
      const movable = v.scheduledAt !== undefined && !Object.values(v.deliveries).some((d) => ["published", "publishing", "handed_over"].includes(d.status));
      if (!movable) {
        skipped++;
        continue;
      }
      const deliveries = Object.fromEntries(Object.entries(v.deliveries).map(([id, d]) => [id, d.at === undefined ? d : { ...d, at: d.at + deltaMs }]));
      await this.deps.writer.patchVariant(v.file, { scheduledAt: v.scheduledAt! + deltaMs, deliveries });
      moved++;
    }
    new Notice(`Moved ${moved} post${moved === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} (published, handed over or unscheduled)` : ""}.`);
    return { moved, skipped };
  }

  async bulkSetStatus(rows: PostRow[], status: "idea" | "draft" | "ready"): Promise<{ changed: number; skipped: number }> {
    let changed = 0;
    let skipped = 0;
    const target = status === "ready" ? "ready" : "draft";
    for (const v of uniqueVariants(rows)) {
      const ds = Object.entries(v.deliveries);
      if (ds.some(([, d]) => d.status !== "draft" && d.status !== "ready")) {
        skipped++;
        continue;
      }
      const deliveries = Object.fromEntries(ds.map(([id, d]) => [id, d.status === target ? d : { ...d, status: target }]));
      await this.deps.writer.patchVariant(v.file, { status, deliveries });
      changed++;
    }
    new Notice(`Changed ${changed} post${changed === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already scheduled or published` : ""}.`);
    return { changed, skipped };
  }

  async bulkTrash(rows: PostRow[]): Promise<number> {
    const variants = uniqueVariants(rows);
    if (!variants.length) return 0;
    const ok = await this.confirm(`Move ${variants.length} note${variants.length === 1 ? "" : "s"} to the trash?`, "Move to trash");
    if (!ok) return 0;
    for (const v of variants) await this.deps.app.fileManager.trashFile(v.file);
    new Notice(`Moved ${variants.length} note${variants.length === 1 ? "" : "s"} to the trash.`);
    return variants.length;
  }
```

- [ ] **Step 5: Implement `ListView.svelte` and add list mode**

```svelte
<script lang="ts">
  import { Menu } from "obsidian";
  import type { PostRow } from "../index/queries";
  import { PLATFORM_META } from "../model/platforms";
  import { sortRows, type SortKey } from "../planner/list";
  import { STATUS_LABEL } from "../planner/status";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { rows }: { rows: PostRow[] } = $props();
  const { snapshot, channels, actions } = useOsmm();
  let sortKey = $state<SortKey>("at");
  let dir = $state<"asc" | "desc">("asc");
  let selected = $state<Set<string>>(new Set());

  const titles = $derived(new Map($snapshot.campaigns.map((c) => [c.path, c.title])));
  const sorted = $derived(sortRows(rows, sortKey, dir, (p) => (p ? (titles.get(p) ?? "") : "")));
  const chosen = $derived(sorted.filter((r) => selected.has(r.key)));
  const HEADERS: Array<[SortKey, string]> = [["at", "When"], ["platform", "Platform"], ["channel", "Channel"], ["title", "Post"], ["campaign", "Campaign"], ["status", "Status"]];

  function sortBy(key: SortKey): void {
    if (sortKey === key) dir = dir === "asc" ? "desc" : "asc";
    else {
      sortKey = key;
      dir = "asc";
    }
  }
  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }
  function toggleAll(): void {
    selected = selected.size === sorted.length ? new Set() : new Set(sorted.map((r) => r.key));
  }
  function shiftMenu(event: MouseEvent): void {
    const menu = new Menu();
    const H = 3_600_000;
    for (const [label, ms] of [["+1 hour", H], ["+1 day", 24 * H], ["+1 week", 7 * 24 * H], ["−1 day", -24 * H]] as const) {
      menu.addItem((i) => i.setTitle(label).onClick(() => void actions.bulkShift(chosen, ms)));
    }
    menu.showAtMouseEvent(event);
  }
  function statusMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const s of ["idea", "draft", "ready"] as const) menu.addItem((i) => i.setTitle(STATUS_LABEL[s]).onClick(() => void actions.bulkSetStatus(chosen, s)));
    menu.showAtMouseEvent(event);
  }
</script>

{#if chosen.length}
  <div class="osmm-bulkbar" role="toolbar" aria-label="Bulk actions">
    <span>{chosen.length} selected</span>
    <button type="button" onclick={shiftMenu}>Shift</button>
    <button type="button" onclick={statusMenu}>Set status</button>
    <button type="button" class="mod-warning" onclick={() => void actions.bulkTrash(chosen).then(() => (selected = new Set()))}>Move to trash</button>
  </div>
{/if}
<table class="osmm-table">
  <thead>
    <tr>
      <th><input type="checkbox" aria-label="Select all" checked={selected.size > 0 && selected.size === sorted.length} onchange={toggleAll} /></th>
      {#each HEADERS as [key, label] (key)}
        <th aria-sort={sortKey === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" onclick={() => sortBy(key)}>{label}</button>
        </th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each sorted as r (r.key)}
      <tr>
        <td><input type="checkbox" aria-label={`Select ${r.variant.displayTitle}`} checked={selected.has(r.key)} onchange={() => toggle(r.key)} /></td>
        <td>{r.at !== undefined ? `${formatShortDate(r.at)} ${formatTime(r.at)}` : "—"}</td>
        <td><span class="osmm-row"><PlatformBadge platform={r.variant.platform} />{PLATFORM_META[r.variant.platform].label}</span></td>
        <td>{r.channelId ? (channels.get(r.channelId)?.name ?? r.channelId) : "—"}</td>
        <td><button type="button" class="osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button></td>
        <td>{r.variant.campaignPath ? (titles.get(r.variant.campaignPath) ?? "") : "Standalone"}</td>
        <td><span class="osmm-pill-status">{STATUS_LABEL[r.status]}</span></td>
      </tr>
    {/each}
  </tbody>
</table>
```

In `Planner.svelte`: set `MODES` to `["month", "week", "board", "list"]`, import `ListView`, and add `{:else if mode === "list"}<ListView {rows} />`. The list shows all filtered rows, scheduled or not. Its title is "All posts": extend the `title` derivation with `if (mode === "list") return "All posts";`, and show the nav only for month and week.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(planner): add list view with sorting and bulk actions (refs #33)"
```

---

### Task 9: Sidebar — Overdue tray, Up next, Campaigns (#35)

**Files:**
- Create: `src/views/Sidebar.svelte`, `src/views/SidebarView.ts`, `test/views/sidebar.test.ts`
- Modify: `src/ui/actions.ts` (`skip`, `quickReschedule`), `src/main.ts` (register the sidebar view + command)

**Interfaces:**
- Produces: `PlannerActions.skip(row): Promise<void>`; `PlannerActions.quickReschedule(event, row): void` (menu: in 1 hour / tomorrow same time / pick a date…); `class SidebarView` (`VIEW_SIDEBAR`); command `open-sidebar`.

- [ ] **Step 1: Write the failing test**

`test/views/sidebar.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { settle } from "../helpers";

describe("Sidebar", () => {
  it("lists overdue posts, today's queue and campaign progress", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(ctx) });
    const overdue = screen.getByRole("region", { name: /Overdue/ });
    expect(overdue.textContent).toContain("One evening. Eighty makers.");
    expect(overdue.textContent).toContain("Show HN: Event X");
    expect(screen.getByRole("region", { name: "Up next · today" }).textContent).toContain("Event X is back");
    expect(screen.getByRole("region", { name: "Campaigns" }).textContent).toMatch(/Event X\s*1\/\d+/);
  });

  it("skips an overdue post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(ctx) });
    const buttons = screen.getAllByRole("button", { name: /^Skip/ });
    await fireEvent.click(buttons[0]!);
    await settle(5);
    expect(index.getVariant("Social/Event X/Event X – Instagram.md")?.deliveries["ig/acmestudio"]?.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/views/sidebar.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the actions**

Add to `src/ui/actions.ts` (imports: `Menu` from `obsidian`, `HOUR`, `DAY` and `addLocalDays` from `../model/dates`):
```ts
  async skip(row: PostRow): Promise<void> {
    const file = row.variant.file;
    if (row.channelId) await this.deps.writer.transitionDelivery(file, row.channelId, "skipped");
    else await this.deps.writer.patchVariant(file, { status: "skipped" });
    new Notice("Skipped.");
  }

  quickReschedule(event: MouseEvent, row: PostRow): void {
    const now = this.deps.now();
    const base = row.at ?? now;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("In 1 hour").onClick(() => void this.reschedule(row, { at: now + HOUR })));
    menu.addItem((i) => i.setTitle("Tomorrow, same time").onClick(() => void this.reschedule(row, { at: Math.max(addLocalDays(base, 1), now + HOUR) })));
    menu.addItem((i) =>
      i.setTitle("Pick a date…").onClick(async () => {
        const at = await pickDateTime(this.deps.app, "Reschedule", Math.max(base, now + DAY));
        if (at !== null) await this.reschedule(row, { at });
      }),
    );
    menu.showAtMouseEvent(event);
  }
```

- [ ] **Step 4: Implement the sidebar**

`src/views/Sidebar.svelte`:
```svelte
<script lang="ts">
  import { campaignProgress, expandRows, overdueRows, upcomingRows } from "../index/queries";
  import { startOfLocalDay, addLocalDays } from "../model/dates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  const { snapshot, settings, now, channels, actions } = useOsmm();
  const rows = $derived(expandRows($snapshot.variants, $settings.defaultStaggerMinutes));
  const overdue = $derived(overdueRows(rows, $now));
  const endOfDay = $derived(addLocalDays(startOfLocalDay($now), 1));
  const upNext = $derived(upcomingRows(rows, $now, endOfDay - $now));
  const campaigns = $derived(
    $snapshot.campaigns
      .filter((c) => c.status === "active")
      .map((c) => ({ c, ...campaignProgress($snapshot.variants, c.path) }))
      .sort((a, b) => (a.c.anchorDate ?? Infinity) - (b.c.anchorDate ?? Infinity)),
  );
</script>

<div class="osmm-sidebar">
  {#if overdue.length}
    <section class="osmm-overdue" aria-label={`Overdue · ${overdue.length}`}>
      <h3 class="osmm-section-title">Overdue · {overdue.length}</h3>
      {#each overdue as r (r.key)}
        <div class="osmm-row">
          <PlatformBadge platform={r.variant.platform} />
          <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button>
        </div>
        <div class="osmm-row">
          <span class="osmm-progress">{r.at !== undefined ? `${formatShortDate(r.at)} ${formatTime(r.at)}` : ""}{r.channelId ? ` · ${channels.get(r.channelId)?.name ?? r.channelId}` : ""}</span>
          <span class="osmm-spacer"></span>
          <button type="button" onclick={(e) => actions.quickReschedule(e, r)}>Reschedule</button>
          <button type="button" aria-label={`Skip ${r.variant.displayTitle}`} onclick={() => void actions.skip(r)}>Skip</button>
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

`src/views/SidebarView.ts`:
```ts
import { VIEW_SIDEBAR } from "../ui/actions";
import { SvelteItemView } from "../ui/SvelteView";
import Sidebar from "./Sidebar.svelte";

export class SidebarView extends SvelteItemView {
  getViewType(): string {
    return VIEW_SIDEBAR;
  }
  getDisplayText(): string {
    return "Social queue";
  }
  override getIcon(): string {
    return "list-todo";
  }
  protected component() {
    return Sidebar;
  }
  protected props() {
    return {};
  }
}
```

In `src/main.ts` (imports `SidebarView`, `VIEW_SIDEBAR`):
```ts
    this.registerView(VIEW_SIDEBAR, (leaf) => new SidebarView(leaf, this.uiContext()));
    this.addCommand({ id: "open-sidebar", name: "Open social queue (sidebar)", callback: () => void activateView(this.app, VIEW_SIDEBAR, "right") });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(planner): add sidebar with overdue tray, up next and campaigns (refs #35)"
```

---

### Task 10: `social-variants` campaign table (#36)

**Files:**
- Create: `src/planner/campaignTable.ts`, `src/views/CampaignTable.svelte`, `test/planner/campaignTable.test.ts`, `test/views/campaignTable.test.ts`
- Modify: `src/index/socialIndex.ts` (+`bodyChars`), `test/index/socialIndex.test.ts`, `src/ui/actions.ts` (`createVariantForCampaign`), `src/main.ts` (code-block processor)

**Interfaces:**
- Produces: `IndexedVariant.bodyChars: number` (graphemes of the plain-text body); `interface CampaignTableRow { variant; channels: Channel[]; when?: number; chars: number; status: VariantStatus }`; `campaignTable(campaignPath, variants, channels: Channel[]): { rows; missing: Platform[]; counts: { created; published; overdue } }`; `PlannerActions.createVariantForCampaign(campaignPath, platform): Promise<void>`; `<CampaignTable campaignPath>`.

- [ ] **Step 1: Add `bodyChars` to the index (test first)**

Append to the first test in `test/index/socialIndex.test.ts`:
```ts
    expect(variant?.bodyChars).toBe("I almost didn't host Event X.\n\nMore text".length);
```
Run: `npx vitest run test/index/socialIndex.test.ts`. Expected: FAIL (`bodyChars` is undefined).

In `src/index/socialIndex.ts`, add `bodyChars: number;` to `IndexedVariant`, import `countChars` and `plainText` from `../model/body`, and in `read()` replace the excerpt lines with:
```ts
    const body = bodyOf(await this.app.vault.cachedRead(file));
    const text = excerpt(body);
```
Add `bodyChars: countChars(plainText(body).replace(/^#+\s*/gm, "").trim()),` to the returned value. Update the `v()` helper in `test/index/queries.test.ts` and `test/planner/*.test.ts` fixtures with `bodyChars: 0`.

Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 2: Write the failing tests**

`test/planner/campaignTable.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { campaignTable } from "../../src/planner/campaignTable";
import { buildSeed } from "../../scripts/seedData";
import { migrateSettings } from "../../src/settings/settings";
import type { IndexedVariant } from "../../src/index/socialIndex";

const channels = migrateSettings(buildSeed(0).settings).channels;
const v = (path: string, platform: IndexedVariant["platform"], status: IndexedVariant["status"], ids: string[], campaignPath = "ex.md") =>
  ({ path, platform, status, channels: ids, campaignPath, deliveries: {}, bodyChars: 10, scheduledAt: 1 }) as unknown as IndexedVariant;

describe("campaignTable", () => {
  const variants = [
    v("li.md", "linkedin", "partial", ["li/me", "li/acme-studio"]),
    v("x.md", "x", "published", ["x/you"]),
    v("ig.md", "instagram", "overdue", ["ig/acmestudio"]),
    v("other.md", "x", "draft", ["x/you"], "other.md"),
  ];
  const table = campaignTable("ex.md", variants, channels);

  it("lists the campaign's variants in platform order with resolved channels", () => {
    expect(table.rows.map((r) => r.variant.path)).toEqual(["li.md", "x.md", "ig.md"]);
    expect(table.rows[0]!.channels.map((c) => c.name)).toEqual(["Me", "Acme Studio"]);
  });

  it("offers platforms that have channels but no variant yet", () => {
    expect(table.missing).toEqual(["facebook", "mastodon", "bluesky", "telegram", "discord", "hackernews", "indiehackers", "whatsapp", "wordpress"]);
  });

  it("counts created, published and overdue variants", () => {
    expect(table.counts).toEqual({ created: 3, published: 1, overdue: 1 });
  });
});
```

`test/views/campaignTable.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { settle } from "../helpers";

describe("CampaignTable", () => {
  it("renders variants and creates a missing one with all channels of that platform", async () => {
    const { app, ctx, index } = await makeCtx({ seed: true });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(ctx) });
    expect(screen.getByText(/9 created · 0 published · 1 overdue/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp variant" }));
    await settle(5);
    const created = index.getVariant("Social/Event X/Event X – WhatsApp.md");
    expect(created?.channels).toEqual(["wa/makers-berlin"]);
    expect(app.workspace.opened.at(-1)?.linktext).toBe("Social/Event X/Event X – WhatsApp.md");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/planner/campaignTable.test.ts test/views/campaignTable.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `campaignTable.ts`**

```ts
import type { IndexedVariant } from "../index/socialIndex";
import { PLATFORMS, type Platform } from "../model/platforms";
import type { Channel, VariantStatus } from "../model/types";

export interface CampaignTableRow {
  variant: IndexedVariant;
  channels: Channel[];
  when?: number;
  chars: number;
  status: VariantStatus;
}

export function campaignTable(
  campaignPath: string,
  variants: readonly IndexedVariant[],
  channels: readonly Channel[],
): { rows: CampaignTableRow[]; missing: Platform[]; counts: { created: number; published: number; overdue: number } } {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const order = (p: Platform) => PLATFORMS.indexOf(p);
  const own = variants
    .filter((v) => v.campaignPath === campaignPath)
    .sort((a, b) => order(a.platform) - order(b.platform) || a.path.localeCompare(b.path));
  const rows = own.map((v) => ({
    variant: v,
    channels: v.channels.map((id) => byId.get(id)).filter((c): c is Channel => c !== undefined),
    when: v.scheduledAt,
    chars: v.bodyChars,
    status: v.status,
  }));
  const present = new Set(own.map((v) => v.platform));
  const configured = new Set(channels.map((c) => c.platform));
  const missing = PLATFORMS.filter((p) => configured.has(p) && !present.has(p));
  return {
    rows,
    missing,
    counts: {
      created: own.length,
      published: own.filter((v) => v.status === "published").length,
      overdue: own.filter((v) => v.status === "overdue").length,
    },
  };
}
```

- [ ] **Step 5: Add the action and the component**

Add to `src/ui/actions.ts`:
```ts
  async createVariantForCampaign(campaignPath: string, platform: Platform): Promise<void> {
    const file = this.deps.app.vault.getFileByPath(campaignPath);
    if (!file) {
      new Notice("Campaign note not found.");
      return;
    }
    const created = await this.deps.factory.createVariant({
      campaign: file,
      platform,
      channels: this.deps.channels.byPlatform(platform).map((c) => c.id),
    });
    this.openNote(created.path);
  }
```
(import `type Platform` from `../model/platforms`).

`src/views/CampaignTable.svelte`:
```svelte
<script lang="ts">
  import { PLATFORM_META } from "../model/platforms";
  import { campaignTable } from "../planner/campaignTable";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { campaignPath }: { campaignPath: string } = $props();
  const { snapshot, settings, actions } = useOsmm();
  const table = $derived(campaignTable(campaignPath, $snapshot.variants, $settings.channels));
  const STATUS: Record<string, string> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", partial: "Partly published", published: "Published", overdue: "Overdue", attention: "Needs attention", skipped: "Skipped" };
</script>

<section class="osmm-variants" aria-label="Platform variants">
  <header class="osmm-variants-head">
    <strong>Platform variants</strong>
    <span class="osmm-progress">{table.counts.created} created · {table.counts.published} published · {table.counts.overdue} overdue</span>
  </header>
  <table class="osmm-table">
    <thead>
      <tr><th>Platform</th><th>Channels</th><th>Mode</th><th>Scheduled</th><th>Length</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr>
    </thead>
    <tbody>
      {#each table.rows as r (r.variant.path)}
        <tr>
          <td><span class="osmm-row"><PlatformBadge platform={r.variant.platform} size="md" />{PLATFORM_META[r.variant.platform].label}</span></td>
          <td><span class="osmm-row">{#each r.channels as c (c.id)}<ChannelAvatar channel={c} size={20} />{/each}</span></td>
          <td>{r.variant.mode === "assisted" ? "Assisted" : "Auto-post"}</td>
          <td>{r.when !== undefined ? `${formatShortDate(r.when)} ${formatTime(r.when)}` : "—"}</td>
          <td class="osmm-progress">{r.chars}</td>
          <td><span class="osmm-pill-status">{STATUS[r.status] ?? r.status}</span></td>
          <td><button type="button" onclick={() => actions.openNote(r.variant.path)}>Open</button></td>
        </tr>
      {/each}
      {#each table.missing as p (p)}
        <tr class="is-missing">
          <td><span class="osmm-row"><PlatformBadge platform={p} size="md" />{PLATFORM_META[p].label}</span></td>
          <td colspan="5" class="osmm-progress">not created</td>
          <td><button type="button" aria-label={`Create ${PLATFORM_META[p].label} variant`} onclick={() => void actions.createVariantForCampaign(campaignPath, p)}>Create variant</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
```
Add to `planner.css`: `.osmm .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }` and `.osmm-variants tr.is-missing { opacity: 0.75; }`.

- [ ] **Step 6: Register the code-block processor**

In `src/main.ts` (imports `SvelteRenderChild` from `./ui/SvelteView` and `CampaignTable` from `./views/CampaignTable.svelte`):
```ts
    this.registerMarkdownCodeBlockProcessor("social-variants", (_source, el, ctx) => {
      ctx.addChild(new SvelteRenderChild(el, CampaignTable, { campaignPath: ctx.sourcePath }, this.uiContext()));
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Manual check**

Open `Social/Event X/Event X.md` in Reading view and in Live Preview. The table matches mockup artboard 2 (minus the M2 actions). "Create variant" creates and opens the note, and the table updates live when a variant's frontmatter changes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(campaign): render interactive social-variants table (refs #36)"
```

---

### Task 11: Campaign timeline and schedule templates (#37)

**Files:**
- Create: `src/planner/templates.ts`, `src/views/Timeline.svelte`, `src/views/TemplatePreview.svelte`, `test/planner/templates.test.ts`, `test/ui/templates.test.ts`
- Modify: `src/settings/settings.ts` (schema v2 + templates), `test/settings/settings.test.ts`, `src/settings/tab.ts` (templates section), `test/fakes/obsidian.ts` (`addTextArea`, `addButton`), `src/ui/actions.ts` (`applyTemplate`, `openTemplatePreview`), `src/views/CampaignTable.svelte` (timeline + button)

**Interfaces:**
- Produces: `interface TemplateStep { offsetDays: number; time: string; platforms: Platform[]; label: string }`; `interface ScheduleTemplate { id: string; name: string; steps: TemplateStep[] }`; `zScheduleTemplate`; `DEFAULT_TEMPLATES`; `parseTemplateLines(text): { steps: TemplateStep[]; errors: string[] }`; `formatTemplateLines(steps): string`; `relativeDayLabel(at, anchor): string`; `interface TimelineStep { offset; label; date; platforms: Platform[]; done: boolean }`; `campaignTimeline(anchor, variants): TimelineStep[]`; `interface TemplateProposal { variant: IndexedVariant; from?: number; to: number; label: string }`; `planTemplate(template, anchor, variants): TemplateProposal[]`; `OsmmSettings.scheduleTemplates` (schema **2**); `PlannerActions.applyTemplate(proposals)` and `openTemplatePreview(campaignPath, templateId)`.

- [ ] **Step 1: Write the failing tests**

`test/planner/templates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, campaignTimeline, formatTemplateLines, parseTemplateLines, planTemplate, relativeDayLabel } from "../../src/planner/templates";
import type { IndexedVariant } from "../../src/index/socialIndex";

const anchor = new Date(2026, 9, 12, 18).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const v = (path: string, platform: IndexedVariant["platform"], scheduledAt?: number, status: IndexedVariant["status"] = "draft") =>
  ({ path, platform, scheduledAt, status, channels: [], deliveries: {} }) as unknown as IndexedVariant;

describe("template lines", () => {
  it("parses and formats", () => {
    const { steps, errors } = parseTemplateLines("T-7 09:00 linkedin,x Announce\nT0 17:30 x\nT+1 09:00 linkedin Recap");
    expect(errors).toEqual([]);
    expect(steps).toEqual([
      { offsetDays: -7, time: "09:00", platforms: ["linkedin", "x"], label: "Announce" },
      { offsetDays: 0, time: "17:30", platforms: ["x"], label: "" },
      { offsetDays: 1, time: "09:00", platforms: ["linkedin"], label: "Recap" },
    ]);
    expect(formatTemplateLines(steps)).toBe("T-7 09:00 linkedin,x Announce\nT0 17:30 x\nT+1 09:00 linkedin Recap");
  });

  it("reports bad lines", () => {
    expect(parseTemplateLines("T-7 9am linkedin\nT-2 10:00 myspace").errors).toEqual([
      'Line 1: expected "T±days HH:mm platforms [label]"',
      "Line 2: unknown platform myspace",
    ]);
  });

  it("ships a Launch template", () => {
    expect(DEFAULT_TEMPLATES[0]!.name).toBe("Launch");
  });
});

describe("timeline", () => {
  it("labels days relative to the anchor", () => {
    expect(relativeDayLabel(at(5, 9), anchor)).toBe("T-7");
    expect(relativeDayLabel(at(12, 23), anchor)).toBe("T0");
    expect(relativeDayLabel(at(13, 9), anchor)).toBe("T+1");
  });

  it("groups variants by relative day", () => {
    const steps = campaignTimeline(anchor, [v("a", "linkedin", at(5, 9), "published"), v("b", "x", at(5, 9, 5), "published"), v("c", "instagram", at(12, 16))]);
    expect(steps.map((s) => [s.label, s.platforms, s.done])).toEqual([
      ["T-7", ["linkedin", "x"], true],
      ["T0", ["instagram"], false],
    ]);
  });
});

describe("planTemplate", () => {
  it("assigns steps to variants of matching platforms, in order", () => {
    const template = { id: "t", name: "T", steps: parseTemplateLines("T-7 09:00 linkedin,x\nT+1 09:00 linkedin").steps };
    // The pool is ordered by current schedule, so li.md (Oct 1) is used before li-recap.md (Oct 2).
    const proposals = planTemplate(template, anchor, [v("li-recap.md", "linkedin", at(2, 9)), v("li.md", "linkedin", at(1, 9)), v("x.md", "x"), v("pub.md", "x", at(1, 9), "published")]);
    expect(proposals.map((p) => [p.variant.path, p.to, p.label])).toEqual([
      ["li.md", at(5, 9), "T-7"],
      ["x.md", at(5, 9), "T-7"],
      ["li-recap.md", at(13, 9), "T+1"],
    ]);
  });
});
```

Add to `test/settings/settings.test.ts`:
```ts
  it("migrates v1 settings to v2 with default templates", () => {
    const s = migrateSettings({ schemaVersion: 1, rootFolder: "Social" });
    expect(s.schemaVersion).toBe(2);
    expect(s.scheduleTemplates.map((t) => t.name)).toEqual(["Launch"]);
  });
```
Change the existing `expect(migrateSettings(undefined).schemaVersion).toBe(1);` and `expect(s.schemaVersion).toBe(1);` assertions to `2`.

`test/ui/templates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeCtx } from "./ctx";
import { settle } from "../helpers";
import { planTemplate, DEFAULT_TEMPLATES } from "../../src/planner/templates";
import { Notice } from "../fakes/obsidian";

describe("applyTemplate", () => {
  it("writes proposed times and can undo them", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const campaign = index.getCampaign("Social/Event X/Event X.md")!;
    const proposals = planTemplate(DEFAULT_TEMPLATES[0]!, campaign.anchorDate!, index.variantsOf(campaign.path));
    expect(proposals.length).toBeGreaterThan(0);
    await ctx.actions.applyTemplate(proposals);
    await settle(5);
    for (const p of proposals) expect(index.getVariant(p.variant.path)?.scheduledAt).toBe(p.to);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await settle(5);
    for (const p of proposals) expect(index.getVariant(p.variant.path)?.scheduledAt).toBe(p.from);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/planner/templates.test.ts test/ui/templates.test.ts test/settings`
Expected: FAIL.

- [ ] **Step 3: Implement `templates.ts`**

```ts
import { z } from "zod";
import type { IndexedVariant } from "../index/socialIndex";
import { DAY } from "../model/dates";
import { isPlatform, type Platform } from "../model/platforms";
import { zPlatform, zTimeOfDay } from "../model/schemas";
import { dayKey } from "./calendar";

export interface TemplateStep {
  offsetDays: number;
  time: string;
  platforms: Platform[];
  label: string;
}

export interface ScheduleTemplate {
  id: string;
  name: string;
  steps: TemplateStep[];
}

export const zScheduleTemplate = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1),
  steps: z.array(
    z.object({ offsetDays: z.number().int().min(-365).max(365), time: zTimeOfDay, platforms: z.array(zPlatform).min(1), label: z.string() }),
  ),
});

const LINE_RE = /^T([+-]?\d+)\s+(\d{2}:\d{2})\s+([a-z,]+)(?:\s+(.*))?$/;

export function parseTemplateLines(text: string): { steps: TemplateStep[]; errors: string[] } {
  const steps: TemplateStep[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .forEach((line, i) => {
      if (!line) return;
      const m = LINE_RE.exec(line);
      if (!m || !zTimeOfDay.safeParse(m[2]).success) {
        errors.push(`Line ${i + 1}: expected "T±days HH:mm platforms [label]"`);
        return;
      }
      const names = (m[3] ?? "").split(",").filter(Boolean);
      const unknown = names.find((n) => !isPlatform(n));
      if (unknown) {
        errors.push(`Line ${i + 1}: unknown platform ${unknown}`);
        return;
      }
      steps.push({ offsetDays: Number(m[1]), time: m[2]!, platforms: names as Platform[], label: (m[4] ?? "").trim() });
    });
  return { steps, errors };
}

const offsetLabel = (n: number) => (n === 0 ? "T0" : n > 0 ? `T+${n}` : `T${n}`);

export function formatTemplateLines(steps: readonly TemplateStep[]): string {
  return steps.map((s) => [offsetLabel(s.offsetDays), s.time, s.platforms.join(","), s.label].filter(Boolean).join(" ")).join("\n");
}

export const DEFAULT_TEMPLATES: ScheduleTemplate[] = [
  {
    id: "launch",
    name: "Launch",
    steps: parseTemplateLines(
      [
        "T-7 09:00 linkedin,x,mastodon,bluesky Announce",
        "T-6 18:00 instagram,facebook Visual push",
        "T-4 11:00 telegram,discord,whatsapp,reddit,hackernews,indiehackers Details",
        "T-2 09:00 wordpress Article",
        "T0 17:30 x,mastodon,bluesky Live",
        "T+1 09:00 linkedin Recap",
      ].join("\n"),
    ).steps,
  },
];

function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

export function relativeDayLabel(at: number, anchor: number): string {
  return offsetLabel(localDayIndex(at) - localDayIndex(anchor));
}

export interface TimelineStep {
  offset: number;
  label: string;
  date: number;
  platforms: Platform[];
  done: boolean;
}

export function campaignTimeline(anchor: number, variants: readonly IndexedVariant[]): TimelineStep[] {
  const byDay = new Map<string, TimelineStep>();
  for (const v of [...variants].filter((x) => x.scheduledAt !== undefined).sort((a, b) => a.scheduledAt! - b.scheduledAt!)) {
    const key = dayKey(v.scheduledAt!);
    const offset = localDayIndex(v.scheduledAt!) - localDayIndex(anchor);
    const step = byDay.get(key) ?? { offset, label: offsetLabel(offset), date: v.scheduledAt!, platforms: [], done: true };
    if (!step.platforms.includes(v.platform)) step.platforms.push(v.platform);
    step.done &&= v.status === "published" || v.status === "skipped";
    byDay.set(key, step);
  }
  return [...byDay.values()].sort((a, b) => a.offset - b.offset);
}

export interface TemplateProposal {
  variant: IndexedVariant;
  from?: number;
  to: number;
  label: string;
}

const LOCKED = new Set(["published", "partial", "skipped"]);

export function planTemplate(template: ScheduleTemplate, anchor: number, variants: readonly IndexedVariant[]): TemplateProposal[] {
  const pool = [...variants]
    .filter((v) => !LOCKED.has(v.status) && !Object.values(v.deliveries).some((d) => d.status === "handed_over" || d.status === "published"))
    .sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity) || a.path.localeCompare(b.path));
  const used = new Set<string>();
  const a = new Date(anchor);
  const proposals: TemplateProposal[] = [];
  for (const step of [...template.steps].sort((x, y) => x.offsetDays - y.offsetDays)) {
    const [h, m] = step.time.split(":").map(Number) as [number, number];
    const to = new Date(a.getFullYear(), a.getMonth(), a.getDate() + step.offsetDays, h, m).getTime();
    for (const platform of step.platforms) {
      const v = pool.find((x) => x.platform === platform && !used.has(x.path));
      if (!v) continue;
      used.add(v.path);
      proposals.push({ variant: v, from: v.scheduledAt, to, label: offsetLabel(step.offsetDays) });
    }
  }
  return proposals;
}
```

- [ ] **Step 4: Settings schema v2**

In `src/settings/settings.ts`:
- Set `SETTINGS_VERSION = 2`, add `scheduleTemplates: ScheduleTemplate[]` to `OsmmSettings`, and set `scheduleTemplates: structuredClone(DEFAULT_TEMPLATES)` in `DEFAULT_SETTINGS`. Import from `../planner/templates`.
- Add the migration `1: (raw) => ({ ...raw, schemaVersion: 2, scheduleTemplates: structuredClone(DEFAULT_TEMPLATES) })`.
- In `sanitize`, add:
```ts
  const templates = (Array.isArray(raw.scheduleTemplates) ? raw.scheduleTemplates : [])
    .map((t) => zScheduleTemplate.safeParse(t))
    .flatMap((r) => (r.success ? [r.data] : []));
```
  and `scheduleTemplates: templates,` in the returned object.

Update `scripts/seedData.ts` to write `schemaVersion: 2` together with `scheduleTemplates: DEFAULT_TEMPLATES` (import it).

- [ ] **Step 5: Add the actions, the preview and the timeline**

`src/views/TemplatePreview.svelte`:
```svelte
<script lang="ts">
  import { PLATFORM_META } from "../model/platforms";
  import type { TemplateProposal } from "../planner/templates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { proposals, close }: { proposals: TemplateProposal[]; close: () => void } = $props();
  const { actions } = useOsmm();
  const when = (ms?: number) => (ms === undefined ? "—" : `${formatShortDate(ms)} ${formatTime(ms)}`);
</script>

{#if proposals.length}
  <table class="osmm-table">
    <thead><tr><th>Step</th><th>Post</th><th>From</th><th>To</th></tr></thead>
    <tbody>
      {#each proposals as p (p.variant.path)}
        <tr>
          <td>{p.label}</td>
          <td><span class="osmm-row"><PlatformBadge platform={p.variant.platform} />{PLATFORM_META[p.variant.platform].label} · {p.variant.displayTitle}</span></td>
          <td>{when(p.from)}</td>
          <td><strong>{when(p.to)}</strong></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="modal-button-container">
    <button type="button" class="mod-cta" onclick={() => void actions.applyTemplate(proposals).then(close)}>Apply to {proposals.length} posts</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
{:else}
  <p>No unpublished variants match this template's platforms.</p>
{/if}
```

`src/views/Timeline.svelte`:
```svelte
<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { campaignTimeline } from "../planner/templates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { formatShortDate } from "../ui/format";

  let { anchor, variants }: { anchor: number; variants: IndexedVariant[] } = $props();
  const steps = $derived(campaignTimeline(anchor, variants));
</script>

<ol class="osmm-timeline" aria-label="Campaign timeline">
  {#each steps as s (s.label)}
    <li class="osmm-row">
      <span class="osmm-progress">{s.label}</span>
      <span>{formatShortDate(s.date)}</span>
      <span class="osmm-row">{#each s.platforms as p (p)}<PlatformBadge platform={p} />{/each}</span>
      {#if s.done}<span aria-label="done">✓</span>{/if}
    </li>
  {/each}
</ol>
```

Add to `src/ui/actions.ts` (imports: `planTemplate`, `type TemplateProposal` from `../planner/templates`; `SvelteModal` from `./dialogs`; `TemplatePreview` from `../views/TemplatePreview.svelte`; `type OsmmContext` from `./context`):
```ts
  /** Set by the plugin so actions can open Svelte modals with the same context. */
  context: OsmmContext | null = null;

  async applyTemplate(proposals: TemplateProposal[]): Promise<void> {
    for (const p of proposals) await this.deps.writer.patchVariant(p.variant.file, { scheduledAt: p.to });
    this.undoNotice(`Scheduled ${proposals.length} post${proposals.length === 1 ? "" : "s"} from the template.`, async () => {
      for (const p of proposals) await this.deps.writer.patchVariant(p.variant.file, { scheduledAt: p.from });
    });
  }

  openTemplatePreview(campaignPath: string, templateId: string): void {
    const campaign = this.deps.index.getCampaign(campaignPath);
    const template = this.deps.settings().scheduleTemplates.find((t) => t.id === templateId);
    if (!campaign?.anchorDate) {
      new Notice("Set anchor_date on the campaign first.");
      return;
    }
    if (!template || !this.context) return;
    const proposals = planTemplate(template, campaign.anchorDate, this.deps.index.variantsOf(campaignPath));
    new SvelteModal(this.deps.app, `Apply “${template.name}”`, TemplatePreview, { proposals }, this.context).open();
  }
```
In `main.ts` `uiContext()`, after building `this.ui`, set `this.ui.actions.context = this.ui;`. In `test/ui/ctx.ts`, set `actions.context = ctx;` after building `ctx`.

In `src/views/CampaignTable.svelte`, extend the script with a campaign lookup, a template menu and the timeline:
```ts
  import { Menu } from "obsidian";
  import Timeline from "./Timeline.svelte";
  const campaign = $derived($snapshot.campaigns.find((c) => c.path === campaignPath));
  function templateMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const t of $settings.scheduleTemplates) menu.addItem((i) => i.setTitle(t.name).onClick(() => actions.openTemplatePreview(campaignPath, t.id)));
    menu.showAtMouseEvent(event);
  }
```
Add to the header, after the counts: `<span class="osmm-spacer"></span><button type="button" onclick={templateMenu}>Apply schedule template</button>`. After `</table>`:
```svelte
  {#if campaign?.anchorDate !== undefined}
    <Timeline anchor={campaign.anchorDate} variants={table.rows.map((r) => r.variant)} />
  {/if}
```

- [ ] **Step 6: Templates section in the settings tab**

Add `TextAreaComponent` and `ButtonComponent` to the fake (`test/fakes/obsidian.ts`):
```ts
export class TextAreaComponent extends TextComponent {}
export class ButtonComponent {
  private cb: (() => unknown) | undefined;
  text = "";
  setButtonText(t: string): this {
    this.text = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(cb: () => unknown): this {
    this.cb = cb;
    return this;
  }
  async click(): Promise<void> {
    await this.cb?.();
  }
}
// in class Setting:
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    const c = new TextAreaComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    const c = new ButtonComponent();
    this.components.push(c as never);
    cb(c);
    return this;
  }
```

In `src/settings/tab.ts`, append to `display()` (imports `parseTemplateLines`, `formatTemplateLines`):
```ts
    new Setting(containerEl).setName("Schedule templates").setHeading();
    for (const template of s.scheduleTemplates) {
      new Setting(containerEl)
        .setName(template.name)
        .setDesc("One step per line: T±days HH:mm platforms [label], e.g. T-7 09:00 linkedin,x Announce")
        .addTextArea((t) =>
          t.setValue(formatTemplateLines(template.steps)).onChange(async (value) => {
            const { steps, errors } = parseTemplateLines(value);
            if (errors.length) return;
            await this.osmm.updateSettings({
              scheduleTemplates: this.osmm.settings.scheduleTemplates.map((x) => (x.id === template.id ? { ...x, steps } : x)),
            });
          }),
        );
    }
```
Update the settings-tab test in `test/main.test.ts` so the expected names end with `"Schedule templates", "Launch"`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(campaign): add relative timeline and schedule templates with preview (refs #37)"
```

---

### Task 12: Commands, ribbon and quick-create modals (#38)

**Files:**
- Create: `src/views/QuickCreate.svelte`, `src/commands.ts`, `test/views/quickCreate.test.ts`, `test/commands.test.ts`
- Modify: `src/main.ts` (use `registerCommands`), `src/ui/actions.ts` (`quickCreate`, `newVariantForActiveCampaign`), `src/views/Sidebar.svelte` ("New campaign" button)

**Interfaces:**
- Produces: `validateQuickCreate(input): string[]` (exported from `QuickCreate.svelte` via a `<script module>` block); `PlannerActions.quickCreate(kind: "campaign" | "post"): void`; `PlannerActions.newVariantForActiveCampaign(): boolean` (check callback); `registerCommands(plugin)`, which registers `open-planner`, `open-board`, `open-sidebar`, `new-campaign`, `new-post` and `new-variant-for-campaign`, plus the ribbon icon.

- [ ] **Step 1: Write the failing tests**

`test/views/quickCreate.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import QuickCreate, { validateQuickCreate } from "../../src/views/QuickCreate.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { settle } from "../helpers";

describe("validateQuickCreate", () => {
  it("requires a title for campaigns and a channel for posts", () => {
    expect(validateQuickCreate({ kind: "campaign", title: " " })).toEqual(["Give the campaign a title."]);
    expect(validateQuickCreate({ kind: "post", title: "Hi", platform: "x", channels: [] })).toEqual(["Pick at least one channel."]);
    expect(validateQuickCreate({ kind: "post", title: "Hi", platform: "x", channels: ["x/you"] })).toEqual([]);
  });
});

describe("QuickCreate", () => {
  it("creates a campaign and opens it", async () => {
    const { app, ctx, index } = await makeCtx();
    const close = vi.fn();
    render(QuickCreate, { props: { kind: "campaign", close }, context: osmmContext(ctx) });
    await fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Spring meetup" } });
    await fireEvent.input(screen.getByLabelText("Anchor date"), { target: { value: "2026-11-20" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await settle(5);
    expect(index.campaigns().map((c) => c.title)).toEqual(["Spring meetup"]);
    expect(app.workspace.opened.at(-1)?.linktext).toBe("Social/Spring meetup/Spring meetup.md");
    expect(close).toHaveBeenCalled();
  });

  it("shows validation errors instead of creating", async () => {
    const { ctx, index } = await makeCtx();
    render(QuickCreate, { props: { kind: "campaign", close: () => {} }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByRole("alert").textContent).toContain("Give the campaign a title.");
    expect(index.campaigns()).toEqual([]);
  });
});
```

`test/commands.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App } from "./fakes/obsidian";
import OsmmPlugin from "../src/main";
import { settle, writeNote } from "./helpers";

describe("commands", () => {
  it("registers the M1 commands", async () => {
    const app = new App();
    const plugin = new OsmmPlugin(app as never, { id: "osmm-social-planner", name: "", version: "", minAppVersion: "", description: "", author: "" });
    await plugin.load();
    const ids = (plugin as unknown as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    expect(ids).toEqual(["open-planner", "open-board", "open-sidebar", "new-campaign", "new-post", "new-variant-for-campaign"]);
    plugin.unload();
  });

  it("only offers 'new variant' when the active note is a campaign", async () => {
    const app = new App();
    const plugin = new OsmmPlugin(app as never, { id: "osmm-social-planner", name: "", version: "", minAppVersion: "", description: "", author: "" });
    await plugin.load();
    const cmd = (plugin as unknown as { commands: Array<{ id: string; checkCallback: (c: boolean) => boolean }> }).commands.find((c) => c.id === "new-variant-for-campaign")!;
    expect(cmd.checkCallback(true)).toBe(false);
    app.workspace.activeFile = await writeNote(app as never, "Social/E/E.md", { type: "social-campaign", title: "E" });
    await settle(60);
    expect(cmd.checkCallback(true)).toBe(true);
    plugin.unload();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/views/quickCreate.test.ts test/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `QuickCreate.svelte`**

```svelte
<script module lang="ts">
  import type { Platform } from "../model/platforms";

  export type QuickCreateInput =
    | { kind: "campaign"; title: string }
    | { kind: "post"; title: string; platform: Platform; channels: string[] };

  export function validateQuickCreate(input: QuickCreateInput): string[] {
    const errors: string[] = [];
    if (!input.title.trim()) errors.push(input.kind === "campaign" ? "Give the campaign a title." : "Give the post a title.");
    if (input.kind === "post" && input.channels.length === 0) errors.push("Pick at least one channel.");
    return errors;
  }
</script>

<script lang="ts">
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { useOsmm } from "../ui/context";

  let { kind, close }: { kind: "campaign" | "post"; close: () => void } = $props();
  const { channels, snapshot, actions } = useOsmm();

  let title = $state("");
  let date = $state("");
  let time = $state("18:00");
  let link = $state("");
  let platform = $state<Platform>("linkedin");
  let selected = $state<string[]>([]);
  let campaignPath = $state("");
  let errors = $state<string[]>([]);

  const platformChannels = $derived(channels.byPlatform(platform));

  function when(): number | undefined {
    if (!date) return undefined;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const [h, min] = (time || "09:00").split(":").map(Number) as [number, number];
    return new Date(y, m - 1, d, h, min).getTime();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const input: QuickCreateInput =
      kind === "campaign" ? { kind: "campaign", title } : { kind: "post", title, platform, channels: selected };
    errors = validateQuickCreate(input);
    if (errors.length) return;
    if (kind === "campaign") await actions.createCampaign({ title, anchorDate: when(), link: link || undefined });
    else await actions.createPost({ title, platform, channels: selected, scheduledAt: when(), campaignPath: campaignPath || undefined });
    close();
  }
</script>

<form class="osmm-form" onsubmit={submit}>
  <label>Title<input type="text" bind:value={title} /></label>
  {#if kind === "post"}
    <label>
      Platform
      <select bind:value={platform} onchange={() => (selected = [])}>
        {#each PLATFORMS as p (p)}<option value={p}>{PLATFORM_META[p].label}</option>{/each}
      </select>
    </label>
    <fieldset>
      <legend>Channels</legend>
      {#each platformChannels as c (c.id)}
        <label class="osmm-row"><input type="checkbox" value={c.id} bind:group={selected} />{c.name}</label>
      {:else}
        <p class="osmm-progress">No {PLATFORM_META[platform].label} channels yet. Add one in settings.</p>
      {/each}
    </fieldset>
    <label>
      Campaign
      <select bind:value={campaignPath}>
        <option value="">Standalone post</option>
        {#each $snapshot.campaigns as c (c.path)}<option value={c.path}>{c.title}</option>{/each}
      </select>
    </label>
  {/if}
  <label>{kind === "campaign" ? "Anchor date" : "Date"}<input type="date" bind:value={date} /></label>
  <label>Time<input type="time" bind:value={time} /></label>
  {#if kind === "campaign"}<label>Link<input type="url" bind:value={link} placeholder="https://" /></label>{/if}
  {#if errors.length}
    <ul class="osmm-issues" role="alert">{#each errors as e (e)}<li>{e}</li>{/each}</ul>
  {/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">{kind === "campaign" ? "Create campaign" : "Create post"}</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
```

- [ ] **Step 4: Add the actions**

Add to `src/ui/actions.ts` (import `QuickCreate` from `../views/QuickCreate.svelte`):
```ts
  async createCampaign(input: { title: string; anchorDate?: number; link?: string }): Promise<void> {
    const file = await this.deps.factory.createCampaign(input);
    this.openNote(file.path);
  }

  async createPost(input: { title: string; platform: Platform; channels: string[]; scheduledAt?: number; campaignPath?: string }): Promise<void> {
    const campaign = input.campaignPath ? (this.deps.app.vault.getFileByPath(input.campaignPath) ?? undefined) : undefined;
    const file = await this.deps.factory.createVariant({
      platform: input.platform,
      campaign,
      title: input.title,
      channels: input.channels,
      scheduledAt: input.scheduledAt,
    });
    this.openNote(file.path);
  }

  quickCreate(kind: "campaign" | "post"): void {
    if (!this.context) return;
    new SvelteModal(this.deps.app, kind === "campaign" ? "New campaign" : "New post", QuickCreate, { kind }, this.context).open();
  }

  /** Command check callback: available when the active note is an indexed campaign. */
  newVariantForActiveCampaign(checking: boolean): boolean {
    const file = this.deps.app.workspace.getActiveFile();
    const campaign = file ? this.deps.index.getCampaign(file.path) : undefined;
    if (!campaign) return false;
    if (!checking) {
      const menu = new Menu();
      const present = new Set(this.deps.index.variantsOf(campaign.path).map((v) => v.platform));
      for (const p of PLATFORMS.filter((x) => !present.has(x))) {
        menu.addItem((i) => i.setTitle(PLATFORM_META[p].label).onClick(() => void this.createVariantForCampaign(campaign.path, p)));
      }
      menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
    }
    return true;
  }
```
Import `PLATFORMS` alongside `PLATFORM_META`.

- [ ] **Step 5: Register commands**

`src/commands.ts`:
```ts
import type OsmmPlugin from "./main";
import { VIEW_PLANNER, VIEW_SIDEBAR } from "./ui/actions";
import { activateView } from "./views/PlannerView";

export function registerCommands(plugin: OsmmPlugin): void {
  const { app } = plugin;
  const openPlanner = () => void activateView(app, VIEW_PLANNER, "tab");

  plugin.addRibbonIcon("calendar-days", "Open social planner", openPlanner);
  plugin.addCommand({ id: "open-planner", name: "Open planner", callback: openPlanner });
  plugin.addCommand({
    id: "open-board",
    name: "Open pipeline board",
    callback: () => {
      plugin.uiContext().viewState.update((s) => ({ ...s, mode: "board" }));
      openPlanner();
    },
  });
  plugin.addCommand({ id: "open-sidebar", name: "Open social queue (sidebar)", callback: () => void activateView(app, VIEW_SIDEBAR, "right") });
  plugin.addCommand({ id: "new-campaign", name: "New campaign", callback: () => plugin.uiContext().actions.quickCreate("campaign") });
  plugin.addCommand({ id: "new-post", name: "New post", callback: () => plugin.uiContext().actions.quickCreate("post") });
  plugin.addCommand({
    id: "new-variant-for-campaign",
    name: "New platform variant for this campaign",
    checkCallback: (checking) => plugin.uiContext().actions.newVariantForActiveCampaign(checking),
  });
}
```
In `src/main.ts`, remove the ribbon/`open-planner`/`open-sidebar` registrations added in Tasks 4 and 9, and call `registerCommands(this);` after the `registerView` calls.

In `src/views/Sidebar.svelte`, add at the top of `.osmm-sidebar`:
```svelte
  <button type="button" class="mod-cta" onclick={() => actions.quickCreate("campaign")}>New campaign</button>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add commands, ribbon and quick-create modals (refs #38)"
```

---

### Task 13: Channels settings UI (#25)

**Files:**
- Create: `src/settings/ChannelsSection.svelte`, `src/settings/ChannelForm.svelte`, `src/settings/GroupForm.svelte`, `src/ui/secretField.ts`, `test/settings/channelForm.test.ts`
- Modify: `src/settings/tab.ts` (mount the section), `test/fakes/obsidian.ts` (`SecretComponent`), `test/main.test.ts`

**Interfaces:**
- Consumes: `ChannelRegistry.upsertChannel/removeChannel/upsertGroup/removeGroup/suggestId/usage`, `SecretIds.channel`.
- Produces: `<ChannelsSection>` (grouped channel list with Edit / Remove / Add channel, and a groups list with Add group / Edit / Remove); `<ChannelForm channel? close>`; `<GroupForm group? close>`; the Svelte action `secretField(node, { app, value, onchange })`, which wraps Obsidian's `SecretComponent`.

- [ ] **Step 1: Add the fake `SecretComponent`**

```ts
export class SecretComponent {
  static last: SecretComponent | null = null;
  value = "";
  private cb: ((v: string) => unknown) | undefined;
  constructor(
    public app: App,
    public containerEl: HTMLElement,
  ) {
    SecretComponent.last = this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown): this {
    this.cb = cb;
    return this;
  }
  async change(v: string): Promise<void> {
    this.value = v;
    await this.cb?.(v);
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/settings/channelForm.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { SecretComponent } from "../fakes/obsidian";
import ChannelForm from "../../src/settings/ChannelForm.svelte";
import ChannelsSection from "../../src/settings/ChannelsSection.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("ChannelForm", () => {
  it("suggests an id from the name and saves a valid channel with its secret id", async () => {
    const { ctx } = await makeCtx();
    const close = vi.fn();
    render(ChannelForm, { props: { close }, context: osmmContext(ctx) });
    await fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "telegram" } });
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Launch Updates" } });
    expect((screen.getByLabelText("Channel id") as HTMLInputElement).value).toBe("tg/launch-updates");
    await SecretComponent.last!.change("osmm-channel-tg-launch-updates");
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("tg/launch-updates")).toMatchObject({ platform: "telegram", name: "Launch Updates", secretId: "osmm-channel-tg-launch-updates" });
    expect(close).toHaveBeenCalled();
  });

  it("shows validation issues", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("Name is required");
  });
});

describe("ChannelsSection", () => {
  it("lists channels grouped by platform and removes after confirmation, warning about usage", async () => {
    const { ctx } = await makeCtx({ seed: true });
    let asked = "";
    ctx.actions.confirm = async (message) => {
      asked = message;
      return true;
    };
    render(ChannelsSection, { context: osmmContext(ctx) });
    expect(screen.getByRole("heading", { name: "LinkedIn" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Remove Acme Studio" }));
    expect(asked).toMatch(/used by 1 note/);
    expect(ctx.channels.get("li/acme-studio")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/settings/channelForm.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the secret action and the forms**

`src/ui/secretField.ts`:
```ts
import { SecretComponent, type App } from "obsidian";

/** Svelte action wrapping Obsidian's SecretComponent (the user picks or creates a secret; we store only its id). */
export function secretField(node: HTMLElement, opts: { app: App; value: string; onchange: (id: string) => void }) {
  const component = new SecretComponent(opts.app, node).setValue(opts.value).onChange((id) => opts.onchange(id));
  return {
    update(next: { app: App; value: string; onchange: (id: string) => void }) {
      component.setValue(next.value);
      opts = next;
    },
  };
}
```

`src/settings/ChannelForm.svelte`:
```svelte
<script lang="ts">
  import { PLATFORMS, PLATFORM_META, type Platform } from "../model/platforms";
  import { CHANNEL_KINDS, PUBLISH_METHODS } from "../model/schemas";
  import type { Channel, Issue } from "../model/types";
  import { useOsmm } from "../ui/context";
  import { secretField } from "../ui/secretField";
  import { PLATFORM_COLORS } from "../ui/colors";

  let { channel, close }: { channel?: Channel; close: () => void } = $props();
  const { app, channels } = useOsmm();
  const editing = !!channel;

  let platform = $state<Platform>(channel?.platform ?? "linkedin");
  let name = $state(channel?.name ?? "");
  let id = $state(channel?.id ?? "");
  let idTouched = $state(editing);
  let kind = $state(channel?.kind ?? "profile");
  let handle = $state(channel?.handle ?? "");
  let method = $state(channel?.method ?? "assisted");
  let avatarColor = $state(channel?.avatarColor ?? PLATFORM_COLORS.linkedin);
  let defaultTime = $state(channel?.defaultTime ?? "");
  let secretId = $state(channel?.secretId ?? "");
  let issues = $state<Issue[]>([]);

  $effect(() => {
    if (!idTouched) id = name.trim() ? channels.suggestId(platform, name) : "";
  });

  const KIND_LABEL: Record<string, string> = { profile: "Profile", page: "Page", group: "Group", server_channel: "Server channel", site: "Website", account: "Account" };
  const METHOD_LABEL: Record<string, string> = { api: "API (auto-post)", native: "API with native scheduling", assisted: "Assisted (remind + open)" };

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await channels.upsertChannel({
      id,
      platform,
      name,
      kind,
      handle: handle || undefined,
      method,
      avatarColor,
      defaultTime: defaultTime || undefined,
      secretId: secretId || undefined,
      defaultReminders: channel?.defaultReminders,
    });
    if (!result.ok) {
      issues = result.issues;
      return;
    }
    if (editing && channel && channel.id !== id) await channels.removeChannel(channel.id);
    close();
  }
</script>

<form class="osmm-form" onsubmit={save}>
  <label>
    Platform
    <select bind:value={platform} disabled={editing} onchange={() => (avatarColor = PLATFORM_COLORS[platform])}>
      {#each PLATFORMS as p (p)}<option value={p}>{PLATFORM_META[p].label}</option>{/each}
    </select>
  </label>
  <label>Name<input type="text" bind:value={name} /></label>
  <label>Channel id<input type="text" bind:value={id} oninput={() => (idTouched = true)} /></label>
  <label>
    Kind
    <select bind:value={kind}>{#each CHANNEL_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}</select>
  </label>
  <label>Handle / URL<input type="text" bind:value={handle} /></label>
  <label>
    Publishing
    <select bind:value={method}>{#each PUBLISH_METHODS as m (m)}<option value={m}>{METHOD_LABEL[m]}</option>{/each}</select>
  </label>
  <label>Colour<input type="color" bind:value={avatarColor} /></label>
  <label>Default time<input type="time" bind:value={defaultTime} /></label>
  <div>
    <span>Credential (stored only on this device)</span>
    <div use:secretField={{ app, value: secretId, onchange: (v) => (secretId = v) }}></div>
  </div>
  {#if issues.length}
    <ul class="osmm-issues" role="alert">{#each issues as i (i.field + i.message)}<li>{i.field}: {i.message}</li>{/each}</ul>
  {/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">Save channel</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
```

`src/settings/GroupForm.svelte`:
```svelte
<script lang="ts">
  import { PLATFORM_META } from "../model/platforms";
  import type { ChannelGroup, Issue } from "../model/types";
  import { useOsmm } from "../ui/context";

  let { group, close }: { group?: ChannelGroup; close: () => void } = $props();
  const { channels } = useOsmm();
  let name = $state(group?.name ?? "");
  let selected = $state<string[]>(group ? [...group.channelIds] : []);
  let issues = $state<Issue[]>([]);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await channels.upsertGroup({ id: group?.id ?? slug(name), name, channelIds: selected });
    if (!result.ok) issues = result.issues;
    else close();
  }
</script>

<form class="osmm-form" onsubmit={save}>
  <label>Group name<input type="text" bind:value={name} /></label>
  <fieldset>
    <legend>Channels</legend>
    {#each channels.list() as c (c.id)}
      <label class="osmm-row"><input type="checkbox" value={c.id} bind:group={selected} />{PLATFORM_META[c.platform].label} · {c.name}</label>
    {/each}
  </fieldset>
  {#if issues.length}<ul class="osmm-issues" role="alert">{#each issues as i (i.message)}<li>{i.message}</li>{/each}</ul>{/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">Save group</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
```

`src/settings/ChannelsSection.svelte`:
```svelte
<script lang="ts">
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import type { Channel, ChannelGroup } from "../model/types";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import { useOsmm } from "../ui/context";
  import ChannelForm from "./ChannelForm.svelte";
  import GroupForm from "./GroupForm.svelte";
  import { SvelteModal } from "../ui/dialogs";

  const ctx = useOsmm();
  const { app, settings, snapshot, channels, actions } = ctx;
  const METHOD_LABEL: Record<string, string> = { api: "API · auto", native: "API · native schedule", assisted: "Assisted" };

  const grouped = $derived(
    PLATFORMS.map((p) => ({ p, list: $settings.channels.filter((c) => c.platform === p) })).filter((g) => g.list.length),
  );

  function editChannel(channel?: Channel): void {
    new SvelteModal(app, channel ? `Edit ${channel.name}` : "Add channel", ChannelForm, { channel }, ctx).open();
  }
  function editGroup(group?: ChannelGroup): void {
    new SvelteModal(app, group ? `Edit ${group.name}` : "Add channel group", GroupForm, { group }, ctx).open();
  }
  async function removeChannel(c: Channel): Promise<void> {
    const used = channels.usage(c.id, $snapshot.variants).length;
    const ok = await actions.confirm(`Remove ${c.name}? It is used by ${used} note${used === 1 ? "" : "s"}; those notes keep the id and will show a warning.`, "Remove");
    if (ok) await channels.removeChannel(c.id);
  }
  async function removeGroup(g: ChannelGroup): Promise<void> {
    if (await actions.confirm(`Remove the group ${g.name}? Channels are kept.`, "Remove")) await channels.removeGroup(g.id);
  }
</script>

<div class="osmm-channels">
  <div class="osmm-row">
    <p class="osmm-progress">A channel is one place you publish: your profile, a page, a group, a server channel or a website.</p>
    <span class="osmm-spacer"></span>
    <button type="button" class="mod-cta" onclick={() => editChannel()}>Add channel</button>
  </div>
  {#each grouped as { p, list } (p)}
    <h4>{PLATFORM_META[p].label}</h4>
    {#each list as c (c.id)}
      <div class="osmm-row setting-item">
        <ChannelAvatar channel={c} />
        <span class="osmm-row-title">{c.name} <span class="osmm-progress">{c.id}</span></span>
        <span class="osmm-pill-status">{METHOD_LABEL[c.method]}</span>
        <span class="osmm-progress">{c.secretId ? "credential set" : "no credential"}</span>
        <button type="button" onclick={() => editChannel(c)}>Edit</button>
        <button type="button" aria-label={`Remove ${c.name}`} onclick={() => void removeChannel(c)}>Remove</button>
      </div>
    {/each}
  {:else}
    <p>No channels yet.</p>
  {/each}

  <div class="osmm-row">
    <h4>Channel groups</h4>
    <span class="osmm-spacer"></span>
    <button type="button" onclick={() => editGroup()}>Add group</button>
  </div>
  {#each $settings.channelGroups as g (g.id)}
    <div class="osmm-row setting-item">
      <span class="osmm-row-title">{g.name} <span class="osmm-progress">{g.channelIds.length} channels</span></span>
      <button type="button" onclick={() => editGroup(g)}>Edit</button>
      <button type="button" aria-label={`Remove group ${g.name}`} onclick={() => void removeGroup(g)}>Remove</button>
    </div>
  {/each}
</div>
```

- [ ] **Step 5: Mount the section in the settings tab**

In `src/settings/tab.ts` (imports `mountSvelte`, `type Mounted`, `osmmContext`, `ChannelsSection`), add the field `private channelsUi: Mounted | null = null;`. In `display()`, between General and Schedule templates:
```ts
    new Setting(containerEl).setName("Channels").setHeading();
    const host = document.createElement("div");
    host.className = "osmm";
    containerEl.appendChild(host);
    this.channelsUi?.destroy();
    this.channelsUi = mountSvelte(host, ChannelsSection, {}, osmmContext(this.osmm.uiContext()));
```
Add:
```ts
  override hide(): void {
    this.channelsUi?.destroy();
    this.channelsUi = null;
  }
```
Update the expected setting names in `test/main.test.ts` to `["General", "Root folder", "Week starts on", "Default reminders", "Default stagger", "Channels", "Schedule templates", "Launch"]`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(settings): add channels and channel-group management UI (refs #25)"
```

---

### Task 14: M1 acceptance pass

**Files:**
- Create: `docs/qa/m1.md`

**Interfaces:**
- Produces: a manual QA checklist, run once in Obsidian, with results recorded in the PR description.

- [ ] **Step 1: Write the checklist**

`docs/qa/m1.md`:
```markdown
# M1 manual QA

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+, enable the plugin.
Run every check in the **default dark and light themes** and one community theme (e.g. Minimal).

## Planner (mockup 1, 4)
- [ ] Ribbon icon opens the planner; month shows chips with correct status styles and legend.
- [ ] Today is highlighted; Event X anchor marker shows on its day.
- [ ] Hover a chip with Mod held shows the note preview; click opens the note; Mod+click opens a new tab.
- [ ] Week view: items at the right times, overlapping items side by side, red now-line today.
- [ ] Drag a chip to another day (month) and to a slot (week); Undo in the notice restores it.
- [ ] Dragging a handed-over WordPress item asks for confirmation; a published item is refused with a notice.
- [ ] Board: columns and counts; drag Ready → Scheduled asks for a date; Published → Draft is refused.
- [ ] List: sort each column; select rows; Shift +1 day; Set status; Move to trash (with confirmation).
- [ ] Filters persist after closing and reopening Obsidian; "Clear filters" resets.
- [ ] Keyboard: Tab reaches every control; focus ring visible on chips and buttons.

## Sidebar
- [ ] "Open social queue" shows Overdue (Instagram, HN), Up next today, campaign progress.
- [ ] Reschedule → "In 1 hour" moves the post; Skip marks the delivery skipped.

## Campaign note (mockup 2)
- [ ] `social-variants` renders in Reading view and Live Preview; counts correct.
- [ ] "Create variant" for a missing platform creates the note with all that platform's channels and opens it.
- [ ] "Apply schedule template" → Launch shows a preview; Apply changes times; Undo restores them.
- [ ] Timeline shows T-labels and ✓ for fully published days.

## Commands
- [ ] New campaign / New post modals validate and create notes.
- [ ] "New platform variant for this campaign" appears only when a campaign note is active.

## Settings (mockup 8)
- [ ] General settings persist; Channels: add Telegram channel with a secret, edit it, remove it (usage warning).
- [ ] Groups: create "All LinkedIn pages"; it appears in the planner Channel filter.
- [ ] `data.json` contains secret **ids** only, no secret values.

## Performance
- [ ] `npm run seed -- --large`: planner opens in < 1 s, scrolling months stays smooth.
```

- [ ] **Step 2: Run the full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 3: Walk through the checklist and fix what fails**

Work through `docs/qa/m1.md` in Obsidian. For each failure, add a failing test in the owning module first, fix the problem, and commit with `fix(...)`.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -m "docs(qa): add M1 manual QA checklist"
gh pr create --title "M1b: planning UI" --body "Implements the M1b plan. Refs #8 #25 #29 #30 #31 #32 #33 #34 #35 #36 #37 #38. QA checklist: docs/qa/m1.md (results below)."
```

---

## M1b Done Checklist

- [ ] All 14 tasks committed on `feat/m1b-planning-ui`; the automated suite passes.
- [ ] Every item in `docs/qa/m1.md` checked in light and dark themes.
- [ ] PR opened, referencing #8 #25 #29–#38. When M1a and M1b are merged, epics E0–E4 (#1 #10 #17 #21 #28) can be closed, except #26 and #27 (M3).
