/**
 * In-memory fake of the parts of the Obsidian API the plugin uses.
 * Behaviour mirrors Obsidian where it matters for our code (see Task 2 interface notes).
 * Grow this file when new API surface is needed; never import it from src/.
 */
import YAML from "yaml";
import momentLib from "moment";

export const moment = momentLib;

type Callback = (...args: any[]) => unknown;

export interface EventRef {
  readonly name: string;
  readonly cb: Callback;
  readonly owner: Events;
}

export class Events {
  private handlers = new Map<string, Set<Callback>>();

  on(name: string, cb: Callback): EventRef {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(cb);
    return { name, cb, owner: this };
  }

  off(name: string, cb: Callback): void {
    this.handlers.get(name)?.delete(cb);
  }

  offref(ref: EventRef): void {
    ref.owner.off(ref.name, ref.cb);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(name) ?? [])]) cb(...args);
  }
}

export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return p === "" ? "/" : p;
}

export function parseYaml(text: string): any {
  return YAML.parse(text) ?? null;
}

export function stringifyYaml(obj: unknown): string {
  return YAML.stringify(obj);
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/.exec(content);
  if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const from = content.indexOf("\n") + 1;
  const fm = m[1] ?? "";
  return { exists: true, frontmatter: fm, from, to: from + fm.length, contentStart: m[0].length };
}

export abstract class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
  constructor(public vault: Vault) {}
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "/";
  }
}

function setPath(f: TAbstractFile, path: string): void {
  f.path = path;
  f.name = path.split("/").pop() ?? path;
  if (f instanceof TFile) {
    const dot = f.name.lastIndexOf(".");
    f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
    f.extension = dot > 0 ? f.name.slice(dot + 1) : "";
  }
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
}

interface Entry {
  file: TFile;
  content: string;
}

export class Vault extends Events {
  private files = new Map<string, Entry>();
  private folders = new Set<string>(["/"]);

  constructor(private readonly app: App) {
    super();
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map((e) => e.file);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(normalizePath(path))?.file ?? null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    const entry = this.files.get(p);
    if (entry) return entry.file;
    if (this.folders.has(p)) {
      const folder = new TFolder(this);
      setPath(folder, p);
      return folder;
    }
    return null;
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.folders.has(p) || this.files.has(p)) throw new Error("Folder already exists.");
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    return this.getAbstractFileByPath(p) as TFolder;
  }

  async create(path: string, content: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error("File already exists.");
    const dir = parentOf(p);
    if (!this.folders.has(dir)) throw new Error(`Folder ${dir} does not exist.`);
    const file = new TFile(this);
    setPath(file, p);
    file.stat = { ctime: Date.now(), mtime: Date.now(), size: content.length };
    this.files.set(p, { file, content });
    this.trigger("create", file);
    this.app.metadataCache.fileChanged(file, content);
    return file;
  }

  async read(file: TFile): Promise<string> {
    return this.entry(file).content;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.entry(file).content;
  }

  async modify(file: TFile, content: string): Promise<void> {
    const entry = this.entry(file);
    entry.content = content;
    file.stat = { ...file.stat, mtime: Date.now(), size: content.length };
    this.trigger("modify", file);
    this.app.metadataCache.fileChanged(file, content);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.entry(file).content);
    await this.modify(file, next);
    return next;
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    if (!(file instanceof TFile)) throw new Error("The fake vault only renames files");
    const p = normalizePath(newPath);
    if (this.files.has(p)) throw new Error("Destination file already exists!");
    const entry = this.entry(file);
    const oldPath = file.path;
    this.files.delete(oldPath);
    setPath(file, p);
    this.files.set(p, entry);
    this.trigger("rename", file, oldPath);
    this.app.metadataCache.fileRenamed(file, oldPath);
  }

  async delete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) throw new Error("The fake vault only deletes files");
    this.entry(file);
    this.files.delete(file.path);
    this.trigger("delete", file);
    this.app.metadataCache.fileDeleted(file);
  }

  private entry(file: TFile): Entry {
    const entry = this.files.get(file.path);
    if (!entry || entry.file !== file) throw new Error(`File not found: ${file.path}`);
    return entry;
  }
}

export interface CachedMetadata {
  frontmatter?: Record<string, any>;
}

export class MetadataCache extends Events {
  private caches = new Map<string, CachedMetadata>();

  constructor(private readonly app: App) {
    super();
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.caches.get(file.path) ?? null;
  }

  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    const target = (linkpath.split("#")[0] ?? "").trim();
    if (!target) return null;
    const withExt = target.endsWith(".md") ? target : `${target}.md`;
    const exact = this.app.vault.getFileByPath(withExt);
    if (exact) return exact;
    const base = withExt.split("/").pop();
    return this.app.vault.getFiles().find((f) => f.name === base) ?? null;
  }

  fileChanged(file: TFile, content: string): void {
    const info = getFrontMatterInfo(content);
    let frontmatter: Record<string, any> | undefined;
    if (info.exists) {
      try {
        const parsed = parseYaml(info.frontmatter);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed;
      } catch {
        frontmatter = undefined;
      }
    }
    const cache: CachedMetadata = frontmatter ? { frontmatter } : {};
    this.caches.set(file.path, cache);
    setTimeout(() => this.trigger("changed", file, content, cache), 0);
  }

  fileRenamed(file: TFile, oldPath: string): void {
    const cache = this.caches.get(oldPath);
    this.caches.delete(oldPath);
    if (cache) this.caches.set(file.path, cache);
  }

  fileDeleted(file: TFile): void {
    const prev = this.caches.get(file.path) ?? null;
    this.caches.delete(file.path);
    setTimeout(() => this.trigger("deleted", file, prev), 0);
  }
}

export class FileManager {
  constructor(private readonly app: App) {}

  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void> {
    const content = await this.app.vault.read(file);
    const info = getFrontMatterInfo(content);
    const fm = info.exists ? (parseYaml(info.frontmatter) ?? {}) : {};
    fn(fm);
    const body = info.exists ? content.slice(info.contentStart) : content;
    const yaml = Object.keys(fm).length ? stringifyYaml(fm) : "";
    await this.app.vault.modify(file, `---\n${yaml}---\n${body}`);
  }
}

export class Workspace extends Events {
  onLayoutReady(cb: () => void): void {
    cb();
  }
}

export class SecretStorage extends Events {
  private secrets = new Map<string, string>();

  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid secret id: ${id}`);
    this.secrets.set(id, secret);
  }

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  listSecrets(): string[] {
    return [...this.secrets.keys()];
  }
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  workspace = new Workspace();
  secretStorage = new SecretStorage();
  private local = new Map<string, unknown>();

  constructor() {
    this.vault = new Vault(this);
    this.metadataCache = new MetadataCache(this);
    this.fileManager = new FileManager(this);
  }

  loadLocalStorage(key: string): any | null {
    return this.local.has(key) ? structuredClone(this.local.get(key)) : null;
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    if (data === null) this.local.delete(key);
    else this.local.set(key, structuredClone(data));
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
}

export class Component {
  private cleanups: Array<() => void> = [];
  register(cb: () => void): void {
    this.cleanups.push(cb);
  }
  registerEvent(ref: EventRef): void {
    this.cleanups.push(() => ref.owner.offref(ref));
  }
  async load(): Promise<void> {
    await this.onload();
  }
  onload(): void | Promise<void> {}
  unload(): void {
    for (const cb of this.cleanups.splice(0)) cb();
    this.onunload();
  }
  onunload(): void {}
}

export class Plugin extends Component {
  private data: unknown = null;
  settingTabs: PluginSettingTab[] = [];
  constructor(
    public app: App,
    public manifest: PluginManifest,
  ) {
    super();
  }
  async loadData(): Promise<any> {
    return structuredClone(this.data);
  }
  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
  display(): void {}
  hide(): void {}
}

export class TextComponent {
  value = "";
  inputEl = document.createElement("input");
  private cb: ((v: string) => unknown) | undefined;
  setPlaceholder(_p: string): this {
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    this.inputEl.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown): this {
    this.cb = cb;
    return this;
  }
  /** Test helper: simulate the user typing. */
  async change(v: string): Promise<void> {
    this.setValue(v);
    await this.cb?.(v);
  }
}

export class DropdownComponent {
  value = "";
  options: Record<string, string> = {};
  private cb: ((v: string) => unknown) | undefined;
  addOption(value: string, label: string): this {
    this.options[value] = label;
    return this;
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

export class Setting {
  static all: Setting[] = [];
  name = "";
  desc = "";
  heading = false;
  components: Array<TextComponent | DropdownComponent> = [];
  settingEl = document.createElement("div");
  constructor(containerEl: HTMLElement) {
    containerEl.appendChild(this.settingEl);
    Setting.all.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addText(cb: (c: TextComponent) => unknown): this {
    const c = new TextComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    const c = new DropdownComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
}

export class Notice {
  static messages: string[] = [];
  constructor(public message: string) {
    Notice.messages.push(message);
  }
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  json: any;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** Test-only: queue one handler per expected request. */
export const requestUrlMock = {
  queue: [] as Array<(req: RequestUrlParam) => RequestUrlResponse | Error>,
};

export async function requestUrl(req: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const param = typeof req === "string" ? { url: req } : req;
  const handler = requestUrlMock.queue.shift();
  if (!handler) throw new Error(`No requestUrl fixture for ${param.url}`);
  const res = handler(param);
  if (res instanceof Error) throw res;
  if (res.status >= 400 && param.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${res.status}`), { status: res.status, headers: res.headers });
  }
  return res;
}
