import { Menu, Notice, type App, type TFile } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import { expandRows, type PostRow, type RowStatus } from "../index/queries";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { addLocalDays, DAY, HOUR } from "../model/dates";
import type { NoteFactory } from "../model/factory";
import { PLATFORM_META, PLATFORMS, type Platform } from "../model/platforms";
import type { Variant } from "../model/types";
import type { SafeWriter, VariantPlan } from "../model/writer";
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
import { deliveryChanges, planUndo, recordWrite, type WriteRecord } from "../planner/changes";
import { frozenForMove, statusEditable, uniqueVariants } from "../planner/list";
import { planReschedule, type RescheduleTarget } from "../planner/reschedule";
import { STATUS_LABEL } from "../planner/status";
import { planTemplate, planTemplateMove, templateMovable, type TemplateProposal } from "../planner/templates";
import type { OsmmSettings } from "../settings/settings";
import type { OsmmContext } from "./context";
import { confirmDialog, pickDateTime, SvelteModal } from "./dialogs";
import { formatShortDate, formatTime } from "./format";
import TemplatePreview from "../views/TemplatePreview.svelte";
import QuickCreate from "../views/QuickCreate.svelte";

export const VIEW_PLANNER = "osmm-planner";
export const VIEW_SIDEBAR = "osmm-sidebar";
export const VIEW_COMPOSER = "osmm-composer";
export const VIEW_PREVIEW_GRID = "osmm-preview-grid";
export const ROW_MIME = "text/x-osmm-row";
export const UNDO_CONFLICT = "Some changes were kept because the note changed since.";

/** Ruling P2: bulk shift and template apply ask once before moving deliveries that are awaiting the user. */
export const AWAITING_MOVE = "Some of these posts have channels awaiting you to post manually. Moving them won't change what you already agreed to post. Move them anyway?";

/** A listed channel is awaiting the user (ruling P2: sticky, moving it needs confirmation). */
function awaitingYou(v: Pick<Variant, "channels" | "deliveries">): boolean {
  return v.channels.some((id) => v.deliveries[id]?.status === "awaiting_you");
}

export type WriteResult = { ok: true; record: WriteRecord } | { ok: false; reason: string };

const COLUMN_TITLE: Readonly<Record<BoardColumn, string>> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", published: "Published" };
/** Rows that can still be posted, rescheduled or skipped from a menu. */
const POSTABLE = new Set<RowStatus>(["draft", "ready", "scheduled", "overdue", "failed", "awaiting_you"]);
const NOT_MOVABLE = new Set<RowStatus>(["published", "publishing", "skipped"]);

/** The snapshot variant with the fresh frontmatter values laid over it (keeps file, campaignPath, …). */
function freshIndexed(v: IndexedVariant, fresh: Variant): IndexedVariant {
  return { ...v, ...fresh };
}

/** Anchors a menu under an element's rect (keyboard activation, or a click with no mouse movement, opens under the button, not at 0,0). */
function rectAnchor(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

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
  private rowsCache: { revision: number; stagger: number; rows: PostRow[] } | undefined;

  /** Set by the plugin so actions can open Svelte modals with the same context. */
  context: OsmmContext | null = null;

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

  /**
   * Cached per index revision and stagger setting so a row object handed to the UI (e.g. from a
   * list render) stays `===` across repeated calls until the index or the stagger default
   * actually changes.
   */
  rows(): PostRow[] {
    const revision = this.deps.index.revision;
    const stagger = this.deps.settings().defaultStaggerMinutes;
    if (!this.rowsCache || this.rowsCache.revision !== revision || this.rowsCache.stagger !== stagger) {
      this.rowsCache = { revision, stagger, rows: expandRows(this.deps.index.variants(), stagger) };
    }
    return this.rowsCache.rows;
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

  /** Overridable in tests. */
  pickTime(title: string, initial: number): Promise<number | null> {
    return pickDateTime(this.deps.app, title, initial);
  }

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

  async reschedule(row: PostRow, target: RescheduleTarget): Promise<boolean> {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const plan = planReschedule(row, target, channel?.defaultTime ?? "09:00", this.deps.settings().defaultStaggerMinutes);
    if (!plan.ok) {
      new Notice(plan.reason);
      return false;
    }
    if (plan.needsConfirm) {
      const message = plan.awaitingYou
        ? "Some channels are awaiting you to post manually. Moving it here won't change what you already agreed to post. Move anyway?"
        : "This post was already handed over to the platform. Moving it here won't change it on the platform until you push an update. Move anyway?";
      const go = await this.confirm(message, "Move");
      if (!go) return false;
    }
    if (plan.newAt < this.deps.now()) {
      const go = await this.confirm("That time is in the past, so the post will show as overdue until you post or move it. Move it anyway?", "Move");
      if (!go) return false;
    }
    const stagger = this.deps.settings().defaultStaggerMinutes;
    let newAt = plan.newAt;
    const result = await this.write(row.variant.file, (fresh) => {
      const freshRow = expandRows([freshIndexed(row.variant, fresh)], stagger).find((r) => r.channelId === row.channelId);
      if (!freshRow) return { refuse: "This post changed since. Try again." };
      const again = planReschedule(freshRow, target, channel?.defaultTime ?? "09:00", stagger);
      if (!again.ok) return { refuse: again.reason };
      if (again.needsConfirm && !plan.needsConfirm) return { refuse: "This post was handed over in the meantime. Try again." };
      newAt = again.newAt;
      return { fields: { scheduledAt: again.patch.scheduledAt }, deliveries: deliveryChanges(fresh, again.patch.deliveries ?? {}) };
    });
    if (!result.ok) {
      new Notice(result.reason);
      return false;
    }
    this.undoNotice(`Moved to ${formatShortDate(newAt)} ${formatTime(newAt)}.`, () => this.undo([result.record]));
    return true;
  }

  /**
   * Every UI write: `plan` runs against fresh frontmatter inside the writer queue and returns only
   * what it changes. The stored status is always part of the record so undo can restore it.
   */
  async write(file: TFile, plan: VariantPlan): Promise<WriteResult> {
    let before: Variant | undefined;
    const applied = await this.deps.writer.updateVariant(file, (fresh) => {
      before = fresh;
      const planned = plan(fresh);
      if ("refuse" in planned) return planned;
      return { ...planned, fields: { status: fresh.status, ...planned.fields } };
    });
    if ("refuse" in applied) return { ok: false, reason: applied.refuse };
    return { ok: true, record: recordWrite(file, before!, applied) };
  }

  /** Reverts recorded writes where the note still holds what they wrote; reports the rest as conflicts. */
  async undo(records: readonly WriteRecord[]): Promise<void> {
    let conflicts = 0;
    for (const record of records) {
      await this.deps.writer.updateVariant(record.file, (fresh) => {
        const { update, conflicts: n } = planUndo(record, fresh);
        conflicts += n;
        return update;
      });
    }
    if (conflicts > 0) new Notice(UNDO_CONFLICT);
  }

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
        const at = await this.pickTime("Reschedule", Math.max(base, now + DAY));
        if (at !== null) await this.reschedule(row, { at });
      }),
    );
    menu.showAtMouseEvent(event);
  }

  /**
   * The menu of a board card: one card stands for every channel of the post, so Post now and Skip act on
   * all of its postable channels (final review Minor 11), not only on the first row.
   */
  cardMenu(v: IndexedVariant, at: MouseEvent | { x: number; y: number }): Menu | undefined {
    const rows = this.rows().filter((r) => r.variant.path === v.path);
    return rows[0] ? this.rowMenu(rows[0], at, rows) : undefined;
  }

  /** The Menu key or Shift+F10 on a board card. */
  cardKeyMenu(event: KeyboardEvent, v: IndexedVariant): void {
    const rows = this.rows().filter((r) => r.variant.path === v.path);
    if (rows[0]) this.keyMenu(event, rows[0], rows);
  }

  /**
   * The menu equivalent of every drag-and-drop action (#113), with the same guards, notices and undo.
   * `group` is every row the menu stands for (a board card: all channels of the post); Post now and Skip act on its postable ones.
   */
  rowMenu(row: PostRow, at: MouseEvent | { x: number; y: number }, group: readonly PostRow[] = [row]): Menu {
    const v = row.variant;
    const menu = new Menu();
    const postable = group.filter((r) => r.channelId !== null && POSTABLE.has(r.status));
    const postableIds = postable.map((r) => r.channelId!);
    menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => this.openNote(v.path)));
    menu.addItem((i) => i.setTitle("Compose").setIcon("pencil-line").onClick(() => void this.context?.composer.openComposer(v.path)));
    if (postable.length) {
      menu.addItem((i) => i.setTitle("Post now").setIcon("send").onClick(() => void this.context?.publish.postNow(v.path, postableIds)));
    }
    const current = columnOf(v.status);
    const movable = BOARD_COLUMNS.filter((col) => col !== current && planBoardMove(v, col).ok);
    const canReschedule = !NOT_MOVABLE.has(row.status);
    const canSkip = postable.length > 0;
    if (canReschedule || movable.length || canSkip) menu.addSeparator();
    if (canReschedule) {
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
    for (const col of movable) {
      menu.addItem((i) => i.setTitle(`Move to ${COLUMN_TITLE[col]}`).onClick(() => void this.moveOnBoard(v, col)));
    }
    if (canSkip) {
      menu.addItem((i) =>
        i
          .setTitle("Skip")
          .setIcon("skip-forward")
          .onClick(async () => {
            for (const r of postable) await this.skip(r);
          }),
      );
    }
    if (at instanceof MouseEvent) {
      // A keyboard-triggered click (Enter/Space) fires a MouseEvent with detail 0; anchor to the
      // button's rect instead of showing the menu at (0,0).
      if (at.detail === 0 && at.currentTarget instanceof HTMLElement) menu.showAtPosition(rectAnchor(at.currentTarget));
      else menu.showAtMouseEvent(at);
    } else {
      menu.showAtPosition(at);
    }
    return menu;
  }

  /** The Menu key or Shift+F10 opens the row menu under the focused element. */
  keyMenu(event: KeyboardEvent, row: PostRow, group: readonly PostRow[] = [row]): void {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    this.rowMenu(row, rectAnchor(event.currentTarget as HTMLElement), group);
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

  async setStatus(v: IndexedVariant, status: "idea" | "draft" | "ready"): Promise<void> {
    const target = status === "idea" ? "draft" : status;
    const result = await this.write(v.file, (fresh) => {
      const deliveries: Variant["deliveries"] = {};
      for (const [id, d] of Object.entries(fresh.deliveries)) {
        if (d.status === "draft" || d.status === "ready") deliveries[id] = { ...d, status: target };
      }
      return { fields: { status }, deliveries: deliveryChanges(fresh, deliveries) };
    });
    this.afterWrite(result, `Moved to ${STATUS_LABEL[status]}.`);
  }

  async schedule(v: IndexedVariant, at: number): Promise<void> {
    const result = await this.write(v.file, (fresh) => {
      if (!fresh.channels.length) return { refuse: "Pick at least one channel before scheduling." };
      return { fields: { scheduledAt: at }, deliveries: deliveryChanges(fresh, scheduleDeliveries(fresh)) };
    });
    this.afterWrite(result, `Scheduled for ${formatShortDate(at)} ${formatTime(at)}.`);
  }

  async unschedule(v: IndexedVariant, status: "idea" | "draft" | "ready"): Promise<void> {
    const result = await this.write(v.file, (fresh) => {
      if (unscheduleBlocked(fresh)) return { refuse: UNSCHEDULE_BLOCKED };
      return { fields: { status }, deliveries: deliveryChanges(fresh, unscheduleDeliveries(fresh, status === "ready" ? "ready" : "draft")) };
    });
    this.afterWrite(result, "Unscheduled.");
  }

  afterWrite(result: WriteResult, message: string): void {
    if (result.ok) this.undoNotice(message, () => this.undo([result.record]));
    else new Notice(result.reason);
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
    const at = await this.pickTime("Schedule post", defaultScheduleTime(this.deps.now(), v, channel?.defaultTime));
    if (at !== null) await this.schedule(v, at);
  }

  /**
   * Ruling P2, the reschedule() pattern for multi-post moves: ask once when a post has a channel awaiting the
   * user. Declined, those posts are left unchanged (counted as skipped); the write plans re-check on fresh
   * frontmatter so a delivery that became awaiting_you meanwhile is not moved unconfirmed.
   */
  private async confirmAwaiting(movable: readonly IndexedVariant[]): Promise<boolean> {
    return !movable.some(awaitingYou) || this.confirm(AWAITING_MOVE, "Move");
  }

  async bulkShift(rows: PostRow[], deltaMs: number): Promise<{ moved: number; skipped: number }> {
    const stagger = this.deps.settings().defaultStaggerMinutes;
    let skipped = 0;
    const records: WriteRecord[] = [];
    const variants = uniqueVariants(rows);
    const moveAwaiting = await this.confirmAwaiting(variants.filter((v) => v.scheduledAt !== undefined && !frozenForMove(v, stagger)));
    for (const v of variants) {
      const result = await this.write(v.file, (fresh) => {
        if (fresh.scheduledAt === undefined || frozenForMove(freshIndexed(v, fresh), stagger)) return { refuse: "frozen" };
        if (!moveAwaiting && awaitingYou(fresh)) return { refuse: "awaiting you" };
        const deliveries: Variant["deliveries"] = {};
        for (const [id, d] of Object.entries(fresh.deliveries)) if (d.at !== undefined) deliveries[id] = { ...d, at: d.at + deltaMs };
        return { fields: { scheduledAt: fresh.scheduledAt! + deltaMs }, deliveries };
      });
      if (result.ok) records.push(result.record);
      else skipped++;
    }
    const moved = records.length;
    const summary = `Moved ${moved} post${moved === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} (published, handed over, skipped, unscheduled or awaiting you)` : ""}.`;
    if (records.length) this.undoNotice(summary, () => this.undo(records));
    else new Notice(summary);
    return { moved, skipped };
  }

  async bulkSetStatus(rows: PostRow[], status: "idea" | "draft" | "ready"): Promise<{ changed: number; skipped: number }> {
    const stagger = this.deps.settings().defaultStaggerMinutes;
    let skipped = 0;
    const target = status === "ready" ? "ready" : "draft";
    const records: WriteRecord[] = [];
    for (const v of uniqueVariants(rows)) {
      const result = await this.write(v.file, (fresh) => {
        if (!statusEditable(freshIndexed(v, fresh), stagger)) return { refuse: "frozen" };
        const ds = Object.entries(fresh.deliveries);
        const deliveries: Variant["deliveries"] = {};
        for (const [id, d] of ds) if (d.status !== target) deliveries[id] = { ...d, status: target };
        return { fields: { status }, deliveries };
      });
      if (result.ok) records.push(result.record);
      else skipped++;
    }
    const changedCount = records.length;
    const summary = `Changed ${changedCount} post${changedCount === 1 ? "" : "s"}, skipped ${skipped} with channels already scheduled, in progress or done.`;
    const summaryNoSkip = `Changed ${changedCount} post${changedCount === 1 ? "" : "s"}.`;
    const notice = skipped ? summary : summaryNoSkip;
    if (records.length) this.undoNotice(notice, () => this.undo(records));
    else new Notice(notice);
    return { changed: changedCount, skipped };
  }

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

  async applyTemplate(proposals: TemplateProposal[]): Promise<void> {
    const records: WriteRecord[] = [];
    let skipped = 0;
    const moveAwaiting = await this.confirmAwaiting(proposals.map((p) => p.variant).filter((v) => templateMovable(v)));
    for (const p of proposals) {
      const result = await this.write(p.variant.file, (fresh) => (!moveAwaiting && awaitingYou(fresh) ? { refuse: "awaiting you" } : planTemplateMove(fresh, p.to)));
      if (result.ok) records.push(result.record);
      else skipped++;
    }
    const n = records.length;
    const summary = `Scheduled ${n} post${n === 1 ? "" : "s"} from the template.${skipped ? ` Skipped ${skipped} already published, handed over, being published or awaiting you.` : ""}`;
    if (records.length) this.undoNotice(summary, () => this.undo(records));
    else new Notice(summary);
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
    new SvelteModal(this.deps.app, `Apply "${template.name}"`, TemplatePreview, { proposals }, this.context).open();
  }

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

  async bulkTrash(rows: PostRow[]): Promise<number> {
    const variants = uniqueVariants(rows);
    if (!variants.length) return 0;
    const ok = await this.confirm(`Move ${variants.length} note${variants.length === 1 ? "" : "s"} to the trash?`, "Move to trash");
    if (!ok) return 0;
    for (const v of variants) await this.deps.app.fileManager.trashFile(v.file);
    new Notice(`Moved ${variants.length} note${variants.length === 1 ? "" : "s"} to the trash.`);
    return variants.length;
  }
}
