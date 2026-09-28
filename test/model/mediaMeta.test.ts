import { describe, expect, it } from "vitest";
import { parseVariant, variantFields } from "../../src/model/frontmatter";
import { SafeWriter } from "../../src/model/writer";
import { createApp, writeNote } from "../helpers";

const base = { type: "social-post", platform: "instagram", channels: ["ig/acmestudio"] };

describe("media_meta", () => {
  it("reads alt text and focal points keyed by link target", () => {
    const r = parseVariant(
      { ...base, media_meta: { "cover.png": { alt: " Makers ", focus: "0.5, 0.3" }, "[[b.png]]": { focus: [0.2, 0.8] } } },
      "p.md",
    );
    expect(r.value?.mediaMeta).toEqual({ "cover.png": { alt: "Makers", focus: [0.5, 0.3] }, "b.png": { focus: [0.2, 0.8] } });
    expect(r.issues).toEqual([]);
  });

  it("ignores badly shaped entries with a warning and keeps the valid parts (review focus 3)", () => {
    const wrongType = parseVariant({ ...base, media_meta: "cover.png" }, "p.md");
    expect(wrongType.value?.mediaMeta).toBeUndefined();
    expect(wrongType.issues).toEqual([{ level: "warning", field: "media_meta", message: "media_meta must be a map of image → { alt, focus }" }]);

    const badFocus = parseVariant({ ...base, media_meta: { "a.png": { alt: "Crowd", focus: "0.5, 2" }, "b.png": { alt: "" } } }, "p.md");
    expect(badFocus.value?.mediaMeta).toEqual({ "a.png": { alt: "Crowd" }, "b.png": {} });
    expect(badFocus.issues).toEqual([
      { level: "warning", field: "media_meta.a.png.focus", message: "focus must be two numbers between 0 and 1, e.g. 0.5, 0.3" },
    ]);
  });

  it("serializes with rounded focus and drops empty entries", () => {
    expect(variantFields({ mediaMeta: { "a.png": { alt: "A", focus: [0.123, 0.5] }, "b.png": {} } })).toEqual({
      media_meta: { "a.png": { alt: "A", focus: [0.12, 0.5] } },
    });
    expect(variantFields({ mediaMeta: {} })).toEqual({ media_meta: undefined });
  });

  it("round-trips through SafeWriter", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Posts/P.md", base, "Hi\n");
    const writer = new SafeWriter(app as never);
    await writer.updateVariant(file as never, () => ({ fields: { mediaMeta: { "cover.png": { alt: "Makers", focus: [0.25, 0.75] } } } }));
    const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
    expect(fm.media_meta).toEqual({ "cover.png": { alt: "Makers", focus: [0.25, 0.75] } });
    expect(parseVariant(fm, file.path).value?.mediaMeta).toEqual({ "cover.png": { alt: "Makers", focus: [0.25, 0.75] } });
  });
});
