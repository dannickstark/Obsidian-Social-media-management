import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { App } from "../fakes/obsidian";
import { ChannelRegistry } from "../../src/channels/registry";
import {
  DEFAULT_VIEW_STATE,
  activeFilterCount,
  sanitizeViewState,
  toRowFilter,
  toggle,
  viewStateStore,
} from "../../src/planner/viewState";

describe("view state", () => {
  it("sanitizes unknown or partial data", () => {
    expect(sanitizeViewState(null)).toEqual(DEFAULT_VIEW_STATE);
    expect(sanitizeViewState({ mode: "timeline", filter: { platforms: ["linkedin", "myspace"], statuses: ["published", "posted"], channels: [1, "li/me"] } })).toEqual({
      mode: "month",
      filter: { platforms: ["linkedin"], channels: ["li/me"], campaigns: [], statuses: ["published"] },
    });
  });

  it("persists to device-local storage", () => {
    const app = new App();
    const store = viewStateStore(app as never);
    store.update((s) => ({ ...s, mode: "board" }));
    expect(get(viewStateStore(app as never)).mode).toBe("board");
  });

  it("toggles values and counts active filters", () => {
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(activeFilterCount({ platforms: ["x"], channels: [], campaigns: ["", "c.md"], statuses: [] })).toBe(3);
  });

  it("expands channel groups and ignores deleted channels (review focus 4)", () => {
    const registry = new ChannelRegistry({
      read: () => ({
        channels: [
          { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" },
          { id: "li/acme", platform: "linkedin", name: "Acme", kind: "page", avatarColor: "#6ea3e6", method: "assisted" },
        ],
        channelGroups: [{ id: "pages", name: "Pages", channelIds: ["li/acme"] }],
      }),
      write: async () => {},
    });
    expect(toRowFilter({ platforms: [], channels: ["group:pages", "li/me"], campaigns: [], statuses: [] }, registry).channelIds).toEqual(["li/acme", "li/me"]);
    expect(toRowFilter({ platforms: [], channels: ["li/deleted"], campaigns: [], statuses: [] }, registry).channelIds).toEqual([]);
  });
});
