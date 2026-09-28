import { describe, expect, it } from "vitest";
import { App } from "./fakes/obsidian";
import OsmmPlugin from "../src/main";
import { indexed, writeNote } from "./helpers";

describe("commands", () => {
  it("registers the M1 commands", async () => {
    const app = new App();
    const plugin = new OsmmPlugin(app as never, { id: "osmm-social-planner", name: "", version: "", minAppVersion: "", description: "", author: "" });
    await plugin.load();
    const ids = (plugin as unknown as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    expect(ids).toEqual(["open-planner", "open-board", "open-sidebar", "new-campaign", "new-post", "new-variant-for-campaign"]);
    plugin.unload();
  });

  it("only offers 'new variant' when the active note is a campaign", async () => {
    const app = new App();
    const plugin = new OsmmPlugin(app as never, { id: "osmm-social-planner", name: "", version: "", minAppVersion: "", description: "", author: "" });
    await plugin.load();
    const cmd = (plugin as unknown as { commands: Array<{ id: string; checkCallback: (c: boolean) => boolean }> }).commands.find((c) => c.id === "new-variant-for-campaign")!;
    expect(cmd.checkCallback(true)).toBe(false);
    app.workspace.activeFile = (await writeNote(app as never, "Social/E/E.md", { type: "social-campaign", title: "E" })) as never;
    await indexed(plugin.index, () => cmd.checkCallback(true));
    expect(cmd.checkCallback(true)).toBe(true);
    plugin.unload();
  });
});
