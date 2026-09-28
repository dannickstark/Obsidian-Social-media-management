import type { Platform } from "../../src/model/platforms";
import type { Channel, Variant } from "../../src/model/types";
import { previewModel, type PreviewModel } from "../../src/previews/model";
import { platformDef } from "../../src/platforms/registry";
import type { MediaInfo } from "../../src/platforms/types";
import { input } from "../platforms/fixtures";

export function pv(platform: Platform, body: string, extra: Partial<Variant> = {}, media: MediaInfo[] = [], channel?: Channel, featured?: MediaInfo): PreviewModel {
  return previewModel({
    def: platformDef(platform),
    variant: input(platform, body, extra, media).variant,
    body,
    media,
    featured,
    channel,
    resource: (path) => `app://local/${path}`,
  });
}
