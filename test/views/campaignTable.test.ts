import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { indexed } from "../helpers";

describe("CampaignTable", () => {
  it("renders variants and creates a missing one with all channels of that platform", async () => {
    const { app, ctx, index } = await makeCtx({ seed: true });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(ctx) });
    expect(screen.getByText(/9 created · 0 published · 1 overdue/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp variant" }));
    await indexed(index, () => index.getVariant("Social/Event X/Event X – WhatsApp.md") !== undefined);
    const created = index.getVariant("Social/Event X/Event X – WhatsApp.md");
    expect(created?.channels).toEqual(["wa/makers-berlin"]);
    expect(app.workspace.opened.at(-1)?.linktext).toBe("Social/Event X/Event X – WhatsApp.md");
  });
});
