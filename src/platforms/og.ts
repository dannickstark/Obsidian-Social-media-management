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
/**
 * Only the start of a page is read for parsing: the head is at the top of an HTML document, so nothing beyond this
 * is ever handed to the DOM parser. This bounds *parsing*, not the network transfer: `requestUrl` downloads the
 * whole response before this cap is applied (see the fetch note on redirects and exposure below).
 */
const MAX_HTML = 512 * 1024;
/** https only (SSRF guard, spec §4.1): the fetcher never follows a plain http(s):// link, let alone anything else. */
const HTTPS_URL = /^https:\/\//i;

/** A private, loopback or link-local IPv4 address, given as its four octets. */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 127) return true; // loopback (127.0.0.0/8)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 0) return true;
  return false;
}

/**
 * Expands a bracket-free IPv6 address (`::` shorthand, and a trailing dotted IPv4 tail such as `::ffff:127.0.0.1`)
 * into its 8 16-bit groups, or returns null when it isn't a well-formed IPv6 address. Used only for the SSRF guard:
 * an address it can't parse is treated as not-private (fetches are still gated by needing `https://` and a
 * successful `new URL()` parse elsewhere).
 */
function expandIPv6(host: string): number[] | null {
  let text = host;
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted && dotted[1] !== undefined && dotted[2] !== undefined) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] as number) << 8) | (octets[1] as number);
    const lo = ((octets[2] as number) << 8) | (octets[3] as number);
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  let parts: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    parts = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    parts = head;
  }
  if (parts.length !== 8) return null;
  const groups = parts.map((p) => parseInt(p || "0", 16));
  return groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : groups;
}

/**
 * SSRF guard: refuses a host that resolves inside the machine or the local network without ever making a request.
 * This is a conservative literal/textual check on the hostname as written in the URL — loopback, RFC1918, IPv6
 * unique-local (fc00::/7) and link-local (fe80::/10, incl. IPv4's 169.254.0.0/16 cloud-metadata range), IPv4-mapped
 * IPv6 (`::ffff:a.b.c.d` and its all-hex form, unwrapped and checked again as IPv4), every form of the IPv6
 * unspecified/loopback address (`::`, `::1`, and their fully-written-out equivalents), and `.local` mDNS names — it
 * does not resolve DNS, so a public name that happens to resolve to a private address is not caught here (nor is a
 * redirect to one; see the fetch note below).
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, ""); // a trailing dot (`localhost.`) names the same host as without it.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  if (!host.includes(":")) return false;
  const groups = expandIPv6(host);
  if (!groups) return false;
  if (groups.every((g) => g === 0)) return true; // "::", the unspecified address
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // "::1", every written-out form
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if (((groups[0] as number) & 0xfe00) === 0xfc00) return true; // fc00::/7, unique-local
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    // ::ffff:a.b.c.d, the IPv4-mapped form (in dotted or all-hex notation): unwrap it and check the v4 address again.
    // groups[6] packs the first two octets (a<<8|b), which is all isPrivateV4 needs.
    const ab = groups[6] as number;
    return isPrivateV4((ab >> 8) & 0xff, ab & 0xff);
  }
  return false;
}

/** A URL this fetcher is willing to request: https only, and never a private/loopback/link-local host. */
export function isFetchable(url: string): boolean {
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
 *
 * Known limit — redirects (fix round 1): `requestUrl` follows redirects itself and doesn't expose the final URL, so
 * the SSRF guard above only ever sees the URL the caller asked for. A public URL that redirects to an internal
 * address (loopback, RFC1918, link-local, cloud metadata, …) cannot be caught here — Obsidian's `requestUrl` gives
 * this class no hook into the redirect chain. This is bounded, not open-ended: the request is always a plain `GET`
 * with no credential of any kind attached (no cookie jar, no Authorization header, nothing from `app.secretStorage`),
 * and the response is only ever parsed as text (`parseLinkCard`/DOMParser) — never executed, never written anywhere
 * but the in-memory cache. So the worst a malicious redirect can do through this class is cause "a GET was made" to
 * an internal address; it cannot exfiltrate a secret or have this class act as a write proxy. See docs/qa for the
 * write-up of this as a known, accepted limit.
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
