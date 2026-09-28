import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import Checks from "../../src/composer/Checks.svelte";
import { slugify } from "../../src/composer/fixes";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

async function renderChecks(c: TestCtx, path: string) {
  const v = c.index.getVariant(path)!;
  const content = await c.ctx.composer.content.load(v);
  return render(Checks, {
    props: { variant: v, issues: c.ctx.composer.check(v, content), counters: c.ctx.composer.counters(v, content) },
    context: osmmContext(c.ctx),
  });
}

async function frontmatter(c: TestCtx, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("slugify", () => {
  it.each([
    ["We're hosting Event X again", "we-re-hosting-event-x-again"],
    ["Café à Berlin!", "cafe-a-berlin"],
    ["  --  ", ""],
  ])("%s → %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });
});

describe("Checks", () => {
  it("shows counters and says when there is nothing to fix", async () => {
    const c = await makeCtx({ seed: true });
    await renderChecks(c, "Social/Event X/Event X – Hacker News.md");
    const panel = screen.getByRole("region", { name: "Checks" });
    expect(panel.textContent).toContain("Title");
    expect(panel.textContent).toContain("47/80");
    expect(panel.textContent).toContain("No problems found.");
  });

  it("lists blocking issues and fills the url from the campaign link", async () => {
    const path = "Social/Event X/Event X – HN 2.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "hackernews", channels: ["hn/you"], title: "Show HN: Event X" } }],
    });
    await renderChecks(c, path);
    expect(screen.getByRole("region", { name: "Checks" }).textContent).toContain("Blocking · 1");
    await fireEvent.click(screen.getByRole("button", { name: "Use the campaign link" }));
    await indexed(c.index, () => c.index.getVariant(path)?.url === "https://example.com/event-x");
    expect(c.index.getVariant(path)?.url).toBe("https://example.com/event-x");
  });

  it("suggests a slug from the title, with undo", async () => {
    const path = "Social/Posts/Article.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "wordpress", channels: ["wp/eventx-berlin"], title: "We're back" }, body: "Hello" }],
    });
    await renderChecks(c, path);
    await fireEvent.click(screen.getByRole("button", { name: 'Use slug "we-re-back"' }));
    await vi.waitFor(async () => expect((await frontmatter(c, path)).slug).toBe("we-re-back"));
    Notice.last!.noticeEl.querySelector("button")!.click();
    await vi.waitFor(async () => expect((await frontmatter(c, path)).slug).toBeUndefined());
  });

  it("separates blocking from advisory issues", async () => {
    const path = "Social/Posts/Linky.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me"] }, body: `${"a".repeat(3001)} https://example.com` }],
    });
    await renderChecks(c, path);
    const panel = screen.getByRole("region", { name: "Checks" });
    expect(panel.textContent).toContain("Blocking · 1");
    expect(panel.textContent).toContain("Advisory · 1");
  });
});
