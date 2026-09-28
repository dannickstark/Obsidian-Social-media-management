import { TFile, type App, type EventRef, type TAbstractFile } from "obsidian";
import { bodyOf, excerpt } from "../model/body";
import { isRecord, parseCampaign, parseVariant, socialKind, type SocialKind } from "../model/frontmatter";
import type { Campaign, Issue, Variant } from "../model/types";
import { platformDef } from "../platforms/registry";
import { countFor, postText } from "../platforms/text";

export interface IndexedCampaign extends Campaign {
  file: TFile;
  issues: Issue[];
}

export interface IndexedVariant extends Variant {
  file: TFile;
  issues: Issue[];
  /** Path of the linked campaign note, if the link resolves. */
  campaignPath?: string;
  excerpt: string;
  displayTitle: string;
  bodyChars: number;
}

export interface InvalidNote {
  file: TFile;
  kind: SocialKind;
  issues: Issue[];
}

export interface IndexChange {
  changed: string[];
  removed: string[];
}

type Listener = (change: IndexChange) => void;

type Entry =
  | { kind: "campaign"; value: IndexedCampaign }
  | { kind: "post"; value: IndexedVariant }
  | { kind: "invalid"; value: InvalidNote }
  | null;

export class SocialIndex {
  private readonly campaignMap = new Map<string, IndexedCampaign>();
  private readonly variantMap = new Map<string, IndexedVariant>();
  private readonly invalidMap = new Map<string, InvalidNote>();
  private readonly listeners = new Set<Listener>();
  private readonly pendingChanged = new Set<string>();
  private readonly pendingRemoved = new Set<string>();
  private readonly sequence = new Map<string, number>();
  private nextToken = 0;
  private refs: Array<{ source: { offref(ref: EventRef): void }; ref: EventRef }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;

  constructor(
    private readonly app: App,
    private readonly debounceMs = 50,
  ) {}

  get revision(): number {
    return this.version;
  }

  async build(): Promise<void> {
    this.campaignMap.clear();
    this.variantMap.clear();
    this.invalidMap.clear();
    // Claim a sequence token per path before reading: a reindex that runs while build() awaits its
    // reads takes a newer token, and its (newer) result must not be overwritten by ours.
    const files = this.app.vault.getMarkdownFiles();
    // Record the claimed path alongside its token: after the await, `file.path` may have changed
    // through a rename, but the token was claimed (and must be checked/deleted) under the old path.
    const claims = files.map((f) => ({ path: f.path, token: this.claim(f.path) }));
    const entries = await Promise.all(files.map((f) => this.read(f)));
    files.forEach((_file, i) => {
      const { path, token } = claims[i]!;
      const entry = entries[i];
      if (this.sequence.get(path) !== token) return;
      this.sequence.delete(path);
      if (entry) this.store(entry);
    });
    this.relinkCampaigns();
    for (const path of [...this.campaignMap.keys(), ...this.variantMap.keys()]) this.pendingChanged.add(path);
    this.flush();
  }

  start(): void {
    const { metadataCache, vault } = this.app;
    this.refs.push({ source: metadataCache, ref: metadataCache.on("changed", (file: TFile) => void this.onChanged(file)) });
    this.refs.push({ source: vault, ref: vault.on("rename", (file: TAbstractFile, oldPath: string) => void this.onRename(file, oldPath)) });
    this.refs.push({ source: vault, ref: vault.on("delete", (file: TAbstractFile) => this.onDelete(file)) });
  }

  stop(): void {
    for (const { source, ref } of this.refs) source.offref(ref);
    this.refs = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  campaigns(): IndexedCampaign[] {
    return [...this.campaignMap.values()];
  }

  variants(): IndexedVariant[] {
    return [...this.variantMap.values()];
  }

  invalidNotes(): InvalidNote[] {
    return [...this.invalidMap.values()];
  }

  getCampaign(path: string): IndexedCampaign | undefined {
    return this.campaignMap.get(path);
  }

  getVariant(path: string): IndexedVariant | undefined {
    return this.variantMap.get(path);
  }

  variantsOf(campaignPath: string): IndexedVariant[] {
    return this.variants().filter((v) => v.campaignPath === campaignPath);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit pending changes now (used after build and by tests). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingChanged.size === 0 && this.pendingRemoved.size === 0) return;
    const change: IndexChange = { changed: [...this.pendingChanged], removed: [...this.pendingRemoved] };
    this.pendingChanged.clear();
    this.pendingRemoved.clear();
    this.version++;
    for (const listener of [...this.listeners]) listener(change);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private kindAt(path: string): SocialKind | null {
    if (this.campaignMap.has(path)) return "campaign";
    if (this.variantMap.has(path)) return "post";
    return this.invalidMap.get(path)?.kind ?? null;
  }

  private drop(path: string): void {
    this.campaignMap.delete(path);
    this.variantMap.delete(path);
    this.invalidMap.delete(path);
  }

  private async read(file: TFile): Promise<Entry> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const kind = socialKind(fm);
    if (!kind || !isRecord(fm)) return null;
    if (kind === "campaign") {
      const r = parseCampaign(fm, file.path);
      return r.value
        ? { kind: "campaign", value: { ...r.value, file, issues: r.issues } }
        : { kind: "invalid", value: { file, kind, issues: r.issues } };
    }
    const r = parseVariant(fm, file.path);
    if (!r.value) return { kind: "invalid", value: { file, kind, issues: r.issues } };
    const body = bodyOf(await this.app.vault.cachedRead(file));
    const text = excerpt(body);
    return {
      kind: "post",
      value: {
        ...r.value,
        file,
        issues: r.issues,
        excerpt: text,
        displayTitle: r.value.title ?? (text || file.basename),
        campaignPath: this.resolveCampaign(r.value),
        bodyChars: countFor(postText(body, platformDef(r.value.platform)), platformDef(r.value.platform)),
      },
    };
  }

  private store(entry: NonNullable<Entry>): void {
    const path = entry.value.file.path;
    this.drop(path);
    if (entry.kind === "campaign") this.campaignMap.set(path, entry.value);
    else if (entry.kind === "post") this.variantMap.set(path, entry.value);
    else this.invalidMap.set(path, entry.value);
  }

  /** Only resolves to indexed campaign notes; during build() campaigns may not be indexed yet, so build() relinks afterwards. */
  private resolveCampaign(v: Variant): string | undefined {
    if (!v.campaignLink) return undefined;
    const dest = this.app.metadataCache.getFirstLinkpathDest(v.campaignLink, v.path);
    return dest && this.campaignMap.has(dest.path) ? dest.path : undefined;
  }

  private relinkCampaigns(): void {
    for (const v of this.variantMap.values()) {
      const next = this.resolveCampaign(v);
      if (next !== v.campaignPath) {
        this.variantMap.set(v.path, { ...v, campaignPath: next });
        this.pendingChanged.add(v.path);
      }
    }
  }

  /**
   * Re-read one file; stale reads (superseded by a newer event for the same path) are discarded.
   * Tokens come from one monotonic counter for the whole index, so a token value is never reused:
   * once a completed read deletes its entry, a later claim for the same path cannot collide with
   * an older, still in-flight claim that happens to be waiting on the same (stale) number.
   */
  private claim(path: string): number {
    const token = ++this.nextToken;
    this.sequence.set(path, token);
    return token;
  }

  private async reindex(file: TFile): Promise<{ before: SocialKind | null; after: SocialKind | null } | null> {
    const token = this.claim(file.path);
    const before = this.kindAt(file.path);
    const entry = await this.read(file);
    if (this.sequence.get(file.path) !== token) return null;
    this.sequence.delete(file.path);
    if (entry) this.store(entry);
    else this.drop(file.path);
    const after = entry ? (entry.kind === "invalid" ? entry.value.kind : entry.kind) : null;
    return { before, after };
  }

  private async onChanged(file: TFile): Promise<void> {
    const result = await this.reindex(file);
    if (!result || (result.before === null && result.after === null)) return;
    if (result.after === null) this.pendingRemoved.add(file.path);
    else this.pendingChanged.add(file.path);
    if (result.before === "campaign" || result.after === "campaign") this.relinkCampaigns();
    this.schedule();
  }

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile)) return;
    // The vault moves the metadata cache to the new path right after firing this event, but
    // synchronously within the same call stack; yield one microtask so that has happened
    // before we read the cache at the new path below.
    await Promise.resolve();
    // Any token claimed under the old path (e.g. by a build() still awaiting its read) can never
    // be resolved there again now that the file has moved; drop it so it cannot leak.
    this.sequence.delete(oldPath);
    const before = this.kindAt(oldPath);
    if (before) {
      this.drop(oldPath);
      this.pendingRemoved.add(oldPath);
    }
    const result = await this.reindex(file);
    if (result?.after) this.pendingChanged.add(file.path);
    if (before === "campaign" || result?.after === "campaign") this.relinkCampaigns();
    if (before || result?.after) this.schedule();
  }

  private onDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const before = this.kindAt(file.path);
    if (!before) return;
    this.drop(file.path);
    this.pendingRemoved.add(file.path);
    if (before === "campaign") this.relinkCampaigns();
    this.schedule();
  }
}
