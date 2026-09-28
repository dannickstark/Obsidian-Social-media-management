import { header, send, type HttpFn } from "./http";

/** A link preview: what Bluesky's external embed and the previews show (#93). */
export interface LinkCard {
  url: string;
  title: string;
  description: string;
  image?: string;
  siteName?: string;
}

export const CARD_TIMEOUT_MS = 8_000;
export const CARD_TTL_MS = 60 * 60_000;
export const CARD_FAILURE_TTL_MS = 5 * 60_000;
export const CARD_CACHE_SIZE = 100;
/** Only the start of a page is read: the head is at the top, and the cap bounds the response we buffer. */
const MAX_HTML = 512 * 1024;
/** https only (SSRF guard, spec §4.1): the fetcher never follows a plain http(s):// link, let alone anything else. */
const HTTPS_URL = /^https:\/\//i;

/**
 * SSRF guard: refuses a host that resolves inside the machine or the local network without ever making a request.
 * This is a conservative literal/textual check on the hostname as written in the URL (loopback, RFC1918, link-local
 * incl. cloud metadata 169.254.169.254, IPv6 loopback and `.local` mDNS names) — it does not resolve DNS, so a
 * public name that happens to resolve to a private address is not caught here.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 0) return true;
  }
  return false;
}

/** A URL this fetcher is willing to request: https only, and never a private/loopback/link-local host. */
function isFetchable(url: string): boolean {
  if (!HTTPS_URL.test(url)) return false;
  try {
    return !isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function absolute(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base).toString();
    // The og:image URL must itself be https (spec §4.1): never http, javascript:, data: or anything else.
    return HTTPS_URL.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strips markup (any residual tags) and control characters, then clips to `max` characters. A NUL byte in an HTML
 * attribute is replaced with U+FFFD by the parser itself, so that is stripped too.
 */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f-\u009f�]/g, "");
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Reads OpenGraph, then Twitter tags, then the title and meta description; the host when a page has none. */
export function parseLinkCard(html: string, url: string): LinkCard {
  const doc = new DOMParser().parseFromString(html.slice(0, MAX_HTML), "text/html");
  const meta = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const title = meta("og:title", "twitter:title") ?? (doc.querySelector("title")?.textContent?.trim() || hostOf(url));
  const description = meta("og:description", "twitter:description", "description") ?? "";
  const raw = meta("og:image", "og:image:url", "twitter:image");
  const image = raw ? absolute(raw, url) : undefined;
  const siteName = meta("og:site_name");
  return { url, title: clean(title, 300), description: clean(description, 1000), ...(image ? { image } : {}), ...(siteName ? { siteName } : {}) };
}

/**
 * Fetches link cards with requestUrl, with a timeout, a size cap, a cache and one request per link at a time. Never
 * rejects and never sends any credential: only a GET with an Accept header, https only, private/loopback hosts
 * refused (SSRF guard). A fetch failure never blocks a post — it resolves to null, meaning "no card".
 */
export class LinkCardFetcher {
  private readonly cache = new Map<string, { card: LinkCard | null; until: number }>();
  private readonly pending = new Map<string, Promise<LinkCard | null>>();

  constructor(private readonly deps: { http: HttpFn; now(): number; timeoutMs?: number }) {}

  /** The cached answer: a card, null when the last fetch failed, undefined when there is none (or it expired). */
  peek(url: string): LinkCard | null | undefined {
    const hit = this.cache.get(url);
    if (!hit) return undefined;
    if (hit.until <= this.deps.now()) {
      this.cache.delete(url);
      return undefined;
    }
    return hit.card;
  }

  get(url: string): Promise<LinkCard | null> {
    const cached = this.peek(url);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!isFetchable(url)) return Promise.resolve(null);
    const running = this.pending.get(url);
    if (running) return running;
    const task = this.fetch(url).then((card) => {
      this.pending.delete(url);
      this.remember(url, card);
      return card;
    });
    this.pending.set(url, task);
    return task;
  }

  private remember(url: string, card: LinkCard | null): void {
    this.cache.delete(url);
    this.cache.set(url, { card, until: this.deps.now() + (card ? CARD_TTL_MS : CARD_FAILURE_TTL_MS) });
    while (this.cache.size > CARD_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetch(url: string): Promise<LinkCard | null> {
    try {
      // No credential is ever sent: no Authorization/Cookie header, and requestUrl carries none by default.
      const res = await send(this.deps.http, { url, method: "GET", headers: { Accept: "text/html,application/xhtml+xml" } }, this.deps.timeoutMs ?? CARD_TIMEOUT_MS);
      if (res.status < 200 || res.status >= 300) return null;
      if (!/html/i.test(header(res.headers, "content-type") ?? "")) return { url, title: hostOf(url), description: "" };
      return parseLinkCard(res.text, url);
    } catch {
      // A fetch failure (timeout, connection error) never blocks a post: it falls back to no card.
      return null;
    }
  }
}
