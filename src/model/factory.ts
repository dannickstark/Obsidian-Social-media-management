import { getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml, type App, type TFile } from "obsidian";
import { formatDateTime } from "./dates";
import { isRecord, parseVariant, serializeDelivery, serializeDeliveries } from "./frontmatter";
import { PLATFORM_META, type Platform } from "./platforms";
import { rollupStatus } from "./stateMachine";
import type { SafeWriter } from "./writer";

const ILLEGAL_RE = /[\\/:*?"<>|#^[\]]/g;

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
    .trim();
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
}

export class NoteFactory {
  constructor(
    private readonly app: App,
    private readonly writer: SafeWriter,
    private readonly opts: FactoryOptions,
  ) {}

  async createCampaign(input: { title: string; anchorDate?: number; link?: string }): Promise<TFile> {
    const title = input.title.trim();
    if (!title) throw new Error("Campaign title is required");
    const name = safeFileName(title);
    const folder = await this.ensureFolder(`${this.root()}/${name}`);
    const fm: Record<string, unknown> = { type: "social-campaign", title, status: "active" };
    if (input.anchorDate !== undefined) fm.anchor_date = formatDateTime(input.anchorDate);
    if (input.link) fm.link = input.link;
    const body = "\n## Brief\n\n\n## Variants\n\n```social-variants\n```\n";
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
    const content = await this.app.vault.read(file);
    const info = getFrontMatterInfo(content);
    const raw: unknown = info.exists ? parseYaml(info.frontmatter) : {};
    const fm = isRecord(raw) ? raw : {};
    const variant = parseVariant(fm, file.path).value;
    if (!variant) throw new Error(`${file.path} is not a valid social post`);
    if (!variant.channels.includes(channelId)) throw new Error(`${channelId} is not a channel of this post`);
    if (variant.channels.length < 2) throw new Error("Cannot fork the only channel of a post");

    const delivery = variant.deliveries[channelId];
    const forkFm: Record<string, unknown> = { ...fm, channels: [channelId] };
    if (delivery) forkFm.deliveries = { [channelId]: serializeDelivery(delivery) };
    else delete forkFm.deliveries;
    forkFm.status = rollupStatus({ ...variant, channels: [channelId], deliveries: delivery ? { [channelId]: delivery } : {} });

    const body = info.exists ? content.slice(info.contentStart) : content;
    const forkPath = this.uniquePath(parentPath(file.path), safeFileName(`${file.basename} – ${channelName}`));
    const created = await this.app.vault.create(forkPath, render(forkFm, body));

    await this.writer.run(file, (orig) => {
      const current = parseVariant(orig, file.path).value;
      if (!current) return;
      const channels = current.channels.filter((c) => c !== channelId);
      const deliveries = { ...current.deliveries };
      delete deliveries[channelId];
      orig.channels = channels;
      const serialized = serializeDeliveries(deliveries);
      if (serialized) orig.deliveries = serialized;
      else delete orig.deliveries;
      orig.status = rollupStatus({ ...current, channels, deliveries });
    });
    return created;
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
