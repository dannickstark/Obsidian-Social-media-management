import type { Issue } from "../../model/types";
import { MB, type PlatformDef } from "../types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const def: PlatformDef = {
  id: "wordpress",
  dialect: "html",
  preview: "article",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: article length and upload size (site dependent)
    limits: { maxChars: 1_000_000, counter: "graphemes", titleRequired: true, link: "none" },
    media: { maxCount: 50, required: false, maxBytes: 20 * MB, video: false },
  },
  validate(input) {
    const wp = input.variant.wordpress;
    const issues: Issue[] = [];
    if (!wp?.slug) issues.push({ level: "error", field: "slug", code: "missing-slug", message: "WordPress needs a slug." });
    else if (!SLUG_RE.test(wp.slug)) {
      issues.push({ level: "error", field: "slug", code: "bad-slug", message: "Use lowercase letters, digits and dashes in the slug." });
    }
    if (!wp?.featuredImage) issues.push({ level: "warning", field: "featured_image", code: "missing-featured", message: "No featured image set." });
    return issues;
  },
};
