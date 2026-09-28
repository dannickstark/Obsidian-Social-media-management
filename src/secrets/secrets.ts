import type { App } from "obsidian";
import type { Channel } from "../model/types";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function toSecretId(...parts: string[]): string {
  const id = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ID_RE.test(id)) throw new Error(`Cannot build a secret id from "${parts.join(", ")}"`);
  return id;
}

export const SecretIds = {
  channel: (channelId: string) => toSecretId("osmm", "channel", channelId),
  ntfyTopic: "osmm-ntfy-topic",
  ntfyToken: "osmm-ntfy-token",
  openaiKey: "osmm-openai-key",
  mcpBearer: "osmm-mcp-bearer",
} as const;

/** Every secret id the plugin may hold; text that leaves the plugin (log, notices) is redacted against all of them. */
export function allSecretIds(channels: readonly Channel[]): string[] {
  const ids = channels.flatMap((c) => (c.secretId ? [c.secretId] : []));
  return [...new Set([...ids, SecretIds.ntfyTopic, SecretIds.ntfyToken, SecretIds.openaiKey, SecretIds.mcpBearer])];
}

/** Thin wrapper over Obsidian's per-device secret storage (ADR 0001). */
export class Secrets {
  constructor(private readonly app: App) {}

  get(id: string): string | null {
    const value = this.app.secretStorage.getSecret(id);
    return value ? value : null;
  }

  set(id: string, value: string): void {
    if (!ID_RE.test(id)) throw new Error(`Invalid secret id "${id}"`);
    this.app.secretStorage.setSecret(id, value);
  }

  clear(id: string): void {
    this.set(id, "");
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  redact(text: string, ids: readonly string[]): string {
    let out = text;
    for (const id of ids) {
      const value = this.get(id);
      if (value && value.length >= 4) out = out.split(value).join("•••");
    }
    return out;
  }
}
