import type { App } from "obsidian";
import type { IndexedVariant } from "../index/socialIndex";
import { bodyOf } from "../model/body";
import type { MediaInspector } from "../media/mediaInfo";
import type { MediaInfo } from "../platforms/types";
import { imageEmbeds } from "../platforms/wordpress/markdown";

export interface LoadedContent {
  body: string;
  media: MediaInfo[];
  featured?: MediaInfo;
  /** Generated WordPress images embedded in Markdown but absent from `media:`. */
  bodyMedia?: MediaInfo[];
}

/** Every resolved asset that contributes to the hand-over content digest. */
export function digestMedia(content: LoadedContent): MediaInfo[] {
  return [...content.media, ...(content.bodyMedia ?? []), ...(content.featured ? [content.featured] : [])];
}

/** Reads what checks and previews need from a variant note: its body and its resolved media. */
export class ContentLoader {
  constructor(
    private readonly app: App,
    private readonly media: MediaInspector,
  ) {}

  async body(v: Pick<IndexedVariant, "file">): Promise<string> {
    return bodyOf(await this.app.vault.cachedRead(v.file));
  }

  async load(v: IndexedVariant, exactBody?: string): Promise<LoadedContent> {
    const [body, media] = await Promise.all([exactBody === undefined ? this.body(v) : exactBody, this.media.inspect(v)]);
    const bodyTargets = v.platform === "wordpress" ? imageEmbeds(body).filter((target) => v.mediaMeta?.[target]?.sourcePath && !v.media.includes(target)) : [];
    const bodyMedia = bodyTargets.length ? await this.media.inspect({ path: v.path, media: bodyTargets, mediaMeta: v.mediaMeta }) : undefined;
    const target = v.wordpress?.featuredImage;
    if (!target) return { body, media, ...(bodyMedia ? { bodyMedia } : {}) };
    const [featured] = await this.media.inspect({ path: v.path, media: [target], mediaMeta: v.mediaMeta });
    return { body, media, featured, ...(bodyMedia ? { bodyMedia } : {}) };
  }
}
