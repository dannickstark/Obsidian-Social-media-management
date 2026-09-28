import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import PvLinkCard from "../../src/previews/PvLinkCard.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("PvLinkCard", () => {
  it("renders an http(s) url as a link", () => {
    render(PvLinkCard, { props: { card: { url: "https://example.com/page", domain: "example.com" } } });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/page");
    expect(link.textContent).toContain("example.com");
  });

  it("renders a javascript: url as plain text with no link", () => {
    render(PvLinkCard, { props: { card: { url: "javascript:alert(1)", domain: "javascript:alert(1)" } } });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getAllByText("javascript:alert(1)").length).toBeGreaterThan(0);
  });

  it("shows the fetched title, description and image when the plugin has a card (#93)", async () => {
    const { ctx } = await makeCtx();
    const card = { url: "https://example.com/page", title: "Event X, Berlin", description: "Monthly makers evening", image: "https://example.com/cover.png" };
    ctx.linkCards = { peek: () => undefined, get: async () => card };
    const { container } = render(PvLinkCard, { props: { card: { url: card.url, domain: "example.com" } }, context: osmmContext(ctx) });
    expect(await screen.findByText("Event X, Berlin")).toBeTruthy();
    expect(screen.getByText("Monthly makers evening")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/cover.png");
  });

  it("keeps the plain card when no card could be fetched", async () => {
    const { ctx } = await makeCtx();
    ctx.linkCards = { peek: () => null, get: async () => null };
    const { container } = render(PvLinkCard, { props: { card: { url: "https://example.com/page", domain: "example.com" } }, context: osmmContext(ctx) });
    // The fetch is debounced (fix round 1): wait past the debounce window, not just a microtask turn.
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link").textContent).toContain("https://example.com/page");
  });

  it("debounces the fetch while the url is still being typed, one fetch after it settles (#93, fix round 1)", async () => {
    const { ctx } = await makeCtx();
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      ctx.linkCards = {
        peek: () => undefined,
        get: async (url: string) => {
          calls.push(url);
          return null;
        },
      };
      const target = "https://example.com/page";
      const { rerender } = render(PvLinkCard, { props: { card: { url: "h", domain: "" } }, context: osmmContext(ctx) });
      for (let i = 1; i <= target.length; i++) {
        await rerender({ card: { url: target.slice(0, i), domain: "example.com" } });
        await vi.advanceTimersByTimeAsync(50);
      }
      // Nothing fetched yet: the last keystroke reset the debounce timer, which hasn't elapsed.
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(800);
      expect(calls).toEqual([target]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fetches a host with no real-looking TLD, even once stable (#93, fix round 1)", async () => {
    const { ctx } = await makeCtx();
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      ctx.linkCards = {
        peek: () => undefined,
        get: async (url: string) => {
          calls.push(url);
          return null;
        },
      };
      render(PvLinkCard, { props: { card: { url: "https://localhost/x", domain: "localhost" } }, context: osmmContext(ctx) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
