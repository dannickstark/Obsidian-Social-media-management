import { describe, expect, it } from "vitest";
import { allSecretIds, SecretIds, Secrets, toSecretId } from "../../src/secrets/secrets";
import { createApp } from "../helpers";

describe("secret ids", () => {
  it("builds valid ids from channel ids", () => {
    expect(SecretIds.channel("li/acme-studio")).toBe("osmm-channel-li-acme-studio");
    expect(toSecretId("osmm", "WP", "blog.osmm.app")).toBe("osmm-wp-blog-osmm-app");
  });

  it("throws when nothing usable remains", () => {
    expect(() => toSecretId("//", "--")).toThrow();
  });

  it("lists every secret id the plugin may hold, for redaction", () => {
    const channel = { id: "tg/event-x", platform: "telegram", name: "Event X", kind: "server_channel", avatarColor: "#000", method: "api", secretId: "osmm-channel-tg-event-x" } as never;
    expect(allSecretIds([channel])).toEqual(["osmm-channel-tg-event-x", "osmm-ntfy-topic", "osmm-ntfy-token", "osmm-openai-key", "osmm-mcp-bearer"]);
  });
});

describe("Secrets", () => {
  it("stores, reads and clears secrets per device", () => {
    const secrets = new Secrets(createApp());
    const id = SecretIds.channel("tg/event-x");
    expect(secrets.has(id)).toBe(false);
    secrets.set(id, "123:abc");
    expect(secrets.get(id)).toBe("123:abc");
    secrets.clear(id);
    expect(secrets.get(id)).toBeNull();
  });

  it("rejects invalid ids", () => {
    expect(() => new Secrets(createApp()).set("Not Valid", "x")).toThrow(/Invalid secret id/);
  });

  it("redacts known secret values from text", () => {
    const secrets = new Secrets(createApp());
    secrets.set(SecretIds.openaiKey, "sk-live-1234567890");
    expect(secrets.redact("401 for key sk-live-1234567890 on /v1/images", [SecretIds.openaiKey])).toBe("401 for key ••• on /v1/images");
  });
});
