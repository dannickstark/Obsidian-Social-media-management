import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { requestUrlMock, SecretComponent } from "../fakes/obsidian";
import ChannelForm from "../../src/settings/ChannelForm.svelte";
import ChannelsSection from "../../src/settings/ChannelsSection.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { TelegramAdapter } from "../../src/platforms/telegram/api";
import { contractDeps } from "../platforms/contract/harness";
import { json, queue } from "../platforms/http";
import { TG, TG_TOKEN } from "../platforms/telegram/fixtures";
import { createAdapters } from "../../src/platforms/adapters";
import { before as facebookBefore, PAGE_TOKEN, USER_TOKEN, PAGE } from "../platforms/facebook/contract";

describe("ChannelForm", () => {
  const pick = (value: string) => fireEvent.change(screen.getByLabelText("Platform"), { target: { value } });
  const methods = () => [...(screen.getByLabelText("Publishing") as HTMLSelectElement).options].map((o) => o.value);

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

  it("offers only the publishing methods the platform supports (M5)", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("hackernews");
    expect(methods()).toEqual(["assisted"]);
    await pick("telegram");
    expect(methods()).toEqual(["api", "assisted"]);
    await pick("wordpress");
    expect(methods()).toEqual(["api", "native", "assisted"]);
  });

  it("saves a WordPress site address and user name, and refuses a site without https", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("wordpress");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Event X blog" } });
    await fireEvent.input(screen.getByLabelText("Site address (https://…)"), { target: { value: "http://eventx.berlin" } });
    await fireEvent.input(screen.getByLabelText("User name"), { target: { value: "editor" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("server: Use an https:// address");
    await fireEvent.input(screen.getByLabelText("Site address (https://…)"), { target: { value: "https://eventx.berlin/" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("wp/event-x-blog")).toMatchObject({ server: "https://eventx.berlin", login: "editor" });
  });

  it("saves Discord's post-as name and avatar", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("discord");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "News" } });
    await fireEvent.input(screen.getByLabelText("Post as name (optional)"), { target: { value: "Event X" } });
    await fireEvent.input(screen.getByLabelText("Post as avatar URL (optional)"), { target: { value: "https://event.example/logo.png" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(ctx.channels.get("dc/news")).toMatchObject({ postAsName: "Event X", postAsAvatar: "https://event.example/logo.png" });
  });

  it("refuses a Discord post-as name that Discord will reject", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("discord");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "News" } });
    await fireEvent.input(screen.getByLabelText("Post as name (optional)"), { target: { value: "@everyone" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    expect(screen.getByRole("alert").textContent).toContain("postAsName: Discord won't accept this post-as name");
    expect(ctx.channels.get("dc/news")).toBeUndefined();
  });

  it("tests the connection with this device's credential, and never shows the secret", async () => {
    const c = await makeCtx({ seed: true });
    c.app.secretStorage.setSecret("osmm-channel-tg-event-x", "SECRET-TOKEN-1234");
    c.adapters.register({ platform: "telegram", verify: async (_channel, secret) => ({ ok: false, error: `Telegram refused ${secret ?? ""}` }) });
    const channel = { ...c.ctx.channels.get("tg/event-x")!, handle: "@eventx", secretId: "osmm-channel-tg-event-x" };
    render(ChannelForm, { props: { channel, close: () => {} }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toBe("Telegram refused •••");
  });

  it("shows the account when the connection works", async () => {
    const c = await makeCtx({ seed: true });
    c.adapters.register({ platform: "telegram", verify: async () => ({ ok: true, account: "Event X, posting as @osmm_bot" }) });
    render(ChannelForm, { props: { channel: c.ctx.channels.get("tg/event-x")!, close: () => {} }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toBe("Connected: Event X, posting as @osmm_bot");
  });

  it("has no Test connection where the plugin has no API adapter", async () => {
    const { ctx } = await makeCtx();
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(ctx) });
    await pick("hackernews");
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("finds a Telegram chat id from what the bot has seen only after the user asks", async () => {
    const c = await makeCtx({ seed: true });
    c.app.secretStorage.setSecret("osmm-channel-tg-event-x", TG_TOKEN);
    c.adapters.register(new TelegramAdapter(contractDeps()));
    const channel = { ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" };
    render(ChannelForm, { props: { channel, close: () => {} }, context: osmmContext(c.ctx) });
    expect(requestUrlMock.calls).toHaveLength(0);
    queue(json(200, TG.getUpdates));
    await fireEvent.click(screen.getByRole("button", { name: "Find chat id" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use Event X (@eventx)" }));
    expect((screen.getByLabelText("Chat id (@name or -100…)") as HTMLInputElement).value).toBe("@eventx");
  });

  it("discovers Facebook Pages with a supplied token, verifies permissions, and saves only the Page id and credential reference", async () => {
    const c = await makeCtx();
    for (const a of createAdapters(contractDeps())) c.adapters.register(a);
    c.app.secretStorage.setSecret("fb-token", USER_TOKEN);
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(c.ctx) });
    await pick("facebook");
    expect(methods()).toEqual(["assisted"]);
    expect(screen.getByText(/OAuth.*unverified/)).toBeTruthy();
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "My Page" } });
    await SecretComponent.last!.change("fb-token");
    expect(requestUrlMock.calls).toHaveLength(0);
    queue(...facebookBefore());
    await fireEvent.click(screen.getByRole("button", { name: "Find Facebook Pages" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use Event X" }));
    expect((screen.getByLabelText("Page id") as HTMLInputElement).value).toBe("11");
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("page");
    expect(methods()).toEqual(["api", "native", "assisted"]);
    expect(screen.queryByText(/^Connected:/)).toBeNull();
    await fireEvent.change(screen.getByLabelText("Publishing"), { target: { value: "native" } });
    queue(...facebookBefore());
    await fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
    await waitFor(() =>
      expect(c.ctx.channels.get("fb/my-page")).toMatchObject({
        handle: "11",
        kind: "page",
        method: "native",
        secretId: "fb-token",
      }),
    );
    expect(JSON.stringify(c.ctx.channels.get("fb/my-page"))).not.toContain(USER_TOKEN);
    expect(document.body.textContent).not.toContain(PAGE_TOKEN);
  });

  it("keeps Facebook assisted when permissions are missing and invalidates selection on credential changes", async () => {
    const c = await makeCtx();
    for (const a of createAdapters(contractDeps())) c.adapters.register(a);
    c.app.secretStorage.setSecret("fb-token", USER_TOKEN);
    render(ChannelForm, { props: { close: () => {} }, context: osmmContext(c.ctx) });
    await pick("facebook");
    await SecretComponent.last!.change("fb-token");
    queue(json(200, { data: [PAGE] }), json(200, { data: [] }));
    await fireEvent.click(screen.getByRole("button", { name: "Find Facebook Pages" }));
    await fireEvent.click(await screen.findByRole("button", { name: /Use Event X/ }));
    expect(methods()).toEqual(["assisted"]);
    queue(...facebookBefore());
    await fireEvent.click(screen.getByRole("button", { name: "Find Facebook Pages" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use Event X" }));
    expect(methods()).toEqual(["api", "native", "assisted"]);
    await SecretComponent.last!.change("other-token");
    expect(methods()).toEqual(["assisted"]);
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
