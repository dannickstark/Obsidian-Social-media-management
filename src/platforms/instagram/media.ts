import { NeedsUserError } from "../errors";

export interface InstagramHostedFile {
  name: string;
  mime: string;
  data: ArrayBuffer;
}

export interface HostedInstagramMedia {
  url: string;
  /** Unix epoch milliseconds after which the URL can no longer be fetched. */
  expiresAt?: number;
}

/** A host must make image bytes reachable by Meta without exposing vault paths or credentials. */
export interface InstagramMediaHost {
  /** `token` is reserved for a host-specific credential; it is never the Meta account token. */
  create(file: InstagramHostedFile, token: string): Promise<HostedInstagramMedia>;
}

/**
 * M6 currently has no configured public media host. Instagram's Graph API fetches image_url from Meta's servers;
 * a vault resource URL, local listener, or private Obsidian path cannot satisfy that contract safely.
 */
export class AssistedOnlyInstagramMediaHost implements InstagramMediaHost {
  async create(_file: InstagramHostedFile, _token: string): Promise<HostedInstagramMedia> {
    throw new NeedsUserError(
      "Instagram API publishing needs a secure public image host that Meta can fetch. No host is configured; use assisted publishing to add the image in Instagram.",
    );
  }
}

function hasLocalMediaPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  return (
    /(?:^|\/)users\/[^/]+(?:\/|$)/i.test(normalizedPath) ||
    /(?:^|\/)home\/[^/]+(?:\/|$)/i.test(normalizedPath) ||
    /(?:^|\/)[a-z]:\//i.test(normalizedPath) ||
    /(?:^|\/)(?:private\/)?(?:tmp|var)(?:\/|$)/i.test(normalizedPath) ||
    /(?:^|\/)\.obsidian(?:\/|$)/i.test(normalizedPath) ||
    /(?:^|\/)vault(?:\/|$)/i.test(normalizedPath)
  );
}

function decodePathLayer(path: string): string | undefined {
  try {
    // A percent sign not followed by two hex digits is literal path data, not an escape.
    return decodeURIComponent(path.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return undefined;
  }
}

function decodeAsciiEscapes(path: string): string {
  // Decode ASCII escapes independently so one invalid UTF-8 byte cannot hide a later
  // encoded path marker. Non-ASCII bytes stay escaped; they are irrelevant to local-path markers.
  return path.replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
    const byte = Number.parseInt(hex, 16);
    return byte < 0x80 ? String.fromCharCode(byte) : escape;
  });
}

/** Reject local/private destinations and URLs that carry userinfo, query credentials, or fragments. */
export function validateInstagramMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NeedsUserError("Instagram: the image host did not return a valid public URL; use assisted publishing.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const decodedPath = decodePathLayer(url.pathname);
  let localPath = decodedPath !== undefined && hasLocalMediaPath(decodedPath);
  // Inspect a separate copy for nested encodings. Only recognizable local/vault markers
  // are grounds for rejection; ordinary filename escapes (including encoded slashes,
  // spaces, and literal percent sequences) must not be normalized or rejected.
  let inspectionPath = url.pathname;
  localPath ||= hasLocalMediaPath(inspectionPath);
  let inspectionComplete = false;
  for (let depth = 0; depth < 8 && !localPath; depth++) {
    const next = decodeAsciiEscapes(inspectionPath);
    if (next === inspectionPath) {
      inspectionComplete = true;
      break;
    }
    inspectionPath = next;
    localPath = hasLocalMediaPath(inspectionPath);
  }
  if (!localPath && !inspectionComplete && /%[0-9a-f]{2}/i.test(inspectionPath)) {
    throw new NeedsUserError("Instagram: the image host URL path is too deeply encoded; use assisted publishing.");
  }
  const ipv4 = host.split(".").map(Number);
  const privateIpv4 =
    ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168));
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || privateIpv4;
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    privateHost ||
    localPath
  ) {
    throw new NeedsUserError(
      "Instagram: the image host URL must be public HTTPS and contain no credentials or private path; use assisted publishing.",
    );
  }
  return url.toString();
}
