import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { writable } from "svelte/store";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import type { McpStatus } from "../../src/mcp/service";
import { mcpStatusText } from "../../src/settings/tab";
import { makeCtx } from "../ui/ctx";

describe("Claude Code status light (#73)", () => {
  it("shows the server state in the sidebar", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const status = writable<McpStatus>({ state: "on", port: 27150 });
    const { container } = render(Sidebar, { context: osmmContext({ ...ctx, mcp: { status } }) });
    const light = () => container.querySelector(".osmm-mcp-status");
    expect(light()?.textContent).toContain("Claude Code: ready on port 27150");
    expect(light()?.getAttribute("data-state")).toBe("on");
    status.set({ state: "error", message: "Port 27150 is already in use." });
    await tick();
    expect(light()?.textContent).toContain("Claude Code: not running");
    status.set({ state: "unavailable" });
    await tick();
    expect(light()).toBeNull();
  });

  it("shows nothing when the plugin has no server (phones, tests)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const { container } = render(Sidebar, { context: osmmContext(ctx) });
    expect(container.querySelector(".osmm-mcp-status")).toBeNull();
  });
});

describe("mcpStatusText", () => {
  it("describes the state, the last call and the last refusal", () => {
    const at = Date.UTC(2026, 9, 8, 12, 5);
    expect(mcpStatusText({ state: "on", port: 27150 }, { last: { at, label: "create_variant" }, refused: { at, status: 401 } })).toBe(
      "Running on 127.0.0.1:27150. Last request from Claude: create_variant at 14:05. Last refused request at 14:05 (missing or wrong token).",
    );
    expect(mcpStatusText({ state: "error", message: "Port 27150 is already in use." }, { last: null, refused: null })).toBe("Not running: Port 27150 is already in use.");
  });
});
