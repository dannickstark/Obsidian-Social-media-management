import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { Modal, Notice } from "../fakes/obsidian";
import { vi } from "vitest";
import { osmmContext } from "../../src/ui/context";
import PublisherBanner from "../../src/views/PublisherBanner.svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { settle } from "../helpers";
import { makeCtx } from "../ui/ctx";

describe("PublisherBanner", () => {
  it("says where publishing happens and offers a confirmed takeover", async () => {
    const c = await makeCtx();
    c.settings.update((s) => ({ ...s, publisher: { deviceId: "other", name: "Work laptop", since: 1 } }));
    render(Sidebar, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("status").textContent).toContain("Publishing happens on Work laptop.");
    await fireEvent.click(screen.getByRole("button", { name: "Publish from this device instead" }));
    (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
    await settle();
    expect(get(c.settings).publisher?.deviceId).toBe("test-device");
  });

  it("asks for a publisher when there is none, and disappears on the publisher", async () => {
    const c = await makeCtx();
    render(PublisherBanner, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("status").textContent).toContain("No device publishes scheduled posts yet");
    await fireEvent.click(screen.getByRole("button", { name: "Make this device the publisher" }));
    await settle();
    expect(c.publisher.isPublisher()).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a Notice when the takeover fails (final review 13)", async () => {
    const c = await makeCtx();
    vi.spyOn(c.publisher, "takeOver").mockRejectedValue(new Error("Couldn't save the settings."));
    Notice.messages = [];
    render(PublisherBanner, { context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Make this device the publisher" }));
    await settle();
    expect(Notice.messages).toEqual(["Couldn't make this device the publisher: Couldn't save the settings."]);
  });
});
