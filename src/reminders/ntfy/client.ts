import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { isRecord } from "../../model/frontmatter";
import type { NtfyConfig } from "./config";

export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | { action: "http"; label: string; url: string; method?: string; headers?: Record<string, string>; body?: string; clear?: boolean };

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** Opened when the notification itself is tapped. */
  click?: string;
  /** ntfy shows at most three. */
  actions?: NtfyAction[];
  /** Delivery time (epoch ms); sent at once when absent or less than 10 s ahead. */
  at?: number;
}

export type NtfyErrorKind = "setup" | "auth" | "rate_limited" | "rejected" | "unreachable" | "server";

/** A failed ntfy call. The message is safe to show: it never contains the topic or the token. */
export class NtfyError extends Error {
  constructor(
    readonly kind: NtfyErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "NtfyError";
  }
}

/**
 * "cancelled": the push is withdrawn. "gone": the server no longer has it (404). "unsupported": the server can't
 * cancel pushes at all (405/501). "refused": the server turned down this cancel (other 4xx, or a malformed id).
 * With "unsupported" and "refused" the push still arrives.
 */
export type CancelOutcome = "cancelled" | "gone" | "unsupported" | "refused";

export type Http = (req: RequestUrlParam) => Promise<RequestUrlResponse>;

/** ntfy.sh's minimum delay; a push due sooner is sent without one. */
export const MIN_DELAY_MS = 10_000;
const MAX_ACTIONS = 3;
const MESSAGE_ID_RE = /^[A-Za-z0-9]{1,64}$/;

export function testMessage(): NtfyMessage {
  return { title: "Social Planner test", message: "Phone reminders work. Reminders for your posts will arrive here.", priority: 3, tags: ["osmm"] };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Publishes to ntfy.sh or a self-hosted server with Obsidian's requestUrl (works on mobile, #68). */
export class NtfyClient {
  constructor(
    private readonly target: () => NtfyConfig | null,
    private readonly http: Http = (req) => requestUrl(req),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async publish(msg: NtfyMessage): Promise<{ id: string; at: number }> {
    const c = this.require();
    const body: Record<string, unknown> = { topic: c.topic, title: msg.title, message: msg.message };
    if (msg.priority) body.priority = msg.priority;
    if (msg.tags?.length) body.tags = msg.tags;
    if (msg.click) body.click = msg.click;
    if (msg.actions?.length) body.actions = msg.actions.slice(0, MAX_ACTIONS);
    const delayed = msg.at !== undefined && msg.at - this.now() >= MIN_DELAY_MS;
    if (delayed) body.delay = String(Math.floor(msg.at! / 1000));
    const res = await this.send(c, { url: `${c.server}/`, method: "POST", contentType: "application/json", headers: this.headers(c), body: JSON.stringify(body) });
    const json = parseJson(res.text);
    if (!isRecord(json) || typeof json.id !== "string") throw new NtfyError("server", "The ntfy server sent an unexpected reply.");
    const time = typeof json.time === "number" ? json.time * 1000 : this.now();
    return { id: json.id, at: delayed ? msg.at! : time };
  }

  /** Cancels a delayed push (see CancelOutcome). */
  async cancel(id: string): Promise<CancelOutcome> {
    const c = this.require();
    if (!MESSAGE_ID_RE.test(id)) return "refused";
    try {
      await this.send(c, { url: `${c.server}/${c.topic}/${id}`, method: "DELETE", headers: this.headers(c) });
      return "cancelled";
    } catch (e) {
      if (!(e instanceof NtfyError)) throw e;
      if (e.status === 405 || e.status === 501) return "unsupported";
      if (e.status === 404) return "gone";
      if (e.kind === "rejected") return "refused";
      throw e;
    }
  }

  private require(): NtfyConfig {
    const c = this.target();
    if (!c) throw new NtfyError("setup", "Phone reminders aren't set up yet: choose a server and a topic in the settings.");
    return c;
  }

  private headers(c: NtfyConfig): Record<string, string> {
    return c.token ? { Authorization: `Bearer ${c.token}` } : {};
  }

  private async send(c: NtfyConfig, req: RequestUrlParam): Promise<RequestUrlResponse> {
    const scrub = (text: string) => [c.topic, c.token].reduce<string>((s, secret) => (secret ? s.split(secret).join("•••") : s), text);
    let res: RequestUrlResponse;
    try {
      res = await this.http({ ...req, throw: false });
    } catch {
      // The underlying error text can contain the URL, and so the topic: never pass it on.
      throw new NtfyError("unreachable", "Couldn't reach the ntfy server. Check the server address and the connection.");
    }
    if (res.status >= 200 && res.status < 300) return res;
    const json = parseJson(res.text);
    const detail = isRecord(json) && typeof json.error === "string" ? scrub(json.error).slice(0, 160) : "";
    if (res.status === 401 || res.status === 403) throw new NtfyError("auth", "The ntfy server refused this device: check the access token, or whether the topic is reserved by someone else.");
    if (res.status === 429) {
      const seconds = Number(header(res.headers, "retry-after"));
      throw new NtfyError("rate_limited", "The ntfy server is limiting how often this device can send.", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
    }
    if (res.status >= 500) throw new NtfyError("server", `The ntfy server had a problem (${res.status}).`, undefined, res.status);
    throw new NtfyError("rejected", `The ntfy server rejected the request (${res.status}${detail ? `: ${detail}` : ""}).`, undefined, res.status);
  }
}
