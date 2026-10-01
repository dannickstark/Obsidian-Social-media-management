import { describe, expect, it } from "vitest";
import { NeedsUserError } from "../../../src/platforms/errors";
import { AssistedOnlyInstagramMediaHost, validateInstagramMediaUrl } from "../../../src/platforms/instagram/media";

describe("Instagram media hosting", () => {
  it("explains that API publishing needs a provider reachable image host", async () => {
    await expect(
      new AssistedOnlyInstagramMediaHost().create(
        { name: "cover.png", mime: "image/png", data: new ArrayBuffer(8) },
        "page-token",
      ),
    ).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringContaining("assisted publishing"),
    });
  });

  it.each([
    "file:///Users/alice/Vault/cover.png",
    "https://user:secret@images.example/cover.png",
    "https://localhost/cover.png",
    "https://127.0.0.1/cover.png",
    "https://images.example/cover.png?access_token=secret",
    "https://images.example/Users/alice/Vault/cover.png",
    "https://images.example/%2555sers/alice/Vault/cover.png",
    "https://images.example/%252FUsers%252Falice%252FVault%252Fcover.png",
    "https://images.example/%255cUsers%255calice%255cVault%255ccover.png",
    "https://images.example/Users/alice/Desktop/cover.png",
    "https://images.example/home/alice/.obsidian/attachments/cover.png",
    "https://images.example/private/tmp/obsidian/vault/cover.png",
  ])("refuses a URL that could expose a vault path or credential: %s", (url) => {
    expect(() => validateInstagramMediaUrl(url)).toThrow(NeedsUserError);
  });

  it("accepts a public https image URL without URL credentials", () => {
    expect(validateInstagramMediaUrl("https://cdn.example.net/image/opaque-id.png")).toBe(
      "https://cdn.example.net/image/opaque-id.png",
    );
  });

  it("preserves a literal percent sign in a public image filename", () => {
    expect(validateInstagramMediaUrl("https://cdn.example.net/image/100%25complete.png")).toBe(
      "https://cdn.example.net/image/100%25complete.png",
    );
  });
});
