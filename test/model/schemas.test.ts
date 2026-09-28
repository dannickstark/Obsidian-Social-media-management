import { describe, expect, it } from "vitest";
import { zChannel, zChannelGroup, zMinutesList, zodIssues } from "../../src/model/schemas";

const channel = {
  id: "li/acme-studio",
  platform: "linkedin",
  name: "Acme Studio",
  kind: "page",
  avatarColor: "#6ea3e6",
  method: "assisted",
};

describe("zChannel", () => {
  it("accepts a valid channel", () => {
    expect(zChannel.safeParse(channel).success).toBe(true);
    expect(zChannel.safeParse({ ...channel, secretId: "osmm-channel-li-acme-studio", defaultTime: "09:00", defaultReminders: [60, 10] }).success).toBe(true);
  });

  it("requires the id prefix to match the platform", () => {
    const r = zChannel.safeParse({ ...channel, id: "fb/acme-studio" });
    expect(r.success).toBe(false);
    expect(zodIssues(r.error!)).toEqual([
      { level: "error", field: "id", message: 'Channel id must start with "li/" for LinkedIn' },
    ]);
  });

  it.each([
    [{ name: "  " }, "name"],
    [{ id: "li/Acme" }, "id"],
    [{ avatarColor: "blue" }, "avatarColor"],
    [{ secretId: "Bad Secret" }, "secretId"],
    [{ defaultTime: "9:00" }, "defaultTime"],
    [{ kind: "shop" }, "kind"],
  ])("rejects %o on field %s", (patch, field) => {
    const r = zChannel.safeParse({ ...channel, ...patch });
    expect(r.success).toBe(false);
    expect(zodIssues(r.error!).map((i) => i.field)).toContain(field);
  });
});

describe("zChannelGroup", () => {
  it("accepts a group of channel ids", () => {
    expect(zChannelGroup.safeParse({ id: "all-linkedin-pages", name: "All LinkedIn pages", channelIds: ["li/acme-studio"] }).success).toBe(true);
  });
  it("rejects bad group ids", () => {
    expect(zChannelGroup.safeParse({ id: "All Pages", name: "x", channelIds: [] }).success).toBe(false);
  });
});

describe("zMinutesList", () => {
  it("coerces numeric strings", () => {
    expect(zMinutesList.parse(["60", 10])).toEqual([60, 10]);
  });
  it("rejects negatives", () => {
    expect(zMinutesList.safeParse([-5]).success).toBe(false);
  });
});
