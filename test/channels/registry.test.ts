import { describe, expect, it } from "vitest";
import { ChannelRegistry, type ChannelStore } from "../../src/channels/registry";
import type { Channel, ChannelGroup, Variant } from "../../src/model/types";

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

  it("createChannel refuses an id that already exists and leaves it unchanged (G4)", async () => {
    const store = memoryStore([me]);
    const reg = new ChannelRegistry(store);
    expect(await reg.createChannel({ ...me, name: "Other" })).toEqual({
      ok: false,
      issues: [{ level: "error", field: "id", message: "A channel with this id already exists" }],
    });
    expect(store.writes).toBe(0);
    expect(reg.get("li/me")).toEqual(me);
    expect(await reg.createChannel(acme)).toEqual({ ok: true, value: acme });
    expect(reg.list()).toEqual([me, acme]);
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
    const variants: Array<Pick<Variant, "path" | "channels" | "deliveries">> = [
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
