import { describe, expect, it } from "vitest";
import {
  linkTarget,
  parseCampaign,
  parseVariant,
  serializeDeliveries,
  socialKind,
  variantFields,
} from "../../src/model/frontmatter";

const base = {
  type: "social-post",
  campaign: "[[Event X]]",
  platform: "linkedin",
  channels: ["li/me", "li/acme-studio"],
  mode: "auto",
  status: "scheduled",
  scheduled_at: "2026-10-08T17:30:00+02:00",
  stagger_minutes: 15,
  reminders: [60, 10],
  media: ["[[event-x-cover.png]]"],
  deliveries: {
    "li/me": { status: "published", at: "2026-10-08T17:30:00+02:00", url: "https://www.linkedin.com/feed/update/1", remote_id: 1 },
    "li/acme-studio": { status: "awaiting_you", at: "2026-10-08T17:45:00+02:00" },
  },
};

describe("socialKind and linkTarget", () => {
  it("detects social notes", () => {
    expect(socialKind({ type: "social-campaign" })).toBe("campaign");
    expect(socialKind({ type: "social-post" })).toBe("post");
    expect(socialKind({ type: "note" })).toBeNull();
    expect(socialKind(null)).toBeNull();
  });

  it.each([
    ["[[Event X]]", "Event X"],
    ["[[Event X|the event]]", "Event X"],
    ["[[Social/Event X/Event X#Brief]]", "Social/Event X/Event X"],
    ["Event X", "Event X"],
    ["", undefined],
    [42, undefined],
  ])("linkTarget(%s) = %s", (input, expected) => {
    expect(linkTarget(input)).toBe(expected);
  });
});

describe("parseVariant", () => {
  it("parses the spec example", () => {
    const { value, issues } = parseVariant(base, "Social/Event X/Event X – LinkedIn.md");
    expect(issues).toEqual([]);
    expect(value).toMatchObject({
      platform: "linkedin",
      campaignLink: "Event X",
      channels: ["li/me", "li/acme-studio"],
      mode: "auto",
      status: "scheduled",
      scheduledAt: Date.UTC(2026, 9, 8, 15, 30),
      staggerMinutes: 15,
      reminders: [60, 10],
      media: ["event-x-cover.png"],
    });
    expect(value?.deliveries["li/me"]).toEqual({
      status: "published",
      at: Date.UTC(2026, 9, 8, 15, 30),
      url: "https://www.linkedin.com/feed/update/1",
      remoteId: "1",
    });
  });

  it("coerces hand-written shapes (review focus 1)", () => {
    const { value, issues } = parseVariant(
      { type: "social-post", platform: "linkedin", channels: "li/me", reminders: "60", stagger_minutes: "5" },
      "a.md",
    );
    expect(issues).toEqual([]);
    expect(value?.channels).toEqual(["li/me"]);
    expect(value?.reminders).toEqual([60]);
    expect(value?.staggerMinutes).toBe(5);
    expect(value?.mode).toBe("auto");
    expect(value?.status).toBe("draft");
  });

  it("returns null with an error when the platform is missing or unknown", () => {
    expect(parseVariant({ type: "social-post" }, "a.md")).toEqual({
      value: null,
      issues: [{ level: "error", field: "platform", message: "platform is required" }],
    });
    expect(parseVariant({ type: "social-post", platform: "myspace" }, "a.md").value).toBeNull();
  });

  it("drops channels of another platform with a warning", () => {
    const { value, issues } = parseVariant({ ...base, channels: ["li/me", "x/you", "not a channel"] }, "a.md");
    expect(value?.channels).toEqual(["li/me"]);
    expect(issues.map((i) => i.level)).toEqual(["warning", "warning", "warning"]);
  });

  it("reports invalid dates as errors and keeps the rest", () => {
    const { value, issues } = parseVariant({ ...base, scheduled_at: "next friday" }, "a.md");
    expect(value?.scheduledAt).toBeUndefined();
    expect(issues).toContainEqual({ level: "error", field: "scheduled_at", message: '"next friday" is not a valid date/time' });
  });

  it("skips deliveries with unknown statuses and warns about unknown channels", () => {
    const { value, issues } = parseVariant(
      { ...base, deliveries: { "li/me": { status: "posted" }, "li/old-page": { status: "published" } } },
      "a.md",
    );
    expect(Object.keys(value?.deliveries ?? {})).toEqual(["li/old-page"]);
    expect(issues.map((i) => i.field)).toEqual(["deliveries.li/me.status", "deliveries.li/old-page"]);
  });

  it("reads WordPress fields", () => {
    const { value } = parseVariant(
      { type: "social-post", platform: "wordpress", channels: ["wp/eventx-berlin"], slug: "hosting-event-x", categories: "Community", tags: ["events", "buildinpublic"], featured_image: "[[cover.png]]" },
      "a.md",
    );
    expect(value?.wordpress).toEqual({ slug: "hosting-event-x", categories: ["Community"], tags: ["events", "buildinpublic"], excerpt: undefined, featuredImage: "cover.png" });
  });
});

describe("parseCampaign", () => {
  it("uses the title or falls back to the file name", () => {
    expect(parseCampaign({ type: "social-campaign", anchor_date: "2026-10-12 18:00" }, "Social/Event X/Event X.md").value).toEqual({
      path: "Social/Event X/Event X.md",
      title: "Event X",
      anchorDate: Date.UTC(2026, 9, 12, 16, 0),
      link: undefined,
      status: "active",
    });
  });

  it("warns about an invalid link but keeps the campaign", () => {
    const { value, issues } = parseCampaign({ type: "social-campaign", title: "X", link: "not a url" }, "x.md");
    expect(value?.link).toBeUndefined();
    expect(issues[0]?.level).toBe("warning");
  });
});

describe("serialization", () => {
  it("round-trips a variant through variantFields", () => {
    const first = parseVariant(base, "a.md").value!;
    const fm = { type: "social-post", platform: "linkedin", campaign: "[[Event X]]", ...variantFields(first) };
    expect(parseVariant(fm, "a.md").value).toEqual(first);
  });

  it("marks cleared fields as undefined so writers delete them", () => {
    expect(variantFields({ scheduledAt: undefined, deliveries: {} })).toEqual({ scheduled_at: undefined, deliveries: undefined });
  });

  it("serializes deliveries with snake_case keys and ISO dates", () => {
    expect(serializeDeliveries({ "li/me": { status: "published", at: Date.UTC(2026, 9, 8, 15, 30), remoteId: "9" } })).toEqual({
      "li/me": { status: "published", at: "2026-10-08T17:30:00+02:00", remote_id: "9" },
    });
  });
});
