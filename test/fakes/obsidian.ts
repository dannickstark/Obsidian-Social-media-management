/**
 * In-memory fake of the parts of the Obsidian API the plugin uses.
 * Behaviour mirrors Obsidian where it matters for our code (see Task 2 interface notes).
 * Grow this file when new API surface is needed; never import it from src/.
 */
import YAML from "yaml";
import momentLib from "moment";

export const moment = momentLib;

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
  binary?: ArrayBuffer;
}

export class Vault extends Events {
  private files = new Map<string, Entry>();
  private folders = new Set<string>(["/"]);

  constructor(private readonly app: App) {
    super();
  }

  getName(): string {
    return "Test Vault";
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

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const entry = this.entry(file);
    entry.binary = data.slice(0);
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: data.byteLength };
    this.trigger("modify", file);
    this.app.metadataCache.fileChanged(file, "");
  }

  getResourcePath(file: TFile): string {
    return `app://local/${file.path}`;
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
    const name = target.split("/").pop() ?? target;
    const withExt = /\.[a-z0-9]+$/i.test(name) ? target : `${target}.md`;
    const exact = this.app.vault.getFileByPath(withExt);
    if (exact) return exact;
    const base = withExt.split("/").pop();
    return this.app.vault.getFiles().find((f) => f.name === base) ?? null;
  }

  /** The shortest link that resolves to `file`: the name when unambiguous, otherwise the vault path. */
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const md = file.extension === "md" && omitMdExtension;
    const short = md ? file.basename : file.name;
    if (this.getFirstLinkpathDest(short, sourcePath) === file) return short;
    return md ? file.path.slice(0, -3) : file.path;
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

  async trashFile(file: TFile): Promise<void> {
    await this.app.vault.delete(file);
  }

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
}

export class WorkspaceLeaf {
  view: ItemView | null = null;
  viewType: string | null = null;
  file: TFile | null = null;
  constructor(public app: App) {}
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
  async openFile(file: TFile): Promise<void> {
    this.file = file;
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
  workspace: Workspace;
  secretStorage = new SecretStorage();
  private local = new Map<string, unknown>();

  constructor() {
    this.vault = new Vault(this);
    this.metadataCache = new MetadataCache(this);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace(this);
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
  registerDomEvent(el: EventTarget, type: string, handler: (ev: Event) => unknown): void {
    el.addEventListener(type, handler);
    this.cleanups.push(() => el.removeEventListener(type, handler));
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
  async setState(_state: unknown, _result: { history: boolean }): Promise<void> {}
  getState(): Record<string, unknown> {
    return {};
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

/** An open note in the editor. Tests set `file` and `editor` directly. */
export class MarkdownView extends ItemView {
  file: TFile | null = null;
  editor: { getValue(): string } = { getValue: () => "" };
  override getViewType(): string {
    return "markdown";
  }
  /** Flushes the editor's buffer to disk, like Obsidian's real MarkdownView.save(). */
  async save(): Promise<void> {
    if (this.file) await this.app.vault.modify(this.file, this.editor.getValue());
  }
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
  /** The position the menu was shown at, when shown via showAtPosition (or a detail-0 click). */
  pos: { x: number; y: number } | null = null;
  separators = 0;
  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    this.items.push(item);
    cb(item);
    return this;
  }
  addSeparator(): this {
    this.separators++;
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): this {
    Menu.last = this;
    return this;
  }
  showAtPosition(pos: { x: number; y: number }): this {
    this.pos = pos;
    Menu.last = this;
    return this;
  }
}

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin extends Component {
  private data: unknown = null;
  settingTabs: PluginSettingTab[] = [];
  commands: Command[] = [];
  codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: any) => unknown>();
  ribbon: Array<{ icon: string; title: string; cb: () => unknown }> = [];
  protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
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
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.protocolHandlers.set(action, handler);
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

export class ToggleComponent {
  value = false;
  private cb: ((v: boolean) => unknown) | undefined;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(cb: (v: boolean) => unknown): this {
    this.cb = cb;
    return this;
  }
  /** Test helper: the user flips the toggle. */
  async toggle(v: boolean): Promise<void> {
    this.value = v;
    await this.cb?.(v);
  }
}

export class Setting {
  static all: Setting[] = [];
  name = "";
  desc = "";
  heading = false;
  components: Array<TextComponent | DropdownComponent | TextAreaComponent | ButtonComponent | ToggleComponent> = [];
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
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    const c = new TextAreaComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    const c = new ButtonComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    const c = new ToggleComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
}

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

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
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

/** Test-only: queue one handler per expected request; every request is recorded in `calls`. A handler may return a promise (a slow or silent server). */
export const requestUrlMock = {
  queue: [] as Array<(req: RequestUrlParam) => RequestUrlResponse | Error | Promise<RequestUrlResponse | Error>>,
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
  const res = await handler(param);
  if (res instanceof Error) throw res;
  if (res.status >= 400 && param.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${res.status}`), { status: res.status, headers: res.headers });
  }
  return res;
}

export function setIcon(el: HTMLElement, name: string): void {
  el.dataset.icon = name;
}

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
