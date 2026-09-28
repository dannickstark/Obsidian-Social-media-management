import { Notice, type App, type WorkspaceLeaf } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import type { Channel, ChannelGroup, Delivery, Issue, MediaMeta, PostMode, Variant } from "../model/types";
import type { SafeWriter } from "../model/writer";
import { MediaInspector } from "../media/mediaInfo";
import { planSelectGroup, planToggleChannel } from "./channels";
import { slugify } from "./fixes";
import { scheduleDeliveries } from "../planner/board";
import { deliveryChanges, type WriteRecord } from "../planner/changes";
import { blocking, counters, validateAll, type Counter } from "../platforms/checks";
import { effectiveMethod, platformDef, type AdapterRegistry, type EffectiveMethod } from "../platforms/registry";
import { previewModel, type PreviewModel } from "../previews/model";
import type { OsmmSettings } from "../settings/settings";
import { VIEW_COMPOSER, VIEW_PREVIEW_GRID, type PlannerActions } from "../ui/actions";
import { formatShortDate, formatTime } from "../ui/format";
import { ContentLoader, type LoadedContent } from "./content";
import { planComposerSchedule, scheduleNeeds, type ScheduleRequest } from "./schedule";
import { composerSession, type ComposerSession } from "./session";

const ATTACHABLE_RE = /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i;

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

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

export interface QuickFix {
  label: string;
  run(): Promise<void>;
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
      added.push(this.deps.app.metadataCache.fileToLinktext(created, v.path, true));
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

  async setAlt(v: IndexedVariant, target: string, alt: string): Promise<void> {
    await this.patchMediaMeta(v, target, { alt: alt.trim() }, "Alt text saved.");
  }

  /** Resolves true when the focal point was written. */
  setFocus(v: IndexedVariant, target: string, focus: [number, number]): Promise<boolean> {
    return this.patchMediaMeta(v, target, { focus }, "Focal point saved.");
  }

  private async patchMediaMeta(v: IndexedVariant, target: string, patch: MediaMeta, message: string): Promise<boolean> {
    const result = await this.deps.planner.write(v.file, (fresh) => {
      const next: MediaMeta = { ...fresh.mediaMeta?.[target], ...patch };
      if (!next.alt) delete next.alt;
      return { fields: { mediaMeta: { ...fresh.mediaMeta, [target]: next } } };
    });
    this.deps.planner.afterWrite(result, message);
    return result.ok;
  }

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

  async setStagger(v: IndexedVariant, minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      new Notice("Use a whole number of minutes between 0 and 1440.");
      return;
    }
    const result = await this.deps.planner.write(v.file, () => ({ fields: { staggerMinutes: minutes } }));
    this.deps.planner.afterWrite(result, `Channels are now ${minutes} min apart.`);
  }

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
}
