import { getFrontMatterInfo, normalizePath, stringifyYaml, type App, type TFile } from "obsidian";
import { formatDateTime } from "./dates";
import { isRecord, parseVariant, serializeDelivery } from "./frontmatter";
import { PLATFORM_META, type Platform } from "./platforms";
import { pinScheduledTimes, rollupStatus } from "./stateMachine";
import type { SafeWriter } from "./writer";

const ILLEGAL_RE = /[\\/:*?"<>|#^[\]]/g;

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Leading dots and spaces, repeatedly: ". .hidden" or "../.obsidian" must not become a hidden name.
    .replace(/^[.\s]+/, "")
    .slice(0, 120)
    .replace(/[.\s]+$/, "");
  return cleaned || "Untitled";
}

function render(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}

function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export interface FactoryOptions {
  rootFolder(): string;
  /** The plugin's stagger, for posts without their own (fork keeps every scheduled time). Default 0. */
  defaultStaggerMinutes?(): number;
}

export class NoteFactory {
  constructor(
    private readonly app: App,
    private readonly writer: SafeWriter,
    private readonly opts: FactoryOptions,
  ) {}

  async createCampaign(input: { title: string; anchorDate?: number; link?: string; brief?: string }): Promise<TFile> {
    const title = input.title.trim();
    if (!title) throw new Error("Campaign title is required");
    const name = safeFileName(title);
    const folder = await this.ensureFolder(`${this.root()}/${name}`);
    const fm: Record<string, unknown> = { type: "social-campaign", title, status: "active" };
    if (input.anchorDate !== undefined) fm.anchor_date = formatDateTime(input.anchorDate);
    if (input.link) fm.link = input.link;
    const brief = input.brief?.trim();
    const body = brief
      ? `\n## Brief\n\n${brief}\n\n## Variants\n\n\`\`\`social-variants\n\`\`\`\n`
      : "\n## Brief\n\n\n## Variants\n\n```social-variants\n```\n";
    return this.app.vault.create(this.uniquePath(folder, name), render(fm, body));
  }

  async createVariant(input: {
    platform: Platform;
    campaign?: TFile;
    title?: string;
    channels?: string[];
    body?: string;
    scheduledAt?: number;
  }): Promise<TFile> {
    const title = input.title?.trim();
    let folder: string;
    let name: string;
    if (input.campaign) {
      folder = parentPath(input.campaign.path);
      name = `${input.campaign.basename} – ${PLATFORM_META[input.platform].label}`;
    } else {
      if (!title) throw new Error("A standalone post needs a title");
      folder = await this.ensureFolder(`${this.root()}/Posts`);
      name = title;
    }
    const fm: Record<string, unknown> = { type: "social-post" };
    if (input.campaign) fm.campaign = `[[${input.campaign.basename}]]`;
    if (title) fm.title = title;
    fm.platform = input.platform;
    fm.channels = input.channels ?? [];
    fm.mode = "auto";
    fm.status = "draft";
    if (input.scheduledAt !== undefined) fm.scheduled_at = formatDateTime(input.scheduledAt);
    return this.app.vault.create(this.uniquePath(folder, safeFileName(name)), render(fm, `${input.body ?? ""}\n`));
  }

  async forkVariant(file: TFile, channelId: string, channelName: string): Promise<TFile> {
    // Snapshot and remove the channel in ONE queued write, so writes queued before the fork are
    // included in the snapshot and none can land between reading and rewriting the original.
    const stagger = this.opts.defaultStaggerMinutes?.() ?? 0;
    let pinned: string[] = [];
    const { snapshot, variant } = await this.writer.run(file, (orig) => {
      const current = parseVariant(orig, file.path).value;
      if (!current) throw new Error(`${file.path} is not a valid social post`);
      if (!current.channels.includes(channelId)) throw new Error(`${channelId} is not a channel of this post`);
      // Frozen: the fork would drop the raw entry and the channel could be posted again.
      if (current.invalidDeliveries?.includes(channelId)) throw new Error(`${channelId}'s delivery entry can't be read. Fix its status in the note before forking it.`);
      // In flight: the run's result lands on this note, where the forked channel would no longer exist (M4 P4).
      if (current.deliveries[channelId]?.status === "publishing") throw new Error(`${channelName} is being published right now. Try again in a minute.`);
      // Outcome unknown: a pending lookup still targets this note, and the fork would invite a second post.
      if (current.deliveries[channelId]?.status === "check_needed") {
        throw new Error(`${channelName} needs a check first (did it go out?). Resolve it in Needs attention, then try again.`);
      }
      if (current.channels.length < 2) throw new Error("Cannot fork the only channel of a post");
      const copy = structuredClone(orig);
      const channels = current.channels.filter((c) => c !== channelId);
      // Scheduled channels that move up keep their time (M4 Task 6 cross-task ruling).
      const pins = pinScheduledTimes(current, { channels }, stagger);
      pinned = Object.keys(pins);
      const deliveries = { ...current.deliveries, ...pins };
      delete deliveries[channelId];
      orig.channels = channels;
      // Only drop the forked channel's entry and write the pinned ones; other raw entries stay verbatim.
      const raw = isRecord(orig.deliveries) ? { ...orig.deliveries } : {};
      delete raw[channelId];
      for (const [id, d] of Object.entries(pins)) raw[id] = serializeDelivery(d);
      if (Object.keys(raw).length > 0) orig.deliveries = raw;
      else delete orig.deliveries;
      orig.status = rollupStatus({ ...current, channels, deliveries });
      return { snapshot: copy, variant: current };
    });

    // The forked channel becomes the first (and only) one: it keeps its time too.
    const delivery = pinScheduledTimes(variant, { channels: [channelId] }, stagger)[channelId] ?? variant.deliveries[channelId];
    const forkFm: Record<string, unknown> = { ...snapshot, channels: [channelId] };
    if (delivery) forkFm.deliveries = { [channelId]: serializeDelivery(delivery) };
    else delete forkFm.deliveries;
    forkFm.status = rollupStatus({ ...variant, channels: [channelId], deliveries: delivery ? { [channelId]: delivery } : {} });

    const content = await this.app.vault.read(file);
    const info = getFrontMatterInfo(content);
    const body = info.exists ? content.slice(info.contentStart) : content;
    const forkPath = this.uniquePath(parentPath(file.path), safeFileName(`${file.basename} – ${channelName}`));
    try {
      return await this.app.vault.create(forkPath, render(forkFm, body));
    } catch (err) {
      // The channel was already removed from the original above; if the fork note can't be
      // created, restore the channel (at its original position) and its raw delivery entry on
      // the original rather than losing it.
      await this.writer.run(file, (orig) => {
        const originalChannels = Array.isArray(snapshot.channels) ? (snapshot.channels as string[]) : [];
        const position = originalChannels.indexOf(channelId);
        const channels = Array.isArray(orig.channels) ? [...(orig.channels as string[])] : [];
        if (!channels.includes(channelId)) {
          const insertAt = position >= 0 && position <= channels.length ? position : channels.length;
          channels.splice(insertAt, 0, channelId);
        }
        orig.channels = channels;
        const rawDeliveries = isRecord(snapshot.deliveries) ? snapshot.deliveries : undefined;
        if (rawDeliveries && channelId in rawDeliveries) {
          const raw = isRecord(orig.deliveries) ? { ...orig.deliveries } : {};
          raw[channelId] = rawDeliveries[channelId];
          orig.deliveries = raw;
        }
        if (pinned.length && isRecord(orig.deliveries)) {
          // Undo the pinned times: back to the entries (or their absence) before the fork.
          const raw = { ...orig.deliveries };
          for (const id of pinned) {
            if (rawDeliveries && id in rawDeliveries) raw[id] = rawDeliveries[id];
            else delete raw[id];
          }
          if (Object.keys(raw).length > 0) orig.deliveries = raw;
          else delete orig.deliveries;
        }
        const restored = parseVariant(orig, file.path).value;
        if (restored) orig.status = rollupStatus(restored);
      });
      throw err;
    }
  }

  private root(): string {
    return normalizePath(this.opts.rootFolder() || "Social");
  }

  private async ensureFolder(path: string): Promise<string> {
    const p = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
    return p;
  }

  private uniquePath(folder: string, name: string): string {
    const prefix = folder ? `${folder}/` : "";
    let candidate = `${prefix}${name}.md`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(candidate); n++) candidate = `${prefix}${name} ${n}.md`;
    return candidate;
  }
}
