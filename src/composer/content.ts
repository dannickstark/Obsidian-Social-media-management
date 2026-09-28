import type { App } from "obsidian";
import type { IndexedVariant } from "../index/socialIndex";
import { bodyOf } from "../model/body";
import type { MediaInspector } from "../media/mediaInfo";
import type { MediaInfo } from "../platforms/types";

export interface LoadedContent {
  body: string;
  media: MediaInfo[];
  featured?: MediaInfo;
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

  async load(v: IndexedVariant): Promise<LoadedContent> {
    const [body, media] = await Promise.all([this.body(v), this.media.inspect(v)]);
    const target = v.wordpress?.featuredImage;
    if (!target) return { body, media };
    const [featured] = await this.media.inspect({ path: v.path, media: [target], mediaMeta: v.mediaMeta });
    return { body, media, featured };
  }
}
