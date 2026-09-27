# M1a — Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the non-UI core of the OSMM Obsidian plugin: a buildable, tested plugin skeleton with the domain model, safe frontmatter writes, note creation, a live vault index, settings, secrets, and the channel registry.

**Architecture:** One TypeScript Obsidian plugin bundled with esbuild. Pure domain modules (`model/`, `index/`, `channels/`, `secrets/`, `settings/`) depend only on the `obsidian` API, and tests run against an in-memory fake of that API aliased under Vitest. UI (M1b) consumes the interfaces produced here.

**Tech Stack:** TypeScript 5.9 (strict), esbuild 0.28 + esbuild-svelte 0.9, Svelte 5, zod 4, Vitest 5 (jsdom), yaml 2, moment 2 (tests only), Obsidian API 1.13 typings.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§2 data model, §4 architecture, §5 lifecycle). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z

**Branch:** `feat/m1a-core-engine`, created from `design/social-planner`.

**Issues covered:** #2 #3 #4 #5 #6 #7 #9 (E0) · #11–#16 (E1) · #18–#20 (E2) · #22 #23 #24 (E3). #8 (theming) and #25 (channels UI) are in the M1b plan.

## Global Constraints

- Plugin id `osmm-social-planner`; `minAppVersion` **1.11.4** (the first version with `app.secretStorage`).
- Secret values live only in `app.secretStorage`. Settings (`data.json`) store **secret ids**, never secret values.
- Every frontmatter mutation of an existing social note goes through `SafeWriter`. Only `NoteFactory` creates notes.
- Dates are written as local ISO with offset: `YYYY-MM-DDTHH:mm:ss±HH:MM`. Reading accepts ISO with or without an offset, `YYYY-MM-DD HH:mm`, and `YYYY-MM-DD`.
- Channel ids are `<prefix>/<slug>` with prefixes `li x ig fb ma bs tg dc hn ih rd wa wp`; the slug matches `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`.
- Frontmatter keys are snake_case as in spec §2.2 (`scheduled_at`, `stagger_minutes`, `remote_id`, `anchor_date`, `featured_image`); TypeScript uses camelCase.
- Thread separator: a body line that is exactly `---` outside a code fence.
- Tests run with `TZ=Europe/Berlin` (set in `vitest.config.ts`).
- No network access in M1.
- CI uses Node 22.

## Review Focus

1. **Hand-edited YAML with the wrong shape** (`channels: li/me` as a string, `reminders: "60"`, `reminders: 60`): it should be coerced, not rejected. Tests in Task 7.
2. **Dates without a timezone, date-only values, and DST boundaries** (e.g. 25 Oct 2026 in Berlin): wall-clock time is kept and stored with the correct offset. Tests in Task 5.
3. **A note renamed while a frontmatter write is queued**: the write lands in the renamed file and nothing is lost. Test in Task 10.
4. **A campaign renamed** (with or without Obsidian updating the links): variants re-link, or show as orphaned without crashing. Tests in Task 15.
5. **Titles containing characters that are illegal in file names** (`/ : ? # [ ]`) **and name collisions**: a safe, unique path is created. Tests in Task 11.

---

## File Structure

```
package.json, tsconfig.json, esbuild.config.mjs, vitest.config.ts, svelte.config.js
eslint.config.mjs, .prettierrc, .gitignore, manifest.json, versions.json
.github/workflows/ci.yml, .github/workflows/release.yml
scripts/version-bump.mjs            sync manifest/versions on `npm version`
scripts/seedData.ts                 pure generator of dev-vault notes + settings
scripts/seed.ts                     writes the dev vault to disk
docs/adr/0001-secrets.md            spike outcome (#22)
src/main.ts                         plugin entry; wires services
src/styles/index.css                CSS entry (emitted as styles.css)
src/ui/mount.ts                     Svelte mount/unmount helper
src/model/platforms.ts              platform ids, metadata, channel-id parsing
src/model/dates.ts                  parse/format local date-times
src/model/schemas.ts                zod schemas, status/kind enums, zodIssues()
src/model/types.ts                  domain types
src/model/frontmatter.ts            parse/serialize campaigns & variants
src/model/stateMachine.ts           delivery transitions, roll-up, stagger
src/model/body.ts                   body split, threads, embeds, excerpt, char counts
src/model/writer.ts                 SafeWriter (serialized processFrontMatter)
src/model/factory.ts                NoteFactory (create campaign/variant, fork)
src/settings/settings.ts            settings type, defaults, migrations, parsers
src/settings/device.ts              device-local settings (localStorage)
src/settings/tab.ts                 settings tab (General section)
src/secrets/secrets.ts              Secrets wrapper over app.secretStorage
src/channels/registry.ts            ChannelRegistry (channels + groups)
src/index/socialIndex.ts            SocialIndex (live in-memory index)
src/index/queries.ts                PostRow expansion + filters/queries
src/index/stores.ts                 Svelte store bridge
test/setup.ts                       DOM polyfills for Obsidian helpers
test/fakes/obsidian.ts              in-memory Obsidian API fake
test/helpers.ts                     createApp, writeNote, settle, nextChange
test/**/<module>.test.ts            one test file per module
```

---

### Task 1: Scaffold the Obsidian plugin (#2)

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `src/main.ts`, `src/styles/index.css`

**Interfaces:**
- Produces: `npm run build` → `main.js`, `styles.css`; `npm run dev` watches and copies into `dev-vault/.obsidian/plugins/osmm-social-planner/`; default export `OsmmPlugin extends Plugin` in `src/main.ts`.

- [ ] **Step 1: Create the branch**

```bash
git checkout design/social-planner && git checkout -b feat/m1a-core-engine
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "osmm-social-planner",
  "version": "0.1.0",
  "description": "Plan, preview, schedule and publish social media posts from Obsidian.",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "npm run typecheck && node esbuild.config.mjs production",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "seed": "tsx scripts/seed.ts",
    "version": "node scripts/version-bump.mjs && git add manifest.json versions.json"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Install the build toolchain**

```bash
npm install --save-dev obsidian@^1.13.1 typescript@^5.9 esbuild@^0.28 builtin-modules@^5 \
  @types/node@^22 tslib eslint@^9 @eslint/js@^9 typescript-eslint@^8 prettier@^3
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "test/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 5: Write `esbuild.config.mjs`**

```js
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

const prod = process.argv[2] === "production";
const devVault = process.env.OSMM_DEV_VAULT ?? "dev-vault";
const pluginDir = `${devVault}/.obsidian/plugins/osmm-social-planner`;

/** esbuild names the CSS bundle after the JS outfile; Obsidian expects styles.css. */
const finalize = {
  name: "finalize",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      if (existsSync("main.css")) await rename("main.css", "styles.css");
      if (prod) return;
      await mkdir(pluginDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        if (existsSync(f)) await copyFile(f, `${pluginDir}/${f}`);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  plugins: [finalize],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
```

- [ ] **Step 6: Write `manifest.json` and `versions.json`**

```json
{
  "id": "osmm-social-planner",
  "name": "Social Planner (OSMM)",
  "version": "0.1.0",
  "minAppVersion": "1.11.4",
  "description": "Plan, preview, schedule and publish social media posts and WordPress articles from your vault.",
  "author": "dannickstark",
  "authorUrl": "https://github.com/dannickstark",
  "isDesktopOnly": false
}
```

```json
{
  "0.1.0": "1.11.4"
}
```

- [ ] **Step 7: Write lint/format/ignore config**

`eslint.config.mjs`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "styles.css", "dev-vault/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/fakes/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
```

`.prettierrc`:
```json
{ "printWidth": 100, "trailingComma": "all" }
```

`.gitignore`:
```
node_modules/
main.js
main.css
styles.css
dev-vault/
coverage/
.DS_Store
```

- [ ] **Step 8: Write the plugin entry and CSS entry**

`src/styles/index.css`:
```css
/* OSMM Social Planner — stylesheet entry. Component styles are appended by the Svelte build. */
```

`src/main.ts`:
```ts
import { Plugin } from "obsidian";
import "./styles/index.css";

export default class OsmmPlugin extends Plugin {
  override async onload(): Promise<void> {
    console.debug("[osmm] loaded");
  }

  override onunload(): void {
    console.debug("[osmm] unloaded");
  }
}
```

- [ ] **Step 9: Verify typecheck, lint and production build**

Run: `npm run typecheck && npm run lint && node esbuild.config.mjs production && ls main.js styles.css manifest.json`
Expected: no errors; the three files are listed.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Obsidian plugin with esbuild (refs #2)"
```

---

### Task 2: Vitest with an in-memory Obsidian fake (#4)

**Files:**
- Create: `vitest.config.ts`, `test/setup.ts`, `test/fakes/obsidian.ts`, `test/helpers.ts`, `test/fakes/obsidian.test.ts`

**Interfaces:**
- Produces (tests only): `obsidian` resolves to the fake at test time, which exports `App, Vault, MetadataCache, FileManager, Workspace, SecretStorage, Events, EventRef, TAbstractFile, TFile, TFolder, Plugin, PluginSettingTab, Setting, TextComponent, DropdownComponent, Notice, normalizePath, parseYaml, stringifyYaml, getFrontMatterInfo, requestUrl, moment`, plus test-only `requestUrlMock`.
- `test/helpers.ts`: `createApp(): App`, `settle(ms?: number): Promise<void>`, `writeNote(app, path, frontmatter | null, body?): Promise<TFile>`.
- Fake behaviour matches Obsidian: `vault.create` fails if the parent folder is missing; `metadataCache` updates the cache synchronously but fires `changed` on the next macrotask; `vault.rename` fires `rename(file, oldPath)` and moves the cache without firing `changed`; `vault.delete` fires `delete(file)`.

- [ ] **Step 1: Install test dependencies**

```bash
npm install --save-dev vitest@^5 @vitest/coverage-v8@^5 jsdom yaml@^2 moment@^2.30
```

- [ ] **Step 2: Write `vitest.config.ts` and `test/setup.ts`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// All date logic is tested in a zone with DST so offset bugs surface.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: { provider: "v8", include: ["src/**"] },
  },
});
```

```ts
// test/setup.ts — minimal versions of the DOM helpers Obsidian adds to HTMLElement.
declare global {
  interface HTMLElement {
    empty(): void;
  }
}

HTMLElement.prototype.empty = function empty(this: HTMLElement) {
  this.replaceChildren();
};

export {};
```

- [ ] **Step 3: Write the failing fake self-test**

`test/fakes/obsidian.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { requestUrl, requestUrlMock } from "./obsidian";
import { createApp, settle, writeNote } from "../helpers";

describe("obsidian fake", () => {
  it("runs in Europe/Berlin", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-120);
  });

  it("parses frontmatter into the cache and emits changed asynchronously", async () => {
    const app = createApp();
    const seen: string[] = [];
    app.metadataCache.on("changed", (file: TFile) => seen.push(file.path));
    const file = await writeNote(app, "Social/Event X/Event X.md", { type: "social-campaign", title: "Event X" }, "Brief\n");
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ type: "social-campaign", title: "Event X" });
    expect(seen).toEqual([]);
    await settle();
    expect(seen).toEqual(["Social/Event X/Event X.md"]);
  });

  it("refuses to create a file in a missing folder", async () => {
    await expect(createApp().vault.create("Nope/a.md", "")).rejects.toThrow(/does not exist/);
  });

  it("processFrontMatter rewrites the frontmatter and keeps the body", async () => {
    const app = createApp();
    const file = await writeNote(app, "a.md", { a: 1 }, "Body\n");
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm.b = 2;
    });
    expect(await app.vault.read(file)).toBe("---\na: 1\nb: 2\n---\nBody\n");
  });

  it("rename moves the cache and emits rename with the old path", async () => {
    const app = createApp();
    const renames: Array<[string, string]> = [];
    app.vault.on("rename", (f, old) => renames.push([f.path, old]));
    const file = await writeNote(app, "a.md", { a: 1 });
    await app.vault.rename(file, "b.md");
    expect(renames).toEqual([["b.md", "a.md"]]);
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ a: 1 });
    expect(app.vault.getFileByPath("a.md")).toBeNull();
  });

  it("resolves wikilinks by path or basename", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Event X/Event X.md", { a: 1 });
    expect(app.metadataCache.getFirstLinkpathDest("Event X", "x.md")).toBe(file);
    expect(app.metadataCache.getFirstLinkpathDest("Social/Event X/Event X", "x.md")).toBe(file);
    expect(app.metadataCache.getFirstLinkpathDest("Missing", "x.md")).toBeNull();
  });

  it("validates secret ids like Obsidian", () => {
    const app = createApp();
    expect(() => app.secretStorage.setSecret("Bad Id", "x")).toThrow();
    app.secretStorage.setSecret("osmm-openai-key", "sk-test");
    expect(app.secretStorage.getSecret("osmm-openai-key")).toBe("sk-test");
    expect(app.secretStorage.listSecrets()).toEqual(["osmm-openai-key"]);
  });

  it("serves requestUrl fixtures and throws on error statuses", async () => {
    requestUrlMock.queue.push(() => ({ status: 200, headers: {}, json: { ok: true }, text: "{\"ok\":true}", arrayBuffer: new ArrayBuffer(0) }));
    expect((await requestUrl({ url: "https://example.com" })).json).toEqual({ ok: true });
    requestUrlMock.queue.push(() => ({ status: 429, headers: { "retry-after": "5" }, json: null, text: "", arrayBuffer: new ArrayBuffer(0) }));
    await expect(requestUrl({ url: "https://example.com" })).rejects.toMatchObject({ status: 429 });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/fakes/obsidian.test.ts`
Expected: FAIL. Cannot resolve `./obsidian` / `../helpers`.

- [ ] **Step 5: Write the fake**

`test/fakes/obsidian.ts`:
```ts
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
```

`test/helpers.ts`:
```ts
import { App, stringifyYaml, type TFile } from "obsidian";

export function createApp(): App {
  return new App();
}

/** Wait for queued timers (the fake emits metadata events on the next macrotask). */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeNote(
  app: App,
  path: string,
  frontmatter: Record<string, unknown> | null,
  body = "",
): Promise<TFile> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  const content = frontmatter ? `---\n${stringifyYaml(frontmatter)}---\n${body}` : body;
  const existing = app.vault.getFileByPath(path);
  if (existing) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return app.vault.create(path, content);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/fakes/obsidian.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: add Vitest setup with in-memory Obsidian API fake (refs #4)"
```

---

### Task 3: Svelte 5 integration and mount helper (#3)

**Files:**
- Create: `svelte.config.js`, `src/ui/mount.ts`, `test/fixtures/Hello.svelte`, `test/ui/mount.test.ts`
- Modify: `esbuild.config.mjs` (add the Svelte plugin), `vitest.config.ts` (add the Svelte plugins), `package.json` (typecheck script)

**Interfaces:**
- Produces: `mountSvelte<P extends Record<string, unknown>>(target: HTMLElement, component: Component<P>, props: P, context?: Map<unknown, unknown>): Mounted`, where `Mounted = { destroy(): void }` (idempotent).

- [ ] **Step 1: Install Svelte tooling**

```bash
npm install --save-dev svelte@^5 esbuild-svelte@^0.9 @sveltejs/vite-plugin-svelte@^7 \
  @testing-library/svelte@^5 svelte-check@^4
```

- [ ] **Step 2: Write the failing test and fixture**

`test/fixtures/Hello.svelte`:
```svelte
<script lang="ts">
  import { getContext, onDestroy } from "svelte";

  let { name, onGone }: { name: string; onGone: () => void } = $props();
  const greeting = getContext<string | undefined>("greeting") ?? "Hello";
  onDestroy(onGone);
</script>

<p>{greeting}, {name}!</p>
```

`test/ui/mount.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { mountSvelte } from "../../src/ui/mount";
import Hello from "../fixtures/Hello.svelte";

describe("mountSvelte", () => {
  it("mounts with props and context, and unmounts exactly once", () => {
    const target = document.createElement("div");
    const onGone = vi.fn();
    const mounted = mountSvelte(target, Hello, { name: "Ada", onGone }, new Map([["greeting", "Hi"]]));
    expect(target.textContent).toContain("Hi, Ada!");
    mounted.destroy();
    mounted.destroy();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(target.textContent).toBe("");
  });
});
```

- [ ] **Step 3: Add the Svelte plugins to Vitest**

```ts
// vitest.config.ts (full file)
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { fileURLToPath } from "node:url";

process.env.TZ = "Europe/Berlin";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: { provider: "v8", include: ["src/**"] },
  },
});
```

`svelte.config.js`:
```js
export default {};
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/ui/mount.test.ts`
Expected: FAIL. Cannot resolve `../../src/ui/mount`.

- [ ] **Step 5: Implement the helper**

`src/ui/mount.ts`:
```ts
import { mount, unmount, type Component } from "svelte";

export interface Mounted {
  destroy(): void;
}

/** Mount a Svelte 5 component; `destroy()` is safe to call more than once (e.g. from onClose and onunload). */
export function mountSvelte<P extends Record<string, unknown>>(
  target: HTMLElement,
  component: Component<P>,
  props: P,
  context?: Map<unknown, unknown>,
): Mounted {
  const instance = mount(component, { target, props, context });
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      void unmount(instance);
    },
  };
}
```

- [ ] **Step 6: Add Svelte to the esbuild build and to typechecking**

In `esbuild.config.mjs`, add the import and the plugin (before `finalize`):
```js
import sveltePlugin from "esbuild-svelte";
// …
  plugins: [sveltePlugin({ compilerOptions: { css: "external" } }), finalize],
```

In `package.json`, replace the `typecheck` script:
```json
"typecheck": "svelte-check --tsconfig ./tsconfig.json --threshold error"
```

- [ ] **Step 7: Verify tests, typecheck and build**

Run: `npx vitest run && npm run typecheck && node esbuild.config.mjs production`
Expected: all tests pass; no type errors; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ui): integrate Svelte 5 with a mount helper (refs #3)"
```

---

### Task 4: CI and release workflows (#5, #6)

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/version-bump.mjs`

**Interfaces:**
- Produces: CI on every PR and on pushes to `main`. Pushing a tag `x.y.z` creates a pre-release with `main.js`, `manifest.json`, `styles.css` (installable with BRAT). `npm version <v>` keeps `manifest.json` and `versions.json` in sync.

- [ ] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage
      - run: node esbuild.config.mjs production
      - uses: actions/upload-artifact@v4
        if: github.event_name == 'pull_request'
        with:
          name: plugin-build
          path: |
            main.js
            manifest.json
            styles.css
```

- [ ] **Step 2: Write the release workflow**

`.github/workflows/release.yml`:
```yaml
name: Release
on:
  push:
    tags: ["*.*.*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - name: Tag must match manifest version
        run: test "$(node -p "require('./manifest.json').version")" = "$GITHUB_REF_NAME"
      - name: Create pre-release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" main.js manifest.json styles.css --title "$GITHUB_REF_NAME" --generate-notes --prerelease
```

- [ ] **Step 3: Write the version-bump script**

`scripts/version-bump.mjs`:
```js
import { readFileSync, writeFileSync } from "node:fs";

const target = process.env.npm_package_version;
if (!target) throw new Error("Run through `npm version <version>`");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = target;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
```

- [ ] **Step 4: Verify the bump locally, then revert**

Run: `npm version 0.1.1 --no-git-tag-version && grep '"version"' manifest.json && cat versions.json`
Expected: `"version": "0.1.1"`, and `versions.json` contains `"0.1.1": "1.11.4"`.
Then revert: `git checkout -- package.json package-lock.json manifest.json versions.json`

- [ ] **Step 5: Validate the workflow YAML**

Run: `npx --yes yaml-lint .github/workflows/*.yml`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ci: add CI and tag-based release workflows (refs #5, #6)"
```

---

### Task 5: Platforms and date handling (#11, part 1)

**Files:**
- Create: `src/model/platforms.ts`, `src/model/dates.ts`, `test/model/platforms.test.ts`, `test/model/dates.test.ts`

**Interfaces:**
- Produces (`platforms.ts`): `PLATFORMS` (readonly tuple), `type Platform`, `interface PlatformMeta { id; label; prefix; badge; threads }`, `PLATFORM_META: Record<Platform, PlatformMeta>`, `isPlatform(v: unknown): v is Platform`, `platformByPrefix(prefix: string): Platform | undefined`, `CHANNEL_ID_RE`, `channelPlatform(id: string): Platform | undefined`.
- Produces (`dates.ts`): `MINUTE`, `HOUR`, `DAY` (ms), `parseDateTime(value: unknown): number | null`, `formatDateTime(ms: number): string`, `startOfLocalDay(ms: number): number`, `addLocalDays(ms: number, days: number): number`.

- [ ] **Step 1: Write the failing tests**

`test/model/platforms.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META, channelPlatform, isPlatform, platformByPrefix } from "../../src/model/platforms";

describe("platforms", () => {
  it("has metadata with a unique prefix for every platform", () => {
    const prefixes = PLATFORMS.map((p) => PLATFORM_META[p].prefix);
    expect(new Set(prefixes).size).toBe(PLATFORMS.length);
    for (const p of PLATFORMS) expect(PLATFORM_META[p].id).toBe(p);
  });

  it("recognises platform ids", () => {
    expect(isPlatform("linkedin")).toBe(true);
    expect(isPlatform("myspace")).toBe(false);
    expect(platformByPrefix("wp")).toBe("wordpress");
  });

  it.each([
    ["li/acme-studio", "linkedin"],
    ["x/you", "x"],
    ["wp/eventx-berlin", "wordpress"],
    ["zz/acme", undefined],
    ["li/Acme", undefined],
    ["li/-acme", undefined],
    ["li/acme-", undefined],
    ["li/", undefined],
  ])("channelPlatform(%s) = %s", (id, expected) => {
    expect(channelPlatform(id)).toBe(expected);
  });
});
```

`test/model/dates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DAY, HOUR, addLocalDays, formatDateTime, parseDateTime, startOfLocalDay } from "../../src/model/dates";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("parseDateTime (Europe/Berlin)", () => {
  it.each([
    ["2026-10-08T17:30:00+02:00", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T15:30:00Z", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T17:30:00+0200", at(2026, 10, 8, 15, 30)],
    ["2026-10-08 17:30", at(2026, 10, 8, 15, 30)],
    ["2026-10-08T17:30", at(2026, 10, 8, 15, 30)],
    ["2026-12-08 17:30", at(2026, 12, 8, 16, 30)],
    ["2026-10-08", at(2026, 10, 7, 22, 0)],
    ["  2026-10-08 17:30  ", at(2026, 10, 8, 15, 30)],
  ])("parses %s", (input, expected) => {
    expect(parseDateTime(input)).toBe(expected);
  });

  it("accepts Date objects and epoch numbers", () => {
    expect(parseDateTime(new Date(at(2026, 10, 8)))).toBe(at(2026, 10, 8));
    expect(parseDateTime(at(2026, 10, 8))).toBe(at(2026, 10, 8));
  });

  it.each(["2026-02-30", "2026-10-08 25:00", "2026-10-08 12:61", "tomorrow", "", "2026/10/08"])(
    "rejects %s",
    (input) => {
      expect(parseDateTime(input)).toBeNull();
    },
  );

  it.each([null, undefined, {}, [], Number.NaN])("rejects %s", (input) => {
    expect(parseDateTime(input)).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("writes local time with the right offset for summer and winter", () => {
    expect(formatDateTime(at(2026, 10, 8, 15, 30))).toBe("2026-10-08T17:30:00+02:00");
    expect(formatDateTime(at(2026, 12, 8, 16, 30))).toBe("2026-12-08T17:30:00+01:00");
  });

  it("round-trips through parseDateTime", () => {
    for (const t of [at(2026, 3, 29, 1, 30), at(2026, 10, 25, 0, 30), at(2026, 10, 25, 1, 30), at(2027, 1, 1)]) {
      expect(parseDateTime(formatDateTime(t))).toBe(t);
    }
  });
});

describe("local day arithmetic across DST", () => {
  it("keeps wall-clock time when adding a day over the October change", () => {
    const sat = parseDateTime("2026-10-24 09:00")!;
    const sun = addLocalDays(sat, 1);
    expect(formatDateTime(sun)).toBe("2026-10-25T09:00:00+01:00");
    expect(sun - sat).toBe(DAY + HOUR);
  });

  it("finds the start of the local day", () => {
    expect(formatDateTime(startOfLocalDay(parseDateTime("2026-10-25 18:45")!))).toBe("2026-10-25T00:00:00+02:00");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement `platforms.ts`**

```ts
export const PLATFORMS = [
  "linkedin",
  "x",
  "instagram",
  "facebook",
  "mastodon",
  "bluesky",
  "telegram",
  "discord",
  "hackernews",
  "indiehackers",
  "reddit",
  "whatsapp",
  "wordpress",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export interface PlatformMeta {
  readonly id: Platform;
  readonly label: string;
  /** Channel-id prefix, e.g. "li" in "li/acme-studio". */
  readonly prefix: string;
  /** Short text shown in badges. */
  readonly badge: string;
  /** Whether `---` in the body splits the post into a thread. */
  readonly threads: boolean;
}

export const PLATFORM_META: Readonly<Record<Platform, PlatformMeta>> = {
  linkedin: { id: "linkedin", label: "LinkedIn", prefix: "li", badge: "in", threads: false },
  x: { id: "x", label: "X", prefix: "x", badge: "X", threads: true },
  instagram: { id: "instagram", label: "Instagram", prefix: "ig", badge: "IG", threads: false },
  facebook: { id: "facebook", label: "Facebook", prefix: "fb", badge: "f", threads: false },
  mastodon: { id: "mastodon", label: "Mastodon", prefix: "ma", badge: "M", threads: true },
  bluesky: { id: "bluesky", label: "Bluesky", prefix: "bs", badge: "bs", threads: true },
  telegram: { id: "telegram", label: "Telegram", prefix: "tg", badge: "tg", threads: false },
  discord: { id: "discord", label: "Discord", prefix: "dc", badge: "dc", threads: false },
  hackernews: { id: "hackernews", label: "Hacker News", prefix: "hn", badge: "Y", threads: false },
  indiehackers: { id: "indiehackers", label: "Indie Hackers", prefix: "ih", badge: "IH", threads: false },
  reddit: { id: "reddit", label: "Reddit", prefix: "rd", badge: "r/", threads: false },
  whatsapp: { id: "whatsapp", label: "WhatsApp", prefix: "wa", badge: "wa", threads: false },
  wordpress: { id: "wordpress", label: "WordPress", prefix: "wp", badge: "WP", threads: false },
};

const BY_PREFIX = new Map(PLATFORMS.map((p) => [PLATFORM_META[p].prefix, p] as const));

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export function platformByPrefix(prefix: string): Platform | undefined {
  return BY_PREFIX.get(prefix);
}

export const CHANNEL_ID_RE = /^([a-z]{1,2})\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;

export function channelPlatform(id: string): Platform | undefined {
  const m = CHANNEL_ID_RE.exec(id);
  return m ? platformByPrefix(m[1] ?? "") : undefined;
}
```

- [ ] **Step 4: Implement `dates.ts`**

```ts
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parse a frontmatter date-time. Values without an offset are local time. Returns epoch ms or null. */
export function parseDateTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();

  if (ZONED_RE.test(s)) {
    const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(t) ? null : t;
  }

  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const se = Number(m[6] ?? 0);
  if (h > 23 || mi > 59 || se > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, se);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Format epoch ms as local ISO with offset, e.g. 2026-10-08T17:30:00+02:00. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Add calendar days keeping the wall-clock time (DST-safe). */
export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ).getTime();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/model`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(model): add platform metadata and DST-safe date parsing (refs #11)"
```

---

### Task 6: Schemas and domain types (#11, part 2)

**Files:**
- Create: `src/model/schemas.ts`, `src/model/types.ts`, `test/model/schemas.test.ts`

**Interfaces:**
- Consumes: `PLATFORMS`, `PLATFORM_META`, `CHANNEL_ID_RE` from Task 5.
- Produces (`schemas.ts`): constant tuples `DELIVERY_STATUSES`, `VARIANT_STATUSES`, `CHANNEL_KINDS`, `PUBLISH_METHODS`, `POST_MODES`; zod schemas `zPlatform, zChannelId, zDeliveryStatus, zVariantStatus, zMinutes, zMinutesList, zCount, zTimeOfDay, zUrl, zHexColor, zSecretId, zChannel, zChannelGroup`; `zodIssues(error, prefix?): Issue[]`.
- Produces (`types.ts`): `DeliveryStatus, VariantStatus, ChannelKind, PublishMethod, PostMode, Issue, Delivery, Campaign, WordPressFields, Variant, Parsed<T>, Channel, ChannelGroup`.

- [ ] **Step 1: Install zod**

```bash
npm install zod@^4
```

- [ ] **Step 2: Write the failing tests**

`test/model/schemas.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { zChannel, zChannelGroup, zMinutesList, zodIssues } from "../../src/model/schemas";

const channel = {
  id: "li/acme-studio",
  platform: "linkedin",
  name: "Acme Studio",
  kind: "page",
  avatarColor: "#6ea3e6",
  method: "assisted",
};

describe("zChannel", () => {
  it("accepts a valid channel", () => {
    expect(zChannel.safeParse(channel).success).toBe(true);
    expect(zChannel.safeParse({ ...channel, secretId: "osmm-channel-li-acme-studio", defaultTime: "09:00", defaultReminders: [60, 10] }).success).toBe(true);
  });

  it("requires the id prefix to match the platform", () => {
    const r = zChannel.safeParse({ ...channel, id: "fb/acme-studio" });
    expect(r.success).toBe(false);
    expect(zodIssues(r.error!)).toEqual([
      { level: "error", field: "id", message: 'Channel id must start with "li/" for LinkedIn' },
    ]);
  });

  it.each([
    [{ name: "  " }, "name"],
    [{ id: "li/Acme" }, "id"],
    [{ avatarColor: "blue" }, "avatarColor"],
    [{ secretId: "Bad Secret" }, "secretId"],
    [{ defaultTime: "9:00" }, "defaultTime"],
    [{ kind: "shop" }, "kind"],
  ])("rejects %o on field %s", (patch, field) => {
    const r = zChannel.safeParse({ ...channel, ...patch });
    expect(r.success).toBe(false);
    expect(zodIssues(r.error!).map((i) => i.field)).toContain(field);
  });
});

describe("zChannelGroup", () => {
  it("accepts a group of channel ids", () => {
    expect(zChannelGroup.safeParse({ id: "all-linkedin-pages", name: "All LinkedIn pages", channelIds: ["li/acme-studio"] }).success).toBe(true);
  });
  it("rejects bad group ids", () => {
    expect(zChannelGroup.safeParse({ id: "All Pages", name: "x", channelIds: [] }).success).toBe(false);
  });
});

describe("zMinutesList", () => {
  it("coerces numeric strings", () => {
    expect(zMinutesList.parse(["60", 10])).toEqual([60, 10]);
  });
  it("rejects negatives", () => {
    expect(zMinutesList.safeParse([-5]).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/model/schemas.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 4: Implement `schemas.ts`**

```ts
import { z } from "zod";
import { CHANNEL_ID_RE, PLATFORMS, PLATFORM_META } from "./platforms";
import type { Issue } from "./types";

export const DELIVERY_STATUSES = [
  "draft",
  "ready",
  "scheduled",
  "handed_over",
  "publishing",
  "published",
  "failed",
  "awaiting_you",
  "skipped",
  "overdue",
  "check_needed",
] as const;

export const VARIANT_STATUSES = [
  "idea",
  "draft",
  "ready",
  "scheduled",
  "partial",
  "published",
  "overdue",
  "attention",
  "skipped",
] as const;

export const CHANNEL_KINDS = ["profile", "page", "group", "server_channel", "site", "account"] as const;
export const PUBLISH_METHODS = ["api", "native", "assisted"] as const;
export const POST_MODES = ["auto", "assisted"] as const;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const zPlatform = z.enum(PLATFORMS);
export const zChannelId = z.string().regex(CHANNEL_ID_RE, 'Channel id must look like "li/acme-studio"');
export const zDeliveryStatus = z.enum(DELIVERY_STATUSES);
export const zVariantStatus = z.enum(VARIANT_STATUSES);
export const zMinutes = z.coerce.number().int().min(0).max(60 * 24 * 14);
export const zMinutesList = z.array(zMinutes).max(10);
export const zCount = z.coerce.number().int().min(0);
export const zTimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
export const zUrl = z.url();
export const zHexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #6ea3e6");
export const zSecretId = z.string().regex(SLUG_RE, "Use lowercase letters, digits and dashes");

export const zChannel = z
  .object({
    id: zChannelId,
    platform: zPlatform,
    name: z.string().trim().min(1, "Name is required"),
    kind: z.enum(CHANNEL_KINDS),
    handle: z.string().optional(),
    avatarColor: zHexColor,
    method: z.enum(PUBLISH_METHODS),
    secretId: zSecretId.optional(),
    defaultTime: zTimeOfDay.optional(),
    defaultReminders: zMinutesList.optional(),
  })
  .superRefine((c, ctx) => {
    const meta = PLATFORM_META[c.platform];
    if (!c.id.startsWith(`${meta.prefix}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: `Channel id must start with "${meta.prefix}/" for ${meta.label}`,
      });
    }
  });

export const zChannelGroup = z.object({
  id: z.string().regex(SLUG_RE, "Use lowercase letters, digits and dashes"),
  name: z.string().trim().min(1, "Name is required"),
  channelIds: z.array(zChannelId),
});

export function zodIssues(error: z.ZodError, prefix = ""): Issue[] {
  return error.issues.map((i) => ({
    level: "error" as const,
    field: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    message: i.message,
  }));
}
```

- [ ] **Step 5: Implement `types.ts`**

```ts
import type { z } from "zod";
import type { Platform } from "./platforms";
import type {
  CHANNEL_KINDS,
  DELIVERY_STATUSES,
  POST_MODES,
  PUBLISH_METHODS,
  VARIANT_STATUSES,
  zChannel,
  zChannelGroup,
} from "./schemas";

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type VariantStatus = (typeof VARIANT_STATUSES)[number];
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type PublishMethod = (typeof PUBLISH_METHODS)[number];
export type PostMode = (typeof POST_MODES)[number];
export type Channel = z.infer<typeof zChannel>;
export type ChannelGroup = z.infer<typeof zChannelGroup>;

export interface Issue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export interface Delivery {
  status: DeliveryStatus;
  /** Explicit delivery time (epoch ms); otherwise derived from scheduledAt + stagger. */
  at?: number;
  url?: string;
  remoteId?: string;
  error?: string;
  attempts?: number;
}

export interface Campaign {
  path: string;
  title: string;
  anchorDate?: number;
  link?: string;
  status: "active" | "archived";
}

export interface WordPressFields {
  slug?: string;
  categories: string[];
  tags: string[];
  excerpt?: string;
  featuredImage?: string;
}

export interface Variant {
  path: string;
  platform: Platform;
  /** Link target of the `campaign` wikilink, e.g. "Event X". */
  campaignLink?: string;
  title?: string;
  url?: string;
  channels: string[];
  mode: PostMode;
  /** Status as stored in frontmatter (kept in sync by roll-up). */
  status: VariantStatus;
  scheduledAt?: number;
  staggerMinutes?: number;
  reminders?: number[];
  media: string[];
  deliveries: Record<string, Delivery>;
  wordpress?: WordPressFields;
}

export interface Parsed<T> {
  value: T | null;
  issues: Issue[];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/model/schemas.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(model): add zod schemas and domain types (refs #11)"
```

---

### Task 7: Tolerant frontmatter parser and serializer (#12)

**Files:**
- Create: `src/model/frontmatter.ts`, `test/model/frontmatter.test.ts`

**Interfaces:**
- Consumes: Task 5 (`parseDateTime`, `formatDateTime`, `channelPlatform`, `PLATFORM_META`) and Task 6 (schemas, types).
- Produces: `type SocialKind = "campaign" | "post"`; `isRecord(v): v is Record<string, unknown>`; `socialKind(fm: unknown): SocialKind | null`; `linkTarget(value: unknown): string | undefined`; `parseCampaign(fm, path): Parsed<Campaign>`; `parseVariant(fm, path): Parsed<Variant>`; `serializeDelivery(d): Record<string, unknown>`; `serializeDeliveries(ds): Record<string, unknown> | undefined` (undefined when empty); `type VariantPatch`; `variantFields(patch: VariantPatch): Record<string, unknown>` (a key mapped to `undefined` means "delete").

- [ ] **Step 1: Write the failing tests**

`test/model/frontmatter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  linkTarget,
  parseCampaign,
  parseVariant,
  serializeDeliveries,
  socialKind,
  variantFields,
} from "../../src/model/frontmatter";

const base = {
  type: "social-post",
  campaign: "[[Event X]]",
  platform: "linkedin",
  channels: ["li/me", "li/acme-studio"],
  mode: "auto",
  status: "scheduled",
  scheduled_at: "2026-10-08T17:30:00+02:00",
  stagger_minutes: 15,
  reminders: [60, 10],
  media: ["[[event-x-cover.png]]"],
  deliveries: {
    "li/me": { status: "published", at: "2026-10-08T17:30:00+02:00", url: "https://www.linkedin.com/feed/update/1", remote_id: 1 },
    "li/acme-studio": { status: "awaiting_you", at: "2026-10-08T17:45:00+02:00" },
  },
};

describe("socialKind and linkTarget", () => {
  it("detects social notes", () => {
    expect(socialKind({ type: "social-campaign" })).toBe("campaign");
    expect(socialKind({ type: "social-post" })).toBe("post");
    expect(socialKind({ type: "note" })).toBeNull();
    expect(socialKind(null)).toBeNull();
  });

  it.each([
    ["[[Event X]]", "Event X"],
    ["[[Event X|the event]]", "Event X"],
    ["[[Social/Event X/Event X#Brief]]", "Social/Event X/Event X"],
    ["Event X", "Event X"],
    ["", undefined],
    [42, undefined],
  ])("linkTarget(%s) = %s", (input, expected) => {
    expect(linkTarget(input)).toBe(expected);
  });
});

describe("parseVariant", () => {
  it("parses the spec example", () => {
    const { value, issues } = parseVariant(base, "Social/Event X/Event X – LinkedIn.md");
    expect(issues).toEqual([]);
    expect(value).toMatchObject({
      platform: "linkedin",
      campaignLink: "Event X",
      channels: ["li/me", "li/acme-studio"],
      mode: "auto",
      status: "scheduled",
      scheduledAt: Date.UTC(2026, 9, 8, 15, 30),
      staggerMinutes: 15,
      reminders: [60, 10],
      media: ["event-x-cover.png"],
    });
    expect(value?.deliveries["li/me"]).toEqual({
      status: "published",
      at: Date.UTC(2026, 9, 8, 15, 30),
      url: "https://www.linkedin.com/feed/update/1",
      remoteId: "1",
    });
  });

  it("coerces hand-written shapes (review focus 1)", () => {
    const { value, issues } = parseVariant(
      { type: "social-post", platform: "linkedin", channels: "li/me", reminders: "60", stagger_minutes: "5" },
      "a.md",
    );
    expect(issues).toEqual([]);
    expect(value?.channels).toEqual(["li/me"]);
    expect(value?.reminders).toEqual([60]);
    expect(value?.staggerMinutes).toBe(5);
    expect(value?.mode).toBe("auto");
    expect(value?.status).toBe("draft");
  });

  it("returns null with an error when the platform is missing or unknown", () => {
    expect(parseVariant({ type: "social-post" }, "a.md")).toEqual({
      value: null,
      issues: [{ level: "error", field: "platform", message: "platform is required" }],
    });
    expect(parseVariant({ type: "social-post", platform: "myspace" }, "a.md").value).toBeNull();
  });

  it("drops channels of another platform with a warning", () => {
    const { value, issues } = parseVariant({ ...base, channels: ["li/me", "x/you", "not a channel"] }, "a.md");
    expect(value?.channels).toEqual(["li/me"]);
    expect(issues.map((i) => i.level)).toEqual(["warning", "warning", "warning"]);
  });

  it("reports invalid dates as errors and keeps the rest", () => {
    const { value, issues } = parseVariant({ ...base, scheduled_at: "next friday" }, "a.md");
    expect(value?.scheduledAt).toBeUndefined();
    expect(issues).toContainEqual({ level: "error", field: "scheduled_at", message: '"next friday" is not a valid date/time' });
  });

  it("skips deliveries with unknown statuses and warns about unknown channels", () => {
    const { value, issues } = parseVariant(
      { ...base, deliveries: { "li/me": { status: "posted" }, "li/old-page": { status: "published" } } },
      "a.md",
    );
    expect(Object.keys(value?.deliveries ?? {})).toEqual(["li/old-page"]);
    expect(issues.map((i) => i.field)).toEqual(["deliveries.li/me.status", "deliveries.li/old-page"]);
  });

  it("reads WordPress fields", () => {
    const { value } = parseVariant(
      { type: "social-post", platform: "wordpress", channels: ["wp/eventx-berlin"], slug: "hosting-event-x", categories: "Community", tags: ["events", "buildinpublic"], featured_image: "[[cover.png]]" },
      "a.md",
    );
    expect(value?.wordpress).toEqual({ slug: "hosting-event-x", categories: ["Community"], tags: ["events", "buildinpublic"], excerpt: undefined, featuredImage: "cover.png" });
  });
});

describe("parseCampaign", () => {
  it("uses the title or falls back to the file name", () => {
    expect(parseCampaign({ type: "social-campaign", anchor_date: "2026-10-12 18:00" }, "Social/Event X/Event X.md").value).toEqual({
      path: "Social/Event X/Event X.md",
      title: "Event X",
      anchorDate: Date.UTC(2026, 9, 12, 16, 0),
      link: undefined,
      status: "active",
    });
  });

  it("warns about an invalid link but keeps the campaign", () => {
    const { value, issues } = parseCampaign({ type: "social-campaign", title: "X", link: "not a url" }, "x.md");
    expect(value?.link).toBeUndefined();
    expect(issues[0]?.level).toBe("warning");
  });
});

describe("serialization", () => {
  it("round-trips a variant through variantFields", () => {
    const first = parseVariant(base, "a.md").value!;
    const fm = { type: "social-post", platform: "linkedin", campaign: "[[Event X]]", ...variantFields(first) };
    expect(parseVariant(fm, "a.md").value).toEqual(first);
  });

  it("marks cleared fields as undefined so writers delete them", () => {
    expect(variantFields({ scheduledAt: undefined, deliveries: {} })).toEqual({ scheduled_at: undefined, deliveries: undefined });
  });

  it("serializes deliveries with snake_case keys and ISO dates", () => {
    expect(serializeDeliveries({ "li/me": { status: "published", at: Date.UTC(2026, 9, 8, 15, 30), remoteId: "9" } })).toEqual({
      "li/me": { status: "published", at: "2026-10-08T17:30:00+02:00", remote_id: "9" },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/frontmatter.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `frontmatter.ts`**

```ts
import { z } from "zod";
import { formatDateTime, parseDateTime } from "./dates";
import { PLATFORM_META, channelPlatform } from "./platforms";
import {
  POST_MODES,
  zChannelId,
  zCount,
  zDeliveryStatus,
  zMinutes,
  zMinutesList,
  zPlatform,
  zUrl,
  zVariantStatus,
} from "./schemas";
import type { Campaign, Delivery, Issue, Parsed, Variant } from "./types";

export type SocialKind = "campaign" | "post";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function socialKind(fm: unknown): SocialKind | null {
  if (!isRecord(fm)) return null;
  if (fm.type === "social-campaign") return "campaign";
  if (fm.type === "social-post") return "post";
  return null;
}

const WIKILINK_RE = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

/** "[[Event X|alias]]" → "Event X"; plain strings are returned trimmed. */
export function linkTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  const m = WIKILINK_RE.exec(s);
  const target = (m ? m[1] : s)?.trim();
  return target ? target : undefined;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function asList(value: unknown): unknown[] {
  if (isBlank(value)) return [];
  return Array.isArray(value) ? value : [value];
}

function take<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
  issues: Issue[],
  level: Issue["level"] = "error",
): T | undefined {
  if (isBlank(value)) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  issues.push({ level, field, message: r.error.issues[0]?.message ?? "Invalid value" });
  return undefined;
}

function takeDate(value: unknown, field: string, issues: Issue[]): number | undefined {
  if (isBlank(value)) return undefined;
  const t = parseDateTime(value);
  if (t === null) {
    issues.push({ level: "error", field, message: `"${String(value)}" is not a valid date/time` });
    return undefined;
  }
  return t;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] {
  return asList(value)
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function parseCampaign(fm: Record<string, unknown>, path: string): Parsed<Campaign> {
  const issues: Issue[] = [];
  const campaign: Campaign = {
    path,
    title: str(fm.title) ?? basename(path),
    anchorDate: takeDate(fm.anchor_date, "anchor_date", issues),
    link: take(zUrl, fm.link, "link", issues, "warning"),
    status: take(z.enum(["active", "archived"]), fm.status, "status", issues, "warning") ?? "active",
  };
  return { value: campaign, issues };
}

function parseDeliveries(raw: unknown, channels: string[], issues: Issue[]): Record<string, Delivery> {
  const deliveries: Record<string, Delivery> = {};
  if (isBlank(raw)) return deliveries;
  if (!isRecord(raw)) {
    issues.push({ level: "warning", field: "deliveries", message: "deliveries must be a map of channel id → delivery" });
    return deliveries;
  }
  for (const [id, value] of Object.entries(raw)) {
    const field = `deliveries.${id}`;
    if (!isRecord(value)) {
      issues.push({ level: "warning", field, message: "Delivery must be an object" });
      continue;
    }
    const status = take(zDeliveryStatus, value.status, `${field}.status`, issues, "warning");
    if (!status) continue;
    const d: Delivery = { status };
    const at = takeDate(value.at, `${field}.at`, issues);
    if (at !== undefined) d.at = at;
    if (typeof value.url === "string" && value.url) d.url = value.url;
    if (!isBlank(value.remote_id)) d.remoteId = String(value.remote_id);
    if (typeof value.error === "string" && value.error) d.error = value.error;
    const attempts = take(zCount, value.attempts, `${field}.attempts`, issues, "warning");
    if (attempts !== undefined) d.attempts = attempts;
    if (!channels.includes(id)) {
      issues.push({ level: "warning", field, message: `Delivery for ${id}, which is not in channels` });
    }
    deliveries[id] = d;
  }
  return deliveries;
}

export function parseVariant(fm: Record<string, unknown>, path: string): Parsed<Variant> {
  const issues: Issue[] = [];
  if (isBlank(fm.platform)) {
    return { value: null, issues: [{ level: "error", field: "platform", message: "platform is required" }] };
  }
  const platform = take(zPlatform, fm.platform, "platform", issues);
  if (!platform) return { value: null, issues };

  const channels: string[] = [];
  for (const raw of asList(fm.channels)) {
    const id = take(zChannelId, typeof raw === "string" ? raw.trim() : raw, "channels", issues, "warning");
    if (!id) continue;
    if (channelPlatform(id) !== platform) {
      issues.push({ level: "warning", field: "channels", message: `${id} is not a ${PLATFORM_META[platform].label} channel` });
      continue;
    }
    if (!channels.includes(id)) channels.push(id);
  }

  const variant: Variant = {
    path,
    platform,
    campaignLink: linkTarget(fm.campaign),
    title: str(fm.title),
    url: take(zUrl, fm.url, "url", issues, "warning"),
    channels,
    mode: take(z.enum(POST_MODES), fm.mode, "mode", issues, "warning") ?? "auto",
    status: take(zVariantStatus, fm.status, "status", issues, "warning") ?? "draft",
    scheduledAt: takeDate(fm.scheduled_at, "scheduled_at", issues),
    staggerMinutes: take(zMinutes, fm.stagger_minutes, "stagger_minutes", issues, "warning"),
    reminders: isBlank(fm.reminders)
      ? undefined
      : take(zMinutesList, asList(fm.reminders), "reminders", issues, "warning"),
    media: asList(fm.media)
      .map(linkTarget)
      .filter((m): m is string => m !== undefined),
    deliveries: parseDeliveries(fm.deliveries, channels, issues),
  };

  if (platform === "wordpress") {
    variant.wordpress = {
      slug: str(fm.slug),
      categories: strList(fm.categories),
      tags: strList(fm.tags),
      excerpt: str(fm.excerpt),
      featuredImage: linkTarget(fm.featured_image),
    };
  }

  return { value: variant, issues };
}

export function serializeDelivery(d: Delivery): Record<string, unknown> {
  const out: Record<string, unknown> = { status: d.status };
  if (d.at !== undefined) out.at = formatDateTime(d.at);
  if (d.url) out.url = d.url;
  if (d.remoteId) out.remote_id = d.remoteId;
  if (d.error) out.error = d.error;
  if (d.attempts !== undefined) out.attempts = d.attempts;
  return out;
}

export function serializeDeliveries(ds: Record<string, Delivery>): Record<string, unknown> | undefined {
  const entries = Object.entries(ds);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([id, d]) => [id, serializeDelivery(d)]));
}

export type VariantPatch = Partial<
  Pick<
    Variant,
    "channels" | "mode" | "status" | "scheduledAt" | "staggerMinutes" | "reminders" | "media" | "title" | "url" | "deliveries"
  >
>;

/** Map a camelCase patch to frontmatter keys. A key mapped to `undefined` means "delete this key". */
export function variantFields(patch: VariantPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("channels" in patch) out.channels = patch.channels;
  if ("mode" in patch) out.mode = patch.mode;
  if ("status" in patch) out.status = patch.status;
  if ("scheduledAt" in patch) out.scheduled_at = patch.scheduledAt === undefined ? undefined : formatDateTime(patch.scheduledAt);
  if ("staggerMinutes" in patch) out.stagger_minutes = patch.staggerMinutes;
  if ("reminders" in patch) out.reminders = patch.reminders;
  if ("media" in patch) out.media = patch.media?.map((m) => `[[${m}]]`);
  if ("title" in patch) out.title = patch.title;
  if ("url" in patch) out.url = patch.url;
  if ("deliveries" in patch) out.deliveries = patch.deliveries ? serializeDeliveries(patch.deliveries) : undefined;
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/model/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): add tolerant frontmatter parsing and serialization (refs #12)"
```

---

### Task 8: Delivery state machine, roll-up and stagger (#13)

**Files:**
- Create: `src/model/stateMachine.ts`, `test/model/stateMachine.test.ts`

**Interfaces:**
- Consumes: `Delivery`, `DeliveryStatus`, `Variant`, `VariantStatus` (Task 6).
- Produces: `TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>>`; `class IllegalTransitionError extends Error { from; to }`; `canTransition(from, to): boolean`; `transition(d: Delivery, to: DeliveryStatus, patch?: Partial<Omit<Delivery, "status">>): Delivery`; `rollupStatus(v: Pick<Variant, "status" | "channels" | "deliveries">): VariantStatus`; `deliveryTime(v: Pick<Variant, "scheduledAt" | "channels" | "staggerMinutes" | "deliveries">, channelId: string, defaultStagger: number): number | undefined`.

- [ ] **Step 1: Write the failing tests**

`test/model/stateMachine.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DELIVERY_STATUSES } from "../../src/model/schemas";
import {
  IllegalTransitionError,
  canTransition,
  deliveryTime,
  rollupStatus,
  transition,
} from "../../src/model/stateMachine";
import type { Delivery, DeliveryStatus } from "../../src/model/types";

describe("delivery transitions (spec §5)", () => {
  it.each<[DeliveryStatus, DeliveryStatus]>([
    ["draft", "ready"],
    ["ready", "scheduled"],
    ["scheduled", "handed_over"],
    ["scheduled", "publishing"],
    ["scheduled", "awaiting_you"],
    ["scheduled", "overdue"],
    ["handed_over", "published"],
    ["publishing", "published"],
    ["publishing", "failed"],
    ["publishing", "check_needed"],
    ["awaiting_you", "published"],
    ["awaiting_you", "skipped"],
    ["overdue", "publishing"],
    ["overdue", "scheduled"],
    ["failed", "publishing"],
    ["check_needed", "published"],
  ])("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition({ status: from }, to).status).toBe(to);
  });

  it.each<[DeliveryStatus, DeliveryStatus]>([
    ["draft", "published"],
    ["publishing", "scheduled"],
    ["publishing", "publishing"],
    ["check_needed", "publishing"],
    ["handed_over", "publishing"],
  ])("refuses %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition({ status: from }, to)).toThrow(IllegalTransitionError);
  });

  it("never leaves published", () => {
    for (const to of DELIVERY_STATUSES) expect(canTransition("published", to)).toBe(false);
  });

  it("keeps existing fields and applies the patch", () => {
    const d: Delivery = { status: "scheduled", at: 1000, attempts: 1 };
    expect(transition(d, "published", { url: "https://x.com/1", remoteId: "1" })).toEqual({
      status: "published",
      at: 1000,
      attempts: 1,
      url: "https://x.com/1",
      remoteId: "1",
    });
  });
});

describe("rollupStatus", () => {
  const v = (status: string[], stored = "draft") => ({
    status: stored as never,
    channels: status.map((_, i) => `li/c${i}`),
    deliveries: Object.fromEntries(status.map((s, i) => [`li/c${i}`, { status: s as DeliveryStatus }])),
  });

  it.each([
    [[], "idea", "idea"],
    [[], "ready", "ready"],
    [["failed", "published"], "draft", "attention"],
    [["check_needed"], "draft", "attention"],
    [["overdue", "scheduled"], "draft", "overdue"],
    [["published", "published"], "draft", "published"],
    [["published", "skipped"], "draft", "published"],
    [["skipped", "skipped"], "draft", "skipped"],
    [["published", "scheduled"], "draft", "partial"],
    [["scheduled", "awaiting_you"], "draft", "scheduled"],
    [["handed_over"], "draft", "scheduled"],
    [["ready", "ready"], "draft", "ready"],
    [["ready", "draft"], "draft", "draft"],
    [["draft"], "idea", "idea"],
  ])("%j (stored %s) → %s", (statuses, stored, expected) => {
    expect(rollupStatus(v(statuses, stored))).toBe(expected);
  });

  it("treats channels without a delivery as draft", () => {
    expect(rollupStatus({ status: "draft", channels: ["li/a", "li/b"], deliveries: { "li/a": { status: "published" } } })).toBe("partial");
  });
});

describe("deliveryTime", () => {
  const variant = { scheduledAt: 1_000_000, channels: ["li/a", "li/b", "li/c"], staggerMinutes: 15, deliveries: {} as Record<string, Delivery> };

  it("staggers channels by their index", () => {
    expect(deliveryTime(variant, "li/a", 5)).toBe(1_000_000);
    expect(deliveryTime(variant, "li/c", 5)).toBe(1_000_000 + 30 * 60_000);
  });

  it("uses the default stagger when none is set", () => {
    expect(deliveryTime({ ...variant, staggerMinutes: undefined }, "li/b", 5)).toBe(1_000_000 + 5 * 60_000);
  });

  it("prefers an explicit delivery time", () => {
    expect(deliveryTime({ ...variant, deliveries: { "li/b": { status: "scheduled", at: 42 } } }, "li/b", 5)).toBe(42);
  });

  it("is undefined without a schedule", () => {
    expect(deliveryTime({ ...variant, scheduledAt: undefined }, "li/a", 5)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/stateMachine.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `stateMachine.ts`**

```ts
import { MINUTE } from "./dates";
import type { Delivery, DeliveryStatus, Variant, VariantStatus } from "./types";

/** Allowed delivery transitions (spec §5). `publishing` and `check_needed` never go back to a retryable state automatically. */
export const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  draft: ["ready", "scheduled", "skipped"],
  ready: ["draft", "scheduled", "skipped"],
  scheduled: ["draft", "ready", "handed_over", "publishing", "awaiting_you", "overdue", "skipped"],
  handed_over: ["published", "failed", "scheduled", "check_needed"],
  publishing: ["published", "failed", "check_needed"],
  awaiting_you: ["published", "skipped", "scheduled", "overdue"],
  overdue: ["publishing", "awaiting_you", "scheduled", "skipped", "published"],
  failed: ["scheduled", "publishing", "skipped", "ready"],
  check_needed: ["published", "failed", "scheduled", "skipped"],
  published: [],
  skipped: ["ready", "scheduled"],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`Illegal delivery transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(
  d: Delivery,
  to: DeliveryStatus,
  patch: Partial<Omit<Delivery, "status">> = {},
): Delivery {
  if (!canTransition(d.status, to)) throw new IllegalTransitionError(d.status, to);
  return { ...d, ...patch, status: to };
}

const PENDING = new Set<DeliveryStatus>(["scheduled", "handed_over", "publishing", "awaiting_you"]);

export function rollupStatus(v: Pick<Variant, "status" | "channels" | "deliveries">): VariantStatus {
  // No delivery records yet: nothing to roll up, keep what the user wrote.
  if (!v.channels.some((c) => v.deliveries[c] !== undefined)) return v.status;
  const statuses = v.channels.map((c) => v.deliveries[c]?.status ?? "draft");
  if (statuses.some((s) => s === "failed" || s === "check_needed")) return "attention";
  if (statuses.some((s) => s === "overdue")) return "overdue";
  const published = statuses.filter((s) => s === "published").length;
  const skipped = statuses.filter((s) => s === "skipped").length;
  if (published + skipped === statuses.length) return published > 0 ? "published" : "skipped";
  if (published > 0) return "partial";
  if (statuses.some((s) => PENDING.has(s))) return "scheduled";
  if (statuses.every((s) => s === "ready")) return "ready";
  return v.status === "idea" ? "idea" : "draft";
}

export function deliveryTime(
  v: Pick<Variant, "scheduledAt" | "channels" | "staggerMinutes" | "deliveries">,
  channelId: string,
  defaultStagger: number,
): number | undefined {
  const explicit = v.deliveries[channelId]?.at;
  if (explicit !== undefined) return explicit;
  if (v.scheduledAt === undefined) return undefined;
  const index = Math.max(0, v.channels.indexOf(channelId));
  return v.scheduledAt + index * (v.staggerMinutes ?? defaultStagger) * MINUTE;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/model/stateMachine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): add delivery state machine, status roll-up and stagger (refs #13)"
```

---

### Task 9: Body parsing — threads, embeds, excerpt, character counts (#14)

**Files:**
- Create: `src/model/body.ts`, `test/model/body.test.ts`

**Interfaces:**
- Produces: `bodyOf(content: string): string`; `splitThread(body: string): string[]`; `extractEmbeds(body: string): string[]`; `plainText(markdown: string): string`; `excerpt(body: string, max?: number): string`; `type CharCounter = "graphemes" | "x-weighted"`; `countChars(text: string, counter?: CharCounter): number`.

- [ ] **Step 1: Write the failing tests**

`test/model/body.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bodyOf, countChars, excerpt, extractEmbeds, plainText, splitThread } from "../../src/model/body";

describe("bodyOf", () => {
  it("strips frontmatter", () => {
    expect(bodyOf("---\na: 1\n---\nHello\n")).toBe("Hello\n");
    expect(bodyOf("Hello")).toBe("Hello");
  });
});

describe("splitThread", () => {
  it("splits on body-level --- lines", () => {
    expect(splitThread("One\n---\nTwo\n\n---\n\nThree\n")).toEqual(["One", "Two", "Three"]);
  });

  it("ignores --- inside code fences", () => {
    const body = "Intro\n```yaml\n---\nkey: 1\n```\n---\nSecond";
    expect(splitThread(body)).toEqual(["Intro\n```yaml\n---\nkey: 1\n```", "Second"]);
  });

  it("drops empty items and keeps a single post intact", () => {
    expect(splitThread("---\nOnly\n---\n")).toEqual(["Only"]);
    expect(splitThread("Just one post")).toEqual(["Just one post"]);
  });
});

describe("extractEmbeds", () => {
  it("collects wikilink and markdown image embeds in order, deduplicated", () => {
    const body = "![[cover.png]]\ntext ![alt](img/local.jpg) ![[cover.png|300]] ![remote](https://x.com/a.png) ![[b.webp]]";
    expect(extractEmbeds(body)).toEqual(["cover.png", "img/local.jpg", "b.webp"]);
  });
});

describe("plainText and excerpt", () => {
  it("resolves links to readable text", () => {
    expect(plainText("See [[Event X|the event]], [[Notes/Plan]] and [site](https://a.b)\n![[x.png]]")).toBe(
      "See the event, Plan and site\n",
    );
  });

  it("uses the first meaningful line, trimmed to max", () => {
    expect(excerpt("\n# I almost didn't host Event X.\n\nMore")).toBe("I almost didn't host Event X.");
    expect(excerpt("- a list item")).toBe("a list item");
    expect(excerpt("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(excerpt("")).toBe("");
  });
});

describe("countChars", () => {
  it.each([
    ["hello", 5, 5],
    ["日本", 2, 4],
    ["👍🏽", 1, 2],
    ["é", 1, 1],
    ["Visit https://example.com/a/very/long/path now", 46, 33],
  ])("%s → graphemes %i, x-weighted %i", (text, graphemes, weighted) => {
    expect(countChars(text)).toBe(graphemes);
    expect(countChars(text, "x-weighted")).toBe(weighted);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/body.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `body.ts`**

```ts
import { getFrontMatterInfo } from "obsidian";

export function bodyOf(content: string): string {
  const info = getFrontMatterInfo(content);
  return info.exists ? content.slice(info.contentStart) : content;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Split a post body into thread items on lines that are exactly `---`, outside code fences. */
export function splitThread(body: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const ch = f[1]?.[0] ?? "`";
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
      current.push(line);
      continue;
    }
    if (fence === null && line.trim() === "---") {
      items.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  items.push(current.join("\n"));
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

const WIKI_EMBED_RE = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const MD_EMBED_RE = /!\[[^\]]*\]\((?!https?:)([^)\s]+)\)/g;

export function extractEmbeds(body: string): string[] {
  const found: Array<{ index: number; target: string }> = [];
  for (const m of body.matchAll(WIKI_EMBED_RE)) found.push({ index: m.index ?? 0, target: (m[1] ?? "").trim() });
  for (const m of body.matchAll(MD_EMBED_RE)) found.push({ index: m.index ?? 0, target: (m[1] ?? "").trim() });
  found.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  for (const { target } of found) if (target && !out.includes(target)) out.push(target);
  return out;
}

/** Markdown → readable text: drops embeds, resolves wikilinks/markdown links to their label. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => (target.split("#")[0] ?? target).split("/").pop() ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

export function excerpt(body: string, max = 120): string {
  const line = plainText(body)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim())
    .find((l) => l.length > 0 && !FENCE_RE.test(l));
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type CharCounter = "graphemes" | "x-weighted";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const URL_RE = /\bhttps?:\/\/[^\s]+/gi;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/** X counts most Latin text as 1 and CJK/emoji as 2 (twitter-text v3 ranges). */
function xWeight(grapheme: string): number {
  if (PICTOGRAPHIC_RE.test(grapheme)) return 2;
  const cp = grapheme.codePointAt(0) ?? 0;
  const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
  return light ? 1 : 2;
}

export function countChars(text: string, counter: CharCounter = "graphemes"): number {
  if (counter === "graphemes") return [...segmenter.segment(text)].length;
  let total = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    total += 23;
    return "";
  });
  for (const { segment } of segmenter.segment(withoutUrls)) total += xWeight(segment);
  return total;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/model/body.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): add body parsing for threads, embeds, excerpts and char counts (refs #14)"
```

---

### Task 10: SafeWriter — serialized frontmatter writes (#15)

**Files:**
- Create: `src/model/writer.ts`, `test/model/writer.test.ts`

**Interfaces:**
- Consumes: `parseVariant`, `serializeDeliveries`, `variantFields`, `VariantPatch` (Task 7); `transition`, `rollupStatus` (Task 8).
- Produces: `class SafeWriter { constructor(app: App); run<T>(file: TFile, fn: (fm: Record<string, unknown>) => T): Promise<T>; setFields(file, fields: Record<string, unknown>): Promise<void>; patchVariant(file, patch: VariantPatch): Promise<void>; updateDeliveries(file, patch: Record<string, Delivery | null>): Promise<void>; transitionDelivery(file, channelId: string, to: DeliveryStatus, patch?: Partial<Omit<Delivery,"status">>): Promise<Delivery> }`. Writes to the same `TFile` object run in order even across renames. `patchVariant`, `updateDeliveries` and `transitionDelivery` also recompute the stored `status` by roll-up.

- [ ] **Step 1: Write the failing tests**

`test/model/writer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseYaml, getFrontMatterInfo } from "obsidian";
import { SafeWriter } from "../../src/model/writer";
import { IllegalTransitionError } from "../../src/model/stateMachine";
import { createApp, writeNote } from "../helpers";
import type { App, TFile } from "obsidian";

async function fmOf(app: App, file: TFile): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await app.vault.read(file)).frontmatter);
}

const post = { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme-studio"], status: "draft" };

describe("SafeWriter", () => {
  it("sets and deletes fields, keeping the body", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, title: "Old" }, "Body\n");
    await new SafeWriter(app).setFields(file, { title: undefined, url: "https://a.b" });
    const fm = await fmOf(app, file);
    expect(fm.title).toBeUndefined();
    expect(fm.url).toBe("https://a.b");
    expect((await app.vault.read(file)).endsWith("Body\n")).toBe(true);
  });

  it("serializes concurrent writes so none are lost", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    const writer = new SafeWriter(app);
    await Promise.all(Array.from({ length: 10 }, (_, i) => writer.setFields(file, { [`k${i}`]: i })));
    const fm = await fmOf(app, file);
    for (let i = 0; i < 10; i++) expect(fm[`k${i}`]).toBe(i);
  });

  it("keeps queued writes on a file renamed mid-queue (review focus 3)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    const writer = new SafeWriter(app);
    const first = writer.setFields(file, { a: 1 });
    await app.vault.rename(file, "renamed.md");
    const second = writer.setFields(file, { b: 2 });
    await Promise.all([first, second]);
    const fm = await fmOf(app, app.vault.getFileByPath("renamed.md")!);
    expect(fm).toMatchObject({ a: 1, b: 2 });
  });

  it("updates deliveries and rolls up the status", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    await new SafeWriter(app).updateDeliveries(file, {
      "li/me": { status: "published", url: "https://www.linkedin.com/feed/update/1" },
      "li/acme-studio": { status: "scheduled", at: Date.UTC(2026, 9, 8, 15, 45) },
    });
    const fm = await fmOf(app, file);
    expect(fm.status).toBe("partial");
    expect(fm.deliveries).toEqual({
      "li/me": { status: "published", url: "https://www.linkedin.com/feed/update/1" },
      "li/acme-studio": { status: "scheduled", at: "2026-10-08T17:45:00+02:00" },
    });
  });

  it("patches variant fields with frontmatter key names", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    await new SafeWriter(app).patchVariant(file, { scheduledAt: Date.UTC(2026, 9, 8, 15, 30), staggerMinutes: 10 });
    expect(await fmOf(app, file)).toMatchObject({ scheduled_at: "2026-10-08T17:30:00+02:00", stagger_minutes: 10 });
  });

  it("transitions a delivery and refuses illegal moves without writing", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "scheduled" } } });
    const writer = new SafeWriter(app);
    const next = await writer.transitionDelivery(file, "li/me", "publishing");
    expect(next.status).toBe("publishing");
    const before = await app.vault.read(file);
    await expect(writer.transitionDelivery(file, "li/me", "scheduled")).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await app.vault.read(file)).toBe(before);
  });

  it("removes a delivery when patched with null", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "draft" } } });
    await new SafeWriter(app).updateDeliveries(file, { "li/me": null });
    expect((await fmOf(app, file)).deliveries).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/writer.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `writer.ts`**

```ts
import type { App, TFile } from "obsidian";
import { parseVariant, serializeDeliveries, variantFields, type VariantPatch } from "./frontmatter";
import { rollupStatus, transition } from "./stateMachine";
import type { Delivery, DeliveryStatus, Variant } from "./types";

type Frontmatter = Record<string, unknown>;

function applyFields(fm: Frontmatter, fields: Frontmatter): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete fm[key];
    else fm[key] = value;
  }
}

function requireVariant(fm: Frontmatter, path: string): Variant {
  const parsed = parseVariant(fm, path).value;
  if (!parsed) throw new Error(`${path} is not a valid social post`);
  return parsed;
}

/**
 * The single entry point for mutating frontmatter of existing notes.
 * Writes to the same TFile are applied one after another (keyed by object identity, so renames are safe).
 */
export class SafeWriter {
  private readonly queues = new WeakMap<TFile, Promise<unknown>>();

  constructor(private readonly app: App) {}

  run<T>(file: TFile, fn: (fm: Frontmatter) => T): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    let result!: T;
    const next = previous
      .catch(() => undefined)
      .then(() =>
        this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => {
          result = fn(fm);
        }),
      )
      .then(() => result);
    this.queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  }

  setFields(file: TFile, fields: Frontmatter): Promise<void> {
    return this.run(file, (fm) => applyFields(fm, fields));
  }

  patchVariant(file: TFile, patch: VariantPatch): Promise<void> {
    return this.run(file, (fm) => {
      applyFields(fm, variantFields(patch));
      const v = requireVariant(fm, file.path);
      fm.status = rollupStatus(v);
    });
  }

  updateDeliveries(file: TFile, patch: Record<string, Delivery | null>): Promise<void> {
    return this.run(file, (fm) => {
      const v = requireVariant(fm, file.path);
      const deliveries = { ...v.deliveries };
      for (const [id, d] of Object.entries(patch)) {
        if (d === null) delete deliveries[id];
        else deliveries[id] = d;
      }
      applyFields(fm, { deliveries: serializeDeliveries(deliveries), status: rollupStatus({ ...v, deliveries }) });
    });
  }

  transitionDelivery(
    file: TFile,
    channelId: string,
    to: DeliveryStatus,
    patch: Partial<Omit<Delivery, "status">> = {},
  ): Promise<Delivery> {
    return this.run(file, (fm) => {
      const v = requireVariant(fm, file.path);
      const next = transition(v.deliveries[channelId] ?? { status: "draft" }, to, patch);
      const deliveries = { ...v.deliveries, [channelId]: next };
      applyFields(fm, { deliveries: serializeDeliveries(deliveries), status: rollupStatus({ ...v, deliveries }) });
      return next;
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/model/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): add SafeWriter for serialized frontmatter updates (refs #15)"
```

---

### Task 11: NoteFactory — create campaign, create variant, fork variant (#16)

**Files:**
- Create: `src/model/factory.ts`, `test/model/factory.test.ts`

**Interfaces:**
- Consumes: `SafeWriter` (Task 10); `parseVariant`, `serializeDelivery`, `serializeDeliveries` (Task 7); `rollupStatus` (Task 8); `formatDateTime` (Task 5); `PLATFORM_META`, `Platform` (Task 5).
- Produces: `safeFileName(name: string): string`; `class NoteFactory { constructor(app: App, writer: SafeWriter, opts: { rootFolder(): string }); createCampaign(input: { title: string; anchorDate?: number; link?: string }): Promise<TFile>; createVariant(input: { platform: Platform; campaign?: TFile; title?: string; channels?: string[]; body?: string; scheduledAt?: number }): Promise<TFile>; forkVariant(file: TFile, channelId: string, channelName: string): Promise<TFile> }`.
- Paths: campaign `<root>/<Title>/<Title>.md`; variant `<campaign folder>/<Campaign> – <Platform label>.md`; standalone `<root>/Posts/<Title>.md`; fork `<same folder>/<basename> – <Channel name>.md`. On a collision, ` 2`, ` 3`, … is appended.

- [ ] **Step 1: Write the failing tests**

`test/model/factory.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml, type App, type TFile } from "obsidian";
import { NoteFactory, safeFileName } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { createApp, writeNote } from "../helpers";

async function fmOf(app: App, file: TFile): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await app.vault.read(file)).frontmatter);
}

function setup() {
  const app = createApp();
  const factory = new NoteFactory(app, new SafeWriter(app), { rootFolder: () => "Social" });
  return { app, factory };
}

describe("safeFileName (review focus 5)", () => {
  it.each([
    ["Event X", "Event X"],
    ["Q&A: what/why?", "Q&A what why"],
    ["#launch [beta] ^1", "launch beta 1"],
    ["...hidden", "hidden"],
    ["   ", "Untitled"],
    ["x".repeat(200), "x".repeat(120)],
  ])("%s → %s", (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});

describe("NoteFactory", () => {
  it("creates a campaign note with the variants block", async () => {
    const { app, factory } = setup();
    const file = await factory.createCampaign({ title: "Event X", anchorDate: Date.UTC(2026, 9, 12, 16), link: "https://example.com/event-x" });
    expect(file.path).toBe("Social/Event X/Event X.md");
    expect(await fmOf(app, file)).toEqual({
      type: "social-campaign",
      title: "Event X",
      status: "active",
      anchor_date: "2026-10-12T18:00:00+02:00",
      link: "https://example.com/event-x",
    });
    expect(await app.vault.read(file)).toContain("```social-variants\n```");
  });

  it("uses a safe, unique path for awkward or duplicate titles", async () => {
    const { factory } = setup();
    expect((await factory.createCampaign({ title: "Launch: v1/beta?" })).path).toBe("Social/Launch v1 beta/Launch v1 beta.md");
    expect((await factory.createCampaign({ title: "Launch: v1/beta?" })).path).toBe("Social/Launch v1 beta/Launch v1 beta 2.md");
  });

  it("rejects an empty campaign title", async () => {
    await expect(setup().factory.createCampaign({ title: " " })).rejects.toThrow(/title/);
  });

  it("creates a variant next to its campaign", async () => {
    const { app, factory } = setup();
    const campaign = await factory.createCampaign({ title: "Event X" });
    const file = await factory.createVariant({ campaign, platform: "linkedin", channels: ["li/me"], body: "Hello", scheduledAt: Date.UTC(2026, 9, 8, 15, 30) });
    expect(file.path).toBe("Social/Event X/Event X – LinkedIn.md");
    expect(await fmOf(app, file)).toEqual({
      type: "social-post",
      campaign: "[[Event X]]",
      platform: "linkedin",
      channels: ["li/me"],
      mode: "auto",
      status: "draft",
      scheduled_at: "2026-10-08T17:30:00+02:00",
    });
    expect(await app.vault.read(file)).toMatch(/---\nHello\n$/);
  });

  it("creates standalone posts under Posts/ and requires a title", async () => {
    const { factory } = setup();
    expect((await factory.createVariant({ platform: "x", title: "Launch day" })).path).toBe("Social/Posts/Launch day.md");
    await expect(factory.createVariant({ platform: "x" })).rejects.toThrow(/title/);
  });

  it("forks one channel into its own note", async () => {
    const { app, factory } = setup();
    const file = await writeNote(
      app,
      "Social/Event X/Event X – LinkedIn.md",
      {
        type: "social-post",
        platform: "linkedin",
        channels: ["li/me", "li/acme-studio"],
        status: "partial",
        deliveries: { "li/me": { status: "published" }, "li/acme-studio": { status: "scheduled" } },
      },
      "Shared text\n",
    );
    const fork = await factory.forkVariant(file, "li/acme-studio", "Acme Studio");
    expect(fork.path).toBe("Social/Event X/Event X – LinkedIn – Acme Studio.md");
    expect(await fmOf(app, fork)).toMatchObject({ channels: ["li/acme-studio"], deliveries: { "li/acme-studio": { status: "scheduled" } }, status: "scheduled" });
    expect(await app.vault.read(fork)).toMatch(/Shared text\n$/);
    expect(await fmOf(app, file)).toMatchObject({ channels: ["li/me"], deliveries: { "li/me": { status: "published" } }, status: "published" });
  });

  it("refuses to fork the only channel or an unknown one", async () => {
    const { app, factory } = setup();
    const file = await writeNote(app, "p.md", { type: "social-post", platform: "linkedin", channels: ["li/me"] });
    await expect(factory.forkVariant(file, "li/me", "Me")).rejects.toThrow(/only channel/);
    await expect(factory.forkVariant(file, "li/other", "Other")).rejects.toThrow(/not a channel/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/factory.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `factory.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/model/factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): add NoteFactory for campaigns, variants and forks (refs #16)"
```

---

### Task 12: Settings with versioned migrations and device-local settings (#9)

**Files:**
- Create: `src/settings/settings.ts`, `src/settings/device.ts`, `test/settings/settings.test.ts`

**Interfaces:**
- Consumes: `zChannel`, `zChannelGroup`, `zMinutesList` (Task 6); `isRecord` (Task 7).
- Produces: `SETTINGS_VERSION = 1`; `interface OsmmSettings { schemaVersion; rootFolder; weekStartsOn: 0 | 1; defaultReminders: number[]; defaultStaggerMinutes: number; channels: Channel[]; channelGroups: ChannelGroup[] }`; `DEFAULT_SETTINGS`; `migrateSettings(raw: unknown): OsmmSettings`; `parseMinutesList(text: string): number[] | null`; `interface DeviceSettings { deviceId: string }`; `loadDeviceSettings(app): DeviceSettings`; `saveDeviceSettings(app, s): void`.

- [ ] **Step 1: Write the failing tests**

`test/settings/settings.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings, parseMinutesList } from "../../src/settings/settings";
import { loadDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";

const channel = { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" };

describe("migrateSettings", () => {
  it("returns defaults for empty data", () => {
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(undefined).schemaVersion).toBe(1);
  });

  it("migrates v0 data and normalizes the root folder", () => {
    const s = migrateSettings({ rootFolder: "/Content//Social/", weekStartsOn: 0 });
    expect(s.schemaVersion).toBe(1);
    expect(s.rootFolder).toBe("Content/Social");
    expect(s.weekStartsOn).toBe(0);
  });

  it("keeps valid channels and drops invalid ones", () => {
    const s = migrateSettings({ schemaVersion: 1, channels: [channel, { ...channel, id: "fb/me" }], channelGroups: [{ id: "mine", name: "Mine", channelIds: ["li/me"] }] });
    expect(s.channels).toEqual([channel]);
    expect(s.channelGroups).toHaveLength(1);
  });

  it("falls back to defaults for invalid scalar values", () => {
    const s = migrateSettings({ schemaVersion: 1, rootFolder: "", weekStartsOn: 3, defaultReminders: ["x"], defaultStaggerMinutes: -1 });
    expect(s).toMatchObject({ rootFolder: "Social", weekStartsOn: 1, defaultReminders: [60, 10], defaultStaggerMinutes: 15 });
  });

  it("refuses settings from a newer plugin version", () => {
    expect(() => migrateSettings({ schemaVersion: 99 })).toThrow(/newer version/);
  });
});

describe("parseMinutesList", () => {
  it.each([
    ["60, 10", [60, 10]],
    ["60 10", [60, 10]],
    ["", []],
    ["1h", null],
    ["-5", null],
  ])("%s → %j", (input, expected) => {
    expect(parseMinutesList(input)).toEqual(expected);
  });
});

describe("device settings", () => {
  it("creates a stable device id in local storage only", () => {
    const app = createApp();
    const first = loadDeviceSettings(app);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadDeviceSettings(app)).toEqual(first);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/settings/settings.test.ts`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement `settings.ts`**

```ts
import { normalizePath } from "obsidian";
import { isRecord } from "../model/frontmatter";
import { zChannel, zChannelGroup, zMinutes, zMinutesList } from "../model/schemas";
import type { Channel, ChannelGroup } from "../model/types";

export const SETTINGS_VERSION = 1;

export interface OsmmSettings {
  schemaVersion: typeof SETTINGS_VERSION;
  rootFolder: string;
  weekStartsOn: 0 | 1;
  defaultReminders: number[];
  defaultStaggerMinutes: number;
  channels: Channel[];
  channelGroups: ChannelGroup[];
}

export const DEFAULT_SETTINGS: OsmmSettings = {
  schemaVersion: SETTINGS_VERSION,
  rootFolder: "Social",
  weekStartsOn: 1,
  defaultReminders: [60, 10],
  defaultStaggerMinutes: 15,
  channels: [],
  channelGroups: [],
};

type RawSettings = Record<string, unknown>;

/** MIGRATIONS[n] upgrades data from schema n to n + 1. */
const MIGRATIONS: Record<number, (raw: RawSettings) => RawSettings> = {
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

function sanitize(raw: RawSettings): OsmmSettings {
  const root = typeof raw.rootFolder === "string" && raw.rootFolder.trim() ? normalizePath(raw.rootFolder.trim()) : DEFAULT_SETTINGS.rootFolder;
  const reminders = zMinutesList.safeParse(raw.defaultReminders);
  const stagger = zMinutes.safeParse(raw.defaultStaggerMinutes);
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .map((c) => zChannel.safeParse(c))
    .flatMap((r) => (r.success ? [r.data] : []));
  const groups = (Array.isArray(raw.channelGroups) ? raw.channelGroups : [])
    .map((g) => zChannelGroup.safeParse(g))
    .flatMap((r) => (r.success ? [r.data] : []));
  return {
    schemaVersion: SETTINGS_VERSION,
    rootFolder: root === "/" ? DEFAULT_SETTINGS.rootFolder : root,
    weekStartsOn: raw.weekStartsOn === 0 ? 0 : 1,
    defaultReminders: reminders.success ? reminders.data : [...DEFAULT_SETTINGS.defaultReminders],
    defaultStaggerMinutes: stagger.success ? stagger.data : DEFAULT_SETTINGS.defaultStaggerMinutes,
    channels,
    channelGroups: groups,
  };
}

export function migrateSettings(raw: unknown): OsmmSettings {
  let data: RawSettings = isRecord(raw) ? { ...raw } : {};
  let version = typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
  if (version > SETTINGS_VERSION) {
    throw new Error(`Settings were saved by a newer version of the plugin (schema ${version}). Please update the plugin.`);
  }
  while (version < SETTINGS_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`No settings migration from schema ${version}`);
    data = migrate(data);
    version = Number(data.schemaVersion);
  }
  return sanitize(data);
}

/** "60, 10" → [60, 10]; "" → []; anything invalid → null. */
export function parseMinutesList(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const r = zMinutesList.safeParse(parts.map(Number));
  return r.success ? r.data : null;
}
```

- [ ] **Step 4: Implement `device.ts`**

```ts
import type { App } from "obsidian";
import { isRecord } from "../model/frontmatter";

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
}

const KEY = "osmm-device";

export function loadDeviceSettings(app: App): DeviceSettings {
  const raw: unknown = app.loadLocalStorage(KEY);
  if (isRecord(raw) && typeof raw.deviceId === "string") return { deviceId: raw.deviceId };
  const created: DeviceSettings = { deviceId: crypto.randomUUID() };
  saveDeviceSettings(app, created);
  return created;
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  app.saveLocalStorage(KEY, settings);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/settings/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): add versioned settings with migrations and device-local settings (refs #9)"
```

---

### Task 13: Secrets module and ADR (#22, #23)

**Files:**
- Create: `docs/adr/0001-secrets.md`, `src/secrets/secrets.ts`, `test/secrets/secrets.test.ts`

**Interfaces:**
- Produces: `toSecretId(...parts: string[]): string`; `SecretIds = { channel(channelId: string): string; ntfyToken: string; openaiKey: string; mcpBearer: string }`; `class Secrets { constructor(app: App); get(id): string | null; set(id, value): void; clear(id): void; has(id): boolean; redact(text: string, ids: readonly string[]): string }`.

- [ ] **Step 1: Record the spike decision (#22)**

`docs/adr/0001-secrets.md`:
```markdown
# ADR 0001 — Storing secrets

- Status: accepted (2026-09-27)
- Issue: #22

## Context
Channels need tokens (API tokens, page tokens, WordPress application passwords). The ntfy token, the OpenAI key and the MCP bearer token are secrets too. The vault syncs through iCloud, Git or Obsidian Sync, so `data.json` is not a safe place for them.

## Decision
- Use Obsidian's `app.secretStorage` (API since **1.11.4**): `setSecret(id, value)`, `getSecret(id)`, `listSecrets()`. It is per device and never synced.
- Set the plugin's `minAppVersion` to **1.11.4**. No fallback storage (YAGNI).
- Settings store only **secret ids**, e.g. `Channel.secretId = "osmm-channel-li-acme-studio"`. Ids are lowercase alphanumeric with dashes, which the API requires.
- The settings UI uses Obsidian's `SecretComponent`, so users can pick or create a secret from the shared keychain.
- The API has no delete, so "clear" means `setSecret(id, "")`, and an empty string is treated as absent.

## Consequences
- Each device that publishes must be configured with its own secrets.
- Secrets never appear in `data.json`, logs or notices: errors pass through `Secrets.redact`.
```

- [ ] **Step 2: Write the failing tests**

`test/secrets/secrets.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SecretIds, Secrets, toSecretId } from "../../src/secrets/secrets";
import { createApp } from "../helpers";

describe("secret ids", () => {
  it("builds valid ids from channel ids", () => {
    expect(SecretIds.channel("li/acme-studio")).toBe("osmm-channel-li-acme-studio");
    expect(toSecretId("osmm", "WP", "blog.osmm.app")).toBe("osmm-wp-blog-osmm-app");
  });

  it("throws when nothing usable remains", () => {
    expect(() => toSecretId("//", "--")).toThrow();
  });
});

describe("Secrets", () => {
  it("stores, reads and clears secrets per device", () => {
    const secrets = new Secrets(createApp());
    const id = SecretIds.channel("tg/event-x");
    expect(secrets.has(id)).toBe(false);
    secrets.set(id, "123:abc");
    expect(secrets.get(id)).toBe("123:abc");
    secrets.clear(id);
    expect(secrets.get(id)).toBeNull();
  });

  it("rejects invalid ids", () => {
    expect(() => new Secrets(createApp()).set("Not Valid", "x")).toThrow(/Invalid secret id/);
  });

  it("redacts known secret values from text", () => {
    const secrets = new Secrets(createApp());
    secrets.set(SecretIds.openaiKey, "sk-live-1234567890");
    expect(secrets.redact("401 for key sk-live-1234567890 on /v1/images", [SecretIds.openaiKey])).toBe("401 for key ••• on /v1/images");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/secrets/secrets.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 4: Implement `secrets.ts`**

```ts
import type { App } from "obsidian";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function toSecretId(...parts: string[]): string {
  const id = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ID_RE.test(id)) throw new Error(`Cannot build a secret id from "${parts.join(", ")}"`);
  return id;
}

export const SecretIds = {
  channel: (channelId: string) => toSecretId("osmm", "channel", channelId),
  ntfyToken: "osmm-ntfy-token",
  openaiKey: "osmm-openai-key",
  mcpBearer: "osmm-mcp-bearer",
} as const;

/** Thin wrapper over Obsidian's per-device secret storage (ADR 0001). */
export class Secrets {
  constructor(private readonly app: App) {}

  get(id: string): string | null {
    const value = this.app.secretStorage.getSecret(id);
    return value ? value : null;
  }

  set(id: string, value: string): void {
    if (!ID_RE.test(id)) throw new Error(`Invalid secret id "${id}"`);
    this.app.secretStorage.setSecret(id, value);
  }

  clear(id: string): void {
    this.set(id, "");
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  redact(text: string, ids: readonly string[]): string {
    let out = text;
    for (const id of ids) {
      const value = this.get(id);
      if (value && value.length >= 4) out = out.split(value).join("•••");
    }
    return out;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/secrets/secrets.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(secrets): store secrets in Obsidian secret storage; record ADR (refs #22, #23)"
```

---

### Task 14: ChannelRegistry — channels, groups, expansion (#24)

**Files:**
- Create: `src/channels/registry.ts`, `test/channels/registry.test.ts`

**Interfaces:**
- Consumes: `zChannel`, `zChannelGroup`, `zodIssues` (Task 6); `PLATFORM_META` (Task 5); `Channel`, `ChannelGroup`, `Issue`, `Variant` (Task 6).
- Produces: `interface ChannelStore { read(): { channels: Channel[]; channelGroups: ChannelGroup[] }; write(next: { channels: Channel[]; channelGroups: ChannelGroup[] }): Promise<void> }`; `type UpsertResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }`; `GROUP_PREFIX = "group:"`; `class ChannelRegistry { list(); byPlatform(p); get(id); groups(); group(id); upsertChannel(input: unknown); removeChannel(id); upsertGroup(input: unknown); removeGroup(id); expand(ids: readonly string[]): string[]; usage(id, variants): string[]; suggestId(platform, name): string }`.

- [ ] **Step 1: Write the failing tests**

`test/channels/registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ChannelRegistry, type ChannelStore } from "../../src/channels/registry";
import type { Channel, ChannelGroup } from "../../src/model/types";

function memoryStore(channels: Channel[] = [], channelGroups: ChannelGroup[] = []): ChannelStore & { writes: number } {
  let state = { channels, channelGroups };
  return {
    writes: 0,
    read: () => state,
    async write(next) {
      this.writes++;
      state = next;
    },
  };
}

const me: Channel = { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" };
const acme: Channel = { id: "li/acme-studio", platform: "linkedin", name: "Acme Studio", kind: "page", avatarColor: "#6ea3e6", method: "assisted" };
const tg: Channel = { id: "tg/event-x", platform: "telegram", name: "Event X channel", kind: "page", avatarColor: "#f29a5c", method: "api" };

describe("ChannelRegistry", () => {
  it("adds and replaces channels after validation", async () => {
    const store = memoryStore();
    const reg = new ChannelRegistry(store);
    expect(await reg.upsertChannel(me)).toEqual({ ok: true, value: me });
    expect(await reg.upsertChannel({ ...me, name: "Myself" })).toMatchObject({ ok: true });
    expect(reg.list()).toEqual([{ ...me, name: "Myself" }]);
  });

  it("returns issues for invalid channels and does not write", async () => {
    const store = memoryStore();
    const r = await new ChannelRegistry(store).upsertChannel({ ...me, id: "x/me" });
    expect(r.ok).toBe(false);
    expect(store.writes).toBe(0);
  });

  it("filters by platform", () => {
    expect(new ChannelRegistry(memoryStore([me, acme, tg])).byPlatform("linkedin").map((c) => c.id)).toEqual(["li/me", "li/acme-studio"]);
  });

  it("validates groups against known channels", async () => {
    const reg = new ChannelRegistry(memoryStore([me, acme]));
    expect(await reg.upsertGroup({ id: "all-linkedin", name: "All LinkedIn", channelIds: ["li/me", "li/acme-studio"] })).toMatchObject({ ok: true });
    const bad = await reg.upsertGroup({ id: "ghosts", name: "Ghosts", channelIds: ["li/ghost"] });
    expect(bad).toEqual({ ok: false, issues: [{ level: "error", field: "channelIds", message: "Unknown channel li/ghost" }] });
  });

  it("removing a channel also removes it from groups", async () => {
    const reg = new ChannelRegistry(memoryStore([me, acme], [{ id: "all", name: "All", channelIds: ["li/me", "li/acme-studio"] }]));
    await reg.removeChannel("li/acme-studio");
    expect(reg.list()).toEqual([me]);
    expect(reg.group("all")?.channelIds).toEqual(["li/me"]);
  });

  it("expands groups and channel ids, deduplicated, dropping unknown ids", () => {
    const reg = new ChannelRegistry(memoryStore([me, acme, tg], [{ id: "all-linkedin", name: "All", channelIds: ["li/me", "li/acme-studio"] }]));
    expect(reg.expand(["tg/event-x", "group:all-linkedin", "li/me", "li/ghost", "group:nope"])).toEqual(["tg/event-x", "li/me", "li/acme-studio"]);
  });

  it("finds notes that use a channel", () => {
    const reg = new ChannelRegistry(memoryStore([me]));
    const variants = [
      { path: "a.md", channels: ["li/me"], deliveries: {} },
      { path: "b.md", channels: [], deliveries: { "li/me": { status: "published" as const } } },
      { path: "c.md", channels: ["li/acme-studio"], deliveries: {} },
    ];
    expect(reg.usage("li/me", variants)).toEqual(["a.md", "b.md"]);
  });

  it("suggests unique ids", () => {
    const reg = new ChannelRegistry(memoryStore([acme]));
    expect(reg.suggestId("linkedin", "Acme Studio")).toBe("li/acme-studio-2");
    expect(reg.suggestId("wordpress", "blog.osmm.app")).toBe("wp/blog-osmm-app");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/channels/registry.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 3: Implement `registry.ts`**

```ts
import { PLATFORM_META, type Platform } from "../model/platforms";
import { zChannel, zChannelGroup, zodIssues } from "../model/schemas";
import type { Channel, ChannelGroup, Issue, Variant } from "../model/types";

export interface ChannelState {
  channels: Channel[];
  channelGroups: ChannelGroup[];
}

export interface ChannelStore {
  read(): ChannelState;
  write(next: ChannelState): Promise<void>;
}

export type UpsertResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export const GROUP_PREFIX = "group:";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "channel"
  );
}

export class ChannelRegistry {
  constructor(private readonly store: ChannelStore) {}

  list(): Channel[] {
    return this.store.read().channels;
  }

  byPlatform(platform: Platform): Channel[] {
    return this.list().filter((c) => c.platform === platform);
  }

  get(id: string): Channel | undefined {
    return this.list().find((c) => c.id === id);
  }

  groups(): ChannelGroup[] {
    return this.store.read().channelGroups;
  }

  group(id: string): ChannelGroup | undefined {
    return this.groups().find((g) => g.id === id);
  }

  async upsertChannel(input: unknown): Promise<UpsertResult<Channel>> {
    const r = zChannel.safeParse(input);
    if (!r.success) return { ok: false, issues: zodIssues(r.error) };
    const { channels, channelGroups } = this.store.read();
    const exists = channels.some((c) => c.id === r.data.id);
    const next = exists ? channels.map((c) => (c.id === r.data.id ? r.data : c)) : [...channels, r.data];
    await this.store.write({ channels: next, channelGroups });
    return { ok: true, value: r.data };
  }

  async removeChannel(id: string): Promise<void> {
    const { channels, channelGroups } = this.store.read();
    await this.store.write({
      channels: channels.filter((c) => c.id !== id),
      channelGroups: channelGroups.map((g) => ({ ...g, channelIds: g.channelIds.filter((c) => c !== id) })),
    });
  }

  async upsertGroup(input: unknown): Promise<UpsertResult<ChannelGroup>> {
    const r = zChannelGroup.safeParse(input);
    if (!r.success) return { ok: false, issues: zodIssues(r.error) };
    const unknown = r.data.channelIds.filter((id) => !this.get(id));
    if (unknown.length) {
      return { ok: false, issues: unknown.map((id) => ({ level: "error", field: "channelIds", message: `Unknown channel ${id}` })) };
    }
    const { channels, channelGroups } = this.store.read();
    const exists = channelGroups.some((g) => g.id === r.data.id);
    const next = exists ? channelGroups.map((g) => (g.id === r.data.id ? r.data : g)) : [...channelGroups, r.data];
    await this.store.write({ channels, channelGroups: next });
    return { ok: true, value: r.data };
  }

  async removeGroup(id: string): Promise<void> {
    const { channels, channelGroups } = this.store.read();
    await this.store.write({ channels, channelGroups: channelGroups.filter((g) => g.id !== id) });
  }

  /** Resolve channel ids and `group:<id>` references to known channel ids, in order, without duplicates. */
  expand(ids: readonly string[]): string[] {
    const out: string[] = [];
    const push = (id: string) => {
      if (this.get(id) && !out.includes(id)) out.push(id);
    };
    for (const id of ids) {
      if (id.startsWith(GROUP_PREFIX)) this.group(id.slice(GROUP_PREFIX.length))?.channelIds.forEach(push);
      else push(id);
    }
    return out;
  }

  usage(id: string, variants: readonly Pick<Variant, "path" | "channels" | "deliveries">[]): string[] {
    return variants.filter((v) => v.channels.includes(id) || id in v.deliveries).map((v) => v.path);
  }

  suggestId(platform: Platform, name: string): string {
    const base = `${PLATFORM_META[platform].prefix}/${slugify(name)}`;
    let candidate = base;
    for (let n = 2; this.get(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/channels/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(channels): add channel registry with groups and expansion (refs #24)"
```

---

### Task 15: SocialIndex — live index fed by vault events (#18)

**Files:**
- Create: `src/index/socialIndex.ts`, `test/index/socialIndex.test.ts`
- Modify: `test/helpers.ts` (add `nextChange`)

**Interfaces:**
- Consumes: `socialKind`, `isRecord`, `parseCampaign`, `parseVariant`, `SocialKind` (Task 7); `bodyOf`, `excerpt` (Task 9).
- Produces: `interface IndexedCampaign extends Campaign { file: TFile; issues: Issue[] }`; `interface IndexedVariant extends Variant { file: TFile; issues: Issue[]; campaignPath?: string; excerpt: string; displayTitle: string }`; `interface InvalidNote { file: TFile; kind: SocialKind; issues: Issue[] }`; `interface IndexChange { changed: string[]; removed: string[] }`; `class SocialIndex { constructor(app: App, debounceMs?: number); build(): Promise<void>; start(): void; stop(): void; campaigns(); variants(); invalidNotes(); getCampaign(path); getVariant(path); variantsOf(campaignPath); readonly revision: number; onChange(listener): () => void; flush(): void }`.
- Test helper: `nextChange(index: SocialIndex): Promise<IndexChange>`.

- [ ] **Step 1: Add the test helper**

Append to `test/helpers.ts`:
```ts
import type { IndexChange, SocialIndex } from "../src/index/socialIndex";

export function nextChange(index: SocialIndex): Promise<IndexChange> {
  return new Promise((resolve) => {
    const off = index.onChange((change) => {
      off();
      resolve(change);
    });
  });
}
```

- [ ] **Step 2: Write the failing tests**

`test/index/socialIndex.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { SocialIndex } from "../../src/index/socialIndex";
import { createApp, nextChange, settle, writeNote } from "../helpers";

let index: SocialIndex | undefined;
afterEach(() => index?.stop());

async function vaultWithCampaign() {
  const app = createApp();
  await writeNote(app, "Social/Event X/Event X.md", { type: "social-campaign", title: "Event X" }, "Brief");
  await writeNote(
    app,
    "Social/Event X/Event X – LinkedIn.md",
    { type: "social-post", campaign: "[[Event X]]", platform: "linkedin", channels: ["li/me"] },
    "\n# I almost didn't host Event X.\n\nMore text",
  );
  await writeNote(app, "Notes/Random.md", { tags: ["x"] }, "Not social");
  await writeNote(app, "Social/Broken.md", { type: "social-post" }, "");
  await settle();
  index = new SocialIndex(app, 0);
  await index.build();
  index.start();
  return { app, index };
}

describe("SocialIndex", () => {
  it("indexes campaigns, variants and invalid notes; ignores other notes", async () => {
    const { index } = await vaultWithCampaign();
    expect(index.campaigns().map((c) => c.title)).toEqual(["Event X"]);
    const [variant] = index.variants();
    expect(variant).toMatchObject({
      platform: "linkedin",
      campaignPath: "Social/Event X/Event X.md",
      excerpt: "I almost didn't host Event X.",
      displayTitle: "I almost didn't host Event X.",
    });
    expect(index.invalidNotes().map((n) => n.file.path)).toEqual(["Social/Broken.md"]);
    expect(index.variantsOf("Social/Event X/Event X.md")).toHaveLength(1);
  });

  it("emits changes when a note is modified", async () => {
    const { app, index } = await vaultWithCampaign();
    const change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", campaign: "[[Event X]]", platform: "linkedin", channels: ["li/me"], title: "New title" });
    expect(await change).toEqual({ changed: ["Social/Event X/Event X – LinkedIn.md"], removed: [] });
    expect(index.getVariant("Social/Event X/Event X – LinkedIn.md")?.displayTitle).toBe("New title");
  });

  it("removes notes that are deleted or stop being social notes", async () => {
    const { app, index } = await vaultWithCampaign();
    let change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "note" });
    expect((await change).removed).toEqual(["Social/Event X/Event X – LinkedIn.md"]);
    change = nextChange(index);
    await app.vault.delete(app.vault.getFileByPath("Social/Event X/Event X.md")!);
    expect((await change).removed).toEqual(["Social/Event X/Event X.md"]);
    expect(index.campaigns()).toEqual([]);
  });

  it("follows a renamed variant", async () => {
    const { app, index } = await vaultWithCampaign();
    const change = nextChange(index);
    await app.vault.rename(app.vault.getFileByPath("Social/Event X/Event X – LinkedIn.md")!, "Social/Event X/LI.md");
    expect(await change).toEqual({ changed: ["Social/Event X/LI.md"], removed: ["Social/Event X/Event X – LinkedIn.md"] });
  });

  it("re-links variants when a campaign is renamed and links are updated (review focus 4)", async () => {
    const { app, index } = await vaultWithCampaign();
    await app.vault.rename(app.vault.getFileByPath("Social/Event X/Event X.md")!, "Social/Event X/Event X 2026.md");
    await settle(5);
    expect(index.variants()[0]?.campaignPath).toBeUndefined();
    const change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", campaign: "[[Event X 2026]]", platform: "linkedin", channels: ["li/me"] });
    await change;
    expect(index.variants()[0]?.campaignPath).toBe("Social/Event X/Event X 2026.md");
  });

  it("stops listening after stop()", async () => {
    const { app, index } = await vaultWithCampaign();
    index.stop();
    let fired = false;
    index.onChange(() => (fired = true));
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", platform: "x" });
    await settle(5);
    expect(fired).toBe(false);
  });

  it("increments the revision on every emitted change", async () => {
    const { app, index } = await vaultWithCampaign();
    const before = index.revision;
    const change = nextChange(index);
    await writeNote(app, "Social/Posts/Solo.md", { type: "social-post", platform: "x", title: "Solo" });
    await change;
    expect(index.revision).toBe(before + 1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/index/socialIndex.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 4: Implement `socialIndex.ts`**

```ts
import { TFile, type App, type EventRef, type TAbstractFile } from "obsidian";
import { bodyOf, excerpt } from "../model/body";
import { isRecord, parseCampaign, parseVariant, socialKind, type SocialKind } from "../model/frontmatter";
import type { Campaign, Issue, Variant } from "../model/types";

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
    const entries = await Promise.all(this.app.vault.getMarkdownFiles().map((f) => this.read(f)));
    for (const entry of entries) if (entry) this.store(entry);
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
    const text = excerpt(bodyOf(await this.app.vault.cachedRead(file)));
    return {
      kind: "post",
      value: {
        ...r.value,
        file,
        issues: r.issues,
        excerpt: text,
        displayTitle: r.value.title ?? (text || file.basename),
        campaignPath: this.resolveCampaign(r.value),
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
        v.campaignPath = next;
        this.pendingChanged.add(v.path);
      }
    }
  }

  /** Re-read one file; stale reads (superseded by a newer event for the same path) are discarded. */
  private async reindex(file: TFile): Promise<{ before: SocialKind | null; after: SocialKind | null } | null> {
    const token = (this.sequence.get(file.path) ?? 0) + 1;
    this.sequence.set(file.path, token);
    const before = this.kindAt(file.path);
    const entry = await this.read(file);
    if (this.sequence.get(file.path) !== token) return null;
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/index/socialIndex.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(index): add live social index fed by vault events (refs #18)"
```

---

### Task 16: Query API and Svelte store bridge (#19)

**Files:**
- Create: `src/index/queries.ts`, `src/index/stores.ts`, `test/index/queries.test.ts`

**Interfaces:**
- Consumes: `IndexedVariant`, `IndexedCampaign`, `SocialIndex` (Task 15); `deliveryTime` (Task 8).
- Produces (`queries.ts`): `type RowStatus = DeliveryStatus | "idea"`; `interface PostRow { key: string; variant: IndexedVariant; channelId: string | null; status: RowStatus; at?: number }`; `interface RowFilter { platforms?; channelIds?; campaignPaths?; statuses? }` (a `""` entry in `campaignPaths` matches standalone posts); `expandRows(variants, defaultStagger): PostRow[]`; `filterRows(rows, filter): PostRow[]`; `rowsBetween(rows, from, to): PostRow[]`; `overdueRows(rows, now): PostRow[]`; `upcomingRows(rows, now, horizonMs): PostRow[]`; `unscheduledRows(rows): PostRow[]`; `campaignProgress(variants, campaignPath): { published: number; total: number }`.
- Produces (`stores.ts`): `interface IndexSnapshot { revision: number; campaigns: IndexedCampaign[]; variants: IndexedVariant[] }`; `indexStore(index: SocialIndex): Readable<IndexSnapshot>`.

- [ ] **Step 1: Write the failing tests**

`test/index/queries.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  campaignProgress,
  expandRows,
  filterRows,
  overdueRows,
  rowsBetween,
  unscheduledRows,
  upcomingRows,
} from "../../src/index/queries";
import { indexStore } from "../../src/index/stores";
import { SocialIndex, type IndexedVariant } from "../../src/index/socialIndex";
import { createApp, nextChange, writeNote } from "../helpers";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 8, 10);

function v(partial: Partial<IndexedVariant> & Pick<IndexedVariant, "path" | "platform">): IndexedVariant {
  return {
    channels: [],
    mode: "auto",
    status: "draft",
    media: [],
    deliveries: {},
    issues: [],
    excerpt: "",
    displayTitle: partial.path,
    file: {} as IndexedVariant["file"],
    ...partial,
  };
}

const variants = [
  v({ path: "li.md", platform: "linkedin", campaignPath: "ex.md", channels: ["li/me", "li/acme"], scheduledAt: NOW + H, staggerMinutes: 15, deliveries: { "li/me": { status: "published" }, "li/acme": { status: "scheduled" } } }),
  v({ path: "ig.md", platform: "instagram", campaignPath: "ex.md", channels: ["ig/acme"], scheduledAt: NOW - 2 * H, deliveries: { "ig/acme": { status: "scheduled" } } }),
  v({ path: "hn.md", platform: "hackernews", channels: ["hn/you"], scheduledAt: NOW - H, deliveries: { "hn/you": { status: "overdue" } } }),
  v({ path: "idea.md", platform: "x", status: "idea" }),
];

describe("expandRows", () => {
  const rows = expandRows(variants, 10);

  it("creates one row per channel and one for channel-less variants", () => {
    expect(rows.map((r) => r.key)).toEqual(["li.md#li/me", "li.md#li/acme", "ig.md#ig/acme", "hn.md#hn/you", "idea.md#"]);
    expect(rows.find((r) => r.key === "idea.md#")).toMatchObject({ channelId: null, status: "idea", at: undefined });
  });

  it("applies stagger to delivery times", () => {
    expect(rows.find((r) => r.key === "li.md#li/acme")?.at).toBe(NOW + H + 15 * 60_000);
  });
});

describe("row queries", () => {
  const rows = expandRows(variants, 10);

  it("filters by platform, channel, campaign and status", () => {
    expect(filterRows(rows, { platforms: ["linkedin"] }).map((r) => r.key)).toEqual(["li.md#li/me", "li.md#li/acme"]);
    expect(filterRows(rows, { channelIds: ["ig/acme"] }).map((r) => r.key)).toEqual(["ig.md#ig/acme"]);
    expect(filterRows(rows, { campaignPaths: [""] }).map((r) => r.key)).toEqual(["hn.md#hn/you", "idea.md#"]);
    expect(filterRows(rows, { statuses: ["published"] }).map((r) => r.key)).toEqual(["li.md#li/me"]);
    expect(filterRows(rows, {})).toHaveLength(rows.length);
  });

  it("finds rows in a time range, sorted", () => {
    expect(rowsBetween(rows, NOW - 3 * H, NOW + H).map((r) => r.key)).toEqual(["ig.md#ig/acme", "hn.md#hn/you"]);
  });

  it("finds overdue rows: past scheduled rows and explicit overdue", () => {
    expect(overdueRows(rows, NOW).map((r) => r.key)).toEqual(["ig.md#ig/acme", "hn.md#hn/you"]);
  });

  it("finds upcoming and unscheduled rows", () => {
    expect(upcomingRows(rows, NOW, 2 * H).map((r) => r.key)).toEqual(["li.md#li/acme"]);
    expect(unscheduledRows(rows).map((r) => r.key)).toEqual(["idea.md#"]);
  });

  it("computes campaign progress", () => {
    expect(campaignProgress(variants, "ex.md")).toEqual({ published: 1, total: 3 });
  });
});

describe("indexStore", () => {
  it("publishes a new snapshot on every index change", async () => {
    const app = createApp();
    const index = new SocialIndex(app, 0);
    await index.build();
    index.start();
    const store = indexStore(index);
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.variants.length));
    const change = nextChange(index);
    await writeNote(app, "Social/Posts/Solo.md", { type: "social-post", platform: "x", title: "Solo" });
    await change;
    expect(seen).toEqual([0, 1]);
    expect(get(store).revision).toBe(index.revision);
    off();
    index.stop();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/index/queries.test.ts`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement `queries.ts`**

```ts
import { deliveryTime } from "../model/stateMachine";
import type { DeliveryStatus } from "../model/types";
import type { Platform } from "../model/platforms";
import type { IndexedVariant } from "./socialIndex";

export type RowStatus = DeliveryStatus | "idea";

/** One schedulable unit: a variant on one channel (or a variant without channels). */
export interface PostRow {
  key: string;
  variant: IndexedVariant;
  channelId: string | null;
  status: RowStatus;
  at?: number;
}

export interface RowFilter {
  platforms?: readonly Platform[];
  channelIds?: readonly string[];
  /** Campaign note paths; "" matches standalone posts. */
  campaignPaths?: readonly string[];
  statuses?: readonly RowStatus[];
}

function undeliveredStatus(v: IndexedVariant): RowStatus {
  if (v.status === "idea" || v.status === "ready" || v.status === "scheduled") return v.status;
  return "draft";
}

export function expandRows(variants: readonly IndexedVariant[], defaultStagger: number): PostRow[] {
  const rows: PostRow[] = [];
  for (const v of variants) {
    if (v.channels.length === 0) {
      rows.push({ key: `${v.path}#`, variant: v, channelId: null, status: undeliveredStatus(v), at: v.scheduledAt });
      continue;
    }
    for (const id of v.channels) {
      rows.push({
        key: `${v.path}#${id}`,
        variant: v,
        channelId: id,
        status: v.deliveries[id]?.status ?? undeliveredStatus(v),
        at: deliveryTime(v, id, defaultStagger),
      });
    }
  }
  return rows;
}

const active = <T>(list: readonly T[] | undefined): list is readonly T[] => !!list && list.length > 0;

export function filterRows(rows: readonly PostRow[], f: RowFilter): PostRow[] {
  return rows.filter((r) => {
    if (active(f.platforms) && !f.platforms.includes(r.variant.platform)) return false;
    if (active(f.channelIds) && (r.channelId === null || !f.channelIds.includes(r.channelId))) return false;
    if (active(f.campaignPaths) && !f.campaignPaths.includes(r.variant.campaignPath ?? "")) return false;
    if (active(f.statuses) && !f.statuses.includes(r.status)) return false;
    return true;
  });
}

const byTime = (a: PostRow, b: PostRow) => (a.at ?? 0) - (b.at ?? 0) || a.key.localeCompare(b.key);

export function rowsBetween(rows: readonly PostRow[], from: number, to: number): PostRow[] {
  return rows.filter((r) => r.at !== undefined && r.at >= from && r.at < to).sort(byTime);
}

const OVERDUE_CANDIDATES = new Set<RowStatus>(["scheduled", "awaiting_you"]);

export function overdueRows(rows: readonly PostRow[], now: number): PostRow[] {
  return rows
    .filter((r) => r.status === "overdue" || (OVERDUE_CANDIDATES.has(r.status) && r.at !== undefined && r.at < now))
    .sort(byTime);
}

const UPCOMING = new Set<RowStatus>(["scheduled", "handed_over", "awaiting_you"]);

export function upcomingRows(rows: readonly PostRow[], now: number, horizonMs: number): PostRow[] {
  return rows
    .filter((r) => UPCOMING.has(r.status) && r.at !== undefined && r.at >= now && r.at < now + horizonMs)
    .sort(byTime);
}

export function unscheduledRows(rows: readonly PostRow[]): PostRow[] {
  return rows.filter((r) => r.at === undefined);
}

export function campaignProgress(
  variants: readonly IndexedVariant[],
  campaignPath: string,
): { published: number; total: number } {
  const rows = expandRows(
    variants.filter((v) => v.campaignPath === campaignPath),
    0,
  );
  return { published: rows.filter((r) => r.status === "published").length, total: rows.length };
}
```

- [ ] **Step 4: Implement `stores.ts`**

```ts
import { readable, type Readable } from "svelte/store";
import type { IndexedCampaign, IndexedVariant, SocialIndex } from "./socialIndex";

export interface IndexSnapshot {
  revision: number;
  campaigns: IndexedCampaign[];
  variants: IndexedVariant[];
}

export function indexStore(index: SocialIndex): Readable<IndexSnapshot> {
  const snapshot = (): IndexSnapshot => ({
    revision: index.revision,
    campaigns: index.campaigns(),
    variants: index.variants(),
  });
  return readable(snapshot(), (set) => index.onChange(() => set(snapshot())));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/index/queries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(index): add row queries and Svelte store bridge (refs #19)"
```

---

### Task 17: Index performance on large vaults (#20)

**Files:**
- Create: `test/index/perf.test.ts`

**Interfaces:**
- Consumes: `SocialIndex` (Task 15); `expandRows`, `rowsBetween` (Task 16).
- Produces: performance guards: building 5,000 notes takes under 2 s in CI, the expected figure is under 500 ms, and it is logged; a full-month query takes under 50 ms; a burst of 100 modifications produces one change event.

- [ ] **Step 1: Write the performance tests**

`test/index/perf.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SocialIndex } from "../../src/index/socialIndex";
import { expandRows, rowsBetween } from "../../src/index/queries";
import { createApp, settle, writeNote } from "../helpers";

const PLATFORMS = ["linkedin", "x", "instagram", "facebook", "mastodon", "bluesky", "telegram", "discord", "hackernews"] as const;
const PREFIX: Record<string, string> = { linkedin: "li", x: "x", instagram: "ig", facebook: "fb", mastodon: "ma", bluesky: "bs", telegram: "tg", discord: "dc", hackernews: "hn" };

describe("index performance (#20)", () => {
  it("indexes 5,000 notes and answers queries fast", async () => {
    const app = createApp();
    const start = Date.UTC(2026, 9, 1);
    for (let c = 0; c < 500; c++) {
      const folder = `Social/C${c}`;
      await writeNote(app, `${folder}/C${c}.md`, { type: "social-campaign", title: `C${c}` });
      for (const [i, platform] of PLATFORMS.entries()) {
        await writeNote(
          app,
          `${folder}/C${c} – ${platform}.md`,
          { type: "social-post", campaign: `[[C${c}]]`, platform, channels: [`${PREFIX[platform]}/main`], scheduled_at: new Date(start + (c * 9 + i) * 3_600_000).toISOString() },
          `Post ${c}/${i}`,
        );
      }
    }
    await settle();

    const index = new SocialIndex(app, 0);
    const t0 = performance.now();
    await index.build();
    const buildMs = performance.now() - t0;
    console.info(`[perf] build 5,000 notes: ${buildMs.toFixed(0)} ms`);
    expect(index.variants()).toHaveLength(4500);
    expect(buildMs).toBeLessThan(2000);

    const t1 = performance.now();
    const rows = rowsBetween(expandRows(index.variants(), 15), start, start + 31 * 86_400_000);
    const queryMs = performance.now() - t1;
    console.info(`[perf] month query: ${queryMs.toFixed(1)} ms (${rows.length} rows)`);
    expect(queryMs).toBeLessThan(50);
  }, 30_000);

  it("coalesces bursts of changes into one event", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/p.md", { type: "social-post", platform: "x" });
    await settle();
    const index = new SocialIndex(app, 20);
    await index.build();
    index.start();
    let events = 0;
    index.onChange(() => events++);
    for (let i = 0; i < 100; i++) await app.vault.modify(file, `---\ntype: social-post\nplatform: x\ntitle: t${i}\n---\n`);
    await settle(60);
    expect(events).toBe(1);
    expect(index.getVariant("Social/p.md")?.title).toBe("t99");
    index.stop();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/index/perf.test.ts`
Expected: PASS, with `[perf]` timings in the output. If the build is ≥ 2 s, profile `SocialIndex.read` (`cachedRead` + `excerpt`) before relaxing anything.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(index): add large-vault performance guards (refs #20)"
```

---

### Task 18: Wire the plugin — services and General settings tab

**Files:**
- Create: `src/settings/tab.ts`, `test/main.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `OsmmPlugin` public fields `settings: OsmmSettings`, `device: DeviceSettings`, `secrets: Secrets`, `writer: SafeWriter`, `factory: NoteFactory`, `channels: ChannelRegistry`, `index: SocialIndex`; methods `saveSettings(): Promise<void>` and `updateSettings(patch: Partial<Omit<OsmmSettings, "schemaVersion">>): Promise<void>`. `OsmmSettingTab` with the General section (root folder, week start, default reminders, default stagger). M1b adds the Channels section.

- [ ] **Step 1: Write the failing test**

`test/main.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App, Setting, type TextComponent, type DropdownComponent } from "./fakes/obsidian";
import OsmmPlugin from "../src/main";
import { nextChange, settle } from "./helpers";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };

async function loaded() {
  const app = new App();
  const plugin = new OsmmPlugin(app as never, manifest);
  await plugin.load();
  await settle();
  return { app, plugin };
}

describe("OsmmPlugin", () => {
  it("wires services and indexes notes created through the factory", async () => {
    const { plugin } = await loaded();
    const change = nextChange(plugin.index);
    await plugin.factory.createCampaign({ title: "Event X" });
    await change;
    expect(plugin.index.campaigns().map((c) => c.path)).toEqual(["Social/Event X/Event X.md"]);
    plugin.unload();
  });

  it("persists settings updates", async () => {
    const { plugin } = await loaded();
    await plugin.updateSettings({ rootFolder: "Content/Social" });
    expect((await plugin.loadData()).rootFolder).toBe("Content/Social");
    plugin.unload();
  });

  it("renders the General settings and applies edits", async () => {
    const { plugin } = await loaded();
    Setting.all = [];
    (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!.display();
    const byName = (n: string) => Setting.all.find((s) => s.name === n)!;
    expect(Setting.all.map((s) => s.name)).toEqual(["General", "Root folder", "Week starts on", "Default reminders", "Default stagger"]);
    await (byName("Default reminders").components[0] as TextComponent).change("30, 5");
    await (byName("Week starts on").components[0] as DropdownComponent).change("0");
    expect(plugin.settings.defaultReminders).toEqual([30, 5]);
    expect(plugin.settings.weekStartsOn).toBe(0);
    await (byName("Default reminders").components[0] as TextComponent).change("soon");
    expect(plugin.settings.defaultReminders).toEqual([30, 5]);
    plugin.unload();
  });

  it("stops the index on unload", async () => {
    const { app, plugin } = await loaded();
    plugin.unload();
    let fired = false;
    plugin.index.onChange(() => (fired = true));
    await app.vault.createFolder("Social");
    await app.vault.create("Social/p.md", "---\ntype: social-post\nplatform: x\n---\n");
    await settle(80);
    expect(fired).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL. `plugin.factory` is undefined and the settings tab is missing.

- [ ] **Step 3: Implement the settings tab**

`src/settings/tab.ts`:
```ts
import { normalizePath, PluginSettingTab, Setting, type App } from "obsidian";
import type OsmmPlugin from "../main";
import { parseMinutesList } from "./settings";

export class OsmmSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly osmm: OsmmPlugin,
  ) {
    super(app, osmm);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.osmm.settings;

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Root folder")
      .setDesc("New campaigns and standalone posts are created here.")
      .addText((t) =>
        t
          .setPlaceholder("Social")
          .setValue(s.rootFolder)
          .onChange(async (value) => {
            await this.osmm.updateSettings({ rootFolder: normalizePath(value.trim() || "Social") });
          }),
      );

    new Setting(containerEl)
      .setName("Week starts on")
      .addDropdown((d) =>
        d
          .addOption("1", "Monday")
          .addOption("0", "Sunday")
          .setValue(String(s.weekStartsOn))
          .onChange(async (value) => {
            await this.osmm.updateSettings({ weekStartsOn: value === "0" ? 0 : 1 });
          }),
      );

    new Setting(containerEl)
      .setName("Default reminders")
      .setDesc("Minutes before a post, comma-separated (e.g. 60, 10).")
      .addText((t) =>
        t.setValue(s.defaultReminders.join(", ")).onChange(async (value) => {
          const parsed = parseMinutesList(value);
          if (parsed) await this.osmm.updateSettings({ defaultReminders: parsed });
        }),
      );

    new Setting(containerEl)
      .setName("Default stagger")
      .setDesc("Minutes between channels when one post goes to several channels.")
      .addText((t) =>
        t.setValue(String(s.defaultStaggerMinutes)).onChange(async (value) => {
          if (/^\d+$/.test(value.trim())) await this.osmm.updateSettings({ defaultStaggerMinutes: Number(value.trim()) });
        }),
      );
  }
}
```

- [ ] **Step 4: Wire services in `src/main.ts`**

```ts
import { Plugin } from "obsidian";
import "./styles/index.css";
import { ChannelRegistry } from "./channels/registry";
import { SocialIndex } from "./index/socialIndex";
import { NoteFactory } from "./model/factory";
import { SafeWriter } from "./model/writer";
import { Secrets } from "./secrets/secrets";
import { loadDeviceSettings, type DeviceSettings } from "./settings/device";
import { migrateSettings, type OsmmSettings } from "./settings/settings";
import { OsmmSettingTab } from "./settings/tab";

export default class OsmmPlugin extends Plugin {
  settings!: OsmmSettings;
  device!: DeviceSettings;
  secrets!: Secrets;
  writer!: SafeWriter;
  factory!: NoteFactory;
  channels!: ChannelRegistry;
  index!: SocialIndex;

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.device = loadDeviceSettings(this.app);
    this.secrets = new Secrets(this.app);
    this.writer = new SafeWriter(this.app);
    this.factory = new NoteFactory(this.app, this.writer, { rootFolder: () => this.settings.rootFolder });
    this.channels = new ChannelRegistry({
      read: () => this.settings,
      write: async (next) => {
        this.settings = { ...this.settings, ...next };
        await this.saveSettings();
      },
    });
    this.index = new SocialIndex(this.app);
    this.register(() => this.index.stop());

    this.addSettingTab(new OsmmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.index.build();
      this.index.start();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async updateSettings(patch: Partial<Omit<OsmmSettings, "schemaVersion">>): Promise<void> {
    this.settings = migrateSettings({ ...this.settings, ...patch });
    await this.saveSettings();
  }
}
```

- [ ] **Step 5: Run the full suite, typecheck and build**

Run: `npm test && npm run typecheck && npm run lint && node esbuild.config.mjs production`
Expected: all tests pass; no type or lint errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire core services into the plugin with a General settings tab"
```

---

### Task 19: Dev vault with seed fixtures (#7)

**Files:**
- Create: `scripts/seedData.ts`, `scripts/seed.ts`, `test/scripts/seedData.test.ts`, `README.md`

**Interfaces:**
- Consumes: `formatDateTime`, `HOUR`, `DAY` (Task 5); `parseCampaign`, `parseVariant` (Task 7); `migrateSettings` (Task 12).
- Produces: `buildSeed(now: number, opts?: { large?: boolean }): { notes: Array<{ path: string; frontmatter: Record<string, unknown>; body: string }>; settings: Record<string, unknown> }`; `npm run seed [-- --large]` writes `dev-vault/`.

- [ ] **Step 1: Install tsx**

```bash
npm install --save-dev tsx@^4
```

- [ ] **Step 2: Write the failing test**

`test/scripts/seedData.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildSeed } from "../../scripts/seedData";
import { parseCampaign, parseVariant } from "../../src/model/frontmatter";
import { migrateSettings } from "../../src/settings/settings";

const NOW = Date.UTC(2026, 9, 8, 8);

describe("seed data", () => {
  const seed = buildSeed(NOW);

  it("produces notes that parse without errors or warnings", () => {
    for (const note of seed.notes) {
      const parsed = note.frontmatter.type === "social-campaign" ? parseCampaign(note.frontmatter, note.path) : parseVariant(note.frontmatter, note.path);
      expect({ path: note.path, issues: parsed.issues }).toEqual({ path: note.path, issues: [] });
    }
  });

  it("covers every delivery state the UI must show", () => {
    const statuses = new Set(seed.notes.flatMap((n) => Object.values((n.frontmatter.deliveries ?? {}) as Record<string, { status: string }>).map((d) => d.status)));
    for (const s of ["published", "scheduled", "awaiting_you", "overdue", "failed"]) expect(statuses).toContain(s);
  });

  it("produces valid settings with channels for every platform used", () => {
    const settings = migrateSettings(seed.settings);
    const ids = new Set(settings.channels.map((c) => c.id));
    for (const n of seed.notes) for (const id of (n.frontmatter.channels ?? []) as string[]) expect(ids).toContain(id);
  });

  it("generates 5,000+ notes in large mode", () => {
    expect(buildSeed(NOW, { large: true }).notes.length).toBeGreaterThanOrEqual(5000);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/scripts/seedData.test.ts`
Expected: FAIL. The module doesn't exist yet.

- [ ] **Step 4: Implement `scripts/seedData.ts`**

```ts
import { DAY, HOUR, formatDateTime } from "../src/model/dates";

export interface SeedNote {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const ch = (id: string, platform: string, name: string, kind: string, avatarColor: string, method: string) => ({ id, platform, name, kind, avatarColor, method });

const CHANNELS = [
  ch("li/me", "linkedin", "Me", "profile", "#c9c3b8", "api"),
  ch("li/acme-studio", "linkedin", "Acme Studio", "page", "#6ea3e6", "assisted"),
  ch("li/maker-lab", "linkedin", "Maker Lab", "page", "#6fc4ae", "assisted"),
  ch("li/osmm", "linkedin", "OSMM", "page", "#9d8cf5", "assisted"),
  ch("li/event-x-berlin", "linkedin", "Event X Berlin", "page", "#f29a5c", "assisted"),
  ch("fb/event-x-berlin", "facebook", "Event X Berlin", "page", "#8aa3f0", "native"),
  ch("ig/acmestudio", "instagram", "@acmestudio", "account", "#e38bb4", "api"),
  ch("x/you", "x", "@you", "profile", "#e6e4df", "api"),
  ch("ma/you", "mastodon", "@you@mastodon.social", "profile", "#a99bf6", "native"),
  ch("bs/you", "bluesky", "@you.bsky.social", "profile", "#68b9f2", "api"),
  ch("tg/event-x", "telegram", "Event X channel", "page", "#5cc6d6", "api"),
  ch("dc/maker-lab", "discord", "Maker Lab #announcements", "server_channel", "#a0a7f3", "api"),
  ch("hn/you", "hackernews", "HN", "account", "#f29a5c", "assisted"),
  ch("ih/you", "indiehackers", "Indie Hackers", "account", "#6fc4ae", "assisted"),
  ch("wa/makers-berlin", "whatsapp", "Makers Berlin", "group", "#7fd39a", "assisted"),
  ch("wp/eventx-berlin", "wordpress", "eventx.berlin", "site", "#f29a5c", "native"),
];

const GROUPS = [
  { id: "all-linkedin-pages", name: "All LinkedIn pages", channelIds: ["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"] },
];

export function buildSeed(now: number, opts: { large?: boolean } = {}): { notes: SeedNote[]; settings: Record<string, unknown> } {
  const day = (d: number, h: number, m = 0) => {
    const base = new Date(now);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, h, m).getTime();
  };
  const iso = formatDateTime;
  const notes: SeedNote[] = [];
  const campaign = (folder: string, title: string, extra: Record<string, unknown> = {}) =>
    notes.push({ path: `Social/${folder}/${title}.md`, frontmatter: { type: "social-campaign", title, status: "active", ...extra }, body: "\n## Brief\n\n[FILL IN]\n\n```social-variants\n```\n" });
  const post = (path: string, fm: Record<string, unknown>, body: string) =>
    notes.push({ path, frontmatter: { type: "social-post", mode: "auto", ...fm }, body });

  campaign("Event X", "Event X", { anchor_date: iso(day(4, 18)), link: "https://example.com/event-x" });
  const ex = (p: string) => `Social/Event X/Event X – ${p}.md`;
  post(ex("LinkedIn"), {
    campaign: "[[Event X]]", platform: "linkedin", status: "partial",
    channels: ["li/me", "li/acme-studio", "li/maker-lab"], scheduled_at: iso(day(0, 17, 30)), stagger_minutes: 15, reminders: [60, 10],
    deliveries: { "li/me": { status: "published", at: iso(day(-3, 9)), url: "https://www.linkedin.com/feed/update/urn:li:activity:1" }, "li/acme-studio": { status: "awaiting_you", at: iso(day(0, 17, 45)) }, "li/maker-lab": { status: "scheduled", at: iso(day(0, 18)) } },
  }, "I almost didn't host Event X.\n\nSix months ago I was shipping alone…\n");
  post(ex("X"), { campaign: "[[Event X]]", platform: "x", status: "scheduled", channels: ["x/you"], scheduled_at: iso(day(1, 9)), deliveries: { "x/you": { status: "scheduled" } } }, "I almost didn't host Event X.\n---\nOne evening, twelve makers…\n---\nRSVP → example.com/event-x\n");
  post(ex("Instagram"), { campaign: "[[Event X]]", platform: "instagram", status: "overdue", channels: ["ig/acmestudio"], scheduled_at: iso(day(-2, 18)), media: ["[[event-x-cover.png]]"], deliveries: { "ig/acmestudio": { status: "overdue" } } }, "One evening. Eighty makers. Laptops open.\n");
  post(ex("Hacker News"), { campaign: "[[Event X]]", platform: "hackernews", mode: "assisted", status: "scheduled", title: "Show HN: Event X – a monthly evening for makers", url: "https://example.com/event-x", channels: ["hn/you"], scheduled_at: iso(day(-1, 15)), deliveries: { "hn/you": { status: "scheduled" } } }, "");
  post(ex("Bluesky"), { campaign: "[[Event X]]", platform: "bluesky", status: "scheduled", channels: ["bs/you"], scheduled_at: iso(day(0, 11)), deliveries: { "bs/you": { status: "scheduled" } } }, "Event X is back on the 12th — one evening, 80 makers.\n");
  post(ex("Telegram"), { campaign: "[[Event X]]", platform: "telegram", status: "attention", channels: ["tg/event-x"], scheduled_at: iso(day(0, 12)), deliveries: { "tg/event-x": { status: "failed", error: "Bot is not an admin of the channel" } } }, "**Event X — 18:00**\n80 seats · free\n");
  post(ex("Discord"), { campaign: "[[Event X]]", platform: "discord", status: "scheduled", channels: ["dc/maker-lab"], scheduled_at: iso(day(2, 19)), deliveries: { "dc/maker-lab": { status: "scheduled" } } }, "@everyone Event X is on!\n");
  post(ex("WordPress"), { campaign: "[[Event X]]", platform: "wordpress", status: "scheduled", title: "We're hosting Event X again", channels: ["wp/eventx-berlin"], scheduled_at: iso(day(-2, 8)), slug: "hosting-event-x-again", categories: ["Community"], tags: ["events"], deliveries: { "wp/eventx-berlin": { status: "handed_over", at: iso(day(-2, 8)), remote_id: "412" } } }, "# We're hosting Event X again\n\nSix months ago…\n");
  post(ex("LinkedIn recap"), { campaign: "[[Event X]]", platform: "linkedin", status: "draft", channels: ["li/me"], scheduled_at: iso(day(6, 9)) }, "Event X recap: what 80 makers shipped.\n");

  campaign("OSMM launch", "OSMM launch", { anchor_date: iso(day(14, 9)) });
  post("Social/OSMM launch/OSMM launch – Hacker News.md", { campaign: "[[OSMM launch]]", platform: "hackernews", mode: "assisted", status: "idea", title: "Show HN: OSMM – plan social posts in Obsidian", channels: ["hn/you"] }, "");
  post("Social/OSMM launch/OSMM launch – Indie Hackers.md", { campaign: "[[OSMM launch]]", platform: "indiehackers", mode: "assisted", status: "ready", channels: ["ih/you"] }, "Building OSMM in public.\n");

  post("Social/Posts/Weekly devlog 12.md", { platform: "mastodon", title: "Weekly devlog #12", status: "published", channels: ["ma/you"], scheduled_at: iso(day(-8, 9)), deliveries: { "ma/you": { status: "published", url: "https://mastodon.social/@you/1" } } }, "Devlog #12: calendar view landed.\n");
  post("Social/Posts/WhatsApp reminder.md", { platform: "whatsapp", mode: "assisted", title: "WhatsApp reminder", status: "draft", channels: ["wa/makers-berlin"] }, "*Event X · 18:00* RSVP: example.com/event-x\n");

  if (opts.large) {
    const platforms: Array<[string, string]> = [["linkedin", "li/me"], ["x", "x/you"], ["instagram", "ig/acmestudio"], ["facebook", "fb/event-x-berlin"], ["mastodon", "ma/you"], ["bluesky", "bs/you"], ["telegram", "tg/event-x"], ["discord", "dc/maker-lab"], ["hackernews", "hn/you"]];
    for (let c = 0; c < 500; c++) {
      const title = `Bulk ${c}`;
      campaign(`Bulk/${title}`, title);
      platforms.forEach(([platform, channel], i) =>
        post(`Social/Bulk/${title}/${title} – ${platform}.md`, { campaign: `[[${title}]]`, platform, status: "draft", channels: [channel], scheduled_at: iso(now + ((c * 9 + i) % 90) * DAY + i * HOUR) }, `Bulk post ${c}/${i}\n`),
      );
    }
  }

  return { notes, settings: { schemaVersion: 1, rootFolder: "Social", channels: CHANNELS, channelGroups: GROUPS } };
}
```

- [ ] **Step 5: Implement `scripts/seed.ts`**

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { buildSeed } from "./seedData";

const vault = process.env.OSMM_DEV_VAULT ?? "dev-vault";
const large = process.argv.includes("--large");
const { notes, settings } = buildSeed(Date.now(), { large });

await rm(join(vault, "Social"), { recursive: true, force: true });
for (const note of notes) {
  const path = join(vault, note.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\n${YAML.stringify(note.frontmatter)}---\n${note.body}`);
}

const pluginDir = join(vault, ".obsidian", "plugins", "osmm-social-planner");
await mkdir(pluginDir, { recursive: true });
await writeFile(join(pluginDir, "data.json"), JSON.stringify(settings, null, 2));
await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["osmm-social-planner"]));

console.info(`Seeded ${notes.length} notes into ${vault}${large ? " (large)" : ""}. Run \`npm run dev\` and open the vault in Obsidian.`);
```

- [ ] **Step 6: Write the README**

`README.md`:
```markdown
# OSMM — Social Planner for Obsidian

Plan, preview, schedule and publish social media posts and WordPress articles from your vault.

- Design spec: `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md`
- Implementation plans: `docs/superpowers/plans/`

## Development

Requirements: Node 22+, Obsidian 1.11.4+.

    npm install
    npm run seed          # creates dev-vault/ with sample campaigns (add -- --large for 5,000 notes)
    npm run dev           # builds and copies the plugin into dev-vault/ on every change

Open `dev-vault/` as a vault in Obsidian and enable **Social Planner (OSMM)** under Community plugins.

    npm test              # unit tests (Vitest, TZ=Europe/Berlin)
    npm run typecheck && npm run lint
```

- [ ] **Step 7: Run the tests and the seed**

Run: `npx vitest run test/scripts/seedData.test.ts && npm run seed && ls dev-vault/Social/"Event X"`
Expected: PASS. The Event X folder lists the campaign and 9 variant notes.

- [ ] **Step 8: Run the complete verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: add dev vault seed with realistic fixtures (refs #7)"
```

---

## M1a Done Checklist

- [ ] All 19 tasks committed on `feat/m1a-core-engine`; `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] `npm run seed && npm run dev` loads the plugin in Obsidian 1.11.4+ with no console errors, and the settings tab shows the General section.
- [ ] Open a PR titled "M1a: core engine" that references #2 #3 #4 #5 #6 #7 #9 #11 #12 #13 #14 #15 #16 #18 #19 #20 #22 #23 #24.
