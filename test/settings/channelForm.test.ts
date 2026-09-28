import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { SecretComponent } from "../fakes/obsidian";
import ChannelForm from "../../src/settings/ChannelForm.svelte";
import ChannelsSection from "../../src/settings/ChannelsSection.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("ChannelForm", () => {
  it("suggests an id from the name and saves a valid channel with its secret id", async () => {
    const { ctx } = await makeCtx();
    const close = vi.fn();
    render(ChannelForm, { props: { close }, context: osmmContext(ctx) });
    await fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "telegram" } });
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Launch Updates" } });
    expect((screen.getByLabelText("Channel id") as HTMLInputElement).value).toBe("tg/launch-updates");
    await SecretComponent.last!.change("osmm-channel-tg-launch-updates");
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("tg/launch-updates")).toMatchObject({ platform: "telegram", name: "Launch Updates", secretId: "osmm-channel-tg-launch-updates" });
    expect(close).toHaveBeenCalled();
  });

  it("shows validation issues", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("Name is required");
  });

  it("refuses to add a channel whose id already exists (G4)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const existing = ctx.channels.get("li/acme-studio")!;
    const close = vi.fn();
    render(ChannelForm, { props: { close }, context: osmmContext(ctx) });
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Imposter" } });
    await fireEvent.input(screen.getByLabelText("Channel id"), { target: { value: "li/acme-studio" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("id: A channel with this id already exists");
    expect(ctx.channels.get("li/acme-studio")).toEqual(existing);
    expect(close).not.toHaveBeenCalled();
  });

  it("makes the channel id read-only when editing (G4)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const channel = ctx.channels.get("li/acme-studio")!;
    render(ChannelForm, { props: { channel, close: () => {} }, context: osmmContext(ctx) });
    expect((screen.getByLabelText("Channel id") as HTMLInputElement).readOnly).toBe(true);
  });

  it("saves a character limit for Mastodon channels only (#41)", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    expect(screen.queryByLabelText("Character limit")).toBeNull();
    await fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "mastodon" } });
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Fosstodon" } });
    await fireEvent.input(screen.getByLabelText("Character limit"), { target: { value: "1000" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("ma/fosstodon")?.maxChars).toBe(1000);
  });
});

describe("ChannelsSection", () => {
  it("lists channels grouped by platform and removes after confirmation, warning about usage", async () => {
    const { ctx } = await makeCtx({ seed: true });
    let asked = "";
    ctx.actions.confirm = async (message) => {
      asked = message;
      return true;
    };
    render(ChannelsSection, { context: osmmContext(ctx) });
    expect(screen.getByRole("heading", { name: "LinkedIn" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Remove Acme Studio" }));
    expect(asked).toMatch(/used by 1 note/);
    expect(ctx.channels.get("li/acme-studio")).toBeUndefined();
  });
});
