const encoder = new TextEncoder();

export const utf8Length = (s: string): number => encoder.encode(s).length;

export type Feature =
  | { $type: "app.bsky.richtext.facet#link"; uri: string }
  | { $type: "app.bsky.richtext.facet#mention"; did: string }
  | { $type: "app.bsky.richtext.facet#tag"; tag: string };

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Feature[];
}

interface Span {
  /** UTF-16 index, inclusive. */
  start: number;
  /** UTF-16 index, exclusive. */
  end: number;
}

const LINK_RE = /https?:\/\/[^\s<>"'`]+/g;
const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)/g;
/** A tag starts after a space (or the start), and has at least one letter or underscore (so #1 or #2026 are not tags). */
const TAG_RE = /(^|\s)#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/gu;

export function findLinks(text: string): Array<Span & { uri: string }> {
  return [...text.matchAll(LINK_RE)].map((m) => {
    const uri = m[0].replace(/[.,;:!?)\]]+$/, "");
    const start = m.index ?? 0;
    return { start, end: start + uri.length, uri };
  });
}

const inside = (spans: readonly Span[], i: number): boolean => spans.some((s) => i >= s.start && i < s.end);

export function findMentions(text: string): Array<Span & { handle: string }> {
  const links = findLinks(text);
  return [...text.matchAll(MENTION_RE)]
    .map((m) => {
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      const handle = m[2] ?? "";
      return { start, end: start + 1 + handle.length, handle };
    })
    .filter((m) => /\.[a-zA-Z]{2,}$/.test(m.handle) && !inside(links, m.start));
}

export function findTags(text: string): Array<Span & { tag: string }> {
  const links = findLinks(text);
  return [...text.matchAll(TAG_RE)]
    .map((m) => {
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      const tag = m[2] ?? "";
      return { start, end: start + 1 + tag.length, tag };
    })
    .filter((t) => [...t.tag].length <= 64 && !inside(links, t.start));
}

/** Links, mentions (only those whose handle resolves to a DID) and tags, indexed by UTF-8 byte offsets. */
export async function buildFacets(text: string, resolve: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const bytes = (i: number) => utf8Length(text.slice(0, i));
  const index = (s: Span) => ({ byteStart: bytes(s.start), byteEnd: bytes(s.end) });
  const facets: Facet[] = findLinks(text).map((l) => ({ index: index(l), features: [{ $type: "app.bsky.richtext.facet#link", uri: l.uri }] }));
  for (const m of findMentions(text)) {
    const did = await resolve(m.handle.toLowerCase()).catch(() => null);
    if (did) facets.push({ index: index(m), features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
  }
  for (const t of findTags(text)) facets.push({ index: index(t), features: [{ $type: "app.bsky.richtext.facet#tag", tag: t.tag }] });
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
