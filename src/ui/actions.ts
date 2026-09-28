import { Menu, Notice, type App, type TFile } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import { expandRows, type PostRow } from "../index/queries";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { addLocalDays, DAY, HOUR } from "../model/dates";
import type { NoteFactory } from "../model/factory";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { SafeWriter } from "../model/writer";
import { defaultScheduleTime, planBoardMove, scheduleDeliveries, unscheduleDeliveries, type BoardColumn } from "../planner/board";
import { uniqueVariants } from "../planner/list";
import { planReschedule, type RescheduleTarget } from "../planner/reschedule";
import { STATUS_LABEL } from "../planner/status";
import type { OsmmSettings } from "../settings/settings";
import { confirmDialog, pickDateTime } from "./dialogs";
import { formatShortDate, formatTime } from "./format";

export const VIEW_PLANNER = "osmm-planner";
export const VIEW_SIDEBAR = "osmm-sidebar";
export const ROW_MIME = "text/x-osmm-row";

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

  async reschedule(row: PostRow, target: RescheduleTarget): Promise<boolean> {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const plan = planReschedule(row, target, channel?.defaultTime ?? "09:00", this.deps.settings().defaultStaggerMinutes);
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
    const previous = {
      status: v.status,
      deliveries: Object.fromEntries(Object.entries(v.deliveries).map(([id, d]) => [id, { ...d }])),
    };
    const target = status === "idea" ? "draft" : status;
    const deliveries: typeof v.deliveries = {};
    for (const [id, d] of Object.entries(v.deliveries)) {
      deliveries[id] = d.status === "draft" || d.status === "ready" ? { ...d, status: target } : d;
    }
    await this.deps.writer.patchVariant(v.file, { status, deliveries });
    this.undoNotice(`Moved to ${STATUS_LABEL[status]}.`, () => this.deps.writer.patchVariant(v.file, previous));
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

  async bulkShift(rows: PostRow[], deltaMs: number): Promise<{ moved: number; skipped: number }> {
    let moved = 0;
    let skipped = 0;
    const changed: Array<[TFile, { scheduledAt?: number; deliveries: IndexedVariant["deliveries"] }]> = [];
    for (const v of uniqueVariants(rows)) {
      const movable = v.scheduledAt !== undefined && !Object.values(v.deliveries).some((d) => ["published", "publishing", "handed_over"].includes(d.status));
      if (!movable) {
        skipped++;
        continue;
      }
      const previous = { scheduledAt: v.scheduledAt, deliveries: Object.fromEntries(Object.entries(v.deliveries).map(([id, d]) => [id, { ...d }])) };
      const deliveries = Object.fromEntries(Object.entries(v.deliveries).map(([id, d]) => [id, d.at === undefined ? d : { ...d, at: d.at + deltaMs }]));
      await this.deps.writer.patchVariant(v.file, { scheduledAt: v.scheduledAt! + deltaMs, deliveries });
      changed.push([v.file, previous]);
      moved++;
    }
    const summary = `Moved ${moved} post${moved === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} (published, handed over or unscheduled)` : ""}.`;
    if (changed.length) {
      this.undoNotice(summary, async () => {
        for (const [file, previous] of changed) await this.deps.writer.patchVariant(file, previous);
      });
    } else {
      new Notice(summary);
    }
    return { moved, skipped };
  }

  async bulkSetStatus(rows: PostRow[], status: "idea" | "draft" | "ready"): Promise<{ changed: number; skipped: number }> {
    let changedCount = 0;
    let skipped = 0;
    const target = status === "ready" ? "ready" : "draft";
    const changed: Array<[TFile, { status: IndexedVariant["status"]; deliveries: IndexedVariant["deliveries"] }]> = [];
    for (const v of uniqueVariants(rows)) {
      const ds = Object.entries(v.deliveries);
      if (ds.some(([, d]) => d.status !== "draft" && d.status !== "ready")) {
        skipped++;
        continue;
      }
      const previous = { status: v.status, deliveries: Object.fromEntries(ds.map(([id, d]) => [id, { ...d }])) };
      const deliveries: typeof v.deliveries = {};
      for (const [id, d] of ds) deliveries[id] = d.status === target ? d : { ...d, status: target };
      await this.deps.writer.patchVariant(v.file, { status, deliveries });
      changed.push([v.file, previous]);
      changedCount++;
    }
    const summary = `Changed ${changedCount} post${changedCount === 1 ? "" : "s"}, skipped ${skipped} with channels already scheduled, in progress or done.`;
    const summaryNoSkip = `Changed ${changedCount} post${changedCount === 1 ? "" : "s"}.`;
    const notice = skipped ? summary : summaryNoSkip;
    if (changed.length) {
      this.undoNotice(notice, async () => {
        for (const [file, previous] of changed) await this.deps.writer.patchVariant(file, previous);
      });
    } else {
      new Notice(notice);
    }
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
