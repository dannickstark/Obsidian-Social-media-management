import { randomString } from "../../model/ids";
import { SecretIds, type Secrets } from "../../secrets/secrets";
import type { DeviceSettings } from "../../settings/device";

export interface NtfyConfig {
  /** Normalized, without a trailing slash. */
  server: string;
  topic: string;
  token: string | null;
}

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
/** ntfy topic names: letters, digits, - and _, at most 64 characters. */
export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export function normalizeServer(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash || !url.host) return null;
  return s;
}

/** A long random topic: on a public server, anyone who knows the topic can read the pushes (#71). */
export function randomTopic(): string {
  return `osmm-${randomString(24)}`;
}

/** Where pushes go: the device's server plus the topic and token from secret storage. Null until usable. */
export function ntfyTarget(device: Pick<DeviceSettings, "ntfy">, secrets: Pick<Secrets, "get">): NtfyConfig | null {
  const server = normalizeServer(device.ntfy.server);
  const topic = secrets.get(SecretIds.ntfyTopic);
  if (!server || !topic || !TOPIC_RE.test(topic)) return null;
  return { server, topic, token: secrets.get(SecretIds.ntfyToken) };
}
